// ═══════════════════════════════════════════
// SynaBun Neural Interface — 3D Variant: the app behind the loading overlay
// ═══════════════════════════════════════════
//
// main.js paints the loading overlay from about twenty modules, then imports this file. Everything here used to be
// in main.js and runs in the same order: the help section, the map, the event bus, the shared UI's init functions
// (initLoading excepted, which main.js ran first, as before) and boot(). The overlay hides only when boot() says so,
// so the page the user first sees is the same page.
//
// The side panels (sidepanel-lazy.js) and the Settings window (ui-settings-entry.js) are not imported here: their
// facades load them on first use or in idle time after the page is shown.

// ── Storage (self-hydrating — importing it populates the cache) ──
import { storage } from '../../shared/storage.js';
import { posStore } from '../../shared/node-positions-store.js';

// ── Shared foundation ──
import { state, emit, on } from '../../shared/state.js';
import { registerHelpSection } from '../../shared/registry.js';
import { normalizeNodes } from '../../shared/utils.js';
import { loadMemoryList } from '../../shared/memory-list.js';
import { FOCUS_BOARD_WAIT_MS, mapToggleAction, settleWithin } from './boot-reveal.js';
import { KEYS } from '../../shared/constants.js';
import { t } from '../../shared/i18n.js';

// ── Shared UI modules (side-effect: each registers its own event listeners) ──
import { initTooltip } from '../../shared/ui-tooltip.js';
import { initPanelSystem, initPinToggle, clampPanelsToViewport } from '../../shared/ui-panels.js';
import { showLoadingError, hideLoading, rememberHealth } from '../../shared/ui-loading.js';
import { initNavbar } from '../../shared/ui-navbar.js';
import { initMenubar, closeMenubar } from '../../shared/ui-menubar.js';
import { initSearch, clearSearch } from '../../shared/ui-search.js';
import { buildCategorySidebar, initSidebar, loadCategories } from '../../shared/ui-sidebar.js';
import { openMemoryCard, restoreOpenCards, initDetailPanel, setDetailCallbacks } from '../../shared/ui-detail.js';
import { initSettings } from '../../shared/ui-settings-entry.js';
import { restoreInterfaceConfig, restoreSkin, loadIfaceConfig } from '../../shared/iface-config.js';
import { initTrash } from '../../shared/ui-trash.js';
import { initBookmarks } from '../../shared/ui-bookmarks.js';
import { initResume } from '../../shared/ui-resume.js';
import { initHelp } from '../../shared/ui-help.js';
import { initMultiSelect, clearMultiSelect } from '../../shared/ui-multiselect.js';
import { updateStats, initStats } from '../../shared/ui-stats.js';
import { initExplorer } from '../../shared/ui-explorer.js';
import { initFileExplorer } from '../../shared/ui-file-explorer.js';
import { initSkillsStudio } from '../../shared/ui-skills.js';
import { initAgentsStudio } from '../../shared/ui-agents.js';
import { initStyleGuide } from '../../shared/ui-styleguide.js';
import { initTerminal } from '../../shared/ui-terminal.js';
import { initLink } from '../../shared/ui-link.js';
import { initWhiteboard, whiteboardLoaded } from '../../shared/ui-whiteboard.js';
import { initCostWidget } from '../../shared/ui-cost-widget.js';
import { initGames, clearGameOnLoad } from '../../shared/ui-games.js';
import { initWorkspaces } from '../../shared/ui-workspaces.js';
import { initInvite } from '../../shared/ui-invite.js';
import { initSync, isGuest } from '../../shared/ui-sync.js';
import { startLaunchPrefetch } from '../../shared/launch-prefetch.js';
import { initKeybinds, registerAction } from '../../shared/ui-keybinds.js';
import { initTutorial } from '../../shared/ui-tutorial.js';
import { initImageGallery } from '../../shared/ui-image-gallery.js';
import { initScheduleQueue } from '../../shared/ui-schedule-queue.js';
import { initAutomationStudio } from '../../shared/ui-automation-studio.js';
import { initSchedulesStudio } from '../../shared/ui-schedules-studio.js';
import { initNativeLoopRouter } from '../../shared/ui-native-loop-router.js';
import { initCommandRunner } from '../../shared/ui-command-runner.js';
import { initAppContextMenu, openAppContextMenu, registerContextMenuArea } from '../../shared/ui-context-menu.js';
// The side panels' module-level listeners and their launch steps (sidepanel-lazy.js), before any init runs.
import '../../shared/sidepanel-lazy.js';

