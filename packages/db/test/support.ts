import { createOrder, createPool, type PaymentMethod, type Pool } from '../src/index.js';

export const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  return url;
}

export function createTestPool(
  url: string = testDatabaseUrl(),
  options: { max?: number; statementTimeoutMillis?: number } = {},
): Pool {
  return createPool(
    { connectionString: url, connectionTimeoutMillis: 1000, ...options },
    () => undefined,
  );
}

/** Empties every M2 table. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE payment_charges, order_items, orders, products');
}

/** M1 helper name, kept for the M1 tests. */
export const resetOrders = resetDatabase;

/** Inserts bare pending orders without items, as the M1 tests did. */
export async function insertPendingOrders(pool: Pool, count: number): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO orders (total_cents, currency)
     SELECT 1000 + n, 'USD' FROM generate_series(1, $1) AS n
     RETURNING id`,
    [count],
  );
  return result.rows.map((r) => r.id);
}

export interface TestProduct {
  sku: string;
  priceCents: number;
  stock: number;
}

export async function insertProducts(pool: Pool, products: TestProduct[]): Promise<void> {
  await pool.query(
    `INSERT INTO products (sku, name, price_cents, stock_available)
     SELECT sku, 'Test ' || sku, price, stock
       FROM unnest($1::text[], $2::int[], $3::int[]) AS t(sku, price, stock)`,
    [products.map((p) => p.sku), products.map((p) => p.priceCents), products.map((p) => p.stock)],
  );
}

/** Creates a pending order through the same data-access path the API uses. */
export async function placeOrder(
  pool: Pool,
  items: { sku: string; quantity: number }[],
  paymentMethod: PaymentMethod = 'pm_card_ok',
): Promise<string> {
  const result = await createOrder(
    pool,
    { items, paymentMethod, idempotencyKey: null, requestHash: 'test' },
    (lines) => lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0),
  );
  if (result.kind !== 'created') throw new Error(`placeOrder failed: ${result.kind}`);
  return result.order.id;
}

export async function stockOf(pool: Pool, sku: string): Promise<number> {
  const result = await pool.query<{ stock_available: number }>(
    'SELECT stock_available FROM products WHERE sku = $1',
    [sku],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no product ${sku}`);
  return row.stock_available;
}

export interface OrderRowState {
  status: string;
  processing_attempts: number;
  charge_attempts: number;
  reconciliation_attempts: number;
  claimed_by: string | null;
  claimed_at: Date | null;
  inventory_reserved_at: Date | null;
  inventory_released_at: Date | null;
  failure_reason: string | null;
  payment_reference: string | null;
  last_error: string | null;
  next_attempt_at: Date;
  updated_at: Date;
  /** next_attempt_at - updated_at in milliseconds, computed in SQL. */
  due_in_ms: number;
}

export async function orderState(pool: Pool, id: string): Promise<OrderRowState> {
  const result = await pool.query<OrderRowState>(
    `SELECT status, processing_attempts, charge_attempts, reconciliation_attempts, claimed_by,
            claimed_at, inventory_reserved_at, inventory_released_at, failure_reason,
            payment_reference, last_error, next_attempt_at, updated_at,
            (extract(epoch FROM next_attempt_at - updated_at) * 1000)::float8 AS due_in_ms
       FROM orders WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no order ${id}`);
  return row;
}

export async function ledgerRows(
  pool: Pool,
  orderId: string,
): Promise<{ outcome: string; reference: string | null }[]> {
  const result = await pool.query<{ outcome: string; reference: string | null }>(
    'SELECT outcome, reference FROM payment_charges WHERE order_id = $1',
    [orderId],
  );
  return result.rows;
}

/** Moves a claim into the past, so recovery treats it as expired. No waiting involved. */
export async function ageClaim(pool: Pool, orderId: string): Promise<void> {
  await pool.query(`UPDATE orders SET claimed_at = claimed_at - interval '1 hour' WHERE id = $1`, [
    orderId,
  ]);
}

/** Makes a pending or parked order due now. A same-status update, allowed by the trigger. */
export async function makeDue(pool: Pool, orderId: string): Promise<void> {
  await pool.query(`UPDATE orders SET next_attempt_at = now() WHERE id = $1`, [orderId]);
}

/**
 * Runs SQL with the transition trigger skipped (session_replication_role = replica), for test
 * setup that needs a state the lifecycle cannot reach directly. Constraints still apply.
 */
export async function withoutTransitionTrigger(pool: Pool, sql: string, args: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(sql, args);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
