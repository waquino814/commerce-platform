// Criteria 4 and 5: automatic http and pg instrumentation under the production preload. M3c adds
// criteria 4 and 13 for metrics: only the catalog records, never the auto-instrumentations.
// Run by `pnpm test:smoke`:
//   node --import ./packages/telemetry/smoke/memory-exporter.js \
//        --import ./apps/orders-api/dist/telemetry.js packages/telemetry/smoke/instrumentation.test.js
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool } from '@commerce/db';
import { getActiveTelemetry } from '@commerce/telemetry';
import { trace } from '@opentelemetry/api';
import { pino } from 'pino';
import { buildServer } from '../../../apps/orders-api/dist/server.js';

const exporter = globalThis[Symbol.for('commerce.telemetry.testSpanExporter')];
const reader = globalThis[Symbol.for('commerce.telemetry.testMetricReader')];
const url = process.env.TEST_DATABASE_URL;
assert.ok(url, 'TEST_DATABASE_URL must be set');
const pool = createPool({ connectionString: url, max: 2 }, () => undefined);
const app = buildServer({ pool, logger: pino({ level: 'silent' }) });
let base;

before(async () => {
  await pool.query('TRUNCATE payment_charges, order_items, orders, products');
  await pool.query(
    "INSERT INTO products (sku, name, price_cents, stock_available) VALUES ('SKU-00001', 'Smoke', 1234, 10)",
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app.close();
  await pool.end();
  await getActiveTelemetry().shutdown();
});

const isDb = (s) => s.attributes['db.system.name'] === 'postgresql';
const queryText = (s) => String(s.attributes['db.query.text'] ?? '');

test('production preload instruments http and pg with the agreed rules', async () => {
  assert.equal(getActiveTelemetry().enabled, true);
  exporter.reset();

  await pool.query("SELECT 'outside' AS outside_any_span");
  const created = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [{ sku: 'SKU-00001', quantity: 2 }],
      paymentMethod: 'pm_card_ok',
    }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await fetch(`${base}/orders/${id}`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  await trace.getTracer('smoke').startActiveSpan('order.process', async (span) => {
    await pool.query('SELECT 2 AS inside_pass');
    span.end();
  });
  await getActiveTelemetry().forceFlush();

  const spans = exporter.getFinishedSpans();
  const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
  const ancestors = (s) => {
    const names = [];
    for (
      let p = byId.get(s.parentSpanContext?.spanId);
      p;
      p = byId.get(p.parentSpanContext?.spanId)
    ) {
      names.push(p.name);
    }
    return names;
  };
  const server = (name) => spans.find((s) => s.name === name && s.kind === 1);
  const db = spans.filter(isDb);

  // Criterion 4 and route naming.
  const post = server('POST /orders');
  const get = server('GET /orders/:id');
  assert.ok(post, `server span POST /orders missing; got ${spans.map((s) => s.name).join(', ')}`);
  assert.equal(post.attributes['http.route'], '/orders');
  assert.ok(get);
  assert.equal(get.attributes['http.route'], '/orders/:id');
  assert.ok(
    !spans.some((s) => /healthz|readyz/.test(`${s.name} ${s.attributes['url.path'] ?? ''}`)),
    'probe spans',
  );
  assert.ok(!db.some((s) => queryText(s) === 'SELECT 1'), 'readiness ping must create no db span');

  // Criterion 7 (M3b): the HTTP server span and order.create carry order.id, and the stored
  // traceparent is order.create's context.
  const create = spans.find((s) => s.name === 'order.create');
  assert.ok(create, 'order.create span missing');
  assert.equal(post.attributes['order.id'], id);
  assert.equal(create.attributes['order.id'], id);
  assert.equal(create.parentSpanContext?.spanId, post.spanContext().spanId);
  const stored = await pool.query('SELECT trace_context FROM orders WHERE id = $1', [id]);
  const { traceId, spanId } = create.spanContext();
  assert.equal(stored.rows[0]?.trace_context, `00-${traceId}-${spanId}-01`);

  // Criterion 5: pg spans under the issuing span, none outside a span, no parameter values.
  const underPost = db.filter((s) => ancestors(s).includes('POST /orders'));
  assert.ok(
    underPost.length >= 3,
    `expected order-creation queries under POST /orders, got ${underPost.length}`,
  );
  for (const s of underPost) assert.equal(s.spanContext().traceId, post.spanContext().traceId);
  assert.ok(
    db.some((s) => queryText(s).includes('inside_pass') && ancestors(s).includes('order.process')),
  );
  assert.ok(
    !db.some((s) => queryText(s).includes('outside_any_span')),
    'query outside a span was traced',
  );
  const dbAttributes = JSON.stringify(db.map((s) => s.attributes));
  for (const value of ['SKU-00001', 'pm_card_ok', id]) {
    assert.ok(!dbAttributes.includes(value), `db span recorded parameter value ${value}`);
  }
});

test('production preload: only the catalog records metrics, with the agreed labels', async () => {
  // The previous test made one POST /orders, one GET /orders/:id and two probe requests.
  // These add an unmatched URL and a pg query whose pool the pg instrumentation would observe.
  assert.equal((await fetch(`${base}/no/such/path`)).status, 404);
  await pool.query('SELECT 1 AS pool_activity');

  const { resourceMetrics, errors } = await reader.collect();
  assert.deepEqual(errors, []);
  assert.equal(resourceMetrics.resource.attributes['service.name'], 'orders-api');
  assert.equal(resourceMetrics.resource.attributes['service.version'], '0.0.0');

  // Instrumentation isolation: no metrics from the http or pg instrumentations, which would reuse
  // catalog names (http.server.request.duration, db.client.connection.count) with other labels.
  const scopes = resourceMetrics.scopeMetrics.map((s) => s.scope.name);
  assert.deepEqual(scopes, ['@commerce/telemetry'], `metric scopes: ${scopes.join(', ')}`);
  const metrics = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
  assert.deepEqual(
    metrics.map((m) => m.descriptor.name),
    ['http.server.request.duration'],
  );

  const points = metrics[0].dataPoints.map((p) => ({ ...p.attributes, count: p.value.count }));
  const key = (p) =>
    `${p['http.request.method']} ${p['http.route'] ?? '-'} ${p['http.response.status_code']}`;
  assert.deepEqual(points.map(key).sort(), [
    'GET - 404',
    'GET /orders/:id 200',
    'POST /orders 201',
  ]);
  // Probes are never counted (criterion 4), and the 404 carries no route or raw URL.
  assert.equal(
    points.reduce((sum, p) => sum + p.count, 0),
    3,
  );
  for (const p of points) {
    assert.deepEqual(
      Object.keys(p).sort(),
      [
        'count',
        'http.request.method',
        'http.response.status_code',
        ...(p['http.route'] ? ['http.route'] : []),
      ].sort(),
    );
  }
});
