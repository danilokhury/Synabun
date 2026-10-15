// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: AI autocomplete
// ═══════════════════════════════════════════
//
// Grey text after the caret that Tab accepts: the suggestion as a CodeMirror
// state field and widget, the request that fetches it (asked a moment after
// the last change, aborted by the next one), the keys, and the status-bar
// chip with its popover. What needs no page is decided in editor-ai-logic.js;
// the server side is lib/editor-completion.js.
//
// It ships off. Nothing is requested while `ai.enabled` is off or while the
// server has no `complete` capability, and without that capability there is no
// chip either: against a server that was not restarted the editor is exactly
// as it was. Takes the vendored bundle, the strings and the preferences as
// arguments: it imports nothing of the app.

import {
  cacheKey, chipState, completionWindow, createSuggestionCache, describeFailure, failureKey, formatMs,
  hasPrivateKey, matchesExclude, modelsReadFailed, nextWord, requestBody, shouldRequest, suggestionsExpected, typeThrough, usageLine,
} from './editor-ai-logic.js';
import { EDITOR_COMMANDS, formatKey } from './editor-commands.js';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform || '');
const COMPLETE_URL = '/api/editor/complete';
const FEEDBACK_DELAY_MS = 3000;
const MAX_BACKOFF_MS = 60_000;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children);
  return node;
}

/**
 * @param {object} cm the vendored CodeMirror bundle (editor-loader.js)
 * @param {object} o
 * @param {(key: string, params?: object) => string} o.t
 * @param {{ get: () => object, set: (partial: object) => Promise<boolean>, subscribe: (fn: Function) => Function }} o.prefs
 *   the editor's preferences (editor-prefs.js)
 * @param {() => ({ path: string, language: string, indentUnit: string } | null)} o.getDocument the open document
 * @param {() => { path: string, text: string }[]} [o.getNeighbors] snippets of the other open tabs that go with a
 *   request (pickNeighbors() of editor-ai-logic.js); asked for only when a request is made
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => void} [o.openSettings] opens Settings on the AI autocomplete section
 */
