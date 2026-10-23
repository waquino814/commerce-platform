export interface PricedLine {
  quantity: number;
  unitPriceCents: number;
}

/** Order total in integer cents: the sum of quantity × unit price. Pure. */
export function orderTotalCents(lines: readonly PricedLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new RangeError(`invalid quantity ${line.quantity}`);
    }
    if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
      throw new RangeError(`invalid unit price ${line.unitPriceCents}`);
    }
    total += line.quantity * line.unitPriceCents;
  }
  if (!Number.isSafeInteger(total)) throw new RangeError('order total overflow');
  return total;
}
