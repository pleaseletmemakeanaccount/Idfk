/**
 * ERNAS ENGINE — tools/check_shaders.js
 * =====================================================================
 *  Static validation of the GLSL sources.
 * =====================================================================
 *
 * A shader typo does not throw in a useful place: you get a black canvas and
 * a console warning that is easy to miss.  This script checks the sources
 * without a GPU.
 *
 * Three levels of check, in increasing order of how much they need installed:
 *
 *   1. STRUCTURAL (always runs).  `#version 300 es` is the first thing in the
 *      file, braces and parens balance, and every `in` in a fragment stage has
 *      a matching `out` of the same type in the vertex stage.  That last one
 *      is a cross-stage interface check the GLSL compiler does for you, and
 *      nothing else here does.
 *
 *   2. SYNTAX (runs if @shaderfrog/glsl-parser is installed).  A real GLSL
 *      ES 1.00/3.00 grammar parse.  Install with:
 *          npm install --no-save @shaderfrog/glsl-parser
 *      It is intentionally not a dependency of this repo — the engine ships
 *      no build step and no node_modules.
 *
 *   3. LINK/COMPILE — NOT POSSIBLE HERE.  That needs a real GL context.  See
 *      ernas/README.md, "What I could not verify".
 */

import { ALL_SHADERS } from "../src/render/shaders.js";

const STAGE_PAIRS = [
  ["CHUNK_VERT", "CHUNK_FRAG"],
  ["SKY_VERT", "SKY_FRAG"],
  ["SUN_VERT", "SUN_FRAG"],
  ["LINE_VERT", "LINE_FRAG"],
];

let failures = 0;
let checks = 0;
function fail(msg) { failures++; console.error(`  FAIL  ${msg}`); }
function pass(msg) { checks++; console.log(`  ok    ${msg}`); }

/* ------------------------------------------------------------------ *
 * 1. Structural
 * ------------------------------------------------------------------ */

function checkVersionDirective(name, src) {
  if (!src.startsWith("#version 300 es")) {
    fail(`${name}: must begin with exactly "#version 300 es" (found ${JSON.stringify(src.slice(0, 24))})`);
    return;
  }
  pass(`${name}: version directive is first`);
}

function checkBalanced(name, src) {
  // Strip comments and string-ish content so braces inside them don't count.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const counts = { "{": 0, "(": 0, "[": 0 };
  const pairs = { "}": "{", ")": "(", "]": "[" };
  for (const ch of stripped) {
    if (ch in counts) counts[ch]++;
    else if (ch in pairs) counts[pairs[ch]]--;
  }
  for (const [open, n] of Object.entries(counts)) {
    if (n !== 0) { fail(`${name}: unbalanced "${open}" (net ${n})`); return; }
  }
  pass(`${name}: braces/parens balanced`);
}

/** Extract `out <type> <name>;` / `in <type> <name>;` declarations. */
function ioDeclarations(src, keyword) {
  const re = new RegExp(`^\\s*(?:smooth\\s+|flat\\s+|noperspective\\s+)?${keyword}\\s+(\\w+)\\s+(\\w+)\\s*;`, "gm");
  const out = new Map();
  let m;
  while ((m = re.exec(src)) !== null) out.set(m[2], m[1]);
  return out;
}

function checkStageInterface(vertName, fragName) {
  const vOut = ioDeclarations(ALL_SHADERS[vertName], "out");
  const fIn = ioDeclarations(ALL_SHADERS[fragName], "in");
  if (fIn.size === 0) { fail(`${fragName}: declares no inputs — suspicious`); return; }
  for (const [name, type] of fIn) {
    if (!vOut.has(name)) { fail(`${fragName}: input "${name}" has no matching out in ${vertName}`); continue; }
    if (vOut.get(name) !== type) {
      fail(`${fragName}: input "${name}" is ${type} but ${vertName} outputs ${vOut.get(name)}`);
      continue;
    }
  }
  // Vertex outputs that the fragment stage ignores are legal, but worth noting.
  pass(`${vertName} -> ${fragName}: ${fIn.size} varying(s) matched by name and type`);
}

function checkFragmentWritesColor(name, src) {
  if (!/out\s+vec4\s+\w+\s*;/.test(src)) { fail(`${name}: no "out vec4" colour target`); return; }
  const target = /out\s+vec4\s+(\w+)\s*;/.exec(src)[1];
  if (!new RegExp(`${target}\\s*=`).test(src)) { fail(`${name}: never writes to ${target}`); return; }
  pass(`${name}: writes its colour target (${target})`);
}

/* ------------------------------------------------------------------ *
 * 2. Syntax (optional dependency)
 * ------------------------------------------------------------------ */

