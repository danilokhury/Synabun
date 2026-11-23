// ═══════════════════════════════════════════
// BACKUP GROUPS — what a backup holds, by content
// ═══════════════════════════════════════════
//
// A full backup of the owner's data home was 9,389 MB on 2026-11-21 (151,584 entries). Read from that archive's own
// central directory and sorted into the groups below (MB in the archive / MB before compression):
//
//   scratch         6,128 /  8,574   data/scratch: the working folders of dispatched runs (installers, build
//                                    caches, whole checkouts with node_modules). Temporary, and 65% of the archive
//   media           1,779 /  1,779   what creation runs generated, and screenshots
//   memories        1,058 /  2,477   database/memory.db
//   conversations     266 /    886   the Assistant's conversations, run tails, usage ledger
//   settings           62 /    175   settings, schedules, agents, skills, plans, and every path no rule names
//   caches             60 /    266   per-tab OpenCode configuration folders, the editor's completion serve, hook
//                                    receipts, the link, map and session caches
//   in no backup now   27 /    154   logs (a rotated server log of 50.6 MB among them) and runtime records
//   the manifest        8 /     47
//
// What a backup never held (the updater's files, browser profile folders, the copies of memory.db that migrations
// leave) is not in an archive and was not measured here.
//
// So a backup is made of groups, and the owner chooses which go in (Settings → Backups, saved in
// DATA_HOME/data/backup-selection.json, the same choice for manual and scheduled backups). The default keeps
// everything that cannot be made again and leaves out what can.
//
//   backupGroupOf(archivePath)      the group of one file by its path in the archive, or null: in no backup at all
//   normalizeBackupSelection(v)     { id: boolean } for every group, defaults where nothing (valid) is said
//   selectedBackupGroups(sel)       the ids switched on, in BACKUP_GROUPS order
//   manifestGroups(sel)             what a manifest records: { version, included, excluded }
//   readManifestGroups(manifest)    what an archive holds, for any manifest (one from before groups is read from
//                                   its file list): { recorded, included, excluded, complete, legacy }
//   checkManifestGroups(manifest, entryNames, prefix)   the problems of an archive against what its manifest says
//                                   it holds; [] when it holds exactly that
//
// The rule that keeps this safe: a path no rule names belongs to `settings`, the group that is on by default and
// that the page warns about when it is switched off. A new feature's files are therefore in every default backup
// without anybody adding them here; only what is listed below as regenerable is ever left out by default.
// ═══════════════════════════════════════════

import { LOCK_FILE_NAME } from './rulesets/lock.js';

/** `kind`: irreplaceable (lost for good without a backup), regenerable (SynaBun makes it again), temporary (working files). */
export const BACKUP_GROUPS = Object.freeze([
  Object.freeze({ id: 'memories', kind: 'irreplaceable', default: true }),
  Object.freeze({ id: 'settings', kind: 'irreplaceable', default: true }),
  Object.freeze({ id: 'conversations', kind: 'irreplaceable', default: true }),
  Object.freeze({ id: 'media', kind: 'irreplaceable', default: true }),
  Object.freeze({ id: 'caches', kind: 'regenerable', default: false }),
  Object.freeze({ id: 'scratch', kind: 'temporary', default: false }),
]);
export const BACKUP_GROUP_IDS = Object.freeze(BACKUP_GROUPS.map(group => group.id));
export const BACKUP_GROUPS_VERSION = 1;

const SQLITE_SIDE = ['', '-journal', '-wal', '-shm'];
// Operating-system locks kept as files: the rules installer's (lib/rulesets/lock.js) and the hooks' state lock
// (hooks/claude-code/state.mjs). Opening and closing one in this process can drop a lock this process holds on it.
const LOCK_FILES = [LOCK_FILE_NAME, 'hook-state-lock.sqlite'];
const isLockFile = (lower) => LOCK_FILES.some(file => SQLITE_SIDE.some(suffix => lower === `${file}${suffix}`));

/**
 * True for a lock kept as a file (and the journal, WAL and shm names SQLite could put beside it), whatever the letter
 * case. A backup never copies one and a restore never extracts one over the live file: archives from before
 * 2026-11-21 hold data/hook-state-lock.sqlite.
 */
export function isBackupLockFile(name) {
  return isLockFile(String(name).toLowerCase());
}

