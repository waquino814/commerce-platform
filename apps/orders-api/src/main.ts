import { ConfigError, createPool } from '@commerce/db';
import { completeShutdown, getActiveTelemetry, traceLogMixin } from '@commerce/telemetry';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const SHUTDOWN_DEADLINE_MS = 8000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino({
    level: config.logLevel,
    base: { service: 'orders-api' },
    mixin: traceLogMixin,
  });
  const pool = createPool({ connectionString: config.databaseUrl }, (err) => {
    logger.warn({ err }, 'idle database client error');
  });
  const app = buildServer({ pool, logger });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown started');
    const deadlineAt = Date.now() + SHUTDOWN_DEADLINE_MS;
    setTimeout(() => {
      logger.error('shutdown deadline exceeded, forcing exit');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
    void completeShutdown({
      exitCode: 0,
      cleanup: async () => {
        await app.close();
        await pool.end();
        logger.info('shutdown complete');
      },
      telemetry: getActiveTelemetry(),
      deadlineAt,
      exit: (code) => process.exit(code),
      onCleanupError: (err) => {
        logger.error({ err }, 'shutdown failed');
      },
      onFlush: (result, budgetMs) => {
        logger.debug({ result, budgetMs }, 'telemetry flush');
      },
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host: '0.0.0.0', port: config.port });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`orders-api: ${err.message}`);
  } else {
    console.error('orders-api: fatal startup error', err);
  }
  process.exit(1);
});
