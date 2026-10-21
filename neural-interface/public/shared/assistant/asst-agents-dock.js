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
// The head is always on screen while there are runs: beside the summary, one
// mini scene per working agent (asst-scenes.js; up to three, then "+N"), all
// moving at once. Open, each working agent's row has a lane: its mini scene
// and current step. A mini scene or a lane brings that run's card into view
// in the transcript (hooks.onReveal). hooks.onRunChange hears every change
// to a run, whatever its source, so the transcript's card follows the tray.

import { on } from '../state.js';
import { getProviderMeta } from '../provider-icons.js';
import { listAssistantRuns } from './asst-api.js';
import { buildRunCard, tickRunCard, updateRunCard } from './asst-render.js';
import { awaitsAnswer, compactActivity, isLivePhase, phaseLine, sceneFor, sceneSvg, stageLabel, stagePhase, stepLine } from './asst-scenes.js';
import { injectSceneStyles } from './asst-scene-styles.js';
import { plural } from './asst-tool-kinds.js';
import { isRemovableRun, isRunIdle, isTerminalRunStatus, mergeRunDescriptor, runFromPayload, runNeedsAttention, sortRuns } from './asst-state.js';

const TICK_MS = 5000;
const SHOW_ALL_LIMIT = 40;
const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;
const MINI_LIMIT = 3; // mini scenes in the head, then "+N"
const SCENE_DWELL_MS = 2500; // a scene the activity picked stays at least this long
const WORKING_PHASES = new Set(['queued', 'starting', 'working']); // live and not waiting on you (asst-scenes.js stagePhase)

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
 *          onRemove(runId), onClearFinished(runIds), onReveal(runId), onRunChange(run),
 *          open, showAll, onToggle(open), onShowAllChange(showAll),
 *          onCountChange({ total, active, attention, answer, idle, working, waiting, visible }) }
 */
