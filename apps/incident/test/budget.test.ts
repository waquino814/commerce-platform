import { describe, expect, it } from 'vitest';
import {
  budgetedCommand,
  budgetedFetch,
  CategorizedError,
  nodeRunCommand,
  raceSignals,
  REAL_TIMERS,
  sleep,
  withTimeout,
  type BudgetOptions,
  type SignalRunCommand,
} from '../src/budget.js';
import { FakeTime, fakeFetch, type Reply } from './support.js';

/** M5c section 7: deadlines, retries and classification, on a fake clock. */
function setup(time: FakeTime, overrides: Partial<BudgetOptions> = {}) {
  const interrupt = new AbortController();
  const options: BudgetOptions = {
    monotonic: time.monotonic,
    timers: time.timers,
    sourceDeadline: time.now + 40_000,
    globalDeadline: time.now + 600_000,
    interrupt: interrupt.signal,
    attemptTimeoutMs: 10_000,
    ...overrides,
  };
  return { options, interrupt };
}

function sequence(replies: Reply[]) {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)] ?? { status: 200 };
}

const category = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof CategorizedError ? err.category : `other: ${String(err)}`;
  }
};

describe('budgetedFetch', () => {
  it('returns the first success, with its body', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, () => ({ status: 200, body: { ok: true } }));
    const { options } = setup(time);
    const b = budgetedFetch(stub.fetch, options);
    const res = await time.run(b.fetch('http://127.0.0.1:9090/x'));
    expect(await res.json()).toEqual({ ok: true });
    expect(b.state).toEqual({ lastStatus: 200, attempts: 1 });
    b.dispose();
  });

  it('retries 502, 503, 504 and transport errors with a 2 s pause, at most 3 attempts', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(
      time,
      sequence([{ status: 503 }, { transportError: true }, { status: 200, body: 1 }]),
    );
    const { options } = setup(time);
    const b = budgetedFetch(stub.fetch, options);
    const res = await time.run(b.fetch('http://h/x'));
    expect(res.status).toBe(200);
    expect(stub.calls.map((c) => c.at)).toEqual([0, 2001, 4002]);
    b.dispose();
  });

  it('after 3 retryable HTTP failures returns the last response for the client to report', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, () => ({ status: 504 }));
    const b = budgetedFetch(stub.fetch, setup(time).options);
    const res = await time.run(b.fetch('http://h/x'));
    expect(res.status).toBe(504);
    expect(stub.calls).toHaveLength(3);
    b.dispose();
  });

  it('three transport failures throw transport', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, () => ({ transportError: true }));
    const b = budgetedFetch(stub.fetch, setup(time).options);
    expect(await time.run(category(b.fetch('http://h/x')))).toBe('transport');
    expect(stub.calls).toHaveLength(3);
    b.dispose();
  });

  it('does not retry other statuses, including 4xx', async () => {
    for (const status of [400, 404, 500, 501]) {
      const time = new FakeTime();
      const stub = fakeFetch(time, () => ({ status }));
      const b = budgetedFetch(stub.fetch, setup(time).options);
      expect((await time.run(b.fetch('http://h/x'))).status).toBe(status);
      expect(stub.calls).toHaveLength(1);
      b.dispose();
    }
  });

  it('an attempt timeout is retryable; three of them take 3 × 10 + 2 × 2 = 34 s, within 40 s', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, () => ({ hang: true }));
    const b = budgetedFetch(stub.fetch, setup(time).options);
    const p = category(b.fetch('http://h/x'));
    expect(await time.run(p)).toBe('timeout');
    expect(stub.calls.map((c) => c.at)).toEqual([0, 12_000, 24_000]);
    expect(time.now).toBe(34_000);
    b.dispose();
  });

  it('Jaeger arithmetic: 3 × 15 + 2 × 2 = 49 s fits within its 50 s budget', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, () => ({ hang: true }));
    const b = budgetedFetch(
      stub.fetch,
      setup(time, { sourceDeadline: 50_000, attemptTimeoutMs: 15_000 }).options,
    );
    expect(await time.run(category(b.fetch('http://h/x')))).toBe('timeout');
    expect(stub.calls).toHaveLength(3);
    expect(time.now).toBe(49_000);
    b.dispose();
  });

  it('pauses only when another attempt fits: pause + 1 s must remain', async () => {
    const time = new FakeTime();
    // 2.5 s left after the first failure: less than the 2 s pause plus the 1 s guard.
    const stub = fakeFetch(time, () => ({ status: 503, latencyMs: 2_500 }));
    const b = budgetedFetch(stub.fetch, setup(time, { sourceDeadline: 5_000 }).options);
    const res = await time.run(b.fetch('http://h/x'));
    expect(res.status).toBe(503);
    expect(stub.calls).toHaveLength(1);
    expect(time.now).toBe(2_500);
    b.dispose();
  });

  it('the source deadline aborts the in-flight attempt: timeout, no retry, nothing starts after it', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, () => ({ hang: true }));
    const b = budgetedFetch(
      stub.fetch,
      setup(time, { sourceDeadline: 3_000, attemptTimeoutMs: 10_000 }).options,
    );
    expect(await time.run(category(b.fetch('http://h/x')))).toBe('timeout');
    expect(time.now).toBe(3_000);
    expect(await time.run(category(b.fetch('http://h/y')))).toBe('timeout');
    expect(stub.calls).toHaveLength(1);
    b.dispose();
  });

  it('the global deadline gives deadline, and a signal gives interrupted', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, () => ({ hang: true }));
    const b = budgetedFetch(stub.fetch, setup(time, { globalDeadline: 2_000 }).options);
    expect(await time.run(category(b.fetch('http://h/x')))).toBe('deadline');
    b.dispose();

    const t2 = new FakeTime();
    const s2 = fakeFetch(t2, () => ({ hang: true }));
    const { options, interrupt } = setup(t2);
    const b2 = budgetedFetch(s2.fetch, options);
    const p = category(b2.fetch('http://h/x'));
    t2.timers.setTimeout(() => {
      interrupt.abort('SIGINT');
    }, 500);
    expect(await t2.run(p)).toBe('interrupted');
    expect(await t2.run(category(b2.fetch('http://h/x')))).toBe('interrupted');
    b2.dispose();
  });

  it('the guard keeps a deadline out of the pause; an interrupt during the pause stops the retry', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, () => ({ status: 503, latencyMs: 1 }));
    const { options, interrupt } = setup(time);
    const b = budgetedFetch(stub.fetch, options);
    const p = category(b.fetch('http://h/x'));
    time.timers.setTimeout(() => {
      interrupt.abort('SIGINT');
    }, 1_000);
    expect(await time.run(p)).toBe('interrupted');
    expect(stub.calls).toHaveLength(1);
    b.dispose();
  });

  it('covers reading the body: a body that never ends is an attempt timeout', async () => {
    const time = new FakeTime();
    const fetch = (_url: string, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => {
                controller.error(new Error('aborted'));
              });
            },
          }),
          { status: 200 },
        ),
      );
    const b = budgetedFetch(
      fetch,
      setup(time, { sourceDeadline: 25_000, attemptTimeoutMs: 10_000 }).options,
    );
    expect(await time.run(category(b.fetch('http://h/x')))).toBe('timeout');
    // 10 s, pause, 10 s, pause, then a 1 s attempt cut by the 25 s source deadline.
    expect(b.state.attempts).toBe(3);
    expect(time.now).toBe(25_000);
    b.dispose();
  });
});

