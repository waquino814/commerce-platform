import { readdirSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { groundTruthJson } from '@commerce/faults';
import { writeBundle } from '@commerce/incident-bundle';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureChecks,
  checkExitCode,
  createSignalPolicy,
  freeBytes,
  runCli,
  writableDir,
  type CliDeps,
} from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import type { RunCommandSimple } from '../src/isolation.js';
import type { RunDeps } from '../src/run.js';
import { containers, FakeTime, tempDir } from './support.js';

/** M5c criterion C1 and the capture-check contract (section 8.3). */
const VERIFIED = { composePsShape: true, composeOverride: true, containerIdentity: true };
/** Every runtime fact unverified: the gating behavior, independent of the production values. */
const UNVERIFIED = { composePsShape: false, composeOverride: false, containerIdentity: false };
let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});
const scratch = () => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};

const noNetwork = () => Promise.reject(new Error('no network calls allowed'));
const noCommands: RunCommandSimple = () => Promise.reject(new Error('no commands allowed'));

function cli(over: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const time = new FakeTime();
  const deps: CliDeps = {
    env: {},
    stdout: (t) => {
      out.push(t);
      return Promise.resolve();
    },
    stderr: (t) => err.push(t),
    fetch: noNetwork,
    runSimple: noCommands,
    timers: time.timers,
    monotonic: time.monotonic,
    verification: UNVERIFIED,
    statfsFree: () => Promise.resolve(10 * 1024 ** 3),
    writable: () => Promise.resolve(undefined),
    runDeps: () => {
      throw new Error('run must not be reached');
    },
    ...over,
  };
  return { deps, out, err, text: () => out.join(''), errors: () => err.join('') };
}

describe('commands without network calls (C1)', () => {
  it('list, ground-truth and validate make no network call and run no command', async () => {
    const c = cli();
    expect(await runCli(['list'], c.deps)).toBe(0);
    expect(c.text()).toMatch(/^api-pool-exhaustion \(version 1\): /);
    const g = cli();
    expect(
      await runCli(['ground-truth', '--scenario', 'provider-outage', '--seed', '42'], g.deps),
    ).toBe(0);
    expect(g.text()).toBe(groundTruthJson('provider-outage', 42));
  });

  it('validate reports a valid and an invalid bundle', async () => {
    const dir = scratch();
    const missing = cli();
    expect(await runCli(['validate', join(dir, 'nope')], missing.deps)).toBe(1);
    expect(missing.text()).toMatch(/invalid: .*\n {2}manifest.json: missing file/);
    const { dir: bundle } = await writeBundle(dir, {
      manifest: {
        schemaVersion: '1.0.0',
        bundleId: 'provider-outage-42-20261025T140000Z',
        createdAt: '2026-10-25T14:10:00.000Z',
        scenario: { name: 'provider-outage', version: 1, seed: 42 },
        window: {
          loadStartedAt: '2026-10-25T14:00:00.000Z',
          loadEndedAt: '2026-10-25T14:02:30.000Z',
          captureFrom: '2026-10-25T14:00:00.000Z',
          captureTo: '2026-10-25T14:02:45.000Z',
        },
        trigger: {
          startedAt: '2026-10-25T14:00:30.000Z',
          stoppedAt: '2026-10-25T14:02:00.000Z',
          requestedDurationMs: 90000,
        },
        detection: { detectedAt: null, latencyMs: null, deadlineSeconds: 120 },
        producer: { repository: 'commerce-platform', commit: 'c'.repeat(40), dirty: false },
        services: [{ name: 'worker', version: 'unknown', instanceId: 'worker-1' }],
        infrastructure: { images: {} },
        load: { profile: 'incident', seed: 42, planHash: 'b'.repeat(64), runPrefix: 'run-1' },
        capture: {
          traces: {
            source: 'jaeger-v3',
            sliceSeconds: 10,
            minSliceSeconds: 1,
            searchDepth: 1000,
            maxTracesPerService: 5000,
            droppedAdminSpans: 0,
            services: [],
          },
          metrics: { source: 'prometheus', stepSeconds: 5, series: [] },
          logs: { source: 'docker-compose', services: [] },
        },
      },
      groundTruth: JSON.parse(groundTruthJson('provider-outage', 42)) as never,
      traces: [],
      metrics: [],
      logs: [],
    });
    const ok = cli();
    expect(await runCli(['validate', bundle], ok.deps)).toBe(0);
    expect(ok.text()).toBe(`valid: ${bundle}\n`);
  });

  it('invalid arguments exit 1 and name the problem', async () => {
    const cases: [string[], RegExp][] = [
      [['ground-truth', '--seed', '1'], /--scenario is required/],
      [['ground-truth', '--scenario', 'nope', '--seed', '1'], /unknown scenario "nope"/],
      [['ground-truth', '--scenario', 'poison-order', '--seed', '-1'], /--seed/],
      [['ground-truth', '--scenario', 'poison-order', '--seed', '1', '--extra'], /extra/],
      [['run', '--scenario', 'poison-order'], /--seed is required/],
      [['validate'], /exactly one bundle directory/],
      [['list', 'extra'], /extra/],
      [['bogus'], /unknown command "bogus"/],
    ];
    for (const [argv, message] of cases) {
      const c = cli();
      expect(await runCli(argv, c.deps), argv.join(' ')).toBe(1);
      expect(c.errors(), argv.join(' ')).toMatch(message);
    }
    const env = cli({ env: { JAEGER_URL: 'nope' } });
    expect(await runCli(['capture-check'], env.deps)).toBe(1);
    expect(env.errors()).toMatch(/JAEGER_URL/);
    const help = cli();
    expect(await runCli(['--help'], help.deps)).toBe(0);
    expect(await runCli([], cli().deps)).toBe(1);
  });
});

