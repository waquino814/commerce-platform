import type { Pool, PoolClient, Queryable } from './pool.js';

export type OrderStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'payment_unknown';
export type PaymentMethod = 'pm_card_ok' | 'pm_card_declined' | 'pm_card_unavailable';
export type FailureReason =
  'out_of_stock' | 'payment_declined' | 'max_attempts_exceeded' | 'invalid_order';

/** An order as returned by a claim. `processingAttempts` is the pass's fencing token. */
export interface ClaimedOrder {
  id: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  paymentMethod: PaymentMethod | null;
  processingAttempts: number;
  chargeAttempts: number;
  reconciliationAttempts: number;
  inventoryReservedAt: Date | null;
  claimedBy: string;
  claimedAt: Date;
  createdAt: Date;
  /** W3C traceparent of the span that created the order, or null (M3b). */
  traceContext: string | null;
}

/** Identifies the claim a write belongs to. Every worker write is fenced by both fields. */
export interface Fence {
  orderId: string;
  token: number;
}

interface ClaimedOrderRow {
  id: string;
  status: OrderStatus;
  total_cents: number;
  currency: string;
  payment_method: PaymentMethod | null;
  processing_attempts: number;
  charge_attempts: number;
  reconciliation_attempts: number;
  inventory_reserved_at: Date | null;
  claimed_by: string;
  claimed_at: Date;
  created_at: Date;
  next_attempt_at: Date;
  trace_context: string | null;
}

const FENCED = `id = $1 AND status = 'processing' AND processing_attempts = $2`;
const CLEAR_CLAIM = `claimed_by = NULL, claimed_at = NULL, updated_at = now()`;

function toClaimedOrder(row: ClaimedOrderRow): ClaimedOrder {
  return {
    id: row.id,
    status: row.status,
    totalCents: row.total_cents,
    currency: row.currency,
    paymentMethod: row.payment_method,
    processingAttempts: row.processing_attempts,
    chargeAttempts: row.charge_attempts,
    reconciliationAttempts: row.reconciliation_attempts,
    inventoryReservedAt: row.inventory_reserved_at,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    traceContext: row.trace_context,
  };
}

/**
 * Atomically claims up to `limit` due orders (`pending` or `payment_unknown`) for `workerId`,
 * oldest due first. The claim increments `processing_attempts`, which becomes the fencing token.
 * `SKIP LOCKED` lets concurrent workers claim disjoint batches without waiting.
 */
export async function claimDueOrders(
  db: Queryable,
  params: { workerId: string; limit: number },
): Promise<ClaimedOrder[]> {
  const result = await db.query<ClaimedOrderRow>(
    `UPDATE orders
        SET status = 'processing',
            claimed_by = $1,
            claimed_at = now(),
            processing_attempts = processing_attempts + 1,
            updated_at = now()
      WHERE id IN (
              SELECT id
                FROM orders
               WHERE status IN ('pending', 'payment_unknown')
                 AND next_attempt_at <= now()
               ORDER BY next_attempt_at, created_at
               LIMIT $2
                 FOR UPDATE SKIP LOCKED
            )
  RETURNING id, status, total_cents, currency, payment_method, processing_attempts,
            charge_attempts, reconciliation_attempts, inventory_reserved_at,
            claimed_by, claimed_at, created_at, next_attempt_at, trace_context`,
    [params.workerId, params.limit],
  );
  // RETURNING does not preserve the subquery's order. Dispatch oldest-due first, deterministically.
  return result.rows
    .sort(
      (a, b) =>
        a.next_attempt_at.getTime() - b.next_attempt_at.getTime() ||
        a.created_at.getTime() - b.created_at.getTime() ||
        a.id.localeCompare(b.id),
    )
    .map(toClaimedOrder);
}

export type ReservationResult =
  { kind: 'reserved'; chargeAttempts: number } | { kind: 'out_of_stock' } | { kind: 'claim_lost' };

/**
 * Reserves stock for every item of a claimed, not yet reserved order, and records the first
 * charge attempt in the same commit. Six statements whatever the item count:
 * BEGIN, lock order (fenced), lock products in SKU order, decrement all, marker + charge
 * increment, COMMIT. If any item is short, everything rolls back and a fenced update on the
 * same connection fails the order with `out_of_stock`.
 */
