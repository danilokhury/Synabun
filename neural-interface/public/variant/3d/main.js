// ═══════════════════════════════════════════
// SynaBun Neural Interface — 3D Variant Entry Point
// ═══════════════════════════════════════════
//
// Registers the 3D variant, imports all shared & variant modules,
// wires event listeners, and boots the application.

// ── Storage (self-hydrating — importing it populates the cache) ──
import { storage } from '../../shared/storage.js';

// ── Shared foundation ──
import { state, emit, on } from '../../shared/state.js';
import { registerVariant, registerMenuItem, registerHelpSection } from '../../shared/registry.js';
import { fetchMemories } from '../../shared/api.js';
import { normalizeNodes } from '../../shared/utils.js';
import { injectSharedHTML } from '../../shared/html-shell.js';
import { KEYS } from '../../shared/constants.js';
import { initI18n, t } from '../../shared/i18n.js';

// ── Shared UI modules (side-effect: each registers its own event listeners) ──
import { initTooltip } from '../../shared/ui-tooltip.js';
import { initPanelSystem, initPinToggle, clampPanelsToViewport } from '../../shared/ui-panels.js';
import { initLoading, showLoadingError, hideLoading } from '../../shared/ui-loading.js';
import { initNavbar } from '../../shared/ui-navbar.js';
import { initMenubar } from '../../shared/ui-menubar.js';
import { initSearch } from '../../shared/ui-search.js';
import { buildCategorySidebar, initSidebar, preloadCategoryLogos, loadCategories } from '../../shared/ui-sidebar.js';
import { openMemoryCard, restoreOpenCards, initDetailPanel, setDetailCallbacks } from '../../shared/ui-detail.js';
import { initSettings, restoreInterfaceConfig, restoreSkin, loadIfaceConfig } from '../../shared/ui-settings.js';
import { initTrash } from '../../shared/ui-trash.js';
import { initBookmarks } from '../../shared/ui-bookmarks.js';
import { initResume } from '../../shared/ui-resume.js';
import { initLayouts, registerBuiltinPresets } from '../../shared/ui-layouts.js';
import { initHelp } from '../../shared/ui-help.js';
import { initMultiSelect } from '../../shared/ui-multiselect.js';
import { updateStats, initStats } from '../../shared/ui-stats.js';
import { initExplorer } from '../../shared/ui-explorer.js';
import { initFileExplorer } from '../../shared/ui-file-explorer.js';
import { initSkillsStudio } from '../../shared/ui-skills.js';
import { initTerminal } from '../../shared/ui-terminal.js';
import { initLink } from '../../shared/ui-link.js';
import { initWhiteboard } from '../../shared/ui-whiteboard.js';
import { initGames, clearGameOnLoad } from '../../shared/ui-games.js';
import { initWorkspaces } from '../../shared/ui-workspaces.js';
import { initInvite } from '../../shared/ui-invite.js';
import { initSync } from '../../shared/ui-sync.js';
import { initKeybinds } from '../../shared/ui-keybinds.js';
import { initTutorial } from '../../shared/ui-tutorial.js';

// ── 3D variant modules ──
import { gfx } from './gfx.js';
import { setGraphicsHooks } from './settings-gfx.js';
import { initAutomationStudio } from '../../shared/ui-automation-studio.js';
import { initCommandRunner } from '../../shared/ui-command-runner.js';
import { initCamera, updateCameraMovement, animateCameraToNode, frameCameraToExtent, saveCameraState, restoreCameraState } from './camera.js';
import { applyFloorStyle, applyBgTheme, animateBackground } from './background.js';
import {
  initGraph, getGraph, getBloomPass, applyGraphData,
  preloadCategoryLogos as preloadGraphLogos,
  applyLinkVisibility, setLinkMode, setLinkTypeFilter,
  navigateToNode, scheduleGraphRemoval, cancelScheduledRemoval,
  saveNodePositions, clearSavedPositions, resetLayout,
  setBloomParams, setBloomEnabled, stopAnimation, startAnimation,
} from './graph.js';


