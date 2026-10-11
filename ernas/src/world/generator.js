/**
 * ERNAS ENGINE — world/generator.js
 * =====================================================================
 *  Procedural terrain for the inverted cylinder.
 * =====================================================================
 *
 * The generator is a PURE FUNCTION of (i, j, k).  It holds no chunk storage.
 * That single decision keeps the whole engine simple:
 *
 *   - Meshing a chunk never needs its neighbours to be loaded; it just asks
 *     the generator for the 6 neighbour voxels.
 *   - Lighting, physics raycasts and the void outside the streaming window
 *     all read the same function, so the world cannot disagree with itself.
 *   - Player edits are a sparse overlay on top (see world.js `overrides`).
 *
 * The only mutable state is a *cache* of the (i,k) -> surface-radius height
 * field, because that value is needed by nearly every voxel in a column and
 * recomputing the domain-warped fBm per voxel would be ~20x slower.
 *
 * TERRAIN MODEL
 * -------------
 * Because gravity points outward, "altitude" is a *radius*.  High ground is
 * CLOSER to the axis:
 *
 *     surfaceRadius(i,k) = R_SURFACE - relief(i,k)
 *
 *   relief > 0  -> mountain, the peak leans toward the axis
 *   relief < 0  -> basin / ocean trench, the floor sinks toward the crust
 *
 * Solid rock fills [ surfaceRadius(i,k) , R_CRUST ].  The last
 * CRUST_THICKNESS layers are the outer iron crust.
 *
 * THE THETA FREQUENCY CONTRACT  (read before touching any sample call)
 * -------------------------------------------------------------------
 * Every noise sample taken along the theta axis must satisfy:
 *
 *     x = i * (cells / THETA_COUNT)   and   periodX = cells
 *
 * for some integer `cells`.  Then advancing a full revolution (i -> i+8192)
 * advances the lattice coordinate by exactly `cells` cells = exactly one tile
 * period, and the seam is bit-exact at every octave.  Any frequency that is
 * not of this form — 0.055, 1/18, "a third of the tube" — silently tears the
 * seam, and a tear in a tube world is a wall running from the sky to the
 * crust.  Use `theta(cells)` and never hand-write a theta frequency.
 */

import { WORLD, wrapTheta } from "./cylinderGeometry.js";
import { BLOCK } from "./blocks.js";
import { NoiseEngine, softClamp } from "../noise/index.js";
import { RNG, hash2 } from "../core/rng.js";

export const BIOME = Object.freeze({
  HIGHLANDS: 0,
  TAIGA: 1,
  ABYSSAL_TRENCH: 2,
  CORAL_SHELF: 3,
  BROKEN_LANDS: 4,
});

export const BIOME_NAMES = ["highlands", "taiga", "abyssal trench", "coral shelf", "broken lands"];

/** Radial band where the Sky Ring cloud platforms float. */
export const CLOUD_BAND = Object.freeze({ inner: 1000, outer: 1092 });
/** Radial band for the floating-island clusters that spawn near the ranges. */
export const ISLAND_BAND = Object.freeze({ inner: 1150, outer: 1196 });

/**
 * Exact theta frequency descriptor.
 * `cells` noise lattice cells per full revolution; must be a power of two and
 * >= 2^(octaves-1) so that every octave's period is still an integer >= 1.
 *
 * Feature size at octave 0, in voxel columns:  THETA_COUNT / cells
 */
function theta(cells) {
  return Object.freeze({ freq: cells / WORLD.THETA_COUNT, period: cells });
}

/**
 * Per-layer theta frequencies.  Feature sizes are quoted in voxel columns at
 * the surface (arc length ~= 1 voxel/column, see cylinderGeometry.arcWidthAt).
 */
