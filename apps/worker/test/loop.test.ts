import { claimDueOrders, recoverExpiredClaims, type ClaimedOrder } from '@commerce/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestPool,
  insertProducts,
  ledgerRows,
  placeOrder,
  resetDatabase,
  stockOf,
} from '../../../packages/db/test/support.js';
import { runWorkerLoop } from '../src/loop.js';
import {
  Deferred,
  FakeProvider,
  makeWorker,
  realSimulator,
  silentLogger,
  waitUntil,
} from './support.js';

const HOUR = 3_600_000;

describe('capacity rule (criterion 17)', () => {
  it('claims only free slots, never while full, wakes on a freed slot, and dispatches synchronously', async () => {
    const concurrency = 3;
    const batch = 2;
    const supply = Array.from({ length: 10 }, (_, i) => `order-${i}`);
    const handlers = new Map<string, Deferred<void>>();
    const events: string[] = [];
    const claimsAt: { limit: number; inFlight: number }[] = [];
    let claimedTotal = 0;

    const controller = new AbortController();
    const loop = runWorkerLoop<string>(
      {
        claim: (limit) => {
          // Every previously claimed order must already be running.
          expect(handlers.size).toBe(claimedTotal);
          claimsAt.push({ limit, inFlight: [...handlers.values()].length - doneCount() });
          return Promise.resolve(supply.splice(0, limit));
        },
        recover: () => {
          expect(handlers.size).toBe(claimedTotal);
          events.push('recover');
          return Promise.resolve();
        },
        process: (item) => {
          events.push(`start:${item}`);
          const gate = new Deferred<void>();
          handlers.set(item, gate);
          return gate.promise;
        },
        onClaim: (items) => {
          claimedTotal += items.length;
          events.push(`claimed:${items.length}`);
        },
        concurrency,
        claimBatchSize: batch,
        pollIntervalMs: HOUR,
        logger: silentLogger,
      },
      controller.signal,
    );

    const finished = new Set<string>();
    function doneCount(): number {
      return finished.size;
    }
    const finish = (item: string): void => {
      finished.add(item);
      handlers.get(item)?.resolve();
    };

    await waitUntil(() => claimedTotal === 3, 'slots filled');
    expect(claimsAt).toEqual([
      { limit: 2, inFlight: 0 },
      { limit: 1, inFlight: 2 },
    ]);
    // Each claim's orders start before anything else happens.
    expect(events.slice(0, 7)).toEqual([
      'recover',
      'claimed:2',
      'start:order-0',
      'start:order-1',
      'recover',
      'claimed:1',
      'start:order-2',
    ]);

    // Full: no further claim even after many event-loop turns.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(claimsAt).toHaveLength(2);

    // A freed slot triggers the next claim at once; the poll interval is an hour.
    finish('order-1');
    await waitUntil(() => claimedTotal === 4, 'claim after freed slot');
    expect(claimsAt.at(-1)).toEqual({ limit: 1, inFlight: 2 });

    finish('order-0');
    finish('order-2');
    await waitUntil(() => claimedTotal === 6, 'two slots refilled');
    for (const c of claimsAt) {
      expect(c.inFlight).toBeLessThan(concurrency);
      expect(c.limit).toBe(Math.min(concurrency - c.inFlight, batch));
    }

    controller.abort();
    await loop;
  });

  it('dispatches rows from a claim in flight when shutdown begins, then stops', async () => {
    const claim = new Deferred<string[]>();
    const started: string[] = [];
    const controller = new AbortController();
    let claims = 0;
    const loop = runWorkerLoop<string>(
      {
        claim: () => {
          claims += 1;
          return claim.promise;
        },
        recover: () => Promise.resolve(),
        process: (item) => {
          started.push(item);
          return Promise.resolve();
        },
        concurrency: 2,
        claimBatchSize: 2,
        pollIntervalMs: HOUR,
        logger: silentLogger,
      },
      controller.signal,
    );
    await waitUntil(() => claims === 1, 'claim sent');
    controller.abort();
    claim.resolve(['a', 'b']);
    await loop;
    expect(started).toEqual(['a', 'b']);
    expect(claims).toBe(1);
  });
});

