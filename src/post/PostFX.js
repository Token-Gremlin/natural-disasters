import * as THREE from 'three';
import { FullScreenPass, makeRT, PingPong } from '../gfx/FullScreenPass.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';
import { NOISE_GLSL } from '../gfx/NoiseGLSL.js';
import { U } from '../core/SharedUniforms.js';

/* ============================================================ TAA resolve */
const TAA_FRAG = /* glsl */ `
${NOISE_GLSL}
${SHADING_GLSL}
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uVelocity;
uniform vec2 uInvResolution;
uniform vec2 uJitter;
uniform float uBlend;
uniform float uReset;
in vec2 vUv;
layout(location = 0) out vec4 oColor;

vec3 rgbToYcocg(vec3 c){ return vec3(0.25*c.r+0.5*c.g+0.25*c.b, 0.5*c.r-0.5*c.b, -0.25*c.r+0.5*c.g-0.25*c.b); }
vec3 ycocgToRgb(vec3 c){ float t = c.x - c.z; return vec3(t + c.y, c.x + c.z, t - c.y); }

vec3 sampleCatmullRom(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));
  vec2 texPos0 = (texPos1 - 1.0) / texSize;
  vec2 texPos3 = (texPos1 + 2.0) / texSize;
  vec2 texPos12 = (texPos1 + offset12) / texSize;
  vec3 result = vec3(0.0);
  result += texture(tex, vec2(texPos0.x, texPos0.y)).rgb * w0.x * w0.y;
  result += texture(tex, vec2(texPos12.x, texPos0.y)).rgb * w12.x * w0.y;
  result += texture(tex, vec2(texPos3.x, texPos0.y)).rgb * w3.x * w0.y;
  result += texture(tex, vec2(texPos0.x, texPos12.y)).rgb * w0.x * w12.y;
  result += texture(tex, vec2(texPos12.x, texPos12.y)).rgb * w12.x * w12.y;
  result += texture(tex, vec2(texPos3.x, texPos12.y)).rgb * w3.x * w12.y;
  result += texture(tex, vec2(texPos0.x, texPos3.y)).rgb * w0.x * w3.y;
  result += texture(tex, vec2(texPos12.x, texPos3.y)).rgb * w12.x * w3.y;
  result += texture(tex, vec2(texPos3.x, texPos3.y)).rgb * w3.x * w3.y;
  return max(result, vec3(0.0));
}

void main(){
  vec2 texSize = 1.0 / uInvResolution;

  // velocity dilation: pick the closest fragment in a 3x3 neighbourhood
  vec2 bestVel = texture(uVelocity, vUv).xy;
  float bestDepth = texture(uVelocity, vUv).z;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    if (x == 0 && y == 0) continue;
    vec4 s = texture(uVelocity, vUv + vec2(float(x), float(y)) * uInvResolution);
    if (s.z < bestDepth) { bestDepth = s.z; bestVel = s.xy; }
  }

  vec3 cur = texture(uCurrent, vUv).rgb;

  vec2 histUv = vUv - bestVel;
  if (uReset > 0.5 || histUv.x < 0.0 || histUv.x > 1.0 || histUv.y < 0.0 || histUv.y > 1.0) {
    oColor = vec4(cur, 1.0);
    return;
  }

  // neighbourhood statistics in YCoCg for variance clipping
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 minC = vec3(1e9), maxC = vec3(-1e9);
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 c = rgbToYcocg(texture(uCurrent, vUv + vec2(float(x), float(y)) * uInvResolution).rgb);
    m1 += c; m2 += c * c;
    minC = min(minC, c); maxC = max(maxC, c);
  }
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3(0.0)));
  float gamma = 1.35;
  vec3 lo = max(mu - gamma * sigma, minC);
  vec3 hi = min(mu + gamma * sigma, maxC);

  vec3 hist = sampleCatmullRom(uHistory, histUv, texSize);
  vec3 histY = rgbToYcocg(hist);
  histY = clamp(histY, lo, hi);
  hist = ycocgToRgb(histY);

  // luminance weighting kills the "flicker then smear" of HDR fireflies
  float lumCur = luminance(cur), lumHist = luminance(hist);
  float wCur = 1.0 / (1.0 + lumCur);
  float wHist = 1.0 / (1.0 + lumHist);
  float blend = uBlend;
  float velLen = length(bestVel * texSize);
  blend = mix(blend, 0.72, clamp(velLen / 22.0, 0.0, 1.0));

  vec3 result = (cur * wCur * blend + hist * wHist * (1.0 - blend)) /
                max(wCur * blend + wHist * (1.0 - blend), 1e-5);
  oColor = vec4(max(result, vec3(0.0)), 1.0);
}
`;

