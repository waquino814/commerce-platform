/** Stock wording and tone from the product's real `stockAvailable`. */
export const LOW_STOCK = 10;

export function stockText(stock: number): string {
  return stock <= 0
    ? 'Sold out'
    : stock < LOW_STOCK
      ? `Only ${String(stock)} left`
      : `${String(stock)} in stock`;
}

export function StockIndicator({ stock, className = '' }: { stock: number; className?: string }) {
  const tone =
    stock <= 0
      ? 'text-rose-700 dark:text-rose-300'
      : stock < LOW_STOCK
        ? 'text-amber-800 dark:text-amber-300'
        : 'text-emerald-700 dark:text-emerald-400';
  const dot = stock <= 0 ? 'bg-rose-500' : stock < LOW_STOCK ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone} ${className}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {stockText(stock)}
    </span>
  );
}
