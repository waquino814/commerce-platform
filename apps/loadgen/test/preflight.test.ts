import { describe, expect, it } from 'vitest';
import { generatePlan, type Plan, type PlanEntry } from '../src/plan.js';
import {
  checkStock,
  plannedQuantities,
  runPreflight,
  SHORTFALL_THRESHOLD_PERCENT,
} from '../src/preflight.js';
import { STEADY } from '../src/profiles.js';
import type { HttpFetch, HttpRequest } from '../src/runner.js';

/** M4 criterion 8, against stubbed responses. */
const base = 'http://api.test';

function stubApi(options: {
  readyz?: number | 'error';
  stock: Map<string, number>;
  pageSize?: number;
  productsStatus?: number;
  stuckCursor?: boolean;
  malformed?: boolean;
}) {
  const requests: { url: string; req: HttpRequest }[] = [];
  const skus = [...options.stock.keys()].sort();
  const fetch: HttpFetch = (url, req) => {
    requests.push({ url, req });
    const reply = (status: number, body: unknown) =>
      Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/readyz') {
      if (options.readyz === 'error') return Promise.reject(new TypeError('fetch failed'));
      return reply(options.readyz ?? 200, {});
    }
    if (pathname === '/products') {
      if (options.productsStatus) return reply(options.productsStatus, {});
      if (options.malformed) return reply(200, { items: [{ sku: 1 }] });
      const size = options.pageSize ?? Number(searchParams.get('limit'));
      const after = searchParams.get('after');
      const start = after === null ? 0 : skus.indexOf(after) + 1;
      const page = skus.slice(start, start + size);
      const last = page.at(-1) ?? null;
      const more = start + size < skus.length;
      return reply(200, {
        items: page.map((sku) => ({ sku, stockAvailable: options.stock.get(sku) ?? 0 })),
        nextCursor: options.stuckCursor ? (after ?? last) : more ? last : null,
      });
    }
    return reply(404, {});
  };
  return { fetch, requests };
}

const create = (index: number, items: [string, number][]): PlanEntry => ({
  index,
  offsetMs: index,
  op: 'order.create',
  params: {
    items: items.map(([sku, quantity]) => ({ sku, quantity })),
    paymentMethod: 'pm_card_ok',
    keyIndex: index,
  },
});
const planOf = (entries: PlanEntry[]): Plan => ({ profile: STEADY, seed: 0, entries });

/** 100 planned units: 50 of SKU-00001, 30 of SKU-00002, 20 of SKU-00003. */
const hundredUnits = planOf([
  create(0, [
    ['SKU-00001', 50],
    ['SKU-00002', 30],
  ]),
  create(1, [['SKU-00003', 20]]),
]);

