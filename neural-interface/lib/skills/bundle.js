// ── Skill bundles: export, and import through a staging area ──
// A bundle is a JSON document (`synabun-skill-bundle`) holding one skill folder, or one command or agent file
// with its icon. Version 2, written by the export, keeps every file byte for byte: text as text, anything else
// as base64, each with its size, its SHA-256 and whether it is executable, plus the folders (an empty one too)
// and the entries it left out on purpose (hidden files, node_modules) with the reason. Version 1, written before,
// is still read; it never carried modes or hashes.
//
// An import never writes into a folder Claude Code, Codex or OpenCode reads skills from. It is checked whole
// first (format, version, type, name, the head file, every path, every value, sizes, two names for one file),
// then written into a staging folder under the data home (DATA_HOME/data/skills/staging/<id>/), scanned
// (lib/skills/scan.js) and linted, and answered with what it is: its files, its digest, the scan's findings, the
// problems, what it would collide with. Installing it is a second request that names the staged digest: the
// files are read again from staging and must still be exactly those bytes, the scan must be of them and allow
// it (a review gate needs the person's confirmation of that digest), and the files are written into place all or
// nothing. Nothing of a staged import runs, loads or is sent anywhere.

import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PathConfineError, isInside, isPlainName, realPathOf } from '../path-confine.js';
import { canonicalInside, makeConfinedDir, readConfinedFile, writeConfinedFile } from '../confined-fs.js';
import { SYSTEM_NAMES, fileEntry, manifestDigest, readManifest, sha256 } from './digest.js';
import { findHiddenChars } from '../../public/shared/skills/ss-unicode.js';
import { isEditableText } from '../../public/shared/skills/ss-doc.js';

export const BUNDLE_FORMAT = 'synabun-skill-bundle';
export const BUNDLE_VERSION = 2;
export const BUNDLE_TYPES = Object.freeze(['skill', 'command', 'agent']);
export const BUNDLE_LIMITS = Object.freeze({
  maxEntries: 2000,
  maxDepth: 16,
  maxPathChars: 512,
  maxSegmentBytes: 255,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 18 * 1024 * 1024,     // decoded; with base64 and JSON around it, a bundle stays under the 25 MB request limit
  maxHeadBytes: 2 * 1024 * 1024,       // the head file is read whole by the library: bigger, and it would not be listed
  maxJsonChars: 24 * 1024 * 1024,      // an export longer than this could not be imported again
  maxNameChars: 128,
  stagingTtlMs: 24 * 60 * 60 * 1000,
});
export const ICON_EXTENSIONS = Object.freeze(['.png', '.svg', '.jpg', '.jpeg', '.webp']);

export class BundleError extends PathConfineError {
  constructor(status, message, { code = 'invalid_bundle', problems = [] } = {}) {
    super(status, message);
    this.code = code;
    this.problems = problems;
  }
}

/** Why a path inside a bundle cannot be written, or null. Portable rules: what one system writes, all can. */
export function bundlePathProblem(rel, { maxDepth = BUNDLE_LIMITS.maxDepth, maxPathChars = BUNDLE_LIMITS.maxPathChars, maxSegmentBytes = BUNDLE_LIMITS.maxSegmentBytes } = {}) {
  if (typeof rel !== 'string' || rel === '') return 'it is empty';
  if (rel.length > maxPathChars) return `it is longer than ${maxPathChars} characters`;
  if (rel.includes('\0')) return 'it holds a NUL character';
  if (rel.includes('\\')) return 'it holds a backslash';
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return 'it is absolute';
  const segments = rel.split('/');
  if (segments.length > maxDepth) return `it is more than ${maxDepth} folders deep`;
  for (const seg of segments) {
    if (seg === '') return 'it has an empty part (//)';
    if (seg === '.' || seg === '..') return 'it climbs out of its folder (. or ..)';
    if (Buffer.byteLength(seg, 'utf8') > maxSegmentBytes) return `a part is longer than ${maxSegmentBytes} bytes`;
    if (/[\u0000-\u001F\u007F-\u009F]/.test(seg)) return 'it holds a control character';
    if (findHiddenChars(seg, { identifier: true }).length) return 'it holds a character nobody can see';
    if (/[<>:"|?*]/.test(seg)) return 'it holds a character Windows cannot store (< > : " | ? *)';
    if (/[ .]$/.test(seg)) return 'a part ends with a dot or a space';
    if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(seg)) return 'a part is a name Windows reserves';
  }
  return null;
}

