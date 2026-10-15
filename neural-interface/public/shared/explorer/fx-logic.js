// ═══════════════════════════════════════════
// SynaBun Neural Interface — File Explorer: what decides
// ═══════════════════════════════════════════
//
// Everything of the explorer that needs no page: paths, order, what git says
// about a row, the trees of the filter and of "changed only", selection, what
// a key means, what a menu holds, how a failure is worded, what is kept per
// project. The modules that draw (fx-tree.js, fx-popups.js) and the one that
// acts (fx-ops.js) ask here. The only import is the names module, which has
// none: `node --test` loads this file as it is.

import { compareNames } from './fx-names.js';

// ── Paths (always with forward slashes, never ending in one) ──

export const slashes = (path) => String(path ?? '').replace(/\\/g, '/');
export const trimSlash = (path) => { const p = slashes(path); return p.length > 1 ? p.replace(/\/+$/, '') : p; };
export const baseName = (path) => { const p = trimSlash(path); return p.slice(p.lastIndexOf('/') + 1); };
export const dirName = (path) => { const p = trimSlash(path); const cut = p.lastIndexOf('/'); return cut <= 0 ? p.slice(0, cut + 1) : p.slice(0, cut); };
export const joinPath = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);

/** `path` below `root` ('' for the root itself), or null when it is not inside it. */
export function relativeTo(root, path) {
  const r = trimSlash(root); const p = trimSlash(path);
  if (p === r) return '';
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
}

/** Whether `path` is `folder` or below it. */
export const isWithin = (folder, path) => relativeTo(folder, path) !== null;

/** Of several paths, the ones not inside another of them (a folder and a file in it are one thing to move). */
export function topLevelOf(paths) {
  const list = [...new Set(paths.map(trimSlash))];
  return list.filter((path) => !list.some((other) => other !== path && isWithin(other, path)));
}

// ── Order ──

/**
 * Folders first, then by name in natural, case-insensitive order; or files by the time they changed or by size.
 * @param {{ name: string, type: string, size?: number, mtime?: number }[]} items
 * @param {'name' | 'date' | 'size'} [mode]
 */
export function sortItems(items, mode = 'name') {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    if (a.type === 'file' && mode === 'date' && (a.mtime || b.mtime) && a.mtime !== b.mtime) return (b.mtime || 0) - (a.mtime || 0);
    if (a.type === 'file' && mode === 'size' && a.size !== b.size) return (b.size || 0) - (a.size || 0);
    return compareNames(a.name, b.name);
  });
}

/** Whether two listings show the same rows (a folder that was read again and did not change is not drawn again). */
export function sameListing(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x.name !== y.name || x.type !== y.type || x.size !== y.size || x.mtime !== y.mtime || !!x.link !== !!y.link || !!x.outside !== !!y.outside || !!x.broken !== !!y.broken) return false;
  }
  return true;
}

/**
 * Of several readings of one thing that overlap, the one that was asked for last is the one that counts: a
 * folder is read when it is opened and again when the watcher tells of a change, and the older answer may be the
 * one that arrives last. `take(key)` begins a reading and answers a function that says, when its answer is
 * there, whether that reading is still the latest one of `key`. An answer that is not is dropped.
 * @returns {{ take: (key: string) => () => boolean, clear: () => void }}
 */
export function latestOnly() {
  const turns = new Map();   // key → the number of the reading asked for last
  return {
    take(key) {
      const turn = (turns.get(key) || 0) + 1;
      turns.set(key, turn);
      return () => turns.get(key) === turn;
    },
    clear() { turns.clear(); },
  };
}

// ── Git ──

/** The letter a row shows for its state, and the tone it is drawn in. */
export const GIT_MARKS = Object.freeze({
  modified: { letter: 'M', tone: 'modified' },
  mixed: { letter: 'M', tone: 'modified' },
  staged: { letter: 'M', tone: 'modified' },
  renamed: { letter: 'R', tone: 'modified' },
  added: { letter: 'A', tone: 'new' },
  untracked: { letter: 'U', tone: 'new' },
  deleted: { letter: 'D', tone: 'deleted' },
  conflict: { letter: '!', tone: 'conflict' },
});
const TONE_RANK = { new: 1, deleted: 2, modified: 2, conflict: 3 };

