// ═══════════════════════════════════════════
// STATE — shared reactive state store + event bus
// ═══════════════════════════════════════════
//
// All UI components read/write this object.
// Variants (3D / 2D) listen for changes via the event bus.
// Variant-specific state (graph, bloom, frustum, etc.) stays in the variant.

export const state = {
  // ── Data (loaded from API) ──
  allNodes: [],
  allLinks: [],
  categoryMetadata: {},    // { name: { description, color, parent, is_parent, logo_url } }
  allCategoryNames: [],    // ordered list of category names from server
  categoryDescriptions: {},// { name: description }

  // ── Selection ──
  selectedNodeId: null,
  hoveredNodeId: null,
  focusedNodeId: null,

  // ── Search ──
  searchResults: null,     // null = no active search, Set of IDs = active search
  searchQuery: '',

  // ── Category visibility ──
  activeCategories: new Set(),

  // ── Multi-select ──
  multiSelected: new Set(),

  // ── UI toggles ──
  labelsVisible: true,
  labelSizeMultiplier: 1.0,

  // ── Link mode ──
  linkMode: 'off',         // 'off' | 'intra' | 'all'
  linkTypeFilter: 'all',

  // ── Grid snap ──
  gridSnap: false,
  gridSize: 20,
};


// ═══════════════════════════════════════════
// EVENT BUS — lightweight pub/sub
// ═══════════════════════════════════════════

const _listeners = {};

/**
 * Emit an event to all registered listeners.
 * @param {string} event   Event name (e.g. 'selection-changed', 'data-loaded')
 * @param {*}      [data]  Payload passed to each listener
 */
export function emit(event, data) {
  const fns = _listeners[event];
  if (fns) fns.forEach(fn => fn(data));
}

/**
 * Subscribe to an event. Returns an unsubscribe function.
 * @param {string}   event  Event name
 * @param {Function} fn     Listener
 * @returns {Function} Unsubscribe function
 */
export function on(event, fn) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(fn);
  return () => { _listeners[event] = _listeners[event].filter(f => f !== fn); };
}

/**
 * Remove a specific listener for an event.
 * @param {string}   event  Event name
 * @param {Function} fn     Listener to remove
 */
export function off(event, fn) {
  if (_listeners[event]) {
    _listeners[event] = _listeners[event].filter(f => f !== fn);
  }
}
