import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';

/** Every error response has this shape, with a stable machine-readable `error` code. */
export interface ApiError {
  error: string;
  message: string;
  details?: unknown[];
}

export function sendError(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
  details?: unknown[],
): FastifyReply {
  const body: ApiError = details === undefined ? { error, message } : { error, message, details };
  return reply.code(status).send(body);
}

export function sendValidationError(reply: FastifyReply, zodError: z.ZodError): FastifyReply {
  return sendError(
    reply,
    400,
    'validation_error',
    'request validation failed',
    zodError.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

/** Maps framework errors, such as malformed JSON, onto the shared error shape. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return sendError(reply, 500, 'internal_error', 'internal server error');
    }
    const code = status === 400 ? 'validation_error' : (err.code || 'bad_request').toLowerCase();
    return sendError(reply, status, code, err.message);
  });
  app.setNotFoundHandler((request, reply) =>
    sendError(reply, 404, 'not_found', `route ${request.method} ${request.url} not found`),
  );
}
