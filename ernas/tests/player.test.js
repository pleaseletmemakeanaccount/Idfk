/**
 * ERNAS ENGINE — tests/player.test.js
 *
 * Locomotion and collision on the inside of a cylinder.  Headless: none of
 * this needs a GL context, which is exactly why the physics lives in its own
 * module rather than in the render loop.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MothPlayer, BODY_HEIGHT, EYE_HEIGHT } from "../src/player/controller.js";
import { World } from "../src/world/world.js";
import { makeTerrain, BIOME_NAMES } from "../src/world/generator.js";
import { WORLD, gravityScaleAt } from "../src/world/cylinderGeometry.js";
import { isSolid } from "../src/world/blocks.js";

function makePlayer(seed = "player-test", theta = 0) {
  const world = new World(makeTerrain(seed));
  const p = new MothPlayer(world);
  const k = WORLD.WORLD_Z / 2;
  p.spawn(theta, k);
  // Stream the chunks around the spawn so collision reads resident data.
  const c = p.tubeCoords();
  world.update(Math.floor(c.i / 16), Math.floor(c.j / 16), Math.floor(c.k / 16), 3, 600);
  return { world, p };
}

const radius = (v) => Math.hypot(v[0], v[1]);

/* ------------------------------------------------------------------ *
 * Camera basis
 * ------------------------------------------------------------------ */

test("the camera basis is orthonormal and right-handed", () => {
  const { p } = makePlayer();
  for (let a = 0; a < 8; a++) {
    p.yaw = (a / 8) * Math.PI * 2;
    p.pitch = ((a % 3) - 1) * 0.3;
    const f = p.forwardHorizontal([0, 0, 0]);
    const r = p.rightHorizontal([0, 0, 0]);
    const u = p.upVector();
    const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const len = (x) => Math.hypot(x[0], x[1], x[2]);

    assert.ok(Math.abs(len(f) - 1) < 1e-9, "forward not unit");
    assert.ok(Math.abs(len(r) - 1) < 1e-9, "right not unit");
    assert.ok(Math.abs(dot(f, r)) < 1e-9, "forward and right are not orthogonal");
    assert.ok(Math.abs(dot(f, u)) < 1e-9, "forward is not horizontal");
    assert.ok(Math.abs(dot(r, u)) < 1e-9, "right is not horizontal");

    // right = forward x up  =>  the triple (right, up, -forward) is right-handed
    const cx = f[1] * u[2] - f[2] * u[1];
    const cy = f[2] * u[0] - f[0] * u[2];
    const cz = f[0] * u[1] - f[1] * u[0];
    assert.ok(Math.hypot(cx - r[0], cy - r[1], cz - r[2]) < 1e-9,
      "rightHorizontal is not forward x up — strafing would be inverted");
  }
});

test("yaw 0 looks down the tube axis, yaw 90deg looks along the circumference", () => {
  const { p } = makePlayer();
  p.yaw = 0; p.pitch = 0;
  let f = p.forwardHorizontal([0, 0, 0]);
  assert.ok(Math.abs(f[2] - 1) < 1e-9, `yaw 0 forward = ${f}, expected +Z`);

  p.yaw = Math.PI / 2;
  f = p.forwardHorizontal([0, 0, 0]);
  assert.ok(Math.abs(f[2]) < 1e-9, "yaw 90 should have no axial component");
  // ...and it should be tangential, i.e. perpendicular to the radial direction
  const r = Math.hypot(p.pos[0], p.pos[1]);
  const radialDot = (f[0] * p.pos[0] + f[1] * p.pos[1]) / r;
  assert.ok(Math.abs(radialDot) < 1e-9, "yaw 90 forward is not tangential");
});

test("up points at the axis wherever the player stands", () => {
  const { p } = makePlayer();
  for (const theta of [0, 1000, 4096, 7000]) {
    p.spawn(theta, WORLD.WORLD_Z / 2);
    const u = p.upVector();
    const r = Math.hypot(p.pos[0], p.pos[1]);
    const dot = (u[0] * p.pos[0] + u[1] * p.pos[1]) / r;
    assert.ok(dot < -0.999, `up does not point inward at theta index ${theta}`);
  }
});

test("the eye is above the feet along the local up vector", () => {
  const { p } = makePlayer();
  const eye = p.eye();
  assert.ok(radius(eye) < radius(p.pos) - EYE_HEIGHT + 1e-6,
    "the eye is not inboard (upward) of the feet");
  assert.equal(eye[2], p.pos[2], "the eye should be at the same axial position");
});

/* ------------------------------------------------------------------ *
 * Spawning
 * ------------------------------------------------------------------ */

