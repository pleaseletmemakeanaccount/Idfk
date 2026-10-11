/**
 * ERNAS ENGINE — src/main.js
 * =====================================================================
 *  Boot, frame loop, chunk streaming budget, input, HUD.
 * =====================================================================
 *
 * This is the thin shell that turns the engine into something you can walk
 * around in.  It owns nothing the engine does not already own: the world owns
 * chunk residency, the terrain owns "what block is here", the controller owns
 * locomotion, the renderer owns the frame.
 *
 * What lives here, and why it lives here rather than in the engine:
 *
 *  - THE FRAME BUDGET.  Chunk generation, lighting and meshing are all
 *    synchronous today (see UNRESOLVED(renderer) in renderer.js).  The engine
 *    exposes `world.update(..., budget)` in *chunks*, but a chunk count is the
 *    wrong currency for a frame: one chunk costs 21.7 ms on average and the
 *    variance is large enough that a fixed count still stutters.  So this file
 *    spends the budget in MILLISECONDS and asks the engine for one chunk at a
 *    time.  That is a policy decision, which is why it sits in the shell.
 *
 *  - THE PIPELINE ORDER.  generate -> light -> mesh -> upload must happen one
 *    stage at a time per chunk, because lighting reads neighbouring voxels and
 *    meshing reads neighbouring *light*.  The stage counters below exist so the
 *    HUD can show a chunk stuck between stages instead of silently invisible.
 *
 * UNRESOLVED(main): this file runs in Node under `tests/main_headless.test.js`,
 * which installs a fake DOM and a recording WebGL2 stub and drives the real
 * frame loop — so the boot path, the chunk pipeline, the uniform bindings and
 * the input handling ARE covered.  What is still unverified, and cannot be
 * verified without a browser, is anything a stub has to fake: real shader
 * compilation and linking, attribute binding locations, depth and cull
 * behaviour, pointer lock, and what the rendered image actually looks like.
 * See ernas/README.md, "What I could not verify".
 */

import { WORLD } from "./world/cylinderGeometry.js";
import { makeTerrain, BIOME_NAMES } from "./world/generator.js";
import { World } from "./world/world.js";
import { CHUNK_STATE } from "./world/chunk.js";
import { meshChunkInto } from "./world/mesher.js";
import { Renderer } from "./render/renderer.js";
import { MothPlayer } from "./player/controller.js";

/* ------------------------------------------------------------------ *
 * Tunables.  Everything here is a policy knob, not an engine constant.
 * ------------------------------------------------------------------ */

const RENDER_RADIUS = 7;      // chunks.  7^3-ish sphere = ~1400 chunks.
const MESH_MS = 6.0;          // ms/frame we are willing to spend meshing
const UPLOAD_MS = 6.0;        // ms/frame we are willing to spend uploading
const FOV_Y = 1.22;           // radians, ~70 degrees
const SPRINT_MULT = 1.75;

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

const canvas = document.getElementById("gl");
const overlay = document.getElementById("overlay");
const overlayBody = document.getElementById("overlay-body");
const hud = document.getElementById("hud");
const bootBtn = document.getElementById("boot");

/** One line of the boot/readout panel. */
function say(text, cls = "") {
  const el = document.createElement("div");
  el.textContent = text;
  if (cls) el.className = cls;
  overlayBody.appendChild(el);
  return el;
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

let renderer, world, player;

function boot() {
  const t0 = performance.now();

  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    say(`FATAL: ${err.message}`, "err");
    say("WebGL2 is required. This engine does not ship a WebGL1 fallback.", "err");
    bootBtn.disabled = true;
    throw err;
  }
  say(`WebGL2 context acquired  (${renderer.gl.getParameter(renderer.gl.VERSION)})`);

  // A fixed seed makes the demo reproducible; the URL can override it so you
  // can look at other worlds without editing code.
  const seed = new URLSearchParams(location.search).get("seed") || "ERNAS";
  const terrain = makeTerrain(seed);
  world = new World(terrain);
  player = new MothPlayer(world);
  player.spawn(0, WORLD.WORLD_Z / 2);
  globalThis.__ernas.renderer = renderer;
  globalThis.__ernas.world = world;
  globalThis.__ernas.player = player;
  say(`world seed "${seed}"  —  override with ?seed=...`);

  resize();
  window.addEventListener("resize", resize);
  bindInput();

  const bootMs = performance.now() - t0;
  say(`engine up in ${bootMs.toFixed(0)} ms — streaming ${RENDER_RADIUS}-chunk radius`, "ok");
  say("");
  say("W A S D  move      mouse  look      space  jump", "hint");
  say("shift  sprint     F  toggle flight (space/ctrl = up/down)", "hint");
  say("esc  release mouse    O  hide this panel", "hint");
  say("");
  say("click anywhere to capture the mouse", "hint");
  return true;
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(window.innerWidth, window.innerHeight, dpr);
  canvas.style.width = "100%";
  canvas.style.height = "100%";
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

const keys = Object.create(null);
const input = { f: 0, b: 0, l: 0, r: 0, up: 0, down: 0, jump: false };
let sprint = false;

function bindInput() {
  canvas.addEventListener("click", () => {
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  });

  // The overlay is the pause screen: pointer lock is the only thing that can
  // dismiss it, so "esc" also un-pauses the mouse for free.
  document.addEventListener("pointerlockchange", () => {
    overlay.classList.toggle("hidden", document.pointerLockElement === canvas);
  });

  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;
    // Yaw rotates in the (tangent, axis) plane; pitch tilts toward the axis.
    player.yaw -= e.movementX * 0.0022;
    player.pitch -= e.movementY * 0.0022;
    const lim = Math.PI / 2 - 0.01;
    if (player.pitch > lim) player.pitch = lim;
    if (player.pitch < -lim) player.pitch = -lim;
  });

  document.addEventListener("keydown", (e) => {
    keys[e.code] = true;
    if (e.code === "KeyF") player.creative = !player.creative;
    if (e.code === "KeyR") respawn();
    if (e.code === "KeyO") overlay.classList.toggle("hidden");
    if (e.code === "Space") e.preventDefault();
  });
  document.addEventListener("keyup", (e) => { keys[e.code] = false; });
  window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
}

