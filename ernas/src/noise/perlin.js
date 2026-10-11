/**
 * ERNAS ENGINE — noise/perlin.js
 * =====================================================================
 *  Gradient (Perlin) noise, 2D / 3D / 4D, tileable, with analytic derivatives.
 * =====================================================================
 *
 * WHY THIS IS NOT JUST PERLIN'S 2002 `improved noise` COPY-PASTE
 * --------------------------------------------------------------
 * The canonical implementation has three limitations that matter for a world
 * the size of ERNAS, and all three are fixed here:
 *
 *  1. LATTICE REPETITION.  Classic Perlin indexes a 256-entry permutation
 *     table, so the noise repeats every 256 lattice cells.  On a tube whose
 *     inner surface is ~8000 voxels around, that shows up as a faint
 *     repeating "wallpaper" in the terrain.  ERNAS hashes the lattice
 *     coordinate instead (see core/rng.js `hash2/hash3/hash4`), which has no
 *     period at all.
 *
 *  2. PERIOD CAP.  A permutation table also caps *tileable* noise at a
 *     period of 256.  The ERNAS tube must tile seamlessly in theta at a
 *     period of 1024..8192 columns.  Because the permutation is a pure
 *     function of the integer coordinate, tiling here is just
 *     `i = i mod period` before hashing, for any period.
 *
 *  3. GRADIENT BIAS.  Perlin's `grad()` maps a 4-bit hash onto the 12
 *     cube-edge midpoints through a 16-way branch tree, which means 4 of the
 *     12 gradients are selected twice as often as the other 8.  That is a
 *     real statistical bias (it is why classic Perlin has faint axis-aligned
 *     "combing").  ERNAS selects uniformly from a 12-entry unit-gradient
 *     table using a multiply-shift, which is both unbiased and branch-free.
 *
 * WHAT IS ADDED ON TOP
 * --------------------
 *  - `perlin2Grad` / `perlin3Grad`: the *analytic* derivative of the noise
 *    field (not a finite difference).  Required for correct domain warping,
 *    curl noise and erosion.
 *  - Tiled variants for every dimension.
 *  - Bulk `fill` routines that write straight into a Float32Array, so the
 *    JIT keeps the inner loop tight and the result is directly usable as a
 *    texture / heightmap.
 *
 * The value returned is in [-1, 1] and has zero mean.
 */

import { hash2, hash3, hash4 } from "../core/rng.js";

/* ================================================================== *
 * Interpolation kernel
 * ================================================================== *
 * Ken Perlin's 2002 quintic fade  6t^5 - 15t^4 + 10t^3.
 * Chosen because f(0)=0, f(1)=1 and BOTH f'(0)=f'(1)=0 and f''(0)=f''(1)=0,
 * i.e. it is C2 continuous across lattice boundaries.  The older cubic
 * 3t^2-2t^3 is only C1 and produces visible creases along lattice lines.
 */

/** @param {number} t in [0,1] */
export function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** d/dt of the quintic fade = 30t^4 - 60t^3 + 30t^2.  Used by the derivatives. */
export function fadeDeriv(t) {
  return 30 * t * t * t * t - 60 * t * t * t + 30 * t * t;
}

/* ================================================================== *
 * Gradient tables
 * ================================================================== */

const INV_SQRT2 = 1 / Math.SQRT2;

/**
 * 2D: eight unit gradients — the 4 axis directions plus the 4 diagonals,
 * all normalised to length 1.  (Classic 2D Perlin uses only the 4 corners
 * (+-1,+-1), which makes the field visibly diamond-shaped.)
 */
export const GRAD2 = Float64Array.from([
  1, 0, -1, 0, 0, 1, 0, -1,
  INV_SQRT2, INV_SQRT2, -INV_SQRT2, INV_SQRT2, INV_SQRT2, -INV_SQRT2, -INV_SQRT2, -INV_SQRT2,
]);

/**
 * 3D: the twelve midpoints of the cube edges, normalised to unit length.
 * These are the same twelve directions Perlin uses; only the *selection*
 * differs (uniform, see below).
 */
export const GRAD3 = Float64Array.from([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
].map((v) => v * INV_SQRT2));

/**
 * 4D: 32 gradients = all sign/permutation combos of (+-1,+-1,+-1,0)... the
 * standard simplex-4D set, normalised.
 */
