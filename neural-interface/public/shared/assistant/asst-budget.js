// ═══════════════════════════════════════════
// SynaBun Assistant — Budget (⋯ → Budget…)
// ═══════════════════════════════════════════
// The money caps of the assistant: default and largest per-run cap, the
// session warning, the session hard cap (brain + every run) and the brain cap.
// Saved to assistant-config.json through PUT /api/assistant/budget; the
// dispatcher and the runtime read them on their next check, so a change
// applies to running sessions without a restart. The pure helpers
// (validateBudgetDraft, budgetTone, budgetChipText) are covered by node:test;
// nothing here touches `document` at import time.

import { getBudget, putBudget } from './asst-api.js';

export const BUDGET_FIELDS = Object.freeze([
  { id: 'defaultRunUsd', key: 'assistant.budget.defaultRun', label: 'Default per-run cap', desc: 'Each dispatched run stops at this spend unless the brain asks for another cap.' },
  { id: 'maxRunUsd', key: 'assistant.budget.maxRun', label: 'Largest per-run cap', desc: 'The most a brain may give one run (budget_usd).' },
  { id: 'sessionWarnUsd', key: 'assistant.budget.sessionWarn', label: 'Session warning', desc: 'The brain and this panel are warned once when the session spends this much.' },
  { id: 'sessionHardUsd', key: 'assistant.budget.sessionHard', label: 'Session hard cap', desc: 'Brain + every run of the session. At this spend runs stop, and dispatches, follow-ups and brain turns are refused.' },
  { id: 'brainUsd', key: 'assistant.budget.brain', label: 'Brain cap', desc: 'The central brain\'s own spend in one session, checked before every brain turn.' },
]);
export const BUDGET_BOUNDS = Object.freeze({ minUsd: 0.1, maxUsd: 1000 });

function tf(t) {
  return (key, fallback, vars) => {
    let text = typeof t === 'function' ? t(key, vars) : null;
    if (!text || text === key) text = fallback;
    if (vars) for (const [name, value] of Object.entries(vars)) text = String(text).replaceAll(`{${name}}`, String(value));
    return text;
  };
}
const money = (value) => `$${(Number(value) || 0).toFixed(2)}`;
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Check a draft ({ field: string|number }) the way the server does: each value
 * an amount between the bounds, then default ≤ largest ≤ hard, warning < hard,
 * brain ≤ hard. → { values, errors: { field: message } }.
 */
export function validateBudgetDraft(draft = {}, { bounds = BUDGET_BOUNDS, t = null } = {}) {
  const tr = tf(t);
  const values = {};
  const errors = {};
  for (const field of BUDGET_FIELDS) {
    const raw = draft[field.id];
    const text = typeof raw === 'string' ? raw.trim().replace(/^\$/, '') : raw;
    const n = text === '' || text === null || text === undefined ? NaN : Number(text);
    if (!Number.isFinite(n)) { errors[field.id] = tr('assistant.budget.errNumber', 'Enter an amount in US dollars.'); continue; }
    if (n < bounds.minUsd || n > bounds.maxUsd) { errors[field.id] = tr('assistant.budget.errRange', 'Between {min} and {max}.', { min: money(bounds.minUsd), max: `$${bounds.maxUsd}` }); continue; }
    values[field.id] = Math.round(n * 100) / 100;
  }
  const v = values;
  const has = (...ids) => ids.every((id) => Number.isFinite(v[id]));
  if (has('maxRunUsd', 'sessionHardUsd') && v.maxRunUsd > v.sessionHardUsd && !errors.maxRunUsd) errors.maxRunUsd = tr('assistant.budget.errMaxOverHard', 'Cannot exceed the session hard cap ({hard}).', { hard: money(v.sessionHardUsd) });
  if (has('defaultRunUsd', 'maxRunUsd') && v.defaultRunUsd > v.maxRunUsd && !errors.defaultRunUsd) errors.defaultRunUsd = tr('assistant.budget.errDefaultOverMax', 'Cannot exceed the largest per-run cap ({max}).', { max: money(v.maxRunUsd) });
  if (has('sessionWarnUsd', 'sessionHardUsd') && v.sessionWarnUsd >= v.sessionHardUsd && !errors.sessionWarnUsd) errors.sessionWarnUsd = tr('assistant.budget.errWarnOverHard', 'Must be below the session hard cap ({hard}).', { hard: money(v.sessionHardUsd) });
  if (has('brainUsd', 'sessionHardUsd') && v.brainUsd > v.sessionHardUsd && !errors.brainUsd) errors.brainUsd = tr('assistant.budget.errBrainOverHard', 'Cannot exceed the session hard cap ({hard}).', { hard: money(v.sessionHardUsd) });
  return { values, errors };
}

