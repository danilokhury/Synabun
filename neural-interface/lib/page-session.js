// ═══════════════════════════════════════════
// SynaBun — The page secret: what tells the owner's own page from a local process
// ═══════════════════════════════════════════
//
// The owner's writes to Skills Studio (a skill creation, an install, a review decision) used to be told apart from
// an agent's by headers alone: an agent sends X-Synabun-Terminal / -Role, the page sends X-SynaBun-UI. Both are
// plain headers any local process can send or leave out, so a shell-capable worker could omit the agent headers
// and start a creation "as the owner" (the P3 review, ea44bd5f).
//
// Now the server mints one random secret per boot and hands it to the page as an HttpOnly, SameSite=Strict cookie
// on the app's own pages (and on the Studio's first read, so a page the service worker served still gets it). The
// browser sends it back by itself with every same-origin request; the page's code never sees it (HttpOnly) and
// never has to send it. An owner write without it is refused (403 PAGE_SECRET_REQUIRED / UI_ONLY). A worker never
// gets it: nothing SynaBun starts is given the cookie, it is in no environment, no file and no API answer a worker
// reads.
//
// Per boot, not per install: the secret lives in this process only (no file in the data home, so nothing a worker
// can read outside the server hands it out), and a restart makes a new one. The owner's open tab keeps the old
// cookie, so its first write after a restart is refused; the page recovers by itself (public/shared/page-session.js
// wraps the page's fetch: a 403 UI_ONLY / PAGE_SECRET_REQUIRED on a same-origin write asks GET /api/page-session,
// which sets this boot's cookie, and sends the write once more; no reload, no toast, nothing lost).
//
// Per port: the browser's cookie jar ignores ports, so every server on localhost sees every localhost cookie. The
// cookie's name carries the port (synabun_page_<port>): two SynaBun servers side by side (the app and a test
// instance, or a second checkout) each read their own and neither overwrites the other's. Other servers on
// localhost still receive it with every request a page of theirs makes, as they receive any localhost cookie: a
// local process that fetches one of the pages itself reads the Set-Cookie header the same way the browser does.
// Both are the same class of limit, stated plainly: the secret raises the bar from "leave the headers out" to
// "know this and fetch a page first"; the worker confinement (lib/worker-confinement.js) is what keeps a
// prompt-injected worker from doing that with its shell (a guarded run's shell may not call SynaBun's own port),
// and the two are meant to be used together. A browser worker that opens SynaBun's pages in the automation browser
// is told apart by the marker cookie (WORKER_BROWSER_COOKIE, set on that browser's context by server.js): its
// owner writes are refused. The marker's name carries no port on purpose: it only ever refuses, so a marker from
// one SynaBun instance refusing an owner write at another is the safe direction, and each automation browser is a
// Playwright context of its own, so no instance's marker is overwritten by another's.

//
// Owner authority by peer identity (lib/peer-identity.js): markers are told by the browser, the TCP table cannot be
// talked into anything. When the server wires a peer lookup in (`peer`), every way the secret is handed out or
// used asks it too: a request from SynaBun's automation browser, a browser started for automation, an agent's
// process tree or a relay is never handed the secret (the pages, GET /api/page-session, a Studio read's attach) and
// never counts as the owner (verify), whatever host, port, cookie or marker it carries, and a service worker there
// gets a worker that takes itself away (serviceWorker). A lookup that could not run leaves the rules above.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { parseCookies } from './http-guards.js';
import { ipv6Groups, mappedIPv4 } from './peer-identity.js';
import { setBrowserNetworkRule, localMarkerPatterns } from './browser-network-guard.js';

/** The cookie's name without a port (tests, hosts that pass none); with one it is pageSecretCookieName(port). */
export const PAGE_SECRET_COOKIE = 'synabun_page';
/** The page secret cookie's name for a server at `port`: synabun_page_<port>, or synabun_page without a port. */
export function pageSecretCookieName(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 ? `${PAGE_SECRET_COOKIE}_${n}` : PAGE_SECRET_COOKIE;
}
/**
 * The marker SynaBun's automation browser carries for SynaBun's own origin: a worker that opens SynaBun's pages in
 * that browser (visual QA of the Studio) gets the page secret cookie like any page, so its writes would pass; this
 * cookie, set on the browser context itself (HttpOnly, by SynaBun, never by a page), tells those tabs apart and an
 * owner write that carries it is refused. Reads, screenshots and clicks still work there.
 */
