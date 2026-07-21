// ═══════════════════════════════════════════
// SynaBun Neural Interface — memo-cache
// ═══════════════════════════════════════════
// Single-flight memoization for expensive loaders behind polled endpoints,
// with optional fs.watch invalidation and a TTL backstop (macOS FSEvents can
// drop or coalesce events under load — never rely on the watcher alone).

import { watch as fsWatch } from 'fs';

export function memoCache(loader, { ttlMs = 0, watchDirs = [], watchFilter = null } = {}) {
  let value;
  let loadedAt = 0;
  let inFlight = null;
  let invalidated = true;
  let invalidateTimer = null;
  const watchers = [];

  const invalidate = () => { invalidated = true; };

  const scheduleInvalidate = () => {
    // Debounce watcher bursts (one save can emit several events)
    if (invalidateTimer) return;
    invalidateTimer = setTimeout(() => { invalidateTimer = null; invalidate(); }, 100);
    invalidateTimer.unref?.();
  };

  const armWatcher = (dir) => {
    try {
      const w = fsWatch(dir, (eventType, filename) => {
        if (watchFilter && filename && !watchFilter(filename)) return;
        scheduleInvalidate();
      });
      w.unref?.();
      w.on('error', () => {
        invalidate();
        try { w.close(); } catch {}
        // Re-arm after a beat — the dir may have been replaced (rename swap)
        const t = setTimeout(() => armWatcher(dir), 1000);
        t.unref?.();
      });
      watchers.push(w);
    } catch { /* dir may not exist yet — TTL backstop covers it */ }
  };
  for (const dir of watchDirs) armWatcher(dir);

  const isFresh = () => {
    if (invalidated) return false;
    if (ttlMs > 0 && Date.now() - loadedAt > ttlMs) return false;
    return loadedAt > 0;
  };

  return {
    async get(...args) {
      if (isFresh()) return value;
      if (!inFlight) {
        invalidated = false;
        inFlight = Promise.resolve(loader(...args))
          .then((v) => { value = v; loadedAt = Date.now(); return v; })
          .finally(() => { inFlight = null; });
      }
      return inFlight;
    },
    invalidate,
    peek() { return value; },
    close() {
      for (const w of watchers) { try { w.close(); } catch {} }
      watchers.length = 0;
    },
  };
}

// Run fn over items with bounded concurrency; resolves to results in order.
export async function asyncPool(limit, items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
