import {
  claimDueOrders,
  finalizeFailed,
  finalizePaid,
  recoverExpiredClaims,
  retryLater,
  type ClaimedOrder,
  type PaymentMethod,
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
import { recoveryBackoffMs } from '../src/lifecycle.js';
import { runWorkerLoop } from '../src/loop.js';
import {
  claimOne,
  DEFAULT_LIMITS,
  FakeProvider,
  limits,
  makeWorker,
  realSimulator,
  runPasses,
  silentLogger,
  waitUntil,
} from './support.js';

const pool = createTestPool();
const simulatorPool = createTestPool(undefined, { max: 20 });
afterAll(async () => {
  await pool.end();
  await simulatorPool.end();
});
beforeEach(() => resetDatabase(pool));

const recoverWith = (retryBaseMs: number) =>
  recoverExpiredClaims(pool, {
    claimTimeoutMs: 60_000,
    retryBaseMs,
    retryMaxMs: DEFAULT_LIMITS.retryMaxDelayMs,
    maxReconciliationAttempts: 5,
    paymentUnknownRecheckMs: 900_000,
  });

describe('two workers over 200 mixed orders (criterion 10)', () => {
  it('ends every order terminal with one charge per paid order and consistent stock', async () => {
    const skus = ['SKU-00001', 'SKU-00002', 'SKU-00003', 'SKU-00004'];
    const initial: Record<string, number> = {
      'SKU-00001': 1000,
      'SKU-00002': 1000,
      'SKU-00003': 1000,
      'SKU-00004': 6,
    };
    await insertProducts(
      pool,
      skus.map((sku) => ({ sku, priceCents: 300, stock: initial[sku] ?? 0 })),
    );
    const methods: PaymentMethod[] = [
      'pm_card_ok',
      'pm_card_ok',
      'pm_card_declined',
      'pm_card_unavailable',
    ];
    for (let i = 0; i < 200; i++) {
      const sku = skus[i % skus.length] ?? 'SKU-00001';
      await placeOrder(pool, [{ sku, quantity: 1 + (i % 3) }], methods[i % methods.length]);
    }

    const sim = realSimulator(simulatorPool);
    // Short backoff so unavailable orders exhaust their retries quickly.
    const lim = limits({ retryBaseDelayMs: 1, retryMaxDelayMs: 5 });
    const controllers: AbortController[] = [];
    const loops = ['worker-a', 'worker-b'].map((workerId) => {
      const { processor } = makeWorker(pool, sim.provider, { limits: lim });
      const controller = new AbortController();
      controllers.push(controller);
      return runWorkerLoop<ClaimedOrder>(
        {
          claim: (limit) => claimDueOrders(pool, { workerId, limit }),
          recover: () => Promise.resolve(),
          process: (order) => processor.process(order),
          concurrency: 4,
          claimBatchSize: 4,
          pollIntervalMs: 5,
          logger: silentLogger,
        },
        controller.signal,
      );
    });

    await waitUntil(
      async () => {
        const open = await pool.query(
          `SELECT 1 FROM orders WHERE status NOT IN ('paid', 'failed') LIMIT 1`,
        );
        return open.rowCount === 0;
      },
      'all orders terminal',
      60_000,
    );
    for (const c of controllers) c.abort();
    await Promise.all(loops);

    const paid = await pool.query<{ id: string; payment_reference: string }>(
      `SELECT id, payment_reference FROM orders WHERE status = 'paid'`,
    );
    expect(paid.rowCount).toBeGreaterThan(0);
    for (const order of paid.rows) {
      expect(await ledgerRows(pool, order.id)).toEqual([
        { outcome: 'approved', reference: order.payment_reference },
      ]);
    }
    const approvals = await pool.query(`SELECT 1 FROM payment_charges WHERE outcome = 'approved'`);
    expect(approvals.rowCount).toBe(paid.rowCount);

    const sold = await pool.query<{ sku: string; sold: string }>(
      `SELECT p.sku, coalesce(sum(oi.quantity) FILTER (WHERE o.status = 'paid'), 0) AS sold
         FROM products p
         LEFT JOIN order_items oi ON oi.product_id = p.id
         LEFT JOIN orders o ON o.id = oi.order_id
        GROUP BY p.sku`,
    );
    for (const row of sold.rows) {
      const stock = await stockOf(pool, row.sku);
      expect(stock).toBeGreaterThanOrEqual(0);
      expect(stock).toBe((initial[row.sku] ?? 0) - Number(row.sold));
    }
    const reasons = await pool.query<{ failure_reason: string }>(
      `SELECT DISTINCT failure_reason FROM orders WHERE status = 'failed' ORDER BY 1`,
    );
    expect(reasons.rows.map((r) => r.failure_reason)).toEqual([
      'max_attempts_exceeded',
      'out_of_stock',
      'payment_declined',
    ]);
  }, 90_000);
});

describe('stale claims (criterion 11)', () => {
  beforeEach(() => insertProducts(pool, [{ sku: 'SKU-00001', priceCents: 500, stock: 10 }]));

  it('requeues an expired claim without touching stock or counters, and fences the stale worker', async () => {
    const id = await placeOrder(pool, [{ sku: 'SKU-00001', quantity: 2 }]);
    const fake = new FakeProvider();
    fake.blockCharges();
    const w1 = makeWorker(pool, fake);
    const stale = w1.processor.process(await claimOne(pool, 'w1'));
    await waitUntil(() => fake.charges.length === 1, 'w1 charge started');
    const before = await orderState(pool, id);

    await ageClaim(pool, id);
    expect(await recoverWith(1000)).toEqual([{ id, status: 'pending' }]);
    const recovered = await orderState(pool, id);
    expect(recovered).toMatchObject({
      status: 'pending',
      last_error: 'claim_expired',
      claimed_at: null,
      processing_attempts: before.processing_attempts,
      charge_attempts: before.charge_attempts,
      reconciliation_attempts: 0,
      inventory_released_at: null,
    });
    expect(recovered.due_in_ms).toBe(recoveryBackoffMs(1, DEFAULT_LIMITS));
    expect(await stockOf(pool, 'SKU-00001')).toBe(8);

    await pool.query(`UPDATE orders SET next_attempt_at = now() WHERE id = $1`, [id]);
    const sim = realSimulator(simulatorPool);
    const w2 = makeWorker(pool, sim.provider);
    expect(await runPasses(pool, w2.processor, 'w2')).toEqual(['paid']);

    const fence = { orderId: id, token: 1 };
    expect(await finalizePaid(pool, { ...fence, paymentReference: 'stale' })).toBe(false);
    expect(await retryLater(pool, { ...fence, delayMs: 0, lastError: 'stale' })).toBe(false);
    const client = await pool.connect();
    try {
      expect(await finalizeFailed(client, { ...fence, reason: 'payment_declined' })).toBe(false);
    } finally {
      client.release();
    }
    fake.release(id, { outcome: 'declined', reference: 'stale', replayed: false });
    expect(await stale).toBe('claim_lost');

    expect((await orderState(pool, id)).status).toBe('paid');
    expect(await ledgerRows(pool, id)).toHaveLength(1);
    expect(await stockOf(pool, 'SKU-00001')).toBe(8);
  });

  it('computes the recovery due time in SQL exactly as the worker does', async () => {
    for (const attempts of [1, 2, 3, 5, 8]) {
      await resetDatabase(pool);
      await insertProducts(pool, [{ sku: 'SKU-00001', priceCents: 500, stock: 10 }]);
      const id = await placeOrder(pool, [{ sku: 'SKU-00001', quantity: 1 }]);
      await pool.query('UPDATE orders SET processing_attempts = $2 WHERE id = $1', [
        id,
        attempts - 1,
      ]);
      await claimOne(pool);
      await ageClaim(pool, id);
      await recoverWith(DEFAULT_LIMITS.retryBaseDelayMs);
      expect((await orderState(pool, id)).due_in_ms).toBe(
        recoveryBackoffMs(attempts, DEFAULT_LIMITS),
      );
    }
  });
});

describe('workers racing over the same order (criterion 30)', () => {
  beforeEach(() => insertProducts(pool, [{ sku: 'SKU-00001', priceCents: 500, stock: 10 }]));

  it('lets exactly one of two concurrent recoveries requeue an expired claim', async () => {
    const id = await placeOrder(pool, [{ sku: 'SKU-00001', quantity: 1 }]);
    await claimOne(pool);
    await ageClaim(pool, id);

    const [a, b] = await Promise.all([recoverWith(1000), recoverWith(1000)]);

    expect([...a, ...b]).toEqual([{ id, status: 'pending' }]);
  });

  it('lets exactly one of two concurrent claimers take a due payment_unknown order, with one lookup', async () => {
    const id = await placeOrder(pool, [{ sku: 'SKU-00001', quantity: 1 }]);
    await withoutTransitionTrigger(
      pool,
      `UPDATE orders SET status = 'payment_unknown', reconciliation_attempts = 5,
              processing_attempts = 1, charge_attempts = 1, inventory_reserved_at = now()
        WHERE id = $1`,
      [id],
    );
    const fake = new FakeProvider();
    const [a, b] = await Promise.all([
      runPasses(pool, makeWorker(pool, fake).processor, 'a'),
      runPasses(pool, makeWorker(pool, fake).processor, 'b'),
    ]);
    expect([...a, ...b]).toEqual(['parked']);
    expect(fake.lookups).toEqual([id]);
    expect(fake.charges).toHaveLength(0);
  });
});