// ── Memory map (three.js itself loads only when the map is shown) ──
import { createLabelLayer } from './map-labels.js';
import { createMapView } from './map-view.js';
import { initMapControls } from './map-controls.js';
import { fetchMap, requestRebuild } from './map-data.js';


// ═══════════════════════════════════════════
// 2. HELP (translations and the shared HTML are main.js's)
// ═══════════════════════════════════════════

const helpRow = (keys, desc) =>
  `<div class="help-row"><div class="help-keys">${keys.map((k) => `<span class="help-key">${k}</span>`).join('')}</div><span class="help-desc">${desc}</span></div>`;
registerHelpSection({
  order: 50,
  html: `<div class="help-section">
    <div class="help-section-title">${t('map.help.title')}</div>
    ${helpRow(['Drag'], t('map.help.orbit'))}
    ${helpRow(['Right-drag'], t('map.help.pan'))}
    ${helpRow(['Scroll'], t('map.help.zoom'))}
    ${helpRow(['←', '→', '↑', '↓'], t('map.help.keysPan'))}
    ${helpRow(['Shift', '←', '→'], t('map.help.keysOrbit'))}
    ${helpRow(['Click'], t('map.help.open'))}
    ${helpRow(['⌘/Ctrl', 'Click'], t('map.help.multi'))}
    ${helpRow(['Click name'], t('map.help.flyTo'))}
    ${helpRow(['H'], t('map.help.frameAll'))}
    ${helpRow(['Esc'], t('map.help.clear'))}
    <div class="help-row"><span class="help-desc">${t('map.help.legend')}</span></div>
  </div>`,
});


// ═══════════════════════════════════════════
// 3. THE MAP
// ═══════════════════════════════════════════

let renderer = null;
let labels = null;
let view = null;
let mapInit = null;
let _vizEnabled = loadIfaceConfig().visualizationEnabled !== false;
let _inFocusMode = false;
let _bootComplete = false;
// Boot has decided whether it draws the map (from _vizEnabled); a toggle before that is boot's to read.
let _mapDecided = false;
// state.allNodes holds the whole memory list (boot or a reload put it there). Until then it is empty, never a part.
let _memoriesReady = false;
// The /api/map answer index.html asked for, while boot has not used it (a boot in Focus Mode never does).
let _bootMapP = null;
const _seenCategories = new Set();

function statusPill(container) {
  let el = document.getElementById('map-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'map-status';
    container.appendChild(el);
  }
  return el;
}

function showMapMessage(text) {
  const container = document.getElementById('graph-container');
  if (!container) return;
  const el = statusPill(container);
  el.textContent = text;
  el.classList.add('visible', 'error');
}

/** Create renderer, labels, view and input once; three.js is fetched here. */
function ensureMap() {
  if (!mapInit) {
    mapInit = (async () => {
      const container = document.getElementById('graph-container');
      const { createMapRenderer } = await import('./map-renderer.js');
      labels = createLabelLayer(container);
      let v = null;
      renderer = createMapRenderer(container, {
        onFrame: (now) => (v ? v.drawLabels(now) : false),
        onSettle: () => v?.onSettle(),
        onResize: (w, h) => labels.resize(w, h),
        onMorphEnd: () => v?.onMorphEnd(),
      });
      labels.resize(renderer.size.width, renderer.size.height);
      v = createMapView({ renderer, labels, statusEl: statusPill(container), onMissingNodes: (ids) => addMissingMemories(ids) });
      initMapControls({ renderer, view: v, labels, onContextMenu: openMapMenu });
      view = v;
      applyRunState();
      syncMapMenuChecks();
      return v;
    })();
    mapInit.catch((err) => {
      console.error('[map] could not start:', err);
      showMapMessage(t('map.status.noWebgl'));
    });
  }
  return mapInit;
}

/** The map renders only while the visualisation is on and focus mode is off. */
function applyRunState() {
  if (!view) return;
  if (_vizEnabled && !_inFocusMode) view.resume();
  else view.pause();
}


