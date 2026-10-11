/**
 * ERNAS ENGINE — world/mesher.js
 * =====================================================================
 *  Voxel -> triangles, with cylindrical normals and ambient occlusion.
 * =====================================================================
 *
 * Two things make this mesher different from a cubic-world mesher:
 *
 * 1. VERTICES ARE CARTESIAN, TOPOLOGY IS CYLINDRICAL.
 *    Neighbour tests happen in tube coordinates (i+-1, j+-1, k+-1) but the
 *    emitted corner positions are (r cos theta, r sin theta, z).  A face is
 *    therefore a planar quad whose four corners do not all share a radius,
 *    which is what makes the tube curve instead of looking faceted at the
 *    chunk scale.
 *
 * 2. "UP" IS THE AXIS.
 *    The face pointing at the axis (FACE.INNER) is the one the player stands
 *    on and the one the sun hits.  It gets the brightest shade and the block's
 *    top tint.  The face pointing away (FACE.OUTER) is a ceiling or a floor
 *    seen from below and gets the darkest.
 *
 * Output per chunk:
 *   positions  Float32Array  3 floats/vertex, Cartesian
 *   attrs      Uint8Array    4 bytes/vertex  [r, g, b, brightness]
 *   indices    Uint32Array   6 per face
 *
 * UNRESOLVED(meshing): this is a naive per-face mesher.  A 16^3 chunk of
 * exposed surface produces ~4 vertices per face with no greedy merging, so a
 * flat plain costs 4x the vertices it needs.  Greedy meshing in a cylindrical
 * grid is possible but the merged quads stop being planar (they become
 * annular sectors), so they need a curved tessellation or a shader that
 * re-projects them.  Not implemented; at a streaming radius of 4-5 chunks the
 * naive mesh is comfortably within budget.
 */

import { WORLD } from "./cylinderGeometry.js";
import { CHUNK_SIZE } from "./chunk.js";
import { BLOCK, FACE, blockColor, isOpaque, faceVisible } from "./blocks.js";
import { hash3 } from "../core/rng.js";

const C = CHUNK_SIZE;
const PAD = 2;                    // AO reaches two voxels out from a face
const E = C + PAD * 2;            // padded edge length

/**
 * Face table.  `corners` lists the four (ci, cj, ck) voxel corners in the
 * order they are emitted; the winding is asserted by tests/cylinder.test.js
 * against each face's geometric normal, so a mistake here fails loudly
 * instead of silently rendering inside-out geometry.
 */
/**
 * Face table.  `corners` lists the four (ci, cj, ck) voxel corners in the
 * order they are emitted.
 *
 * The winding here was wrong on ALL SIX faces in the first draft — every quad
 * was emitted clockwise, which with backface culling on would have rendered
 * the entire world invisible from inside the tube.  It is now verified by
 * `tests/cylinder.test.js` ("every face type is wound counter-clockwise seen
 * from outside"), which computes cross(B-A, C-A) . normal for each face at a
 * representative voxel and requires it to be positive.  Do not reorder these
 * arrays without that test in front of you.
 */
export const FACES = Object.freeze([
  {
    name: "inner", axis: 1, dir: -1, kind: FACE.INNER, shade: 1.00,
    corners: [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]],
  },
  {
    name: "outer", axis: 1, dir: 1, kind: FACE.OUTER, shade: 0.50,
    corners: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
  },
  {
    name: "theta-", axis: 0, dir: -1, kind: FACE.SIDE, shade: 0.72,
    corners: [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]],
  },
  {
    name: "theta+", axis: 0, dir: 1, kind: FACE.SIDE, shade: 0.72,
    corners: [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]],
  },
  {
    name: "z-", axis: 2, dir: -1, kind: FACE.SIDE, shade: 0.86,
    corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
  },
  {
    name: "z+", axis: 2, dir: 1, kind: FACE.SIDE, shade: 0.86,
    corners: [[0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]],
  },
]);

