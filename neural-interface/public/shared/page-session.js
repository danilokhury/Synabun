// ═══════════════════════════════════════════
// SynaBun — the page secret's recovery: an open tab outlives a server restart
// ═══════════════════════════════════════════
//
// The server tells the owner's own page from a local process by a secret it mints per boot and hands the page as
// an HttpOnly cookie (lib/page-session.js). The page's code never sees or sends that cookie: the browser does. A
// restart mints a new secret, and a tab that stayed open still carries the old cookie, so its first owner write
// (a dispatch, Protect workers, a route card, a Skills Studio install…) would come back 403 UI_ONLY or
// PAGE_SECRET_REQUIRED and the owner would have to reload. The owner wants zero friction, so this module wraps the
// page's fetch once: when a same-origin write is refused with one of those two codes, it asks GET /api/page-session
// (which sets this boot's cookie), then sends the very same request once more and hands back that answer. No
// reload, no toast (the toast fires on the error jsonFetch throws, and it throws only on the final answer), no lost
// action. A read is recovered the same way when it is refused 403 PAGE_SECRET_REQUIRED: since 2026-11-04 the browser
// routes (/api/browser/*) ask every request of the page for this boot's secret, reads included, so the browser panel
// and the browser settings keep working across a restart. Anything else (a read refused UI_ONLY, another 403, a refusal
// the refresh did not cure, a body that cannot be sent twice) is handed back as it came, so nothing changes for a
// request this is not about. refreshPageSession() asks for this boot's cookie by itself (one request at a time): the
// browser panel calls it before it opens its socket again, because a WebSocket refused for a stale cookie never says why.
//
// No imports and nothing done at load under Node: tests load it with node --test and a fake fetch. In a browser it
// installs itself on window.fetch when the page loads it (index.html, index2d.html and sidepanel-session.html load
// it as their first module script, before any module that writes), and once only.
//
// 503 PEER_UNAVAILABLE is something else: the server could not tell which program sent the request (macOS, its
// lookup of the calling process failed: lib/peer-identity.js), so it hands out no page secret and refuses the owner's
// actions until a lookup works again. Nothing here cures that, so nothing is retried: the answer goes back as it came,
// and the page is told once per answer (the `synabun:peer-unavailable` event on the window, which
// ui-owner-authority.js turns into its banner). A refresh that met it (GET /api/page-session answered 503) is not asked
// again for a few seconds: a burst of refused writes costs the server one lookup, not one each.
//
// A refusal nothing here cures (403 WORKER_BROWSER, OWNER_ROUTE, or PAGE_SECRET_REQUIRED the refresh did not cure) is
// the page not having the owner's access at all: SynaBun's automation browser opened it, by design. The answer still
// goes back as it came; the page is told (`synabun:owner-access-refused` on the window, which ui-owner-access.js turns
// into one banner and each panel into "No access" instead of an empty list or default values). A refresh that gets
// this boot's secret is told too (`synabun:owner-access-restored`).

/** The route that hands an open tab this boot's cookie (lib/page-session.js PAGE_SECRET_REFRESH_PATH). */
export const PAGE_SECRET_REFRESH_PATH = '/api/page-session';
/** The refusals that mean "the page secret is missing or stale", and nothing else. */
export const PAGE_SECRET_CODES = Object.freeze(['UI_ONLY', 'PAGE_SECRET_REQUIRED']);
/** The answer that means "the server could not identify the caller" (lib/owner-authority.js PEER_UNAVAILABLE). */
export const PEER_UNAVAILABLE_CODE = 'PEER_UNAVAILABLE';
/** The window event a 503 PEER_UNAVAILABLE becomes (detail: { reason, retryable, error, url, method }). */
export const PEER_UNAVAILABLE_EVENT = 'synabun:peer-unavailable';
/** How long a refresh that met 503 PEER_UNAVAILABLE is not asked again. */
export const REFRESH_COOLDOWN_MS = 5000;
/**
 * The final refusals that mean "this page does not have the owner's access" (after any recovery here was tried):
 * WORKER_BROWSER (SynaBun's automation browser: never the owner), PAGE_SECRET_REQUIRED (no secret, and the refresh
 * did not cure it), OWNER_ROUTE (a route the owner's page only reaches). Told once per answer to `onRefused`, which
 * the window turns into OWNER_ACCESS_REFUSED_EVENT (ui-owner-access.js: the banner and the panels' "No access").
 */
