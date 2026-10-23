import type { Pool } from './pool.js';

export type OrderStatus = 'pending' | 'processing' | 'paid' | 'failed';

export interface ClaimedOrder {
  id: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  processingAttempts: number;
  claimedBy: string;
  claimedAt: Date;
  createdAt: Date;
}

interface ClaimedOrderRow {
  id: string;
  status: OrderStatus;
  total_cents: number;
  currency: string;
  processing_attempts: number;
  claimed_by: string;
  claimed_at: Date;
  created_at: Date;
}

/**
 * Atomically claims up to `limit` of the oldest pending orders for `workerId`, moving them to
 * `processing`. `SKIP LOCKED` lets concurrent workers claim disjoint batches without waiting.
 */
export async function claimPendingOrders(
  pool: Pool,
  params: { workerId: string; limit: number },
): Promise<ClaimedOrder[]> {
  const result = await pool.query<ClaimedOrderRow>(
    `UPDATE orders
        SET status = 'processing',
            claimed_by = $1,
            claimed_at = now(),
            processing_attempts = processing_attempts + 1,
            updated_at = now()
      WHERE id IN (
              SELECT id
                FROM orders
               WHERE status = 'pending'
               ORDER BY created_at
               LIMIT $2
                 FOR UPDATE SKIP LOCKED
            )
  RETURNING id, status, total_cents, currency, processing_attempts,
            claimed_by, claimed_at, created_at`,
    [params.workerId, params.limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    totalCents: row.total_cents,
    currency: row.currency,
    processingAttempts: row.processing_attempts,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
  }));
}
