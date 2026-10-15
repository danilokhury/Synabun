// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: unsaved work
// ═══════════════════════════════════════════
//
// What keeps an edit from being lost: the browser's own question when the page
// is left with unsaved text, a copy of every unsaved buffer written a second
// after the last change (and removed when the buffer is saved or discarded),
// the check of open files against the disk, and what the bars about all that
// say. editor-panel.js owns the documents and draws the bars; everything here
// is handed what it works with (a store, a timer, a way to ask the server), so
// `node --test` loads it as it is. No imports.
//
// Where a copy is kept: the UI blob store's `editor-backups` namespace, which
// only the owner can read or write, on a server that has it (the `backups`
// capability). The namespaces of a server that was not restarted are fixed and
// the only free one is open to invited guests, so until then the copy stays in
// this browser (IndexedDB).

/** A buffer is copied this long after its last change. */
export const BACKUP_DELAY_MS = 1000;
/** Buffers longer than this are not copied (1 MB of text). */
export const BACKUP_MAX_CHARS = 1024 * 1024;
export const BACKUP_VERSION = 1;
export const BACKUP_NAMESPACE = 'editor-backups';
/** What the store keeps: the newest copies, up to this many and this much text. */
export const BACKUP_KEEP = Object.freeze({ maxEntries: 40, maxChars: 24 * 1024 * 1024 });
/** Open files are checked against the disk this often while the panel is visible. */
export const DISK_POLL_MS = 2000;
/** Paths per request (the server's limit). */
export const STAT_BATCH = 50;

