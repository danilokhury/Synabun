import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  styleGuideSchema, styleGuideDescription, handleStyleGuide,
} from './style-guide-tools.js';

/**
 * Register the SynaBun Style Guide MCP tool on the given server instance.
 * Single tool with action-based dispatch: get | list.
 */
export function registerStyleGuideTools(server: McpServer) {
  return [
    server.tool('style_guide', styleGuideDescription, styleGuideSchema, handleStyleGuide),
  ];
}
