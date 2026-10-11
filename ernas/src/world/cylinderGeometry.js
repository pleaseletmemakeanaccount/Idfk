/**
 * ERNAS ENGINE — world/cylinderGeometry.js
 * =====================================================================
 *  The inverted cylinder: coordinate system, gravity field, sun deadzone.
 * =====================================================================
 *
 * ERNAS's primary space is the *interior wall* of a colossal cylinder.  The
 * player stands on the inside of the tube and "up" points at the cylinder's
 * central axis.  Everything about the engine — voxel addressing, chunking,
 * meshing, lighting, physics — is expressed in cylindrical coordinates and
 * converted to Cartesian only at the last possible moment (mesh upload).
 *
 * VOXEL ADDRESSING (the "tube grid")
 * ----------------------------------
 *   i = theta index   0 .. THETA_COUNT-1   around the tube   (wraps)
 *   j = radial index  = integer radius in voxels from the axis  (does NOT wrap)
 *   k = axial index   0 .. WORLD_Z-1       along the tube's length
 *
 * A voxel (i, j, k) occupies
 *      theta in [ i*dTheta , (i+1)*dTheta ]
 *      r     in [ j        , j+1          ]
 *      z     in [ k        , k+1          ]
 *
 * Making `j` literally the radius is deliberate: it makes the terrain a
 * height field in (i, k) with the radius as the height, which in turn makes
 * skylight trivial ("is anything solid between me and the axis?") and makes
 * chunk indexing a plain 3D box.
 *
 * LAYOUT FROM THE AXIS OUTWARD
 * ----------------------------
 *   r = 0                    the central longitudinal axis
 *   r <= R_SUN               THE SUN.  A perfect non-voxelised sphere.
 *   r <= R_DEADZONE          zero-gravity deadzone around the sun
 *   R_DEADZONE .. surface    open interior volume (sky, clouds, sky ring)
 *   h(i,k) .. R_CRUST_INNER  terrain shell: dirt/grass skin, stone, ores, caves
 *   R_CRUST_INNER .. R_CRUST OUTER IRON CRUST — the hard shell encasing the tube
 *   r > R_CRUST              the volumetric void (cloud-filled, non-voxel)
 *
 * Since gravity points OUTWARD, "down" for the player is +r and the iron
 * crust is the bedrock you eventually dig through to break into the void.
 */

/* ================================================================== *
 * World constants
 * ================================================================== */

/**
 * THETA_COUNT is the number of angular voxel columns around the tube.
 * It is built as THETA_PERIOD * THETA_REPS so that:
 *   - THETA_PERIOD (1024) is the tile period of the base noise octave, giving
 *     a continental feature size of 1024 columns;
 *   - THETA_REPS (8) repetitions fit exactly around the circumference, so the
 *     *whole* tube is seamless — there is no special-case seam column.
 */
export const WORLD = Object.freeze((() => {
  const THETA_PERIOD = 1024;
  const THETA_REPS = 8;
  const THETA_COUNT = THETA_PERIOD * THETA_REPS;      // 8192 columns
  const R_SURFACE = 1280;                            // mean surface radius
  const SURFACE_AMP = 44;                            // +- relief in voxels
  const SHELL_DEPTH = 112;                           // rock below the surface
  const CRUST_THICKNESS = 10;                        // iron crust
  const R_CRUST = R_SURFACE + SURFACE_AMP + SHELL_DEPTH + CRUST_THICKNESS; // 1446
  const R_CRUST_INNER = R_CRUST - CRUST_THICKNESS;
  const R_SUN = 72;                                  // perfect geometric sphere
  const R_DEADZONE = 120;                            // zero-g threshold
  const R_GRAV_FULL = 320;                           // gravity reaches 1.0 here
  const WORLD_Z = 2048;                              // tube length in voxels
  const SEA_RADIUS = R_SURFACE + 10;                 // "sea level" (a radius!)
  const CHUNK = 16;
  const BROKEN_LAND_WIDTH = 96;                      // +-Z edge anomaly band

  return {
    AXIS: "Z",
    THETA_PERIOD, THETA_REPS, THETA_COUNT,
    D_THETA: (Math.PI * 2) / THETA_COUNT,
    R_SURFACE, SURFACE_AMP, SHELL_DEPTH,
    CRUST_THICKNESS, R_CRUST, R_CRUST_INNER,
    R_SUN, R_DEADZONE, R_GRAV_FULL,
    WORLD_Z, SEA_RADIUS, CHUNK, BROKEN_LAND_WIDTH,
    GRAVITY: 26.0,          // blocks/s^2 at full strength
    SUN_LIGHT_LEVEL: 15,
    LIGHT_MAX: 15,
    /** Voxel below this radial index is never solid; it is the open interior. */
    R_SHELL_MIN: R_SURFACE - SURFACE_AMP - 8,
  };
})());