function pollInput() {
  input.f = keys.KeyW || keys.ArrowUp ? 1 : 0;
  input.b = keys.KeyS || keys.ArrowDown ? 1 : 0;
  input.l = keys.KeyA || keys.ArrowLeft ? 1 : 0;
  input.r = keys.KeyD || keys.ArrowRight ? 1 : 0;
  input.up = keys.Space ? 1 : 0;
  input.down = keys.ControlLeft || keys.ControlRight ? 1 : 0;
  input.jump = !!keys.Space;
  sprint = !!(keys.ShiftLeft || keys.ShiftRight);
  // Sprint is a shell-level knob: the controller only knows a walk speed.
  player.walkSpeed = 5.2 * (sprint ? SPRINT_MULT : 1);
}

function respawn() {
  player.spawn(0, WORLD.WORLD_Z / 2);
  world.update(...playerChunk(), RENDER_RADIUS, 64);
}

/* ------------------------------------------------------------------ *
 * Chunk pipeline, spent in milliseconds
 * ------------------------------------------------------------------ */

/** The player's chunk coordinates, as the streamer wants them. */
function playerChunk() {
  const t = player.tubeCoords();
  return [
    Math.floor(t.i / WORLD.CHUNK),
    Math.floor(t.j / WORLD.CHUNK),
    Math.floor(t.k / WORLD.CHUNK),
  ];
}

/**
 * Spend up to `ms` milliseconds advancing resident chunks by one pipeline
 * stage: MESH, or UPLOAD.  Returns how many chunks it advanced.
 *
 * Generation and lighting are deliberately not here — those are the world's
 * job, driven by `world.update` from the frame loop, because only the world
 * knows which chunks are supposed to be resident at all.
 *
 * A chunk with no geometry (fully solid, or fully air) still has to reach
 * MESHED, or this loop re-examines it every frame forever.  `meshChunkInto`
 * returns false for those; we mark them MESHED with a null mesh and skip the
 * upload.
 *
 * UNRESOLVED(pipeline): this scans every resident chunk on every call.  At the
 * current ~1400 resident chunks that is noise next to a 21.7 ms/chunk pipeline,
 * but it is O(resident) per stage per frame and should become a per-stage work
 * queue before the render distance grows.
 */
function advance(ms) {
  const t0 = performance.now();
  let done = 0;
  for (const chunk of world.chunks.values()) {
    if (performance.now() - t0 > ms) break;
    if (chunk.state === CHUNK_STATE.LIT) {
      meshChunkInto(world, chunk);
      chunk.state = CHUNK_STATE.MESHED;
      done++;
    } else if (chunk.state === CHUNK_STATE.MESHED && !chunk.uploaded) {
      chunk.uploaded = true;                 // set first: a null mesh is terminal too
      if (chunk.mesh) renderer.uploadChunk(chunk);
      done++;
    }
  }
  return done;
}

/**
 * Free GPU memory for chunks the streamer evicted.
 *
 * `World.update` deletes from `world.chunks` but cannot reach the renderer, so
 * this reconciles the two maps.  Without it, every evicted chunk leaks its VAO
 * and three buffers for the life of the page — which is exactly the failure
 * mode you only notice after ten minutes of walking.
 */
function reconcileUploads() {
  if (renderer.gpuChunks.size <= world.chunks.size) return;   // fast path
  for (const key of Array.from(renderer.gpuChunks.keys())) {
    if (!world.chunks.has(key)) renderer.disposeChunk({ key });
  }
}