/** Why a name cannot be what an artifact is installed under, or null. */
export function bundleNameProblem(name) {
  if (typeof name !== 'string' || !name) return 'it is empty';
  if (!isPlainName(name)) return 'it is not one plain name';
  if (name.length > BUNDLE_LIMITS.maxNameChars) return `it is longer than ${BUNDLE_LIMITS.maxNameChars} characters`;
  if (name.startsWith('.')) return 'it starts with a dot';
  return bundlePathProblem(name, { maxDepth: 1 });
}

// One character class, no nested repetition: a regular expression that stays linear on a 20 MB string.
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

/** Canonical base64 only (what Buffer writes back is what was sent), or null. */
export function decodeBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_CHARS.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

const fold = (p) => String(p).normalize('NFC').toLowerCase();

/**
 * Check a bundle and decode it. Nothing is written.
 * @returns {{ type, name, version, files: { path, bytes, executable }[], dirs: string[], excluded: object[], head: string, digest: string, entries: object[] }}
 * @throws {BundleError} 400 with every problem found (`problems: [{ path, message }]`)
 */
export function readBundle(bundle, limits = BUNDLE_LIMITS) {
  const problems = [];
  const fail = (message, code = 'invalid_bundle') => { throw new BundleError(400, message, { code, problems }); };
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) fail('That is not a SynaBun skill bundle.');
  if (bundle.format !== BUNDLE_FORMAT) fail('That is not a SynaBun skill bundle.');
  const version = bundle.version;
  if (version !== 1 && version !== 2) fail(`Bundle version ${JSON.stringify(version ?? null)} is not one this SynaBun reads (1 or 2).`, 'unsupported_version');
  const { type, name } = bundle;
  if (!BUNDLE_TYPES.includes(type)) fail('The bundle\'s type must be skill, command or agent.');
  const nameProblem = bundleNameProblem(name);
  if (nameProblem) fail(`The bundle's name cannot be used: ${nameProblem}.`, 'invalid_name');
  const files = bundle.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) fail('The bundle holds no files.');
  const keys = Object.keys(files);
  if (!keys.length) fail('The bundle holds no files.');
  if (keys.length > limits.maxEntries) fail(`The bundle holds ${keys.length} files; the limit is ${limits.maxEntries}.`, 'too_large');

  const out = [];
  const dropped = [];
  let total = 0;
  for (const rel of keys) {
    // A file the system writes by itself (.DS_Store…) is not part of a skill: left out, and said so.
    if (typeof rel === 'string' && SYSTEM_NAMES.has(rel.split('/').pop())) { dropped.push({ path: rel, reason: 'system file' }); continue; }
    const pathProblem = bundlePathProblem(rel, limits);
    if (pathProblem) { problems.push({ path: rel, message: `This path cannot be written: ${pathProblem}.` }); continue; }
    if (type !== 'skill' && rel.includes('/')) { problems.push({ path: rel, message: 'A command or an agent bundle holds files of one folder only.' }); continue; }
    const value = files[rel];
    let bytes = null; let executable = false;
    if (version === 1) {
      if (typeof value === 'string') bytes = Buffer.from(value, 'utf-8');
      else if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.base64 === 'string') {
        bytes = decodeBase64(value.base64);
        if (!bytes) { problems.push({ path: rel, message: 'Its base64 content is not valid.' }); continue; }
      } else { problems.push({ path: rel, message: 'Its content is neither text nor { base64 }.' }); continue; }
    } else {
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.data !== 'string') { problems.push({ path: rel, message: 'Its entry is not { encoding, data, size, sha256 }.' }); continue; }
      if (value.encoding === 'utf-8') bytes = Buffer.from(value.data, 'utf-8');
      else if (value.encoding === 'base64') {
        bytes = decodeBase64(value.data);
        if (!bytes) { problems.push({ path: rel, message: 'Its base64 content is not valid.' }); continue; }
      } else { problems.push({ path: rel, message: `Its encoding ${JSON.stringify(value.encoding ?? null)} is not utf-8 or base64.` }); continue; }
      if (value.size !== undefined && value.size !== bytes.length) { problems.push({ path: rel, message: `It says ${value.size} bytes but holds ${bytes.length}.` }); continue; }
      if (value.sha256 !== undefined && value.sha256 !== sha256(bytes)) { problems.push({ path: rel, message: 'Its content does not match its SHA-256: it was changed or damaged.' }); continue; }
      if (value.executable !== undefined && typeof value.executable !== 'boolean') { problems.push({ path: rel, message: '"executable" must be true or false.' }); continue; }
      executable = value.executable === true;
    }
    if (bytes.length > limits.maxFileBytes) { problems.push({ path: rel, message: `It is larger than ${Math.round(limits.maxFileBytes / (1024 * 1024))} MB.` }); continue; }
    total += bytes.length;
    out.push({ path: rel, bytes, executable });
  }
  if (total > limits.maxTotalBytes) problems.push({ path: null, message: `The bundle holds ${Math.round(total / (1024 * 1024))} MB; the limit is ${Math.round(limits.maxTotalBytes / (1024 * 1024))} MB.` });

  // Folders: the ones it names (an empty folder is kept), and every folder on the way to a file.
  const dirs = new Set();
  if (version === 2 && bundle.dirs !== undefined) {
    if (!Array.isArray(bundle.dirs)) problems.push({ path: null, message: '"dirs" must be a list of folders.' });
    else for (const d of bundle.dirs) {
      const p = bundlePathProblem(d, limits);
      if (p) problems.push({ path: String(d), message: `This folder cannot be made: ${p}.` });
      else if (type !== 'skill') problems.push({ path: d, message: 'A command or an agent bundle holds no folders.' });
      else dirs.add(d);
    }
  }
  for (const f of out) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  // Two names for one entry on a volume that ignores case and Unicode form, or a file where a folder must be.
  const seen = new Map();
  for (const p of [...out.map((f) => f.path), ...dirs]) {
    const key = fold(p);
    if (seen.has(key) && seen.get(key) !== p) problems.push({ path: p, message: `"${p}" and "${seen.get(key)}" name the same entry on macOS and Windows.` });
    else seen.set(key, p);
  }
  const fileKeys = new Set(out.map((f) => fold(f.path)));
  for (const d of dirs) if (fileKeys.has(fold(d))) problems.push({ path: d, message: `"${d}" is both a file and a folder.` });

  // The head file: what makes it a skill, a command or an agent.
  const headPath = type === 'skill' ? 'SKILL.md' : `${name}.md`;
  const head = out.find((f) => f.path === headPath);
  if (!head) { if (!problems.some((p) => p.path === headPath)) problems.push({ path: headPath, message: `The bundle has no ${headPath}: it would not be found as a ${type}.` }); }
  else if (!isEditableText(head.bytes)) problems.push({ path: headPath, message: `${headPath} is not UTF-8 text.` });
  else if (head.bytes.length > limits.maxHeadBytes) problems.push({ path: headPath, message: `${headPath} is larger than ${Math.round(limits.maxHeadBytes / (1024 * 1024))} MB: the library could not list it.` });
  if (type !== 'skill') {
    const icons = new Set(ICON_EXTENSIONS.map((ext) => `${name}.icon${ext}`));
    for (const f of out) if (f.path !== headPath && !icons.has(f.path)) problems.push({ path: f.path, message: `A ${type} bundle holds ${headPath} and its icon only.` });
  }
  if (problems.length) {
    throw new BundleError(400, problems.length === 1 ? `The bundle cannot be imported: ${problems[0].path ? `${problems[0].path}: ` : ''}${problems[0].message}` : `The bundle cannot be imported: ${problems.length} problems.`, { problems });
  }
  const entries = [...[...dirs].map((d) => ({ path: d, type: 'dir' })), ...out.map((f) => fileEntry(f.path, f.bytes, { executable: f.executable }))];
  return {
    type, name, version, files: out.sort((a, b) => (a.path < b.path ? -1 : 1)), dirs: [...dirs].sort(),
    excluded: [...dropped, ...(Array.isArray(bundle.excluded) ? bundle.excluded.filter((e) => e && typeof e.path === 'string').slice(0, 200).map((e) => ({ path: String(e.path).slice(0, 512), reason: String(e.reason ?? '').slice(0, 64) })) : [])],
    head: head.bytes.toString('utf-8'), headPath, digest: manifestDigest(entries), entries,
  };
}

