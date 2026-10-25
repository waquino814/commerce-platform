import { ConfigError, seedCatalog, seedProduct, type Pool } from '@commerce/db';
import { ORDER_READ_ERROR_MESSAGE } from '@commerce/faults';
import {
  completeShutdown,
  createApiMetrics,
  DISABLED_TELEMETRY,
  METRIC,
} from '@commerce/telemetry';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, resetDatabase } from '../../../packages/db/test/support.js';
import {
  createTestMeter,
  pointsOf,
  valueAt,
  type TestMeter,
} from '../../../packages/telemetry/test/metric-support.js';
import { createApiFaults, type ApiFaults } from '../src/faults.js';
import { loadFaultsConfig } from '../src/faults-config.js';
import { buildServer } from '../src/server.js';
import { createApiCleanup } from '../src/shutdown.js';

/** M5a on the orders API: criteria A1, A2, A3, A6, A8, A9 and A10. */
const sku = seedProduct(42).sku;
const order = { items: [{ sku, quantity: 1 }], paymentMethod: 'pm_card_ok' };

const okWorker = ((url: string) =>
  Promise.resolve(
    url.endsWith('/start')
      ? new Response(null, { status: 202 })
      : url.endsWith('/stop')
        ? new Response(null, { status: 200 })
        : Response.json({ processes: { worker: { active: null } } }),
  )) as unknown as typeof fetch;

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    { write: (l: string) => lines.push(JSON.parse(l) as Record<string, unknown>) },
  );
  return { logger, lines };
}

describe('fault configuration (A2)', () => {
  it('is disabled by default and accepts only true or false', () => {
    expect(loadFaultsConfig({})).toEqual({ enabled: false });
    expect(loadFaultsConfig({ FAULTS_ENABLED: 'false', WORKER_ADMIN_URL: 'nonsense' })).toEqual({
      enabled: false,
    });
    expect(loadFaultsConfig({ FAULTS_ENABLED: 'true' })).toEqual({
      enabled: true,
      workerAdminUrl: 'http://localhost:3001',
    });
    expect(
      loadFaultsConfig({ FAULTS_ENABLED: 'true', WORKER_ADMIN_URL: 'http://worker:3001/' }),
    ).toEqual({ enabled: true, workerAdminUrl: 'http://worker:3001' });
    for (const value of ['yes', '1', 'TRUE', '']) {
      expect(() => loadFaultsConfig({ FAULTS_ENABLED: value })).toThrow(ConfigError);
      expect(() => loadFaultsConfig({ FAULTS_ENABLED: value })).toThrow(/FAULTS_ENABLED/);
    }
    expect(() => loadFaultsConfig({ FAULTS_ENABLED: 'true', WORKER_ADMIN_URL: 'ftp://x' })).toThrow(
      /WORKER_ADMIN_URL/,
    );
  });
});

