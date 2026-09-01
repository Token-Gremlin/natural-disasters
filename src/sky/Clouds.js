import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { FullScreenPass, makeRT, PingPong } from '../gfx/FullScreenPass.js';
import { ATMO_COMMON } from './AtmosphereGLSL.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';
import { NOISE_GLSL } from '../gfx/NoiseGLSL.js';

/**
 * Raymarched volumetric cloud layer.
 *
 * Structure follows the Horizon: Zero Dawn / Nubis recipe, with one deliberate
 * change of emphasis: the 2D weather map, not the 3D shape volume, decides
 * where cloud is. The map is 1024² over ~40 km, so a cell footprint is drawn
 * at ~40 m resolution with a crisp, warped-worley outline. The 128³ shape
 * volume then only has to carve billows *inside* a footprint, where the
 * threshold sits in the middle of its distribution — never at the tail, which
 * is where a trilinear volume prints its own voxel lattice as bricks.
 *
 * Every low-resolution pixel is marched every frame with a per-frame jittered
 * start, and the result is accumulated temporally with reprojection along the
 * cloud's own depth. There is no checkerboard: the old 1/16-per-frame
 * amortisation could only ever converge with the camera locked, and stamped
 * its 4×4 grid over every silhouette the moment it moved.
 */

const PROBE_NDC = [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();

/**
 * Weather-map decoding, shared verbatim with the ocean's cloud-shadow term so
 * the shadow on the water is the cloud overhead and nothing else.
 * Returns (coverage 0..1, type 0..1, base lift, tallness 0..1).
 */
export const WEATHER_GLSL = /* glsl */ `
uniform sampler2D uWeatherMap;
uniform vec4  uWeatherLo;
uniform vec4  uWeatherHi;
uniform float uWeatherScaleM;   // metres per weather-map repeat
uniform float uCoverage;
uniform float uAnvil;
uniform vec2  uCloudWind;
uniform float uCloudTime;

vec4 weatherTex(vec2 uv) {
  // Explicit LOD, always: derivatives are meaningless inside a raymarch.
  return clamp((textureLod(uWeatherMap, uv, 0.0) - uWeatherLo) / (uWeatherHi - uWeatherLo), 0.0, 1.0);
}

vec4 weatherAt(vec2 xz) {
  vec2 w = xz + uCloudWind * uCloudTime * 0.6;
  vec4 m = weatherTex(w / uWeatherScaleM);
  // A second, finer read of the same map: the small cumulus that live in the
  // gaps between the big cells. It drifts a little differently so a system
  // evolves as it crosses the sky instead of sliding past rigidly.
  vec4 n = weatherTex(w / (uWeatherScaleM * 0.37) + vec2(0.37, 0.11)
                      - uCloudWind * uCloudTime * 0.00001);
  // Synoptic lanes: strong in a broken sky, gone in an overcast one. Baking
  // the product into the map made the lanes permanent holes that no coverage
  // setting could fill.
  float sc = smoothstep(0.40, 0.85, uCoverage);
  float lane = mix(0.45 + 0.55 * m.g, 1.0, sc);
  float field = (m.r * 0.66 + n.r * 0.34) * lane;

  // The map is percentile-normalised, so a threshold of (1 - coverage) covers
  // about that fraction of the sky. The edge is soft in field space, which in
  // world space is a ragged 100-300 m fringe rather than a cut line.
  float th = 1.0 - uCoverage;
  float c = smoothstep(th - 0.14, th + 0.10, field) * smoothstep(0.0, 0.04, uCoverage);
  // Cores of a cell are fuller than its fringe. This is also what keeps the 3D
  // threshold in the middle of the shape distribution inside a footprint.
  c *= 0.55 + 0.45 * smoothstep(th, min(th + 0.6, 1.0), field);

  // Type: 0 stratus, 0.5 cumulus, 1 cumulonimbus. Broken-to-overcast skies are
  // stratocumulus; towers appear only when the storm control asks for them,
  // and then only over the convective cores of a deep system.
  // Towers are things you see from outside: under a near-overcast storm the
  // sky is a nimbostratus ceiling, not a skyline, so the tower term fades out
  // with coverage and the deck thickens and darkens instead.
  float storm = smoothstep(0.45, 0.9, uAnvil);
  float type = 0.34 + 0.16 * m.g - 0.30 * sc
             + storm * (1.0 - sc) * (0.08 + 0.95 * m.a * smoothstep(0.35, 0.8, m.b));
  type = clamp(type, 0.0, 1.0);
  // Bases ride a little with the system and with the cell, so the floor is
  // not one geometric plane.
  float lift = (m.g - 0.5) * 0.10 + (n.g - 0.5) * 0.06;
  // How tall a cumulus this column can carry: only the big cells grow; the
  // small puffs between them stay squat.
  float tall = smoothstep(0.50, 1.0, m.b) * (1.0 - 0.55 * sc);
  return vec4(c, type, lift, tall);
}
`;

const CLOUD_COMMON = /* glsl */ `
uniform sampler3D uCloudShape;
uniform sampler3D uCloudDetail;
uniform sampler2D uCurlTex;
uniform vec4 uShapeLo;
uniform vec4 uShapeHi;
uniform vec4 uDetailLo;
uniform vec4 uDetailHi;

uniform float uCloudDensity;
uniform float uCloudBottom;
uniform float uCloudTop;
uniform float uCloudScaleM;    // metres per shape-volume repeat
uniform float uDetailScaleM;   // metres per detail-volume repeat
uniform float uSunIntensity;
uniform vec3  uSunDir;
uniform float uAmbientFlash;
uniform vec3  uLightningColor;
uniform vec4  uLightning0;
uniform vec4  uLightning1;

${WEATHER_GLSL}

vec3 gAmbTop = vec3(0.0);
vec3 gAmbBottom = vec3(0.0);

const float PLANET_R = 6360000.0;

float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) * (d - c) / max(b - a, 1e-5);
}

// normalise a baked channel onto its measured 2..98 percentile range
vec4 shapeTex(vec3 uvw) {
  return clamp((textureLod(uCloudShape, uvw, 0.0) - uShapeLo) / (uShapeHi - uShapeLo), 0.0, 1.0);
}
vec4 detailTex(vec3 uvw) {
  return clamp((textureLod(uCloudDetail, uvw, 0.0) - uDetailLo) / (uDetailHi - uDetailLo), 0.0, 1.0);
}

/**
 * Vertical density profile in layer units. type 0 = thin stratus sheet,
 * 0.5 = cumulus with a flat base and a rounded top, 1 = cumulonimbus tower
 * that fills the whole layer and flares into an anvil.
 */
float heightProfile(float h, float type) {
  // The base is a hard cut: cloud condenses at one altitude and a cumulus
  // base is flat. A soft rise here runs through the coverage threshold and
  // tapers every cell to a hanging point.
  float st = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.40, 1.0, h));
  float cu = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.45, 1.0, h));
  float cb = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.82, 1.0, h));
  float anvil = smoothstep(0.62, 0.78, h) * (1.0 - smoothstep(0.90, 1.0, h));
  cb = max(cb, anvil);
  float t = type * 2.0;
  return t < 1.0 ? mix(st, cu, t) : mix(cu, cb, clamp(t - 1.0, 0.0, 1.0));
}

// diagnostics
float gShapeR = 0.0;
float gBase = 0.0;
float gT0 = 0.0, gT1 = 0.0, gIters = 0.0, gSpent = 0.0, gCov = 0.0;
// ambient occlusion from the erosion field: crevices see less sky (HDRP trick)
float gAO = 1.0;

/** Two taps: is there any cloud in this column at all? Drives empty-space skipping. */
float columnCoverage(vec3 p, float h) {
  vec2 xz = p.xz + uCloudWind * uCloudTime * h * 1.2;
  return weatherAt(xz).x;
}

/**
 * @param p      planet-relative position (metres)
 * @param h      height through the layer, 0..1
 * @param detail erosion strength 0..2 (continuous so no LOD arc prints)
 */
float cloudDensity(vec3 p, float h, float detail) {
  // Wind shear: upper levels outrun the base, tilting towers and smearing anvils.
  vec3 q = p;
  q.xz += uCloudWind * uCloudTime * h * 1.2;

  vec4 wm = weatherAt(q.xz);
  float cov = wm.x;
  float type = wm.y;
  float cbness = clamp(type * 2.0 - 1.0, 0.0, 1.0);
  float stness = 1.0 - clamp(type * 2.0, 0.0, 1.0);
  // Anvils spread aloft, so the top of a mature cell covers more sky.
  cov = mix(cov, min(cov * 1.6 + 0.22, 1.0), smoothstep(0.62, 0.90, h) * cbness);
  gCov = max(gCov, cov);
  if (cov <= 0.002) return 0.0;

  // Vertical extent is a property of the cell, in metres, not a fraction of
  // whatever layer the weather asked for: a fair-weather cumulus tops out a
  // kilometre or two above its base whether the layer is 2 km or 6 km deep,
  // and only a cumulonimbus fills the layer. Fuller columns grow taller.
  float thickness = uCloudTop - uCloudBottom;
  float cuTop = mix(320.0, 1500.0, wm.w * wm.w);
  float topM = mix(mix(cuTop, 380.0, stness), thickness, cbness);
  // A rain deck is a kilometre or more thick, ragged underneath.
  topM *= 1.0 + 1.6 * smoothstep(0.45, 0.9, uAnvil) * smoothstep(0.40, 0.85, uCoverage);
  float hs = (h * thickness - wm.z * topM) / topM;
  if (hs <= 0.0 || hs >= 1.0) return 0.0;
  float prof = heightProfile(hs, type);
  if (prof <= 0.002) return 0.0;
  // Cells lean inward with height so a footprint becomes a dome, not a pillar.
  cov *= 1.0 - hs * mix(0.62, 0.25, cbness);

  // A tower is one billow kilometres across, not a stack of cumulus-sized
  // ones: the shape field is read at a coarser scale as the column matures.
  vec3 uvw = q / (uCloudScaleM * mix(1.0, 2.2, cbness));
  // Sub-voxel domain warp: moves the isosurface off the trilinear lattice so
  // a near-flat face does not print the volume's voxel terraces. Only the
  // view samples need it; the hunt and the light march skip the tap.
  vec3 warp = detail > 0.001 ? (detailTex(uvw * 9.0).rgb - 0.5) * 0.012 : vec3(0.0);
  vec4 shape = shapeTex(uvw + warp);
  float fbmLow = shape.g * 0.625 + shape.b * 0.25 + shape.a * 0.125;
  // Both channels are percentile-normalised, so this field is roughly uniform
  // on [0,1]: the coverage threshold below then removes a predictable fraction
  // of the volume. Perlin-worley keeps it connected; the worley fbm adds the
  // cauliflower lobes.
  float base = mix(shape.r, fbmLow, 0.35) * prof;
  gShapeR = max(gShapeR, shape.r);
  gBase = max(gBase, base);

  // Coverage was decided in 2D; here it sets how much of the billow field
  // survives inside the footprint. Even a full cell keeps ~40% of its volume
  // empty, which is what leaves it a surface with relief instead of a block.
  float ct = cov * 0.62;
  float d = remap(base, 1.0 - ct, 1.0, 0.0, 1.0);
  if (d <= 0.0) return 0.0;
  d *= smoothstep(0.0, 0.5, cov);

  float w1 = clamp(detail, 0.0, 1.0);
  if (w1 > 0.001) {
    // Curl-warped erosion: wispy at the base where the updraught shears,
    // cauliflower at the top where it punches through.
    vec2 curl = textureLod(uCurlTex, uvw.xz * 1.7, 0.0).rg * 2.0 - 1.0;
    vec3 dp = q / uDetailScaleM;
    dp.xz += curl * (1.0 - hs) * 0.08;
    vec3 det = detailTex(dp).rgb;
    float detFbm = det.r * 0.625 + det.g * 0.25 + det.b * 0.125;
    float mod3 = mix(detFbm, 1.0 - detFbm, clamp(hs * 4.0, 0.0, 1.0));
    gAO = 1.0 - sqrt(mod3 * 0.45) * w1;
    // Bites hardest at the silhouette, barely in the core: that is what turns
    // a smooth blob into billows without hollowing the cell out.
    float bite = mix(0.55, 0.12, smoothstep(0.15, 0.7, d));
    d = mix(d, remap(d, mod3 * bite, 1.0, 0.0, 1.0), w1);
    if (d <= 0.0) return 0.0;

    float w2 = clamp(detail - 1.0, 0.0, 1.0);
    if (w2 > 0.001) {
      vec3 fp = dp * 3.7;
      fp.xz += curl * 0.15;
      vec3 fine = detailTex(fp).rgb;
      float f = fine.r * 0.62 + fine.g * 0.26 + fine.b * 0.12;
      float fbite = mix(0.32, 0.05, smoothstep(0.2, 0.8, d));
      d = mix(d, remap(d, f * fbite, 1.0, 0.0, 1.0), w2);
      if (d <= 0.0) return 0.0;
    }
  }

  // Liquid water content climbs quickly above a flat base.
  float grad = mix(0.5, 1.0, smoothstep(0.0, 0.25, hs));
  return clamp(d, 0.0, 1.0) * grad * uCloudDensity;
}

vec2 shellIntersect(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

/**
 * Atmospheric extinction and in-scatter between the eye and the cloud, so
 * distant cells wash out into the horizon haze. Returns the premultiplied
 * layer colour for "sky * a + rgb" compositing.
 */
vec3 applyAerial(vec3 scatter, float transmittance, float dist, vec3 hazeColor) {
  if (dist <= 0.0) return scatter;
  vec3 beta = (vec3(5.802e-6, 13.558e-6, 33.1e-6) + vec3(3.996e-6) * uAtmoTurbidity) * 0.72;
  vec3 Ta = exp(-beta * dist);
  return scatter * Ta + hazeColor * (1.0 - Ta) * (1.0 - transmittance);
}

vec3 lightningGlow(vec3 p) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    vec4 l = (i == 0) ? uLightning0 : uLightning1;
    if (l.w <= 0.0001) continue;
    float d2 = dot(l.xyz - p, l.xyz - p);
    sum += uLightningColor * l.w * 6.0e6 / max(d2, 4.0e4);
  }
  return sum;
}
`;

const CLOUD_MARCH = /* glsl */ `
uniform int uSteps;
uniform int uLightSteps;
uniform sampler2D uSkyAmbLUT;
uniform vec3 uDetailFade;   // metres along the ray where the erosion octaves retire

void skyAmbient(vec3 viewPos, vec3 rd) {
  vec3 up = getValFromSkyLUT(uSkyAmbLUT, viewPos, vec3(0.0, 1.0, 0.0), uSunDir);
  vec3 side = getValFromSkyLUT(uSkyAmbLUT, viewPos, normalize(vec3(rd.x, 0.08, rd.z)), uSunDir);
  // The LUT is per unit solar irradiance. Averaged over the upper hemisphere
  // the sky is brighter than its zenith, hence the factor above one.
  gAmbTop = (up * 0.8 + side * 0.5) * uSunIntensity;
  // Under a deck the only light left is what leaks in sideways from the bright
  // ring at the horizon and bounces up off the water: dim, and blue-grey.
  gAmbBottom = (side * 0.28 + up * 0.08) * uSunIntensity * vec3(0.82, 0.88, 1.0);
}

// Extinction per unit density per metre. Real cumulus are 0.04-0.08/m.
// Rain-bearing cloud is denser and darker (HDRP runs 0.04 fair to 0.12 rain).
#define SIGMA (0.05 + 0.05 * uAnvil)

/**
 * Light reaching p from the sun, with a Wrenninge-style multiple-scattering
 * approximation (three octaves of successively dimmer, more penetrating
 * light) and Beer-Powder edge darkening.
 */
vec3 sampleLight(vec3 p, float mu, vec3 sunColor, float jitter, int steps) {
  vec3 ld = uSunDir;
  float stepLen = 22.0;
  float depth = 0.0;
  float travelled = stepLen * (0.3 + 0.4 * jitter);
  float thickness = uCloudTop - uCloudBottom;
  for (int i = 0; i < 8; i++) {
    if (i >= steps) break;
    travelled += stepLen;
    vec3 sp = p + ld * travelled;
    float sh = (length(sp) - (PLANET_R + uCloudBottom)) / thickness;
    if (sh > 1.0) break;
    depth += cloudDensity(sp, clamp(sh, 0.0, 1.0), 0.0) * stepLen;
    stepLen *= 1.65;
  }
  float od = depth * SIGMA;

  vec3 lum = vec3(0.0);
  float a = 1.0, b = 1.0, c = 1.0;
  // Powder: the crevices of a lit face are darker than the bulges because a
  // photon has to scatter more than once to leave them. Strongest looking
  // toward the sun, gone looking away.
  float powder = 1.0 - exp(-od * 2.0);
  float powderW = 0.55 * smoothstep(-0.4, 0.6, mu);
  for (int o = 0; o < 3; o++) {
    float beer = exp(-od * b);
    float phase = dualHG(mu, 0.80 * c, -0.28 * c, 0.5);
    lum += sunColor * a * phase * beer * mix(1.0, powder, powderW);
    a *= 0.55; b *= 0.45; c *= 0.6;
  }
  return lum;
}

/**
 * Two-speed raymarch: cheap strides (no erosion) hunt for the boundary, then
 * the ray backs up and integrates with short detailed steps.
 * @return vec4(scattered radiance, transmittance)
 * diag = (transmittance-weighted depth, peak raw shape, peak density, taps in cloud)
 */
vec4 marchClouds(vec3 ro, vec3 rd, float rayJitter, vec3 sunColor, out vec4 diag) {
  diag = vec4(-1.0, 0.0, 0.0, 0.0);
  vec3 center = vec3(0.0, -PLANET_R, 0.0);
  vec3 o = ro - center;

  float thickness = uCloudTop - uCloudBottom;
  float rInner = PLANET_R + uCloudBottom;
  float rOuter = PLANET_R + uCloudTop;
  vec2 tOuter = shellIntersect(o, rd, rOuter);
  if (tOuter.y < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec2 tInner = shellIntersect(o, rd, rInner);

  float t0, t1;
  float ro_r = length(o);
  if (ro_r < rInner) {
    if (tInner.y < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
    t0 = tInner.y; t1 = tOuter.y;
  } else if (ro_r < rOuter) {
    t0 = 0.0;
    t1 = (tInner.x > 0.0) ? tInner.x : tOuter.y;
  } else {
    t0 = max(tOuter.x, 0.0);
    t1 = (tInner.x > 0.0) ? tInner.x : tOuter.y;
  }
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);

  float maxDist = 90000.0;
  t1 = min(t1, t0 + maxDist);
  gT0 = t0; gT1 = t1;

  // Short enough that one step cannot swallow the optical depth of the ~20 m
  // skin where all the visible shading happens.
  float nearFine = clamp(thickness * 0.006, 16.0, 36.0);

  float mu = dot(rd, uSunDir);
  vec3 scatter = vec3(0.0);
  float transmittance = 1.0;
  float depthAcc = 0.0;
  float peakDensity = 0.0;

  float t = t0 + nearFine * rayJitter;
  float tPrev = t;
  bool inside = false;
  int emptyRun = 0;
  int spent = 0;

  for (int i = 0; i < 300; i++) {
    gIters = float(i);
    if (spent >= uSteps || t > t1 || transmittance < 0.005) break;
    float budget = float(uSteps - spent) / float(uSteps);
    // Distance relaxes the step because a far cell is a pixel wide; the budget
    // relaxes it only near the end so a long ray fades rather than cuts off.
    float fine = nearFine * clamp(1.0 + t / 7000.0, 1.0, 24.0)
               * (1.0 + 6.0 * (1.0 - smoothstep(0.0, 0.3, budget)));
    // The hunt stride is a fraction of the distance: at 30 km a 1 km stride is
    // still under a pixel, and without it a horizon ray burns the whole loop
    // walking 90 km of shell in cumulus-sized steps.
    // ...but never longer than the smallest cell it is hunting for, or the
    // jitter decides whether that cell exists and the deck turns to speckle.
    float stride = min(max(fine * 2.5, t * 0.035), 110.0 + t * 0.012);
    vec3 p = o + rd * t;
    float h = clamp((length(p) - rInner) / thickness, 0.0, 1.0);

    if (!inside) {
      // Empty column: the weather map says there is nothing here at any
      // height, so leap. Footprints are hundreds of metres wide and fringed,
      // so a 4x stride still lands inside the fringe before the core.
      if (columnCoverage(p, h) <= 0.002) { tPrev = t; t += stride * 2.0; continue; }
      if (cloudDensity(p, h, 0.0) > 0.0) {
        // The boundary lies between the last empty sample and this one:
        // rewind to there, re-jittered by one fine step so neighbouring rays
        // do not land on the same phase and print a comb.
        t = max(tPrev + fine * rayJitter, t0);
        inside = true;
        emptyRun = 0;
      } else {
        tPrev = t;
        t += stride;
      }
      continue;
    }

    float detail = 2.0 - smoothstep(uDetailFade.x, uDetailFade.y, t)
                       - smoothstep(uDetailFade.y, uDetailFade.z, t);
    float dens = cloudDensity(p, h, detail);
    peakDensity = max(peakDensity, dens);
    spent++;
    if (dens > 0.0005) {
      diag.w += 1.0;
      emptyRun = 0;

      int ls = transmittance > 0.3 ? uLightSteps : 2;
      vec3 lum = sampleLight(p, mu, sunColor, rayJitter, ls);

      // Skylight has to get down through whatever cloud stands above this
      // sample: two coarse taps give the dark base / bright shoulder gradient.
      float above = 0.0;
      {
        float span = max(thickness, 200.0);
        vec3 up = normalize(p);
        above += cloudDensity(p + up * span * 0.08, min(h + 0.08, 1.0), 0.0) * span * 0.16;
        above += cloudDensity(p + up * span * 0.30, min(h + 0.30, 1.0), 0.0) * span * 0.40;
      }
      float skyVis = mix(0.10, 1.0, exp(-above * SIGMA * 0.5));
      vec3 amb = mix(gAmbBottom, gAmbTop, smoothstep(0.0, 1.0, h)) * skyVis * gAO;
      lum += amb;
      lum += lightningGlow(p + center);
      lum += uAmbientFlash * uLightningColor * 0.25;

      float tr = exp(-dens * SIGMA * fine);
      float w = transmittance * (1.0 - tr);
      scatter += lum * w;
      depthAcc += t * w;
      transmittance *= tr;
    } else if (++emptyRun > 4) {
      inside = false;
    }
    tPrev = t;
    t += fine;
  }

  float opacity = 1.0 - transmittance;
  diag.x = opacity > 0.002 ? depthAcc / opacity : -1.0;
  diag.y = gShapeR;
  diag.z = max(gBase, peakDensity);
  gSpent = float(spent);
  return vec4(scatter, transmittance);
}
`;

/** Marches every low-resolution pixel, jittered per frame. */
const CLOUD_FRAG = /* glsl */ `
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec2 uLowRes;
uniform float uFrame;
uniform int uCloudDebug;

${ATMO_COMMON}
${SHADING_GLSL}
${NOISE_GLSL}
${CLOUD_COMMON}
${CLOUD_MARCH}

uniform sampler2D uTransmittanceLUT;
uniform sampler2D uSkyViewLUT;

in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oDepth;

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 p0 = uInvViewProj * vec4(ndc, -1.0, 1.0); p0 /= p0.w;
  vec4 p1 = uInvViewProj * vec4(ndc,  1.0, 1.0); p1 /= p1.w;
  vec3 rd = normalize(p1.xyz - p0.xyz);

  // Below the horizon the ocean covers everything: nearly half the frame.
  // Only valid while the camera is under the deck: from above, the clouds
  // are between the eye and the sea.
  float dip = -sqrt(2.0 * max(uCamPos.y, 0.0) / 6360000.0) - 0.003;
  if (rd.y < dip && uCamPos.y < uCloudBottom) {
    oColor = vec4(0.0, 0.0, 0.0, 1.0);
    oDepth = vec4(-1.0, 0.0, 0.0, 0.0);
    return;
  }

  vec3 viewPos = vec3(0.0, groundRadiusMM + max(uCamPos.y, 0.2) * 1e-6, 0.0);
  vec3 sunColor = getValFromTLUT(uTransmittanceLUT, viewPos, uSunDir) * uSunIntensity;
  skyAmbient(viewPos, rd);

  vec4 diag;
  // Interleaved gradient noise, rotated every frame: neighbours decorrelate
  // spatially and each pixel walks a different phase over time, so the
  // temporal accumulation integrates a genuinely supersampled ray.
  float jitter = ignTemporal(gl_FragCoord.xy, uFrame);
  vec4 cl = marchClouds(uCamPos, rd, jitter, sunColor, diag);

  vec3 haze = getValFromSkyLUT(uSkyViewLUT, viewPos, rd, uSunDir) * uSunIntensity;
  cl.rgb = applyAerial(cl.rgb, cl.a, diag.x, haze);

  if (uCloudDebug > 0) {
    vec3 v = (uCloudDebug == 1)
      ? vec3(gT0 / 40000.0, gIters / 300.0, gCov)
      : vec3(gSpent / float(uSteps), diag.z, diag.x / 60000.0);
    oColor = vec4(clamp(v, 0.0, 1.0), 1.0);
    oDepth = diag;
    return;
  }
  oColor = cl;
  oDepth = diag;
}
`;

/**
 * Temporal accumulation. History is reprojected along this pixel's own cloud
 * depth, clamped to the 3×3 neighbourhood of the fresh march, and blended.
 */
const CLOUD_TEMPORAL_FRAG = /* glsl */ `
uniform sampler2D uCur;
uniform sampler2D uCurDiag;
uniform sampler2D uHistory;
uniform sampler2D uHistoryDiag;
uniform mat4 uPrevViewProj;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec2 uInvRes;
uniform vec2 uRes;
uniform float uReset;
uniform float uBlend;
uniform float uShellMid;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oDiag;

// Catmull-Rom history fetch as nine bilinear taps collapsed to four: a plain
// bilinear history read blurs a little more every frame and the deck turns to
// fog under a slow pan.
vec4 sampleHistory(vec2 uv) {
  vec2 pos = uv * uRes - 0.5;
  vec2 base = floor(pos);
  vec2 f = pos - base;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = f2 - 0.5 * (f3 + f);
  vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
  vec2 w3 = 0.5 * (f3 - f2);
  vec2 w2 = 1.0 - w0 - w1 - w3;
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 t0 = (base - 0.5 + w1 / s0) * uInvRes;
  vec2 t1 = (base + 1.5 + w3 / s1) * uInvRes;
  return texture(uHistory, vec2(t0.x, t0.y)) * (s0.x * s0.y)
       + texture(uHistory, vec2(t1.x, t0.y)) * (s1.x * s0.y)
       + texture(uHistory, vec2(t0.x, t1.y)) * (s0.x * s1.y)
       + texture(uHistory, vec2(t1.x, t1.y)) * (s1.x * s1.y);
}

void main(){
  ivec2 lp = ivec2(gl_FragCoord.xy);
  vec4 cur = texelFetch(uCur, lp, 0);
  vec4 curDiag = texelFetch(uCurDiag, lp, 0);

  if (uReset > 0.5) { oColor = cur; oDiag = curDiag; return; }

  // Reproject along the cloud's own depth; where the ray found nothing the
  // shell midpoint stands in, which is right for the sky behind a cell edge.
  float dist = curDiag.x > 0.0 ? curDiag.x : uShellMid;
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 p0 = uInvViewProj * vec4(ndc, -1.0, 1.0); p0 /= p0.w;
  vec4 p1 = uInvViewProj * vec4(ndc,  1.0, 1.0); p1 /= p1.w;
  vec3 rd = normalize(p1.xyz - p0.xyz);
  vec4 prevClip = uPrevViewProj * vec4(uCamPos + rd * dist, 1.0);
  if (prevClip.w <= 0.0) { oColor = cur; oDiag = curDiag; return; }
  vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
  if (any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) {
    oColor = cur; oDiag = curDiag; return;
  }

  vec4 hist = sampleHistory(prevUv);
  vec4 histDiag = texture(uHistoryDiag, prevUv);

  // Neighbourhood clamp, loose enough not to fight the jitter's own variance.
  vec4 lo = cur, hi = cur;
  ivec2 mx = ivec2(uRes) - 1;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec4 s = texelFetch(uCur, clamp(lp + ivec2(x, y), ivec2(0), mx), 0);
    lo = min(lo, s); hi = max(hi, s);
  }
  vec4 tol = (hi - lo) * 0.6 + vec4(0.015, 0.015, 0.015, 0.03);
  hist = clamp(hist, lo - tol, hi + tol);

  // A large depth disagreement means the history belonged to a different
  // cloud (a cell edge slid across this pixel): trust the fresh sample more.
  float dm = abs(histDiag.x - curDiag.x) / max(dist, 1.0);
  float alpha = mix(uBlend, 1.0, smoothstep(0.25, 0.8, dm) * float(histDiag.x > 0.0 && curDiag.x > 0.0));

  oColor = mix(hist, cur, alpha);
  oDiag = mix(histDiag, curDiag, alpha);
}
`;

/** Catmull-Rom upsample from the low buffer to screen. */
const CLOUD_UPSAMPLE_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uInvSrc;
uniform vec2 uSrcRes;
in vec2 vUv;
layout(location = 0) out vec4 oColor;

vec4 bicubic(vec2 uv) {
  vec2 pos = uv * uSrcRes - 0.5;
  vec2 base = floor(pos);
  vec2 f = pos - base;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = f2 - 0.5 * (f3 + f);
  vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
  vec2 w3 = 0.5 * (f3 - f2);
  vec2 w2 = 1.0 - w0 - w1 - w3;
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 t0 = (base - 0.5 + w1 / s0) * uInvSrc;
  vec2 t1 = (base + 1.5 + w3 / s1) * uInvSrc;
  return texture(uSrc, vec2(t0.x, t0.y)) * (s0.x * s0.y)
       + texture(uSrc, vec2(t1.x, t0.y)) * (s1.x * s0.y)
       + texture(uSrc, vec2(t0.x, t1.y)) * (s0.x * s1.y)
       + texture(uSrc, vec2(t1.x, t1.y)) * (s1.x * s1.y);
}

void main(){
  vec4 c = bicubic(vUv);
  c.a = clamp(c.a, 0.0, 1.0);
  oColor = max(c, vec4(0.0));
}
`;

const CLOUD_ENV_FRAG = /* glsl */ `
uniform vec3 uCamPos;
uniform float uFrame;

${ATMO_COMMON}
${SHADING_GLSL}
${NOISE_GLSL}
${CLOUD_COMMON}
${CLOUD_MARCH}

uniform sampler2D uTransmittanceLUT;
uniform sampler2D uSkyViewLUT;

in vec2 vUv;
layout(location = 0) out vec4 oColor;

void main(){
  vec3 rd = equirectToDir(vUv);
  if (rd.y < -0.02) { oColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 viewPos = vec3(0.0, groundRadiusMM + max(uCamPos.y, 0.2) * 1e-6, 0.0);
  vec3 sunColor = getValFromTLUT(uTransmittanceLUT, viewPos, uSunDir) * uSunIntensity;
  skyAmbient(viewPos, rd);

  vec4 diag;
  vec4 cl = marchClouds(uCamPos, rd, hash12(gl_FragCoord.xy + uFrame), sunColor, diag);
  vec3 haze = getValFromSkyLUT(uSkyViewLUT, viewPos, rd, uSunDir) * uSunIntensity;
  cl.rgb = applyAerial(cl.rgb, cl.a, diag.x, haze);
  oColor = cl;
}
`;

/**
 * With the eye above the cloud base the deck sits between it and the sea, and
 * the ocean mesh paints over the layer the sky pass composited. This
 * full-screen triangle re-applies the layer after the ocean, premultiplied
 * (dst * a + rgb), on rays that hit the sea. Sky rays already carry it.
 */
const OVER_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;
const OVER_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uCloudTex;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 p0 = uInvViewProj * vec4(ndc, -1.0, 1.0); p0 /= p0.w;
  vec4 p1 = uInvViewProj * vec4(ndc,  1.0, 1.0); p1 /= p1.w;
  vec3 rd = normalize(p1.xyz - p0.xyz);
  // same horizon test the marcher uses: below it the ray meets the sea
  float dip = -sqrt(2.0 * max(uCamPos.y, 0.0) / 6360000.0) - 0.003;
  if (rd.y >= dip) discard;
  vec4 cl = texture(uCloudTex, vUv);
  oColor = vec4(max(cl.rgb, vec3(0.0)), clamp(cl.a, 0.0, 1.0));
  // ONE / SRC_ALPHA blending leaves the velocity buffer untouched
  oVelocity = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

export class Clouds {
  constructor(renderer, atmosphere, textures, quality) {
    this.renderer = renderer;
    this.atmosphere = atmosphere;
    this.enabled = true;
    this.frame = 0;
    this.reset = true;

    const pct = (tex) => {
      const p = tex?.userData?.percentiles;
      return p
        ? [new THREE.Vector4(...p.lo), new THREE.Vector4(...p.hi)]
        : [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(1, 1, 1, 1)];
    };
    const [shapeLo, shapeHi] = pct(textures.cloudShape);
    const [detLo, detHi] = pct(textures.cloudDetail);
    const [wLo, wHi] = pct(textures.weather);

    this.shared = {
      uCloudShape: { value: textures.cloudShape },
      uCloudDetail: { value: textures.cloudDetail },
      uShapeLo: { value: shapeLo }, uShapeHi: { value: shapeHi },
      uDetailLo: { value: detLo }, uDetailHi: { value: detHi },
      uWeatherLo: { value: wLo }, uWeatherHi: { value: wHi },
      uCurlTex: U.uCurlTex,
      uWeatherMap: { value: textures.weather },
      uWeatherScaleM: { value: 56000 },
      uCoverage: { value: 0.4 },
      uCloudDensity: { value: 0.6 },
      uCloudBottom: { value: 1200 },
      uCloudTop: { value: 5200 },
      uAnvil: { value: 0.0 },
      uCloudWind: { value: new THREE.Vector2(6, 2) },
      uCloudTime: { value: 0 },
      // A billow is a few hundred metres across; the shape volume repeats
      // every 6 km so its lowest worley octave is ~1.5 km and its voxels ~47 m.
      uCloudScaleM: { value: 6000 },
      uDetailScaleM: { value: 700 },
      // kept for callers that still poke it; no longer read by the shaders
      uCloudContrast: { value: 1.0 },
      // screen-space layer + "eye is above the base" flag, read by the ocean
      uCloudTex: { value: null },
      uCloudOver: { value: 0 },
      uSunIntensity: U.uSunIntensity,
      uSunDir: U.uSunDir,
      uSkyAmbLUT: { value: atmosphere.skyViewRT.texture },
      uAmbientFlash: U.uAmbientFlash,
      uLightningColor: U.uLightningColor,
      uLightning0: U.uLightning0,
      uLightning1: U.uLightning1,
      uTransmittanceLUT: { value: atmosphere.transmittanceRT.texture },
      uSkyViewLUT: { value: atmosphere.skyViewRT.texture },
      uAtmoTurbidity: U.uAtmoTurbidity,
      uAtmoMieG: U.uAtmoMieG,
      uAtmoGroundAlbedo: U.uAtmoGroundAlbedo,
      uSteps: { value: 64 },
      uLightSteps: { value: 6 },
    };

    this.marchPass = new FullScreenPass(CLOUD_FRAG, {
      ...this.shared,
      uInvViewProj: U.uInvViewProjNJ,
      uCamPos: U.uCamPos,
      uLowRes: { value: new THREE.Vector2(1, 1) },
      uFrame: U.uFrame,
      // Each erosion octave retires where its features fall under ~2 pixels;
      // past that it only adds sub-pixel aliasing the temporal pass then has
      // to average away as grain.
      uDetailFade: { value: new THREE.Vector3(2500, 9000, 30000) },
      uCloudDebug: { value: 0 },
    }, { name: 'cloudMarch' });

    this.temporalPass = new FullScreenPass(CLOUD_TEMPORAL_FRAG, {
      uCur: { value: null }, uCurDiag: { value: null },
      uHistory: { value: null }, uHistoryDiag: { value: null },
      uPrevViewProj: U.uPrevViewProjNJ, uInvViewProj: U.uInvViewProjNJ,
      uCamPos: U.uCamPos,
      uInvRes: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() },
      uReset: { value: 1 }, uBlend: { value: 0.08 },
      uShellMid: { value: 20000 },
    }, { name: 'cloudTemporal' });

    this.upsamplePass = new FullScreenPass(CLOUD_UPSAMPLE_FRAG, {
      uSrc: { value: null }, uInvSrc: { value: new THREE.Vector2() },
      uSrcRes: { value: new THREE.Vector2() },
    }, { name: 'cloudUpsample' });

    this.envPass = new FullScreenPass(CLOUD_ENV_FRAG, {
      ...this.shared,
      uCamPos: U.uCamPos,
      uFrame: U.uFrame,
      uSteps: { value: 18 },
      uLightSteps: { value: 3 },
      uDetailFade: { value: new THREE.Vector3(1500, 4000, 12000) },
    }, { name: 'cloudEnv' });

    const overGeom = new THREE.BufferGeometry();
    overGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    overGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    overGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    this.overMaterial = new THREE.RawShaderMaterial({
      name: 'CloudOverOcean', glslVersion: THREE.GLSL3,
      vertexShader: OVER_VERT, fragmentShader: OVER_FRAG,
      uniforms: { uCloudTex: this.shared.uCloudTex, uInvViewProj: U.uInvViewProjNJ, uCamPos: U.uCamPos },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.overMesh = new THREE.Mesh(overGeom, this.overMaterial);
    this.overMesh.frustumCulled = false;
    this.overMesh.renderOrder = 4;   // after the ocean (0), before spout (5) and particles
    this.overMesh.visible = false;

    this.setQuality(quality);
  }

  setQuality(q) {
    this.scale = q.cloudScale;
    this.enabled = q.cloudEnabled;
    this.marchPass.uniforms.uSteps.value = q.cloudSteps;
    this.marchPass.uniforms.uLightSteps.value = q.cloudLightSteps;
    this.envPass.uniforms.uSteps.value = q.envCloudSteps;
    this.envSize = Math.max(64, Math.floor(q.envSize / 2));
    if (this.envRT && this.envRT.width !== this.envSize) {
      this.envRT.dispose();
      this.envRT = null;
    }
    if (!this.envRT) {
      this.envRT = makeRT(this.envSize, this.envSize / 2, {
        type: THREE.HalfFloatType, name: 'cloudEnv', wrap: THREE.RepeatWrapping,
      });
      this.envRT.texture.wrapS = THREE.RepeatWrapping;
      this.envRT.texture.wrapT = THREE.ClampToEdgeWrapping;
    }
    if (this.fullW) this.setSize(this.fullW, this.fullH, true);
  }

  setSize(w, h, force = false) {
    const lw = Math.max(16, Math.round(w * this.scale));
    const lh = Math.max(16, Math.round(h * this.scale));
    if (!force && this.lowW === lw && this.lowH === lh) return;
    this.fullW = w; this.fullH = h;
    this.lowW = lw; this.lowH = lh;

    this.curRT?.dispose();
    this.history?.dispose();
    this.fullRT?.dispose();

    this.curRT = makeRT(lw, lh, { type: THREE.HalfFloatType, count: 2, name: 'cloudCur' });
    this.history = new PingPong(lw, lh, { type: THREE.HalfFloatType, count: 2, name: 'cloudHist' });
    this.fullRT = makeRT(w, h, { type: THREE.HalfFloatType, name: 'cloudFull' });
    this.shared.uCloudTex.value = this.fullRT.texture;
    this.marchPass.uniforms.uLowRes.value.set(lw, lh);
    this.temporalPass.uniforms.uRes.value.set(lw, lh);
    this.temporalPass.uniforms.uInvRes.value.set(1 / lw, 1 / lh);
    this.reset = true;
  }

  /** Worst-case reprojection shift in low-res texels; used for the HUD only. */
  _reprojectionShift(dist) {
    const inv = U.uInvViewProjNJ.value;
    const prev = U.uPrevViewProjNJ.value;
    const cam = U.uCamPos.value;
    let worst = 0;
    for (const p of PROBE_NDC) {
      _pa.set(p[0], p[1], -1).applyMatrix4(inv);
      _pb.set(p[0], p[1], 1).applyMatrix4(inv);
      _pb.sub(_pa).normalize().multiplyScalar(dist).add(cam).applyMatrix4(prev);
      if (!Number.isFinite(_pb.x) || !Number.isFinite(_pb.y)) return 1e3;
      const du = (_pb.x - p[0]) * 0.5 * this.lowW;
      const dv = (_pb.y - p[1]) * 0.5 * this.lowH;
      worst = Math.max(worst, Math.hypot(du, dv));
    }
    return worst;
  }

  /** @param {number} time seconds */
  update(time, dt) {
    if (!this.enabled) return;
    const r = this.renderer;
    const s = this.shared;
    s.uCloudTime.value = time;
    s.uCloudOver.value = (U.uCamPos.value.y > s.uCloudBottom.value) ? 1 : 0;
    this.overMesh.visible = s.uCloudOver.value === 1;
    this.frame++;

    this.marchPass.render(r, this.curRT);

    const mid = (s.uCloudBottom.value + s.uCloudTop.value) * 0.5;
    this.temporalPass
      .set('uCur', this.curRT.textures[0])
      .set('uCurDiag', this.curRT.textures[1])
      .set('uHistory', this.history.read.textures[0])
      .set('uHistoryDiag', this.history.read.textures[1])
      .set('uReset', (this.reset || this.forceReset) ? 1 : 0)
      .set('uShellMid', Math.max(mid, 500) * 6.0);
    this.temporalPass.render(r, this.history.write);
    this.history.swap();

    this.upsamplePass.set('uSrc', this.history.read.textures[0]);
    this.upsamplePass.uniforms.uInvSrc.value.set(1 / this.lowW, 1 / this.lowH);
    this.upsamplePass.uniforms.uSrcRes.value.set(this.lowW, this.lowH);
    this.upsamplePass.render(r, this.fullRT);

    if (this.frame % 8 === 0 || this.reset) this.envPass.render(r, this.envRT);
    this.reset = false;
  }

  get screenTexture() { return this.enabled ? this.fullRT.texture : null; }
  get envTexture() { return this.enabled ? this.envRT.texture : null; }

  dispose() {
    this.curRT?.dispose(); this.history?.dispose();
    this.fullRT?.dispose(); this.envRT?.dispose();
  }
}
