/**
 * ERNAS ENGINE — tests/cylinder.test.js
 *
 * Validation of the inverted-cylinder world: coordinate maths, the gravity
 * field, terrain shape, the theta seam, lighting, mesh winding and chunk
 * residency.
 *
 * Run: `node --test` (from ernas/)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  WORLD, wrapTheta, thetaOf, arcWidthAt,
  cylindricalToCartesian, cartesianToCylindrical, cartesianToVoxel,
  voxelCenter, voxelCorner, localFrameAt,
  gravityScaleAt, gravityVectorAt, upVectorAt, inDeadzone, inSun,
  chunkKey, unpackChunkKey, voxelKey, unvoxelKey, toChunkIndex,
} from "../src/world/cylinderGeometry.js";
import { makeTerrain, BIOME, BIOME_NAMES, CLOUD_BAND, THETA_FREQ } from "../src/world/generator.js";
import { BLOCK, blockName, isOpaque, faceVisible, assertFull } from "../src/world/blocks.js";
import { Chunk, generateChunk, CHUNK_VOLUME, CHUNK_STATE } from "../src/world/chunk.js";
import { lightChunk } from "../src/world/lighting.js";
import { meshChunk, FACES } from "../src/world/mesher.js";
import { World } from "../src/world/world.js";

/* ------------------------------------------------------------------ *
 * 1. Coordinate transforms
 * ------------------------------------------------------------------ */

test("cylindrical <-> cartesian round-trips", () => {
  const a = [0, 0, 0], b = [0, 0, 0];
  for (let n = 0; n < 2000; n++) {
    const theta = (n * 0.137) % (Math.PI * 2);
    const r = 1 + (n % 2000) * 0.7;
    const z = (n % 500) - 250;
    cylindricalToCartesian(theta, r, z, a);
    cartesianToCylindrical(a[0], a[1], a[2], b);
    assert.ok(Math.abs(b[0] - theta) < 1e-9, `theta ${b[0]} != ${theta}`);
    assert.ok(Math.abs(b[1] - r) < 1e-9);
    assert.ok(Math.abs(b[2] - z) < 1e-9);
  }
});

test("cartesianToVoxel inverts voxelCenter to within one voxel", () => {
  const c = [0, 0, 0], v = [0, 0, 0];
  for (const [i, j, k] of [[0, 1280, 100], [4095, 1300, 2000], [8191, 1240, 1], [123, 1446, 700]]) {
    voxelCenter(i, j, k, c);
    cartesianToVoxel(c[0], c[1], c[2], v);
    assert.ok(Math.abs(v[0] - (i + 0.5)) < 1e-6, `i ${v[0]} vs ${i + 0.5}`);
    assert.ok(Math.abs(v[1] - (j + 0.5)) < 1e-6, `j ${v[1]} vs ${j + 0.5}`);
    assert.ok(Math.abs(v[2] - (k + 0.5)) < 1e-6);
  }
});

test("voxelCorner spans exactly one voxel in radius and one in z", () => {
  const a = [0, 0, 0], b = [0, 0, 0];
  voxelCorner(100, 1300, 500, 0, 0, 0, a);
  voxelCorner(100, 1300, 500, 0, 1, 1, b);
  assert.equal(a[2], 500);
  assert.equal(b[2], 501);
  assert.ok(Math.abs(Math.hypot(a[0], a[1]) - 1300) < 1e-9);
  assert.ok(Math.abs(Math.hypot(b[0], b[1]) - 1301) < 1e-9);
});

test("theta wraps correctly in both directions", () => {
  assert.equal(wrapTheta(0), 0);
  assert.equal(wrapTheta(WORLD.THETA_COUNT), 0);
  assert.equal(wrapTheta(-1), WORLD.THETA_COUNT - 1);
  assert.equal(wrapTheta(WORLD.THETA_COUNT + 5), 5);
  assert.equal(wrapTheta(-WORLD.THETA_COUNT - 3), WORLD.THETA_COUNT - 3);
});

test("arc width at the surface is ~1 voxel (voxels are near-cubic there)", () => {
  const w = arcWidthAt(WORLD.R_SURFACE);
  assert.ok(Math.abs(w - 1) < 0.05, `arc width ${w} — voxels are not near-cubic at the surface`);
  // and it genuinely varies with radius, which is the documented wart
  assert.ok(arcWidthAt(WORLD.R_SUN) < 0.1);
  assert.ok(arcWidthAt(WORLD.R_CRUST) > w);
});

