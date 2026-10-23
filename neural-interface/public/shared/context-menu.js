// ═══════════════════════════════════════════
// SynaBun Neural Interface — Context menu component
// One menu at a time, at the pointer or by the focused element, in the box of
// the menubar's dropdown and with its rows (.menu-item, .menu-shortcut,
// .menu-submenu-arrow, .menu-sep). Items are data (context-menu-logic.js);
// this module draws them, places the menu and its submenus inside the window,
// takes the keys while it is open and closes on a press outside, Escape,
// Tab, scroll, resize, window blur and after an action. Any area can open
// one; the app's global right-click menu is ui-context-menu.js.
// ═══════════════════════════════════════════

import {
  anchorPoint, firstIndex, lastIndex, normalizeItems, placeMenu, placeSubmenu, stepIndex, typeaheadIndex,
} from './context-menu-logic.js';

const SUBMENU_OPEN_DELAY = 120; // hover intent before a submenu opens
const SUBMENU_GRACE = 300;      // the pointer may cross other rows on its way into an open submenu
const TYPEAHEAD_RESET = 600;
const ARROW_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

let _open = null; // the open menu's handle

/** Whether a menu is open. */
export const isContextMenuOpen = () => !!_open;

/** Close the open menu, if there is one. `refocus: false` leaves the keyboard where it is. */
export function closeContextMenu(o) { _open?.close(o); }

/** The root element of the open menu, or null. */
export const openContextMenuElement = () => _open?.element || null;

/**
 * Open a menu.
 * @param {object} o
 * @param {import('./context-menu-logic.js').MenuItem[]} o.items
 * @param {number} [o.x] @param {number} [o.y] where the press was (client px)
 * @param {DOMRect | null} [o.anchorRect] opened from the keyboard: the focused element's box, used when x/y are missing
 * @param {string} [o.label] the menu's accessible name
 * @param {boolean} [o.keyboard] opened from the keyboard: the first row has the focus from the start
 * @param {Element | null} [o.returnFocus] where the keyboard goes back to when the menu closes
 * @param {() => void} [o.onClose]
 * @returns {{ close: Function, element: HTMLElement } | null} null when no item is left to show
 */
