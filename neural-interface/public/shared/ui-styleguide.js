// ═══════════════════════════════════════════
// SynaBun Neural Interface — Style Guide
// Per-project visual identity editor.
// Writes DESIGN.md to the project root on every change.
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { storage } from './storage.js';
import { isGuest, hasPermission, showGuestToast } from './ui-sync.js';
import {
  fetchProjects, fetchStyleGuide, saveStyleGuide,
  uploadStyleGuideLogo, deleteStyleGuideLogo, styleGuideAssetUrl,
} from './api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const STORAGE_KEY_PROJECT = 'styleguide.lastProject';
const SAVE_DEBOUNCE_MS = 800;
const TABS = [
  { id: 'colors',     label: 'Colors' },
  { id: 'typography', label: 'Typography' },
  { id: 'shape',      label: 'Shape & Spacing' },
  { id: 'logo',       label: 'Logo & Imagery' },
];

let _panel = null;
let _backdrop = null;
let _projects = [];
let _projectPath = null;
let _config = null;
let _assetsHash = null;
let _activeTab = 'colors';
let _saveTimer = null;
let _saving = false;
let _loadSeq = 0;
let _googleFontsLoaded = new Set();

export function initStyleGuide() {
  on('styleguide:open', () => openPanel());
}

async function openPanel() {
  if (isGuest() && !hasPermission('styleGuide')) {
    showGuestToast('Style Guide is disabled by the host');
    return;
  }
  if (_panel) { _panel.focus(); return; }

  _backdrop = document.createElement('div');
  _backdrop.className = 'studio-backdrop';
  document.body.appendChild(_backdrop);

  _panel = document.createElement('div');
  _panel.className = 'styleguide-panel glass resizable';
  _panel.id = 'styleguide-panel';
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);

  _panel.style.left = Math.max(20, (window.innerWidth - 1000) / 2) + 'px';
  _panel.style.top = Math.max(48, (window.innerHeight - 600) / 2) + 'px';

  wirePanel();
  await loadProjects();

  requestAnimationFrame(() => { _backdrop.classList.add('open'); _panel.classList.add('open'); });
}

function closePanel() {
  if (!_panel) return;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; flushSave(); }
  if (_backdrop) { _backdrop.remove(); _backdrop = null; }
  _panel.remove();
  _panel = null;
  _config = null;
  _projectPath = null;
  _assetsHash = null;
  _activeTab = 'colors';
}

