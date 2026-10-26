import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from './icons';

/** Copies a value to the clipboard and confirms it on screen and to screen readers. */
export function CopyButton({
  value,
  label,
  className = '',
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => {
      setState('idle');
    }, 2000);
    return () => {
      clearTimeout(t);
    };
  }, [state]);
  const copy = async () => {
    try {
      if (!(navigator as Partial<Navigator>).clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-stone-600 hover:bg-stone-200/70 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-brand-500 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100 ${className}`}
      >
        {state === 'copied' ? <CheckIcon className="text-emerald-600" /> : <CopyIcon />}
        <span aria-hidden="true">
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
        </span>
      </button>
      <span role="status" className="sr-only">
        {state === 'copied'
          ? 'Order ID copied to the clipboard'
          : state === 'failed'
            ? 'Could not copy the order ID'
            : ''}
      </span>
    </span>
  );
}
