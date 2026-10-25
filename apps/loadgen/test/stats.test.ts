import { describe, expect, it } from 'vitest';
import type { Operation } from '../src/plan.js';
import { STEADY } from '../src/profiles.js';
import {
  buildReport,
  evaluate,
  inWindow,
  nearestRank,
  REQUEST_TIMEOUT_MS,
  STEADY_THRESHOLDS,
  type EntryResult,
  type Outcome,
} from '../src/stats.js';

/** M4 criterion 7: accounting identities, denominators, window, timeouts and percentiles. */
const ok = (latencyMs: number, status = 200): Outcome => ({
  kind: 'successful',
  latencyMs,
  status,
});
const failStatus = (status: number, latencyMs = 10): Outcome => ({
  kind: 'failed',
  latencyMs,
  reason: 'status',
  status,
});

let next = 0;
function at(offsetMs: number, outcome: Outcome, op: Operation = 'product.list'): EntryResult {
  next += 1;
  return { index: next, offsetMs, op, outcome };
}

describe('accounting (criterion 7)', () => {
  it('counts only entries due inside the 60 s window, after the 5 s warm-up', () => {
    expect(inWindow(STEADY, 4_999.9)).toBe(false);
    expect(inWindow(STEADY, 5_000)).toBe(true);
    expect(inWindow(STEADY, 64_999)).toBe(true);
    expect(inWindow(STEADY, 65_000)).toBe(false);
    const report = buildReport(STEADY, [at(0, ok(1)), at(4_999, ok(1)), at(5_000, ok(1))]);
    expect(report.offered).toBe(1);
    expect(report.windowSeconds).toBe(60);
  });

  it('gives every entry exactly one category, and offered = sent + missed + skipped', () => {
    const results = [
      at(6_000, ok(10)),
      at(6_100, ok(20), 'order.create'),
      at(6_200, failStatus(500)),
      at(6_300, { kind: 'failed', latencyMs: REQUEST_TIMEOUT_MS, reason: 'timeout' }),
      at(6_400, { kind: 'failed', latencyMs: 3, reason: 'transport' }),
      at(6_500, { kind: 'missed' }),
      at(6_600, { kind: 'skipped' }, 'order.read'),
      at(6_700, { kind: 'skipped' }, 'order.read'),
    ];
    const r = buildReport(STEADY, results);
    expect(r).toMatchObject({
      offered: 8,
      sent: 5,
      successful: 2,
      failed: 3,
      missed: 1,
      skipped: 2,
    });
    expect(r.offered).toBe(r.sent + r.missed + r.skipped);
    expect(r.sent).toBe(r.successful + r.failed);
    expect(r.failures).toEqual({ status: 1, timeout: 1, transport: 1 });
    expect(r.failedStatuses).toEqual({ '500': 1 });
  });

  it('uses the defined denominators', () => {
    const results = [
      ...Array.from({ length: 90 }, (_, i) => at(10_000 + i, ok(5))),
      ...Array.from({ length: 2 }, (_, i) => at(20_000 + i, failStatus(409))),
      ...Array.from({ length: 5 }, (_, i) => at(30_000 + i, { kind: 'missed' })),
      ...Array.from({ length: 3 }, (_, i) => at(40_000 + i, { kind: 'skipped' })),
    ];
    const r = buildReport(STEADY, results);
    expect(r.throughputRps).toBe(90 / 60); // successful ÷ 60 s
    expect(r.failureRate).toBe(2 / 92); // failed ÷ sent
    expect(r.missRate).toBe(5 / 100); // missed ÷ offered
    expect(r.skipRate).toBe(3 / 100); // skipped ÷ offered
  });

  it('includes timeouts in latency at 5,000 ms, and excludes missed and skipped entries', () => {
    const results = [
      ...Array.from({ length: 19 }, (_, i) => at(10_000 + i, ok(10))),
      at(11_000, { kind: 'failed', latencyMs: REQUEST_TIMEOUT_MS, reason: 'timeout' }),
      at(12_000, { kind: 'missed' }),
      at(13_000, { kind: 'skipped' }),
    ];
    const r = buildReport(STEADY, results);
    expect(REQUEST_TIMEOUT_MS).toBe(5000);
    expect(r.latencyMs).toEqual({ p50: 10, p95: 10, p99: 5000 });
  });

  it('reports counts and latency per operation', () => {
    const r = buildReport(STEADY, [
      at(6_000, ok(10), 'product.list'),
      at(6_001, ok(30, 201), 'order.create'),
      at(6_002, failStatus(404), 'order.read'),
      at(6_003, { kind: 'skipped' }, 'order.read'),
    ]);
    expect(r.byOperation['order.create']).toMatchObject({ offered: 1, successful: 1 });
    expect(r.byOperation['order.read']).toMatchObject({
      offered: 2,
      sent: 1,
      failed: 1,
      skipped: 1,
    });
    expect(r.byOperation['product.list'].latencyMs.p95).toBe(10);
  });

  it('has a zero failure rate and null latencies when nothing was sent', () => {
    const r = buildReport(STEADY, [at(6_000, { kind: 'missed' })]);
    expect(r.failureRate).toBe(0);
    expect(r.latencyMs).toEqual({ p50: null, p95: null, p99: null });
    expect(buildReport(STEADY, []).missRate).toBe(0);
  });
});

describe('nearest-rank percentiles', () => {
  it('returns the value at rank ceil(p/100 * n)', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(nearestRank(values, 50)).toBe(50);
    expect(nearestRank(values, 95)).toBe(95);
    expect(nearestRank(values, 99)).toBe(99);
    expect(nearestRank([7], 95)).toBe(7);
    expect(nearestRank([1, 2, 3], 50)).toBe(2);
    expect(nearestRank([1, 2, 3], 0)).toBe(1);
    expect(nearestRank([], 95)).toBeNull();
  });
});

describe('pass verdict', () => {
  const report = (successful: number, p95Latency: number, failed: number) =>
    buildReport(STEADY, [
      ...Array.from({ length: successful }, (_, i) => at(5_000 + i, ok(p95Latency))),
      ...Array.from({ length: failed }, (_, i) => at(5_000 + i, failStatus(500, p95Latency))),
    ]);

  it('passes at 50 rps, p95 under 200 ms and failures under 1%', () => {
    expect(STEADY_THRESHOLDS).toEqual({
      minThroughputRps: 50,
      maxP95Ms: 200,
      maxFailureRate: 0.01,
    });
    expect(evaluate(report(3000, 199, 0)).passed).toBe(true);
  });

  it('fails on each threshold separately', () => {
    expect(evaluate(report(2999, 10, 0)).checks.map((c) => c.passed)).toEqual([false, true, true]);
    expect(evaluate(report(3000, 200, 0)).checks.map((c) => c.passed)).toEqual([true, false, true]);
    // 31 failed of 3031 sent is 1.02%.
    expect(evaluate(report(3000, 10, 31)).checks.map((c) => c.passed)).toEqual([true, true, false]);
    expect(evaluate(buildReport(STEADY, [])).passed).toBe(false);
  });
});
