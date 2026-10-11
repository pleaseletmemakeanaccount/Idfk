/**
 * ERNAS ENGINE — noise/fractal.js
 * =====================================================================
 *  Fractal composition layer: everything built *on top of* raw Perlin.
 * =====================================================================
 *
 * Raw Perlin noise is a single octave: one characteristic feature size.  No
 * landscape looks like that.  This module composes octaves into the field
 * shapes the ERNAS biomes actually need:
 *
 *   fbm            - fractal Brownian motion.  Rolling hills, taiga floor,
 *                    the base continental shape of the tube interior.
 *   ridged         - ridged multifractal.  Sharp creases; mountain ranges,
 *                    the Spiked Forest crystal spires.
 *   billow         - abs() folded fBm.  Billowing cloud mass, lumpy nests.
 *   turbulence     - sum of |octave|.  Erosion masks, storm intensity.
 *   domainWarp     - Inigo Quilez two-stage warp.  The single biggest visual
 *                    quality win available: it breaks up the "blobby
 *                    isotropic" look that plain fBm has and produces
 *                    flowing, marble-like strata.
 *   curl           - divergence-free vector field from a scalar potential.
 *                    Tornadoes, steam, gas buoyancy — anything that must
 *                    swirl without accumulating or vanishing mass.
 *
 * Every function here has a *tiled* form.  On the ERNAS tube the theta axis
 * is periodic, and an octave-0 period of P implies an octave-k period of
 * P >> k, so the whole fractal stack closes on itself seamlessly.
 */

import {
  perlin2, perlin2Tiled, perlin2Grad,
  perlin3, perlin3Tiled, perlin3Grad,
  perlin2TiledGrad,
} from "./perlin.js";

export { perlin2TiledGrad };

/** Sensible defaults shared by every fractal function. */
export const FRACTAL_DEFAULTS = Object.freeze({
  octaves: 5,
  lacunarity: 2.0,   // frequency multiplier per octave
  gain: 0.5,         // amplitude multiplier per octave
});

function opts(o) {
  const d = FRACTAL_DEFAULTS;
  return o
    ? { octaves: o.octaves ?? d.octaves, lacunarity: o.lacunarity ?? d.lacunarity, gain: o.gain ?? d.gain }
    : d;
}

/**
 * Precompute per-octave (frequency, amplitude) pairs plus the 1/sum
 * normaliser, so the hot loops contain no pow() calls.
 */
export function makeOctaveTable(o) {
  const { octaves, lacunarity, gain } = opts(o);
  const freq = new Float64Array(octaves);
  const amp = new Float64Array(octaves);
  let f = 1, a = 1, sum = 0;
  for (let i = 0; i < octaves; i++) {
    freq[i] = f; amp[i] = a; sum += a;
    f *= lacunarity; a *= gain;
  }
  return { octaves, lacunarity, gain, freq, amp, invSum: 1 / sum, sum };
}

/* ================================================================== *
 * fBm
 * ================================================================== */

/** 2D fractal Brownian motion, normalised so the output stays in [-1,1]. */
export function fbm2(x, y, o, seed = 0) {
  const t = makeOctaveTable(o);
  let acc = 0;
  for (let i = 0; i < t.octaves; i++) {
    acc += t.amp[i] * perlin2(x * t.freq[i], y * t.freq[i], (seed + i * 31) | 0);
  }
  return acc * t.invSum;
}

/** 3D fBm — caves, ore fields, volumetric cloud density. */
export function fbm3(x, y, z, o, seed = 0) {
  const t = makeOctaveTable(o);
  let acc = 0;
  for (let i = 0; i < t.octaves; i++) {
    acc += t.amp[i] * perlin3(x * t.freq[i], y * t.freq[i], z * t.freq[i], (seed + i * 31) | 0);
  }
  return acc * t.invSum;
}

/**
 * Tileable 2D fBm.
 * `periodX/periodY` are the *octave 0* periods in lattice cells.  Each
 * successive octave halves the period; if the period would fall below 1 the
 * octave is dropped rather than aliased.
 */
export function fbm2Tiled(x, y, periodX, periodY, o, seed = 0) {
  const t = makeOctaveTable(o);
  let acc = 0, ampSum = 0;
  let px = periodX, py = periodY;
  for (let i = 0; i < t.octaves; i++) {
    if (periodX > 0 && px < 1) break;
    if (periodY > 0 && py < 1) break;
    acc += t.amp[i] * perlin2Tiled(x * t.freq[i], y * t.freq[i], px, py, (seed + i * 31) | 0);
    ampSum += t.amp[i];
    px = periodX > 0 ? Math.max(1, Math.round(px / t.lacunarity)) : 0;
    py = periodY > 0 ? Math.max(1, Math.round(py / t.lacunarity)) : 0;
  }
  return ampSum > 0 ? acc / ampSum : 0;
}

