import { claimDueOrders, listOrderSkus, type ClaimedOrder } from '@commerce/db';
import { poisonSku } from '@commerce/faults';
import { createWorkerMetrics, METRIC } from '@commerce/telemetry';
import { pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ageClaim,
  createTestPool,
  insertProducts,
  makeDue,
  orderState,
  placeOrder,
  resetDatabase,
} from '../../../packages/db/test/support.js';
import {
  createTestMeter,
  valueAt,
  type TestMeter,
} from '../../../packages/telemetry/test/metric-support.js';
import { createWorkerFaults, type WorkerFaults } from '../src/faults.js';
import { loadFaultsConfig } from '../src/faults-config.js';
import { buildHealthServer } from '../src/health-server.js';
import { runWorkerLoop } from '../src/loop.js';
import { createClaimRecoverer } from '../src/recovery.js';
import { createClaimReleaser, shutdownWorker } from '../src/shutdown.js';
import {
  limits,
  makeWorker,
  realSimulator,
  runPasses,
  silentLogger,
  waitUntil,
} from './support.js';

/** M5a on the worker: criteria A1, A2, A3, A6, A8, A9 and A10. */
const HOUR = 3_600_000;
const SKU = 'SKU-00001';
const POISON = poisonSku(42);
const POLICY = { maxReconciliationAttempts: 5, paymentUnknownRecheckMs: 900_000 };
const RECOVERY = { ...POLICY, claimTimeoutMs: 60_000, retryBaseMs: 1000, retryMaxMs: 60_000 };

const pool = createTestPool();
const simulatorPool = createTestPool();
let tm: TestMeter;
let faults: WorkerFaults;

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeEach(async () => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  tm = createTestMeter();
  faults = createWorkerFaults({ skusOf: (id) => listOrderSkus(pool, id) });
  await resetDatabase(pool);
  await insertProducts(pool, [
    { sku: SKU, priceCents: 1000, stock: 500 },
    { sku: POISON, priceCents: 1000, stock: 500 },
  ]);
});
afterEach(async () => {
  faults.controller.stop();
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
  await tm.shutdown();
});
afterAll(async () => {
  await pool.end();
  await simulatorPool.end();
});

describe('fault configuration (A2)', () => {
  it('is disabled by default and accepts only true or false', () => {
    expect(loadFaultsConfig({})).toEqual({ enabled: false });
    expect(loadFaultsConfig({ FAULTS_ENABLED: 'true' })).toEqual({ enabled: true });
    for (const value of ['yes', '', 'True']) {
      expect(() => loadFaultsConfig({ FAULTS_ENABLED: value })).toThrow(/FAULTS_ENABLED/);
    }
  });
});

