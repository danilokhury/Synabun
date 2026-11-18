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

// ── Escape and everything else that opens over the page ──
//
// The two windows above were found one at a time; the terminal's folder picker and the workspaces dropdown (and
// its dialogs) had the same fate: they close on Escape from a listener at the document, and the board, listening
// ahead of them, stopped every Escape. The rule now: the board takes Escape only when it has something of its own
// to cancel (ui-whiteboard.js, boardHasEscapeWork), and not even then while any of these shows outside the board.
// They are SynaBun's pickers, dialogs, dropdowns and menus by name, and anything the page marks as a dialog, a menu
// or a list of choices (ARIA roles, <dialog open>, aria-modal) while it is on screen. Shown means rendered: an
// element hidden by `hidden`, display:none, visibility:hidden, opacity 0 or a skipped subtree (a closed side panel)
// is not open.

/** What takes Escape from the board while it shows outside the board. */
export const ESCAPE_OVERLAYS = Object.freeze([
  ...ESCAPE_WINDOWS,
  '#settings-panel',
  '.term-picker-overlay',            // the terminal's folder and project pickers (ui-terminal.js)
  '#ws-dropdown',                    // the workspaces dropdown (ui-workspaces.js)
  '.tag-delete-overlay',             // the shared confirm dialogs: the workspaces' save / clear / delete, and more
  '.fe-modal-overlay', '.fe-ctx-flyout', '.fe-git-popover',
  '.studio-backdrop', '.resume-prompt-overlay', '.sched-prompt-backdrop', '.kb-backdrop', '.ig-backdrop', '.sm-backdrop',
  '.ss-dlg-overlay', '.ss-fd-backdrop', '.ocpv2-name-modal-overlay', '.mtc-settings-overlay', '.cr-modal-overlay',
  '.menubar-item.open', '#topright-overflow-menu', '.cc-dropdown.open',
  'dialog[open]', '[aria-modal="true"]', '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="listbox"]',
]);

/** Whether `el` is on screen (see above). Without layout (node --test) an element counts when it is not hidden. */
export function isShown(el, view = globalThis) {
  if (!el || el.isConnected === false) return false;
  try {
    if (typeof el.closest === 'function' && el.closest('[hidden], [inert]')) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: false });
    }
    if (typeof el.getClientRects === 'function' && !el.getClientRects().length) return false;
    const style = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : null;
    if (style && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The first overlay of ESCAPE_OVERLAYS shown outside the board, or null.
 * @param {Document} [doc]
 * @param {{ selectors?: readonly string[], view?: any }} [options]
 */
export function openEscapeOverlay(doc = globalThis.document, { selectors = ESCAPE_OVERLAYS, view = globalThis } = {}) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;
  for (const selector of selectors) {
    let found;
    try { found = doc.querySelectorAll(selector); } catch { continue; } // a selector an older engine cannot read
    for (const el of found) {
      if (inside(el, BOARD)) continue; // the board's own menus are the board's to close
      if (isShown(el, view)) return el;
    }
  }
  return null;
}

/**
 * Whether the board leaves this Escape to something else: an open window (windowTakesKey) or an overlay shown
 * outside the board, wherever the focus is. The board asks only when no text or list of its own is being edited
 * (an edit in progress still ends on Escape: ui-whiteboard.js handles that before it asks).
 */
export function escapeBelongsElsewhere(event, active = globalThis.document?.activeElement, doc = globalThis.document, view = globalThis) {
  if (!event || event.key !== 'Escape') return false;
  if (windowTakesKey(event, active, doc)) return true;
  return !!openEscapeOverlay(doc, { view });
}
