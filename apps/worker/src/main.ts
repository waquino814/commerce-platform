import { setTimeout as sleep } from 'node:timers/promises';
import { claimDueOrders, ConfigError, createPool, recoverExpiredClaims } from '@commerce/db';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { buildHealthServer } from './health-server.js';
import { runWorkerLoop } from './loop.js';
import { PassRegistry } from './pass-context.js';
import { createPaymentSimulator } from './payment/simulator.js';
import { createProcessor } from './processor.js';
import { createClaimReleaser, DRAIN_DEADLINE_MS, shutdownWorker } from './shutdown.js';

/** M1 hard deadline. The protocol finishes well before it: drain 7 s plus a 500 ms release. */
const HARD_SHUTDOWN_DEADLINE_MS = 8000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino({
    level: config.logLevel,
    base: { service: 'worker', workerId: config.workerId },
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
      recover: () =>
        recoverExpiredClaims(pool, {
          ...policy,
          claimTimeoutMs: config.claimTimeoutMs,
          retryBaseMs: config.limits.retryBaseDelayMs,
          retryMaxMs: config.limits.retryMaxDelayMs,
        }).then((recovered) => {
          if (recovered.length > 0) logger.warn({ recovered }, 'expired claims recovered');
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
    setTimeout(() => {
      logger.error('hard shutdown deadline exceeded, forcing exit');
      process.exit(1);
    }, HARD_SHUTDOWN_DEADLINE_MS).unref();

    shutdownWorker({
      stopLoop: () => {
        controller.abort();
      },
      loopDone,
      registry,
      drainDeadline: sleep(DRAIN_DEADLINE_MS).then(() => undefined),
      release: createClaimReleaser(pool, policy, logger),
      logger,
    })
      .then(async (result) => {
        await health.close();
        await pool.end();
        // A provider call abandoned at the deadline may still hold a simulator connection.
        await Promise.race([simulatorPool.end(), sleep(300)]);
        logger.info({ exitCode: result.exitCode }, 'shutdown complete');
        process.exit(result.exitCode);
      })
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