// ═══════════════════════════════════════════
// 1. REGISTER VARIANT
// ═══════════════════════════════════════════

registerVariant({
  variant: '3d',
  capabilities: ['camera-hud', 'controls-panel', 'bloom', 'floor-effects', 'background-theme'],
});


// ═══════════════════════════════════════════
// 2. REGISTER VARIANT-SPECIFIC MENU ITEMS
// ═══════════════════════════════════════════

registerMenuItem({
  menu: 'view',
  order: 25,
  type: 'toggle',
  id: 'menu-3d-controls',
  label: '3D Controls',
  init: (el) => {
    el.addEventListener('click', () => {
      const panel = document.getElementById('controls-panel');
      if (panel) panel.classList.toggle('visible');
      el.classList.toggle('active', panel?.classList.contains('visible'));
    });
  },
});


// ═══════════════════════════════════════════
// 3. REGISTER VARIANT HELP SECTION
// ═══════════════════════════════════════════

registerHelpSection({
  order: 50,
  html: `<div class="help-section">
    <div class="help-section-title">3D Navigation</div>
    <div class="help-row"><div class="help-keys"><span class="help-key">W</span><span class="help-key">A</span><span class="help-key">S</span><span class="help-key">D</span></div><span class="help-desc">Move camera</span></div>
    <div class="help-row"><div class="help-keys"><span class="help-key">Q</span><span class="help-key">E</span></div><span class="help-desc">Move camera down / up</span></div>
    <div class="help-row"><div class="help-keys"><span class="help-key">Shift</span></div><span class="help-desc">Boost speed (hold)</span></div>
    <div class="help-row"><div class="help-keys"><span class="help-key">Mouse</span><span class="help-key">+</span><span class="help-key">W</span></div><span class="help-desc">Fly towards look direction</span></div>
    <div class="help-row"><div class="help-keys"><span class="help-key">Drag</span></div><span class="help-desc">Orbit camera</span></div>
    <div class="help-row"><div class="help-keys"><span class="help-key">Scroll</span></div><span class="help-desc">Zoom in / out</span></div>
  </div>`,
});


// ═══════════════════════════════════════════
// 4. LOAD TRANSLATIONS & INJECT SHARED HTML
// ═══════════════════════════════════════════

await initI18n();
injectSharedHTML();

// Provide hooks to the 3D graphics settings tab
setGraphicsHooks({
  applyBgTheme: (theme) => {
    const g = getGraph();
    const bloom = getBloomPass();
    if (g) applyBgTheme(g, bloom);
  },
  applyFloorStyle: (style) => {
    const g = getGraph();
    if (g) applyFloorStyle(style, g);
  },
  getGraph,
  setBloomEnabled,
});


// ═══════════════════════════════════════════
// 5. WIRE EVENT BUS — connect shared events to variant actions
// ═══════════════════════════════════════════

// When shared UI emits graph:navigate, move camera to node
on('graph:navigate', ({ node, zoom }) => {
  if (node) navigateToNode(node, { zoom });
});

// When shared UI requests data reload (e.g. after OpenClaw bridge sync)
on('data:reload', async () => {
  try {
    const needLinks = state.linkMode !== 'off';
    const res = await fetch(`/api/memories${needLinks ? '' : '?links=false'}`);
    if (!res.ok) return;
    const data = await res.json();
    state.allNodes = normalizeNodes(data.nodes);
    state.allLinks = data.links;

    await loadCategories();
    // Preload logos into graph module's own map (sidebar has a separate one)
    const _logoCats = Object.entries(state.categoryMetadata)
      .filter(([, m]) => m.logo)
      .map(([name, m]) => ({ name, logo: m.logo }));
    preloadGraphLogos(_logoCats);

    const presentCats = new Set(state.allNodes.map(n => n.payload.category));
    state.activeCategories = new Set([...presentCats, ...state.allCategoryNames]);

    buildCategorySidebar(presentCats);
    applyGraphData();
    updateStats();
  } catch (err) {
    console.error('data:reload failed:', err);
  }
});

