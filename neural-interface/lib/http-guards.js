// ═══════════════════════════════════════════
// SynaBun — HTTP guards for local-only routes
// ═══════════════════════════════════════════
//
// Express middleware for routes that must only ever answer the person sitting
// at the computer running SynaBun (first user: /api/whatsapp). Every refusal
// is JSON `{ ok: false, code, error }` with a 4xx status. Nothing here sets an
// Access-Control-* header, ever: a cross-origin page gets no CORS grant, so
// any preflight it needs fails in the browser.
//
//   requireLocal                socket address must be loopback; any proxy or tunnel header refuses
//   requireLocalHost(port)      Host must be localhost / 127.0.0.1 / [::1] on our port (DNS rebinding)
//   requireSameOriginJson(port) state-changing methods: our Origin, Sec-Fetch-Site, JSON, X-SynaBun-UI: 1
//   requireJson                 415 unless req.is('application/json')
//   uiOnly                      refuses requests carrying agent headers
//   guestForbidden(pred)        refuses invite guests (fail closed)
//   noStore                     Cache-Control: no-store
//
// And for every WebSocket upgrade (server.js, app-wide):
//
//   isAllowedWebSocketOrigin(req, {port, allowedOrigins})  a browser's Origin must be this server, under one of its own names
//   isAllowedHost(host, {allowedHosts, machineName})       is this Host one of our names, one DNS rebinding cannot borrow?
//   refuseUpgrade(socket, status)                          answer the upgrade with an HTTP error, close
//
// requireLocal reads req.socket.remoteAddress and nothing else — never req.ip,
// never X-Forwarded-For — so Express's 'trust proxy' setting cannot change its
// answer. A tunnel (cloudflared) or a reverse proxy on this machine connects
// from loopback, which is why any forwarding header refuses on its own.
//
// requireJson relies on Express's req.is(), which returns null for a request
// without a body (neither Content-Length nor Transfer-Encoding) and false
// without a JSON Content-Type, so callers must always send a JSON body — the
// UI sends {} when it has nothing to say. (A browser's empty POST carries
// Content-Length: 0, which type-is counts as a body.) A cross-site page cannot
// send application/json, or the custom X-SynaBun-UI header, without a CORS
// preflight, and SynaBun never answers one.

import { isIP } from 'node:net';
import { hostname as osHostname } from 'node:os';

/** Headers that mean a proxy or tunnel forwarded the request (lower-case). */
export const PROXY_HEADERS = Object.freeze(['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via']);

/** Headers that mark a request as an agent's rather than the user's (lower-case). */
export const AGENT_HEADERS = Object.freeze(['x-synabun-desktop-grant', 'x-synabun-terminal', 'x-synabun-role', 'x-synabun-assistant']);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// RFC 3986 dec-octet: 0-255, no leading zeros (Node never reports them).
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
const MAPPED_PREFIX_RE = /^::ffff:/i;
// A Host header as a browser sends one: a bracketed IPv6 literal, or a name of
// non-empty ASCII labels with at most one trailing dot, then an optional port
// without a leading zero. Checked before new URL(), which would otherwise drop
// userinfo, a path or a query, and decode %-escapes into a name.
const HOST_HEADER_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?)(?::[1-9]\d{0,4})?$/i;

const hasHeader = (req, name) => req.headers?.[name] !== undefined;

function localAuthorities(port) {
  const n = typeof port === 'string' && /^\d{1,5}$/.test(port) ? Number(port) : port;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new TypeError(`http-guards: invalid port ${String(port)}`);
  return [`localhost:${n}`, `127.0.0.1:${n}`, `[::1]:${n}`];
}

/** Send a guard refusal: `{ ok: false, code, error }`, plus `field` when one is given. */
export function sendGuardError(res, status, code, error, field) {
  const body = { ok: false, code, error };
  if (field != null) body.field = field;
  return res.status(status).json(body);
}

/** True for 127.0.0.0/8, ::1 / 0:0:0:0:0:0:0:1 and ::ffff:<dotted 127.x.x.x>; false for everything else, host names included. */
export function isLoopbackAddress(addr) {
  if (typeof addr !== 'string') return false;
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = MAPPED_PREFIX_RE.test(addr) && IPV4_RE.test(addr.slice(7)) ? addr.slice(7) : addr;
  return IPV4_RE.test(ipv4) && ipv4.startsWith('127.');
}

