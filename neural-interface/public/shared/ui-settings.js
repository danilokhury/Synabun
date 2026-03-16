// ═══════════════════════════════════════════
// UI-SETTINGS — Settings modal with shared tabs + variant tab injection
// ═══════════════════════════════════════════
//
// The most complex shared UI module. Builds a floating settings panel with
// 6 shared tabs (General, Setup, Terminal, Database, Recall, Projects, Automations, Interface)
// plus any variant-registered tabs (e.g. Graphics) injected via the registry.

import { state, emit, on } from './state.js';
import { getSettingsTabs } from './registry.js';
import { escapeHtml } from './utils.js';
import { storage } from './storage.js';
import { KEYS } from './constants.js';
import { registerAction } from './ui-keybinds.js';
import { createTerminalSession } from './api.js';
import { buildExplorePrompt } from './ui-tutorial-steps.js';
import { FI, FI_MAP, getFileIcon } from './ui-file-explorer.js';

// ── SVG icon constants ──

const eyeOpen = '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const eyeClosed = '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// Nav button SVGs keyed by tab id
const TAB_ICONS = {
  server: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/></svg>',
  hooks: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  terminal: '<svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  collections: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>',
  projects: '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  memory: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"/><line x1="9" y1="21" x2="15" y2="21"/><line x1="10" y1="24" x2="14" y2="24"/></svg>',
  interface: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="9" y1="9" x2="21" y2="9"/></svg>',
  graphics: '<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  icons: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  setup: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  skins: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-1 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9zM6.5 13c-.83 0-1.5-.67-1.5-1.5S5.67 10 6.5 10 8 10.67 8 11.5 7.33 13 6.5 13zm3-4C8.67 9 8 8.33 8 7.5S8.67 6 9.5 6s1.5.67 1.5 1.5S10.33 9 9.5 9zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 6 14.5 6s1.5.67 1.5 1.5S15.33 9 14.5 9zm3 4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>',
  social: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
  skills: '<svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  permissions: '<svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3z"/></svg>',
  discord: '<svg viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>',
};

// ── Shared icon constants ──

const COPY_ICON = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHEVRON_ICON = '<svg class="cc-section-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>';
const ANTHROPIC_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="currentColor"/></svg>';
const GEMINI_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="currentColor"/></svg>';
const OPENAI_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" fill="currentColor"/></svg>';
const BROWSER_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="4" ry="10" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 7h15M4.5 17h15" fill="none" stroke="currentColor" stroke-width="1"/></svg>';

// ── Toast helper ──

function showCCToast(msg, duration = 3000) {
  let toast = document.querySelector('.cc-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'cc-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ═══════════════════════════════════════════
// INTERFACE CUSTOMIZATION — config, presets, apply
// ═══════════════════════════════════════════

const IFACE_DEFAULTS = {
  visualizationEnabled: true,
  scale: 1,
  glassOpacity: 0.72,
  glassBlur: 40,
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

const IFACE_PRESETS = {
  default: { label: 'Default',  desc: 'Standard glass look',      values: { ...IFACE_DEFAULTS } },
  frosted: { label: 'Frosted',  desc: 'High blur, soft edges',    values: { glassOpacity: 0.5, glassBlur: 60, glassSaturate: 1.6, glassBorderOpacity: 0.1, glassShadowOpacity: 0.3, glassShadowSpread: 30, glassRadius: 18 } },
  solid:   { label: 'Solid',    desc: 'Opaque, minimal blur',     values: { glassOpacity: 0.92, glassBlur: 10, glassSaturate: 1.0, glassBorderOpacity: 0.15, glassShadowOpacity: 0.5, glassShadowSpread: 10, glassRadius: 10 } },
  minimal: { label: 'Minimal',  desc: 'Near-invisible panels',    values: { glassOpacity: 0.3, glassBlur: 20, glassSaturate: 1.2, glassBorderOpacity: 0.03, glassShadowOpacity: 0.15, glassShadowSpread: 8, glassRadius: 14 } },
};

// Slider definitions: [configKey, label, min, max, step, decimals]
const IFACE_SLIDERS = {
  'Glass & Transparency': [
    ['glassOpacity',       'Panel Opacity',      0,   1,    0.01, 2],
    ['glassBlur',          'Backdrop Blur',       0,   80,   1,    0],
    ['glassSaturate',      'Backdrop Saturation', 0.5, 2.5,  0.1,  1],
    ['glassBorderOpacity', 'Border Opacity',      0,   0.3,  0.01, 2],
  ],
  'Shadows': [
    ['glassShadowOpacity', 'Shadow Intensity',    0,   1,    0.01, 2],
    ['glassShadowSpread',  'Shadow Spread',        0,   60,   1,    0],
  ],
  'Shape': [
    ['glassRadius',        'Corner Radius',       0,   30,   1,    0],
  ],
  'Typography': [
    ['fontScale',          'Font Scale',           0.7, 1.5,  0.01, 2],
  ],
};

export function loadIfaceConfig() {
  try {
    const raw = storage.getItem('neural-interface-config');
    if (raw) return { ...IFACE_DEFAULTS, ...JSON.parse(raw) };
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
  storage.setItem('neural-interface-config', JSON.stringify(cfg));
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
      if (staticBg) staticBg.classList.add('visible');
    } else {
      // User toggle — stagger: controls fade first, then iris closes
      setTimeout(() => {
        if (graphContainer) graphContainer.classList.add('focus-active');
        if (staticBg) staticBg.classList.add('visible');
      }, 100);
    }
    // Notify variant-specific cleanup (lasso, context menu, etc.)
    emit('focus:enter');
  } else {
    // EXITING FOCUS MODE
    // Iris open the graph + close focus bg
    if (graphContainer) graphContainer.classList.remove('focus-active');
    if (staticBg) staticBg.classList.remove('visible');
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

// ── Shared tab order (variant tabs injected by order) ──

const SHARED_TAB_IDS = ['server', 'setup', 'terminal', 'collections', 'memory', 'projects', 'hooks', 'skills', 'discord', 'permissions', 'social', 'skins', 'interface', 'icons'];

// ── Tab descriptor map ──
const TAB_META = {
  server:      { label: 'General',     desc: 'API keys & status',       group: 'System' },
  setup:       { label: 'Setup',       desc: 'Claude, Gemini, Codex',   group: 'System' },
  terminal:    { label: 'Terminal',    desc: 'CLI executables',          group: 'System' },
  collections: { label: 'Database',    desc: 'SQLite storage',          group: 'Data' },
  memory:      { label: 'Recall',      desc: 'Token budget & sync',     group: 'Data' },
  projects:    { label: 'Projects',    desc: 'Workspace configs',       group: 'Data' },
  hooks:       { label: 'Automations', desc: 'Integrations & bridges',  group: 'Connections' },
  skills:      { label: 'Skills',      desc: 'Slash commands',          group: 'Connections' },
  discord:     { label: 'Discord',     desc: 'Bot & server config',     group: 'Connections' },
  permissions: { label: 'Permissions', desc: 'Tool access control',    group: 'Connections' },
  social:      { label: 'Social Media', desc: 'Platform automations',   group: 'Connections' },
  skins:       { label: 'Skins',       desc: 'Community themes',        group: 'Appearance' },
  interface:   { label: 'Interface',   desc: 'Theme & appearance',      group: 'Appearance' },
  icons:       { label: 'Icons',       desc: 'File type icons',         group: 'Appearance' },
};

// ═══════════════════════════════════════════
// SKIN LOADING — stylesheet injection + boot restore
// ═══════════════════════════════════════════

const SKIN_LINK_ID = 'synabun-skin-css';

/** Insert or update the skin stylesheet <link> */
function loadSkinStylesheet(skinId) {
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
function removeSkinStylesheet() {
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

// Listen for cross-tab skin changes via WebSocket
on('sync:skin:changed', (msg) => {
  const id = msg?.id || 'default';
  if (id === 'default') removeSkinStylesheet();
  else loadSkinStylesheet(id);
  // Update settings panel if open
  const panel = document.getElementById('settings-panel');
  if (panel) refreshSkinsTab(panel);
});

// ═══════════════════════════════════════════
// SKINS TAB — builder + interaction
// ═══════════════════════════════════════════

function buildSkinsTab(skins = [], activeSkin = 'default') {
  const activeMeta = skins.find(s => s.id === activeSkin) || { name: activeSkin };

  let cardsHtml = '';
  for (const s of skins) {
    const isActive = s.id === activeSkin;
    const previewHtml = s.preview
      ? `<div class="skin-preview" style="background-image:url(/skins/${escapeHtml(s.id)}/${escapeHtml(s.preview)})"></div>`
      : `<div class="skin-preview-fallback">${escapeHtml(s.name)}</div>`;

    const badgeHtml = isActive ? `<span class="skin-active-badge">Active</span>` : '';
    const removeBtn = s.builtin ? '' : `<button class="skin-remove" data-skin-id="${escapeHtml(s.id)}">Remove</button>`;
    const activateBtn = isActive ? '' : `<button class="skin-activate" data-skin-id="${escapeHtml(s.id)}">Activate</button>`;

    cardsHtml += `
      <div class="skin-card${isActive ? ' active' : ''}" data-skin-id="${escapeHtml(s.id)}">
        ${previewHtml}
        ${badgeHtml}
        <div class="skin-info">
          <span class="skin-name">${escapeHtml(s.name)}</span>
          <span class="skin-author">${s.author ? 'by ' + escapeHtml(s.author) : ''}</span>
        </div>
        <div class="skin-actions">
          ${activateBtn}
          ${removeBtn}
        </div>
      </div>`;
  }

  return `<div class="settings-tab-body" data-tab="skins">
    <div class="skin-active-strip">
      <span class="skin-active-dot"></span>
      <span class="skin-active-name">${escapeHtml(activeMeta.name)}</span>
      <span style="color:var(--t-muted)">active</span>
    </div>
    <div class="skin-grid" id="skin-grid">
      ${cardsHtml}
    </div>
    <div class="skin-upload-area">
      <button class="skin-upload-btn" id="skin-upload-btn">Install from ZIP</button>
      <input type="file" id="skin-file-input" accept=".zip" style="display:none">
      <span class="skin-upload-msg" id="skin-upload-msg"></span>
    </div>
    <div class="skin-hint">Create a skin: folder with skin.json + skin.css, package as ZIP.</div>
  </div>`;
}

/** Refresh the skins tab in an already-open settings panel */
async function refreshSkinsTab(panel) {
  try {
    const resp = await fetch('/api/skins').then(r => r.json());
    if (!resp.ok) return;
    const tabBody = panel.querySelector('.settings-tab-body[data-tab="skins"]');
    if (!tabBody) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = buildSkinsTab(resp.skins, resp.active);
    const newBody = tmp.querySelector('.settings-tab-body[data-tab="skins"]');
    tabBody.innerHTML = newBody.innerHTML;
    wireSkinsTab(panel, resp.skins, resp.active);
  } catch {}
}

/** Wire interaction handlers for the skins tab */
function wireSkinsTab(overlay, skins, activeSkin) {
  // Activate buttons
  overlay.querySelectorAll('.skin-activate').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.skinId;
      try {
        const resp = await fetch(`/api/skins/${id}/activate`, { method: 'PUT' }).then(r => r.json());
        if (resp.ok) {
          loadSkinStylesheet(id);
          refreshSkinsTab(overlay);
        }
      } catch {}
    });
  });

  // Remove buttons
  overlay.querySelectorAll('.skin-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.skinId;
      if (!confirm(`Remove skin "${id}"?`)) return;
      try {
        const resp = await fetch(`/api/skins/${id}`, { method: 'DELETE' }).then(r => r.json());
        if (resp.ok) {
          // If the deleted skin was active, revert to default
          const currentSkin = storage.getItem(KEYS.ACTIVE_SKIN) || 'default';
          if (currentSkin === id) removeSkinStylesheet();
          refreshSkinsTab(overlay);
        }
      } catch {}
    });
  });

  // Upload button
  const uploadBtn = overlay.querySelector('#skin-upload-btn');
  const fileInput = overlay.querySelector('#skin-file-input');
  const uploadMsg = overlay.querySelector('#skin-upload-msg');
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileInput.value = '';
      uploadMsg.textContent = 'Installing...';
      uploadMsg.className = 'skin-upload-msg';
      try {
        const buf = await file.arrayBuffer();
        const resp = await fetch('/api/skins/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: buf,
        }).then(r => r.json());
        if (resp.ok) {
          uploadMsg.textContent = `Installed "${resp.skin.name}"`;
          uploadMsg.className = 'skin-upload-msg success';
          refreshSkinsTab(overlay);
        } else {
          uploadMsg.textContent = resp.error || 'Upload failed';
          uploadMsg.className = 'skin-upload-msg error';
        }
      } catch (err) {
        uploadMsg.textContent = err.message || 'Upload failed';
        uploadMsg.className = 'skin-upload-msg error';
      }
      setTimeout(() => { if (uploadMsg) uploadMsg.textContent = ''; }, 5000);
    });
  }
}

// ═══════════════════════════════════════════
// TAB HTML BUILDERS
// ═══════════════════════════════════════════

function buildNavHTML(variantTabs, statusMap = {}) {
  let html = '';
  let lastGroup = '';

  // Shared tabs — grouped with section headers
  for (const id of SHARED_TAB_IDS) {
    const meta = TAB_META[id] || { label: id, desc: '', group: '' };

    // Insert group header when group changes
    if (meta.group && meta.group !== lastGroup) {
      if (lastGroup) html += `<div class="settings-nav-sep"></div>\n`;
      html += `<div class="stg-nav-group-label">${meta.group}</div>\n`;
      lastGroup = meta.group;
    }

    const statusAttr = statusMap[id] ? ` data-status="${statusMap[id]}"` : '';
    html += `<button class="settings-nav-item${id === 'server' ? ' active' : ''}" data-tab="${id}"${statusAttr}>
      <span class="stg-nav-icon">${TAB_ICONS[id] || ''}</span>
      <span class="stg-nav-text">
        <span class="stg-nav-label">${meta.label}</span>
        <span class="stg-nav-desc">${meta.desc}</span>
      </span>
    </button>\n`;
  }

  // Separator + variant-registered tabs under "Appearance" group
  if (variantTabs.length) {
    html += `<div class="settings-nav-sep"></div>\n`;
  }
  for (const tab of variantTabs) {
    const icon = TAB_ICONS[tab.id] || (tab.icon.startsWith('<') ? tab.icon : `<span style="font-size:14px">${tab.icon}</span>`);
    html += `<button class="settings-nav-item" data-tab="${tab.id}">
      <span class="stg-nav-icon">${icon}</span>
      <span class="stg-nav-text">
        <span class="stg-nav-label">${tab.label}</span>
        <span class="stg-nav-desc"></span>
      </span>
    </button>\n`;
  }
  return html;
}

function buildServerTab(settings) {
  const dbSizeMB = settings.dbSizeBytes ? (settings.dbSizeBytes / 1024 / 1024).toFixed(1) : '0';
  return `
      <div class="settings-tab-body active" data-tab="server">
        <div class="settings-status">
          <span class="settings-status-dot ${settings.storage === 'sqlite' ? 'connected' : 'disconnected'}"></span>
          Storage: ${settings.storage === 'sqlite' ? 'SQLite' : settings.storage || 'Unknown'}
        </div>
        <div class="settings-field">
          <label>Database Path</label>
          <div class="settings-key-row" style="display:flex;gap:6px">
            <input type="text" id="stg-db-path" value="${escapeHtml(settings.dbPath || '')}" autocomplete="off" spellcheck="false" style="flex:1">
            <button class="conn-add-btn" id="stg-db-browse-btn" style="margin:0;width:auto;flex:0 0 auto;white-space:nowrap;padding:4px 10px">Browse</button>
            <button class="conn-add-btn" id="stg-db-move-btn" style="margin:0;width:auto;flex:0 0 auto;white-space:nowrap;padding:4px 10px">Move</button>
          </div>
          <div id="stg-db-browser" style="display:none;margin:4px 0 8px;border:1px solid var(--s-medium);border-radius:6px;background:var(--s-darker);max-height:220px;overflow-y:auto"></div>
          <div class="settings-hint" id="stg-db-hint">${settings.dbExists ? `File exists (${dbSizeMB} MB)` : 'Database not found'}</div>
          <div id="stg-db-move-status" style="display:none;margin-top:8px;font-size:12px;align-items:center;gap:8px"></div>
          <div id="stg-db-move-cleanup" style="display:none;margin-top:8px;padding:10px 12px;background:rgba(109,213,140,0.08);border:1px solid rgba(109,213,140,0.2);border-radius:8px;font-size:12px;">
            <div style="color:var(--green);margin-bottom:6px;font-weight:600">Move successful!</div>
            <div style="color:var(--t-secondary);margin-bottom:6px">Old database files remain at the previous location.</div>
            <div id="stg-db-mcp-notice" style="color:var(--t-muted);margin-bottom:8px;font-size:11px">Note: Restart the MCP server for the change to take effect.</div>
            <div style="display:flex;gap:8px">
              <button class="conn-add-btn" id="stg-db-delete-old" style="margin:0">Delete Old Files</button>
              <button class="settings-btn-cancel" id="stg-db-keep-old" style="margin:0">Keep Them</button>
            </div>
          </div>
        </div>
        <div class="settings-field">
          <label>Embedding</label>
          <div class="settings-key-row">
            <input type="text" value="${settings.embedding === 'local' ? 'Local' : settings.embedding || 'unknown'} — ${settings.embeddingModel || 'n/a'} (${settings.embeddingDims || '?'}d)" readonly style="opacity:0.7;cursor:default" autocomplete="off" spellcheck="false">
          </div>
          <div class="settings-hint">Embeddings are computed locally, no API key required</div>
        </div>
        <div class="stg-section-divider"></div>
        <div class="gfx-group-title">System Backup & Restore</div>
        <div class="settings-hint" style="margin-bottom:12px">
          Create a full backup of all SynaBun data including .env config, data files,
          category definitions, and memory database.
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="conn-add-btn" id="sys-backup-btn" style="margin:0;flex:0 0 auto">
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download Full Backup
          </button>
          <button class="conn-add-btn" id="sys-restore-btn" style="margin:0;flex:0 0 auto">
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Restore from Backup
          </button>
          <input type="file" id="sys-restore-file" accept=".zip" style="display:none">
        </div>
        <div id="sys-backup-status" style="display:none;margin-top:10px;font-size:12px;align-items:center;gap:8px">
          <div class="wiz-status-dot spin" id="sys-backup-dot"></div>
          <span id="sys-backup-text"></span>
        </div>
      </div>`;
}