export function openContextMenu({ items, x, y, anchorRect = null, label = '', keyboard = false,
  returnFocus = document.activeElement, onClose } = {}) {
  // A menu opened over another one hands the keyboard back to where the first one would have.
  if (_open && (!returnFocus || _open.contains(returnFocus))) returnFocus = _open.returnFocus;
  closeContextMenu({ refocus: false });
  const list = normalizeItems(items);
  if (!list.length) return null;

  const levels = []; // [{ el, items, rows, active, parentRow }]
  let closed = false;
  let subTimer = 0;
  let subPending = null;
  let typed = '';
  let typedAt = 0;

  // ── Drawing ──
  function drawRow(item) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      sep.setAttribute('role', 'separator');
      return sep;
    }
    const row = document.createElement('div');
    row.className = 'menu-item';
    row.tabIndex = -1;
    const checkable = typeof item.checked === 'boolean';
    row.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
    if (checkable) {
      row.setAttribute('aria-checked', String(item.checked));
      row.classList.toggle('active', item.checked);
    }
    if (item.id) row.dataset.ctxId = item.id;
    if (item.disabled) {
      row.classList.add('disabled');
      row.setAttribute('aria-disabled', 'true');
    }
    const check = document.createElement('span');
    check.className = 'menu-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = checkable ? '✓' : '';
    const text = document.createElement('span');
    text.className = 'menu-text';
    if (item.icon) {
      const icon = document.createElement('span');
      icon.className = 'menu-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = item.icon; // the app's own markup, never text from the page
      text.append(icon);
    }
    const name = document.createElement('span');
    name.className = 'app-ctx-label';
    name.textContent = item.label;
    text.append(name);
    row.append(check, text);
    if (item.submenu) {
      row.setAttribute('aria-haspopup', 'menu');
      row.setAttribute('aria-expanded', 'false');
      const arrow = document.createElement('span');
      arrow.className = 'menu-submenu-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.innerHTML = ARROW_SVG;
      row.append(arrow);
    } else if (item.shortcut) {
      const key = document.createElement('span');
      key.className = 'menu-shortcut';
      key.textContent = item.shortcut;
      row.append(key);
    }
    return row;
  }

  function drawLevel(levelItems, name) {
    const el = document.createElement('div');
    el.className = 'app-ctx-menu';
    el.setAttribute('role', 'menu');
    if (name) el.setAttribute('aria-label', name);
    el.tabIndex = -1;
    el.style.visibility = 'hidden';
    const rows = levelItems.map(drawRow);
    el.append(...rows);
    const level = { el, items: levelItems, rows, active: -1, parentRow: null };
    el.addEventListener('pointermove', (event) => onHover(level, event));
    el.addEventListener('click', (event) => {
      const index = rowIndex(level, event.target);
      if (index >= 0) activate(level, index);
    });
    // The press stays off the page: nothing selected there is cleared, nothing behind the menu is focused.
    el.addEventListener('pointerdown', (event) => event.preventDefault());
    el.addEventListener('mousedown', (event) => event.preventDefault());
    el.addEventListener('contextmenu', (event) => event.preventDefault());
    document.body.appendChild(el);
    return level;
  }

  const rowIndex = (level, node) => {
    const row = node?.closest?.('.menu-item');
    return row ? level.rows.indexOf(row) : -1;
  };
  const levelOf = (index) => levels[index];
  const levelIndex = (level) => levels.indexOf(level);

  // ── The row the keyboard and the pointer are on ──
  function setActive(level, index, { focus = true } = {}) {
    if (level.active >= 0) level.rows[level.active]?.classList.remove('focused');
    level.active = index;
    const row = index >= 0 ? level.rows[index] : null;
    if (!row) { if (focus) level.el.focus({ preventScroll: true }); return; }
    row.classList.add('focused');
    if (focus) row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: 'nearest' });
  }

  // The level the keyboard is in: the deepest one with a row on, else the deepest one open.
  function keyLevel() {
    for (let i = levels.length - 1; i >= 0; i--) if (levels[i].active >= 0) return levels[i];
    return levels[levels.length - 1];
  }

  // ── Submenus ──
  function openSubmenu(level, index, { focusFirst = false } = {}) {
    cancelTimer();
    const item = level.items[index];
    const row = level.rows[index];
    if (!item?.submenu || item.disabled) return;
    const depth = levelIndex(level);
    const next = levelOf(depth + 1);
    if (next?.parentRow !== row) {
      closeFrom(depth + 1);
      const sub = drawLevel(item.submenu, item.label);
      sub.parentRow = row;
      levels.push(sub);
      row.classList.add('submenu-open');
      row.setAttribute('aria-expanded', 'true');
      const menuRect = level.el.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const box = sub.el.getBoundingClientRect();
      const at = placeSubmenu({ menuRect, rowRect, width: box.width, height: box.height,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
      sub.el.style.left = `${at.left}px`;
      sub.el.style.top = `${at.top}px`;
      sub.el.dataset.side = at.side;
      sub.el.style.visibility = '';
    }
    if (focusFirst) setActive(levelOf(depth + 1), firstIndex(item.submenu));
  }

  // Close every level from `depth` down; the row that opened the first of them is no longer open.
  function closeFrom(depth) {
    while (levels.length > Math.max(depth, 1)) {
      const level = levels.pop();
      level.parentRow?.classList.remove('submenu-open');
      level.parentRow?.setAttribute('aria-expanded', 'false');
      level.el.remove();
    }
  }

  function scheduleTimer(row, fn, ms) {
    clearTimeout(subTimer);
    subPending = row;
    subTimer = setTimeout(() => { subTimer = 0; subPending = null; if (!closed) fn(); }, ms);
  }
  function cancelTimer() {
    clearTimeout(subTimer);
    subTimer = 0;
    subPending = null;
  }

  function onHover(level, event) {
    const index = rowIndex(level, event.target);
    if (index < 0) return;
    const item = level.items[index];
    const row = level.rows[index];
    if (item.disabled) return;
    if (level.active !== index) setActive(level, index);
    // Back in a parent level: the deeper ones lose their highlight, not their place.
    const depth = levelIndex(level);
    for (let i = depth + 1; i < levels.length; i++) setActive(levels[i], -1, { focus: false });
    if (row === subPending) return;
    const next = levelOf(depth + 1);
    if (next) {
      if (next.parentRow === row) { cancelTimer(); return; }
      scheduleTimer(row, () => (item.submenu ? openSubmenu(level, index) : closeFrom(depth + 1)), SUBMENU_GRACE);
    } else if (item.submenu) {
      scheduleTimer(row, () => openSubmenu(level, index), SUBMENU_OPEN_DELAY);
    } else {
      cancelTimer();
    }
  }

  // ── Choosing ──
  function activate(level, index) {
    const item = level.items[index];
    if (!item || item.separator || item.disabled) return;
    if (item.submenu) { openSubmenu(level, index, { focusFirst: true }); return; }
    close({ refocus: true });
    try {
      const result = item.run?.();
      if (result && typeof result.catch === 'function') result.catch((err) => console.warn('[context-menu] action failed:', err));
    } catch (err) {
      console.warn('[context-menu] action failed:', err);
    }
  }

  // ── Keys (at the window, before anything in the page; the app's single-key shortcuts must not fire) ──
  function onKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      if (event.key === 'Escape') { event.preventDefault(); close({ refocus: true }); }
      return; // the browser's and the system's keys stay theirs
    }
    const level = keyLevel();
    const depth = levelIndex(level);
    const deepest = levels.length - 1; // a submenu the pointer opened may be open without the keyboard in it
    const { key } = event;
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    // Moving to another row closes a submenu that belongs to the row left.
    const move = (index) => {
      setActive(level, index);
      if (levelOf(depth + 1) && levelOf(depth + 1).parentRow !== level.rows[level.active]) closeFrom(depth + 1);
    };
    switch (key) {
      case 'ArrowDown': handled(); move(stepIndex(level.items, level.active, 1)); return;
      case 'ArrowUp': handled(); move(stepIndex(level.items, level.active, -1)); return;
      case 'Home': handled(); move(firstIndex(level.items)); return;
      case 'End': handled(); move(lastIndex(level.items)); return;
      case 'ArrowRight':
        handled();
        if (level.items[level.active]?.submenu) openSubmenu(level, level.active, { focusFirst: true });
        return;
      case 'ArrowLeft':
        handled();
        if (deepest > 0) backTo(deepest);
        return;
      case 'Escape':
        handled();
        if (deepest > 0) backTo(deepest); else close({ refocus: true });
        return;
      case 'Tab': handled(); close({ refocus: true }); return;
      case 'Enter':
      case ' ':
        handled();
        if (level.active >= 0) activate(level, level.active);
        return;
      default:
        if (key.length !== 1) return;
        handled();
        {
          const now = Date.now();
          typed = now - typedAt > TYPEAHEAD_RESET ? key : typed + key;
          typedAt = now;
          const index = typeaheadIndex(level.items, level.active, typed);
          if (index >= 0) move(index);
        }
    }
  }
  // A Space released on a row must not reach it as a click either.
  function onKeyUp(event) {
    if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === ' ' || event.key === 'Enter')) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // Leave a submenu for the row that opened it.
  function backTo(depth) {
    const parent = levelOf(depth - 1);
    const row = levelOf(depth).parentRow;
    closeFrom(depth);
    setActive(parent, parent.rows.indexOf(row));
  }

  // ── Closing ──
  const inside = (node) => levels.some((level) => level.el.contains(node));
  const onOutsidePress = (event) => { if (!inside(event.target)) close({ refocus: false }); };
  const onScroll = (event) => { if (!inside(event.target)) close({ refocus: false }); };
  const onGone = () => close({ refocus: false });

  function close({ refocus = true } = {}) {
    if (closed) return;
    closed = true;
    if (_open === handle) _open = null;
    cancelTimer();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener('pointerdown', onOutsidePress, true);
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('wheel', onScroll, true);
    window.removeEventListener('resize', onGone);
    window.removeEventListener('blur', onGone);
    // The keyboard goes back where it was, unless the press outside already took it somewhere.
    const active = document.activeElement;
    const held = !active || active === document.body || inside(active);
    for (const level of levels.splice(0)) level.el.remove();
    if (refocus && held && returnFocus?.isConnected && typeof returnFocus.focus === 'function') {
      try { returnFocus.focus({ preventScroll: true }); } catch { /* not focusable any more */ }
    }
    try { onClose?.(); } catch (err) { console.warn('[context-menu] onClose failed:', err); }
  }

  // ── Open ──
  const root = drawLevel(list, label);
  levels.push(root);
  const box = root.el.getBoundingClientRect();
  let px = x;
  let py = y;
  if (!Number.isFinite(px) || !Number.isFinite(py)) ({ x: px, y: py } = anchorPoint(anchorRect, window.innerWidth, window.innerHeight));
  const at = placeMenu({ x: px, y: py, width: box.width, height: box.height,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
  root.el.style.left = `${at.left}px`;
  root.el.style.top = `${at.top}px`;
  root.el.style.visibility = '';
  root.el.classList.add('app-ctx-menu--root');

  const handle = { close, element: root.el, returnFocus, contains: inside };
  _open = handle;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('pointerdown', onOutsidePress, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('wheel', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onGone);
  window.addEventListener('blur', onGone);
  if (keyboard) setActive(root, firstIndex(list));
  else root.el.focus({ preventScroll: true });
  return handle;
}
