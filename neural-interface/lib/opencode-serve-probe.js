// ─────────────────────────────────────────────────────────────────────────────
// Does a running OpenCode serve really require its password? Asked of the serve itself, not of its version number.
//
// A native browser context (MoreLogin) cannot have its pages' WebSockets routed, so a page there can open
// ws://127.0.0.1:<port>/api/pty/… of a local OpenCode serve: an unauthenticated serve would hand any web page a
// shell, files and sessions (lib/opencode-native-boundary.js). This probe is the evidence the boundary admits a serve
// on. Every check must pass; anything else (a timeout, a connection error, a status nobody expected, an answer that
// cannot be read) is a failure: fail closed.
//
// THE ROUTE MATRIX, and where it comes from. OpenCode 2.3.0 (Homebrew opencode-v2, /opt/homebrew/bin/opencode,
// checked 2026-11-14):
//   - its OpenAPI document, GET /openapi.json with the serve's password ("opencode HttpApi"), which lists every
//     /api route and /auth/connect/{code};
//   - its authentication middleware, read from the binary's bundled server: the password is taken from a Basic
//     Authorization header, from the query parameter `auth_token` (base64 of user:password: a page CAN set that on a
//     WebSocket URL) or from an `opencode_session_<port>` cookie signed with the password (only when the Origin's host
//     is the Host); it runs before the router (an unknown /api path answers 401) and EXEMPTS
//     /auth/connect/:code (a pairing code the route itself checks) and, when `?ticket=` is present,
//     /api/pty/:ptyID/connect, /api/experimental/persistent-pty/:ptyID/connect and /api/experimental/client-mcp
//     (the route checks the ticket). Those exemptions are probed with a ticket / a code the serve never issued.
// SENSITIVE_ROUTES below is the fixed part (sessions, shell, files, terminals, configuration, MCP, events, credentials,
// RPC); for a serve SynaBun holds the password of, every operation of its own /openapi.json is added (`surface`), so
// a route a later build adds is asked too. A build whose document cannot be read is refused: its surface is unknown.
//
// NOTHING SENT HERE CAN ACT, even on a serve that turned out to be open: GETs read; every other method goes only to
// a route with a path parameter (filled with an id no serve has: ses_synabunprobe, pty_synabunprobe, …) or a
// request body, and carries the malformed JSON body `{`, which OpenCode 2.3.0 answers 400 "Expected a valid JSON
// body" / 404 "not found" even WITH the password (checked live on every mutating route of SENSITIVE_ROUTES). An
// operation that takes neither (POST /api/vcs/init, /api/pair, /api/location/reload, /api/debug/heap-dump, …) is
// never sent: on an open serve it would run. It is covered by the `routing` check instead: an unknown path and a
// wrong method under /api must be refused too, which proves the password is asked before the router picks a route.
//
// Checks (PROBE_CHECKS order):
//   loopback        the serve's process listens only on loopback addresses (its sockets as the OS reports them, never
//                   what its command line says), on the probed port among them
//   surface         the route list: the serve's /openapi.json read with SynaBun's password (a serve without one is
//                   asked SENSITIVE_ROUTES only, and the check says so)
//   http-anonymous  every route, without credentials: 401 or 403. A 2xx that is not a web page (JSON, an event
//                   stream) is an open API; a web page under /api, a 400 / 404 (the router answered: no password was
//                   asked), a redirect or any other status is refused as unexpected. Only /api paths, /openapi.json
//                   and /auth/connect are asked: every other path is OpenCode's web app (200 text/html), which is not
//                   an authentication hole and is never read as one.
//   http-wrong-password  the same with credentials that are not the serve's: Basic, `?auth_token=`, a forged session
//                   cookie, a ticket on the ticket routes and a pairing code that was never issued: 401 or 403
//   ws-anonymous    a WebSocket upgrade without credentials, from a page's Origin, to every WebSocket route: never 101
//   ws-wrong-password  the same upgrades with each wrong credential and a forged ticket: never 101
//   routing         an unknown /api path and a wrong method on a real route, without credentials: 401 or 403
//   weak-password   (a serve SynaBun did not start) a handful of guessable passwords do not open GET /api/info
//   credentials     the password SynaBun holds for a serve it started opens /api/info (200 JSON with a version).
//                   A serve SynaBun holds no password for cannot pass, unless asked as a foreign serve.
//
// A real credential is sent twice (GET /openapi.json, GET /api/info), in a header, never in a URL, and never
// appears in a result.
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { basicAuthHeader } from './opencode-protocol.js';
import { listListenAddressesAsync } from './process-identity.js';