function buildPanelHTML() {
  return `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>

    <div class="sg-header drag-handle" data-drag="styleguide-panel">
      <div class="sg-header-left">
        <h3>Style Guide</h3>
        <select class="sg-project-select" id="sg-project-select" title="Active project"></select>
      </div>
      <div class="sg-header-right">
        <span class="sg-status" id="sg-status" data-state="idle">Ready</span>
        <button class="sg-close" id="sg-close" title="Close">&times;</button>
      </div>
    </div>

    <div class="sg-tabs" id="sg-tabs">
      ${TABS.map(t => `<button class="sg-tab${t.id === _activeTab ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>

    <div class="sg-body" id="sg-body">
      <div class="sg-empty">Select a project to begin.</div>
    </div>
  `;
}

function wirePanel() {
  $('sg-close')?.addEventListener('click', closePanel);
  $('sg-project-select')?.addEventListener('change', (e) => onProjectChange(e.target.value));

  _panel.querySelectorAll('.sg-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      _panel.querySelectorAll('.sg-tab').forEach(b => b.classList.toggle('active', b === btn));
      renderBody();
    });
  });

  const onEsc = (e) => {
    if (e.key === 'Escape' && _panel) {
      closePanel();
      document.removeEventListener('keydown', onEsc);
    }
  };
  document.addEventListener('keydown', onEsc);
}

async function loadProjects() {
  try {
    const data = await fetchProjects();
    _projects = data.projects || [];
    const select = $('sg-project-select');
    if (!select) return;
    select.innerHTML = _projects.length === 0
      ? `<option value="">(no projects)</option>`
      : _projects.map(p => `<option value="${esc(p.path)}">${esc(p.label)}</option>`).join('');

    const last = storage.getItem(STORAGE_KEY_PROJECT);
    const initial = (last && _projects.some(p => p.path === last)) ? last : _projects[0]?.path;
    if (initial) {
      select.value = initial;
      await onProjectChange(initial);
    }
  } catch (err) {
    console.error('[styleguide] load projects failed', err);
    setStatus('error', 'Failed to load projects');
  }
}

async function onProjectChange(path) {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; await flushSave(); }
  _projectPath = path;
  if (path) storage.setItem(STORAGE_KEY_PROJECT, path);
  const seq = ++_loadSeq;
  setStatus('loading', 'Loading…');
  try {
    const data = await fetchStyleGuide(path);
    if (seq !== _loadSeq) return;
    _config = data.config;
    _assetsHash = data.assetsHash;
    setStatus('idle', data.hasDesignFile ? 'Loaded · DESIGN.md exists' : 'Loaded · DESIGN.md not yet written');
    renderBody();
  } catch (err) {
    if (seq !== _loadSeq) return;
    console.error('[styleguide] load failed', err);
    setStatus('error', err.message || 'Load failed');
  }
}

function setStatus(state, text) {
  const el = $('sg-status');
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}

function scheduleSave() {
  if (!_projectPath || !_config) return;
  setStatus('dirty', 'Saving…');
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

async function flushSave() {
  if (!_projectPath || !_config || _saving) return;
  _saving = true;
  _saveTimer = null;
  try {
    const data = await saveStyleGuide(_projectPath, _config);
    _config = data.config;
    _assetsHash = data.assetsHash;
    setStatus('saved', 'Saved · DESIGN.md updated');
  } catch (err) {
    console.error('[styleguide] save failed', err);
    setStatus('error', err.message || 'Save failed');
  } finally {
    _saving = false;
  }
}

// ── Body rendering dispatch ──
function renderBody() {
  const body = $('sg-body');
  if (!body) return;
  if (!_config) {
    body.innerHTML = `<div class="sg-empty">Select a project to begin.</div>`;
    return;
  }
  switch (_activeTab) {
    case 'colors':     renderColors(body); break;
    case 'typography': renderTypography(body); break;
    case 'shape':      renderShape(body); break;
    case 'logo':       renderLogo(body); break;
  }
}

// ═══════════════════════════════════════════
// COLORS TAB
// ═══════════════════════════════════════════

const COLOR_ROLES = [
  { key: 'primary',   label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'accent',    label: 'Accent' },
  { key: 'neutral',   label: 'Neutral' },
];
const SHADE_KEYS = ['50', '100', '300', '500', '900'];

function renderColors(body) {
  const c = _config.colors = _config.colors || {};
  const cols = COLOR_ROLES.map(role => {
    const shades = c[role.key] || {};
    const swatches = SHADE_KEYS.map(s => {
      const hex = shades[s] || '#888888';
      return `
        <div class="sg-swatch-row">
          <span class="sg-swatch-shade">${s}</span>
          <input type="color" class="sg-swatch-color" data-role="${role.key}" data-shade="${s}" value="${esc(hex)}">
          <input type="text" class="sg-swatch-hex" data-role="${role.key}" data-shade="${s}" value="${esc(hex)}" maxlength="7">
        </div>`;
    }).join('');
    const base = shades['500'] || '#3b82f6';
    return `
      <div class="sg-color-col">
        <div class="sg-color-header">
          <span class="sg-swatch-big" style="background:${esc(base)}"></span>
          <h4>${role.label}</h4>
          <button class="sg-mini-btn" data-action="autoshade" data-role="${role.key}" title="Auto-generate shade scale from 500">Auto</button>
        </div>
        ${swatches}
      </div>`;
  }).join('');

  const status = c.status || {};
  const statusRows = ['success', 'warning', 'danger', 'info'].map(k => {
    const hex = status[k] || '#888888';
    return `
      <div class="sg-status-row">
        <input type="color" class="sg-status-color" data-key="${k}" value="${esc(hex)}">
        <input type="text" class="sg-status-hex" data-key="${k}" value="${esc(hex)}" maxlength="7">
        <span class="sg-status-label">${k}</span>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="sg-section">
      <div class="sg-color-grid">${cols}</div>
    </div>
    <div class="sg-section">
      <h3 class="sg-section-title">Status colors</h3>
      <div class="sg-status-grid">${statusRows}</div>
    </div>
  `;

  // Wire swatch inputs
  body.querySelectorAll('.sg-swatch-color').forEach(input => {
    input.addEventListener('input', (e) => {
      const { role, shade } = e.target.dataset;
      const v = e.target.value;
      _config.colors[role] = _config.colors[role] || {};
      _config.colors[role][shade] = v;
      const hexInput = body.querySelector(`.sg-swatch-hex[data-role="${role}"][data-shade="${shade}"]`);
      if (hexInput) hexInput.value = v;
      if (shade === '500') {
        const big = e.target.closest('.sg-color-col')?.querySelector('.sg-swatch-big');
        if (big) big.style.background = v;
      }
      scheduleSave();
    });
  });
  body.querySelectorAll('.sg-swatch-hex').forEach(input => {
    input.addEventListener('change', (e) => {
      const { role, shade } = e.target.dataset;
      const v = normalizeHex(e.target.value);
      if (!v) { e.target.value = _config.colors[role]?.[shade] || '#888888'; return; }
      _config.colors[role] = _config.colors[role] || {};
      _config.colors[role][shade] = v;
      e.target.value = v;
      const color = body.querySelector(`.sg-swatch-color[data-role="${role}"][data-shade="${shade}"]`);
      if (color) color.value = v;
      scheduleSave();
    });
  });
  body.querySelectorAll('[data-action="autoshade"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const role = btn.dataset.role;
      const base = _config.colors[role]?.['500'] || '#3b82f6';
      _config.colors[role] = autoShadeScale(base);
      renderBody();
      scheduleSave();
    });
  });
  body.querySelectorAll('.sg-status-color').forEach(input => {
    input.addEventListener('input', (e) => {
      const k = e.target.dataset.key;
      _config.colors.status = _config.colors.status || {};
      _config.colors.status[k] = e.target.value;
      const hex = body.querySelector(`.sg-status-hex[data-key="${k}"]`);
      if (hex) hex.value = e.target.value;
      scheduleSave();
    });
  });
  body.querySelectorAll('.sg-status-hex').forEach(input => {
    input.addEventListener('change', (e) => {
      const k = e.target.dataset.key;
      const v = normalizeHex(e.target.value);
      if (!v) { e.target.value = _config.colors.status?.[k] || '#888888'; return; }
      _config.colors.status = _config.colors.status || {};
      _config.colors.status[k] = v;
      e.target.value = v;
      const color = body.querySelector(`.sg-status-color[data-key="${k}"]`);
      if (color) color.value = v;
      scheduleSave();
    });
  });
}

function normalizeHex(v) {
  v = String(v || '').trim();
  if (!v) return null;
  if (!v.startsWith('#')) v = '#' + v;
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) return null;
  return v.toLowerCase();
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

function mix(c1, c2, t) {
  return [
    c1[0] + (c2[0] - c1[0]) * t,
    c1[1] + (c2[1] - c1[1]) * t,
    c1[2] + (c2[2] - c1[2]) * t,
  ];
}

function autoShadeScale(base) {
  const rgb = hexToRgb(base);
  const white = [255, 255, 255];
  const black = [0, 0, 0];
  return {
    50:  rgbToHex(...mix(rgb, white, 0.90)),
    100: rgbToHex(...mix(rgb, white, 0.75)),
    300: rgbToHex(...mix(rgb, white, 0.40)),
    500: rgbToHex(...rgb),
    900: rgbToHex(...mix(rgb, black, 0.55)),
  };
}

// ═══════════════════════════════════════════
// TYPOGRAPHY TAB
// ═══════════════════════════════════════════

const FONT_OPTIONS = [
  'Inter', 'Space Grotesk', 'Roboto', 'Open Sans', 'Lato', 'Montserrat',
  'Poppins', 'Source Sans Pro', 'Nunito', 'Raleway', 'Work Sans', 'DM Sans',
  'Manrope', 'Plus Jakarta Sans', 'Outfit', 'IBM Plex Sans', 'Karla', 'Mulish',
  'Playfair Display', 'Merriweather', 'Lora', 'PT Serif', 'Source Serif Pro',
  'Cormorant', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'IBM Plex Mono',
];

function loadGoogleFont(family) {
  if (!family || _googleFontsLoaded.has(family)) return;
  _googleFontsLoaded.add(family);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@300;400;500;600;700;800&display=swap`;
  document.head.appendChild(link);
}

