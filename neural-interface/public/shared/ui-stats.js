// ═══════════════════════════════════════════
// SynaBun Neural Interface — Stats Bar
// Updates the bottom stats bar with memory/visible/link counts
// ═══════════════════════════════════════════

import { state, on } from './state.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

export function updateStats() {
  const total = state.allNodes.filter(n => !n._isAnchor && !n._isTag).length;
  const visible = state.allNodes.filter(n => !n._isAnchor && !n._isTag && n._visible !== false).length;
  const links = state.allLinks.filter(l => l._visible !== false).length;

  const elTotal = $('stat-total');
  const elVisible = $('stat-visible');
  const elLinks = $('stat-links');
  const elSearch = $('stat-search-status');

  if (elTotal) elTotal.textContent = total;
  if (elVisible) elVisible.textContent = visible;
  if (elLinks) elLinks.textContent = links;

  if (elSearch) {
    if (state.searchResults) {
      elSearch.textContent = t('search.matchCount', { count: state.searchResults.size });
      elSearch.style.color = 'var(--accent-blue)';
    } else {
      elSearch.textContent = '';
    }
  }
}

export function initStats() {
  on('stats:update', updateStats);
  updateStats();
}