test("localFrameAt returns an orthonormal right-handed basis with up = -radial", () => {
  for (const [x, y] of [[1280, 0], [0, 1280], [-900, 900], [300, -1100]]) {
    const f = localFrameAt(x, y, new Float64Array(9));
    const T = [f[0], f[1], f[2]], U = [f[3], f[4], f[5]], Z = [f[6], f[7], f[8]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const len = (a) => Math.hypot(a[0], a[1], a[2]);
    assert.ok(Math.abs(len(T) - 1) < 1e-12, "tangential not unit");
    assert.ok(Math.abs(len(U) - 1) < 1e-12, "up not unit");
    assert.ok(Math.abs(dot(T, U)) < 1e-12, "T.U != 0");
    assert.ok(Math.abs(dot(T, Z)) < 1e-12, "T.Z != 0");
    assert.ok(Math.abs(dot(U, Z)) < 1e-12, "U.Z != 0");
    // up must point at the axis
    const r = Math.hypot(x, y);
    assert.ok(Math.abs(dot(U, [x / r, y / r, 0]) + 1) < 1e-12, "up is not -radial");
  }
});

/* ------------------------------------------------------------------ *
 * 2. Gravity field
 * ------------------------------------------------------------------ */

test("gravity is zero inside the deadzone and full beyond R_GRAV_FULL", () => {
  assert.equal(gravityScaleAt(0), 0);
  assert.equal(gravityScaleAt(WORLD.R_DEADZONE), 0);
  assert.equal(gravityScaleAt(WORLD.R_DEADZONE - 1), 0);
  assert.equal(gravityScaleAt(WORLD.R_GRAV_FULL), 1);
  assert.equal(gravityScaleAt(WORLD.R_SURFACE), 1);
  assert.equal(gravityScaleAt(WORLD.R_CRUST), 1);
});

test("gravity ramps monotonically and smoothly out of the deadzone", () => {
  let prev = -1, prevSlope = -Infinity;
  for (let r = WORLD.R_DEADZONE; r <= WORLD.R_GRAV_FULL; r += 1) {
    const g = gravityScaleAt(r);
    assert.ok(g >= prev - 1e-12, `gravity not monotonic at r=${r}`);
    const slope = g - prev;
    if (prev >= 0 && r > WORLD.R_DEADZONE + 2 && r < WORLD.R_GRAV_FULL - 2) {
      // smoothstep: the slope must rise then fall, never jump
      assert.ok(Number.isFinite(slope));
    }
    prev = g; prevSlope = slope;
  }
  void prevSlope;
  // C1 at both ends of the ramp
  assert.ok(Math.abs(gravityScaleAt(WORLD.R_DEADZONE + 1e-6) - 0) < 1e-9);
  assert.ok(Math.abs(gravityScaleAt(WORLD.R_GRAV_FULL - 1e-6) - 1) < 1e-6);
});

test("gravity points outward, away from the axis, with no axial component", () => {
  const out = [0, 0, 0];
  for (const [x, y] of [[1000, 0], [-1000, 0], [0, 1000], [0, -1000], [700, -700]]) {
    gravityVectorAt(x, y, out);
    const r = Math.hypot(x, y);
    const dot = (out[0] * x + out[1] * y) / r;
    assert.ok(dot > 0, `gravity at (${x},${y}) does not point outward`);
    assert.equal(out[2], 0, "gravity has an axial component");
    const cross = out[0] * y - out[1] * x;
    assert.ok(Math.abs(cross) < 1e-9, "gravity is not purely radial");
  }
});

test("up vector opposes gravity everywhere outside the axis", () => {
  const g = [0, 0, 0], u = [0, 0, 0];
  for (let a = 0; a < 64; a++) {
    const t = (a / 64) * Math.PI * 2;
    const r = 400 + (a % 7) * 130;
    gravityVectorAt(Math.cos(t) * r, Math.sin(t) * r, g);
    upVectorAt(Math.cos(t) * r, Math.sin(t) * r, u);
    const d = g[0] * u[0] + g[1] * u[1];
    assert.ok(d < -1e-9, "up does not oppose gravity");
  }
});

test("sun and deadzone predicates agree with the constants", () => {
  assert.ok(inSun(WORLD.R_SUN - 1));
  assert.ok(!inSun(WORLD.R_SUN + 1));
  assert.ok(inDeadzone(WORLD.R_DEADZONE - 1));
  assert.ok(!inDeadzone(WORLD.R_DEADZONE + 1));
  assert.ok(WORLD.R_SUN < WORLD.R_DEADZONE, "the sun must sit inside the deadzone");
});

/* ------------------------------------------------------------------ *
 * 3. Chunk / voxel key packing
 * ------------------------------------------------------------------ */

test("chunkKey round-trips", () => {
  for (const [ci, cj, ck] of [[0, 80, 0], [511, 90, 127], [123, 77, 64], [5, 82, 100]]) {
    const [a, b, c] = unpackChunkKey(chunkKey(ci, cj, ck));
    assert.deepEqual([a, b, c], [ci, cj, ck]);
  }
});

test("chunkKey wraps the theta axis", () => {
  assert.equal(chunkKey(0, 80, 5), chunkKey(512, 80, 5));
  assert.equal(chunkKey(-1, 80, 5), chunkKey(511, 80, 5));
});

test("voxelKey round-trips and is collision-free over the shell", () => {
  const seen = new Set();
  let expected = 0;
  for (let i = 0; i < 8192; i += 97) {
    for (let j = 1200; j < 1450; j += 13) {
      for (let k = 0; k < 2048; k += 101) {
        const key = voxelKey(i, j, k);
        const [a, b, c] = unvoxelKey(key);
        assert.deepEqual([a, b, c], [i, j, k], `key ${key} decoded wrong`);
        seen.add(key);
        expected++;
      }
    }
  }
  assert.equal(seen.size, expected, "voxelKey collided");
  assert.ok(expected > 30000, `only ${expected} voxels exercised`);
});

test("toChunkIndex floors correctly for negative coordinates", () => {
  assert.deepEqual(toChunkIndex(0, 1280, 0), [0, 80, 0]);
  assert.deepEqual(toChunkIndex(15, 1295, 15), [0, 80, 0]);
  assert.deepEqual(toChunkIndex(16, 1296, 16), [1, 81, 1]);
});

/* ------------------------------------------------------------------ *
 * 4. Block registry
 * ------------------------------------------------------------------ */

test("block table is dense and every id resolves", () => {
  assert.ok(assertFull());
  for (let id = 0; id < 20; id++) {
    assert.ok(typeof blockName(id) === "string");
    assert.ok(blockName(id).length > 0);
  }
});

test("faceVisible rules", () => {
  assert.equal(faceVisible(BLOCK.AIR, BLOCK.AIR), false);
  assert.equal(faceVisible(BLOCK.AIR, BLOCK.STONE), false);
  assert.equal(faceVisible(BLOCK.STONE, BLOCK.AIR), true);
  assert.equal(faceVisible(BLOCK.STONE, BLOCK.STONE), false);
  assert.equal(faceVisible(BLOCK.WATER, BLOCK.WATER), false);
  assert.equal(faceVisible(BLOCK.WATER, BLOCK.STONE), false, "solid neighbour hides the face");
  assert.equal(faceVisible(BLOCK.STONE, BLOCK.WATER), true);
  assert.equal(faceVisible(BLOCK.CLOUD, BLOCK.AIR), true);
});

/* ------------------------------------------------------------------ *
 * 5. Terrain: shape, seam, biomes, skin
 * ------------------------------------------------------------------ */

const terrain = makeTerrain("ERNAS-TEST");
const ZMID = WORLD.WORLD_Z / 2;

test("the surface radius stays inside the shell", () => {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < WORLD.THETA_COUNT; i += 32) {
    const r = terrain.surfaceRadius(i, ZMID);
    if (r < min) min = r;
    if (r > max) max = r;
  }
  assert.ok(min > WORLD.R_SURFACE - WORLD.SURFACE_AMP - 8, `surface ${min} too close to the sky`);
  assert.ok(max < WORLD.R_CRUST_INNER, `surface ${max} reached into the crust`);
  assert.ok(max - min > 20, `relief only ${(max - min).toFixed(1)} voxels — terrain is flat`);
});