const NO_GIT = Object.freeze({ isGit: false, branch: '', count: 0, statusOf: () => null, toneOf: () => null, isIgnored: () => false, changed: () => [] });

/**
 * What git says about the paths of a project, ready to be asked row by row.
 * @param {{ isGit?: boolean, branch?: string, changes?: Record<string, string>, ignored?: string[] } | null} state
 *   what GET /api/explorer/git answered: paths below the project, a folder ends in `/`
 * @returns {{ isGit: boolean, branch: string, count: number,
 *   statusOf: (rel: string, isDir: boolean) => string | null, toneOf: (rel: string, isDir: boolean) => string | null,
 *   isIgnored: (rel: string) => boolean, changed: () => { path: string, type: string, status: string }[] }}
 *   a file's status is its own, or `untracked` inside a new folder; a folder's tone is the strongest of what it holds
 */
export function gitIndex(state) {
  if (!state?.isGit) return NO_GIT;
  const files = new Map();      // file → status
  const wholeDirs = new Map();  // folder git names as a whole (new: nothing in it is tracked) → status
  const holds = new Map();      // folder → the strongest tone below it
  const entries = Object.entries(state.changes || {});
  for (const [path, status] of entries) {
    const isDir = path.endsWith('/');
    const clean = isDir ? path.slice(0, -1) : path;
    if (!clean || !GIT_MARKS[status]) continue;
    (isDir ? wholeDirs : files).set(clean, status);
    const tone = GIT_MARKS[status].tone;
    for (let at = clean; ;) {
      const cut = at.lastIndexOf('/');
      if (cut < 0) break;
      at = at.slice(0, cut);
      if ((TONE_RANK[holds.get(at)] || 0) < TONE_RANK[tone]) holds.set(at, tone === 'deleted' ? 'modified' : tone);
    }
  }
  const ignoredDirs = new Set(); const ignoredFiles = new Set();
  for (const path of state.ignored || []) (path.endsWith('/') ? ignoredDirs.add(path.slice(0, -1)) : ignoredFiles.add(path));
  const above = (rel, table) => {
    for (let at = rel; ;) {
      const cut = at.lastIndexOf('/');
      if (cut < 0) return undefined;
      at = at.slice(0, cut);
      if (table.has(at)) return table instanceof Map ? table.get(at) : true;
    }
  };
  const statusOf = (rel, isDir) => {
    if (!rel) return null;
    if (isDir) return wholeDirs.get(rel) || above(rel, wholeDirs) || null;
    return files.get(rel) || above(rel, wholeDirs) || null;
  };
  return {
    isGit: true,
    branch: state.branch || '',
    count: entries.length,
    statusOf,
    toneOf(rel, isDir) {
      const own = statusOf(rel, isDir);
      if (own) return GIT_MARKS[own].tone;
      return isDir ? holds.get(rel) || null : null;
    },
    // git's own folder is not a file of the project either: it is dimmed with what git ignores.
    isIgnored: (rel) => !!rel && (rel === '.git' || rel.startsWith('.git/') || ignoredFiles.has(rel) || ignoredDirs.has(rel) || !!above(rel, ignoredDirs)),
    changed: () => entries.filter(([, status]) => GIT_MARKS[status]).map(([path, status]) => (path.endsWith('/')
      ? { path: path.slice(0, -1), type: 'dir', status }
      : { path, type: 'file', status, ...(status === 'deleted' ? { missing: true } : {}) })),
  };
}

// ── A tree made of paths (the filter's answer, and "changed only") ──

/**
 * The folders a list of paths spans, each with the entries to show in it.
 * @param {{ path: string, type: 'dir' | 'file' }[]} entries paths below the project
 * @returns {Map<string, object[]>} folder below the project ('' is the project) → its entries; an entry that was
 *   listed carries `hit: true`, a folder that is only on the way to one does not
 */