/* ------------------------------------------------------------------ *
 * Frame loop
 * ------------------------------------------------------------------ */

let last = 0;
let fps = 0;
let frames = 0;
let fpsTimer = 0;
const scene = { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 0, 1], fovY: FOV_Y, time: 0, chunks: null };

function frame(now) {
  requestAnimationFrame(frame);

  const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
  last = now;
  scene.time = now / 1000;

  // fps over a half second, not per-frame (per-frame is unreadable)
  frames++;
  fpsTimer += dt;
  if (fpsTimer >= 0.5) { fps = frames / fpsTimer; frames = 0; fpsTimer = 0; }

  pollInput();
  player.update(dt, input);

  const [ci, cj, ck] = playerChunk();
  world.update(ci, cj, ck, RENDER_RADIUS, 2);   // keep 2 fresh chunks entering per frame
  advance(MESH_MS);
  advance(UPLOAD_MS);
  reconcileUploads();

  scene.eye = player.eye();
  scene.target = player.target();
  scene.up = player.upVector();
  scene.chunks = world.chunks.values();
  // Fog is in Cartesian units and the tube's inner radius is ~1280, so these
  // are absolute distances from the camera, not radii.
  scene.fogNear = 60;
  scene.fogFar = RENDER_RADIUS * WORLD.CHUNK * 1.6;
  renderer.render(scene);

  updateHud();
}

/* ------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------ */

const hudRows = {};
function hudRow(id, label) {
  if (!hudRows[id]) {
    const el = document.createElement("div");
    el.innerHTML = `<span class="k">${label}</span><span class="v" id="hud-${id}"></span>`;
    hud.appendChild(el);
    hudRows[id] = el.querySelector(".v");
  }
  return hudRows[id];
}

let hudTick = 0;
function updateHud() {
  // Redrawing the HUD every frame costs more than it is worth.
  if (++hudTick % 6 !== 0) return;

  const t = player.tubeCoords();
  const bio = BIOME_NAMES[world.terrain.biomeAt(t.i, t.k)] ?? "?";

  hudRow("fps", "fps").textContent = fps.toFixed(0);
  hudRow("pos", "tube i / j / k").textContent =
    `${t.i} / ${t.j} / ${t.k}`;
  hudRow("rad", "radius").textContent =
    `${t.radius.toFixed(1)}  (surface ${world.terrain.surfaceRadius(t.i, t.k).toFixed(1)})`;
  hudRow("bio", "biome").textContent = bio;
  hudRow("mode", "mode").textContent =
    player.creative ? "FLIGHT" : (player.onGround ? "grounded" : "falling");

  let lit = 0, meshed = 0, uploaded = 0;
  for (const c of world.chunks.values()) {
    if (c.state >= CHUNK_STATE.LIT) lit++;
    if (c.state >= CHUNK_STATE.MESHED) meshed++;
    if (c.uploaded) uploaded++;
  }
  hudRow("chunks", "chunks gen / mesh / gpu").textContent =
    `${world.chunks.size} / ${meshed} / ${uploaded}  (lit ${lit})`;
  hudRow("draw", "draw calls / tris").textContent =
    `${renderer.stats.drawn} / ${(renderer.stats.triangles / 1000).toFixed(0)}k  (culled ${renderer.stats.culled})`;
  hudRow("patches", "column patches cached").textContent =
    `${world.terrain.cache.size}`;
}

/**
 * Exposed for the browser console and for tests/main_headless.test.js.
 *
 * Deliberately a debug handle rather than an API: nothing in the engine reads
 * it, and the tests use it to assert the invariants that only become visible
 * after the pipeline has run for a while — most importantly that GPU handles do
 * not outlive the chunks they belong to.
 */
globalThis.__ernas = { renderer: null, world: null, player: null, scene };

/* ------------------------------------------------------------------ *
 * Go
 * ------------------------------------------------------------------ */

bootBtn.addEventListener("click", () => {
  bootBtn.disabled = true;
  try {
    boot();
  } catch (err) {
    console.error(err);
    return;
  }
  /*
   * Warm a small radius synchronously so the first frames are not empty sky.
   * Capped by wall-clock time, not chunk count: `world.update` returns the
   * number it generated, which hits 0 once the radius is full, and that is the
   * natural loop exit.
   */
  const [ci, cj, ck] = playerChunk();
  const t0 = performance.now();
  while (performance.now() - t0 < 900) {
    if (world.update(ci, cj, ck, 3, 2) === 0) break;
  }
  advance(250);
  advance(250);
  say(`pre-streamed ${world.chunks.size} chunks in ${(performance.now() - t0).toFixed(0)} ms`, "ok");
  requestAnimationFrame(frame);
});
