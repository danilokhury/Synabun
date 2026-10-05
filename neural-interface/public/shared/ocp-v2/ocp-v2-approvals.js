// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — approvals logic (no DOM)
//   • what a permission card says (origin, what "Always allow" covers and for how long)
//   • auto-accept: a per-session switch, off by default, held only in the
//     panel store (never written to storage, never sent to OpenCode as a rule)
// ─────────────────────────────────────────────────────────────────────────────

import { replyFailed, replyError } from './ocp-v2-caps.js';
import { requestBelongsTo, requestOwner } from './ocp-v2-rehydrate.js';
import { captureBinding, bindingOf } from './ocp-v2-binding.js';

// Kinds that always need a person. `doom_loop` is OpenCode asking whether a
// model that keeps repeating the same tool call may go on.
export const NEVER_AUTO_ACCEPT = Object.freeze(['doom_loop']);

export function permissionKind(req) {
  const inner = (req?.permission && typeof req.permission === 'object') ? req.permission : req;
  return String(inner?.permission || inner?.type || '').toLowerCase();
}

export const permissionId = (req) => String(req?.id || req?.requestID || req?.permissionID || '');

/** True when `req` may be answered "once" without asking. */
export function shouldAutoAccept(enabled, req) {
  if (!enabled || !permissionId(req)) return false;
  return !NEVER_AUTO_ACCEPT.includes(permissionKind(req));
}

/**
 * Is the switch on in a session above `sessionId`? Auto-accept is inherited
 * along the sessions' parent links (child → parent, up to the session in the
 * main panel), whether or not the sessions in between have a panel: closing
 * the panel of a sub-agent changes nothing for the sub-agents below it.
 *   parentOf(id)  the parent session of `id`; '' when it has none or it is not known
 *   isOn(id)      the switch of a panel that is on that session
 */
export function autoAcceptInherited(sessionId, { parentOf, isOn, maxDepth = 12 } = {}) {
  if (!sessionId || typeof parentOf !== 'function' || typeof isOn !== 'function') return false;
  const seen = new Set([sessionId]);
  let cursor = parentOf(sessionId);
  for (let depth = 0; depth < maxDepth && cursor && !seen.has(cursor); depth += 1) {
    seen.add(cursor);
    if (isOn(cursor) === true) return true;
    cursor = parentOf(cursor);
  }
  return false;
}

/** What the card needs beyond the request's target. */
export function permissionCardView(req, { sessionId } = {}) {
  const owner = req?.sessionID || req?.sessionId || '';
  const always = Array.isArray(req?.always) ? req.always.filter((p) => typeof p === 'string' && p) : [];
  return {
    id: permissionId(req),
    kind: permissionKind(req),
    fromSubagent: !!(owner && sessionId && owner !== sessionId),
    always,
    auto: !!req?._auto,
  };
}

/**
 * Answer one request "once" on the user's standing instruction. While the
 * reply is in flight the request is marked `_auto` (the card becomes a one-line
 * stub); if OpenCode refuses the reply the mark comes off and the user is asked.
 * Resolves true when the reply was accepted.
 *
 * The switch covers this panel's session and its sub-agents, nothing else, and
 * that is checked here, right before the reply, whatever put the request in
 * the queue: `isDescendant(owner, sessionId)` must confirm a request that is
 * not the session's own. A request that fails the check is not answered.
 */
export async function autoAcceptRequest(store, api, req, { cwd, isDescendant } = {}) {
  const id = permissionId(req);
  if (!id) return false;
  const at = captureBinding(store);
  if (!(await requestBelongsTo(req, at.sessionId, isDescendant))) return false;
  // The panel may have moved to another session while ancestry was looked up
  // (or left this one and come back: the switch it was turned on for is gone).
  if (!at.isCurrent()) return false;
  store.addPendingPermission({ ...req, _auto: true });
  let res;
  try {
    res = await api.permissionReply({
      sessionId: requestOwner(req),
      permissionId: id,
      response: 'once',
      cwd,
    });
  } catch (err) {
    res = { ok: false, error: err?.message || String(err) };
  }
  if (!replyFailed(res)) {
    // permission.replied removes it; do it here too in case that event is lost.
    if (at.isCurrent()) store.removePendingPermission(id);
    return true;
  }
  // The queue on screen is another binding's by now: nothing of it is touched.
  if (!at.isCurrent()) return false;
  const still = store.getState().pendingPermissions.find((p) => permissionId(p) === id);
  if (still) {
    const { _auto, ...plain } = still;
    store.addPendingPermission(plain);
  }
  return false;
}

