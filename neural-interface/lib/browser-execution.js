import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const requests = new AsyncLocalStorage();
export const browserV2Enabled = () => process.env.SYNABUN_BROWSER_V2 !== '0';

export async function measureBrowserPhase(name, work) {
  const state = requests.getStore();
  const start = performance.now();
  try { return await work(); }
  finally {
    if (state) {
      state.phases[name] = (state.phases[name] || 0) + performance.now() - start;
      state.counts[name] = (state.counts[name] || 0) + 1;
    }
  }
}

export function assertBrowserRequestActive(req) {
  const state = req?.browserRequest || requests.getStore();
  if (state && (state.signal.aborted || Date.now() >= state.deadline)) {
    const error = new Error(state.actionStarted
      ? 'Browser request expired after execution began; outcome is uncertain. Inspect the page before retrying.'
      : 'Browser request cancelled before execution.');
    error.code = 'BROWSER_REQUEST_CANCELLED';
    throw error;
  }
}

export function browserActionTimeout(req, fallback = 5000) {
  assertBrowserRequestActive(req);
  const state = req?.browserRequest || requests.getStore();
  return state ? Math.max(1, Math.min(fallback, state.deadline - Date.now())) : fallback;
}

export function markBrowserActionStarted(req) {
  assertBrowserRequestActive(req);
  const state = req?.browserRequest || requests.getStore();
  if (state) state.actionStarted = true;
}

/** Bound probes/queues without replaying their underlying operation. Every later
 * mutation still checks request liveness, since Promise.race cannot cancel CDP. */
export async function runBrowserRequest(req, work, fallback = 10000) {
  assertBrowserRequestActive(req);
  const state = req?.browserRequest || requests.getStore();
  let timer, abort;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error('Browser operation deadline exceeded; inspect state before retrying.'), { code: 'BROWSER_OPERATION_TIMEOUT' }));
        timer = setTimeout(fail, Math.max(1, Math.min(fallback, state ? state.deadline - Date.now() : fallback)));
        abort = fail;
        state?.signal.addEventListener('abort', abort, { once: true });
        if (state?.signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) state?.signal.removeEventListener('abort', abort);
  }
}

export function cancellableBrowserDelay(ms, req) {
  assertBrowserRequestActive(req);
  const state = req?.browserRequest || requests.getStore();
  return new Promise((resolve, reject) => {
    const cleanup = () => state?.signal.removeEventListener('abort', abort);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      try { assertBrowserRequestActive(req); } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    state?.signal.addEventListener('abort', abort, { once: true });
    if (state?.signal.aborted) abort();
  });
}

/** Metadata only: never logs URLs, selectors, form values, scripts or response bodies. */
export function browserRequestMiddleware(req, res, next) {
  const controller = new AbortController();
  const start = performance.now();
  const supplied = req.get('X-Synabun-Request-Id');
  const requestId = /^[\w-]{1,80}$/.test(supplied || '') ? supplied : randomUUID();
  const requestedDeadline = Number(req.get('X-Synabun-Deadline'));
  const deadline = Number.isFinite(requestedDeadline) && requestedDeadline > 0
    ? Math.min(requestedDeadline, Date.now() + 120_000) : Date.now() + 120_000;
  const state = { requestId, deadline, signal: controller.signal, actionStarted: false, phases: {}, counts: {} };
  req.browserRequest = state;
  res.setHeader('X-Synabun-Request-Id', requestId);
  let responseBytes = 0;
  let estimatedTextTokens = 0;
  const send = res.send.bind(res);
  res.send = (body) => {
    if (typeof body === 'string' || Buffer.isBuffer(body)) responseBytes = Buffer.byteLength(body);
    return send(body);
  };
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.headersSent || res.destroyed) return res;
    if (body?.error) {
      body = { ...body, actionStarted: state.actionStarted, ...(state.actionStarted ? { outcome: 'uncertain' } : {}) };
      if (!state.actionStarted && body.error === 'Session not found') body.code = 'SESSION_NOT_FOUND';
      if (!state.actionStarted && /^Tab .* not found in session$/.test(body.error)) body.code = 'TAB_NOT_FOUND';
    }
    if (process.env.SYNABUN_BROWSER_METRICS === '1' && body && typeof body === 'object') {
      const { data: _data, image: _image, screenshot: _screenshot, ...textFields } = body;
      estimatedTextTokens = Math.ceil(JSON.stringify(textFields).length / 4);
    }
    const began = performance.now();
    const result = json(body);
    state.phases.serialization = performance.now() - began;
    return result;
  };
  const timer = setTimeout(() => {
    controller.abort();
    if (!res.headersSent && !res.destroyed) {
      res.status(408).json({ error: state.actionStarted
        ? 'Browser deadline exceeded after execution began; outcome uncertain. Inspect before retrying.'
        : 'Browser deadline exceeded before execution.', code: 'BROWSER_DEADLINE_EXCEEDED' });
    }
  }, Math.max(1, deadline - Date.now()));
  const abort = () => controller.abort();
  req.once('aborted', abort);
  let logged = false;
  const finish = () => {
    clearTimeout(timer);
    req.removeListener('aborted', abort);
    if (!res.writableFinished) controller.abort();
    if (!logged && process.env.SYNABUN_BROWSER_METRICS === '1') {
      logged = true;
      const operation = String(req.route?.path || req.path).split('/').pop();
      console.error('[browser-metric]', JSON.stringify({
        requestId, operation: /^[\w-]+$/.test(operation) ? operation : 'session',
        durationMs: performance.now() - start, phases: state.phases, counts: state.counts,
        responseBytes, estimatedTextTokens, status: res.statusCode,
        actionStarted: state.actionStarted, cancelled: controller.signal.aborted,
      }));
    }
  };
  res.once('finish', finish);
  res.once('close', finish);
  requests.run(state, () => {
    if (deadline <= Date.now()) {
      controller.abort();
      return res.status(408).json({ error: 'Browser deadline exceeded before execution.', code: 'BROWSER_DEADLINE_EXCEEDED' });
    }
    next();
  });
}