function fnv1a(text, seed = 0x811c9dc5) {
  let hash = seed;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A short mark of a text: two texts with the same mark are taken to be the same text. */
export function textFingerprint(text) {
  const value = String(text ?? '');
  return `${value.length}:${fnv1a(value)}`;
}

/** The name a document's copy is stored under: safe in an address, the same for the same document. */
export function backupId(key) {
  const value = String(key ?? '');
  return `b${fnv1a(value)}${fnv1a(value, 0x9747b28c)}`;
}

/** Whether a stored value is a copy of this document. */
export function isBackup(record, key) {
  return !!record && typeof record === 'object' && record.v === BACKUP_VERSION && record.key === key && typeof record.text === 'string';
}

/**
 * What a copy found when a file is opened means.
 * @param {{ text: string, base?: string } | null} record the copy
 * @param {string} diskText the file as it was just read (line breaks as "\n")
 * @returns {'none' | 'same' | 'restore' | 'restore-changed'} `same`: the file already holds that text, the copy
 *   is of no use; `restore`: the unsaved text comes back; `restore-changed`: it comes back, and the file is no
 *   longer the one the text was written over
 */
export function describeBackup(record, diskText) {
  if (!record) return 'none';
  if (record.text === diskText) return 'same';
  return typeof record.base === 'string' && record.base !== textFingerprint(diskText) ? 'restore-changed' : 'restore';
}

/**
 * The copies of unsaved buffers.
 * @param {object} o
 * @param {{ get: (id: string) => Promise<any>, put: (id: string, value: object, o?: { keep?: boolean }) => any, remove: (id: string) => any, flush?: (o?: object) => any }} o.store
 *   `put` may answer a promise that says whether the copy has arrived (`false`: it has not); a store that answers
 *   nothing is taken at its word. `keep: false` marks a copy that only takes the place of one that goes (a file
 *   was renamed): the store evicts nothing for it.
 * @param {number} [o.delayMs]
 * @param {number} [o.maxChars]
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => any} [o.setTimer]
 * @param {(timer: any) => void} [o.clearTimer]
 */
export function createBackups({
  store, delayMs = BACKUP_DELAY_MS, maxChars = BACKUP_MAX_CHARS, now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (timer) => clearTimeout(timer),
}) {
  const waiting = new Map();   // key → { timer, read }: a copy is due
  const stored = new Set();    // keys that may have a copy in the store
  // The copies that are on their way from one key to another (a file was renamed while its unsaved text was only
  // in the store): { from, to, path, since, commit, fresh, reused }
  //   since   when the file was renamed: only a copy written before that is this document's
  //   commit  what is remembered of the document may follow it (called once, when its copy is under `to`)
  //   fresh   a newer copy is under `to` by now, or none is wanted there: the one on its way is not brought
  //   reused  this page wrote another document's copy under `from` since: nothing there is this document's
  const jobs = new Set();
  let queue = Promise.resolve();   // one after the other: the second of two renames finds what the first put

  const usable = (snapshot) => !!snapshot && typeof snapshot.text === 'string' && snapshot.text.length <= maxChars;
  const recordOf = (key, snapshot) => ({
    v: BACKUP_VERSION, key, path: String(snapshot.path ?? ''), text: snapshot.text,
    base: typeof snapshot.base === 'string' ? snapshot.base : null, eol: snapshot.eol === 'CRLF' ? 'CRLF' : 'LF', at: now(),
  });
  // The document at `key` has a newer copy there now, or wants none: a copy on its way to that key is not brought.
  const supersede = (key) => { for (const job of jobs) if (job.to === key) job.fresh = true; };
  const settle = (job) => {
    const { commit } = job;
    job.commit = null;
    if (commit) { try { commit(); } catch { /* the caller's own failure */ } }
  };

  function write(key) {
    const entry = waiting.get(key);
    if (!entry) return false;
    waiting.delete(key);
    clearTimer(entry.timer);
    let snapshot = null;
    try { snapshot = entry.read(); } catch { snapshot = null; }
    // A buffer that outgrew the limit is not copied; the copy made while it was smaller stays, as the last one there is.
    if (!usable(snapshot)) return false;
    supersede(key);   // what is written now is newer than a copy on its way here
    for (const job of jobs) if (job.from === key) job.reused = true;   // and what is under this key is this document's
    stored.add(key);
    store.put(backupId(key), recordOf(key, snapshot));
    return true;
  }

  // One renamed document's copy, brought from the key it was under to the key the document has now. In this
  // order, so that a page that goes at any moment finds the document and its copy under one name: the copy is put
  // under the new key (the store evicts nothing for it); when it has arrived, what is remembered of the document
  // follows (`commit`); then the copy under the old key goes. A copy that was written after the rename is another
  // file's, under a name that was free again: it is neither brought nor removed.
  async function carry(job) {
    let carried = false;
    try {
      let record = null;
      try { record = await store.get(backupId(job.from)); } catch { record = null; }
      const mine = !job.reused && isBackup(record, job.from) && (Number(record.at) || 0) <= job.since;
      if (mine && !job.fresh) {
        let arrived;
        try { arrived = await store.put(backupId(job.to), { ...record, key: job.to, path: String(job.path ?? record.path ?? '') }, { keep: false }); } catch { arrived = false; }
        if (arrived === false && !job.fresh) return false;   // it stays where it is, and so does what is remembered
        if (!job.fresh) { stored.add(job.to); carried = true; }
      }
      settle(job);
      if (mine && !job.reused) { stored.delete(job.from); try { store.remove(backupId(job.from)); } catch { /* the store's own failure */ } }
    } catch { carried = false; } finally { jobs.delete(job); }
    return carried;
  }

  // Where the copy of the document at `key` is by now: under its key, or under the key a move that is still
  // queued will bring it from (through every such move: of two renames in a row, under the first name).
  // `since`: only a copy written before that is the document's; `path`: where the document is.
  function whereabouts(key) {
    let at = key; let path = null; let since = Infinity;
    for (let hop = 0; hop <= jobs.size; hop++) {
      let job = null;
      for (const each of jobs) if (each.to === at && !each.fresh && !each.reused) job = each;
      if (!job) break;
      if (path === null) path = job.path;
      since = Math.min(since, job.since);
      at = job.from;
    }
    return { at, path, since };
  }

  return {
    /**
     * A buffer with unsaved text changed: copy it once it has been still for a second.
     * @param {string} key the document (its tab key)
     * @param {() => ({ path: string, text: string, base?: string, eol?: string } | null)} read the buffer when the
     *   copy is made; null when there is nothing to copy any more
     */
    touch(key, read) {
      const entry = waiting.get(key);
      if (entry) clearTimer(entry.timer);
      waiting.set(key, { read, timer: setTimer(() => write(key), delayMs) });
    },
    /**
     * The buffer was saved or discarded: no copy is due, and the one in the store goes.
     * @param {string} key
     * @param {{ always?: boolean }} [o] `always`: ask the store even when this page never saw a copy (a tab that
     *   came back with unsaved text and was closed before it was read)
     */
    drop(key, { always = false } = {}) {
      const entry = waiting.get(key);
      if (entry) { clearTimer(entry.timer); waiting.delete(key); }
      supersede(key);
      if (!stored.delete(key) && !always) return false;
      store.remove(backupId(key));
      return true;
    },
    /**
     * The document has another key now (its file was renamed or moved): its copy is kept under the new key, with
     * the new path, and nothing is left under the old one. A copy that is due is made under the new key.
     *
     * The text of an open document (`read`) is the newest there is: it is stored under the new key in this very
     * call, the copy under the old key goes, and `commit` is called before the call returns. A copy that is only
     * in the store (a kept tab that is not open) has to be read from there first: it is brought by a queue, one
     * move after the other, and `commit` is called when it is under the new key (see `carry`). Until then nothing
     * is added to the store and nothing is remembered anew, so a page that leaves in between has lost nothing: the
     * document is remembered where its copy still is. Of two quick renames the copy ends under the last name, and
     * nothing stays under the one in between.
     * @param {string} from @param {string} to the document's key before and now @param {string} path where it is now
     * @param {object} [o]
     * @param {() => ({ path: string, text: string, base?: string, eol?: string } | null)} [o.read] the buffer as it
     *   is now, when the document is open with unsaved text (null otherwise)
     * @param {boolean} [o.expected] the document is known to have unsaved text, so a copy is expected in the store
     * @param {number} [o.since] when the file was renamed (now, unless the caller had to wait before it could ask)
     * @param {() => void} [o.commit] what is remembered of the document may follow it to the new key. Called once:
     *   in the call when there is nothing to wait for, else when the copy has arrived under the new key (or there
     *   turned out to be none of this document's). Not called when the copy could not be put there.
     * @returns {Promise<boolean>} whether a stored copy was carried over
     */
    move(from, to, path, { read = null, expected = false, since = now(), commit = null } = {}) {
      const done = () => { if (commit) { try { commit(); } catch { /* the caller's own failure */ } } };
      if (from === to) { done(); return Promise.resolve(false); }
      const entry = waiting.get(from);
      if (entry) {
        clearTimer(entry.timer);
        waiting.delete(from);
        const there = waiting.get(to);
        if (there) clearTimer(there.timer);
        waiting.set(to, { read: entry.read, timer: setTimer(() => write(to), delayMs) });
      }
      const known = stored.delete(from);
      // A document that was on its way to this key gave it up: its tab was closed for the one that takes it.
      supersede(to);
      let snapshot = null;
      if (read) { try { snapshot = read(); } catch { snapshot = null; } }
      if (usable(snapshot)) {
        let put = true;
        try { store.put(backupId(to), recordOf(to, snapshot)); } catch { put = false; }
        if (put) {
          stored.add(to);
          supersede(from);   // a copy that was still on its way to the key that was left is older than this text
          if (known || expected) { try { store.remove(backupId(from)); } catch { /* the store's own failure */ } }
          done();
          return Promise.resolve(false);
        }
      }
      // What is remembered waits only for a copy that is expected; one this page knows nothing of is brought all the same.
      const job = { from, to, path, since, commit: known || expected ? commit : null, fresh: false, reused: false };
      if (!job.commit) done();
      jobs.add(job);
      const step = queue.then(() => carry(job));
      queue = step.then(() => {}, () => {});
      return step;
    },
    /**
     * Make every copy that is due now (the page is being hidden or left). A move that is still under way needs
     * nothing more: its copy and what is remembered of its document are together at every step.
     */
    flush({ leaving = false } = {}) {
      let wrote = 0;
      for (const key of [...waiting.keys()]) if (write(key)) wrote++;
      store.flush?.({ leaving });
      return wrote;
    },
    /**
     * The copy of a document, or null. Nothing is waited for here: opening a file must not hang on the queue (a
     * write of another file's copy that does not arrive would hold every file up). A copy that is still on its
     * way to this key is read from where it is by now, and handed over as this document's.
     */
    async read(key) {
      const tried = new Set();
      for (;;) {
        const { at, path, since } = whereabouts(key);
        if (tried.has(at)) return null;   // it is under none of the keys it could be under
        tried.add(at);
        let record = null;
        try { record = await store.get(backupId(at)); } catch { record = null; }
        if (at === key) {
          if (!isBackup(record, key)) return null;
          stored.add(key);
          return record;
        }
        if (isBackup(record, at) && (Number(record.at) || 0) <= since) return { ...record, key, path: String(path ?? record.path ?? '') };
        // Not there: it was carried on while this was asked for, or there is none. Look where it is now.
      }
    },
    /** Whether a copy of this document is due. */
    due: (key) => waiting.has(key),
    /** Whether the store may hold a copy of this document. */
    has: (key) => stored.has(key),
  };
}

/**
 * Copies in the UI blob store (public/shared/blob-store.js), in a namespace of their own.
 * @param {{ fetchBlob: Function, putBlob: Function, deleteBlob: Function, flushBlobs: Function, namespace?: string }} o
 */
export function blobBackupStore({ fetchBlob, putBlob, deleteBlob, flushBlobs, namespace = BACKUP_NAMESPACE }) {
  return {
    get: (id) => fetchBlob(namespace, id),
    // Answers what putBlob answers: whether the write has arrived. A copy that only takes another's place
    // (`keep: false`) names no limits, so the store evicts nothing for it.
    put: (id, value, { keep = true } = {}) => putBlob(namespace, id, value, keep ? { debounceMs: 0, ...BACKUP_KEEP } : { debounceMs: 0 }),
    // Tried once. A copy the server could not remove comes back when its file is opened again: as unsaved text
    // under the "restored" bar, which an undo takes out (a copy that equals the file is dropped unseen).
    remove: (id) => deleteBlob(namespace, id),
    flush: ({ leaving = false } = {}) => flushBlobs({ useBeacon: leaving }),
  };
}

/**
 * Copies kept in this browser, for a server whose blob store has no place for them yet.
 * @param {{ indexedDB?: IDBFactory, name?: string, maxEntries?: number }} [o]
 */
export function localBackupStore({ indexedDB = globalThis.indexedDB, name = 'synabun-editor', maxEntries = BACKUP_KEEP.maxEntries } = {}) {
  const TABLE = 'backups';
  let opening = null;
  const database = () => {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (!indexedDB) { reject(new Error('IndexedDB is not available')); return; }
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(TABLE)) request.result.createObjectStore(TABLE); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB is blocked'));
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  };
  const run = async (mode, work) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE, mode);
      const request = work(tx.objectStore(TABLE));
      tx.oncomplete = () => resolve(request?.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  // The oldest copies go once there are more than the store keeps.
  const prune = async () => {
    const keys = await run('readonly', (table) => table.getAllKeys());
    if (!keys || keys.length <= maxEntries) return;
    const values = await run('readonly', (table) => table.getAll());
    const oldest = keys.map((key, i) => ({ key, at: Number(values?.[i]?.at) || 0 })).sort((a, b) => b.at - a.at).slice(maxEntries);
    await run('readwrite', (table) => { for (const entry of oldest) table.delete(entry.key); return null; });
  };
  return {
    get: (id) => run('readonly', (table) => table.get(id)).catch(() => null),
    // Answers whether the copy is written. `keep: false`: it takes the place of one that goes, nothing is pruned for it.
    put: (id, value, { keep = true } = {}) => run('readwrite', (table) => table.put(value, id)).then(() => (keep ? prune().catch(() => {}) : null)).then(() => true, () => false),
    remove: (id) => run('readwrite', (table) => table.delete(id)).catch(() => {}),
    flush() {},
  };
}

