// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — re-read what events alone cannot restore (no DOM)
// After a page load, a tab switch or a socket reconnect the panel has missed
// every event since it last looked. This asks OpenCode for what the transcript
// does not hold: is the session running, which permission requests and
// questions are still waiting for an answer, and the todo list.
//
// Three rules keep a recovery from doing harm:
//   • A recovered request is shown only when it belongs to this panel's session
//     tree: the session itself, or a descendant whose ancestry was verified
//     (verifyDescendant) and that has no panel of its own. A serve can host
//     other root sessions; "nobody else has it open" proves nothing.
//   • A snapshot never replaces something newer. Each slice of the store has a
//     revision (store.getRevisions()); a read that a live event overtook is
//     thrown away and asked again.
//   • An answer is for the binding it was asked under. The store counts how
//     often it moved to another session (`binding`); an answer that comes back
//     after a move is dropped, also when the panel is on that session again.
// ─────────────────────────────────────────────────────────────────────────────

import { replyFailed } from './ocp-v2-caps.js';
import { captureBinding } from './ocp-v2-binding.js';

const listOf = (res) => {
  const data = res?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.questions)) return data.questions;
  if (Array.isArray(data?.data)) return data.data;
  return [];
};

export const requestOwner = (req) => String(req?.sessionID || req?.sessionId || '');

export const ANCESTRY_MAX_DEPTH = 12;

/**
 * Is `sessionId` a descendant of `ancestorId`? Walks child → parent.
 *   parentOf      Map(child → parent) learned from session.created/updated
 *   roots         Set of sessions known to have no parent (optional cache)
 *   fetchParent   async (id) → the parent id, '' for a root session; a throw or
 *                 anything that is not a string means "unknown"
 * Unknown is false: ancestry that cannot be established is not ancestry.
 */
export async function verifyDescendant(sessionId, ancestorId, { parentOf, roots, fetchParent } = {}) {
  if (!sessionId || !ancestorId || sessionId === ancestorId) return false;
  const seen = new Set([sessionId]);
  let cursor = sessionId;
  for (let depth = 0; depth < ANCESTRY_MAX_DEPTH; depth++) {
    let parent = parentOf?.get(cursor);
    if (parent === undefined) {
      if (roots?.has(cursor) || typeof fetchParent !== 'function') return false;
      try { parent = await fetchParent(cursor); } catch { return false; }
      if (typeof parent !== 'string') return false;
      if (parent) parentOf?.set(cursor, parent);
      else roots?.add(cursor);
    }
    if (!parent) return false;
    if (parent === ancestorId) return true;
    if (seen.has(parent)) return false;
    seen.add(parent);
    cursor = parent;
  }
  return false;
}

/**
 * The same walk without asking anyone: true only when every link from
 * `sessionId` up to `ancestorId` is already in `parentOf`. For code that cannot
 * wait (rendering); verifyDescendant records the links it had to fetch, so a
 * request that was verified once passes here too.
 */
export function knownDescendant(sessionId, ancestorId, parentOf) {
  if (!sessionId || !ancestorId || sessionId === ancestorId || !parentOf) return false;
  const seen = new Set([sessionId]);
  let cursor = sessionId;
  for (let depth = 0; depth < ANCESTRY_MAX_DEPTH; depth++) {
    const parent = parentOf.get(cursor);
    if (!parent || seen.has(parent)) return false;
    if (parent === ancestorId) return true;
    seen.add(parent);
    cursor = parent;
  }
  return false;
}

/**
 * The requests a panel bound to `sessionId` may show: its own, and those of a
 * session already known to descend from it. A request of any other session is
 * left out, whatever put it in the queue.
 */
export function requestsVisibleIn(list, sessionId, isKnownDescendant) {
  return (Array.isArray(list) ? list : []).filter((req) => {
    const owner = requestOwner(req);
    if (!owner || !sessionId) return false;
    if (owner === sessionId) return true;
    try { return typeof isKnownDescendant === 'function' && isKnownDescendant(owner, sessionId) === true; } catch { return false; }
  });
}

/**
 * Does `req` belong to the panel bound to `sessionId`? Its own requests do; a
 * sub-agent's do when `isDescendant(owner, sessionId)` confirms the ancestry.
 * A request that names no session cannot be placed and belongs to nobody.
 */
export async function requestBelongsTo(req, sessionId, isDescendant) {
  const owner = requestOwner(req);
  if (!owner || !sessionId) return false;
  if (owner === sessionId) return true;
  if (typeof isDescendant !== 'function') return false;
  try { return (await isDescendant(owner, sessionId)) === true; } catch { return false; }
}

/**
 * Requests that belong in this panel: the session's own, plus those of a
 * verified descendant that has no panel of its own (a sub-agent whose child
 * panel is not open). `hasPanel(sessionId)` says whether some panel is bound.
 */
export async function requestsForPanel(list, sessionId, { hasPanel = () => false, isDescendant } = {}) {
  const out = [];
  for (const req of Array.isArray(list) ? list : []) {
    const owner = requestOwner(req);
    if (!owner) continue;
    if (owner !== sessionId && hasPanel(owner)) continue;
    if (await requestBelongsTo(req, sessionId, isDescendant)) out.push(req);
  }
  return out;
}