export const GRAD4 = (() => {
  const out = [];
  const base = [
    [0, 1, 1, 1], [0, 1, 1, -1], [0, 1, -1, 1], [0, 1, -1, -1],
    [0, -1, 1, 1], [0, -1, 1, -1], [0, -1, -1, 1], [0, -1, -1, -1],
    [1, 0, 1, 1], [1, 0, 1, -1], [1, 0, -1, 1], [1, 0, -1, -1],
    [-1, 0, 1, 1], [-1, 0, 1, -1], [-1, 0, -1, 1], [-1, 0, -1, -1],
    [1, 1, 0, 1], [1, 1, 0, -1], [1, -1, 0, 1], [1, -1, 0, -1],
    [-1, 1, 0, 1], [-1, 1, 0, -1], [-1, -1, 0, 1], [-1, -1, 0, -1],
    [1, 1, 1, 0], [1, 1, -1, 0], [1, -1, 1, 0], [1, -1, -1, 0],
    [-1, 1, 1, 0], [-1, 1, -1, 0], [-1, -1, 1, 0], [-1, -1, -1, 0],
  ];
  const n = Math.sqrt(3);
  for (const g of base) out.push(g[0] / n, g[1] / n, g[2] / n, g[3] / n);
  return Float64Array.from(out);
})();

/*
 * Uniform selection from a table of N entries without a modulo.
 * Lemire's multiply-shift: floor((u / 2^32) * N).  Bias is N/2^32 — utterly
 * negligible, and it costs one multiply instead of a division.
 */
const INV_U32 = 1 / 4294967296;
const sel12 = (h) => ((h >>> 0) * INV_U32 * 12) | 0;
const sel8 = (h) => ((h >>> 0) * INV_U32 * 8) | 0;
const sel32 = (h) => ((h >>> 0) * INV_U32 * 32) | 0;

/* ================================================================== *
 * Wrapping helper
 * ================================================================== *
 * `period <= 0` means "infinite".  Otherwise the lattice coordinate folds
 * modulo the period, which makes the noise tile seamlessly: the gradient at
 * lattice cell `period` IS the gradient at cell `0`.
 */
function wrapAxis(i, period) {
  if (period <= 0) return i | 0;
  const m = i % period;
  return m < 0 ? m + period : m;
}

/* ================================================================== *
 * 2D
 * ================================================================== */

/**
 * Plain 2D Perlin noise.
 * @returns {number} value in roughly [-0.71, 0.71] for the unit 8-gradient set
 */
export function perlin2(x, y, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const u = fade(tx);
  const v = fade(ty);

  const g00 = sel8(hash2(x0, y0, seed)) * 2;
  const g10 = sel8(hash2(x0 + 1, y0, seed)) * 2;
  const g01 = sel8(hash2(x0, y0 + 1, seed)) * 2;
  const g11 = sel8(hash2(x0 + 1, y0 + 1, seed)) * 2;

  const n00 = GRAD2[g00] * tx + GRAD2[g00 + 1] * ty;
  const n10 = GRAD2[g10] * (tx - 1) + GRAD2[g10 + 1] * ty;
  const n01 = GRAD2[g01] * tx + GRAD2[g01 + 1] * (ty - 1);
  const n11 = GRAD2[g11] * (tx - 1) + GRAD2[g11 + 1] * (ty - 1);

  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  return nx0 + v * (nx1 - nx0);
}

/**
 * Tileable 2D Perlin noise.  `periodX`/`periodY` are in lattice cells.
 * This is the workhorse for the ERNAS tube height field, where the X axis is
 * theta and must wrap exactly once around the cylinder.
 */
export function perlin2Tiled(x, y, periodX, periodY, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const u = fade(tx);
  const v = fade(ty);

  const xa = wrapAxis(x0, periodX);
  const xb = wrapAxis(x0 + 1, periodX);
  const ya = wrapAxis(y0, periodY);
  const yb = wrapAxis(y0 + 1, periodY);

  const g00 = sel8(hash2(xa, ya, seed)) * 2;
  const g10 = sel8(hash2(xb, ya, seed)) * 2;
  const g01 = sel8(hash2(xa, yb, seed)) * 2;
  const g11 = sel8(hash2(xb, yb, seed)) * 2;

  const n00 = GRAD2[g00] * tx + GRAD2[g00 + 1] * ty;
  const n10 = GRAD2[g10] * (tx - 1) + GRAD2[g10 + 1] * ty;
  const n01 = GRAD2[g01] * tx + GRAD2[g01 + 1] * (ty - 1);
  const n11 = GRAD2[g11] * (tx - 1) + GRAD2[g11 + 1] * (ty - 1);

  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  return nx0 + v * (nx1 - nx0);
}

