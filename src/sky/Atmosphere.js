import * as THREE from 'three';
import { FullScreenPass, makeRT } from '../gfx/FullScreenPass.js';
import { ATMO_COMMON, ATMO_RAYMARCH } from './AtmosphereGLSL.js';

const TLUT_W = 256, TLUT_H = 64;
const MSLUT = 32;
const SKY_W = 200, SKY_H = 128;
const AP_SLICES = 32, AP_RES = 32;   // aerial perspective froxels, stored as a 2D atlas

const TRANSMITTANCE_FRAG = /* glsl */ `
${ATMO_COMMON}
in vec2 vUv;
layout(location = 0) out vec4 oCol;
const float sunTransmittanceSteps = 40.0;

vec3 getSunTransmittance(vec3 pos, vec3 sunDir) {
  if (rayIntersectSphere(pos, sunDir, groundRadiusMM) > 0.0) return vec3(0.0);
  float atmoDist = rayIntersectSphere(pos, sunDir, atmosphereRadiusMM);
  float t = 0.0;
  vec3 transmittance = vec3(1.0);
  for (float i = 0.0; i < sunTransmittanceSteps; i += 1.0) {
    float newT = ((i + 0.3) / sunTransmittanceSteps) * atmoDist;
    float dt = newT - t; t = newT;
    vec3 newPos = pos + t * sunDir;
    vec3 rs, ext; float ms;
    scatteringValues(newPos, rs, ms, ext);
    transmittance *= exp(-dt * ext);
  }
  return transmittance;
}

void main(){
  float u = vUv.x, v = vUv.y;
  float sunCosTheta = 2.0 * u - 1.0;
  float sunTheta = acos(clamp(sunCosTheta, -1.0, 1.0));
  float height = mix(groundRadiusMM, atmosphereRadiusMM, v);
  vec3 pos = vec3(0.0, height, 0.0);
  vec3 sunDir = normalize(vec3(0.0, sunCosTheta, -sin(sunTheta)));
  oCol = vec4(getSunTransmittance(pos, sunDir), 1.0);
}
`;

