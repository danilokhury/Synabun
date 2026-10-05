// ═══════════════════════════════════════════
// SynaBun — OpenCode hidden models (client)
// ═══════════════════════════════════════════
// Settings → OpenCode per-model checkboxes: a denylist of "providerID/modelID"
// ids, so new models start enabled. The server (GET/PUT
// /api/opencode/hidden-models, lib/opencode-hidden-models.js) is the source of
// truth, so every window and origin and the Assistant's router agree.
// localStorage `ocp-hidden-models` stays as the synchronous mirror the
// OpenCode pickers read; a mirror change fires the document event
// `ocp-hidden-models-changed`. Before the server kept this list it lived only
// in localStorage: the first window that finds the server store never written
// pushes its local list up once.

export const HIDDEN_MODELS_KEY = 'ocp-hidden-models';
export const HIDDEN_MODELS_EVENT = 'ocp-hidden-models-changed';
const ENDPOINT = '/api/opencode/hidden-models';

let _chain = Promise.resolve();
let _pending = 0;
let _latest = null;
let _hydrating = null;

function readMirror() {
  try {
    const value = JSON.parse(localStorage.getItem(HIDDEN_MODELS_KEY) || '[]');
    return Array.isArray(value) ? value.map(String) : [];
  } catch { return []; }
}

function writeMirror(list) {
  try { localStorage.setItem(HIDDEN_MODELS_KEY, JSON.stringify(list)); } catch {}
}

function sameList(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function notify() {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent(HIDDEN_MODELS_EVENT));
}

async function putHidden(body) {
  try {
    const res = await fetch(ENDPOINT, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    return res.ok && data?.ok ? data : null;
  } catch { return null; }
}

/** The hidden set as this window knows it (the localStorage mirror). */
export function getHiddenModels() {
  return new Set(readMirror());
}

/** The hidden id a model id names (full "provider/model", or a bare model id), else null. */
export function hiddenModelMatch(id, hidden = getHiddenModels()) {
  const want = String(id || '').trim().toLowerCase();
  if (!want) return null;
  for (const h of hidden) {
    const full = String(h).toLowerCase();
    if (full === want || (!want.includes('/') && full.split('/').slice(1).join('/') === want)) return String(h);
  }
  return null;
}

/**
 * Mirror the server's list locally; fires the change event when it differs.
 * Ignored while this window's own newer write is still on its way.
 */
export function applyHiddenModels(models) {
  if (_pending > 0 || !Array.isArray(models)) return false;
  const next = models.map(String);
  if (sameList(readMirror(), next)) return false;
  writeMirror(next);
  notify();
  return true;
}

/**
 * Save a new hidden set: the mirror at once, then the server (writes are
 * serialized and each sends the latest list). Callers fire the change event.
 */
export function saveHiddenModels(set) {
  _latest = [...set].map(String);
  writeMirror(_latest);
  _pending += 1;
  _chain = _chain.catch(() => null)
    .then(() => putHidden({ models: _latest }))
    .finally(() => { _pending -= 1; });
  return _chain;
}

/** Pull the server's list into the mirror (and migrate a pre-server local list once). */
export function hydrateHiddenModels() {
  if (_hydrating) return _hydrating;
  _hydrating = (async () => {
    try {
      const res = await fetch(ENDPOINT);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) return getHiddenModels();
      const local = readMirror();
      if (!data.initialized && local.length) {
        const migrated = await putHidden({ models: local, migrate: true });
        if (migrated?.models) applyHiddenModels(migrated.models);
      } else {
        applyHiddenModels(data.models || []);
      }
    } catch {}
    return getHiddenModels();
  })().finally(() => { _hydrating = null; });
  return _hydrating;
}

if (typeof window !== 'undefined' && typeof fetch === 'function') hydrateHiddenModels();
