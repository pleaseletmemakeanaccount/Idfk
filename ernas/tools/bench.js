#!/usr/bin/env node
/**
 * ERNAS ENGINE — tools/bench.js
 * =====================================================================
 *  Where the milliseconds actually go.
 * =====================================================================
 *
 * Run: `npm run bench`   (or `node tools/bench.js --seed=ERNAS --repeats=5`)
 *
 * Every number this prints was used to make a decision in the engine, and the
 * decision is recorded next to the code it affected.  Re-run it after changing
 * the generator, the mesher or the lighting pass; if a stage moves by more than
 * about 20%, the comment quoting it is now a lie.
 *
 * MEASUREMENT RULES THIS FILE FOLLOWS, because getting them wrong produces
 * numbers that are confidently meaningless:
 *
 *  - Column patches are cached, so the FIRST terrain sample in a patch costs
 *    ~40x what later ones cost.  Every loop warms the cache over its own range
 *    before timing.  Otherwise you are measuring cache misses and calling it
 *    "generation" — that mistake was made once here and reported 40 us/call for
 *    terrain sampling instead of 0.5.
 *  - JIT warm-up, not timer resolution, is the real noise source.  Every figure
 *    is a best-of-N, not a single pass.
 *  - The three pipeline stages are timed by calling generateChunk, lightChunk
 *    and meshChunk SEPARATELY.  Going through `world.ensureChunk` for the
 *    generation stage silently includes lighting and inflates it ~2x.
 *  - Unit conversions are stated once, in `perMicro` / `perMega` below, rather
 *    than inline at each call site where they are easy to get backwards.
 */

import { performance } from "node:perf_hooks";
/*
 * `THETA_CHUNKS` and `Z_CHUNKS` are module-level exports, NOT properties of
 * `WORLD`.  An earlier version of this file wrote `WORLD.THETA_CHUNKS`, got
 * `undefined`, produced `ci = NaN` for every chunk pick, and then reported
 * perfectly plausible-looking pipeline timings that were actually measured on
 * 45 fully-solid chunks — no faces, no light gradient, nothing.  The guard
 * below exists so that cannot happen quietly again.
 */
import { WORLD, THETA_CHUNKS } from "../src/world/cylinderGeometry.js";
import { makeTerrain } from "../src/world/generator.js";
import { World } from "../src/world/world.js";
import { Chunk, generateChunk, CHUNK_STATE } from "../src/world/chunk.js";
import { lightChunk } from "../src/world/lighting.js";
import { meshChunk } from "../src/world/mesher.js";
import { NoiseEngine, NOISE_LAYERS } from "../src/noise/index.js";
import { perlin3 } from "../src/noise/perlin.js";

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  }),
);
const SEED = args.get("seed") || "ERNAS";
const REPEATS = args.get("repeats") ? Number(args.get("repeats")) : 3;