/* ================================================================ exposure */
const LUM_DOWN_FRAG = /* glsl */ `
${SHADING_GLSL}
uniform sampler2D uSrc;
uniform vec2 uInvSrc;
uniform float uFirst;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
// Each level is a 4x reduction, so a 4x4 box centred on the destination texel
// covers exactly the source block it stands for: every texel is read once.
void main(){
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++)
  for (int x = 0; x < 4; x++) {
    vec2 uv = vUv + (vec2(float(x), float(y)) - 1.5) * uInvSrc;
    vec4 s = texture(uSrc, uv);
    if (uFirst > 0.5) acc += vec4(log(clamp(luminance(s.rgb), 3e-4, 6.0e4)));
    else acc += s;
  }
  oColor = acc * (1.0 / 16.0);
}
`;

const EXPOSURE_FRAG = /* glsl */ `
uniform sampler2D uLum;
uniform sampler2D uPrev;
uniform float uDt;
uniform float uSpeedUp;
uniform float uSpeedDown;
uniform float uCompensation;
uniform float uMinEV;
uniform float uMaxEV;
uniform float uReset;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
void main(){
  float logLum = texture(uLum, vec2(0.5)).r;
  float avg = exp(logLum);
  // EV100 from average luminance (ISO 100, K = 12.5)
  float ev = log2(max(avg, 1e-4) * 100.0 / 12.5);
  ev = clamp(ev + uCompensation, uMinEV, uMaxEV);
  float target = 1.0 / (1.2 * exp2(ev));
  float prev = texture(uPrev, vec2(0.5)).r;
  if (uReset > 0.5 || prev <= 0.0) { oColor = vec4(target); return; }
  float speed = (target < prev) ? uSpeedDown : uSpeedUp;
  float v = prev + (target - prev) * (1.0 - exp(-uDt * speed));
  oColor = vec4(v);
}
`;

/* ==================================================================== bloom */
const BLOOM_DOWN_FRAG = /* glsl */ `
${SHADING_GLSL}
uniform sampler2D uSrc;
uniform sampler2D uExposure;
uniform vec2 uInvSrc;
uniform float uFirstMip;
uniform float uThreshold;
uniform float uSoftKnee;
uniform float uExposureBias;
in vec2 vUv;
layout(location = 0) out vec4 oColor;

vec3 fetch(vec2 uv){ return texture(uSrc, uv).rgb; }
float karisWeight(vec3 c){ return 1.0 / (1.0 + luminance(c)); }

void main(){
  vec2 t = uInvSrc;
  vec3 a = fetch(vUv + vec2(-2.0, 2.0) * t);
  vec3 b = fetch(vUv + vec2( 0.0, 2.0) * t);
  vec3 c = fetch(vUv + vec2( 2.0, 2.0) * t);
  vec3 d = fetch(vUv + vec2(-2.0, 0.0) * t);
  vec3 e = fetch(vUv);
  vec3 f = fetch(vUv + vec2( 2.0, 0.0) * t);
  vec3 g = fetch(vUv + vec2(-2.0,-2.0) * t);
  vec3 h = fetch(vUv + vec2( 0.0,-2.0) * t);
  vec3 i = fetch(vUv + vec2( 2.0,-2.0) * t);
  vec3 j = fetch(vUv + vec2(-1.0, 1.0) * t);
  vec3 k = fetch(vUv + vec2( 1.0, 1.0) * t);
  vec3 l = fetch(vUv + vec2(-1.0,-1.0) * t);
  vec3 m = fetch(vUv + vec2( 1.0,-1.0) * t);

  vec3 result;
  if (uFirstMip > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25;
    vec3 g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25;
    vec3 g3 = (e + f + h + i) * 0.25;
    vec3 g4 = (j + k + l + m) * 0.25;
    float w0 = karisWeight(g0), w1 = karisWeight(g1), w2 = karisWeight(g2), w3 = karisWeight(g3), w4 = karisWeight(g4);
    float wsum = w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5;
    result = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) / max(wsum, 1e-5);
    // Threshold in exposed space: the scene is HDR radiance spanning many
    // stops, so an absolute cut either blooms everything at noon or nothing at
    // dusk. What counts as a highlight is what will land bright on screen.
    float exposure = texture(uExposure, vec2(0.5)).r * uExposureBias;
    float lum = luminance(result) * exposure;
    float knee = uThreshold * uSoftKnee + 1e-5;
    float soft = clamp(lum - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee);
    float contrib = max(soft, lum - uThreshold) / max(lum, 1e-5);
    result *= contrib;
  } else {
    result = e * 0.125;
    result += (a + c + g + i) * 0.03125;
    result += (b + d + f + h) * 0.0625;
    result += (j + k + l + m) * 0.125;
  }
  oColor = vec4(max(result, vec3(0.0)), 1.0);
}
`;

