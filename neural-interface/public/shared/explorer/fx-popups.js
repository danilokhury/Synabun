// ═══════════════════════════════════════════
// SynaBun Neural Interface — File Explorer: what opens over the page
// ═══════════════════════════════════════════
//
// The context menu and the preview card (flyouts docked to the right of the
// panel, an arrow pointing at their row), the questions (confirm dialogs), and
// the line at the foot of the panel that says what happened.
// While one is open its keys are taken at the window, before anything in the
// page sees them: the whiteboard listens at the document in the capture phase
// and takes Escape, Delete and letters whenever the keyboard is not in a text
// field. Taken, not cancelled: a key reaches nothing in the page under the
// popup, and only the keys the popup itself acts on lose what the browser
// would do with them. Reload (F5, Ctrl+R) and the like stay the browser's.
// One flyout is open at a time; closed with the keyboard, it gives the
// keyboard back to where it was. One question is open at a time too: a second
// one answers the first with "given up" before it takes its place.
// No imports: the caller hands in the words.

const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];
const stroke = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

/** The glyph of a menu item, by its id (24 × 24, drawn with the row's colour). */
export const MENU_ICONS = {
  open: stroke('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  openKeep: stroke('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 11 17 15 13"/>'),
  openAsText: stroke('<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
  preview: stroke('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
  newFile: stroke('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/>'),
  newFolder: stroke('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>'),
  send: stroke('<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14z"/>'),
  sendTo: stroke('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  cut: stroke('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>'),
  copy: stroke('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  paste: stroke('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>'),
  duplicate: stroke('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/><line x1="14.5" y1="11.5" x2="14.5" y2="17.5"/><line x1="11.5" y1="14.5" x2="17.5" y2="14.5"/>'),
  copyPath: stroke('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  copyRelativePath: stroke('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  copyName: stroke('<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>'),
  rename: stroke('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  delete: stroke('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  reveal: stroke('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
  color: stroke('<circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="10.5" r="2.5"/><circle cx="8.5" cy="7.5" r="2.5"/><circle cx="6.5" cy="12.5" r="2.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.67 1.5-1.5 0-.39-.14-.74-.39-1.04-.24-.28-.37-.59-.37-.96 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.5-4.5-10-10-10z"/>'),
  expand: stroke('<polyline points="9 6 15 12 9 18"/>'),
  collapse: stroke('<polyline points="6 9 12 15 18 9"/>'),
  collapseChildren: stroke('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>'),
  collapseAll: stroke('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>'),
  expandAll: stroke('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'),
  refresh: stroke('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  changedOnly: stroke('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>'),
  sortBy: stroke('<path d="M3 6h7M3 12h5M3 18h3M16 4v16M12 16l4 4 4-4"/>'),
  back: stroke('<polyline points="15 6 9 12 15 18"/>'),
  check: stroke('<polyline points="20 6 9 17 4 12"/>'),
};

let _flyout = null;   // the open flyout: { close }
let _dialog = null;   // the open question: { giveUp, before }
const MENU_KEYS = new Set(['Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ']);
const CARD_KEYS = new Set(['Tab', 'Escape', 'ArrowLeft', 'ArrowRight']);
const plain = (event) => !event.ctrlKey && !event.metaKey && !event.altKey;

/** Close the menu or the preview that is open, if one is. */
export function closeFlyout(o) { _flyout?.close(o); }
export const isFlyoutOpen = () => !!_flyout;

// Put a flyout to the right of the panel with its arrow at `y`; over the panel when the window has no room there.
function dock(flyout, arrow, { panel, y }) {
  const frame = panel.getBoundingClientRect();
  const size = flyout.getBoundingClientRect();
  const fits = frame.right + 6 + size.width <= window.innerWidth - 8;
  const left = fits ? frame.right + 6 : Math.max(8, window.innerWidth - size.width - 8);
  const top = Math.max(8, Math.min(window.innerHeight - size.height - 8, y - size.height / 2));
  flyout.style.left = `${Math.round(left)}px`;
  flyout.style.top = `${Math.round(top)}px`;
  flyout.classList.toggle('fe-ctx-flyout--over', !fits);
  if (arrow) arrow.style.top = `${Math.round(Math.max(12, Math.min(size.height - 12, y - top)))}px`;
}

// What every flyout shares: one at a time, keys at the window, gone on a press outside, the keyboard handed back.
// `owns(event)` says whether a key is one the flyout acts on: only those are cancelled (on the way down, where
// `onKey` acts, and on the way up, where a button would otherwise take a Space as a click).
function mount(flyout, { row, onKey, owns, onClose }) {
  closeFlyout();
  const before = document.activeElement;
  let closed = false;
  const keys = (event) => {
    event.stopPropagation();
    if (!owns(event)) return;
    if (event.type === 'keydown') onKey(event);
    else event.preventDefault();
  };
  const outside = (event) => { if (!flyout.contains(event.target)) close({ refocus: false }); };
  const gone = () => close({ refocus: false });
  function close({ refocus = true } = {}) {
    if (closed) return;
    closed = true;
    if (_flyout === handle) _flyout = null;
    for (const type of KEY_EVENTS) window.removeEventListener(type, keys, true);
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', gone);
    window.removeEventListener('blur', gone);
    row?.classList.remove('fe-row--ctx-active');
    flyout.classList.remove('fe-ctx-flyout--in');
    flyout.classList.add('fe-ctx-flyout--out');
    setTimeout(() => flyout.remove(), 150);
    // The keyboard goes back to where it was, unless what was chosen took it somewhere (a name being typed, a question).
    const held = flyout.contains(document.activeElement) || document.activeElement === document.body || !document.activeElement;
    if (refocus && held && before?.isConnected) before.focus({ preventScroll: true });
    onClose?.();
  }
  const handle = { close, element: flyout };
  _flyout = handle;
  document.body.appendChild(flyout);
  row?.classList.add('fe-row--ctx-active');
  for (const type of KEY_EVENTS) window.addEventListener(type, keys, true);
  // Not the press that opened it.
  setTimeout(() => { if (!closed) document.addEventListener('pointerdown', outside, true); }, 0);
  window.addEventListener('resize', gone);
  window.addEventListener('blur', gone);
  requestAnimationFrame(() => flyout.classList.add('fe-ctx-flyout--in'));
  return handle;
}

/**
 * @typedef {object} MenuItem
 * @property {string} [id] @property {string} [label] @property {string} [keyLabel] its shortcut, as it is shown
 * @property {boolean} [danger] @property {boolean} [disabled] @property {string} [title] why it is disabled
 * @property {boolean} [checked] @property {boolean} [more] it opens another page of the menu
 * @property {boolean} [back] the row that leads back to the page before
 * @property {string} [swatch] a colour: drawn as a round swatch, in a row with the others
 * @property {boolean} [separator]
 */

/**
 * Open the context menu.
 * @param {object} o
 * @param {HTMLElement} o.panel the explorer panel (the menu docks to its right edge)
 * @param {HTMLElement | null} o.row the row it belongs to, or null for the empty space
 * @param {number} [o.y] where the arrow points when there is no row
 * @param {string} o.label its accessible name
 * @param {MenuItem[]} o.items
 * @param {boolean} [o.keyboard] opened with the keyboard: the first item has it from the start
 * @param {(item: MenuItem) => (MenuItem[] | void)} o.onSelect what an item does; a list it returns is shown as the
 *   menu's next page
 * @param {() => void} [o.onClose]
 */
export function openContextMenu({ panel, row, y = null, label, items, keyboard = false, onSelect, onClose }) {
  const flyout = document.createElement('div');
  flyout.className = 'fe-ctx-flyout';
  const arrow = document.createElement('div');
  arrow.className = 'fe-ctx-arrow';
  const menu = document.createElement('div');
  menu.className = 'fe-ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  menu.tabIndex = -1;
  flyout.append(arrow, menu);
  const at = row ? (() => { const box = row.getBoundingClientRect(); return box.top + box.height / 2; })() : y ?? window.innerHeight / 2;
  const pages = [];   // the pages left behind, for "back"
  let shown = [];
  let typed = '';
  let typedAt = 0;

  const stops = () => [...menu.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])')];
  const focusAt = (index) => { const list = stops(); if (list.length) list[(index + list.length) % list.length].focus({ preventScroll: true }); };

  function draw(list, { focusFirst = false } = {}) {
    shown = list;
    menu.textContent = '';
    let swatches = null;
    for (const item of list) {
      if (item.separator) {
        swatches = null;
        const line = document.createElement('div');
        line.className = 'fe-ctx-separator';
        line.setAttribute('role', 'separator');
        menu.append(line);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.dataset.id = item.id;
      if (item.swatch) {
        if (!swatches) { swatches = document.createElement('div'); swatches.className = 'fe-ctx-swatches'; swatches.setAttribute('role', 'group'); menu.append(swatches); }
        button.className = `fe-color-swatch${item.checked ? ' fe-color-swatch--active' : ''}`;
        button.style.background = item.swatch;
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', String(!!item.checked));
        button.setAttribute('aria-label', item.label);
        button.dataset.tooltip = item.label;
        swatches.append(button);
        continue;
      }
      swatches = null;
      button.className = `fe-ctx-item${item.danger ? ' fe-ctx-item--danger' : ''}`;
      const checkable = item.checked !== undefined;
      button.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
      if (checkable) button.setAttribute('aria-checked', String(!!item.checked));
      if (item.more) button.setAttribute('aria-haspopup', 'menu');
      if (item.disabled) { button.setAttribute('aria-disabled', 'true'); if (item.title) button.title = item.title; }
      const icon = document.createElement('span');
      icon.className = 'fe-ctx-icon';
      icon.innerHTML = (checkable ? (item.checked ? MENU_ICONS.check : '') : MENU_ICONS[item.back ? 'back' : item.icon || item.id]) || '';
      const text = document.createElement('span');
      text.className = 'fe-ctx-label';
      text.textContent = item.label;
      button.append(icon, text);
      if (item.keyLabel || item.more) {
        const key = document.createElement('span');
        key.className = 'fe-ctx-key';
        key.textContent = item.more ? '›' : item.keyLabel;
        key.setAttribute('aria-hidden', 'true');
        if (item.keyLabel && !item.more) button.setAttribute('aria-keyshortcuts', item.keyLabel);
        button.append(key);
      }
      menu.append(button);
    }
    dock(flyout, arrow, { panel, y: at });
    if (focusFirst) focusAt(0); else menu.focus({ preventScroll: true });
  }

  function choose(item) {
    if (!item || item.disabled) return;
    if (item.back) { const page = pages.pop(); if (page) draw(page, { focusFirst: true }); return; }
    const next = onSelect(item);
    if (Array.isArray(next)) { pages.push(shown); draw(next, { focusFirst: true }); return; }
    handle.close();
  }
  const itemOf = (node) => shown.find((item) => !item.separator && item.id === node?.dataset.id);

  menu.addEventListener('click', (event) => choose(itemOf(event.target.closest('[data-id]'))));
  // The row under the pointer is the one the keyboard is on: one highlight, not two.
  menu.addEventListener('pointermove', (event) => {
    const node = event.target.closest('[role^="menuitem"]:not([aria-disabled="true"])');
    if (node && node !== document.activeElement) node.focus({ preventScroll: true });
  });

  const handle = mount(flyout, {
    row,
    onClose,
    // The menu's own keys: moving, choosing, closing, and a letter typed for an item. With Ctrl, Cmd or Alt held a
    // key is the browser's (it still reaches nothing in the page).
    owns: (event) => !event.ctrlKey && !event.metaKey && !event.altKey && (MENU_KEYS.has(event.key) || event.key.length === 1),
    onKey(event) {
      const list = stops();
      const index = list.indexOf(document.activeElement);
      const { key } = event;
      event.preventDefault();
      if (key === 'Tab') { handle.close(); return; }
      if (key === 'Escape') { handle.close(); return; }
      if (key === 'ArrowDown') { focusAt(index + 1); return; }
      if (key === 'ArrowUp') { focusAt(index < 0 ? list.length - 1 : index - 1); return; }
      if (key === 'Home') { focusAt(0); return; }
      if (key === 'End') { focusAt(list.length - 1); return; }
      if (key === 'ArrowLeft') { if (pages.length) choose(shown.find((item) => item.back)); return; }
      if (key === 'ArrowRight') { const item = itemOf(document.activeElement); if (item?.more) choose(item); return; }
      if (key === 'Enter' || key === ' ') { choose(itemOf(document.activeElement)); return; }
      if (key.length === 1) {
        // A letter goes to the next item that starts with what was typed.
        const now = Date.now();
        typed = now - typedAt > 600 ? key.toLowerCase() : typed + key.toLowerCase();
        typedAt = now;
        const from = typed.length > 1 ? Math.max(0, index) : index + 1;
        for (let i = 0; i < list.length; i++) {
          const node = list[(from + i) % list.length];
          if ((itemOf(node)?.label || '').toLowerCase().startsWith(typed)) { node.focus({ preventScroll: true }); break; }
        }
      }
    },
  });
  draw(items, { focusFirst: keyboard });
  return handle;
}

/**
 * Open the card of a file that is not text: its picture when it is one, what it is, and what can be done with it.
 * @param {object} o
 * @param {HTMLElement} o.panel @param {HTMLElement | null} o.row @param {string} o.label its accessible name
 * @param {string} o.name @param {string} o.detail what it is and how large
 * @param {string | null} [o.imageUrl] @param {string} [o.imageAlt] @param {string} [o.imageFailed] said when the picture does not load
 * @param {{ label: string, run: () => void, keep?: boolean }[]} o.actions `keep`: the card stays open after it
 * @param {() => void} [o.onClose]
 */
export function openPreviewCard({ panel, row, label, name, detail, imageUrl = null, imageAlt = '', imageFailed = '', actions, onClose }) {
  const flyout = document.createElement('div');
  flyout.className = 'fe-ctx-flyout fe-preview';
  const arrow = document.createElement('div');
  arrow.className = 'fe-ctx-arrow';
  const card = document.createElement('div');
  card.className = 'fe-ctx-menu fe-preview-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', label);
  card.tabIndex = -1;
  const at = row ? (() => { const box = row.getBoundingClientRect(); return box.top + box.height / 2; })() : window.innerHeight / 2;
  const title = document.createElement('div');
  title.className = 'fe-preview-name';
  title.textContent = name;
  title.title = name;
  const meta = document.createElement('div');
  meta.className = 'fe-preview-detail';
  meta.textContent = detail;
  card.append(title);
  if (imageUrl) {
    const frame = document.createElement('div');
    frame.className = 'fe-preview-frame';
    const image = document.createElement('img');
    image.alt = imageAlt;
    image.decoding = 'async';
    image.addEventListener('load', () => {
      if (image.naturalWidth) meta.textContent = `${detail} · ${image.naturalWidth} × ${image.naturalHeight}`;
      dock(flyout, arrow, { panel, y: at });
    });
    image.addEventListener('error', () => { frame.textContent = imageFailed; frame.classList.add('fe-preview-frame--failed'); dock(flyout, arrow, { panel, y: at }); });
    image.src = imageUrl;
    frame.append(image);
    card.append(frame);
  }
  card.append(meta);
  const bar = document.createElement('div');
  bar.className = 'fe-preview-actions';
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fe-modal-btn fe-modal-cancel';
    button.textContent = action.label;
    button.addEventListener('click', () => { if (!action.keep) handle.close(); action.run(); });
    bar.append(button);
  }
  card.append(bar);
  flyout.append(arrow, card);
  const buttons = () => [...bar.querySelectorAll('button')];
  // Whatever makes the card another size (the picture arriving, a long name wrapping), it is put inside the
  // window again, with the margin the menu keeps.
  const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => dock(flyout, arrow, { panel, y: at })) : null;
  const handle = mount(flyout, {
    row,
    onClose() { sized?.disconnect(); onClose?.(); },
    // Enter and Space are the focused button's own; with no button focused they would act on nothing.
    owns: (event) => plain(event) && (CARD_KEYS.has(event.key) || ((event.key === 'Enter' || event.key === ' ') && !buttons().includes(document.activeElement))),
    onKey(event) {
      const { key } = event;
      event.preventDefault();
      if (key === 'Escape') { handle.close(); return; }
      if (key === 'Enter' || key === ' ') return;
      const list = buttons();
      const index = list.indexOf(document.activeElement);
      const step = key === 'ArrowLeft' || (key === 'Tab' && event.shiftKey) ? -1 : 1;
      list[(index + step + list.length) % list.length]?.focus();
    },
  });
  dock(flyout, arrow, { panel, y: at });
  sized?.observe(card);
  buttons()[0]?.focus({ preventScroll: true });
  return handle;
}

/**
 * Ask before something that cannot simply be taken back.
 * @param {object} o
 * @param {string} o.title @param {string[]} o.lines what will happen, a sentence per line
 * @param {string} o.confirmLabel @param {string} o.cancelLabel
 * @param {string} [o.altLabel] a third answer between the two
 * @param {boolean} [o.danger] the confirm button removes something: it is not where the keyboard starts
 * @returns {Promise<'confirm' | 'alt' | null>} null: given up (also when another question took its place)
 */
export function confirmDialog({ title, lines, confirmLabel, cancelLabel, altLabel = '', danger = false }) {
  return new Promise((resolve) => {
    closeFlyout({ refocus: false });
    // A question that is still open is given up through its own way out: its listeners go and its caller hears
    // "no". The keyboard goes back, in the end, to where it was before the first of them.
    const earlier = _dialog;
    earlier?.giveUp();
    // One that was answered a moment ago may still be fading out: it goes at once (two would share an id).
    document.getElementById('fe-dialog')?.remove();
    const before = earlier?.before || document.activeElement;
    const overlay = document.createElement('div');
    overlay.id = 'fe-dialog';
    overlay.className = 'fe-modal-overlay';
    const modal = document.createElement('div');
    modal.className = `fe-modal${danger ? '' : ' fe-modal--plain'}`;
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'fe-dialog-title');
    modal.setAttribute('aria-describedby', 'fe-dialog-body');
    const heading = document.createElement('div');
    heading.className = 'fe-modal-title';
    heading.id = 'fe-dialog-title';
    heading.textContent = title;
    const body = document.createElement('div');
    body.className = 'fe-modal-body';
    body.id = 'fe-dialog-body';
    for (const line of lines.filter(Boolean)) { const p = document.createElement('p'); p.textContent = line; body.append(p); }
    const bar = document.createElement('div');
    bar.className = 'fe-modal-actions';
    const button = (label, className, answer) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `fe-modal-btn ${className}`;
      node.textContent = label;
      node.addEventListener('click', () => done(answer));
      bar.append(node);
      return node;
    };
    const cancel = button(cancelLabel, 'fe-modal-cancel', null);
    if (altLabel) button(altLabel, 'fe-modal-cancel', 'alt');
    const confirm = button(confirmLabel, 'fe-modal-confirm', 'confirm');
    modal.append(heading, body, bar);
    overlay.append(modal);

    // No key reaches the page under the question; the ones it acts on (and only those) are cancelled.
    const keys = (event) => {
      event.stopPropagation();
      if (event.type !== 'keydown' || !plain(event)) return;
      const list = [...bar.querySelectorAll('button')];
      const index = list.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); done(null); return; }
      if (event.key === 'Tab' || event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const step = event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
        list[(index + step + list.length) % list.length].focus();
        return;
      }
      // Enter and Space are the focused button's own; with no button focused they would act on nothing.
      if ((event.key === 'Enter' || event.key === ' ') && index < 0) event.preventDefault();
    };
    let answered = false;
    function done(answer, { replaced = false } = {}) {
      if (answered) return;
      answered = true;
      if (_dialog === handle) _dialog = null;
      for (const type of KEY_EVENTS) window.removeEventListener(type, keys, true);
      overlay.classList.remove('fe-modal-overlay--in');
      // Another question is taking its place: it goes at once (two of them would share an id for a moment).
      if (replaced) overlay.remove();
      else {
        setTimeout(() => overlay.remove(), 150);
        if (before?.isConnected) before.focus({ preventScroll: true });
      }
      resolve(answer);
    }
    const handle = { before, giveUp: () => done(null, { replaced: true }) };
    _dialog = handle;
    overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) done(null); });
    for (const type of KEY_EVENTS) window.addEventListener(type, keys, true);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('fe-modal-overlay--in'));
    (danger ? cancel : confirm).focus({ preventScroll: true });
  });
}