test("spawn places the player standing on the surface, not inside it", () => {
  const { p } = makePlayer();
  assert.ok(!p.collides(p.pos[0], p.pos[1], p.pos[2]), "spawned inside solid ground");

  const c = p.tubeCoords();
  const h = Math.ceil(p.world.terrain.surfaceRadius(c.i, c.k));
  // Feet should be just inboard of the topmost solid voxel.
  assert.ok(radius(p.pos) <= h, `feet radius ${radius(p.pos)} is below the surface ${h}`);
  assert.ok(radius(p.pos) > h - 3, `feet radius ${radius(p.pos)} is far above the surface ${h}`);

  // And the ground probe must find solid immediately below.
  const { radial } = p.basis();
  assert.ok(
    p.collides(p.pos[0] + radial[0] * 0.5, p.pos[1] + radial[1] * 0.5, p.pos[2]),
    "there is no ground under the spawn point",
  );
});

test("spawn works at many points around the tube and in every biome", () => {
  const { p } = makePlayer();
  const biomes = new Set();
  for (let n = 0; n < 40; n++) {
    const theta = Math.floor((n / 40) * WORLD.THETA_COUNT);
    p.spawn(theta, WORLD.WORLD_Z / 2 + (n % 50) - 25);
    assert.ok(!p.collides(p.pos[0], p.pos[1], p.pos[2]),
      `spawned inside terrain at theta ${theta}`);
    const c = p.tubeCoords();
    biomes.add(BIOME_NAMES[p.world.terrain.biomeAtCached(c.i, c.k)]);
  }
  assert.ok(biomes.size >= 2, `only saw biomes: ${[...biomes]}`);
});

/* ------------------------------------------------------------------ *
 * Gravity
 * ------------------------------------------------------------------ */

test("falling increases the radius (gravity points outward, away from the axis)", () => {
  const { p } = makePlayer();
  // Lift the player clear of the ground, then let go.
  const { up } = p.basis();
  for (let n = 0; n < 40; n++) {
    p.pos[0] += up[0] * 0.5;
    p.pos[1] += up[1] * 0.5;
  }
  p.vel = [0, 0, 0];
  const startR = radius(p.pos);
  assert.ok(!p.collides(p.pos[0], p.pos[1], p.pos[2]), "lifted player is inside terrain");

  for (let n = 0; n < 20; n++) p.update(1 / 60, {});
  assert.ok(radius(p.pos) > startR,
    `radius went ${startR.toFixed(3)} -> ${radius(p.pos).toFixed(3)}; gravity is not outward`);
});

test("gravity vanishes inside the deadzone", () => {
  assert.equal(gravityScaleAt(WORLD.R_SUN), 0);
  assert.equal(gravityScaleAt(WORLD.R_DEADZONE * 0.5), 0);

  const { p } = makePlayer();
  // Teleport into the deadzone with zero velocity.
  p.pos = [WORLD.R_SUN * 0.5, 0, WORLD.WORLD_Z / 2];
  p.vel = [0, 0, 0];
  const before = radius(p.pos);
  for (let n = 0; n < 30; n++) p.update(1 / 60, {});
  assert.ok(Math.abs(radius(p.pos) - before) < 1e-9,
    "the player accelerated inside the zero-gravity deadzone");
  assert.ok(p.inDeadzone, "inDeadzone was not set");
});

/* ------------------------------------------------------------------ *
 * Walking and collision
 * ------------------------------------------------------------------ */

test("the player settles on the ground and stays there", () => {
  const { p } = makePlayer();
  for (let n = 0; n < 180; n++) p.update(1 / 60, {});
  assert.ok(p.onGround, "player is not on the ground after 3 seconds");
  const r1 = radius(p.pos);
  for (let n = 0; n < 120; n++) p.update(1 / 60, {});
  assert.ok(Math.abs(radius(p.pos) - r1) < 0.2,
    `player drifted from ${r1.toFixed(3)} to ${radius(p.pos).toFixed(3)} while standing still`);
  assert.ok(!p.collides(p.pos[0], p.pos[1], p.pos[2]), "player sank into the ground");
});

test("walking moves the player and never pushes them through terrain", () => {
  const { p } = makePlayer();
  for (let n = 0; n < 60; n++) p.update(1 / 60, {});
  const start = [...p.pos];
  for (let n = 0; n < 600; n++) {
    p.update(1 / 60, { f: 1 });
    assert.ok(!p.collides(p.pos[0], p.pos[1], p.pos[2]),
      `player ended up inside terrain at step ${n}`);
  }
  const moved = Math.hypot(p.pos[0] - start[0], p.pos[1] - start[1], p.pos[2] - start[2]);
  assert.ok(moved > 10, `player only moved ${moved.toFixed(2)} blocks in 10 seconds`);
});

test("walking forward at yaw 0 travels down the tube axis", () => {
  const { p } = makePlayer();
  p.yaw = 0;
  for (let n = 0; n < 60; n++) p.update(1 / 60, {});
  const z0 = p.pos[2];
  for (let n = 0; n < 300; n++) p.update(1 / 60, { f: 1 });
  assert.ok(p.pos[2] > z0 + 5, `axial travel was only ${(p.pos[2] - z0).toFixed(2)}`);
});

