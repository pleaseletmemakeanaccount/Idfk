/**
 * ERNAS ENGINE — tests/main_headless.test.js
 * =====================================================================
 *  Drives the real src/main.js frame loop against a recording GL stub.
 * =====================================================================
 *
 * WHY THIS EXISTS
 *
 * main.js is the one file in the engine that `node --test` would ordinarily
 * skip entirely, because it touches `document` and WebGL at module scope.  Left
 * untested it is exactly where a typo, a wrong field name or a broken state
 * machine would survive review.  So rather than re-implement its logic in a
 * test — which would test the re-implementation — this file installs a fake DOM
 * and a recording WebGL2 stub and runs the actual module.
 *
 * WHAT IT DOES PROVE
 *   - every named import in main.js resolves;
 *   - boot() runs to completion and the chunk pipeline advances
 *     generate -> light -> mesh -> upload;
 *   - every uniform location renderer.js asks for is actually declared in the
 *     shader source it was linked against (see tests/_fakegl.js);
 *   - the frame loop survives a simulated second of play without throwing, and
 *     the player actually moves when you hold W;
 *   - evicted chunks release their GPU handles instead of leaking.
 *
 * WHAT IT CANNOT PROVE
 *   Shaders are not compiled or linked by a driver, nothing is rasterised, and
 *   there is no assertion anywhere about what the picture looks like.  Those
 *   need a real browser.  See ernas/README.md, "What I could not verify".
 */

import test from "node:test";
import assert from "node:assert/strict";

import { FakeGL } from "./_fakegl.js";
import { FakeElement, installDom, uninstallDom } from "./_fakedom.js";

const gl = new FakeGL();
const canvas = new FakeElement("canvas", "gl");
canvas._gl = gl;
const { elements, rafQueue } = installDom(canvas);

// The module reads the DOM and registers the boot handler at import time.
await import("../src/main.js");

test("boot() completes and reports a WebGL2 context", () => {
  elements.get("boot").dispatch("click");

  const lines = elements.get("overlay-body").children.map((c) => c.textContent);
  assert.ok(
    lines.some((l) => l.includes("WebGL2 context acquired")),
    `boot did not report a context; said:\n  ${lines.join("\n  ")}`,
  );
  assert.ok(
    lines.some((l) => l.includes("engine up in")),
    "boot did not reach the end of its own startup sequence",
  );
  // The fatal path must not have fired.
  assert.ok(!lines.some((l) => l.includes("FATAL")), `boot reported a fatal: ${lines.join(" | ")}`);
});

/** Drive n frames at a fixed 60 Hz, as the browser would. */
function runFrames(n, t0 = 1000) {
  for (let f = 0; f < n; f++) {
    const fn = rafQueue.shift();
    assert.ok(fn, `frame loop stopped queueing after ${f} frames`);
    fn(t0 + f * (1000 / 60));
  }
}

test("the frame loop runs a simulated second without throwing", () => {
  // boot() already queued the first frame; the pre-stream loop ran synchronously.
  runFrames(60);
  assert.ok(gl.draws > 0, `renderer issued no draw calls in 60 frames (${gl.calls} GL calls total)`);
});

test("the chunk pipeline reaches the GPU, not just the CPU", () => {
  // Reach into the module's live state through the objects it mutated.  main.js
  // keeps `world` private, so this reads the renderer's own bookkeeping instead.
  assert.ok(gl.drawnElements > 0,
    "no indexed geometry was ever drawn — no chunk mesh reached the GPU");
  // 60 frames at ~1 chunk/frame of meshing is plenty to have uploaded several.
  assert.ok(gl.draws >= 60,
    `only ${gl.draws} draws over 60 frames; the sky alone is 1/frame, so chunks are not being drawn`);
});

