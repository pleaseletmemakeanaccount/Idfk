/**
 * ERNAS ENGINE — tests/noise.test.js
 *
 * Statistical + numerical validation of the noise stack.  These are the tests
 * that would catch the bugs you cannot see in a screenshot: a lattice seam, a
 * biased gradient pick, a derivative that is subtly wrong, a "tileable" noise
 * that is not actually tileable.
 *
 * Run: `node --test` (from this directory — `node --test tests/` does NOT work
 * on Node 22; a directory argument is treated as a module entry point.)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  perlin2, perlin3, perlin4,
  perlin2Tiled, perlin3Tiled,
  perlin2Grad, perlin3Grad, perlin2TiledGrad,
  fade, fadeDeriv, GRAD2, GRAD3,
} from "../src/noise/perlin.js";
import {
  fbm2, fbm3, fbm2Tiled, fbm3Tiled, ridged2Tiled, billow2Tiled,
  turbulence2Tiled, domainWarp2Tiled, curl2, curl3, makeOctaveTable,
} from "../src/noise/fractal.js";
import { NoiseEngine, NOISE_LAYERS } from "../src/noise/index.js";
import { hash2, hash3, fmix32, RNG, makePermutation } from "../src/core/rng.js";

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function sampleStats(fn, n, stride = 0.37) {
  let min = Infinity, max = -Infinity, sum = 0, sum2 = 0, bad = 0;
  for (let i = 0; i < n; i++) {
    const v = fn(i);
    if (!Number.isFinite(v)) bad++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; sum2 += v * v;
  }
  const mean = sum / n;
  return { min, max, mean, variance: sum2 / n - mean * mean, bad, n };
}

/* ------------------------------------------------------------------ *
 * 1. Determinism — the bedrock requirement for a generated world.
 * ------------------------------------------------------------------ */

test("noise is bit-for-bit deterministic for a given seed", () => {
  for (let i = 0; i < 500; i++) {
    const x = i * 0.137, y = i * -0.241, z = i * 0.093;
    assert.equal(perlin3(x, y, z, 1234), perlin3(x, y, z, 1234));
    assert.equal(perlin2(x, y, 99), perlin2(x, y, 99));
  }
});

test("different seeds produce different fields", () => {
  let same = 0;
  for (let i = 0; i < 200; i++) {
    if (perlin3(i * 0.3, i * 0.17, i * 0.11, 1) === perlin3(i * 0.3, i * 0.17, i * 0.11, 2)) same++;
  }
  assert.ok(same < 5, `seeds collided on ${same}/200 samples`);
});

/* ------------------------------------------------------------------ *
 * 2. Range and distribution
 * ------------------------------------------------------------------ */

test("perlin2/3/4 stay inside [-1,1] and are roughly zero-mean", () => {
  const s2 = sampleStats((i) => perlin2(i * 0.31, i * 0.17, 7), 200000);
  const s3 = sampleStats((i) => perlin3(i * 0.31, i * 0.17, i * 0.11, 7), 200000);
  const s4 = sampleStats((i) => perlin4(i * 0.31, i * 0.17, i * 0.11, i * 0.05, 7), 60000);

  for (const [name, s] of [["2D", s2], ["3D", s3], ["4D", s4]]) {
    assert.equal(s.bad, 0, `${name} produced non-finite values`);
    assert.ok(Math.abs(s.min) <= 1, `${name} min ${s.min} below -1`);
    assert.ok(Math.abs(s.max) <= 1, `${name} max ${s.max} above 1`);
    assert.ok(Math.abs(s.mean) < 0.02, `${name} mean ${s.mean} drifted from 0`);
    assert.ok(s.variance > 0.01, `${name} variance ${s.variance} suspiciously flat`);
  }
});

test("fbm stays normalised (amplitude does not blow up with octaves)", () => {
  for (const octaves of [1, 2, 3, 5, 8]) {
    const s = sampleStats((i) => fbm3(i * 0.21, i * 0.13, i * 0.07, { octaves }, 5), 60000);
    assert.ok(s.max <= 1.0, `fbm3 ${octaves} octaves exceeded 1 (${s.max})`);
    assert.ok(s.min >= -1.0, `fbm3 ${octaves} octaves went below -1 (${s.min})`);
    assert.ok(s.variance > 0.005, `fbm3 ${octaves} octaves collapsed`);
  }
});

