import * as THREE from 'three';

/**
 * Minimal, allocation-free full-screen shader pass.
 * Shares one triangle geometry and one orthographic camera across every pass
 * in the app; only the material differs.
 */

const _geom = new THREE.BufferGeometry();
_geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
_geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
_geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);

const _cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

export const FS_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

export class FullScreenPass {
  /**
   * @param {string} fragment GLSL3 fragment source (must declare its own `out`s)
   * @param {object} uniforms
   * @param {object} [opts] { defines, name, blending, depthTest }
   */
  constructor(fragment, uniforms = {}, opts = {}) {
    this.material = new THREE.RawShaderMaterial({
      name: opts.name || 'FullScreenPass',
      glslVersion: THREE.GLSL3,
      vertexShader: `precision highp float;\nprecision highp int;\nin vec3 position;\nin vec2 uv;\n${FS_VERT}`,
      fragmentShader: `precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp sampler3D;\nprecision highp sampler2DArray;\n${fragment}`,
      uniforms,
      defines: opts.defines || {},
      depthTest: false,
      depthWrite: false,
      blending: opts.blending !== undefined ? opts.blending : THREE.NoBlending,
      transparent: opts.blending !== undefined && opts.blending !== THREE.NoBlending,
    });
    this.mesh = new THREE.Mesh(_geom, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
  }

  get uniforms() { return this.material.uniforms; }

  set(name, value) {
    const u = this.material.uniforms[name];
    if (u) u.value = value;
    return this;
  }

  define(name, value) {
    if (this.material.defines[name] !== value) {
      this.material.defines[name] = value;
      this.material.needsUpdate = true;
    }
    return this;
  }

  render(renderer, target = null, clear = false) {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = clear;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, _cam);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  dispose() { this.material.dispose(); }
}

/** Convenience helper: creates a render target with sane defaults. */
export function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: opts.type || THREE.HalfFloatType,
    format: opts.format || THREE.RGBAFormat,
    minFilter: opts.minFilter || THREE.LinearFilter,
    magFilter: opts.magFilter || THREE.LinearFilter,
    wrapS: opts.wrap || THREE.ClampToEdgeWrapping,
    wrapT: opts.wrap || THREE.ClampToEdgeWrapping,
    depthBuffer: !!opts.depthBuffer,
    stencilBuffer: false,
    generateMipmaps: !!opts.mipmaps,
    count: opts.count || 1,
  });
  rt.texture.name = opts.name || 'rt';
  if (opts.anisotropy) rt.texture.anisotropy = opts.anisotropy;
  if (opts.count > 1) {
    for (let i = 0; i < opts.count; i++) {
      rt.textures[i].name = `${opts.name || 'rt'}[${i}]`;
      rt.textures[i].minFilter = opts.minFilter || THREE.LinearFilter;
      rt.textures[i].magFilter = opts.magFilter || THREE.LinearFilter;
      rt.textures[i].wrapS = opts.wrap || THREE.ClampToEdgeWrapping;
      rt.textures[i].wrapT = opts.wrap || THREE.ClampToEdgeWrapping;
      rt.textures[i].generateMipmaps = !!opts.mipmaps;
      if (opts.anisotropy) rt.textures[i].anisotropy = opts.anisotropy;
    }
  }
  return rt;
}

/** Simple A/B ping-pong pair. */
export class PingPong {
  constructor(w, h, opts = {}) {
    this.a = makeRT(w, h, { ...opts, name: (opts.name || 'pp') + 'A' });
    this.b = makeRT(w, h, { ...opts, name: (opts.name || 'pp') + 'B' });
  }
  swap() { const t = this.a; this.a = this.b; this.b = t; }
  get read() { return this.a; }
  get write() { return this.b; }
  setSize(w, h) { this.a.setSize(w, h); this.b.setSize(w, h); }
  dispose() { this.a.dispose(); this.b.dispose(); }
}