function buildSetupTab(setupStatus) {
  const claudeConnected = setupStatus.claude?.connected || false;
  const geminiConnected = setupStatus.gemini?.connected || false;
  const codexConnected = setupStatus.codex?.connected || false;

  const statusBadge = (on) => `<span class="setup-status-badge ${on ? 'active' : 'inactive'}">${on ? 'Connected' : 'Off'}</span>`;

  return `
      <div class="settings-tab-body" data-tab="setup">

        <!-- CLAUDE (Anthropic) -->
        <div class="iface-section collapsed" data-collapsible id="setup-claude">
          <div class="gfx-group-title">
            <span style="display:flex;align-items:center;gap:8px">
              ${CHEVRON_ICON}
              ${ANTHROPIC_ICON}
              <span>Claude</span>
              ${statusBadge(claudeConnected)}
            </span>
          </div>
          <div class="cc-section-body">
            <div class="cc-integration-item${claudeConnected ? ' enabled' : ''}" id="setup-claude-mcp-row">
              <div class="cc-integration-info">
                <div class="cc-integration-label">SynaBun MCP</div>
                <div class="cc-integration-path" id="setup-claude-mcp-status">${claudeConnected ? 'Registered in ~/.claude.json' : 'Not connected'}</div>
              </div>
              <button class="cc-toggle${claudeConnected ? ' on' : ''}" id="setup-claude-mcp-toggle"></button>
            </div>
            <button class="cc-copy-btn" id="setup-claude-cli-copy" style="margin-top:4px">${COPY_ICON} Copy CLI Command</button>

            <div style="margin-top:12px">
              <div class="cc-greeting-label" style="margin-bottom:4px">CLAUDE.md Ruleset</div>
              <div class="cc-ruleset-preview" id="setup-claude-ruleset-preview">Loading...</div>
              <button class="cc-copy-btn" id="setup-claude-ruleset-copy" style="margin-top:4px">${COPY_ICON} Copy Ruleset</button>
              <div class="setup-hint">Paste into your project's <code>CLAUDE.md</code></div>
            </div>
          </div>
        </div>

        <!-- GEMINI (Google) -->
        <div class="iface-section collapsed" data-collapsible id="setup-gemini">
          <div class="gfx-group-title">
            <span style="display:flex;align-items:center;gap:8px">
              ${CHEVRON_ICON}
              ${GEMINI_ICON}
              <span>Gemini</span>
              ${statusBadge(geminiConnected)}
            </span>
          </div>
          <div class="cc-section-body">
            <div class="cc-integration-item${geminiConnected ? ' enabled' : ''}" id="setup-gemini-mcp-row">
              <div class="cc-integration-info">
                <div class="cc-integration-label">SynaBun MCP</div>
                <div class="cc-integration-path" id="setup-gemini-mcp-status">${geminiConnected ? 'Registered in ~/.gemini/settings.json' : 'Not connected'}</div>
              </div>
              <button class="cc-toggle${geminiConnected ? ' on' : ''}" id="setup-gemini-mcp-toggle"></button>
            </div>

            <div style="margin-top:12px">
              <div class="cc-greeting-label" style="margin-bottom:4px">Manual Config <span style="color:var(--t-faint)">(~/.gemini/settings.json)</span></div>
              <div class="cc-ruleset-preview" id="setup-gemini-config-preview" style="max-height:120px">Loading...</div>
              <button class="cc-copy-btn" id="setup-gemini-config-copy" style="margin-top:4px">${COPY_ICON} Copy JSON Config</button>
            </div>

            <div style="margin-top:12px">
              <div class="cc-greeting-label" style="margin-bottom:4px">GEMINI.md Ruleset</div>
              <div class="cc-ruleset-preview" id="setup-gemini-ruleset-preview">Loading...</div>
              <button class="cc-copy-btn" id="setup-gemini-ruleset-copy" style="margin-top:4px">${COPY_ICON} Copy Ruleset</button>
              <div class="setup-hint">Paste into your project's <code>GEMINI.md</code></div>
            </div>
          </div>
        </div>

        <!-- CODEX (OpenAI) -->
        <div class="iface-section collapsed" data-collapsible id="setup-codex">
          <div class="gfx-group-title">
            <span style="display:flex;align-items:center;gap:8px">
              ${CHEVRON_ICON}
              ${OPENAI_ICON}
              <span>Codex</span>
              ${statusBadge(codexConnected)}
            </span>
          </div>
          <div class="cc-section-body">
            <div class="cc-integration-item${codexConnected ? ' enabled' : ''}" id="setup-codex-mcp-row">
              <div class="cc-integration-info">
                <div class="cc-integration-label">SynaBun MCP</div>
                <div class="cc-integration-path" id="setup-codex-mcp-status">${codexConnected ? 'Registered in ~/.codex/config.toml' : 'Not connected'}</div>
              </div>
              <button class="cc-toggle${codexConnected ? ' on' : ''}" id="setup-codex-mcp-toggle"></button>
            </div>
            <button class="cc-copy-btn" id="setup-codex-cli-copy" style="margin-top:4px">${COPY_ICON} Copy CLI Command</button>

            <div style="margin-top:12px">
              <div class="cc-greeting-label" style="margin-bottom:4px">Manual Config <span style="color:var(--t-faint)">(~/.codex/config.toml)</span></div>
              <div class="cc-ruleset-preview" id="setup-codex-config-preview" style="max-height:120px">Loading...</div>
              <button class="cc-copy-btn" id="setup-codex-config-copy" style="margin-top:4px">${COPY_ICON} Copy TOML Config</button>
            </div>

            <div style="margin-top:12px">
              <div class="cc-greeting-label" style="margin-bottom:4px">AGENTS.md Ruleset</div>
              <div class="cc-ruleset-preview" id="setup-codex-ruleset-preview">Loading...</div>
              <button class="cc-copy-btn" id="setup-codex-ruleset-copy" style="margin-top:4px">${COPY_ICON} Copy Ruleset</button>
              <div class="setup-hint">Paste into your project's <code>AGENTS.md</code></div>
            </div>
          </div>
        </div>

        <!-- BROWSER (Playwright) -->
        <div class="iface-section collapsed" data-collapsible id="setup-browser">
          <div class="gfx-group-title">
            <span style="display:flex;align-items:center;gap:8px">
              ${CHEVRON_ICON}
              ${BROWSER_ICON}
              <span>Browser</span>
              <span class="setup-status-badge inactive" id="setup-browser-badge">Playwright</span>
            </span>
          </div>
          <div class="cc-section-body">

            <!-- ════ QUICK SETUP (always visible, no collapsible) ════ -->
            <div class="bc-card" id="bcg-executable">
              <div class="bc-card-row">
                <label class="bc-lbl">Chrome Path</label>
                <div class="browser-cfg-input-row">
                  <input type="text" class="browser-cfg-input" id="bc-executablePath" placeholder="Auto-detect" spellcheck="false" autocomplete="off">
                  <button class="cli-detect-btn" id="bc-detect-executable" data-tooltip="Detect">
                    <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  </button>
                </div>
                <div class="browser-cfg-hint" id="bc-detected-path"></div>
              </div>
              <div class="bc-card-row">
                <label class="bc-lbl">Mode</label>
                <div class="bc-inline-group">
                  <input type="hidden" id="bc-headless" value="false">
                  <div class="cc-dropdown bc-dropdown" data-for="bc-headless">
                    <button class="cc-dropdown-trigger" type="button">
                      <span class="cc-dropdown-value">Headed</span>
                      <svg class="cc-dropdown-arrow" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    <div class="cc-dropdown-menu">
                      <div class="cc-dropdown-item active" data-value="true">Headless</div>
                      <div class="cc-dropdown-item" data-value="false">Headed</div>
                    </div>
                  </div>
                  <input type="hidden" id="bc-channel" value="">
                  <div class="cc-dropdown bc-dropdown" data-for="bc-channel">
                    <button class="cc-dropdown-trigger" type="button">
                      <span class="cc-dropdown-value">Default channel</span>
                      <svg class="cc-dropdown-arrow" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    <div class="cc-dropdown-menu">
                      <div class="cc-dropdown-item active" data-value="">Default channel</div>
                      <div class="cc-dropdown-item" data-value="chrome">Chrome</div>
                      <div class="cc-dropdown-item" data-value="chrome-beta">Chrome Beta</div>
                      <div class="cc-dropdown-item" data-value="chrome-dev">Chrome Dev</div>
                      <div class="cc-dropdown-item" data-value="chrome-canary">Chrome Canary</div>
                      <div class="cc-dropdown-item" data-value="msedge">MS Edge</div>
                      <div class="cc-dropdown-item" data-value="msedge-beta">MS Edge Beta</div>
                      <div class="cc-dropdown-item" data-value="msedge-dev">MS Edge Dev</div>
                      <div class="cc-dropdown-item" data-value="msedge-canary">MS Edge Canary</div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="bc-card-row">
                <label class="bc-lbl">Viewport</label>
                <div class="bc-inline-group">
                  <input type="number" class="browser-cfg-input browser-cfg-input-sm" id="bc-viewportWidth" value="1280" min="320" max="7680" step="1" data-tooltip="Width">
                  <span class="bc-x">&times;</span>
                  <input type="number" class="browser-cfg-input browser-cfg-input-sm" id="bc-viewportHeight" value="800" min="200" max="4320" step="1" data-tooltip="Height">
                  <span class="bc-sep"></span>
                  <input type="number" class="browser-cfg-input" id="bc-deviceScaleFactor" value="1" min="0.5" max="5" step="0.25" style="width:52px;flex:none" data-tooltip="DPR">
                  <span class="bc-unit">DPR</span>
                </div>
              </div>
              <div class="bc-card-row">
                <label class="bc-lbl">Screencast</label>
                <div class="bc-inline-group">
                  <input type="hidden" id="bc-screencastFormat" value="jpeg">
                  <div class="cc-dropdown bc-dropdown" data-for="bc-screencastFormat" style="width:72px;flex:none">
                    <button class="cc-dropdown-trigger" type="button">
                      <span class="cc-dropdown-value">JPEG</span>
                      <svg class="cc-dropdown-arrow" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    <div class="cc-dropdown-menu">
                      <div class="cc-dropdown-item active" data-value="jpeg">JPEG</div>
                      <div class="cc-dropdown-item" data-value="png">PNG</div>
                    </div>
                  </div>
                  <input type="range" class="browser-cfg-range" id="bc-screencastQuality" value="60" min="10" max="100" step="5" style="flex:1;min-width:60px">
                  <span class="browser-cfg-range-val" id="bc-screencastQuality-val">60%</span>
                </div>
              </div>
            </div>

            <!-- ════ PROFILE ════ -->
            <div class="bc-card bc-card-accent">
              <div class="bc-card-header">Profile &amp; Storage</div>
              <input type="hidden" id="bc-userDataDir" value="">
              <div class="bc-card-row">
                <label class="bc-lbl">Chrome Profile</label>
                <div class="browser-cfg-input-row" style="flex:1">
                  <button class="cli-detect-btn" id="bc-detect-profiles" data-tooltip="Scan for profiles" style="order:2">
                    <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  </button>
                </div>
              </div>
              <div class="bc-profile-list" id="bc-profile-list">
                <div class="bc-profile-item selected" data-profile-value="">
                  <span class="bc-profile-radio"></span>
                  <span class="bc-profile-name">Clean Sandbox</span>
                  <span class="bc-profile-hint">No persistent profile</span>
                </div>
                <div class="bc-profile-item" data-profile-value="__synabun__">
                  <span class="bc-profile-radio"></span>
                  <span class="bc-profile-name">SynaBun Profile</span>
                  <span class="bc-profile-hint">Managed</span>
                </div>
              </div>
              <div class="bc-card-row" style="margin-top:6px">
                <label class="bc-lbl">Path</label>
                <div class="browser-cfg-input-row" style="flex:1">
                  <input type="text" class="browser-cfg-input" id="bc-custom-profile-path" placeholder="Profile folder path (or pick from list above)" spellcheck="false" autocomplete="off" style="flex:1">
                  <button class="cli-detect-btn" id="bc-browse-folder" data-tooltip="Browse for folder" style="order:2">
                    <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                  </button>
                </div>
              <div id="bc-browse-browser" style="display:none;margin:4px 0 4px;border:1px solid var(--s-medium);border-radius:6px;background:var(--s-darker);max-height:220px;overflow-y:auto"></div>
              </div>
              <div class="bc-card-row">
                <label class="bc-lbl">Persist State</label>
                <div class="bc-inline-group">
                  <button class="cc-toggle" id="bc-persistStorage"></button>
                  <span class="bc-hint-inline">Save cookies &amp; localStorage between sessions</span>
                </div>
              </div>
              <div class="bc-card-row" id="bc-storagePath-row">
                <label class="bc-lbl">Storage File</label>
                <input type="text" class="browser-cfg-input" id="bc-storageStatePath" placeholder="data/browser-storage.json" spellcheck="false" disabled>
              </div>
              <div class="bc-card-row">
                <label class="bc-lbl">Clear on Start</label>
                <div class="bc-inline-group">
                  <button class="cc-toggle" id="bc-clearStorageOnStart"></button>
                </div>
              </div>
            </div>

            <!-- ════ IDENTITY & STEALTH ════ -->
            <div class="browser-cfg-group" id="bcg-identity">
              <div class="browser-cfg-group-title" data-collapsible-sub>
                <svg class="browser-cfg-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
                Identity &amp; Stealth
              </div>
              <div class="browser-cfg-group-body">
                <div class="bc-card-row">
                  <label class="bc-lbl">Stealth Fingerprint</label>
                  <div class="bc-inline-group">
                    <button class="cc-toggle on" id="bc-stealthFingerprint"></button>
                    <span class="bc-hint-inline">webdriver=false, fake plugins, language cloning</span>
                  </div>
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">User Agent</label>
                  <input type="text" class="browser-cfg-input" id="bc-userAgent" placeholder="Auto-clone from real browser" spellcheck="false">
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Locale</label>
                  <div class="bc-inline-group">
                    <input type="text" class="browser-cfg-input" id="bc-acceptLanguage" placeholder="en-US,en;q=0.9" spellcheck="false" style="flex:1">
                    <input type="text" class="browser-cfg-input" id="bc-locale" placeholder="en-US" spellcheck="false" style="width:80px;flex:none">
                    <input type="text" class="browser-cfg-input" id="bc-timezoneId" placeholder="America/New_York" spellcheck="false" style="flex:1">
                  </div>
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Extra Headers</label>
                  <textarea class="browser-cfg-textarea" id="bc-extraHTTPHeaders" rows="2" placeholder='{"X-Custom": "value"}' spellcheck="false"></textarea>
                </div>
              </div>
            </div>

            <!-- ════ DISPLAY ════ -->
            <div class="browser-cfg-group" id="bcg-viewport">
              <div class="browser-cfg-group-title" data-collapsible-sub>
                <svg class="browser-cfg-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
                Display &amp; Emulation
              </div>
              <div class="browser-cfg-group-body">
                <div class="bc-card-row">
                  <label class="bc-lbl">Screen Size</label>
                  <div class="bc-inline-group">
                    <input type="number" class="browser-cfg-input browser-cfg-input-sm" id="bc-screenWidth" value="1920" min="320" max="7680" step="1">
                    <span class="bc-x">&times;</span>
                    <input type="number" class="browser-cfg-input browser-cfg-input-sm" id="bc-screenHeight" value="1080" min="200" max="4320" step="1">
                  </div>
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Emulation</label>
                  <div class="bc-inline-group">
                    <button class="cc-toggle" id="bc-isMobile"></button>
                    <span class="bc-hint-inline">Mobile</span>
                    <span class="bc-sep"></span>
                    <button class="cc-toggle" id="bc-hasTouch"></button>
                    <span class="bc-hint-inline">Touch</span>
                  </div>
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Appearance</label>
                  <div class="bc-inline-group">
                    <input type="hidden" id="bc-colorScheme" value="">
                    <div class="cc-dropdown bc-dropdown" data-for="bc-colorScheme">
                      <button class="cc-dropdown-trigger" type="button">
                        <span class="cc-dropdown-value">Color: auto</span>
                        <svg class="cc-dropdown-arrow" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                      </button>
                      <div class="cc-dropdown-menu">
                        <div class="cc-dropdown-item active" data-value="">Color: auto</div>
                        <div class="cc-dropdown-item" data-value="light">Light</div>
                        <div class="cc-dropdown-item" data-value="dark">Dark</div>
                        <div class="cc-dropdown-item" data-value="no-preference">No pref</div>
                      </div>
                    </div>
                    <input type="hidden" id="bc-reducedMotion" value="">
                    <div class="cc-dropdown bc-dropdown" data-for="bc-reducedMotion">
                      <button class="cc-dropdown-trigger" type="button">
                        <span class="cc-dropdown-value">Motion: auto</span>
                        <svg class="cc-dropdown-arrow" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                      </button>
                      <div class="cc-dropdown-menu">
                        <div class="cc-dropdown-item active" data-value="">Motion: auto</div>
                        <div class="cc-dropdown-item" data-value="reduce">Reduce</div>
                        <div class="cc-dropdown-item" data-value="no-preference">No pref</div>
                      </div>
                    </div>
                    <input type="hidden" id="bc-forcedColors" value="">
                    <div class="cc-dropdown bc-dropdown" data-for="bc-forcedColors">
                      <button class="cc-dropdown-trigger" type="button">
                        <span class="cc-dropdown-value">Colors: auto</span>
                        <svg class="cc-dropdown-arrow" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                      </button>
                      <div class="cc-dropdown-menu">
                        <div class="cc-dropdown-item active" data-value="">Colors: auto</div>
                        <div class="cc-dropdown-item" data-value="active">Forced</div>
                        <div class="cc-dropdown-item" data-value="none">None</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- ════ ADVANCED ════ -->
            <div class="browser-cfg-group" id="bcg-advanced">
              <div class="browser-cfg-group-title" data-collapsible-sub>
                <svg class="browser-cfg-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
                Advanced
              </div>
              <div class="browser-cfg-group-body">
                <!-- Timeouts & Launch -->
                <div class="bc-adv-section">Timeouts &amp; Launch</div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Timeouts</label>
                  <div class="bc-inline-group">
                    <input type="number" class="browser-cfg-input" id="bc-timeout" value="30000" min="0" max="300000" step="1000" style="width:80px;flex:none">
                    <span class="bc-unit">action</span>
                    <input type="number" class="browser-cfg-input" id="bc-navigationTimeout" value="30000" min="0" max="300000" step="1000" style="width:80px;flex:none">
                    <span class="bc-unit">nav</span>
                    <input type="number" class="browser-cfg-input" id="bc-slowMo" value="0" min="0" max="10000" step="50" style="width:64px;flex:none">
                    <span class="bc-unit">slow</span>
                  </div>
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Extra Args</label>
                  <input type="text" class="browser-cfg-input" id="bc-extraArgs" placeholder="--flag1 --flag2=value" spellcheck="false">
                </div>

                <!-- Screencast (advanced) -->
                <div class="bc-adv-section">Screencast</div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Resolution</label>
                  <div class="bc-inline-group">
                    <input type="number" class="browser-cfg-input browser-cfg-input-sm" id="bc-screencastMaxWidth" value="1280" min="320" max="3840" step="1">
                    <span class="bc-x">&times;</span>
                    <input type="number" class="browser-cfg-input browser-cfg-input-sm" id="bc-screencastMaxHeight" value="800" min="200" max="2160" step="1">
                    <span class="bc-sep"></span>
                    <span class="bc-unit">every</span>
                    <input type="number" class="browser-cfg-input" id="bc-screencastEveryNthFrame" value="1" min="1" max="30" step="1" style="width:44px;flex:none">
                    <span class="bc-unit">frame</span>
                  </div>
                </div>

                <!-- Security -->
                <div class="bc-adv-section">Security</div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Flags</label>
                  <div class="bc-inline-group bc-toggle-row">
                    <div class="bc-toggle-item"><button class="cc-toggle on" id="bc-javaScriptEnabled"></button><span>JS</span></div>
                    <div class="bc-toggle-item"><button class="cc-toggle" id="bc-ignoreHTTPSErrors"></button><span>Skip HTTPS</span></div>
                    <div class="bc-toggle-item"><button class="cc-toggle" id="bc-bypassCSP"></button><span>Bypass CSP</span></div>
                    <div class="bc-toggle-item"><button class="cc-toggle on" id="bc-acceptDownloads"></button><span>Downloads</span></div>
                    <div class="bc-toggle-item"><button class="cc-toggle on" id="bc-strictSelectors"></button><span>Strict</span></div>
                  </div>
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Workers</label>
                  <input type="hidden" id="bc-serviceWorkers" value="allow">
                  <div class="cc-dropdown bc-dropdown" data-for="bc-serviceWorkers">
                    <button class="cc-dropdown-trigger" type="button">
                      <span class="cc-dropdown-value">Allow</span>
                      <svg class="cc-dropdown-arrow" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    <div class="cc-dropdown-menu">
                      <div class="cc-dropdown-item active" data-value="allow">Allow</div>
                      <div class="cc-dropdown-item" data-value="block">Block</div>
                    </div>
                  </div>
                </div>

                <!-- Geolocation -->
                <div class="bc-adv-section">Geolocation</div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Override</label>
                  <div class="bc-inline-group">
                    <button class="cc-toggle" id="bc-geoEnabled"></button>
                    <input type="number" class="browser-cfg-input" id="bc-geoLatitude" value="0" min="-90" max="90" step="0.0001" disabled style="width:80px;flex:none" placeholder="lat">
                    <input type="number" class="browser-cfg-input" id="bc-geoLongitude" value="0" min="-180" max="180" step="0.0001" disabled style="width:80px;flex:none" placeholder="lng">
                    <input type="number" class="browser-cfg-input" id="bc-geoAccuracy" value="100" min="0" max="100000" step="1" disabled style="width:64px;flex:none" placeholder="acc">
                  </div>
                </div>

                <!-- Permissions -->
                <div class="bc-adv-section">Permissions</div>
                <div class="browser-cfg-checkbox-grid">
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-geolocation"> Geolocation</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-midi"> MIDI</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-midi-sysex"> MIDI SysEx</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-notifications"> Notifications</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-camera"> Camera</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-microphone"> Microphone</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-background-sync"> Bg Sync</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-ambient-light-sensor"> Light</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-accelerometer"> Accel</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-gyroscope"> Gyro</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-magnetometer"> Magnet</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-clipboard-read"> Clipboard R</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-clipboard-write"> Clipboard W</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-payment-handler"> Payment</label>
                  <label class="browser-cfg-checkbox"><input type="checkbox" id="bc-perm-storage-access"> Storage</label>
                </div>

                <!-- Network & Proxy -->
                <div class="bc-adv-section">Network &amp; Proxy</div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Offline</label>
                  <div class="bc-inline-group">
                    <button class="cc-toggle" id="bc-offline"></button>
                  </div>
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Proxy</label>
                  <div class="bc-inline-group">
                    <input type="text" class="browser-cfg-input" id="bc-proxyServer" placeholder="http://host:port" spellcheck="false" style="flex:2">
                    <input type="text" class="browser-cfg-input" id="bc-proxyBypass" placeholder="bypass" spellcheck="false" style="flex:1">
                  </div>
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Proxy Auth</label>
                  <div class="bc-inline-group">
                    <input type="text" class="browser-cfg-input" id="bc-proxyUsername" placeholder="user" spellcheck="false" autocomplete="off">
                    <input type="password" class="browser-cfg-input" id="bc-proxyPassword" placeholder="pass" autocomplete="off">
                  </div>
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">HTTP Auth</label>
                  <div class="bc-inline-group">
                    <input type="text" class="browser-cfg-input" id="bc-httpCredUser" placeholder="user" spellcheck="false" autocomplete="off">
                    <input type="password" class="browser-cfg-input" id="bc-httpCredPass" placeholder="pass" autocomplete="off">
                  </div>
                </div>

                <!-- Recording -->
                <div class="bc-adv-section">Recording</div>
                <div class="bc-card-row">
                  <label class="bc-lbl">Video</label>
                  <div class="bc-inline-group">
                    <button class="cc-toggle" id="bc-recordVideo"></button>
                    <input type="text" class="browser-cfg-input" id="bc-recordVideoDir" placeholder="data/videos" spellcheck="false" disabled style="flex:1">
                    <input type="number" class="browser-cfg-input" id="bc-recordVideoWidth" value="1280" min="320" max="3840" step="1" disabled style="width:64px;flex:none">
                    <span class="bc-x">&times;</span>
                    <input type="number" class="browser-cfg-input" id="bc-recordVideoHeight" value="720" min="200" max="2160" step="1" disabled style="width:64px;flex:none">
                  </div>
                </div>
                <div class="bc-card-row">
                  <label class="bc-lbl">HAR</label>
                  <div class="bc-inline-group">
                    <button class="cc-toggle" id="bc-recordHar"></button>
                    <input type="text" class="browser-cfg-input" id="bc-recordHarPath" placeholder="data/network.har" spellcheck="false" disabled style="flex:1">
                  </div>
                </div>
                <div id="bc-recordHar-fields">
                  <div class="bc-card-row">
                    <label class="bc-lbl"></label>
                    <div class="bc-inline-group">
                      <input type="hidden" id="bc-recordHarContent" value="embed" disabled>
                      <div class="cc-dropdown bc-dropdown disabled" data-for="bc-recordHarContent">
                        <button class="cc-dropdown-trigger" type="button" disabled>
                          <span class="cc-dropdown-value">Content: Embed</span>
                          <svg class="cc-dropdown-arrow" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                        <div class="cc-dropdown-menu">
                          <div class="cc-dropdown-item active" data-value="embed">Content: Embed</div>
                          <div class="cc-dropdown-item" data-value="attach">Attach</div>
                          <div class="cc-dropdown-item" data-value="omit">Omit</div>
                        </div>
                      </div>
                      <input type="hidden" id="bc-recordHarMode" value="full" disabled>
                      <div class="cc-dropdown bc-dropdown disabled" data-for="bc-recordHarMode">
                        <button class="cc-dropdown-trigger" type="button" disabled>
                          <span class="cc-dropdown-value">Mode: Full</span>
                          <svg class="cc-dropdown-arrow" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                        <div class="cc-dropdown-menu">
                          <div class="cc-dropdown-item active" data-value="full">Mode: Full</div>
                          <div class="cc-dropdown-item" data-value="minimal">Minimal</div>
                        </div>
                      </div>
                      <input type="text" class="browser-cfg-input" id="bc-recordHarUrlFilter" placeholder="URL filter glob" spellcheck="false" disabled style="flex:1">
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- ════ ACTIONS ════ -->
            <div class="bc-actions">
              <button class="bc-action-btn bc-action-save" id="bc-save-all">Save</button>
              <button class="bc-action-btn bc-action-reset" id="bc-reset-all">Reset</button>
            </div>
            <div class="bc-status-row"><span class="browser-cfg-hint" id="bc-save-status"></span></div>

          </div>
        </div>

        <!-- COEXISTENCE RULES -->
        <div class="iface-section collapsed" data-collapsible id="setup-coexistence">
          <div class="gfx-group-title">
            <span style="display:flex;align-items:center;gap:8px">
              ${CHEVRON_ICON}
              <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v-2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
              <span>Multi-Tool Coexistence</span>
            </span>
          </div>
          <div class="cc-section-body">
            <div class="setup-hint" style="margin-bottom:8px">When running SynaBun alongside other AI memory tools (CogniLayer, mem0, etc.), paste these rules into your project's instructions file to prevent tool confusion.</div>
            <div class="cc-ruleset-preview" id="setup-coexistence-ruleset-preview">Loading...</div>
            <button class="cc-copy-btn" id="setup-coexistence-ruleset-copy" style="margin-top:4px">${COPY_ICON} Copy Coexistence Rules</button>
            <div class="setup-hint">Paste into your project's <code>CLAUDE.md</code>, <code>GEMINI.md</code>, <code>AGENTS.md</code>, or <code>.cursorrules</code></div>
          </div>
        </div>

      </div>`;
}

function buildTerminalTab(cliConfig) {
  const chevron = CHEVRON_ICON;
  const cliProfiles = [
    { id: 'claude-code', label: 'Claude Code', icon: ANTHROPIC_ICON, color: '#D4A27F', default: 'claude' },
    { id: 'codex',       label: 'Codex CLI',   icon: OPENAI_ICON,   color: '#74c7a5', default: 'codex' },
    { id: 'gemini',      label: 'Gemini CLI',  icon: GEMINI_ICON,   color: '#669DF6', default: 'gemini' },
  ];

  return `
      <div class="settings-tab-body" data-tab="terminal">

        <!-- CLI EXECUTABLE PATHS -->
        <div class="iface-section" id="cc-cli-paths">
          <div class="gfx-group-title">CLI Executable Paths</div>
          <div class="cc-hint" style="margin-bottom:12px">
            Configure the command used to launch each CLI from the terminal.<br>
            Use a bare name for PATH lookup, a full path for custom installs, or prefix with <code style="font-size:10px;background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px">wsl</code> for WSL.
          </div>
          ${cliProfiles.map(p => {
            const current = (cliConfig && cliConfig[p.id]?.command) || p.default;
            const isDefault = current === p.default;
            return `
            <div class="cli-path-row" data-cli-profile="${p.id}">
              <div class="cli-path-icon" style="color:${p.color}">${p.icon}</div>
              <div class="cli-path-field">
                <label class="cli-path-label">${p.label}</label>
                <div class="cli-path-input-row">
                  <input type="text" class="cli-path-input"
                         id="cli-path-${p.id}"
                         value="${escapeHtml(current)}"
                         placeholder="${p.default}"
                         spellcheck="false" autocomplete="off">
                  <button class="cli-detect-btn" data-cli-detect="${p.id}" data-tooltip="Auto-detect path">
                    <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                  </button>
                  <span class="cli-path-status${isDefault ? '' : ' custom'}" id="cli-status-${p.id}">
                    ${isDefault ? 'default' : 'custom'}
                  </span>
                </div>
              </div>
            </div>`;
          }).join('')}
          <button class="conn-add-btn" id="cli-paths-save"
                  style="width:100%;margin-top:12px;font-size:12px;padding:7px 10px;border-style:solid;background:rgba(79,195,247,0.08);border-color:rgba(79,195,247,0.25);color:rgba(79,195,247,0.9)">
            Save CLI Paths
          </button>
        </div>

        <!-- EXAMPLES -->
        <div class="iface-section">
          <div class="gfx-group-title">Examples</div>
          <div style="font-size:11px;color:var(--t-secondary);line-height:1.7">
            <div style="display:flex;gap:8px;align-items:baseline">
              <code style="font-size:10px;background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:3px;color:var(--t-muted);white-space:nowrap">claude</code>
              <span style="color:var(--t-dim)">Default — uses system PATH</span>
            </div>
            <div style="display:flex;gap:8px;align-items:baseline;margin-top:4px">
              <code style="font-size:10px;background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:3px;color:var(--t-muted);white-space:nowrap">C:\\Users\\me\\.npm\\claude</code>
              <span style="color:var(--t-dim)">Custom Windows path</span>
            </div>
            <div style="display:flex;gap:8px;align-items:baseline;margin-top:4px">
              <code style="font-size:10px;background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:3px;color:var(--t-muted);white-space:nowrap">/opt/homebrew/bin/claude</code>
              <span style="color:var(--t-dim)">Custom Unix path</span>
            </div>
            <div style="display:flex;gap:8px;align-items:baseline;margin-top:4px">
              <code style="font-size:10px;background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:3px;color:var(--t-muted);white-space:nowrap">wsl claude</code>
              <span style="color:var(--t-dim)">Run via WSL on Windows</span>
            </div>
            <div style="display:flex;gap:8px;align-items:baseline;margin-top:4px">
              <code style="font-size:10px;background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:3px;color:var(--t-muted);white-space:nowrap">wsl -d Ubuntu gemini</code>
              <span style="color:var(--t-dim)">Specific WSL distro</span>
            </div>
          </div>
        </div>

        <!-- NOTIFICATIONS -->
        <div class="iface-section">
          <div class="gfx-group-title">Notifications</div>
          <div class="cc-hint" style="margin-bottom:10px">
            Play a sound and show a browser notification when a CLI task finishes or needs attention.
          </div>
          <div class="iface-toggle-row">
            <label class="iface-toggle">
              <input type="checkbox" id="term-notif-toggle">
              <span class="iface-slider"></span>
            </label>
            <span class="iface-toggle-label">Enable task notifications</span>
          </div>
        </div>

      </div>`;
}

function buildCollectionsTab(connections, settings) {
  const conn = connections[0] || {};
  const dbSizeMB = settings.dbSizeBytes ? (settings.dbSizeBytes / 1024 / 1024).toFixed(1) : '0';

  const mismatchBanner = settings.embeddingMismatch ? `
        <div style="margin-bottom:12px;padding:10px 12px;background:rgba(255,107,107,0.10);border:1px solid rgba(255,107,107,0.25);border-radius:8px;font-size:12px;color:var(--red);line-height:1.5">
          Embedding model mismatch detected. Vectors may not match the current model. Run <strong>Reindex</strong> to regenerate all embeddings.
        </div>` : '';

  return `
      <div class="settings-tab-body" data-tab="collections">
        ${mismatchBanner}
        <div class="gfx-group-title">Memory Database</div>
        <div class="conn-list" id="conn-list">
          <div class="conn-item active">
            <div class="conn-item-dot"></div>
            <div class="conn-item-info">
              <div class="conn-item-name">Local SQLite</div>
              <div class="conn-item-meta">${settings.dbPath || 'memories.db'}</div>
            </div>
            <span class="conn-item-count">${conn.points || 0} memories</span>
          </div>
        </div>
        <div style="padding:8px 2px;font-size:12px;color:var(--t-muted);line-height:1.6">
          <div><strong style="color:var(--t-secondary)">Storage:</strong> SQLite</div>
          <div><strong style="color:var(--t-secondary)">DB Size:</strong> ${dbSizeMB} MB</div>
          <div><strong style="color:var(--t-secondary)">Embedding:</strong> ${settings.embeddingModel || 'local'} (${settings.embeddingDims || '?'}d)</div>
        </div>

        <div class="stg-section-divider"></div>
        <div class="gfx-group-title">Embedding Management</div>
        <div class="settings-hint" style="margin-bottom:12px">
          Regenerate all memory and session chunk embeddings using the current model. Use this if you change the embedding model or provider.
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <button class="conn-add-btn" id="reindex-btn" style="margin:0">Reindex All Memories</button>
          <button class="settings-btn-cancel" id="reindex-cancel-btn" style="margin:0;display:none">Cancel</button>
        </div>
        <div id="reindex-status" style="display:none;margin-top:10px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <div class="wiz-status-dot spin" id="reindex-dot"></div>
            <span id="reindex-text" style="font-size:12px;color:var(--t-secondary)"></span>
          </div>
          <div style="background:rgba(255,255,255,0.06);border-radius:4px;height:4px;overflow:hidden">
            <div id="reindex-bar" style="background:var(--green);height:100%;width:0%;transition:width 0.3s ease"></div>
          </div>
          <div id="reindex-summary" style="font-size:11px;color:var(--t-muted);margin-top:4px"></div>
        </div>
      </div>`;
}

/** Generate tool toggle rows, marking items that are alone in their grid row with span-full */
function buildToolRows(tools, perms) {
  // Split tools into segments by group header
  const segments = [];
  let currentGroup = null;
  let currentItems = [];
  for (const t of tools) {
    if (t.group && t.group !== currentGroup) {
      if (currentItems.length) segments.push({ group: currentGroup, items: currentItems });
      currentGroup = t.group;
      currentItems = [t];
    } else {
      currentItems.push(t);
    }
  }
  if (currentItems.length) segments.push({ group: currentGroup, items: currentItems });

  let html = '';
  for (const seg of segments) {
    if (seg.group) html += `<div class="cc-tool-group-header">${seg.group}</div>`;
    seg.items.forEach((t, i) => {
      const isOn = perms[t.key] !== false;
      const isOddLast = (seg.items.length % 2 === 1) && (i === seg.items.length - 1);
      html += `<div class="cc-integration-item${isOn ? ' enabled' : ''}${isOddLast ? ' span-full' : ''}" data-tool-key="${t.key}">
                <div class="cc-integration-info">
                  <div class="cc-integration-label">${t.label}</div>
                  <div class="cc-integration-path">${t.desc}</div>
                </div>
                <button class="cc-toggle${isOn ? ' on' : ''}" data-cc-tool="${t.key}"></button>
              </div>`;
    });
  }
  return html;
}

function buildSocialTab(toolCategories, toolPermissions) {
  const socialCat = (toolCategories || []).find(c => c.id === 'social');
  if (!socialCat) return `<div class="settings-tab-body" data-tab="social"><div class="cc-hint" style="padding:20px;color:var(--t-dim)">No social media tools registered.</div></div>`;

  const perms = toolPermissions || {};
  const onCount = socialCat.tools.filter(t => perms[t.key] !== false).length;
  const allOn = onCount === socialCat.tools.length;

  return `
      <div class="settings-tab-body" data-tab="social">
        <div class="cc-tool-category" data-tool-category="social" style="margin:0">
          <div class="cc-tool-category-header" style="padding-bottom:8px">
            <span class="cc-tool-category-label" style="font-size:12px">All Platforms</span>
            <span class="cc-tool-category-count">${onCount}/${socialCat.tools.length}</span>
            <button class="cc-tool-category-all${allOn ? ' on' : ''}" data-cc-tool-cat="social" title="Toggle all social media tools">${allOn ? 'All' : 'All'}</button>
          </div>
          <div class="cc-hook-toggles">${buildToolRows(socialCat.tools, perms)}
          </div>
        </div>
      </div>`;
}

