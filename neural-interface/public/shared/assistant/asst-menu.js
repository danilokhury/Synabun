// ═══════════════════════════════════════════
// SynaBun Assistant — shared popover menu
// ═══════════════════════════════════════════
// One body-level popover for every assistant menu (brain fields, model menu,
// sessions, "⋯", route mode). Appended to <body> so it escapes the viewport's
// paint containment; positioned with fixed coordinates next to its anchor and
// kept inside the Assistant that holds the anchor (the sidepanel, or a tab's own
// root) and the window. Only one menu is open at a time.
//
// openMenu(anchor, { title, items, placement:'auto'|'above'|'below'|'prefer-below', filter,
//                    width, role:'menu'|'listbox', label, className, onClose,
//                    zIndex (a menu opened from a layer above the panel's own, e.g. Settings),
//                    footer, bounds, onEscape })
// 'prefer-below' opens under the anchor whenever a usable list fits there (the
// menu scrolls inside that room), even when more room is above: a menu opened
// from Settings must not cover the Settings header. The panel's menus use 'auto'.
// `footer`: items under the list that stay in view while the list scrolls.
// Every menu is measured at the width it is shown at, never wider than its box less the margins,
// and opens where that box has room (the list scrolls inside it). The box is the Assistant
// panel or root around the anchor, else the app frame (app-frame.js; the window on a page without it).
// `bounds`: an element (or () => DOMRect) to use as that box instead: the menu is then exactly
// `width` wide (or the box's room) and follows the box on resize.
// `onEscape`: returns true when it handled Esc (e.g. went back a view): the menu stays open.
// Item kinds:
//   item (default)  { label, desc, icon, tag, disabled, danger, keywords, onSelect }
//   radio           { ...item, selected }            → menuitemradio / option
//   check           { ...item, checked }             → menuitemcheckbox
//   header          { label, icon, color, note }     → 10px uppercase group header
//   separator       {}                               (legacy `{ sep: true }` too)
//   info            { label, value }                 → non-interactive row
//   tag             { label }                        → non-interactive badge row
//   input           { placeholder, value, onSubmit } → inline text field
//   buttons         { label, buttons: [item…] }      → one row of compact items (a group)
// `action: { icon, label, tooltip, id, onSelect }` on an item (or radio / check) adds one icon button at the
// row's end, shown on hover and keyboard focus (the Sessions menu's Remove). It is not a stop of ↑/↓: → from
// its row reaches it, ← goes back, Delete on the row presses it; choosing it never chooses the row and leaves
// the menu open (its onSelect usually redraws it with update()).
// `render(button, { checked })` on an item draws its content instead of label/desc/tag.
// `className` on an item or an info row adds its own class.
// `keepOpen` on an item leaves the menu open when it is chosen.
// `restoreFocus` on an item or input sends focus back to the anchor once it is chosen.
// Keys: ↑/↓ move, Home/End jump, Enter/Space activate, Esc closes (focus back
// to the anchor), Tab closes. The optional filter hides non-matching items and
// any group left empty. The handle's update({ title, items, footer, focus }) redraws
// an open menu in place (focus: the data-id to land on; the filter's text still applies).

import { frameRect } from '../app-frame.js';

let _open = null;
let _uid = 0;
let _lastDown = null;
globalThis.document?.addEventListener('pointerdown', (e) => { _lastDown = { x: e.clientX, target: e.target, at: performance.now() }; }, true);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

function itemKind(item) {
  if (!item) return 'separator';
  if (item.sep) return 'separator';
  if (item.input) return 'input';
  return item.kind || 'item';
}

function focusables(menu) {
  return [...menu.querySelectorAll('.asst-dd-item:not([disabled]), .asst-dd-input')]
    .filter(node => !node.hidden && !node.closest('[hidden]') && node.getClientRects().length);
}

