import { App } from './core/App.js';

const boot = document.getElementById('boot');
const bootBar = document.querySelector('#bootbar i');
const bootMsg = document.getElementById('bootmsg');
const bootErr = document.getElementById('booterr');
const hud = document.getElementById('hud');

function progress(msg, p) {
  bootMsg.textContent = msg;
  if (p !== undefined) bootBar.style.width = `${Math.round(p * 100)}%`;
}

function fail(err) {
  console.error(err);
  bootMsg.textContent = 'initialisation failed';
  bootErr.textContent = (err && err.stack) ? err.stack : String(err);
}

async function main() {
  const canvas = document.getElementById('gl');
  const app = new App(canvas, progress);
  window.__app = app;
  try {
    await app.init();
  } catch (e) {
    fail(e);
    return;
  }

  const { installDirector } = await import('./weather/Director.js');
  const director = installDirector(app);

  const { installUI } = await import('./ui/Overlay.js');
  installUI(app);

  const p = app.params;
  if (p.get('act') !== null) director.gotoAct(parseInt(p.get('act'), 10) || 0);
  if (p.get('director') === '0') director.enabled = false;
  if (p.get('debug') !== null) app.setDebugMode(parseInt(p.get('debug'), 10) || 0);
  if (p.get('paused') === '1') app.paused = true;

  app.start();
  setTimeout(() => {
    boot.classList.add('hidden');
    hud.classList.add('on');
    document.body.classList.add('cine');
  }, 350);

  window.addEventListener('error', (e) => console.error('[runtime]', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => console.error('[promise]', e.reason));
}

main();