/**
 * A version 2 bundle of an artifact's files.
 * @param {{ type, name, files: { path, bytes, executable }[], dirs?: string[], excluded?: { path, reason }[] }} o
 * @returns {{ bundle: object, json: string, digest: string }}
 * @throws {BundleError} 413 when the bundle could not be imported again
 */
export function buildBundle({ type, name, files, dirs = [], excluded = [] }, limits = BUNDLE_LIMITS) {
  const entries = [];
  // No prototype: a file named `__proto__` (or `constructor`) is a file of the bundle like any other.
  const out = Object.create(null);
  let total = 0;
  for (const f of files.slice().sort((a, b) => (a.path < b.path ? -1 : 1))) {
    total += f.bytes.length;
    const text = isEditableText(f.bytes);
    out[f.path] = {
      encoding: text ? 'utf-8' : 'base64', data: text ? f.bytes.toString('utf-8') : f.bytes.toString('base64'),
      size: f.bytes.length, sha256: sha256(f.bytes), ...(f.executable ? { executable: true } : {}),
    };
    entries.push(fileEntry(f.path, f.bytes, { executable: f.executable }));
  }
  const allDirs = new Set(dirs);
  for (const f of files) { const parts = f.path.split('/'); for (let i = 1; i < parts.length; i++) allDirs.add(parts.slice(0, i).join('/')); }
  for (const d of allDirs) entries.push({ path: d, type: 'dir' });
  const digest = manifestDigest(entries);
  const bundle = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, type, name, digest, files: out, dirs: [...allDirs].sort(), excluded };
  if (total > limits.maxTotalBytes || files.length > limits.maxEntries) throw new BundleError(413, 'This is too large to export as one bundle: it could not be imported again.', { code: 'too_large' });
  const json = JSON.stringify(bundle, null, 2);
  if (json.length > limits.maxJsonChars) throw new BundleError(413, 'This is too large to export as one bundle: it could not be imported again.', { code: 'too_large' });
  return { bundle, json, digest };
}

