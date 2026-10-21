// ═══════════════════════════════════════════
// SynaBun Neural Interface — launch cache
// ═══════════════════════════════════════════
// The last good answer of a slow lookup (a model list, a provider catalog, a
// CLI probe), given at once and asked for again in the background once it is
// old: stale-while-revalidate. One refresh at a time per entry, shared by every
// caller. A caller waits only when nothing was ever kept for its key, or when it
// asks for a fresh answer (`refresh`).
//
// Keys say what an answer depends on (an account, a provider, a binary and its
// version, a serve's credentials file): an answer is never given for another
// key. `markStale()` keeps an answer but has the next read refresh it (a serve
// restarted, a CLI may have been updated); `invalidate()` drops it, so the next
// read waits (the user changed what it answers).
//
// Never kept (`accept`): an error, a timeout, an empty answer a failure caused,
// a body that is not JSON. What is kept survives a restart in
// DATA_HOME/cache/launch/<name>.json: outside data/ (no backup carries a cache)
// and outside the package (an update replaces that). An answer read back from
// the file is served at once and asked for again on its first read.

import { mkdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE_VERSION = 1;
const SAVE_DELAY_MS = 400;

/** The folder the caches of a data home live in. */
export function launchCacheDir(dataHome) {
  return join(String(dataHome || '.'), 'cache', 'launch');
}

/**
 * At most `limit` jobs at once, the rest in order behind them: what keeps a
 * warm-up or a burst of probes from starting every process together.
 */
export function createLimiter(limit = 1) {
  let running = 0;
  const waiting = [];
  const pump = () => {
    while (running < limit && waiting.length) {
      const { job, resolve, reject } = waiting.shift();
      running += 1;
      Promise.resolve().then(job).then(resolve, reject).finally(() => { running -= 1; pump(); });
    }
  };
  const run = (job) => new Promise((resolve, reject) => { waiting.push({ job, resolve, reject }); pump(); });
  run.pending = () => waiting.length + running;
  return run;
}

/**
 * @param {object} o
 * @param {string} o.name                  file name (and log tag) of this cache
 * @param {(key:string)=>Promise<any>} o.load  the slow lookup; throw (or return what `accept` refuses) on failure
 * @param {number} o.ttlMs                 how long an answer is fresh
 * @param {string|null} [o.dir]            where it is kept across restarts (null: memory only)
 * @param {(value:any, key:string)=>boolean} [o.accept]  is this answer worth keeping
 * @param {(a:any, b:any)=>boolean} [o.equals]  same answer (no save, no change event)
 * @param {(value:any)=>any} [o.persistValue]  what is written for a value (default: the value)
 * @param {(key:string, value:any, previous:any)=>void} [o.onChange]  a refresh gave another answer
 * @param {number} [o.maxEntries]          keys kept (the oldest goes first)
 */
export function createLaunchCache({
  name,
  load,
  ttlMs,
  dir = null,
  accept = (value) => value !== undefined && value !== null,
  equals = (a, b) => {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  },
  persistValue = (value) => value,
  onChange = null,
  maxEntries = 16,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (typeof load !== 'function') throw new Error('createLaunchCache needs load');
  const entries = new Map();     // key → { value, at, stale }
  const inflight = new Map();    // key → promise of the load
  const generations = new Map(); // key → bumped by invalidate(): a load begun before it is not kept
  const file = dir ? join(dir, `${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.json`) : null;
  let loadedFile = !file;
  let saveTimer = null;
  let saving = null;

  function readFile() {
    if (loadedFile) return;
    loadedFile = true;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed?.version !== FILE_VERSION || !Array.isArray(parsed.entries)) return;
      for (const row of parsed.entries.slice(-maxEntries)) {
        if (typeof row?.key !== 'string' || row.value === undefined) continue;
        if (!safeAccept(row.value, row.key)) continue;
        // From the last run: served at once, asked for again on its first read.
        if (!entries.has(row.key)) entries.set(row.key, { value: row.value, at: Number(row.at) || 0, stale: true, restored: true });
      }
    } catch { /* no file yet, or one that cannot be read: an empty cache */ }
  }

  function safeAccept(value, key) {
    try { return accept(value, key) === true; } catch { return false; }
  }

  function fresh(entry) {
    return !!entry && !entry.stale && now() - entry.at < ttlMs;
  }

  function trim() {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function scheduleSave() {
    if (!file) return;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saving = (saving || Promise.resolve()).then(saveNow).catch(() => {});
    }, SAVE_DELAY_MS);
    saveTimer.unref?.();
  }

  async function saveNow() {
    const rows = [];
    for (const [key, entry] of entries) {
      let value;
      try { value = persistValue(entry.value); } catch { continue; }
      if (value === undefined) continue;
      rows.push({ key, at: entry.at, value });
    }
    const body = JSON.stringify({ version: FILE_VERSION, name, savedAt: new Date(now()).toISOString(), entries: rows });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, file);
    } catch (error) {
      log(`[launch-cache] ${name}: could not be saved (${error?.code || error?.message || error})`);
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  function store(key, value) {
    const previous = entries.get(key);
    const same = !!previous && equals(previous.value, value);
    entries.delete(key);
    entries.set(key, { value: same ? previous.value : value, at: now(), stale: false });
    trim();
    if (!same || previous?.restored) scheduleSave();
    if (!same && previous && typeof onChange === 'function') {
      try { onChange(key, value, previous.value); } catch { /* a listener's failure is its own */ }
    }
    return same ? previous.value : value;
  }

  /** One load for `key` at a time; what it gives is kept when it is worth keeping. */
  function revalidate(key) {
    if (inflight.has(key)) return inflight.get(key);
    const generation = generations.get(key) || 0;
    const job = (async () => {
      try {
        const value = await load(key);
        if (safeAccept(value, key) && (generations.get(key) || 0) === generation) return { value: store(key, value), kept: true };
        return { value, kept: false };
      } finally {
        if (inflight.get(key) === job) inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  /**
   * The answer for `key` and how it was obtained: `{ value, cached, stale, at }`.
   * `refresh`: wait for a new answer (one shared load); without it a kept answer
   * is given at once (and refreshed in the background when it is old).
   */
  async function read(key = '', { refresh = false } = {}) {
    readFile();
    const id = String(key);
    const entry = entries.get(id);
    if (!refresh && entry) {
      const stale = !fresh(entry);
      if (stale) revalidate(id).catch((error) => log(`[launch-cache] ${name}: background refresh failed (${error?.message || error})`));
      return { value: entry.value, cached: true, stale, at: entry.at };
    }
    const result = await revalidate(id);
    return { value: result.value, cached: false, stale: false, at: result.kept ? (entries.get(id)?.at || now()) : 0, kept: result.kept };
  }

  return {
    name,
    read,
    async get(key = '', options = {}) { return (await read(key, options)).value; },
    /** The kept answer for `key`, or undefined: never waits, never loads. */
    peek(key = '') { readFile(); return entries.get(String(key))?.value; },
    /** How old the kept answer is, and whether it is due for a refresh (undefined: none kept). */
    info(key = '') {
      readFile();
      const entry = entries.get(String(key));
      return entry ? { at: entry.at, stale: !fresh(entry), restored: !!entry.restored } : undefined;
    },
    /** Keep an answer obtained elsewhere (a route that already has it). */
    set(key, value) { readFile(); if (safeAccept(value, String(key))) store(String(key), value); },
    /** Ask for `key` again in the background (or every key): the kept answer is still given meanwhile. */
    markStale(key = null) {
      readFile();
      if (key === null) { for (const entry of entries.values()) entry.stale = true; return; }
      const entry = entries.get(String(key));
      if (entry) entry.stale = true;
    },
    /** Drop `key` (or every key): the next read waits for a new answer, and a load already running is not kept. */
    invalidate(key = null) {
      readFile();
      const ids = key === null ? [...new Set([...entries.keys(), ...inflight.keys()])] : [String(key)];
      for (const id of ids) {
        entries.delete(id);
        generations.set(id, (generations.get(id) || 0) + 1);
        // A load begun before this is not joined by later reads: its answer is from before the change.
        inflight.delete(id);
      }
      scheduleSave();
    },
    /** Start a refresh of `key` now (warm-up, an event): resolves to its answer, never rejects. */
    refresh(key = '') {
      readFile();
      return revalidate(String(key)).then((result) => result.value, () => undefined);
    },
    keys() { readFile(); return [...entries.keys()]; },
    /** Write what is pending now (shutdown). */
    async flush() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await saveNow(); }
      await saving?.catch?.(() => {});
    },
  };
}

/** Make the cache folder now (a first start), so the first save has nothing to create. */
export function ensureLaunchCacheDir(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch { /* the save creates it, or says why it cannot */ }
}

/**
 * One value kept across restarts for a module that keeps its own cache (the
 * Claude model list): `read()` gives what the last run saved (once, from the
 * file), `write(value)` saves it a moment later, off the request.
 */
export function createSnapshotStore({ dir, name, log = () => {} } = {}) {
  const file = dir ? join(dir, `${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.json`) : null;
  let cached;
  let read = false;
  let timer = null;
  let pending;
  let chain = Promise.resolve();
  const save = async (value) => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, JSON.stringify({ version: FILE_VERSION, name, value }), 'utf8');
      await rename(tmp, file);
    } catch (error) {
      log(`[launch-cache] ${name}: could not be saved (${error?.code || error?.message || error})`);
      await rm(tmp, { force: true }).catch(() => {});
    }
  };
  return {
    read() {
      if (read || !file) return cached;
      read = true;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed?.version === FILE_VERSION) cached = parsed.value;
      } catch { /* nothing saved yet */ }
      return cached;
    },
    write(value) {
      cached = value;
      read = true;
      if (!file) return;
      pending = value;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const next = pending;
        chain = chain.then(() => save(next)).catch(() => {});
      }, SAVE_DELAY_MS);
      timer.unref?.();
    },
  };
}
