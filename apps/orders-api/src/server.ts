import type { Pool } from '@commerce/db';
import { ORDER_READ_ERROR_MESSAGE, type ScenarioControl } from '@commerce/faults';
import {
  createApiMetrics,
  isProbePath,
  nameServerSpan,
  type ApiMetrics,
} from '@commerce/telemetry';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin.js';
import { registerErrorHandler } from './errors.js';
import { probeLogLevel, registerHealthRoutes } from './health.js';
import { registerCommerceRoutes } from './routes.js';

export interface ServerDeps {
  pool: Pool;
  logger: FastifyBaseLogger;
  /** M3c request metrics. Defaults to the global meter, a no-op when telemetry is off. */
  metrics?: ApiMetrics;
  /** M5 fault injection. Absent when `FAULTS_ENABLED` is not `true`: no hook and no route. */
  faults?: { control: ScenarioControl; orderReadFault: { shouldFail(): boolean } };
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
  // M5 `bad-deploy-order-reads`: only registered when faults are enabled, and a no-op unless that
  // scenario is active. The thrown error takes the API's normal error path to a 500.
  const orderReadFault = deps.faults?.orderReadFault;
  if (orderReadFault) {
    app.addHook('preHandler', (request, _reply, done) => {
      if (
        request.method === 'GET' &&
        request.routeOptions.url === '/orders/:id' &&
        orderReadFault.shouldFail()
      ) {
        done(new TypeError(ORDER_READ_ERROR_MESSAGE));
        return;
      }
      done();
    });
  }
  registerErrorHandler(app);
  registerHealthRoutes(app, { pool: deps.pool });
  registerAdminRoutes(app, {
    control: deps.faults?.control ?? null,
    logLevel: probeLogLevel(app.log.level),
  });
  registerCommerceRoutes(app, { pool: deps.pool });
  return app;
}
