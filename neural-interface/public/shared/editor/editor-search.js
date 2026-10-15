// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: find, replace, go to line
// ═══════════════════════════════════════════
//
// The find / replace bar and the go-to-line bar, as CodeMirror panels at the
// top of the editor. The search itself is CodeMirror's (@codemirror/search:
// the query, the match highlighting, next / previous, replace); this module is
// the bar in the editor's existing design (`.fe-editor-find`, `.fe-editor-goto`
// in styles.css), the three query switches and the match count.
// Takes the vendored bundle as an argument.

import { parseLineTarget, positionAt } from './editor-doc.js';

/** Matches counted before the count gives up and says "N+". */
export const COUNT_CAP = 9999;
// After an edit, the matches are counted once typing pauses: a count is a pass over the document.
const RECOUNT_AFTER_EDIT_MS = 150;

const ICON = {
  previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'text') node.textContent = value;
    else if (name === 'html') node.innerHTML = value;
    else if (name === 'tooltip') { node.dataset.tooltip = value; node.setAttribute('aria-label', value); }
    else node.setAttribute(name, value);
  }
  return node;
}

/**
 * The index in `spans` (a flat list of from, to, from, to… in document order) of the match that is exactly
 * `from`–`to`, or -1.
 */
export function matchIndex(spans, from, to) {
  let lo = 0; let hi = spans.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = spans[mid * 2];
    if (at === from) return spans[mid * 2 + 1] === to ? mid : -1;
    if (at < from) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/**
 * @param {object} cm the vendored CodeMirror bundle
 * @param {{ t: (key: string, params?: object) => string }} o
 * @returns {{
 *   extension: any,
 *   openFind: (view: any) => boolean, openReplace: (view: any) => boolean, closeFind: (view: any) => boolean,
 *   toggleFind: (view: any) => boolean, isFindOpen: (state: any) => boolean,
 *   findNext: (view: any) => boolean, findPrevious: (view: any) => boolean,
 *   openGoToLine: (view: any) => boolean, closeGoToLine: (view: any) => boolean,
 *   dismiss: (view: any) => boolean,
 * }}
 */
export function editorSearch(cm, { t }) {
  const {
    EditorSelection, EditorView, SearchQuery, StateEffect, StateField,
    closeSearchPanel, findNext, findPrevious, getPanel, getSearchQuery, openSearchPanel,
    replaceAll, replaceNext, runScopeHandlers, search, searchPanelOpen, setSearchQuery, showPanel,
  } = cm;

  const reveal = (range) => EditorView.scrollIntoView(range, { y: 'nearest', yMargin: 80 });
  // The open find bar of a view. (CodeMirror registers the bar under a function of its own, so getPanel() cannot find it.)
  const findPanels = new WeakMap();

  // ── Find and replace ──

  function createFindPanel(view) {
    let query = getSearchQuery(view.state);
    let spans = [];          // from, to of every counted match
    let capped = false;
    let countTimer = 0;

    const dom = el('div', 'fe-editor-find open', { role: 'search' });
    const findRow = el('div', 'fe-editor-find-row');
    const input = el('input', 'fe-editor-find-input', {
      id: 'fe-editor-find-input', type: 'text', placeholder: t('editor.find.placeholder'), 'aria-label': t('editor.find.label'),
      spellcheck: 'false', autocomplete: 'off', 'main-field': 'true',
    });
    const toggle = (name, text, label) => el('button', 'fe-editor-find-toggle', { type: 'button', text, tooltip: label, 'aria-pressed': 'false', 'data-option': name });
    const caseBtn = toggle('caseSensitive', 'Aa', t('editor.find.matchCase'));
    const wordBtn = toggle('wholeWord', 'ab', t('editor.find.wholeWord'));
    const regexpBtn = toggle('regexp', '.*', t('editor.find.regexp'));
    const count = el('span', 'fe-editor-find-count', { id: 'fe-editor-find-count', 'aria-live': 'polite' });
    const nav = (id, icon, label) => el('button', 'fe-editor-find-nav', { id, type: 'button', html: icon, tooltip: label });
    const prevBtn = nav('fe-editor-find-prev', ICON.previous, t('editor.find.previous'));
    const nextBtn = nav('fe-editor-find-next', ICON.next, t('editor.find.next'));
    const closeBtn = nav('fe-editor-find-close', ICON.close, t('editor.find.close'));
    findRow.append(input, caseBtn, wordBtn, regexpBtn, count, prevBtn, nextBtn, closeBtn);

    const replaceRow = el('div', 'fe-editor-replace-row');
    const replaceInput = el('input', 'fe-editor-replace-input', {
      id: 'fe-editor-replace-input', type: 'text', placeholder: t('editor.find.replacePlaceholder'), 'aria-label': t('editor.find.replaceLabel'),
      spellcheck: 'false', autocomplete: 'off',
    });
    const replaceBtn = el('button', 'fe-editor-replace-btn', { id: 'fe-editor-replace', type: 'button', text: t('editor.find.replace') });
    const replaceAllBtn = el('button', 'fe-editor-replace-btn', { id: 'fe-editor-replace-all', type: 'button', text: t('editor.find.replaceAll') });
    replaceRow.append(replaceInput, replaceBtn, replaceAllBtn);
    dom.append(findRow, replaceRow);

    const toggles = [caseBtn, wordBtn, regexpBtn];
    const isOn = (button) => button.getAttribute('aria-pressed') === 'true';

    function showQuery() {
      if (input.value !== query.search) input.value = query.search;
      if (replaceInput.value !== query.replace) replaceInput.value = query.replace;
      caseBtn.setAttribute('aria-pressed', String(!!query.caseSensitive));
      wordBtn.setAttribute('aria-pressed', String(!!query.wholeWord));
      regexpBtn.setAttribute('aria-pressed', String(!!query.regexp));
      input.classList.toggle('invalid', !!query.search && !query.valid);
    }

    function showCount() {
      const total = spans.length / 2;
      if (!query.search) { count.textContent = ''; return; }
      if (!query.valid) { count.textContent = t('editor.find.invalid'); return; }
      if (!total) { count.textContent = t('editor.find.noResults'); return; }
      const totalText = capped ? `${total}+` : String(total);
      const main = view.state.selection.main;
      const current = matchIndex(spans, main.from, main.to);
      count.textContent = current >= 0
        ? t('editor.find.count', { current: current + 1, total: totalText })
        : t(total === 1 && !capped ? 'editor.find.total.one' : 'editor.find.total.other', { count: totalText });
    }

    function recount() {
      clearTimeout(countTimer);
      countTimer = 0;
      spans = [];
      capped = false;
      if (query.search && query.valid) {
        const cursor = query.getCursor(view.state);
        for (let step = cursor.next(); !step.done; step = cursor.next()) {
          if (spans.length >= COUNT_CAP * 2) { capped = true; break; }
          spans.push(step.value.from, step.value.to);
        }
      }
      showCount();
    }

    // The first match at or after the caret, selected while the keyboard stays in the field.
    function selectNearest() {
      if (!query.search || !query.valid) return;
      const from = view.state.selection.main.from;
      let step = query.getCursor(view.state, from).next();
      if (step.done && from > 0) step = query.getCursor(view.state, 0, from).next();
      if (step.done) return;
      const range = EditorSelection.range(step.value.from, step.value.to);
      view.dispatch({ selection: range, effects: reveal(range), userEvent: 'select.search' });
    }

    function commit({ jump = false } = {}) {
      const regexp = isOn(regexpBtn);
      const next = new SearchQuery({
        search: input.value,
        replace: replaceInput.value,
        caseSensitive: isOn(caseBtn),
        wholeWord: isOn(wordBtn),
        regexp,
        literal: !regexp,
      });
      if (next.eq(query)) return;
      query = next;
      view.dispatch({ effects: setSearchQuery.of(next) });
      input.classList.toggle('invalid', !!next.search && !next.valid);
      recount();
      if (jump) selectNearest();
    }

    input.addEventListener('input', () => commit({ jump: true }));
    replaceInput.addEventListener('input', () => commit());
    for (const button of toggles) {
      button.addEventListener('click', () => {
        button.setAttribute('aria-pressed', String(!isOn(button)));
        commit({ jump: true });
        input.focus();
      });
    }
    prevBtn.addEventListener('click', () => findPrevious(view));
    nextBtn.addEventListener('click', () => findNext(view));
    closeBtn.addEventListener('click', () => closeSearchPanel(view));
    replaceBtn.addEventListener('click', () => replaceNext(view));
    replaceAllBtn.addEventListener('click', () => replaceAll(view));

    dom.addEventListener('keydown', (event) => {
      // The editor's own keys that also work from here: save, find, go to line, next / previous, Escape.
      if (runScopeHandlers(view, event, 'search-panel')) { event.preventDefault(); return; }
      if (event.key !== 'Enter' || event.isComposing) return;
      if (event.target === input) {
        event.preventDefault();
        (event.shiftKey ? findPrevious : findNext)(view);
      } else if (event.target === replaceInput) {
        event.preventDefault();
        (event.metaKey || event.ctrlKey ? replaceAll : replaceNext)(view);
      }
    });

    showQuery();

    const panel = {
      dom,
      top: true,
      mount() {
        input.focus();
        input.select();
        recount();
      },
      update(update) {
        let queryChanged = false;
        let replaced = false;
        for (const tr of update.transactions) {
          if (tr.isUserEvent('input.replace')) replaced = true;
          for (const effect of tr.effects) {
            if (effect.is(setSearchQuery) && !effect.value.eq(query)) { query = effect.value; queryChanged = true; }
          }
        }
        if (queryChanged) showQuery();
        if (queryChanged || replaced) recount();
        else if (update.docChanged) {
          // Typing in the document: count again once it pauses. Until then the last count stays on screen.
          clearTimeout(countTimer);
          countTimer = setTimeout(recount, RECOUNT_AFTER_EDIT_MS);
        } else if (update.selectionSet && !countTimer) showCount();
      },
      destroy() {
        clearTimeout(countTimer);
        if (findPanels.get(view) === panel) findPanels.delete(view);
      },
      focusReplace() { replaceInput.focus(); replaceInput.select(); },
    };
    findPanels.set(view, panel);
    return panel;
  }

  const isFindOpen = (state) => searchPanelOpen(state);
  const closeFind = (view) => closeSearchPanel(view);

  function openFind(view) {
    closeGoToLine(view, { refocus: false });
    return openSearchPanel(view);
  }

  function openReplace(view) {
    openFind(view);
    findPanels.get(view)?.focusReplace();
    return true;
  }

  const toggleFind = (view) => (isFindOpen(view.state) ? closeFind(view) : openFind(view));

  // ── Go to line ──

  const setGoToLine = StateEffect.define();

  function createGoToLinePanel(view) {
    const dom = el('div', 'fe-editor-goto open');
    const label = el('label', 'fe-editor-goto-label', { for: 'fe-editor-goto-input', text: t('editor.goto.label') });
    const input = el('input', 'fe-editor-goto-input', {
      id: 'fe-editor-goto-input', type: 'text', inputmode: 'numeric', placeholder: t('editor.goto.placeholder'),
      spellcheck: 'false', autocomplete: 'off',
    });
    const hint = el('span', 'fe-editor-goto-hint');
    dom.append(label, input, hint);
    const showHint = () => { hint.textContent = t('editor.goto.range', { max: view.state.doc.lines }); };

    function go() {
      const target = parseLineTarget(input.value);
      if (!target) { input.classList.add('invalid'); return; }
      const { pos } = positionAt(view.state.doc, target.line, target.column);
      view.dispatch({
        selection: { anchor: pos },
        effects: [setGoToLine.of(false), EditorView.scrollIntoView(pos, { y: 'start', yMargin: 100 })],
        userEvent: 'select',
      });
      view.focus();
    }

    input.addEventListener('input', () => input.classList.remove('invalid'));
    dom.addEventListener('keydown', (event) => {
      if (runScopeHandlers(view, event, 'search-panel')) { event.preventDefault(); return; }
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); go(); }
    });

    showHint();
    return {
      dom,
      top: true,
      mount() { input.focus(); },
      update(update) { if (update.docChanged) showHint(); },
    };
  }

  const goToLineField = StateField.define({
    create: () => false,
    update(open, tr) {
      for (const effect of tr.effects) if (effect.is(setGoToLine)) open = effect.value;
      return open;
    },
    provide: (field) => showPanel.from(field, (open) => (open ? createGoToLinePanel : null)),
  });

  const isGoToLineOpen = (state) => state.field(goToLineField, false) === true;

  function openGoToLine(view) {
    if (isGoToLineOpen(view.state)) {
      const input = getPanel(view, createGoToLinePanel)?.dom.querySelector('input');
      input?.focus();
      input?.select();
      return true;
    }
    if (isFindOpen(view.state)) closeSearchPanel(view);
    view.dispatch({ effects: setGoToLine.of(true) });
    return true;
  }

  function closeGoToLine(view, { refocus = true } = {}) {
    if (!isGoToLineOpen(view.state)) return false;
    const hadFocus = getPanel(view, createGoToLinePanel)?.dom.contains(view.root.activeElement);
    view.dispatch({ effects: setGoToLine.of(false) });
    if (refocus && hadFocus) view.focus();
    return true;
  }

  /** Close whichever bar is open. False when neither was (Escape then does what it does in the text). */
  const dismiss = (view) => closeGoToLine(view) || closeFind(view);

  return {
    extension: [
      search({ top: true, createPanel: createFindPanel, scrollToMatch: (range) => reveal(range) }),
      goToLineField,
    ],
    openFind,
    openReplace,
    closeFind,
    toggleFind,
    isFindOpen,
    findNext: (view) => findNext(view),
    findPrevious: (view) => findPrevious(view),
    openGoToLine,
    closeGoToLine,
    dismiss,
  };
}
