import type { ControllerTimers, Effect } from '../src/controller.js';

/** Timers the test fires by hand. */
export function manualTimers(): ControllerTimers & { fire(): void; pending(): number } {
  let next = 0;
  const timers = new Map<number, () => void>();
  return {
    setTimeout: (fn) => {
      next += 1;
      timers.set(next, fn);
      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    fire() {
      const all = [...timers.values()];
      timers.clear();
      for (const fn of all) fn();
    },
    pending: () => timers.size,
  };
}

/** An effect that records its calls. */
export function recordingEffect(): Effect & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    activate: (seed) => calls.push(`activate:${String(seed)}`),
    deactivate: () => calls.push('deactivate'),
  };
}
