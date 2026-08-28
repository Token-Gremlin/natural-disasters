import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { FullScreenPass, makeRT, PingPong } from '../gfx/FullScreenPass.js';
import { ATMO_COMMON } from './AtmosphereGLSL.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';
import { NOISE_GLSL } from '../gfx/NoiseGLSL.js';

/**
 * Raymarched volumetric cloud layer.
 *
 * The layer is a spherical shell around the planet so it curves down to the
 * horizon instead of ending in a flat plate. Density comes from the baked
 * Perlin-Worley 3D volume, eroded by a smaller worley volume; lighting uses a
 * short march toward the sun with a Beer-Powder term, dual-lobe HG phase and a
 * three-octave multiple-scattering approximation.
 *
 * Cost is controlled by rendering at a fraction of screen resolution and
 * reprojecting the previous frame, so only a slice of the rays is new work.
 */

// Screen centre plus the four corners: enough to catch a pan, a dolly and a
// roll without running a full motion-vector pass for one scalar.
const PROBE_NDC = [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();

const CLOUD_COMMON = /* glsl */ `
uniform sampler3D uCloudShape;
uniform sampler3D uCloudDetail;
uniform sampler2D uCurlTex;
uniform sampler2D uWeatherMap;
uniform float uWeatherScaleM;   // metres per weather-map repeat
uniform vec4 uShapeLo;
uniform vec4 uShapeHi;
uniform vec4 uDetailLo;
uniform vec4 uDetailHi;

uniform float uCoverage;
uniform float uCloudDensity;
uniform float uCloudBottom;
uniform float uCloudTop;
uniform float uAnvil;
uniform float uStorm;
uniform vec2  uCloudWind;
uniform float uCloudTime;
uniform float uCloudScaleM;    // metres per shape-texture repeat
uniform float uCloudAspect;    // vertical squash: how many cells fit in the deck
uniform float uCloudContrast;  // how hard the weather map breaks the deck up
uniform float uSunIntensity;
uniform vec3  uSunDir;
uniform float uAmbientFlash;

// Skylight reaching the deck, in the same units as everything else in the
// frame. Written once per fragment from the sky LUT rather than carried as a
// uniform, because an ad-hoc ambient constant is impossible to keep in step
// with the sun's intensity and leaves storm cloud undersides pure black.
vec3 gAmbTop = vec3(0.0);
vec3 gAmbBottom = vec3(0.0);
uniform vec3  uLightningColor;
uniform vec4  uLightning0;
uniform vec4  uLightning1;

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
 * Vertical density profile. The type parameter runs 0 = flat stratus slab,
 * 0.5 = fair weather cumulus, 1 = full cumulonimbus tower with an anvil.
 */
float heightProfile(float h, float type) {
  // Blend where the profile rises and falls, not two already-evaluated curves.
  // Averaging a low stratus slab against a taller cumulus gives a curve that
  // never reaches 1 — above h=0.38 the old blend capped at 0.6, and since the
  // coverage threshold sits near 0.9 that made cloud *impossible* up there. The
  // deck collapsed into flat-lidded slabs all topping out at one altitude,
  // because the only thing still clearing the threshold was the narrow band
  // where both curves happened to overlap.
  float t = clamp(type * 2.0, 0.0, 1.0);
  float rise = mix(0.05, 0.13, t);       // stratus base is crisper than cumulus
  float fallFrom = mix(0.16, 0.48, t);   // where the shoulders start eroding
  float fallTo = mix(0.38, 0.95, t);     // and where nothing is left
  float lo = smoothstep(0.0, rise, h) * (1.0 - smoothstep(fallFrom, fallTo, h));

  // column that punches the whole deck and flares into an anvil
  float tower = smoothstep(0.0, 0.04, h) * (1.0 - smoothstep(0.88, 1.0, h));
  float anvil = smoothstep(0.58, 0.74, h) * (1.0 - smoothstep(0.90, 1.0, h));
  float cb = max(tower * 0.9, anvil);

  return mix(lo, cb, clamp(type * 2.0 - 1.0, 0.0, 1.0));
}

/**
 * Large-scale organisation. A real sky is never statistically uniform: cells
 * come in clusters and bands tens of kilometres across with clear lanes
 * between them, and that structure is most of what the eye uses to judge
 * whether a cloudscape is real. Returns (coverage, type, base lift).
 */
vec3 weatherAt(vec2 xz) {
  // The map drifts as a whole and the cells inside it drift again, so a system
  // evolves as it crosses the sky instead of sliding past rigidly.
  // Explicit level, always. Screen-space derivatives inside a raymarch loop are
  // meaningless — neighbouring fragments are at different steps, or have exited
  // entirely — and letting the hardware pick a mip from them tears the deck
  // along hard seams wherever the chosen level happens to change.
  vec2 w = xz + uCloudWind * uCloudTime * 0.6;
  vec4 m = textureLod(uWeatherMap, w / uWeatherScaleM, 0.0);
  vec4 n = textureLod(uWeatherMap, w / (uWeatherScaleM * 0.27)
                 + vec2(0.37, 0.11) - uCloudWind * uCloudTime * 0.00002, 0.0);

  float field = m.r * 0.62 + m.g * 0.22 + n.g * 0.16;
  // Contrast pivots about the requested coverage: uCoverage says how much sky
  // is cloud, the field says where. Narrowing that spread near the ends is
  // tempting but wrong — it starves exactly the light-coverage case, where each
  // surviving cell is already only a few shape voxels across and turns to
  // cubes. Instead only the zero itself is gated, because the pivot alone lets
  // an above-average field manufacture cloud out of a request for none, and
  // "clear sky" has to actually clear.
  float cover = clamp((field - 0.5) * uCloudContrast + uCoverage, 0.0, 1.0)
              * smoothstep(0.0, 0.05, uCoverage);
  // Cloud type: 0 is a flat stratus slab, 0.5 a fair-weather cumulus, 1 a
  // cumulonimbus tower. Fair weather is made of cumulus, so the floor sits
  // there and the storm control lifts the deepest cells into towers. Running
  // the whole range off uAnvil meant a clear day was drawn as a field of
  // stratus pancakes — the right density in entirely the wrong shape.
  float type = clamp(0.30 + 0.20 * m.b + uAnvil * (0.34 + 0.55 * m.b + 0.6 * m.a), 0.0, 1.0);
  // How far this column's whole profile rides above or below the nominal deck.
  // Without it the base is a geometric plane at a constant altitude, and once
  // coverage is high enough to close the gaps an observer underneath sees a
  // featureless grey ceiling — which is why an overcast storm can end up
  // reading as flat haze while the same cloud model looks fine at a distance.
  float lift = (n.r * 0.6 + m.g * 0.4 - 0.5) * 0.34;
  return vec3(cover, type, lift);
}

// diagnostics: last raw shape value / post-threshold base, read by the probe
float gShapeR = 0.0;
float gBase = 0.0;
// march internals, written unconditionally and only read when uCloudDebug asks
float gT0 = 0.0, gT1 = 0.0, gIters = 0.0, gSpent = 0.0, gCov = 0.0;

/**
 * @param detail how much erosion to apply, 0..2. Continuous on purpose: a hard
 *   LOD switch changes the density, not just its frequency content, and since
 *   the switch happens at a fixed distance it stamps a sharp arc across the sky
 *   wherever the deck crosses it.
 */
float cloudDensity(vec3 p, float h, float detail) {
  // Higher layers outrun the base: the shear is what tilts a tower downwind
  // and smears its anvil, and it costs nothing.
  vec3 q = p;
  q.xz += uCloudWind * uCloudTime * (0.6 + h * 1.5);

  vec3 wm = weatherAt(q.xz);
  float type = wm.y;
  // Anvils spread aloft, so the top of a mature cell covers far more sky — but
  // only a mature cell does. Keyed on plain cumulus this lays a translucent
  // sheet across the entire top of the deck and the sky hazes over.
  float anvilness = smoothstep(0.62, 1.0, type);
  float cov = mix(wm.x, min(wm.x * 1.8 + 0.24, 1.0), smoothstep(0.55, 0.88, h) * anvilness);
  gCov = max(gCov, cov);
  if (cov <= 0.01) return 0.0;

  // Ride the whole profile up or down with the system. heightProfile is zero
  // outside the unit interval, so this carves a ragged base and top rather than
  // merely fading the slab.
  float hs = h - wm.z;
  if (hs <= 0.0 || hs >= 1.0) return 0.0;

  vec3 uvw = q / uCloudScaleM;
  uvw.y *= uCloudAspect;
  // Scattered cloud slices the top few percent of the shape field, and the
  // maxima of a trilinearly interpolated 128^3 volume are its own voxel corners
  // — so at low coverage the sky came out as a field of axis-aligned bricks. A
  // domain warp finer than that lattice moves the isosurface off it without
  // touching the value distribution, so coverage still means what it says.
  vec3 warp = (detailTex(uvw * 11.0).rgb - 0.5) * 0.011;
  vec4 shape = shapeTex(uvw + warp);

  float fbmLow = shape.g * 0.625 + shape.b * 0.25 + shape.a * 0.125;
  // Schneider's dilation: widen the perlin-worley field by its own fbm so the
  // billows stay connected instead of breaking into popcorn
  float base = remap(shape.r, fbmLow * 0.92 - 1.0, 1.0, 0.0, 1.0);
  base *= heightProfile(hs, type);
  gShapeR = max(gShapeR, shape.r);
  gBase = max(gBase, base);

  // Coverage sweeps a threshold across the base distribution. The dilation
  // above lifts the mean of base well past 0.5, so the sweep still has to start
  // near 1.0 for zero coverage to mean a genuinely empty sky. What it must not
  // do is spend the low end of its travel up in the tail: sliced above ~0.85 a
  // cell is only three or four shape-texture voxels across, and a trilinear
  // blob that small is a rounded box that no amount of erosion can rescue. The
  // gamma keeps both endpoints exact and gets off the tail quickly, so light
  // coverage means a few real cumulus rather than a field of bricks.
  float d = remap(base, mix(0.99, 0.20, pow(cov, 0.67)), 1.0, 0.0, 1.0);
  if (d <= 0.0) return 0.0;

  // A cloud is not a soft blob: liquid water content ramps up fast just inside
  // the boundary. The smoothstep puts that hard edge back, which is most of
  // what separates "convincing cumulus" from "grey smudge".
  d = d * d * (3.0 - 2.0 * d);

  float w1 = clamp(detail, 0.0, 1.0);
  if (w1 > 0.001) {
    // Curl-distorted erosion: wispy tendrils at the base where the updraught
    // shears, cauliflower billows at the top where it punches through.
    vec2 curl = textureLod(uCurlTex, uvw.xz * 3.1, 0.0).rg * 2.0 - 1.0;
    vec3 dp = q / (uCloudScaleM * 0.2);
    dp.xz += curl * (1.0 - h) * 3.5;
    vec3 det = detailTex(dp).rgb;
    float detFbm = det.r * 0.625 + det.g * 0.25 + det.b * 0.125;
    float mod3 = mix(1.0 - detFbm, detFbm, clamp(h * 4.0, 0.0, 1.0));
    // Erosion bites hardest at the silhouette and barely at all in the core,
    // which is what turns a smooth blob into billows. It used to be capped low
    // so the boundary could not flicker between amortisation phases — but the
    // cure for that belongs in the resolve, and paying for it here meant never
    // carving a shape in the first place.
    float bite = mix(0.78, 0.14, smoothstep(0.20, 0.78, d));
    d = mix(d, remap(d, mod3 * bite, 1.0, 0.0, 1.0), w1);
    if (d <= 0.0) return 0.0;

    float w2 = clamp(detail - 1.0, 0.0, 1.0);
    if (w2 > 0.001) {
      // The octave that actually reads as cauliflower: tens of metres across,
      // on the lit shoulders. Warped by the curl again at a different rate so
      // it never sits in register with the octave above it.
      vec3 fp = dp * 3.1;
      fp.xz += curl * 0.9;
      vec3 fine = detailTex(fp).rgb;
      float f = fine.r * 0.62 + fine.g * 0.26 + fine.b * 0.12;
      float fbite = mix(0.46, 0.08, smoothstep(0.25, 0.85, d));
      d = mix(d, remap(d, f * fbite, 1.0, 0.0, 1.0), w2);
      if (d <= 0.0) return 0.0;
    }
  }

  return clamp(d, 0.0, 1.0) * uCloudDensity;
}

/** Intersect a ray with a sphere of radius r centred at the planet core. */
vec2 shellIntersect(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

/**
 * Folds atmospheric extinction between the eye and the cloud into the layer,
 * so distant cells wash out into the horizon haze exactly like the real thing.
 * Returns the premultiplied layer colour for "sky * a + rgb" compositing.
 */
vec3 applyAerial(vec3 scatter, float transmittance, float dist, vec3 hazeColor) {
  if (dist <= 0.0) return scatter;
  // sea-level extinction, thinned a little for the altitude of the deck
  vec3 beta = (vec3(5.802e-6, 13.558e-6, 33.1e-6)
             + vec3(3.996e-6) * uAtmoTurbidity) * 0.72;
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
// Ranges over which the two erosion octaves fade out, in metres along the ray.
uniform vec3 uDetailFade;

/**
 * Skylight arriving at the deck, split into what reaches the tops and what
 * crawls in under the base. Both come straight out of the sky LUT so they
 * track sunset, overcast and night without any hand-tuned constants.
 */
void skyAmbient(vec3 viewPos, vec3 rd) {
  vec3 up = getValFromSkyLUT(uSkyAmbLUT, viewPos, vec3(0.0, 1.0, 0.0), uSunDir);
  // Under a deck the only light comes in sideways from the bright ring at the
  // horizon, then bounces once off the water on its way up.
  vec3 side = getValFromSkyLUT(uSkyAmbLUT, viewPos,
                normalize(vec3(rd.x, 0.07, rd.z)), uSunDir);
  // Skylight is blue and comes from everywhere, so it is also the term that
  // flattens a cloud. Too much of it and a sunlit cumulus reads as a pale blue
  // smudge with no lit side and no shaded side — which is not a lighting bug
  // you can tonemap your way out of, it is the shape disappearing.
  gAmbTop = up * uSunIntensity * 1.45;
  // Still generous. A deck kilometres thick is optically opaque, so a strictly
  // single-scattering base integrates to black and the overcast stops reading
  // as weather and starts reading as night. The light is really there: it
  // arrives sideways from the bright ring under the deck edge and is piped
  // through the cloud by high-order scattering the light march truncates.
  gAmbBottom = (side * 0.50 + up * 0.15) * uSunIntensity * vec3(0.80, 0.88, 1.0);
}

// Extinction per unit density per metre. Real cumulus sit around 0.05/m, which
// makes a 500 m cell optically thick enough to hide the sun completely; we run
// a little under that because the raymarch cannot afford steps short enough to
// resolve the ~20 m skin where all the visible shading actually happens.
const float SIGMA = 0.022;

/**
 * Energy-conserving multiple-scattering approximation (Wrenninge octaves).
 * Light taps grow exponentially so a handful of samples still cover the deck.
 */
vec3 sampleLight(vec3 p, float mu, vec3 sunColor, float selfDensity, float jitter, int steps) {
  vec3 ld = uSunDir;
  float thickness = uCloudTop - uCloudBottom;
  float stepLen = thickness * 0.045;
  float depth = 0.0;
  // Small: the shadow march is smooth, so jitter here buys almost no banding
  // relief and costs visible noise in the lighting.
  float travelled = stepLen * (0.25 + 0.3 * jitter);
  for (int i = 0; i < 8; i++) {
    if (i >= steps) break;
    travelled += stepLen;
    vec3 sp = p + ld * travelled;
    float sh = clamp((length(sp) - (PLANET_R + uCloudBottom)) / thickness, 0.0, 1.0);
    // base octave only: the shadow of a wisp is not worth a 3D texture fetch
    depth += cloudDensity(sp, sh, 0.0) * stepLen;
    stepLen *= 1.62;
  }

  vec3 lum = vec3(0.0);
  float a = 1.0, b = 1.0, c = 1.0;
  for (int o = 0; o < 3; o++) {
    float beer = exp(-depth * SIGMA * b);
    // Powder: light that scattered back out of a dense edge before it could be
    // absorbed. It is the thing that makes a sunlit cumulus edge read as solid
    // rather than translucent, and it must key off the LOCAL density, not the
    // path integral, or it darkens the whole cloud instead of its rim.
    float powder = 1.0 - exp(-selfDensity * 14.0);
    float phase = dualHG(mu, 0.82 * c, -0.32 * c, 0.55);
    lum += sunColor * a * phase * beer * mix(1.0, powder, 0.6);
    // Successive octaves stand for light that has already bounced: each one is
    // dimmer but penetrates much further, and it is that long tail that keeps
    // the inside of a thick cell luminous grey instead of black. The tail has
    // to keep decaying though — at b = 0.09 the third octave barely attenuates
    // at all, so it acts as a second flat ambient and erases the very gradient
    // between the lit shoulder and the shaded flank it exists to soften.
    a *= 0.5; b *= 0.42; c *= 0.68;
  }
  return lum;
}

/**
 * Two-speed raymarch: long cheap strides (no detail octave) hunt for the cloud
 * boundary, then we back up and integrate with short detailed steps. Leaving a
 * cell reverts to striding. This is what makes a 4 km deck affordable at
 * horizon distances where the ray can cover 200 km inside the shell.
 *
 * @return vec4(scattered radiance, transmittance)
 */
vec4 marchClouds(vec3 ro, vec3 rd, float rayJitter, vec3 sunColor, out vec4 diag) {
  // diag = (first-hit distance, peak raw shape, peak density, taps inside cloud)
  diag = vec4(-1.0, 0.0, 0.0, 0.0);
  float depthOut = -1.0;
  float peakDensity = 0.0;
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

  // Beyond this the deck is a few pixels tall on the horizon and the aerial
  // perspective has already washed it into the haze, so marching further only
  // buys banding.
  float maxDist = 140000.0;
  t1 = min(t1, t0 + maxDist);
  float span = t1 - t0;
  gT0 = t0; gT1 = t1;

  // Fine steps resolve the cell; they have to stay short enough that a single
  // step cannot swallow the whole optical depth, or the visible skin of the
  // cloud collapses to one flat sample. Tying this to the deck thickness would
  // make a 12 km storm deck step in 250 m chunks, which is exactly the case
  // where the skin matters most. Distance relaxes it because a far cell is a
  // pixel wide anyway.
  float nearFine = clamp(thickness * 0.005, 22.0, 48.0);

  float mu = dot(rd, uSunDir);
  vec3 scatter = vec3(0.0);
  float transmittance = 1.0;

  float t = t0 + nearFine * rayJitter;
  bool inside = false;
  int emptyRun = 0;
  int spent = 0;

  for (int i = 0; i < 512; i++) {
    gIters = float(i);
    if (spent >= uSteps || t > t1 || transmittance < 0.004) break;
    // Sample spacing is a quality decision and must not be stretched to make
    // the ray reach the far shell: a 500 m step swallows the whole optical
    // depth of a storm cell in one go, which flattens its skin to a single
    // sample and turns the ray-start jitter into salt-and-pepper noise.
    // Instead the step only grows once the budget is nearly gone, smoothly,
    // so a ray that runs long fades out rather than cutting off.
    float budget = float(uSteps - spent) / float(uSteps);
    float fine = nearFine * clamp(1.0 + t / 9000.0, 1.0, 22.0)
               * (1.0 + 7.0 * (1.0 - smoothstep(0.0, 0.35, budget)));
    // The stride is what hunts for the cloud boundary, so it cannot be longer
    // than the features it is hunting for: stride past a wisp and the ray
    // reports empty, and whether it does depends on the jitter, which is
    // precisely how a cloud edge turns into salt-and-pepper. Distance growth
    // is compounding, so this still reaches 140 km in about 120 taps.
    float stride = fine * 3.0;
    vec3 p = o + rd * t;
    float h = clamp((length(p) - rInner) / thickness, 0.0, 1.0);

    if (!inside) {
      if (cloudDensity(p, h, 0.0) > 0.0) {
        // Rewind to just before the boundary. The rewind lands on a grid that
        // is nearly identical for neighbouring rays, so without re-jittering
        // here the sample phase correlates across the screen and prints a comb
        // of stripes across every cloud face. One fine step of jitter is enough
        // to break that up; a whole stride just turns the comb into noise.
        t = max(t - stride + fine * rayJitter, t0);
        inside = true;
        emptyRun = 0;
      } else {
        t += stride;
      }
      continue;
    }

    // Detail octaves retire when what they carve stops resolving. Retiring the
    // fine octave at a kilometre and a bit — nearer than the cloud base itself
    // — meant every cloud in the sky was drawn from the base shape alone, and a
    // 128-cell volume stretched over seven kilometres holds nothing smaller
    // than a three-hundred-metre blob. That, and not the march resolution, is
    // what made the deck read as cotton wool.
    float detail = 2.0 - smoothstep(uDetailFade.x, uDetailFade.y, t)
                       - smoothstep(uDetailFade.y, uDetailFade.z, t);
    float dens = cloudDensity(p, h, detail);
    peakDensity = max(peakDensity, dens);
    spent++;
    if (dens > 0.0005) {
      diag.w += 1.0;
      emptyRun = 0;
      if (depthOut < 0.0) depthOut = t;

      // Once the cloud in front has eaten most of the light, nothing behind it
      // is resolvable, so the light march can drop to a couple of taps.
      int ls = transmittance > 0.25 ? uLightSteps : 2;
      vec3 lum = sampleLight(p, mu, sunColor, dens, rayJitter, ls);
      // Ambient: sky from above, ocean-tinted bounce from below, attenuated by
      // how deep inside the deck we are — that vertical gradient is what gives
      // a cloud its dark base and bright shoulders.
      // Skylight has to fight its way down through whatever cloud stands above
      // this sample. Without this the ambient term is the same everywhere along
      // the base and an overcast deck integrates to a flat grey sheet: the
      // relief is all there in the geometry, but nothing shades it. Two coarse
      // taps are enough, because what matters is the difference between a
      // sample under two hundred metres of cloud and one under two kilometres.
      float above = 0.0;
      {
        float span = max(uCloudTop - uCloudBottom, 200.0);
        vec3 up = normalize(p);
        above += cloudDensity(p + up * span * 0.10, min(h + 0.10, 1.0), 0.0) * span * 0.22;
        above += cloudDensity(p + up * span * 0.34, min(h + 0.34, 1.0), 0.0) * span * 0.46;
      }
      float skyVis = exp(-above * SIGMA * 0.55);

      vec3 amb = mix(gAmbBottom, gAmbTop, h);
      lum += amb * mix(0.55, 1.0, h) * mix(0.16, 1.0, skyVis);
      lum += lightningGlow(p + center);
      lum += uAmbientFlash * uLightningColor * 0.25;

      float tr = exp(-dens * SIGMA * fine);
      // analytic slab integration keeps banding away at low step counts
      scatter += lum * transmittance * (1.0 - tr);
      transmittance *= tr;
    } else if (++emptyRun > 4) {
      inside = false;
    }
    t += fine;
  }

  diag.x = depthOut;
  diag.y = gShapeR;
  diag.z = max(gBase, peakDensity);
  gSpent = float(spent);
  return vec4(scatter, transmittance);
}
`;

/**
 * Marches 1/16 of the low-resolution rays per frame. Each fragment stands for
 * one low-res pixel inside a 4x4 block, chosen by a Bayer-ordered offset that
 * cycles over 16 frames; the resolve pass scatters the result back and
 * reprojects the other 15/16.
 */
const CLOUD_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;

uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec2 uLowRes;
uniform vec2 uSlotOffset;
uniform float uFrame;
// Temporary instrument: writes a march internal instead of radiance so the
// buffer can be blitted and read. 0 = off.
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
  vec2 lowPix = floor(gl_FragCoord.xy) * 4.0 + uSlotOffset + 0.5;
  vec2 uv = lowPix / uLowRes;

  vec2 ndc = uv * 2.0 - 1.0;
  vec4 p0 = uInvViewProj * vec4(ndc, -1.0, 1.0); p0 /= p0.w;
  vec4 p1 = uInvViewProj * vec4(ndc,  1.0, 1.0); p1 /= p1.w;
  vec3 rd = normalize(p1.xyz - p0.xyz);

  // Anything below the horizon is covered by the (spherical) ocean, so the
  // cloud march there is pure waste — that is nearly half the frame.
  float dip = -sqrt(2.0 * max(uCamPos.y, 0.0) / 6360000.0) - 0.003;
  if (rd.y < dip) {
    oColor = vec4(0.0, 0.0, 0.0, 1.0);
    oDepth = vec4(-1.0, 0.0, 0.0, 0.0);
    return;
  }

  vec3 viewPos = vec3(0.0, groundRadiusMM + max(uCamPos.y, 0.2) * 1e-6, 0.0);
  vec3 sunColor = getValFromTLUT(uTransmittanceLUT, viewPos, uSunDir) * uSunIntensity;
  skyAmbient(viewPos, rd);

  vec4 diag;
  // Jitter is a pure function of the low-res pixel, deliberately not of time.
  // Each pixel is re-marched on the same phase of the 4x4 amortisation cycle,
  // so a fixed offset means every refresh returns the same radiance and the
  // history can be replaced outright instead of crawling toward it. A temporal
  // offset would decorrelate successive refreshes, force a slow blend, and the
  // slow blend is exactly what drags the image back to the marched resolution
  // and prints its blocks the moment the camera moves.
  //
  // Bayer rather than a hash: the resolve filter averages a 4x4 neighbourhood,
  // and an ordered pattern guarantees those sixteen pixels carry the sixteen
  // distinct offsets exactly once. That is a stratified estimate of the ray
  // integral; white noise would leave clumps and gaps in the offsets and so a
  // visibly grainier average for the same number of samples.
  // Bayer stratifies the offsets across the sixteen pixels of a block, but its
  // period is exactly the period of the amortisation, so on its own every pixel
  // would be re-marched with the same offset forever and its sampling error
  // would freeze into a static 4x4 pattern that no amount of resolve filtering
  // removes. Rotating by the golden ratio once per refresh cycle keeps the
  // spatial stratification and lets the history average the error away instead.
  float cycle = floor(uFrame * 0.0625);
  vec4 cl = marchClouds(uCamPos, rd, fract(bayer4(lowPix) + 0.6180339887 * cycle),
                        sunColor, diag);

  vec3 haze = getValFromSkyLUT(uSkyViewLUT, viewPos, rd, uSunDir) * uSunIntensity;
  cl.rgb = applyAerial(cl.rgb, cl.a, diag.x, haze);

  if (uCloudDebug > 0) {
    // Three internals per pass so one capture answers three questions.
    vec3 v = (uCloudDebug == 1)
      ? vec3(gT0 / 40000.0, gIters / 512.0, gCov)             // entry, budget, weather
      : vec3(gSpent / float(uSteps), diag.z, diag.x / 60000.0); // steps, density, hit
    oColor = vec4(clamp(v, 0.0, 1.0), 1.0);
    oDepth = diag;
    return;
  }

  oColor = cl;
  oDepth = diag;
}
`;

/**
 * Scatters this frame's 1/16 slice back into the low-res buffer and fills the
 * rest by reprojecting the previous frame along the cloud-shell depth.
 */
const CLOUD_REPROJ_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uQuarter;      // freshly marched slice
uniform sampler2D uQuarterDiag;
uniform sampler2D uHistory;
uniform sampler2D uHistoryDiag;
uniform mat4 uPrevViewProj;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec2 uSlotOffset;
uniform float uReset;
uniform float uBlend;
uniform float uShellMid;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oDiag;

void main(){
  ivec2 lp = ivec2(gl_FragCoord.xy);
  ivec2 qp = lp >> 2;
  ivec2 slot = ivec2(uSlotOffset);
  bool fresh = (lp.x & 3) == slot.x && (lp.y & 3) == slot.y;

  vec4 cur = texelFetch(uQuarter, qp, 0);
  vec4 curDiag = texelFetch(uQuarterDiag, qp, 0);

  // Where there is no history to blend against, seed from a bilinear read of
  // the marched buffer rather than the nearest texel: point-sampling it hands
  // every pixel of a 4x4 amortisation cell the same value, so the sky prints as
  // hard rectangles until all sixteen slots have been revisited. Soft and
  // low-resolution converges to sharp; blocky reads as broken.
  vec4 smooth_ = texture(uQuarter, vUv);
  vec4 smoothDiag = texture(uQuarterDiag, vUv);

  if (uReset > 0.5) {
    oColor = fresh ? cur : smooth_;
    oDiag = fresh ? curDiag : smoothDiag;
    return;
  }

  // reproject using this pixel's own history depth; fall back to the shell mid
  float dist = texture(uHistoryDiag, vUv).x;
  if (dist <= 0.0) dist = uShellMid;

  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 p0 = uInvViewProj * vec4(ndc, -1.0, 1.0); p0 /= p0.w;
  vec4 p1 = uInvViewProj * vec4(ndc,  1.0, 1.0); p1 /= p1.w;
  vec3 rd = normalize(p1.xyz - p0.xyz);
  vec4 prevClip = uPrevViewProj * vec4(uCamPos + rd * dist, 1.0);
  vec2 prevUv = (prevClip.xy / max(prevClip.w, 1e-6)) * 0.5 + 0.5;

  // Disoccluded at the edge the camera is panning into — same story as a reset.
  if (any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) {
    oColor = fresh ? cur : smooth_;
    oDiag = fresh ? curDiag : smoothDiag;
    return;
  }

  vec4 hist = texture(uHistory, prevUv);
  vec4 histDiag = texture(uHistoryDiag, prevUv);

  // Reject stale history the same way TAA does: the 3x3 block of freshly
  // marched samples around this pixel bounds what it can plausibly be. Without
  // this, whole regions can hold onto pre-camera-cut content indefinitely.
  vec4 lo = cur, hi = cur;
  ivec2 qmax = textureSize(uQuarter, 0) - 1;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec4 s = texelFetch(uQuarter, clamp(qp + ivec2(x, y), ivec2(0), qmax), 0);
    lo = min(lo, s); hi = max(hi, s);
  }
  // Generous: this exists to catch history that survived a camera cut, not to
  // police detail. Clamping tightly against a 4x-coarser neighbourhood drags
  // every pixel back toward the marched resolution and prints its blocks.
  vec4 tol = (hi - lo) * 1.5 + vec4(0.06, 0.06, 0.06, 0.12);
  hist = clamp(hist, lo - tol, hi + tol);

  if (fresh) {
    oColor = mix(hist, cur, uBlend);
    oDiag = curDiag;
  } else {
    oColor = hist;
    oDiag = histDiag;
  }
}
`;