function buildSkillsTab(ccSkills) {
  const skills = ccSkills || [];
  if (!skills.length) return `<div class="settings-tab-body" data-tab="skills"><div class="cc-hint" style="padding:20px;color:var(--t-dim)">No skills registered.</div></div>`;

  return `
      <div class="settings-tab-body" data-tab="skills">
        <div class="cc-tool-permissions-hint" style="font-size:11px;color:var(--t-dim);margin-bottom:12px;padding:0 2px">
          Slash commands that extend Claude Code with specialized capabilities.
        </div>
        ${skills.map(skill => `
          <div class="cc-skill-row${skill.installed ? ' installed' : ''}" data-skill-name="${skill.dirName}">
            <div class="cc-skill-info">
              <span class="cc-skill-name">/${skill.name}</span>
              <span class="cc-skill-desc">${skill.description || ''}</span>
            </div>
            <button class="cc-toggle${skill.installed ? ' on' : ''}" data-cc-skill="${skill.dirName}"></button>
          </div>
        `).join('')}
      </div>`;
}

function buildPermissionsTab(toolCategories, toolPermissions) {
  const chevron = CHEVRON_ICON;
  const categories = (toolCategories || []).filter(c => c.id !== 'social');
  if (!categories.length) return `<div class="settings-tab-body" data-tab="permissions"><div class="cc-hint" style="padding:20px;color:var(--t-dim)">No tool categories registered.</div></div>`;
  const perms = toolPermissions || {};

  let totalOn = 0, totalAll = 0;
  const catData = categories.map(cat => {
    const onCount = cat.tools.filter(t => perms[t.key] !== false).length;
    totalOn += onCount;
    totalAll += cat.tools.length;
    return { ...cat, onCount };
  });

  const allOn = totalOn === totalAll;

  const categoryHTML = catData.map(cat => {
    const catAllOn = cat.onCount === cat.tools.length;

    return `
            <div class="cc-tool-category" data-tool-category="${cat.id}">
              <div class="cc-tool-category-header">
                <span class="cc-tool-category-label">${cat.label}</span>
                <span class="cc-tool-category-count">${cat.onCount}/${cat.tools.length}</span>
                <button class="cc-tool-category-all${catAllOn ? ' on' : ''}" data-cc-tool-cat="${cat.id}" title="Toggle all ${cat.label} tools">${catAllOn ? 'All' : 'All'}</button>
              </div>
              <div class="cc-hook-toggles">${buildToolRows(cat.tools, perms)}
              </div>
            </div>`;
  }).join('');

  return `
      <div class="settings-tab-body" data-tab="permissions">
        <div class="cc-tool-permissions-hint" style="font-size:11px;color:var(--t-dim);margin-bottom:12px;padding:0 2px">
          Choose which actions can run automatically without asking you first.
        </div>
        <div class="cc-tool-category-header" style="padding-bottom:8px;margin-bottom:4px">
          <span class="cc-tool-category-label" style="font-size:12px">All Tools</span>
          <span class="cc-hooks-badge${allOn ? ' all-on' : ''}" id="cc-tools-badge">${totalOn}/${totalAll}</span>
        </div>
        ${categoryHTML}
      </div>`;
}

