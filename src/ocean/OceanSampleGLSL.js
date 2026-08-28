/**
 * Shared ocean field sampling: three FFT cascades + analytic disaster
 * modifiers (solitons, rogue groups, vortices, hurricane swell, currents).
 * Used by the surface material, the spray emitter and the buoyancy probes.
 */
export const OCEAN_SAMPLE_GLSL = /* glsl */ `
#ifndef OCEAN_SAMPLE_GLSL
#define OCEAN_SAMPLE_GLSL 1

uniform sampler2D uOceanDisp0, uOceanDisp1, uOceanDisp2;
uniform sampler2D uOceanDeriv0, uOceanDeriv1, uOceanDeriv2;
uniform sampler2D uOceanTurb0, uOceanTurb1, uOceanTurb2;
uniform vec3 uOceanScales;
uniform float uOceanTexels;
uniform float uOceanAniso;
uniform vec3 uCascadeGain;
uniform sampler2D uCurlTex;

uniform vec4 uVortex0, uVortex1, uVortex2, uVortex3;
uniform vec4 uSoliton0, uSoliton0b, uSoliton1, uSoliton1b;
uniform vec4 uRogue, uRogueB;
uniform vec4 uHurricane;
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform float uGustiness;
uniform float uEarthCurvature;
uniform float uSeaLevel;

const float EARTH_R = 6371000.0;

// ------------------------------------------------------------ current field
// Slowly varying divergence-free-ish flow used to advect the small cascades.
vec2 currentAt(vec2 p, float t) {
  vec2 uv = p * 0.00022 + vec2(t * 0.0009, -t * 0.0006);
  vec4 c = texture(uCurlTex, uv);
  vec2 f = (c.xy * 2.0 - 1.0);
  vec2 uv2 = p * 0.0009 - vec2(t * 0.0021, t * 0.0013);
  vec4 c2 = texture(uCurlTex, uv2);
  f += (c2.xy * 2.0 - 1.0) * 0.45;
  return f;
}

// ------------------------------------------------------------------ vortex
// Returns swirl rotation angle at p and writes the funnel depression.
float vortexField(vec2 p, vec4 v, inout float depression, inout float shear) {
  if (v.w <= 0.0001) return 0.0;
  vec2 d = p - v.xy;
  float r = length(d) + 1e-3;
  float R = max(v.z, 1.0);
  float x = r / R;
  // Rankine-like vortex: solid body inside the core, 1/r outside
  float vt = (x < 1.0) ? x : 1.0 / (x * x * 0.65 + 0.35);
  float env = exp(-x * x * 0.55);
  depression -= v.w * (1.0 / (1.0 + x * x * 2.2)) * 1.0;
  // Foam from shear saturates rather than tracking strength linearly: past a
  // point the surface is already fully broken and cannot get whiter. Without
  // the ceiling a forty metre maelstrom asks for four times full coverage and
  // the spiral arms merge into one disc of white paint.
  shear += vt * env * min(v.w * 0.022, 0.62);
  return vt * env * v.w * 0.09;
}

// ---------------------------------------------------------------- soliton
/**
 * Crest profile of the travelling solitary wave, normalised to a peak of one.
 *
 * x runs along the direction of travel, measured from the crest, so x > 0 is
 * the water the wave has not reached yet and the flank facing that way is the
 * one that breaks.
 *
 * A deep-water soliton is a symmetric sech^2 mound. At the amplitude a tsunami
 * really carries offshore that is a 1-in-40 slope — invisible from any camera
 * you would want to put in the shot, which is exactly why ships ride them out
 * without noticing. What everybody pictures is the shoaling form: the front has
 * run out of depth and stood up while the back is still in deep water.
 * Compressing the leading half of the coordinate reproduces that asymmetry
 * while staying a single smooth function of x, so normals, foam and the CPU
 * mirror all follow from it for free.
 *
 * Keep this in step with Director.eventHeight(), which evaluates the same
 * profile on the CPU for the camera to ride.
 */
float solitonProfile(float x, float w, float steep) {
  float xf = x > 0.0 ? x * (1.0 + steep * 1.35) : x;
  float s = 1.0 / cosh(clamp(xf / w, -12.0, 12.0));
  // Drawdown ahead of the face. The volume standing up in the crest has to come
  // from somewhere, and it comes from the water immediately in front — which is
  // the sea running out before it lands.
  float d = 1.0 / cosh(clamp((x - w * 1.6) / (w * 1.1), -12.0, 12.0));
  return s * s - d * d * 0.16 * steep;
}

float solitonHeight(vec2 p, vec4 s, vec4 sb, out vec2 pushDir, out float crest) {
  pushDir = vec2(0.0); crest = 0.0;
  if (s.w <= 0.001) return 0.0;
  vec2 dir = normalize(s.xy);
  float x = dot(p, dir) - s.z;
  float w = max(sb.x, 1.0);
  // lateral extent so the wave is a finite front, not infinite
  float lateral = dot(p, vec2(-dir.y, dir.x));
  float latEnv = exp(-lateral * lateral / (sb.z * sb.z + 1.0));

  float steep = sb.y;
  float prof = solitonProfile(x, w, steep);
  float h = s.w * prof * latEnv;

  // Overhang. Water near the crest is thrown forward over the face, which is
  // what a wave about to break looks like and what stops the wall reading as a
  // smooth ramp. Concentrating it in the top of the crest — prof squared, which
  // falls to nothing within a wave length — is what keeps it from translating
  // the whole neighbourhood bodily and tearing a hole under the camera.
  float top = clamp(prof, 0.0, 1.0);
  pushDir = dir * (top * top * min(s.w, w * 0.4) * steep * 0.28 * latEnv);

  // Foam belongs on the breaking lip and in the wash running down the face —
  // not spread over the whole shoulder, which reads as a painted slab rather
  // than as water. Keep it to the top of the profile and bias it forward.
  float faceBias = mix(0.25, 1.0, smoothstep(-w * 0.35, w * 0.2, x));
  crest = smoothstep(0.80, 0.985, prof) * latEnv * faceBias;
  return h;
}

// -------------------------------------------------------------- rogue group
float rogueGroup(vec2 p, out vec2 push, out float crest) {
  push = vec2(0.0); crest = 0.0;
  if (uRogue.w <= 0.001) return 0.0;
  vec2 d = p - uRogue.xy;
  float R = max(uRogue.z, 1.0);
  float env = exp(-dot(d, d) / (R * R));
  vec2 dir = normalize(uRogueB.xy + 1e-6);
  float k = 6.28318530718 / max(uRogueB.z, 4.0);
  float phase = dot(d, dir) * k + uRogueB.w;
  float h = 0.0;
  // three-mode Gerstner group -> peaky crest, flat trough
  h += cos(phase) * 1.0;
  h += cos(phase * 1.87 + 1.1) * 0.42;
  h += cos(phase * 0.61 - 0.7) * 0.55;
  h = h / 1.97;
  float peaky = sign(h) * pow(abs(h), 0.72);
  push = dir * (-sin(phase) * env * uRogue.w * 0.45);
  crest = smoothstep(0.55, 1.0, peaky) * env;
  return peaky * env * uRogue.w;
}

// ------------------------------------------------------------- hurricane
// Large rotating swell plus an eye of glassy calm.
float hurricaneField(vec2 p, out vec2 swirl, out float calm) {
  swirl = vec2(0.0); calm = 0.0;
  if (uHurricane.w <= 0.001) return 0.0;
  vec2 d = p - uHurricane.xy;
  float r = length(d) + 1e-3;
  float eye = max(uHurricane.z, 50.0);
  float x = r / eye;
  calm = exp(-x * x * 1.6);
  vec2 tang = vec2(-d.y, d.x) / r;
  float vt = (x < 1.0) ? x * 1.05 : 1.0 / pow(x, 0.55);
  swirl = tang * vt * uHurricane.w;
  // eyewall swell ring
  float ring = exp(-pow((x - 1.25) * 1.4, 2.0));
  return ring * uHurricane.w * 3.0 - calm * uHurricane.w * 0.4;
}

/**
 * Vertical-only disaster displacement. Mirrors oceanModifiers().y, minus the
 * horizontal push and the crest/calm outputs.
 *
 * The projected grid places samples by intersecting view rays with a flat
 * plane. That is a fine approximation for wind waves, which are metres tall,
 * and a terrible one for events that lift the surface by tens of metres: the
 * band of rays that lands on a tsunami is then a fraction of a degree wide, so
 * the wall is drawn by a handful of vertex rows however dense the grid is.
 * Iterating the intersection against this height restores a uniform
 * screen-space distribution, so it needs to be cheap.
 */
float oceanEventHeight(vec2 p) {
  float h = 0.0;

  vec4 vs[4];
  vs[0] = uVortex0; vs[1] = uVortex1; vs[2] = uVortex2; vs[3] = uVortex3;
  for (int i = 0; i < 4; i++) {
    if (vs[i].w <= 0.0001) continue;
    float x = (length(p - vs[i].xy) + 1e-3) / max(vs[i].z, 1.0);
    h -= vs[i].w / (1.0 + x * x * 2.2);
  }

  vec4 ss[2]; vec4 sbs[2];
  ss[0] = uSoliton0; sbs[0] = uSoliton0b;
  ss[1] = uSoliton1; sbs[1] = uSoliton1b;
  for (int i = 0; i < 2; i++) {
    if (ss[i].w <= 0.001) continue;
    vec2 dir = normalize(ss[i].xy);
    float x = dot(p, dir) - ss[i].z;
    float w = max(sbs[i].x, 1.0);
    float lateral = dot(p, vec2(-dir.y, dir.x));
    float latEnv = exp(-lateral * lateral / (sbs[i].z * sbs[i].z + 1.0));
    h += ss[i].w * solitonProfile(x, w, sbs[i].y) * latEnv;
  }

  if (uRogue.w > 0.001) {
    vec2 d = p - uRogue.xy;
    float R = max(uRogue.z, 1.0);
    float env = exp(-dot(d, d) / (R * R));
    vec2 dir = normalize(uRogueB.xy + 1e-6);
    float phase = dot(d, dir) * (6.28318530718 / max(uRogueB.z, 4.0)) + uRogueB.w;
    float g = (cos(phase) + cos(phase * 1.87 + 1.1) * 0.42 + cos(phase * 0.61 - 0.7) * 0.55) / 1.97;
    h += sign(g) * pow(abs(g), 0.72) * env * uRogue.w;
  }

  if (uHurricane.w > 0.001) {
    vec2 d = p - uHurricane.xy;
    float x = (length(d) + 1e-3) / max(uHurricane.z, 50.0);
    float ring = exp(-pow((x - 1.25) * 1.4, 2.0));
    h += ring * uHurricane.w * 3.0 - exp(-x * x * 1.6) * uHurricane.w * 0.4;
  }

  return h;
}

// ------------------------------------------------------- cascade fetching
struct OceanSample {
  vec3 disp;
  float jacobian;
  vec4 turb;       // foam, bubbles, crest, spray
  vec4 deriv;      // dYdx, dYdz, lambdaDxDx, lambdaDzDz
};

vec2 warpCoord(vec2 p, float t, float amount) {
  vec2 flow = currentAt(p, t);
  return p + flow * amount;
}

/** Vertex-side displacement with explicit LOD. */
vec3 oceanDisplacementLod(vec2 p, vec3 lods, out float foamHint) {
  vec3 d = vec3(0.0);
  foamHint = 0.0;
  if (uCascadeGain.x > 0.001) {
    vec4 s = textureLod(uOceanDisp0, p / uOceanScales.x, lods.x);
    d += s.xyz * uCascadeGain.x;
  }
  if (uCascadeGain.y > 0.001 && lods.y < 7.5) {
    vec4 s = textureLod(uOceanDisp1, p / uOceanScales.y, lods.y);
    d += s.xyz * uCascadeGain.y;
  }
  if (uCascadeGain.z > 0.001 && lods.z < 7.5) {
    vec4 s = textureLod(uOceanDisp2, p / uOceanScales.z, lods.z);
    d += s.xyz * uCascadeGain.z;
  }
  return d;
}

/** Full analytic modifier stack, shared by vertex + CPU-side probes. */
vec3 oceanModifiers(vec2 p, float t, out float crestOut, out float calmOut) {
  vec3 d = vec3(0.0);
  crestOut = 0.0;
  calmOut = 0.0;

  float depression = 0.0, shear = 0.0;
  float a0 = vortexField(p, uVortex0, depression, shear);
  float a1 = vortexField(p, uVortex1, depression, shear);
  float a2 = vortexField(p, uVortex2, depression, shear);
  float a3 = vortexField(p, uVortex3, depression, shear);
  d.y += depression;
  crestOut += shear;

  vec2 push; float crest;
  d.y += solitonHeight(p, uSoliton0, uSoliton0b, push, crest);
  d.xz += push; crestOut = max(crestOut, crest);
  d.y += solitonHeight(p, uSoliton1, uSoliton1b, push, crest);
  d.xz += push; crestOut = max(crestOut, crest);

  d.y += rogueGroup(p, push, crest);
  d.xz += push; crestOut = max(crestOut, crest);

  vec2 swirl; float calm;
  d.y += hurricaneField(p, swirl, calm);
  calmOut = calm;

  return d;
}

/** Rotation applied to cascade lookups so vortices actually swirl the water. */
vec2 swirlCoords(vec2 p, float t) {
  vec2 q = p;
  vec4 vs[4];
  vs[0] = uVortex0; vs[1] = uVortex1; vs[2] = uVortex2; vs[3] = uVortex3;
  for (int i = 0; i < 4; i++) {
    vec4 v = vs[i];
    if (v.w <= 0.0001) continue;
    vec2 d = q - v.xy;
    float r = length(d) + 1e-3;
    float R = max(v.z, 1.0);
    float x = r / R;
    float vt = (x < 1.0) ? x : 1.0 / (x * x * 0.6 + 0.4);
    float ang = vt * exp(-x * x * 0.5) * v.w * 0.05 * t;
    float c = cos(ang), s = sin(ang);
    q = v.xy + mat2(c, -s, s, c) * d;
  }
  if (uHurricane.w > 0.001) {
    vec2 d = q - uHurricane.xy;
    float r = length(d) + 1e-3;
    float x = r / max(uHurricane.z, 50.0);
    float vt = (x < 1.0) ? x : 1.0 / pow(max(x, 1e-3), 0.6);
    float ang = vt * uHurricane.w * 0.0015 * t;
    float c = cos(ang), s = sin(ang);
    q = uHurricane.xy + mat2(c, -s, s, c) * d;
  }
  return q;
}

float earthDrop(vec2 p, vec3 camPos) {
  float r2 = dot(p - camPos.xz, p - camPos.xz);
  return uEarthCurvature * r2 / (2.0 * EARTH_R);
}

#endif
`;
