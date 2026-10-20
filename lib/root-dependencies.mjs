#!/usr/bin/env node
/**
 * SynaBun — the package's dependencies, at its root
 *
 * `npm i -g synabun` has to leave a SynaBun that runs: no npm install at the
 * first start, none after an update. So the root package.json names every
 * production dependency of both parts, npm-shrinkwrap.json (the one lockfile
 * npm honours inside an installed package) pins each of them, and npm installs
 * them all at the package root, where Node finds them from mcp-server/ and
 * neural-interface/ alike (lib/runtime-dependencies.js checks that it did).
 *
 * The parts stay the source: their package.json and package-lock.json are what
 * development, the tests and the desktop build install from. What this file
 * writes is derived from them and from nothing else:
 *
 *   dependencies          both parts' dependencies. Where the two ask for one
 *                         package with different ranges, the range that lies
 *                         inside the other; when neither does, nothing is
 *                         written and the error names the package to decide
 *   optionalDependencies  OPTIONAL_AT_ROOT (lib/runtime-dependencies.js)
 *   devDependencies       BUILD_TOOLS: what compiles the MCP server in a fresh
 *                         checkout, at mcp-server's own ranges
 *   overrides             both parts' overrides
 *   npm-shrinkwrap.json   both locked trees as one tree. Every package is at a
 *                         version one of the two lockfiles holds; where both
 *                         put a different version in the same place, the one
 *                         most of its dependents accept stays and a dependent
 *                         it does not suit gets its own copy of the version
 *                         its lockfile gave it. The tools the user installs
 *                         (Claude Code, Codex: lib/external-tools.js) are
 *                         left out, as the desktop build leaves them out.
 *                         On an install or update no dependency's
 *                         install script runs (withoutInstallScript), as
 *                         none ran before.
 *
 *   node lib/root-dependencies.mjs --write    write both
 *   node lib/root-dependencies.mjs --check    exit 1 when either is not what the parts give
 *   (--root <dir> for another checkout, --json for the report)
 *
 * Deterministic and offline: no registry, no npm run. semver is the one
 * dependency (loadSemver: the checkout's own, else the copy inside npm).
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageNameOfLockPath, stripExternalToolsFromLock } from './external-tools.js';
import { OPTIONAL_AT_ROOT, RUNTIME_PARTS } from './runtime-dependencies.js';

export const SHRINKWRAP = 'npm-shrinkwrap.json';

/** mcp-server devDependencies a fresh checkout needs to compile dist/ (setup.js, postinstall.js). */
export const BUILD_TOOLS = Object.freeze(['typescript', '@types/node', '@types/express']);

/** The root package.json fields this file owns, in the order they are written. */
export const ROOT_FIELDS = Object.freeze(['dependencies', 'optionalDependencies', 'devDependencies', 'overrides']);

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PART_FOLDERS = RUNTIME_PARTS.map(part => part.folder).sort();

export class RootDependencyError extends Error {}

// ── semver ──

/** npm's semver: the checkout's (root or a part), else the copy every npm carries. */
export function loadSemver(root = DEFAULT_ROOT, { env = process.env, execPath = process.execPath } = {}) {
  const bases = [join(root, 'package.json'), ...PART_FOLDERS.map(folder => join(root, folder, 'package.json'))];
  if (env.npm_execpath) bases.push(join(dirname(dirname(env.npm_execpath)), 'package.json'));
  const bin = dirname(execPath);
  bases.push(join(bin, '..', 'lib', 'node_modules', 'npm', 'package.json'), join(bin, 'node_modules', 'npm', 'package.json'));
  for (const base of bases) {
    try {
      const semver = createRequire(base)('semver');
      if (typeof semver.subset === 'function') return semver;
    } catch {}
  }
  throw new RootDependencyError('semver could not be loaded: run this with the Node whose npm installed the checkout, or install the dependencies first');
}

// ── lockfile trees ──

