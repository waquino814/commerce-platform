import { setTimeout as sleep } from 'node:timers/promises';
import { claimDueOrders, ConfigError, createPool } from '@commerce/db';
import { completeShutdown, getActiveTelemetry, traceLogMixin } from '@commerce/telemetry';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { buildHealthServer } from './health-server.js';
import { runWorkerLoop } from './loop.js';
import { PassRegistry } from './pass-context.js';
import { createClaimRecoverer } from './recovery.js';
import { createPaymentSimulator } from './payment/simulator.js';
import { createProcessor } from './processor.js';
import { createClaimReleaser, DRAIN_DEADLINE_MS, shutdownWorker } from './shutdown.js';
import { startWorkerMetrics } from './worker-metrics.js';

/** M1 hard deadline. The protocol finishes well before it: drain 7 s plus a 500 ms release. */
const HARD_SHUTDOWN_DEADLINE_MS = 8000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino({
    level: config.logLevel,
    base: { service: 'worker', workerId: config.workerId },
    mixin: traceLogMixin,
  });
  logger.info(
    { processingBudgetMs: config.processingBudgetMs, claimTimeoutMs: config.claimTimeoutMs },
    'processing budget',
  );

  const onIdleError = (err: Error): void => {
    logger.warn({ err }, 'idle database client error');
  };
  // One connection per slot, one for claiming, recovery and release, one for readiness.
  const pool = createPool(
    {
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: config.dbConnectTimeoutMs,
      statementTimeoutMillis: config.dbStatementTimeoutMs,
      max: config.concurrency + 2,
    },
    onIdleError,
  );
  // The simulator stands in for an external provider, so it has its own pool.
  const simulatorPool = createPool(
    {
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: config.paymentTimeoutMs,
      statementTimeoutMillis: config.paymentTimeoutMs,
      max: 2 * config.concurrency,
    },
    onIdleError,
  );

  const registry = new PassRegistry();
  // M3c metrics. With telemetry off the meter is a no-op, and the metrics pool and order-status
  // sampler are not created at all.
  const telemetry = getActiveTelemetry();
  const workerTelemetry = startWorkerMetrics({
    enabled: telemetry.enabled,
    sampleIntervalMs: telemetry.metricsSampleIntervalMs,
    databaseUrl: config.databaseUrl,
    logger,
    workerPool: pool,
    simulatorPool,
    inflight: () => registry.size,
  });
  const { metrics } = workerTelemetry;
  const provider = createPaymentSimulator({
    pool: simulatorPool,
    logger,
    latencyMs: config.paymentLatencyMs,
  });
  const processor = createProcessor({
    pool,
    provider,
    logger,
    limits: config.limits,
    paymentTimeoutMs: config.paymentTimeoutMs,
    registry,
    metrics,
  });
  const policy = {
    maxReconciliationAttempts: config.limits.maxReconciliationAttempts,
    paymentUnknownRecheckMs: config.limits.paymentUnknownRecheckMs,
  };

  const health = buildHealthServer({ pool, logger });
  const controller = new AbortController();
  const loopDone = runWorkerLoop(
    {
      claim: (limit) => claimDueOrders(pool, { workerId: config.workerId, limit }),
      recover: createClaimRecoverer({
        pool,
        logger,
        metrics,
        params: {
          ...policy,
          claimTimeoutMs: config.claimTimeoutMs,
          retryBaseMs: config.limits.retryBaseDelayMs,
          retryMaxMs: config.limits.retryMaxDelayMs,
        },
      }),
      process: (order) => processor.process(order),
      concurrency: config.concurrency,
      claimBatchSize: config.claimBatchSize,
      pollIntervalMs: config.pollIntervalMs,
      logger,
    },
    controller.signal,
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown started');
    const deadlineAt = Date.now() + HARD_SHUTDOWN_DEADLINE_MS;
    setTimeout(() => {
      logger.error('hard shutdown deadline exceeded, forcing exit');
      process.exit(1);
    }, HARD_SHUTDOWN_DEADLINE_MS).unref();
    workerTelemetry.stopSampler();

    shutdownWorker({
      stopLoop: () => {
        controller.abort();
      },
      loopDone,
      registry,
      drainDeadline: sleep(DRAIN_DEADLINE_MS).then(() => undefined),
      release: createClaimReleaser(
        pool,
        policy,
        logger,
        (orderId) => registry.get(orderId)?.order.traceContext ?? null,
        metrics,
      ),
      logger,
    })
      .then((result) =>
        // M2's protocol has decided the exit code. Telemetry only adds a bounded flush after
        // cleanup and can never change that code (docs/prompts/m3-design.md, "Shutdown").
        completeShutdown({
          exitCode: result.exitCode,
          cleanup: async () => {
            await health.close();
            await pool.end();
            // A provider call abandoned at the deadline may still hold a simulator connection.
            await Promise.race([simulatorPool.end(), sleep(300)]);
            await workerTelemetry.closeMetricsPool();
            logger.info({ exitCode: result.exitCode }, 'shutdown complete');
          },
          telemetry,
          deadlineAt,
          exit: (code) => process.exit(code),
          onCleanupError: (err) => {
            logger.error({ err }, 'shutdown failed');
          },
          onFlush: (flushResult, budgetMs) => {
            logger.debug({ result: flushResult, budgetMs }, 'telemetry flush');
          },
        }),
      )
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await health.listen({ host: '0.0.0.0', port: config.healthPort });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`worker: ${err.message}`);
  } else {
    console.error('worker: fatal startup error', err);
  }
  process.exit(1);
});
