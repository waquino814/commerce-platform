import { useEffect, useState } from 'react';
import { api, type Product } from './api';

export const CATALOG_PAGE = 12;

export type CatalogStatus = 'loading' | 'idle' | { error: Error };

/** The catalog from GET /products, accumulated page by page with the API's cursor. */
export function useCatalog() {
  const [products, setProducts] = useState<Product[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [request, setRequest] = useState<{ after: string | null; n: number }>({
    after: null,
    n: 0,
  });
  const [status, setStatus] = useState<CatalogStatus>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    api.products(request.after, CATALOG_PAGE, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setProducts((ps) => (request.after === null ? page.items : [...ps, ...page.items]));
        setNextCursor(page.nextCursor);
        setStatus('idle');
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setStatus({ error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => {
      controller.abort();
    };
  }, [request]);

  return {
    products,
    status,
    hasMore: nextCursor !== null,
    loadMore: () => {
      setRequest((r) => ({ after: nextCursor, n: r.n + 1 }));
    },
    retry: () => {
      setRequest((r) => ({ ...r, n: r.n + 1 }));
    },
  };
}
