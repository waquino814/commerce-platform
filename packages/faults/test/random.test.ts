import { describe, expect, it } from 'vitest';
import { deriveSeed, mulberry32, splitmix32, stream, uniformInt } from '../src/random.js';

/** The same reference vectors as the M4 load generator, from an independent implementation. */
const take = (next: () => number, n: number) => Array.from({ length: n }, () => next());

describe('fault randomness', () => {
  it('matches the reference vectors', () => {
    expect(take(mulberry32(42), 3)).toEqual([2581720956, 1925393290, 3661312704]);
    expect(take(splitmix32(42), 3)).toEqual([551831576, 144025891, 322543647]);
    expect(deriveSeed(42, 1)).toBe(453036224);
  });

  it('draws exactly uniform integers, and the same stream for the same seed and id', () => {
    let calls = 0;
    const values = [2 ** 32 - 1, 7];
    expect(uniformInt(() => values[calls++] ?? 0, 10)).toBe(7);
    expect(take(() => stream(9, 101)(100), 1)).toEqual(take(() => stream(9, 101)(100), 1));
    const a = stream(9, 101);
    const b = stream(9, 102);
    expect(take(() => a(1000), 5)).not.toEqual(take(() => b(1000), 5));
  });
});
