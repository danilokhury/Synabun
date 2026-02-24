// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Context Menu
// Right-click on a card shows a context menu with actions.
// Listens for 'node-context-menu' events from graph.js.
// Element: #context-menu
// ═══════════════════════════════════════════

import { state, emit, on } from '../../shared/state.js';
import { getAllCards } from './graph.js';

const $ = (id) => document.getElementById(id);

// ── Private state ──
let _contextMenuNode = null;
let _contextMenu = null;

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize the context menu system.
 * @param {object} _graphInstance  Unused — kept for API compatibility
 */
export function initContextMenu(_graphInstance) {
  _contextMenu = $('context-menu');
  if (!_contextMenu) return;

  // ── Menu item clicks ──
  _contextMenu.addEventListener('click', _onMenuClick);

  // ── Close on outside click ──
  document.addEventListener('click', _onDocumentClick);

  // ── Listen for context menu events from the graph renderer ──
  on('node-context-menu', ({ node, event }) => {
    showContextMenu(node, event);
  });
}

// ═══════════════════════════════════════════
// SHOW / HIDE
// ═══════════════════════════════════════════

/**
 * Show the context menu at the given screen coordinates for a node.
 * @param {object} node   The graph node object
 * @param {MouseEvent} event  The triggering mouse event (for coordinates)
 */
export function showContextMenu(node, event) {
  if (!_contextMenu) return;

  _contextMenuNode = node;
  _contextMenu.style.left = event.clientX + 'px';
  _contextMenu.style.top = event.clientY + 'px';
  _contextMenu.classList.add('open');

  // Update pin text based on card pinned state
  const pinItem = _contextMenu.querySelector('[data-action="pin"]');
  if (pinItem) {
    const cards = getAllCards();
    const card = cards.find(c => c.node.id === node.id);
    pinItem.textContent = (card && card.pinned) ? 'Unpin' : 'Pin';
  }
}

/**
 * Hide the context menu and clear the tracked node.
 */
export function hideContextMenu() {
  if (!_contextMenu) return;
  _contextMenu.classList.remove('open');
  _contextMenuNode = null;
}

// ═══════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════

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
    case 'pin': {
      const cards = getAllCards();
      const card = cards.find(c => c.node.id === node.id);
      if (card) {
        card.pinned = !card.pinned;
        emit('context-menu:pin', { node, pinned: card.pinned });
      }
      break;
    }
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

function _onDocumentClick(e) {
  if (_contextMenu && !_contextMenu.contains(e.target)) {
    hideContextMenu();
  }
}

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════

export function setGraph(_graphInstance) {
  // No-op — context menu is event-driven
}

export function getContextMenuNode() {
  return _contextMenuNode;
}
