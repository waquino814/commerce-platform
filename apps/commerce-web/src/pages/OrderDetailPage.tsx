import type { ReactNode } from 'react';
import { isTerminal, type Order, type OrderStatus } from '../api';
import { ArrowLeftIcon, CheckIcon, XIcon } from '../components/icons';
import { ProductArt } from '../components/ProductArt';
import {
  BUTTON,
  Card,
  ErrorState,
  LoadingState,
  Mono,
  StatusBadge,
  SURFACE,
} from '../components/ui';
import { FAILURE_TEXT, formatDateTime, formatMoney, PAYMENT_TEXT, STATUS_HELP } from '../format';
import { Link } from '../router';
import { POLL_INTERVAL_MS, useOrderPolling } from '../useOrderPolling';

export function OrderDetailPage({ id }: { id: string }) {
  const { order, error, retrying, live } = useOrderPolling(id);

  return (
    <div className="space-y-6">
      <Link href="/orders" className={`${BUTTON.ghost} -ml-2.5`}>
        <ArrowLeftIcon />
        Order history
      </Link>
      {!order && !error && <LoadingState label="Loading order" />}
      {error && !order && (
        <ErrorState
          title={
            error.status === 404
              ? 'Order not found'
              : error.status === 400
                ? 'Not a valid order ID'
                : 'Could not load this order'
          }
          error={error}
        />
      )}
      {retrying && (
        <p
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-200"
        >
          {retrying.error.message} Retrying in {Math.round(retrying.inMs / 1000)} s.
          {order && ' The status shown is the last one received.'}
        </p>
      )}
      {order && error && (
        <p
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-200"
        >
          Live updates stopped: {error.message}
        </p>
      )}
      {order && <OrderView order={order} live={live} />}
    </div>
  );
}

type StepState = 'done' | 'current' | 'upcoming' | 'failed';

/** The lifecycle as three steps, derived only from the order's status. */
function steps(status: OrderStatus): { label: string; state: StepState }[] {
  const processing = status === 'payment_unknown' ? 'Confirming payment' : 'Processing';
  if (status === 'pending' || status === 'processing' || status === 'payment_unknown')
    return [
      { label: 'Placed', state: 'done' },
      { label: processing, state: 'current' },
      { label: 'Paid', state: 'upcoming' },
    ];
  if (status === 'paid')
    return [
      { label: 'Placed', state: 'done' },
      { label: 'Processed', state: 'done' },
      { label: 'Paid', state: 'done' },
    ];
  return [
    { label: 'Placed', state: 'done' },
    { label: 'Processed', state: 'done' },
    { label: 'Failed', state: 'failed' },
  ];
}

const DOT: Record<StepState, string> = {
  done: 'bg-brand-600 text-white border-brand-600',
  current:
    'bg-white text-brand-700 border-brand-500 ring-4 ring-brand-500/15 dark:bg-stone-900 dark:text-brand-300',
  upcoming: 'bg-white text-stone-400 border-stone-300 dark:bg-stone-900 dark:border-stone-700',
  failed: 'bg-rose-600 text-white border-rose-600',
};