/** The folder of the package that holds `path` in its node_modules ('' for the root). */
function parentPackage(path) {
  const at = path.lastIndexOf('/node_modules/');
  return at < 0 ? '' : path.slice(0, at);
}

const depthOf = (path) => path.split('/node_modules/').length;

/** Where Node finds `name` for the package at `path`: its node_modules, then each package folder above. */
function resolveFrom(has, path, name) {
  for (let base = path; ; base = parentPackage(base)) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (has(candidate)) return candidate;
    if (!base) return null;
  }
}

const isOptionalType = (type) => type === 'optional' || type === 'peerOptional';
const isPeerType = (type) => type === 'peer' || type === 'peerOptional';

/** An entry's edges as npm builds them: peer, then prod, then optional; a later kind wins for the same name. */
function edgesOf(entry, { dev = false } = {}) {
  const edges = new Map();
  const meta = entry.peerDependenciesMeta || {};
  for (const [name, spec] of Object.entries(entry.peerDependencies || {})) edges.set(name, { name, spec, type: meta[name]?.optional ? 'peerOptional' : 'peer' });
  for (const [name, spec] of Object.entries(entry.dependencies || {})) edges.set(name, { name, spec, type: 'prod' });
  for (const [name, spec] of Object.entries(entry.optionalDependencies || {})) edges.set(name, { name, spec, type: 'optional' });
  if (dev) for (const [name, spec] of Object.entries(entry.devDependencies || {})) edges.set(name, { name, spec, type: 'dev' });
  return [...edges.values()];
}

/** Whether the locked `entry` installed as `name` is what `spec` asks for (an npm: alias included). */
function accepts(semver, entry, spec, name) {
  let range = String(spec ?? '');
  if (range.startsWith('npm:')) {
    const body = range.slice(4);
    const at = body.lastIndexOf('@');
    const wanted = at > 0 ? body.slice(0, at) : body;
    range = at > 0 ? body.slice(at + 1) : '*';
    if ((entry.name || name) !== wanted) return false;
  } else if (entry.name && entry.name !== name) {
    return false;
  }
  if (range === '' || range === '*' || range === 'latest') return true;
  const valid = semver.validRange(range, { loose: true });
  // A tag, a URL or a path: npm only asks that the package is there.
  if (!valid) return true;
  return semver.satisfies(entry.version, valid, { loose: true });
}

const sameEntry = (a, b) => a === b || (a.version === b.version && (a.name || '') === (b.name || '')
  && (a.resolved || '') === (b.resolved || '') && (a.integrity || '') === (b.integrity || ''));

/**
 * A locked package whose install scripts npm leaves alone on an install or
 * update, as the parts' own `npm install --ignore-scripts` always did.
 * A bare `npm rebuild` is another matter: it reads each package's real
 * package.json and runs those scripts, so nothing SynaBun runs or suggests is
 * one (tests/npm-invocations.test.mjs). npm reads a locked package's
 * scripts from its folder only when the entry says hasInstallScript, and it
 * compiles a package with a binding.gyp by itself unless the entry says
 * gypfile: false (npm 10 and 11, arborist rebuild). What those scripts would
 * do, nothing needs: every native package ships prebuilt binaries, and
 * node-pty is SynaBun's own postinstall's (neural-interface/scripts/rebuild-pty.js).
 * Run, they failed `npm i -g synabun` itself: onnxruntime-node's fetches a CUDA
 * payload on Linux x64 and throws for CUDA 11, sharp's builds from source when
 * it finds a system libvips, with no node-gyp in the tree.
 */
export function withoutInstallScript(entry) {
  if (!entry.hasInstallScript) return entry;
  delete entry.hasInstallScript;
  entry.gypfile = false;
  return entry;
}

