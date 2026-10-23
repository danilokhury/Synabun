// ── What a skill is, byte for byte ──
// A revision is the SHA-256 of a file's exact bytes: a save names the revision it was written over, and one
// that does not match what is on disk now is refused (lib/skills/revision.js). A digest is the same for a whole
// skill folder: a manifest of every entry (relative path, type, size, executable bit, the file's hash, a link's
// target as written) sorted by path, hashed. It is what an install records as SynaBun's own and compares before
// it replaces or removes anything (lib/skills/ownership.js), and what an import is approved by
// (lib/skills/bundle.js).
//
// Reading a folder never follows a link (a link is an entry, with its target as text), never opens a FIFO or a
// device (listed as `other`, never read), and is bounded in entries, depth and bytes.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readConfinedFile } from '../confined-fs.js';
import { realPathOf } from '../path-confine.js';

export const sha256 = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

/** The revision of a file's content: the hash of its exact bytes. */
export function revisionOf(bytes) {
  return sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf-8'));
}

/** Files the system writes into folders by itself: never part of what a skill is, never copied. */
export const SYSTEM_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export const TREE_LIMITS = Object.freeze({ maxEntries: 5000, maxDepth: 24, maxBytes: 64 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024 });

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The digest of a list of entries: `{ path, type: 'file'|'dir'|'link'|'other', size?, executable?, sha256?, target? }`.
 * Order does not matter; the entries are sorted by path first.
 */
export function manifestDigest(entries) {
  const lines = (entries || []).slice().sort(byPath).map((e) => {
    if (e.type === 'file') return `file\t${e.path}\t${e.size}\t${e.executable ? 'x' : '-'}\t${e.sha256}`;
    if (e.type === 'link') return `link\t${e.path}\t${e.target}`;
    if (e.type === 'dir') return `dir\t${e.path}`;
    return `other\t${e.path}`;
  });
  return sha256(lines.join('\n'));
}

/** The manifest entry of bytes about to be written as one file. */
export function fileEntry(path, bytes, { executable = false } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf-8');
  return { path, type: 'file', size: buf.length, executable: !!executable, sha256: sha256(buf) };
}

/**
 * Read what is at `path` as a manifest, without following any link.
 * @returns {{ kind: 'absent'|'file'|'dir'|'link'|'other', entries: object[], digest: string|null, complete: boolean,
 *   reason?: string }} `digest` is null when the folder could not be read whole (too large, changed while read):
 *   such a destination is never taken for SynaBun's own.
 */
export function readManifest(path, limits = TREE_LIMITS) {
  let st;
  try { st = lstatSync(path); } catch { return { kind: 'absent', entries: [], digest: null, complete: true }; }
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = readlinkSync(path); } catch { target = ''; }
    const entries = [{ path: '.', type: 'link', target }];
    return { kind: 'link', entries, digest: manifestDigest(entries), complete: true };
  }
  if (st.isFile()) {
    let real;
    try {
      real = realPathOf(path);
      const bytes = readConfinedFile(dirname(real), real, { maxBytes: limits.maxFileBytes });
      const entries = [fileEntry('.', bytes, { executable: (st.mode & 0o111) !== 0 })];
      return { kind: 'file', entries, digest: manifestDigest(entries), complete: true };
    } catch (err) {
      return { kind: 'file', entries: [], digest: null, complete: false, reason: String(err?.message || err) };
    }
  }
  if (!st.isDirectory()) return { kind: 'other', entries: [{ path: '.', type: 'other' }], digest: null, complete: false, reason: 'not a file or a folder' };
  const entries = [];
  const state = { bytes: 0, complete: true, reason: '' };
  let base;
  try { base = realPathOf(path); } catch { return { kind: 'dir', entries: [], digest: null, complete: false, reason: 'unresolvable' }; }
  const walk = (dir, rel, depth) => {
    if (!state.complete) return;
    if (depth > limits.maxDepth) { state.complete = false; state.reason = 'too deep'; return; }
    let names;
    try { names = readdirSync(dir).sort(); } catch (err) { state.complete = false; state.reason = String(err?.message || err); return; }
    for (const name of names) {
      if (SYSTEM_NAMES.has(name)) continue;
      if (entries.length >= limits.maxEntries) { state.complete = false; state.reason = 'too many entries'; return; }
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let est;
      try { est = lstatSync(full); } catch { state.complete = false; state.reason = 'changed while read'; return; }
      if (est.isSymbolicLink()) {
        let target = '';
        try { target = readlinkSync(full); } catch { target = ''; }
        entries.push({ path: relPath, type: 'link', target });
      } else if (est.isDirectory()) {
        entries.push({ path: relPath, type: 'dir' });
        walk(full, relPath, depth + 1);
        if (!state.complete) return;
      } else if (est.isFile()) {
        if (est.size > limits.maxFileBytes || state.bytes + est.size > limits.maxBytes) { state.complete = false; state.reason = 'too large'; return; }
        let bytes;
        try { bytes = readConfinedFile(base, full, { maxBytes: limits.maxFileBytes }); } catch (err) { state.complete = false; state.reason = String(err?.message || err); return; }
        state.bytes += bytes.length;
        entries.push(fileEntry(relPath, bytes, { executable: (est.mode & 0o111) !== 0 }));
      } else {
        entries.push({ path: relPath, type: 'other' });
      }
    }
  };
  walk(base, '', 0);
  return { kind: 'dir', entries, digest: state.complete ? manifestDigest(entries) : null, complete: state.complete, ...(state.complete ? {} : { reason: state.reason }) };
}

/** A short form of a digest for people ("sha256:3f2a…9c01"). */
export const shortDigest = (digest) => (typeof digest === 'string' && digest.length > 20 ? `${digest.slice(0, 13)}…${digest.slice(-4)}` : String(digest ?? ''));
