// ═══════════════════════════════════════════
// SynaBun Neural Interface — File Explorer: the tree
// ═══════════════════════════════════════════
//
// Draws the rows of #fe-tree and takes what the user does to them: pointer,
// keyboard, drag and drop, a name typed in place. It holds no file data: it
// asks the controller (fx-main.js) what a folder shows and what a row looks
// like, and reports what was done. What a key or a click means is decided in
// fx-logic.js.
//
// The rows are an ARIA tree: `.fe-node` (treeitem) > `.fe-row` + `.fe-children`
// (group). The tree element itself has the keyboard; the row it is on is its
// `aria-activedescendant`. A folder is drawn in chunks, and read again without
// being rebuilt: rows are matched by name, so what is open, selected, scrolled
// to or being renamed stays where it is.
//
// A line among the rows that offers something ("Show more", "Retry") is a stop
// of the keyboard as a row is: the arrows reach it in its place, Enter or
// Space does what it offers, and the keyboard then goes to the first row that
// came, or back to the folder. It is never selected: it is not a file.

import { canDropInto, dirName, joinPath, keyAction, moveTarget, pickRow, rangeBetween, topLevelOf, typeAheadTarget } from './fx-logic.js';

const CHUNK = 300;
const TYPE_AHEAD_MS = 700;
const LONG_PRESS_MS = 500;
const SPRING_OPEN_MS = 700;
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
const LINK_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7"/><polyline points="8 7 17 7 17 16"/></svg>';
let _seq = 0;

/**
 * @param {object} o
 * @param {HTMLElement} o.el #fe-tree
 * @param {boolean} o.mac
 * @param {{ folder: string, link: string, forFile: (name: string) => { svg?: string, img?: string, color?: string | null } }} o.icons
 * @param {object} o.hooks the controller: `itemsOf(dir)`, `isExpanded(path)`, `rowInfo(path, item)`, `words` (the
 *   strings a row needs), and what the user did: `onToggle`, `onOpen`, `onMenu`, `onAction`, `onSelection`,
 *   `onDrop`, `onDragStart`, `onDragEnd`, `onRetry`, `onScroll`, `onEditLost`
 */