/**
 * One store over several: a copy is written to the first; it is looked for in each, in order, and removed from
 * all. The later ones are where copies were kept before (a server that has since been restarted).
 */
export function layeredBackupStore(primary, ...older) {
  const all = [primary, ...older].filter(Boolean);
  return {
    async get(id) {
      for (const store of all) {
        let value = null;
        try { value = await store.get(id); } catch { value = null; }
        if (value) return value;
      }
      return null;
    },
    put: (id, value, o) => primary.put(id, value, o),
    remove(id) { for (const store of all) { try { store.remove(id); } catch { /* that store's own failure */ } } },
    flush: (o) => primary.flush?.(o),
  };
}

/**
 * The browser's question when the page is left while something is unsaved.
 * @param {object} o
 * @param {EventTarget} o.target the window
 * @param {() => boolean} o.isDirty
 * @param {() => void} [o.beforeLeave] runs first, whatever the answer: what must be written before the page goes
 */
export function createUnloadGuard({ target, isDirty, beforeLeave = () => {} }) {
  const onBeforeUnload = (event) => {
    try { beforeLeave(); } catch { /* leaving is not held up by it */ }
    let dirty = false;
    try { dirty = !!isDirty(); } catch { dirty = false; }
    if (!dirty) return undefined;
    event.preventDefault();
    event.returnValue = '';
    return '';
  };
  return {
    install() { target.addEventListener('beforeunload', onBeforeUnload); },
    remove() { target.removeEventListener('beforeunload', onBeforeUnload); },
    handler: onBeforeUnload,
  };
}

