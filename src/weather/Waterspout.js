import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { NOISE_GLSL } from '../gfx/NoiseGLSL.js';
import { ATMO_COMMON } from '../sky/AtmosphereGLSL.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';

/**
 * A condensation funnel: the visible part of a waterspout.
 *
 * The column is raymarched rather than built from geometry. A waterspout is a
 * thin sheath of cloud wrapped around a vortex core, and its whole character is
 * in how the sheath thins, tears and lets the sky through — none of which
 * survives being frozen into a mesh. Marching also gets the silhouette right
 * from any angle and lets the funnel fade into the parent cloud instead of
 * ending at a hard cap.
 */

const FUNNEL_VERT = /* glsl */ `
precision highp float;

in vec3 position;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

out vec3 vWorld;

void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FUNNEL_FRAG = /* glsl */ `
precision highp float;

${ATMO_COMMON}
${SHADING_GLSL}
${NOISE_GLSL}

in vec3 vWorld;

uniform vec3  uCamPos;
uniform float uTime;
uniform vec3  uSunDir;
uniform float uSunIntensity;
uniform sampler2D uTransmittanceLUT;
uniform sampler2D uSkyViewLUT;
uniform vec3  uLightningColor;
uniform float uAmbientFlash;
uniform vec2  uWindDir;

// xy = base position on the sea (world x, z), z = intensity 0..1, w = height
uniform vec4  uSpout;
#define SPOUT_XZ (uSpout.xy)
#define SPOUT_AMP (uSpout.z)
// x = base radius, y = top flare, z = lean, w = age in seconds
uniform vec4  uShape;
uniform int   uSteps;
uniform float uDebug;

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;

const float PLANET_R = 6360000.0;

// --------------------------------------------------------------- funnel form
// Where the axis sits at a given height. Real funnels lean downwind and snake:
// the vortex is embedded in a sheared flow, so each level is displaced a little
// further than the one below it and the whole column writhes on a slow period.
// A straight cone reads as a traffic cone no matter how well it is lit.
vec2 axisAt(float h){
  float t = uTime * 0.45;
  float lean = uShape.z * h * h;
  vec2 downwind = normalize(uWindDir + 1e-5);
  vec2 wander = vec2(
    sin(h * 3.1 + t * 1.1) * 0.55 + sin(h * 6.7 - t * 0.7) * 0.22,
    cos(h * 2.6 - t * 0.9) * 0.55 + cos(h * 5.3 + t * 1.3) * 0.22
  );
  return SPOUT_XZ + downwind * lean + wander * (14.0 + 30.0 * h);
}

// Sheath radius: a rope that necks down toward the water and opens out into the
// parent cloud at the top. The wobble matters as much as the taper — a perfect
// surface of revolution reads as turned metal however well it is shaded.
float radiusAt(float h){
  float tube = uShape.x * (0.48 + 0.85 * pow(h, 1.5));
  float flare = uShape.y * pow(smoothstep(0.58, 1.0, h), 2.6);
  float wob = 1.0 + 0.30 * sin(h * 7.3 - uTime * 0.9) * sin(h * 3.1 + uTime * 0.55)
                  + 0.14 * sin(h * 17.0 + uTime * 1.7);
  return tube * wob + flare;
}

/**
 * The analytic envelope of the column: sheath, hollow core and the spray
 * cascade at the waterline, with no noise at all.
 *
 * Kept separate from the textured density because it answers the two questions
 * that dominate the cost — "is this sample anywhere near the funnel" and "how
 * much water is between here and the sun" — and neither needs the detail. The
 * noise is only paid for on samples that actually contribute to the image.
 */
