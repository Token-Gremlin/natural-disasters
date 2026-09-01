/** Reusable procedural noise library (hash / value / perlin / worley / fbm / curl). */
export const NOISE_GLSL = /* glsl */ `
#ifndef NOISE_GLSL
#define NOISE_GLSL 1

float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3){ p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }

// ------------------------------------------------------------- value noise
float vnoise2(vec2 x){
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1,0)), c = hash12(i + vec2(0,1)), d = hash12(i + vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float vnoise3(vec3 x){
  vec3 i = floor(x), f = fract(x);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0,0,0)), n100 = hash13(i + vec3(1,0,0));
  float n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1));
  float n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000,n100,u.x), mix(n010,n110,u.x), u.y),
             mix(mix(n001,n101,u.x), mix(n011,n111,u.x), u.y), u.z);
}

// ----------------------------------------------------- tileable perlin 3D
vec3 tileHash33(vec3 p, float period){
  p = mod(p, vec3(period));
  return normalize(hash33(p) * 2.0 - 1.0);
}
float perlin3Tiled(vec3 x, float period){
  vec3 i = floor(x), f = fract(x);
  vec3 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  float n = 0.0;
  for (int dz = 0; dz <= 1; dz++)
  for (int dy = 0; dy <= 1; dy++)
  for (int dx = 0; dx <= 1; dx++) {
    vec3 o = vec3(float(dx), float(dy), float(dz));
    vec3 g = tileHash33(i + o, period);
    float w = mix(1.0-u.x, u.x, o.x) * mix(1.0-u.y, u.y, o.y) * mix(1.0-u.z, u.z, o.z);
    n += w * dot(g, f - o);
  }
  return n;
}
float perlinFbm3(vec3 p, float period, int octaves){
  float f = 0.0, amp = 0.5, per = period;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    f += amp * perlin3Tiled(p, per);
    p *= 2.0; per *= 2.0; amp *= 0.5;
  }
  return f;
}

// ------------------------------------------------------ tileable worley 3D
float worley3Tiled(vec3 p, float cells){
  p *= cells;
  vec3 i = floor(p), f = fract(p);
  float minDist = 1e9;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 cell = mod(i + o, vec3(cells));
    vec3 pt = o + hash33(cell);
    minDist = min(minDist, dot(pt - f, pt - f));
  }
  return clamp(sqrt(minDist), 0.0, 1.0);
}
float worleyFbm3(vec3 p, float cells){
  return worley3Tiled(p, cells) * 0.625
       + worley3Tiled(p, cells * 2.0) * 0.25
       + worley3Tiled(p, cells * 4.0) * 0.125;
}

// -------------------------------------------------------- tileable worley 2D
float worley2Tiled(vec2 p, float cells){
  p *= cells;
  vec2 i = floor(p), f = fract(p);
  float minDist = 1e9;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 cell = mod(i + o, vec2(cells));
    vec2 pt = o + hash22(cell);
    minDist = min(minDist, dot(pt - f, pt - f));
  }
  return clamp(sqrt(minDist), 0.0, 1.0);
}
float vnoise2Tiled(vec2 x, float period){
  vec2 i = floor(x), f = fract(x);
  vec2 u = f*f*(3.0-2.0*f);
  float a = hash12(mod(i, period));
  float b = hash12(mod(i + vec2(1,0), period));
  float c = hash12(mod(i + vec2(0,1), period));
  float d = hash12(mod(i + vec2(1,1), period));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm2Tiled(vec2 p, float period, int octaves){
  float f = 0.0, amp = 0.5, per = period;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    f += amp * vnoise2Tiled(p * per / period, per);
    per *= 2.0; amp *= 0.5;
  }
  return f;
}

// Seamless fbm over the unit square: N lattice cells across the texture,
// each octave doubling and wrapping. (fbm2Tiled above scales the *period*, not
// the position, so over a unit-square bake it only ever covers one lattice
// cell and the texture does not repeat — a seam every tile.)
float fbm2Seamless(vec2 p, float cells, int octaves){
  float f = 0.0, amp = 0.5, c = cells;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    f += amp * vnoise2Tiled(p * c, c);
    c *= 2.0; amp *= 0.5;
  }
  return f;
}

// Interleaved gradient noise — cheap per-pixel dithering
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Ordered 4x4 dither. Every 4x4 tile carries the sixteen values of [0,1) once,
// so averaging a tile is a stratified estimate rather than a random one.
float bayer4(vec2 p){
  ivec2 i = ivec2(mod(floor(p), 4.0));
  int b = ((i.x & 1) << 3) | ((i.y & 1) << 2) | (i.x & 2) | ((i.y & 2) >> 1);
  return (float(b) + 0.5) / 16.0;
}
float ignTemporal(vec2 p, float frame){
  p += 5.588238 * fract(frame * 0.6180339887);
  return ign(p);
}

#endif
`;