export const WORKER_BROWSER_COOKIE = 'synabun_worker';
/**
 * The host-proof twin of the marker cookie: a request HEADER SynaBun's browser layer adds to every request its
 * automation browser makes to any local destination (markWorkerBrowserContext, via CDP request interception). The
 * cookie jar is per host, so a worker that drives the automation browser to the LAN IP, the hostname or [::1]
 * instead of localhost gets a fresh page-secret cookie for that host and no marker cookie — it would pass as the
 * owner. The header travels with EVERY request whatever the host or port, and page JS cannot see or remove a
 * header the browser adds at the network layer (and item 1 keeps raw CDP away from a guarded worker, so it cannot
 * strip it there either). The server refuses the page secret and owner authority to any request carrying it.
 */
export const WORKER_BROWSER_HEADER = 'x-synabun-worker';
/** Does a request carry the automation-browser marker (cookie or the host-proof header)? */
function hasWorkerMarker(req) {
  if (req?.headers?.[WORKER_BROWSER_HEADER] !== undefined) return true;
  const jar = parseCookies(req?.headers?.cookie);
  return !!jar && jar[WORKER_BROWSER_COOKIE] !== undefined;
}
/**
 * A host as one spelling: lowercase, no brackets, no trailing dot ("localhost.", "Mac."), an IPv4 address in any of
 * the forms the URL parser takes (127.1, 2130706433, 0x7f.1) as its dotted quad, an IPv4-mapped IPv6 literal
 * ([::ffff:127.0.0.1], [::ffff:7f00:1]) as the IPv4 address it stands for, any other IPv6 literal as its eight groups.
 */
export function canonicalMarkerHost(hostname) {
  let h = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return '';
  if (h.includes(':')) {
    const v4 = mappedIPv4(h);
    if (v4) return v4;
    const groups = ipv6Groups(h);
    return groups ? groups.map((g) => g.toString(16)).join(':') : h;
  }
  if (/^[0-9a-fx.]+$/.test(h)) {
    // A name made of digits, dots and hex: what the browser would connect to (WHATWG IPv4 parsing), if it is an address.
    try { const parsed = new URL(`http://${h}/`).hostname; if (isIP(parsed) === 4) return parsed; } catch { /* not an address */ }
  }
  return h;
}

function isLocalIPv4(dotted) {
  const [a, b] = dotted.split('.').map(Number);
  return a === 127 || a === 10 || a === 0 // loopback, private, "this network"
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) // private
    || (a === 169 && b === 254) // link-local
    || (a === 100 && b >= 64 && b <= 127); // shared address space (CGNAT, a tailnet's addresses)
}

/** Loopback / private-network / link-local host — a local destination the marker header is safe to add to (never a
 *  public site, so the automation browser's fingerprint on real sites is unchanged). Address ranges are matched on
 *  address literals only (127.example.com is a name, and a public one); names match "localhost", *.localhost and this
 *  computer's own names (also as <name>.local), whatever their spelling. */