/** Session-wide write queue: cancelled waiters never execute or consume a write slot. */
export function createEngagementScheduler({ now = Date.now, random = Math.random, delay = cancellableBrowserDelay } = {}) {
  const states = new Map();
  return {
    clear(key) { states.delete(key); },
    async run(key, req, execute) {
      const state = states.get(key) || { tail: Promise.resolve(), lastWriteAt: null };
      states.set(key, state);
      const predecessor = state.tail;
      let release;
      state.tail = new Promise(resolve => { release = resolve; });
      try {
        await predecessor;
        assertBrowserRequestActive(req);
        const gap = 30_000 + Math.floor(random() * 60_001);
        const remaining = state.lastWriteAt === null ? 0 : Math.max(0, state.lastWriteAt + gap - now());
        if (remaining) await measureBrowserPhase('intentionalPacing', () => delay(remaining, req));
        assertBrowserRequestActive(req);
        // Time from completion conservatively includes preparation and uncertain
        // attempts. A wedged probe must not permanently hold the session queue.
        try { return await runBrowserRequest(req, execute, 120_000); }
        finally {
          const request = req?.browserRequest || requests.getStore();
          if (!request || request.actionStarted) state.lastWriteAt = now();
        }
      } finally { release(); }
    },
  };
}

const ENGAGE_WRITE_RE = /tweetButton|data-testid=["']?(like|unlike|retweet|unretweet)\b|-follow\b|:has-text\(["'](Follow|Seguir|Segui|Folgen|Suivre)["']\)/i;

/**
 * The selector-string half of "is this an engagement write". The write queue
 * keys on the selector text, so `a:has-text("Follow")` queues even when the
 * resolved element says nothing; anything that must never queue checks both.
 */
export function isEngagementWriteSelector(selector) {
  return typeof selector === 'string' && ENGAGE_WRITE_RE.test(selector);
}

const X_HOST_RE = /^(?:[a-z0-9-]+\.)*(?:x|twitter)\.com$/i;
function isXPage(url) {
  try { return X_HOST_RE.test(new URL(String(url)).hostname); } catch { return false; }
}

/**
 * Cmd/Ctrl+Enter in an X composer publishes without clicking tweetButton, which
 * skips the publish gate and the write queue. Loops used it when the button was
 * covered by an overlay; the /press route refuses it on loop-owned tabs.
 */
export function isXShortcutPublish(key, url) {
  return typeof key === 'string'
    && /(?:^|\+)(?:Meta|Control|ControlOrMeta|Ctrl|Cmd|Command)\+(?:.*\+)?Enter$/i.test(key.trim())
    && isXPage(url);
}

const X_SCRIPT_TARGET_RE = /tweetButton|confirmationSheetConfirm|["'[=](?:like|unlike|retweet|unretweet)["'\]]|-follow\b/i;
const X_SCRIPT_ACTION_RE = /\.click\s*\(|dispatchEvent\s*\(|requestSubmit\s*\(|\.submit\s*\(/;

/**
 * A browser_evaluate script that clicks a publish/like/repost/follow control on X
 * is the other gate bypass (the "JS .click() on an intercepted tweetButton" trick).
 * Reads that only query those elements stay allowed.
 */
export function isXScriptedWrite(script, url) {
  return typeof script === 'string'
    && X_SCRIPT_TARGET_RE.test(script)
    && X_SCRIPT_ACTION_RE.test(script)
    && isXPage(url);
}

/** Read semantics from the resolved element, including ref-based targets. */
export async function engagementTargetSelector(target) {
  return target.evaluate(el => {
    for (let node = el; node; node = node.parentElement) {
      const testid = node.getAttribute('data-testid') || '';
      const label = (node.getAttribute('aria-label') || node.textContent || '').trim();
      if (/^(tweetButton(?:Inline)?|like|unlike|retweet|unretweet)$/.test(testid) || /-follow$/.test(testid)) {
        return '[data-testid="' + testid + '"]';
      }
      if ((node.tagName === 'BUTTON' || node.getAttribute('role') === 'button')
        && /^(Follow|Seguir|Segui|Folgen|Suivre)$/.test(label)) return 'button:has-text("Follow")';
    }
    return '';
  });
}
