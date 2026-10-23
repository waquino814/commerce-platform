import {
  claimDueOrders,
  finalizePaid,
  recoverExpiredClaims,
  releaseClaims,
  type Pool,
} from '@commerce/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ageClaim,
  createTestPool,
  insertProducts,
  ledgerRows,
  orderState,
  placeOrder,
  resetDatabase,
  stockOf,
  withoutTransitionTrigger,
} from '../../../packages/db/test/support.js';
import type { Limits } from '../src/lifecycle.js';
import { runWorkerLoop } from '../src/loop.js';
import type { PaymentProvider } from '../src/payment/provider.js';
import type { OrderStore, ProcessorHooks } from '../src/processor.js';
import { createClaimReleaser, shutdownWorker } from '../src/shutdown.js';
import {
  captureLogger,
  claimOne,
  countingStore,
  Deferred,
  FakeProvider,
  limits,
  makeWorker,
  realSimulator,
  runPasses,
  silentLogger,
  waitUntil,
} from './support.js';

const HOUR = 3_600_000;
const SKU = 'SKU-00001';
const POLICY = { maxReconciliationAttempts: 5, paymentUnknownRecheckMs: 900_000 };

const pool = createTestPool();
const simulatorPool = createTestPool();
afterAll(async () => {
  await pool.end();
  await simulatorPool.end();
});
beforeEach(async () => {
  await resetDatabase(pool);
  await insertProducts(pool, [{ sku: SKU, priceCents: 1000, stock: 10 }]);
});

const recover = () =>
  recoverExpiredClaims(pool, {
    ...POLICY,
    claimTimeoutMs: 60_000,
    retryBaseMs: 0,
    retryMaxMs: 0,
  });

/** A real loop and processor, with a counted claim function and a controllable shutdown. */
function startWorker(
  provider: PaymentProvider,
  options: { hooks?: ProcessorHooks; limits?: Limits; store?: OrderStore } = {},
) {
  const { processor, registry } = makeWorker(pool, provider, options);
  const controller = new AbortController();
  let claims = 0;
  const loopDone = runWorkerLoop(
    {
      claim: (limit) => {
        claims += 1;
        return claimDueOrders(pool, { workerId: 'w1', limit });
      },
      recover: () => Promise.resolve(),
      process: (order) => processor.process(order),
      concurrency: 2,
      claimBatchSize: 10,
      pollIntervalMs: HOUR,
      logger: silentLogger,
    },
    controller.signal,
  );
  return {
    registry,
    loopDone,
    claims: () => claims,
    shutdown: (drainDeadline: Promise<void>, releasePool: Pool = pool) =>
      shutdownWorker({
        stopLoop: () => {
          controller.abort();
        },
        loopDone,
        registry,
        drainDeadline,
        release: createClaimReleaser(releasePool, POLICY, silentLogger),
        logger: silentLogger,
      }),
  };
}

const never = new Promise<void>(() => undefined);

