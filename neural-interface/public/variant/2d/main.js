// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Variant Entry Point
// ═══════════════════════════════════════════
//
// Registers the 2D variant, imports all shared & variant modules,
// wires event listeners, and boots the application.

// ── Storage (self-hydrating — importing it populates the cache) ──
import { storage } from '../../shared/storage.js';

// ── Shared foundation ──
import { state, emit, on } from '../../shared/state.js';
import { registerVariant, registerMenuItem, registerHelpSection } from '../../shared/registry.js';

import { injectSharedHTML } from '../../shared/html-shell.js';
import { KEYS } from '../../shared/constants.js';
import { normalizeNodes } from '../../shared/utils.js';
import { initI18n, t } from '../../shared/i18n.js';

// ── Shared UI modules (side-effect: each registers its own event listeners) ──
import { initTooltip } from '../../shared/ui-tooltip.js';
import { initPanelSystem, initPinToggle, clampPanelsToViewport } from '../../shared/ui-panels.js';
import { initLoading, showLoadingError, hideLoading } from '../../shared/ui-loading.js';
import { initNavbar } from '../../shared/ui-navbar.js';
import { initMenubar } from '../../shared/ui-menubar.js';
import { initSearch } from '../../shared/ui-search.js';
import { buildCategorySidebar, initSidebar, loadCategories } from '../../shared/ui-sidebar.js';
import { openMemoryCard, restoreOpenCards, initDetailPanel, setDetailCallbacks } from '../../shared/ui-detail.js';
import { initSettings, restoreInterfaceConfig, loadIfaceConfig } from '../../shared/ui-settings.js';
import { initTrash } from '../../shared/ui-trash.js';
import { initBookmarks } from '../../shared/ui-bookmarks.js';
import { initLayouts } from '../../shared/ui-layouts.js';
import { initHelp } from '../../shared/ui-help.js';
import { initMultiSelect } from '../../shared/ui-multiselect.js';
import { updateStats, initStats } from '../../shared/ui-stats.js';
import { initExplorer } from '../../shared/ui-explorer.js';
import { initSkillsStudio } from '../../shared/ui-skills.js';
import { initTerminal } from '../../shared/ui-terminal.js';
import { initWorkspaces } from '../../shared/ui-workspaces.js';
import { initKeybinds, registerAction, getDisplayKey } from '../../shared/ui-keybinds.js';

// ── 2D variant modules ──
import { gfx, saveGfxConfig } from './gfx.js';
import './settings-gfx.js'; // side-effect: self-registers Graphics tab
import { stopBackground } from './background.js';
import { initMinimap, drawMinimap, toggleMinimap, isMinimapVisible, forceHideMinimap, restoreMinimap } from './minimap.js';
import { initLasso } from './lasso.js';
import { initContextMenu, hideContextMenu } from './context-menu.js';
import {
  initGraph, getGraph, applyGraphData,
  preloadCategoryLogos, scheduleGraphRemoval, cancelScheduledRemoval,
  refreshGraph, reheatSimulation, getAllCards,
} from './graph.js';


// ═══════════════════════════════════════════
// 1. REGISTER VARIANT
// ═══════════════════════════════════════════

registerVariant({
  variant: '2d',
  capabilities: ['minimap', 'lasso', 'context-menu', 'orbital-layout'],
});


// ═══════════════════════════════════════════
// 2. REGISTER VARIANT-SPECIFIC MENU ITEMS
// ═══════════════════════════════════════════

registerMenuItem({
  menu: 'view',
  order: 25,
  type: 'toggle',
  id: 'menu-region-glow',
  label: 'Region Glow',
  init: (el) => {
    el.classList.toggle('active', gfx.regionGlowOpacity > 0);
    el.addEventListener('click', () => {
      if (gfx.regionGlowOpacity > 0) {
        gfx.regionGlowOpacity = 0;
      } else {
        gfx.regionGlowOpacity = 0.05;
      }
      saveGfxConfig(gfx);
      el.classList.toggle('active', gfx.regionGlowOpacity > 0);
    });
  },
});

registerMenuItem({
  menu: 'view',
  order: 26,
  type: 'toggle',
  id: 'menu-minimap',
  label: 'Minimap',
  shortcut: 'M',
  init: (el) => {
    // Set initial active state (minimap starts visible)
    el.classList.add('active');

    const doToggle = () => {
      toggleMinimap();
      el.classList.toggle('active', isMinimapVisible());
    };

    el.addEventListener('click', doToggle);

    // Register keybind action so the central dispatcher can trigger it
    registerAction('toggle-minimap', doToggle);
  },
});


// ═══════════════════════════════════════════
// 3. REGISTER VARIANT HELP SECTION
// ═══════════════════════════════════════════

