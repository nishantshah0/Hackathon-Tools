/**
 * mulberry32 — tiny, fast, seeded PRNG. Good enough statistical quality
 * for simulated annealing; fully deterministic for a given 32-bit seed.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer in [0, n) from an rng function. */
export function randInt(rng, n) {
  return Math.floor(rng() * n);
}