describe('shutdown', () => {
  it('stops claiming and drains an in-flight order (criterion 23)', async () => {
    const a = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const fake = new FakeProvider();
    fake.blockCharges();
    const sim = realSimulator(simulatorPool);
    const worker = startWorker(fake);
    await waitUntil(() => fake.charges.length === 1, 'charge started');
    const b = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);

    const deadline = new Deferred<void>();
    const done = worker.shutdown(deadline.promise);
    await worker.loopDone;
    const claimsAtStop = worker.claims();

    const request = fake.charges[0];
    if (!request) throw new Error('no charge');
    fake.release(a, await sim.provider.charge(request));
    const result = await done;

    expect(result).toEqual({ exitCode: 0, drained: true, released: [], unconfirmed: [] });
    expect(worker.claims()).toBe(claimsAtStop);
    expect((await orderState(pool, a)).status).toBe('paid');
    expect(await orderState(pool, b)).toMatchObject({ status: 'pending', processing_attempts: 0 });
  });

  async function chargeRecordedThenHang() {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 2 }]);
    const sim = realSimulator(simulatorPool);
    const fake = new FakeProvider();
    fake.onCharge = async (request) => {
      await sim.provider.charge(request);
      return new Promise(() => undefined);
    };
    const worker = startWorker(fake);
    await waitUntil(async () => (await ledgerRows(pool, id)).length === 1, 'approval recorded');
    return { id, sim, worker };
  }

  it('releases an order whose charge was recorded just before shutdown, and a new pass pays it (criterion 24)', async () => {
    const { id, sim, worker } = await chargeRecordedThenHang();

    const result = await worker.shutdown(Promise.resolve());

    expect(result).toEqual({ exitCode: 0, drained: false, released: [id], unconfirmed: [] });
    const state = await orderState(pool, id);
    expect(state).toMatchObject({
      status: 'pending',
      last_error: 'released_on_shutdown',
      claimed_at: null,
      claimed_by: null,
      processing_attempts: 1,
      charge_attempts: 1,
      inventory_released_at: null,
    });
    expect(state.inventory_reserved_at).toBeInstanceOf(Date);
    const [row] = await ledgerRows(pool, id);
    expect(row?.outcome).toBe('approved');
    expect(await stockOf(pool, SKU)).toBe(8);

    const { processor } = makeWorker(pool, sim.provider);
    expect(await runPasses(pool, processor, 'w2')).toEqual(['paid']);
    expect(sim.calls.results.at(-1)).toMatchObject({ replayed: true, reference: row?.reference });
    expect(await orderState(pool, id)).toMatchObject({
      status: 'paid',
      payment_reference: row?.reference,
    });
    expect(await ledgerRows(pool, id)).toHaveLength(1);
    expect(await stockOf(pool, SKU)).toBe(8);
  });

  it('variant: a failed release leaves the order for recovery, which requeues it (criterion 24)', async () => {
    const { id, sim, worker } = await chargeRecordedThenHang();
    const closedPool = createTestPool();
    await closedPool.end();

    const result = await worker.shutdown(Promise.resolve(), closedPool);

    expect(result).toMatchObject({ exitCode: 1, released: [], unconfirmed: [id] });
    expect(await orderState(pool, id)).toMatchObject({
      status: 'processing',
      processing_attempts: 1,
      charge_attempts: 1,
    });

    await ageClaim(pool, id);
    expect(await recover()).toEqual([{ id, status: 'pending' }]);
    const { processor } = makeWorker(pool, sim.provider);
    expect(await runPasses(pool, processor, 'w2')).toEqual(['paid']);
    expect(await ledgerRows(pool, id)).toHaveLength(1);
    expect(await stockOf(pool, SKU)).toBe(8);
  });

  it('fences out a stale worker after recovery (criterion 25)', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const fake = new FakeProvider();
    fake.blockCharges();
    const { logger, lines } = captureLogger();
    const w1 = makeWorker(pool, fake, { logger });
    const w1Pass = w1.processor.process(await claimOne(pool, 'w1'));
    await waitUntil(() => fake.charges.length === 1, 'w1 charge started');

    await ageClaim(pool, id);
    await recover();
    const sim = realSimulator(simulatorPool);
    const w2 = makeWorker(pool, sim.provider);
    expect(await runPasses(pool, w2.processor, 'w2')).toEqual(['paid']);
    const paid = await orderState(pool, id);
    expect(paid).toMatchObject({ status: 'paid', processing_attempts: 2 });

    const request = fake.charges[0];
    if (!request) throw new Error('no charge');
    fake.release(id, await sim.provider.charge(request));
    expect(await w1Pass).toBe('claim_lost');
    const client = await pool.connect();
    try {
      expect(
        await releaseClaims(client, {
          ...POLICY,
          claims: [{ orderId: id, token: 1 }],
          statementTimeoutMs: 500,
        }),
      ).toEqual([]);
    } finally {
      client.release();
    }

    const after = await orderState(pool, id);
    expect(after.updated_at).toEqual(paid.updated_at);
    expect(after.payment_reference).toBe(paid.payment_reference);
    expect(lines.some((l) => l.msg === 'claim_lost' && l.orderId === id)).toBe(true);
    expect(await ledgerRows(pool, id)).toHaveLength(1);
    expect(await stockOf(pool, SKU)).toBe(9);
  });
});

describe('attempt semantics (criterion 34)', () => {
  const pauseBeforeReserve: ProcessorHooks = {
    beforeStep: (step) => (step === 'reserve' ? never : undefined),
  };

  async function releaseBeforeReservation(provider: PaymentProvider, lim?: Limits) {
    const worker = startWorker(provider, {
      hooks: pauseBeforeReserve,
      ...(lim ? { limits: lim } : {}),
    });
    await waitUntil(() => worker.registry.size === 1, 'pass paused before reservation');
    const result = await worker.shutdown(Promise.resolve());
    expect(result.exitCode).toBe(0);
    expect(result.released).toHaveLength(1);
  }

  it('does not spend the charge budget on shutdown releases', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const sim = realSimulator(simulatorPool);
    for (let i = 0; i < 3; i++) await releaseBeforeReservation(sim.provider);

    expect(await orderState(pool, id)).toMatchObject({
      status: 'pending',
      processing_attempts: 3,
      charge_attempts: 0,
    });

    const { processor } = makeWorker(pool, sim.provider);
    expect(await runPasses(pool, processor)).toEqual(['paid']);
    expect(await orderState(pool, id)).toMatchObject({
      status: 'paid',
      processing_attempts: 4,
      charge_attempts: 1,
    });
  });

  it('reconciles and voids an order that reaches the claim ceiling without a charge', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const sim = realSimulator(simulatorPool);
    const lim = limits({ maxClaims: 3, maxChargeAttempts: 2 });
    for (let i = 0; i < 3; i++) await releaseBeforeReservation(sim.provider, lim);

    const { processor } = makeWorker(pool, sim.provider, { limits: lim });
    expect(await runPasses(pool, processor)).toEqual(['failed']);

    const state = await orderState(pool, id);
    expect(state).toMatchObject({
      status: 'failed',
      failure_reason: 'max_attempts_exceeded',
      processing_attempts: 4,
      charge_attempts: 0,
      inventory_reserved_at: null,
      inventory_released_at: null,
    });
    expect(sim.calls.charges).toHaveLength(0);
    expect(sim.calls.lookups).toEqual([id]);
    expect(await ledgerRows(pool, id)).toEqual([{ outcome: 'voided', reference: null }]);
    expect(await stockOf(pool, SKU)).toBe(10);
  });
});