/** npm's key order (json-stringify-nice): scalars and arrays before objects, preferred keys first, the rest by 'en' order. */
const PREFERRED_KEYS = ['name', 'version', 'lockfileVersion', 'resolved', 'integrity', 'requires', 'packages', 'dependencies'];
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
function compareKeys(a, b) {
  const ia = PREFERRED_KEYS.indexOf(a);
  const ib = PREFERRED_KEYS.indexOf(b);
  if (ia >= 0 || ib >= 0) return ia < 0 ? 1 : ib < 0 ? -1 : ia - ib;
  return a.localeCompare(b, 'en');
}
function sortedForNpm(value) {
  if (Array.isArray(value)) return value.map(sortedForNpm);
  if (!isObject(value)) return value;
  const entries = Object.entries(value).sort(([ak, av], [bk, bv]) => (isObject(av) === isObject(bv) ? compareKeys(ak, bk) : isObject(av) ? 1 : -1));
  return Object.fromEntries(entries.map(([key, item]) => [key, sortedForNpm(item)]));
}

/** A lockfile as npm writes one: its key order, two spaces, a final newline. */
export function formatLock(lock) {
  return `${JSON.stringify(sortedForNpm(lock), null, 2)}\n`;
}

const byName = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b, 'en')));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// ── the parts ──

/** Both parts: manifest, and the locked packages with every external tool and its edges taken out. */
export function readParts(root = DEFAULT_ROOT) {
  return PART_FOLDERS.map((folder) => {
    const manifest = readJson(join(root, folder, 'package.json'));
    const lock = readJson(join(root, folder, 'package-lock.json'));
    if (!lock.packages || lock.lockfileVersion < 2) throw new RootDependencyError(`${folder}/package-lock.json is not a lockfile npm 7 or later wrote`);
    stripExternalToolsFromLock(lock);
    const declared = lock.packages[''] || {};
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      const a = JSON.stringify(byName(manifest[field] || {}));
      const b = JSON.stringify(byName(declared[field] || {}));
      if (a !== b) throw new RootDependencyError(`${folder}/package-lock.json does not match ${folder}/package.json (${field}): run npm install --package-lock-only in ${folder}`);
    }
    return { folder, manifest, packages: lock.packages };
  });
}

/** The range for `name` when the parts ask with `specs`: the one inside all the others. */
function narrowest(semver, name, specs, what) {
  const unique = [...new Set(specs)];
  if (unique.length === 1) return unique[0];
  const inside = unique.filter(spec => unique.every(other => semver.subset(spec, other, { loose: true })));
  if (!inside.length) {
    throw new RootDependencyError(`${what} ${name}: the parts ask for ${unique.map(spec => `"${spec}"`).join(' and ')}, and neither range lies inside the other. `
      + 'One package cannot be both at the package root: make the two parts agree (or give one an npm alias), then run this again.');
  }
  return inside.sort((a, b) => a.localeCompare(b, 'en'))[0];
}

/** The four root fields the parts give. */
export function rootFields(parts, semver) {
  const wanted = new Map();
  const want = (name, spec) => { if (!wanted.has(name)) wanted.set(name, []); wanted.get(name).push(spec); };
  for (const part of parts) {
    for (const [name, spec] of Object.entries({ ...part.manifest.dependencies, ...part.manifest.optionalDependencies })) want(name, spec);
  }
  const dependencies = {};
  const optionalDependencies = {};
  for (const [name, specs] of wanted) {
    (Object.hasOwn(OPTIONAL_AT_ROOT, name) ? optionalDependencies : dependencies)[name] = narrowest(semver, name, specs, 'dependency');
  }
  const mcp = parts.find(part => part.folder === 'mcp-server');
  const devDependencies = {};
  for (const name of BUILD_TOOLS) {
    const spec = mcp?.manifest.devDependencies?.[name];
    if (!spec) throw new RootDependencyError(`mcp-server/package.json has no devDependency ${name}, which compiles the MCP server (BUILD_TOOLS)`);
    devDependencies[name] = spec;
  }
  const overrides = {};
  const overridden = new Map();
  for (const part of parts) {
    for (const [name, spec] of Object.entries(part.manifest.overrides || {})) {
      if (typeof spec !== 'string') throw new RootDependencyError(`${part.folder}/package.json overrides ${name} with an object; only a range is carried to the root`);
      if (!overridden.has(name)) overridden.set(name, []);
      overridden.get(name).push(spec);
    }
  }
  for (const [name, specs] of overridden) overrides[name] = narrowest(semver, name, specs, 'override');
  return {
    dependencies: byName(dependencies),
    optionalDependencies: byName(optionalDependencies),
    devDependencies: byName(devDependencies),
    overrides: byName(overrides),
  };
}

