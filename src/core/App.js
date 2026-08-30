import * as THREE from 'three';
import { U, updateFrameUniforms } from './SharedUniforms.js';
import { Quality, autoDetectPreset } from './Quality.js';
import { makeRT, FullScreenPass, PingPong } from '../gfx/FullScreenPass.js';
import { bakeProceduralTextures } from '../gfx/ProceduralTextures.js';
import { OceanFFT } from '../ocean/OceanFFT.js';
import { OceanMesh } from '../ocean/OceanMesh.js';
import { Atmosphere } from '../sky/Atmosphere.js';
import { SkyRenderer } from '../sky/SkyRenderer.js';
import { Clouds } from '../sky/Clouds.js';
import { Lightning } from '../weather/Lightning.js';
import { Waterspout } from '../weather/Waterspout.js';
import { Rain, Spray } from '../weather/Precipitation.js';
import { OCEAN_SAMPLE_GLSL } from '../ocean/OceanSampleGLSL.js';
import { PostFX } from '../post/PostFX.js';
import { CinematicCamera } from '../camera/CinematicCamera.js';
import { GpuProfiler } from './GpuProfiler.js';

export class App {
  constructor(canvas, onProgress = () => {}) {
    this.canvas = canvas;
    this.onProgress = onProgress;
    this.time = 0;
    this.frame = 0;
    this.running = false;
    this.paused = false;
    this._lastT = 0;
    this._projNoJitter = new THREE.Matrix4();
    this._invViewProjNJ = new THREE.Matrix4();
  }

  async init() {
    const canvas = this.canvas;
    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false, depth: true,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.debug.checkShaderErrors = true;
    this.renderer = renderer;

    const gl = renderer.getContext();
    if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 is required for this demo.');
    const extFloat = gl.getExtension('EXT_color_buffer_float');
    if (!extFloat) throw new Error('EXT_color_buffer_float is required (float render targets).');
    gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_float_blend');

    this.caps = {
      maxTexture: renderer.capabilities.maxTextureSize,
      anisotropy: renderer.capabilities.getMaxAnisotropy(),
      drawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
      renderer: (() => {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
      })(),
      webgpu: typeof navigator !== 'undefined' && !!navigator.gpu,
    };

    const params = new URLSearchParams(location.search);
    this.params = params;
    this.profiler = new GpuProfiler(renderer);
    this.profiler.enabled = params.get('profile') === '1';
    this.quality = new Quality(params.get('preset') || autoDetectPreset(this.caps.renderer));
    if (params.get('adaptive') === '0') this.quality.adaptive = false;
    this.quality.onDowngrade = (name, scale) => this.setQualityPreset(name, scale);

    this.onProgress('baking procedural textures', 0.08);
    this.textures = await bakeProceduralTextures(renderer, (m) => this.onProgress(m, 0.1));
    U.uFoamTex.value = this.textures.foam;
    U.uRippleTex.value = this.textures.ripple;
    U.uCurlTex.value = this.textures.curl;

    this.onProgress('solving wave spectrum', 0.42);
    this.ocean = new OceanFFT(renderer, { size: this.quality.fftSize });

    this.onProgress('integrating atmosphere', 0.55);
    this.atmosphere = new Atmosphere(renderer);
    this.atmosphere.buildStaticLUTs(true);

    this.onProgress('building sky', 0.62);
    this.sky = new SkyRenderer(renderer, this.atmosphere);

    this.onProgress('seeding cloud volume', 0.66);
    this.clouds = new Clouds(renderer, this.atmosphere, this.textures, this.quality);

    this.onProgress('tessellating ocean', 0.7);
    this.oceanMesh = new OceanMesh(this.ocean, this.atmosphere, this.quality, this.clouds.shared);

    this.lightning = new Lightning();
    this.waterspout = new Waterspout();
    this.waterspout.setLUTs(this.atmosphere);
    this.waterspout.setQuality(this.quality);
    this.onProgress('seeding spray', 0.76);
    this.rain = new Rain(this.quality);
    this.spray = new Spray(this.renderer, this.ocean, this.quality,
      FullScreenPass, makeRT, PingPong, OCEAN_SAMPLE_GLSL);

    this.scene = new THREE.Scene();
    this.scene.add(this.sky.mesh);
    this.scene.add(this.oceanMesh.mesh);
    this.scene.add(this.clouds.overMesh);
    this.scene.add(this.waterspout.mesh);
    this.scene.add(this.spray.mesh);
    this.scene.add(this.rain.mesh);
    this.scene.add(this.lightning.mesh);

    this.onProgress('setting up camera', 0.8);
    this.cine = new CinematicCamera(window.innerWidth / window.innerHeight);
    this.cine.attachInput(canvas);
    this.cine.seaLevelFn = () => U.uSeaLevel.value;
    this.cine.eventFloorFn = (x, z) => this.director?.eventHeight(x, z) || 0;
    this.camera = this.cine.camera;

    this.onProgress('compiling post stack', 0.86);
    this._resize(true);
    window.addEventListener('resize', () => this._resize());

    this.onProgress('warming shaders', 0.94);
    this.ocean.update(1 / 60);
    this.atmosphere.update(this.camera, this.camera.position);
    this.sky.renderEnv();
    renderer.compile(this.scene, this.camera);

    this.onProgress('ready', 1.0);
  }

