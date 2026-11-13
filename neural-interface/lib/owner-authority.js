// ═══════════════════════════════════════════
// SynaBun — the one decision for the owner's routes: who may act with the owner's powers
// ═══════════════════════════════════════════
//
// Many of SynaBun's routes act with the owner's own powers without asking for the page secret: they were guarded
// by the Host, the Origin and the guest rules only (lib/http-guards.js ownerRouteGuard, lib/request-gate.js). A
// page of the app passes those by being a page of the app — and so did SynaBun's automation browser, which a
// sandboxed worker drives with its sanctioned browser tools: it could open the File Explorer and write anywhere,
// save in the code editor, run git, start the tunnel, make an invite, change Settings, open a terminal tab or an
// agent panel and type into it — each a way out of the worker's sandbox. A local relay (a proxy, ssh -L, any program
// that listens and calls SynaBun) was the same way out for a worker that cannot reach SynaBun's port itself.
//
// This module is the one decision for all of them, made on what the request cannot choose: the automation
// browser's marker (lib/page-session.js) and the process at the other end of the connection (lib/peer-identity.js,
// whose verdict the peer middleware keeps on the request). It covers:
//   • every request to /api that is not a GET / HEAD / OPTIONS (default-deny: a route added later is covered), but
//     for FEATURE_OPEN_PREFIXES — the hooks' own routes and the feature data the agents' MCP tools write too
//     (memories, cards, the whiteboard…), where a refusal would stop the owner's integrations and buy nothing;
//   • the two reads that hand out a secret: GET /api/mcp-key (the whole MCP key) and GET /api/mcp/env/<name>?reveal=1;
//   • the owner's own reads (OWNER_READ_PREFIXES: what a guest is refused, and git), for the peers that are never the
//     owner — the code editor's and File Explorer's roots include SynaBun's data home, whose secrets the worker
//     sandbox keeps from a worker; an agent's tree reads them as before;
//   • the owner's sockets: a terminal, the Claude / Codex / OpenCode panels, the Assistant, the browser panel —
//     and /ws/sync, which stays open (the app's pages need it to draw) but read-only.
//
// Refused, whatever the request says (headers, pins, cookies, Origin): a request with the automation browser's
// marker; a peer that is SynaBun's automation browser or any browser started for automation, a relay (named, or a
// program that listens), another SynaBun server, a remote login (sshd), or a client that left before it was
// identified. Refused too, unless it is an agent's own call: an AI agent's process tree, and SynaBun's own MCP server
// over HTTP (mcp-server/dist/http.js: it listens, so it would read as a relay; lib/peer-identity.js knows it by its
// main script inside this install, and its tools call with the stdio MCP server's pin). An agent's own call is
// one that says who it is — an agent pin (X-Synabun-Terminal / -Role / -Assistant / -Desktop-Grant) or a brain
// credential that survived the peer check — and stays on its route's rules (the MCP git tool, desktop, loop and
// browser tools; the brain; the Assistant's route gate, asked with the session's pin by the OpenCode plugin and the
// Codex hook, which checks the session's own token), as do the few routes agents call without a pin
// (AGENT_OPEN_PREFIXES: the server's stop and restart the CLI asks, the MCP server's tab release, the loops and
// schedules the /synabun skill creates with curl, and OpenCode's requests for a Sabiá model through SynaBun).
//
// Never refused by this module: the owner's own browser and the SynaBun app (the peer lookup allows them), this
// server itself, a request from outside (the tunnel, the invite proxy: the guest rules decide those, and the
// tunnel's own process would otherwise read as a relay), and wherever the lookup does not run (another platform than
// macOS, or SYNABUN_PEER_IDENTITY=off: the rules from before apply, so Windows and Linux work as they always did).
//
// A lookup that failed on macOS (lib/peer-identity.js: netstat or ps missing, denied, slow past the cap, unreadable)
// proves nothing about who is asking, so it holds none of the owner's powers: every request this module covers —
// the owner's writes (an agent's pinned call and an agent-open route too: a relay can send a pin), the owner's reads,
// the secret reads, the owner's sockets — is answered 503 PEER_UNAVAILABLE (`retryable` when the lookup timed out,
// with Retry-After), and /ws/sync stays open, read-only. The app's pages and every other read still load. Two writes
// keep the rules from before even then (DEGRADED_OPEN_PATHS): the server's restart and stop, which take nothing from
// the request, are what the desktop app's quit, the uninstaller and the owner's way out (SYNABUN_PEER_IDENTITY=off,
// then a restart) need, and an agent's tree may call them anyway. A request it should have looked up and has no
// verdict for (`required`: a server whose lookup runs) is taken as a failed lookup, never as the rules from before.

