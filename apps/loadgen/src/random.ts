/**
 * Seeded randomness for request plans (docs/prompts/m4-design.md, "Seeded randomness"; ADR 0006).
 * mulberry32 generates; splitmix32 derives one independent seed per decision dimension, so
 * changing one dimension's draws never reshuffles another. Not cryptographic: never use it for
 * anything security-related.
 */

const TWO_POW_32 = 4_294_967_296;

/** A 32-bit generator: each call returns the next unsigned 32-bit integer. */
export type Uint32Source = () => number;

/** mulberry32: the reference algorithm, returning unsigned 32-bit integers. */
export function mulberry32(seed: number): Uint32Source {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** splitmix32: used only to derive stream seeds from the run seed. */
export function splitmix32(seed: number): Uint32Source {
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

/**
 * The decision dimensions, each with a fixed id. The ids are part of the plan's definition:
 * changing one changes every plan hash.
 */
export const STREAM_IDS = Object.freeze({
  operation: 1,
  sku: 2,
  quantity: 3,
  payment: 4,
  cursor: 5,
  readTarget: 6,
  itemCount: 7,
});
export type StreamName = keyof typeof STREAM_IDS;

/** The seed of one stream: the first splitmix32 output for the run seed mixed with the stream id. */
export function deriveStreamSeed(seed: number, streamId: number): number {
  return splitmix32((seed ^ Math.imul(streamId, 0x9e3779b9)) >>> 0)();
}

/** Draws from one stream. */
export interface Random {
  /** The next unsigned 32-bit integer. */
  readonly uint32: () => number;
  /** A uniform integer in [0, n), exactly uniform by rejection sampling. */
  readonly int: (n: number) => number;
  /** True with probability `p`, using a uniform draw on a 32-bit grid. */
  readonly chance: (p: number) => boolean;
}

/**
 * Exactly uniform integer in [0, n). Values at or above the largest multiple of n below 2^32 are
 * rejected and redrawn, so no remainder is favored.
 */
export function uniformInt(next: Uint32Source, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > TWO_POW_32) {
    throw new RangeError(`uniformInt: n must be an integer from 1 to 2^32, got ${String(n)}`);
  }
  const limit = TWO_POW_32 - (TWO_POW_32 % n);
  for (;;) {
    const value = next();
    if (value < limit) return value % n;
  }
}

export function createRandom(next: Uint32Source): Random {
  return {
    uint32: next,
    int: (n) => uniformInt(next, n),
    chance: (p) => next() < Math.round(p * TWO_POW_32),
  };
}

/** One independent mulberry32 stream per decision dimension, all derived from `seed`. */
export function createStreams(seed: number): Record<StreamName, Random> {
  const streams = {} as Record<StreamName, Random>;
  for (const [name, id] of Object.entries(STREAM_IDS) as [StreamName, number][]) {
    streams[name] = createRandom(mulberry32(deriveStreamSeed(seed, id)));
  }
  return streams;
}