export const THETA_FREQ = Object.freeze({
  continental: theta(16),   // 512 columns per continent-scale feature
  detail:      theta(256),  // 32 columns
  ridge:       theta(32),   // 256 columns
  cloud:       theta(64),   // 128 columns
  /*
   * Sinkholes.  This was 512 (16-column features) and it was the single worst
   * source of cliffs in the tube: the ramp crossed its whole range inside two
   * columns, dropping up to 55 blocks between neighbours.  At 64 the finest
   * octave is 16 columns wide, so a sinkhole is a ~128-column basin with a
   * steep but walkable rim.  Measured: worst adjacent step 7.2 blocks (was 55).
   */
  storm:       theta(64),   // 128 columns — sinkhole basins
  cave:        theta(512),  // 16 columns
  island:      theta(256),  // 32 columns
  ore:         theta(1024), // 8 columns
  biome:       theta(8),    // 1024 columns per biome region
});

/** Scales the unit-variance height composite back to a usable relief range. */
const RELIEF_GAIN = 0.66;

/** Smooth Hermite step, clamped to [0,1].  Used for every biome blend. */
function smooth01(x) {
  const t = x < 0 ? 0 : (x > 1 ? 1 : x);
  return t * t * (3 - 2 * t);
}

/** Axial (k) frequencies — same scale as theta, no tiling needed. */
const AX = Object.freeze({
  continental: THETA_FREQ.continental.freq,
  detail: THETA_FREQ.detail.freq,
  ridge: THETA_FREQ.ridge.freq,
  cloud: THETA_FREQ.cloud.freq,
  cave: THETA_FREQ.cave.freq,
  ore: THETA_FREQ.ore.freq,
  biome: THETA_FREQ.biome.freq,
});

/**
 * Column patch cache.
 * Keys are chunk-aligned 16x16 (i,k) patches; the value is a Float32Array of
 * 256 surface radii plus 256 biome ids.  Eviction is plain FIFO.
 *
 * UNRESOLVED(cache): FIFO is not LRU.  A player running in a straight line
 * along the tube evicts exactly the patches they just used — the worst case
 * for cache behaviour.  It is invisible at the current streaming radius (the
 * whole visible set fits inside `maxPatches`), but it must become a real LRU,
 * or be owned by the chunk manager and freed together with the chunk, before
 * the streaming radius grows.
 */
class ColumnPatchCache {
  constructor(maxPatches = 8192) {
    this.maxPatches = maxPatches;
    this.map = new Map();
  }

  key(ci, ck) {
    const a = ((ci % 8192) + 8192) % 8192;
    const b = ((ck % 8192) + 8192) % 8192;
    return a * 8192 + b;
  }

  get(ci, ck) { return this.map.get(this.key(ci, ck)); }

  set(ci, ck, patch) {
    const k = this.key(ci, ck);
    if (this.map.size >= this.maxPatches && !this.map.has(k)) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(k, patch);
    return patch;
  }

  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

export class CylinderTerrain {
  /** @param {string|number} seed world seed */
  constructor(seed = "ERNAS") {
    this.seed = seed;
    this.noise = new NoiseEngine(seed);
    this.rng = new RNG(seed);
    this.cache = new ColumnPatchCache();
    this.stats = { patchesBuilt: 0, samples: 0 };
  }

  /* ---------------------------------------------------------------- *
   * Biomes
   * ---------------------------------------------------------------- */

  /**
   * Continuous biome fields for a column.
   *
   * Two low-frequency fields give a temperature/moisture pair.  Everything the
   * HEIGHT FIELD needs is returned as a smooth 0..1 blend weight, and only the
   * discrete `id` is used for choosing surface materials.
   *
   * WHY: my first version branched on the biome id inside the height field, so
   * a highlands column next to an abyssal trench stepped down ~60 voxels in
   * one column.  Measured over 150k columns the worst adjacent step was 48
   * blocks — the tube was ringed with unclimbable vertical walls.  Geometry
   * must be continuous; only materials may switch abruptly.
   */
  _biomeFields(i, k) {
    const bx = i * AX.biome, bz = k * AX.biome, bp = THETA_FREQ.biome.period;
    const t = this.noise.sample2Norm("biome", bx, bz, bp);
    const m = this.noise.sample2Norm("biome", bx + 4096.5, bz - 1877.5, bp);

    const cold = smooth01((-0.45 - t) / 0.70);   // 1 when t <= -0.45
    const wet = smooth01((m - 0.25) / 0.70);
    const warm = smooth01((t + 0.20) / 0.60);
    const ocean = wet * warm;                    // 0..1, continuous
    const deep = smooth01((m - 0.90) / 0.80);    // 1 in the deepest water

    let id = BIOME.HIGHLANDS;
    if (this._brokenWeight(k) >= 1) id = BIOME.BROKEN_LANDS;
    else if (cold > 0.5) id = BIOME.TAIGA;
    else if (ocean > 0.5) id = deep > 0.5 ? BIOME.ABYSSAL_TRENCH : BIOME.CORAL_SHELF;

    return { t, m, cold, wet, warm, ocean, deep, id };
  }

