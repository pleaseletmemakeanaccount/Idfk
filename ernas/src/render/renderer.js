/**
 * ERNAS ENGINE — render/renderer.js
 * =====================================================================
 *  WebGL2 renderer: sky, chunk meshes, the sun sphere.
 * =====================================================================
 *
 * Draw order:
 *   1. sky        — fullscreen pass, no depth write.  Interior atmosphere
 *                   plus the sun's disc and bloom, both computed analytically
 *                   from the view ray, so the sun stays a perfect circle at
 *                   any distance.
 *   2. chunks     — depth-tested, frustum-culled per chunk bounding sphere.
 *   3. sun sphere — a real geometric sphere at the axis.  Drawn after the
 *                   terrain so it can be occluded by mountains, which is the
 *                   whole point of it being geometry rather than a skybox dot.
 *
 * UNRESOLVED(renderer): chunk meshes are uploaded as three separate VBOs per
 * chunk with no instancing and no LOD.  At the demo's streaming radius that is
 * a few hundred draw calls, which is fine, but a real build wants (a) merged
 * chunk clusters, (b) LOD by radial distance — voxels near the axis subtend a
 * much smaller angle — and (c) the mesher moved to a Web Worker with
 * transferable ArrayBuffers.  None of that is here.
 */

import {
  CHUNK_VERT, CHUNK_FRAG, SKY_VERT, SKY_FRAG, SUN_VERT, SUN_FRAG,
} from "./shaders.js";
import { perspective, lookAt, multiply, frustumPlanes, sphereInFrustum, mat4 } from "../core/math.js";
import { WORLD } from "../world/cylinderGeometry.js";

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`${label} compile failed:\n${log}`);
  }
  return sh;
}

function link(gl, vsSrc, fsSrc, label) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, `${label}.vert`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, `${label}.frag`);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`${label} link failed:\n${log}`);
  }
  // Cache uniform locations once; glGetUniformLocation is not free.
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { program: p, uniforms };
}