import { readFileSync } from 'node:fs';
import { AGENT_HEADERS, sendGuardError } from './http-guards.js';
import { BRAIN_HEADER, PEER_VERDICT, failedPeerVerdict, peerAuthority } from './peer-identity.js';
import { ADMIN_ONLY_PREFIXES, routedForms } from './request-gate.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Writes left open to every caller the rules before allowed: the hooks' own routes, and the feature data the
 *  agents' MCP tools write too. A path counts as open only when every reading of it is open. */
export const FEATURE_OPEN_PREFIXES = Object.freeze([
  '/api/hook-', '/api/greeting', '/api/sessions',
  '/api/memory', '/api/memories', '/api/memory-maintenance', '/api/categories', '/api/trash', '/api/search',
  '/api/cards', '/api/whiteboard', '/api/images', '/api/games',
  '/api/cache', '/api/fetch-markdown', '/api/last-session', '/api/health',
  '/api/ui-blobs',
]);
/** Paths under an open prefix that are not open: the code editor's copies of unsaved buffers (file content). */
export const NEVER_OPEN_PREFIXES = Object.freeze(['/api/ui-blobs/editor-backups']);
/** Routes agents call without a pin: an agent's tree may call them as it did (the other peers are still refused).
 *  `/api/maritaca/opencode/v1/chat/completions` is OpenCode's own request for a Sabiá model (lib/maritaca/opencode-proxy.js,
 *  the base URL of the provider block SynaBun writes): OpenCode's serve is an agent's tree and sends no pin, and the
 *  route itself takes only a caller that presents the saved Maritaca key. That one path only, nothing else of /api/maritaca. */
export const AGENT_OPEN_PREFIXES = Object.freeze(['/api/server/', '/api/browser/release', '/api/loop', '/api/schedules', '/api/schedule-groups', '/api/maritaca/opencode/v1/chat/completions']);
/** The peers whose own calls (pinned, or on an agent-open route) keep their route's rules: an AI agent's process tree,
 *  and SynaBun's own MCP server over HTTP (lib/peer-identity.js isSynabunMcpServer), as the stdio one in an agent's tree. */
export const AGENT_CALL_KINDS = Object.freeze(['agent', 'synabun-mcp']);
/**
 * The owner's own reads: what a guest is refused (lib/request-gate.js ADMIN_ONLY_PREFIXES — the owner's settings,
 * the code editor's and the File Explorer's file contents, whose roots include SynaBun's data home with its secrets,
 * the runs' transcripts, MCP and plugin configuration…) and git. Refused to the automation browser, relays, other
 * SynaBun servers, remote logins and closed clients (the sandbox keeps a worker out of the data home; these reads
 * would hand it over through a browser or a relay). An agent's tree reads them as before (it is not sandboxed when
 * it can reach SynaBun at all, and the CLI and the MCP tools read some of them). The hooks' own routes are not here.
 */
export const OWNER_READ_PREFIXES = Object.freeze([...ADMIN_ONLY_PREFIXES.filter((prefix) => prefix !== '/api/hook-'), '/api/git']);
/**
 * The writes a failed lookup does not refuse (the rules from before): the server's restart and stop. They take nothing
 * from the request, an agent's tree may call them anyway, and the desktop app's quit, the uninstaller and the in-app
 * Restart (the way out of a degraded server: SYNABUN_PEER_IDENTITY=off, then a restart) depend on them. Whole paths.
 */
export const DEGRADED_OPEN_PATHS = Object.freeze(['/api/server/restart', '/api/server/shutdown']);
/** The owner's sockets: a terminal, the agent panels, the Assistant, the browser panel. */
export const OWNER_SOCKET_PREFIXES = Object.freeze(['/ws/terminal/', '/ws/claude-skin', '/ws/codex-skin', '/ws/opencode-v2', '/ws/antigravity', '/ws/maritaca', '/ws/assistant/', '/ws/browser/']);
/** Sockets that stay open for the app's pages to draw, read-only for a peer the owner's powers are refused to. */
export const READ_ONLY_SOCKET_PATHS = Object.freeze(['/ws/sync']);

/** A path form under a prefix: a prefix ending in "/" or "-" is a plain prefix, any other is a whole segment. */
function under(form, prefix) {
  if (prefix.endsWith('/') || prefix.endsWith('-')) return form.startsWith(prefix);
  return form === prefix || form.startsWith(`${prefix}/`);
}

