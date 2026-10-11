/**
 * ERNAS ENGINE — world/world.js
 * =====================================================================
 *  Chunk manager: streaming, block access across chunk boundaries, edits.
 * =====================================================================
 *
 * The World is the only object that knows whether a chunk is resident.  Every
 * other system (mesher, lighting, physics, the renderer's block picker) goes
 * through `getBlock`, which transparently falls back to the pure terrain
 * function for voxels that are not loaded.  Nothing else in the engine has to
 * think about residency.
 */

import { WORLD, chunkKey, unpackChunkKey, voxelKey, wrapTheta } from "./cylinderGeometry.js";
import { Chunk, generateChunk, CHUNK_STATE, CHUNK_SIZE } from "./chunk.js";
import { BLOCK, isOpaque } from "./blocks.js";
import { lightChunk } from "./lighting.js";

export class World {
  /** @param {import("./generator.js").CylinderTerrain} terrain */
  constructor(terrain) {
    this.terrain = terrain;
    /** @type {Map<number, Chunk>} */
    this.chunks = new Map();
    /** @type {Map<number, number>} packed voxel key -> block id */
    this.overrides = new Map();
    /** Chunk keys whose mesh is stale and must be rebuilt. */
    this.dirty = new Set();
    /** Chunks created or destroyed since the last frame, for the renderer. */
    this.spawnedThisFrame = [];
    this.stats = { generated: 0, lit: 0, meshed: 0, evicted: 0 };
    /** Radial band the streamer will populate, in chunk indices. */
    this.radialWindow = { min: 0, max: 0 };
  }

  /* ---------------------------------------------------------------- *
   * Block access
   * ---------------------------------------------------------------- */

