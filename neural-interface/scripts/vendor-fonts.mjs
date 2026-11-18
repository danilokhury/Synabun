#!/usr/bin/env node
/**
 * Vendors the page's three Google font families into public/vendor/fonts/ so no page asks Google for them.
 *
 *   node neural-interface/scripts/vendor-fonts.mjs
 *
 * It asks Google Fonts once for the very sheet the pages used to link (FAMILIES_URL, the same families, weights and
 * `display=swap`), downloads every woff2 that sheet names into a fresh temporary folder, checks each is a WOFF2 file,
 * and writes:
 *   fonts.css      the same @font-face rules in the same order (family, style, weight, font-display, unicode-range),
 *                  each url() pointing at the local copy
 *   <family>-<subset>.woff2   one file per unicode-range subset (Google serves these families as variable fonts:
 *                  one file covers every weight of a subset)
 *   <family>-OFL.txt          the SIL Open Font License 1.1 of each family, from github.com/google/fonts
 *   manifest.json  where every file came from and its SHA-256 (tests/vendored-fonts.test.mjs checks them)
 *
 * Google answers the same sheet to Chromium, Firefox and Safari user agents (checked 2026-11-15), so one sheet serves
 * every engine. Run it again only to move to newer font versions; the page never reaches Google at runtime.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FONTS_DIR = resolve(HERE, '..', 'public', 'vendor', 'fonts');
export const FAMILIES_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const LICENCES = {
  Inter: 'ofl/inter/OFL.txt',
  'JetBrains Mono': 'ofl/jetbrainsmono/OFL.txt',
  'Space Grotesk': 'ofl/spacegrotesk/OFL.txt',
};

export const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** The @font-face blocks of a Google css2 sheet, each with the subset named by the comment above it. */
export function parseGoogleSheet(css) {
  const faces = [];
  const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const body = m[2];
    const get = (prop) => body.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`))?.[1].trim();
    faces.push({
      subset: m[1],
      family: get('font-family')?.replace(/^['"]|['"]$/g, ''),
      style: get('font-style'),
      weight: get('font-weight'),
      display: get('font-display'),
      url: body.match(/url\((https:[^)]+)\)/)?.[1],
      unicodeRange: get('unicode-range'),
    });
  }
  return faces;
}

export function renderSheet(faces, fileOf) {
  const head = '/* Inter, JetBrains Mono and Space Grotesk, served from SynaBun itself (no font CDN at runtime).\n'
    + '   The rules Google Fonts serves for the sheet in scripts/vendor-fonts.mjs (FAMILIES_URL), in the same order,\n'
    + '   with the same weights, font-display and unicode-range subsets; each url() names the local copy.\n'
    + '   SIL Open Font License 1.1: the <family>-OFL.txt files in this folder. Sources and hashes: manifest.json. */\n';
  return head + faces.map((f) => `/* ${f.subset} */\n@font-face {\n  font-family: '${f.family}';\n  font-style: ${f.style};\n`
    + `  font-weight: ${f.weight};\n  font-display: ${f.display};\n  src: url(./${fileOf(f)}) format('woff2');\n`
    + `  unicode-range: ${f.unicodeRange};\n}\n`).join('');
}

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

async function main() {
  const css = await get(FAMILIES_URL);
  const faces = parseGoogleSheet(css);
  if (!faces.length || faces.some((f) => !f.family || !f.url || !f.unicodeRange)) throw new Error('unexpected sheet shape');
  const nameOfUrl = new Map();
  for (const f of faces) {
    const name = `${slug(f.family)}-${f.subset}.woff2`;
    const known = nameOfUrl.get(f.url);
    if (known && known !== name) throw new Error(`${f.url} is two subsets (${known}, ${name})`);
    nameOfUrl.set(f.url, name);
  }
  const work = mkdtempSync(join(tmpdir(), 'synabun-fonts-'));
  try {
    const files = {};
    for (const [url, name] of nameOfUrl) {
      const buf = await get(url, 'buffer');
      if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error(`${url} is not a WOFF2 file`);
      writeFileSync(join(work, name), buf);
      files[name] = { source: url, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    }
    const licences = {};
    for (const [family, path] of Object.entries(LICENCES)) {
      const text = await get(`https://raw.githubusercontent.com/google/fonts/main/${path}`);
      if (!/SIL Open Font License, Version 1\.1/.test(text)) throw new Error(`${path}: not the OFL 1.1`);
      licences[family] = { file: `${slug(family)}-OFL.txt`, source: `https://github.com/google/fonts/blob/main/${path}`, copyright: text.split(/\r?\n/)[0].trim(), text };
    }
    mkdirSync(FONTS_DIR, { recursive: true });
    for (const name of Object.keys(files)) writeFileSync(join(FONTS_DIR, name), readFileSync(join(work, name)));
    for (const l of Object.values(licences)) writeFileSync(join(FONTS_DIR, l.file), l.text);
    writeFileSync(join(FONTS_DIR, 'fonts.css'), renderSheet(faces, (f) => nameOfUrl.get(f.url)));
    const manifest = {
      source: FAMILIES_URL,
      fetched: new Date().toISOString().slice(0, 10),
      license: 'OFL-1.1',
      families: Object.fromEntries(Object.entries(licences).map(([family, l]) => [family, {
        licenseFile: l.file, licenseSource: l.source, copyright: l.copyright,
        weights: [...new Set(faces.filter((f) => f.family === family).map((f) => Number(f.weight)))].sort((a, b) => a - b),
        subsets: [...new Set(faces.filter((f) => f.family === family).map((f) => f.subset))],
      }])),
      files,
    };
    writeFileSync(join(FONTS_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`vendored ${faces.length} @font-face rules, ${Object.keys(files).length} files into ${FONTS_DIR}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
