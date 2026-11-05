// ═══════════════════════════════════════════
// SynaBun — the worker-only MCP channel (a second loopback listener for sandboxed workers)
// ═══════════════════════════════════════════
//
// A guarded worker on macOS runs under a Seatbelt profile (lib/worker-sandbox.js) that blocks outbound connections
// to SynaBun's control port (NEURAL_PORT). That also blocks the worker's own SynaBun MCP client, so a guarded
// worker is given this instead: a second HTTP listener, bound to 127.0.0.1 on a port of its own, which the profile
// leaves open and which serves ONLY the MCP endpoint — never the owner's API, never the page, never a run's data.
//
// Each worker reaches it at a per-run path, /w/<token>/mcp, where <token> is an unguessable id this channel minted
// for that run. The channel pins every such request to that run (X-Synabun-Terminal = the run id, from the token,
// not from anything the worker sends) and strips the headers that carry authority — the brain launch credential,
// the assistant role, the owner's page cookie, and the from-outside markers — so a worker can never be read as the
// owner or as a brain here, whatever it sends. What stays is the run's own routing (its browser session / tab, its
// project, its memory session) and its own per-run desktop grant (a capability token minted for that run, needed by
// a computer-use worker). The MCP tools it then has are the worker-safe ones: memory, browser, loop, cards — the
// role-gated agents / skills groups are never advertised, because the role header is stripped.
//
// The channel carries a SECOND createMcpRoutes() instance (its own sessions), sharing the same in-process services
// and database as the main /mcp mount. A tool call that fetches back into the Neural Interface (a browser op) is
// made by the Neural Interface process itself to its own loopback port — never by the worker — so it is outside the
// worker's sandbox and works normally.
//
// Only an enforced guard on macOS uses this channel; a full worker, a warn/off run, or any non-macOS host keeps the
// main /mcp mount unchanged. If the channel cannot start, the caller falls back to the main mount and says so (the
// worker is then not OS-isolated): the live tree must never lose worker dispatch to a channel that failed to bind.

import express from 'express';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { isAutomationBrowserRoute } from './browser-automation-routes.js';

// The only Neural-Interface API a sandboxed worker's stdio MCP child (OpenCode) may reach through the channel: the
// browser routes its browser tools call over HTTP to NEURAL_INTERFACE_URL, exactly (lib/browser-automation-routes.js:
// the session list, create and close, acquire and release, the page actions on a session). Everything else it does
// (memory) is direct DB I/O in its own process and never touches the channel. The owner's API (/api/assistant,
// /api/page-session, …) and the owner's browser routes (the browser settings, the money guard's lift, the CDP
// endpoints, tab management) are NEVER proxied: the channel is not a way back to the control surface. Until
// 2026-11-05 it forwarded every /browser/* path with the run's token (review 972afb74, finding 1).
const BROWSER_PREFIX = '/api/browser';

