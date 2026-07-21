// ═══════════════════════════════════════════
// NODE POSITIONS — blob-backed storage facade
// ═══════════════════════════════════════════
//
// Graph node-position maps grow to hundreds of KB and used to ride the
// ui-state PATCH cycle via storage.js. This facade keeps the synchronous
// localStorage-like API the graph/layout/workspaces code expects, but
// persists each key as its own blob-store entry (ns 'kv').
//
// Top-level await mirrors storage.js: importers get a populated cache before
// their module body runs, so reads stay synchronous.

import { fetchBlobNamespace, putBlob, deleteBlob } from './blob-store.js';

const POS_KEYS = ['synabun-node-positions', 'synabun-node-positions-2d'];
const _cache = {};

await (async () => {
  try {
    const kv = await fetchBlobNamespace('kv');
    for (const key of POS_KEYS) {
      const v = kv[key];
      if (v == null) continue;
      _cache[key] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  } catch { /* server unreachable — start empty, writes will persist later */ }
})();

export const posStore = {
  getItem(key) {
    return _cache[key] ?? null;
  },
  setItem(key, value) {
    const str = String(value);
    if (_cache[key] === str) return;
    _cache[key] = str;
    putBlob('kv', key, str, { debounceMs: 1000 });
  },
  removeItem(key) {
    if (!(key in _cache)) return;
    delete _cache[key];
    deleteBlob('kv', key);
  },
};
