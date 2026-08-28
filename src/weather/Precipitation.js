import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { NOISE_GLSL } from '../gfx/NoiseGLSL.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';

/**
 * Rain, entirely in the vertex shader.
 *
 * Each instance owns a fixed slot in a box that travels with the camera. The
 * slot's position is a hash of its index; the drop falls at its own terminal
 * velocity, is pushed sideways by the wind, and wraps modulo the box height, so
 * the whole field is a closed-form function of time with no simulation state
 * and no CPU work at all.
 *
 * A drop is drawn as a streak: the quad is stretched along the drop's velocity
 * by roughly the distance it covers during the shutter interval, which is what
 * a camera actually records. Streaks are shaded as thin water cylinders — they
 * refract the sky behind them, so they read bright against a dark sea and dark
 * against a bright sky, exactly like real rain.
 */

const RAIN_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
in float aIndex;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform float uTime;
uniform float uRain;
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform float uGustiness;
uniform vec2 uBox;          // (half extent, height)
uniform float uCount;
uniform float uStreak;      // shutter length in seconds
uniform float uSeaLevel;
uniform float uPixelScale;  // world units per pixel at one metre of depth
uniform float uDebug;

out vec2 vUv;
out float vFade;
out float vSeed;
out float vThin;
out vec3 vWorld;

${NOISE_GLSL}