/**
 * The owner's backup-encryption key file in data/ (lib/backup-encryption.js): a public key, the private key wrapped by
 * the backup password, and the authentication key. No archive holds it and no restore writes it: a restored backup would otherwise
 * bring back the password (and the key pair) of the day it was made, or a crafted one somebody else's key.
 */
export const BACKUP_ENCRYPTION_FILE = 'backup-encryption.json';

/** True for the backup-encryption key file, whatever the letter case. */
export function isBackupEncryptionFile(name) {
  return String(name).toLowerCase() === BACKUP_ENCRYPTION_FILE;
}

// Records a running install rewrites about itself: restoring one would describe a process that is not there.
const RUNTIME_RECORDS = new Set([
  'server-stdout.log', 'server-stderr.log', 'restart-requested', 'opencode-managed.pid',
  'supervisor.json', 'start-launcher.lock', 'update-handoff.json',
]);
// Folders of data/ no archive holds: the updater's own files, logs, bulk downloads a loop can fetch again, the
// automation browser's Chromium profiles (locked and rewritten while it runs, with its cookies and logins; a copy
// taken under a running browser is not a profile), and imports that were staged and never committed.
const NEVER_DATA_DIRS = new Set(['updater', 'logs', 'youtube-downloads', 'chrome-profile', 'chrome-attach', 'browser-profiles']);
const NEVER_DATA_PATHS = ['skills/staging'];

const SQLITE_JOURNAL_RE = /\.(?:db|bak)-journal$/i;

/**
 * True for a path inside data/ or mcp-data/ (relative to it, forward slashes) that no archive of any kind holds.
 * createVerifiedBackup, the upgrade snapshot and the size estimate all ask this one function.
 */
export function isNeverBackedUp(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/');
  const parts = normalized.split('/');
  const name = parts.at(-1);
  const lower = name.toLowerCase();
  // A local browser profile's folder (data/local-profiles/<id>/…); its definitions (profiles.json) are a plain file.
  if (parts[0] === 'local-profiles' && parts.length > 2) return true;
  if (parts.length > 1 && NEVER_DATA_DIRS.has(parts[0])) return true;
  if (NEVER_DATA_PATHS.some(path => normalized === path || normalized.startsWith(`${path}/`))) return true;
  if (RUNTIME_RECORDS.has(name)) return true;
  if (lower === BACKUP_ENCRYPTION_FILE) return true;
  if (isLockFile(lower)) return true;
  if (lower === '.ds_store' || lower === 'thumbs.db' || lower === 'desktop.ini') return true;
  // Logs, the rotated ones too (server-stdout.log.1 was 50 MB of the archive): a log restored over a newer one is wrong.
  if (/\.log(?:\.\d+)?$/i.test(name)) return true;
  if (lower.endsWith('.tmp') || lower.endsWith('.pid')) return true;
  if (/\.(?:db|sqlite|sqlite3)-(?:wal|shm)$/i.test(name)) return true;
  if (SQLITE_JOURNAL_RE.test(name)) return true;
  return false;
}

/** True for a folder of data/ (relative path) whose every file is never backed up: the walk does not enter it. */
export function isNeverBackedUpDir(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (NEVER_DATA_DIRS.has(parts[0])) return true;
  if (parts[0] === 'local-profiles' && parts.length >= 2) return true;
  return NEVER_DATA_PATHS.some(path => normalized === path || normalized.startsWith(`${path}/`));
}

// data/<folder>/… by group. Anything not named here is `settings`.
const DATA_DIR_GROUPS = new Map([
  ['scratch', 'scratch'],
  ['media', 'media'], ['x-media', 'media'], ['x-showcase', 'media'], ['images', 'media'], ['extension-uploads', 'media'],
  ['assistant', 'conversations'], ['assistant-usage', 'conversations'], ['run-tails', 'conversations'],
  // Made again by what uses them: a tab's OpenCode configuration folder (with its node_modules), the editor's
  // completion serve, the hooks' per-session receipts and flags.
  ['sidepanel-configs', 'caches'], ['editor-complete', 'caches'], ['task-gate', 'caches'], ['memory-context', 'caches'],
  ['pending-remember', 'caches'], ['pending-compact', 'caches'], ['precompact', 'caches'],
]);
// data/<file> by group: the caches the server rebuilds from the memories and the transcripts, and its request journals.
const DATA_FILE_GROUPS = new Map([
  ['assistant-dispatches.json', 'conversations'],
  ['links-cache.json', 'caches'], ['memory-map.json', 'caches'], ['codex-request-journal.json', 'caches'],
  ['ocp-trace.jsonl', 'caches'], ['last-session.json', 'caches'],
]);
const SESSIONS_CACHE_RE = /^sessions-cache-.*\.json$/i;