export const FOREIGN_REQUEST_MESSAGE = 'This request belongs to another session and cannot be answered from here.';

/**
 * Whose is `req`, asked at the moment of answering?
 *   'own'      the session this panel is bound to raised it, or one of its
 *              sub-agents did (`isDescendant` confirms those)
 *   'foreign'  it belongs to a session outside this panel's tree
 *   'moved'    the panel was rebound while ancestry was looked up; nothing is
 *              known about the request any more and nothing may be sent
 * `at` is the binding the answer started on (captured at the click); without
 * it the binding is captured here.
 */
export async function requestOwnership(store, req, isDescendant, at = captureBinding(store)) {
  if (!at.isCurrent()) return 'moved';
  const mine = await requestBelongsTo(req, at.sessionId, isDescendant);
  if (!at.isCurrent()) return 'moved';
  return mine ? 'own' : 'foreign';
}

/**
 * May this panel answer `req`? Only for the session it is bound to and that
 * session's sub-agents (`isDescendant` confirms those), and only while it stays
 * on that binding. The same rule the automatic reply follows, for a click.
 */
export async function ownsRequest(store, req, isDescendant, at) {
  return (await requestOwnership(store, req, isDescendant, at)) === 'own';
}

/**
 * A question card built from the transcript carries the session its tool part
 * belongs to (`sessionID`) and the binding it was drawn under (`_binding`).
 * It may be answered only by the panel that drew it, while that panel is still
 * on that session under that binding.
 */
export function ownsTranscriptCard(store, req) {
  const owner = requestOwner(req);
  if (!owner || owner !== store.getState().sessionId) return false;
  return typeof req?._binding !== 'number' || req._binding === bindingOf(store);
}

/**
 * The user's answer to a permission card. A request of a session outside this
 * panel's tree is not answered: it is taken off the queue (it should never
 * have been on screen here) and `{ ok: false, foreign: true }` comes back.
 * Resolves `{ ok }`; a refused or failed reply leaves the card for a retry.
 * `{ ok: false, moved: true }` when the panel was rebound before the reply
 * left (nothing is sent) or while it was out (it was sent; nothing to show).
 */
export async function replyToPermission(store, api, req, response, { cwd, message, isDescendant } = {}) {
  const id = permissionId(req);
  if (!id) return { ok: false };
  // The binding the click happened on. Ownership is established against it,
  // and it is checked again right before the reply leaves.
  const at = captureBinding(store);
  const ownership = await requestOwnership(store, req, isDescendant, at);
  // Rebound meanwhile: the card that was clicked is gone, and the queue on
  // screen is the new binding's. Nothing is sent and nothing is removed.
  if (ownership === 'moved') return { ok: false, moved: true };
  if (ownership !== 'own') {
    store.removePendingPermission(id);
    return { ok: false, foreign: true, error: FOREIGN_REQUEST_MESSAGE };
  }
  let res;
  try {
    res = await api.permissionReply({
      sessionId: requestOwner(req),
      permissionId: id,
      response,
      cwd,
      message: typeof message === 'string' && message.trim() ? message.trim() : undefined,
    });
  } catch (err) {
    res = { ok: false, error: err?.message || String(err) };
  }
  // The reply went to the request's verified owner and stands. Its outcome is
  // for the card that was clicked: once the panel is on another binding that
  // card is gone, and neither a success nor a failure is the caller's to show.
  if (!at.isCurrent()) return { ok: false, moved: true };
  // The round-trip resolves even on a server-side failure (ok:false or an HTTP
  // status >= 400): that is a failure, so the caller can re-enable the card.
  return replyFailed(res) ? { ok: false, error: typeof res?.error === 'string' ? res.error : '' } : { ok: true };
}

