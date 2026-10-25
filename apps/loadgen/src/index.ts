import { generatePlan, planHash, type Plan } from './plan.js';
import { runPreflight, type PreflightResult } from './preflight.js';
import type { Profile } from './profiles.js';
import {
  createRunPrefix,
  monotonicClock,
  nodeFetch,
  realTimers,
  runPlan,
  type Clock,
  type HttpFetch,
  type Timers,
} from './runner.js';
import { buildReport, evaluate, type EntryResult, type Report, type Verdict } from './stats.js';

/**
 * The load generator factory: the CLI uses it, and M5's scenario runner will call it in-process
 * (docs/prompts/m4-design.md, "M5 integration").
 */
export interface LoadGeneratorOptions {
  readonly profile: Profile;
  readonly seed: number;
  readonly baseUrl: string;
  readonly clock?: Clock;
  readonly timers?: Timers;
  /** The UUID source for the per-run idempotency prefix. */
  readonly random?: () => string;
  readonly fetch?: HttpFetch;
  /** Tests only: a timeout signal their fake clock controls. */
  readonly timeoutSignal?: (ms: number) => AbortSignal;
  /**
   * M5c (docs/prompts/m5c-design.md, section 3): called once, synchronously, when the plan starts
   * after the preflight has passed, with the clock's `now()` in milliseconds. Never called when the
   * preflight fails or the run is cancelled first. If it throws, `run()` rejects before any plan
   * request is sent.
   */
  readonly onPlanStart?: (atMs: number) => void;
  /**
   * M5c: cancels the run. Before or during the preflight, `run()` rejects with the signal's reason
   * and sends no plan request. During the plan, no entry is scheduled, in-flight requests are
   * aborted, and `run()` rejects once they have settled: within the 5 s request timeout of the
   * abort, plus event-loop latency.
   */
  readonly signal?: AbortSignal;
}

export interface RunReport {
  readonly runPrefix: string;
  readonly preflight: PreflightResult;
  /** Present only when the preflight passed and the plan ran. */
  readonly results?: readonly EntryResult[];
  readonly report?: Report;
  readonly verdict?: Verdict;
}

export interface LoadGenerator {
  readonly plan: Plan;
  readonly planHash: string;
  /** Preflight, then the plan. A failed preflight sends no planned request. */
  run(): Promise<RunReport>;
}

export function createLoadGenerator(options: LoadGeneratorOptions): LoadGenerator {
  const plan = generatePlan(options.profile, options.seed);
  const hash = planHash(plan);
  const fetch = options.fetch ?? nodeFetch;
  const { signal } = options;
  const baseTimeout = options.timeoutSignal;
  // Without a signal the requests' timeouts are exactly as before.
  const timeouts =
    signal === undefined
      ? baseTimeout
        ? { timeoutSignal: baseTimeout }
        : {}
      : {
          timeoutSignal: (ms: number) =>
            AbortSignal.any([(baseTimeout ?? ((t: number) => AbortSignal.timeout(t)))(ms), signal]),
        };
  return {
    plan,
    planHash: hash,
    async run() {
      if (signal?.aborted) throw signal.reason;
      const runPrefix = createRunPrefix(options.random);
      const preflight = await runPreflight(plan, { baseUrl: options.baseUrl, fetch, ...timeouts });
      if (signal?.aborted) throw signal.reason;
      if (!preflight.passed) return { runPrefix, preflight };
      const results = await runPlan(plan, {
        baseUrl: options.baseUrl,
        fetch,
        clock: options.clock ?? monotonicClock,
        timers: options.timers ?? realTimers,
        runPrefix,
        ...timeouts,
        ...(options.onPlanStart ? { onStart: options.onPlanStart } : {}),
        ...(signal ? { signal } : {}),
      });
      const report = buildReport(options.profile, results);
      return { runPrefix, preflight, results, report, verdict: evaluate(report) };
    },
  };
}

export { generatePlan, planHash, canonicalPlanText, summarizePlan } from './plan.js';
export type { Plan, PlanEntry } from './plan.js';
export { getProfile, profileNames, PROFILES, STEADY } from './profiles.js';
export type { Profile } from './profiles.js';
export type { PreflightResult } from './preflight.js';
export type { EntryResult, Report, Verdict } from './stats.js';