  /**
   * Block id at tube coordinate (i, j, k).
   * Always correct, resident or not.
   */
  getBlock(i, j, k) {
    const o = this.overrides.get(voxelKey(wrapTheta(i), j, k & 2047));
    if (o !== undefined) return o;

    const ci = Math.floor(i / CHUNK_SIZE);
    const cj = Math.floor(j / CHUNK_SIZE);
    const ck = Math.floor(k / CHUNK_SIZE);
    const chunk = this.chunks.get(chunkKey(ci, cj, ck));
    if (chunk && chunk.state >= CHUNK_STATE.GENERATED) {
      return chunk.blocks[((i % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
        + CHUNK_SIZE * (((j % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
        + CHUNK_SIZE * (((k % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE))];
    }
    return this.terrain.sample(i, j, k);
  }

  /** True when the voxel blocks light. */
  isOpaqueAt(i, j, k) { return isOpaque(this.getBlock(i, j, k)); }

  /**
   * Light level 0..15 at a tube coordinate.  Falls back to a sensible default
   * when the chunk is not resident: open interior is fully lit, anything at or
   * below the surface is dark.  This is an approximation used only for meshes
   * that are built while a neighbour chunk is still unloaded.
   */
  lightAt(i, j, k) {
    const ci = Math.floor(i / CHUNK_SIZE);
    const cj = Math.floor(j / CHUNK_SIZE);
    const ck = Math.floor(k / CHUNK_SIZE);
    const chunk = this.chunks.get(chunkKey(ci, cj, ck));
    if (chunk && chunk.state >= CHUNK_STATE.LIT) {
      return chunk.lightLevel(((i % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
        ((j % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
        ((k % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE);
    }
    const surface = this.terrain.firstOpaqueRadius(wrapTheta(i), k);
    return j < surface ? WORLD.LIGHT_MAX : 0;
  }

  /* ---------------------------------------------------------------- *
   * Edits
   * ---------------------------------------------------------------- */

  /**
   * Player edit.  Writes the override, patches every resident chunk that
   * contains the voxel, and marks those chunks (plus the 6 face-neighbours
   * when the edit is on a chunk boundary) dirty for remeshing and relighting.
   */
  setBlock(i, j, k, id) {
    const iw = wrapTheta(i);
    this.overrides.set(voxelKey(iw, j, k & 2047), id);

    const C = CHUNK_SIZE;
    const ci = Math.floor(iw / C), cj = Math.floor(j / C), ck = Math.floor(k / C);
    this._touchChunk(ci, cj, ck);

    // Boundary edits change a neighbour's silhouette, so it must remesh too.
    const li = ((iw % C) + C) % C, lj = ((j % C) + C) % C, lk = ((k % C) + C) % C;
    if (li === 0) this._touchChunk(ci - 1, cj, ck);
    if (li === C - 1) this._touchChunk(ci + 1, cj, ck);
    if (lj === 0) this._touchChunk(ci, cj - 1, ck);
    if (lj === C - 1) this._touchChunk(ci, cj + 1, ck);
    if (lk === 0) this._touchChunk(ci, cj, ck - 1);
    if (lk === C - 1) this._touchChunk(ci, cj, ck + 1);
  }

  _touchChunk(ci, cj, ck) {
    const key = chunkKey(ci, cj, ck);
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    const [wi, wj, wk] = unpackChunkKey(key);
    generateChunk(chunk, this.terrain, this.overrides);
    void wi; void wj; void wk;
    chunk.state = CHUNK_STATE.GENERATED;
    lightChunk(this, chunk);
    this.dirty.add(key);
  }

  /* ---------------------------------------------------------------- *
   * Chunk residency / streaming
   * ---------------------------------------------------------------- */

  /** Get a chunk, generating it on demand if `create` is true. */
  getChunk(ci, cj, ck, create = false) {
    const key = chunkKey(ci, cj, ck);
    let c = this.chunks.get(key);
    if (!c && create) {
      c = new Chunk(ci, cj, ck);
      this.chunks.set(key, c);
    }
    return c;
  }

  /** Generate + light a chunk. Returns it. */
  ensureChunk(ci, cj, ck) {
    const c = this.getChunk(ci, cj, ck, true);
    if (c.state < CHUNK_STATE.GENERATED) {
      generateChunk(c, this.terrain, this.overrides);
      this.stats.generated++;
    }
    if (c.state < CHUNK_STATE.LIT) {
      lightChunk(this, c);
      this.stats.lit++;
    }
    return c;
  }

  /**
   * Stream chunks around a tube-space centre.
   *
   * The tube's radial extent is effectively unbounded (you can fall from the
   * surface all the way to the axis, or dig to the crust), so the streamer
   * follows the player in all three axes rather than keeping a fixed radial
   * band.  That is what makes the deadzone, the crust and the void reachable
   * without a second code path.
   *
   * @param {number} ci centre theta chunk
   * @param {number} cj centre radial chunk
   * @param {number} ck centre axial chunk
   * @param {number} r  streaming radius in chunks
   * @param {number} budget max chunks to generate this call (frame budget)
   * @returns {number} number of chunks generated
   */
  update(ci, cj, ck, r, budget = 24) {
    let made = 0;

    // Generate nearest-first so a fresh spawn fills in around the player
    // instead of crawling in from the edge of the render distance.
    const want = [];
    for (let dj = -r; dj <= r; dj++) {
      for (let dk = -r; dk <= r; dk++) {
        for (let di = -r; di <= r; di++) {
          const d = di * di + dj * dj + dk * dk;
          if (d > r * r + r) continue;
          want.push([d, ci + di, cj + dj, ck + dk]);
        }
      }
    }
    want.sort((a, b) => a[0] - b[0]);

    for (const [, a, b, c] of want) {
      if (b < 0) continue;                       // below the axis: nothing exists
      if (b * CHUNK_SIZE > WORLD.R_CRUST + CHUNK_SIZE) continue;
      const existing = this.chunks.get(chunkKey(a, b, c));
      if (existing && existing.state >= CHUNK_STATE.LIT) continue;
      this.ensureChunk(a, b, c);
      this.spawnedThisFrame.push(chunkKey(a, b, c));
      if (++made >= budget) break;
    }

    // Evict anything well outside the window.
    const limit = (r + 3) * (r + 3);
    for (const [key, chunk] of this.chunks) {
      const [wi, wj, wk] = unpackChunkKey(key);
      // theta distance is circular
      let di = wi - ((ci % 512 + 512) % 512);
      if (di > 256) di -= 512;
      if (di < -256) di += 512;
      const dj = wj - cj, dk = wk - ((ck % 128 + 128) % 128);
      if (di * di + dj * dj + dk * dk > limit) {
        chunk.dispose();
        this.chunks.delete(key);
        this.dirty.delete(key);
        this.stats.evicted++;
      }
    }

    return made;
  }

  /* ---------------------------------------------------------------- *
   * Raycast — block picking for mining / interaction
   * ---------------------------------------------------------------- */

  /**
   * Amanatides & Woo voxel traversal in Cartesian space.
   *
   * UNRESOLVED(picking): the traversal steps through *Cartesian* unit cells,
   * but the voxel grid is cylindrical.  Near the surface the two agree to
   * within a few percent, so picking is accurate where the player stands, but
   * a ray fired across the tube toward the sun will drift off the true voxel
   * column.  A correct version walks the grid in (theta, r, z) — three
   * independent 1-D parametric crossings, which is the same algorithm with a
   * different step vector.  Not implemented; the demo ray only ever travels a
   * few blocks.
   *
   * @returns {{i:number,j:number,k:number,id:number}|null} the first non-air voxel
   */
  raycast(origin, dir, maxDist = 8) {
    let [x, y, z] = origin;
    const step = 0.02;
    const n = Math.ceil(maxDist / step);
    let lastI = -1, lastJ = -1, lastK = -1;
    for (let s = 0; s <= n; s++) {
      const px = x + dir[0] * step * s;
      const py = y + dir[1] * step * s;
      const pz = z + dir[2] * step * s;
      const r = Math.hypot(px, py);
      let t = Math.atan2(py, px);
      if (t < 0) t += Math.PI * 2;
      const i = Math.floor(t / WORLD.D_THETA);
      const j = Math.floor(r);
      const k = Math.floor(pz);
      if (i === lastI && j === lastJ && k === lastK) continue;
      lastI = i; lastJ = j; lastK = k;
      const id = this.getBlock(i, j, k);
      if (id !== BLOCK.AIR) return { i, j, k, id };
    }
    return null;
  }

  clearSpawned() { this.spawnedThisFrame.length = 0; }
  get residentChunks() { return this.chunks.size; }
}
