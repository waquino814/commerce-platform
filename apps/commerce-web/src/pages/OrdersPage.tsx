import { useEffect, useState } from 'react';
import { api, type OrderSummary } from '../api';
import { ArrowRightIcon, ReceiptIcon, RefreshIcon, Spinner } from '../components/icons';
import {
  BUTTON,
  EmptyState,
  ErrorState,
  LoadingState,
  Mono,
  PageHeader,
  StatusBadge,
  SURFACE,
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
    <div>
      <PageHeader
        eyebrow="Account"
        title="Order history"
        description="All orders, newest first. Open an order to follow its status live."
        actions={
          <button
            type="button"
            className={BUTTON.secondary}
            onClick={refresh}
            disabled={state === 'loading'}
          >
            {firstLoad ? <Spinner /> : <RefreshIcon />}
            Refresh
          </button>
        }
      />

      {firstLoad && <LoadingState label="Loading orders" />}
      {typeof state === 'object' && orders.length === 0 && (
        <ErrorState title="Could not load orders" error={state.error} onRetry={refresh} />
      )}
      {state === 'idle' && orders.length === 0 && (
        <EmptyState title="No orders yet" icon={<ReceiptIcon />}>
          Orders you place appear here with their live status.{' '}
          <Link href="/" className={BUTTON.link}>
            Place the first order
          </Link>
        </EmptyState>
      )}
      {orders.length > 0 && !firstLoad && (
        <section className={`${SURFACE} overflow-hidden`}>
          <div
            aria-hidden="true"
            className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] gap-4 border-b border-stone-200/80 bg-stone-50/80 px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-stone-500 md:grid dark:border-stone-800 dark:bg-stone-950/40 dark:text-stone-400"
          >
            <span>Order</span>
            <span>Placed</span>
            <span>Items</span>
            <span className="text-right">Total</span>
            <span className="w-36 text-right">Status</span>
          </div>
          <ul className="divide-y divide-stone-200/80 dark:divide-stone-800" aria-label="Orders">
            {orders.map((o) => (
              <li
                key={o.id}
                className="group relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-stone-50 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] md:items-center dark:hover:bg-stone-800/40"
              >
                <div className="min-w-0">
                  <Link
                    href={`/orders/${o.id}`}
                    className="font-semibold text-stone-900 after:absolute after:inset-0 after:content-[''] focus-visible:outline-none dark:text-stone-100"
                    aria-label={`Order ${o.id}`}
                  >
                    <span className="text-stone-500 dark:text-stone-400">#</span>
                    <Mono className="text-[0.95em]">{shortId(o.id)}</Mono>
                  </Link>
                  {o.failureReason && (
                    <p className="mt-0.5 text-xs text-rose-700 dark:text-rose-300">
                      {FAILURE_TEXT[o.failureReason]}
                    </p>
                  )}
                </div>
                <div className="col-start-2 row-start-1 flex justify-end md:col-start-auto md:row-start-auto md:hidden">
                  <StatusBadge status={o.status} />
                </div>
                <p className="text-sm text-stone-600 dark:text-stone-400">
                  <time dateTime={o.createdAt}>{formatDateTime(o.createdAt)}</time>
                </p>
                <p className="text-sm text-stone-600 md:text-stone-700 dark:text-stone-400 dark:md:text-stone-300">
                  {o.itemCount} product{o.itemCount === 1 ? '' : 's'} · {o.totalQuantity} unit
                  {o.totalQuantity === 1 ? '' : 's'}
                </p>
                <p className="col-start-2 row-start-2 text-right text-sm font-semibold tabular-nums md:col-start-auto md:row-start-auto">
                  {formatMoney(o.totalCents, o.currency)}
                </p>
                <div className="hidden w-36 items-center justify-end gap-2 md:flex">
                  <StatusBadge status={o.status} />
                  <ArrowRightIcon className="text-stone-400 transition-transform motion-safe:group-hover:translate-x-0.5" />
                </div>
              </li>
            ))}
          </ul>
          {state === 'loading' && (
            <div className="border-t border-stone-200/80 p-5 dark:border-stone-800">
              <LoadingState label="Loading more orders" />
            </div>
          )}
          {typeof state === 'object' && (
            <div className="border-t border-stone-200/80 p-5 dark:border-stone-800">
              <ErrorState
                title="Could not load more orders"
                error={state.error}
                onRetry={() => {
                  setRequest((r) => ({ ...r, n: r.n + 1 }));
                }}
              />
            </div>
          )}
          {state === 'idle' && cursor && (
            <div className="border-t border-stone-200/80 p-4 text-center dark:border-stone-800">
              <button
                type="button"
                className={BUTTON.secondary}
                onClick={() => {
                  setRequest((r) => ({ after: cursor, n: r.n + 1 }));
                }}
              >
                Load older orders
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