float funnelShape(vec3 p, float h, out float rn, out float ang, out float cascade){
  rn = 9.0; ang = 0.0; cascade = 0.0;
  vec2 d = p.xz - axisAt(h);
  float r = length(d);
  float R = radiusAt(h);
  if (r > R * 2.9 + 30.0) return 0.0;

  rn = r / max(R, 1.0);
  ang = atan(d.y, d.x);

  // Dense wall, hollow-ish core. Condensation tracks the steepest pressure
  // gradient, which sits at the radius of maximum wind rather than on the axis,
  // and that hollow is what gives a spout its glassy translucent edge.
  float wall = smoothstep(1.06, 0.80, rn) * smoothstep(0.10, 0.46, rn);
  float core = smoothstep(0.62, 0.0, rn) * 0.55;
  float body = wall + core;

  // ragged where it meets the water, dissolving into the parent cloud on top
  body *= mix(0.55, 1.0, smoothstep(0.0, 0.16, h));
  body *= 1.0 - smoothstep(0.86, 1.0, h) * 0.55;

  // Where the circulation reaches the sea it tears a cascade of spray off the
  // surface: far wider than the funnel, only tens of metres tall, and brighter
  // than the sheath because it is dense liquid water rather than vapour. It has
  // to stay low, or it stops reading as spray and becomes a plinth.
  float cascH = 22.0 + uShape.x * 0.7;
  if (p.y < cascH * 3.5) {
    float cr = r / (R * 3.4 + 34.0);
    cascade = exp(-p.y / cascH)
            * smoothstep(1.0, 0.30, cr)
            * smoothstep(0.0, 0.22, cr);
  }

  return max(body, 0.0);
}

// Textured density. Sampled in the rotating frame of the vortex so the noise
// resolves into helical striations climbing the column instead of a static
// crust. Angular speed rises as the radius drops — conservation of angular
// momentum, and the reason the neck of a spout always looks the most violent.
float funnelDetail(float shape, float cascade, float rn, float ang, float h, float y){
  float R = radiusAt(h);
  float omega = 3.4 * uShape.x / max(R, 4.0);
  float phase = ang + uTime * omega + h * 5.5;

  float n = vnoise3(vec3(phase * 1.7, h * 11.0 - uTime * 0.85, rn * 2.2));
  n = n * 0.62 + vnoise3(vec3(phase * 4.1, h * 26.0 - uTime * 1.7, rn * 4.0)) * 0.38;

  // Wide swing, because the striations are the only thing that keeps the sheath
  // from reading as a moulded surface, and a gentle modulation vanishes the
  // moment the column is optically thick.
  float body = shape * mix(0.10, 1.75, n);
  if (cascade > 0.001) {
    float cn = vnoise3(vec3(ang * 3.1 + uTime * 1.9, y * 0.10 - uTime * 0.8, rn * 2.4));
    cn = cn * 0.7 + vnoise3(vec3(ang * 7.0 - uTime * 2.6, y * 0.22, rn * 5.0)) * 0.3;
    // squared: spray is lumpy, with dense knots and torn gaps between them
    body += cascade * cn * cn * 3.4;
  }
  return max(body, 0.0) * SPOUT_AMP;
}

// Shadowing along the sun direction, so the column has a lit and an unlit side
// instead of glowing uniformly. The envelope alone is enough here: the light
// march only needs the bulk optical depth, and the striations average out.
float lightTransmittance(vec3 p, float top){
  float acc = 0.0;
  float step = max(top * 0.06, 8.0);
  for (int i = 1; i <= 2; ++i) {
    vec3 q = p + uSunDir * step * float(i);
    float h = clamp(q.y / top, 0.0, 1.0);
    float rn, ang, casc;
    acc += (funnelShape(q, h, rn, ang, casc) + casc * 1.2) * SPOUT_AMP;
  }
  return exp(-acc * step * 0.055);
}