function renderTypography(body) {
  const t = _config.typography = _config.typography || {};
  t.heading = t.heading || { family: 'Space Grotesk', weights: [600], scale: { h1: 48, h2: 36, h3: 28, h4: 22 } };
  t.body = t.body || { family: 'Inter', weights: [400], size: 16, lineHeight: 1.5 };
  t.mono = t.mono || { family: 'JetBrains Mono', weights: [400] };

  loadGoogleFont(t.heading.family);
  loadGoogleFont(t.body.family);
  loadGoogleFont(t.mono.family);

  const fontDatalist = `<datalist id="sg-font-list">${FONT_OPTIONS.map(f => `<option value="${esc(f)}">`).join('')}</datalist>`;

  body.innerHTML = `
    ${fontDatalist}

    <div class="sg-section">
      <div class="sg-typo-grid">
        <div class="sg-typo-controls">
          <h3 class="sg-section-title">Heading</h3>
          <label class="sg-field"><span>Family</span>
            <input type="text" list="sg-font-list" id="sg-h-family" value="${esc(t.heading.family)}"></label>
          <label class="sg-field"><span>Weights (comma-separated)</span>
            <input type="text" id="sg-h-weights" value="${esc((t.heading.weights || []).join(','))}"></label>
          <div class="sg-scale-grid">
            ${['h1','h2','h3','h4'].map(k => `
              <label class="sg-field"><span>${k}</span>
                <input type="number" min="8" max="160" id="sg-h-${k}" value="${esc(t.heading.scale?.[k] ?? 16)}">
              </label>`).join('')}
          </div>
        </div>
        <div class="sg-typo-preview" id="sg-h-preview" style="font-family: '${esc(t.heading.family)}', sans-serif;">
          <div class="sg-preview-label">SPECIMEN</div>
          <div class="sg-preview-aa" style="font-size: ${t.heading.scale?.h1 || 48}px; font-weight: ${(t.heading.weights || [700])[0] || 700};">Aa</div>
          <div class="sg-preview-alpha" style="font-size: 18px; font-weight: ${(t.heading.weights || [600])[0] || 600};">abcdefghijklmnopqrstuvwxyz</div>
          <div class="sg-preview-num" style="font-size: 18px; font-weight: ${(t.heading.weights || [600])[0] || 600};">0 1 2 3 4 5 6 7 8 9</div>
        </div>
      </div>
    </div>

    <div class="sg-section">
      <div class="sg-typo-grid">
        <div class="sg-typo-controls">
          <h3 class="sg-section-title">Body</h3>
          <label class="sg-field"><span>Family</span>
            <input type="text" list="sg-font-list" id="sg-b-family" value="${esc(t.body.family)}"></label>
          <label class="sg-field"><span>Weights</span>
            <input type="text" id="sg-b-weights" value="${esc((t.body.weights || []).join(','))}"></label>
          <div class="sg-scale-grid">
            <label class="sg-field"><span>Size (px)</span>
              <input type="number" min="8" max="48" id="sg-b-size" value="${esc(t.body.size ?? 16)}"></label>
            <label class="sg-field"><span>Line-height</span>
              <input type="number" min="1" max="2.5" step="0.05" id="sg-b-lh" value="${esc(t.body.lineHeight ?? 1.5)}"></label>
          </div>
        </div>
        <div class="sg-typo-preview" style="font-family: '${esc(t.body.family)}', sans-serif;">
          <div class="sg-preview-label">BODY SPECIMEN</div>
          <p style="font-size: ${t.body.size || 16}px; line-height: ${t.body.lineHeight || 1.5}; margin: 0;">The quick brown fox jumps over the lazy dog. abcdefghijklmnopqrstuvwxyz 0123456789.</p>
        </div>
      </div>
    </div>

    <div class="sg-section">
      <div class="sg-typo-grid">
        <div class="sg-typo-controls">
          <h3 class="sg-section-title">Mono</h3>
          <label class="sg-field"><span>Family</span>
            <input type="text" list="sg-font-list" id="sg-m-family" value="${esc(t.mono.family)}"></label>
          <label class="sg-field"><span>Weights</span>
            <input type="text" id="sg-m-weights" value="${esc((t.mono.weights || []).join(','))}"></label>
        </div>
        <div class="sg-typo-preview" style="font-family: '${esc(t.mono.family)}', monospace;">
          <div class="sg-preview-label">MONO SPECIMEN</div>
          <pre style="margin: 0; font-size: 14px;">const greet = (name) =&gt; \`hello, \${name}\`;</pre>
        </div>
      </div>
    </div>
  `;

  // Heading
  bindText('sg-h-family', v => { t.heading.family = v; loadGoogleFont(v); renderBody(); });
  bindText('sg-h-weights', v => { t.heading.weights = parseWeights(v); });
  ['h1','h2','h3','h4'].forEach(k => {
    bindNumber(`sg-h-${k}`, v => {
      t.heading.scale = t.heading.scale || {};
      t.heading.scale[k] = v;
      if (k === 'h1') {
        const aa = body.querySelector('.sg-preview-aa');
        if (aa) aa.style.fontSize = v + 'px';
      }
    });
  });

  // Body
  bindText('sg-b-family', v => { t.body.family = v; loadGoogleFont(v); renderBody(); });
  bindText('sg-b-weights', v => { t.body.weights = parseWeights(v); });
  bindNumber('sg-b-size', v => { t.body.size = v; });
  bindNumber('sg-b-lh', v => { t.body.lineHeight = v; });

  // Mono
  bindText('sg-m-family', v => { t.mono.family = v; loadGoogleFont(v); renderBody(); });
  bindText('sg-m-weights', v => { t.mono.weights = parseWeights(v); });
}

