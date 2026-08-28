/**
 * Crop and magnify a screenshot so pixel-level artefacts are actually legible.
 *
 *   node tools/crop.mjs shots/aniso-y0040.png 300,330,520,300 2
 *
 * Args: <file> <x,y,w,h> [zoom] [outName]. Nearest-neighbour on the way up so
 * what you see is the source pixels, not the resampler's opinion of them.
 */
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, extname, join } from 'node:path';

const [file, rect = '0,0,640,360', zoomArg = '2', outArg] = process.argv.slice(2);
if (!file) { console.error('usage: node tools/crop.mjs <png> <x,y,w,h> [zoom] [out]'); process.exit(1); }

const src = resolve(file);
const [x, y, w, h] = rect.split(',').map(Number);
const zoom = Number(zoomArg) || 2;
const out = outArg
  ? resolve(dirname(src), outArg)
  : join(dirname(src), `${basename(src, extname(src))}-crop${extname(src)}`);

const b64 = readFileSync(src).toString('base64');
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const data = await page.evaluate(async ({ b64, x, y, w, h, zoom }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w * zoom; c.height = h * zoom;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, w * zoom, h * zoom);
  return c.toDataURL('image/png').split(',')[1];
}, { b64, x, y, w, h, zoom });

writeFileSync(out, Buffer.from(data, 'base64'));
await browser.close();
console.warn(`> ${out}  ${w}x${h} @${zoom}x`);