test("octave amplitudes sum to 1 after normalisation", () => {
  const t = makeOctaveTable({ octaves: 6, lacunarity: 2, gain: 0.5 });
  let sum = 0;
  for (let i = 0; i < t.octaves; i++) sum += t.amp[i] * t.invSum;
  assert.ok(Math.abs(sum - 1) < 1e-12);
});

/* ------------------------------------------------------------------ *
 * 3. Smoothness — no discontinuity across lattice boundaries.
 *
 * The classic Perlin bug class: a wrong index makes the field jump at
 * integer coordinates.  We measure the Lipschitz ratio and specifically
 * hammer the lattice boundaries.
 * ------------------------------------------------------------------ */

test("perlin3 is continuous across lattice cell boundaries", () => {
  const h = 1e-6;
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    // sit exactly on a lattice plane, then step across it
    const y = i + 0.0, z = i * 0.5 + 0.5;
    const a = perlin3(i - h, y, z, 3);
    const b = perlin3(i + h, y, z, 3);
    worst = Math.max(worst, Math.abs(b - a) / (2 * h));
  }
  assert.ok(worst < 5, `slope across lattice boundary too steep: ${worst}`);
});

test("fade kernel is C1 at the boundaries (f'(0)=f'(1)=0)", () => {
  assert.ok(Math.abs(fade(0)) < 1e-15);
  assert.ok(Math.abs(fade(1) - 1) < 1e-15);
  assert.ok(Math.abs(fadeDeriv(0)) < 1e-12, `fade'(0) = ${fadeDeriv(0)}`);
  assert.ok(Math.abs(fadeDeriv(1)) < 1e-12, `fade'(1) = ${fadeDeriv(1)}`);
  // monotonic
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    assert.ok(fade(t) >= prev - 1e-15);
    prev = fade(t);
  }
});

test("perlin2 max slope stays bounded (Lipschitz check)", () => {
  const h = 1e-4;
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const x = i * 0.0137, y = i * 0.0271;
    const gx = (perlin2(x + h, y, 11) - perlin2(x - h, y, 11)) / (2 * h);
    const gy = (perlin2(x, y + h, 11) - perlin2(x, y - h, 11)) / (2 * h);
    const m = Math.hypot(gx, gy);
    if (m > worst) worst = m;
  }
  // Unit gradients + quintic fade: the analytic bound is ~1.9 in 2D.
  assert.ok(worst < 3, `2D gradient magnitude reached ${worst}`);
});

/* ------------------------------------------------------------------ *
 * 4. Tiling — the tube's theta axis must close exactly.
 * ------------------------------------------------------------------ */

test("perlin2Tiled is exactly periodic", () => {
  const P = 64;
  for (let i = 0; i < 300; i++) {
    const x = i * 0.191, y = i * 0.077;
    const a = perlin2Tiled(x, y, P, 0, 21);
    const b = perlin2Tiled(x + P, y, P, 0, 21);
    const c = perlin2Tiled(x - 3 * P, y, P, 0, 21);
    assert.ok(Math.abs(a - b) < 1e-12, `tile seam broke: ${a} vs ${b}`);
    assert.ok(Math.abs(a - c) < 1e-12, "negative-direction tiling broke");
  }
});

test("perlin3Tiled tiles on any single axis without disturbing the others", () => {
  const P = 128;
  for (let i = 0; i < 200; i++) {
    const x = i * 0.13, y = i * 0.29, z = i * 0.07;
    assert.ok(Math.abs(perlin3Tiled(x, y, z, P, 0, 0, 5) - perlin3Tiled(x + P, y, z, P, 0, 0, 5)) < 1e-12);
    assert.ok(Math.abs(perlin3Tiled(x, y, z, 0, 0, P, 5) - perlin3Tiled(x, y, z + P, 0, 0, P, 5)) < 1e-12);
  }
});