/** Turn the switch on or off; turning it on answers what is already waiting. */
export async function setAutoAccept(store, api, enabled, { cwd, isDescendant } = {}) {
  store.setAutoAccept(enabled);
  if (!enabled) return 0;
  // Each automatic reply captures the binding itself (autoAcceptRequest); the
  // list of what is waiting is read here, before anything is awaited.
  const waiting = store.getState().pendingPermissions.filter((req) => !req._auto && shouldAutoAccept(true, req));
  const results = await Promise.all(waiting.map((req) => autoAcceptRequest(store, api, req, { cwd, isDescendant })));
  return results.filter(Boolean).length;
}

/**
 * How long an "Always allow" lasts, for the card. On OpenCode 1.18.34 the
 * answer is kept by the serve process that runs the session: the patterns are
 * allowed for the project on that serve until it restarts. It is not written
 * to OpenCode's saved-permissions store (`/api/permission/saved` stays empty
 * after an "always"; checked against a live serve), so there is no list of
 * earlier answers to show or take back.
 */
export const ALWAYS_ALLOW_SCOPE = 'until this session\u2019s OpenCode runtime restarts';

// ── Questions ───────────────────────────────────────────────────────────────
// The answer path of a question card, whatever built the card: a request in
// the queue (question.asked, recovery) or the transcript (a `question` tool
// part that is still open). Ownership is established against the binding the
// click happened on and checked again right before each request leaves.

const formatDetail = (value) => {
  if (value == null) return 'request rejected';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
};

/** '' when the socket round trip succeeded, else what to tell the user. */
export function wsFailureText(resp, label) {
  if (!resp) return `${label} failed: empty response`;
  if (resp.ok === false) return `${label} failed: ${formatDetail(resp.error || 'request rejected')}`;
  if (resp.status && resp.status >= 400) {
    return `${label} failed: ${formatDetail(resp.error || resp.data?.error || resp.data?.message || `HTTP ${resp.status}`)}`;
  }
  if (resp.error) return `${label} failed: ${formatDetail(resp.error)}`;
  return '';
}

export function questionListOf(resp) {
  const data = resp?.data ?? resp;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.questions)) return data.questions;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

/**
 * The card for an open `question` tool part of the transcript, or null when
 * the part is not this panel's to ask: its message (or the part itself) names
 * another session than the one the store is bound to. However such a part got
 * into the store, no card is drawn for it. The card carries its owner and the
 * binding it was drawn under (see ownsTranscriptCard).
 */
export function transcriptQuestionCard(store, part, questions) {
  const s = store.getState();
  const messageInfo = s.messages?.get?.(part?.messageID || part?.messageId)?.info;
  const named = part?.sessionID || part?.sessionId || messageInfo?.sessionID || messageInfo?.sessionId || '';
  const owner = String(named || s.sessionId || '');
  if (!owner || owner !== s.sessionId) return null;
  return {
    id: part?.callID || part?.id || `tool-${part?.messageID || 'q'}`,
    sessionID: owner,
    questions,
    _viaToolPart: true,
    _binding: bindingOf(store),
  };
}

export const QUESTION_NOT_PENDING_MESSAGE = 'OpenCode did not expose a pending question request for this card. Answer was not queued.';

/**
 * Answer a question card. Resolves `{ ok, replyRequestId }`, or
 *   { ok: false, moved: true }                 the panel was rebound meanwhile: nothing more is sent, nothing is reported
 *   { ok: false, foreign: true, error }        the card is another session's (a queued one is taken off the queue)
 *   { ok: false, error }                       the reply failed; the card stays for a retry
 * The session and directory of every request are the ones captured at the
 * click; the reply goes to the runtime of that session, which the request's
 * owner (itself or a verified sub-agent) runs on.
 */
