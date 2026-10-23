import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  chargeBackoffMs,
  exponentialBackoffMs,
  lookupErrorTarget,
  processingBudgetMs,
  reconciliationBackoffMs,
  recoveryBackoffMs,
  selectPass,
} from '../src/lifecycle.js';
import { DEFAULT_LIMITS } from './support.js';

describe('selectPass', () => {
  const limits = { maxClaims: 10, maxChargeAttempts: 3 };
  it.each([
    [{ processingAttempts: 1, chargeAttempts: 0, reconciliationAttempts: 0 }, 'charge'],
    [{ processingAttempts: 3, chargeAttempts: 2, reconciliationAttempts: 0 }, 'charge'],
    [{ processingAttempts: 10, chargeAttempts: 0, reconciliationAttempts: 0 }, 'charge'],
    [{ processingAttempts: 4, chargeAttempts: 3, reconciliationAttempts: 0 }, 'reconciliation'],
    [{ processingAttempts: 2, chargeAttempts: 1, reconciliationAttempts: 1 }, 'reconciliation'],
    [{ processingAttempts: 11, chargeAttempts: 0, reconciliationAttempts: 0 }, 'reconciliation'],
  ] as const)('%j is a %s pass', (order, expected) => {
    expect(selectPass(order, limits)).toBe(expected);
  });
});

describe('backoff', () => {
  it('doubles from the base and caps at the maximum', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => exponentialBackoffMs(n, 1000, 30_000))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
    ]);
    expect(exponentialBackoffMs(0, 1000, 30_000)).toBe(1000);
  });

  it('uses the configured bases per purpose', () => {
    expect(chargeBackoffMs(2, DEFAULT_LIMITS)).toBe(2000);
    expect(recoveryBackoffMs(3, DEFAULT_LIMITS)).toBe(4000);
    expect(reconciliationBackoffMs(1, DEFAULT_LIMITS)).toBe(5000);
    expect(reconciliationBackoffMs(5, DEFAULT_LIMITS)).toBe(60_000);
  });

  it('parks at the reconciliation limit, with the recheck interval', () => {
    expect(lookupErrorTarget(4, DEFAULT_LIMITS)).toEqual({ parked: false, delayMs: 40_000 });
    expect(lookupErrorTarget(5, DEFAULT_LIMITS)).toEqual({ parked: true, delayMs: 900_000 });
    expect(lookupErrorTarget(9, DEFAULT_LIMITS)).toEqual({ parked: true, delayMs: 900_000 });
  });
});

describe('transitions', () => {
  it('allows exactly the lifecycle table and same-status updates', () => {
    const statuses = ['pending', 'processing', 'paid', 'failed', 'payment_unknown'] as const;
    const allowed = statuses.flatMap((from) =>
      statuses.filter((to) => from !== to && canTransition(from, to)).map((to) => `${from}->${to}`),
    );
    expect(allowed.sort()).toEqual(ALLOWED_TRANSITIONS.map(([f, t]) => `${f}->${t}`).sort());
    expect(canTransition('paid', 'paid')).toBe(true);
    expect(canTransition('payment_unknown', 'failed')).toBe(false);
  });
});

describe('processingBudgetMs', () => {
  it('is 2C + 11S + 2P, 36 s with defaults', () => {
    expect(processingBudgetMs({ connectMs: 2000, statementMs: 2000, paymentMs: 5000 })).toBe(
      36_000,
    );
  });
});
