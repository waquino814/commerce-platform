import { createPool, type Pool, type PoolConfig } from '@commerce/db';
import { createWorkerMetrics, METRIC, type OrderStatusCounts } from '@commerce/telemetry';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ageClaim,
  createTestPool,
  insertProducts,
  orderState,
  placeOrder,
  resetDatabase,
  testDatabaseUrl,
  UNREACHABLE_DATABASE_URL,
} from '../../../packages/db/test/support.js';
import {
  createTestMeter,
  labelValuesOf,
  pointsOf,
  seriesOf,
  valueAt,
  type TestMeter,
} from '../../../packages/telemetry/test/metric-support.js';
import { createOrderStatusSampler, STALE_AFTER_INTERVALS } from '../src/order-status-sampler.js';
import { createClaimRecoverer } from '../src/recovery.js';
import { createClaimReleaser } from '../src/shutdown.js';
import { METRICS_POOL_SETTINGS, startWorkerMetrics } from '../src/worker-metrics.js';
import {
  captureLogger,
  claimOne,
  Deferred,
  FakeProvider,
  limits,
  makeWorker,
  realSimulator,
  runPasses,
  silentLogger,
  timeoutError,
  waitUntil,
} from './support.js';

const SKU = 'SKU-00001';
const POLICY = { maxReconciliationAttempts: 5, paymentUnknownRecheckMs: 900_000 };
const RECOVERY = { ...POLICY, claimTimeoutMs: 60_000, retryBaseMs: 1000, retryMaxMs: 60_000 };

const pool = createTestPool();
const simulatorPool = createTestPool();
let tm: TestMeter;

beforeEach(async () => {
  tm = createTestMeter();
  await resetDatabase(pool);
  await insertProducts(pool, [{ sku: SKU, priceCents: 1000, stock: 500 }]);
});
afterEach(async () => {
  await tm.shutdown();
});
afterAll(async () => {
  await pool.end();
  await simulatorPool.end();
});