void main(){
  float id = aIndex;
  vec3 h = hash33(vec3(id * 0.0013, id * 0.0071, id * 0.0037));
  vSeed = h.z;

  // Only a fraction of the slots are live at low rain rates. Fading a drop in
  // rather than popping it keeps the onset of a squall smooth.
  float live = step(h.x, clamp(uRain * 1.15, 0.0, 1.0));

  // Bias the field toward the camera's view direction: rain behind the lens is
  // wasted geometry, so the box is pushed forward along the look vector.
  vec3 anchor = uCamPos + uCamFwd * uBox.x * 0.45;
  anchor.y = uCamPos.y;

  // terminal velocity of a raindrop, 4 m/s for drizzle to 9 m/s for a downpour
  float size = mix(0.35, 1.0, h.y);
  float vy = mix(4.2, 9.4, size) * mix(0.85, 1.15, h.z);
  vec2 gust = uWindDir * uWindSpeed * (0.78 + uGustiness * 0.5 * sin(uTime * 0.7 + h.z * 6.28));

  // wrap the fall so the slot recycles without any state
  float fall = mod(h.z * uBox.y + uTime * vy, uBox.y);
  vec3 wp;
  wp.y = anchor.y + uBox.y * 0.55 - fall;

  // Uniform density in space wastes almost every drop: at 80 m a raindrop is
  // far under a pixel. Biasing the radius toward the camera gives roughly
  // uniform density on screen instead, which is what the eye reads as rain.
  float ang = h.x * 6.2831853;
  float rad = uBox.x * pow(h.y, 1.7);
  vec2 drift = gust * (fall / max(vy, 0.1));
  wp.xz = anchor.xz + vec2(cos(ang), sin(ang)) * rad + drift;
  // keep the slab centred on the camera as the drift carries it away
  wp.xz -= floor((wp.xz - anchor.xz) / (2.0 * uBox.x) + 0.5) * (2.0 * uBox.x);

  vec3 vel = vec3(gust.x, -vy, gust.y);
  float speed = length(vel);
  vec3 dir = vel / max(speed, 1e-4);

  vec3 toEye = uCamPos - wp;
  float dist = length(toEye);
  toEye /= max(dist, 1e-4);
  vec3 side = normalize(cross(dir, toEye));

  // The streak is what the shutter integrates: the drop's own length is
  // irrelevant, only how far it travels while the frame is open.
  float len = clamp(speed * uStreak, 0.30, 3.2) * mix(0.7, 1.3, size);

  // A raindrop is a few millimetres across, which is far under a pixel at any
  // useful distance. Rasterising that honestly gives a flickering dotted mess,
  // so the quad is held at a floor of about one pixel and the opacity is scaled
  // down by exactly the factor it was widened. That keeps the total light the
  // streak contributes correct, and it is what makes distant rain settle into a
  // grey veil instead of a swarm of confetti.
  float worldPerPx = uPixelScale * dist;
  float trueWide = mix(0.006, 0.016, size);
  float wide = max(trueWide, worldPerPx * 1.15);
  vThin = clamp(trueWide / wide, 0.10, 1.0);

  vec3 p = wp + dir * (position.y - 0.5) * len + side * position.x * wide;

  // Rain arrives in curtains, not as a uniform field. A slow noise sheet
  // drifting downwind gates whole swathes of the box, which is most of what
  // sells a squall — and it means the near field breathes as gusts pass.
  vec2 curtainUv = (wp.xz - uWindDir * uTime * 9.0) * 0.0055;
  float curtain = fbm2Tiled(curtainUv, 64.0, 3) * 0.5 + 0.55;
  curtain = smoothstep(0.30, 0.72, curtain + uRain * 0.35);

  // fade at the box edges and kill anything that has fallen into the sea
  float edge = 1.0 - smoothstep(uBox.x * 0.72, uBox.x, length(wp.xz - anchor.xz));
  float above = smoothstep(-0.5, 2.0, wp.y - uSeaLevel);
  vFade = live * edge * above * curtain * clamp(uRain * 1.6, 0.0, 1.0);

  vUv = vec2(position.x, position.y);
  vWorld = wp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  if (vFade <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
}
`;

const RAIN_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in float vFade;
in float vSeed;
in float vThin;
in vec3 vWorld;

uniform sampler2D uEnvMap;
uniform float uEnvMaxLod;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uCamPos;
uniform vec3 uLightningColor;
uniform float uAmbientFlash;
uniform float uDebug;

${SHADING_GLSL}

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;

void main(){
  // cylindrical cross-section: bright core falling off to the edges
  float r = vUv.x * 2.0;
  float body = sqrt(max(1.0 - r * r, 0.0));
  float ends = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.88, 1.0, vUv.y));
  if (uDebug > 0.5) {
    float ad = vFade * body * ends;
    oColor = vec4(vec3(30.0, 0.0, 30.0) * ad, ad);
    oVelocity = vec4(0.0);
    return;
  }

  // A drop is a lens. It gathers light from a wide cone and concentrates it
  // toward the eye, which is why rain reads bright against a dark sea even
  // under a flat grey sky — the streak is far brighter than the sky behind it.
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 look = normalize(vWorld - uCamPos);
  vec3 refr = normalize(mix(look, up, 0.55 + r * 0.25));
  vec3 lens = textureLod(uEnvMap, dirToEquirect(refr), uEnvMaxLod * 0.45).rgb;

  // total internal reflection puts a hard glint on the sun side of the drop
  float glint = pow(max(dot(refr, uSunDir), 0.0), 24.0);
  vec3 col = lens * (1.15 + body * 0.7) + uSunColor * uSunIntensity * glint * 0.9;
  col += uLightningColor * uAmbientFlash * 2.5;

  float a = vFade * body * ends * vThin * 0.7;
  oColor = vec4(col * a, a);
  // leave the velocity/depth buffer alone: these are transparent overlays and
  // should inherit the motion of whatever they are drawn over
  oVelocity = vec4(0.0);
}
`;

export class Rain {
  constructor(quality) {
    const geom = new THREE.InstancedBufferGeometry();
    const quad = new Float32Array([
      -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0,
      -0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
    ]);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
    geom.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

    this.max = quality.rainCount ?? 24000;
    const idx = new Float32Array(this.max);
    for (let i = 0; i < this.max; i++) idx[i] = i;
    geom.setAttribute('aIndex', new THREE.InstancedBufferAttribute(idx, 1));
    geom.instanceCount = 0;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.RawShaderMaterial({
      name: 'Rain',
      glslVersion: THREE.GLSL3,
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      uniforms: {
        uCamPos: U.uCamPos,
        uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
        uTime: U.uTime,
        uRain: U.uRain,
        uWindDir: U.uWindDir,
        uWindSpeed: U.uWindSpeed,
        uGustiness: U.uGustiness,
        uSeaLevel: U.uSeaLevel,
        uBox: { value: new THREE.Vector2(80, 52) },
        uCount: { value: this.max },
        uStreak: { value: 0.042 },
        uPixelScale: { value: 0.002 },
        uEnvMap: U.uEnvMap,
        uEnvMaxLod: U.uEnvMaxLod,
        uSunDir: U.uSunDir,
        uSunColor: U.uSunColor,
        uSunIntensity: U.uSunIntensity,
        uLightningColor: U.uLightningColor,
        uAmbientFlash: U.uAmbientFlash,
        uDebug: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      // colour is premultiplied in the shader
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });

    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.geom = geom;
  }

  setQuality(q) {
    this.max = Math.min(this.max, q.rainCount ?? this.max);
    this.budget = q.rainCount ?? this.max;
  }

  update(camera, rain, viewHeightPx) {
    const n = Math.min(this.max, Math.ceil((this.budget ?? this.max) * Math.min(rain * 1.2, 1)));
    this.geom.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    camera.getWorldDirection(this.material.uniforms.uCamFwd.value);
    // metres per pixel per metre of depth, so the shader only has to multiply
    const h = Math.max(viewHeightPx || 720, 16);
    this.material.uniforms.uPixelScale.value =
      2 * Math.tan(camera.fov * 0.5 * Math.PI / 180) / h;
  }
}

/**
 * Wind-blown spray.
 *
 * Torn from breaking crests, so emission is driven by the FFT turbulence field
 * rather than scattered blindly: the simulation pass looks up the spray channel
 * of the wind-sea cascade at a candidate point and only respawns a particle
 * where the water is actually breaking. Particles then ballistically follow the
 * wind with drag until they fall back into the sea.
 *
 * State lives in two float textures (position+age, velocity+seed) stepped by a
 * full-screen pass, and the draw is one instanced quad per texel.
 */
const SPRAY_SIM = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D uPos;      // xyz = world position, w = age
uniform sampler2D uVel;      // xyz = velocity, w = seed
uniform float uDt;
uniform float uTime;
uniform vec3 uCamPos;
uniform float uSprayAmount;
uniform float uRadius;
uniform float uFrame;

${NOISE_GLSL}
OCEAN_SAMPLE_PLACEHOLDER

in vec2 vUv;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;

/**
 * Sea surface height under a world xz, including the analytic modifiers.
 * The cascades have no mip chain, so every fetch has to be level 0.
 */
float seaHeight(vec2 xz, out float breaking) {
  float foamHint;
  vec2 q = swirlCoords(xz, uTime);
  vec3 d = oceanDisplacementLod(q, vec3(0.0), foamHint);
  float crest, calm;
  vec3 m = oceanModifiers(xz, uTime, crest, calm);
  // spray is torn where the wind sea breaks; the swell cascade contributes the
  // big plunging crests and the capillary one is far too fine to matter
  vec4 t0 = texture(uOceanTurb0, q / uOceanScales.x);
  vec4 t1 = texture(uOceanTurb1, q / uOceanScales.y);
  breaking = max(max(t1.a, t0.a * 0.7), crest);
  return d.y + m.y + uSeaLevel;
}

void main(){
  vec4 P = texture(uPos, vUv);
  vec4 V = texture(uVel, vUv);
  float age = P.w;
  float seed = V.w;

  // NaN never compares true, so a texel that started as uninitialised garbage
  // would stay "alive" forever with a position that never rasterises.
  bool dead = !(age > 0.0) || any(isnan(P.xyz)) || any(isnan(V.xyz));
  if (!dead) {
    // drag toward the local wind, gravity, and a little turbulent jitter
    vec3 wind = vec3(uWindDir.x, 0.0, uWindDir.y) * uWindSpeed;
    vec3 rel = wind - V.xyz;
    // small droplets couple to the air much faster than large ones
    float drag = mix(0.35, 2.6, seed);
    V.xyz += (rel * drag - vec3(0.0, 9.81, 0.0)) * uDt;
    V.xyz += (hash33(P.xyz * 0.7 + uTime) - 0.5) * uWindSpeed * 0.35 * uDt;
    P.xyz += V.xyz * uDt;
    age -= uDt;

    float breaking;
    float sea = seaHeight(P.xz, breaking);
    if (P.y < sea - 0.15) age = 0.0;
    if (length(P.xz - uCamPos.xz) > uRadius * 1.35) age = 0.0;
    dead = age <= 0.0;
  }

  if (dead) {
    // Look for a breaking crest to be born on. Whitecaps cover a few percent of
    // the sea even in a gale, so a single blind candidate per frame would take
    // a hundred frames to fill the budget; three keeps the refill snappy while
    // the cost stays a fixed handful of taps.
    P = vec4(0.0, -1e6, 0.0, 0.0);
    V = vec4(0.0);
    for (int k = 0; k < 3; k++) {
      vec3 r = hash33(vec3(vUv * 512.0, uFrame * 0.017 + float(k) * 7.31));
      float ang = r.x * 6.2831853;
      // Uniform area sampling puts almost every droplet in the far ring where
      // it is sub-pixel. Bias the radius inward so screen density is even.
      float rad = uRadius * pow(r.y, 1.55) + 4.0;
      vec2 xz = uCamPos.xz + vec2(cos(ang), sin(ang)) * rad;
      float breaking;
      float sea = seaHeight(xz, breaking);

      if (r.z < breaking * uSprayAmount * 2.2) {
        vec3 wind = vec3(uWindDir.x, 0.0, uWindDir.y) * uWindSpeed;
        P = vec4(xz.x, sea + 0.3, xz.y, mix(1.1, 3.4, r.z));
        // torn off the crest: mostly downwind, with an upward kick
        vec3 kick = wind * mix(0.45, 1.05, r.x)
                  + vec3(0.0, 1.0, 0.0) * (3.5 + breaking * 9.0) * mix(0.6, 1.5, r.y);
        // splash out sideways as well, so a crest reads as a bursting sheet
        vec2 lat = vec2(-uWindDir.y, uWindDir.x) * (r.x - 0.5) * uWindSpeed * 0.35;
        V = vec4(kick + vec3(lat.x, 0.0, lat.y), r.y);
        break;
      }
    }
  } else {
    P.w = age;
  }

  oPos = P;
  oVel = V;
}
`;

const SPRAY_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec3 position;
in vec2 aTexel;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform vec3 uCamPos;
uniform float uSize;
uniform float uDebug;

out vec2 vUv;
out float vAlpha;
out float vSeed;
out vec3 vWorld;

void main(){
  // explicit level: a vertex stage has no derivatives to pick one from
  vec4 P = textureLod(uPos, aTexel, 0.0);
  vec4 V = textureLod(uVel, aTexel, 0.0);
  vUv = position.xy;

  if (uDebug > 1.5) {
    vAlpha = P.w > 0.0 ? 1.0 : 0.0; vSeed = 0.5;
    vec3 c = P.xyz;
    vWorld = c;
    vec3 te = normalize(uCamPos - c);
    vec3 sd = normalize(cross(vec3(0.0, 1.0, 0.0), te));
    vec3 upv = cross(te, sd);
    gl_Position = projectionMatrix * modelViewMatrix
                * vec4(c + sd * position.x * 2.0 + upv * position.y * 2.0, 1.0);
    return;
  }
  vSeed = V.w;

  if (P.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }

  // fade in as it is torn off, fade out as the droplet evaporates or falls
  float life = clamp(P.w / 2.6, 0.0, 1.0);
  vAlpha = smoothstep(0.0, 0.12, 1.0 - life) * smoothstep(0.0, 0.35, life);

  vec3 toEye = uCamPos - P.xyz;
  float dist = length(toEye);
  toEye /= max(dist, 1e-4);
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toEye));
  vec3 up = cross(toEye, side);

  // stretch along the direction of travel: fast droplets read as streaks
  float speed = length(V.xyz);
  vec3 dir = V.xyz / max(speed, 1e-4);
  float stretch = 1.0 + clamp(speed * 0.05, 0.0, 2.2);
  vec3 axis = normalize(dir - toEye * dot(dir, toEye) + side * 1e-5);
  vec3 perp = cross(toEye, axis);

  // grow with distance so a far plume keeps a few pixels instead of aliasing
  float s = uSize * mix(0.55, 1.9, vSeed) * (1.0 + dist * 0.018);
  vec3 wp = P.xyz + axis * (position.y * s * stretch) + perp * (position.x * s);

  vWorld = wp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}
`;

const SPRAY_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in float vAlpha;
in float vSeed;
in vec3 vWorld;

uniform sampler2D uEnvMap;
uniform float uEnvMaxLod;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uCamPos;
uniform vec3 uLightningColor;
uniform float uAmbientFlash;
uniform float uDebug;

${SHADING_GLSL}

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;

void main(){
  float d = length(vUv);
  if (d > 1.0) discard;
  // soft droplet cluster, denser in the middle
  float a = pow(1.0 - d, 1.6) * vAlpha;
  if (uDebug > 0.5) {
    oColor = vec4(vec3(0.0, 30.0, 10.0) * a, a);
    oVelocity = vec4(0.0);
    return;
  }

  vec3 look = normalize(vWorld - uCamPos);
  // A droplet cloud scatters mostly forward: it lights up when the sun is
  // behind it, which is what makes wind-torn spray glow off a wave crest.
  float mu = dot(look, uSunDir);
  float phase = 0.55 + 1.9 * pow(max(mu, 0.0), 6.0);

  vec3 sky = textureLod(uEnvMap, dirToEquirect(vec3(look.x, abs(look.y) * 0.5 + 0.2, look.z)), uEnvMaxLod * 0.6).rgb;
  vec3 col = sky * 0.85 + uSunColor * uSunIntensity * phase * 0.12;
  col += uLightningColor * uAmbientFlash * 0.5;

  oColor = vec4(col * a, a * 0.85);
  oVelocity = vec4(0.0);
}
`;

export class Spray {
  constructor(renderer, oceanFFT, quality, FullScreenPassCls, makeRTFn, PingPongCls, oceanGlsl) {
    this.renderer = renderer;
    this.size = 0;
    this._FullScreenPass = FullScreenPassCls;
    this._makeRT = makeRTFn;
    this._PingPong = PingPongCls;
    this.oceanFFT = oceanFFT;

    const simSrc = SPRAY_SIM.replace('OCEAN_SAMPLE_PLACEHOLDER', oceanGlsl);
    this.simUniforms = {
      uPos: { value: null }, uVel: { value: null },
      uDt: { value: 0.016 }, uTime: U.uTime, uFrame: U.uFrame,
      uCamPos: U.uCamPos, uSprayAmount: U.uSprayAmount,
      uRadius: { value: 420 },
      ...U,
    };
    oceanFFT.bind(this.simUniforms);
    this.simPass = new FullScreenPassCls(simSrc, this.simUniforms, { name: 'spraySim' });

    this.material = new THREE.RawShaderMaterial({
      name: 'Spray',
      glslVersion: THREE.GLSL3,
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      uniforms: {
        uPos: { value: null }, uVel: { value: null },
        uCamPos: U.uCamPos, uSize: { value: 0.55 }, uDebug: { value: 0 },
        uEnvMap: U.uEnvMap, uEnvMaxLod: U.uEnvMaxLod,
        uSunDir: U.uSunDir, uSunColor: U.uSunColor, uSunIntensity: U.uSunIntensity,
        uLightningColor: U.uLightningColor, uAmbientFlash: U.uAmbientFlash,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });

    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0,
    ]), 3));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geom = geom;
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;

    this.setQuality(quality);
  }

  setQuality(q) {
    const side = Math.max(8, Math.round(Math.sqrt(q.sprayCount ?? 4096)));
    if (side === this.size) return;
    this.size = side;
    this.state?.dispose();
    this.state = new this._PingPong(side, side, {
      type: THREE.FloatType, minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter, count: 2, name: 'sprayState',
    });
    const texels = new Float32Array(side * side * 2);
    for (let y = 0, i = 0; y < side; y++) {
      for (let x = 0; x < side; x++, i += 2) {
        texels[i] = (x + 0.5) / side;
        texels[i + 1] = (y + 0.5) / side;
      }
    }
    this.geom.setAttribute('aTexel', new THREE.InstancedBufferAttribute(texels, 2));
    this.geom.instanceCount = side * side;
    this.reset = true;
  }

  update(dt, sprayAmount) {
    const on = sprayAmount > 0.005;
    this.mesh.visible = on;
    if (!on) return;
    const s = this.state;
    this.simPass.set('uPos', s.read.textures[0]);
    this.simPass.set('uVel', s.read.textures[1]);
    this.simPass.uniforms.uDt.value = Math.min(dt, 0.05);
    this.simPass.uniforms.uRadius.value = 420;
    this.simPass.render(this.renderer, s.write);
    s.swap();
    this.material.uniforms.uPos.value = s.read.textures[0];
    this.material.uniforms.uVel.value = s.read.textures[1];
  }

  dispose() { this.state?.dispose(); this.simPass?.dispose(); }
}
