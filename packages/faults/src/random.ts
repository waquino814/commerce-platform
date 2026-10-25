/**
 * Seeded randomness for fault decisions: the same algorithms as the M4 load generator
 * (mulberry32, with splitmix32 deriving one stream per use), with the same reference vectors in
 * the tests. Not cryptographic.
 */
const TWO_POW_32 = 4_294_967_296;

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** Fixed stream ids. Changing one changes every seed-derived fault decision for that use. */
export const FAULT_STREAMS = Object.freeze({
  orderReadFailures: 101,
  paymentHangs: 102,
  poisonSku: 103,
});

export function deriveSeed(seed: number, streamId: number): number {
  return splitmix32((seed ^ Math.imul(streamId, 0x9e3779b9)) >>> 0)();
}

/** Exactly uniform integer in [0, n), by rejection sampling. */
export function uniformInt(next: () => number, n: number): number {
  const limit = TWO_POW_32 - (TWO_POW_32 % n);
  for (;;) {
    const value = next();
    if (value < limit) return value % n;
  }
}

/** A stream of exactly uniform integers in [0, n) for one use of one seed. */
export function stream(seed: number, streamId: number): (n: number) => number {
  const next = mulberry32(deriveSeed(seed, streamId));
  return (n) => uniformInt(next, n);
}
