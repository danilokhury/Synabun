// ═══════════════════════════════════════════
// SynaBun Neural Interface — Search
// Debounced semantic search with result highlighting
// ═══════════════════════════════════════════

import { state, emit } from './state.js';
import { searchMemories } from './api.js';
import { t, tp } from './i18n.js';
import { registerAction } from './ui-keybinds.js';

const $ = (id) => document.getElementById(id);

// ── Internal state ──
let _searchTimeout = null;
const DEBOUNCE_MS = 400;

// ═══════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════

/**
 * Execute a semantic search against the API and update shared state.
 * Emits `search:apply` with the Set of matching IDs on success.
 * Variants should listen for this event to handle camera/centering.
 *
 * @param {string} query  The search query string
 */
export async function performSearch(query) {
  const $searchBadge = $('search-badge');
  const $searchClear = $('search-clear');
  const $statSearch  = $('stat-search-status');

  try {
    const data = await searchMemories(query);

    if (data.results && data.results.length > 0) {
      const ids = new Set(data.results.map(r => r.id));
      state.searchResults = ids;
      state.searchQuery = query;

      if ($searchBadge) {
        $searchBadge.textContent = data.results.length;
        $searchBadge.classList.add('visible');
      }
      if ($searchClear) $searchClear.style.display = 'none'; // badge takes its place
      if ($statSearch) $statSearch.textContent = tp('search.resultCount', data.results.length);

      // Emit for variant-specific camera handling
      emit('search:apply', { ids, results: data.results });
    } else {
      state.searchResults = new Set(); // empty set = no matches
      state.searchQuery = query;

      if ($searchBadge) {
        $searchBadge.textContent = '0';
        $searchBadge.classList.add('visible');
      }
      if ($searchClear) $searchClear.style.display = 'none';
      if ($statSearch) $statSearch.textContent = t('search.noResults');

      emit('search:apply', { ids: new Set(), results: [] });
    }

    emit('stats:update');
  } catch (err) {
    console.error('Search error:', err);
    if ($statSearch) $statSearch.textContent = t('search.searchError');
  }
}

/**
 * Clear the current search — reset state, hide badges, and
 * emit `search:clear` so variants can restore full visibility.
 */
export function clearSearch() {
  state.searchResults = null;
  state.searchQuery = '';

  const $searchInput = $('search-input');
  const $searchBadge = $('search-badge');
  const $searchClear = $('search-clear');
  const $statSearch  = $('stat-search-status');

  if ($searchInput) $searchInput.value = '';
  if ($searchBadge) $searchBadge.classList.remove('visible');
  if ($searchClear) $searchClear.style.display = 'none';
  if ($statSearch) $statSearch.textContent = '';

  emit('search:clear');
  emit('stats:update');
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize the search UI. Wires up:
 * - Input focus/blur styling on the search wrapper
 * - Debounced input handler that triggers performSearch
 * - Clear button that resets search state
 */
export function initSearch() {
  const $searchInput   = $('search-input');
  const $searchWrapper = $('search-wrapper');
  const $searchClear   = $('search-clear');
  const $searchBadge   = $('search-badge');
  const $statSearch    = $('stat-search-status');

  if (!$searchInput) return;

  // ── Focus styling ──
  if ($searchWrapper) {
    $searchInput.addEventListener('focus', () => $searchWrapper.classList.add('focused'));
    $searchInput.addEventListener('blur', () => $searchWrapper.classList.remove('focused'));
  }

  // ── Debounced input ──
  $searchInput.addEventListener('input', () => {
    clearTimeout(_searchTimeout);
    const query = $searchInput.value.trim();

    if (!query) {
      clearSearch();
      return;
    }

    if ($searchClear) $searchClear.style.display = 'block';
    if ($searchBadge) $searchBadge.classList.remove('visible');
    if ($statSearch) $statSearch.textContent = t('search.searching');

    _searchTimeout = setTimeout(() => performSearch(query), DEBOUNCE_MS);
  });

  // ── Clear button ──
  if ($searchClear) {
    $searchClear.addEventListener('click', () => {
      clearSearch();
      $searchInput.focus();
    });
  }

  // Global focus-search shortcut (via central keybinds)
  registerAction('focus-search', () => $searchInput.focus());
}
