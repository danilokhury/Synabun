// ── What comes back ──
// A saved tab after the server restarted, a cached transcript when its session
// is reopened, the "Load earlier" pager inside it, the project a history
// request names. The decisions are here, DOM-free; the panel and
// cp-rehydrate.js act on them.

import { normalizeSession } from './cp-session-model.js';
import { TOOL_POLICIES, BYPASS_MODE } from './cp-permission-model.js';
import { applyTaskTool } from './cp-tool-results.js';

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']);

/**
 * A saved tab after the server restarted. What ran in the old process is gone
 * with it and is dropped: the running flag, the queue, the plan banner, the
 * session cost (re-synced on attach). What the user configured is not running
 * state and stays: the Claude account the conversation belongs to, the tool
 * policy, the permission mode (Bypass only as the user's recorded pick), the
 * session settings (limits, sandbox,
 * directories, tool lists, MCP servers, agents, overrides). Dropping those
 * would bring a restricted tab back unrestricted, under the default account.
 */
export function scrubSavedTab(t) {
  const saved = t && typeof t === 'object' ? t : {};
  const out = {
    id: saved.id,
    sessionId: saved.sessionId || null,
    label: saved.label || '',
    titleState: saved.titleState || (saved.sessionId || (saved.label && saved.label !== 'New chat') ? 'manual' : 'default'),
    project: saved.project || '',
    model: saved.model || '',
    effort: saved.effort || '',
    automationRunId: saved.automationRunId || null,
    automationActive: false,
    automationOwnerId: saved.automationOwnerId || null,
  };
  if (typeof saved.accountId === 'string' && ACCOUNT_ID.test(saved.accountId)) out.accountId = saved.accountId;
  if (typeof saved.toolPolicy === 'string' && Object.hasOwn(TOOL_POLICIES, saved.toolPolicy)) out.toolPolicy = saved.toolPolicy;
  const mode = saved.permissionMode || (saved.planMode ? 'plan' : '');
  // A saved Bypass is kept only with the record that the user picked it; any
  // other one is dropped here, and the tab comes back as one that never picked
  // a mode (restoredMode() in cp-permission-model.js decides the same on restore).
  if (PERMISSION_MODES.has(mode) && (mode !== BYPASS_MODE || saved.bypassChosen === true)) {
    out.permissionMode = mode;
    if (typeof saved.modeChosen === 'boolean') out.modeChosen = saved.modeChosen;
    if (mode === BYPASS_MODE) out.bypassChosen = true;
  }
  if (saved.planMode === true) out.planMode = true;
  // The number of the tab's latest statement of its mode only grows, also across
  // a restart; and plan mode comes back with what the tab was before it
  // (restoredMode() checks it: a Bypass there needs its own record).
  if (Number.isSafeInteger(saved.modeSeq) && saved.modeSeq > 0) out.modeSeq = saved.modeSeq;
  // Whether the tab may be in Bypass stays with it: only a report of its session ends that (restoredMode()).
  if (saved.sessionBypass === true) out.sessionBypass = true;
  if (saved.planFrom && typeof saved.planFrom === 'object' && (out.permissionMode === 'plan' || out.planMode)) out.planFrom = { mode: String(saved.planFrom.mode || ''), ...(saved.planFrom.bypassChosen === true ? { bypassChosen: true } : {}) };
  if (saved.session && typeof saved.session === 'object') out.session = normalizeSession(saved.session);
  const at = transcriptPlace(saved.transcriptAt, out.sessionId);
  if (at) out.transcriptAt = at;
  return out;
}

// Where a tab found its session's transcript when that was not the tab's own
// project: `{ sessionId, project }`, or null when it is not about `sessionId`.
function transcriptPlace(at, sessionId) {
  if (!at || typeof at !== 'object' || !sessionId || at.sessionId !== sessionId) return null;
  if (typeof at.project !== 'string' || !at.project) return null;
  return { sessionId, project: at.project };
}

/**
 * The messages, other than a query or a warm start, that can start a tab's CLI
 * process: each is sent with the tab's configuration (`config`: the fields of
 * an ordinary query, without a prompt). After a server restart, or when an
 * idle tab's socket was replaced, the bridge holds nothing of the tab but its
 * session id; the first message to reach it must bring the account, the tool
 * policy, the permission mode and the session settings, or the bridge starts
 * nothing. `session_request` is here for its rewind preview.
 */
export const START_CONFIG_TYPES = Object.freeze(['compact', 'rewind', 'rewind_conversation', 'session_request']);

/** `msg` as it goes on the wire: with `config` when its type can start the process. */
export function withStartConfig(msg, config) {
  if (!config || typeof config !== 'object' || !START_CONFIG_TYPES.includes(msg?.type)) return msg;
  return { ...msg, config };
}

