import { seedCatalog, seedProduct } from '@commerce/db';
import { createApiMetrics, METRIC, observePools } from '@commerce/telemetry';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, resetDatabase } from '../../../packages/db/test/support.js';
import {
  createTestMeter,
  labelValuesOf,
  pointsOf,
  seriesOf,
  valueAt,
  type TestMeter,
} from '../../../packages/telemetry/test/metric-support.js';
import { buildServer } from '../src/server.js';

/** Criteria 4 and 13: request-duration labels, probe exclusion and cardinality for the API. */
describe('orders API request metrics', () => {
  const pool = createTestPool();
  let tm: TestMeter;
  let app: ReturnType<typeof buildServer>;
  const sku = seedProduct(42).sku;
  const order = { items: [{ sku, quantity: 1 }], paymentMethod: 'pm_card_ok' };

  beforeAll(async () => {
    await resetDatabase(pool);
    await seedCatalog(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE payment_charges, order_items, orders');
    tm = createTestMeter();
    app = buildServer({
      pool,
      logger: pino({ level: 'silent' }),
      metrics: createApiMetrics(tm.meter),
    });
  });
  afterAll(async () => {
    await app.close();
    await tm.shutdown();
    await pool.end();
  });

  async function placeOrders(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/orders', payload: order });
      expect(res.statusCode).toBe(201);
      const { id } = res.json<{ id: string }>();
      expect((await app.inject({ method: 'GET', url: `/orders/${id}` })).statusCode).toBe(200);
      ids.push(id);
    }
    return ids;
  }

  it('labels by method, route template and status; probes add nothing; unmatched routes have no route', async () => {
    await placeOrders(1);
    const unknownSku = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { items: [{ sku: 'SKU-99999', quantity: 1 }], paymentMethod: 'pm_card_ok' },
    });
    expect(unknownSku.statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/products?limit=5' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'HEAD', url: '/products' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/no/such/path' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/orders' })).statusCode).toBe(404);
    for (const url of ['/healthz', '/readyz']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
      expect((await app.inject({ method: 'HEAD', url })).statusCode).toBe(200);
    }

    const collected = await tm.collect();
    const at = (attrs: Record<string, string | number>) =>
      valueAt(collected, METRIC.httpServerRequestDuration, attrs);
    const m = 'http.request.method';
    const r = 'http.route';
    const s = 'http.response.status_code';
    expect(at({ [m]: 'POST', [r]: '/orders', [s]: 201 })).toBe(1);
    expect(at({ [m]: 'POST', [r]: '/orders', [s]: 422 })).toBe(1);
    expect(at({ [m]: 'GET', [r]: '/orders/:id', [s]: 200 })).toBe(1);
    expect(at({ [m]: 'GET', [r]: '/products', [s]: 200 })).toBe(1);
    expect(at({ [m]: 'HEAD', [r]: '/products', [s]: 200 })).toBe(1);
    expect(at({ [m]: 'GET', [s]: 404 })).toBe(1);
    expect(at({ [m]: '_OTHER', [s]: 404 })).toBe(1);

    // Seven non-probe requests, and nothing else: probes are never counted (criterion 4).
    const points = pointsOf(collected, METRIC.httpServerRequestDuration);
    expect(points.reduce((sum, p) => sum + p.value, 0)).toBe(7);
    for (const p of points) {
      expect(['GET', 'POST', 'HEAD', 'OPTIONS', '_OTHER']).toContain(p.attributes[m]);
      if (r in p.attributes) {
        expect(['/products', '/orders', '/orders/:id']).toContain(p.attributes[r]);
      }
    }
    const values = labelValuesOf(collected);
    for (const raw of ['/healthz', '/readyz', '/no/such/path', '?limit=5', sku, 'SKU-99999']) {
      expect(values.some((v) => v.includes(raw))).toBe(false);
    }
  });

  it('over 20 orders and unmatched URLs in one run, series stay fixed and unmatched URLs have no route', async () => {
    const m = 'http.request.method';
    const r = 'http.route';
    const s = 'http.response.status_code';
    const firstUnmatched = '/no/such/path';
    const laterUnmatched = ['/orders/abc/extra', '/ORDERS'];
    const unmatched = [firstUnmatched, ...laterUnmatched];

    // First part: 2 orders and one unmatched URL.
    const firstIds = await placeOrders(2);
    expect((await app.inject({ method: 'GET', url: firstUnmatched })).statusCode).toBe(404);
    const early = await tm.collect();
    const earlySeries = new Set(seriesOf(early));

    // Second part: 18 more orders, for 20 in total, and two more distinct unmatched URLs.
    const laterIds = await placeOrders(18);
    for (const url of laterUnmatched) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    const collected = await tm.collect();

    // The series do not grow with orders or with distinct unmatched URLs.
    expect(new Set(seriesOf(collected))).toEqual(earlySeries);
    const points = pointsOf(collected, METRIC.httpServerRequestDuration);
    expect(
      points.map((p) => p.attributes).sort((a, b) => String(a[r]).localeCompare(String(b[r]))),
    ).toEqual([
      { [m]: 'POST', [r]: '/orders', [s]: 201 },
      { [m]: 'GET', [r]: '/orders/:id', [s]: 200 },
      { [m]: 'GET', [s]: 404 },
    ]);
    expect(
      valueAt(collected, METRIC.httpServerRequestDuration, {
        [m]: 'POST',
        [r]: '/orders',
        [s]: 201,
      }),
    ).toBe(20);
    expect(
      valueAt(collected, METRIC.httpServerRequestDuration, {
        [m]: 'GET',
        [r]: '/orders/:id',
        [s]: 200,
      }),
    ).toBe(20);
    // All three unmatched URLs share one series, with no http.route label.
    expect(valueAt(collected, METRIC.httpServerRequestDuration, { [m]: 'GET', [s]: 404 })).toBe(3);

    // No label value carries an order id, a SKU or a raw URL.
    const values = labelValuesOf(collected);
    for (const raw of [...firstIds, ...laterIds, sku, ...unmatched]) {
      expect(values.some((v) => v.includes(raw))).toBe(false);
    }
  });

  it('observes the API pool as orders-api', async () => {
    const stop = observePools([{ name: 'orders-api', pool }], tm.meter);
    const collected = await tm.collect();
    expect(
      valueAt(collected, METRIC.dbConnectionMax, {
        'db.client.connection.pool.name': 'orders-api',
      }),
    ).toBe(10);
    stop();
  });
});
