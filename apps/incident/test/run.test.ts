import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poisonSku } from '@commerce/faults';
import type { LoadGeneratorOptions, RunReport as LoadRunReport } from '@commerce/loadgen';
import { afterEach, describe, expect, it } from 'vitest';
import { CategorizedError, type SignalRunCommand } from '../src/budget.js';
import { NODE_BUNDLE_FS, validateBundle } from '@commerce/incident-bundle';
import { loadConfig } from '../src/config.js';
import { NODE_EVIDENCE_FS } from '../src/evidence.js';
import { NODE_LOCK_FS } from '../src/lock.js';
import { FAILED_DIR } from '../src/evidence.js';
import { LOCK_FILE } from '../src/lock.js';
import {
  exitCodeFor,
  formatReport,
  runIncident,
  type Captures,
  type IncidentReport,
  type RunConfig,
  type RunDeps,
} from '../src/run.js';
import { containers, FakeTime, fakeFetch, tempDir, type Reply } from './support.js';

/**
 * M5c criterion C2 and sections 4 to 6 and 9, on a fake clock with every external dependency
 * stubbed: no Docker, no services, no real time.
 */
const VERIFIED = { composePsShape: true, composeOverride: true, containerIdentity: true };
/** Every runtime fact unverified: the gating behavior, independent of the production values. */
const UNVERIFIED = { composePsShape: false, composeOverride: false, containerIdentity: false };
const TRACE_ID = 'a'.repeat(32);
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

type LoadBehavior =
  | { kind: 'normal' }
  | { kind: 'preflight-fails' }
  | { kind: 'never-starts' }
  | { kind: 'rejects-at'; offsetMs: number }
  | { kind: 'never-settles' };

interface Options {
  scenario?: RunConfig['scenario'];
  load?: LoadBehavior;
  poll?: (n: number) => Reply;
  start?: () => Reply;
  stopConfirms?: boolean | ((n: number) => boolean);
  api?: (url: URL, init?: RequestInit) => Reply | undefined;
  captures?: Partial<Captures>;
  verification?: typeof VERIFIED;
  freeBytes?: number;
  validate?: RunDeps['validateBundle'];
  runCommand?: SignalRunCommand;
  truncated?: boolean;
  interruptAt?: (T: number) => number;
}