/* ================================================================== *
 * Theta / index helpers
 * ================================================================== */

/** Wrap an angular index onto [0, THETA_COUNT). */
export function wrapTheta(i) {
  const n = WORLD.THETA_COUNT;
  const m = i % n;
  return m < 0 ? m + n : m;
}

/** Wrap an axial index onto [0, WORLD_Z) — returns -1 if outside the tube. */
export function wrapAxial(k) {
  if (k < 0 || k >= WORLD.WORLD_Z) return -1;
  return k;
}

/** Angle (radians) of the *centre* of angular column i. */
export function thetaOf(i) {
  return (i + 0.5) * WORLD.D_THETA;
}

/**
 * Arc length spanned by one angular voxel at radius r.
 *
 * UNRESOLVED(geometry): this is the one genuine geometric wart of a
 * cylindrical voxel grid.  The angular column is a fixed angle, so the voxel's
 * tangential width is D_THETA * r — one unit at the surface, but shrinking
 * linearly toward the axis and growing beyond the crust.  At the surface the
 * voxels are essentially cubic (D_THETA * R_SURFACE = 0.9986), which is why
 * R_SURFACE and THETA_COUNT are tied together.
 *
 * The proper fix is multi-resolution rings: double THETA_COUNT at each
 * halving of radius so arc length stays constant, at the cost of a mesher
 * that has to stitch 1:2 and 1:4 faces between rings.  Not implemented.
 * All ERNAS terrain lives in the thin shell near R_SURFACE where the aspect
 * ratio is within a few percent of 1, so it does not bite yet — but anything
 * built down near the axis (pylons in the deadzone, the sun biome) will show
 * visibly thin voxels.
 */
export function arcWidthAt(r) {
  return WORLD.D_THETA * r;
}

/* ================================================================== *
 * Coordinate conversion
 * ================================================================== */

/**
 * Exact cylindrical -> Cartesian.  `out` is [x, y, z].
 * theta in radians, r in voxels, z in voxels.
 */
export function cylindricalToCartesian(theta, r, z, out) {
  out[0] = Math.cos(theta) * r;
  out[1] = Math.sin(theta) * r;
  out[2] = z;
  return out;
}

/** Cartesian -> cylindrical.  `out` is [theta, r, z] with theta in [0, 2pi). */
export function cartesianToCylindrical(x, y, z, out) {
  let t = Math.atan2(y, x);
  if (t < 0) t += Math.PI * 2;
  out[0] = t;
  out[1] = Math.hypot(x, y);
  out[2] = z;
  return out;
}

/** Cartesian -> fractional tube-grid coordinate [i, j, k]. */
export function cartesianToVoxel(x, y, z, out) {
  const r = Math.hypot(x, y);
  let t = Math.atan2(y, x);
  if (t < 0) t += Math.PI * 2;
  out[0] = t / WORLD.D_THETA;
  out[1] = r;
  out[2] = z;
  return out;
}

/**
 * Centre of voxel (i, j, k) in Cartesian space.
 * Uses the column's centre angle and the cell's centre radius/height.
 */
