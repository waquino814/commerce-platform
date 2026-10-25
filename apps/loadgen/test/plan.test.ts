import { describe, expect, it } from 'vitest';
import {
  CATALOG_SKUS,
  canonicalPlanText,
  entryCount,
  generatePlan,
  isValidSeed,
  planHash,
  summarizePlan,
  type PlanEntry,
} from '../src/plan.js';
import { getProfile, profileNames, STEADY, type Profile } from '../src/profiles.js';

/**
 * The steady/42 golden hash. It was recorded only after the plan's contents were checked
 * independently against every constraint below (D6). Any change to plan generation changes it:
 * update it deliberately and say why in the change.
 */
const STEADY_42_HASH = 'ba75539e9eac6c3754b0b0982d2afa0d9484cabdce827263bd38f10d850603f4';

const plan = generatePlan(STEADY, 42);
const byIndex = new Map(plan.entries.map((e) => [e.index, e]));
const creates = plan.entries.filter(
  (e): e is Extract<PlanEntry, { op: 'order.create' }> => e.op === 'order.create',
);

describe('plan determinism (criterion 1)', () => {
  it('the same profile and seed give a byte-identical plan and the committed golden hash', () => {
    const again = generatePlan(STEADY, 42);
    expect(canonicalPlanText(again)).toBe(canonicalPlanText(plan));
    expect(planHash(plan)).toBe(STEADY_42_HASH);
    expect(planHash(again)).toBe(STEADY_42_HASH);
  });

  it('a different seed gives a different hash', () => {
    expect(planHash(generatePlan(STEADY, 43))).not.toBe(STEADY_42_HASH);
    expect(planHash(generatePlan(STEADY, 0))).not.toBe(planHash(generatePlan(STEADY, 1)));
  });

  it('the canonical text has one JSON object per entry with keys in a fixed order', () => {
    const lines = canonicalPlanText(plan).split('\n');
    expect(lines).toHaveLength(3575);
    for (const line of lines.slice(0, 200)) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(entry)).toEqual(['index', 'offsetMs', 'op', 'params']);
      const params = Object.keys(entry.params as object);
      if (entry.op === 'product.list') expect(params).toEqual(['limit', 'after']);
      if (entry.op === 'order.create')
        expect(params).toEqual(['items', 'paymentMethod', 'keyIndex']);
      if (entry.op === 'order.read') expect(params).toEqual(['createIndex']);
    }
  });

  it('seeds outside 0..2^32-1 are rejected', () => {
    for (const seed of [-1, 1.5, 2 ** 32, Number.NaN]) {
      expect(isValidSeed(seed)).toBe(false);
      expect(() => generatePlan(STEADY, seed)).toThrow(RangeError);
    }
    expect(isValidSeed(0)).toBe(true);
    expect(isValidSeed(2 ** 32 - 1)).toBe(true);
  });
});

