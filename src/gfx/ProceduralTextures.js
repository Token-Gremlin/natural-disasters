import * as THREE from 'three';
import { FullScreenPass, makeRT } from './FullScreenPass.js';
import { NOISE_GLSL } from './NoiseGLSL.js';

/**
 * Every texture in the demo is baked on the GPU at start-up.
 * Nothing is loaded from disk or the network.
 */

const FOAM_FRAG = /* glsl */ `
${NOISE_GLSL}
in vec2 vUv;
layout(location = 0) out vec4 oCol;
void main(){
  vec2 p = vUv;
  // clustered bubble rafts
  float w1 = 1.0 - worley2Tiled(p, 6.0);
  float w2 = 1.0 - worley2Tiled(p, 14.0);
  float w3 = 1.0 - worley2Tiled(p, 32.0);
  float w4 = 1.0 - worley2Tiled(p, 72.0);

  float clusters = clamp(w1 * 0.55 + w2 * 0.3 + w3 * 0.18, 0.0, 1.0);
  clusters = pow(clusters, 1.35);

  float bubbles = clamp(w3 * 0.5 + w4 * 0.7, 0.0, 1.0);
  bubbles = smoothstep(0.32, 0.92, bubbles);

  float fbm = fbm2Tiled(p, 8.0, 6);
  float streak = fbm2Tiled(vec2(p.x * 0.35, p.y * 3.0), 8.0, 5);

  // dissolve mask drives foam erosion over time
  float dissolve = clamp(fbm * 0.6 + w2 * 0.4, 0.0, 1.0);

  oCol = vec4(clusters, bubbles, clamp(fbm * 1.15, 0.0, 1.0), dissolve * 0.75 + streak * 0.25);
}
`;

/**
 * Capillary relief that rides on the spectrum. Rounded wavelets, not cells:
 * the previous field was mostly a Worley ridge network amplified forty times,
 * which reads as etched metal the moment anisotropic filtering stops blurring
 * it into a haze. Gradients are normalised by the sample step so the slope is a
 * property of the field rather than of the bake resolution.
 */
const RIPPLE_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform float uRes;
uniform float uSlope;
in vec2 vUv;
layout(location = 0) out vec4 oCol;
float h(vec2 p){
  float a = fbm2Tiled(p, 11.0, 5);
  float b = fbm2Tiled(p + vec2(3.71, 1.29), 26.0, 4);
  // A trace of cellular structure for the dimpled look of a wind-ruffled
  // surface, rounded off hard so it contributes shape and not creases.
  float c = smoothstep(0.10, 0.95, 1.0 - worley2Tiled(p, 30.0));
  return a * 0.56 + b * 0.30 + c * 0.14;
}
void main(){
  vec2 p = vUv;
  float e = 1.5 / uRes;
  float gx = (h(p + vec2(e, 0.0)) - h(p - vec2(e, 0.0))) / (2.0 * e);
  float gy = (h(p + vec2(0.0, e)) - h(p - vec2(0.0, e))) / (2.0 * e);
  vec3 n = normalize(vec3(-gx * uSlope, 1.0, -gy * uSlope));
  oCol = vec4(n * 0.5 + 0.5, h(p));
}
`;

// Perlin-Worley cloud base shape, baked to a horizontal atlas then uploaded as 3D.
const CLOUD_SHAPE_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform float uRes;
uniform float uTilesX;
in vec2 vUv;
layout(location = 0) out vec4 oCol;
void main(){
  vec2 px = floor(vUv * vec2(uRes * uTilesX, uRes));
  float tileX = floor(px.x / uRes);
  float tileY = floor(px.y / uRes);
  float z = tileX + tileY * uTilesX;
  vec3 uvw = vec3((mod(px.x, uRes) + 0.5) / uRes, (mod(px.y, uRes) + 0.5) / uRes, (z + 0.5) / uRes);

  // Five octaves from 4 tops out at frequency 64, which is Nyquist for a 128^3
  // volume. Seven ran to 256: the last two octaves alias into per-texel grit,
  // and once the coverage threshold slices that field the grit becomes
  // single-voxel blobs — a sky of little cubes no erosion pass can smooth.
  float freq = 4.0;
  float perlin = clamp(perlinFbm3(uvw * freq, freq, 5) * 0.5 + 0.5, 0.0, 1.0);

  // billowy worley octaves (inverted so high == dense)
  float w0 = 1.0 - worleyFbm3(uvw, 4.0);
  float w1 = 1.0 - worleyFbm3(uvw, 8.0);
  float w2 = 1.0 - worleyFbm3(uvw, 14.0);
  float w3 = 1.0 - worleyFbm3(uvw, 22.0);

  // Schneider's perlin-worley: dilate the perlin field by the low worley so the
  // result keeps perlin's connectedness with worley's cauliflower edges.
  float perlinWorley = w0 + perlin * (1.0 - w0);

  oCol = vec4(clamp(perlinWorley, 0.0, 1.0), w1, w2, w3);
}
`;