export function buildPathTree(entries) {
  const folders = new Map();
  const at = (dir) => { if (!folders.has(dir)) folders.set(dir, new Map()); return folders.get(dir); };
  at('');
  for (const entry of entries) {
    const parts = String(entry.path || '').split('/').filter(Boolean);
    if (!parts.length) continue;
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const inside = at(dir);
      if (!inside.has(parts[i])) inside.set(parts[i], { name: parts[i], type: 'dir' });
      else if (inside.get(parts[i]).type !== 'dir') inside.set(parts[i], { ...inside.get(parts[i]), type: 'dir' });
      dir = dir ? `${dir}/${parts[i]}` : parts[i];
      at(dir);
    }
    const name = parts[parts.length - 1];
    const { path, ...rest } = entry;
    at(dir).set(name, { ...(at(dir).get(name) || {}), ...rest, name, hit: true });
  }
  return new Map([...folders].map(([dir, inside]) => [dir, [...inside.values()]]));
}

/** Where the first word of what was typed is in a name, as `[start, end]`, or null. */
export function matchRange(name, query) {
  const word = String(query || '').trim().toLowerCase().split(/\s+/)[0] || '';
  const plain = word.includes('/') ? word.slice(word.lastIndexOf('/') + 1) : word;
  if (!plain) return null;
  const at = String(name).toLowerCase().indexOf(plain);
  return at < 0 ? null : [at, at + plain.length];
}

/** Whether a name holds every word of what was typed (the same rule the server's search uses for names). */
export function nameMatches(name, query) {
  const hay = String(name).toLowerCase();
  return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}

// ── Selection and the keyboard ──