describe('orders wait unclaimed for capacity (criterion 18)', () => {
  const pool = createTestPool();
  const simulatorPool = createTestPool();
  afterAll(async () => {
    await pool.end();
    await simulatorPool.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    await insertProducts(pool, [{ sku: 'SKU-00001', priceCents: 1000, stock: 100 }]);
  });

  async function states() {
    const result = await pool.query<{
      id: string;
      status: string;
      claimed_at: Date | null;
      processing_attempts: number;
    }>('SELECT id, status, claimed_at, processing_attempts FROM orders');
    return result.rows;
  }

  it('runs at most two orders, keeps the rest unclaimed, and refills on each freed slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++)
      ids.push(await placeOrder(pool, [{ sku: 'SKU-00001', quantity: 1 }]));
    const fake = new FakeProvider();
    fake.blockCharges();
    const sim = realSimulator(simulatorPool);
    const claimedIds: string[] = [];
    const startedIds: string[] = [];
    const { processor } = makeWorker(pool, fake, {
      hooks: { onPassStart: (order) => startedIds.push(order.id) },
    });
    const recover = () =>
      recoverExpiredClaims(pool, {
        claimTimeoutMs: HOUR,
        retryBaseMs: 1000,
        retryMaxMs: 30_000,
        maxReconciliationAttempts: 5,
        paymentUnknownRecheckMs: 900_000,
      });

    const controller = new AbortController();
    const loop = runWorkerLoop<ClaimedOrder>(
      {
        claim: (limit) => claimDueOrders(pool, { workerId: 'w', limit }),
        recover,
        process: (order) => processor.process(order),
        onClaim: (orders) => claimedIds.push(...orders.map((o) => o.id)),
        concurrency: 2,
        claimBatchSize: 10,
        pollIntervalMs: HOUR,
        logger: silentLogger,
      },
      controller.signal,
    );

    // Steps 1 and 2.
    await waitUntil(() => fake.charges.length === 2, '2 charges started');
    expect(claimedIds).toHaveLength(2);
    expect(startedIds).toEqual(claimedIds);
    const rows = await states();
    const active = rows.filter((r) => r.status === 'processing');
    const waiting = rows.filter((r) => r.status === 'pending');
    expect(active.map((r) => r.id).sort()).toEqual([...claimedIds].sort());
    expect(waiting).toHaveLength(4);
    for (const r of waiting) {
      expect(r.claimed_at).toBeNull();
      expect(r.processing_attempts).toBe(0);
    }

    // Step 3: recovery changes nothing.
    expect(await recover()).toEqual([]);

    // Steps 4 and 5.
    for (let released = 1; released <= 6; released++) {
      const [next] = fake.blockedOrderIds;
      const request = fake.charges.find((c) => c.orderId === next);
      if (!next || !request) throw new Error('expected a blocked charge');
      // The blocked charge is answered by the real simulator, so the ledger records it.
      fake.release(next, await sim.provider.charge(request));
      if (released <= 4) {
        await waitUntil(
          () => fake.charges.length === released + 2,
          `charge ${released + 2} started`,
        );
        const now = await states();
        expect(now.filter((r) => r.status === 'paid')).toHaveLength(released);
        expect(now.filter((r) => r.status === 'processing')).toHaveLength(2);
        expect(now.filter((r) => r.status === 'pending' && r.claimed_at === null)).toHaveLength(
          4 - released,
        );
      }
    }
    await waitUntil(
      async () => (await states()).every((r) => r.status === 'paid'),
      'all orders paid',
    );

    const final = await pool.query<{
      processing_attempts: number;
      charge_attempts: number;
      last_error: string | null;
    }>('SELECT processing_attempts, charge_attempts, last_error FROM orders');
    for (const r of final.rows) {
      expect(r).toEqual({ processing_attempts: 1, charge_attempts: 1, last_error: null });
    }
    expect(fake.maxRunning).toBe(2);
    expect(fake.charges).toHaveLength(6);
    expect(await stockOf(pool, 'SKU-00001')).toBe(94);
    expect(claimedIds).toHaveLength(6);
    for (const id of ids) {
      expect((await ledgerRows(pool, id)).map((r) => r.outcome)).toEqual(['approved']);
    }

    controller.abort();
    await loop;
  });
});
