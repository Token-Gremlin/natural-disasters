/**
 * Mean absolute difference between two screenshots, plus where it lives.
 * Two runs that were supposed to differ and come back identical mean the knob
 * under test never reached the shader.
 *
 *   node tools/diff.mjs shots/a.png shots/b.png
 */
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) { console.error('usage: node tools/diff.mjs <a.png> <b.png>'); process.exit(1); }

const A = readFileSync(resolve(fa)).toString('base64');
const B = readFileSync(resolve(fb)).toString('base64');
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const out = await page.evaluate(async ({ A, B }) => {
  const load = async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
    return { d: c.getContext('2d').getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  };
  const a = await load(A), b = await load(B);
  if (a.w !== b.w || a.h !== b.h) return { err: `size ${a.w}x${a.h} vs ${b.w}x${b.h}` };
  let sum = 0, changed = 0, peak = 0;
  const cols = new Float64Array(a.w);
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    const i = (y * a.w + x) * 4;
    const e = Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2]);
    sum += e; if (e > 6) changed++; if (e > peak) peak = e;
    cols[x] += e;
  }
  const n = a.w * a.h;
  let bx = 0; for (let x = 0; x < a.w; x++) if (cols[x] > cols[bx]) bx = x;
  return { w: a.w, h: a.h, mean: +(sum / n).toFixed(3), pctChanged: +(100 * changed / n).toFixed(2), peak, busiestCol: bx };
}, { A, B });

await browser.close();
console.warn(JSON.stringify(out));