export function voxelCenter(i, j, k, out) {
  return cylindricalToCartesian(thetaOf(i), j + 0.5, k + 0.5, out);
}

/** The corner (ci, cj, ck) each in {0,1} of voxel (i, j, k), in Cartesian. */
export function voxelCorner(i, j, k, ci, cj, ck, out) {
  return cylindricalToCartesian((i + ci) * WORLD.D_THETA, j + cj, k + ck, out);
}

/* ================================================================== *
 * Local orientation basis
 * ================================================================== *
 * On the inside of a tube there is no global "up".  Every position has its
 * own basis:
 *   radial    r-hat : points away from the axis  == DOWN
 *   tangential t-hat: direction of increasing theta
 *   axial     z-hat : along the tube
 * The player's up vector is -r-hat.
 */

/** Unit radial (outward) vector at angle theta. */
export function radialBasis(theta, out) {
  out[0] = Math.cos(theta);
  out[1] = Math.sin(theta);
  out[2] = 0;
  return out;
}

/** Unit tangential (counter-clockwise) vector at angle theta. */
export function tangentialBasis(theta, out) {
  out[0] = -Math.sin(theta);
  out[1] = Math.cos(theta);
  out[2] = 0;
  return out;
}

/**
 * Full local frame at a Cartesian position.
 * Fills `out` as a flat 9-float row-major basis: [t-hat, up, z-hat].
 * This is the camera/player basis: X = tangential, Y = up (inward), Z = axial.
 */
export function localFrameAt(x, y, out) {
  const r = Math.hypot(x, y) || 1;
  const rx = x / r, ry = y / r;
  // tangential (right-handed about +Z)
  out[0] = -ry; out[1] = rx; out[2] = 0;
  // up = -radial (toward the axis)
  out[3] = -rx; out[4] = -ry; out[5] = 0;
  // axial
  out[6] = 0; out[7] = 0; out[8] = 1;
  return out;
}

/* ================================================================== *
 * Gravity
 * ================================================================== *
 * Gravity radiates OUTWARD from the central axis toward the iron shell.
 *
 * UNRESOLVED(physics): a uniform infinite cylindrical shell produces *zero*
 * net gravitational field anywhere inside it (the 2-D analogue of Newton's
 * shell theorem).  So "gravity from the shell" cannot be real; ERNAS's tube
 * gravity is an authored field, not a simulated one.  That is fine — but it
 * means the profile below is a design decision, and it is the reason the sun
 * biome can float at the axis in a zero-g deadzone.
 *
 * Profile:
 *   r <= R_DEADZONE                     0.0     (the sun's deadzone)
 *   R_DEADZONE < r < R_GRAV_FULL        smoothstep ramp 0 -> 1
 *   r >= R_GRAV_FULL                    1.0
 *
 * `smoothstep` (3t^2 - 2t^3) rather than linear so that a player drifting out
 * of the deadzone accelerates smoothly instead of being jerked.
 */

/** Scalar gravity multiplier [0,1] at radius r. */
export function gravityScaleAt(r) {
  if (r <= WORLD.R_DEADZONE) return 0;
  if (r >= WORLD.R_GRAV_FULL) return 1;
  const t = (r - WORLD.R_DEADZONE) / (WORLD.R_GRAV_FULL - WORLD.R_DEADZONE);
  return t * t * (3 - 2 * t);
}

/**
 * Gravity acceleration vector (blocks/s^2) at a Cartesian position,
 * written into `out`.  Magnitude is WORLD.GRAVITY * gravityScaleAt(r).
 */
export function gravityVectorAt(x, y, out) {
  const r = Math.hypot(x, y);
  const g = WORLD.GRAVITY * gravityScaleAt(r);
  if (r < 1e-9) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  out[0] = (x / r) * g;
  out[1] = (y / r) * g;
  out[2] = 0;
  return out;
}

/** "Up" (anti-gravity) unit vector at a Cartesian position. */
export function upVectorAt(x, y, out) {
  const r = Math.hypot(x, y);
  if (r < 1e-9) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
  out[0] = -x / r;
  out[1] = -y / r;
  out[2] = 0;
  return out;
}