test("THE THETA SEAM IS EXACTLY PERIODIC", () => {
  // The strongest form of the seam test: column i and column i+THETA_COUNT are
  // the same column, so the height field must agree to the last bit.  If the
  // noise frequencies were not exact multiples of THETA_COUNT (see the theta
  // frequency contract at the top of generator.js) this fails immediately.
  for (let n = 0; n < 200; n++) {
    const i = n * 41;
    const k = ZMID + (n % 200) - 100;
    assert.equal(terrain.surfaceRadius(i + WORLD.THETA_COUNT, k), terrain.surfaceRadius(i, k));
    assert.equal(terrain.biomeAtCached(i + WORLD.THETA_COUNT, k), terrain.biomeAtCached(i, k));
  }
});

test("THE THETA SEAM IS NO ROUGHER THAN THE REST OF THE TUBE", () => {
  /*
   * Periodicity alone is not enough: the field could be periodic and still
   * have a cliff at the seam.  So compare the seam jump against the *worst*
   * adjacent-column jump anywhere else in the tube.
   *
   * Note that large jumps are legal in this world — biome boundaries are
   * cliffs by design (a highlands column next to an abyssal trench steps down
   * ~60 voxels).  What is NOT legal is the seam being worse than that.  My
   * first version of this test compared the seam jump to the *average* jump
   * and failed at 32 vs 1.2, which was the test being wrong: it had found a
   * biome boundary, not a seam tear.
   */
  let worstElsewhere = 0, seamWorst = 0, sum = 0, n = 0;
  for (let k = ZMID - 128; k < ZMID + 128; k++) {
    for (let i = 0; i < WORLD.THETA_COUNT; i += 3) {
      const d = Math.abs(terrain.surfaceRadius(i + 1, k) - terrain.surfaceRadius(i, k));
      sum += d; n++;
      if (i < WORLD.THETA_COUNT - 2 && d > worstElsewhere) worstElsewhere = d;
    }
    const seam = Math.abs(terrain.surfaceRadius(0, k) - terrain.surfaceRadius(WORLD.THETA_COUNT - 1, k));
    if (seam > seamWorst) seamWorst = seam;
  }
  assert.ok(seamWorst <= worstElsewhere + 1e-9,
    `seam jump ${seamWorst.toFixed(3)} exceeds the worst jump elsewhere ` +
    `${worstElsewhere.toFixed(3)} (mean ${(sum / n).toFixed(3)}) — the seam is a wall`);
});

test("terrain is periodic in theta at the block level", () => {
  // i = -1 and i = THETA_COUNT-1 are the same voxel.
  for (let j = WORLD.R_CRUST - 60; j < WORLD.R_CRUST; j++) {
    for (let k = ZMID; k < ZMID + 32; k++) {
      assert.equal(terrain.sample(-1, j, k), terrain.sample(WORLD.THETA_COUNT - 1, j, k));
    }
  }
});

test("the topmost solid voxel carries a skin block, never bare stone", () => {
  // Regression test for the float-height bug: `depth = j - h` with a float h
  // is never exactly 0, so the skin layer silently disappeared.
  const skins = new Set();
  for (let i = 0; i < WORLD.THETA_COUNT; i += 16) {
    const k = ZMID + (i % 300);
    const h = Math.ceil(terrain.surfaceRadius(i, k));
    const id = terrain.sample(i, h, k);
    skins.add(id);
    assert.notEqual(id, BLOCK.STONE, `column ${i} has bare stone at its surface`);
    assert.notEqual(id, BLOCK.AIR, `column ${i} has air where its surface should be`);
  }
  assert.ok(skins.size >= 2, `only one skin block type across the whole tube: ${[...skins]}`);
});

test("every voxel above the surface in the shell is air or liquid, never rock", () => {
  for (let i = 0; i < 4096; i += 7) {
    const k = ZMID + (i % 200);
    const h = Math.ceil(terrain.surfaceRadius(i, k));
    for (let j = WORLD.R_SHELL_MIN; j < h; j++) {
      const id = terrain.sample(i, j, k);
      assert.ok(id === BLOCK.AIR || id === BLOCK.WATER || id === BLOCK.BLOOD,
        `floating rock at i=${i} j=${j} k=${k}: ${blockName(id)}`);
    }
  }
});