export async function reserveInventory(
  client: PoolClient,
  fence: Fence,
): Promise<ReservationResult> {
  const args = [fence.orderId, fence.token];
  await client.query('BEGIN');
  try {
    const order = await client.query(
      `SELECT id FROM orders WHERE ${FENCED} AND inventory_reserved_at IS NULL FOR UPDATE`,
      args,
    );
    if (order.rowCount === 0) {
      await client.query('ROLLBACK');
      return { kind: 'claim_lost' };
    }
    const locked = await client.query(
      `SELECT p.id
         FROM products p
         JOIN order_items oi ON oi.product_id = p.id
        WHERE oi.order_id = $1
        ORDER BY p.sku
          FOR UPDATE OF p`,
      [fence.orderId],
    );
    const decremented = await client.query(
      `UPDATE products p
          SET stock_available = p.stock_available - oi.quantity, updated_at = now()
         FROM order_items oi
        WHERE oi.order_id = $1 AND oi.product_id = p.id AND p.stock_available >= oi.quantity`,
      [fence.orderId],
    );
    if ((decremented.rowCount ?? 0) < (locked.rowCount ?? 0)) {
      await client.query('ROLLBACK');
      const failed = await client.query(
        `UPDATE orders
            SET status = 'failed', failure_reason = 'out_of_stock', failed_at = now(), ${CLEAR_CLAIM}
          WHERE ${FENCED}`,
        args,
      );
      return failed.rowCount === 0 ? { kind: 'claim_lost' } : { kind: 'out_of_stock' };
    }
    const marked = await client.query<{ charge_attempts: number }>(
      `UPDATE orders
          SET inventory_reserved_at = now(), charge_attempts = charge_attempts + 1, updated_at = now()
        WHERE ${FENCED}
        RETURNING charge_attempts`,
      args,
    );
    await client.query('COMMIT');
    const row = marked.rows[0];
    if (!row) return { kind: 'claim_lost' };
    return { kind: 'reserved', chargeAttempts: row.charge_attempts };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/**
 * Records a charge attempt before a `charge` call when the reservation already exists.
 * Returns the new count, or null when the claim was lost or the budget is spent.
 */
export async function incrementChargeAttempt(
  db: Queryable,
  fence: Fence & { maxChargeAttempts: number },
): Promise<number | null> {
  const result = await db.query<{ charge_attempts: number }>(
    `UPDATE orders
        SET charge_attempts = charge_attempts + 1, updated_at = now()
      WHERE ${FENCED} AND charge_attempts < $3 AND inventory_reserved_at IS NOT NULL
      RETURNING charge_attempts`,
    [fence.orderId, fence.token, fence.maxChargeAttempts],
  );
  return result.rows[0]?.charge_attempts ?? null;
}

/** Fenced `processing -> paid`. Returns false when the claim was lost. */
export async function finalizePaid(
  db: Queryable,
  fence: Fence & { paymentReference: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE orders
        SET status = 'paid', payment_reference = $3, paid_at = now(), ${CLEAR_CLAIM}
      WHERE ${FENCED}`,
    [fence.orderId, fence.token, fence.paymentReference],
  );
  return result.rowCount === 1;
}

/**
 * Fenced `processing -> failed`, releasing reserved inventory in the same transaction.
 * Four statements: BEGIN, fenced update, release, COMMIT. The release locks product rows in
 * SKU order inside one statement, matching the reservation's lock order to avoid deadlocks.
 * Inventory is released only if this update matched, the order was reserved, and it was not
 * released before. Returns false when the claim was lost.
 */
export async function finalizeFailed(
  client: PoolClient,
  fence: Fence & { reason: Exclude<FailureReason, 'invalid_order'> },
): Promise<boolean> {
  await client.query('BEGIN');
  try {
    const updated = await client.query<{ release: boolean }>(
      `UPDATE orders
          SET status = 'failed', failure_reason = $3, failed_at = now(),
              inventory_released_at = CASE WHEN inventory_reserved_at IS NOT NULL
                                           AND inventory_released_at IS NULL
                                           THEN now() END,
              ${CLEAR_CLAIM}
        WHERE ${FENCED}
        RETURNING inventory_released_at IS NOT NULL AS release`,
      [fence.orderId, fence.token, fence.reason],
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return false;
    }
    if (row.release) {
      await client.query(
        `WITH locked AS (
           SELECT p.id, oi.quantity
             FROM products p
             JOIN order_items oi ON oi.product_id = p.id
            WHERE oi.order_id = $1
            ORDER BY p.sku
              FOR UPDATE OF p
         )
         UPDATE products p
            SET stock_available = p.stock_available + locked.quantity, updated_at = now()
           FROM locked
          WHERE p.id = locked.id`,
        [fence.orderId],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Fenced `processing -> pending` after a charge error with budget left. Keeps the reservation. */
export async function retryLater(
  db: Queryable,
  fence: Fence & { delayMs: number; lastError: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE orders
        SET status = 'pending', next_attempt_at = now() + $3 * interval '1 millisecond',
            last_error = $4, ${CLEAR_CLAIM}
      WHERE ${FENCED}`,
    [fence.orderId, fence.token, fence.delayMs, fence.lastError],
  );
  return result.rowCount === 1;
}

/**
 * Fenced record of a `lookupOrVoid` error: increments `reconciliation_attempts` and moves the
 * order to `pending` (below the limit) or `payment_unknown` (parked). Never releases inventory.
 */
export async function recordLookupError(
  db: Queryable,
  fence: Fence & { parked: boolean; delayMs: number; lastError: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE orders
        SET reconciliation_attempts = reconciliation_attempts + 1,
            status = CASE WHEN $3::boolean THEN 'payment_unknown' ELSE 'pending' END,
            next_attempt_at = now() + $4 * interval '1 millisecond',
            last_error = $5, ${CLEAR_CLAIM}
      WHERE ${FENCED}`,
    [fence.orderId, fence.token, fence.parked, fence.delayMs, fence.lastError],
  );
  return result.rowCount === 1;
}

export interface RequeuePolicy {
  /** Orders with at least this many lookup errors are parked in `payment_unknown`. */
  maxReconciliationAttempts: number;
  paymentUnknownRecheckMs: number;
}

export interface RecoveredClaim {
  id: string;
  status: OrderStatus;
  processingAttempts: number;
  /** W3C traceparent of the order's creation span, or null. */
  traceContext: string | null;
}

/**
 * Returns expired claims to `pending`, or to `payment_unknown` for parked orders. Holds no token:
 * one statement re-checks expiry under `SKIP LOCKED`. Never touches counters or inventory.
 * The pending due time mirrors the worker's recovery backoff:
 * `min(retryBaseMs * 2^(processing_attempts - 1), retryMaxMs)`.
 * Also returns each order's attempt count and creation trace context, for recovery tracing.
 */
export async function recoverExpiredClaimsWithContext(
  db: Queryable,
  params: RequeuePolicy & { claimTimeoutMs: number; retryBaseMs: number; retryMaxMs: number },
): Promise<RecoveredClaim[]> {
  const result = await db.query<{
    id: string;
    status: OrderStatus;
    processing_attempts: number;
    trace_context: string | null;
  }>(
    `UPDATE orders o
        SET status = CASE WHEN o.reconciliation_attempts >= $2 THEN 'payment_unknown' ELSE 'pending' END,
            next_attempt_at = now() + interval '1 millisecond' *
              CASE WHEN o.reconciliation_attempts >= $2 THEN $3::double precision
                   ELSE LEAST($4::double precision * power(2, o.processing_attempts - 1),
                              $5::double precision) END,
            last_error = 'claim_expired',
            claimed_by = NULL, claimed_at = NULL, updated_at = now()
      WHERE o.id IN (
              SELECT id FROM orders
               WHERE status = 'processing'
                 AND claimed_at < now() - $1 * interval '1 millisecond'
                 FOR UPDATE SKIP LOCKED
            )
  RETURNING o.id, o.status, o.processing_attempts, o.trace_context`,
    [
      params.claimTimeoutMs,
      params.maxReconciliationAttempts,
      params.paymentUnknownRecheckMs,
      params.retryBaseMs,
      params.retryMaxMs,
    ],
  );
  return result.rows.map((r) => ({
    id: r.id,
    status: r.status,
    processingAttempts: r.processing_attempts,
    traceContext: r.trace_context,
  }));
}

/**
 * M2 contract, unchanged: the same recovery, returning only `{ id, status }` per order.
 * See recoverExpiredClaimsWithContext for the statement and its guarantees.
 */
export async function recoverExpiredClaims(
  db: Queryable,
  params: RequeuePolicy & { claimTimeoutMs: number; retryBaseMs: number; retryMaxMs: number },
): Promise<{ id: string; status: OrderStatus }[]> {
  const recovered = await recoverExpiredClaimsWithContext(db, params);
  return recovered.map(({ id, status }) => ({ id, status }));
}

/**
 * Shutdown release: hands unfinished claims back. Fenced by `(id, token)` and `processing`,
 * and skips rows whose lock is held instead of waiting. Runs with a 500 ms statement timeout.
 * Returns the ids actually released. Never touches counters or inventory.
 */
export async function releaseClaims(
  client: PoolClient,
  params: RequeuePolicy & { claims: Fence[]; statementTimeoutMs: number },
): Promise<string[]> {
  if (params.claims.length === 0) return [];
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
      String(params.statementTimeoutMs),
    ]);
    const result = await client.query<{ id: string }>(
      `UPDATE orders o
          SET status = CASE WHEN o.reconciliation_attempts >= $3 THEN 'payment_unknown' ELSE 'pending' END,
              next_attempt_at = CASE WHEN o.reconciliation_attempts >= $3
                                     THEN now() + $4 * interval '1 millisecond'
                                     ELSE now() END,
              last_error = 'released_on_shutdown',
              claimed_by = NULL, claimed_at = NULL, updated_at = now()
        WHERE o.id IN (
                SELECT id FROM orders
                 WHERE (id, processing_attempts) IN (SELECT * FROM unnest($1::uuid[], $2::int[]))
                   AND status = 'processing'
                   FOR UPDATE SKIP LOCKED
              )
    RETURNING o.id`,
      [
        params.claims.map((c) => c.orderId),
        params.claims.map((c) => c.token),
        params.maxReconciliationAttempts,
        params.paymentUnknownRecheckMs,
      ],
    );
    await client.query('COMMIT');
    return result.rows.map((r) => r.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Returns the claims from `claims` that are still `processing` with the same token. */
export async function stillHeldClaims(db: Queryable, claims: Fence[]): Promise<string[]> {
  if (claims.length === 0) return [];
  const result = await db.query<{ id: string }>(
    `SELECT id FROM orders
      WHERE (id, processing_attempts) IN (SELECT * FROM unnest($1::uuid[], $2::int[]))
        AND status = 'processing'`,
    [claims.map((c) => c.orderId), claims.map((c) => c.token)],
  );
  return result.rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------------------------
// Orders API: creation and retrieval.

export interface OrderItemView {
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface OrderView {
  id: string;
  status: OrderStatus;
  currency: string;
  totalCents: number;
  items: OrderItemView[];
  paymentMethod: PaymentMethod | null;
  paymentReference: string | null;
  processingAttempts: number;
  chargeAttempts: number;
  reconciliationAttempts: number;
  failureReason: FailureReason | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  paidAt: Date | null;
  failedAt: Date | null;
}

interface OrderRow {
  id: string;
  status: OrderStatus;
  currency: string;
  total_cents: number;
  payment_method: PaymentMethod | null;
  payment_reference: string | null;
  processing_attempts: number;
  charge_attempts: number;
  reconciliation_attempts: number;
  failure_reason: FailureReason | null;
  last_error: string | null;
  next_attempt_at: Date;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
  failed_at: Date | null;
  request_hash: string | null;
}

/** Reads one order with its items, or null. */
export async function getOrder(db: Queryable, orderId: string): Promise<OrderView | null> {
  const orders = await db.query<OrderRow>(
    `SELECT id, status, currency, total_cents, payment_method, payment_reference,
            processing_attempts, charge_attempts, reconciliation_attempts, failure_reason,
            last_error, next_attempt_at, created_at, updated_at, paid_at, failed_at, request_hash
       FROM orders WHERE id = $1`,
    [orderId],
  );
  const row = orders.rows[0];
  if (!row) return null;
  const items = await db.query<{
    sku: string;
    name: string;
    quantity: number;
    unit_price_cents: number;
  }>(
    `SELECT p.sku, p.name, oi.quantity, oi.unit_price_cents
       FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY p.sku`,
    [orderId],
  );
  const due = row.status === 'pending' || row.status === 'payment_unknown';
  return {
    id: row.id,
    status: row.status,
    currency: row.currency,
    totalCents: row.total_cents,
    items: items.rows.map((i) => ({
      sku: i.sku,
      name: i.name,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      lineTotalCents: i.quantity * i.unit_price_cents,
    })),
    paymentMethod: row.payment_method,
    paymentReference: row.payment_reference,
    processingAttempts: row.processing_attempts,
    chargeAttempts: row.charge_attempts,
    reconciliationAttempts: row.reconciliation_attempts,
    failureReason: row.failure_reason,
    lastError: row.last_error,
    nextAttemptAt: due ? row.next_attempt_at : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    failedAt: row.failed_at,
  };
}

/** One line of an order-history preview. */
export interface OrderItemPreview {
  sku: string;
  name: string;
  quantity: number;
}

/** One row of the order history: the order with item counts and a short item preview. */
export interface OrderSummaryView {
  id: string;
  status: OrderStatus;
  currency: string;
  totalCents: number;
  /** Distinct SKUs in the order. */
  itemCount: number;
  /** Units across all items. */
  totalQuantity: number;
  /** The first ORDER_PREVIEW_ITEMS lines by SKU; `itemCount` says how many there are in all. */
  items: OrderItemPreview[];
  failureReason: FailureReason | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ORDER_PREVIEW_ITEMS = 3;

export interface ListOrdersParams {
  limit: number;
  after: string | null;
  /** Only orders in this status. */
  status?: OrderStatus | null;
  /**
   * Case-insensitive search: an order-ID prefix, or part of any item's SKU or product name.
   * LIKE wildcards in it are matched literally.
   */
  query?: string | null;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

/**
 * Keyset pagination over all orders, newest first, ordered by (created_at, id), optionally
 * filtered. The cursor is the last order's ID; filters apply before the page is cut, so a cursor
 * from one filter is still a valid position under another. Returns null when the cursor names no
 * order, so the caller can reject it.
 */
export async function listOrders(
  db: Queryable,
  params: ListOrdersParams,
): Promise<{ items: OrderSummaryView[]; nextCursor: string | null } | null> {
  if (params.after !== null) {
    const cursor = await db.query('SELECT 1 FROM orders WHERE id = $1', [params.after]);
    if (cursor.rowCount === 0) return null;
  }
  const query = params.query?.trim() ? params.query.trim() : null;
  const result = await db.query<{
    id: string;
    status: OrderStatus;
    currency: string;
    total_cents: number;
    item_count: number;
    total_quantity: number;
    preview: OrderItemPreview[];
    failure_reason: FailureReason | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT o.id, o.status, o.currency, o.total_cents, o.failure_reason, o.created_at,
            o.updated_at, i.item_count, i.total_quantity, pv.preview
       FROM orders o
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS item_count, coalesce(sum(quantity), 0)::int AS total_quantity
           FROM order_items WHERE order_id = o.id
       ) i
       CROSS JOIN LATERAL (
         SELECT coalesce(json_agg(x ORDER BY x.sku), '[]'::json) AS preview
           FROM (SELECT p.sku, p.name, oi.quantity
                   FROM order_items oi JOIN products p ON p.id = oi.product_id
                  WHERE oi.order_id = o.id
                  ORDER BY p.sku
                  LIMIT $6) x
       ) pv
      WHERE ($1::uuid IS NULL
             OR (o.created_at, o.id) < (SELECT created_at, id FROM orders WHERE id = $1))
        AND ($3::text IS NULL OR o.status = $3)
        AND ($4::text IS NULL
             OR o.id::text LIKE $5 ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id
                         WHERE oi.order_id = o.id
                           AND (p.sku ILIKE $4 ESCAPE '\\' OR p.name ILIKE $4 ESCAPE '\\')))
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $2`,
    [
      params.after,
      params.limit + 1,
      params.status ?? null,
      query === null ? null : `%${escapeLike(query)}%`,
      query === null ? null : `${escapeLike(query.toLowerCase())}%`,
      ORDER_PREVIEW_ITEMS,
    ],
  );
  const rows = result.rows.slice(0, params.limit);
  const hasMore = result.rows.length > params.limit;
  return {
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      currency: r.currency,
      totalCents: r.total_cents,
      itemCount: r.item_count,
      totalQuantity: r.total_quantity,
      items: r.preview,
      failureReason: r.failure_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
  };
}

export interface PricedProduct {
  id: string;
  sku: string;
  priceCents: number;
  currency: string;
}

export interface OrderLine {
  productId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface NewOrder {
  items: { sku: string; quantity: number }[];
  paymentMethod: PaymentMethod;
  idempotencyKey: string | null;
  requestHash: string;
  /** W3C traceparent of the creating span (M3b). Stored only when a new order is inserted. */
  traceContext?: string | null;
}

export type CreateOrderResult =
  | { kind: 'created'; order: OrderView }
  | { kind: 'replayed'; order: OrderView }
  | { kind: 'idempotency_conflict' }
  | { kind: 'unknown_products'; skus: string[] };

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION &&
    (err as { constraint?: unknown }).constraint === constraint
  );
}

async function findByIdempotencyKey(
  db: Queryable,
  key: string,
): Promise<{ id: string; requestHash: string | null } | null> {
  const result = await db.query<{ id: string; request_hash: string | null }>(
    'SELECT id, request_hash FROM orders WHERE idempotency_key = $1',
    [key],
  );
  const row = result.rows[0];
  return row ? { id: row.id, requestHash: row.request_hash } : null;
}

async function replayOrConflict(
  db: Queryable,
  existing: { id: string; requestHash: string | null },
  requestHash: string,
): Promise<CreateOrderResult> {
  if (existing.requestHash !== requestHash) return { kind: 'idempotency_conflict' };
  const order = await getOrder(db, existing.id);
  if (!order) throw new Error(`order ${existing.id} vanished during idempotent replay`);
  return { kind: 'replayed', order };
}

/**
 * Creates a `pending` order and its items in one transaction, reading prices in that same
 * transaction. `price` is the caller's pure pricing function. Stock is not checked here.
 * An `Idempotency-Key` replays the original order for the same request, and conflicts otherwise;
 * a concurrent duplicate is resolved through the unique constraint.
 */
export async function createOrder(
  pool: Pool,
  input: NewOrder,
  price: (lines: OrderLine[]) => number,
): Promise<CreateOrderResult> {
  if (input.idempotencyKey !== null) {
    const existing = await findByIdempotencyKey(pool, input.idempotencyKey);
    if (existing) return replayOrConflict(pool, existing, input.requestHash);
  }

  const client = await pool.connect();
  let orderId: string;
  try {
    await client.query('BEGIN');
    const skus = input.items.map((i) => i.sku);
    const products = await client.query<{
      id: string;
      sku: string;
      price_cents: number;
      currency: string;
    }>('SELECT id, sku, price_cents, currency FROM products WHERE sku = ANY($1::text[])', [skus]);
    const bySku = new Map(products.rows.map((p) => [p.sku, p]));
    const unknown = skus.filter((s) => !bySku.has(s));
    if (unknown.length > 0) {
      await client.query('ROLLBACK');
      return { kind: 'unknown_products', skus: unknown };
    }
    const lines: OrderLine[] = input.items.map((item) => {
      const product = bySku.get(item.sku);
      if (!product) throw new Error(`unreachable: ${item.sku} checked above`);
      return {
        productId: product.id,
        quantity: item.quantity,
        unitPriceCents: product.price_cents,
      };
    });
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO orders (total_cents, currency, payment_method, idempotency_key, request_hash,
                           trace_context)
       VALUES ($1, 'USD', $2, $3, $4, $5)
       RETURNING id`,
      [
        price(lines),
        input.paymentMethod,
        input.idempotencyKey,
        input.requestHash,
        input.traceContext ?? null,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('order insert returned no id');
    orderId = id;
    await client.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
       SELECT $1, * FROM unnest($2::uuid[], $3::int[], $4::int[])`,
      [
        orderId,
        lines.map((l) => l.productId),
        lines.map((l) => l.quantity),
        lines.map((l) => l.unitPriceCents),
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (input.idempotencyKey !== null && isUniqueViolation(err, 'orders_idempotency_key_key')) {
      const existing = await findByIdempotencyKey(pool, input.idempotencyKey);
      if (existing) return await replayOrConflict(pool, existing, input.requestHash);
    }
    throw err;
  } finally {
    client.release();
  }

  const order = await getOrder(pool, orderId);
  if (!order) throw new Error(`order ${orderId} not found after insert`);
  return { kind: 'created', order };
}

/**
 * Counts orders by status for the worker's order-status sampler (M3c). Every status is present,
 * with 0 for statuses that have no orders. Read-only; it takes no locks beyond a plain read.
 */
export async function countOrdersByStatus(db: Queryable): Promise<Record<OrderStatus, number>> {
  const result = await db.query<{ status: OrderStatus; count: string }>(
    'SELECT status, count(*) AS count FROM orders GROUP BY status',
  );
  const counts: Record<OrderStatus, number> = {
    pending: 0,
    processing: 0,
    paid: 0,
    failed: 0,
    payment_unknown: 0,
  };
  for (const row of result.rows) counts[row.status] = Number(row.count);
  return counts;
}

/**
 * The SKUs in an order, sorted. Read-only; used by the M5 poison-order fault, only while that
 * scenario is active.
 */
export async function listOrderSkus(db: Queryable, orderId: string): Promise<string[]> {
  const result = await db.query<{ sku: string }>(
    `SELECT p.sku
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY p.sku`,
    [orderId],
  );
  return result.rows.map((r) => r.sku);
}