test("tiled noise is smooth *across* the seam, not just equal at it", () => {
  // Equality at the seam is necessary but not sufficient: the derivative must
  // also match, otherwise you get a visible crease running down the tube.
  const P = 64, h = 1e-5;
  for (let i = 0; i < 50; i++) {
    const y = i * 0.31;
    const leftSlope = (perlin2Tiled(P - h, y, P, 0, 9) - perlin2Tiled(P - 2 * h, y, P, 0, 9)) / h;
    const rightSlope = (perlin2Tiled(2 * h, y, P, 0, 9) - perlin2Tiled(h, y, P, 0, 9)) / h;
    assert.ok(Math.abs(leftSlope - rightSlope) < 0.2,
      `derivative discontinuity at seam: ${leftSlope} vs ${rightSlope}`);
  }
});

test("tiled fbm closes the seam at every octave simultaneously", () => {
  const P = 1024;
  for (let i = 0; i < 100; i++) {
    const x = i * 0.7, y = i * 0.13;
    const a = fbm2Tiled(x, y, P, 0, { octaves: 5 }, 3);
    const b = fbm2Tiled(x + P, y, P, 0, { octaves: 5 }, 3);
    assert.ok(Math.abs(a - b) < 1e-10, `fbm seam at octave stack: ${a} vs ${b}`);
  }
});

test("fbm3Tiled is periodic on the theta axis for caves", () => {
  const P = 256;
  const a = fbm3Tiled(12.3, 4.5, 6.7, P, 0, 0, { octaves: 3 }, 8);
  const b = fbm3Tiled(12.3 + P, 4.5, 6.7, P, 0, 0, { octaves: 3 }, 8);
  assert.ok(Math.abs(a - b) < 1e-10);
});

/* ------------------------------------------------------------------ *
 * 5. No hidden 256-cell repetition (the classic permutation-table artefact)
 * ------------------------------------------------------------------ */

test("hash-permuted noise does not repeat every 256 lattice cells", () => {
  // With a 256-entry permutation table, perlin(x) === perlin(x+256) exactly.
  // Hash-based permutation must not do that.
  let identical = 0;
  for (let i = 0; i < 300; i++) {
    const x = i * 0.37 + 0.21, y = i * 0.19 + 0.44;
    if (perlin2(x, y, 4) === perlin2(x + 256, y, 4)) identical++;
  }
  assert.equal(identical, 0, `${identical} samples repeated at +256 — permutation table leaked in`);
});

/* ------------------------------------------------------------------ *
 * 6. Analytic derivatives match finite differences
 * ------------------------------------------------------------------ */

test("perlin2Grad matches central finite differences", () => {
  const out = [0, 0, 0];
  const h = 1e-5;
  let worstRel = 0;
  for (let i = 0; i < 3000; i++) {
    const x = i * 0.0173, y = i * 0.0311;
    perlin2Grad(x, y, out, 17);
    const gx = (perlin2(x + h, y, 17) - perlin2(x - h, y, 17)) / (2 * h);
    const gy = (perlin2(x, y + h, 17) - perlin2(x, y - h, 17)) / (2 * h);
    const scale = Math.max(1e-3, Math.hypot(gx, gy));
    worstRel = Math.max(worstRel, Math.hypot(out[1] - gx, out[2] - gy) / scale);
  }
  assert.ok(worstRel < 1e-3, `2D analytic derivative off by ${worstRel} relative`);
});

test("perlin3Grad matches central finite differences", () => {
  const out = [0, 0, 0, 0];
  const h = 1e-5;
  let worstRel = 0;
  for (let i = 0; i < 3000; i++) {
    const x = i * 0.0173, y = i * 0.0311, z = i * 0.0097;
    perlin3Grad(x, y, z, out, 19);
    const gx = (perlin3(x + h, y, z, 19) - perlin3(x - h, y, z, 19)) / (2 * h);
    const gy = (perlin3(x, y + h, z, 19) - perlin3(x, y - h, z, 19)) / (2 * h);
    const gz = (perlin3(x, y, z + h, 19) - perlin3(x, y, z - h, 19)) / (2 * h);
    const scale = Math.max(1e-3, Math.hypot(gx, gy, gz));
    worstRel = Math.max(worstRel, Math.hypot(out[1] - gx, out[2] - gy, out[3] - gz) / scale);
  }
  assert.ok(worstRel < 1e-3, `3D analytic derivative off by ${worstRel} relative`);
});