describe('budgetedCommand', () => {
  const base = (time: FakeTime, interrupt = new AbortController()) => ({
    monotonic: time.monotonic,
    timers: time.timers,
    sourceDeadline: time.now + 30_000,
    globalDeadline: time.now + 600_000,
    interrupt: interrupt.signal,
    commandTimeoutMs: 15_000,
  });

  it('returns the result of a command that finishes', async () => {
    const time = new FakeTime();
    const run: SignalRunCommand = () => Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '' });
    const cmd = budgetedCommand(run, base(time));
    expect(await time.run(cmd('docker', ['compose']))).toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
  });

  it('kills at min(15 s, remaining), reports timeout, and notes an unreaped process', async () => {
    const time = new FakeTime();
    const unreaped: string[] = [];
    const run: SignalRunCommand = (_c, _a, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('killed'), { reaped: false }));
        });
      });
    const cmd = budgetedCommand(run, { ...base(time), onUnreaped: (c) => unreaped.push(c) });
    expect(await time.run(category(cmd('docker', ['compose', 'logs'])))).toBe('timeout');
    expect(time.now).toBe(15_000);
    expect(unreaped).toEqual(['docker']);
    // 15 s left of the 30 s budget: the second command gets 15 s, then nothing is left.
    expect(await time.run(category(cmd('docker', ['compose', 'logs'])))).toBe('timeout');
    expect(await time.run(category(cmd('docker', ['compose', 'logs'])))).toBe('timeout');
    expect(time.now).toBe(30_000);
  });

  it('classifies a failed command, an interrupt and the global deadline', async () => {
    const time = new FakeTime();
    const failing: SignalRunCommand = () => Promise.reject(new Error('spawn docker ENOENT'));
    expect(await time.run(category(budgetedCommand(failing, base(time))('docker', [])))).toBe(
      'command',
    );
    const interrupt = new AbortController();
    interrupt.abort('SIGTERM');
    expect(
      await time.run(category(budgetedCommand(failing, base(time, interrupt))('docker', []))),
    ).toBe('interrupted');
    const late = { ...base(time), globalDeadline: time.now - 1 };
    expect(await time.run(category(budgetedCommand(failing, late)('docker', [])))).toBe('deadline');
  });
});

