import { buildGroundTruth, poisonSku, SCENARIOS, type ScenarioName } from '@commerce/faults';
import {
  BUNDLE_ID,
  NODE_BUNDLE_FS,
  SCHEMA_VERSION,
  canonicalJson,
  toJsonl,
  validateBundle as defaultValidate,
  writeBundle as defaultWrite,
  type BundleFs,
  type LogsRecord,
  type ManifestBody,
  type MetricsRecord,
  type TraceRecord,
  type ValidationResult,
} from '@commerce/incident-bundle';
import type { LoadGeneratorOptions, RunReport as LoadRunReport } from '@commerce/loadgen';
import { getProfile } from '@commerce/loadgen';
import {
  budgetedCommand,
  budgetedFetch,
  CategorizedError,
  isAborted,
  raceSignals,
  sleep,
  timerSignal,
  withTimeout,
  type BudgetState,
  type FailureCategory,
  type Monotonic,
  type SignalRunCommand,
  type Timers,
} from './budget.js';
import type { HttpFetch } from './capture/deps.js';
import { captureTraces, type TracesCapture, type TracesOptions } from './capture/jaeger.js';
import { captureLogs, type LogsCapture } from './capture/logs.js';
import { captureMetrics, type MetricsCapture } from './capture/prometheus.js';
import type { IncidentConfig } from './config.js';
import {
  createControl,
  request,
  stopProcedure,
  STOP_PROCEDURE_MS,
  type Control,
} from './control.js';
import { poll, renderCondition } from './detect.js';
import {
  bundleIdTaken,
  moveInvalidBundle,
  NODE_EVIDENCE_FS,
  preserveEvidence,
  type EvidenceFs,
  type EvidenceResult,
  type FailureRecord,
} from './evidence.js';
import {
  message,
  runIsolationChecks,
  type ComposeContainer,
  type RuntimeVerification,
} from './isolation.js';
import {
  acquireLock,
  describeStale,
  NODE_LOCK_FS,
  releaseLock,
  type LockFs,
  type LockInfo,
} from './lock.js';
import { images, producer, services as serviceMetadata } from './metadata.js';
import { createRedactor } from './redact.js';

/**
 * `pnpm incident run` (docs/prompts/m5c-design.md, sections 4 to 6 and 9): phases in order, with
 * the load plan, the fault lifecycle and detection running concurrently inside LOAD_AND_FAULT, one
 * canonical cleanup, and outcomes that never present failed, invalid or truncated evidence as
 * complete. All times come from injected clocks; every deadline is on the monotonic clock.
 */
export const LIMITS = {
  checksMs: 15_000,
  lockMs: 1_000,
  preflightMs: 30_000,
  preflightRequestMs: 5_000,
  loadStartMs: 30_000,
  triggerMs: 30_000,
  startRequestMs: 10_000,
  poisonOrderMs: 5_000,
  stopAtMs: 120_000,
  pollEndMs: 150_000,
  pollIntervalMs: 5_000,
  pollTimeoutMs: 4_000,
  loadSettleMs: 160_000,
  flushMs: 15_000,
  metrics: { budgetMs: 40_000, attemptMs: 10_000 },
  traces: { budgetMs: 50_000, attemptMs: 15_000 },
  logs: { budgetMs: 30_000, commandMs: 15_000 },
  writeMs: 30_000,
  validateMs: 30_000,
  globalMs: 600_000,
  loadCancelMs: 6_000,
  lockReleaseMs: 1_000,
  faultDurationMs: 90_000,
  minFreeBytes: 1024 ** 3,
} as const;

export const SERVICES = ['orders-api', 'worker'] as const;

export interface RunConfig extends IncidentConfig {
  scenario: ScenarioName;
  seed: number;
}

