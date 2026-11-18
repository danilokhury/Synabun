// SynaBun — the interface config (scale, glass, font scale, accent, Focus Mode) and the skin stylesheet.
//
// Moved out of ui-settings.js unchanged: the boot applies both before the Settings window exists (its module, about
// 2 MB with what it imports, loads on first open or in idle time: ui-settings-entry.js). ui-settings.js imports and
// re-exports them. A skin changed in another window is applied here at once; the open Settings window refreshes its
// Skins tab through setSkinsTabRefresher.

import { storage } from './storage.js';
import { state, emit, on } from './state.js';
import { KEYS } from './constants.js';
import { normalizeViewConfig } from './view-variant.js';
import { setStaticBgVisible } from './static-bg-state.js';

// Optional legacy view preferences must never reintroduce a 2D selection.
export const IFACE_DEFAULTS = {
  visualizationEnabled: true,
  scale: 1,
  glassOpacity: 0.72,
  // 16 keeps the glass look at a fraction of the compositing cost — users can
  // still crank the slider to 80 to explicitly opt back into heavier blur
  glassBlur: 16,
  glassSaturate: 1.4,
  glassBorderOpacity: 0.06,
  glassShadowOpacity: 0.4,
  glassShadowSpread: 20,
  glassRadius: 14,
  fontScale: 1,
  accentHue: 0,
  accentSaturation: 0,
  accentLightness: 80,
};

export function loadIfaceConfig() {
  try {
    const raw = storage.getItem('neural-interface-config');
    if (raw) return { ...IFACE_DEFAULTS, ...normalizeViewConfig(JSON.parse(raw)) };
    // Migrate legacy ui-scale if present
    const legacyScale = storage.getItem('neural-ui-scale');
    if (legacyScale) {
      const cfg = { ...IFACE_DEFAULTS, scale: parseFloat(legacyScale) || 1 };
      saveIfaceConfig(cfg);
      return cfg;
    }
    return { ...IFACE_DEFAULTS };
  } catch { return { ...IFACE_DEFAULTS }; }
}

export function saveIfaceConfig(cfg) {
  storage.setItem('neural-interface-config', JSON.stringify(normalizeViewConfig(cfg)));
  // Keep legacy key in sync for backwards compat
  storage.setItem('neural-ui-scale', cfg.scale);
}

export function applyIfaceConfig(cfg, { instant = false } = {}) {
  const r = document.documentElement.style;
  r.setProperty('--ui-scale', cfg.scale);
  r.setProperty('--glass-opacity', cfg.glassOpacity);
  r.setProperty('--glass-blur', cfg.glassBlur);
  r.setProperty('--glass-saturate', cfg.glassSaturate);
  r.setProperty('--glass-border-opacity', cfg.glassBorderOpacity);
  r.setProperty('--glass-shadow-opacity', cfg.glassShadowOpacity);
  r.setProperty('--glass-shadow-spread', cfg.glassShadowSpread);
  r.setProperty('--glass-radius', cfg.glassRadius);
  r.setProperty('--font-scale', cfg.fontScale);
  r.setProperty('--accent-hue', cfg.accentHue);
  r.setProperty('--accent-saturation', cfg.accentSaturation + '%');
  r.setProperty('--accent-lightness', cfg.accentLightness + '%');

  // Focus Mode — scale+blur transition with staggered controls
  const vizEnabled = cfg.visualizationEnabled !== false;
  const graphContainer = document.getElementById('graph-container');
  const staticBg = document.getElementById('static-bg');

  if (!vizEnabled) {
    // ENTERING FOCUS MODE

    // ── Clean up all interactive state ──
    // Hide 3D tooltip + detach its mousemove listener
    const $tooltip = document.getElementById('tooltip');
    if ($tooltip) {
      $tooltip.classList.remove('visible');
      if ($tooltip._moveHandler) {
        document.removeEventListener('mousemove', $tooltip._moveHandler);
        $tooltip._moveHandler = null;
      }
    }
    // Hide data-tooltip tooltips
    const uiTip = document.querySelector('.ui-tooltip');
    if (uiTip) {
      uiTip.classList.remove('visible');
      uiTip.style.display = 'none';
    }
    // Clear hover state
    state.hoveredNodeId = null;
    // Clear multi-select
    if (state.multiSelected.size > 0) {
      state.multiSelected.clear();
      const bar = document.getElementById('multi-select-bar');
      if (bar) bar.classList.remove('open');
      emit('multiselect:cleared');
    }
    // Reset cursor
    document.body.style.cursor = 'default';

    // Hide controls, 2D canvases, category sidebar
    for (const id of ['controls-panel', 'stats-bar', 'category-sidebar']) {
      const el = document.getElementById(id);
      if (el) el.classList.add('viz-hidden');
    }
    for (const id of ['bg-canvas', 'hull-canvas', 'lasso-canvas']) {
      const el = document.getElementById(id);
      if (el) el.classList.add('viz-hidden-2d');
    }
    if (instant) {
      // Page load — apply immediately without animation
      if (graphContainer) graphContainer.classList.add('focus-active');
      setStaticBgVisible(staticBg, true);
    } else {
      // User toggle — stagger: controls fade first, then iris closes
      setTimeout(() => {
        if (graphContainer) graphContainer.classList.add('focus-active');
        setStaticBgVisible(staticBg, true);
      }, 100);
    }
    // Notify variant-specific cleanup (lasso, context menu, etc.)
    emit('focus:enter');
  } else {
    // EXITING FOCUS MODE
    // Iris open the graph + close focus bg
    if (graphContainer) graphContainer.classList.remove('focus-active');
    setStaticBgVisible(staticBg, false);
    // 2D canvases
    for (const id of ['bg-canvas', 'hull-canvas', 'lasso-canvas']) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('viz-hidden-2d');
    }
    if (instant) {
      // Page load — show controls immediately
      for (const id of ['controls-panel', 'stats-bar', 'category-sidebar']) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('viz-hidden');
      }
    } else {
      // User toggle — delay controls until iris starts opening
      setTimeout(() => {
        for (const id of ['controls-panel', 'stats-bar', 'category-sidebar']) {
          const el = document.getElementById(id);
          if (el) el.classList.remove('viz-hidden');
        }
      }, 200);
    }
    emit('focus:exit');
  }
  // Notify variants to pause/resume rendering
  emit('viz:toggle', vizEnabled);
}

