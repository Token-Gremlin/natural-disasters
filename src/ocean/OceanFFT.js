import * as THREE from 'three';
import { FullScreenPass, makeRT, PingPong } from '../gfx/FullScreenPass.js';

/**
 * Multi-cascade spectral ocean (Tessendorf / JONSWAP-TMA + Donelan-Banner spreading)
 * solved entirely on the GPU with a Stockham-free Cooley-Tukey butterfly IFFT.
 *
 * Per cascade we IFFT eight real fields packed as four complex signals
 * (a real field pair (f,g) is transported as f + i*g, valid because both
 * spectra are Hermitian):
 *
 *   buf0.rg = Dx + i*Dz          buf0.ba = Dy  + i*dDy/dx
 *   buf1.rg = dDy/dz + i*dDx/dx  buf1.ba = dDz/dz + i*dDx/dz
 *
 * Outputs per cascade:
 *   displacement : RGBA16F  xyz = displacement (m), w = folding (Jacobian)
 *   derivatives  : RGBA16F  xy  = dDy/dxz, zw = lambda*dDx/dx, lambda*dDz/dz
 *   turbulence   : RGBA16F  r   = foam coverage, g = sub-surface bubbles,
 *                           b   = crest energy, a = short-lived spray seed
 */

const GRAVITY = 9.80665;

// -------------------------------------------------------------- shared GLSL
const GLSL_COMPLEX = /* glsl */ `
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cconj(vec2 a){ return vec2(a.x, -a.y); }
const float PI = 3.14159265358979323846;
`;

