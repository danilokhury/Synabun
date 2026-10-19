// One saved per-session budget. Both entry points use this controller and form;
// chips display confirmed server values, while an unsaved edit stays in the form.
import { getBudget, putBudget } from './asst-api.js';
import { openMenu, closeMenu, isMenuOpen } from './asst-menu.js';
import { createMascotControl } from './asst-mascot.js';

export const BUDGET_BOUNDS = Object.freeze({ minUsd: 0.1, maxUsd: 1000 });
const money = value => `$${(Number(value) || 0).toFixed(2)}`;
// The saved amount: whole dollars as typed ("$1000"), cents always with two digits ("$12.50").
const amountText = value => (Number.isInteger(Number(value)) ? `$${Number(value)}` : money(value));
const tf = t => (key, fallback, vars = {}) => {
  const value = t?.(key, vars);
  return String(!value || value === key ? fallback : value).replace(/\{(\w+)\}/g, (all, key) => vars[key] ?? all);
};
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

export function validateBudgetDraft(draft = {}, { bounds = BUDGET_BOUNDS, t } = {}) {
  const tr = tf(t), errors = {}, values = { unlimited: draft.unlimited === true };
  const raw = typeof draft.amountUsd === 'string' ? draft.amountUsd.trim() : draft.amountUsd;
  const amount = raw === '' || raw == null ? NaN : Number(raw);
  if (!values.unlimited) {
    if (!Number.isFinite(amount)) errors.amountUsd = tr('assistant.budget.errNumber', 'Enter an amount in US dollars.');
    else if (amount < bounds.minUsd || amount > bounds.maxUsd) errors.amountUsd = tr('assistant.budget.errRange', 'Between {min} and {max}.', { min: money(bounds.minUsd), max: money(bounds.maxUsd) });
  }
  // No limit must work even if the unfinished amount field is invalid.
  if (Number.isFinite(amount) && amount >= bounds.minUsd && amount <= bounds.maxUsd) values.amountUsd = Math.round(amount * 100) / 100;
  return { values, errors };
}
export function budgetTone(view) {
  if (!view) return null;
  if (view.unlimited) return 'ok';
  if (view.exceeded || Number(view.spentUsd) >= Number(view.amountUsd)) return 'over';
  if (Number(view.spentUsd) >= Number(view.warnAtUsd ?? Number(view.amountUsd) * 0.8)) return 'warn';
  return 'ok';
}
export function budgetSpendText(view, { t } = {}) {
  if (!view) return '';
  return view.unlimited
    ? tf(t)('assistant.budget.spendUnlimited', '{spent} · no limit', { spent: money(view.spentUsd) })
    : `${money(view.spentUsd)} / ${money(view.amountUsd)}`;
}
export function budgetSettingText(budget, { t } = {}) {
  if (!budget) return '…';
  return budget.unlimited ? tf(t)('assistant.budget.noLimit', 'No limit')
    : tf(t)('assistant.budget.perSession', '{amount} / session', { amount: amountText(budget.amountUsd) });
}
export function budgetChipText(view, { t } = {}) {
  if (!view) return '';
  const tr = tf(t);
  return [budgetSpendText(view, { t }), tr('assistant.budget.chipSplit', 'Brain {brain} · agents {agents}', { brain: money(view.brainUsd), agents: money(view.dispatchUsd) }),
    Number(view.unpricedRuns) > 0 ? tr('assistant.budget.chipUnpriced', '{n} run(s) with unpriced usage', { n: view.unpricedRuns }) : ''].filter(Boolean).join(' · ');
}