function bindText(id, onValue) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', () => { onValue(el.value); scheduleSave(); });
}

function bindNumber(id, onValue) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', () => {
    const v = parseFloat(el.value);
    if (Number.isFinite(v)) { onValue(v); scheduleSave(); }
  });
}

function parseWeights(s) {
  return String(s || '').split(',').map(x => parseInt(x.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
}

// ═══════════════════════════════════════════
// SHAPE & SPACING TAB
// ═══════════════════════════════════════════

function renderShape(body) {
  const s = _config.shape = _config.shape || {};
  s.radius = s.radius || { pill: 20, button: 10, card: 8, small: 6 };
  s.spacing = Array.isArray(s.spacing) ? s.spacing : [4, 8, 12, 16, 24, 32, 48, 64];
  s.shadows = s.shadows || { sm: '0 1px 2px rgba(0,0,0,.06)', md: '0 4px 12px rgba(0,0,0,.1)', lg: '0 12px 32px rgba(0,0,0,.18)' };

  const radiusRows = Object.entries(s.radius).map(([k, v]) => `
    <div class="sg-radius-row">
      <span class="sg-radius-label">${esc(k)}</span>
      <input type="range" min="0" max="40" value="${esc(v)}" data-radius-key="${esc(k)}">
      <input type="number" min="0" max="60" value="${esc(v)}" data-radius-num="${esc(k)}">
      <span class="sg-radius-preview" style="border-radius: ${v}px"></span>
    </div>`).join('');

  const spacingChips = s.spacing.map((v, i) => `
    <span class="sg-spacing-chip">
      <input type="number" min="0" max="200" value="${esc(v)}" data-spacing-idx="${i}">
      <button class="sg-mini-btn" data-spacing-remove="${i}" title="Remove">×</button>
    </span>`).join('');

  const shadowRows = Object.entries(s.shadows).map(([k, v]) => `
    <div class="sg-shadow-row">
      <span class="sg-shadow-label">${esc(k)}</span>
      <input type="text" class="sg-shadow-input" data-shadow-key="${esc(k)}" value="${esc(v)}">
      <span class="sg-shadow-preview" style="box-shadow: ${esc(v)}"></span>
    </div>`).join('');

  body.innerHTML = `
    <div class="sg-section">
      <h3 class="sg-section-title">Border radii</h3>
      <div class="sg-radius-grid">${radiusRows}</div>
    </div>
    <div class="sg-section">
      <h3 class="sg-section-title">Spacing scale</h3>
      <div class="sg-spacing-row">
        ${spacingChips}
        <button class="sg-mini-btn" id="sg-spacing-add">+ Add</button>
      </div>
    </div>
    <div class="sg-section">
      <h3 class="sg-section-title">Shadows</h3>
      <div class="sg-shadow-grid">${shadowRows}</div>
    </div>
  `;

  // Radii
  body.querySelectorAll('[data-radius-key]').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const k = e.target.dataset.radiusKey;
      const v = parseInt(e.target.value, 10);
      s.radius[k] = v;
      const num = body.querySelector(`[data-radius-num="${k}"]`);
      if (num) num.value = v;
      const preview = e.target.closest('.sg-radius-row')?.querySelector('.sg-radius-preview');
      if (preview) preview.style.borderRadius = v + 'px';
      scheduleSave();
    });
  });
  body.querySelectorAll('[data-radius-num]').forEach(num => {
    num.addEventListener('change', (e) => {
      const k = e.target.dataset.radiusNum;
      const v = Math.max(0, parseInt(e.target.value, 10) || 0);
      s.radius[k] = v;
      const slider = body.querySelector(`[data-radius-key="${k}"]`);
      if (slider) slider.value = Math.min(40, v);
      const preview = e.target.closest('.sg-radius-row')?.querySelector('.sg-radius-preview');
      if (preview) preview.style.borderRadius = v + 'px';
      scheduleSave();
    });
  });

  // Spacing
  body.querySelectorAll('[data-spacing-idx]').forEach(input => {
    input.addEventListener('change', (e) => {
      const i = parseInt(e.target.dataset.spacingIdx, 10);
      const v = Math.max(0, parseInt(e.target.value, 10) || 0);
      s.spacing[i] = v;
      scheduleSave();
    });
  });
  body.querySelectorAll('[data-spacing-remove]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const i = parseInt(e.target.dataset.spacingRemove, 10);
      s.spacing.splice(i, 1);
      renderBody();
      scheduleSave();
    });
  });
  $('sg-spacing-add')?.addEventListener('click', () => {
    s.spacing.push((s.spacing[s.spacing.length - 1] || 4) * 2);
    renderBody();
    scheduleSave();
  });

  // Shadows
  body.querySelectorAll('[data-shadow-key]').forEach(input => {
    input.addEventListener('change', (e) => {
      const k = e.target.dataset.shadowKey;
      s.shadows[k] = e.target.value;
      const preview = e.target.closest('.sg-shadow-row')?.querySelector('.sg-shadow-preview');
      if (preview) preview.style.boxShadow = e.target.value;
      scheduleSave();
    });
  });
}