const MULTISCATTER_FRAG = /* glsl */ `
${ATMO_COMMON}
uniform sampler2D uTransmittance;
in vec2 vUv;
layout(location = 0) out vec4 oCol;

const float mulScattSteps = 20.0;
const int sqrtSamples = 8;

vec3 getSphericalDir(float theta, float phi) {
  float cosPhi = cos(phi), sinPhi = sin(phi);
  float cosTheta = cos(theta), sinTheta = sin(theta);
  return vec3(sinPhi * sinTheta, cosPhi, sinPhi * cosTheta);
}

void getMulScattValues(vec3 pos, vec3 sunDir, out vec3 lumTotal, out vec3 fms) {
  lumTotal = vec3(0.0); fms = vec3(0.0);
  float invSamples = 1.0 / float(sqrtSamples * sqrtSamples);
  for (int i = 0; i < sqrtSamples; i++) {
    for (int j = 0; j < sqrtSamples; j++) {
      float theta = PI_A * (float(i) + 0.5) / float(sqrtSamples);
      float phi = acos(1.0 - 2.0 * (float(j) + 0.5) / float(sqrtSamples));
      vec3 rayDir = getSphericalDir(theta, phi);

      float atmoDist = rayIntersectSphere(pos, rayDir, atmosphereRadiusMM);
      float groundDist = rayIntersectSphere(pos, rayDir, groundRadiusMM);
      float tMax = atmoDist;
      if (groundDist > 0.0) tMax = groundDist;

      float cosTheta = dot(rayDir, sunDir);
      float miePhaseValue = miePhase(cosTheta);
      float rayleighPhaseValue = rayleighPhase(-cosTheta);

      vec3 lum = vec3(0.0), lumFactor = vec3(0.0), transmittance = vec3(1.0);
      float t = 0.0;
      for (float stepI = 0.0; stepI < mulScattSteps; stepI += 1.0) {
        float newT = ((stepI + 0.3) / mulScattSteps) * tMax;
        float dt = newT - t; t = newT;
        vec3 newPos = pos + t * rayDir;

        vec3 rayleighScattering, extinction; float mieScattering;
        scatteringValues(newPos, rayleighScattering, mieScattering, extinction);
        vec3 sampleTransmittance = exp(-dt * extinction);

        vec3 scatteringNoPhase = rayleighScattering + vec3(mieScattering);
        vec3 scatteringF = (scatteringNoPhase - scatteringNoPhase * sampleTransmittance) / max(extinction, vec3(1e-7));
        lumFactor += transmittance * scatteringF;

        vec3 sunTransmittance = getValFromTLUT(uTransmittance, newPos, sunDir);
        vec3 rayleighInScattering = rayleighScattering * rayleighPhaseValue;
        vec3 mieInScattering = vec3(mieScattering * miePhaseValue);
        vec3 inScattering = (rayleighInScattering + mieInScattering) * sunTransmittance;

        vec3 scatteringIntegral = (inScattering - inScattering * sampleTransmittance) / max(extinction, vec3(1e-7));
        lum += scatteringIntegral * transmittance;
        transmittance *= sampleTransmittance;
      }

      if (groundDist > 0.0) {
        vec3 hitPos = pos + groundDist * rayDir;
        if (dot(pos, sunDir) > 0.0) {
          hitPos = normalize(hitPos) * groundRadiusMM;
          lum += transmittance * uAtmoGroundAlbedo * getValFromTLUT(uTransmittance, hitPos, sunDir);
        }
      }
      fms += lumFactor * invSamples;
      lumTotal += lum * invSamples;
    }
  }
}

void main(){
  float sunCosTheta = 2.0 * vUv.x - 1.0;
  float sunTheta = acos(clamp(sunCosTheta, -1.0, 1.0));
  float height = mix(groundRadiusMM, atmosphereRadiusMM, vUv.y);
  vec3 pos = vec3(0.0, height, 0.0);
  vec3 sunDir = normalize(vec3(0.0, sunCosTheta, -sin(sunTheta)));
  vec3 lum, f_ms;
  getMulScattValues(pos, sunDir, lum, f_ms);
  vec3 psi = lum / max(1.0 - f_ms, vec3(1e-5));
  oCol = vec4(psi, 1.0);
}
`;

const SKYVIEW_FRAG = /* glsl */ `
${ATMO_COMMON}
${ATMO_RAYMARCH}
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform vec3 uSunDir;
uniform float uViewHeightMM;
in vec2 vUv;
layout(location = 0) out vec4 oCol;

void main(){
  float u = vUv.x, v = vUv.y;
  vec3 viewPos = vec3(0.0, uViewHeightMM, 0.0);
  float azimuthAngle = (u - 0.5) * 2.0 * PI_A;
  float adjV;
  if (v < 0.5) { float c = 1.0 - 2.0 * v; adjV = -c * c; }
  else { float c = v * 2.0 - 1.0; adjV = c * c; }

  float height = length(viewPos);
  vec3 up = viewPos / height;
  float horizonAngle = acos(clamp(sqrt(max(height*height - groundRadiusMM*groundRadiusMM, 0.0)) / height, -1.0, 1.0)) - 0.5 * PI_A;
  float altitudeAngle = adjV * 0.5 * PI_A - horizonAngle;

  float cosAltitude = cos(altitudeAngle);
  vec3 rayDir = vec3(cosAltitude * sin(azimuthAngle), sin(altitudeAngle), -cosAltitude * cos(azimuthAngle));

  float sunAltitude = (0.5 * PI_A) - acos(clamp(dot(uSunDir, up), -1.0, 1.0));
  vec3 sunDir = vec3(0.0, sin(sunAltitude), -cos(sunAltitude));

  float atmoDist = rayIntersectSphere(viewPos, rayDir, atmosphereRadiusMM);
  float groundDist = rayIntersectSphere(viewPos, rayDir, groundRadiusMM);
  float tMax = (groundDist < 0.0) ? atmoDist : groundDist;

  vec3 lum = raymarchScattering(uTransmittance, uMultiScatter, viewPos, rayDir, sunDir, tMax, 32.0);
  oCol = vec4(lum, 1.0);
}
`;

