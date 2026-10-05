// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — compose logic without DOM (node:test imports this directly)
// ─────────────────────────────────────────────────────────────────────────────

import { isBindingToken } from './ocp-v2-binding.js';

/**
 * The compose box shows the outgoing prompt at once as a local message. The
 * server's copy arrives as message.updated + message.part.updated a moment
 * later; from then on the local one is a duplicate. Drop it as soon as a user
 * message this send did not know about has a part to show, and stop watching
 * when the turn ends.
 *
 * Returns { dropped(), stop() }.
 */
export function trackOptimisticMessage(store, { optimisticId, existingMessageIds, onDrop, isCurrent } = {}) {
  const known = existingMessageIds instanceof Set ? existingMessageIds : new Set(existingMessageIds || []);
  let dropped = false;
  let unsubscribe = () => {};
  const stop = () => { try { unsubscribe(); } catch { /* already gone */ } unsubscribe = () => {}; };
  const drop = () => {
    if (dropped) return;
    dropped = true;
    stop();
    try { onDrop?.(); } catch (e) { console.warn('[ocp-v2-send] optimistic drop failed', e); }
  };
  unsubscribe = store.subscribe((event, state) => {
    if (dropped) return;
    // The store was bound to another session (`isCurrent` is the send's
    // binding): its messages are not this prompt's server copy.
    if (typeof isCurrent === 'function' && !isCurrent()) { dropped = true; stop(); return; }
    if (event?.type === 'message:remove' && event.messageId === optimisticId) { dropped = true; stop(); return; }
    if (event?.type !== 'part:upsert' && event?.type !== 'part:delta') return;
    const id = event.messageId;
    if (!id || id === optimisticId || known.has(id)) return;
    const msg = state.messages.get(id);
    if (msg && (msg.role || msg.info?.role) === 'user') drop();
  });
  return { dropped: () => dropped, stop };
}

// How often a running turn re-reads the whole transcript. Deltas and part
// updates arrive over the socket; this only repairs a dropped event.
export const TRANSCRIPT_SAFETY_POLL_MS = 10_000;

// ── Turns ────────────────────────────────────────────────────────────────────
// The binding says which session the store is on. It does not say which of
// that session's turns a continuation belongs to: an idle event can let the
// next prompt out while the previous send is still reading the transcript,
// and that older send must not end the newer turn. So a turn has an identity
// of its own (store.beginTurn(), a counter), and a turn token is a binding
// token that also knows its turn:
//   isCurrent()  the store is on the token's binding AND no newer turn began
//   onBinding()  the store is on the token's binding (what the transcript, a
//                banner or the strips need: they are the session's, not the turn's)
function turnToken(store, at, turnId) {
  const onBinding = at.isCurrent;
  const sameTurn = () => (typeof store.getTurn === 'function' ? store.getTurn() === turnId : true);
  const isCurrent = () => onBinding() && sameTurn();
  return Object.freeze({ ...at, turnId, onBinding, isCurrent, isStale: () => !isCurrent() });
}

/**
 * Start a turn on the binding `at`: sets `running` and returns the turn token.
 * (A store without beginTurn, in older tests, just gets `running` set.)
 */
export function beginTurn(store, at) {
  const turnId = typeof store.beginTurn === 'function' ? store.beginTurn() : (store.setRunning(true), 0);
  return turnToken(store, at, turnId);
}

/**
 * The turn that is running right now on the binding `at`, for an action on it
 * that waits (Stop): what it clears afterwards is cleared only while that turn
 * is still the newest one of that binding.
 */
export function currentTurn(store, at) {
  return turnToken(store, at, typeof store.getTurn === 'function' ? store.getTurn() : 0);
}

/**
 * A turn ended (finished, failed, was stopped, timed out): clear `running`,
 * unless it is no longer this turn's to clear. `turn` is the token the turn
 * started with (beginTurn; a plain binding token is accepted too): once the
 * panel left that binding the flag is another session's, also when the panel
 * is back on the same session (A → B → A); and once a newer turn began on the
 * same binding the flag is that turn's. A bare session id is still accepted
 * and compared by id only.
 * Returns whether the flag was this turn's to clear.
 */
export function endTurn(store, turn) {
  const current = isBindingToken(turn) ? turn.isCurrent() : store.getState().sessionId === turn;
  if (!current) return false;
  store.setRunning(false);
  return true;
}

/**
 * The outcome of a send, for the panel that started it and for the session it
 * went to. `turn` is the binding token of the send; `item` is the prompt as a
 * queue item (`{ text, images, paths, mentions }`, a command also `command`).
 *   • On the binding it started on, the composer handles it as it always did
 *     (`here` is true): the error banner, the attachments back in the strips,
 *     the queued prompt back at the front of the queue.
 *   • Once the panel is elsewhere, none of that may land in the session on
 *     screen. What could not be delivered is parked for the session it was
 *     written for (`parked`), and comes back, paused, when the panel is on
 *     that session: at the next rebinding to it, or at once when the panel is
 *     already back on it under a newer binding (the composer asks the parking
 *     after every failure: see restoreParkedHere in ocp-v2-send.js).
 */
export function settleFailedSend(turn, parked, { item, error = '' } = {}) {
  const here = typeof turn.onBinding === 'function' ? turn.onBinding() : turn.isCurrent();
  if (here) return { here: true, parked: false };
  const kept = !!(turn.sessionId && item && parked?.park(turn.sessionId, { item, error }));
  return { here: false, parked: kept };
}