/** Serializable writer with one conflict retry, no polling and no local persistence. */
export function createBudgetController({ sessionId = null, t, get = getBudget, put = putBudget, onSaved, debounceMs = 450 } = {}) {
  const tr = tf(t), listeners = new Set(), commits = new Set(), edits = new Map();
  const state = { data: null, draft: { unlimited: false, amountUsd: '' }, dirty: false, saving: false, loading: false, error: '', fieldError: '', saved: false };
  let timer, revision = 0, loading, writing, disposed = false;
  const notify = () => { if (!disposed) for (const fn of listeners) fn(state); };
  const committed = event => { if (!disposed) for (const fn of commits) { try { fn(event); } catch { /* an observer cannot fail a save */ } } };
  const adopt = data => {
    if (!data?.budget || (state.data && Number(data.version) < Number(state.data.version))) return;
    // A PUT returns before the split finishes: don't overwrite a newer live split
    // that arrived during this request with the old split from its response.
    const live = state.data?.session;
    if (live && data.session && live.version >= data.session.version &&
        Date.parse(live.split?.updatedAt || 0) > Date.parse(data.session.split?.updatedAt || 0)) data = { ...data, session: live };
    state.data = data;
    if (!edits.has('unlimited')) state.draft.unlimited = data.budget.unlimited;
    if (!edits.has('amountUsd')) state.draft.amountUsd = String(data.budget.amountUsd ?? '');
    if (!disposed) onSaved?.(data);
  };
  async function load() {
    if (loading) return loading;
    state.loading = true; state.error = ''; notify();
    loading = (async () => {
      try { adopt(await get(sessionId)); }
      catch { state.error = tr('assistant.budget.loadFailed', 'Could not load the budget. Try again.'); }
      finally { state.loading = false; loading = null; notify(); }
      return state.data;
    })();
    return loading;
  }
  function edit(patch, { immediate = false } = {}) {
    revision++; state.draft = { ...state.draft, ...patch }; state.dirty = true;
    for (const field of Object.keys(patch)) edits.set(field, revision);
    state.error = ''; state.fieldError = ''; state.saved = false;
    clearTimeout(timer); notify();
    if (immediate) return flush();
    timer = setTimeout(flush, debounceMs);
  }
  async function flush() {
    clearTimeout(timer);
    if (writing) return writing;
    if (!state.data || !state.dirty) return;
    writing = (async () => {
      while (state.dirty) {
        const changed = new Map(edits);
        const { values, errors } = validateBudgetDraft(state.draft, { bounds: state.data.bounds, t });
        state.fieldError = errors.amountUsd || '';
        if (state.fieldError) { notify(); break; }
        const patch = Object.fromEntries([...changed.keys()].filter(field => Object.hasOwn(values, field)).map(field => [field, values[field]]));
        state.saving = true; state.error = ''; notify();
        try {
          let response;
          try { response = await put(patch, state.data.version, sessionId); }
          catch (err) {
            if (err.code !== 'VERSION_CONFLICT' && err.status !== 409) throw err;
            adopt(await get(sessionId));
            response = await put(patch, state.data.version, sessionId); // retry the edit once
          }
          for (const [field, at] of changed) if (edits.get(field) === at) edits.delete(field);
          state.dirty = edits.size > 0;
          adopt(response); state.saved = !state.dirty;
          committed({ ok: true, patch, budget: response.budget });
        } catch (err) {
          if (err.code === 'BUDGET_INVALID') state.fieldError = tr('assistant.budget.invalid', 'The server rejected this budget. Check the amount and try again.');
          else if (err.code === 'VERSION_CONFLICT' || err.status === 409) state.error = tr('assistant.budget.conflict', 'Changed elsewhere again. Your edit is kept; try again.');
          else state.error = tr('assistant.budget.saveFailed', 'Could not save the budget. Your edit is kept; try again.');
          committed({ ok: false, patch, error: err });
          break;
        } finally { state.saving = false; notify(); }
      }
    })();
    try { await writing; } finally { writing = null; }
  }
  function receiveSession(view) {
    if (!view || (sessionId && view.sessionId !== sessionId)) return;
    if (state.data && Number(view.version) < Number(state.data.version)) return;
    const saved = state.data?.budget || {};
    adopt({ ...(state.data || {}), version: view.version, budget: { ...saved, unlimited: view.unlimited, amountUsd: view.amountUsd ?? saved.amountUsd, version: view.version }, session: view });
    notify();
  }
  return { state, load, edit, flush, receiveSession,
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    onCommit(fn) { commits.add(fn); return () => commits.delete(fn); },
    destroy() { flush(); disposed = true; clearTimeout(timer); listeners.clear(); commits.clear(); },
  };
}

