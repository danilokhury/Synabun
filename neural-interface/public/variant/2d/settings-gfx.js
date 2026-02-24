// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Graphics Settings Tab
// Self-registers a "Graphics" tab in the settings panel
// via the shared registry. No explicit exports — side-effect module.
// ═══════════════════════════════════════════

import { registerSettingsTab } from '../../shared/registry.js';
import { gfx, saveGfxConfig } from './gfx.js';
import { emit } from '../../shared/state.js';

// ═══════════════════════════════════════════
// SLIDER DEFINITIONS
// ═══════════════════════════════════════════

const SLIDERS = [
  { key: 'parentOrbitRadius', label: 'Parent Orbit Radius',   min: 300, max: 1200, step: 50,   format: v => String(v) },
  { key: 'childOrbitGap',     label: 'Child Orbit Gap',       min: 100, max: 500,  step: 25,   format: v => String(v) },
  { key: 'cardGap',           label: 'Card Spacing',          min: 5,   max: 40,   step: 5,    format: v => String(v) },
  { key: 'cardOpacity',       label: 'Card Opacity',          min: 0.3, max: 1,    step: 0.05, format: v => v.toFixed(2) },
  { key: 'regionGlowOpacity', label: 'Region Glow',           min: 0,   max: 0.2,  step: 0.01, format: v => v.toFixed(2) },
  { key: 'linkOpacity',       label: 'Link Opacity',          min: 0,   max: 1,    step: 0.01, format: v => v.toFixed(2) },
];

const CHECKBOXES = [
  { key: 'bgBreathingEnabled', label: 'Breathing animation' },
  { key: 'bgLogoVisible',      label: 'Logo watermark' },
];

// ═══════════════════════════════════════════
// BUILD TAB HTML
// ═══════════════════════════════════════════

function buildGraphicsTab() {
  // Range sliders
  const sliderRows = SLIDERS.map(s => `
    <div class="gfx-row">
      <span class="gfx-label">${s.label}</span>
      <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${gfx[s.key]}">
      <span class="gfx-val" data-val="${s.key}">${s.format(gfx[s.key])}</span>
    </div>`).join('');

  // Checkboxes
  const checkboxRows = CHECKBOXES.map(cb => `
    <div class="gfx-row">
      <label class="gfx-label" style="min-width:0;display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" data-key="${cb.key}" ${gfx[cb.key] ? 'checked' : ''}> ${cb.label}
      </label>
    </div>`).join('');

  return `
    <div class="iface-section">
      ${sliderRows}
    </div>
    <div class="iface-section">
      ${checkboxRows}
    </div>
  `;
}

// ═══════════════════════════════════════════
// WIRE UP AFTER RENDER
// ═══════════════════════════════════════════

function initGraphicsTab(container) {
  // Range sliders
  container.querySelectorAll('input[type="range"]').forEach(input => {
    input.addEventListener('input', () => {
      const key = input.dataset.key;
      gfx[key] = parseFloat(input.value);
      const valSpan = container.querySelector(`[data-val="${key}"]`);
      if (valSpan) valSpan.textContent = parseFloat(input.step) < 1 ? gfx[key].toFixed(2) : gfx[key];
      saveGfxConfig(gfx);
      emit('graph:refresh');
    });
  });

  // Checkboxes
  container.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      gfx[input.dataset.key] = input.checked;
      saveGfxConfig(gfx);
      emit('graph:refresh');
    });
  });
}

// ═══════════════════════════════════════════
// SELF-REGISTER
// ═══════════════════════════════════════════

registerSettingsTab({
  id: 'graphics',
  label: 'Graphics',
  icon: '\uD83C\uDFA8',
  order: 70,
  build: buildGraphicsTab,
  afterRender: initGraphicsTab,
});
