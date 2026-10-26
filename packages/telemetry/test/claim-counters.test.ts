import { afterEach, describe, expect, it } from 'vitest';
import { createWorkerMetrics, METRIC } from '../src/metrics.js';
import { createTestMeter, pointsOf, valueAt, type TestMeter } from './metric-support.js';

/**
 * Zero-initialized claim counters (docs/prompts/m3-design.md, "Metrics"): with the option, all
 * four series exist at 0 before any claim is recovered or released, so Prometheus's `increase()`
 * sees the first one. Without it, the counters still appear on first use.
 */
let tm: TestMeter;
afterEach(async () => {
  await tm.shutdown();
});

const sorted = (points: { attributes: Record<string, unknown>; value: unknown }[]) =>
  [...points].sort((a, b) =>
    JSON.stringify(a.attributes).localeCompare(JSON.stringify(b.attributes)),
  );

describe('claim counters with zeroClaimCounters', () => {
  it('export all four series at 0 before any claim is recovered or released', async () => {
    tm = createTestMeter();
    createWorkerMetrics(tm.meter, { zeroClaimCounters: true });
    const collected = await tm.collect();
    expect(sorted(pointsOf(collected, METRIC.claimsRecovered))).toEqual([
      { attributes: { 'order.status': 'payment_unknown' }, value: 0 },
      { attributes: { 'order.status': 'pending' }, value: 0 },
    ]);
    expect(sorted(pointsOf(collected, METRIC.claimsReleased))).toEqual([
      { attributes: { 'release.result': 'released' }, value: 0 },
      { attributes: { 'release.result': 'unconfirmed' }, value: 0 },
    ]);
  });

  it('count increments on the same series, with no extra series', async () => {
    tm = createTestMeter();
    const worker = createWorkerMetrics(tm.meter, { zeroClaimCounters: true });
    worker.claimsRecovered('pending', 1);
    worker.claimsRecovered('pending', 2);
    worker.claimsReleased('unconfirmed', 1);
    worker.claimsRecovered('payment_unknown', 0);
    const collected = await tm.collect();
    expect(valueAt(collected, METRIC.claimsRecovered, { 'order.status': 'pending' })).toBe(3);
    expect(valueAt(collected, METRIC.claimsRecovered, { 'order.status': 'payment_unknown' })).toBe(
      0,
    );
    expect(valueAt(collected, METRIC.claimsReleased, { 'release.result': 'unconfirmed' })).toBe(1);
    expect(valueAt(collected, METRIC.claimsReleased, { 'release.result': 'released' })).toBe(0);
    expect(pointsOf(collected, METRIC.claimsRecovered)).toHaveLength(2);
    expect(pointsOf(collected, METRIC.claimsReleased)).toHaveLength(2);
  });

  it('creating the recorders twice on one meter adds nothing and duplicates no series', async () => {
    tm = createTestMeter();
    createWorkerMetrics(tm.meter, { zeroClaimCounters: true });
    createWorkerMetrics(tm.meter, { zeroClaimCounters: true }).claimsRecovered('pending', 1);
    const collected = await tm.collect();
    expect(pointsOf(collected, METRIC.claimsRecovered)).toHaveLength(2);
    expect(valueAt(collected, METRIC.claimsRecovered, { 'order.status': 'pending' })).toBe(1);
  });

  it('without the option the counters still appear on first use', async () => {
    tm = createTestMeter();
    createWorkerMetrics(tm.meter);
    const collected = await tm.collect();
    expect(pointsOf(collected, METRIC.claimsRecovered)).toEqual([]);
    expect(pointsOf(collected, METRIC.claimsReleased)).toEqual([]);
  });
});
