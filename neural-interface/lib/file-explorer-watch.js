// ── The File Explorer's watcher ──
// Tells the page which of the folders it shows changed on disk, and when the
// git state of the project may have, without the page asking again and again.
// It costs nothing while nothing changes: the operating system reports changes,
// nothing is polled.
//
// Two ways to watch, by what the system offers:
//   recursive  one watcher on the project's folder (macOS and Windows have it
//              natively). Every change below the folder arrives; the ones the
//              page did not ask about are dropped here.
//   folders    one watcher per folder the page shows (Linux, where a recursive
//              watch is a watch per sub-folder), plus one on .git.
// Changes are collected for a moment and sent together. Dependencies are
// injected: the tests drive it with real folders and with a fake `watch`.
//
// A watcher that exists is not a watch that works: the system may have no
// watches left (ENOSPC on Linux), or lose one it had. `state()` says what is
// really watched, and `onState` when that changes, so the page can read again
// by itself where nothing will tell it.
//
// A watch that failed is not asked for again at once. A watch that is lost
// each time it is opened would otherwise be opened, lost and opened again as
// fast as the page and the system can answer one another. It is tried again
// after a wait that doubles (a second, two, four, ... a minute at most) and
// starts over once a watch has held for a minute; until then it stays a watch
// that is not there, whatever folders the page shows meanwhile.

import { existsSync, watch as fsWatch } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export const MAX_WATCHED_DIRS = 600;
/** A watch that failed is tried again after this long, then after twice that, and so on. */
export const RETRY_FIRST_MS = 1000;
/** ... and never less often than this. */
export const RETRY_MAX_MS = 60000;
/** A watch that held this long was no part of a run of failures: the next wait is the first one again. */
export const RETRY_QUIET_MS = 60000;
/** The files of .git whose change means "commit, stage, checkout or merge": the git state is read again. */
const GIT_STATE_FILES = /^(index|HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|packed-refs)$/;
/** A folder that is not there (any more) is no watch that failed: its next listing says what is true. */
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);

/** Which way this system is watched. */
export function watchStrategy(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32' ? 'recursive' : 'folders';
}

/**
 * @param {object} o
 * @param {string} o.root the project's folder, canonical
 * @param {'recursive' | 'folders'} [o.strategy]
 * @param {(change: { dirs: string[], git: boolean }) => void} o.onChange `dirs`: watched folders (canonical) whose
 *   entries changed; `git`: the git state may have changed
 * @param {(error: Error) => void} [o.onError] the watch on the project's folder was lost
 * @param {(state: { scope: 'tree' | 'folders', live: 'full' | 'partial' | 'none' }) => void} [o.onState] what is
 *   really watched changed (see `state()`); not called for the state it starts in
 * @param {(relativePath: string) => boolean} [o.ignoresGit] a path git ignores: a change there is no change of state
 * @param {typeof fsWatch} [o.watch] @param {(path: string) => boolean} [o.exists]
 * @param {number} [o.debounceMs] @param {number} [o.maxWaitMs]
 * @param {() => number} [o.now] @param {(fn: () => void, ms: number) => any} [o.setTimer] @param {(timer: any) => void} [o.clearTimer]
 *   the clock of the waits between two attempts at a watch that failed (a test moves it by hand)
 * @returns {{ setDirs: (dirs: string[]) => void, close: () => void, count: () => number, strategy: string,
 *   state: () => { scope: 'tree' | 'folders', live: 'full' | 'partial' | 'none' } }}
 */
