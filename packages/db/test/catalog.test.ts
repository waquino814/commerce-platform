import { readFileSync } from 'node:fs';
import * as catalog from '@commerce/db/catalog';
import { describe, expect, it } from 'vitest';
import * as db from '../src/index.js';
import * as seed from '../src/seed.js';

/** M4 criterion 4: the pure catalog export (docs/prompts/m4-design.md, "Catalog source"). */
describe('@commerce/db/catalog', () => {
  it('returns exactly the seed catalog: 1,000 products from seedProduct(1) to seedProduct(1000)', () => {
    const products = catalog.seedProducts();
    expect(catalog.SEED_PRODUCT_COUNT).toBe(1000);
    expect(products).toHaveLength(1000);
    expect(products[0]).toEqual(catalog.seedProduct(1));
    expect(products[999]).toEqual(catalog.seedProduct(1000));
    expect(products[41]?.sku).toBe('SKU-00042');
    expect(products.reduce((sum, p) => sum + p.stockAvailable, 0)).toBe(108_570);
    expect(new Set(products.map((p) => p.sku)).size).toBe(1000);
  });

  it('the seed module and the package root re-export the same functions', () => {
    expect(seed.seedProduct).toBe(catalog.seedProduct);
    expect(seed.seedProducts).toBe(catalog.seedProducts);
    expect(seed.SEED_PRODUCT_COUNT).toBe(catalog.SEED_PRODUCT_COUNT);
    expect(db.seedProduct).toBe(catalog.seedProduct);
    expect(db.seedProducts).toBe(catalog.seedProducts);
  });

  it('the catalog source has no imports at all, so it can never load pg or the pool', () => {
    const source = readFileSync(new URL('../src/catalog.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfrom\s+['"]/);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