export const OWNER_ACCESS_CODES = Object.freeze(['WORKER_BROWSER', 'PAGE_SECRET_REQUIRED', 'OWNER_ROUTE']);
/** The window event a final owner refusal becomes (detail: { code, url, method, status }). */
export const OWNER_ACCESS_REFUSED_EVENT = 'synabun:owner-access-refused';
/** The window event a refresh that got this boot's page secret becomes (detail: {}): the page is the owner's again. */
export const OWNER_ACCESS_RESTORED_EVENT = 'synabun:owner-access-restored';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether an answer is the server refusing a write for want of this boot's page secret. */
export function isPageSecretRefusal(status, body) {
  return Number(status) === 403 && !!body && typeof body === 'object' && PAGE_SECRET_CODES.includes(body.code);
}

/** Whether an answer is a final refusal of the owner's access (403 with one of OWNER_ACCESS_CODES). */
export function isOwnerAccessRefusal(status, body) {
  return Number(status) === 403 && !!body && typeof body === 'object' && OWNER_ACCESS_CODES.includes(body.code);
}

/** Whether an answer is the server saying it could not identify the caller (never retried here). */
export function isPeerUnavailable(status, body) {
  return Number(status) === 503 && !!body && typeof body === 'object' && body.code === PEER_UNAVAILABLE_CODE;
}

/**
 * What a request is, for the retry: its method, whether it is same-origin, and the arguments that send it again,
 * or null when it is not a write, goes elsewhere, or cannot be sent twice (a streamed body).
 */
export function replayPlan(input, init, origin = null) {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const method = String(init?.method || (isRequest ? input.method : '') || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return null;
  const url = isRequest ? input.url : (input instanceof URL ? input.href : String(input ?? ''));
  if (!sameOrigin(url, origin)) return null;
  const body = init?.body;
  if (body && typeof body === 'object' && typeof body.getReader === 'function') return null; // a stream is read once
  // fetch(request) reads the request's body: a copy taken before the first send is what the second one sends.
  const again = isRequest ? input.clone() : input;
  return { method, url, args: init === undefined ? [again] : [again, init] };
}

/** The same for a read (GET / HEAD of this origin): sent again only when it was refused for the page secret. */
export function readReplayPlan(input, init, origin = null) {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const method = String(init?.method || (isRequest ? input.method : '') || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  const url = isRequest ? input.url : (input instanceof URL ? input.href : String(input ?? ''));
  if (!sameOrigin(url, origin)) return null;
  const again = isRequest ? input.clone() : input;
  return { method, url, read: true, args: init === undefined ? [again] : [again, init] };
}

function sameOrigin(url, origin) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')) return true; // a path of this page
  if (!origin) return false;
  try { return new URL(url).origin === new URL(origin).origin; } catch { return false; }
}

/** A request's URL and method as given to fetch (for the event's detail). */
function describeRequest(input, init) {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const method = String(init?.method || (isRequest ? input.method : '') || 'GET').toUpperCase();
  const url = isRequest ? input.url : (input instanceof URL ? input.href : String(input ?? ''));
  return { method, url };
}

/**
 * A fetch over `fetchImpl` that recovers the page secret once: the refresh is one request at a time (writes refused
 * together share it), the refused request is sent again only when the refresh answered, and the second answer is
 * final whatever it says. A 503 PEER_UNAVAILABLE (a write's, a read's, or the refresh's) is never retried: it is handed
 * back as it came and told to `onUnavailable` ({ reason, retryable, error, url, method }); after the refresh met one,
 * refused writes are handed back without a refresh for `cooldownMs`.
 */
export function createPageSessionFetch(fetchImpl, { refreshPath = PAGE_SECRET_REFRESH_PATH, origin = null, onRecover = null, onUnavailable = null, onRefused = null, onRestored = null, cooldownMs = REFRESH_COOLDOWN_MS, now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createPageSessionFetch needs a fetch');
  let refreshing = null;
  let quietUntil = 0;
  const tell = (body, request) => {
    try { onUnavailable?.({ reason: typeof body?.reason === 'string' ? body.reason : '', retryable: body?.retryable === true, error: typeof body?.error === 'string' ? body.error : '', url: request.url, method: request.method }); } catch { /* a listener's own error */ }
  };
  const tellRefused = (body, request, status = 403) => {
    try { onRefused?.({ code: body.code, url: request.url, method: request.method, status }); } catch { /* a listener's own error */ }
  };
  /** Read a 403 answer's body and tell it when it is a final owner refusal (the answer itself is untouched). */
  async function noteRefused(res, request) {
    if (!onRefused || !res || res.status !== 403 || typeof res.clone !== 'function') return res;
    let body = null;
    try { body = await res.clone().json(); } catch { return res; }
    if (isOwnerAccessRefusal(res.status, body)) tellRefused(body, request);
    return res;
  }
  /** Read a 503 answer's body and tell it when it is PEER_UNAVAILABLE (the answer itself is untouched). */
  async function noteUnavailable(res, request) {
    if (!res || res.status !== 503 || typeof res.clone !== 'function') return false;
    let body = null;
    try { body = await res.clone().json(); } catch { return false; }
    if (!isPeerUnavailable(res.status, body)) return false;
    tell(body, request);
    return true;
  }
  function refreshCookie() {
    if (now() < quietUntil) return Promise.resolve(false);
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const res = await fetchImpl(refreshPath, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
          if (await noteUnavailable(res, { url: refreshPath, method: 'GET' })) { quietUntil = now() + Math.max(0, Number(cooldownMs) || 0); return false; }
          if (res && res.ok === true) { try { onRestored?.(); } catch { /* a listener's own error */ } return true; }
          // The server refusing this page the secret itself (403 WORKER_BROWSER: the automation browser) is told too.
          await noteRefused(res, { url: refreshPath, method: 'GET' });
          return false;
        } catch { return false; } finally { refreshing = null; }
      })();
    }
    return refreshing;
  }
  async function pageSessionFetch(input, init) {
    const plan = replayPlan(input, init, origin) || readReplayPlan(input, init, origin);
    const request = describeRequest(input, init);
    const res = await fetchImpl(input, init);
    if (res && res.status === 503) { await noteUnavailable(res, request); return res; }
    if (!plan || !res || res.status !== 403 || typeof res.clone !== 'function') return noteRefused(res, request);
    let body = null;
    try { body = await res.clone().json(); } catch { return res; }
    if (!isPageSecretRefusal(res.status, body)) { if (isOwnerAccessRefusal(res.status, body)) tellRefused(body, request); return res; }
    // A read is the page secret's business only when it says so (the browser routes): UI_ONLY on a read is handed back.
    if (plan.read && body.code !== 'PAGE_SECRET_REQUIRED') return res;
    if (!(await refreshCookie())) { if (isOwnerAccessRefusal(res.status, body)) tellRefused(body, request); return res; }
    try { onRecover?.({ method: plan.method, url: plan.url, code: body.code }); } catch { /* a listener's own error */ }
    const again = await fetchImpl(...plan.args);
    if (again && again.status === 503) await noteUnavailable(again, { url: plan.url, method: plan.method });
    return noteRefused(again, { url: plan.url, method: plan.method });
  }
  // The refresh by itself (one at a time, the same cooldown): true when the server handed this boot's cookie.
  pageSessionFetch.refreshPageSession = () => refreshCookie();
  return pageSessionFetch;
}