// ── A proxy between the owner's browser and SynaBun ──────────────────────────
// A relay is refused because it hides who asked: through a system proxy, ssh -D or a proxy extension, the owner's own
// browser reads as the relay. Browsers normally send localhost and 127.0.0.1 straight past a system proxy, so this
// takes a browser told to proxy them (an extension, a PAC file, Firefox's localhost setting) or SynaBun opened by a
// name or address the bypass list lacks. The refusal then says what to do, in the request's language (Accept-Language:
// the i18n files' `ownerAuthority` strings). A relay is never trusted instead, not even one whose parents lead back to
// the owner's browser: who its client is cannot be seen from SynaBun, and a guarded worker's sandbox keeps the system
// proxy reachable for the worker's internet, so its requests would arrive from that same relay.

/** The refusal kinds that mean "something carries this request for someone else". */
export const PROXY_REFUSAL_KINDS = Object.freeze(['relay', 'listener']);
const COPY_LOCALES = Object.freeze(['en', 'pt-BR']);
let ownerCopies = null;
/** The `ownerAuthority` strings of every locale (read once, when a refusal first needs them). */
function ownerCopy(locale) {
  if (!ownerCopies) {
    ownerCopies = {};
    for (const code of COPY_LOCALES) {
      try { ownerCopies[code] = JSON.parse(readFileSync(new URL(`../i18n/${code}.json`, import.meta.url), 'utf8'))?.ownerAuthority || {}; } catch { ownerCopies[code] = {}; }
    }
  }
  return { ...(ownerCopies.en || {}), ...(ownerCopies[locale] || {}) };
}
/** The request's language among the i18n files' (pt-* → pt-BR), by the Accept-Language preference order; else en. */
export function requestLocale(req) {
  const header = String(req?.headers?.['accept-language'] || '');
  const ranked = header.split(',').map((part, index) => {
    const [tag, ...params] = part.trim().split(';');
    const q = Number(params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean) ?? 1);
    return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0, index };
  }).filter((x) => x.tag && x.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    if (tag === 'pt' || tag.startsWith('pt-')) return 'pt-BR';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}
/** What to do when the owner's browser reaches SynaBun through a proxy (`ownerAuthority.proxyRefused`), filled in. */
export function proxyRefusalText(req, refuse) {
  const template = ownerCopy(requestLocale(req)).proxyRefused;
  const params = { name: String(refuse?.name || 'a proxy').slice(0, 64), pid: String(refuse?.pid ?? '?') };
  if (typeof template !== 'string' || !template) return `Your browser reaches SynaBun through ${params.name} (pid ${params.pid}), a proxy or relay, so SynaBun refused this: add localhost and 127.0.0.1 to the proxy's bypass list, or turn the proxy off for SynaBun, then reload.`;
  return template.replace(/\{(\w+)\}/g, (whole, key) => (params[key] != null ? params[key] : whole));
}

// ── A lookup that failed (macOS): 503 PEER_UNAVAILABLE ───────────────────────

/** The code of every answer to a request whose peer could not be identified (lib/peer-identity.js, macOS). */
export const PEER_UNAVAILABLE = 'PEER_UNAVAILABLE';
/** Retry-After for it: soon after a timeout or a busy moment, later for a lookup that cannot run at all. */
export function retryAfterSeconds(down) { return down?.retryable === true ? 2 : 30; }
/** Why SynaBun did not act as the owner, and what to do (`ownerAuthority.peerUnavailable`), in the request's language. */
export function peerUnavailableText(req, down) {
  const template = ownerCopy(requestLocale(req)).peerUnavailable;
  const params = { reason: String(down?.reason || 'the lookup failed').slice(0, 160) };
  if (typeof template !== 'string' || !template) return `SynaBun could not check which program sent this (${params.reason}), so it refused to act as the owner. Reload the page to try again.`;
  return template.replace(/\{(\w+)\}/g, (whole, key) => (params[key] != null ? params[key] : whole));
}
/** The answer's body: { ok: false, code: 'PEER_UNAVAILABLE', error, retryable, reason }. */
export function peerUnavailableBody(req, down) {
  return { ok: false, code: PEER_UNAVAILABLE, error: peerUnavailableText(req, down), retryable: down?.retryable === true, reason: String(down?.reason || 'the lookup failed') };
}
/** Answer 503 PEER_UNAVAILABLE (never cached, Retry-After). Used by the owner gate, the page secret and the Assistant API. */
export function sendPeerUnavailable(res, req, down) {
  try { res.setHeader?.('Retry-After', String(retryAfterSeconds(down))); res.setHeader?.('Cache-Control', 'no-store'); } catch { /* headers already sent */ }
  return res.status(503).json(peerUnavailableBody(req, down));
}

