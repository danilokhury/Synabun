// Model routes: draft-only editor. All model data comes through asst-route-models.
// The global default and saved preferences are written together only on Save.
import { clampEffortId, getEffortLevelsForModel, modelEffortIds, fetchClaudeAccounts, fetchCodexAccounts, getCachedClaudeAccounts, getCachedCodexAccounts, getClaudeWorkerAccountId, getCodexWorkerAccountId } from '../agent-runtime-options.js';
import { accountSummary, accountName, accountBadge, accountIdentity } from '../account-view.js';
import { accountUsageText, autoAccountLabel } from '../account-usage.js';
import { getProviderMeta } from '../provider-icons.js';
import { getRouting, putRouting } from './asst-api.js';
import { catalogModelRow, hiddenModelFor, ICON_CARET, openModelMenu } from './asst-brain-picker.js';
import { closeMenu, currentMenu } from './asst-menu.js';
import { loadRouteModels, routeModelLabel, routeModelsStatus, watchRouteModels } from './asst-route-models.js';
import { designRouteSight, openModelsManager, routeCatalogRow, routeModeLabel } from './asst-route.js';
import { DEFAULT_ROUTE_MODE, normalizeRouteMode, ROUTE_MODES } from './asst-state.js';

const ICON_ROUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h15l-4-4M20 17H5l4 4"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
const ICON_RESET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/></svg>';
const ICON_CHOICE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';
const ICON_AUTO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="3"/></svg>';
const ICON_ISSUE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4v4m0 3v.1"/></svg>';
let editor = null;
let uid = 0;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const rowsOf = catalog => Object.values(catalog || {}).flatMap(v => Array.isArray(v) ? v : []);
// The task classes the translation files name; a test keeps this list equal to them. A class the
// server knows and the strings do not keeps the server's own label, instead of a key that i18n
// would report as missing.
export const TRANSLATED_ROUTE_CLASSES = Object.freeze(['automation', 'browser', 'chat', 'code', 'complex', 'computer', 'design', 'image_gen', 'quick', 'research', 'review', 'video_gen']);
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function translator(t) {
  return (key, fallback, params) => {
    const text = t?.(key, params);
    return typeof text === 'string' && text !== key ? text : String(fallback).replace(/\{(\w+)\}/g, (_, k) => params?.[k] ?? `{${k}}`);
  };
}
function choiceKey(p) { return p ? JSON.stringify([p.kind || 'direct', p.provider || '', p.model || '', p.effort || '', p.accountId || '']) : ''; }

export function routeAccountView(pref, task, brain, accounts, workers = {}, t = null) {
  const tr = translator(t);
  const empty = { label: tr('assistant.routes.editorUnusedValue', '—'), readOnly: true, options: [], hint: '' };
  if (!pref || pref.provider === 'opencode') return empty;
  const direct = task.id === 'chat' || routeExecutionKind(pref, task, brain) === 'direct';
  const provider = task.id === 'chat' ? brain.provider : pref.provider;
  if (!['claude-code', 'codex'].includes(provider)) return empty;
  const rows = accounts[provider] || [];
  const providerView = provider === 'codex' ? 'codex' : 'claude';
  const id = task.id === 'chat' ? brain.accountId || 'default' : pref.accountId || (direct ? brain.accountId || 'default' : null);
  const selected = rows.find(a => a.id === id);
  const missing = id && id !== 'auto' && !selected;
  const removed = tr('assistant.routes.account.removed', '{id} · account removed', { id });
  const warning = missing ? tr('assistant.routes.account.removedHint', 'Account removed. Save another account choice before running this route.') : selected?.signedIn === false ? tr('assistant.routes.account.signedOut', 'Signed out. Sign in from the provider account menu before running this route.') : '';
  const worker = rows.find(a => a.id === (workers[provider] || 'default'));
  const label = id === 'auto' ? autoAccountLabel(t) : selected ? accountSummary(selected, providerView) : missing ? removed : tr('assistant.routes.account.workersDefault', 'Workers default');
  const options = [
    { id: '', label: direct ? tr('assistant.routes.editorInConversation', 'This conversation') : tr('assistant.routes.account.workersDefault', 'Workers default'), desc: worker ? accountSummary(worker, providerView) : '', selected: !pref.accountId },
    { id: 'auto', label: autoAccountLabel(t), desc: tr('assistant.accountUsage.autoHint', 'Signed-in subscriptions only. Another account runs on a worker.'), selected: id === 'auto' },
    ...rows.map(a => ({ id: a.id, label: accountName(a, providerView), tag: accountBadge(a, providerView).text, desc: a.signedIn === false ? tr('assistant.routes.account.signedOut', 'Signed out. Sign in from the provider account menu before running this route.') : [accountIdentity(a), accountUsageText(a, t)].filter(Boolean).join(' · '), selected: !!pref.accountId && a.id === id })),
  ];
  return { label, readOnly: task.id === 'chat', options, warning, hint: warning || (selected ? `${label} · ${accountUsageText(selected, t)}` : label) };
}

export function routeModelAccount(pref, provider) { return pref?.provider === provider ? pref.accountId || null : null; }

/** Only actual choices change the draft. Catalog label/by updates are not user edits. */
export function routeEditorPatch(mode, initialMode, prefs, edits) {
  const patch = {};
  if (mode !== initialMode) patch.defaultMode = mode;
  const preferences = Object.fromEntries(Object.entries(edits).filter(([key, p]) => choiceKey(p) !== choiceKey(prefs[key])));
  if (Object.keys(preferences).length) patch.preferences = preferences;
  return patch;
}

/** Same rule as the router's preferenceTarget: direct on another provider is a worker. */
export function routeExecutionKind(pref, row, brain) {
  if (!pref) return row.dispatchOnly ? 'dispatch' : null;
  return row.dispatchOnly || pref.kind !== 'direct' || pref.provider !== brain?.provider ? 'dispatch' : 'direct';
}

