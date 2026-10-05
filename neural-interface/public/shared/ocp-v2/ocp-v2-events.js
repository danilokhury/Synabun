// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — events → store (no DOM, no socket)
// One function per concern so node:test can drive them with a real store:
//   applyEvent(store, eventType, ev, hooks)   an SDK bus event → store calls
//   describeError(err)                        a typed OpenCode error → text
//   resolveEventTargets(...)                  which stores an event belongs to
// The socket layer (ocp-v2-ws.js) owns delivery and desktop notifications and
// passes those in as hooks.
// ─────────────────────────────────────────────────────────────────────────────

// OpenCode errors are `{ name, data: { message, … } }` (session.error,
// AssistantMessage.error). The newer tagged errors are `{ _tag, message }`.
const ERROR_KINDS = {
  MessageAbortedError: 'aborted',
  ProviderAuthError: 'auth',
  ContextOverflowError: 'overflow',
  MessageOutputLengthError: 'output-length',
  ContentFilterError: 'content-filter',
  StructuredOutputError: 'structured-output',
  APIError: 'api',
  SessionBusyError: 'busy',
};

const ERROR_FALLBACK_TEXT = {
  aborted: 'Stopped',
  auth: 'The provider rejected the credentials.',
  overflow: 'The conversation no longer fits the model context window.',
  'output-length': 'The reply hit the model output limit.',
  'content-filter': 'The provider filtered this reply.',
  'structured-output': 'The model did not return the requested structure.',
  busy: 'The session is busy with another turn.',
};

export function describeError(err) {
  if (typeof err === 'string') return { name: '', kind: 'error', message: err || 'Error' };
  const name = String(err?.name || err?._tag || '');
  const kind = ERROR_KINDS[name] || 'error';
  const data = err?.data && typeof err.data === 'object' ? err.data : {};
  const raw = (typeof data.message === 'string' && data.message)
    || (typeof err?.message === 'string' && err.message)
    || '';
  const message = kind === 'aborted'
    ? 'Stopped'
    : (raw || ERROR_FALLBACK_TEXT[kind] || name || 'Error');
  const out = { name, kind, message };
  if (typeof data.statusCode === 'number') out.statusCode = data.statusCode;
  if (typeof data.isRetryable === 'boolean') out.retryable = data.isRetryable;
  if (typeof data.providerID === 'string' && data.providerID) out.providerID = data.providerID;
  return out;
}

/** One line for a banner: the message, with the HTTP status when there is one. */
export function errorText(err) {
  const d = describeError(err);
  return d.statusCode ? `${d.message} (HTTP ${d.statusCode})` : d.message;
}

export function eventSessionId(ev) {
  return ev?.sessionID || ev?.sessionId || ev?.info?.id || '';
}

export const permissionRequestId = (ev) => String(ev?.requestID || ev?.id || ev?.permissionID || '');

// Requests a sub-agent raises have no panel of their own unless its child
// panel is open; they still have to reach the user.
const ASKED_EVENTS = new Set(['permission.asked', 'question.asked']);
const ANSWERED_EVENTS = new Set(['permission.replied', 'question.replied', 'question.rejected']);

/**
 * The stores an event belongs to.
 *   • An ask raised by a session nobody has open goes to the nearest ancestor
 *     that is open (`parentOf`: child → parent).
 *   • An answer goes to the session's own panel and to every open ancestor: the
 *     request may be showing in a parent that took it before the child panel
 *     opened. Removing a request a store does not hold is a no-op.
 *   • A session.error without a sessionID goes to every store with a turn running.
 */