/** 'over' at the hard cap, 'warn' at the warning, else 'ok' (null without a budget view). */
export function budgetTone(view) {
  if (!view || !Number.isFinite(Number(view.totalUsd))) return null;
  if (Number(view.totalUsd) >= Number(view.hardUsd)) return 'over';
  if (Number(view.totalUsd) >= Number(view.warnUsd)) return 'warn';
  return 'ok';
}

/** Cost chip tooltip: "Brain $x · agents $y · $z of $cap cap". */
export function budgetChipText(view, { t = null, brainMetered = true } = {}) {
  const tr = tf(t);
  if (!view) return '';
  const brain = brainMetered ? money(view.brainUsd) : tr('assistant.budget.notMetered', 'not metered');
  const parts = [
    tr('assistant.budget.chipSplit', 'Brain {brain} · agents {agents}', { brain, agents: money(view.dispatchUsd) }),
    tr('assistant.budget.chipCap', '{total} of the {hard} session cap', { total: money(view.totalUsd), hard: money(view.hardUsd) }),
  ];
  if (Number(view.unpricedRuns) > 0) parts.push(tr('assistant.budget.chipUnpriced', '{n} run(s) with unpriced usage', { n: view.unpricedRuns }));
  return parts.join(' · ');
}

let _editor = null;

/**
 * Open the Budget modal. hooks: { t, sessionId, brainMetered, onToast, onSaved(payload) }.
 */
