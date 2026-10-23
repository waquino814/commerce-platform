import { describe, expect, it } from 'vitest';
import { orderTotalCents } from '../src/pricing.js';

describe('orderTotalCents', () => {
  it('sums quantity × unit price in integer cents', () => {
    expect(
      orderTotalCents([
        { quantity: 2, unitPriceCents: 1999 },
        { quantity: 1, unitPriceCents: 1 },
      ]),
    ).toBe(3999);
    expect(orderTotalCents([])).toBe(0);
  });

  it.each([
    [{ quantity: 0, unitPriceCents: 100 }],
    [{ quantity: 1.5, unitPriceCents: 100 }],
    [{ quantity: 1, unitPriceCents: -1 }],
    [{ quantity: 1, unitPriceCents: 0.5 }],
  ])('rejects %j', (line) => {
    expect(() => orderTotalCents([line])).toThrow(RangeError);
  });

  it('rejects totals beyond safe integers', () => {
    expect(() =>
      orderTotalCents([{ quantity: 100, unitPriceCents: Number.MAX_SAFE_INTEGER }]),
    ).toThrow(/overflow/);
  });
});
