import { seedProducts } from './catalog.js';
import type { Queryable } from './pool.js';

export { SEED_PRODUCT_COUNT, seedProduct, seedProducts, type SeedProduct } from './catalog.js';

/** Inserts the seed catalog. Existing SKUs are left untouched, so live stock is never reset. */
export async function seedCatalog(db: Queryable): Promise<number> {
  const products = seedProducts();
  const result = await db.query(
    `INSERT INTO products (sku, name, price_cents, currency, stock_available)
     SELECT sku, name, price, 'USD', stock
       FROM unnest($1::text[], $2::text[], $3::int[], $4::int[]) AS t(sku, name, price, stock)
     ON CONFLICT (sku) DO NOTHING`,
    [
      products.map((p) => p.sku),
      products.map((p) => p.name),
      products.map((p) => p.priceCents),
      products.map((p) => p.stockAvailable),
    ],
  );
  return result.rowCount ?? 0;
}
