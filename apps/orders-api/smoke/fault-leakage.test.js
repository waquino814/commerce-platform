// M5a criterion A9 under the production preload: scenario control traffic creates no spans,
// incoming or outgoing, while ordinary traffic still does. Run by `pnpm test:smoke`:
//   node --import ./packages/telemetry/smoke/memory-exporter.js \
//        --import ./apps/orders-api/dist/telemetry.js apps/orders-api/smoke/fault-leakage.test.js
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createPool } from '@commerce/db';
import { getActiveTelemetry } from '@commerce/telemetry';
import { pino } from 'pino';
import { createApiFaults } from '../dist/faults.js';
import { buildServer } from '../dist/server.js';

const exporter = globalThis[Symbol.for('commerce.telemetry.testSpanExporter')];
const url = process.env.TEST_DATABASE_URL;
assert.ok(url, 'TEST_DATABASE_URL must be set');
const pool = createPool({ connectionString: url, max: 2 }, () => undefined);

// A stand-in worker on a plain node:http server, so it is instrumented like a real one.
const worker = http.createServer((req, res) => {
  const status = req.url?.endsWith('/start') ? 202 : 200;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ processes: { worker: { active: null } } }));
});
let app;
let base;

before(async () => {
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve));
  const faults = createApiFaults({
    pool,
    workerAdminUrl: `http://127.0.0.1:${worker.address().port}`,
  });
  app = buildServer({ pool, logger: pino({ level: 'silent' }), faults });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app.close();
  await new Promise((resolve) => worker.close(resolve));
  await pool.end();
  await getActiveTelemetry().shutdown();
});

test('admin traffic creates no span on the API, on the worker, or for the forwarding call', async () => {
  assert.equal(getActiveTelemetry().enabled, true);
  exporter.reset();
  const start = await fetch(`${base}/admin/scenarios/bad-deploy-order-reads/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed: 42, durationMs: 60000 }),
  });
  assert.equal(start.status, 202);
  assert.equal((await fetch(`${base}/admin/scenarios/active`)).status, 200);
  assert.equal((await fetch(`${base}/admin/scenarios/stop`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${base}/admin/scenarios`)).status, 200);
  await getActiveTelemetry().forceFlush();
  const spans = exporter.getFinishedSpans();
  const text = JSON.stringify(spans.map((s) => [s.name, s.attributes]));
  assert.equal(spans.length, 0, `admin traffic produced spans: ${text}`);

  // Control: an ordinary request is traced, so the exporter is working.
  assert.equal((await fetch(`${base}/products?limit=1`)).status, 200);
  await getActiveTelemetry().forceFlush();
  assert.ok(exporter.getFinishedSpans().some((s) => s.name === 'GET /products'));
});