export function resolveEventTargets({ eventType, ev, storesBySession, parentOf, allStores }) {
  const sid = eventSessionId(ev);
  if (!sid) {
    if (eventType !== 'session.error') return [];
    return [...(allStores || [])].filter((store) => store.getState().running);
  }
  const direct = [...(storesBySession?.get(sid) || [])];
  const asked = ASKED_EVENTS.has(eventType);
  const answered = ANSWERED_EVENTS.has(eventType);
  if (!answered && (direct.length || !asked)) return direct;
  const targets = new Set(direct);
  const seen = new Set([sid]);
  let cursor = parentOf?.get(sid);
  while (cursor && !seen.has(cursor)) {
    const owners = storesBySession?.get(cursor);
    if (owners && owners.size) {
      for (const store of owners) targets.add(store);
      if (asked) break;
    }
    seen.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return [...targets];
}

// "Still running" is news even when the flag does not change: a transcript
// snapshot read before this event must not be allowed to say the turn ended.
function markRunning(store) {
  if (!store.getState().running) store.setRunning(true);
  else store.touchStatus?.();
}

// running → idle: the turn is over. `hooks.onOutcome` fires once per real
// transition; an idle echo for a panel that was already idle is silent.
function finishTurn(store, hooks) {
  const wasRunning = store.getState().running;
  store.setRunning(false);
  if (wasRunning) hooks.onOutcome?.(store, 'done');
}

export function applyEvent(store, eventType, ev = {}, hooks = {}) {
  switch (eventType) {
    case 'message.updated':
      if (ev.info) {
        store.upsertMessage(ev.info);
        // A message without a completed timestamp is still streaming: the
        // local `running` flag may be stale after a reload. session.idle
        // clears it.
        const completed = ev.info?.time?.completed;
        if (ev.info?.role === 'assistant' && (completed == null || completed === 0)) markRunning(store);
      }
      break;
    case 'message.removed':
      if (ev.messageID) store.removeMessage(ev.messageID);
      break;
    case 'message.part.updated':
      if (ev.part) {
        store.upsertPart(ev.part);
        // Any part still running/pending means the session is running, whether
        // or not this panel sent the turn (sub-agents, post-reload recovery).
        const partStatus = ev.part?.state?.status || ev.part?.status || '';
        if (partStatus === 'running' || partStatus === 'pending') markRunning(store);
      }
      break;
    case 'message.part.delta':
      store.appendPartDelta({ messageID: ev.messageID, partID: ev.partID, field: ev.field, delta: ev.delta });
      markRunning(store);
      break;
    case 'message.part.removed':
      if (ev.messageID && ev.partID) store.removePart(ev.messageID, ev.partID);
      break;
    case 'session.status': {
      const status = ev.status && typeof ev.status.type === 'string' ? ev.status : { type: 'idle' };
      store.setSessionStatus(status);
      if (status.type === 'busy' || status.type === 'retry') markRunning(store);
      else finishTurn(store, hooks);
      break;
    }
    case 'session.idle':
      store.setSessionStatus({ type: 'idle' });
      finishTurn(store, hooks);
      break;
    case 'session.updated':
      // Title, share, revert and compaction state; never touches the transcript.
      // The event carries the whole Session: a field it no longer has (revert
      // after a new prompt, share after unsharing) is cleared, not kept.
      if (ev.info) store.setSessionInfo({ revert: undefined, share: undefined, ...ev.info });
      break;
    case 'session.compacted':
      store.setCompacting(false);
      hooks.onCompacted?.(store);
      break;
    case 'session.error': {
      const described = describeError(ev.error || {});
      store.setSessionStatus({ type: 'idle' });
      store.setRunning(false);
      // Stopping a turn is not an error: the message itself says "Stopped".
      if (described.kind === 'aborted') break;
      store.pushError({
        message: ev.error ? errorText(ev.error) : 'session error',
        kind: described.kind,
        name: described.name,
        raw: ev.error,
      });
      hooks.onOutcome?.(store, 'error');
      break;
    }
    case 'todo.updated':
      store.setTodos(ev.todos);
      break;
    case 'session.diff':
      store.setSessionDiff(ev.diff);
      break;
    case 'mcp.profile.changed':
      store.setMcpProfile(ev.profile || null);
      break;
    case 'mcp.profile.refresh.failed':
      store.pushError({
        message: ev.error || `MCP profile changed to ${ev.profile || 'the requested profile'}, but OpenCode could not reload its tools.`,
        raw: ev,
      });
      break;
    case 'permission.asked': {
      const id = permissionRequestId(ev);
      if (!id) break;
      const isNew = store.addPendingPermission(ev);
      if (isNew) hooks.onAsk?.(store, id, 'permission', ev);
      break;
    }
    case 'permission.replied': {
      // The event carries `requestID`; the request itself carried `id`.
      const id = permissionRequestId(ev);
      if (!id) break;
      store.removePendingPermission(id);
      hooks.onAskCleared?.(id);
      break;
    }
    case 'question.asked':
      if (ev && ev.id) {
        store.addPendingQuestion(ev);
        hooks.onAsk?.(store, String(ev.id), 'question', ev);
      }
      break;
    case 'question.replied':
    case 'question.rejected': {
      const reqId = ev?.requestID || ev?.id;
      if (reqId) {
        store.removePendingQuestion(reqId);
        hooks.onAskCleared?.(String(reqId));
      }
      break;
    }
    default:
      break;
  }
}
