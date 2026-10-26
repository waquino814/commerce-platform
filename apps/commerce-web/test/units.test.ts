import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { apiBaseUrl } from '../src/config';
import { formatDateTime, formatMoney } from '../src/format';
import { serverFieldErrors, unknownSkuErrors, validateOrder, type Line } from '../src/orderForm';
import { matchRoute } from '../src/router';

const line = (key: number, sku: string, quantity: string): Line => ({ key, sku, quantity });

describe('order validation (mirrors the API schema)', () => {
  it('accepts valid items, normalizing SKUs', () => {
    expect(
      validateOrder([line(0, ' sku-00042 ', '2'), line(1, 'SKU-00007', '100')], 'pm_card_declined'),
    ).toEqual({
      errors: {},
      order: {
        items: [
          { sku: 'SKU-00042', quantity: 2 },
          { sku: 'SKU-00007', quantity: 100 },
        ],
        paymentMethod: 'pm_card_declined',
      },
    });
  });

  it('rejects missing or malformed SKUs, duplicates, and out-of-range quantities', () => {
    const { errors, order } = validateOrder(
      [
        line(0, '', '1'),
        line(1, 'SKU-42', '1'),
        line(2, 'SKU-00001', '0'),
        line(3, 'sku-00001', '101'),
        line(4, 'SKU-00002', '1.5'),
        line(5, 'SKU-00003', ''),
      ],
      'pm_card_ok',
    );
    expect(order).toBeNull();
    expect(errors).toEqual({
      'sku-0': 'Enter a SKU.',
      'sku-1': 'Use the format SKU-00042.',
      'quantity-2': 'Enter a whole number from 1 to 100.',
      'sku-3': 'This SKU is already in the order.',
      'quantity-3': 'Enter a whole number from 1 to 100.',
      'quantity-4': 'Enter a whole number from 1 to 100.',
      'quantity-5': 'Enter a whole number from 1 to 100.',
    });
    expect(validateOrder([], 'pm_card_ok').errors.form).toBe('Add at least one item.');
    const many = Array.from({ length: 51 }, (_, i) =>
      line(i, `SKU-${String(i).padStart(5, '0')}`, '1'),
    );
    expect(validateOrder(many, 'pm_card_ok').errors.form).toBe(
      'An order can have at most 50 items.',
    );
  });

  it('maps API 400 details and 422 unknown SKUs onto fields', () => {
    const lines = [line(4, 'SKU-00001', '1'), line(9, 'SKU-99999', '1')];
    expect(
      serverFieldErrors(lines, [
        { path: 'items.1.sku', message: 'x' },
        { path: 'items.0.quantity', message: 'y' },
      ]),
    ).toEqual({
      'sku-9': 'The API rejected this SKU.',
      'quantity-4': 'The API rejected this quantity.',
    });
    expect(serverFieldErrors(lines, [{ path: 'paymentMethod', message: 'z' }, 'odd'])).toEqual({
      form: 'The API rejected the order. Check the items and try again.',
    });
    expect(unknownSkuErrors(lines, ['SKU-99999', 7])).toEqual({
      'sku-9': 'No product has this SKU.',
    });
  });
});

describe('helpers', () => {
  it('configures the API base URL', () => {
    expect(apiBaseUrl(undefined)).toBe('/api');
    expect(apiBaseUrl('  ')).toBe('/api');
    expect(apiBaseUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
  });

  it('formats money and times', () => {
    expect(formatMoney(3085, 'USD')).toBe('$30.85');
    expect(formatMoney(100, 'not-a-currency')).toBe('1.00 not-a-currency');
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('2026-10-25T12:00:00.123Z')).toBe('2026-10-25 12:00:00 UTC');
    expect(formatDateTime('garbage')).toBe('garbage');
  });

  it('classifies transient API errors', () => {
    expect([0, 429, 500, 503].map((s) => new ApiError(s, 'x', 'y').transient)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect([400, 404, 409, 422].map((s) => new ApiError(s, 'x', 'y').transient)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('matches routes', () => {
    expect(matchRoute('/')).toEqual({ name: 'place' });
    expect(matchRoute('/orders/')).toEqual({ name: 'orders' });
    expect(matchRoute('/orders/abc')).toEqual({ name: 'order', id: 'abc' });
    expect(matchRoute('/orders/a/b')).toEqual({ name: 'not_found' });
  });
});
