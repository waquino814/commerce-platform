import {
  claimDueOrders,
  finalizePaid,
  getOrder,
  recoverExpiredClaims,
  reserveInventory,
} from '@commerce/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../orders-api/src/server.js';
import {
  ageClaim,
  createTestPool,
  insertProducts,
  ledgerRows,
  makeDue,
  orderState,
  placeOrder,
  resetDatabase,
  stockOf,
} from '../../../packages/db/test/support.js';
import {
  approved,
  captureLogger,
  claimOne,
  countingStore,
  FakeProvider,
  limits,
  makeWorker,
  realSimulator,
  runPasses,
  silentLogger,
  timeoutError,
} from './support.js';

const SKU = 'SKU-00001';
const INITIAL_STOCK = 10;

const pool = createTestPool();
const simulatorPool = createTestPool();
afterAll(async () => {
  await pool.end();
  await simulatorPool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await insertProducts(pool, [
    { sku: SKU, priceCents: 1500, stock: INITIAL_STOCK },
    { sku: 'SKU-00002', priceCents: 700, stock: 3 },
  ]);
});

const recover = (overrides: { retryBaseMs?: number } = {}) =>
  recoverExpiredClaims(pool, {
    claimTimeoutMs: 60_000,
    retryBaseMs: overrides.retryBaseMs ?? 1000,
    retryMaxMs: 30_000,
    maxReconciliationAttempts: 5,
    paymentUnknownRecheckMs: 900_000,
  });

describe('core flow', () => {
  it('pays a pm_card_ok order in one pass (criterion 4)', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 2 }]);
    const { provider } = realSimulator(simulatorPool);
    const { processor } = makeWorker(pool, provider);

    expect(await runPasses(pool, processor)).toEqual(['paid']);

    const order = await getOrder(pool, id);
    expect(order).toMatchObject({
      status: 'paid',
      processingAttempts: 1,
      chargeAttempts: 1,
      nextAttemptAt: null,
      paymentReference: expect.stringMatching(/^sim_/) as string,
    });
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK - 2);
    expect(await ledgerRows(pool, id)).toEqual([
      { outcome: 'approved', reference: order?.paymentReference },
    ]);
  });

  it('fails a declined order and releases its stock (criterion 5)', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 4 }], 'pm_card_declined');
    const { processor } = makeWorker(pool, realSimulator(simulatorPool).provider);

    expect(await runPasses(pool, processor)).toEqual(['failed']);

    const state = await orderState(pool, id);
    expect(state).toMatchObject({ status: 'failed', failure_reason: 'payment_declined' });
    expect(state.inventory_released_at).toBeInstanceOf(Date);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK);
  });

  it('fails an order larger than the stock without reserving anything (criterion 6)', async () => {
    const id = await placeOrder(pool, [
      { sku: SKU, quantity: 1 },
      { sku: 'SKU-00002', quantity: 4 },
    ]);
    const fake = new FakeProvider();
    const { processor } = makeWorker(pool, fake);

    expect(await runPasses(pool, processor)).toEqual(['failed']);

    const state = await orderState(pool, id);
    expect(state).toMatchObject({
      status: 'failed',
      failure_reason: 'out_of_stock',
      charge_attempts: 0,
      inventory_reserved_at: null,
      inventory_released_at: null,
    });
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK);
    expect(await stockOf(pool, 'SKU-00002')).toBe(3);
    expect(fake.charges).toHaveLength(0);
  });

  it('retries pm_card_unavailable with backoff, then voids and fails it (criterion 7)', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 3 }], 'pm_card_unavailable');
    const { provider, calls } = realSimulator(simulatorPool);
    const { processor } = makeWorker(pool, provider);

    expect(await runPasses(pool, processor)).toEqual(['retry_scheduled']);
    let state = await orderState(pool, id);
    expect(state).toMatchObject({ status: 'pending', charge_attempts: 1 });
    expect(state.due_in_ms).toBe(1000);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK - 3);

    await makeDue(pool, id);
    expect(await runPasses(pool, processor)).toEqual(['retry_scheduled']);
    state = await orderState(pool, id);
    expect(state).toMatchObject({ status: 'pending', charge_attempts: 2 });
    expect(state.due_in_ms).toBe(2000);

    await makeDue(pool, id);
    expect(await runPasses(pool, processor)).toEqual(['failed']);

    state = await orderState(pool, id);
    expect(state).toMatchObject({
      status: 'failed',
      failure_reason: 'max_attempts_exceeded',
      charge_attempts: 3,
      processing_attempts: 3,
    });
    expect(calls.charges).toHaveLength(3);
    expect(calls.lookups).toEqual([id]);
    expect(await ledgerRows(pool, id)).toEqual([{ outcome: 'voided', reference: null }]);
    expect(state.inventory_released_at).toBeInstanceOf(Date);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK);
  });
});

