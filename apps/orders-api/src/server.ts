import type { Pool } from '@commerce/db';
import {
  createApiMetrics,
  isProbePath,
  nameServerSpan,
  type ApiMetrics,
} from '@commerce/telemetry';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerErrorHandler } from './errors.js';
import { registerHealthRoutes } from './health.js';
import { registerCommerceRoutes } from './routes.js';

export interface ServerDeps {
  pool: Pool;
  logger: FastifyBaseLogger;
  /** M3c request metrics. Defaults to the global meter, a no-op when telemetry is off. */
  metrics?: ApiMetrics;
}

/** Builds the orders API without starting it, so tests can use `inject`. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger });
  // With telemetry on, the HTTP server span is named after the route template, never the raw URL.
  app.addHook('onRequest', (request, _reply, done) => {
    nameServerSpan(request.method, request.routeOptions.url);
    done();
  });
  // M3c: request duration by method, route template and status. Probes are never counted, and an
  // unmatched route has no route template, so it gets no http.route label: raw URLs never become
  // labels. Recording is synchronous and cannot change the response.
  const metrics = deps.metrics ?? createApiMetrics();
  app.addHook('onResponse', (request, reply, done) => {
    if (!isProbePath(request.url)) {
      metrics.recordRequest({
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        durationS: reply.elapsedTime / 1000,
      });
    }
    done();
  });
  registerErrorHandler(app);
  registerHealthRoutes(app, { pool: deps.pool });
  registerCommerceRoutes(app, { pool: deps.pool });
  return app;
}