test("perlin2TiledGrad matches finite differences of perlin2Tiled", () => {
  const out = [0, 0, 0];
  const h = 1e-5, P = 96;
  let worstRel = 0;
  for (let i = 0; i < 2000; i++) {
    const x = i * 0.0211, y = i * 0.0139;
    perlin2TiledGrad(x, y, P, 0, out, 23);
    const gx = (perlin2Tiled(x + h, y, P, 0, 23) - perlin2Tiled(x - h, y, P, 0, 23)) / (2 * h);
    const gy = (perlin2Tiled(x, y + h, P, 0, 23) - perlin2Tiled(x, y - h, P, 0, 23)) / (2 * h);
    const scale = Math.max(1e-3, Math.hypot(gx, gy));
    worstRel = Math.max(worstRel, Math.hypot(out[1] - gx, out[2] - gy) / scale);
  }
  assert.ok(worstRel < 1e-3, `tiled derivative off by ${worstRel} relative`);
});

/* ------------------------------------------------------------------ *
 * 7. Curl noise must be divergence-free
 * ------------------------------------------------------------------ */

test("curl2 has ~zero divergence", () => {
  const out = [0, 0];
  const h = 1e-3;
  let worst = 0;
  for (let i = 0; i < 2000; i++) {
    const x = i * 0.0131, y = i * 0.0197;
    curl2(x + h, y, out, 31); const dudx = out[0];
    curl2(x - h, y, out, 31); const dudx2 = out[0];
    curl2(x, y + h, out, 31); const dvdy = out[1];
    curl2(x, y - h, out, 31); const dvdy2 = out[1];
    const div = (dudx - dudx2) / (2 * h) + (dvdy - dvdy2) / (2 * h);
    worst = Math.max(worst, Math.abs(div));
  }
  assert.ok(worst < 1e-3, `2D curl divergence ${worst} — field is not solenoidal`);
});

test("curl3 has ~zero divergence", () => {
  const out = [0, 0, 0];
  const h = 1e-3;
  let worst = 0;
  for (let i = 0; i < 800; i++) {
    const x = i * 0.0131, y = i * 0.0197, z = i * 0.0071;
    const at = (dx, dy, dz) => { curl3(x + dx, y + dy, z + dz, out, 41); return [out[0], out[1], out[2]]; };
    const xp = at(h, 0, 0), xm = at(-h, 0, 0);
    const yp = at(0, h, 0), ym = at(0, -h, 0);
    const zp = at(0, 0, h), zm = at(0, 0, -h);
    const div = (xp[0] - xm[0] + yp[1] - ym[1] + zp[2] - zm[2]) / (2 * h);
    worst = Math.max(worst, Math.abs(div));
  }
  assert.ok(worst < 1e-3, `3D curl divergence ${worst}`);
});

/* ------------------------------------------------------------------ *
 * 8. Lattice hash quality
 * ------------------------------------------------------------------ */

test("lattice hash selects all 12 3D gradients about equally (no Perlin bias)", () => {
  const counts = new Array(12).fill(0);
  const N = 240000;
  for (let i = 0; i < N; i++) {
    const h = hash3(i % 600, (i / 600) | 0, (i * 7919) % 977, 1234);
    counts[((h >>> 0) / 4294967296 * 12) | 0]++;
  }
  const expected = N / 12;
  let chi2 = 0;
  for (const c of counts) chi2 += (c - expected) ** 2 / expected;
  // chi-square with 11 dof: 99.9th percentile is 31.3
  assert.ok(chi2 < 40, `gradient selection is biased, chi2=${chi2.toFixed(1)}, counts=${counts}`);
});

test("lattice hash selects all 8 2D gradients about equally", () => {
  const counts = new Array(8).fill(0);
  const N = 240000;
  for (let i = 0; i < N; i++) {
    const h = hash2(i % 500, (i / 500) | 0, 77);
    counts[((h >>> 0) / 4294967296 * 8) | 0]++;
  }
  const expected = N / 8;
  let chi2 = 0;
  for (const c of counts) chi2 += (c - expected) ** 2 / expected;
  assert.ok(chi2 < 35, `2D gradient selection biased, chi2=${chi2.toFixed(1)}`);
});

