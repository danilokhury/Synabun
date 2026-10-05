// ═══════════════════════════════════════════
// SynaBun Assistant — shared popover menu
// ═══════════════════════════════════════════
// One body-level popover for every assistant menu (brain fields, model menu,
// sessions, "⋯", route mode). Appended to <body> so it escapes the viewport's
// paint containment; positioned with fixed coordinates next to its anchor and
// clamped to the window. Only one menu is open at a time.
//
// openMenu(anchor, { title, items, placement:'auto'|'above'|'below'|'prefer-below', filter,
//                    width, role:'menu'|'listbox', label, className, onClose,
//                    zIndex (a menu opened from a layer above the panel's own, e.g. Settings) })
// 'prefer-below' opens under the anchor whenever a usable list fits there (the
// menu scrolls inside that room), even when more room is above: a menu opened
// from Settings must not cover the Settings header. The panel's menus use 'auto'.
// Item kinds:
//   item (default)  { label, desc, icon, tag, disabled, danger, keywords, onSelect }
//   radio           { ...item, selected }            → menuitemradio / option
//   check           { ...item, checked }             → menuitemcheckbox
//   header          { label, icon, color, note }     → 10px uppercase group header
//   separator       {}                               (legacy `{ sep: true }` too)
//   info            { label, value }                 → non-interactive row
//   tag             { label }                        → non-interactive badge row
//   input           { placeholder, value, onSubmit } → inline text field
// Keys: ↑/↓ move, Home/End jump, Enter/Space activate, Esc closes (focus back
// to the anchor), Tab closes. The optional filter hides non-matching items and
// any group left empty.

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

function buildItems(list, items, { role, onActivate }) {
  const itemRole = role === 'listbox' ? 'option' : 'menuitem';
  for (const item of items || []) {
    const kind = itemKind(item);
    if (kind === 'separator') { list.appendChild(el('div', 'asst-dd-sep')).setAttribute('role', 'separator'); continue; }
    if (kind === 'header') {
      const h = el('div', 'asst-dd-group');
      h.setAttribute('role', 'presentation');
      h.innerHTML = `${item.icon ? `<span class="asst-icon" aria-hidden="true"${item.color ? ` style="color:${esc(item.color)}"` : ''}>${item.icon}</span>` : ''}<span class="asst-dd-group-label">${esc(item.label)}</span>${item.note ? `<span class="asst-dd-group-note">${esc(item.note)}</span>` : ''}`;
      list.appendChild(h);
      continue;
    }
    if (kind === 'info' || kind === 'tag') {
      const row = el('div', kind === 'tag' ? 'asst-dd-tagrow' : 'asst-dd-info');
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
      input._asstSubmit = (value) => { closeMenu(); spec.onSubmit?.(value); };
      list.appendChild(input);
      continue;
    }
    const btn = el('button', `asst-dd-item${item.danger ? ' danger' : ''}`);
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
      btn.setAttribute('role', itemRole);
    }
    if (item.disabled) btn.disabled = true;
    const lead = kind === 'radio' || kind === 'check'
      ? `<span class="asst-dd-check" aria-hidden="true">${checked ? ICON_CHECK : ''}</span>`
      : '';
    btn.innerHTML = `${lead}${item.icon ? `<span class="asst-icon" aria-hidden="true"${item.color ? ` style="color:${esc(item.color)}"` : ''}>${item.icon}</span>` : ''}<span class="asst-dd-item-main"><span class="asst-dd-item-label">${esc(item.label)}</span>${item.desc ? `<span class="asst-dd-item-desc">${esc(item.desc)}</span>` : ''}</span>${item.tag ? `<span class="asst-dd-item-tag">${esc(item.tag)}</span>` : ''}${item.shortcut ? `<kbd class="asst-dd-kbd">${esc(item.shortcut)}</kbd>` : ''}`;
    if (item.title) btn.title = item.title;
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
    list.appendChild(btn);
  }
  if (!list.querySelector('.asst-dd-item, .asst-dd-input, .asst-dd-info, .asst-dd-tagrow')) list.appendChild(el('div', 'asst-dd-empty', '—'));
}

