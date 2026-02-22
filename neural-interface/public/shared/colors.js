// ═══════════════════════════════════════════
// COLORS — shared color utility functions
// ═══════════════════════════════════════════
//
// Pure utility functions for color resolution, alpha blending,
// importance-to-radius mapping, and the custom <select> upgrade.
// No variant-specific dependencies.

import { COLOR_PALETTE, KEYS } from './constants.js';
import { state } from './state.js';

/**
 * Resolve the display color for a category.
 * Priority: localStorage override > backend metadata color > palette index > hash fallback.
 * @param {string} category  Category name
 * @returns {string} Hex color string
 */
export function catColor(category) {
  // 1. User override from localStorage (highest priority)
  try {
    const overrides = JSON.parse(localStorage.getItem(KEYS.CATEGORY_COLORS) || '{}');
    if (overrides[category]) return overrides[category];
  } catch {}
  // 2. Backend color from category metadata
  if (state.categoryMetadata[category]?.color) {
    return state.categoryMetadata[category].color;
  }
  // 3. Index-based from palette (deterministic -- same position = same color)
  const idx = state.allCategoryNames.indexOf(category);
  if (idx >= 0) return COLOR_PALETTE[idx % COLOR_PALETTE.length];
  // 4. Hash-based fallback for unknown categories
  let hash = 0;
  for (let i = 0; i < category.length; i++) hash = ((hash << 5) - hash + category.charCodeAt(i)) | 0;
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}

/**
 * Convert a hex color + alpha (0-1) to an rgba() string.
 * @param {string} hex    Hex color (e.g. '#C47A8E')
 * @param {number} alpha  Alpha value 0-1
 * @returns {string} rgba() CSS string
 */
export function hexAlpha(hex, alpha) {
  const c = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${alpha})`;
}

/**
 * Map an importance score (1-10) to a node radius.
 * @param {number} importance  1-10
 * @returns {number} Radius (2 to 6.5)
 */
export function importanceToRadius(importance) {
  return 2 + (importance - 1) * 0.5; // 2 to 6.5
}

/**
 * Replace a native <select> with a styled custom dropdown.
 * Keeps the hidden <select> synced so .value still works.
 * Adds category color dots via catColor() when values match categories.
 *
 * If the select was already upgraded, refreshes the existing wrapper
 * (useful after options change dynamically).
 *
 * @param {HTMLSelectElement} selectEl  The native <select> to upgrade
 * @returns {HTMLDivElement|null} The .styled-select wrapper, or null if selectEl is falsy
 */
export function upgradeSelect(selectEl) {
  if (!selectEl) return null;

  // If already upgraded, refresh the existing wrapper
  if (selectEl.dataset.upgraded) {
    const existing = selectEl.closest('.styled-select');
    if (existing && existing._refresh) { existing._refresh(); return existing; }
  }

  selectEl.dataset.upgraded = '1';
  selectEl.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'styled-select';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'styled-select-trigger';

  const menu = document.createElement('div');
  menu.className = 'styled-select-menu';

  function updateTrigger() {
    trigger.innerHTML = '';
    const sel = selectEl.options[selectEl.selectedIndex];
    if (sel && sel.value) {
      const dot = document.createElement('span');
      dot.className = 'styled-select-dot';
      dot.style.background = catColor(sel.value);
      trigger.appendChild(dot);
    }
    const lbl = document.createElement('span');
    lbl.className = 'styled-select-label';
    lbl.textContent = sel ? sel.textContent : '';
    trigger.appendChild(lbl);
  }

  function buildOptions() {
    menu.innerHTML = '';
    Array.from(selectEl.options).forEach(opt => {
      const row = document.createElement('div');
      row.className = 'styled-select-option' + (opt.value === selectEl.value ? ' active' : '');
      if (opt.value) {
        const dot = document.createElement('span');
        dot.className = 'styled-select-dot';
        dot.style.background = catColor(opt.value);
        row.appendChild(dot);
      }
      const lbl = document.createElement('span');
      lbl.textContent = opt.textContent;
      row.appendChild(lbl);
      row.addEventListener('click', () => {
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        updateTrigger();
        buildOptions();
        wrapper.classList.remove('open');
      });
      menu.appendChild(row);
    });
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close any other open styled selects first
    document.querySelectorAll('.styled-select.open').forEach(s => {
      if (s !== wrapper) s.classList.remove('open');
    });
    const opening = wrapper.classList.toggle('open');
    if (opening) buildOptions();
  });

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) wrapper.classList.remove('open');
  });

  selectEl.parentNode.insertBefore(wrapper, selectEl);
  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  wrapper.appendChild(selectEl);

  wrapper._refresh = () => { updateTrigger(); buildOptions(); };
  updateTrigger();
  return wrapper;
}