// ═══════════════════════════════════════════
// 4. DATA
// ═══════════════════════════════════════════

const prefetch = window.__synPrefetch || {};

/** What index.html / main.js started for the boot, taken once: a boot the overlay retries asks again. */
function takePrefetch(key) {
  const value = prefetch[key] || null;
  prefetch[key] = null;
  return value;
}

/** A request index.html started before any module loaded (a fetch() promise), taken once. */
function takeEarlyFetch(url) {
  const value = prefetch.early?.[url] || null;
  if (prefetch.early) prefetch.early[url] = null;
  return value;
}

function activateNewCategories(names) {
  for (const name of names) {
    if (_seenCategories.has(name)) continue;
    _seenCategories.add(name);
    state.activeCategories.add(name);
  }
}

// Memories the map already shows but the page has no data for (written through
// MCP, which never broadcasts). A few are fetched one by one; the 23 MB list is
// re-downloaded only when many are missing, and at most once a minute.
const _missingAsked = new Map(); // id → when it was last requested
let _lastFullReload = 0;
async function addMissingMemories(ids) {
  const now = Date.now();
  if (!ids) {
    if (now - _lastFullReload < 60_000) return;
    _lastFullReload = now;
    scheduleReload();
    return;
  }
  const want = ids.filter((id) => now - (_missingAsked.get(id) || 0) > 60_000);
  if (!want.length) return;
  for (const id of want) _missingAsked.set(id, now);
  const fetched = [];
  for (let i = 0; i < want.length; i += 6) {
    const batch = await Promise.all(want.slice(i, i + 6).map((id) =>
      fetch(`/api/memory/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    for (const m of batch) if (m?.id && m.payload) fetched.push({ id: m.id, payload: m.payload });
  }
  const known = new Set(state.allNodes.map((n) => n.id));
  const fresh = normalizeNodes(fetched).filter((n) => !known.has(n.id));
  if (!fresh.length) return;
  state.allNodes = [...fresh, ...state.allNodes]; // the list is newest-first
  const presentCats = new Set(state.allNodes.map((n) => n.payload.category));
  activateNewCategories([...presentCats]);
  buildCategorySidebar(presentCats);
  view?.hydrate();
  view?.refreshVisibility();
  updateStats();
}

let _reloadTimer = null;
let _reloading = null;
function scheduleReload() {
  if (_reloadTimer) return;
  _reloadTimer = setTimeout(() => { _reloadTimer = null; reloadMemories(); }, 300);
}

/** Refetch the memory list (slim payload) and the map (304 when unchanged). */
async function reloadMemories() {
  if (_reloading) return _reloading;
  _reloading = (async () => {
    try {
      const data = await loadMemoryList({ concurrency: 2 });
      if (data?.error) throw data.error;
      state.allNodes = normalizeNodes(data.nodes);
      state.allLinks = data.links || [];
      _memoriesReady = true;
      await loadCategories();
      const presentCats = new Set(state.allNodes.map((n) => n.payload.category));
      activateNewCategories([...presentCats, ...state.allCategoryNames]);
      buildCategorySidebar(presentCats);
      view?.hydrate();
      view?.refreshColors();
      view?.refreshVisibility();
      view?.refetch();
      updateStats();
    } catch (err) {
      console.error('data:reload failed:', err);
    } finally {
      _reloading = null;
    }
  })();
  return _reloading;
}

/** Old 3D renderer state that nothing reads any more. Idempotent. */
function dropLegacy3dState() {
  try {
    posStore.removeItem(KEYS.NODE_POS_3D);
    for (const key of ['neural-gfx-config', 'neural-gfx-preset', 'neural-cam-hud-pinned', 'neural-cam-hud-pos', 'synabun-layout-version']) {
      storage.removeItem(key);
    }
  } catch {}
}


// ═══════════════════════════════════════════
// 5. EVENT BUS
// ═══════════════════════════════════════════

on('graph:navigate', ({ node }) => { if (node) view?.select(node.id, { fly: true }); });

on('node-selected', (node) => {
  if (!node) return;
  view?.select(node.id, { fly: true });
  openMemoryCard(node);
});

on('search:apply', ({ ids, results } = {}) => view?.applySearch(ids, results));
on('search:clear', () => view?.clearSearch());

// A category toggle emits links:dirty immediately and graph:refresh 600 ms later.
on('links:dirty', () => view?.refreshVisibility());
on('graph:refresh', () => { view?.refreshVisibility(); updateStats(); });

const onCategoriesChanged = () => { view?.refreshColors(); view?.refreshVisibility(); };
on('categories-changed', onCategoriesChanged);
on('categories:changed', onCategoriesChanged);
on('graph:nodeThreeObject', () => view?.refreshColors()); // a category colour changed

on('data:reload', () => scheduleReload());
on('graph:reload', () => scheduleReload());

on('multiselect:cleared', () => view?.refreshVisibility());
on('detail:opened', () => view?.syncSelectionFromState());
on('detail:closed', () => view?.syncSelectionFromState());

on('layout:reset', () => view?.frameAll());
on('sync:map:updated', (msg) => view?.onServerUpdate(msg));

on('workspace:get-scene', (callback) => callback(view ? view.getScene() : { nodePositions: {}, camera: null }));
on('workspace:restore-scene', (scene) => view?.restoreScene(scene));

// Visualisation off / focus mode (whiteboard): zero frames, no input.
on('viz:toggle', (enabled) => {
  _vizEnabled = !!enabled;
  const action = mapToggleAction({ decided: _mapDecided, enabled: _vizEnabled, hasMap: !!mapInit });
  if (action === 'start') startMapAfterBoot();
  else if (action === 'apply') applyRunState();
});

/**
 * The map, switched on after a boot in Focus Mode: the overlay is gone and the memory list may still be on its way.
 * The map draws from /api/map alone; its titles, tooltips and the stats' visible flags come from the list, and
 * only from the whole list: `hydrate` before it arrived would take every memory on the map for a removed one.
 */
function startMapAfterBoot() {
  ensureMap().then(async (v) => {
    // index.html's answer while boot is still reading the list (it is seconds old at most), else a fresh one.
    const early = _bootComplete ? null : _bootMapP;
    _bootMapP = null;
    let json = early ? await Promise.resolve(early).catch(() => null) : null;
    if (!json) json = await fetchMap().catch(() => null);
    if (!json) return;
    if (!_memoriesReady) {
      // As boot does when the map comes before the list: every category on, so no island starts hidden.
      state.activeCategories = new Set([...state.allCategoryNames, ...(json.islands || []).map((i) => i.name)]);
    }
    v.applyMap(json, { morph: false });
    if (_memoriesReady) v.hydrate();
    v.refreshVisibility();
    v.frameAll(0);
  }).catch(() => {});
}
on('focus:enter', () => {
  _inFocusMode = true;
  state.hoveredNodeId = null;
  applyRunState();
});
on('focus:exit', () => {
  _inFocusMode = false;
  applyRunState();
});


// ═══════════════════════════════════════════
// 6. DETAIL CARD CALLBACKS (the names ui-detail.js calls)
// ═══════════════════════════════════════════

setDetailCallbacks({
  applyGraphData: () => {
    view?.hydrate();
    view?.syncFocusFromState();
    view?.refreshVisibility();
  },
  updateStats: () => updateStats(),
  buildCategorySidebar: (cats) => buildCategorySidebar(cats),
  clearMultiSelect: () => clearMultiSelect(),
  fetchTrashItems: () => emit('trash:refresh'),
  refreshNodeAppearance: () => { view?.refreshColors(); view?.refreshVisibility(); },
});


// ═══════════════════════════════════════════
// 7. MAP MENU + KEYS
// ═══════════════════════════════════════════

const MAP_TOGGLES = { 'menu-map-neighbors': 'neighbors', 'menu-map-recency': 'recency', 'menu-map-grid': 'grid' };

function syncMapMenuChecks() {
  const opts = view?.options;
  if (!opts) return;
  for (const [id, key] of Object.entries(MAP_TOGGLES)) document.getElementById(id)?.classList.toggle('active', !!opts[key]);
}

function wireMapMenu() {
  const click = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => { closeMenubar(); fn(el); });
    return el;
  };
  click('menu-map-frame-all', () => view?.frameAll());
  for (const [id, key] of Object.entries(MAP_TOGGLES)) {
    click(id, () => { if (!view) return; view.setOption(key, !view.options[key]); syncMapMenuChecks(); });
  }
  const rebuild = click('menu-map-rebuild', () => {
    requestRebuild().catch((err) => console.warn('[map] rebuild failed:', err?.message || err));
  });
  const syncGuest = () => { if (rebuild) rebuild.style.display = isGuest() ? 'none' : ''; };
  syncGuest();
  on('session:info', syncGuest);
}

registerAction('map-frame-all', () => view?.frameAll());


// ═══════════════════════════════════════════
// 8. CONTEXT MENU (shared/ui-context-menu.js)
// ═══════════════════════════════════════════
// A right-click (no drag) on the map opens the app's menu with the map's part on top: a memory, a name on the
// map, or its empty space. The same functions as the map's clicks and Apps › Map.

const mapActions = {
  frameAll: () => view?.frameAll(),
  toggleOption: (key) => { if (!view) return; view.setOption(key, !view.options[key]); syncMapMenuChecks(); },
  toggleSelect: (id) => view?.toggleMulti(id),
  flyToIsland: (name) => view?.flyToIsland(name),
  clearSearch: () => clearSearch(),
  clearSelection: () => view?.clearSelection(),
};

/** The map's part of the menu for what a press resolved to (map-controls.js resolve), null before the map exists. */
function mapMenuArea(hit) {
  if (!view?.map) return null;
  if (hit && hit.i >= 0) {
    const d = view.describe(hit.i);
    if (d) {
      const island = view.map.islands[view.map.islandOf[hit.i]]?.name || d.category;
      return {
        kind: 'memory',
        memory: { id: d.id, onMap: true, island, selected: state.multiSelected.has(d.id) },
        act: { ...mapActions, openMemory: () => view.clickPoint(hit.i) },
      };
    }
  }
  const label = hit?.label && hit.label.type !== 'memory' ? hit.label : null;
  return {
    kind: 'map',
    map: { options: view.options, searching: view.searching, selected: !!view.selectedId, label, variant: '3d' },
    act: { ...mapActions, flyToLabel: () => label && view.clickLabel(label) },
  };
}

function openMapMenu({ clientX, clientY, hit }) {
  openAppContextMenu({ x: clientX, y: clientY, target: renderer?.canvas || null, area: mapMenuArea(hit),
    returnFocus: renderer?.canvas || null });
}

// From the keyboard (ContextMenu key, Shift+F10) on the focused map: the selected memory, else the map.
registerContextMenuArea({
  id: 'memory-map',
  match(el) {
    if (!renderer || el !== renderer.canvas) return null;
    const i = view?.selectedId ? view.map?.indexOf.get(view.selectedId) : undefined;
    return mapMenuArea(i === undefined ? null : { i, label: null });
  },
});


// ═══════════════════════════════════════════
// 9. BOOT
// ═══════════════════════════════════════════

export async function boot() {
  try {
    restoreInterfaceConfig();
    restoreSkin();
    dropLegacy3dState();

    try {
      const healthRes = await (takeEarlyFetch('/api/health') || fetch('/api/health'));
      const health = await healthRes.json();
      rememberHealth(health);
      if (!health.ok) {
        const messages = {
          db_missing:         [t('loading.health.databaseUnreachable.title'), health.detail || t('loading.health.databaseUnreachable.sub')],
          db_error:           [t('loading.health.databaseUnreachable.title'), health.detail || t('loading.health.databaseUnreachable.sub')],
          remote_unreachable: [t('loading.health.remoteUnreachable.title'), health.detail || t('loading.health.remoteUnreachable.sub')],
          auth_error:         [t('loading.health.authError.title'), health.detail || t('loading.health.authError.sub')],
        };
        const [title, sub] = messages[health.reason] || [t('loading.health.connectionError.title'), health.detail || t('loading.health.connectionError.sub')];
        showLoadingError(title, sub, !!health.canAutoStart);
        return;
      }
      // The memory database is being upgraded: what the page fetched before this answer is a 503, and is read again.
      // Loaded only then: the normal start carries no extra module.
      if (health.store) {
        const { holdForMemoryStore } = await import('../../shared/memory-store-wait.js');
        if (await holdForMemoryStore(health, { fetchHealth: () => fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()), t, showLoadingError })) {
          takePrefetch('memories');
          takePrefetch('map');
        }
      }
    } catch {
      // /api/health failed — continue to try the data
    }

    // The whole memory list, read page by page since main.js ran (shared/memory-list.js); never rejects.
    const memoriesP = takePrefetch('memories') || loadMemoryList({ concurrency: 2 });
    const mapP = takePrefetch('map') || fetchMap().catch(() => null);

    // Categories first, so the first frame already has the sidebar's colours.
    await loadCategories();

    // From here a switch of the visualisation is the map's own business (viz:toggle), not boot's.
    _mapDecided = true;
    _bootMapP = _vizEnabled ? null : mapP;
    if (_vizEnabled) {
      try {
        const [v, mapJson] = await Promise.all([ensureMap(), mapP]);
        if (mapJson) {
          state.activeCategories = new Set([...state.allCategoryNames, ...mapJson.islands.map((i) => i.name)]);
          v.applyMap(mapJson, { morph: false });
          v.frameAll(0);
          hideLoading(150); // the map is up; the rest fills in behind it
        } else {
          showMapMessage(t('map.status.error'));
        }
      } catch {
        // ensureMap already reported it; the rest of the app still works
      }
    } else {
      // Focus Mode: the first view is the whiteboard (static background, saved board), and nothing shown there reads
      // the memory list. The page shows once the board is drawn; the list fills in behind it, as it does behind the map.
      await settleWithin(whiteboardLoaded(), FOCUS_BOARD_WAIT_MS);
      hideLoading(150);
    }

    const data = await memoriesP;
    if (data?.error) throw data.error;
    try { performance.mark('synabun:memories-ready'); } catch {}
    state.allNodes = normalizeNodes(data.nodes);
    state.allLinks = data.links || [];
    _memoriesReady = true;
    _bootMapP = null;
    const presentCats = new Set(state.allNodes.map((n) => n.payload.category));
    state.activeCategories = new Set([...presentCats, ...state.allCategoryNames]);
    for (const name of state.activeCategories) _seenCategories.add(name);
    buildCategorySidebar(presentCats);
    view?.hydrate();
    view?.refreshVisibility();
    updateStats();

    emit('data-loaded', data);
    restoreOpenCards();

    // Recover a selected memory handed over by a legacy 2D tab
    const switchNodeId = sessionStorage.getItem('neural-selected-node-switch');
    if (switchNodeId) {
      sessionStorage.removeItem('neural-selected-node-switch');
      const node = state.allNodes.find((n) => n.id === switchNodeId);
      if (node) {
        openMemoryCard(node);
        view?.select(node.id, { fly: true });
      }
    }

    try { emit('trash:refresh'); } catch {}
    hideLoading(400);
    _bootComplete = true;
    window.dispatchEvent(new Event('synabun:boot-complete'));
    // Painted: what the windows, menus and Settings wait for is read now, in idle time (launch-prefetch.js).
    startLaunchPrefetch({ isGuest });
  } catch (err) {
    console.error('Init error:', err);
    const isNetworkError = err.message === 'Failed to fetch' || err.name === 'TypeError';
    showLoadingError(
      isNetworkError ? t('loading.serverOffline') : t('loading.connectionFailed'),
      isNetworkError ? t('loading.serverNotRunning') : err.message,
      false,
      isNetworkError,
    );
  }
}


// ═══════════════════════════════════════════
// 10. INIT ALL SHARED UI SYSTEMS
// ═══════════════════════════════════════════

initKeybinds();
initTooltip();
initPanelSystem();
initPinToggle();
initNavbar();
initMenubar();
initSearch();
initSidebar();
initDetailPanel();
initSettings();
initTrash();
initBookmarks();
initResume();
initWorkspaces();
initInvite();
initSync();
initHelp();
initMultiSelect();
initStats();
initExplorer();
initFileExplorer();
initSkillsStudio();
initAgentsStudio();
initStyleGuide();
initAutomationStudio();
initSchedulesStudio();
initNativeLoopRouter();
initImageGallery();
initScheduleQueue();
initCommandRunner();
initTerminal();
initLink();
clearGameOnLoad();
initWhiteboard();
initCostWidget();
initGames();
initTutorial();
initAppContextMenu();
wireMapMenu();

window.addEventListener('resize', () => clampPanelsToViewport());

boot();