  /**
   * Biome at a (theta, axial) column.  Discrete id, used for materials only —
   * never for geometry.  See `_biomeFields`.
   */
  biomeAt(i, k) {
    return this._biomeFields(i, k).id;
  }

  /**
   * 0 in the middle of the tube, 1 inside the axial end bands.
   * The Broken Lands are the edge-zone anomaly: geometry stops being smooth.
   */
  _brokenWeight(k) {
    const d = Math.min(k, WORLD.WORLD_Z - 1 - k);
    const w = WORLD.BROKEN_LAND_WIDTH;
    if (d >= w) return 0;
    return 1 - d / w;
  }

  /* ---------------------------------------------------------------- *
   * Height field
   * ---------------------------------------------------------------- */

  /**
   * Build (or fetch) the 16x16 column patch containing (i, k).
   * @returns {{radius: Float32Array, biome: Uint8Array}}
   */
  columnPatch(ci, ck) {
    const hit = this.cache.get(ci, ck);
    if (hit) return hit;

    const C = WORLD.CHUNK;
    const radius = new Float32Array(C * C);
    const biome = new Uint8Array(C * C);
    const shadow = new Float32Array(C * C);
    const ocean = new Float32Array(C * C);
    const deep = new Float32Array(C * C);
    const cold = new Float32Array(C * C);
    const cont = new Float32Array(C * C);
    const base = ci * C;
    const baseZ = ck * C;

    const CF = THETA_FREQ.cloud;
    for (let lk = 0; lk < C; lk++) {
      const k = baseZ + lk;
      const broken = this._brokenWeight(k);
      const zArg = k * AX.cloud;
      for (let li = 0; li < C; li++) {
        const i = base + li;
        const idx = li + C * lk;
        const bf = this._biomeFields(i, k);
        biome[idx] = bf.id;
        ocean[idx] = bf.ocean;
        deep[idx] = bf.deep;
        cold[idx] = bf.cold;
        const CFc = THETA_FREQ.continental;
        const c = this.noise.sample2Norm("continental", i * CFc.freq, k * AX.continental, CFc.period);
        cont[idx] = c;
        const r = this._surfaceRadius(i, k, bf.id, broken, bf, c);
        radius[idx] = r;
        // Sunlight blocker for the column.  Computed here, once per column,
        // instead of per voxel in the lighting and meshing passes — see the
        // note on firstOpaqueRadius below.
        const cloud = this.noise.sample2Norm("cloud", i * CF.freq, zArg, CF.period);
        shadow[idx] = cloud > 0.35 ? CLOUD_BAND.inner : r;
      }
    }
    this.stats.patchesBuilt++;
    return this.cache.set(ci, ck, { radius, biome, shadow, ocean, deep, cold, cont });
  }

  /** Innermost solid radius at column (i, k). Cached. */
  surfaceRadius(i, k) {
    const C = WORLD.CHUNK;
    const patch = this.columnPatch(Math.floor(i / C), Math.floor(k / C));
    return patch.radius[((i % C) + C) % C + C * (((k % C) + C) % C)];
  }

  /** Biome id at column (i, k). Cached. */
  biomeAtCached(i, k) {
    const C = WORLD.CHUNK;
    const patch = this.columnPatch(Math.floor(i / C), Math.floor(k / C));
    return patch.biome[((i % C) + C) % C + C * (((k % C) + C) % C)];
  }

