// ═══════════════════════════════════════════
// SynaBun Assistant — agents tray (bottom card)
// ═══════════════════════════════════════════
// Rows for every run dispatched by this assistant session: provider icon,
// model, account, title, status pill, route tag, elapsed, cost, Focus / Stop /
// Read (+ Escalate when the server offers one; Remove once the run finished).
// Lives inside the bottom card
// above the composer: a one-line head ("Agents · 2 running · 1 needs
// approval"), collapsed by default, hidden entirely when there is nothing to
// show. Sources: active and recent terminal GET /api/assistant/runs at
// mount, then sync:sidepanel:run-* and sync:assistant:* bus events. A run
// removed here (or in another window: sync:assistant:run-removed) never comes
// back from a late event.

import { on } from '../state.js';
import { getProviderMeta } from '../provider-icons.js';
import { listAssistantRuns } from './asst-api.js';
import { buildRunCard, tickRunCard, updateRunCard } from './asst-render.js';
import { isRemovableRun, isRunIdle, isTerminalRunStatus, mergeRunDescriptor, runFromPayload, runNeedsAttention, sortRuns } from './asst-state.js';

const TICK_MS = 5000;
const SHOW_ALL_LIMIT = 40;
const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * createAgentsDock(hostEl, hooks)
 * hooks: { t, sessionId, onFocus(runId), onStop(runId), onRead(runId), onEscalate(runId, target), onStopAll(),
 *          onRemove(runId), onClearFinished(runIds),
 *          open, showAll, onToggle(open), onShowAllChange(showAll),
 *          onCountChange({ total, active, attention, visible }) }
 */
