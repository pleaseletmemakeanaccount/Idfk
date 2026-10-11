/**
 * ERNAS ENGINE — noise/index.js
 * =====================================================================
 *  Public noise API + the named ERNAS terrain layers.
 * =====================================================================
 *
 * Raw Perlin is a primitive.  World code should never call `perlin3` with a
 * hand-rolled seed arithmetic — that is how two subsystems accidentally share
 * a seed and end up with ore veins that mirror the cave system.
 *
 * `NoiseEngine` owns one world seed and derives one independent stream per
 * named layer.  Layer names are part of the save format: renaming one changes
 * the world, so treat them as stable identifiers.
 */

export * from "./perlin.js";
export * from "./fractal.js";

import { RNG, seedToUint32, cyrb128 } from "../core/rng.js";
import {
  fbm2Tiled, fbm3Tiled, ridged2Tiled, billow2Tiled, turbulence2Tiled,
  domainWarp2Tiled, curl2, curl3, makeOctaveTable,
} from "./fractal.js";

/**
 * The named noise layers of the ERNAS tube, in generation order.
 *
 * LACUNARITY IS PINNED TO EXACTLY 2.0 ON PURPOSE.
 * A tileable fractal needs every octave's period to be an exact integer, and
 * the octave-k period is period0 / lacunarity^k.  With lacunarity = 2 and a
 * power-of-two period0, every period is exact and the whole stack closes on
 * itself.  A lacunarity of 2.03 would round the period at some octave, and the
 * theta seam would tear open — the single most visible bug a tube world can
 * have.  Frequency variety comes from `cellsPerTurn` and domain warping, not
 * from a fractional lacunarity.
 */
export const NOISE_LAYERS = Object.freeze({
  continental: { kind: "warp2", octaves: 5, lacunarity: 2, gain: 0.50 },
  detail:      { kind: "fbm2",  octaves: 4, lacunarity: 2, gain: 0.48 },
  ridge:       { kind: "ridg2", octaves: 5, lacunarity: 2, gain: 0.52 },
  cloud:       { kind: "bill2", octaves: 4, lacunarity: 2, gain: 0.55 },
  storm:       { kind: "turb2", octaves: 3, lacunarity: 2, gain: 0.50 },
  cave:        { kind: "fbm3",  octaves: 3, lacunarity: 2, gain: 0.50 },
  island:      { kind: "fbm3",  octaves: 3, lacunarity: 2, gain: 0.50 },
  ore:         { kind: "fbm3",  octaves: 2, lacunarity: 2, gain: 0.50 },
  biome:       { kind: "fbm2",  octaves: 3, lacunarity: 2, gain: 0.50 },
});

/**
 * MEASURED output statistics of each layer.
 * ----------------------------------------------------------------------
 * Fractal operators do NOT preserve variance, and the deviation is large:
 *
 *   layer         mean     sd      raw range
 *   continental   0.000    0.127   -0.42 .. 0.46
 *   detail        0.002    0.135   -0.45 .. 0.46
 *   ridge         0.675    0.135    0.15 .. 1.00
 *   cloud        -0.643    0.152   -1.00 .. -0.04
 *   storm         0.176    0.082    0.00 .. 0.52
 *   biome         0.000    0.135   -0.39 .. 0.43
 *   cave          0.000    0.122   -0.46 .. 0.47
 *   island        0.000    0.122   -0.50 .. 0.49
 *   ore           0.000    0.140   -0.53 .. 0.54
 *
 * Measured with 3-5 world seeds x 40k-120k samples each; the spread between
 * seeds is under 3% on every row, so these are safe constants.
 * `tests/noise.test.js` re-measures them and fails if they drift.
 *
 * WHY THIS TABLE EXISTS: thresholding raw fractal output silently does
 * nothing.  Billow noise ("cloud") never exceeds -0.04, so a `cloud > 0.4`
 * test produces zero clouds ever.  Turbulence ("storm") never exceeds 0.52,
 * so a `> 0.72` sinkhole test produces zero sinkholes ever.  Both bugs were
 * present, both were invisible in the output (you just get a world with no
 * clouds), and both are caught by this table.  Always threshold *normalised*
 * values, in units of standard deviation.
 */
export const LAYER_STATS = Object.freeze({
  continental: Object.freeze({ mean: 0.000, sd: 0.127 }),
  detail:      Object.freeze({ mean: 0.002, sd: 0.135 }),
  ridge:       Object.freeze({ mean: 0.675, sd: 0.135 }),
  cloud:       Object.freeze({ mean: -0.643, sd: 0.152 }),
  storm:       Object.freeze({ mean: 0.176, sd: 0.082 }),
  biome:       Object.freeze({ mean: 0.000, sd: 0.135 }),
  cave:        Object.freeze({ mean: 0.000, sd: 0.122 }),
  island:      Object.freeze({ mean: 0.000, sd: 0.122 }),
  ore:         Object.freeze({ mean: 0.000, sd: 0.140 }),
});