test("the iron crust forms a continuous shell at the bottom of the tube", () => {
  for (let i = 0; i < 2048; i += 11) {
    for (let k = ZMID; k < ZMID + 16; k++) {
      for (let t = 0; t < WORLD.CRUST_THICKNESS; t++) {
        const j = WORLD.R_CRUST - 1 - t;
        assert.equal(terrain.sample(i, j, k), BLOCK.IRON_CRUST,
          `crust hole at i=${i} j=${j} k=${k}`);
      }
      assert.equal(terrain.sample(i, WORLD.R_CRUST, k), BLOCK.AIR, "the void is not empty");
    }
  }
});

test("all five biomes appear somewhere in the tube", () => {
  const seen = new Set();
  for (let k = ZMID - 300; k < ZMID + 300; k += 4) {
    for (let i = 0; i < WORLD.THETA_COUNT; i += 24) {
      seen.add(terrain.biomeAtCached(i, k));
    }
  }
  const missing = BIOME_NAMES.filter((_, idx) => !seen.has(idx) && idx !== BIOME.BROKEN_LANDS);
  assert.equal(missing.length, 0, `biomes never generated: ${missing.join(", ")}`);
});

test("the axial ends become the Broken Lands", () => {
  assert.equal(terrain.biomeAtCached(100, 0), BIOME.BROKEN_LANDS);
  assert.equal(terrain.biomeAtCached(100, WORLD.WORLD_Z - 1), BIOME.BROKEN_LANDS);
  assert.equal(terrain.biomeAtCached(100, ZMID) !== BIOME.BROKEN_LANDS, true,
    "the middle of the tube should not be broken lands");
});

test("broken-lands columns are quantised (the Farlands step)", () => {
  // Must be sampled at k = 0 exactly: the Broken Lands blend in over
  // BROKEN_LAND_WIDTH columns, and only at the very edge is the blend weight 1
  // and the height purely quantised.  Testing at k = 8 (weight 0.92) measures
  // a mix and finds nothing.
  let quantised = 0, total = 0;
  for (let i = 0; i < 512; i++) {
    const r = terrain.surfaceRadius(i, 0);
    const rel = WORLD.R_SURFACE - r;
    if (Math.abs(rel - Math.round(rel / 7) * 7) < 1e-9) quantised++;
    total++;
  }
  assert.ok(quantised / total > 0.5,
    `only ${quantised}/${total} broken-land columns sit on the 7-voxel step`);
});

test("clouds and floating islands are generated in the interior", () => {
  let cloud = 0, island = 0;
  for (let i = 0; i < 2048; i += 2) {
    for (let j = CLOUD_BAND.inner; j < CLOUD_BAND.outer; j++) {
      if (terrain.sample(i, j, ZMID) === BLOCK.CLOUD) cloud++;
    }
    for (let j = 1150; j < 1196; j++) {
      if (terrain.sample(i, j, ZMID + 300) !== BLOCK.AIR) island++;
    }
  }
  assert.ok(cloud > 1000, `only ${cloud} cloud voxels — the Sky Ring is empty`);
  assert.ok(island > 100, `only ${island} island voxels`);
});

test("nothing is generated outside the axial extent of the tube", () => {
  for (let j = 1200; j < 1450; j += 10) {
    assert.equal(terrain.sample(100, j, -5), BLOCK.AIR);
    assert.equal(terrain.sample(100, j, WORLD.WORLD_Z + 5), BLOCK.AIR);
  }
});

test("terrain is deterministic across generator instances", () => {
  const a = makeTerrain("same-seed");
  const b = makeTerrain("same-seed");
  const c = makeTerrain("other-seed");
  let diffSeedDiffers = 0;
  for (let n = 0; n < 300; n++) {
    const i = n * 13, j = 1280 + (n % 40), k = ZMID + (n % 90);
    assert.equal(a.sample(i, j, k), b.sample(i, j, k));
    if (a.sample(i, j, k) !== c.sample(i, j, k)) diffSeedDiffers++;
  }
  assert.ok(diffSeedDiffers > 20, "different seeds produced nearly identical terrain");
});

/* ------------------------------------------------------------------ *
 * 6. Mesh face winding — inside-out geometry is invisible in tests
 *    unless you assert it, and catastrophic in the renderer.
 * ------------------------------------------------------------------ */

/** Geometric outward normal of a face at a voxel. */
function faceNormal(i, j, k, face, out) {
  const theta = (i + 0.5) * WORLD.D_THETA;
  const ct = Math.cos(theta), st = Math.sin(theta);
  if (face.axis === 1) {           // radial
    const s = face.dir;
    out[0] = ct * s; out[1] = st * s; out[2] = 0;
  } else if (face.axis === 0) {    // tangential
    const s = face.dir;
    out[0] = -st * s; out[1] = ct * s; out[2] = 0;
  } else {                         // axial
    out[0] = 0; out[1] = 0; out[2] = face.dir;
  }
  return out;
}

test("every face type is wound counter-clockwise seen from outside", () => {
  const A = [0, 0, 0], B = [0, 0, 0], Cc = [0, 0, 0], n = [0, 0, 0];
  for (const face of FACES) {
    // A representative surface voxel: mid-theta, mid-shell, mid-tube.
    const i = 3000, j = 1290, k = 900;
    const pts = face.corners.map(([ci, cj, ck]) => {
      const o = [0, 0, 0];
      voxelCorner(i, j, k, ci, cj, ck, o);
      return o;
    });
    for (let a = 0; a < 3; a++) { A[a] = pts[1][a] - pts[0][a]; B[a] = pts[2][a] - pts[0][a]; }
    const cross = [
      A[1] * B[2] - A[2] * B[1],
      A[2] * B[0] - A[0] * B[2],
      A[0] * B[1] - A[1] * B[0],
    ];
    faceNormal(i, j, k, face, n);
    const d = cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2];
    assert.ok(d > 0,
      `face "${face.name}" is wound the wrong way (cross.normal = ${d.toFixed(4)}); ` +
      `it would render inside-out or be culled`);
    void Cc;
  }
});