describe('crash after a successful payment', () => {
  /** Claim, reserve, and record an approval, then stop: the state a crash leaves behind. */
  async function crashAfterApproval(provider: ReturnType<typeof realSimulator>['provider']) {
    const order = await claimOne(pool, 'w1');
    const client = await pool.connect();
    try {
      const reservation = await reserveInventory(client, {
        orderId: order.id,
        token: order.processingAttempts,
      });
      expect(reservation.kind).toBe('reserved');
    } finally {
      client.release();
    }
    const result = await provider.charge({
      orderId: order.id,
      amountCents: order.totalCents,
      paymentMethod: 'pm_card_ok',
    });
    expect(result).toMatchObject({ outcome: 'approved', replayed: false });
    return { order, reference: result.reference };
  }

  it('recovers and pays with the original charge, without reserving again (criterion 20)', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 2 }]);
    const sim = realSimulator(simulatorPool);
    const { reference } = await crashAfterApproval(sim.provider);
    const reservedAt = (await orderState(pool, id)).inventory_reserved_at;

    await ageClaim(pool, id);
    expect(await recover({ retryBaseMs: 0 })).toEqual([{ id, status: 'pending' }]);
    expect(await orderState(pool, id)).toMatchObject({
      status: 'pending',
      last_error: 'claim_expired',
      claimed_at: null,
      charge_attempts: 1,
    });

    const { logger, lines } = captureLogger();
    const { store, counts } = countingStore();
    const { processor } = makeWorker(pool, sim.provider, { logger, store });
    expect(await runPasses(pool, processor, 'w2')).toEqual(['paid']);

    const state = await orderState(pool, id);
    expect(state).toMatchObject({
      status: 'paid',
      processing_attempts: 2,
      charge_attempts: 2,
      payment_reference: reference,
    });
    expect(sim.calls.results.at(-1)).toEqual({ outcome: 'approved', reference, replayed: true });
    expect(await ledgerRows(pool, id)).toHaveLength(1);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK - 2);
    expect(state.inventory_reserved_at).toEqual(reservedAt);
    expect(counts.reserveInventory).toBe(0);
    expect(lines.some((l) => l.msg === 'reservation_skipped' && l.orderId === id)).toBe(true);

    expect(await finalizePaid(pool, { orderId: id, token: 1, paymentReference: 'stale' })).toBe(
      false,
    );
    expect((await orderState(pool, id)).payment_reference).toBe(reference);
  });

  it('reconciles after a crash on the last allowed charge attempt (criterion 21)', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 2 }]);
    const sim = realSimulator(simulatorPool);
    const { reference } = await crashAfterApproval(sim.provider);
    await ageClaim(pool, id);
    await recover({ retryBaseMs: 0 });

    const chargesBefore = sim.calls.charges.length;
    const { store, counts } = countingStore();
    const lim = limits({ maxChargeAttempts: 1 });
    const { processor } = makeWorker(pool, sim.provider, { store, limits: lim });
    expect(await runPasses(pool, processor, 'w2')).toEqual(['paid']);

    expect(sim.calls.charges).toHaveLength(chargesBefore);
    expect(sim.calls.lookups).toEqual([id]);
    expect(sim.calls.results.at(-1)).toEqual({ outcome: 'approved', reference, replayed: true });
    expect(counts.reserveInventory + counts.incrementChargeAttempt).toBe(0);
    expect(await orderState(pool, id)).toMatchObject({
      status: 'paid',
      charge_attempts: 1,
      processing_attempts: 2,
      payment_reference: reference,
    });
    expect(await ledgerRows(pool, id)).toHaveLength(1);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK - 2);
  });

  it('pays when the approval was recorded but the last attempt timed out (criterion 22)', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const sim = realSimulator(simulatorPool);
    const provider = {
      charge: async (request: Parameters<typeof sim.provider.charge>[0]) => {
        await sim.provider.charge(request);
        throw timeoutError();
      },
      lookupOrVoid: (orderId: string) => sim.provider.lookupOrVoid(orderId),
    };
    const { processor } = makeWorker(pool, provider, { limits: limits({ maxChargeAttempts: 1 }) });

    expect(await runPasses(pool, processor)).toEqual(['paid']);

    const [row] = await ledgerRows(pool, id);
    expect(await orderState(pool, id)).toMatchObject({
      status: 'paid',
      payment_reference: row?.reference,
    });
    expect(await ledgerRows(pool, id)).toHaveLength(1);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK - 1);
  });
});