/** Smooth saturating clamp: linear near 0, asymptotes to +-limit. */
export function softClamp(v, limit = 3) {
  const t = v / limit;
  return limit * (t / (1 + Math.abs(t)));
}

export class NoiseEngine {
  /**
   * @param {string|number} seed world seed; identical input -> identical world
   */
  constructor(seed = "ERNAS") {
    this.seed = seed;
    this.seedU32 = seedToUint32(seed);
    this.rng = new RNG(seed);
    /** @type {Map<string, number>} */
    this._layerSeeds = new Map();
    /** @type {Map<string, ReturnType<typeof makeOctaveTable>>} */
    this._tables = new Map();
  }

  /** The 32-bit seed derived for a named layer. */
  seedFor(name) {
    let s = this._layerSeeds.get(name);
    if (s === undefined) {
      if (!(name in NOISE_LAYERS)) throw new Error(`Unknown ERNAS noise layer: ${name}`);
      s = cyrb128(`${this.seed}::layer::${name}`)[0];
      this._layerSeeds.set(name, s);
    }
    return s;
  }

  /** Cached octave table for a named layer. */
  tableFor(name) {
    let t = this._tables.get(name);
    if (!t) {
      t = makeOctaveTable(NOISE_LAYERS[name]);
      this._tables.set(name, t);
    }
    return t;
  }

  /**
   * Sample a named 2D layer.
   *
   * `x` is already in lattice cells and `periodX` is the exact tile period of
   * the base octave in lattice cells.  The caller owns the frequency; this
   * engine refuses to rescale it, because any rescaling that is not an exact
   * integer division destroys the tile seam.
   */
  sample2(name, x, y, periodX = 0, periodY = 0) {
    const def = NOISE_LAYERS[name];
    if (!def) throw new Error(`Unknown ERNAS noise layer: ${name}`);
    const seed = this.seedFor(name);
    const px = periodX | 0;
    const py = periodY | 0;
    switch (def.kind) {
      // Warp displacement is measured in LATTICE CELLS of the base octave.
      // 0.6 cells keeps the folded-strata look.  The 4.0 multiplier that used
      // to be inside domainWarp2Tiled pushed displacement past 10 cells — more
      // than the base wavelength itself — which folded the field over and
      // produced multi-block cliffs between adjacent columns.
      case "warp2": return domainWarp2Tiled(x, y, px, py, def, seed, 0.6);
      case "fbm2":  return fbm2Tiled(x, y, px, py, def, seed);
      case "ridg2": return ridged2Tiled(x, y, px, py, def, seed);
      case "bill2": return billow2Tiled(x, y, px, py, def, seed);
      case "turb2": return turbulence2Tiled(x, y, px, py, def, seed);
      default: throw new Error(`Layer ${name} is not a 2D layer`);
    }
  }

  /** Sample a named 3D layer (caves, ore). Coordinates are lattice units. */
  sample3(name, x, y, z, periodX = 0, periodY = 0, periodZ = 0) {
    const def = NOISE_LAYERS[name];
    if (!def) throw new Error(`Unknown ERNAS noise layer: ${name}`);
    if (def.kind !== "fbm3") throw new Error(`Layer ${name} is not a 3D layer`);
    const seed = this.seedFor(name);
    return fbm3Tiled(x, y, z, periodX | 0, periodY | 0, periodZ | 0, def, seed);
  }

  /**
   * Sample a 2D layer and normalise it to zero mean / unit variance using
   * LAYER_STATS.  This is the form world code should threshold against:
   * "cloud > 0.4" then genuinely means "the top third of cloud density".
   */
  sample2Norm(name, x, y, periodX = 0, periodY = 0) {
    const st = LAYER_STATS[name];
    const v = this.sample2(name, x, y, periodX, periodY);
    return (v - st.mean) / st.sd;
  }

  /** Sample a 3D layer, normalised to zero mean / unit variance. */
  sample3Norm(name, x, y, z, periodX = 0, periodY = 0, periodZ = 0) {
    const st = LAYER_STATS[name];
    const v = this.sample3(name, x, y, z, periodX, periodY, periodZ);
    return (v - st.mean) / st.sd;
  }

  /** Divergence-free 2D flow field (tornado cross-section, steam). */
  curl2(name, x, y, out) {
    return curl2(x, y, out, this.seedFor(name));
  }

  /** Divergence-free 3D flow field (spherical tornado volumes). */
  curl3(name, x, y, z, out) {
    return curl3(x, y, z, out, this.seedFor(name));
  }
}