describe('orders API with faults', () => {
  const pool = createTestPool();
  let tm: TestMeter;
  let app: FastifyInstance;
  let faults: ApiFaults;

  beforeAll(async () => {
    await resetDatabase(pool);
    await seedCatalog(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE payment_charges, order_items, orders');
    tm = createTestMeter();
  });
  afterEach(async () => {
    faults.controller.stop();
    await app.close();
    await tm.shutdown();
  });
  afterAll(async () => {
    await pool.end();
  });

  function build(options: { enabled: boolean; appPool?: Pool; logger?: pino.Logger }) {
    const appPool = options.appPool ?? pool;
    faults = createApiFaults({
      pool: appPool,
      workerAdminUrl: 'http://worker.test',
      fetch: okWorker,
    });
    app = buildServer({
      pool: appPool,
      logger: options.logger ?? pino({ level: 'silent' }),
      metrics: createApiMetrics(tm.meter),
      ...(options.enabled ? { faults } : {}),
    });
    return app;
  }

  async function createOrderId(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/orders', payload: order });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it('A1: disabled, admin paths return the standard 404 and order reads are untouched', async () => {
    build({ enabled: false });
    for (const [method, url] of [
      ['GET', '/admin/scenarios'],
      ['GET', '/admin/scenarios/active'],
      ['POST', '/admin/scenarios/poison-order/start'],
      ['POST', '/admin/scenarios/stop'],
    ] as const) {
      const res =
        method === 'POST'
          ? await app.inject({ method, url, payload: {} })
          : await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'not_found',
        message: `route ${method} ${url} not found`,
      });
    }
    const id = await createOrderId();
    for (let i = 0; i < 30; i += 1) {
      expect((await app.inject({ method: 'GET', url: `/orders/${id}` })).statusCode).toBe(200);
    }
  });

  it('A6: the admin endpoints follow the documented contract over HTTP', async () => {
    build({ enabled: true });
    const list = await app.inject({ method: 'GET', url: '/admin/scenarios' });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ scenarios: unknown[] }>().scenarios).toHaveLength(5);

    const badJson = await app.inject({
      method: 'POST',
      url: '/admin/scenarios/poison-order/start',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ error: 'validation_error' });

    const invalid = await app.inject({
      method: 'POST',
      url: '/admin/scenarios/poison-order/start',
      payload: { seed: 1, durationMs: 10 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: 'validation_error',
      details: [{ path: 'durationMs' }],
    });

    const unknown = await app.inject({
      method: 'POST',
      url: '/admin/scenarios/missing-index/start',
      payload: { seed: 1, durationMs: 1000 },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({
      error: 'scenario_not_found',
      message: 'no scenario named missing-index',
    });

    const started = await app.inject({
      method: 'POST',
      url: '/admin/scenarios/poison-order/start',
      payload: { seed: 7, durationMs: 60_000 },
    });
    expect(started.statusCode).toBe(202);
    const { activation } = started.json<{ activation: Record<string, unknown> }>();
    expect(activation).toMatchObject({
      scenario: 'poison-order',
      seed: 7,
      processes: { 'orders-api': 'active', worker: 'active' },
    });
    expect(new Date(String(activation.startedAt)).toISOString()).toBe(activation.startedAt);

    const conflict = await app.inject({
      method: 'POST',
      url: '/admin/scenarios/payment-timeouts/start',
      payload: { seed: 1, durationMs: 1000 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'scenario_active' });

    const report = await app.inject({ method: 'GET', url: '/admin/scenarios/active' });
    expect(report.json()).toMatchObject({ active: { scenario: 'poison-order' } });
    const stopped = await app.inject({ method: 'POST', url: '/admin/scenarios/stop' });
    expect(stopped.json()).toEqual({ stopped: true, scenario: 'poison-order' });
  });

  it('A5: a worker that does not confirm rolls the start back with 502', async () => {
    faults = createApiFaults({
      pool,
      workerAdminUrl: 'http://worker.test',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    app = buildServer({
      pool,
      logger: pino({ level: 'silent' }),
      metrics: createApiMetrics(tm.meter),
      faults,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/scenarios/bad-deploy-order-reads/start',
      payload: { seed: 1, durationMs: 1000 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'worker_unavailable' });
    expect(faults.controller.active()).toBeNull();
  });

  it('A3, A8, A9: bad-deploy-order-reads fails about 40% of order reads with 500 until stopped', async () => {
    const { logger, lines } = capturingLogger();
    build({ enabled: true, logger });
    const id = await createOrderId();
    const before = await app.inject({ method: 'GET', url: `/orders/${id}` });
    expect(before.statusCode).toBe(200);
    faults.controller.start('bad-deploy-order-reads', 42, 60_000);
    const statuses: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const res = await app.inject({ method: 'GET', url: `/orders/${id}` });
      statuses.push(res.statusCode);
      if (res.statusCode === 500) {
        expect(res.json()).toEqual({ error: 'internal_error', message: 'internal server error' });
      }
    }
    const errors = statuses.filter((s) => s === 500).length;
    expect(errors).toBeGreaterThan(25);
    expect(errors).toBeLessThan(55);
    expect(statuses.every((s) => s === 200 || s === 500)).toBe(true);
    const collected = await tm.collect();
    expect(
      valueAt(collected, METRIC.httpServerRequestDuration, {
        'http.request.method': 'GET',
        'http.route': '/orders/:id',
        'http.response.status_code': 500,
      }),
    ).toBe(errors);
    faults.controller.stop();
    for (let i = 0; i < 30; i += 1) {
      expect((await app.inject({ method: 'GET', url: `/orders/${id}` })).statusCode).toBe(200);
    }
    expect(ORDER_READ_ERROR_MESSAGE).not.toMatch(/fault|scenario/i);
    // A9: the failing requests are logged like any other 500, with nothing naming the scenario.
    expect(lines.some((l) => l.level === 50)).toBe(true);
    expect(JSON.stringify(lines)).not.toMatch(/fault|scenario|bad-deploy|admin/i);
  });

  it('A3, A8: api-pool-exhaustion makes POST /orders return 500 and readiness 503, until stopped', async () => {
    const small = createTestPool(undefined, { max: 2 });
    try {
      build({ enabled: true, appPool: small });
      faults.controller.start('api-pool-exhaustion', 42, 60_000);
      await faults.poolLeak.settled();
      expect(faults.poolLeak.heldCount()).toBe(2);
      const failed = await app.inject({ method: 'POST', url: '/orders', payload: order });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: 'internal_error', message: 'internal server error' });
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
      const collected = await tm.collect();
      expect(
        valueAt(collected, METRIC.httpServerRequestDuration, {
          'http.request.method': 'POST',
          'http.route': '/orders',
          'http.response.status_code': 500,
        }),
      ).toBe(1);
      faults.controller.stop();
      expect(faults.poolLeak.heldCount()).toBe(0);
      expect(
        (await app.inject({ method: 'POST', url: '/orders', payload: order })).statusCode,
      ).toBe(201);
    } finally {
      faults.controller.stop();
      await app.close();
      await small.end();
      app = buildServer({ pool, logger: pino({ level: 'silent' }) });
    }
  });

  it('A9: admin requests record no request metric and log nothing at info, enabled or disabled', async () => {
    for (const enabled of [false, true]) {
      const { logger, lines } = capturingLogger();
      build({ enabled, logger });
      await app.inject({ method: 'GET', url: '/admin/scenarios' });
      await app.inject({ method: 'GET', url: '/admin/scenarios/active' });
      await app.inject({ method: 'POST', url: '/admin/scenarios/stop' });
      expect(lines, `enabled=${String(enabled)}`).toEqual([]);
      expect(pointsOf(await tm.collect(), METRIC.httpServerRequestDuration)).toEqual([]);
      // Control: an ordinary request is logged and counted.
      await app.inject({ method: 'GET', url: '/products' });
      expect(lines.length).toBeGreaterThan(0);
      expect(JSON.stringify(lines)).not.toMatch(/admin|scenario|poison|fault/i);
      await app.close();
      tm = createTestMeter();
    }
    build({ enabled: false });
  });

  it('A10: shutdown during api-pool-exhaustion releases the pool and exits 0 well within 8 s', async () => {
    const own = createTestPool(undefined, { max: 2 });
    build({ enabled: true, appPool: own });
    faults.controller.start('api-pool-exhaustion', 42, 60_000);
    await faults.poolLeak.settled();
    expect(faults.poolLeak.heldCount()).toBe(2);
    const exitCodes: number[] = [];
    const started = Date.now();
    await completeShutdown({
      exitCode: 0,
      cleanup: createApiCleanup({
        faults: faults.controller,
        app,
        pool: own,
        logger: pino({ level: 'silent' }),
      }),
      telemetry: DISABLED_TELEMETRY,
      deadlineAt: started + 8000,
      exit: (code) => exitCodes.push(code),
    });
    expect(exitCodes).toEqual([0]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(faults.poolLeak.heldCount()).toBe(0);
    expect(faults.controller.start('api-pool-exhaustion', 1, 1000)).toEqual({
      ok: false,
      reason: 'shut_down',
    });
    // The app and pool are closed; give afterEach fresh ones to close.
    app = buildServer({ pool, logger: pino({ level: 'silent' }) });
  });

  it('A10: shutdown during bad-deploy-order-reads turns the flag off', () => {
    build({ enabled: true });
    faults.controller.start('bad-deploy-order-reads', 42, 60_000);
    faults.controller.shutdown();
    expect(faults.orderReadFault.shouldFail()).toBe(false);
  });
});