export const PROBE_CHECKS = Object.freeze(['loopback', 'surface', 'http-anonymous', 'http-wrong-password', 'ws-anonymous',
  'ws-wrong-password', 'routing', 'weak-password', 'credentials']);

// Ids no serve has: a mutating request that reached a route would find nothing to act on.
const PROBE_IDS = Object.freeze({ sessionID: 'ses_synabunprobe', ptyID: 'pty_synabunprobe' });
const PROBE_ID = 'synabun-auth-probe';

/**
 * The fixed part of the matrix (see the head of this file). `body`: sent with the malformed JSON body `{`;
 * `ws`: asked as a WebSocket upgrade too; `ticket`: a route OpenCode exempts from the password when `?ticket=` is
 * present, asked with a forged ticket.
 */
export const SENSITIVE_ROUTES = Object.freeze([
  { id: 'session.list', method: 'GET', path: '/api/session' },
  { id: 'session.create', method: 'POST', path: '/api/session', body: true },
  { id: 'session.prompt', method: 'POST', path: '/api/session/ses_synabunprobe/prompt', body: true },
  { id: 'session.shell', method: 'POST', path: '/api/session/ses_synabunprobe/shell', body: true },
  { id: 'shell.list', method: 'GET', path: '/api/shell' },
  { id: 'shell.create', method: 'POST', path: '/api/shell', body: true },
  { id: 'fs.list', method: 'GET', path: '/api/fs/list' },
  { id: 'fs.read', method: 'GET', path: '/api/fs/read/synabun-auth-probe' },
  { id: 'fs.find', method: 'GET', path: '/api/fs/find' },
  { id: 'fs.write', method: 'POST', path: '/api/experimental/fs/write', body: true },
  { id: 'pty.list', method: 'GET', path: '/api/pty' },
  { id: 'pty.create', method: 'POST', path: '/api/pty', body: true },
  { id: 'pty.connect', method: 'GET', path: '/api/pty/pty_synabunprobe/connect', ws: true, ticket: true },
  { id: 'persistent-pty.connect', method: 'GET', path: '/api/experimental/persistent-pty/pty_synabunprobe/connect', ws: true, ticket: true },
  { id: 'config', method: 'GET', path: '/api/config' },
  { id: 'config.patch', method: 'PATCH', path: '/api/experimental/config', body: true },
  { id: 'mcp', method: 'GET', path: '/api/mcp' },
  { id: 'mcp.put', method: 'PUT', path: '/api/experimental/mcp/synabun-probe', body: true },
  { id: 'mcp.connect', method: 'POST', path: '/api/experimental/mcp/synabun-probe/connect', body: true },
  { id: 'client-mcp', method: 'GET', path: '/api/experimental/client-mcp?name=synabun-probe', ws: true, ticket: true },
  { id: 'credential', method: 'GET', path: '/api/credential' },
  { id: 'event', method: 'GET', path: '/api/event', ws: true },
  { id: 'rpc', method: 'POST', path: '/api/rpc/synabun-probe/probe', body: true },
  { id: 'info', method: 'GET', path: '/api/info' },
  { id: 'openapi', method: 'GET', path: '/openapi.json' },
]);
// Proof that the password is asked before the router: a path no build has, and a method /api/info does not take.
export const ROUTING_PROBES = Object.freeze([
  { id: 'routing.unknown', method: 'GET', path: '/api/synabun-auth-probe' },
  { id: 'routing.method', method: 'DELETE', path: '/api/info' },
]);
// A pairing code no serve issued: /auth/connect/:code is exempt from the password and must refuse it itself.
export const PAIRING_PROBE = Object.freeze({ id: 'pairing', method: 'GET', path: '/auth/connect/synabun-auth-probe' });
// Passwords a page could guess, tried on a serve SynaBun did not start (its password is not SynaBun's to know).
export const WEAK_PASSWORDS = Object.freeze(['', 'opencode', 'password', 'admin', '1234', '123456', '12345678', 'changeme', 'secret', 'letmein']);
// The Origin a web page in the browser would send: OpenCode 2 accepts any http://localhost:* origin.
const PAGE_ORIGIN = 'http://localhost:1';
const MALFORMED_BODY = '{';
const WS_PATH = /\/connect$|^\/api\/event$|\/terminal(\/|$)|client-mcp|\/ws(\/|$)/;