function setFocused(menu, node) {
  menu.querySelectorAll('.asst-dd-item.focused').forEach(n => n.classList.remove('focused'));
  if (!node) return;
  if (node.classList.contains('asst-dd-item')) node.classList.add('focused');
  try { node.focus({ preventScroll: true }); } catch { node.focus(); }
  node.scrollIntoView?.({ block: 'nearest' });
}

/** Close the open menu. `restoreFocus` sends focus back to its anchor. */
export function closeMenu({ restoreFocus = false } = {}) {
  if (!_open) return;
  const { menu, anchor, onClose, cleanup } = _open;
  _open = null;
  cleanup();
  menu.remove();
  if (anchor?.isConnected) {
    if (anchor.getAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'false');
    anchor.removeAttribute('aria-controls');
    if (restoreFocus) { try { anchor.focus({ preventScroll: true }); } catch { /* detached */ } }
  }
  try { onClose?.(); } catch { /* listener error */ }
}

export function isMenuOpen(anchor = null) {
  return !!_open && (!anchor || _open.anchor === anchor);
}

export function currentMenu() {
  return _open?.menu || null;
}

/** The element the open menu belongs to (null when none is open). */
export function currentMenuAnchor() {
  return _open?.anchor || null;
}

function itemButton(item, kind, { role, list, onActivate }) {
  const btn = el('button', `asst-dd-item${item.danger ? ' danger' : ''}${item.className ? ` ${item.className}` : ''}`);
  btn.type = 'button';
  btn.tabIndex = -1;
  btn.dataset.kind = kind;
  if (item.id != null) btn.dataset.id = String(item.id);
  btn.dataset.search = `${item.label || ''} ${item.desc || ''} ${item.keywords || ''}`.toLowerCase();
  const checked = kind === 'radio' ? !!item.selected : kind === 'check' ? !!item.checked : false;
  if (role === 'listbox') {
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', checked ? 'true' : 'false');
  } else if (kind === 'radio') {
    btn.setAttribute('role', 'menuitemradio');
    btn.setAttribute('aria-checked', checked ? 'true' : 'false');
  } else if (kind === 'check') {
    btn.setAttribute('role', 'menuitemcheckbox');
    btn.setAttribute('aria-checked', checked ? 'true' : 'false');
  } else {
    btn.setAttribute('role', role === 'listbox' ? 'option' : 'menuitem');
  }
  if (item.disabled) btn.disabled = true;
  if (typeof item.render === 'function') {
    item.render(btn, { checked });
  } else {
    const lead = kind === 'radio' || kind === 'check'
      ? `<span class="asst-dd-check" aria-hidden="true">${checked ? ICON_CHECK : ''}</span>`
      : '';
    btn.innerHTML = `${lead}${item.icon ? `<span class="asst-icon" aria-hidden="true"${item.color ? ` style="color:${esc(item.color)}"` : ''}>${item.icon}</span>` : ''}<span class="asst-dd-item-main"><span class="asst-dd-item-label">${esc(item.label)}</span>${item.desc ? `<span class="asst-dd-item-desc">${esc(item.desc)}</span>` : ''}</span>${item.tag ? `<span class="asst-dd-item-tag">${esc(item.tag)}</span>` : ''}${item.shortcut ? `<kbd class="asst-dd-kbd">${esc(item.shortcut)}</kbd>` : ''}`;
  }
  if (item.title) btn.title = item.title;
  if (item.ariaLabel) btn.setAttribute('aria-label', item.ariaLabel);
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (!btn.disabled) onActivate(item, btn); });
  btn.addEventListener('mousemove', () => {
    if (btn.classList.contains('focused') || btn.disabled) return;
    const menu = list.closest('.asst-dd-menu');
    menu?.querySelectorAll('.asst-dd-item.focused').forEach(n => n.classList.remove('focused'));
    btn.classList.add('focused');
    // Hover never steals focus from the filter / inline input.
    if (!document.activeElement?.classList?.contains('asst-dd-input')) { try { btn.focus({ preventScroll: true }); } catch { /* ignore */ } }
  });
  if (checked) btn.dataset.checked = '1';
  return btn;
}