registerHelpSection({
  order: 50,
  html: `
    <h4>2D Canvas Controls</h4>
    <div class="help-key-row"><span class="help-key">Mouse Drag</span> Pan the canvas</div>
    <div class="help-key-row"><span class="help-key">Scroll</span> Zoom in/out</div>
    <div class="help-key-row"><span class="help-key">Click Card</span> Select &amp; open detail</div>
    <div class="help-key-row"><span class="help-key">Click Category</span> Zoom to category</div>
    <div class="help-key-row"><span class="help-key">Double-Click Card</span> Unpin card</div>
    <div class="help-key-row"><span class="help-key">Double-Click BG</span> Zoom to fit all</div>
    <div class="help-key-row"><span class="help-key">Right-Click Card</span> Context menu</div>
    <div class="help-key-row"><span class="help-key">Shift + Drag</span> Lasso select</div>
    <div class="help-key-row"><span class="help-key">Drag Card</span> Move &amp; pin card</div>
    <div class="help-key-row"><span class="help-key">Drag Category</span> Move entire group</div>
  `,
});


// ═══════════════════════════════════════════
// 4. LOAD TRANSLATIONS & INJECT SHARED HTML
// ═══════════════════════════════════════════

await initI18n();
injectSharedHTML();


// ═══════════════════════════════════════════
// 5. WIRE EVENT BUS — connect shared events to variant actions
// ═══════════════════════════════════════════

// When shared UI emits graph:navigate, center on node
on('graph:navigate', ({ node, zoom }) => {
  const g = getGraph();
  if (!node || !g) return;
  const cards = getAllCards();
  const card = cards.find(c => c.node.id === node.id);
  if (card) {
    g.centerAt(card.x, card.y, 500);
    if (zoom === 'close') g.zoom(4, 500);
  }
});

// Data reload (e.g. after OpenClaw bridge sync)
on('data:reload', async () => {
  try {
    await refreshGraph();
    const presentCats = new Set(state.allNodes.map(n => n.payload.category));
    buildCategorySidebar(presentCats);
    updateStats();
  } catch (err) {
    console.error('data:reload failed:', err);
  }
});

// Categories changed
on('categories-changed', () => {
  applyGraphData();
});

// Search apply/clear
on('search:apply', () => {
  // No layout recompute needed — just re-renders with dimming
});

on('search:clear', () => {
  // No layout recompute needed
});

// Link mode changes — just triggers re-render (no API call needed)
on('link-mode-changed', () => {
  // Render loop picks up state.linkMode automatically
});

on('link-type-changed', () => {
  // Render loop picks up state.linkTypeFilter automatically
});

// Node selection — center camera on selected card + open detail card
on('node-selected', (node) => {
  if (!node) return;
  const g = getGraph();
  if (g) {
    const cards = getAllCards();
    const card = cards.find(c => c.node.id === node.id);
    if (card) {
      g.centerAt(card.x, card.y, 500);
    }
  }
  openMemoryCard(node);
});

// Graph refresh
on('graph:refresh', () => {
  applyGraphData();
});

// Category removal scheduling
on('category:schedule-removal', () => {
  scheduleGraphRemoval();
});

on('category:cancel-removal', () => {
  cancelScheduledRemoval();
});

// Layout commands
on('layout:reset', () => {
  reheatSimulation(); // clears saved positions + recomputes layout
});

on('layout:frame', () => {
  const g = getGraph();
  if (g) g.zoomToFit(400, 60);
});

// Stats update
on('stats-changed', () => {
  updateStats();
});

// Context menu hide
on('context-menu-hide', () => {
  hideContextMenu();
});

// Render frame post — draw minimap
on('render-frame-post', () => {
  if (isMinimapVisible()) drawMinimap();
});


// ═══════════════════════════════════════════
// 6. DETAIL PANEL CALLBACKS
// ═══════════════════════════════════════════

setDetailCallbacks({
  navigateToNode: (node) => {
    const g = getGraph();
    if (!g || !node) return;
    const cards = getAllCards();
    const card = cards.find(c => c.node.id === node.id);
    if (card) g.centerAt(card.x, card.y, 500);
  },
  refreshGraph: () => applyGraphData(),
  scheduleRemoval: () => scheduleGraphRemoval(),
  cancelRemoval: () => cancelScheduledRemoval(),
});


// ═══════════════════════════════════════════
// 7. BOOT SEQUENCE
// ═══════════════════════════════════════════