describe('lookup failures and payment_unknown', () => {
  const lim = limits({ maxChargeAttempts: 1 });

  /** Spends the charge budget with an unknown charge outcome, then fails the first lookup. */
  async function reachFirstLookupError() {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 2 }]);
    const fake = new FakeProvider();
    fake.onCharge = () => Promise.reject(timeoutError());
    const { store, counts } = countingStore();
    const { processor } = makeWorker(pool, fake, { limits: lim, store });
    expect(await runPasses(pool, processor)).toEqual(['reconciliation_retry']);
    return { id, fake, processor, counts };
  }

  it('keeps the order recoverable after a lookup error below the limit (criterion 26)', async () => {
    const { id, fake, processor, counts } = await reachFirstLookupError();

    const state = await orderState(pool, id);
    expect(state).toMatchObject({
      status: 'pending',
      reconciliation_attempts: 1,
      charge_attempts: 1,
      inventory_released_at: null,
    });
    expect(state.due_in_ms).toBe(5000);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK - 2);

    await makeDue(pool, id);
    expect(await runPasses(pool, processor)).toEqual(['reconciliation_retry']);
    expect(fake.charges).toHaveLength(1);
    expect(fake.lookups).toEqual([id, id]);
    expect(counts.reserveInventory).toBe(1);
    expect(counts.incrementChargeAttempt).toBe(0);
    const after = await orderState(pool, id);
    expect(after).toMatchObject({ reconciliation_attempts: 2, charge_attempts: 1 });
    expect(after.due_in_ms).toBe(10_000);
  });

  async function parkOrder() {
    const ctx = await reachFirstLookupError();
    for (let i = 2; i <= 5; i++) {
      await makeDue(pool, ctx.id);
      expect(await runPasses(pool, ctx.processor)).toEqual([
        i < 5 ? 'reconciliation_retry' : 'parked',
      ]);
    }
    return ctx;
  }

  it('parks the order in payment_unknown at the limit, with no hot loop (criterion 27)', async () => {
    const { id, fake, processor } = await parkOrder();

    const state = await orderState(pool, id);
    expect(state).toMatchObject({
      status: 'payment_unknown',
      reconciliation_attempts: 5,
      charge_attempts: 1,
      inventory_released_at: null,
    });
    expect(state.due_in_ms).toBe(900_000);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK - 2);
    expect(fake.charges).toHaveLength(1);

    const api = buildServer({ pool, logger: silentLogger });
    const res = await api.inject({ method: 'GET', url: `/orders/${id}` });
    await api.close();
    expect(res.json()).toMatchObject({
      status: 'payment_unknown',
      reconciliationAttempts: 5,
      lastError: expect.stringContaining('lookup_unavailable') as string,
      nextAttemptAt: state.next_attempt_at.toISOString(),
    });

    expect(await claimDueOrders(pool, { workerId: 'w', limit: 10 })).toEqual([]);

    await makeDue(pool, id);
    const lookupsBefore = fake.lookups.length;
    expect(await runPasses(pool, processor)).toEqual(['parked']);
    expect(fake.lookups.length - lookupsBefore).toBe(1);
    const again = await orderState(pool, id);
    expect(again).toMatchObject({ status: 'payment_unknown', reconciliation_attempts: 6 });
    expect(again.due_in_ms).toBe(900_000);
    expect(await runPasses(pool, processor)).toEqual([]);
  });

  it('pays a parked order when a later lookup finds an approval, without reserving again (criterion 28)', async () => {
    const { id, fake, processor, counts } = await parkOrder();
    fake.onLookup = () => Promise.resolve(approved('ref-late', true));
    const reservesBefore = counts.reserveInventory;

    await makeDue(pool, id);
    expect(await runPasses(pool, processor)).toEqual(['paid']);

    expect(await orderState(pool, id)).toMatchObject({
      status: 'paid',
      payment_reference: 'ref-late',
      inventory_released_at: null,
    });
    expect(counts.reserveInventory).toBe(reservesBefore);
    expect(counts.incrementChargeAttempt).toBe(0);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK - 2);
    expect(fake.charges).toHaveLength(1);
  });

  it('fails a parked order and releases stock once when the provider records a void (criterion 29)', async () => {
    const { id, fake, processor } = await parkOrder();
    const sim = realSimulator(simulatorPool);
    fake.onLookup = (orderId) => sim.provider.lookupOrVoid(orderId);

    await makeDue(pool, id);
    expect(await runPasses(pool, processor)).toEqual(['failed']);

    const state = await orderState(pool, id);
    expect(state).toMatchObject({ status: 'failed', failure_reason: 'max_attempts_exceeded' });
    expect(state.inventory_released_at).toBeInstanceOf(Date);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK);
    expect(await ledgerRows(pool, id)).toEqual([{ outcome: 'voided', reference: null }]);

    const late = await sim.provider.charge({
      orderId: id,
      amountCents: 3000,
      paymentMethod: 'pm_card_ok',
    });
    expect(late).toEqual({ outcome: 'voided', reference: null, replayed: true });
    expect(await ledgerRows(pool, id)).toEqual([{ outcome: 'voided', reference: null }]);
    expect(await stockOf(pool, SKU)).toBe(INITIAL_STOCK);
  });
});