/** The rows from one to another in the order they are shown, both included. */
export function rangeBetween(order, from, to) {
  const a = order.indexOf(from); const b = order.indexOf(to);
  if (a < 0 || b < 0) return to ? [to] : [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * The selection after a row was picked.
 * @param {{ selected: Iterable<string>, anchor: string | null }} state
 * @param {string} path the row
 * @param {{ toggle?: boolean, range?: boolean }} how `toggle`: Ctrl / Cmd; `range`: Shift
 * @param {string[]} order the rows as they are shown
 * @returns {{ selected: Set<string>, anchor: string | null, focus: string }}
 */
export function pickRow(state, path, { toggle = false, range = false } = {}, order = []) {
  if (range && state.anchor && order.includes(state.anchor)) {
    return { selected: new Set(rangeBetween(order, state.anchor, path)), anchor: state.anchor, focus: path };
  }
  if (toggle) {
    const selected = new Set(state.selected);
    if (selected.has(path)) selected.delete(path); else selected.add(path);
    return { selected, anchor: path, focus: path };
  }
  return { selected: new Set([path]), anchor: path, focus: path };
}

/** The row a movement key lands on. */
export function moveTarget(order, current, move, { page = 10 } = {}) {
  if (!order.length) return null;
  const at = order.indexOf(current);
  if (at < 0) return move === 'end' || move === 'up' || move === 'pageUp' ? order[order.length - 1] : order[0];
  switch (move) {
    case 'down': return order[Math.min(order.length - 1, at + 1)];
    case 'up': return order[Math.max(0, at - 1)];
    case 'home': return order[0];
    case 'end': return order[order.length - 1];
    case 'pageDown': return order[Math.min(order.length - 1, at + page)];
    case 'pageUp': return order[Math.max(0, at - page)];
    default: return current;
  }
}

/**
 * The row typing goes to: the next one whose name begins with what was typed (one letter typed again moves on to
 * the next such row).
 * @param {string[]} order @param {(path: string) => string} nameOf @param {string | null} current @param {string} typed
 */
export function typeAheadTarget(order, nameOf, current, typed) {
  const want = String(typed || '').toLowerCase();
  if (!want || !order.length) return null;
  const repeated = want.length > 1 && [...want].every((letter) => letter === want[0]);
  const prefix = repeated ? want[0] : want;
  const from = order.indexOf(current);
  // More letters narrow down from the row the keyboard is on; one letter (or the same again) starts after it.
  const start = prefix.length > 1 ? Math.max(0, from) : from + 1;
  for (let i = 0; i < order.length; i++) {
    const path = order[(start + i + order.length) % order.length];
    if (nameOf(path).toLowerCase().startsWith(prefix)) return path;
  }
  return null;
}

/**
 * What a key means in the tree.
 * @param {{ key: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean }} event
 * @param {{ mac?: boolean }} [o]
 * @returns {{ action: string, extend?: boolean, keep?: boolean } | { type: string } | null} `extend`: Shift widens the
 *   selection; `keep`: Ctrl / Cmd moves the keyboard without selecting; `type`: a letter for type-ahead
 */
export function keyAction(event, { mac = false } = {}) {
  const mod = mac ? !!event.metaKey : !!event.ctrlKey;
  const otherMod = mac ? !!event.ctrlKey : !!event.metaKey;
  const { key } = event;
  const moves = { ArrowDown: 'down', ArrowUp: 'up', Home: 'home', End: 'end', PageDown: 'pageDown', PageUp: 'pageUp' };
  if (moves[key] && !event.altKey) return { action: moves[key], extend: !!event.shiftKey, keep: mod };
  if (event.altKey && mod && (event.code === 'KeyC' || key === 'c' || key === 'C' || key === 'ç')) return { action: event.shiftKey ? 'copyRelativePath' : 'copyPath' };
  // Ctrl+Space on every system (Cmd+Space is the system's own on a Mac).
  if (event.ctrlKey && !event.altKey && !event.metaKey && key === ' ') return { action: 'toggle' };
  if (event.altKey || otherMod) return null;
  if (mod) {
    if (mac && key === 'Backspace') return { action: 'delete' };
    switch (key.toLowerCase()) {
      case 'c': return { action: 'copy' };
      case 'x': return { action: 'cut' };
      case 'v': return { action: 'paste' };
      case 'a': return { action: 'selectAll' };
      case 'p': return event.shiftKey ? null : { action: 'jump' };
      default: return null;
    }
  }
  switch (key) {
    case 'ArrowRight': return { action: 'right' };
    case 'ArrowLeft': return { action: 'left' };
    case 'Enter': return { action: 'open' };
    case ' ': return { action: 'peek' };
    case 'F2': return { action: 'rename' };
    case 'Delete': return { action: 'delete' };
    case 'ContextMenu': return { action: 'menu' };
    case 'F10': return event.shiftKey ? { action: 'menu' } : null;
    case 'Escape': return { action: 'escape' };
    default:
  }
  // A letter, a digit or a sign: the name that is being typed.
  if (key.length === 1 && key !== ' ') return { type: key };
  return null;
}

/** Whether rows may be dropped into a folder: never into themselves or below themselves; a move, not where they already are. */
export function canDropInto(sources, target, { copy = false } = {}) {
  const into = trimSlash(target);
  const list = topLevelOf(sources);
  if (!list.length) return false;
  if (list.some((path) => isWithin(path, into))) return false;
  return copy || list.some((path) => dirName(path) !== into);
}

// ── What a file is ──

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const BINARY_KINDS = {
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'jar', 'war'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'epub'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'opus'],
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv'],
  font: ['woff', 'woff2', 'ttf', 'otf', 'eot'],
  database: ['db', 'sqlite', 'sqlite3', 'db-wal', 'db-shm', 'mdb'],
  program: ['exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'wasm', 'node', 'pyc', 'app'],
  diskImage: ['dmg', 'iso', 'pkg', 'deb', 'rpm', 'msi', 'apk', 'ipa'],
  design: ['psd', 'ai', 'sketch', 'fig', 'xd', 'heic', 'tif', 'tiff', 'raw'],
};
const BINARY_BY_EXT = new Map(Object.entries(BINARY_KINDS).flatMap(([kind, list]) => list.map((ext) => [ext, kind])));

/**
 * What a file is, by its name: text the editor opens, an image the explorer previews, or something else it names.
 * @returns {{ kind: 'text' | 'image' | 'binary', type?: string, alsoText?: boolean }} `type`: which kind of
 *   binary (the key of its name: fileExplorer.kind.*); `alsoText`: an image that is text too (SVG)
 */
export function fileKind(name) {
  const lower = String(name || '').toLowerCase();
  if (lower === '.ds_store' || lower === 'thumbs.db') return { kind: 'binary', type: 'system' };
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (IMAGE_EXT.has(ext)) return { kind: 'image', ...(ext === 'svg' ? { alsoText: true } : {}) };
  if (BINARY_BY_EXT.has(ext)) return { kind: 'binary', type: BINARY_BY_EXT.get(ext) };
  return { kind: 'text' };
}

/** A size in the unit that reads best. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// ── Failures, in words ──

const NAME_REASONS = new Set(['empty', 'dots', 'separator', 'control', 'reserved', 'chars', 'trailing', 'long']);
const FAILURE_KEYS = {
  exists: 'exists', gone: 'gone', denied: 'denied', root: 'root', 'into-self': 'intoSelf', 'too-large': 'tooLarge', busy: 'busy',
  'no-space': 'noSpace', outside: 'outside', 'not-dir': 'notDir', offline: 'offline', 'no-reveal': 'noReveal', 'no-trash': 'noTrash',
  changed: 'changed', 'other-disk': 'otherDisk',
  unsupported: 'needsRestart', GUEST_FORBIDDEN: 'owner', BAD_HOST: 'owner', BAD_ORIGIN: 'owner', limit: 'limit', 'not-image': 'notImage',
};

/**
 * The sentence for a failure, as an i18n key and its parameters.
 * @param {{ code?: string, reason?: string, name?: string, conflicts?: string[] }} failure what a route answered
 *   (`code` 'offline' when it did not answer at all)
 */
export function failureMessage(failure = {}) {
  const name = failure.name || failure.conflicts?.[0] || '';
  if (failure.code === 'invalid-name') {
    return { key: `fileExplorer.error.name.${NAME_REASONS.has(failure.reason) ? failure.reason : 'other'}`, params: { name } };
  }
  return { key: `fileExplorer.error.${FAILURE_KEYS[failure.code] || 'failed'}`, params: { name } };
}

const STOPPED_KEYS = { move: 'fileExplorer.move.stopped', copy: 'fileExplorer.copy.stopped', delete: 'fileExplorer.delete.stopped' };

/**
 * What to say of a move, a copy or a delete that did not go through: how far it got, the entry it stopped at, and
 * why. When nothing was done before it stopped, the reason alone.
 * @param {'move' | 'copy' | 'delete' | 'trash'} what `trash`: a delete to the Trash
 * @param {{ done?: number, total?: number, failure?: object, trash?: 'win32' | 'other' }} o `done` of `total` went
 *   through; `failure` is what the route answered (`failed`: the path it stopped at; `partial`: a copy that was
 *   begun under that path and is not whole)
 * @returns {{ key: string, params: object, why: { key: string, params: object } | null, partial: { key: string, params: object } | null }}
 *   `why`, once worded, is the `{why}` of the sentence; null when the sentence is the reason itself. `partial` is
 *   a sentence of its own, said after it: what the copy stopped at is at the destination in part
 */
export function stoppedMessage(what, { done = 0, total = 0, failure = {}, trash = 'other' } = {}) {
  const name = failure.name || (failure.failed ? baseName(failure.failed) : '') || failure.conflicts?.[0] || '';
  const why = failureMessage({ ...failure, name });
  const partial = typeof failure.partial === 'string' && failure.partial ? { key: 'fileExplorer.copy.partial', params: { name: baseName(failure.partial) } } : null;
  if (!(done > 0)) return { ...why, why: null, partial };
  const key = what === 'trash' ? `fileExplorer.delete.stoppedTrash.${trash === 'win32' ? 'win32' : 'other'}` : STOPPED_KEYS[what] || STOPPED_KEYS.move;
  return { key, params: { done, total, name }, why, partial };
}

// ── The menu ──

/**
 * What the context menu holds, in groups.
 * @param {object} c
 * @param {'file' | 'dir' | 'multi' | 'empty'} c.target what was right-clicked: one file, one folder, several rows, or
 *   the space below the rows (the project itself)
 * @param {number} [c.count] how many rows
 * @param {{ ops?: boolean, reveal?: boolean }} [c.caps] what the server can do; the rest is listed and says why not
 * @param {boolean} [c.expanded] a folder that is open
 * @param {boolean} [c.canPaste] something was cut or copied
 * @param {'text' | 'image' | 'binary'} [c.kind] of a file
 * @param {boolean} [c.missing] a file git lists as deleted: it is not on disk
 * @param {boolean} [c.changedOnly] @param {string} [c.sort] the view's state, for the menu of the empty space
 * @returns {({ separator: true } | { id: string, key?: string, danger?: boolean, disabled?: boolean, checked?: boolean, more?: boolean })[]}
 *   `key`: its shortcut in the editor's notation (`Mod-c`); `more`: it opens a second page of the menu
 */
export function menuModel({ target, count = 1, caps = {}, expanded = false, canPaste = false, kind = 'text', missing = false, changedOnly = false, sort = 'name' }) {
  const ops = !!caps.ops;
  const needs = (item) => (ops ? item : { ...item, disabled: true, why: 'restart' });
  const sep = { separator: true };
  const send = [{ id: 'send' }, { id: 'sendTo', more: true }];
  const paths = [{ id: 'copyPath', key: 'Mod-Alt-c' }, { id: 'copyRelativePath', key: 'Mod-Shift-Alt-c' }];
  const reveal = caps.reveal ? { id: 'reveal' } : { id: 'reveal', disabled: true, why: ops ? 'noReveal' : 'restart' };
  if (target === 'empty') {
    return [
      { id: 'newFile' }, { id: 'newFolder' }, sep,
      needs({ id: 'paste', key: 'Mod-v', ...(canPaste ? {} : { disabled: true, why: 'nothingCopied' }) }), sep,
      ...paths.slice(0, 1), reveal, sep,
      { id: 'changedOnly', checked: changedOnly }, { id: 'sortBy', more: true, value: sort }, sep,
      { id: 'expandAll' }, { id: 'collapseAll' }, { id: 'refresh' },
    ];
  }
  if (missing) return [...paths, { id: 'copyName' }];
  if (target === 'multi') {
    return [
      ...send, sep,
      needs({ id: 'cut', key: 'Mod-x' }), needs({ id: 'copy', key: 'Mod-c' }), sep,
      ...paths, sep,
      { id: 'delete', key: 'Delete', danger: true, count },
    ];
  }
  const edit = [needs({ id: 'cut', key: 'Mod-x' }), needs({ id: 'copy', key: 'Mod-c' })];
  const tail = [needs({ id: 'rename', key: 'F2' }), { id: 'delete', key: 'Delete', danger: true }, sep, reveal];
  if (target === 'dir') {
    return [
      { id: 'newFile' }, { id: 'newFolder' }, sep,
      expanded ? { id: 'collapse', key: 'ArrowLeft' } : { id: 'expand', key: 'ArrowRight' },
      ...(expanded ? [{ id: 'collapseChildren' }] : []), sep,
      ...send, sep,
      ...edit, needs({ id: 'paste', key: 'Mod-v', ...(canPaste ? {} : { disabled: true, why: 'nothingCopied' }) }), needs({ id: 'duplicate' }), sep,
      ...paths, { id: 'copyName' }, sep,
      { id: 'color', more: true }, sep,
      ...tail,
    ];
  }
  return [
    // Each entry beside its own key: Space looks at a file in the reused tab, Enter keeps the tab.
    kind === 'text' ? { id: 'open', key: 'Space' } : { id: 'preview', key: 'Enter' },
    ...(kind === 'text' ? [{ id: 'openKeep', key: 'Enter' }] : kind === 'image' ? [{ id: 'openAsText' }] : []), sep,
    ...send, sep,
    ...edit, needs({ id: 'duplicate' }), sep,
    ...paths, { id: 'copyName' }, sep,
    ...tail,
  ];
}

/** The items of a menu the keyboard can stop on, in order. */
export const menuStops = (items) => items.filter((item) => !item.separator && !item.disabled);

// ── What is kept of the tree, per project ──

export const TREE_STATE_VERSION = 1;
export const MAX_KEPT_PROJECTS = 30;
export const MAX_KEPT_EXPANDED = 400;
export const MAX_KEPT_SELECTED = 50;

const strings = (list, max) => (Array.isArray(list) ? list.filter((entry) => typeof entry === 'string' && entry).slice(0, max) : []);

/**
 * What was kept for a project, cleaned up: its open folders, its selection, the row the keyboard was on, how far
 * it was scrolled and whether it showed only what changed.
 * @param {any} stored the stored value (parsed JSON, or anything)
 * @param {string} project the project's folder
 */
export function recallTreeState(stored, project) {
  const kept = stored && stored.v === TREE_STATE_VERSION && stored.projects && typeof stored.projects === 'object' ? stored.projects[trimSlash(project)] : null;
  return {
    expanded: strings(kept?.expanded, MAX_KEPT_EXPANDED),
    selected: strings(kept?.selected, MAX_KEPT_SELECTED),
    focus: typeof kept?.focus === 'string' ? kept.focus : null,
    top: Number.isFinite(kept?.top) && kept.top > 0 ? Math.round(kept.top) : 0,
    changedOnly: kept?.changedOnly === true,
  };
}

/** The stored value with one project's state written into it; the projects not used for longest go first. */
export function rememberTreeState(stored, project, state, now = Date.now()) {
  const projects = stored && stored.v === TREE_STATE_VERSION && stored.projects && typeof stored.projects === 'object' ? { ...stored.projects } : {};
  projects[trimSlash(project)] = {
    at: now,
    expanded: strings([...(state.expanded || [])], MAX_KEPT_EXPANDED),
    selected: strings([...(state.selected || [])], MAX_KEPT_SELECTED),
    focus: typeof state.focus === 'string' ? state.focus : null,
    top: Number.isFinite(state.top) && state.top > 0 ? Math.round(state.top) : 0,
    changedOnly: state.changedOnly === true,
  };
  const names = Object.keys(projects).sort((a, b) => (projects[b].at || 0) - (projects[a].at || 0)).slice(0, MAX_KEPT_PROJECTS);
  return { v: TREE_STATE_VERSION, projects: Object.fromEntries(names.map((name) => [name, projects[name]])) };
}

// ── A server from before these routes ──

/** A folder as GET /api/project-files lists it, in the shape of GET /api/explorer/list, plus what it said of git. */
export function fromLegacyListing(data) {
  const items = (data?.items || []).map((item) => ({ name: item.name, type: item.type === 'dir' ? 'dir' : 'file', ...(item.size !== undefined ? { size: item.size } : {}), ...(item.mtime !== undefined ? { mtime: item.mtime } : {}) }));
  const git = {};
  for (const item of data?.items || []) if (item.git && GIT_MARKS[item.git]) git[item.name] = item.git;
  return { ok: true, path: trimSlash(data?.path || ''), items, total: data?.total ?? items.length, truncated: !!data?.truncated, branch: data?.branch || null, git };
}

/** A search as GET /api/project-files answers it, in the shape of GET /api/explorer/search. */
export function fromLegacySearch(data) {
  const items = (data?.items || []).filter((item) => item.relativePath).map((item) => ({ path: slashes(item.relativePath), type: item.type === 'dir' ? 'dir' : 'file' }));
  return { ok: true, items, truncated: items.length >= 100, partial: false };
}