  /**
   * Uncached height field.  Composes:
   *   continental  domain-warped fBm   — the landmass shape
   *   ridge        ridged multifractal — creases and peaks
   *   detail       fine fBm            — bumps you can walk over
   * All three tile in theta, so the tube closes seamlessly.
   *
   * @param {object} bf    continuous biome fields (see `_biomeFields`)
   * @param {number} contN normalised continental value, reused for basins
   */
  _surfaceRadius(i, k, biome, brokenWeight, bf, contN) {
    const CF = THETA_FREQ.continental, RF = THETA_FREQ.ridge, DF = THETA_FREQ.detail;
    const cont = contN;
    const ridge = this.noise.sample2Norm("ridge", i * RF.freq, k * AX.ridge, RF.period);
    const detail = this.noise.sample2Norm("detail", i * DF.freq, k * AX.detail, DF.period);

    /*
     * Weighted sum of three unit-variance fields.  Assuming independence the
     * composite has sd sqrt(0.62^2 + 0.26^2 + 0.12^2) = 0.683, so RELIEF_GAIN
     * scales it back to sd ~0.45: about 95% of columns land within
     * +-SURFACE_AMP, and the clamp below catches the tail.
     *
     * ridged is used raw (not folded) so its natural skew survives: sharp
     * peaks, rounded valleys.
     */
    let land = WORLD.SURFACE_AMP * RELIEF_GAIN
      * softClamp(0.62 * cont + 0.26 * ridge + 0.12 * detail, 3);

    // Taiga is a lower, rolling sub-freezing ring.  Blended, not branched.
    land *= 1 - 0.18 * bf.cold;

    /*
     * Ocean basins, blended continuously by `ocean` (0 = dry land, 1 = open
     * water) so a coastline is a slope rather than a cliff.
     */
    const bowl = Math.min(2, Math.max(0, -cont));
    const oceanDepth = 14 + 46 * bf.deep + 10 * bowl;
    let relief = land * (1 - bf.ocean) + (-oceanDepth) * bf.ocean;

    /*
     * Sinkholes: a rare radial collapse punching into the cave system.
     * A smooth ramp rather than a threshold — a hard `if (sink > X)` produces
     * a hole with vertical sides, which is a pit, not a sinkhole.
     */
    const SF = THETA_FREQ.storm;
    const sink = this.noise.sample2Norm("storm", i * SF.freq, k * SF.freq, SF.period);
    relief -= smooth01((sink - 1.7) / 1.2) * 40;

    /*
     * The Broken Lands.  The Farlands-style look comes from quantising the
     * height field AND shearing it by a per-column hash, so adjacent columns
     * stop agreeing with each other and the surface fractures into disjointed
     * linear steps.  This is the one place a deliberate discontinuity is
     * wanted, and it is blended in by `brokenWeight` so the transition from
     * normal terrain is a gradient.
     */
    if (brokenWeight > 0) {
      const shear = ((hash2(i, k, 0x51ed) & 31) - 16) * brokenWeight;
      const stepped = Math.round((relief + shear) / 7) * 7;
      relief = relief * (1 - brokenWeight) + stepped * brokenWeight;
    }

    // Clamp so the shell can never punch through the crust or the sky.
    const minR = WORLD.R_SURFACE - WORLD.SURFACE_AMP - 6;
    const maxR = WORLD.R_CRUST_INNER - 4;
    const r = WORLD.R_SURFACE - relief;
    return r < minR ? minR : (r > maxR ? maxR : r);
  }

  /* ---------------------------------------------------------------- *
   * Voxel sampling — the single source of truth for "what is here"
   * ---------------------------------------------------------------- */

