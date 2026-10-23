// ── What SynaBun installed, and only that ──
// Installing a bundled skill into a runtime (Claude Code's skills folder, Codex's prompts, OpenCode's commands)
// writes into folders that belong to the user. A destination is replaced or removed only when it is provably
// SynaBun's own:
//   - absent: written;
//   - identical: it already holds exactly what would be written (by digest): nothing to do, and it is recorded;
//   - owned: the install ledger records that SynaBun wrote it, and it still holds exactly that;
//   - modified: SynaBun wrote it but it was changed since; unowned: SynaBun has no record of it, and it holds
//     something else. Both are refused (409) unless the request names the digest of what is there now, which a
//     person sees before confirming (`expectedDestinationDigest`): the decision is bound to that state;
//   - unreadable (too large, a FIFO, changed while read): refused, always.
// Whatever is replaced or removed is copied first into a backup (DATA_HOME/data/skills/backups/<id>/), and the
// ledger (DATA_HOME/data/skills/installs.json) keeps every install with its digest and its source. A link is a
// destination like any other: its target is recorded, never followed, never removed through.
//
// This is the first piece of the managed skill library (owner decision, 2026-10-22): per-target install
// records with digests, backups and rollback. The library's revisions and its per-runtime exports extend it.

import { chmodSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { PathConfineError, isPlainName, realPathOf } from '../path-confine.js';
import { listConfined, makeConfinedDir, readConfinedFile, removeConfinedEntry, replaceFileAtomic, writeConfinedFile } from '../confined-fs.js';
import { SYSTEM_NAMES, fileEntry, manifestDigest, readManifest, shortDigest } from './digest.js';

export const LEDGER_VERSION = 1;
export const MAX_BACKUPS = 100;
export const MAX_JOURNAL = 500;
// The ledger is read whole only up to this: one larger is not read, nothing is claimed from it, and nothing is
// written over it (a write would lose what it holds).
export const LEDGER_MAX_BYTES = 16 * 1024 * 1024;

export class InstallRefusedError extends PathConfineError {
  constructor(message, details = {}) {
    super(409, message);
    Object.assign(this, details);
  }
}

const STATE_WORDS = {
  modified: 'was installed by SynaBun but has been changed since',
  unowned: 'was not installed by SynaBun',
  unreadable: 'could not be read whole',
};

/**
 * @param {object} o
 * @param {string} o.dataDir where the ledger and the backups live (DATA_HOME/data/skills)
 * @param {() => string} [o.now] ISO time
 * @param {() => string} [o.random] a short random tag for backup names
 */
export function createSkillInstaller({ dataDir, now = () => new Date().toISOString(), random = () => randomBytes(4).toString('hex') }) {
  const ledgerPath = join(dataDir, 'installs.json');
  const backupsDir = join(dataDir, 'backups');

  const emptyLedger = () => ({ schemaVersion: LEDGER_VERSION, records: [], journal: [] });
  // The parse of the ledger as the file was at `key` (its inode, size and times): a catalog scan or a bridge
  // search asks for one record per entry, and the file is parsed once while it does not change.
  let cached = null;
  let parses = 0;
  const fileKey = () => { try { const st = statSync(ledgerPath); return { st, key: `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` }; } catch { return null; } };

  /** The ledger as the file holds it now, for reading only (never changed in place). `state`: ok | absent | invalid | too-large. */
  function ledgerView() {
    const at = fileKey();
    if (!at) { cached = null; return { ledger: emptyLedger(), state: 'absent' }; }
    if (cached && cached.key === at.key) return cached;
    let ledger = emptyLedger();
    let state = 'ok';
    if (!at.st.isFile() || at.st.size > LEDGER_MAX_BYTES) state = 'too-large';
    else {
      try {
        const parsed = JSON.parse(readConfinedFile(dataDir, ledgerPath, { maxBytes: LEDGER_MAX_BYTES, encoding: 'utf-8' }));
        parses += 1;
        if (parsed && parsed.schemaVersion === LEDGER_VERSION && Array.isArray(parsed.records)) {
          ledger = { schemaVersion: LEDGER_VERSION, records: parsed.records.filter((r) => r && typeof r.destination === 'string'), journal: Array.isArray(parsed.journal) ? parsed.journal : [] };
        } else state = 'invalid';
      } catch { state = 'invalid'; /* unreadable: no record is a claim */ }
    }
    cached = { key: at.key, ledger, state };
    return cached;
  }

  /** A copy of the ledger to change and write back. One over its bound is refused: writing it would lose it. */
  function readLedger({ forWrite = false } = {}) {
    const view = ledgerView();
    if (forWrite && view.state === 'too-large') {
      throw Object.assign(new PathConfineError(413, `The install ledger (${ledgerPath}) is larger than ${Math.round(LEDGER_MAX_BYTES / (1024 * 1024))} MB: SynaBun does not write over a ledger it cannot read. Move it away to start a new one.`), { code: 'ledger_too_large' });
    }
    return { schemaVersion: LEDGER_VERSION, records: view.ledger.records.map((r) => ({ ...r })), journal: [...view.ledger.journal] };
  }

  function writeLedger(ledger) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const out = { schemaVersion: LEDGER_VERSION, records: ledger.records, journal: ledger.journal.slice(-MAX_JOURNAL) };
    replaceFileAtomic(ledgerPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    // What was just written is what the file holds: kept, not read again.
    const at = fileKey();
    cached = at ? { key: at.key, ledger: { schemaVersion: LEDGER_VERSION, records: out.records.map((r) => ({ ...r })), journal: [...out.journal] }, state: 'ok' } : null;
  }

  const keyOf = (destination) => resolve(String(destination));
  const recordOf = (ledger, destination) => ledger.records.find((r) => keyOf(r.destination) === keyOf(destination)) || null;

  function journal(ledger, entry) {
    ledger.journal.push({ at: now(), ...entry });
  }

  // ── Payloads: what an install writes ──

  /** Every regular file and folder of a source folder (links inside it followed only to what is inside it). */
  function payloadFromFolder(dir) {
    const real = realPathOf(dir);
    const listing = listConfined(real, real, { skip: (name) => SYSTEM_NAMES.has(name) });
    if (listing.truncated) throw new PathConfineError(413, 'That skill has too many files to install.');
    const files = []; const dirs = []; const entries = [];
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.type === 'dir') { dirs.push(node.path); entries.push({ path: node.path, type: 'dir' }); walk(node.children || []); continue; }
        const bytes = readConfinedFile(real, node.real);
        const executable = (lstatSync(node.real).mode & 0o111) !== 0;
        files.push({ path: node.path, bytes, executable });
        entries.push(fileEntry(node.path, bytes, { executable }));
      }
    };
    walk(listing.entries);
    return { kind: 'dir', files, dirs, digest: manifestDigest(entries) };
  }

  /** One file's content (a Codex or OpenCode bridge). */
  function payloadFromText(text) {
    const bytes = Buffer.from(String(text ?? ''), 'utf-8');
    return { kind: 'file', bytes, executable: false, digest: manifestDigest([fileEntry('.', bytes)]) };
  }

  // ── The state of a destination ──

  /**
   * @returns {{ state: 'absent'|'identical'|'owned'|'modified'|'unowned'|'unreadable', current: object, record: object|null }}
   */
  function inspect({ destination, payload = null }) {
    const record = recordOf(ledgerView().ledger, destination);
    const current = readManifest(destination);
    let state;
    if (current.kind === 'absent') state = 'absent';
    else if (!current.digest) state = 'unreadable';
    else if (payload && current.digest === payload.digest && current.kind === payload.kind) state = 'identical';
    else if (record && record.digest === current.digest) state = 'owned';
    else if (record) state = 'modified';
    else state = 'unowned';
    return { state, current, record };
  }

  function refuse(action, { state, current, destination, target, name }) {
    const what = `"${destination}" ${STATE_WORDS[state] || 'is not SynaBun\'s'}`;
    const how = state === 'unreadable'
      ? 'Move it away yourself and try again.'
      : `Nothing was ${action === 'install' ? 'replaced' : 'removed'}. To ${action === 'install' ? 'replace' : 'remove'} it anyway, confirm it as it is now (${shortDigest(current.digest)}): a backup is kept.`;
    throw new InstallRefusedError(`${what}. ${how}`, {
      code: state === 'modified' ? 'skill_modified' : state === 'unreadable' ? 'skill_unreadable' : 'skill_unowned',
      state, destination, target, name, currentDigest: current.digest || null, action,
    });
  }

  const confirmed = (decision, current) => !!current.digest && typeof decision?.expectedDestinationDigest === 'string' && decision.expectedDestinationDigest === current.digest;

  // ── Backups ──

  function pruneBackups() {
    let names = [];
    try { names = readdirSync(backupsDir).filter((n) => !n.startsWith('.')).sort(); } catch { return; }
    for (const old of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
      try { rmSync(join(backupsDir, old), { recursive: true, force: true }); } catch { /* the next prune tries again */ }
    }
  }

  /** Copy what is at `destination` into a new backup, without following links. @returns the backup id */
  function backup({ destination, target, name, reason }) {
    const stamp = now().replace(/[:.]/g, '-');
    const id = `${stamp}-${String(target).replace(/[^a-z0-9-]/gi, '')}-${String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)}-${random()}`;
    const dir = join(backupsDir, id);
    mkdirSync(join(dir, 'entry'), { recursive: true, mode: 0o700 });
    const entryRoot = join(dir, 'entry');
    const manifest = readManifest(destination);
    const links = [];
    const skipped = [];
    // Every file's and folder's own mode (permission bits), put back by a restore or a rollback exactly: a private
    // 0600 file stays 0600. The copies in the backup itself are private (0600 / 0700) whatever the original was.
    const modes = {};
    const st = lstatSync(destination);
    if (st.isSymbolicLink()) links.push({ path: '.', target: readlinkSync(destination) });
    else if (st.isFile()) {
      const real = realPathOf(destination);
      modes['.'] = st.mode & 0o777;
      writeConfinedFile(entryRoot, join(entryRoot, 'file'), readConfinedFile(dirname(real), real), { exclusive: true, mode: (st.mode & 0o111) ? 0o700 : 0o600 });
    } else if (st.isDirectory()) {
      const base = realPathOf(destination);
      modes['.'] = st.mode & 0o777;
      const walk = (from, rel) => {
        for (const n of readdirSync(from).sort()) {
          const full = join(from, n);
          const relPath = rel ? `${rel}/${n}` : n;
          const est = lstatSync(full);
          if (est.isSymbolicLink()) links.push({ path: relPath, target: readlinkSync(full) });
          else if (est.isDirectory()) { modes[relPath] = est.mode & 0o777; makeConfinedDir(entryRoot, join(entryRoot, 'tree', relPath)); walk(full, relPath); }
          else if (est.isFile()) { modes[relPath] = est.mode & 0o777; writeConfinedFile(entryRoot, join(entryRoot, 'tree', relPath), readConfinedFile(base, full), { exclusive: true, mode: (est.mode & 0o111) ? 0o700 : 0o600 }); }
          else skipped.push(relPath);
        }
      };
      makeConfinedDir(entryRoot, join(entryRoot, 'tree'));
      walk(base, '');
    }
    const meta = { schemaVersion: 1, id, at: now(), reason, target, name, destination, kind: manifest.kind, digest: manifest.digest, entries: manifest.entries.map(({ path, type, size, executable, sha256, target: t }) => ({ path, type, size, executable, sha256, target: t })), links, skipped, modes };
    writeConfinedFile(dir, join(dir, 'backup.json'), `${JSON.stringify(meta, null, 2)}\n`, { exclusive: true, mode: 0o600 });
    pruneBackups();
    return id;
  }

  /** Put a backup back where it was taken from (the destination must be free). */
  function restore(id, { root }) {
    if (!isPlainName(id)) throw new PathConfineError(400, 'Not a backup id.');
    const dir = join(backupsDir, id);
    const meta = JSON.parse(readConfinedFile(dir, join(dir, 'backup.json'), { maxBytes: 8 * 1024 * 1024, encoding: 'utf-8' }));
    const destination = meta.destination;
    if (resolve(dirname(destination)) !== resolve(root)) throw new PathConfineError(403, 'That backup is of another folder.');
    try { lstatSync(destination); throw new PathConfineError(409, `"${destination}" exists: the backup is not put back over it.`); } catch (err) { if (err instanceof PathConfineError) throw err; }
    const rootLink = meta.links.find((l) => l.path === '.');
    if (rootLink) { symlinkSync(rootLink.target, destination); return destination; }
    const modeOf = (path, executable) => backupMode(meta, path, executable);
    if (meta.kind === 'file') {
      const bytes = readConfinedFile(join(dir, 'entry'), join(dir, 'entry', 'file'));
      const mode = modeOf('.', meta.entries[0]?.executable);
      writeConfinedFile(root, destination, bytes, { exclusive: true, mode });
      chmodSync(destination, mode);
      return destination;
    }
    makeConfinedDir(root, destination);
    const real = realPathOf(destination);
    for (const e of meta.entries) {
      if (e.type === 'dir') makeConfinedDir(real, join(real, e.path));
      else if (e.type === 'file') {
        const mode = modeOf(e.path, e.executable);
        writeConfinedFile(real, join(real, e.path), readConfinedFile(join(dir, 'entry'), join(dir, 'entry', 'tree', e.path)), { exclusive: true, mode });
        chmodSync(join(real, e.path), mode);
      }
    }
    for (const l of meta.links) if (l.path !== '.') { try { symlinkSync(l.target, join(real, l.path)); } catch { /* left out, as it is in the backup's list */ } }
    // Folders last, deepest first: a folder that was not writable is made so only after its files are in.
    applyFolderModes(real, meta);
    return destination;
  }

  // ── Writing a payload ──

  function writePayload(root, destination, payload) {
    if (payload.kind === 'file') {
      writeConfinedFile(root, destination, payload.bytes, { exclusive: true, mode: payload.executable ? 0o755 : 0o644 });
      return;
    }
    makeConfinedDir(root, destination);
    const real = realPathOf(destination);
    for (const d of payload.dirs) makeConfinedDir(real, join(real, d));
    for (const f of payload.files) writeConfinedFile(real, join(real, f.path), f.bytes, { exclusive: true, mode: f.executable ? 0o755 : 0o644 });
  }

  function checkPlace(root, destination) {
    if (resolve(dirname(String(destination))) !== resolve(String(root)) || !isPlainName(basename(String(destination)))) {
      throw new PathConfineError(400, 'An install goes into its runtime folder, by a plain name.');
    }
  }

  /**
   * Install `payload` at `destination` (a plain name in `root`).
   * @param {object} o
   * @param {'claude'|'codex'|'opencode'} o.target @param {string} o.name @param {string} o.root @param {string} o.destination
   * @param {object} o.payload from payloadFromFolder / payloadFromText
   * @param {object} [o.source] where the payload came from ({ kind: 'bundled', name, digest })
   * @param {{ expectedDestinationDigest?: string }} [o.decision] the person confirmed replacing what is there now
   * @returns {{ ok: true, changed: boolean, state: string, backupId: string|null, digest: string }}
   */
  function install({ target, name, root, destination, payload, source = null, decision = {} }) {
    checkPlace(root, destination);
    const { state, current } = inspect({ destination, payload });
    const ledger = readLedger({ forWrite: true });
    const record = { target, name, destination: keyOf(destination), kind: payload.kind, digest: payload.digest, source, installedAt: now() };
    if (state === 'identical') {
      ledger.records = ledger.records.filter((r) => keyOf(r.destination) !== keyOf(destination)).concat([{ ...(recordOf(ledger, destination) || {}), ...record }]);
      journal(ledger, { action: 'install', target, name, destination: record.destination, result: 'already-installed', digest: payload.digest });
      writeLedger(ledger);
      return { ok: true, changed: false, state, backupId: null, digest: payload.digest };
    }
    if (state === 'unreadable') refuse('install', { state, current, destination, target, name });
    if ((state === 'modified' || state === 'unowned') && !confirmed(decision, current)) refuse('install', { state, current, destination, target, name });
    let backupId = null;
    if (state !== 'absent') {
      backupId = backup({ destination, target, name, reason: `install over ${state}` });
      // Changed between the look and now: what the backup holds is what was confirmed, or nothing happens.
      const again = readManifest(destination);
      if (again.digest !== current.digest) throw new PathConfineError(409, 'That folder changed while it was being installed over. Nothing was replaced.');
      removeConfinedEntry(root, destination);
    }
    try {
      writePayload(root, destination, payload);
      const written = readManifest(destination);
      if (written.digest !== payload.digest) throw new PathConfineError(500, 'The installed files do not match what was meant to be written.');
    } catch (err) {
      try { removeConfinedEntry(root, destination); } catch { /* nothing more to take away */ }
      if (backupId) { try { restore(backupId, { root }); } catch { /* the backup stays where it is */ } }
      throw err;
    }
    ledger.records = ledger.records.filter((r) => keyOf(r.destination) !== keyOf(destination)).concat([{ ...record, backupId }]);
    journal(ledger, { action: 'install', target, name, destination: record.destination, result: state === 'absent' ? 'installed' : `replaced-${state}`, digest: payload.digest, backupId });
    writeLedger(ledger);
    return { ok: true, changed: true, state, backupId, digest: payload.digest };
  }

  /**
   * Remove what an install put at `destination`.
   * @param {object} o same as install(); `payload` is what installing now would write (a destination that holds
   *   exactly that is SynaBun's to remove even without a record)
   * @returns {{ ok: true, changed: boolean, state: string, backupId: string|null }}
   */
  function uninstall({ target, name, root, destination, payload = null, decision = {} }) {
    checkPlace(root, destination);
    const { state, current } = inspect({ destination, payload });
    const ledger = readLedger({ forWrite: true });
    if (state === 'absent') {
      const had = ledger.records.length;
      ledger.records = ledger.records.filter((r) => keyOf(r.destination) !== keyOf(destination));
      if (ledger.records.length !== had) { journal(ledger, { action: 'uninstall', target, name, destination: keyOf(destination), result: 'already-absent' }); writeLedger(ledger); }
      return { ok: true, changed: false, state, backupId: null };
    }
    if (state === 'unreadable') refuse('uninstall', { state, current, destination, target, name });
    if ((state === 'modified' || state === 'unowned') && !confirmed(decision, current)) refuse('uninstall', { state, current, destination, target, name });
    const backupId = backup({ destination, target, name, reason: `uninstall ${state}` });
    const again = readManifest(destination);
    if (again.digest !== current.digest) throw new PathConfineError(409, 'That folder changed while it was being removed. Nothing was removed.');
    removeConfinedEntry(root, destination);
    ledger.records = ledger.records.filter((r) => keyOf(r.destination) !== keyOf(destination));
    journal(ledger, { action: 'uninstall', target, name, destination: keyOf(destination), result: `removed-${state}`, backupId });
    writeLedger(ledger);
    return { ok: true, changed: true, state, backupId };
  }

  /** Record something SynaBun wrote by another way (an import, a customised copy): its provenance, for later updates. */
  function recordWrite({ target, name, destination, digest, kind, source }) {
    const ledger = readLedger({ forWrite: true });
    ledger.records = ledger.records.filter((r) => keyOf(r.destination) !== keyOf(destination)).concat([{ target, name, destination: keyOf(destination), kind, digest, source, installedAt: now() }]);
    journal(ledger, { action: source?.kind || 'write', target, name, destination: keyOf(destination), result: 'written', digest });
    writeLedger(ledger);
  }

  /**
   * Stop claiming a destination: what is there is no longer SynaBun's (a rollback put the user's own folder back,
   * or SynaBun's copy was removed by another route). Journaled; nothing on disk changes.
   */
  function forget({ destination, target = null, name = null, reason = 'released' }) {
    const ledger = readLedger({ forWrite: true });
    const had = ledger.records.length;
    ledger.records = ledger.records.filter((r) => keyOf(r.destination) !== keyOf(destination));
    if (ledger.records.length === had) return false;
    journal(ledger, { action: 'release', target, name, destination: keyOf(destination), result: reason });
    writeLedger(ledger);
    return true;
  }

  /** The ledger's record of a destination, or null. */
  function recordFor(destination) {
    const found = recordOf(ledgerView().ledger, destination);
    return found ? { ...found } : null;
  }

  /** Append one line to the journal (an action another module carried out on a destination SynaBun owns). */
  function note(entry) {
    const ledger = readLedger({ forWrite: true });
    journal(ledger, entry);
    writeLedger(ledger);
  }

  /**
   * A backup's files, read back (for a rollback that swaps them into place).
   * @returns {{ meta: object, kind: string, files: {path, bytes, executable}[], dirs: string[], links: object[] }}
   */
  function readBackup(id) {
    if (!isPlainName(id)) throw new PathConfineError(400, 'Not a backup id.');
    const dir = join(backupsDir, id);
    let meta;
    try { meta = JSON.parse(readConfinedFile(dir, join(dir, 'backup.json'), { maxBytes: 8 * 1024 * 1024, encoding: 'utf-8' })); } catch {
      throw new PathConfineError(404, 'That backup is no longer kept.');
    }
    const files = []; const dirs = [];
    if (meta.kind === 'file') {
      files.push({ path: '.', bytes: readConfinedFile(join(dir, 'entry'), join(dir, 'entry', 'file')), executable: !!meta.entries?.[0]?.executable, mode: backupMode(meta, '.', meta.entries?.[0]?.executable) });
    } else if (meta.kind === 'dir') {
      for (const e of meta.entries || []) {
        if (e.type === 'dir') dirs.push(e.path);
        else if (e.type === 'file') files.push({ path: e.path, bytes: readConfinedFile(join(dir, 'entry'), join(dir, 'entry', 'tree', e.path)), executable: !!e.executable, mode: backupMode(meta, e.path, e.executable) });
      }
    }
    const dirModes = {};
    for (const [path, mode] of Object.entries(meta.modes || {})) if (path === '.' || dirs.includes(path)) dirModes[path] = mode & 0o777;
    return { meta, kind: meta.kind, files, dirs, dirModes, links: meta.links || [] };
  }

  /** How often the ledger file was parsed (it is parsed again only when it changed). */
  const stats = () => ({ ledgerParses: parses });

  return { inspect, install, uninstall, backup, restore, recordWrite, forget, recordFor, note, readBackup, payloadFromFolder, payloadFromText, readLedger, stats, paths: { ledgerPath, backupsDir } };
}

/**
 * The mode a backed-up file is put back with: its own, as recorded (permission bits only), or, for a backup made
 * before modes were recorded, 0755 / 0644 by its executable bit.
 */
export function backupMode(meta, path, executable) {
  const recorded = meta?.modes?.[path];
  return Number.isInteger(recorded) ? recorded & 0o777 : (executable ? 0o755 : 0o644);
}

/** Give a restored folder and the folders in it their recorded modes, deepest first. */
export function applyFolderModes(real, meta) {
  const entries = Object.entries(meta?.modes || {}).filter(([path]) => path === '.' || (meta.entries || []).some((e) => e.type === 'dir' && e.path === path));
  entries.sort((a, b) => (b[0] === '.' ? -1 : b[0].split('/').length) - (a[0] === '.' ? -1 : a[0].split('/').length));
  for (const [path, mode] of entries) {
    try { chmodSync(path === '.' ? real : join(real, path), mode & 0o777); } catch { /* the folder keeps the mode it was made with */ }
  }
}
