import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { claimPendingOrders } from '../src/index.js';
import { createTestPool, insertPendingOrders, resetOrders } from './support.js';

describe('claimPendingOrders', () => {
  const pool = createTestPool();
  beforeEach(() => resetOrders(pool));
  afterAll(() => pool.end());

  it('moves claimed orders to processing and records the claim', async () => {
    const [id] = await insertPendingOrders(pool, 1);

    const claimed = await claimPendingOrders(pool, { workerId: 'w1', limit: 10 });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id,
      status: 'processing',
      claimedBy: 'w1',
      processingAttempts: 1,
      currency: 'USD',
    });
    expect(claimed[0]?.claimedAt).toBeInstanceOf(Date);
    expect(await claimPendingOrders(pool, { workerId: 'w1', limit: 10 })).toEqual([]);
  });

  it('respects the limit and claims oldest orders first', async () => {
    const ids = await insertPendingOrders(pool, 5);
    await pool.query(
      `UPDATE orders SET created_at = now() - make_interval(secs => 100 - total_cents % 100)`,
    );

    const claimed = await claimPendingOrders(pool, { workerId: 'w1', limit: 2 });

    expect(claimed.map((o) => o.id)).toEqual(ids.slice(0, 2));
  });

  it('ignores orders that are not pending', async () => {
    await insertPendingOrders(pool, 3);
    await pool.query(`UPDATE orders SET status = 'paid'`);

    expect(await claimPendingOrders(pool, { workerId: 'w1', limit: 10 })).toEqual([]);
  });

  it('never claims the same order twice across concurrent claimers', async () => {
    const ids = await insertPendingOrders(pool, 100);

    const drain = async (workerId: string): Promise<string[]> => {
      const mine: string[] = [];
      for (;;) {
        const batch = await claimPendingOrders(pool, { workerId, limit: 7 });
        if (batch.length === 0) return mine;
        mine.push(...batch.map((o) => o.id));
      }
    };
    const [a, b] = await Promise.all([drain('worker-a'), drain('worker-b')]);

    const all = [...a, ...b];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(ids));
    const attempts = await pool.query<{ max: number }>(
      'SELECT max(processing_attempts) AS max FROM orders',
    );
    expect(attempts.rows[0]?.max).toBe(1);
  });
});