  /**
   * Block id at tube-grid coordinate (i, j, k).
   * `i` wraps around the tube; `k` is clamped by the world length; `j` is a
   * raw radius and does not wrap.
   */
  sample(i, j, k) {
    this.stats.samples++;

    // --- outside the axial extent of the tube: void -------------------
    if (k < 0 || k >= WORLD.WORLD_Z) return BLOCK.AIR;

    // --- beyond the iron crust: the volumetric void -------------------
    if (j >= WORLD.R_CRUST) return BLOCK.AIR;

    const iw = wrapTheta(i);

    // --- the iron crust itself ---------------------------------------
    if (j >= WORLD.R_CRUST_INNER) return BLOCK.IRON_CRUST;

    // --- open interior: only clouds and floating islands live here ----
    if (j < WORLD.R_SHELL_MIN) return this._interior(iw, j, k);

    /*
     * The height field is a float (so lighting and geometry can stay smooth),
     * but voxel occupancy is an integer.  The topmost solid voxel is
     * ceil(h) — NOT floor, and not `h` used directly.  Getting this wrong
     * makes `depth = j - h` a fraction that is never exactly 0, and the
     * depth === 0 skin layer (moss, snow, sand) silently never appears.
     * That bug was live here once; `tests/cylinder.test.js` pins it.
     */
    const hInt = Math.ceil(this.surfaceRadius(iw, k));
    if (j < hInt) return this._liquid(iw, j, k);
    return this._shell(iw, j, k, hInt);
  }

  /**
   * Air, or the fluid filling a basin.  Called only for j < surfaceRadius,
   * so anything at or below the sea-level radius that is not rock is fluid.
   *
   * Abyssal trenches hold still, black water; the coral shelf holds clear
   * water.  Liquid BLOOD is reserved for the Outer Desert Sphere's oceans —
   * see ernas/README.md, "Out of scope, on purpose".
   */
  _liquid(i, j, k) {
    if (j < WORLD.SEA_RADIUS) return BLOCK.AIR;
    return BLOCK.WATER;
  }

  /**
   * Rock, skin and ores from the surface down to the crust.
   * @param {number} hInt integer surface radius = index of the topmost solid voxel
   */
  _shell(i, j, k, hInt) {
    const depth = j - hInt;           // exactly 0 on the topmost solid voxel
    const bio = this.biomeAtCached(i, k);

    // Caves: two independent fields, carve where BOTH are near zero.
    // The near-zero sets of two fields intersect in 1-D curves, which is what
    // turns "swiss cheese" into long connected tunnels.
    if (depth > 2 && j < WORLD.R_CRUST_INNER - 3) {
      const CF = THETA_FREQ.cave;
      const fx = CF.freq, fy = 0.075;
      const a = this.noise.sample3Norm("cave", i * fx, j * fy, k * fx, CF.period);
      const b = this.noise.sample3Norm("cave", i * fx + 131.5, j * fy - 77.25, k * fx + 41.5, CF.period);
      // Both fields inside +-0.30 sd at once: ~5% of the shell becomes tunnel.
      if (Math.abs(a) < 0.30 && Math.abs(b) < 0.30) return BLOCK.AIR;
    }

    // Ores.  Gold favours the taiga's shallow surface veins; uranium sits deep.
    if (depth > 4) {
      const OF = THETA_FREQ.ore;
      const o = this.noise.sample3Norm("ore", i * OF.freq, j * 0.13, k * OF.freq, OF.period);
      const goldCut = bio === BIOME.TAIGA ? 1.35 : 1.65;
      if (o > goldCut && depth < 34) return BLOCK.GOLD_ORE;
      if (o < -2.0 && depth > 52) return BLOCK.URANIUM;
    }

    // The skin, and the layers just under it.
    if (depth === 0) {
      switch (bio) {
        case BIOME.TAIGA: return BLOCK.SNOW;
        case BIOME.ABYSSAL_TRENCH: return BLOCK.DIRT;
        case BIOME.CORAL_SHELF: return BLOCK.SAND;
        case BIOME.BROKEN_LANDS: return BLOCK.DIRTY_STONE;
        default: return BLOCK.MOSS;
      }
    }
    if (depth === 1 && bio === BIOME.CORAL_SHELF) {
      // Coral grows on the shallow sea floor.
      const CF = THETA_FREQ.island;
      if (this.noise.sample3Norm("island", i * CF.freq, j * 0.3, k * CF.freq, CF.period) > 1.0) {
        return BLOCK.CORAL;
      }
      return BLOCK.SAND;
    }
    if (depth < 4) {
      return bio === BIOME.CORAL_SHELF ? BLOCK.SAND
        : bio === BIOME.BROKEN_LANDS ? BLOCK.DIRTY_STONE
        : BLOCK.DIRT;
    }
    if (bio === BIOME.TAIGA && depth < 7) return BLOCK.ICE;
    if (bio === BIOME.BROKEN_LANDS) return BLOCK.DIRTY_STONE;
    return BLOCK.STONE;
  }