/**
 * The project a history request names for a tab: the tab's own. The project
 * picker shows the active tab's project, so it stands in only for the active
 * tab; for any other tab without one, none is named (the server then looks in
 * every registered project instead of in the wrong one).
 */
export function historyProjectOf(tab, { pickerProject = '', isActive = false, sessionId = '' } = {}) {
  // A transcript that was found under another registered project than the
  // tab's own (transcriptOwner) is read from there, for that session only.
  const at = transcriptPlace(tab?.transcriptAt, sessionId || tab?.sessionId);
  if (at) return at.project;
  return (typeof tab?.project === 'string' && tab.project) || (isActive ? String(pickerProject || '') : '');
}

/**
 * What the history route answered:
 *   'rows'                 a transcript with something to show
 *   'empty'                a transcript with nothing in it
 *   'account_unavailable'  the tab's Claude account is no longer set up
 *   'not_in_project'       no transcript of this session in the project named
 *   'not_found'            none in any registered project
 *   'refused'              any other refusal (the project is not registered, …)
 */
export function historyOutcome(data) {
  const d = data && typeof data === 'object' ? data : {};
  if (Array.isArray(d.messages) && d.messages.length) return 'rows';
  if (d.code === 'account_unavailable') return 'account_unavailable';
  if (d.code === 'transcript_not_found') return d.scope === 'project' ? 'not_in_project' : 'not_found';
  if (d.error) return 'refused';
  return 'empty';
}

/**
 * The registered project a session's transcript is under, read from the
 * session's own entry in the session list (`GET /api/claude-code/sessions`
 * finds a session by its id): its path, or '' when the list does not have the
 * session or only names the project already asked.
 */
export function transcriptOwner(list, sessionId, asked = '') {
  for (const p of Array.isArray(list?.projects) ? list.projects : []) {
    if (typeof p?.path !== 'string' || !p.path || p.path === asked) continue;
    if ((Array.isArray(p.sessions) ? p.sessions : []).some(s => s?.sessionId === sessionId)) return p.path;
  }
  return '';
}

/** The sentence for a transcript that was not found (never "No messages": the session is not empty, it is elsewhere or gone). */
export function historyNotFoundText(data, { project = '' } = {}) {
  if (data?.scope === 'project') {
    const name = String(project || '').split(/[/\\]/).filter(Boolean).pop() || '';
    return `This session's transcript was not found in this tab's project${name ? ` (${name})` : ''}. If it belongs to another project, open it from the session menu of that project.`;
  }
  return 'This session\'s transcript was not found in any registered project: it was deleted, or its project is no longer registered.';
}

/** Every transcript uuid the rows under `$msgs` carry (prompts: data-uuid; replies: data-uuids). */
export function shownUuids($msgs) {
  const out = new Set();
  if (!$msgs?.querySelectorAll) return out;
  for (const row of $msgs.querySelectorAll('[data-uuid], [data-uuids]')) {
    if (row.dataset?.uuid) out.add(row.dataset.uuid);
    for (const id of String(row.dataset?.uuids || '').split(' ')) if (id) out.add(id);
  }
  return out;
}

/**
 * The uuid the rows under `$msgs` end on: the last line of the last prompt or
 * reply row, '' when no row carries one. Top-level rows only (a subagent's
 * rows inside a card are not the conversation's end).
 */
export function shownTail($msgs) {
  const rows = $msgs?.children ? [...$msgs.children] : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const ids = String(rows[i].dataset?.uuids || '').split(' ').filter(Boolean);
    if (ids.length) return ids[ids.length - 1];
    if (rows[i].dataset?.uuid) return rows[i].dataset.uuid;
  }
  return '';
}

/**
 * Whether a restored snapshot may stay on screen. `probe` is the history
 * route's answer for the owning tab's project and account (one row is enough:
 * the counts and the leaf come with it).
 *   'rebuild'  the transcript does not end where the snapshot does: it moved
 *              on (more rows), another branch is active (a conversation rewind
 *              replaced what the snapshot shows, even with fewer rows), it was
 *              cut back to an entry the snapshot shows further up, or it is
 *              empty; or the tab's account is gone or the transcript is not
 *              where the tab looks (the rebuild says so instead of showing a
 *              stale conversation); or the snapshot predates tool results the
 *              server can now return
 *   'keep'     the snapshot is current, or the server could not say
 * @param shown        uuids of the restored rows, in order (shownUuids)
 * @param tail         the uuid the restored rows end on (shownTail); when not
 *                     given, the last of `shown`
 * @param wantsResults snapshotWantsResults(snapshot, probe), decided by the caller
 */
