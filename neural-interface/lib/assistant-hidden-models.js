// ═══════════════════════════════════════════
// SynaBun — Assistant hidden models (every provider)
// ═══════════════════════════════════════════
//
// The models the user switched off in the Assistant's Models manager. The
// router, the dispatcher, the catalog (routing sheet, agent_catalog) and every
// Assistant model menu leave them out. One denylist per provider, so new
// models start enabled:
//   claude-code, codex → ~/.synabun/data/assistant-hidden-models.json
//   opencode           → the Settings → OpenCode store (lib/opencode-hidden-models.js),
//                        so both screens edit the same list
// Matching (lib/assistant-catalog.js hiddenModelId): the id, or the row's
// resolved model at the same context window, case-insensitive; context
// variants ("opus" / "opus[1m]", "gpt-x" / "gpt-x[extended]") hide
// independently. OpenCode ids match full or bare. Re-read when the file's
// mtime changes; writes are atomic.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Router } from 'express';
import { CATALOG_PROVIDERS, baseModelId, canonicalModelId, contextSuffix } from './assistant-catalog.js';
import { HIDDEN_MODELS_SYNC_TYPE as OPENCODE_SYNC_TYPE } from './opencode-hidden-models.js';

export const ASSISTANT_HIDDEN_SYNC_TYPE = 'assistant:hidden-models-changed';
export const OWN_PROVIDERS = Object.freeze(['claude-code', 'codex']);
export const MAX_HIDDEN_PER_PROVIDER = 2000;

function hiddenError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}
function arr(value) { return Array.isArray(value) ? value : []; }

/** Unique (case-insensitive), sorted model ids; blanks and oversize values are dropped. */
export function normalizeModelIds(list) {
  const out = new Map();
  for (const value of arr(list)) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || id.length > 300) continue;
    if (!out.has(id.toLowerCase())) out.set(id.toLowerCase(), id);
    if (out.size >= MAX_HIDDEN_PER_PROVIDER) break;
  }
  return [...out.values()].sort();
}

/** The Claude Code / Codex store: { version, updatedAt, providers: { 'claude-code': [], codex: [] } }. */
export function createAssistantHiddenModelsStore({ path, now = Date.now, log = () => {} } = {}) {
  if (!path) throw new Error('createAssistantHiddenModelsStore requires path');
  const emptyProviders = () => Object.fromEntries(OWN_PROVIDERS.map((p) => [p, []]));
  const empty = Object.freeze({ providers: emptyProviders(), version: 0, updatedAt: null });
  let cached = null; // { mtimeMs, value }
  const listeners = new Set();

  function mtime() { try { return statSync(path).mtimeMs; } catch { return 0; } }
  function read() {
    const m = mtime();
    if (cached && cached.mtimeMs === m) return cached.value;
    let value = empty;
    if (m) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) || {};
        const providers = emptyProviders();
        for (const p of OWN_PROVIDERS) providers[p] = normalizeModelIds(raw.providers?.[p]);
        value = { providers, version: Number(raw.version) || 0, updatedAt: raw.updatedAt || null };
      } catch (error) { log('hidden-models:unreadable', error?.message || String(error)); value = cached?.value || empty; }
    }
    cached = { mtimeMs: m, value };
    return value;
  }
  function list(provider) { return read().providers[provider] || []; }

  /** Replace one provider's list. Returns { providers, version, updatedAt, changed }. */
  function set(provider, ids) {
    if (!OWN_PROVIDERS.includes(provider)) throw hiddenError('PROVIDER_INVALID', `provider must be one of ${OWN_PROVIDERS.join(', ')}`);
    const current = read();
    const nextList = normalizeModelIds(ids);
    const changed = current.providers[provider].join('\n') !== nextList.join('\n');
    if (!changed) return { ...current, changed: false };
    const next = { version: current.version + 1, updatedAt: new Date(now()).toISOString(), providers: { ...current.providers, [provider]: nextList } };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
    cached = { mtimeMs: mtime(), value: next };
    for (const listener of listeners) { try { listener(next, { provider, changed: true }); } catch {} }
    return { ...next, changed: true };
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  return { read, list, set, onChange, path };
}

/**
 * One view over both stores.
 *   list(provider) → ids; all() → { 'claude-code', codex, opencode }
 *   update(provider, { hide, show }) → { provider, hidden, changed, added, removed }
 *   onChange(fn) → fn({ provider }) after either store changes
 * OpenCode ids are "provider/model" (its store drops anything else); callers
 * resolve bare ids first (the router does, from the catalog).
 */
