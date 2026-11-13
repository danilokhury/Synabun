export const BROWSER_EVALUATE_DEADLINE_MS = 10_000;
export const BROWSER_RECOVERY_PROBE_DEADLINE_MS = 1_000;
export const BROWSER_RECOVERY_STEP_DEADLINE_MS = 5_000;

export const BrowserPageFailureDisposition = Object.freeze({
  NONE: 'none',
  PROBE: 'probe',
  REPLACE: 'replace',
});

export class BrowserOperationTimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`${operation} did not respond within ${timeoutMs}ms`);
    this.name = 'BrowserOperationTimeoutError';
    this.code = 'SYNABUN_BROWSER_OPERATION_TIMEOUT';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

function errorMessage(error) {
  return String(error?.message || error || '');
}

/**
 * Playwright can deliver a lifecycle event after Chromium has already detached
 * the target that originated it. These errors happen outside the request that
 * retired the page, so they must be recognized at the process boundary.
 * Dialog errors stay method-scoped so unrelated protocol failures remain fatal.
 */
export function isIgnorablePlaywrightLifecycleError(error) {
  const message = errorMessage(error);
  if (/frame (?:was |has been )?detached/i.test(message)) return true;

  const isDialogCommand = error?.method === 'Page.handleJavaScriptDialog'
    || /\(Page\.handleJavaScriptDialog\)/.test(message);
  return isDialogCommand
    && /No dialog is showing|Not attached to an active page|Target page, context or browser has been closed|Session closed/i.test(message);
}

/**
 * Classify failures before attempting destructive page replacement. Network and
 * policy errors (including ERR_ABORTED / ERR_BLOCKED_BY_CLIENT / ERR_FAILED) are
 * deliberately left as NONE unless they also carry an actual lifecycle signal.
 */
export function classifyBrowserPageError(error) {
  const message = errorMessage(error);
  if (error?.code === 'SYNABUN_BROWSER_OPERATION_TIMEOUT'
    || /Timeout \d+ms exceeded/i.test(message)
    || /did not respond within \d+ms/i.test(message)
    || /frame (?:was |has been )?detached/i.test(message)
    || /execution context was destroyed/i.test(message)) {
    return BrowserPageFailureDisposition.PROBE;
  }
  if (/target page, context or browser has been closed/i.test(message)
    || /page has been closed/i.test(message)
    || /browser (?:has )?disconnected/i.test(message)
    || /not attached to an active page/i.test(message)) {
    return BrowserPageFailureDisposition.REPLACE;
  }
  return BrowserPageFailureDisposition.NONE;
}

/** Backward-compatible boolean form for callers that only need eligibility. */
export function isRecoverableBrowserPageError(error) {
  return classifyBrowserPageError(error) !== BrowserPageFailureDisposition.NONE;
}

export const SLOW_NAVIGATION_NOTICE = 'The page is still loading: its document arrived, but did not finish loading within the navigation budget. Wait a moment, then browser_snapshot or extract; do not navigate to it again.';

/**
 * browser_navigate answers once the document commits, then waits for DOMContentLoaded at most
 * this long (benchmarked 2026-11-08: waiting for DCL plus a default snapshot added 0.6–1.0 s per
 * navigate and far more on heavy pages). A page that has not parsed by then is answered with
 * `loadState: 'commit'` and PAGE_STILL_PARSING_NOTICE; never a failure.
 */
export const NAVIGATE_DCL_CAP_MS = 1500;
/** The bounded wait the snapshot routes give a page that is still parsing before they capture it. */
export const SNAPSHOT_DCL_WAIT_MS = 5000;

export const PAGE_STILL_PARSING_NOTICE = 'The page committed but is still parsing; browser_snapshot (or any action) waits briefly for it. Do not navigate to it again.';

/**
 * Wait for the page's DOMContentLoaded, at most `capMs`. Resolves 'domcontentloaded' when it
 * arrived (at once when it already had), 'commit' when the cap ran out or the wait failed
 * (closed page, a new navigation): it never rejects.
 */
export async function waitForDomContentLoadedCapped(page, capMs = NAVIGATE_DCL_CAP_MS) {
  const timeout = Math.max(1, Math.floor(Number(capMs) || 0));
  try {
    await page.waitForLoadState('domcontentloaded', { timeout });
    return 'domcontentloaded';
  } catch {
    return 'commit';
  }
}

/**
 * A navigation that timed out after its document committed is a slow page, not a wedged
 * tab. x.com's first load in a cold profile starts its service worker and parses its bundles
 * for longer than the route's 15 s, and its busy renderer misses the 1 s liveness probe: until
 * 2026-11-06 the route then reset the loading tab to about:blank and blocked the URL for two
 * minutes, so "x.com times out on first load" while a warm retry loaded fine.
 * `committed` is whether the main frame navigated while the goto ran; `url` the page's now.
 */
export function navigationLandedDespiteTimeout(error, { committed, url }) {
  const message = errorMessage(error);
  const timedOut = error?.code === 'SYNABUN_BROWSER_OPERATION_TIMEOUT'
    || error?.name === 'TimeoutError'
    || /Timeout \d+ms exceeded/i.test(message);
  if (!timedOut || committed !== true) return false;
  return typeof url === 'string' && /^https?:/i.test(url);
}

