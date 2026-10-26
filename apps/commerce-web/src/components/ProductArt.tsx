/**
 * A decorative tile for a product. The API has no product images, so this is a monogram of the
 * product's name on a gradient chosen from its SKU: stable per product, and not product data.
 */
const GRADIENTS = [
  'from-rose-200 via-orange-100 to-amber-200 text-rose-900/70',
  'from-sky-200 via-cyan-100 to-teal-200 text-sky-900/70',
  'from-violet-200 via-fuchsia-100 to-pink-200 text-violet-900/70',
  'from-emerald-200 via-lime-100 to-yellow-200 text-emerald-900/70',
  'from-indigo-200 via-blue-100 to-sky-200 text-indigo-900/70',
  'from-amber-200 via-yellow-100 to-orange-200 text-amber-900/70',
  'from-teal-200 via-emerald-100 to-cyan-200 text-teal-900/70',
  'from-stone-300 via-stone-100 to-zinc-200 text-stone-700',
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
  const gradient = GRADIENTS[hashSku(sku) % GRADIENTS.length] ?? GRADIENTS[0];
  return (
    <div
      aria-hidden="true"
      className={`relative flex items-center justify-center overflow-hidden bg-gradient-to-br ${gradient ?? ''} ${className}`}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_15%,rgb(255_255_255/0.45),transparent_45%),radial-gradient(circle_at_10%_95%,rgb(255_255_255/0.3),transparent_40%)]" />
      <span className="relative font-semibold tracking-tight">{monogram(name)}</span>
    </div>
  );
}
