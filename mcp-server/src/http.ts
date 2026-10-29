#!/usr/bin/env node

/**
 * HTTP transport for SynaBun MCP server.
 *
 * STATEFUL: each MCP client (a Claude Code process — CLI window, sidepanel
 * chat, loop) performs an initialize handshake and receives a unique
 * Mcp-Session-Id, which it echoes on every subsequent request. That id — or
 * an explicit X-Synabun-Terminal header injected at launch (loops, sidepanel)
 * — becomes the caller's identity for browser session/tab isolation. Every
 * transport.handleRequest call runs inside an AsyncLocalStorage identity
 * context so neural-interface.ts resolves per-caller state instead of
 * process-global state (the old stateless mode collapsed every HTTP caller
 * into one identity → cross-automation tab collisions).
 *
 * Mount on any Express app or run standalone.
 */

import { randomUUID } from 'node:crypto';
import express, { type Request, type Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ensureDatabase } from './services/sqlite.js';
import { initCategoryCache } from './services/categories.js';
import { warmupEmbeddings } from './services/local-embeddings.js';
import {
  createMcpServer, refreshServerSchemas, onSchemaRefresh, setServerRole, setServerCapabilities, setServerSelection, httpDefaultSelection, getServerToolRuntime,
} from './index.js';
import { ToolListRefreshBarrier } from './services/tool-list-refresh-barrier.js';
import { selectionFromList, unreadableSelection, type ToolMode, type ToolSelection } from './services/tool-runtime.js';
import { TOOL_LIST_LIMITS } from './services/tool-catalog.js';
import {
  type CallerIdentity,
  markHttpMode,
  obtainIdentity,
  sanitizeBrainCredential,
  sanitizeDesktopGrant,
  sanitizePin,
  sanitizeRole,
  runWithBrainCredential,
  runWithIdentity,
  releaseIdentity,
  startIdentitySweeper,
} from './services/identity.js';

let initialized = false;
let initPromise: Promise<void> | null = null;

// Warm-server pool: registering 100+ tools (with Zod schema construction)
// is measurable overhead. Pre-build the next server off the request path;
// drop it when category schemas change. With stateful sessions this is
// consumed once per CLIENT SESSION (initialize), not per request.
let warmServer: ReturnType<typeof createMcpServer> | null = null;
const toolListBarriers = new WeakMap<ReturnType<typeof createMcpServer>, ToolListRefreshBarrier>();

// Built with focus on every group: Claude Code reaches every SynaBun tool
// through ToolSearch. Each session's own selection is bound at initialize.
function takeServer(): ReturnType<typeof createMcpServer> {
  const server = warmServer ?? createMcpServer({ selection: httpDefaultSelection() });
  warmServer = null;
  setImmediate(() => {
    try {
      if (!warmServer) warmServer = createMcpServer({ selection: httpDefaultSelection() });
    } catch { /* next request builds inline */ }
  });
  return server;
}

/** A selection the worker channel resolves for its run: group ids, strict unless it says focus. */
export interface McpSessionSelection {
  groups: readonly string[];
  mode?: ToolMode;
}

export interface McpRoutesOptions {
  /**
   * The worker channel's resolver: a request's selection from its own run-token map, never from a header. When it
   * answers, the session has exactly that selection and X-Synabun-Tools is ignored.
   */
  selectionFor?: (req: Request) => McpSessionSelection | null | undefined;
}

/**
 * A session's tools, decided once, at initialize: the resolver's answer (strict), else the X-Synabun-Tools header
 * (focus only: it steers the instructions, never what the session can reach), else focus on every group.
 */
