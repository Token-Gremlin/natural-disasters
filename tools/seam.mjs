/**
 * Find vertical seams in a screenshot: columns whose horizontal step is far
 * larger than their neighbours'. Wave texture produces a noisy but flat
 * profile; a genuine seam is a single column spiking well above it.
 *
 *   node tools/seam.mjs shots/rgh-high.png [y0frac] [y1frac]
 */
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [file, a = '0.35', b = '0.95'] = process.argv.slice(2);
if (!file) { console.error('usage: node tools/seam.mjs <png> [y0frac] [y1frac]'); process.exit(1); }

const b64 = readFileSync(resolve(file)).toString('base64');
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const out = await page.evaluate(async ({ b64, a, b }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const y0 = Math.floor(H * a), y1 = Math.floor(H * b);
  const d = g.getImageData(0, y0, W, y1 - y0).data;
  const rows = y1 - y0;

  const col = new Float64Array(W);
  for (let r = 0; r < rows; r++) {
    for (let x = 1; x < W; x++) {
      const i = ((r * W) + x) * 4, j = i - 4;
      col[x] += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
    }
  }
  for (let x = 1; x < W; x++) col[x] /= rows;

  // Compare each column against the local median so wave texture, which varies
  // smoothly across the frame, does not set the bar for the whole image.
  const scores = [];
  const R = 24;
  for (let x = R + 1; x < W - R; x++) {
    const win = [];
    for (let k = x - R; k <= x + R; k++) if (k !== x) win.push(col[k]);
    win.sort((p, q) => p - q);
    const med = win[win.length >> 1] || 1e-6;
    scores.push({ x, ratio: col[x] / med, step: col[x] });
  }
  scores.sort((p, q) => q.ratio - p.ratio);
  return { W, H, band: [y0, y1], top: scores.slice(0, 8).map(s => ({ x: s.x, frac: +(s.x / W).toFixed(3), ratio: +s.ratio.toFixed(2), step: +s.step.toFixed(1) })) };
}, { b64, a: parseFloat(a), b: parseFloat(b) });

await browser.close();
console.warn(`${file}  ${out.W}x${out.H}  rows ${out.band[0]}..${out.band[1]}`);
for (const t of out.top) console.warn(`  x=${t.x} (${t.frac})  ratio ${t.ratio}x  step ${t.step}`);