let uid = 0;
/** The identical autosave control in the empty-state popover and the session modal. */
export function createBudgetControls(controller, { t } = {}) {
  const tr = tf(t), id = `asst-budget-${++uid}`;
  const root = el('section', 'asst-budget-controls'); root.tabIndex = -1;
  const label = el('label', 'asst-routes-row-label', tr('assistant.budget.amount', 'Budget per session (USD)'));
  label.htmlFor = id;
  const input = el('input', 'asst-dd-input asst-budget-input');
  input.id = id; input.type = 'number'; input.inputMode = 'decimal'; input.step = '0.01';
  const switchLabel = el('label', 'asst-budget-switch-label');
  const toggle = el('input', 'asst-budget-switch');
  toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch');
  switchLabel.append(toggle, el('span', '', tr('assistant.budget.noLimit', 'No limit')));
  const note = el('div', 'asst-modal-note', tr('assistant.budget.applies', 'Applies to each new session and all open sessions. Jev splits it across providers.'));
  const error = el('div', 'asst-budget-field-error'); error.id = `${id}-error`; error.setAttribute('role', 'alert');
  const status = el('div', 'asst-modal-note'); status.setAttribute('role', 'status');
  note.id = `${id}-note`; input.setAttribute('aria-describedby', `${note.id} ${error.id}`);
  const retry = el('button', 'asst-btn asst-btn-secondary', tr('assistant.budget.retry', 'Try again')); retry.type = 'button';
  retry.addEventListener('click', () => controller.state.dirty ? controller.flush() : controller.load());
  input.addEventListener('input', () => controller.edit({ amountUsd: input.value }));
  input.addEventListener('blur', () => controller.flush());
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); controller.flush(); } });
  toggle.addEventListener('change', () => controller.edit({ unlimited: toggle.checked }, { immediate: true }));
  root.append(label, input, switchLabel, note, error, status, retry);
  root.addEventListener('keydown', e => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation(); });
  const unsubscribe = controller.subscribe(state => {
    if (input.value !== String(state.draft.amountUsd)) input.value = state.draft.amountUsd;
    input.min = String(state.data?.bounds?.minUsd ?? BUDGET_BOUNDS.minUsd); input.max = String(state.data?.bounds?.maxUsd ?? BUDGET_BOUNDS.maxUsd);
    input.disabled = !state.data || state.draft.unlimited;
    toggle.disabled = !state.data; toggle.checked = state.draft.unlimited;
    input.setAttribute('aria-invalid', state.fieldError ? 'true' : 'false');
    error.textContent = state.fieldError || state.error; error.hidden = !error.textContent;
    status.textContent = state.loading ? tr('common.loading', 'Loading...') : state.saving ? tr('assistant.budget.saving', 'Saving…') : state.saved ? tr('assistant.budget.saved', 'Budget saved — applies now.') : '';
    retry.hidden = !(state.error || state.fieldError);
  });
  return { el: root, focus: () => (!input.disabled ? input : !toggle.disabled ? toggle : !retry.hidden ? retry : root).focus({ preventScroll: true }), destroy: unsubscribe };
}

