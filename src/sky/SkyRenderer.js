import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { FullScreenPass, makeRT } from '../gfx/FullScreenPass.js';
import { ATMO_COMMON } from './AtmosphereGLSL.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';
import { NOISE_GLSL } from '../gfx/NoiseGLSL.js';

const SKY_CORE = /* glsl */ `
uniform sampler2D uSkyViewLUT;
uniform sampler2D uTransmittanceLUT;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uStarIntensity;
uniform float uAmbientFlash;
uniform vec3 uLightningColor;
uniform vec4 uLightning0;
uniform vec4 uLightning1;
uniform vec3 uCamPos;

const float SUN_ANGULAR_RADIUS = 0.00465;

vec3 sunDisc(vec3 dir, vec3 sunDir, vec3 transmittance) {
  float cosT = dot(dir, sunDir);
  float ang = acos(clamp(cosT, -1.0, 1.0));
  if (ang > SUN_ANGULAR_RADIUS * 1.6) return vec3(0.0);
  float r = clamp(ang / SUN_ANGULAR_RADIUS, 0.0, 1.0);
  // Limb darkening (Hestroffer & Magnan coefficients)
  float mu = sqrt(max(1.0 - r * r, 0.0));
  vec3 u = vec3(1.0);
  vec3 a = vec3(0.397, 0.503, 0.652);
  vec3 factor = 1.0 - u * (1.0 - pow(vec3(mu), a));
  float edge = 1.0 - smoothstep(1.0, 1.35, ang / SUN_ANGULAR_RADIUS);
  return transmittance * factor * edge * 18000.0;
}

vec3 starField(vec3 dir, float intensity) {
  if (intensity < 0.001) return vec3(0.0);
  vec3 col = vec3(0.0);
  for (int oct = 0; oct < 2; oct++) {
    float scale = (oct == 0) ? 340.0 : 780.0;
    vec3 p = dir * scale;
    vec3 i = floor(p);
    vec3 f = fract(p) - 0.5;
    vec3 h = hash33(i);
    if (h.x > (oct == 0 ? 0.982 : 0.9955)) {
      vec3 off = (hash33(i + 7.31) - 0.5) * 0.7;
      float d = length(f - off);
      float mag = pow(h.y, 3.0);
      float twinkle = 0.75 + 0.25 * sin(h.z * 90.0 + uTimeStars * (1.2 + h.z * 2.5));
      float s = exp(-d * d * 900.0) * mag * twinkle;
      vec3 tint = mix(vec3(0.68, 0.78, 1.0), vec3(1.0, 0.82, 0.62), h.z);
      col += tint * s;
    }
  }
  // milky way band
  float band = exp(-pow(dot(normalize(dir), normalize(vec3(0.42, 0.28, -0.86))) * 2.6, 2.0));
  float mw = fbm2Tiled(dirToEquirect(dir) * 26.0, 26.0, 5);
  col += vec3(0.55, 0.62, 0.86) * band * mw * 0.055;
  return col * intensity * 8.0;
}
`;

const SKY_FRAG_BODY = /* glsl */ `
vec3 renderSky(vec3 dir, vec3 camPos) {
  vec3 viewPos = vec3(0.0, groundRadiusMM + max(camPos.y, 0.2) * 1e-6, 0.0);
  vec3 lum = getValFromSkyLUT(uSkyViewLUT, viewPos, dir, uSunDir);

  vec3 tr = getValFromTLUT(uTransmittanceLUT, viewPos, dir);
  if (dir.y > -0.02) {
    lum += sunDisc(dir, uSunDir, tr) * 0.00025;
  }

  // night sky
  float night = clamp(1.0 - (uSunDir.y + 0.12) * 6.0, 0.0, 1.0);
  lum += starField(dir, uStarIntensity * night) * 0.0016;

  return lum;
}
`;

const BACKGROUND_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;

const BACKGROUND_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProjNJ;
uniform mat4 uViewProjNJ;
uniform vec2 uResolution;
uniform sampler2D uCloudTex;
uniform float uCloudEnabled;
uniform float uTimeStars;
uniform float uFogDensity;

${ATMO_COMMON}
${SHADING_GLSL}
${NOISE_GLSL}
${SKY_CORE}
${SKY_FRAG_BODY}

