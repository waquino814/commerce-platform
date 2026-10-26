import type { NewOrder, PaymentMethod } from './api';

/**
 * Client-side checks that mirror the orders API's request schema (apps/orders-api/src/routes.ts),
 * so most mistakes are caught before a request. The API stays authoritative: its 400 and 422
 * answers are mapped back onto the same fields.
 */
export const SKU_PATTERN = /^SKU-\d{5}$/;
export const MAX_QUANTITY = 100;
export const MAX_LINES = 50;

export interface Line {
  key: number;
  sku: string;
  quantity: string;
}

export type FieldErrors = Record<string, string>;
export const skuField = (key: number) => `sku-${String(key)}`;
export const quantityField = (key: number) => `quantity-${String(key)}`;

export function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}

export function validateOrder(
  lines: readonly Line[],
  paymentMethod: PaymentMethod,
): { errors: FieldErrors; order: NewOrder | null } {
  const errors: FieldErrors = {};
  const seen = new Set<string>();
  const items: NewOrder['items'] = [];
  if (lines.length === 0) errors.form = 'Add at least one item.';
  if (lines.length > MAX_LINES)
    errors.form = `An order can have at most ${String(MAX_LINES)} items.`;
  for (const line of lines) {
    const sku = normalizeSku(line.sku);
    if (sku === '') errors[skuField(line.key)] = 'Enter a SKU.';
    else if (!SKU_PATTERN.test(sku)) errors[skuField(line.key)] = 'Use the format SKU-00042.';
    else if (seen.has(sku)) errors[skuField(line.key)] = 'This SKU is already in the order.';
    seen.add(sku);
    const raw = line.quantity.trim();
    const quantity = Number(raw);
    if (raw === '' || !/^\d+$/.test(raw) || quantity < 1 || quantity > MAX_QUANTITY)
      errors[quantityField(line.key)] = `Enter a whole number from 1 to ${String(MAX_QUANTITY)}.`;
    items.push({ sku, quantity });
  }
  return Object.keys(errors).length > 0
    ? { errors, order: null }
    : { errors, order: { items, paymentMethod } };
}

/** Maps the API's 400 `details` (`{ path: 'items.0.sku', message }`) onto form fields. */
export function serverFieldErrors(
  lines: readonly Line[],
  details: readonly unknown[],
): FieldErrors {
  const errors: FieldErrors = {};
  for (const d of details) {
    const path = typeof d === 'object' && d !== null && 'path' in d ? String(d.path) : '';
    const m = /^items\.(\d+)\.(sku|quantity)$/.exec(path);
    const line = m ? lines[Number(m[1])] : undefined;
    if (m && line) {
      errors[m[2] === 'sku' ? skuField(line.key) : quantityField(line.key)] =
        m[2] === 'sku' ? 'The API rejected this SKU.' : 'The API rejected this quantity.';
    } else {
      errors.form = 'The API rejected the order. Check the items and try again.';
    }
  }
  return errors;
}

/** Marks the lines whose SKUs the API reported as unknown (422 `unknown_product`). */
export function unknownSkuErrors(lines: readonly Line[], skus: readonly unknown[]): FieldErrors {
  const unknown = new Set(skus.filter((s): s is string => typeof s === 'string'));
  const errors: FieldErrors = {};
  for (const line of lines)
    if (unknown.has(normalizeSku(line.sku)))
      errors[skuField(line.key)] = 'No product has this SKU.';
  return errors;
}
