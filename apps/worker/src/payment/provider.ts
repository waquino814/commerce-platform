import type { PaymentMethod } from '@commerce/db';

export type LedgerOutcome = 'approved' | 'declined' | 'voided';

/** An authoritative provider answer. `replayed` is true when it was recorded earlier. */
export interface ProviderResult {
  outcome: LedgerOutcome;
  reference: string | null;
  replayed: boolean;
}

export interface ChargeRequest {
  orderId: string;
  amountCents: number;
  paymentMethod: PaymentMethod;
}

/**
 * The payment provider as the worker sees it. Both calls either resolve with an authoritative
 * result or reject. A rejection, including a timeout, means the outcome is unknown: it is never
 * evidence that no charge exists.
 */
export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ProviderResult>;
  /** Returns the recorded outcome, or atomically records `voided` when there is none. */
  lookupOrVoid(orderId: string): Promise<ProviderResult>;
}

/** A provider-side failure, such as "provider unavailable". The outcome is unknown. */
export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(readonly code: string) {
    super(code);
  }
}

export class PaymentTimeoutError extends Error {
  override name = 'PaymentTimeoutError';
  constructor(readonly timeoutMs: number) {
    super(`payment provider did not answer within ${timeoutMs} ms`);
  }
}
