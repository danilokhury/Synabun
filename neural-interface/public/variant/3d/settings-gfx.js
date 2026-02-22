// ═══════════════════════════════════════════
// SynaBun Neural Interface — 3D Graphics Settings Tab
// Self-registering settings tab for quality presets,
// floor styles, and fine-tuning controls
// ═══════════════════════════════════════════

import { registerSettingsTab } from '../../shared/registry.js';
import { state, emit, on } from '../../shared/state.js';
import {
  gfx,
  GFX_DEFAULTS,
  GFX_PRESETS,
  saveGfxConfig,
  applyGfxPreset,
  getActivePreset,
} from './gfx.js';


// ── Lazy bindings for functions still in the monolith ──
let _applyBgTheme   = null;
let _applyFloorStyle = null;
let _getGraph        = null;

export function setGraphicsHooks(hooks) {
  if (hooks.applyBgTheme)   _applyBgTheme   = hooks.applyBgTheme;
  if (hooks.applyFloorStyle) _applyFloorStyle = hooks.applyFloorStyle;
  if (hooks.getGraph)        _getGraph        = hooks.getGraph;
}


// ── Helper: range slider row ──

function rangeRow(key, label, min, max, step) {
  const val = gfx[key];
  const decimals = step < 1 ? 2 : 0;
  return `<div class="gfx-row">
    <span class="gfx-label">${label}</span>
    <input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${val}">
    <span class="gfx-val" data-val="${key}">${Number(val).toFixed(decimals)}</span>
  </div>`;
}


// ═══════════════════════════════════════════
// BUILD — returns the HTML string for the Graphics tab body
// ═══════════════════════════════════════════

function buildGraphicsTab() {
  // ── Quality preset cards ──
  const presetCards = Object.entries(GFX_PRESETS).map(([key, p]) => `
    <div class="gfx-preset-card${getActivePreset() === key ? ' active' : ''}" data-preset="${key}">
      <span class="gfx-preset-name">${p.label}</span>
      <span class="gfx-preset-desc">${p.desc}</span>
    </div>
  `).join('');

  // ── Floor style cards ──
  const floorStyles = [
    { key: 'grid',    name: 'Grid',       desc: 'Soft glowing lines' },
    { key: 'dots',    name: 'Dot Field',  desc: 'Proximity glow dots' },
    { key: 'hex',     name: 'Hex Grid',   desc: 'Hexagonal cells' },
    { key: 'ripples', name: 'Ripples',    desc: 'Concentric waves' },
    { key: 'fog',     name: 'Ground Fog', desc: 'Drifting mist' },
    { key: 'none',    name: 'None',       desc: 'No floor effect' },
  ];
  const floorCards = floorStyles.map(f => `
    <div class="gfx-preset-card floor-card${gfx.floorStyle === f.key ? ' active' : ''}" data-floor-style="${f.key}">
      <span class="gfx-preset-name">${f.name}</span>
      <span class="gfx-preset-desc">${f.desc}</span>
    </div>
  `).join('');

  return `
    <div class="gfx-presets" id="gfx-preset-cards" style="margin-bottom:14px">
      ${presetCards}
    </div>

    <div class="iface-section">
      <div class="gfx-group-title">Floor Effect</div>
      <div class="gfx-presets gfx-floor-grid" id="gfx-floor-cards">
        ${floorCards}
      </div>
    </div>

    <div class="iface-section">
      <div class="gfx-group-title">Links</div>
      ${rangeRow('linkOpacity', 'Opacity', 0, 0.5, 0.01)}
    </div>

    <div class="iface-grid">
      <div class="iface-section">
        <div class="gfx-group-title">Camera</div>
        ${rangeRow('clickZoom', 'Click Zoom', 40, 300, 10)}
        ${rangeRow('gentleZoom', 'Gentle Zoom', 80, 400, 10)}
      </div>
      <div class="iface-section">
        <div class="gfx-group-title">Background</div>
        ${rangeRow('bgIntensity', 'Particle Glow', 0, 2, 0.05)}
        ${rangeRow('bgParticleCount', 'Particle Count', 500, 5000, 100)}
      </div>
    </div>

    <div class="iface-reset-wrap">
      <button class="gfx-reset-btn" id="gfx-reset">Reset All to Defaults</button>
    </div>
  `;
}


