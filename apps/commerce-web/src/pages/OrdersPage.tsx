import { useEffect, useState } from 'react';
import { api, type OrderSummary } from '../api';
import {
  BUTTON,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Mono,
  StatusBadge,
} from '../components/ui';
import { FAILURE_TEXT, formatDateTime, formatMoney, shortId } from '../format';
import { Link } from '../router';

export const HISTORY_PAGE = 20;

/** Order history from GET /orders: every order, newest first, paged by cursor. */
export function OrdersPage() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [request, setRequest] = useState<{ after: string | null; n: number }>({
    after: null,
    n: 0,
  });
  const [state, setState] = useState<'loading' | 'idle' | { error: Error }>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    api.orders(request.after, HISTORY_PAGE, controller.signal).then(
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

  const refresh = () => {
    setRequest((r) => ({ after: null, n: r.n + 1 }));
  };
  const firstLoad = state === 'loading' && request.after === null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Order history</h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
            All orders, newest first. Open an order to follow its status live.
          </p>
        </div>
        <button
          type="button"
          className={BUTTON.secondary}
          onClick={refresh}
          disabled={state === 'loading'}
        >
          Refresh
        </button>
      </header>

      {firstLoad && <LoadingState label="Loading orders" />}
      {typeof state === 'object' && orders.length === 0 && (
        <ErrorState title="Could not load orders" error={state.error} onRetry={refresh} />
      )}
      {state === 'idle' && orders.length === 0 && (
        <EmptyState title="No orders yet">
          <Link href="/" className={BUTTON.link}>
            Place the first order
          </Link>
        </EmptyState>
      )}
      {orders.length > 0 && !firstLoad && (
        <Card>
          <ul className="divide-y divide-stone-200 dark:divide-stone-800" aria-label="Orders">
            {orders.map((o) => (
              <li
                key={o.id}
                className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <Link
                    href={`/orders/${o.id}`}
                    className={`${BUTTON.link} font-medium`}
                    aria-label={`Order ${o.id}`}
                  >
                    Order <Mono>{shortId(o.id)}</Mono>
                  </Link>
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    {formatDateTime(o.createdAt)}
                  </p>
                </div>
                <p className="text-sm text-stone-600 dark:text-stone-300">
                  {o.totalQuantity} unit(s) of {o.itemCount} product(s) ·{' '}
                  {formatMoney(o.totalCents, o.currency)}
                </p>
                <div className="flex flex-col items-start gap-1 sm:items-end">
                  <StatusBadge status={o.status} />
                  {o.failureReason && (
                    <span className="text-xs text-rose-700 dark:text-rose-300">
                      {FAILURE_TEXT[o.failureReason]}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {state === 'loading' && <LoadingState label="Loading more orders" />}
          {typeof state === 'object' && (
            <ErrorState
              title="Could not load more orders"
              error={state.error}
              onRetry={() => {
                setRequest((r) => ({ ...r, n: r.n + 1 }));
              }}
            />
          )}
          {state === 'idle' && cursor && (
            <button
              type="button"
              className={`${BUTTON.secondary} mt-4 w-full`}
              onClick={() => {
                setRequest((r) => ({ after: cursor, n: r.n + 1 }));
              }}
            >
              Load older orders
            </button>
          )}
        </Card>
      )}
    </div>
  );
}