export interface Captures {
  metrics(options: {
    captureFrom: Date;
    captureTo: Date;
    baseUrl: string;
    fetch: HttpFetch;
  }): Promise<MetricsCapture>;
  traces(options: TracesOptions): Promise<TracesCapture>;
  logs(options: {
    captureFrom: Date;
    captureTo: Date;
    services: readonly string[];
    runCommand: (
      command: string,
      args: readonly string[],
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }): Promise<LogsCapture>;
}

export const M5B_CAPTURES: Captures = {
  metrics: captureMetrics,
  traces: captureTraces,
  logs: captureLogs,
};

export interface LoadGeneratorLike {
  readonly planHash: string;
  run(): Promise<LoadRunReport>;
}

export interface RunDeps {
  wallClock: () => Date;
  monotonic: Monotonic;
  timers: Timers;
  fetch: HttpFetch;
  runCommand: SignalRunCommand;
  /** Aborted on the first SIGINT or SIGTERM, with the signal's name as the reason. */
  interrupt: AbortSignal;
  verification: RuntimeVerification;
  hostname: string;
  pid: number;
  createLoadGenerator: (options: LoadGeneratorOptions) => LoadGeneratorLike;
  freeBytes: (dir: string) => Promise<number>;
  lockFs?: LockFs;
  evidenceFs?: EvidenceFs;
  bundleFs?: BundleFs;
  captures?: Captures;
  writeBundle?: typeof defaultWrite;
  validateBundle?: (dir: string) => Promise<ValidationResult>;
  /** Called when cleanup starts, so a signal handler knows a second signal interrupts cleanup. */
  onCleanupStart?: () => void;
}

export type Outcome =
  'success' | 'symptom_not_detected' | 'orchestration_failure' | 'evidence_failure' | 'interrupted';
export type CleanupState = 'succeeded' | 'failed';

export interface IncidentReport {
  outcome: Outcome;
  stage?: string;
  detail?: string;
  signal?: 'SIGINT' | 'SIGTERM';
  bundle: { state: 'valid' | 'invalid' | 'none'; path?: string };
  evidence:
    | { state: 'complete' }
    | { state: 'incomplete'; reasons: string[] }
    | { state: 'preserved'; path: string; files: string[] }
    | { state: 'partially_preserved'; path: string; files: string[]; failed: string[] }
    | { state: 'not_preserved'; error: string }
    | { state: 'none'; reason: string };
  cleanup: { state: CleanupState; steps: { step: 'stop' | 'load' | 'lock'; result: string }[] };
  warnings: string[];
  redactions: number;
}

/** A failure inside the run, with its outcome class. */
class RunFailure extends Error {
  constructor(
    readonly outcome: 'orchestration_failure' | 'evidence_failure',
    readonly stage: string,
    detail: string,
    readonly evidence?: IncidentReport['evidence'],
    readonly bundle?: IncidentReport['bundle'],
  ) {
    super(detail);
  }
}

const DEADLINE = Symbol('global deadline');

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function bundleIdFor(scenario: string, seed: number, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${scenario}-${String(seed)}-${stamp}`;
}

interface Ctx {
  lock?: { path: string; info: LockInfo };
  possiblyActive: boolean;
  stopInProgress: boolean;
  stopPromise?: Promise<{ confirmed: boolean; detail: string }>;
  stopConfirmed: boolean;
  loadRunning: boolean;
  loadController: AbortController;
  loadPromise?: Promise<unknown>;
}

export async function runIncident(config: RunConfig, deps: RunDeps): Promise<IncidentReport> {
  const warnings: string[] = [];
  const evidenceFs = deps.evidenceFs ?? NODE_EVIDENCE_FS;
  const lockFs = deps.lockFs ?? NODE_LOCK_FS;
  const simple = (command: string, args: readonly string[]) => {
    const t = timerSignal(deps.timers, LIMITS.checksMs, new Error(`${command} timed out`));
    return deps
      .runCommand(command, args, AbortSignal.any([t.signal, deps.interrupt]))
      .finally(t.cancel);
  };
  const ctx: Ctx = {
    possiblyActive: false,
    stopInProgress: false,
    stopConfirmed: false,
    loadRunning: false,
    loadController: new AbortController(),
  };
  const notNeeded: IncidentReport['cleanup'] = {
    state: 'succeeded',
    steps: [
      { step: 'stop', result: 'not needed' },
      { step: 'load', result: 'not needed' },
      { step: 'lock', result: 'not held' },
    ],
  };
  const early = (stage: string, detail: string): IncidentReport => ({
    outcome: deps.interrupt.aborted ? 'interrupted' : 'orchestration_failure',
    stage,
    detail,
    ...(deps.interrupt.aborted ? { signal: deps.interrupt.reason as 'SIGINT' | 'SIGTERM' } : {}),
    bundle: { state: 'none' },
    evidence: { state: 'none', reason: 'the run stopped before the load started' },
    cleanup: notNeeded,
    warnings,
    redactions: 0,
  });

  // CHECKS: configuration and local isolation, before any lock.
  let containers: ComposeContainer[];
  try {
    const iso = await withTimeout(
      deps.timers,
      LIMITS.checksMs,
      runIsolationChecks({
        config,
        run: simple,
        fetch: deps.fetch,
        verification: deps.verification,
      }),
      'isolation checks',
    );
    containers = iso.containers;
    const bad = iso.checks.filter((c) => c.status !== 'PASS');
    if (bad.length > 0) {
      return early(
        'checks',
        `live runs are blocked: ${bad.map((c) => `${c.name} ${c.status}: ${c.detail}`).join('; ')}`,
      );
    }
  } catch (err) {
    return early('checks', message(err));
  }
  if (deps.interrupt.aborted) return early('checks', 'interrupted before the lock was taken');

  // LOCK.
  const info: LockInfo = {
    pid: deps.pid,
    hostname: deps.hostname,
    startedAt: deps.wallClock().toISOString(),
    scenario: config.scenario,
    seed: config.seed,
  };
  const acquired = await withTimeout(
    deps.timers,
    LIMITS.lockMs,
    acquireLock(config.incidentsDir, info, { fs: lockFs }),
    'lock',
  ).catch((err: unknown) => ({ kind: 'error' as const, path: '', message: message(err) }));
  if (acquired.kind === 'held')
    return early('lock', `another run is in progress: ${JSON.stringify(acquired.holder)}`);
  if (acquired.kind === 'stale') return early('lock', describeStale(acquired));
  if (acquired.kind === 'error')
    return early('lock', `the lock could not be created: ${acquired.message}`);
  ctx.lock = { path: acquired.path, info };

  // The global deadline starts now.
  const globalDeadline = deps.monotonic.now() + LIMITS.globalMs;
  const global = timerSignal(deps.timers, LIMITS.globalMs, DEADLINE);
  const workSignal = AbortSignal.any([global.signal, deps.interrupt]);
  const control = createControl({
    baseUrl: config.ordersApiUrl,
    fetch: deps.fetch,
    timers: deps.timers,
    monotonic: deps.monotonic,
  });

  let result: Omit<IncidentReport, 'cleanup' | 'warnings'>;
  try {
    result = await work(config, deps, {
      ctx,
      control,
      workSignal,
      globalDeadline,
      containers,
      warnings,
      evidenceFs,
    });
    // A signal during the uninterruptible write and validation: the bundle's state stays truthful.
    if (isAborted(deps.interrupt)) {
      result = {
        ...result,
        outcome: 'interrupted',
        signal: deps.interrupt.reason as 'SIGINT' | 'SIGTERM',
        detail: 'interrupted during writing or validation',
      };
    }
  } catch (err) {
    const redactions = 0;
    if (err instanceof RunFailure && !isAborted(deps.interrupt) && !isAborted(global.signal)) {
      result = {
        outcome: err.outcome,
        stage: err.stage,
        detail: err.message,
        bundle: err.bundle ?? { state: 'none' },
        evidence: err.evidence ?? {
          state: 'none',
          reason: 'no capture after an orchestration failure',
        },
        redactions,
      };
    } else if (isAborted(deps.interrupt)) {
      result = {
        outcome: 'interrupted',
        signal: deps.interrupt.reason as 'SIGINT' | 'SIGTERM',
        stage: err instanceof RunFailure ? err.stage : 'run',
        detail: 'interrupted by a signal',
        bundle: err instanceof RunFailure && err.bundle ? err.bundle : { state: 'none' },
        evidence: { state: 'none', reason: 'interrupted; nothing captured' },
        redactions,
      };
    } else if (isAborted(global.signal)) {
      result = {
        outcome: 'orchestration_failure',
        stage: 'deadline',
        detail: `the run reached its ${String(LIMITS.globalMs / 1000)} s global deadline`,
        bundle: { state: 'none' },
        evidence: { state: 'none', reason: 'the global deadline ended the run; nothing captured' },
        redactions,
      };
    } else {
      result = {
        outcome: 'orchestration_failure',
        stage: 'internal',
        detail: message(err),
        bundle: { state: 'none' },
        evidence: { state: 'none', reason: 'no capture after an orchestration failure' },
        redactions,
      };
    }
  } finally {
    global.cancel();
  }

  deps.onCleanupStart?.();
  const cleanup = await runCleanup(ctx, control, deps, lockFs);
  return { ...result, cleanup, warnings };
}

interface WorkEnv {
  ctx: Ctx;
  control: Control;
  workSignal: AbortSignal;
  globalDeadline: number;
  containers: ComposeContainer[];
  warnings: string[];
  evidenceFs: EvidenceFs;
}

async function work(
  config: RunConfig,
  deps: RunDeps,
  env: WorkEnv,
): Promise<Omit<IncidentReport, 'cleanup' | 'warnings'>> {
  const { ctx, control, workSignal } = env;
  const { timers, monotonic } = deps;
  const guard = <T>(p: Promise<T>) => raceSignals(p, [workSignal]);
  const orchestration = (stage: string, detail: string) =>
    new RunFailure('orchestration_failure', stage, detail);
  const groundTruth = buildGroundTruth(config.scenario, config.seed);

  // PREFLIGHT, 30 s.
  const preflightTimer = timerSignal(
    timers,
    LIMITS.preflightMs,
    new CategorizedError('timeout', 'the preflight timed out'),
  );
  const pre = <T>(p: Promise<T>) => raceSignals(p, [workSignal, preflightTimer.signal]);
  let bundleId: string;
  let producerInfo: { commit: string; dirty: boolean };
  try {
    const ready = await pre(control.readyz(LIMITS.preflightRequestMs));
    if (ready !== 200)
      throw orchestration('preflight', `the orders API /readyz returned ${String(ready)}`);
    const listed = await pre(control.list(LIMITS.preflightRequestMs));
    if (listed.status === 404)
      throw orchestration(
        'preflight',
        'fault injection is not enabled (GET /admin/scenarios returned 404)',
      );
    if (!listed.versions)
      throw orchestration('preflight', `GET /admin/scenarios returned ${String(listed.status)}`);
    const served = listed.versions.get(config.scenario);
    const expected = SCENARIOS[config.scenario].version;
    if (served !== expected) {
      throw orchestration(
        'preflight',
        `scenario version mismatch: the running image serves ${config.scenario} version ${String(served)}, the checkout has version ${String(expected)}`,
      );
    }
    const active = await pre(control.active(LIMITS.preflightRequestMs));
    if (active !== 'none')
      throw orchestration('preflight', `a scenario may already be active (report: ${active})`);
    const reqDeps = { fetch: deps.fetch, timers, monotonic };
    const prom = await pre(
      request(
        { ...reqDeps, baseUrl: config.prometheusUrl },
        'GET',
        '/-/ready',
        LIMITS.preflightRequestMs,
      ),
    );
    if (prom.status !== 200)
      throw orchestration('preflight', `Prometheus /-/ready returned ${String(prom.status)}`);
    const jaeger = await pre(
      request({ ...reqDeps, baseUrl: config.jaegerUrl }, 'GET', '/', LIMITS.preflightRequestMs),
    );
    if (jaeger.status !== 200)
      throw orchestration('preflight', `Jaeger returned ${String(jaeger.status)}`);
    producerInfo = await pre(
      producer((command, args) =>
        deps.runCommand(command, args, AbortSignal.any([workSignal, preflightTimer.signal])),
      ),
    );
    const free = await pre(deps.freeBytes(config.incidentsDir));
    if (free < LIMITS.minFreeBytes) {
      throw orchestration(
        'preflight',
        `only ${String(Math.floor(free / 1024 ** 2))} MiB free in ${config.incidentsDir}; 1 GiB is required`,
      );
    }
    bundleId = bundleIdFor(config.scenario, config.seed, deps.wallClock());
    if (!BUNDLE_ID.test(bundleId))
      throw orchestration('preflight', `bundle ID ${bundleId} does not match the M5b format`);
    const taken = await pre(bundleIdTaken(config.incidentsDir, bundleId, env.evidenceFs));
    if (taken !== undefined)
      throw orchestration('bundle-id', `${taken} already exists; no load or fault was started`);
  } catch (err) {
    if (err instanceof RunFailure) throw err;
    if (workSignal.aborted) throw err;
    throw orchestration('preflight', message(err));
  } finally {
    preflightTimer.cancel();
  }

  // LOAD_AND_FAULT.
  let T = 0;
  let loadStartedAt: Date | undefined;
  let loadEndedAt: Date | undefined;
  const planStarted = deferred<undefined>();
  const profile = getProfile('incident');
  if (!profile) throw orchestration('load', 'the incident load profile is not registered');
  const generator = deps.createLoadGenerator({
    profile,
    seed: config.seed,
    baseUrl: config.ordersApiUrl,
    clock: monotonic,
    timers: { setTimeout: (fn, ms) => timers.setTimeout(fn, ms) },
    signal: ctx.loadController.signal,
    onPlanStart: (atMs) => {
      T = atMs;
      loadStartedAt = deps.wallClock();
      planStarted.resolve(undefined);
    },
  });
  ctx.loadRunning = true;
  const loadPromise = generator.run().then(
    (report) => {
      ctx.loadRunning = false;
      loadEndedAt = deps.wallClock();
      return report;
    },
    (err: unknown) => {
      ctx.loadRunning = false;
      throw err;
    },
  );
  ctx.loadPromise = loadPromise;
  loadPromise.catch(() => undefined);

  const startTimer = timerSignal(timers, LIMITS.loadStartMs, 'timeout');
  type StartOutcome =
    | { kind: 'started' }
    | { kind: 'ended'; report: LoadRunReport }
    | { kind: 'failed'; error: unknown }
    | { kind: 'timeout' };
  const started: StartOutcome = await guard(
    Promise.race<StartOutcome>([
      planStarted.promise.then(() => ({ kind: 'started' })),
      loadPromise.then(
        (report) => ({ kind: 'ended', report }),
        (error: unknown) => ({ kind: 'failed', error }),
      ),
      new Promise<StartOutcome>((resolve) => {
        startTimer.signal.addEventListener('abort', () => {
          resolve({ kind: 'timeout' });
        });
      }),
    ]),
  ).finally(startTimer.cancel);
  if (started.kind === 'ended') {
    throw orchestration(
      'load',
      `the load generator's preflight failed: ${started.report.preflight.failure ?? 'unknown reason'}`,
    );
  }
  if (started.kind === 'failed')
    throw orchestration('load', `the load generator failed: ${message(started.error)}`);
  if (started.kind === 'timeout')
    throw orchestration(
      'load',
      `the load plan did not start within ${String(LIMITS.loadStartMs / 1000)} s`,
    );

  const phase = new AbortController();
  const phaseSignal = AbortSignal.any([workSignal, phase.signal]);
  let failure: RunFailure | undefined;
  const failWith = (f: RunFailure) => {
    failure ??= f;
    phase.abort(f);
  };
  const until = (offsetMs: number) => sleep(timers, T + offsetMs - monotonic.now(), [phaseSignal]);

  let triggerStartedAt: Date | undefined;
  const stop: { at: Date | null } = { at: null };
  const detection = { polls: 0, failed: [] as string[], detectedAt: undefined as Date | undefined };
  let detectionTask: Promise<void> = Promise.resolve();

  const detect = async () => {
    const query = renderCondition(groundTruth.primarySymptom);
    const pollDeps = { fetch: deps.fetch, timers, monotonic, prometheusUrl: config.prometheusUrl };
    for (;;) {
      const pollStart = monotonic.now();
      if (pollStart > T + LIMITS.pollEndMs || phaseSignal.aborted) return;
      const res = await poll(pollDeps, query, LIMITS.pollTimeoutMs);
      detection.polls += 1;
      if (res.kind === 'sample') {
        detection.detectedAt = deps.wallClock();
        return;
      }
      if (res.kind === 'failed') detection.failed.push(res.reason);
      const next = pollStart + LIMITS.pollIntervalMs;
      if (next > T + LIMITS.pollEndMs) return;
      await sleep(timers, next - monotonic.now(), [phaseSignal]);
    }
  };

  const faultTask = (async () => {
    await until(LIMITS.triggerMs);
    ctx.possiblyActive = true;
    let status: number;
    try {
      status = await control.start(
        config.scenario,
        config.seed,
        LIMITS.faultDurationMs,
        LIMITS.startRequestMs,
      );
    } catch (err) {
      failWith(orchestration('fault-start', message(err)));
      return;
    }
    if (status !== 202) {
      failWith(
        orchestration(
          'fault-start',
          `POST /admin/scenarios/${config.scenario}/start returned ${String(status)}`,
        ),
      );
      return;
    }
    triggerStartedAt = deps.wallClock();
    detectionTask = detect().catch(() => undefined);
    if (config.scenario === 'poison-order') {
      try {
        const order = await control.placeOrder(
          poisonSku(config.seed),
          `incident-${bundleId}-poison`,
          LIMITS.poisonOrderMs,
        );
        if (order !== 201 && order !== 200)
          throw new Error(`POST /orders returned ${String(order)}`);
      } catch (err) {
        failWith(orchestration('poison-order', message(err)));
        return;
      }
    }
    await until(LIMITS.stopAtMs);
    ctx.stopInProgress = true;
    ctx.stopPromise = stopProcedure(control, { timers, monotonic });
    const stopped = await ctx.stopPromise;
    ctx.stopInProgress = false;
    if (stopped.confirmed) {
      ctx.possiblyActive = false;
      ctx.stopConfirmed = true;
      stop.at = deps.wallClock();
    } else {
      env.warnings.push(`the normal stop was not confirmed: ${stopped.detail}`);
    }
  })().catch(() => undefined);

  const loadTask = (async () => {
    const settle = timerSignal(timers, T + LIMITS.loadSettleMs - monotonic.now(), 'timeout');
    try {
      const report = await raceSignals(loadPromise, [settle.signal, phaseSignal]);
      if (!report.results) failWith(orchestration('load', 'the load plan did not run'));
    } catch (err) {
      if (settle.signal.aborted)
        failWith(
          orchestration(
            'load',
            `the load plan did not settle by T+${String(LIMITS.loadSettleMs / 1000)} s`,
          ),
        );
      else if (!phaseSignal.aborted)
        failWith(orchestration('load', `the load generator failed: ${message(err)}`));
    } finally {
      settle.cancel();
    }
  })();

  await Promise.all([faultTask, loadTask]);
  await detectionTask;
  if (workSignal.aborted) throw new Error('aborted');
  if (failure) throw failure;
  if (!loadStartedAt || !loadEndedAt || !triggerStartedAt)
    throw orchestration('load', 'the run did not complete its timeline');
  const detected = detection.detectedAt;
  if (!detected && detection.failed.length > 0) {
    throw orchestration(
      'detection',
      `inconclusive: ${String(detection.failed.length)} of ${String(detection.polls)} polls failed (${[...new Set(detection.failed)].join('; ')}), and the symptom was not seen`,
    );
  }
  const load = await loadPromise;

  // FLUSH.
  await guard(sleep(timers, LIMITS.flushMs, [workSignal]));

  // CAPTURE: metrics, traces, logs, each within its budget.
  const captures = deps.captures ?? M5B_CAPTURES;
  const window = {
    captureFrom: loadStartedAt,
    captureTo: new Date(loadEndedAt.getTime() + LIMITS.flushMs),
  };
  const done: { metrics?: MetricsCapture; traces?: TracesCapture; logs?: LogsCapture } = {};
  const redactor = createRedactor();
  const files = () =>
    [
      done.metrics
        ? { name: 'metrics.jsonl', content: toJsonl(redactor.value(done.metrics.records)) }
        : undefined,
      done.traces
        ? { name: 'traces.jsonl', content: toJsonl(redactor.value(done.traces.records)) }
        : undefined,
      done.logs
        ? { name: 'logs.jsonl', content: toJsonl(redactor.value(done.logs.records)) }
        : undefined,
      {
        name: 'capture-summary.json',
        content: canonicalJson({
          metrics: done.metrics?.summary,
          traces: done.traces?.summary,
          logs: done.logs?.summary,
        }),
      },
    ].filter((f): f is { name: string; content: string } => f !== undefined);
  const evidenceFailure = async (
    stage: FailureRecord['stage'],
    category: FailureCategory,
    detail: string,
  ): Promise<never> => {
    const failureRecord: Omit<FailureRecord, 'files'> = {
      failureVersion: 1,
      bundleId,
      stage,
      category,
      message: redactor.text(detail),
      occurredAt: deps.wallClock().toISOString(),
      completedCaptures: Object.keys(done),
    };
    const preserved = await preserveEvidence(
      config.incidentsDir,
      files(),
      failureRecord,
      env.evidenceFs,
    );
    throw new RunFailure('evidence_failure', stage, detail, evidenceReport(preserved));
  };
  const classify = (err: unknown, state?: BudgetState): FailureCategory => {
    if (err instanceof CategorizedError) return err.category;
    if (state?.lastStatus === undefined) return 'command';
    return state.lastStatus === 200 ? 'malformed-response' : 'http';
  };
  const runSource = async <T>(
    stage: FailureRecord['stage'],
    budget: { budgetMs: number; attemptMs: number },
    fn: (fetch: HttpFetch) => Promise<T>,
  ): Promise<T> => {
    const b = budgetedFetch(deps.fetch, {
      monotonic,
      timers,
      sourceDeadline: monotonic.now() + budget.budgetMs,
      globalDeadline: env.globalDeadline,
      interrupt: deps.interrupt,
      attemptTimeoutMs: budget.attemptMs,
    });
    try {
      return await guard(fn(b.fetch));
    } catch (err) {
      if (isAborted(workSignal)) throw err;
      const category = classify(err, b.state);
      if (category === 'deadline' || category === 'interrupted') throw err;
      return await evidenceFailure(stage, category, message(err));
    } finally {
      b.dispose();
    }
  };
  done.metrics = await runSource('capture-metrics', LIMITS.metrics, (fetch) =>
    captures.metrics({ ...window, baseUrl: config.prometheusUrl, fetch }),
  );
  done.traces = await runSource('capture-traces', LIMITS.traces, (fetch) =>
    captures.traces({ ...window, baseUrl: config.jaegerUrl, fetch, services: SERVICES }),
  );
  const logsStart = monotonic.now();
  try {
    done.logs = await guard(
      captures.logs({
        ...window,
        services: SERVICES,
        runCommand: budgetedCommand(deps.runCommand, {
          monotonic,
          timers,
          sourceDeadline: logsStart + LIMITS.logs.budgetMs,
          globalDeadline: env.globalDeadline,
          interrupt: deps.interrupt,
          commandTimeoutMs: LIMITS.logs.commandMs,
          onUnreaped: (command) =>
            env.warnings.push(`a timed-out ${command} process had not exited when it was killed`),
        }),
      }),
    );
  } catch (err) {
    if (isAborted(workSignal)) throw err;
    const category = err instanceof CategorizedError ? err.category : 'command';
    if (category === 'deadline' || category === 'interrupted') throw err;
    await evidenceFailure('capture-logs', category, message(err));
  }
  if (!done.logs) throw orchestration('capture', 'log capture returned nothing');

  // REDACT, then build the bundle contents.
  let traces: TraceRecord[];
  let metrics: MetricsRecord[];
  let logs: LogsRecord[];
  try {
    traces = redactor.value(done.traces.records);
    metrics = redactor.value(done.metrics.records);
    logs = redactor.value(done.logs.records);
  } catch (err) {
    return await evidenceFailure('redact', 'validation', message(err));
  }
  const meta = serviceMetadata(SERVICES, traces, metrics);
  env.warnings.push(...meta.warnings);
  const truncated = done.traces.summary.services.filter((s) => s.truncated);
  for (const s of truncated) {
    env.warnings.push(
      `trace evidence may be incomplete: ${s.name} ${s.truncationReasons.join(', ')}`,
    );
  }
  const manifest: ManifestBody = {
    schemaVersion: SCHEMA_VERSION,
    bundleId,
    createdAt: deps.wallClock().toISOString(),
    scenario: { name: config.scenario, version: groundTruth.scenario.version, seed: config.seed },
    window: {
      loadStartedAt: loadStartedAt.toISOString(),
      loadEndedAt: loadEndedAt.toISOString(),
      captureFrom: window.captureFrom.toISOString(),
      captureTo: window.captureTo.toISOString(),
    },
    trigger: {
      startedAt: triggerStartedAt.toISOString(),
      stoppedAt: stop.at === null ? null : stop.at.toISOString(),
      requestedDurationMs: LIMITS.faultDurationMs,
    },
    detection: {
      detectedAt: detected ? detected.toISOString() : null,
      latencyMs: detected ? detected.getTime() - triggerStartedAt.getTime() : null,
      deadlineSeconds: groundTruth.primarySymptom.deadlineSeconds,
    },
    producer: {
      repository: 'commerce-platform',
      commit: producerInfo.commit,
      dirty: producerInfo.dirty,
    },
    services: meta.services,
    infrastructure: { images: images(env.containers) },
    load: {
      profile: 'incident',
      seed: config.seed,
      planHash: generator.planHash,
      runPrefix: load.runPrefix,
    },
    capture: {
      traces: done.traces.summary,
      metrics: done.metrics.summary,
      logs: done.logs.summary,
    },
  };

  // WRITE, 30 s. Not interruptible once started, so the report can say where the bundle is.
  const write = deps.writeBundle ?? defaultWrite;
  let dir: string;
  try {
    dir = (
      await withTimeout(
        timers,
        LIMITS.writeMs,
        write(
          config.incidentsDir,
          { manifest, groundTruth, traces, metrics, logs },
          deps.bundleFs ?? NODE_BUNDLE_FS,
        ),
        'writing the bundle',
      )
    ).dir;
  } catch (err) {
    return await evidenceFailure(
      'write',
      err instanceof CategorizedError ? err.category : 'filesystem',
      message(err),
    );
  }

  // VALIDATE, 30 s.
  const validate = deps.validateBundle ?? defaultValidate;
  let validation: ValidationResult;
  try {
    validation = await withTimeout(
      timers,
      LIMITS.validateMs,
      validate(dir),
      'validating the bundle',
    );
  } catch (err) {
    validation = { valid: false, errors: [{ file: 'bundle', message: message(err) }] };
  }
  if (!validation.valid) {
    const moved = await moveInvalidBundle(
      config.incidentsDir,
      dir,
      {
        failureVersion: 1,
        bundleId,
        stage: 'validate',
        category: 'validation',
        message: redactor.text(
          validation.errors
            .map((e) => `${e.file}${e.field ? `: ${e.field}` : ''}: ${e.message}`)
            .join('; '),
        ),
        occurredAt: deps.wallClock().toISOString(),
        completedCaptures: ['metrics', 'traces', 'logs'],
      },
      env.evidenceFs,
    );
    if (!moved.moved) env.warnings.push(`the invalid bundle could not be moved: ${moved.error}`);
    throw new RunFailure(
      'evidence_failure',
      'validate',
      `the bundle is invalid: ${validation.errors.length} error(s)`,
      { state: 'none', reason: 'the bundle failed validation' },
      { state: 'invalid', path: moved.location },
    );
  }

  const reasons: string[] = [];
  if (!ctx.stopConfirmed) reasons.push('the scenario stop was not confirmed');
  for (const s of truncated)
    reasons.push(`traces truncated for ${s.name}: ${s.truncationReasons.join(', ')}`);
  return {
    outcome: detected ? 'success' : 'symptom_not_detected',
    bundle: { state: 'valid', path: dir },
    evidence: reasons.length === 0 ? { state: 'complete' } : { state: 'incomplete', reasons },
    redactions: redactor.count,
  };
}

