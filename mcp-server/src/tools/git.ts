import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  gitSchema, gitDescription, handleGit,
} from './git-tools.js';

/**
 * Register the Git MCP tool on the given server instance.
 * Single tool with action-based dispatch: status, diff, commit, log, branches.
 */
export function registerGitTools(server: McpServer) {
  server.tool('git', gitDescription, gitSchema, handleGit);
}
