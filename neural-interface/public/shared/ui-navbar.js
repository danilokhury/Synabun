// ═══════════════════════════════════════════
// SynaBun Neural Interface — Navbar
// Initializes the 2D/3D view toggle, right-side icon buttons, and menubar action buttons.
// Menu items (View, Graph, Bookmarks, Layouts) are handled by ui-menubar.js.
// ═══════════════════════════════════════════

import { state, emit, on } from './state.js';
import { getVariant } from './registry.js';
import { KEYS } from './constants.js';
import { loadIfaceConfig, saveIfaceConfig, applyIfaceConfig } from './ui-settings.js';
import { registerAction } from './ui-keybinds.js';
import { startTutorial } from './ui-tutorial.js';
import { toggleClaudePanel } from './ui-claude-panel.js';
import { toggleSessionMonitor } from './ui-sessions.js';
import { toggleImageGallery } from './ui-image-gallery.js';
import { initUpdate } from './ui-update.js';

const $ = (id) => document.getElementById(id);

export function initNavbar() {
  const variant = getVariant() || '3d';

  // ── View toggle ──
  const nav2d = $('nav-2d-link');
  const nav3d = $('nav-3d-link');

  const activeLink = variant === '3d' ? nav3d : nav2d;
  const inactiveLink = variant === '3d' ? nav2d : nav3d;

  if (activeLink) {
    activeLink.addEventListener('click', (e) => e.preventDefault());
  }
  if (inactiveLink) {
    inactiveLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (state.selectedNodeId) {
        sessionStorage.setItem(KEYS.SELECTED_SWITCH, state.selectedNodeId);
      }
      window.location.href = inactiveLink.getAttribute('href');
    });
  }

  // ── Claude panel toggle (topright workspace toolbar) ──
  const claudePanelBtn = $('topright-claude-panel-btn');
  if (claudePanelBtn) {
    claudePanelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleClaudePanel();
      claudePanelBtn.classList.toggle('active');
    });
    registerAction('toggle-claude-panel', () => claudePanelBtn.click());
  }

  // ── Sidebar close button ──
  const sidebar = $('category-sidebar');
  const sidebarClose = $('sidebar-close');
  if (sidebarClose && sidebar) {
    sidebarClose.addEventListener('click', () => {
      sidebar.style.display = 'none';
      emit('sidebar:closed');
    });
  }

  // ── Settings ──
  // Note: Settings button click is handled by initSettings() in ui-settings.js.
  // Do NOT add a click handler here — it would cause duplicate openSettingsModal() calls.

  // ── Trash ──
  // Note: Trash button click is handled by initTrash() in ui-trash.js.
  // Do NOT add a click handler here — it would conflict with the toggle logic.

  // ── Visualization toggle ──
  const vizBtn = $('titlebar-viz-toggle');
  const searchWrapper = $('search-wrapper');
  if (vizBtn) {
    const cfg = loadIfaceConfig();
    const vizOn = cfg.visualizationEnabled !== false;
    vizBtn.classList.toggle('active', vizOn);
    if (searchWrapper) searchWrapper.classList.toggle('viz-hidden', !vizOn);

    vizBtn.addEventListener('click', () => {
      const cfg = loadIfaceConfig();
      cfg.visualizationEnabled = !cfg.visualizationEnabled;
      applyIfaceConfig(cfg);
      saveIfaceConfig(cfg);
      vizBtn.classList.toggle('active', cfg.visualizationEnabled);
      if (searchWrapper) searchWrapper.classList.toggle('viz-hidden', !cfg.visualizationEnabled);
    });

    on('viz:toggle', (enabled) => {
      vizBtn.classList.toggle('active', enabled);
      if (searchWrapper) searchWrapper.classList.toggle('viz-hidden', !enabled);
    });

    registerAction('toggle-focus-mode', () => vizBtn.click());
  }

  // ── Session monitor toggle ──
  const sessionsBtn = $('titlebar-sessions-btn');
  if (sessionsBtn) {
    sessionsBtn.addEventListener('click', () => {
      toggleSessionMonitor();
      sessionsBtn.classList.toggle('active');
    });
    // Sync button state when window is closed via its own close button or backdrop
    on('session-monitor:closed', () => sessionsBtn.classList.remove('active'));
    registerAction('toggle-session-monitor', () => sessionsBtn.click());
  }

  // ── Image gallery toggle ──
  const galleryBtn = $('titlebar-gallery-btn');
  if (galleryBtn) {
    galleryBtn.addEventListener('click', () => {
      toggleImageGallery();
      galleryBtn.classList.toggle('active');
    });
    on('image-gallery:closed', () => galleryBtn.classList.remove('active'));
    registerAction('toggle-image-gallery', () => galleryBtn.click());
  }

  // ── Cost tracker dock button ──
  const costBtn = $('titlebar-cost-btn');
  if (costBtn) {
    costBtn.addEventListener('click', () => emit('cost:dock-toggle'));
    // Update label when cost changes
    on('cost:updated', (data) => {
      if (!data) return;
      const label = costBtn.querySelector('.bar-cost-label');
      if (label && typeof data.sessionCost === 'number') {
        label.textContent = '$' + data.sessionCost.toFixed(2);
      }
    });
    on('cost:dock-state', (docked) => {
      costBtn.classList.toggle('active', docked);
    });
  }

  // ── Tutorial toggle (?) ──
  const tutBtn = $('titlebar-tutorial-btn');
  if (tutBtn) {
    tutBtn.addEventListener('click', () => startTutorial(true));
  }

  // ── Fullscreen button ──
  const fsBtn = $('titlebar-fullscreen-btn');
  if (fsBtn) {
    const enterIcon = '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    const exitIcon = '<svg viewBox="0 0 24 24"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>';

    function updateFsIcon() {
      const isFs = !!document.fullscreenElement;
      fsBtn.innerHTML = isFs ? exitIcon : enterIcon;
      fsBtn.classList.toggle('active', isFs);
      // Lock height so macOS menu bar overlays instead of pushing content down
      if (isFs) {
        document.body.classList.add('is-fullscreen');
        document.documentElement.style.setProperty('--fs-locked-height', window.screen.height + 'px');
      } else {
        document.body.classList.remove('is-fullscreen');
        document.documentElement.style.removeProperty('--fs-locked-height');
      }
    }

    fsBtn.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await document.documentElement.requestFullscreen();
        }
      } catch (err) {
        console.warn('Fullscreen toggle failed:', err);
      }
    });

    document.addEventListener('fullscreenchange', updateFsIcon);
  }

  // ── Window Controls Overlay (PWA standalone) ──
  // Toggles body.wco-active when the overlay chevron is clicked (traffic lights move into content).
  if ('windowControlsOverlay' in navigator) {
    const wco = navigator.windowControlsOverlay;
    const updateWco = () => document.body.classList.toggle('wco-active', wco.visible);
    updateWco();
    wco.addEventListener('geometrychange', updateWco);
  }

  // ── Clock ──
  const clockEl = $('titlebar-clock');
  if (clockEl) {
    function updateClock() {
      const now = new Date();
      const h = now.getHours().toString().padStart(2, '0');
      const m = now.getMinutes().toString().padStart(2, '0');
      clockEl.textContent = `${h}:${m}`;
    }
    updateClock();
    setInterval(updateClock, 15000);
  }

  // ── Workspace toolbar collapse toggle ──
  const collapseBtn = $('topright-collapse-btn');
  const controls = $('topright-controls');
  if (collapseBtn && controls) {
    // Restore persisted state
    const wasCollapsed = localStorage.getItem('synabun-toolbar-collapsed') === '1';
    if (wasCollapsed) controls.classList.add('collapsed');

    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isCollapsed = controls.classList.toggle('collapsed');
      localStorage.setItem('synabun-toolbar-collapsed', isCollapsed ? '1' : '0');
      // Close any open dropdowns when collapsing
      if (isCollapsed) emit('panel:close-all-dropdowns');
    });

    registerAction('toggle-toolbar', () => collapseBtn.click());
  }

  // ── Update alert ──
  initUpdate();
}