function buildConnectionsTab(ccIntegrations, ccSkills, tunnelStatus, mcpKeyInfo, openclawBridge, greetingConfig, toolPermissions, toolCategories) {
  const gh = ccIntegrations.global.hooks || {};
  const projs = ccIntegrations.projects || [];
  const ssOn = !!gh.SessionStart;
  const psOn = !!gh.UserPromptSubmit;
  const pcOn = !!gh.PreCompact;
  const stOn = !!gh.Stop;
  const prOn = !!gh.PreToolUse;
  const ptOn = !!gh.PostToolUse;
  const allOn = ssOn && psOn && pcOn && stOn && prOn && ptOn;
  const onCount = [ssOn, psOn, pcOn, stOn, prOn, ptOn].filter(Boolean).length;
  const hf = ccIntegrations.hookFeatures || {};
  const cmOn = hf.conversationMemory !== false;
  const grOn = hf.greeting === true;
  const ulOn = hf.userLearning !== false;
  const ulThreshold = hf.userLearningThreshold || 8;
  const ulMaxNudges = hf.userLearningMaxNudges || 3;

  const hookRows = [
    { key: 'SessionStart', on: ssOn, label: 'Session Startup', desc: 'Load memory and context when a new session begins' },
    { key: 'UserPromptSubmit', on: psOn, label: 'Message Processing', desc: 'Process each message for memory triggers and rule enforcement' },
    { key: 'PreCompact', on: pcOn, label: 'Context Preservation', desc: 'Save session data before the context window is compressed' },
    { key: 'Stop', on: stOn, label: 'Session Indexing', desc: 'Index completed sessions so they can be recalled later' },
    { key: 'PreToolUse', on: prOn, label: 'Tool Safety Guard', desc: 'Prevent web searches while browser automation is running' },
    { key: 'PostToolUse', on: ptOn, label: 'Action Tracking', desc: 'Track file changes, enforce rules, and save plans on approval' },
  ];

  // Build greeting project options
  const gc = greetingConfig || { defaults: {}, projects: {}, global: {} };
  const greetingProjects = Object.keys(gc.projects || {});
  const firstKey = greetingProjects[0] || 'global';
  const projectKeys = [...greetingProjects, 'global'];
  const projectOptions = projectKeys.map(k => {
    const label = k === 'global' ? 'Global (Default)' : (gc.projects[k]?.label || k);
    return `<option value="${k}"${k === firstKey ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');

  // Get first project config for initial display
  const firstCfg = firstKey === 'global'
    ? { ...gc.defaults, ...gc.global }
    : { ...gc.defaults, ...(gc.projects[firstKey] || {}) };

  const buildReminderRow = (r) => `
    <div class="cc-greeting-reminder-row">
      <span class="cc-greeting-drag-handle" title="Drag to reorder">&#8942;&#8942;</span>
      <input class="cc-greeting-reminder-input label" placeholder="Label" value="${escapeHtml(r.label || '')}">
      <input class="cc-greeting-reminder-input cmd" placeholder="Command" value="${escapeHtml(r.command || '')}">
      <button class="cc-greeting-reminder-remove" title="Remove">&times;</button>
    </div>`;

  const remindersHTML = (firstCfg.reminders || []).map(buildReminderRow).join('');

  const copyIcon = COPY_ICON;
  const chevron = CHEVRON_ICON;
  const anthropicIcon = ANTHROPIC_ICON;
  const geminiIcon = GEMINI_ICON;
  const openaiIcon = OPENAI_ICON;

  // Provider badge helper — generates compatibility badges for all AI providers
  const providerBadge = (compat) => {
    const anthropicItems = [
      { label: 'Claude Code CLI', on: compat.cli !== false },
      { label: 'Claude Code VSCode', on: compat.vscode !== false },
      { label: 'Claude Web', on: !!compat.web, note: compat.webNote },
      { label: 'Claude Cowork', on: !!compat.cowork },
    ];
    const geminiItems = [
      { label: 'Gemini CLI', on: false },
      { label: 'Gemini Code Assist', on: false },
      { label: 'Gemini Web', on: false },
    ];
    const openaiItems = [
      { label: 'Codex CLI', on: false },
      { label: 'Cursor', on: false },
      { label: 'ChatGPT Web', on: false },
    ];
    const anthropicOn = anthropicItems.filter(i => i.on).length;

    const buildPopup = (icon, title, items, untested) => {
      const onCount = items.filter(i => i.on).length;
      return `<div class="cc-compat-popup">
        <div class="cc-compat-header">
          ${icon}
          <span>${title}</span>
          <span class="cc-compat-count">${onCount}/${items.length}</span>
        </div>
        <div class="cc-compat-grid">
          ${items.map(i => `<div class="cc-compat-row ${i.on ? 'on' : 'off'}">
            <span class="cc-compat-dot${untested ? ' untested' : ''}"></span>
            <span class="cc-compat-name">${i.label}</span>
            ${i.note ? `<span class="cc-compat-note">${i.note}</span>` : ''}
          </div>`).join('')}
        </div>
      </div>`;
    };

    return `<div class="cc-provider-badges" onclick="event.stopPropagation()">
      <div class="cc-provider-badge" data-provider="anthropic" tabindex="0">
        ${anthropicIcon}
        ${buildPopup(anthropicIcon, 'Claude Compatibility', anthropicItems, false)}
      </div>
      <div class="cc-provider-badge" data-provider="google" tabindex="0">
        ${geminiIcon}
        ${buildPopup(geminiIcon, 'Gemini Compatibility', geminiItems, true)}
      </div>
      <div class="cc-provider-badge" data-provider="openai" tabindex="0">
        ${openaiIcon}
        ${buildPopup(openaiIcon, 'OpenAI Compatibility', openaiItems, true)}
      </div>
    </div>`;
  };

  return `
      <div class="settings-tab-body" data-tab="hooks">

        <!-- 1. GREETING (combined toggle + config) -->
        <div class="iface-section collapsed" data-collapsible id="cc-greeting-config">
          <div class="gfx-group-title" style="justify-content:space-between">
            <span style="display:flex;align-items:center;gap:6px">${chevron} Greeting</span>
            <div style="display:flex;align-items:center;gap:8px">
              ${providerBadge({ cli: true, vscode: true, web: false, cowork: false })}
              <button class="cc-toggle${grOn ? ' on' : ''}" data-cc-feature="greeting"></button>
            </div>
          </div>
          <div class="cc-section-body" id="cc-greeting-body" style="display:${grOn ? 'block' : 'none'}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
              <div class="cc-dropdown" id="cc-greeting-project-dropdown">
                <button class="cc-dropdown-trigger" type="button">
                  <span class="cc-dropdown-value" id="cc-greeting-project-label">${firstKey === 'global' ? 'Global (Default)' : escapeHtml((gc.projects[firstKey] || {}).label || firstKey)}</span>
                  <svg class="cc-dropdown-arrow" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <div class="cc-dropdown-menu" id="cc-greeting-project-menu">
                  ${projectKeys.map(k => {
                    const label = k === 'global' ? 'Global (Default)' : (gc.projects[k]?.label || k);
                    return `<div class="cc-dropdown-item${k === firstKey ? ' active' : ''}" data-value="${k}">${escapeHtml(label)}</div>`;
                  }).join('')}
                </div>
                <input type="hidden" id="cc-greeting-project" value="${firstKey}">
              </div>
              <span style="font-size:10px;color:var(--t-faint);margin-left:8px">Per-project or global</span>
            </div>
            <div class="cc-greeting-field">
              <label class="cc-greeting-label">Template</label>
              <textarea class="cc-greeting-textarea" id="cc-greeting-template" placeholder="{time_greeting}! Working on **{project_label}** ({branch} branch). {date}.">${escapeHtml(firstCfg.greetingTemplate || '')}</textarea>
              <div class="cc-greeting-cheatsheet-toggle" id="cc-greeting-cheatsheet-toggle">
                <svg viewBox="0 0 24 24" style="width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2;vertical-align:-1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                Variable Reference
              </div>
              <div class="cc-greeting-cheatsheet" id="cc-greeting-cheatsheet" style="display:none">
                <table class="cc-cheatsheet-table">
                  <thead><tr><th>Variable</th><th>Preview</th></tr></thead>
                  <tbody>
                    <tr><td><code>{time_greeting}</code></td><td id="cc-cs-time"></td></tr>
                    <tr><td><code>{project_label}</code></td><td id="cc-cs-label"></td></tr>
                    <tr><td><code>{project_name}</code></td><td id="cc-cs-name"></td></tr>
                    <tr><td><code>{branch}</code></td><td id="cc-cs-branch"></td></tr>
                    <tr><td><code>{date}</code></td><td id="cc-cs-date"></td></tr>
                  </tbody>
                </table>
                <div class="cc-cheatsheet-example">
                  <div class="cc-greeting-label" style="margin-bottom:3px;font-size:9px">Example output</div>
                  <div class="cc-cheatsheet-preview" id="cc-cs-preview"></div>
                </div>
              </div>
            </div>

            <div class="cc-greeting-checkboxes">
              <label class="iface-toggle-row">
                <input type="checkbox" id="cc-greeting-show-reminders" ${firstCfg.showReminders ? 'checked' : ''}>
                Show reminders
              </label>
              <label class="iface-toggle-row">
                <input type="checkbox" id="cc-greeting-show-last-session" ${firstCfg.showLastSession ? 'checked' : ''}>
                Show last session
              </label>
            </div>

            <div class="cc-greeting-field">
              <label class="cc-greeting-label">Reminders</label>
              <div class="cc-greeting-reminder-list" id="cc-greeting-reminders">${remindersHTML}</div>
              <button class="conn-add-btn" id="cc-greeting-add-reminder" style="margin-top:6px;font-size:11px;padding:5px 10px">
                <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add Reminder
              </button>
            </div>

            <button class="conn-add-btn" id="cc-greeting-save" style="width:100%;margin-top:4px;font-size:12px;padding:7px 10px;border-style:solid;background:rgba(79,195,247,0.08);border-color:rgba(79,195,247,0.25);color:rgba(79,195,247,0.9)">
              Save Greeting Config
            </button>
          </div>
        </div>

        <!-- 2. HOOKS -->
        <div class="iface-section collapsed" data-collapsible data-cc-target="global">
          <div class="gfx-group-title" style="justify-content:space-between">
            <span style="display:flex;align-items:center;gap:6px">${chevron} Hooks <span class="cc-hooks-badge${allOn ? ' all-on' : ''}" id="cc-hooks-badge">${onCount}/6</span></span>
            ${providerBadge({ cli: true, vscode: true, web: false, cowork: false })}
          </div>
          <div class="cc-section-body">
            <div class="cc-hook-toggles">
              ${hookRows.map(h => `
              <div class="cc-integration-item${h.on ? ' enabled' : ''}" data-hook="${h.key}">
                <div class="cc-integration-info">
                  <div class="cc-integration-label">${h.label}</div>
                  <div class="cc-integration-path">${h.desc}</div>
                </div>
                <button class="cc-toggle${h.on ? ' on' : ''}" data-cc-hook="${h.key}" data-cc-scope="global"></button>
              </div>`).join('')}
            </div>
          </div>
        </div>

        <!-- 3. KNOWLEDGE -->
        <div class="iface-section collapsed" data-collapsible>
          <div class="gfx-group-title" style="justify-content:space-between">
            <span style="display:flex;align-items:center;gap:6px">${chevron} Knowledge</span>
            ${providerBadge({ cli: true, vscode: true, web: false, cowork: false })}
          </div>
          <div class="cc-section-body">
            <div class="cc-hook-toggles">
              <div class="cc-integration-item${cmOn ? ' enabled' : ''}" data-feature="conversationMemory">
                <div class="cc-integration-info">
                  <div class="cc-integration-label">Conversation Memory</div>
                  <div class="cc-integration-path">Remember past sessions so context carries over between conversations</div>
                </div>
                <button class="cc-toggle${cmOn ? ' on' : ''}" data-cc-feature="conversationMemory"></button>
              </div>
              <div class="cc-integration-item${ulOn ? ' enabled' : ''}" data-feature="userLearning">
                <div class="cc-integration-info">
                  <div class="cc-integration-label">User Learning</div>
                  <div class="cc-integration-path">Learn your communication style and preferences over time</div>
                  <div class="cc-ul-threshold" id="cc-ul-threshold" style="display:${ulOn ? 'flex' : 'none'};align-items:center;gap:6px;margin-top:5px">
                    <span style="font-size:10px;color:var(--t-dim);white-space:nowrap">Reflect every</span>
                    <input type="number" id="cc-ul-threshold-input" min="3" max="30" value="${ulThreshold}" style="width:40px;padding:2px 4px;font-size:10px;background:rgba(255,255,255,0.04);border:1px solid var(--b-subtle);border-radius:4px;color:var(--t-bright);text-align:center;font-family:inherit">
                    <span style="font-size:10px;color:var(--t-dim)">interactions</span>
                    <span style="font-size:10px;color:var(--t-dim);white-space:nowrap;margin-left:8px">Max</span>
                    <input type="number" id="cc-ul-max-nudges-input" min="1" max="10" value="${ulMaxNudges}" style="width:34px;padding:2px 4px;font-size:10px;background:rgba(255,255,255,0.04);border:1px solid var(--b-subtle);border-radius:4px;color:var(--t-bright);text-align:center;font-family:inherit">
                    <span style="font-size:10px;color:var(--t-dim)">per session</span>
                  </div>
                </div>
                <button class="cc-toggle${ulOn ? ' on' : ''}" data-cc-feature="userLearning"></button>
              </div>
            </div>
          </div>
        </div>

        <!-- 4. EXTERNAL ACCESS -->
        <div class="iface-section collapsed" data-collapsible>
          <div class="gfx-group-title" style="justify-content:space-between">
            <span style="display:flex;align-items:center;gap:6px">${chevron} Go Online</span>
            ${providerBadge({ cli: true, vscode: true, web: true, webNote: 'via MCP URL', cowork: false })}
          </div>
          <div class="cc-section-body">
            <div class="cc-integration-item${tunnelStatus.running ? ' enabled' : ''}" id="cc-tunnel-row">
              <div class="cc-integration-info">
                <div class="cc-integration-label" id="cc-tunnel-label">${tunnelStatus.running ? 'Running' : tunnelStatus.available ? 'Ready' : 'Not installed'}</div>
                <div class="cc-integration-path" id="cc-tunnel-url">${tunnelStatus.url || (tunnelStatus.available ? 'Expose MCP via public tunnel' : 'Install cloudflared to enable')}</div>
              </div>
              ${tunnelStatus.available ? '<button class="cc-toggle' + (tunnelStatus.running ? ' on' : '') + '" id="cc-tunnel-toggle"></button>' : ''}
            </div>
            ${tunnelStatus.url ? `<button class="cc-copy-btn" id="cc-tunnel-copy-url" style="margin-top:4px">${copyIcon} Copy MCP URL</button>` : ''}

            <div style="margin-top:10px">
              <div class="cc-integration-item${mcpKeyInfo.hasKey ? ' enabled' : ''}" id="cc-apikey-row">
                <div class="cc-integration-info">
                  <div class="cc-integration-label">API Key</div>
                  <div class="cc-integration-path" id="cc-apikey-status">${mcpKeyInfo.hasKey ? mcpKeyInfo.maskedKey : 'No key \u2014 open'}</div>
                </div>
                <button class="conn-add-btn" id="cc-apikey-generate" style="margin:0;font-size:10px;padding:3px 8px;width:auto;border-style:solid;background:rgba(255,255,255,0.03)">${mcpKeyInfo.hasKey ? 'Regen' : 'Generate'}</button>
              </div>
              <div id="cc-apikey-reveal" style="display:none;margin-top:6px">
                <div style="background:rgba(255,255,255,0.04);padding:6px 8px;border-radius:6px;border:1px solid var(--b-subtle);font-family:'JetBrains Mono',monospace;font-size:10px;word-break:break-all;color:var(--t-bright);line-height:1.5" id="cc-apikey-value"></div>
                <div class="cc-hint" style="margin-top:3px;color:var(--accent-orange);font-size:10px">Save now \u2014 won't show again.</div>
                <div style="margin-top:4px;display:flex;gap:4px">
                  <button class="cc-copy-btn" id="cc-apikey-copy" style="flex:1">${copyIcon} Copy</button>
                  <button class="cc-copy-btn" id="cc-apikey-revoke" style="width:auto;opacity:0.5;padding:4px 8px">Revoke</button>
                </div>
              </div>
              <div class="cc-hint" style="margin-top:4px;font-size:10px"><a href="https://claude.ai/settings/connectors" target="_blank" style="color:var(--accent-blue)">Claude web</a> &rarr; Connectors &rarr; Add MCP</div>
            </div>
          </div>
        </div>

        <!-- 6. BRIDGES -->
        <div class="iface-section collapsed" data-collapsible id="bridge-openclaw">
          <div class="gfx-group-title" style="justify-content:space-between">
            <span style="display:flex;align-items:center;gap:6px">${chevron} Bridges <span class="cc-panel-status ${openclawBridge.enabled ? 'active' : 'inactive'}" style="${openclawBridge.enabled ? 'background:rgba(249,115,22,0.15);color:#f97316' : ''}">${openclawBridge.enabled ? 'Connected' : 'Off'}</span></span>
            ${providerBadge({ cli: true, vscode: true, web: false, cowork: false })}
          </div>
          <div class="cc-section-body">
            <div class="cc-integration-item${openclawBridge.enabled ? ' enabled' : ''}">
              <div class="cc-integration-info">
                <div class="cc-integration-label" ${openclawBridge.enabled ? 'style="color:#f97316"' : ''}>OpenClaw</div>
                <div class="cc-integration-path" id="bridge-openclaw-meta">${
                  openclawBridge.enabled
                    ? (openclawBridge.nodeCount || 0) + ' nodes synced' + (openclawBridge.lastSync ? ' \u00b7 ' + new Date(openclawBridge.lastSync).toLocaleTimeString() : '')
                    : 'Read-only overlay of OpenClaw markdown memories'
                }</div>
              </div>
            </div>
            <div class="cc-panel-actions" id="bridge-openclaw-actions">${
              openclawBridge.enabled
                ? `<button class="cc-enable-btn on" id="bridge-openclaw-sync" style="flex:1">
                    <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;vertical-align:-1px;margin-right:4px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>Sync
                  </button>
                  <button class="cc-disable-btn" id="bridge-openclaw-disconnect">Disconnect</button>`
                : `<button class="cc-enable-btn" id="bridge-openclaw-connect">Connect</button>`
            }</div>
          </div>
        </div>

      </div>`;
}

function buildProjectsTab(ccIntegrations) {
  return `
      <div class="settings-tab-body" data-tab="projects">
        <div class="cc-hint" style="margin-bottom:10px">Per-project hook installations. Each project gets its own <code style="font-size:12px;background:var(--s-medium);padding:2px 5px;border-radius:4px">.claude/settings.json</code> entry.</div>
        <div id="cc-project-list">
          ${ccIntegrations.projects.length === 0
            ? '<div class="cc-hint" style="text-align:center;padding:14px">No projects registered yet.</div>'
            : ccIntegrations.projects.map((p, i) => `
              <div class="cc-panel${p.installed ? ' enabled' : ''}" data-cc-idx="${i}" data-cc-path="${p.path.replace(/"/g, '&quot;')}">
                <div class="cc-panel-header" data-cc-collapse>
                  <svg class="cc-panel-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
                  <span class="cc-panel-title">${p.label}</span>
                  <span class="cc-panel-status ${p.installed ? 'active' : 'inactive'}">${p.installed ? 'Active' : 'Off'}</span>
                </div>
                <div class="cc-panel-body">
                  <div class="cc-panel-row">
                    <span class="cc-panel-row-label">Path</span>
                    <span class="cc-panel-row-value" title="${p.path.replace(/\\/g, '/').replace(/"/g, '&quot;')}">${p.path.replace(/\\/g, '/')}</span>
                  </div>
                  <div class="cc-panel-actions">
                    <button class="cc-explore-btn" data-cc-explore="${i}" style="background:var(--accent-blue-bg);border:1px solid var(--accent-blue-border);color:var(--accent-blue);padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px">Learn it</button>
                    <button class="cc-enable-btn${p.installed ? ' on' : ''}" data-cc-project-toggle="${i}">${p.installed ? 'Enabled' : 'Enable'}</button>
                    <button class="cc-remove-panel-btn" data-cc-remove="${i}">Remove</button>
                  </div>
                </div>
              </div>
            `).join('')}
        </div>
        <button class="conn-add-btn" id="cc-add-project" style="margin-top:8px">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Project
        </button>
      </div>`;
}

function buildMemoryTab() {
  return `
      <div class="settings-tab-body" data-tab="memory">

        <div class="iface-section">
          <div class="gfx-group-title">Recall Token Budget</div>
          <div class="settings-hint" style="margin-bottom:6px">Control how much of each memory is injected into the AI context window. Lower values save tokens and reduce cost per recall.</div>
          <div class="gfx-presets" id="recall-presets">
            <div class="gfx-preset-card" data-recall-preset="150">
              <span class="gfx-preset-name">Brief</span>
              <span class="gfx-preset-desc">~40 tokens per memory</span>
            </div>
            <div class="gfx-preset-card" data-recall-preset="500">
              <span class="gfx-preset-name">Summary</span>
              <span class="gfx-preset-desc">~130 tokens per memory</span>
            </div>
            <div class="gfx-preset-card active" data-recall-preset="0">
              <span class="gfx-preset-name">Full</span>
              <span class="gfx-preset-desc">No truncation</span>
            </div>
          </div>
          <div class="gfx-row" style="margin-top:14px">
            <span class="gfx-label">Limit</span>
            <input type="range" id="recall-slider" min="100" max="2100" step="50" value="2100">
            <span class="gfx-val" id="recall-slider-val">No limit</span>
          </div>
          <div class="recall-preview-box" id="recall-preview"></div>
          <div class="recall-tips">
            <div class="recall-tips-title">When to use each level</div>
            <div class="recall-tip"><span class="recall-tip-tag brief">Brief</span> Routine coding &mdash; quick lookups, bug fixes, simple tasks</div>
            <div class="recall-tip"><span class="recall-tip-tag summary">Summary</span> General development &mdash; feature work, refactoring, reviews</div>
            <div class="recall-tip"><span class="recall-tip-tag full">Full</span> Planning &amp; brainstorming &mdash; architecture decisions, deep context needed</div>
          </div>
        </div>

        <div class="iface-section">
          <div class="gfx-group-title">Memory Sync</div>
          <div class="settings-hint" style="margin-bottom:10px">Scan for memories whose related files have changed since they were last stored. Stale memories may contain outdated information about renamed functions, moved files, or changed APIs.</div>
          <button class="sync-check-btn" id="sync-check-btn">
            <span class="btn-label">Check for stale memories</span>
            <span class="spinner"></span>
          </button>
          <div class="sync-results" id="sync-results"></div>
        </div>

      </div>`;
}

function ifaceSliderRow(key, label, min, max, step, decimals, value) {
  const display = Number(value).toFixed(decimals);
  return `<div class="gfx-row">
    <span class="gfx-label">${label}</span>
    <input type="range" data-iface-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
    <span class="gfx-val" data-iface-val="${key}">${display}</span>
  </div>`;
}

function buildDiscordTab(discordConfig) {
  const c = discordConfig || {};
  const hasToken = !!c.botToken;
  const maskedToken = hasToken ? c.botToken.slice(0, 10) + '...' + c.botToken.slice(-4) : '';

  return `
    <div class="settings-tab-body" data-tab="discord">
      <div class="settings-status">
        <span class="settings-status-dot ${hasToken ? 'connected' : 'disconnected'}"></span>
        ${hasToken ? 'Token configured' : 'Not configured'}
      </div>

      <!-- Bot Connection -->
      <div class="iface-section" data-collapsible>
        <div class="gfx-group-title" style="justify-content:space-between;cursor:pointer">
          <span style="display:flex;align-items:center;gap:6px">
            ${CHEVRON_ICON} Bot Connection
          </span>
          <span id="discord-conn-status" style="font-size:11px;color:var(--t-muted)">${hasToken ? 'configured' : 'missing'}</span>
        </div>
        <div class="cc-section-body">
          <div class="settings-field">
            <label>Bot Token</label>
            <div class="settings-key-row" style="display:flex;gap:6px">
              <input type="password" id="discord-bot-token" value="${escapeHtml(c.botToken || '')}" placeholder="Paste your Discord bot token" autocomplete="off" spellcheck="false" style="flex:1;font-family:monospace;font-size:12px">
              <button class="conn-add-btn discord-eye-btn" id="discord-token-eye" style="margin:0;width:auto;flex:0 0 auto;padding:4px 8px" data-tooltip="Show/hide">${eyeClosed}</button>
              <button class="conn-add-btn" id="discord-token-save" style="margin:0;width:auto;flex:0 0 auto;padding:4px 10px">Save</button>
            </div>
            <div class="settings-hint">Create a bot at <a href="https://discord.com/developers/applications" target="_blank" style="color:var(--accent)">discord.com/developers</a>. Enable MESSAGE CONTENT, SERVER MEMBERS, and PRESENCE intents.</div>
          </div>
          <div class="settings-field">
            <label>Default Guild ID</label>
            <div class="settings-key-row" style="display:flex;gap:6px">
              <input type="text" id="discord-guild-id" value="${escapeHtml(c.guildId || '')}" placeholder="Right-click server > Copy Server ID" autocomplete="off" spellcheck="false" style="flex:1;font-family:monospace;font-size:12px">
              <button class="conn-add-btn" id="discord-guild-save" style="margin:0;width:auto;flex:0 0 auto;padding:4px 10px">Save</button>
            </div>
            <div class="settings-hint">The server Claude Code will manage by default. Enable Developer Mode in Discord to copy IDs.</div>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="conn-add-btn" id="discord-test-btn" style="margin:0">Test Connection</button>
          </div>
          <div id="discord-test-result" style="display:none;margin-top:10px;padding:10px 12px;border-radius:8px;font-size:12px"></div>
        </div>
      </div>

      <!-- Bot Permissions -->
      <div class="iface-section collapsed" data-collapsible>
        <div class="gfx-group-title" style="cursor:pointer">
          <span style="display:flex;align-items:center;gap:6px">
            ${CHEVRON_ICON} Required Permissions
          </span>
        </div>
        <div class="cc-section-body">
          <div class="settings-hint" style="margin-bottom:10px">Your bot needs these permissions to fully manage the server. Use the invite link below or add them manually.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:12px;color:var(--t-secondary)">
            <span>Administrator</span><span style="color:var(--t-muted)">Full access (recommended)</span>
            <span>Manage Server</span><span style="color:var(--t-muted)">Edit server settings</span>
            <span>Manage Channels</span><span style="color:var(--t-muted)">Create/edit/delete channels</span>
            <span>Manage Roles</span><span style="color:var(--t-muted)">Create/edit/assign roles</span>
            <span>Manage Messages</span><span style="color:var(--t-muted)">Pin, delete messages</span>
            <span>Manage Webhooks</span><span style="color:var(--t-muted)">Create/manage webhooks</span>
            <span>Kick/Ban Members</span><span style="color:var(--t-muted)">Moderation actions</span>
            <span>Moderate Members</span><span style="color:var(--t-muted)">Timeout members</span>
            <span>Send Messages</span><span style="color:var(--t-muted)">Post in channels</span>
            <span>Add Reactions</span><span style="color:var(--t-muted)">React to messages</span>
            <span>Read Message History</span><span style="color:var(--t-muted)">View past messages</span>
            <span>View Channels</span><span style="color:var(--t-muted)">See all channels</span>
          </div>
          <div class="settings-field" style="margin-top:12px">
            <label>Bot Invite Link</label>
            <div class="settings-key-row" style="display:flex;gap:6px">
              <input type="text" id="discord-invite-link" value="" readonly style="flex:1;font-size:11px;opacity:0.7;cursor:default" autocomplete="off" spellcheck="false">
              <button class="conn-add-btn" id="discord-invite-copy" style="margin:0;width:auto;flex:0 0 auto;padding:4px 8px" data-tooltip="Copy">${COPY_ICON}</button>
            </div>
            <div class="settings-hint">Permission integer: 8 (Administrator). Change to 1642825033974 for granular permissions.</div>
          </div>
        </div>
      </div>

      <!-- Server Defaults -->
      <div class="iface-section collapsed" data-collapsible>
        <div class="gfx-group-title" style="cursor:pointer">
          <span style="display:flex;align-items:center;gap:6px">
            ${CHEVRON_ICON} Server Defaults
          </span>
        </div>
        <div class="cc-section-body">
          <div class="settings-hint" style="margin-bottom:10px">Default channel and role names used by Discord tools. Leave empty for no default.</div>
          <div class="settings-field">
            <label>Default Category</label>
            <div class="settings-key-row">
              <input type="text" id="discord-default-category" value="${escapeHtml(c.defaultCategory || '')}" placeholder="e.g. General" autocomplete="off" spellcheck="false" data-discord-key="defaultCategory">
            </div>
            <div class="settings-hint">New channels are created under this category by default.</div>
          </div>
          <div class="settings-field">
            <label>Welcome Channel</label>
            <div class="settings-key-row">
              <input type="text" id="discord-welcome-channel" value="${escapeHtml(c.welcomeChannel || '')}" placeholder="e.g. welcome" autocomplete="off" spellcheck="false" data-discord-key="welcomeChannel">
            </div>
          </div>
          <div class="settings-field">
            <label>Rules Channel</label>
            <div class="settings-key-row">
              <input type="text" id="discord-rules-channel" value="${escapeHtml(c.rulesChannel || '')}" placeholder="e.g. rules" autocomplete="off" spellcheck="false" data-discord-key="rulesChannel">
            </div>
          </div>
          <div class="settings-field">
            <label>Log Channel</label>
            <div class="settings-key-row">
              <input type="text" id="discord-log-channel" value="${escapeHtml(c.logChannel || '')}" placeholder="e.g. mod-logs" autocomplete="off" spellcheck="false" data-discord-key="logChannel">
            </div>
            <div class="settings-hint">Where moderation actions are logged.</div>
          </div>
          <div class="settings-field">
            <label>Moderator Role</label>
            <div class="settings-key-row">
              <input type="text" id="discord-mod-role" value="${escapeHtml(c.modRole || '')}" placeholder="e.g. Moderator" autocomplete="off" spellcheck="false" data-discord-key="modRole">
            </div>
          </div>
        </div>
      </div>

      <!-- Moderation Defaults -->
      <div class="iface-section collapsed" data-collapsible>
        <div class="gfx-group-title" style="cursor:pointer">
          <span style="display:flex;align-items:center;gap:6px">
            ${CHEVRON_ICON} Moderation Defaults
          </span>
        </div>
        <div class="cc-section-body">
          <div class="settings-field">
            <label>Ban — Delete Message Days</label>
            <div class="settings-key-row" style="display:flex;gap:6px;align-items:center">
              <input type="number" id="discord-ban-delete-days" value="${c.banDeleteDays || '0'}" min="0" max="7" style="width:70px;text-align:center" data-discord-key="banDeleteDays">
              <span style="font-size:12px;color:var(--t-muted)">days (0-7)</span>
            </div>
            <div class="settings-hint">How many days of messages to delete when banning a user.</div>
          </div>
          <div class="settings-field">
            <label>Timeout — Default Duration</label>
            <div class="settings-key-row" style="display:flex;gap:6px;align-items:center">
              <input type="number" id="discord-timeout-minutes" value="${c.timeoutMinutes || '10'}" min="1" max="40320" style="width:70px;text-align:center" data-discord-key="timeoutMinutes">
              <span style="font-size:12px;color:var(--t-muted)">minutes (max 28 days)</span>
            </div>
            <div class="settings-hint">Default timeout duration when no duration is specified.</div>
          </div>
        </div>
      </div>

      <!-- MCP Tools Reference -->
      <div class="iface-section collapsed" data-collapsible>
        <div class="gfx-group-title" style="cursor:pointer">
          <span style="display:flex;align-items:center;gap:6px">
            ${CHEVRON_ICON} MCP Tools Reference
          </span>
        </div>
        <div class="cc-section-body">
          <div style="font-size:12px;color:var(--t-secondary);display:grid;grid-template-columns:auto 1fr;gap:4px 12px">
            <code style="color:var(--accent)">discord_guild</code><span>Server info, list channels/members/roles, audit log</span>
            <code style="color:var(--accent)">discord_channel</code><span>Create/edit/delete channels, categories, permissions</span>
            <code style="color:var(--accent)">discord_role</code><span>Create/edit/delete roles, assign/remove from members</span>
            <code style="color:var(--accent)">discord_message</code><span>Send/edit/delete/pin/react, bulk delete, list messages</span>
            <code style="color:var(--accent)">discord_member</code><span>Info, kick, ban, unban, timeout, nickname</span>
            <code style="color:var(--accent)">discord_onboarding</code><span>Welcome screen, rules, verification, onboarding</span>
            <code style="color:var(--accent)">discord_webhook</code><span>Create/edit/delete/list/execute webhooks</span>
            <code style="color:var(--accent)">discord_thread</code><span>Create/archive/lock/delete threads</span>
          </div>
          <div class="settings-hint" style="margin-top:10px">All tools use an <code>action</code> parameter. Channel/role/user fields accept names or IDs.</div>
        </div>
      </div>
    </div>`;
}

function buildInterfaceTab() {
  const cfg = loadIfaceConfig();

  // ── Theme preset cards ──
  const presetCards = Object.entries(IFACE_PRESETS).map(([key, p]) => `
    <div class="gfx-preset-card${detectIfacePreset(cfg) === key ? ' active' : ''}" data-iface-preset="${key}">
      <span class="gfx-preset-name">${p.label}</span>
      <span class="gfx-preset-desc">${p.desc}</span>
    </div>
  `).join('');

  // ── Helper: build a section ──
  function section(title, ...rows) {
    return `<div class="iface-section">
      <div class="gfx-group-title">${title}</div>
      ${rows.join('')}
    </div>`;
  }

  // ── Accent color swatch ──
  const swatchColor = `hsl(${cfg.accentHue}, ${cfg.accentSaturation}%, ${cfg.accentLightness}%)`;

  return `
      <div class="settings-tab-body" data-tab="interface">

        <div class="gfx-presets" id="iface-preset-cards" style="margin-bottom:14px">
          ${presetCards}
        </div>

        ${section('Panel Scale',
          `<div class="gfx-row">
            <span class="gfx-label">Scale</span>
            <input type="range" data-iface-key="scale" min="0.5" max="1.5" step="0.01" value="${cfg.scale}">
            <input type="number" id="ui-scale-val" class="gfx-val gfx-val-input" min="50" max="150" step="1" value="${Math.round(cfg.scale * 100)}" title="Type exact % or use arrow keys">
            <span class="gfx-val" style="pointer-events:none;margin-left:-2px">%</span>
          </div>`
        )}

        ${section('Glass & Transparency',
          ifaceSliderRow('glassOpacity', 'Panel Opacity', 0, 1, 0.01, 2, cfg.glassOpacity),
          ifaceSliderRow('glassBlur', 'Backdrop Blur', 0, 80, 1, 0, cfg.glassBlur),
          ifaceSliderRow('glassSaturate', 'Saturation', 0.5, 2.5, 0.1, 1, cfg.glassSaturate),
          ifaceSliderRow('glassBorderOpacity', 'Border Glow', 0, 0.3, 0.01, 2, cfg.glassBorderOpacity),
        )}

        <div class="iface-grid">
          ${section('Shadows',
            ifaceSliderRow('glassShadowOpacity', 'Intensity', 0, 1, 0.01, 2, cfg.glassShadowOpacity),
            ifaceSliderRow('glassShadowSpread', 'Spread', 0, 60, 1, 0, cfg.glassShadowSpread),
          )}
          ${section('Shape & Type',
            ifaceSliderRow('glassRadius', 'Corner Radius', 0, 30, 1, 0, cfg.glassRadius),
            ifaceSliderRow('fontScale', 'Font Scale', 0.7, 1.5, 0.01, 2, cfg.fontScale),
          )}
        </div>

        <div class="iface-section">
          <div class="iface-accent-header">
            <div class="iface-accent-swatch" id="iface-accent-swatch" style="background:${swatchColor}"></div>
            <div class="iface-accent-info">
              <span class="label">Accent Color</span>
              <span class="value" id="iface-accent-hex">${swatchColor}</span>
            </div>
          </div>
          ${ifaceSliderRow('accentHue', 'Hue', 0, 360, 1, 0, cfg.accentHue)}
          ${ifaceSliderRow('accentSaturation', 'Saturation', 0, 100, 1, 0, cfg.accentSaturation)}
          ${ifaceSliderRow('accentLightness', 'Lightness', 20, 80, 1, 0, cfg.accentLightness)}
        </div>

        <div class="iface-section">
          <div class="gfx-group-title">Visualization</div>
          <label class="iface-toggle-row">
            <input type="checkbox" id="iface-viz-toggle" ${cfg.visualizationEnabled !== false ? 'checked' : ''}>
            <span>Graph visualization</span>
          </label>
          <div style="margin-top:4px;opacity:0.5;font-size:11px;color:var(--t-secondary);">
            Press V to toggle Focus Mode. Pauses GPU rendering and shows a calm background.
          </div>
        </div>

        <div class="iface-reset-wrap">
          <button class="gfx-reset-btn" id="iface-reset">Reset All to Defaults</button>
        </div>
      </div>`;
}

/** Detect which preset matches the current config (or null) */
function detectIfacePreset(cfg) {
  for (const [key, preset] of Object.entries(IFACE_PRESETS)) {
    const vals = preset.values;
    const matches = Object.keys(vals).every(k => {
      const a = cfg[k], b = vals[k];
      return Math.abs(a - b) < 0.001;
    });
    if (matches) return key;
  }
  return null;
}

// ═══════════════════════════════════════════
// ICONS TAB — builder + interaction
// ═══════════════════════════════════════════

// Known special filenames for the icon grid
const SPECIAL_FILENAMES = [
  'dockerfile', 'makefile', '.gitignore', '.env', 'readme', 'changelog', 'license',
];

function buildIconsTab(customIcons = {}) {
  const exts = Object.keys(FI_MAP);
  const hasAny = Object.keys(customIcons.extensions || {}).length > 0 || Object.keys(customIcons.filenames || {}).length > 0;

  let cards = '';

  // Extension cards
  for (const ext of exts) {
    const info = FI_MAP[ext];
    const custom = customIcons.extensions?.[ext];
    const hasCustom = !!custom;
    const preview = hasCustom
      ? `<img src="/custom-icons/${escapeHtml(custom.path)}?t=${Date.now()}" alt="${ext}">`
      : `<span class="fe-icon" style="color:${info.c || 'rgba(255,255,255,0.4)'}"><span style="display:flex;align-items:center;justify-content:center;width:24px;height:24px">${FI[info.i]}</span></span>`;

    cards += `<div class="icon-card${hasCustom ? ' has-custom' : ''}" data-icon-type="ext" data-icon-key="${ext}">
      <div class="icon-card-preview">${preview}</div>
      <span class="icon-card-label">.${ext}</span>
      ${hasCustom ? '<span class="icon-card-badge">Custom</span><button class="icon-card-reset" data-reset-type="ext" data-reset-key="' + ext + '">&times;</button>' : ''}
    </div>`;
  }

  // Special filename cards
  for (const fname of SPECIAL_FILENAMES) {
    const custom = customIcons.filenames?.[fname];
    const hasCustom = !!custom;
    const fi = getFileIcon(fname);
    const preview = hasCustom
      ? `<img src="/custom-icons/${escapeHtml(custom.path)}?t=${Date.now()}" alt="${fname}">`
      : fi.img
        ? `<img src="${fi.img}" alt="${fname}">`
        : `<span class="fe-icon" style="color:${fi.color || 'rgba(255,255,255,0.4)'}"><span style="display:flex;align-items:center;justify-content:center;width:24px;height:24px">${fi.svg}</span></span>`;

    cards += `<div class="icon-card${hasCustom ? ' has-custom' : ''}" data-icon-type="name" data-icon-key="${fname}">
      <div class="icon-card-preview">${preview}</div>
      <span class="icon-card-label">${fname}</span>
      ${hasCustom ? '<span class="icon-card-badge">Custom</span><button class="icon-card-reset" data-reset-type="name" data-reset-key="' + fname + '">&times;</button>' : ''}
    </div>`;
  }

  return `
    <div class="settings-tab-body" data-tab="icons">
      <div class="icon-filter-bar">
        <input type="text" id="icon-filter-input" placeholder="Filter extensions..." autocomplete="off" spellcheck="false">
        ${hasAny ? '<button class="conn-add-btn" id="icon-reset-all" style="margin:0;flex:0 0 auto;white-space:nowrap;padding:4px 10px">Reset All</button>' : ''}
      </div>
      <div class="settings-hint" style="margin-bottom:12px">Click any icon to upload a custom replacement. Supports PNG, SVG, JPG, and WebP (max 2 MB).</div>
      <div class="icon-grid">${cards}</div>
      <input type="file" id="icon-upload-input" accept=".png,.svg,.jpg,.jpeg,.webp" style="display:none">
    </div>`;
}

function wireIconsTab(panel, customIcons) {
  let _pendingType = null;
  let _pendingKey = null;

  const fileInput = panel.querySelector('#icon-upload-input');
  const filterInput = panel.querySelector('#icon-filter-input');
  const resetAllBtn = panel.querySelector('#icon-reset-all');

  // Card click → open file picker
  panel.querySelectorAll('.icon-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.icon-card-reset')) return; // let reset handler fire
      _pendingType = card.dataset.iconType;
      _pendingKey = card.dataset.iconKey;
      if (fileInput) { fileInput.value = ''; fileInput.click(); }
    });
  });

  // File selected → upload
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file || !_pendingType || !_pendingKey) return;

      const ct = file.type || 'application/octet-stream';
      try {
        const buf = await file.arrayBuffer();
        const resp = await fetch(`/api/file-icons/${_pendingType}/${_pendingKey}`, {
          method: 'POST',
          headers: { 'Content-Type': ct, 'X-Original-Name': file.name },
          body: buf,
        });
        const data = await resp.json();
        if (data.ok) {
          emit('sync:icons:changed');
          refreshIconsTab(panel);
        } else {
          showCCToast(data.error || 'Upload failed');
        }
      } catch (err) {
        showCCToast('Upload failed: ' + err.message);
      }
    });
  }

  // Reset single icon
  panel.querySelectorAll('.icon-card-reset').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const type = btn.dataset.resetType;
      const key = btn.dataset.resetKey;
      try {
        const resp = await fetch(`/api/file-icons/${type}/${key}`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.ok) {
          emit('sync:icons:changed');
          refreshIconsTab(panel);
        }
      } catch {}
    });
  });

  // Reset all
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/file-icons', { method: 'DELETE' });
        const data = await resp.json();
        if (data.ok) {
          emit('sync:icons:changed');
          refreshIconsTab(panel);
          showCCToast('All custom icons reset');
        }
      } catch {}
    });
  }

  // Filter
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const q = filterInput.value.toLowerCase().trim();
      panel.querySelectorAll('.icon-card').forEach(card => {
        const key = card.dataset.iconKey || '';
        card.style.display = !q || key.includes(q) ? '' : 'none';
      });
    });
  }
}

async function refreshIconsTab(panel) {
  try {
    const resp = await fetch('/api/file-icons').then(r => r.json());
    if (!resp.ok) return;
    const tabBody = panel.querySelector('.settings-tab-body[data-tab="icons"]');
    if (!tabBody) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = buildIconsTab(resp.custom);
    const newBody = tmp.querySelector('.settings-tab-body[data-tab="icons"]');
    if (newBody) {
      tabBody.innerHTML = newBody.innerHTML;
      wireIconsTab(panel, resp.custom);
    }
  } catch {}
}

// ═══════════════════════════════════════════
// MAIN ENTRY — openSettingsModal
// ═══════════════════════════════════════════

export async function openSettingsModal() {
  // If already open, just bring it to front
  const existing = document.getElementById('settings-panel');
  if (existing) { existing.style.zIndex = '300001'; return; }

  // ── Fetch all data in parallel ──
  let settings = {};
  let connections = [];
  let ccIntegrations = { global: { installed: false }, projects: [] };
  let ccSkills = [];
  let tunnelStatus = { available: false, running: false, url: null };
  let mcpKeyInfo = { hasKey: false };
  let _bridgeResult = null;
  let greetingConfig = { defaults: {}, projects: {}, global: {} };
  let setupStatus = { claude: {}, gemini: {}, codex: {}, paths: {} };
  let cliConfig = {};
  let toolPermissions = {};
  let toolCategories = [];
  let discordConfig = {};
  let skinsData = { skins: [], active: 'default' };
  let customIconsData = { extensions: {}, filenames: {} };

  try {
    const [settingsRes, connRes, ccRes, skillsRes, tunnelRes, keyRes, bridgeRes, greetRes, setupRes, cliRes, toolPermsRes, toolCatsRes, discordRes, skinsRes, iconsRes] = await Promise.allSettled([
      fetch('/api/settings').then(r => r.json()),
      fetch('/api/connections').then(r => r.json()),
      fetch('/api/claude-code/integrations').then(r => r.json()),
      fetch('/api/claude-code/skills').then(r => r.json()),
      fetch('/api/tunnel/status').then(r => r.json()),
      fetch('/api/mcp-key').then(r => r.json()),
      fetch('/api/bridges/openclaw').then(r => r.json()),
      fetch('/api/greeting/config').then(r => r.json()),
      fetch('/api/setup/status').then(r => r.json()),
      fetch('/api/cli/config').then(r => r.json()),
      fetch('/api/claude-code/tool-permissions').then(r => r.json()),
      fetch('/api/claude-code/tool-categories').then(r => r.json()),
      fetch('/api/discord/config').then(r => r.json()),
      fetch('/api/skins').then(r => r.json()),
      fetch('/api/file-icons').then(r => r.json()),
    ]);
    if (settingsRes.status === 'fulfilled') settings = settingsRes.value;
    if (connRes.status === 'fulfilled' && connRes.value.connections) connections = connRes.value.connections;
    if (ccRes.status === 'fulfilled' && ccRes.value.ok) ccIntegrations = ccRes.value;
    if (skillsRes.status === 'fulfilled' && skillsRes.value.ok) ccSkills = skillsRes.value.skills || [];
    if (tunnelRes.status === 'fulfilled' && tunnelRes.value.ok) tunnelStatus = tunnelRes.value;
    if (keyRes.status === 'fulfilled' && keyRes.value.ok) mcpKeyInfo = keyRes.value;
    if (bridgeRes.status === 'fulfilled' && bridgeRes.value.ok) _bridgeResult = bridgeRes.value;
    if (greetRes.status === 'fulfilled' && greetRes.value.ok) greetingConfig = greetRes.value.config;
    if (setupRes.status === 'fulfilled' && setupRes.value.ok) setupStatus = setupRes.value;
    if (cliRes.status === 'fulfilled' && cliRes.value.ok) cliConfig = cliRes.value.config;
    if (toolPermsRes.status === 'fulfilled' && toolPermsRes.value.ok) toolPermissions = toolPermsRes.value.tools;
    if (toolCatsRes.status === 'fulfilled' && toolCatsRes.value.ok) toolCategories = toolCatsRes.value.categories;
    if (discordRes.status === 'fulfilled' && discordRes.value.ok) discordConfig = discordRes.value.config;
    if (skinsRes.status === 'fulfilled' && skinsRes.value.ok) skinsData = skinsRes.value;
    if (iconsRes.status === 'fulfilled' && iconsRes.value.ok) customIconsData = iconsRes.value.custom;
  } catch {}
  let openclawBridge = _bridgeResult || { enabled: false };

  // ── Gather variant-registered settings tabs ──
  const variantTabs = getSettingsTabs();

  // ── Panel ──
  const overlay = document.createElement('div');
  overlay.className = 'settings-panel glass resizable';
  overlay.id = 'settings-panel';

  // Always open centered at default size
  overlay.style.left = Math.max(20, (window.innerWidth - 720) / 2) + 'px';
  overlay.style.top = Math.max(48, (window.innerHeight - 500) / 2) + 'px';

  // ── Build variant tab bodies ──
  let variantTabBodies = '';
  for (const tab of variantTabs) {
    variantTabBodies += `<div class="settings-tab-body" data-tab="${tab.id}">${tab.build()}</div>\n`;
  }

  // ── Assemble HTML ──
  overlay.innerHTML = `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>
    <div class="settings-panel-header drag-handle" data-drag="settings-panel">
      <div class="stg-header-left">
        <h3>Settings</h3>
        <span class="stg-status-badge">
          <span class="stg-status-dot ${settings.storage === 'sqlite' ? 'connected' : 'disconnected'}"></span>
          SQLite
        </span>
      </div>
      <button class="settings-panel-close" id="stg-close" data-tooltip="Close">&times;</button>
    </div>
    <div class="settings-panel-body">
      <nav class="settings-nav">
        ${buildNavHTML(variantTabs, {
          server: settings.storage === 'sqlite' ? 'connected' : 'disconnected',
          setup: (setupStatus.claude?.connected || setupStatus.gemini?.connected || setupStatus.codex?.connected) ? 'connected' : 'disconnected',
          discord: discordConfig.botToken ? 'connected' : 'disconnected',
        })}
      </nav>
      <div class="settings-content">
        ${buildServerTab(settings)}
        ${buildConnectionsTab(ccIntegrations, ccSkills, tunnelStatus, mcpKeyInfo, openclawBridge, greetingConfig, toolPermissions, toolCategories)}
        ${buildTerminalTab(cliConfig)}
        ${buildSetupTab(setupStatus)}
        ${buildCollectionsTab(connections, settings)}
        ${buildProjectsTab(ccIntegrations)}
        ${buildMemoryTab()}
        ${buildSkillsTab(ccSkills)}
        ${buildDiscordTab(discordConfig)}
        ${buildPermissionsTab(toolCategories, toolPermissions)}
        ${buildSocialTab(toolCategories, toolPermissions)}
        ${buildSkinsTab(skinsData.skins, skinsData.active)}
        ${buildInterfaceTab()}
        ${buildIconsTab(customIconsData)}
        ${variantTabBodies}
      </div>
    </div>
  `;

  // ── Backdrop ──
  const backdrop = document.createElement('div');
  backdrop.className = 'studio-backdrop';
  backdrop.addEventListener('click', () => close());
  document.body.appendChild(backdrop);

  document.body.appendChild(overlay);

  // ── Open animation (matches Skills/Automation Studio) ──
  requestAnimationFrame(() => { backdrop.classList.add('open'); overlay.classList.add('open'); });

  // ── Focus mode ──
  let _focusMode = false;
  const focusBtn = overlay.querySelector('#stg-focus');
  if (focusBtn) {
    focusBtn.addEventListener('click', () => {
      _focusMode = !_focusMode;
      focusBtn.classList.toggle('active', _focusMode);
    });
  }

  // ── Close helper ──
  const close = () => {
    backdrop.remove();
    overlay.remove();
  };

  // ── Nav switching ──
  overlay.querySelectorAll('.settings-nav-item').forEach(nav => {
    nav.addEventListener('click', () => {
      overlay.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
      overlay.querySelectorAll('.settings-tab-body').forEach(b => b.classList.remove('active'));
      nav.classList.add('active');
      overlay.querySelector(`.settings-tab-body[data-tab="${nav.dataset.tab}"]`).classList.add('active');
    });
  });

  // ── Interface customization suite ──
  {
    let ifaceCfg = loadIfaceConfig();

    // Helper: update all slider displays + swatch from current config
    function syncIfaceUI() {
      overlay.querySelectorAll('input[data-iface-key]').forEach(slider => {
        const key = slider.dataset.ifaceKey;
        if (ifaceCfg[key] != null) slider.value = ifaceCfg[key];
      });
      // Update value labels
      for (const [, sliders] of Object.entries(IFACE_SLIDERS)) {
        for (const [key, , , , , decimals] of sliders) {
          const valEl = overlay.querySelector(`[data-iface-val="${key}"]`);
          if (valEl) valEl.textContent = Number(ifaceCfg[key]).toFixed(decimals);
        }
      }
      // Accent color labels
      for (const k of ['accentHue', 'accentSaturation', 'accentLightness']) {
        const valEl = overlay.querySelector(`[data-iface-val="${k}"]`);
        if (valEl) valEl.textContent = Math.round(ifaceCfg[k]);
      }
      // Scale number input
      const scaleNumEl = overlay.querySelector('#ui-scale-val');
      if (scaleNumEl) scaleNumEl.value = Math.round(ifaceCfg.scale * 100);
      // Accent swatch
      const swatch = overlay.querySelector('#iface-accent-swatch');
      const hexLabel = overlay.querySelector('#iface-accent-hex');
      const color = `hsl(${ifaceCfg.accentHue}, ${ifaceCfg.accentSaturation}%, ${ifaceCfg.accentLightness}%)`;
      if (swatch) swatch.style.background = color;
      if (hexLabel) hexLabel.textContent = color;
      // Visualization toggle checkbox
      const vizCb = overlay.querySelector('#iface-viz-toggle');
      if (vizCb) vizCb.checked = ifaceCfg.visualizationEnabled !== false;
      // Preset card active state
      const activePreset = detectIfacePreset(ifaceCfg);
      overlay.querySelectorAll('[data-iface-preset]').forEach(card => {
        card.classList.toggle('active', card.dataset.ifacePreset === activePreset);
      });
    }

    // Range sliders
    overlay.querySelectorAll('input[data-iface-key]').forEach(slider => {
      slider.addEventListener('input', () => {
        const key = slider.dataset.ifaceKey;
        ifaceCfg[key] = parseFloat(slider.value);
        applyIfaceConfig(ifaceCfg);
        saveIfaceConfig(ifaceCfg);
        syncIfaceUI();
      });
    });

    // Scale number input (special: percent ↔ decimal)
    const scaleNumInput = overlay.querySelector('#ui-scale-val');
    if (scaleNumInput) {
      scaleNumInput.addEventListener('change', () => {
        const pct = Math.max(50, Math.min(150, parseInt(scaleNumInput.value) || 100));
        scaleNumInput.value = pct;
        ifaceCfg.scale = pct / 100;
        applyIfaceConfig(ifaceCfg);
        saveIfaceConfig(ifaceCfg);
        syncIfaceUI();
      });
    }

    // Theme preset cards
    overlay.querySelectorAll('[data-iface-preset]').forEach(card => {
      card.addEventListener('click', () => {
        const presetKey = card.dataset.ifacePreset;
        const preset = IFACE_PRESETS[presetKey];
        if (!preset) return;
        ifaceCfg = { ...ifaceCfg, ...preset.values };
        applyIfaceConfig(ifaceCfg);
        saveIfaceConfig(ifaceCfg);
        syncIfaceUI();
      });
    });

    // Visualization toggle
    const vizToggle = overlay.querySelector('#iface-viz-toggle');
    if (vizToggle) {
      vizToggle.addEventListener('change', () => {
        ifaceCfg.visualizationEnabled = vizToggle.checked;
        applyIfaceConfig(ifaceCfg);
        saveIfaceConfig(ifaceCfg);
      });
    }

    // Reset button
    const resetBtn = overlay.querySelector('#iface-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        ifaceCfg = { ...IFACE_DEFAULTS };
        applyIfaceConfig(ifaceCfg);
        saveIfaceConfig(ifaceCfg);
        syncIfaceUI();
      });
    }
  }

  // ── Toggle visibility buttons (eye icon) ──
  overlay.querySelectorAll('.settings-toggle-vis').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = overlay.querySelector('#' + btn.dataset.target);
      if (!input) return;
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.innerHTML = isPassword ? eyeOpen : eyeClosed;
    });
  });

  // ── Close handlers ──
  overlay.querySelector('#stg-close').addEventListener('click', close);

  // ── Move Database handlers ──
  const moveBrowseBtn = overlay.querySelector('#stg-db-browse-btn');
  const moveBtn = overlay.querySelector('#stg-db-move-btn');

  if (moveBrowseBtn) {
    const dbBrowserEl = overlay.querySelector('#stg-db-browser');
    const dbPathInput = overlay.querySelector('#stg-db-path');

    async function loadDbDir(dirPath) {
      dbBrowserEl.style.display = 'block';
      dbBrowserEl.innerHTML = '<div style="padding:10px;color:var(--t-muted);font-size:12px">Loading...</div>';
      try {
        const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
        const res = await fetch(`/api/browse-directory${qs}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);

        let html = '<div style="padding:6px 10px;font-size:11px;color:var(--t-muted);border-bottom:1px solid var(--s-medium);display:flex;align-items:center;justify-content:space-between">'
          + `<span style="font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(data.current)}</span>`
          + '<button id="stg-db-browse-select" style="flex:0 0 auto;padding:3px 10px;background:var(--accent-blue-bg);border:1px solid var(--accent-blue-border);color:var(--accent-blue);border-radius:4px;cursor:pointer;font-size:11px">Select</button>'
          + '</div>';
        html += '<div style="padding:4px 0">';
        if (data.parent) {
          html += `<div class="cc-browse-item" data-path="${escapeHtml(data.parent)}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;color:var(--t-muted)">`
            + '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><polyline points="15 18 9 12 15 6"/></svg>'
            + '.. (parent)</div>';
        }
        for (const d of data.directories) {
          html += `<div class="cc-browse-item" data-path="${escapeHtml(data.current + '/' + d)}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px">`
            + '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
            + escapeHtml(d) + '</div>';
        }
        if (data.directories.length === 0 && !data.parent) {
          html += '<div style="padding:8px 10px;color:var(--t-muted);font-size:12px">No subdirectories</div>';
        }
        html += '</div>';
        dbBrowserEl.innerHTML = html;

        dbBrowserEl.querySelector('#stg-db-browse-select').addEventListener('click', () => {
          dbPathInput.value = data.current.replace(/\\/g, '/') + '/memory.db';
          dbBrowserEl.style.display = 'none';
        });

        dbBrowserEl.querySelectorAll('.cc-browse-item').forEach(item => {
          item.addEventListener('mouseenter', () => item.style.background = 'var(--s-medium)');
          item.addEventListener('mouseleave', () => item.style.background = '');
          item.addEventListener('click', () => loadDbDir(item.dataset.path));
        });
      } catch (err) {
        dbBrowserEl.innerHTML = `<div style="padding:10px;color:var(--accent-dim);font-size:12px">Error: ${escapeHtml(err.message)}</div>`;
      }
    }

    moveBrowseBtn.addEventListener('click', () => {
      if (dbBrowserEl.style.display === 'block') {
        dbBrowserEl.style.display = 'none';
        return;
      }
      // Start browsing from current path's directory, or home
      const currentVal = (dbPathInput.value || '').trim();
      const startDir = currentVal ? currentVal.replace(/[/\\][^/\\]*$/, '') : '';
      loadDbDir(startDir);
    });
  }

  if (moveBtn) {
    moveBtn.addEventListener('click', async () => {
      const pathInput = overlay.querySelector('#stg-db-path');
      const newPath = (pathInput?.value || '').trim();
      const statusEl = overlay.querySelector('#stg-db-move-status');
      const cleanupEl = overlay.querySelector('#stg-db-move-cleanup');
      const hintEl = overlay.querySelector('#stg-db-hint');

      if (!newPath) return;

      // Extract directory from the path (user may type full path with memory.db or just a dir)
      const newDir = newPath.endsWith('memory.db') ? newPath.replace(/[/\\]memory\.db$/, '') : newPath;

      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<div class="wiz-status-dot spin" style="display:inline-block"></div> Moving database...';
      moveBtn.disabled = true;

      try {
        const res = await fetch('/api/settings/move-db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPath: newDir }),
        });
        const data = await res.json();

        if (data.ok) {
          statusEl.style.display = 'none';
          if (hintEl) hintEl.textContent = 'Moved successfully';
          if (pathInput) pathInput.value = data.newDbPath;
          cleanupEl.style.display = 'block';
          cleanupEl.dataset.oldPath = data.oldDbPath;
        } else {
          statusEl.innerHTML = `<span style="color:var(--red)">Error: ${data.error}</span>`;
          moveBtn.disabled = false;
        }
      } catch (err) {
        statusEl.innerHTML = `<span style="color:var(--red)">Error: ${err.message}</span>`;
        moveBtn.disabled = false;
      }
    });

    // Delete old files
    const deleteOldBtn = overlay.querySelector('#stg-db-delete-old');
    if (deleteOldBtn) {
      deleteOldBtn.addEventListener('click', async () => {
        const cleanupEl = overlay.querySelector('#stg-db-move-cleanup');
        const oldPath = cleanupEl?.dataset.oldPath;
        if (!oldPath) return;
        deleteOldBtn.disabled = true;
        deleteOldBtn.textContent = 'Deleting...';
        try {
          await fetch('/api/settings/move-db/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPath }),
          });
        } catch {}
        cleanupEl.style.display = 'none';
      });
    }

    const keepOldBtn = overlay.querySelector('#stg-db-keep-old');
    if (keepOldBtn) {
      keepOldBtn.addEventListener('click', () => {
        const cleanupEl = overlay.querySelector('#stg-db-move-cleanup');
        if (cleanupEl) cleanupEl.style.display = 'none';
      });
    }
  }

  // ── Reindex handlers ──
  const reindexBtn = overlay.querySelector('#reindex-btn');
  const reindexCancelBtn = overlay.querySelector('#reindex-cancel-btn');

  let _reindexPoll = null;

  if (reindexBtn) {
    reindexBtn.addEventListener('click', async () => {
      const statusEl = overlay.querySelector('#reindex-status');
      const textEl = overlay.querySelector('#reindex-text');
      const barEl = overlay.querySelector('#reindex-bar');
      const summaryEl = overlay.querySelector('#reindex-summary');
      const dotEl = overlay.querySelector('#reindex-dot');

      try {
        const res = await fetch('/api/settings/reindex', { method: 'POST' });
        const data = await res.json();
        if (!data.ok) {
          if (textEl) textEl.textContent = `Error: ${data.error}`;
          if (statusEl) statusEl.style.display = 'block';
          return;
        }

        reindexBtn.disabled = true;
        if (reindexCancelBtn) reindexCancelBtn.style.display = '';
        if (statusEl) statusEl.style.display = 'block';
        if (textEl) textEl.textContent = 'Starting reindex...';
        if (dotEl) dotEl.className = 'wiz-status-dot spin';

        _reindexPoll = setInterval(async () => {
          try {
            const sr = await fetch('/api/settings/reindex/status');
            const sd = await sr.json();

            if (!sd.running) {
              clearInterval(_reindexPoll);
              _reindexPoll = null;
              if (dotEl) dotEl.className = 'wiz-status-dot ' + (sd.cancelled ? 'yellow' : 'green');
              if (textEl) textEl.textContent = sd.cancelled ? 'Reindex cancelled.' : 'Reindex complete!';
              if (barEl) barEl.style.width = sd.cancelled ? barEl.style.width : '100%';
              if (summaryEl) summaryEl.textContent = `${sd.completed} memories + ${sd.chunks} session chunks processed, ${sd.errors} error${sd.errors !== 1 ? 's' : ''}`;
              reindexBtn.disabled = false;
              if (reindexCancelBtn) reindexCancelBtn.style.display = 'none';
              return;
            }

            const pct = sd.total > 0 ? Math.round((sd.completed / sd.total) * 100) : 0;
            if (textEl) textEl.textContent = `Processing ${sd.completed} / ${sd.total} memories...`;
            if (barEl) barEl.style.width = `${pct}%`;
            if (summaryEl) summaryEl.textContent = `${sd.chunks} / ${sd.totalChunks} session chunks, ${sd.errors} error${sd.errors !== 1 ? 's' : ''}`;
          } catch {}
        }, 800);
      } catch (err) {
        if (textEl) textEl.textContent = `Error: ${err.message}`;
        if (statusEl) statusEl.style.display = 'block';
      }
    });
  }

  if (reindexCancelBtn) {
    reindexCancelBtn.addEventListener('click', async () => {
      reindexCancelBtn.disabled = true;
      const textEl = overlay.querySelector('#reindex-text');
      if (textEl) textEl.textContent = 'Cancelling...';
      try {
        await fetch('/api/settings/reindex/cancel', { method: 'POST' });
      } catch {}
    });
  }

  // ── System Backup & Restore handlers ──

  const backupBtn = overlay.querySelector('#sys-backup-btn');
  const restoreBtn = overlay.querySelector('#sys-restore-btn');
  const restoreFileInput = overlay.querySelector('#sys-restore-file');

  if (backupBtn) {
    backupBtn.addEventListener('click', async () => {
      const statusEl = overlay.querySelector('#sys-backup-status');
      const statusDot = overlay.querySelector('#sys-backup-dot');
      const statusText = overlay.querySelector('#sys-backup-text');

      backupBtn.disabled = true;
      const origHTML = backupBtn.innerHTML;
      backupBtn.textContent = 'Creating backup...';
      statusEl.style.display = 'flex';
      statusDot.className = 'wiz-status-dot spin';
      statusText.textContent = 'Collecting files and creating database backup...';

      try {
        const res = await fetch('/api/system/backup');
        if (!res.ok) {
          let errMsg = 'Backup failed';
          try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
          throw new Error(errMsg);
        }
        const blob = await res.blob();
        const disposition = res.headers.get('content-disposition') || '';
        const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
        const filename = filenameMatch ? filenameMatch[1] : 'synabun-backup.zip';

        // Trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);

        statusDot.className = 'wiz-status-dot green';
        statusText.textContent = `Backup saved: ${filename} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`;
      } catch (err) {
        statusDot.className = 'wiz-status-dot red';
        statusText.textContent = 'Backup failed: ' + err.message;
      } finally {
        backupBtn.disabled = false;
        backupBtn.innerHTML = origHTML;
      }
    });
  }

  if (restoreBtn && restoreFileInput) {
    restoreBtn.addEventListener('click', () => restoreFileInput.click());

    restoreFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';

      const statusEl = overlay.querySelector('#sys-backup-status');
      const statusDot = overlay.querySelector('#sys-backup-dot');
      const statusText = overlay.querySelector('#sys-backup-text');

      statusEl.style.display = 'flex';
      statusDot.className = 'wiz-status-dot spin';
      statusText.textContent = 'Reading backup file...';

      try {
        const buffer = await file.arrayBuffer();

        // Preview first
        statusText.textContent = 'Validating backup...';
        const previewRes = await fetch('/api/system/restore/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: buffer,
        });
        if (!previewRes.ok) {
          let errMsg = 'Invalid backup';
          try { const body = await previewRes.json(); errMsg = body.error || errMsg; } catch {}
          throw new Error(errMsg);
        }
        const { manifest: m } = await previewRes.json();

        statusEl.style.display = 'none';

        const fileCount = (m.files || []).length;
        const hasDb = !!m.database;

        const confirmOverlay = document.createElement('div');
        confirmOverlay.className = 'tag-delete-overlay';
        confirmOverlay.style.zIndex = '50200';
        confirmOverlay.innerHTML = `
          <div class="tag-delete-modal settings-modal" style="max-width:500px;text-align:left">
            <h3 style="margin-bottom:4px">Restore Backup</h3>
            <p style="font-size:11px;color:var(--t-muted);margin-bottom:12px">
              Created: ${new Date(m.created).toLocaleString()} on ${escapeHtml(m.hostname || 'unknown')}
            </p>
            <div style="font-size:12px;margin-bottom:8px">
              <strong>${fileCount}</strong> config files
              ${hasDb ? `<br><strong>Database:</strong> memory.db included` : ''}
            </div>
            <p style="font-size:11px;color:var(--accent-dim);margin-bottom:12px">
              This will overwrite your current .env, data files, and memory database.
              This action cannot be undone.
            </p>
            <div class="tag-delete-modal-actions">
              <button class="action-btn action-btn--ghost" id="sys-restore-cancel">Cancel</button>
              <button class="action-btn action-btn--danger" id="sys-restore-confirm"
                style="background:var(--accent-blue-bg);border-color:var(--accent-blue-border);color:var(--accent-blue)">
                Restore
              </button>
            </div>
            <div id="sys-restore-progress" style="display:none;margin-top:10px;font-size:12px;align-items:center;gap:8px">
              <div class="wiz-status-dot spin" id="sys-restore-dot"></div>
              <span id="sys-restore-text"></span>
            </div>
          </div>`;
        document.body.appendChild(confirmOverlay);

        confirmOverlay.querySelector('#sys-restore-cancel').addEventListener('click', () => confirmOverlay.remove());
        confirmOverlay.addEventListener('click', (ev) => {
          if (ev.target === confirmOverlay) confirmOverlay.remove();
        });

        confirmOverlay.querySelector('#sys-restore-confirm').addEventListener('click', async () => {
          const confirmBtn = confirmOverlay.querySelector('#sys-restore-confirm');
          const progressEl = confirmOverlay.querySelector('#sys-restore-progress');
          const progressDot = confirmOverlay.querySelector('#sys-restore-dot');
          const progressText = confirmOverlay.querySelector('#sys-restore-text');

          confirmBtn.textContent = 'Restoring...';
          confirmBtn.disabled = true;
          progressEl.style.display = 'flex';
          progressDot.className = 'wiz-status-dot spin';
          progressText.textContent = 'Applying backup...';

          try {
            const restoreRes = await fetch('/api/system/restore?mode=full', {
              method: 'POST',
              headers: { 'Content-Type': 'application/zip' },
              body: buffer,
            });
            if (!restoreRes.ok) {
              let errMsg = 'Restore failed';
              try { const body = await restoreRes.json(); errMsg = body.error || errMsg; } catch {}
              throw new Error(errMsg);
            }
            const result = await restoreRes.json();
            const restoredFileCount = result.results?.files?.length || 0;

            progressDot.className = 'wiz-status-dot green';
            progressText.textContent = `Done! ${restoredFileCount} files restored.`;
            confirmBtn.textContent = 'Done';

            setTimeout(() => { confirmOverlay.remove(); location.reload(); }, 2500);
          } catch (err) {
            progressDot.className = 'wiz-status-dot red';
            progressText.textContent = err.message;
            confirmBtn.textContent = 'Restore';
            confirmBtn.disabled = false;
          }
        });
      } catch (err) {
        statusDot.className = 'wiz-status-dot red';
        statusText.textContent = 'Invalid backup: ' + err.message;
      }
    });
  }

  // ══════════════════════════════════════
  // Memory tab: Recall response size
  // ══════════════════════════════════════
  const recallSlider = overlay.querySelector('#recall-slider');
  const recallSliderVal = overlay.querySelector('#recall-slider-val');
  const recallPreview = overlay.querySelector('#recall-preview');
  const recallPresets = overlay.querySelector('#recall-presets');
  const PREVIEW_TEXT = 'SynaBun is a persistent vector memory system for AI assistants built with three core components: MCP Server (TypeScript/Node.js), Neural Interface (Express.js + Three.js), and SQLite with local embeddings. It stores memory vectors in a single database with cosine similarity and supports multiple projects.';

  function updateRecallUI(maxChars) {
    recallSlider.value = maxChars === 0 ? 2100 : Math.min(maxChars, 2100);
    recallSliderVal.textContent = maxChars === 0 ? 'No limit' : maxChars + ' chars';
    recallPresets.querySelectorAll('.gfx-preset-card').forEach(c => {
      c.classList.toggle('active', String(maxChars) === c.dataset.recallPreset);
    });
    if (maxChars > 0 && PREVIEW_TEXT.length > maxChars) {
      recallPreview.textContent = PREVIEW_TEXT.substring(0, maxChars) + '...';
    } else {
      recallPreview.textContent = PREVIEW_TEXT;
    }
  }

  async function saveRecallSetting(maxChars) {
    try {
      await fetch('/api/display-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recallMaxChars: maxChars }),
      });
    } catch (e) {
      console.error('Failed to save display settings:', e);
    }
  }

  // Load current setting
  fetch('/api/display-settings').then(r => r.json()).then(data => {
    updateRecallUI(data.recallMaxChars ?? 0);
  }).catch(() => updateRecallUI(0));

  // Preset clicks
  recallPresets.querySelectorAll('.gfx-preset-card').forEach(card => {
    card.addEventListener('click', () => {
      const val = parseInt(card.dataset.recallPreset, 10);
      updateRecallUI(val);
      saveRecallSetting(val);
    });
  });

  // Slider changes
  recallSlider.addEventListener('input', () => {
    const raw = parseInt(recallSlider.value, 10);
    const val = raw >= 2100 ? 0 : raw;
    updateRecallUI(val);
    saveRecallSetting(val);
  });

  // Sync button
  const syncBtn = overlay.querySelector('#sync-check-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => checkSyncStatus());
  }

  // ══════════════════════════════════════
  // OpenClaw Bridge handlers
  // ══════════════════════════════════════

  function attachBridgeSyncHandler(container) {
    const syncBtn = container.querySelector('#bridge-openclaw-sync');
    if (!syncBtn) return;
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true; const origHTML = syncBtn.innerHTML; syncBtn.textContent = 'Syncing\u2026';
      try {
        const res = await fetch('/api/bridges/openclaw/sync', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          const metaEl = container.querySelector('#bridge-openclaw-meta');
          if (metaEl) metaEl.textContent = (data.nodes || 0) + ' nodes synced \u00b7 ' + new Date().toLocaleTimeString();
          emit('data:reload');
        } else { alert(data.error || 'Sync failed'); }
      } catch (err) { alert('Sync failed: ' + err.message); }
      finally { syncBtn.disabled = false; syncBtn.innerHTML = origHTML; }
    });
  }

  function attachBridgeDisconnectHandler(container, closeFn) {
    const disconnectBtn = container.querySelector('#bridge-openclaw-disconnect');
    if (!disconnectBtn) return;
    disconnectBtn.addEventListener('click', async () => {
      if (!confirm('Disconnect OpenClaw bridge? Memories will be removed from the graph.')) return;
      try {
        await fetch('/api/bridges/openclaw', { method: 'DELETE' });
        emit('data:reload');
        const bridgeEl = container.querySelector('#bridge-openclaw');
        if (bridgeEl) bridgeEl.classList.remove('enabled');
        const titleEl = bridgeEl?.querySelector('.cc-panel-title');
        if (titleEl) titleEl.style.color = '';
        const statusEl = bridgeEl?.querySelector('.cc-panel-status');
        if (statusEl) { statusEl.textContent = 'Off'; statusEl.className = 'cc-panel-status inactive'; statusEl.style.background = ''; statusEl.style.color = ''; }
        const integItem = bridgeEl?.querySelector('.cc-integration-item');
        if (integItem) integItem.classList.remove('enabled');
        const metaEl = container.querySelector('#bridge-openclaw-meta');
        if (metaEl) metaEl.textContent = 'Read-only overlay of OpenClaw markdown memories';
        const actionsEl = container.querySelector('#bridge-openclaw-actions');
        if (actionsEl) {
          actionsEl.innerHTML = `<button class="cc-enable-btn" id="bridge-openclaw-connect">Connect</button>`;
          const newConnBtn = actionsEl.querySelector('#bridge-openclaw-connect');
          if (newConnBtn) newConnBtn.addEventListener('click', () => { if (closeFn) closeFn(); openSettingsModal(); });
        }
      } catch (err) { alert('Disconnect failed: ' + err.message); }
    });
  }

  const ocConnectBtn = overlay.querySelector('#bridge-openclaw-connect');
  if (ocConnectBtn) {
    ocConnectBtn.addEventListener('click', async () => {
      ocConnectBtn.disabled = true; ocConnectBtn.textContent = 'Connecting\u2026';
      try {
        const res = await fetch('/api/bridges/openclaw/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (data.ok) {
          emit('data:reload');
          const bridgeEl = overlay.querySelector('#bridge-openclaw');
          if (bridgeEl) bridgeEl.classList.add('enabled');
          const titleEl = bridgeEl?.querySelector('.cc-panel-title');
          if (titleEl) titleEl.style.color = '#f97316';
          const statusEl = bridgeEl?.querySelector('.cc-panel-status');
          if (statusEl) { statusEl.textContent = 'Connected'; statusEl.className = 'cc-panel-status active'; statusEl.style.background = 'rgba(249,115,22,0.15)'; statusEl.style.color = '#f97316'; }
          const integItem = bridgeEl?.querySelector('.cc-integration-item');
          if (integItem) integItem.classList.add('enabled');
          const metaEl = overlay.querySelector('#bridge-openclaw-meta');
          if (metaEl) metaEl.textContent = (data.nodes || 0) + ' nodes synced' + (data.nodes > 0 ? ' \u00b7 ' + new Date().toLocaleTimeString() : '');
          const actionsEl = overlay.querySelector('#bridge-openclaw-actions');
          if (actionsEl) {
            actionsEl.innerHTML = `<button class="cc-enable-btn on" id="bridge-openclaw-sync" style="flex:1"><svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;vertical-align:-1px;margin-right:4px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>Sync</button><button class="cc-disable-btn" id="bridge-openclaw-disconnect">Disconnect</button>`;
            attachBridgeSyncHandler(overlay);
            attachBridgeDisconnectHandler(overlay, close);
          }
        } else { alert(data.error || 'Failed to connect'); ocConnectBtn.disabled = false; ocConnectBtn.textContent = 'Connect'; }
      } catch (err) { alert('Failed: ' + err.message); ocConnectBtn.disabled = false; ocConnectBtn.textContent = 'Connect'; }
    });
  }
  attachBridgeSyncHandler(overlay);
  attachBridgeDisconnectHandler(overlay, close);

  // ══════════════════════════════════════
  // Claude Code tab handlers
  // ══════════════════════════════════════

  // Collapsible panel headers
  overlay.querySelectorAll('[data-cc-collapse]').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.cc-panel-actions')) return;
      const panel = header.closest('.cc-panel');
      if (panel) panel.classList.toggle('open');
    });
  });

  // Collapsible iface-section cards (Automations tab) — click anywhere on the card
  overlay.querySelectorAll('.iface-section[data-collapsible]').forEach(section => {
    section.addEventListener('click', (e) => {
      if (e.target.closest('select, input, button, textarea, a, .cc-section-body')) return;
      section.classList.toggle('collapsed');
    });
  });

  // ── Discord tab handlers ──
  {
    // Token save
    const tokenSaveBtn = overlay.querySelector('#discord-token-save');
    if (tokenSaveBtn) {
      tokenSaveBtn.addEventListener('click', async () => {
        const input = overlay.querySelector('#discord-bot-token');
        const val = input.value.trim();
        const res = await fetch('/api/discord/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'botToken', value: val }),
        }).then(r => r.json()).catch(() => ({ error: 'Network error' }));
        if (res.ok) {
          showCCToast('Bot token saved');
          const statusEl = overlay.querySelector('#discord-conn-status');
          if (statusEl) statusEl.textContent = val ? 'configured' : 'missing';
          const dot = overlay.querySelector('.settings-tab-body[data-tab="discord"] .settings-status-dot');
          if (dot) { dot.classList.toggle('connected', !!val); dot.classList.toggle('disconnected', !val); }
          const statusText = overlay.querySelector('.settings-tab-body[data-tab="discord"] .settings-status');
          if (statusText) statusText.lastChild.textContent = val ? ' Token configured' : ' Not configured';
          // Update invite link
          updateInviteLink(overlay, val);
        } else {
          showCCToast(res.error || 'Save failed');
        }
      });
    }

    // Token eye toggle
    const tokenEye = overlay.querySelector('#discord-token-eye');
    if (tokenEye) {
      tokenEye.addEventListener('click', () => {
        const input = overlay.querySelector('#discord-bot-token');
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        tokenEye.innerHTML = isPassword ? eyeOpen : eyeClosed;
      });
    }

    // Guild ID save
    const guildSaveBtn = overlay.querySelector('#discord-guild-save');
    if (guildSaveBtn) {
      guildSaveBtn.addEventListener('click', async () => {
        const input = overlay.querySelector('#discord-guild-id');
        const val = input.value.trim();
        const res = await fetch('/api/discord/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'guildId', value: val }),
        }).then(r => r.json()).catch(() => ({ error: 'Network error' }));
        if (res.ok) showCCToast('Guild ID saved');
        else showCCToast(res.error || 'Save failed');
      });
    }

    // Test connection
    const testBtn = overlay.querySelector('#discord-test-btn');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const resultEl = overlay.querySelector('#discord-test-result');
        resultEl.style.display = 'block';
        resultEl.style.background = 'rgba(255,255,255,0.05)';
        resultEl.style.border = '1px solid var(--s-medium)';
        resultEl.textContent = 'Testing connection...';

        const res = await fetch('/api/discord/test', { method: 'POST' }).then(r => r.json()).catch(() => ({ ok: false, error: 'Network error' }));
        if (res.ok) {
          const bot = res.bot;
          const guilds = bot.guilds.map(g => `${g.name} (${g.id})`).join(', ');
          resultEl.style.background = 'rgba(109,213,140,0.08)';
          resultEl.style.border = '1px solid rgba(109,213,140,0.2)';
          resultEl.innerHTML = `<div style="color:var(--green);margin-bottom:4px;font-weight:600">Connected!</div>` +
            `<div>Bot: <strong>${escapeHtml(bot.username)}</strong> (${bot.id})</div>` +
            `<div>Guilds: ${escapeHtml(guilds) || 'none'}</div>`;
        } else {
          resultEl.style.background = 'rgba(255,99,99,0.08)';
          resultEl.style.border = '1px solid rgba(255,99,99,0.2)';
          resultEl.innerHTML = `<div style="color:var(--red,#ff6b6b)">Failed: ${escapeHtml(res.error || 'Unknown error')}</div>`;
        }
      });
    }

    // Invite link
    function updateInviteLink(container, token) {
      const linkInput = container.querySelector('#discord-invite-link');
      if (!linkInput) return;
      if (!token) { linkInput.value = 'Save a bot token first'; return; }
      // Extract application ID from token (first segment is base64-encoded app ID)
      try {
        const appId = atob(token.split('.')[0]);
        linkInput.value = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=8&scope=bot`;
      } catch {
        linkInput.value = 'Could not parse bot token';
      }
    }
    updateInviteLink(overlay, discordConfig.botToken);

    // Copy invite link
    const inviteCopy = overlay.querySelector('#discord-invite-copy');
    if (inviteCopy) {
      inviteCopy.addEventListener('click', () => {
        const linkInput = overlay.querySelector('#discord-invite-link');
        if (linkInput.value && !linkInput.value.startsWith('Save') && !linkInput.value.startsWith('Could')) {
          navigator.clipboard.writeText(linkInput.value);
          showCCToast('Invite link copied');
        }
      });
    }

    // Auto-save for Server Defaults and Moderation Defaults inputs
    overlay.querySelectorAll('input[data-discord-key]').forEach(input => {
      let debounce;
      input.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          const key = input.dataset.discordKey;
          const val = input.value.trim();
          await fetch('/api/discord/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value: val }),
          }).catch(() => {});
          showCCToast('Saved');
        }, 800);
      });
    });
  }

  // ── CLI Paths handlers ──
  {
    const cliSaveBtn = overlay.querySelector('#cli-paths-save');
    const cliDefaults = { 'claude-code': 'claude', 'codex': 'codex', 'gemini': 'gemini' };

    // Detect buttons
    overlay.querySelectorAll('.cli-detect-btn[data-cli-detect]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const profileId = btn.dataset.cliDetect;
        const input = overlay.querySelector(`#cli-path-${profileId}`);
        const status = overlay.querySelector(`#cli-status-${profileId}`);
        btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none';
        try {
          const res = await fetch(`/api/cli/detect/${encodeURIComponent(profileId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          const data = await res.json();
          if (data.ok && data.found && data.path) {
            input.value = data.path;
            status.textContent = 'detected';
            status.className = 'cli-path-status detected';
            showCCToast(`Found: ${data.path}`);
          } else {
            status.textContent = 'not found';
            status.className = 'cli-path-status not-found';
            showCCToast('CLI not found in PATH');
          }
        } catch (err) {
          showCCToast('Detection failed: ' + err.message);
        } finally {
          btn.style.opacity = ''; btn.style.pointerEvents = '';
        }
      });
    });

    // Save button
    if (cliSaveBtn) {
      cliSaveBtn.addEventListener('click', async () => {
        const body = {};
        ['claude-code', 'codex', 'gemini'].forEach(id => {
          const input = overlay.querySelector(`#cli-path-${id}`);
          if (input) body[id] = { command: input.value.trim() };
        });
        cliSaveBtn.style.opacity = '0.5'; cliSaveBtn.style.pointerEvents = 'none';
        try {
          const res = await fetch('/api/cli/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (data.ok) {
            ['claude-code', 'codex', 'gemini'].forEach(id => {
              const input = overlay.querySelector(`#cli-path-${id}`);
              const status = overlay.querySelector(`#cli-status-${id}`);
              const val = input?.value?.trim() || '';
              const isDefault = !val || val === cliDefaults[id];
              if (status) {
                status.textContent = isDefault ? 'default' : 'custom';
                status.className = `cli-path-status${isDefault ? '' : ' custom'}`;
              }
            });
            showCCToast('CLI paths saved');
          } else {
            alert(data.error || 'Failed to save');
          }
        } catch (err) {
          alert('Failed: ' + err.message);
        } finally {
          cliSaveBtn.style.opacity = ''; cliSaveBtn.style.pointerEvents = '';
        }
      });
    }

    // Notification toggle
    const notifToggle = overlay.querySelector('#term-notif-toggle');
    if (notifToggle) {
      notifToggle.checked = storage.getItem(KEYS.TERMINAL_NOTIFICATIONS) !== 'off';
      notifToggle.addEventListener('change', () => {
        storage.setItem(KEYS.TERMINAL_NOTIFICATIONS, notifToggle.checked ? 'on' : 'off');
        if (notifToggle.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
          Notification.requestPermission();
        }
      });
    }
  }

  function updateGlobalHookBadge() {
    const hooksSection = overlay.querySelector('.iface-section[data-cc-target="global"]');
    if (!hooksSection) return;
    const toggles = hooksSection.querySelectorAll('.cc-toggle[data-cc-scope="global"]');
    const onCount = [...toggles].filter(t => t.classList.contains('on')).length;
    const badge = overlay.querySelector('#cc-hooks-badge');
    if (badge) {
      badge.textContent = `${onCount}/6`;
      badge.classList.toggle('all-on', onCount === 6);
    }
  }

  function updateProjectCount() {
    const allPanels = overlay.querySelectorAll('.cc-panel[data-cc-idx]');
    const activePanels = overlay.querySelectorAll('.cc-panel[data-cc-idx].enabled');
    const countEl = overlay.querySelector('.cc-project-count');
    if (countEl) countEl.textContent = `${activePanels.length} of ${allPanels.length} active`;
  }

  async function ccToggleHook(target, projectPath, toggleBtn, panel, hookEvent) {
    const isOn = toggleBtn.classList.contains('on');
    const method = isOn ? 'DELETE' : 'POST';
    const body = { target };
    if (projectPath) body.projectPath = projectPath;
    if (hookEvent) body.hook = hookEvent;
    try {
      toggleBtn.style.opacity = '0.4'; toggleBtn.style.pointerEvents = 'none';
      const res = await fetch('/api/claude-code/integrations', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.ok) {
        const nowOn = !isOn;
        toggleBtn.classList.toggle('on');
        const row = toggleBtn.closest('.cc-integration-item');
        if (row) row.classList.toggle('enabled', nowOn);
        if (target === 'global') { updateGlobalHookBadge(); }
        else { toggleBtn.textContent = nowOn ? 'Enabled' : 'Enable'; if (panel) panel.classList.toggle('enabled'); const badge = panel?.querySelector('.cc-panel-status'); if (badge) { badge.textContent = nowOn ? 'Active' : 'Off'; badge.className = 'cc-panel-status ' + (nowOn ? 'active' : 'inactive'); } updateProjectCount(); }
      } else { alert(data.error || 'Failed to toggle hook'); }
    } catch (err) { alert('Failed: ' + err.message); }
    finally { toggleBtn.style.opacity = ''; toggleBtn.style.pointerEvents = ''; }
  }

  // Per-hook toggles (global)
  overlay.querySelectorAll('.cc-toggle[data-cc-scope="global"]').forEach(toggle => {
    toggle.addEventListener('click', () => { ccToggleHook('global', null, toggle, overlay.querySelector('.iface-section[data-cc-target="global"]'), toggle.dataset.ccHook); });
  });

  // Feature toggles
  overlay.querySelectorAll('.cc-toggle[data-cc-feature]').forEach(toggle => {
    toggle.addEventListener('click', async () => {
      const feature = toggle.dataset.ccFeature; const isOn = toggle.classList.contains('on');
      try {
        toggle.style.opacity = '0.4'; toggle.style.pointerEvents = 'none';
        const res = await fetch('/api/claude-code/hook-features', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature, enabled: !isOn }) });
        const data = await res.json();
        if (data.ok) {
          toggle.classList.toggle('on'); const row = toggle.closest('.cc-integration-item'); if (row) row.classList.toggle('enabled', !isOn);
          // Show/hide greeting body when greeting feature is toggled
          if (feature === 'greeting') {
            const gcBody = overlay.querySelector('#cc-greeting-body');
            if (gcBody) gcBody.style.display = !isOn ? 'block' : 'none';
          }
          // Show/hide user learning threshold when feature is toggled
          if (feature === 'userLearning') {
            const ulThreshold = overlay.querySelector('#cc-ul-threshold');
            if (ulThreshold) ulThreshold.style.display = !isOn ? 'flex' : 'none';
          }
        }
        else { alert(data.error || 'Failed to toggle feature'); }
      } catch (err) { alert('Failed: ' + err.message); }
      finally { toggle.style.opacity = ''; toggle.style.pointerEvents = ''; }
    });
  });

  // ── Tool Permission toggles ──
  function updateToolBadges() {
    // Update per-category counts across all tabs (Automations + Social)
    let totalOn = 0, totalAll = 0;
    overlay.querySelectorAll('.cc-tool-category').forEach(catEl => {
      const toggles = catEl.querySelectorAll('.cc-toggle[data-cc-tool]');
      const on = [...toggles].filter(t => t.classList.contains('on')).length;
      const countEl = catEl.querySelector('.cc-tool-category-count');
      if (countEl) countEl.textContent = `${on}/${toggles.length}`;
      const allBtn = catEl.querySelector('.cc-tool-category-all');
      if (allBtn) allBtn.classList.toggle('on', on === toggles.length);
      // Only count toward the Automations badge for non-social categories
      if (catEl.dataset.toolCategory !== 'social') {
        totalOn += on;
        totalAll += toggles.length;
      }
    });
    const badge = overlay.querySelector('#cc-tools-badge');
    if (badge) {
      badge.textContent = `${totalOn}/${totalAll}`;
      badge.classList.toggle('all-on', totalOn === totalAll);
    }
  }

  function applyToolPermissionResult(tools) {
    // Apply across all tabs (Automations + Social)
    for (const [key, enabled] of Object.entries(tools)) {
      const toggle = overlay.querySelector(`.cc-toggle[data-cc-tool="${key}"]`);
      if (toggle) {
        toggle.classList.toggle('on', enabled);
        const row = toggle.closest('.cc-integration-item');
        if (row) row.classList.toggle('enabled', enabled);
      }
    }
    updateToolBadges();
  }

  // Individual tool toggles
  overlay.querySelectorAll('.cc-toggle[data-cc-tool]').forEach(toggle => {
    toggle.addEventListener('click', async () => {
      const tool = toggle.dataset.ccTool;
      const isOn = toggle.classList.contains('on');
      try {
        toggle.style.opacity = '0.4'; toggle.style.pointerEvents = 'none';
        const res = await fetch('/api/claude-code/tool-permissions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, enabled: !isOn }) });
        const data = await res.json();
        if (data.ok) applyToolPermissionResult(data.tools);
        else alert(data.error || 'Failed to toggle tool');
      } catch (err) { alert('Failed: ' + err.message); }
      finally { toggle.style.opacity = ''; toggle.style.pointerEvents = ''; }
    });
  });

  // Category "All" toggles
  overlay.querySelectorAll('.cc-tool-category-all[data-cc-tool-cat]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const category = btn.dataset.ccToolCat;
      const isOn = btn.classList.contains('on');
      try {
        btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none';
        const res = await fetch('/api/claude-code/tool-permissions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, enabled: !isOn }) });
        const data = await res.json();
        if (data.ok) applyToolPermissionResult(data.tools);
        else alert(data.error || 'Failed to toggle category');
      } catch (err) { alert('Failed: ' + err.message); }
      finally { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
    });
  });

  // ── User Learning threshold handler ──
  {
    const ulInput = overlay.querySelector('#cc-ul-threshold-input');
    if (ulInput) {
      let ulDebounce;
      ulInput.addEventListener('input', () => {
        clearTimeout(ulDebounce);
        ulDebounce = setTimeout(async () => {
          const val = Math.max(3, Math.min(30, parseInt(ulInput.value) || 8));
          ulInput.value = val;
          try {
            await fetch('/api/claude-code/hook-features/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'userLearningThreshold', value: val }) });
          } catch { /* silent */ }
        }, 600);
      });
    }
  }

  // ── User Learning max nudges handler ──
  {
    const ulMaxInput = overlay.querySelector('#cc-ul-max-nudges-input');
    if (ulMaxInput) {
      let ulMaxDebounce;
      ulMaxInput.addEventListener('input', () => {
        clearTimeout(ulMaxDebounce);
        ulMaxDebounce = setTimeout(async () => {
          const val = Math.max(1, Math.min(10, parseInt(ulMaxInput.value) || 3));
          ulMaxInput.value = val;
          try {
            await fetch('/api/claude-code/hook-features/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'userLearningMaxNudges', value: val }) });
          } catch { /* silent */ }
        }, 600);
      });
    }
  }

  // ── Greeting editor handlers ──
  {
    const gcSelect = overlay.querySelector('#cc-greeting-project');
    const gcTemplate = overlay.querySelector('#cc-greeting-template');
    const gcShowReminders = overlay.querySelector('#cc-greeting-show-reminders');
    const gcShowLastSession = overlay.querySelector('#cc-greeting-show-last-session');
    const gcReminderList = overlay.querySelector('#cc-greeting-reminders');
    const gcAddReminder = overlay.querySelector('#cc-greeting-add-reminder');
    const gcSave = overlay.querySelector('#cc-greeting-save');

    // Helper: get config for a project key
    function getGreetingCfg(key) {
      const gc = greetingConfig || { defaults: {}, projects: {}, global: {} };
      if (key === 'global') return { ...gc.defaults, ...gc.global };
      return { ...gc.defaults, ...(gc.projects[key] || {}) };
    }

    // Helper: build reminder row HTML
    function reminderRowHTML(r) {
      return `<div class="cc-greeting-reminder-row">
        <span class="cc-greeting-drag-handle" title="Drag to reorder">&#8942;&#8942;</span>
        <input class="cc-greeting-reminder-input label" placeholder="Label" value="${escapeHtml(r.label || '')}">
        <input class="cc-greeting-reminder-input cmd" placeholder="Command" value="${escapeHtml(r.command || '')}">
        <button class="cc-greeting-reminder-remove" title="Remove">&times;</button>
      </div>`;
    }

    // Populate fields from a project key
    function populateGreetingFields(key) {
      const cfg = getGreetingCfg(key);
      if (gcTemplate) gcTemplate.value = cfg.greetingTemplate || '';
      if (gcShowReminders) gcShowReminders.checked = !!cfg.showReminders;
      if (gcShowLastSession) gcShowLastSession.checked = !!cfg.showLastSession;
      if (gcReminderList) gcReminderList.innerHTML = (cfg.reminders || []).map(r => reminderRowHTML(r)).join('');
      wireReminderRemoveButtons();
      wireReminderDragHandles();
    }

    // Wire remove buttons
    function wireReminderRemoveButtons() {
      if (!gcReminderList) return;
      gcReminderList.querySelectorAll('.cc-greeting-reminder-remove').forEach(btn => {
        btn.onclick = () => {
          const row = btn.closest('.cc-greeting-reminder-row');
          if (row) { row.style.opacity = '0'; row.style.transition = 'opacity 0.15s'; setTimeout(() => row.remove(), 150); }
        };
      });
    }

    // Wire drag handles for reorder
    function wireReminderDragHandles() {
      if (!gcReminderList) return;
      gcReminderList.querySelectorAll('.cc-greeting-drag-handle').forEach(handle => {
        handle.onmousedown = (e) => {
          e.preventDefault();
          const row = handle.closest('.cc-greeting-reminder-row');
          if (!row) return;
          row.style.opacity = '0.5';
          const rows = [...gcReminderList.querySelectorAll('.cc-greeting-reminder-row')];
          const startY = e.clientY;
          const startIdx = rows.indexOf(row);
          const onMove = (me) => {
            const dy = me.clientY - startY;
            const rowH = row.offsetHeight + 4;
            const shift = Math.round(dy / rowH);
            const newIdx = Math.max(0, Math.min(rows.length - 1, startIdx + shift));
            if (newIdx !== rows.indexOf(row)) {
              const ref = gcReminderList.children[newIdx];
              if (newIdx > rows.indexOf(row)) gcReminderList.insertBefore(row, ref?.nextSibling || null);
              else gcReminderList.insertBefore(row, ref);
            }
          };
          const onUp = () => {
            row.style.opacity = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        };
      });
    }

    // Custom dropdown behavior
    const gcDropdown = overlay.querySelector('#cc-greeting-project-dropdown');
    const gcDropdownLabel = overlay.querySelector('#cc-greeting-project-label');
    const gcDropdownMenu = overlay.querySelector('#cc-greeting-project-menu');
    if (gcDropdown && gcDropdownMenu) {
      gcDropdown.querySelector('.cc-dropdown-trigger').addEventListener('click', () => {
        gcDropdown.classList.toggle('open');
      });
      gcDropdownMenu.querySelectorAll('.cc-dropdown-item').forEach(item => {
        item.addEventListener('click', () => {
          const val = item.dataset.value;
          if (gcSelect) { gcSelect.value = val; gcSelect.dispatchEvent(new Event('change')); }
          if (gcDropdownLabel) gcDropdownLabel.textContent = item.textContent;
          gcDropdownMenu.querySelectorAll('.cc-dropdown-item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          gcDropdown.classList.remove('open');
          populateGreetingFields(val);
        });
      });
      // Close on click outside
      document.addEventListener('click', (e) => {
        if (!gcDropdown.contains(e.target)) gcDropdown.classList.remove('open');
      });
    }

    // Add reminder
    if (gcAddReminder && gcReminderList) {
      gcAddReminder.addEventListener('click', () => {
        const tmp = document.createElement('div');
        tmp.innerHTML = reminderRowHTML({ label: '', command: '' });
        const newRow = tmp.firstElementChild;
        gcReminderList.appendChild(newRow);
        wireReminderRemoveButtons();
        wireReminderDragHandles();
        newRow.querySelector('.label')?.focus();
      });
    }

    // Save greeting config
    if (gcSave) {
      gcSave.addEventListener('click', async () => {
        const project = gcSelect?.value || 'global';
        const reminders = [];
        if (gcReminderList) {
          gcReminderList.querySelectorAll('.cc-greeting-reminder-row').forEach(row => {
            const label = row.querySelector('.label')?.value?.trim() || '';
            const command = row.querySelector('.cmd')?.value?.trim() || '';
            if (label || command) reminders.push({ label, command });
          });
        }
        const body = {
          greetingTemplate: gcTemplate?.value || '',
          showReminders: gcShowReminders?.checked ?? false,
          showLastSession: gcShowLastSession?.checked ?? false,
          reminders,
        };
        gcSave.style.opacity = '0.5'; gcSave.style.pointerEvents = 'none';
        try {
          const res = await fetch(`/api/greeting/config/${encodeURIComponent(project)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          const data = await res.json();
          if (data.ok) {
            // Update local cache
            const gc = greetingConfig;
            const target = project === 'global' ? (gc.global || (gc.global = {})) : (gc.projects[project] || (gc.projects[project] = {}));
            Object.assign(target, body);
            showCCToast('Greeting config saved');
          } else { alert(data.error || 'Failed to save'); }
        } catch (err) { alert('Failed: ' + err.message); }
        finally { gcSave.style.opacity = ''; gcSave.style.pointerEvents = ''; }
      });
    }

    // Initial wiring
    wireReminderRemoveButtons();
    wireReminderDragHandles();

    // Cheatsheet toggle + preview
    const csToggle = overlay.querySelector('#cc-greeting-cheatsheet-toggle');
    const csPanel = overlay.querySelector('#cc-greeting-cheatsheet');
    if (csToggle && csPanel) {
      csToggle.addEventListener('click', () => {
        const open = csPanel.style.display !== 'none';
        csPanel.style.display = open ? 'none' : 'block';
        csToggle.classList.toggle('open', !open);
      });

      function updateCheatsheetPreview() {
        const hour = new Date().getHours();
        const timeGreeting = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : 'Good evening';
        const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const key = gcSelect?.value || 'global';
        const gc = greetingConfig || {};
        const projCfg = key === 'global' ? gc.global : gc.projects?.[key];
        const label = projCfg?.label || key;
        const name = key === 'global' ? 'global' : key;

        overlay.querySelector('#cc-cs-time').textContent = timeGreeting;
        overlay.querySelector('#cc-cs-label').textContent = label;
        overlay.querySelector('#cc-cs-name').textContent = name;
        overlay.querySelector('#cc-cs-branch').textContent = 'dev';
        overlay.querySelector('#cc-cs-date').textContent = dateStr;

        // Render the template with resolved values as example
        const tpl = gcTemplate?.value || '{time_greeting}! Working on **{project_label}** ({branch} branch). {date}.';
        const resolved = tpl
          .replace(/\{time_greeting\}/g, timeGreeting)
          .replace(/\{project_label\}/g, label)
          .replace(/\{project_name\}/g, name)
          .replace(/\{branch\}/g, 'dev')
          .replace(/\{date\}/g, dateStr)
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/`(.+?)`/g, '<code>$1</code>');
        overlay.querySelector('#cc-cs-preview').innerHTML = resolved;
      }

      // Update on toggle open and on project/template change
      csToggle.addEventListener('click', updateCheatsheetPreview);
      if (gcSelect) gcSelect.addEventListener('change', () => { if (csPanel.style.display !== 'none') updateCheatsheetPreview(); });
      if (gcTemplate) gcTemplate.addEventListener('input', () => { if (csPanel.style.display !== 'none') updateCheatsheetPreview(); });
    }
  }

  // Per-project toggles
  overlay.querySelectorAll('.cc-enable-btn[data-cc-project-toggle]').forEach(btn => {
    btn.addEventListener('click', () => { const idx = btn.dataset.ccProjectToggle; const panel = overlay.querySelector(`.cc-panel[data-cc-idx="${idx}"]`); const projectPath = panel?.dataset.ccPath; if (projectPath) ccToggleHook('project', projectPath, btn, panel); });
  });

  // Skill toggles
  overlay.querySelectorAll('.cc-toggle[data-cc-skill]').forEach(toggle => {
    toggle.addEventListener('click', async () => {
      const skillName = toggle.dataset.ccSkill; const isOn = toggle.classList.contains('on');
      try {
        toggle.style.opacity = '0.4'; toggle.style.pointerEvents = 'none';
        const res = await fetch('/api/claude-code/skills', { method: isOn ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: skillName }) });
        const data = await res.json();
        if (data.ok) { toggle.classList.toggle('on'); const row = toggle.closest('.cc-skill-row'); if (row) row.classList.toggle('installed', !isOn); showCCToast(isOn ? 'Skill uninstalled \u2014 restart Claude Code to apply' : 'Skill installed \u2014 restart Claude Code to apply'); }
        else { alert(data.error || 'Failed to toggle skill'); }
      } catch (err) { alert('Failed: ' + err.message); }
      finally { toggle.style.opacity = ''; toggle.style.pointerEvents = ''; }
    });
  });

  // ── Setup tab: per-provider MCP toggles, CLI copy, config copy, rulesets ──
  {
    const checkIcon = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg>';
    const copyBtnIcon = COPY_ICON;

    // Helper: wire a MCP toggle for any provider
    function wireSetupMcpToggle(provider, apiPath, configLabel) {
      const toggle = overlay.querySelector(`#setup-${provider}-mcp-toggle`);
      if (!toggle) return;
      toggle.addEventListener('click', async () => {
        const isOn = toggle.classList.contains('on');
        try {
          toggle.style.opacity = '0.4'; toggle.style.pointerEvents = 'none';
          const res = await fetch(apiPath, { method: isOn ? 'DELETE' : 'POST' });
          const data = await res.json();
          if (data.ok) {
            const nowOn = !isOn;
            toggle.classList.toggle('on');
            const row = overlay.querySelector(`#setup-${provider}-mcp-row`);
            if (row) row.classList.toggle('enabled', nowOn);
            const status = overlay.querySelector(`#setup-${provider}-mcp-status`);
            if (status) status.textContent = nowOn ? `Registered in ${configLabel}` : 'Not connected';
            const badge = overlay.querySelector(`#setup-${provider} .setup-status-badge`);
            if (badge) { badge.className = `setup-status-badge ${nowOn ? 'active' : 'inactive'}`; badge.textContent = nowOn ? 'Connected' : 'Off'; }
          } else { alert(data.error || 'Failed'); }
        } catch (err) { alert('Failed: ' + err.message); }
        finally { toggle.style.opacity = ''; toggle.style.pointerEvents = ''; }
      });
    }

    // Helper: wire a copy button
    function wireCopyBtn(id, getText, originalLabel) {
      const btn = overlay.querySelector(`#${id}`);
      if (!btn) return;
      btn.addEventListener('click', () => {
        const text = getText();
        if (!text) { alert('Content not available'); return; }
        navigator.clipboard.writeText(text);
        btn.innerHTML = `${checkIcon} Copied!`;
        setTimeout(() => { btn.innerHTML = `${copyBtnIcon} ${originalLabel}`; }, 2000);
      });
    }

    // Helper: load a ruleset preview
    function wireRulesetPreview(provider, format) {
      const preview = overlay.querySelector(`#setup-${provider}-ruleset-preview`);
      if (!preview) return;
      let cached = '';
      fetch(`/api/claude-code/ruleset?format=${format}`).then(r => r.json()).then(data => {
        if (data.ok && data.ruleset) {
          cached = data.ruleset;
          const lines = data.ruleset.split('\n');
          preview.textContent = lines.slice(0, 20).join('\n') + (lines.length > 20 ? '\n...' : '');
        } else { preview.textContent = 'Could not load ruleset.'; }
      }).catch(() => { preview.textContent = 'Failed to load.'; });

      // Wire copy
      wireCopyBtn(`setup-${provider}-ruleset-copy`, () => cached, 'Copy Ruleset');
    }

    // ── Claude ──
    wireSetupMcpToggle('claude', '/api/claude-code/mcp', '~/.claude.json');
    wireCopyBtn('setup-claude-cli-copy', () => setupStatus.claude?.cliCommand || ccIntegrations.mcp?.cliCommand || '', 'Copy CLI Command');
    wireRulesetPreview('claude', 'claude');

    // ── Gemini ──
    wireSetupMcpToggle('gemini', '/api/setup/gemini/mcp', '~/.gemini/settings.json');
    // Config preview
    {
      const preview = overlay.querySelector('#setup-gemini-config-preview');
      let cachedConfig = '';
      if (preview) {
        fetch('/api/setup/gemini/mcp').then(r => r.json()).then(data => {
          if (data.ok && data.config) {
            cachedConfig = JSON.stringify(data.config, null, 2);
            preview.textContent = cachedConfig;
          } else if (data.ok) {
            cachedConfig = JSON.stringify({ mcpServers: { SynaBun: { command: 'node', args: [setupStatus.paths?.mcpIndexPath || '<path-to>/mcp-server/dist/preload.js'], env: { DOTENV_PATH: setupStatus.paths?.envPath || '<path-to>/synabun/.env' } } } }, null, 2);
            preview.textContent = cachedConfig;
          } else { preview.textContent = 'Could not load config.'; }
        }).catch(() => { preview.textContent = 'Failed to load.'; });
      }
      wireCopyBtn('setup-gemini-config-copy', () => cachedConfig, 'Copy JSON Config');
    }
    wireRulesetPreview('gemini', 'gemini');

    // ── Codex ──
    wireSetupMcpToggle('codex', '/api/setup/codex/mcp', '~/.codex/config.toml');
    wireCopyBtn('setup-codex-cli-copy', () => setupStatus.codex?.cliCommand || '', 'Copy CLI Command');
    // Config preview
    {
      const preview = overlay.querySelector('#setup-codex-config-preview');
      let cachedConfig = '';
      if (preview) {
        fetch('/api/setup/codex/mcp').then(r => r.json()).then(data => {
          if (data.ok && data.toml) {
            cachedConfig = data.toml;
            preview.textContent = cachedConfig;
          } else if (data.ok) {
            const mp = setupStatus.paths?.mcpIndexPath || '<path-to>/mcp-server/dist/preload.js';
            const ep = setupStatus.paths?.envPath || '<path-to>/synabun/.env';
            cachedConfig = `[mcp_servers.SynaBun]\ncommand = "node"\nargs = ["${mp}"]\n\n[mcp_servers.SynaBun.env]\nDOTENV_PATH = "${ep}"`;
            preview.textContent = cachedConfig;
          } else { preview.textContent = 'Could not load config.'; }
        }).catch(() => { preview.textContent = 'Failed to load.'; });
      }
      wireCopyBtn('setup-codex-config-copy', () => cachedConfig, 'Copy TOML Config');
    }
    wireRulesetPreview('codex', 'codex');

    // ── Coexistence rules ──
    wireRulesetPreview('coexistence', 'coexistence');
  }

  // ── Browser config (Setup tab) ──
  {
    // Sub-group collapsing
    overlay.querySelectorAll('.browser-cfg-group-title[data-collapsible-sub]').forEach(title => {
      title.addEventListener('click', () => {
        title.closest('.browser-cfg-group').classList.toggle('expanded');
      });
    });

    // Helper: get/set toggle state
    const bcToggle = (id) => overlay.querySelector(`#${id}`);
    const isToggleOn = (id) => bcToggle(id)?.classList.contains('on') || false;
    const setToggle = (id, on) => { const t = bcToggle(id); if (t) { t.classList.toggle('on', on); } };

    // Wire toggle clicks
    const toggleIds = [
      'bc-isMobile', 'bc-hasTouch', 'bc-stealthFingerprint', 'bc-geoEnabled',
      'bc-offline', 'bc-javaScriptEnabled', 'bc-ignoreHTTPSErrors', 'bc-bypassCSP',
      'bc-acceptDownloads', 'bc-strictSelectors', 'bc-persistStorage',
      'bc-clearStorageOnStart', 'bc-recordVideo', 'bc-recordHar',
    ];
    toggleIds.forEach(id => {
      const el = overlay.querySelector(`#${id}`);
      if (el) el.addEventListener('click', () => el.classList.toggle('on'));
    });

    // Wire all bc-dropdown custom selects
    overlay.querySelectorAll('.bc-dropdown').forEach(dd => {
      const trigger = dd.querySelector('.cc-dropdown-trigger');
      const menu = dd.querySelector('.cc-dropdown-menu');
      const label = dd.querySelector('.cc-dropdown-value');
      const hiddenId = dd.dataset.for;
      const hidden = hiddenId ? overlay.querySelector(`#${hiddenId}`) : null;
      if (!trigger || !menu) return;

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dd.classList.contains('disabled')) return;
        // Close other open dropdowns first
        overlay.querySelectorAll('.bc-dropdown.open').forEach(other => {
          if (other !== dd) other.classList.remove('open');
        });
        dd.classList.toggle('open');
      });

      menu.querySelectorAll('.cc-dropdown-item').forEach(item => {
        item.addEventListener('click', () => {
          const val = item.dataset.value;
          if (hidden) hidden.value = val;
          if (label) label.textContent = item.textContent;
          menu.querySelectorAll('.cc-dropdown-item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          dd.classList.remove('open');
        });
      });
    });

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
      overlay.querySelectorAll('.bc-dropdown.open').forEach(dd => {
        if (!dd.contains(e.target)) dd.classList.remove('open');
      });
    });

    // Sync dropdown display from hidden input value (for applyBrowserConfig)
    function syncBcDropdowns() {
      overlay.querySelectorAll('.bc-dropdown').forEach(dd => {
        const hiddenId = dd.dataset.for;
        const hidden = hiddenId ? overlay.querySelector(`#${hiddenId}`) : null;
        if (!hidden) return;
        const val = hidden.value;
        const label = dd.querySelector('.cc-dropdown-value');
        const menu = dd.querySelector('.cc-dropdown-menu');
        if (!menu) return;
        menu.querySelectorAll('.cc-dropdown-item').forEach(item => {
          const isMatch = item.dataset.value === val;
          item.classList.toggle('active', isMatch);
          if (isMatch && label) label.textContent = item.textContent;
        });
        // Sync disabled state
        dd.classList.toggle('disabled', !!hidden.disabled);
        const trigger = dd.querySelector('.cc-dropdown-trigger');
        if (trigger) trigger.disabled = !!hidden.disabled;
      });
    }

    // Geo toggle → enable/disable geo fields
    const geoToggle = bcToggle('bc-geoEnabled');
    if (geoToggle) {
      geoToggle.addEventListener('click', () => {
        const on = isToggleOn('bc-geoEnabled');
        ['bc-geoLatitude', 'bc-geoLongitude', 'bc-geoAccuracy'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = !on;
        });
      });
    }

    // Persist storage toggle → enable/disable storage path
    const persistToggle = bcToggle('bc-persistStorage');
    if (persistToggle) {
      persistToggle.addEventListener('click', () => {
        const on = isToggleOn('bc-persistStorage');
        const inp = overlay.querySelector('#bc-storageStatePath');
        if (inp) inp.disabled = !on;
      });
    }

    // Record video toggle → enable/disable video fields
    const vidToggle = bcToggle('bc-recordVideo');
    if (vidToggle) {
      vidToggle.addEventListener('click', () => {
        const on = isToggleOn('bc-recordVideo');
        ['bc-recordVideoDir', 'bc-recordVideoWidth', 'bc-recordVideoHeight'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = !on;
        });
      });
    }

    // Record HAR toggle → enable/disable HAR fields + dropdowns
    const harToggle = bcToggle('bc-recordHar');
    if (harToggle) {
      harToggle.addEventListener('click', () => {
        const on = isToggleOn('bc-recordHar');
        ['bc-recordHarPath', 'bc-recordHarContent', 'bc-recordHarMode', 'bc-recordHarUrlFilter'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = !on;
          // Also toggle dropdown container
          const dd = overlay.querySelector(`.bc-dropdown[data-for="${id}"]`);
          if (dd) {
            dd.classList.toggle('disabled', !on);
            const trigger = dd.querySelector('.cc-dropdown-trigger');
            if (trigger) trigger.disabled = !on;
          }
        });
      });
    }

    // Screencast quality range → value display
    const scRange = overlay.querySelector('#bc-screencastQuality');
    const scVal = overlay.querySelector('#bc-screencastQuality-val');
    if (scRange && scVal) {
      scRange.addEventListener('input', () => { scVal.textContent = scRange.value; });
    }

    // Auto-detect executable
    const detectBtn = overlay.querySelector('#bc-detect-executable');
    if (detectBtn) {
      detectBtn.addEventListener('click', async () => {
        detectBtn.style.opacity = '0.4'; detectBtn.style.pointerEvents = 'none';
        try {
          const res = await fetch('/api/browser/config');
          const data = await res.json();
          const hint = overlay.querySelector('#bc-detected-path');
          if (data.detectedPath) {
            if (hint) hint.textContent = `Detected: ${data.detectedPath}`;
            const inp = overlay.querySelector('#bc-executablePath');
            if (inp && !inp.value.trim()) inp.value = data.detectedPath;
          } else {
            if (hint) hint.textContent = 'No Chrome/Chromium found — Playwright will use its bundled browser';
          }
        } catch (err) {
          const hint = overlay.querySelector('#bc-detected-path');
          if (hint) hint.textContent = 'Detection failed: ' + err.message;
        } finally { detectBtn.style.opacity = ''; detectBtn.style.pointerEvents = ''; }
      });
    }

    // ── Chrome profile picker ──
    let _detectedProfiles = [];
    let _synabunProfile = '';

    /** Select a profile from the list. Updates hidden field + path input. */
    function selectProfileItem(value) {
      const list = overlay.querySelector('#bc-profile-list');
      if (!list) return;
      list.querySelectorAll('.bc-profile-item').forEach(el => el.classList.remove('selected'));
      const hidden = overlay.querySelector('#bc-userDataDir');
      const pathInput = overlay.querySelector('#bc-custom-profile-path');

      let resolvedPath = '';
      if (value === '') {
        resolvedPath = '';
      } else if (value === '__synabun__') {
        resolvedPath = _synabunProfile || 'data/chrome-profile';
      } else {
        resolvedPath = value;
      }

      if (hidden) hidden.value = resolvedPath;
      if (pathInput) pathInput.value = resolvedPath;

      const match = list.querySelector(`[data-profile-value="${CSS.escape(value)}"]`);
      if (match) match.classList.add('selected');
    }

    /** Set the path directly (from typing or browse). Highlights matching profile or deselects all. */
    function setProfilePath(path) {
      const hidden = overlay.querySelector('#bc-userDataDir');
      if (hidden) hidden.value = path;

      const list = overlay.querySelector('#bc-profile-list');
      if (!list) return;
      list.querySelectorAll('.bc-profile-item').forEach(el => el.classList.remove('selected'));

      if (!path) {
        const sandbox = list.querySelector('[data-profile-value=""]');
        if (sandbox) sandbox.classList.add('selected');
        return;
      }

      const norm = path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
      const synNorm = (_synabunProfile || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

      if (synNorm && norm === synNorm) {
        const el = list.querySelector('[data-profile-value="__synabun__"]');
        if (el) el.classList.add('selected');
        return;
      }

      for (const p of _detectedProfiles) {
        if (p.path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') === norm) {
          const el = list.querySelector(`[data-profile-value="${CSS.escape(p.path)}"]`);
          if (el) el.classList.add('selected');
          return;
        }
      }
      // No match — nothing highlighted, path input is the source of truth
    }

    function buildProfileList(profiles, synabunProfile) {
      const list = overlay.querySelector('#bc-profile-list');
      if (!list) return;

      const currentVal = overlay.querySelector('#bc-userDataDir')?.value || '';

      list.innerHTML = '';

      // Built-in: Clean Sandbox
      list.insertAdjacentHTML('beforeend', `
        <div class="bc-profile-item" data-profile-value="">
          <span class="bc-profile-radio"></span>
          <span class="bc-profile-name">Clean Sandbox</span>
          <span class="bc-profile-hint">No persistent profile</span>
        </div>
      `);

      // Built-in: SynaBun Profile
      list.insertAdjacentHTML('beforeend', `
        <div class="bc-profile-item" data-profile-value="__synabun__">
          <span class="bc-profile-radio"></span>
          <span class="bc-profile-name">SynaBun Profile</span>
          <span class="bc-profile-hint">Managed</span>
        </div>
      `);

      // Group detected profiles by browser
      const byBrowser = {};
      for (const p of profiles) {
        if (!byBrowser[p.browser]) byBrowser[p.browser] = [];
        byBrowser[p.browser].push(p);
      }

      for (const [browser, items] of Object.entries(byBrowser)) {
        list.insertAdjacentHTML('beforeend', `<div class="bc-profile-divider">${browser}</div>`);
        for (const p of items) {
          const label = p.name === p.folder ? p.name : `${p.name} (${p.folder})`;
          list.insertAdjacentHTML('beforeend', `
            <div class="bc-profile-item" data-profile-value="${p.path.replace(/"/g, '&quot;')}">
              <span class="bc-profile-radio"></span>
              <span class="bc-profile-name">${label}</span>
              <span class="bc-profile-hint">${p.isDefault ? 'Default' : ''}</span>
            </div>
          `);
        }
      }

      // Attach click handlers
      list.querySelectorAll('.bc-profile-item').forEach(el => {
        el.addEventListener('click', () => selectProfileItem(el.dataset.profileValue));
      });

      // Restore selection
      matchProfileSelection(currentVal, synabunProfile);
    }

    function matchProfileSelection(userDataDir, synabunProfile) {
      const pathInput = overlay.querySelector('#bc-custom-profile-path');
      if (!userDataDir) {
        if (pathInput) pathInput.value = '';
        selectProfileItem('');
        return;
      }

      if (pathInput) pathInput.value = userDataDir;

      const norm = (userDataDir || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
      const synNorm = (synabunProfile || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

      if (synNorm && norm === synNorm) {
        selectProfileItem('__synabun__');
        return;
      }

      for (const p of _detectedProfiles) {
        if (p.path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') === norm) {
          selectProfileItem(p.path);
          return;
        }
      }

      // Custom path — just set the hidden field, no list item to highlight
      const hidden = overlay.querySelector('#bc-userDataDir');
      if (hidden) hidden.value = userDataDir;
    }

    async function detectAndBuildProfiles() {
      const btn = overlay.querySelector('#bc-detect-profiles');
      if (btn) { btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none'; }
      try {
        const res = await fetch('/api/browser/detect-profiles');
        const data = await res.json();
        _detectedProfiles = data.profiles || [];
        _synabunProfile = data.synabunProfile || '';
        buildProfileList(_detectedProfiles, _synabunProfile);
      } catch {
        // Keep existing list if detection fails
      } finally {
        if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
      }
    }

    // Attach click handlers to initial static profile items
    overlay.querySelectorAll('#bc-profile-list .bc-profile-item').forEach(el => {
      el.addEventListener('click', () => selectProfileItem(el.dataset.profileValue));
    });

    // Detect button click
    const profileDetectBtn = overlay.querySelector('#bc-detect-profiles');
    if (profileDetectBtn) {
      profileDetectBtn.addEventListener('click', detectAndBuildProfiles);
    }

    // Path input → sync to hidden field + highlight matching profile
    const customPathInput = overlay.querySelector('#bc-custom-profile-path');
    if (customPathInput) {
      customPathInput.addEventListener('input', () => {
        setProfilePath(customPathInput.value.trim());
      });
    }

    // Browse folder button → in-app folder picker
    const browseBtn = overlay.querySelector('#bc-browse-folder');
    const bcBrowserEl = overlay.querySelector('#bc-browse-browser');
    if (browseBtn && bcBrowserEl) {
      async function loadBcDir(dirPath) {
        bcBrowserEl.style.display = 'block';
        bcBrowserEl.innerHTML = '<div style="padding:10px;color:var(--t-muted);font-size:12px">Loading...</div>';
        try {
          const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
          const res = await fetch(`/api/browse-directory${qs}`);
          const data = await res.json();
          if (!data.ok) throw new Error(data.error);

          let html = '<div style="padding:6px 10px;font-size:11px;color:var(--t-muted);border-bottom:1px solid var(--s-medium);display:flex;align-items:center;justify-content:space-between">'
            + `<span style="font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(data.current)}</span>`
            + '<button id="bc-browse-select" style="flex:0 0 auto;padding:3px 10px;background:var(--accent-blue-bg);border:1px solid var(--accent-blue-border);color:var(--accent-blue);border-radius:4px;cursor:pointer;font-size:11px">Select</button>'
            + '</div>';
          html += '<div style="padding:4px 0">';
          if (data.parent) {
            html += `<div class="cc-browse-item" data-path="${escapeHtml(data.parent)}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;color:var(--t-muted)">`
              + '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><polyline points="15 18 9 12 15 6"/></svg>'
              + '.. (parent)</div>';
          }
          for (const d of data.directories) {
            html += `<div class="cc-browse-item" data-path="${escapeHtml(data.current + '/' + d)}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px">`
              + '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
              + escapeHtml(d) + '</div>';
          }
          if (data.directories.length === 0 && !data.parent) {
            html += '<div style="padding:8px 10px;color:var(--t-muted);font-size:12px">No subdirectories</div>';
          }
          html += '</div>';
          bcBrowserEl.innerHTML = html;

          bcBrowserEl.querySelector('#bc-browse-select').addEventListener('click', () => {
            const input = overlay.querySelector('#bc-custom-profile-path');
            const selected = data.current.replace(/\\/g, '/');
            if (input) input.value = selected;
            setProfilePath(selected);
            bcBrowserEl.style.display = 'none';
          });

          bcBrowserEl.querySelectorAll('.cc-browse-item').forEach(item => {
            item.addEventListener('mouseenter', () => item.style.background = 'var(--s-medium)');
            item.addEventListener('mouseleave', () => item.style.background = '');
            item.addEventListener('click', () => loadBcDir(item.dataset.path));
          });
        } catch (err) {
          bcBrowserEl.innerHTML = `<div style="padding:10px;color:var(--accent-dim);font-size:12px">Error: ${escapeHtml(err.message)}</div>`;
        }
      }

      browseBtn.addEventListener('click', () => {
        if (bcBrowserEl.style.display === 'block') {
          bcBrowserEl.style.display = 'none';
          return;
        }
        const current = overlay.querySelector('#bc-custom-profile-path')?.value?.trim() || '';
        loadBcDir(current);
      });
    }

    // Collect all config from the form
    function collectBrowserConfig() {
      const val = (id) => (overlay.querySelector(`#${id}`)?.value || '').trim();
      const num = (id, def) => { const v = parseInt(val(id), 10); return isNaN(v) ? def : v; };
      const numF = (id, def) => { const v = parseFloat(val(id)); return isNaN(v) ? def : v; };

      // Permissions
      const permissions = [];
      overlay.querySelectorAll('.browser-cfg-checkbox-grid input[type="checkbox"]').forEach(cb => {
        if (cb.checked) permissions.push(cb.id.replace('bc-perm-', ''));
      });

      const config = {
        // Executable
        executablePath: val('bc-executablePath') || null,
        userDataDir: val('bc-userDataDir') || null,
        headless: val('bc-headless') === 'false' ? false : true,
        channel: val('bc-channel') || null,
        slowMo: num('bc-slowMo', 0),
        timeout: num('bc-timeout', 30000),
        navigationTimeout: num('bc-navigationTimeout', 30000),
        extraArgs: val('bc-extraArgs') || null,

        // Viewport & Display
        viewport: {
          width: num('bc-viewportWidth', 1280),
          height: num('bc-viewportHeight', 800),
        },
        screen: {
          width: num('bc-screenWidth', 1920),
          height: num('bc-screenHeight', 1080),
        },
        deviceScaleFactor: numF('bc-deviceScaleFactor', 1),
        isMobile: isToggleOn('bc-isMobile'),
        hasTouch: isToggleOn('bc-hasTouch'),

        // Identity & Headers
        userAgent: val('bc-userAgent') || null,
        acceptLanguage: val('bc-acceptLanguage') || null,
        locale: val('bc-locale') || null,
        timezoneId: val('bc-timezoneId') || null,
        extraHTTPHeaders: (() => {
          try { const v = val('bc-extraHTTPHeaders'); return v ? JSON.parse(v) : null; }
          catch { return null; }
        })(),
        stealthFingerprint: isToggleOn('bc-stealthFingerprint'),

        // Geolocation
        geolocation: isToggleOn('bc-geoEnabled') ? {
          latitude: numF('bc-geoLatitude', 0),
          longitude: numF('bc-geoLongitude', 0),
          accuracy: numF('bc-geoAccuracy', 100),
        } : null,

        // Permissions
        permissions: permissions.length ? permissions : null,

        // Network & Proxy
        offline: isToggleOn('bc-offline'),
        proxy: val('bc-proxyServer') ? {
          server: val('bc-proxyServer'),
          bypass: val('bc-proxyBypass') || undefined,
          username: val('bc-proxyUsername') || undefined,
          password: val('bc-proxyPassword') || undefined,
        } : null,
        httpCredentials: val('bc-httpCredUser') ? {
          username: val('bc-httpCredUser'),
          password: val('bc-httpCredPass'),
        } : null,

        // Appearance
        colorScheme: val('bc-colorScheme') || null,
        reducedMotion: val('bc-reducedMotion') || null,
        forcedColors: val('bc-forcedColors') || null,

        // Scripting & Security
        javaScriptEnabled: isToggleOn('bc-javaScriptEnabled'),
        ignoreHTTPSErrors: isToggleOn('bc-ignoreHTTPSErrors'),
        bypassCSP: isToggleOn('bc-bypassCSP'),
        acceptDownloads: isToggleOn('bc-acceptDownloads'),
        strictSelectors: isToggleOn('bc-strictSelectors'),
        serviceWorkers: val('bc-serviceWorkers') || 'allow',

        // Storage / Cookies
        persistStorage: isToggleOn('bc-persistStorage'),
        storageStatePath: val('bc-storageStatePath') || 'data/browser-storage.json',
        clearStorageOnStart: isToggleOn('bc-clearStorageOnStart'),

        // Recording
        recordVideo: isToggleOn('bc-recordVideo') ? {
          dir: val('bc-recordVideoDir') || 'data/videos',
          size: {
            width: num('bc-recordVideoWidth', 1280),
            height: num('bc-recordVideoHeight', 720),
          },
        } : null,
        recordHar: isToggleOn('bc-recordHar') ? {
          path: val('bc-recordHarPath') || 'data/network.har',
          content: val('bc-recordHarContent') || 'embed',
          mode: val('bc-recordHarMode') || 'full',
          urlFilter: val('bc-recordHarUrlFilter') || undefined,
        } : null,

        // Screencast
        screencast: {
          format: val('bc-screencastFormat') || 'jpeg',
          quality: num('bc-screencastQuality', 60),
          maxWidth: num('bc-screencastMaxWidth', 1280),
          maxHeight: num('bc-screencastMaxHeight', 800),
          everyNthFrame: num('bc-screencastEveryNthFrame', 1),
        },
      };

      return config;
    }

    // Apply config values to form controls
    function applyBrowserConfig(cfg) {
      if (!cfg || typeof cfg !== 'object') return;
      const setVal = (id, v) => { const el = overlay.querySelector(`#${id}`); if (el && v != null) el.value = v; };

      // Executable
      setVal('bc-executablePath', cfg.executablePath);
      setVal('bc-userDataDir', cfg.userDataDir || '');
      matchProfileSelection(cfg.userDataDir || '', _synabunProfile);
      setVal('bc-headless', String(cfg.headless ?? 'true'));
      setVal('bc-channel', cfg.channel || '');
      setVal('bc-slowMo', cfg.slowMo ?? 0);
      setVal('bc-timeout', cfg.timeout ?? 30000);
      setVal('bc-navigationTimeout', cfg.navigationTimeout ?? 30000);
      setVal('bc-extraArgs', cfg.extraArgs || '');

      // Viewport & Display
      if (cfg.viewport) {
        setVal('bc-viewportWidth', cfg.viewport.width);
        setVal('bc-viewportHeight', cfg.viewport.height);
      }
      if (cfg.screen) {
        setVal('bc-screenWidth', cfg.screen.width);
        setVal('bc-screenHeight', cfg.screen.height);
      }
      setVal('bc-deviceScaleFactor', cfg.deviceScaleFactor ?? 1);
      setToggle('bc-isMobile', !!cfg.isMobile);
      setToggle('bc-hasTouch', !!cfg.hasTouch);

      // Identity
      setVal('bc-userAgent', cfg.userAgent || '');
      setVal('bc-acceptLanguage', cfg.acceptLanguage || '');
      setVal('bc-locale', cfg.locale || '');
      setVal('bc-timezoneId', cfg.timezoneId || '');
      if (cfg.extraHTTPHeaders) {
        setVal('bc-extraHTTPHeaders', JSON.stringify(cfg.extraHTTPHeaders, null, 2));
      }
      setToggle('bc-stealthFingerprint', cfg.stealthFingerprint !== false);

      // Geolocation
      setToggle('bc-geoEnabled', !!cfg.geolocation);
      if (cfg.geolocation) {
        setVal('bc-geoLatitude', cfg.geolocation.latitude);
        setVal('bc-geoLongitude', cfg.geolocation.longitude);
        setVal('bc-geoAccuracy', cfg.geolocation.accuracy);
        ['bc-geoLatitude', 'bc-geoLongitude', 'bc-geoAccuracy'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = false;
        });
      }

      // Permissions
      if (cfg.permissions) {
        cfg.permissions.forEach(p => {
          const cb = overlay.querySelector(`#bc-perm-${p}`);
          if (cb) cb.checked = true;
        });
      }

      // Network
      setToggle('bc-offline', !!cfg.offline);
      if (cfg.proxy) {
        setVal('bc-proxyServer', cfg.proxy.server);
        setVal('bc-proxyBypass', cfg.proxy.bypass);
        setVal('bc-proxyUsername', cfg.proxy.username);
        setVal('bc-proxyPassword', cfg.proxy.password);
      }
      if (cfg.httpCredentials) {
        setVal('bc-httpCredUser', cfg.httpCredentials.username);
        setVal('bc-httpCredPass', cfg.httpCredentials.password);
      }

      // Appearance
      setVal('bc-colorScheme', cfg.colorScheme || '');
      setVal('bc-reducedMotion', cfg.reducedMotion || '');
      setVal('bc-forcedColors', cfg.forcedColors || '');

      // Scripting & Security
      setToggle('bc-javaScriptEnabled', cfg.javaScriptEnabled !== false);
      setToggle('bc-ignoreHTTPSErrors', !!cfg.ignoreHTTPSErrors);
      setToggle('bc-bypassCSP', !!cfg.bypassCSP);
      setToggle('bc-acceptDownloads', cfg.acceptDownloads !== false);
      setToggle('bc-strictSelectors', cfg.strictSelectors !== false);
      setVal('bc-serviceWorkers', cfg.serviceWorkers || 'allow');

      // Storage
      setToggle('bc-persistStorage', !!cfg.persistStorage);
      setVal('bc-storageStatePath', cfg.storageStatePath || 'data/browser-storage.json');
      if (cfg.persistStorage) {
        const inp = overlay.querySelector('#bc-storageStatePath');
        if (inp) inp.disabled = false;
      }
      setToggle('bc-clearStorageOnStart', !!cfg.clearStorageOnStart);

      // Recording — video
      const hasVideo = !!cfg.recordVideo;
      setToggle('bc-recordVideo', hasVideo);
      if (hasVideo) {
        setVal('bc-recordVideoDir', cfg.recordVideo.dir);
        if (cfg.recordVideo.size) {
          setVal('bc-recordVideoWidth', cfg.recordVideo.size.width);
          setVal('bc-recordVideoHeight', cfg.recordVideo.size.height);
        }
        ['bc-recordVideoDir', 'bc-recordVideoWidth', 'bc-recordVideoHeight'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = false;
        });
      }
      // Recording — HAR
      const hasHar = !!cfg.recordHar;
      setToggle('bc-recordHar', hasHar);
      if (hasHar) {
        setVal('bc-recordHarPath', cfg.recordHar.path);
        setVal('bc-recordHarContent', cfg.recordHar.content || 'embed');
        setVal('bc-recordHarMode', cfg.recordHar.mode || 'full');
        setVal('bc-recordHarUrlFilter', cfg.recordHar.urlFilter || '');
        ['bc-recordHarPath', 'bc-recordHarContent', 'bc-recordHarMode', 'bc-recordHarUrlFilter'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = false;
        });
      }

      // Screencast
      if (cfg.screencast) {
        setVal('bc-screencastFormat', cfg.screencast.format || 'jpeg');
        setVal('bc-screencastQuality', cfg.screencast.quality ?? 60);
        if (scVal) scVal.textContent = cfg.screencast.quality ?? 60;
        setVal('bc-screencastMaxWidth', cfg.screencast.maxWidth ?? 1280);
        setVal('bc-screencastMaxHeight', cfg.screencast.maxHeight ?? 800);
        setVal('bc-screencastEveryNthFrame', cfg.screencast.everyNthFrame ?? 1);
      }
    }

    // Load config on open, then auto-detect profiles
    fetch('/api/browser/config').then(r => r.json()).then(async (data) => {
      if (data.config) { applyBrowserConfig(data.config); syncBcDropdowns(); }
      // Show detected path
      const hint = overlay.querySelector('#bc-detected-path');
      if (hint && data.detectedPath) hint.textContent = `Detected: ${data.detectedPath}`;
      // Auto-detect Chrome profiles and select current
      await detectAndBuildProfiles();
      if (data.config) matchProfileSelection(data.config.userDataDir || '', _synabunProfile);
    }).catch(() => {});

    // Save button
    const saveBtn = overlay.querySelector('#bc-save-all');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const config = collectBrowserConfig();
        saveBtn.style.opacity = '0.5'; saveBtn.style.pointerEvents = 'none';
        const status = overlay.querySelector('#bc-save-status');
        try {
          const res = await fetch('/api/browser/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
          });
          const data = await res.json();
          if (data.ok) {
            if (status) { status.textContent = 'Configuration saved'; status.style.color = '#4ade80'; }
            showCCToast('Browser configuration saved');
          } else {
            if (status) { status.textContent = 'Save failed: ' + (data.error || 'Unknown error'); status.style.color = '#f87171'; }
          }
        } catch (err) {
          if (status) { status.textContent = 'Save failed: ' + err.message; status.style.color = '#f87171'; }
        } finally {
          saveBtn.style.opacity = ''; saveBtn.style.pointerEvents = '';
          setTimeout(() => { if (status) { status.textContent = ''; } }, 4000);
        }
      });
    }

    // Reset button
    const resetBtn = overlay.querySelector('#bc-reset-all');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        const defaults = {
          executablePath: null, headless: false, channel: null, slowMo: 0,
          timeout: 30000, navigationTimeout: 30000, extraArgs: null,
          viewport: { width: 1280, height: 800 }, screen: { width: 1920, height: 1080 },
          deviceScaleFactor: 1, isMobile: false, hasTouch: false,
          userAgent: null, acceptLanguage: null, locale: null, timezoneId: null,
          extraHTTPHeaders: null, stealthFingerprint: true,
          geolocation: null, permissions: null,
          offline: false, proxy: null, httpCredentials: null,
          colorScheme: null, reducedMotion: null, forcedColors: null,
          javaScriptEnabled: true, ignoreHTTPSErrors: false, bypassCSP: false,
          acceptDownloads: true, strictSelectors: true, serviceWorkers: 'allow',
          persistStorage: false, storageStatePath: 'data/browser-storage.json', clearStorageOnStart: false,
          recordVideo: null, recordHar: null,
          screencast: { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
        };
        applyBrowserConfig(defaults);
        // Reset disabled states
        ['bc-geoLatitude', 'bc-geoLongitude', 'bc-geoAccuracy', 'bc-storageStatePath',
         'bc-recordVideoDir', 'bc-recordVideoWidth', 'bc-recordVideoHeight',
         'bc-recordHarPath', 'bc-recordHarContent', 'bc-recordHarMode', 'bc-recordHarUrlFilter'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = true;
        });
        syncBcDropdowns();
        // Uncheck all permission checkboxes
        overlay.querySelectorAll('.browser-cfg-checkbox-grid input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        const status = overlay.querySelector('#bc-save-status');
        if (status) { status.textContent = 'Reset to defaults (not saved yet)'; status.style.color = 'var(--t-faint)'; }
        setTimeout(() => { if (status) status.textContent = ''; }, 3000);
      });
    }

  }

  // ── Tunnel toggle ──
  const tunnelToggle = overlay.querySelector('#cc-tunnel-toggle');
  if (tunnelToggle) {
    tunnelToggle.addEventListener('click', async () => {
      const isOn = tunnelToggle.classList.contains('on');
      const endpoint = isOn ? '/api/tunnel/stop' : '/api/tunnel/start';
      try {
        tunnelToggle.style.opacity = '0.4'; tunnelToggle.style.pointerEvents = 'none';
        const res = await fetch(endpoint, { method: 'POST' }); const data = await res.json();
        if (data.ok) {
          if (isOn) {
            tunnelToggle.classList.remove('on');
            const row = overlay.querySelector('#cc-tunnel-row'); if (row) row.classList.remove('enabled');
            const label = overlay.querySelector('#cc-tunnel-label'); if (label) label.textContent = 'Ready';
            const urlEl = overlay.querySelector('#cc-tunnel-url'); if (urlEl) urlEl.textContent = 'Expose MCP to Claude web via public URL';
          } else {
            tunnelToggle.classList.add('on');
            const row = overlay.querySelector('#cc-tunnel-row'); if (row) row.classList.add('enabled');
            const label = overlay.querySelector('#cc-tunnel-label'); if (label) label.textContent = 'Starting...';
            const urlEl = overlay.querySelector('#cc-tunnel-url'); if (urlEl) urlEl.textContent = 'Waiting for tunnel URL...';
            let attempts = 0;
            const poll = setInterval(async () => {
              attempts++;
              try {
                const sr = await fetch('/api/tunnel/status'); const sd = await sr.json();
                if (sd.url) {
                  clearInterval(poll);
                  if (label) label.textContent = 'Running';
                  if (urlEl) urlEl.textContent = sd.url;
                  let copyBtn = overlay.querySelector('#cc-tunnel-copy-url');
                  if (!copyBtn) {
                    const wrapper = document.createElement('div'); wrapper.style.cssText = 'margin-top:6px;display:flex;gap:6px;align-items:center';
                    wrapper.innerHTML = `<button class="conn-add-btn" id="cc-tunnel-copy-url" style="margin:0;flex:1;font-size:12px;padding:6px 10px"><svg viewBox="0 0 24 24" style="width:12px;height:12px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy MCP URL</button>`;
                    row.parentNode.insertBefore(wrapper, row.nextSibling);
                    copyBtn = wrapper.querySelector('#cc-tunnel-copy-url');
                    copyBtn.addEventListener('click', () => {
                      const tunnelMcpUrl = (urlEl?.textContent || '') + '/mcp';
                      navigator.clipboard.writeText(tunnelMcpUrl);
                      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
                      setTimeout(() => { copyBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy MCP URL'; }, 2000);
                    });
                  }
                } else if (attempts >= 30) { clearInterval(poll); if (label) label.textContent = 'Timeout'; if (urlEl) urlEl.textContent = 'Failed to get tunnel URL - check cloudflared'; }
              } catch {}
            }, 1000);
          }
        } else { alert(data.error || 'Failed'); }
      } catch (err) { alert('Failed: ' + err.message); }
      finally { tunnelToggle.style.opacity = ''; tunnelToggle.style.pointerEvents = ''; }
    });
  }

  // Copy tunnel MCP URL
  const tunnelCopy = overlay.querySelector('#cc-tunnel-copy-url');
  if (tunnelCopy) {
    tunnelCopy.addEventListener('click', () => {
      const urlEl = overlay.querySelector('#cc-tunnel-url'); const baseUrl = urlEl?.textContent || '';
      if (!baseUrl) { alert('Tunnel URL not available'); return; }
      const tunnelMcpUrl = mcpKeyInfo.key ? baseUrl + '/mcp/' + mcpKeyInfo.key : baseUrl + '/mcp';
      navigator.clipboard.writeText(tunnelMcpUrl);
      tunnelCopy.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
      setTimeout(() => { tunnelCopy.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy MCP URL'; }, 2000);
    });
  }

  // ── API key generate / copy / revoke ──
  const apikeyGenBtn = overlay.querySelector('#cc-apikey-generate');
  if (apikeyGenBtn) {
    apikeyGenBtn.addEventListener('click', async () => {
      const existing = overlay.querySelector('#cc-apikey-row')?.classList.contains('enabled');
      if (existing && !confirm('This will revoke the current key and generate a new one. Continue?')) return;
      apikeyGenBtn.style.opacity = '0.4'; apikeyGenBtn.style.pointerEvents = 'none';
      try {
        const res = await fetch('/api/mcp-key', { method: 'POST' }); const data = await res.json();
        if (data.ok && data.key) {
          mcpKeyInfo = { hasKey: true, key: data.key, maskedKey: '***' + data.key.slice(-8) };
          const reveal = overlay.querySelector('#cc-apikey-reveal');
          const valueEl = overlay.querySelector('#cc-apikey-value');
          const statusEl = overlay.querySelector('#cc-apikey-status');
          const row = overlay.querySelector('#cc-apikey-row');
          if (valueEl) valueEl.textContent = data.key;
          if (reveal) reveal.style.display = '';
          if (statusEl) statusEl.textContent = '***' + data.key.slice(-8);
          if (row) row.classList.add('enabled');
          apikeyGenBtn.textContent = 'Regenerate';
        } else { alert(data.error || 'Failed to generate key'); }
      } catch (err) { alert('Failed: ' + err.message); }
      finally { apikeyGenBtn.style.opacity = ''; apikeyGenBtn.style.pointerEvents = ''; }
    });
  }
  const apikeyCopyBtn = overlay.querySelector('#cc-apikey-copy');
  if (apikeyCopyBtn) {
    apikeyCopyBtn.addEventListener('click', () => {
      const key = overlay.querySelector('#cc-apikey-value')?.textContent || ''; if (!key) return;
      navigator.clipboard.writeText(key);
      apikeyCopyBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
      setTimeout(() => { apikeyCopyBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Key'; }, 2000);
    });
  }
  const apikeyRevokeBtn = overlay.querySelector('#cc-apikey-revoke');
  if (apikeyRevokeBtn) {
    apikeyRevokeBtn.addEventListener('click', async () => {
      if (!confirm('Revoke this API key? The MCP endpoint will become open.')) return;
      try {
        const res = await fetch('/api/mcp-key', { method: 'DELETE' }); const data = await res.json();
        if (data.ok) {
          mcpKeyInfo = { hasKey: false };
          const reveal = overlay.querySelector('#cc-apikey-reveal'); if (reveal) reveal.style.display = 'none';
          const statusEl = overlay.querySelector('#cc-apikey-status'); if (statusEl) statusEl.textContent = 'No key configured - tunnel is open';
          const row = overlay.querySelector('#cc-apikey-row'); if (row) row.classList.remove('enabled');
          const genBtn = overlay.querySelector('#cc-apikey-generate'); if (genBtn) genBtn.textContent = 'Generate Key';
        }
      } catch (err) { alert('Failed: ' + err.message); }
    });
  }

  // ══════════════════════════════════════
  // Projects tab handlers
  // ══════════════════════════════════════

  // Explore project
  function openExploreModal(projectPath, projectLabel) {
    const CLI_MODELS = {
      'claude-code': [
        { id: 'claude-opus-4-6',   label: 'Opus 4.6',   desc: 'Most capable',  tier: 'top' },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6',  desc: 'Balanced',      tier: 'default' },
        { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',   desc: 'Fastest',       tier: 'light' },
      ],
      'codex': [
        { id: 'o3',      label: 'o3',      desc: 'Deep reasoning',  tier: 'top' },
        { id: 'o4-mini', label: 'o4-mini', desc: 'Fast reasoning',  tier: 'default' },
      ],
      'gemini': [
        { id: 'gemini-2.5-pro',   label: '2.5 Pro',   desc: 'Most capable',  tier: 'default' },
        { id: 'gemini-2.5-flash', label: '2.5 Flash', desc: 'Lightweight',   tier: 'light' },
      ],
    };
    const CLI_OPTIONS = [
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'codex',       label: 'Codex CLI' },
      { id: 'gemini',      label: 'Gemini CLI' },
    ];

    let selectedCli = 'claude-code';
    let selectedModel = CLI_MODELS['claude-code'][0].id;

    const exploreOverlay = document.createElement('div');
    exploreOverlay.className = 'tag-delete-overlay';
    exploreOverlay.style.zIndex = '50200';

    function tierColor(tier) {
      return tier === 'top' ? 'rgba(255, 180, 80, 0.7)'
        : tier === 'light' ? 'rgba(130, 200, 255, 0.7)'
        : 'rgba(255, 255, 255, 0.6)';
    }

    function renderCliCards() {
      return CLI_OPTIONS.map(c => `
        <div class="explore-cli-card" data-cli="${c.id}" style="
          flex:1;padding:14px 12px;text-align:center;border-radius:8px;cursor:pointer;
          background:${c.id === selectedCli ? 'var(--accent-blue-bg)' : 'var(--s-medium)'};
          border:1px solid ${c.id === selectedCli ? 'var(--accent-blue-border)' : 'var(--s-light)'};
          color:${c.id === selectedCli ? 'var(--accent-blue)' : 'var(--t-primary)'};
          transition:border-color 0.15s,background 0.15s;
        ">
          <div style="font-size:13px;font-weight:600">${c.label}</div>
        </div>
      `).join('');
    }

    function renderModelCards() {
      const models = CLI_MODELS[selectedCli] || CLI_MODELS['claude-code'];
      if (!models.find(m => m.id === selectedModel)) selectedModel = models[0].id;
      return models.map(m => `
        <div class="explore-model-card" data-model="${m.id}" style="
          flex:1;padding:14px 12px;text-align:center;border-radius:8px;cursor:pointer;
          background:${m.id === selectedModel ? 'var(--accent-blue-bg)' : 'var(--s-medium)'};
          border:1px solid ${m.id === selectedModel ? 'var(--accent-blue-border)' : 'var(--s-light)'};
          transition:border-color 0.15s,background 0.15s;
        ">
          <div style="font-size:13px;font-weight:600;color:${tierColor(m.tier)}">${m.label}</div>
          <div style="font-size:11px;color:var(--t-muted);margin-top:4px">${m.desc}</div>
        </div>
      `).join('');
    }

    function renderModal() {
      exploreOverlay.innerHTML = `
        <div class="tag-delete-modal settings-modal" style="max-width:520px;padding:24px 28px">
          <h3 style="margin:0 0 20px;font-size:16px;font-weight:600;color:var(--t-primary)">
            <svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:var(--accent-blue);stroke-width:2;fill:none;vertical-align:-2px;margin-right:6px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            Explore: ${escapeHtml(projectLabel)}
          </h3>
          <div style="margin-bottom:18px">
            <div style="font-size:12px;color:var(--t-muted);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">CLI</div>
            <div id="explore-cli-cards" style="display:flex;gap:8px">${renderCliCards()}</div>
          </div>
          <div style="margin-bottom:22px">
            <div style="font-size:12px;color:var(--t-muted);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Model</div>
            <div id="explore-model-cards" style="display:flex;gap:8px">${renderModelCards()}</div>
          </div>
          <div class="settings-actions" style="margin-top:0;display:flex;justify-content:flex-end;gap:8px">
            <button class="settings-btn-cancel" id="explore-cancel">Cancel</button>
            <button class="settings-btn-save" id="explore-begin">Begin Exploration</button>
          </div>
        </div>`;
      wireModalEvents();
    }

    function wireModalEvents() {
      exploreOverlay.querySelectorAll('.explore-cli-card').forEach(card => {
        card.addEventListener('click', () => {
          selectedCli = card.dataset.cli;
          renderModal();
        });
      });
      exploreOverlay.querySelectorAll('.explore-model-card').forEach(card => {
        card.addEventListener('click', () => {
          selectedModel = card.dataset.model;
          renderModal();
        });
      });
      exploreOverlay.querySelector('#explore-cancel').addEventListener('click', closeExplore);
      exploreOverlay.addEventListener('click', e => { if (e.target === exploreOverlay) closeExplore(); });
      exploreOverlay.querySelector('#explore-begin').addEventListener('click', async () => {
        const beginBtn = exploreOverlay.querySelector('#explore-begin');
        beginBtn.textContent = 'Launching...';
        beginBtn.disabled = true;
        try {
          const slug = projectLabel.toLowerCase().replace(/[^a-z0-9]+/g, '');
          const prompt = buildExplorePrompt(slug);
          const result = await createTerminalSession(selectedCli, 120, 30, projectPath,
            selectedModel ? { model: selectedModel } : {});
          if (result?.sessionId) {
            emit('terminal:attach-floating', {
              terminalSessionId: result.sessionId,
              profile: selectedCli,
              initialMessage: prompt,
              autoSubmit: true,
            });
          }
          closeExplore();
        } catch (err) {
          alert('Exploration launch failed: ' + err.message);
          beginBtn.textContent = 'Begin Exploration';
          beginBtn.disabled = false;
        }
      });
    }

    function closeExplore() { exploreOverlay.remove(); }

    renderModal();
    document.body.appendChild(exploreOverlay);
  }

  overlay.querySelectorAll('.cc-explore-btn[data-cc-explore]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = btn.dataset.ccExplore;
      const panel = overlay.querySelector(`.cc-panel[data-cc-idx="${idx}"]`);
      const projectPath = panel?.dataset.ccPath;
      const projectLabel = panel?.querySelector('.cc-panel-title')?.textContent || 'Project';
      if (projectPath) openExploreModal(projectPath, projectLabel);
    });
  });

  // Remove project
  overlay.querySelectorAll('.cc-remove-panel-btn[data-cc-remove]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = btn.dataset.ccRemove;
      const panel = overlay.querySelector(`.cc-panel[data-cc-idx="${idx}"]`);
      const label = panel?.querySelector('.cc-panel-title')?.textContent || 'this project';
      if (!confirm(`Remove "${label}" from tracked projects?\nThis also disables the hook if active.`)) return;
      try {
        const projectPath = panel?.dataset.ccPath;
        if (projectPath && panel.classList.contains('enabled')) {
          await fetch('/api/claude-code/integrations', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'project', projectPath }) });
        }
        const res = await fetch(`/api/claude-code/projects/${idx}`, { method: 'DELETE' }); const data = await res.json();
        if (data.ok) {
          panel.style.transition = 'opacity 0.2s, transform 0.2s'; panel.style.opacity = '0'; panel.style.transform = 'translateX(10px)';
          setTimeout(() => { panel.remove(); updateProjectCount(); if (!overlay.querySelector('.cc-panel[data-cc-idx]')) overlay.querySelector('#cc-project-list').innerHTML = '<div class="cc-hint" style="text-align:center;padding:14px">No projects registered yet.</div>'; }, 200);
        } else { alert(data.error || 'Failed to remove project'); }
      } catch (err) { alert('Failed: ' + err.message); }
    });
  });

  // Add project
  overlay.querySelector('#cc-add-project').addEventListener('click', () => {
    const addOverlay = document.createElement('div');
    addOverlay.className = 'tag-delete-overlay'; addOverlay.style.zIndex = '50200';
    addOverlay.innerHTML = `
      <div class="tag-delete-modal settings-modal" style="max-width:480px">
        <h3><svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:var(--accent-blue);stroke-width:2;fill:none"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add Project</h3>
        <div class="settings-field"><label>Project Path</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="text" id="cc-proj-path" placeholder="/home/user/myproject" autocomplete="off" spellcheck="false" style="font-family:'JetBrains Mono',monospace;font-size:12px;flex:1">
            <button id="cc-proj-browse" style="flex:0 0 auto;padding:5px 10px;background:var(--s-medium);border:1px solid var(--s-light);border-radius:4px;color:var(--t-primary);cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px" title="Browse folders">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              Browse
            </button>
          </div>
        </div>
        <div id="cc-proj-browser" style="display:none;margin:-4px 0 12px;border:1px solid var(--s-medium);border-radius:6px;background:var(--s-darker);max-height:220px;overflow-y:auto"></div>
        <div class="settings-field"><label>Label <span style="color:var(--t-muted);font-weight:normal">(optional)</span></label><input type="text" id="cc-proj-label" placeholder="My Project" autocomplete="off" spellcheck="false"></div>
        <div class="cc-hint">The hook will be added to <code style="font-size:12px;background:var(--s-medium);padding:2px 5px;border-radius:4px">.claude/settings.json</code> inside this directory.</div>
        <div class="settings-actions" style="margin-top:12px"><button class="settings-btn-cancel" id="cc-proj-cancel">Cancel</button><button class="settings-btn-save" id="cc-proj-save">Add &amp; Enable</button></div>
      </div>`;
    document.body.appendChild(addOverlay);
    const closeAdd = () => addOverlay.remove();

    // Folder browser
    const browseBtn = addOverlay.querySelector('#cc-proj-browse');
    const browserEl = addOverlay.querySelector('#cc-proj-browser');
    const pathInput = addOverlay.querySelector('#cc-proj-path');

    async function loadDir(dirPath) {
      browserEl.style.display = 'block';
      browserEl.innerHTML = '<div style="padding:10px;color:var(--t-muted);font-size:12px">Loading...</div>';
      try {
        const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
        const res = await fetch(`/api/browse-directory${qs}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);

        let html = '<div style="padding:6px 10px;font-size:11px;color:var(--t-muted);border-bottom:1px solid var(--s-medium);display:flex;align-items:center;justify-content:space-between">'
          + `<span style="font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(data.current)}</span>`
          + '<button id="cc-browse-select" style="flex:0 0 auto;padding:3px 10px;background:var(--accent-blue-bg);border:1px solid var(--accent-blue-border);color:var(--accent-blue);border-radius:4px;cursor:pointer;font-size:11px">Select</button>'
          + '</div>';
        html += '<div style="padding:4px 0">';
        if (data.parent) {
          html += `<div class="cc-browse-item" data-path="${escapeHtml(data.parent)}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;color:var(--t-muted)">`
            + '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><polyline points="15 18 9 12 15 6"/></svg>'
            + '.. (parent)</div>';
        }
        for (const d of data.directories) {
          html += `<div class="cc-browse-item" data-path="${escapeHtml(data.current + '/' + d)}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px">`
            + '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
            + escapeHtml(d) + '</div>';
        }
        if (data.directories.length === 0 && !data.parent) {
          html += '<div style="padding:8px 10px;color:var(--t-muted);font-size:12px">No subdirectories</div>';
        }
        html += '</div>';
        browserEl.innerHTML = html;

        // Select current directory
        browserEl.querySelector('#cc-browse-select').addEventListener('click', () => {
          pathInput.value = data.current.replace(/\\/g, '/');
          browserEl.style.display = 'none';
        });

        // Navigate into subdirectory
        browserEl.querySelectorAll('.cc-browse-item').forEach(item => {
          item.addEventListener('mouseenter', () => item.style.background = 'var(--s-medium)');
          item.addEventListener('mouseleave', () => item.style.background = '');
          item.addEventListener('click', () => loadDir(item.dataset.path));
        });
      } catch (err) {
        browserEl.innerHTML = `<div style="padding:10px;color:var(--accent-dim);font-size:12px">Error: ${escapeHtml(err.message)}</div>`;
      }
    }

    browseBtn.addEventListener('click', () => {
      if (browserEl.style.display === 'block') {
        browserEl.style.display = 'none';
        return;
      }
      const current = pathInput.value.trim();
      loadDir(current || '');
    });

    addOverlay.querySelector('#cc-proj-cancel').addEventListener('click', closeAdd);
    addOverlay.addEventListener('click', e => { if (e.target === addOverlay) closeAdd(); });
    addOverlay.querySelector('#cc-proj-save').addEventListener('click', async () => {
      const projPath = addOverlay.querySelector('#cc-proj-path').value.trim();
      const label = addOverlay.querySelector('#cc-proj-label').value.trim();
      if (!projPath) { alert('Project path is required.'); return; }
      try {
        const saveBtn = addOverlay.querySelector('#cc-proj-save'); saveBtn.textContent = 'Adding...'; saveBtn.disabled = true;
        const res = await fetch('/api/claude-code/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'project', projectPath: projPath, label }) });
        const data = await res.json();
        if (data.ok) {
          closeAdd(); close();
          openSettingsModal().then(() => {
            const panel = document.getElementById('settings-panel');
            if (panel) { panel.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active')); panel.querySelectorAll('.settings-tab-body').forEach(b => b.classList.remove('active')); const nav = panel.querySelector('.settings-nav-item[data-tab="projects"]'); const tab = panel.querySelector('.settings-tab-body[data-tab="projects"]'); if (nav) nav.classList.add('active'); if (tab) tab.classList.add('active'); }
          });
        } else { alert(data.error || 'Failed to add project'); saveBtn.textContent = 'Add & Enable'; saveBtn.disabled = false; }
      } catch (err) { alert('Failed: ' + err.message); const saveBtn = addOverlay.querySelector('#cc-proj-save'); saveBtn.textContent = 'Add & Enable'; saveBtn.disabled = false; }
    });
  });

  // ── Skins tab: wire interaction ──
  wireSkinsTab(overlay, skinsData.skins, skinsData.active);

  // ── Icons tab: wire interaction ──
  wireIconsTab(overlay, customIconsData);

  // ── Variant tabs: call afterRender ──
  for (const vTab of variantTabs) {
    if (typeof vTab.afterRender === 'function') {
      const tabBody = overlay.querySelector(`.settings-tab-body[data-tab="${vTab.id}"]`);
      if (tabBody) vTab.afterRender(tabBody);
    }
  }
}


// ═══════════════════════════════════════════
// MEMORY SYNC
// ═══════════════════════════════════════════

export async function checkSyncStatus() {
  const btn = document.getElementById('sync-check-btn');
  const results = document.getElementById('sync-results');
  if (!btn || !results) return;

  btn.classList.add('loading');
  btn.disabled = true;
  results.innerHTML = '';

  try {
    const res = await fetch('/api/sync/check');
    const data = await res.json();

    if (data.total_stale === 0) {
      results.innerHTML = `
        <div class="sync-summary clean">
          <strong>All clear</strong> \u2014 checked ${data.total_with_files} memories with related files, none are stale.
        </div>`;
      return;
    }

    let html = `
      <div class="sync-summary">
        <strong>${data.total_stale}</strong> of ${data.total_with_files} memories are stale
        <button class="sync-select-all" id="sync-select-all">Deselect all</button>
      </div>`;

    for (const mem of data.stale) {
      const preview = mem.content.length > 120
        ? mem.content.slice(0, 120) + '...'
        : mem.content;
      const files = mem.stale_files.map(f => `<span>${f.path}</span>`).join(', ');

      html += `
        <div class="sync-card selected" data-sync-id="${mem.id}">
          <div class="sync-card-header">
            <div class="sync-card-check"></div>
            <span class="sync-card-category">${mem.category}</span>
            <span class="sync-card-importance">imp ${mem.importance}</span>
          </div>
          <div class="sync-card-content">${escapeHtml(preview)}</div>
          <div class="sync-card-files">Changed: ${files}</div>
        </div>`;
    }

    html += `<button class="sync-copy-btn" id="sync-copy-all">Copy sync prompt (${data.total_stale})</button>`;
    results.innerHTML = html;

    results._syncData = data;

    // Card selection toggle
    results.querySelectorAll('.sync-card').forEach(card => {
      card.addEventListener('click', () => {
        card.classList.toggle('selected');
        updateSyncCopyBtn();
      });
    });

    // Copy button
    const copyBtn = document.getElementById('sync-copy-all');
    if (copyBtn) copyBtn.addEventListener('click', () => copySyncPrompt());

    // Select all / Deselect all
    document.getElementById('sync-select-all').addEventListener('click', () => {
      const cards = results.querySelectorAll('.sync-card');
      const allSelected = [...cards].every(c => c.classList.contains('selected'));
      cards.forEach(c => c.classList.toggle('selected', !allSelected));
      updateSyncCopyBtn();
    });
  } catch (err) {
    results.innerHTML = `<div class="sync-summary" style="color:var(--accent-red)">Error: ${err.message}</div>`;
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function updateSyncCopyBtn() {
  const results = document.getElementById('sync-results');
  const btn = document.getElementById('sync-copy-all');
  const selectAllBtn = document.getElementById('sync-select-all');
  if (!results || !btn) return;

  const cards = results.querySelectorAll('.sync-card');
  const selected = results.querySelectorAll('.sync-card.selected');
  const count = selected.length;

  btn.textContent = count ? `Copy sync prompt (${count})` : 'Copy sync prompt';
  btn.disabled = count === 0;

  if (selectAllBtn) {
    const allSelected = selected.length === cards.length;
    selectAllBtn.textContent = allSelected ? 'Deselect all' : 'Select all';
  }
}

export function copySyncPrompt() {
  const results = document.getElementById('sync-results');
  const data = results?._syncData;
  if (!data || !data.stale.length) return;

  const selectedIds = new Set(
    [...results.querySelectorAll('.sync-card.selected')].map(c => c.dataset.syncId)
  );
  const selected = data.stale.filter(m => selectedIds.has(m.id));
  if (!selected.length) return;

  let prompt = `The following ${selected.length} memories have stale related files and need updating. For each memory, read the current file content, compare it with the memory, and use the reflect tool to update the memory content to match the current code.\n\n`;

  for (const mem of selected) {
    prompt += `Memory ${mem.id}:\n`;
    prompt += `- Category: ${mem.category}\n`;
    prompt += `- Importance: ${mem.importance}\n`;
    prompt += `- Related files: ${mem.related_files.join(', ')}\n`;
    prompt += `- Changed files: ${mem.stale_files.map(f => f.path).join(', ')}\n`;
    prompt += `- Current content:\n${mem.content}\n\n`;
  }

  navigator.clipboard.writeText(prompt).then(() => {
    showSyncCopiedModal(selected.length);
  });
}

function showSyncCopiedModal(count) {
  const modal = document.createElement('div');
  modal.className = 'tag-delete-overlay';
  modal.style.background = 'rgba(0,0,0,0.6)';
  modal.innerHTML = `
    <div class="tag-delete-modal" style="max-width:380px">
      <div class="tag-delete-modal-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        Prompt copied
      </div>
      <p style="font-size:var(--fs-sm);color:var(--t-secondary);margin-bottom:6px">
        ${count} ${count === 1 ? 'memory' : 'memories'} ready to sync.
      </p>
      <p style="font-size:var(--fs-sm);color:var(--t-secondary);margin-bottom:6px">
        Paste this prompt into your preferred model to update the stale memories.
      </p>
      <p style="font-size:var(--fs-xs);color:var(--t-muted);margin-bottom:18px">
        The model you choose affects output accuracy \u2014 more capable models produce better rewrites.
      </p>
      <div class="tag-delete-modal-actions">
        <button class="action-btn action-btn--ghost" id="sync-modal-close">Got it</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('visible'));

  const closeModal = () => {
    modal.classList.remove('visible');
    setTimeout(() => modal.remove(), 200);
  };
  modal.querySelector('#sync-modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
}


// ═══════════════════════════════════════════
// INIT — wire settings button clicks
// ═══════════════════════════════════════════

export function initSettings() {
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => openSettingsModal());

  const titlebarBtn = document.getElementById('titlebar-settings-btn');
  if (titlebarBtn) titlebarBtn.addEventListener('click', () => openSettingsModal());

  const menubarBtn = document.getElementById('menubar-settings-btn');
  if (menubarBtn) menubarBtn.addEventListener('click', () => openSettingsModal());

  registerAction('open-settings', openSettingsModal);

  // Expose sync functions for inline onclick attributes (if any remain)
  window.checkSyncStatus = checkSyncStatus;
  window.copySyncPrompt = copySyncPrompt;
}