export const PROBE_REQUEST_MS = 1500;
export const PROBE_TOTAL_MS = 10_000;
const PROBE_CONCURRENCY = 16;

/** Is a listening address one only this computer can reach? 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const v4 = h.startsWith('::ffff:') ? h.slice(7) : h;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  return !!m && m.slice(1).every((x) => Number(x) <= 255) && Number(m[1]) === 127;
}

/**
 * What one answer without the right credentials means: 'refused' (401 / 403: what passes), 'open' (a 2xx that is not
 * a web page, or a WebSocket accepted), 'unexpected' (a web page, a redirect, a 400 / 404 / 5xx: anything else) or
 * 'no-answer' (timeout, connection error).
 */
export function classifyAnonymousAnswer({ status, contentType = '', upgraded = false } = {}) {
  if (upgraded || status === 101) return 'open';
  if (status == null) return 'no-answer';
  if (status === 401 || status === 403) return 'refused';
  if (status >= 200 && status < 300) return /text\/html/i.test(String(contentType)) ? 'unexpected' : 'open';
  return 'unexpected';
}

/**
 * One request to the serve; resolves `{ status, contentType, upgraded, error }`, never rejects, never reads a body.
 * `body` is sent as JSON (the malformed body of a mutating probe).
 */
export function probeRequest({ port, path, method = 'GET', host = '127.0.0.1', headers = {}, upgrade = false, body = null, timeoutMs = PROBE_REQUEST_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let req;
    try {
      const base = upgrade
        ? { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), origin: PAGE_ORIGIN }
        : { accept: 'application/json', origin: PAGE_ORIGIN };
      const all = { ...base, ...headers };
      if (body != null) { all['content-type'] = 'application/json'; all['content-length'] = String(Buffer.byteLength(body)); }
      req = httpRequest({ hostname: host, port, path, method: upgrade ? 'GET' : method, agent: false, headers: all });
    } catch (error) { done({ status: null, contentType: '', upgraded: false, error: String(error?.message || error) }); return; }
    req.on('response', (res) => {
      const value = { status: res.statusCode ?? null, contentType: String(res.headers['content-type'] || ''), upgraded: false, error: null };
      res.destroy();
      req.destroy();
      done(value);
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); done({ status: 101, contentType: '', upgraded: true, error: null }); });
    req.on('error', (error) => done({ status: null, contentType: '', upgraded: false, error: String(error?.code || error?.message || error) }));
    req.setTimeout(timeoutMs, () => { req.destroy(); done({ status: null, contentType: '', upgraded: false, error: `no answer within ${timeoutMs} ms` }); });
    req.end(body ?? undefined);
  });
}

/** An OpenAPI path template filled with the probe's ids: {sessionID} → ses_synabunprobe, `*` → synabun-auth-probe. */
export function fillProbePath(template) {
  return String(template).replace(/\{([^}/]+)\}/g, (whole, name) => PROBE_IDS[name] || PROBE_ID).replace(/\*/g, PROBE_ID);
}

/**
 * The operations of a serve's OpenAPI document as probe routes: `{ routes, skipped }`, or null when the document is
 * not one (no `paths` object, or no operation in it). GETs are asked (and as a WebSocket when the path is one of
 * OpenCode's socket paths); another method only with a path parameter or a request body (with the malformed body);
 * the rest are `skipped` (they could act: the routing check covers them).
 */
export function routesFromOpenApi(doc) {
  const paths = doc && typeof doc === 'object' && doc.paths && typeof doc.paths === 'object' && !Array.isArray(doc.paths) ? doc.paths : null;
  if (!paths) return null;
  const routes = [];
  const skipped = [];
  for (const [template, item] of Object.entries(paths)) {
    if (!template.startsWith('/') || !item || typeof item !== 'object') continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const path = fillProbePath(template);
      if (method === 'get') { routes.push({ id: `${method} ${template}`, method: 'GET', path, ...(WS_PATH.test(template) ? { ws: true } : {}) }); continue; }
      const inputs = /\{[^}]+\}|\*/.test(template) || !!op.requestBody;
      if (inputs) routes.push({ id: `${method} ${template}`, method: method.toUpperCase(), path, body: true });
      else skipped.push({ method: method.toUpperCase(), path: template });
    }
  }
  return routes.length ? { routes, skipped } : null;
}

