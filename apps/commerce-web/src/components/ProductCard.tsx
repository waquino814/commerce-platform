import { forwardRef } from 'react';
import type { Product } from '../api';
import { formatMoney } from '../format';
import { highlight } from '../search';
import { PlusIcon } from './icons';
import { ProductArt } from './ProductArt';
import { StockIndicator } from './StockIndicator';
import { BUTTON, Mono } from './ui';

/** Marks the part of `text` that matches the search query. */
export function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((s, i) =>
        s.match ? (
          <mark
            key={i}
            className="rounded-sm bg-brand-100 px-0.5 text-inherit dark:bg-brand-900/70"
          >
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/** A catalog card: real product data only (name, SKU, price, stock). Adding never places an order. */
export const ProductCard = forwardRef<
  HTMLButtonElement,
  {
    product: Product;
    inOrder: number;
    query?: string;
    highlighted?: boolean;
    onAdd: (p: Product) => void;
  }
>(function ProductCard({ product: p, inOrder, query = '', highlighted = false, onAdd }, addRef) {
  const out = p.stockAvailable <= 0;
  return (
    <li
      id={`product-${p.sku}`}
      data-highlighted={highlighted || undefined}
      className={`group relative flex flex-col rounded-2xl border bg-white p-4 shadow-card transition duration-200 hover:shadow-lift dark:bg-stone-900 ${
        highlighted
          ? 'border-brand-500 ring-4 ring-brand-500/20 dark:border-brand-400'
          : 'border-stone-200/80 hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-700'
      } ${out ? 'opacity-75' : ''}`}
    >
      <div className="flex items-start gap-3">
        <ProductArt sku={p.sku} name={p.name} className="h-12 w-12 rounded-xl text-base" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[0.95rem] font-semibold leading-snug tracking-tight">
            <Highlighted text={p.name} query={query} />
          </h3>
          <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
            <Mono>
              <Highlighted text={p.sku} query={query} />
            </Mono>
          </p>
        </div>
        {inOrder > 0 && (
          <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[0.7rem] font-semibold text-brand-700 ring-1 ring-inset ring-brand-600/20 dark:bg-brand-950/60 dark:text-brand-300">
            {inOrder} in order
          </span>
        )}
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-xl font-semibold tracking-tight tabular-nums">
            {formatMoney(p.priceCents, p.currency)}
          </p>
          <StockIndicator stock={p.stockAvailable} className="mt-0.5" />
        </div>
        <button
          ref={addRef}
          type="button"
          className={`${BUTTON.primary} px-3.5 py-2`}
          onClick={() => {
            onAdd(p);
          }}
          disabled={out}
          aria-label={out ? `${p.name} (${p.sku}) is out of stock` : `Add ${p.name} (${p.sku})`}
        >
          {out ? (
            'Sold out'
          ) : (
            <>
              <PlusIcon />
              Add
            </>
          )}
        </button>
      </div>
    </li>
  );
});