describe('plan contents for steady/42 (criterion 2)', () => {
  it('has 3,575 entries at offsets of index * 1000 / 55', () => {
    expect(entryCount(STEADY)).toBe(3575);
    plan.entries.forEach((entry, i) => {
      expect(entry.index).toBe(i);
      expect(entry.offsetMs).toBe((i * 1000) / 55);
    });
  });

  it('keeps the operation mix within 2 percentage points of 60/25/15', () => {
    const { byOperation, entries } = summarizePlan(plan);
    const pct = (n: number) => (100 * n) / entries;
    expect(Math.abs(pct(byOperation['product.list']) - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(pct(byOperation['order.create']) - 25)).toBeLessThanOrEqual(2);
    expect(Math.abs(pct(byOperation['order.read']) - 15)).toBeLessThanOrEqual(2);
  });

  it('gives every create 1 to 3 distinct catalog SKUs with quantity 1 or 2, and its own key index', () => {
    const catalog = new Set(CATALOG_SKUS);
    for (const entry of creates) {
      const { items, keyIndex } = entry.params;
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.length).toBeLessThanOrEqual(3);
      expect(new Set(items.map((i) => i.sku)).size).toBe(items.length);
      for (const item of items) {
        expect(catalog.has(item.sku)).toBe(true);
        expect([1, 2]).toContain(item.quantity);
      }
      expect(keyIndex).toBe(entry.index);
    }
  });

  it('uses only pm_card_ok and pm_card_declined', () => {
    expect(new Set(creates.map((e) => e.params.paymentMethod))).toEqual(
      new Set(['pm_card_ok', 'pm_card_declined']),
    );
  });

  it('targets every read at a create scheduled at least 1 s earlier', () => {
    const reads = plan.entries.filter((e) => e.op === 'order.read');
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      const target = byIndex.get(read.params.createIndex);
      expect(target?.op).toBe('order.create');
      expect((target?.offsetMs ?? Infinity) <= read.offsetMs - 1000).toBe(true);
    }
  });

  it('turns entries with no eligible create into product.list, so nothing reads before 1 s', () => {
    const firstRead = plan.entries.find((e) => e.op === 'order.read');
    expect(firstRead?.offsetMs).toBeGreaterThanOrEqual(1000);
    const early = plan.entries.filter((e) => e.offsetMs < 1000);
    expect(early.every((e) => e.op !== 'order.read')).toBe(true);
  });

  it('lists products with limit 20 and a catalog SKU cursor or none', () => {
    const catalog = new Set(CATALOG_SKUS);
    for (const entry of plan.entries) {
      if (entry.op !== 'product.list') continue;
      expect(entry.params.limit).toBe(20);
      if (entry.params.after !== null) expect(catalog.has(entry.params.after)).toBe(true);
    }
  });

  it('draws SKUs through exact uniform selection over the whole catalog', () => {
    // A two-SKU catalog makes the draw observable: both SKUs appear, and a single-item order
    // can only use the catalog it was given.
    const tiny: Profile = { ...STEADY, durationMs: 2_000 };
    const small = generatePlan(tiny, 42, ['SKU-00001', 'SKU-00002', 'SKU-00003']);
    const used = new Set(
      small.entries.flatMap((e) =>
        e.op === 'order.create' ? e.params.items.map((i) => i.sku) : [],
      ),
    );
    expect(used).toEqual(new Set(['SKU-00001', 'SKU-00002', 'SKU-00003']));
    expect(() => generatePlan(STEADY, 42, ['SKU-00001'])).toThrow(RangeError);
  });

  it('supplementary, fixed seed: SKU lines per tenth of the catalog and the payment mix are plausible', () => {
    // Deterministic for steady/42, so it cannot flake. Bands are deliberately wide.
    const tenths = Array.from({ length: 10 }, () => 0);
    let ok = 0;
    for (const entry of creates) {
      if (entry.params.paymentMethod === 'pm_card_ok') ok += 1;
      for (const item of entry.params.items) {
        const t = Math.floor((Number(item.sku.slice(4)) - 1) / 100);
        tenths[t] = (tenths[t] ?? 0) + 1;
      }
    }
    const lines = tenths.reduce((a, b) => a + b, 0);
    for (const count of tenths) {
      expect(count).toBeGreaterThan(lines * 0.07);
      expect(count).toBeLessThan(lines * 0.13);
    }
    expect(ok / creates.length).toBeGreaterThan(0.88);
    expect(ok / creates.length).toBeLessThan(0.96);
  });
});

describe('profiles', () => {
  it('is a closed registry with steady only', () => {
    expect(profileNames()).toEqual(['steady']);
    expect(getProfile('steady')).toBe(STEADY);
    expect(getProfile('burst')).toBeUndefined();
    expect(getProfile('toString')).toBeUndefined();
  });

  it('steady matches the accepted design', () => {
    expect(STEADY).toEqual({
      name: 'steady',
      ratePerSecond: 55,
      durationMs: 65_000,
      warmupMs: 5_000,
      mixPercent: { productList: 60, orderCreate: 25 },
      productList: { limit: 20, noCursorPercent: 10 },
      orderCreate: {
        minItems: 1,
        maxItems: 3,
        minQuantity: 1,
        maxQuantity: 2,
        okPaymentPercent: 92,
      },
      orderReadMinAgeMs: 1_000,
    });
  });
});