describe('preflight (criterion 8)', () => {
  it('passes a ready API with full stock, paging the whole catalog with GET only', async () => {
    const plan = generatePlan(STEADY, 42);
    const stock = new Map(
      Array.from({ length: 1000 }, (_, i) => [`SKU-${String(i + 1).padStart(5, '0')}`, 199]),
    );
    const api = stubApi({ stock });
    const result = await runPreflight(plan, { baseUrl: `${base}/`, fetch: api.fetch });
    expect(result.passed).toBe(true);
    expect(result.catalog).toEqual({ products: 1000, missingSkus: [] });
    expect(result.stock?.shortfallPercent).toBe(0);
    expect(result.stock?.shortSkus).toEqual([]);
    expect(api.requests.every((r) => r.req.method === 'GET')).toBe(true);
    expect(api.requests.every((r) => r.url.startsWith(`${base}/`))).toBe(true);
    expect(api.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/readyz',
      ...Array.from({ length: 10 }, () => '/products'),
    ]);
  });

  it('stops when /readyz is not 200 or unreachable, before reading the catalog', async () => {
    for (const readyz of [503, 'error'] as const) {
      const api = stubApi({ readyz, stock: new Map() });
      const result = await runPreflight(hundredUnits, { baseUrl: base, fetch: api.fetch });
      expect(result.passed).toBe(false);
      expect(result.failure).toMatch(/docker compose up -d --build --wait/);
      expect(api.requests).toHaveLength(1);
    }
  });

  it('stops when a planned SKU is missing from the catalog', async () => {
    const api = stubApi({ stock: new Map([['SKU-00001', 100]]) });
    const result = await runPreflight(hundredUnits, { baseUrl: base, fetch: api.fetch });
    expect(result.passed).toBe(false);
    expect(result.catalog?.missingSkus).toEqual(['SKU-00002', 'SKU-00003']);
    expect(result.failure).toMatch(/missing from the API's catalog/);
  });

  it('passes at exactly 5% shortfall and stops just above it', async () => {
    expect(SHORTFALL_THRESHOLD_PERCENT).toBe(5);
    const exact = stubApi({
      stock: new Map([
        ['SKU-00001', 45], // unmet 5 of 100 planned units: exactly 5%
        ['SKU-00002', 30],
        ['SKU-00003', 20],
      ]),
    });
    const atLimit = await runPreflight(hundredUnits, { baseUrl: base, fetch: exact.fetch });
    expect(atLimit.stock).toMatchObject({
      plannedQuantity: 100,
      unmetQuantity: 5,
      shortfallPercent: 5,
    });
    expect(atLimit.passed).toBe(true);

    const over = stubApi({
      stock: new Map([
        ['SKU-00001', 44], // unmet 6: 6%
        ['SKU-00002', 30],
        ['SKU-00003', 20],
      ]),
    });
    const above = await runPreflight(hundredUnits, { baseUrl: base, fetch: over.fetch });
    expect(above.passed).toBe(false);
    expect(above.stock?.shortfallPercent).toBe(6);
    expect(above.failure).toMatch(/6\.00% of planned order-item quantity/);
    expect(above.failure).toMatch(/recreating the database by hand/);
    expect(above.failure).toMatch(/never resets or reseeds/);
  });

  it('lists every short SKU, sorted by unmet then SKU, on pass and on fail', async () => {
    // Short SKUs at an aggregate of 4%: the run still passes.
    const passing = stubApi({
      stock: new Map([
        ['SKU-00001', 48], // unmet 2
        ['SKU-00002', 28], // unmet 2
        ['SKU-00003', 20],
      ]),
    });
    const ok = await runPreflight(hundredUnits, { baseUrl: base, fetch: passing.fetch });
    expect(ok.passed).toBe(true);
    expect(ok.stock?.shortSkus).toEqual([
      { sku: 'SKU-00001', planned: 50, available: 48, unmet: 2 },
      { sku: 'SKU-00002', planned: 30, available: 28, unmet: 2 },
    ]);

    const failing = stubApi({
      stock: new Map([
        ['SKU-00001', 50],
        ['SKU-00002', 0], // unmet 30
        ['SKU-00003', 10], // unmet 10
      ]),
    });
    const bad = await runPreflight(hundredUnits, { baseUrl: base, fetch: failing.fetch });
    expect(bad.passed).toBe(false);
    expect(bad.stock?.shortSkus.map((s) => [s.sku, s.unmet])).toEqual([
      ['SKU-00002', 30],
      ['SKU-00003', 10],
    ]);
  });

  it('stops on a catalog page that fails, is malformed, or never advances', async () => {
    const stock = new Map([
      ['SKU-00001', 100],
      ['SKU-00002', 100],
      ['SKU-00003', 100],
    ]);
    for (const options of [
      { productsStatus: 500 },
      { malformed: true },
      { stuckCursor: true, pageSize: 1 },
    ]) {
      const api = stubApi({ stock, ...options });
      const result = await runPreflight(hundredUnits, { baseUrl: base, fetch: api.fetch });
      expect(result.passed).toBe(false);
      expect(result.failure).toBeDefined();
    }
  });
});

describe('stock arithmetic', () => {
  it('sums planned quantity per SKU over every create item in the whole plan', () => {
    const planned = plannedQuantities(
      planOf([
        create(0, [['SKU-00001', 2]]),
        create(1, [
          ['SKU-00001', 1],
          ['SKU-00002', 2],
        ]),
      ]),
    );
    expect(planned).toEqual(
      new Map([
        ['SKU-00001', 3],
        ['SKU-00002', 2],
      ]),
    );
    const steady = plannedQuantities(generatePlan(STEADY, 42));
    expect([...steady.values()].reduce((a, b) => a + b, 0)).toBe(2771);
  });

  it('treats a SKU with no known stock as having none, and an empty plan as 0%', () => {
    expect(checkStock(new Map([['SKU-00009', 4]]), new Map())).toMatchObject({
      unmetQuantity: 4,
      shortfallPercent: 100,
    });
    expect(checkStock(new Map(), new Map()).shortfallPercent).toBe(0);
  });
});
