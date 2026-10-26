// CLI entry: `pnpm web`. The logic, and its tests, live in server.ts, incidents.ts, telemetry.ts
// and health.ts.
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { HOST, loadWebConfig, WebConfigError } from './config.js';
import { buildWebServer } from './server.js';

let config;
try {
  config = loadWebConfig(process.env);
} catch (err) {
  process.stderr.write(`${err instanceof WebConfigError ? err.message : String(err)}\n`);
  process.exit(1);
}
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
// dist/main.js serves the client that `vite build` writes to dist/client.
const clientDir = fileURLToPath(new URL('./client/', import.meta.url));
const app = buildWebServer({ config, logger, clientDir });
await app.listen({ host: HOST, port: config.port });
logger.info(
  { url: `http://${HOST}:${String(config.port)}`, incidentsDir: config.incidentsDir },
  'incident dashboard ready',
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
