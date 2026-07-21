import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';

// ═══════════════════════════════════════════
// morelogin — MoreLogin anti-detect browser MCP tool
// ═══════════════════════════════════════════

export const moreloginSchema = {
  action: z.enum(['status', 'list', 'create', 'start', 'stop', 'use_default']).describe(
    'MoreLogin action. "status" = installed/running + current default. "list" = browser profiles (environments). "create" = new profile. "start"/"stop" = launch/close a profile. "use_default" = make a profile the default AI browser so every browser_* tool drives it.'
  ),
  envId: z.string().optional().describe(
    'MoreLogin environment (profile) id — required for start, stop, and use_default. Get ids from the "list" action.'
  ),
  name: z.string().optional().describe(
    'Name for a new profile ("create" action). Defaults to "SynaBun".'
  ),
};

export const moreloginDescription =
  'Manage MoreLogin (anti-detect, multi-account browser) profiles. Actions: "status" (is MoreLogin installed/running, which profile is the default AI browser), "list" (profiles), "create" (new profile), "start"/"stop" (launch/close a profile), "use_default" (set a profile as the default AI browser — afterwards all browser_* tools automatically drive that MoreLogin profile). Requires the MoreLogin desktop app to be running with its local API enabled.';

interface MlEnv { id: string; name: string; status?: string }

export async function handleMoreLogin(args: { action: string; envId?: string; name?: string }) {
  switch (args.action) {
    case 'status': {
      const r = await ni.moreloginStatus();
      if (r.error) return text(`MoreLogin unreachable: ${r.error}`);
      if (!r.installed) return text('MoreLogin is not installed. Install it from https://www.morelogin.com.');
      if (!r.running) return text(`MoreLogin is installed but its local API is not running on port ${r.port}. Open the MoreLogin app and enable Settings → API & MCP.`);
      const def = r.isDefault && r.defaultEnvId ? `default AI browser = env ${r.defaultEnvId}` : 'no MoreLogin default set';
      return text(`MoreLogin running on port ${r.port}. ${r.profileCount} profile(s). ${def}.`);
    }
    case 'list': {
      const r = await ni.moreloginProfiles();
      if (r.error) return text(`MoreLogin list failed: ${r.error}`);
      const envs = (r.envs || []) as MlEnv[];
      if (!envs.length) return text('No MoreLogin profiles found. Create one with action "create" (or one is auto-created on first use).');
      return text('MoreLogin profiles:\n' + envs.map(e => `  • ${e.name} (id ${e.id})${e.status ? ` — ${e.status}` : ''}`).join('\n'));
    }
    case 'create': {
      const r = await ni.moreloginCreate(args.name);
      if (r.error) return text(`Create failed: ${r.error}`);
      const ids = (r.ids || []) as string[];
      return text(`Created MoreLogin profile${ids.length ? ` (id ${ids.join(', ')})` : ''}.`);
    }
    case 'start': {
      if (!args.envId) return text('envId is required for the "start" action. Use "list" to get ids.');
      const r = await ni.moreloginStart(args.envId);
      if (r.error) return text(`Start failed: ${r.error}`);
      return text(`Started MoreLogin env ${args.envId} (debug port ${r.debugPort}).`);
    }
    case 'stop': {
      if (!args.envId) return text('envId is required for the "stop" action.');
      const r = await ni.moreloginStop(args.envId);
      if (r.error) return text(`Stop failed: ${r.error}`);
      return text(`Stopped MoreLogin env ${args.envId}.`);
    }
    case 'use_default': {
      if (!args.envId) return text('envId is required for the "use_default" action.');
      const r = await ni.moreloginUseDefault(args.envId);
      if (r.error) return text(`use_default failed: ${r.error}`);
      return text(`MoreLogin env ${args.envId} is now the default AI browser — every browser_* tool will drive it.`);
    }
    default:
      return text(`Unknown action: ${args.action}`);
  }
}

/**
 * Register the MoreLogin MCP tool on the given server instance.
 * Single tool with action-based dispatch: status, list, create, start, stop, use_default.
 */
export function registerMoreLoginTools(server: McpServer) {
  return [
    server.tool('morelogin', moreloginDescription, moreloginSchema, handleMoreLogin),
  ];
}