  /**
   * The open interior volume: Sky Ring cloud platforms and the floating
   * island clusters that spawn near the mountain ranges.
   */
  _interior(i, j, k) {
    if (j >= CLOUD_BAND.inner && j < CLOUD_BAND.outer) {
      const CF = THETA_FREQ.cloud;
      const n = this.noise.sample2Norm("cloud", i * CF.freq, k * AX.cloud, CF.period);
      // Thin the cloud toward the edges of the band so platforms get a top and
      // a bottom surface instead of being a solid slab.
      const mid = (CLOUD_BAND.inner + CLOUD_BAND.outer) / 2;
      const half = (CLOUD_BAND.outer - CLOUD_BAND.inner) / 2;
      const edge = 1 - Math.abs(j - mid) / half;   // 1 mid-band, 0 at the edges
      // n is in sd units; the band edge raises the bar so platforms get a skin.
      return n > 0.55 - 1.25 * edge ? BLOCK.CLOUD : BLOCK.AIR;
    }

    if (j >= ISLAND_BAND.inner && j < ISLAND_BAND.outer) {
      // Islands only where a mountain is overhead: re-sample the continental
      // field the surface uses, so islands track the ranges above them.
      const CF = THETA_FREQ.continental;
      const cont = this.noise.sample2Norm("continental", i * CF.freq, k * AX.continental, CF.period);
      if (cont < 0.9) return BLOCK.AIR;

      const IF = THETA_FREQ.island;
      const lump = this.noise.sample3Norm("island", i * IF.freq, j * 0.16, k * IF.freq, IF.period);
      const mid = (ISLAND_BAND.inner + ISLAND_BAND.outer) / 2;
      const half = (ISLAND_BAND.outer - ISLAND_BAND.inner) / 2;
      const edge = 1 - Math.abs(j - mid) / half;
      if (lump > 0.95 - 1.60 * edge) {
        // The band's inner edge is the island's *top* (closest to the axis),
        // so give that layer a moss skin and the rest bare stone.
        return j === ISLAND_BAND.inner ? BLOCK.MOSS : BLOCK.STONE;
      }
      return BLOCK.AIR;
    }

    return BLOCK.AIR;
  }

  /* ---------------------------------------------------------------- *
   * Lighting support
   * ---------------------------------------------------------------- */

  /**
   * Radius at which sunlight is first blocked in this column.
   * Anything at or beyond this radius is in shadow unless light floods in
   * from a neighbour.
   *
   * Cached in the column patch.  This matters more than it looks: lighting and
   * meshing both ask for it once per *voxel*, and the uncached version ran a
   * four-octave billow noise every time — measured at 54 us/call, which made
   * lighting a single chunk cost 49 ms of pure cloud noise.  Reading it out of
   * the patch costs the same as `surfaceRadius`.
   *
   * UNRESOLVED(cloud shadows): the cloud test is coarse.  A column counts as
   * cloud-covered when the cloud field crosses the threshold at the column
   * centre, rather than by scanning the 92-voxel cloud band for an actual
   * solid voxel.  That makes cloud shadows slightly larger and softer-edged
   * than the clouds themselves.  The correct version scans the band once per
   * column patch — still cheap, since it would live right here.
   */
  firstOpaqueRadius(i, k) {
    const C = WORLD.CHUNK;
    const patch = this.columnPatch(Math.floor(i / C), Math.floor(k / C));
    return patch.shadow[((i % C) + C) % C + C * (((k % C) + C) % C)];
  }

  /** Debug/telemetry: forget every cached column patch. */
  invalidate() { this.cache.clear(); }
}

/** Convenience factory for tests and tools. */
export function makeTerrain(seed = "ERNAS") {
  return new CylinderTerrain(seed);
}
