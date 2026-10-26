import { setTimeout as sleep } from 'node:timers/promises';
import { countOrdersByStatus, createPool, type Pool, type PoolConfig } from '@commerce/db';
import {
  createWorkerMetrics,
  observeInflight,
  observeOrderStatuses,
  observePools,
  type PoolName,
  type WorkerMetrics,
} from '@commerce/telemetry';
import type { Meter } from '@opentelemetry/api';
import { createOrderStatusSampler, type OrderStatusSampler } from './order-status-sampler.js';

/** The metrics pool's close is capped so it can never delay exit. */
export const METRICS_POOL_CLOSE_CAP_MS = 100;

/** The dedicated metrics pool: one connection, 1 s to connect, 1 s per statement. */
export const METRICS_POOL_SETTINGS = Object.freeze({
  max: 1,
  connectionTimeoutMillis: 1000,
  statementTimeoutMillis: 1000,
});

export interface WorkerMetricsDeps {
  /** Whether telemetry is enabled. When false, no metrics pool or sampler is created. */
  enabled: boolean;
  sampleIntervalMs: number;
  databaseUrl: string;
  logger: { debug(obj: object, msg: string): void };
  workerPool: Pool;
  simulatorPool: Pool;
  /** Passes in flight, for `commerce.worker.inflight`. */
  inflight: () => number;
  /** Test seams. Production uses the global meter and the real pool factory. */
  meter?: Meter;
  createPool?: (config: PoolConfig, onError: (err: Error) => void) => Pool;
}

export interface WorkerTelemetry {
  metrics: WorkerMetrics;
  /** Stops the order-status sampler. Called at SIGTERM. */
  stopSampler(): void;
  /** Ends the metrics pool within METRICS_POOL_CLOSE_CAP_MS. Never rejects. */
  closeMetricsPool(): Promise<void>;
}

/**
 * The worker's M3c metrics (docs/prompts/m3-design.md, "Metrics" and "Order-status sampler and
 * the metrics pool"): the pass, payment and claim recorders, connection metrics for every pool,
 * the in-flight gauge, and, with telemetry on, the dedicated metrics pool and order-status
 * sampler. With telemetry off the meter is a no-op and no pool or sampler exists.
 */
export function startWorkerMetrics(deps: WorkerMetricsDeps): WorkerTelemetry {
  // The claim counters start at 0, so a first recovery is an increase Prometheus can see.
  const metrics = createWorkerMetrics(deps.meter, { zeroClaimCounters: true });
  let metricsPool: Pool | null = null;
  let sampler: OrderStatusSampler | null = null;

  if (deps.enabled) {
    const ownPool = (deps.createPool ?? createPool)(
      { connectionString: deps.databaseUrl, ...METRICS_POOL_SETTINGS },
      (err) => {
        deps.logger.debug({ err: err.message }, 'metrics pool client error');
      },
    );
    const ownSampler = createOrderStatusSampler({
      query: () => countOrdersByStatus(ownPool),
      intervalMs: deps.sampleIntervalMs,
      logger: deps.logger,
    });
    observeOrderStatuses(() => ownSampler.read(), deps.meter);
    ownSampler.start();
    metricsPool = ownPool;
    sampler = ownSampler;
  }

  const pools: { name: PoolName; pool: Pool }[] = [
    { name: 'worker', pool: deps.workerPool },
    { name: 'simulator', pool: deps.simulatorPool },
  ];
  if (metricsPool) pools.push({ name: 'metrics', pool: metricsPool });
  observePools(pools, deps.meter);
  observeInflight(deps.inflight, deps.meter);

  return {
    metrics,
    stopSampler() {
      sampler?.stop();
    },
    async closeMetricsPool() {
      if (!metricsPool) return;
      // Telemetry-only: a failed or slow close is ignored and never changes the exit code.
      await Promise.race([
        metricsPool.end().catch(() => undefined),
        sleep(METRICS_POOL_CLOSE_CAP_MS, undefined, { ref: false }),
      ]);
    },
  };
}
