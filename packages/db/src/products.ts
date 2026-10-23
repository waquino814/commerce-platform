import type { Queryable } from './pool.js';

export interface ProductView {
  sku: string;
  name: string;
  priceCents: number;
  currency: string;
  stockAvailable: number;
}

/** Keyset pagination by SKU. Returns `limit` products after `after`, and the next cursor. */
export async function listProducts(
  db: Queryable,
  params: { limit: number; after: string | null },
): Promise<{ items: ProductView[]; nextCursor: string | null }> {
  const result = await db.query<{
    sku: string;
    name: string;
    price_cents: number;
    currency: string;
    stock_available: number;
  }>(
    `SELECT sku, name, price_cents, currency, stock_available
       FROM products
      WHERE $1::text IS NULL OR sku > $1
      ORDER BY sku
      LIMIT $2`,
    [params.after, params.limit + 1],
  );
  const rows = result.rows.slice(0, params.limit);
  const hasMore = result.rows.length > params.limit;
  return {
    items: rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      priceCents: r.price_cents,
      currency: r.currency,
      stockAvailable: r.stock_available,
    })),
    nextCursor: hasMore ? (rows.at(-1)?.sku ?? null) : null,
  };
}
