# ERNAS — engine base

Voxel engine for a **non-Euclidean inverted-cylinder world**: you live on the
*inside* of a tube, gravity pulls outward from the central axis toward the iron
crust, and a sun sphere floats in the zero-gravity deadzone at the centre.

This is the **engine base only**. The two things deliberately built to depth are
the ones the brief asked for:

1. **Perlin noise** — hash-lattice, gradient-unbiased, exactly tileable.
2. **The cylinder world** — geometry, voxel generation, chunking, lighting,
   meshing, rendering, locomotion.

Everything else in the game spec (moth avatar limbs and dismemberment,
metabolism, chiselling, pylons, bosses, multiplayer, the sleep minigame,
entities) is **out of scope here** and is stubbed or annotated as future work
rather than half-built.

```
npm test        # 115 tests
npm run bench   # where the milliseconds go
npm run report  # statistical report on the noise stack
```

Serve the demo with any static file server (`python3 server.py` from the repo
root, then open `/ernas/`). It needs **WebGL2**.

---

## 1. Running it

| Command | What it does |
| --- | --- |
| `npm test` | 115 tests across noise, geometry, player, and the headless frame loop |
| `npm run bench` | Chunk pipeline, noise throughput, mesh yield, streaming cost |
| `npm run report` | Distribution, isotropy, tileability, octave spectrum, world outcome |
| `npm run shaders` | 41 structural, grammar and binding checks on all 8 GLSL sources |

> `npm test` runs `node --test`, **not** `node --test tests/`. On Node 22 a
> directory argument is treated as a module entry point and the run silently
> tests nothing. This was broken and is fixed.

---

## 2. The world, in coordinates

The cylinder's axis is **Z**. A voxel is addressed `(i, j, k)`:

| | meaning | range |
| --- | --- | --- |
| `i` | theta index around the tube | `0 .. THETA_COUNT-1` (8192), wraps |
| `j` | **integer radius** from the axis | `0 .. R_CRUST` |
| `k` | position along the axis | `0 .. WORLD_Z-1` (2048) |

Radially, outward from the axis:

```
r = 0        sun sphere (R_SUN 72) inside a zero-gravity deadzone (R_DEADZONE 120)
             open interior — unchunked; clouds and floating islands
r = 1228     R_SHELL_MIN, terrain begins
r = 1280     R_SURFACE, mean surface radius (mountains are SMALLER r)
r = 1436     R_CRUST_INNER
r = 1446     R_CRUST, the iron shell; beyond it is the volumetric void
```

Two consequences drive everything else:

- **Smaller radius is higher up.** The height field's "innermost solid radius"
  is the ground; a mountain is a *dip* in `j`.
- **`j` is the integer radius**, not a height. `surfaceRadius(i,k)` returns a
  float and the topmost solid voxel is `Math.ceil(h)` — using `floor` or the
  float directly makes `depth === 0` never true and the whole surface skin
  (moss, snow, sand) silently disappears.

---

## 3. Noise

### Design decisions that are not obvious from the code

**Hash lattice, not a 256-entry permutation table.** The classic table repeats
every 256 cells, which caps the tileable period at 256 — far too coarse for a
tube with an 8192-column circumference. ERNAS hashes the lattice corner
(`hash2/3/4` + `fmix32`) so tiling works for *any* integer period via
`wrapAxis(i, period)`. `period <= 0` means infinite.

**Gradient-bias fix.** Perlin's textbook `grad()` maps a 4-bit hash onto the 12
edge midpoints through a 16-way branch, so 4 of the 12 directions are chosen
**twice as often**. The field visibly favours the diagonals. ERNAS indexes
`Float64Array` tables of 8/12/32 unit gradients with Lemire multiply-shift
(`((h>>>0) * INV_U32 * N)|0`), which is uniform for any `N`.

**Fade** is `6t⁵−15t⁴+10t³` (C² continuous); `fadeDeriv = 30t⁴−60t³+30t²`.

**Lacunarity is exactly 2 for every layer.** A fractional lacunarity on a tiled
axis breaks the seam: the octave periods stop dividing the base period evenly.