/** Tileable 3D fBm (theta-periodic caves / veins inside the tube shell). */
export function fbm3Tiled(x, y, z, periodX, periodY, periodZ, o, seed = 0) {
  const t = makeOctaveTable(o);
  let acc = 0, ampSum = 0;
  let px = periodX, py = periodY, pz = periodZ;
  for (let i = 0; i < t.octaves; i++) {
    if (periodX > 0 && px < 1) break;
    acc += t.amp[i] * perlin3Tiled(x * t.freq[i], y * t.freq[i], z * t.freq[i], px, py, pz, (seed + i * 31) | 0);
    ampSum += t.amp[i];
    px = periodX > 0 ? Math.max(1, Math.round(px / t.lacunarity)) : 0;
    py = periodY > 0 ? Math.max(1, Math.round(py / t.lacunarity)) : 0;
    pz = periodZ > 0 ? Math.max(1, Math.round(pz / t.lacunarity)) : 0;
  }
  return ampSum > 0 ? acc / ampSum : 0;
}

/**
 * Analytic gradient of tileable 2D fBm.
 * Because fBm is a linear combination, the derivative is the same linear
 * combination of the per-octave derivatives — with each octave's derivative
 * scaled by its frequency (chain rule).  Finite-differencing the composited
 * field instead would cost 2x the samples *and* lose accuracy near creases.
 * @returns the same array it was given, filled with [v, dx, dy].
 */
export function fbm2TiledGrad(x, y, periodX, periodY, out, o, seed = 0) {
  const t = makeOctaveTable(o);
  const g = [0, 0, 0];
  let acc = 0, dx = 0, dy = 0, ampSum = 0;
  let px = periodX, py = periodY;
  for (let i = 0; i < t.octaves; i++) {
    if (periodX > 0 && px < 1) break;
    if (periodY > 0 && py < 1) break;
    const f = t.freq[i];
    perlin2TiledGrad(x * f, y * f, px, py, g, (seed + i * 31) | 0);
    acc += t.amp[i] * g[0];
    dx += t.amp[i] * g[1] * f;
    dy += t.amp[i] * g[2] * f;
    ampSum += t.amp[i];
    px = periodX > 0 ? Math.max(1, Math.round(px / t.lacunarity)) : 0;
    py = periodY > 0 ? Math.max(1, Math.round(py / t.lacunarity)) : 0;
  }
  const inv = ampSum > 0 ? 1 / ampSum : 0;
  out[0] = acc * inv; out[1] = dx * inv; out[2] = dy * inv;
  return out;
}

/* ================================================================== *
 * Ridged multifractal
 * ================================================================== *
 * n = 1 - |perlin|, then squared, then weighted by the *previous* octave.
 * The weighting is what creates the sharp interconnected ridge network
 * instead of a field of independent spikes.
 * ================================================================== */

/** Ridged multifractal, tileable 2D.  Output is in [0,1]. */
export function ridged2Tiled(x, y, periodX, periodY, o, seed = 0) {
  const t = makeOctaveTable(o);
  let acc = 0, weight = 1, ampSum = 0;
  let px = periodX, py = periodY;
  for (let i = 0; i < t.octaves; i++) {
    if (periodX > 0 && px < 1) break;
    if (periodY > 0 && py < 1) break;
    let n = 1 - Math.abs(perlin2Tiled(x * t.freq[i], y * t.freq[i], px, py, (seed + i * 31) | 0));
    n *= n;
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 2));
    acc += n * t.amp[i];
    ampSum += t.amp[i];
    px = periodX > 0 ? Math.max(1, Math.round(px / t.lacunarity)) : 0;
    py = periodY > 0 ? Math.max(1, Math.round(py / t.lacunarity)) : 0;
  }
  return ampSum > 0 ? acc / ampSum : 0;
}

/* ================================================================== *
 * Billow / turbulence
 * ================================================================== */

/** Billow noise: folded fBm.  Cloud mass and lumpy Sky-Ring nests. */
export function billow2Tiled(x, y, periodX, periodY, o, seed = 0) {
  const t = makeOctaveTable(o);
  let acc = 0, ampSum = 0;
  let px = periodX, py = periodY;
  for (let i = 0; i < t.octaves; i++) {
    if (periodX > 0 && px < 1) break;
    if (periodY > 0 && py < 1) break;
    const n = perlin2Tiled(x * t.freq[i], y * t.freq[i], px, py, (seed + i * 31) | 0);
    acc += t.amp[i] * (2 * Math.abs(n) - 1);
    ampSum += t.amp[i];
    px = periodX > 0 ? Math.max(1, Math.round(px / t.lacunarity)) : 0;
    py = periodY > 0 ? Math.max(1, Math.round(py / t.lacunarity)) : 0;
  }
  return ampSum > 0 ? acc / ampSum : 0;
}

