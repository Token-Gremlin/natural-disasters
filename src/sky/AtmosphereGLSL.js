/**
 * Shared atmosphere GLSL (Bruneton/Hillaire style, megametre units).
 * Included by the LUT builders, the sky pass, the cloud pass and the ocean shader.
 */
export const ATMO_COMMON = /* glsl */ `
#ifndef ATMO_COMMON
#define ATMO_COMMON 1

#define PI_A 3.14159265358979323846

const float groundRadiusMM = 6.360;
const float atmosphereRadiusMM = 6.460;

// per-megametre coefficients
const vec3  rayleighScatteringBase = vec3(5.802, 13.558, 33.100);
const float rayleighAbsorptionBase = 0.0;
const float mieScatteringBase = 3.996;
const float mieAbsorptionBase = 4.40;
const vec3  ozoneAbsorptionBase = vec3(0.650, 1.881, 0.085);

uniform float uAtmoTurbidity;   // 1 = clear, up to ~12 in a storm
uniform float uAtmoMieG;
uniform vec3  uAtmoGroundAlbedo;

float rayIntersectSphere(vec3 ro, vec3 rd, float rad) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rad * rad;
  if (c > 0.0 && b > 0.0) return -1.0;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  if (disc > b * b) return (-b + sqrt(disc));
  return -b - sqrt(disc);
}

void scatteringValues(vec3 pos, out vec3 rayleighScattering, out float mieScattering, out vec3 extinction) {
  float altitudeKM = (length(pos) - groundRadiusMM) * 1000.0;
  float rayleighDensity = exp(-altitudeKM / 8.0);
  float mieDensity = exp(-altitudeKM / 1.2);

  float turb = uAtmoTurbidity;
  rayleighScattering = rayleighScatteringBase * rayleighDensity;
  float rayleighAbsorption = rayleighAbsorptionBase * rayleighDensity;

  mieScattering = mieScatteringBase * turb * mieDensity;
  float mieAbsorption = mieAbsorptionBase * turb * mieDensity;

  vec3 ozoneAbsorption = ozoneAbsorptionBase * max(0.0, 1.0 - abs(altitudeKM - 25.0) / 15.0);

  extinction = rayleighScattering + rayleighAbsorption + mieScattering + mieAbsorption + ozoneAbsorption;
}

float miePhase(float cosTheta) {
  const float scale = 3.0 / (8.0 * PI_A);
  float g = uAtmoMieG;
  float g2 = g * g;
  float num = (1.0 - g2) * (1.0 + cosTheta * cosTheta);
  float denom = (2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
  return scale * num / denom;
}

float rayleighPhase(float cosTheta) {
  const float k = 3.0 / (16.0 * PI_A);
  return k * (1.0 + cosTheta * cosTheta);
}

// ------------------------------------------------- transmittance LUT lookup
vec3 getValFromTLUT(sampler2D tex, vec3 pos, vec3 sunDir) {
  float height = length(pos);
  vec3 up = pos / height;
  float sunCosZenithAngle = dot(sunDir, up);
  vec2 uv = vec2(
    clamp(0.5 + 0.5 * sunCosZenithAngle, 0.0, 1.0),
    clamp((height - groundRadiusMM) / (atmosphereRadiusMM - groundRadiusMM), 0.0, 1.0));
  return texture(tex, uv).rgb;
}

vec3 getValFromMultiScattLUT(sampler2D tex, vec3 pos, vec3 sunDir) {
  float height = length(pos);
  vec3 up = pos / height;
  float sunCosZenithAngle = dot(sunDir, up);
  vec2 uv = vec2(
    clamp(0.5 + 0.5 * sunCosZenithAngle, 0.0, 1.0),
    clamp((height - groundRadiusMM) / (atmosphereRadiusMM - groundRadiusMM), 0.0, 1.0));
  return texture(tex, uv).rgb;
}

// --------------------------------------------------- sky-view LUT mapping
// Non-linear in view zenith so the horizon keeps its detail.
vec2 skyViewUV(vec3 viewPos, vec3 rayDir, vec3 sunDir) {
  float height = length(viewPos);
  vec3 up = viewPos / height;
  float horizonAngle = acos(clamp(sqrt(max(height * height - groundRadiusMM * groundRadiusMM, 0.0)) / height, -1.0, 1.0)) - 0.5 * PI_A;
  float altitudeAngle = asin(clamp(dot(rayDir, up), -1.0, 1.0)) - horizonAngle;

  vec3 right = normalize(cross(sunDir, up));
  vec3 forward = normalize(cross(up, right));
  vec3 projected = normalize(rayDir - up * dot(rayDir, up));
  float sinTheta = dot(projected, right);
  float cosTheta = dot(projected, forward);
  float azimuth = atan(sinTheta, cosTheta) + PI_A;

  float v;
  if (altitudeAngle < 0.0) {
    v = 0.5 - 0.5 * sqrt(max(-altitudeAngle / (0.5 * PI_A + horizonAngle), 0.0));
  } else {
    v = 0.5 + 0.5 * sqrt(max(altitudeAngle / (0.5 * PI_A - horizonAngle), 0.0));
  }
  return vec2(azimuth / (2.0 * PI_A), clamp(v, 0.0, 1.0));
}

vec3 getValFromSkyLUT(sampler2D tex, vec3 viewPos, vec3 rayDir, vec3 sunDir) {
  // Explicit LOD, always. The azimuth coordinate wraps from 1 back to 0 in the
  // span of one pixel, so an implicit lookup sees a screen-space derivative of
  // ~1 there and jumps to the top of the mip chain — a hairline dark column
  // running from the zenith to the horizon on whichever bearing the wrap lands.
  return textureLod(tex, skyViewUV(viewPos, rayDir, sunDir), 0.0).rgb;
}
vec3 getValFromSkyLUTLod(sampler2D tex, vec3 viewPos, vec3 rayDir, vec3 sunDir, float lod) {
  return textureLod(tex, skyViewUV(viewPos, rayDir, sunDir), lod).rgb;
}

#endif
`;