/** UV sphere, used for the sun. */
function makeSphere(rings = 32, sectors = 48) {
  const pos = [];
  const idx = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= sectors; s++) {
      const th = (s / sectors) * Math.PI * 2;
      pos.push(
        Math.sin(phi) * Math.cos(th),
        Math.sin(phi) * Math.sin(th),
        Math.cos(phi),
      );
    }
  }
  const stride = sectors + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sectors; s++) {
      const a = r * stride + s;
      const b = a + stride;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint16Array.from(idx) };
}

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;

    this.chunkProg = link(gl, CHUNK_VERT, CHUNK_FRAG, "chunk");
    this.skyProg = link(gl, SKY_VERT, SKY_FRAG, "sky");
    this.sunProg = link(gl, SUN_VERT, SUN_FRAG, "sun");

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);

    /* fullscreen triangle for the sky */
    this.skyVao = gl.createVertexArray();
    gl.bindVertexArray(this.skyVao);
    const skyBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, skyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    /* sun sphere */
    const sphere = makeSphere();
    this.sunVao = gl.createVertexArray();
    gl.bindVertexArray(this.sunVao);
    const sPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, sPos);
    gl.bufferData(gl.ARRAY_BUFFER, sphere.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const sIdx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.sunIndexCount = sphere.indices.length;

    /** @type {Map<number, {vao:WebGLVertexArrayObject, count:number}>} */
    this.gpuChunks = new Map();

    this._vp = mat4();
    this._proj = mat4();
    this._view = mat4();
    this._planes = new Float32Array(24);

    this.stats = { drawn: 0, culled: 0, triangles: 0, uploaded: 0 };

    this.fogColor = [0.10, 0.12, 0.17];
    this.zenith = [0.42, 0.48, 0.62];
    this.nadir = [0.035, 0.04, 0.06];
    this.sunColor = [1.0, 0.86, 0.55];
    this.sunPos = [0, 0, 0];
    this.exposure = 1.0;
  }

  resize(width, height, dpr = 1) {
    const w = Math.max(1, Math.floor(width * dpr));
    const h = Math.max(1, Math.floor(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
    this.aspect = w / h;
  }

  /* ---------------------------------------------------------------- *
   * Chunk GPU resources
   * ---------------------------------------------------------------- */

  /** Upload (or replace) the GPU buffers for a chunk. */
  uploadChunk(chunk) {
    const gl = this.gl;
    this.disposeChunk(chunk);
    if (!chunk.mesh) return;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const ab = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ab);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.mesh.attrs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, chunk.mesh.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);

    this.gpuChunks.set(chunk.key, { vao, count: chunk.mesh.indices.length, pb, ab, ib });
    this.stats.uploaded++;
  }

  disposeChunk(chunk) {
    const gl = this.gl;
    const e = this.gpuChunks.get(chunk.key);
    if (!e) return;
    gl.deleteVertexArray(e.vao);
    gl.deleteBuffer(e.pb);
    gl.deleteBuffer(e.ab);
    gl.deleteBuffer(e.ib);
    this.gpuChunks.delete(chunk.key);
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  /**
   * @param {object} scene
   * @param {number[]} scene.eye     camera position, Cartesian
   * @param {number[]} scene.target  point the camera looks at
   * @param {number[]} scene.up      local up (-radial)
   * @param {number}   scene.fovY    vertical field of view, radians
   * @param {number}   scene.time    seconds since start
   * @param {Iterable} scene.chunks  resident chunks to consider drawing
   */
  render(scene) {
    const gl = this.gl;
    const { eye, target, up, fovY, time } = scene;

    perspective(this._proj, fovY, this.aspect ?? 1.6, 0.1, 4000);
    lookAt(this._view, eye, target, up);
    multiply(this._vp, this._proj, this._view);
    frustumPlanes(this._vp, this._planes);

    gl.clearColor(this.nadir[0], this.nadir[1], this.nadir[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this._drawSky(scene);
    this._drawChunks(scene);
    this._drawSun(scene, time);
  }

  _drawSky(scene) {
    const gl = this.gl;
    const { program, uniforms } = this.skyProg;
    gl.useProgram(program);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    // Forward/right/up from the view basis, so the sky needs no matrix inverse.
    const v = this._view;
    const fwd = [
      scene.target[0] - scene.eye[0],
      scene.target[1] - scene.eye[1],
      scene.target[2] - scene.eye[2],
    ];
    const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
    fwd[0] /= fl; fwd[1] /= fl; fwd[2] /= fl;
    const up = scene.up;
    let rx = up[1] * fwd[2] - up[2] * fwd[1];
    let ry = up[2] * fwd[0] - up[0] * fwd[2];
    let rz = up[0] * fwd[1] - up[1] * fwd[0];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    // true up, orthogonal to both
    const ux = fwd[1] * rz - fwd[2] * ry;
    const uy = fwd[2] * rx - fwd[0] * rz;
    const uz = fwd[0] * ry - fwd[1] * rx;
    void v;

    gl.uniform3fv(uniforms.uCamPos, scene.eye);
    gl.uniform3f(uniforms.uRight, rx, ry, rz);
    gl.uniform3f(uniforms.uUp, ux, uy, uz);
    gl.uniform3fv(uniforms.uForward, fwd);
    gl.uniform3fv(uniforms.uSunPos, this.sunPos);
    gl.uniform3fv(uniforms.uSunColor, this.sunColor);
    gl.uniform3fv(uniforms.uZenithColor, this.zenith);
    gl.uniform3fv(uniforms.uNadirColor, this.nadir);
    gl.uniform1f(uniforms.uAspect, this.aspect ?? 1.6);
    gl.uniform1f(uniforms.uTanHalfFov, Math.tan((scene.fovY ?? 1.2) / 2));
    gl.uniform1f(uniforms.uSunRadius, WORLD.R_SUN);
    gl.uniform1f(uniforms.uTime, scene.time);

    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  _drawChunks(scene) {
    const gl = this.gl;
    const { program, uniforms } = this.chunkProg;
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uViewProj, false, this._vp);
    gl.uniform3fv(uniforms.uCamPos, scene.eye);
    gl.uniform3fv(uniforms.uFogColor, this.fogColor);
    gl.uniform1f(uniforms.uFogNear, scene.fogNear ?? 90);
    gl.uniform1f(uniforms.uFogFar, scene.fogFar ?? 340);
    gl.uniform1f(uniforms.uExposure, this.exposure);

    let drawn = 0, culled = 0, tris = 0;
    for (const chunk of scene.chunks) {
      const e = this.gpuChunks.get(chunk.key);
      if (!e) continue;
      if (!sphereInFrustum(this._planes, chunk.centerX, chunk.centerY, chunk.centerZ, chunk.radius)) {
        culled++;
        continue;
      }
      gl.bindVertexArray(e.vao);
      gl.drawElements(gl.TRIANGLES, e.count, gl.UNSIGNED_INT, 0);
      drawn++;
      tris += e.count / 3;
    }
    gl.bindVertexArray(null);
    this.stats.drawn = drawn;
    this.stats.culled = culled;
    this.stats.triangles = tris;
  }

  _drawSun(scene, time) {
    const gl = this.gl;
    const { program, uniforms } = this.sunProg;
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uViewProj, false, this._vp);
    gl.uniform3fv(uniforms.uSunPos, this.sunPos);
    gl.uniform1f(uniforms.uSunRadius, WORLD.R_SUN);
    gl.uniform3fv(uniforms.uCamPos, scene.eye);
    gl.uniform3fv(uniforms.uSunColor, this.sunColor);
    gl.uniform1f(uniforms.uTime, time);

    // The sun is an emitter: cull its front faces so you see the far side
    // through it when you are inside the deadzone.
    gl.cullFace(gl.FRONT);
    gl.bindVertexArray(this.sunVao);
    gl.drawElements(gl.TRIANGLES, this.sunIndexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.cullFace(gl.BACK);
  }
}
