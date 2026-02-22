// ═══════════════════════════════════════════
// SynaBun Neural Interface — Help Modal
// Shared help sections + variant section injection via registry
// ═══════════════════════════════════════════

import { getHelpSections } from './registry.js';

// Shared help sections that appear in all variants
const SHARED_HELP_SECTIONS = [
  {
    order: 10,
    html: `<div class="help-section">
      <div class="help-section-title">Keyboard</div>
      <div class="help-row"><div class="help-keys"><span class="help-key">/</span></div><span class="help-desc">Focus search</span></div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Esc</span></div><span class="help-desc">Close panel / clear search</span></div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Enter</span></div><span class="help-desc">Save layout (when naming)</span></div>
      <div class="help-row"><div class="help-keys"><span class="help-key">?</span></div><span class="help-desc">Toggle this help</span></div>
    </div>`
  },
  {
    order: 20,
    html: `<div class="help-section">
      <div class="help-section-title">Mouse &mdash; Graph</div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Click</span><span class="help-key">Node</span></div><span class="help-desc">Select &amp; inspect memory</span></div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Drag</span><span class="help-key">Node</span></div><span class="help-desc">Move &amp; pin node in place</span></div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Hover</span><span class="help-key">Node</span></div><span class="help-desc">Show tooltip preview</span></div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Ctrl</span><span class="help-key">Click</span></div><span class="help-desc">Multi-select nodes</span></div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Click</span><span class="help-key">Background</span></div><span class="help-desc">Deselect / close detail panel</span></div>
    </div>`
  },
  {
    order: 80,
    html: `<div class="help-section">
      <div class="help-section-title">Panels</div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Drag</span><span class="help-key">Grip</span></div><span class="help-desc">Move panel</span></div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Drag</span><span class="help-key">Edge</span></div><span class="help-desc">Resize panel</span></div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Pin</span><span class="help-key">&#x1F4CC;</span></div><span class="help-desc">Lock panel position &amp; size</span></div>
    </div>`
  },
  {
    order: 90,
    html: `<div class="help-section">
      <div class="help-section-title">Sidebar</div>
      <div class="help-row"><div class="help-keys"><span class="help-key">Click</span><span class="help-key">Category</span></div><span class="help-desc">Toggle category visibility</span></div>
    </div>`
  }
];

function buildHelpContent() {
  const variantSections = getHelpSections();
  const allSections = [...SHARED_HELP_SECTIONS, ...variantSections];
  allSections.sort((a, b) => a.order - b.order);
  return allSections.map(s => s.html).join('');
}

export function openHelp() {
  const overlay = document.getElementById('help-overlay');
  const content = document.getElementById('help-content');
  if (content) content.innerHTML = buildHelpContent();
  if (overlay) overlay.classList.add('open');
}

export function closeHelp() {
  const overlay = document.getElementById('help-overlay');
  if (overlay) overlay.classList.remove('open');
}

export function initHelp() {
  const helpBtn = document.getElementById('help-btn');
  const helpClose = document.getElementById('help-close');
  const helpOverlay = document.getElementById('help-overlay');

  if (helpBtn) helpBtn.addEventListener('click', openHelp);
  if (helpClose) helpClose.addEventListener('click', closeHelp);
  if (helpOverlay) {
    helpOverlay.addEventListener('click', (e) => {
      if (e.target === helpOverlay) closeHelp();
    });
  }

  // Global "?" shortcut to toggle help
  document.addEventListener('keydown', (e) => {
    const inInput = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
    if (inInput) return;
    if (e.key === '?') {
      e.preventDefault();
      const overlay = document.getElementById('help-overlay');
      if (overlay?.classList.contains('open')) closeHelp();
      else openHelp();
    }
  });
}