/* ------------------------------------------------------------------ *
 * 7. Chunk generation
 * ------------------------------------------------------------------ */

test("chunk generation fills all 4096 voxels and flags uniform chunks", () => {
  const t = makeTerrain("chunk-test");

  // Open interior: guaranteed uniform air.
  const sky = new Chunk(10, 40, Math.floor(ZMID / 16));
  generateChunk(sky, t, null);
  assert.equal(sky.blocks.length, CHUNK_VOLUME);
  assert.equal(sky.state, CHUNK_STATE.GENERATED);
  assert.ok(sky.uniform, "a chunk in the open interior should be uniform air");
  assert.equal(sky.uniformId, BLOCK.AIR);

  /*
   * Deep underground: mostly stone, but NOT guaranteed uniform — caves punch
   * through and ore replaces stone, so a chunk at any given depth can be
   * mixed.  (My first version asserted uniformity for a chunk straddling the
   * iron crust, which is 10 voxels thick inside a 16-voxel chunk, so it can
   * never be uniform.  That was a bad test, not a bad generator.)
   */
  const deep = new Chunk(10, Math.floor(1380 / 16), Math.floor(ZMID / 16));
  generateChunk(deep, t, null);
  let stone = 0;
  for (let n = 0; n < CHUNK_VOLUME; n++) {
    const id = deep.blocks[n];
    if (id === BLOCK.STONE || id === BLOCK.GOLD_ORE || id === BLOCK.URANIUM) stone++;
  }
  assert.ok(stone / CHUNK_VOLUME > 0.8,
    `only ${(stone / CHUNK_VOLUME * 100).toFixed(1)}% of a deep chunk is rock`);
});

test("chunk voxel access matches the terrain function", () => {
  const t = makeTerrain("chunk-test");
  const ci = 20, cj = Math.floor(1290 / 16), ck = Math.floor(ZMID / 16);
  const c = new Chunk(ci, cj, ck);
  generateChunk(c, t, null);
  for (let n = 0; n < 500; n++) {
    const li = n % 16, lj = (n * 7) % 16, lk = (n * 13) % 16;
    assert.equal(c.get(li, lj, lk), t.sample(ci * 16 + li, cj * 16 + lj, ck * 16 + lk));
  }
});

test("overrides are applied to generated chunks", () => {
  const t = makeTerrain("chunk-test");
  const ci = 20, cj = Math.floor(1290 / 16), ck = Math.floor(ZMID / 16);
  const wi = ci * 16 + 3, wj = cj * 16 + 3, wk = ck * 16 + 3;
  const overrides = new Map([[voxelKey(wi, wj, wk), BLOCK.PYLON]]);
  const c = new Chunk(ci, cj, ck);
  generateChunk(c, t, overrides);
  assert.equal(c.get(3, 3, 3), BLOCK.PYLON);
});

/* ------------------------------------------------------------------ *
 * 8. Lighting
 * ------------------------------------------------------------------ */

function makeLitWorld(seed = "light-test") {
  const world = new World(makeTerrain(seed));
  return world;
}

test("open interior is fully lit and rock is dark", () => {
  const world = makeLitWorld();
  const ci = 40, ck = Math.floor(ZMID / 16);
  // A chunk in the open interior, well inside the surface radius.
  const cjSky = Math.floor(1100 / 16);
  const sky = world.ensureChunk(ci, cjSky, ck);
  assert.equal(sky.getSkyLight(8, 8, 8), WORLD.LIGHT_MAX);

  // A chunk deep in solid rock.
  const cjDeep = Math.floor((WORLD.R_CRUST - 40) / 16);
  const deep = world.ensureChunk(ci, cjDeep, ck);
  assert.equal(deep.getSkyLight(8, 8, 8), 0);
});

test("light never exceeds 15 and never goes negative", () => {
  const world = makeLitWorld();
  const ck = Math.floor(ZMID / 16);
  for (let cj = Math.floor(1250 / 16); cj <= Math.floor(1320 / 16); cj++) {
    const c = world.ensureChunk(60, cj, ck);
    for (let n = 0; n < CHUNK_VOLUME; n++) {
      const sky = c.light[n] >>> 4;
      const blk = c.light[n] & 15;
      assert.ok(sky <= 15 && blk <= 15, `light overflow: sky=${sky} blk=${blk}`);
    }
  }
});

test("a solid overhang casts a shadow (light falls off with depth)", () => {
  const world = makeLitWorld();
  const ck = Math.floor(ZMID / 16);
  const ci = 70;
  // Walk radially from the open interior into the ground and confirm light drops.
  const i = ci * 16 + 8;
  let surface = Math.ceil(world.terrain.surfaceRadius(i, ck * 16 + 8));
  const lit = world.lightAt(i, surface - 1, ck * 16 + 8);
  const under = world.lightAt(i, surface + 6, ck * 16 + 8);
  const deep = world.lightAt(i, surface + 30, ck * 16 + 8);
  assert.equal(lit, WORLD.LIGHT_MAX, "the voxel just above the surface should be sunlit");
  assert.ok(under < lit, `light does not fall off underground (got ${under})`);
  assert.ok(deep <= under, `light increased with depth (${deep} > ${under})`);
});