export function isLocalMarkerHost(hostname, extraNames = []) {
  const h = canonicalMarkerHost(hostname);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h) === 4) return isLocalIPv4(h);
  const groups = h.includes(':') ? ipv6Groups(h) : null;
  if (groups) {
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] <= 1) return true; // :: and ::1
    if ((groups[0] & 0xffc0) === 0xfe80 || (groups[0] & 0xfe00) === 0xfc00) return true; // link-local, unique-local
    if (groups.slice(0, 6).every((g) => g === 0)) return isLocalIPv4(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`); // ::a.b.c.d
    return false;
  }
  return (Array.isArray(extraNames) ? extraNames : []).some((name) => {
    const n = canonicalMarkerHost(name);
    if (!n) return false;
    const bare = n.endsWith('.local') ? n.slice(0, -'.local'.length) : n;
    return h === n || h === bare || h === `${bare}.local`;
  });
}
/**
 * The pages the cookie is set on: the app's shells and the detached side panel's window, each the first page a
 * browser window loads. The Studio's library read sets it too (server.js), as does GET /api/page-session.
 */
export const PAGE_SECRET_PATHS = Object.freeze(['/', '/index.html', '/index2d.html', '/onboarding.html', '/sidepanel-session.html']);
/** The route an open tab asks for this boot's cookie after a restart (public/shared/page-session.js). */
export const PAGE_SECRET_REFRESH_PATH = '/api/page-session';
/** The app's service worker (public/sw.js): a browser that may not hold the secret gets SERVICE_WORKER_NOOP instead. */
export const SERVICE_WORKER_PATH = '/sw.js';
/**
 * The service worker SynaBun's automation browser (and anything else refused the page secret) is given in place of
 * public/sw.js: no fetch handler, so none of that browser's requests is answered by a worker, and it unregisters
 * itself once active (an older worker it replaces goes with it).
 */
export const SERVICE_WORKER_NOOP = `// SynaBun: this browser gets no service worker (it is not the owner's own browser), so every request it makes
// reaches the server as itself. This worker takes itself away.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => { event.waitUntil(self.registration.unregister().catch(() => {})); });
`;

/**
 * @param {object} [o]
 * @param {{ refusal(req): string|null }} [o.peer] lib/peer-identity.js: why a request's peer process may not hold or
 *   use the secret (null when it may, or when it could not be told)
 */
export function createPageSession({ secret = null, cookieName = null, port = null, secure = false, isGuest = null, peer = null, networkRule = setBrowserNetworkRule } = {}) {
  const value = typeof secret === 'string' && secret.length >= 32 ? secret : randomBytes(32).toString('hex');
  const expected = Buffer.from(value);
  const name = typeof cookieName === 'string' && cookieName ? cookieName : pageSecretCookieName(port);
  const guest = (req) => { try { return typeof isGuest === 'function' && isGuest(req) === true; } catch { return true; } };
  /** Why the peer lookup refuses this request the secret, or null (never asked, could not tell, or allowed). */
  const peerRefusal = (req) => { try { return typeof peer?.refusal === 'function' ? (peer.refusal(req) || null) : null; } catch { return null; } };
  /** A request that may neither be handed the secret nor use it: a marker of the automation browser, or its peer. */
  const heldBack = (req) => hasWorkerMarker(req) || !!peerRefusal(req);

  /** The Set-Cookie header value (HttpOnly, SameSite=Strict, the whole site). */
  function cookie() {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }
  /**
   * Add the cookie to a response (once; a header already there is kept and this one appended). Never to a guest, a
   * request with the automation browser's marker or one whose peer is refused: `req` is the response's own request
   * (Express's res.req) unless given, so every caller that hands the page the secret asks the same questions.
   */
  function attach(res, req = res?.req) {
    if (!res || typeof res.getHeader !== 'function' || typeof res.setHeader !== 'function') return;
    if (req && (heldBack(req) || guest(req))) return;
    const current = res.getHeader('Set-Cookie');
    const list = current === undefined ? [] : Array.isArray(current) ? [...current] : [String(current)];
    if (list.some((line) => String(line).startsWith(`${name}=`))) return;
    list.push(cookie());
    res.setHeader('Set-Cookie', list);
  }
  /** Whether a request carries this boot's secret cookie (nothing else asked: the cheap test for "look the peer up"). */
  function carriesSecret(req) {
    const jar = parseCookies(req?.headers?.cookie);
    const got = jar && typeof jar[name] === 'string' ? Buffer.from(jar[name]) : null;
    return !!got && got.length === expected.length && timingSafeEqual(got, expected);
  }
  /** Whether a request carries this boot's secret, and neither the automation browser's marker (cookie or header)
   *  nor a peer the lookup refuses. */
  function verify(req) {
    if (heldBack(req)) return false;
    return carriesSecret(req);
  }
  /** Whether a request comes from a tab of SynaBun's automation browser (the marker cookie or the host-proof header). */
  function fromWorkerBrowser(req) {
    return hasWorkerMarker(req);
  }
  /**
   * Mark a Playwright browser context as SynaBun's automation browser. Two markers, both HttpOnly / network-level so
   * no page script reads or drops them, and never throws:
   *   • a cookie for localhost and 127.0.0.1 at the server's port (kept for compatibility and defence in depth);
   *   • a host-proof request header (WORKER_BROWSER_HEADER) added to every request the context makes to a LOCAL
   *     destination, whatever the host or port (so the LAN IP / hostname / [::1] forms are covered, which the
   *     per-host cookie is not). Public sites are left untouched, so the browser's fingerprint there is unchanged.
   * @param {string[]} [hostNames] this machine's own names (os.hostname / scutil), for the header's local-host test.
   */
  async function markWorkerBrowserContext(context, { port: atPort, hostNames = [] } = {}) {
    if (!context || !(Number(atPort) > 0)) return false;
    if (typeof context.addCookies === 'function') {
      const cookies = ['localhost', '127.0.0.1'].map((host) => ({ name: WORKER_BROWSER_COOKIE, value: '1', url: `http://${host}:${Number(atPort)}/`, httpOnly: true, sameSite: 'Lax' }));
      try { await context.addCookies(cookies); } catch { /* a CDP-attached context may refuse; the header still marks it */ }
    }
    try {
      await networkRule(context, 'worker-marker', {
        patterns: localMarkerPatterns(hostNames),
        decide(request) {
          return isLocalMarkerHost(new URL(request.url).hostname, hostNames) ? { headers: { [WORKER_BROWSER_HEADER]: '1' } } : null;
        },
      });
      return true;
    } catch (error) {
      // Cookies alone miss LAN IPs/hostnames. The caller must not silently
      // navigate an unmarked browser when the host-proof header failed.
      console.warn('[worker-browser] network marker unavailable:', error.message);
      return false;
    }
  }
  /** Express middleware for an owner write: 403 PAGE_SECRET_REQUIRED without the secret. */
  function require(req, res, next) {
    if (verify(req)) return next();
    res.status(403).json({ ok: false, code: 'PAGE_SECRET_REQUIRED', error: 'This change is made from SynaBun\'s own page. Reload the page and try again.' });
  }
  /** Express middleware that sets the cookie on the pages it belongs to (GET only, the app's shells; never a guest's
   *  and never a request that carries the automation-browser marker or whose peer is refused — a marked tab, an
   *  automation browser, an agent or a relay must never be handed the secret). */
  function pages(req, res, next) {
    if ((req.method === 'GET' || req.method === 'HEAD') && PAGE_SECRET_PATHS.includes(req.path) && !guest(req) && !heldBack(req)) attach(res, req);
    next();
  }
  /**
   * GET /api/page-session: this boot's cookie for a page that is already open (its cookie is an earlier boot's
   * after a restart). Answers { ok: true } with the cookie; a guest gets 403 and no cookie. A tab of SynaBun's
   * automation browser (the marker cookie or the host-proof header) is refused the secret too (403 WORKER_BROWSER),
   * as is a request whose peer process the lookup refuses (403 PEER_REFUSED: an automation browser, an agent's
   * process tree, a relay). Never cached.
   */
  function refresh(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (guest(req)) return res.status(403).json({ ok: false, code: 'GUEST_FORBIDDEN', error: 'Available to the owner only.' });
    if (hasWorkerMarker(req)) return res.status(403).json({ ok: false, code: 'WORKER_BROWSER', error: 'SynaBun\'s automation browser does not hold the owner\'s page secret.' });
    const why = peerRefusal(req);
    if (why) return res.status(403).json({ ok: false, code: 'PEER_REFUSED', error: `SynaBun hands its page secret to the owner's own browser only; this request comes from ${why}.` });
    attach(res, req);
    res.json({ ok: true });
  }
  /**
   * Express middleware for GET /sw.js: a browser that may not hold the secret (the automation browser's marker, or a
   * refused peer) gets SERVICE_WORKER_NOOP, so no service worker answers its requests out of the server's sight;
   * everyone else falls through to the real public/sw.js.
   */
  function serviceWorker(req, res, next) {
    if ((req.method === 'GET' || req.method === 'HEAD') && req.path === SERVICE_WORKER_PATH && heldBack(req)) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      return res.end(req.method === 'HEAD' ? undefined : SERVICE_WORKER_NOOP);
    }
    next();
  }
  return { cookieName: name, cookie, attach, carriesSecret, verify, require, pages, refresh, serviceWorker, fromWorkerBrowser, peerRefusal, markWorkerBrowserContext };
}
