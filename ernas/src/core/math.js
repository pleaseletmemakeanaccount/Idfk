/**
 * ERNAS ENGINE — core/math.js
 * =====================================================================
 *  Minimal column-major mat4 / vec3, matching WebGL's layout.
 * =====================================================================
 *
 * Only what the renderer needs: perspective, look-at, multiply, inverse, and
 * frustum plane extraction for chunk culling.  No general-purpose library,
 * because a tube world only ever needs these and a dependency here would be
 * the largest thing in the engine.
 */

export function mat4() {
  return new Float32Array(16);
}

export function identity(out) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

/**
 * Look-at.  `up` must not be parallel to the view direction.
 *
 * NOTE for the tube: the caller must pass the *local* up (-radial), not a
 * global up.  There is no global up inside a cylinder.
 */
export function lookAt(out, eye, center, up) {
  let zx = eye[0] - center[0];
  let zy = eye[1] - center[1];
  let zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz);
  if (len < 1e-9) { zz = 1; len = 1; }
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-9) { xx = 1; xy = 0; xz = 0; }
  else { xx /= len; xy /= len; xz /= len; }

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

export function multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/**
 * The six frustum planes in world space, as [a,b,c,d] with ax+by+cz+d >= 0
 * meaning "inside".  Extracted from the combined view-projection matrix using
 * the Gribb/Hartmann method.
 */
export function frustumPlanes(vp, out) {
  const m = vp;
  const rows = [
    [m[0], m[4], m[8], m[12]],
    [m[1], m[5], m[9], m[13]],
    [m[2], m[6], m[10], m[14]],
    [m[3], m[7], m[11], m[15]],
  ];
  const defs = [
    [3, 0, 1],  // left   = row3 + row0
    [3, 0, -1], // right  = row3 - row0
    [3, 1, 1],  // bottom
    [3, 1, -1], // top
    [3, 2, 1],  // near
    [3, 2, -1], // far
  ];
  for (let p = 0; p < 6; p++) {
    const [a, b, s] = defs[p];
    let x = rows[a][0] + s * rows[b][0];
    let y = rows[a][1] + s * rows[b][1];
    let z = rows[a][2] + s * rows[b][2];
    let w = rows[a][3] + s * rows[b][3];
    const len = Math.hypot(x, y, z) || 1;
    out[p * 4] = x / len;
    out[p * 4 + 1] = y / len;
    out[p * 4 + 2] = z / len;
    out[p * 4 + 3] = w / len;
  }
  return out;
}

/** True when a sphere is at least partially inside all six planes. */
export function sphereInFrustum(planes, cx, cy, cz, r) {
  for (let p = 0; p < 6; p++) {
    const d = planes[p * 4] * cx + planes[p * 4 + 1] * cy + planes[p * 4 + 2] * cz + planes[p * 4 + 3];
    if (d < -r) return false;
  }
  return true;
}

export function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
