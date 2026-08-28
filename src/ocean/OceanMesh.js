import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { OCEAN_SAMPLE_GLSL } from './OceanSampleGLSL.js';
import { NOISE_GLSL } from '../gfx/NoiseGLSL.js';
import { ATMO_COMMON } from '../sky/AtmosphereGLSL.js';
import { AERIAL_GLSL } from '../sky/Atmosphere.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';

/**
 * Screen-space projected grid. Every vertex is a view ray intersected with the
 * *spherical* sea surface, so triangle density is uniform in pixels, the mesh
 * ends exactly on the true geometric horizon and nothing is spent on water
 * that is off-screen. Rays that pass above the horizon are snapped to the
 * azimuthal tangent point, which projects precisely onto the horizon line.
 */
function buildProjectedGrid(nx, ny) {
  const vertCount = (nx + 1) * (ny + 1);
  const grid = new Float32Array(vertCount * 2);
  let o = 0;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      grid[o++] = i / nx;
      grid[o++] = j / ny;
    }
  }
  const idx = new Uint32Array(nx * ny * 6);
  let k = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + (nx + 1);
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = d;
      idx[k++] = a; idx[k++] = d; idx[k++] = b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('aGrid', new THREE.BufferAttribute(grid, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

const VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 aGrid;

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat4 uViewProjNJ;
uniform mat4 uPrevViewProjNJ;
uniform mat4 uInvViewProjNJ;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uRMax;
uniform vec2 uGridSize;
uniform float uGridMargin;
uniform float uSkirt;
uniform float uGridPlane;
uniform float uCurrentStrength;
uniform float uDisplaceScale;
// Loop bounds, deliberately not compile-time constants. With literals the
// driver unrolls the ray search into forty inlined copies of the event field
// and the HLSL translation never finishes compiling.
uniform int uEventSteps;
uniform int uEventBisect;

${OCEAN_SAMPLE_GLSL}

out vec3 vWorldPos;
out vec2 vFlatPos;
out vec3 vDisp;
out float vDist;
out float vCrest;
out float vCalm;
out float vWaveY;
out float vEventY;
out vec3 vLods;
out vec4 vClipNJ;
out vec4 vPrevClipNJ;

vec3 rayFor(vec2 ndc) {
  vec4 a = uInvViewProjNJ * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvViewProjNJ * vec4(ndc,  1.0, 1.0);
  return normalize(b.xyz / b.w - a.xyz / a.w);
}

// -------------------------------------------------------- disaster brackets
// The stretch of a ray in which a given event can possibly reach it. Marching
// blind is hopeless: a degree above the horizon the water occupies kilometres
// of ray, and a hundred-and-fifty-metre crest falls clean between two samples.
// Every event is analytic though, so its footprint solves in closed form — a
// solitary wave is a band in its own front coordinate, everything else is a
// disc — and sixteen samples inside a tight bracket find what a hundred spread
// over the whole slab would miss. Distances are horizontal; the caller divides.
void bandSoliton(vec4 s, vec4 sb, vec2 o, vec2 d, inout vec2 span) {
  if (s.w <= 0.001) return;
  vec2 sd = normalize(s.xy);
  float w = max(sb.x, 1.0) * 3.0;
  float x0 = dot(o, sd) - s.z;
  float k = dot(d, sd);
  vec2 seg;
  if (abs(k) < 1e-5) {
    if (abs(x0) > w) return;      // running along the front, never crosses it
    seg = vec2(0.0, 1e7);
  } else {
    float a = (-w - x0) / k, b = (w - x0) / k;
    seg = vec2(min(a, b), max(a, b));
  }
  span = vec2(min(span.x, seg.x), max(span.y, seg.y));
}

void bandDisc(vec2 c, float r, float amp, vec2 o, vec2 d, inout vec2 span) {
  if (amp <= 0.001) return;
  vec2 m = o - c;
  float b = dot(m, d);
  float cc = dot(m, m) - r * r;
  float disc = b * b - cc;
  if (disc < 0.0) return;
  float sq = sqrt(disc);
  span = vec2(min(span.x, -b - sq), max(span.y, -b + sq));
}

/**
 * First crossing of a view ray with the analytic disaster field inside
 * [lo, hi], or -1 if the ray clears it. The tested quantity is the ray's
 * height above the surface, so the crossing is where it first goes negative.
 *
 * Two passes, and the second one is not optional. Where the ray is nearly
 * tangent to a crest — which is the silhouette, the one part of the wave the
 * eye is actually reading — the stretch in which the ray is below the surface
 * narrows towards nothing, and a single coarse march catches it on one row and
 * steps clean over it on the next. Adjacent vertices then land on different
 * branches, the mesh folds back on itself and the crest comes out as a zipper.
 * Re-marching the cell around the closest approach costs sixteen more samples
 * of a pure-ALU function and turns that rip back into an edge.
 */
float eventRayHit(vec3 dir, vec2 o2, float eye, float lo, float hi) {
  float a = lo, b = hi;
  float ta = -1.0, tb = 0.0;

  for (int pass = 0; pass < 2; pass++) {
    float dt = (b - a) / float(uEventSteps);
    float tPrev = a;
    float gPrev = eye + dir.y * a - oceanEventHeight(o2 + dir.xz * a);
    float gMin = gPrev, tMin = a;
    for (int i = 1; i <= uEventSteps; i++) {
      float tc = a + dt * float(i);
      float gc = eye + dir.y * tc - oceanEventHeight(o2 + dir.xz * tc);
      if (ta < 0.0 && gPrev > 0.0 && gc <= 0.0) { ta = tPrev; tb = tc; }
      if (gc < gMin) { gMin = gc; tMin = tc; }
      tPrev = tc; gPrev = gc;
    }
    if (ta > 0.0) break;
    // Nothing crossed. Re-march the cell around the closest approach in case
    // the coarse pass stepped over a narrow one.
    a = max(tMin - dt, lo);
    b = min(tMin + dt, hi);
  }
  if (ta < 0.0) return -1.0;

  for (int i = 0; i < uEventBisect; i++) {
    float tm = 0.5 * (ta + tb);
    if (eye + dir.y * tm - oceanEventHeight(o2 + dir.xz * tm) > 0.0) ta = tm; else tb = tm;
  }
  return 0.5 * (ta + tb);
}

/** Intersect a view ray with the parabolic (spherical) sea surface. */
vec2 seaHit(vec3 dir, float eyeHeight) {
  float curv = uEarthCurvature / (2.0 * EARTH_R);
  float a = max((1.0 - dir.y * dir.y) * curv, 1e-14);
  float b = dir.y;
  float c = eyeHeight;
  float disc = b * b - 4.0 * a * c;
  float t = 0.0;
  bool miss = true;
  if (disc >= 0.0) {
    // Citardauq form. The textbook (-b ± sqrt(disc)) / 2a is unusable here: the
    // sea sphere has planetary radius, so a ~ 1e-8 and for any ray steeper than
    // a few degrees 4ac is a part in ten million of b*b. The subtraction then
    // cancels to float noise and gets amplified by 1/2a ~ 1e7, which scatters
    // near-field vertices to random distances and tears a hole in the mesh
    // wherever the camera looks down.
    float sq = sqrt(disc);
    float qq = -0.5 * (b + (b >= 0.0 ? sq : -sq));
    float r1 = qq / a;
    float r2 = abs(qq) > 1e-20 ? c / qq : -1.0;
    float lo = min(r1, r2), hi = max(r1, r2);
    t = lo > 0.02 ? lo : hi;
    miss = t <= 0.02;
  }
  if (miss || t > uRMax) {
    // snap to the azimuthal tangent point => lands exactly on the horizon
    float rh = sqrt(max(2.0 * EARTH_R * max(abs(c), 0.05) * uEarthCurvature, 1.0));
    rh = min(rh, uRMax);
    if (uEarthCurvature < 0.5) rh = uRMax;
    float horiz = max(length(dir.xz), 1e-5);
    t = rh / horiz;
    return vec2(t, 1.0);
  }
  return vec2(t, 0.0);
}

void main(){
  // A flat margin cannot guarantee coverage. Every vertex is placed on the
  // *undisplaced* sea and then moved by up to a few metres horizontally, and
  // for the bottom row — water eight metres from the lens — a few metres is a
  // large fraction of the frame. The boundary of the mesh then walks inward and
  // tears a wedge out of the corner of the screen. So the outermost ring is
  // thrown far outside the frustum: one ring of vertices, effectively free,
  // whose stretched triangles guarantee the visible area is always covered.
  vec2 cellIdx = aGrid * uGridSize;
  vec2 atMin = step(cellIdx, vec2(0.5));
  vec2 atMax = step(uGridSize - 0.5, cellIdx);
  vec2 ndc = (aGrid * 2.0 - 1.0) * uGridMargin + (atMax - atMin) * uSkirt;
  vec3 dir = rayFor(ndc);
  // Aim the rays at the water actually under the lens, not at mean sea level.
  //
  // A tsunami lifts the whole neighbourhood by tens of metres. Intersect the
  // flat plane instead and the near rows land on points that displacement then
  // throws above the sight line, uncovering the bottom third of the frame; no
  // amount of margin can reach far enough down to cover it, because the
  // geometry that belongs there is metres from the lens.
  //
  // The offset has to be constant across the grid. Re-intersecting per vertex
  // against the sampled height — by fixed point or by Newton — diverges for
  // grazing rays, where a wavy surface offers many intersections and adjacent
  // rays converge on different ones. The mesh comes apart into contour
  // terraces. A constant is continuous by construction.
  float eyeHeight = max(uCamPos.y - (uSeaLevel + uGridPlane), 0.35);

  vec2 hit = seaHit(dir, eyeHeight);
  float t = hit.x;
  float snapped = hit.y;

  // ---------------------------------------------- re-aim at the disasters
  // A flat reference plane is exactly right for a wind sea a few metres tall
  // and useless for a forty metre one. Every ray that points at a distant
  // tsunami either grazes the plane or misses it upward, so all of them are
  // snapped to the horizon ring and the wall is not drawn coarsely — it is not
  // drawn at all. Re-intersecting against the analytic event field puts those
  // rows back onto the face, and the density then takes care of itself: a wall
  // covering six degrees of the frame collects every row inside six degrees.
  //
  // The FFT relief is deliberately excluded. A metre-scale surface offers a
  // grazing ray dozens of intersections, adjacent vertices settle on different
  // ones, and the mesh comes apart into contour terraces.
  float horiz = length(dir.xz);
  // World distance covered by one radian of pitch on whatever surface the
  // vertex ended up on. Zero means "use the flat-plane estimate".
  float eventSpread = 0.0;
  if (horiz > 1e-5) {
    vec2 d2 = dir.xz / horiz;
    vec2 o2 = uCamPos.xz;
    vec2 span = vec2(1e9, -1e9);
    bandSoliton(uSoliton0, uSoliton0b, o2, d2, span);
    bandSoliton(uSoliton1, uSoliton1b, o2, d2, span);
    bandDisc(uRogue.xy, uRogue.z * 2.4, uRogue.w, o2, d2, span);
    bandDisc(uHurricane.xy, uHurricane.z * 3.0, uHurricane.w, o2, d2, span);
    bandDisc(uVortex0.xy, uVortex0.z * 3.0, uVortex0.w, o2, d2, span);
    bandDisc(uVortex1.xy, uVortex1.z * 3.0, uVortex1.w, o2, d2, span);
    bandDisc(uVortex2.xy, uVortex2.z * 3.0, uVortex2.w, o2, d2, span);
    bandDisc(uVortex3.xy, uVortex3.z * 3.0, uVortex3.w, o2, d2, span);

    if (span.y > span.x) {
      float lo = max(span.x / horiz, 0.05);
      float hi = min(span.y / horiz, uRMax);
      // A ray that already found flat water cannot be answered by an event
      // behind that water — it is occluded. The slack is for the opposite
      // case, the drawdown ahead of a crest, where the sea the ray wants is
      // *below* the plane and therefore slightly further out.
      if (snapped < 0.5) hi = min(hi, t * 1.06 + 60.0);
      hi = min(hi, lo + 8000.0);

      if (hi > lo) {
        float tHit = eventRayHit(dir, o2, uCamPos.y - uSeaLevel, lo, hi);
        if (tHit > 0.0) {
          t = clamp(tHit, 0.05, uRMax);
          snapped = 0.0;

          // How far apart consecutive rows land on this face. Where the ray
          // grazes the surface it is tens of metres even though the rows are a
          // fraction of a degree apart, and a footprint that still believes
          // the flat-plane spacing point-samples the cascade and serrates the
          // crest into a mountain ridge. Differentiating the intersection
          // itself: dt/dtheta = -t / (dir.y - dE/dt).
          float hs = max(t * 0.02, 0.5);
          float dEdt = (oceanEventHeight(o2 + dir.xz * (t + hs))
                      - oceanEventHeight(o2 + dir.xz * t)) / hs;
          eventSpread = t / max(abs(dir.y - dEdt), 2e-3);
        }
      }
    }
  }

  vec2 world = uCamPos.xz + dir.xz * t;

  // footprint from the neighbouring grid cells (uniform in screen space)
  vec2 ndcDu = (vec2(aGrid.x + 1.0 / uGridSize.x, aGrid.y) * 2.0 - 1.0) * uGridMargin;
  vec2 ndcDv = (vec2(aGrid.x, aGrid.y + 1.0 / uGridSize.y) * 2.0 - 1.0) * uGridMargin;
  vec3 dirU = rayFor(ndcDu);
  vec3 dirV = rayFor(ndcDv);
  // Scale the neighbours by however far the refinement moved this vertex.
  // Re-solving for each of them costs three times the search; the ratio is
  // accurate wherever the two rays land on the same face, which is the only
  // place the footprint matters.
  float tScale = t / max(hit.x, 1e-3);
  vec2 wu = uCamPos.xz + dirU.xz * (seaHit(dirU, eyeHeight).x * tScale);
  vec2 wv = uCamPos.xz + dirV.xz * (seaHit(dirV, eyeHeight).x * tScale);
  // Never finer than the cell subtends at this range. Rays that missed the
  // reference plane were all snapped to the same tangent ring, so their
  // neighbour footprints differ by nothing and the lookup collapses to the
  // sharpest mip — which is how a wave face four hundred metres out ends up
  // sampled per-texel and rendered as crumpled foil.
  float angU = length(dirU - dir), angV = length(dirV - dir);
  float pixel = max(t * angU, eventSpread * angV);
  float cell = max(max(length(wu - world), length(wv - world)), max(0.015, pixel));

  vec3 texel = uOceanScales / uOceanTexels;
  vec3 lods = log2(max(vec3(cell) / texel, vec3(1.0)));
  vLods = lods;

  vec2 q = swirlCoords(world, uTime);
  q = warpCoord(q, uTime, uCurrentStrength);

  float foamHint;
  vec3 disp = oceanDisplacementLod(q, lods, foamHint) * uDisplaceScale;

  float crest, calm;
  vec3 mods = oceanModifiers(world, uTime, crest, calm);
  disp *= (1.0 - calm * 0.8);
  // Wind waves and disaster displacement have to stay separable. Shading uses
  // crest height as a stand-in for how thin the water is — a metre-high crest
  // with the sun behind it glows — and the two are only interchangeable while
  // the sea is made of wind waves. Fold in a forty metre tsunami and every
  // "thin sheet" term pins to its maximum across the entire wall, which is
  // what turned the face into a slab of jade.
  float waveY = disp.y;
  disp += mods;

  // fade the vertical relief out right at the horizon so the silhouette stays clean
  float horizonFade = 1.0 - snapped * 0.92;
  disp *= horizonFade;
  vWaveY = waveY * horizonFade;
  vEventY = mods.y * horizonFade;

  vec3 wp = vec3(world.x + disp.x, uSeaLevel + disp.y, world.y + disp.z);
  wp.y -= earthDrop(world, uCamPos);

  vWorldPos = wp;
  vFlatPos = world;
  vDisp = disp;
  vDist = length(wp - uCamPos);
  vCrest = crest;
  vCalm = calm;

  vClipNJ = uViewProjNJ * vec4(wp, 1.0);
  vPrevClipNJ = uPrevViewProjNJ * vec4(wp, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec3 uCamPos;
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientColor;
uniform sampler2D uTransmittanceLUT;
uniform sampler2D uWeatherMap;
uniform float uWeatherScaleM;
uniform float uCoverage;
uniform float uCloudContrast;
uniform float uCloudDensity;
uniform float uCloudBottom;
uniform vec2 uCloudWind;
uniform float uCloudTime;
uniform sampler2D uEnvMap;
uniform float uEnvMaxLod;
uniform float uEnvWidth;
uniform sampler2D uFoamTex;
uniform sampler2D uRippleTex;
uniform float uRain;
uniform float uWhitecapCoverage;
uniform float uStormFactor;
uniform vec3 uWaterScatter;
uniform vec3 uWaterAbsorb;
uniform float uFoamStrength;
uniform float uCurrentStrength;
uniform vec4 uLightning0;
uniform vec4 uLightning1;
uniform vec3 uLightningColor;
uniform float uAmbientFlash;
uniform float uExposure;
uniform float uUnderwater;
uniform float uDebugMode;

${ATMO_COMMON}
${AERIAL_GLSL}
${NOISE_GLSL}
${OCEAN_SAMPLE_GLSL}
${SHADING_GLSL}

in vec3 vWorldPos;
in vec2 vFlatPos;
in vec3 vDisp;
in float vDist;
in float vCrest;
in float vCalm;
in float vWaveY;
in float vEventY;
in vec3 vLods;
in vec4 vClipNJ;
in vec4 vPrevClipNJ;

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;

vec4 sampleCascadeGrad(sampler2D tex, vec2 p, float scale, vec2 ddx, vec2 ddy) {
  return textureGrad(tex, p / scale, ddx / scale, ddy / scale);
}

/**
 * How much of the direct beam survives the cloud deck on its way to this patch
 * of water. Reads the same weather map the deck is built from, at the point
 * where the beam crosses the cloud base, so the shadows are the actual clouds
 * overhead and they drift with them. Without this the sea kept a full midday
 * sun and a hard specular glint underneath a violent storm.
 */
float cloudShadow(vec3 p, vec3 L) {
  if (uCoverage <= 0.001) return 1.0;
  // Grazing sun would throw the sample kilometres away and swim; past this the
  // deck is edge-on and the beam is inside cloud the whole way regardless.
  float up = max(L.y, 0.22);
  vec2 xz = p.xz + L.xz / up * max(uCloudBottom - p.y, 0.0);

  vec2 w = xz + uCloudWind * uCloudTime * 0.6;
  vec4 m = textureLod(uWeatherMap, w / uWeatherScaleM, 0.0);
  vec4 n = textureLod(uWeatherMap, w / (uWeatherScaleM * 0.27)
                 + vec2(0.37, 0.11) - uCloudWind * uCloudTime * 0.00002, 0.0);
  float field = m.r * 0.62 + m.g * 0.22 + n.g * 0.16;
  float cov = clamp((field - 0.5) * uCloudContrast + uCoverage, 0.0, 1.0);

  // Thin edges of a cell shadow far less than its core, and a slanted beam
  // takes a longer path through the same deck.
  float od = smoothstep(0.04, 0.62, cov) * uCloudDensity * 4.2 / up;
  return exp(-od);
}

void main(){
  vec2 q = swirlCoords(vFlatPos, uTime);
  q = warpCoord(q, uTime, uCurrentStrength);

  vec2 ddx = dFdx(q);
  vec2 ddy = dFdy(q);

  // The two axes of this pixel's footprint on the water, in metres. You look at
  // an ocean almost edge-on, so they differ by orders of magnitude: at the
  // horizon a pixel is centimetres across and kilometres deep. The major axis
  // is what an unfiltered tap would alias on; the minor axis is the detail
  // anisotropic sampling still resolves, and it is the one that decides whether
  // a wavelength is worth shading or belongs in the roughness lobe instead.
  float fpA = length(ddx), fpB = length(ddy);
  float fpMajor = max(fpA, fpB);
  float fpMinor = max(max(min(fpA, fpB), fpMajor / max(uOceanAniso, 1.0)), 1e-5);
  // Roughness answers to the whole pixel, not to the one axis the anisotropic
  // taps sharpen. Charge it for the minor axis alone and the far sea stays
  // nearly mirror-smooth at grazing incidence: every wavelet the filter kept
  // becomes its own specular highlight, and the horizon turns into a field of
  // white speckle. The geometric mean is the isotropic footprint of equal area,
  // so detail stays sharp while the light it reflects is averaged honestly.
  float fpShade = sqrt(fpMinor * fpMajor);

  // ---------------------------------------------------------- surface normal
  vec4 d0 = sampleCascadeGrad(uOceanDeriv0, q, uOceanScales.x, ddx, ddy) * uCascadeGain.x;
  vec4 d1 = sampleCascadeGrad(uOceanDeriv1, q, uOceanScales.y, ddx, ddy) * uCascadeGain.y;
  vec4 d2 = sampleCascadeGrad(uOceanDeriv2, q, uOceanScales.z, ddx, ddy) * uCascadeGain.z;
  vec4 dsum = d0 + d1 + d2;

  vec2 slope = vec2(dsum.x / max(1.0 + dsum.z, 0.05), dsum.y / max(1.0 + dsum.w, 0.05));
  slope *= (1.0 - vCalm * 0.85);
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  // Capillary detail on top of the spectrum. This used to fade on raw distance,
  // which threw it away past a few hundred metres however much of the frame the
  // water covered — from any high vantage the sea turned to plastic halfway up
  // the image. It fades on footprint now, and the taps are gradient-filtered so
  // the layer can live all the way to where it genuinely stops resolving
  // instead of being cut early to hide its own aliasing.
  float microFade = 1.0 - smoothstep(0.35, 2.2, fpShade);
  if (microFade > 0.004) {
    vec2 wdir = normalize(uWindDir + 1e-5);
    vec2 drift = wdir * uTime;
    // Three taps of the one tile at incommensurate scales, each turned to its
    // own angle. Axis-aligned layers print their lattice across the whole sea
    // now that the detail survives to the horizon — the old pair repeated every
    // ten metres and read as a crosshatch scratched into the water. Rotations
    // mean the repeats never line up, so the eye finds no grid to lock onto.
    mat2 rotA = mat2( 0.8339, 0.5519, -0.5519, 0.8339);
    mat2 rotB = mat2(-0.2225, 0.9749, -0.9749, -0.2225);
    vec2 qA = rotA * q, qB = rotB * q;
    vec3 r0 = textureGrad(uRippleTex, q * 0.0131 + drift * 0.0075,
                          ddx * 0.0131, ddy * 0.0131).xyz * 2.0 - 1.0;
    vec3 r1 = textureGrad(uRippleTex, qA * 0.0474 - drift * 0.019,
                          rotA * ddx * 0.0474, rotA * ddy * 0.0474).xyz * 2.0 - 1.0;
    vec3 r2 = textureGrad(uRippleTex, qB * 0.1327 + drift * 0.041,
                          rotB * ddx * 0.1327, rotB * ddy * 0.1327).xyz * 2.0 - 1.0;
    // Each layer's slope lives in its own rotated frame; carry it back with the
    // transpose before adding, or the ripples all lean the same wrong way.
    vec2 micro = r0.xz * 0.46 + (r1.xz * rotA) * 0.33 + (r2.xz * rotB) * 0.21;
    micro *= microFade * (0.05 + 0.011 * uWindSpeed);
    N = normalize(N + vec3(micro.x, 0.0, micro.y));
  }

  // rain impact ripples
  float rainRip = 0.0;
  if (uRain > 0.01) {
    float f = exp(-vDist * 0.012);
    if (f > 0.004) {
      vec2 cellUv = q * 2.2;
      vec2 ci = floor(cellUv);
      vec2 cf = fract(cellUv) - 0.5;
      float rnd = hash12(ci);
      float phase = fract(uTime * (0.9 + rnd * 0.6) + rnd);
      float rad = phase * 0.48;
      float dd = length(cf);
      float ring = exp(-pow((dd - rad) * 26.0, 2.0)) * (1.0 - phase) * step(rnd, uRain * 0.85);
      vec2 dir = normalize(cf + 1e-5);
      N = normalize(N + vec3(dir.x, 0.0, dir.y) * ring * 1.35 * f);
      rainRip = ring * f;
    }
  }

  vec3 Nflat = N;
  bool underwater = uUnderwater > 0.5;
  vec3 V = normalize(uCamPos - vWorldPos);
  // Seeing the underside of the surface means the eye is inside the water — in
  // the trough of a wave that has closed over it, or behind the face of a
  // tsunami. The mesh is double-sided so the geometry is there, but with the
  // normal pointing away every lighting term collapses and the wall renders as
  // a black hole in the middle of the frame. Flip it and mark the fragment so
  // it can be shaded as a thick, backlit body of water instead.
  bool backLit = dot(N, V) < 0.0;
  if (backLit) N = -N;
  underwater = underwater || backLit;

  // -------------------------------------------------------------- roughness
  // Cox & Munk mean-square slope; only the sub-pixel part becomes roughness.
  float mssTotal = 0.003 + 0.00512 * max(uWindSpeed, 0.5);
  vec3 share = vec3(0.06, 0.30, 0.64);
  vec3 sampledLod = log2(max(vec3(fpShade) * (uOceanTexels / uOceanScales), vec3(1.0)));
  float lost = share.x * clamp(sampledLod.x / 6.0, 0.0, 1.0)
             + share.y * clamp(sampledLod.y / 6.0, 0.0, 1.0)
             + share.z * clamp(sampledLod.z / 6.0, 0.0, 1.0);
  lost = max(lost, 1.0 - microFade * 0.9);
  float mssUnres = mssTotal * lost + 0.0009;
  float alpha = clamp(sqrt(2.0 * mssUnres), 0.012, 0.62);
  float roughness = clamp(sqrt(alpha), 0.02, 0.86);

  // ------------------------------------------------------------------- foam
  vec4 t0 = sampleCascadeGrad(uOceanTurb0, q, uOceanScales.x, ddx, ddy);
  vec4 t1 = sampleCascadeGrad(uOceanTurb1, q, uOceanScales.y, ddx, ddy);
  vec4 t2 = sampleCascadeGrad(uOceanTurb2, q, uOceanScales.z, ddx, ddy);
  // The cascades overlap in space, so take the strongest raft rather than the
  // sum — adding them triple-counts a crest that all three see.
  float rawFoam = max(max(t0.r * 0.75, t1.r), t2.r * 0.45);
  float bubbles = t0.g * 0.35 + t1.g * 0.7 + t2.g * 0.3;

  float foamMask = (rawFoam * uFoamStrength + vCrest * 0.8) * (1.0 - vCalm * 0.9);

  // Erode with baked bubble rafts. The lookup is stretched along the wind
  // because Langmuir cells organise surface foam into windrows: long streaks
  // running downwind, tens of metres apart. Sampling isotropic noise instead
  // gives a spatter that reads as wet sand once it covers a whole wave face.
  vec2 wd = normalize(uWindDir + vec2(1e-5, 0.0));
  mat2 windFrame = mat2(wd.x, -wd.y, wd.y, wd.x);
  vec2 qs = windFrame * q;
  vec2 stretch = vec2(0.22, 1.0);   // long downwind, narrow across
  float t = uTime;
  vec2 gx = windFrame * ddx, gy = windFrame * ddy;
  vec4 fx0 = textureGrad(uFoamTex, qs * 0.031 * stretch + vec2(t * 0.004, -t * 0.003),
                         gx * 0.031 * stretch, gy * 0.031 * stretch);
  vec4 fx1 = textureGrad(uFoamTex, qs * 0.145 * stretch - vec2(t * 0.011, t * 0.008),
                         gx * 0.145 * stretch, gy * 0.145 * stretch);
  vec4 fx2 = textureGrad(uFoamTex, q * 0.62 + vec2(-t * 0.03, t * 0.021), ddx * 0.62, ddy * 0.62);
  float foamNoise = fx0.a * 0.5 + fx1.a * 0.42 + fx2.a * 0.22;
  float foamDetail = fx1.r * 0.55 + fx2.r * 0.45;
  float foamFine = fx2.g * 0.6 + fx1.g * 0.4;

  // Monahan whitecap coverage sets how easily a raft survives: a light breeze
  // leaves nothing behind, a storm keeps the sea streaked between breakers.
  // The noise multiplies rather than merely modulates, so where the windrow
  // pattern is empty the water stays water no matter how much foam the
  // simulation deposited there.
  float onset = mix(0.62, 0.26, clamp(uWhitecapCoverage / 0.16, 0.0, 1.0));
  float carved = foamMask * (0.10 + foamNoise * 1.55);
  float foam = smoothstep(onset, onset + 0.30, carved);
  foam *= mix(0.35, 1.0, foamDetail);
  float foamThin = smoothstep(onset * 0.55, onset + 0.30, carved);

  // foam perturbs the normal too
  N = normalize(N + vec3(fx2.r - fx2.b, 0.0, fx2.g - fx2.a) * foam * 0.35 * microFade);

  float NoV = max(dot(N, V), 1e-4);
  vec3 L = normalize(uSunDir);
  float NoL = dot(N, L);

  // --------------------------------------------------------------- lighting
  // The sky, the clouds and the spout all take the sun through the atmospheric
  // transmittance LUT; the sea used to take it raw, so at low elevations the
  // water kept a white midday sun while everything above it went red.
  vec3 tluPos = vec3(0.0, groundRadiusMM + max(uCamPos.y, 0.2) * 1e-6, 0.0);
  vec3 sunTrans = getValFromTLUT(uTransmittanceLUT, tluPos, uSunDir);
  vec3 sun = uSunColor * sunTrans * uSunIntensity * cloudShadow(vWorldPos, L);
  vec3 R = reflect(-V, N);

  // bend reflections that dive below the horizon back up along the surface
  float rUp = R.y;
  if (rUp < 0.0) R = normalize(vec3(R.x, mix(0.02, 0.35, roughness) - rUp * 0.15, R.z));

  // The GGX lobe half-angle is ~alpha radians; an equirect probe covers 2pi
  // across its width, so match the mip to the lobe instead of over-blurring —
  // the bright band just above the horizon is most of the water's reflection.
  float lobeTexels = alpha * 0.5 / (6.2831853 / max(uEnvWidth, 8.0));
  float envLod = clamp(log2(max(lobeTexels, 1.0)), 0.0, uEnvMaxLod);
  vec3 env = textureLod(uEnvMap, dirToEquirect(R), envLod).rgb;
  vec3 skyAmb = skyIrradiance(uEnvMap, uEnvMaxLod);

  float F = fresnelWater(NoV, roughness);

  // sun specular (disc-widened GGX)
  vec3 spec = vec3(0.0);
  if (NoL > 0.0) {
    vec3 H = normalize(L + V);
    float NoH = max(dot(N, H), 0.0);
    float VoH = max(dot(V, H), 1e-4);
    float a = alpha;
    float aP = clamp(a + 0.00465 / 2.0, 0.0, 1.0);
    float norm = (a * a) / (aP * aP);
    float D = ggxD(NoH, aP);
    float Vis = smithGGXCorrelated(NoV, max(NoL, 1e-4), a);
    float Fs = 0.02 + 0.98 * pow(1.0 - VoH, 5.0);
    spec = sun * D * Vis * Fs * NoL * norm;
  }
  spec += env * F * 0.0;   // (env already carries the mirror term below)

  // --------------------------------------------------- subsurface scattering
  // Everything the eye sees that did NOT reflect off the surface comes out of
  // the water body. Open ocean has a volume reflectance of a few percent that
  // peaks in the blue-green, and it is driven by the whole downwelling
  // irradiance, so it tracks the cloud deck through the probe.
  vec3 bodyR = uWaterScatter;

  // Light that entered a wave and left toward the eye: peaks looking into a
  // backlit crest, which is what makes a breaking wave glow. Only the wind-wave
  // relief counts — a crest is thin, which is the whole reason it lights up.
  float heightNorm = clamp(vWaveY * 0.35 + 0.35, 0.0, 1.5);
  // A tsunami face is not a backlit sheet, it is tens of metres of opaque
  // water, so the deeper the body behind the surface the less gets through.
  float thinness = 1.0 / (1.0 + max(vEventY, 0.0) * 0.075);
  float backlit = heightNorm * thinness
                * pow(clamp(dot(L, -V), 0.0, 1.0), 4.0)
                * pow(0.5 - 0.5 * dot(L, N), 3.0);
  vec3 scatter = bodyR * sun * backlit * 3.4 / (1.0 + max(0.0, -L.y) * 4.0);

  // Downwelling irradiance just under the surface: the direct beam landing on a
  // horizontal plane, plus the diffuse sky. skyIrradiance already returns E/pi,
  // so the beam needs its own 1/pi to sit on the same scale, and what the
  // surface reflects away never enters the volume.
  float sunUp = max(L.y, 0.0);
  vec3 beam = sun * sunUp * (1.0 - fresnelWater(max(sunUp, 1e-3), 0.0)) / PI_S;
  scatter += bodyR * (beam + skyAmb * 0.94);

  // Entrained bubbles keep scattering for a while after the crest has broken.
  scatter += bodyR * bubbles * 0.55 * (skyAmb * 1.6 + sun * 0.10);

  // Whatever little climbs back out of the deep water below.
  vec3 deep = uWaterAbsorb * skyAmb * 0.8;
  vec3 refracted = scatter + deep;

  // ------------------------------------------------------------- combine
  vec3 color = mix(refracted, env, F) + spec;

  if (backLit) {
    // Looking out through the body of the wave. Almost nothing specular
    // survives — past the critical angle the surface is a mirror pointing back
    // into the dark water — but a great deal of light diffuses through the
    // sheet, which is why the inside of a breaking wave glows green.
    float thickness = clamp(0.35 + vWaveY * 0.04, 0.15, 1.0);
    // What reaches the eye through a sheet of water is the light behind it cut
    // down by absorption — not the two or three percent that backscatters.
    // Driving this off the volume reflectance instead makes the inside of every
    // wave a black hole, which is exactly what a tsunami face used to look like.
    vec3 through = (sun * max(L.y, 0.05) * 0.45 + skyAmb * 1.15)
                 * uWaterAbsorb / (1.0 + thickness * 2.0);
    // plus the light that genuinely scattered inside the body, and the bubbles
    // entrained in it, which is what gives a breaking wave its green core —
    // over a metre or two of water. Through the shoulder of a solitary wave the
    // same term is a wall of jade, so it dies with the depth behind the surface.
    through += bodyR * (sun * 2.2 + skyAmb * 1.8) * thinness;
    through += bodyR * bubbles * skyAmb * 1.4;
    color = mix(through, color, 0.18);
  }

  // ---------------------------------------------------------------- foam mat
  if (foam > 0.002 || foamThin > 0.002) {
    float foamAO = mix(0.62, 1.0, foamFine);
    vec3 foamAlbedo = vec3(0.93, 0.96, 0.985) * foamAO;
    float wrapNoL = clamp((dot(N, L) + 0.45) / 1.45, 0.0, 1.0);
    vec3 foamLit = foamAlbedo * (sun * wrapNoL * 0.30 + skyAmb * 0.95);
    // bubbles scatter the sun through the raft
    foamLit += foamAlbedo * sun * pow(clamp(dot(V, -L), 0.0, 1.0), 3.0) * 0.10 * foamFine;
    vec3 fspec = vec3(0.0);
    if (NoL > 0.0) {
      vec3 H = normalize(L + V);
      float NoH = max(dot(N, H), 0.0);
      float aF = 0.55;
      fspec = sun * ggxD(NoH, aF) * smithGGXCorrelated(NoV, max(NoL, 1e-4), aF) * 0.04 * NoL;
    }
    color = mix(color, foamLit + fspec, foam);
    // The bubble slick trailing a breaker is translucent, not paint: it lifts
    // the water a little and kills the specular, it does not turn it white.
    color = mix(color, mix(color, foamLit, 0.20), foamThin * (1.0 - foam));
  }

  color += vec3(rainRip) * sun * 0.02;
  vec3 preLightning = color;

  // ----------------------------------------------------------- lightning
  color += lightningContribution(vWorldPos, N, V, uLightning0, uLightning1, uLightningColor)
         * (0.55 + foam * 1.6);
  color += uAmbientFlash * uLightningColor * (0.02 + foam * 0.35 + F * 0.25);

  // ------------------------------------------------------ aerial perspective
  vec2 screenUv = gl_FragCoord.xy / uResolution;
  vec4 ap = sampleAerial(screenUv, vDist);
  vec3 tr = pow(vec3(clamp(ap.a, 0.0, 1.0)), vec3(1.0, 1.06, 1.16));
  color = color * tr + ap.rgb * uSunIntensity;

  if (uDebugMode > 0.5) {
    vec3 dbg = vec3(0.0);
    int m = int(uDebugMode + 0.5);
    if (m == 1) dbg = N * 0.5 + 0.5;
    else if (m == 2) dbg = vec3(foam, foamThin, foamMask * 0.3);
    else if (m == 3) dbg = env * 0.05;
    else if (m == 4) dbg = vec3(F);
    else if (m == 5) dbg = abs(vDisp) * 0.1;
    else if (m == 6) dbg = ap.rgb * uSunIntensity * 0.1;
    else if (m == 7) dbg = vec3(t1.r, t1.g, t1.b);
    else if (m == 8) dbg = vec3(roughness);
    else if (m == 9) dbg = refracted * 0.5;
    else if (m == 10) dbg = spec * 0.02;
    else if (m == 11) dbg = vec3(vLods / 8.0);
    else if (m == 12) dbg = vec3(fract(vDist * 0.001), fract(vDist * 0.01), 0.0);
    else if (m == 13) dbg = preLightning / 3.0;
    else if (m == 14) dbg = (color - preLightning * tr) / 3.0;
    else if (m == 15) dbg = vec3(sun) / 3.0;
    else if (m == 16) dbg = color / 3.0;
    else if (m == 17) dbg = lightningContribution(vWorldPos, N, V, uLightning0, uLightning1, uLightningColor) / 3.0;
    else if (m == 18) dbg = vec3(uAmbientFlash, uLightning0.w, uLightning1.w) / 3.0;
    oColor = vec4(dbg * 3.0, 1.0);
    oVelocity = vec4(0.0, 0.0, vDist, 1.0);
    return;
  }

  oColor = vec4(max(color, vec3(0.0)), 1.0);

  vec2 cur = vClipNJ.xy / max(vClipNJ.w, 1e-6);
  vec2 prv = vPrevClipNJ.xy / max(vPrevClipNJ.w, 1e-6);
  oVelocity = vec4((cur - prv) * 0.5, vDist, foam);
}
`;

export class OceanMesh {
  constructor(oceanFFT, atmosphere, quality, cloudShared = null) {
    this.fft = oceanFFT;
    this.gridX = 0;
    this.gridY = 0;

    // NOTE: projectionMatrix / viewMatrix are three.js built-ins for raw
    // materials — declaring them here would overwrite the renderer's values.
    const uniforms = {
      uRMax: { value: 68000.0 },
      uGridSize: { value: new THREE.Vector2(1, 1) },
      uGridMargin: { value: 1.04 },
      uSkirt: { value: 1.1 },
      uGridPlane: { value: 0.0 },
      uEventSteps: { value: 16 },
      uEventBisect: { value: 8 },
      uCurrentStrength: { value: 26.0 },
      uDisplaceScale: { value: 1.0 },
      uCascadeGain: { value: new THREE.Vector3(1, 1, 1) },
      uWaterScatter: { value: new THREE.Vector3(0.018, 0.075, 0.088) },
      uWaterAbsorb: { value: new THREE.Vector3(0.004, 0.021, 0.036) },
      uFoamStrength: { value: 1.0 },
      uUnderwater: { value: 0 },
      uDebugMode: { value: 0 },
      ...U,
    };
    oceanFFT.bind(uniforms);
    atmosphere.bind(uniforms);
    // shared refs win over the private copies created by bind()
    uniforms.uSunDir = U.uSunDir;
    uniforms.uSunColor = U.uSunColor;
    uniforms.uSunIntensity = U.uSunIntensity;
    uniforms.uAtmoTurbidity = U.uAtmoTurbidity;
    uniforms.uAtmoMieG = U.uAtmoMieG;
    uniforms.uAtmoGroundAlbedo = U.uAtmoGroundAlbedo;
    uniforms.uInvViewProjNJ = U.uInvViewProjNJ;

    // Share the deck's own uniform objects rather than copying values, so the
    // shadows on the water are always the clouds that are actually up there.
    const cs = cloudShared;
    uniforms.uWeatherMap = cs?.uWeatherMap ?? { value: null };
    uniforms.uWeatherScaleM = cs?.uWeatherScaleM ?? { value: 58000 };
    uniforms.uCoverage = cs?.uCoverage ?? { value: 0 };
    uniforms.uCloudContrast = cs?.uCloudContrast ?? { value: 1.6 };
    uniforms.uCloudDensity = cs?.uCloudDensity ?? { value: 0.6 };
    uniforms.uCloudBottom = cs?.uCloudBottom ?? { value: 1200 };
    uniforms.uCloudWind = cs?.uCloudWind ?? { value: new THREE.Vector2() };
    uniforms.uCloudTime = cs?.uCloudTime ?? { value: 0 };

    this.uniforms = uniforms;
    this.material = new THREE.RawShaderMaterial({
      name: 'OceanSurface',
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    this.setResolution(quality.oceanGridX, quality.oceanGridY);
  }

  setResolution(gridX, gridY) {
    gridX = Math.max(16, gridX | 0); gridY = Math.max(12, gridY | 0);
    if (this.gridX === gridX && this.gridY === gridY) return;
    this.gridX = gridX; this.gridY = gridY;
    const old = this.mesh.geometry;
    this.mesh.geometry = buildProjectedGrid(gridX, gridY);
    if (old) old.dispose();
    this.uniforms.uGridSize.value.set(gridX, gridY);
    this.triangles = gridX * gridY * 2;
  }

  /**
   * @param surfaceY height of the water under the lens, disasters included.
   * Testing against absolute zero instead puts the whole ocean into the
   * submerged path the moment the camera rides the drawdown ahead of a
   * tsunami — which is well below mean sea level and entirely above water.
   */
  update(camPos, surfaceY = 0) {
    this.uniforms.uUnderwater.value = camPos.y < surfaceY ? 1 : 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