/** AO multipliers indexed by AO level 0..3. */
const AO_CURVE = [0.44, 0.64, 0.83, 1.0];

/** Padded scratch cube, reused across chunks to avoid GC churn. */
const cube = new Uint8Array(E * E * E);
const lightCube = new Uint8Array(E * E * E);

function cidx(pi, pj, pk) {
  return (pi + PAD) + E * ((pj + PAD) + E * (pk + PAD));
}

/**
 * Mesh one chunk.
 * @param {import("./world.js").World} world
 * @param {import("./chunk.js").Chunk} chunk
 * @returns {{positions: Float32Array, attrs: Uint8Array, indices: Uint32Array,
 *            vertexCount: number, faceCount: number}|null} null when the
 *            chunk has no visible surface at all.
 */
export function meshChunk(world, chunk) {
  const i0 = chunk.originI;
  const j0 = chunk.originJ;
  const k0 = chunk.originK;

  /* ---- load the padded neighbourhood ------------------------------ */
  for (let pk = -PAD; pk < C + PAD; pk++) {
    const k = k0 + pk;
    for (let pj = -PAD; pj < C + PAD; pj++) {
      const j = j0 + pj;
      for (let pi = -PAD; pi < C + PAD; pi++) {
        const i = i0 + pi;
        const idx = cidx(pi, pj, pk);
        cube[idx] = world.getBlock(i, j, k);
        lightCube[idx] = world.lightAt(i, j, k);
      }
    }
  }

  const positions = [];
  const attrs = [];
  const indices = [];
  let vertex = 0;
  let faceCount = 0;

  /* ---- precompute the 17 theta boundaries of this chunk ------------ */
  const cosT = cosScratch, sinT = sinScratch;
  for (let t = 0; t <= C; t++) {
    const ang = (i0 + t) * WORLD.D_THETA;
    cosT[t] = Math.cos(ang);
    sinT[t] = Math.sin(ang);
  }

  for (let lk = 0; lk < C; lk++) {
    for (let lj = 0; lj < C; lj++) {
      for (let li = 0; li < C; li++) {
        const id = cube[cidx(li, lj, lk)];
        if (id === BLOCK.AIR) continue;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const ni = li + (face.axis === 0 ? face.dir : 0);
          const nj = lj + (face.axis === 1 ? face.dir : 0);
          const nk = lk + (face.axis === 2 ? face.dir : 0);
          const nId = cube[cidx(ni, nj, nk)];
          if (!faceVisible(id, nId)) continue;

          const light = lightCube[cidx(li, lj, lk)];
          const [br, bg, bb] = blockColor(id, face.kind);

          // Per-voxel tint jitter: keeps large flat areas from reading as a
          // single flat polygon, which is most of the "8-bit" look.
          const h = hash3(i0 + li, j0 + lj, k0 + lk, 0x2f6b1d);
          const jitter = 0.90 + ((h & 255) / 255) * 0.20;
          const cr = clamp255(br * jitter);
          const cg = clamp255(bg * jitter);
          const cb = clamp255(bb * jitter);

          const base = vertex;
          const r0 = j0 + lj;
          const r1 = r0 + 1;

          // Ambient occlusion has to be known for all four corners before the
          // indices are written, because the quad's diagonal is chosen from it.
          const ao0 = computeAO(face, face.corners[0][0], face.corners[0][1], face.corners[0][2], li, lj, lk);
          const ao1 = computeAO(face, face.corners[1][0], face.corners[1][1], face.corners[1][2], li, lj, lk);
          const ao2 = computeAO(face, face.corners[2][0], face.corners[2][1], face.corners[2][2], li, lj, lk);
          const ao3 = computeAO(face, face.corners[3][0], face.corners[3][1], face.corners[3][2], li, lj, lk);
          const aos = aoScratch;
          aos[0] = ao0; aos[1] = ao1; aos[2] = ao2; aos[3] = ao3;

          for (let v = 0; v < 4; v++) {
            const ci = face.corners[v][0];
            const cj = face.corners[v][1];
            const ck = face.corners[v][2];
            const px = (ci === 0 ? cosT[li] : cosT[li + 1]) * (cj === 0 ? r0 : r1);
            const py = (ci === 0 ? sinT[li] : sinT[li + 1]) * (cj === 0 ? r0 : r1);
            const pz = k0 + lk + ck;
            positions.push(px, py, pz);

            const bright = (0.06 + 0.94 * (light / WORLD.LIGHT_MAX)) * face.shade * AO_CURVE[aos[v]];
            attrs.push(cr, cg, cb, clamp255(bright));
            vertex++;
          }

          /*
           * Two triangles, with the diagonal chosen from the AO values.
           *
           * To be precise about what this does and does not buy: linear
           * interpolation across a quad has the SAME magnitude of error
           * against the true bilinear AO field whichever diagonal you pick —
           * only the sign flips.  So this is not "more correct", it is a
           * data-driven tie-break.  What it fixes is consistency: with a fixed
           * diagonal, neighbouring quads whose dark corners sit on opposite
           * diagonals shade against each other and a visible crease runs
           * across the surface.  Picking the diagonal from the data makes
           * adjacent quads agree far more often.
           *
           * Both index patterns keep the 0,1,2,3 winding, so flipping the
           * diagonal cannot turn a face inside-out.
           */
          if (ao0 + ao2 > ao1 + ao3) {
            indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
          } else {
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
          faceCount++;
        }
      }
    }
  }

  if (faceCount === 0) {
    chunk.faceCount = 0;
    chunk.vertexCount = 0;
    return null;
  }

  return {
    positions: Float32Array.from(positions),
    attrs: Uint8Array.from(attrs),
    indices: Uint32Array.from(indices),
    vertexCount: vertex,
    faceCount,
  };
}

