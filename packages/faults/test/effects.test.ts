import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createOrderReadFault,
  createPaymentFaults,
  createPoisonFault,
  createPoolLeak,
} from '../src/effects.js';
import { poisonSku } from '../src/scenarios.js';

/** M5a criteria A1 (pass-through when inactive) and A3 (activation, stop and cleanup). */
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 10));
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

describe('bad-deploy-order-reads', () => {
  it('fails nothing while inactive, about 40% of reads from a seeded stream while active', () => {
    const fault = createOrderReadFault();
    expect(Array.from({ length: 100 }, () => fault.shouldFail()).some(Boolean)).toBe(false);
    fault.effect.activate(42);
    const first = Array.from({ length: 1000 }, () => fault.shouldFail());
    const failures = first.filter(Boolean).length;
    expect(failures).toBeGreaterThan(330);
    expect(failures).toBeLessThan(470);
    fault.effect.deactivate();
    expect(fault.shouldFail()).toBe(false);
    // The same seed gives the same sequence.
    fault.effect.activate(42);
    expect(Array.from({ length: 1000 }, () => fault.shouldFail())).toEqual(first);
  });
});

describe('payment-timeouts and provider-outage', () => {
  const errors = {
    unavailable: () => Object.assign(new Error('provider_unavailable'), { code: 'unavailable' }),
    reset: () => Object.assign(new Error('connection_reset'), { code: 'reset' }),
  };
  const provider = {
    charge: (r: { id: string }) => Promise.resolve(`charged:${r.id}`),
    lookupOrVoid: (id: string) => Promise.resolve(`looked:${id}`),
  };

  it('passes calls through unchanged while inactive', async () => {
    const faults = createPaymentFaults(errors);
    const wrapped = faults.wrap(provider);
    expect(await wrapped.charge({ id: 'a' })).toBe('charged:a');
    expect(await wrapped.lookupOrVoid('a')).toBe('looked:a');
  });

  it('outage rejects every charge and lookup as unavailable, then recovers', async () => {
    const faults = createPaymentFaults(errors);
    const wrapped = faults.wrap(provider);
    faults.outage.activate(1);
    await expect(wrapped.charge({ id: 'a' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(wrapped.lookupOrVoid('a')).rejects.toMatchObject({ code: 'unavailable' });
    faults.outage.deactivate();
    expect(await wrapped.charge({ id: 'a' })).toBe('charged:a');
  });

  it('timeouts leave about 60% of charges pending; stop rejects them all, never unhandled', async () => {
    const faults = createPaymentFaults(errors);
    const wrapped = faults.wrap(provider);
    faults.timeouts.activate(42);
    const settled: string[] = [];
    const calls = Array.from({ length: 50 }, (_, i) =>
      wrapped.charge({ id: String(i) }).then(
        (v) => settled.push(v),
        (e: unknown) => settled.push((e as { code: string }).code),
      ),
    );
    await new Promise((r) => setTimeout(r, 5));
    const hung = faults.pendingCount();
    expect(hung).toBeGreaterThan(20);
    expect(hung).toBeLessThan(42);
    expect(await wrapped.lookupOrVoid('x')).toBe('looked:x');
    // A hung call nobody waits for any more is rejected on stop without an unhandled rejection.
    void wrapped.charge({ id: 'abandoned' });
    faults.timeouts.deactivate();
    await Promise.all(calls);
    expect(faults.pendingCount()).toBe(0);
    expect(settled.filter((s) => s === 'reset')).toHaveLength(hung);
    expect(await wrapped.charge({ id: 'after' })).toBe('charged:after');
  });
});

describe('api-pool-exhaustion', () => {
  function stubPool(max: number, failFirst = 0) {
    let open = 0;
    let failures = failFirst;
    const released: number[] = [];
    let id = 0;
    return {
      released,
      open: () => open,
      pool: {
        options: { max },
        connect: () => {
          if (failures > 0) {
            failures -= 1;
            return Promise.reject(new Error('timeout exceeded when trying to connect'));
          }
          open += 1;
          id += 1;
          const mine = id;
          return Promise.resolve({
            release: () => {
              open -= 1;
              released.push(mine);
            },
          });
        },
      },
    };
  }

  it('holds every connection until stop, retrying failed connects, then releases them all', async () => {
    const stub = stubPool(4, 2);
    const leak = createPoolLeak(stub.pool, { sleep: () => Promise.resolve() });
    expect(leak.heldCount()).toBe(0);
    leak.effect.activate(1);
    await leak.settled();
    expect(leak.heldCount()).toBe(4);
    expect(stub.open()).toBe(4);
    leak.effect.deactivate();
    expect(leak.heldCount()).toBe(0);
    expect(stub.open()).toBe(0);
    expect(stub.released).toHaveLength(4);
  });

  it('releases a connection that arrives after stop', async () => {
    let resolveConnect: ((c: { release(): void }) => void) | undefined;
    let releases = 0;
    const pool = {
      options: { max: 1 },
      connect: () =>
        new Promise<{ release(): void }>((r) => {
          resolveConnect = r;
        }),
    };
    const leak = createPoolLeak(pool);
    leak.effect.activate(1);
    leak.effect.deactivate();
    resolveConnect?.({ release: () => (releases += 1) });
    await leak.settled();
    expect(releases).toBe(1);
    expect(leak.heldCount()).toBe(0);
  });
});

describe('poison-order', () => {
  it('returns nothing and makes no query while inactive', () => {
    let queries = 0;
    const fault = createPoisonFault({ skusOf: () => ((queries += 1), Promise.resolve([])) });
    expect(fault.beforeStep('reserve', { id: 'o1' })).toBeUndefined();
    expect(queries).toBe(0);
  });

  it('hangs a pass for an order with the poison SKU until stop, then fails it; others pass', async () => {
    const sku = poisonSku(42);
    const fault = createPoisonFault({
      skusOf: (id) => Promise.resolve(id === 'poisoned' ? ['SKU-00001', sku] : ['SKU-00001']),
    });
    fault.effect.activate(42);
    await expect(fault.beforeStep('reserve', { id: 'clean' })).resolves.toBeUndefined();
    let outcome = 'pending';
    const pass = fault.beforeStep('reserve', { id: 'poisoned' });
    void pass?.then(
      () => (outcome = 'resolved'),
      (e: unknown) => (outcome = (e as Error).message),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(outcome).toBe('pending');
    expect(fault.hungCount()).toBe(1);
    fault.effect.deactivate();
    await new Promise((r) => setTimeout(r, 1));
    expect(outcome).toBe('processing aborted after a stall');
    expect(fault.hungCount()).toBe(0);
    expect(fault.beforeStep('reserve', { id: 'poisoned' })).toBeUndefined();
  });
});
