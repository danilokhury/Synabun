// ═══════════════════════════════════════════
// UI-SETTINGS — Settings modal with shared tabs + variant tab injection
// ═══════════════════════════════════════════
//
// The most complex shared UI module. Builds a floating settings panel with
// 6 shared tabs (Server, Connections, Collections, Projects, Memory, Interface)
// plus any variant-registered tabs (e.g. Graphics) injected via the registry.

import { state, emit, on } from './state.js';
import { getSettingsTabs } from './registry.js';
import { escapeHtml } from './utils.js';
import { storage } from './storage.js';

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
  setup: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
};

// ── Shared icon constants ──

const COPY_ICON = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHEVRON_ICON = '<svg class="cc-section-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>';
const ANTHROPIC_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="currentColor"/></svg>';
const GEMINI_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="currentColor"/></svg>';
const OPENAI_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" fill="currentColor"/></svg>';

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
    // Hide controls + 2D canvases
    for (const id of ['controls-panel', 'stats-bar']) {
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
      for (const id of ['controls-panel', 'stats-bar']) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('viz-hidden');
      }
    } else {
      // User toggle — delay controls until iris starts opening
      setTimeout(() => {
        for (const id of ['controls-panel', 'stats-bar']) {
          const el = document.getElementById(id);
          if (el) el.classList.remove('viz-hidden');
        }
      }, 200);
    }
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

const SHARED_TAB_IDS = ['server', 'hooks', 'terminal', 'setup', 'collections', 'projects', 'memory', 'interface'];

// ═══════════════════════════════════════════
// TAB HTML BUILDERS
// ═══════════════════════════════════════════

function buildNavHTML(variantTabs) {
  let html = '';
  // Shared tabs
  for (const id of SHARED_TAB_IDS) {
    const label = id === 'server' ? 'General' : id === 'hooks' ? 'Connections' : id === 'collections' ? 'Memory'
      : id === 'terminal' ? 'Terminal' : id.charAt(0).toUpperCase() + id.slice(1);
    html += `<button class="settings-nav-item${id === 'server' ? ' active' : ''}" data-tab="${id}">
      ${TAB_ICONS[id] || ''}
      ${label}
    </button>\n`;
  }
  // Separator before variant tabs
  if (variantTabs.length) {
    html += `<div class="settings-nav-sep"></div>\n`;
  }
  // Variant-registered tabs
  for (const tab of variantTabs) {
    const icon = TAB_ICONS[tab.id] || (tab.icon.startsWith('<') ? tab.icon : `<span style="font-size:14px">${tab.icon}</span>`);
    html += `<button class="settings-nav-item" data-tab="${tab.id}">
      ${icon}
      ${tab.label}
    </button>\n`;
  }
  return html;
}

function buildServerTab(settings, qdrantOk) {
  return `
      <div class="settings-tab-body active" data-tab="server">
        <div class="settings-status">
          <span class="settings-status-dot ${qdrantOk ? 'connected' : 'disconnected'}"></span>
          Qdrant: ${qdrantOk ? 'Connected' : 'Not connected'}
        </div>
        <div class="settings-field">
          <label>OpenAI API Key</label>
          <div class="settings-key-row">
            <input type="password" id="stg-openai" placeholder="${settings.openaiApiKey || 'sk-...'}" autocomplete="off" spellcheck="false">
            <button class="settings-toggle-vis" data-target="stg-openai" data-tooltip="Toggle">${eyeClosed}</button>
          </div>
          <div class="settings-hint">${settings.openaiApiKeySet ? 'Key is set' : 'Not configured'} — leave empty to keep current</div>
        </div>
        <div class="settings-field">
          <label>Qdrant URL</label>
          <div class="settings-key-row">
            <input type="text" id="stg-qdrant-url" placeholder="${settings.qdrantUrl || 'http://localhost:6333'}" autocomplete="off" spellcheck="false">
          </div>
          <div class="settings-hint">Default: http://localhost:6333</div>
        </div>
        <div class="settings-field">
          <label>Qdrant API Key</label>
          <div class="settings-key-row">
            <input type="password" id="stg-qdrant-key" placeholder="${settings.qdrantApiKey || 'your-key'}" autocomplete="off" spellcheck="false">
            <button class="settings-toggle-vis" data-target="stg-qdrant-key" data-tooltip="Toggle">${eyeClosed}</button>
          </div>
          <div class="settings-hint">${settings.qdrantApiKeySet ? 'Key is set' : 'Not configured'} — leave empty to keep current</div>
        </div>
        <div class="settings-restart-notice" id="stg-restart-notice">Settings saved. Restart the server for changes to take effect.</div>
        <div class="settings-actions">
          <button class="settings-btn-cancel" id="stg-cancel">Cancel</button>
          <button class="settings-btn-save" id="stg-save">Save</button>
        </div>

        <div style="margin:20px 0 16px;border-top:1px solid var(--s-medium)"></div>
        <div class="gfx-group-title">System Backup & Restore</div>
        <div class="settings-hint" style="margin-bottom:12px">
          Create a full backup of all SynaBun data including .env config, data files,
          category definitions, and Qdrant collection snapshots.
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

      </div>`;
}

function buildCollectionsTab(connections) {
  return `
      <div class="settings-tab-body" data-tab="collections">
        <div class="gfx-group-title">Memory Collections</div>
        <div class="conn-list" id="conn-list">
          ${connections.length === 0 ? '<div class="conn-empty">No connections configured</div>' :
            connections.map(c => `
              <div class="conn-item${c.active ? ' active' : ''}${!c.reachable ? ' unreachable' : ''}" data-conn-id="${c.id}">
                <div class="conn-item-dot"></div>
                <div class="conn-item-info">
                  <div class="conn-item-name">${c.label || c.collection}</div>
                  <div class="conn-item-meta">${c.collection}</div>
                </div>
                ${c.reachable ? `<span class="conn-item-count">${c.points} pts</span>` : ''}
                ${!c.reachable && /localhost|127\\.0\\.0\\.1/.test(c.url) ? `
                  <button class="conn-item-start" data-conn-id="${c.id}" data-tooltip="Start Container">
                    <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  </button>
                ` : ''}
                ${c.reachable ? `
                  <button class="conn-item-action conn-item-backup" data-conn-id="${c.id}" data-tooltip="Backup">
                    <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </button>
                  <button class="conn-item-action conn-item-restore" data-conn-id="${c.id}" data-tooltip="Restore">
                    <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  </button>
                ` : ''}
                <button class="conn-item-delete" data-conn-id="${c.id}" data-conn-label="${c.label || c.collection}" data-tooltip="Remove">
                  <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            `).join('')}
        </div>
        <button class="conn-add-btn" id="conn-add-btn">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Collection
        </button>
        <button class="conn-add-btn" id="conn-restore-standalone" style="margin-top:6px; border-style:solid">
          <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Restore from Backup
        </button>
      </div>`;
}