export async function openBudgetEditor(hooks = {}) {
  if (_editor) _editor.close();
  const tr = tf(hooks.t);
  const overlay = el('div', 'asst-modal-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', tr('assistant.budget.title', 'Budget'));
  const modal = el('div', 'asst-modal asst-routes-modal asst-budget-modal');
  modal.innerHTML = `
    <div class="asst-modal-head"><span class="asst-icon" aria-hidden="true">$</span><span>${esc(tr('assistant.budget.title', 'Budget'))}</span><button type="button" class="asst-iconbtn asst-modal-close" aria-label="${esc(tr('common.close', 'Close'))}">✕</button></div>
    <div class="asst-modal-body"><div class="asst-modal-note">${esc(tr('common.loading', 'Loading...'))}</div></div>
    <div class="asst-modal-foot">
      <button type="button" class="asst-btn asst-btn-secondary asst-budget-reset-all">${esc(tr('assistant.budget.resetAll', 'Defaults'))}</button>
      <span class="asst-modal-spacer"></span>
      <button type="button" class="asst-btn asst-btn-secondary asst-budget-cancel">${esc(tr('common.cancel', 'Cancel'))}</button>
      <button type="button" class="asst-btn asst-btn-primary asst-budget-save">${esc(tr('common.save', 'Save'))}</button>
    </div>`;
  overlay.appendChild(modal);
  const body = modal.querySelector('.asst-modal-body');
  const saveBtn = modal.querySelector('.asst-budget-save');
  const returnTo = document.activeElement;
  const state = { data: null, draft: {}, error: '', conflict: false, serverField: null, saving: false };

  function close() {
    if (!overlay.isConnected) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    _editor = null;
    if (returnTo?.isConnected) { try { returnTo.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Enter' && e.target?.matches?.('.asst-budget-input')) { e.preventDefault(); save(); return; }
    e.stopPropagation();
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  modal.querySelector('.asst-modal-close').addEventListener('click', close);
  modal.querySelector('.asst-budget-cancel').addEventListener('click', close);
  modal.querySelector('.asst-budget-reset-all').addEventListener('click', () => {
    if (!state.data) return;
    for (const field of BUDGET_FIELDS) state.draft[field.id] = String(state.data.defaults?.[field.id] ?? '');
    render();
  });
  document.body.appendChild(overlay);
  _editor = { close };

  function sourceLabel(source) {
    if (source === 'saved') return tr('assistant.budget.sourceSaved', 'saved');
    if (source === 'legacy') return tr('assistant.budget.sourceLegacy', 'from soft budget');
    return tr('assistant.budget.sourceDefault', 'default');
  }

  function sessionSection(view) {
    const section = el('section', 'asst-routes-section asst-budget-session');
    section.appendChild(el('div', 'asst-routes-section-title', tr('assistant.budget.thisSession', 'This session')));
    const tone = budgetTone(view) || 'ok';
    const hard = Math.max(0.01, Number(view.hardUsd) || 0);
    const meter = el('div', 'asst-budget-meter');
    meter.dataset.tone = tone;
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', String(hard));
    meter.setAttribute('aria-valuenow', String(Number(view.totalUsd) || 0));
    meter.setAttribute('aria-label', tr('assistant.budget.meterLabel', 'Session spend against the hard cap'));
    const fill = el('span', 'asst-budget-meter-fill');
    fill.style.width = `${Math.min(100, (Number(view.totalUsd) / hard) * 100)}%`;
    const tick = el('span', 'asst-budget-meter-warn');
    tick.style.left = `${Math.min(100, (Number(view.warnUsd) / hard) * 100)}%`;
    meter.append(fill, tick);
    section.appendChild(meter);
    const brain = hooks.brainMetered === false ? tr('assistant.budget.notMeteredCodex', 'not metered (Codex brain)') : money(view.brainUsd);
    const line = tr('assistant.budget.sessionLine', '{total} spent of {hard} — brain {brain}, agents {agents}; {reserved} reserved by live runs, {available} left for new runs.', {
      total: money(view.totalUsd), hard: money(view.hardUsd), brain, agents: money(view.dispatchUsd), reserved: money(view.reservedUsd), available: money(view.availableUsd),
    });
    section.appendChild(el('div', 'asst-modal-note', line));
    if (Number(view.unpricedRuns) > 0) {
      const note = el('div', 'asst-modal-note asst-budget-unpriced', tr('assistant.budget.unpriced', '{n} run(s) used a model with no known price: their tokens are recorded but the dollar caps cannot meter them.', { n: view.unpricedRuns }));
      section.appendChild(note);
    }
    return section;
  }

  function capRow(field, errors) {
    const data = state.data;
    const row = el('div', 'asst-routes-row asst-budget-row');
    row.dataset.field = field.id;
    const main = el('div', 'asst-routes-row-main');
    const inputId = `asst-budget-${field.id}`;
    const label = el('label', 'asst-routes-row-label', tr(field.key, field.label));
    label.htmlFor = inputId;
    main.appendChild(label);
    main.appendChild(el('div', 'asst-budget-desc', tr(`${field.key}Desc`, field.desc)));
    const effective = data.budget?.[field.id];
    const def = data.defaults?.[field.id];
    main.appendChild(el('div', 'asst-budget-meta', tr('assistant.budget.effective', 'In effect: {value} · default {def}', { value: money(effective), def: money(def) })));
    const error = errors[field.id] || (state.serverField === field.id ? state.error : '');
    if (error) {
      const msg = el('div', 'asst-budget-field-error', error);
      msg.id = `${inputId}-error`;
      main.appendChild(msg);
    }
    row.appendChild(main);
    const wrap = el('div', 'asst-budget-amount');
    wrap.appendChild(el('span', 'asst-budget-unit', 'USD $'));
    const input = el('input', 'asst-dd-input asst-budget-input');
    input.id = inputId;
    input.type = 'number';
    input.inputMode = 'decimal';
    input.step = '0.01';
    input.min = String(data.bounds?.minUsd ?? BUDGET_BOUNDS.minUsd);
    input.max = String(data.bounds?.maxUsd ?? BUDGET_BOUNDS.maxUsd);
    input.value = state.draft[field.id] ?? '';
    if (error) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', `${inputId}-error`); }
    input.addEventListener('input', () => {
      state.draft[field.id] = input.value;
      if (state.serverField === field.id) { state.serverField = null; state.error = ''; }
      const pos = input.selectionStart;
      render();
      const again = modal.querySelector(`#${CSS.escape(inputId)}`);
      again?.focus({ preventScroll: true });
      try { again?.setSelectionRange?.(pos, pos); } catch { /* number inputs have no selection */ }
    });
    wrap.appendChild(input);
    row.appendChild(wrap);
    const source = String(state.draft[field.id]) === String(effective) ? (data.sources?.[field.id] || 'default') : 'edited';
    const badge = el('span', 'asst-routes-source', source === 'edited' ? tr('assistant.budget.sourceEdited', 'edited') : sourceLabel(source));
    badge.dataset.source = source === 'saved' || source === 'edited' ? 'yours' : 'default';
    row.appendChild(badge);
    return row;
  }

  function enforcementSection(data) {
    const section = el('section', 'asst-routes-section');
    section.appendChild(el('div', 'asst-routes-section-title', tr('assistant.budget.howEnforced', 'How caps are enforced')));
    const names = { 'claude-code': 'Claude', codex: 'Codex', opencode: 'OpenCode', brain: tr('assistant.budget.brainRow', 'Brain') };
    const list = el('ul', 'asst-budget-enforcement');
    for (const [id, info] of Object.entries(data.enforcement || {})) {
      const item = el('li');
      item.appendChild(el('strong', null, `${names[id] || id}: `));
      item.appendChild(document.createTextNode(`${info.perRun} ${info.session}`));
      list.appendChild(item);
    }
    section.appendChild(list);
    const pricing = data.pricing;
    if (pricing) {
      // One table prices the catalog and the usage ledger; models.dev only fills in Codex models it lacks.
      const fromTable = pricing.source === 'table' && pricing.table;
      section.appendChild(el('div', 'asst-modal-note', fromTable
        ? tr('assistant.budget.pricingTable', "List prices: SynaBun's table, checked against the Anthropic and OpenAI pricing pages on {date}. A Codex model it does not list is priced from models.dev.", { date: pricing.table.verified || '' })
        : pricing.available
          ? tr('assistant.budget.pricingOk', 'Codex list prices: models.dev (OpenCode cache).')
          : tr('assistant.budget.pricingMissing', 'Codex list prices unavailable (no OpenCode models.dev cache): Codex runs are flagged unpriced.')));
      const drift = Array.isArray(pricing.drift) ? [...new Set(pricing.drift.map((row) => row.model))] : [];
      if (drift.length) section.appendChild(el('div', 'asst-modal-note', tr('assistant.budget.pricingDrift', 'models.dev lists another price for {models}: the table may be out of date.', { models: drift.join(', ') })));
    }
    if (Array.isArray(data.repairs) && data.repairs.length) {
      section.appendChild(el('div', 'asst-modal-note asst-budget-unpriced', tr('assistant.budget.repaired', 'The saved file broke a rule ({fields}); the values in effect were corrected. Save to store them.', { fields: data.repairs.join(', ') })));
    }
    return section;
  }

  function render() {
    body.innerHTML = '';
    const { errors } = state.data ? validateBudgetDraft(state.draft, { bounds: state.data.bounds || BUDGET_BOUNDS, t: hooks.t }) : { errors: {} };
    if (state.error && !state.serverField) {
      const banner = el('div', 'asst-routes-error');
      banner.setAttribute('role', 'alert');
      banner.appendChild(el('span', null, state.error));
      if (state.conflict) {
        const reload = el('button', 'asst-btn asst-btn-secondary', tr('assistant.budget.reload', 'Reload'));
        reload.type = 'button';
        reload.addEventListener('click', () => load());
        banner.appendChild(reload);
      }
      body.appendChild(banner);
    }
    if (!state.data) { saveBtn.disabled = true; return; }
    if (state.data.session) body.appendChild(sessionSection(state.data.session));
    const caps = el('section', 'asst-routes-section');
    caps.appendChild(el('div', 'asst-routes-section-title', tr('assistant.budget.caps', 'Caps (US dollars)')));
    const list = el('div', 'asst-routes-list');
    for (const field of BUDGET_FIELDS) list.appendChild(capRow(field, errors));
    caps.appendChild(list);
    caps.appendChild(el('div', 'asst-modal-note', tr('assistant.budget.applies', 'Saved caps apply at once to open sessions and their runs: the next dispatch, follow-up, turn end and metered step. A Claude run keeps the CLI cap it started with, and the dispatcher also stops it at the new cap after its turn.')));
    body.appendChild(caps);
    body.appendChild(enforcementSection(state.data));
    saveBtn.disabled = state.saving || Object.keys(errors).length > 0;
  }

  async function load() {
    state.error = '';
    state.conflict = false;
    state.serverField = null;
    try {
      const data = await getBudget(hooks.sessionId || null);
      state.data = data || null;
      state.draft = Object.fromEntries(BUDGET_FIELDS.map((field) => [field.id, String(data?.budget?.[field.id] ?? '')]));
    } catch (err) {
      state.data = null;
      state.error = err?.status === 404
        ? tr('assistant.budget.unavailable', 'Budget settings are not available on this server yet (restart SynaBun to load them).')
        : `${tr('assistant.budget.loadFailed', 'Could not load the budget')}: ${err?.message || err}`;
    }
    render();
    modal.querySelector('.asst-budget-input')?.focus({ preventScroll: true });
  }

  async function save() {
    if (!state.data || state.saving) return;
    const { values, errors } = validateBudgetDraft(state.draft, { bounds: state.data.bounds || BUDGET_BOUNDS, t: hooks.t });
    if (Object.keys(errors).length) { render(); return; }
    state.saving = true;
    saveBtn.disabled = true;
    try {
      const res = await putBudget(values, state.data.version, hooks.sessionId || null);
      state.saving = false;
      state.data = res;
      try { hooks.onSaved?.(res); } catch { /* ignore */ }
      hooks.onToast?.(tr('assistant.budget.saved', 'Budget saved — applies now.'));
      close();
    } catch (err) {
      state.saving = false;
      if (err?.status === 409 || err?.code === 'VERSION_CONFLICT') {
        state.error = tr('assistant.budget.conflict', 'Changed elsewhere — reload to see the saved caps.');
        state.conflict = true;
      } else if (err?.code === 'BUDGET_INVALID' && err?.field && BUDGET_FIELDS.some((f) => f.id === err.field)) {
        state.error = err.message;
        state.serverField = err.field;
      } else {
        state.error = `${tr('assistant.budget.saveFailed', 'Could not save the budget')}: ${err?.message || err}`;
      }
      render();
    }
  }
  saveBtn.addEventListener('click', () => save());

  await load();
  return { el: overlay, close };
}
