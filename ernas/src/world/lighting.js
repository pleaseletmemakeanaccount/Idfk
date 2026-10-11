/**
 * ERNAS ENGINE — world/lighting.js
 * =====================================================================
 *  Radial skylight + block light, flood-filled per chunk.
 * =====================================================================
 *
 * In a normal voxel game the sun is infinitely far away, so skylight is a
 * column problem: walk down from the sky, full brightness until you hit
 * something, then decay.  ERNAS's light source is the SUN SPHERE ON THE
 * AXIS, so the equivalent column runs OUTWARD along the radius:
 *
 *   a voxel is sunlit  <=>  nothing solid lies between it and the axis
 *                        <=>  j < firstOpaqueRadius(i, k)
 *
 * which is exactly the same one-dimensional scan, just pointed along +r
 * instead of -y.  Caves, overhangs and the underside of cloud platforms all
 * fall out of that rule for free.
 *
 * Two passes then run over a padded volume:
 *   sky   — seeded with every transparent voxel that can see the axis (15)
 *   block — seeded with emissive voxels (their `emit` value)
 * Both are a breadth-first flood with a 1-level falloff per step.  Because a
 * FIFO queue processes light in non-increasing order, each voxel is settled
 * once and the queue never exceeds the padded volume.
 *
 * The volume is padded by one voxel on every side so light can cross a chunk
 * boundary instead of stopping dead at it.
 *
 * UNRESOLVED(lighting): one voxel of padding is not enough in principle —
 * light can travel 15 steps, so a long tunnel that enters a chunk two voxels
 * from its edge will be slightly darker than it should be until the neighbour
 * chunk is relit.  Fixing it properly means either a global light queue that
 * spans chunks (what Minecraft does) or a 15-voxel pad, which costs 15x the
 * memory per relight.  The visible symptom is a faint darkening at some chunk
 * seams deep underground.  Not fixed.
 */

import { WORLD, wrapTheta, localIndex } from "./cylinderGeometry.js";
import { CHUNK_SIZE, CHUNK_STATE } from "./chunk.js";
import { isOpaque, lightEmission, BLOCK } from "./blocks.js";

const C = CHUNK_SIZE;      // 16
const P = C + 2;           // padded cube edge
const PV = P * P * P;      // padded volume

/** index into the padded cube from a local offset in [-1, C] */
function pidx(pi, pj, pk) {
  return (pi + 1) + P * ((pj + 1) + P * (pk + 1));
}

/**
 * Compute sky + block light for one chunk and store it in `chunk.light`.
 * @param {import("./world.js").World} world
 * @param {import("./chunk.js").Chunk} chunk
 */
export function lightChunk(world, chunk) {
  const sky = scratchSky;
  const blk = scratchBlk;
  sky.fill(0);
  blk.fill(0);

  const i0 = chunk.originI;
  const j0 = chunk.originJ;
  const k0 = chunk.originK;
  const terrain = world.terrain;
  const opaque = scratchOpaque;

  const queue = ensureQueue();
  let head = 0;
  let tail = 0;

  /* ---- pass 0: classify + seed ------------------------------------ */
  for (let pk = -1; pk <= C; pk++) {
    const k = k0 + pk;
    const kValid = k >= 0 && k < WORLD.WORLD_Z;
    for (let pi = -1; pi <= C; pi++) {
      const i = i0 + pi;
      /*
       * The shadow column depends only on (i, k), so it is hoisted out of the
       * radial loop.  Asking for it per voxel made lighting a single chunk
       * cost ~40 ms, almost all of it redundant column lookups.
       */
      const surface = kValid ? terrain.firstOpaqueRadius(wrapTheta(i), k) : 0;
      for (let pj = -1; pj <= C; pj++) {
        const j = j0 + pj;
        const idx = pidx(pi, pj, pk);
        const id = kValid ? world.getBlock(i, j, k) : BLOCK.AIR;
        const op = isOpaque(id);
        opaque[idx] = op ? 1 : 0;

        if (op) {
          const e = lightEmission(id);
          if (e > 0) { blk[idx] = e; queue[tail++] = idx | (1 << 24); }
          continue;
        }
        // Transparent.  Sunlit when the column is clear all the way to the axis.
        if (kValid && j < surface) {
          sky[idx] = WORLD.LIGHT_MAX;
          queue[tail++] = idx;                    // channel 0 = sky
        }
      }
    }
  }

  /* ---- pass 1: breadth-first flood, both channels ------------------ */
  while (head < tail) {
    const entry = queue[head++];
    const idx = entry & 0xffffff;
    const isBlock = (entry >>> 24) & 1;
    const field = isBlock ? blk : sky;
    const level = field[idx];
    if (level <= 1) continue;
    const next = level - 1;

    const pi = (idx % P) - 1;
    const pj = (Math.floor(idx / P) % P) - 1;
    const pk = (Math.floor(idx / (P * P))) - 1;

    for (let a = 0; a < 6; a++) {
      const ni = pi + NEIGH[a * 3];
      const nj = pj + NEIGH[a * 3 + 1];
      const nk = pk + NEIGH[a * 3 + 2];
      if (ni < -1 || ni > C || nj < -1 || nj > C || nk < -1 || nk > C) continue;
      const nIdx = pidx(ni, nj, nk);
      if (opaque[nIdx]) continue;
      if (field[nIdx] >= next) continue;
      field[nIdx] = next;
      queue[tail++] = nIdx | (isBlock << 24);
    }
  }

  /* ---- pass 2: copy the interior into the chunk -------------------- */
  const light = chunk.light;
  for (let lk = 0; lk < C; lk++) {
    for (let lj = 0; lj < C; lj++) {
      for (let li = 0; li < C; li++) {
        const s = sky[pidx(li, lj, lk)];
        const b = blk[pidx(li, lj, lk)];
        light[localIndex(li, lj, lk)] = ((s & 15) << 4) | (b & 15);
      }
    }
  }

  chunk.state = Math.max(chunk.state, CHUNK_STATE.LIT);
  return chunk;
}

const NEIGH = Int8Array.from([
  1, 0, 0, -1, 0, 0,
  0, 1, 0, 0, -1, 0,
  0, 0, 1, 0, 0, -1,
]);

/* Reused scratch buffers.  Lighting runs on the main thread during streaming,
 * so allocating 3 x 5.8 KiB per chunk would show up as GC stutter. */
let scratchSky = new Uint8Array(PV);
let scratchBlk = new Uint8Array(PV);
let scratchOpaque = new Uint8Array(PV);
/* A voxel index can be queued once for the sky channel and once for the block
 * channel, so the queue needs twice the padded volume. */
let scratchQueue = new Int32Array(PV * 2);

function ensureQueue() { return scratchQueue; }

/**
 * Sky light only, without the flood — used by the mesher when a neighbour
 * chunk is not resident and by tools that just need the shadow column.
 */
export function directSunlight(world, i, j, k) {
  const surface = world.terrain.firstOpaqueRadius(wrapTheta(i), k);
  return j < surface ? WORLD.LIGHT_MAX : 0;
}
