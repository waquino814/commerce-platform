import { spawn } from 'node:child_process';
import type { CommandResult, HttpFetch } from './capture/deps.js';

/**
 * Deadlines, abortable waits and the deadline-aware wrappers the capture clients run through
 * (docs/prompts/m5c-design.md, sections 4 and 7). Every deadline is an absolute time on the
 * injected monotonic clock. Timers fire late when the event loop is busy: the bounds here are when
 * an abort is started, and completion can trail them by that latency, which is not bounded.
 */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}
export interface Monotonic {
  now(): number;
}

export const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => {
    clearTimeout(id as ReturnType<typeof setTimeout>);
  },
};
export const REAL_MONOTONIC: Monotonic = { now: () => performance.now() };

export type FailureCategory =
  | 'transport'
  | 'http'
  | 'malformed-response'
  | 'timeout'
  | 'deadline'
  | 'interrupted'
  | 'command'
  | 'filesystem'
  | 'validation';

/** A failure with its category (docs/prompts/m5c-design.md, section 7, "Classification"). */
export class CategorizedError extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
    this.name = 'CategorizedError';
  }
}

/** A signal aborted after `ms` on the injected timers, with a cancel for when it is no longer needed. */
export function timerSignal(
  timers: Timers,
  ms: number,
  reason: unknown,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const id = timers.setTimeout(
    () => {
      controller.abort(reason);
    },
    Math.max(0, ms),
  );
  return {
    signal: controller.signal,
    cancel: () => {
      timers.clearTimeout(id);
    },
  };
}

/** Waits `ms`, or rejects with the signal's reason as soon as any signal aborts. */
export function sleep(
  timers: Timers,
  ms: number,
  signals: readonly AbortSignal[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = signals.find((s) => s.aborted);
    if (aborted) {
      reject(aborted.reason as Error);
      return;
    }
    const onAbort = (s: AbortSignal) => () => {
      timers.clearTimeout(id);
      reject(s.reason as Error);
    };
    const listeners = signals.map((s) => {
      const fn = onAbort(s);
      s.addEventListener('abort', fn, { once: true });
      return { s, fn };
    });
    const id = timers.setTimeout(
      () => {
        for (const { s, fn } of listeners) s.removeEventListener('abort', fn);
        resolve();
      },
      Math.max(0, ms),
    );
  });
}

