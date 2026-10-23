// ═══════════════════════════════════════════
// SynaBun Neural Interface — Context menu: what decides
// No DOM and no imports: the component (context-menu.js) and the app's
// global registration (ui-context-menu.js) draw what these functions say,
// and node --test checks them (tests/context-menu-logic.test.mjs).
// ═══════════════════════════════════════════

/**
 * @typedef {object} MenuItem
 * @property {string} [id]
 * @property {string} [label]
 * @property {string} [icon]      trusted SVG markup (the app's own icons, never page text)
 * @property {string} [shortcut]  the key as menus show it ('' when the action has none)
 * @property {boolean} [disabled]
 * @property {boolean} [checked]  a toggle: drawn with a check, role menuitemcheckbox
 * @property {boolean} [hidden]   left out of the menu
 * @property {MenuItem[]} [submenu]
 * @property {() => unknown} [run]
 * @property {boolean} [separator]
 */

export const VIEWPORT_MARGIN = 8;
export const SUBMENU_GAP = 2;
// What a submenu's first row sits under: the menu's padding plus the row's margin.
export const SUBMENU_LEAD = 6;

/**
 * Items as the menu draws them: hidden ones and ones without a label left out, a submenu with nothing in it left
 * out, no separator at either end or next to another.
 * @param {(MenuItem | null | undefined)[]} items
 * @returns {MenuItem[]}
 */
export function normalizeItems(items) {
  const out = [];
  for (const item of items || []) {
    if (!item || item.hidden) continue;
    if (item.separator) {
      if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
      continue;
    }
    if (!item.label) continue;
    if (item.submenu) {
      const submenu = normalizeItems(item.submenu);
      if (!submenu.length) continue;
      out.push({ ...item, submenu });
      continue;
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/**
 * Sections in order, one separator between two that have something in them.
 * @param {(MenuItem[] | null | undefined)[]} sections
 * @returns {MenuItem[]}
 */
export function joinSections(sections) {
  const out = [];
  for (const section of sections || []) {
    const items = normalizeItems(section);
    if (!items.length) continue;
    if (out.length) out.push({ separator: true });
    out.push(...items);
  }
  return out;
}

/** How many rows a menu has at its top level (separators do not count). */
export function countRows(items) {
  return (items || []).filter((item) => item && !item.separator).length;
}

/**
 * Where a menu of `width` × `height` goes for a press at (x, y): down and to the right of it, flipped up or left
 * when that side has no room, and kept inside the window either way.
 * @returns {{ left: number, top: number }}
 */
export function placeMenu({ x, y, width, height, viewportWidth, viewportHeight, margin = VIEWPORT_MARGIN }) {
  const fit = (at, size, room) => {
    const furthest = room - margin - size;      // the last place it may start and still end inside the margin
    if (furthest < margin) return margin;       // larger than the window: from the margin (it scrolls)
    if (at + size <= room - margin) return Math.max(margin, at);
    if (at - size >= margin) return Math.min(at - size, furthest);
    return furthest;
  };
  return {
    left: Math.round(fit(x, width, viewportWidth)),
    top: Math.round(fit(y, height, viewportHeight)),
  };
}

/**
 * Where a submenu goes: beside the menu it opens from, its first row level with the row that opened it; on the left
 * when the window has no room on the right, and kept inside the window.
 * @param {{ left: number, right: number }} o.menuRect the menu it opens from
 * @param {{ top: number }} o.rowRect the row that opens it
 * @returns {{ left: number, top: number, side: 'right' | 'left' }}
 */
export function placeSubmenu({ menuRect, rowRect, width, height, viewportWidth, viewportHeight,
  margin = VIEWPORT_MARGIN, gap = SUBMENU_GAP, lead = SUBMENU_LEAD }) {
  let side = 'right';
  let left = menuRect.right + gap;
  if (left + width > viewportWidth - margin) {
    const leftSide = menuRect.left - gap - width;
    if (leftSide >= margin) { left = leftSide; side = 'left'; }
    else left = Math.max(margin, viewportWidth - margin - width);
  }
  const top = Math.max(margin, Math.min(rowRect.top - lead, viewportHeight - margin - height));
  return { left: Math.round(left), top: Math.round(top), side };
}

/**
 * Where a menu opened from the keyboard points: inside the focused element near its top-left corner, or at its
 * middle when it fills most of the window (the memory map).
 */
export function anchorPoint(rect, viewportWidth, viewportHeight) {
  if (!rect) return { x: Math.round(viewportWidth / 2), y: Math.round(viewportHeight / 3) };
  if (rect.width > viewportWidth * 0.6 && rect.height > viewportHeight * 0.6) {
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }
  return { x: Math.round(rect.left + Math.min(rect.width / 2, 16)), y: Math.round(rect.top + Math.min(rect.height / 2, 16)) };
}

const selectable = (item) => !!item && !item.separator && !item.disabled;

/**
 * The next row the keyboard can land on from `from` in direction `dir` (1 down, -1 up), wrapping; -1 when none can.
 * From -1, down is the first row and up the last.
 */
export function stepIndex(items, from, dir) {
  const n = items?.length || 0;
  if (!n) return -1;
  let i = from;
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    if (selectable(items[i])) return i;
  }
  return -1;
}

/** The first and the last row the keyboard can land on. */
export const firstIndex = (items) => stepIndex(items, -1, 1);
export const lastIndex = (items) => stepIndex(items, -1, -1);

/**
 * The row typed letters go to: the next one whose label starts with them, from the row after `from` (a first
 * letter) or from `from` itself (more letters of the same word). -1 when none does.
 */
export function typeaheadIndex(items, from, typed) {
  const n = items?.length || 0;
  const want = String(typed || '').toLowerCase();
  if (!n || !want) return -1;
  const start = want.length > 1 ? Math.max(0, from) : from + 1;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (selectable(items[i]) && String(items[i].label || '').toLowerCase().startsWith(want)) return i;
  }
  return -1;
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number',
  'date', 'datetime-local', 'month', 'time', 'week']);