/** A row's own action (item.action): an icon button beside the row, outside the ↑/↓ cycle. */
function actionButton(action, item, { role }) {
  const btn = el('button', `asst-iconbtn asst-dd-item-action${action.className ? ` ${action.className}` : ''}`);
  btn.type = 'button';
  btn.tabIndex = -1;
  btn.setAttribute('role', role === 'listbox' ? 'option' : 'menuitem');
  if (action.id != null) btn.dataset.id = String(action.id);
  const label = String(action.label || '');
  if (label) btn.setAttribute('aria-label', label);
  if (action.tooltip || label) btn.dataset.tooltip = action.tooltip || label;
  btn.innerHTML = action.icon || '';
  btn.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  btn.addEventListener('click', (e) => { e.stopPropagation(); action.onSelect?.(item, btn); });
  return btn;
}

function buildItems(list, items, { role, onActivate }) {
  for (const item of items || []) {
    const kind = itemKind(item);
    if (kind === 'separator') { list.appendChild(el('div', 'asst-dd-sep')).setAttribute('role', 'separator'); continue; }
    if (kind === 'buttons') {
      const row = el('div', `asst-dd-btnrow${item.className ? ` ${item.className}` : ''}`);
      row.setAttribute('role', 'group');
      if (item.id != null) row.dataset.id = String(item.id);
      if (item.ariaLabel || item.label) row.setAttribute('aria-label', item.ariaLabel || item.label);
      if (item.label) row.appendChild(el('span', 'asst-dd-btnrow-label', item.label)).setAttribute('aria-hidden', 'true');
      for (const button of item.buttons || []) row.appendChild(itemButton(button, itemKind(button), { role, list, onActivate }));
      list.appendChild(row);
      continue;
    }
    if (kind === 'header') {
      const h = el('div', 'asst-dd-group');
      h.setAttribute('role', 'presentation');
      h.innerHTML = `${item.icon ? `<span class="asst-icon" aria-hidden="true"${item.color ? ` style="color:${esc(item.color)}"` : ''}>${item.icon}</span>` : ''}<span class="asst-dd-group-label">${esc(item.label)}</span>${item.note ? `<span class="asst-dd-group-note">${esc(item.note)}</span>` : ''}`;
      list.appendChild(h);
      continue;
    }
    if (kind === 'info' || kind === 'tag') {
      const row = el('div', `${kind === 'tag' ? 'asst-dd-tagrow' : 'asst-dd-info'}${item.className ? ` ${item.className}` : ''}`);
      row.setAttribute('role', 'presentation');
      row.innerHTML = kind === 'tag'
        ? `<span class="asst-dd-tag">${esc(item.label)}</span>`
        : `<span class="asst-dd-info-label">${esc(item.label)}</span>${item.value != null && item.value !== '' ? `<span class="asst-dd-info-value">${esc(item.value)}</span>` : ''}`;
      list.appendChild(row);
      continue;
    }
    if (kind === 'input') {
      const spec = item.input || item;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'asst-dd-input';
      input.placeholder = spec.placeholder || '';
      input.value = spec.value || '';
      input.setAttribute('aria-label', spec.label || spec.placeholder || 'Value');
      input.dataset.submit = '1';
      input._asstSubmit = (value) => { closeMenu({ restoreFocus: !!spec.restoreFocus }); spec.onSubmit?.(value); };
      list.appendChild(input);
      continue;
    }
    if (item.action && typeof item.action === 'object' && !item.disabled) {
      const row = el('div', 'asst-dd-itemrow');
      row.setAttribute('role', 'none');
      row.appendChild(itemButton(item, kind, { role, list, onActivate }));
      row.appendChild(actionButton(item.action, item, { role }));
      list.appendChild(row);
      continue;
    }
    list.appendChild(itemButton(item, kind, { role, list, onActivate }));
  }
  if (!list.querySelector('.asst-dd-item, .asst-dd-input, .asst-dd-info, .asst-dd-tagrow')) list.appendChild(el('div', 'asst-dd-empty', '—'));
}