// When categories change, rebuild sidebar and refresh graph
on('categories-changed', () => {
  // Re-preload logos in case a category logo was added/changed
  const _lc = Object.entries(state.categoryMetadata)
    .filter(([, m]) => m.logo)
    .map(([name, m]) => ({ name, logo: m.logo }));
  preloadGraphLogos(_lc);
  applyGraphData();
});

// When search applies, refresh graph to show/hide nodes
on('search:apply', () => {
  applyGraphData();
});

on('search:clear', () => {
  applyGraphData();
});

// Link mode changes
on('link-mode-changed', (mode) => {
  setLinkMode(mode);
});

on('link-type-changed', (filter) => {
  setLinkTypeFilter(filter);
});

// Node selection — zoom camera + open detail card
on('node-selected', (node) => {
  if (node) {
    animateCameraToNode(node, { zoom: 'close' });
    openMemoryCard(node);
  }
});

// Graph refresh request (from settings sliders, etc.)
on('graph:refresh', () => {
  applyGraphData();
});

// Per-frame WASD camera movement
on('camera-tick', () => {
  updateCameraMovement();
});

// Animation tick — update background animations
on('animate-tick', ({ time, graph: g }) => {
  animateBackground(time, g);
});

// When a category is removed and its nodes should disappear
on('category:schedule-removal', () => {
  scheduleGraphRemoval();
});

on('category:cancel-removal', () => {
  cancelScheduledRemoval();
});

// Layout commands
on('layout:reset', () => {
  clearSavedPositions();
  resetLayout();
});

on('layout:frame', (nodes) => {
  frameCameraToExtent(nodes || state.allNodes);
});

// Stats update
on('stats-changed', () => {
  updateStats();
});


// ═══════════════════════════════════════════
// 6. DETAIL PANEL CALLBACKS
// ═══════════════════════════════════════════

setDetailCallbacks({
  navigateToNode: (node) => navigateToNode(node, { zoom: 'close' }),
  refreshGraph: () => applyGraphData(),
  scheduleRemoval: () => scheduleGraphRemoval(),
  cancelRemoval: () => cancelScheduledRemoval(),
});


// ═══════════════════════════════════════════
// 7. BOOT SEQUENCE
// ═══════════════════════════════════════════

async function boot() {
  try {
    // Restore interface customization + active skin before anything renders
    restoreInterfaceConfig();
    restoreSkin();

    // Pre-flight health check
    try {
      const healthRes = await fetch('/api/health');
      const health = await healthRes.json();
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
    } catch {
      // /api/health failed — continue to try /api/memories
    }

    // Fetch all memories (skip expensive link computation — loaded on demand)
    const res = await fetch('/api/memories?links=false');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.allNodes = normalizeNodes(data.nodes);
    state.allLinks = data.links;

    // Fetch category definitions
    await loadCategories();
    // Preload logos into graph module's own map (sidebar has a separate one)
    const _logoCats = Object.entries(state.categoryMetadata)
      .filter(([, m]) => m.logo)
      .map(([name, m]) => ({ name, logo: m.logo }));
    preloadGraphLogos(_logoCats);

    // Discover all categories present
    const presentCats = new Set(state.allNodes.map(n => n.payload.category));
    state.activeCategories = new Set([...presentCats, ...state.allCategoryNames]);

    // Build category sidebar
    buildCategorySidebar(presentCats);

    // Init the 3D graph (skip if visualization is disabled or already init'd by viz:toggle)
    const container = document.getElementById('graph-container');
    const vizEnabled = loadIfaceConfig().visualizationEnabled !== false;

    if (vizEnabled && !getGraph()) {
      initGraph(container, {
        onApplyBgTheme: (theme) => {
          const g = getGraph();
          const bloom = getBloomPass();
          if (g) applyBgTheme(g, bloom);
        },
      });

      // Init camera controls
      const g = getGraph();
      if (g) initCamera(g);

      // Apply floor style from saved config
      if (g) applyFloorStyle(gfx.floorStyle || 'grid', g);
    }

    // Update stats
    updateStats();

    // Notify shared modules that data is ready
    emit('data-loaded', data);

    // Restore previously open memory cards (persisted positions)
    restoreOpenCards();

    // Check for cross-variant node switch
    const switchNodeId = sessionStorage.getItem('neural-selected-node-switch');
    if (switchNodeId) {
      sessionStorage.removeItem('neural-selected-node-switch');
      const switchNode = state.allNodes.find(n => n.id === switchNodeId);
      if (switchNode) {
        state.selectedNodeId = switchNodeId;
        openMemoryCard(switchNode);
        setTimeout(() => navigateToNode(switchNode, { zoom: 'close' }), 500);
      }
    }

    // Fetch trash count
    try { emit('trash:refresh'); } catch {}

    // Fade out loading
    hideLoading(400);

    // Mark boot complete — viz:toggle handler can now respond to user toggles
    _bootComplete = true;

  } catch (err) {
    console.error('Init error:', err);
    const isNetworkError = err.message === 'Failed to fetch' || err.name === 'TypeError';
    showLoadingError(
      isNetworkError ? t('loading.serverOffline') : t('loading.connectionFailed'),
      isNetworkError ? t('loading.serverNotRunning') : err.message,
      false,
      isNetworkError
    );
  }
}