export function editorAi(cm, { t, prefs, getDocument, getNeighbors = () => [], fetchImpl = (...args) => fetch(...args), openSettings = () => {} }) {
  const { Decoration, EditorView, StateEffect, StateField, ViewPlugin, WidgetType } = cm;

  let view = null;            // the editor, while a document is in it
  let capable = false;        // the server has the `complete` capability
  let timer = 0;              // the wait after the last change
  let request = null;         // the request under way: { id, controller }
  let sequence = 0;
  let problem = null;         // the last failure (describeFailure), until a request succeeds
  let failures = 0;           // failures in a row
  let pausedUntil = 0;        // no automatic request before this time (rate limit, repeated failures)
  let pauseTimer = 0;
  let refusedPath = null;     // a file the server said it never reads
  let shownKey = null;        // the cache key of the suggestion on screen
  let shownSeq = 0;           // moves on with every suggestion put in the document...
  let countedSeq = 0;         // ...and this one when it was seen: one that stayed under the completion list is not counted
  const cache = createSuggestionCache();
  const counted = { shown: 0, accepted: 0 };
  let feedbackTimer = 0;
  let chip = null;            // { wrap, button, popover, sep } once mounted
  let listedModels = null;    // the models the popover last listed

  const ai = () => prefs.get().ai;
  const usable = () => capable && ai().enabled;

  // ── The suggestion ──

  class GhostText extends WidgetType {
    constructor(text) { super(); this.text = text; }
    eq(other) { return other.text === this.text; }
    toDOM() { return el('span', { class: 'cm-ghost', 'aria-hidden': 'true', text: this.text }); }
    ignoreEvent() { return false; }
  }

  /** Replaces the suggestion: `{ from, text }`, or null for none. */
  const setSuggestion = StateEffect.define();

  // `{ from, text, hidden }`: `text` would be inserted at `from`. It is not drawn while the completion list is open:
  // it may arrive under the list (a request does not wait for the list to close) and shows when the list is gone.
  const suggestionField = StateField.define({
    create: () => null,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setSuggestion)) value = effect.value ? { ...effect.value, hidden: false } : null;
      const set = tr.effects.some((effect) => effect.is(setSuggestion));
      if (!value) return null;
      if (!set) {
        const selection = tr.newSelection;
        const oneCaret = selection.ranges.length === 1 && selection.main.empty;
        if (tr.docChanged) {
          // Typing what the suggestion begins with leaves the rest of it; any other change drops it.
          let change = null;
          let changes = 0;
          tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => { changes++; change = { from, to, insert: inserted.toString() }; });
          const left = changes === 1 && oneCaret ? typeThrough(value, { ...change, head: selection.main.head }).suggestion : null;
          if (!left) return null;
          value = { ...left, hidden: value.hidden };
        } else if (tr.selection && !(oneCaret && selection.main.head === value.from)) {
          return null;
        }
      }
      const hidden = cm.completionStatus(tr.state) === 'active';
      return hidden === value.hidden ? value : { ...value, hidden };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => (value && !value.hidden
      ? Decoration.set([Decoration.widget({ widget: new GhostText(value.text), side: 1 }).range(value.from)])
      : Decoration.none)),
  });

  const visibleSuggestion = (state) => {
    const value = state.field(suggestionField, false);
    return value && !value.hidden ? value : null;
  };

  // ── Requests ──

  function abortRequest() {
    if (!request) return;
    request.controller.abort();
    request = null;
    renderChip();
  }

  function cancelWait() {
    if (timer) { clearTimeout(timer); timer = 0; }
  }

  function schedule(trigger = 'auto') {
    cancelWait();
    if (!usable()) return;
    timer = setTimeout(() => { timer = 0; ask(trigger); }, trigger === 'manual' ? 0 : ai().debounceMs);
  }

  function pauseFor(ms) {
    pausedUntil = Date.now() + ms;
    clearTimeout(pauseTimer);
    // The chip goes back to "ready" when the wait is over.
    pauseTimer = setTimeout(() => { if (problem?.kind === 'rate') problem = null; renderChip(); }, ms + 50);
  }

  function failed(failure) {
    if (failure.kind === 'disabled') {
      // The server's preferences say off: another window switched it off, or this page never heard.
      prefs.load?.();
      problem = null;
    } else if (failure.kind === 'excluded') {
      refusedPath = getDocument()?.path || null;
      problem = null;
    } else {
      problem = failure;
      failures++;
      if (failure.kind === 'rate') pauseFor(failure.retryAfterMs);
      else if (failure.kind !== 'no-model' && failure.kind !== 'no-endpoint') pauseFor(Math.min(MAX_BACKOFF_MS, 5000 * failures));
    }
    renderChip();
  }

  /** Whether a request may be made for the caret as it is, and for which document. */
  function situation() {
    const doc = getDocument();
    if (!view || !doc) return { check: { ok: false, reason: 'off' }, doc: null };
    const { state } = view;
    const selection = state.selection;
    const head = selection.main.head;
    const line = state.doc.lineAt(head);
    const check = shouldRequest({
      enabled: ai().enabled, capable, readOnly: state.readOnly, focused: view.hasFocus,
      visible: document.visibilityState === 'visible',
      carets: selection.ranges.length, hasSelection: selection.ranges.some((range) => !range.empty),
      composing: view.composing,
      lineAfter: state.sliceDoc(head, line.to), path: doc.path, exclude: ai().exclude,
    });
    return { check, doc, head };
  }

  async function ask(trigger) {
    const { check, doc, head } = situation();
    if (!check.ok || refusedPath === doc.path) return;
    const manual = trigger === 'manual';
    if (!manual && Date.now() < pausedUntil) return;
    // Nothing to choose from yet: asking again would only fail again, until the preferences change.
    if (!manual && (problem?.kind === 'no-model' || problem?.kind === 'no-endpoint')) return;
    const { state } = view;
    const window = completionWindow({ slice: (from, to) => state.sliceDoc(from, to), length: state.doc.length, pos: head });
    if (hasPrivateKey(window.prefix, window.suffix, window.header)) return;
    const key = cacheKey({ path: doc.path, prefix: window.prefix, suffix: window.suffix });
    if (!manual) {
      const kept = cache.get(key);
      if (kept !== undefined) { show(kept, head, key); return; }
    }

    abortRequest();
    // What the other open tabs of this language hold, unless the user switched that off.
    let neighbors = [];
    if (ai().neighbors !== false) { try { neighbors = getNeighbors() || []; } catch { neighbors = []; } }
    const mine = { id: ++sequence, controller: new AbortController() };
    request = mine;
    renderChip();
    let failure = null;
    let completion = null;
    try {
      const res = await fetchImpl(COMPLETE_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: mine.controller.signal,
        body: JSON.stringify(requestBody({ path: doc.path, language: doc.language, indentUnit: doc.indentUnit, window, neighbors, trigger })),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok === true) completion = typeof body.completion === 'string' ? body.completion : '';
      else failure = describeFailure({ status: res.status, body });
    } catch (error) {
      if (mine.controller.signal.aborted) return;
      failure = describeFailure({ error: error?.message });
    }
    if (request !== mine) return;   // given up on while the answer was being read
    request = null;
    if (failure) { failed(failure); return; }
    problem = null;
    failures = 0;
    pausedUntil = 0;
    cache.set(key, completion);
    renderChip();
    show(completion, head, key);
  }

  /**
   * Put a suggestion in the document, when the caret is still where it was asked for. Under an open completion
   * list it is there and not drawn (the field hides it): it shows when the list closes.
   */
  function show(text, pos, key) {
    if (!text || !view) return;
    const { state } = view;
    const selection = state.selection;
    if (selection.ranges.length !== 1 || !selection.main.empty || selection.main.head !== pos) return;
    if (!view.hasFocus || state.readOnly) return;
    shownKey = key;
    shownSeq++;
    view.dispatch({ effects: setSuggestion.of({ from: pos, text }) });
  }

  // ── What the user did with suggestions ──

  function sendFeedback({ leaving = false } = {}) {
    clearTimeout(feedbackTimer);
    feedbackTimer = 0;
    if (!counted.shown && !counted.accepted) return;
    const body = JSON.stringify(counted);
    counted.shown = 0;
    counted.accepted = 0;
    Promise.resolve().then(() => fetchImpl(`${COMPLETE_URL}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: leaving })).catch(() => {});
  }

  function count(what) {
    counted[what]++;
    if (!feedbackTimer) feedbackTimer = setTimeout(() => sendFeedback(), FEEDBACK_DELAY_MS);
  }

  // ── Commands (editor-commands.js binds the keys) ──

  /** Insert `text` at `at` and leave `remainder` (the rest of the suggestion, or nothing) after it. */
  function insert(target, at, text, remainder = '') {
    const end = at + text.length;
    target.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: end },
      effects: setSuggestion.of(remainder ? { from: end, text: remainder } : null),
      // One step of its own: an undo takes the suggestion back whole, and never the typing around it.
      annotations: cm.isolateHistory.of('full'),
      userEvent: 'input.complete',
      scrollIntoView: true,
    });
  }

  /** Tab: take the suggestion. False when there is none (the key then indents, as always). */
  function accept(target) {
    const suggestion = visibleSuggestion(target.state);
    if (!suggestion || target.state.readOnly) return false;
    insert(target, suggestion.from, suggestion.text);
    count('accepted');
    return true;
  }

  /** Mod-→: take the next word of the suggestion and keep the rest. */
  function acceptWord(target) {
    const suggestion = visibleSuggestion(target.state);
    if (!suggestion || target.state.readOnly) return false;
    const word = nextWord(suggestion.text);
    const rest = suggestion.text.slice(word.length);
    insert(target, suggestion.from, word, rest);
    if (!rest) count('accepted');
    return true;
  }

  /** Esc: drop the suggestion. A request that has not answered yet is given up on, and the key goes on to whatever else it closes. */
  function dismiss(target) {
    const suggestion = visibleSuggestion(target.state);
    // With the completion list open the key is the list's: what was asked for the caret stays on its way, and a
    // suggestion that is waiting under the list shows when it is gone. The next Esc is the suggestion's.
    if (!suggestion && cm.completionStatus(target.state) !== null) return false;
    cancelWait();
    abortRequest();
    if (!suggestion) return false;
    if (shownKey) cache.delete(shownKey);   // dismissed: not offered again from memory
    target.dispatch({ effects: setSuggestion.of(null) });
    return true;
  }

  /** Alt-\: ask now, without the wait. False while the feature is off: the key is then typed as usual. */
  function trigger() {
    if (!usable() || !view) return false;
    cancelWait();
    ask('manual');
    return true;
  }

  // ── The editor's side ──

  const isTyping = (update) => update.transactions.some((tr) => tr.docChanged && (tr.isUserEvent('input') || tr.isUserEvent('delete')));

  const watcher = ViewPlugin.fromClass(class {
    constructor(editor) {
      view = editor;
      this.listOpen = false;
    }

    update(update) {
      const listOpen = cm.completionStatus(update.state) !== null;
      const listClosed = this.listOpen && !listOpen;
      this.listOpen = listOpen;
      const suggestion = update.state.field(suggestionField, false);
      if (update.docChanged || update.selectionSet) {
        // Any change to the document or the selection: the answer on its way is for a caret that moved.
        abortRequest();
        cancelWait();
        // A remainder that was typed into needs no new request.
        if (!suggestion && update.docChanged && isTyping(update)) schedule();
      } else if (listClosed && !suggestion && !request && !timer) {
        schedule();   // the completion list went away and nothing is there or on its way for this caret
      }
      // Counted as shown when it is seen, which for one that arrived under the completion list is when the list closes.
      if (suggestion && !suggestion.hidden && countedSeq !== shownSeq) {
        countedSeq = shownSeq;
        count('shown');
      }
      if (update.focusChanged && !update.view.hasFocus) {
        cancelWait();
        abortRequest();
        if (suggestion) queueMicrotask(() => { if (view === update.view && view.state.field(suggestionField, false)) view.dispatch({ effects: setSuggestion.of(null) }); });
      }
    }

    destroy() {
      cancelWait();
      abortRequest();
      view = null;
    }
  }, {
    eventHandlers: {
      // A composition (an IME) is typing of its own kind: the suggestion steps aside for it.
      compositionstart(_event, editor) {
        cancelWait();
        abortRequest();
        if (editor.state.field(suggestionField, false)) editor.dispatch({ effects: setSuggestion.of(null) });
      },
    },
  });

  // ── The chip and its popover ──

  const stateSentence = (state) => {
    if (state === 'off') {
      const doc = getDocument();
      const excluded = ai().enabled && doc && (refusedPath === doc.path || matchesExclude(doc.path, ai().exclude));
      return t(excluded ? 'editor.ai.state.excluded' : 'editor.ai.state.off');
    }
    if (state === 'thinking') return t('editor.ai.state.thinking');
    if (state === 'problem') return problemSentence();
    return t('editor.ai.state.ready');
  };

  const problemSentence = () => t(failureKey(problem), { message: problem?.message || '', seconds: Math.max(1, Math.ceil((pausedUntil - Date.now()) / 1000)) });

  function currentState() {
    const doc = getDocument();
    const excluded = !!doc && (refusedPath === doc.path || matchesExclude(doc.path, ai().exclude));
    return chipState({ capable, enabled: ai().enabled, excluded, busy: !!request, problem });
  }

  function renderChip() {
    if (!chip) return;
    const state = currentState();
    const sentence = state === 'hidden' ? '' : stateSentence(state);
    chip.wrap.hidden = state === 'hidden';
    chip.sep.hidden = state === 'hidden';
    chip.button.dataset.state = state;
    chip.button.dataset.tooltip = sentence;
    chip.button.setAttribute('aria-label', sentence);
    if (!chip.popover.hidden) renderPopover();
  }

  const openPopover = () => chip && !chip.popover.hidden;
  const POPOVER_KEYS = ['keydown', 'keyup', 'keypress'];

  // While the popover is open, the keys pressed in it are its own. Taken at the window in the capture phase: a
  // listener at the document (the whiteboard takes Escape there whenever the keyboard is not in a text field, and
  // the popover's switch is a button) would otherwise have the key before the popover does.
  function onPopoverKey(event) {
    if (!openPopover() || !chip.wrap.contains(event.target)) return;
    event.stopPropagation();
    if (event.type === 'keydown' && event.key === 'Escape') { event.preventDefault(); closePopover({ refocus: true }); }
  }

  function closePopover({ refocus = false } = {}) {
    if (!chip || chip.popover.hidden) return;
    chip.popover.hidden = true;
    chip.button.setAttribute('aria-expanded', 'false');
    for (const type of POPOVER_KEYS) window.removeEventListener(type, onPopoverKey, true);
    if (refocus) chip.button.focus();
  }

  function renderPopover() {
    const q = (id) => chip.popover.querySelector(`#fe-editor-ai-${id}`);
    const config = ai();
    const state = currentState();
    const toggle = q('switch');
    toggle.setAttribute('aria-checked', String(config.enabled));
    const status = q('status');
    status.textContent = stateSentence(state);
    status.dataset.state = state;
    const endpoint = config.engine === 'endpoint';
    q('model-row').hidden = endpoint;
    q('fastest-row').hidden = endpoint;
    const where = q('endpoint');
    where.hidden = !endpoint;
    where.textContent = endpoint ? t(config.endpoint.model ? 'editor.ai.endpointModel' : 'editor.ai.endpointNone', { model: config.endpoint.model }) : '';
    const select = q('model');
    if (!endpoint && listedModels && select.value !== (config.model || '')) fillModels(listedModels);
  }

  function fillModels(models) {
    const select = chip.popover.querySelector('#fe-editor-ai-model');
    const selected = ai().model || '';
    listedModels = models;
    select.textContent = '';
    if (!selected) select.append(el('option', { value: '', text: t('editor.ai.modelNone') }));
    for (const model of models) {
      const price = model.free ? t('editor.ai.priceFree') : model.price ? t('editor.ai.price', { input: model.price.input, output: model.price.output }) : '';
      select.append(el('option', { value: model.id, text: price ? `${model.label} · ${price}` : model.label }));
    }
    // A model that is selected but not listed (hidden since, or its provider signed out) is still named.
    if (selected && !models.some((model) => model.id === selected)) select.append(el('option', { value: selected, text: selected }));
    select.value = selected;
  }

  async function loadPopoverData() {
    const result = chip.popover.querySelector('#fe-editor-ai-result');
    const usage = chip.popover.querySelector('#fe-editor-ai-usage');
    const select = chip.popover.querySelector('#fe-editor-ai-model');
    if (!listedModels) {
      select.textContent = '';
      select.append(el('option', { value: ai().model || '', text: t('editor.ai.modelsLoading') }));
    }
    const read = async (path) => {
      try { const res = await fetchImpl(`${COMPLETE_URL}${path}`); return res.ok ? await res.json() : null; } catch { return null; }
    };
    const [models, today] = await Promise.all([ai().engine === 'endpoint' ? null : read('/models'), read('/usage')]);
    if (!openPopover()) return;
    if (models?.ok) {
      fillModels(Array.isArray(models.models) ? models.models : []);
      if (models.available === false && !result.textContent) result.textContent = t('editor.ai.modelsUnavailable');
    } else if (modelsReadFailed({ engine: ai().engine, models })) {
      // No answer about the models: the list goes back to what it was (the model in use, at least) and says so,
      // instead of "Loading…" for as long as the popover is open.
      fillModels(listedModels || []);
      result.textContent = t('editor.ai.modelsFailed');
    }
    // "No requests today" only for an answer of zero: a read that failed is said to have failed.
    const line = usageLine(today);
    usage.textContent = t(line.key, line.params);
  }

  async function findFastest() {
    const button = chip.popover.querySelector('#fe-editor-ai-fastest');
    const result = chip.popover.querySelector('#fe-editor-ai-result');
    button.disabled = true;
    result.textContent = t('editor.ai.finding');
    let body = null;
    try {
      const res = await fetchImpl(`${COMPLETE_URL}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fastest: true }) });
      body = await res.json().catch(() => null);
    } catch { body = null; }
    button.disabled = false;
    const best = body?.results?.find((row) => row.model === body.fastest);
    if (best) {
      await prefs.set({ ai: { model: best.model } });
      result.textContent = t('editor.ai.fastest', { model: best.model, time: formatMs(best.ms) });
      loadPopoverData();
    } else {
      result.textContent = body?.message || t('editor.ai.fastestNone');
    }
  }

  function buildPopover() {
    const mac = IS_MAC;
    const keys = el('div', { class: 'fe-editor-ai-keys' });
    for (const command of EDITOR_COMMANDS.filter((entry) => entry.feature === 'ai')) {
      keys.append(el('div', { class: 'fe-editor-kb' }, el('kbd', { text: formatKey(command.keys[0], mac) }), ' ', el('span', { text: t(command.titleKey) })));
    }
    const popover = el('div', { class: 'fe-editor-ai-popover', id: 'fe-editor-ai-popover', role: 'dialog', 'aria-labelledby': 'fe-editor-ai-title', hidden: true },
      el('div', { class: 'fe-editor-ai-head' },
        el('span', { class: 'fe-editor-ai-title', id: 'fe-editor-ai-title', text: t('editor.ai.title') }),
        el('button', { type: 'button', class: 'fe-editor-ai-switch', id: 'fe-editor-ai-switch', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': 'fe-editor-ai-title', 'aria-describedby': 'fe-editor-ai-consent' })),
      el('p', { class: 'fe-editor-ai-note', id: 'fe-editor-ai-consent', text: t('editor.ai.consent') }),
      el('p', { class: 'fe-editor-ai-status', id: 'fe-editor-ai-status', role: 'status' }),
      el('p', { class: 'fe-editor-ai-note', id: 'fe-editor-ai-endpoint', hidden: true }),
      el('div', { class: 'fe-editor-ai-row', id: 'fe-editor-ai-model-row' },
        el('label', { for: 'fe-editor-ai-model', text: t('editor.ai.model') }),
        el('select', { class: 'fe-editor-ai-select', id: 'fe-editor-ai-model' })),
      el('div', { class: 'fe-editor-ai-row', id: 'fe-editor-ai-fastest-row' },
        el('button', { type: 'button', class: 'fe-editor-btn', id: 'fe-editor-ai-fastest', text: t('editor.ai.findFastest') }),
        el('span', { class: 'fe-editor-ai-result', id: 'fe-editor-ai-result', role: 'status' })),
      el('p', { class: 'fe-editor-ai-note', id: 'fe-editor-ai-usage' }),
      keys,
      el('button', { type: 'button', class: 'fe-editor-ai-link', id: 'fe-editor-ai-settings', text: t('editor.ai.settings') }));

    popover.querySelector('#fe-editor-ai-switch').addEventListener('click', () => { prefs.set({ ai: { enabled: !ai().enabled } }); });
    popover.querySelector('#fe-editor-ai-model').addEventListener('change', (event) => { if (event.target.value) prefs.set({ ai: { model: event.target.value } }); });
    popover.querySelector('#fe-editor-ai-fastest').addEventListener('click', findFastest);
    popover.querySelector('#fe-editor-ai-settings').addEventListener('click', () => { closePopover(); openSettings(); });
    return popover;
  }

  /**
   * Put the chip in the status bar, in front of the caret's position. Called once the server is known to have
   * the `complete` capability: without it nothing is added to the page.
   * @param {HTMLElement} statusbar #fe-editor-statusbar
   */
  function mountChip(statusbar) {
    if (chip || !statusbar) return;
    const button = el('button', { type: 'button', class: 'fe-editor-ai-chip', id: 'fe-editor-ai', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'fe-editor-ai-popover' },
      el('span', { class: 'fe-editor-ai-label', text: t('editor.ai.chip') }), el('span', { class: 'fe-editor-ai-dot', 'aria-hidden': 'true' }));
    const popover = buildPopover();
    const wrap = el('span', { class: 'fe-editor-ai', id: 'fe-editor-ai-wrap' }, button, popover);
    const sep = el('span', { class: 'fe-editor-sep', id: 'fe-editor-ai-sep' });
    const before = statusbar.querySelector('#fe-editor-cursor');
    if (before) before.before(wrap, sep); else statusbar.append(sep, wrap);
    chip = { wrap, button, popover, sep };

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (openPopover()) { closePopover(); return; }
      popover.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      for (const type of POPOVER_KEYS) window.addEventListener(type, onPopoverKey, true);
      popover.querySelector('#fe-editor-ai-result').textContent = '';
      renderPopover();
      loadPopoverData();
      popover.querySelector('#fe-editor-ai-switch').focus();
    });
    popover.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', () => closePopover());
    // The chip is outside the editor's own element: its keys are stopped here, so they reach no shortcut of the app
    // (the open popover's are taken earlier still: onPopoverKey).
    for (const type of POPOVER_KEYS) wrap.addEventListener(type, (event) => event.stopPropagation());
    renderChip();
  }

  prefs.subscribe(() => {
    // Another model, another list of files, on or off: what was kept and what went wrong belong to the old settings.
    cache.clear();
    problem = null;
    failures = 0;
    pausedUntil = 0;
    refusedPath = null;
    if (!ai().enabled) { cancelWait(); abortRequest(); if (view?.state.field(suggestionField, false)) view.dispatch({ effects: setSuggestion.of(null) }); }
    renderChip();
  });
  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => sendFeedback({ leaving: true }));

  return {
    extension: [suggestionField, watcher],
    accept,
    acceptWord,
    dismiss,
    trigger,
    mountChip,
    /** The server's answer about what it offers: with `complete`, the feature exists on this page. */
    setCapable(on) { capable = !!on; renderChip(); },
    /** Another document was opened, or the panel closed: what was under way belonged to the old one. */
    documentChanged() {
      cancelWait();
      abortRequest();
      problem = problem?.kind === 'no-model' || problem?.kind === 'no-endpoint' ? problem : null;
      refusedPath = null;
      closePopover();
      renderChip();
    },
    /**
     * Whether suggestions are expected for the open document (on, a file that is read, a model to ask). The
     * completion list then keeps the document's words for when it is asked (editor-completion-list.js).
     */
    expectsSuggestions() {
      const doc = getDocument();
      if (!doc) return false;
      return suggestionsExpected({ capable, enabled: ai().enabled, excluded: refusedPath === doc.path || matchesExclude(doc.path, ai().exclude), problem });
    },
    /** The suggestion on screen, or null (tests, and the panel's own checks). */
    suggestion: () => (view ? visibleSuggestion(view.state) : null),
    state: () => currentState(),
  };
}