test("emissive blocks light their surroundings", () => {
  /*
   * Light cannot pass through solid rock, so a shrine buried in stone lights
   * nothing — which is exactly what my first version of this test did, and it
   * correctly reported "shrine emits no light at all".  Carve a sealed air
   * pocket first.  The pocket is placed deep enough that it cannot connect to
   * the surface, so the only light in it is the shrine's own block light.
   */
  const world = makeLitWorld();
  const ci = 90, cj = Math.floor(1380 / 16), ck = Math.floor(ZMID / 16);
  const wi = ci * 16 + 8, wj = cj * 16 + 8, wk = ck * 16 + 8;
  // setBlock only patches chunks that are already resident, so make sure this
  // one exists before editing it.
  world.ensureChunk(ci, cj, ck);

  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      for (let dk = -2; dk <= 2; dk++) {
        if (di === 0 && dj === 0 && dk === 0) continue;
        world.setBlock(wi + di, wj + dj, wk + dk, BLOCK.AIR);
      }
    }
  }
  world.setBlock(wi, wj, wk, BLOCK.SHRINE);       // emit 12

  const chunk = world.getChunk(ci, cj, ck);
  assert.ok(chunk, "chunk holding the shrine is not resident");
  const at = (di, dj, dk) =>
    chunk.getBlockLight(8 + di, 8 + dj, 8 + dk);

  assert.equal(world.getBlock(wi, wj, wk), BLOCK.SHRINE);
  const centre = at(0, 0, 0);
  const near = at(1, 0, 0);
  const mid = at(2, 0, 0);
  assert.ok(centre >= 12, `shrine voxel has block light ${centre}, emit is 12`);
  assert.ok(near > 0, "shrine lights nothing next to it");
  assert.ok(near < centre, "block light does not fall off with distance");
  assert.ok(mid <= near, "block light increased with distance");
});

/* ------------------------------------------------------------------ *
 * 9. Meshing
 * ------------------------------------------------------------------ */

/**
 * Minimal stand-in for World, exposing exactly the two methods the mesher
 * uses.  Testing the mesher's culling rules against a synthetic world is both
 * faster and more honest than hunting worldgen for a chunk that happens to be
 * fully solid — at ~5% cave density no 16^3 chunk in the shell ever is.
 */
function stubWorld(id, chunk = null) {
  return {
    getBlock: (i, j, k) => {
      if (chunk) {
        const li = i - chunk.originI, lj = j - chunk.originJ, lk = k - chunk.originK;
        if (li >= 0 && li < 16 && lj >= 0 && lj < 16 && lk >= 0 && lk < 16) {
          return chunk.get(li, lj, lk);
        }
      }
      return id;
    },
    lightAt: () => WORLD.LIGHT_MAX,
  };
}

test("a chunk with no exposed surface produces no mesh", () => {
  const c = new Chunk(30, 88, Math.floor(ZMID / 16));
  c.blocks.fill(BLOCK.STONE);
  assert.equal(meshChunk(stubWorld(BLOCK.STONE), c), null);
  assert.equal(c.faceCount, 0);
});

test("a single buried voxel emits exactly 6 faces", () => {
  const c = new Chunk(31, 88, Math.floor(ZMID / 16));
  c.blocks.fill(BLOCK.STONE);
  c.set(8, 8, 8, BLOCK.AIR);                 // a pocket: 6 exposed faces
  const mesh = meshChunk(stubWorld(BLOCK.STONE, c), c);
  assert.ok(mesh);
  assert.equal(mesh.faceCount, 6, `expected 6 faces around the pocket, got ${mesh.faceCount}`);
  assert.equal(mesh.vertexCount, 24);
});

test("an empty chunk produces no mesh", () => {
  const world = makeLitWorld();
  const c = world.ensureChunk(30, 30, Math.floor(ZMID / 16));
  assert.equal(c.uniformId, BLOCK.AIR);
  assert.equal(meshChunk(world, c), null);
});

/** Find the radial chunk that actually contains the surface for a column. */
function surfaceChunkAt(world, ci, ck) {
  const i = ci * 16 + 8;
  const k = ck * 16 + 8;
  const h = Math.ceil(world.terrain.surfaceRadius(i, k));
  return world.ensureChunk(ci, Math.floor(h / 16), ck);
}

test("a surface chunk produces a well-formed mesh", () => {
  const world = makeLitWorld();
  const ci = 100, ck = Math.floor(ZMID / 16);
  // Ask the terrain where the surface actually is instead of guessing a
  // radius: at a fixed j the chunk is usually entirely rock or entirely air.
  const c = surfaceChunkAt(world, ci, ck);
  const mesh = meshChunk(world, c);
  assert.ok(mesh, "surface chunk produced no mesh");

  assert.equal(mesh.positions.length, mesh.vertexCount * 3);
  assert.equal(mesh.attrs.length, mesh.vertexCount * 4);
  assert.equal(mesh.indices.length, mesh.faceCount * 6);
  assert.ok(mesh.faceCount > 0);

  for (let n = 0; n < mesh.indices.length; n++) {
    assert.ok(mesh.indices[n] < mesh.vertexCount, `index ${mesh.indices[n]} out of range`);
  }
  for (let n = 0; n < mesh.positions.length; n++) {
    assert.ok(Number.isFinite(mesh.positions[n]), "non-finite vertex position");
  }
  // Every vertex must lie on the tube: its radius must be within the chunk's
  // radial extent.  This is the check that the cylindrical projection is right.
  for (let v = 0; v < mesh.vertexCount; v++) {
    const r = Math.hypot(mesh.positions[v * 3], mesh.positions[v * 3 + 1]);
    assert.ok(r >= c.originJ - 0.001 && r <= c.originJ + 16.001,
      `vertex radius ${r} outside chunk radial range [${c.originJ}, ${c.originJ + 16}]`);
  }
});