function buildConnectionsTab(ccIntegrations, ccSkills, tunnelStatus, mcpKeyInfo, openclawBridge, greetingConfig) {
  const gh = ccIntegrations.global.hooks || {};
  const projs = ccIntegrations.projects || [];
  const ssOn = gh.SessionStart && projs.every(p => (p.hooks || {}).SessionStart);
  const psOn = gh.UserPromptSubmit && projs.every(p => (p.hooks || {}).UserPromptSubmit);
  const pcOn = gh.PreCompact && projs.every(p => (p.hooks || {}).PreCompact);
  const stOn = gh.Stop && projs.every(p => (p.hooks || {}).Stop);
  const ptOn = gh.PostToolUse && projs.every(p => (p.hooks || {}).PostToolUse);
  const allOn = ssOn && psOn && pcOn && stOn && ptOn;
  const onCount = [ssOn, psOn, pcOn, stOn, ptOn].filter(Boolean).length;
  const hf = ccIntegrations.hookFeatures || {};
  const cmOn = hf.conversationMemory !== false;
  const grOn = hf.greeting === true;
  const ulOn = hf.userLearning !== false;
  const ulThreshold = hf.userLearningThreshold || 8;

  const hookRows = [
    { key: 'SessionStart', on: ssOn, label: 'SessionStart', desc: 'Runs once when a new session begins' },
    { key: 'UserPromptSubmit', on: psOn, label: 'UserPromptSubmit', desc: 'Runs on every user message' },
    { key: 'PreCompact', on: pcOn, label: 'PreCompact', desc: 'Caches session data before context compaction' },
    { key: 'Stop', on: stOn, label: 'Stop', desc: 'Enforces session indexing after compaction' },
    { key: 'PostToolUse', on: ptOn, label: 'PostToolUse', desc: 'Tracks edits and clears enforcement flags on remember' },
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
            ${providerBadge({ cli: true, vscode: true, web: false, cowork: false })}
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
              <button class="cc-toggle${grOn ? ' on' : ''}" data-cc-feature="greeting"></button>
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
            <span style="display:flex;align-items:center;gap:6px">${chevron} Hooks <span class="cc-hooks-badge${allOn ? ' all-on' : ''}" id="cc-hooks-badge">${onCount}/5</span></span>
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

        <!-- 3. FEATURES -->
        <div class="iface-section collapsed" data-collapsible>
          <div class="gfx-group-title" style="justify-content:space-between">
            <span style="display:flex;align-items:center;gap:6px">${chevron} Features</span>
            ${providerBadge({ cli: true, vscode: true, web: false, cowork: false })}
          </div>
          <div class="cc-section-body">
            <div class="cc-hook-toggles">
              <div class="cc-integration-item${cmOn ? ' enabled' : ''}" data-feature="conversationMemory">
                <div class="cc-integration-info">
                  <div class="cc-integration-label">Conversation Memory</div>
                  <div class="cc-integration-path">Auto-index sessions on compaction for cross-session recall</div>
                </div>
                <button class="cc-toggle${cmOn ? ' on' : ''}" data-cc-feature="conversationMemory"></button>
              </div>
              <div class="cc-integration-item${ulOn ? ' enabled' : ''}" data-feature="userLearning">
                <div class="cc-integration-info">
                  <div class="cc-integration-label">User Learning</div>
                  <div class="cc-integration-path">Observe communication patterns, preferences, and behavioral singularity</div>
                  <div class="cc-ul-threshold" id="cc-ul-threshold" style="display:${ulOn ? 'flex' : 'none'};align-items:center;gap:6px;margin-top:5px">
                    <span style="font-size:10px;color:var(--t-dim);white-space:nowrap">Reflect every</span>
                    <input type="number" id="cc-ul-threshold-input" min="3" max="30" value="${ulThreshold}" style="width:40px;padding:2px 4px;font-size:10px;background:rgba(255,255,255,0.04);border:1px solid var(--b-subtle);border-radius:4px;color:var(--t-bright);text-align:center;font-family:inherit">
                    <span style="font-size:10px;color:var(--t-dim)">interactions</span>
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
            <span style="display:flex;align-items:center;gap:6px">${chevron} External Access</span>
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

        <!-- 7. SKILLS (conditional) -->
        ${ccSkills.length > 0 ? `
        <div class="iface-section collapsed" data-collapsible>
          <div class="gfx-group-title" style="justify-content:space-between">
            <span style="display:flex;align-items:center;gap:6px">${chevron} Skills</span>
            ${providerBadge({ cli: true, vscode: true, web: false, cowork: false })}
          </div>
          <div class="cc-section-body">
            ${ccSkills.map(skill => `
              <div class="cc-skill-row${skill.installed ? ' installed' : ''}" data-skill-name="${skill.dirName}">
                <div class="cc-skill-info">
                  <span class="cc-skill-name">/${skill.name}</span>
                  <span class="cc-skill-desc">${skill.description || ''}</span>
                </div>
                <button class="cc-toggle${skill.installed ? ' on' : ''}" data-cc-skill="${skill.dirName}"></button>
              </div>
            `).join('')}
          </div>
        </div>` : ''}
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
// MAIN ENTRY — openSettingsModal
// ═══════════════════════════════════════════

export async function openSettingsModal() {
  // If already open, just bring it to front
  const existing = document.getElementById('settings-panel');
  if (existing) { existing.style.zIndex = '301'; return; }

  // ── Fetch all data in parallel ──
  let settings = {};
  let qdrantOk = false;
  let connections = [];
  let ccIntegrations = { global: { installed: false }, projects: [] };
  let ccSkills = [];
  let tunnelStatus = { available: false, running: false, url: null };
  let mcpKeyInfo = { hasKey: false };
  let _bridgeResult = null;
  let greetingConfig = { defaults: {}, projects: {}, global: {} };
  let setupStatus = { claude: {}, gemini: {}, codex: {}, paths: {} };
  let cliConfig = {};

  try {
    const [settingsRes, statsRes, connRes, ccRes, skillsRes, tunnelRes, keyRes, bridgeRes, greetRes, setupRes, cliRes] = await Promise.allSettled([
      fetch('/api/settings').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/connections').then(r => r.json()),
      fetch('/api/claude-code/integrations').then(r => r.json()),
      fetch('/api/claude-code/skills').then(r => r.json()),
      fetch('/api/tunnel/status').then(r => r.json()),
      fetch('/api/mcp-key').then(r => r.json()),
      fetch('/api/bridges/openclaw').then(r => r.json()),
      fetch('/api/greeting/config').then(r => r.json()),
      fetch('/api/setup/status').then(r => r.json()),
      fetch('/api/cli/config').then(r => r.json()),
    ]);
    if (settingsRes.status === 'fulfilled') settings = settingsRes.value;
    if (statsRes.status === 'fulfilled' && statsRes.value.status) qdrantOk = true;
    if (connRes.status === 'fulfilled' && connRes.value.connections) connections = connRes.value.connections;
    if (ccRes.status === 'fulfilled' && ccRes.value.ok) ccIntegrations = ccRes.value;
    if (skillsRes.status === 'fulfilled' && skillsRes.value.ok) ccSkills = skillsRes.value.skills || [];
    if (tunnelRes.status === 'fulfilled' && tunnelRes.value.ok) tunnelStatus = tunnelRes.value;
    if (keyRes.status === 'fulfilled' && keyRes.value.ok) mcpKeyInfo = keyRes.value;
    if (bridgeRes.status === 'fulfilled' && bridgeRes.value.ok) _bridgeResult = bridgeRes.value;
    if (greetRes.status === 'fulfilled' && greetRes.value.ok) greetingConfig = greetRes.value.config;
    if (setupRes.status === 'fulfilled' && setupRes.value.ok) setupStatus = setupRes.value;
    if (cliRes.status === 'fulfilled' && cliRes.value.ok) cliConfig = cliRes.value.config;
  } catch {}
  let openclawBridge = _bridgeResult || { enabled: false };

  // ── Gather variant-registered settings tabs ──
  const variantTabs = getSettingsTabs();

  // ── Backdrop ──
  const backdrop = document.createElement('div');
  backdrop.className = 'settings-panel-backdrop';
  document.body.appendChild(backdrop);

  // ── Panel ──
  const overlay = document.createElement('div');
  overlay.className = 'settings-panel glass resizable';
  overlay.id = 'settings-panel';

  const navbarH = 48; // title-bar height (padding + content)
  const savedPanel = JSON.parse(storage.getItem('neural-panel-settings-panel') || 'null');
  if (savedPanel) {
    if (savedPanel.left && savedPanel.left !== 'auto') overlay.style.left = savedPanel.left;
    if (savedPanel.top) overlay.style.top = Math.max(navbarH, parseInt(savedPanel.top, 10) || 0) + 'px';
    if (savedPanel.width) overlay.style.width = savedPanel.width;
    if (savedPanel.height) overlay.style.height = savedPanel.height;
  } else {
    overlay.style.left = Math.max(20, (window.innerWidth - 620) / 2) + 'px';
    overlay.style.top = Math.max(navbarH, (window.innerHeight - 600) / 2) + 'px';
  }

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
      <h3>Settings</h3>
      <button class="settings-panel-close" id="stg-close" data-tooltip="Close">&times;</button>
    </div>
    <div class="settings-panel-body">
      <nav class="settings-nav">
        ${buildNavHTML(variantTabs)}
      </nav>
      <div class="settings-content">
        ${buildServerTab(settings, qdrantOk)}
        ${buildConnectionsTab(ccIntegrations, ccSkills, tunnelStatus, mcpKeyInfo, openclawBridge, greetingConfig)}
        ${buildTerminalTab(cliConfig)}
        ${buildSetupTab(setupStatus)}
        ${buildCollectionsTab(connections)}
        ${buildProjectsTab(ccIntegrations)}
        ${buildMemoryTab()}
        ${buildInterfaceTab()}
        ${variantTabBodies}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // ── Close helper ──
  const close = () => {
    storage.setItem('neural-panel-settings-panel', JSON.stringify({
      left: overlay.style.left || null,
      top: overlay.style.top || null,
      width: overlay.style.width || null,
      height: overlay.style.height || null,
    }));
    overlay.remove();
    backdrop.remove();
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
  overlay.querySelector('#stg-cancel').addEventListener('click', close);

  // ── Save handler (server tab) ──
  overlay.querySelector('#stg-save').addEventListener('click', async () => {
    const body = {};
    const openai = overlay.querySelector('#stg-openai').value.trim();
    const qdrantUrl = overlay.querySelector('#stg-qdrant-url').value.trim();
    const qdrantKey = overlay.querySelector('#stg-qdrant-key').value.trim();
    if (openai) body.openaiApiKey = openai;
    if (qdrantUrl) body.qdrantUrl = qdrantUrl;
    if (qdrantKey) body.qdrantApiKey = qdrantKey;
    if (Object.keys(body).length === 0) { close(); return; }
    try {
      const saveBtn = overlay.querySelector('#stg-save');
      saveBtn.textContent = 'Saving...';
      saveBtn.disabled = true;
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        const notice = overlay.querySelector('#stg-restart-notice');
        notice.textContent = data.message || 'Settings saved.';
        notice.style.display = 'block';
        saveBtn.textContent = 'Saved';
        setTimeout(() => { close(); location.reload(); }, 2000);
      } else {
        saveBtn.textContent = 'Error';
        saveBtn.disabled = false;
      }
    } catch {
      const saveBtn = overlay.querySelector('#stg-save');
      saveBtn.textContent = 'Error';
      saveBtn.disabled = false;
    }
  });

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
      statusText.textContent = 'Collecting files and creating Qdrant snapshots...';

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

        // Build confirmation modal
        const connList = Object.entries(m.connections || {})
          .map(([id, c]) => `<li><strong>${escapeHtml(c.label)}</strong> (${escapeHtml(c.collection)}) — ${c.pointCount} memories</li>`)
          .join('');
        const unreachList = (m.unreachableConnections || [])
          .map(id => `<li style="color:var(--t-muted)">${escapeHtml(id)} (was unreachable at backup time)</li>`)
          .join('');
        const fileCount = (m.files || []).length;

        const confirmOverlay = document.createElement('div');
        confirmOverlay.className = 'tag-delete-overlay';
        confirmOverlay.style.zIndex = '10001';
        confirmOverlay.innerHTML = `
          <div class="tag-delete-modal settings-modal" style="max-width:500px;text-align:left">
            <h3 style="margin-bottom:4px">Restore Full Backup</h3>
            <p style="font-size:11px;color:var(--t-muted);margin-bottom:12px">
              Created: ${new Date(m.created).toLocaleString()} on ${escapeHtml(m.hostname || 'unknown')}
            </p>
            <div style="font-size:12px;margin-bottom:8px">
              <strong>${fileCount}</strong> config files
            </div>
            ${connList ? `<div style="font-size:12px;margin-bottom:8px">
              <strong>Qdrant snapshots:</strong>
              <ul style="margin:4px 0 0 16px;padding:0">${connList}</ul>
            </div>` : ''}
            ${unreachList ? `<div style="font-size:11px;color:var(--t-muted);margin-bottom:8px">
              <strong>Skipped at backup time:</strong>
              <ul style="margin:4px 0 0 16px;padding:0">${unreachList}</ul>
            </div>` : ''}
            <p style="font-size:11px;color:var(--accent-dim);margin-bottom:12px">
              This will overwrite your current .env, data files, and Qdrant collections.
              This action cannot be undone.
            </p>
            <div class="settings-field" style="margin-bottom:14px">
              <label style="font-size:11px">Restore mode</label>
              <select id="sys-restore-mode" class="modal-select" style="margin-bottom:0">
                <option value="full">Full (config + snapshots)</option>
                <option value="config-only">Config files only</option>
                <option value="snapshots-only">Qdrant snapshots only</option>
              </select>
            </div>
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
          const mode = confirmOverlay.querySelector('#sys-restore-mode').value;

          confirmBtn.textContent = 'Restoring...';
          confirmBtn.disabled = true;
          progressEl.style.display = 'flex';
          progressDot.className = 'wiz-status-dot spin';

          const hasSnapshots = Object.keys(m.connections || {}).length > 0;
          const needsSnapshots = (mode === 'full' || mode === 'snapshots-only') && hasSnapshots;

          try {
            let restoredFileCount = 0;
            let snapCount = 0;
            let errCount = 0;

            if (mode === 'full' && needsSnapshots) {
              // Phase 1: Restore config files first
              progressText.textContent = 'Restoring config files...';
              const configRes = await fetch('/api/system/restore?mode=config-only', {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: buffer,
              });
              if (!configRes.ok) {
                let errMsg = 'Config restore failed';
                try { const body = await configRes.json(); errMsg = body.error || errMsg; } catch {}
                throw new Error(errMsg);
              }
              const configResult = await configRes.json();
              restoredFileCount = configResult.results?.files?.length || 0;

              // Phase 2: Ensure Qdrant is running
              progressText.textContent = 'Starting Qdrant...';
              const healthRes = await fetch('/api/health/start', { method: 'POST' });
              const healthData = await healthRes.json();
              if (!healthData.ok) {
                throw new Error('Failed to start Qdrant: ' + (healthData.error || 'unknown'));
              }
              if (!healthData.ready) {
                throw new Error('Qdrant started but is not responding. Try again.');
              }

              // Phase 3: Restore snapshots
              progressText.textContent = 'Restoring memory snapshots...';
              const snapRes = await fetch('/api/system/restore?mode=snapshots-only', {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: buffer,
              });
              if (!snapRes.ok) {
                let errMsg = 'Snapshot restore failed';
                try { const body = await snapRes.json(); errMsg = body.error || errMsg; } catch {}
                throw new Error(errMsg);
              }
              const snapResult = await snapRes.json();
              snapCount = snapResult.results?.snapshots?.length || 0;
              errCount = snapResult.results?.errors?.length || 0;

            } else if (mode === 'snapshots-only' && needsSnapshots) {
              // Ensure Qdrant is running before snapshot restore
              progressText.textContent = 'Starting Qdrant...';
              const healthRes = await fetch('/api/health/start', { method: 'POST' });
              const healthData = await healthRes.json();
              if (!healthData.ok) {
                throw new Error('Failed to start Qdrant: ' + (healthData.error || 'unknown'));
              }
              if (!healthData.ready) {
                throw new Error('Qdrant started but is not responding. Try again.');
              }

              progressText.textContent = 'Restoring memory snapshots...';
              const restoreRes = await fetch('/api/system/restore?mode=snapshots-only', {
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
              snapCount = result.results?.snapshots?.length || 0;
              errCount = result.results?.errors?.length || 0;

            } else {
              // Config-only or no snapshots — single call is fine
              progressText.textContent = 'Applying backup...';
              const restoreRes = await fetch(`/api/system/restore?mode=${encodeURIComponent(mode)}`, {
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
              restoredFileCount = result.results?.files?.length || 0;
              snapCount = result.results?.snapshots?.length || 0;
              errCount = result.results?.errors?.length || 0;
            }

            progressDot.className = 'wiz-status-dot green';
            progressText.textContent = `Done! ${restoredFileCount} files, ${snapCount} snapshots restored.`
              + (errCount ? ` ${errCount} errors.` : '');
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
  const PREVIEW_TEXT = 'SynaBun is a persistent vector memory system for AI assistants built with three core components: MCP Server (TypeScript/Node.js), Neural Interface (Express.js + Three.js), and Qdrant Vector Database (Docker). It stores memory embeddings in a single collection with cosine distance similarity and supports multiple projects.';

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
  // Collections tab handlers
  // ══════════════════════════════════════

  // Click a connection item to switch to it
  overlay.querySelectorAll('.conn-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.conn-item-delete') || e.target.closest('.conn-item-action') || e.target.closest('.conn-item-start')) return;
      const id = item.dataset.connId;
      if (!id || item.classList.contains('active')) return;
      if (item.classList.contains('unreachable')) { alert('This connection is offline. Start the container first.'); return; }
      item.style.opacity = '0.5';
      item.style.pointerEvents = 'none';
      try {
        const res = await fetch('/api/connections/active', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        const data = await res.json();
        if (data.ok) { close(); location.reload(); }
        else { alert(data.error || 'Failed to switch connection'); item.style.opacity = ''; item.style.pointerEvents = ''; }
      } catch (err) { alert('Failed to switch: ' + err.message); item.style.opacity = ''; item.style.pointerEvents = ''; }
    });
  });

  // Delete a connection
  overlay.querySelectorAll('.conn-item-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.connId;
      const label = btn.dataset.connLabel;
      if (!id) return;
      if (!confirm(`Remove connection "${label}"?\nThis only removes the config, not the Qdrant data.`)) return;
      try {
        const res = await fetch(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          const item = btn.closest('.conn-item');
          item.style.transition = 'opacity 0.2s, transform 0.2s';
          item.style.opacity = '0';
          item.style.transform = 'translateX(10px)';
          setTimeout(() => { item.remove(); if (!overlay.querySelector('.conn-item')) overlay.querySelector('#conn-list').innerHTML = '<div class="conn-empty">No connections configured</div>'; }, 200);
        } else { alert(data.error || 'Failed to remove connection'); }
      } catch (err) { alert('Failed to remove: ' + err.message); }
    });
  });

  // Start a stopped Docker container
  overlay.querySelectorAll('.conn-item-start').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const connId = btn.dataset.connId;
      if (!connId) return;
      btn.disabled = true;
      btn.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;animation:dep-spin 0.7s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
      try {
        const res = await fetch('/api/connections/start-container', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: connId }) });
        const data = await res.json();
        if (data.ok) { close(); location.reload(); }
        else { alert(data.error || 'Failed to start container'); btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>'; }
      } catch (err) { alert('Failed: ' + err.message); btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>'; }
    });
  });

  // Backup a collection
  overlay.querySelectorAll('.conn-item-backup').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.connId;
      if (!id || btn.classList.contains('backing-up')) return;
      btn.classList.add('backing-up');
      try {
        const res = await fetch(`/api/connections/${encodeURIComponent(id)}/backup`, { method: 'POST' });
        if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Backup failed'); }
        const blob = await res.blob();
        const disposition = res.headers.get('content-disposition') || '';
        const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
        const filename = filenameMatch ? filenameMatch[1] : `backup-${id}.snapshot`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      } catch (err) { alert('Backup failed: ' + err.message); }
      finally { btn.classList.remove('backing-up'); }
    });
  });

  // Restore a collection (upload snapshot)
  overlay.querySelectorAll('.conn-item-restore').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.connId;
      if (!id || btn.classList.contains('restoring')) return;
      const item = btn.closest('.conn-item');
      const label = item?.querySelector('.conn-item-name')?.textContent || id;
      const collection = item?.querySelector('.conn-item-meta')?.textContent || '';
      const fileInput = document.createElement('input');
      fileInput.type = 'file'; fileInput.accept = '.snapshot'; fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0]; fileInput.remove(); if (!file) return;
        const confirmOverlay = document.createElement('div');
        confirmOverlay.className = 'tag-delete-overlay'; confirmOverlay.style.zIndex = '10001';
        confirmOverlay.innerHTML = `
          <div class="tag-delete-modal" style="max-width:400px">
            <div class="tag-delete-modal-title" style="margin-bottom:8px">Restore Collection</div>
            <p style="font-size:var(--fs-sm);color:var(--t-secondary);margin-bottom:6px">This will replace all data in <strong style="color:var(--t-bright)">${label}</strong> (${collection}) with the snapshot file.</p>
            <p style="font-size:var(--fs-xs);color:var(--t-muted);margin-bottom:4px">File: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)</p>
            <p style="font-size:var(--fs-xs);color:var(--accent-dim);margin-bottom:18px">The snapshot must be from the same Qdrant version.</p>
            <div class="tag-delete-modal-actions">
              <button class="action-btn action-btn--ghost" id="restore-cancel">Cancel</button>
              <button class="action-btn action-btn--danger" id="restore-confirm" style="background:var(--accent-blue-bg);border-color:var(--accent-blue-border);color:var(--accent-blue)">Restore</button>
            </div>
          </div>`;
        document.body.appendChild(confirmOverlay);
        confirmOverlay.querySelector('#restore-cancel').addEventListener('click', () => confirmOverlay.remove());
        confirmOverlay.addEventListener('click', (ev) => { if (ev.target === confirmOverlay) confirmOverlay.remove(); });
        confirmOverlay.querySelector('#restore-confirm').addEventListener('click', async () => {
          const confirmBtn = confirmOverlay.querySelector('#restore-confirm');
          confirmBtn.textContent = 'Restoring...'; confirmBtn.disabled = true; btn.classList.add('restoring');
          try {
            const buffer = await file.arrayBuffer();
            const res = await fetch(`/api/connections/${encodeURIComponent(id)}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Restore failed');
            confirmOverlay.remove();
            try {
              const connRes = await fetch('/api/connections'); const connData = await connRes.json();
              if (connData.connections) { const pts = connData.connections.find(c => c.id === id); if (pts) { const countEl = item.querySelector('.conn-item-count'); if (countEl) countEl.textContent = pts.points + ' pts'; } }
            } catch {}
          } catch (err) { alert('Restore failed: ' + err.message); confirmOverlay.remove(); }
          finally { btn.classList.remove('restoring'); }
        });
      });
      fileInput.click();
    });
  });

  // Restore from Backup — standalone
  overlay.querySelector('#conn-restore-standalone').addEventListener('click', () => {
    const restoreOverlay = document.createElement('div');
    restoreOverlay.className = 'tag-delete-overlay'; restoreOverlay.style.zIndex = '10001';
    restoreOverlay.innerHTML = `
      <div class="tag-delete-modal settings-modal" style="max-width:460px;text-align:left">
        <h3 style="margin-bottom:4px">Restore from Backup</h3>
        <p style="font-size:11px;color:var(--t-muted);margin-bottom:18px;line-height:1.5">Upload a .snapshot file to restore a collection. The collection will be created if it doesn't exist, and automatically added to your connections.</p>
        <div class="settings-field" style="margin-bottom:12px"><label>Qdrant URL</label><input type="text" id="rs-url" placeholder="http://localhost:6333" autocomplete="off" spellcheck="false" style="font-family:'JetBrains Mono',monospace;font-size:12px"></div>
        <div class="settings-field" style="margin-bottom:12px"><label>API Key</label><input type="text" id="rs-key" placeholder="your-api-key" autocomplete="off" spellcheck="false" style="font-family:'JetBrains Mono',monospace;font-size:12px"></div>
        <div class="settings-field" style="margin-bottom:12px"><label>Collection Name</label><input type="text" id="rs-collection" placeholder="claude_memory" autocomplete="off" spellcheck="false" style="font-family:'JetBrains Mono',monospace;font-size:12px"><div style="font-size:10px;color:var(--t-muted);margin-top:3px">Lowercase, digits, underscores. Will be created if it doesn't exist.</div></div>
        <div class="settings-field" style="margin-bottom:12px"><label>Label (optional)</label><input type="text" id="rs-label" placeholder="My Restored Memory" autocomplete="off" spellcheck="false" style="font-size:12px"></div>
        <div class="settings-field" style="margin-bottom:16px"><label>Snapshot File</label><div style="display:flex;align-items:center;gap:8px"><button class="settings-btn-cancel" id="rs-pick-file" style="font-size:11px;padding:6px 12px">Choose .snapshot file</button><span id="rs-file-name" style="font-size:11px;color:var(--t-muted)">No file selected</span></div><input type="file" id="rs-file-input" accept=".snapshot" style="display:none"></div>
        <div id="rs-status" style="display:none;margin-bottom:12px;font-size:12px;display:flex;align-items:center;gap:8px"><div class="wiz-status-dot spin" id="rs-status-dot"></div><span id="rs-status-text"></span></div>
        <div class="settings-actions"><button class="settings-btn-cancel" id="rs-cancel">Cancel</button><button class="settings-btn-save" id="rs-restore" disabled>Restore</button></div>
      </div>`;
    document.body.appendChild(restoreOverlay);
    let selectedFile = null;
    const fileInput = restoreOverlay.querySelector('#rs-file-input');
    const fileName = restoreOverlay.querySelector('#rs-file-name');
    const restoreBtn = restoreOverlay.querySelector('#rs-restore');
    const statusEl = restoreOverlay.querySelector('#rs-status');
    const statusDot = restoreOverlay.querySelector('#rs-status-dot');
    const statusText = restoreOverlay.querySelector('#rs-status-text');
    const closeRestore = () => restoreOverlay.remove();
    restoreOverlay.querySelector('#rs-cancel').addEventListener('click', closeRestore);
    restoreOverlay.querySelector('#rs-pick-file').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      selectedFile = fileInput.files[0] || null;
      if (selectedFile) { fileName.textContent = selectedFile.name + ' (' + (selectedFile.size / 1024 / 1024).toFixed(1) + ' MB)'; fileName.style.color = 'var(--t-primary)'; }
      else { fileName.textContent = 'No file selected'; fileName.style.color = 'var(--t-muted)'; }
      checkReady();
    });
    function checkReady() {
      const url = restoreOverlay.querySelector('#rs-url').value.trim();
      const key = restoreOverlay.querySelector('#rs-key').value.trim();
      const col = restoreOverlay.querySelector('#rs-collection').value.trim();
      restoreBtn.disabled = !url || !key || !col || !selectedFile;
    }
    restoreOverlay.querySelectorAll('input[type="text"]').forEach(inp => inp.addEventListener('input', checkReady));
    restoreBtn.addEventListener('click', async () => {
      const url = restoreOverlay.querySelector('#rs-url').value.trim();
      const apiKey = restoreOverlay.querySelector('#rs-key').value.trim();
      const collection = restoreOverlay.querySelector('#rs-collection').value.trim();
      const label = restoreOverlay.querySelector('#rs-label').value.trim();
      if (!url || !apiKey || !collection || !selectedFile) return;
      restoreBtn.disabled = true; restoreBtn.textContent = 'Restoring...';
      statusEl.style.display = 'flex'; statusDot.className = 'wiz-status-dot spin'; statusText.textContent = 'Uploading and restoring snapshot...';
      try {
        const buffer = await selectedFile.arrayBuffer();
        const params = new URLSearchParams({ url, apiKey, collection }); if (label) params.set('label', label);
        const res = await fetch('/api/connections/restore-standalone?' + params.toString(), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Restore failed');
        statusDot.className = 'wiz-status-dot green'; statusText.textContent = data.message; restoreBtn.textContent = 'Done';
        setTimeout(() => { closeRestore(); close(); location.reload(); }, 1200);
      } catch (err) { statusDot.className = 'wiz-status-dot red'; statusText.textContent = err.message; restoreBtn.textContent = 'Restore'; restoreBtn.disabled = false; }
    });
  });

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

  // Collapsible iface-section cards (Connections tab) — click anywhere on the card
  overlay.querySelectorAll('.iface-section[data-collapsible]').forEach(section => {
    section.addEventListener('click', (e) => {
      if (e.target.closest('select, input, button, textarea, a, .cc-section-body')) return;
      section.classList.toggle('collapsed');
    });
  });

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
  }

  function updateGlobalHookBadge() {
    const hooksSection = overlay.querySelector('.iface-section[data-cc-target="global"]');
    if (!hooksSection) return;
    const toggles = hooksSection.querySelectorAll('.cc-toggle[data-cc-scope="global"]');
    const onCount = [...toggles].filter(t => t.classList.contains('on')).length;
    const badge = overlay.querySelector('#cc-hooks-badge');
    if (badge) {
      badge.textContent = `${onCount}/5`;
      badge.classList.toggle('all-on', onCount === 5);
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
    addOverlay.className = 'tag-delete-overlay'; addOverlay.style.zIndex = '10001';
    addOverlay.innerHTML = `
      <div class="tag-delete-modal settings-modal" style="max-width:480px">
        <h3><svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:var(--accent-blue);stroke-width:2;fill:none"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add Project</h3>
        <div class="settings-field"><label>Project Path</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="text" id="cc-proj-path" placeholder="C:/Users/me/MyProject" autocomplete="off" spellcheck="false" style="font-family:'JetBrains Mono',monospace;font-size:12px;flex:1">
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

  // ── Add Collection wizard ──
  overlay.querySelector('#conn-add-btn').addEventListener('click', () => {
    function generateApiKey() {
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    function toDockerName(label) {
      return 'synabun-qdrant-' + label.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }
    function suggestPort() {
      let max = 6333;
      connections.forEach(c => {
        const m = (c.url || '').match(/:(\d+)\/?$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      return max + 10 - (max % 10) + 10;
    }

    const defaultPort = suggestPort();
    const wizState = {
      mode: null, label: '', url: '', apiKey: '', collection: '',
      port: defaultPort, grpcPort: defaultPort + 1,
      containerName: '', volumeName: '',
      dockerReady: false, collectionCreated: false,
    };

    let currentStep = 0;
    const TOTAL_STEPS = 4;

    const wiz = document.createElement('div');
    wiz.className = 'conn-wizard-overlay';
    wiz.innerHTML = `
      <div class="conn-wizard-panel">
        <div class="conn-wizard-viewport" id="wiz-viewport">

          <!-- Step 0: Choose Mode -->
          <div class="conn-wizard-step active" data-wiz-step="0">
            <h3>New Collection</h3>
            <div class="wiz-subtitle">How would you like to set up your new memory collection?</div>
            <div class="wiz-mode-grid">
              <div class="wiz-mode-card" data-mode="docker">
                <svg class="wmc-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><line x1="17.5" y1="14" x2="17.5" y2="21"/><line x1="14" y1="17.5" x2="21" y2="17.5"/></svg>
                <div class="wmc-title">New Docker Instance</div>
                <div class="wmc-desc">Spin up a fresh Qdrant container on its own port</div>
              </div>
              <div class="wiz-mode-card" data-mode="existing">
                <svg class="wmc-icon" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                <div class="wmc-title">Existing Instance</div>
                <div class="wmc-desc">Create a new collection on a running Qdrant</div>
              </div>
            </div>
          </div>

          <!-- Step 1: Configuration -->
          <div class="conn-wizard-step right" data-wiz-step="1">
            <div id="wiz-config-docker" style="display:none">
              <h3>Configure Container</h3>
              <div class="wiz-subtitle">Set up your new Qdrant Docker instance.</div>
              <div class="wiz-field">
                <label>Label</label>
                <input type="text" id="wiz-d-label" placeholder="My Project" autocomplete="off" spellcheck="false">
                <div class="wiz-hint">Friendly name shown in the UI</div>
                <div class="wiz-error" id="wiz-d-label-err"></div>
              </div>
              <div class="wiz-field">
                <label>Collection Name</label>
                <input type="text" id="wiz-d-collection" placeholder="my_collection" autocomplete="off" spellcheck="false">
                <div class="wiz-hint">Lowercase letters, digits, underscores. 3-50 chars.</div>
                <div class="wiz-error" id="wiz-d-collection-err"></div>
              </div>
              <div class="wiz-row">
                <div class="wiz-field">
                  <label>HTTP Port</label>
                  <input type="number" id="wiz-d-port" value="${defaultPort}" min="1024" max="65535">
                  <div class="wiz-hint">REST API port</div>
                </div>
                <div class="wiz-field">
                  <label>gRPC Port</label>
                  <input type="number" id="wiz-d-grpc" value="${defaultPort + 1}" min="1024" max="65535">
                  <div class="wiz-hint">gRPC port</div>
                </div>
              </div>
              <div class="wiz-field">
                <label>API Key</label>
                <div class="wiz-input-row">
                  <input type="text" id="wiz-d-key" value="${generateApiKey()}" autocomplete="off" spellcheck="false">
                  <button class="wiz-generate-btn" id="wiz-d-gen">Generate</button>
                </div>
                <div class="wiz-hint">Secures the Qdrant instance. Min 8 characters.</div>
                <div class="wiz-error" id="wiz-d-key-err"></div>
              </div>
            </div>

            <div id="wiz-config-existing" style="display:none">
              <h3>Instance Details</h3>
              <div class="wiz-subtitle">Connect to a running Qdrant instance and create a new collection.</div>
              <div class="wiz-field">
                <label>Label</label>
                <input type="text" id="wiz-e-label" placeholder="My Memory Store" autocomplete="off" spellcheck="false">
                <div class="wiz-hint">Friendly name shown in the UI</div>
                <div class="wiz-error" id="wiz-e-label-err"></div>
              </div>
              <div class="wiz-field">
                <label>Qdrant URL</label>
                <input type="text" id="wiz-e-url" placeholder="http://localhost:6333" autocomplete="off" spellcheck="false">
                <div class="wiz-hint">The full URL of your Qdrant instance</div>
                <div class="wiz-error" id="wiz-e-url-err"></div>
              </div>
              <div class="wiz-field">
                <label>API Key</label>
                <input type="text" id="wiz-e-key" placeholder="your-api-key" autocomplete="off" spellcheck="false">
                <div class="wiz-error" id="wiz-e-key-err"></div>
              </div>
              <div class="wiz-field">
                <label>Collection Name</label>
                <input type="text" id="wiz-e-collection" placeholder="my_collection" autocomplete="off" spellcheck="false">
                <div class="wiz-hint">Will be created if it doesn't exist. Lowercase, digits, underscores.</div>
                <div class="wiz-error" id="wiz-e-collection-err"></div>
              </div>
            </div>
          </div>

          <!-- Step 2: Action -->
          <div class="conn-wizard-step right" data-wiz-step="2">
            <div id="wiz-action-docker" style="display:none">
              <h3>Start Container</h3>
              <div class="wiz-subtitle">Spinning up a new Qdrant instance and creating your collection.</div>
              <div class="wiz-status" id="wiz-docker-status" style="display:none">
                <div class="wiz-status-dot spin" id="wiz-docker-dot"></div>
                <span id="wiz-docker-status-text">Starting container...</span>
              </div>
              <div class="wiz-terminal" id="wiz-docker-term">Waiting to start...</div>
              <button class="wiz-action-btn" id="wiz-docker-btn">Start Container</button>
            </div>

            <div id="wiz-action-existing" style="display:none">
              <h3>Create Collection</h3>
              <div class="wiz-subtitle">Testing connectivity and creating the collection on your Qdrant instance.</div>
              <div class="wiz-status" id="wiz-existing-status" style="display:none">
                <div class="wiz-status-dot spin" id="wiz-existing-dot"></div>
                <span id="wiz-existing-status-text">Connecting...</span>
              </div>
              <button class="wiz-action-btn" id="wiz-existing-btn">Test & Create</button>
            </div>
          </div>

          <!-- Step 3: Confirm & Save -->
          <div class="conn-wizard-step right" data-wiz-step="3">
            <h3>Confirm & Save</h3>
            <div class="wiz-subtitle">Review your new collection before adding it.</div>
            <div class="wiz-summary-card" id="wiz-summary"></div>
            <button class="wiz-action-btn" id="wiz-save-btn">Add Collection</button>
          </div>

        </div>
        <div class="conn-wizard-nav">
          <button class="wiz-nav-btn" id="wiz-cancel">Cancel</button>
          <button class="wiz-nav-btn" id="wiz-back" disabled>&larr; Back</button>
          <div class="wiz-dots" id="wiz-dots">
            ${Array.from({length: TOTAL_STEPS}, (_, i) => `<div class="wiz-dot${i === 0 ? ' active' : ''}"></div>`).join('')}
          </div>
          <button class="wiz-nav-btn primary" id="wiz-next">Next &rarr;</button>
        </div>
      </div>
    `;
    document.body.appendChild(wiz);

    const $viewport = wiz.querySelector('#wiz-viewport');
    const $steps = wiz.querySelectorAll('.conn-wizard-step');
    const $dots = wiz.querySelectorAll('.wiz-dot');
    const $back = wiz.querySelector('#wiz-back');
    const $next = wiz.querySelector('#wiz-next');

    const closeWiz = () => wiz.remove();

    // Cancel button + backdrop click to close
    wiz.querySelector('#wiz-cancel').addEventListener('click', closeWiz);
    wiz.addEventListener('click', (e) => {
      if (e.target === wiz) closeWiz();
    });

    function resizeViewport(stepIdx) {
      const step = $steps[stepIdx];
      step.style.position = 'relative';
      requestAnimationFrame(() => {
        $viewport.style.height = step.scrollHeight + 'px';
        setTimeout(() => { step.style.position = ''; }, 400);
      });
    }

    function goToStep(n) {
      if (n < 0 || n >= TOTAL_STEPS) return;
      $steps.forEach((s, i) => {
        s.classList.remove('active', 'left', 'right');
        if (i === n) s.classList.add('active');
        else if (i < n) s.classList.add('left');
        else s.classList.add('right');
      });
      $dots.forEach((d, i) => {
        d.classList.remove('active', 'done');
        if (i === n) d.classList.add('active');
        else if (i < n) d.classList.add('done');
      });
      currentStep = n;
      $back.disabled = n === 0;
      updateNextBtn();
      resizeViewport(n);
    }

    function updateNextBtn() {
      if (currentStep === 0) {
        $next.disabled = !wizState.mode;
        $next.textContent = 'Next \u2192';
      } else if (currentStep === 1) {
        $next.disabled = false;
        $next.textContent = 'Next \u2192';
      } else if (currentStep === 2) {
        $next.disabled = !wizState.collectionCreated;
        $next.textContent = 'Next \u2192';
      } else if (currentStep === 3) {
        $next.style.display = 'none';
      }
      if (currentStep < 3) $next.style.display = '';
    }

    const collectionRe = /^[a-z][a-z0-9_]{2,49}$/;

    function clearErrors() {
      wiz.querySelectorAll('.wiz-error').forEach(e => { e.textContent = ''; e.classList.remove('visible'); });
    }
    function showError(id, msg) {
      const el = wiz.querySelector('#' + id);
      if (el) { el.textContent = msg; el.classList.add('visible'); }
    }

    function validateStep1() {
      clearErrors();
      let valid = true;
      if (wizState.mode === 'docker') {
        const label = wiz.querySelector('#wiz-d-label').value.trim();
        const collection = wiz.querySelector('#wiz-d-collection').value.trim();
        const key = wiz.querySelector('#wiz-d-key').value.trim();
        const port = parseInt(wiz.querySelector('#wiz-d-port').value, 10);
        const grpc = parseInt(wiz.querySelector('#wiz-d-grpc').value, 10);
        if (!label) { showError('wiz-d-label-err', 'Label is required'); valid = false; }
        if (!collectionRe.test(collection)) { showError('wiz-d-collection-err', 'Must be 3-50 chars: lowercase, digits, underscores'); valid = false; }
        if (key.length < 8) { showError('wiz-d-key-err', 'Minimum 8 characters'); valid = false; }
        if (port < 1024 || port > 65535) { valid = false; }
        if (grpc < 1024 || grpc > 65535 || grpc === port) { valid = false; }
        if (valid) {
          wizState.label = label;
          wizState.collection = collection;
          wizState.apiKey = key;
          wizState.port = port;
          wizState.grpcPort = grpc;
          wizState.containerName = toDockerName(label);
          wizState.volumeName = toDockerName(label) + '-data';
          wizState.url = 'http://localhost:' + port;
        }
      } else {
        const label = wiz.querySelector('#wiz-e-label').value.trim();
        const url = wiz.querySelector('#wiz-e-url').value.trim();
        const key = wiz.querySelector('#wiz-e-key').value.trim();
        const collection = wiz.querySelector('#wiz-e-collection').value.trim();
        if (!label) { showError('wiz-e-label-err', 'Label is required'); valid = false; }
        if (!url.startsWith('http://') && !url.startsWith('https://')) { showError('wiz-e-url-err', 'Must start with http:// or https://'); valid = false; }
        if (!key) { showError('wiz-e-key-err', 'API Key is required'); valid = false; }
        if (!collectionRe.test(collection)) { showError('wiz-e-collection-err', 'Must be 3-50 chars: lowercase, digits, underscores'); valid = false; }
        if (valid) {
          wizState.label = label;
          wizState.url = url.replace(/\/+$/, '');
          wizState.apiKey = key;
          wizState.collection = collection;
        }
      }
      return valid;
    }

    // Step 0: Mode selection
    wiz.querySelectorAll('.wiz-mode-card').forEach(card => {
      card.addEventListener('click', () => {
        wiz.querySelectorAll('.wiz-mode-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        wizState.mode = card.dataset.mode;
        updateNextBtn();
      });
    });

    // Step 1: Show correct config panel
    function showConfigPanel() {
      const isDocker = wizState.mode === 'docker';
      wiz.querySelector('#wiz-config-docker').style.display = isDocker ? '' : 'none';
      wiz.querySelector('#wiz-config-existing').style.display = isDocker ? 'none' : '';
      wiz.querySelector('#wiz-action-docker').style.display = isDocker ? '' : 'none';
      wiz.querySelector('#wiz-action-existing').style.display = isDocker ? 'none' : '';
    }

    wiz.querySelector('#wiz-d-gen').addEventListener('click', () => {
      wiz.querySelector('#wiz-d-key').value = generateApiKey();
    });

    wiz.querySelector('#wiz-d-port').addEventListener('input', (e) => {
      const p = parseInt(e.target.value, 10);
      if (!isNaN(p)) wiz.querySelector('#wiz-d-grpc').value = p + 1;
    });

    // Step 2: Docker action
    wiz.querySelector('#wiz-docker-btn').addEventListener('click', async () => {
      const btn = wiz.querySelector('#wiz-docker-btn');
      const term = wiz.querySelector('#wiz-docker-term');
      const statusEl = wiz.querySelector('#wiz-docker-status');
      const dot = wiz.querySelector('#wiz-docker-dot');
      const statusText = wiz.querySelector('#wiz-docker-status-text');

      btn.disabled = true;
      btn.textContent = 'Starting...';
      statusEl.style.display = 'flex';
      dot.className = 'wiz-status-dot spin';
      statusText.textContent = 'Starting container...';
      term.textContent = 'Running docker run...\n';

      try {
        const dockerRes = await fetch('/api/connections/docker-new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            port: wizState.port, grpcPort: wizState.grpcPort,
            apiKey: wizState.apiKey, containerName: wizState.containerName,
            volumeName: wizState.volumeName,
          }),
        });
        const dockerData = await dockerRes.json();
        if (!dockerRes.ok) throw new Error(dockerData.error || 'Failed to start container');
        term.textContent += (dockerData.output || 'Container started.') + '\n';

        if (!dockerData.ready) throw new Error('Container started but Qdrant is not responding. Check Docker logs.');

        statusText.textContent = 'Container ready. Creating collection...';
        term.textContent += 'Qdrant is ready on port ' + wizState.port + '\n';

        const colRes = await fetch('/api/connections/create-collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: wizState.url, apiKey: wizState.apiKey, collection: wizState.collection }),
        });
        const colData = await colRes.json();
        if (!colRes.ok) throw new Error(colData.error || 'Failed to create collection');

        term.textContent += colData.message + '\n';
        dot.className = 'wiz-status-dot green';
        statusText.textContent = 'Collection ready!';
        btn.textContent = 'Done';
        wizState.dockerReady = true;
        wizState.collectionCreated = true;
        updateNextBtn();
      } catch (err) {
        dot.className = 'wiz-status-dot red';
        statusText.textContent = err.message;
        term.textContent += 'ERROR: ' + err.message + '\n';
        btn.textContent = 'Retry';
        btn.disabled = false;
      }
    });

    // Step 2: Existing action
    wiz.querySelector('#wiz-existing-btn').addEventListener('click', async () => {
      const btn = wiz.querySelector('#wiz-existing-btn');
      const statusEl = wiz.querySelector('#wiz-existing-status');
      const dot = wiz.querySelector('#wiz-existing-dot');
      const statusText = wiz.querySelector('#wiz-existing-status-text');

      btn.disabled = true;
      btn.textContent = 'Creating...';
      statusEl.style.display = 'flex';
      dot.className = 'wiz-status-dot spin';
      statusText.textContent = 'Testing connection & creating collection...';

      try {
        const res = await fetch('/api/connections/create-collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: wizState.url, apiKey: wizState.apiKey, collection: wizState.collection }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create collection');

        dot.className = 'wiz-status-dot green';
        statusText.textContent = data.existed ? 'Collection already exists \u2014 ready!' : 'Collection created!';
        btn.textContent = 'Done';
        wizState.collectionCreated = true;
        updateNextBtn();
      } catch (err) {
        dot.className = 'wiz-status-dot red';
        statusText.textContent = err.message;
        btn.textContent = 'Retry';
        btn.disabled = false;
      }
    });

    // Step 3: Summary & Save
    function buildSummary() {
      const summary = wiz.querySelector('#wiz-summary');
      summary.innerHTML = `
        <div class="wiz-summary-row"><span class="wsr-label">Label</span><span class="wsr-value">${wizState.label}</span></div>
        <div class="wiz-summary-row"><span class="wsr-label">URL</span><span class="wsr-value">${wizState.url}</span></div>
        <div class="wiz-summary-row"><span class="wsr-label">Collection</span><span class="wsr-value">${wizState.collection}</span></div>
        <div class="wiz-summary-row"><span class="wsr-label">Mode</span><span class="wsr-value">${wizState.mode === 'docker' ? 'New Docker Container' : 'Existing Instance'}</span></div>
      `;
    }

    wiz.querySelector('#wiz-save-btn').addEventListener('click', async () => {
      const btn = wiz.querySelector('#wiz-save-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      const id = wizState.label.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

      try {
        const res = await fetch('/api/connections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id, label: wizState.label, url: wizState.url,
            apiKey: wizState.apiKey, collection: wizState.collection,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save connection');

        // Refresh connections list in-place
        try {
          const connRes = await fetch('/api/connections');
          const connData = await connRes.json();
          if (connData.connections) {
            const list = overlay.querySelector('#conn-list');
            const allConns = connData.connections;
            if (allConns.length === 0) {
              list.innerHTML = '<div class="conn-empty">No connections configured</div>';
            } else {
              list.innerHTML = allConns.map(c => `
                <div class="conn-item${c.active ? ' active' : ''}${!c.reachable ? ' unreachable' : ''}" data-conn-id="${c.id}">
                  <div class="conn-item-dot"></div>
                  <div class="conn-item-info">
                    <div class="conn-item-name">${c.label || c.collection}</div>
                    <div class="conn-item-meta">${c.collection}</div>
                  </div>
                  ${c.reachable ? `<span class="conn-item-count">${c.points} pts</span>` : ''}
                  ${!c.reachable && /localhost|127\\.0\\.0\\.1/.test(c.url) ? `
                    <button class="conn-item-start" data-conn-id="${c.id}" data-tooltip="Start Container">
                      <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    </button>
                  ` : ''}
                  ${c.reachable ? `
                    <button class="conn-item-action conn-item-backup" data-conn-id="${c.id}" data-tooltip="Backup">
                      <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    </button>
                    <button class="conn-item-action conn-item-restore" data-conn-id="${c.id}" data-tooltip="Restore">
                      <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    </button>
                  ` : ''}
                  <button class="conn-item-delete" data-conn-id="${c.id}" data-conn-label="${c.label || c.collection}" data-tooltip="Remove">
                    <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              `).join('');
            }
          }
        } catch {}

        closeWiz();
      } catch (err) {
        btn.textContent = 'Add Collection';
        btn.disabled = false;
        alert(err.message);
      }
    });

    // Navigation
    $next.addEventListener('click', () => {
      if (currentStep === 0) {
        showConfigPanel();
        goToStep(1);
      } else if (currentStep === 1) {
        if (validateStep1()) {
          wizState.dockerReady = false;
          wizState.collectionCreated = false;
          goToStep(2);
        }
      } else if (currentStep === 2) {
        buildSummary();
        goToStep(3);
      }
    });

    $back.addEventListener('click', () => {
      if (currentStep > 0) goToStep(currentStep - 1);
    });

    resizeViewport(0);
  });

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

  // Expose sync functions for inline onclick attributes (if any remain)
  window.checkSyncStatus = checkSyncStatus;
  window.copySyncPrompt = copySyncPrompt;
}