// ═══════════════════════════════════════════
// INIT — wire up event handlers after HTML is injected
// ═══════════════════════════════════════════

function initGraphicsTab(container) {
  // ── Preset card clicks ──
  container.querySelectorAll('.gfx-preset-card[data-preset]').forEach(card => {
    card.addEventListener('click', () => {
      const g = _getGraph ? _getGraph() : null;
      applyGfxPreset(card.dataset.preset, gfx, g, _applyBgTheme);

      container.querySelectorAll('.gfx-preset-card[data-preset]').forEach(c => {
        c.classList.toggle('active', c.dataset.preset === card.dataset.preset);
      });
      container.querySelectorAll('.floor-card[data-floor-style]').forEach(c => {
        c.classList.toggle('active', c.dataset.floorStyle === gfx.floorStyle);
      });

      // Sync slider values
      container.querySelectorAll('input[type="range"][data-key]').forEach(input => {
        const key = input.dataset.key;
        if (gfx[key] !== undefined) {
          input.value = gfx[key];
          const step = parseFloat(input.step);
          const valSpan = container.querySelector(`[data-val="${key}"]`);
          if (valSpan) valSpan.textContent = Number(gfx[key]).toFixed(step < 1 ? 2 : 0);
        }
      });
    });
  });

  // ── Floor style card clicks ──
  container.querySelectorAll('.floor-card[data-floor-style]').forEach(card => {
    card.addEventListener('click', () => {
      const style = card.dataset.floorStyle;
      gfx.floorStyle = style;
      saveGfxConfig(gfx);

      container.querySelectorAll('.floor-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      if (_applyFloorStyle) _applyFloorStyle(style);
    });
  });

  // ── Live range slider updates ──
  container.querySelectorAll('input[type="range"][data-key]').forEach(input => {
    input.addEventListener('input', () => {
      const key = input.dataset.key;
      const val = parseFloat(input.value);
      gfx[key] = val;

      const step = parseFloat(input.step);
      const valSpan = container.querySelector(`[data-val="${key}"]`);
      if (valSpan) valSpan.textContent = val.toFixed(step < 1 ? 2 : 0);

      saveGfxConfig(gfx);

      // Clear preset selection when manually tweaking
      localStorage.removeItem('neural-gfx-preset');
      container.querySelectorAll('.gfx-preset-card[data-preset]').forEach(c => c.classList.remove('active'));

      // Live-apply visual changes
      if (key === 'bgParticleCount' && _applyBgTheme) {
        _applyBgTheme(gfx.bgTheme || 'deep-grid');
      }
    });
  });

  // ── Reset to defaults ──
  const resetBtn = container.querySelector('#gfx-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      Object.assign(gfx, GFX_DEFAULTS);
      localStorage.removeItem('neural-gfx-config');
      localStorage.removeItem('neural-gfx-preset');

      container.querySelectorAll('input[type="range"][data-key]').forEach(input => {
        const key = input.dataset.key;
        if (GFX_DEFAULTS[key] == null) return;
        input.value = GFX_DEFAULTS[key];
        const step = parseFloat(input.step);
        const valSpan = container.querySelector(`[data-val="${key}"]`);
        if (valSpan) valSpan.textContent = Number(GFX_DEFAULTS[key]).toFixed(step < 1 ? 2 : 0);
      });

      container.querySelectorAll('.gfx-preset-card[data-preset]').forEach(c => c.classList.remove('active'));
      container.querySelectorAll('.floor-card[data-floor-style]').forEach(c => {
        c.classList.toggle('active', c.dataset.floorStyle === GFX_DEFAULTS.floorStyle);
      });

      const g = _getGraph ? _getGraph() : null;
      if (g) {
        if (_applyBgTheme) _applyBgTheme(GFX_DEFAULTS.bgTheme || 'deep-grid');
        if (_applyFloorStyle) _applyFloorStyle(GFX_DEFAULTS.floorStyle || 'grid');
      }
    });
  }
}


// ═══════════════════════════════════════════
// SELF-REGISTER — side effect on import
// ═══════════════════════════════════════════

registerSettingsTab({
  id: 'graphics',
  label: 'Graphics',
  icon: '🎨',
  order: 70,
  build: buildGraphicsTab,
  afterRender: initGraphicsTab,
});
