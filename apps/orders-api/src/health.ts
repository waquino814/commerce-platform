import { pingDatabase, type Pool } from '@commerce/db';
import type { FastifyInstance, LogLevel } from 'fastify';

export const READINESS_TIMEOUT_MS = 1000;

const LEVEL_ORDER = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

/** Health probes run every few seconds, so they log at `warn` unless the app is stricter. */
export function probeLogLevel(appLevel: string): LogLevel {
  return (
    LEVEL_ORDER.indexOf(appLevel) > LEVEL_ORDER.indexOf('warn') ? appLevel : 'warn'
  ) as LogLevel;
}

/**
 * `/healthz` is liveness: it never touches dependencies.
 * `/readyz` is readiness: it succeeds only when the database answers within the timeout.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: { pool: Pool }): void {
  const logLevel = probeLogLevel(app.log.level);

  app.get('/healthz', { logLevel }, () => ({ status: 'ok' }));

  app.get('/readyz', { logLevel }, async (request, reply) => {
    const ready = await pingDatabase(deps.pool, READINESS_TIMEOUT_MS, (err) => {
      request.log.warn({ err }, 'readiness check failed: database unreachable');
    });
    if (!ready) return reply.code(503).send({ status: 'not_ready' });
    return { status: 'ready' };
  });
}