describe('health server admin routes', () => {
  it('A1: without fault control the admin paths return 404 and nothing is registered', async () => {
    const app = buildHealthServer({ pool, logger: pino({ level: 'silent' }) });
    const res = await app.inject({ method: 'GET', url: '/admin/scenarios' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'not_found',
      message: 'route GET /admin/scenarios not found',
    });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });

  it('A6, A9: with control, the worker answers for itself and logs nothing at info', async () => {
    const lines: unknown[] = [];
    const logger = pino({ level: 'info' }, { write: (l: string) => lines.push(l) });
    const app = buildHealthServer({ pool, logger, faultControl: faults.control });
    const started = await app.inject({
      method: 'POST',
      url: '/admin/scenarios/provider-outage/start',
      payload: { seed: 3, durationMs: 60_000 },
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({
      activation: { scenario: 'provider-outage', processes: { worker: 'active' } },
    });
    const badJson = await app.inject({
      method: 'POST',
      url: '/admin/scenarios/provider-outage/start',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ error: 'validation_error' });
    expect(
      (await app.inject({ method: 'GET', url: '/admin/scenarios/active' })).json(),
    ).toMatchObject({
      processes: { worker: { active: { scenario: 'provider-outage' } } },
    });
    expect((await app.inject({ method: 'POST', url: '/admin/scenarios/stop' })).json()).toEqual({
      stopped: true,
      scenario: 'provider-outage',
    });
    expect(lines).toEqual([]);
    await app.close();
  });
});

describe('worker scenarios', () => {
  it('A1: before any start, the provider and the hook pass through', async () => {
    const sim = realSimulator(simulatorPool);
    const metrics = createWorkerMetrics(tm.meter);
    const { processor } = makeWorker(pool, faults.wrapProvider(sim.provider), {
      metrics,
      hooks: faults.hooks,
    });
    await placeOrder(pool, [{ sku: POISON, quantity: 1 }]);
    expect(await runPasses(pool, processor)).toEqual(['paid']);
    expect(faults.hooks.beforeStep?.('reserve', { id: 'x' } as ClaimedOrder)).toBeUndefined();
  });

  it('A3, A8: payment-timeouts hangs charges until the payment timeout, counted as charge errors', async () => {
    const sim = realSimulator(simulatorPool);
    const metrics = createWorkerMetrics(tm.meter);
    const { processor } = makeWorker(pool, faults.wrapProvider(sim.provider), {
      metrics,
      paymentTimeoutMs: 50,
    });
    faults.controller.start('payment-timeouts', 42, 60_000);
    for (let i = 0; i < 10; i += 1) await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const outcomes = await runPasses(pool, processor);
    const retried = outcomes.filter((o) => o === 'retry_scheduled').length;
    expect(retried).toBeGreaterThan(0);
    expect(outcomes.filter((o) => o === 'paid').length).toBe(10 - retried);
    const collected = await tm.collect();
    expect(
      valueAt(collected, METRIC.paymentCalls, {
        'payment.operation': 'charge',
        'payment.result': 'error',
        'payment.replayed': false,
      }),
    ).toBe(retried);
    // The hung calls are still held; stopping rejects them all, never unhandled.
    expect(faults.pendingPaymentCalls()).toBe(retried);
    faults.controller.stop();
    expect(faults.pendingPaymentCalls()).toBe(0);
  });

  it('A3, A8: provider-outage fails charges and lookups as unavailable', async () => {
    const sim = realSimulator(simulatorPool);
    const metrics = createWorkerMetrics(tm.meter);
    const { processor } = makeWorker(pool, faults.wrapProvider(sim.provider), {
      metrics,
      limits: limits({ maxChargeAttempts: 1 }),
    });
    faults.controller.start('provider-outage', 42, 60_000);
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    expect(await runPasses(pool, processor)).toEqual(['reconciliation_retry']);
    expect((await orderState(pool, id)).status).toBe('pending');
    const collected = await tm.collect();
    expect(
      valueAt(collected, METRIC.paymentCalls, {
        'payment.operation': 'lookup_or_void',
        'payment.result': 'error',
        'payment.replayed': false,
      }),
    ).toBe(1);
    expect(sim.calls.charges).toHaveLength(0);
  });

  it('A3, A8: poison-order hangs the pass, its claim is recovered, and stop fails the pass', async () => {
    const metrics = createWorkerMetrics(tm.meter);
    const { processor, registry } = makeWorker(pool, realSimulator(simulatorPool).provider, {
      metrics,
      hooks: faults.hooks,
    });
    faults.controller.start('poison-order', 42, 60_000);
    const clean = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const poisoned = await placeOrder(pool, [
      { sku: SKU, quantity: 1 },
      { sku: POISON, quantity: 1 },
    ]);
    const claimed = await claimDueOrders(pool, { workerId: 'w1', limit: 2 });
    const passes = claimed.map((o) => processor.process(o));
    await waitUntil(() => faults.hungPasses() === 1, 'poison pass hung');
    // The clean order's pass finishes; only the poisoned one keeps its slot.
    await waitUntil(
      async () => (await orderState(pool, clean)).status === 'paid',
      'clean order paid',
    );
    await waitUntil(() => registry.size === 1, 'clean pass finished');
    expect(registry.size).toBe(1);

    await ageClaim(pool, poisoned);
    const recover = createClaimRecoverer({ pool, logger: silentLogger, params: RECOVERY, metrics });
    expect(await recover()).toBe(1);
    expect(valueAt(await tm.collect(), METRIC.claimsRecovered, { 'order.status': 'pending' })).toBe(
      1,
    );

    faults.controller.stop();
    expect((await Promise.all(passes)).sort()).toEqual(['error', 'paid']);
    expect(faults.hungPasses()).toBe(0);
  });

  it('A10: shutdown during poison-order and payment-timeouts keeps the M2 drain result, exit 0', async () => {
    const sim = realSimulator(simulatorPool);
    const { processor, registry } = makeWorker(pool, faults.wrapProvider(sim.provider), {
      hooks: faults.hooks,
      paymentTimeoutMs: HOUR,
    });
    await placeOrder(pool, [{ sku: POISON, quantity: 1 }]);
    faults.controller.start('poison-order', 42, 60_000);
    const controller = new AbortController();
    const loopDone = runWorkerLoop<ClaimedOrder>(
      {
        claim: (limit) => claimDueOrders(pool, { workerId: 'w1', limit }),
        recover: () => Promise.resolve(),
        process: (order) => processor.process(order),
        concurrency: 2,
        claimBatchSize: 10,
        pollIntervalMs: HOUR,
        logger: silentLogger,
      },
      controller.signal,
    );
    await waitUntil(() => faults.hungPasses() === 1, 'poison pass hung');

    // As main.ts does at SIGTERM: faults first, then the unchanged M2 protocol.
    faults.controller.shutdown();
    const result = await shutdownWorker({
      stopLoop: () => {
        controller.abort();
      },
      loopDone,
      registry,
      drainDeadline: new Promise(() => undefined),
      release: createClaimReleaser(pool, POLICY, silentLogger),
      logger: silentLogger,
    });
    expect(result).toEqual({ exitCode: 0, drained: true, released: [], unconfirmed: [] });
    expect(faults.hungPasses()).toBe(0);
    expect(faults.pendingPaymentCalls()).toBe(0);
    expect(faults.controller.start('payment-timeouts', 1, 1000)).toEqual({
      ok: false,
      reason: 'shut_down',
    });
  });

  it('A10: shutdown during provider-outage restores the provider and refuses later starts', async () => {
    const sim = realSimulator(simulatorPool);
    const wrapped = faults.wrapProvider(sim.provider);
    const { processor } = makeWorker(pool, wrapped, { limits: limits({ maxChargeAttempts: 1 }) });
    faults.controller.start('provider-outage', 42, 60_000);
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    expect(await runPasses(pool, processor)).toEqual(['reconciliation_retry']);
    faults.controller.shutdown();
    expect(faults.controller.active()).toBeNull();
    expect(sim.calls.charges).toHaveLength(0);
    // The provider passes through again; the order's next pass is the ordinary M2 one.
    await makeDue(pool, id);
    expect(await runPasses(pool, processor)).not.toContain('reconciliation_retry');
    expect(faults.controller.start('provider-outage', 1, 1000)).toEqual({
      ok: false,
      reason: 'shut_down',
    });
  });

  it('A10: shutdown during payment-timeouts rejects every pending call', async () => {
    const sim = realSimulator(simulatorPool);
    const { processor } = makeWorker(pool, faults.wrapProvider(sim.provider), {
      paymentTimeoutMs: HOUR,
    });
    faults.controller.start('payment-timeouts', 42, 60_000);
    for (let i = 0; i < 6; i += 1) await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const claimed = await claimDueOrders(pool, { workerId: 'w1', limit: 6 });
    const passes = claimed.map((o) => processor.process(o));
    await waitUntil(() => faults.pendingPaymentCalls() > 0, 'a charge hangs');
    await new Promise((r) => setTimeout(r, 50));
    const hung = faults.pendingPaymentCalls();
    faults.controller.shutdown();
    const outcomes = await Promise.all(passes);
    expect(outcomes.filter((o) => o === 'retry_scheduled')).toHaveLength(hung);
    expect(faults.pendingPaymentCalls()).toBe(0);
  });
});