// ═══════════════════════════════════════════
// LOGO & IMAGERY TAB
// ═══════════════════════════════════════════

const ICON_LIBRARIES = ['lucide', 'heroicons', 'feather', 'material-symbols', 'phosphor', 'tabler', 'fontawesome', 'remix'];

function renderLogo(body) {
  const l = _config.logo = _config.logo || { variants: [], iconLibrary: 'lucide', imageryNotes: '' };
  if (!Array.isArray(l.variants)) l.variants = [];

  const bgOptions = [
    { id: 'primary', label: 'Primary', bg: _config.colors?.primary?.['500'] || '#3b82f6' },
    { id: 'white',   label: 'Light',   bg: '#ffffff' },
    { id: 'dark',    label: 'Dark',    bg: '#0f172a' },
  ];

  const variantTiles = l.variants.length === 0
    ? `<div class="sg-empty-small">No logo variants yet — drag or upload an SVG/PNG to add one.</div>`
    : l.variants.map(v => {
      const bgInfo = bgOptions.find(b => b.id === v.bg) || bgOptions[0];
      const url = v.file && _assetsHash ? styleGuideAssetUrl(_assetsHash, v.file) : '';
      return `
        <div class="sg-logo-tile" data-variant="${esc(v.id)}">
          <div class="sg-logo-preview" style="background:${esc(bgInfo.bg)}">
            ${url ? `<img src="${esc(url)}" alt="${esc(v.name)}">` : `<span class="sg-logo-placeholder">No file</span>`}
          </div>
          <input type="text" class="sg-logo-name" data-variant="${esc(v.id)}" value="${esc(v.name || 'Variant')}" placeholder="Variant name">
          <div class="sg-logo-bg-row">
            ${bgOptions.map(b => `
              <button class="sg-logo-bg${b.id === v.bg ? ' active' : ''}" data-variant="${esc(v.id)}" data-bg="${b.id}" style="background:${esc(b.bg)}" title="${esc(b.label)}"></button>
            `).join('')}
          </div>
          <button class="sg-mini-btn sg-logo-remove" data-variant="${esc(v.id)}">Remove</button>
        </div>`;
    }).join('');

  body.innerHTML = `
    <div class="sg-section">
      <h3 class="sg-section-title">Logo variations</h3>
      <div class="sg-logo-grid">
        ${variantTiles}
      </div>
      <div class="sg-logo-actions">
        <label class="sg-mini-btn sg-upload-btn">
          + Upload variant
          <input type="file" id="sg-logo-upload" accept="image/svg+xml,image/png,image/jpeg,image/webp" hidden>
        </label>
        <span class="sg-hint">Max 4MB — SVG, PNG, JPG or WebP.</span>
      </div>
    </div>

    <div class="sg-section">
      <h3 class="sg-section-title">Icon library</h3>
      <select id="sg-icon-lib" class="sg-select">
        ${ICON_LIBRARIES.map(lib => `<option value="${esc(lib)}"${lib === l.iconLibrary ? ' selected' : ''}>${esc(lib)}</option>`).join('')}
      </select>
    </div>

    <div class="sg-section">
      <h3 class="sg-section-title">Imagery direction</h3>
      <textarea id="sg-imagery" class="sg-textarea" placeholder="Notes about imagery style, mood, photography vs illustration, do/don't, etc.">${esc(l.imageryNotes || '')}</textarea>
    </div>
  `;

  $('sg-logo-upload')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('dirty', 'Uploading logo…');
    try {
      const res = await uploadStyleGuideLogo(_projectPath, file, { name: file.name.replace(/\.[^.]+$/, '') });
      _config = res.config;
      renderBody();
      setStatus('saved', 'Logo uploaded · DESIGN.md updated');
    } catch (err) {
      console.error('[styleguide] logo upload failed', err);
      setStatus('error', err.message || 'Upload failed');
    } finally {
      e.target.value = '';
    }
  });

  body.querySelectorAll('.sg-logo-name').forEach(input => {
    input.addEventListener('change', (e) => {
      const id = e.target.dataset.variant;
      const v = l.variants.find(x => x.id === id);
      if (v) { v.name = e.target.value; scheduleSave(); }
    });
  });

  body.querySelectorAll('.sg-logo-bg').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.dataset.variant;
      const bg = e.target.dataset.bg;
      const v = l.variants.find(x => x.id === id);
      if (v) { v.bg = bg; renderBody(); scheduleSave(); }
    });
  });

  body.querySelectorAll('.sg-logo-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.variant;
      if (!confirm('Remove this logo variant?')) return;
      setStatus('dirty', 'Removing…');
      try {
        const res = await deleteStyleGuideLogo(_projectPath, id);
        _config = res.config;
        renderBody();
        setStatus('saved', 'Variant removed · DESIGN.md updated');
      } catch (err) {
        console.error('[styleguide] logo delete failed', err);
        setStatus('error', err.message || 'Delete failed');
      }
    });
  });

  $('sg-icon-lib')?.addEventListener('change', (e) => {
    l.iconLibrary = e.target.value;
    scheduleSave();
  });

  $('sg-imagery')?.addEventListener('input', (e) => {
    l.imageryNotes = e.target.value;
    scheduleSave();
  });
}
