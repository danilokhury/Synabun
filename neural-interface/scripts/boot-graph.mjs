#!/usr/bin/env node
/**
 * The page's module graph, read the way a browser reads it: what loads before the first line of an entry runs
 * (the static closure: every `import … from` / `export … from` / bare `import '…'`, transitively), and what each
 * module asks for later through `import('…')`.
 *
 * The static specifiers come from V8's own parser (`vm.SourceTextModule#moduleRequests` /
 * `dependencySpecifiers`), so a specifier in a comment or a string is never counted. That class needs
 * `--experimental-vm-modules`; without it this file re-runs itself with the flag (`runBootGraph`).
 *
 *   node --experimental-vm-modules neural-interface/scripts/boot-graph.mjs [--json] [--page index.html]
 *
 * Resolution follows the page: `./` and `../` against the importer's URL, `/…` against public/, bare names
 * through the page's import map. Bytes are the files as served (the server sends them uncompressed).
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = resolve(HERE, '..', 'public');

/** The page's import map and its module entries, in document order. */
export function readPage(pageFile, publicDir = PUBLIC_DIR) {
  const html = readFileSync(join(publicDir, pageFile), 'utf8');
  const importMap = {};
  const mapMatch = html.match(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/i);
  if (mapMatch) Object.assign(importMap, JSON.parse(mapMatch[1]).imports || {});
  const entries = [];
  for (const m of html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) entries.push(m[1]);
  const modulepreloads = [];
  for (const m of html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*>/gi)) {
    const href = m[0].match(/\bhref=["']([^"']+)["']/i);
    if (href) modulepreloads.push(href[1]);
  }
  const stylesheets = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel=["']stylesheet["']/i.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    // A sheet with a media that never matches the screen (print, swapped onload) does not hold the first paint.
    const media = tag.match(/\bmedia=["']([^"']+)["']/i)?.[1] || 'all';
    stylesheets.push({ href, blocking: !/^print$/i.test(media.trim()) });
  }
  const preloads = [];
  for (const m of html.matchAll(/<link\b[^>]*\brel=["']preload["'][^>]*>/gi)) {
    const href = m[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
    const as = m[0].match(/\bas=["']([^"']+)["']/i)?.[1];
    if (href) preloads.push({ href, as: as || '' });
  }
  return { html, importMap, entries, modulepreloads, stylesheets, preloads };
}

/** A specifier as the page would resolve it: a URL path under the site, or null for another origin. */
export function resolveSpecifier(spec, importerUrl, importMap = {}) {
  if (Object.prototype.hasOwnProperty.call(importMap, spec)) spec = importMap[spec];
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null; // another origin, data:, blob:
  if (spec.startsWith('/')) return normalizeUrlPath(spec);
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const base = importerUrl.slice(0, importerUrl.lastIndexOf('/') + 1);
    return normalizeUrlPath(base + spec);
  }
  return null; // a bare name with no import-map entry fails in the page too
}

function normalizeUrlPath(path) {
  const clean = path.split(/[?#]/)[0];
  const out = [];
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

function staticSpecifiers(source, file) {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('boot-graph needs node --experimental-vm-modules');
  }
  let mod;
  try {
    mod = new vm.SourceTextModule(source, { identifier: file });
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
  if (Array.isArray(mod.moduleRequests)) return mod.moduleRequests.map((r) => r.specifier);
  return [...mod.dependencySpecifiers];
}

/** `import('literal')` calls, outside comments (a cheap reading; only used to describe what loads later). */
export function dynamicSpecifiers(source) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const out = [];
  for (const m of stripped.matchAll(/\bimport\(\s*(['"`])([^'"`$]+)\1\s*\)/g)) out.push(m[2]);
  return out;
}

/**
 * The static closure of `entries` (URL paths), with each module's bytes, and every dynamic import found in it.
 * @returns {{ modules: Map<string,{bytes:number,gzip:number,imports:string[],dynamic:string[]}>, missing: string[] }}
 */
export function staticClosure(entries, { publicDir = PUBLIC_DIR, importMap = {} } = {}) {
  const modules = new Map();
  const missing = [];
  const queue = [...entries];
  while (queue.length) {
    const url = queue.shift();
    if (modules.has(url)) continue;
    const file = join(publicDir, url);
    if (!file.startsWith(publicDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      missing.push(url);
      modules.set(url, { bytes: 0, gzip: 0, imports: [], dynamic: [] });
      continue;
    }
    const buf = readFileSync(file);
    const source = buf.toString('utf8');
    const imports = [];
    for (const spec of staticSpecifiers(source, url)) {
      const target = resolveSpecifier(spec, url, importMap);
      if (target) { imports.push(target); queue.push(target); }
    }
    const dynamic = [];
    for (const spec of dynamicSpecifiers(source)) {
      const target = resolveSpecifier(spec, url, importMap);
      if (target) dynamic.push(target);
    }
    modules.set(url, { bytes: buf.length, gzip: gzipSync(buf).length, imports, dynamic });
  }
  return { modules, missing };
}

/** Everything reachable by static or dynamic import (what the page can ever load as a module). */
export function fullClosure(entries, opts = {}) {
  const seen = new Map();
  let frontier = [...entries];
  while (frontier.length) {
    const { modules } = staticClosure(frontier, opts);
    frontier = [];
    for (const [url, info] of modules) {
      if (seen.has(url)) continue;
      seen.set(url, info);
      for (const d of info.dynamic) if (!seen.has(d)) frontier.push(d);
    }
  }
  return seen;
}

function sum(modules, key) {
  let n = 0;
  for (const info of modules.values()) n += info[key];
  return n;
}

/**
 * The numbers for a page: the critical path (entries + their static closure), CSS that holds the paint, the rest.
 * `deferred` names modules an entry imports dynamically right away (variant/3d/app.js behind the loading overlay):
 * `beforeReveal` is the critical path plus their static closure, what loads before the page is shown.
 */
export function measurePage(pageFile = 'index.html', publicDir = PUBLIC_DIR, { deferred = [] } = {}) {
  const page = readPage(pageFile, publicDir);
  const { modules, missing } = staticClosure(page.entries, { publicDir, importMap: page.importMap });
  const reveal = staticClosure([...page.entries, ...deferred], { publicDir, importMap: page.importMap });
  const everything = fullClosure(page.entries, { publicDir, importMap: page.importMap });
  const localCss = page.stylesheets.filter((s) => s.blocking && s.href.startsWith('/'));
  const remoteBlocking = page.stylesheets.filter((s) => s.blocking && !s.href.startsWith('/'));
  return {
    page: pageFile,
    entries: page.entries,
    critical: {
      modules: modules.size,
      bytes: sum(modules, 'bytes'),
      gzip: sum(modules, 'gzip'),
      urls: [...modules.keys()],
      missing,
    },
    beforeReveal: {
      modules: reveal.modules.size,
      bytes: sum(reveal.modules, 'bytes'),
      gzip: sum(reveal.modules, 'gzip'),
      urls: [...reveal.modules.keys()],
      /** Each module's static imports, by URL. */
      imports: Object.fromEntries([...reveal.modules].map(([url, info]) => [url, info.imports])),
      missing: reveal.missing,
    },
    reachable: { modules: everything.size, bytes: sum(everything, 'bytes') },
    renderBlocking: {
      stylesheets: page.stylesheets.filter((s) => s.blocking).map((s) => s.href),
      remote: remoteBlocking.map((s) => s.href),
      localCssBytes: localCss.reduce((n, s) => {
        const f = join(publicDir, s.href.split(/[?#]/)[0]);
        return n + (existsSync(f) ? statSync(f).size : 0);
      }, 0),
    },
    modulepreloads: page.modulepreloads,
    preloads: page.preloads,
    graph: modules,
  };
}

/** What each of an entry's own imports adds to the critical path that no other import of it brings. */
export function exclusiveWeight(entryUrl, { publicDir = PUBLIC_DIR, importMap = {} } = {}) {
  const { modules } = staticClosure([entryUrl], { publicDir, importMap });
  const direct = modules.get(entryUrl).imports;
  const rows = [];
  for (const dep of direct) {
    const others = direct.filter((d) => d !== dep);
    // closure of the entry minus `dep`: the closure of every other direct import, plus the entry
    const rest = staticClosure(others, { publicDir, importMap }).modules;
    const own = staticClosure([dep], { publicDir, importMap }).modules;
    let mods = 0; let bytes = 0;
    for (const [url, info] of own) if (!rest.has(url)) { mods++; bytes += info.bytes; }
    rows.push({ import: dep, modules: mods, bytes });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

/** Run this file under the flag it needs and return its JSON report (for tests and other scripts). */
export function runBootGraph(args = []) {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), '--json', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`boot-graph failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

function kb(n) { return `${(n / 1024).toFixed(1)} KB`; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const pageArg = args.indexOf('--page');
  const pageFile = pageArg >= 0 ? args[pageArg + 1] : 'index.html';
  const deferred = args.flatMap((arg, i) => (arg === '--deferred' && args[i + 1] ? [args[i + 1]] : []));
  const m = measurePage(pageFile, PUBLIC_DIR, { deferred });
  if (json) {
    const { graph, ...rest } = m;
    const byUrl = {};
    for (const [url, info] of graph) byUrl[url] = info;
    process.stdout.write(JSON.stringify({ ...rest, graph: byUrl }, null, 2));
  } else {
    console.log(`page: ${m.page}`);
    console.log(`entries: ${m.entries.join(', ')}`);
    console.log(`critical path: ${m.critical.modules} modules, ${kb(m.critical.bytes)} (gzip ${kb(m.critical.gzip)})`);
    if (m.critical.missing.length) console.log(`missing: ${m.critical.missing.join(', ')}`);
    if (deferred.length) {
      console.log(`before the page is shown (+ ${deferred.join(', ')}): ${m.beforeReveal.modules} modules, ${kb(m.beforeReveal.bytes)} (gzip ${kb(m.beforeReveal.gzip)})`);
      if (m.beforeReveal.missing.length) console.log(`missing: ${m.beforeReveal.missing.join(', ')}`);
    }
    console.log(`reachable (static + dynamic): ${m.reachable.modules} modules, ${kb(m.reachable.bytes)}`);
    console.log(`render-blocking stylesheets: ${m.renderBlocking.stylesheets.join(', ')} (local ${kb(m.renderBlocking.localCssBytes)})`);
    console.log(`remote render-blocking: ${m.renderBlocking.remote.length ? m.renderBlocking.remote.join(', ') : 'none'}`);
    if (args.includes('--weights')) {
      const page = readPage(pageFile);
      for (const entry of page.entries) {
        console.log(`\nexclusive weight of ${entry}'s imports:`);
        for (const row of exclusiveWeight(entry, { importMap: page.importMap })) {
          console.log(`  ${String(row.modules).padStart(4)} mod  ${kb(row.bytes).padStart(10)}  ${row.import}`);
        }
      }
    }
  }
}