describe('worker metrics at the M3b recording points (criterion 13)', () => {
  it('counts passes, payment calls, recovered and released claims with closed labels', async () => {
    const metrics = createWorkerMetrics(tm.meter);
    const sim = realSimulator(simulatorPool);
    const paid = await placeOrder(pool, [{ sku: SKU, quantity: 1 }], 'pm_card_ok');
    const declined = await placeOrder(pool, [{ sku: SKU, quantity: 1 }], 'pm_card_declined');
    const { processor } = makeWorker(pool, sim.provider, { metrics });
    expect((await runPasses(pool, processor)).sort()).toEqual(['failed', 'paid']);

    // An unknown outcome: counted as an error with replayed = false, and a retry is scheduled.
    const unknown = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const fake = new FakeProvider();
    fake.onCharge = () => Promise.reject(timeoutError());
    const retrying = makeWorker(pool, fake, { metrics, limits: limits({ maxChargeAttempts: 3 }) });
    expect(await runPasses(pool, retrying.processor)).toEqual(['retry_scheduled']);

    // Recovery of an expired claim, then a shutdown release of a held claim.
    const stuck = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    await claimOne(pool);
    await ageClaim(pool, stuck);
    const recover = createClaimRecoverer({ pool, logger: silentLogger, params: RECOVERY, metrics });
    expect(await recover()).toBe(1);
    await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const held = await claimOne(pool);
    const release = createClaimReleaser(pool, POLICY, silentLogger, undefined, metrics);
    expect(await release([{ orderId: held.id, token: held.processingAttempts }])).toEqual({
      released: [held.id],
      unconfirmed: [],
    });

    const collected = await tm.collect();
    const passes = (outcome: string) =>
      valueAt(collected, METRIC.workerPasses, {
        'order.pass.type': 'charge',
        'order.pass.outcome': outcome,
      });
    expect([passes('paid'), passes('failed'), passes('retry_scheduled')]).toEqual([1, 1, 1]);
    const calls = (result: string, replayed: boolean) =>
      valueAt(collected, METRIC.paymentCalls, {
        'payment.operation': 'charge',
        'payment.result': result,
        'payment.replayed': replayed,
      });
    expect([calls('approved', false), calls('declined', false), calls('error', false)]).toEqual([
      1, 1, 1,
    ]);
    expect(
      pointsOf(collected, METRIC.paymentDuration)
        .map((p) => [p.attributes['payment.result'], p.value])
        .sort(),
    ).toEqual([
      ['approved', 1],
      ['declined', 1],
      ['error', 1],
    ]);
    expect(pointsOf(collected, METRIC.claimsRecovered)).toEqual([
      { attributes: { 'order.status': 'pending' }, value: 1 },
    ]);
    expect(pointsOf(collected, METRIC.claimsReleased)).toEqual([
      { attributes: { 'release.result': 'released' }, value: 1 },
    ]);

    // No label value carries an order id, SKU, payment reference or error message.
    const references = await pool.query<{ payment_reference: string | null }>(
      'SELECT payment_reference FROM orders WHERE payment_reference IS NOT NULL',
    );
    const forbidden = [
      paid,
      declined,
      unknown,
      stuck,
      held.id,
      SKU,
      timeoutError().message,
      ...references.rows.map((r) => r.payment_reference ?? ''),
    ];
    expect(references.rows.length).toBeGreaterThan(0);
    const values = labelValuesOf(collected);
    for (const value of forbidden) {
      expect(values.some((v) => v.includes(value))).toBe(false);
    }
  });

  it('series do not grow with the number of orders (20 orders)', async () => {
    const metrics = createWorkerMetrics(tm.meter);
    const sim = realSimulator(simulatorPool);
    const { processor } = makeWorker(pool, sim.provider, { metrics });
    const runMix = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        await placeOrder(
          pool,
          [{ sku: SKU, quantity: 1 }],
          i % 2 ? 'pm_card_declined' : 'pm_card_ok',
        );
      }
      await runPasses(pool, processor);
    };
    await runMix(2);
    const fewOrders = new Set(seriesOf(await tm.collect()));
    await runMix(18);
    const collected = await tm.collect();
    expect(new Set(seriesOf(collected))).toEqual(fewOrders);
    expect(
      valueAt(collected, METRIC.workerPasses, {
        'order.pass.type': 'charge',
        'order.pass.outcome': 'paid',
      }),
    ).toBe(10);
  });

  it('does not count a payment call interrupted by shutdown, but counts the aborted pass', async () => {
    const metrics = createWorkerMetrics(tm.meter);
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const fake = new FakeProvider();
    fake.blockCharges();
    const { processor, registry } = makeWorker(pool, fake, { metrics });
    const order = await claimOne(pool);
    const pass = processor.process(order);
    await waitUntil(() => fake.blockedOrderIds.includes(id), 'charge blocked');
    registry.get(id)?.abort();
    expect(await pass).toBe('aborted');

    const collected = await tm.collect();
    expect(pointsOf(collected, METRIC.paymentCalls)).toEqual([]);
    expect(pointsOf(collected, METRIC.paymentDuration)).toEqual([]);
    expect(pointsOf(collected, METRIC.workerPasses)).toEqual([
      { attributes: { 'order.pass.type': 'charge', 'order.pass.outcome': 'aborted' }, value: 1 },
    ]);
  });
});

/** Timers the test fires by hand. */
function manualTimers() {
  const timers = {
    tick: null as (() => void) | null,
    cleared: false,
    setInterval: (fn: () => void) => {
      timers.tick = fn;
      return 'handle';
    },
    clearInterval: () => {
      timers.cleared = true;
    },
  };
  return timers;
}

const COUNTS: OrderStatusCounts = {
  pending: 1,
  processing: 0,
  paid: 2,
  failed: 0,
  payment_unknown: 0,
};