function evidenceReport(result: EvidenceResult): IncidentReport['evidence'] {
  if (result.state === 'not_preserved') return { state: 'not_preserved', error: result.error };
  if (result.state === 'preserved')
    return { state: 'preserved', path: result.path, files: result.written };
  return {
    state: 'partially_preserved',
    path: result.path,
    files: result.written,
    failed: result.failed,
  };
}

/** The canonical cleanup (section 5). */
async function runCleanup(
  ctx: Ctx,
  control: Control,
  deps: RunDeps,
  lockFs: LockFs,
): Promise<IncidentReport['cleanup']> {
  const { timers, monotonic } = deps;
  let stopTask: Promise<string>;
  if (ctx.stopInProgress && ctx.stopPromise) {
    stopTask = ctx.stopPromise.then((r) =>
      r.confirmed ? 'confirmed' : `unconfirmed: ${r.detail}`,
    );
  } else if (ctx.possiblyActive) {
    ctx.stopInProgress = true;
    stopTask = stopProcedure(control, { timers, monotonic }).then((r) =>
      r.confirmed ? 'confirmed' : `unconfirmed: ${r.detail}`,
    );
  } else {
    stopTask = Promise.resolve(ctx.stopConfirmed ? 'not needed (confirmed earlier)' : 'not needed');
  }
  let loadTask: Promise<string> = Promise.resolve('not needed');
  if (ctx.loadRunning && ctx.loadPromise) {
    ctx.loadController.abort(new Error('cleanup'));
    const settled = ctx.loadPromise.then(
      () => 'settled',
      () => 'settled',
    );
    loadTask = withTimeout(timers, LIMITS.loadCancelMs, settled, 'load cancellation').catch(
      () => 'timed out',
    );
  }
  const [stop, load] = await Promise.all([
    withTimeout(timers, STOP_PROCEDURE_MS + 1_000, stopTask, 'stop procedure').catch(
      () => 'unconfirmed: timed out',
    ),
    loadTask,
  ]);
  let lock = 'not held';
  if (ctx.lock) {
    lock = await withTimeout(
      timers,
      LIMITS.lockReleaseMs,
      releaseLock(ctx.lock.path, ctx.lock.info, lockFs),
      'lock release',
    ).catch(() => 'failed');
  }
  const ok =
    (stop === 'confirmed' || stop.startsWith('not needed')) &&
    (load === 'not needed' || load === 'settled') &&
    lock === 'released';
  return {
    state: ok ? 'succeeded' : 'failed',
    steps: [
      { step: 'stop', result: stop },
      { step: 'load', result: load },
      { step: 'lock', result: lock },
    ],
  };
}