export function mountBudgetChip(slot, controller, { t, mascot } = {}) {
  const tr = tf(t), btn = el('button', 'asst-dd asst-empty-control-btn asst-empty-budget-btn');
  btn.type = 'button'; btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
  const icon = el('span', 'asst-icon'); icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M16 10h5v5h-5zM7 9h4"/></svg>';
  const value = el('span', 'asst-dd-label'), caret = el('span', 'asst-dd-caret'); caret.setAttribute('aria-hidden', 'true');
  caret.innerHTML = '<svg viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3"/></svg>';
  btn.append(icon, el('span', 'asst-empty-project-key', tr('assistant.budget.title', 'Budget')), value, caret);
  const actor = createMascotControl(btn, { director: mascot, pose: 'budget', options: () => ({ unlimited: !!controller.state.data?.budget.unlimited }) });
  const offCommit = controller.onCommit(event => actor.commit(!event.ok ? 'wince' : Object.hasOwn(event.patch, 'unlimited') ? event.patch.unlimited ? 'pulse' : 'pop' : 'nod'));
  let unlimited;
  const off = controller.subscribe(state => {
    value.textContent = budgetSettingText(state.data?.budget, { t });
    btn.setAttribute('aria-label', `${tr('assistant.budget.title', 'Budget')}: ${value.textContent}`);
    if (unlimited !== state.data?.budget.unlimited) { unlimited = state.data?.budget.unlimited; actor.refresh(); }
  });
  btn.addEventListener('click', () => {
    if (isMenuOpen(btn)) { closeMenu({ restoreFocus: true }); return; }
    const controls = createBudgetControls(controller, { t });
    openMenu(btn, { title: tr('assistant.budget.title', 'Budget'), role: 'dialog', content: controls.el, width: 320, repositionOnResize: true,
      className: 'asst-budget-popover', placement: 'prefer-below', onOpen: node => actor.open(node), onClose: () => { actor.close(); controller.flush(); controls.destroy(); } });
    controls.focus();
    if (!controller.state.data) controller.load().then(() => { if (isMenuOpen(btn)) controls.focus(); });
  });
  slot.appendChild(btn);
  return { el: btn, destroy() { if (isMenuOpen(btn)) closeMenu(); actor.destroy(); offCommit(); off(); btn.remove(); } };
}

export function renderBudgetSession(view, { t } = {}) {
  const tr = tf(t), section = el('section', 'asst-budget-session');
  section.append(el('h3', 'asst-routes-section-title', tr('assistant.budget.thisSession', 'This session')), el('div', 'asst-budget-total', budgetSpendText(view, { t })));
  section.dataset.tone = budgetTone(view);
  if (!view.unlimited) {
    const meter = el('meter', 'asst-budget-meter'); meter.min = 0; meter.max = view.amountUsd; meter.value = view.spentUsd;
    meter.setAttribute('aria-label', tr('assistant.budget.meterLabel', 'Session spend against the budget')); section.append(meter);
  }
  const providers = el('div', 'asst-budget-providers');
  for (const row of view.providers || []) {
    const item = el('div', 'asst-budget-provider'); item.dataset.provider = row.provider;
    item.dataset.eligible = String(row.eligible); item.dataset.dry = String((view.dry || []).includes(row.provider));
    const heading = el('div', 'asst-budget-provider-name', row.label || row.provider);
    if (row.isBrain) heading.append(el('span', 'asst-budget-brain', tr('assistant.budget.brainRow', 'Brain')));
    item.append(heading);
    item.append(el('div', 'asst-budget-provider-money', view.unlimited
      ? tr('assistant.budget.providerSpend', '{spent} spent', { spent: money(row.spentUsd) })
      : tr('assistant.budget.providerAmounts', 'Share {share} · spent {spent} · left for tasks {left}', { share: row.shareUsd == null ? '—' : money(row.shareUsd), spent: money(row.spentUsd), left: row.workerLeftUsd == null ? '—' : money(row.workerLeftUsd) })));
    if (!view.unlimited && row.isBrain && view.split) item.append(el('div', 'asst-modal-note', tr('assistant.budget.reserve', '{reserve} reserved for the brain within this share.', { reserve: money(view.split.brainReserveLeftUsd) })));
    if (!view.unlimited && (view.dry || []).includes(row.provider)) item.append(el('div', 'asst-budget-dry', tr('assistant.budget.dry', 'Share used up')));
    if (!row.eligible && row.reason) {
      const reason = String(row.reason).replace(/^brain:/, '');
      item.append(el('div', 'asst-modal-note', tr(`assistant.budget.ineligible.${reason}`, { no_models: 'No available models', signed_out: 'Signed out', limited: 'Provider usage limit reached' }[reason] || reason)));
    }
    providers.append(item);
  }
  section.append(providers);
  if (!view.unlimited) {
    if (view.split) {
      const split = view.split;
      const source = split.source === 'jev' ? 'Jev' : tr('assistant.budget.fixedRule', 'Fixed rule');
      const why = split.fallbackWhy ? tr(`assistant.budget.fallback.${split.fallbackWhy}`, { jev_off: 'Jev is off', jev_unavailable: 'Jev is unavailable', jev_incomplete: 'Jev returned an incomplete split', nothing_left: 'No budget left' }[split.fallbackWhy] || split.fallbackWhy) : '';
      const time = el('time'); time.dateTime = split.updatedAt || '';
      time.textContent = split.updatedAt && Number.isFinite(Date.parse(split.updatedAt)) ? new Date(split.updatedAt).toLocaleString() : '';
      const meta = el('div', 'asst-modal-note', [source, why].filter(Boolean).join(' · ') + ' · '); meta.append(time); section.append(meta);
    } else section.append(el('div', 'asst-modal-note', tr('assistant.budget.awaitingSplit', 'The split is prepared when work starts.')));
  }
  if (view.unpricedRuns > 0) section.append(el('div', 'asst-budget-unpriced', tr('assistant.budget.chipUnpriced', '{n} run(s) with unpriced usage', { n: view.unpricedRuns })));
  return section;
}