describe('capture-check (section 8.3)', () => {
  const docker: RunCommandSimple = (_command, args) => {
    if (args[0] === 'context')
      return Promise.resolve({ exitCode: 0, stdout: '"unix:///var/run/docker.sock"', stderr: '' });
    if (args[1] === 'ps')
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(containers()), stderr: '' });
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        services: {
          'orders-api': { ports: [{ host_ip: '127.0.0.1', published: '3000' }] },
          worker: { ports: [{ host_ip: '127.0.0.1', published: '3001' }] },
        },
      }),
      stderr: '',
    });
  };
  const http =
    (over: Record<string, number> = {}) =>
    (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/api/v1/query') {
        return Promise.resolve(
          Response.json({
            status: 'success',
            data: { result: [{ metric: { instance: 'a1b2c3d4e5f6' } }] },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: over[u.pathname] ?? 200 }));
    };

  it('passes only when every check passes and the runtime facts are verified', async () => {
    const c = cli({ runSimple: docker, fetch: http(), verification: VERIFIED });
    expect(await runCli(['capture-check'], c.deps)).toBe(0);
    expect(c.text()).toMatch(/^PASS url-form/);
    expect(c.text()).toMatch(/summary: all checks passed\n$/);
  });

  it('is inconclusive (exit 5) while the runtime facts are unverified, never 0', async () => {
    const c = cli({ runSimple: docker, fetch: http() });
    expect(await runCli(['capture-check'], c.deps)).toBe(5);
    expect(c.text()).toMatch(/INCONCLUSIVE compose-override/);
    expect(c.text()).toMatch(/INCONCLUSIVE container-identity/);
  });

  it('fails (exit 1) on a failed check: faults disabled, a service down, low disk or no write access', async () => {
    const disabled = cli({
      runSimple: docker,
      fetch: http({ '/admin/scenarios': 404 }),
      verification: VERIFIED,
    });
    expect(await runCli(['capture-check'], disabled.deps)).toBe(1);
    expect(disabled.text()).toMatch(/FAIL fault-controls: faults disabled/);
    const config = loadConfig({});
    const checks = await captureChecks(
      config,
      cli({
        runSimple: docker,
        fetch: http({ '/-/ready': 503, '/readyz': 500, '/admin/scenarios': 500 }),
        verification: VERIFIED,
        statfsFree: () => Promise.resolve(1),
        writable: () => Promise.resolve('incidents is not writable'),
      }).deps,
    );
    expect(checks.filter((x) => x.status === 'FAIL').map((x) => x.name)).toEqual([
      'api-ready',
      'fault-controls',
      'prometheus-ready',
      'output-writable',
      'free-disk',
    ]);
    const broken = await captureChecks(
      config,
      cli({
        runSimple: docker,
        fetch: () => Promise.reject(new Error('down')),
        verification: VERIFIED,
        statfsFree: () => Promise.reject(new Error('statfs failed')),
      }).deps,
    );
    expect(broken.filter((x) => x.status === 'INCONCLUSIVE').map((x) => x.name)).toEqual([
      'container-identity',
      'api-ready',
      'fault-controls',
      'prometheus-ready',
      'jaeger-ready',
      'free-disk',
    ]);
    const badUrl = await captureChecks(
      loadConfig({ ORDERS_API_URL: 'http://localhost:3000' }),
      cli().deps,
    );
    expect(badUrl).toEqual([
      { name: 'url-form', status: 'FAIL', detail: expect.stringContaining('localhost') as string },
    ]);
    expect(checkExitCode(badUrl)).toBe(1);
  });

  it('never writes: the output directory is unchanged, and a missing one is not created', async () => {
    const dir = scratch();
    await mkdir(join(dir, 'incidents'));
    await writeFile(join(dir, 'incidents', 'keep'), 'x');
    const before = readdirSync(dir, { recursive: true });
    const c = cli({
      env: { INCIDENTS_DIR: join(dir, 'incidents') },
      runSimple: docker,
      fetch: http(),
      verification: VERIFIED,
      writable: writableDir,
      statfsFree: freeBytes,
    });
    expect(await runCli(['capture-check'], c.deps)).toBe(0);
    const missing = cli({
      env: { INCIDENTS_DIR: join(dir, 'new', 'incidents') },
      runSimple: docker,
      fetch: http(),
      verification: VERIFIED,
      writable: writableDir,
      statfsFree: freeBytes,
    });
    await runCli(['capture-check'], missing.deps);
    expect(readdirSync(dir, { recursive: true })).toEqual(before);
  });
});