export function createHiddenModels({ file, opencodeStore = null, now = Date.now, log = () => {} } = {}) {
  const own = createAssistantHiddenModelsStore({ path: file, now, log });
  const listeners = new Set();
  const emit = (provider) => { for (const fn of listeners) { try { fn({ provider }); } catch {} } };
  own.onChange((_value, meta) => emit(meta?.provider || null));
  opencodeStore?.onChange?.(() => emit('opencode'));

  function list(provider) {
    if (provider === 'opencode') { try { return arr(opencodeStore?.list?.()); } catch { return []; } }
    return OWN_PROVIDERS.includes(provider) ? own.list(provider) : [];
  }
  function all() { return Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, list(p)])); }

  function update(provider, { hide = [], show = [] } = {}) {
    if (!CATALOG_PROVIDERS.includes(provider)) throw hiddenError('PROVIDER_INVALID', `provider must be one of ${CATALOG_PROVIDERS.join(', ')}`);
    if (provider === 'opencode' && !opencodeStore) throw hiddenError('PROVIDER_UNAVAILABLE', 'The OpenCode hidden-model store is not available.', 503);
    const current = list(provider);
    const key = (id) => String(id).trim().toLowerCase();
    const hideIds = arr(hide).map((id) => String(id || '').trim()).filter(Boolean);
    const showKeys = new Set(arr(show).map(key).filter(Boolean));
    const next = new Map(current.map((id) => [key(id), id]));
    for (const id of hideIds) if (!next.has(key(id))) next.set(key(id), id);
    for (const k of showKeys) next.delete(k);
    const nextList = [...next.values()];
    const before = new Set(current.map(key));
    const after = new Set(nextList.map(key));
    const added = nextList.filter((id) => !before.has(key(id)));
    const removed = current.filter((id) => !after.has(key(id)));
    if (!added.length && !removed.length) return { provider, hidden: current, changed: false, added, removed };
    const result = provider === 'opencode' ? opencodeStore.set(nextList) : own.set(provider, nextList);
    return { provider, hidden: provider === 'opencode' ? result.models : result.providers[provider], changed: true, added, removed, version: result.version };
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  return { list, all, update, onChange, store: own, path: file };
}

// ── resolving user-typed ids against the unfiltered catalog ─────────────────

/**
 * How well `want` names `row` (higher is better, 0 = no match): exact id 4,
 * case-insensitive id 3, resolved model at the same context window or bare
 * OpenCode id 2, label 1. The context suffix always counts: "opus" never
 * names "opus[1m]".
 */
function rowScore(row, want) {
  const id = String(row.id || '');
  const lower = want.toLowerCase();
  if (id === want) return 4;
  if (id.toLowerCase() === lower) return 3;
  if (row.provider === 'claude-code' && row.upstream && `${baseModelId(row.upstream)}${contextSuffix(id)}`.toLowerCase() === lower) return 2;
  if (row.provider === 'opencode' && !want.includes('/') && id.split('/').slice(1).join('/').toLowerCase() === lower) return 2;
  if (String(row.label || '').toLowerCase() === lower) return 1;
  return 0;
}

