// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — session lifecycle actions (no DOM)
// Each action takes the panel store and the socket api, talks to OpenCode,
// applies the answer to the store and resolves `{ ok, error?, … }`. Dialogs,
// tab switching and the composer stay with the caller.
// ─────────────────────────────────────────────────────────────────────────────

import { replyFailed, replyError } from './ocp-v2-caps.js';
import {
  turnStartFor, lastUserMessageId, replayablePrompt, sessionSelections, exportTranscript,
} from './ocp-v2-sessions-logic.js';
import { draftRestorePlan, resourceReplayParts } from './ocp-v2-composer-logic.js';
import { captureBinding, isBindingToken } from './ocp-v2-binding.js';

// store.getState() hands out the live state: `s.sessionId` read after an await
// is wherever the panel is by then. Each action captures the binding once,
// before it asks anything (ocp-v2-binding.js), sends its requests for that
// session, and applies the answer only while the panel is still on that
// binding. An action the panel moved away from resolves `{ ok: false, moved:
// true }`: not an error, and nothing for the caller to put on screen.
const targetOf = (at) => ({ sessionId: at.sessionId, cwd: at.directory || undefined });
const fail = (res, fallback) => ({ ok: false, error: replyError(res, fallback), unsupported: !!res?.unsupported });
const MOVED = Object.freeze({ ok: false, moved: true });

async function call(fn, fallback) {
  let res;
  try { res = await fn(); } catch (err) { res = { ok: false, error: err?.message || String(err) }; }
  return replyFailed(res) ? fail(res, fallback) : { ok: true, data: res.data };
}

function applySession(store, at, data) {
  // The answer is the updated Session; `revert` / `share` are absent once cleared,
  // so say so explicitly instead of letting the merge keep the old value.
  if (!data || !at.isCurrent()) return;
  store.setSessionInfo({ revert: undefined, share: undefined, ...data });
}

// The MCP resources of the session's serve, to rebuild a resource mention
// from. [] when the server does not answer resource:list or the read fails.
async function readResourceList(api, { sessionId, cwd }) {
  if (typeof api?.resourceList !== 'function') return [];
  try {
    const res = await api.resourceList({ sessionId, cwd });
    return !replyFailed(res) && Array.isArray(res.data) ? res.data : [];
  } catch { return []; }
}

/**
 * Undo everything from `messageId` on. Resolves that prompt for the composer:
 * its text, its file parts (`files`) and the MCP resources it read
 * (`resources`, with `resourceList` to rebuild them from), so "edit and
 * resend" keeps what was attached. `readResources: false` skips that list (the
 * caller has it already).
 */
export async function revertToMessage(store, api, messageId, { readResources = true, binding } = {}) {
  // `binding` is the token of an action this undo is a step of (Retry): the
  // revert then goes to the session that action started on, or nowhere.
  const at = isBindingToken(binding) ? binding : captureBinding(store);
  if (!at.isCurrent()) return MOVED;
  const s = store.getState();
  if (!at.sessionId || !messageId) return { ok: false, error: 'Nothing to undo.' };
  if (s.running) return { ok: false, error: 'Stop the running turn before you undo.' };
  const prompt = replayablePrompt(s.messages.get(messageId));
  const target = targetOf(at);
  const out = await call(() => api.sessionRevert({ ...target, messageID: messageId }), 'Undo failed');
  // The panel moved while the revert was out: the prompt is not handed to a
  // composer that now belongs to another session. The session it was undone
  // in keeps its "Undone … Restore" banner.
  if (!at.isCurrent()) return MOVED;
  if (!out.ok) return out;
  applySession(store, at, out.data);
  const resourceList = readResources && prompt.resources.length ? await readResourceList(api, target) : [];
  if (!at.isCurrent()) return MOVED;
  return { ok: true, text: prompt.text, files: prompt.files, resources: prompt.resources, resourceList, session: out.data };
}

/**
 * Put a reverted prompt's attachments back in the composer, each as what it
 * was (see draftRestorePlan): data URLs in the attachment strip, referenced
 * paths as chips, @ mentions (files, symbols with their line range, MCP
 * resources) as picked mentions through `addMentions(items)`, which the
 * composer supplies. `prompt` is `{ text, files, resources, resourceList }`.
 * Resolves `{ restored, lost }`; `lost` names what could not be put back.
 */
