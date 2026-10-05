import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { getIdentity } from './identity.js';
import { detectProject } from '../config.js';

/** Standard MCP roots are optional; clients without roots keep existing calls. */
export function attachMemoryClient(server: McpServer) {
  const refresh=async()=>{
    if(!server.server.getClientCapabilities()?.roots)return;
    const identity=getIdentity();
    if(identity.memoryContext?.project && identity.memoryContext.generation !== 'mcp-roots')return;
    try {
      const {roots}=await server.server.listRoots({}, {timeout:1500});
      if(roots.length===1 && roots[0].uri.startsWith('file:')) {
        identity.memoryContext={...identity.memoryContext,project:detectProject(fileURLToPath(roots[0].uri)),generation:'mcp-roots'};
      } else if(identity.memoryContext) delete identity.memoryContext.project;
    } catch { /* Optional capability; explicit project always remains available. */ }
  };
  const previous=server.server.oninitialized;
  server.server.oninitialized=()=>{previous?.();refresh().catch(()=>{});};
  server.server.setNotificationHandler(RootsListChangedNotificationSchema,refresh);
}
