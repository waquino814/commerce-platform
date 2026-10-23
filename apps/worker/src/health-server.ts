import type { Pool } from '@commerce/db';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './health.js';

/** Internal HTTP server exposing only `/healthz` and `/readyz` for Compose health checks. */
export function buildHealthServer(deps: {
  pool: Pool;
  logger: FastifyBaseLogger;
}): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger });
  registerHealthRoutes(app, { pool: deps.pool });
  return app;
}