export async function answerQuestion(store, api, req, answers, { isDescendant } = {}) {
  if (!req || !req.id) return { ok: false, error: 'Question reply failed' };
  const at = captureBinding(store);
  const cwd = at.directory || at.sessionInfo?.info?.directory || undefined;
  const requestId = req.id;
  let owner = requestOwner(req);

  if (req._viaToolPart) {
    if (!ownsTranscriptCard(store, req)) return { ok: false, foreign: true, error: FOREIGN_REQUEST_MESSAGE };
  } else {
    const ownership = await requestOwnership(store, req, isDescendant, at);
    if (ownership === 'moved') return { ok: false, moved: true };
    if (ownership !== 'own') {
      store.removePendingQuestion(requestId);
      return { ok: false, foreign: true, error: FOREIGN_REQUEST_MESSAGE };
    }
  }
  owner = owner || at.sessionId;

  // A transcript card has no request id of its own: the pending request of
  // that session with the same tool call is the one to answer.
  let replyRequestId = requestId;
  if (req._viaToolPart) {
    let listResp;
    try { listResp = await api.questionList({ cwd, sessionId: at.sessionId }); } catch (err) { listResp = { ok: false, error: err?.message || String(err) }; }
    if (!at.isCurrent()) return { ok: false, moved: true };
    const failure = wsFailureText(listResp, 'Question list');
    if (failure) return { ok: false, error: failure };
    const partCallId = String(requestId || '');
    const match = questionListOf(listResp).find((q) => {
      if (!q || requestOwner(q) !== owner) return false;
      const qCallId = q.tool?.callID || q.tool?.callId || q.tool?.id || '';
      return partCallId && qCallId ? qCallId === partCallId : true;
    });
    if (!match?.id) return { ok: false, error: QUESTION_NOT_PENDING_MESSAGE };
    replyRequestId = match.id;
  }

  // The moment of answering: still the binding the click happened on?
  if (!at.isCurrent()) return { ok: false, moved: true };
  let replyResp;
  try { replyResp = await api.questionReply({ requestId: replyRequestId, answers, cwd, sessionId: at.sessionId }); } catch (err) { replyResp = { ok: false, error: err?.message || String(err) }; }
  const failure = wsFailureText(replyResp, 'Question reply');
  if (failure) return at.isCurrent() ? { ok: false, error: failure } : { ok: false, moved: true };
  if (at.isCurrent()) {
    store.removePendingQuestion(replyRequestId);
    store.removePendingQuestion(requestId);
  }
  return { ok: true, replyRequestId };
}

/**
 * "Skip" on a question card: reject the request, or, for a transcript card
 * (no request exists server-side), stop the turn that is waiting on it. Same
 * ownership rule and the same results as answerQuestion.
 */
export async function skipQuestion(store, api, req, { isDescendant } = {}) {
  if (!req) return { ok: false, error: 'Question skip failed' };
  const at = captureBinding(store);
  if (req._viaToolPart) {
    if (!ownsTranscriptCard(store, req)) return { ok: false, foreign: true, error: FOREIGN_REQUEST_MESSAGE };
    const stopped = await api.abort(requestOwner(req));
    // The stop was for the card's owner and stands; its result is for the
    // card that was clicked, which is gone once the panel moved.
    if (!at.isCurrent()) return { ok: false, moved: true };
    // A stop the server refused did not stop anything: the card says so.
    return replyFailed(stopped) ? { ok: false, error: replyError(stopped, 'Question skip failed') } : { ok: true };
  }
  const ownership = await requestOwnership(store, req, isDescendant, at);
  if (ownership === 'moved') return { ok: false, moved: true };
  if (ownership !== 'own') {
    store.removePendingQuestion(req.id);
    return { ok: false, foreign: true, error: FOREIGN_REQUEST_MESSAGE };
  }
  const rejected = await api.questionReject({ requestId: req.id, sessionId: requestOwner(req) });
  if (!at.isCurrent()) return { ok: false, moved: true };
  // A refused reject leaves the question open: not a success.
  return replyFailed(rejected) ? { ok: false, error: replyError(rejected, 'Question skip failed') } : { ok: true };
}
