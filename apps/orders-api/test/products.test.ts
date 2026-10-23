import { seedCatalog, seedProduct } from '@commerce/db';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool, resetDatabase } from '../../../packages/db/test/support.js';
import { buildServer } from '../src/server.js';

describe('GET /products', () => {
  const pool = createTestPool();
  const app = buildServer({ pool, logger: pino({ level: 'silent' }) });
  beforeAll(async () => {
    await resetDatabase(pool);
    await seedCatalog(pool);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('pages through the catalog by SKU with a cursor', async () => {
    const first = await app.inject({ method: 'GET', url: '/products?limit=2' });
    expect(first.statusCode).toBe(200);
    const page = first.json<{ items: { sku: string }[]; nextCursor: string | null }>();
    const p1 = seedProduct(1);
    expect(page.items[0]).toEqual({
      sku: p1.sku,
      name: p1.name,
      priceCents: p1.priceCents,
      currency: 'USD',
      stockAvailable: p1.stockAvailable,
    });
    expect(page.items.map((i) => i.sku)).toEqual(['SKU-00001', 'SKU-00002']);
    expect(page.nextCursor).toBe('SKU-00002');

    const next = await app.inject({ method: 'GET', url: '/products?limit=2&after=SKU-00002' });
    expect(next.json<{ items: { sku: string }[] }>().items.map((i) => i.sku)).toEqual([
      'SKU-00003',
      'SKU-00004',
    ]);

    const last = await app.inject({ method: 'GET', url: '/products?limit=100&after=SKU-00950' });
    const lastPage = last.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(lastPage.items).toHaveLength(50);
    expect(lastPage.nextCursor).toBeNull();
  });

  it('defaults to 50 items', async () => {
    const res = await app.inject({ method: 'GET', url: '/products' });
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(50);
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'after=nope', 'other=1'])(
    'returns 400 validation_error for %s',
    async (query) => {
      const res = await app.inject({ method: 'GET', url: `/products?${query}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation_error' });
    },
  );
});