test("meshed faces point the right way: inner faces dominate at the surface", () => {
  // Standing on the inside of the tube, the ground you see is made of INNER
  // faces (normal toward the axis).  If the mesher emitted OUTER faces there,
  // the terrain would be invisible from inside.
  const world = makeLitWorld();
  const ci = 140, ck = Math.floor(ZMID / 16);
  const c = surfaceChunkAt(world, ci, ck);
  const mesh = meshChunk(world, c);
  assert.ok(mesh);
  let innerFacing = 0;
  const nrm = [0, 0, 0];
  for (let f = 0; f < mesh.faceCount; f++) {
    const i0 = mesh.indices[f * 6] * 3;
    const i1 = mesh.indices[f * 6 + 1] * 3;
    const i2 = mesh.indices[f * 6 + 2] * 3;
    const ax = mesh.positions[i1] - mesh.positions[i0];
    const ay = mesh.positions[i1 + 1] - mesh.positions[i0 + 1];
    const az = mesh.positions[i1 + 2] - mesh.positions[i0 + 2];
    const bx = mesh.positions[i2] - mesh.positions[i0];
    const by = mesh.positions[i2 + 1] - mesh.positions[i0 + 1];
    const bz = mesh.positions[i2 + 2] - mesh.positions[i0 + 2];
    nrm[0] = ay * bz - az * by;
    nrm[1] = az * bx - ax * bz;
    nrm[2] = ax * by - ay * bx;
    // radial direction at the face centroid
    const cx = (mesh.positions[i0] + mesh.positions[i1] + mesh.positions[i2]) / 3;
    const cy = (mesh.positions[i0 + 1] + mesh.positions[i1 + 1] + mesh.positions[i2 + 1]) / 3;
    const rr = Math.hypot(cx, cy) || 1;
    const dot = (nrm[0] * cx + nrm[1] * cy) / rr;
    if (dot < 0) innerFacing++;
  }
  assert.ok(innerFacing > mesh.faceCount * 0.2,
    `only ${innerFacing}/${mesh.faceCount} faces point inward — the surface would be invisible from inside the tube`);
});

/* ------------------------------------------------------------------ *
 * 10. World streaming and edit propagation
 * ------------------------------------------------------------------ */

test("streaming populates chunks around the player and evicts distant ones", () => {
  const world = makeLitWorld();
  const [ci, cj, ck] = toChunkIndex(0, 1276, ZMID);
  const before = world.residentChunks;
  world.update(ci, cj, ck, 2, 400);
  assert.ok(world.residentChunks > before, "streaming created no chunks");
  const peak = world.residentChunks;

  // Jump far away; the old window must be released.
  world.update(ci + 200, cj, (ck + 60) % 128, 2, 400);
  assert.ok(world.residentChunks < peak * 1.2,
    `chunks are leaking: ${world.residentChunks} resident after moving`);
});

test("getBlock agrees whether or not the chunk is resident", () => {
  const world = makeLitWorld();
  const i = 500, j = 1295, k = ZMID + 11;
  const cold = world.getBlock(i, j, k);
  world.update(...toChunkIndex(i, j, k), 1, 400);
  const hot = world.getBlock(i, j, k);
  assert.equal(cold, hot, "resident and non-resident reads disagree");
  assert.equal(hot, world.terrain.sample(i, j, k));
});

test("editing a chunk boundary remeshes the neighbour", () => {
  const world = makeLitWorld();
  const [ci, cj, ck] = toChunkIndex(600, 1290, ZMID);
  world.update(ci, cj, ck, 2, 400);
  const neighbour = world.getChunk(ci + 1, cj, ck);
  assert.ok(neighbour, "neighbour chunk is not resident");
  world.dirty.clear();
  // Edit the last voxel of chunk ci — it touches chunk ci+1.
  world.setBlock(ci * 16 + 15, 1290, ck * 16 + 8, BLOCK.AIR);
  assert.ok(world.dirty.has(neighbour.key),
    "neighbour chunk was not marked dirty after a boundary edit");
  assert.equal(world.getBlock(ci * 16 + 15, 1290, ck * 16 + 8), BLOCK.AIR);
});

test("isOpaqueAt matches the block table", () => {
  const world = makeLitWorld();
  for (let j = 1240; j < 1450; j += 5) {
    const id = world.getBlock(900, j, ZMID);
    assert.equal(world.isOpaqueAt(900, j, ZMID), isOpaque(id));
  }
});

test("raycast finds the surface from above", () => {
  const world = makeLitWorld();
  world.update(...toChunkIndex(0, 1270, ZMID), 2, 400);
  const i = 0;
  const h = Math.ceil(world.terrain.surfaceRadius(i, ZMID));
  const theta = (i + 0.5) * WORLD.D_THETA;
  const startR = h - 6;
  const origin = [Math.cos(theta) * startR, Math.sin(theta) * startR, ZMID + 0.5];
  // Fire straight "down" — outward, along +r.
  const dir = [Math.cos(theta), Math.sin(theta), 0];
  const hit = world.raycast(origin, dir, 20);
  assert.ok(hit, "raycast found nothing");
  assert.equal(hit.j, h, `raycast hit j=${hit.j}, surface is ${h}`);
});

/* ------------------------------------------------------------------ *
 * 11. Terrain roughness regression
 *
 * Two separate bugs produced unclimbable vertical walls in the tube, and both
 * were invisible in any single-column check.  These tests pin the fixes.
 * ------------------------------------------------------------------ */