export function restoreDraftAttachments(store, prompt = {}, { addMentions } = {}) {
  const plan = draftRestorePlan(prompt);
  let restored = 0;
  for (const attachment of plan.attachments) {
    if (store.addAttachedImage(attachment)) restored += 1;
  }
  for (const path of plan.paths) {
    if (store.addPendingPath(path)) restored += 1;
  }
  const lost = [...plan.lost];
  if (plan.mentions.length) {
    if (typeof addMentions === 'function') { addMentions(plan.mentions); restored += plan.mentions.length; }
    else lost.push(...plan.mentions.map((item) => item.label || item.token));
  }
  return { restored, lost };
}

/** /undo: revert to the newest prompt. */
export function undoLastTurn(store, api) {
  const target = lastUserMessageId(store.getState());
  if (!target) return Promise.resolve({ ok: false, error: 'Nothing to undo.' });
  return revertToMessage(store, api, target);
}

/** /redo: bring back what was undone. */
export async function restoreReverted(store, api) {
  const at = captureBinding(store);
  if (!at.sessionId) return { ok: false, error: 'No session.' };
  if (!at.sessionInfo?.revert?.messageID) return { ok: false, error: 'Nothing to restore.' };
  const out = await call(() => api.sessionUnrevert(targetOf(at)), 'Restore failed');
  if (!at.isCurrent()) return MOVED;
  if (!out.ok) return out;
  applySession(store, at, out.data);
  return { ok: true, session: out.data };
}

/**
 * Retry an assistant turn: undo back to its prompt, then hand the prompt to
 * `send(text, { files })`. The prompt is read before anything changes: a turn
 * whose prompt cannot be sent again (nothing but text OpenCode added) is
 * refused with the session untouched. `files` are the original file parts;
 * the sender must use those and leave the current draft alone.
 */
export async function retryFromMessage(store, api, messageId, send) {
  // One binding for the whole action: the resource read, the revert and the
  // resend all belong to the session Retry was clicked in. Each step is
  // cancelled once the panel is somewhere else: a revert is not started for
  // (or in) another session, and the prompt is never sent into one.
  const at = captureBinding(store);
  const state = store.getState();
  const start = turnStartFor(state, messageId);
  if (!start) return { ok: false, error: 'This reply has no prompt to retry.' };
  const prompt = replayablePrompt(state.messages.get(start));
  if (!prompt.replayable) return { ok: false, error: 'The prompt of this turn has nothing to send again.' };
  // An MCP resource the prompt read is not in the transcript as a file part:
  // it is rebuilt from the session's resource list, read before anything changes.
  let files = prompt.files;
  if (prompt.resources.length) {
    const rebuilt = resourceReplayParts({ text: prompt.text, resources: prompt.resources, resourceList: await readResourceList(api, targetOf(at)) });
    if (!at.isCurrent()) return MOVED;
    if (rebuilt.lost.length) {
      return { ok: false, error: `This prompt read ${rebuilt.lost.join(', ')}, which cannot be attached again. Use Undo and attach it by hand.` };
    }
    files = [...prompt.files, ...rebuilt.parts];
  }
  const reverted = await revertToMessage(store, api, start, { readResources: false, binding: at });
  if (!reverted.ok) return reverted;
  if (!at.isCurrent()) return MOVED;
  // The sender gets the binding too and refuses a prompt whose binding is gone.
  const sent = await send(prompt.text, { files, binding: at });
  if (!at.isCurrent()) return MOVED;
  return sent
    ? { ok: true }
    : { ok: false, error: 'The turn was undone but its prompt could not be sent again.', text: prompt.text, files };
}

/**
 * The Session for `sessionId` as it is now: `{ info, fresh }`. It is always
 * read from the server (session:get), also when `info` already is a whole
 * Session: the tab cache keeps those, and another window or the CLI can have
 * changed the model or the agent since. `fresh` is true only for an answer
 * read now; a failed read hands `info` back (so the caller still has a title)
 * with `fresh: false`, and nothing should be restored from it.
 */
export async function loadSessionDetail(api, sessionId, info = null) {
  try {
    const res = await api.sessionGet(sessionId);
    if (!replyFailed(res) && res.data?.id === sessionId) return { info: { ...(info || {}), ...res.data }, fresh: true };
  } catch { /* keep what the caller has */ }
  return { info, fresh: false };
}

