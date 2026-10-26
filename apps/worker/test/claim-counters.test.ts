import { METRIC } from '@commerce/telemetry';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestPool } from '../../../packages/db/test/support.js';
import {
  createTestMeter,
  pointsOf,
  valueAt,
  type TestMeter,
} from '../../../packages/telemetry/test/metric-support.js';
import { startWorkerMetrics } from '../src/worker-metrics.js';

/** The worker's startup path zero-initializes the four claim-counter series (M5 poison-order fix). */
const pool = createTestPool();
let tm: TestMeter;
afterEach(async () => {
  await tm.shutdown();
});
afterAll(async () => {
  await pool.end();
});

describe('worker startup claim counters', () => {
  it('startWorkerMetrics exports all four claim series at 0 before any claim, and counts on them', async () => {
    tm = createTestMeter();
    const telemetry = startWorkerMetrics({
      enabled: false,
      sampleIntervalMs: 1000,
      databaseUrl: 'postgres://unused',
      logger: { debug: () => undefined },
      workerPool: pool,
      simulatorPool: pool,
      inflight: () => 0,
      meter: tm.meter,
    });
    try {
      const before = await tm.collect();
      expect(
        pointsOf(before, METRIC.claimsRecovered)
          .map((p) => [p.attributes['order.status'], p.value])
          .sort(),
      ).toEqual([
        ['payment_unknown', 0],
        ['pending', 0],
      ]);
      expect(
        pointsOf(before, METRIC.claimsReleased)
          .map((p) => [p.attributes['release.result'], p.value])
          .sort(),
      ).toEqual([
        ['released', 0],
        ['unconfirmed', 0],
      ]);
      telemetry.metrics.claimsRecovered('pending', 1);
      const after = await tm.collect();
      expect(valueAt(after, METRIC.claimsRecovered, { 'order.status': 'pending' })).toBe(1);
      expect(pointsOf(after, METRIC.claimsRecovered)).toHaveLength(2);
    } finally {
      telemetry.stopSampler();
      await telemetry.closeMetricsPool();
    }
  });
});