/**
 * Ambient occlusion for one face corner.
 *
 * Standard voxel AO: look at the three voxels that touch this corner from the
 * outside of the face — the two edge neighbours and the diagonal one.  If both
 * edge neighbours are solid the corner is fully occluded; otherwise the count
 * of solid neighbours picks the AO level.
 */
function computeAO(face, ci, cj, ck, li, lj, lk) {
  const axis = face.axis;
  const t1 = axis === 0 ? 1 : 0;
  const t2 = axis === 2 ? 1 : 2;

  const corner = [ci, cj, ck];
  const o1 = corner[t1] === 0 ? -1 : 1;
  const o2 = corner[t2] === 0 ? -1 : 1;

  const base = [li, lj, lk];
  base[axis] += face.dir;

  const at = (a, b) => {
    const p = [base[0], base[1], base[2]];
    p[t1] += a; p[t2] += b;
    return isOpaque(cube[cidx(p[0], p[1], p[2])]) ? 1 : 0;
  };

  const s1 = at(o1, 0);
  const s2 = at(0, o2);
  const cn = at(o1, o2);
  return (s1 && s2) ? 0 : 3 - (s1 + s2 + cn);
}

function clamp255(v) {
  const x = (v * 255) | 0;
  return x < 0 ? 0 : (x > 255 ? 255 : x);
}

const cosScratch = new Float64Array(C + 1);
const sinScratch = new Float64Array(C + 1);
const aoScratch = new Uint8Array(4);

/**
 * Convenience: mesh a chunk and store the result on it.
 * @returns {boolean} true when a mesh was produced
 */
export function meshChunkInto(world, chunk) {
  const mesh = meshChunk(world, chunk);
  chunk.mesh = mesh;
  chunk.faceCount = mesh ? mesh.faceCount : 0;
  chunk.vertexCount = mesh ? mesh.vertexCount : 0;
  return !!mesh;
}
