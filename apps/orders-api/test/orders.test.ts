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
      for (const q of ['?limit=0', '?limit=101', '?after=nope', '?status=paid']) {
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
  });
});
