import type { FailureReason, OrderStatus, PaymentMethod } from './api';

/** Display text chosen by the UI; the API returns only stable codes (docs/architecture.md). */
export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

export const STATUS_TEXT: Record<OrderStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  payment_unknown: 'Confirming payment',
  paid: 'Paid',
  failed: 'Failed',
};

export const STATUS_HELP: Record<OrderStatus, string> = {
  pending: 'Waiting for the order processor.',
  processing: 'Reserving stock and charging the payment method.',
  payment_unknown: 'The payment outcome is being confirmed with the provider.',
  paid: 'Payment succeeded. This order is complete.',
  failed: 'This order did not complete.',
};

export const FAILURE_TEXT: Record<FailureReason, string> = {
  out_of_stock: 'Not enough stock for one or more items.',
  payment_declined: 'The payment method was declined.',
  max_attempts_exceeded: 'The order could not be processed after repeated attempts.',
  invalid_order: 'The order was invalid.',
};

export const PAYMENT_TEXT: Record<PaymentMethod, string> = {
  pm_card_ok: 'Test card · approves',
  pm_card_declined: 'Test card · declines',
  pm_card_unavailable: 'Test card · provider unavailable',
};

export const shortId = (id: string) => id.slice(0, 8);
