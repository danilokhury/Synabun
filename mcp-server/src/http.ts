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
import { createMcpServer, refreshServerSchemas, onSchemaRefresh } from './index.js';
import {
  type CallerIdentity,
  markHttpMode,
  obtainIdentity,
  sanitizePin,
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

function takeServer(): ReturnType<typeof createMcpServer> {
  const server = warmServer ?? createMcpServer('full');
  warmServer = null;
  setImmediate(() => {
    try {
      if (!warmServer) warmServer = createMcpServer('full');
    } catch { /* next request builds inline */ }
  });
  return server;
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
  const headerTerminal = sanitizePin(req.get('x-synabun-terminal'));
  if (headerTerminal) {
    return obtainIdentity(headerTerminal, {
      source: 'header',
      pins: {
        terminalSessionId: headerTerminal,
        browserSessionId: sanitizePin(req.get('x-synabun-browser-session')),
        browserTabId: sanitizePin(req.get('x-synabun-browser-tab')),
      },
    });
  }
  // The initialize request has no session id yet — identity for it is
  // irrelevant (no tool calls happen during initialize), so a throwaway key
  // is fine; real requests carry the assigned Mcp-Session-Id.
  return obtainIdentity(sid || `init-${randomUUID()}`, { source: 'mcp-session' });
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
    try { await ensureDatabase(); } catch {}
    await initCategoryCache();
    await warmupEmbeddings();
    initialized = true;
  })();
  await initPromise;
  initPromise = null;
}

/**
 * Create Express routes for the MCP HTTP endpoint.
 * Auth is handled externally (URL-embedded key in server.js).
 * Can be mounted on an existing Express app: app.use('/mcp', createMcpRoutes());
 */
export function createMcpRoutes(): Router {
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
        await runWithIdentity(deriveIdentity(req, sid), () =>
          entry.transport.handleRequest(req, res, req.body)
        );
        return;
      }

      // New client — must be an initialize request.
      if (!isInitializeRequest(req.body)) {
        return jsonRpcError(res, 400, -32000, 'Bad Request: no valid session ID provided');
      }

      const server = takeServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid) => {
          mcpSessions.set(newSid, { transport, server, lastSeen: Date.now() });
          const terminal = sanitizePin(req.get('x-synabun-terminal'));
          console.error(`[mcp-http] session ${newSid} init (terminal=${terminal || 'none'}, sessions=${mcpSessions.size})`);
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
      await runWithIdentity(deriveIdentity(req, undefined), () =>
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
      await runWithIdentity(deriveIdentity(req, sid), () =>
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

// If run directly, start a standalone HTTP server
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/http.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('/http.ts');

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