/** Hide items that do not match `query`, then any header/separator left without items. */
export function applyMenuFilter(list, query, emptyLabel = 'No matches') {
  const q = String(query || '').trim().toLowerCase();
  const rows = [...list.children];
  for (const row of rows) {
    if (row.classList.contains('asst-dd-item')) row.hidden = !!q && !row.dataset.search.includes(q);
    // A row with its own action: shown while its item matches.
    else if (row.classList.contains('asst-dd-itemrow')) row.hidden = !!q && !(row.querySelector('.asst-dd-item')?.dataset.search || '').includes(q);
    // A button row stays whole: shown while one of its buttons matches.
    else if (row.classList.contains('asst-dd-btnrow')) row.hidden = !!q && ![...row.querySelectorAll('.asst-dd-item')].some(b => b.dataset.search.includes(q));
    else if (row.classList.contains('asst-dd-info') || row.classList.contains('asst-dd-tagrow')) row.hidden = !!q;
  }
  // Group headers: visible only when an item until the next header/separator is visible.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.classList.contains('asst-dd-group')) continue;
    let any = false;
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j];
      if (next.classList.contains('asst-dd-group') || next.classList.contains('asst-dd-sep')) break;
      if (!next.hidden) { any = true; break; }
    }
    row.hidden = !any;
  }
  // Separators: no leading, trailing or doubled separators among visible rows.
  let prevVisible = null;
  for (const row of rows) {
    if (!row.classList.contains('asst-dd-sep')) { if (!row.hidden) prevVisible = row; continue; }
    row.hidden = !prevVisible || prevVisible.classList.contains('asst-dd-sep');
    if (!row.hidden) prevVisible = row;
  }
  const visible = rows.filter(r => !r.hidden);
  const last = visible[visible.length - 1];
  if (last?.classList.contains('asst-dd-sep')) last.hidden = true;
  let empty = list.querySelector('.asst-dd-empty.asst-dd-noresults');
  const hasItem = rows.some(r => !r.hidden && (r.classList.contains('asst-dd-item') || r.classList.contains('asst-dd-itemrow') || r.classList.contains('asst-dd-btnrow') || r.classList.contains('asst-dd-input')));
  if (q && !hasItem) {
    if (!empty) { empty = el('div', 'asst-dd-empty asst-dd-noresults', emptyLabel); list.appendChild(empty); }
    empty.hidden = false;
  } else if (empty) empty.hidden = true;
}

// 'prefer-below': the least room under the anchor that still holds a usable list.
const PREFER_BELOW_MIN = 220;

/**
 * Whether a menu opens above its anchor (pure; sizes in px). `above` / `below`:
 * the room on each side of the anchor; `anchorTop` / `viewportHeight`: the anchor's
 * top in the box the menu stays inside, and that box's height.
 */
export function menuOpensAbove(placement, { anchorTop, anchorHeight, menuHeight, above, below, viewportHeight }) {
  if (placement === 'above') return menuHeight <= above || above >= below;
  if (placement === 'below') return !(menuHeight <= below || below >= above);
  if (placement === 'prefer-below') return below < Math.min(menuHeight, PREFER_BELOW_MIN) && above > below;
  if (anchorTop + anchorHeight / 2 > viewportHeight * 0.55) return menuHeight <= above || above >= below;
  return !(menuHeight <= below || below >= above);
}

// A menu: never narrower than this while the window allows it; never shorter than these
// (a bounded menu holds a title and a footer around its list).
const BOUNDED_MIN_WIDTH = 248;
const MENU_MIN_HEIGHT = 96;
const BOUNDED_MIN_HEIGHT = 140;

