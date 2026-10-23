import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { claimDueOrders } from '../src/index.js';
import {
  createTestPool,
  insertProducts,
  placeOrder,
  resetDatabase,
  withoutTransitionTrigger,
} from './support.js';

/** Criterion 12: the trigger and constraints, exercised with raw SQL. */
describe('order lifecycle trigger and constraints', () => {
  const pool = createTestPool();
  let id: string;

  beforeEach(async () => {
    await resetDatabase(pool);
    await insertProducts(pool, [{ sku: 'SKU-00001', priceCents: 500, stock: 10 }]);
    id = await placeOrder(pool, [{ sku: 'SKU-00001', quantity: 1 }]);
  });
  afterAll(() => pool.end());

  const setState = (sql: string) => withoutTransitionTrigger(pool, sql, [id]);
  const update = (sql: string) => pool.query(sql, [id]);
  const CLEAR = `claimed_by = NULL, claimed_at = NULL`;

  it.each([
    ['paid', 'pending', `status = 'paid', payment_reference = 'r', paid_at = now()`],
    [
      'failed',
      'processing',
      `status = 'failed', failure_reason = 'out_of_stock', failed_at = now()`,
    ],
    ['payment_unknown', 'failed', `status = 'payment_unknown', reconciliation_attempts = 1`],
    ['payment_unknown', 'paid', `status = 'payment_unknown', reconciliation_attempts = 1`],
    ['payment_unknown', 'pending', `status = 'payment_unknown', reconciliation_attempts = 1`],
  ])('rejects %s -> %s', async (_from, to, setup) => {
    await setState(`UPDATE orders SET ${setup} WHERE id = $1`);
    const target: Record<string, string> = {
      pending: `status = 'pending'`,
      processing: `status = 'processing', claimed_by = 'x', claimed_at = now(), failure_reason = NULL, failed_at = NULL`,
      failed: `status = 'failed', failure_reason = 'out_of_stock', failed_at = now()`,
      paid: `status = 'paid', payment_reference = 'r', paid_at = now()`,
    };
    await expect(update(`UPDATE orders SET ${target[to] ?? ''} WHERE id = $1`)).rejects.toThrow(
      /illegal order status transition/,
    );
  });

  it('accepts every lifecycle transition and same-status updates', async () => {
    const claim = async () => {
      const claimed = await claimDueOrders(pool, { workerId: 'w', limit: 1 });
      expect(claimed).toHaveLength(1);
    };
    await update(`UPDATE orders SET next_attempt_at = now() - interval '1 second' WHERE id = $1`);
    await claim(); // pending -> processing
    await update(`UPDATE orders SET status = 'pending', ${CLEAR} WHERE id = $1`);
    await claim();
    await update(
      `UPDATE orders SET status = 'payment_unknown', reconciliation_attempts = 1, ${CLEAR} WHERE id = $1`,
    );
    await update(`UPDATE orders SET next_attempt_at = now() WHERE id = $1`); // same status
    await claim(); // payment_unknown -> processing
    await update(
      `UPDATE orders SET status = 'paid', payment_reference = 'r', paid_at = now(), ${CLEAR} WHERE id = $1`,
    );
    const other = await placeOrder(pool, [{ sku: 'SKU-00001', quantity: 1 }]);
    await claim();
    await pool.query(
      `UPDATE orders SET status = 'failed', failure_reason = 'payment_declined', failed_at = now(), ${CLEAR} WHERE id = $1`,
      [other],
    );
  });

  it.each([
    ['processing without claim columns', `status = 'processing'`, /orders_claim_columns_check/],
    [
      'pending with claim columns',
      `claimed_by = 'x', claimed_at = now()`,
      /orders_claim_columns_check/,
    ],
    [
      'charge attempts without a reservation',
      `charge_attempts = 1, processing_attempts = 1`,
      /orders_charge_requires_reservation_check/,
    ],
    [
      'released inventory on a non-failed order',
      `inventory_reserved_at = now(), inventory_released_at = now()`,
      /orders_inventory_release_check/,
    ],
    [
      'payment_unknown with no lookup errors',
      `status = 'payment_unknown'`,
      /orders_payment_unknown_check/,
    ],
    ['paid without a reference', `status = 'paid', paid_at = now()`, /orders_paid_check/],
    [
      'charge attempts above claims',
      `inventory_reserved_at = now(), charge_attempts = 1`,
      /orders_counters_check/,
    ],
  ])('rejects %s', async (_name, set, constraint) => {
    await expect(setState(`UPDATE orders SET ${set} WHERE id = $1`)).rejects.toThrow(constraint);
  });
});
