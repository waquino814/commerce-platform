import type { ReactNode } from 'react';
import { isTerminal, type OrderSummary } from '../api';
import {
  FAILURE_TEXT,
  formatClock,
  formatDate,
  formatMoney,
  plural,
  shortId,
  STATUS_HELP,
} from '../format';
import { Link } from '../router';
import { CopyButton } from './CopyButton';
import { ArrowRightIcon } from './icons';
import { ProductArt } from './ProductArt';
import { BUTTON, Mono, StatusBadge, SURFACE } from './ui';

function Meta({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-[0.7rem] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-medium text-stone-900 dark:text-stone-100">{children}</dd>
    </div>
  );
}

/**
 * One order in "Your Orders", from the list summary alone: when, how much, how many, its status,
 * and the first items. In-progress orders offer "Track order", which opens the details page and
 * its live polling; there is no polling here.
 */
export function OrderCard({ order: o }: { order: OrderSummary }) {
  const live = !isTerminal(o.status);
  const titleId = `order-${o.id}-title`;
  const preview = o.items ?? null;
  const more = preview ? o.itemCount - preview.length : 0;
  return (
    <article aria-labelledby={titleId} className={`${SURFACE} overflow-hidden`}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-stone-200/80 bg-stone-50/80 px-5 py-3.5 sm:flex sm:flex-wrap sm:items-start sm:gap-x-10 dark:border-stone-800 dark:bg-stone-950/40">
        <Meta label="Order placed">
          <time dateTime={o.createdAt}>{formatDate(o.createdAt)}</time>
          <span className="block text-xs font-normal text-stone-500 dark:text-stone-400">
            {formatClock(o.createdAt)}
          </span>
        </Meta>
        <Meta label="Total">
          <span className="tabular-nums">{formatMoney(o.totalCents, o.currency)}</span>
        </Meta>
        <Meta label="Items">
          {plural(o.itemCount, 'product')}
          <span className="block text-xs font-normal text-stone-500 dark:text-stone-400">
            {plural(o.totalQuantity, 'unit')}
          </span>
        </Meta>
        <Meta label="Order #" className="sm:ml-auto sm:text-right">
          <span className="flex items-center gap-1 sm:justify-end">
            <Mono className="text-[0.95em]">{shortId(o.id)}</Mono>
            <CopyButton value={o.id} label={`Copy order ID ${o.id}`} />
          </span>
        </Meta>
      </dl>

      <div className="flex flex-col gap-4 px-5 py-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <h3 id={titleId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="sr-only">Order {o.id}:</span>
            <StatusBadge status={o.status} />
            <span className="text-sm text-stone-600 dark:text-stone-400">
              {live ? `${STATUS_HELP[o.status]} Still in progress.` : STATUS_HELP[o.status]}
            </span>
          </h3>
          {o.failureReason && (
            <p className="text-sm font-medium text-rose-700 dark:text-rose-300">
              {FAILURE_TEXT[o.failureReason]}
            </p>
          )}
          {preview ? (
            <ul className="space-y-2" aria-label="Items in this order">
              {preview.map((i) => (
                <li key={i.sku} className="flex items-center gap-3">
                  <ProductArt sku={i.sku} name={i.name} className="h-9 w-9 rounded-lg text-xs" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{i.name}</span>
                    <span className="block text-xs text-stone-500 dark:text-stone-400">
                      <Mono>{i.sku}</Mono> · Qty {i.quantity}
                    </span>
                  </span>
                </li>
              ))}
              {more > 0 && (
                <li className="pl-12 text-xs text-stone-600 dark:text-stone-400">
                  and {plural(more, 'more product')}
                </li>
              )}
            </ul>
          ) : (
            <p className="text-sm text-stone-600 dark:text-stone-400">
              Item details are on the order page.
            </p>
          )}
        </div>
        <div className="flex shrink-0 md:w-48 md:justify-end">
          <Link
            href={`/orders/${o.id}`}
            className={`${live ? BUTTON.primary : BUTTON.secondary} w-full md:w-auto`}
            aria-label={`${live ? 'Track order' : 'View order details'} ${o.id}`}
          >
            {live ? 'Track order' : 'View order details'}
            <ArrowRightIcon />
          </Link>
        </div>
      </div>
    </article>
  );
}
