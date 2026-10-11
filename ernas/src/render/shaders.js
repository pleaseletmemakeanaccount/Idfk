/**
 * ERNAS ENGINE — render/shaders.js
 * =====================================================================
 *  GLSL ES 3.00 sources.
 * =====================================================================
 *
 * IMPORTANT: `#version 300 es` must be the very first characters of the
 * string — no leading newline, no indent.  WebGL rejects the shader otherwise.
 * These are written with the directive flush-left on purpose, which is why the
 * template literals below look odd.
 *
 * Every source here is parse-checked by `tools/check_shaders.js` against
 * @shaderfrog/glsl-parser, so a typo fails in CI rather than as a black
 * screen in the browser.  (Parse-checked, not link-checked: the parser
 * validates syntax and declarations, not cross-stage interface matching.
 * See the note in ernas/README.md, "What I could not verify".)
 */

/* ================================================================== *
 * Chunk geometry
 * ================================================================== */

export const CHUNK_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColor;

uniform mat4 uViewProj;
uniform vec3 uCamPos;

out vec3 vTint;
out float vBright;
out float vDist;

void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vTint = aColor.rgb;
  vBright = aColor.a;
  vDist = distance(aPos, uCamPos);
}
`;

export const CHUNK_FRAG = `#version 300 es
precision highp float;

in vec3 vTint;
in float vBright;
in float vDist;

uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uExposure;

out vec4 outColor;

void main() {
  vec3 lit = vTint * (vBright * uExposure);

  // Quadratic fog: the tube is deep and a linear ramp washes out the
  // foreground long before the far side disappears.
  float span = max(uFogFar - uFogNear, 0.001);
  float f = clamp((vDist - uFogNear) / span, 0.0, 1.0);
  vec3 c = mix(lit, uFogColor, f * f);

  outColor = vec4(c, 1.0);
}
`;

/* ================================================================== *
 * Fullscreen background — interior atmosphere and sun glow
 * ================================================================== */

export const SKY_VERT = `#version 300 es
layout(location = 0) in vec2 aNdc;

out vec2 vNdc;

void main() {
  vNdc = aNdc;
  gl_Position = vec4(aNdc, 1.0, 1.0);
}
`;

export const SKY_FRAG = `#version 300 es
precision highp float;

in vec2 vNdc;

uniform vec3 uCamPos;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec3 uSunPos;
uniform vec3 uSunColor;
uniform vec3 uZenithColor;
uniform vec3 uNadirColor;
uniform float uAspect;
uniform float uTanHalfFov;
uniform float uSunRadius;
uniform float uTime;

out vec4 outColor;

void main() {
  vec3 dir = normalize(
    uForward
    + uRight * (vNdc.x * uAspect * uTanHalfFov)
    + uUp * (vNdc.y * uTanHalfFov)
  );

  // "Up" in this world is the tube axis direction from the camera, i.e.
  // straight inward.  The sky brightens toward it because that is where the
  // sun is, and darkens toward the crust behind the player.
  float r = length(uCamPos.xy);
  vec3 inward = r > 0.0001 ? vec3(-uCamPos.x / r, -uCamPos.y / r, 0.0) : vec3(0.0, 1.0, 0.0);
  float up = dot(dir, inward) * 0.5 + 0.5;
  vec3 sky = mix(uNadirColor, uZenithColor, pow(up, 1.4));

  // Sun disc plus a wide bloom.  The sun is a perfect sphere on the axis, so
  // its angular size falls off with distance to that axis point.
  vec3 toSun = uSunPos - uCamPos;
  float dSun = max(length(toSun), 0.0001);
  vec3 sunDir = toSun / dSun;
  float cosAng = dot(dir, sunDir);
  float ang = acos(clamp(cosAng, -1.0, 1.0));
  float angRadius = atan(uSunRadius, dSun);

  float disc = 1.0 - smoothstep(angRadius * 0.86, angRadius, ang);
  float bloom = exp(-ang / (angRadius * 7.0)) * 0.55;
  float pulse = 0.965 + 0.035 * sin(uTime * 0.7);

  vec3 c = sky;
  c += uSunColor * bloom * pulse;
  c = mix(c, uSunColor * 1.6, disc);

  outColor = vec4(c, 1.0);
}
`;

/* ================================================================== *
 * The sun sphere — a perfect geometric solid, deliberately NOT voxelised
 * ================================================================== */

export const SUN_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;

uniform mat4 uViewProj;
uniform vec3 uSunPos;
uniform float uSunRadius;

out vec3 vNormal;
out vec3 vWorld;

void main() {
  vec3 world = uSunPos + aPos * uSunRadius;
  gl_Position = uViewProj * vec4(world, 1.0);
  vNormal = aPos;
  vWorld = world;
}
`;

export const SUN_FRAG = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorld;

uniform vec3 uCamPos;
uniform vec3 uSunColor;
uniform float uTime;

out vec4 outColor;

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamPos - vWorld);

  // Limb brightening rather than the usual Lambert darkening: this is an
  // emitter, so the silhouette should read as the hottest part.
  float rim = 1.0 - abs(dot(n, v));
  float shimmer = 0.94 + 0.06 * sin(uTime * 1.3 + vWorld.z * 0.05);

  vec3 c = uSunColor * (0.85 + 1.35 * pow(rim, 2.2)) * shimmer;
  outColor = vec4(c, 1.0);
}
`;

/* ================================================================== *
 * Debug overlay — the gravity vector field and the deadzone shell
 * ================================================================== */

export const LINE_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColor;

uniform mat4 uViewProj;

out vec4 vColor;

void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vColor = aColor;
}
`;

export const LINE_FRAG = `#version 300 es
precision highp float;

in vec4 vColor;

out vec4 outColor;

void main() {
  outColor = vColor;
}
`;

/** Every source in this module, for the parser check. */
export const ALL_SHADERS = Object.freeze({
  CHUNK_VERT, CHUNK_FRAG,
  SKY_VERT, SKY_FRAG,
  SUN_VERT, SUN_FRAG,
  LINE_VERT, LINE_FRAG,
});
