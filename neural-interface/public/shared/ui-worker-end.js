// ═══════════════════════════════════════════
// SynaBun Neural Interface — how a dispatched worker's tab ends: the page side
// ═══════════════════════════════════════════
//
// What the three provider sidepanels (Claude Code, Codex, OpenCode) share for
// the end of a worker the Assistant dispatched: following the run until it
// has something to show, asking the dispatcher how it went (GET
// /api/assistant/runs/:runId, then its `assistant:dispatch` events), the card
// itself, and the way back to the Assistant session that dispatched it. What
// the card says is worker-end.js; where it goes in a transcript, how it looks
// and how its tab closes are each panel's own (every panel passes its own
// classes and its own close action, so the card wears that panel's styles).
//
// The way back closes the worker's tab with the close the panel's own X runs
// (it never deletes the run record: the Assistant still reads its result, and
// the agents dock still lists it) and then shows the session through
// `assistant:show` with the sidepanel as the host for a session that is open
// nowhere: the terminal tab or the sidepanel that has it keeps it. Closing the
// tab of a worker that finished its task completes its run instead of
// stopping it (endWorkerRunOnClose): the Assistant reads it as done, never as
// stopped by the user.

import { emit, on } from './state.js';
import { t } from './i18n.js';
import { TERMINAL_STATES, WORKER_END_CLASS, isDispatchedRun, isRunWorking, mayHaveEnded, workerEndView } from './worker-end.js';

export { WORKER_END_CLASS };

const translate = (key, params) => t(`workerEnd.${key}`, params);

// runId → { run, dispatch, settled, wasWorking, busy, apply, readKey, sig }
const _runs = new Map();
let _wired = false;

function newer(next, current) {
  if (!current) return true;
  // A run resumed after a server restart (`resumes` only grows) is newer whatever its version: a crash can lose the
  // last saved versions of a run a page already saw.
  const resumed = (Number(next?.resumes) || 0) - (Number(current?.resumes) || 0);
  if (resumed) return resumed > 0;
  const a = Number(next?.version) || 0;
  const b = Number(current?.version) || 0;
  if (a !== b) return a > b;
  return String(next?.updatedAt || '') >= String(current?.updatedAt || '');
}

function wire() {
  if (_wired) return;
  _wired = true;
  // Every change of a run the dispatcher makes (a turn, a result, the end, a
  // failure's cause judged later) reaches the tab without another request.
  on('sync:assistant:dispatch', (message) => {
    const view = message?.run;
    const entry = view?.runId ? _runs.get(view.runId) : null;
    if (!entry || !newer(view, entry.dispatch)) return;
    noteDispatch(entry, view);
    paint(entry);
  });
}

function noteDispatch(entry, view) {
  entry.dispatch = view;
  entry.settled = true;
  // What the run was doing before it ended: a stop in the middle of a turn is a stop.
  if (!TERMINAL_STATES.has(String(view.state || ''))) entry.wasWorking = isRunWorking(null, view);
}

function paint(entry) {
  const view = workerEndView(entry.run, entry.dispatch, { t: translate, busy: entry.busy, stoppedMidTurn: entry.wasWorking });
  // An ended run is drawn once the dispatcher has answered: never "Stopped" first and "Task complete" a moment later.
  if (view && !entry.settled) return;
  const sig = view?.sig || '';
  if (sig === entry.sig) return;
  entry.sig = sig;
  try { entry.apply(view); } catch (error) { console.warn('[worker-end] a panel failed to draw the end of a run', error); }
}

async function read(entry) {
  const run = entry.run;
  const key = `${run.status}|${run.turnState || ''}|${run.version || 0}`;
  if (entry.readKey === key) return;
  entry.readKey = key;
  try {
    const response = await fetch(`/api/assistant/runs/${encodeURIComponent(run.runId)}`);
    const data = response.ok ? await response.json() : null;
    if (_runs.get(run.runId) !== entry) return;
    if (data?.run && newer(data.run, entry.dispatch)) noteDispatch(entry, data.run);
  } catch {
    if (_runs.get(run.runId) !== entry) return;
  }
  // No answer (an older server, a run the dispatcher no longer keeps): the runtime's own reading is drawn.
  entry.settled = true;
  paint(entry);
}

/**
 * Follow a run attached to a provider tab. Call it on every attach (the
 * router attaches again on each change of the run): `apply(view)` is called
 * with the card to show, or null to take it away, only when that changes.
 * A run the Assistant did not dispatch gets `apply(null)` and is not followed.
 *
 * @param {object} run the runtime descriptor the panel was attached with
 * @param {object} o
 * @param {(view: object | null) => void} o.apply draw the card (or remove it)
 * @param {boolean} [o.busy] the tab sees background work of the run still going
 */
export function trackWorkerEnd(run, { apply, busy = false } = {}) {
  if (!run?.runId || typeof apply !== 'function') return;
  if (!isDispatchedRun(run)) {
    _runs.delete(run.runId);
    apply(null);
    return;
  }
  wire();
  let entry = _runs.get(run.runId);
  if (!entry) {
    entry = { run: null, dispatch: null, settled: false, wasWorking: false, busy: false, apply, readKey: '', sig: null };
    _runs.set(run.runId, entry);
  }
  entry.apply = apply;
  entry.busy = !!busy;
  if (newer(run, entry.run)) entry.run = run;
  if (!TERMINAL_STATES.has(String(entry.run.status || '')) && !TERMINAL_STATES.has(String(entry.dispatch?.state || ''))) {
    entry.wasWorking = isRunWorking(entry.run, null);
  }
  paint(entry);
  if (mayHaveEnded(entry.run)) read(entry);
}

