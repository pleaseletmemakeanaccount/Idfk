#!/usr/bin/env node
/**
 * ERNAS ENGINE — tools/noise_report.js
 * =====================================================================
 *  A readable report on the noise stack's statistical quality.
 * =====================================================================
 *
 * Run: `npm run report`   (or `node tools/noise_report.js --seed=ERNAS`)
 *
 * The tests in tests/noise.test.js ASSERT these properties.  This tool PRINTS
 * them, because a pass/fail boolean is useless when you are trying to decide
 * whether a change made the terrain better or just differently bad.
 *
 * It covers four things that a screenshot cannot show you:
 *
 *  1. DISTRIBUTION   — mean/sd/range per layer, against LAYER_STATS.
 *  2. ISOTROPY       — Perlin noise is not rotationally invariant; the classic
 *                      lattice artefact is that variation along the grid axes
 *                      differs from variation along the diagonals.  Measured
 *                      properly (see the note in `isotropy`), not by eyeballing
 *                      a 1-D slice.
 *  3. TILEABILITY    — the tube closes on itself in theta.  A seam shows up as
 *                      a discontinuity at i = 0, so the jump ACROSS the seam is
 *                      compared against the worst jump anywhere else.
 *  4. SPECTRUM       — an fBm's octave amplitudes must actually decay as
 *                      advertised, or the "detail" octaves are doing nothing.
 */

import { performance } from "node:perf_hooks";
import { NoiseEngine, NOISE_LAYERS, LAYER_STATS } from "../src/noise/index.js";
import { perlin2Tiled, perlin2, GRAD2 } from "../src/noise/perlin.js";
import { makeOctaveTable } from "../src/noise/fractal.js";
import { makeTerrain, THETA_FREQ, BIOME_NAMES } from "../src/world/generator.js";
import { WORLD } from "../src/world/cylinderGeometry.js";
import { mulberry32 } from "../src/core/rng.js";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  }),
);
const SEED = args.get("seed") || "ERNAS";
const SAMPLES = args.get("samples") ? Number(args.get("samples")) : 60_000;

const noise = new NoiseEngine(SEED);
const terrain = makeTerrain(SEED);

function section(t) { process.stdout.write(`\n\x1b[1m${t}\x1b[0m\n`); }
function row(label, value, unit = "", note = "") {
  process.stdout.write(`  ${label.padEnd(30)} ${String(value).padStart(11)} ${unit.padEnd(9)} ${note}\n`);
}
const f3 = (x) => x.toFixed(3);
const f4 = (x) => x.toFixed(4);
const pct = (x) => (x * 100).toFixed(2) + "%";

process.stdout.write(`\n\x1b[1mERNAS noise report\x1b[0m   seed "${SEED}"   ${SAMPLES} samples/layer\n`);

/* ------------------------------------------------------------------ *
 * 1. Distribution
 * ------------------------------------------------------------------ */

section("1. DISTRIBUTION  (raw layer output vs LAYER_STATS)");
process.stdout.write("  layer        kind   oct      mean        sd       min       max     table sd   sd err\n");

for (const [name, def] of Object.entries(NOISE_LAYERS)) {
  const is3d = def.kind === "fbm3";
  const period = THETA_FREQ[name].period;
  const span = Math.max(1024, period * 16);
  const rnd = mulberry32(0xC0FFEE);
  let n = 0, s = 0, s2 = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const x = rnd() * span, y = rnd() * 2048, z = rnd() * 2048;
    const v = is3d ? noise.sample3(name, x, y * 0.4, z, period) : noise.sample2(name, x, y, period);
    n++; s += v; s2 += v * v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const mean = s / n;
  const sd = Math.sqrt(s2 / n - mean * mean);
  const st = LAYER_STATS[name];
  process.stdout.write(
    `  ${name.padEnd(12)} ${def.kind.padEnd(6)} ${String(def.octaves).padEnd(5)} ` +
    `${mean.toFixed(4).padStart(9)} ${sd.toFixed(4).padStart(9)} ` +
    `${lo.toFixed(3).padStart(9)} ${hi.toFixed(3).padStart(9)} ` +
    `${st.sd.toFixed(3).padStart(9)} ${((sd / st.sd - 1) * 100).toFixed(1).padStart(6)}%\n`,
  );
}

/* ------------------------------------------------------------------ *
 * 2. Isotropy
 * ------------------------------------------------------------------ */