let editor;
export async function openBudgetEditor(hooks = {}) {
  editor?.close();
  const controller = hooks.controller || createBudgetController(hooks), tr = tf(hooks.t);
  const returnTo = document.activeElement, overlay = el('div', 'asst-modal-overlay asst-budget-overlay');
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', tr('assistant.budget.title', 'Budget'));
  const modal = el('div', 'asst-modal asst-budget-modal'), head = el('div', 'asst-modal-head');
  const closeBtn = el('button', 'asst-iconbtn asst-modal-close', '✕'); closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', tr('common.close', 'Close'));
  head.append(el('span', '', tr('assistant.budget.title', 'Budget')), closeBtn);
  const body = el('div', 'asst-modal-body'), controls = createBudgetControls(controller, hooks), live = el('div');
  body.append(controls.el, live); modal.append(head, body); overlay.append(modal); document.body.append(overlay);
  const off = controller.subscribe(state => { live.replaceChildren(...(state.data?.session ? [renderBudgetSession(state.data.session, hooks)] : [])); });
  function close() {
    if (!overlay.isConnected) return;
    controller.flush(); off(); controls.destroy(); if (!hooks.controller) controller.destroy();
    window.removeEventListener('keydown', onKey, true); overlay.remove(); editor = null;
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const nodes = [...modal.querySelectorAll('button, input')].filter(node => !node.disabled && !node.hidden);
      const index = nodes.indexOf(document.activeElement);
      if (e.shiftKey && index <= 0) { e.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!e.shiftKey && (index < 0 || index === nodes.length - 1)) { e.preventDefault(); nodes[0]?.focus(); }
    }
  }
  closeBtn.addEventListener('click', close); overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', onKey, true);
  overlay.addEventListener('keydown', e => e.stopPropagation());
  const handle = { el: overlay, close, controller }; editor = handle;
  closeBtn.focus({ preventScroll: true });
  await controller.load(); if (overlay.isConnected) controls.focus();
  return handle;
}

export function closeBudgetEditor(controller) { if (editor?.controller === controller) editor.close(); }