const CLOUD_DETAIL_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform float uRes;
uniform float uTilesX;
in vec2 vUv;
layout(location = 0) out vec4 oCol;
void main(){
  vec2 px = floor(vUv * vec2(uRes * uTilesX, uRes));
  float tileX = floor(px.x / uRes);
  float tileY = floor(px.y / uRes);
  float z = tileX + tileY * uTilesX;
  vec3 uvw = vec3((mod(px.x, uRes) + 0.5) / uRes, (mod(px.y, uRes) + 0.5) / uRes, (z + 0.5) / uRes);
  float w0 = 1.0 - worleyFbm3(uvw, 3.0);
  float w1 = 1.0 - worleyFbm3(uvw, 6.0);
  float w2 = 1.0 - worleyFbm3(uvw, 11.0);
  oCol = vec4(w0, w1, w2, (w0 + w1 + w2) / 3.0);
}
`;

/**
 * Cloud weather map. Deciding where cloud goes from a couple of taps into the
 * 3D shape volume looks fine in isolation but stamps the volume's texel grid
 * across the sky the moment you threshold it, because a 128³ trilinear field
 * is only C0 continuous. Baking the decision into a dedicated high-resolution
 * 2D field costs one fetch instead of two and has no grid to show.
 *
 *   r  synoptic coverage — the scale of whole weather systems
 *   g  cell modulation — which parts of a system are actively building
 *   b  cloud type — flat stratus through to a towering cumulonimbus
 *   a  convective cores, used to place the anvils
 */
const WEATHER_FRAG = /* glsl */ `
${NOISE_GLSL}
in vec2 vUv;
layout(location = 0) out vec4 oCol;

