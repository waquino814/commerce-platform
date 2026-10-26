import { useEffect, useId, useState } from 'react';
import { api, ApiError, ORDER_STATUSES, type OrderStatus, type OrderSummary } from '../api';
import { ReceiptIcon, RefreshIcon, SearchIcon, Spinner, XIcon } from '../components/icons';
import { OrderCard } from '../components/OrderCard';
import { BUTTON, EmptyState, ErrorState, LoadingState, PageHeader } from '../components/ui';
import { STATUS_TEXT, plural } from '../format';
import { Link } from '../router';

export const HISTORY_PAGE = 20;
export const SEARCH_DEBOUNCE_MS = 300;

type Request = { after: string | null; status: OrderStatus | null; q: string | null; n: number };

/** The search the API runs: an order-ID prefix (a leading # is ignored), or part of a SKU or name. */
export function orderQuery(raw: string): string | null {
  const q = raw.trim().replace(/^#/, '').trim();
  return q === '' ? null : q.slice(0, 100);
}

/**
 * "Your Orders": GET /orders, newest first, paged by cursor. Search and the status filter run on
 * the server across every order, so a filter never hides orders that simply weren't loaded yet.
 * Any change to them starts again from the first page, so a cursor is only ever reused under the
 * filter that produced it. The API has no customer identity: these are all orders on this store.
 */
export function OrdersPage() {
  const searchId = useId();
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [request, setRequest] = useState<Request>({ after: null, status: null, q: null, n: 0 });
  const [state, setState] = useState<'loading' | 'idle' | { error: Error }>('loading');

  // Debounce typing; a new search or filter always restarts from the first page.
  useEffect(() => {
    const q = orderQuery(input);
    if (q === request.q) return;
    const t = setTimeout(() => {
      setRequest((r) => ({ after: null, status: r.status, q, n: r.n + 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [input, request.q]);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    // A first page (new search, filter or refresh) replaces the list, so orders from another
    // filter are never shown under this one, not even next to an error.
    if (request.after === null) {
      setOrders([]);
      setCursor(null);
    }
    api
      .orders(
        { after: request.after, limit: HISTORY_PAGE, status: request.status, q: request.q },
        controller.signal,
      )
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          setOrders((os) => (request.after === null ? page.items : [...os, ...page.items]));
          setCursor(page.nextCursor);
          setState('idle');
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({ error: error instanceof Error ? error : new Error(String(error)) });
        },
      );
    return () => {
      controller.abort();
    };
  }, [request]);

  const filtering = request.q !== null || request.status !== null;
  const pendingSearch = orderQuery(input) !== request.q;
  const firstLoad = state === 'loading' && request.after === null;
  const choose = (s: OrderStatus | null) => {
    setStatus(s);
    setRequest((r) => ({ after: null, status: s, q: orderQuery(input), n: r.n + 1 }));
  };
  const refresh = () => {
    setRequest((r) => ({ ...r, after: null, n: r.n + 1 }));
  };
  const clearAll = () => {
    setInput('');
    setStatus(null);
    setRequest((r) => ({ after: null, status: null, q: null, n: r.n + 1 }));
  };
  const error = typeof state === 'object' ? state.error : null;
  // Orders APIs built before M7's filters reject the new parameters as unknown.
  const unsupported =
    error instanceof ApiError &&
    error.status === 400 &&
    error.code === 'validation_error' &&
    filtering;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        eyebrow="Orders"
        title="Your Orders"
        description="Every order placed on this store, newest first. There are no customer accounts, so this lists all orders. Open one to follow its status live."
        actions={
          <button
            type="button"
            className={BUTTON.secondary}
            onClick={refresh}
            disabled={state === 'loading'}
          >
            {state === 'loading' ? <Spinner /> : <RefreshIcon />}
            Refresh
          </button>
        }
      />

      <div className="mb-6 space-y-4">
        <div>
          <label htmlFor={searchId} className="sr-only">
            Search orders
          </label>
          <div className="flex h-12 items-center gap-3 rounded-full border border-stone-300 bg-white px-4 shadow-card focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/15 dark:border-stone-700 dark:bg-stone-900">
            <SearchIcon className="shrink-0 text-lg text-stone-500 dark:text-stone-400" />
            <input
              id={searchId}
              type="search"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
              }}
              placeholder="Search by order ID, product name or SKU"
              autoComplete="off"
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent text-[0.95rem] placeholder:text-stone-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden dark:placeholder:text-stone-400"
            />
            {pendingSearch && <Spinner className="shrink-0 text-stone-400" />}
            {input !== '' && (
              <button
                type="button"
                aria-label="Clear order search"
                onClick={() => {
                  setInput('');
                }}
                className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-stone-100"
              >
                <XIcon />
              </button>
            )}
          </div>
        </div>
        <div
          role="group"
          aria-label="Filter by status"
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
        >
          {[null, ...ORDER_STATUSES].map((s) => {
            const on = status === s;
            return (
              <button
                key={s ?? 'all'}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  choose(s);
                }}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${
                  on
                    ? 'bg-stone-900 text-white ring-stone-900 dark:bg-stone-100 dark:text-stone-900 dark:ring-stone-100'
                    : 'bg-white text-stone-700 ring-stone-300 hover:bg-stone-50 dark:bg-stone-900 dark:text-stone-300 dark:ring-stone-700 dark:hover:bg-stone-800'
                }`}
              >
                {s === null ? 'All orders' : STATUS_TEXT[s]}
              </button>
            );
          })}
        </div>
      </div>

      <p
        role="status"
        aria-live="polite"
        className="mb-4 text-sm text-stone-600 dark:text-stone-400"
      >
        {state === 'idle' &&
          orders.length > 0 &&
          `Showing ${plural(orders.length, 'order')}${request.status ? ` · ${STATUS_TEXT[request.status]}` : ''}${request.q ? ` matching “${request.q}”` : ''}${cursor ? '. Older orders load below.' : '.'}`}
      </p>

      {firstLoad && <LoadingState label="Loading orders" />}
      {error && orders.length === 0 && !firstLoad && (
        <ErrorState
          title={
            unsupported ? 'This orders API cannot search or filter yet' : 'Could not load orders'
          }
          error={
            unsupported
              ? new Error(
                  'Search and status filters need an orders API built from this version. Clear them to see all orders.',
                )
              : error
          }
          onRetry={unsupported ? clearAll : refresh}
          retryLabel={unsupported ? 'Clear search and filters' : 'Try again'}
        />
      )}
      {state === 'idle' && orders.length === 0 && !filtering && (
        <EmptyState title="No orders yet" icon={<ReceiptIcon />}>
          Orders placed on this store appear here with their live status.{' '}
          <Link href="/" className={BUTTON.link}>
            Place the first order
          </Link>
        </EmptyState>
      )}
      {state === 'idle' && orders.length === 0 && filtering && (
        <EmptyState title="No orders match" icon={<SearchIcon />}>
          {request.q ? `Nothing matches “${request.q}”` : 'No orders have this status'}
          {request.q && request.status ? ` with status ${STATUS_TEXT[request.status]}` : ''}.{' '}
          <button type="button" className={BUTTON.link} onClick={clearAll}>
            Clear search and filters
          </button>
        </EmptyState>
      )}
      {orders.length > 0 && !firstLoad && (
        <>
          <ol className="space-y-4" aria-label="Orders">
            {orders.map((o) => (
              <li key={o.id}>
                <OrderCard order={o} />
              </li>
            ))}
          </ol>
          {state === 'loading' && (
            <div className="mt-4">
              <LoadingState label="Loading more orders" />
            </div>
          )}
          {error && (
            <div className="mt-4">
              <ErrorState
                title="Could not load more orders"
                error={error}
                onRetry={() => {
                  setRequest((r) => ({ ...r, n: r.n + 1 }));
                }}
              />
            </div>
          )}
          {state === 'idle' && cursor && (
            <div className="mt-6 text-center">
              <button
                type="button"
                className={BUTTON.secondary}
                onClick={() => {
                  setRequest((r) => ({ ...r, after: cursor, n: r.n + 1 }));
                }}
              >
                Load older orders
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