const routeKey = (r) => `${r.method} ${r.path}`;
function mergeRoutes(...lists) {
  const seen = new Map();
  for (const list of lists) for (const r of list) {
    const k = routeKey(r);
    const prev = seen.get(k);
    seen.set(k, prev ? { ...prev, ws: prev.ws || r.ws, ticket: prev.ticket || r.ticket, body: prev.body || r.body } : r);
  }
  return [...seen.values()];
}

const withQuery = (path, query) => (query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path);

/** The wrong credentials a page could present, each in a way OpenCode 2.3.0 reads a password. */
function wrongCredentials(port) {
  const fake = `synabun-probe-${randomBytes(12).toString('base64url')}`;
  const cookieValue = `${Math.floor(Date.now() / 1000) + 3600}.${randomBytes(32).toString('base64url')}`;
  return [
    { id: 'basic', label: 'a wrong password (Basic)', headers: { authorization: basicAuthHeader(fake) } },
    { id: 'auth_token', label: 'a wrong password (?auth_token=)', query: `auth_token=${encodeURIComponent(Buffer.from(`opencode:${fake}`).toString('base64'))}` },
    { id: 'cookie', label: 'a forged session cookie', headers: { cookie: `opencode_session_${port}=${cookieValue}; opencode_session=${cookieValue}`, origin: `http://127.0.0.1:${port}` } },
  ];
}

const describeAnswer = (a) => (a.upgraded ? 'accepted the WebSocket (101)' : a.status == null ? `did not answer (${a.error || 'no answer'})`
  : `answered ${a.status}${a.contentType ? ` ${a.contentType.split(';')[0].trim()}` : ''}`);

// A check over many answers: the first that is not a refusal is the failure (an open answer before an unexpected
// one, so the sentence names the worst). `exposed`: an answer proved the serve open (a page could use it).
function judge(id, answers) {
  const verdicts = answers.map((a) => ({ ...a, verdict: classifyAnonymousAnswer(a.answer) }));
  const bad = verdicts.find((a) => a.verdict === 'open') || verdicts.find((a) => a.verdict === 'unexpected') || verdicts.find((a) => a.verdict === 'no-answer');
  if (!bad) return { id, ok: true, detail: `${answers.length} request${answers.length === 1 ? '' : 's'} refused (401/403)` };
  const what = bad.upgrade ? `a WebSocket upgrade to ${bad.path.split('?')[0]}` : `${bad.method} ${bad.path.split('?')[0]}`;
  const how = bad.label ? ` with ${bad.label}` : '';
  const why = bad.verdict === 'open' ? (id === 'weak-password' ? ': a web page could guess its password' : `${bad.label ? '' : ' without credentials'}: this serve does not require its password`)
    : bad.verdict === 'no-answer' ? '' : ' (expected 401 or 403)';
  // 'unexpected' too: a 400 / 404 means a route ran without the password being asked.
  const exposed = bad.verdict === 'open' || (bad.verdict === 'unexpected' && bad.answer.status != null && !/text\/html/i.test(bad.answer.contentType || ''));
  return { id, ok: false, verdict: bad.verdict, exposed, transient: bad.verdict === 'no-answer', detail: `${what}${how} ${describeAnswer(bad.answer)}${why}` };
}