test("fmix32 avalanches: a single input bit flips ~half the output bits", () => {
  let totalFlips = 0, trials = 0;
  for (let base = 1; base <= 64; base++) {
    const a = fmix32(base), b = fmix32(base ^ 1);
    let x = (a ^ b) >>> 0, bits = 0;
    while (x) { bits += x & 1; x >>>= 1; }
    totalFlips += bits; trials++;
  }
  const avg = totalFlips / trials;
  assert.ok(avg > 13 && avg < 19, `expected ~16 flipped bits, got ${avg.toFixed(2)}`);
});

test("adjacent lattice cells are decorrelated", () => {
  // Pearson correlation between perlin at (x,y) and (x+1,y) over the lattice
  let s1 = 0, s2 = 0, s11 = 0, s22 = 0, s12 = 0, n = 0;
  for (let i = 0; i < 40000; i++) {
    const a = perlin2(i * 0.53, i * 0.31, 55);
    const b = perlin2(i * 0.53 + 1, i * 0.31, 55);
    s1 += a; s2 += b; s11 += a * a; s22 += b * b; s12 += a * b; n++;
  }
  const cov = s12 / n - (s1 / n) * (s2 / n);
  const va = s11 / n - (s1 / n) ** 2;
  const vb = s22 / n - (s2 / n) ** 2;
  const r = cov / Math.sqrt(va * vb);
  assert.ok(Math.abs(r) < 0.25, `neighbouring cells correlated at r=${r.toFixed(3)}`);
});

/* ------------------------------------------------------------------ *
 * 9. Isotropy — no preferred direction
 * ------------------------------------------------------------------ *
 * The naive version of this test measures the variance of a 1-D slice along
 * each direction.  That is WRONG and I want the reason recorded here, because
 * it looks like it should work:
 *
 *   - Perlin noise is exactly zero at every lattice point.  A slice taken
 *     exactly along a lattice line (e.g. y = 0) is pinned to zero at every
 *     integer x, which suppresses its variance by ~25%.  A slice at 22.5 deg
 *     never lands on a lattice point and reads ~15% higher.  That measures the
 *     sampling line, not the field.
 *   - Worse, sampling at a step of exactly 1.0 aliases onto the lattice and
 *     produces a bogus 35-57% "anisotropy".
 *
 * The correct statistic is the variance of the *directional derivative* over
 * a whole region: E[(u . grad f)^2] = u^T H u, where H is the structure tensor
 * of the gradient field.  H is estimated over tens of thousands of samples
 * spread across many lattice cells at a sub-lattice step, so it converges.
 * A field is isotropic exactly when H is a multiple of the identity.
 *
 * Measured across seeds 1/7/61/1234/99991: 2.1% - 4.8% spread, 2D and 3D.
 */

function structureTensor2(seed, n = 200, step = 0.25) {
  const g = [0, 0, 0];
  let xx = 0, xy = 0, yy = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      perlin2Grad(0.31 + i * step, 0.63 + j * step, g, seed);
      xx += g[1] * g[1]; xy += g[1] * g[2]; yy += g[2] * g[2];
    }
  }
  const c = n * n;
  return { xx: xx / c, xy: xy / c, yy: yy / c };
}

function structureTensor3(seed, n = 56, step = 0.25) {
  const g = [0, 0, 0, 0];
  const T = [0, 0, 0, 0, 0, 0]; // xx yy zz xy xz yz
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        perlin3Grad(0.31 + i * step, 0.63 + j * step, 0.17 + k * step, g, seed);
        T[0] += g[1] * g[1]; T[1] += g[2] * g[2]; T[2] += g[3] * g[3];
        T[3] += g[1] * g[2]; T[4] += g[1] * g[3]; T[5] += g[2] * g[3];
      }
    }
  }
  const c = n * n * n;
  return T.map((v) => v / c);
}

