import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryHandle } from '../src/handle.js';
import { completeShutdown } from '../src/shutdown.js';

function telemetry(events: string[], flush: () => Promise<void>): TelemetryHandle {
  return {
    enabled: true,
    forceFlush: () => {
      events.push('flush-start');
      return flush();
    },
    shutdown: () => {
      events.push('telemetry-shutdown');
      return new Promise(() => undefined);
    },
  };
}

describe('completeShutdown (criterion 17, orchestration)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs cleanup, then a bounded flush, then exits once with the protocol exit code', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const exit = vi.fn((code: number) => events.push(`exit:${code}`));
    const done = completeShutdown({
      exitCode: 1,
      cleanup: () => {
        events.push('cleanup');
        return Promise.resolve();
      },
      telemetry: telemetry(events, () => new Promise(() => undefined)),
      deadlineAt: 8000,
      now: () => 0,
      exit,
      onFlush: (result) => events.push(`flush:${result}`),
    });
    await vi.advanceTimersByTimeAsync(300);
    await done;
    expect(events).toEqual([
      'cleanup',
      'flush-start',
      'flush:timed_out',
      'telemetry-shutdown',
      'exit:1',
    ]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when cleanup fails, as before telemetry existed, and still flushes', async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    await completeShutdown({
      exitCode: 0,
      cleanup: () => Promise.reject(new Error('pool end failed')),
      telemetry: telemetry(events, () => Promise.resolve()),
      deadlineAt: Date.now() + 8000,
      exit: (code) => events.push(`exit:${code}`),
      onCleanupError: (err) => errors.push(err),
    });
    expect(errors).toHaveLength(1);
    expect(events).toEqual(['flush-start', 'telemetry-shutdown', 'exit:1']);
  });

  it('skips the flush near the deadline and exits with the unchanged code', async () => {
    const events: string[] = [];
    await completeShutdown({
      exitCode: 0,
      cleanup: () => Promise.resolve(),
      telemetry: telemetry(events, () => Promise.resolve()),
      deadlineAt: 1000,
      now: () => 900,
      exit: (code) => events.push(`exit:${code}`),
      onFlush: (result) => events.push(`flush:${result}`),
    });
    expect(events).toEqual(['flush:skipped', 'telemetry-shutdown', 'exit:0']);
  });
});