export function snapshotVerdict(snapshot, probe, shown, { wantsResults = false, tail } = {}) {
  const p = probe && typeof probe === 'object' ? probe : {};
  if (p.code === 'account_unavailable' || p.code === 'transcript_not_found') return 'rebuild';
  if (p.error) return 'keep';
  const cached = Number(snapshot?.itemCount) || 0;
  // `visible` counts prompts and replies only (a server that predates it sends `total`).
  if ((p.visible ?? p.total ?? 0) > cached + 2) return 'rebuild';
  if (typeof p.leaf === 'string') {
    const list = shown instanceof Set ? [...shown] : (Array.isArray(shown) ? shown : []);
    const end = typeof tail === 'string' ? tail : (list.length ? list[list.length - 1] : '');
    // The transcript ends on its last prompt or reply (`leaf`). That it is
    // somewhere among the rows shown is not enough: after a rewind to an entry
    // already on screen, everything below it is an abandoned branch.
    if (p.leaf && p.leaf !== end) return 'rebuild';
    // Nothing left in the transcript, and the snapshot shows a conversation.
    if (!p.leaf && p.visible === 0 && (end || cached > 0)) return 'rebuild';
  }
  return wantsResults ? 'rebuild' : 'keep';
}

/**
 * Where a "Load earlier" note stands, read back from a restored snapshot: the
 * index its page starts at and the total, as _addHistoryPager stamped them
 * (`data-start`, `data-total`). A note stored before the stamps is read from
 * its sentence ("Showing 120 of 500 entries"). Null when there is nothing
 * earlier to load or the note cannot be read.
 */
export function pagerState(dataset, labelText = '') {
  let start = Number(dataset?.start);
  let total = Number(dataset?.total);
  if (!(dataset?.start !== undefined && dataset.start !== '' && Number.isFinite(start) && Number.isFinite(total))) {
    const m = /^Showing (\d+) of (\d+) entries/.exec(String(labelText || '').trim());
    if (!m) return null;
    total = Number(m[2]);
    start = total - Number(m[1]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(total) || start <= 0 || total <= start) return null;
  return { start, total };
}

/**
 * Split a history page into `{ head, tail }` so the visible tail (~40 rows) can
 * paint and scroll immediately while earlier rows prepend in chunked tasks.
 * Never splits an `assistant` `tool_use` from its matching `tool_result`.
 */
export function splitHistoryTail(messages, tailSize = 40) {
  const list = Array.isArray(messages) ? messages : [];
  const cap = Math.max(1, Number(tailSize) || 40);
  if (list.length <= Math.ceil(cap * 1.5)) return { head: [], tail: list };
  let cut = list.length - cap;
  const indexOfToolUse = new Map();
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m?.role === 'assistant' && Array.isArray(m.tools)) {
      for (const t of m.tools) if (t?.id) indexOfToolUse.set(String(t.id), i);
    }
  }
  for (let i = cut; i < list.length; i++) {
    const m = list[i];
    if (m?.role === 'tool_result' && m.toolUseId) {
      const ownerIdx = indexOfToolUse.get(String(m.toolUseId));
      if (ownerIdx !== undefined && ownerIdx < cut) cut = ownerIdx;
    }
  }
  while (cut > 0 && list[cut]?.role === 'tool_result') cut--;
  if (cut <= 0) return { head: [], tail: list };
  return { head: list.slice(0, cut), tail: list.slice(cut) };
}

/**
 * Chronologically replay TaskCreate / TaskUpdate / TaskList results from a
 * history page so tail-first DOM rendering still preserves exact todo order.
 */
export function replayTodosFromMessages(messages, initialTodos = []) {
  const list = Array.isArray(messages) ? messages : [];
  const calls = new Map();
  for (const m of list) {
    if (m?.role === 'assistant' && Array.isArray(m.tools)) {
      for (const t of m.tools) {
        if (t?.id && (t.name === 'TaskCreate' || t.name === 'TaskUpdate' || t.name === 'TaskList')) {
          calls.set(String(t.id), t);
        }
      }
    }
  }
  if (!calls.size) return null;
  let todos = Array.isArray(initialTodos) ? initialTodos : [];
  let changed = false;
  for (const m of list) {
    if (m?.role !== 'tool_result' || m.isError || !m.toolUseId) continue;
    const call = calls.get(String(m.toolUseId));
    if (!call) continue;
    const next = applyTaskTool(todos, call.name, call.input || {}, m.structured);
    if (next) {
      todos = next;
      changed = true;
    }
  }
  return changed ? todos : null;
}