function suggestionsFor(rowsByProvider, want, provider = null) {
  const needle = String(want || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const score = (row) => { const id = String(row.id).toLowerCase().replace(/[^a-z0-9]/g, ''); let s = 0; for (const ch of new Set(needle)) if (id.includes(ch)) s += 1; if (id.includes(needle)) s += 10; return s; };
  const rows = Object.entries(rowsByProvider).filter(([p]) => !provider || p === provider).flatMap(([p, list]) => list.map((row) => ({ ...row, provider: p })));
  return rows.sort((a, b) => score(b) - score(a)).slice(0, 5).map((row) => ({ provider: row.provider, id: row.id }));
}

/**
 * Resolve one id to { provider, id } for `action` ('hide' | 'show').
 * `rowsByProvider` = every catalog row, hidden ones included; `hiddenByProvider`
 * = the current lists (a model that left the catalog can still be shown again).
 * A claude-* id the CLI accepts without listing it can be hidden too.
 */
export function resolveHiddenModelId({ id, provider = null, action = 'hide', rowsByProvider = {}, hiddenByProvider = {} }) {
  const typed = String(id || '').trim();
  if (!typed) throw hiddenError('MODEL_REQUIRED', 'Model id required.');
  const providers = provider ? [provider] : CATALOG_PROVIDERS;
  const candidates = [];
  let want = typed;
  for (const p of providers) {
    want = canonicalModelId(p, typed);
    let best = null;
    for (const row of arr(rowsByProvider[p])) {
      const s = rowScore({ ...row, provider: p }, want);
      // A resolved-model match hides the resolved id itself, so every alias of
      // it (default, opus, …) goes with it, at that context window only.
      if (s && (!best || s > best.score)) best = { provider: p, id: s === 2 && p === 'claude-code' ? want.toLowerCase() : row.id, score: s };
    }
    if (!best && action === 'show') {
      const lower = want.toLowerCase();
      const hit = arr(hiddenByProvider[p]).find((h) => String(h).toLowerCase() === lower || (p === 'opencode' && !want.includes('/') && String(h).split('/').slice(1).join('/').toLowerCase() === lower));
      if (hit) best = { provider: p, id: hit, score: 3 };
    }
    if (!best && p === 'claude-code' && /^claude-[a-z0-9.\-]+(\[1m\])?$/i.test(want)) best = { provider: p, id: want.toLowerCase(), score: 1 };
    if (best) candidates.push(best);
  }
  want = typed;
  if (!candidates.length) {
    throw hiddenError('MODEL_UNKNOWN', `Unknown model "${want}"${provider ? ` for ${provider}` : ''}. Use an id from the Assistant's Models list.`, 400, { suggestions: suggestionsFor(rowsByProvider, want, provider) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.filter((c) => c.score === candidates[0].score);
  if (top.length > 1) {
    throw hiddenError('MODEL_AMBIGUOUS', `"${want}" names a model of ${top.map((c) => c.provider).join(' and ')}. Pass provider.`, 400, { suggestions: top.map((c) => ({ provider: c.provider, id: c.id })) });
  }
  return { provider: top[0].provider, id: top[0].id };
}

/**
 * GET   /  → { ok, providers: { 'claude-code': [], codex: [], opencode: [] } }
 * PATCH /  { provider?, hide?: [], show?: [] } → the new lists plus what changed.
 *          A missing provider is inferred from the unfiltered catalog.
 * Owner only (guests get 403). Broadcasts assistant:hidden-models-changed, and
 * opencode:hidden-models-changed when the OpenCode list changed.
 */
export function createAssistantHiddenModelsRouter({ hiddenModels, catalog = null, opencodeStore = null, isGuestRequest = () => false, broadcastSync = () => {} } = {}) {
  if (!hiddenModels) throw new Error('createAssistantHiddenModelsRouter requires hiddenModels');
  const router = Router();
  router.use((req, res, next) => {
    if (isGuestRequest(req)) return res.status(403).json({ ok: false, code: 'OWNER_ONLY', error: 'Admin only' });
    next();
  });
  router.get('/', (req, res) => {
    try { res.json({ ok: true, providers: hiddenModels.all() }); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  router.patch('/', async (req, res) => {
    try {
      const body = req.body || {};
      const toList = (value) => (Array.isArray(value) ? value : (typeof value === 'string' && value.trim() ? [value] : []));
      const hide = toList(body.hide);
      const show = toList(body.show);
      if (!hide.length && !show.length) throw hiddenError('MODELS_REQUIRED', 'Pass hide and/or show: arrays of model ids.');
      if (hide.length + show.length > MAX_HIDDEN_PER_PROVIDER) throw hiddenError('TOO_MANY', `At most ${MAX_HIDDEN_PER_PROVIDER} ids per request.`);
      const provider = body.provider ? String(body.provider).trim().toLowerCase() : null;
      if (provider && !CATALOG_PROVIDERS.includes(provider)) throw hiddenError('PROVIDER_INVALID', `provider must be one of ${CATALOG_PROVIDERS.join(', ')}`);
      let rowsByProvider = {};
      try { rowsByProvider = (await catalog?.manageRows?.()) || {}; } catch {}
      const hiddenByProvider = hiddenModels.all();
      const plan = new Map(); // provider → { hide: [], show: [] }
      const applied = [];
      const add = (action, raw) => {
        const hit = resolveHiddenModelId({ id: raw, provider, action, rowsByProvider, hiddenByProvider });
        if (!plan.has(hit.provider)) plan.set(hit.provider, { hide: [], show: [] });
        plan.get(hit.provider)[action].push(hit.id);
        applied.push({ action, provider: hit.provider, id: hit.id, requested: String(raw) });
      };
      for (const id of hide) add('hide', id);
      for (const id of show) add('show', id);
      const results = [];
      for (const [p, change] of plan) results.push(hiddenModels.update(p, change));
      const changed = results.filter((r) => r.changed);
      const providers = hiddenModels.all();
      if (changed.length) {
        broadcastSync({ type: ASSISTANT_HIDDEN_SYNC_TYPE, providers, changed: changed.map((r) => r.provider) });
        const oc = changed.find((r) => r.provider === 'opencode');
        if (oc) {
          let version = oc.version;
          try { version = opencodeStore?.read?.().version ?? version; } catch {}
          broadcastSync({ type: OPENCODE_SYNC_TYPE, models: providers.opencode, version });
        }
      }
      res.json({
        ok: true, providers, changed: changed.length > 0, applied,
        added: Object.fromEntries(changed.map((r) => [r.provider, r.added])),
        removed: Object.fromEntries(changed.map((r) => [r.provider, r.removed])),
      });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: error.message, code: error.code || null, suggestions: error.suggestions || undefined });
    }
  });
  return router;
}
