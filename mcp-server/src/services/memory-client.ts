import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { currentIdentity, getIdentity, type CallerIdentity } from './identity.js';
import { detectProject } from '../config.js';

const serverIdentities = new WeakMap<McpServer, CallerIdentity>();
const serverRefreshers = new WeakMap<McpServer, () => Promise<void>>();

/** Bind a session's CallerIdentity to its McpServer so roots refresh callbacks keep it even outside ALS. */
export function bindServerIdentity(server: McpServer, identity: CallerIdentity): void {
  serverIdentities.set(server, identity);
}

/** Trigger a roots refresh for an attached McpServer (e.g. once an HTTP session's standalone SSE stream opens). */
export function refreshMemoryClientRoots(server: McpServer): Promise<void> {
  return serverRefreshers.get(server)?.() ?? Promise.resolve();
}

/** Standard MCP roots are optional; clients without roots keep existing calls. */
export function attachMemoryClient(server: McpServer) {
  const refresh = async () => {
    if (!server.server.getClientCapabilities()?.roots) return;
    const bound = serverIdentities.get(server);
    const ambient = currentIdentity();
    // Reject a binding mismatch: a callback on a server bound to one session must never
    // write its roots into a different ambient session identity.
    if (bound && ambient && ambient !== bound) return;
    const identity = bound ?? ambient ?? getIdentity();
    if (identity.memoryContext?.project && identity.memoryContext.generation !== 'mcp-roots') return;
    try {
      const { roots } = await server.server.listRoots({}, { timeout: 1500 });
      if (identity.memoryContext?.project && identity.memoryContext.generation !== 'mcp-roots') return;
      if (roots.length === 1 && roots[0].uri.startsWith('file:')) {
        identity.memoryContext = { ...identity.memoryContext, project: detectProject(fileURLToPath(roots[0].uri)), generation: 'mcp-roots' };
      } else if (identity.memoryContext) delete identity.memoryContext.project;
    } catch { /* Optional capability; explicit project always remains available. */ }
  };
  serverRefreshers.set(server, refresh);
  const previous = server.server.oninitialized;
  server.server.oninitialized = () => { previous?.(); refresh().catch(() => {}); };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, refresh);
}