describe('order-status sampler', () => {
  it('samples at start and on each tick, skips a tick while a sample runs, and stops', async () => {
    const timers = manualTimers();
    const gates: Deferred<OrderStatusCounts>[] = [];
    const sampler = createOrderStatusSampler({
      query: () => {
        const gate = new Deferred<OrderStatusCounts>();
        gates.push(gate);
        return gate.promise;
      },
      intervalMs: 1000,
      logger: silentLogger,
      timers,
    });
    sampler.start();
    expect(gates).toHaveLength(1);
    timers.tick?.();
    expect(gates).toHaveLength(1);
    gates[0]?.resolve(COUNTS);
    await waitUntil(() => sampler.read() !== null, 'first sample');
    timers.tick?.();
    expect(gates).toHaveLength(2);
    gates[1]?.resolve(COUNTS);

    sampler.stop();
    expect(timers.cleared).toBe(true);
    await sampler.sample();
    expect(gates).toHaveLength(2);
  });

  it('expires a sample older than three intervals, and a failure is logged at debug and skipped', async () => {
    let now = 0;
    let fail = false;
    const { logger, lines } = captureLogger();
    const sampler = createOrderStatusSampler({
      query: () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(COUNTS)),
      intervalMs: 1000,
      logger,
      now: () => now,
      timers: manualTimers(),
    });
    expect(sampler.read()).toBeNull();
    await sampler.sample();
    now = STALE_AFTER_INTERVALS * 1000;
    expect(sampler.read()).toEqual(COUNTS);

    fail = true;
    await expect(sampler.sample()).resolves.toBeUndefined();
    expect(sampler.read()).toEqual(COUNTS);
    now += 1;
    expect(sampler.read()).toBeNull();
    expect(lines.filter((l) => l.msg === 'order_status_sample_failed')).toEqual([
      expect.objectContaining({ level: 20, err: 'db down' }),
    ]);
  });
});