export function sessionSelection(req: Request, options: McpRoutesOptions = {}): ToolSelection {
  if (options.selectionFor) {
    let answer: McpSessionSelection | null | undefined;
    try {
      answer = options.selectionFor(req);
    } catch (err) {
      return unreadableSelection('channel', `its run's tool list could not be resolved (${err instanceof Error ? err.message : String(err)})`, 'strict');
    }
    if (answer) {
      const mode = answer.mode === 'focus' ? 'focus' : 'strict';
      return Array.isArray(answer.groups)
        ? selectionFromList([...answer.groups], mode, 'channel')
        : unreadableSelection('channel', 'its run names no tool list', mode);
    }
  }
  const header = req.get('x-synabun-tools');
  if (header === undefined || !header.trim()) return httpDefaultSelection();
  const selection = Buffer.byteLength(header, 'utf8') > TOOL_LIST_LIMITS.maxSerializedBytes
    ? unreadableSelection('header', `longer than ${TOOL_LIST_LIMITS.maxSerializedBytes} bytes`, 'focus')
    : selectionFromList(header, 'focus', 'header');
  // A header that cannot be read narrows nothing: the session keeps reaching every tool and is told why.
  return selection.listError ? { ...selection, mode: 'focus', hostMode: 'focus' } : selection;
}

// ── MCP client sessions (one per connected Claude Code process) ──
interface McpHttpSession {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
  lastSeen: number;
}
const mcpSessions = new Map<string, McpHttpSession>();

const MCP_SESSION_TTL_MS = parseInt(process.env.SYNABUN_MCP_SESSION_TTL_MS || '', 10) || 60 * 60 * 1000;

let sessionSweeperStarted = false;
function startSessionSweeper(): void {
  if (sessionSweeperStarted) return;
  sessionSweeperStarted = true;
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of mcpSessions) {
      if (now - entry.lastSeen > MCP_SESSION_TTL_MS) {
        console.error(`[mcp-http] session ${sid} evicted after ${Math.round((now - entry.lastSeen) / 60000)}min idle (${mcpSessions.size - 1} remain)`);
        // transport.close() fires onclose → map cleanup + releaseIdentity + server.close.
        try { entry.transport.close(); } catch { /* already closed */ }
      }
    }
  }, 10 * 60 * 1000);
  interval.unref();
}

// Category/schema changes: drop the warm server AND refresh every live
// session's tool schemas (tool.update() pushes tools/list_changed to clients
// that hold an open notification stream).
onSchemaRefresh(() => {
  warmServer = null;
  for (const entry of mcpSessions.values()) {
    try { refreshServerSchemas(entry.server); } catch { /* per-session best-effort */ }
  }
});

/**
 * Per-request caller identity. Explicit X-Synabun-* headers (injected into the
 * launch config of loops, scheduled loops, and sidepanel sessions) win; plain
 * CLI windows fall back to their unique Mcp-Session-Id.
 */
function deriveIdentity(req: Request, sid: string | undefined): CallerIdentity {
  const memoryContext = {
    project: req.get('x-synabun-project')?.slice(0,200),
    session: req.get('x-synabun-memory-session')?.slice(0,200),
    generation: req.get('x-synabun-context-generation')?.slice(0,200),
  };
  // Re-read on every request: the assistant brain sends X-Synabun-Role with
  // each call, so the role never outlives the headers that granted it.
  // Tunnel callers (a remote MCP-key holder) can claim neither the assistant
  // role nor a computer-use grant.
  const remote = !!req.get('cf-connecting-ip');
  const role = remote ? null : sanitizeRole(req.get('x-synabun-role'));
  const desktopGrant = remote ? null : sanitizeDesktopGrant(req.get('x-synabun-desktop-grant'));
  const headerTerminal = sanitizePin(req.get('x-synabun-terminal'));
  if (headerTerminal) {
    const identity = obtainIdentity(headerTerminal, {
      source: 'header',
      pins: {
        terminalSessionId: headerTerminal,
        browserSessionId: sanitizePin(req.get('x-synabun-browser-session')),
        browserTabId: sanitizePin(req.get('x-synabun-browser-tab')),
      },
      role,
      desktopGrant,
    });
    identity.memoryContext = { ...identity.memoryContext, ...Object.fromEntries(Object.entries(memoryContext).filter(([,v])=>v !== undefined)) };
    return identity;
  }
  // The initialize request has no session id yet — identity for it is
  // irrelevant (no tool calls happen during initialize), so a throwaway key
  // is fine; real requests carry the assigned Mcp-Session-Id.
  const identity = obtainIdentity(sid || `init-${randomUUID()}`, { source: 'mcp-session', role, desktopGrant });
  identity.memoryContext = { ...identity.memoryContext, ...Object.fromEntries(Object.entries(memoryContext).filter(([,v])=>v !== undefined)) };
  return identity;
}

