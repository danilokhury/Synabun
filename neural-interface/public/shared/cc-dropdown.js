// The app's custom dropdown (DESIGN.md "Settings custom dropdown", `.cc-dropdown`): a hidden
// <input id> holds the value, a trigger button shows the choice, a menu lists the choices.
// settings-kit.js dropdown() writes the same markup for Settings; this module writes it with its
// ARIA and drives every dropdown under a root from one set of listeners, so markup drawn again
// with innerHTML needs no wiring of its own.
//
// Every dropdown in SynaBun is this one: a native <select> is not allowed (tests/no-native-select.test.mjs).
// Adding one, as the Schedules window (ui-schedules-studio.js) does:
//   1. Markup: dropdownHTML(id, [{ value, label, selected }], { labelledBy }); in Settings, settings-kit.js dropdown().
//   2. Wiring: wireDropdowns(container, { signal }) once; markup drawn later needs nothing more.
//   3. Reading: the hidden input's `.value`, and its `change` event (it bubbles), as with a <select>.
//   4. Changing: setDropdownItems(input, entries), setDropdownValue(input, value), setDropdownDisabled(input, on).
//   5. Focusing it or marking it invalid: controlOf(input) is its trigger.
//
// To the code around it, it reads like a <select>: the input's `.value` is the choice, and a
// choice the user makes fires `input` and `change` on the input (bubbling). Choices are
// `{ value, label, selected, disabled }` (labels are text), or `{ group, options }` for a heading.
// The chosen one is the last marked `selected`, else the first that is not disabled: a <select>'s
// rule, so a list rebuilt from saved data shows what was saved. setDropdownItems() is
// `select.innerHTML = …`, setDropdownValue() is `select.value = …`; neither fires an event.
//
// Keyboard and ARIA are the WAI-ARIA select-only combobox: the focus stays on the trigger and the
// highlighted option is its aria-activedescendant. Enter, Space or an arrow opens; arrows, Home,
// End, Page Up/Down and typing move; Enter or Space chooses; Escape closes without a change; Tab
// closes and moves on, the choice as it was. An open menu is placed `fixed` against its trigger,
// so a scrolling pane never cuts it off, and kept inside the box that clips it (a window).

import { placementArea } from './app-frame.js';

const ARROW = '<svg class="cc-dropdown-arrow" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const GAP = 4;          // between the trigger and its menu
const EDGE = 6;         // the least room left between a menu and the edge of what clips it
const PAGE = 10;        // options a Page Up/Down moves
const TYPE_PAUSE = 500; // ms between keys that still extend a type-ahead search

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// ── What decides (no DOM) ──

/** The options of a list of entries, headings left out, in their order. */
export function flatOptions(entries) {
  const out = [];
  for (const entry of entries || []) {
    if (entry && Array.isArray(entry.options)) out.push(...entry.options.filter(Boolean));
    else if (entry) out.push(entry);
  }
  return out;
}

/** The chosen option as a <select> picks it: the last marked selected, else the first enabled; -1 for none. */
export function chosenIndex(options) {
  let last = -1;
  options.forEach((option, i) => { if (option.selected) last = i; });
  return last >= 0 ? last : options.findIndex(option => !option.disabled);
}

/** The first or last option that is not disabled; -1 for none. */
export function edgeIndex(options, which) {
  if (which === 'first') return options.findIndex(option => !option.disabled);
  for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
  return -1;
}

/** `steps` enabled options away from `from` (negative: up), stopping at the ends. From none, the first or last. */
export function stepIndex(options, from, steps) {
  if (from < 0 || from >= options.length) return edgeIndex(options, steps < 0 ? 'last' : 'first');
  const dir = Math.sign(steps) || 1;
  let left = Math.abs(steps) || 1;
  let found = from;
  for (let i = from + dir; i >= 0 && i < options.length; i += dir) {
    if (options[i].disabled) continue;
    found = i;
    if (--left === 0) break;
  }
  return found;
}

/**
 * Type-ahead: the option whose label starts with what was typed, searching on from the highlighted
 * one and round. One letter typed again moves on to the next option with that letter, as a <select> does.
 */
