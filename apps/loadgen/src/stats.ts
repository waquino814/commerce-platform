import type { Operation } from './plan.js';
import type { Profile } from './profiles.js';

/**
 * Accounting (docs/prompts/m4-design.md, "Accounting"). Every plan entry gets exactly one outcome;
 * only entries due inside the measured window count toward the report.
 */
export const REQUEST_TIMEOUT_MS = 5_000;

export type FailureReason = 'status' | 'timeout' | 'transport';

export type Outcome =
  | { readonly kind: 'successful'; readonly latencyMs: number; readonly status: number }
  | {
      readonly kind: 'failed';
      readonly latencyMs: number;
      readonly reason: FailureReason;
      /** The HTTP status, for `reason: 'status'`. */
      readonly status?: number;
    }
  | { readonly kind: 'missed' }
  | { readonly kind: 'skipped' };

export interface EntryResult {
  readonly index: number;
  readonly offsetMs: number;
  readonly op: Operation;
  readonly outcome: Outcome;
}

export interface Latency {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

export interface Counts {
  readonly offered: number;
  readonly sent: number;
  readonly successful: number;
  readonly failed: number;
  readonly missed: number;
  readonly skipped: number;
}

export interface Report extends Counts {
  readonly windowSeconds: number;
  /** successful ÷ window seconds. */
  readonly throughputRps: number;
  /** failed ÷ sent; 0 when nothing was sent. */
  readonly failureRate: number;
  /** missed ÷ offered; reported, not a threshold. */
  readonly missRate: number;
  /** skipped ÷ offered; reported, not a threshold. */
  readonly skipRate: number;
  readonly latencyMs: Latency;
  readonly failures: Readonly<Record<FailureReason, number>>;
  /** Failed responses by HTTP status, as strings for stable JSON keys. */
  readonly failedStatuses: Readonly<Record<string, number>>;
  readonly byOperation: Readonly<Record<Operation, Counts & { readonly latencyMs: Latency }>>;
}

export interface Thresholds {
  readonly minThroughputRps: number;
  readonly maxP95Ms: number;
  readonly maxFailureRate: number;
}

/** Roadmap M4: at least 50 rps, p95 under 200 ms, failure rate under 1%. */
export const STEADY_THRESHOLDS: Thresholds = Object.freeze({
  minThroughputRps: 50,
  maxP95Ms: 200,
  maxFailureRate: 0.01,
});

/** Nearest-rank percentile of `sorted` (ascending), or null when it is empty. */
export function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

function latencyOf(values: number[]): Latency {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
  };
}

function countsOf(results: readonly EntryResult[]): Counts & { latencyMs: Latency } {
  let successful = 0;
  let failed = 0;
  let missed = 0;
  let skipped = 0;
  const latencies: number[] = [];
  for (const { outcome } of results) {
    if (outcome.kind === 'successful' || outcome.kind === 'failed') {
      if (outcome.kind === 'successful') successful += 1;
      else failed += 1;
      latencies.push(outcome.latencyMs);
    } else if (outcome.kind === 'missed') {
      missed += 1;
    } else {
      skipped += 1;
    }
  }
  return {
    offered: results.length,
    sent: successful + failed,
    successful,
    failed,
    missed,
    skipped,
    latencyMs: latencyOf(latencies),
  };
}

/** Whether an entry is due inside the measured window, after the warm-up. */
export function inWindow(profile: Profile, offsetMs: number): boolean {
  return offsetMs >= profile.warmupMs && offsetMs < profile.durationMs;
}

export function buildReport(profile: Profile, results: readonly EntryResult[]): Report {
  const windowed = results.filter((r) => inWindow(profile, r.offsetMs));
  const totals = countsOf(windowed);
  const windowSeconds = (profile.durationMs - profile.warmupMs) / 1000;
  const failures: Record<FailureReason, number> = { status: 0, timeout: 0, transport: 0 };
  const failedStatuses: Record<string, number> = {};
  for (const { outcome } of windowed) {
    if (outcome.kind !== 'failed') continue;
    failures[outcome.reason] += 1;
    if (outcome.status !== undefined) {
      const key = String(outcome.status);
      failedStatuses[key] = (failedStatuses[key] ?? 0) + 1;
    }
  }
  const ops: Operation[] = ['product.list', 'order.create', 'order.read'];
  const byOperation = Object.fromEntries(
    ops.map((op) => [op, countsOf(windowed.filter((r) => r.op === op))]),
  ) as Report['byOperation'];
  return {
    offered: totals.offered,
    sent: totals.sent,
    successful: totals.successful,
    failed: totals.failed,
    missed: totals.missed,
    skipped: totals.skipped,
    windowSeconds,
    throughputRps: totals.successful / windowSeconds,
    failureRate: totals.sent === 0 ? 0 : totals.failed / totals.sent,
    missRate: totals.offered === 0 ? 0 : totals.missed / totals.offered,
    skipRate: totals.offered === 0 ? 0 : totals.skipped / totals.offered,
    latencyMs: totals.latencyMs,
    failures,
    failedStatuses,
    byOperation,
  };
}

export interface Verdict {
  readonly passed: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly detail: string;
  }[];
}

export function evaluate(report: Report, thresholds: Thresholds = STEADY_THRESHOLDS): Verdict {
  const p95 = report.latencyMs.p95;
  const checks = [
    {
      name: 'throughput',
      passed: report.throughputRps >= thresholds.minThroughputRps,
      detail: `${report.throughputRps.toFixed(2)} rps (min ${String(thresholds.minThroughputRps)})`,
    },
    {
      name: 'p95 latency',
      passed: p95 !== null && p95 < thresholds.maxP95Ms,
      detail: `${p95 === null ? 'n/a' : p95.toFixed(1)} ms (under ${String(thresholds.maxP95Ms)})`,
    },
    {
      name: 'failure rate',
      passed: report.failureRate < thresholds.maxFailureRate,
      detail: `${(report.failureRate * 100).toFixed(2)}% (under ${String(thresholds.maxFailureRate * 100)}%)`,
    },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}