/**
 * Whether an element is a field the browser's own menu belongs to (spelling, paste): a text input, a textarea, a
 * native select or anything editable. Checkboxes, buttons and the like are not.
 * @param {{ tagName?: string, type?: string, isContentEditable?: boolean, closest?: Function } | null} el
 */
export function isEditableTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase());
  return !!el.closest?.('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
}

/**
 * Why the app's menu stays out of a right-click, or null when it opens. In order: another handler took the event
 * (it called preventDefault: an area with a menu of its own), the press is on the app's menu itself, Shift is held
 * (the escape hatch to the browser's menu), the target is a field, or it is in an area that opted out.
 * @param {{ defaultPrevented?: boolean, shiftKey?: boolean }} event
 * @param {{ inOwnMenu?: boolean, editable?: boolean, optedOut?: boolean }} target
 * @returns {null | 'handled' | 'own-menu' | 'shift' | 'editable' | 'opt-out'}
 */
export function nativeMenuReason(event, target = {}) {
  if (event?.defaultPrevented) return 'handled';
  if (target.inOwnMenu) return 'own-menu';
  if (event?.shiftKey) return 'shift';
  if (target.editable) return 'editable';
  if (target.optedOut) return 'opt-out';
  return null;
}

/** Whether a key press asks for a context menu: the ContextMenu key, or Shift+F10, with no other modifier. */
export function isMenuKey(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key === 'ContextMenu' || (event.key === 'F10' && !!event.shiftKey);
}

/**
 * A link the menu can offer: http(s) only, and not one that only points into the page (`#`, `#…`) or runs script.
 * @param {string | null} raw the href as written
 * @param {string | null} resolved the href the browser resolved
 * @returns {string | null} the address to open or copy
 */
export function usableLink(raw, resolved) {
  const written = String(raw ?? '').trim();
  if (!written || written.startsWith('#')) return null;
  if (/^\s*javascript:/i.test(written)) return null;
  return /^https?:\/\//i.test(String(resolved || '')) ? String(resolved) : null;
}

/**
 * An image the menu can offer. A data: or blob: picture can be copied by address; only an http(s) one opens in a
 * new tab (browsers refuse to open a data: address there).
 * @returns {{ src: string, canOpen: boolean } | null}
 */
export function usableImage(src) {
  const value = String(src || '');
  if (/^https?:\/\//i.test(value)) return { src: value, canOpen: true };
  if (/^(data|blob):/i.test(value)) return { src: value, canOpen: false };
  return null;
}

/** A selection as a menu label shows it: one line, at most `max` characters, an ellipsis when cut. */
export function quoteSelection(text, max = 24) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The selected text an action takes: trimmed, and capped so a whole page selected is not sent anywhere at once. */
export const SELECTION_MAX = 4000;
export function selectionPayload(text, max = SELECTION_MAX) {
  const value = String(text || '').trim();
  return value.length > max ? value.slice(0, max) : value;
}
