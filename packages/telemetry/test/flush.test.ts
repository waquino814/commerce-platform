import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushWithinBudget } from '../src/flush.js';

describe('flushWithinBudget (criterion 17)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.useRealTimers();
  });

  it('is still pending at 299 ms and times out at exactly 300 ms for a never-settling flush', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = flushWithinBudget({
      flush: () => new Promise(() => undefined),
      deadlineAt: 10_000,
      now: () => 0,
    }).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ result: 'timed_out', budgetMs: 300 });
  });

  it('reports flushed and failed without throwing', async () => {
    const base = { deadlineAt: 10_000, now: () => 0 };
    expect(await flushWithinBudget({ ...base, flush: () => Promise.resolve() })).toEqual({
      result: 'flushed',
      budgetMs: 300,
    });
    expect(
      await flushWithinBudget({ ...base, flush: () => Promise.reject(new Error('x')) }),
    ).toEqual({
      result: 'failed',
      budgetMs: 300,
    });
    expect(
      await flushWithinBudget({
        ...base,
        flush: () => {
          throw new Error('sync');
        },
      }),
    ).toEqual({ result: 'failed', budgetMs: 300 });
  });

  it('skips without calling flush when under 150 ms remain, and shrinks the budget near the deadline', async () => {
    let calls = 0;
    const flush = (): Promise<void> => {
      calls += 1;
      return Promise.resolve();
    };
    expect(await flushWithinBudget({ flush, deadlineAt: 149, now: () => 0 })).toEqual({
      result: 'skipped',
      budgetMs: 49,
    });
    expect(calls).toBe(0);
    expect((await flushWithinBudget({ flush, deadlineAt: 250, now: () => 0 })).budgetMs).toBe(150);
  });

  it('never produces an unhandled rejection when the flush rejects after the timeout', async () => {
    vi.useFakeTimers();
    let rejectLater: (e: Error) => void = () => undefined;
    const pending = flushWithinBudget({
      flush: () =>
        new Promise((_, reject) => {
          rejectLater = reject;
        }),
      deadlineAt: 10_000,
      now: () => 0,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect((await pending).result).toBe('timed_out');
    rejectLater(new Error('late exporter failure'));
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(unhandled).toEqual([]);
  });
});
