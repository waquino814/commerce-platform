import type { ReactNode } from 'react';
import { isTerminal, type OrderStatus } from '../api';
import { STATUS_TEXT } from '../format';
import { AlertIcon, CheckIcon, ClockIcon, RefreshIcon, Spinner, XIcon } from './icons';

/**
 * The shared visual system: surfaces, buttons, inputs, the status badge, and the loading, empty
 * and error states. Colors come from the brand and stone scales in styles.css.
 */
export const SURFACE =
  'rounded-2xl border border-stone-200/80 bg-white shadow-card dark:border-stone-800 dark:bg-stone-900';

export function Card({
  title,
  description,
  children,
  actions,
  className = '',
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${SURFACE} p-5 sm:p-6 ${className}`}>
      {(title ?? actions) && (
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-sm text-stone-600 dark:text-stone-400">{description}</p>
            )}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600 dark:text-brand-400">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {title}
        </h1>
        {description && (
          <p className="mt-2 text-[0.95rem] text-pretty text-stone-600 dark:text-stone-400">
            {description}
          </p>
        )}
      </div>
      {actions}
    </header>
  );
}

const STATUS_STYLE: Record<OrderStatus, string> = {
  pending:
    'bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-950/60 dark:text-sky-300 dark:ring-sky-400/20',
  processing:
    'bg-brand-50 text-brand-800 ring-brand-600/20 dark:bg-brand-950/60 dark:text-brand-300 dark:ring-brand-400/20',
  payment_unknown:
    'bg-amber-50 text-amber-900 ring-amber-600/25 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-400/20',
  paid: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-400/20',
  failed:
    'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-950/60 dark:text-rose-300 dark:ring-rose-400/20',
};

function StatusIcon({ status }: { status: OrderStatus }) {
  if (status === 'paid') return <CheckIcon />;
  if (status === 'failed') return <XIcon />;
  if (status === 'pending') return <ClockIcon />;
  return <Spinner />;
}

export function StatusBadge({ status, size = 'sm' }: { status: OrderStatus; size?: 'sm' | 'lg' }) {
  const sizing = size === 'lg' ? 'gap-2 px-3.5 py-1.5 text-sm' : 'gap-1.5 px-2.5 py-1 text-xs';
  return (
    <span
      data-status={status}
      data-terminal={isTerminal(status) || undefined}
      className={`inline-flex shrink-0 items-center rounded-full font-semibold ring-1 ring-inset ${sizing} ${STATUS_STYLE[status]}`}
    >
      <StatusIcon status={status} />
      {STATUS_TEXT[status]}
    </span>
  );
}

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500';
const BASE = `inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed ${FOCUS}`;
export const BUTTON = {
  primary: `${BASE} bg-brand-600 px-4 py-2.5 text-white shadow-sm hover:bg-brand-700 active:bg-brand-800 disabled:bg-brand-600/50 dark:disabled:bg-brand-600/40`,
  secondary: `${BASE} border border-stone-300 bg-white px-3.5 py-2 text-stone-800 shadow-sm hover:border-stone-400 hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800`,
  ghost: `${BASE} px-2.5 py-2 text-stone-600 hover:bg-stone-100 hover:text-stone-900 disabled:opacity-40 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100`,
  danger: `${BASE} bg-rose-600 px-3.5 py-2 text-white hover:bg-rose-700`,
  link: `rounded font-medium text-brand-700 underline-offset-4 hover:underline dark:text-brand-300 ${FOCUS}`,
};

export const INPUT =
  'block w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm shadow-sm transition-colors placeholder:text-stone-400 hover:border-stone-400 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15 aria-[invalid=true]:border-rose-500 aria-[invalid=true]:focus:ring-rose-500/15 dark:border-stone-700 dark:bg-stone-950 dark:hover:border-stone-600';

export function LoadingState({
  label,
  variant = 'rows',
}: {
  label: string;
  variant?: 'rows' | 'grid';
}) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {variant === 'grid' ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="overflow-hidden rounded-2xl border border-stone-200/80 dark:border-stone-800"
            >
              <div className="aspect-[4/3] motion-safe:animate-pulse bg-stone-200/70 dark:bg-stone-800" />
              <div className="space-y-2 p-4">
                <div className="h-4 w-2/3 rounded motion-safe:animate-pulse bg-stone-200 dark:bg-stone-800" />
                <div className="h-3 w-1/3 rounded motion-safe:animate-pulse bg-stone-200 dark:bg-stone-800" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-14 rounded-xl motion-safe:animate-pulse bg-stone-200/70 dark:bg-stone-800"
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-12 text-center dark:border-stone-700 dark:bg-stone-900/40"
    >
      {icon && (
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-stone-100 text-xl text-stone-500 dark:bg-stone-800 dark:text-stone-400">
          {icon}
        </div>
      )}
      <p className="font-semibold">{title}</p>
      {children && (
        <div className="mt-1.5 text-sm text-stone-600 dark:text-stone-400">{children}</div>
      )}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  error,
  onRetry,
  retryLabel = 'Try again',
}: {
  title?: string;
  error: Error;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-900 sm:p-5 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-200"
    >
      <AlertIcon className="mt-0.5 shrink-0 text-lg text-rose-600 dark:text-rose-400" />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5 text-sm break-words">{error.message}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className={`${BUTTON.danger} mt-3`}>
            <RefreshIcon />
            {retryLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <code className={`font-mono text-[0.85em] break-all ${className}`}>{children}</code>;
}