async function loadParser() {
  try {
    const mod = await import("@shaderfrog/glsl-parser");
    return mod.parser ?? mod.default?.parser ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

console.log("ERNAS shader check");
console.log("------------------");

for (const [name, src] of Object.entries(ALL_SHADERS)) {
  checkVersionDirective(name, src);
  checkBalanced(name, src);
  if (name.endsWith("_FRAG")) checkFragmentWritesColor(name, src);
}

console.log("");
for (const [v, f] of STAGE_PAIRS) checkStageInterface(v, f);

console.log("");
const parser = await loadParser();
if (!parser) {
  console.log("  skip  grammar parse — @shaderfrog/glsl-parser is not installed");
  console.log("        (npm install --no-save @shaderfrog/glsl-parser)");
} else {
  for (const [name, src] of Object.entries(ALL_SHADERS)) {
    try {
      parser.parse(src, { quiet: true });
      pass(`${name}: parses as valid GLSL`);
    } catch (err) {
      fail(`${name}: ${err.message.split("\n")[0]}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Vertex attribute locations: shader declaration vs renderer binding
 * ------------------------------------------------------------------ */

/**
 * The one renderer/shape mismatch that is BOTH easy to make and completely
 * invisible to every other check in this file: a vertex shader declares
 * `layout(location = 1) in vec4 aColor` while the renderer binds location 1
 * with `vertexAttribPointer(1, 3, gl.UNSIGNED_BYTE, ...)`.  Both files are
 * individually valid.  A real driver links it happily and draws the mesh with
 * a garbage fourth component.
 *
 * So: every `vertexAttribPointer(loc, size, ...)` the renderer issues must
 * match a `layout(location = loc) in vec<size>` declaration in one of the
 * shaders it links, and every attribute a linked shader declares must be bound
 * with a matching component count.
 *
 * The regexes are deliberately narrow.  They understand exactly the call shapes
 * renderer.js uses; if renderer.js starts binding attributes in a loop or from
 * a table, this check must be rewritten rather than trusted.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

console.log("");

const VEC_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4, int: 1, ivec2: 2, ivec3: 3, ivec4: 4 };
const ATTR_RE = /layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\s+(\w+)\s+(\w+)\s*;/g;

/** Which vertex shaders the renderer actually links. */
const LINKED = new Set(["CHUNK_VERT", "SKY_VERT", "SUN_VERT"]);

const declared = new Map();      // "shader:loc" -> size
for (const [name, src] of Object.entries(ALL_SHADERS)) {
  if (!name.endsWith("_VERT")) continue;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(src))) {
    const size = VEC_SIZE[m[2]];
    if (size === undefined) {
      fail(`${name}: attribute ${m[3]} has non-vector type ${m[2]} at location ${m[1]}`);
      continue;
    }
    declared.set(`${name}:${m[1]}`, { size, attr: m[3] });
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const rendererSrc = readFileSync(join(here, "..", "src", "render", "renderer.js"), "utf8");
const bound = [];                // {loc, size}
{
  const re = /vertexAttribPointer\s*\(\s*(\d+)\s*,\s*(\d+)/g;
  let m;
  while ((m = re.exec(rendererSrc))) bound.push({ loc: Number(m[1]), size: Number(m[2]) });
}

for (const b of bound) {
  // Must match SOME linked shader's declaration at that location.
  const matches = [...declared].filter(
    ([k, v]) => LINKED.has(k.split(":")[0]) && k.endsWith(`:${b.loc}`) && v.size === b.size,
  );
  if (matches.length === 0) {
    const sameLoc = [...declared].filter(
      ([k]) => LINKED.has(k.split(":")[0]) && k.endsWith(`:${b.loc}`),
    );
    fail(
      `renderer binds location ${b.loc} with ${b.size} component(s), but no linked ` +
      `shader declares a vec${b.size} there (declared at that location: ` +
      `${sameLoc.map(([k, v]) => `${k.split(":")[0]}.${v.attr}=vec${v.size}`).join(", ") || "nothing"})`,
    );
  } else {
    pass(`location ${b.loc} bound with ${b.size} component(s) matches ${matches.map(([k]) => k.split(":")[0]).join("/")}`);
  }
}

// And every attribute a LINKED shader declares must actually be bound.
for (const [key, v] of declared) {
  const [shader, loc] = key.split(":");
  if (!LINKED.has(shader)) continue;
  const hit = bound.find((b) => b.loc === Number(loc) && b.size === v.size);
  if (!hit) {
    fail(`${shader}.${v.attr} (location ${loc}, vec${v.size}) is declared but never bound by renderer.js`);
  } else {
    pass(`${shader}.${v.attr} (location ${loc}) is bound`);
  }
}

if (![...declared].some(([k]) => k.startsWith("LINE_VERT"))) {
  fail("LINE_VERT declares no attributes — the debug line shader is stale");
} else {
  pass("LINE_VERT declares its attributes (shader is not linked by renderer.js yet)");
}

console.log("");
console.log(`${checks} checks passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
