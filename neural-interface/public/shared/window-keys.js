// ═══════════════════════════════════════════
// SynaBun Neural Interface — which keys a floating window takes from the whiteboard
// ═══════════════════════════════════════════
//
// The whiteboard listens for keys at the document in the capture phase, ahead of every element, and stops the ones
// it acts on (Escape deselects and resets the tool there). The Notifications window (ui-sessions.js) and Automation
// Studio (ui-automation-studio.js) close on Escape from a listener at the document, so on a page showing the board
// that Escape never reached them. While one of these windows is open:
//   • a key pressed inside it (target or focus) is the window's, never a board shortcut;
//   • Escape is the window's wherever the focus is (the window is the top layer: its backdrop covers the board, and
//     its own Escape handling closes a list, a popover or the search first), except while a text on the board is
//     being edited (the focus is inside the board): that Escape still ends the edit.
// Text fields keep their own Escape: the whiteboard leaves keys typed in a field alone already.
//
// No DOM needed: `node --test` passes stand-ins with closest / querySelector (tests/window-keys.test.mjs).

/** The windows that close on Escape and take it from the board. */
export const ESCAPE_WINDOWS = Object.freeze(['#session-monitor-panel', '#automation-studio-panel']);
const SELECTOR = ESCAPE_WINDOWS.join(', ');
const BOARD = '#static-bg';

const inside = (node, selector) => {
  try { return !!(node && typeof node.closest === 'function' && node.closest(selector)); } catch { return false; }
};

/** Whether one of ESCAPE_WINDOWS is on the page. */
export function escapeWindowOpen(doc = globalThis.document) {
  try { return !!(doc && typeof doc.querySelector === 'function' && doc.querySelector(SELECTOR)); } catch { return false; }
}

/** Whether the board must leave this key to an open window (see above). */
export function windowTakesKey(event, active = globalThis.document?.activeElement, doc = globalThis.document) {
  if (!event) return false;
  if (inside(event.target, SELECTOR) || inside(active, SELECTOR)) return true;
  if (event.key !== 'Escape') return false;
  if (inside(active, BOARD)) return false;
  return escapeWindowOpen(doc);
}