const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform sampler2D uBase;
uniform vec2 uInvSrc;
uniform float uRadius;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
void main(){
  vec2 t = uInvSrc * uRadius;
  vec3 s = texture(uSrc, vUv + vec2(-1, 1) * t).rgb * 1.0;
  s += texture(uSrc, vUv + vec2( 0, 1) * t).rgb * 2.0;
  s += texture(uSrc, vUv + vec2( 1, 1) * t).rgb * 1.0;
  s += texture(uSrc, vUv + vec2(-1, 0) * t).rgb * 2.0;
  s += texture(uSrc, vUv).rgb * 4.0;
  s += texture(uSrc, vUv + vec2( 1, 0) * t).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(-1,-1) * t).rgb * 1.0;
  s += texture(uSrc, vUv + vec2( 0,-1) * t).rgb * 2.0;
  s += texture(uSrc, vUv + vec2( 1,-1) * t).rgb * 1.0;
  s /= 16.0;
  oColor = vec4(texture(uBase, vUv).rgb + s, 1.0);
}
`;

/* ====================================================== depth of field */
const COC_FRAG = /* glsl */ `
uniform sampler2D uVelocity;
uniform float uFocusDist;
uniform float uFocalLength;
uniform float uAperture;
uniform float uMaxCoc;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
void main(){
  // anything that did not write a distance is background, i.e. at infinity
  float z = texture(uVelocity, vUv).z;
  if (!(z > 0.0)) z = 1.0e5;
  float f = uFocalLength;
  float s = max(uFocusDist, f * 1.02 + 1e-3);
  float apertureDiameter = f / max(uAperture, 0.7);
  // thin-lens CoC in metres on the sensor, normalised by sensor height (24mm)
  float coc = (apertureDiameter * f * (z - s)) / max(z * (s - f), 1e-6);
  coc = clamp(coc / 0.024, -1.0, 1.0) * uMaxCoc;
  oColor = vec4(coc, abs(coc), z, 1.0);
}
`;

const DOF_FRAG = /* glsl */ `
${SHADING_GLSL}
uniform sampler2D uColor;
uniform sampler2D uCoc;
uniform vec2 uInvResolution;
uniform float uMaxCoc;
uniform float uBokehRotation;
uniform float uBokehBlades;
in vec2 vUv;
layout(location = 0) out vec4 oColor;

const int TAPS = 43;

void main(){
  vec4 cc = texture(uCoc, vUv);
  float coc = cc.x;
  vec3 center = texture(uColor, vUv).rgb;
  float aCoc = abs(coc);
  if (aCoc < 0.0015) { oColor = vec4(center, 1.0); return; }

  float radius = aCoc * uMaxCoc;
  vec3 acc = center / (1.0 + luminance(center));
  float wsum = 1.0 / (1.0 + luminance(center));

  float golden = 2.39996323;
  for (int i = 1; i < TAPS; i++) {
    float fi = float(i);
    float r = sqrt(fi / float(TAPS - 1));
    float ang = fi * golden + uBokehRotation;
    // slight aperture-blade polygonalisation
    float blade = cos(PI_S / uBokehBlades) / max(cos(mod(ang, TAU_S / uBokehBlades) - PI_S / uBokehBlades), 1e-3);
    vec2 off = vec2(cos(ang), sin(ang)) * r * blade * radius;
    vec2 uv = vUv + off * uInvResolution;
    vec4 sc = texture(uCoc, uv);
    vec3 s = texture(uColor, uv).rgb;
    // reject background samples bleeding onto sharp foreground
    float sampleR = abs(sc.x) * uMaxCoc;
    float w = clamp((sampleR - length(off) + 1.0) * 0.5, 0.0, 1.0);
    if (sc.x < 0.0 && coc > 0.0) w *= 0.15;
    w /= (1.0 + luminance(s));
    acc += s * w;
    wsum += w;
  }
  oColor = vec4(acc / max(wsum, 1e-5), 1.0);
}
`;

const DOF_COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uSharp;
uniform sampler2D uBlur;
uniform sampler2D uCoc;
uniform vec2 uInvResolution;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
void main(){
  vec3 sharp = texture(uSharp, vUv).rgb;
  // 4-tap tent on the half-res bokeh buffer hides its resolution
  vec2 o = uInvResolution;
  vec3 blur = texture(uBlur, vUv + vec2(-o.x, -o.y)).rgb
            + texture(uBlur, vUv + vec2( o.x, -o.y)).rgb
            + texture(uBlur, vUv + vec2(-o.x,  o.y)).rgb
            + texture(uBlur, vUv + vec2( o.x,  o.y)).rgb;
  blur *= 0.25;
  float coc = abs(texture(uCoc, vUv).x);
  float t = smoothstep(0.012, 0.16, coc);
  oColor = vec4(mix(sharp, blur, t), 1.0);
}
`;