/** Does a request say it is an agent's own call (a pin, or a brain credential that survived the peer check)? */
export function isAgentCall(req) {
  const h = req?.headers || {};
  return AGENT_HEADERS.some((name) => h[name] !== undefined) || typeof h[BRAIN_HEADER] === 'string';
}

/**
 * Where an HTTP request stands: `gated` (one of the owner's writes, one of the owner's reads, or a secret read),
 * `agentOpen` (an agent's tree may call it without a pin: every owner's read but the secret ones, and the
 * AGENT_OPEN_PREFIXES writes) and `degradedOpen` (a failed lookup does not refuse it: DEGRADED_OPEN_PATHS, every
 * reading of the path one of them). A path with no safe reading is gated.
 */
export function restScope(req) {
  const method = String(req?.method || 'GET').toUpperCase();
  const forms = routedForms(String(req?.path ?? req?.url ?? ''));
  if (!forms) return { gated: !SAFE_METHODS.has(method), agentOpen: false, degradedOpen: false, reason: 'no safe reading of the path' };
  if (SAFE_METHODS.has(method)) {
    if (method === 'OPTIONS') return { gated: false, agentOpen: false, degradedOpen: false };
    const reveal = String(req?.query?.reveal || '') === '1';
    if (forms.some((form) => form === '/api/mcp-key' || (reveal && form.startsWith('/api/mcp/env/')))) {
      return { gated: true, agentOpen: false, degradedOpen: false, reason: 'a read that hands out a secret' };
    }
    // (ADMIN_ONLY_PREFIXES are plain prefixes, as lib/request-gate.js reads them)
    const ownerRead = forms.some((form) => OWNER_READ_PREFIXES.some((prefix) => form.startsWith(prefix)));
    return { gated: ownerRead, agentOpen: true, degradedOpen: false, reason: ownerRead ? 'one of the owner\'s reads' : null };
  }
  if (!forms.some((form) => under(form, '/api'))) return { gated: false, agentOpen: false, degradedOpen: false };
  const open = (form) => FEATURE_OPEN_PREFIXES.some((prefix) => under(form, prefix)) && !NEVER_OPEN_PREFIXES.some((prefix) => under(form, prefix));
  if (forms.every(open)) return { gated: false, agentOpen: false, degradedOpen: false };
  return {
    gated: true,
    agentOpen: forms.every((form) => AGENT_OPEN_PREFIXES.some((prefix) => under(form, prefix))),
    degradedOpen: forms.every((form) => DEGRADED_OPEN_PATHS.includes(form)),
    reason: 'one of the owner\'s writes',
  };
}

/** Where a socket stands: `owner` (refused to the peers below) or `readOnly` (open, read-only for them). */
export function socketScope(pathname) {
  const p = String(pathname || '');
  if (OWNER_SOCKET_PREFIXES.some((prefix) => (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix))) return { owner: true, readOnly: false };
  if (READ_ONLY_SOCKET_PATHS.includes(p)) return { owner: false, readOnly: true };
  return { owner: false, readOnly: false };
}

/**
 * The decision for one request whose peer verdict is on it (or not: then only the marker counts, unless `required`).
 * @param {object} req
 * @param {{ agentOpen?: boolean, degradedOpen?: boolean, required?: boolean, fromWorkerBrowser?: (req) => boolean, automationBrowserAllowed?: boolean }} o
 *   `required`: the lookup runs on this server (macOS, not off), so a covered request without a verdict was never
 *   identified and is taken as a failed lookup; `degradedOpen`: a failed lookup leaves this one to the rules from before;
 *   `automationBrowserAllowed`: the owner's setting is on, so the automation browser (marker or peer) is not refused
 * @returns {{ status: 403|503, code: string, error: string, hint?: string, peer?: object, retryable?: boolean, reason?: string } | null}
 *   `hint: 'proxy'` (with the relay's kind, pid and name) when the peer carries requests for others: `error` then says
 *   what to do, in the request's language; status 503 with code PEER_UNAVAILABLE when the peer could not be identified
 */