/** The box a menu stays inside: its bounds clipped to the app frame (the frame when it has none). */
function boundsBox(bounds) {
  const f = frameRect();
  let r = null;
  try { r = typeof bounds === 'function' ? bounds() : bounds?.getBoundingClientRect?.(); } catch { r = null; }
  if (!r || !(r.width > 0) || !(r.height > 0)) return { left: f.left, top: f.top, right: f.right, bottom: f.bottom };
  return { left: Math.max(f.left, r.left), top: Math.max(f.top, r.top), right: Math.min(f.right, r.right), bottom: Math.min(f.bottom, r.bottom) };
}

/** Where a menu without `bounds` stays: the Assistant around its anchor (the sidepanel, or a tab's own root). */
function assistantOf(anchor) {
  return anchor.closest?.('.assistant-panel') || anchor.closest?.('.asst-root') || null;
}

/** The widest a menu may be in its box (pure; px): the box less the margins, never under the minimum the window allows. */
export function menuRoomWidth({ box, viewportWidth, margin = 8 }) {
  return Math.round(Math.max(box.right - box.left - margin * 2, Math.min(BOUNDED_MIN_WIDTH, viewportWidth - margin * 2)));
}

/** A bounded menu's width (pure; px): `width` at most, its box less the margins, never under the minimum the window allows. */
export function boundedMenuWidth({ box, viewportWidth, width, margin = 8 }) {
  return Math.round(Math.max(Math.min(width || 320, box.right - box.left - margin * 2), Math.min(BOUNDED_MIN_WIDTH, viewportWidth - margin * 2)));
}

/**
 * Where a menu goes (pure; px; rects as getBoundingClientRect gives them): under the anchor or
 * above it as `placement` decides from the room inside the box (menuOpensAbove), as tall as that
 * room; right-aligned with `alignX` (default: the anchor's right edge), or starting at the anchor's
 * left edge with `alignLeft`; always inside the box and the window.
 * → { left, top, maxHeight (null: its own height fits), up }.
 */
export function boundedMenuPlacement({ anchor, box, viewportWidth, viewportHeight, width, menuHeight, placement = 'below', alignX = null, alignLeft = false, minHeight = BOUNDED_MIN_HEIGHT, margin = 8, gap = 6 }) {
  const below = box.bottom - margin - (anchor.bottom + gap);
  const above = anchor.top - gap - (box.top + margin);
  const up = menuOpensAbove(placement, { anchorTop: anchor.top - box.top, anchorHeight: anchor.bottom - anchor.top, menuHeight, above, below, viewportHeight: box.bottom - box.top });
  const room = Math.max(minHeight, Math.floor(up ? above : below));
  const height = Math.min(menuHeight, room);
  let top = up ? anchor.top - gap - height : anchor.bottom + gap;
  top = Math.max(margin, Math.min(top, viewportHeight - margin - height));
  let left = alignLeft ? anchor.left : (alignX ?? anchor.right) - width;
  left = Math.min(left, box.right - margin - width);
  left = Math.max(left, box.left + margin);
  left = Math.max(margin, Math.min(left, viewportWidth - margin - width));
  return { left: Math.round(left), top: Math.round(top), maxHeight: menuHeight > room ? room : null, up };
}

/**
 * Place a menu inside its box: its width is final before it is measured (the CSS caps read the
 * box's room through --asst-dd-room; a bounded menu is set to its width), so what is shown is what
 * was placed; then boundedMenuPlacement. The list scrolls inside, title and footer stay.
 */
