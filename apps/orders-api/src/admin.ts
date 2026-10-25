import type { ScenarioControl } from '@commerce/faults';
import type { FastifyInstance, LogLevel } from 'fastify';
import { sendError } from './errors.js';

/**
 * M5 scenario control routes under `/admin`, at the probe log level so nothing is logged at
 * `info`. Without `control` (faults disabled) no route exists: only a scoped 404 handler, which
 * returns the API's standard 404 at the same log level.
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { control: ScenarioControl | null; logLevel: LogLevel },
): void {
  const { control } = deps;
  void app.register(
    (admin, _opts, done) => {
      admin.setNotFoundHandler((request, reply) =>
        sendError(reply, 404, 'not_found', `route ${request.method} ${request.url} not found`),
      );
      if (control) {
        admin.get('/scenarios', (_request, reply) => {
          const res = control.list();
          return reply.code(res.status).send(res.body);
        });
        admin.get('/scenarios/active', async (_request, reply) => {
          const res = await control.report();
          return reply.code(res.status).send(res.body);
        });
        admin.post<{ Params: { name: string } }>(
          '/scenarios/:name/start',
          async (request, reply) => {
            const res = await control.start(request.params.name, request.body);
            return reply.code(res.status).send(res.body);
          },
        );
        admin.post('/scenarios/stop', async (_request, reply) => {
          const res = await control.stop();
          return reply.code(res.status).send(res.body);
        });
      }
      done();
    },
    { prefix: '/admin', logLevel: deps.logLevel },
  );
}