// Run `fn` over `items`, at most `limit` at a time, until `stop()` says so (the probe's deadline passed, or the serve
// stopped answering): what was not asked then is left out (the probe has failed by then).
async function pool(items, limit, fn, stop = () => false) {
  const out = [];
  let next = 0;
  const worker = async () => { while (next < items.length && !stop()) { const k = next++; out[k] = await fn(items[k]); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out.filter(Boolean);
}

async function loopbackCheck({ pid, port, listenAddresses }) {
  if (!(Number.isInteger(pid) && pid > 0)) return { id: 'loopback', ok: false, detail: 'the process that answers on the port is not known, so its sockets cannot be read' };
  let addresses;
  try { addresses = await listenAddresses(pid); } catch { addresses = null; }
  if (!Array.isArray(addresses)) return { id: 'loopback', ok: false, transient: true, detail: `the sockets pid ${pid} listens on could not be read` };
  if (!addresses.length) return { id: 'loopback', ok: false, transient: true, detail: `pid ${pid} listens on no TCP socket` };
  const outside = addresses.filter((a) => !isLoopbackHost(a.host));
  if (outside.length) {
    const list = outside.map((a) => `${a.host === '*' ? '*' : a.host.includes(':') ? `[${a.host}]` : a.host}:${a.port}`).join(', ');
    return { id: 'loopback', ok: false, exposed: true, detail: `pid ${pid} listens on ${list}, reachable from other computers (only 127.0.0.1 or ::1 is allowed)` };
  }
  if (!addresses.some((a) => a.port === Number(port))) return { id: 'loopback', ok: false, detail: `pid ${pid} does not listen on port ${port}` };
  return { id: 'loopback', ok: true, detail: `pid ${pid} listens on loopback only` };
}

// GET with SynaBun's password: `{ status, type, json }` or `{ error }`. Never rejects.
async function authorizedGet(fetchImpl, url, password, timeoutMs) {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', authorization: basicAuthHeader(password) }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const type = String(res.headers?.get?.('content-type') || '');
    if (res.status !== 200 || !/application\/json/i.test(type)) { await res.body?.cancel?.().catch?.(() => {}); return { status: res.status, type, json: null }; }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, type, json };
  } catch (error) {
    return { error: String(error?.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : error?.message || error) };
  }
}

async function surfaceCheck({ port, password, host, timeoutMs, fetchImpl, foreign }) {
  if (!password) {
    return foreign
      ? { id: 'surface', ok: true, skipped: true, routes: [], detail: `no password held: the ${SENSITIVE_ROUTES.length} routes SynaBun knows (OpenCode 2.3.0's) are asked` }
      : { id: 'surface', ok: false, routes: [], detail: 'SynaBun holds no password for this serve, so its route list cannot be read' };
  }
  const got = await authorizedGet(fetchImpl, `http://${host}:${port}/openapi.json`, password, timeoutMs);
  if (got.error) return { id: 'surface', ok: false, transient: true, routes: [], detail: `GET /openapi.json with SynaBun's password failed: ${got.error}` };
  const parsed = got.json ? routesFromOpenApi(got.json) : null;
  if (!parsed) {
    return { id: 'surface', ok: false, routes: [], detail: `GET /openapi.json with SynaBun's password answered ${got.status}${got.type ? ` ${got.type.split(';')[0]}` : ''} without a route list: this build's API cannot be established` };
  }
  return { id: 'surface', ok: true, routes: parsed.routes, notSent: parsed.skipped,
    detail: `${parsed.routes.length} operations from the serve's /openapi.json${parsed.skipped.length ? ` (${parsed.skipped.length} that take no input are not sent: ${parsed.skipped.map((s) => `${s.method} ${s.path}`).join(', ')})` : ''}` };
}

async function credentialsCheck({ port, password, host, timeoutMs, fetchImpl }) {
  if (!password) return { id: 'credentials', ok: false, detail: 'SynaBun holds no password for this serve (it did not start it)' };
  const got = await authorizedGet(fetchImpl, `http://${host}:${port}/api/info`, password, timeoutMs);
  if (got.error) return { id: 'credentials', ok: false, transient: true, detail: `GET /api/info with SynaBun's password failed: ${got.error}` };
  if (got.status !== 200 || !/application\/json/i.test(got.type || '')) {
    return { id: 'credentials', ok: false, detail: `GET /api/info with SynaBun's password answered ${got.status}${got.type ? ` ${got.type.split(';')[0]}` : ''} (expected 200 JSON)` };
  }
  if (!got.json || typeof got.json.version !== 'string') return { id: 'credentials', ok: false, detail: 'GET /api/info with SynaBun\'s password did not answer OpenCode 2\'s info (no version)' };
  return { id: 'credentials', ok: true, detail: `SynaBun's password is accepted (OpenCode ${got.json.version})`, version: got.json.version };
}

