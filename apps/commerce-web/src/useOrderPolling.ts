import { useEffect, useState } from 'react';
import { api, ApiError, isTerminal, type Order } from './api';

export const POLL_INTERVAL_MS = 2000;
export const MAX_BACKOFF_MS = 30_000;

export interface OrderPollState {
  order: Order | null;
  /** A failure that ended polling: not found, invalid ID, or a first load that failed for good. */
  error: ApiError | null;
  /** The last transient failure while polling continues, with the delay before the next try. */
  retrying: { error: ApiError; inMs: number } | null;
  /** True while more updates are expected. */
  live: boolean;
}

/**
 * Reads an order, then polls `GET /orders/:id` until it is `paid` or `failed`. One request is in
 * flight at a time: the next is scheduled only after the previous settles. Transient failures
 * (no response, 429, 5xx) keep the last order and back off exponentially up to 30 s; a 4xx ends
 * polling. Unmounting, or a new ID, aborts the request and cancels the timer.
 */
export function useOrderPolling(id: string): OrderPollState {
  const [state, setState] = useState<OrderPollState>({
    order: null,
    error: null,
    retrying: null,
    live: true,
  });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    setState((s) => ({
      order: s.order?.id === id ? s.order : null,
      error: null,
      retrying: null,
      live: true,
    }));

    const tick = async () => {
      try {
        const order = await api.order(id, controller.signal);
        if (controller.signal.aborted) return;
        failures = 0;
        const live = !isTerminal(order.status);
        setState({ order, error: null, retrying: null, live });
        if (live) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = err instanceof ApiError ? err : new ApiError(0, 'network_error', String(err));
        if (!error.transient) {
          setState((s) => ({ ...s, error, retrying: null, live: false }));
          return;
        }
        failures += 1;
        const inMs = Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
        setState((s) => ({ ...s, retrying: { error, inMs }, live: true }));
        timer = setTimeout(() => void tick(), inMs);
      }
    };
    void tick();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id]);

  return state;
}