export function matchIndex(options, typed, from = -1) {
  const query = String(typed || '').toLocaleLowerCase();
  if (!query) return -1;
  const repeated = [...query].every(c => c === query[0]);
  const needle = repeated ? query[0] : query;
  const n = options.length;
  const start = repeated ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    const option = options[i];
    if (!option.disabled && String(option.label ?? '').trim().toLocaleLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/** Multi-choice values in menu order. Disabled selected rows are mandatory. */
export function multipleValues(options) {
  const exclusive = options.find(o => o.selected && o.exclusive && !o.scope);
  if (exclusive) return [String(exclusive.value ?? '')];
  const scoped = new Set(options.filter(o => o.selected && o.exclusive && o.scope).map(o => o.scope));
  return options.filter(o => o.selected && (!scoped.has(o.scope) || o.exclusive)).map(o => String(o.value ?? ''));
}

/** Exclusive rows may apply globally (inheritance) or within a named section. */
export function toggleMultiple(options, values, index) {
  const option = options[index];
  if (!option || option.disabled) return [...values];
  if (option.exclusive && !option.scope) return [String(option.value ?? '')];
  const selected = new Set(values);
  for (const row of options) {
    if ((row.exclusive && !row.scope) || (option.exclusive && row.scope === option.scope) || (!option.exclusive && row.exclusive && row.scope === option.scope)) selected.delete(String(row.value ?? ''));
  }
  const value = String(option.value ?? '');
  if (option.exclusive) selected.add(value);
  else if (selected.has(value)) selected.delete(value); else selected.add(value);
  return multipleValues(options.map(row => ({ ...row, selected: selected.has(String(row.value ?? '')) || (!option.exclusive && row.disabled && row.selected) })));
}

const multipleText = (options, values) => options.filter(o => values.includes(String(o.value ?? '')))
  .map(o => o.label).join(', ');

// ── Markup ──

function optionHTML(id, option, index, chosen) {
  const label = String(option.label ?? '');
  const active = Array.isArray(chosen) ? (chosen.includes(String(option.value ?? '')) || (option.automatic && option.selected)) : index === chosen;
  return `<div class="cc-dropdown-item${active ? ' active' : ''}" id="${esc(id)}-opt-${index}" role="option" aria-selected="${active}"`
    + `${option.disabled ? ' aria-disabled="true"' : ''} data-value="${esc(option.value ?? '')}" data-index="${index}"${option.exclusive ? ' data-exclusive="true"' : ''}${option.scope ? ` data-scope="${esc(option.scope)}"` : ''}${option.automatic ? ' data-automatic="true"' : ''} data-label="${esc(label)}" title="${esc(option.caption || label)}">${Array.isArray(chosen) ? '<span class="cc-dropdown-check" aria-hidden="true"></span>' : ''}<span>${esc(label)}${option.caption ? `<small class="cc-dropdown-caption">${esc(option.caption)}</small>` : ''}</span></div>`;
}

/** The menu's options (and headings) for `entries`, the `chosen` index marked. */
export function menuHTML(id, entries, chosen = chosenIndex(flatOptions(entries))) {
  let index = 0;
  let group = 0;
  return (entries || []).filter(Boolean).map((entry) => {
    if (!Array.isArray(entry.options)) return optionHTML(id, entry, index++, chosen);
    const headId = `${id}-grp-${group++}`;
    const options = entry.options.filter(Boolean).map(option => optionHTML(id, option, index++, chosen)).join('');
    return `<div class="cc-dropdown-optgroup" role="group" aria-labelledby="${esc(headId)}"><div class="cc-dropdown-group" id="${esc(headId)}" role="presentation">${esc(entry.group ?? '')}</div>${options}</div>`;
  }).join('');
}

/**
 * A dropdown: the hidden input (`id`, with `inputAttrs`) and the `.cc-dropdown` it belongs to.
 * Name it with `labelledBy` (the id of its visible label) or `label`. `classes` and `attrs` go on
 * the `.cc-dropdown`.
 */
export function dropdownHTML(id, entries, { classes = '', labelledBy = '', label = '', attrs = '', inputAttrs = '', disabled = false, multiple = false, summary = '' } = {}) {
  const options = flatOptions(entries);
  const chosen = multiple ? multipleValues(options) : chosenIndex(options);
  const current = chosen >= 0 ? options[chosen] : null;
  const name = labelledBy ? ` aria-labelledby="${esc(labelledBy)}"` : label ? ` aria-label="${esc(label)}"` : '';
  const text = multiple ? (summary || multipleText(options, chosen)) : String(current?.label ?? '');
  return `<input type="hidden" id="${esc(id)}" value="${esc(multiple ? chosen.join(',') : current?.value ?? '')}"${disabled ? ' disabled' : ''}${inputAttrs ? ` ${inputAttrs}` : ''}>`
    + `<div class="cc-dropdown${classes ? ` ${classes}` : ''}${disabled ? ' disabled' : ''}" data-for="${esc(id)}"${multiple ? ' data-multiple="true"' : ''}${attrs ? ` ${attrs}` : ''}>`
    + `<button type="button" class="cc-dropdown-trigger" id="${esc(id)}-trigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="${esc(id)}-menu"${name}${disabled ? ' disabled' : ''}>`
    + `<span class="cc-dropdown-value" title="${esc(text)}">${esc(text)}</span>${ARROW}</button>`
    + `<div class="cc-dropdown-menu" id="${esc(id)}-menu" role="listbox"${multiple ? ' aria-multiselectable="true"' : ''}${name} tabindex="-1">${menuHTML(id, entries, chosen)}</div>`
    + '</div>';
}

// ── The DOM: finding the parts ──

const partsOf = (dd) => ({
  trigger: dd.querySelector(':scope > .cc-dropdown-trigger'),
  menu: dd.querySelector(':scope > .cc-dropdown-menu'),
  label: dd.querySelector(':scope > .cc-dropdown-trigger .cc-dropdown-value'),
  input: dd.dataset.for ? document.getElementById(dd.dataset.for) : null,
});
const itemsOf = (dd) => [...(partsOf(dd).menu?.querySelectorAll('.cc-dropdown-item') || [])];
const optionsOf = (items) => items.map(el => ({ value: el.dataset.value ?? '', label: el.dataset.label ?? el.textContent, disabled: el.getAttribute('aria-disabled') === 'true', exclusive: el.dataset.exclusive === 'true', scope: el.dataset.scope || undefined, selected: el.classList.contains('active') }));
const highlightedOf = (items) => items.findIndex(el => el.classList.contains('highlight'));
const chosenOf = (items) => items.findIndex(el => el.classList.contains('active'));
const isOpen = (dd) => !!dd?.classList.contains('open');

/** The `.cc-dropdown` of a hidden input, or null. */
export function dropdownOf(input) {
  if (!input?.id) return null;
  const next = input.nextElementSibling;
  if (next?.classList.contains('cc-dropdown') && next.dataset.for === input.id) return next;
  return document.querySelector(`.cc-dropdown[data-for="${CSS.escape(input.id)}"]`);
}

/** What takes the focus for a field: a dropdown's trigger for its hidden input, else the element itself. */
export function controlOf(el) {
  const dd = el && el.type === 'hidden' ? dropdownOf(el) : null;
  return (dd && partsOf(dd).trigger) || el;
}

// Markup written by settings-kit.js dropdown() has no roles or ids: they are added when it opens.
function ensureAria(dd) {
  const { trigger, menu, input } = partsOf(dd);
  const base = input?.id || dd.dataset.for || 'cc-dropdown';
  if (!trigger.hasAttribute('role')) trigger.setAttribute('role', 'combobox');
  if (!menu.id) menu.id = `${base}-menu`;
  trigger.setAttribute('aria-controls', menu.id);
  if (!menu.hasAttribute('role')) menu.setAttribute('role', 'listbox');
  itemsOf(dd).forEach((el, i) => {
    if (!el.id) el.id = `${base}-opt-${i}`;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', String(el.classList.contains('active')));
  });
}

// ── Choosing, opening, closing ──

function showChosen(dd, index) {
  const { label, input } = partsOf(dd);
  const items = itemsOf(dd);
  items.forEach((el, i) => {
    el.classList.toggle('active', i === index);
    el.setAttribute('aria-selected', String(i === index));
  });
  const item = items[index];
  if (input) input.value = item ? item.dataset.value ?? '' : '';
  if (label) {
    label.textContent = item ? item.textContent : '';
    label.title = label.textContent;
  }
}

function showMultiple(dd, values) {
  const { label, input } = partsOf(dd);
  const items = itemsOf(dd);
  items.forEach(el => {
    const active = values.includes(el.dataset.value ?? '') || el.dataset.automatic === 'true';
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', String(active));
  });
  if (input) input.value = values.join(',');
  if (label) {
    label.textContent = multipleText(optionsOf(items), values);
    label.title = label.textContent;
  }
}

function highlight(dd, index) {
  const { trigger, menu } = partsOf(dd);
  const items = itemsOf(dd);
  items.forEach((el, i) => el.classList.toggle('highlight', i === index));
  const item = items[index];
  if (!item) { trigger?.removeAttribute('aria-activedescendant'); return; }
  trigger?.setAttribute('aria-activedescendant', item.id);
  // The menu scrolls itself; scrollIntoView would also move the panes and the window behind it.
  const box = menu.getBoundingClientRect();
  const row = item.getBoundingClientRect();
  if (row.top < box.top + menu.clientTop) menu.scrollTop -= box.top + menu.clientTop - row.top;
  else if (row.bottom > box.top + menu.clientTop + menu.clientHeight) menu.scrollTop += row.bottom - (box.top + menu.clientTop + menu.clientHeight);
}

// What a fixed menu is placed against and cut off by: the nearest ancestor that is a containing
// block for fixed boxes (a transform, a filter, containment: a floating window), else the viewport.
function fixedContainer(el) {
  for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none'
      || (cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none')
      || /paint|layout|strict|content/.test(cs.contain || '') || (cs.containerType && cs.containerType !== 'normal')
      || /transform|perspective|filter/.test(cs.willChange || '')) return node;
  }
  return null;
}

function place(dd) {
  const { trigger, menu } = partsOf(dd);
  const style = menu.style;
  Object.assign(style, { position: 'fixed', left: '0px', top: '0px', right: 'auto', bottom: 'auto', width: 'auto', maxHeight: 'none', minWidth: '0px', maxWidth: 'none' });
  const origin = menu.getBoundingClientRect(); // where the containing block's (0, 0) is on screen
  const t = trigger.getBoundingClientRect();
  // The app frame for a trigger inside it (app-frame.js), else the window; then whatever clips the menu
  const area = placementArea(t.left + t.width / 2, t.top + t.height / 2);
  let room = { left: area.left, top: area.top, right: area.right, bottom: area.bottom };
  const box = fixedContainer(dd);
  if (box) {
    const cs = getComputedStyle(box);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = box.getBoundingClientRect();
      room = { left: Math.max(room.left, r.left), top: Math.max(room.top, r.top), right: Math.min(room.right, r.right), bottom: Math.min(room.bottom, r.bottom) };
    }
  }
  room = { left: room.left + EDGE, top: room.top + EDGE, right: room.right - EDGE, bottom: room.bottom - EDGE };
  const roomWidth = Math.max(0, room.right - room.left);
  style.maxWidth = `${roomWidth}px`;
  style.minWidth = `${Math.min(t.width, roomWidth)}px`;
  const height = menu.offsetHeight;
  const below = room.bottom - t.bottom - GAP;
  const above = t.top - GAP - room.top;
  const down = height <= below || below >= above;
  const space = Math.max(0, down ? below : above);
  if (height > space) style.maxHeight = `${space}px`;
  const shown = Math.min(height, space);
  const width = menu.offsetWidth;
  const left = Math.max(room.left, Math.min(t.left, room.right - width));
  const top = down ? t.bottom + GAP : t.top - GAP - shown;
  style.left = `${Math.round(left - origin.left)}px`;
  style.top = `${Math.round(top - origin.top)}px`;
  dd.classList.toggle('drop-up', !down);
  dd._ccPlacedAt = { left: t.left, top: t.top };
}