export const REHYDRATE_ATTEMPTS = 3;

// `() => boolean`: is the store still on `sessionId`, under the binding it has
// right now? False once the panel moved away, and stays false if it comes back.
// The same token every other asynchronous flow of the panel captures
// (ocp-v2-binding.js), pinned to the session the recovery was asked for.
function bindingCheck(store, sessionId, isCurrent) {
  return captureBinding(store, { sessionId, isCurrent }).isCurrent;
}

/**
 * Bring `store` in line with the server for `sessionId`. Each read is
 * independent: one that fails or that the server does not support leaves that
 * part of the store alone, and so does one that live events kept overtaking.
 * `isCurrent()` (optional) lets the caller veto late answers, e.g. for a panel
 * that was closed meanwhile. Resolves what it applied, for the caller's log.
 */
export async function rehydrateSessionState(store, api, { sessionId, cwd, hasPanel, isDescendant, isCurrent } = {}) {
  const applied = { status: false, permissions: false, questions: false, todos: false };
  if (!sessionId) return applied;
  const stillBound = bindingCheck(store, sessionId, isCurrent);
  const revisionOf = (slice) => (typeof store.getRevisions === 'function' ? store.getRevisions()[slice] : 0);

  // read → (prepare) → apply, unless the slice changed while the read was out.
  async function sync(slice, read, prepare, apply) {
    for (let attempt = 0; attempt < REHYDRATE_ATTEMPTS; attempt++) {
      const before = revisionOf(slice);
      let res;
      try { res = await read(); } catch (err) { res = { ok: false, error: err?.message || String(err) }; }
      if (!stillBound() || replyFailed(res)) return;
      const value = await prepare(res);
      if (value === undefined || !stillBound()) return;
      if (revisionOf(slice) !== before) continue;   // a live event is newer than this snapshot
      apply(value);
      applied[slice] = true;
      return;
    }
  }

  await Promise.all([
    sync('status',
      () => api.sessionStatus({ sessionId, cwd }),
      (res) => (res.data?.status?.type ? res.data.status : undefined),
      (current) => {
        store.setSessionStatus(current);
        // OpenCode's own answer beats the guess made from unfinished messages: a
        // turn that died mid-reply leaves one behind and is not running.
        const busy = current.type === 'busy' || current.type === 'retry';
        if (store.getState().running !== busy) store.setRunning(busy);
      }),
    sync('permissions',
      () => api.permissionList({ sessionId, cwd }),
      (res) => requestsForPanel(listOf(res), sessionId, { hasPanel, isDescendant }),
      // The server's own list: what is not in it is no longer open (`listed`).
      (mine) => store.setPendingPermissions(mine, { listed: true })),
    sync('questions',
      () => api.questionList({ sessionId, cwd }),
      (res) => (typeof res.data === 'string' ? undefined : requestsForPanel(listOf(res), sessionId, { hasPanel, isDescendant })),
      (mine) => store.setPendingQuestions(mine)),
    sync('todos',
      () => (api.sessionTodo ? api.sessionTodo({ sessionId, cwd }) : { ok: false }),
      (res) => (Array.isArray(res.data) ? res.data : undefined),
      (todos) => store.setTodos(todos)),
  ]);
  return applied;
}

/** True when a transcript snapshot shows a turn still in flight. */
export function transcriptInFlight(items) {
  for (const item of Array.isArray(items) ? items : []) {
    const info = item?.info;
    if (info?.role === 'assistant') {
      const completed = info?.time?.completed;
      if (completed == null || completed === 0) return true;
    }
    for (const part of (item?.parts || [])) {
      const status = part?.state?.status || part?.status;
      if (status === 'running' || status === 'pending') return true;
    }
  }
  return false;
}

/**
 * Read the transcript of `sessionId` and apply it, unless the panel moved on
 * while the read was out. The one way a transcript snapshot enters a store.
 *   • The answer is dropped when the store is on another session, or left this
 *     one and came back (`superseded`): it is another binding's answer.
 *   • `syncRunning` (default on) also sets the run state from the snapshot
 *     (an unfinished assistant message = running), but only when nothing live
 *     touched the run state since the read began. A snapshot that says
 *     "finished" never ends a turn an event has just reported running.
 * `beforeApply(items)` runs right before the snapshot goes into the store (the
 * composer drops its optimistic bubble there), and only when it does.
 * Resolves `{ applied, superseded, error, items }`.
 */