/* ============================================================ motion blur */
const MOTIONBLUR_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform sampler2D uColor;
uniform sampler2D uVelocity;
uniform vec2 uInvResolution;
uniform float uStrength;
uniform float uFrame;
uniform float uMaxRadius;
in vec2 vUv;
layout(location = 0) out vec4 oColor;

const int MB_TAPS = 13;

void main(){
  vec2 texSize = 1.0 / uInvResolution;
  vec2 vel = texture(uVelocity, vUv).xy * uStrength;
  // dilate
  for (int i = -2; i <= 2; i++) {
    vec2 o = vec2(float(i)) * uInvResolution * 3.0;
    vec2 v = texture(uVelocity, vUv + o).xy * uStrength;
    if (dot(v, v) > dot(vel, vel)) vel = v;
    v = texture(uVelocity, vUv + o.yx).xy * uStrength;
    if (dot(v, v) > dot(vel, vel)) vel = v;
  }
  float lenPx = length(vel * texSize);
  if (lenPx < 0.6) { oColor = texture(uColor, vUv); return; }
  float scale = min(1.0, uMaxRadius / lenPx);
  vel *= scale;

  float jitter = ignTemporal(gl_FragCoord.xy, uFrame) - 0.5;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < MB_TAPS; i++) {
    float t = (float(i) + 0.5 + jitter) / float(MB_TAPS) - 0.5;
    vec2 uv = vUv - vel * t;
    float w = 1.0;
    acc += texture(uColor, clamp(uv, vec2(0.0), vec2(1.0))).rgb * w;
    wsum += w;
  }
  oColor = vec4(acc / wsum, 1.0);
}
`;

/* ================================================================ composite */
const COMPOSITE_FRAG = /* glsl */ `
${SHADING_GLSL}
${NOISE_GLSL}
uniform sampler2D uColor;
uniform sampler2D uBloom;
uniform sampler2D uExposure;
uniform vec2 uResolution;
uniform float uBloomStrength;
uniform float uTime;
uniform float uFrame;
uniform float uVignette;
uniform float uGrain;
uniform float uChromatic;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;
uniform float uWetLens;
uniform float uRainStreaks;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uTonemapMode;
uniform float uExposureBias;
uniform float uDebugPass;
in vec2 vUv;
layout(location = 0) out vec4 oColor;

// Grain and dither are applied by the final pass, after sharpening: CAS on
// top of noise just sharpens the noise.

vec3 sampleChromatic(vec2 uv, float amount) {
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  vec2 dir = c * (r2 * amount * 0.006);
  vec3 col;
  col.r = texture(uColor, uv - dir * 1.0).r;
  col.g = texture(uColor, uv).g;
  col.b = texture(uColor, uv + dir * 1.0).b;
  return col;
}

// procedural lens dirt / water beading
float lensDirt(vec2 uv) {
  float d = 0.0;
  d += smoothstep(0.55, 1.0, fbm2Tiled(uv * 6.0, 6.0, 4)) * 0.6;
  d += (1.0 - worley2Tiled(uv * vec2(1.0, uResolution.y / uResolution.x) * 3.0, 8.0)) * 0.35;
  d += smoothstep(0.7, 1.0, vnoise2(uv * 22.0)) * 0.25;
  return clamp(d, 0.0, 1.0);
}