describe('metrics pool isolation (criterion 14)', () => {
  function startEnabled(options: { databaseUrl?: string; pools?: Pool[] } = {}) {
    const created: { config: PoolConfig; pool: Pool }[] = [];
    const { logger, lines } = captureLogger();
    const telemetry = startWorkerMetrics({
      enabled: true,
      sampleIntervalMs: 1000,
      databaseUrl: options.databaseUrl ?? testDatabaseUrl(),
      logger,
      workerPool: pool,
      simulatorPool,
      inflight: () => 0,
      meter: tm.meter,
      createPool: (config, onError) => {
        const created_ = createPool(config, onError);
        created.push({ config, pool: created_ });
        return created_;
      },
    });
    return { telemetry, created, lines };
  }

  it('samples through its own one-connection pool only, leaving the worker and simulator pools untouched', async () => {
    await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const before = { worker: pool.totalCount, simulator: simulatorPool.totalCount };
    const { telemetry, created } = startEnabled();
    try {
      expect(created).toHaveLength(1);
      expect(created[0]?.config).toEqual({
        connectionString: testDatabaseUrl(),
        ...METRICS_POOL_SETTINGS,
      });
      expect(METRICS_POOL_SETTINGS).toEqual({
        max: 1,
        connectionTimeoutMillis: 1000,
        statementTimeoutMillis: 1000,
      });
      await waitUntil(
        async () => pointsOf(await tm.collect(), METRIC.orders).length === 5,
        'first sample',
      );
      const collected = await tm.collect();
      expect(valueAt(collected, METRIC.orders, { 'order.status': 'pending' })).toBe(1);
      expect(valueAt(collected, METRIC.orders, { 'order.status': 'paid' })).toBe(0);
      expect(pool.totalCount).toBe(before.worker);
      expect(simulatorPool.totalCount).toBe(before.simulator);
      expect(
        valueAt(collected, METRIC.dbConnectionMax, { 'db.client.connection.pool.name': 'metrics' }),
      ).toBe(1);
    } finally {
      telemetry.stopSampler();
      await telemetry.closeMetricsPool();
    }
  });

  it('with the database unreachable, sampling skips quietly and a concurrent pass keeps its M2 outcome', async () => {
    const { telemetry, lines } = startEnabled({ databaseUrl: UNREACHABLE_DATABASE_URL });
    try {
      const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
      const { processor } = makeWorker(pool, realSimulator(simulatorPool).provider);
      expect(await runPasses(pool, processor)).toEqual(['paid']);
      expect((await orderState(pool, id)).status).toBe('paid');
      await waitUntil(
        () => lines.some((l) => l.msg === 'order_status_sample_failed'),
        'sample failure logged',
      );
      expect(lines.find((l) => l.msg === 'order_status_sample_failed')?.level).toBe(20);
      expect(pointsOf(await tm.collect(), METRIC.orders)).toEqual([]);
    } finally {
      telemetry.stopSampler();
      await telemetry.closeMetricsPool();
    }
  });

  it('a sample blocked past its statement timeout fails quietly while a pass completes', async () => {
    const metricsPool = createPool(
      { connectionString: testDatabaseUrl(), ...METRICS_POOL_SETTINGS },
      () => undefined,
    );
    const { logger, lines } = captureLogger();
    let now = 0;
    const sampler = createOrderStatusSampler({
      // Blocks for 5 s inside the statement; the pool's 1 s statement timeout cancels it.
      query: async () => {
        await metricsPool.query('SELECT pg_sleep(5)');
        return COUNTS;
      },
      intervalMs: 1000,
      logger,
      now: () => now,
      timers: manualTimers(),
    });
    try {
      const blocked = sampler.sample();
      const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
      const { processor } = makeWorker(pool, realSimulator(simulatorPool).provider);
      expect(await runPasses(pool, processor)).toEqual(['paid']);
      expect((await orderState(pool, id)).status).toBe('paid');
      await expect(blocked).resolves.toBeUndefined();
      expect(lines.find((l) => l.msg === 'order_status_sample_failed')?.err).toMatch(
        /statement timeout/,
      );
      now = 10_000;
      expect(sampler.read()).toBeNull();
    } finally {
      await metricsPool.end();
    }
  });

  it('with telemetry disabled, creates no metrics pool and no sampler', async () => {
    let poolsCreated = 0;
    const telemetry = startWorkerMetrics({
      enabled: false,
      sampleIntervalMs: 1000,
      databaseUrl: testDatabaseUrl(),
      logger: silentLogger,
      workerPool: pool,
      simulatorPool,
      inflight: () => 3,
      meter: tm.meter,
      createPool: (config, onError) => {
        poolsCreated += 1;
        return createPool(config, onError);
      },
    });
    const collected = await tm.collect();
    expect(poolsCreated).toBe(0);
    expect(pointsOf(collected, METRIC.orders)).toEqual([]);
    expect(
      pointsOf(collected, METRIC.dbConnectionMax).map(
        (p) => p.attributes['db.client.connection.pool.name'],
      ),
    ).toEqual(['worker', 'simulator']);
    expect(pointsOf(collected, METRIC.workerInflight)).toEqual([{ attributes: {}, value: 3 }]);
    telemetry.stopSampler();
    await expect(telemetry.closeMetricsPool()).resolves.toBeUndefined();
  });

  it('caps the metrics pool close at 100 ms even when the pool never ends', async () => {
    const neverEnds = {
      end: () => new Promise<void>(() => undefined),
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      options: { max: 1 },
    } as unknown as Pool;
    const telemetry = startWorkerMetrics({
      enabled: true,
      sampleIntervalMs: 60_000,
      databaseUrl: testDatabaseUrl(),
      logger: silentLogger,
      workerPool: pool,
      simulatorPool,
      inflight: () => 0,
      meter: tm.meter,
      createPool: () => neverEnds,
    });
    telemetry.stopSampler();
    const started = performance.now();
    await telemetry.closeMetricsPool();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1000);
  });
});
