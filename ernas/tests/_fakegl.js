/**
 * ERNAS ENGINE — tests/_fakegl.js
 * =====================================================================
 *  A recording WebGL2 stub, good enough to run main.js in Node.
 * =====================================================================
 *
 * WHAT THIS IS AND IS NOT
 *
 * This is not an OpenGL implementation.  It rasterises nothing and validates no
 * GLSL.  Its one clever trick is that `linkProgram` REGEX-PARSES the shader
 * sources it was handed and `getUniformLocation` answers from that, so a
 * `uniform vec3 uFogColour;` declared in the shader but referenced as
 * `uFogColor` from renderer.js comes back `null` — and `assertLocations` below
 * turns that into a failure.  Uniform-name typos are the single most likely
 * renderer bug and the GLSL grammar parser in `tools/check_shaders.js` cannot
 * see them, because both sides are individually well-formed.
 *
 * Still unverifiable with this stub: shader COMPILE and LINK against a real
 * driver, attribute binding locations, depth/cull behaviour, framebuffer
 * results, and anything about what the image looks like.  See
 * ernas/README.md, "What I could not verify".
 */

/** Every GL entry point the renderer touches, as no-ops. */
const NOOP = [
  /*
   * `shaderSource`, `compileShader`, `attachShader` and `linkProgram` are
   * deliberately NOT in this list.  The loop below assigns own properties, and
   * an own property shadows the class method of the same name — so listing them
   * here silently disabled source capture and made every uniform lookup vacuous.
   * That bug was live once and was caught only because the uniform test also
   * asserts a minimum lookup count.
   */
  "bufferData", "bindBuffer", "bindVertexArray", "vertexAttribPointer",
  "enableVertexAttribArray", "drawElements", "drawArrays", "useProgram",
  "clear", "clearColor", "enable", "disable", "depthFunc", "depthMask",
  "cullFace", "frontFace", "viewport", "deleteShader", "deleteProgram",
  "uniform1f", "uniform2f", "uniform3f", "uniform4f",
  "uniform1i", "uniform2i", "uniform3i", "uniform4i",
  "uniform1fv", "uniform2fv", "uniform3fv", "uniform4fv",
  "uniformMatrix3fv", "uniformMatrix4fv",
  "vertexAttribDivisor", "drawArraysInstanced", "drawElementsInstanced",
  "blendFunc", "lineWidth", "scissor", "texImage2D", "activeTexture",
  "bindTexture", "texParameteri", "generateMipmap", "deleteTexture",
];

const UNIFORM_RE = /uniform\s+(?:lowp\s+|mediump\s+|highp\s+)?\w+\s+([A-Za-z_]\w*)\s*(\[\s*\d+\s*\])?\s*;/g;

export class FakeGL {
  constructor() {
    this.calls = 0;
    this.draws = 0;
    this.drawnElements = 0;
    /** @type {Map<string, Set<string>>} program handle -> declared uniforms */
    this.programs = new Map();
    /** @type {Set<string>} every uniform location ever requested */
    this.requestedLocations = new Set();
    /** @type {Array<{name:string, why:string}>} null uniform lookups */
    this.nullLocations = [];
    this._next = 1;
    this._shaderSrc = new Map();
    this._programShaders = new Map();
    this._currentProgram = null;

    // Constants.  Values are irrelevant to a stub; identity is all that matters.
    for (const [k, v] of Object.entries({
      VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
      COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82, ACTIVE_UNIFORMS: 0x8B86,
      ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88E4,
      FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401, UNSIGNED_INT: 0x1405, UNSIGNED_SHORT: 0x1403,
      TRIANGLES: 0x0004, COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100,
      DEPTH_TEST: 0x0B71, CULL_FACE: 0x0B44, BLEND: 0x0BE2,
      LEQUAL: 0x0203, BACK: 0x0405, FRONT: 0x0404, CCW: 0x0901,
      VERSION: 0x1F02, TEXTURE_2D: 0x0DE1,
    })) this[k] = v;

    for (const name of NOOP) {
      this[name] = (...args) => {
        this.calls++;
        if (name === "drawArrays" || name === "drawElements") {
          this.draws++;
          if (name === "drawElements") this.drawnElements += args[1] ?? 0;
        }
        // A null uniform location is a real bug: the driver would silently
        // drop the write and the object would render with a garbage constant.
        if (name.startsWith("uniform") && args[0] === null) {
          this.nullLocations.push({ name, why: `null location passed to ${name}` });
        }
      };
    }
  }

  createShader(type) { return { __shader: this._next++, type, src: "" }; }

  shaderSource(sh, src) { sh.src = src; this.calls++; }
  compileShader() { this.calls++; }
  getShaderParameter() { return true; }
  getShaderInfoLog() { return ""; }

  createProgram() { return { __program: this._next++, uniforms: new Set() }; }

  attachShader(p, sh) {
    this.calls++;
    if (!this._programShaders.has(p)) this._programShaders.set(p, []);
    this._programShaders.get(p).push(sh);
  }

  linkProgram(p) {
    this.calls++;
    for (const sh of this._programShaders.get(p) ?? []) {
      UNIFORM_RE.lastIndex = 0;
      let m;
      while ((m = UNIFORM_RE.exec(sh.src))) p.uniforms.add(m[1]);
    }
    this.programs.set(p.__program, p.uniforms);
  }

  getProgramParameter(p, what) {
    if (what === this.LINK_STATUS) return true;
    if (what === this.ACTIVE_UNIFORMS) return p.uniforms.size;
    return 0;
  }

  getProgramInfoLog() { return ""; }

  getActiveUniform(p, i) { return { name: [...p.uniforms][i], type: this.FLOAT, size: 1 }; }

  /**
   * Answers from the declarations actually present in the linked sources.
   * `uName[0]` is accepted for array uniforms, as GLSL requires.
   */
  getUniformLocation(p, name) {
    this.calls++;
    this.requestedLocations.add(name);
    const base = name.replace(/\[0\]$/, "");
    if (!p.uniforms.has(base)) {
      this.nullLocations.push({
        name,
        why: `not declared in shader (declared: ${[...p.uniforms].join(", ") || "none"})`,
      });
      return null;
    }
    return { __loc: name, program: p };
  }

  getParameter(what) {
    if (what === this.VERSION) return "WebGL 2.0 (FakeGL)";
    return 0;
  }

  createBuffer() { this.calls++; return { __buffer: this._next++ }; }
  createVertexArray() { this.calls++; return { __vao: this._next++ }; }
  deleteBuffer() { this.calls++; }
  deleteVertexArray() { this.calls++; }
  createTexture() { this.calls++; return { __tex: this._next++ }; }
}
