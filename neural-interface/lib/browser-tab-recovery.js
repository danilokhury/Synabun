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