/** Refuse a request that carries any proxy/tunnel header (even empty) or whose socket is not loopback. */
export function requireLocal(req, res, next) {
  if (PROXY_HEADERS.some((name) => hasHeader(req, name))) return sendGuardError(res, 403, 'REMOTE_FORBIDDEN', 'Only available on the computer running SynaBun.');
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return sendGuardError(res, 403, 'LOCAL_ONLY', 'Open SynaBun on this computer to see this.');
  next();
}

/** Host must be exactly localhost:<port>, 127.0.0.1:<port> or [::1]:<port> (host part case-insensitive). Throws on an invalid port. */
export function requireLocalHost(port) {
  const allowed = new Set(localAuthorities(port));
  return function requireLocalHostGuard(req, res, next) {
    const host = req.headers?.host;
    if (typeof host !== 'string' || !allowed.has(host.toLowerCase())) return sendGuardError(res, 403, 'BAD_HOST', 'Unexpected Host header.');
    next();
  };
}

/** 415 unless req.is('application/json') — which is null for a request with no body. */
export function requireJson(req, res, next) {
  if (typeof req.is !== 'function' || !req.is('application/json')) return sendGuardError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON (Content-Type: application/json).');
  next();
}

/** State-changing requests only (GET, HEAD, OPTIONS pass): our exact Origin, Sec-Fetch-Site same-origin when sent, a JSON body, X-SynaBun-UI: 1. Throws on an invalid port. */
export function requireSameOriginJson(port) {
  const origins = new Set(localAuthorities(port).map((authority) => `http://${authority}`));
  return function requireSameOriginJsonGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers?.origin;
    if (typeof origin !== 'string' || !origins.has(origin)) return sendGuardError(res, 403, 'BAD_ORIGIN', 'Missing or unexpected Origin header.');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return sendGuardError(res, 403, 'CROSS_SITE', 'Cross-site requests are refused.');
    requireJson(req, res, () => {
      if (req.headers['x-synabun-ui'] !== '1') return sendGuardError(res, 403, 'UI_HEADER_REQUIRED', 'Send the X-SynaBun-UI: 1 header.');
      next();
    });
  };
}

/** Refuse a request carrying any agent header (even empty): these controls are the user's. */
export function uiOnly(req, res, next) {
  if (AGENT_HEADERS.some((name) => hasHeader(req, name))) return sendGuardError(res, 403, 'UI_ONLY', 'This control is reserved for the user.');
  next();
}

/** Refuse invite guests: isGuestRequest(req) truthy, or throwing, is a guest; no predicate means nobody is. */
export function guestForbidden(isGuestRequest) {
  return function guestForbiddenGuard(req, res, next) {
    let guest = false;
    if (isGuestRequest != null) {
      try { guest = !!isGuestRequest(req); } catch { guest = true; }
    }
    if (guest) return sendGuardError(res, 403, 'GUEST_FORBIDDEN', 'Available to the owner only.');
    next();
  };
}

/** Cache-Control: no-store. */
export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