export const ATMO_RAYMARCH = /* glsl */ `
vec3 raymarchScattering(sampler2D tLUT, sampler2D msLUT, vec3 pos, vec3 rayDir, vec3 sunDir,
                        float tMax, float numSteps) {
  float cosTheta = dot(rayDir, sunDir);
  float miePhaseValue = miePhase(cosTheta);
  float rayleighPhaseValue = rayleighPhase(-cosTheta);

  vec3 lum = vec3(0.0);
  vec3 transmittance = vec3(1.0);
  float t = 0.0;
  for (float i = 0.0; i < numSteps; i += 1.0) {
    float newT = ((i + 0.3) / numSteps) * tMax;
    float dt = newT - t;
    t = newT;

    vec3 newPos = pos + t * rayDir;

    vec3 rayleighScattering, extinction;
    float mieScattering;
    scatteringValues(newPos, rayleighScattering, mieScattering, extinction);

    vec3 sampleTransmittance = exp(-dt * extinction);

    vec3 sunTransmittance = getValFromTLUT(tLUT, newPos, sunDir);
    vec3 psiMS = getValFromMultiScattLUT(msLUT, newPos, sunDir);

    vec3 rayleighInScattering = rayleighScattering * (rayleighPhaseValue * sunTransmittance + psiMS);
    vec3 mieInScattering = vec3(mieScattering) * (miePhaseValue * sunTransmittance + psiMS);
    vec3 inScattering = rayleighInScattering + mieInScattering;

    vec3 scatteringIntegral = (inScattering - inScattering * sampleTransmittance) / max(extinction, vec3(1e-7));

    lum += scatteringIntegral * transmittance;
    transmittance *= sampleTransmittance;
  }
  return lum;
}
`;
