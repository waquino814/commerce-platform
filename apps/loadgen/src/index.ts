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
  const timeouts = options.timeoutSignal ? { timeoutSignal: options.timeoutSignal } : {};
  return {
    plan,
    planHash: hash,
    async run() {
      const runPrefix = createRunPrefix(options.random);
      const preflight = await runPreflight(plan, { baseUrl: options.baseUrl, fetch, ...timeouts });
      if (!preflight.passed) return { runPrefix, preflight };
      const results = await runPlan(plan, {
        baseUrl: options.baseUrl,
        fetch,
        clock: options.clock ?? monotonicClock,
        timers: options.timers ?? realTimers,
        runPrefix,
        ...timeouts,
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
