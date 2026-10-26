import { useCallback, useEffect, useState } from 'react';

/** Loading, success and error states for one API call, with retry and optional polling. */
export type ApiState<T> =
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'success'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: Error };

export function useApi<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { pollMs?: number } = {},
): ApiState<T> & { reload: () => void; refreshing: boolean } {
  const [state, setState] = useState<ApiState<T>>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setRefreshing(true);
    load(controller.signal).then(
      (data) => {
        setState({ status: 'success', data });
        setRefreshing(false);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        });
        setRefreshing(false);
      },
    );
    return () => {
      controller.abort();
    };
    // `load` is recreated each render; `deps` lists what it depends on.
  }, [...deps, tick]);

  useEffect(() => {
    if (!options.pollMs) return;
    const id = setInterval(reload, options.pollMs);
    return () => {
      clearInterval(id);
    };
  }, [options.pollMs, reload]);

  return { ...state, reload, refreshing };
}
