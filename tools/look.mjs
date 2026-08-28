/**
 * Emit the CDP expression that poses the demo for a given look, so the browser
 * driver does not have to carry a wall of inlined JavaScript every iteration.
 *
 *   node tools/look.mjs sky        -- clear day, camera up toward the sun
 *   node tools/look.mjs sea        -- clear day, camera down onto the water
 *   node tools/look.mjs storm sky
 */
const LOOKS = {
  sky:   { cond: 'clear',  y: 45,  pitch: 0.30,  yawOff: 0.55, fov: 48 },
  sea:   { cond: 'clear',  y: 45,  pitch: -0.16, yawOff: 0.60, fov: 55 },
  high:  { cond: 'clear',  y: 320, pitch: -0.22, yawOff: 0.60, fov: 60 },
  storm: { cond: 'squall', y: 40,  pitch: 0.16,  yawOff: 0.40, fov: 52 },
  gold:  { cond: 'golden', y: 30,  pitch: 0.05,  yawOff: 0.10, fov: 50 },
};

const name = process.argv[2] || 'sky';
const L = LOOKS[name];
if (!L) { console.error(`unknown look: ${name}. try ${Object.keys(LOOKS).join(', ')}`); process.exit(1); }

process.stdout.write(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) { if (window.__app && window.__app.running) break; await w(500); }
  const a = window.__app;
  const e = document.getElementById('booterr')?.textContent;
  if (e) return { err: e };
  a.sandbox.setActive(true);
  a.sandbox.applyCondition('${L.cond}', true);
  await w(500);
  const sd = a.clouds.shared.uSunDir.value;
  a.camera.position.set(0, ${L.y}, 0);
  a.cine._freePos.set(0, ${L.y}, 0);
  a.cine.yaw = Math.atan2(-sd.x, -sd.z) + ${L.yawOff};
  a.cine.pitch = ${L.pitch};
  a.cine._vantage = null; a.cine._ceiling = null;
  a.cine.setZoom(${L.fov});
  a.profiler.enabled = true; a.profiler.reset();
  await w(5000);
  return {
    ms: +a.quality.averageMs.toFixed(1),
    hide: +a.clouds._blockHide.toFixed(3),
    zones: a.profiler.report().zones.map(z => z.name + ' ' + z.ms.toFixed(2)),
  };
})()`);
