import type { Pool } from '@commerce/db';
import type { ScenarioControl } from '@commerce/faults';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin.js';
import { probeLogLevel, registerHealthRoutes } from './health.js';

/**
 * Internal HTTP server exposing `/healthz` and `/readyz` for Compose health checks and, only when
 * `FAULTS_ENABLED=true`, the M5 scenario control routes under `/admin`.
 */
export function buildHealthServer(deps: {
  pool: Pool;
  logger: FastifyBaseLogger;
  faultControl?: ScenarioControl;
}): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger });
  registerHealthRoutes(app, { pool: deps.pool });
  registerAdminRoutes(app, {
    control: deps.faultControl ?? null,
    logLevel: probeLogLevel(app.log.level),
  });
  return app;
}
