import type { Pool } from '@commerce/db';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './health.js';

export interface ServerDeps {
  pool: Pool;
  logger: FastifyBaseLogger;
}

/** Builds the orders API without starting it, so tests can use `inject`. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger });
  registerHealthRoutes(app, { pool: deps.pool });
  return app;
}
