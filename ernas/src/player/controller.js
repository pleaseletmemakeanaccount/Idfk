/**
 * ERNAS ENGINE — player/controller.js
 * =====================================================================
 *  First-person avatar for the inverted cylinder.
 * =====================================================================
 *
 * THE ONE THING THAT IS DIFFERENT HERE
 * ------------------------------------
 * There is no global up.  Every position has its own: up = -r-hat, pointing
 * at the tube's axis.  So the camera basis is rebuilt from the player's
 * position every frame, and yaw/pitch are relative to that local frame rather
 * than to any world axis.
 *
 *   e1 = tangential (t-hat)    e2 = axial (z-hat)    n = up = -r-hat
 *
 *   forward(yaw) = cos(yaw) * e2 + sin(yaw) * right0
 *   right0       = -t-hat
 *
 * The sign on right0 is not cosmetic: with right0 = +t-hat the basis comes out
 * left-handed and the view matrix flips the world inside-out.
 *
 * Walking "straight ahead" therefore traces a helix or a circle around the
 * tube, which is the correct behaviour and the entire point of the geometry.
 *
 * UNRESOLVED(player): this is the base locomotion only.  The spec's Moth
 * Avatar has a limb-damage array (Head, Torso, L/R Wings, L/R Legs, L/R Eyes)
 * where flight capacity scales with limb integrity, dismemberment is permanent
 * per run, and losing both legs forces a prone rolling state.  None of that is
 * implemented.  What is here — local-frame movement, radial gravity, collision
 * — is the substrate those systems would read and write.
 */

import {
  WORLD, gravityScaleAt,
  cartesianToVoxel, cylindricalToCartesian,
} from "../world/cylinderGeometry.js";
import { isSolid, BLOCK } from "../world/blocks.js";

const EYE_HEIGHT = 1.62;
const BODY_HALF = 0.30;
const BODY_HEIGHT = 1.80;

export class MothPlayer {
  /** @param {import("../world/world.js").World} world */
  constructor(world) {
    this.world = world;
    this.pos = [0, 0, 0];       // feet, Cartesian
    /**
     * Velocity in the LOCAL frame: [tangential, axial, radial].
     *
     * Deliberately not Cartesian.  On the inside of a cylinder, a straight
     * Cartesian step is a chord, and a chord of the inner surface passes
     * *through* the floor — resolving movement along the world x/y axes
     * therefore wedges the player into the ground within a few frames (they
     * moved 3 blocks in 10 seconds before this was fixed).  Moving along
     * t-hat and z-hat keeps the radius exactly constant, so walking along the
     * inner wall no longer sinks.
     */
    this.vel = [0, 0, 0];
    this.yaw = 0;               // radians about local up
    this.pitch = 0;             // radians about local right
    this.onGround = false;
    this.creative = false;      // spec: unrestricted flight + instant mining
    this.walkSpeed = 5.2;
    this.flySpeed = 22.0;
    this.jumpSpeed = 8.4;

    // Reused scratch, so update() allocates nothing.
    this._r = [0, 0, 0];
    this._t = [0, 0, 0];
    this._up = [0, 0, 0];
    this._g = [0, 0, 0];
    this._cyl = [0, 0, 0];
    this._vox = [0, 0, 0];
  }

  /* ---------------------------------------------------------------- *
   * Frames
   * ---------------------------------------------------------------- */

  /** Local basis at the player's current position. */
  basis() {
    const r = Math.hypot(this.pos[0], this.pos[1]) || 1;
    this._r[0] = this.pos[0] / r; this._r[1] = this.pos[1] / r; this._r[2] = 0;
    this._t[0] = -this._r[1]; this._t[1] = this._r[0]; this._t[2] = 0;
    this._up[0] = -this._r[0]; this._up[1] = -this._r[1]; this._up[2] = 0;
    return { radial: this._r, tangential: this._t, up: this._up };
  }

