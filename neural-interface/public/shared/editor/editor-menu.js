// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: menus
// ═══════════════════════════════════════════
//
// The one popup of the editor panel: a tab's menu, the status bar's lists
// (language, indentation, line ending), the View menu, the command palette and
// go-to-file. A list of actions, optionally under a search field; arrows,
// Home / End, Enter and Escape work it, and its keys never reach the app's
// shortcuts. They are taken at the window, before anything in the page sees
// them: other parts of the app listen for keys at the document in the capture
// phase (the whiteboard takes Escape there whenever the keyboard is not in a
// text field), and a listener on the menu itself would come after those.
// One is open at a time; closed with the keyboard, it gives the keyboard back
// to where it was. Its look is `.fe-editor-menu` in styles.css (the menu
// treatment of DESIGN.md).
// No imports: the caller hands in the words.

let _current = null;
const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];

/** Close the open menu, if there is one. */
export function closeEditorMenu() {
  _current?.close();
}

/**
 * @typedef {object} EditorMenuItem
 * @property {string} [id]
 * @property {string} [label]
 * @property {string} [hint] muted words after the label
 * @property {boolean} [checked] the one in force (shown with a check)
 * @property {boolean} [toggle] `checked` is a switch of its own, not one choice among the others
 * @property {boolean} [disabled]
 * @property {boolean} [separator] a line between groups; takes no other field
 */

/**
 * Open a menu.
 * @param {object} o
 * @param {HTMLElement} o.host the element it is added to (the editor panel: its variables and its focus ring apply)
 * @param {HTMLElement} [o.anchor] the control it belongs to: it opens against it and gives the keyboard back to it
 * @param {{ x: number, y: number }} [o.at] or a point of the page (a right click): the keyboard then goes back to
 *   whatever had it when the menu opened
 * @param {string} o.label its accessible name
 * @param {EditorMenuItem[]} o.items
 * @param {{ label: string, placeholder: string, empty: string | (() => string), filter: (query: string) => EditorMenuItem[] }} [o.search]
 *   a field above the list: `filter` gives the items for what was typed; `empty` is said when there are none
 * @param {string} [o.className] a class of its own, next to `fe-editor-menu` (the palette is wider)
 * @param {string} [o.activeId] the item the keyboard starts on (else the checked one, else the first)
 * @param {(id: string) => void} o.onSelect
 * @param {() => void} [o.onClose]
 * @returns {{ close: (o?: { refocus?: boolean }) => void, setItems: (items: EditorMenuItem[]) => void, element: HTMLElement }}
 *   `setItems`: show other items in the open menu (a search whose answer arrived)
 */