/**
 * Directional variation of a field, measured the only way that works.
 *
 * A naive "sample along a line at angle u and compare variances" test is
 * INVALID for a lattice noise: it measures the line's alignment with the grid
 * and says nothing about the field.  The correct quantity is the expected
 * squared directional derivative,
 *
 *     E[(u . grad f)^2] = u^T H u,      H = E[grad f grad f^T]
 *
 * estimated by finite differences at a step SMALLER than the lattice spacing,
 * so the difference quotient approximates the derivative rather than a chord
 * between two lattice cells.  A perfectly isotropic field gives the same value
 * for every unit u.
 *
 * @returns {{min:number, max:number, anisotropy:number}} spread as a fraction
 */
function isotropy(field, step = 0.07, n = 20_000, angles = 24) {
  const H = [0, 0, 0, 0];       // symmetric 2x2, stored as [xx, xy, yy]
  const rnd = mulberry32(0x5EED);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = rnd() * 512, y = rnd() * 512;
    const gx = (field(x + step, y) - field(x - step, y)) / (2 * step);
    const gy = (field(x, y + step) - field(x, y - step)) / (2 * step);
    H[0] += gx * gx; H[1] += gx * gy; H[3] += gy * gy;
    count++;
  }
  H[0] /= count; H[1] /= count; H[3] /= count;

  let min = Infinity, max = -Infinity;
  for (let a = 0; a < angles; a++) {
    const th = (a / angles) * Math.PI * 2;
    const ux = Math.cos(th), uy = Math.sin(th);
    const q = ux * ux * H[0] + 2 * ux * uy * H[1] + uy * uy * H[3];
    if (q < min) min = q;
    if (q > max) max = q;
  }
  const mid = (min + max) / 2;
  return { min, max, anisotropy: (max - min) / (2 * mid) };
}

section("2. ISOTROPY  (directional derivative spread; 0% = perfectly isotropic)");

const plain = (x, y) => perlin2(x, y);
const p = isotropy(plain);
row("perlin2, single octave", pct(p.anisotropy), "", "<- the lattice's own bias");

for (const name of ["continental", "detail", "ridge", "cloud", "storm", "biome"]) {
  const fr = THETA_FREQ[name];
  const q = isotropy((x, y) => noise.sample2(name, x, y, fr.period));
  row(`layer "${name}"`, pct(q.anisotropy), "",
    q.anisotropy < 0.08 ? "ok" : "HIGH — check the octave table");
}

/*
 * The gradient-bias fix is what keeps the single-octave number above small.
 * Perlin's textbook grad() maps a 4-bit hash through a 16-way branch onto 12
 * edge midpoints, so 4 of the 12 directions are chosen twice as often and the
 * field visibly favours the diagonals.  ERNAS indexes unit-gradient tables with
 * Lemire multiply-shift instead.  This asserts the tables are what they claim.
 */
section("2b. GRADIENT TABLES");
row("GRAD2 entries", GRAD2.length / 2, "vectors");
{
  let worst = 0, minLen = Infinity, maxLen = -Infinity;
  for (let i = 0; i < GRAD2.length; i += 2) {
    const l = Math.hypot(GRAD2[i], GRAD2[i + 1]);
    minLen = Math.min(minLen, l); maxLen = Math.max(maxLen, l);
    worst = Math.max(worst, Math.abs(l - 1));
  }
  row("max |length - 1|", f4(worst), "", minLen === maxLen ? "all unit length" : "MIXED lengths");
}

/* ------------------------------------------------------------------ *
 * 3. Tileability / the theta seam
 * ------------------------------------------------------------------ */

section("3. THETA SEAM  (the tube closes on itself at i = 0)");

{
  /*
   * Compare the jump ACROSS the seam against the worst adjacent jump anywhere
   * else.  If the seam is clean, the worst seam jump is no worse than the worst
   * interior jump — comparing against the AVERAGE interior jump would be the
   * wrong test, since a single outlier anywhere would then look like a seam.
   */
  const K = 64;
  let seamWorst = 0;
  for (let k = 1000; k < 1000 + K; k++) {
    const a = terrain.surfaceRadius(WORLD.THETA_COUNT - 1, k);
    const b = terrain.surfaceRadius(0, k);
    seamWorst = Math.max(seamWorst, Math.abs(b - a));
  }
  let interiorWorst = 0, interiorSum = 0, n = 0;
  for (let k = 1000; k < 1000 + K; k++) {
    for (let i = 0; i < WORLD.THETA_COUNT; i += 16) {
      const d = Math.abs(terrain.surfaceRadius(i + 1, k) - terrain.surfaceRadius(i, k));
      interiorWorst = Math.max(interiorWorst, d);
      interiorSum += d; n++;
    }
  }
  row("worst seam jump (i=8191 -> 0)", f3(seamWorst), "blocks");
  row("worst interior jump", f3(interiorWorst), "blocks");
  row("mean interior jump", f3(interiorSum / n), "blocks");
  row("seam vs worst interior", seamWorst <= interiorWorst ? "CLEAN" : "SEAM VISIBLE", "",
    seamWorst <= interiorWorst ? "" : "<- the tile period is wrong somewhere");
}

