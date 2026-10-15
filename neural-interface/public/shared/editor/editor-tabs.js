// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: the tab strip
// ═══════════════════════════════════════════
//
// The row of tabs under the editor's header (#fe-editor-tabs, markup in
// html-shell.js, look in styles.css). It is there only while two or more
// documents are open: with one, the panel is as it was before it had tabs.
// It draws what editor-tabs-logic.js holds and reports what the user did;
// editor-panel.js decides what that means. No imports: the strings, the file
// icons and the menu are handed in.

const FILE_ICON = '<svg viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><polyline points="13 2 13 7 18 7"/></svg>';
const PLAN_ICON = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 11 17 15 13"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/**
 * @param {object} o
 * @param {HTMLElement} o.root #fe-editor-tabs
 * @param {(key: string, params?: object) => string} o.t
 * @param {(fileName: string) => ({ svg?: string, img?: string, color?: string | null } | null)} [o.fileIcon] the
 *   File Explorer's icon for a file name
 * @param {(menu: object) => object} o.openMenu editor-menu.js, already given the panel as its host
 * @param {object} o.on what the user did, by tab id: `activate`, `close`, `pin`, `move(id, index)`,
 *   `keyboardLeft()` (the strip was hidden while the keyboard was in it), and
 *   `command(id, 'close' | 'closeOthers' | 'closeSaved' | 'copyPath' | 'reveal')` for the menu
 */
