import type { OrderStatus } from '@commerce/db';

/** Retry, reconciliation, and claim limits. All delays are in milliseconds. */
export interface Limits {
  maxClaims: number;
  maxChargeAttempts: number;
  maxReconciliationAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  reconciliationBaseDelayMs: number;
  reconciliationMaxDelayMs: number;
  paymentUnknownRecheckMs: number;
}

/** The transitions the database trigger also enforces. Same-status updates are always allowed. */
export const ALLOWED_TRANSITIONS: readonly (readonly [OrderStatus, OrderStatus])[] = [
  ['pending', 'processing'],
  ['payment_unknown', 'processing'],
  ['processing', 'paid'],
  ['processing', 'failed'],
  ['processing', 'pending'],
  ['processing', 'payment_unknown'],
];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export type PassType = 'charge' | 'reconciliation';

/**
 * A pass reconciles once any condition holds: a lookup already failed, the charge budget is
 * spent, or the order exceeded the claim ceiling. All three only ever stay true, so after the
 * first reconciliation an order never gets another `charge` call.
 */
export function selectPass(
  order: { processingAttempts: number; chargeAttempts: number; reconciliationAttempts: number },
  limits: Pick<Limits, 'maxClaims' | 'maxChargeAttempts'>,
): PassType {
  if (
    order.reconciliationAttempts > 0 ||
    order.chargeAttempts >= limits.maxChargeAttempts ||
    order.processingAttempts > limits.maxClaims
  ) {
    return 'reconciliation';
  }
  return 'charge';
}

/** `min(base * 2^(attempt - 1), max)` for attempt >= 1. No jitter, to keep runs deterministic. */
export function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

export function chargeBackoffMs(chargeAttempts: number, limits: Limits): number {
  return exponentialBackoffMs(chargeAttempts, limits.retryBaseDelayMs, limits.retryMaxDelayMs);
}

/** Mirrors the SQL in `recoverExpiredClaims`. A test keeps the two in agreement. */
export function recoveryBackoffMs(processingAttempts: number, limits: Limits): number {
  return exponentialBackoffMs(processingAttempts, limits.retryBaseDelayMs, limits.retryMaxDelayMs);
}

export function reconciliationBackoffMs(reconciliationAttempts: number, limits: Limits): number {
  return exponentialBackoffMs(
    reconciliationAttempts,
    limits.reconciliationBaseDelayMs,
    limits.reconciliationMaxDelayMs,
  );
}

/** Where a lookup error sends the order, given its new `reconciliation_attempts` value. */
export function lookupErrorTarget(
  newReconciliationAttempts: number,
  limits: Limits,
): { parked: boolean; delayMs: number } {
  const parked = newReconciliationAttempts >= limits.maxReconciliationAttempts;
  return {
    parked,
    delayMs: parked
      ? limits.paymentUnknownRecheckMs
      : reconciliationBackoffMs(newReconciliationAttempts, limits),
  };
}

/**
 * Worst case for one processing pass, measured from `claimed_at`:
 * claim tail S + reservation (C + 6S) + charge P + lookup P + finalize (C + 4S) = 2C + 11S + 2P.
 */
export function processingBudgetMs(timeouts: {
  connectMs: number;
  statementMs: number;
  paymentMs: number;
}): number {
  return 2 * timeouts.connectMs + 11 * timeouts.statementMs + 2 * timeouts.paymentMs;
}
