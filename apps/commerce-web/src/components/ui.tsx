import type { ReactNode } from 'react';
import { isTerminal, type OrderStatus } from '../api';
import { STATUS_TEXT } from '../format';

/** Shared presentation: cards, the status badge, and loading, empty and error states. */
export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6 dark:border-stone-800 dark:bg-stone-900">
      {(title ?? actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const STATUS_TONE: Record<OrderStatus, string> = {
  pending: 'bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-950 dark:text-sky-300',
  processing:
    'bg-indigo-50 text-indigo-800 ring-indigo-600/20 dark:bg-indigo-950 dark:text-indigo-300',
  payment_unknown:
    'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300',
  paid: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-950 dark:text-rose-300',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_TONE[status]}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full bg-current ${isTerminal(status) ? '' : 'animate-pulse'}`}
      />
      {STATUS_TEXT[status]}
    </span>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-xl bg-stone-200 dark:bg-stone-800" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-2xl border border-dashed border-stone-300 p-8 text-center dark:border-stone-700"
    >
      <p className="font-medium">{title}</p>
      {children && (
        <div className="mt-2 text-sm text-stone-500 dark:text-stone-400">{children}</div>
      )}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  error,
  onRetry,
}: {
  title?: string;
  error: Error;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm">{error.message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className={`${BUTTON.danger} mt-3`}>
          Try again
        </button>
      )}
    </div>
  );
}

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500';
export const BUTTON = {
  primary: `inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`,
  secondary: `inline-flex items-center justify-center rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800 ${FOCUS}`,
  danger: `inline-flex items-center justify-center rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 ${FOCUS}`,
  link: `rounded text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-400 ${FOCUS}`,
};

export const INPUT = `block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-stone-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 aria-[invalid=true]:border-rose-500 dark:border-stone-700 dark:bg-stone-950`;

export function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.85em] break-all">{children}</code>;
}