  /** Horizontal forward (no pitch), in Cartesian. */
  forwardHorizontal(out) {
    const { tangential } = this.basis();
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    // right0 = -tangential
    out[0] = c * 0 + s * -tangential[0];
    out[1] = c * 0 + s * -tangential[1];
    out[2] = c;                       // axial component
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
  }

  /**
   * Horizontal right, in Cartesian.
   *
   * This must be `forward x up`, NOT `up x forward`.  lookAt builds the
   * camera's x axis as cross(up, -forward) = cross(forward, up), so using the
   * other order makes pressing D strafe left.  It is the kind of bug that is
   * invisible in a unit test and immediately obvious the first time you play.
   */
  rightHorizontal(out) {
    const f = this.forwardHorizontal([0, 0, 0]);
    const { up } = this.basis();
    out[0] = f[1] * up[2] - f[2] * up[1];
    out[1] = f[2] * up[0] - f[0] * up[2];
    out[2] = f[0] * up[1] - f[1] * up[0];
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
  }

  /** Full view direction including pitch. */
  viewDir(out) {
    const f = this.forwardHorizontal([0, 0, 0]);
    const { up } = this.basis();
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    out[0] = cp * f[0] + sp * up[0];
    out[1] = cp * f[1] + sp * up[1];
    out[2] = cp * f[2] + sp * up[2];
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
  }

  eye() {
    const { up } = this.basis();
    return [
      this.pos[0] + up[0] * EYE_HEIGHT,
      this.pos[1] + up[1] * EYE_HEIGHT,
      this.pos[2] + up[2] * EYE_HEIGHT,
    ];
  }

  target() {
    const e = this.eye();
    const d = this.viewDir([0, 0, 0]);
    return [e[0] + d[0], e[1] + d[1], e[2] + d[2]];
  }

  upVector() {
    const { up } = this.basis();
    return [up[0], up[1], up[2]];
  }

  /* ---------------------------------------------------------------- *
   * Spawning
   * ---------------------------------------------------------------- */

  /** Drop the player onto the inner surface at theta = 0. */
  spawn(thetaIndex = 0, k = WORLD.WORLD_Z / 2) {
    const i = thetaIndex | 0;
    const h = Math.ceil(this.world.terrain.surfaceRadius(i, k));
    const theta = (i + 0.5) * WORLD.D_THETA;
    // Feet one voxel inboard of the surface (smaller radius = higher up).
    cylindricalToCartesian(theta, h - 0.02, k + 0.5, this.pos);
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    // Nudge out of the ground if the surface voxel is solid at the feet.
    for (let n = 0; n < 8 && this.collides(this.pos[0], this.pos[1], this.pos[2]); n++) {
      const { up } = this.basis();
      this.pos[0] += up[0] * 0.5;
      this.pos[1] += up[1] * 0.5;
      this.pos[2] += up[2] * 0.5;
    }
    return this.pos;
  }

  /* ---------------------------------------------------------------- *
   * Collision
   * ---------------------------------------------------------------- */

