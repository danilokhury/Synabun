// ── A Codex rollout, read once for the preview and the history fallback ──
// The early preview (server.js sendEarlyCodexRolloutPreview) used to readFileSync the
// whole rollout JSONL before Codex's app-server started, for every thread a tab
// bootstrapped, and the history fallback read it again right after. This reads it as
// a stream (the event loop and the app-server's start are not held up) and keeps the
// parsed items of the last few files by path, size and time, so the fallback that
// follows reuses them while the file is unchanged.

import { createReadStream, statSync } from 'node:fs';
import { jsonlLines } from './jsonl-lines.js';

export function createRolloutReader({
  open = (path) => createReadStream(path, { encoding: 'utf-8' }),
  stat = statSync,
  maxEntries = 4,
} = {}) {
  const kept = new Map(); // path → { size, mtimeMs, items }
  const running = new Map(); // `${path}|${size}|${mtimeMs}` → promise of items
  const stats = { reads: 0, reused: 0 };

  /** The items `parse(lines)` makes of the file at `path` (an async iterable of its lines). */
  async function items(path, parse) {
    if (!path) return [];
    let st;
    try { st = stat(path); } catch { return []; }
    const hit = kept.get(path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      stats.reused++;
      kept.delete(path); kept.set(path, hit);
      return hit.items;
    }
    const key = `${path}|${st.size}|${st.mtimeMs}`;
    if (running.has(key)) { stats.reused++; return running.get(key); }
    const job = (async () => {
      stats.reads++;
      const stream = open(path);
      try {
        const out = await parse(jsonlLines(stream));
        kept.delete(path);
        kept.set(path, { size: st.size, mtimeMs: st.mtimeMs, items: out });
        while (kept.size > maxEntries) kept.delete(kept.keys().next().value);
        return out;
      } finally {
        stream.destroy?.();
      }
    })();
    running.set(key, job);
    try { return await job; } finally { running.delete(key); }
  }

  return { items, forget: (path) => kept.delete(path), get stats() { return { ...stats }; }, get size() { return kept.size; } };
}