let wroteHeader = false;
function section(title) {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`);
  wroteHeader = true;
}
function row(label, value, unit = "", note = "") {
  process.stdout.write(
    `  ${label.padEnd(40)} ${String(value).padStart(10)} ${unit.padEnd(9)} ${note}\n`,
  );
}

/** samples -> millions per second, given elapsed milliseconds. */
const perMega = (n, ms) => n / (ms * 1000);
/** n operations -> microseconds each, given elapsed milliseconds. */
const perMicro = (n, ms) => (ms * 1000) / n;

function bestOf(fn, n = REPEATS) {
  let best = Infinity;
  for (let i = 0; i < n; i++) best = Math.min(best, fn());
  return best;
}

const f2 = (x) => x.toFixed(2);
const f3 = (x) => x.toFixed(3);

/**
 * Keeps a computed value alive so the JIT cannot delete the loop that produced
 * it.  Every timed loop feeds its accumulator in here.
 */
let sink = 0;
function keep(v) { sink += v; if (sink > 1e12) sink = 0; }

/* ------------------------------------------------------------------ *
 * 1. Noise throughput
 * ------------------------------------------------------------------ */

section(`1. NOISE THROUGHPUT  (best of ${REPEATS})`);

const N = 400_000;
const noise = new NoiseEngine(SEED);

{
  const rate = bestOf(() => {
    const t0 = performance.now();
    for (let s = 0; s < N; s++) keep(perlin3(s * 0.0173, s * 0.0091, s * 0.0211));
    return perMega(N, performance.now() - t0);
  });
  row("perlin3, single octave (reference)", f2(rate), "M samples/s");
}

for (const [name, def] of Object.entries(NOISE_LAYERS)) {
  const is3d = def.kind === "fbm3";
  const rate = bestOf(() => {
    const t0 = performance.now();
    for (let s = 0; s < N; s++) {
      const x = s * 0.0137, y = s * 0.0071, z = s * 0.0191;
      keep(is3d ? noise.sample3(name, x, y, z, 0) : noise.sample2(name, x, y, 0));
    }
    return perMega(N, performance.now() - t0);
  });
  const rel = "";
  row(`layer "${name}" (${is3d ? "3D" : "2D"}, ${def.octaves} oct)`, f2(rate), "M samples/s", rel);
}

/* ------------------------------------------------------------------ *
 * 2. Terrain column sampling
 * ------------------------------------------------------------------ */

section("2. TERRAIN COLUMN SAMPLING");

const terrain = makeTerrain(SEED);

// Warm the exact range the timed loops will touch, untimed.
for (let k = 1000; k < 1300; k += 16) for (let i = 0; i < 8192; i += 64) terrain.surfaceRadius(i, k);

const SR_N = 200_000;
row("surfaceRadius, WARM column cache", f2(bestOf(() => {
  const t0 = performance.now();
  for (let s = 0; s < SR_N; s++) keep(terrain.surfaceRadius((s * 3) % 8192, 1000 + (s % 200)));
  return perMicro(SR_N, performance.now() - t0);
})), "us/call");

terrain.invalidate();
row("surfaceRadius, COLD cache", f2(bestOf(() => {
  terrain.invalidate();
  const t0 = performance.now();
  for (let s = 0; s < 4000; s++) keep(terrain.surfaceRadius(s % 8192, 1000 + (s % 64)));
  return perMicro(4000, performance.now() - t0);
}, 2)), "us/call", "<- this is what a cold patch costs");

// Re-warm, then time voxel sampling.
for (let k = 1000; k < 1100; k += 16) for (let i = 0; i < 8192; i += 64) terrain.sample(i, 1270, k);
const VS_N = 200_000;
row("terrain.sample(i,j,k), warm", f2(bestOf(() => {
  const t0 = performance.now();
  for (let s = 0; s < VS_N; s++) keep(terrain.sample(s % 8192, 1270 + (s % 60), 1000 + (s % 100)));
  return perMicro(VS_N, performance.now() - t0);
})), "us/call");

const FO_N = 200_000;
row("firstOpaqueRadius (cached in patch)", f2(bestOf(() => {
  const t0 = performance.now();
  for (let s = 0; s < FO_N; s++) keep(terrain.firstOpaqueRadius(s % 8192, 1000 + (s % 200)));
  return perMicro(FO_N, performance.now() - t0);
})), "us/call", "<- was 54us before the patch cache");

/* ------------------------------------------------------------------ *
 * 3. Chunk pipeline
 * ------------------------------------------------------------------ */

section("3. CHUNK PIPELINE  (per 16^3 chunk)");

const world = new World(terrain);
const COUNT = 45;

/*
 * Pick chunks straddling the surface.  A chunk deep underground is almost
 * uniform — no faces, no light gradient — and would flatter every number below.
 */
const picks = [];
for (let n = 0; n < COUNT; n++) {
  const ci = (n * 137) % THETA_CHUNKS;
  const ck = 60 + ((n * 29) % 40);
  const surf = terrain.surfaceRadius(ci * WORLD.CHUNK + 8, ck * WORLD.CHUNK + 8);
  const cj = Math.max(0, Math.floor(surf / WORLD.CHUNK) - 2 + (n % 4));
  picks.push([ci, cj, ck]);
}

// Fail loudly rather than measuring the wrong thing.
for (const [ci, cj, ck] of picks) {
  if (!Number.isFinite(ci) || !Number.isFinite(cj) || !Number.isFinite(ck)) {
    throw new Error(
      `bench: chunk pick is not finite (ci=${ci} cj=${cj} ck=${ck}) — ` +
      `a geometry constant is being read from the wrong place`,
    );
  }
}
if (!picks.every(([, cj]) => cj >= 70 && cj <= 90)) {
  throw new Error(
    `bench: chunk picks do not straddle the surface (radial chunk range ` +
    `${Math.min(...picks.map((p) => p[1]))}..${Math.max(...picks.map((p) => p[1]))}); ` +
    `the pipeline numbers would describe solid rock, not terrain`,
  );
}

/** Build fresh Chunk objects so no stage can read a previous stage's work. */
function freshChunks() {
  return picks.map(([ci, cj, ck]) => new Chunk(ci, cj, ck));
}

const tGen = bestOf(() => {
  const chunks = freshChunks();
  const t0 = performance.now();
  for (const c of chunks) generateChunk(c, terrain, world.overrides);
  return (performance.now() - t0) / chunks.length;
});

// Lighting needs the chunks present in the world so cross-chunk reads resolve.
const tLight = bestOf(() => {
  for (const k of [...world.chunks.keys()]) world.chunks.delete(k);
  const chunks = freshChunks();
  for (const c of chunks) { generateChunk(c, terrain, world.overrides); world.chunks.set(c.key, c); }
  const t0 = performance.now();
  for (const c of chunks) lightChunk(world, c);
  return (performance.now() - t0) / chunks.length;
});

const tMesh = bestOf(() => {
  for (const k of [...world.chunks.keys()]) world.chunks.delete(k);
  const chunks = freshChunks();
  for (const c of chunks) {
    generateChunk(c, terrain, world.overrides);
    lightChunk(world, c);
    world.chunks.set(c.key, c);
  }
  const t0 = performance.now();
  let faces = 0;
  for (const c of chunks) faces += meshChunk(world, c)?.faceCount ?? 0;
  keep(faces);
  return (performance.now() - t0) / chunks.length;
});

/*
 * Generation above is measured with a WARM column-patch cache.  In the running
 * game a chunk entering the streaming radius usually needs a patch nobody has
 * built yet, and a patch is 256 columns of height field.  This row measures
 * that, so the frame budget in main.js is not planned against a number the
 * streamer will never actually see.
 */
const tGenCold = bestOf(() => {
  terrain.invalidate();
  const chunks = freshChunks();
  const t0 = performance.now();
  for (const c of chunks) generateChunk(c, terrain, world.overrides);
  return (performance.now() - t0) / chunks.length;
}, 2);

const total = tGen + tLight + tMesh;
row("generate  (noise + biome + materials)", f2(tGen), "ms", "<- warm patch cache");
row("generate, COLD patch cache", f2(tGenCold), "ms",
  `<- patches are shared, amortises over ~${f2(tGenCold / Math.max(0.01, tGen))}x`);
row("light     (dual-channel BFS, (C+2)^3)", f2(tLight), "ms");
row("mesh      (faces + AO + packed attrs)", f2(tMesh), "ms");
row("TOTAL per chunk", f2(total), "ms");
row("=> chunks per 16 ms frame", f2(16 / total), "chunks",
  "<- main.js budgets 12 ms for mesh+upload");

/* ------------------------------------------------------------------ *
 * 4. Mesh yield
 * ------------------------------------------------------------------ */

section("4. MESH YIELD");

let faces = 0, verts = 0, noGeo = 0;
for (const c of world.chunks.values()) {
  const m = meshChunk(world, c);
  if (!m) { noGeo++; continue; }
  faces += m.faceCount;
  verts += m.vertexCount;
}
const built = world.chunks.size - noGeo;
row("chunks sampled", world.chunks.size, "chunks");
row("chunks with geometry", built, "chunks", `(${noGeo} empty/uniform)`);
row("mean faces per built chunk", f2(faces / Math.max(1, built)), "faces");
row("mean vertices per built chunk", f2(verts / Math.max(1, built)), "verts");
row("GPU bytes per built chunk", f2(
  (verts * (3 * 4 + 4) + faces * 6 * 4) / Math.max(1, built) / 1024), "KiB");

/* ------------------------------------------------------------------ *
 * 5. World streaming
 * ------------------------------------------------------------------ */

section("5. WORLD STREAMING  (world.update, budget 2/frame)");

const world2 = new World(makeTerrain(SEED));
const frames = 120;
const t0 = performance.now();
let made = 0;
for (let f = 0; f < frames; f++) made += world2.update(32, 79, 64, 7, 2);
const totalMs = performance.now() - t0;
row("frames simulated", frames, "frames");
row("chunks generated", made, "chunks");
row("mean world.update cost", f3(totalMs / frames), "ms/frame");
row("resident chunks at rest", world2.chunks.size, "chunks");

process.stdout.write(
  `\n  seed "${SEED}"  node ${process.version}  ` +
  `(keep=${sink === Infinity ? "?" : "ok"})\n\n`,
);
void CHUNK_STATE; void wroteHeader;