describe('nodeRunCommand (a real local process, no Docker)', () => {
  it('captures output and the exit code', async () => {
    const res = await nodeRunCommand(
      process.execPath,
      ['-e', 'process.stdout.write("hi"); process.exit(3)'],
      new AbortController().signal,
    );
    expect(res).toMatchObject({ exitCode: 3, stdout: 'hi', reaped: true });
  });

  it('kills the process on abort and rejects at once', async () => {
    const controller = new AbortController();
    const p = nodeRunCommand(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000)'],
      controller.signal,
    );
    setTimeout(() => {
      controller.abort(new Error('stop'));
    }, 50);
    await expect(p).rejects.toMatchObject({ message: 'stop', reaped: false });
  });

  it('rejects an already-aborted signal and a missing command', async () => {
    const controller = new AbortController();
    controller.abort(new Error('early'));
    await expect(nodeRunCommand(process.execPath, [], controller.signal)).rejects.toThrow('early');
    await expect(
      nodeRunCommand('definitely-not-a-command-xyz', [], new AbortController().signal),
    ).rejects.toThrow();
  });
});

describe('waits', () => {
  it('sleep, raceSignals and withTimeout honor their signals', async () => {
    const time = new FakeTime();
    const c = new AbortController();
    const p = sleep(time.timers, 1_000, [c.signal]);
    c.abort(new Error('cut'));
    await expect(p).rejects.toThrow('cut');
    const aborted = new AbortController();
    aborted.abort(new Error('already'));
    await expect(sleep(time.timers, 1, [aborted.signal])).rejects.toThrow('already');
    await expect(raceSignals(Promise.resolve(1), [aborted.signal])).rejects.toThrow('already');
    await expect(raceSignals(Promise.reject(new Error('inner')), [])).rejects.toThrow('inner');
    expect(await time.run(withTimeout(time.timers, 100, Promise.resolve(5), 'x'))).toBe(5);
    expect(
      await time.run(category(withTimeout(time.timers, 100, new Promise(() => undefined), 'x'))),
    ).toBe('timeout');
    await sleep(REAL_TIMERS, 1);
  });
});