test("every uniform the renderer asks for is declared in its shader", () => {
  /*
   * This is the check the GLSL grammar parser structurally cannot make.  A
   * `uFogColor` uniform requested against a shader that declares `uFogColour`
   * is two perfectly valid files that do not fit together; the driver answers
   * null and the value is silently never applied.
   */
  assert.ok(gl.requestedLocations.size >= 10,
    `only ${gl.requestedLocations.size} uniform lookups — the renderer barely ran`);
  assert.deepEqual(
    gl.nullLocations,
    [],
    `${gl.nullLocations.length} uniform lookups returned null:\n` +
    gl.nullLocations.map((n) => `  ${n.name}: ${n.why}`).join("\n"),
  );
});

test("holding W moves the player along the tube", () => {
  /*
   * Driven through the key handler main.js registered on `document`, which is
   * the same path a real keyboard takes.  Note the HUD only redraws every sixth
   * frame, so 60 frames is six HUD updates — enough to read a settled value.
   */
  runFrames(6);
  const posBefore = readTubePosition();
  pressKey("KeyW", true);
  runFrames(90, 5000);
  pressKey("KeyW", false);
  runFrames(6, 9000);
  const posAfter = readTubePosition();

  assert.notEqual(posAfter, posBefore,
    `player did not move while holding W (still at tube ${posBefore})`);
  assert.ok(gl.draws > 150, `frame loop stalled while walking (draws=${gl.draws})`);
});

test("toggling flight changes the reported movement mode", () => {
  runFrames(6, 12000);
  const before = hudValue("mode");
  pressKey("KeyF", true);
  pressKey("KeyF", false);
  runFrames(6, 13000);
  const after = hudValue("mode");
  assert.equal(before, "grounded", `expected the player to start grounded, HUD says "${before}"`);
  assert.equal(after, "FLIGHT", `F did not enable flight, HUD says "${after}"`);
});

/* ------------------------------------------------------------------ *
 * Helpers that read state back out of the fake HUD main.js writes to.
 * ------------------------------------------------------------------ */

/**
 * The HUD is the only window into main.js's private state, so tests read it
 * rather than exporting internals.  Rows are `<div><span class=k>..</span><span
 * class=v>value</span></div>`; rows are found by their key text.
 */
function hudValue(prefix) {
  for (const row of elements.get("hud").children) {
    const kids = row.children;
    if (!kids || kids.length < 2) continue;
    if (String(kids[0].textContent ?? "").startsWith(prefix)) {
      return String(kids[1].textContent ?? "");
    }
  }
  return null;
}

function readTubePosition() {
  const v = hudValue("tube i / j / k");
  assert.ok(v !== null,
    `HUD has no tube-coordinate row; rows are: ` +
    elements.get("hud").children.map((r) => r.children?.[0]?.textContent).join(", "));
  return v;
}

/** Fire a key event through main.js's own document-level handler. */
function pressKey(code, down) {
  document.dispatch(down ? "keydown" : "keyup", { code, preventDefault() {} });
}

test("GPU handles never outlive the chunk they belong to", () => {
  /*
   * `World.update` evicts far chunks from `world.chunks`, but it cannot reach
   * the renderer.  If `reconcileUploads` did not run, every evicted chunk would
   * leak a VAO and three buffers for the life of the page — a failure you only
   * notice after ten minutes of walking, which is exactly the kind of bug a
   * short smoke test walks straight past.
   */
  const { renderer, world } = globalThis.__ernas;
  assert.ok(renderer && world, "boot did not publish the debug handle");

  // Walk far enough in flight mode that the streamer has to evict something.
  pressKey("KeyW", true);
  for (let batch = 0; batch < 24; batch++) {
    runFrames(20, 20000 + batch * 2000);
    assert.ok(
      renderer.gpuChunks.size <= world.chunks.size,
      `leak: ${renderer.gpuChunks.size} GPU chunks against ${world.chunks.size} resident ` +
      `after ${20 * (batch + 1)} frames of walking`,
    );
  }
  pressKey("KeyW", false);

  assert.ok(world.chunks.size > 20,
    `only ${world.chunks.size} resident chunks — the streamer is not keeping up`);
  assert.ok(renderer.gpuChunks.size > 20,
    `only ${renderer.gpuChunks.size} chunks on the GPU — uploads are stalling`);
});

test("teardown", () => { uninstallDom(); });