/** Wrap `target.fetch` (the window's) once; returns true when it did, false when it already had or there is none.
 *  A 503 PEER_UNAVAILABLE is dispatched on `target` as PEER_UNAVAILABLE_EVENT, a final owner refusal as
 *  OWNER_ACCESS_REFUSED_EVENT and a refresh that got the secret as OWNER_ACCESS_RESTORED_EVENT (when it can dispatch). */
export function installPageSessionRecovery(target = globalThis) {
  if (!target || typeof target.fetch !== 'function' || target.__synabunPageSession) return false;
  const original = target.fetch.bind(target);
  const origin = target.location && typeof target.location.origin === 'string' ? target.location.origin : null;
  const dispatch = (name, detail) => {
    if (typeof target.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return;
    target.dispatchEvent(new CustomEvent(name, { detail }));
  };
  const onUnavailable = (detail) => dispatch(PEER_UNAVAILABLE_EVENT, detail);
  // The last refusal is kept on the window too, for a module that listens only after it was told.
  const onRefused = (detail) => { try { target.__synabunOwnerAccessRefused = detail; } catch { /* a frozen target */ } dispatch(OWNER_ACCESS_REFUSED_EVENT, detail); };
  const onRestored = () => { try { delete target.__synabunOwnerAccessRefused; } catch { /* a frozen target */ } dispatch(OWNER_ACCESS_RESTORED_EVENT, {}); };
  target.fetch = createPageSessionFetch(original, { origin, onUnavailable, onRefused, onRestored });
  try { Object.defineProperty(target, '__synabunPageSession', { value: true, configurable: true }); } catch { target.__synabunPageSession = true; }
  return true;
}

/**
 * Ask for this boot's page secret now (GET /api/page-session through the installed recovery: one request at a time,
 * none during a cooldown after a 503). Resolves true when the server handed it, false otherwise; never rejects. For a
 * socket the browser opens by itself (the browser panel's /ws/browser/:id), whose refusal for a stale cookie the page
 * cannot read.
 */
export async function refreshPageSession(target = globalThis) {
  try {
    const refresh = target?.fetch?.refreshPageSession;
    if (typeof refresh === 'function') return (await refresh()) === true;
    if (typeof target?.fetch !== 'function') return false;
    const res = await target.fetch(PAGE_SECRET_REFRESH_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    return !!res && res.ok === true;
  } catch { return false; }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') installPageSessionRecovery(window);
