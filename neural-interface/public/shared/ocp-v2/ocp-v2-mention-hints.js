// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — @ mention picker
// One instance per compose, anchored like the slash picker and styled with its
// classes. Typing `@` + a few characters searches what can be mentioned:
// project files and directories, workspace symbols, resources of connected MCP
// servers, and the project's references. Picking a row replaces the token with
// `@token ` and reports the item, which the composer turns into a file part
// when the prompt is sent.
// Token detection, the groups and the file parts are in ocp-v2-composer-logic.js.
// ─────────────────────────────────────────────────────────────────────────────

import { detectMentionToken, applyMention } from './ocp-v2-composer-logic.js';
import { latestOnly } from './ocp-v2-binding.js';

const SEARCH_DEBOUNCE_MS = 140;

export function mountMentionHints(rootEl, inputEl, options = {}) {
  const noop = { isOpen: () => false, hide() {}, navigate() {}, applySelected: () => false, destroy() {} };
  if (!rootEl || !inputEl || typeof options.search !== 'function') return noop;
  const isAvailable = typeof options.isAvailable === 'function' ? options.isAvailable : () => true;

  const browser = document.createElement('div');
  browser.className = 'ocpv2-slash-browser ocpv2-mention-browser';
  browser.hidden = true;
  rootEl.appendChild(browser);

  let items = [];
  let activeIdx = -1;
  let token = null;
  let timer = null;
  // One search owns the picker at a time: a newer keystroke, or hide(), takes
  // it away from the one still out.
  const searches = latestOnly();

  const isOpen = () => browser.classList.contains('open');

  function hide() {
    searches.cancel();
    if (timer) { clearTimeout(timer); timer = null; }
    if (!isOpen()) return;
    browser.classList.remove('open');
    browser.hidden = true;
    browser.innerHTML = '';
    items = [];
    activeIdx = -1;
    token = null;
  }

  // groups: [{ id, label, items: [{ token, label, detail, … }] }] (mentionGroups).
  function show(groups, query) {
    const total = groups.reduce((n, group) => n + group.items.length, 0);
    browser.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'ocpv2-slash-search';
    const icon = document.createElement('span');
    icon.className = 'ocpv2-slash-search-icon';
    icon.textContent = '@';
    const q = document.createElement('span');
    q.className = 'ocpv2-slash-query';
    q.textContent = query;
    const count = document.createElement('span');
    count.className = 'ocpv2-slash-count';
    count.textContent = `${total} result${total === 1 ? '' : 's'}`;
    header.append(icon, q, count);
    browser.appendChild(header);

    const list = document.createElement('div');
    list.className = 'ocpv2-slash-list';
    browser.appendChild(list);
    items = [];
    if (!total) {
      const empty = document.createElement('div');
      empty.className = 'ocpv2-slash-empty';
      empty.textContent = query ? `Nothing matches ${query}` : 'Type to search files, symbols, MCP resources and references';
      list.appendChild(empty);
    }
    for (const group of groups) {
      const section = document.createElement('div');
      section.className = 'ocpv2-slash-group';
      const title = document.createElement('div');
      title.className = 'ocpv2-slash-group-header';
      title.textContent = group.label;
      section.appendChild(title);
      for (const entry of group.items) {
        const idx = items.length;
        const item = document.createElement('div');
        item.className = 'ocpv2-slash-item' + (idx === 0 ? ' active' : '');
        item.dataset.source = group.id;
        const name = document.createElement('span');
        name.className = 'ocpv2-slash-name';
        name.textContent = entry.label;
        item.appendChild(name);
        if (entry.detail) {
          const detail = document.createElement('span');
          detail.className = 'ocpv2-slash-desc';
          detail.textContent = entry.detail;
          item.appendChild(detail);
        }
        // mousedown, not click: click fires after blur, when the caret is gone.
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          activeIdx = idx;
          applySelected();
        });
        item.addEventListener('mousemove', () => {
          if (activeIdx === idx) return;
          items[activeIdx]?.el.classList.remove('active');
          activeIdx = idx;
          item.classList.add('active');
        });
        section.appendChild(item);
        items.push({ entry, el: item });
      }
      list.appendChild(section);
    }
    activeIdx = items.length ? 0 : -1;
    browser.hidden = false;
    browser.classList.add('open');
  }

  function refreshFromInput() {
    if (!isAvailable()) { hide(); return; }
    const found = detectMentionToken(inputEl.value, inputEl.selectionStart ?? inputEl.value.length);
    if (!found) { hide(); return; }
    token = found;
    const mine = searches.begin();
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      let groups;
      try { groups = await options.search(found.query); } catch { groups = []; }
      if (!mine()) return;              // a newer keystroke owns the picker, or it was hidden
      // null: the search was made for a session or a directory the composer
      // has left (ocp-v2-binding.js, searchOnBinding). Its rows are not shown.
      if (groups === null) { hide(); return; }
      show(Array.isArray(groups) ? groups : [], found.query);
    }, SEARCH_DEBOUNCE_MS);
  }

  function navigate(dir) {
    if (!items.length) return;
    items[activeIdx]?.el.classList.remove('active');
    activeIdx = Math.max(0, Math.min(items.length - 1, activeIdx + dir));
    const next = items[activeIdx]?.el;
    if (next) {
      next.classList.add('active');
      next.scrollIntoView({ block: 'nearest' });
    }
  }

  function applySelected() {
    const selected = items[activeIdx];
    if (!selected || !token) { hide(); return false; }
    const entry = selected.entry;
    const { value, caret } = applyMention(inputEl.value, token, entry.token);
    hide();
    inputEl.value = value;
    try { inputEl.setSelectionRange(caret, caret); } catch {}
    inputEl.focus();
    try { options.onPick?.(entry); } catch (err) { console.warn('[ocp-v2-mention-hints] onPick threw', err); }
    return true;
  }

  // Only what the user types opens the picker: text set by code does not.
  const onInput = (event) => { if (event?.isTrusted) refreshFromInput(); else hide(); };
  const onBlur = () => { setTimeout(() => { if (document.activeElement !== inputEl) hide(); }, 120); };
  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('blur', onBlur);

  return {
    isOpen,
    hide,
    navigate,
    applySelected,
    destroy() {
      inputEl.removeEventListener('input', onInput);
      inputEl.removeEventListener('blur', onBlur);
      hide();
      browser.remove();
    },
  };
}