/**
 * The files of a skill folder for an export: every regular file and folder, each by its own name. A link is
 * never followed, wherever it leads (`notes.md -> .env` would export the secret under another name, `vendor ->
 * node_modules` a dependency tree): it is left out and named, like hidden entries, node_modules, system files
 * and special files. The limits of an import hold while the folder is read, from each entry's size before its
 * bytes are: a folder too large to be imported again is refused (413) without being read into memory.
 */
export function collectFolder(realBase, limits = BUNDLE_LIMITS) {
  const files = []; const dirs = []; const excluded = [];
  let total = 0; let count = 0;
  const tooLarge = (message) => new BundleError(413, message, { code: 'too_large' });
  const megabytes = (n) => `${Math.round(n / (1024 * 1024))} MB`;
  const walk = (realDir, rel, depth, names) => {
    for (const name of names.sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const left = name.startsWith('.') ? 'hidden' : name === 'node_modules' ? 'node_modules' : SYSTEM_NAMES.has(name) ? 'system file' : null;
      if (left) { excluded.push({ path, reason: left }); continue; }
      const full = join(realDir, name);
      let st;
      try { st = lstatSync(full); } catch { excluded.push({ path, reason: 'unreadable' }); continue; }
      if (st.isSymbolicLink()) { excluded.push({ path, reason: 'link' }); continue; }
      if (!st.isDirectory() && !st.isFile()) { excluded.push({ path, reason: 'not a regular file' }); continue; }
      if (++count > limits.maxEntries) throw tooLarge(`This skill has more than ${limits.maxEntries} files and folders: it could not be imported again as one bundle.`);
      if (st.isDirectory()) {
        if (depth + 1 >= limits.maxDepth) throw tooLarge(`"${path}" is more than ${limits.maxDepth} folders deep: it could not be imported again.`);
        let children;
        try { children = readdirSync(full); } catch { excluded.push({ path, reason: 'unreadable' }); continue; }
        dirs.push(path);
        walk(full, path, depth + 1, children);
        continue;
      }
      if (st.size > limits.maxFileBytes) throw tooLarge(`"${path}" is larger than ${megabytes(limits.maxFileBytes)}: it could not be imported again.`);
      if (total + st.size > limits.maxTotalBytes) throw tooLarge(`This skill holds more than ${megabytes(limits.maxTotalBytes)}: it could not be imported again as one bundle.`);
      // Opened without following a link (one put there since the look above is refused), and bounded: a file
      // that grew since is not read past the limit.
      const bytes = readConfinedFile(realBase, full, { maxBytes: limits.maxFileBytes });
      total += bytes.length;
      if (total > limits.maxTotalBytes) throw tooLarge(`This skill holds more than ${megabytes(limits.maxTotalBytes)}: it could not be imported again as one bundle.`);
      files.push({ path, bytes, executable: (st.mode & 0o111) !== 0 });
    }
  };
  let top;
  try { top = readdirSync(realBase); } catch (err) { throw new BundleError(500, `The skill's folder could not be read (${err.code || err.message}).`, { code: 'unreadable' }); }
  walk(realBase, '', 0, top);
  return { files, dirs, excluded };
}

