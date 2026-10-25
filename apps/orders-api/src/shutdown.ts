import type { Pool } from '@commerce/db';
import type { FaultController } from '@commerce/faults';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

/**
 * The orders API's shutdown cleanup. Faults stop first, releasing any connection a scenario holds,
 * so `pool.end()` never waits on one (docs/prompts/m5-design.md, "Shutdown"). The exit code and
 * the 8 s deadline stay with `completeShutdown` in main.ts.
 */
export function createApiCleanup(deps: {
  faults: FaultController;
  app: FastifyInstance;
  pool: Pool;
  logger: FastifyBaseLogger;
}): () => Promise<void> {
  return async () => {
    deps.faults.shutdown();
    await deps.app.close();
    await deps.pool.end();
    deps.logger.info('shutdown complete');
  };
}
