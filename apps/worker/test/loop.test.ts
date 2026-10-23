import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createTestPool,
  insertPendingOrders,
  resetOrders,
  UNREACHABLE_DATABASE_URL,
} from '../../../packages/db/test/support.js';
import { runWorkerLoop } from '../src/loop.js';

const logger = pino({ level: 'silent' });

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('runWorkerLoop', () => {
  const pool = createTestPool();
  beforeEach(() => resetOrders(pool));
  afterAll(() => pool.end());

  it('claims pending orders, including more than one batch, then stops on abort', async () => {
    await insertPendingOrders(pool, 5);
    const controller = new AbortController();

    const loop = runWorkerLoop(
      { pool, logger, workerId: 'loop-test', pollIntervalMs: 50, claimBatchSize: 2 },
      controller.signal,
    );
    await waitFor(async () => {
      const r = await pool.query(`SELECT 1 FROM orders WHERE status = 'pending'`);
      return r.rowCount === 0;
    });
    controller.abort();
    await loop;

    const rows = await pool.query<{ status: string; claimed_by: string }>(
      'SELECT DISTINCT status, claimed_by FROM orders',
    );
    expect(rows.rows).toEqual([{ status: 'processing', claimed_by: 'loop-test' }]);
  });

  it('stops promptly during a long poll interval', async () => {
    const controller = new AbortController();
    const loop = runWorkerLoop(
      { pool, logger, workerId: 'idle', pollIntervalMs: 60_000, claimBatchSize: 10 },
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    controller.abort();
    await loop;
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('keeps running when the database is unreachable', async () => {
    const down = createTestPool(UNREACHABLE_DATABASE_URL);
    const controller = new AbortController();
    const loop = runWorkerLoop(
      { pool: down, logger, workerId: 'offline', pollIntervalMs: 20, claimBatchSize: 1 },
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await expect(loop).resolves.toBeUndefined();
    await down.end();
  });
});