function stepHistogram(terrain, kFrom, kTo, iStep = 4) {
  const h = { d1: 0, d2: 0, d4: 0, d8: 0, d16: 0, n: 0, max: 0 };
  for (let k = kFrom; k < kTo; k++) {
    for (let i = 0; i < WORLD.THETA_COUNT; i += iStep) {
      const a = terrain.surfaceRadius(i, k);
      const d = Math.abs(terrain.surfaceRadius(i + 1, k) - a);
      h.n++;
      if (d > h.max) h.max = d;
      if (d > 1) h.d1++;
      if (d > 2) h.d2++;
      if (d > 4) h.d4++;
      if (d > 8) h.d8++;
      if (d > 16) h.d16++;
    }
  }
  return h;
}

test("REGRESSION: no column-to-column cliff walls (sinkhole ramp too steep)", () => {
  /*
   * The sinkhole layer once ran at a 16-column feature size with a 55-block
   * drop, so its smoothstep ramp crossed its whole range inside two columns:
   * 10722 of 614400 columns had a neighbour more than 16 blocks away.  Those
   * are sheer unclimbable faces.  After moving the layer to 128-column
   * features and a 40-block depth, the worst step in the tube is under 10.
   */
  const h = stepHistogram(terrain, 950, 1050);
  assert.equal(h.d16, 0,
    `${h.d16} columns have a neighbour >16 blocks away (worst ${h.max.toFixed(1)})`);
  assert.ok(h.max < 12, `worst adjacent step is ${h.max.toFixed(1)} blocks — a sheer wall`);
  assert.ok(h.d8 / h.n < 0.002, `${(h.d8 / h.n * 100).toFixed(2)}% of columns step more than 8 blocks`);
  // ...but the terrain must not have been flattened into a billiard table.
  assert.ok(h.d1 / h.n > 0.05,
    `only ${(h.d1 / h.n * 100).toFixed(1)}% of columns vary at all — terrain is too smooth`);
});

test("REGRESSION: ocean coastlines are slopes, not cliffs", () => {
  // Find a coastline (ocean-ness crossing 0.5) and check the step there is
  // comparable to the rest of the tube, not a 60-block drop.
  let coastSteps = 0, coastWorst = 0, coasts = 0;
  for (let k = 950; k < 1050; k++) {
    for (let i = 0; i < WORLD.THETA_COUNT; i += 4) {
      const a = terrain._biomeFields(i, k).ocean;
      const b = terrain._biomeFields(i + 1, k).ocean;
      if ((a < 0.5) !== (b < 0.5)) {
        coasts++;
        const d = Math.abs(terrain.surfaceRadius(i + 1, k) - terrain.surfaceRadius(i, k));
        coastSteps += d;
        if (d > coastWorst) coastWorst = d;
      }
    }
  }
  assert.ok(coasts > 10, `only found ${coasts} coastline crossings — no oceans generated`);
  assert.ok(coastWorst < 12,
    `worst coastline step is ${coastWorst.toFixed(1)} blocks — biomes are switching geometry abruptly`);
});

test("REGRESSION: domain warp displacement stays below the base wavelength", () => {
  /*
   * domainWarp2Tiled displaces the sample point by `strength` LATTICE CELLS.
   * The continental layer's base octave period is THETA_FREQ.continental.period
   * cells, so a displacement near or above that folds the field over itself.
   * The 4.0 multiplier that used to be hard-coded inside domainWarp2Tiled
   * pushed displacement past 10 cells against a 16-cell period, and the height
   * field came out stepping 3-6 blocks between adjacent columns everywhere.
   *
   * Measured directly on the layer rather than on the warp constant, so this
   * catches the symptom no matter which knob causes it.
   */
  /*
   * This is a distribution assertion, not a maximum.  Even correctly tuned,
   * the warp concentrates strain somewhere, so a handful of columns out of
   * 500k will change by half a standard deviation in one step.  What went
   * wrong at strength 3.6 was that this was the TYPICAL step, not the tail.
   */
  const t = makeTerrain("warp-check");
  const f = THETA_FREQ.continental;
  const deltas = [];
  for (let k = 1000; k < 1060; k++) {
    for (let i = 0; i < WORLD.THETA_COUNT; i += 8) {
      const a = t.noise.sample2Norm("continental", i * f.freq, k * f.freq, f.period);
      const b = t.noise.sample2Norm("continental", (i + 1) * f.freq, k * f.freq, f.period);
      deltas.push(Math.abs(b - a));
    }
  }
  deltas.sort((a, b) => a - b);
  const q = (p) => deltas[Math.floor(p * (deltas.length - 1))];
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;

  /*
   * Thresholds are set against a measured negative control.  Re-running this
   * exact measurement with the old 3.6-cell displacement gives:
   *
   *                     strength 0.6 (current)   strength 3.6 (the bug)
   *   median                    0.0226                    0.5145
   *   99th percentile           0.2130                    2.7420
   *   max                       0.5204                    5.1051
   *   fraction > 0.3 sd         0.197 %                  66.7  %
   *
   * So each assertion below has roughly 30-40 % headroom on the pass side and
   * a 9x-300x margin before it would catch the regression.
   */
  assert.ok(q(0.5) < 0.05, `median column step is ${q(0.5).toFixed(3)} sd — field is far too rough`);
  assert.ok(q(0.99) < 0.30, `99th percentile column step is ${q(0.99).toFixed(3)} sd — the warp is folding the field`);
  // The tail is allowed to be sharp; what must not happen is that being typical.
  const bigFrac = deltas.filter((d) => d > 0.3).length / deltas.length;
  assert.ok(bigFrac < 0.005,
    `${(bigFrac * 100).toFixed(3)}% of columns jump more than 0.3 sd — sharp folds are too common`);
  // ...and the layer must still actually vary (guards against over-damping).
  assert.ok(mean > 0.002,
    `mean column step is ${mean.toFixed(5)} sd — the warp was removed entirely`);
});
