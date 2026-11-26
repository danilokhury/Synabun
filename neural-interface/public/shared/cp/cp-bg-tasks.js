// ── Background tasks of a Claude Code panel tab (glue over public/shared/bg-tasks/) ──
//
// The registry, the view and the badges are the shared module's; this file only says where a Claude tab's
// pieces are: its session's routes (GET …/background-tasks and its output pages), the bridge's own Stop
// (`stop_task` on the tab's socket → the SDK's stopTask) and the tab's transcript for the notice cards.

import { createBgTasksPanel } from '../bg-tasks/bg-tasks-panel.js';
import { claudeFactsFromEvent, claudeLiveFact } from '../bg-tasks/bg-tasks-claude.js';
import { exitCodeOf, noticeCardView } from '../bg-tasks/bg-tasks-model.js';
import { markStaleNoticeCards, renderBgNoticeCard } from '../bg-tasks/bg-tasks-view.js';

const STOP_WAIT_MS = 15_000;

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { res, body };
}

/**
 * The tab's background tasks: `tab.bg`. `project()` is the project its transcript is read under (the panel's
 * _historyProject), `onChange` repaints its badges.
 */
export function attachClaudeBgTasks(tab, { storage = null, t = null, project = () => '', onChange = () => {}, onShownChange = () => {} } = {}) {
  const query = () => {
    const p = new URLSearchParams();
    const proj = project() || '';
    if (proj) p.set('project', proj);
    if (tab.accountId) p.set('account', tab.accountId);
    return p;
  };
  const base = () => (tab.sessionId ? `/api/claude-code/sessions/${encodeURIComponent(tab.sessionId)}/background-tasks` : '');
  tab._bgStopWaits = tab._bgStopWaits || new Map();
  tab.bg = createBgTasksPanel({
    key: tab.sessionId ? `claude:${tab.sessionId}` : '',
    factsOf: (ev) => claudeFactsFromEvent(ev),
    liveFactOf: (tasks) => claudeLiveFact(tasks),
    storage,
    t,
    onChange,
    onShownChange,
    api: {
      async list() {
        const url = base();
        if (!url) return null;
        const { res, body } = await getJson(`${url}?${query()}`);
        // A server from before this view has no such route (its 404 names no code): its output waits for a restart.
        if (res.status === 404 && !body?.code) return { unsupported: true };
        return res.ok && body?.ok ? body : null;
      },
      async output({ taskId, cursor, tail, limit, running }) {
        const url = base();
        if (!url) return { ok: false, status: 404, error: 'No session yet.' };
        const p = query();
        if (cursor != null) p.set('cursor', String(cursor));
        if (tail != null) p.set('tail', String(tail));
        if (limit != null) p.set('limit', String(limit));
        if (typeof running === 'boolean') p.set('running', running ? '1' : '0');
        try {
          const { res, body } = await getJson(`${url}/${encodeURIComponent(taskId)}/output?${p}`);
          if (!res.ok || !body?.ok) return { ok: false, status: res.status, error: body?.error || 'The output could not be read.' };
          return { status: 200, data: body };
        } catch (err) { return { ok: false, status: 502, error: err?.message || 'The output could not be read.' }; }
      },
      // The bridge's own stop (the SDK's stopTask), never a kill typed by hand.
      stop(taskId) {
        const ws = tab.ws;
        if (!ws || ws.readyState !== 1) return Promise.resolve({ ok: false, error: 'The session is not connected.' });
        if (tab.capabilities instanceof Set && !tab.capabilities.has('task_control')) return Promise.resolve({ ok: false, error: 'Stopping a task from here needs the SynaBun server restart.' });
        return new Promise((resolve) => {
          const timer = setTimeout(() => { tab._bgStopWaits.delete(taskId); resolve({ ok: false, error: 'No answer from the session.' }); }, STOP_WAIT_MS);
          tab._bgStopWaits.set(taskId, (out) => { clearTimeout(timer); resolve(out); });
          try { ws.send(JSON.stringify({ type: 'stop_task', taskId })); }
          catch (err) { clearTimeout(timer); tab._bgStopWaits.delete(taskId); resolve({ ok: false, error: err?.message || String(err) }); }
        });
      },
    },
  });
  return tab.bg;
}

/** The bridge answered a `stop_task` (task_control_result): the Stop that waited for it hears. → whether one did. */
export function settleClaudeBgStop(tab, msg) {
  if (msg?.action !== 'stop_task' || !tab?._bgStopWaits?.size) return false;
  const id = msg.taskId && tab._bgStopWaits.has(msg.taskId) ? msg.taskId : [...tab._bgStopWaits.keys()][0];
  const done = tab._bgStopWaits.get(id);
  tab._bgStopWaits.delete(id);
  done?.({ ok: !!msg.ok, error: msg.error || '' });
  return true;
}

/**
 * The cards of a replayed `origin` row whose notices the server read (lib/claude-history.js `notifications`),
 * linked to the task the registry knows (or what the notice says).
 */
export function historyNoticeCards(tab, row, t = null) {
  const out = [];
  const at = Date.parse(row?.timestamp || '') || 0;
  for (const n of Array.isArray(row?.notifications) ? row.notifications : []) {
    if (!n?.taskId) continue;
    const task = tab?.bg?.registry?.().tasks.get(n.taskId) || null;
    const view = noticeCardView({ taskId: n.taskId, type: n.event || /^monitor\b/i.test(n.summary || '') ? 'watch' : 'shell', status: n.status || (n.event ? 'event' : ''), summary: n.summary || '', event: n.event || '', exitCode: exitCodeOf(n.summary), stale: false }, task);
    const card = renderBgNoticeCard(view, { t });
    if (at) card.dataset.at = String(at);
    if (view.isEvent) card.dataset.event = '1';
    out.push(card);
  }
  return out;
}

/** After a rebuild, the replayed cards of events that came after their task's end say they are stale. */
export function markClaudeStaleCards(tab) {
  if (tab?.messagesEl && tab.bg) markStaleNoticeCards(tab.messagesEl, tab.bg.registry());
}

/**
 * One click listener per transcript (a transcript put back from a stored snapshot has no listeners of its own):
 * a notice card opens its task in the view.
 */
export function wireNoticeCardClicks(container, open) {
  if (!container || container._sbtNoticeWired) return;
  container._sbtNoticeWired = true;
  container.addEventListener('click', (event) => {
    const card = event.target?.closest?.('.sbt-notice[data-task-id]');
    if (!card || !container.contains(card)) return;
    event.preventDefault();
    open(card.dataset.taskId);
  });
}