function Progress({ status }: { status: OrderStatus }) {
  const list = steps(status);
  return (
    <ol className="grid grid-cols-3" aria-label="Order progress">
      {list.map((s, i) => (
        <li
          key={s.label}
          className="relative flex flex-col items-center text-center"
          aria-current={s.state === 'current' ? 'step' : undefined}
        >
          {i > 0 && (
            <span
              aria-hidden="true"
              className={`absolute right-1/2 top-3.5 h-0.5 w-full -translate-y-1/2 ${s.state === 'upcoming' ? 'bg-stone-200 dark:bg-stone-700' : s.state === 'failed' ? 'bg-rose-300 dark:bg-rose-800' : 'bg-brand-500'}`}
            />
          )}
          <span
            className={`relative flex h-7 w-7 items-center justify-center z-10 rounded-full border-2 text-base ${DOT[s.state]}`}
          >
            {s.state === 'done' && <CheckIcon />}
            {s.state === 'failed' && <XIcon />}
            {s.state === 'current' && (
              <span className="h-2 w-2 rounded-full bg-current motion-safe:animate-pulse" />
            )}
          </span>
          <span
            className={`mt-2 text-xs font-medium ${s.state === 'upcoming' ? 'text-stone-500 dark:text-stone-400' : ''}`}
          >
            {s.label}
            <span className="sr-only"> ({s.state})</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function OrderView({ order, live }: { order: Order; live: boolean }) {
  const units = order.items.reduce((n, i) => n + i.quantity, 0);
  return (
    <>
      <section className={`${SURFACE} overflow-hidden`}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-center">
          <header className="min-w-0 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600 dark:text-brand-400">
              Order
            </p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              <span className="sr-only">Order </span>
              <Mono className="text-[0.8em]">{order.id}</Mono>
            </h1>
            <div className="flex flex-wrap items-center gap-3" aria-live="polite">
              <StatusBadge status={order.status} size="lg" />
              <span className="text-sm text-stone-600 dark:text-stone-400">
                {STATUS_HELP[order.status]}
              </span>
            </div>
            {order.failureReason && (
              <p className="text-sm font-medium text-rose-700 dark:text-rose-300">
                {FAILURE_TEXT[order.failureReason]}
              </p>
            )}
            <p className="flex items-center gap-2 text-xs text-stone-600 dark:text-stone-400">
              {live ? (
                <span aria-hidden="true" className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
              ) : (
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-stone-400" />
              )}
              {live
                ? `Updating live every ${String(POLL_INTERVAL_MS / 1000)} s until the order is paid or failed.`
                : 'Final status. Live updates have stopped.'}
            </p>
          </header>
          <div
            className={`rounded-xl p-4 ${isTerminal(order.status) && order.status === 'failed' ? 'bg-rose-50/60 dark:bg-rose-950/30' : 'bg-stone-50 dark:bg-stone-950/50'}`}
          >
            <Progress status={order.status} />
          </div>
        </div>
        <dl className="grid grid-cols-2 border-t border-stone-200/80 sm:grid-cols-4 dark:border-stone-800">
          <Stat label="Total">{formatMoney(order.totalCents, order.currency)}</Stat>
          <Stat label="Items">
            {order.items.length} product{order.items.length === 1 ? '' : 's'} · {units} unit
            {units === 1 ? '' : 's'}
          </Stat>
          <Stat label="Payment">
            {order.paymentMethod ? PAYMENT_TEXT[order.paymentMethod] : '—'}
          </Stat>
          <Stat label="Placed">{formatDateTime(order.createdAt).slice(0, 16)}</Stat>
        </dl>
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card
          title="Items"
          description={`${String(order.items.length)} product${order.items.length === 1 ? '' : 's'} in this order`}
        >
          <div className="-mx-5 overflow-x-auto sm:-mx-6">
            <table className="w-full sm:min-w-[30rem] text-left text-sm">
              <thead className="border-y border-stone-200/80 bg-stone-50/80 text-xs uppercase tracking-wide text-stone-500 dark:border-stone-800 dark:bg-stone-950/40 dark:text-stone-400">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-semibold sm:px-6">
                    Product
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-semibold">
                    Quantity
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-semibold">
                    Unit price
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-right font-semibold sm:px-6">
                    Line total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200/80 dark:divide-stone-800">
                {order.items.map((i) => (
                  <tr key={i.sku}>
                    <td className="px-5 py-3 sm:px-6">
                      <div className="flex items-center gap-3">
                        <ProductArt
                          sku={i.sku}
                          name={i.name}
                          className="hidden h-10 w-10 shrink-0 rounded-lg text-xs sm:flex"
                        />
                        <div className="min-w-0">
                          <span className="font-medium">{i.name}</span>
                          <span className="block text-xs text-stone-500 dark:text-stone-400">
                            <Mono>{i.sku}</Mono>
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{i.quantity}</td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatMoney(i.unitPriceCents, order.currency)}
                    </td>
                    <td className="px-5 py-3 text-right font-medium tabular-nums sm:px-6">
                      {formatMoney(i.lineTotalCents, order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-stone-200/80 dark:border-stone-800">
                <tr className="text-base font-semibold">
                  <th scope="row" colSpan={3} className="px-3 pt-4 text-right">
                    Total
                  </th>
                  <td className="px-5 pt-4 text-right tabular-nums sm:px-6">
                    {formatMoney(order.totalCents, order.currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>

        <Card title="Details">
          <dl className="space-y-3 text-sm">
            <Detail label="Payment method">
              {order.paymentMethod ? PAYMENT_TEXT[order.paymentMethod] : '—'}
            </Detail>
            <Detail label="Payment reference">
              {order.paymentReference ? <Mono>{order.paymentReference}</Mono> : '—'}
            </Detail>
            <Detail label="Placed">{formatDateTime(order.createdAt)}</Detail>
            <Detail label="Last updated">{formatDateTime(order.updatedAt)}</Detail>
            {order.paidAt && <Detail label="Paid">{formatDateTime(order.paidAt)}</Detail>}
            {order.failedAt && <Detail label="Failed">{formatDateTime(order.failedAt)}</Detail>}
            {order.nextAttemptAt && (
              <Detail label="Next attempt">{formatDateTime(order.nextAttemptAt)}</Detail>
            )}
          </dl>
          <details className="group mt-5 rounded-xl border border-stone-200/80 text-sm dark:border-stone-800">
            <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl px-4 py-3 font-medium text-stone-700 hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-stone-800/50">
              Processing details
              <span
                aria-hidden="true"
                className="text-stone-400 transition-transform group-open:rotate-90"
              >
                ›
              </span>
            </summary>
            <dl className="space-y-2 border-t border-stone-200/80 px-4 py-3 dark:border-stone-800">
              <Detail label="Processing attempts">{order.processingAttempts}</Detail>
              <Detail label="Charge attempts">{order.chargeAttempts}</Detail>
              <Detail label="Reconciliation attempts">{order.reconciliationAttempts}</Detail>
              <Detail label="Last error">
                {order.lastError ? <Mono>{order.lastError}</Mono> : '—'}
              </Detail>
            </dl>
          </details>
        </Card>
      </div>
    </>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-stone-200/80 px-5 py-4 odd:border-r sm:border-r sm:last:border-r-0 sm:px-6 dark:border-stone-800 [&:nth-child(-n+2)]:border-b sm:[&:nth-child(-n+2)]:border-b-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
        {label}
      </dt>
      <dd className="mt-1 font-semibold break-words tabular-nums">{children}</dd>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-stone-600 dark:text-stone-400">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}