in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 p0 = uInvViewProj * vec4(ndc, -1.0, 1.0); p0 /= p0.w;
  vec4 p1 = uInvViewProj * vec4(ndc,  1.0, 1.0); p1 /= p1.w;
  vec3 dir = normalize(p1.xyz - p0.xyz);

  // The LUTs store radiance per unit solar irradiance, so the sun's strength is
  // applied here. The cloud layer already carries it — folding it in before the
  // composite instead of after is the difference between a lit deck and one
  // that is a hundred times too bright.
  vec3 sky = renderSky(dir, uCamPos) * uSunIntensity;

  if (uCloudEnabled > 0.5) {
    vec4 cl = texture(uCloudTex, vUv);
    sky = sky * cl.a + cl.rgb;
  }

  sky += uAmbientFlash * uLightningColor * 0.012 * max(0.0, 1.0 - abs(dir.y));

  oColor = vec4(sky, 1.0);

  vec3 farPt = uCamPos + dir * 40000.0;
  vec4 cur = uViewProjNJ * vec4(farPt, 1.0);
  vec4 prv = uPrevViewProjNJ * vec4(farPt, 1.0);
  // z is the linear view distance the depth-of-field and fog passes read; the
  // sky is at infinity, and leaving it at zero makes the CoC solver treat the
  // whole dome as if it were pressed against the lens.
  oVelocity = vec4((cur.xy / cur.w - prv.xy / prv.w) * 0.5, 40000.0, 1.0);
}
`;

const ENV_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uCloudEnvTex;
uniform float uCloudEnabled;
uniform float uTimeStars;

${ATMO_COMMON}
${SHADING_GLSL}
${NOISE_GLSL}
${SKY_CORE}
${SKY_FRAG_BODY}

in vec2 vUv;
layout(location = 0) out vec4 oColor;

void main(){
  vec3 dir = equirectToDir(vUv);

  // Below the horizon the probe stands in for the sea itself. Leaving it black
  // would drain every rough reflection, so mirror the sky and tint it with the
  // water's own colour — that is very close to what a wave actually sees.
  float below = smoothstep(0.0, -0.22, dir.y);
  vec3 lookDir = mix(dir, vec3(dir.x, abs(dir.y) * 0.35 + 0.02, dir.z), below);

  vec3 sky = renderSky(normalize(lookDir), uCamPos) * uSunIntensity;
  if (uCloudEnabled > 0.5) {
    vec4 cl = texture(uCloudEnvTex, vUv);
    sky = sky * cl.a + cl.rgb;
  }
  sky += uAmbientFlash * uLightningColor * 0.012;
  sky = mix(sky, sky * vec3(0.16, 0.30, 0.38), below);
  oColor = vec4(sky, 1.0);
}
`;

export class SkyRenderer {
  constructor(renderer, atmosphere) {
    this.renderer = renderer;
    this.atmosphere = atmosphere;
    this.starIntensity = 1.0;

    const shared = {
      uSkyViewLUT: { value: atmosphere.skyViewRT.texture },
      uTransmittanceLUT: { value: atmosphere.transmittanceRT.texture },
      uSunDir: U.uSunDir,
      uMoonDir: U.uMoonDir,
      uSunColor: U.uSunColor,
      uSunIntensity: U.uSunIntensity,
      uCamPos: U.uCamPos,
      uStarIntensity: { value: 1.0 },
      uAmbientFlash: U.uAmbientFlash,
      uLightningColor: U.uLightningColor,
      uLightning0: U.uLightning0,
      uLightning1: U.uLightning1,
      uAtmoTurbidity: U.uAtmoTurbidity,
      uAtmoMieG: U.uAtmoMieG,
      uAtmoGroundAlbedo: U.uAtmoGroundAlbedo,
      uTimeStars: { value: 0 },
      uCloudEnabled: { value: 0 },
    };
    this.shared = shared;

    // ---- background (drawn into the main MRT before everything else)
    const bgGeom = new THREE.BufferGeometry();
    bgGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    bgGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    bgGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);

    this.bgMaterial = new THREE.RawShaderMaterial({
      name: 'SkyBackground',
      glslVersion: THREE.GLSL3,
      vertexShader: BACKGROUND_VERT,
      fragmentShader: BACKGROUND_FRAG,
      uniforms: {
        ...shared,
        uInvViewProj: U.uInvViewProj,
        uViewProjNJ: U.uViewProjNJ,
        uPrevViewProjNJ: U.uPrevViewProjNJ,
        uResolution: U.uResolution,
        uFogDensity: U.uFogDensity,
        uCloudTex: { value: null },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(bgGeom, this.bgMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;

    // ---- environment probe (equirect, mipmapped, used for ocean reflections)
    this.envRT = makeRT(256, 128, {
      type: THREE.HalfFloatType, name: 'envProbe',
      wrap: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, mipmaps: true,
    });
    this.envRT.texture.wrapS = THREE.RepeatWrapping;
    this.envRT.texture.wrapT = THREE.ClampToEdgeWrapping;

    this.envPass = new FullScreenPass(ENV_FRAG, {
      ...shared,
      uCloudEnvTex: { value: null },
    }, { name: 'envProbe' });

    U.uEnvMap.value = this.envRT.texture;
    // A 256-wide probe has mips 0..8; stopping at 7 leaves the roughest
    // reflections a mip sharper than the material asks for.
    U.uEnvMaxLod.value = Math.log2(256);
    U.uEnvWidth.value = 256;
  }

  setCloudTextures(screenTex, envTex) {
    this.bgMaterial.uniforms.uCloudTex.value = screenTex;
    this.envPass.uniforms.uCloudEnvTex.value = envTex;
    const on = screenTex ? 1 : 0;
    this.bgMaterial.uniforms.uCloudEnabled.value = on;
    this.envPass.uniforms.uCloudEnabled.value = on;
  }

  update(time) {
    this.shared.uTimeStars.value = time;
    this.bgMaterial.uniforms.uTimeStars.value = time;
    this.envPass.uniforms.uTimeStars.value = time;
    this.bgMaterial.uniforms.uStarIntensity.value = this.starIntensity;
    this.envPass.uniforms.uStarIntensity.value = this.starIntensity;
  }

  renderEnv() {
    this.envPass.render(this.renderer, this.envRT);
  }
}