// ------------------------------------------------------------ noise texture
function gaussianNoiseTexture(size, seed = 1337) {
  // xorshift32 for reproducible spectra across reloads
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 8) / 16777216;
  };
  const n = size * size * 4;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    let u1 = Math.max(rnd(), 1e-7);
    const u2 = rnd();
    const r = Math.sqrt(-2.0 * Math.log(u1));
    data[i] = r * Math.cos(2 * Math.PI * u2);
    data[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// -------------------------------------------------------- butterfly texture
function butterflyTexture(N) {
  const stages = Math.log2(N) | 0;
  const data = new Float32Array(stages * N * 4);
  const bits = stages;
  const reverse = (i) => {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    return r;
  };
  for (let stage = 0; stage < stages; stage++) {
    for (let y = 0; y < N; y++) {
      const span = 1 << stage;
      const k = ((y * (N >> (stage + 1))) % N);
      // inverse transform => positive exponent twiddle
      const twR = Math.cos(2 * Math.PI * k / N);
      const twI = Math.sin(2 * Math.PI * k / N);
      const topWing = (y % (1 << (stage + 1))) < span;
      let top, bot;
      if (stage === 0) {
        if (topWing) { top = reverse(y); bot = reverse(y + 1); }
        else { top = reverse(y - 1); bot = reverse(y); }
      } else {
        if (topWing) { top = y; bot = y + span; }
        else { top = y - span; bot = y; }
      }
      const o = (stage + y * stages) * 4; // texture is (stages x N) => x=stage, y=index
      data[o] = twR; data[o + 1] = twI; data[o + 2] = top; data[o + 3] = bot;
    }
  }
  const tex = new THREE.DataTexture(data, stages, N, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ shaders
const SPECTRUM_FRAG = /* glsl */ `
${GLSL_COMPLEX}
uniform sampler2D uNoise;
uniform float uN;
uniform float uLengthScale;
uniform float uCutoffLow;
uniform float uCutoffHigh;
uniform float uDepth;
// per-spectrum: (scale, angle, spreadBlend, swell)
uniform vec4 uS0a;  // scale, angle, spreadBlend, swell
uniform vec4 uS0b;  // alpha, peakOmega, gamma, shortWavesFade
uniform vec4 uS1a;
uniform vec4 uS1b;
in vec2 vUv;
layout(location = 0) out vec4 oH0;

float freq(float k){ return sqrt(9.80665 * k * tanh(min(k * uDepth, 20.0))); }
float freqDeriv(float k){
  float th = tanh(min(k * uDepth, 20.0));
  float ch = cosh(k * uDepth);
  return 9.80665 * (uDepth * k / (ch*ch) + th) / max(2.0 * sqrt(9.80665 * k * th), 1e-9);
}
float normFactor(float s){
  float s2=s*s, s3=s2*s, s4=s3*s;
  if (s < 5.0) return -0.000564*s4 + 0.00776*s3 - 0.044*s2 + 0.192*s + 0.163;
  return -4.80e-8*s4 + 1.07e-5*s3 - 9.53e-4*s2 + 5.90e-2*s + 3.93e-1;
}
float cos2s(float theta, float s){ return normFactor(s) * pow(max(abs(cos(0.5*theta)), 1e-5), 2.0*s); }
float spreadPower(float omega, float peak){
  return omega > peak ? 9.77 * pow(max(omega/peak,1e-5), -2.5)
                      : 6.97 * pow(max(omega/peak,1e-5),  5.0);
}
float tmaCorrection(float omega){
  float oh = omega * sqrt(uDepth / 9.80665);
  if (oh <= 1.0) return 0.5 * oh * oh;
  if (oh <  2.0) return 1.0 - 0.5 * (2.0 - oh) * (2.0 - oh);
  return 1.0;
}
float jonswap(float omega, vec4 sb){
  float alpha = sb.x, peak = sb.y, gamma = sb.z;
  float sigma = omega <= peak ? 0.07 : 0.09;
  float r = exp(-(omega-peak)*(omega-peak) / (2.0*sigma*sigma*peak*peak));
  float invO = 1.0 / max(omega, 1e-5);
  float invO5 = invO*invO*invO*invO*invO;
  return tmaCorrection(omega) * alpha * 9.80665 * 9.80665 * invO5
       * exp(-1.25 * pow(peak * invO, 4.0)) * pow(abs(gamma), r);
}
float directional(float theta, float omega, vec4 sa, vec4 sb){
  float s = spreadPower(omega, sb.y) + 16.0 * tanh(min(omega / max(sb.y,1e-4), 20.0)) * sa.w * sa.w;
  float d = mix(2.0 / PI * cos(theta) * cos(theta), cos2s(theta - sa.y, s), sa.z);
  return d;
}
float shortWaveFade(float k, float fade){ return exp(-fade*fade*k*k); }

float spectrumAt(float kLen, float kAngle, vec4 sa, vec4 sb){
  if (sa.x <= 1e-6) return 0.0;
  float omega = freq(kLen);
  float dOdk  = freqDeriv(kLen);
  return sa.x * jonswap(omega, sb) * directional(kAngle, omega, sa, sb)
       * shortWaveFade(kLen, sb.w) * abs(dOdk) / max(kLen, 1e-6);
}

void main(){
  float N = uN;
  vec2 xy = floor(vUv * N);
  float dk = 2.0 * PI / uLengthScale;
  vec2 k = (xy - N * 0.5) * dk;
  float kLen = length(k);

  vec2 h0 = vec2(0.0);
  if (kLen >= uCutoffLow && kLen <= uCutoffHigh && kLen > 1e-6) {
    float kAngle = atan(k.y, k.x);
    float S = spectrumAt(kLen, kAngle, uS0a, uS0b) + spectrumAt(kLen, kAngle, uS1a, uS1b);
    vec4 g = texture(uNoise, (xy + 0.5) / N);
    h0 = g.xy * sqrt(2.0 * max(S, 0.0) * dk * dk);
  }
  oH0 = vec4(h0, 0.0, 0.0);
}
`;

const CONJUGATE_FRAG = /* glsl */ `
uniform sampler2D uH0;
uniform float uN;
in vec2 vUv;
layout(location = 0) out vec4 oH0;
void main(){
  ivec2 p = ivec2(floor(vUv * uN));
  int N = int(uN);
  ivec2 m = ivec2((N - p.x) % N, (N - p.y) % N);
  vec2 h0k  = texelFetch(uH0, p, 0).xy;
  vec2 h0mk = texelFetch(uH0, m, 0).xy;
  oH0 = vec4(h0k, h0mk.x, -h0mk.y);
}
`;

const TIMESPECTRUM_FRAG = /* glsl */ `
${GLSL_COMPLEX}
uniform sampler2D uH0;
uniform float uN;
uniform float uLengthScale;
uniform float uTime;
uniform float uDepth;
in vec2 vUv;
layout(location = 0) out vec4 oBuf0;
layout(location = 1) out vec4 oBuf1;

void main(){
  ivec2 p = ivec2(floor(vUv * uN));
  vec4 h0 = texelFetch(uH0, p, 0);
  float dk = 2.0 * PI / uLengthScale;
  vec2 k = (vec2(p) - uN * 0.5) * dk;
  float kLen = max(length(k), 1e-5);
  vec2 kn = k / kLen;

  float omega = sqrt(9.80665 * kLen * tanh(min(kLen * uDepth, 20.0)));
  // quantise to the fundamental frequency so the field loops seamlessly in time
  float phase = omega * uTime;
  vec2 e  = vec2(cos(phase), sin(phase));
  vec2 ec = vec2(e.x, -e.y);

  vec2 h  = cmul(h0.xy, e) + cmul(h0.zw, ec);
  vec2 ih = vec2(-h.y, h.x);

  vec2 Dx    = ih * kn.x;
  vec2 Dz    = ih * kn.y;
  vec2 Dy    = h;
  vec2 DyDx  = ih * k.x;
  vec2 DyDz  = ih * k.y;
  vec2 DxDx  = -h * k.x * kn.x;
  vec2 DzDz  = -h * k.y * kn.y;
  vec2 DxDz  = -h * k.y * kn.x;

  // pack pairs of real fields as f + i*g
  oBuf0 = vec4(Dx.x - Dz.y,    Dx.y + Dz.x,    Dy.x   - DyDx.y, Dy.y   + DyDx.x);
  oBuf1 = vec4(DyDz.x - DxDx.y, DyDz.y + DxDx.x, DzDz.x - DxDz.y, DzDz.y + DxDz.x);
}
`;

const BUTTERFLY_FRAG = /* glsl */ `
${GLSL_COMPLEX}
uniform sampler2D uButterfly;
uniform sampler2D uSrc0;
uniform sampler2D uSrc1;
uniform int uStage;
uniform int uVertical;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;

void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int idx = (uVertical == 1) ? p.y : p.x;
  vec4 bf = texelFetch(uButterfly, ivec2(uStage, idx), 0);
  ivec2 a, b;
  if (uVertical == 1) { a = ivec2(p.x, int(bf.z)); b = ivec2(p.x, int(bf.w)); }
  else                { a = ivec2(int(bf.z), p.y); b = ivec2(int(bf.w), p.y); }
  vec2 w = bf.xy;

  vec4 pa = texelFetch(uSrc0, a, 0);
  vec4 pb = texelFetch(uSrc0, b, 0);
  o0 = vec4(pa.rg + cmul(w, pb.rg), pa.ba + cmul(w, pb.ba));

  vec4 qa = texelFetch(uSrc1, a, 0);
  vec4 qb = texelFetch(uSrc1, b, 0);
  o1 = vec4(qa.rg + cmul(w, qb.rg), qa.ba + cmul(w, qb.ba));
}
`;

const ASSEMBLE_FRAG = /* glsl */ `
uniform sampler2D uBuf0;
uniform sampler2D uBuf1;
uniform sampler2D uPrevTurb;
uniform float uLambda;
uniform float uFoamBias;
uniform float uSteepBias;
uniform float uCrestK;
uniform vec2  uWindDir;
uniform float uFoamMul;
uniform float uFoamDecay;
uniform float uBubbleDecay;
uniform float uDt;
uniform float uN;
uniform float uLengthScale;
in vec2 vUv;
layout(location = 0) out vec4 oDisp;
layout(location = 1) out vec4 oDeriv;
layout(location = 2) out vec4 oTurb;

void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float perm = ((p.x + p.y) % 2 == 0) ? 1.0 : -1.0;

  vec4 b0 = texelFetch(uBuf0, p, 0) * perm;
  vec4 b1 = texelFetch(uBuf1, p, 0) * perm;

  float Dx   = b0.x, Dz   = b0.y, Dy   = b0.z, DyDx = b0.w;
  float DyDz = b1.x, DxDx = b1.y, DzDz = b1.z, DxDz = b1.w;

  float lx = uLambda * DxDx;
  float lz = uLambda * DzDz;
  float lxz = uLambda * DxDz;
  float jacobian = (1.0 + lx) * (1.0 + lz) - lxz * lxz;

  oDisp  = vec4(uLambda * Dx, Dy, uLambda * Dz, jacobian);
  oDeriv = vec4(DyDx, DyDz, lx, lz);

  // ---- turbulence / foam accumulation (world-tiled, so it wraps naturally)
  //
  // Two independent breaking criteria, because neither alone covers the sea.
  //
  // Folding (Jacobian near zero) catches the plunging breaker whose face has
  // gone vertical, but it only fires when the horizontal displacement is pushed
  // past the point of self-intersection — which a physically-scaled chop never
  // reaches, so on its own it leaves a gale looking glassy.
  //
  // Steepness is what actually limits an ocean wave: past roughly H/L = 1/7 the
  // crest can no longer support itself and spills. That threshold lives in the
  // surface slope, which the FFT gives us directly, and it fires on the whole
  // spilling-breaker population that folding misses.
  vec4 prev = texture(uPrevTurb, vUv);
  float fold = smoothstep(uFoamBias, uFoamBias - 0.30, jacobian);

  vec2 grad = vec2(DyDx, DyDz);
  float slope = length(grad);
  // Waves spill down their leeward face, so weight the injection toward crests
  // whose front is turned away from the wind rather than ringing the whole crest.
  float lee = 0.55 + 0.45 * clamp(dot(grad / max(slope, 1e-4), uWindDir), -1.0, 1.0);
  // Steepness alone also fires on the steep flank halfway down a big wave, which
  // paints broad blobs. Air is only entrained at the top, so require the water
  // to be high in its own band as well. uCrestK turns the cascade's elevation
  // into the same units as its slope, making the gate scale-free.
  float above = smoothstep(0.10, 0.75, Dy * uCrestK);
  float steep = smoothstep(uSteepBias, uSteepBias + 0.30, slope) * lee * above;

  fold = max(fold, steep);

  // Entrainment is a *rate*, not a level. Snapping the accumulator to 1 the
  // instant a texel folds means every texel the wave field sweeps over pins at
  // full white and the decay never gets ahead of it, which turns a storm sea
  // into a snowfield. Integrating a rate instead gives an equilibrium coverage
  // of rate*dutyCycle/decay, so only water that breaks repeatedly goes white.
  float foam = prev.r * exp(-uDt * uFoamDecay) + fold * uFoamMul * uDt;
  foam = max(foam - uDt * 0.015, 0.0);
  float bub  = prev.g * exp(-uDt * uBubbleDecay) + fold * uFoamMul * uDt * 0.55;
  // crest energy is the instantaneous folding, used for spray emission
  float crest = fold;
  float spray = max(prev.a * exp(-uDt * 6.0), smoothstep(0.45, 0.95, fold));

  oTurb = vec4(clamp(foam, 0.0, 1.0), clamp(bub, 0.0, 1.0), crest, spray);
}
`;

/** Per-cascade air-entrainment weight: swell, wind sea, capillary. */
const FOAM_SCALE = [0.55, 1.0, 0.22];

/**
 * Per-cascade horizontal-displacement weight. Chop sharpens crests by pulling
 * mass toward them, but it is a first-order correction: once the horizontal
 * displacement approaches the vertical the surface folds through itself and
 * the sea reads as jagged rock rather than water. Long swell carries the most
 * amplitude and so needs the tightest rein; the short cascades can be pushed
 * harder because their displacement is small in absolute terms.
 */
const CHOP_SCALE = [0.55, 0.9, 1.1];

// ------------------------------------------------------------- the cascade
class Cascade {
  constructor(renderer, N, lengthScale, cutLow, cutHigh, noiseTex, butterflyTex) {
    this.N = N;
    this.lengthScale = lengthScale;
    this.cutLow = cutLow;
    this.cutHigh = cutHigh;

    const fOpts = { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.h0 = makeRT(N, N, { ...fOpts, name: 'h0' });
    this.h0k = makeRT(N, N, { ...fOpts, name: 'h0k' });
    this.pp0 = new PingPong(N, N, { ...fOpts, name: 'fft0' });
    this.pp1 = new PingPong(N, N, { ...fOpts, name: 'fft1' });
    // MRT pair used by the butterfly (two targets bound at once)
    this.mrtA = makeRT(N, N, { ...fOpts, name: 'mrtA', count: 2 });
    this.mrtB = makeRT(N, N, { ...fOpts, name: 'mrtB', count: 2 });

    // Anisotropy is not a nicety here, it is the whole reason the sea keeps its
    // texture past a hundred metres. A trilinear sample picks its mip from the
    // longest axis of the footprint, and at the grazing angles you view an ocean
    // from that axis is enormous: the shader ends up reading a 4x4 mip of the
    // wave slopes and the surface turns into flat paint from mid-distance to the
    // horizon. Sampling along the minor axis instead keeps every ripple the
    // spectrum produced, all the way out.
    const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    const wrapOpts = {
      type: THREE.HalfFloatType, wrap: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      mipmaps: true, anisotropy: aniso,
    };
    this.out = makeRT(N, N, { ...wrapOpts, name: 'oceanOut', count: 3 });
    this.turbPrev = makeRT(N, N, {
      type: THREE.HalfFloatType, wrap: THREE.RepeatWrapping,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, name: 'turbPrev',
    });

    this.spectrumPass = new FullScreenPass(SPECTRUM_FRAG, {
      uNoise: { value: noiseTex },
      uN: { value: N },
      uLengthScale: { value: lengthScale },
      uCutoffLow: { value: cutLow },
      uCutoffHigh: { value: cutHigh },
      uDepth: { value: 500 },
      uS0a: { value: new THREE.Vector4() }, uS0b: { value: new THREE.Vector4() },
      uS1a: { value: new THREE.Vector4() }, uS1b: { value: new THREE.Vector4() },
    }, { name: 'spectrum' });

    this.conjPass = new FullScreenPass(CONJUGATE_FRAG, {
      uH0: { value: this.h0.texture }, uN: { value: N },
    }, { name: 'conjugate' });

    this.timePass = new FullScreenPass(TIMESPECTRUM_FRAG, {
      uH0: { value: this.h0k.texture },
      uN: { value: N },
      uLengthScale: { value: lengthScale },
      uTime: { value: 0 },
      uDepth: { value: 500 },
    }, { name: 'timeSpectrum' });

    this.butterflyPass = new FullScreenPass(BUTTERFLY_FRAG, {
      uButterfly: { value: butterflyTex },
      uSrc0: { value: null }, uSrc1: { value: null },
      uStage: { value: 0 }, uVertical: { value: 0 },
    }, { name: 'butterfly' });

    this.assemblePass = new FullScreenPass(ASSEMBLE_FRAG, {
      uBuf0: { value: null }, uBuf1: { value: null },
      uPrevTurb: { value: this.turbPrev.texture },
      uLambda: { value: 1.0 },
      uFoamBias: { value: 0.85 },
      uSteepBias: { value: 0.5 },
      // Wavenumber of this cascade's band centre, used to compare elevation
      // against slope without knowing the sea state.
      uCrestK: { value: 16.0 * Math.PI / lengthScale },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uFoamMul: { value: 1.2 },
      uFoamDecay: { value: 0.35 },
      uBubbleDecay: { value: 0.14 },
      uDt: { value: 0.016 },
      uN: { value: N },
      uLengthScale: { value: lengthScale },
    }, { name: 'assemble' });

    this.copyTurb = new FullScreenPass(/* glsl */`
      uniform sampler2D uSrc; in vec2 vUv; layout(location=0) out vec4 o;
      void main(){ o = texture(uSrc, vUv); }`,
      { uSrc: { value: this.out.textures[2] } }, { name: 'copyTurb' });

    this.stages = Math.log2(N) | 0;
  }

  get displacement() { return this.out.textures[0]; }
  get derivatives() { return this.out.textures[1]; }
  get turbulence() { return this.out.textures[2]; }

  updateSpectrum(renderer, s0a, s0b, s1a, s1b, depth) {
    const u = this.spectrumPass.uniforms;
    u.uS0a.value.copy(s0a); u.uS0b.value.copy(s0b);
    u.uS1a.value.copy(s1a); u.uS1b.value.copy(s1b);
    u.uDepth.value = depth;
    this.timePass.uniforms.uDepth.value = depth;
    this.spectrumPass.render(renderer, this.h0);
    this.conjPass.render(renderer, this.h0k);
  }

  step(renderer, time, dt, lambda, foam, foamScale = 1) {
    this.timePass.set('uTime', time).render(renderer, this.mrtA);

    let src = this.mrtA, dst = this.mrtB;
    const bp = this.butterflyPass;
    for (let dir = 0; dir < 2; dir++) {
      bp.set('uVertical', dir);
      for (let s = 0; s < this.stages; s++) {
        bp.set('uStage', s);
        bp.set('uSrc0', src.textures[0]);
        bp.set('uSrc1', src.textures[1]);
        bp.render(renderer, dst);
        const t = src; src = dst; dst = t;
      }
    }

    const ap = this.assemblePass;
    ap.set('uBuf0', src.textures[0]);
    ap.set('uBuf1', src.textures[1]);
    ap.set('uLambda', lambda);
    ap.set('uFoamBias', foam.bias);
    ap.set('uSteepBias', foam.steepBias / Math.max(foamScale, 0.35));
    ap.uniforms.uWindDir.value.copy(foam.windDir);
    ap.set('uFoamMul', foam.mul * foamScale);
    ap.set('uFoamDecay', foam.decay / Math.max(foamScale, 0.15));
    ap.set('uBubbleDecay', foam.bubbleDecay);
    ap.set('uDt', dt);
    ap.render(renderer, this.out);
    this.copyTurb.render(renderer, this.turbPrev);
  }

  dispose() {
    [this.h0, this.h0k, this.mrtA, this.mrtB, this.out, this.turbPrev].forEach(t => t.dispose());
    this.pp0.dispose(); this.pp1.dispose();
    [this.spectrumPass, this.conjPass, this.timePass, this.butterflyPass, this.assemblePass, this.copyTurb]
      .forEach(p => p.dispose());
  }
}

// ----------------------------------------------------------------- manager
export class OceanFFT {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.N = opts.size || 256;
    // Deliberately non-harmonic tile sizes so the three cascades never beat
    // into a visible repeating pattern.
    //
    // The longest tile has to comfortably contain the spectral peak, not merely
    // reach it. A fully developed sea at 30 m/s peaks near 900 m, so a 1 km tile
    // resolves the peak with barely one mode and the "sea" collapses into a few
    // coherent ridges marching in lockstep. Four kilometres puts ~5 modes across
    // the peak and dozens across the energy-containing band, which is what makes
    // the surface read as chaotic water instead of corrugated terrain.
    this.lengthScales = opts.lengthScales || [4099.0, 389.0, 41.3];
    this.depth = 900.0;
    this.time = 0;
    this.timeScale = 1.0;

    this.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    this.noise = gaussianNoiseTexture(this.N, 0xC0FFEE);
    this.butterfly = butterflyTexture(this.N);
    this._windDir = new THREE.Vector2(1, 0);

    // Hand a band to the next cascade down while its shortest wave still has
    // ~6 texels across it, otherwise bilinear filtering of the displacement map
    // facets the crests.
    const b1 = 2.0 * Math.PI / this.lengthScales[1] * 4.0;
    const b2 = 2.0 * Math.PI / this.lengthScales[2] * 4.0;
    const bounds = [[1e-4, b1], [b1, b2], [b2, 9999.0]];

    this.cascades = this.lengthScales.map((L, i) =>
      new Cascade(renderer, this.N, L, bounds[i][0], bounds[i][1], this.noise, this.butterfly));

    // wave state (driven by WeatherSystem)
    this.params = {
      windSpeed: 9.0,
      windDir: 0.6,
      fetch: 220000,
      swellHs: 1.4,        // significant height of the distant swell, metres
      swellPeriod: 11.0,   // peak period, seconds
      swellDir: 0.9,
      swellGamma: 6.0,     // narrow-banded
      swellCutoff: 14.0,   // kills the short-wave tail so it stays a pure swell
      spread: 0.72,
      choppiness: 1.35,
      amplitude: 1.0,
      shortWaveFade: 0.0065,
      peakEnhancement: 3.3,
      foamBias: 0.5,
      foamMul: 1.35,
      foamDecay: 0.35,
      bubbleDecay: 0.12,
    };
    this._s = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
    this._dirty = true;
    this._sig = '';
  }

  markDirty() { this._dirty = true; }

  /** Significant wave height, integrated from the actual spectrum. */
  get significantWaveHeight() { return this.hs || 0; }

  /**
   * JONSWAP fetch relations blow up past the fully-developed limit, so the
   * effective fetch is clamped to the Pierson-Moskowitz saturation point.
   */
  static _jonswapParams(U, fetch) {
    const g = GRAVITY;
    const u = Math.max(U, 0.5);
    const fullyDeveloped = 2.2e4 * u * u / g;
    const F = Math.max(Math.min(fetch, fullyDeveloped), 400);
    return {
      alpha: 0.076 * Math.pow(u * u / (F * g), 0.22),
      peakOmega: Math.max(22.0 * Math.pow(g * g / (u * F), 1 / 3), 0.30),
    };
  }

  /** Numerically integrate the 1-D spectrum so the HUD can report a true Hs. */
  static _m0(alpha, peakOmega, gamma) {
    const g = GRAVITY;
    let m0 = 0;
    const N = 128, wMin = 0.08, wMax = 14.0;
    const lr = Math.log(wMax / wMin);
    for (let i = 0; i < N; i++) {
      const w = wMin * Math.exp(lr * (i + 0.5) / N);
      const dw = w * lr / N;
      const sigma = w <= peakOmega ? 0.07 : 0.09;
      const r = Math.exp(-((w - peakOmega) ** 2) / (2 * sigma * sigma * peakOmega * peakOmega));
      const S = alpha * g * g / Math.pow(w, 5)
        * Math.exp(-1.25 * Math.pow(peakOmega / w, 4)) * Math.pow(gamma, r);
      m0 += S * dw;
    }
    return m0;
  }

  _buildSpectra() {
    const p = this.params;
    const wind = OceanFFT._jonswapParams(p.windSpeed, p.fetch);

    // Swell is specified directly in metres: DNV-RP-C205 alpha from Hs and Tp
    const Tp = Math.max(p.swellPeriod, 3.0);
    const gamma = Math.max(p.swellGamma, 1.0);
    const Hs = Math.max(p.swellHs, 0.0);
    const alphaS = 5.061 * (Hs * Hs / (Tp * Tp * Tp * Tp)) * (1.0 - 0.287 * Math.log(gamma));
    const peakOmegaS = 2 * Math.PI / Tp;

    const m0w = OceanFFT._m0(wind.alpha, wind.peakOmega, p.peakEnhancement) * p.amplitude;
    const m0s = OceanFFT._m0(alphaS, peakOmegaS, gamma) * p.amplitude;
    this.hs = 4.0 * Math.sqrt(Math.max(m0w + m0s, 1e-9));
    this.windHs = 4.0 * Math.sqrt(Math.max(m0w, 1e-9));
    this.swellHsActual = 4.0 * Math.sqrt(Math.max(m0s, 1e-9));
    this.peakPeriod = 2 * Math.PI / wind.peakOmega;

    // local wind sea
    this._s[0].set(p.amplitude, p.windDir, p.spread, 0.0);
    this._s[1].set(wind.alpha, wind.peakOmega, p.peakEnhancement, p.shortWaveFade);

    // distant swell (narrow band, narrow directional spread)
    this._s[2].set(Hs > 1e-3 ? p.amplitude : 0.0, p.swellDir, 1.0, 1.0);
    this._s[3].set(alphaS, peakOmegaS, gamma, p.swellCutoff);
  }

  update(dt) {
    const r = this.renderer;
    this.time += dt * this.timeScale;

    const p = this.params;
    const sig = `${p.windSpeed.toFixed(2)}|${p.windDir.toFixed(3)}|${p.swellHs.toFixed(3)}|${p.swellDir.toFixed(3)}|${p.swellPeriod.toFixed(2)}|${p.swellGamma.toFixed(2)}|${p.swellCutoff.toFixed(2)}|${p.spread.toFixed(3)}|${p.amplitude.toFixed(3)}|${p.shortWaveFade.toFixed(4)}|${p.peakEnhancement.toFixed(2)}|${p.fetch.toFixed(0)}`;
    if (this._dirty || sig !== this._sig) {
      this._sig = sig;
      this._dirty = false;
      this._buildSpectra();
      for (const c of this.cascades) {
        c.updateSpectrum(r, this._s[0], this._s[1], this._s[2], this._s[3], this.depth);
      }
    }

    const foam = {
      bias: p.foamBias, mul: p.foamMul, decay: p.foamDecay,
      bubbleDecay: p.bubbleDecay, steepBias: p.steepBias ?? 0.5,
      windDir: this._windDir.set(Math.cos(p.windDir ?? 0), Math.sin(p.windDir ?? 0)),
    };
    // Air entrainment is a property of the breaking wave, not of every ripple:
    // the wind-sea cascade produces the whitecaps, the swell folds only rarely
    // and the capillary cascade contributes a fast-fading sheen at most.
    for (let i = 0; i < this.cascades.length; i++) {
      this.cascades[i].step(r, this.time, dt, p.choppiness * (CHOP_SCALE[i] ?? 1),
                            foam, FOAM_SCALE[i] ?? 1);
    }
  }

  /** Uniform block for materials that sample the ocean. */
  bind(uniforms) {
    uniforms.uOceanDisp0 = { value: this.cascades[0].displacement };
    uniforms.uOceanDisp1 = { value: this.cascades[1].displacement };
    uniforms.uOceanDisp2 = { value: this.cascades[2].displacement };
    uniforms.uOceanDeriv0 = { value: this.cascades[0].derivatives };
    uniforms.uOceanDeriv1 = { value: this.cascades[1].derivatives };
    uniforms.uOceanDeriv2 = { value: this.cascades[2].derivatives };
    uniforms.uOceanTurb0 = { value: this.cascades[0].turbulence };
    uniforms.uOceanTurb1 = { value: this.cascades[1].turbulence };
    uniforms.uOceanTurb2 = { value: this.cascades[2].turbulence };
    uniforms.uOceanScales = { value: new THREE.Vector3(...this.lengthScales) };
    uniforms.uOceanTexels = { value: this.N };
    uniforms.uOceanAniso = { value: this.anisotropy };
    return uniforms;
  }

  dispose() {
    this.cascades.forEach(c => c.dispose());
    this.noise.dispose();
    this.butterfly.dispose();
  }
}