/** Whether two file versions (`{ mtimeMs, size }`) are the same. Without both, they are not. */
export function sameVersion(a, b) {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * The check of open files against the disk.
 * @param {object} o
 * @param {(paths: string[]) => Promise<{ [path: string]: { exists: boolean, version?: object } } | null>} o.stat
 *   asks the server (POST /api/file-stat); null or a rejection means no answer this time
 * @param {() => { id: string, path: string, version: object | null }[]} o.files the open files and the version
 *   each was read or saved at
 * @param {(id: string, change: { exists: boolean, version: object | null, asked: object | null, path: string }) => void} o.onChange
 *   a file is not what it was: `asked` is the version the check compared with, `path` the path it was asked for
 * @param {() => boolean} [o.isActive] whether a check is worth making now (the panel is visible)
 * @param {number} [o.intervalMs]
 */
export function createDiskWatcher({
  stat, files, onChange, isActive = () => true, intervalMs = DISK_POLL_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (timer) => clearTimeout(timer),
}) {
  let timer = null;
  let running = false;
  let checking = null;

  async function checkOnce() {
    const open = files().filter((file) => file && file.path);
    for (let at = 0; at < open.length; at += STAT_BATCH) {
      const batch = open.slice(at, at + STAT_BATCH);
      let answer = null;
      try { answer = await stat(batch.map((file) => file.path)); } catch { answer = null; }
      if (!answer) return false;
      for (const file of batch) {
        const entry = answer[file.path];
        if (!entry) continue;
        if (entry.exists === false) {
          if (file.version) onChange(file.id, { exists: false, version: null, asked: file.version, path: file.path });
        } else if (!sameVersion(entry.version, file.version)) {
          onChange(file.id, { exists: true, version: entry.version || null, asked: file.version, path: file.path });
        }
      }
    }
    return true;
  }

  /** Check now. One check runs at a time: a second call gets the one under way. */
  function check() {
    if (!checking) checking = checkOnce().finally(() => { checking = null; });
    return checking;
  }

  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!running) return;
    timer = setTimer(async () => {
      timer = null;
      if (running && isActive()) await check().catch(() => {});
      schedule();
    }, intervalMs);
  }

  return {
    start() { if (!running) { running = true; schedule(); } },
    stop() { running = false; if (timer !== null) clearTimer(timer); timer = null; },
    check,
    running: () => running,
  };
}

