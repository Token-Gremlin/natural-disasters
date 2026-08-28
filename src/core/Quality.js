export const PRESETS = {
  potato: {
    label: 'POTATO', renderScale: 0.6, maxPixelRatio: 1.0,
    oceanGridX: 128, oceanGridY: 84, fftSize: 128,
    cloudScale: 0.32, cloudSteps: 34, cloudLightSteps: 4, cloudEnabled: true,
    sprayCount: 6000, rainCount: 9000, dof: false, motionBlur: false, taa: true,
    envSize: 128, envCloudSteps: 12, spoutSteps: 32,
  },
  low: {
    label: 'LOW', renderScale: 0.72, maxPixelRatio: 1.0,
    oceanGridX: 176, oceanGridY: 110, fftSize: 128,
    cloudScale: 0.36, cloudSteps: 48, cloudLightSteps: 5, cloudEnabled: true,
    sprayCount: 16000, rainCount: 22000, dof: true, motionBlur: true, taa: true,
    envSize: 128, envCloudSteps: 14, spoutSteps: 44,
  },
  medium: {
    label: 'MEDIUM', renderScale: 0.85, maxPixelRatio: 1.25,
    oceanGridX: 240, oceanGridY: 150, fftSize: 256,
    cloudScale: 0.45, cloudSteps: 66, cloudLightSteps: 6, cloudEnabled: true,
    sprayCount: 40000, rainCount: 48000, dof: true, motionBlur: true, taa: true,
    envSize: 256, envCloudSteps: 16, spoutSteps: 56,
  },
  high: {
    label: 'HIGH', renderScale: 1.0, maxPixelRatio: 1.5,
    oceanGridX: 340, oceanGridY: 210, fftSize: 256,
    cloudScale: 0.5, cloudSteps: 96, cloudLightSteps: 7, cloudEnabled: true,
    sprayCount: 80000, rainCount: 96000, dof: true, motionBlur: true, taa: true,
    envSize: 256, envCloudSteps: 20, spoutSteps: 72,
  },
  ultra: {
    label: 'ULTRA', renderScale: 1.0, maxPixelRatio: 2.0,
    oceanGridX: 480, oceanGridY: 300, fftSize: 256,
    cloudScale: 0.62, cloudSteps: 148, cloudLightSteps: 8, cloudEnabled: true,
    sprayCount: 150000, rainCount: 180000, dof: true, motionBlur: true, taa: true,
    envSize: 512, envCloudSteps: 26, spoutSteps: 96,
  },
};

export const TIERS = ['ultra', 'high', 'medium', 'low', 'potato'];

// Enough frames that one slow one does not decide policy...
const SAMPLE_FRAMES = 24;
// ...but never wait longer than this for them. At 60 fps the frame count is
// reached first (24 frames is about 400 ms) so this changes nothing; below
// that it closes the window early, which is the entire point of having it.
const SAMPLE_MS = 400;
// Still take a handful, so a single shader compile cannot pass as a sample.
const MIN_FRAMES = 4;

const MIN_SCALE = 0.5;
// Over budget by this much and the incremental path cannot arrive in time.
const PANIC = 4.0;

export class Quality {
  constructor(name = 'high') {
    this.setPreset(name);
    this.adaptive = true;
    this.targetMs = 17.5;
    this.dynamicScale = 1.0;
    this._acc = 0;
    this._count = 0;
    this._cooldown = 0;
    this._window = new Float32Array(SAMPLE_FRAMES);
    this._scratch = new Float32Array(SAMPLE_FRAMES);
    this.history = new Float32Array(90);
    this.historyIndex = 0;
    this.onDowngrade = null;
  }

  setPreset(name, scale = 1.0) {
    this.presetName = PRESETS[name] ? name : 'high';
    Object.assign(this, PRESETS[this.presetName]);
    this.dynamicScale = scale;
    this._cooldown = 2.0;
  }

  get effectiveScale() { return this.renderScale * this.dynamicScale; }

  /** Name of the preset n tiers cheaper, clamped to the bottom. Null if there. */
  tierBelow(n) {
    const i = TIERS.indexOf(this.presetName);
    if (i < 0) return null;
    const j = Math.min(i + n, TIERS.length - 1);
    return j > i ? TIERS[j] : null;
  }

