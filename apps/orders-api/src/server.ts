import type { Pool } from '@commerce/db';
import { nameServerSpan } from '@commerce/telemetry';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerErrorHandler } from './errors.js';
import { registerHealthRoutes } from './health.js';
import { registerCommerceRoutes } from './routes.js';

export interface ServerDeps {
  pool: Pool;
  logger: FastifyBaseLogger;
}

/** Builds the orders API without starting it, so tests can use `inject`. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger });
  // With telemetry on, the HTTP server span is named after the route template, never the raw URL.
  app.addHook('onRequest', (request, _reply, done) => {
    nameServerSpan(request.method, request.routeOptions.url);
    done();
  });
  registerErrorHandler(app);
  registerHealthRoutes(app, { pool: deps.pool });
  registerCommerceRoutes(app, { pool: deps.pool });
  return app;
}
