// ── What an explicit close of a browser session closes (DOM-free) ──
//
// Scheduled runs share one browser session (one MoreLogin profile), each in a tab of its own. On 2026-11-04 a
// curiosity-video run cleaned up with browser_session close on every session it listed, the shared one included,
// and the Bluesky reply-back run working in that session lost its tab mid-write ("Session not found"). An
// automation's close therefore never tears down a session another automation still works in: it closes the
// caller's own tab there and leaves the rest. The owner's own close (the Neural Interface page, which sends no
// X-Synabun-Terminal) is a supervised action and still closes the whole session.
//
// An automation closes or stops only what it works in (2026-11-05, review 972afb74, finding 4): before, an automation
// that owned nothing in a session nobody else held (the owner's manual session, or a profile only the owner used)
// destroyed it or stopped the profile, because "no other owner" read as "nobody to protect".

/** Whether `caller` works in `session`: a tab of its own there (open or not yet pruned), or a hold on the session. */
export function holdsSession(session, caller) {
  if (!session || !caller) return false;
  if (session._tabOwners?.has?.(caller)) return true;
  return [session._loopOwned, session._interactiveOwned, session._agentOwnedSet].some((set) => !!set?.has?.(caller));
}

/**
 * The automations other than `caller` that still work in `session`: owners of a tab that is open, and the loops,
 * interactive MCP callers and agents that hold the session. Reads the session's own registries only.
 */
export function otherSessionOwners(session, caller) {
  const others = new Set();
  const tabs = session?.tabs;
  for (const [owner, tabId] of session?._tabOwners || []) {
    if (owner !== caller && (!tabs || tabs.has(tabId))) others.add(owner);
  }
  for (const set of [session?._loopOwned, session?._interactiveOwned, session?._agentOwnedSet]) {
    for (const owner of set || []) if (owner !== caller) others.add(owner);
  }
  return [...others];
}

/**
 * What DELETE /api/browser/sessions/:id does for this caller.
 * - `{ action: 'destroy' }`: the owner's close (no caller), a session that is gone, or an automation's close of a
 *   session it works in and nobody else does.
 * - `{ action: 'release', others, ownTabId }`: an automation's close of a session it works in and others still use:
 *   only the caller's own tab (ownTabId, null when it has none open there) is closed and its claims dropped.
 * - `{ action: 'refuse' }`: an automation's close of a session it does not work in (no tab of its own, no hold): the
 *   owner's to close.
 */
export function sessionCloseDecision(session, caller) {
  if (!session || !caller) return { action: 'destroy' };
  if (!holdsSession(session, caller)) return { action: 'refuse', reason: 'not_owned' };
  const others = otherSessionOwners(session, caller);
  if (others.length === 0) return { action: 'destroy' };
  const ownTabId = session._tabOwners?.get?.(caller) || null;
  return { action: 'release', others, ownTabId: ownTabId && session.tabs?.has?.(ownTabId) !== false ? ownTabId : null };
}

/**
 * What POST /api/morelogin/stop does for this caller. Stopping a MoreLogin profile closes its whole browser, and
 * with it the tab of every run in every session on that profile: an agent that called the `morelogin` tool's `stop`
 * on the shared profile ended the other runs' tabs three times between 2026-10-27 and 2026-11-03.
 * - `{ action: 'stop' }`: the owner's stop (no caller), or an automation's stop of a profile it holds (it works in a
 *   session on it, or `startedBy` says it started the profile) where no other automation works.
 * - `{ action: 'refuse', others, sessionIds }`: an automation's stop while others work there.
 * - `{ action: 'refuse', reason: 'not_owned', others: [], sessionIds: [] }`: an automation's stop of a profile it does
 *   not hold: the owner's to stop.
 * `sessions` is the server's session registry (id → session); a session is on the profile when it is a MoreLogin
 * session with that env id. `startedBy(envId)` lists who started the profile through POST /api/morelogin/start.
 */
export function profileStopDecision(sessions, envId, caller, { startedBy = () => [] } = {}) {
  if (!caller || !envId) return { action: 'stop' };
  const others = new Set();
  const sessionIds = [];
  let holds = false;
  try { holds = [...(startedBy(String(envId)) || [])].includes(caller); } catch { holds = false; }
  for (const [id, session] of sessions || []) {
    if (session?._profileMode !== 'morelogin' || String(session?._mlEnvId ?? '') !== String(envId)) continue;
    if (holdsSession(session, caller)) holds = true;
    const theirs = otherSessionOwners(session, caller);
    if (theirs.length === 0) continue;
    sessionIds.push(id);
    for (const owner of theirs) others.add(owner);
  }
  if (others.size) return { action: 'refuse', others: [...others], sessionIds };
  if (!holds) return { action: 'refuse', reason: 'not_owned', others: [], sessionIds: [] };
  return { action: 'stop' };
}
