// ═══════════════════════════════════════════
// SynaBun — OpenCode hidden models (~/.synabun/data/opencode-hidden-models.json)
// ═══════════════════════════════════════════
//
// Settings → OpenCode per-model checkboxes. A denylist of "providerID/modelID"
// ids, so new models start enabled. This file is the source of truth: the
// Assistant's catalog, router and dispatcher read it here, and every browser
// window mirrors it into localStorage `ocp-hidden-models` for the synchronous
// OpenCode pickers (public/shared/ocp-hidden-models.js). `initialized` stays
// false until the first write, so a window holding choices made before the
// server kept them can migrate them once. Re-read when the file's mtime
// changes; writes are atomic (tmp + rename).

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Router } from 'express';

export const MAX_HIDDEN_MODELS = 5000;
export const HIDDEN_MODELS_SYNC_TYPE = 'opencode:hidden-models-changed';

function hiddenError(message) {
  const error = new Error(message);
  error.code = 'HIDDEN_MODELS_INVALID';
  error.status = 400;
  return error;
}

/** Unique, sorted "provider/model" ids; anything else is dropped. */
export function normalizeHiddenModels(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const value of list) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || id.length > 300 || !id.includes('/') || id.startsWith('/') || id.endsWith('/')) continue;
    out.add(id);
    if (out.size >= MAX_HIDDEN_MODELS) break;
  }
  return [...out].sort();
}

export function createOpencodeHiddenModelsStore({ path, now = Date.now, log = () => {} } = {}) {
  if (!path) throw new Error('createOpencodeHiddenModelsStore requires path');
  const empty = Object.freeze({ models: [], initialized: false, version: 0, updatedAt: null });
  let cached = null; // { mtimeMs, value, set }
  const listeners = new Set();

  function mtime() { try { return statSync(path).mtimeMs; } catch { return 0; } }
  function read() {
    const m = mtime();
    if (cached && cached.mtimeMs === m) return cached.value;
    let value = empty;
    if (m) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) || {};
        value = { models: normalizeHiddenModels(raw.models), initialized: true, version: Number(raw.version) || 0, updatedAt: raw.updatedAt || null };
      } catch (error) { log('hidden-models:unreadable', error?.message || String(error)); value = cached?.value || empty; }
    }
    cached = { mtimeMs: m, value, set: new Set(value.models) };
    return value;
  }
  function list() { return read().models; }
  function hiddenSet() { read(); return cached.set; }
  function has(id) { return hiddenSet().has(String(id || '').trim()); }

  /** Replace the whole list. Returns the new state plus `changed`. */
  function set(models) {
    if (!Array.isArray(models)) throw hiddenError('models must be an array of "provider/model" ids');
    const current = read();
    const next = { models: normalizeHiddenModels(models), version: current.version + 1, updatedAt: new Date(now()).toISOString() };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
    const value = { ...next, initialized: true };
    cached = { mtimeMs: mtime(), value, set: new Set(value.models) };
    const changed = current.models.join('\n') !== value.models.join('\n');
    for (const listener of listeners) { try { listener(value, { changed }); } catch {} }
    return { ...value, changed };
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { read, list, hiddenSet, has, set, onChange, path };
}

/**
 * GET  /  → { ok, models, initialized, version, updatedAt }
 * PUT  /  { models, migrate? } → the new state. `migrate: true` writes only
 *         while the store was never written (one-time localStorage import).
 * Guests may read (their pickers need it) but not write.
 */
export function createOpencodeHiddenModelsRouter({ store, isGuestRequest = () => false, broadcastSync = () => {} } = {}) {
  if (!store) throw new Error('createOpencodeHiddenModelsRouter requires a store');
  const router = Router();
  const view = (value) => ({ models: value.models, initialized: value.initialized, version: value.version, updatedAt: value.updatedAt });
  router.get('/', (req, res) => {
    try { res.json({ ok: true, ...view(store.read()) }); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  router.put('/', (req, res) => {
    if (isGuestRequest(req)) return res.status(403).json({ ok: false, error: 'Admin only' });
    try {
      const current = store.read();
      if (req.body?.migrate === true && current.initialized) return res.json({ ok: true, migrated: false, ...view(current) });
      const result = store.set(req.body?.models);
      if (result.changed) broadcastSync({ type: HIDDEN_MODELS_SYNC_TYPE, models: result.models, version: result.version });
      res.json({ ok: true, migrated: req.body?.migrate === true, changed: result.changed, ...view(result) });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: error.message, code: error.code || null });
    }
  });
  return router;
}
