import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BUNDLE_ID } from '@commerce/incident-bundle';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { WebConfig } from './config.js';
import { checkHealth, type HealthDeps } from './health.js';
import { listIncidents, readIncident, SERVABLE_FILES } from './incidents.js';
import { readTelemetry } from './telemetry.js';

/**
 * The incident dashboard's server (M7): a read-only JSON API over the local incident bundles and
 * the stack's readiness endpoints, plus the built React client. GET only: it never starts a
 * scenario, changes fault state or writes anything. Errors use the `{ error, message }` shape.
 */
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const FILE_TYPES: Record<string, string> = {
  'manifest.json': 'application/json; charset=utf-8',
  'ground_truth.json': 'application/json; charset=utf-8',
  'traces.jsonl': 'application/x-ndjson; charset=utf-8',
  'metrics.jsonl': 'application/x-ndjson; charset=utf-8',
  'logs.jsonl': 'application/x-ndjson; charset=utf-8',
};

const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
/** Built asset names, as Vite emits them: no separators, so no path can escape the directory. */
const ASSET_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css|svg|png|woff2)$/;

export interface WebServerDeps {
  config: WebConfig;
  logger: FastifyBaseLogger;
  /** The built client (`vite build` output). When it is missing, the API still works. */
  clientDir: string;
  health?: Partial<HealthDeps>;
}

export function buildWebServer(deps: WebServerDeps): FastifyInstance {
  const { config, clientDir } = deps;
  const healthDeps: HealthDeps = {
    fetch: (url, init) => fetch(url, init),
    now: () => performance.now(),
    wallClock: () => new Date(),
    ...deps.health,
  };
  const app = Fastify({ loggerInstance: deps.logger });

  app.addHook('onSend', async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'dashboard request failed');
    return reply
      .code(500)
      .send({ error: 'internal_error', message: 'The incident evidence could not be read.' });
  });

  app.get('/api/incidents', async () => listIncidents(config.incidentsDir));

  app.get<{ Params: { id: string } }>('/api/incidents/:id', async (req, reply) => {
    const detail = await readIncident(config.incidentsDir, req.params.id);
    if (!detail)
      return reply
        .code(404)
        .send({ error: 'incident_not_found', message: `no incident bundle ${req.params.id}` });
    return { ...detail, jaegerUrl: config.jaegerUrl };
  });

  app.get<{ Params: { id: string } }>('/api/incidents/:id/telemetry', async (req, reply) => {
    const telemetry = await readTelemetry(config.incidentsDir, req.params.id);
    if (!telemetry)
      return reply
        .code(404)
        .send({ error: 'incident_not_found', message: `no incident bundle ${req.params.id}` });
    return telemetry;
  });

  app.get<{ Params: { id: string; file: string } }>(
    '/api/incidents/:id/files/:file',
    async (req, reply) => {
      const { id, file } = req.params;
      // Only a valid bundle ID and one of the bundle's known file names: no other path is reachable.
      if (!BUNDLE_ID.test(id) || !SERVABLE_FILES.includes(file)) {
        return reply.code(404).send({ error: 'file_not_found', message: 'no such evidence file' });
      }
      const path = join(config.incidentsDir, id, file);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile())
        return reply.code(404).send({ error: 'file_not_found', message: 'no such evidence file' });
      return reply
        .type(FILE_TYPES[file] ?? 'application/octet-stream')
        .header('content-length', info.size)
        .header('content-disposition', `inline; filename="${file}"`)
        .send(createReadStream(path));
    },
  );

  app.get('/api/health', async () => checkHealth(config, healthDeps));

  app.get<{ Params: { file: string } }>('/assets/:file', async (req, reply) => {
    const { file } = req.params;
    const ext = file.slice(file.lastIndexOf('.'));
    const path = join(clientDir, 'assets', file);
    const info = ASSET_NAME.test(file) ? await stat(path).catch(() => null) : null;
    if (!info?.isFile())
      return reply.code(404).send({ error: 'not_found', message: 'no such asset' });
    return reply
      .type(ASSET_TYPES[ext] ?? 'application/octet-stream')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(path));
  });

  // Every other GET outside /api is a client route: serve the single-page app.
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) {
      return reply
        .code(404)
        .send({ error: 'not_found', message: `route ${req.method} ${req.url} not found` });
    }
    const html = await readFile(join(clientDir, 'index.html'), 'utf8').catch(() => null);
    if (html === null) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send(
          'The dashboard client is not built. Run `pnpm build` (or `pnpm web:build`), then reload.',
        );
    }
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);
  });

  return app;
}