/**
 * Probe one serve. `{ ok, failed, checks, version, detail, transient, exposed, matrix }`: `ok` only when every check
 * passed; `failed` the id of the first check that did not (PROBE_CHECKS order), `detail` its sentence; `transient`
 * when that failure was a missing answer (a timeout, a socket that could not be read), which a later attempt may ask
 * again; `exposed` when a failed check proved the serve reachable without its password (open answers, a socket
 * other computers reach). `foreign`: a serve SynaBun did not start (no password): no credential or surface check,
 * the weak-password check instead. Never throws. Bounded: `timeoutMs` per request, `totalMs` for the whole probe.
 * @param {{ port: number, pid?: number|null, password?: string|null, host?: string, timeoutMs?: number, totalMs?: number,
 *   foreign?: boolean, requireCredentials?: boolean, listenAddresses?: (pid: number) => Promise<Array<{host: string, port: number}>|null>,
 *   request?: typeof probeRequest, fetchImpl?: typeof fetch }} o
 */
export async function probeOpencodeServe({ port, pid = null, password = null, host = '127.0.0.1', timeoutMs = PROBE_REQUEST_MS, totalMs = PROBE_TOTAL_MS,
  foreign = false, requireCredentials = !foreign, listenAddresses = listListenAddressesAsync, request = probeRequest, fetchImpl = globalThis.fetch } = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) {
    return { ok: false, failed: 'loopback', transient: false, exposed: false, version: null, detail: 'no valid port to probe', checks: [{ id: 'loopback', ok: false, detail: 'no valid port to probe' }], matrix: null };
  }
  const ask = (route, { label = null, headers = {}, query = null, upgrade = false } = {}) => {
    const path = withQuery(route.path, query);
    return request({ port: p, host, path, method: route.method, headers, upgrade, body: !upgrade && route.body ? MALFORMED_BODY : null, timeoutMs })
      .then((answer) => ({ path, method: upgrade ? 'GET' : route.method, label, upgrade, answer }));
  };
  let cancelled = false;
  const work = (async () => {
    const [loopback, surface] = await Promise.all([
      loopbackCheck({ pid: Number(pid) || null, port: p, listenAddresses }),
      surfaceCheck({ port: p, password, host, timeoutMs, fetchImpl, foreign }),
    ]);
    const routes = mergeRoutes(SENSITIVE_ROUTES, surface.routes || []);
    const wsRoutes = routes.filter((r) => r.ws);
    const fixed = new Set(SENSITIVE_ROUTES.map(routeKey));
    const wrong = wrongCredentials(p);
    const forgedTicket = `ticket=${randomBytes(18).toString('base64url')}`;
    // Every request of the matrix, tagged with the check it answers.
    const plan = [];
    for (const r of routes) plan.push(['http-anonymous', r, {}]);
    for (const r of routes) for (const w of fixed.has(routeKey(r)) ? wrong : wrong.slice(0, 1)) plan.push(['http-wrong-password', r, w]);
    for (const r of routes.filter((x) => x.ticket)) plan.push(['http-wrong-password', r, { label: 'a ticket the serve never issued', query: forgedTicket }]);
    plan.push(['http-wrong-password', PAIRING_PROBE, { label: 'a pairing code the serve never issued' }]);
    for (const r of wsRoutes) plan.push(['ws-anonymous', r, { upgrade: true }]);
    for (const r of wsRoutes) for (const w of wrong) plan.push(['ws-wrong-password', r, { ...w, upgrade: true }]);
    for (const r of wsRoutes.filter((x) => x.ticket)) plan.push(['ws-wrong-password', r, { label: 'a ticket the serve never issued', query: forgedTicket, upgrade: true }]);
    for (const r of ROUTING_PROBES) plan.push(['routing', r, {}]);
    if (foreign) for (const guess of WEAK_PASSWORDS) plan.push(['weak-password', SENSITIVE_ROUTES.find((r) => r.id === 'info'), { label: guess ? `the guessable password "${guess}"` : 'an empty password', headers: { authorization: basicAuthHeader(guess) } }]);
    let silent = 0;
    const answers = await pool(plan, PROBE_CONCURRENCY, ([check, route, opts]) => ask(route, opts).then((a) => {
      if (a.answer.status == null && !a.answer.upgraded) silent++;
      return { check, ...a };
    }), () => cancelled || silent >= PROBE_CONCURRENCY);
    const of = (id) => answers.filter((a) => a.check === id);
    const checks = [loopback, surface];
    for (const id of ['http-anonymous', 'http-wrong-password', 'ws-anonymous', 'ws-wrong-password', 'routing']) checks.push(judge(id, of(id)));
    checks.push(foreign ? judge('weak-password', of('weak-password')) : { id: 'weak-password', ok: true, skipped: true, detail: 'not asked (SynaBun made this serve\'s password)' });
    checks.push(requireCredentials || password ? await credentialsCheck({ port: p, password, host, timeoutMs, fetchImpl }) : { id: 'credentials', ok: true, skipped: true, detail: 'not asked (no password held)' });
    return { checks, matrix: { source: surface.ok && !surface.skipped ? 'openapi' : 'fixed', routes: routes.length, requests: plan.length, notSent: Array.isArray(surface.notSent) ? surface.notSent.map((s) => `${s.method} ${s.path}`) : [] } };
  })();
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), totalMs); timer.unref?.(); });
  let outcome;
  try { outcome = await Promise.race([work, late]); } catch (error) {
    outcome = { checks: [{ id: 'loopback', ok: false, detail: `the probe failed: ${String(error?.message || error)}` }], matrix: null };
  } finally { clearTimeout(timer); cancelled = true; }
  if (!outcome) {
    const detail = `the probe did not finish within ${totalMs} ms`;
    return { ok: false, failed: 'loopback', transient: true, exposed: false, version: null, detail, checks: PROBE_CHECKS.map((id) => ({ id, ok: false, detail })), matrix: null };
  }
  const checks = PROBE_CHECKS.map((id) => outcome.checks.find((c) => c.id === id)).filter(Boolean);
  // The failure named is one that proved the serve open when there is one (a page could use it), else the first.
  const first = checks.find((c) => !c.ok && c.exposed) || checks.find((c) => !c.ok) || null;
  return {
    ok: !first,
    failed: first?.id || null,
    transient: !!first?.transient,
    exposed: checks.some((c) => !c.ok && c.exposed),
    version: checks.find((c) => c.id === 'credentials')?.version || null,
    detail: first ? first.detail : 'every check passed',
    checks: checks.map(({ id, ok, detail, skipped }) => ({ id, ok, detail, ...(skipped ? { skipped: true } : {}) })),
    matrix: outcome.matrix,
  };
}