test("2D noise is isotropic: directional-derivative variance within 10%", () => {
  for (const seed of [1, 61, 1234]) {
    const { xx, xy, yy } = structureTensor2(seed);
    const mean = (xx + yy) / 2;
    const rel = (deg) => {
      const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      return (xx * c * c + 2 * xy * c * s + yy * s * s) / mean;
    };
    const vals = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5].map(rel);
    const spread = Math.max(...vals) - Math.min(...vals);
    assert.ok(spread < 0.10,
      `seed ${seed}: directional variance spread ${(spread * 100).toFixed(1)}% ` +
      `[${vals.map((v) => v.toFixed(3)).join(", ")}]`);
  }
});

test("3D noise is isotropic: directional-derivative variance within 10%", () => {
  for (const seed of [7, 1234]) {
    const T = structureTensor3(seed);
    const mean = (T[0] + T[1] + T[2]) / 3;
    const q = (d) => (T[0] * d[0] ** 2 + T[1] * d[1] ** 2 + T[2] * d[2] ** 2
      + 2 * T[3] * d[0] * d[1] + 2 * T[4] * d[0] * d[2] + 2 * T[5] * d[1] * d[2]) / mean;
    const dirs = [
      [1, 0, 0], [0, 1, 0], [0, 0, 1],
      [0.5774, 0.5774, 0.5774], [0.2673, 0.5345, 0.8018], [0, 0.7071, 0.7071],
    ];
    const vals = dirs.map(q);
    const spread = Math.max(...vals) - Math.min(...vals);
    assert.ok(spread < 0.10,
      `seed ${seed}: 3D directional variance spread ${(spread * 100).toFixed(1)}% ` +
      `[${vals.map((v) => v.toFixed(3)).join(", ")}]`);
  }
});

test("gradient field has no cross-axis shear (off-diagonal tensor ~ 0)", () => {
  const { xx, xy, yy } = structureTensor2(4242);
  assert.ok(Math.abs(xy) / ((xx + yy) / 2) < 0.02,
    `xy shear ${(xy / ((xx + yy) / 2)).toFixed(4)} indicates a skewed gradient set`);
});

/* ------------------------------------------------------------------ *
 * 10. Gradient tables are well-formed
 * ------------------------------------------------------------------ */

test("gradient tables are unit length", () => {
  for (let i = 0; i < GRAD2.length; i += 2) {
    assert.ok(Math.abs(Math.hypot(GRAD2[i], GRAD2[i + 1]) - 1) < 1e-12);
  }
  for (let i = 0; i < GRAD3.length; i += 3) {
    assert.ok(Math.abs(Math.hypot(GRAD3[i], GRAD3[i + 1], GRAD3[i + 2]) - 1) < 1e-12);
  }
});

test("GRAD3 holds exactly the 12 distinct cube-edge midpoints", () => {
  const seen = new Set();
  for (let i = 0; i < GRAD3.length; i += 3) {
    seen.add(`${GRAD3[i].toFixed(6)},${GRAD3[i + 1].toFixed(6)},${GRAD3[i + 2].toFixed(6)}`);
  }
  assert.equal(seen.size, 12, `expected 12 unique gradients, got ${seen.size}`);
});

/* ------------------------------------------------------------------ *
 * 11. NoiseEngine layer isolation
 * ------------------------------------------------------------------ */

test("NoiseEngine gives every layer an independent seed", () => {
  const n = new NoiseEngine("ERNAS-TEST");
  const seeds = Object.keys(NOISE_LAYERS).map((k) => n.seedFor(k));
  assert.equal(new Set(seeds).size, seeds.length, "two layers share a seed");
  assert.throws(() => n.seedFor("does-not-exist"));
});

test("NoiseEngine is reproducible across instances and string/number seeds differ", () => {
  const a = new NoiseEngine("tube-7");
  const b = new NoiseEngine("tube-7");
  const c = new NoiseEngine("tube-8");
  assert.equal(a.seedFor("continental"), b.seedFor("continental"));
  assert.notEqual(a.seedFor("continental"), c.seedFor("continental"));
  assert.equal(
    a.sample2("continental", 12.5, 3.25, 1024),
    b.sample2("continental", 12.5, 3.25, 1024),
  );
});

