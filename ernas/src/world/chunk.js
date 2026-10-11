/**
 * ERNAS ENGINE — world/chunk.js
 * =====================================================================
 *  A 16x16x16 cache of voxels in tube coordinates.
 * =====================================================================
 *
 * A chunk is a CACHE, not the source of truth.  The generator can answer
 * "what block is at (i,j,k)" on its own; chunks exist only so that meshing,
 * lighting and physics do not have to re-run noise for every access.
 *
 * Memory: 4 KiB blocks + 4 KiB light per chunk.  At a streaming radius of 5
 * chunks that is ~500 chunks = ~4 MiB, which is nothing.
 */

import { WORLD, localIndex, wrapTheta, chunkKey, unvoxelKey } from "./cylinderGeometry.js";
import { BLOCK, lightEmission } from "./blocks.js";

export const CHUNK_SIZE = WORLD.CHUNK;            // 16
export const CHUNK_VOLUME = CHUNK_SIZE ** 3;      // 4096

export const CHUNK_STATE = Object.freeze({
  EMPTY: 0,
  GENERATED: 1,
  LIT: 2,
  MESHED: 3,
});

export class Chunk {
  /**
   * @param {number} ci theta chunk index (wraps)
   * @param {number} cj radial chunk index (= radius >> 4)
   * @param {number} ck axial chunk index
   */
  constructor(ci, cj, ck) {
    this.ci = ci;
    this.cj = cj;
    this.ck = ck;
    this.key = chunkKey(ci, cj, ck);

    /** @type {Uint8Array} block ids */
    this.blocks = new Uint8Array(CHUNK_VOLUME);
    /** @type {Uint8Array} packed light: high nibble = sky, low nibble = block */
    this.light = new Uint8Array(CHUNK_VOLUME);

    this.state = CHUNK_STATE.EMPTY;
    /** Mesh data, filled by the mesher; null until then. */
    this.mesh = null;
    this.faceCount = 0;
    this.vertexCount = 0;
    /** True when every voxel is the same id — such a chunk needs no mesh. */
    this.uniform = false;
    this.uniformId = BLOCK.AIR;
    /** Number of light-emitting voxels; > 0 means the lighting pass must
     *  re-flood this chunk whenever it changes. */
    this.emissiveCount = 0;

    /** Bounding-sphere centre/radius in Cartesian, for frustum culling. */
    this.centerX = 0;
    this.centerY = 0;
    this.centerZ = 0;
    this.radius = 0;
  }

  /** World-space origin (minimum corner) of this chunk in tube coordinates. */
  get originI() { return this.ci * CHUNK_SIZE; }
  get originJ() { return this.cj * CHUNK_SIZE; }
  get originK() { return this.ck * CHUNK_SIZE; }

  get(li, lj, lk) { return this.blocks[localIndex(li, lj, lk)]; }
  set(li, lj, lk, id) { this.blocks[localIndex(li, lj, lk)] = id; }

  getSkyLight(li, lj, lk) { return this.light[localIndex(li, lj, lk)] >>> 4; }
  getBlockLight(li, lj, lk) { return this.light[localIndex(li, lj, lk)] & 15; }
  setSkyLight(li, lj, lk, v) {
    const idx = localIndex(li, lj, lk);
    this.light[idx] = (this.light[idx] & 0x0f) | ((v & 15) << 4);
  }
  setBlockLight(li, lj, lk, v) {
    const idx = localIndex(li, lj, lk);
    this.light[idx] = (this.light[idx] & 0xf0) | (v & 15);
  }

  /** Combined light level 0..15 for a voxel inside this chunk. */
  lightLevel(li, lj, lk) {
    const v = this.light[localIndex(li, lj, lk)];
    return Math.max(v >>> 4, v & 15);
  }

  /** True when at least one voxel in this chunk emits light. */
  hasEmissive() { return this.emissiveCount > 0; }

  dispose() {
    this.mesh = null;
    this.blocks = null;
    this.light = null;
    this.state = CHUNK_STATE.EMPTY;
  }
}

/**
 * Fill a chunk's block array from the terrain function.
 * Theta wraps; the axial axis does not (columns outside [0, WORLD_Z) are air).
 */
export function generateChunk(chunk, terrain, overrides) {
  const C = CHUNK_SIZE;
  const i0 = chunk.originI;
  const j0 = chunk.originJ;
  const k0 = chunk.originK;
  const blocks = chunk.blocks;

  let first = -1;
  let uniform = true;
  let emissive = 0;

  for (let lk = 0; lk < C; lk++) {
    const k = k0 + lk;
    for (let lj = 0; lj < C; lj++) {
      const j = j0 + lj;
      for (let li = 0; li < C; li++) {
        const i = i0 + li;
        const id = terrain.sample(i, j, k);
        blocks[localIndex(li, lj, lk)] = id;
        if (first === -1) first = id;
        else if (id !== first) uniform = false;
        if (lightEmission(id) > 0) emissive++;
      }
    }
  }

  // Player edits win over generated terrain.
  if (overrides && overrides.size > 0) {
    for (const [okey, id] of overrides) {
      const [oi, oj, ok] = unvoxelKey(okey);
      const li = oi - i0, lj = oj - j0, lk = ok - k0;
      if (li >= 0 && li < C && lj >= 0 && lj < C && lk >= 0 && lk < C) {
        blocks[localIndex(li, lj, lk)] = id;
        if (id !== first) uniform = false;
        if (lightEmission(id) > 0) emissive++;
      }
    }
  }

  chunk.uniform = uniform;
  chunk.uniformId = first === -1 ? BLOCK.AIR : first;
  chunk.emissiveCount = emissive;
  chunk.state = CHUNK_STATE.GENERATED;

  // Bounding sphere: the chunk's corner farthest from the tube axis, swept
  // through its angular extent.  Cheap and conservative.
  const midI = i0 + C / 2;
  const theta = (midI) * WORLD.D_THETA;
  const midR = j0 + C / 2;
  chunk.centerX = Math.cos(theta) * midR;
  chunk.centerY = Math.sin(theta) * midR;
  chunk.centerZ = k0 + C / 2;
  chunk.radius = Math.sqrt(3) * C * 0.5 * 1.02 + C * 0.5;

  return chunk;
}

/** Wrap a world theta index and return it; exported for symmetry with tests. */
export function wrapI(i) { return wrapTheta(i); }
