import { effectiveInstallName, nameChecks } from './scan-context.js';
import { scanArtifact, withExternalScans } from './scan.js';
import { frontmatterData } from './frontmatter.js';
// ── The managed skill library: complete folders, immutable revisions ──
// SynaBun's own copy of every skill it manages (owner decision, 2026-10-22): a skill is a whole folder, kept as
// immutable revisions under the data home, and installed into each runtime's folders from there
// (lib/skills/deploy.js). Runtime folders are destinations; nothing here is read by a runtime, and nothing here is
// inside a folder a runtime reads skills from.
//
//   DATA_HOME/data/skills/library/
//     blobs/<2 hex>/<64 hex>     file bytes, by their SHA-256 (written once, checked on every read)
//     revisions/<revisionId>.json one revision: the manifest of every file (path, bytes, digest, mode, encoding,
//                                 BOM, line endings), its parent, where it came from and who made it. Written once,
//                                 never changed.
//     skills/<skillId>.json      the skill: its name (a label), origin, the revisions it has, and its pointers
//                                 (latest, draft, candidate, best, approved, upstream) with a log of every move
//     drafts/<draftId>.json      an editable workspace: a list of files by blob, over a base revision
//     archive/<skillId>.<time>.json a skill the owner deleted from the library: its record and its draft as they
//                                 were, kept (nothing lists them); its revisions and blobs stay where they are
//
// A revision's `contentDigest` is the digest of the folder (lib/skills/digest.js manifestDigest), the same one an
// install records and compares: a folder installed from a revision has the revision's digest unless an export
// changed it on purpose. Ids are opaque (`skl_`, `rev_`, `drf_` + random hex); names are labels. `approved` moves
// only through a review's approval and `upstream` only through the bundled-skill sync: no caller can point them at
// a revision directly. Source identity (where the bytes came from: a bundled skill of an app version, a folder, a
// repository at a requested ref and the commit it resolved to) is kept field by field and checked
// (normalizeSource), never folded into one string.
//
// Everything here is synchronous: the server's one process is the only writer, and a JavaScript turn is never
// interleaved with another's.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PathConfineError } from '../path-confine.js';
import { readConfinedFile, replaceFileAtomic, writeConfinedFile } from '../confined-fs.js';
import { fileEntry, manifestDigest, sha256 } from './digest.js';
import { BUNDLE_LIMITS, bundleNameProblem, bundlePathProblem } from './bundle.js';
import { isEditableText } from '../../public/shared/skills/ss-doc.js';

export const LIBRARY_SCHEMA = 2;
export const POINTERS = Object.freeze(['latest', 'draft', 'candidate', 'best', 'approved', 'upstream']);
const PROTECTED_POINTERS = new Set(['approved', 'upstream']);
const MOVABLE_POINTERS = new Set(['candidate', 'best']);
export const SOURCE_KINDS = Object.freeze(['bundled', 'local', 'import', 'assistant', 'adopted', 'customize', 'restore', 'github', 'draft']);
export const AUTHOR_KINDS = Object.freeze(['owner', 'assistant', 'agent', 'system']);
const POINTER_LOG_MAX = 200;
const ID = { skill: /^skl_[0-9a-f]{20}$/, revision: /^rev_[0-9a-f]{20}$/, draft: /^drf_[0-9a-f]{20}$/ };
const COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export class LibraryError extends PathConfineError {
  constructor(status, message, code, extra = {}) {
    super(status, message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export const isSkillId = (v) => typeof v === 'string' && ID.skill.test(v);
export const isRevisionId = (v) => typeof v === 'string' && ID.revision.test(v);
export const isDraftId = (v) => typeof v === 'string' && ID.draft.test(v);

const clipText = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : null);

/**
 * Where bytes came from, field by field. A requested ref (a branch, a tag) and the commit it resolved to are two
 * fields: one never stands for the other. Throws 400 on a value that is not what its field holds.
 */
export function normalizeSource(source = {}) {
  const s = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const kind = typeof s.kind === 'string' ? s.kind : 'local';
  if (!SOURCE_KINDS.includes(kind)) throw new LibraryError(400, `A source kind is one of ${SOURCE_KINDS.join(', ')}.`, 'invalid_source');
  if (s.resolvedCommit !== undefined && s.resolvedCommit !== null && !(typeof s.resolvedCommit === 'string' && COMMIT_RE.test(s.resolvedCommit))) {
    throw new LibraryError(400, 'resolvedCommit is a full commit id (40 or 64 hex characters), or nothing.', 'invalid_source');
  }
  if (s.digest !== undefined && s.digest !== null && !(typeof s.digest === 'string' && DIGEST_RE.test(s.digest))) {
    throw new LibraryError(400, 'A source digest is sha256:<64 hex>.', 'invalid_source');
  }
  for (const key of ['uri', 'subpath', 'requestedRef', 'name', 'appVersion', 'path', 'rootId', 'artifactId', 'stagingId', 'reviewId']) {
    if (s[key] !== undefined && s[key] !== null && typeof s[key] !== 'string') throw new LibraryError(400, `The source's ${key} is text.`, 'invalid_source');
  }
  const out = { kind };
  for (const key of ['uri', 'subpath', 'requestedRef', 'resolvedCommit', 'digest', 'name', 'appVersion', 'path', 'rootId', 'artifactId', 'stagingId', 'reviewId']) {
    if (typeof s[key] === 'string' && s[key]) out[key] = s[key].slice(0, 2000);
  }
  if (kind === 'github' && !out.uri) throw new LibraryError(400, 'A GitHub source names its repository (uri).', 'invalid_source');
  return out;
}

/** Who made something: a kind and what is known of them (never a credential). */
export function normalizeAuthor(author = {}) {
  const a = author && typeof author === 'object' && !Array.isArray(author) ? author : {};
  const kind = AUTHOR_KINDS.includes(a.kind) ? a.kind : 'owner';
  const out = { kind };
  for (const key of ['provider', 'modelProvider', 'model', 'runId', 'terminal', 'sessionId', 'principalId']) {
    const v = clipText(a[key], 200);
    if (v) out[key] = v;
  }
  return out;
}

/** What a file's bytes are, for a manifest: text or binary, BOM, and its line endings. */
export function describeBytes(bytes) {
  const binary = !isEditableText(bytes);
  if (binary) return { encoding: 'binary', bom: false, eol: 'none' };
  const bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  let crlf = 0; let lf = 0; let cr = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 13) { if (bytes[i + 1] === 10) { crlf++; i++; } else cr++; }
    else if (b === 10) lf++;
  }
  const kinds = [crlf && 'crlf', lf && 'lf', cr && 'cr'].filter(Boolean);
  return { encoding: 'utf-8', bom, eol: kinds.length === 0 ? 'none' : (kinds.length === 1 ? kinds[0] : 'mixed') };
}

