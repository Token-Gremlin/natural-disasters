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

export class Quality {
  constructor(name = 'high') {
    this.setPreset(name);
    this.adaptive = true;
    this.targetMs = 17.5;
    this.dynamicScale = 1.0;
    this._acc = 0;
    this._count = 0;
    this._cooldown = 0;
    this.history = new Float32Array(90);
    this.historyIndex = 0;
    this.onDowngrade = null;
  }

  setPreset(name) {
    this.presetName = PRESETS[name] ? name : 'high';
    Object.assign(this, PRESETS[this.presetName]);
    this.dynamicScale = 1.0;
    this._cooldown = 2.0;
  }

  get effectiveScale() { return this.renderScale * this.dynamicScale; }

  /**
   * Closed loop on frame time. Resolution moves first; if we bottom out and
   * are still slow, drop a whole preset tier.
   */
  tick(dtMs) {
    this.history[this.historyIndex % this.history.length] = dtMs;
    this.historyIndex++;
    if (!this.adaptive) return false;

    this._acc += dtMs; this._count++;
    this._cooldown -= dtMs / 1000;
    if (this._count < 24) return false;

    const avg = this._acc / this._count;
    this._acc = 0; this._count = 0;
    if (this._cooldown > 0) return false;

    const prev = this.dynamicScale;
    if (avg > this.targetMs * 1.25) {
      if (this.dynamicScale <= 0.56 && this.onDowngrade) {
        const order = ['ultra', 'high', 'medium', 'low', 'potato'];
        const i = order.indexOf(this.presetName);
        if (i >= 0 && i < order.length - 1) {
          this.onDowngrade(order[i + 1]);
          this._cooldown = 4.0;
          return true;
        }
      }
      this.dynamicScale = Math.max(0.5, this.dynamicScale - 0.09);
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