// ── one tree from two ──

/** What one part installs for the root's needs: its root edges (and BUILD_TOOLS for mcp-server), followed through its lockfile. */
function partClosure(part, semver, startEdges) {
  const has = (path) => Object.hasOwn(part.packages, path);
  const seen = new Set();
  const queue = [];
  const follow = (from, edge) => {
    // An optional peer is never installed for its own sake (npm does not either).
    if (edge.type === 'peerOptional') return;
    const target = resolveFrom(has, from, edge.name);
    if (!target) {
      if (isOptionalType(edge.type)) return;
      throw new RootDependencyError(`${part.folder}/package-lock.json: ${from || 'the root'} needs ${edge.name}@${edge.spec}, and the lockfile holds no copy of it`);
    }
    if (!accepts(semver, part.packages[target], edge.spec, edge.name)) {
      throw new RootDependencyError(`${part.folder}/package-lock.json: ${from || 'the root'} needs ${edge.name}@${edge.spec}, and the copy it finds is ${part.packages[target].version}`);
    }
    if (!seen.has(target)) { seen.add(target); queue.push(target); }
  };
  for (const edge of startEdges) follow('', edge);
  while (queue.length) {
    const path = queue.shift();
    for (const edge of edgesOf(part.packages[path])) follow(path, edge);
  }
  return seen;
}

/**
 * The parts' packages in one tree. A part's package counts at a path only when
 * every package folder above that path holds the same package in the part's
 * own tree (a nested copy belongs to the package around it). `forced` picks a
 * part for a conflicting path; otherwise the version the root asks for, then
 * the higher version.
 */
function mergeTrees(parts, closures, { semver, rootSpecs, forced }) {
  const byFolder = new Map(parts.map(part => [part.folder, part]));
  const contributions = new Map();
  for (const part of parts) {
    for (const path of closures.get(part.folder)) {
      if (!contributions.has(path)) contributions.set(path, []);
      contributions.get(path).push({ folder: part.folder, entry: part.packages[path] });
    }
  }
  const order = [...contributions.keys()].sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b, 'en'));
  const chosen = new Map();
  const conflicts = [];
  for (const path of order) {
    const eligible = contributions.get(path).filter(({ folder }) => {
      for (let up = parentPackage(path); up; up = parentPackage(up)) {
        const kept = chosen.get(up);
        const own = byFolder.get(folder).packages[up];
        if (!kept || !own || !sameEntry(kept.entry, own)) return false;
      }
      return true;
    });
    if (!eligible.length) continue;
    const options = [];
    for (const item of eligible) {
      const same = options.find(option => sameEntry(option.entry, item.entry));
      if (same) same.folders.push(item.folder);
      else options.push({ entry: item.entry, folders: [item.folder] });
    }
    let pick = options[0];
    if (options.length > 1) {
      const name = packageNameOfLockPath(path);
      pick = options.find(option => option.folders.includes(forced.get(path)))
        || preferredOption(options, { semver, spec: parentPackage(path) === '' ? rootSpecs.get(name) : undefined, name });
      conflicts.push({ path, name, options, pick });
    }
    chosen.set(path, { entry: pick.entry, folders: pick.folders, sourcePath: path });
  }
  return { chosen, conflicts };
}

/** Of two or more versions for one place: the one the root asks for, then the higher, then the part name. */
function preferredOption(options, { semver, spec, name }) {
  let pool = options;
  if (spec) {
    const fit = options.filter(option => accepts(semver, option.entry, spec, name));
    if (fit.length) pool = fit;
  }
  return [...pool].sort((a, b) => semver.rcompare(a.entry.version, b.entry.version, { loose: true }) || a.folders[0].localeCompare(b.folders[0], 'en'))[0];
}