void main(){
  if (uDebugPass > 0.5) {
    oColor = vec4(linearToSrgb(max(texture(uColor, vUv).rgb, vec3(0.0))), 1.0);
    return;
  }
  float exposure = texture(uExposure, vec2(0.5)).r * uExposureBias;

  vec3 col = (uChromatic > 0.0001) ? sampleChromatic(vUv, uChromatic) : texture(uColor, vUv).rgb;

  vec3 bloom = texture(uBloom, vUv).rgb;
  float dirt = lensDirt(vUv);
  col += bloom * uBloomStrength * (1.0 + dirt * uWetLens * 3.0);

  col *= exposure;
  col += uFlash * uFlashColor * exposure;

  // ---- grade
  col = max(col, vec3(0.0));
  float lum = luminance(col);
  col = mix(vec3(lum), col, uSaturation);
  col = (col - 0.5) * uContrast + 0.5 + uLift;
  col = max(col, vec3(0.0));

  // ---- tonemap (returns display-linear 0..1)
  vec3 mapped;
  if (uTonemapMode < 0.5) {
    mapped = agx(col);
    mapped = agxLook(mapped, 1.0, vec3(1.0), vec3(1.04, 1.01, 1.0), 0.0);
    mapped = agxEotf(mapped);
    // AgX's contrast curve is display-encoded; linearise before the OETF
    mapped = pow(max(mapped, vec3(0.0)), vec3(2.2));
  } else {
    mapped = acesFitted(col);
  }
  mapped = clamp(mapped, 0.0, 1.0);

  // ---- vignette
  vec2 vc = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  float v = 1.0 - uVignette * dot(vc, vc) * 1.1;
  mapped *= clamp(v, 0.0, 1.0);

  vec3 srgb = linearToSrgb(max(mapped, vec3(0.0)));
  oColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
`;

/* ============================================================ grain + dither */
const GRAIN_FRAG = /* glsl */ `
${SHADING_GLSL}
${NOISE_GLSL}
uniform sampler2D uSrc;
uniform float uFrame;
uniform float uGrain;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
void main(){
  vec3 srgb = texture(uSrc, vUv).rgb;
  // film grain (luma-dependent) + 8-bit dither, always the last thing applied
  float g = ignTemporal(gl_FragCoord.xy, uFrame) - 0.5;
  srgb += g * uGrain * mix(1.0, 0.3, luminance(srgb));
  srgb += (hash12(gl_FragCoord.xy + uFrame) - 0.5) / 255.0;
  oColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
`;

/* ================================================================== sharpen */
const CAS_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uInvResolution;
uniform float uSharpness;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
void main(){
  vec2 t = uInvResolution;
  vec3 a = texture(uSrc, vUv + vec2(0.0, -t.y)).rgb;
  vec3 b = texture(uSrc, vUv + vec2(-t.x, 0.0)).rgb;
  vec3 c = texture(uSrc, vUv).rgb;
  vec3 d = texture(uSrc, vUv + vec2(t.x, 0.0)).rgb;
  vec3 e = texture(uSrc, vUv + vec2(0.0, t.y)).rgb;
  vec3 mn = min(min(min(a, b), min(d, e)), c);
  vec3 mx = max(max(max(a, b), max(d, e)), c);
  vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
  amp = sqrt(amp);
  vec3 w = -amp * (uSharpness * 0.2 + 0.03);
  vec3 res = (c + (a + b + d + e) * w) / (1.0 + 4.0 * w);
  oColor = vec4(clamp(res, 0.0, 1.0), 1.0);
}
`;

const HALT = [
  [0.5, 0.333333], [0.25, 0.666667], [0.75, 0.111111], [0.125, 0.444444],
  [0.625, 0.777778], [0.375, 0.222222], [0.875, 0.555556], [0.0625, 0.888889],
  [0.5625, 0.037037], [0.3125, 0.370370], [0.8125, 0.703704], [0.1875, 0.148148],
  [0.6875, 0.481481], [0.4375, 0.814815], [0.9375, 0.259259], [0.03125, 0.592593],
];

export class PostFX {
  constructor(renderer, width, height) {
    this.renderer = renderer;
    this.width = width; this.height = height;
    this.frame = 0;

    this.settings = {
      taa: true,
      taaBlend: 0.10,
      bloom: true,
      bloomStrength: 0.055,
      bloomThreshold: 1.1,
      bloomRadius: 1.15,
      dof: true,
      focusDistance: 60,
      focalLength: 0.055,
      aperture: 2.2,
      maxCoc: 22,
      motionBlur: true,
      motionBlurStrength: 0.55,
      // EV offset applied to the metered average. The Frostbite
      // avg-luminance -> EV100 -> 1/(1.2*2^EV) chain places the scene average at
      // ~0.10 linear, which AgX then renders a stop below middle grey: a clear
      // midday sea came out reading as dusk. Pull the meter down to sit the
      // average near 0.18 and let the tonemapper's shoulder hold the highlights.
      exposureCompensation: -0.5,
      exposureSpeedUp: 1.4,
      exposureSpeedDown: 0.7,
      vignette: 0.42,
      grain: 0.022,
      chromatic: 0.55,
      saturation: 1.06,
      contrast: 1.04,
      lift: 0.0,
      wetLens: 0.0,
      flash: 0.0,
      tonemap: 0,
      exposureBias: 1.0,
      sharpen: 0.45,
    };
    this.flashColor = new THREE.Vector3(0.8, 0.88, 1.0);

    this._build(width, height);
  }

  _build(w, h) {
    const half = { type: THREE.HalfFloatType };
    this.taaHistory = new PingPong(w, h, { ...half, name: 'taaHist' });
    this.sceneResolved = makeRT(w, h, { ...half, name: 'resolved' });
    this.tmpA = makeRT(w, h, { ...half, name: 'tmpA' });
    this.tmpB = makeRT(w, h, { ...half, name: 'tmpB' });
    this.cocRT = makeRT(w, h, { ...half, name: 'coc', minFilter: THREE.LinearFilter });
    this.dofW = Math.max(2, w >> 1); this.dofH = Math.max(2, h >> 1);
    this.dofRT = makeRT(this.dofW, this.dofH, { ...half, name: 'dof' });
    this.ldrRT = makeRT(w, h, { type: THREE.UnsignedByteType, name: 'ldr' });
    this.ldrRT2 = makeRT(w, h, { type: THREE.UnsignedByteType, name: 'ldr2' });

    // luminance reduction chain (float so it can be read back for diagnostics)
    this.lumChain = [];
    let lw = Math.max(1, Math.round(w / 4)), lh = Math.max(1, Math.round(h / 4));
    while (true) {
      this.lumChain.push(makeRT(lw, lh, {
        type: THREE.FloatType, minFilter: THREE.LinearFilter, name: `lum${lw}`,
      }));
      if (lw === 1 && lh === 1) break;
      lw = Math.max(1, lw >> 2); lh = Math.max(1, lh >> 2);
    }
    if (!this.exposureRT) {
      this.exposureRT = new PingPong(1, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, name: 'exposure' });
    }

    // bloom chain
    this.bloomChain = [];
    const levels = 7;
    let bw = w >> 1, bh = h >> 1;
    for (let i = 0; i < levels && bw > 4 && bh > 4; i++) {
      this.bloomChain.push(makeRT(bw, bh, { ...half, name: `bloom${i}` }));
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
    this.bloomUp = this.bloomChain.map((rt, i) => makeRT(rt.width, rt.height, { ...half, name: `bloomUp${i}` }));

    if (!this.passes) {
      this.passes = {
        taa: new FullScreenPass(TAA_FRAG, {
          uCurrent: { value: null }, uHistory: { value: null }, uVelocity: { value: null },
          uInvResolution: { value: new THREE.Vector2() }, uJitter: { value: new THREE.Vector2() },
          uBlend: { value: 0.1 }, uReset: { value: 1 },
        }, { name: 'taa' }),
        lumDown: new FullScreenPass(LUM_DOWN_FRAG, {
          uSrc: { value: null }, uInvSrc: { value: new THREE.Vector2() },
          uFirst: { value: 0 },
        }, { name: 'lumDown' }),
        exposure: new FullScreenPass(EXPOSURE_FRAG, {
          uLum: { value: null }, uPrev: { value: null }, uDt: { value: 0.016 },
          uSpeedUp: { value: 1.4 }, uSpeedDown: { value: 0.7 }, uCompensation: { value: 0.4 },
          uMinEV: { value: -5.0 }, uMaxEV: { value: 17.0 }, uReset: { value: 1 },
        }, { name: 'exposure' }),
        bloomDown: new FullScreenPass(BLOOM_DOWN_FRAG, {
          uSrc: { value: null }, uExposure: { value: null }, uInvSrc: { value: new THREE.Vector2() },
          uFirstMip: { value: 0 }, uThreshold: { value: 1.0 }, uSoftKnee: { value: 0.6 },
          uExposureBias: { value: 1.0 },
        }, { name: 'bloomDown' }),
        bloomUp: new FullScreenPass(BLOOM_UP_FRAG, {
          uSrc: { value: null }, uBase: { value: null },
          uInvSrc: { value: new THREE.Vector2() }, uRadius: { value: 1.0 },
        }, { name: 'bloomUp' }),
        coc: new FullScreenPass(COC_FRAG, {
          uVelocity: { value: null }, uFocusDist: { value: 50 }, uFocalLength: { value: 0.05 },
          uAperture: { value: 2.8 }, uMaxCoc: { value: 1.0 },
        }, { name: 'coc' }),
        dof: new FullScreenPass(DOF_FRAG, {
          uColor: { value: null }, uCoc: { value: null },
          uInvResolution: { value: new THREE.Vector2() }, uMaxCoc: { value: 20 },
          uBokehRotation: { value: 0 }, uBokehBlades: { value: 7 },
        }, { name: 'dof' }),
        dofComposite: new FullScreenPass(DOF_COMPOSITE_FRAG, {
          uSharp: { value: null }, uBlur: { value: null }, uCoc: { value: null },
          uInvResolution: { value: new THREE.Vector2() },
        }, { name: 'dofComposite' }),
        motionBlur: new FullScreenPass(MOTIONBLUR_FRAG, {
          uColor: { value: null }, uVelocity: { value: null },
          uInvResolution: { value: new THREE.Vector2() }, uStrength: { value: 0.5 },
          uFrame: { value: 0 }, uMaxRadius: { value: 48 },
        }, { name: 'motionBlur' }),
        composite: new FullScreenPass(COMPOSITE_FRAG, {
          uColor: { value: null }, uBloom: { value: null }, uExposure: { value: null },
          uResolution: { value: new THREE.Vector2() }, uBloomStrength: { value: 0.06 },
          uTime: { value: 0 }, uFrame: { value: 0 }, uVignette: { value: 0.4 },
          uGrain: { value: 0.02 }, uChromatic: { value: 0.5 }, uSaturation: { value: 1.05 },
          uContrast: { value: 1.03 }, uLift: { value: 0 }, uWetLens: { value: 0 },
          uRainStreaks: { value: 0 }, uFlash: { value: 0 },
          uFlashColor: { value: this.flashColor }, uTonemapMode: { value: 0 },
          uExposureBias: { value: 1.0 }, uDebugPass: { value: 0 },
        }, { name: 'composite' }),
        cas: new FullScreenPass(CAS_FRAG, {
          uSrc: { value: null }, uInvResolution: { value: new THREE.Vector2() }, uSharpness: { value: 0.5 },
        }, { name: 'cas' }),
        grain: new FullScreenPass(GRAIN_FRAG, {
          uSrc: { value: null }, uFrame: { value: 0 }, uGrain: { value: 0.02 },
        }, { name: 'grain' }),
      };
    }
    this.reset = true;
  }

  setSize(w, h) {
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    [this.sceneResolved, this.tmpA, this.tmpB, this.cocRT, this.dofRT, this.ldrRT, this.ldrRT2].forEach(rt => rt && rt.dispose());
    this.taaHistory.dispose();
    this.lumChain.forEach(rt => rt.dispose());
    this.bloomChain.forEach(rt => rt.dispose());
    this.bloomUp.forEach(rt => rt.dispose());
    this._build(w, h);
  }

  /** TAA sub-pixel offset in NDC for the current frame. */
  getJitter(index) {
    const [jx, jy] = HALT[index % HALT.length];
    return [(jx - 0.5) * 2.0 / this.width, (jy - 0.5) * 2.0 / this.height];
  }

  render(hdrTex, velTex, outTarget = null) {
    const r = this.renderer;
    const s = this.settings;
    const p = this.passes;
    const w = this.width, h = this.height;
    const inv = [1 / w, 1 / h];
    this.frame++;

    // ---------------------------------------------------------------- TAA
    let color;
    if (s.taa) {
      p.taa.set('uCurrent', hdrTex).set('uHistory', this.taaHistory.read.texture)
        .set('uVelocity', velTex).set('uBlend', s.taaBlend)
        .set('uReset', this.reset ? 1 : 0);
      p.taa.uniforms.uInvResolution.value.set(inv[0], inv[1]);
      p.taa.render(r, this.taaHistory.write);
      this.taaHistory.swap();
      color = this.taaHistory.read.texture;
    } else {
      color = hdrTex;
    }

    // ------------------------------------------------------------ exposure
    p.lumDown.set('uSrc', color).set('uFirst', 1);
    p.lumDown.uniforms.uInvSrc.value.set(inv[0], inv[1]);
    p.lumDown.render(r, this.lumChain[0]);
    for (let i = 1; i < this.lumChain.length; i++) {
      const src = this.lumChain[i - 1];
      p.lumDown.set('uSrc', src.texture).set('uFirst', 0);
      p.lumDown.uniforms.uInvSrc.value.set(1 / src.width, 1 / src.height);
      p.lumDown.render(r, this.lumChain[i]);
    }
    p.exposure.set('uLum', this.lumChain[this.lumChain.length - 1].texture)
      .set('uPrev', this.exposureRT.read.texture)
      .set('uDt', Math.min(U.uDt.value, 0.1))
      .set('uSpeedUp', s.exposureSpeedUp).set('uSpeedDown', s.exposureSpeedDown)
      .set('uCompensation', s.exposureCompensation)
      .set('uReset', this.reset ? 1 : 0);
    p.exposure.render(r, this.exposureRT.write);
    this.exposureRT.swap();

    // -------------------------------------------------------- motion blur
    if (s.motionBlur && s.motionBlurStrength > 0.001) {
      p.motionBlur.set('uColor', color).set('uVelocity', velTex)
        .set('uStrength', s.motionBlurStrength).set('uFrame', this.frame);
      p.motionBlur.uniforms.uInvResolution.value.set(inv[0], inv[1]);
      p.motionBlur.render(r, this.tmpA);
      color = this.tmpA.texture;
    }

    // ---------------------------------------------------------------- DOF
    if (s.dof) {
      p.coc.set('uVelocity', velTex).set('uFocusDist', s.focusDistance)
        .set('uFocalLength', s.focalLength).set('uAperture', s.aperture).set('uMaxCoc', 1.0);
      p.coc.render(r, this.cocRT);
      p.dof.set('uColor', color).set('uCoc', this.cocRT.texture)
        .set('uMaxCoc', s.maxCoc * (h / 1080) * 0.5).set('uBokehRotation', this.frame * 0.31);
      p.dof.uniforms.uInvResolution.value.set(1 / this.dofW, 1 / this.dofH);
      p.dof.render(r, this.dofRT);
      p.dofComposite.set('uSharp', color).set('uBlur', this.dofRT.texture).set('uCoc', this.cocRT.texture);
      p.dofComposite.uniforms.uInvResolution.value.set(1 / this.dofW, 1 / this.dofH);
      p.dofComposite.render(r, this.tmpB);
      color = this.tmpB.texture;
    }

    // -------------------------------------------------------------- bloom
    let bloomTex = null;
    if (s.bloom && this.bloomChain.length) {
      for (let i = 0; i < this.bloomChain.length; i++) {
        const src = i === 0 ? color : this.bloomChain[i - 1].texture;
        const srcW = i === 0 ? w : this.bloomChain[i - 1].width;
        const srcH = i === 0 ? h : this.bloomChain[i - 1].height;
        p.bloomDown.set('uSrc', src).set('uFirstMip', i === 0 ? 1 : 0)
          .set('uThreshold', s.bloomThreshold)
          .set('uExposure', this.exposureRT.read.texture).set('uExposureBias', s.exposureBias);
        p.bloomDown.uniforms.uInvSrc.value.set(1 / srcW, 1 / srcH);
        p.bloomDown.render(r, this.bloomChain[i]);
      }
      const last = this.bloomChain.length - 1;
      // seed the top of the upsample chain
      p.bloomUp.set('uSrc', this.bloomChain[last].texture).set('uBase', this.bloomChain[last].texture)
        .set('uRadius', 0.0);
      p.bloomUp.uniforms.uInvSrc.value.set(1 / this.bloomChain[last].width, 1 / this.bloomChain[last].height);
      p.bloomUp.render(r, this.bloomUp[last]);
      for (let i = last - 1; i >= 0; i--) {
        p.bloomUp.set('uSrc', this.bloomUp[i + 1].texture).set('uBase', this.bloomChain[i].texture)
          .set('uRadius', s.bloomRadius);
        p.bloomUp.uniforms.uInvSrc.value.set(1 / this.bloomUp[i + 1].width, 1 / this.bloomUp[i + 1].height);
        p.bloomUp.render(r, this.bloomUp[i]);
      }
      bloomTex = this.bloomUp[0].texture;
    }

    // ---------------------------------------------------------- composite
    const c = p.composite;
    c.set('uColor', color).set('uBloom', bloomTex || this.bloomChain[0]?.texture || color)
      .set('uExposure', this.exposureRT.read.texture)
      .set('uBloomStrength', bloomTex ? s.bloomStrength : 0.0)
      .set('uTime', U.uTime.value).set('uFrame', this.frame)
      .set('uVignette', s.vignette).set('uGrain', s.grain).set('uChromatic', s.chromatic)
      .set('uSaturation', s.saturation).set('uContrast', s.contrast).set('uLift', s.lift)
      .set('uWetLens', s.wetLens).set('uFlash', s.flash)
      .set('uTonemapMode', s.tonemap).set('uExposureBias', s.exposureBias)
      .set('uDebugPass', s.debugPassthrough ? 1 : 0);
    c.uniforms.uResolution.value.set(w, h);
    c.uniforms.uFlashColor.value.copy(this.flashColor);

    // Order matters at the tail: tonemap -> sharpen -> grain + dither. Grain
    // before CAS gets sharpened into a speckle; dither before CAS is undone.
    const passthrough = !!s.debugPassthrough;
    const wantGrain = !passthrough && s.grain > 0.0001;
    const wantCas = !passthrough && s.sharpen > 0.001;
    if (!wantCas && !wantGrain) {
      c.render(r, outTarget);
    } else {
      c.render(r, this.ldrRT);
      let ldr = this.ldrRT;
      if (wantCas) {
        p.cas.set('uSrc', ldr.texture).set('uSharpness', s.sharpen);
        p.cas.uniforms.uInvResolution.value.set(inv[0], inv[1]);
        p.cas.render(r, wantGrain ? this.ldrRT2 : outTarget);
        ldr = this.ldrRT2;
      }
      if (wantGrain) {
        p.grain.set('uSrc', ldr.texture).set('uFrame', this.frame).set('uGrain', s.grain);
        p.grain.render(r, outTarget);
      }
    }

    this.reset = false;
  }
}
