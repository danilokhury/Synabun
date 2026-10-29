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
// action. Anything else (a read, another 403, a refusal the refresh did not cure, a body that cannot be sent
// twice) is handed back as it came, so nothing changes for a request this is not about.
//
// No imports and nothing done at load under Node: tests load it with node --test and a fake fetch. In a browser it
// installs itself on window.fetch when the page loads it (index.html, index2d.html and sidepanel-session.html load
// it as their first module script, before any module that writes), and once only.

/** The route that hands an open tab this boot's cookie (lib/page-session.js PAGE_SECRET_REFRESH_PATH). */
export const PAGE_SECRET_REFRESH_PATH = '/api/page-session';
/** The refusals that mean "the page secret is missing or stale", and nothing else. */
export const PAGE_SECRET_CODES = Object.freeze(['UI_ONLY', 'PAGE_SECRET_REQUIRED']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether an answer is the server refusing a write for want of this boot's page secret. */
export function isPageSecretRefusal(status, body) {
  return Number(status) === 403 && !!body && typeof body === 'object' && PAGE_SECRET_CODES.includes(body.code);
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

function sameOrigin(url, origin) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')) return true; // a path of this page
  if (!origin) return false;
  try { return new URL(url).origin === new URL(origin).origin; } catch { return false; }
}

/**
 * A fetch over `fetchImpl` that recovers the page secret once: the refresh is one request at a time (writes refused
 * together share it), the refused request is sent again only when the refresh answered, and the second answer is
 * final whatever it says.
 */
export function createPageSessionFetch(fetchImpl, { refreshPath = PAGE_SECRET_REFRESH_PATH, origin = null, onRecover = null } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createPageSessionFetch needs a fetch');
  let refreshing = null;
  function refreshCookie() {
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const res = await fetchImpl(refreshPath, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
          return !!res && res.ok === true;
        } catch { return false; } finally { refreshing = null; }
      })();
    }
    return refreshing;
  }
  return async function pageSessionFetch(input, init) {
    const plan = replayPlan(input, init, origin);
    const res = await fetchImpl(input, init);
    if (!plan || !res || res.status !== 403 || typeof res.clone !== 'function') return res;
    let body = null;
    try { body = await res.clone().json(); } catch { return res; }
    if (!isPageSecretRefusal(res.status, body)) return res;
    if (!(await refreshCookie())) return res;
    try { onRecover?.({ method: plan.method, url: plan.url, code: body.code }); } catch { /* a listener's own error */ }
    return fetchImpl(...plan.args);
  };
}

/** Wrap `target.fetch` (the window's) once; returns true when it did, false when it already had or there is none. */
export function installPageSessionRecovery(target = globalThis) {
  if (!target || typeof target.fetch !== 'function' || target.__synabunPageSession) return false;
  const original = target.fetch.bind(target);
  const origin = target.location && typeof target.location.origin === 'string' ? target.location.origin : null;
  target.fetch = createPageSessionFetch(original, { origin });
  try { Object.defineProperty(target, '__synabunPageSession', { value: true, configurable: true }); } catch { target.__synabunPageSession = true; }
  return true;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') installPageSessionRecovery(window);
