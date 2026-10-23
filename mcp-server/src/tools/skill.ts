import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { skillSchema, skillDescription, handleSkill } from './skill-tools.js';

/**
 * Register the SynaBun `skill` MCP tool (role-gated group `skills`): one tool with action-based dispatch over the
 * Skills Service (catalog, library, drafts, checks, install plans, Review queue). It never installs or approves.
 */
export function registerSkillTools(server: McpServer) {
  return [
    server.tool('skill', skillDescription, skillSchema, handleSkill),
  ];
}
