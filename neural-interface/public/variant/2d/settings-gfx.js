// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Graphics Settings Tab
// Self-registers a "Graphics" tab in the settings panel
// via the shared registry. No explicit exports — side-effect module.
// ═══════════════════════════════════════════

import { registerSettingsTab } from '../../shared/registry.js';
import { gfx, saveGfxConfig } from './gfx.js';
import { emit } from '../../shared/state.js';
import * as kit from '../../shared/settings/settings-kit.js';

// ═══════════════════════════════════════════
// SLIDER DEFINITIONS
// ═══════════════════════════════════════════

// `inv` is the Settings inventory id: its label and one-line help come from i18n (settings.redesign.control.*).
const SLIDERS = [
  { key: 'parentOrbitRadius', inv: 'GFX001', min: 300, max: 1200, step: 50,   format: v => String(v) },
  { key: 'childOrbitGap',     inv: 'GFX002', min: 100, max: 500,  step: 25,   format: v => String(v) },
  { key: 'cardGap',           inv: 'GFX003', min: 5,   max: 40,   step: 5,    format: v => String(v) },
  { key: 'cardOpacity',       inv: 'GFX004', min: 0.3, max: 1,    step: 0.05, format: v => v.toFixed(2) },
  { key: 'regionGlowOpacity', inv: 'GFX005', min: 0,   max: 0.2,  step: 0.01, format: v => v.toFixed(2) },
  { key: 'linkOpacity',       inv: 'GFX006', min: 0,   max: 1,    step: 0.01, format: v => v.toFixed(2) },
];

const CHECKBOXES = [
  { key: 'bgBreathingEnabled', inv: 'GFX007' },
  { key: 'bgLogoVisible',      inv: 'GFX008' },
];

// ═══════════════════════════════════════════
// BUILD TAB HTML
// ═══════════════════════════════════════════

function buildGraphicsTab() {
  // Range sliders
  const sliderRows = SLIDERS.map(s => `
    <div class="gfx-row" ${kit.inv(s.inv)}>
      <label class="gfx-label" for="gfx-${s.key}">${kit.L(s.inv)}</label>
      <input type="range" id="gfx-${s.key}" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${gfx[s.key]}" title="${kit.H(s.inv)}">
      <span class="gfx-val" data-val="${s.key}">${s.format(gfx[s.key])}</span>
    </div>`).join('');

  // Switches (plain checkboxes underneath: the wiring reads input[type="checkbox"][data-key])
  const checkboxRows = CHECKBOXES.map(cb => kit.toggleField(cb.inv,
    kit.switchInput(`gfx-${cb.key}`, { checked: !!gfx[cb.key], attrs: `data-key="${cb.key}"` }), { forId: `gfx-${cb.key}` })).join('');

  return `
    ${sliderRows}
    <div style="margin-top:14px">${checkboxRows}</div>
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