  /**
   * The one way a preset changes, whether the adaptive loop asked or the user
   * clicked. Every subsystem that caches something derived from the preset has
   * to be told, and the HUD used to carry its own copy of this list that had
   * already drifted — rain, spray and the waterspout kept their old step counts
   * when a preset was picked by hand.
   */
  setQualityPreset(name, scale = 1.0) {
    this.quality.setPreset(name, scale);
    if (this.ocean && this.ocean.N !== this.quality.fftSize) {
      // The spectra are rebuilt on the next update; the mesh, spray and clouds
      // keep their materials because resize repoints the bound textures.
      this.ocean.resize(this.quality.fftSize);
    }
    this.oceanMesh?.setResolution(this.quality.oceanGridX, this.quality.oceanGridY);
    this.clouds?.setQuality(this.quality);
    this.rain?.setQuality(this.quality);
    this.spray?.setQuality(this.quality);
    this.waterspout?.setQuality(this.quality);
    this._resize(true);
    this.onQualityChange?.(this.quality.presetName);
  }

  _resize(force = false) {
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    const cssW = window.innerWidth, cssH = window.innerHeight;
    const w = Math.max(2, Math.floor(cssW * dpr * this.quality.effectiveScale));
    const h = Math.max(2, Math.floor(cssH * dpr * this.quality.effectiveScale));
    if (!force && this.renderWidth === w && this.renderHeight === h) return;
    this.renderWidth = w; this.renderHeight = h;

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(cssW, cssH, true);

    if (this.hdrRT) this.hdrRT.dispose();
    this.hdrRT = makeRT(w, h, {
      type: THREE.HalfFloatType, count: 2, depthBuffer: true,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, name: 'hdrMRT',
    });

    if (!this.post) this.post = new PostFX(this.renderer, w, h);
    else this.post.setSize(w, h);
    this.clouds?.setSize(w, h);

    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    U.uResolution.value.set(w, h);
    U.uInvResolution.value.set(1 / w, 1 / h);
  }

