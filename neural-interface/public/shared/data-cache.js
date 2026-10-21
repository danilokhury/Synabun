// ═══════════════════════════════════════════
// SynaBun Neural Interface — data cache
// ═══════════════════════════════════════════
// One cache for what windows, menus and dropdowns wait for when they open
// (model lists, provider lists, accounts, Settings' reads). In memory, per
// page: a kept answer is given at once and asked for again in the background
// once it is old (stale-while-revalidate); callers asking at the same time
// share one request; nothing is kept from a failed request. A change event
// ages an answer (markStale: still given, asked for again) or drops it
// (invalidate: the next read waits, `refetch` asks for it right away), and
// subscribers hear when a background read brought another answer, so an open
// window can update in place.
//
// `persist: true` also keeps the last answer in sessionStorage (this tab only,
// gone when it closes): a reload paints from it at once. An answer read back
// from there is always asked for again on its first read.
//
// No DOM, no imports: runs under node --test as well.

const STORAGE_PREFIX = 'synabun:data-cache:v1:';
const MAX_PERSIST_CHARS = 768 * 1024;

const registry = new Map(); // name → cache (invalidateDataCaches)

function sameJson(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function session() {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

/**
 * @param {string} name
 * @param {object} o
 * @param {(key:string, opts:{force:boolean})=>Promise<any>} o.load  the request; throw on failure
 * @param {number} [o.ttlMs]           how long an answer is fresh
 * @param {boolean} [o.persist]        keep the last answer in sessionStorage too
 * @param {(value:any, key:string)=>boolean} [o.accept]  worth keeping (a failed or empty answer is not)
 * @param {(a:any, b:any)=>boolean} [o.equals]
 */
export function createDataCache(name, {
  load,
  ttlMs = 60_000,
  persist = false,
  accept = (value) => value !== undefined && value !== null,
  equals = sameJson,
  now = () => Date.now(),
} = {}) {
  if (typeof load !== 'function') throw new Error(`data cache ${name}: load is required`);
  const entries = new Map();     // key → { value, at, stale }
  const inflight = new Map();    // key → promise
  const generations = new Map(); // key → bumped by invalidate(): a request begun before it is not kept
  const listeners = new Set();
  const restored = new Set();    // keys looked up in sessionStorage already

  const storageKey = (key) => `${STORAGE_PREFIX}${name}:${key}`;
  const ok = (value, key) => { try { return accept(value, key) === true; } catch { return false; } };

  function restore(key) {
    if (!persist || restored.has(key)) return;
    restored.add(key);
    if (entries.has(key)) return;
    try {
      const raw = session()?.getItem(storageKey(key));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.value !== undefined && ok(parsed.value, key)) entries.set(key, { value: parsed.value, at: Number(parsed.at) || 0, stale: true });
    } catch { /* unreadable: nothing kept */ }
  }

  function save(key, entry) {
    if (!persist) return;
    try {
      const text = JSON.stringify({ at: entry.at, value: entry.value });
      if (text.length > MAX_PERSIST_CHARS) { session()?.removeItem(storageKey(key)); return; }
      session()?.setItem(storageKey(key), text);
    } catch { /* full or unavailable: memory still has it */ }
  }

  function forget(key) {
    if (!persist) return;
    try { session()?.removeItem(storageKey(key)); } catch { /* unavailable */ }
  }

  function notify(key, value, previous) {
    for (const listener of [...listeners]) {
      try { listener(key, value, previous); } catch { /* a listener's failure is its own */ }
    }
  }

  function store(key, value) {
    const previous = entries.get(key);
    const same = !!previous && equals(previous.value, value);
    const entry = { value: same ? previous.value : value, at: now(), stale: false };
    entries.set(key, entry);
    save(key, entry);
    if (!same) notify(key, entry.value, previous?.value);
    return entry.value;
  }

  function fresh(entry) {
    return !!entry && !entry.stale && now() - entry.at < ttlMs;
  }

  function request(key, force) {
    if (inflight.has(key)) return inflight.get(key);
    const generation = generations.get(key) || 0;
    const job = (async () => {
      try {
        const value = await load(key, { force });
        if (ok(value, key) && (generations.get(key) || 0) === generation) return { value: store(key, value), kept: true };
        return { value, kept: false };
      } finally {
        if (inflight.get(key) === job) inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  /** `{ value, cached, stale }`: a kept answer at once (asked for again when old), else the request's. */
  async function read(key = '', { force = false } = {}) {
    const id = String(key);
    restore(id);
    const entry = entries.get(id);
    if (!force && entry) {
      const stale = !fresh(entry);
      if (stale) request(id, false).catch(() => {});
      return { value: entry.value, cached: true, stale };
    }
    const result = await request(id, force);
    return { value: result.value, cached: false, stale: false, kept: result.kept };
  }

  const cache = {
    name,
    read,
    async get(key = '', options = {}) { return (await read(key, options)).value; },
    /** The kept answer, or undefined: never waits. An old one (or one read back after a reload) is asked for again behind it. */
    peek(key = '') {
      const id = String(key);
      restore(id);
      const entry = entries.get(id);
      if (entry && !fresh(entry)) request(id, false).catch(() => {});
      return entry?.value;
    },
    has(key = '') { const id = String(key); restore(id); return entries.has(id); },
    /** True while nothing was kept and a request is running (the one moment a spinner is right). */
    loading(key = '') { const id = String(key); restore(id); return !entries.has(id) && inflight.has(id); },
    /** Ask now unless a fresh answer is kept; resolves when done, never rejects. */
    prefetch(key = '') {
      const id = String(key);
      restore(id);
      if (fresh(entries.get(id))) return Promise.resolve(entries.get(id).value);
      return request(id, false).then((result) => result.value, () => undefined);
    },
    /** Ask again now (one request for every caller); resolves to the answer, never rejects. */
    refresh(key = '', { force = false } = {}) {
      return request(String(key), force).then((result) => result.value, () => undefined);
    },
    /** Keep an answer obtained elsewhere (a save that returned the new state). */
    set(key = '', value) { const id = String(key); if (ok(value, id)) store(id, value); },
    /** The answer is due: still given, asked for again on the next read (`refetch`: now). */
    markStale(key = null, { refetch = false } = {}) {
      const ids = key === null ? [...entries.keys()] : [String(key)];
      for (const id of ids) {
        restore(id);
        const entry = entries.get(id);
        if (entry) entry.stale = true;
        if (refetch) request(id, false).catch(() => {});
      }
    },
    /** Drop the answer: the next read waits for a new one; a request already running is not kept (`refetch`: ask now). */
    invalidate(key = null, { refetch = false } = {}) {
      const ids = key === null ? [...new Set([...entries.keys(), ...inflight.keys()])] : [String(key)];
      for (const id of ids) {
        entries.delete(id);
        restored.add(id);
        forget(id);
        generations.set(id, (generations.get(id) || 0) + 1);
        // A request begun before this is not joined by later reads: its answer is from before the change.
        inflight.delete(id);
        if (refetch) request(id, false).catch(() => {});
      }
    },
    /** `listener(key, value, previous)` whenever another answer is kept. Returns the function that stops it. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    keys() { return [...entries.keys()]; },
  };
  registry.set(name, cache);
  return cache;
}

/** The cache registered under `name`, or null. */
export function dataCache(name) {
  return registry.get(name) || null;
}

/** Drop every answer of the named caches (or of all of them): a sign-out, a server that came back as another. */
export function invalidateDataCaches(names = null) {
  for (const [name, cache] of registry) {
    if (!names || names.includes(name)) cache.invalidate();
  }
}

/**
 * Run `fn` when the page is idle (requestIdleCallback where there is one; Safari has none, so a short timer
 * there), at most `timeout` ms later. Returns a function that cancels it.
 */
export function whenIdle(fn, { timeout = 1500, fallbackMs = 120 } = {}) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(() => fn(), { timeout });
    return () => { try { window.cancelIdleCallback?.(id); } catch { /* gone */ } };
  }
  const id = setTimeout(fn, fallbackMs);
  return () => clearTimeout(id);
}
