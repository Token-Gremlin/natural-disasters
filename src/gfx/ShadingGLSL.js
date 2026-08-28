/** Shared BRDF / tone / utility GLSL. */
export const SHADING_GLSL = /* glsl */ `
#ifndef SHADING_GLSL
#define SHADING_GLSL 1

#define PI_S 3.14159265358979323846
#define TAU_S 6.28318530717958647692

vec2 dirToEquirect(vec3 d) {
  return vec2(atan(d.z, d.x) / TAU_S + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI_S);
}
vec3 equirectToDir(vec2 uv) {
  float phi = (uv.x - 0.5) * TAU_S;
  float theta = uv.y * PI_S;
  float st = sin(theta);
  return vec3(st * cos(phi), cos(theta), st * sin(phi));
}

/**
 * Mean cosine-weighted radiance of the upper hemisphere of an equirect probe.
 *
 * Nine taps on a heavily blurred mip: enough for an ambient term, and because
 * it reads the same probe the reflections use, an overcast deck darkens the
 * water and a break in the clouds brightens it with no extra bookkeeping.
 * Multiply by an albedo to get the diffuse response (the 1/pi and the pi in the
 * irradiance cancel).
 */
vec3 skyIrradiance(sampler2D env, float maxLod) {
  float lod = max(maxLod - 1.0, 0.0);
  vec3 sum = textureLod(env, vec2(0.5, 0.02), lod).rgb;
  float w = 1.0;
  for (int i = 0; i < 4; i++) {
    float a = (float(i) + 0.5) * 0.25;
    sum += textureLod(env, vec2(a, 0.25), lod).rgb * 0.7071;          // 45 deg
    sum += textureLod(env, vec2(a + 0.125, 0.40), lod).rgb * 0.3090;  // 18 deg
    w += 1.0161;
  }
  return sum / w;
}

float ggxD(float NoH, float a) {
  float a2 = a * a;
  float d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / max(PI_S * d * d, 1e-8);
}

float smithGGXCorrelated(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-6);
}

float fresnelWater(float NoV, float roughness) {
  float f = 0.02 + 0.98 * pow(clamp(1.0 - NoV, 0.0, 1.0), 5.0);
  // rough surfaces lose the sharp grazing peak
  return mix(f, clamp(f * 0.72 + 0.06, 0.0, 1.0), clamp(roughness * 1.5, 0.0, 1.0));
}

float schlick(float cosTheta, float f0) {
  return f0 + (1.0 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

float henyeyGreenstein(float cosT, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI_S * pow(max(1.0 + g2 - 2.0 * g * cosT, 1e-4), 1.5));
}
float dualHG(float cosT, float g0, float g1, float w) {
  return mix(henyeyGreenstein(cosT, g0), henyeyGreenstein(cosT, g1), w);
}

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// ---------------------------------------------------------------- lightning
// Two concurrent strokes, inverse-square with a soft core; used by every
// surface shader so a bolt lights the whole scene consistently.
vec3 lightningContribution(vec3 worldPos, vec3 N, vec3 V, vec4 l0, vec4 l1, vec3 tint) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    vec4 l = (i == 0) ? l0 : l1;
    if (l.w <= 0.0001) continue;
    vec3 d = l.xyz - worldPos;
    float dist2 = dot(d, d);
    vec3 Ld = d * inversesqrt(max(dist2, 1e-4));
    float atten = l.w * 4.0e5 / max(dist2, 900.0);
    float ndl = clamp(dot(N, Ld) * 0.65 + 0.35, 0.0, 1.0);
    vec3 H = normalize(Ld + V);
    float spec = pow(max(dot(N, H), 0.0), 220.0) * 2.4;
    sum += tint * atten * (ndl + spec);
  }
  return sum;
}

// --------------------------------------------------------------- tonemapping
vec3 agxDefaultContrastApprox(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return  15.5 * x4 * x2
        - 40.14 * x4 * x
        + 31.96 * x4
        - 6.868 * x2 * x
        + 0.4298 * x2
        + 0.1191 * x
        - 0.00232;
}

vec3 agx(vec3 val) {
  const mat3 agx_mat = mat3(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const float min_ev = -12.47393;
  const float max_ev = 4.026069;
  val = agx_mat * val;
  val = clamp(log2(max(val, 1e-10)), min_ev, max_ev);
  val = (val - min_ev) / (max_ev - min_ev);
  return agxDefaultContrastApprox(val);
}
vec3 agxEotf(vec3 val) {
  const mat3 agx_mat_inv = mat3(
     1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  return agx_mat_inv * val;
}
vec3 agxLook(vec3 val, float sat, vec3 slope, vec3 power, float offset) {
  float luma = luminance(val);
  val = pow(max(val * slope + offset, vec3(0.0)), power);
  return luma + sat * (val - luma);
}

vec3 acesFitted(vec3 x) {
  const mat3 ACESInputMat = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777);
  const mat3 ACESOutputMat = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602);
  x = ACESInputMat * x;
  vec3 a = x * (x + 0.0245786) - 0.000090537;
  vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;
  x = a / b;
  return clamp(ACESOutputMat * x, 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

#endif
`;