/** Call on page load to restore saved interface config */
export function restoreInterfaceConfig() {
  // Suppress transitions during initial load to prevent flash
  document.documentElement.classList.add('no-transition');
  applyIfaceConfig(loadIfaceConfig(), { instant: true });
  // Re-enable transitions after a frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('no-transition');
    });
  });
}

// ═══════════════════════════════════════════
// SKIN LOADING — stylesheet injection + boot restore
// ═══════════════════════════════════════════

export const SKIN_LINK_ID = 'synabun-skin-css';

/** Insert or update the skin stylesheet <link> */
export function loadSkinStylesheet(skinId) {
  if (!skinId || skinId === 'default') {
    removeSkinStylesheet();
    return;
  }
  let link = document.getElementById(SKIN_LINK_ID);
  if (!link) {
    link = document.createElement('link');
    link.id = SKIN_LINK_ID;
    link.rel = 'stylesheet';
    // Insert after the main styles.css
    const mainCSS = document.querySelector('link[href*="styles.css"]');
    if (mainCSS && mainCSS.nextSibling) {
      mainCSS.parentNode.insertBefore(link, mainCSS.nextSibling);
    } else {
      document.head.appendChild(link);
    }
  }
  link.href = `/skins/${skinId}/skin.css`;
  storage.setItem(KEYS.ACTIVE_SKIN, skinId);
}

/** Remove the skin stylesheet */
export function removeSkinStylesheet() {
  const link = document.getElementById(SKIN_LINK_ID);
  if (link) link.remove();
  storage.setItem(KEYS.ACTIVE_SKIN, 'default');
}

/** Restore active skin on page load. Export for variant main.js to call. */
export function restoreSkin() {
  const skinId = storage.getItem(KEYS.ACTIVE_SKIN) || 'default';
  if (skinId && skinId !== 'default') {
    loadSkinStylesheet(skinId);
  }
}

/** The open Settings window's Skins tab, redrawn when another window changes the skin (set by ui-settings.js). */
let _refreshSkinsTab = null;
export function setSkinsTabRefresher(fn) { _refreshSkinsTab = typeof fn === 'function' ? fn : null; }

// Listen for cross-tab skin changes via WebSocket
on('sync:skin:changed', (msg) => {
  const id = msg?.id || 'default';
  if (id === 'default') removeSkinStylesheet();
  else loadSkinStylesheet(id);
  // Update settings panel if open
  const panel = document.getElementById('settings-panel');
  if (panel) _refreshSkinsTab?.(panel);
});
