import { ConfigError, createPool } from '@commerce/db';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { buildHealthServer } from './health-server.js';
import { runWorkerLoop } from './loop.js';

const SHUTDOWN_DEADLINE_MS = 8000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino({
    level: config.logLevel,
    base: { service: 'worker', workerId: config.workerId },
  });
  const pool = createPool({ connectionString: config.databaseUrl }, (err) => {
    logger.warn({ err }, 'idle database client error');
  });
  const health = buildHealthServer({ pool, logger });
  const controller = new AbortController();

  const loop = runWorkerLoop(
    {
      pool,
      logger,
      workerId: config.workerId,
      pollIntervalMs: config.pollIntervalMs,
      claimBatchSize: config.claimBatchSize,
    },
    controller.signal,
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown started');
    setTimeout(() => {
      logger.error('shutdown deadline exceeded, forcing exit');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
    controller.abort();
    loop
      .then(() => health.close())
      .then(() => pool.end())
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
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