export function openEditorMenu({ host, anchor = null, at = null, label, items, search = null, className = '', activeId = null, onSelect, onClose = () => {} }) {
  closeEditorMenu();

  const menu = document.createElement('div');
  menu.className = className ? `fe-editor-menu ${className}` : 'fe-editor-menu';
  menu.setAttribute('role', search ? 'dialog' : 'menu');
  menu.setAttribute('aria-label', label);
  menu.tabIndex = -1;
  const list = document.createElement('div');
  list.className = 'fe-editor-menu-list';
  list.id = 'fe-editor-menu-list';
  list.setAttribute('role', search ? 'listbox' : 'none');
  let input = null;
  if (search) {
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'fe-editor-menu-search';
    input.placeholder = search.placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-label', search.label);
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-autocomplete', 'list');
    menu.append(input);
  }
  menu.append(list);

  let shown = [];       // the items that can be chosen, in order
  let activeAt = -1;
  let open = true;
  // What had the keyboard when the menu opened: where it goes back to, for a menu that belongs to no control.
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;

  function setActive(index, { scroll = true } = {}) {
    activeAt = shown.length ? Math.max(0, Math.min(shown.length - 1, index)) : -1;
    shown.forEach((entry, i) => entry.node.classList.toggle('active', i === activeAt));
    const node = shown[activeAt]?.node || null;
    (input || menu).setAttribute('aria-activedescendant', node ? node.id : '');
    if (node && scroll) node.scrollIntoView({ block: 'nearest' });
  }

  function render(entries) {
    list.textContent = '';
    shown = [];
    let seq = 0;
    for (const item of entries) {
      if (item.separator) {
        const line = document.createElement('div');
        line.className = 'fe-editor-menu-sep';
        line.setAttribute('role', 'separator');
        list.append(line);
        continue;
      }
      const node = document.createElement('div');
      node.className = 'fe-editor-menu-item';
      node.id = `fe-editor-menu-item-${seq++}`;
      node.dataset.id = item.id;
      node.setAttribute('role', search ? 'option' : (item.checked === undefined ? 'menuitem' : (item.toggle ? 'menuitemcheckbox' : 'menuitemradio')));
      if (item.checked !== undefined) node.setAttribute(search ? 'aria-selected' : 'aria-checked', String(!!item.checked));
      if (item.disabled) node.setAttribute('aria-disabled', 'true');
      const check = document.createElement('span');
      check.className = 'fe-editor-menu-check';
      check.setAttribute('aria-hidden', 'true');
      if (item.checked) check.textContent = '✓';
      const text = document.createElement('span');
      text.className = 'fe-editor-menu-label';
      text.textContent = item.label;
      node.append(check, text);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'fe-editor-menu-hint';
        hint.textContent = item.hint;
        node.append(hint);
      }
      list.append(node);
      if (!item.disabled) shown.push({ item, node });
    }
    if (!shown.length && search) {
      const none = document.createElement('div');
      none.className = 'fe-editor-menu-empty';
      none.textContent = typeof search.empty === 'function' ? search.empty() : search.empty;
      list.append(none);
    }
    const wanted = activeId === null ? -1 : shown.findIndex((entry) => entry.item.id === activeId);
    const checked = shown.findIndex((entry) => entry.item.checked && !entry.item.toggle);
    setActive(wanted >= 0 ? wanted : (checked >= 0 ? checked : 0));
  }

  function close({ refocus = false } = {}) {
    if (!open) return;
    open = false;
    if (_current === handle) _current = null;
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('resize', onResize);
    for (const type of KEY_EVENTS) window.removeEventListener(type, onKey, true);
    menu.remove();
    anchor?.setAttribute('aria-expanded', 'false');
    if (refocus) {
      const back = anchor || (opener?.isConnected ? opener : null);
      back?.focus();
    }
    onClose();
  }

  function choose(entry) {
    if (!entry) return;
    close({ refocus: true });
    onSelect(entry.item.id);
  }

  const onOutside = (event) => { if (!menu.contains(event.target)) close(); };
  const onResize = () => close();

  menu.addEventListener('click', (event) => {
    const node = event.target.closest?.('.fe-editor-menu-item');
    if (node) choose(shown.find((entry) => entry.node === node));
  });
  menu.addEventListener('mousemove', (event) => {
    const node = event.target.closest?.('.fe-editor-menu-item');
    const index = node ? shown.findIndex((entry) => entry.node === node) : -1;
    if (index >= 0 && index !== activeAt) setActive(index, { scroll: false });
  });
  // The keys pressed in the menu are its own. Taken at the window in the capture phase, so that they are the
  // menu's before a listener at the document can take them for a shortcut of its own, and go no further: what a
  // key types into the search field is not held back by that.
  function onKey(event) {
    if (!open || !menu.contains(event.target)) return;
    event.stopPropagation();
    if (event.type !== 'keydown') return;
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); setActive(activeAt + 1 >= shown.length ? 0 : activeAt + 1); break;
      case 'ArrowUp': event.preventDefault(); setActive(activeAt - 1 < 0 ? shown.length - 1 : activeAt - 1); break;
      case 'Home': if (!input) { event.preventDefault(); setActive(0); } break;
      case 'End': if (!input) { event.preventDefault(); setActive(shown.length - 1); } break;
      case 'PageDown': event.preventDefault(); setActive(activeAt + 8); break;
      case 'PageUp': event.preventDefault(); setActive(activeAt - 8); break;
      case 'Enter': if (!event.isComposing) { event.preventDefault(); choose(shown[activeAt]); } break;
      case ' ': if (!input) { event.preventDefault(); choose(shown[activeAt]); } break;
      case 'Escape': event.preventDefault(); close({ refocus: true }); break;
      case 'Tab': event.preventDefault(); close({ refocus: true }); break;
      default:
    }
  }
  if (input) input.addEventListener('input', () => render(search.filter(input.value)));

  render(search ? search.filter('') : items);
  host.append(menu);

  // Against the anchor (above it when there is no room below), or at the point; always inside the host.
  const frame = host.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const gap = 6;
  let left; let top;
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    left = box.left;
    top = box.bottom + gap + size.height <= frame.bottom ? box.bottom + gap : box.top - gap - size.height;
  } else {
    left = at?.x ?? frame.left;
    top = at?.y ?? frame.top;
  }
  left = Math.max(frame.left + 8, Math.min(left, frame.right - size.width - 8));
  top = Math.max(frame.top + 8, Math.min(top, frame.bottom - size.height - 8));
  menu.style.left = `${Math.round(left - frame.left)}px`;
  menu.style.top = `${Math.round(top - frame.top)}px`;

  anchor?.setAttribute('aria-expanded', 'true');
  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('resize', onResize);
  for (const type of KEY_EVENTS) window.addEventListener(type, onKey, true);
  (input || menu).focus();
  setActive(activeAt);

  const handle = { close, setItems: (entries) => { if (open) render(entries); }, element: menu };
  _current = handle;
  return handle;
}
