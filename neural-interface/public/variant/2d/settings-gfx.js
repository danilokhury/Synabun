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

/**
 * Each entry defines a range slider for the graphics settings tab.
 *   key        — property name on the gfx config object
 *   label      — human-readable label
 *   min/max    — range bounds
 *   step       — increment size
 *   format     — how to display the current value
 */
const SLIDERS = [
  { key: 'linkOpacity',        label: 'Link Opacity',                  min: 0,   max: 1,   step: 0.01, format: v => v.toFixed(2) },
  { key: 'nodeSizeMultiplier', label: 'Node Size Multiplier',          min: 0.5, max: 3,   step: 0.1,  format: v => v.toFixed(1) },
  { key: 'labelThreshold',     label: 'Label Threshold (importance \u2265)', min: 1,   max: 10,  step: 1,    format: v => String(v) },
  { key: 'hullOpacity',        label: 'Hull Opacity',                  min: 0,   max: 0.5, step: 0.01, format: v => v.toFixed(2) },
];

// ═══════════════════════════════════════════
// BUILD TAB HTML
// ═══════════════════════════════════════════

/**
 * Build the Graphics settings tab content.
 * Returns an HTML string to be injected into #settings-content.
 * @returns {string}
 */
function buildGraphicsTab() {
  let html = '';

  // Range sliders
  for (const s of SLIDERS) {
    html += `
      <div class="settings-group">
        <label>${s.label}: <span data-val="${s.key}">${s.format(gfx[s.key])}</span></label>
        <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${gfx[s.key]}" style="width:100%">
      </div>`;
  }

  // Checkbox: background dot grid
  html += `
      <div class="settings-group">
        <label><input type="checkbox" data-key="bgDotGrid" ${gfx.bgDotGrid ? 'checked' : ''}> Show background dot grid</label>
      </div>`;

  return html;
}

// ═══════════════════════════════════════════
// WIRE UP AFTER RENDER
// ═══════════════════════════════════════════

/**
 * Attach event listeners to the sliders and checkboxes after the
 * settings tab HTML has been injected into the DOM.
 * @param {HTMLElement} container  The #settings-content element
 */
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