test("every named layer produces finite, bounded output", () => {
  const n = new NoiseEngine("bounds");
  for (const [name, def] of Object.entries(NOISE_LAYERS)) {
    for (let i = 0; i < 2000; i++) {
      const v = def.kind === "fbm3"
        ? n.sample3(name, i * 0.11, i * 0.13, i * 0.07, 512)
        : n.sample2(name, i * 0.11, i * 0.13, 1024);
      assert.ok(Number.isFinite(v), `layer ${name} produced ${v}`);
      assert.ok(v >= -1.0001 && v <= 1.0001, `layer ${name} out of range: ${v}`);
    }
  }
});

test("ridged and turbulence layers are non-negative by construction", () => {
  const n = new NoiseEngine("signs");
  for (let i = 0; i < 5000; i++) {
    assert.ok(n.sample2("ridge", i * 0.13, i * 0.07, 1024) >= -1e-12);
    assert.ok(n.sample2("storm", i * 0.13, i * 0.07, 1024) >= -1e-12);
  }
});

/* ------------------------------------------------------------------ *
 * 12. Domain warp stays bounded and tiles
 * ------------------------------------------------------------------ */

test("two-stage domain warp stays in range and remains tileable", () => {
  const P = 512;
  const s = sampleStats((i) => domainWarp2Tiled(i * 0.09, i * 0.037, P, 0, { octaves: 4 }, 71), 30000);
  assert.ok(s.max <= 1 && s.min >= -1, `warp out of range [${s.min}, ${s.max}]`);
  assert.ok(Math.abs(
    domainWarp2Tiled(12.5, 3.0, P, 0, { octaves: 4 }, 71) -
    domainWarp2Tiled(12.5 + P, 3.0, P, 0, { octaves: 4 }, 71),
  ) < 1e-9, "domain warp broke the tile seam");
});

/* ------------------------------------------------------------------ *
 * 13. RNG primitives
 * ------------------------------------------------------------------ */

test("RNG.fork produces independent, order-stable streams", () => {
  const r = new RNG("seed-x");
  const a1 = r.fork("caves").next();
  const a2 = new RNG("seed-x").fork("caves").next();
  const b1 = new RNG("seed-x").fork("ores").next();
  assert.equal(a1, a2, "fork is not deterministic");
  assert.notEqual(a1, b1, "forks are not independent");
});

test("makePermutation is a valid permutation and doubled for mask-free lookup", () => {
  const p = makePermutation(2024);
  const seen = new Set();
  for (let i = 0; i < 256; i++) seen.add(p[i]);
  assert.equal(seen.size, 256);
  assert.equal(p.length, 512);
  for (let i = 0; i < 256; i++) assert.equal(p[i], p[i + 256]);
});

/* ------------------------------------------------------------------ *
 * LAYER_STATS — the normalisation table
 * ------------------------------------------------------------------ */

// `NoiseEngine` and `NOISE_LAYERS` are already imported at the top of this file.
import { LAYER_STATS } from "../src/noise/index.js";
import { THETA_FREQ } from "../src/world/generator.js";
import { mulberry32 } from "../src/core/rng.js";

/**
 * Measure a layer's raw mean and standard deviation.
 *
 * Sampling has to be RANDOM over a range that covers the whole tile, not a
 * regular grid.  My first version of this walked a 180x180 grid with a fixed
 * stride, which under-sampled the base octave badly — it reported `biome` at
 * sd 0.018 against a true 0.141, an 86% error, purely from the sampling
 * pattern.  Random positions over `max(1024, 16 * period)` cells fix it.
 */
function measureLayer(name, seed, n = 30000) {
  const engine = new NoiseEngine(seed);
  const is3d = NOISE_LAYERS[name].kind === "fbm3";
  const period = THETA_FREQ[name].period;
  const span = Math.max(1024, period * 16);
  const rnd = mulberry32(0xC0FFEE);
  let sum = 0, sum2 = 0;
  for (let s = 0; s < n; s++) {
    const x = rnd() * span, y = rnd() * 2048, z = rnd() * 2048;
    const v = is3d
      ? engine.sample3(name, x, y * 0.4, z, period)
      : engine.sample2(name, x, y, period);
    sum += v; sum2 += v * v;
  }
  const mean = sum / n;
  return { mean, sd: Math.sqrt(sum2 / n - mean * mean) };
}