/** Resolves with the promise, or rejects with the first aborting signal's reason. */
export function raceSignals<T>(promise: Promise<T>, signals: readonly AbortSignal[]): Promise<T> {
  const aborted = signals.find((s) => s.aborted);
  if (aborted) return Promise.reject(aborted.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    const done = () => {
      for (const c of cleanups) c();
    };
    for (const s of signals) {
      const fn = () => {
        done();
        reject(s.reason as Error);
      };
      s.addEventListener('abort', fn, { once: true });
      cleanups.push(() => {
        s.removeEventListener('abort', fn);
      });
    }
    promise.then(
      (v) => {
        done();
        resolve(v);
      },
      (e: unknown) => {
        done();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Rejects with a `timeout` error after `ms` unless the promise settles first. */
export async function withTimeout<T>(
  timers: Timers,
  ms: number,
  promise: Promise<T>,
  what: string,
): Promise<T> {
  const t = timerSignal(
    timers,
    ms,
    new CategorizedError('timeout', `${what} timed out after ${String(ms)} ms`),
  );
  try {
    return await raceSignals(promise, [t.signal]);
  } finally {
    t.cancel();
  }
}

/** Reads a signal's state; a function, so a check made before an await is not narrowed. */
export const isAborted = (signal: AbortSignal): boolean => signal.aborted;

/** Reasons the wrapper aborts with, so it can tell which deadline fired. */
const SOURCE_DEADLINE = Symbol('source deadline');
const GLOBAL_DEADLINE = Symbol('global deadline');
const ATTEMPT_TIMEOUT = Symbol('attempt timeout');

export interface BudgetOptions {
  monotonic: Monotonic;
  timers: Timers;
  /** Absolute monotonic time at which the source must have finished. */
  sourceDeadline: number;
  /** Absolute monotonic time of the run's global deadline. */
  globalDeadline: number;
  /** Aborted on SIGINT or SIGTERM. */
  interrupt: AbortSignal;
  attemptTimeoutMs: number;
  maxAttempts?: number;
  pauseMs?: number;
  /** Scheduling guard only: no attempt starts with less than this left after the pause. */
  minAttemptMs?: number;
}

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** What the budgeted fetch saw last, so the caller can classify a client's own errors. */
export interface BudgetState {
  lastStatus: number | undefined;
  attempts: number;
}

/**
 * A `fetch` for the M5b capture clients, which call `fetch(url)` with no other options. Each
 * attempt gets one signal combining its own timer, the source deadline, the global deadline and the
 * interrupt, and the response body is read inside the attempt, so body reading is covered too.
 * Retries: network errors, attempt timeouts and HTTP 502, 503 and 504, at most `maxAttempts`, with
 * a pause only when another attempt will follow and still fits before the effective deadline.
 */
export function budgetedFetch(
  fetch: HttpFetch,
  options: BudgetOptions,
): { fetch: HttpFetch; state: BudgetState; dispose: () => void } {
  const maxAttempts = options.maxAttempts ?? 3;
  const pauseMs = options.pauseMs ?? 2000;
  const minAttemptMs = options.minAttemptMs ?? 1000;
  const { monotonic, timers } = options;
  const state: BudgetState = { lastStatus: undefined, attempts: 0 };
  const effective = Math.min(options.sourceDeadline, options.globalDeadline);
  const deadlineReason =
    options.globalDeadline <= options.sourceDeadline ? GLOBAL_DEADLINE : SOURCE_DEADLINE;
  const remaining = () => effective - monotonic.now();
  const deadline = timerSignal(timers, remaining(), deadlineReason);

  const deadlineError = (reason: unknown): CategorizedError => {
    if (options.interrupt.aborted)
      return new CategorizedError('interrupted', 'interrupted by a signal');
    return reason === GLOBAL_DEADLINE
      ? new CategorizedError('deadline', 'the run reached its global deadline')
      : new CategorizedError('timeout', 'the capture source reached its deadline');
  };

  const wrapped: HttpFetch = async (url) => {
    let lastFailure: CategorizedError | undefined;
    let lastResponse: Response | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.interrupt.aborted || deadline.signal.aborted || remaining() <= 0) {
        throw deadlineError(deadline.signal.aborted ? deadline.signal.reason : deadlineReason);
      }
      const attemptTimer = timerSignal(
        timers,
        Math.min(options.attemptTimeoutMs, remaining()),
        ATTEMPT_TIMEOUT,
      );
      const signal = AbortSignal.any([attemptTimer.signal, deadline.signal, options.interrupt]);
      state.attempts += 1;
      try {
        const res = await fetch(url, { signal });
        const body = await res.arrayBuffer();
        state.lastStatus = res.status;
        const copy = new Response(body, { status: res.status, headers: res.headers });
        if (!RETRYABLE_STATUSES.has(res.status)) return copy;
        lastResponse = copy;
        lastFailure = new CategorizedError('http', `HTTP ${String(res.status)} from ${url}`);
      } catch (err) {
        if (isAborted(options.interrupt) || isAborted(deadline.signal)) {
          throw deadlineError(deadline.signal.reason);
        }
        lastResponse = undefined;
        lastFailure = attemptTimer.signal.aborted
          ? new CategorizedError('timeout', `attempt timed out for ${url}`)
          : new CategorizedError(
              'transport',
              `${err instanceof Error ? err.message : String(err)} (${url})`,
            );
      } finally {
        attemptTimer.cancel();
      }
      // A retryable failure: another attempt only if it fits, after the pause.
      if (attempt >= maxAttempts || remaining() < pauseMs + minAttemptMs) break;
      try {
        await sleep(timers, pauseMs, [deadline.signal, options.interrupt]);
      } catch {
        throw deadlineError(deadline.signal.reason);
      }
    }
    // The last HTTP 5xx goes back to the client, which reports it; other failures throw here.
    if (lastResponse) return lastResponse;
    throw lastFailure ?? new CategorizedError('transport', `no attempt was made for ${url}`);
  };
  return { fetch: wrapped, state, dispose: deadline.cancel };
}

/** Runs a command; the signal kills it. */
export type SignalRunCommand = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<CommandResult & { reaped?: boolean }>;

/**
 * The real command runner: on abort the process is sent SIGKILL and the promise rejects at once,
 * without waiting for the process to exit. `reaped` on the error says whether it had exited then.
 */
export const nodeRunCommand: SignalRunCommand = (command, args, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const onAbort = () => {
      child.kill('SIGKILL');
      const err = signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
      Object.assign(err, { reaped: child.exitCode !== null || child.signalCode !== null });
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? -1, stdout, stderr, reaped: true });
    });
  });

/**
 * A `runCommand` for the M5b log client: each command gets `min(commandTimeoutMs, remaining)`, is
 * killed when that runs out, and is never retried.
 */
export function budgetedCommand(
  run: SignalRunCommand,
  options: Omit<BudgetOptions, 'attemptTimeoutMs' | 'maxAttempts' | 'pauseMs' | 'minAttemptMs'> & {
    commandTimeoutMs: number;
    /** Called when a killed process had not exited yet. */
    onUnreaped?: (command: string) => void;
  },
): (command: string, args: readonly string[]) => Promise<CommandResult> {
  const effective = Math.min(options.sourceDeadline, options.globalDeadline);
  return async (command, args) => {
    const remaining = effective - options.monotonic.now();
    if (options.interrupt.aborted)
      throw new CategorizedError('interrupted', 'interrupted by a signal');
    if (remaining <= 0) {
      throw options.globalDeadline <= options.sourceDeadline
        ? new CategorizedError('deadline', 'the run reached its global deadline')
        : new CategorizedError('timeout', 'the capture source reached its deadline');
    }
    const limit = Math.min(options.commandTimeoutMs, remaining);
    const timer = timerSignal(options.timers, limit, ATTEMPT_TIMEOUT);
    try {
      const result = await run(command, args, AbortSignal.any([timer.signal, options.interrupt]));
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      if ((err as { reaped?: boolean }).reaped === false) options.onUnreaped?.(command);
      if (isAborted(options.interrupt))
        throw new CategorizedError('interrupted', 'interrupted by a signal');
      if (timer.signal.aborted) {
        throw new CategorizedError(
          'timeout',
          `${command} ${args.slice(0, 2).join(' ')} timed out after ${String(Math.round(limit))} ms`,
        );
      }
      throw new CategorizedError('command', err instanceof Error ? err.message : String(err));
    } finally {
      timer.cancel();
    }
  };
}