/**
 * Check a set of files as one skill folder: every path writable everywhere, within the import limits, the head
 * file there. Returns them sorted, with every folder on the way.
 */
export function checkFolder({ files, dirs = [] }, { headPath = 'SKILL.md', limits = BUNDLE_LIMITS } = {}) {
  if (!Array.isArray(files) || !files.length) throw new LibraryError(400, 'A skill holds at least its SKILL.md.', 'invalid_folder');
  const problems = [];
  const seen = new Map();
  let total = 0;
  const out = [];
  for (const f of files) {
    const path = f?.path;
    const why = bundlePathProblem(path, limits);
    if (why) { problems.push({ path: String(path), message: `This path cannot be written: ${why}.` }); continue; }
    if (!Buffer.isBuffer(f.bytes)) { problems.push({ path, message: 'No bytes.' }); continue; }
    if (f.bytes.length > limits.maxFileBytes) { problems.push({ path, message: `It is larger than ${Math.round(limits.maxFileBytes / (1024 * 1024))} MB.` }); continue; }
    const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) { problems.push({ path, message: `"${path}" and "${seen.get(key)}" name the same file on macOS and Windows.` }); continue; }
    seen.set(key, path);
    total += f.bytes.length;
    out.push({ path, bytes: f.bytes, executable: f.executable === true });
  }
  if (out.length > limits.maxEntries) problems.push({ path: null, message: `${out.length} files; the limit is ${limits.maxEntries}.` });
  if (total > limits.maxTotalBytes) problems.push({ path: null, message: `${Math.round(total / (1024 * 1024))} MB; the limit is ${Math.round(limits.maxTotalBytes / (1024 * 1024))} MB.` });
  const dirSet = new Set();
  for (const d of dirs || []) {
    const why = bundlePathProblem(d, limits);
    if (why) problems.push({ path: String(d), message: `This folder cannot be made: ${why}.` });
    else dirSet.add(d);
  }
  for (const f of out) { const parts = f.path.split('/'); for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join('/')); }
  for (const d of dirSet) if (seen.has(d.normalize('NFC').toLowerCase())) problems.push({ path: d, message: `"${d}" is both a file and a folder.` });
  const head = out.find((f) => f.path === headPath);
  if (!head) problems.push({ path: headPath, message: `There is no ${headPath}.` });
  if (problems.length) {
    throw new LibraryError(problems.some((p) => /limit is/.test(p.message)) ? 413 : 400,
      problems.length === 1 ? `${problems[0].path ? `${problems[0].path}: ` : ''}${problems[0].message}` : `${problems.length} problems with these files.`,
      'invalid_folder', { problems: problems.slice(0, 200) });
  }
  return { files: out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), dirs: [...dirSet].sort() };
}

/** The digest of a folder's files and folders, as an install and an import compute it. */
export function folderDigest({ files, dirs = [] }) {
  return manifestDigest([...dirs.map((d) => ({ path: d, type: 'dir' })), ...files.map((f) => fileEntry(f.path, f.bytes, { executable: f.executable }))]);
}

// ── Line diff (Myers, O(ND)), bounded ──

const DIFF_MAX_LINES = 20000;
const DIFF_MAX_D = 4000;

function myers(a, b) {
  const n = a.length; const m = b.length; const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  for (let d = 0; d <= Math.min(max, DIFF_MAX_D); d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) {
        // Walk back to the edit script.
        const ops = [];
        let cx = n; let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd];
          const kk = cx - cy;
          const prevK = (kk === -dd || (kk !== dd && (pv.get(kk - 1) ?? -1) < (pv.get(kk + 1) ?? -1))) ? kk + 1 : kk - 1;
          const px = pv.get(prevK) ?? 0; const py = px - prevK;
          while (cx > px && cy > py) { ops.push({ t: ' ', a: cx - 1, b: cy - 1 }); cx--; cy--; }
          if (cx === px) ops.push({ t: '+', b: cy - 1 }); else ops.push({ t: '-', a: cx - 1 });
          cx = px; cy = py;
        }
        while (cx > 0 && cy > 0) { ops.push({ t: ' ', a: cx - 1, b: cy - 1 }); cx--; cy--; }
        return ops.reverse();
      }
    }
  }
  return null;
}

/** A unified diff of two texts (3 lines of context), or null when they are too far apart or too long to compare. */
export function unifiedDiff(before, after, { context = 3 } = {}) {
  const a = String(before).split('\n'); const b = String(after).split('\n');
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null;
  const ops = myers(a, b);
  if (!ops) return null;
  // Changed lines in groups: two changes closer than twice the context share one hunk.
  const changed = [];
  ops.forEach((o, i) => { if (o.t !== ' ') changed.push(i); });
  const groups = [];
  for (const i of changed) {
    const last = groups[groups.length - 1];
    if (last && i - last.end <= context * 2 + 1) last.end = i;
    else groups.push({ start: i, end: i });
  }
  return groups.map(({ start, end }) => {
    const slice = ops.slice(Math.max(0, start - context), Math.min(ops.length, end + 1 + context));
    const aLines = slice.filter((o) => o.t !== '+').length;
    const bLines = slice.filter((o) => o.t !== '-').length;
    const aFirst = slice.find((o) => o.a !== undefined)?.a;
    const bFirst = slice.find((o) => o.b !== undefined)?.b;
    const aStart = aLines ? aFirst + 1 : (aFirst ?? 0);
    const bStart = bLines ? bFirst + 1 : (bFirst ?? 0);
    const lines = slice.map((o) => (o.t === '+' ? `+${b[o.b]}` : o.t === '-' ? `-${a[o.a]}` : ` ${a[o.a]}`));
    return { header: `@@ -${aStart},${aLines} +${bStart},${bLines} @@`, lines };
  });
}

