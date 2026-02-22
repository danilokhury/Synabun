// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Context Menu
// Right-click on a node shows a context menu with actions.
// Right-click on background hides the menu.
// Element: #context-menu
// ═══════════════════════════════════════════

import { state, emit, on } from '../../shared/state.js';

const $ = (id) => document.getElementById(id);

// ── Private state ──
let _contextMenuNode = null;
let _contextMenu = null;
let _graph = null;

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize the context menu system.
 * Sets up click handlers on the #context-menu element and a
 * document-level click listener to close on outside click.
 *
 * Actions emit events so the variant's main code can handle
 * domain-specific operations (showDetailPanel, enterEditMode, etc.).
 *
 * @param {object} graphInstance  The force-graph 2D instance
 */
export function initContextMenu(graphInstance) {
  _graph = graphInstance;
  _contextMenu = $('context-menu');
  if (!_contextMenu) return;

  // ── Menu item clicks ──
  _contextMenu.addEventListener('click', _onMenuClick);

  // ── Close on outside click ──
  document.addEventListener('click', _onDocumentClick);
}

// ═══════════════════════════════════════════
// SHOW / HIDE
// ═══════════════════════════════════════════

/**
 * Show the context menu at the given screen coordinates for a node.
 * Skips anchor/tag nodes.
 * @param {object} node   The graph node object
 * @param {MouseEvent} event  The triggering mouse event (for coordinates)
 */
export function showContextMenu(node, event) {
  if (!_contextMenu) return;
  if (node.payload._isAnchor || node.payload._isTag) return;

  _contextMenuNode = node;
  _contextMenu.style.left = event.clientX + 'px';
  _contextMenu.style.top = event.clientY + 'px';
  _contextMenu.classList.add('visible');

  // Update pin text
  const pinItem = _contextMenu.querySelector('[data-action="pin"]');
  if (pinItem) pinItem.textContent = node.fx != null ? 'Unpin' : 'Pin';
}

/**
 * Hide the context menu and clear the tracked node.
 */
export function hideContextMenu() {
  if (!_contextMenu) return;
  _contextMenu.classList.remove('visible');
  _contextMenuNode = null;
}

// ═══════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════

/**
 * Handle clicks on context menu items.
 * Emits events for each action so the variant handles side effects.
 */
function _onMenuClick(e) {
  const action = e.target.closest('.ctx-item')?.dataset.action;
  if (!action || !_contextMenuNode) return;
  const node = _contextMenuNode;
  hideContextMenu();

  switch (action) {
    case 'open':
      emit('context-menu:open', { node });
      break;
    case 'edit':
      emit('context-menu:edit', { node });
      break;
    case 'move':
      emit('context-menu:move', { node });
      break;
    case 'pin':
      if (node.fx != null) {
        node.fx = undefined;
        node.fy = undefined;
        if (_graph) _graph.d3ReheatSimulation();
      } else {
        node.fx = node.x;
        node.fy = node.y;
      }
      emit('context-menu:pin', { node, pinned: node.fx != null });
      break;
    case 'focus':
      emit('context-menu:focus', { node });
      break;
    case 'bookmark':
      emit('context-menu:bookmark', { node });
      break;
    case 'trash':
      emit('context-menu:trash', { node });
      break;
  }
}

/**
 * Close context menu when clicking outside of it.
 */
function _onDocumentClick(e) {
  if (_contextMenu && !_contextMenu.contains(e.target)) {
    hideContextMenu();
  }
}

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════

/**
 * Update the graph instance reference (e.g. after graph rebuild).
 * @param {object} graphInstance
 */
export function setGraph(graphInstance) {
  _graph = graphInstance;
}

/**
 * Get the currently tracked context menu node.
 * @returns {object|null}
 */
export function getContextMenuNode() {
  return _contextMenuNode;
}