void main(){
  vec2 p = vUv;

  // Synoptic scale: broad fronts and clear lanes. Ridged noise gives the long
  // filamentary bands a satellite image actually shows, rather than the
  // isotropic blobs a plain fbm produces. The ridge is smoothed because a bare
  // absolute value has a crease along its zero set, and a crease in coverage
  // becomes a dead-straight edge to the cloud deck kilometres long.
  float f1 = fbm2Tiled(p, 4.0, 5);
  float f2 = fbm2Tiled(p + vec2(3.7, 1.3), 6.0, 5);
  float r = f2 * 2.0 - 1.0;
  float band = 1.0 - sqrt(r * r + 0.035);
  float synoptic = clamp(f1 * 0.62 + band * 0.55 - 0.10, 0.0, 1.0);

  // Mesoscale cells inside a system, with worley to give them discrete edges.
  float cells = 1.0 - worley2Tiled(p + vec2(0.41, 0.77), 9.0);
  float meso = clamp(fbm2Tiled(p * 1.0 + vec2(9.1, 4.4), 11.0, 4) * 0.7 + cells * 0.5, 0.0, 1.0);

  // Type: the deepest, most persistent parts of a system grow towers.
  float type = clamp(smoothstep(0.42, 0.86, synoptic) * 0.8
                   + fbm2Tiled(p + vec2(6.3, 2.9), 7.0, 3) * 0.5, 0.0, 1.0);

  // Convective cores: sparse, small, and only inside an active region.
  float core = smoothstep(0.55, 0.95, 1.0 - worley2Tiled(p + vec2(2.2, 8.8), 14.0));
  core *= smoothstep(0.35, 0.8, synoptic);

  oCol = vec4(synoptic, meso, type, core);
}
`;

// 2D curl/turbulence field used for cloud edge distortion and spray advection
const CURL_FRAG = /* glsl */ `
${NOISE_GLSL}
in vec2 vUv;
layout(location = 0) out vec4 oCol;
void main(){
  float e = 1.0 / 256.0;
  float n1 = fbm2Tiled(vUv + vec2(0.0, e), 6.0, 4);
  float n2 = fbm2Tiled(vUv - vec2(0.0, e), 6.0, 4);
  float n3 = fbm2Tiled(vUv + vec2(e, 0.0), 6.0, 4);
  float n4 = fbm2Tiled(vUv - vec2(e, 0.0), 6.0, 4);
  vec2 curl = vec2(n1 - n2, n4 - n3) / (2.0 * e);
  curl = normalize(curl + 1e-6) * 0.5 + 0.5;
  oCol = vec4(curl, fbm2Tiled(vUv, 12.0, 5), fbm2Tiled(vUv, 3.0, 4));
}
`;

function bake(renderer, frag, w, h, uniforms = {}, type = THREE.UnsignedByteType) {
  const rt = makeRT(w, h, { type, wrap: THREE.RepeatWrapping, name: 'bake' });
  const pass = new FullScreenPass(frag, uniforms, { name: 'bake' });
  pass.render(renderer, rt);
  pass.dispose();
  return rt;
}

/**
 * Per-channel 2%/98% percentiles. Procedural noise recipes rarely fill [0,1]
 * evenly, and a compressed channel makes every downstream threshold impossible
 * to tune, so the consumer normalises with these instead of magic numbers.
 */
function channelPercentiles(buf, count, p = 0.02) {
  const lo = [], hi = [];
  for (let c = 0; c < 4; c++) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < count; i++) hist[buf[i * 4 + c]]++;
    let acc = 0, l = 0, hgh = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= count * p) { l = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= count * p) { hgh = i; break; } }
    if (hgh <= l) hgh = Math.min(255, l + 1);
    lo.push(l / 255); hi.push(hgh / 255);
  }
  return { lo, hi };
}

function atlasTo3D(renderer, rt, res, tilesX, tilesY) {
  const w = res * tilesX, h = res * tilesY;
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  const stats = channelPercentiles(buf, w * h);
  const out = new Uint8Array(res * res * res * 4);
  for (let z = 0; z < res; z++) {
    const tx = z % tilesX, ty = Math.floor(z / tilesX);
    for (let y = 0; y < res; y++) {
      const srcRow = ((ty * res + y) * w + tx * res) * 4;
      const dstRow = ((z * res + y) * res) * 4;
      out.set(buf.subarray(srcRow, srcRow + res * 4), dstRow);
    }
  }
  const tex = new THREE.Data3DTexture(out, res, res, res);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  tex.userData.percentiles = stats;
  return tex;
}

export async function bakeProceduralTextures(renderer, onProgress = () => {}) {
  const out = {};
  const yieldFrame = () => new Promise(r => setTimeout(r, 0));

  const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());

  onProgress('baking foam & bubble rafts');
  await yieldFrame();
  const foamRT = bake(renderer, FOAM_FRAG, 2048, 2048);
  foamRT.texture.wrapS = foamRT.texture.wrapT = THREE.RepeatWrapping;
  foamRT.texture.minFilter = THREE.LinearMipmapLinearFilter;
  foamRT.texture.generateMipmaps = true;
  foamRT.texture.anisotropy = aniso;
  foamRT.texture.needsUpdate = true;
  out.foam = foamRT.texture;
  out._foamRT = foamRT;

  onProgress('baking micro-ripple normals');
  await yieldFrame();
  const RIPPLE_RES = 1024;
  const rippleRT = bake(renderer, RIPPLE_FRAG, RIPPLE_RES, RIPPLE_RES, {
    uRes: { value: RIPPLE_RES }, uSlope: { value: 0.030 },
  });
  rippleRT.texture.wrapS = rippleRT.texture.wrapT = THREE.RepeatWrapping;
  rippleRT.texture.minFilter = THREE.LinearMipmapLinearFilter;
  rippleRT.texture.generateMipmaps = true;
  rippleRT.texture.anisotropy = aniso;
  rippleRT.texture.needsUpdate = true;
  out.ripple = rippleRT.texture;
  out._rippleRT = rippleRT;

  onProgress('baking curl turbulence field');
  await yieldFrame();
  const curlRT = bake(renderer, CURL_FRAG, 256, 256);
  curlRT.texture.wrapS = curlRT.texture.wrapT = THREE.RepeatWrapping;
  out.curl = curlRT.texture;
  out._curlRT = curlRT;

  onProgress('baking synoptic weather map');
  await yieldFrame();
  const weatherRT = bake(renderer, WEATHER_FRAG, 1024, 1024);
  weatherRT.texture.wrapS = weatherRT.texture.wrapT = THREE.RepeatWrapping;
  weatherRT.texture.minFilter = THREE.LinearMipmapLinearFilter;
  weatherRT.texture.generateMipmaps = true;
  weatherRT.texture.needsUpdate = true;
  out.weather = weatherRT.texture;
  out._weatherRT = weatherRT;

  onProgress('baking volumetric cloud shape (128³)');
  await yieldFrame();
  const SHAPE_RES = 128, SHAPE_TX = 16, SHAPE_TY = 8;
  const shapeRT = bake(renderer, CLOUD_SHAPE_FRAG, SHAPE_RES * SHAPE_TX, SHAPE_RES * SHAPE_TY, {
    uRes: { value: SHAPE_RES }, uTilesX: { value: SHAPE_TX },
  });
  out.cloudShape = atlasTo3D(renderer, shapeRT, SHAPE_RES, SHAPE_TX, SHAPE_TY);
  shapeRT.dispose();

  onProgress('baking volumetric cloud detail (32³)');
  await yieldFrame();
  const DET_RES = 32, DET_TX = 8, DET_TY = 4;
  const detRT = bake(renderer, CLOUD_DETAIL_FRAG, DET_RES * DET_TX, DET_RES * DET_TY, {
    uRes: { value: DET_RES }, uTilesX: { value: DET_TX },
  });
  out.cloudDetail = atlasTo3D(renderer, detRT, DET_RES, DET_TX, DET_TY);
  detRT.dispose();

  return out;
}