/**
 * The group of one file, by its path in the archive (`data/…`, `mcp-data/…`, `database/memory.db`, `env.bak`,
 * `global-skills/…`, …). null: a file no backup holds (isNeverBackedUp).
 */
export function backupGroupOf(archivePath) {
  const path = String(archivePath).replace(/\\/g, '/');
  if (path === 'database/memory.db') return 'memories';
  const slash = path.indexOf('/');
  const root = slash < 0 ? path : path.slice(0, slash);
  const rel = slash < 0 ? '' : path.slice(slash + 1);
  if (root === 'data' && rel) {
    if (isNeverBackedUp(rel)) return null;
    const parts = rel.split('/');
    if (parts.length > 1) return DATA_DIR_GROUPS.get(parts[0]) || 'settings';
    if (DATA_FILE_GROUPS.has(parts[0])) return DATA_FILE_GROUPS.get(parts[0]);
    return SESSIONS_CACHE_RE.test(parts[0]) ? 'caches' : 'settings';
  }
  if (root === 'mcp-data' && rel) return isNeverBackedUp(rel) ? null : 'settings';
  // Skills, agents, skins, ~/.claude/settings.json, the .env: a stray system file among them is still not data.
  const name = path.split('/').at(-1).toLowerCase();
  if (name === '.ds_store' || name === 'thumbs.db' || name === 'desktop.ini') return null;
  return 'settings';
}

/** The folders of data/ a group owns outright (relative, one segment): a walk that leaves the group out skips them. */
export function dataDirsOfGroup(id) {
  return [...DATA_DIR_GROUPS].filter(([, group]) => group === id).map(([dir]) => dir);
}

/** { id: boolean } for every group. Anything that is not a boolean for a known id is the group's default. */
export function normalizeBackupSelection(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const selection = {};
  for (const group of BACKUP_GROUPS) selection[group.id] = typeof source[group.id] === 'boolean' ? source[group.id] : group.default;
  return selection;
}

/** The ids switched on, in BACKUP_GROUPS order. `selection` null or undefined: every group (a backup of everything). */
export function selectedBackupGroups(selection) {
  if (selection == null) return [...BACKUP_GROUP_IDS];
  if (Array.isArray(selection)) return BACKUP_GROUP_IDS.filter(id => selection.includes(id));
  const normalized = normalizeBackupSelection(selection);
  return BACKUP_GROUP_IDS.filter(id => normalized[id]);
}

/** The irreplaceable groups a selection leaves out (what the page warns about). */
export function irreplaceableLeftOut(selection) {
  const on = new Set(selectedBackupGroups(selection));
  return BACKUP_GROUPS.filter(group => group.kind === 'irreplaceable' && !on.has(group.id)).map(group => group.id);
}

/** What a manifest records about its groups. */
export function manifestGroups(selection) {
  const included = selectedBackupGroups(selection);
  return { version: BACKUP_GROUPS_VERSION, included, excluded: BACKUP_GROUP_IDS.filter(id => !included.includes(id)) };
}

const cleanIds = (list) => [...new Set((Array.isArray(list) ? list : []).filter(id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(id)))];

/**
 * What an archive holds, from its manifest.
 *   recorded  the manifest says so itself (a backup made with groups)
 *   included / excluded   group ids; for a manifest from before groups, `included` is read from its file list and
 *             `excluded` is the known groups it has no file of
 *   complete  every group known to this version is in it
 *   legacy    null | 'complete' | 'state-only' (an upgrade snapshot: state, without generated media)
 */
