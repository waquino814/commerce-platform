import { createHash } from 'node:crypto';
import { seedProducts } from '@commerce/db/catalog';
import type { PaymentMethod, Profile } from './profiles.js';
import { createStreams } from './random.js';

/**
 * The canonical request plan: a pure function of the profile and the seed (ADR 0006). Responses,
 * server ids, the run prefix and timing are never part of it.
 */
export type PlanEntry =
  | {
      readonly index: number;
      readonly offsetMs: number;
      readonly op: 'product.list';
      readonly params: { readonly limit: number; readonly after: string | null };
    }
  | {
      readonly index: number;
      readonly offsetMs: number;
      readonly op: 'order.create';
      readonly params: {
        readonly items: readonly { readonly sku: string; readonly quantity: number }[];
        readonly paymentMethod: PaymentMethod;
        /** The plan index used for this create's idempotency key. */
        readonly keyIndex: number;
      };
    }
  | {
      readonly index: number;
      readonly offsetMs: number;
      readonly op: 'order.read';
      /** The plan index of the earlier `order.create` whose order this reads. */
      readonly params: { readonly createIndex: number };
    };

export type Operation = PlanEntry['op'];

export interface Plan {
  readonly profile: Profile;
  readonly seed: number;
  readonly entries: readonly PlanEntry[];
}

/** The seed catalog's SKUs, from the pure catalog export. */
export const CATALOG_SKUS: readonly string[] = Object.freeze(seedProducts().map((p) => p.sku));

export function isValidSeed(seed: number): boolean {
  return Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff;
}

export function entryCount(profile: Profile): number {
  return Math.round((profile.durationMs * profile.ratePerSecond) / 1000);
}

export function offsetOf(profile: Profile, index: number): number {
  return (index * 1000) / profile.ratePerSecond;
}

export function generatePlan(
  profile: Profile,
  seed: number,
  catalog: readonly string[] = CATALOG_SKUS,
): Plan {
  if (!isValidSeed(seed)) {
    throw new RangeError(`seed must be an integer from 0 to 4294967295, got ${String(seed)}`);
  }
  if (catalog.length < profile.orderCreate.maxItems) {
    throw new RangeError('catalog is smaller than the maximum items per order');
  }
  const random = createStreams(seed);
  const createIndexes: number[] = [];
  /** createIndexes[0, eligible) are creates scheduled at least orderReadMinAgeMs earlier. */
  let eligible = 0;
  const entries: PlanEntry[] = [];

  const productList = (index: number, offsetMs: number): PlanEntry => ({
    index,
    offsetMs,
    op: 'product.list',
    params: {
      limit: profile.productList.limit,
      after:
        random.cursor.int(100) < profile.productList.noCursorPercent
          ? null
          : (catalog[random.cursor.int(catalog.length)] ?? null),
    },
  });

  for (let index = 0; index < entryCount(profile); index += 1) {
    const offsetMs = offsetOf(profile, index);
    while (eligible < createIndexes.length) {
      const candidate = createIndexes[eligible] ?? 0;
      if (offsetOf(profile, candidate) > offsetMs - profile.orderReadMinAgeMs) break;
      eligible += 1;
    }
    const roll = random.operation.int(100);
    if (roll < profile.mixPercent.productList) {
      entries.push(productList(index, offsetMs));
    } else if (roll < profile.mixPercent.productList + profile.mixPercent.orderCreate) {
      const { minItems, maxItems, minQuantity, maxQuantity, okPaymentPercent } =
        profile.orderCreate;
      const count = minItems + random.itemCount.int(maxItems - minItems + 1);
      const skus: string[] = [];
      while (skus.length < count) {
        // Redraw duplicates: each SKU stays equally likely, and the API needs distinct SKUs.
        const sku = catalog[random.sku.int(catalog.length)] ?? '';
        if (!skus.includes(sku)) skus.push(sku);
      }
      entries.push({
        index,
        offsetMs,
        op: 'order.create',
        params: {
          items: skus.map((sku) => ({
            sku,
            quantity: minQuantity + random.quantity.int(maxQuantity - minQuantity + 1),
          })),
          paymentMethod:
            random.payment.int(100) < okPaymentPercent ? 'pm_card_ok' : 'pm_card_declined',
          keyIndex: index,
        },
      });
      createIndexes.push(index);
    } else if (eligible > 0) {
      entries.push({
        index,
        offsetMs,
        op: 'order.read',
        params: { createIndex: createIndexes[random.readTarget.int(eligible)] ?? 0 },
      });
    } else {
      // No create is old enough yet: the design turns this entry into a product.list.
      entries.push(productList(index, offsetMs));
    }
  }
  return Object.freeze({ profile, seed, entries: Object.freeze(entries) });
}

/** One JSON object per entry, keys in a fixed order, joined with newlines. */
export function canonicalPlanText(plan: Plan): string {
  return plan.entries
    .map((entry) => {
      const params =
        entry.op === 'product.list'
          ? { limit: entry.params.limit, after: entry.params.after }
          : entry.op === 'order.create'
            ? {
                items: entry.params.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
                paymentMethod: entry.params.paymentMethod,
                keyIndex: entry.params.keyIndex,
              }
            : { createIndex: entry.params.createIndex };
      return JSON.stringify({ index: entry.index, offsetMs: entry.offsetMs, op: entry.op, params });
    })
    .join('\n');
}

/** SHA-256 of the canonical plan text, as lowercase hex. */
export function planHash(plan: Plan): string {
  return createHash('sha256').update(canonicalPlanText(plan)).digest('hex');
}

export interface PlanSummary {
  readonly entries: number;
  readonly byOperation: Readonly<Record<Operation, number>>;
}

export function summarizePlan(plan: Plan): PlanSummary {
  const byOperation: Record<Operation, number> = {
    'product.list': 0,
    'order.create': 0,
    'order.read': 0,
  };
  for (const entry of plan.entries) byOperation[entry.op] += 1;
  return { entries: plan.entries.length, byOperation };
}