export function createTree({ el, mac, icons, hooks }) {
  const nodes = new Map();          // path → .fe-node
  const stops = new Map();          // key → a line that offers something (.fe-note with a button), where the keyboard stops
  const shown = new Map();          // folder → how many of its rows are drawn
  let root = null;
  let selected = new Set();
  let anchor = null;
  let focus = null;
  let editing = null;               // { node, input, temp, done }
  let dragging = null;              // the rows being dragged out of this tree
  let dropInto = null;
  let springTimer = 0; let springPath = null;
  let typed = ''; let typedTimer = 0;
  let wantFirst = false;            // the keyboard was on a line of the project's own folder: it takes the first row that comes
  let pressTimer = 0; let swallowClick = false; let pressedAt = 0;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const more = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) showMore(entry.target.dataset.dir); }, { root: el })
    : null;

  el.setAttribute('role', 'tree');
  el.setAttribute('aria-multiselectable', 'true');
  el.tabIndex = 0;

  // ── Rows ──

  const containerOf = (path) => (path === root ? el : nodes.get(path)?.querySelector(':scope > .fe-children') || null);
  const rowOf = (path) => nodes.get(path)?.querySelector(':scope > .fe-row') || null;
  const realChildren = (container) => [...container.children].filter((child) => child.classList.contains('fe-node') && !child.dataset.temp);
  // A stop's key cannot be a path: it begins with a character no path holds.
  const stopKey = (act, dir) => `\u0000${act}:${dir}`;
  const isStop = (key) => typeof key === 'string' && key.charCodeAt(0) === 0;
  const there = (key) => nodes.has(key) || stops.has(key);
  const dropNote = (line) => { more?.unobserve(line); if (stops.get(line.dataset.stop) === line) stops.delete(line.dataset.stop); line.remove(); };

  function forget(node) {
    for (const inner of [node, ...node.querySelectorAll('.fe-node')]) {
      const path = inner.dataset.path;
      if (nodes.get(path) === inner) nodes.delete(path);
      shown.delete(path);
      if (editing?.node === inner) loseEdit();
    }
  }
  function removeNode(node) { forget(node); node.remove(); }

  function createNode(item, parent, depth) {
    const path = joinPath(parent, item.name);
    const node = document.createElement('div');
    node.className = 'fe-node';
    node.id = `fe-n-${++_seq}`;
    node.setAttribute('role', 'treeitem');
    node.dataset.path = path;
    node.dataset.name = item.name;
    node.dataset.type = item.type;
    node.dataset.depth = String(depth);
    node.dataset.expanded = 'false';
    node.setAttribute('aria-level', String(depth + 1));
    const row = document.createElement('div');
    row.className = 'fe-row';
    row.style.paddingLeft = `${depth * 16 + 8}px`;
    if (!coarse) row.draggable = true;
    const chevron = document.createElement('span');
    chevron.className = item.type === 'dir' ? 'fe-chevron' : 'fe-chevron fe-chevron--none';
    if (item.type === 'dir') chevron.innerHTML = CHEVRON;
    const icon = document.createElement('span');
    icon.className = `fe-icon fe-icon--${item.type === 'dir' ? 'dir' : 'file'}`;
    const name = document.createElement('span');
    name.className = 'fe-name';
    const dot = document.createElement('span');
    dot.className = 'fe-open-dot';
    dot.setAttribute('aria-hidden', 'true');
    const badge = document.createElement('span');
    badge.className = 'fe-git-badge';
    badge.setAttribute('aria-hidden', 'true');
    row.append(chevron, icon, name, dot, badge);
    node.append(row);
    if (item.type === 'dir') {
      const children = document.createElement('div');
      children.className = 'fe-children';
      children.setAttribute('role', 'group');
      children.style.setProperty('--fe-guide', `${depth * 16 + 14}px`);
      node.append(children);
    }
    nodes.set(path, node);
    return node;
  }

  function drawIcon(icon, item, info) {
    const key = `${item.type}|${item.name}|${info.color || ''}|${info.link ? 1 : 0}`;
    if (icon.dataset.drawn === key) return;
    icon.dataset.drawn = key;
    icon.style.color = '';
    if (item.type === 'dir') {
      icon.innerHTML = icons.folder;
      const svg = icon.querySelector('svg');
      if (svg && info.color) { svg.style.fill = info.color; svg.style.stroke = info.color; }
    } else {
      const found = icons.forFile(item.name);
      if (found?.img) {
        icon.textContent = '';
        const image = document.createElement('img');
        image.src = found.img; image.alt = ''; image.className = 'fe-icon-img';
        icon.append(image);
      } else {
        icon.innerHTML = found?.svg || '';
        if (found?.color) icon.style.color = found.color;
      }
    }
    if (info.link) icon.insertAdjacentHTML('beforeend', `<span class="fe-link-glyph">${LINK_GLYPH}</span>`);
  }

  // Everything a row shows of its state. Cheap: called for every drawn row when git or the editor changes.
  function updateNode(node, item, index = null, count = null) {
    node._item = item;
    const path = node.dataset.path;
    const info = hooks.rowInfo(path, item);
    const row = node.firstElementChild;
    const [, icon, name, dot, badge] = row.children;
    if (index !== null) { node.setAttribute('aria-posinset', String(index + 1)); node.setAttribute('aria-setsize', String(count)); }
    node.setAttribute('aria-selected', String(selected.has(path)));
    node.classList.toggle('fe-node--selected', selected.has(path));
    node.classList.toggle('fe-node--focus', focus === path);
    node.classList.toggle('fe-node--ignored', !!info.ignored);
    node.classList.toggle('fe-node--cut', !!info.cut);
    node.classList.toggle('fe-node--open', !!info.open);
    node.classList.toggle('fe-node--active', !!info.active);
    node.classList.toggle('fe-node--missing', !!info.missing);
    node.classList.toggle('fe-node--faint', !!info.faint);
    drawIcon(icon, item, info);
    if (editing?.node !== node) {
      const sign = `${item.name}|${info.match ? info.match.join(',') : ''}`;
      if (name.dataset.drawn !== sign) {
        name.dataset.drawn = sign;
        name.textContent = '';
        if (info.match) {
          const [from, to] = info.match;
          const hit = document.createElement('mark');
          hit.className = 'fe-match';
          hit.textContent = item.name.slice(from, to);
          name.append(item.name.slice(0, from), hit, item.name.slice(to));
        } else name.textContent = item.name;
      }
    }
    dot.className = `fe-open-dot${info.dirty ? ' fe-open-dot--dirty' : info.open ? ' fe-open-dot--open' : ''}`;
    badge.className = `fe-git-badge${info.tone ? ` fe-git-${info.tone}` : ''}${info.letter ? '' : ' fe-git-badge--dot'}`;
    badge.textContent = info.letter || '';
    badge.hidden = !info.tone;
    // The whole name, and the row's state in words: for a pointer that rests on it, and for a screen reader.
    const said = info.words?.length ? `${item.name} (${info.words.join(', ')})` : item.name;
    if (row.title !== said) { row.title = said; node.setAttribute('aria-label', said); }
  }

  function note(container, className, text, action = null) {
    const line = document.createElement('div');
    line.className = `fe-note ${className}`;
    line.style.paddingLeft = `${(Number(container.parentElement?.dataset.depth ?? -1) + 1) * 16 + 26}px`;
    const words = document.createElement('span');
    words.textContent = text;
    line.append(words);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fe-note-action';
      button.textContent = action.label;
      button.dataset.act = action.act;
      button.tabIndex = -1;
      line.append(button);
      // Where the keyboard stops, like a row: the tree has the keyboard, this line is its active descendant.
      const key = stopKey(action.act, action.dir);
      line.id = `fe-n-${++_seq}`;
      line.dataset.dir = action.dir;
      line.dataset.stop = key;
      line.setAttribute('role', 'treeitem');
      line.setAttribute('aria-label', `${text} ${action.label}`);
      line.classList.toggle('fe-note--focus', focus === key);
      stops.set(key, line);
    }
    container.append(line);
    return line;
  }

  /** Bring the rows of one folder up to what the controller says it shows now. Rows that stay are not rebuilt. */
  function syncContainer(container, dir, depth) {
    for (const old of [...container.children]) if (old.classList.contains('fe-note')) dropNote(old);
    const data = hooks.itemsOf(dir);
    if (data.state !== 'ready') {
      // What was drawn stays under a folder that is being read again; a first read, or a failure, says so.
      if (data.state === 'error') {
        for (const child of realChildren(container)) removeNode(child);
        note(container, 'fe-note--error', data.message, { label: hooks.words.retry, act: 'retry', dir });
      } else if (!realChildren(container).length) note(container, 'fe-note--loading', hooks.words.loading);
      return;
    }
    const limit = Math.max(CHUNK, shown.get(dir) || CHUNK);
    const visible = data.items.length > limit ? data.items.slice(0, limit) : data.items;
    // Rows are matched by name. What is gone leaves first; what stays is then put in order, moving as few as it takes.
    const existing = new Map(realChildren(container).map((child) => [child.dataset.name, child]));
    const wanted = visible.map((item) => {
      const node = existing.get(item.name);
      if (node && node.dataset.type === item.type) { existing.delete(item.name); return node; }
      return null;
    });
    for (const node of existing.values()) removeNode(node);
    const real = (node) => { let at = node; while (at && (!at.classList.contains('fe-node') || at.dataset.temp)) at = at.nextElementSibling; return at; };
    let cursor = real(container.firstElementChild);
    visible.forEach((item, index) => {
      const node = wanted[index] || createNode(item, dir, depth);
      if (cursor === node) cursor = real(cursor.nextElementSibling);
      else container.insertBefore(node, cursor);
      updateNode(node, item, index, visible.length);
      if (item.type === 'dir') syncDir(node);
    });
    if (data.items.length > visible.length) {
      const rest = note(container, 'fe-note--more', hooks.words.more(data.items.length - visible.length), { label: hooks.words.showMore, act: 'more', dir });
      more?.observe(rest);
    } else if (data.truncated) note(container, 'fe-note--cut', hooks.words.truncated(data.items.length, data.total));
    if (!data.items.length && !container.querySelector(':scope > .fe-node')) note(container, 'fe-note--empty', data.note || hooks.words.emptyFolder);
  }

  // A folder's own node: open or closed, and its rows when it is open.
  function syncDir(node) {
    const path = node.dataset.path;
    const open = hooks.isExpanded(path);
    node.dataset.expanded = String(open);
    node.setAttribute('aria-expanded', String(open));
    const children = node.querySelector(':scope > .fe-children');
    if (!children) return;
    if (open) syncContainer(children, path, Number(node.dataset.depth) + 1);
    else if (children.firstChild) { for (const child of [...children.children]) { if (child.classList.contains('fe-node')) removeNode(child); else dropNote(child); } }
  }

  function showMore(dir) {
    if (!dir) return;
    // The keyboard was on "Show more": it goes to the first of the rows that come.
    const line = stops.get(stopKey('more', dir));
    const last = focus === line?.dataset.stop ? line.previousElementSibling : null;
    shown.set(dir, (shown.get(dir) || CHUNK) + CHUNK);
    renderDir(dir);
    const next = last?.nextElementSibling;
    if (last && next?.classList.contains('fe-node')) apply({ selected, anchor, focus: next.dataset.path });
  }

  // What a line offers, asked for with the keyboard.
  function useStop(key) {
    const line = stops.get(key);
    if (!line) return;
    const dir = line.dataset.dir;
    if (line.querySelector('.fe-note-action')?.dataset.act === 'more') { showMore(dir); return; }
    // Retry: the folder is read again and this line goes. The keyboard waits on the folder, one step above where
    // the rows will be, or the line that says it failed again.
    if (nodes.has(dir)) apply({ selected, anchor, focus: dir });
    hooks.onRetry(dir);
  }

  /** Draw everything from the project's folder down. */
  function render() {
    if (!root) return;
    syncContainer(el, root, 0);
    settle();
  }
  /** Draw one folder again (the root's path draws all). Nothing happens for a folder that is not shown. */
  function renderDir(path) {
    if (!root) return;
    if (path === root) { render(); return; }
    const node = nodes.get(path);
    if (node) { syncDir(node); settle(); }
  }
  /** Every drawn row takes its state again (git, the editor, what was cut). */
  function refreshRows() { for (const node of nodes.values()) if (node._item) updateNode(node, node._item); }

  // After rows came or went: the selection and the keyboard only ever point at rows that are there.
  function settle() {
    let changed = false;
    for (const path of [...selected]) if (!nodes.has(path)) { selected.delete(path); changed = true; }
    if (anchor && !nodes.has(anchor)) anchor = null;
    if (focus && !there(focus)) {
      // The row the keyboard was on is gone: the folder that held it takes it. A line that offered something (it
      // begins with its folder) is gone when it was used: its folder, likewise. A line of the project's own
      // folder has no row above it: the keyboard takes the first row that comes (below).
      const line = isStop(focus);
      let at = line ? focus.slice(focus.indexOf(':') + 1) : dirName(focus);
      while (at && at !== root && !nodes.has(at)) at = dirName(at);
      focus = nodes.has(at) ? at : null;
      if (!focus && line) wantFirst = true;
      changed = true;
    }
    if (wantFirst && !focus) {
      // The first of the rows that came, or the line that says the folder could not be read again. It has the
      // keyboard and is not selected: nobody picked it.
      const first = order({ withStops: true })[0];
      if (first) { wantFirst = false; apply({ selected, anchor, focus: first }, { scroll: false, quiet: true }); changed = true; }
    }
    markFocus();
    if (changed) hooks.onSelection(selection());
  }

  // ── Selection and the keyboard's row ──

  /** The rows in the order they are shown. `withStops`: and the lines the keyboard stops on, each in its place. */
  function order({ withStops = false } = {}) {
    const out = [];
    const walk = (container) => {
      for (const child of container.children) {
        if (withStops && child.dataset.stop) { out.push(child.dataset.stop); continue; }
        if (!child.classList.contains('fe-node') || child.dataset.temp) continue;
        out.push(child.dataset.path);
        if (child.dataset.expanded === 'true') { const inner = child.querySelector(':scope > .fe-children'); if (inner) walk(inner); }
      }
    };
    walk(el);
    return out;
  }
  // The row the keyboard is on, for whoever acts on files: a line that offers something is not one.
  const selection = () => ({ selected: [...selected], anchor, focus: isStop(focus) ? null : focus });

  function markFocus() {
    const node = focus ? nodes.get(focus) || stops.get(focus) : null;
    if (node) el.setAttribute('aria-activedescendant', node.id); else el.removeAttribute('aria-activedescendant');
  }
  function apply(next, { scroll = true, quiet = false } = {}) {
    const touched = new Set([...selected, ...next.selected, focus, next.focus]);
    // Only rows are selected: a line that offers something can have the keyboard, and nothing else.
    selected = new Set([...next.selected].filter((path) => !isStop(path)));
    anchor = isStop(next.anchor) ? null : next.anchor;
    focus = next.focus;
    if (focus) wantFirst = false;
    for (const path of touched) {
      if (isStop(path)) { stops.get(path)?.classList.toggle('fe-note--focus', focus === path); continue; }
      const node = path ? nodes.get(path) : null;
      if (!node) continue;
      node.classList.toggle('fe-node--selected', selected.has(path));
      node.classList.toggle('fe-node--focus', focus === path);
      node.setAttribute('aria-selected', String(selected.has(path)));
    }
    markFocus();
    if (scroll && focus) (isStop(focus) ? stops.get(focus) : rowOf(focus))?.scrollIntoView({ block: 'nearest' });
    if (!quiet) hooks.onSelection(selection());
  }
  /** Select rows (those that are drawn), and put the keyboard on one of them. */
  function select(paths, { focus: at = null, scroll = true, quiet = false } = {}) {
    const list = paths.filter((path) => nodes.has(path));
    const on = at && nodes.has(at) ? at : list[0] || null;
    apply({ selected: new Set(list), anchor: on, focus: on }, { scroll, quiet });
  }

  // ── A name typed in place (rename, new file, new folder) ──

  // The row a name was being typed in is gone. That is a loss to say when the file went away under the typing;
  // it is what was asked for when the name was just kept and the row gives way to the one of the new name. While
  // the name is on its way to the server nobody knows which: a refresh that follows the disk may take the row
  // before the answer is here. Then nothing is said yet, and the answer decides (submit).
  function loseEdit() {
    const lost = editing;
    editing = null;
    if (!lost) return;
    lost.tip?.remove();
    if (lost.busy) { lost.lost = true; return; }
    if (!lost.settled) hooks.onEditLost?.(lost.original);
  }
  /** The name that was typed is the entry's name now: the row it was typed in is about to be replaced. */
  function settleEdit() { if (editing) editing.settled = true; }

  /**
   * Let the user type a name in a row.
   * @param {object} o
   * @param {string} [o.path] the row to rename; or
   * @param {string} [o.parent] the folder a new row is added to, and
   * @param {'file' | 'dir'} [o.kind] what the new row will be
   * @param {string} [o.value] @param {[number, number]} [o.select] the part of it that starts selected
   * @param {string} o.label the field's accessible name
   * @param {(name: string) => string | null} o.validate the sentence that says why a name cannot be used
   * @param {(name: string) => Promise<{ ok: boolean, message?: string }>} o.commit
   * @returns {boolean} whether the field is there
   */
  function startEdit({ path = null, parent = null, kind = 'file', value = '', select: range = null, label, validate, commit }) {
    endEdit();
    let node; let temp = false;
    if (path) {
      node = nodes.get(path);
      if (!node) return false;
    } else {
      const container = containerOf(parent);
      if (!container) return false;
      const depth = parent === root ? 0 : Number(nodes.get(parent).dataset.depth) + 1;
      node = createNode({ name: '', type: kind }, parent, depth);
      nodes.delete(node.dataset.path);
      node.dataset.temp = '1';
      node.removeAttribute('role');
      drawIcon(node.firstElementChild.children[1], { name: kind === 'dir' ? '' : 'new', type: kind }, {});
      node.querySelector('.fe-git-badge').hidden = true;
      container.querySelector(':scope > .fe-note--empty')?.remove();
      container.insertBefore(node, container.firstChild);
      temp = true;
    }
    const row = node.firstElementChild;
    const name = row.children[2];
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fe-rename-input';
    input.value = value;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('aria-label', label);
    const tip = document.createElement('div');
    tip.className = 'fe-rename-tip';
    tip.id = `${node.id}-tip`;
    tip.setAttribute('role', 'alert');
    tip.hidden = true;
    input.setAttribute('aria-describedby', tip.id);
    name.textContent = '';
    name.dataset.drawn = '';
    name.append(input);
    row.after(tip);
    row.draggable = false;
    const state = { node, input, tip, temp, original: value, busy: false, lost: false };
    editing = state;
    const say = (message) => { tip.textContent = message || ''; tip.hidden = !message; input.setAttribute('aria-invalid', String(!!message)); };

    function finish() {
      if (editing !== state) return;
      editing = null;
      tip.remove();
      if (temp) node.remove();
      else {
        if (!coarse) row.draggable = true;
        if (node.isConnected && node._item) updateNode(node, node._item);
      }
    }
    async function submit() {
      if (state.busy || editing !== state) return;
      const typedName = input.value.trim();
      // Nothing typed, or the name it had: nothing to do.
      if (!typedName || (!temp && typedName === value)) { finish(); el.focus({ preventScroll: true }); return; }
      const problem = validate(typedName);
      if (problem) { say(problem); input.focus(); return; }
      state.busy = true;
      input.readOnly = true;
      let done;
      try { done = await commit(typedName); } catch { done = { ok: false, message: '' }; }
      state.busy = false;
      if (editing !== state) {
        // The row went while the name was on its way. A name that was kept is no loss; one that was not is said,
        // in the server's words when it had any.
        if (state.lost && !done?.ok && !state.settled) hooks.onEditLost?.(state.original, done?.message || '');
        return;
      }
      if (done?.ok) { finish(); return; }
      input.readOnly = false;
      if (done?.cancel) { finish(); el.focus({ preventScroll: true }); return; }
      say(done?.message || '');
      input.focus();
    }
    state.done = finish;
    input.addEventListener('input', () => { const text = input.value.trim(); say(text ? validate(text) : ''); });
    for (const type of ['keydown', 'keyup', 'keypress']) {
      input.addEventListener(type, (event) => {
        event.stopPropagation();
        if (type !== 'keydown') return;
        if (event.key === 'Enter') { event.preventDefault(); submit(); }
        else if (event.key === 'Escape') { event.preventDefault(); finish(); el.focus({ preventScroll: true }); }
      });
    }
    // Leaving the field keeps what was typed when it is a name that can be used, and gives it up when not.
    input.addEventListener('blur', () => {
      if (state.busy || editing !== state) return;
      const text = input.value.trim();
      if (text && !(!temp && text === value) && !validate(text)) submit(); else finish();
    });
    for (const type of ['click', 'dblclick', 'mousedown', 'pointerdown', 'contextmenu']) input.addEventListener(type, (event) => event.stopPropagation());
    input.focus({ preventScroll: true });
    if (range) input.setSelectionRange(range[0], range[1]); else input.select();
    row.scrollIntoView({ block: 'nearest' });
    return true;
  }
  function endEdit() { editing?.done?.(); }

  // ── Pointer ──

  const nodeAt = (target) => { const row = target?.closest?.('.fe-row'); const node = row?.parentElement; return node && nodes.get(node.dataset.path) === node ? node : null; };

  el.addEventListener('click', (event) => {
    if (swallowClick) { swallowClick = false; event.preventDefault(); return; }
    const button = event.target.closest('.fe-note-action');
    if (button) {
      const dir = button.closest('.fe-note').dataset.dir;
      if (button.dataset.act === 'more') showMore(dir); else hooks.onRetry(dir);
      return;
    }
    if (event.target.closest('.fe-note')) return;
    const node = nodeAt(event.target);
    if (!node || editing?.node === node) return;
    const path = node.dataset.path;
    const toggle = mac ? event.metaKey : event.ctrlKey;
    const range = event.shiftKey;
    apply(pickRow({ selected, anchor }, path, { toggle, range }, order()), { scroll: false });
    if (toggle || range || event.detail > 1) return;
    // A click opens or closes a folder; on a file it is the row's menu, the same one a right click opens
    // (docs/design/code-editor/SPEC.md, run 3). A double click opens the file.
    if (node.dataset.type === 'dir') hooks.onToggle(path, node.dataset.expanded !== 'true');
    else menuFor(node, { y: event.clientY });
  });

  el.addEventListener('dblclick', (event) => {
    const node = nodeAt(event.target);
    if (!node || node.dataset.type === 'dir' || editing?.node === node) return;
    event.preventDefault();
    hooks.onOpen(node.dataset.path, node._item, { pin: true });
  });

  function menuFor(node, { keyboard = false, y = null } = {}) {
    if (node) {
      const path = node.dataset.path;
      if (!selected.has(path)) apply({ selected: new Set([path]), anchor: path, focus: path }, { scroll: false });
      else if (focus !== path) apply({ selected, anchor, focus: path }, { scroll: false });
      hooks.onMenu({ paths: topLevelOf([...selected]), row: node.firstElementChild, item: node._item, expanded: node.dataset.expanded === 'true', keyboard });
    } else hooks.onMenu({ paths: [], row: null, y, keyboard });
  }

  el.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.fe-rename-input')) return;
    event.preventDefault();
    event.stopPropagation();
    // A long press already opened it (some touch browsers send both).
    if (Date.now() - pressedAt < 800) return;
    menuFor(nodeAt(event.target), { y: event.clientY });
  });

  // A finger held on a row opens its menu; one that moves is scrolling.
  el.addEventListener('pointerdown', (event) => {
    clearTimeout(pressTimer);
    if (event.pointerType === 'mouse' || editing) return;
    const node = nodeAt(event.target);
    const from = { x: event.clientX, y: event.clientY };
    const stop = () => { clearTimeout(pressTimer); el.removeEventListener('pointermove', moved); el.removeEventListener('pointerup', stop); el.removeEventListener('pointercancel', stop); };
    const moved = (move) => { if (Math.hypot(move.clientX - from.x, move.clientY - from.y) > 10) stop(); };
    el.addEventListener('pointermove', moved);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    pressTimer = setTimeout(() => {
      stop();
      pressedAt = Date.now();
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 700);
      try { navigator.vibrate?.(8); } catch { /* not there */ }
      menuFor(node, { y: from.y });
    }, LONG_PRESS_MS);
  });

  // ── Drag and drop ──

  function markDrop(into) {
    if (dropInto === into) return;
    if (dropInto) (dropInto === root ? el : nodes.get(dropInto))?.classList.remove('fe-drop');
    dropInto = into;
    if (dropInto) (dropInto === root ? el : nodes.get(dropInto))?.classList.add('fe-drop');
  }
  function spring(path) {
    if (springPath === path) return;
    clearTimeout(springTimer);
    springPath = path;
    // Held over a closed folder, the folder opens.
    if (path && nodes.get(path)?.dataset.expanded !== 'true') springTimer = setTimeout(() => { if (springPath === path) hooks.onToggle(path, true); }, SPRING_OPEN_MS);
  }
  // The folder a drop at this point goes into: the folder under the pointer, a file's folder, or the project.
  function folderAt(target) {
    const node = nodeAt(target) || target?.closest?.('.fe-node');
    if (!node || !nodes.has(node.dataset.path)) return root;
    return node.dataset.type === 'dir' ? node.dataset.path : dirName(node.dataset.path);
  }

  el.addEventListener('dragstart', (event) => {
    const node = nodeAt(event.target);
    if (!node || editing) { event.preventDefault(); return; }
    const path = node.dataset.path;
    if (!selected.has(path)) apply({ selected: new Set([path]), anchor: path, focus: path }, { scroll: false });
    dragging = topLevelOf([...selected]);
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', dragging.join('\n'));
    event.dataTransfer.setData('application/x-synabun-paths', JSON.stringify(dragging));
    el.classList.add('fe-tree--dragging');
    hooks.onDragStart(dragging);
  });
  el.addEventListener('dragover', (event) => {
    const files = !dragging && [...(event.dataTransfer?.types || [])].includes('Files');
    if (!dragging && !files) return;
    const into = folderAt(event.target);
    const copy = files || (mac ? event.altKey : event.ctrlKey);
    if (!into || (dragging && !canDropInto(dragging, into, { copy })) || (files && !hooks.acceptsFiles())) { markDrop(null); spring(null); return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = copy ? 'copy' : 'move';
    markDrop(into);
    const over = nodeAt(event.target);
    spring(over?.dataset.type === 'dir' ? over.dataset.path : null);
  });
  el.addEventListener('dragleave', (event) => { if (!el.contains(event.relatedTarget)) { markDrop(null); spring(null); } });
  el.addEventListener('drop', (event) => {
    const into = dropInto;
    markDrop(null);
    spring(null);
    if (!into) return;
    event.preventDefault();
    if (dragging) hooks.onDrop({ rows: dragging, into, copy: mac ? event.altKey : event.ctrlKey });
    else hooks.onDrop({ transfer: event.dataTransfer, into });
  });
  el.addEventListener('dragend', () => {
    dragging = null;
    markDrop(null);
    spring(null);
    el.classList.remove('fe-tree--dragging');
    hooks.onDragEnd();
  });

  // ── Keyboard ──

  function move(to, { extend = false, keep = false } = {}) {
    if (!to) return;
    if (extend) {
      const from = anchor && nodes.has(anchor) ? anchor : (isStop(focus) ? null : focus) || to;
      apply({ selected: new Set(rangeBetween(order({ withStops: true }), from, to)), anchor: from, focus: to });
    } else if (keep || isStop(to)) apply({ selected, anchor, focus: to });
    else apply({ selected: new Set([to]), anchor: to, focus: to });
  }

  // The keyboard is on a line that offers something: the arrows move on from it, Enter or Space takes the offer,
  // and what is about files (rename, delete, paste) has nothing to act on.
  function onStopKey(what, rows) {
    const line = stops.get(focus);
    switch (what.action) {
      case 'down': case 'up': case 'home': case 'end': case 'pageDown': case 'pageUp':
        move(moveTarget(rows, focus, what.action, { page: Math.max(1, Math.floor(el.clientHeight / 24) - 1) }), { keep: what.keep });
        return;
      case 'left': { const dir = line?.dataset.dir; if (nodes.has(dir)) move(dir); return; }
      case 'open': case 'peek': useStop(focus); return;
      case 'escape': hooks.onAction('escape', { paths: topLevelOf([...selected]), focus: null }); return;
      default:
    }
  }

  function onKey(event) {
    if (editing) return false;
    const what = keyAction(event, { mac });
    if (!what) return false;
    const rows = order({ withStops: true });
    if (isStop(focus) && !what.type) { onStopKey(what, rows); return true; }
    const node = focus ? nodes.get(focus) : null;
    if (what.type) {
      typed += what.type;
      clearTimeout(typedTimer);
      typedTimer = setTimeout(() => { typed = ''; }, TYPE_AHEAD_MS);
      const to = typeAheadTarget(rows, (path) => nodes.get(path)?.dataset.name || '', focus, typed);
      if (to) move(to);
      return true;
    }
    switch (what.action) {
      case 'down': case 'up': case 'home': case 'end': case 'pageDown': case 'pageUp':
        move(moveTarget(rows, focus, what.action, { page: Math.max(1, Math.floor(el.clientHeight / 24) - 1) }), what);
        return true;
      case 'right':
        if (node?.dataset.type === 'dir') {
          if (node.dataset.expanded !== 'true') hooks.onToggle(focus, true);
          else { const first = node.querySelector(':scope > .fe-children > .fe-node:not([data-temp])'); if (first) move(first.dataset.path); }
        }
        return true;
      case 'left':
        if (node?.dataset.type === 'dir' && node.dataset.expanded === 'true') hooks.onToggle(focus, false);
        else if (node) { const up = dirName(focus); if (nodes.has(up)) move(up); }
        return true;
      case 'open': case 'peek':
        if (!node) return true;
        if (node.dataset.type === 'dir') hooks.onToggle(focus, node.dataset.expanded !== 'true');
        // Enter opens a file to work on it (its tab stays, the editor takes the keyboard); Space only looks at it.
        else hooks.onOpen(focus, node._item, what.action === 'open' ? { pin: true } : { pin: false, keep: true });
        return true;
      case 'toggle':
        if (focus) apply(pickRow({ selected, anchor }, focus, { toggle: true }, rows));
        return true;
      case 'selectAll': {
        const all = rows.filter((path) => !isStop(path));
        apply({ selected: new Set(all), anchor: all[0] || null, focus: focus || all[0] || null }, { scroll: false });
        return true;
      }
      case 'menu':
        menuFor(node, { keyboard: true });
        return true;
      default:
        hooks.onAction(what.action, { paths: topLevelOf([...selected]), focus });
        return true;
    }
  }

  // Taken at the window while the tree has the keyboard, before the page's own shortcuts: the whiteboard listens
  // at the document in the capture phase, and a letter typed for a name is not one of the app's keys.
  const keys = (event) => {
    if (document.activeElement !== el) return;
    if (event.type === 'keydown') { if (onKey(event)) { event.preventDefault(); event.stopPropagation(); } return; }
    if (keyAction(event, { mac })) event.stopPropagation();
  };
  for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, keys, true);

  el.addEventListener('focus', () => {
    if (focus && there(focus)) return;
    const first = [...selected].find((path) => nodes.has(path)) || order()[0] || null;
    if (first) apply({ selected: selected.size ? selected : new Set([first]), anchor: anchor || first, focus: first }, { scroll: false });
  });
  let scrollFrame = 0;
  el.addEventListener('scroll', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; hooks.onScroll(el.scrollTop); }); }, { passive: true });

  return {
    /** Show another project's folder: everything that was drawn goes. */
    setRoot(path) {
      endEdit();
      for (const node of [...nodes.values()]) node.remove();
      nodes.clear(); stops.clear(); shown.clear();
      el.textContent = '';
      selected = new Set(); anchor = null; focus = null; wantFirst = false;
      root = path;
      markFocus();
    },
    render,
    renderDir,
    refreshRows,
    order,
    selection,
    select,
    has: (path) => nodes.has(path),
    itemOf: (path) => nodes.get(path)?._item || null,
    rowOf,
    isEditing: () => !!editing,
    startEdit,
    endEdit,
    settleEdit,
    focus: () => el.focus({ preventScroll: true }),
    /** Mark a row for a moment (a file that was just revealed). */
    flash(path) {
      const row = rowOf(path);
      if (!row) return;
      row.scrollIntoView({ block: 'center' });
      row.classList.add('fe-row--ctx-active');
      setTimeout(() => row.classList.remove('fe-row--ctx-active'), 1600);
    },
    scrollTop: () => el.scrollTop,
    setScrollTop(top) { el.scrollTop = top; },
    destroy() {
      for (const type of ['keydown', 'keyup', 'keypress']) window.removeEventListener(type, keys, true);
      more?.disconnect();
      clearTimeout(springTimer); clearTimeout(typedTimer); clearTimeout(pressTimer);
    },
  };
}
