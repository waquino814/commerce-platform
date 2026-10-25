import { ConfigError, createPool } from '@commerce/db';
import { DISABLED_FAULTS } from '@commerce/faults';
import {
  completeShutdown,
  getActiveTelemetry,
  observePools,
  traceLogMixin,
} from '@commerce/telemetry';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createApiFaults } from './faults.js';
import { loadFaultsConfig } from './faults-config.js';
import { buildServer } from './server.js';
import { createApiCleanup } from './shutdown.js';

const SHUTDOWN_DEADLINE_MS = 8000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const faultsConfig = loadFaultsConfig(process.env);
  const logger = pino({
    level: config.logLevel,
    base: { service: 'orders-api' },
    mixin: traceLogMixin,
  });
  const pool = createPool({ connectionString: config.databaseUrl }, (err) => {
    logger.warn({ err }, 'idle database client error');
  });
  // M3c: connection metrics for the API's only pool. A no-op when telemetry is off.
  observePools([{ name: 'orders-api', pool }]);
  // M5: fault injection exists only with FAULTS_ENABLED=true, and never starts a scenario itself.
  const faults = faultsConfig.enabled
    ? createApiFaults({ pool, workerAdminUrl: faultsConfig.workerAdminUrl })
    : null;
  const app = buildServer({ pool, logger, ...(faults ? { faults } : {}) });

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
      cleanup: createApiCleanup({
        faults: faults?.controller ?? DISABLED_FAULTS,
        app,
        pool,
        logger,
      }),
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