/**
 * 2D Perlin noise *and* its analytic gradient, in one pass.
 * `out` receives [value, dValue/dx, dValue/dy].
 *
 * Derivation: f = sum_c w_c(t) * dot(g_c, p - c).  The derivative has two
 * terms — the derivative of the blend weights, and the derivative of the dot
 * products (which is just the gradient component itself).
 */
export function perlin2Grad(x, y, out, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const u = fade(tx);
  const v = fade(ty);
  const du = fadeDeriv(tx);
  const dv = fadeDeriv(ty);

  const g00 = sel8(hash2(x0, y0, seed)) * 2;
  const g10 = sel8(hash2(x0 + 1, y0, seed)) * 2;
  const g01 = sel8(hash2(x0, y0 + 1, seed)) * 2;
  const g11 = sel8(hash2(x0 + 1, y0 + 1, seed)) * 2;

  const ax0 = GRAD2[g00], ay0 = GRAD2[g00 + 1];
  const ax1 = GRAD2[g10], ay1 = GRAD2[g10 + 1];
  const ax2 = GRAD2[g01], ay2 = GRAD2[g01 + 1];
  const ax3 = GRAD2[g11], ay3 = GRAD2[g11 + 1];

  const n00 = ax0 * tx + ay0 * ty;
  const n10 = ax1 * (tx - 1) + ay1 * ty;
  const n01 = ax2 * tx + ay2 * (ty - 1);
  const n11 = ax3 * (tx - 1) + ay3 * (ty - 1);

  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);

  out[0] = nx0 + v * (nx1 - nx0);
  out[1] = du * ((1 - v) * (n10 - n00) + v * (n11 - n01))
         + (1 - v) * ((1 - u) * ax0 + u * ax1)
         + v * ((1 - u) * ax2 + u * ax3);
  out[2] = dv * ((1 - u) * (n01 - n00) + u * (n11 - n10))
         + (1 - u) * ((1 - v) * ay0 + v * ay2)
         + u * ((1 - v) * ay1 + v * ay3);
  return out;
}

/**
 * Tileable 2D Perlin noise *and* its analytic gradient.
 * The tiling only changes which lattice cells the corner gradients come
 * from, so the derivative algebra is identical to `perlin2Grad`.
 */
export function perlin2TiledGrad(x, y, periodX, periodY, out, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const u = fade(tx);
  const v = fade(ty);
  const du = fadeDeriv(tx);
  const dv = fadeDeriv(ty);

  const xa = wrapAxis(x0, periodX), xb = wrapAxis(x0 + 1, periodX);
  const ya = wrapAxis(y0, periodY), yb = wrapAxis(y0 + 1, periodY);

  const g00 = sel8(hash2(xa, ya, seed)) * 2;
  const g10 = sel8(hash2(xb, ya, seed)) * 2;
  const g01 = sel8(hash2(xa, yb, seed)) * 2;
  const g11 = sel8(hash2(xb, yb, seed)) * 2;

  const ax0 = GRAD2[g00], ay0 = GRAD2[g00 + 1];
  const ax1 = GRAD2[g10], ay1 = GRAD2[g10 + 1];
  const ax2 = GRAD2[g01], ay2 = GRAD2[g01 + 1];
  const ax3 = GRAD2[g11], ay3 = GRAD2[g11 + 1];

  const n00 = ax0 * tx + ay0 * ty;
  const n10 = ax1 * (tx - 1) + ay1 * ty;
  const n01 = ax2 * tx + ay2 * (ty - 1);
  const n11 = ax3 * (tx - 1) + ay3 * (ty - 1);

  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);

  out[0] = nx0 + v * (nx1 - nx0);
  out[1] = du * ((1 - v) * (n10 - n00) + v * (n11 - n01))
         + (1 - v) * ((1 - u) * ax0 + u * ax1)
         + v * ((1 - u) * ax2 + u * ax3);
  out[2] = dv * ((1 - u) * (n01 - n00) + u * (n11 - n10))
         + (1 - u) * ((1 - v) * ay0 + v * ay2)
         + u * ((1 - v) * ay1 + v * ay3);
  return out;
}