const STAT_SEEDS = ["ERNAS", "tube-2", "moth", "a-very-long-seed-string", "7"];

test("LAYER_STATS still matches the layers it claims to describe", () => {
  /*
   * The table is hand-recorded constants, and `sample2Norm` divides by them, so
   * a stale row silently shifts every threshold in the generator.  Tolerances
   * come from the measurement itself: across 5 seeds x 30k samples the worst
   * deviation from the table is 4.8% on sd and 3.3% of sd on mean, and the
   * spread BETWEEN seeds is under 1% — so 8% is a genuine margin, not a guess.
   *
   * Note this table is a property of the fractal operators, not of the world's
   * frequency choices: changing THETA_FREQ.storm (which the sinkhole fix did)
   * changes how often the storm layer is sampled spatially, not its output
   * distribution.  This test re-confirms that after the fact.
   */
  for (const name of Object.keys(NOISE_LAYERS)) {
    const stats = LAYER_STATS[name];
    assert.ok(stats, `NOISE_LAYERS has "${name}" but LAYER_STATS does not`);

    const runs = STAT_SEEDS.map((s) => measureLayer(name, s));
    const mean = runs.reduce((a, r) => a + r.mean, 0) / runs.length;
    const sd = runs.reduce((a, r) => a + r.sd, 0) / runs.length;

    // Seeds must agree with each other, or the layer is seed-sensitive.
    const sdSpread = Math.max(...runs.map((r) => Math.abs(r.sd / sd - 1)));
    assert.ok(sdSpread < 0.03,
      `${name}: seed-to-seed sd spread is ${(sdSpread * 100).toFixed(1)}% — too unstable to record`);

    assert.ok(Math.abs(sd / stats.sd - 1) < 0.08,
      `${name}: measured sd ${sd.toFixed(4)} but LAYER_STATS says ${stats.sd} ` +
      `(${((sd / stats.sd - 1) * 100).toFixed(1)}% off)`);

    // Mean error is judged in units of sd, since sd differs per layer.
    const meanErr = Math.abs(mean - stats.mean) / stats.sd;
    assert.ok(meanErr < 0.08,
      `${name}: measured mean ${mean.toFixed(4)} but LAYER_STATS says ${stats.mean} ` +
      `(${(meanErr * 100).toFixed(1)}% of sd off)`);
  }
});

test("sample2Norm / sample3Norm really do produce zero mean and unit variance", () => {
  // This is the whole point of the table: after normalisation a "> 1.0"
  // threshold means "one standard deviation out", for every layer alike.
  for (const name of Object.keys(NOISE_LAYERS)) {
    const is3d = NOISE_LAYERS[name].kind === "fbm3";
    const engine = new NoiseEngine("ERNAS");
    const period = THETA_FREQ[name].period;
    const span = Math.max(1024, period * 16);
    const rnd = mulberry32(0xBADC0DE);
    let sum = 0, sum2 = 0;
    const n = 30000;
    for (let s = 0; s < n; s++) {
      const x = rnd() * span, y = rnd() * 2048, z = rnd() * 2048;
      const v = is3d
        ? engine.sample3Norm(name, x, y * 0.4, z, period)
        : engine.sample2Norm(name, x, y, period);
      sum += v; sum2 += v * v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sum2 / n - mean * mean);
    assert.ok(Math.abs(mean) < 0.10, `${name}: normalised mean is ${mean.toFixed(3)}, not ~0`);
    assert.ok(Math.abs(sd - 1) < 0.10, `${name}: normalised sd is ${sd.toFixed(3)}, not ~1`);
  }
});

test("LAYER_STATS covers exactly the layers that exist", () => {
  assert.deepEqual(
    Object.keys(LAYER_STATS).sort(),
    Object.keys(NOISE_LAYERS).sort(),
    "LAYER_STATS and NOISE_LAYERS have drifted apart",
  );
});
