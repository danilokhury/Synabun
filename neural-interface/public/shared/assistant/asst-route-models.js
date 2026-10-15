// ═══════════════════════════════════════════
// SynaBun Assistant — Model routes editor: where its model lists come from
// ═══════════════════════════════════════════
// The data side of the Routes editor (asst-route.js `openRoutesEditor`), kept
// apart from its markup. No DOM is built here.
//
// One list per provider, the one every Assistant model menu shows:
// loadModelCatalog() of asst-brain-picker.js, which is GET /api/assistant/catalog,
// itself built from the lists the Claude, Codex and OpenCode panels' own
// selectors read. Nothing here, and nothing in the editor, may keep a second
// list of models: a label, a tier, a price or an effort level is read from the
// catalog row each time it is drawn.

import { catalogModelRow, loadModelCatalog, modelCatalogStatus, onModelCatalogChange } from './asst-brain-picker.js';
import { routeTargetLabel } from './asst-state.js';

/** The catalog as the editor opens: a new build, never the copy another menu loaded a minute ago. */
export function loadRouteModels() {
  return loadModelCatalog({ force: true });
}

/** Loading/partial state belongs to the same model source, without changing the catalog shape. */
export function routeModelsStatus() { return modelCatalogStatus(); }

/**
 * The name shown for a saved route's model. The catalog's label for that id wins:
 * a route keeps the label it was saved with, and an alias moves ("haiku" was
 * Haiku 4.5, then Haiku 5.5). A model the catalog no longer lists (removed by its
 * provider, hidden, or its provider is not answering) keeps the saved label,
 * then its id, then the provider's name: never an empty name.
 */
export function routeModelLabel(pref, catalog) {
  if (!pref || typeof pref !== 'object') return '';
  const row = pref.provider && pref.model ? catalogModelRow(pref.provider, pref.model, catalog) : null;
  const live = row?.label ? String(row.label).trim() : '';
  return live || routeTargetLabel(pref);
}

/** What the editor draws from a catalog: when this is unchanged, there is nothing to redraw. */
export function catalogSignature(catalog) {
  if (!catalog || typeof catalog !== 'object') return '';
  return JSON.stringify(Object.keys(catalog).sort().map(provider => [
    provider,
    (Array.isArray(catalog[provider]) ? catalog[provider] : []).map(m => [
      m?.id, m?.label, m?.status ?? null, m?.vision ?? null, m?.outputs?.image ?? null, m?.outputs?.video ?? null,
      (m?.efforts || []).join(','), m?.defaultEffort || '', m?.isDefault === true,
    ]),
  ]));
}

/**
 * Keeps an open editor on the current lists. `apply(catalog)` is called with a
 * newly loaded catalog whenever it differs from the last one applied:
 *  - after a change event (a model hidden or shown, a provider listing other
 *    models, an OpenCode provider connected or removed): a new build is asked;
 *  - when the window is shown again: the catalog is read again, and reloaded
 *    once its copy has aged out (no event tells a window that slept).
 * Returns { seed(catalog), stop() }: seed with the catalog the editor loaded
 * itself, stop when it closes. No timer runs while nothing changes.
 */
export function watchRouteModels(apply, {
  load = loadModelCatalog,
  subscribe = onModelCatalogChange,
  doc = typeof document !== 'undefined' ? document : null,
  delayMs = 150,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let stopped = false;
  let timer = null;
  let last = null;
  let run = 0;

  async function reload(force) {
    const mine = ++run;
    let catalog = null;
    try { catalog = await load({ force }); } catch { return; }
    if (stopped || mine !== run || !catalog) return;
    const signature = catalogSignature(catalog);
    if (signature === last) return;
    last = signature;
    try { apply(catalog); } catch { /* the editor's own failure */ }
  }

  // Several events for one change (a hide broadcasts twice) become one reload.
  let pendingForce = false;
  function schedule(force) {
    if (stopped) return;
    pendingForce = pendingForce || force;
    if (timer != null) clearTimer(timer);
    timer = setTimer(() => { timer = null; const f = pendingForce; pendingForce = false; reload(f); }, delayMs);
  }

  const unsubscribe = subscribe(() => schedule(true));
  const onVisible = () => { if (doc?.visibilityState !== 'hidden') schedule(false); };
  doc?.addEventListener?.('visibilitychange', onVisible);

  return {
    seed(catalog) { last = catalogSignature(catalog); },
    stop() {
      stopped = true;
      if (timer != null) clearTimer(timer);
      timer = null;
      try { unsubscribe?.(); } catch { /* ignore */ }
      doc?.removeEventListener?.('visibilitychange', onVisible);
    },
  };
}