{
  // Exact periodicity, tested on the raw layer rather than the height field.
  let worst = 0;
  for (const name of ["continental", "detail", "ridge", "cloud", "storm", "biome"]) {
    const fr = THETA_FREQ[name];
    const xAt = (i) => i * fr.freq;
    for (let s = 0; s < 200; s++) {
      const k = 1000 + s;
      const a = noise.sample2(name, xAt(0), k * fr.freq, fr.period);
      const b = noise.sample2(name, xAt(WORLD.THETA_COUNT), k * fr.freq, fr.period);
      worst = Math.max(worst, Math.abs(a - b));
    }
  }
  row("layer wrap error (x vs x+period)", worst.toExponential(2), "",
    worst < 1e-9 ? "exact" : "NOT EXACT — seam will show");
}

{
  // And the primitive tiled Perlin itself, independent of the fractal layers.
  let worst = 0;
  for (let s = 0; s < 5000; s++) {
    const y = s * 0.37;
    worst = Math.max(worst, Math.abs(perlin2Tiled(0, y, 64, 0) - perlin2Tiled(64, y, 64, 0)));
  }
  row("perlin2Tiled wrap error (p=64)", worst.toExponential(2), "", worst < 1e-12 ? "exact" : "NOT EXACT");
}

/* ------------------------------------------------------------------ *
 * 4. Octave spectrum
 * ------------------------------------------------------------------ */

section("4. OCTAVE SPECTRUM  (does the amplitude actually decay?)");

for (const [name, def] of Object.entries(NOISE_LAYERS)) {
  if (NOISE_LAYERS[name].kind === "warp2") continue;   // warped: not a plain sum
  const table = makeOctaveTable(def);
  const amps = table.amp ?? table.amplitudes ?? null;
  if (!amps) {
    row(`"${name}"`, "n/a", "", "(octave table shape not recognised)");
    continue;
  }
  const norm = amps[0];
  row(`"${name}" (${def.octaves} oct)`,
    [...amps].map((a) => (a / norm).toFixed(2)).join(" "), "",
    `gain ${def.gain}, sum ${[...amps].reduce((a, b) => a + b, 0).toFixed(2)}`);
}

/* ------------------------------------------------------------------ *
 * 5. World-level outcome
 * ------------------------------------------------------------------ */

section("5. WORLD OUTCOME  (what the noise actually produced)");

{
  const counts = new Map();
  let lo = Infinity, hi = -Infinity, n = 0;
  let d1 = 0, d4 = 0, d8 = 0, d16 = 0, worst = 0;
  for (let k = 950; k < 1150; k += 2) {
    for (let i = 0; i < WORLD.THETA_COUNT; i += 4) {
      const r = terrain.surfaceRadius(i, k);
      counts.set(terrain.biomeAtCached(i, k), (counts.get(terrain.biomeAtCached(i, k)) ?? 0) + 1);
      if (r < lo) lo = r;
      if (r > hi) hi = r;
      const d = Math.abs(terrain.surfaceRadius(i + 1, k) - r);
      worst = Math.max(worst, d);
      if (d > 1) d1++;
      if (d > 4) d4++;
      if (d > 8) d8++;
      if (d > 16) d16++;
      n++;
    }
  }
  row("columns sampled", n, "columns");
  row("surface radius range", `${lo.toFixed(0)}..${hi.toFixed(0)}`, "blocks");
  row("worst adjacent step", f3(worst), "blocks", worst < 12 ? "climbable" : "SHEER WALL");
  row("columns stepping >1 block", pct(d1 / n));
  row("columns stepping >4 blocks", pct(d4 / n));
  row("columns stepping >8 blocks", pct(d8 / n));
  row("columns stepping >16 blocks", d16 === 0 ? "0" : pct(d16 / n), "",
    d16 === 0 ? "none — no sheer walls" : `${d16} CLIFFS`);
  process.stdout.write("  biomes:");
  for (const [id, c] of [...counts].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${BIOME_NAMES[id] ?? id}=${pct(c / n)}`);
  }
  process.stdout.write("\n");
}

process.stdout.write(`\n  generated in ${performance.now().toFixed(0)} ms (process uptime)\n\n`);