export function ownerRefusal(req, { agentOpen = false, degradedOpen = false, required = false, fromWorkerBrowser = () => false, automationBrowserAllowed = false } = {}) {
  // The owner's setting "Let the automation browser act as owner" (lib/automation-browser-owner-access.js): while
  // on, that browser's marker and its peer kind are not refusals. Nothing else is granted by it.
  const granted = automationBrowserAllowed === true;
  let marked = false;
  try { marked = !!fromWorkerBrowser(req); } catch { marked = false; }
  if (marked && !granted) return { status: 403, code: 'WORKER_BROWSER', error: 'SynaBun\'s automation browser cannot act as the owner: it reads SynaBun\'s pages, clicks and screenshots; the owner\'s own settings, files and actions are the owner\'s, from the owner\'s browser or the app.' };
  const verdict = req?.[PEER_VERDICT];
  const auth = verdict == null && required ? peerAuthority(failedPeerVerdict('the request was not identified')) : peerAuthority(verdict);
  if (auth.decision === 'before' || auth.decision === 'allowed') return null;
  if (granted && auth.decision === 'refused' && auth.kind === 'automation-browser') return null;
  if (auth.decision === 'unavailable') {
    if (degradedOpen) return null; // the server's restart and stop: the rules from before (DEGRADED_OPEN_PATHS)
    return { status: 503, code: PEER_UNAVAILABLE, error: peerUnavailableText(req, auth), retryable: auth.retryable, reason: auth.reason };
  }
  if (auth.gone) return { status: 403, code: 'PEER_REFUSED', error: `This is the owner's, and ${auth.why}.` };
  if (AGENT_CALL_KINDS.includes(auth.kind) && (agentOpen || isAgentCall(req))) return null; // an agent's own call: its route's rules
  if (PROXY_REFUSAL_KINDS.includes(auth.kind)) {
    return { status: 403, code: 'PEER_REFUSED', error: proxyRefusalText(req, auth), hint: 'proxy', peer: { kind: auth.kind, pid: auth.pid, name: auth.name } };
  }
  return { status: 403, code: 'PEER_REFUSED', error: `This is the owner's, from the owner's own browser or the app; this request comes from ${auth.why}: pid ${auth.pid} (${auth.name}).` };
}

/**
 * @param {object} o
 * @param {() => ({ fromWorkerBrowser(req): boolean } | null)} [o.pageSession] the page session (read at request time)
 * @param {(req) => boolean} [o.isRemote] a request from outside (the tunnel, the invite proxy): the guest rules decide
 * @param {{ lookup(req): Promise<object>, supported?: boolean }} [o.peer] lib/peer-identity.js (for sockets: no
 *   middleware runs for them). `supported` (macOS, not off): a covered request without a verdict, or a socket whose
 *   lookup threw, is a failed lookup (503), never the rules from before.
 * @param {(line: string) => void} [o.log]
 * @param {() => boolean} [o.automationBrowserAllowed] the owner's setting (lib/automation-browser-owner-access.js);
 *   left out, the page session's `automationBrowserGranted()` is asked, so both read the one value
 */