// ── One transcript container, several history loads ──
// A container can be asked for its history more than once while a load is still
// running (a restored tab shown while its reattach says "resynced", an in-tab
// session switch). Loads of one container run one after the other, and only the
// newest asked for renders; rows a rebuild put in are marked so the next one
// takes them out instead of appending a second copy after them. Rows that came
// live stay, after the history.

/** The property a history row carries: the load (ticket) that rendered it. */
export const HISTORY_ROW = '_cpHistoryRow';

export function markHistoryRows(nodes, ticket) {
  for (const n of nodes || []) if (n && typeof n === 'object') n[HISTORY_ROW] = ticket;
}

/** Rows an earlier rebuild (finished, aborted, or a snapshot put back) left in the container. */
export function earlierHistoryRows(children, ticket) {
  return [...(children || [])].filter((n) => n && n[HISTORY_ROW] != null && n[HISTORY_ROW] !== ticket);
}

/** Rows that came live: no history mark and not the empty-state placeholder. */
export function liveRows(children) {
  return [...(children || [])].filter((n) => n && n[HISTORY_ROW] == null && !n.classList?.contains?.('cp-empty'));
}

/**
 * Starts a load of `$msgs`: it waits for the one running there and is skipped when
 * a newer load was asked for meanwhile. `run(isStale)` does the work; `isStale()`
 * is true as soon as a newer load was asked for (the running one stops at its next
 * yield). Returns the promise of this load.
 */
export function queueHistoryLoad(container, run) {
  const ticket = (container._historyTicket || 0) + 1;
  container._historyTicket = ticket;
  const isStale = () => container._historyTicket !== ticket;
  const prev = container._historyChain || Promise.resolve();
  const job = prev.catch(() => {}).then(() => (isStale() ? undefined : run(isStale, ticket)));
  container._historyChain = job;
  return job;
}

// Messages that put rows in a transcript. One of these for a restored tab whose
// history is still deferred loads that history first; while any history load of
// the tab runs, they wait in the tab's buffer, so the history always comes first.
const TRANSCRIPT_MESSAGES = new Set(['event', 'turn_started', 'stderr', 'done', 'aborted', 'error']);

/** 'load' (start the deferred history, then hold the message), 'hold', or 'pass'. */
export function historyGate(tab, msg, bypass = false) {
  if (!tab || bypass) return 'pass';
  const deferred = !!tab._historyDeferred && tab._historyDeferred === tab.sessionId && !tab.automationRunId;
  if (deferred && TRANSCRIPT_MESSAGES.has(msg?.type)) return 'load';
  if (tab._historyHold > 0) return 'hold';
  return 'pass';
}

/**
 * A live tool result whose card a running replay has not rendered yet (it sits in
 * a head chunk still to come) is kept here and applied when the card is built.
 */
export function holdPendingResult(tab, ev) {
  if (!tab || !ev?.tool_use_id || !(tab._historyRendering > 0) || tab._replayRow) return false;
  if (!(tab._pendingResults instanceof Map)) tab._pendingResults = new Map();
  tab._pendingResults.set(String(ev.tool_use_id), ev);
  return true;
}

export function takePendingResult(tab, toolUseId) {
  const map = tab?._pendingResults;
  if (!(map instanceof Map) || !toolUseId) return null;
  const ev = map.get(String(toolUseId)) || null;
  if (ev) map.delete(String(toolUseId));
  return ev;
}

/** Whether a task tool's result may change the todo list now (a replayed one is in the precomputed list). */
export function taskResultAppliesTodos(tab, ev) {
  if (!tab || tab._agentScope || ev?.is_error) return false;
  return !(tab._skipReplayTodos && tab._replayRow);
}

/**
 * Renders `rows` with `render(row)` (which appends to `container`), marks the
 * nodes it added as load `ticket`'s and moves them before `before` (a live row,
 * or the first row of the tail already shown), so rows already on screen are
 * never moved or rebuilt: the browser's scroll anchoring keeps a reader who
 * scrolled up where they were while older rows go in above. `skip` holds nodes
 * that are never taken as added (the live rows). Returns the added nodes.
 */
export function renderHistoryRowsInto(container, rows, render, { before = null, ticket = null, skip = null } = {}) {
  const marker = container.lastElementChild;
  for (const row of rows || []) render(row);
  const added = [];
  for (let n = marker ? marker.nextElementSibling : container.firstElementChild; n; n = n.nextElementSibling) {
    if (!skip || !skip.has(n)) added.push(n);
  }
  markHistoryRows(added, ticket);
  if (before && before.parentNode === container) for (const n of added) container.insertBefore(n, before);
  return added;
}