// ── Staging ──

const STAGING_ID_RE = /^[0-9a-f]{24}$/;

/**
 * The staging area of imports.
 * @param {object} o
 * @param {string} o.dir DATA_HOME/data/skills/staging
 * @param {() => string[]} [o.liveRoots] every folder a runtime reads skills from: staging is refused inside one
 */
export function createImportStaging({ dir, liveRoots = () => [], now = () => Date.now(), random = () => randomBytes(12).toString('hex') }) {
  function ensureOutsideLiveRoots() {
    // Where it would be, links resolved, is checked before anything is made: not even an empty folder is put
    // where a runtime reads skills from.
    let planned;
    try { planned = realPathOf(dir); } catch (err) { throw new BundleError(500, `The staging folder cannot be used: ${err.message}`, { code: 'staging_unavailable' }); }
    const unsafe = (place) => {
      for (const root of liveRoots()) {
        let rootReal;
        try { rootReal = realPathOf(root); } catch { continue; }
        if (isInside(rootReal, place, { allowRoot: true }) || isInside(place, rootReal, { allowRoot: true })) return rootReal;
      }
      return null;
    };
    const refuse = (place, root) => new BundleError(500, `The staging folder (${place}) is inside a folder a runtime reads skills from (${root}): imports are refused until the data home moves.`, { code: 'staging_unsafe' });
    const before = unsafe(planned);
    if (before) throw refuse(planned, before);
    let real;
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); real = realpathSync(dir); } catch (err) { throw new BundleError(500, `The staging folder cannot be made: ${err.message}`, { code: 'staging_unavailable' }); }
    const after = unsafe(real);
    if (after) throw refuse(real, after);
    return real;
  }

  function prune(real) {
    let names = [];
    try { names = readdirSync(real); } catch { return; }
    for (const n of names) {
      if (!STAGING_ID_RE.test(n)) continue;
      try {
        const meta = JSON.parse(readFileSync(join(real, n, 'staging.json'), 'utf8'));
        if (now() - Date.parse(meta.stagedAt) > BUNDLE_LIMITS.stagingTtlMs) rmSync(join(real, n), { recursive: true, force: true });
      } catch {
        try { if (now() - lstatSync(join(real, n)).mtimeMs > BUNDLE_LIMITS.stagingTtlMs) rmSync(join(real, n), { recursive: true, force: true }); } catch { /* next time */ }
      }
    }
  }

  /**
   * Put a checked bundle into staging. @param {object} read readBundle()'s result @param {object} meta what the
   * install will need (scope, destination, scan, lint…), stored beside the files
   * @returns {string} the staging id
   */
  function stage(read, meta) {
    const real = ensureOutsideLiveRoots();
    prune(real);
    const id = random();
    if (!STAGING_ID_RE.test(id)) throw new BundleError(500, 'Bad staging id.');
    const home = join(real, id);
    mkdirSync(home, { mode: 0o700 });
    const filesDir = join(home, 'files');
    mkdirSync(filesDir, { mode: 0o700 });
    try {
      for (const d of read.dirs) makeConfinedDir(filesDir, join(filesDir, d));
      // Staged files are never executable: what they would be is in the manifest, and is applied on install.
      for (const f of read.files) writeConfinedFile(filesDir, join(filesDir, f.path), f.bytes, { exclusive: true, mode: 0o600 });
      const record = {
        schemaVersion: 1, stagingId: id, stagedAt: new Date(now()).toISOString(), type: read.type, name: read.name, version: read.version,
        digest: read.digest, headPath: read.headPath,
        manifest: read.entries.map((e) => (e.type === 'dir' ? { path: e.path, type: 'dir' } : { path: e.path, type: 'file', size: e.size, sha256: e.sha256, executable: !!e.executable })),
        excluded: read.excluded, ...meta,
      };
      writeConfinedFile(home, join(home, 'staging.json'), `${JSON.stringify(record, null, 2)}\n`, { exclusive: true, mode: 0o600 });
      return id;
    } catch (err) {
      rmSync(home, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * A staged import, its files read again from staging and checked against its manifest.
   * @returns {{ record: object, files: { path, bytes, executable }[], dirs: string[], digest: string }}
   */
  function load(id) {
    if (typeof id !== 'string' || !STAGING_ID_RE.test(id)) throw new BundleError(400, 'Not a staging id.', { code: 'invalid_staging_id' });
    const real = ensureOutsideLiveRoots();
    const home = join(real, id);
    let record;
    try { record = JSON.parse(readConfinedFile(home, join(home, 'staging.json'), { maxBytes: 4 * 1024 * 1024, encoding: 'utf-8' })); } catch { throw new BundleError(404, 'That import is no longer staged: import it again.', { code: 'staging_gone' }); }
    const filesDir = join(home, 'files');
    const files = []; const dirs = [];
    for (const e of record.manifest || []) {
      if (e.type === 'dir') { dirs.push(e.path); continue; }
      const bytes = readConfinedFile(filesDir, join(filesDir, e.path), { maxBytes: BUNDLE_LIMITS.maxFileBytes });
      files.push({ path: e.path, bytes, executable: !!e.executable });
    }
    const entries = [...dirs.map((d) => ({ path: d, type: 'dir' })), ...files.map((f) => fileEntry(f.path, f.bytes, { executable: f.executable }))];
    const digest = manifestDigest(entries);
    // What is in staging now must be what was staged (and nothing more).
    const onDisk = readManifest(filesDir);
    const stagedNow = onDisk.entries.map((e) => (e.type === 'file' ? { ...e, executable: !!(record.manifest.find((m) => m.path === e.path) || {}).executable } : e));
    if (digest !== record.digest || manifestDigest(stagedNow) !== record.digest) {
      throw new BundleError(409, 'The staged files changed since they were checked: import the bundle again.', { code: 'staging_changed' });
    }
    return { record, files, dirs, digest };
  }

  function discard(id) {
    if (typeof id !== 'string' || !STAGING_ID_RE.test(id)) throw new BundleError(400, 'Not a staging id.', { code: 'invalid_staging_id' });
    const real = ensureOutsideLiveRoots();
    const home = join(real, id);
    try { lstatSync(home); } catch { return false; }
    rmSync(home, { recursive: true, force: true });
    return true;
  }

  return { stage, load, discard, ensureOutsideLiveRoots };
}

/**
 * Write a staged skill folder into place: a new folder, all of it or none of it.
 * @param {{ dir: string, anchor?: string }} root the skills folder it goes into
 * @param {string} destination root.dir/<name>
 * @returns {string} the folder's canonical path
 */
export function writeSkillFolder(root, destination, { files, dirs }) {
  const rootReal = realPathOf(root.dir);
  mkdirSync(rootReal, { recursive: true });
  const real = canonicalInside(rootReal, destination);
  try { mkdirSync(real); } catch (err) {
    if (err?.code === 'EEXIST') throw new BundleError(409, `"${destination}" already exists. Nothing was written.`, { code: 'exists' });
    throw err;
  }
  try {
    if (realpathSync(real) !== real) throw new PathConfineError(409, 'That path changed while it was being used. Nothing was done; try again.');
    for (const d of dirs) makeConfinedDir(real, join(real, d));
    for (const f of files) writeConfinedFile(real, join(real, f.path), f.bytes, { exclusive: true, mode: f.executable ? 0o755 : 0o644 });
  } catch (err) {
    rmSync(real, { recursive: true, force: true });
    throw err;
  }
  return real;
}