export function createAgentsDock(hostEl, hooks = {}) {
  const t = (key, fallback, params) => {
    const v = typeof hooks.t === 'function' ? hooks.t(key, params) : undefined;
    if (v && v !== key && typeof v === 'string') return v;
    return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
  };

  const root = el('div', 'asst-dock');
  root.hidden = true;
  const bodyId = `asst-dock-body-${Math.random().toString(36).slice(2, 8)}`;
  root.innerHTML = `
    <div class="asst-dock-head">
      <button type="button" class="asst-dock-toggle" aria-expanded="false" aria-controls="${bodyId}"><span class="asst-dock-chev" aria-hidden="true">&#x203A;</span><span class="asst-dock-title">${esc(t('assistant.dock.title', 'Agents'))}</span><span class="asst-dock-summary"></span></button>
      <span class="asst-dock-spacer"></span>
      <button type="button" class="asst-tb-btn asst-dock-showall" aria-pressed="false" hidden>${esc(t('assistant.dock.showAll', 'Show all'))}</button>
      <button type="button" class="asst-tb-btn asst-dock-clear" hidden>${esc(t('assistant.dock.clearFinished', 'Clear finished'))}</button>
      <button type="button" class="asst-btn asst-btn-danger asst-dock-stopall" hidden>${esc(t('assistant.dock.stopAll', 'Stop all'))}</button>
    </div>
    <div class="asst-dock-body" id="${bodyId}" role="list" hidden></div>
  `;
  hostEl.appendChild(root);

  const toggle = root.querySelector('.asst-dock-toggle');
  const summaryEl = root.querySelector('.asst-dock-summary');
  const showAllBtn = root.querySelector('.asst-dock-showall');
  const stopAllBtn = root.querySelector('.asst-dock-stopall');
  const clearBtn = root.querySelector('.asst-dock-clear');
  const body = root.querySelector('.asst-dock-body');

  const runs = new Map();   // runId → descriptor
  const cards = new Map();  // runId → element
  const removed = new Set(); // runIds the user removed: late events never revive them
  let open = hooks.open === true;
  let showAll = hooks.showAll === true;
  let ticker = null;
  let destroyed = false;
  const unsubs = [];

  function belongs(run) {
    if (!run?.runId || removed.has(run.runId) || run.removed === true) return false;
    if (!hooks.sessionId) return true;
    return run.assistantSessionId === hooks.sessionId;
  }

  function visibleRuns() {
    const all = sortRuns([...runs.values()]);
    if (showAll) return all.slice(0, SHOW_ALL_LIMIT);
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return all.filter((run) => !isTerminalRunStatus(run.status) || new Date(run.completedAt || run.updatedAt || 0).getTime() >= cutoff).slice(0, SHOW_ALL_LIMIT);
  }

  function counts() {
    const list = [...runs.values()];
    return {
      total: list.length,
      active: list.filter(r => !isTerminalRunStatus(r.status)).length,
      attention: list.filter(runNeedsAttention).length,
      idle: list.filter(isRunIdle).length,
      finished: list.length - list.filter(r => !isTerminalRunStatus(r.status)).length,
      visible: list.length > 0,
    };
  }

  function summaryText(c) {
    const bits = [];
    const running = c.active - c.attention - c.idle;
    if (running > 0) bits.push(t('assistant.dock.running', '{n} running', { n: running }));
    if (c.idle > 0) bits.push(t('assistant.dock.idle', '{n} idle', { n: c.idle }));
    if (c.attention > 0) bits.push(t('assistant.dock.needsApproval', '{n} needs approval', { n: c.attention }));
    if (!bits.length && c.total) bits.push(t('assistant.dock.done', '{n} finished', { n: c.total }));
    return bits.join(' · ');
  }

  function cardOpts() {
    return {
      t: hooks.t,
      compact: true,
      providerIcon: (p) => getProviderMeta(p).icon,
      providerColor: (p) => getProviderMeta(p).color,
      onFocus: hooks.onFocus,
      onStop: hooks.onStop,
      onRead: hooks.onRead,
      onEscalate: hooks.onEscalate,
      onRemove: typeof hooks.onRemove === 'function' ? hooks.onRemove : null,
    };
  }

  function render() {
    if (destroyed) return;
    const list = visibleRuns();
    const seen = new Set();
    const frag = document.createDocumentFragment();
    for (const run of list) {
      seen.add(run.runId);
      let card = cards.get(run.runId);
      if (!card) { card = buildRunCard(run, cardOpts()); cards.set(run.runId, card); }
      else updateRunCard(card, run, cardOpts());
      card.setAttribute('role', 'listitem');
      frag.appendChild(card);
    }
    for (const [runId, card] of cards) { if (!seen.has(runId)) { card.remove(); cards.delete(runId); } }
    body.innerHTML = '';
    body.appendChild(frag);

    const c = counts();
    root.hidden = c.total === 0;
    summaryEl.textContent = summaryText(c);
    root.classList.toggle('attention', c.attention > 0);
    stopAllBtn.hidden = c.active === 0;
    clearBtn.hidden = !open || typeof hooks.onClearFinished !== 'function' || ![...runs.values()].some(isRemovableRun);
    showAllBtn.hidden = !open;
    showAllBtn.setAttribute('aria-pressed', showAll ? 'true' : 'false');
    body.hidden = !open;
    root.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    hooks.onCountChange?.(c);
    syncTicker();
  }

  function syncTicker() {
    const needs = open && !root.hidden && [...runs.values()].some(r => !isTerminalRunStatus(r.status));
    if (needs && !ticker) ticker = setInterval(() => { for (const [runId, card] of cards) tickRunCard(card, runs.get(runId)); }, TICK_MS);
    if (!needs && ticker) { clearInterval(ticker); ticker = null; }
  }

  function upsertRun(run) {
    const descriptor = runFromPayload(run) || run;
    if (!belongs(descriptor)) return null;
    const merged = mergeRunDescriptor(runs.get(descriptor.runId), descriptor);
    runs.set(descriptor.runId, merged);
    render();
    return merged;
  }

  /** Drop runs the server removed (this window or another one). */
  function dropRuns(runIds) {
    let changed = false;
    for (const runId of Array.isArray(runIds) ? runIds : [runIds]) {
      if (!runId) continue;
      removed.add(runId);
      if (runs.delete(runId)) changed = true;
    }
    if (changed) render();
    return changed;
  }

  function patchRun(runId, patch) {
    const current = runs.get(runId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    runs.set(runId, next);
    render();
    return next;
  }

  function patchUsageRun(runId, tokens, fidelity) {
    const current = runs.get(runId);
    if (!current) return null;
    const next = { ...current, usageTokens: tokens, usageFidelity: fidelity, usageObserved: true };
    runs.set(runId, next);
    const card = cards.get(runId);
    if (card?.isConnected) updateRunCard(card, next, cardOpts());
    return next;
  }

  async function refresh() {
    if (!hooks.sessionId) return;
    const knownTerminal = [...runs].filter(([, run]) => isTerminalRunStatus(run.status)).map(([runId]) => runId);
    try {
      const [active, terminal] = await Promise.all([
        listAssistantRuns({ assistantSessionId: hooks.sessionId, active: true }),
        listAssistantRuns({ assistantSessionId: hooks.sessionId, status: 'terminal', limit: 100 }),
      ]);
      const listed = new Set();
      const list = [...active, ...terminal].filter((run) => {
        const id = run?.runId || run?.run?.runId;
        if (!id || listed.has(id)) return false;
        listed.add(id);
        return true;
      });
      for (const run of list) { const d = runFromPayload(run) || run; if (belongs(d)) runs.set(d.runId, mergeRunDescriptor(runs.get(d.runId), d)); }
      // When the terminal page was complete, previously known terminal runs
      // absent from it were removed elsewhere. A run arriving during refresh
      // must never be pruned by this older snapshot.
      if (terminal.length < 100) {
        for (const runId of knownTerminal) if (!listed.has(runId)) { runs.delete(runId); removed.add(runId); }
      }
      render();
    } catch { /* offline or not built yet */ }
  }

  function setOpen(value) {
    open = !!value;
    render();
    hooks.onToggle?.(open);
  }

  toggle.addEventListener('click', () => setOpen(!open));
  showAllBtn.addEventListener('click', () => { showAll = !showAll; hooks.onShowAllChange?.(showAll); refresh().finally(render); });
  stopAllBtn.addEventListener('click', () => hooks.onStopAll?.());
  clearBtn.addEventListener('click', () => {
    const ids = [...runs.values()].filter(isRemovableRun).map(r => r.runId);
    if (ids.length) hooks.onClearFinished?.(ids);
  });

  // ── Bus subscriptions ──
  const onRunEvent = (msg) => { const run = runFromPayload(msg); if (run) upsertRun(run); };
  for (const ev of ['sync:sidepanel:run-created', 'sync:sidepanel:run-updated', 'sync:sidepanel:run-claimed', 'sync:sidepanel:run-completed', 'sync:sidepanel:run-failed', 'sync:sidepanel:run-stopped']) {
    unsubs.push(on(ev, onRunEvent));
  }
  unsubs.push(on('sync:assistant:dispatch', onRunEvent));
  unsubs.push(on('sync:assistant:run-removed', (msg) => {
    if (hooks.sessionId && msg?.assistantSessionId && msg.assistantSessionId !== hooks.sessionId) return;
    dropRuns(msg?.runIds || []);
  }));
  unsubs.push(on('sync:assistant:permission-request', (msg) => {
    const runId = msg?.run?.runId || msg?.runId;
    if (runId && runs.has(runId)) patchRun(runId, { turnState: 'awaiting_permission' });
  }));
  unsubs.push(on('sync:assistant:permission-resolved', (msg) => {
    const runId = runFromPayload(msg)?.runId || msg?.runId;
    if (runId && runs.get(runId)?.turnState === 'awaiting_permission') patchRun(runId, { turnState: 'running' });
  }));
  unsubs.push(on('sync:assistant:cost', (msg) => {
    const runId = msg?.runId || runFromPayload(msg)?.runId;
    if (runId && Number.isFinite(Number(msg?.costUsd))) patchRun(runId, { costUsd: Number(msg.costUsd) });
  }));

  render();
  refresh();

  return {
    el: root,
    upsertRun,
    patchRun,
    patchUsageRun,
    dropRuns,
    getRun: (runId) => runs.get(runId) || null,
    getRuns: () => sortRuns([...runs.values()]),
    activeRuns: () => [...runs.values()].filter(r => !isTerminalRunStatus(r.status)),
    counts,
    setOpen,
    isOpen: () => open,
    setShowAll(value) { showAll = !!value; refresh().finally(render); },
    render,
    refresh,
    destroy() {
      destroyed = true;
      if (ticker) clearInterval(ticker);
      unsubs.forEach(off => { try { off(); } catch { /* ignore */ } });
      root.remove();
    },
  };
}