  /**
   * AABB overlap test against the voxel grid.
   *
   * The box is axis-aligned in the *local* frame (tangential x axial x radial),
   * which is what the player experiences as a box.  In Cartesian space it is a
   * slightly warped prism, but over 1.8 voxels the difference is well under a
   * percent.
   */
  collides(px, py, pz) {
    const r = Math.hypot(px, py) || 1;
    const rx = px / r, ry = py / r;
    const tx = -ry, ty = rx;

    // Sample the 8 corners plus the 4 vertical edge midpoints.  Corners alone
    // let a thin wall slip through the middle of a face.
    for (let ci = 0; ci < 12; ci++) {
      const st = CORNERS[ci * 3];
      const sz = CORNERS[ci * 3 + 1];
      const sr = CORNERS[ci * 3 + 2];
      const x = px + tx * st + sr * rx;
      const y = py + ty * st + sr * ry;
      const z = pz + sz;
      cartesianToVoxel(x, y, z, this._vox);
      const i = Math.floor(this._vox[0]);
      const j = Math.floor(this._vox[1]);
      const k = Math.floor(this._vox[2]);
      if (isSolid(this.world.getBlock(i, j, k))) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- *
   * Step
   * ---------------------------------------------------------------- */

  /**
   * Attempt a horizontal move, with step-up assist.
   *
   * Voxel terrain is full of one-block ledges, and without this the player
   * stops dead at every single one — walking across the tube felt like pushing
   * into invisible walls.  If the plain move is blocked, retry it raised by up
   * to one block, but only if there is something to stand on at the top.  That
   * last condition matters: without it the player could step up onto the side
   * of a floating block and stand on nothing.
   *
   * @returns {boolean} true if the move was accepted
   */
  _tryStep(from, dx, dy, dz, up) {
    const nx = from[0] + dx, ny = from[1] + dy, nz = from[2] + dz;
    if (!this.collides(nx, ny, nz)) {
      this.pos[0] = nx; this.pos[1] = ny; this.pos[2] = nz;
      return true;
    }
    for (let s = 0; s < STEP_HEIGHTS.length; s++) {
      const h = STEP_HEIGHTS[s];
      const rx = nx + up[0] * h, ry = ny + up[1] * h, rz = nz + up[2] * h;
      if (this.collides(rx, ry, rz)) continue;
      // Require ground under the landing spot.
      const { radial } = this.basis();
      if (!this.collides(rx + radial[0] * 0.15, ry + radial[1] * 0.15, rz)) continue;
      this.pos[0] = rx; this.pos[1] = ry; this.pos[2] = rz;
      return true;
    }
    return false;
  }

  /**
   * @param {number} dt seconds
   * @param {{f:number,b:number,l:number,r:number,jump:boolean,up:boolean,down:boolean}} input
   */
  update(dt, input) {
    dt = Math.min(dt, 0.05);           // clamp: a stalled tab must not teleport
    const { radial, tangential } = this.basis();

    const f = this.forwardHorizontal([0, 0, 0]);
    const rt = this.rightHorizontal([0, 0, 0]);

    let mx = (input.r ?? 0) - (input.l ?? 0);
    let mz = (input.f ?? 0) - (input.b ?? 0);
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }

    const speed = this.creative ? this.flySpeed : this.walkSpeed;

    // Wish velocity in Cartesian, then projected onto the local frame.
    const wx = (f[0] * mz + rt[0] * mx) * speed;
    const wy = (f[1] * mz + rt[1] * mx) * speed;
    const wz = (f[2] * mz + rt[2] * mx) * speed;
    let vT = wx * tangential[0] + wy * tangential[1];
    let vZ = wz;
    let vR = this.vel[2];

    if (this.creative) {
      // Free flight: no inertia, no gravity, direct control on all three axes.
      const vy = ((input.up ? 1 : 0) - (input.down ? 1 : 0)) * speed;
      vR = -vy;                        // "up" for the player is -radial
      this.onGround = false;
    } else {
      const g = WORLD.GRAVITY * gravityScaleAt(Math.hypot(this.pos[0], this.pos[1]));
      vR += g * dt;
      if (input.jump && this.onGround) {
        vR = -this.jumpSpeed;          // push toward the axis
        this.onGround = false;
      }
    }

    this.vel[0] = vT;
    this.vel[1] = vZ;
    this.vel[2] = vR;

    /*
     * Integrate one local axis at a time, recomputing the basis between the
     * tangential and radial steps (the tangential step changes the player's
     * angle, so t-hat and r-hat have both rotated).  Per-axis resolution is
     * what lets the player slide along a wall instead of sticking to it.
     */
    this.onGround = false;
    // Recomputed once here: the basis only depends on the player's angle, and
    // every sub-step below re-derives it if the angle changed.  Note `up2` is
    // -radial; passing the radial vector to the step assist pushes the player
    // further INTO the floor instead of over the ledge.
    const { radial: r2, up: up2 } = this.basis();

    // 1. tangential — constant radius, so it cannot sink into the floor
    if (vT !== 0) {
      const step = vT * dt;
      const ok = this._tryStep(this.pos, tangential[0] * step, tangential[1] * step, 0, up2);
      if (!ok) this.vel[0] = 0;
    }

    // 2. axial — parallel to the tube, also constant radius
    if (this.vel[1] !== 0) {
      const ok = this._tryStep(this.pos, 0, 0, this.vel[1] * dt, up2);
      if (!ok) this.vel[1] = 0;
    }

    // 3. radial — this is "vertical".  Re-derive the basis, since the
    // tangential step above may have moved the player around the tube.
    const { radial: r3 } = this.basis();
    if (this.vel[2] !== 0) {
      const step = this.vel[2] * dt;
      const np = [
        this.pos[0] + r3[0] * step,
        this.pos[1] + r3[1] * step,
        this.pos[2],
      ];
      if (this.collides(np[0], np[1], np[2])) {
        // Blocked while moving outward means we are standing on something.
        if (this.vel[2] > 0) this.onGround = true;
        this.vel[2] = 0;
      } else {
        this.pos[0] = np[0];
        this.pos[1] = np[1];
      }
    }

    /*
     * Ground probe.  Inferring "on ground" from a blocked axis is unreliable
     * on a curved floor — the probe is unambiguous.
     */
    if (!this.creative && !this.onGround) {
      this.onGround = this.collides(
        this.pos[0] + r3[0] * 0.08,
        this.pos[1] + r3[1] * 0.08,
        this.pos[2],
      );
    }

    // Inside the deadzone there is no gravity and no ground; drift freely.
    const r = Math.hypot(this.pos[0], this.pos[1]);
    this.inDeadzone = gravityScaleAt(r) === 0;

    // Hard floor: never let the player fall through the crust into the void.
    if (r > WORLD.R_CRUST - 2) {
      const s = (WORLD.R_CRUST - 2) / r;
      this.pos[0] *= s;
      this.pos[1] *= s;
      this.vel[2] = 0;
    }
    void radial;
  }

  /** Tube coordinates of the player's feet, for the HUD. */
  tubeCoords() {
    const r = Math.hypot(this.pos[0], this.pos[1]);
    let t = Math.atan2(this.pos[1], this.pos[0]);
    if (t < 0) t += Math.PI * 2;
    return {
      i: Math.floor(t / WORLD.D_THETA),
      j: Math.floor(r),
      k: Math.floor(this.pos[2]),
      radius: r,
      thetaDeg: (t * 180) / Math.PI,
    };
  }
}

/**
 * Sample offsets in the local frame: (tangential, axial, radial).
 * Radial runs from 0 (feet) to -BODY_HEIGHT (head), because up is -radial.
 * The last four entries are the vertical edge midpoints.
 */
/** Step-up assist heights, tried in order.  Just over one voxel is the max. */
const STEP_HEIGHTS = Float64Array.from([0.55, 1.05]);

const CORNERS = Float32Array.from([
  -BODY_HALF, -BODY_HALF, 0,
  BODY_HALF, -BODY_HALF, 0,
  -BODY_HALF, BODY_HALF, 0,
  BODY_HALF, BODY_HALF, 0,
  -BODY_HALF, -BODY_HALF, -BODY_HEIGHT,
  BODY_HALF, -BODY_HALF, -BODY_HEIGHT,
  -BODY_HALF, BODY_HALF, -BODY_HEIGHT,
  BODY_HALF, BODY_HALF, -BODY_HEIGHT,
  -BODY_HALF, -BODY_HALF, -BODY_HEIGHT * 0.5,
  BODY_HALF, -BODY_HALF, -BODY_HEIGHT * 0.5,
  -BODY_HALF, BODY_HALF, -BODY_HEIGHT * 0.5,
  BODY_HALF, BODY_HALF, -BODY_HEIGHT * 0.5,
]);

export { EYE_HEIGHT, BODY_HALF, BODY_HEIGHT, BLOCK };