/**
 * Continue a session on what it last ran with (Session.model / .agent): the
 * model picker and the agent toggle follow the session that is on screen
 * instead of keeping the previous tab's. The variant is left to the variant
 * picker, which restores the one remembered for the model as soon as the model
 * changes and is the only place that knows which variants a model has.
 * Returns what the session carried.
 */
export function applySessionSelections(store, info) {
  const picked = sessionSelections(info);
  const current = store.getState().model;
  const sameModel = current && picked.model
    && current.providerID === picked.model.providerID && current.modelID === picked.model.modelID;
  if (picked.model && !sameModel) store.setModel(picked.model);
  if (picked.agent && picked.agent !== store.getState().agent) store.setAgent(picked.agent);
  return picked;
}

/**
 * A new session that continues from `messageId` (or from the end). Resolves
 * the new Session, with `moved: true` when the panel went elsewhere while the
 * fork was made: the fork exists and is worth a tab, but the user's newer
 * selection stays on screen.
 */
export async function forkSession(store, api, messageId) {
  const at = captureBinding(store);
  if (!at.sessionId) return { ok: false, error: 'No session.' };
  const out = await call(() => api.sessionFork({ ...targetOf(at), messageID: messageId || undefined }), 'Fork failed');
  if (!out.ok) return at.isCurrent() ? out : MOVED;
  if (!out.data?.id) return at.isCurrent() ? { ok: false, error: 'OpenCode did not return the forked session.' } : MOVED;
  return at.isCurrent() ? { ok: true, session: out.data } : { ok: true, session: out.data, moved: true };
}

export async function deleteMessage(store, api, messageId) {
  const at = captureBinding(store);
  if (!at.sessionId || !messageId) return { ok: false, error: 'No message.' };
  if (store.getState().running) return { ok: false, error: 'Stop the running turn before you delete a message.' };
  const out = await call(() => api.messageDelete({ ...targetOf(at), messageID: messageId }), 'Delete failed');
  if (!at.isCurrent()) return MOVED;
  if (!out.ok) return out;
  // message.removed does this too; doing it here keeps the panel right if that event is lost.
  store.removeMessage(messageId);
  return { ok: true };
}

/**
 * Publish the transcript. `confirm()` must resolve true first, every time:
 * the caller asks in the panel (ocp-v2-confirm-logic.js), this function never
 * shares without it. `stopped` is the panel's createStoppedShares().
 */
export async function shareSession(store, api, confirm, { stopped = null } = {}) {
  // The session the question is about, captured before the question is asked:
  // a confirm answered after the panel moved publishes nothing.
  const at = captureBinding(store);
  if (!at.sessionId) return { ok: false, error: 'No session.' };
  let agreed = false;
  try { agreed = (await confirm()) === true; } catch { agreed = false; }
  if (!agreed) return { ok: false, cancelled: true };
  if (!at.isCurrent()) return { ok: false, cancelled: true, moved: true };
  const out = await call(() => api.sessionShare(targetOf(at)), 'Share failed');
  // Shared again, for that session whatever is on screen by now: a link the
  // panel had stopped before is a share once more.
  if (out.ok) stopped?.resume(at.sessionId);
  if (!at.isCurrent()) return MOVED;
  if (!out.ok) return out;
  applySession(store, at, out.data);
  const url = out.data?.share?.url || '';
  return url ? { ok: true, url } : { ok: false, error: 'OpenCode did not return a share link.' };
}

export async function unshareSession(store, api, { stopped = null } = {}) {
  const at = captureBinding(store);
  if (!at.sessionId) return { ok: false, error: 'No session.' };
  const out = await call(() => api.sessionUnshare(targetOf(at)), 'Could not stop sharing');
  // Sharing stopped, for that session whatever is on screen by now. OpenCode
  // keeps the link in the session row and reports it again with every later
  // read (createStoppedShares): the panel remembers which one it stopped.
  if (out.ok) stopped?.stop(at.sessionId, at.sessionInfo?.share?.url || out.data?.share?.url || '');
  if (!at.isCurrent()) return MOVED;
  if (!out.ok) return out;
  // The answer is read from that row too, so it can still carry the link.
  if (out.data) applySession(store, at, { ...out.data, share: undefined });
  else store.setSessionInfo({ share: undefined });
  return { ok: true };
}

/**
 * The transcript of the session on screen as a download: `{ ok, filename,
 * json }`. Session id, metadata and file name are the ones captured before the
 * transcript is read, so a panel that moved meanwhile still exports one
 * session, whole: its transcript under its own name.
 */