export function createTreeWatcher({
  root, strategy = watchStrategy(), onChange, onError = () => {}, onState = () => {}, ignoresGit = () => false,
  watch = fsWatch, exists = existsSync, debounceMs = 120, maxWaitMs = 500,
  now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (timer) => clearTimeout(timer),
}) {
  let closed = false;
  let wanted = new Set([root]);        // the folders the page shows
  let capped = false;                  // the page shows more folders than are watched
  const watchers = new Map();          // what is watched → FSWatcher
  const failed = new Set();            // what should be watched and is not (no watches left, a watch that was lost)
  const openedAt = new Map();          // what is watched → when that watch was opened
  let retryMs = 0;                     // the wait that is running, or ran last
  let retryAt = 0;                     // nothing that failed is asked for again before this
  let retryTimer = null;
  let refused = false;                 // the system refused a watch in the pass that is under way
  let said = null;                     // the `live` that was last reported
  const pending = new Set();
  let pendingGit = false;
  let timer = null;
  let firstAt = 0;

  const slashed = (path) => (sep === '/' ? path : path.split(sep).join('/'));

  function flush() {
    timer = null;
    if (closed || (!pending.size && !pendingGit)) return;
    const change = { dirs: [...pending], git: pendingGit };
    pending.clear();
    pendingGit = false;
    try { onChange(change); } catch { /* a listener's failure is not the watcher's */ }
  }

  // Sent a moment after the last change, and never later than `maxWaitMs` after the first of a burst.
  function schedule() {
    const now = Date.now();
    if (!timer) firstAt = now;
    else clearTimeout(timer);
    const wait = Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now));
    timer = setTimeout(flush, wait);
    timer.unref?.();
  }

  // One change, by its path below the root ('' is the root itself).
  function note(rel) {
    if (closed) return;
    const path = slashed(rel || '');
    if (path === '.git' || path.startsWith('.git/')) {
      const inside = path.slice(5);
      if (GIT_STATE_FILES.test(inside) || inside.startsWith('refs/')) pendingGit = true;
    } else if (!path || !ignoresGit(path)) {
      pendingGit = true;
    }
    const parent = path.includes('/') ? join(root, dirname(path)) : root;
    if (wanted.has(parent)) pending.add(parent);
    // A watched folder that was itself removed or renamed: whoever shows it reads it again and finds out.
    const self = path ? join(root, path) : root;
    if (self !== parent && wanted.has(self)) pending.add(self);
    if (pending.size || pendingGit) schedule();
  }

  /**
   * What is really watched. `scope`: every change below the project (`tree`), or only changes in the folders the
   * page shows and in git's own files (`folders`: a change inside a closed folder is not seen). `live`: `full`
   * when all of that is watched, `partial` when some of it could not be, `none` when the project's folder is not.
   */
  const state = () => ({
    scope: strategy === 'recursive' ? 'tree' : 'folders',
    live: failed.has(root) || !watchers.has(root) ? 'none' : failed.size || capped ? 'partial' : 'full',
  });
  function report() {
    if (closed) return;
    const is = state();
    if (is.live === said) return;
    said = is.live;
    try { onState(is); } catch { /* a listener's failure is not the watcher's */ }
  }

  // Something that should be watched is not: everything that failed is asked for again together, after a wait.
  // One wait covers whatever fails while it runs; the next one is twice as long, unless the watch that failed
  // had held for a while (`heldSince`): that was no part of a run of failures.
  function backOff(heldSince) {
    const at = now();
    if (retryTimer !== null && at < retryAt) return;
    if (heldSince !== undefined && at - heldSince >= RETRY_QUIET_MS) retryMs = 0;
    retryMs = retryMs ? Math.min(retryMs * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
    retryAt = at + retryMs;
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = setTimer(() => { retryTimer = null; if (closed) return; sync(); report(); }, retryMs);
    retryTimer?.unref?.();
  }

  function open(key, path, options, handler) {
    if (watchers.has(key) || closed) return;
    // Still in its wait: the folders the page shows do not ask the system again for a watch it just refused or lost.
    if (failed.has(key) && now() < retryAt) return;
    let watcher;
    try { watcher = watch(path, { persistent: false, ...options }, handler); }
    catch (error) {
      // A folder that is gone says so in its next listing. Anything else (no watches left) is a change nobody
      // will be told of: it is counted, and the page reads again by itself.
      if (key === root || !NOT_THERE.has(error?.code)) { failed.add(key); refused = true; }
      return;
    }
    failed.delete(key);
    openedAt.set(key, now());
    watcher.on?.('error', () => {
      try { watcher.close(); } catch { /* already closed */ }
      if (watchers.get(key) !== watcher) return;   // let go of since: not a watch that was lost
      watchers.delete(key);
      if (closed) return;
      // Tried again after its wait; until then it is a watch that is not there.
      if (key === root || exists(path)) { failed.add(key); backOff(openedAt.get(key)); }
      report();
      if (key === root) { try { onError(new Error('The watch on the project folder was lost.')); } catch { /* as above */ } } else note(relative(root, path));
    });
    watchers.set(key, watcher);
  }

  function sync() {
    if (closed) return;
    refused = false;
    try { place(); } finally { if (refused) backOff(); }
  }

  function place() {
    if (strategy === 'recursive') {
      open(root, root, { recursive: true }, (type, name) => note(name ? String(name) : ''));
      return;
    }
    for (const [key, watcher] of watchers) {
      if (key === '.git' || wanted.has(key)) continue;
      try { watcher.close(); } catch { /* already closed */ }
      watchers.delete(key);
      openedAt.delete(key);
    }
    for (const key of failed) if (key !== '.git' && !wanted.has(key)) failed.delete(key);
    for (const dir of wanted) {
      const rel = relative(root, dir);
      open(dir, dir, {}, (type, name) => note(name ? join(rel, String(name)) : rel));
    }
    open('.git', join(root, '.git'), {}, (type, name) => { if (name) note(join('.git', String(name))); });
  }

  sync();
  said = state().live;

  return {
    strategy,
    /** The folders the page shows now (canonical paths, the root or below it). */
    setDirs(dirs) {
      const next = new Set([root]);
      capped = false;
      for (const dir of dirs || []) {
        if (typeof dir !== 'string' || !(dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep)) || next.has(dir)) continue;
        if (next.size >= MAX_WATCHED_DIRS) { capped = strategy !== 'recursive'; break; }
        next.add(dir);
      }
      wanted = next;
      sync();
      report();
    },
    state,
    count: () => watchers.size,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      for (const watcher of watchers.values()) { try { watcher.close(); } catch { /* already closed */ } }
      watchers.clear();
      pending.clear();
    },
  };
}