export async function hydrateTranscript(store, api, { sessionId, isCurrent, syncRunning = true, beforeApply } = {}) {
  const out = { applied: false, superseded: false, error: '', items: [] };
  if (!sessionId) { out.error = 'No session.'; return out; }
  const current = bindingCheck(store, sessionId, isCurrent);
  if (!current()) { out.superseded = true; return out; }
  const statusBefore = typeof store.getRevisions === 'function' ? store.getRevisions().status : 0;
  let list;
  try { list = await api.sessionMessages(sessionId); } catch (err) { list = { ok: false, error: err?.message || String(err) }; }
  if (!current()) { out.superseded = true; return out; }
  if (replyFailed(list)) {
    out.error = (typeof list?.error === 'string' && list.error) || (typeof list?.data?.error === 'string' && list.data.error) || 'Session messages unavailable';
    return out;
  }
  const items = Array.isArray(list?.data) ? list.data : [];
  if (typeof beforeApply === 'function') {
    try { beforeApply(items); } catch (err) { console.warn('[ocp-v2-rehydrate] beforeApply failed', err); }
  }
  store.hydrateMessages(items);
  out.applied = true;
  out.items = items;
  if (syncRunning) {
    // The guess from the transcript, unless an event already said otherwise;
    // session.status is the authority where the server has it.
    const untouched = typeof store.getRevisions !== 'function' || store.getRevisions().status === statusBefore;
    const inFlight = transcriptInFlight(items);
    if (untouched && store.getState().running !== inFlight) store.setRunning(inFlight);
  }
  return out;
}

/**
 * Everything a panel shows for its session, re-read from the server:
 * session info, transcript, run state, approvals, todos. Used by the primary
 * panel (boot, tab switch, auto-heal, after a compaction) and by a sub-agent
 * panel (when it is created, and again after the socket came back, because
 * whatever happened during the outage reached nobody).
 * `isCurrent()` is asked after every answer, and so is the store's binding: a
 * panel that was destroyed or bound to another session meanwhile takes
 * nothing, and `moved` says so.
 *   refreshInfo   read the session itself first (session:get)
 *   requireInfo   stop when that read fails: the session is gone (`unavailable`)
 */
export async function rehydratePanelSession(store, api, {
  sessionId, hasPanel, isDescendant, isCurrent, refreshInfo = true, requireInfo = false,
} = {}) {
  const out = { info: false, transcript: false, live: null, moved: false, unavailable: false, error: '' };
  if (!sessionId) return out;
  const current = bindingCheck(store, sessionId, isCurrent);
  const left = () => { out.moved = true; return out; };
  if (!current()) return left();

  if (refreshInfo) {
    let res;
    try { res = await api.sessionGet(sessionId); } catch (err) { res = { ok: false, error: err?.message || String(err) }; }
    if (!current()) return left();
    if (!replyFailed(res) && res.data) { store.setSession(sessionId, res.data); out.info = true; }
    else if (requireInfo) {
      out.unavailable = true;
      out.error = (typeof res?.error === 'string' && res.error) || `Session ${String(sessionId).slice(0, 8)} is unavailable`;
      return out;
    }
    // Otherwise the transcript may still answer.
  }
  const transcript = await hydrateTranscript(store, api, { sessionId, isCurrent: current });
  if (transcript.superseded) return left();
  out.transcript = transcript.applied;
  if (!transcript.applied) out.error = transcript.error;
  const s = store.getState();
  out.live = await rehydrateSessionState(store, api, {
    sessionId,
    cwd: s.cwd || s.sessionInfo?.directory || undefined,
    hasPanel,
    isDescendant,
    isCurrent: current,
  });
  if (!current()) out.moved = true;
  return out;
}

/**
 * Calls `onReconnect()` once per reconnect: after the socket reopened and the
 * server said what it understands (`capabilities()`), or `graceMs` after the
 * reopen for a server that never says (it predates the list). The first open
 * is not a reconnect.
 */
export function createReconnectNotifier(onReconnect, { graceMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let opened = false;
  let pending = false;
  let timer = null;
  const fire = () => {
    if (timer) { clearTimer(timer); timer = null; }
    if (!pending) return;
    pending = false;
    try { onReconnect(); } catch (err) { console.warn('[ocp-v2-rehydrate] reconnect listener failed', err); }
  };
  return {
    opened() {
      if (!opened) { opened = true; return; }
      pending = true;
      if (timer) clearTimer(timer);
      timer = setTimer(fire, graceMs);
    },
    capabilities() { fire(); },
    closed() {
      pending = false;
      if (timer) { clearTimer(timer); timer = null; }
    },
  };
}

/**
 * The errors a recovery may clear when it is done: those that were on screen
 * when it began, on the binding it began on. `begin` it before the recovery
 * waits on anything; `clear()` afterwards removes exactly those errors, and
 * only while the panel is still on that binding. An error that appeared while
 * the recovery was out (a send or a rename that failed meanwhile) is newer
 * than what was recovered from and stays. A notice is never one of them. When
 * the user moved to another session meanwhile, that session's errors are its
 * own and stay; when the recovery itself bound a new session, the store
 * already started it clean.
 * Returns whether anything was this recovery's to clear.
 */
export function recoveredErrorSweep(store) {
  const at = captureBinding(store);
  const ids = (store.getState().errors || []).filter((err) => !err?.notice).map((err) => err.id);
  return {
    clear() {
      if (!at.isCurrent()) return false;
      store.clearErrors(ids);
      return true;
    },
  };
}
