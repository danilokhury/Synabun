// ── What a failed wedge recovery retires: the tab, or the whole session (DOM-free) ──
//
// A tab that stops answering is replaced by a new page under the same tab id (recoverSessionTabPage). When the
// replacement cannot be made in time either, the server used to retire the whole browser session. Scheduled runs
// share that session (one MoreLogin profile, a tab per run), so one slow tab ended every other run's tab with it:
// 15 of the 44 session teardowns that orphaned running loops between 2026-10-21 and 2026-11-04 were this, 11 of
// them in one half hour on 2026-11-03 while MoreLogin was slow. A new connection to the same MoreLogin browser does
// not make it faster; it only takes the other runs' tabs away.
//
// So the session is retired only when nothing in it answers any more: the browser is disconnected, or no other tab
// of the session answers a trivial evaluate within the probe deadline. Otherwise only the wedged tab is retired:
// it leaves the registry (its owner's next call gets "Tab not found" and the run's tab recovery opens a new one),
// and the other tabs keep working.

/** How long each other tab may take to answer the liveness probe. */
export const OTHER_TAB_PROBE_MS = 1000;

/**
 * How many of `pages` answer `page.evaluate('1')` within `timeoutMs`, all asked at once. A page that throws, is
 * closed or does not answer in time does not count. Never throws.
 */
export async function answeringPages(pages, timeoutMs = OTHER_TAB_PROBE_MS) {
  const probes = (pages || []).map((page) => new Promise((resolve) => {
    if (!page || page.isClosed?.()) { resolve(false); return; }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    Promise.resolve().then(() => page.evaluate('1')).then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(false); },
    );
  }));
  return (await Promise.all(probes)).filter(Boolean).length;
}

/**
 * The decision for a tab whose replacement page could not be made.
 * - `{ action: 'retire-session', why: 'disconnected' }`: the browser connection itself is gone.
 * - `{ action: 'retire-session', why: 'nothing-answers' }`: no other tab of the session answers (or there is none):
 *   the connection is what is wedged, and a new one may help.
 * - `{ action: 'retire-tab', why: 'others-answer' }`: the browser still serves the session's other tabs.
 */
export function failedRecoveryDecision({ browserConnected, otherTabsAnswering }) {
  if (browserConnected === false) return { action: 'retire-session', why: 'disconnected' };
  if (!(otherTabsAnswering > 0)) return { action: 'retire-session', why: 'nothing-answers' };
  return { action: 'retire-tab', why: 'others-answer' };
}

/**
 * Decide for `tabId` of `session`, probing the session's other registered tabs. Never throws: a probe that fails
 * counts as a tab that does not answer.
 */
export async function decideFailedTabRecovery(session, tabId, { timeoutMs = OTHER_TAB_PROBE_MS } = {}) {
  let browserConnected = null;
  try {
    const connected = session?.browser?.isConnected?.();
    if (typeof connected === 'boolean') browserConnected = connected;
  } catch { browserConnected = false; }
  if (browserConnected === false) return failedRecoveryDecision({ browserConnected, otherTabsAnswering: 0 });
  const others = [...(session?.tabs?.entries?.() || [])]
    .filter(([id, entry]) => id !== tabId && entry?.page)
    .map(([, entry]) => entry.page);
  const otherTabsAnswering = others.length ? await answeringPages(others, timeoutMs) : 0;
  return { ...failedRecoveryDecision({ browserConnected, otherTabsAnswering }), otherTabs: others.length, otherTabsAnswering };
}