/* ================================================================== *
 * 3D
 * ================================================================== */

/** Plain 3D Perlin noise, hash-permuted, 12 unit gradients. */
export function perlin3(x, y, z, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const ty = y - y0;
  const tz = z - z0;
  const u = fade(tx);
  const v = fade(ty);
  const w = fade(tz);

  const a = sel12(hash3(x0, y0, z0, seed)) * 3;
  const b = sel12(hash3(x0 + 1, y0, z0, seed)) * 3;
  const c = sel12(hash3(x0, y0 + 1, z0, seed)) * 3;
  const d = sel12(hash3(x0 + 1, y0 + 1, z0, seed)) * 3;
  const e = sel12(hash3(x0, y0, z0 + 1, seed)) * 3;
  const f = sel12(hash3(x0 + 1, y0, z0 + 1, seed)) * 3;
  const g = sel12(hash3(x0, y0 + 1, z0 + 1, seed)) * 3;
  const h = sel12(hash3(x0 + 1, y0 + 1, z0 + 1, seed)) * 3;

  const tx1 = tx - 1, ty1 = ty - 1, tz1 = tz - 1;

  const n000 = GRAD3[a] * tx + GRAD3[a + 1] * ty + GRAD3[a + 2] * tz;
  const n100 = GRAD3[b] * tx1 + GRAD3[b + 1] * ty + GRAD3[b + 2] * tz;
  const n010 = GRAD3[c] * tx + GRAD3[c + 1] * ty1 + GRAD3[c + 2] * tz;
  const n110 = GRAD3[d] * tx1 + GRAD3[d + 1] * ty1 + GRAD3[d + 2] * tz;
  const n001 = GRAD3[e] * tx + GRAD3[e + 1] * ty + GRAD3[e + 2] * tz1;
  const n101 = GRAD3[f] * tx1 + GRAD3[f + 1] * ty + GRAD3[f + 2] * tz1;
  const n011 = GRAD3[g] * tx + GRAD3[g + 1] * ty1 + GRAD3[g + 2] * tz1;
  const n111 = GRAD3[h] * tx1 + GRAD3[h + 1] * ty1 + GRAD3[h + 2] * tz1;

  const nx00 = n000 + u * (n100 - n000);
  const nx10 = n010 + u * (n110 - n010);
  const nx01 = n001 + u * (n101 - n001);
  const nx11 = n011 + u * (n111 - n011);
  const nxy0 = nx00 + v * (nx10 - nx00);
  const nxy1 = nx01 + v * (nx11 - nx01);
  return nxy0 + w * (nxy1 - nxy0);
}

/**
 * Tileable 3D Perlin noise — period per axis in lattice cells.
 * The tube uses `periodX = THETA_PERIOD` so that the theta axis closes on
 * itself, while `periodY/periodZ = 0` (infinite) for depth and length.
 */
export function perlin3Tiled(x, y, z, periodX, periodY, periodZ, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const ty = y - y0;
  const tz = z - z0;
  const u = fade(tx);
  const v = fade(ty);
  const w = fade(tz);

  const xa = wrapAxis(x0, periodX), xb = wrapAxis(x0 + 1, periodX);
  const ya = wrapAxis(y0, periodY), yb = wrapAxis(y0 + 1, periodY);
  const za = wrapAxis(z0, periodZ), zb = wrapAxis(z0 + 1, periodZ);

  const a = sel12(hash3(xa, ya, za, seed)) * 3;
  const b = sel12(hash3(xb, ya, za, seed)) * 3;
  const c = sel12(hash3(xa, yb, za, seed)) * 3;
  const d = sel12(hash3(xb, yb, za, seed)) * 3;
  const e = sel12(hash3(xa, ya, zb, seed)) * 3;
  const f = sel12(hash3(xb, ya, zb, seed)) * 3;
  const g = sel12(hash3(xa, yb, zb, seed)) * 3;
  const h = sel12(hash3(xb, yb, zb, seed)) * 3;

  const tx1 = tx - 1, ty1 = ty - 1, tz1 = tz - 1;

  const n000 = GRAD3[a] * tx + GRAD3[a + 1] * ty + GRAD3[a + 2] * tz;
  const n100 = GRAD3[b] * tx1 + GRAD3[b + 1] * ty + GRAD3[b + 2] * tz;
  const n010 = GRAD3[c] * tx + GRAD3[c + 1] * ty1 + GRAD3[c + 2] * tz;
  const n110 = GRAD3[d] * tx1 + GRAD3[d + 1] * ty1 + GRAD3[d + 2] * tz;
  const n001 = GRAD3[e] * tx + GRAD3[e + 1] * ty + GRAD3[e + 2] * tz1;
  const n101 = GRAD3[f] * tx1 + GRAD3[f + 1] * ty + GRAD3[f + 2] * tz1;
  const n011 = GRAD3[g] * tx + GRAD3[g + 1] * ty1 + GRAD3[g + 2] * tz1;
  const n111 = GRAD3[h] * tx1 + GRAD3[h + 1] * ty1 + GRAD3[h + 2] * tz1;

  const nx00 = n000 + u * (n100 - n000);
  const nx10 = n010 + u * (n110 - n010);
  const nx01 = n001 + u * (n101 - n001);
  const nx11 = n011 + u * (n111 - n011);
  const nxy0 = nx00 + v * (nx10 - nx00);
  const nxy1 = nx01 + v * (nx11 - nx01);
  return nxy0 + w * (nxy1 - nxy0);
}