export function createOwnerAuthority({ pageSession = () => null, isRemote = () => false, peer = null, log = () => {}, automationBrowserAllowed = null } = {}) {
  const fromWorkerBrowser = (req) => { const s = pageSession(); return typeof s?.fromWorkerBrowser === 'function' ? s.fromWorkerBrowser(req) : false; };
  /** The owner's setting, read at request time: given here, else the page session's own reading; never on a failure. */
  const granted = () => {
    try {
      if (typeof automationBrowserAllowed === 'function') return automationBrowserAllowed() === true;
      const s = pageSession();
      return typeof s?.automationBrowserGranted === 'function' && s.automationBrowserGranted() === true;
    } catch { return false; }
  };
  const remote = (req) => { try { return isRemote(req) === true; } catch { return false; } };
  /** The lookup runs here (macOS, not off): no verdict is no proof. */
  const required = peer?.supported === true;
  const logged = new Map();
  const note = (key, line) => {
    const now = Date.now();
    if (now - (logged.get(key) || 0) < 60_000) return;
    logged.set(key, now);
    if (logged.size > 500) logged.delete(logged.keys().next().value);
    try { log(line); } catch { /* a logger's own failure */ }
  };

  /** Whether the peer middleware should look this request up (it is one of the owner's, and not from outside). */
  function needsLookup(req) {
    if (remote(req)) return false;
    try { return restScope(req).gated; } catch { return true; }
  }

  /** Express middleware, mounted after the peer middleware: 403 for a refused request to one of the owner's routes
   *  (its writes, its reads, a secret read), 503 PEER_UNAVAILABLE (with Retry-After) for one whose peer could not be
   *  identified on macOS. */
  function restGate(req, res, next) {
    let scope;
    try { scope = restScope(req); } catch { scope = { gated: true, agentOpen: false, degradedOpen: false }; }
    if (!scope.gated || remote(req)) return next();
    const refused = ownerRefusal(req, { agentOpen: scope.agentOpen, degradedOpen: scope.degradedOpen, required, fromWorkerBrowser, automationBrowserAllowed: granted() });
    if (!refused) return next();
    note(`${refused.code}:${req[PEER_VERDICT]?.pid || (refused.code === PEER_UNAVAILABLE ? refused.reason : 'marker')}:${String(req.path).slice(0, 80)}`, `[owner-authority] ${refused.code === PEER_UNAVAILABLE ? 'unavailable (503)' : 'refused'} ${req.method} ${String(req.path).slice(0, 120)}: ${refused.hint === 'proxy' ? `${req[PEER_VERDICT]?.refuse?.why}: pid ${refused.peer?.pid} (${refused.peer?.name})` : refused.code === PEER_UNAVAILABLE ? `the caller could not be identified (${refused.reason})` : refused.error}`);
    if (refused.code === PEER_UNAVAILABLE) return sendPeerUnavailable(res, req, refused);
    if (refused.hint) return res.status(403).json({ ok: false, code: refused.code, error: refused.error, hint: refused.hint, peer: refused.peer });
    return sendGuardError(res, 403, refused.code, refused.error);
  }

  /**
   * The decision for a WebSocket upgrade (no middleware runs for one): looks the peer up for an owner socket and for
   * /ws/sync. → { refuse: boolean, readOnly: boolean, status?: 403|503, code?, error?, retryable? }. Never rejects. A
   * peer that could not be identified on macOS gets no owner socket (status 503) and a read-only /ws/sync; where the
   * lookup does not run, nothing is refused for it.
   */
  async function checkUpgrade(req, pathname) {
    const scope = socketScope(pathname);
    if ((!scope.owner && !scope.readOnly) || remote(req)) return { refuse: false, readOnly: false };
    if (peer && typeof peer.lookup === 'function' && !req[PEER_VERDICT]) {
      try { req[PEER_VERDICT] = await peer.lookup(req); } catch (error) {
        // A lookup that threw is a lookup that failed where it runs; elsewhere the rules from before.
        if (required) req[PEER_VERDICT] = failedPeerVerdict(`the lookup failed (${error?.message || error})`);
      }
    }
    const refused = ownerRefusal(req, { agentOpen: false, required, fromWorkerBrowser, automationBrowserAllowed: granted() });
    if (!refused) return { refuse: false, readOnly: false };
    note(`ws:${refused.code}:${req[PEER_VERDICT]?.pid || 'marker'}:${pathname}`, `[owner-authority] ${scope.owner ? (refused.code === PEER_UNAVAILABLE ? 'unavailable (503)' : 'refused') : 'read-only'} socket ${pathname}: ${refused.code === PEER_UNAVAILABLE ? `the caller could not be identified (${refused.reason})` : refused.error}`);
    return scope.owner ? { refuse: true, readOnly: false, ...refused } : { refuse: false, readOnly: true, ...refused };
  }

  /**
   * The decision for an upgrade whose check itself broke (checkUpgrade never rejects; this is the guard for what it
   * cannot foresee, server.js's rejection path): where the lookup runs, as for a failed lookup (an owner socket refused
   * with 503, /ws/sync read-only); elsewhere, and for a request from outside, the rules from before.
   */
  function upgradeFailed(req, pathname, error) {
    const scope = socketScope(pathname);
    if (!required || (!scope.owner && !scope.readOnly) || remote(req)) return { refuse: false, readOnly: false };
    const reason = `the socket's check failed (${error?.message || error || 'no reason'})`;
    note(`ws-failed:${pathname}`, `[owner-authority] ${scope.owner ? 'unavailable (503)' : 'read-only'} socket ${pathname}: ${reason}`);
    const refused = { status: 503, code: PEER_UNAVAILABLE, error: peerUnavailableText(req, { reason }), retryable: false, reason };
    return scope.owner ? { refuse: true, readOnly: false, ...refused } : { refuse: false, readOnly: true, ...refused };
  }

  return { needsLookup, restGate, checkUpgrade, upgradeFailed, restScope, socketScope };
}
