import type { Order } from '../api';
import { BUTTON, Card, ErrorState, LoadingState, Mono, StatusBadge } from '../components/ui';
import { FAILURE_TEXT, formatDateTime, formatMoney, PAYMENT_TEXT, STATUS_HELP } from '../format';
import { Link } from '../router';
import { POLL_INTERVAL_MS, useOrderPolling } from '../useOrderPolling';

export function OrderDetailPage({ id }: { id: string }) {
  const { order, error, retrying, live } = useOrderPolling(id);

  return (
    <div className="space-y-6">
      <Link href="/orders" className={`${BUTTON.link} text-sm`}>
        ← Order history
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
      {order && <OrderView order={order} live={live} />}
      {order && error && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
          Live updates stopped: {error.message}
        </p>
      )}
      {retrying && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {retrying.error.message} Retrying in {Math.round(retrying.inMs / 1000)} s.
          {order && ' The status shown is the last one received.'}
        </p>
      )}
    </div>
  );
}

function OrderView({ order, live }: { order: Order; live: boolean }) {
  return (
    <>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Order <Mono>{order.id}</Mono>
        </h1>
        <div className="flex flex-wrap items-center gap-3" aria-live="polite">
          <StatusBadge status={order.status} />
          <span className="text-sm text-stone-600 dark:text-stone-400">
            {STATUS_HELP[order.status]}
          </span>
        </div>
        {order.failureReason && (
          <p className="text-sm text-rose-700 dark:text-rose-300">
            {FAILURE_TEXT[order.failureReason]}
          </p>
        )}
        <p className="text-xs text-stone-500 dark:text-stone-400">
          {live
            ? `Updating live every ${String(POLL_INTERVAL_MS / 1000)} s until the order is paid or failed.`
            : 'Final status. Live updates have stopped.'}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card title="Items">
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead className="text-xs text-stone-500 dark:text-stone-400">
                <tr>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Product
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Quantity
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Unit price
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Line total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
                {order.items.map((i) => (
                  <tr key={i.sku}>
                    <td className="px-2 py-2">
                      {i.name}
                      <span className="block text-xs text-stone-500">
                        <Mono>{i.sku}</Mono>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">{i.quantity}</td>
                    <td className="px-2 py-2 text-right">
                      {formatMoney(i.unitPriceCents, order.currency)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {formatMoney(i.lineTotalCents, order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <th scope="row" colSpan={3} className="px-2 pt-3 text-right">
                    Total
                  </th>
                  <td className="px-2 pt-3 text-right">
                    {formatMoney(order.totalCents, order.currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>

        <Card title="Details">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-stone-500">Payment method</dt>
            <dd>{order.paymentMethod ? PAYMENT_TEXT[order.paymentMethod] : '—'}</dd>
            <dt className="text-stone-500">Payment reference</dt>
            <dd>{order.paymentReference ? <Mono>{order.paymentReference}</Mono> : '—'}</dd>
            <dt className="text-stone-500">Placed</dt>
            <dd>{formatDateTime(order.createdAt)}</dd>
            <dt className="text-stone-500">Last updated</dt>
            <dd>{formatDateTime(order.updatedAt)}</dd>
            {order.paidAt && (
              <>
                <dt className="text-stone-500">Paid</dt>
                <dd>{formatDateTime(order.paidAt)}</dd>
              </>
            )}
            {order.failedAt && (
              <>
                <dt className="text-stone-500">Failed</dt>
                <dd>{formatDateTime(order.failedAt)}</dd>
              </>
            )}
            {order.nextAttemptAt && (
              <>
                <dt className="text-stone-500">Next attempt</dt>
                <dd>{formatDateTime(order.nextAttemptAt)}</dd>
              </>
            )}
          </dl>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer rounded text-stone-600 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-stone-400">
              Processing details
            </summary>
            <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
              <dt className="text-stone-500">Processing attempts</dt>
              <dd>{order.processingAttempts}</dd>
              <dt className="text-stone-500">Charge attempts</dt>
              <dd>{order.chargeAttempts}</dd>
              <dt className="text-stone-500">Reconciliation attempts</dt>
              <dd>{order.reconciliationAttempts}</dd>
              <dt className="text-stone-500">Last error</dt>
              <dd>{order.lastError ? <Mono>{order.lastError}</Mono> : '—'}</dd>
            </dl>
          </details>
        </Card>
      </div>
    </>
  );
}
