import type { Pool, PoolClient } from '@commerce/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, ledgerRows, resetDatabase } from '../../../packages/db/test/support.js';
import { ProviderError, type ProviderResult } from '../src/payment/provider.js';
import { createPaymentSimulator, LEDGER_LOCK_NAMESPACE } from '../src/payment/simulator.js';
import { captureLogger, silentLogger, waitUntil } from './support.js';

const ORDER = '11111111-1111-4111-8111-111111111111';

const pool = createTestPool();
const simulatorPool = createTestPool();
afterAll(async () => {
  await pool.end();
  await simulatorPool.end();
});
beforeEach(() => resetDatabase(pool));

/** Holds the per-order ledger lock in its own transaction, as the simulator would. */
async function holdLedgerLock(orderId: string): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
    LEDGER_LOCK_NAMESPACE,
    orderId,
  ]);
  return client;
}

async function waitingOnLedgerLock(db: Pool): Promise<number> {
  const result = await db.query<{ waiting: string }>(
    `SELECT count(*) AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND classid = $1::oid AND objsubid = 2`,
    [LEDGER_LOCK_NAMESPACE],
  );
  return Number(result.rows[0]?.waiting ?? 0);
}

const charge = (sim: ReturnType<typeof createPaymentSimulator>, method = 'pm_card_ok' as const) =>
  sim.charge({ orderId: ORDER, amountCents: 2500, paymentMethod: method });

describe('ledger serialization (criterion 32)', () => {
  const sim = createPaymentSimulator({ pool: simulatorPool, logger: silentLogger, latencyMs: 0 });

  async function race(first: () => Promise<ProviderResult>, second: () => Promise<ProviderResult>) {
    const holder = await holdLedgerLock(ORDER);
    const a = first();
    await waitUntil(async () => (await waitingOnLedgerLock(pool)) === 1, 'first waiter queued');
    const b = second();
    await waitUntil(async () => (await waitingOnLedgerLock(pool)) === 2, 'second waiter queued');
    await holder.query('ROLLBACK');
    holder.release();
    return Promise.all([a, b]);
  }

  async function laterCallsReturn(expected: ProviderResult['outcome']): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const result = i % 2 === 0 ? await charge(sim) : await sim.lookupOrVoid(ORDER);
      expect(result).toMatchObject({ outcome: expected, replayed: true });
    }
    expect(await ledgerRows(pool, ORDER)).toHaveLength(1);
  }

  it('charge first: the charge is recorded and the void returns it', async () => {
    const [charged, looked] = await race(
      () => charge(sim),
      () => sim.lookupOrVoid(ORDER),
    );

    expect(charged).toMatchObject({ outcome: 'approved', replayed: false });
    expect(looked).toEqual({ ...charged, replayed: true });
    expect(await ledgerRows(pool, ORDER)).toEqual([
      { outcome: 'approved', reference: charged.reference },
    ]);
    await laterCallsReturn('approved');
  });

  it('void first: the void is recorded and the charge never inserts', async () => {
    const [voided, charged] = await race(
      () => sim.lookupOrVoid(ORDER),
      () => charge(sim),
    );

    expect(voided).toEqual({ outcome: 'voided', reference: null, replayed: false });
    expect(charged).toEqual({ outcome: 'voided', reference: null, replayed: true });
    expect(await ledgerRows(pool, ORDER)).toEqual([{ outcome: 'voided', reference: null }]);
    await laterCallsReturn('voided');
  });

  it('keeps one row under many concurrent mixed calls', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? sim.lookupOrVoid(ORDER) : charge(sim))),
    );
    const rows = await ledgerRows(pool, ORDER);
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((r) => r.outcome))).toEqual(new Set([rows[0]?.outcome]));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
});

describe('repeated, unavailable, and duplicate requests (criterion 33)', () => {
  it('replays the stored outcome for sequential repeats', async () => {
    const sim = createPaymentSimulator({ pool: simulatorPool, logger: silentLogger, latencyMs: 0 });
    const first = await charge(sim);
    const second = await charge(sim);
    const declinedAttempt = await sim.charge({
      orderId: ORDER,
      amountCents: 2500,
      paymentMethod: 'pm_card_declined',
    });
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ ...first, replayed: true });
    expect(declinedAttempt).toEqual({ ...first, replayed: true });
    expect(await ledgerRows(pool, ORDER)).toHaveLength(1);
  });

  it('records nothing for pm_card_unavailable and returns the same error each time', async () => {
    const sim = createPaymentSimulator({ pool: simulatorPool, logger: silentLogger, latencyMs: 0 });
    for (let i = 0; i < 3; i++) {
      await expect(charge(sim, 'pm_card_unavailable' as 'pm_card_ok')).rejects.toEqual(
        new ProviderError('provider_unavailable'),
      );
    }
    expect(await ledgerRows(pool, ORDER)).toEqual([]);
  });

  it('logs an amount mismatch on replay and returns the stored outcome', async () => {
    const { logger, lines } = captureLogger();
    const sim = createPaymentSimulator({ pool: simulatorPool, logger, latencyMs: 0 });
    const first = await charge(sim);
    const replay = await sim.charge({
      orderId: ORDER,
      amountCents: 1,
      paymentMethod: 'pm_card_ok',
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(lines.some((l) => l.msg === 'amount_mismatch')).toBe(true);
  });

  it('survives a duplicate written without the lock, and logs the bypass', async () => {
    const { logger, lines } = captureLogger();
    const sim = createPaymentSimulator({
      pool: simulatorPool,
      logger,
      latencyMs: 0,
      // While the simulator holds the lock, a bug writes the ledger directly.
      simulateLatency: async (orderId) => {
        await pool.query(
          `INSERT INTO payment_charges (order_id, outcome, reference, amount_cents)
           VALUES ($1, 'declined', 'rogue', 2500)`,
          [orderId],
        );
      },
    });

    const result = await charge(sim);

    expect(result).toEqual({ outcome: 'declined', reference: 'rogue', replayed: true });
    expect(await ledgerRows(pool, ORDER)).toEqual([{ outcome: 'declined', reference: 'rogue' }]);
    expect(lines.some((l) => l.msg === 'ledger_lock_bypassed')).toBe(true);
  });

  it('rejects a second ledger row at the database level', async () => {
    await pool.query(
      `INSERT INTO payment_charges (order_id, outcome, reference, amount_cents) VALUES ($1, 'approved', 'a', 1)`,
      [ORDER],
    );
    await expect(
      pool.query(
        `INSERT INTO payment_charges (order_id, outcome, reference, amount_cents) VALUES ($1, 'approved', 'b', 1)`,
        [ORDER],
      ),
    ).rejects.toThrow(/payment_charges_pkey/);
  });
});
