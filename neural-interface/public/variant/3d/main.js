// ═══════════════════════════════════════════
// SynaBun Neural Interface — 3D Variant Entry Point (Memory Map)
// ═══════════════════════════════════════════
//
// What the first frame needs and nothing else: the variant, the translations, the shared HTML and the loading
// overlay (about twenty modules). The rest of the app (app.js: the map, the shared UI, the side panels' facades,
// boot) is imported right after, while the overlay shows; it used to load all of it, about four hundred modules,
// before the first frame. The map paints as soon as /api/map arrives; the full memory list (sidebar, explorer,
// cards, tooltips) hydrates right behind it.

// ── Storage (self-hydrating — importing it populates the cache) ──
import { storage, isShowcaseMode } from '../../shared/storage.js';

// ── Shared foundation ──
import { registerVariant } from '../../shared/registry.js';
import { injectSharedHTML } from '../../shared/html-shell.js';
import { migrateViewPreferences, normalizeViewUrl } from '../../shared/view-variant.js';
import { initI18n, t } from '../../shared/i18n.js';
import { fetchHealth } from '../../shared/api.js';
import { initLoading, showLoadingError } from '../../shared/ui-loading.js';
import { loadMemoryList } from '../../shared/memory-list.js';

// ═══════════════════════════════════════════
// 1. REGISTER VARIANT
// ═══════════════════════════════════════════

// storage.js has hydrated before this runs. Rewrite legacy choices once, before any UI is built.
let localPreferences;
try { if (storage.persists !== false) localPreferences = window.localStorage; } catch {}
registerVariant({ variant: migrateViewPreferences(storage, localPreferences), capabilities: ['memory-map'] });
const canonicalUrl = normalizeViewUrl(window.location.href);
if (canonicalUrl !== window.location.pathname + window.location.search + window.location.hash) {
  window.history.replaceState(window.history.state, '', canonicalUrl);
}


// ═══════════════════════════════════════════
// 2. TRANSLATIONS, SHARED HTML (the help section is app.js's)
// ═══════════════════════════════════════════

// Showcase mode (?showcase): the user's own content is blurred for product captures,
// before anything is drawn. Without it window.__synabunShowcase is missing and a capture stops.
if (isShowcaseMode()) {
  try {
    (await import('../../shared/showcase-privacy.js')).installShowcasePrivacy();
  } catch (err) {
    console.warn('[showcase] privacy blur unavailable:', err);
  }
}
await initI18n();
injectSharedHTML();

// ═══════════════════════════════════════════
// 3. THE LOADING OVERLAY, THEN THE APP
// ═══════════════════════════════════════════

// The first frame in index.html owns the bounded retry for a failed module graph.
let app = null;
let moduleFailed = false;
const retryModule = () => window.dispatchEvent(new Event('synabun:startup-module-failed'));
initLoading({ onInit: () => {
  if (app) app.boot();
  else if (moduleFailed) retryModule();
  // While the import is pending, app.js will run its own first boot.
} });

import('./app.js').then((module) => { app = module; }, async (err) => {
  moduleFailed = true;
  console.error('Init error:', err);
  const health = await fetchHealth().catch(() => null);
  if (health?.ok === true && !health.restarting) { retryModule(); return; }
  showLoadingError(t('loading.serverOffline'), t('loading.serverNotRunning'), false, true);
});

// The memory list: index.html asked for its first page; the others are read now, one page at a time, while the app
// loads (shared/memory-list.js). boot() takes the whole list from here, in the shape the single answer had.
const prefetch = window.__synPrefetch || (window.__synPrefetch = {});
prefetch.memories = loadMemoryList({ first: prefetch.memories || null });