/**
 * 3D Perlin noise + analytic gradient in one pass.
 * `out` receives [v, dx, dy, dz].
 */
export function perlin3Grad(x, y, z, out, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const ty = y - y0;
  const tz = z - z0;
  const u = fade(tx);
  const v = fade(ty);
  const w = fade(tz);
  const du = fadeDeriv(tx);
  const dv = fadeDeriv(ty);
  const dw = fadeDeriv(tz);

  const ia = sel12(hash3(x0, y0, z0, seed)) * 3;
  const ib = sel12(hash3(x0 + 1, y0, z0, seed)) * 3;
  const ic = sel12(hash3(x0, y0 + 1, z0, seed)) * 3;
  const id = sel12(hash3(x0 + 1, y0 + 1, z0, seed)) * 3;
  const ie = sel12(hash3(x0, y0, z0 + 1, seed)) * 3;
  const if_ = sel12(hash3(x0 + 1, y0, z0 + 1, seed)) * 3;
  const ig = sel12(hash3(x0, y0 + 1, z0 + 1, seed)) * 3;
  const ih = sel12(hash3(x0 + 1, y0 + 1, z0 + 1, seed)) * 3;

  const ax = [GRAD3[ia], GRAD3[ib], GRAD3[ic], GRAD3[id], GRAD3[ie], GRAD3[if_], GRAD3[ig], GRAD3[ih]];
  const ay = [GRAD3[ia + 1], GRAD3[ib + 1], GRAD3[ic + 1], GRAD3[id + 1], GRAD3[ie + 1], GRAD3[if_ + 1], GRAD3[ig + 1], GRAD3[ih + 1]];
  const az = [GRAD3[ia + 2], GRAD3[ib + 2], GRAD3[ic + 2], GRAD3[id + 2], GRAD3[ie + 2], GRAD3[if_ + 2], GRAD3[ig + 2], GRAD3[ih + 2]];

  const tx1 = tx - 1, ty1 = ty - 1, tz1 = tz - 1;
  const px = [tx, tx1, tx, tx1, tx, tx1, tx, tx1];
  const py = [ty, ty, ty1, ty1, ty, ty, ty1, ty1];
  const pz = [tz, tz, tz, tz, tz1, tz1, tz1, tz1];

  const n = new Array(8);
  for (let k = 0; k < 8; k++) n[k] = ax[k] * px[k] + ay[k] * py[k] + az[k] * pz[k];

  const nx00 = n[0] + u * (n[1] - n[0]);
  const nx10 = n[2] + u * (n[3] - n[2]);
  const nx01 = n[4] + u * (n[5] - n[4]);
  const nx11 = n[6] + u * (n[7] - n[6]);
  const nxy0 = nx00 + v * (nx10 - nx00);
  const nxy1 = nx01 + v * (nx11 - nx01);

  out[0] = nxy0 + w * (nxy1 - nxy0);

  // d/dx: weight derivative along x, then the plain x-components of the
  // four gradients that survive the y/z blend.
  const wx0 = (1 - v) * (1 - w), wx1 = v * (1 - w), wx2 = (1 - v) * w, wx3 = v * w;
  out[1] = du * ((1 - w) * ((1 - v) * (n[1] - n[0]) + v * (n[3] - n[2]))
                + w * ((1 - v) * (n[5] - n[4]) + v * (n[7] - n[6])))
         + wx0 * ((1 - u) * ax[0] + u * ax[1])
         + wx1 * ((1 - u) * ax[2] + u * ax[3])
         + wx2 * ((1 - u) * ax[4] + u * ax[5])
         + wx3 * ((1 - u) * ax[6] + u * ax[7]);

  const wy0 = (1 - u) * (1 - w), wy1 = u * (1 - w), wy2 = (1 - u) * w, wy3 = u * w;
  out[2] = dv * ((1 - w) * ((1 - u) * (n[2] - n[0]) + u * (n[3] - n[1]))
                + w * ((1 - u) * (n[6] - n[4]) + u * (n[7] - n[5])))
         + wy0 * ((1 - v) * ay[0] + v * ay[2])
         + wy1 * ((1 - v) * ay[1] + v * ay[3])
         + wy2 * ((1 - v) * ay[4] + v * ay[6])
         + wy3 * ((1 - v) * ay[5] + v * ay[7]);

  const wz0 = (1 - u) * (1 - v), wz1 = u * (1 - v), wz2 = (1 - u) * v, wz3 = u * v;
  out[3] = dw * ((1 - v) * ((1 - u) * (n[4] - n[0]) + u * (n[5] - n[1]))
                + v * ((1 - u) * (n[6] - n[2]) + u * (n[7] - n[3])))
         + wz0 * ((1 - w) * az[0] + w * az[4])
         + wz1 * ((1 - w) * az[1] + w * az[5])
         + wz2 * ((1 - w) * az[2] + w * az[6])
         + wz3 * ((1 - w) * az[3] + w * az[7]);

  return out;
}

