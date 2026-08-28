/**
 * Adaptive quality regression: how long does the loop take to rescue a frame
 * rate it cannot sustain?
 *
 * Pure logic, no GPU, so CI can run it. Frame cost is modelled as
 *
 *     ms = K * tierFactor * (renderScale * dynamicScale)^2
 *
 * which is the shape the real thing has: the ocean shading and the cloud march
 * are both per-pixel, and pixel count goes with the square of the scale.
 *
 *   node tools/quality-sim.mjs
 */
import { Quality, TIERS } from '../src/core/Quality.js';

// Relative per-pixel cost of a tier at scale 1, from its cloud steps, ocean
// grid and particle budgets. Ultra is the reference.
const TIER_FACTOR = { ultra: 1.0, high: 0.62, medium: 0.42, low: 0.30, potato: 0.21 };
const RENDER_SCALE = { ultra: 1.0, high: 1.0, medium: 0.85, low: 0.72, potato: 0.6 };

const PLAYABLE_MS = 25;   // 40 fps: the point where a tab stops feeling broken
const GIVE_UP_S = 180;

/** Run the loop against a machine that cannot afford the starting preset. */
function simulate(q, K, label) {
  q.onDowngrade = (name, scale = 1.0) => q.setPreset(name, scale);

  let t = 0;
  let firstCorrection = null;
  let playable = null;
  let worst = 0;

  while (t < GIVE_UP_S) {
    const ms = K * TIER_FACTOR[q.presetName]
             * Math.pow(RENDER_SCALE[q.presetName] * q.dynamicScale, 2);
    worst = Math.max(worst, ms);

    const before = `${q.presetName}@${q.dynamicScale.toFixed(2)}`;
    q.tick(ms);
    const after = `${q.presetName}@${q.dynamicScale.toFixed(2)}`;

    t += ms / 1000;
    if (firstCorrection === null && before !== after) firstCorrection = t;
    if (playable === null && ms <= PLAYABLE_MS) playable = t;
    if (playable !== null && t > playable + 5) break;
  }

  const fmt = (x) => (x === null ? '  never' : `${x.toFixed(1).padStart(6)}s`);
  console.log(
    `${label.padEnd(10)} first correction ${fmt(firstCorrection)}` +
    `   playable ${fmt(playable)}   settled at ${q.presetName}@${q.dynamicScale.toFixed(2)}`);
  return { firstCorrection, playable };
}

/** The loop as it shipped before the fix, for comparison. */
class LegacyQuality extends Quality {
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
    if (avg > this.targetMs * 1.25) {
      if (this.dynamicScale <= 0.56 && this.onDowngrade) {
        const i = TIERS.indexOf(this.presetName);
        if (i >= 0 && i < TIERS.length - 1) {
          this.onDowngrade(TIERS[i + 1]);
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
    return true;
  }
}

let failed = 0;

for (const [name, K] of [['1 fps', 900], ['4 fps', 250], ['15 fps', 66]]) {
  console.log(`\n--- ultra on hardware that renders it at ${name} ---`);
  simulate(new LegacyQuality('ultra'), K, 'before');
  const after = simulate(new Quality('ultra'), K, 'after');

  // The whole point of the change: a catastrophic frame rate has to be caught
  // in seconds, not in the minute it takes to gather 24 frames five times over.
  if (after.playable === null || after.playable > 12) {
    console.log(`  FAIL: took ${after.playable ?? 'forever'} to reach ${PLAYABLE_MS} ms`);
    failed++;
  }
}

// A machine that can hold the preset must be left alone; an adaptive loop that
// downgrades a healthy 60 fps scene is worse than no loop at all.
console.log('\n--- healthy 60 fps, must not be touched ---');
{
  const q = new Quality('high');
  q.onDowngrade = (n, s = 1.0) => q.setPreset(n, s);
  for (let i = 0; i < 600; i++) q.tick(16.6);
  const ok = q.presetName === 'high' && q.dynamicScale > 0.99;
  console.log(`  settled at ${q.presetName}@${q.dynamicScale.toFixed(2)}  ${ok ? 'ok' : 'FAIL'}`);
  if (!ok) failed++;
}

// One pathological frame in an otherwise fine window is a shader compile, not a
// trend. Reacting to it costs the user quality they did not need to lose.
console.log('\n--- healthy 60 fps with a single 2 s compile hitch ---');
{
  const q = new Quality('high');
  q.onDowngrade = (n, s = 1.0) => q.setPreset(n, s);
  for (let i = 0; i < 300; i++) q.tick(i === 150 ? 2000 : 16.6);
  const ok = q.presetName === 'high';
  console.log(`  settled at ${q.presetName}@${q.dynamicScale.toFixed(2)}  ${ok ? 'ok' : 'FAIL'}`);
  if (!ok) failed++;
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
