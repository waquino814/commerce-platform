import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Product } from './api';

/** Pages requested while building the search index, and the most it will hold. */
export const INDEX_PAGE = 100;
export const INDEX_MAX_PRODUCTS = 5000;

export type IndexStatus = 'idle' | 'loading' | 'complete' | 'capped' | { error: Error };

/**
 * The catalog for search, read once with GET /products' cursor and kept for the session. It
 * starts on first use, fetches one page at a time (never two at once), and stops at the end of
 * the catalog or at INDEX_MAX_PRODUCTS. After an error, `retry` resumes from the last cursor, so
 * no page is skipped or fetched twice. Searching itself never touches the network.
 */
export function useProductIndex() {
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<IndexStatus>('idle');
  const loaded = useRef<Product[]>([]);
  const cursor = useRef<string | null>(null);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setStatus('loading');
    const seen = new Set(loaded.current.map((p) => p.sku));
    try {
      for (;;) {
        const page = await api.products(cursor.current, INDEX_PAGE, abort.signal);
        const fresh = page.items.filter((p) => !seen.has(p.sku));
        for (const p of fresh) seen.add(p.sku);
        loaded.current = [...loaded.current, ...fresh];
        setProducts(loaded.current);
        cursor.current = page.nextCursor;
        if (page.nextCursor === null) {
          setStatus('complete');
          break;
        }
        if (loaded.current.length >= INDEX_MAX_PRODUCTS) {
          setStatus('capped');
          break;
        }
      }
    } catch (err) {
      if (!abort.signal.aborted)
        setStatus({ error: err instanceof Error ? err : new Error(String(err)) });
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  return {
    products,
    status,
    /** Starts loading on first use; later calls do nothing. */
    ensure: () => {
      if (status === 'idle') void load();
    },
    retry: () => {
      if (typeof status === 'object') void load();
    },
  };
}
