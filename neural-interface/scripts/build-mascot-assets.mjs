#!/usr/bin/env node
// Optimise approved v3 drawings without resizing, redrawing or changing timing.
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../.synabun/design/mascot-animations-v3');
const OUT = path.resolve(here, '../public/assets/mascot');
async function buildSet(src, out, mascot = false) {
  const source = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
  await mkdir(out, { recursive: true });
  for (const f of await readdir(out)) if (/\.(gif|png)$/.test(f)) await rm(path.join(out, f));
  const manifest = {};
  for (const state of source.states) {
    const key = mascot && state.id === 'thinking' ? 'think' : state.id;
    const input = await readFile(path.join(src, state.gif));
    const meta = await sharp(input, { animated: true }).metadata();
    const once = !state.intended_behavior.includes('loop');
    const gif = await sharp(input, { animated: true }).gif({ loop: once ? 1 : 0, delay: meta.delay, colours: 16, dither: 0, effort: 10 }).toBuffer();
    const png = await sharp(path.join(src, state.still)).png({ compressionLevel: 9 }).toBuffer();
    await writeFile(path.join(out, `${key}.gif`), gif);
    await writeFile(path.join(out, `${key}.png`), png);
    manifest[key] = { source: state.gif, duration: meta.delay.reduce((a, b) => a + b, 0), once, width: meta.width, height: meta.pageHeight || meta.height, frames: meta.pages, bytes: gif.length };
  }
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${out}: ${Object.keys(manifest).length} assets`);
}
await buildSet(SRC, OUT, true);
await buildSet(path.join(SRC, 'scenes'), path.join(OUT, 'scenes'));