test("walking sideways at yaw 0 curves around the tube", () => {
  const { p } = makePlayer();
  p.yaw = 0;
  for (let n = 0; n < 60; n++) p.update(1 / 60, {});
  const t0 = p.tubeCoords().thetaDeg;
  for (let n = 0; n < 300; n++) p.update(1 / 60, { r: 1 });
  const t1 = p.tubeCoords().thetaDeg;
  assert.ok(Math.abs(t1 - t0) > 1, `theta barely changed (${t0} -> ${t1})`);
});

test("jumping lifts the player toward the axis and brings them back", () => {
  const { p } = makePlayer();
  for (let n = 0; n < 90; n++) p.update(1 / 60, {});
  assert.ok(p.onGround);
  const groundR = radius(p.pos);
  p.update(1 / 60, { jump: true });
  let minR = Infinity;
  for (let n = 0; n < 120; n++) {
    p.update(1 / 60, {});
    minR = Math.min(minR, radius(p.pos));
  }
  assert.ok(minR < groundR - 0.8, `jump only reached ${(groundR - minR).toFixed(2)} blocks of height`);
  assert.ok(p.onGround, "player did not land after jumping");
});

test("collision blocks a wall", () => {
  const { p, world } = makePlayer();
  for (let n = 0; n < 60; n++) p.update(1 / 60, {});
  /*
   * Build a wall across the tube and check the player cannot pass it.
   *
   * The wall must be anchored to the TERRAIN AT THE WALL, not at the player's
   * current radius.  My first version built it at the player's radial level,
   * but the ground drops ~2.5 blocks over those few columns, so the wall ended
   * up floating and the player simply walked underneath it.  It also has to be
   * tall enough to cover that drop.
   */
  p.yaw = 0;
  const c = p.tubeCoords();
  const wallK = c.k + 8;
  const wallBase = Math.ceil(world.terrain.surfaceRadius(c.i, wallK));
  for (let dj = -2; dj <= 10; dj++) {
    for (let di = -3; di <= 3; di++) {
      world.setBlock(c.i + di, wallBase + dj, wallK, 1 /* stone */);
    }
  }
  for (let n = 0; n < 400; n++) p.update(1 / 60, { f: 1 });

  assert.ok(p.tubeCoords().k < wallK,
    `player reached k=${p.tubeCoords().k}, past the wall at k=${wallK}`);
  assert.ok(!p.collides(p.pos[0], p.pos[1], p.pos[2]), "player ended up inside terrain");
});

test("creative mode ignores gravity and terrain height", () => {
  const { p } = makePlayer();
  p.creative = true;
  const { up } = p.basis();
  const r0 = radius(p.pos);
  for (let n = 0; n < 60; n++) p.update(1 / 60, { up: true });
  assert.ok(radius(p.pos) < r0 - 5,
    `creative ascent only reached ${(r0 - radius(p.pos)).toFixed(2)} blocks`);
  assert.ok(!p.collides(p.pos[0], p.pos[1], p.pos[2]));
  void up;
});

test("the player cannot fall through the iron crust into the void", () => {
  const { p } = makePlayer();
  // Place them outside the crust and let gravity run.
  p.pos = [WORLD.R_CRUST + 5, 0, WORLD.WORLD_Z / 2];
  p.vel = [0, 0, 0];
  for (let n = 0; n < 600; n++) p.update(1 / 60, {});
  assert.ok(radius(p.pos) <= WORLD.R_CRUST - 1.9,
    `player escaped to radius ${radius(p.pos).toFixed(2)} (crust at ${WORLD.R_CRUST})`);
});

/* ------------------------------------------------------------------ *
 * HUD-facing accessors
 * ------------------------------------------------------------------ */

test("tubeCoords reports a position consistent with the Cartesian one", () => {
  const { p } = makePlayer();
  for (let n = 0; n < 20; n++) {
    const c = p.tubeCoords();
    assert.ok(c.i >= 0 && c.i < WORLD.THETA_COUNT, `theta index ${c.i} out of range`);
    assert.ok(c.k >= 0 && c.k < WORLD.WORLD_Z, `axial index ${c.k} out of range`);
    assert.ok(Math.abs(c.radius - radius(p.pos)) < 1e-9);
    // The voxel the HUD reports must be the one the player is standing in.
    const id = p.world.getBlock(c.i, c.j, c.k);
    assert.ok(!isSolid(id) || c.j > 0, "the reported voxel is solid");
    p.update(1 / 60, { f: 1 });
  }
});

test("body constants are sane for a 1.8-block humanoid", () => {
  assert.ok(BODY_HEIGHT > 1 && BODY_HEIGHT < 3);
  assert.ok(EYE_HEIGHT < BODY_HEIGHT, "the eye is above the top of the head");
  assert.ok(EYE_HEIGHT > BODY_HEIGHT * 0.7, "the eye is implausibly low");
});
