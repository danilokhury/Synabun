// The Stops of an OpenCode side panel turn that could not end a command in the background (server.js
// handleOpencodeV2Ws, message:abort): from the second one of the same turn the panel offers "Stop anyway". One
// counter per socket, keyed by session, each entry naming the turn it counts for (the token of
// `_ocpActiveSessionTurns`). An entry goes when its turn ends or is replaced (`prune`, at every turn end and every
// failure), when its session is deleted (`clear`) and with the socket (`clearAll`), so a long-lived socket that
// works many sessions keeps at most one entry per session whose turn is still on.

/**
 * `activeTurn(sessionId)`: the token of the turn running now in that session, or null / undefined when none.
 */
export function createStopFailures({ activeTurn = () => null } = {}) {
  const entries = new Map();
  const current = (sid) => activeTurn(sid) ?? null;
  /**
   * Drop every entry whose turn is no longer the one running in its session, and every entry counted while no turn
   * was known (a held turn whose token is gone): it could otherwise stay for good. `keep`: a session left alone.
   */
  function prune(keep = null) {
    for (const [sid, entry] of entries) {
      if (sid === keep) continue;
      if (entry.turn === null || current(sid) !== entry.turn) entries.delete(sid);
    }
  }
  return {
    /** A Stop of `sid`'s turn failed: → how many have failed for that turn so far (1 for its first). */
    fail(sid) {
      prune(sid);
      const turn = current(sid);
      const prior = entries.get(sid);
      const count = prior && prior.turn === turn ? prior.count + 1 : 1;
      entries.set(sid, { turn, count });
      return count;
    },
    /** The session's Stop worked, or the session is gone. */
    clear(sid) { entries.delete(sid); },
    prune: () => prune(),
    clearAll() { entries.clear(); },
    get size() { return entries.size; },
  };
}