/** Turbulence: sum of |octave|.  Always >= 0; used as an intensity mask. */
export function turbulence2Tiled(x, y, periodX, periodY, o, seed = 0) {
  const t = makeOctaveTable(o);
  let acc = 0, ampSum = 0;
  let px = periodX, py = periodY;
  for (let i = 0; i < t.octaves; i++) {
    if (periodX > 0 && px < 1) break;
    if (periodY > 0 && py < 1) break;
    acc += t.amp[i] * Math.abs(perlin2Tiled(x * t.freq[i], y * t.freq[i], px, py, (seed + i * 31) | 0));
    ampSum += t.amp[i];
    px = periodX > 0 ? Math.max(1, Math.round(px / t.lacunarity)) : 0;
    py = periodY > 0 ? Math.max(1, Math.round(py / t.lacunarity)) : 0;
  }
  return ampSum > 0 ? acc / ampSum : 0;
}

/* ================================================================== *
 * Domain warp (Inigo Quilez two-stage)
 * ================================================================== *
 *   q = fbm(p + fbm(p))
 *   f = fbm(p + strength * q + offset)
 *
 * Two nested warps are what turn "noise" into something that reads as
 * geology: long folded strata, pinched valleys, river-like veins.  This is
 * the ERNAS default for the tube's continental height field.
 */
export function domainWarp2Tiled(x, y, periodX, periodY, o, seed = 0, strength = 1.0) {
  const qx = fbm2Tiled(x, y, periodX, periodY, o, seed + 101);
  const qy = fbm2Tiled(x, y, periodX, periodY, o, seed + 211);
  const nx = x + strength * qx * 4.0;
  const ny = y + strength * qy * 4.0;
  const rx = fbm2Tiled(nx, ny, periodX, periodY, o, seed + 331);
  const ry = fbm2Tiled(nx, ny, periodX, periodY, o, seed + 443);
  return fbm2Tiled(x + strength * rx * 4.0, y + strength * ry * 4.0, periodX, periodY, o, seed);
}

/* ================================================================== *
 * Curl noise — divergence-free vector fields
 * ================================================================== *
 * Take a scalar potential psi(x,y).  Then
 *      u =  dpsi/dy ,  v = -dpsi/dx
 * has zero divergence by construction:
 *      du/dx + dv/dy = d2psi/dxdy - d2psi/dydx = 0.
 * Physically: the flow swirls and never converges into a sink or blows out
 * of a source, which is exactly what a tornado column or a rising steam plume
 * needs.  Because we use the *analytic* Perlin derivative, the field is
 * exactly divergence-free analytically, not merely approximately.
 */

const _curlScratch = [0, 0, 0];

/**
 * 2D curl noise.  Writes [u, v] into `out` and returns it.
 * @param {number} eps unused — analytic derivative, kept for API symmetry
 */
export function curl2(x, y, out, seed = 0, o = null) {
  perlin2Grad(x, y, _curlScratch, seed);
  // Single-octave curl is enough for smooth flow; callers wanting detail can
  // sum curls at several frequencies themselves.
  out[0] = _curlScratch[2];
  out[1] = -_curlScratch[1];
  return out;
}

/**
 * 3D curl noise from a 3-component vector potential.
 *   curl(A) = ( dAz/dy - dAy/dz,  dAx/dz - dAz/dx,  dAy/dx - dAx/dy )
 * Three independently seeded Perlin fields supply Ax, Ay, Az.
 */
export function curl3(x, y, z, out, seed = 0) {
  const a = [0, 0, 0, 0];
  const b = [0, 0, 0, 0];
  const c = [0, 0, 0, 0];
  perlin3Grad(x, y, z, a, seed + 11);
  perlin3Grad(x, y, z, b, seed + 23);
  perlin3Grad(x, y, z, c, seed + 37);
  // a = (v, dAx/dx, dAx/dy, dAx/dz) etc.
  out[0] = c[2] - b[3]; // dAz/dy - dAy/dz
  out[1] = a[3] - c[1]; // dAx/dz - dAz/dx
  out[2] = b[1] - a[2]; // dAy/dx - dAx/dy
  return out;
}