describe('shutdown release cannot get the lock (criterion 35)', () => {
  it('reports exit code 1, writes nothing, and the order stays recoverable', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 3 }]);
    const fake = new FakeProvider();
    fake.blockCharges();
    const { store, counts } = countingStore();
    const worker = startWorker(fake, { store });
    await waitUntil(() => fake.charges.length === 1, 'charge started');
    const before = await orderState(pool, id);
    expect(before).toMatchObject({ status: 'processing', charge_attempts: 1 });

    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [id]);
    let result;
    try {
      result = await worker.shutdown(Promise.resolve());
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(result).toEqual({ exitCode: 1, drained: false, released: [], unconfirmed: [id] });

    // Nothing from the aborted pass, even after its charge answers.
    const countsAtAbort = { ...counts };
    fake.release(id, { outcome: 'approved', reference: 'late', replayed: false });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(counts).toEqual(countsAtAbort);
    const unchanged = await orderState(pool, id);
    expect(unchanged).toEqual(before);
    expect(await stockOf(pool, SKU)).toBe(7);
    expect(await ledgerRows(pool, id)).toEqual([]);

    await ageClaim(pool, id);
    expect(await recover()).toEqual([{ id, status: 'pending' }]);
    const reclaimed = await claimOne(pool, 'w2');
    expect(reclaimed.processingAttempts).toBe(2);

    expect(await finalizePaid(pool, { orderId: id, token: 1, paymentReference: 'stale' })).toBe(
      false,
    );
    const client = await pool.connect();
    try {
      expect(
        await releaseClaims(client, {
          ...POLICY,
          claims: [{ orderId: id, token: 1 }],
          statementTimeoutMs: 500,
        }),
      ).toEqual([]);
    } finally {
      client.release();
    }

    const sim = realSimulator(simulatorPool);
    const { processor } = makeWorker(pool, sim.provider);
    expect(await processor.process(reclaimed)).toBe('paid');
    expect(await ledgerRows(pool, id)).toHaveLength(1);
    expect(await stockOf(pool, SKU)).toBe(7);
  });
});

describe('payment_unknown coordination (criterion 36)', () => {
  async function parkedOrder(): Promise<string> {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    await withoutTransitionTrigger(
      pool,
      `UPDATE orders
          SET status = 'payment_unknown', reconciliation_attempts = 5, processing_attempts = 2,
              charge_attempts = 1, inventory_reserved_at = now(), next_attempt_at = now()
        WHERE id = $1`,
      [id],
    );
    await pool.query(`UPDATE products SET stock_available = stock_available - 1 WHERE sku = $1`, [
      SKU,
    ]);
    return id;
  }

  it('lets only one of two eligible workers recheck, with one lookup and no charge', async () => {
    const id = await parkedOrder();
    const fake = new FakeProvider();
    const a = makeWorker(pool, fake);
    const b = makeWorker(pool, fake);

    const outcomes = await Promise.all([
      runPasses(pool, a.processor, 'a'),
      runPasses(pool, b.processor, 'b'),
    ]);

    expect(outcomes.flat()).toEqual(['parked']);
    expect(fake.lookups).toEqual([id]);
    expect(fake.charges).toHaveLength(0);
    expect(await orderState(pool, id)).toMatchObject({
      status: 'payment_unknown',
      reconciliation_attempts: 6,
    });
  });

  it('keeps a recheck interrupted by shutdown parked', async () => {
    const id = await parkedOrder();
    const fake = new FakeProvider();
    fake.onLookup = () => new Promise(() => undefined);
    const worker = startWorker(fake);
    await waitUntil(() => fake.lookups.length === 1, 'recheck started');

    const result = await worker.shutdown(Promise.resolve());

    expect(result).toMatchObject({ exitCode: 0, released: [id] });
    const state = await orderState(pool, id);
    expect(state).toMatchObject({
      status: 'payment_unknown',
      last_error: 'released_on_shutdown',
      inventory_released_at: null,
      reconciliation_attempts: 5,
    });
    expect(state.due_in_ms).toBe(900_000);
    expect(await stockOf(pool, SKU)).toBe(9);
  });

  it('keeps a recheck interrupted by a crash parked', async () => {
    const id = await parkedOrder();
    await claimOne(pool, 'crashed');
    await ageClaim(pool, id);

    expect(await recover()).toEqual([{ id, status: 'payment_unknown' }]);

    const state = await orderState(pool, id);
    expect(state).toMatchObject({ status: 'payment_unknown', last_error: 'claim_expired' });
    expect(state.due_in_ms).toBe(900_000);
    expect(await stockOf(pool, SKU)).toBe(9);
  });
});