**Threshold normalised values, never raw ones.** Fractal operators do not
preserve variance, and the skew is large enough to silently disable features:

| layer | kind | mean | sd | raw range |
| --- | --- | --- | --- | --- |
| continental | warp2 | 0.000 | 0.127 | −0.44 .. 0.41 |
| detail | fbm2 | −0.000 | 0.135 | −0.47 .. 0.47 |
| ridge | ridg2 | 0.678 | 0.136 | 0.13 .. 0.99 |
| cloud | bill2 | −0.648 | 0.149 | −1.00 .. −0.07 |
| storm | turb2 | 0.176 | 0.082 | 0.00 .. 0.50 |
| cave / island | fbm3 | 0.000 | 0.125 | −0.46 .. 0.46 |
| ore | fbm3 | 0.000 | 0.142 | −0.47 .. 0.52 |
| biome | fbm2 | 0.001 | 0.142 | −0.47 .. 0.49 |

Billow noise never exceeds −0.07, so `cloud > 0.4` produces **zero clouds,
ever**. Turbulence never exceeds 0.50, so `storm > 0.72` produces **zero
sinkholes, ever**. Both bugs were live. `LAYER_STATS` holds this table and
`sample2Norm` / `sample3Norm` divide by it, so `> 1.0` means "one standard
deviation out" uniformly. `tests/noise.test.js` re-measures the table from 5
seeds × 30k samples and fails if it drifts; a negative control (perturbing the
`storm` mean by 0.124) confirms the test actually catches it.

### Measured quality (`npm run report`)

| property | result |
| --- | --- |
| Isotropy, `perlin2` single octave | **0.93 %** directional-derivative spread |
| Isotropy, world layers | 0.28 % – 2.59 % |
| Layer wrap error (`x` vs `x + period`) | 5.2e-15 |
| `perlin2Tiled` wrap error | exactly 0 |
| Worst theta seam jump | **1.500 blocks** vs 9.154 worst interior — seam is not the worst discontinuity anywhere |

Isotropy is measured as `E[(u·∇f)²] = uᵀHu` at a sub-lattice step (0.07). A
1-D-slice variance test is *invalid* for lattice noise — it measures the line's
alignment with the grid, not the field. That test was written once and removed.

### Throughput

`perlin3` single octave: **8.2 M samples/s**. World layers 0.76 M/s
(`continental`, 5 octaves + domain warp) to 5.4 M/s (`biome`, 3 octaves).

---

## 4. Terrain

`CylinderTerrain.sample(i, j, k)` is a **pure function of coordinates** — no
chunk storage, no state. Chunks are a cache over it, not the source of truth,
and `World.getBlock` falls back to `terrain.sample` for anything not resident.

### Three fixes that removed unclimbable cliffs

The generator originally produced sheer vertical walls you could not climb.
Three independent causes, each invisible in a single-column check:

**1. Domain warp displaced further than its own wavelength.**
`domainWarp2Tiled`'s hard-coded `* 4.0` multiplier pushed displacement to 10.8
lattice cells against a 16-cell base period — the field folded over itself,
producing 3–6 block steps between *adjacent* columns everywhere. Warp strength
is now expressed in lattice cells and is **0.6**.

**2. The height field branched on biome id.** `highlands → abyssal` was a
~60-voxel step in one column. `_biomeFields(i,k)` now returns *continuous*
blend weights (`ocean`, `deep`, `cold`, `wet`, `warm`) and the height field
blends with them: `relief = land*(1-ocean) + (-oceanDepth)*ocean`. The discrete
`id` survives for **material selection only** — never for geometry.

**3. Sinkholes were a hard threshold.** `if (sink > 2.4)` on a 512-cell layer
crossed the whole ramp inside two columns → 55-block drops. Now
`smooth01((sink-1.7)/1.2) * 40` on the coarser `theta(64)` layer.

Measured over 614,400 columns before → after:

| adjacent step | before | after |
| --- | --- | --- |
| > 1 block | 23.3 % | 21.8 % |
| > 2 | 52 210 | 35 784 |
| > 4 | 25 246 | 4 448 |
| > 8 | 17 568 | 84 |
| > 16 | 10 722 | **0** |

`tests/cylinder.test.js` pins all three fixes, and the warp test's thresholds
are set against a measured negative control (re-running the same measurement at
the old 3.6-cell displacement gives a median step 23× worse and 66.7 % of
columns above 0.3 sd, versus 0.197 % now).

### Theta frequency contract

A frequency is never hand-written. It is always `theta(cells)`, which returns
`{ freq: cells / THETA_COUNT, period: cells }`. `period` must be an integer
power of two ≥ `2^(octaves-1)`.

| layer | cells | columns per feature |
| --- | --- | --- |
| biome | 8 | 1024 |
| continental | 16 | 512 |
| ridge | 32 | 256 |
| cloud, storm | 64 | 128 |
| detail, island | 256 | 32 |
| cave | 512 | 16 |
| ore | 1024 | 8 |

### Result (seed `ERNAS`)

Surface radius 1244–1362. Biomes: highlands 76.8 %, taiga 13.4 %, coral shelf
9.5 %, abyssal trench 0.3 %. Worst adjacent step 9.67 blocks, zero columns
above 16.

---

## 5. Chunk pipeline

```
generateChunk  →  lightChunk  →  meshChunk  →  renderer.uploadChunk
   2.3 ms           1.3 ms         3.0 ms            (GPU)
```

**6.7 ms per 16³ chunk** warm (3.2 ms generation with a cold column-patch
cache). Measured over 45 chunks that straddle the surface — verified by an
assertion in `bench.js`, because an earlier version silently measured 45
fully-solid chunks and reported plausible numbers that meant nothing (see
§7, "Mistakes worth keeping").

Mesh yield: 27 of 45 sampled chunks have geometry, averaging 871 faces / 3 484
vertices / 75 KiB of GPU buffers.

`main.js` spends the budget in **milliseconds**, not chunk counts, and asks for
one chunk at a time — a chunk count is the wrong currency when one chunk costs
6.7 ms and the variance is large.

### Column patch cache

The height field is evaluated per 16×16 `(i,k)` patch and cached (FIFO, 8192
patches). Each patch carries `radius`, `biome`, `shadow`, `ocean`, `deep`,
`cold`, `cont`.

`firstOpaqueRadius` — which lighting and meshing both ask for *per voxel* —
reads the patch's `shadow` array. Uncached it ran a four-octave billow noise
every call at **54 µs**; cached it is **0.08 µs**. That single change took
lighting a chunk from 49 ms to 1.3 ms.

---

## 6. Lighting, meshing, rendering

**Lighting.** Dual-channel (sky + block) BFS over a `(C+2)³` padded volume.
Sunlit iff `j < firstOpaqueRadius(i,k)`, determined by a column scan along `+r`;
transparent voxels seed at 15; BFS decays 1 per step on both channels.

**Meshing.** Vertices are Cartesian, topology is cylindrical: neighbour tests
happen in tube coordinates, corners are placed at `(r cos θ, r sin θ, z)`.
`FACE.INNER` (toward the axis) is "up" and shades 1.00; `OUTER` 0.50; `SIDE`
0.72 in θ / 0.86 in z. AO uses the axis/tangent rule with a per-voxel jitter
from `hash3`. All six `FACES` verified counter-clockwise from outside.

**Rendering.** Draw order: sky fullscreen pass (analytic sun disc + bloom from
the view ray, no depth write) → chunks (depth-tested, frustum-culled by chunk
bounding sphere) → sun sphere (`cullFace(FRONT)`, so it reads correctly from
inside the deadzone).

**Locomotion.** Collision is integrated in the **local frame** — tangential,
then axial, then radial — with the basis recomputed between steps, and velocity
stored as `[vT, vZ, vR]`. Step-up assist (0.55 / 1.05 blocks) requires ground at
the landing spot. See §7 for why Cartesian collision cannot work here.

---

## 7. Mistakes worth keeping