  /** Middle frame time of the closed window; unlike the mean, outlier-proof. */
  _median(n) {
    const s = this._scratch.subarray(0, n);
    s.set(this._window.subarray(0, n));
    s.sort();
    return (n & 1) ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) * 0.5;
  }

  /**
   * Shed load in one move instead of in 9% increments. The incremental path
   * assumes there are frames to spare for the next measurement, but at four
   * times over budget each measurement costs another half second of locked
   * tab, so nibbling never arrives in time to be the thing that rescued
   * anyone. Take the resolution to the floor and skip as many tiers as the
   * overshoot implies.
   */
  _shed(ms) {
    // A tier is worth roughly a halving of cost, so the overshoot measured in
    // octaves is the number of tiers worth skipping.
    const tier = this.tierBelow(Math.max(1, Math.round(Math.log2(ms / this.targetMs))));
    if (tier && this.onDowngrade) {
      // Hand the floor scale down with it, so the rebuild allocates the small
      // targets directly rather than building full-size ones and discarding
      // them on the very next line.
      this.onDowngrade(tier, MIN_SCALE);
      this._cooldown = 3.0;
      return true;
    }

    // Already on the bottom tier; resolution is the only knob left.
    const prev = this.dynamicScale;
    this.dynamicScale = MIN_SCALE;
    this._cooldown = 2.0;
    return Math.abs(prev - this.dynamicScale) > 1e-4;
  }

  /**
   * Closed loop on frame time. Resolution moves first; if we bottom out and
   * are still slow, drop a whole preset tier.
   */
  tick(dtMs) {
    this.history[this.historyIndex % this.history.length] = dtMs;
    this.historyIndex++;
    if (!this.adaptive) return false;

    if (this._count < SAMPLE_FRAMES) this._window[this._count] = dtMs;
    this._acc += dtMs;
    this._count++;
    this._cooldown -= dtMs / 1000;

    // Close the window on frames or on wall time, whichever comes first.
    // Waiting on a fixed frame count is harmless at 60 fps and ruinous at 2:
    // the same twenty-four frames are 400 ms in one case and twelve seconds in
    // the other, and twelve seconds of frozen tab is the exact situation this
    // loop exists to escape.
    if (this._count < MIN_FRAMES) return false;
    if (this._count < SAMPLE_FRAMES && this._acc < SAMPLE_MS) return false;

    const n = this._count;
    const avg = this._acc / n;
    const med = this._median(n);
    this._acc = 0;
    this._count = 0;
    if (this._cooldown > 0) return false;

    // Panic decides on the median. A single two-second shader compile drags
    // the mean past any threshold, and discarding three quality tiers over one
    // hitch is worse than the hitch was.
    if (med > this.targetMs * PANIC) return this._shed(med);

    const prev = this.dynamicScale;
    if (avg > this.targetMs * 1.25) {
      const tier = this.tierBelow(1);
      if (this.dynamicScale <= MIN_SCALE + 0.06 && tier && this.onDowngrade) {
        this.onDowngrade(tier, 1.0);
        this._cooldown = 4.0;
        return true;
      }
      this.dynamicScale = Math.max(MIN_SCALE, this.dynamicScale - 0.09);
      this._cooldown = 0.9;
    } else if (avg < this.targetMs * 0.68) {
      this.dynamicScale = Math.min(1.0, this.dynamicScale + 0.045);
      this._cooldown = 1.5;
    }
    return Math.abs(prev - this.dynamicScale) > 1e-4;
  }

  get averageMs() {
    const n = Math.min(this.historyIndex, this.history.length);
    if (!n) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) s += this.history[i];
    return s / n;
  }
}

/** Rough GPU-class guess from the unmasked renderer string. */
export function autoDetectPreset(rendererString = '') {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'low';

  const r = String(rendererString).toLowerCase();
  const has = (...k) => k.some(x => r.includes(x));

  if (has('swiftshader', 'llvmpipe', 'software')) return 'potato';
  // discrete, recent
  if (/rtx\s*(40|50)\d\d/.test(r) || has('rtx 4090', 'rtx 4080', 'rtx 5090', 'rtx 5080')) return 'ultra';
  if (has('rtx', 'radeon rx 7', 'radeon rx 6', 'radeon rx 9', 'apple m3', 'apple m4', 'apple m2 max', 'apple m1 max', 'apple m2 pro', 'apple m3 pro')) return 'high';
  if (has('geforce', 'radeon', 'apple m1', 'apple m2', 'arc a')) return 'high';
  // Intel integrated and friends
  if (has('uhd graphics', 'hd graphics', 'iris', 'vega 3', 'vega 8', 'adreno', 'mali')) return 'low';
  if (has('intel')) return 'medium';

  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 8;
  if (mem >= 8 && cores >= 12) return 'high';
  if (mem >= 8 && cores >= 6) return 'medium';
  return 'low';
}
