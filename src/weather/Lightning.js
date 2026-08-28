import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';

/**
 * Procedural cloud-to-sea lightning.
 *
 * Each strike is a recursively displaced polyline with forking branches, drawn
 * as camera-facing ribbons with an additive core/glow. A strike also drives the
 * shared lightning uniforms, so the ocean, the cloud volume and the sky all
 * respond to the same flash without any extra bookkeeping.
 *
 * Return strokes are modelled as a short train of flashes with decreasing
 * amplitude, which is what gives real lightning its stutter.
 */

const MAX_SEGMENTS = 2048;

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 aStart;
in vec3 aEnd;
in vec2 aWidth;       // (core width, glow width)
in vec2 aLife;        // (bolt index, branch fade)

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCamPos;
uniform vec4 uBoltState[4];   // xyz unused, w = current intensity

out vec2 vUv;
out float vIntensity;
out float vGlow;

void main(){
  int bi = int(aLife.x + 0.5);
  float intensity = uBoltState[bi].w * aLife.y;
  vIntensity = intensity;

  vec3 seg = aEnd - aStart;
  vec3 mid = mix(aStart, aEnd, 0.5);
  vec3 toEye = normalize(uCamPos - mid);
  vec3 side = normalize(cross(normalize(seg), toEye));

  // widen with distance so a far bolt never falls below a pixel
  float dist = length(uCamPos - mid);
  float widen = 1.0 + dist * 0.0016;
  float w = mix(aWidth.x, aWidth.y, position.z) * widen * (intensity > 0.001 ? 1.0 : 0.0);
  vGlow = position.z;

  vec3 p = aStart + seg * position.y + side * (position.x * w);
  vUv = vec2(position.x, position.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in float vIntensity;
in float vGlow;
uniform vec3 uColor;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;

void main(){
  float r = abs(vUv.x);
  // core is a hot near-white filament, glow is a wide soft halo
  float core = exp(-r * r * 26.0);
  float halo = exp(-r * r * 2.4);
  vec3 c = mix(uColor * halo * 0.55, vec3(1.0, 0.98, 0.95) * core, 1.0 - vGlow);
  float ends = smoothstep(0.0, 0.06, vUv.y) * (1.0 - smoothstep(0.94, 1.0, vUv.y));
  oColor = vec4(c * vIntensity * 420.0 * ends, 1.0);
  oVelocity = vec4(0.0, 0.0, 1e5, 0.0);
}
`;

export class Lightning {
  constructor() {
    this.bolts = [];
    this.time = 0;
    this.ambientFlash = 0;
    this._tmp = new THREE.Vector3();

    const geom = new THREE.InstancedBufferGeometry();
    // a quad per segment: x = across, y = along, z = 0 core / 1 glow layer
    const quad = new Float32Array([
      -1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 0, 0, 1, 1, 0, -1, 1, 0,
      -1, 0, 1, 1, 0, 1, 1, 1, 1, -1, 0, 1, 1, 1, 1, -1, 1, 1,
    ]);
    geom.setAttribute('position', new THREE.BufferAttribute(quad, 3));

    this.aStart = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SEGMENTS * 3), 3);
    this.aEnd = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SEGMENTS * 3), 3);
    this.aWidth = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SEGMENTS * 2), 2);
    this.aLife = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SEGMENTS * 2), 2);
    for (const a of [this.aStart, this.aEnd, this.aWidth, this.aLife]) a.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aStart', this.aStart);
    geom.setAttribute('aEnd', this.aEnd);
    geom.setAttribute('aWidth', this.aWidth);
    geom.setAttribute('aLife', this.aLife);
    geom.instanceCount = 0;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.RawShaderMaterial({
      name: 'Lightning',
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCamPos: U.uCamPos,
        uColor: U.uLightningColor,
        uBoltState: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.geom = geom;
    this.segCount = 0;
  }

  /**
   * @param {number} count how many strikes to schedule over the next seconds
   * @param {object} [opts] { radius, cloudBase, spread }
   */
  burst(count, opts = {}) {
    const radius = opts.radius ?? 3200;
    const base = opts.cloudBase ?? 1400;
    for (let i = 0; i < count; i++) {
      const delay = Math.random() * (opts.window ?? 3.0);
      const a = Math.random() * Math.PI * 2;
      const r = radius * (0.25 + Math.random() * 0.95);
      this.schedule(Math.cos(a) * r, Math.sin(a) * r, base * (0.85 + Math.random() * 0.5), delay);
    }
  }

  schedule(x, z, top, delay) {
    this._pending = this._pending || [];
    this._pending.push({ x, z, top, at: this.time + delay });
  }

  strike(x, z, top) {
    if (this.bolts.length >= 3) this.bolts.shift();
    const segments = [];
    const start = new THREE.Vector3(x, top, z);
    const end = new THREE.Vector3(
      x + (Math.random() - 0.5) * top * 0.5, 0,
      z + (Math.random() - 0.5) * top * 0.5,
    );
    this._grow(segments, start, end, top * 0.42, 0, 1.0);

    // a few in-cloud spider branches for the anvil crawl
    const crawl = 2 + (Math.random() * 3 | 0);
    for (let i = 0; i < crawl; i++) {
      const a = Math.random() * Math.PI * 2;
      const len = top * (0.5 + Math.random());
      const s = new THREE.Vector3(x, top * (1.0 + Math.random() * 0.25), z);
      const e = new THREE.Vector3(x + Math.cos(a) * len, top * (1.05 + Math.random() * 0.3), z + Math.sin(a) * len);
      this._grow(segments, s, e, len * 0.3, 2, 0.45);
    }

    // return strokes: 1-4 flashes, each dimmer and shorter than the last
    const strokes = 1 + (Math.random() * 3 | 0);
    const flashes = [];
    let t = 0;
    for (let i = 0; i < strokes; i++) {
      flashes.push({ at: t, dur: 0.035 + Math.random() * 0.09, amp: Math.pow(0.62, i) });
      t += 0.04 + Math.random() * 0.11;
    }

    this.bolts.push({
      segments, flashes, born: this.time, life: t + 0.35,
      pos: new THREE.Vector3(x, top * 0.35, z), intensity: 0,
    });
    this._dirty = true;
  }

  /** Recursive midpoint displacement with forking, the classic bolt shape. */
  _grow(out, a, b, jitter, depth, fade) {
    if (out.length > MAX_SEGMENTS - 8) return;
    if (depth > 5 || a.distanceTo(b) < 40) {
      out.push({ a: a.clone(), b: b.clone(), fade });
      return;
    }
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a).normalize();
    // displace perpendicular to the channel
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
    perp.normalize();
    const up = new THREE.Vector3().crossVectors(dir, perp);
    mid.addScaledVector(perp, (Math.random() - 0.5) * jitter);
    mid.addScaledVector(up, (Math.random() - 0.5) * jitter);

    this._grow(out, a, mid, jitter * 0.55, depth + 1, fade);
    this._grow(out, mid, b, jitter * 0.55, depth + 1, fade);

    // fork: a shorter dead-end branch that fades out
    if (depth < 3 && Math.random() < 0.42) {
      const len = a.distanceTo(b) * (0.35 + Math.random() * 0.45);
      const bd = dir.clone()
        .addScaledVector(perp, (Math.random() - 0.5) * 1.5)
        .addScaledVector(up, (Math.random() - 0.5) * 1.5)
        .normalize();
      const tip = mid.clone().addScaledVector(bd, len);
      this._grow(out, mid, tip, jitter * 0.5, depth + 2, fade * 0.5);
    }
  }

  update(dt, time, weather) {
    this.time = time;

    if (this._pending?.length) {
      for (let i = this._pending.length - 1; i >= 0; i--) {
        if (this._pending[i].at <= time) {
          const p = this._pending.splice(i, 1)[0];
          this.strike(p.x, p.z, p.top);
        }
      }
    }

    // ambient sheet lightning inside the cloud deck, driven by the storm rate
    const rate = weather?.lightningRate ?? 0;
    if (rate > 0 && Math.random() < rate * dt * 0.9) {
      this.ambientFlash = Math.max(this.ambientFlash, 0.35 + Math.random() * 0.9);
    }
    this.ambientFlash *= Math.exp(-dt * 5.5);

    let anyDirty = false;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const age = time - b.born;
      if (age > b.life) { this.bolts.splice(i, 1); anyDirty = true; continue; }
      let amp = 0;
      for (const f of b.flashes) {
        const u = (age - f.at) / f.dur;
        if (u >= 0 && u <= 1) {
          // fast rise, exponential decay, with a flicker on top
          const env = Math.pow(1 - u, 1.7) * (0.75 + 0.25 * Math.sin(u * 61.0));
          amp = Math.max(amp, f.amp * env);
        }
      }
      // faint afterglow of the ionised channel
      amp = Math.max(amp, Math.exp(-age * 7.0) * 0.05);
      b.intensity = amp;
    }
    if (anyDirty) this._dirty = true;
    if (this._dirty) this._rebuild();

    const st = this.material.uniforms.uBoltState.value;
    for (let i = 0; i < 4; i++) {
      const b = this.bolts[i];
      st[i].set(0, 0, 0, b ? b.intensity : 0);
    }

    // push the two strongest strikes to everything that lights from them
    const sorted = [...this.bolts].sort((a, b) => b.intensity - a.intensity);
    for (let i = 0; i < 2; i++) {
      const u = i === 0 ? U.uLightning0 : U.uLightning1;
      const b = sorted[i];
      if (b && b.intensity > 0.001) u.value.set(b.pos.x, b.pos.y, b.pos.z, b.intensity);
      else u.value.set(0, 0, 0, 0);
    }
    U.uAmbientFlash.value = this.ambientFlash + (sorted[0]?.intensity ?? 0) * 0.55;
    this.mesh.visible = this.bolts.length > 0;
  }

  _rebuild() {
    this._dirty = false;
    let n = 0;
    const s = this.aStart.array, e = this.aEnd.array;
    const w = this.aWidth.array, l = this.aLife.array;
    for (let bi = 0; bi < this.bolts.length && bi < 4; bi++) {
      for (const seg of this.bolts[bi].segments) {
        if (n >= MAX_SEGMENTS) break;
        s[n * 3] = seg.a.x; s[n * 3 + 1] = seg.a.y; s[n * 3 + 2] = seg.a.z;
        e[n * 3] = seg.b.x; e[n * 3 + 1] = seg.b.y; e[n * 3 + 2] = seg.b.z;
        w[n * 2] = 2.2 * seg.fade; w[n * 2 + 1] = 26.0 * seg.fade;
        l[n * 2] = bi; l[n * 2 + 1] = seg.fade;
        n++;
      }
    }
    this.segCount = n;
    this.geom.instanceCount = n;
    for (const a of [this.aStart, this.aEnd, this.aWidth, this.aLife]) a.needsUpdate = true;
  }
}