/** The X-Synabun-Brain-Token of one request (whatsapp_send_file); none for a tunnel caller (a remote MCP-key holder). */
export function requestBrainCredential(req: Pick<Request, 'get'>): string | null {
  return req.get('cf-connecting-ip') ? null : sanitizeBrainCredential(req.get('x-synabun-brain-token'));
}

/**
 * Handle one request inside its caller identity and its own brain-credential context: the
 * X-Synabun-Brain-Token of THIS request, never one another request left on a shared identity.
 */
function runRequest<T>(req: Request, sid: string | undefined, fn: () => T): T {
  return runWithBrainCredential(requestBrainCredential(req), () => runWithIdentity(deriveIdentity(req, sid), fn));
}

function jsonRpcError(res: express.Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Initialize DB, categories, and warm up the embedding model.
 * Safe to call multiple times — only runs once.
 * Exported so the Neural Interface can eagerly init at startup.
 */
export async function ensureInit() {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await ensureDatabase();
    await initCategoryCache();
    warmupEmbeddings().catch(error=>console.error('[memory] Local model unavailable; keyword recall remains available:',error.message));
    initialized = true;
  })();
  try { await initPromise; } finally { initPromise = null; }
}

/**
 * Create Express routes for the MCP HTTP endpoint.
 * Auth is handled externally (URL-embedded key in server.js).
 * Can be mounted on an existing Express app: app.use('/mcp', createMcpRoutes());
 * The worker channel passes `selectionFor`, so its sessions are strict to their run's list.
 */