async function boot() {
  try {
    // Restore interface customization before anything renders
    restoreInterfaceConfig();

    // Pre-flight health check
    try {
      const healthRes = await fetch('/api/health');
      const health = await healthRes.json();
      if (!health.ok) {
        const messages = {
          docker_not_running: [t('loading.health.dockerNotRunning.title'), t('loading.health.dockerNotRunning.sub')],
          container_stopped:  [t('loading.health.containerStopped.title'), t('loading.health.containerStopped.sub')],
          qdrant_unreachable: [t('loading.health.qdrantUnreachable.title'), t('loading.health.qdrantUnreachable.sub')],
          remote_unreachable: [t('loading.health.remoteUnreachable.title'), health.detail || t('loading.health.remoteUnreachable.sub')],
          auth_error:         [t('loading.health.authError.title'), health.detail || t('loading.health.authError.sub')],
        };
        const [title, sub] = messages[health.reason] || [t('loading.health.connectionError.title'), health.detail || t('loading.health.connectionError.sub')];
        showLoadingError(title, sub, !!health.canAutoStart);
        return;
      }
    } catch {}

    // Fetch all memories
    const res = await fetch('/api/memories');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.allNodes = normalizeNodes(data.nodes);
    state.allLinks = data.links;

    // Fetch category definitions
    await loadCategories();

    // Discover all categories
    const presentCats = new Set(state.allNodes.map(n => n.payload.category));
    state.activeCategories = new Set([...presentCats, ...state.allCategoryNames]);

    // Build category sidebar
    buildCategorySidebar(presentCats);

    // Init the 2D canvas renderer (skip if visualization is disabled)
    const container = document.getElementById('graph-container');
    const vizEnabled = loadIfaceConfig().visualizationEnabled !== false;
    let g = null;

    if (vizEnabled && !getGraph()) {
      g = initGraph(container, {
        onRenderFramePost: () => {
          if (isMinimapVisible()) drawMinimap();
        },
      });

      // Init overlays
      initMinimap(g);
      initLasso(g);
      initContextMenu(g);
    }

    // Apply data to compute layout and start rendering
    applyGraphData();

    // Update stats
    updateStats();

    // Signal data is ready
    emit('data-loaded', data);

    // Restore previously open memory cards
    restoreOpenCards();

    // Handle view-switch handoff
    const switchNodeId = sessionStorage.getItem('neural-selected-node-switch');
    if (switchNodeId) {
      sessionStorage.removeItem('neural-selected-node-switch');
      const node = state.allNodes.find(n => n.id === switchNodeId);
      if (node) {
        state.selectedNodeId = switchNodeId;
        openMemoryCard(node);
        setTimeout(() => {
          if (g) {
            const cards = getAllCards();
            const card = cards.find(c => c.node.id === switchNodeId);
            if (card) g.centerAt(card.x, card.y, 500);
          }
        }, 600);
      }
    }

    // Fetch trash count
    try { emit('trash:refresh'); } catch {}

    // Fade out loading
    hideLoading(400);

    // Mark boot complete
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
initLayouts();
initWorkspaces();
initHelp();
initMultiSelect();
initStats();
initExplorer();
initSkillsStudio();
initTerminal();

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

// Visualization toggle — pause/resume 2D rendering
let _bootComplete = false;
on('viz:toggle', (enabled) => {
  if (!_bootComplete) return;
  if (enabled) {
    if (!getGraph()) {
      // First-time init if graph was never created (was disabled at boot)
      const container = document.getElementById('graph-container');
      const g = initGraph(container, {
        onRenderFramePost: () => {
          if (isMinimapVisible()) drawMinimap();
        },
      });
      initMinimap(g);
      initLasso(g);
      initContextMenu(g);
      applyGraphData();
    }
    // Show the main canvas (it's position:fixed, not affected by container opacity)
    const mainCanvas = document.getElementById('canvas-main');
    if (mainCanvas) mainCanvas.classList.remove('viz-hidden-2d');
    // Restore minimap to user's preference
    restoreMinimap();
  } else {
    stopBackground();
    // Hide the main canvas when entering focus mode
    const mainCanvas = document.getElementById('canvas-main');
    if (mainCanvas) mainCanvas.classList.add('viz-hidden-2d');
    // Always hide minimap in focus mode
    forceHideMinimap();
  }
});

// Workspace scene snapshot (2D)
on('workspace:get-scene', (callback) => {
  const graph = getGraph();
  if (!graph) return callback({ nodePositions: {}, camera: null });
  const gd = graph.graphData();
  const positions = {};
  for (const n of gd.nodes) {
    if (n.x != null) positions[n.id] = { x: n.x, y: n.y };
  }
  callback({ nodePositions: positions, camera: null });
});

on('workspace:restore-scene', ({ nodePositions }) => {
  if (nodePositions && Object.keys(nodePositions).length > 0) {
    storage.setItem(KEYS.NODE_POS_2D, JSON.stringify(nodePositions));
  }
  applyGraphData();
});

// Boot
boot();
