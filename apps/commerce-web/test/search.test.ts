import { describe, expect, it } from 'vitest';
import { coverageText } from '../src/components/ProductSearch';
import { formatClock, formatDate, plural } from '../src/format';
import { orderQuery } from '../src/pages/OrdersPage';
import { highlight, normalizeQuery, searchProducts } from '../src/search';
import type { Product } from '../src/api';

const named = (n: number, name: string): Product => ({
  sku: `SKU-${String(n).padStart(5, '0')}`,
  name,
  priceCents: 1000,
  currency: 'USD',
  stockAvailable: 10,
});

describe('searchProducts', () => {
  const products = [
    named(1, 'Brisk Lantern'),
    named(2, 'Lantern Hook'),
    named(3, 'Polar Lantern'),
    named(12, 'Lunar Anchor'),
    named(2, 'Lantern Hook'),
  ];

  it('normalizes the query', () => {
    expect(normalizeQuery('  Lunar   ANCHOR ')).toBe('lunar anchor');
    expect(normalizeQuery(' \t ')).toBe('');
  });

  it('ranks an exact SKU, then name prefixes, then word prefixes, then SKU and name parts', () => {
    expect(searchProducts(products, 'lantern').map((p) => p.name)).toEqual([
      'Lantern Hook',
      'Brisk Lantern',
      'Polar Lantern',
    ]);
    expect(searchProducts(products, 'sku-00012').map((p) => p.sku)).toEqual(['SKU-00012']);
    expect(searchProducts(products, '0001').map((p) => p.sku)).toEqual(['SKU-00001', 'SKU-00012']);
    expect(searchProducts(products, 'ntern h').map((p) => p.name)).toEqual(['Lantern Hook']);
  });

  it('never returns a product twice, and nothing for a blank query', () => {
    expect(searchProducts(products, 'hook')).toHaveLength(1);
    expect(searchProducts(products, '   ')).toEqual([]);
    expect(searchProducts(products, 'zebra')).toEqual([]);
  });

  it('splits text around the first match for highlighting', () => {
    expect(highlight('Lunar Anchor', 'ANCH')).toEqual([
      { text: 'Lunar ', match: false },
      { text: 'Anch', match: true },
      { text: 'or', match: false },
    ]);
    expect(highlight('Lunar', 'lunar')).toEqual([{ text: 'Lunar', match: true }]);
    expect(highlight('Lunar', 'x')).toEqual([{ text: 'Lunar', match: false }]);
    expect(highlight('Lunar', ' ')).toEqual([{ text: 'Lunar', match: false }]);
  });
});

describe('search coverage wording', () => {
  it('never claims the whole catalog before it has loaded', () => {
    expect(coverageText('complete', 1000)).toBeNull();
    expect(coverageText('idle', 0)).toBe('The catalog loads for search when you start typing.');
    expect(coverageText('loading', 300)).toBe(
      'Loading the catalog for search: 300 products so far.',
    );
    expect(coverageText('capped', 5000)).toBe(
      'Searching the first 5000 products; the catalog is larger.',
    );
    expect(coverageText({ error: new Error('x') }, 200)).toBe(
      'Search covers only the 200 products loaded before an error.',
    );
  });
});

describe('order helpers', () => {
  it('normalizes an order search', () => {
    expect(orderQuery('  #F2F0E1DA ')).toBe('F2F0E1DA');
    expect(orderQuery(' # ')).toBeNull();
    expect(orderQuery('')).toBeNull();
    expect(orderQuery('x'.repeat(150))).toHaveLength(100);
  });

  it('formats dates in UTC and counts', () => {
    expect(formatDate('2026-10-26T02:54:28.571Z')).toBe('Oct 26, 2026');
    expect(formatDate('bad')).toBe('bad');
    expect(formatClock('2026-10-26T02:54:28.571Z')).toBe('02:54 UTC');
    expect(formatClock('bad')).toBe('');
    expect([plural(1, 'unit'), plural(3, 'unit')]).toEqual(['1 unit', '3 units']);
  });
});