export function createMcpRoutes(options: McpRoutesOptions = {}): Router {
  markHttpMode();
  startIdentitySweeper();
  startSessionSweeper();

  const router = express.Router();
  router.use(express.json());

  router.post('/', async (req, res) => {
    await ensureInit();
    try {
      const sid = req.get('mcp-session-id') || undefined;

      // Existing client session — route to its transport.
      if (sid) {
        const entry = mcpSessions.get(sid);
        if (!entry) {
          // Expired/unknown session: 404 per spec → the client re-initializes.
          return jsonRpcError(res, 404, -32001, 'Session not found');
        }
        entry.lastSeen = Date.now();
        if (req.body?.method === 'tools/list' && req.body.id !== undefined) {
          // finish means the fresh schemas have left this session's HTTP response.
          res.once('finish', () => { if (res.statusCode === 200) toolListBarriers.get(entry.server)?.listed(); });
        }
        await runRequest(req, sid, () =>
          entry.transport.handleRequest(req, res, req.body)
        );
        return;
      }

      // New client — must be an initialize request.
      if (!isInitializeRequest(req.body)) {
        return jsonRpcError(res, 400, -32000, 'Bad Request: no valid session ID provided');
      }

      const server = takeServer();
      const barrier = new ToolListRefreshBarrier();
      toolListBarriers.set(server, barrier);
      getServerToolRuntime(server)?.setInBandRefresh(() => barrier.refresh(() =>
        server.server.notification({ method: 'notifications/tools/list_changed' })
      ));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid) => {
          mcpSessions.set(newSid, { transport, server, lastSeen: Date.now() });
          deriveIdentity(req, newSid);
          const terminal = sanitizePin(req.get('x-synabun-terminal'));
          // The warm server was built role-less, on focus. The SDK awaits this
          // hook BEFORE dispatching the initialize request, so binding the
          // selection and the role here makes the handshake instructions and
          // the client's first tools/list already right.
          const selection = sessionSelection(req, options);
          setServerSelection(server, selection);
          const remote = !!req.get('cf-connecting-ip');
          const role = remote ? null : sanitizeRole(req.get('x-synabun-role'));
          if (role) setServerRole(server, role);
          // The capability-gated `computer` group is advertised only to a caller
          // presenting a desktop grant (re-checked server-side on every call).
          const grant = remote ? null : sanitizeDesktopGrant(req.get('x-synabun-desktop-grant'));
          if (grant) setServerCapabilities(server, { computer: true });
          const tools = selection.source === 'http' ? '' : `, tools=${selection.mode}:${selection.groups.join(',') || 'memory'}${selection.listError ? ' (unreadable)' : ''}`;
          console.error(`[mcp-http] session ${newSid} init (terminal=${terminal || 'none'}${role ? `, role=${role}` : ''}${grant ? ', computer' : ''}${tools}, sessions=${mcpSessions.size})`);
        },
      });
      // Re-entry guard: server.close() closes its transport, which fires
      // onclose again — without the guard that recurses until stack overflow.
      let tornDown = false;
      transport.onclose = () => {
        if (tornDown) return;
        tornDown = true;
        const closedSid = transport.sessionId;
        if (closedSid && mcpSessions.has(closedSid)) {
          mcpSessions.delete(closedSid);
          // Releases the identity's acquired browser tab (if any). Header-keyed
          // identities (loops) are keyed by terminal id, not sid — untouched.
          releaseIdentity(closedSid);
          console.error(`[mcp-http] session ${closedSid} closed (${mcpSessions.size} remain)`);
        }
        try { server.close(); } catch { /* already closed */ }
      };

      await server.connect(transport);
      await runRequest(req, undefined, () =>
        transport.handleRequest(req, res, req.body)
      );
    } catch (error) {
      console.error('MCP HTTP error:', error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, 'Internal server error');
      }
    }
  });

  // GET opens the SSE notification stream (tools/list_changed reaches HTTP
  // clients); DELETE terminates the session (fires transport.onclose → tab release).
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sid = req.get('mcp-session-id') || undefined;
    const entry = sid ? mcpSessions.get(sid) : undefined;
    if (!sid || !entry) {
      return jsonRpcError(res, sid ? 404 : 400, sid ? -32001 : -32000, sid ? 'Session not found' : 'Bad Request: no valid session ID provided');
    }
    entry.lastSeen = Date.now();
    try {
      await runRequest(req, sid, () =>
        entry.transport.handleRequest(req, res)
      );
    } catch (error) {
      console.error('MCP HTTP error:', error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, 'Internal server error');
      }
    }
  };
  router.get('/', handleSessionRequest);
  router.delete('/', handleSessionRequest);

  return router;
}

// If run directly, start a standalone HTTP server: `node dist/http.js`, or `npm run start:http` / `dev:http`, whose
// preload-http entry loads the data home's .env and then this module (argv[1] names the preload then).
const isMain = /\/(?:preload-)?http\.[jt]s$/.test(process.argv[1]?.replace(/\\/g, '/') || '');

if (isMain) {
  const PORT = parseInt(process.env.MCP_HTTP_PORT || '3345', 10);
  const app = express();
  app.use('/mcp', createMcpRoutes());

  app.get('/', (_req, res) => {
    res.json({ name: 'SynaBun MCP (HTTP)', status: 'ok', endpoint: '/mcp' });
  });

  app.listen(PORT, () => {
    console.log(`SynaBun MCP HTTP server listening on port ${PORT}`);
    console.log(`Endpoint: http://localhost:${PORT}/mcp`);
  });

  // Standalone-only: SIGKILL ourselves on exit to skip C++ static destructors and
  // dodge the onnxruntime-node at-exit abort (`libc++abi: ... mutex lock failed`).
  // When imported in-process by the Neural Interface, that server's own `exit`
  // handler covers this instead. See mcp-server/src/index.ts for the rationale.
  process.on('exit', () => {
    try { process.kill(process.pid, 'SIGKILL'); } catch { /* already gone */ }
  });
}
