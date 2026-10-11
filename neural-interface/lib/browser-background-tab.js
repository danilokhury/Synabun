// ═══════════════════════════════════════════
// SynaBun — a tab opened without selecting it
// ═══════════════════════════════════════════
//
// context.newPage() opens a tab the way a person does: selected, with its window
// restored and brought to the front. On a browser the user shares with the runs
// (a MoreLogin profile, a CDP-attached Chrome) that puts the window over their
// work each time a run starts, and it makes the run's tab the selected one. In
// stock Chromium 147 the selected tab of a minimized or hidden window is the one
// whose screenshots get no answer (lib/browser-screenshot.js); on a MoreLogin
// browser that is not measured yet. Target.createTarget with background: true
// opens the tab behind the selected one: the window stays as it is. The tab is
// not the selected one when it opens; it becomes it later if the user selects it
// or the selected tab closes next to it.

const within = (promise, ms, what, late = null) => {
  let timer;
  let over = false;
  const watched = Promise.resolve(promise);
  // What arrives after the wait was given up (a CDP session) is handed to `late`, not left behind.
  if (late) watched.then((value) => { if (over) Promise.resolve().then(() => late(value)).catch(() => {}); }, () => {});
  return Promise.race([watched, new Promise((_, fail) => { timer = setTimeout(() => { over = true; fail(new Error(`${what} timed out`)); }, ms); })]).finally(() => clearTimeout(timer));
};
const detach = (session) => Promise.resolve().then(() => session.detach()).catch(() => {});
// Closes a tab nobody will use; says so when the browser does not confirm it, because the tab then stays open.
const closeTarget = (session, targetId) => within(Promise.resolve().then(() => session.send('Target.closeTarget', { targetId })), 2000, 'closing the tab')
  .catch((error) => { console.warn(`[browser] background tab ${targetId} was not confirmed closed and may still be open: ${error.message}`); });
// How long the browser session stays attached for a tab asked for and not yet answered, to close it when it comes.
const LATE_TARGET_MS = 60_000;

// The pages this module opened behind the selected tab.
const backgroundPages = new WeakSet();

/** The CDP target id of a Playwright page, or null; given up at `until`, and a session that attaches later is detached. */
async function targetIdOf(context, page, until) {
  const left = () => Math.max(1, until - Date.now());
  let session = null;
  try {
    session = await within(Promise.resolve().then(() => context.newCDPSession(page)), left(), 'attaching', (late) => late?.detach?.());
    return (await within(session.send('Target.getTargetInfo'), left(), 'reading the target')).targetInfo?.targetId || null;
  } catch {
    return null;
  } finally {
    if (session) detach(session);
  }
}

/**
 * Open about:blank in `context` as a background tab and return its Playwright
 * page, found by target id among the pages that appear (another tab's popup is
 * never mistaken for it). `timeoutMs` is for the whole attempt. Null when the
 * browser cannot (no browser-level CDP session, the command refused, the page
 * not reached in time): the tab, if one was created, is closed again — after
 * the answer, so the caller is not kept waiting, and also when the browser only
 * creates it after the wait was given up — and the caller opens a normal one.
 */
export async function openBackgroundPage(browser, context, { timeoutMs = 5000 } = {}) {
  if (typeof browser?.newBrowserCDPSession !== 'function') return null;
  const until = Date.now() + timeoutMs;
  const left = () => Math.max(1, until - Date.now());
  const appeared = [];
  let probe = null;
  const onPage = (page) => { appeared.push(page); probe?.(page); };
  let cdp = null;
  let targetId = null;
  // The browser session is still needed after the answer: to close a tab nobody will use.
  let sessionKept = false;
  context.on('page', onPage);
  try {
    cdp = await within(Promise.resolve().then(() => browser.newBrowserCDPSession()), left(), 'opening a browser CDP session', (late) => late?.detach?.());
    const session = cdp;
    let answered = false;
    const creating = Promise.resolve().then(() => session.send('Target.createTarget', { url: 'about:blank', background: true }));
    creating.then(() => { answered = true; }, () => { answered = true; });
    try {
      ({ targetId } = await within(creating, left(), 'creating the tab'));
    } catch (error) {
      if (!answered) {
        // Asked for and not answered in time: the session stays until the answer comes, to close the tab it names.
        sessionKept = true;
        const giveUp = setTimeout(() => detach(session), LATE_TARGET_MS);
        giveUp.unref?.();
        creating.then((late) => (late?.targetId ? closeTarget(session, late.targetId) : null), () => {}).then(() => { clearTimeout(giveUp); return detach(session); });
      }
      throw error;
    }
    // Every page that appears is asked for its target id at once: one that never answers does not hold up the others.
    const page = await new Promise((done) => {
      const timer = setTimeout(() => done(null), left());
      probe = (candidate) => { targetIdOf(context, candidate, until).then((id) => { if (id === targetId) { clearTimeout(timer); done(candidate); } }); };
      for (const candidate of appeared) probe(candidate);
    });
    if (!page) throw new Error('the tab did not appear');
    backgroundPages.add(page);
    return page;
  } catch {
    if (cdp && targetId) {
      const session = cdp;
      sessionKept = true;
      closeTarget(session, targetId).then(() => detach(session));
    }
    return null;
  } finally {
    probe = null;
    context.off('page', onPage);
    if (cdp && !sessionKept) detach(cdp);
  }
}

/**
 * Whether `page` is the selected tab of its window, as far as the server can
 * tell. No CDP command reports the selected tab, and the page cannot tell
 * either (Playwright's focus emulation keeps every tab "visible"), so this is
 * read from the order tabs were opened in: a tab opened the usual way takes the
 * selection, one opened by openBackgroundPage does not. `likely` is the newest
 * open tab of the context that was not opened in the background; `unlikely` a
 * tab with a newer such tab, or one opened in the background. It is an
 * inference, checked against a real window in Chromium 147 only
 * (tests/browser-screenshot-window.browser.mjs): a tab the user selects by hand,
 * the selected tab closing next to a background tab, or a second window make it
 * wrong without the server seeing it.
 */
export function selectedTabReading(page) {
  try {
    const open = page.context().pages().filter((other) => !other.isClosed?.());
    const at = open.indexOf(page);
    if (at < 0) return { reading: 'unknown', basis: 'not-in-context' };
    if (backgroundPages.has(page)) return { reading: 'unlikely', basis: 'opened-in-background' };
    if (open.slice(at + 1).some((other) => !backgroundPages.has(other))) return { reading: 'unlikely', basis: 'newer-tab-open' };
    return { reading: 'likely', basis: 'newest-foreground-tab' };
  } catch {
    return { reading: 'unknown', basis: 'unreadable' };
  }
}
