/**
 * Headless/headful smoke test: boots the demo in Chrome, collects every
 * console message / page error / GLSL compile log, samples performance and
 * writes screenshots to tools/shots/.
 *
 *   node tools/smoke.mjs --seconds 14 --gpu
 *   node tools/smoke.mjs --gpu --shots 3,10,40,80 --seek 4
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
const url = getArg('url', 'http://localhost:5173/');
const seconds = parseFloat(getArg('seconds', '16'));
const gpu = has('gpu');
const tag = getArg('tag', '');
const shots = (getArg('shots', '') || '').split(',').filter(Boolean).map(Number);
const actJumps = (getArg('acts', '') || '').split(',').filter(Boolean).map(Number);
const outDir = path.resolve('tools/shots');
fs.mkdirSync(outDir, { recursive: true });

const gpuArgs = [
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-zero-copy',
  process.platform === 'win32' ? '--use-angle=d3d11' : '--use-angle=metal',
  '--enable-unsafe-webgpu',
  // Without these the frame time snaps to multiples of the refresh interval and
  // every measurement reads as a wild over-estimate of the real cost.
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
];
const swArgs = [
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
];

const browser = await puppeteer.launch({
  headless: gpu ? false : true,
  args: [
    ...(gpu ? gpuArgs : swArgs),
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1600,940',
    '--window-position=40,40',
  ],
  defaultViewport: { width: 1600, height: 900 },
});

const page = await browser.newPage();
const logs = [];
page.on('console', (msg) => logs.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', (err) => logs.push({ type: 'pageerror', text: err.stack || String(err) }));
page.on('requestfailed', (r) => logs.push({ type: 'requestfailed', text: `${r.url()} :: ${r.failure()?.errorText}` }));

console.log(`> navigating to ${url} (gpu=${gpu})`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// wait for boot
let booted = false;
for (let i = 0; i < 90; i++) {
  await sleep(500);
  const s = await page.evaluate(() => ({
    ok: !!(window.__app && window.__app.running),
    err: document.getElementById('booterr')?.textContent || '',
    msg: document.getElementById('bootmsg')?.textContent || '',
  })).catch(() => ({ ok: false, err: '', msg: 'eval failed' }));
  if (s.err) { console.log('BOOT ERROR:\n' + s.err); break; }
  if (s.ok) { booted = true; console.log(`> booted after ${(i + 1) * 0.5}s`); break; }
}

async function shot(name) {
  const f = path.join(outDir, `${tag ? tag + '-' : ''}${name}.png`);
  await page.screenshot({ path: f });
  console.log(`> screenshot ${f}`);
  return f;
}

const perf = [];
async function samplePerf(label) {
  const p = await page.evaluate(() => {
    const a = window.__app;
    return {
      ms: a?.quality?.averageMs, dyn: a?.quality?.dynamicScale,
      res: `${a?.renderWidth}x${a?.renderHeight}`,
      act: a?.director?.acts?.[a.director.actIndex]?.name,
      frame: a?.frame,
    };
  });
  perf.push({ label, ...p });
}

const blit = getArg('blit', '');
if (booted && blit) {
  const [which, mode = 'rgb', scale = '1'] = blit.split(':');
  await page.evaluate(([w, m, s]) => {
    const a = window.__app;
    const tex = { cloud: a.clouds?.fullRT?.texture, cloudlow: a.clouds?.history?.read?.texture,
      cloudenv: a.clouds?.envRT?.texture, env: a.sky?.envRT?.texture,
      hdr: a.hdrRT?.textures?.[0], vel: a.hdrRT?.textures?.[1],
      skyview: a.atmosphere?.skyViewRT?.texture,
      transmittance: a.atmosphere?.transmittanceRT?.texture,
      multiscatter: a.atmosphere?.multiScatterRT?.texture,
      aerial: a.atmosphere?.aerialRT?.texture,
      spraypos: a.spray?.state?.read?.textures?.[0],
      sprayvel: a.spray?.state?.read?.textures?.[1] }[w];
    a.setDebugTexture(tex, m, parseFloat(s));
  }, [which, mode, scale]);
  console.log(`> blit ${blit}`);
}

const bench = getArg('bench', '');
if (booted && bench !== '') {
  await page.evaluate((i) => {
    window.__app.director && (window.__app.director.enabled = false);
    window.__app.setBenchmarkPose(parseInt(i, 10) || 0);
  }, bench);
  console.log(`> benchmark pose ${bench}`);
}

// --poke 'clouds.marchPass.uniforms.uLightSteps.value=1;...'
const poke = getArg('poke', '');
if (booted && poke) {
  await page.evaluate((p) => {
    // eslint-disable-next-line no-new-func
    new Function('app', `with(app){${p}}`)(window.__app);
  }, poke);
  console.log(`> poke ${poke}`);
}

const weather = getArg('weather', '');
if (booted && weather) {
  await page.evaluate((w) => {
    const o = JSON.parse(w);
    window.__app.weather?.set(o, true);
    window.__app.director && (window.__app.director.enabled = false);
  }, weather);
  console.log(`> weather override ${weather}`);
}

if (booted) {
  if (actJumps.length) {
    // Several stills spread through the act: one-shot events (spouts, rogue
    // waves, tsunamis) fire partway in, so a single early frame never sees them.
    const dwell = parseFloat(getArg('dwell', '4.5'));
    const per = Math.max(1, parseInt(getArg('per', '1'), 10));
    for (const a of actJumps) {
      await page.evaluate((i) => { window.__app.director.gotoAct(i); }, a);
      for (let k = 1; k <= per; k++) {
        await sleep((dwell / per) * 1000);
        await samplePerf(`act${a}.${k}`);
        await shot(`act${String(a).padStart(2, '0')}-${k}`);
      }
    }
  } else {
    const times = shots.length ? shots : [3, Math.round(seconds / 2), seconds];
    let elapsed = 0;
    for (const t of times) {
      await sleep(Math.max(0, t * 1000 - elapsed));
      elapsed = t * 1000;
      await samplePerf(`t${t}`);
      await shot(`t${String(t).padStart(3, '0')}s`);
    }
  }
}

const state = await page.evaluate(() => {
  const app = window.__app;
  const g = (id) => document.getElementById(id)?.textContent;
  return {
    booted: !!app, bootMsg: g('bootmsg'), bootErr: (g('booterr') || '').slice(0, 4000),
    frame: app?.frame, time: app?.time,
    fps: g('hFps'), ms: g('hMs'), res: g('hRes'), qual: g('hQual'),
    act: app?.director?.acts?.[app.director.actIndex]?.name,
    caps: app?.caps, dynScale: app?.quality?.dynamicScale,
    debug: app?.debugStats?.(),
    sprayState: app?.probeSpray?.(),
    ocean: app?.probeOcean?.(64),
    hdr: app?.probeHDR?.(9, 7),
    gpu: app?.profiler?.enabled ? app.profiler.report() : null,
    cloud: app?.probeClouds?.(7, 5),
  };
});

fs.writeFileSync(path.join(outDir, `${tag || 'run'}-state.json`), JSON.stringify(state, null, 2));
console.log('\n=========== STATE ===========');
const { ocean, hdr, gpu: gpuProf, cloud, ...rest } = state;
console.log(JSON.stringify(rest, null, 1).replace(/\n\s+/g, ' '));
if (gpuProf) {
  console.log(`\n--- GPU passes (${gpuProf.mode}) ---`);
  for (const z of gpuProf.zones) console.log(`  ${z.name.padEnd(12)} ${String(z.ms).padStart(9)} ms`);
}
if (hdr) {
  console.log('\n--- HDR scene luminance (top row = top of screen) ---');
  for (const row of hdr) console.log('  ' + row);
}
if (cloud) {
  console.log('\n--- cloud march (hit dist | peak density | taps/inside) ---');
  for (const row of cloud) console.log('  ' + row);
}
if (ocean) {
  console.log('\n--- ocean cascades (min | max | avg) ---');
  for (const o of ocean) {
    if (o.error) { console.log(`${o.label}: ${o.error}`); continue; }
    const f = (a) => '[' + a.map(v => String(v).padStart(9)).join(' ') + ']';
    console.log(`${o.label.padEnd(30)} ${f(o.min)} ${f(o.max)} ${f(o.avg)}`);
  }
}
if (perf.length) {
  console.log('\n=========== PERF ===========');
  for (const p of perf) console.log(`${(p.label || '').padEnd(10)} ${String(p.ms?.toFixed?.(2)).padStart(8)} ms  dyn=${p.dyn}  ${p.res}  ${p.act}`);
}

console.log('\n=========== LOGS ===========');
const seen = new Set();
let errCount = 0;
for (const l of logs) {
  if (l.type === 'error' || l.type === 'pageerror') errCount++;
  const key = l.type + '|' + l.text.slice(0, 200);
  if (seen.has(key)) continue;
  seen.add(key);
  if (l.type === 'log' || l.type === 'debug' || l.type === 'info') continue;
  if (l.text.includes('favicon')) continue;
  console.log(`--- [${l.type}] ---\n${l.text}\n`);
}
console.log(`\n> ${logs.length} messages, ${errCount} errors`);

await browser.close();
process.exit(errCount > 0 || state.bootErr ? 1 : 0);
