import { describe, expect, it } from 'vitest';
import {
  CATALOG_SKUS,
  canonicalPlanText,
  generatePlan,
  planHash,
  summarizePlan,
  type PlanEntry,
} from '../src/plan.js';
import { getProfile, INCIDENT, STEADY } from '../src/profiles.js';

/**
 * M5b criterion B5: the `incident` profile. Its golden hash was recorded only after the plan's
 * contents were checked against the constraints below; the steady golden hash must not change.
 */
const INCIDENT_42_HASH = 'c5ff38777f042dbadcfe9cd0e3fae6d5d0c5802268dbb4b9e18697c414965353';
const STEADY_42_HASH = 'ba75539e9eac6c3754b0b0982d2afa0d9484cabdce827263bd38f10d850603f4';

const plan = generatePlan(INCIDENT, 42);
const byIndex = new Map(plan.entries.map((e) => [e.index, e]));

describe('incident profile (B5)', () => {
  it('is registered: 10 rps for 150 s, no warm-up, otherwise the steady rules', () => {
    expect(getProfile('incident')).toBe(INCIDENT);
    expect(INCIDENT).toEqual({
      ...STEADY,
      name: 'incident',
      ratePerSecond: 10,
      durationMs: 150_000,
      warmupMs: 0,
    });
    expect(Object.isFrozen(INCIDENT)).toBe(true);
  });

  it('plans 1,500 entries, one every 100 ms, in the steady mix', () => {
    const summary = summarizePlan(plan);
    expect(summary.entries).toBe(1500);
    expect(plan.entries.map((e) => e.offsetMs)).toEqual(
      Array.from({ length: 1500 }, (_, i) => i * 100),
    );
    const pct = (n: number) => (n * 100) / summary.entries;
    expect(Math.abs(pct(summary.byOperation['product.list']) - 60)).toBeLessThanOrEqual(5);
    expect(Math.abs(pct(summary.byOperation['order.create']) - 25)).toBeLessThanOrEqual(5);
    expect(Math.abs(pct(summary.byOperation['order.read']) - 15)).toBeLessThanOrEqual(5);
    expect(summary.byOperation).toEqual({
      'product.list': 857,
      'order.create': 406,
      'order.read': 237,
    });
  });

  it('follows the steady create and read rules', () => {
    const skus = new Set<string>(CATALOG_SKUS);
    for (const entry of plan.entries) {
      if (entry.op === 'order.create') {
        const { items, paymentMethod, keyIndex } = entry.params;
        expect(items.length).toBeGreaterThanOrEqual(1);
        expect(items.length).toBeLessThanOrEqual(3);
        for (const item of items) {
          expect(skus.has(item.sku)).toBe(true);
          expect(item.quantity).toBeGreaterThanOrEqual(1);
          expect(item.quantity).toBeLessThanOrEqual(2);
        }
        expect(['pm_card_ok', 'pm_card_declined']).toContain(paymentMethod);
        expect(keyIndex).toBe(entry.index);
      }
      if (entry.op === 'order.read') {
        const target = byIndex.get(entry.params.createIndex) as PlanEntry;
        expect(target.op).toBe('order.create');
        expect(entry.offsetMs - target.offsetMs).toBeGreaterThanOrEqual(1_000);
      }
    }
  });

  it('has its committed golden hash; another seed differs; the steady hash is unchanged', () => {
    expect(canonicalPlanText(generatePlan(INCIDENT, 42))).toBe(canonicalPlanText(plan));
    expect(planHash(plan)).toBe(INCIDENT_42_HASH);
    expect(planHash(generatePlan(INCIDENT, 43))).not.toBe(INCIDENT_42_HASH);
    expect(planHash(generatePlan(STEADY, 42))).toBe(STEADY_42_HASH);
  });
});