// ── The store ──

/**
 * @param {object} o
 * @param {string} o.dir DATA_HOME/data/skills/library
 * @param {() => string} [o.now]
 * @param {(prefix: string) => string} [o.newId]
 */
export function createSkillLibrary({ dir, now = () => new Date().toISOString(), newId = (prefix) => `${prefix}_${randomBytes(10).toString('hex')}` }) {
  let shippedNames = () => listSkills().filter((s) => s.origin?.kind === 'bundled').map((s) => s.origin.name || s.name);
  let externalEvidence = () => [];
  function setExternalEvidence(read) { externalEvidence = read; }
  const scanCache = new Map();
  function setShippedNames(read) { shippedNames = read; scanCache.clear(); }
  function scanSkill(skillId, fallback) {
    const active = readSkill(skillId);
    if (active) return active;
    // Archived revisions remain readable by reviews and installations.
    let files = [];
    try { files = readdirSync(archiveDir).filter((n) => n.startsWith(`${skillId}.`) && n.endsWith('.json')).sort().reverse(); } catch { /* no archive */ }
    for (const file of files) { const record = readJson(archiveDir, file); if (record?.skill?.skillId === skillId) return record.skill; }
    return { name: fallback || 'unknown', origin: null };
  }
  function scanFolderEvidence(folder, skill, digest) {
    const fm = frontmatterData(folder.files.find((f) => f.path === 'SKILL.md')?.bytes.toString('utf-8') || '').data;
    let name;
    try { name = effectiveInstallName(skill, folder.files); } catch { name = skill.name; }
    const shipped = shippedNames();
    const names = nameChecks(skill, name, shipped);
    const key = JSON.stringify([digest, name, names]);
    if (!scanCache.has(key)) {
      if (scanCache.size >= 200) scanCache.clear();
      scanCache.set(key, scanArtifact({ type: 'skill', name, files: folder.files, frontmatter: fm, digest, ...names }));
    }
    return withExternalScans(structuredClone(scanCache.get(key)), externalEvidence(digest));
  }
  const blobsDir = join(dir, 'blobs');
  const revisionsDir = join(dir, 'revisions');
  const skillsDir = join(dir, 'skills');
  const draftsDir = join(dir, 'drafts');
  const archiveDir = join(dir, 'archive');

  function ensure() {
    for (const d of [dir, blobsDir, revisionsDir, skillsDir, draftsDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  function readJson(base, file) {
    try { return JSON.parse(readConfinedFile(base, join(base, file), { maxBytes: 16 * 1024 * 1024, encoding: 'utf-8' })); } catch { return null; }
  }
  function writeJson(path, value) {
    replaceFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  // ── Blobs ──

  const blobPath = (hex) => join(blobsDir, hex.slice(0, 2), hex);

  /** Store bytes by their hash (once). @returns 'sha256:<hex>' */
  function putBlob(bytes) {
    const digest = sha256(bytes);
    const hex = digest.slice(7);
    const path = blobPath(hex);
    if (existsSync(path)) return digest;
    mkdirSync(join(blobsDir, hex.slice(0, 2)), { recursive: true, mode: 0o700 });
    const tmp = join(blobsDir, hex.slice(0, 2), `.${hex}.${randomBytes(6).toString('hex')}.tmp`);
    writeConfinedFile(blobsDir, tmp, bytes, { exclusive: true, mode: 0o600 });
    try { renameSync(tmp, path); } catch (err) { try { unlinkSync(tmp); } catch {} if (!existsSync(path)) throw err; }
    return digest;
  }

  /** The bytes of a blob, checked against their hash (a changed or damaged blob is an error, never content). */
  function getBlob(digest) {
    if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) throw new LibraryError(500, 'Not a blob id.', 'blob_invalid');
    const hex = digest.slice(7);
    let bytes;
    try { bytes = readConfinedFile(blobsDir, blobPath(hex), { maxBytes: BUNDLE_LIMITS.maxFileBytes }); } catch {
      throw new LibraryError(500, 'A file of this revision is missing from the library.', 'blob_missing', { digest });
    }
    if (sha256(bytes) !== digest) throw new LibraryError(500, 'A file of this revision was changed or damaged in the library.', 'blob_corrupt', { digest });
    return bytes;
  }

  // ── Skills ──

  function readSkill(skillId) {
    if (!isSkillId(skillId)) return null;
    const rec = readJson(skillsDir, `${skillId}.json`);
    return rec && rec.schemaVersion === LIBRARY_SCHEMA && rec.skillId === skillId ? rec : null;
  }
  function getSkill(skillId) {
    const rec = readSkill(skillId);
    if (!rec) throw new LibraryError(404, 'There is no such skill in the library.', 'skill_not_found');
    return rec;
  }
  function saveSkill(rec) {
    ensure();
    rec.updatedAt = now();
    writeJson(join(skillsDir, `${rec.skillId}.json`), rec);
    return rec;
  }
  function listSkills() {
    let names = [];
    try { names = readdirSync(skillsDir).filter((n) => /^skl_[0-9a-f]{20}\.json$/.test(n)).sort(); } catch { names = []; }
    return names.map((n) => readSkill(n.slice(0, -5))).filter(Boolean);
  }
  function findSkill(predicate) { return listSkills().find(predicate) || null; }

  function newSkill({ name, origin = { kind: 'local' }, author }) {
    // The name is a label, and the folder an install falls back to: a plain name, visible characters only.
    const why = bundleNameProblem(String(name || ''));
    if (why) throw new LibraryError(400, `"${String(name || '')}" cannot be a skill's name: ${why}.`, 'invalid_name');
    ensure();
    const skillId = newId('skl');
    if (!isSkillId(skillId)) throw new LibraryError(500, 'Bad skill id.', 'bad_id');
    const rec = {
      schemaVersion: LIBRARY_SCHEMA, skillId, name: String(name || '').slice(0, 128), createdAt: now(), updatedAt: now(), etag: 1,
      origin: { ...origin }, createdBy: normalizeAuthor(author), revisions: [],
      pointers: Object.fromEntries(POINTERS.map((p) => [p, null])), log: [],
    };
    return saveSkill(rec);
  }

  function logPointer(rec, entry) {
    rec.log.push({ at: now(), ...entry });
    if (rec.log.length > POINTER_LOG_MAX) rec.log = rec.log.slice(-POINTER_LOG_MAX);
  }

  // ── Revisions ──

  function readRevision(revisionId) {
    if (!isRevisionId(revisionId)) return null;
    const rec = readJson(revisionsDir, `${revisionId}.json`);
    if (!rec || rec.schemaVersion !== LIBRARY_SCHEMA || rec.revisionId !== revisionId) return null;
    const folder = { files: rec.manifest.files.map((e) => ({ path: e.path, bytes: getBlob(e.blobId), executable: e.mode === '0755' })), dirs: rec.manifest.dirs || [] };
    if (folderDigest(folder) !== rec.contentDigest) throw new LibraryError(500, 'This revision does not read back as it was written.', 'revision_corrupt');
    rec.scan = scanFolderEvidence(folder, scanSkill(rec.skillId, rec.scan?.name), rec.contentDigest);
    return rec;
  }
  function getRevision(revisionId) {
    const rec = readRevision(revisionId);
    if (!rec) throw new LibraryError(404, 'There is no such revision.', 'revision_not_found');
    return rec;
  }

  /**
   * A new immutable revision of a skill from whole files. It becomes `latest` unless `asCandidate`: a proposal (an
   * evaluation's optimised description) is labelled `candidate` and leaves `latest` (what the editor opens, what an
   * install offers first) where it was, so nothing it proposes is applied by itself.
   * @returns the revision record
   */
  function putRevision(skillId, { files, dirs = [], parentRevisionId = null, source, author, profiles = [], invocationIntent = null, note = '', asCandidate = false }) {
    const rec = getSkill(skillId);
    const folder = checkFolder({ files, dirs });
    if (parentRevisionId !== null && !rec.revisions.includes(parentRevisionId)) throw new LibraryError(400, 'The parent revision is not one of this skill\'s.', 'invalid_parent');
    const entries = folder.files.map((f) => {
      const digest = putBlob(f.bytes);
      return { path: f.path, type: 'file', digest, bytes: f.bytes.length, mode: f.executable ? '0755' : '0644', ...describeBytes(f.bytes), blobId: digest };
    });
    const contentDigest = folderDigest(folder);
    const revisionId = newId('rev');
    if (!isRevisionId(revisionId)) throw new LibraryError(500, 'Bad revision id.', 'bad_id');
    const revision = {
      schemaVersion: LIBRARY_SCHEMA, skillId, revisionId, parentRevisionId, contentDigest, entrypoint: 'SKILL.md',
      manifest: { digest: contentDigest, files: entries, dirs: folder.dirs },
      scan: scanFolderEvidence(folder, rec, contentDigest),
      source: normalizeSource(source), author: normalizeAuthor(author),
      profiles: (Array.isArray(profiles) ? profiles : []).filter((p) => p && typeof p.id === 'string').map((p) => ({ id: p.id, version: String(p.version || '') })),
      invocationIntent: invocationIntent && typeof invocationIntent === 'object' ? { user: invocationIntent.user !== false, model: invocationIntent.model !== false } : null,
      note: String(note || '').slice(0, 2000), noteCode: source?.kind === 'bundled' && /^Shipped with SynaBun(?: [\d.]+)?\.$/.test(note) ? 'bundled' : null, createdAt: now(),
    };
    ensure();
    writeConfinedFile(revisionsDir, join(revisionsDir, `${revisionId}.json`), `${JSON.stringify(revision, null, 2)}\n`, { exclusive: true, mode: 0o600 });
    rec.revisions.push(revisionId);
    const pointer = asCandidate ? 'candidate' : 'latest';
    const from = rec.pointers[pointer];
    rec.pointers[pointer] = revisionId;
    rec.etag += 1;
    logPointer(rec, { pointer, from, to: revisionId, by: revision.author.kind, reason: asCandidate ? 'proposed by an evaluation' : 'revision created' });
    saveSkill(rec);
    return revision;
  }

  function listRevisions(skillId) {
    const rec = getSkill(skillId);
    return rec.revisions.map((id) => {
      try {
        const revision = readRevision(id);
        if (revision) return { ...revision, integrity: 'intact' };
      } catch (err) {
        if (!['blob_missing', 'blob_corrupt', 'blob_invalid', 'revision_corrupt'].includes(err.code)) throw err;
        const metadata = readJson(revisionsDir, `${id}.json`);
        return { ...metadata, revisionId: id, scan: null, integrity: 'damaged', error: { code: err.code } };
      }
      return { revisionId: id, skillId, scan: null, integrity: 'damaged', error: { code: 'revision_not_found' } };
    });
  }

  /** A revision's files, read back from their blobs and checked. */
  function readRevisionFiles(revisionId) {
    const rev = getRevision(revisionId);
    const files = rev.manifest.files.map((e) => ({ path: e.path, bytes: getBlob(e.blobId), executable: e.mode === '0755' }));
    const out = { files, dirs: rev.manifest.dirs || [] };
    if (folderDigest(out) !== rev.contentDigest) throw new LibraryError(500, 'This revision does not read back as it was written.', 'revision_corrupt');
    return { ...out, revision: rev };
  }

  function readRevisionFile(revisionId, path) {
    const rev = getRevision(revisionId);
    const entry = rev.manifest.files.find((e) => e.path === path);
    if (!entry) throw new LibraryError(404, 'This revision has no such file.', 'file_not_found');
    return { entry, bytes: getBlob(entry.blobId) };
  }

  // ── Pointers ──

  /**
   * Move one pointer. `candidate` and `best` move by request; `approved` only with `allowProtected: 'review'`
   * (a review's approval) and `upstream` only with `allowProtected: 'bundled'`.
   */
  function setPointer(skillId, pointer, revisionId, { expectedEtag = null, by = 'owner', reason = '', allowProtected = null } = {}) {
    const rec = getSkill(skillId);
    if (!POINTERS.includes(pointer)) throw new LibraryError(400, `A pointer is one of ${POINTERS.join(', ')}.`, 'invalid_pointer');
    if (PROTECTED_POINTERS.has(pointer)) {
      const allowed = (pointer === 'approved' && allowProtected === 'review') || (pointer === 'upstream' && allowProtected === 'bundled');
      if (!allowed) throw new LibraryError(403, `"${pointer}" moves only through ${pointer === 'approved' ? 'a review\'s approval' : 'the bundled skills\' update'}.`, 'pointer_protected');
    } else if (!MOVABLE_POINTERS.has(pointer) && allowProtected !== 'internal') {
      throw new LibraryError(403, `"${pointer}" is kept by the library itself.`, 'pointer_protected');
    }
    if (expectedEtag !== null && expectedEtag !== rec.etag) throw new LibraryError(409, 'The skill changed since it was read.', 'skill_conflict', { currentEtag: rec.etag });
    if (revisionId !== null && !(rec.revisions.includes(revisionId) || (pointer === 'draft' && isDraftId(revisionId)))) {
      throw new LibraryError(400, 'That revision is not one of this skill\'s.', 'invalid_revision');
    }
    const from = rec.pointers[pointer];
    if (from === revisionId) return rec;
    rec.pointers[pointer] = revisionId;
    rec.etag += 1;
    logPointer(rec, { pointer, from, to: revisionId, by, reason: String(reason || '').slice(0, 300) });
    return saveSkill(rec);
  }

  /** Every pointer of a skill that names this revision. */
  function labelsOf(rec, revisionId) {
    return POINTERS.filter((p) => rec.pointers[p] === revisionId);
  }

  // ── Creating skills ──

  /** A new skill from whole files: the skill, and its first revision as `latest`. */
  function createSkill({ name, files, dirs = [], source, author, origin = null, profiles = [], invocationIntent = null, note = '' }) {
    checkFolder({ files, dirs });
    const rec = newSkill({ name, origin: origin || { kind: normalizeSource(source).kind }, author });
    const revision = putRevision(rec.skillId, { files, dirs, source, author, profiles, invocationIntent, note });
    return { skill: getSkill(rec.skillId), revision };
  }

  // ── Taking a skill out ──

  /**
   * Take a skill out of the library (the owner deleted it): its record and its draft are written whole into
   * `archive/` first, then removed from `skills/` and `drafts/`, so nothing lists, opens or installs it any more. Its
   * revisions and their blobs stay where they are: written once, shared by content, and still readable by an
   * installation or a review that names them. Whether it may go (installed somewhere, shipped with SynaBun) is the
   * service's to decide; this only moves it.
   * @param {string} skillId
   * @param {{ expectedEtag?: number|null, by?: string, reason?: string }} [o] the etag the owner read: another one is a 409
   * @returns {{ skillId: string, archivedAt: string, archived: string }} `archived`: the archive file's name
   */
  function archiveSkill(skillId, { expectedEtag = null, by = 'owner', reason = '' } = {}) {
    const rec = getSkill(skillId);
    if (expectedEtag !== null && expectedEtag !== rec.etag) throw new LibraryError(409, 'The skill changed since it was read.', 'skill_conflict', { currentEtag: rec.etag });
    const draft = rec.pointers.draft ? readDraft(rec.pointers.draft) : null;
    const archivedAt = now();
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    // One file per deletion (a name of its own: an earlier attempt that stopped half way is never written over).
    const archived = `${skillId}.${archivedAt.replace(/[^0-9]/g, '')}.${randomBytes(4).toString('hex')}.json`;
    const record = { schemaVersion: LIBRARY_SCHEMA, archivedAt, archivedBy: String(by || 'owner').slice(0, 40), reason: String(reason || '').slice(0, 300), skill: rec, draft };
    writeConfinedFile(archiveDir, join(archiveDir, archived), `${JSON.stringify(record, null, 2)}\n`, { exclusive: true, mode: 0o600 });
    unlinkSync(join(skillsDir, `${skillId}.json`));
    if (draft) { try { unlinkSync(join(draftsDir, `${draft.draftId}.json`)); } catch { /* the skill is out already: a draft nothing points to */ } }
    return { skillId, archivedAt, archived };
  }

  /**
   * The skills taken out of the library, newest first: `{ skillId, name, archivedAt, archivedBy, archived, revisions }`
   * (`revisions`: how many of its versions still read back, the ones a Restore brings with it).
   */
  function listArchived() {
    let names = [];
    try { names = readdirSync(archiveDir).filter((n) => /^skl_[0-9a-f]{20}\.[0-9]+\.[0-9a-f]{8}\.json$/.test(n)); } catch { names = []; }
    return names.map((n) => {
      const rec = readJson(archiveDir, n);
      if (!rec?.skill?.skillId) return null;
      const revisions = (Array.isArray(rec.skill.revisions) ? rec.skill.revisions : []).filter((id) => isRevisionId(id) && readRevision(id)).length;
      return { skillId: rec.skill.skillId, name: rec.skill.name, archivedAt: rec.archivedAt, archivedBy: rec.archivedBy, archived: n, revisions };
    }).filter(Boolean).sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
  }

  /**
   * Put an archived skill back as it was: its record and its draft, over the revisions and blobs that never left.
   * 404 when nothing of it is archived (`archive_not_found`: a second Restore of the same deletion); refused while a
   * skill of that id is in the library (409 `skill_exists`: never two records of one id). The newest archive file of
   * the id is the one restored and then removed (an older one of the same id stays, readable).
   * @returns {{ skillId: string, name: string, restoredAt: string, archivedAt: string }}
   */
  function restoreSkill(skillId) {
    if (!isSkillId(skillId)) throw new LibraryError(400, 'Not a skill id.', 'invalid_id');
    const entry = listArchived().find((a) => a.skillId === skillId);
    if (!entry) throw new LibraryError(404, 'Nothing of that skill is archived.', 'archive_not_found');
    if (readSkill(skillId)) throw new LibraryError(409, 'A skill of that id is in the library already.', 'skill_exists');
    const rec = readJson(archiveDir, entry.archived);
    if (!rec?.skill?.skillId || rec.skill.skillId !== skillId) throw new LibraryError(500, 'The archive file does not read back.', 'archive_corrupt');
    const skill = { ...rec.skill };
    skill.log = [...(Array.isArray(skill.log) ? skill.log : []), { at: now(), by: 'owner', action: 'restored', note: `restored from the archive (deleted ${rec.archivedAt})` }].slice(-200);
    skill.etag = (Number(skill.etag) || 0) + 1;
    ensure();
    if (rec.draft?.draftId && !readDraft(rec.draft.draftId)) writeJson(join(draftsDir, `${rec.draft.draftId}.json`), rec.draft);
    else if (!rec.draft?.draftId) skill.pointers = { ...skill.pointers, draft: null };
    saveSkill(skill);
    try { unlinkSync(join(archiveDir, entry.archived)); } catch { /* the record is back: an archive file left behind is listed no more than once */ }
    return { skillId, name: skill.name, restoredAt: now(), archivedAt: rec.archivedAt };
  }

  // ── Drafts ──

  function readDraft(draftId) {
    if (!isDraftId(draftId)) return null;
    const rec = readJson(draftsDir, `${draftId}.json`);
    if (!rec || rec.schemaVersion !== LIBRARY_SCHEMA || rec.draftId !== draftId) return null;
    const folder = { files: rec.files.map((f) => ({ path: f.path, bytes: getBlob(f.blobId), executable: !!f.executable })), dirs: rec.dirs };
    rec.scan = scanFolderEvidence(folder, getSkill(rec.skillId), folderDigest(folder));
    return rec;
  }
  function getDraft(draftId) {
    const rec = readDraft(draftId);
    if (!rec) throw new LibraryError(404, 'There is no such draft.', 'draft_not_found');
    return rec;
  }
  const draftTag = (files, dirs) => sha256(JSON.stringify([files.map((f) => [f.path, f.blobId, !!f.executable]), dirs]));
  function saveDraft(rec) {
    ensure();
    rec.updatedAt = now();
    rec.etag = draftTag(rec.files, rec.dirs);
    const folder = { files: rec.files.map((f) => ({ path: f.path, bytes: getBlob(f.blobId), executable: !!f.executable })), dirs: rec.dirs };
    rec.scan = scanFolderEvidence(folder, getSkill(rec.skillId), folderDigest(folder));
    writeJson(join(draftsDir, `${rec.draftId}.json`), rec);
    return rec;
  }

  /**
   * An editable workspace. Over a skill (from its `latest`, or `baseRevisionId`), or a new skill with `name` and
   * `files`. A new skill's record exists from here on, without revisions until the first snapshot.
   */
  function createDraft({ skillId = null, baseRevisionId = null, name = '', files = null, dirs = [], author, origin = null }) {
    let rec;
    let base = null;
    let entries = [];
    let folders = [];
    if (skillId) {
      rec = getSkill(skillId);
      base = baseRevisionId || rec.pointers.latest;
      if (base) {
        if (!rec.revisions.includes(base)) throw new LibraryError(400, 'That revision is not one of this skill\'s.', 'invalid_revision');
        const rev = getRevision(base);
        entries = rev.manifest.files.map((e) => ({ path: e.path, blobId: e.blobId, executable: e.mode === '0755' }));
        folders = rev.manifest.dirs || [];
      }
    } else {
      if (!Array.isArray(files)) throw new LibraryError(400, 'A new skill\'s draft starts from its files.', 'invalid_draft');
      const folder = checkFolder({ files, dirs });
      rec = newSkill({ name, origin: origin || { kind: 'draft' }, author });
      entries = folder.files.map((f) => ({ path: f.path, blobId: putBlob(f.bytes), executable: f.executable }));
      folders = folder.dirs;
    }
    const draftId = newId('drf');
    if (!isDraftId(draftId)) throw new LibraryError(500, 'Bad draft id.', 'bad_id');
    const draft = saveDraft({
      schemaVersion: LIBRARY_SCHEMA, draftId, skillId: rec.skillId, baseRevisionId: base, files: entries, dirs: folders,
      createdAt: now(), updatedAt: now(), createdBy: normalizeAuthor(author), etag: null,
    });
    setPointer(rec.skillId, 'draft', draftId, { by: normalizeAuthor(author).kind, reason: 'draft opened', allowProtected: 'internal' });
    return draft;
  }

  /**
   * Change a draft: `ops` is a list of { op: 'put', path, content | contentBase64, executable? }, { op: 'delete', path },
   * { op: 'mkdir', path }, { op: 'rename', from, to }. `expectedEtag` must be the draft's: a stale one is refused (409).
   * The whole result is checked as a folder before anything is kept.
   */
  function patchDraft(draftId, { expectedEtag, ops }) {
    const draft = getDraft(draftId);
    if (typeof expectedEtag !== 'string' || expectedEtag !== draft.etag) throw new LibraryError(409, 'The draft changed since it was read.', 'draft_conflict', { currentEtag: draft.etag });
    if (!Array.isArray(ops) || !ops.length || ops.length > 500) throw new LibraryError(400, 'A change is a list of 1 to 500 operations.', 'invalid_ops');
    const files = new Map(draft.files.map((f) => [f.path, { ...f }]));
    const dirs = new Set(draft.dirs);
    const bytesOf = new Map();
    for (const [i, op] of ops.entries()) {
      const at = `Operation ${i + 1}`;
      if (!op || typeof op !== 'object' || Array.isArray(op)) throw new LibraryError(400, `${at} is not an operation.`, 'invalid_ops');
      if (op.op === 'put') {
        const why = bundlePathProblem(op.path);
        if (why) throw new LibraryError(400, `${at}: ${String(op.path)} cannot be written: ${why}.`, 'invalid_path');
        let bytes;
        if (typeof op.content === 'string' && op.contentBase64 === undefined) bytes = Buffer.from(op.content, 'utf-8');
        else if (typeof op.contentBase64 === 'string' && op.content === undefined) {
          bytes = Buffer.from(op.contentBase64, 'base64');
          if (bytes.toString('base64') !== op.contentBase64) throw new LibraryError(400, `${at}: contentBase64 is not canonical base64.`, 'invalid_content');
        } else throw new LibraryError(400, `${at}: give either content (text) or contentBase64.`, 'invalid_content');
        if (bytes.length > BUNDLE_LIMITS.maxFileBytes) throw new LibraryError(413, `${at}: larger than ${Math.round(BUNDLE_LIMITS.maxFileBytes / (1024 * 1024))} MB.`, 'too_large');
        const prior = files.get(op.path);
        files.set(op.path, { path: op.path, blobId: null, executable: typeof op.executable === 'boolean' ? op.executable : !!prior?.executable });
        bytesOf.set(op.path, bytes);
      } else if (op.op === 'delete') {
        if (op.path === 'SKILL.md') throw new LibraryError(400, 'SKILL.md is the skill: it is not deleted from a draft.', 'head_protected');
        // Bytes written earlier in this same batch go with the file (or the folder) they were written to.
        const inside = (p) => p.startsWith(`${op.path}/`);
        if (files.has(op.path)) { files.delete(op.path); bytesOf.delete(op.path); }
        else if (dirs.has(op.path) || [...files.keys()].some(inside)) {
          for (const p of [...files.keys()]) if (inside(p)) { files.delete(p); bytesOf.delete(p); }
          for (const d of [...dirs]) if (d === op.path || inside(d)) dirs.delete(d);
        } else throw new LibraryError(404, `${at}: ${String(op.path)} is not in the draft.`, 'file_not_found');
      } else if (op.op === 'mkdir') {
        const why = bundlePathProblem(op.path);
        if (why) throw new LibraryError(400, `${at}: ${String(op.path)} cannot be made: ${why}.`, 'invalid_path');
        dirs.add(op.path);
      } else if (op.op === 'rename') {
        const why = bundlePathProblem(op.to);
        if (why) throw new LibraryError(400, `${at}: ${String(op.to)} cannot be written: ${why}.`, 'invalid_path');
        if (op.from === 'SKILL.md') throw new LibraryError(400, 'SKILL.md keeps its name.', 'head_protected');
        const f = files.get(op.from);
        if (!f) throw new LibraryError(404, `${at}: ${String(op.from)} is not in the draft.`, 'file_not_found');
        if (files.has(op.to)) throw new LibraryError(409, `${at}: ${op.to} is there already.`, 'exists');
        files.delete(op.from);
        files.set(op.to, { ...f, path: op.to });
        if (bytesOf.has(op.from)) { bytesOf.set(op.to, bytesOf.get(op.from)); bytesOf.delete(op.from); }
      } else throw new LibraryError(400, `${at}: unknown operation ${JSON.stringify(op.op ?? null)}.`, 'invalid_ops');
    }
    // The result as a folder: the same checks as a revision, before a blob is written.
    const check = [...files.values()].map((f) => ({ path: f.path, bytes: bytesOf.get(f.path) || Buffer.alloc(0), executable: f.executable }));
    // Sizes of files that were not changed are the sizes of their blobs.
    for (const c of check) if (!bytesOf.has(c.path)) c.bytes = getBlob(files.get(c.path).blobId);
    checkFolder({ files: check, dirs: [...dirs] });
    for (const [path, bytes] of bytesOf) files.get(path).blobId = putBlob(bytes);
    draft.files = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    const dirList = new Set(dirs);
    for (const f of draft.files) { const p = f.path.split('/'); for (let i = 1; i < p.length; i++) dirList.add(p.slice(0, i).join('/')); }
    draft.dirs = [...dirList].sort();
    return saveDraft(draft);
  }

  /** The files of a draft, read back from their blobs. */
  function readDraftFiles(draftId) {
    const draft = getDraft(draftId);
    return { files: draft.files.map((f) => ({ path: f.path, bytes: getBlob(f.blobId), executable: !!f.executable })), dirs: draft.dirs, draft };
  }

  /** Freeze a draft as a revision (its parent: the draft's base). The draft goes on over the new revision. */
  function snapshotDraft(draftId, { expectedEtag, source, author, profiles = [], invocationIntent = null, note = '' }) {
    const draft = getDraft(draftId);
    if (typeof expectedEtag !== 'string' || expectedEtag !== draft.etag) throw new LibraryError(409, 'The draft changed since it was read.', 'draft_conflict', { currentEtag: draft.etag });
    const { files, dirs } = readDraftFiles(draftId);
    const rec = getSkill(draft.skillId);
    // A snapshot of exactly the base's bytes is that revision: nothing new is made.
    if (draft.baseRevisionId) {
      const base = getRevision(draft.baseRevisionId);
      if (base.contentDigest === folderDigest({ files, dirs })) return { revision: base, unchanged: true };
    }
    const revision = putRevision(rec.skillId, { files, dirs, parentRevisionId: draft.baseRevisionId, source: source || { kind: 'draft' }, author, profiles, invocationIntent, note });
    const again = getDraft(draftId);
    again.baseRevisionId = revision.revisionId;
    saveDraft(again);
    return { revision, unchanged: false };
  }

  // ── Comparing ──

  /**
   * File by file, what changed from one set of manifest entries to another, with a line diff of text files.
   * `readLeft` / `readRight` give an entry's bytes (only asked for text files small enough to compare).
   */
  function diffEntries(leftEntries, rightEntries, readLeft, readRight, { maxTextBytes = 512 * 1024 } = {}) {
    const left = new Map(leftEntries.map((e) => [e.path, e]));
    const right = new Map(rightEntries.map((e) => [e.path, e]));
    const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
    const files = [];
    for (const path of paths) {
      const x = left.get(path); const y = right.get(path);
      let status;
      if (!x) status = 'added';
      else if (!y) status = 'removed';
      else if (x.digest !== y.digest) status = 'modified';
      else if (x.mode !== y.mode) status = 'mode';
      else status = 'unchanged';
      const row = { path, status, before: x ? { bytes: x.bytes, mode: x.mode, digest: x.digest, encoding: x.encoding, eol: x.eol } : null, after: y ? { bytes: y.bytes, mode: y.mode, digest: y.digest, encoding: y.encoding, eol: y.eol } : null };
      if (status === 'added' || status === 'removed' || status === 'modified') {
        const textual = (!x || x.encoding === 'utf-8') && (!y || y.encoding === 'utf-8');
        const small = (!x || x.bytes <= maxTextBytes) && (!y || y.bytes <= maxTextBytes);
        if (textual && small) {
          const before = x ? readLeft(x).toString('utf-8') : '';
          const after = y ? readRight(y).toString('utf-8') : '';
          row.hunks = unifiedDiff(before, after);
          if (row.hunks === null) row.note = 'too different to compare line by line';
        } else row.note = textual ? 'too large to compare line by line' : 'binary';
      }
      files.push(row);
    }
    return { files: files.filter((f) => f.status !== 'unchanged'), unchanged: files.filter((f) => f.status === 'unchanged').length };
  }

  /** What changed from one revision to another, file by file, with a line diff of text files. */
  function diffRevisions(fromId, toId, opts = {}) {
    const a = getRevision(fromId); const b = getRevision(toId);
    const read = (e) => getBlob(e.blobId);
    const { files, unchanged } = diffEntries(a.manifest.files, b.manifest.files, read, read, opts);
    return {
      from: { revisionId: a.revisionId, contentDigest: a.contentDigest }, to: { revisionId: b.revisionId, contentDigest: b.contentDigest },
      same: a.contentDigest === b.contentDigest, files, unchanged,
    };
  }

  /**
   * What changed from a revision to a folder as it is now (a skill's installed copy, read whole by the caller):
   * the same answer as diffRevisions, `to` naming the folder by its digest.
   * @param {string} fromId @param {{ files: {path, bytes, executable}[], dirs?: string[] }} folder @param {{ path?: string }} [about]
   */
  function diffRevisionFolder(fromId, folder, about = {}, opts = {}) {
    const a = getRevision(fromId);
    const checked = checkFolder({ files: folder.files, dirs: folder.dirs || [] });
    const entries = checked.files.map((f) => ({ path: f.path, digest: sha256(f.bytes), bytes: f.bytes.length, mode: f.executable ? '0755' : '0644', ...describeBytes(f.bytes), data: f.bytes }));
    const { files, unchanged } = diffEntries(a.manifest.files, entries, (e) => getBlob(e.blobId), (e) => e.data, opts);
    const contentDigest = folderDigest(checked);
    return {
      from: { revisionId: a.revisionId, contentDigest: a.contentDigest }, to: { path: typeof about.path === 'string' ? about.path : null, contentDigest },
      same: a.contentDigest === contentDigest, files, unchanged,
    };
  }

  // ── Bundled skills ──

  /**
   * Keep a library skill for every skill the app ships. A shipped folder whose bytes differ from the last one seen
   * becomes a new revision under `upstream`; installs stay on the revision they have until the owner installs the
   * new one (lib/skills/deploy.js), and a skill installed and changed locally stays the user's.
   * @param {{ name: string, files, dirs }[]} shipped what PACKAGE_ROOT/skills holds now (read without following links)
   * @returns {{ name, skillId, revisionId, changed: boolean, created: boolean }[]}
   */
  function syncBundled(shipped, { appVersion = '' } = {}) {
    const out = [];
    for (const item of shipped) {
      const digest = folderDigest(item);
      let rec = findSkill((s) => s.origin?.kind === 'bundled' && s.origin?.name === item.name);
      const source = { kind: 'bundled', name: item.name, appVersion: String(appVersion || ''), digest, uri: `synabun://bundled/${encodeURIComponent(item.name)}` };
      if (!rec) {
        const created = createSkill({ name: item.name, files: item.files, dirs: item.dirs, source, author: { kind: 'system' }, origin: { kind: 'bundled', name: item.name }, note: 'Shipped with SynaBun.' });
        rec = created.skill;
        setPointer(rec.skillId, 'upstream', created.revision.revisionId, { by: 'system', reason: 'shipped with SynaBun', allowProtected: 'bundled' });
        setPointer(rec.skillId, 'approved', created.revision.revisionId, { by: 'system', reason: 'shipped with SynaBun', allowProtected: 'review' });
        out.push({ name: item.name, skillId: rec.skillId, revisionId: created.revision.revisionId, changed: true, created: true });
        continue;
      }
      const current = rec.pointers.upstream ? readRevision(rec.pointers.upstream) : null;
      if (current && current.contentDigest === digest) { out.push({ name: item.name, skillId: rec.skillId, revisionId: current.revisionId, changed: false, created: false }); continue; }
      const revision = putRevision(rec.skillId, { files: item.files, dirs: item.dirs, parentRevisionId: rec.pointers.upstream, source, author: { kind: 'system' }, note: `Shipped with SynaBun${appVersion ? ` ${appVersion}` : ''}.` });
      setPointer(rec.skillId, 'upstream', revision.revisionId, { by: 'system', reason: 'a new version shipped with SynaBun', allowProtected: 'bundled' });
      out.push({ name: item.name, skillId: rec.skillId, revisionId: revision.revisionId, changed: true, created: false });
    }
    return out;
  }

  function stats() {
    const skills = listSkills();
    return { skills: skills.length, revisions: skills.reduce((n, s) => n + s.revisions.length, 0) };
  }

  return {
    setShippedNames, setExternalEvidence,
    paths: { dir, blobsDir, revisionsDir, skillsDir, draftsDir, archiveDir },
    putBlob, getBlob,
    getSkill, readSkill, listSkills, findSkill, createSkill, labelsOf, archiveSkill, listArchived, restoreSkill,
    getRevision, readRevision, putRevision, listRevisions, readRevisionFiles, readRevisionFile,
    setPointer,
    createDraft, getDraft, readDraft, patchDraft, readDraftFiles, snapshotDraft,
    diffRevisions, diffRevisionFolder, syncBundled, stats,
  };
}

/** True when nothing is at `path` (a link counts as something). */
export function absent(path) {
  try { lstatSync(path); return false; } catch { return true; }
}

/** The SHA-256 of a canonical JSON value (a plan, a review's subject). */
export function digestOf(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
