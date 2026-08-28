/**
 * Print RGB along a horizontal scanline, averaged over a few rows.
 *
 *   node tools/px.mjs shots/i1-sky.png 200 800 980 10
 *   (file, y, x0, x1, step)
 */
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [file, ys = '200', x0s = '0', x1s = '1600', steps = '20'] = process.argv.slice(2);
const b64 = readFileSync(resolve(file)).toString('base64');
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const rows = await page.evaluate(async ({ b64, y, x0, x1, step }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const H = 5;
  const d = g.getImageData(0, Math.max(0, y - 2), c.width, H).data;
  const out = [];
  for (let x = x0; x < Math.min(x1, c.width); x += step) {
    let r = 0, gg = 0, b = 0;
    for (let k = 0; k < H; k++) {
      const i = (k * c.width + x) * 4;
      r += d[i]; gg += d[i + 1]; b += d[i + 2];
    }
    out.push(`x=${x}  r=${(r / H).toFixed(0)} g=${(gg / H).toFixed(0)} b=${(b / H).toFixed(0)}`);
  }
  return out;
}, { b64, y: +ys, x0: +x0s, x1: +x1s, step: +steps });

await browser.close();
for (const r of rows) console.warn(r);