// Aerial perspective froxel atlas: AP_SLICES tiles laid out horizontally.
const AERIAL_FRAG = /* glsl */ `
${ATMO_COMMON}
${ATMO_RAYMARCH}
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform vec3 uSunDir;
uniform vec3 uCamPos;          // world metres
uniform mat4 uInvViewProj;
uniform float uMaxDistance;    // metres
uniform float uSlices;
uniform float uRes;
in vec2 vUv;
layout(location = 0) out vec4 oCol;

void main(){
  float sliceX = floor(vUv.x * uSlices * uRes) ;
  float slice = floor(sliceX / uRes);
  float localX = (mod(sliceX, uRes) + 0.5) / uRes;
  vec2 ndc = vec2(localX, vUv.y) * 2.0 - 1.0;

  vec4 p0 = uInvViewProj * vec4(ndc, -1.0, 1.0); p0 /= p0.w;
  vec4 p1 = uInvViewProj * vec4(ndc,  1.0, 1.0); p1 /= p1.w;
  vec3 rayDir = normalize(p1.xyz - p0.xyz);

  float dist = uMaxDistance * pow((slice + 1.0) / uSlices, 2.0);

  vec3 viewPos = vec3(0.0, groundRadiusMM + max(uCamPos.y, 0.5) * 1e-6, 0.0);
  float tMaxMM = dist * 1e-6;
  float atmoDist = rayIntersectSphere(viewPos, rayDir, atmosphereRadiusMM);
  tMaxMM = min(tMaxMM, atmoDist);

  vec3 lum = raymarchScattering(uTransmittance, uMultiScatter, viewPos, rayDir, uSunDir, tMaxMM, 12.0);

  // transmittance along the same segment
  vec3 transmittance = vec3(1.0);
  float t = 0.0;
  const float N = 8.0;
  for (float i = 0.0; i < N; i += 1.0) {
    float newT = ((i + 0.5) / N) * tMaxMM;
    float dt = newT - t; t = newT;
    vec3 rs, ext; float ms;
    scatteringValues(viewPos + rayDir * t, rs, ms, ext);
    transmittance *= exp(-dt * ext);
  }
  oCol = vec4(lum, dot(transmittance, vec3(0.3333)));
}
`;