// Has the trigger moved since its menu was placed (a pane scrolled under it)?
function moved(dd) {
  const at = dd._ccPlacedAt;
  const now = partsOf(dd).trigger?.getBoundingClientRect();
  return !at || !now || Math.abs(now.left - at.left) > 1 || Math.abs(now.top - at.top) > 1;
}

function open(dd, index = null) {
  const { trigger } = partsOf(dd);
  if (!trigger || trigger.disabled || dd.classList.contains('disabled')) return;
  for (const other of document.querySelectorAll('.cc-dropdown.open')) if (other !== dd) close(other);
  ensureAria(dd);
  dd._ccBefore = partsOf(dd).input?.value;
  dd._ccBeforeLabel = partsOf(dd).label?.textContent;
  dd._ccBeforeMenu = partsOf(dd).menu?.innerHTML;
  dd.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  partsOf(dd).input?.dispatchEvent(new Event('cc-dropdown-open', { bubbles: true }));
  if (document.activeElement !== trigger) trigger.focus({ preventScroll: true });
  place(dd);
  const items = itemsOf(dd);
  const options = optionsOf(items);
  const chosen = chosenOf(items);
  highlight(dd, index ?? (chosen >= 0 && !options[chosen].disabled ? chosen : edgeIndex(options, 'first')));
}