export function readManifestGroups(manifest) {
  const groups = manifest?.groups;
  if (groups && typeof groups === 'object' && Array.isArray(groups.included)) {
    const included = cleanIds(groups.included);
    const excluded = cleanIds(groups.excluded).filter(id => !included.includes(id));
    // A group this version knows and the manifest names nowhere (a backup from an older version): not in it.
    for (const id of BACKUP_GROUP_IDS) if (!included.includes(id) && !excluded.includes(id)) excluded.push(id);
    return { recorded: true, included, excluded, complete: BACKUP_GROUP_IDS.every(id => included.includes(id)), legacy: null };
  }
  const found = new Set();
  if (manifest?.database || (Array.isArray(manifest?.files) && manifest.files.includes('database/memory.db'))) found.add('memories');
  for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
    const group = backupGroupOf(file);
    if (group) found.add(group);
    if (found.size === BACKUP_GROUP_IDS.length) break;
  }
  const included = BACKUP_GROUP_IDS.filter(id => found.has(id));
  const legacy = manifest?.scope === 'state-only' ? 'state-only' : 'complete';
  return { recorded: false, included, excluded: BACKUP_GROUP_IDS.filter(id => !found.has(id)), complete: legacy === 'complete', legacy };
}

/**
 * Does the archive hold exactly what its manifest says? Returns the problems as sentences, [] for none. Only a
 * manifest that records its groups is checked (one from before them promised nothing about groups):
 *   - every listed file belongs to an included group (a file of a group the manifest calls excluded is refused);
 *   - the memory database is there exactly when `memories` is included;
 *   - the archive has no entry the manifest does not list (nothing rides along unverified).
 * @param {object} manifest
 * @param {Iterable<string>} entryNames  every file entry of the archive, as named in it
 * @param {string} prefix                the archive's folder (BACKUP_PREFIX)
 */
export function checkManifestGroups(manifest, entryNames, prefix) {
  const read = readManifestGroups(manifest);
  if (!read.recorded) return [];
  const problems = [];
  const included = new Set(read.included);
  const listed = new Set(Array.isArray(manifest.files) ? manifest.files : []);
  for (const file of listed) {
    const group = backupGroupOf(file);
    if (group && !included.has(group)) { problems.push(`${file} belongs to "${group}", which this backup says it does not contain`); break; }
  }
  const hasDatabase = listed.has('database/memory.db');
  // `absent`: the group was asked for and the data home had no memory database to give (a fresh install).
  const absent = cleanIds(manifest.groups.absent);
  if (included.has('memories') && !(hasDatabase && manifest.database) && !absent.includes('memories')) problems.push('the backup says it contains the memories, but the memory database is not in it');
  if (!included.has('memories') && (hasDatabase || manifest.database)) problems.push('the backup says it does not contain the memories, but a memory database is in it');
  const lead = prefix ? `${prefix}/` : '';
  for (const name of entryNames) {
    if (!name.startsWith(lead) || name.endsWith('/')) continue;
    const rel = name.slice(lead.length);
    if (rel === 'manifest.json') continue;
    if (!listed.has(rel)) { problems.push(`${rel} is in the archive but not in its manifest`); break; }
  }
  return problems;
}

// ── Size estimates ──
// What a file takes in the archive, roughly, by what it is: stored as it is when already compressed, SQLite and text
// at the ratios measured on the 2026-11-21 archive (memory.db 0.43, JSON lines 0.31, mixed source trees 0.3 to 0.4).
const STORED = new Set(['.avif', '.gif', '.ico', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.ogg', '.png', '.webm', '.webp', '.woff', '.woff2', '.zip',
  '.7z', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.exe', '.dmg', '.pkg', '.msi', '.onnx', '.heic', '.m4a', '.m4v', '.mkv', '.pdf', '.wav']);
const TEXT = new Set(['.json', '.jsonl', '.md', '.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.cts', '.mts', '.map', '.css', '.html',
  '.yaml', '.yml', '.toml', '.svg', '.xml', '.csv', '.h', '.c', '.cc', '.cpp', '.py', '.sh', '.vue', '.svelte', '.mdx', '.bak', '.env']);

/** About how many bytes a file of `bytes` takes in the archive. An estimate for the page, never used to decide. */
export function estimateArchivedBytes(archivePath, bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  const name = String(archivePath).toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot > name.lastIndexOf('/') ? name.slice(dot) : '';
  if (STORED.has(ext)) return size;
  if (ext === '.db' || ext === '.sqlite' || ext === '.sqlite3') return Math.round(size * 0.45);
  if (TEXT.has(ext)) return Math.round(size * 0.33);
  return Math.round(size * 0.7);
}
