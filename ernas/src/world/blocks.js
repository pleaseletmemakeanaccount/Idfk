/**
 * ERNAS ENGINE — world/blocks.js
 * =====================================================================
 *  Block registry.  One byte per voxel, so 256 ids is the hard ceiling.
 * =====================================================================
 *
 * A block entry carries everything the three consumers of the voxel grid
 * need, and nothing else:
 *   - the mesher:  `solid`, `opaque`, `color`, `faceTint`
 *   - the lighting pass: `opaque`, `emit`
 *   - the physics/collision layer: `solid`, `liquid`
 *
 * Anything gameplay-facing (harvest time, drop table, tool tier, chisel
 * profile) belongs in a higher layer, not here — see the note on the
 * sub-voxel chisel in ernas/README.md, "Out of scope, on purpose".
 */

/** Face kinds, in the tube's own frame. */
export const FACE = Object.freeze({
  INNER: 0,  // facing the axis  — this is "up" for a player standing inside
  OUTER: 1,  // facing away from the axis — "down"
  SIDE: 2,   // tangential or axial
});

const B = (name, color, opts = {}) => Object.freeze({
  name,
  color: Object.freeze(color),
  solid: opts.solid ?? true,
  opaque: opts.opaque ?? true,
  liquid: opts.liquid ?? false,
  emit: opts.emit ?? 0,
  /** Optional per-face colour override: [inner, outer, side] as rgb triples. */
  faceTint: opts.faceTint ? Object.freeze(opts.faceTint) : null,
  hardness: opts.hardness ?? 1.0,
});

export const BLOCK = Object.freeze({
  AIR: 0,
  STONE: 1,
  MOSS: 2,        // the tube's "grass": a lichen skin on the inner surface
  DIRT: 3,
  IRON_CRUST: 4,  // the outer shell — rupturing it opens the volumetric void
  GOLD_ORE: 5,
  URANIUM: 6,
  WATER: 7,
  BLOOD: 8,       // dense fluid; recharges runic sigils
  CLOUD: 9,       // solid-enough cloud platform (Sky Ring)
  ICE: 10,
  SAND: 11,
  WOOD: 12,
  LEAVES: 13,
  CORAL: 14,      // dye-producing reef shelf
  DIRTY_STONE: 15,// the alternate dirty-stone dimension's matter
  SALT: 16,
  SNOW: 17,
  SHRINE: 18,     // ancient shrine block; emits light (Black Hole era)
  PYLON: 19,      // fast-travel node
});

/**
 * id -> definition.  Index order IS the block id; a missing slot means that
 * id is unregistered and the mesher will refuse to draw it (see `assertFull`).
 */
export const BLOCK_TABLE = [];

BLOCK_TABLE[BLOCK.AIR] = B("air", [0, 0, 0], { solid: false, opaque: false });
BLOCK_TABLE[BLOCK.STONE] = B("stone", [0.42, 0.42, 0.47], { hardness: 1.0 });
BLOCK_TABLE[BLOCK.MOSS] = B("moss", [0.30, 0.46, 0.24], {
  hardness: 0.6,
  faceTint: {
    [FACE.INNER]: [0.33, 0.52, 0.25],  // lit lichen
    [FACE.OUTER]: [0.34, 0.28, 0.19],  // root-side dirt
    [FACE.SIDE]: [0.31, 0.42, 0.22],
  },
});
BLOCK_TABLE[BLOCK.DIRT] = B("dirt", [0.36, 0.28, 0.20], { hardness: 0.5 });
BLOCK_TABLE[BLOCK.IRON_CRUST] = B("iron crust", [0.30, 0.31, 0.36], { hardness: 8.0 });
BLOCK_TABLE[BLOCK.GOLD_ORE] = B("gold ore", [0.72, 0.58, 0.20], { hardness: 2.0 });
BLOCK_TABLE[BLOCK.URANIUM] = B("uranium", [0.44, 0.78, 0.30], { hardness: 2.5, emit: 3 });
BLOCK_TABLE[BLOCK.WATER] = B("water", [0.16, 0.38, 0.66],
  { solid: false, opaque: false, liquid: true });
BLOCK_TABLE[BLOCK.BLOOD] = B("blood", [0.48, 0.05, 0.08],
  { solid: false, opaque: false, liquid: true });
BLOCK_TABLE[BLOCK.CLOUD] = B("cloud", [0.86, 0.89, 0.96],
  { solid: true, opaque: false, hardness: 0.2 });
BLOCK_TABLE[BLOCK.ICE] = B("ice", [0.66, 0.80, 0.90], { opaque: false, hardness: 0.8 });
BLOCK_TABLE[BLOCK.SAND] = B("sand", [0.80, 0.72, 0.48], { hardness: 0.5 });
BLOCK_TABLE[BLOCK.WOOD] = B("wood", [0.36, 0.25, 0.15], { hardness: 1.2 });
BLOCK_TABLE[BLOCK.LEAVES] = B("leaves", [0.20, 0.40, 0.18], { opaque: false, hardness: 0.2 });
BLOCK_TABLE[BLOCK.CORAL] = B("coral", [0.88, 0.34, 0.52], { hardness: 0.7, emit: 1 });
BLOCK_TABLE[BLOCK.DIRTY_STONE] = B("dirty stone", [0.24, 0.22, 0.21], { hardness: 1.4 });
BLOCK_TABLE[BLOCK.SALT] = B("salt", [0.86, 0.86, 0.82], { hardness: 0.6 });
BLOCK_TABLE[BLOCK.SNOW] = B("snow", [0.90, 0.93, 0.97], { hardness: 0.4 });
BLOCK_TABLE[BLOCK.SHRINE] = B("shrine", [0.85, 0.75, 0.42], { hardness: 4.0, emit: 12 });
BLOCK_TABLE[BLOCK.PYLON] = B("pylon", [0.40, 0.72, 0.85], { hardness: 3.0, emit: 8 });

/** Every id 0..N must be registered; a hole would render as undefined colour. */
export function assertFull() {
  for (let i = 0; i < BLOCK_TABLE.length; i++) {
    if (!BLOCK_TABLE[i]) throw new Error(`Block id ${i} is unregistered`);
  }
  return true;
}

/** Colour lookup with an optional face override. Returns [r,g,b] in 0..1. */
export function blockColor(id, face = FACE.SIDE) {
  const def = BLOCK_TABLE[id];
  if (!def) return [1, 0, 1];
  if (def.faceTint && def.faceTint[face]) return def.faceTint[face];
  return def.color;
}

export function isSolid(id) { return !!BLOCK_TABLE[id]?.solid; }
export function isOpaque(id) { return !!BLOCK_TABLE[id]?.opaque; }
export function isLiquid(id) { return !!BLOCK_TABLE[id]?.liquid; }
export function lightEmission(id) { return BLOCK_TABLE[id]?.emit ?? 0; }
export function blockName(id) { return BLOCK_TABLE[id]?.name ?? `unknown(${id})`; }

/**
 * Should a face between `a` (the block being meshed) and `b` (its neighbour)
 * be emitted?  Rules:
 *   - air against air: no
 *   - solid against a *different* transparent block: yes (glass underwater)
 *   - identical transparent blocks: no (no internal faces inside a lake)
 */
export function faceVisible(a, b) {
  if (a === BLOCK.AIR) return false;
  if (b === BLOCK.AIR) return true;
  if (a === b) return false;
  if (isOpaque(b)) return false;
  return true;
}

assertFull();