// ═══════════════════════════════════════════
// 8. INIT ALL SHARED UI SYSTEMS
// ═══════════════════════════════════════════

initLoading({ onInit: boot });
initKeybinds();  // async — loads keybinds from server, installs central dispatcher
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
initLayouts();
initWorkspaces();
initInvite();
initSync();
initHelp();
initMultiSelect();
initStats();
initExplorer();
initFileExplorer();
initSkillsStudio();
initAutomationStudio();
initCommandRunner();
initTerminal();
initLink();
clearGameOnLoad();
initWhiteboard();
initGames();
initTutorial();

// View switch handler
{
  const switchBtn = document.querySelector('.view-toggle-btn:not(.active)');
  if (switchBtn) {
    switchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (state.selectedNodeId) sessionStorage.setItem('neural-selected-node-switch', state.selectedNodeId);
      window.location.href = switchBtn.getAttribute('href');
    });
  }
}

// Window resize handler
window.addEventListener('resize', () => {
  clampPanelsToViewport();
});

// Visualization toggle — pause/resume 3D rendering
// Guard: ignore viz:toggle events emitted during boot (from restoreInterfaceConfig).
// Boot handles graph init itself; this handler is only for runtime user toggles.
let _bootComplete = false;
on('viz:toggle', (enabled) => {
  if (!_bootComplete) return;
  if (enabled) {
    if (!getGraph()) {
      // First-time init if graph was never created (was disabled at boot)
      const container = document.getElementById('graph-container');
      initGraph(container, {
        onApplyBgTheme: () => {
          const g = getGraph();
          const bloom = getBloomPass();
          if (g) applyBgTheme(g, bloom);
        },
      });
      const g = getGraph();
      if (g) initCamera(g);
      if (g) applyFloorStyle(gfx.floorStyle || 'grid', g);
      applyGraphData();
    }
    startAnimation();
  } else {
    stopAnimation();
  }
});

// Focus mode isolation — clear 3D-specific interactive state
on('focus:enter', () => {
  state.hoveredNodeId = null;
  document.body.style.cursor = 'default';
});

// Workspace scene snapshot (3D)
on('workspace:get-scene', (callback) => {
  const graph = getGraph();
  if (!graph) return callback({ nodePositions: {}, camera: null });
  const gd = graph.graphData();
  const positions = {};
  for (const n of gd.nodes) {
    if (n.x != null) positions[n.id] = { x: n.x, y: n.y, z: n.z };
  }
  callback({ nodePositions: positions, camera: saveCameraState() });
});

on('workspace:restore-scene', ({ nodePositions, camera }) => {
  if (nodePositions && Object.keys(nodePositions).length > 0) {
    storage.setItem(KEYS.NODE_POS_3D, JSON.stringify(nodePositions));
  }
  if (camera) restoreCameraState(camera, 1500);
  applyGraphData();
});

// Boot
boot();