/**
 * The line at the foot of the panel: what happened, and what can be done about it.
 * @param {HTMLElement} root #fe-notice @param {{ dismiss: string }} words
 */
export function createNotice(root, words) {
  let timer = 0;
  const text = root.querySelector('.fe-notice-text');
  const action = root.querySelector('.fe-notice-action');
  const close = root.querySelector('.fe-notice-close');
  let run = null;
  function clear() {
    clearTimeout(timer);
    root.hidden = true;
    run = null;
  }
  action.addEventListener('click', () => { const todo = run; clear(); todo?.(); });
  close.addEventListener('click', clear);
  close.setAttribute('aria-label', words.dismiss);
  return {
    /**
     * @param {string} message
     * @param {{ tone?: 'info' | 'ok' | 'error', action?: { label: string, run: () => void }, ms?: number }} [o] an error
     *   stays until it is dismissed or something else is said
     */
    show(message, { tone = 'info', action: todo = null, ms = tone === 'error' ? 0 : 6000 } = {}) {
      clearTimeout(timer);
      root.dataset.tone = tone;
      root.setAttribute('role', tone === 'error' ? 'alert' : 'status');
      text.textContent = message;
      text.title = message;
      run = todo?.run || null;
      action.hidden = !todo;
      action.textContent = todo?.label || '';
      root.hidden = false;
      if (ms > 0) timer = setTimeout(clear, ms);
    },
    clear,
    text: () => (root.hidden ? '' : text.textContent),
  };
}