export function createAgentsDock(hostEl, hooks = {}) {
  injectSceneStyles();
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
      <div class="asst-dock-minis" role="group" aria-label="${esc(t('assistant.dock.working', 'Agents at work'))}"></div>
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
  const minisEl = root.querySelector('.asst-dock-minis');
  const showAllBtn = root.querySelector('.asst-dock-showall');
  const stopAllBtn = root.querySelector('.asst-dock-stopall');
  const clearBtn = root.querySelector('.asst-dock-clear');
  const body = root.querySelector('.asst-dock-body');

  const runs = new Map();   // runId → descriptor
  const cards = new Map();  // runId → element
  const removed = new Set(); // runIds the user removed: late events never revive them
  const activities = new Map(); // runId → what its worker does now, compact ({ kind, name, step, at }), while the run lasts
  const minis = new Map(); // runId → its mini scene in the head
  let moreBtn = null;
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
      // Waiting on you, whatever for (a permission, a route card, your answer); `answer` is the part that
      // needs your answer, as its lane says (asst-scenes.js awaitsAnswer: a turn that ended asking, a question
      // mid-turn), and a warm worker that asked is never counted idle.
      attention: list.filter(r => runNeedsAttention(r) || awaitsAnswer(r)).length,
      answer: list.filter(awaitsAnswer).length,
      idle: list.filter(r => isRunIdle(r) && !awaitsAnswer(r)).length,
      finished: list.length - list.filter(r => !isTerminalRunStatus(r.status)).length,
      // The session's status reads these (asst-state.js sessionStatus): agents at work (queued for a free slot,
      // starting, in a turn) keep it working after its own turn ended; agents waiting on you make it need you.
      working: list.filter(r => WORKING_PHASES.has(stagePhase(r))).length,
      waiting: list.filter(r => stagePhase(r) === 'waiting').length,
      visible: list.length > 0,
    };
  }

  /** "2 running · 1 idle · 1 needs approval": each count in its own plural form (`key.one` / `key.other`, asst-tool-kinds.js plural). */
  function summaryText(c) {
    const bits = [];
    const running = c.active - c.attention - c.idle;
    if (running > 0) bits.push(plural(t, 'assistant.dock.running', running, '{count} running', '{count} running'));
    if (c.idle > 0) bits.push(plural(t, 'assistant.dock.idle', c.idle, '{count} idle', '{count} idle'));
    const approval = c.attention - (c.answer || 0);
    if (approval > 0) bits.push(plural(t, 'assistant.dock.needsApproval', approval, '{count} needs approval', '{count} need approval'));
    if (c.answer > 0) bits.push(plural(t, 'assistant.dock.needsAnswer', c.answer, '{count} waiting for your answer', '{count} waiting for your answer'));
    if (!bits.length && c.total) bits.push(plural(t, 'assistant.dock.done', c.total, '{count} finished', '{count} finished'));
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
    // Reconciled in place: a row that keeps its place keeps its node (and its mini scene keeps moving).
    let at = 0;
    for (const run of list) {
      seen.add(run.runId);
      let card = cards.get(run.runId);
      if (!card) { card = buildRunCard(run, cardOpts()); cards.set(run.runId, card); }
      else updateRunCard(card, run, cardOpts());
      card.setAttribute('role', 'listitem');
      syncLane(card, run);
      if (body.children[at] !== card) body.insertBefore(card, body.children[at] || null);
      at += 1;
    }
    for (const [runId, card] of cards) { if (!seen.has(runId)) { card.remove(); cards.delete(runId); } }
    while (body.children.length > at) body.lastElementChild.remove();
    renderMinis();

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

  // ── Working agents at a glance: mini scenes in the head, a lane per open row ──
  const workingRuns = () => sortRuns([...runs.values()]).filter(r => isLivePhase(stagePhase(r)));

  /** "Coding · Settings: App controls section · 3 min" (the stage's own name). */
  function labelOf(run, scene, phase) {
    const from = new Date(run.startedAt || run.createdAt || 0).getTime();
    return stageLabel({ scene, phase, title: run.title || run.task || run.runId, ms: from ? Date.now() - from : 0, run }, t);
  }

  /** Draw `scene` into `host` (an SVG of its own), unless the one there was picked under the dwell. */
  function paintScene(node, host, run, phase) {
    const now = Date.now();
    const scene = sceneFor(run, activities.get(run.runId), now);
    if (node.dataset.scene !== scene && (!node.dataset.scene || node.dataset.scene === 'generic' || now - (node._sceneAt || 0) >= SCENE_DWELL_MS)) {
      host.innerHTML = sceneSvg(scene, { mini: true });
      node.dataset.scene = scene;
      node._sceneAt = now;
    }
    node.dataset.phase = phase;
    host.firstElementChild?.toggleAttribute('data-live', phase !== 'waiting');
    return node.dataset.scene;
  }

  function reveal(runId) {
    if (runId) hooks.onReveal?.(runId);
  }

  function renderMinis() {
    const live = workingRuns();
    const shown = live.slice(0, MINI_LIMIT);
    const keep = new Set(shown.map(r => r.runId));
    for (const [runId, node] of minis) if (!keep.has(runId)) { node.remove(); minis.delete(runId); }
    shown.forEach((run, i) => {
      let node = minis.get(run.runId);
      if (!node) {
        node = el('button', 'asst-dock-mini');
        node.type = 'button';
        node.dataset.runId = run.runId;
        node.addEventListener('click', (e) => { e.stopPropagation(); reveal(node.dataset.runId); });
        minis.set(run.runId, node);
      }
      const phase = stagePhase(run);
      const scene = paintScene(node, node, run, phase);
      const label = labelOf(run, scene, phase);
      node.setAttribute('aria-label', t('assistant.dock.reveal', '{label}. Show it in the conversation', { label }));
      node.setAttribute('data-tooltip', label);
      if (minisEl.children[i] !== node) minisEl.insertBefore(node, minisEl.children[i] || null);
    });
    const extra = live.length - shown.length;
    if (extra > 0) {
      if (!moreBtn) {
        moreBtn = el('button', 'asst-dock-more');
        moreBtn.type = 'button';
        moreBtn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(true); });
      }
      moreBtn.textContent = `+${extra}`;
      const more = extra === 1 ? t('assistant.dock.more.one', '{count} more agent at work: show the list', { count: extra }) : t('assistant.dock.more.other', '{count} more agents at work: show the list', { count: extra });
      moreBtn.setAttribute('aria-label', more);
      moreBtn.setAttribute('data-tooltip', more);
      if (minisEl.lastElementChild !== moreBtn) minisEl.appendChild(moreBtn);
    } else moreBtn?.remove();
  }

  /** An open row's lane while its agent works: its mini scene and current step; a click shows its card. */
  function syncLane(card, run) {
    let lane = card.querySelector(':scope > .asst-run-lane');
    const phase = stagePhase(run);
    if (!isLivePhase(phase)) { lane?.remove(); return; }
    if (!lane) {
      lane = el('button', 'asst-run-lane');
      lane.type = 'button';
      lane.innerHTML = '<span class="asst-run-lane-scene" aria-hidden="true"></span><span class="asst-run-lane-step"></span>';
      lane.addEventListener('click', (e) => { e.stopPropagation(); reveal(card.dataset.runId); });
      const meta = card.querySelector(':scope > .asst-run-meta');
      if (meta) meta.after(lane); else card.appendChild(lane);
    }
    const scene = paintScene(lane, lane.querySelector('.asst-run-lane-scene'), run, phase);
    const step = phase === 'working' ? (stepLine(activities.get(run.runId), t) || phaseLine(phase, run, scene, t)) : phaseLine(phase, run, scene, t);
    const stepEl = lane.querySelector('.asst-run-lane-step');
    if (stepEl.textContent !== step) stepEl.textContent = step;
    lane.setAttribute('aria-label', t('assistant.dock.reveal', '{label}. Show it in the conversation', { label: labelOf(run, scene, phase) }));
  }

  /** The worker's provider events say what it does now: its mini scene and lane follow. Kept compact, and only while the run lasts. */
  function setRunActivity(runId, activity) {
    if (!runId || !runs.has(runId)) return;
    const run = runs.get(runId);
    const next = isTerminalRunStatus(run.status) ? null : compactActivity(activity, t);
    if (next) activities.set(runId, next); else activities.delete(runId);
    const card = cards.get(runId);
    if (card) syncLane(card, run);
    if (minis.has(runId)) renderMinis();
  }

  function syncTicker() {
    // Open: the rows' clocks; collapsed with agents at work: their mini scenes' names (whole minutes) and steps.
    const needs = !root.hidden && (open || minis.size > 0) && [...runs.values()].some(r => !isTerminalRunStatus(r.status));
    if (needs && !ticker) {
      ticker = setInterval(() => {
        if (open) for (const [runId, card] of cards) { const run = runs.get(runId); tickRunCard(card, run); if (run) syncLane(card, run); }
        renderMinis();
      }, TICK_MS);
    }
    if (!needs && ticker) { clearInterval(ticker); ticker = null; }
  }

  /** Every change to a run, whatever its source, reaches the panel (its transcript card follows). */
  function changed(run) {
    if (!run) return;
    try { hooks.onRunChange?.(run); } catch { /* the panel is gone */ }
  }

  function upsertRun(run) {
    const descriptor = runFromPayload(run) || run;
    if (!belongs(descriptor)) return null;
    const merged = mergeRunDescriptor(runs.get(descriptor.runId), descriptor);
    runs.set(descriptor.runId, merged);
    if (isTerminalRunStatus(merged.status)) activities.delete(merged.runId); // the run is over: so is what it was doing
    render();
    changed(merged);
    return merged;
  }

  /** Drop runs the server removed (this window or another one). */
  function dropRuns(runIds) {
    let changed = false;
    for (const runId of Array.isArray(runIds) ? runIds : [runIds]) {
      if (!runId) continue;
      removed.add(runId);
      activities.delete(runId);
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
    changed(next);
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
      const merged = [];
      for (const run of list) {
        const d = runFromPayload(run) || run;
        if (!belongs(d)) continue;
        const next = mergeRunDescriptor(runs.get(d.runId), d);
        runs.set(d.runId, next);
        if (isTerminalRunStatus(next.status)) activities.delete(d.runId);
        merged.push(next);
      }
      // When the terminal page was complete, previously known terminal runs
      // absent from it were removed elsewhere. A run arriving during refresh
      // must never be pruned by this older snapshot.
      if (terminal.length < 100) {
        for (const runId of knownTerminal) if (!listed.has(runId)) { runs.delete(runId); removed.add(runId); activities.delete(runId); }
      }
      render();
      for (const run of merged) changed(run);
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
  // The first fetch: what a reload knows about this session's runs (the panel restores their cards from it).
  const ready = Promise.resolve(refresh());

  return {
    el: root,
    ready,
    upsertRun,
    patchRun,
    patchUsageRun,
    setRunActivity,
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
      activities.clear();
      unsubs.forEach(off => { try { off(); } catch { /* ignore */ } });
      root.remove();
    },
  };
}
