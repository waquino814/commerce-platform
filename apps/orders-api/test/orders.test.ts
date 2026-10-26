import { seedCatalog, seedProduct } from '@commerce/db';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, resetDatabase } from '../../../packages/db/test/support.js';
import { buildServer } from '../src/server.js';

const logger = pino({ level: 'silent' });

describe('orders API', () => {
  const pool = createTestPool();
  const app = buildServer({ pool, logger });
  const post = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/orders', payload: payload as object, headers });

  beforeAll(async () => {
    await resetDatabase(pool);
    await seedCatalog(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE payment_charges, order_items, orders');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const p42 = seedProduct(42);
  const p7 = seedProduct(7);
  const validBody = {
    items: [
      { sku: p42.sku, quantity: 2 },
      { sku: p7.sku, quantity: 1 },
    ],
    paymentMethod: 'pm_card_ok',
  };

  it('creates an order with the correct total and Location, and GET returns the same order (criterion 3)', async () => {
    const created = await post(validBody);

    expect(created.statusCode).toBe(201);
    const order = created.json<Record<string, unknown>>();
    expect(created.headers.location).toBe(`/orders/${String(order.id)}`);
    expect(order).toMatchObject({
      status: 'pending',
      currency: 'USD',
      totalCents: 2 * p42.priceCents + p7.priceCents,
      paymentMethod: 'pm_card_ok',
      paymentReference: null,
      processingAttempts: 0,
      chargeAttempts: 0,
      reconciliationAttempts: 0,
      failureReason: null,
      paidAt: null,
      failedAt: null,
    });
    expect(order.items).toEqual([
      {
        sku: p7.sku,
        name: p7.name,
        quantity: 1,
        unitPriceCents: p7.priceCents,
        lineTotalCents: p7.priceCents,
      },
      {
        sku: p42.sku,
        name: p42.name,
        quantity: 2,
        unitPriceCents: p42.priceCents,
        lineTotalCents: 2 * p42.priceCents,
      },
    ]);
    expect(typeof order.nextAttemptAt).toBe('string');

    const fetched = await app.inject({ method: 'GET', url: String(created.headers.location) });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(order);
  });

  it('does not check stock at creation', async () => {
    const scarce = seedProduct(100);
    const res = await post({
      items: [{ sku: scarce.sku, quantity: 100 }],
      paymentMethod: 'pm_card_ok',
    });
    expect(res.statusCode).toBe(201);
  });

  describe('idempotency (criterion 8)', () => {
    it('replays the original order for the same key and body, keeping one row', async () => {
      const first = await post(validBody, { 'idempotency-key': 'key-1' });
      const second = await post(validBody, { 'idempotency-key': 'key-1' });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
      const count = await pool.query('SELECT 1 FROM orders');
      expect(count.rowCount).toBe(1);
    });

    it('returns 409 for the same key with a different body', async () => {
      await post(validBody, { 'idempotency-key': 'key-2' });
      const res = await post(
        { ...validBody, paymentMethod: 'pm_card_declined' },
        { 'idempotency-key': 'key-2' },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'idempotency_key_conflict' });
    });

    it('resolves concurrent duplicates to one order', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => post(validBody, { 'idempotency-key': 'key-3' })),
      );
      const ids = new Set(results.map((r) => r.json<{ id: string }>().id));
      expect(ids.size).toBe(1);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
      const count = await pool.query(`SELECT 1 FROM orders WHERE idempotency_key = 'key-3'`);
      expect(count.rowCount).toBe(1);
    });
  });

  describe('validation (criterion 9)', () => {
    it.each([
      ['an empty item list', { items: [], paymentMethod: 'pm_card_ok' }],
      ['quantity 0', { items: [{ sku: p42.sku, quantity: 0 }], paymentMethod: 'pm_card_ok' }],
      ['quantity 101', { items: [{ sku: p42.sku, quantity: 101 }], paymentMethod: 'pm_card_ok' }],
      [
        'duplicate SKUs',
        {
          items: [
            { sku: p42.sku, quantity: 1 },
            { sku: p42.sku, quantity: 2 },
          ],
          paymentMethod: 'pm_card_ok',
        },
      ],
      [
        'an unknown payment method',
        { items: [{ sku: p42.sku, quantity: 1 }], paymentMethod: 'pm_cash' },
      ],
      ['an unknown top-level field', { ...validBody, coupon: 'FREE' }],
      [
        'an unknown item field',
        { items: [{ sku: p42.sku, quantity: 1, gift: true }], paymentMethod: 'pm_card_ok' },
      ],
      ['a missing payment method', { items: [{ sku: p42.sku, quantity: 1 }] }],
    ])('returns 400 validation_error for %s', async (_name, body) => {
      const res = await post(body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'validation_error',
        message: expect.any(String) as string,
      });
    });

    it('returns 400 validation_error for malformed JSON', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/orders',
        payload: '{"items": [',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation_error' });
    });

    it('returns 400 for an invalid Idempotency-Key', async () => {
      const res = await post(validBody, { 'idempotency-key': 'has spaces' });
      expect(res.statusCode).toBe(400);
    });

    it('returns 422 unknown_product listing unknown SKUs', async () => {
      const res = await post({
        items: [
          { sku: 'SKU-99998', quantity: 1 },
          { sku: p42.sku, quantity: 1 },
          { sku: 'SKU-99999', quantity: 1 },
        ],
        paymentMethod: 'pm_card_ok',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({
        error: 'unknown_product',
        message: expect.any(String) as string,
        details: ['SKU-99998', 'SKU-99999'],
      });
      const count = await pool.query('SELECT 1 FROM orders');
      expect(count.rowCount).toBe(0);
    });

    it('returns 400 for a non-UUID order id and 404 for a missing order', async () => {
      const bad = await app.inject({ method: 'GET', url: '/orders/not-a-uuid' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'validation_error' });

      const missing = await app.inject({
        method: 'GET',
        url: '/orders/00000000-0000-4000-8000-000000000000',
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: 'order_not_found' });
    });
  });

  describe('order history (M7)', () => {
    const list = (query = '') => app.inject({ method: 'GET', url: `/orders${query}` });

    it('is empty with no orders', async () => {
      const res = await list();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], nextCursor: null });
    });

    it('lists orders newest first with item counts, and pages with a cursor', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        ids.push((await post(validBody)).json<{ id: string }>().id);
      }
      // Fix the creation times so the order is deterministic, including a tie broken by ID.
      await pool.query(
        `UPDATE orders SET created_at = CASE id
           WHEN $1::uuid THEN '2026-10-25T10:00:00Z'::timestamptz
           ELSE '2026-10-25T11:00:00Z'::timestamptz END`,
        [ids[0]],
      );
      const newer = [ids[1], ids[2]].map(String).sort().reverse();

      const first = await list('?limit=2');
      expect(first.statusCode).toBe(200);
      const page = first.json<{ items: Record<string, unknown>[]; nextCursor: string | null }>();
      expect(page.items.map((o) => o.id)).toEqual(newer);
      expect(page.nextCursor).toBe(newer[1]);
      expect(page.items[0]).toEqual({
        id: newer[0],
        status: 'pending',
        currency: 'USD',
        totalCents: 2 * p42.priceCents + p7.priceCents,
        itemCount: 2,
        totalQuantity: 3,
        items: [
          { sku: p7.sku, name: p7.name, quantity: 1 },
          { sku: p42.sku, name: p42.name, quantity: 2 },
        ],
        failureReason: null,
        createdAt: '2026-10-25T11:00:00.000Z',
        updatedAt: expect.any(String) as unknown,
      });

      const second = await list(`?limit=2&after=${String(page.nextCursor)}`);
      expect(second.json()).toMatchObject({ items: [{ id: ids[0] }], nextCursor: null });
    });

    it('defaults to 20 and validates the query', async () => {
      for (let i = 0; i < 21; i += 1) await post(validBody);
      const page = (await list()).json<{ items: unknown[]; nextCursor: string | null }>();
      expect(page.items).toHaveLength(20);
      expect(page.nextCursor).not.toBeNull();
      for (const q of [
        '?limit=0',
        '?limit=101',
        '?after=nope',
        '?status=shipped',
        '?q=',
        '?q=%20%20',
        `?q=${'x'.repeat(101)}`,
        '?sort=asc',
      ]) {
        const res = await list(q);
        expect(res.statusCode, q).toBe(400);
        expect(res.json(), q).toMatchObject({ error: 'validation_error' });
      }
      const unknown = await list('?after=00000000-0000-4000-8000-000000000000');
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toEqual({
        error: 'invalid_cursor',
        message: 'the cursor names no order',
      });
    });

    describe('filters and search', () => {
      type Page = { items: { id: string; status: string }[]; nextCursor: string | null };
      const ids = (q: string) => list(q).then((r) => r.json<Page>().items.map((o) => o.id));
      const p300 = seedProduct(300);

      async function threeOrders() {
        const a = (await post(validBody)).json<{ id: string }>().id;
        const b = (
          await post({ items: [{ sku: p300.sku, quantity: 1 }], paymentMethod: 'pm_card_ok' })
        ).json<{ id: string }>().id;
        const c = (await post(validBody)).json<{ id: string }>().id;
        // Newest first: c, b, a. Two of them are failed, one is paid.
        await pool.query(
          `UPDATE orders SET created_at = CASE id
             WHEN $1::uuid THEN '2026-10-25T10:00:00Z'::timestamptz
             WHEN $2::uuid THEN '2026-10-25T11:00:00Z'::timestamptz
             ELSE '2026-10-25T12:00:00Z'::timestamptz END`,
          [a, b],
        );
        // Bypass the lifecycle trigger's transition rules only to label rows for the filter.
        await pool.query('ALTER TABLE orders DISABLE TRIGGER USER');
        try {
          await pool.query(
            `UPDATE orders SET status = 'failed', failure_reason = 'payment_declined',
                    failed_at = now(), inventory_reserved_at = now(), inventory_released_at = now()
              WHERE id = ANY($1::uuid[])`,
            [[a, c]],
          );
        } finally {
          await pool.query('ALTER TABLE orders ENABLE TRIGGER USER');
        }
        return { a, b, c };
      }

      it('filters by status, keeping the newest-first order and the cursor', async () => {
        const { a, b, c } = await threeOrders();
        expect(await ids('?status=failed')).toEqual([c, a]);
        expect(await ids('?status=pending')).toEqual([b]);
        expect(await ids('?status=paid')).toEqual([]);
        const first = (await list('?status=failed&limit=1')).json<Page>();
        expect(first.items.map((o) => o.id)).toEqual([c]);
        expect(first.nextCursor).toBe(c);
        // The next page under the same filter skips the pending order in between.
        expect(await ids(`?status=failed&limit=1&after=${c}`)).toEqual([a]);
      });

      it('searches by order-ID prefix, SKU or product name, case-insensitively', async () => {
        const { a, b, c } = await threeOrders();
        expect(await ids(`?q=${b.slice(0, 8).toUpperCase()}`)).toEqual([b]);
        expect(await ids(`?q=${encodeURIComponent(p300.sku.toLowerCase())}`)).toEqual([b]);
        expect(await ids(`?q=${encodeURIComponent(p42.name.slice(1, 5).toUpperCase())}`)).toEqual(
          expect.arrayContaining([c, a]) as unknown,
        );
        expect(await ids('?q=SKU-0004')).toEqual([c, a]);
        // Only a prefix of the ID matches, not a fragment from its middle.
        expect(await ids(`?q=${b.slice(9, 13)}`)).not.toContain(b);
        expect(await ids(`?q=${encodeURIComponent(p300.sku)}&status=failed`)).toEqual([]);
        expect(
          await ids(`?q=${encodeURIComponent(p42.sku)}&status=failed&limit=1&after=${c}`),
        ).toEqual([a]);
      });

      it('matches LIKE wildcards literally', async () => {
        await threeOrders();
        expect(await ids('?q=%25')).toEqual([]);
        expect(await ids('?q=_')).toEqual([]);
        expect(await ids('?q=SKU%5F0')).toEqual([]);
        expect(await ids(`?q=${encodeURIComponent('\\')}`)).toEqual([]);
      });

      it('previews at most three items, by SKU, with the full counts', async () => {
        const items = [5, 4, 3, 2, 1].map((i) => ({ sku: seedProduct(i).sku, quantity: i }));
        await post({ items, paymentMethod: 'pm_card_ok' });
        const [order] = (await list()).json<{
          items: { itemCount: number; totalQuantity: number; items: unknown[] }[];
        }>().items;
        expect(order?.itemCount).toBe(5);
        expect(order?.totalQuantity).toBe(15);
        expect(order?.items).toEqual(
          [1, 2, 3].map((i) => ({
            sku: seedProduct(i).sku,
            name: seedProduct(i).name,
            quantity: i,
          })),
        );
      });
    });
  });
});