/** A URL as navigation compares it: parsed, without its fragment; the text itself when it does not parse. */
function documentUrl(url) {
  try { const parsed = new URL(String(url)); parsed.hash = ''; return parsed.href; } catch { return String(url ?? ''); }
}

/**
 * Whether the main frame commits the document a goto asked for: `framenavigated` of the main frame
 * (never a subframe) to the requested URL or to a URL its main-frame redirect chain led to.
 * A navigation of the main frame elsewhere (the previous page's own script, an ad frame) never
 * counts. `stop()` removes both listeners and may be called any number of times; `committed`
 * keeps its value after it.
 */
export function trackMainDocumentCommit(page, requestedUrl) {
  const accepted = new Set([documentUrl(requestedUrl)]);
  let committed = false;
  let stopped = false;
  const isMain = frame => { try { return frame === page.mainFrame(); } catch { return false; } };
  const onRequest = request => {
    try {
      if (!request.isNavigationRequest() || !isMain(request.frame())) return;
      const from = request.redirectedFrom?.();
      if (from && accepted.has(documentUrl(from.url()))) accepted.add(documentUrl(request.url()));
    } catch { /* a request of a closing page: nothing to learn */ }
  };
  const onNavigated = frame => {
    try { if (isMain(frame) && accepted.has(documentUrl(frame.url()))) committed = true; } catch { /* detached */ }
  };
  page.on('request', onRequest);
  page.on('framenavigated', onNavigated);
  return {
    get committed() { return committed; },
    stop() {
      if (stopped) return;
      stopped = true;
      page.off('request', onRequest);
      page.off('framenavigated', onNavigated);
    },
  };
}

export const SLOW_LOAD_PROBE_DELAY_MS = 5_000;
export const SLOW_LOAD_PROBE_DEADLINE_MS = 1_500;

/**
 * After a navigate answered `slowLoad`, ask the tab once, later, whether it is alive: a page
 * still loading answers a trivial evaluate within `deadlineMs` once its first parse is done, a
 * dead renderer never does. Nothing here blocks the answer that was sent. Cancelled (and
 * `onDead` never called) when the tab closes, when its main frame starts another document,
 * when `isCurrent()` says the tab was replaced, or by `cancel()`. `done` resolves with
 * 'alive' | 'dead' | 'cancelled' once the listeners are gone.
 */
export function scheduleSlowLoadProbe(page, {
  delayMs = SLOW_LOAD_PROBE_DELAY_MS,
  deadlineMs = SLOW_LOAD_PROBE_DEADLINE_MS,
  isCurrent = () => true,
  onDead,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let state = 'waiting';
  let timer = null;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const detach = () => {
    page.off('request', onRequest);
    page.off('close', onClose);
  };
  const cancel = () => {
    if (state === 'done' || state === 'cancelled') return;
    const wasWaiting = state === 'waiting';
    state = 'cancelled';
    if (timer !== null) clearTimer(timer);
    detach();
    // A probe already running settles `done` itself, after its evaluate returns.
    if (wasWaiting) finish('cancelled');
  };
  function onRequest(request) {
    try { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) cancel(); } catch { /* closing */ }
  }
  function onClose() { cancel(); }
  page.on('request', onRequest);
  page.on('close', onClose);
  timer = setTimer(async () => {
    timer = null;
    if (state !== 'waiting') return;
    if (!isCurrent()) { cancel(); return; }
    state = 'probing';
    let failure = null;
    try {
      await withBrowserOperationDeadline(Promise.resolve().then(() => page.evaluate(() => 1)), deadlineMs, 'Slow page liveness probe');
    } catch (error) {
      failure = error;
    }
    if (state === 'cancelled') { finish('cancelled'); return; }
    state = 'done';
    detach();
    if (failure && isCurrent()) {
      try { await onDead?.(failure); } catch { /* the recovery reports its own failures */ }
      finish('dead');
      return;
    }
    finish(failure ? 'cancelled' : 'alive');
  }, delayMs);
  timer?.unref?.();
  return { cancel, done };
}

function runLateCleanup(callback, value, onCleanupError) {
  if (!callback) return;
  Promise.resolve()
    .then(() => callback(value))
    .catch((error) => {
      try { onCleanupError?.(error); } catch { /* cleanup reporting is best-effort */ }
    });
}

/**
 * Put a server-side ceiling below the MCP transport timeout. Playwright page
 * operations are not cancellable in every state, so callers should replace the
 * affected page after this rejects.
 */
export async function withBrowserOperationDeadline(
  promise,
  timeoutMs,
  operation = 'Browser operation',
  { onLateResolve, onLateReject, onCleanupError } = {},
) {
  let timer = null;
  let timedOut = false;
  const observed = Promise.resolve(promise);

  // Promise.race cannot cancel Playwright operations. Observe the original
  // promise so a resource created after our deadline is retired instead of
  // becoming an unregistered page/CDP session.
  observed.then(
    (value) => {
      if (timedOut) runLateCleanup(onLateResolve, value, onCleanupError);
    },
    (error) => {
      if (timedOut) runLateCleanup(onLateReject, error, onCleanupError);
    },
  );

  try {
    return await Promise.race([
      observed,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new BrowserOperationTimeoutError(operation, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
