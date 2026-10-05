// ── What the CLI knows about a session, over SynaBun's own session list ──
// The session menu is built from SynaBun's transcript scan (message counts, the
// "deleted" cache). It never read what the CLI itself keeps per session: the
// title set with /rename or `renameSession`, the summary, the tag. The Agent
// SDK's listSessions() does, from the head and tail of each file (measured on
// 738 sessions / 1.1 GB: 0.5 s for all of a project, 0.1 s for a page).
// This keeps one such list per project and serves it stale-while-revalidate:
// the menu is polled, and a list that cannot be read must never break it.

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * @param o.listSessions (opts) => Promise<SDKSessionInfo[]>  the SDK function (injected)
 * @param o.ttlMs        how long a list is served before a refresh starts
 * @param o.firstWaitMs  how long the first request for a project waits for its list
 */
export function createSessionListOverlay({ listSessions, ttlMs = 30_000, firstWaitMs = 1500, now = Date.now, log = () => {} } = {}) {
  const cache = new Map(); // dir → { at, map, pending }
  const EMPTY = new Map();

  function refresh(dir) {
    const entry = cache.get(dir) || { at: 0, map: null, pending: null };
    if (entry.pending) return entry.pending;
    entry.pending = Promise.resolve()
      .then(() => listSessions({ dir }))
      .then((rows) => {
        const map = new Map();
        for (const r of Array.isArray(rows) ? rows : []) {
          if (!r || typeof r.sessionId !== 'string') continue;
          map.set(r.sessionId, {
            title: text(r.customTitle, 200),
            summary: text(r.summary, 200),
            tag: text(r.tag, 60),
            createdAt: Number.isFinite(r.createdAt) ? r.createdAt : null,
          });
        }
        entry.map = map;
        entry.at = now();
        return map;
      })
      .catch((err) => { try { log(`[claude-sessions] listSessions failed for ${dir}: ${err?.message || err}`); } catch {} return entry.map || EMPTY; })
      .finally(() => { entry.pending = null; });
    cache.set(dir, entry);
    return entry.pending;
  }

  return {
    /** sessionId → { title, summary, tag, createdAt } for one project directory. Never rejects. */
    async forProject(dir) {
      if (!dir || typeof listSessions !== 'function') return EMPTY;
      const entry = cache.get(dir);
      if (entry?.map) {
        if (now() - entry.at > ttlMs) refresh(dir); // serve what is there, refresh behind it
        return entry.map;
      }
      // Nothing yet: wait a moment for the first list, then go on without it.
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(EMPTY), firstWaitMs); timer.unref?.(); });
      try { return await Promise.race([refresh(dir), timeout]); } finally { clearTimeout(timer); }
    },
    /** A title or a tag changed, a session was deleted or forked: read again on the next request. */
    invalidate(dir) {
      if (dir) { const e = cache.get(dir); if (e) e.at = 0; return; }
      for (const e of cache.values()) e.at = 0;
    },
  };
}

/** The entries of SynaBun's own list with the CLI's title, summary and tag added. */
export function overlaySessions(entries, meta) {
  return (Array.isArray(entries) ? entries : []).map((e) => {
    const m = meta?.get?.(e.sessionId);
    return m ? { ...e, title: m.title || '', summary: m.summary || '', tag: m.tag || '' } : e;
  });
}

/** Does a session match the menu's search text or tag filter, counting the CLI's title and tag? */
export function matchesSessionFilter(entry, { search = '', tag = '' } = {}) {
  if (tag && (entry.tag || '') !== tag) return false;
  if (!search) return true;
  return [entry.firstPrompt, entry.gitBranch, entry.sessionId, entry.title, entry.tag].some(v => String(v || '').toLowerCase().includes(search));
}