const freePort = () => new Promise((done, fail) => {
  const s = net.createServer();
  s.on('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

// Headers a worker's request to the channel must never carry into the MCP server: owner / brain authority and the
// from-outside markers. The run's routing pins and its own desktop grant are kept. A terminal token the worker sends
// is dropped too: the channel adds its run's own (below), from the run the path token names.
const STRIPPED_HEADERS = Object.freeze([
  'x-synabun-tools', 'x-synabun-brain-token', 'x-synabun-assistant', 'x-synabun-role',
  'cookie', 'cf-connecting-ip', 'x-forwarded-host', 'x-forwarded-for', 'forwarded',
  'x-synabun-terminal-token',
]);

/**
 * The upstream URL for a proxied request (`url`: what follows /w/<token>/api, query included), or null when it is not
 * one of the browser routes an automation may call (lib/browser-automation-routes.js). The path is read as the
 * upstream request will be: a URL parser folds `..`, `%2e%2e` and backslashes, so a path it would change is refused
 * outright, never matched in one spelling and sent in another.
 */
export function proxiedBrowserRoute(method, url, mainPort) {
  const raw = String(url || '');
  const rawPath = raw.split('?')[0];
  let target;
  try { target = new URL(`/api${raw}`, `http://127.0.0.1:${mainPort}`); } catch { return null; }
  if (target.pathname !== `/api${rawPath}` || target.host !== `127.0.0.1:${mainPort}`) return null;
  if (!target.pathname.startsWith(`${BROWSER_PREFIX}/`)) return null;
  if (!isAutomationBrowserRoute(method, target.pathname.slice(BROWSER_PREFIX.length))) return null;
  return target;
}

/**
 * Build the channel. `createMcpRoutes` is the same factory server.js mounts at /mcp (mcp-server/dist/http.js).
 * `terminalToken(runId)` is the run's terminal token (lib/terminal-tokens.js tokenFor), which the channel sends with
 * the run's pin on its MCP path and its browser proxy: the path token already proves the run, and the browser routes
 * take a run's pin only with its token. `terminalAuth` is handed to the channel's MCP routes (as server.js's /mcp).
 * @returns an object with start/stop/register/unregister/url/port.
 */
export function createWorkerMcpChannel({ createMcpRoutes, mainPort = null, fetchImpl = globalThis.fetch, log = () => {}, terminalToken = () => null, terminalAuth = undefined } = {}) {
  if (typeof createMcpRoutes !== 'function') throw new Error('createWorkerMcpChannel needs createMcpRoutes');
  /** The run's terminal token, or null (none issued; a lookup that failed). */
  const tokenOf = (runId) => { try { const t = terminalToken(runId); return typeof t === 'string' && t ? t : null; } catch { return null; } };
  const tokenToRun = new Map(); // token → runId
  const runToToken = new Map(); // runId → token
  const selections = new Map(); // runId → immutable snapshot, never a request header
  let server = null;
  let port = null;

  const app = express();
  app.disable('x-powered-by');

  // The browser proxy: a sandboxed OpenCode worker's stdio MCP child points NEURAL_INTERFACE_URL at this channel
  // (.../w/<token>) and drives the browser over it; the channel forwards ONLY the browser subset to the real
  // Neural Interface on 127.0.0.1:<mainPort>, pinning the run and stripping authority. The forward is made by the
  // Neural Interface process itself (this listener lives in it), so it is outside the worker's sandbox. Mounted
  // before the MCP router so /w/<token>/api never falls through to it.
  app.use('/w/:token/api', express.raw({ type: '*/*', limit: '32mb' }), async (req, res) => {
    const runId = tokenToRun.get(String(req.params.token || ''));
    if (!runId) return res.status(404).json({ error: 'Unknown worker channel' });
    const route = proxiedBrowserRoute(req.method, req.url, mainPort || 1);
    if (!route) {
      return res.status(403).json({ error: 'The worker channel forwards the browser routes of SynaBun\'s browser tools only.', code: 'WORKER_CHANNEL_ROUTE' });
    }
    if (!mainPort || typeof fetchImpl !== 'function') return res.status(502).json({ error: 'Worker channel proxy unavailable.' });
    const target = route.href;
    const headers = { 'content-type': req.get('content-type') || 'application/json' };
    // The run's own routing travels; authority never does.
    for (const h of ['x-synabun-browser-session', 'x-synabun-browser-tab', 'x-synabun-project', 'x-synabun-memory-session', 'x-synabun-deadline', 'x-synabun-request-id', 'x-synabun-desktop-grant']) {
      const v = req.get(h); if (v) headers[h] = v;
    }
    headers['x-synabun-terminal'] = runId; // pinned: the worker's own run, never what it claims
    // …with that run's terminal token, which the worker never sends (the path token is its proof here).
    const runToken = tokenOf(runId);
    if (runToken) headers['x-synabun-terminal-token'] = runToken;
    try {
      const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : (Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined);
      const upstream = await fetchImpl(target, { method: req.method, headers, body });
      res.status(upstream.status);
      const passback = upstream.headers?.get?.('x-synabun-browser-default');
      if (passback) res.set('X-Synabun-Browser-Default', passback);
      const text = await upstream.text();
      res.set('Content-Type', upstream.headers?.get?.('content-type') || 'application/json');
      res.send(text);
    } catch (err) {
      res.status(502).json({ error: `Worker channel proxy failed: ${err?.message || err}` });
    }
  });

  const mcpRouter = createMcpRoutes({
    selectionFor: (req) => selections.get(req.headers['x-synabun-terminal']) || { groups: [], mode: 'strict' },
    ...(typeof terminalAuth === 'function' ? { terminalAuth } : {}),
  });
  // Everything the channel serves is under /w/:token/mcp; the run is pinned from the token and authority is stripped.
  app.use('/w/:token/mcp', (req, res, next) => {
    const runId = tokenToRun.get(String(req.params.token || ''));
    if (!runId) return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown worker channel' }, id: null });
    req.headers['x-synabun-terminal'] = runId; // the worker's identity is its own run, never what it claims
    for (const h of STRIPPED_HEADERS) delete req.headers[h];
    // The run's own terminal token, so its tools' browser calls are the run's (the in-process MCP forwards it).
    const runToken = tokenOf(runId);
    if (runToken) req.headers['x-synabun-terminal-token'] = runToken;
    next();
  }, mcpRouter);
  // Nothing else exists on this listener.
  app.use((req, res) => res.status(404).json({ error: 'The worker channel serves /w/<token>/mcp only.' }));

  return {
    /** Start the listener on a free loopback port. Resolves with the port, or throws (the caller falls back). */
    async start() {
      if (server) return port;
      const chosen = await freePort();
      await new Promise((ok, fail) => {
        server = app.listen(chosen, '127.0.0.1', ok);
        server.on('error', fail);
      });
      server.on('error', (err) => { try { log(`[worker-mcp] channel error: ${err?.message || err}`); } catch {} });
      port = chosen;
      try { log(`[worker-mcp] worker-only MCP channel on 127.0.0.1:${port}`); } catch {}
      return port;
    },
    isUp() { return !!server && !!port; },
    port() { return port; },
    /** Mint (or reuse) the per-run token. */
    register(runId, selection) {
      const id = String(runId || '');
      if (!id) throw new Error('worker MCP channel needs a run id');
      if (selection !== undefined) this.setSelection(id, selection);
      if (runToToken.has(id)) return runToToken.get(id);
      const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      tokenToRun.set(token, id);
      runToToken.set(id, token);
      return token;
    },
    setSelection(runId, selection) {
      const valid = Array.isArray(selection?.groups);
      const groups = valid ? [...selection.groups] : [];
      selections.set(String(runId), { groups, mode: valid && selection?.mode === 'focus' ? 'focus' : 'strict' });
    },
    has(runId) { return runToToken.has(String(runId)); },
    /** The MCP URL for a run (registers it if new), or null when the channel is not up. Claude's HTTP MCP uses this. */
    url(runId) {
      if (!port) return null;
      const token = this.register(runId);
      return `http://127.0.0.1:${port}/w/${token}/mcp`;
    },
    /** The per-run base (…/w/<token>), for a sandboxed stdio MCP child's NEURAL_INTERFACE_URL (OpenCode). */
    base(runId) {
      if (!port) return null;
      const token = this.register(runId);
      return `http://127.0.0.1:${port}/w/${token}`;
    },
    /** Forget a run's token (its channel path stops working at once). */
    unregister(runId) {
      const id = String(runId || '');
      selections.delete(id);
      const token = runToToken.get(id);
      if (token) { tokenToRun.delete(token); runToToken.delete(id); }
    },
    async stop() {
      selections.clear();
      tokenToRun.clear();
      runToToken.clear();
      if (server) { await new Promise((r) => server.close(r)); server = null; port = null; }
    },
    // For tests.
    _runs: () => [...runToToken.keys()],
  };
}
