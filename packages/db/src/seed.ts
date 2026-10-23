import type { Queryable } from './pool.js';

export const SEED_PRODUCT_COUNT = 1000;

const ADJECTIVES = [
  'Amber',
  'Brisk',
  'Cobalt',
  'Dusty',
  'Electric',
  'Frosted',
  'Golden',
  'Hollow',
  'Ivory',
  'Jade',
  'Kinetic',
  'Lunar',
  'Mossy',
  'Nimble',
  'Onyx',
  'Polar',
  'Quiet',
  'Rustic',
  'Solar',
  'Tidal',
] as const;
const NOUNS = [
  'Anchor',
  'Beacon',
  'Canteen',
  'Dynamo',
  'Easel',
  'Flask',
  'Gimbal',
  'Hammock',
  'Inkwell',
  'Jacket',
  'Kettle',
  'Lantern',
  'Mallet',
  'Notebook',
  'Oar',
  'Parka',
  'Quiver',
  'Rucksack',
  'Satchel',
  'Tripod',
  'Umbrella',
  'Valise',
  'Whistle',
  'Yoke',
  'Zipper',
  'Atlas',
  'Bucket',
  'Compass',
  'Drybag',
  'Easychair',
  'Fieldkit',
  'Grill',
  'Headlamp',
  'Icepick',
  'Jerrycan',
  'Kayak',
  'Ladder',
  'Mug',
  'Netbag',
  'Organizer',
  'Pillow',
  'Quilt',
  'Rope',
  'Stove',
  'Tarp',
  'Utensil',
  'Visor',
  'Wallet',
  'Xylophone',
  'Yurt',
] as const;

export interface SeedProduct {
  sku: string;
  name: string;
  priceCents: number;
  stockAvailable: number;
}

/** Pure, deterministic product definition for index 1..1000. */
export function seedProduct(index: number): SeedProduct {
  const adjective = ADJECTIVES[index % ADJECTIVES.length] ?? 'Plain';
  const noun = NOUNS[Math.floor(index / ADJECTIVES.length) % NOUNS.length] ?? 'Item';
  return {
    sku: `SKU-${String(index).padStart(5, '0')}`,
    name: `${adjective} ${noun}`,
    priceCents: 199 + ((index * 7919) % 9800),
    // Every 100th SKU is scarce, so out_of_stock is reachable.
    stockAvailable: index % 100 === 0 ? 3 : 20 + ((index * 31) % 180),
  };
}

export function seedProducts(): SeedProduct[] {
  return Array.from({ length: SEED_PRODUCT_COUNT }, (_, i) => seedProduct(i + 1));
}

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
