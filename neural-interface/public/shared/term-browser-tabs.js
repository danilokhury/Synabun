// The browser tabs of the terminal panel that a fresh browser session replaces. DOM-free (ui-terminal.js is
// the page side); tests/terminal-browser-tabs.test.mjs.
//
// A fresh session (openBrowser({ fresh: true })) ends every browser session on the server and must take their
// tabs out of the panel too. It used to look each tab up by its position in the tab bar and close it with a
// function that did not exist; the error went into a catch that ignored everything, so the old tabs stayed,
// each on a session the server no longer had.

/**
 * Close every browser tab in `sessions` through `closeSession(index)`.
 *
 * By session, never by position in the tab bar: closing one takes it out of `sessions` and redraws the bar,
 * so every index and every tab element read before it is stale. A session whose server side this fresh start
 * already ended (`deletedIds`) is marked so its teardown does not ask the server to end it again.
 *
 * @param {Array<object>} sessions  the live session list (mutated by `closeSession`)
 * @param {(index: number) => unknown} closeSession
 * @param {{ deletedIds?: Iterable<string> }} [options]
 * @returns {string[]} the ids of the sessions it closed
 */
export function closeBrowserTabs(sessions, closeSession, { deletedIds = [] } = {}) {
  if (!Array.isArray(sessions)) throw new TypeError('closeBrowserTabs: sessions must be the session list');
  if (typeof closeSession !== 'function') throw new TypeError('closeBrowserTabs: closeSession must be a function');
  const ended = new Set(deletedIds);
  const closed = [];
  for (const session of sessions.filter((entry) => entry && entry._isBrowser)) {
    const index = sessions.indexOf(session);
    if (index < 0) continue; // closed with an earlier one
    if (ended.has(session.id)) session._skipServerDelete = true;
    closeSession(index);
    closed.push(session.id);
  }
  return closed;
}
