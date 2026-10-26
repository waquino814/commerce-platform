import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Product } from '../api';
import { formatMoney } from '../format';
import { normalizeQuery, searchProducts } from '../search';
import type { IndexStatus } from '../useProductIndex';
import { SearchIcon, Spinner, XIcon } from './icons';
import { Highlighted } from './ProductCard';
import { ProductArt } from './ProductArt';
import { StockIndicator } from './StockIndicator';
import { Mono } from './ui';

export const MAX_SUGGESTIONS = 8;

/** What the search covers, in words: never claims the whole catalog before it has loaded. */
export function coverageText(status: IndexStatus, loaded: number): string | null {
  if (status === 'complete') return null;
  if (status === 'capped')
    return `Searching the first ${String(loaded)} products; the catalog is larger.`;
  if (status === 'idle') return 'The catalog loads for search when you start typing.';
  if (status === 'loading')
    return `Loading the catalog for search: ${String(loaded)} products so far.`;
  return `Search covers only the ${String(loaded)} products loaded before an error.`;
}

/**
 * Google-style product search: a combobox whose listbox suggests matching products as you type.
 * Arrow keys move through suggestions, Enter selects the active one (or closes the list to show
 * all results), Escape and an outside click dismiss it. Selecting never adds or orders anything.
 */
export function ProductSearch({
  value,
  onChange,
  products,
  status,
  onFocus,
  onRetry,
  onSelect,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  products: readonly Product[];
  status: IndexStatus;
  onFocus: () => void;
  onRetry: () => void;
  onSelect: (product: Product) => void;
  onSubmit: () => void;
}) {
  const id = useId();
  const listId = `${id}-listbox`;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const q = normalizeQuery(value);
  const matches = q === '' ? [] : searchProducts(products, value);
  const suggestions = matches.slice(0, MAX_SUGGESTIONS);
  const expanded = open && q !== '';
  const loading = status === 'loading' || status === 'idle';
  const failed = typeof status === 'object';

  useEffect(() => {
    setActive(-1);
  }, [value]);

  useEffect(() => {
    if (!expanded) return;
    const onPointer = (e: PointerEvent | MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [expanded]);

  const select = (p: Product) => {
    setOpen(false);
    setActive(-1);
    onSelect(p);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!expanded) {
        setOpen(true);
        return;
      }
      const n = suggestions.length;
      if (n === 0) return;
      // Like Google, moving past either end returns to the typed text.
      setActive((a) =>
        e.key === 'ArrowDown' ? (a + 1 >= n ? -1 : a + 1) : a <= -1 ? n - 1 : a - 1,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = expanded && active >= 0 ? suggestions[active] : undefined;
      if (chosen) select(chosen);
      else {
        setOpen(false);
        onSubmit();
      }
    } else if (e.key === 'Escape') {
      if (expanded) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
    }
  };

  const announcement =
    q === ''
      ? ''
      : matches.length === 0
        ? loading
          ? 'No matches yet; the catalog is still loading.'
          : 'No products match.'
        : `${String(matches.length)} product${matches.length === 1 ? '' : 's'} match. ${String(suggestions.length)} suggestion${suggestions.length === 1 ? '' : 's'} shown; use the arrow keys to choose.`;
  const coverage = coverageText(status, products.length);

  return (
    <div ref={root} className="relative">
      <label htmlFor={`${id}-input`} className="sr-only">
        Search products
      </label>
      <div className="flex h-13 items-center gap-3 rounded-full border border-stone-300 bg-white px-5 shadow-card transition-shadow focus-within:border-brand-500 focus-within:shadow-lift focus-within:ring-4 focus-within:ring-brand-500/15 hover:shadow-lift dark:border-stone-700 dark:bg-stone-900">
        <SearchIcon className="shrink-0 text-lg text-stone-500 dark:text-stone-400" />
        <input
          ref={input}
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            expanded && active >= 0 ? `${id}-option-${String(active)}` : undefined
          }
          aria-describedby={`${id}-hint`}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search products by name or SKU"
          value={value}
          onChange={(e) => {
            // Typing also starts the index, in case focus arrived without a focus event.
            onFocus();
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            onFocus();
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-[0.95rem] placeholder:text-stone-500 focus:outline-none dark:placeholder:text-stone-400"
        />
        {loading && q !== '' && <Spinner className="shrink-0 text-stone-400" />}
        {value !== '' && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onChange('');
              setOpen(false);
              input.current?.focus();
            }}
            className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-brand-500 dark:hover:bg-stone-800 dark:hover:text-stone-100"
          >
            <XIcon />
          </button>
        )}
      </div>
      <p id={`${id}-hint`} className="sr-only">
        Type to see suggestions. Use the up and down arrows to choose, Enter to select, Escape to
        close.
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {expanded && (
        <div className="absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-lift dark:border-stone-700 dark:bg-stone-900">
          <ul
            id={listId}
            role="listbox"
            aria-label="Product suggestions"
            className="max-h-[22rem] overflow-y-auto py-1.5"
          >
            {suggestions.map((p, i) => (
              <li
                key={p.sku}
                id={`${id}-option-${String(i)}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  // Keep focus in the input until the click selects.
                  e.preventDefault();
                }}
                onMouseEnter={() => {
                  setActive(i);
                }}
                onClick={() => {
                  select(p);
                }}
                className={`mx-1.5 flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 ${i === active ? 'bg-brand-50 dark:bg-brand-950/60' : ''}`}
              >
                <ProductArt sku={p.sku} name={p.name} className="h-9 w-9 rounded-lg text-xs" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    <Highlighted text={p.name} query={value} />
                  </span>
                  <span className="block text-xs text-stone-500 dark:text-stone-400">
                    <Mono>
                      <Highlighted text={p.sku} query={value} />
                    </Mono>
                  </span>
                </span>
                <span className="text-right">
                  <span className="block text-sm font-semibold tabular-nums">
                    {formatMoney(p.priceCents, p.currency)}
                  </span>
                  <StockIndicator stock={p.stockAvailable} />
                </span>
              </li>
            ))}
          </ul>
          {suggestions.length === 0 && (
            <p className="px-4 pb-3 pt-1.5 text-sm text-stone-600 dark:text-stone-400">
              {loading
                ? 'No matches yet. Still loading the catalog…'
                : `No products match “${value.trim()}”.`}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200/80 bg-stone-50 px-4 py-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-950/50 dark:text-stone-400">
            <span>
              {matches.length > suggestions.length
                ? `Press Enter to see all ${String(matches.length)} results.`
                : matches.length > 0
                  ? 'Press Enter to show the results.'
                  : ''}
              {coverage && ` ${coverage}`}
            </span>
            {failed && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                onClick={onRetry}
                className="rounded font-semibold text-brand-700 underline-offset-2 hover:underline dark:text-brand-300"
              >
                Retry loading
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