export async function readTranscriptExport(store, api) {
  const at = captureBinding(store);
  if (!at.sessionId) return { ok: false, error: 'No session.' };
  const out = await call(() => api.sessionMessages(at.sessionId), 'Could not read the transcript');
  if (!out.ok) return at.isCurrent() ? out : MOVED;
  const { filename, json } = exportTranscript({ id: at.sessionId, ...(at.sessionInfo || {}) }, out.data || []);
  return { ok: true, sessionId: at.sessionId, filename, json };
}

/**
 * The model, agent and directory a session last ran with, for the selection
 * the panel just made. `apply(full)` runs only when the read is fresh and the
 * panel is still on the binding it was started under: an answer for an earlier
 * visit to the same session (A → B → A) is as stale as one for another session.
 * Resolves the session info, or null when the answer was dropped.
 */
export async function loadSelectedSession(store, api, sessionId, info, apply) {
  const at = captureBinding(store, { sessionId });
  const detail = await loadSessionDetail(api, sessionId, info);
  if (!at.isCurrent()) return null;
  // Only from a read made now: the tab cache keeps whole sessions, and another
  // window or the CLI may have changed this one's model since it was cached.
  if (!detail.fresh) return detail.info;
  apply(detail.info);
  return detail.info;
}

// ── Navigation ──────────────────────────────────────────────────────────────
// "New session", a project change and a new worktree all end by binding the
// panel to a session they create. They own the panel only as long as nobody
// navigated meanwhile: `nav` is the binding captured at the user's gesture.

/**
 * Stop the turn of the session a navigation is about to leave. Resolves
 * whether that navigation still owns the panel: false when the user selected
 * something else while the abort was out, and then nothing may be cleared.
 */
export async function stopForNavigation(store, api, nav) {
  if (nav.sessionId && nav.isCurrent() && store.getState().running) {
    try { await api.abort(nav.sessionId); } catch (err) { console.warn('[ocp-v2-session-actions] abort before navigation failed', err); }
  }
  return nav.isCurrent();
}

/**
 * Create the session of a navigation. Resolves `{ session, activate }`:
 * `activate` is false when the panel was rebound while the session was being
 * created. The session exists and is worth a tab, but the user's newer
 * selection is not cleared or replaced by it. Throws when OpenCode returns no
 * session (as before).
 */
export async function createSessionForNavigation(store, api, { title, cwd, nav } = {}) {
  const at = isBindingToken(nav) ? nav : captureBinding(store);
  const res = await api.sessionCreate(title ? { title } : {}, cwd);
  const session = res?.data;
  if (!session?.id) throw new Error('session create returned no id');
  return { session, activate: at.isCurrent() };
}

/**
 * Rename the session `binding` was captured on (the one the rename box or the
 * dialog was opened for). The title goes to that session; the store gets it
 * only while it is still on that binding (`applied`). Resolves
 * `{ ok, sessionId, title, applied, error? }`. A rename the server refused is
 * a failure like one that never got an answer: the socket resolves an error
 * reply like any other, so the reply itself is checked, and nothing is
 * renamed here for a rename that did not happen there.
 */
export async function renameSession(store, api, title, { binding } = {}) {
  const at = isBindingToken(binding) ? binding : captureBinding(store);
  const next = String(title || '').trim();
  if (!at.sessionId || !next) return { ok: false, sessionId: at.sessionId, applied: false };
  let res;
  try {
    res = await api.sessionUpdate(at.sessionId, { title: next });
  } catch (err) {
    res = { ok: false, error: err?.message || 'Rename failed' };
  }
  if (replyFailed(res)) {
    return { ok: false, sessionId: at.sessionId, title: next, applied: false, current: at.isCurrent(), error: replyError(res, 'Rename failed') };
  }
  const applied = at.isCurrent();
  if (applied) store.setSession(at.sessionId, { ...(store.getState().sessionInfo || {}), id: at.sessionId, title: next });
  return { ok: true, sessionId: at.sessionId, title: next, applied };
}

/**
 * Switch the MCP profile of the session the panel is on. The answer belongs to
 * the session it was asked for: `save(sessionId, profile)` records it under
 * that session's key whatever is on screen by then, and the store takes it
 * only while it is still on that binding (`applied`). Throws when the server
 * refuses (as before). Resolves `{ sessionId, profile, applied }`, or null
 * when there is no session.
 */