function close(dd, { focus = false, cancel = false } = {}) {
  const { trigger, menu, input, label } = partsOf(dd);
  const changed = isOpen(dd) && dd.dataset.multiple === 'true' && input && input.value !== dd._ccBefore;
  if (cancel && changed) {
    if (menu && dd._ccBeforeMenu != null) menu.innerHTML = dd._ccBeforeMenu;
    showMultiple(dd, dd._ccBefore === '' ? [''] : dd._ccBefore.split(','));
    if (label) { label.textContent = dd._ccBeforeLabel; label.title = label.textContent; }
  }
  dd.classList.remove('open', 'drop-up');
  trigger?.setAttribute('aria-expanded', 'false');
  trigger?.removeAttribute('aria-activedescendant');
  for (const el of itemsOf(dd)) el.classList.remove('highlight');
  menu?.removeAttribute('style');
  dd._ccPlacedAt = null;
  if (focus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  if (changed && !cancel) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/** The user's choice: shown, the menu closed, the focus on the trigger, then `input` and `change` when it changed. */
function choose(dd, index) {
  const items = itemsOf(dd);
  const item = items[index];
  const { input } = partsOf(dd);
  if (!item || item.getAttribute('aria-disabled') === 'true') { close(dd, { focus: true }); return; }
  if (dd.dataset.multiple === 'true') {
    showMultiple(dd, toggleMultiple(optionsOf(items), items.filter(el => el.classList.contains('active')).map(el => el.dataset.value), index));
    input?.dispatchEvent(new Event('cc-dropdown-draft', { bubbles: true }));
    highlight(dd, index);
    return;
  }
  const changed = !!input && input.value !== (item.dataset.value ?? '');
  showChosen(dd, index);
  close(dd, { focus: true });
  // After the focus is back: a listener that draws the form again finds the trigger focused.
  if (changed) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// ── What the code around it calls ──

/** `select.innerHTML = …`: new choices; the chosen one by the <select> rule; an open menu stays open. No event. */
export function setDropdownItems(input, entries) {
  const dd = dropdownOf(input);
  if (!dd) return;
  const { menu } = partsOf(dd);
  const wasOpen = isOpen(dd);
  const before = wasOpen ? itemsOf(dd)[highlightedOf(itemsOf(dd))]?.dataset.value : undefined;
  const options = flatOptions(entries);
  const multiple = dd.dataset.multiple === 'true';
  const chosen = multiple ? multipleValues(options) : chosenIndex(options);
  menu.innerHTML = menuHTML(input.id, entries, chosen);
  if (multiple) showMultiple(dd, chosen); else showChosen(dd, chosen);
  if (!wasOpen) return;
  place(dd);
  const items = itemsOf(dd);
  const again = before === undefined ? -1 : items.findIndex(el => el.dataset.value === before);
  highlight(dd, again >= 0 ? again : chosenOf(items));
}

/** `select.value = …`: the first choice with that value, or none (the value is then ''). No event. */
export function setDropdownValue(input, value) {
  const dd = dropdownOf(input);
  if (!dd) { if (input) input.value = value ?? ''; return; }
  if (dd.dataset.multiple === 'true') {
    showMultiple(dd, Array.isArray(value) ? value.map(String) : String(value ?? '').split(','));
    return;
  }
  showChosen(dd, itemsOf(dd).findIndex(el => el.dataset.value === String(value ?? '')));
}

/** `select.disabled = …`: the input, the trigger and the look. A disabled dropdown closes. */
export function setDropdownDisabled(input, disabled) {
  const dd = dropdownOf(input);
  if (input) input.disabled = !!disabled;
  if (!dd) return;
  if (disabled && isOpen(dd)) close(dd, { cancel: true });
  dd.classList.toggle('disabled', !!disabled);
  const { trigger } = partsOf(dd);
  if (trigger) trigger.disabled = !!disabled;
}

/** Closes every open dropdown under `root`; true when one was open. `focus` puts the focus back on its trigger. */
export function closeDropdowns(root = document, { focus = false, cancel = false } = {}) {
  const open = [...root.querySelectorAll('.cc-dropdown.open')];
  for (const dd of open) close(dd, { focus, cancel });
  return open.length > 0;
}

/**
 * Drives every `.cc-dropdown` under `root`, now and drawn later. `signal` (an AbortSignal) takes
 * the listeners off again, the document's and the window's too.
 */
export function wireDropdowns(root, { signal } = {}) {
  const on = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal });
  let typed = '';
  let typedAt = 0;
  let swallowSpaceUp = false;

  const typeAhead = (dd, char) => {
    const now = Date.now();
    typed = (now - typedAt > TYPE_PAUSE ? '' : typed) + char;
    typedAt = now;
    const items = itemsOf(dd);
    const index = matchIndex(optionsOf(items), typed, highlightedOf(items));
    if (index >= 0) highlight(dd, index);
  };
  const typing = () => !!typed && Date.now() - typedAt <= TYPE_PAUSE;
  // Each opening starts a search of its own: letters typed before it closed do not carry over.
  const show = (dd, index) => { typed = ''; open(dd, index); };
  const printable = (e) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ';

  on(root, 'click', (e) => {
    const item = e.target.closest?.('.cc-dropdown-item');
    if (item && root.contains(item)) {
      const dd = item.closest('.cc-dropdown');
      if (item.getAttribute('aria-disabled') !== 'true') choose(dd, itemsOf(dd).indexOf(item));
      return;
    }
    const trigger = e.target.closest?.('.cc-dropdown-trigger');
    if (!trigger || !root.contains(trigger)) return;
    const dd = trigger.closest('.cc-dropdown');
    if (isOpen(dd)) close(dd, { focus: true }); else show(dd);
  });

  // The focus stays on the trigger while a choice is clicked.
  on(root, 'mousedown', (e) => { if (e.target.closest?.('.cc-dropdown-menu')) e.preventDefault(); });
  on(root, 'mouseover', (e) => {
    const item = e.target.closest?.('.cc-dropdown-item');
    if (!item || item.getAttribute('aria-disabled') === 'true') return;
    const dd = item.closest('.cc-dropdown');
    if (isOpen(dd)) highlight(dd, itemsOf(dd).indexOf(item));
  });

  on(root, 'keydown', (e) => {
    const trigger = e.target.closest?.('.cc-dropdown-trigger');
    if (!trigger || !root.contains(trigger) || trigger.disabled) return;
    const dd = trigger.closest('.cc-dropdown');
    const items = itemsOf(dd);
    const options = optionsOf(items);
    const current = highlightedOf(items);
    if (!isOpen(dd)) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        if (e.key === ' ') swallowSpaceUp = true;
        show(dd);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        show(dd, edgeIndex(options, e.key === 'Home' ? 'first' : 'last'));
      } else if (printable(e)) {
        e.preventDefault();
        show(dd);
        typeAhead(dd, e.key);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        if (e.altKey && e.key === 'ArrowUp') choose(dd, current);
        else highlight(dd, stepIndex(options, current, e.key === 'ArrowDown' ? 1 : -1));
        break;
      case 'PageDown':
      case 'PageUp':
        e.preventDefault();
        highlight(dd, stepIndex(options, current, e.key === 'PageDown' ? PAGE : -PAGE));
        break;
      case 'Home':
      case 'End':
        e.preventDefault();
        highlight(dd, edgeIndex(options, e.key === 'Home' ? 'first' : 'last'));
        break;
      case 'Enter':
        e.preventDefault();
        choose(dd, current);
        break;
      case ' ':
        e.preventDefault();
        swallowSpaceUp = true;
        if (typing()) typeAhead(dd, ' '); else choose(dd, current);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(dd, { focus: true, cancel: true });
        break;
      case 'Tab':
        close(dd); // the focus moves on as usual; the choice stays as it was
        break;
      default:
        if (printable(e)) { e.preventDefault(); typeAhead(dd, e.key); }
    }
  });
  // A Space that opened or chose must not also click the trigger when it is let go.
  on(root, 'keyup', (e) => {
    if (e.key === ' ' && swallowSpaceUp) { swallowSpaceUp = false; e.preventDefault(); }
  });

  on(root, 'focusout', (e) => {
    const dd = e.target.closest?.('.cc-dropdown');
    if (dd && isOpen(dd) && !dd.contains(e.relatedTarget)) close(dd);
  });
  on(document, 'pointerdown', (e) => {
    for (const dd of root.querySelectorAll('.cc-dropdown.open')) if (!dd.contains(e.target)) close(dd);
  }, { capture: true });
  // A pane that scrolls the trigger away from its menu closes the menu. A scroll event arrives a frame
  // late, so one from before the menu opened (a click that first scrolled its trigger into view)
  // finds the trigger where the menu was placed, and is let be.
  on(document, 'scroll', (e) => {
    for (const dd of root.querySelectorAll('.cc-dropdown.open')) {
      const target = e.target === document ? document.documentElement : e.target;
      if (!partsOf(dd).menu.contains(target) && target.contains?.(dd) && moved(dd)) close(dd);
    }
  }, { capture: true });
  on(window, 'resize', () => closeDropdowns(root));
}