/** An http(s) origin in its serialized form ("http://localhost:3344"), or null. */
function originOf(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** A Host header → { name, ip } (name lower-case, one trailing dot dropped; IPs canonical, IPv6 in brackets), or null when no browser would send it. */
function parseHostHeader(value) {
  if (typeof value !== 'string' || !HOST_HEADER_RE.test(value)) return null;
  let url;
  try { url = new URL(`http://${value}`); } catch { return null; }
  const name = url.hostname;
  if (name.startsWith('[')) return isIP(name.slice(1, -1)) === 6 ? { name, ip: true } : null;
  if (isIP(name) === 4) return { name, ip: true };
  const bare = name.endsWith('.') ? name.slice(0, -1) : name;
  return bare ? { name: bare, ip: false } : null;
}

/** This machine's names: os.hostname() (or `machineName`, a string or a function) bare and with ".local". */
function machineNames(machineName) {
  let value;
  try { value = typeof machineName === 'function' ? machineName() : machineName; } catch { return []; }
  const parsed = parseHostHeader(value);
  if (!parsed || parsed.ip) return [];
  const bare = parsed.name.endsWith('.local') ? parsed.name.slice(0, -'.local'.length) : parsed.name;
  return bare ? [bare, `${bare}.local`] : [];
}

/** The host names of `allowedHosts` entries: http(s) URLs, host names or host:port. Anything else counts for nothing. */
function listedNames(allowedHosts) {
  let list;
  try { list = typeof allowedHosts === 'function' ? allowedHosts() : allowedHosts; } catch { return []; }
  if (!Array.isArray(list)) return [];
  const names = [];
  for (const entry of list) {
    if (!entry) continue;
    let host = String(entry);
    if (host.includes('://')) {
      try {
        const url = new URL(host);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        host = url.host;
      } catch { continue; }
    }
    const parsed = parseHostHeader(host);
    if (parsed && !parsed.ip) names.push(parsed.name);
  }
  return names;
}

/**
 * Is `host` (a Host header) one of this server's own names, a name no web page
 * can re-point at this machine through DNS rebinding? True for:
 *
 *   - loopback names: localhost and *.localhost (RFC 6761: browsers resolve them
 *     to loopback themselves), 127.0.0.0/8 and [::1];
 *   - any other IP literal, v4 or v6 (IPv6 in brackets): rebinding needs a name;
 *   - this machine: os.hostname() (or `machineName`), bare and with ".local";
 *   - the host name of an `allowedHosts` entry (http(s) URLs, host names or
 *     host:port; an array, or a function called only when nothing above matched):
 *     the tunnel and the invite proxy. Exact names, never a subdomain or a parent.
 *
 * Case never matters and one trailing dot names the same host: "localhost." is
 * loopback, "attacker.example." is still attacker.example. Ports do not matter
 * here, since rebinding is about who controls a name; isAllowedWebSocketOrigin
 * still wants the Origin on this exact host and port. What a browser never
 * sends is refused: userinfo, a path, %-escapes, whitespace, a comma-joined
 * list, an unbracketed or zoned IPv6, a port with a leading zero or over 65535.
 *
 * Broader than requireLocalHost on purpose: that one guards /api/whatsapp and
 * admits exactly localhost / 127.0.0.1 / [::1] on our port.
 */
export function isAllowedHost(host, { allowedHosts = [], machineName = osHostname } = {}) {
  const parsed = parseHostHeader(host);
  if (!parsed) return false;
  if (parsed.ip) return true;
  const { name } = parsed;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (machineNames(machineName).includes(name)) return true;
  return listedNames(allowedHosts).includes(name);
}

/**
 * The WebSocket Origin rule (cross-site WebSocket hijacking, DNS rebinding).
 * CORS does not cover WebSockets, so without it any page open in the user's
 * browser could connect to ws://localhost:<port>/ws/*. A browser always sends
 * Origin on an upgrade, and it must be one of:
 *
 *   - a loopback origin on `port` (http(s)://localhost | 127.0.0.1 | [::1]:<port>),
 *     whatever the Host;
 *   - this server as the request reached it, http(s)://<Host> with the same
 *     name and port, only when isAllowedHost(Host) says the name is ours. A
 *     rebound page sends a Host and an Origin that agree as well, both naming
 *     the attacker's domain, which now resolves to this machine;
 *   - one of `allowedOrigins` (an array, or a function called at most once and
 *     only when nothing cheaper matched: the tunnel's and the invite proxy's
 *     public URLs). Their host names also count as ours for the rule above.
 *
 * A request without Origin is not a browser (CLI tools, the ws package) and
 * passes; an empty, "null" or non-http Origin (sandboxed frames, file: pages,
 * extensions) is refused.
 */
export function isAllowedWebSocketOrigin(req, { port, allowedOrigins = [] } = {}) {
  const raw = req?.headers?.origin;
  if (raw === undefined) return true;
  const origin = originOf(raw);
  if (!origin) return false;
  let authorities = [];
  try { authorities = localAuthorities(port); } catch {}
  for (const authority of authorities) {
    if (origin === `http://${authority}` || origin === `https://${authority}`) return true;
  }
  let listed = null;
  const publicOrigins = () => {
    if (listed === null) {
      try { listed = typeof allowedOrigins === 'function' ? allowedOrigins() : allowedOrigins; } catch { listed = []; }
      if (!Array.isArray(listed)) listed = [];
    }
    return listed;
  };
  const host = req.headers.host;
  if (typeof host === 'string' && (origin === originOf(`http://${host}`) || origin === originOf(`https://${host}`))
    && isAllowedHost(host, { allowedHosts: publicOrigins })) return true;
  return publicOrigins().some((candidate) => candidate && originOf(candidate) === origin);
}

/** Answer a WebSocket upgrade with a plain HTTP error (default 403) and close the socket. */
export function refuseUpgrade(socket, status = 403, message = status === 403 ? 'Forbidden' : 'Bad Request') {
  if (!socket) return;
  // Node drops its own 'error' listener from an upgrade socket: without one, a
  // peer reset while the answer is written would be an uncaught exception.
  socket.on?.('error', () => { try { socket.destroy(); } catch {} });
  if (!socket.writable) { try { socket.destroy(); } catch {} return; }
  try {
    socket.once('finish', () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  } catch {
    try { socket.destroy(); } catch {}
  }
}