function harness(options: Options = {}) {
  const time = new FakeTime();
  const t = tempDir();
  cleanups.push(t.cleanup);
  const incidentsDir = join(t.dir, 'incidents');
  const scenario = options.scenario ?? 'payment-timeouts';
  const state = {
    active: false,
    T: -1,
    loadAborted: false,
    generatorCreated: false,
    cleanupStarted: false,
    polls: 0,
    stopConfirmCalls: 0,
  };
  const interrupt = new AbortController();

  const busy = {
    active: { scenario },
    processes: { 'orders-api': { active: { scenario } }, worker: { active: { scenario } } },
  };
  const none = {
    active: null,
    processes: { 'orders-api': { active: null }, worker: { active: null } },
  };
  const stub = fakeFetch(time, (url, init) => {
    const custom = options.api?.(url, init);
    if (custom) return custom;
    if (url.port === '9090') {
      if (url.pathname === '/-/ready') return { status: 200 };
      if (
        url.pathname === '/api/v1/query' &&
        url.searchParams.get('query')?.startsWith('group by')
      ) {
        return {
          status: 200,
          body: { status: 'success', data: { result: [{ metric: { instance: 'a1b2c3d4e5f6' } }] } },
        };
      }
      state.polls += 1;
      return (
        options.poll?.(state.polls) ?? {
          status: 200,
          body: { status: 'success', data: { result: [{ value: [1, '1'] }] } },
        }
      );
    }
    if (url.port === '16686') return { status: 200 };
    switch (url.pathname) {
      case '/readyz':
        return { status: 200 };
      case '/admin/scenarios':
        return { status: 200, body: { scenarios: [{ name: scenario, version: 1 }] } };
      case '/admin/scenarios/active': {
        if (!state.active) return { status: 200, body: none };
        return { status: 200, body: busy };
      }
      case '/admin/scenarios/stop': {
        state.stopConfirmCalls += 1;
        const confirms =
          typeof options.stopConfirms === 'function'
            ? options.stopConfirms(state.stopConfirmCalls)
            : (options.stopConfirms ?? true);
        if (confirms) state.active = false;
        return { status: 200, body: {} };
      }
      case '/orders':
        return { status: 201, body: { id: 'o1' } };
      default:
        if (url.pathname.endsWith('/start')) {
          const reply = options.start?.() ?? { status: 202, body: {} };
          if ('status' in reply && reply.status === 202) state.active = true;
          return reply;
        }
        return { status: 404 };
    }
  });

  const runCommand: SignalRunCommand =
    options.runCommand ??
    ((command, args) => {
      if (command === 'git') {
        return Promise.resolve({
          exitCode: 0,
          stdout: args[0] === 'rev-parse' ? `${'c'.repeat(40)}\n` : '',
          stderr: '',
        });
      }
      if (args[0] === 'context')
        return Promise.resolve({
          exitCode: 0,
          stdout: '"unix:///var/run/docker.sock"',
          stderr: '',
        });
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(containers()), stderr: '' });
    });

  const load = options.load ?? { kind: 'normal' };
  const createLoadGenerator = (o: LoadGeneratorOptions) => {
    state.generatorCreated = true;
    return {
      planHash: 'b'.repeat(64),
      run: () =>
        new Promise<LoadRunReport>((resolve, reject) => {
          o.signal?.addEventListener('abort', () => {
            state.loadAborted = true;
            reject(new Error('aborted'));
          });
          const passed = {
            runPrefix: 'run-1',
            preflight: { passed: true, readyz: { status: 200 } },
          };
          time.timers.setTimeout(() => {
            if (load.kind === 'preflight-fails') {
              resolve({
                runPrefix: 'run-1',
                preflight: { passed: false, readyz: { status: 200 }, failure: 'stock is short' },
              });
              return;
            }
            if (load.kind === 'never-starts') return;
            state.T = time.now;
            o.onPlanStart?.(time.now);
            if (options.interruptAt) {
              time.timers.setTimeout(
                () => {
                  interrupt.abort('SIGINT');
                },
                options.interruptAt(state.T) - time.now,
              );
            }
            if (load.kind === 'never-settles') return;
            if (load.kind === 'rejects-at') {
              time.timers.setTimeout(() => {
                reject(new Error('load generator crashed'));
              }, load.offsetMs);
              return;
            }
            time.timers.setTimeout(() => {
              resolve({ ...passed, results: [] });
            }, 150_000);
          }, 10);
        }),
    };
  };

  const truncated = options.truncated ?? false;
  const captures: Captures = {
    metrics: () =>
      Promise.resolve({
        records: [
          {
            name: 'commerce_payment_calls_total',
            labels: { job: 'worker', instance: 'worker-1', password_hint: 'postgres://u:pw@h/d' },
            samples: [[1, '3']],
          },
        ],
        summary: {
          source: 'prometheus',
          stepSeconds: 5,
          series: [{ name: 'commerce_payment_calls_total', seriesCount: 1 }],
        },
      }),
    traces: () =>
      Promise.resolve({
        records: [
          {
            resourceSpans: [
              {
                resource: {
                  attributes: [
                    attr('service.name', 'orders-api'),
                    attr('service.version', '0.0.0'),
                    attr('service.instance.id', 'a1b2c3d4e5f6'),
                  ],
                },
                scopeSpans: [
                  {
                    scope: { name: 's' },
                    spans: [
                      {
                        traceId: TRACE_ID,
                        spanId: '1'.repeat(16),
                        name: 'POST /orders',
                        startTimeUnixNano: '1',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        summary: {
          source: 'jaeger-v3',
          sliceSeconds: 10,
          minSliceSeconds: 1,
          searchDepth: 1000,
          maxTracesPerService: 5000,
          droppedAdminSpans: 0,
          services: [
            {
              name: 'orders-api',
              traces: 1,
              saturatedSlices: truncated ? 1 : 0,
              truncated,
              truncationReasons: truncated ? ['slice_saturated'] : [],
            },
            {
              name: 'worker',
              traces: 0,
              saturatedSlices: 0,
              truncated: false,
              truncationReasons: [],
            },
          ],
        },
      }),
    logs: () =>
      Promise.resolve({
        records: [
          {
            service: 'orders-api',
            time: '2026-10-25T14:00:01.000Z',
            level: 'error',
            message: 'db postgres://commerce:secret@db/commerce',
            attributes: { reqId: 'req-1' },
          },
        ],
        summary: {
          source: 'docker-compose',
          services: [{ name: 'orders-api', records: 1, nonJsonLines: 0, droppedAdminLines: 0 }],
        },
      }),
    ...options.captures,
  };

  const deps: RunDeps = {
    wallClock: time.wall,
    monotonic: time.monotonic,
    timers: time.timers,
    fetch: stub.fetch,
    runCommand,
    interrupt: interrupt.signal,
    verification: options.verification ?? VERIFIED,
    hostname: 'host-a',
    pid: 4242,
    createLoadGenerator,
    freeBytes: () => Promise.resolve(options.freeBytes ?? 10 * 1024 ** 3),
    captures,
    lockFs: time.trackFs(NODE_LOCK_FS),
    evidenceFs: time.trackFs(NODE_EVIDENCE_FS),
    bundleFs: time.trackFs(NODE_BUNDLE_FS),
    validateBundle: (dir) => time.track((options.validate ?? validateBundle)(dir)),
    onCleanupStart: () => {
      state.cleanupStarted = true;
    },
  };
  const config: RunConfig = { ...loadConfig({ INCIDENTS_DIR: incidentsDir }), scenario, seed: 42 };
  const calls = (path: string) =>
    stub.calls.filter((c) => new URL(c.url).pathname === path || c.url.endsWith(path));
  return {
    time,
    stub,
    state,
    deps,
    config,
    incidentsDir,
    interrupt,
    calls,
    run: () => time.run(runIncident(config, deps)),
  };
}

const startCalls = (h: ReturnType<typeof harness>) =>
  h.stub.calls.filter((c) => c.url.endsWith('/start'));
const stopCalls = (h: ReturnType<typeof harness>) =>
  h.stub.calls.filter((c) => c.url.endsWith('/admin/scenarios/stop'));

describe('a successful run', () => {
  it('runs the concurrent timeline, writes a valid, complete bundle, and cleans up', async () => {
    const h = harness();
    const report = await h.run();
    expect(report.outcome).toBe('success');
    expect(exitCodeFor(report)).toBe(0);
    expect(report.evidence).toEqual({ state: 'complete' });
    expect(report.bundle.state).toBe('valid');
    expect(report.cleanup).toEqual({
      state: 'succeeded',
      steps: [
        { step: 'stop', result: 'not needed (confirmed earlier)' },
        { step: 'load', result: 'not needed' },
        { step: 'lock', result: 'released' },
      ],
    });
    // T+30 s start, T+120 s stop; the stop does not touch the load, which ends at T+150 s.
    const T = h.state.T;
    expect(startCalls(h).map((c) => c.at)).toEqual([T + 30_000]);
    expect(stopCalls(h).map((c) => c.at)).toEqual([T + 120_000]);
    expect(h.state.loadAborted).toBe(false);
    // Detected on the first poll, right after the 202.
    expect(h.state.polls).toBe(1);
    expect(h.state.cleanupStarted).toBe(true);
    // The lock is gone and the bundle validated.
    expect(await readdir(h.incidentsDir)).toEqual([report.bundle.path?.split('/').at(-1)]);
    const manifest = JSON.parse(
      await readFile(join(report.bundle.path ?? '', 'manifest.json'), 'utf8'),
    ) as Record<string, Record<string, unknown>>;
    expect(manifest.trigger?.stoppedAt).not.toBeNull();
    expect(manifest.detection?.latencyMs).toBe(1);
    expect(manifest.load).toEqual({
      profile: 'incident',
      seed: 42,
      planHash: 'b'.repeat(64),
      runPrefix: 'run-1',
    });
    expect(manifest.producer).toEqual({
      repository: 'commerce-platform',
      commit: 'c'.repeat(40),
      dirty: false,
    });
    expect(Object.keys(manifest.infrastructure?.images as object)).toContain('jaeger');
    // Redacted before writing; the count is in the report only.
    const logs = await readFile(join(report.bundle.path ?? '', 'logs.jsonl'), 'utf8');
    expect(logs).toContain('postgres://commerce:***@db');
    expect(report.redactions).toBe(2);
    expect(formatReport(report).trimEnd().split('\n').slice(-4)).toEqual([
      'outcome: success',
      `bundle: valid ${report.bundle.path ?? ''}`,
      'evidence: complete',
      'cleanup: succeeded',
    ]);
  });

  it('places the poison order for poison-order, with the derived SKU and key', async () => {
    const h = harness({ scenario: 'poison-order' });
    const report = await h.run();
    expect(report.outcome).toBe('success');
    const order = h.stub.calls.find((c) => c.url.endsWith('/orders'));
    expect(JSON.parse(order?.body ?? '{}')).toMatchObject({
      items: [{ sku: poisonSku(42), quantity: 1 }],
    });
    expect(order?.at).toBeGreaterThanOrEqual(h.state.T + 30_000);
  });

  it('reports truncated traces as valid but incomplete, still exit 0', async () => {
    const h = harness({ truncated: true });
    const report = await h.run();
    expect(exitCodeFor(report)).toBe(0);
    expect(report.evidence).toEqual({
      state: 'incomplete',
      reasons: ['traces truncated for orders-api: slice_saturated'],
    });
    expect(report.warnings).toContain(
      'trace evidence may be incomplete: orders-api slice_saturated',
    );
  });
});

describe('detection outcomes', () => {
  const empty = (): Reply => ({ status: 200, body: { status: 'success', data: { result: [] } } });

  it('all polls empty through T+150: symptom not detected, exit 2, a valid bundle with null detection', async () => {
    const h = harness({ poll: empty });
    const report = await h.run();
    expect(report.outcome).toBe('symptom_not_detected');
    expect(exitCodeFor(report)).toBe(2);
    // From the 202 at T+30 s, every 5 s, up to T+150 s: 24 polls.
    expect(h.state.polls).toBe(24);
    const manifest = JSON.parse(
      await readFile(join(report.bundle.path ?? '', 'manifest.json'), 'utf8'),
    ) as { detection: unknown };
    expect(manifest.detection).toEqual({ detectedAt: null, latencyMs: null, deadlineSeconds: 120 });
  });

  it('one failed poll without detection is inconclusive: exit 1, no capture, no bundle', async () => {
    const h = harness({ poll: (n) => (n === 3 ? { status: 503 } : empty()) });
    const report = await h.run();
    expect(report).toMatchObject({
      outcome: 'orchestration_failure',
      stage: 'detection',
      bundle: { state: 'none' },
    });
    expect(report.detail).toMatch(/1 of 24 polls failed \(HTTP 503\)/);
    expect(report.evidence).toEqual({
      state: 'none',
      reason: 'no capture after an orchestration failure',
    });
    expect(await readdir(h.incidentsDir)).toEqual([]);
    expect(exitCodeFor(report)).toBe(1);
  });

  it('a transport failure on a poll is never an empty result', async () => {
    const h = harness({ poll: (n) => (n === 1 ? { transportError: true } : empty()) });
    const report = await h.run();
    expect(report.stage).toBe('detection');
  });
});

describe('orchestration failures and cleanup', () => {
  it('a start rejected with 409: stop sent because it may be active, load cancelled, lock released', async () => {
    const h = harness({ start: () => ({ status: 409, body: { error: 'scenario_active' } }) });
    const report = await h.run();
    expect(report).toMatchObject({ outcome: 'orchestration_failure', stage: 'fault-start' });
    expect(stopCalls(h)).toHaveLength(1);
    expect(h.state.loadAborted).toBe(true);
    expect(report.cleanup.steps).toEqual([
      { step: 'stop', result: 'confirmed' },
      { step: 'load', result: 'settled' },
      { step: 'lock', result: 'released' },
    ]);
  });

  it('a start that times out also gets a stop', async () => {
    const h = harness({ start: () => ({ hang: true }) });
    const report = await h.run();
    expect(report.stage).toBe('fault-start');
    expect(stopCalls(h)).toHaveLength(1);
  });

  it('a load failure before T+30 s: no start, no stop', async () => {
    const h = harness({ load: { kind: 'rejects-at', offsetMs: 10_000 } });
    const report = await h.run();
    expect(report).toMatchObject({ outcome: 'orchestration_failure', stage: 'load' });
    expect(startCalls(h)).toHaveLength(0);
    expect(stopCalls(h)).toHaveLength(0);
    expect(report.cleanup.steps[0]).toEqual({ step: 'stop', result: 'not needed' });
  });

  it('a load failure while the fault is active: cleanup stops it', async () => {
    const h = harness({ load: { kind: 'rejects-at', offsetMs: 60_000 } });
    const report = await h.run();
    expect(report.stage).toBe('load');
    // Cleanup sends the stop at the moment of the failure.
    expect(stopCalls(h).map((c) => c.at)).toEqual([h.state.T + 60_000]);
  });

  it('a load failure after the stop is confirmed: no second stop', async () => {
    const h = harness({ load: { kind: 'rejects-at', offsetMs: 140_000 } });
    const report = await h.run();
    expect(report.stage).toBe('load');
    expect(stopCalls(h)).toHaveLength(1);
    expect(report.cleanup.steps[0]).toEqual({
      step: 'stop',
      result: 'not needed (confirmed earlier)',
    });
  });

  it('a load that does not settle by T+160 s is cancelled', async () => {
    const h = harness({ load: { kind: 'never-settles' } });
    const report = await h.run();
    expect(report).toMatchObject({
      stage: 'load',
      detail: 'the load plan did not settle by T+160 s',
    });
    expect(h.state.loadAborted).toBe(true);
  });

  it('a plan that never starts, or an M4 preflight failure: exit 1, no fault', async () => {
    const never = harness({ load: { kind: 'never-starts' } });
    const r1 = await never.run();
    expect(r1).toMatchObject({ stage: 'load', detail: 'the load plan did not start within 30 s' });
    expect(startCalls(never)).toHaveLength(0);
    const pf = harness({ load: { kind: 'preflight-fails' } });
    const r2 = await pf.run();
    expect(r2.detail).toMatch(/preflight failed: stock is short/);
    expect(exitCodeFor(r2)).toBe(1);
  });

  it('a failed poison order is an orchestration failure, with a stop', async () => {
    const h = harness({
      scenario: 'poison-order',
      api: (url) => (url.pathname === '/orders' ? { status: 422 } : undefined),
    });
    const report = await h.run();
    expect(report.stage).toBe('poison-order');
    expect(stopCalls(h)).toHaveLength(1);
  });
});

describe('preflight', () => {
  const cases: [string, Options, RegExp][] = [
    [
      'readyz',
      { api: (u) => (u.pathname === '/readyz' ? { status: 503 } : undefined) },
      /readyz returned 503/,
    ],
    [
      'faults disabled',
      { api: (u) => (u.pathname === '/admin/scenarios' ? { status: 404 } : undefined) },
      /not enabled/,
    ],
    [
      'list error',
      { api: (u) => (u.pathname === '/admin/scenarios' ? { status: 500 } : undefined) },
      /returned 500/,
    ],
    [
      'version mismatch',
      {
        api: (u) =>
          u.pathname === '/admin/scenarios'
            ? { status: 200, body: { scenarios: [{ name: 'payment-timeouts', version: 2 }] } }
            : undefined,
      },
      /version mismatch/,
    ],
    [
      'already active',
      {
        api: (u) =>
          u.pathname === '/admin/scenarios/active'
            ? {
                status: 200,
                body: {
                  active: { s: 1 },
                  processes: { 'orders-api': { active: {} }, worker: { active: {} } },
                },
              }
            : undefined,
      },
      /already be active/,
    ],
    [
      'prometheus',
      {
        api: (u) => (u.port === '9090' && u.pathname === '/-/ready' ? { status: 503 } : undefined),
      },
      /Prometheus/,
    ],
    [
      'jaeger',
      { api: (u) => (u.port === '16686' ? { status: 500 } : undefined) },
      /Jaeger returned 500/,
    ],
    ['disk', { freeBytes: 100 * 1024 ** 2 }, /1 GiB is required/],
    [
      'transport',
      { api: (u) => (u.pathname === '/readyz' ? { transportError: true } : undefined) },
      /readyz/,
    ],
  ];
  for (const [label, options, detail] of cases) {
    it(`fails before any load: ${label}`, async () => {
      const h = harness(options);
      const report = await h.run();
      expect(report).toMatchObject({ outcome: 'orchestration_failure', stage: 'preflight' });
      expect(report.detail).toMatch(detail);
      expect(h.state.generatorCreated).toBe(false);
      expect(report.cleanup.steps[2]).toEqual({ step: 'lock', result: 'released' });
    });
  }

  it('git failure is a preflight failure', async () => {
    const h = harness({
      runCommand: (command, args) => {
        if (command === 'git')
          return Promise.resolve({ exitCode: 128, stdout: '', stderr: 'not a git repository' });
        if (args[0] === 'context')
          return Promise.resolve({ exitCode: 0, stdout: '"unix:///x"', stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(containers()), stderr: '' });
      },
    });
    const report = await h.run();
    expect(report.detail).toMatch(/git rev-parse HEAD failed: not a git repository/);
  });

  it('a bundle-ID collision fails before any load or fault', async () => {
    const h = harness();
    // The bundle ID comes from the wall clock at the end of the preflight: 14:00:00.
    await mkdir(join(h.incidentsDir, FAILED_DIR, 'payment-timeouts-42-20261025T140000Z'), {
      recursive: true,
    });
    const report = await h.run();
    expect(report).toMatchObject({ outcome: 'orchestration_failure', stage: 'bundle-id' });
    expect(h.state.generatorCreated).toBe(false);
    expect(startCalls(h)).toHaveLength(0);
  });
});

describe('evidence failures', () => {
  it('a capture source that fails: evidence preserved under .failed/, no bundle, exit 3', async () => {
    const h = harness({
      captures: {
        traces: () =>
          Promise.reject(
            new CategorizedError('timeout', 'the capture source reached its deadline'),
          ),
      },
    });
    const report = await h.run();
    expect(report).toMatchObject({
      outcome: 'evidence_failure',
      stage: 'capture-traces',
      bundle: { state: 'none' },
    });
    expect(exitCodeFor(report)).toBe(3);
    expect(report.evidence).toMatchObject({
      state: 'preserved',
      files: ['metrics.jsonl', 'capture-summary.json', 'failure.json'],
    });
    const dir = report.evidence.state === 'preserved' ? report.evidence.path : '';
    const failure = JSON.parse(await readFile(join(dir, 'failure.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(failure).toMatchObject({
      stage: 'capture-traces',
      category: 'timeout',
      completedCaptures: ['metrics'],
    });
    expect(await readdir(dir)).not.toContain('manifest.json');
    expect((await readdir(h.incidentsDir)).filter((n) => n !== FAILED_DIR)).toEqual([]);
  });

  it('classifies a client error after an HTTP error as http, and after a 200 as malformed-response', async () => {
    for (const [status, expected] of [
      [400, 'http'],
      [200, 'malformed-response'],
    ] as const) {
      const h = harness({
        api: (u) => (u.pathname === '/probe' ? { status } : undefined),
        captures: {
          metrics: async (o) => {
            await o.fetch('http://127.0.0.1:9090/probe');
            throw new Error('client rejected the response');
          },
        },
      });
      const report = await h.run();
      const dir = report.evidence.state === 'preserved' ? report.evidence.path : '';
      const failure = JSON.parse(await readFile(join(dir, 'failure.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(failure.category).toBe(expected);
    }
  });

  it('a log command failure is a command failure', async () => {
    const h = harness({
      captures: {
        logs: async (o) => {
          await o.runCommand('docker', ['compose', 'logs']);
          throw new Error('unreachable');
        },
      },
      runCommand: (command, args) => {
        if (command === 'git')
          return Promise.resolve({ exitCode: 0, stdout: 'c'.repeat(40), stderr: '' });
        if (args[0] === 'context')
          return Promise.resolve({ exitCode: 0, stdout: '"unix:///x"', stderr: '' });
        if (args[1] === 'logs')
          return Promise.reject(new Error('Cannot connect to the Docker daemon'));
        return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(containers()), stderr: '' });
      },
    });
    const report = await h.run();
    expect(report).toMatchObject({ outcome: 'evidence_failure', stage: 'capture-logs' });
    expect(report.evidence).toMatchObject({
      files: ['metrics.jsonl', 'traces.jsonl', 'capture-summary.json', 'failure.json'],
    });
  });

  it('a path that appears after the preflight check: the writer refuses, evidence preserved, nothing overwritten', async () => {
    const h = harness({
      captures: {
        metrics: async () => {
          await h.time.track(
            mkdir(join(h.incidentsDir, 'payment-timeouts-42-20261025T140000Z', 'keep'), {
              recursive: true,
            }),
          );
          return {
            records: [],
            summary: { source: 'prometheus', stepSeconds: 5, series: [] },
          };
        },
      },
    });
    const report = await h.run();
    expect(report).toMatchObject({ outcome: 'evidence_failure', stage: 'write' });
    expect(report.detail).toMatch(/already exists/);
    expect(await readdir(join(h.incidentsDir, 'payment-timeouts-42-20261025T140000Z'))).toEqual([
      'keep',
    ]);
  });

  it('an invalid bundle is moved unchanged to .failed/…/bundle and reported invalid', async () => {
    const h = harness({
      validate: () =>
        Promise.resolve({
          valid: false,
          errors: [{ file: 'manifest.json', field: 'x', message: 'bad' }],
        }),
    });
    const report = await h.run();
    expect(report).toMatchObject({ outcome: 'evidence_failure', stage: 'validate' });
    expect(report.bundle).toEqual({
      state: 'invalid',
      path: join(h.incidentsDir, FAILED_DIR, 'payment-timeouts-42-20261025T140000Z', 'bundle'),
    });
    expect(exitCodeFor(report)).toBe(3);
    const failure = JSON.parse(
      await readFile(
        join(h.incidentsDir, FAILED_DIR, 'payment-timeouts-42-20261025T140000Z', 'failure.json'),
        'utf8',
      ),
    ) as {
      message: string;
    };
    expect(failure.message).toBe('manifest.json: x: bad');
  });
});

describe('stop confirmation and cleanup failure', () => {
  it('a normal stop that is never confirmed: bundle incomplete, cleanup retries once, then exit 4', async () => {
    const h = harness({ stopConfirms: false });
    const report = await h.run();
    expect(report.outcome).toBe('success');
    expect(report.evidence).toEqual({
      state: 'incomplete',
      reasons: ['the scenario stop was not confirmed'],
    });
    expect(report.cleanup.state).toBe('failed');
    expect(report.cleanup.steps[0]?.result).toMatch(/^unconfirmed/);
    expect(exitCodeFor(report)).toBe(4);
    // Two procedures, the normal one and the final cleanup's; each stop request succeeds, so
    // each sends one, and only the confirmation fails.
    expect(stopCalls(h)).toHaveLength(2);
    expect(formatReport(report)).toMatch(/cleanup: failed \(stop: unconfirmed/);
  });

  it('a normal stop confirmed only by the final cleanup: exit 0, still incomplete', async () => {
    const h = harness({ stopConfirms: (n) => n >= 2 });
    const report = await h.run();
    expect(exitCodeFor(report)).toBe(0);
    expect(report.evidence.state).toBe('incomplete');
    expect(report.cleanup.steps[0]).toEqual({ step: 'stop', result: 'confirmed' });
  });
});

describe('signals, deadline and blocked runs', () => {
  it('SIGINT during the run: interrupted, exit 130, stop confirmed, load cancelled, no capture', async () => {
    const h = harness({ interruptAt: (T) => T + 60_000 });
    const report = await h.run();
    expect(report).toMatchObject({
      outcome: 'interrupted',
      signal: 'SIGINT',
      bundle: { state: 'none' },
    });
    expect(exitCodeFor(report)).toBe(130);
    expect(stopCalls(h)).toHaveLength(1);
    expect(h.state.loadAborted).toBe(true);
    expect(report.cleanup.state).toBe('succeeded');
    expect(formatReport(report)).toMatch(/outcome: interrupted \(SIGINT\)/);
  });

  it('the global deadline ends normal work, then cleanup runs', async () => {
    const h = harness({ captures: { metrics: () => new Promise(() => undefined) } });
    const report = await h.run();
    expect(report).toMatchObject({ outcome: 'orchestration_failure', stage: 'deadline' });
    expect(report.cleanup.steps[2]).toEqual({ step: 'lock', result: 'released' });
  });

  it('an unverified runtime fact blocks a live run before the lock', async () => {
    const h = harness({ verification: UNVERIFIED });
    const report = await h.run();
    expect(report).toMatchObject({ outcome: 'orchestration_failure', stage: 'checks' });
    expect(report.detail).toMatch(/live runs are blocked: compose-project INCONCLUSIVE/);
    expect(h.state.generatorCreated).toBe(false);
    expect(h.stub.calls.filter((c) => c.url.includes(':3000'))).toEqual([]);
  });

  it('a held or stale lock stops the run, and the lock is left alone', async () => {
    const held = harness();
    await mkdir(held.incidentsDir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(held.incidentsDir, LOCK_FILE),
      JSON.stringify({
        pid: process.pid,
        hostname: 'host-a',
        startedAt: 'x',
        scenario: 's',
        seed: 1,
      }),
    );
    const r1 = await held.run();
    expect(r1).toMatchObject({
      stage: 'lock',
      detail: expect.stringMatching(/another run is in progress/) as string,
    });
    const stale = harness();
    await mkdir(stale.incidentsDir, { recursive: true });
    await writeFile(
      join(stale.incidentsDir, LOCK_FILE),
      JSON.stringify({
        pid: 2 ** 22 + 99,
        hostname: 'host-a',
        startedAt: 'x',
        scenario: 's',
        seed: 1,
      }),
    );
    const r2 = await stale.run();
    expect(r2.detail).toMatch(/stale lock/);
    expect(await readdir(stale.incidentsDir)).toEqual([LOCK_FILE]);
  });

  it('an interrupt before the lock ends the run at once', async () => {
    const h = harness();
    h.interrupt.abort('SIGTERM');
    const report = await h.run();
    expect(report).toMatchObject({ outcome: 'interrupted', signal: 'SIGTERM' });
    expect(exitCodeFor(report)).toBe(143);
  });
});

describe('exit codes (section 9)', () => {
  const r = (
    outcome: IncidentReport['outcome'],
    cleanup: 'succeeded' | 'failed',
    signal?: 'SIGINT' | 'SIGTERM',
  ) => ({
    outcome,
    cleanup: { state: cleanup, steps: [] },
    ...(signal ? { signal } : {}),
  });
  it('a cleanup failure replaces only 0 and 2; failure and signal codes stay', () => {
    expect(exitCodeFor(r('success', 'succeeded'))).toBe(0);
    expect(exitCodeFor(r('success', 'failed'))).toBe(4);
    expect(exitCodeFor(r('symptom_not_detected', 'succeeded'))).toBe(2);
    expect(exitCodeFor(r('symptom_not_detected', 'failed'))).toBe(4);
    expect(exitCodeFor(r('orchestration_failure', 'failed'))).toBe(1);
    expect(exitCodeFor(r('evidence_failure', 'failed'))).toBe(3);
    expect(exitCodeFor(r('interrupted', 'failed', 'SIGINT'))).toBe(130);
    expect(exitCodeFor(r('interrupted', 'succeeded', 'SIGTERM'))).toBe(143);
  });
});
