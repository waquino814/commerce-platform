import type { ReactNode } from 'react';

/** Shared presentation pieces: cards, badges, and the loading, empty and error states. */
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
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {(title ?? actions) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && (
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = 'ok' | 'bad' | 'warn' | 'neutral';

const TONES: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300',
  bad: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950 dark:text-rose-300',
  warn: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300',
  neutral: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300',
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700"
    >
      <p className="font-medium">{title}</p>
      {children && (
        <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{children}</div>
      )}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
    >
      <p className="font-medium">Could not load this view</p>
      <p className="mt-1 text-sm">{error.message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.85em] break-all">{children}</code>;
}
