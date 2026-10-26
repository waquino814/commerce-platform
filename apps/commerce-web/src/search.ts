import type { Product } from './api';

/**
 * Product search over the fields the API provides: name and SKU. Matching is case-insensitive
 * and partial; whitespace at the ends is ignored and runs of it inside count as one space.
 */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Lower is better: exact SKU, name prefix, word prefix, SKU part, name part. */
function rank(product: Product, q: string): number | null {
  const name = product.name.toLowerCase();
  const sku = product.sku.toLowerCase();
  if (sku === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(` ${q}`)) return 2;
  if (sku.includes(q)) return 3;
  if (name.includes(q)) return 4;
  return null;
}

/** Matching products, best first; ties keep catalog (SKU) order. Never duplicates a product. */
export function searchProducts(products: readonly Product[], raw: string): Product[] {
  const q = normalizeQuery(raw);
  if (q === '') return [];
  const seen = new Set<string>();
  const scored: { p: Product; r: number; i: number }[] = [];
  products.forEach((p, i) => {
    if (seen.has(p.sku)) return;
    seen.add(p.sku);
    const r = rank(p, q);
    if (r !== null) scored.push({ p, r, i });
  });
  return scored.sort((a, b) => a.r - b.r || a.i - b.i).map((s) => s.p);
}

/** Splits `text` around the first case-insensitive occurrence of the query, for highlighting. */
export function highlight(text: string, raw: string): { text: string; match: boolean }[] {
  const q = normalizeQuery(raw);
  const at = q === '' ? -1 : text.toLowerCase().indexOf(q);
  if (at < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, at), match: false },
    { text: text.slice(at, at + q.length), match: true },
    { text: text.slice(at + q.length), match: false },
  ].filter((s) => s.text !== '');
}