export function createTabStrip({ root, t, fileIcon = () => null, openMenu, on }) {
  let tabs = [];
  let drawn = '';      // what the strip shows, as text: the same again is not drawn again
  let dragged = null;

  const tabOf = (target) => target?.closest?.('.fe-editor-tab') || null;
  const nodeOf = (id) => [...root.children].find((node) => node.dataset.id === id) || null;

  function iconFor(tab) {
    const icon = document.createElement('span');
    icon.className = 'fe-editor-tab-icon';
    icon.setAttribute('aria-hidden', 'true');
    if (tab.kind !== 'file') { icon.innerHTML = PLAN_ICON; return icon; }
    const found = fileIcon(tab.name);
    if (found?.img) {
      const image = document.createElement('img');
      image.src = found.img;
      image.alt = '';
      icon.append(image);
    } else {
      icon.innerHTML = found?.svg || FILE_ICON;
      if (found?.color) icon.style.color = found.color;
    }
    return icon;
  }

  /**
   * Draw the strip.
   * @param {object} o
   * @param {{ id: string, kind: string, name: string, path: string, pinned: boolean }[]} o.tabs in order
   * @param {string | null} o.activeId
   * @param {Map<string, { name: string, hint: string }>} o.labels from tabLabels()
   * @param {(id: string) => boolean} o.isDirty
   * @param {(id: string) => string} o.titleOf the path a tab shows as its tooltip
   */
  function render({ tabs: next, activeId, labels, isDirty, titleOf }) {
    const rows = next.map((tab) => ({ tab, active: tab.id === activeId, dirty: isDirty(tab.id), label: labels.get(tab.id) || { name: tab.name, hint: '' }, title: titleOf(tab.id) }));
    const signature = JSON.stringify(rows.map((entry) => [entry.tab.id, entry.tab.kind, entry.tab.pinned, entry.active, entry.dirty, entry.label.name, entry.label.hint, entry.title]));
    tabs = next;
    // Unchanged: the elements stay as they are (a second click of a double click finds the one the first hit).
    if (signature === drawn) return;
    drawn = signature;
    const held = root.contains(document.activeElement);   // the keyboard is in the strip
    const focused = held ? tabOf(document.activeElement)?.dataset.id : null;
    const scrolled = root.scrollLeft;
    root.hidden = tabs.length < 2;
    root.textContent = '';
    if (root.hidden) {
      // The strip is gone with the keyboard in it (a tab was closed from it and one file is left): the keyboard
      // would fall to the page, where the next key is somebody else's shortcut. The host says where it goes.
      if (held) on.keyboardLeft?.();
      return;
    }
    for (const { tab, active, dirty, label, title } of rows) {
      const node = document.createElement('div');
      node.className = `fe-editor-tab${active ? ' active' : ''}${dirty ? ' dirty' : ''}${tab.pinned ? '' : ' preview'}${tab.kind === 'file' ? '' : ' marked'}`;
      node.id = `fe-editor-tab-${tab.id}`;
      node.dataset.id = tab.id;
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', String(active));
      node.tabIndex = active ? 0 : -1;
      node.draggable = true;
      node.dataset.tooltip = title;

      const name = document.createElement('span');
      name.className = 'fe-editor-tab-name';
      name.textContent = label.name;
      node.append(iconFor(tab), name);
      if (tab.kind !== 'file') {
        const mark = document.createElement('span');
        mark.className = 'fe-editor-tab-mark';
        mark.textContent = t(tab.kind === 'plan' ? 'editor.tabs.plan' : 'editor.tabs.changelog');
        node.append(mark);
      } else if (label.hint) {
        const hint = document.createElement('span');
        hint.className = 'fe-editor-tab-hint';
        hint.textContent = label.hint;
        node.append(hint);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'fe-editor-tab-close';
      close.tabIndex = -1;
      close.setAttribute('aria-label', t(dirty ? 'editor.tabs.closeUnsaved' : 'editor.tabs.close', { name: tab.name }));
      close.innerHTML = `<span class="fe-editor-tab-dot" aria-hidden="true"></span>${CLOSE_ICON}`;
      node.append(close);
      root.append(node);
    }
    root.scrollLeft = scrolled;
    const activeNode = nodeOf(activeId);
    // The shown tab is in sight; the keyboard stays where it was.
    activeNode?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focused) (nodeOf(focused) || activeNode)?.focus();
  }

  function menuFor(node, at) {
    const id = node.dataset.id;
    openMenu({
      anchor: at ? null : node,
      at,
      label: t('editor.tabs.menu.label'),
      items: [
        { id: 'close', label: t('editor.tabs.menu.close') },
        { id: 'closeOthers', label: t('editor.tabs.menu.closeOthers'), disabled: tabs.length < 2 },
        { id: 'closeSaved', label: t('editor.tabs.menu.closeSaved') },
        { separator: true },
        { id: 'copyPath', label: t('editor.tabs.menu.copyPath') },
        { id: 'reveal', label: t('editor.tabs.menu.reveal') },
      ],
      onSelect: (action) => on.command(id, action),
    });
  }

  root.addEventListener('click', (event) => {
    const node = tabOf(event.target);
    if (!node) return;
    if (event.target.closest('.fe-editor-tab-close')) { event.stopPropagation(); on.close(node.dataset.id); return; }
    // The second click of a double click keeps the tab. (Counted here: the first click may have redrawn the
    // strip, and a `dblclick` would then go to an element that is no longer in it.)
    if (event.detail >= 2) on.pin(node.dataset.id);
    else on.activate(node.dataset.id);
  });
  // The middle button closes a tab; held down, it would otherwise start the browser's own scrolling.
  root.addEventListener('mousedown', (event) => { if (event.button === 1 && tabOf(event.target)) event.preventDefault(); });
  root.addEventListener('auxclick', (event) => {
    const node = tabOf(event.target);
    if (node && event.button === 1) { event.preventDefault(); on.close(node.dataset.id); }
  });
  root.addEventListener('contextmenu', (event) => {
    const node = tabOf(event.target);
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    menuFor(node, { x: event.clientX, y: event.clientY });
  });
  // A vertical wheel moves along the strip.
  root.addEventListener('wheel', (event) => {
    if (event.deltaX || !event.deltaY || root.scrollWidth <= root.clientWidth) return;
    root.scrollLeft += event.deltaY;
    event.preventDefault();
  }, { passive: false });

  for (const type of ['keydown', 'keyup', 'keypress']) {
    root.addEventListener(type, (event) => {
      // The strip is outside the editor's own element: its keys are stopped here.
      event.stopPropagation();
      if (type !== 'keydown') return;
      const node = tabOf(event.target);
      if (!node) return;
      const at = tabs.findIndex((tab) => tab.id === node.dataset.id);
      const go = (index) => {
        const target = tabs[(index + tabs.length) % tabs.length];
        if (!target) return;
        event.preventDefault();
        on.activate(target.id, { keepFocus: true });
        nodeOf(target.id)?.focus();
      };
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        // The editor's own tab keys work from here too.
        if (event.code === 'Period') go(at + 1);
        else if (event.code === 'Comma') go(at - 1);
        else if (event.code === 'KeyW') { event.preventDefault(); if (!event.repeat) on.close(node.dataset.id); }
        return;
      }
      switch (event.key) {
        case 'ArrowRight': go(at + 1); break;
        case 'ArrowLeft': go(at - 1); break;
        case 'Home': go(0); break;
        case 'End': go(tabs.length - 1); break;
        case 'Enter': case ' ': event.preventDefault(); on.activate(node.dataset.id); break;
        // A key that is held closes one tab, not one after the other.
        case 'Delete': case 'Backspace': event.preventDefault(); if (!event.repeat) on.close(node.dataset.id); break;
        case 'ContextMenu': event.preventDefault(); menuFor(node, null); break;
        case 'F10': if (event.shiftKey) { event.preventDefault(); menuFor(node, null); } break;
        default:
      }
    });
  }

  // Dragging a tab onto another puts it there.
  root.addEventListener('dragstart', (event) => {
    const node = tabOf(event.target);
    if (!node) return;
    dragged = node.dataset.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', node.dataset.id);
    node.classList.add('dragging');
  });
  root.addEventListener('dragover', (event) => {
    if (!dragged || !tabOf(event.target)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  root.addEventListener('drop', (event) => {
    const node = tabOf(event.target);
    if (!dragged || !node) return;
    event.preventDefault();
    const to = tabs.findIndex((tab) => tab.id === node.dataset.id);
    if (to >= 0 && node.dataset.id !== dragged) on.move(dragged, to);
  });
  root.addEventListener('dragend', () => {
    nodeOf(dragged)?.classList.remove('dragging');
    dragged = null;
  });

  return { render, element: root };
}