const PRIMARY_CODES: Record<Exclude<Outcome, 'interrupted'>, number> = {
  success: 0,
  symptom_not_detected: 2,
  orchestration_failure: 1,
  evidence_failure: 3,
};
export const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

/** Section 9: a cleanup failure replaces only 0 and 2; failure codes and signal codes stay. */
export function exitCodeFor(
  report: Pick<IncidentReport, 'outcome' | 'signal' | 'cleanup'>,
): number {
  if (report.outcome === 'interrupted') return SIGNAL_CODES[report.signal ?? 'SIGINT'];
  const primary = PRIMARY_CODES[report.outcome];
  if (report.cleanup.state === 'failed' && (primary === 0 || primary === 2)) return 4;
  return primary;
}

/** The report's text; it always ends with the four lines of section 9. */
export function formatReport(report: IncidentReport): string {
  const lines: string[] = [];
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  if (report.redactions > 0) lines.push(`redactions: ${String(report.redactions)}`);
  if (report.detail) lines.push(`detail: ${report.detail}`);
  const outcome =
    report.outcome === 'interrupted'
      ? `interrupted (${report.signal ?? 'signal'})`
      : report.outcome === 'orchestration_failure' || report.outcome === 'evidence_failure'
        ? `${report.outcome} (${report.stage ?? 'unknown'})`
        : report.outcome;
  const bundle =
    report.bundle.state === 'none' ? 'none' : `${report.bundle.state} ${report.bundle.path ?? ''}`;
  const e = report.evidence;
  const evidence =
    e.state === 'complete'
      ? 'complete'
      : e.state === 'incomplete'
        ? `incomplete (${e.reasons.join('; ')})`
        : e.state === 'preserved'
          ? `preserved ${e.path} (${e.files.join(', ')})`
          : e.state === 'partially_preserved'
            ? `partially preserved ${e.path} (${e.files.join(', ')}; failed: ${e.failed.join(', ')})`
            : e.state === 'not_preserved'
              ? `not preserved (${e.error})`
              : `none (${e.reason})`;
  const cleanup =
    report.cleanup.state === 'succeeded'
      ? 'succeeded'
      : `failed (${report.cleanup.steps.map((s) => `${s.step}: ${s.result}`).join('; ')})`;
  lines.push(
    `outcome: ${outcome}`,
    `bundle: ${bundle}`,
    `evidence: ${evidence}`,
    `cleanup: ${cleanup}`,
  );
  return `${lines.join('\n')}\n`;
}
