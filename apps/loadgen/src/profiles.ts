/**
 * Traffic profiles: a closed registry (docs/prompts/m4-design.md, "The `steady` profile"; M5 adds
 * `incident`).
 * Every value here is part of the plan's definition, so changing one changes the plan hash.
 */
export type PaymentMethod = 'pm_card_ok' | 'pm_card_declined';

export interface Profile {
  readonly name: string;
  /** Offered rate. Entry `i` is due at `i * 1000 / ratePerSecond` ms. */
  readonly ratePerSecond: number;
  /** Whole run, warm-up included. */
  readonly durationMs: number;
  /** Entries due before this offset are warm-up and excluded from every count. */
  readonly warmupMs: number;
  /** Operation mix in whole percent, summing to 100. */
  readonly mixPercent: { readonly productList: number; readonly orderCreate: number };
  readonly productList: { readonly limit: number; readonly noCursorPercent: number };
  readonly orderCreate: {
    readonly minItems: number;
    readonly maxItems: number;
    readonly minQuantity: number;
    readonly maxQuantity: number;
    /** Percent of creates that use `pm_card_ok`; the rest use `pm_card_declined`. */
    readonly okPaymentPercent: number;
  };
  /** A read targets a create scheduled at least this long before it. */
  readonly orderReadMinAgeMs: number;
}

/** 55 rps for 65 s: a 5 s warm-up, then the 60 s measured window; 3,575 entries. */
export const STEADY: Profile = Object.freeze({
  name: 'steady',
  ratePerSecond: 55,
  durationMs: 65_000,
  warmupMs: 5_000,
  // 60% product.list, 25% order.create, and the remaining 15% order.read.
  mixPercent: Object.freeze({ productList: 60, orderCreate: 25 }),
  productList: Object.freeze({ limit: 20, noCursorPercent: 10 }),
  orderCreate: Object.freeze({
    minItems: 1,
    maxItems: 3,
    minQuantity: 1,
    maxQuantity: 2,
    okPaymentPercent: 92,
  }),
  orderReadMinAgeMs: 1_000,
});

/**
 * 10 rps for 150 s with no warm-up: background traffic for an M5 incident run
 * (docs/prompts/m5-design.md, "`incident` load profile"); 1,500 entries. Otherwise the steady rules.
 */
export const INCIDENT: Profile = Object.freeze({
  ...STEADY,
  name: 'incident',
  ratePerSecond: 10,
  durationMs: 150_000,
  warmupMs: 0,
});

export const PROFILES: Readonly<Record<string, Profile>> = Object.freeze({
  incident: INCIDENT,
  steady: STEADY,
});

export function profileNames(): string[] {
  return Object.keys(PROFILES).sort();
}

export function getProfile(name: string): Profile | undefined {
  return Object.hasOwn(PROFILES, name) ? PROFILES[name] : undefined;
}
