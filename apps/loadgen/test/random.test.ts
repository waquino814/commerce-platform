import { describe, expect, it } from 'vitest';
import {
  createRandom,
  createStreams,
  deriveStreamSeed,
  mulberry32,
  splitmix32,
  STREAM_IDS,
  uniformInt,
  type Uint32Source,
} from '../src/random.js';

/**
 * M4 criterion 3. The expected values come from a separate Python implementation of the reference
 * algorithms, not from this code, so a transcription error here would show up as a mismatch.
 */
const take = (next: Uint32Source, n: number) => Array.from({ length: n }, () => next());

/** A source that returns the given values in order. */
function scripted(values: number[]): Uint32Source & { calls: number } {
  const source = Object.assign(
    () => {
      const value = values[source.calls];
      source.calls += 1;
      if (value === undefined) throw new Error('scripted source exhausted');
      return value;
    },
    { calls: 0 },
  );
  return source;
}

describe('generators (criterion 3)', () => {
  it('mulberry32 matches the reference vectors', () => {
    expect(take(mulberry32(42), 5)).toEqual([
      2581720956, 1925393290, 3661312704, 2876485805, 750819978,
    ]);
    expect(take(mulberry32(0), 3)).toEqual([1144304738, 1416247, 958946056]);
    expect(take(mulberry32(2 ** 32 - 1), 2)).toEqual([3850105811, 813802916]);
  });

  it('splitmix32 matches the reference vectors', () => {
    expect(take(splitmix32(42), 3)).toEqual([551831576, 144025891, 322543647]);
  });

  it('derives the documented stream seeds', () => {
    expect(STREAM_IDS).toEqual({
      operation: 1,
      sku: 2,
      quantity: 3,
      payment: 4,
      cursor: 5,
      readTarget: 6,
      itemCount: 7,
    });
    const ids = Object.values(STREAM_IDS);
    expect(ids.map((id) => deriveStreamSeed(42, id))).toEqual([
      453036224, 638181755, 885462075, 2776919239, 1174800263, 1318840058, 3598761854,
    ]);
    expect(ids.map((id) => deriveStreamSeed(7, id))).toEqual([
      3726933447, 1437520376, 3011703609, 3361369063, 3094693240, 255044787, 624292766,
    ]);
  });

  it('streams are independent: draining one leaves the others unchanged', () => {
    const untouched = createStreams(42);
    const drained = createStreams(42);
    for (let i = 0; i < 1000; i += 1) drained.sku.uint32();
    expect(take(drained.operation.uint32, 5)).toEqual(take(untouched.operation.uint32, 5));
    expect(take(drained.payment.uint32, 5)).toEqual(take(untouched.payment.uint32, 5));
    // Each stream is its own mulberry32 sequence from its derived seed.
    expect(take(createStreams(42).quantity.uint32, 3)).toEqual(
      take(mulberry32(deriveStreamSeed(42, STREAM_IDS.quantity)), 3),
    );
  });
});

describe('uniform integer selection (D3)', () => {
  it('maps accepted values by remainder', () => {
    expect(uniformInt(scripted([0]), 10)).toBe(0);
    expect(uniformInt(scripted([7]), 10)).toBe(7);
    expect(uniformInt(scripted([1234567]), 1000)).toBe(567);
    expect(uniformInt(scripted([2 ** 32 - 1]), 1)).toBe(0);
  });

  it('rejects values in the incomplete last block, so every result is equally likely', () => {
    // For n = 1000, 2^32 mod 1000 = 296, so values from 2^32 - 296 upward are rejected.
    const limit = 2 ** 32 - (2 ** 32 % 1000);
    expect(limit).toBe(4_294_967_000);
    const source = scripted([limit, 2 ** 32 - 1, limit - 1]);
    expect(uniformInt(source, 1000)).toBe(999);
    expect(source.calls).toBe(3);
    // With a power of two there is nothing to reject.
    const exact = scripted([2 ** 32 - 1]);
    expect(uniformInt(exact, 256)).toBe(255);
    expect(exact.calls).toBe(1);
  });

  it('accepts exactly floor(2^32 / n) values per result', () => {
    // Every result r in [0, n) is produced by the accepted values r, r + n, r + 2n, ... below the
    // limit: the same count for every r, which is what makes the selection exactly uniform.
    for (const n of [3, 7, 10, 55, 1000]) {
      const limit = 2 ** 32 - (2 ** 32 % n);
      expect(limit % n).toBe(0);
      expect(limit / n).toBe(Math.floor(2 ** 32 / n));
    }
  });

  it('rejects invalid ranges', () => {
    expect(() => uniformInt(scripted([0]), 0)).toThrow(RangeError);
    expect(() => uniformInt(scripted([0]), 2.5)).toThrow(RangeError);
    expect(() => uniformInt(scripted([0]), 2 ** 32 + 1)).toThrow(RangeError);
  });

  it('chance(p) compares against p on the 32-bit grid', () => {
    expect(createRandom(scripted([0])).chance(0.1)).toBe(true);
    expect(createRandom(scripted([Math.round(0.1 * 2 ** 32) - 1])).chance(0.1)).toBe(true);
    expect(createRandom(scripted([Math.round(0.1 * 2 ** 32)])).chance(0.1)).toBe(false);
    expect(createRandom(scripted([2 ** 32 - 1])).chance(1)).toBe(true);
    expect(createRandom(scripted([0])).chance(0)).toBe(false);
  });

  it('supplementary: 100,000 draws over 10 buckets stay within a wide, fixed-seed band', () => {
    // Deterministic seed, so this cannot flake; the band is far wider than sampling noise.
    const random = createRandom(mulberry32(12345));
    const buckets = Array.from({ length: 10 }, () => 0);
    for (let i = 0; i < 100_000; i += 1) {
      const b = random.int(10);
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(9_000);
      expect(count).toBeLessThan(11_000);
    }
  });
});