/**
 * Upsample from the amortised low buffer to screen.
 *
 * The residual pattern in the low buffer has a period of exactly four texels:
 * the sixteen pixels of an amortisation block were marched on sixteen different
 * frames, so while the camera moves each carries a different reprojection error
 * and the block prints as a crosshatch. A four-texel box has a zero at exactly
 * that frequency and erases it — but four low-res texels are eight screen
 * pixels, so running that box unconditionally is why every cloud in the sky was
 * a blurred smudge with no silhouette at all.
 *
 * The block only prints while history is being dragged across the buffer. Hold
 * the camera still and every slot converges on the same ray, the low buffer
 * becomes exact, and there is nothing to hide. So the box fades in with camera
 * motion and the still frame gets a sharp cubic instead — which is the frame
 * anyone actually judges the sky on, and while swinging the camera the motion
 * blur covers what the box costs.
 */
const CLOUD_UPSAMPLE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uInvSrc;
uniform vec2 uSrcRes;
uniform float uSharpen;   // 0 = trust the low buffer, 1 = hide the block grid
in vec2 vUv;
layout(location = 0) out vec4 oColor;

// Catmull-Rom over the nine nearest texels, gathered as four bilinear taps.
// Straight bilinear magnification turns a half-resolution cumulus into a
// lattice of diamonds; the cubic keeps an edge an edge.
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
  if (uSharpen > 0.002) {
    // Snap to the nearest texel corner first. A bilinear tap sitting exactly on
    // a corner is the average of the four texels around it, so four such taps
    // one texel out on each diagonal are an exact 4x4 box. Left unsnapped they
    // land mid-texel, the box stops being a box, and the cancellation is only
    // partial.
    vec2 corner = (floor(vUv / uInvSrc - 0.5) + 1.0) * uInvSrc;
    vec4 wide = texture(uSrc, corner + vec2(-1.0, -1.0) * uInvSrc)
              + texture(uSrc, corner + vec2( 1.0, -1.0) * uInvSrc)
              + texture(uSrc, corner + vec2(-1.0,  1.0) * uInvSrc)
              + texture(uSrc, corner + vec2( 1.0,  1.0) * uInvSrc);
    c = mix(c, wide * 0.25, uSharpen);
  }
  c.a = clamp(c.a, 0.0, 1.0);
  oColor = max(c, vec4(0.0));
}
`;

const CLOUD_ENV_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;

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

    this.shared = {
      uCloudShape: { value: textures.cloudShape },
      uCloudDetail: { value: textures.cloudDetail },
      uShapeLo: { value: shapeLo }, uShapeHi: { value: shapeHi },
      uDetailLo: { value: detLo }, uDetailHi: { value: detHi },
      uCurlTex: U.uCurlTex,
      uWeatherMap: { value: textures.weather },
      uWeatherScaleM: { value: 58000 },
      uCoverage: { value: 0.4 },
      uCloudDensity: { value: 0.6 },
      uCloudBottom: { value: 1200 },
      uCloudTop: { value: 5200 },
      uAnvil: { value: 0.0 },
      uStorm: U.uStormFactor,
      uCloudWind: { value: new THREE.Vector2(6, 2) },
      uCloudTime: { value: 0 },
      uCloudScaleM: { value: 15000 },
      uCloudAspect: { value: 2.6 },
      uCloudContrast: { value: 1.6 },
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

    // Bayer-ordered visiting order for the 4x4 amortisation grid: consecutive
    // frames land far apart, so a partially converged buffer looks uniform.
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    this.slots = new Array(16);
    for (let i = 0; i < 16; i++) this.slots[BAYER[i]] = [i % 4, (i / 4) | 0];

    this.marchPass = new FullScreenPass(CLOUD_FRAG, {
      ...this.shared,
      uInvViewProj: U.uInvViewProjNJ,
      uCamPos: U.uCamPos,
      uLowRes: { value: new THREE.Vector2(1, 1) },
      uSlotOffset: { value: new THREE.Vector2() },
      uFrame: U.uFrame,
      uDetailFade: { value: new THREE.Vector3(9000, 34000, 95000) },
      uCloudDebug: { value: 0 },
    }, { name: 'cloudMarch' });

    this.reprojPass = new FullScreenPass(CLOUD_REPROJ_FRAG, {
      uQuarter: { value: null }, uQuarterDiag: { value: null },
      uHistory: { value: null }, uHistoryDiag: { value: null },
      uPrevViewProj: U.uPrevViewProjNJ, uInvViewProj: U.uInvViewProjNJ,
      uCamPos: U.uCamPos, uSlotOffset: { value: new THREE.Vector2() },
      // A refreshed sample is one estimate of the ray integral, not the answer,
      // because the march offset now changes every cycle. Blending rather than
      // replacing is what turns those estimates into an average.
      uReset: { value: 1 }, uBlend: { value: 0.4 },
      uShellMid: { value: 20000 },
    }, { name: 'cloudReproj' });

    this.upsamplePass = new FullScreenPass(CLOUD_UPSAMPLE_FRAG, {
      uSrc: { value: null }, uInvSrc: { value: new THREE.Vector2() },
      uSrcRes: { value: new THREE.Vector2() },
      uSharpen: { value: 0.0 },
    }, { name: 'cloudUpsample' });
    this._blockHide = 0;

    this.envPass = new FullScreenPass(CLOUD_ENV_FRAG, {
      ...this.shared,
      uCamPos: U.uCamPos,
      uFrame: U.uFrame,
      uSteps: { value: 18 },
      uLightSteps: { value: 3 },
      // The probe feeds reflections, which never resolve an erosion octave.
      uDetailFade: { value: new THREE.Vector3(1500, 4000, 12000) },
    }, { name: 'cloudEnv' });

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
    // the low buffer must be a multiple of 4 so the amortisation grid tiles
    const lw = Math.max(16, Math.ceil(w * this.scale / 4) * 4);
    const lh = Math.max(16, Math.ceil(h * this.scale / 4) * 4);
    if (!force && this.lowW === lw && this.lowH === lh) return;
    this.fullW = w; this.fullH = h;
    this.lowW = lw; this.lowH = lh;

    this.quarterRT?.dispose();
    this.history?.dispose();
    this.fullRT?.dispose();

    // linear filtered so the reprojection can also read it as a smooth
    // low-frequency estimate; the per-slot reads use texelFetch regardless
    this.quarterRT = makeRT(lw / 4, lh / 4, {
      type: THREE.HalfFloatType, count: 2, name: 'cloudQuarter',
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.history = new PingPong(lw, lh, { type: THREE.HalfFloatType, count: 2, name: 'cloudHist' });
    this.fullRT = makeRT(w, h, { type: THREE.HalfFloatType, name: 'cloudFull' });
    this.marchPass.uniforms.uLowRes.value.set(lw, lh);
    this.reset = true;
  }

  /**
   * Worst-case distance, in low-resolution texels, that the resolve has to drag
   * history to line it up with this frame — sampled at the screen centre and
   * the four corners so both translation and rotation are caught. Zero means
   * every amortisation slot is looking down the same ray it looked down last
   * frame, so the low buffer is converged and can be trusted sharp.
   */
  _reprojectionShift(dist) {
    const inv = U.uInvViewProjNJ.value;
    const prev = U.uPrevViewProjNJ.value;
    const cam = U.uCamPos.value;
    let worst = 0;
    for (const p of PROBE_NDC) {
      _pa.set(p[0], p[1], -1).applyMatrix4(inv);
      _pb.set(p[0], p[1], 1).applyMatrix4(inv);
      _pb.sub(_pa).normalize().multiplyScalar(dist).add(cam).applyMatrix4(prev);
      // Off the back of the previous frustum the projection flips; treat that
      // as a full disocclusion rather than reading a mirrored coordinate.
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

    // A billow is about as tall as it is wide — that is what makes a cumulus a
    // cumulus. Squashing the volume to fit one billow per deck made every cell
    // three times wider than tall, and fair-weather cloud came out as floating
    // pancakes. Shaping the deck vertically is heightProfile's job; the noise
    // should stay close to isotropic and only stretch for a deep storm tower.
    const thickness = Math.max(s.uCloudTop.value - s.uCloudBottom.value, 200);
    s.uCloudAspect.value = THREE.MathUtils.clamp(
      s.uCloudScaleM.value / (thickness * 4.4), 0.8, 1.7);

    const slot = this.slots[this.frame % 16];
    this.marchPass.uniforms.uSlotOffset.value.set(slot[0], slot[1]);
    this.reprojPass.uniforms.uSlotOffset.value.set(slot[0], slot[1]);
    this.frame++;

    this.marchPass.render(r, this.quarterRT);

    const mid = (s.uCloudBottom.value + s.uCloudTop.value) * 0.5;
    this.reprojPass
      .set('uQuarter', this.quarterRT.textures[0])
      .set('uQuarterDiag', this.quarterRT.textures[1])
      .set('uHistory', this.history.read.textures[0])
      .set('uHistoryDiag', this.history.read.textures[1])
      .set('uReset', (this.reset || this.forceReset) ? 1 : 0)
      .set('uShellMid', Math.max(mid, 500) * 6.0);
    this.reprojPass.render(r, this.history.write);
    this.history.swap();

    // How hard the resolve has to work to hide the amortisation grid, which is
    // entirely a function of how far history is being dragged this frame.
    // Engage fast, because the block prints on the frame the camera starts
    // moving; release slowly, because all sixteen slots have to be revisited
    // before the buffer is trustworthy again and that takes a third of a second.
    const shift = this._reprojectionShift(Math.max(mid, 500) * 6.0);
    const want = THREE.MathUtils.clamp((shift - 0.3) / 1.8, 0, 1);
    this._blockHide += (want - this._blockHide) * (want > this._blockHide ? 0.55 : 0.045);

    this.upsamplePass.set('uSrc', this.history.read.textures[0]);
    this.upsamplePass.set('uSharpen', this._blockHide * 0.85);
    this.upsamplePass.uniforms.uInvSrc.value.set(1 / this.lowW, 1 / this.lowH);
    this.upsamplePass.uniforms.uSrcRes.value.set(this.lowW, this.lowH);
    this.upsamplePass.render(r, this.fullRT);

    // env probe refreshes on a slower cadence — reflections tolerate the lag
    if (this.frame % 8 === 0 || this.reset) this.envPass.render(r, this.envRT);

    this.reset = false;
  }

  get screenTexture() { return this.enabled ? this.fullRT.texture : null; }
  get envTexture() { return this.enabled ? this.envRT.texture : null; }

  dispose() {
    this.quarterRT?.dispose(); this.history?.dispose();
    this.fullRT?.dispose(); this.envRT?.dispose();
  }
}
