import { useEffect, useRef, useState } from 'react';
import type { Product } from '../api';
import { prefersReducedMotion, scrollIntoView } from '../dom';
import { normalizeQuery, searchProducts } from '../search';
import type { CatalogStatus } from '../useCatalog';
import type { IndexStatus } from '../useProductIndex';
import { BagIcon, SearchIcon, Spinner } from './icons';
import { ProductCard } from './ProductCard';
import { coverageText } from './ProductSearch';
import { BUTTON, EmptyState, ErrorState, LoadingState, Mono } from './ui';

export const RESULTS_PAGE = 24;

/**
 * The catalog column. With no query it shows the paged catalog from GET /products; with a query
 * it shows every match from the search index, a page of cards at a time. A selected suggestion's
 * card is scrolled into view, briefly highlighted, and its Add button focused.
 */
export function Catalog({
  paged,
  index,
  query,
  selectedSku,
  onAdd,
  inOrder,
  onClearSearch,
}: {
  paged: {
    products: Product[];
    status: CatalogStatus;
    hasMore: boolean;
    loadMore: () => void;
    retry: () => void;
  };
  index: { products: Product[]; status: IndexStatus; retry: () => void };
  query: string;
  /** A product chosen from the suggestions, with a counter so choosing it again re-scrolls. */
  selectedSku: { sku: string; n: number } | null;
  onAdd: (p: Product) => void;
  inOrder: (sku: string) => number;
  onClearSearch: () => void;
}) {
  const searching = normalizeQuery(query) !== '';
  const results = searching ? searchProducts(index.products, query) : [];
  const [limit, setLimit] = useState(RESULTS_PAGE);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const addButtons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    setLimit(RESULTS_PAGE);
  }, [query]);

  // Show the selected product: page far enough to include it, then scroll, focus and highlight.
  useEffect(() => {
    if (!selectedSku) return;
    const at = results.findIndex((p) => p.sku === selectedSku.sku);
    if (at >= limit) setLimit(Math.ceil((at + 1) / RESULTS_PAGE) * RESULTS_PAGE);
    setHighlighted(selectedSku.sku);
    const t = setTimeout(() => {
      setHighlighted(null);
    }, 2500);
    return () => {
      clearTimeout(t);
    };
    // Only a new selection triggers this; `results` and `limit` are read at that moment.
  }, [selectedSku]);

  useEffect(() => {
    if (!highlighted) return;
    const card = document.getElementById(`product-${highlighted}`);
    scrollIntoView(card, { block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    const button = addButtons.current.get(highlighted);
    if (button && !button.disabled) button.focus({ preventScroll: true });
    else card?.focus({ preventScroll: true });
  }, [highlighted, limit]);

  const cards = (list: readonly Product[], q: string) => (
    <ul
      className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 xl:grid-cols-3"
      aria-label={searching ? 'Search results' : 'Products'}
    >
      {list.map((p) => (
        <ProductCard
          key={p.sku}
          ref={(el) => {
            if (el) addButtons.current.set(p.sku, el);
            else addButtons.current.delete(p.sku);
          }}
          product={p}
          inOrder={inOrder(p.sku)}
          query={q}
          highlighted={highlighted === p.sku}
          onAdd={onAdd}
        />
      ))}
    </ul>
  );

  if (searching) {
    const loading = index.status === 'loading' || index.status === 'idle';
    const coverage = coverageText(index.status, index.products.length);
    return (
      <section aria-labelledby="catalog-title">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="catalog-title"
            className="text-lg font-semibold tracking-tight"
            aria-live="polite"
          >
            {results.length} result{results.length === 1 ? '' : 's'} for “{query.trim()}”
          </h2>
          <button type="button" className={BUTTON.link} onClick={onClearSearch}>
            Show all products
          </button>
        </div>
        {coverage && (
          <p className="mb-4 flex items-center gap-2 text-sm text-stone-600 dark:text-stone-400">
            {loading && <Spinner />}
            {coverage}
          </p>
        )}
        {typeof index.status === 'object' && (
          <div className="mb-4">
            <ErrorState
              title="Could not load the whole catalog for search"
              error={index.status.error}
              onRetry={index.retry}
            />
          </div>
        )}
        {results.length > 0 && cards(results.slice(0, limit), query)}
        {results.length === 0 && !loading && (
          <EmptyState title={`No products match “${query.trim()}”`} icon={<SearchIcon />}>
            Search looks at product names and SKUs, such as <Mono>Anchor</Mono> or{' '}
            <Mono>SKU-00042</Mono>.
          </EmptyState>
        )}
        {results.length === 0 && loading && (
          <LoadingState label="Searching the catalog" variant="grid" />
        )}
        {results.length > limit && (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              className={BUTTON.secondary}
              onClick={() => {
                setLimit((l) => l + RESULTS_PAGE);
              }}
            >
              Show more results ({results.length - limit} more)
            </button>
          </div>
        )}
      </section>
    );
  }

  const { products, status } = paged;
  const first = status === 'loading' && products.length === 0;
  return (
    <section aria-labelledby="catalog-title">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="catalog-title" className="text-lg font-semibold tracking-tight">
          Catalog
        </h2>
        {products.length > 0 && (
          <p className="text-sm text-stone-600 dark:text-stone-400">
            {products.length} product{products.length === 1 ? '' : 's'} shown
          </p>
        )}
      </div>
      {first && <LoadingState label="Loading products" variant="grid" />}
      {products.length > 0 && cards(products, '')}
      {typeof status === 'object' && (
        <div className={products.length > 0 ? 'mt-4' : ''}>
          <ErrorState
            title="Could not load the catalog"
            error={status.error}
            onRetry={paged.retry}
          />
        </div>
      )}
      {status === 'idle' && products.length === 0 && (
        <EmptyState title="The catalog is empty" icon={<BagIcon />}>
          Seed it with <Mono>pnpm db:seed</Mono>.
        </EmptyState>
      )}
      {(paged.hasMore || (status === 'loading' && products.length > 0)) &&
        typeof status !== 'object' && (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              className={BUTTON.secondary}
              onClick={paged.loadMore}
              disabled={status === 'loading'}
            >
              {status === 'loading' ? (
                <>
                  <Spinner />
                  Loading products…
                </>
              ) : (
                'Show more products'
              )}
            </button>
          </div>
        )}
      <p className="mt-4 text-xs text-stone-600 dark:text-stone-400">
        Stock is reserved when the order is processed, not when it is placed, so it can change in
        between.
      </p>
    </section>
  );
}