/** Hide items that do not match `query`, then any header/separator left without items. */
export function applyMenuFilter(list, query) {
  const q = String(query || '').trim().toLowerCase();
  const rows = [...list.children];
  for (const row of rows) {
    if (row.classList.contains('asst-dd-item')) row.hidden = !!q && !row.dataset.search.includes(q);
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
  const hasItem = rows.some(r => !r.hidden && (r.classList.contains('asst-dd-item') || r.classList.contains('asst-dd-input')));
  if (q && !hasItem) {
    if (!empty) { empty = el('div', 'asst-dd-empty asst-dd-noresults', 'No matches'); list.appendChild(empty); }
    empty.hidden = false;
  } else if (empty) empty.hidden = true;
}

// 'prefer-below': the least room under the anchor that still holds a usable list.
const PREFER_BELOW_MIN = 220;

/**
 * Whether a menu opens above its anchor (pure; sizes in px). `above` / `below`:
 * the room on each side of the anchor.
 */
export function menuOpensAbove(placement, { anchorTop, anchorHeight, menuHeight, above, below, viewportHeight }) {
  if (placement === 'above') return menuHeight <= above || above >= below;
  if (placement === 'below') return !(menuHeight <= below || below >= above);
  if (placement === 'prefer-below') return below < Math.min(menuHeight, PREFER_BELOW_MIN) && above > below;
  if (anchorTop + anchorHeight / 2 > viewportHeight * 0.55) return menuHeight <= above || above >= below;
  return !(menuHeight <= below || below >= above);
}

function positionMenu(menu, anchor, placement) {
  const margin = 8;
  const gap = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = anchor.getBoundingClientRect();
  menu.style.maxHeight = '';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const mw = Math.min(menu.offsetWidth, vw - margin * 2);
  let mh = menu.offsetHeight;
  const above = r.top - gap - margin;
  const below = vh - r.bottom - gap - margin;
  const up = menuOpensAbove(placement, { anchorTop: r.top, anchorHeight: r.height, menuHeight: mh, above, below, viewportHeight: vh });
  const room = Math.max(96, up ? above : below);
  if (mh > room) { menu.style.maxHeight = `${Math.floor(room)}px`; mh = Math.floor(room); }
  let top = up ? r.top - gap - mh : r.bottom + gap;
  top = Math.max(margin, Math.min(top, vh - margin - mh));
  let left = r.left;
  if (anchor.closest('.assistant-panel')) {
    // Sidepanel hugs the right screen edge: grow leftward from the click point
    // (or the anchor's right edge for keyboard opens).
    const x = _lastDown && anchor.contains(_lastDown.target) && performance.now() - _lastDown.at < 1500 ? _lastDown.x : r.right;
    left = x - mw;
  }
  if (left + mw > vw - margin) left = vw - margin - mw;
  left = Math.max(margin, left);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.maxWidth = `${vw - margin * 2}px`;
  menu.dataset.placement = up ? 'above' : 'below';
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
  if (title) {
    const heading = el('div', 'asst-dd-menu-title', title);
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
  buildItems(list, items, { role, onActivate: activate });
  if (width) menu.style.minWidth = `${width}px`;
  document.body.appendChild(menu);
  positionMenu(menu, anchor, placement);

  if (filterInput) {
    filterInput.addEventListener('input', () => { applyMenuFilter(list, filterInput.value); positionMenu(menu, anchor, placement); });
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
    const idx = nodes.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu({ restoreFocus: true }); return; }
    if (e.key === 'Tab') { closeMenu(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      if (!nodes.length) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = idx < 0 ? (dir > 0 ? 0 : nodes.length - 1) : (idx + dir + nodes.length) % nodes.length;
      setFocused(menu, nodes[next]);
      return;
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
      const current = document.activeElement?.closest?.('.asst-dd-item');
      if (current && menu.contains(current)) { e.preventDefault(); e.stopPropagation(); current.click(); }
      return;
    }
    // Keep single-letter global keybinds out of an open menu.
    e.stopPropagation();
  };
  const onResize = () => closeMenu();
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onResize);
  const cleanup = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onResize);
  };

  _open = { menu, anchor, onClose, cleanup };
  if (anchor.getAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', menu.id);

  const selected = list.querySelector('.asst-dd-item[data-checked="1"]:not([disabled])');
  const first = focusables(menu).find(n => n.classList.contains('asst-dd-item')) || focusables(menu)[0];
  if (filterInput && focus !== 'item') {
    if (selected) selected.classList.add('focused');
    try { filterInput.focus({ preventScroll: true }); } catch { filterInput.focus(); }
  } else {
    setFocused(menu, selected || first || null);
  }
  return { el: menu, list, close: closeMenu, reposition: () => positionMenu(menu, anchor, placement) };
}

/** Toggle helper for anchor buttons: closes when this anchor's menu is open. */
export function toggleMenu(anchor, opts) {
  if (isMenuOpen(anchor)) { closeMenu(); return null; }
  return openMenu(anchor, opts);
}