/** Availability is an explanation, never a rewrite of the stored preference. */
export function routePreferenceIssue(pref, task, catalog, { hidden = hiddenModelFor, partial = false } = {}) {
  if (!pref) return null;
  if (hidden(pref.provider, pref.model)) return 'disabled';
  if (!catalog || partial) return 'unverified';
  const row = routeCatalogRow(pref, catalog);
  // Design's alias resolution and confirmed sight rule are identical to the existing editor.
  const sight = task.visionOnly ? designRouteSight(pref, catalog) : null;
  if (task.visionOnly && sight !== 'ok') return sight === 'unavailable' ? 'unavailable' : sight === 'blind' ? 'blind' : 'unknownVision';
  if (!row) return 'missing';
  if (row.status === 'unavailable') return 'unavailable';
  if (task.requires && row.outputs?.[task.requires] !== true) return 'incapable';
  if ((task.id === 'computer' || task.id === 'vision') && row.vision === false) return 'blind';
  if (pref.effort && !getEffortLevelsForModel(pref.provider, row).some(e => e.id === pref.effort)) return 'effort';
  return null;
}

export async function openRoutesEditor(hooks = {}) {
  if (editor) { editor.focus(); return editor; }
  const tr = translator(hooks.t);
  const id = `asst-routes-${++uid}`;
  const returnTo = document.activeElement;
  const overlay = el('div', 'asst-modal-overlay asst-routes-overlay');
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', `${id}-title`);
  const modal = el('div', 'asst-modal asst-routes-modal');
  const head = el('div', 'asst-modal-head');
  const icon = el('span', 'asst-icon'); icon.innerHTML = ICON_ROUTE; icon.setAttribute('aria-hidden', 'true');
  const title = el('span', '', tr('assistant.routes.editorTitle', 'Model routes')); title.id = `${id}-title`;
  const closeBtn = button('asst-iconbtn asst-modal-close', tr('common.close', 'Close'), () => close('close'));
  closeBtn.innerHTML = ICON_X;
  head.append(icon, title, closeBtn);
  const body = el('div', 'asst-modal-body');
  const cue = button('asst-routes-scroll-cue', '', () => body.scrollBy({ top: body.clientHeight * 0.7, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
  cue.hidden = true;
  const confirmation = el('div', 'asst-routes-confirm'); confirmation.hidden = true;
  const foot = el('div', 'asst-modal-foot');
  const resetAllBtn = button('asst-btn asst-btn-secondary asst-routes-reset-all', tr('assistant.routes.resetAll', 'Reset all'), () => confirm('reset', 'reset-all'));
  const draft = el('span', 'asst-routes-draft'); draft.setAttribute('role', 'status');
  const cancelBtn = button('asst-btn asst-btn-secondary asst-routes-cancel', tr('common.cancel', 'Cancel'), () => close('cancel'));
  const saveBtn = button('asst-btn asst-btn-primary asst-routes-save', tr('common.save', 'Save'), save);
  closeBtn.dataset.focusKey = 'close'; resetAllBtn.dataset.focusKey = 'reset-all';
  cancelBtn.dataset.focusKey = 'cancel'; saveBtn.dataset.focusKey = 'save';
  foot.append(resetAllBtn, draft, cancelBtn, saveBtn);
  modal.append(head, body, cue, confirmation, foot); overlay.append(modal);

  const state = { data: null, catalog: null, version: null, mode: DEFAULT_ROUTE_MODE, initialMode: DEFAULT_ROUTE_MODE, prefs: {}, patch: {}, loading: true, modelsLoading: true, modelError: false, error: '', conflict: false, saving: false, confirm: null, suspended: false, offline: navigator.onLine === false, menuFocus: '', notice: '' };
  const effectivePref = key => own(state.patch, key) ? state.patch[key] : state.prefs[key] || null;
  const changes = () => routeEditorPatch(state.mode, state.initialMode, state.prefs, state.patch);
  const dirty = () => Object.keys(changes()).length > 0;
  const countChoices = () => new Set([...Object.keys(state.prefs), ...Object.keys(state.patch)].filter(k => effectivePref(k))).size;
  const brain = () => hooks.getBrain?.() || {};
  const threshold = () => Math.round((state.data?.routing?.askBelow ?? hooks.getRouting?.()?.askBelow ?? 0.75) * 100);
  const modelsWatch = watchRouteModels(catalog => {
    if (!overlay.isConnected || !state.data) return;
    const focusKey = document.activeElement?.dataset?.focusKey || state.menuFocus;
    closeMenu(); state.catalog = catalog; state.modelError = routeModelsStatus().partial; state.modelsLoading = false;
    state.notice = tr('assistant.routes.editorState.modelsUpdated', 'Model list updated. Your unsaved changes are kept.');
    render(focusKey);
  });

  function button(cls, label, action) {
    const b = el('button', cls, label); b.type = 'button'; b.setAttribute('aria-label', label); if (action) b.addEventListener('click', action); return b;
  }
  function fieldButton(cls, task, field, label, action) {
    const b = button(`asst-dd ${cls}`, '', action);
    b.dataset.focusKey = `${task.id}-${field}`;
    b.setAttribute('aria-label', tr('assistant.routes.fieldLabel', '{task}: {field}, {value}', { task: task.label, field, value: label }));
    b.append(el('span', 'asst-dd-label', label));
    return b;
  }
  function caret(b) { const c = el('span', 'asst-dd-caret'); c.innerHTML = ICON_CARET; c.setAttribute('aria-hidden', 'true'); b.append(c); b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); }
  function focus(key) {
    const target = key && [...modal.querySelectorAll('[data-focus-key]')].find(n => n.dataset.focusKey === key && !n.disabled);
    (target || closeBtn).focus({ preventScroll: true });
  }
  function finishClose() {
    if (!overlay.isConnected) return;
    closeMenu(); modelsWatch.stop(); resizeObserver?.disconnect();
    window.removeEventListener('keydown', onKey, true); document.removeEventListener('focusin', onFocus, true);
    window.removeEventListener('online', network); window.removeEventListener('offline', network);
    overlay.remove(); editor = null;
    try { hooks.onClose?.(); } catch { /* host callback */ }
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  }
  function close(initiator) {
    if (state.saving || state.suspended) return;
    if (dirty()) { confirm('discard', typeof initiator === 'string' ? initiator : undefined); return; }
    finishClose();
  }
  function confirmationOff() {
    state.confirm = null; confirmation.hidden = true; body.inert = false; foot.hidden = false; closeBtn.disabled = state.saving; updateFoot(); focus(state.confirmFocus);
  }
  // `initiator` is the focus key of the button that asked: WebKit on macOS does not focus
  // a button on click, so the active element cannot say which control to return to.
  function confirm(kind, initiator) {
    if (state.saving || !state.data || (kind === 'reset' && !countChoices())) return;
    closeMenu(); state.confirmFocus = initiator || document.activeElement?.dataset?.focusKey; state.confirm = kind;
    body.inert = true; cue.hidden = true; foot.hidden = true; closeBtn.disabled = true; confirmation.hidden = false; confirmation.innerHTML = '';
    confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-labelledby', `${id}-confirm`);
    const copy = el('div', 'asst-routes-confirm-copy');
    const label = el('strong', '', kind === 'discard' ? tr('assistant.routes.editorState.discardTitle', 'Discard unsaved changes?') : tr('assistant.routes.editorState.resetTitle', 'Reset {count} saved choices?', { count: countChoices() })); label.id = `${id}-confirm`;
    copy.append(label, el('span', '', kind === 'discard' ? tr('assistant.routes.editorState.discardDesc', 'Your saved settings will stay as they are.') : tr('assistant.routes.editorState.resetDesc', 'The assistant will choose for these tasks. Nothing changes until you save.')));
    const keep = button('asst-btn asst-btn-secondary asst-routes-keep', tr('assistant.routes.editorState.keepEditing', 'Keep editing'), confirmationOff);
    const proceed = button('asst-btn asst-btn-secondary asst-routes-confirm-action', kind === 'discard' ? tr('assistant.routes.editorState.discard', 'Discard changes') : tr('assistant.routes.editorState.resetConfirm', 'Reset choices'), () => {
      if (kind === 'discard') { finishClose(); return; }
      for (const key of new Set([...Object.keys(state.prefs), ...Object.keys(state.patch)])) state.patch[key] = null;
      confirmationOff(); render(); resetAllBtn.focus();
    });
    confirmation.append(copy, keep, proceed); keep.focus();
  }
  function tabbables() {
    return [...modal.querySelectorAll('button, input, [tabindex="0"]')].filter(n => !n.disabled && !n.closest('[hidden], [inert]') && n.getClientRects().length && (n.type !== 'radio' || n.checked));
  }
  function onKey(e) {
    if (state.suspended) return;
    const menu = currentMenu();
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (menu) closeMenu({ restoreFocus: true });
      else if (state.confirm) confirmationOff();
      else close();
      return;
    }
    if (e.key === 'Tab') {
      const nodes = tabbables(); if (!nodes.length) { e.preventDefault(); return; }
      if (menu) {
        closeMenu({ restoreFocus: true });
        const i = nodes.indexOf(document.activeElement);
        e.preventDefault(); e.stopImmediatePropagation(); nodes[(i + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length].focus();
      } else if ((!e.shiftKey && document.activeElement === nodes.at(-1)) || (e.shiftKey && document.activeElement === nodes[0]) || !modal.contains(document.activeElement)) {
        e.preventDefault(); e.stopImmediatePropagation(); (e.shiftKey ? nodes.at(-1) : nodes[0]).focus();
      }
    }
  }
  function onFocus(e) {
    if (!state.suspended && !overlay.contains(e.target) && !currentMenu()?.contains(e.target)) (tabbables()[0] || closeBtn).focus();
  }
  function network() { state.offline = navigator.onLine === false; render(); }
  overlay.addEventListener('keydown', e => e.stopPropagation());
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  body.addEventListener('scroll', updateCue, { passive: true });
  // Own Escape before the workspace's document capture shortcuts (including
  // the whiteboard). The listener is removed with this editor and suspended
  // while the Models manager is open.
  window.addEventListener('keydown', onKey, true); document.addEventListener('focusin', onFocus, true);
  window.addEventListener('online', network); window.addEventListener('offline', network);
  document.body.append(overlay);
  // On the next frame: showing or hiding the cue resizes the body it is measured from, and a
  // write inside the observer's own callback makes WebKit report a ResizeObserver loop error.
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => requestAnimationFrame(updateCue)) : null; resizeObserver?.observe(body);
  editor = { el: overlay, close, focus: () => focus() };

  function updateCue() {
    if (!overlay.isConnected || state.confirm || state.suspended) return;
    const more = state.mode === 'never' && body.scrollHeight - body.clientHeight - body.scrollTop > 4;
    cue.hidden = !more;
    cue.textContent = tr('assistant.routes.editorState.moreBelow', 'More task routes below ↓'); cue.setAttribute('aria-label', cue.textContent);
  }
  function issueText(issue, task) {
    switch (issue) {
      case 'disabled': return tr('assistant.routes.issue.disabled', 'Hidden in Models. Show it there or choose another model.');
      case 'missing': return tr('assistant.routes.issue.missing', 'Not in the current list. Reload models, choose a listed model or reset this choice.');
      case 'unavailable': return tr('assistant.routes.issue.unavailable', 'Model unavailable. Choose an available model or reset this choice.');
      case 'blind': return tr('assistant.routes.issue.blind', 'This task needs vision. Choose a model that can see images.');
      case 'unknownVision': return tr('assistant.routes.issue.unknownVision', 'Vision is unverified. Choose a model known to see images or reset this choice.');
      case 'incapable': return tr('assistant.routes.issue.incapable', 'This model cannot generate {medium}. Choose one that can.', { medium: tr(`assistant.routes.medium.${task.requires === 'video' ? 'videos' : 'images'}`, task.requires === 'video' ? 'videos' : 'images') });
      case 'effort': return tr('assistant.routes.issue.effort', 'Saved effort is unsupported. Choose a supported level or use the default.');
      default: return tr('assistant.routes.issue.unverified', 'Could not verify this model. Reload models before relying on this choice.');
    }
  }
  function tasks() {
    const list = (state.data?.taskClasses || []).filter(c => c?.id).map(c => ({ ...c, visionOnly: c.vision === true, label: TRANSLATED_ROUTE_CLASSES.includes(c.id) ? tr(`assistant.routes.classes.${c.id}.label`, c.label || c.id) : (c.label || c.id), description: TRANSLATED_ROUTE_CLASSES.includes(c.id) ? tr(`assistant.routes.classes.${c.id}.desc`, c.description || '') : (c.description || '') }));
    // Actionable tasks first; Chat is retained for compatibility but never routed.
    const chat = list.findIndex(task => task.id === 'chat'); if (chat >= 0) list.push(...list.splice(chat, 1));
    if (!list.some(t => t.id === 'vision')) list.push({ id: 'vision', label: tr('assistant.routes.visionRow', 'Screenshots & images'), description: tr('assistant.routes.visionDesc', 'Fallback when a task needs a model that can see.'), defaultKind: 'direct', visionOnly: false });
    return list;
  }
  function setChoice(key, pref, focusKey) { state.patch[key] = pref; state.notice = ''; render(focusKey); }
  function effortName(value) { return tr(`assistant.routes.efforts.${value}`, value); }
  function defaultEffort(row) { return row?.defaultEffort ? tr('assistant.routes.effortAutoDefault', 'Default · {effort}', { effort: effortName(row.defaultEffort) }) : tr('assistant.routes.effortDefaultUnknown', 'Default · unknown'); }
  function updateFoot() {
    const changed = dirty(); const count = Object.keys(changes().preferences || {}).length + (own(changes(), 'defaultMode') ? 1 : 0);
    draft.textContent = state.saving ? tr('assistant.routes.editorState.saving', 'Saving…') : changed ? count === 1 ? tr('assistant.routes.editorState.unsavedOne', '1 unsaved change') : tr('assistant.routes.editorState.unsaved', '{count} unsaved changes', { count }) : tr('assistant.routes.editorState.noChanges', 'No unsaved changes');
    draft.dataset.dirty = changed ? 'true' : 'false';
    const invalidEdit = tasks().some(t => {
      const p = changes().preferences?.[t.id]; if (!p) return false;
      const issue = routePreferenceIssue(p, t, state.catalog, { partial: state.modelError });
      return (t.visionOnly || t.requires) && issue && issue !== 'effort';
    });
    saveBtn.disabled = !state.data || !changed || state.loading || state.saving || state.conflict || state.offline || invalidEdit;
    saveBtn.title = invalidEdit ? tr('assistant.routes.editorState.fixChoices', 'Fix the highlighted choices or reset them before saving.') : '';
    resetAllBtn.disabled = !state.data || !countChoices() || state.saving;
    resetAllBtn.hidden = state.mode !== 'never';
    cancelBtn.disabled = state.saving; closeBtn.disabled = state.saving || !!state.confirm;
    body.inert = state.saving || !!state.confirm;
    modal.dataset.dirty = changed ? 'true' : 'false';
  }
  function banner(text, actionLabel, action, tone = 'status') {
    const b = el('div', `asst-routes-error${tone === 'status' ? ' asst-routes-notice' : ''}`); b.setAttribute('role', tone === 'error' ? 'alert' : 'status'); b.append(el('span', '', text));
    if (action) b.append(button('asst-btn asst-btn-secondary', actionLabel, action)); body.append(b);
  }
  function render(focusKey) {
    const scroll = body.scrollTop;
    const active = focusKey || document.activeElement?.dataset?.focusKey;
    body.innerHTML = ''; body.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    if (state.error) banner(state.error, tr('assistant.routes.reload', 'Reload'), () => load(true), 'error');
    if (state.offline) banner(tr('assistant.routes.editorState.offline', 'Offline. Your edits are kept. Reconnect to save or reload models.'));
    if (state.notice) banner(state.notice);
    if (state.loading && !state.data) body.append(el('div', 'asst-modal-note', tr('assistant.routes.editorState.loadingRoutes', 'Loading routing settings and models…')));
    if (!state.data) { updateFoot(); return; }
    const section = el('section', 'asst-routes-section');
    const heading = el('h2', 'asst-routes-section-title', tr('assistant.routes.whenToAsk', 'When to ask')); heading.id = `${id}-modes`;
    section.append(heading);
    const modes = el('div', 'asst-routes-modes'); modes.setAttribute('role', 'radiogroup'); modes.setAttribute('aria-labelledby', heading.id);
    const modeCopy = {
      'always-ask': 'Asks before every task. Routes saved in Never ask are offered first on the route card.',
      'ask-unsure': 'Asks below {pct}% confidence or if a model cannot run the task. Routes saved in Never ask are offered first on the route card.',
      never: 'Runs valid saved routes immediately; the Assistant chooses for other tasks. Plain Chat stays on the current brain.',
    };
    for (const mode of ROUTE_MODES) {
      const label = el('label', 'asst-routes-mode'); label.dataset.mode = mode;
      const input = document.createElement('input'); input.type = 'radio'; input.name = `${id}-mode`; input.value = mode; input.checked = mode === state.mode; input.dataset.focusKey = `mode-${mode}`;
      input.setAttribute('aria-labelledby', `${id}-${mode}-label`); input.setAttribute('aria-describedby', `${id}-mode-desc`);
      const name = el('span', 'asst-routes-mode-label', routeModeLabel(mode, hooks.t)); name.id = `${id}-${mode}-label`;
      label.append(input, name);
      input.addEventListener('change', () => { if (input.checked) { closeMenu(); state.mode = mode; state.notice = ''; body.scrollTop = 0; render(`mode-${mode}`); } }); modes.append(label);
    }
    const desc = el('p', 'asst-routes-mode-desc', tr(`assistant.routes.modeSummary.${state.mode}`, modeCopy[state.mode], { pct: threshold() })); desc.id = `${id}-mode-desc`;
    section.append(modes, desc);
    const current = hooks.getRouting?.();
    if (current?.mode != null) {
      const note = el('p', 'asst-routes-session-note', tr('assistant.routes.editorSessionOverride', 'This conversation overrides the default: {mode}.', { mode: routeModeLabel(current.effectiveMode || current.mode, hooks.t) }));
      note.title = note.textContent; section.append(note);
    }
    body.append(section);
    // The draft is independent of the rendered table: mode switches never clear
    // route edits, and updateFoot counts them while the table is absent.
    if (state.mode !== 'never') {
      updateFoot();
      if (active && !state.confirm && !state.suspended) focus(active);
      requestAnimationFrame(updateCue);
      return;
    }

    const table = el('section', 'asst-routes-section asst-routes-tasks');
    const top = el('div', 'asst-routes-section-head');
    const taskTitle = el('div', 'asst-routes-task-title');
    const taskHeading = el('h2', 'asst-routes-section-title', tr('assistant.routes.taskRoutes', 'Task routes'));
    const brainLabel = hooks.brainName?.() || routeModelLabel(brain(), state.catalog) || tr('assistant.routes.theBrain', 'The assistant');
    taskHeading.title = tr('assistant.routes.brainLabel', 'Routing brain: {model}', { model: brainLabel }); taskTitle.append(taskHeading);
    top.append(taskTitle);
    const actions = el('div', 'asst-routes-list-actions');
    const reload = button('asst-btn asst-btn-secondary asst-routes-reload-models', state.modelsLoading ? tr('assistant.routes.editorState.loadingModels', 'Loading models…') : tr('assistant.routes.reloadModels', 'Reload models'), reloadModels); reload.disabled = state.modelsLoading || state.saving || state.offline; reload.dataset.focusKey = 'reload-models';
    const manage = button('asst-btn asst-btn-secondary asst-routes-manage-models', tr('assistant.models.manage', 'Manage models…'), () => manageModels('manage-models')); manage.dataset.focusKey = 'manage-models';
    actions.append(manage, reload); top.append(actions); table.append(top);
    if (state.modelsLoading) table.append(el('div', 'asst-modal-note', tr('assistant.routes.editorState.loadingModels', 'Loading models…')));
    else if (state.modelError) {
      const note = el('div', 'asst-routes-catalog-note'); note.setAttribute('role', 'status'); note.append(el('span', '', tr('assistant.routes.editorState.modelsFailed', 'Could not refresh the model list. Showing provider lists where available. Reload models to verify your choices.'))); table.append(note);
    } else if (!rowsOf(state.catalog).length) table.append(el('div', 'asst-routes-catalog-note', tr('assistant.routes.editorState.modelsEmpty', 'No models are available. Check Models or connect a provider, then reload.')));
    const columns = el('div', 'asst-routes-columns'); columns.setAttribute('aria-hidden', 'true');
    for (const key of ['task', 'model', 'effort', 'run', 'account', 'reset']) columns.append(el('span', '', tr(`assistant.routes.columns.${key}`, key)));
    table.append(columns);
    const list = el('div', 'asst-routes-list');
    const taskList = tasks();
    for (const task of taskList) list.append(taskRow(task));
    if (!taskList.length) list.append(el('div', 'asst-modal-note', tr('assistant.routes.editorState.tasksEmpty', 'No task classes are available on this server.')));
    table.append(list); body.append(table);
    updateFoot(); body.scrollTop = scroll;
    if (active && !state.confirm && !state.suspended) focus(active);
    requestAnimationFrame(updateCue);
  }
  function taskRow(task) {
    const pref = effectivePref(task.id);
    const model = pref ? routeCatalogRow(pref, state.catalog) : null;
    const issue = routePreferenceIssue(pref, task, state.catalog, { partial: state.modelError });
    const node = el('div', 'asst-routes-row'); node.dataset.taskClass = task.id;
    const nameId = `${id}-task-${task.id}`;
    node.setAttribute('role', 'group'); node.setAttribute('aria-labelledby', nameId);
    const main = el('div', 'asst-routes-row-main');
    const name = el('div', 'asst-routes-row-label', task.label); name.id = nameId; main.append(name);
    name.title = task.label;
    const description = el('div', 'asst-routes-row-desc', task.description); description.title = task.description;
    main.append(description);
    if (task.dispatchOnly || task.id === 'computer' || task.id === 'vision') {
      const requirements = [];
      if (task.dispatchOnly) requirements.push(tr('assistant.routes.workerOnly', 'Worker only'));
      if (task.visionOnly || task.id === 'computer' || task.id === 'vision') requirements.push(tr('assistant.routes.needsVision', 'Needs vision'));
      if (task.requires) requirements.push(tr(`assistant.routes.needs.${task.requires}`, task.requires));
      main.title = [task.description, requirements.join(' · ')].filter(Boolean).join(' — ');
    }
    let capabilityNote = null;
    const capable = rowsOf(state.catalog).some(m => task.requires ? m.outputs?.[task.requires] === true && m.status !== 'unavailable' : m.vision === true && m.status !== 'unavailable');
    if ((task.requires || task.visionOnly) && !state.modelsLoading && !state.modelError && !capable) {
      const empty = task.requires ? tr('assistant.routes.noCapableModel', 'No model in your catalog can make {medium} yet.', { medium: tr(`assistant.routes.medium.${task.requires === 'video' ? 'videos' : 'images'}`, task.requires) }) : tr('assistant.routes.noSeeingModel', 'No model in your catalog can see images yet.');
      description.hidden = true;
      capabilityNote = el('div', 'asst-routes-row-note', empty); capabilityNote.title = empty;
    }
    node.append(main);
    const modelCell = el('div', 'asst-routes-cell asst-routes-model-cell');
    modelCell.append(el('span', 'asst-routes-cell-label', tr('assistant.routes.columns.model', 'Model')));
    const label = pref ? routeModelLabel(pref, state.catalog) : tr('assistant.routes.brainDecides', 'Assistant chooses');
    const modelBtn = fieldButton('asst-routes-model', task, tr('assistant.routes.columns.model', 'Model'), label, async () => {
      if (currentMenu()) { closeMenu({ restoreFocus: true }); return; }
      state.menuFocus = modelBtn.dataset.focusKey;
      const emptyLabel = task.requires ? tr('assistant.routes.noCapableModel', 'No model in your catalog can make {medium} yet.', { medium: tr(`assistant.routes.medium.${task.requires === 'video' ? 'videos' : 'images'}`, task.requires) }) : tr('assistant.routes.noSeeingModel', 'No model in your catalog can see images yet.');
      const menu = await openModelMenu(modelBtn, {
        brain: brain(), t: hooks.t, includeHere: true, hereLabel: tr('assistant.routes.brainDecides', 'Assistant chooses'), title: task.label,
        current: pref ? { provider: pref.provider, model: pref.model } : null, onToast: hooks.onToast,
        routingEditor: true, onManageModels: () => manageModels(modelBtn.dataset.focusKey),
        ...(task.requires ? { accept: (_p, m) => m.outputs?.[task.requires] === true, allowCustom: false, emptyLabel } : {}),
        ...(task.visionOnly ? { accept: (_p, m) => m.vision === true && m.status !== 'unavailable', allowCustom: false, emptyLabel } : {}),
        onSelect: target => {
          if (target?.here) setChoice(task.id, null, modelBtn.dataset.focusKey);
          else if (target?.model) {
            const levels = modelEffortIds(catalogModelRow(target.provider, target.model, state.catalog));
            const effort = !pref?.effort ? null : levels ? clampEffortId(pref.effort, levels) : pref.provider === target.provider ? pref.effort : null;
            setChoice(task.id, { kind: task.dispatchOnly ? 'dispatch' : pref?.kind || task.defaultKind || 'direct', provider: target.provider, model: target.model, effort, accountId: routeModelAccount(pref, target.provider), label: target.label || target.model }, modelBtn.dataset.focusKey);
          }
        },
      });
      if (menu && overlay.isConnected && !state.suspended) adoptMenu(menu, overlay);
    });
    // Keys are stable across translations; accessible names use the translated field.
    modelBtn.dataset.focusKey = `${task.id}-model`; caret(modelBtn); modelBtn.setAttribute('aria-haspopup', 'dialog');
    modelBtn.title = label;
    if (pref?.provider) { const mark = el('span', 'asst-icon'); mark.setAttribute('aria-hidden', 'true'); mark.innerHTML = getProviderMeta(pref.provider).icon; mark.style.color = getProviderMeta(pref.provider).color; modelBtn.prepend(mark); }
    modelCell.append(modelBtn);
    const source = el('span', 'asst-routes-source');
    let sourceText = pref ? tr('assistant.routes.source.yours', 'Your choice') : tr('assistant.routes.source.default', 'Assistant chooses');
    source.dataset.source = issue === 'disabled' ? 'disabled' : issue ? 'incapable' : pref ? 'yours' : 'default';
    if (issue) { sourceText = tr(`assistant.routes.issueLabel.${issue}`, tr('assistant.routes.issueLabel.unverified', 'Unverified')); source.setAttribute('data-tooltip', issueText(issue, task)); }
    const edited = own(changes().preferences || {}, task.id); source.dataset.edited = String(edited);
    if (edited) sourceText += tr('assistant.routes.editorState.edited', ' · edited');
    source.id = `${nameId}-source`; source.setAttribute('role', 'img'); source.setAttribute('aria-label', sourceText); source.title = sourceText;
    source.innerHTML = issue ? ICON_ISSUE : pref ? ICON_CHOICE : ICON_AUTO;
    modelBtn.insertBefore(source, modelBtn.querySelector('.asst-dd-caret')); modelBtn.setAttribute('aria-describedby', source.id);
    node.append(modelCell);

    const efforts = pref ? getEffortLevelsForModel(pref.provider, model) : [];
    const hasEffort = efforts.some(e => e.id !== 'off');
    const effortText = !pref ? tr('assistant.routes.brainDecides', 'Assistant chooses') : pref.effort ? effortName(pref.effort) : hasEffort ? defaultEffort(model) : tr('assistant.routes.effortNotSupported', 'Not supported');
    const effortBtn = fieldButton('asst-routes-effort', task, tr('assistant.routes.columns.effort', 'Effort'), effortText, () => {
      state.menuFocus = effortBtn.dataset.focusKey;
      const menu = openMenuFor(effortBtn, tr('assistant.brain.effort', 'Thinking effort'), [
        { kind: 'radio', id: '', label: defaultEffort(model), desc: tr('assistant.routes.effortNote', 'Default effort uses the model default when the brain does not propose a level.'), selected: !pref.effort, onSelect: () => setChoice(task.id, { ...pref, effort: null }, effortBtn.dataset.focusKey) },
        ...efforts.filter(e => e.id !== 'off').map(e => ({ kind: 'radio', id: e.id, label: effortName(e.id), selected: e.id === pref.effort, onSelect: () => setChoice(task.id, { ...pref, effort: e.id }, effortBtn.dataset.focusKey) })),
      ]); return menu;
    });
    effortBtn.dataset.focusKey = `${task.id}-effort`; effortBtn.disabled = !pref || (!hasEffort && !pref.effort); if (!effortBtn.disabled) caret(effortBtn);
    effortBtn.title = effortText;
    // The model control already names who chooses an automatic route. Keep the
    // other cells quiet, and retain the complete default effort in the name/menu.
    const unusedValue = tr('assistant.routes.editorUnusedValue', '—');
    const effortValue = effortBtn.disabled ? unusedValue : pref.effort ? effortText : tr('assistant.routes.editorEffortAuto', 'Auto');
    effortBtn.querySelector('.asst-dd-label').textContent = effortValue;
    if (effortValue !== unusedValue && effortValue !== effortText) effortBtn.setAttribute('aria-label', tr('assistant.routes.fieldLabel', '{task}: {field}, {value}', { task: task.label, field: tr('assistant.routes.columns.effort', 'Effort'), value: `${effortValue} · ${effortText}` }));
    const effortCell = el('div', 'asst-routes-cell asst-routes-effort-cell'); effortCell.append(el('span', 'asst-routes-cell-label', tr('assistant.routes.columns.effort', 'Effort')), effortBtn); node.append(effortCell);
    const kind = routeExecutionKind(pref, task, brain());
    const runLabel = task.id === 'chat' ? tr('assistant.routes.inConversation', 'In conversation') : !pref ? task.dispatchOnly ? tr('assistant.routes.workerChooses', 'Worker · assistant chooses') : tr('assistant.routes.brainDecides', 'Assistant chooses') : kind === 'direct' ? tr('assistant.routes.inConversation', 'In conversation') : tr('assistant.routes.onWorker', '{provider} worker', { provider: getProviderMeta(pref.provider).label });
    const run = fieldButton('asst-routes-run', task, tr('assistant.routes.columns.run', 'Runs in'), runLabel, () => openMenuFor(run, tr('assistant.routes.columns.run', 'Runs in'), [
      { kind: 'radio', id: 'direct', label: tr('assistant.routes.inConversation', 'In conversation'), desc: tr('assistant.routes.conversationDesc', 'Continue this conversation on the chosen model for this task.'), selected: kind === 'direct', onSelect: () => setChoice(task.id, { ...pref, kind: 'direct' }, run.dataset.focusKey) },
      { kind: 'radio', id: 'dispatch', label: tr('assistant.routes.onWorker', '{provider} worker', { provider: getProviderMeta(pref?.provider).label }), desc: tr('assistant.routes.workerDesc', 'Hand the task to a worker and show its result here.'), selected: kind === 'dispatch', onSelect: () => setChoice(task.id, { ...pref, kind: 'dispatch' }, run.dataset.focusKey) },
    ]));
    run.dataset.focusKey = `${task.id}-run`; run.disabled = !pref || task.dispatchOnly || pref.provider !== brain().provider || task.id === 'chat';
    const inConversation = task.id === 'chat' || (pref && kind === 'direct');
    const runValue = inConversation ? tr('assistant.routes.editorInConversation', 'This conversation') : pref ? getProviderMeta(pref.provider).label : unusedValue;
    run.querySelector('.asst-dd-label').textContent = runValue;
    if (inConversation) run.setAttribute('aria-label', tr('assistant.routes.fieldLabel', '{task}: {field}, {value}', { task: task.label, field: tr('assistant.routes.columns.run', 'Runs in'), value: runValue }));
    if (!run.disabled) caret(run);
    run.title = runLabel;
    if (task.dispatchOnly) run.title = tr('assistant.routes.workerOnly', 'Worker only');
    else if (pref && pref.provider !== brain().provider && task.id !== 'chat') run.title = tr('assistant.routes.otherProviderWorker', 'A model from another provider runs on a worker.');
    const runCell = el('div', 'asst-routes-cell asst-routes-run-cell'); runCell.append(el('span', 'asst-routes-cell-label', tr('assistant.routes.columns.run', 'Runs in')), run); node.append(runCell);
    const account = routeAccountView(pref, task, brain(), { 'claude-code': getCachedClaudeAccounts(), codex: getCachedCodexAccounts() }, { 'claude-code': getClaudeWorkerAccountId(), codex: getCodexWorkerAccountId() }, hooks.t);
    const accountCell = el('div', 'asst-routes-cell asst-routes-account-cell');
    const accountBtn = fieldButton('asst-routes-account', task, tr('assistant.routes.columns.account', 'Account'), account.label, () => {
      state.menuFocus = `${task.id}-account`;
      openMenuFor(accountBtn, tr('assistant.routes.columns.account', 'Account'), account.options.map(o => ({ ...o, kind: 'radio', onSelect: () => setChoice(task.id, { ...pref, accountId: o.id || null }, `${task.id}-account`) })));
    });
    accountBtn.dataset.focusKey = `${task.id}-account`; accountBtn.disabled = account.readOnly; accountBtn.title = account.hint;
    if (!account.readOnly) caret(accountBtn);
    if (account.warning) accountBtn.classList.add('asst-dd-warn');
    accountCell.append(el('span', 'asst-routes-cell-label', tr('assistant.routes.columns.account', 'Account')), accountBtn); node.append(accountCell);
    const resetCell = el('div', 'asst-routes-reset-cell');
    if (pref) { const reset = button('asst-iconbtn asst-routes-reset', tr('assistant.routes.reset', 'Reset {taskClass}', { taskClass: task.label }), () => setChoice(task.id, null, `${task.id}-model`)); reset.dataset.focusKey = `${task.id}-reset`; reset.title = reset.getAttribute('aria-label'); reset.innerHTML = ICON_RESET; resetCell.append(reset); }
    node.append(resetCell);
    if (account.warning) { const note = el('div', 'asst-routes-row-warning', account.warning); note.id = `${nameId}-account-warning`; accountBtn.setAttribute('aria-describedby', note.id); node.append(note); }
    if (capabilityNote) node.append(capabilityNote);
    if (issue) { description.hidden = true; node.querySelector('.asst-routes-row-note')?.remove(); const note = el('div', 'asst-routes-row-warning', issueText(issue, task)); note.title = note.textContent; note.id = `${nameId}-issue`; modelBtn.setAttribute('aria-describedby', `${source.id} ${note.id}`); modelBtn.title = `${label} — ${note.textContent}`; node.append(note); }
    if (task.id === 'chat' || task.id === 'vision') {
      description.hidden = true;
      const text = task.id === 'chat' ? tr('assistant.routes.chatInactive', 'Plain chat stays on the current brain. A stored Chat choice is not applied in any mode.') : tr('assistant.routes.visionFallback', 'Vision fallback, not a task class. Used when the chosen model cannot see image input.');
      const context = el('div', 'asst-routes-row-context', text); context.title = text; context.id = `${nameId}-context`; node.append(context);
      context.hidden = !!issue;
      modelBtn.setAttribute('aria-describedby', `${modelBtn.getAttribute('aria-describedby')} ${context.id}`);
      if (task.id === 'chat') { node.dataset.inactive = 'true'; const inactive = el('span', 'asst-routes-inactive', tr('assistant.routes.notApplied', 'Not applied')); inactive.title = text; name.append(inactive); }
    }
    return node;
  }
  async function manageModels(focusKey = 'reload-models') {
    closeMenu(); state.suspended = true; overlay.hidden = true;
    try {
      await openModelsManager({ ...hooks, tab: 'archived', onClose: () => { state.suspended = false; overlay.hidden = false; focus(focusKey); reloadModels(); } });
    } catch { state.suspended = false; overlay.hidden = false; focus(focusKey); }
  }
  async function reloadModels() {
    if (state.modelsLoading || state.offline) return;
    state.modelsLoading = true; closeMenu(); render();
    try { state.catalog = await loadRouteModels(); state.modelError = routeModelsStatus().partial; modelsWatch.seed(state.catalog); }
    catch { state.modelError = true; }
    if (!overlay.isConnected) return;
    state.modelsLoading = false; state.notice = state.modelError ? '' : tr('assistant.routes.editorState.modelsUpdated', 'Model list updated. Your unsaved changes are kept.'); render();
  }
  async function load(preserve = false) {
    const pending = preserve ? changes() : {};
    state.loading = true; state.error = ''; state.modelsLoading = true; render();
    try {
      const [data, result] = await Promise.all([getRouting(), loadRouteModels().then(catalog => ({ catalog })).catch(() => ({ catalog: state.catalog, error: true })), Promise.allSettled([fetchClaudeAccounts(true), fetchCodexAccounts(true)])]);
      if (!overlay.isConnected) return;
      state.data = data; state.version = data.version ?? null; state.initialMode = normalizeRouteMode(data.routing?.defaultMode, DEFAULT_ROUTE_MODE);
      state.mode = pending.defaultMode || state.initialMode; state.prefs = { ...(data.routing?.preferences || {}) }; state.patch = pending.preferences || {};
      state.catalog = result.catalog; state.modelError = result.error || routeModelsStatus().partial; modelsWatch.seed(state.catalog); state.conflict = false;
      if (preserve) state.notice = tr('assistant.routes.editorState.settingsReloaded', 'Latest settings loaded. Your edits are kept; review them before saving.');
    } catch (err) {
      state.error = err.status === 403 ? tr('assistant.routes.editorState.permission', 'You do not have permission to edit routing settings.') : err.status === 404 ? tr('assistant.routes.unavailable', 'Model routing is not available on this server yet.') : tr('assistant.routes.loadFailed', 'Could not load model routes');
    }
    state.loading = false; state.modelsLoading = false; render(); if (!preserve) focus();
  }
  async function save() {
    if (saveBtn.disabled) return;
    const patch = changes(); state.saving = true; state.error = ''; updateFoot(); closeMenu();
    try {
      const res = await putRouting(patch, state.version);
      try { hooks.onSaved?.(res?.routing || null, res); } catch { /* host callback */ }
      finishClose();
    } catch (err) {
      state.saving = false;
      if (err.status === 409 || err.code === 'VERSION_CONFLICT') { state.conflict = true; state.error = tr('assistant.routes.conflict', 'Settings changed elsewhere. Reload to keep your edits and review the latest choices.'); }
      else if (err.code === 'ROUTING_INVALID') state.error = tr('assistant.routes.invalidField', 'Invalid routing setting: {field}', { field: err.message || '' });
      else state.error = err.status === 403 ? tr('assistant.routes.editorState.permission', 'You do not have permission to edit routing settings.') : tr('assistant.routes.saveFailed', 'Could not save. Your edits are kept; try again.');
      render();
    }
  }
  render(); closeBtn.focus(); await load(); return editor || { el: overlay, close, focus };
}

import { openMenu } from './asst-menu.js';
function openMenuFor(anchor, title, items) {
  if (currentMenu()) { closeMenu({ restoreFocus: true }); return null; }
  const menu = openMenu(anchor, { title, items, className: `asst-route-field-menu${anchor.classList.contains('asst-routes-account') ? ' asst-route-account-menu' : ''}`, role: 'menu' });
  const overlay = anchor.closest('.asst-routes-overlay'); if (overlay) adoptMenu(menu, overlay); return menu;
}
function adoptMenu(menu, overlay) {
  const active = menu.el.contains(document.activeElement) ? document.activeElement : null;
  for (const item of menu.el.querySelectorAll('.asst-dd-item')) if (!item.title) item.title = item.textContent.trim();
  overlay.append(menu.el); active?.focus({ preventScroll: true });
}