/**
 * What a bar about unsaved work says and offers. The panel translates the keys and gives each action its function.
 * @param {'conflict' | 'changed' | 'deleted' | 'restored' | 'restored-changed' | 'comparing'} kind
 *   `conflict`: a save was refused because the file changed on disk; `changed`: the check found the file changed
 *   while the buffer has unsaved text; `deleted`: the file is gone; `restored`: unsaved text came back from a
 *   copy; `restored-changed`: it came back over a file that changed since; `comparing`: the comparison is showing
 * @param {{ canCompare?: boolean }} [o] the comparison can be shown (the server has what it takes)
 * @returns {{ id: 'disk' | 'restored' | 'compare', textKey: string, actions: { id: string, labelKey: string }[] }}
 */
export function safetyBar(kind, { canCompare = false } = {}) {
  const compare = canCompare ? [{ id: 'compare', labelKey: 'editor.disk.compare' }] : [];
  const reload = { id: 'reload', labelKey: 'editor.conflict.reload' };
  switch (kind) {
    case 'conflict':
      return { id: 'disk', textKey: 'editor.conflict.text', actions: [...compare, reload, { id: 'overwrite', labelKey: 'editor.conflict.overwrite' }] };
    case 'changed':
      return { id: 'disk', textKey: 'editor.disk.changed', actions: [...compare, reload, { id: 'keepMine', labelKey: 'editor.disk.keepMine' }] };
    case 'deleted':
      return { id: 'disk', textKey: 'editor.disk.deleted', actions: [{ id: 'keepMine', labelKey: 'editor.disk.keepOpen' }, { id: 'closeTab', labelKey: 'editor.disk.closeTab' }] };
    case 'restored':
      return { id: 'restored', textKey: 'editor.backup.restored', actions: [{ id: 'keep', labelKey: 'editor.backup.keep' }, { id: 'discard', labelKey: 'editor.backup.discard' }] };
    case 'restored-changed':
      return { id: 'restored', textKey: 'editor.backup.restoredChanged', actions: [...compare, { id: 'keep', labelKey: 'editor.backup.keep' }, { id: 'discard', labelKey: 'editor.backup.discard' }] };
    case 'comparing':
      return { id: 'compare', textKey: 'editor.compare.text', actions: [{ id: 'closeCompare', labelKey: 'editor.compare.close' }] };
    case 'diffing':
      return { id: 'compare', textKey: 'editor.diff.text', actions: [{ id: 'closeDiff', labelKey: 'editor.diff.close' }] };
    default:
      throw new Error(`Unknown bar: ${kind}`);
  }
}