describe('writable directory and free space', () => {
  it('checks the nearest existing directory without creating anything', async () => {
    const dir = scratch();
    expect(await writableDir(join(dir, 'a', 'b'))).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
    const locked = join(dir, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);
    if (process.getuid?.() !== 0)
      expect(await writableDir(join(locked, 'x'))).toBe(`${locked} is not writable`);
    await chmod(locked, 0o700);
    expect(await freeBytes(join(dir, 'missing', 'deeper'))).toBeGreaterThan(0);
  });
});

describe('run, report emission and signals (section 9)', () => {
  const report = {
    outcome: 'orchestration_failure' as const,
    stage: 'checks',
    detail: 'blocked',
    bundle: { state: 'none' as const },
    evidence: { state: 'none' as const, reason: 'x' },
    cleanup: { state: 'succeeded' as const, steps: [] },
    warnings: [],
    redactions: 0,
  };

  it('prints the report and exits with its code; a failed stdout write is not claimed', async () => {
    const runDeps = () => ({ verification: UNVERIFIED }) as unknown as RunDeps;
    const ok = cli({
      runDeps: () => {
        throw new Error('unused');
      },
    });
    // With the default runtime verification, `run` stops at the isolation checks.
    const blocked = cli({
      runSimple: noCommands,
      runDeps: () => ({
        ...runDeps(),
        wallClock: () => new Date(0),
        monotonic: { now: () => 0 },
        timers: new FakeTime().timers,
        fetch: noNetwork,
        runCommand: () => Promise.reject(new Error('no docker')),
        interrupt: new AbortController().signal,
        hostname: 'h',
        pid: 1,
        createLoadGenerator: () => {
          throw new Error('unused');
        },
        freeBytes: () => Promise.resolve(0),
      }),
    });
    expect(await runCli(['run', '--scenario', 'poison-order', '--seed', '42'], blocked.deps)).toBe(
      1,
    );
    expect(blocked.text()).toMatch(
      /outcome: orchestration_failure \(checks\)\nbundle: none\nevidence: none \(.*\)\ncleanup: succeeded\n$/,
    );
    expect(ok.text()).toBe('');

    const failing = cli({
      stdout: () => Promise.reject(new Error('EPIPE')),
      runDeps: blocked.deps.runDeps,
    });
    expect(await runCli(['run', '--scenario', 'poison-order', '--seed', '42'], failing.deps)).toBe(
      1,
    );
    expect(failing.errors()).toMatch(
      /the report could not be written to stdout \(EPIPE\); exit code 1/,
    );
    expect(report.outcome).toBe('orchestration_failure');
  });

  it('first signal interrupts; a signal during cleanup exits at once with the right code', () => {
    const p = createSignalPolicy();
    expect(p.onSignal('SIGTERM')).toEqual({ kind: 'interrupt' });
    p.cleanupStarted();
    expect(p.onSignal('SIGINT')).toEqual({
      kind: 'exit',
      code: 143,
      message: 'interrupted during cleanup: cleanup incomplete\n',
    });
    // No earlier signal: a signal during a normal run's final cleanup exits with its own code.
    const q = createSignalPolicy();
    q.cleanupStarted();
    expect(q.onSignal('SIGINT')).toMatchObject({ kind: 'exit', code: 130 });
    // A second signal before cleanup has started also exits with the first signal's code.
    const r = createSignalPolicy();
    r.onSignal('SIGINT');
    expect(r.onSignal('SIGTERM')).toMatchObject({ kind: 'exit', code: 130 });
  });
});