void main(){
  // uDebug 3: paint every rasterised fragment of the proxy box, before any
  // analytic rejection, to separate "the box never draws" from "the march
  // rejects everything".
  if (uDebug > 2.5) {
    oColor = vec4(0.0, 0.0, 3.0, 0.4);
    oVelocity = vec4(0.0);
    return;
  }
  if (SPOUT_AMP <= 0.001) discard;

  vec3 ro = uCamPos;
  vec3 rd = normalize(vWorld - ro);
  float top = uSpout.w;

  // Bound the march to a vertical cylinder around the whole swept column. This
  // is far tighter than the proxy box and costs one quadratic.
  float Rmax = radiusAt(1.0) + 60.0;
  vec2 oc = ro.xz - SPOUT_XZ;
  float a = dot(rd.xz, rd.xz);
  float b = dot(oc, rd.xz);
  float c = dot(oc, oc) - Rmax * Rmax;
  float disc = b * b - a * c;
  if (disc <= 0.0 || a < 1e-6) discard;
  float sq = sqrt(disc);
  float t0 = (-b - sq) / a;
  float t1 = (-b + sq) / a;
  if (t1 <= 0.0) discard;
  t0 = max(t0, 0.0);

  // clip to the slab between the sea and the cloud base
  if (abs(rd.y) > 1e-5) {
    float ta = (0.0 - ro.y) / rd.y;
    float tb = (top - ro.y) / rd.y;
    float lo = min(ta, tb), hi = max(ta, tb);
    t0 = max(t0, lo); t1 = min(t1, hi);
  } else if (ro.y < 0.0 || ro.y > top) {
    discard;
  }
  if (t1 <= t0) discard;

  // The sea hides everything behind it. Cutting the ray at the water line stops
  // the funnel from painting over the ocean on the far side of the horizon.
  float seaT = 1e9;
  if (rd.y < -1e-5) seaT = (0.0 - ro.y) / rd.y;
  t1 = min(t1, seaT);
  if (t1 <= t0) discard;

  // uDebug 2: paint the bounding volume, so a missing funnel can be told apart
  // from a funnel that is simply too thin to see.
  if (uDebug > 1.5) {
    oColor = vec4(0.0, 3.0, 0.0, 0.35);
    oVelocity = vec4(0.0);
    return;
  }

  float span = t1 - t0;
  int steps = uSteps;
  float dt = span / float(steps);
  float jitter = bayer4(gl_FragCoord.xy);

  vec3 viewPos = vec3(0.0, groundRadiusMM + max(uCamPos.y, 0.2) * 1e-6, 0.0);
  vec3 sunCol = getValFromTLUT(uTransmittanceLUT, viewPos, uSunDir) * uSunIntensity;
  vec3 ambTop = getValFromSkyLUT(uSkyViewLUT, viewPos, vec3(0.0, 1.0, 0.0), uSunDir) * uSunIntensity;
  vec3 ambSide = getValFromSkyLUT(uSkyViewLUT, viewPos, normalize(vec3(rd.x, 0.08, rd.z)), uSunDir) * uSunIntensity;

  float cosT = dot(rd, uSunDir);
  // Water droplets throw most light forward; the strong forward lobe is why a
  // spout between you and the sun turns into a bright pillar.
  float phase = dualHG(cosT, 0.72, -0.15, 0.35) * 4.0;

  vec3 scatter = vec3(0.0);
  float transmit = 1.0;

  for (int i = 0; i < 96; ++i) {
    if (i >= steps || transmit < 0.012) break;
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    float h = clamp(p.y / top, 0.0, 1.0);

    float rn, ang, casc;
    float shape = funnelShape(p, h, rn, ang, casc);
    if (shape + casc < 0.004) continue;

    float dens = funnelDetail(shape, casc, rn, ang, h, p.y);
    if (dens > 0.002) {
      float lt = lightTransmittance(p, top);
      // Direct sun has to carry the form. Skylight is nearly isotropic, so
      // leaning on it flattens the column into a paper cut-out; the lit and
      // shadowed sides of the rope are what make it read as a solid volume.
      vec3 lum = sunCol * lt * phase * 1.6;
      lum += mix(ambSide * 0.9, ambTop * 1.15, h) * 0.26;
      // Deeper into the sheath is darker, because less skylight gets in.
      lum *= mix(1.0, 0.45, clamp(dens * 0.7, 0.0, 1.0));
      lum += uLightningColor * uAmbientFlash * 1.4;

      // Dense enough that the rope is solid where the sheath is thick, thin
      // enough that the march still resolves structure through it. Push this up
      // and every ray saturates on its first sample, which throws away the
      // striations and leaves a white plastic tube.
      float sigma = 0.042;
      float tr = exp(-dens * sigma * dt);
      scatter += lum * transmit * (1.0 - tr);
      transmit *= tr;
    }
  }

  float alpha = clamp(1.0 - transmit, 0.0, 1.0);
  if (alpha < 0.003) discard;

  if (uDebug > 0.5) {
    oColor = vec4(vec3(6.0, 0.0, 6.0) * alpha, alpha);
    oVelocity = vec4(0.0);
    return;
  }

  oColor = vec4(scatter, alpha);
  oVelocity = vec4(0.0);
}
`;

export class Waterspout {
  constructor() {
    this.active = false;
    this.x = 0;
    this.z = 0;
    this.age = 0;
    this.life = 0;
    this.maxLife = 34;
    this.strength = 1;

    this.uniforms = {
      uCamPos: U.uCamPos,
      uTime: U.uTime,
      uSunDir: U.uSunDir,
      uSunIntensity: U.uSunIntensity,
      uTransmittanceLUT: { value: null },
      uSkyViewLUT: { value: null },
      uLightningColor: U.uLightningColor,
      uAmbientFlash: U.uAmbientFlash,
      uWindDir: U.uWindDir,
      uAtmoTurbidity: U.uAtmoTurbidity,
      uAtmoMieG: U.uAtmoMieG,
      uAtmoGroundAlbedo: U.uAtmoGroundAlbedo,
      uSpout: { value: new THREE.Vector4(0, 0, 0, 900) },
      uShape: { value: new THREE.Vector4(26, 150, 90, 0) },
      uSteps: { value: 56 },
      uDebug: { value: 0 },
    };

    this.material = new THREE.RawShaderMaterial({
      name: 'Waterspout',
      glslVersion: THREE.GLSL3,
      vertexShader: FUNNEL_VERT,
      fragmentShader: FUNNEL_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // we march from the camera, so the proxy only needs to cover the pixels
      side: THREE.BackSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });

    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  setLUTs(atmosphere) {
    this.uniforms.uTransmittanceLUT.value = atmosphere.transmittanceRT.texture;
    this.uniforms.uSkyViewLUT.value = atmosphere.skyViewRT.texture;
  }

  setQuality(q) {
    this.uniforms.uSteps.value = q.spoutSteps ?? 56;
  }

  spawn(x, z, strength = 30) {
    this.active = true;
    this.x = x;
    this.z = z;
    this.life = 0;
    this.strength = strength;
    this.maxLife = 34;
  }

  /** Called every frame by the director as the vortex drifts downwind. */
  setPosition(x, z) {
    this.x = x;
    this.z = z;
  }

  clear() {
    this.active = false;
    this.mesh.visible = false;
  }

  update(dt, cloudBottom) {
    if (!this.active) {
      this.mesh.visible = false;
      return;
    }
    this.life += dt;
    const k = this.life / this.maxLife;
    if (k >= 1) { this.clear(); return; }

    // Spouts do not switch on. They reach down from the cloud, touch, spin up,
    // then rope out and dissipate — the decay is longer than the build.
    const grow = Math.min(1, this.life / 4.5);
    const decay = 1 - Math.pow(Math.max(0, (k - 0.72) / 0.28), 1.6);
    const intensity = Math.max(0, grow * decay);

    // The funnel hangs from the cloud, so it is as tall as the base is high.
    // Real spouts run a few hundred metres and are only tens of metres across:
    // slenderness is the whole silhouette, and a squat cone reads as a tornado
    // from a disaster movie rather than a waterspout.
    const top = Math.max(300, Math.min(cloudBottom ?? 900, 1500));
    const s = this.strength / 30;
    const neck = (9 + 9 * s) * (0.7 + 0.3 * grow);
    const flare = 30 + 45 * s;

    this.uniforms.uSpout.value.set(this.x, this.z, intensity, top);
    this.uniforms.uShape.value.set(neck, flare, (30 + 55 * s) * grow, this.life);

    // Keep the proxy box wrapped around the swept column.
    const rMax = neck * 1.4 + flare + 60 + 60;
    this.mesh.position.set(this.x, top * 0.5, this.z);
    this.mesh.scale.set(rMax * 2, top, rMax * 2);
    this.mesh.visible = true;
  }
}