export class Atmosphere {
  constructor(renderer) {
    this.renderer = renderer;
    this.sunDir = new THREE.Vector3(0.3, 0.35, -0.9).normalize();
    this.turbidity = 1.0;
    this.mieG = 0.8;
    this.groundAlbedo = new THREE.Color(0.06, 0.09, 0.12);
    this.sunIntensity = 22.0;
    this.viewHeightMM = 6.360 + 0.0002;

    const half = { type: THREE.HalfFloatType };
    this.transmittanceRT = makeRT(TLUT_W, TLUT_H, { ...half, name: 'tLUT' });
    this.multiScatterRT = makeRT(MSLUT, MSLUT, { ...half, name: 'msLUT' });
    this.skyViewRT = makeRT(SKY_W, SKY_H, {
      ...half, name: 'skyLUT', wrap: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, mipmaps: true,
    });
    this.aerialRT = makeRT(AP_RES * AP_SLICES, AP_RES, { ...half, name: 'apLUT' });

    const common = () => ({
      uAtmoTurbidity: { value: this.turbidity },
      uAtmoMieG: { value: this.mieG },
      uAtmoGroundAlbedo: { value: new THREE.Vector3(0.06, 0.09, 0.12) },
    });

    this.tPass = new FullScreenPass(TRANSMITTANCE_FRAG, common(), { name: 'transmittanceLUT' });
    this.msPass = new FullScreenPass(MULTISCATTER_FRAG, {
      ...common(), uTransmittance: { value: this.transmittanceRT.texture },
    }, { name: 'multiScatterLUT' });
    this.skyPass = new FullScreenPass(SKYVIEW_FRAG, {
      ...common(),
      uTransmittance: { value: this.transmittanceRT.texture },
      uMultiScatter: { value: this.multiScatterRT.texture },
      uSunDir: { value: this.sunDir },
      uViewHeightMM: { value: this.viewHeightMM },
    }, { name: 'skyViewLUT' });
    this.apPass = new FullScreenPass(AERIAL_FRAG, {
      ...common(),
      uTransmittance: { value: this.transmittanceRT.texture },
      uMultiScatter: { value: this.multiScatterRT.texture },
      uSunDir: { value: this.sunDir },
      uCamPos: { value: new THREE.Vector3() },
      uInvViewProj: { value: new THREE.Matrix4() },
      uMaxDistance: { value: 90000 },
      uSlices: { value: AP_SLICES },
      uRes: { value: AP_RES },
    }, { name: 'aerialLUT' });

    this._lutSig = '';
    this.sunColor = new THREE.Color(1, 1, 1);
    this.ambientColor = new THREE.Color(0.1, 0.2, 0.35);
    this._readBuf = new Float32Array(4);
  }

  _syncCommon(pass) {
    pass.uniforms.uAtmoTurbidity.value = this.turbidity;
    pass.uniforms.uAtmoMieG.value = this.mieG;
    pass.uniforms.uAtmoGroundAlbedo.value.set(this.groundAlbedo.r, this.groundAlbedo.g, this.groundAlbedo.b);
  }

  /** Heavy LUTs — only rebuilt when the medium itself changes. */
  buildStaticLUTs(force = false) {
    const a = this.groundAlbedo;
    const sig = `${this.turbidity.toFixed(1)}|${this.mieG.toFixed(3)}|${a.r.toFixed(3)},${a.g.toFixed(3)},${a.b.toFixed(3)}`;
    if (!force && sig === this._lutSig) return;
    this._lutSig = sig;
    this._syncCommon(this.tPass);
    this._syncCommon(this.msPass);
    this.tPass.render(this.renderer, this.transmittanceRT);
    this.msPass.render(this.renderer, this.multiScatterRT);
  }

  /**
   * @param {THREE.Matrix4} [invViewProjNJ] unjittered inverse view-projection;
   *   the AP LUT is looked up through U.uInvViewProjNJ so it must match.
   */
  update(camera, camPos, invViewProjNJ = null) {
    this.buildStaticLUTs();
    this._syncCommon(this.skyPass);
    this.skyPass.uniforms.uSunDir.value.copy(this.sunDir);
    this.skyPass.uniforms.uViewHeightMM.value = 6.360 + Math.max(camPos.y, 0.4) * 1e-6;
    this.skyPass.render(this.renderer, this.skyViewRT);

    this._syncCommon(this.apPass);
    this.apPass.uniforms.uSunDir.value.copy(this.sunDir);
    this.apPass.uniforms.uCamPos.value.copy(camPos);
    if (invViewProjNJ) this.apPass.uniforms.uInvViewProj.value.copy(invViewProjNJ);
    else this.apPass.uniforms.uInvViewProj.value
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    this.apPass.render(this.renderer, this.aerialRT);

    this._updateLightColors();
  }