export async function setSessionMcpProfile(store, api, profile, { save } = {}) {
  const at = captureBinding(store);
  if (!at.sessionId) return null;
  const result = await api.mcpProfileSet(at.sessionId, profile);
  if (result?.error || result?.ok === false || Number(result?.status || 200) >= 400) {
    const error = new Error(result?.error || result?.data?.error || `Could not switch MCP profile (${result?.status || 'unknown error'})`);
    error.stale = !at.isCurrent();
    throw error;
  }
  const effective = result?.data?.profile || profile;
  if (typeof save === 'function') save(at.sessionId, effective);
  const applied = at.isCurrent();
  if (applied) store.setMcpProfile(effective);
  return { sessionId: at.sessionId, profile: effective, applied };
}

/**
 * Run the last step of a navigation after something it has to wait for (the
 * panel opening, an unarchive): `go(nav)` runs only while `nav` is still the
 * latest navigation. A click that was overtaken by a newer one while it
 * waited does nothing more. Resolves whether `go` ran.
 */
export async function navigateAfter(nav, wait, go) {
  try { await wait(); } catch (err) { console.warn('[ocp-v2-session-actions] navigation wait failed', err); }
  if (!nav.isCurrent()) return false;
  await go(nav);
  return true;
}

/**
 * Take an untouched session instead of creating one more (boot, with no tab
 * to restore). `list()` reads the sessions, `pick(sessions)` chooses one,
 * `bind(session)` puts the panel on it. Resolves
 *   'adopted'  the panel is on the session
 *   'none'     there is none to take (or the lookup failed): the caller may create one
 *   'moved'    another navigation took the panel meanwhile: nothing was
 *              adopted, and nothing may be created over it either. A lookup
 *              that failed after the panel moved is 'moved' too.
 */
export async function adoptReusableSession(nav, { list, pick, bind } = {}) {
  let sessions = [];
  let failed = false;
  try { sessions = await list(); } catch (err) {
    console.warn('[ocp-v2-session-actions] empty session lookup failed', err);
    failed = true;
  }
  if (!nav.isCurrent()) return 'moved';
  const reusable = failed ? null : pick(Array.isArray(sessions) ? sessions : []);
  if (!reusable) return 'none';
  return nav.apply(() => bind(reusable)) ? 'adopted' : 'moved';
}

/**
 * Where a panel with no tab to restore lands: on a session it can adopt, else
 * on a new one, and on neither once another navigation took the panel.
 * `adopt(nav)` resolves as adoptReusableSession does; `create(nav)` creates
 * and binds. Resolves 'adopted' | 'created' | 'moved'.
 */
export async function landWithoutTabs(nav, { adopt, create } = {}) {
  const adopted = await adopt(nav);
  if (adopted === 'adopted') return 'adopted';
  if (adopted === 'moved' || !nav.isCurrent()) return 'moved';
  await create(nav);
  return 'created';
}

/**
 * After "New session": is the naming dialog still wanted? Only for a session
 * that was created, took the panel, and is still what the panel shows while
 * the click that asked for it is still the latest navigation. Never when the
 * creation failed (there is no session to name), and never over a session the
 * user went to meanwhile.
 */
export function shouldNameCreatedSession(store, nav, created) {
  if (!created?.sessionId || created.activated !== true) return false;
  if (!nav.isCurrent()) return false;
  return store.getState().sessionId === created.sessionId;
}

/**
 * The life of a rename box (the header input, in the main and the sub-agent
 * panel). Returns `finish(cancel)`, for Enter / Escape / blur: it acts once,
 * and whatever happens (cancelled, unchanged, renamed, failed) the box is
 * taken out again through `restore()`, so the next Rename opens a fresh one.
 *   read()            the text in the box
 *   rename(next)      sends it; resolves renameSession's result
 *   restore()         puts the title label back in place of the box
 *   after(result, next)  optional: what the caller does with the result
 */
export function renameBox({ currentTitle = '', read, rename, restore, after } = {}) {
  let finished = false;
  return async function finish(cancel = false) {
    if (finished) return null;
    finished = true;
    const next = String(read() || '').trim();
    if (cancel || !next || next === currentTitle) { restore(); return null; }
    let result;
    try {
      result = await rename(next);
    } catch (err) {
      result = { ok: false, applied: false, current: true, error: err?.message || 'Rename failed' };
    }
    try { after?.(result, next); } finally { restore(); }
    return result;
  };
}