  start() {
    this.running = true;
    this._lastT = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const dtRaw = (t - this._lastT) / 1000;
      this._lastT = t;
      const dt = Math.min(Math.max(dtRaw, 1e-4), 0.05);
      this.frameMs = dtRaw * 1000;
      this.render(dt);
    };
    requestAnimationFrame(loop);
  }

  render(dt) {
    const scaled = this.paused ? 0 : dt * (this.timeScale ?? 1);
    this.time += scaled;
    this.frame++;

    if (this.quality.tick(this.frameMs)) this._resize();

    this.beforeUpdate?.(scaled, dt);

    const prof = this.profiler;
    this.cine.update(dt, this.time);
    prof.begin('oceanFFT');
    this.ocean.update(scaled);
    prof.end('oceanFFT');
    prof.begin('atmoLUT');
    // The aerial-perspective LUT is sampled by the clouds and the sea through
    // the unjittered matrices, so it has to be built with the same ones. The
    // projection is clean here: the jitter is only added further down.
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this._invViewProjNJ.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).invert();
    this.atmosphere.update(this.camera, this.camera.position, this._invViewProjNJ);
    prof.end('atmoLUT');
    this.atmosphere.syncUniforms(U);
    U.uAmbientColor.value.set(this.atmosphere.ambientColor.r, this.atmosphere.ambientColor.g, this.atmosphere.ambientColor.b);
    this.sky.update(this.time);
    this.lightning.update(scaled || dt * 1e-3, this.time, this.weather?.state);
    this.waterspout.update(scaled || dt * 1e-3, this.weather?.state?.cloudBottom);
    // Crests run to roughly Hs above the mean, so free flight uses that as its
    // floor and rides over the sea instead of being swallowed by it.
    this.cine.waveFloor = (this.ocean?.significantWaveHeight || 0) * 0.75;

    // Reference plane for the projected grid: the analytic event field under
    // the camera, kept clear of the eye so the ray intersection stays valid on
    // shots that are deliberately overtopped.
    const camY = this.camera.position.y - U.uSeaLevel.value;
    const localMean = this.director?.hasEvents()
      ? this.director.eventHeight(this.camera.position.x, this.camera.position.z) : 0;
    this.oceanMesh.material.uniforms.uGridPlane.value = Math.min(localMean, camY - 0.5);
    this.oceanMesh.update(this.camera.position, U.uSeaLevel.value + localMean);

    // ---- TAA jitter
    this.camera.updateProjectionMatrix();
    this._projNoJitter.copy(this.camera.projectionMatrix);
    if (this.post.settings.taa) {
      const [jx, jy] = this.post.getJitter(this.frame);
      this.camera.projectionMatrix.elements[8] += jx;
      this.camera.projectionMatrix.elements[9] += jy;
      this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
      U.uJitter.value.set(jx, jy);
    }

    updateFrameUniforms(this.camera, this._projNoJitter, dt, this.time, this.frame);
    this.afterUpdate?.(scaled, dt);

    prof.begin('particles');
    this.rain.update(this.camera, U.uRain.value, this.hdrRT.height);
    this.spray.update(scaled || dt, U.uSprayAmount.value);
    prof.end('particles');

    // clouds march against the unjittered matrices set just above
    prof.begin('clouds');
    this.clouds.update(this.time, dt);
    prof.end('clouds');
    this.sky.setCloudTextures(this.clouds.screenTexture, this.clouds.envTexture);
    prof.begin('envProbe');
    this.sky.renderEnv();
    prof.end('envProbe');

    // ---- main pass
    const r = this.renderer;
    prof.begin('scene');
    r.setRenderTarget(this.hdrRT);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    prof.end('scene');

    this.post.settings.focusDistance = this.cine.focusDistance;
    prof.begin('post');
    this.post.render(this.hdrRT.textures[0], this.hdrRT.textures[1], null);
    prof.end('post');
    prof.collect();

    if (this._debugTex && this._blit) this._blit.render(r, null);
  }

  /**
   * Freezes the camera, clock and weather so two runs are directly comparable.
   * Perf A/B tests are meaningless while the director is moving the camera.
   */
  setBenchmarkPose(index = 0) {
    const poses = [
      { pos: [0, 18, 0], look: [220, 12, -120], fov: 45 },     // eye level, to horizon
      { pos: [0, 240, 0], look: [400, 40, -260], fov: 50 },    // elevated, sees the deck
      { pos: [0, 6, 0], look: [60, 30, -40], fov: 60 },        // low, looking up at clouds
    ];
    const p = poses[index % poses.length];
    this.cine.mode = 'static';
    this.cine.director = null;
    this.camera.position.set(...p.pos);
    this.camera.lookAt(...p.look);
    this.camera.fov = p.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.cine.freeze = true;
    this.quality.adaptive = false;
    this.profiler.enabled = true;
    this.profiler.reset();
    this.post.reset = true;
  }

  /** Blits an intermediate buffer to the screen. `mode`: rgb | alpha | lum */
  setDebugTexture(tex, mode = 'rgb', scale = 1.0) {
    this._debugTex = tex;
    if (!this._blit && tex) {
      this._blit = new FullScreenPass(/* glsl */`
        uniform sampler2D uSrc;
        uniform float uMode;
        uniform float uScale;
        in vec2 vUv;
        layout(location = 0) out vec4 oColor;
        void main(){
          vec4 s = texture(uSrc, vUv) * uScale;
          vec3 c = (uMode < 0.5) ? s.rgb
                 : (uMode < 1.5) ? vec3(s.a)
                 : vec3(dot(s.rgb, vec3(0.2126, 0.7152, 0.0722)));
          oColor = vec4(pow(max(c, 0.0), vec3(1.0 / 2.2)), 1.0);
        }`, {
        uSrc: { value: null }, uMode: { value: 0 }, uScale: { value: 1 },
      }, { name: 'debugBlit' });
    }
    if (this._blit) {
      this._blit.set('uSrc', tex).set('uScale', scale)
        .set('uMode', mode === 'alpha' ? 1 : mode === 'lum' ? 2 : 0);
    }
  }

  setDebugMode(mode) {
    this.debugMode = mode;
    if (this.oceanMesh) this.oceanMesh.uniforms.uDebugMode.value = mode;
    if (this.post) {
      this.post.settings.dof = mode ? false : this.quality.dof;
      this.post.settings.bloom = mode ? false : true;
      this.post.settings.debugPassthrough = mode > 0;
    }
  }

  /** Average colour of the final image, for automated visual regression. */
  sampleFrame(nx = 8, ny = 5) {
    const gl = this.renderer.getContext();
    const w = this.canvas.width, h = this.canvas.height;
    const px = new Uint8Array(4);
    const out = [];
    for (let j = 0; j < ny; j++) {
      const row = [];
      for (let i = 0; i < nx; i++) {
        const x = Math.floor((i + 0.5) / nx * w);
        const y = Math.floor((j + 0.5) / ny * h);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        row.push([px[0], px[1], px[2]]);
      }
      out.push(row);
    }
    return out;
  }

  /** Read back the FFT cascades and report per-channel statistics. */
  probeOcean(size = 64) {
    const r = this.renderer;
    const half2float = (h) => {
      const s = (h & 0x8000) >> 15, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
      if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
      if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
      return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    const gl = r.getContext();
    const props = r.properties;
    const stat = (rt, texIndex, label) => {
      const w = Math.min(size, rt.width), h = Math.min(size, rt.height);
      const buf = new Uint16Array(w * h * 4);
      try {
        // three has no MRT-aware readback, so drive readBuffer directly
        const fb = props.get(rt).__webglFramebuffer;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + texIndex);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.HALF_FLOAT, buf);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        r.state.reset();
      } catch (e) { return { label, error: String(e) }; }
      const mn = [1e9, 1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9, -1e9], sum = [0, 0, 0, 0];
      for (let i = 0; i < w * h; i++) {
        for (let c = 0; c < 4; c++) {
          const v = half2float(buf[i * 4 + c]);
          if (v < mn[c]) mn[c] = v;
          if (v > mx[c]) mx[c] = v;
          sum[c] += v;
        }
      }
      const n = w * h;
      return {
        label,
        min: mn.map(v => +v.toFixed(4)),
        max: mx.map(v => +v.toFixed(4)),
        avg: sum.map(v => +(v / n).toFixed(4)),
      };
    };
    const out = [];
    this.ocean.cascades.forEach((c, i) => {
      out.push(stat(c.out, 0, `c${i}.disp(xyz,J)`));
      out.push(stat(c.out, 1, `c${i}.deriv`));
      out.push(stat(c.out, 2, `c${i}.turb(foam,bub,crest,spray)`));
    });
    return out;
  }

  /**
   * Reads back the pre-tonemap HDR buffer and reports scene radiance by
   * screen band. Without this, any brightness bug is pure guesswork.
   */
  probeHDR(nx = 9, ny = 7) {
    const r = this.renderer;
    const rt = this.hdrRT;
    const half2float = (h) => {
      const s = (h & 0x8000) >> 15, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
      if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
      if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
      return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    const buf = new Uint16Array(4);
    const rows = [];
    for (let j = ny - 1; j >= 0; j--) {
      const cells = [];
      for (let i = 0; i < nx; i++) {
        const x = Math.floor((i + 0.5) / nx * rt.width);
        const y = Math.floor((j + 0.5) / ny * rt.height);
        try { r.readRenderTargetPixels(rt, x, y, 1, 1, buf); } catch { cells.push('   err'); continue; }
        const rr = half2float(buf[0]), gg = half2float(buf[1]), bb = half2float(buf[2]);
        const lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
        cells.push(lum >= 1e4 ? lum.toExponential(1).padStart(7)
          : lum.toFixed(lum < 10 ? 3 : 1).padStart(7));
      }
      rows.push(cells.join(' '));
    }
    return rows;
  }

  /**
   * Reads the cloud marcher's diagnostic target: how far the first hit was,
   * the peak density found, and how many taps the ray actually spent.
   */
  probeClouds(nx = 7, ny = 5) {
    const c = this.clouds;
    if (!c?.history) return null;
    const r = this.renderer;
    const gl = r.getContext();
    const fb = r.properties.get(c.history.read).__webglFramebuffer;
    const half2float = (h) => {
      const s = (h & 0x8000) >> 15, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
      if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
      if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
      return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    const buf = new Uint16Array(4);
    const rows = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    for (let j = ny - 1; j >= 0; j--) {
      const cells = [];
      for (let i = 0; i < nx; i++) {
        const x = Math.floor((i + 0.5) / nx * c.lowW);
        const y = Math.floor((j + 0.5) / ny * c.lowH);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.HALF_FLOAT, buf);
        const d = half2float(buf[0]), shape = half2float(buf[1]);
        const base = half2float(buf[2]), inside = half2float(buf[3]);
        cells.push(`${(d > 0 ? (d / 1000).toFixed(0) : '-').padStart(4)}k s${shape.toFixed(2)} b${base.toFixed(2)} n${inside | 0}`);
      }
      rows.push(cells.join(' '));
    }
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    r.state.reset();
    return rows;
  }

  /**
   * Reads the whole spray particle state back and summarises it: how many
   * texels are actually alive, where they are relative to the camera, and how
   * fast they are moving. Cheap enough for a diagnostic, far too slow per frame.
   */
  probeSpray() {
    const s = this.spray?.state;
    if (!s) return null;
    const n = this.spray.size;
    const pos = new Float32Array(n * n * 4);
    const vel = new Float32Array(n * n * 4);
    // r169's readRenderTargetPixels has no MRT attachment argument, so bind the
    // framebuffer directly and pick the colour attachment by hand.
    const gl = this.renderer.getContext();
    const fb = this.renderer.properties.get(s.read).__webglFramebuffer;
    if (!fb) return { error: 'no framebuffer' };
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, pos);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, vel);
    } catch (e) { return { error: String(e) }; }
    finally {
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.renderer.state.reset();
    }
    let live = 0, nan = 0, sumY = 0, sumSpeed = 0, minY = 1e9, maxY = -1e9, maxD = 0;
    const cam = U.uCamPos.value;
    for (let i = 0; i < n * n; i++) {
      const x = pos[i * 4], y = pos[i * 4 + 1], z = pos[i * 4 + 2], age = pos[i * 4 + 3];
      if (!Number.isFinite(x + y + z + age)) { nan++; continue; }
      if (!(age > 0)) continue;
      live++;
      sumY += y; minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      maxD = Math.max(maxD, Math.hypot(x - cam.x, z - cam.z));
      sumSpeed += Math.hypot(vel[i * 4], vel[i * 4 + 1], vel[i * 4 + 2]);
    }
    return {
      total: n * n, live, nan,
      pct: +(100 * live / (n * n)).toFixed(1),
      avgY: live ? +(sumY / live).toFixed(2) : 0,
      minY: live ? +minY.toFixed(2) : 0,
      maxY: live ? +maxY.toFixed(2) : 0,
      maxDist: +maxD.toFixed(0),
      avgSpeed: live ? +(sumSpeed / live).toFixed(2) : 0,
      camY: +cam.y.toFixed(2),
    };
  }

  /** Diagnostics used by tools/smoke.mjs — reads back a few GPU values. */
  debugStats() {
    const r = this.renderer;
    const buf = new Float32Array(4);
    try {
      r.readRenderTargetPixels(this.post.exposureRT.read, 0, 0, 1, 1, buf);
    } catch (e) { /* ignore */ }
    const lum = new Float32Array(4);
    try {
      const last = this.post.lumChain[this.post.lumChain.length - 1];
      r.readRenderTargetPixels(last, 0, 0, 1, 1, lum);
    } catch (e) { /* ignore */ }
    return {
      exposure: buf[0],
      logLum: lum[0],
      avgLum: Math.exp(lum[0]),
      oceanTris: this.oceanMesh?.triangles,
      preset: this.quality.presetName,
      dyn: this.quality.dynamicScale,
      rain: +U.uRain.value.toFixed(3),
      rainDrops: this.rain?.geom.instanceCount ?? 0,
      spray: +U.uSprayAmount.value.toFixed(3),
      sprayLive: this.spray?.mesh.visible ? this.spray.size ** 2 : 0,
      spout: this.waterspout ? {
        on: this.waterspout.active,
        vis: this.waterspout.mesh.visible,
        life: +this.waterspout.life.toFixed(1),
        u: [...this.waterspout.uniforms.uSpout.value.toArray()].map(v => +v.toFixed(1)),
        shape: [...this.waterspout.uniforms.uShape.value.toArray()].map(v => +v.toFixed(1)),
        dbg: this.waterspout.uniforms.uDebug.value,
        inScene: this.scene.children.includes(this.waterspout.mesh),
        matDbg: this.waterspout.material.uniforms.uDebug.value,
      } : null,
      cloudBase: this.weather?.state?.cloudBottom,
      cam: [this.camera.position.x, this.camera.position.y, this.camera.position.z].map(v => +v.toFixed(1)),
      camFloor: +(this.cine._floor ?? 0).toFixed(1),
      free: this.cine.free,
      sandboxOn: !!this.sandbox?.active,
      dirOn: this.director?.enabled,
      eventH: +(this.director?.eventHeight(this.camera.position.x, this.camera.position.z) || 0).toFixed(1),
      soliton: this.director?._solitons?.map(s => ({ d: +s.dist.toFixed(0), a: +s.amp.toFixed(1), w: s.width })),
      eventProfile: (() => {
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const h = Math.hypot(f.x, f.z) || 1;
        const p = this.camera.position;
        return [40, 80, 120, 160, 220, 300, 420].map(d =>
          +(this.director?.eventHeight(p.x + (f.x / h) * d, p.z + (f.z / h) * d) || 0).toFixed(1));
      })(),
    };
  }
}