// Mach-O (both byte orders, 32/64-bit, universal) and ELF: a file the kernel runs itself. A script (#!) is run by an
// interpreter, whose process is not the file: what listens is checked another way (lib/opencode-native-boundary.js).
const NATIVE_MAGIC = [[0xcf, 0xfa, 0xed, 0xfe], [0xce, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xcf], [0xfe, 0xed, 0xfa, 0xce], [0xca, 0xfe, 0xba, 0xbe], [0x7f, 0x45, 0x4c, 0x46], [0x4d, 0x5a]];
function readMagic(path) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    return buf.subarray(0, n);
  } catch { return null; } finally { if (fd != null) { try { closeSync(fd); } catch { /* closed */ } } }
}

/**
 * The file a serve runs, as the file system has it now: `{ path, realpath, size, mtimeMs, ino, dev, native }`, or null
 * when it cannot be read. A Homebrew update changes the real path (a new Cellar folder) and the times; an update in
 * place changes the times and the size: any of them is a different binary, whose serves are probed again. `native`:
 * the file is an executable the kernel runs itself (Mach-O, ELF, PE), not a script.
 */
export function binaryIdentity(path, { realpath = realpathSync, stat = statSync, magic = readMagic } = {}) {
  if (!path || typeof path !== 'string') return null;
  try {
    const real = realpath(path);
    const st = stat(real);
    if (!st.isFile()) return null;
    const head = magic(real);
    const native = !!head && NATIVE_MAGIC.some((m) => m.every((b, i) => head[i] === b));
    return { path, realpath: real, size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino) || 0, dev: Number(st.dev) || 0, native };
  } catch { return null; }
}

/** The key of a binary and its version: what a verdict about a build is filed under. null without both. */
export function binaryKey(identity, version) {
  if (!identity || !version) return null;
  return [identity.realpath, identity.size, identity.mtimeMs, identity.ino, identity.dev, String(version).trim()].join('|');
}