function positionMenu(menu, anchor, { placement, bounds, width }) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const box = boundsBox(bounds || assistantOf(anchor));
  if (bounds) {
    menu.style.minWidth = '0';
    menu.style.maxWidth = 'none';
    menu.style.width = `${boundedMenuWidth({ box, viewportWidth, width })}px`;
    menu.style.maxHeight = 'none';
  } else {
    menu.style.setProperty('--asst-dd-room', `${menuRoomWidth({ box, viewportWidth })}px`);
    menu.style.maxHeight = '';
  }
  menu.style.left = '0px';
  menu.style.top = '0px';
  // The sidepanel hugs the right screen edge: its menus grow leftward from the click point (or the
  // anchor's right edge for keyboard opens), as a bounded menu does; elsewhere a menu starts at its anchor.
  const inSidepanel = !!anchor.closest?.('.assistant-panel');
  const clicked = inSidepanel && _lastDown && anchor.contains(_lastDown.target) && performance.now() - _lastDown.at < 1500;
  const spot = boundedMenuPlacement({
    anchor: anchor.getBoundingClientRect(), box, viewportWidth, viewportHeight,
    width: menu.offsetWidth, menuHeight: menu.offsetHeight, placement,
    alignX: clicked ? _lastDown.x : null, alignLeft: !bounds && !inSidepanel,
    minHeight: bounds ? BOUNDED_MIN_HEIGHT : MENU_MIN_HEIGHT,
  });
  if (spot.maxHeight != null) menu.style.maxHeight = `${spot.maxHeight}px`;
  menu.style.left = `${spot.left}px`;
  menu.style.top = `${spot.top}px`;
  menu.dataset.placement = spot.up ? 'above' : 'below';
}

/** A row its menu's width cuts short (one-line label or description) keeps its words in a tooltip. */
function titleCutRows(menu) {
  for (const btn of menu.querySelectorAll('.asst-dd-item:not([title])')) {
    const parts = [...btn.querySelectorAll('.asst-dd-item-label, .asst-dd-item-desc')];
    if (parts.some(n => n.scrollWidth > n.clientWidth + 1)) btn.title = parts.map(n => n.textContent).filter(Boolean).join(' · ');
  }
}

/**
 * Open a popover next to `anchor`. Returns { el, close, list } or null.
 */