These are recorded in comments at the site of each fix. They are listed here
because each one produced output that *looked correct*.

| Mistake | Symptom | Fix |
| --- | --- | --- |
| Resolving collisions along Cartesian axes | On the inside of a cylinder a Cartesian step is a **chord** of the inner surface, so it drives the player *through* the floor. They wedged and moved 3.3 blocks in 10 s | Integrate in the local frame |
| Passing `radial` where `up` was wanted | Step assist pushed the player *into* the floor; the fix looked applied but did nothing | `up = -radial` |
| Thresholding raw fractal output | Zero clouds, zero sinkholes — no error, just a world without features | Threshold `sample2Norm` |
| Branching on biome id in the height field | 60-voxel cliffs at biome borders | Continuous blend weights |
| `floor` instead of `ceil` for the topmost solid voxel | The entire surface skin layer never appeared | `hInt = Math.ceil(h)` |
| Arrays as `Map` keys | Silent cache misses | Packed `voxelKey` (k 0–10, j 11–23, i 24–36) |
| `Chunk.blocks.fill(id)` | `uniform` flag left stale, chunk rendered wrong | `set()` updates it |
| `up × forward` for the right vector | Strafing inverted | `forward × up`, matching `lookAt` |
| Testing a mesher with a `stubWorld` that ignores the chunk | Tests passed against a world that wasn't the one under test | `stubWorld` reads the chunk's own voxels |
| `WORLD.THETA_CHUNKS` | It does not exist — `THETA_CHUNKS` is a module export. Every chunk pick became `NaN`, every chunk came out solid, and the bench reported confident, meaningless timings | Guard: assert picks are finite and straddle the surface |
| A fake GL with `shaderSource` in its no-op list | Uniform capture silently disabled; the uniform test passed vacuously | Assert a minimum lookup count, not just zero failures |

---

## 8. What I could not verify

Stated plainly, because an unverified change presented as done is worse than a
known gap.

**Verified** — 115 tests, all passing:

- Noise: distribution, isotropy, tileability, gradient-table integrity, `LAYER_STATS`
  re-measured from 5 seeds with a negative control confirming the test discriminates.
- Geometry: transforms, gravity, chunk/voxel keying, the θ seam, terrain roughness
  regressions, biome blend continuity.
- Player: collision, walking, jumping, wall blocking, step assist, camera basis.
- `main.js`: driven end-to-end in Node against a fake DOM and a recording WebGL2
  stub — boot, the chunk pipeline to the GPU, all 17 uniform bindings resolving
  against the shader sources they were linked with, input handling, and a
  GPU-handle leak check over 480 frames of walking.
- Shaders: 8 GLSL ES 3.00 sources pass 41 checks (`npm run shaders`) — version
  directive placement, brace balance, cross-stage varying interfaces, fragment
  colour targets, a real grammar parse under `@shaderfrog/glsl-parser` (installed
  as a devDependency), and vertex attribute locations cross-checked between the
  shader declarations and `renderer.js`'s `vertexAttribPointer` calls.
  Negative-tested: injecting `vertexAttribPointer(1, 3, …)` against a declared
  `vec4 aColor` fails 2 checks; declaring `vec3 aColor` fails 2 checks.

**Not verified** — no GL context and no browser were available:

- **Shaders have never been compiled or linked by a real driver.** The stub
  reports `COMPILE_STATUS`/`LINK_STATUS` as true unconditionally. The grammar
  parser catches *syntax* only: a type error (`vec3 x = someMat4`), an
  undeclared variable, or a precision-qualifier problem would pass every check
  in this repo and fail only on real hardware.
- **Anything visual.** Depth/cull behaviour, the sky's sun disc, fog, AO, the
  sun sphere seen from inside the deadzone — all unverified.
- **Pointer lock and real input.**
- **Performance in a browser.** The 6.7 ms/chunk figure is Node, single-threaded,
  no GPU upload cost.

---

## 9. Known unresolved segments

Each carries an `UNRESOLVED(tag)` annotation at its site — 11 distinct tags, 12
occurrences, listed by `grep -rn "UNRESOLVED(" src/`.