  /** Cheap CPU-side approximation of sun transmittance for direct lighting. */
  _updateLightColors() {
    const h = Math.max(this.sunDir.y, -0.12);
    const cosZ = Math.max(h, 0.0);
    // Chapman-ish air mass
    const airMass = 1.0 / (cosZ + 0.15 * Math.pow(Math.max(93.885 - Math.acos(Math.min(cosZ, 1)) * 57.29578, 1.0), -1.253));
    const t = this.turbidity;
    const beta = [5.802e-3, 13.558e-3, 33.1e-3];
    const mie = 3.996e-3 * t + 4.4e-3 * t;
    const ozone = [0.65e-3, 1.881e-3, 0.085e-3];
    const rgb = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const tau = (beta[i] * 8.0 + mie * 1.2 + ozone[i] * 15.0) * airMass;
      rgb[i] = Math.exp(-tau);
    }
    const dusk = THREE.MathUtils.smoothstep(this.sunDir.y, -0.10, 0.12);
    this.sunColor.setRGB(rgb[0], rgb[1], rgb[2]).multiplyScalar(dusk);
    const amb = 0.02 + 0.5 * Math.max(this.sunDir.y + 0.12, 0.0);
    this.ambientColor.setRGB(0.28 * amb, 0.42 * amb, 0.65 * amb);
  }

  bind(u) {
    u.uTransmittanceLUT = { value: this.transmittanceRT.texture };
    u.uMultiScatterLUT = { value: this.multiScatterRT.texture };
    u.uSkyViewLUT = { value: this.skyViewRT.texture };
    u.uAerialLUT = { value: this.aerialRT.texture };
    u.uAerialSlices = { value: AP_SLICES };
    u.uAerialRes = { value: AP_RES };
    u.uAerialMaxDist = { value: 90000 };
    u.uSunDir = { value: this.sunDir };
    u.uSunColor = { value: new THREE.Vector3(1, 1, 1) };
    u.uSunIntensity = { value: this.sunIntensity };
    u.uAtmoTurbidity = { value: this.turbidity };
    u.uAtmoMieG = { value: this.mieG };
    u.uAtmoGroundAlbedo = { value: new THREE.Vector3(this.groundAlbedo.r, this.groundAlbedo.g, this.groundAlbedo.b) };
    return u;
  }

  syncUniforms(u) {
    if (u.uSunDir) u.uSunDir.value.copy(this.sunDir);
    if (u.uSunColor) u.uSunColor.value.set(this.sunColor.r, this.sunColor.g, this.sunColor.b);
    if (u.uSunIntensity) u.uSunIntensity.value = this.sunIntensity;
    if (u.uAtmoTurbidity) u.uAtmoTurbidity.value = this.turbidity;
    if (u.uAtmoMieG) u.uAtmoMieG.value = this.mieG;
    if (u.uAtmoGroundAlbedo) u.uAtmoGroundAlbedo.value.set(this.groundAlbedo.r, this.groundAlbedo.g, this.groundAlbedo.b);
  }
}

export const AERIAL_GLSL = /* glsl */ `
uniform sampler2D uAerialLUT;
uniform float uAerialSlices;
uniform float uAerialRes;
uniform float uAerialMaxDist;

vec4 sampleAerial(vec2 screenUv, float distMeters) {
  float s = sqrt(clamp(distMeters / uAerialMaxDist, 0.0, 1.0)) * uAerialSlices - 1.0;
  float s0 = clamp(floor(s), 0.0, uAerialSlices - 1.0);
  float s1 = clamp(s0 + 1.0, 0.0, uAerialSlices - 1.0);
  float f = clamp(s - s0, 0.0, 1.0);
  vec2 uvIn = vec2(clamp(screenUv.x, 0.5 / uAerialRes, 1.0 - 0.5 / uAerialRes), screenUv.y);
  vec4 a = texture(uAerialLUT, vec2((s0 + uvIn.x) / uAerialSlices, uvIn.y));
  vec4 b = texture(uAerialLUT, vec2((s1 + uvIn.x) / uAerialSlices, uvIn.y));
  return mix(a, b, f);
}
`;