/** The tab saw its background work change: the card of a warm worker waits for it. */
export function updateWorkerEndBusy(runId, busy) {
  const entry = _runs.get(runId);
  if (!entry || entry.busy === !!busy) return;
  entry.busy = !!busy;
  paint(entry);
}

/** The tab of the run closed (or let the run go): stop following it. */
export function forgetWorkerEnd(runId) {
  if (runId) _runs.delete(runId);
}

/**
 * The run reported its task done and waits warm for a follow-up, with no
 * background work of its own going: its card is (or would be) a warm "Task
 * complete". Known only for a run the tab follows, so ask before forgetWorkerEnd().
 */
export function isFinishedWarmWorker(runId, { busy = false } = {}) {
  const entry = runId ? _runs.get(runId) : null;
  if (!entry?.settled || !entry.run) return false;
  const view = workerEndView(entry.run, entry.dispatch, { busy: busy || entry.busy, stoppedMidTurn: entry.wasWorking });
  return view?.kind === 'complete' && view.warm;
}

/**
 * End the run of a worker tab the user closes (its X, or Back to Assistant).
 * A worker that finished its task and waits warm for a follow-up is completed
 * (POST /api/assistant/runs/:runId/tab-closed: completed, reason `tab_closed`,
 * its result untouched). Any other run, a run the server finds working after
 * all, and a server without that route get `stop()`: the panel's own stop,
 * what its X always did. Decided when called: call it before forgetWorkerEnd().
 *
 * @param {string} runId
 * @param {() => void} stop the panel's stop (POST /api/loop/stop)
 * @param {object} [o]
 * @param {boolean} [o.busy] the tab sees background work of the run still going
 * @returns {Promise<'completed' | 'stopped'>}
 */
export function endWorkerRunOnClose(runId, stop, { busy = false } = {}) {
  const stopped = () => { stop(); return 'stopped'; };
  if (!isFinishedWarmWorker(runId, { busy })) return Promise.resolve(stopped());
  return fetch(`/api/assistant/runs/${encodeURIComponent(runId)}/tab-closed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).then(async (response) => {
    const data = response.ok ? await response.json().catch(() => null) : null;
    return data?.ok ? 'completed' : stopped();
  }).catch(stopped);
}

/**
 * Show the Assistant session that dispatched a run: focused where it is open
 * (the terminal tab or the sidepanel), else opened in the Assistant sidepanel.
 */
export function backToAssistant(assistantSessionId) {
  if (!assistantSessionId) return false;
  emit('assistant:show', { sessionId: assistantSessionId, host: 'sidepanel' });
  return true;
}

/**
 * The card. Every element takes the owning panel's classes, so it is drawn in
 * that panel's type and colours; `data-tone` (ok, warn, err, off) is what the
 * panel's styles colour the title by, and the title always says the state in
 * words. The button is there only for a run with a dispatching session, and
 * works once.
 *
 * @param {object} view a workerEndView() result
 * @param {object} [o]
 * @param {{ card?: string, title?: string, detail?: string, meta?: string, note?: string, actions?: string, button?: string }} [o.classes]
 * @param {(view: object) => (void | boolean | Promise<void | boolean>)} [o.onBack] close the tab, then
 *   backToAssistant(); `false` when the tab stayed (the button works again)
 */
export function buildWorkerEndCard(view, { classes = {}, onBack = null } = {}) {
  const card = document.createElement('div');
  card.className = [WORKER_END_CLASS, classes.card].filter(Boolean).join(' ');
  card.dataset.workerEnd = view.kind;
  card.dataset.tone = view.tone;
  card.setAttribute('role', 'status');

  const title = document.createElement('div');
  title.className = ['worker-end-title', classes.title].filter(Boolean).join(' ');
  title.textContent = view.title;
  card.appendChild(title);

  for (const part of ['detail', 'meta', 'note']) {
    if (!view[part]) continue;
    const el = document.createElement('div');
    el.className = [`worker-end-${part}`, classes[part]].filter(Boolean).join(' ');
    el.textContent = view[part];
    card.appendChild(el);
  }

  if (view.assistantSessionId && typeof onBack === 'function') {
    const actions = document.createElement('div');
    actions.className = ['worker-end-actions', classes.actions].filter(Boolean).join(' ');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = ['worker-end-back', classes.button].filter(Boolean).join(' ');
    button.textContent = view.backLabel;
    button.title = view.backHint;
    button.addEventListener('click', () => {
      if (button.disabled) return;
      button.disabled = true;
      Promise.resolve()
        .then(() => onBack(view))
        // `false`: the panel asked first and the user kept the tab.
        .then((done) => { if (done === false) button.disabled = false; })
        .catch((error) => {
          console.warn('[worker-end] going back to the Assistant failed', error);
          button.disabled = false;
        });
    });
    actions.appendChild(button);
    card.appendChild(actions);
  }
  return card;
}
