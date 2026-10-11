/**
 * ERNAS ENGINE — core/rng.js
 * Deterministic pseudo-random number generation.
 *
 * Everything in the ERNAS world generator must be reproducible from a single
 * seed: the same seed on two machines must produce the same tube, the same
 * veins of gold, the same sinkhole.  That means:
 *
 *   - No Math.random() anywhere in generation.
 *   - Integer-only hashing (no floating point drift between platforms).
 *   - A well-avalanched finalizer so that neighbouring lattice coordinates
 *     (i, i+1) produce completely unrelated gradient picks.  A weak finalizer
 *     shows up in terrain as visible "combing" along the lattice.
 *
 * Primitives provided:
 *   cyrb128(str)      - string -> 4x uint32 seed state
 *   fmix32(x)         - murmur3 32-bit finalizer (proven avalanche)
 *   hash2/hash3/hash4 - coordinate -> uint32 lattice hash
 *   mulberry32(seed)  - fast streaming PRNG (UI/dressing, not terrain)
 *   xoshiro128ss(seed)- higher quality streaming PRNG
 *   RNG               - class wrapper with the helpers the generator uses
 */

/* ------------------------------------------------------------------ *
 * Integer helpers
 * ------------------------------------------------------------------ */

/** murmur3 32-bit finalizer. Every input bit affects every output bit. */
export function fmix32(x) {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Large odd primes, used as coordinate multipliers (FNV / LCG tradition). */
export const PRIME_X = 0x27d4eb2d;
export const PRIME_Y = 0x165667b1;
export const PRIME_Z = 0x9e3779b1;
export const PRIME_W = 0x85ebca77;

/**
 * cyrb128 — turn an arbitrary string into 4 independent 32-bit seed words.
 * Public-domain algorithm (bryc, stackoverflow #521295).  Good enough to
 * expand a human-typed world seed such as "ERNAS-ALBANY" into full state.
 */
export function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/**
 * Accept a seed as string | number | Int32Array-ish and reduce to uint32.
 * Numbers are truncated to 32 bits so `seed: 7` and `seed: "7"` differ but
 * each is individually stable forever.
 */
export function seedToUint32(seed) {
  if (typeof seed === "number") return (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  if (typeof seed === "string") return cyrb128(seed)[0];
  if (seed && typeof seed === "object" && typeof seed[0] === "number") return seed[0] >>> 0;
  return 0x9e3779b9; // golden-ratio fallback: deterministic, not zero
}

/* ------------------------------------------------------------------ *
 * Lattice hashes — the permutation layer of ERNAS Perlin
 * ------------------------------------------------------------------ *
 * Classic Perlin indexes a 256-entry permutation table.  That works, but it
 * means the noise repeats every 256 lattice cells (a visible grid on large
 * terrain) and it caps the period of tileable noise at 256 — too small for a
 * tube whose circumference is thousands of voxels.
 *
 * Hashing the lattice coordinate directly removes both problems:
 *   - no repetition, ever (until 2^32);
 *   - tileable at *any* period, because we simply take `i % period` before
 *     hashing, so lattice cell `period` aliases exactly onto cell `0`.
 */

/** 2D lattice hash -> uint32. */
export function hash2(i, j, seed) {
  let h = (seed ^ Math.imul(i | 0, PRIME_X) ^ Math.imul(j | 0, PRIME_Y)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** 3D lattice hash -> uint32. */
export function hash3(i, j, k, seed) {
  let h = (seed ^ Math.imul(i | 0, PRIME_X) ^ Math.imul(j | 0, PRIME_Y) ^ Math.imul(k | 0, PRIME_Z)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** 4D lattice hash -> uint32 (animated noise / 3D + time). */
export function hash4(i, j, k, l, seed) {
  let h = (seed ^ Math.imul(i | 0, PRIME_X) ^ Math.imul(j | 0, PRIME_Y)
              ^ Math.imul(k | 0, PRIME_Z) ^ Math.imul(l | 0, PRIME_W)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/* ------------------------------------------------------------------ *
 * Streaming PRNGs
 * ------------------------------------------------------------------ */

/** mulberry32 — 32-bit state, one multiply, excellent for dressing passes. */
export function mulberry32(seed) {
  let a = seedToUint32(seed);
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** xoshiro128** — 128-bit state; the quality default for anything statistical. */
export function xoshiro128ss(seed) {
  const s = cyrb128(String(seed ?? "ernas"));
  const st = new Uint32Array([s[0] || 1, s[1] || 2, s[2] || 3, s[3] || 4]);
  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
  return function next() {
    const result = (Math.imul(rotl(Math.imul(st[1], 5), 7), 9)) >>> 0;
    const t = (st[1] << 9) >>> 0;
    st[2] ^= st[0]; st[3] ^= st[1]; st[1] ^= st[2]; st[0] ^= st[3];
    st[2] = (st[2] ^ t) >>> 0;
    st[3] = rotl(st[3], 11);
    return result / 4294967296;
  };
}

/**
 * RNG — the object the world generator actually passes around.
 * Small on purpose: `next`, `range`, `int`, `pick`, `shuffle`, `fork`.
 * `fork(label)` derives an independent child stream from a name, so each
 * subsystem (caves, ores, flora, dressing) gets its own reproducible stream
 * without any subsystem being able to perturb another's sequence.
 */
export class RNG {
  constructor(seed = 1337) {
    this.seed = seed;
    this._next = xoshiro128ss(seed);
  }

  /** [0,1) */
  next() { return this._next(); }

  /** [min,max) float */
  range(min, max) { return min + (max - min) * this._next(); }

  /** [min,max] inclusive integer */
  int(min, max) { return min + Math.floor(this._next() * (max - min + 1)); }

  chance(p) { return this._next() < p; }

  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }

  /** Fisher-Yates, in place. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Deterministic child stream, stable against sibling creation order. */
  fork(label) {
    return new RNG(cyrb128(`${String(this.seed)}::${label}`).slice(0, 2));
  }
}

/**
 * Build a shuffled permutation table (classic Perlin style), for callers
 * that specifically want table-based noise (reference implementations,
 * compatibility with other engines, tests).
 */
export function makePermutation(seed = 1337, size = 256) {
  const p = new Uint8Array(size);
  for (let i = 0; i < size; i++) p[i] = i & 255;
  new RNG(seed).shuffle(p);
  const doubled = new Uint8Array(size * 2); // avoids `& 255` masking in hot loops
  for (let i = 0; i < size * 2; i++) doubled[i] = p[i % size];
  return doubled;
}