export function openMenu(anchor, opts = {}) {
  if (!anchor) return null;
  closeMenu();
  const {
    title = '', items = [], placement = 'auto', filter = false, width = 0, role = 'menu',
    label = '', className = '', onClose = null, filterPlaceholder = 'Filter…', focus = 'selected', zIndex = null,
  } = opts;
  const menu = el('div', `asst-dd-menu${className ? ` ${className}` : ''}`);
  if (Number.isFinite(Number(zIndex)) && Number(zIndex) > 0) menu.style.zIndex = String(Number(zIndex));
  menu.setAttribute('role', role);
  menu.id = `asst-menu-${++_uid}`;
  menu.tabIndex = -1;
  let heading = null;
  if (title) {
    heading = el('div', 'asst-dd-menu-title', title);
    heading.id = `${menu.id}-title`;
    menu.setAttribute('aria-labelledby', heading.id);
    menu.appendChild(heading);
  } else if (label) {
    menu.setAttribute('aria-label', label);
  }
  let filterInput = null;
  if (filter) {
    filterInput = document.createElement('input');
    filterInput.type = 'search';
    filterInput.className = 'asst-dd-input asst-dd-filter';
    filterInput.placeholder = filterPlaceholder;
    filterInput.setAttribute('aria-label', filterPlaceholder);
    filterInput.autocomplete = 'off';
    filterInput.spellcheck = false;
    menu.appendChild(filterInput);
  }
  const list = el('div', 'asst-dd-list');
  menu.appendChild(list);
  const activate = (item, node) => {
    if (item.keepOpen) { item.onSelect?.(item, node); return; }
    closeMenu({ restoreFocus: !!item.restoreFocus });
    item.onSelect?.(item, node);
  };
  if (opts.content) list.appendChild(opts.content);
  else buildItems(list, items, { role, onActivate: activate });
  // The footer stays under the list: only the list scrolls.
  let foot = null;
  const fillFooter = (footer) => {
    if (!foot) { foot = el('div', 'asst-dd-foot'); menu.appendChild(foot); }
    foot.replaceChildren();
    if (Array.isArray(footer) && footer.length) buildItems(foot, footer, { role, onActivate: activate });
    foot.hidden = !(Array.isArray(footer) && footer.length);
  };
  if (Array.isArray(opts.footer)) fillFooter(opts.footer);
  // `width`: at least that wide (exactly, with repositionOnResize), never wider than the room positionMenu sets.
  const capped = `min(${width}px, var(--asst-dd-room, calc(100vw - 16px)))`;
  if (width) menu.style.minWidth = capped;
  if (width && opts.repositionOnResize) menu.style.width = capped;
  document.body.appendChild(menu);
  const place = () => { positionMenu(menu, anchor, { placement, bounds: opts.bounds || null, width }); titleCutRows(menu); };
  place();

  if (filterInput) {
    filterInput.addEventListener('input', () => { applyMenuFilter(list, filterInput.value, opts.filterEmptyLabel); place(); });
  }

  const onDocDown = (e) => {
    if (!_open || _open.menu !== menu) return;
    if (menu.contains(e.target)) return;
    if (anchor.contains(e.target)) return; // the anchor's own click toggles
    closeMenu();
  };
  const onKey = (e) => {
    if (!_open || _open.menu !== menu) return;
    const target = e.target;
    const inInput = target?.classList?.contains('asst-dd-input');
    const nodes = focusables(menu);
    // On a row's action (item.action) the keys move from its row.
    const onAction = document.activeElement?.classList?.contains('asst-dd-item-action') && menu.contains(document.activeElement) ? document.activeElement : null;
    const idx = nodes.indexOf(onAction ? onAction.previousElementSibling : document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (typeof opts.onEscape === 'function' && opts.onEscape() === true) return;
      closeMenu({ restoreFocus: true });
      return;
    }
    if (role === 'dialog') {
      if (e.key === 'Tab') {
        const fields = [...menu.querySelectorAll('button, input')].filter(node => !node.disabled && !node.hidden);
        const index = fields.indexOf(document.activeElement);
        if (e.shiftKey && index <= 0) { e.preventDefault(); fields.at(-1)?.focus(); }
        else if (!e.shiftKey && (index < 0 || index === fields.length - 1)) { e.preventDefault(); fields[0]?.focus(); }
      }
      return; // native number/switch keys and Enter belong to the form
    }
    if (e.key === 'Tab') { closeMenu(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      if (!nodes.length) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = idx < 0 ? (dir > 0 ? 0 : nodes.length - 1) : (idx + dir + nodes.length) % nodes.length;
      setFocused(menu, nodes[next]);
      return;
    }
    if (!inInput && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Delete')) {
      const row = onAction ? null : document.activeElement?.closest?.('.asst-dd-item');
      const action = onAction || (row?.parentElement?.classList.contains('asst-dd-itemrow') ? row.nextElementSibling : null);
      if (action?.classList.contains('asst-dd-item-action')) {
        e.preventDefault(); e.stopPropagation();
        const main = action.previousElementSibling;
        if (e.key === 'ArrowLeft') { if (onAction) setFocused(menu, main); return; }
        if (!onAction) { setFocused(menu, main); try { action.focus({ preventScroll: true }); } catch { action.focus(); } }
        if (e.key === 'Delete') action.click();
        return;
      }
    }
    if ((e.key === 'Home' || e.key === 'End') && !inInput) {
      e.preventDefault(); e.stopPropagation();
      if (nodes.length) setFocused(menu, nodes[e.key === 'Home' ? 0 : nodes.length - 1]);
      return;
    }
    if (e.key === 'Enter' && inInput) {
      e.preventDefault(); e.stopPropagation();
      if (target === filterInput) {
        const first = nodes.find(n => n.classList.contains('asst-dd-item'));
        first?.click();
        return;
      }
      const value = target.value.trim();
      if (value) target._asstSubmit?.(value);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && !inInput) {
      if (onAction) { e.preventDefault(); e.stopPropagation(); onAction.click(); return; }
      const current = document.activeElement?.closest?.('.asst-dd-item');
      if (current && menu.contains(current)) { e.preventDefault(); e.stopPropagation(); current.click(); }
      return;
    }
    // Keep single-letter global keybinds out of an open menu.
    e.stopPropagation();
  };
  const onResize = () => (opts.repositionOnResize || opts.bounds ? place() : closeMenu());
  const onBlur = () => closeMenu();
  document.addEventListener('mousedown', onDocDown, true);
  const keyTarget = role === 'dialog' ? window : document;
  keyTarget.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onBlur);
  const cleanup = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    keyTarget.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onBlur);
  };

  _open = { menu, anchor, onClose, cleanup };
  if (anchor.getAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', menu.id);
  opts.onOpen?.(menu);

  const selected = list.querySelector('.asst-dd-item[data-checked="1"]:not([disabled])');
  const first = focusables(menu).find(n => n.classList.contains('asst-dd-item')) || focusables(menu)[0];
  if (filterInput && focus !== 'item') {
    if (selected) selected.classList.add('focused');
    try { filterInput.focus({ preventScroll: true }); } catch { filterInput.focus(); }
  } else {
    setFocused(menu, selected || first || null);
  }
  // Redraw in place (another view of the same menu): the anchor, the listeners and the focus stay in it.
  // `keepPlace` (fresher data for the same view, read in the background): the scroll position, the row the
  // keyboard is on and the filter's text and focus are left where the user had them.
  const update = (next = {}) => {
    if (!_open || _open.menu !== menu) return;
    const keep = next.keepPlace === true;
    const scrollBefore = list.scrollTop;
    const active = document.activeElement;
    const typing = !!active && active.classList?.contains('asst-dd-input') && menu.contains(active);
    const onRowId = !typing ? (menu.querySelector('.asst-dd-item.focused')?.dataset?.id ?? null) : null;
    if (typeof next.title === 'string' && heading) heading.textContent = next.title;
    if (Array.isArray(next.items)) {
      list.replaceChildren();
      buildItems(list, next.items, { role, onActivate: activate });
      if (filterInput?.value) applyMenuFilter(list, filterInput.value, opts.filterEmptyLabel);
      list.scrollTop = keep ? scrollBefore : 0;
    }
    if ('footer' in next) fillFooter(next.footer);
    place();
    if (keep && typing) {
      // The input keeps the caret; the row highlight follows the selection as it did when it opened.
      menu.querySelectorAll('.asst-dd-item.focused').forEach(n => n.classList.remove('focused'));
      list.querySelector('.asst-dd-item[data-checked="1"]:not([disabled])')?.classList.add('focused');
      return;
    }
    const keptRow = keep && onRowId != null ? [...menu.querySelectorAll('.asst-dd-item')].find(n => n.dataset.id === onRowId && !n.disabled) : null;
    const wanted = keptRow || (next.focus != null ? [...menu.querySelectorAll('.asst-dd-item')].find(n => n.dataset.id === String(next.focus) && !n.disabled) : null);
    if (keep && !keptRow && !menu.contains(document.activeElement)) return; // focus is elsewhere: not taken back
    setFocused(menu, wanted || list.querySelector('.asst-dd-item[data-checked="1"]:not([disabled])') || focusables(menu)[0] || null);
    if (keep) list.scrollTop = scrollBefore;
  };
  return { el: menu, list, close: closeMenu, reposition: place, update };
}

/** Toggle helper for anchor buttons: closes when this anchor's menu is open. */
export function toggleMenu(anchor, opts) {
  if (isMenuOpen(anchor)) { closeMenu(); return null; }
  return openMenu(anchor, opts);
}