/* ================================================================== *
 * 4D — animated fields (tornado vector fields, storm layers, fluid pulse)
 * ================================================================== */

export function perlin4(x, y, z, w, seed = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z), w0 = Math.floor(w);
  const tx = x - x0, ty = y - y0, tz = z - z0, tw = w - w0;
  const u = fade(tx), v = fade(ty), s = fade(tz), t = fade(tw);
  const iu = 1 - u, iv = 1 - v, is = 1 - s, it = 1 - t;

  // Multilinear interpolation over 16 corners is exactly
  //   sum_c ( wx*wy*wz*ww ) * dot(g_c, p - c)
  // so one flat accumulation loop replaces the nested lerp tree.
  let acc = 0;
  for (let cw = 0; cw < 2; cw++) {
    const pw = cw ? t : it;
    for (let cz = 0; cz < 2; cz++) {
      const pzw = pw * (cz ? s : is);
      for (let cy = 0; cy < 2; cy++) {
        const pyzw = pzw * (cy ? v : iv);
        for (let cx = 0; cx < 2; cx++) {
          const g = sel32(hash4(x0 + cx, y0 + cy, z0 + cz, w0 + cw, seed)) * 4;
          const d = GRAD4[g] * (tx - cx) + GRAD4[g + 1] * (ty - cy)
                  + GRAD4[g + 2] * (tz - cz) + GRAD4[g + 3] * (tw - cw);
          acc += pyzw * (cx ? u : iu) * d;
        }
      }
    }
  }
  return acc;
}

/* ================================================================== *
 * Bulk fills — write a whole map into a typed array in one tight loop.
 * ================================================================== */

/**
 * Fill a W x H float buffer with 2D Perlin noise.
 * Values land in [-1,1]; the caller can remap.  Used for the height field
 * cache and for the PNG report generator.
 */
export function perlin2Fill(out, w, h, freq, offX, offY, seed = 0) {
  let p = 0;
  for (let y = 0; y < h; y++) {
    const sy = offY + y * freq;
    for (let x = 0; x < w; x++) {
      out[p++] = perlin2(offX + x * freq, sy, seed);
    }
  }
  return out;
}

/** Fill a W x H float buffer with *tileable* 2D noise (theta x z maps). */
export function perlin2TiledFill(out, w, h, freq, offX, offY, periodX, periodY, seed = 0) {
  let p = 0;
  for (let y = 0; y < h; y++) {
    const sy = offY + y * freq;
    for (let x = 0; x < w; x++) {
      out[p++] = perlin2Tiled(offX + x * freq, sy, periodX, periodY, seed);
    }
  }
  return out;
}
