/**
 * Sandbox harness: boots the demo, switches to the interactive mode, poses the
 * camera, fires one of the event buttons and photographs the result.
 *
 * The plain smoke test cannot do this. Its screenshots are keyed to wall clock
 * while the events it is trying to catch move at metres per second along the
 * view axis, so a shot lands wherever it lands and a missing wave is
 * indistinguishable from a mistimed shutter. Here every frame is stamped with
 * the state that produced it: camera pose, and the analytic event height
 * sampled straight down the sight line. A blank photograph next to a 40 m
 * reading is a rendering bug; a blank photograph next to a flat profile is not.
 *
 *   node tools/sb.mjs --tag tsu --do tsunami --at 3 --shots 8,10,12
 *   node tools/sb.mjs --tag hur --do hurricane --cond storm --pose 0,60,0,0,-0.1,-1
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

const url = getArg('url', 'http://localhost:5173/?preset=medium&adaptive=0');
const tag = getArg('tag', 'sb');
const action = getArg('do', '');
const cond = getArg('cond', '');
const fireAt = parseFloat(getArg('at', '3'));
const shots = (getArg('shots', '6,9,12,15') || '').split(',').filter(Boolean).map(Number);
const pose = (getArg('pose', '') || '').split(',').filter(Boolean).map(Number);
const probeEvery = parseFloat(getArg('probe', '0.5'));
const outDir = path.resolve('tools/shots');
fs.mkdirSync(outDir, { recursive: true });

// A real window on a real GPU, because headless Chrome falls back to
// SwiftShader and then neither the frame times nor the filtering resemble what
// anyone will actually see. It does not have to be a window in your face
// though: parked off the desktop it renders identically and stays out of the
// way. Pass --show when you want to watch it work.
const showWindow = has('show');
const browser = await puppeteer.launch({
  headless: false,
  args: [
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization', process.platform === 'win32' ? '--use-angle=d3d11' : '--use-angle=metal',
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    '--no-sandbox', '--disable-dev-shm-usage',
    // Chrome suspends requestAnimationFrame in a window it thinks nobody is
    // looking at, which here means the simulation silently sits at time zero
    // and every measurement comes back flat. Doubly required off-screen.
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=1600,940',
    showWindow ? '--window-position=40,40' : '--window-position=-2400,-2400',
  ],
  defaultViewport: { width: 1600, height: 900 },
});

const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: e.stack || String(e) }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
// Chrome throttles rAF in a window that is not frontmost, which stops the
// simulation dead between synthetic events and makes every measured delta zero.
await page.bringToFront();

let booted = false;
for (let i = 0; i < 90; i++) {
  await sleep(500);
  const s = await page.evaluate(() => ({
    ok: !!(window.__app && window.__app.running),
    err: document.getElementById('booterr')?.textContent || '',
  })).catch(() => ({ ok: false, err: '' }));
  if (s.err) { console.log('BOOT ERROR:\n' + s.err); break; }
  if (s.ok) { booted = true; console.log(`> booted after ${(i + 1) * 0.5}s`); break; }
}
if (!booted) {
  // Without this a failed boot is a silent exit code, which is the worst
  // possible thing for a shader change to produce.
  console.log('> never booted; console follows');
  for (const l of logs.slice(0, 12)) console.log(`[${l.type}] ${l.text.slice(0, 4000)}`);
  await browser.close();
  process.exit(1);
}

// The probe has to run inside the page: the event fields live on the director
// and the only honest way to ask "is there a wave in front of the lens" is to
// evaluate the same function the vertex shader mirrors.
await page.evaluate(() => {
  window.__probe = () => {
    const a = window.__app, c = a.camera, d = a.director;
    // Forward is the negated third column of the world matrix, which avoids
    // needing a THREE handle inside the page.
    const e = c.matrixWorld.elements;
    const f = { x: -e[8], y: -e[9], z: -e[10] };
    const h = Math.hypot(f.x, f.z) || 1;
    const fx = f.x / h, fz = f.z / h;
    const prof = [];
    for (let r = 0; r <= 1600; r += 100) {
      prof.push(+d.eventHeight(c.position.x + fx * r, c.position.z + fz * r).toFixed(1));
    }
    const sol = d._solitons[0];
    return {
      t: +a.time.toFixed(2),
      ms: +(a.quality?.averageMs ?? 0).toFixed(1),
      cam: [c.position.x, c.position.y, c.position.z].map(v => +v.toFixed(1)),
      fov: +c.fov.toFixed(1),
      pitch: +(Math.asin(f.y) * 180 / Math.PI).toFixed(1),
      floor: +(a.cine._floor ?? 0).toFixed(1),
      here: +d.eventHeight(c.position.x, c.position.z).toFixed(1),
      prof,
      sol: sol ? { amp: +sol.amp.toFixed(1), dist: +sol.dist.toFixed(0), w: sol.width,
        ahead: +(sol.dist - (c.position.x * sol.dir[0] + c.position.z * sol.dir[1])).toFixed(0) } : null,
    };
  };
});

if (pose.length >= 6) {
  await page.evaluate((p) => {
    const a = window.__app;
    a.camera.position.set(p[0], p[1], p[2]);
    a.cine.yaw = Math.atan2(-p[3], -p[5]);
    a.cine.pitch = Math.asin(p[4] / Math.hypot(p[3], p[4], p[5]));
    a.cine._freePos.set(p[0], p[1], p[2]);
  }, pose);
}

// The controls run has to start from the state a visitor lands in, since half
// of what it checks is the way into sandbox mode and back out again.
if (!has('controls')) {
  await page.evaluate(() => window.__app.sandbox.setActive(true));
  console.log('> sandbox on');
}
if (cond) {
  await page.evaluate((c) => window.__app.sandbox.applyCondition(c, true), cond);
  console.log(`> condition ${cond}`);
}
if (pose.length >= 6) {
  // setActive inherits the previous framing, so the pose has to be reasserted
  await page.evaluate((p) => {
    const a = window.__app;
    a.camera.position.set(p[0], p[1], p[2]);
    a.cine._freePos.set(p[0], p[1], p[2]);
    a.cine.yaw = Math.atan2(-p[3], -p[5]);
    a.cine.pitch = Math.asin(p[4] / Math.hypot(p[3], p[4], p[5]));
  }, pose);
}

const trace = [];
const t0 = Date.now();
const wall = () => (Date.now() - t0) / 1000;

// A screenshot costs a second or two of wall clock and the simulation keeps
// running underneath it, so a crest closing at sixty metres a second is a
// hundred metres past where the probe said it was by the time the shutter
// closes. Freezing time first is the difference between photographing the
// event and photographing the moment after it.
// --nohud — take the overlay out of the picture entirely. Its panels carry a
// backdrop-filter, which Chrome resolves by blurring and dithering whatever is
// behind them, and the edge of that region is a hard vertical line across the
// frame. Judging shading through it means arguing about an artefact the
// renderer never produced.
const hideHud = has('nohud');
const shoot = async (file) => {
  await page.evaluate((hide) => {
    window.__app.paused = true;
    if (!hide) return;
    for (const el of document.body.children) {
      if (el.id === 'gl' || el.tagName === 'SCRIPT') continue;
      el.dataset.sbDisp = el.style.display;
      el.style.display = 'none';
    }
  }, hideHud);
  await sleep(120);
  await page.screenshot({ path: file });
  await page.evaluate((hide) => {
    if (hide) {
      for (const el of document.body.children) {
        if (el.dataset.sbDisp === undefined) continue;
        el.style.display = el.dataset.sbDisp;
        delete el.dataset.sbDisp;
      }
    }
    window.__app.paused = false;
  }, hideHud);
};

// --controls — drive the actual input path rather than the methods behind it.
// Calling sandbox.tsunami() from the console proves the event works; it proves
// nothing about whether the button, the key or the mouse reach it.
if (has('controls')) {
  const state = () => page.evaluate(() => {
    const a = window.__app, c = a.camera;
    return {
      pos: [c.position.x, c.position.y, c.position.z].map(v => +v.toFixed(1)),
      fov: +c.fov.toFixed(1), yaw: +a.cine.yaw.toFixed(3), pitch: +a.cine.pitch.toFixed(3),
      free: a.cine.free, dir: a.director.enabled, sb: a.sandbox.active,
      spd: +a.cine.freeSpeed.toFixed(1),
      rain: +a.weather.target.rain.toFixed(2), events: a.director.hasEvents(),
    };
  });
  let prev = null;
  const step = async (label, fn, settle = 900) => {
    await fn();
    await sleep(settle);
    const s = await state();
    // The deltas are the whole point: an absolute position tells you nothing
    // about whether the key that was just pressed did anything.
    const d = prev
      ? ` d=[${s.pos.map((v, i) => (v - prev.pos[i]).toFixed(1)).join(',')}]`
        + ` dfov=${(s.fov - prev.fov).toFixed(1)} dyaw=${(s.yaw - prev.yaw).toFixed(3)}`
      : '';
    console.log(`${label.padEnd(22)} ${JSON.stringify(s)}${d}`);
    prev = s;
    return s;
  };
  const hold = async (key, ms) => {
    await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key);
  };
  // Sit the cursor over open water, away from both HUD panels, so the wheel
  // and the drag-look are tested where a user would actually use them.
  await page.mouse.move(800, 470);

  await sleep(2500);
  await step('initial (cinematic)', async () => {});
  await step('C -> sandbox', () => page.keyboard.press('c'));
  await step('W forward 1.2s', () => hold('w', 1200));
  await step('D strafe 0.8s', () => hold('d', 800));
  await step('S back 0.8s', () => hold('s', 800));
  await step('A strafe 0.8s', () => hold('a', 800));
  await step('Space climb 2s', () => hold(' ', 2000));
  await step('Q descend 1.2s', () => hold('q', 1200));
  await step('Shift+W sprint 1s', async () => {
    await page.keyboard.down('Shift'); await hold('w', 1000); await page.keyboard.up('Shift');
  });
  await step('drag look right', async () => {
    await page.mouse.down();
    for (let i = 0; i < 12; i++) await page.mouse.move(800 + i * 12, 470);
    await page.mouse.up();
    // The click grabbed the pointer; release it or every later mouse.move is
    // swallowed by the lock and the HUD tests below aim at nothing.
    await page.evaluate(() => document.exitPointerLock?.());
    await page.mouse.move(800, 470);
  });
  await step('wheel zoom in', () => page.mouse.wheel({ deltaY: -600 }));
  await step('wheel zoom out', () => page.mouse.wheel({ deltaY: 900 }));
  await step('ctrl+wheel speed', async () => {
    await page.keyboard.down('Control');
    await page.mouse.wheel({ deltaY: -300 });
    await page.keyboard.up('Control');
  });
  await step('wheel over HUD panel', async () => {
    await page.mouse.move(110, 400);
    await page.mouse.wheel({ deltaY: -300 });
    await page.mouse.move(800, 470);
  });
  await step('key 2 (rain)', () => page.keyboard.press('2'));
  await step('key 4 (maelstrom)', () => page.keyboard.press('4'));
  await step('key 0 (calm all)', () => page.keyboard.press('0'));
  await step('click CLEAR DAY', () => page.evaluate(() => {
    [...document.querySelectorAll('.sb-btn')].find(b => b.textContent.includes('CLEAR')).click();
  }));
  // Straight after a click, to catch the focused button eating the space bar.
  await step('Space after click', () => hold(' ', 1000));
  await step('click TSUNAMI button', () => page.evaluate(() => {
    [...document.querySelectorAll('.sb-act')].find(b => b.textContent.includes('TSUNAMI')).click();
  }), 6000);
  await shoot(path.join(outDir, `${tag}-controls.png`));
  await step('C -> cinematic', () => page.keyboard.press('c'));
  await step('click mode toggle', () => page.click('#modeToggle'));

  const errsC = logs.filter(l => l.type === 'error' || l.type === 'pageerror');
  for (const e of errsC.slice(0, 4)) console.log(`[${e.type}] ${e.text}`);
  console.log(`\n> ${logs.length} messages, ${errsC.length} errors`);
  await browser.close();
  process.exit(errsC.length ? 1 : 0);
}

// --look sky,sea,high — named framings for judging image quality rather than
// event behaviour. Yaw is stated relative to the sun so the same name gives the
// same lighting whatever hour the condition preset picked, which is the whole
// point when the thing being compared between runs is the shading.
const LOOKS = {
  sky:  { y: 45,  pitch: 0.30,  yawOff: 0.42, fov: 50 },
  sea:  { y: 45,  pitch: -0.16, yawOff: 0.60, fov: 55 },
  low:  { y: 8,   pitch: -0.04, yawOff: 0.30, fov: 55 },
  high: { y: 320, pitch: -0.22, yawOff: 0.60, fov: 60 },
  sun:  { y: 30,  pitch: 0.16,  yawOff: 0.02, fov: 46 },
};
const looks = (getArg('look', '') || '').split(',').filter(Boolean);
if (looks.length) {
  await sleep(2500);
  // --js "a.clouds.enabled=false" — bisect the frame by switching one subsystem
  // off at a time. `a` is the app. Runs after the condition is applied and
  // before the pose, so it can override anything the preset set.
  const js = getArg('js', '');
  if (js) {
    const r = await page.evaluate((src) => {
      try { return String(new Function('a', src)(window.__app) ?? 'ok'); }
      catch (e) { return 'ERROR ' + e.message; }
    }, js);
    console.log(`> js: ${js} -> ${r}`);
  }
  for (const name of looks) {
    const L = LOOKS[name];
    if (!L) { console.log(`! unknown look ${name}`); continue; }
    await page.evaluate((l) => {
      const a = window.__app;
      const sd = a.clouds.shared.uSunDir.value;
      a.camera.position.set(0, l.y, 0);
      a.cine._freePos.set(0, l.y, 0);
      a.cine.yaw = Math.atan2(-sd.x, -sd.z) + l.yawOff;
      a.cine.pitch = l.pitch;
      a.cine._vantage = null; a.cine._ceiling = null;
      a.cine.setZoom(l.fov);
      a.profiler.enabled = true;
      a.profiler.reset();
    }, L);
    await sleep(4000);
    const zones = await page.evaluate(() => ({
      ms: +window.__app.quality.averageMs.toFixed(1),
      z: window.__app.profiler.report().zones.map(x => `${x.name} ${x.ms.toFixed(2)}`).join('  '),
    })).catch(() => null);
    await shoot(path.join(outDir, `${tag}-${name}.png`));
    console.log(`> ${tag}-${name}.png  ${zones?.ms} ms   ${zones?.z}`);
  }
  await browser.close();
  process.exit(0);
}

// --alts 40,190,400 — same sea and sky photographed from several heights.
// Isolates anything that depends on where the eye is rather than on what the
// weather is doing, which is otherwise very easy to blame on the event.
const alts = (getArg('alts', '') || '').split(',').filter(Boolean).map(Number);
if (alts.length) {
  await sleep(3000);
  for (const y of alts) {
    await page.evaluate((yy) => {
      const a = window.__app;
      // Leave _floor alone: seeding it high makes the camera think it is
      // standing on a surface that is now dropping, and it rides back down.
      a.camera.position.y = yy; a.cine._freePos.y = yy;
      a.cine._vantage = null; a.cine._ceiling = null;
    }, y);
    await sleep(2500);
    const p = await page.evaluate(() => window.__probe()).catch(() => null);
    await shoot(path.join(outDir, `${tag}-y${String(y).padStart(4, '0')}.png`));
    console.log(`> ${tag}-y${y}.png  eye ${p?.cam[1]} m  ${p?.ms} ms`);
  }
  await browser.close();
  process.exit(0);
}

// --seq lightning:5,waterspout:10,whirlpool:10 — fire each button in turn,
// photograph it partway through and again at the end, then calm the sea before
// the next one so nothing is contaminated by the leftovers of the last event.
const seq = (getArg('seq', '') || '').split(',').filter(Boolean)
  .map(s => { const [name, secs] = s.split(':'); return { name, secs: parseFloat(secs || '9') }; });
if (seq.length) {
  for (const step of seq) {
    console.log(`\n=== ${step.name} ===`);
    await page.evaluate((a) => window.__app.sandbox[a](), step.name);
    for (const frac of [0.45, 1.0]) {
      await sleep(step.secs * (frac === 0.45 ? 0.45 : 0.55) * 1000);
      const p = await page.evaluate(() => window.__probe()).catch(() => null);
      const name = `${tag}-${step.name}-${Math.round(frac * 100)}.png`;
      await shoot(path.join(outDir, name));
      console.log(`> ${name}  eye ${p?.cam[1]} m  fov ${p?.fov}  here ${p?.here} m  ${p?.ms} ms`);
    }
    await page.evaluate(() => window.__app.sandbox.calm());
    await sleep(1200);
  }
  const errsSeq = logs.filter(l => l.type === 'error' || l.type === 'pageerror');
  if (errsSeq.length) {
    console.log('\n=========== ERRORS ===========');
    const seen = new Set();
    for (const e of errsSeq) {
      if (seen.has(e.text.slice(0, 120))) continue;
      seen.add(e.text.slice(0, 120));
      console.log(`[${e.type}] ${e.text}\n`);
    }
  }
  console.log(`\n> ${logs.length} messages, ${errsSeq.length} errors`);
  await browser.close();
  process.exit(errsSeq.length ? 1 : 0);
}

let fired = false;
let nextProbe = 0;
let shotIdx = 0;
// Photographing a moving event on a wall clock is hopeless: under Puppeteer the
// simulation runs at roughly half speed and each screenshot stalls it for
// seconds, so a shot lands wherever it lands. Triggering on how far away the
// crest is puts the shutter at the same point of the event every run.
const distGates = (getArg('dist', '') || '').split(',').filter(Boolean).map(Number);
const dbgModes = (getArg('dbg', '') || '').split(',').filter(Boolean).map(Number);
let gateIdx = 0;
const deadline = parseFloat(getArg('deadline', String(Math.max(...shots, fireAt) + 2)));

while (wall() < deadline && (distGates.length === 0 || gateIdx < distGates.length)) {
  await sleep(50);
  const w = wall();
  if (!fired && w >= fireAt && action) {
    await page.evaluate((a) => window.__app.sandbox[a](), action);
    // Override the event's own framing so the same wave can be photographed
    // from several heights without editing the sandbox between runs.
    const eye = parseFloat(getArg('eye', ''));
    if (Number.isFinite(eye)) {
      await page.evaluate((y) => { window.__app.cine._ceiling = { y, hold: 600 }; }, eye);
    }
    fired = true;
    console.log(`> fired ${action} at wall ${w.toFixed(1)}s`);
  }
  if (w >= nextProbe) {
    nextProbe = w + probeEvery;
    const p = await page.evaluate(() => window.__probe()).catch(() => null);
    if (p) {
      trace.push({ w: +w.toFixed(1), ...p });
      if (fired && gateIdx < distGates.length && p.sol && -p.sol.ahead <= distGates[gateIdx]) {
        const g = distGates[gateIdx];
        const name = `${tag}-d${String(g).replace('-', 'm').padStart(4, '0')}.png`;
        await shoot(path.join(outDir, name));
        console.log(`> shot ${name}  (crest ${-p.sol.ahead} m ahead, ${p.sol.amp} m tall, eye ${p.cam[1]} m)`);
        // A tonemapped frame cannot tell a shading bug from an exposure one: a
        // black ocean under a blown-out sky looks the same either way. The HDR
        // grid says which, before the tonemapper has had its say.
        const hdr = await page.evaluate(() => window.__app.probeHDR(9, 7)).catch(() => null);
        if (hdr) {
          console.log('  scene luminance (top row = top of frame):');
          for (const row of hdr) console.log('   ' + row);
        }
        // Optional term-by-term breakdown of the surface shader at this exact
        // moment: which of reflection, volume colour or foam is painting the
        // wave. Guessing at that from a tonemapped frame is how a shading bug
        // gets "fixed" by scaling down whichever term was innocent.
        for (const m of dbgModes) {
          await page.evaluate((mm) => window.__app.setDebugMode(mm), m);
          await sleep(260);
          await shoot(path.join(outDir, `${tag}-d${g}-dbg${m}.png`));
          console.log(`  dbg${m} -> ${tag}-d${g}-dbg${m}.png`);
        }
        if (dbgModes.length) await page.evaluate(() => window.__app.setDebugMode(0));
        gateIdx++;
      }
    }
  }
  if (!distGates.length && shotIdx < shots.length && w >= shots[shotIdx]) {
    const name = `${tag}-w${String(shots[shotIdx]).padStart(3, '0')}.png`;
    await shoot(path.join(outDir, name));
    console.log(`> shot ${name}`);
    shotIdx++;
  }
}

console.log('\n wall   app     ms   camY  pitch  here  ahead amp | height every 100 m down the sight line');
for (const r of trace) {
  console.log(
    `${String(r.w).padStart(5)} ${String(r.t).padStart(6)} ${String(r.ms).padStart(6)} `
    + `${String(r.cam[1]).padStart(6)} `
    + `${String(r.pitch).padStart(6)} ${String(r.here).padStart(5)} `
    + `${String(r.sol?.ahead ?? '-').padStart(6)} ${String(r.sol?.amp ?? '-').padStart(4)} | `
    + r.prof.map(v => String(v).padStart(5)).join(''));
}

fs.writeFileSync(path.join(outDir, `${tag}-trace.json`), JSON.stringify(trace, null, 1));

const errs = logs.filter(l => l.type === 'error' || l.type === 'pageerror');
if (errs.length) {
  console.log('\n=========== ERRORS ===========');
  const seen = new Set();
  for (const e of errs) {
    if (seen.has(e.text.slice(0, 120))) continue;
    seen.add(e.text.slice(0, 120));
    console.log(`[${e.type}] ${e.text}\n`);
  }
}
console.log(`\n> ${logs.length} messages, ${errs.length} errors`);
await browser.close();
process.exit(errs.length ? 1 : 0);