/** The edges that end at `path` in the tree (the root's included): what a version there has to suit. */
function edgesInto(chosen, path, rootEdges) {
  const has = (candidate) => chosen.has(candidate);
  const name = packageNameOfLockPath(path);
  const found = [];
  if (parentPackage(path) === '') for (const edge of rootEdges) if (edge.name === name) found.push(edge);
  for (const [from, node] of chosen) {
    if (from === path) continue;
    for (const edge of edgesOf(node.entry)) if (edge.name === name && resolveFrom(has, from, name) === path) found.push(edge);
  }
  return found;
}

/**
 * Build npm-shrinkwrap.json for `rootManifest` (the root package.json with its
 * ROOT_FIELDS already set) from `parts`. Returns { lock, report }; throws a
 * RootDependencyError when the parts cannot give one valid tree.
 */
export function buildShrinkwrap(rootManifest, parts, semver) {
  const rootEntry = {
    name: rootManifest.name,
    version: rootManifest.version,
    ...(['preinstall', 'install', 'postinstall'].some(script => rootManifest.scripts?.[script]) ? { hasInstallScript: true } : {}),
    ...(rootManifest.license ? { license: rootManifest.license } : {}),
    ...(Object.keys(rootManifest.dependencies || {}).length ? { dependencies: rootManifest.dependencies } : {}),
    ...(Object.keys(rootManifest.devDependencies || {}).length ? { devDependencies: rootManifest.devDependencies } : {}),
    ...(Object.keys(rootManifest.optionalDependencies || {}).length ? { optionalDependencies: rootManifest.optionalDependencies } : {}),
    ...(rootManifest.bin ? { bin: rootManifest.bin } : {}),
    ...(rootManifest.engines ? { engines: rootManifest.engines } : {}),
  };
  const rootEdges = edgesOf(rootEntry, { dev: true });
  const rootSpecs = new Map(rootEdges.map(edge => [edge.name, edge.spec]));

  // What each part installs for the root: its own dependencies, and mcp-server's build tools.
  const closures = new Map();
  for (const part of parts) {
    const own = edgesOf(part.manifest).filter(edge => rootSpecs.has(edge.name));
    const tools = part.folder === 'mcp-server'
      ? BUILD_TOOLS.map(name => ({ name, spec: part.manifest.devDependencies[name], type: 'dev' }))
      : [];
    closures.set(part.folder, partClosure(part, semver, [...own, ...tools]));
  }

  // Merge; then, for each place the parts disagree on, keep the version most of its dependents accept.
  const forced = new Map();
  let merged = mergeTrees(parts, closures, { semver, rootSpecs, forced });
  for (let round = 0; round < 12; round++) {
    let changed = false;
    for (const conflict of merged.conflicts) {
      const into = edgesInto(merged.chosen, conflict.path, rootEdges);
      const score = (option) => into.filter(edge => accepts(semver, option.entry, edge.spec, conflict.name)).length;
      const top = Math.max(...conflict.options.map(score));
      const best = preferredOption(conflict.options.filter(option => score(option) === top), {
        semver, spec: parentPackage(conflict.path) === '' ? rootSpecs.get(conflict.name) : undefined, name: conflict.name,
      });
      if (best !== conflict.pick) { forced.set(conflict.path, best.folders[0]); changed = true; }
    }
    if (!changed) break;
    merged = mergeTrees(parts, closures, { semver, rootSpecs, forced });
  }
  const { chosen, conflicts } = merged;
  const byFolder = new Map(parts.map(part => [part.folder, part]));
  const has = (path) => chosen.has(path);

  // A dependent the kept version does not suit gets the copy its own lockfile gave it, inside its folder.
  const nested = [];
  for (let round = 0; ; round++) {
    if (round > 50) throw new RootDependencyError('the merged tree did not settle after 50 rounds of nesting');
    let changed = false;
    for (const edge of rootEdges) {
      const target = resolveFrom(has, '', edge.name);
      if (target && accepts(semver, chosen.get(target).entry, edge.spec, edge.name)) continue;
      if (!target && isOptionalType(edge.type)) continue;
      throw new RootDependencyError(`the root asks for ${edge.name}@${edge.spec}, and neither part's lockfile places a version of it that fits at the root`);
    }
    for (const [path, node] of [...chosen].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      for (const edge of edgesOf(node.entry)) {
        const target = resolveFrom(has, path, edge.name);
        if (target && accepts(semver, chosen.get(target).entry, edge.spec, edge.name)) continue;
        // A missing optional dependency (another platform's binary) is what npm expects; a missing peer is installed.
        if (!target && isOptionalType(edge.type)) continue;
        let source = null;
        for (const folder of node.folders) {
          const part = byFolder.get(folder);
          const own = resolveFrom((candidate) => Object.hasOwn(part.packages, candidate), node.sourcePath, edge.name);
          if (own && accepts(semver, part.packages[own], edge.spec, edge.name)) { source = { folder, path: own, entry: part.packages[own] }; break; }
        }
        if (!source) {
          throw new RootDependencyError(`${path} needs ${edge.name}@${edge.spec}; ${target ? `the tree has ${chosen.get(target).entry.version}` : 'the tree has none'}, and its own lockfile (${node.folders.join(', ')}) has nothing that fits`);
        }
        const place = `${path}/node_modules/${edge.name}`;
        if (chosen.has(place)) throw new RootDependencyError(`${edge.name}@${source.entry.version} cannot go inside ${path}: ${chosen.get(place).entry.version} is already there`);
        chosen.set(place, { entry: source.entry, folders: [source.folder], sourcePath: source.path });
        nested.push({ path: place, version: source.entry.version, for: path, wanted: edge.spec });
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Only what the root reaches stays; then npm's flags, from how each package is reached.
  const reach = (rootEdge, edge) => {
    const seen = new Set();
    const queue = [];
    const visit = (from, item) => {
      const target = resolveFrom(has, from, item.name);
      if (target && !seen.has(target)) { seen.add(target); queue.push(target); }
    };
    for (const item of rootEdges) if (rootEdge(item)) visit('', item);
    while (queue.length) {
      const path = queue.shift();
      for (const item of edgesOf(chosen.get(path).entry)) if (edge(item)) visit(path, item);
    }
    return seen;
  };
  const any = () => true;
  const notDev = (item) => item.type !== 'dev';
  const notOptional = (item) => !isOptionalType(item.type);
  const notPeer = (item) => !isPeerType(item.type);
  const reached = reach(any, any);
  const pruned = [...chosen.keys()].filter(path => !reached.has(path));
  for (const path of pruned) chosen.delete(path);
  const prod = reach(notDev, any);
  const required = reach(notOptional, notOptional);
  const prodRequired = reach(item => notDev(item) && notOptional(item), notOptional);
  const nonPeer = reach(notPeer, notPeer);

  const packages = { '': rootEntry };
  const scriptsLeftOut = [];
  for (const path of [...chosen.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    const entry = withoutInstallScript({ ...chosen.get(path).entry });
    if (entry.gypfile === false) scriptsLeftOut.push(path);
    for (const flag of ['dev', 'optional', 'devOptional', 'peer', 'extraneous']) delete entry[flag];
    const dev = !prod.has(path);
    const optional = !required.has(path);
    if (dev) entry.dev = true;
    if (optional) entry.optional = true;
    if (!dev && !optional && !prodRequired.has(path)) entry.devOptional = true;
    if (!nonPeer.has(path)) entry.peer = true;
    packages[path] = entry;
  }

  // Every edge of the result holds, optional peers included when their package is there.
  for (const [path, entry] of Object.entries(packages)) {
    for (const edge of edgesOf(entry, { dev: path === '' })) {
      const target = resolveFrom((candidate) => Object.hasOwn(packages, candidate) && candidate !== '', path, edge.name);
      if (!target) {
        if (isOptionalType(edge.type)) continue;
        throw new RootDependencyError(`internal: ${path || 'the root'} is left without ${edge.name}@${edge.spec}`);
      }
      if (!accepts(semver, packages[target], edge.spec, edge.name)) throw new RootDependencyError(`internal: ${path || 'the root'} gets ${edge.name}@${packages[target].version}, not ${edge.spec}`);
    }
  }

  const lock = { name: rootManifest.name, version: rootManifest.version, lockfileVersion: 3, requires: true, packages };
  const report = {
    packages: Object.keys(packages).length - 1,
    conflicts: conflicts.map(conflict => ({
      path: conflict.path,
      kept: `${chosen.get(conflict.path)?.entry.version ?? '(not needed)'}`,
      options: conflict.options.map(option => `${option.entry.version} (${option.folders.join(', ')})`),
    })),
    nested,
    pruned: pruned.length,
    scriptsLeftOut,
  };
  return { lock, report };
}

// ── the root files ──

/** The root package.json with ROOT_FIELDS set (other keys kept in their order; a new field after "scripts"). */
export function withRootFields(manifest, fields) {
  const keys = Object.keys(manifest);
  const result = {};
  const place = (key) => { if (Object.keys(fields[key] || {}).length) result[key] = fields[key]; };
  let placed = false;
  for (const key of keys) {
    if (ROOT_FIELDS.includes(key)) {
      if (!placed) { for (const field of ROOT_FIELDS) place(field); placed = true; }
      continue;
    }
    result[key] = manifest[key];
    if (key === 'scripts' && !placed) { for (const field of ROOT_FIELDS) place(field); placed = true; }
  }
  if (!placed) for (const field of ROOT_FIELDS) place(field);
  return result;
}

/** What the root files should be: { manifest, lock, report }. */
export function expectedRootFiles(root = DEFAULT_ROOT, { semver = loadSemver(root) } = {}) {
  const parts = readParts(root);
  const current = readJson(join(root, 'package.json'));
  const manifest = withRootFields(current, rootFields(parts, semver));
  const { lock, report } = buildShrinkwrap(manifest, parts, semver);
  return { manifest, lock, report };
}

const canonical = (value) => JSON.stringify(sortedForNpm(value));

/** Differences between the root files and what the parts give: [] when they agree. */
export function rootDependencyDrift(root = DEFAULT_ROOT, options = {}) {
  const { manifest, lock } = expectedRootFiles(root, options);
  const problems = [];
  const current = readJson(join(root, 'package.json'));
  for (const field of ROOT_FIELDS) {
    if (canonical(current[field] || {}) !== canonical(manifest[field] || {})) problems.push(`package.json "${field}" is not what mcp-server/ and neural-interface/ give`);
  }
  if (existsSync(join(root, 'package-lock.json'))) problems.push('package-lock.json is at the root: npm-shrinkwrap.json is the root lockfile (npm reads only that one inside an installed package)');
  const file = join(root, SHRINKWRAP);
  if (!existsSync(file)) {
    problems.push(`${SHRINKWRAP} is missing`);
  } else {
    let actual;
    try { actual = readJson(file); } catch (error) { problems.push(`${SHRINKWRAP} is not JSON: ${error.message}`); }
    if (actual) {
      for (const key of ['name', 'version', 'lockfileVersion']) if (actual[key] !== lock[key]) problems.push(`${SHRINKWRAP} ${key} is ${JSON.stringify(actual[key])}, not ${JSON.stringify(lock[key])}`);
      const have = actual.packages || {};
      const want = lock.packages;
      const scripted = Object.keys(have).filter(path => path && (have[path]?.hasInstallScript || (want[path]?.gypfile === false && have[path]?.gypfile !== false)));
      if (scripted.length) {
        problems.push(`${SHRINKWRAP} lets npm run the install scripts of ${scripted.slice(0, 8).join(', ')}${scripted.length > 8 ? ` and ${scripted.length - 8} more` : ''}: `
          + 'only lib/root-dependencies.mjs writes this file (an npm install at the root rewrites it without the flags that keep them off)');
      }
      const paths = [...new Set([...Object.keys(have), ...Object.keys(want)])].sort((a, b) => a.localeCompare(b, 'en'));
      const changed = paths.filter(path => canonical(have[path] ?? null) !== canonical(want[path] ?? null));
      for (const path of changed.slice(0, 20)) {
        const label = path || '(root entry)';
        problems.push(!have[path] ? `${SHRINKWRAP} lacks ${label} ${want[path].version || ''}`.trim()
          : !want[path] ? `${SHRINKWRAP} has ${label} ${have[path].version || ''}, which the parts do not install`.trim()
            : `${SHRINKWRAP} ${label}: ${have[path].version || ''} differs from what the parts give (${want[path].version || ''})`);
      }
      if (changed.length > 20) problems.push(`… and ${changed.length - 20} more entries of ${SHRINKWRAP}`);
    }
  }
  return problems;
}

/** Write the root package.json fields and npm-shrinkwrap.json. Returns the report and what changed. */
export function writeRootDependencies(root = DEFAULT_ROOT, options = {}) {
  const { manifest, lock, report } = expectedRootFiles(root, options);
  const written = [];
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (readFileSync(join(root, 'package.json'), 'utf8') !== manifestText) { writeFileSync(join(root, 'package.json'), manifestText); written.push('package.json'); }
  const lockText = formatLock(lock);
  const lockFile = join(root, SHRINKWRAP);
  if (!existsSync(lockFile) || readFileSync(lockFile, 'utf8') !== lockText) { writeFileSync(lockFile, lockText); written.push(SHRINKWRAP); }
  return { report, written };
}

// ── command line ──

function main(argv) {
  const at = argv.indexOf('--root');
  const root = at >= 0 ? resolve(argv[at + 1]) : DEFAULT_ROOT;
  const json = argv.includes('--json');
  try {
    if (argv.includes('--write')) {
      const { report, written } = writeRootDependencies(root);
      if (json) { console.log(JSON.stringify({ ...report, written }, null, 2)); return 0; }
      console.log(`root dependencies: ${report.packages} packages pinned in ${SHRINKWRAP}; ${written.length ? `wrote ${written.join(', ')}` : 'already current'}`);
      for (const item of report.conflicts) console.log(`  ${item.path}: kept ${item.kept} of ${item.options.join(' / ')}`);
      for (const item of report.nested) console.log(`  ${item.path}: ${item.version} for ${item.for} (${item.wanted})`);
      if (report.scriptsLeftOut.length) console.log(`  install scripts npm leaves alone: ${report.scriptsLeftOut.map(path => path.replace(/^node_modules\//, '')).join(', ')}`);
      if (existsSync(join(root, 'package-lock.json'))) console.log('  note: remove the root package-lock.json; npm-shrinkwrap.json replaces it');
      return 0;
    }
    if (argv.includes('--check')) {
      const problems = rootDependencyDrift(root);
      if (!problems.length) { console.log(`root dependencies: package.json and ${SHRINKWRAP} match mcp-server/ and neural-interface/`); return 0; }
      console.error(`root dependencies drifted from mcp-server/ and neural-interface/:\n${problems.map(problem => `  - ${problem}`).join('\n')}\nRun: node lib/root-dependencies.mjs --write`);
      return 1;
    }
    console.error('Usage: node lib/root-dependencies.mjs --write | --check [--root <dir>] [--json]');
    return 64;
  } catch (error) {
    if (!(error instanceof RootDependencyError)) throw error;
    console.error(`root dependencies: ${error.message}`);
    return 1;
  }
}

// Node gives a module its real path: started through a link (macOS /var, /tmp), the command must still run, or
// --check would end with 0 having checked nothing.
const startedAs = (file) => { try { return pathToFileURL(realpathSync(file)).href; } catch { return pathToFileURL(resolve(file)).href; } };
if (process.argv[1] && import.meta.url === startedAs(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
