import type { ScenarioControl } from '@commerce/faults';
import type { FastifyError, FastifyInstance, LogLevel } from 'fastify';

/**
 * M5 scenario control routes on the worker's health server, under `/admin`, at the probe log
 * level. Without `control` (faults disabled) no route exists, only a scoped 404 handler. Errors use
 * the `{ error, message }` shape, like the orders API.
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { control: ScenarioControl | null; logLevel: LogLevel },
): void {
  const { control } = deps;
  void app.register(
    (admin, _opts, done) => {
      admin.setNotFoundHandler((request, reply) =>
        reply.code(404).send({
          error: 'not_found',
          message: `route ${request.method} ${request.url} not found`,
        }),
      );
      admin.setErrorHandler((err: FastifyError, _request, reply) => {
        const status = err.statusCode ?? 500;
        if (status >= 500) {
          return reply
            .code(500)
            .send({ error: 'internal_error', message: 'internal server error' });
        }
        return reply.code(status).send({ error: 'validation_error', message: err.message });
      });
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
