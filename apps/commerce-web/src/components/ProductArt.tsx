/**
 * A decorative tile for a product. The API has no product images, so this is a monogram of the
 * product's name on a soft tint chosen from its SKU: stable per product, and not product data.
 */
const TINTS = [
  'bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300',
  'bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300',
  'bg-violet-100 text-violet-800 dark:bg-violet-950/70 dark:text-violet-300',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300',
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-300',
  'bg-amber-100 text-amber-900 dark:bg-amber-950/70 dark:text-amber-300',
  'bg-teal-100 text-teal-800 dark:bg-teal-950/70 dark:text-teal-300',
  'bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
];

export function hashSku(sku: string): number {
  let h = 0;
  for (const c of sku) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export function monogram(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() ?? '');
  return letters.slice(0, 2).join('') || '?';
}

export function ProductArt({
  sku,
  name,
  className = '',
}: {
  sku: string;
  name: string;
  className?: string;
}) {
  const tint = TINTS[hashSku(sku) % TINTS.length] ?? TINTS[0];
  return (
    <div
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center font-semibold tracking-tight ${tint ?? ''} ${className}`}
    >
      {monogram(name)}
    </div>
  );
}