/** True while inside the sun's zero-gravity deadzone. */
export function inDeadzone(r) {
  return r <= WORLD.R_DEADZONE;
}

/** True while inside the sun sphere itself (the perfect geometric solid). */
export function inSun(r) {
  return r <= WORLD.R_SUN;
}

/**
 * Sun illumination falloff with radius.  1.0 next to the sun, decaying across
 * the interior volume.  Used by the renderer for ambient tint and by the
 * lighting pass for the intensity that reaches the inner surface.
 * Inverse-square would fall off far too hard over 1300 voxels, so this is a
 * hand-authored curve: bright core, long slow tail.
 */
export function sunIntensityAt(r) {
  if (r <= WORLD.R_SUN) return 1;
  const t = (r - WORLD.R_SUN) / (WORLD.R_SURFACE - WORLD.R_SUN);
  return 1 / (1 + 3.2 * t * t);
}

/* ================================================================== *
 * Chunk indexing
 * ================================================================== */

/** Tube-grid coordinate -> chunk coordinate. */
export function toChunkIndex(i, j, k) {
  return [Math.floor(i / WORLD.CHUNK), Math.floor(j / WORLD.CHUNK), Math.floor(k / WORLD.CHUNK)];
}

/**
 * Pack a chunk coordinate into one integer key.
 * Theta chunks wrap modulo THETA_COUNT/CHUNK; radial and axial are signed but
 * bounded by the world, so 12 bits each is plenty.
 */
export const THETA_CHUNKS = WORLD.THETA_COUNT / WORLD.CHUNK;   // 512
export const Z_CHUNKS = WORLD.WORLD_Z / WORLD.CHUNK;           // 128

export function chunkKey(ci, cj, ck) {
  const tw = ((ci % THETA_CHUNKS) + THETA_CHUNKS) % THETA_CHUNKS;
  // radial index is offset so it is non-negative: shell starts around j=1232
  const jr = (cj + 1024) & 2047;
  const kz = ((ck % Z_CHUNKS) + Z_CHUNKS) % Z_CHUNKS;
  return (tw << 22) | (jr << 11) | kz;
}

export function unpackChunkKey(key) {
  const kz = key & 2047;
  const jr = (key >>> 11) & 2047;
  const tw = (key >>> 22) & 1023;
  return [tw, jr - 1024, kz];
}

/* ================================================================== *
 * Voxel overrides (player edits)
 * ================================================================== *
 * Player edits are stored in a sparse Map keyed by a single number, not by an
 * array — JS Maps compare object keys by identity, so `[i,j,k]` keys would
 * never match on lookup.
 *
 * Bit layout (37 bits total, well inside the 53-bit exact-integer range of a
 * double, and Map compares numbers with SameValueZero):
 *
 *      bits  0..10   k   axial   11 bits  (< 2048 = WORLD_Z)
 *      bits 11..23   j   radial  13 bits  (< 8192, world peaks near 1450)
 *      bits 24..36   i   theta   13 bits  (< 8192 = THETA_COUNT)
 *
 * The first version of this gave `j` 14 bits, which pushed it into bit 24 and
 * collided with the low bit of `i`.  Every override then decoded to the wrong
 * voxel, so player edits were written to a phantom location.  The masks and
 * the shifts must agree exactly; `tests/cylinder.test.js` round-trips them.
 */

export function voxelKey(i, j, k) {
  return ((i & 8191) * 16777216) + ((j & 8191) * 2048) + (k & 2047);
}

export function unvoxelKey(key) {
  const k = key % 2048;
  const j = Math.floor(key / 2048) % 8192;
  const i = Math.floor(key / 16777216) % 8192;
  return [i, j, k];
}

/** Tube-grid voxel coordinate -> flat index inside its 16^3 chunk. */
export function localIndex(li, lj, lk) {
  return li + WORLD.CHUNK * (lj + WORLD.CHUNK * lk);
}
