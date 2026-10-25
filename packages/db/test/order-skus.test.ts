import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listOrderSkus } from '../src/index.js';
import { createTestPool, insertProducts, placeOrder, resetDatabase } from './support.js';

describe('listOrderSkus (M5 poison-order fault)', () => {
  const pool = createTestPool();
  beforeEach(async () => {
    await resetDatabase(pool);
    await insertProducts(pool, [
      { sku: 'SKU-00002', priceCents: 100, stock: 5 },
      { sku: 'SKU-00001', priceCents: 100, stock: 5 },
    ]);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("returns an order's SKUs sorted, and none for an unknown order", async () => {
    const id = await placeOrder(pool, [
      { sku: 'SKU-00002', quantity: 1 },
      { sku: 'SKU-00001', quantity: 2 },
    ]);
    expect(await listOrderSkus(pool, id)).toEqual(['SKU-00001', 'SKU-00002']);
    expect(await listOrderSkus(pool, '00000000-0000-4000-8000-000000000000')).toEqual([]);
  });
});
