import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations, SEED_PRODUCT_COUNT, seedCatalog, seedProduct } from '../src/index.js';
import { createTestPool } from './support.js';

async function freshSchema(pool: ReturnType<typeof createTestPool>): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
}

async function catalogChecksum(pool: ReturnType<typeof createTestPool>): Promise<string> {
  const result = await pool.query<{ checksum: string; count: string }>(
    `SELECT md5(string_agg(sku || '|' || name || '|' || price_cents || '|' || currency || '|' ||
                           stock_available, ',' ORDER BY sku)) AS checksum,
            count(*) AS count
       FROM products`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('no checksum row');
  return `${row.count}:${row.checksum}`;
}

describe('seed catalog (criterion 2)', () => {
  const pool = createTestPool();
  afterAll(() => pool.end());

  it('produces identical catalogs in two fresh databases, and a second seed changes nothing', async () => {
    await freshSchema(pool);
    expect(await seedCatalog(pool)).toBe(SEED_PRODUCT_COUNT);
    const first = await catalogChecksum(pool);

    await freshSchema(pool);
    expect(await seedCatalog(pool)).toBe(SEED_PRODUCT_COUNT);
    const second = await catalogChecksum(pool);

    expect(second).toBe(first);
    expect(first.startsWith('1000:')).toBe(true);

    expect(await seedCatalog(pool)).toBe(0);
    expect(await catalogChecksum(pool)).toBe(first);
  });

  it('never resets live stock on a rerun', async () => {
    await freshSchema(pool);
    await seedCatalog(pool);
    await pool.query(`UPDATE products SET stock_available = 1 WHERE sku = 'SKU-00001'`);

    await seedCatalog(pool);

    const row = await pool.query<{ stock_available: number }>(
      `SELECT stock_available FROM products WHERE sku = 'SKU-00001'`,
    );
    expect(row.rows[0]?.stock_available).toBe(1);
  });

  it('defines SKUs, names, prices and stock as pure functions, with every 100th SKU scarce', () => {
    expect(seedProduct(42)).toEqual(seedProduct(42));
    expect(seedProduct(1).sku).toBe('SKU-00001');
    expect(seedProduct(1000).sku).toBe('SKU-01000');
    expect(seedProduct(100).stockAvailable).toBe(3);
    expect(seedProduct(200).stockAvailable).toBe(3);
    expect(seedProduct(101).stockAvailable).toBeGreaterThan(3);
    const names = new Set(Array.from({ length: 1000 }, (_, i) => seedProduct(i + 1).name));
    expect(names.size).toBe(1000);
  });
});