| tag | what is wrong | why it is not fixed |
| --- | --- | --- |
| `physics` | A uniform infinite cylindrical shell produces **zero** internal gravitational field, so the tube's gravity is authored, not derived | It is a spec requirement, not a physics result |
| `geometry` | Uniform angular columns make tangential voxel width `D_THETA·r`, so voxels thin toward the axis | Fixing it needs a non-uniform `i` spacing, which breaks the tileable noise periods |
| `lighting` | 1 voxel of chunk padding < the 15-step light reach, so long tunnels darken at chunk seams | Proper fix is a global cross-chunk light queue |
| `meshing` | Naive per-face mesher, no greedy merging | Merged quads on a cylinder are annular sectors, not planar |
| `picking` | `raycast` steps Cartesian unit cells against a cylindrical grid; accurate near the surface, drifts for long rays | Needs a true tube-space DDA |
| `cache` | Column patch cache is FIFO, not LRU — a player running straight evicts what they just used | Invisible at the current streaming radius |
| `cloud shadows` | A column counts as cloud-covered at its centre rather than by scanning the 92-voxel cloud band | Makes shadows slightly larger and softer than the clouds |
| `renderer` | No LOD, no worker offload, no merged chunk clusters | Fine at demo scale |
| `pipeline` | `main.js` scans every resident chunk per stage per frame | O(resident); needs a per-stage work queue |
| `player` | The spec's limb damage, permanent dismemberment and prone-rolling are **not implemented** — only the locomotion substrate they would read | Out of scope for the engine base |
| `main` | Browser-only surface: real shader compile/link, attribute locations, visuals, pointer lock | Needs a browser |

---

## 10. Out of scope, on purpose

The brief was to build the engine base with depth in the noise and the cylinder.
These are named so nobody mistakes their absence for an oversight:

**Outer Desert Sphere.** The spec's second structure — an outer sphere of desert
with oceans of liquid blood, enclosing the tube. Not modelled. `BLOCK.BLOOD`
exists as a reserved id and `_liquid()` documents that it is reserved for it,
but there is no geometry, no transform and no generation path. Adding it means a
second coordinate system and a second gravity law; the cylinder's transforms in
`cylinderGeometry.js` are written to generalise, but nothing here exercises them.

**Sub-voxel chiselling.** The spec's block editing is finer than one voxel. The
block table here is whole-voxel ids only, and `BLOCK_TABLE` deliberately carries
no gameplay fields (harvest time, drop table, tool tier, chisel profile) — those
belong in a layer above the engine. `World.setBlock` and the override map exist
and are tested, so whole-voxel editing works today; sub-voxel does not.

**Everything else in the spec**: moth avatar limbs, permanent dismemberment,
metabolism, pylons, bosses, multiplayer, the sleep minigame, and entities. The
player controller provides the locomotion substrate those systems would read
(`tubeCoords`, `onGround`, `inDeadzone`, the local-frame velocity) and nothing
more. See `UNRESOLVED(player)`.

---

## 11. Layout

```
ernas/
  index.html            demo page (WebGL2, pointer lock, HUD)
  package.json          type: module; test / bench / report scripts
  src/
    core/               rng.js (hashing, PRNGs)  math.js (mat4, frustum)
    noise/              perlin.js  fractal.js  index.js (layers + LAYER_STATS)
    world/              cylinderGeometry.js  blocks.js  generator.js
                        chunk.js  world.js  lighting.js  mesher.js
    render/             shaders.js (8 GLSL sources)  renderer.js
    player/             controller.js
    main.js             boot, frame loop, streaming budget, input, HUD
  tools/                bench.js  noise_report.js  check_shaders.js
  tests/                noise  cylinder  player  main_headless
                        _fakegl.js  _fakedom.js
```

Constants live in `WORLD` (`src/world/cylinderGeometry.js`); block ids in
`BLOCK` (`src/world/blocks.js`). Layer names are part of the save format —
layer seeds are `cyrb128(\`${seed}::layer::${name}\`)`, so renaming a layer
changes the world.
