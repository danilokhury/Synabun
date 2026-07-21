import { z } from 'zod';
import { text } from './response.js';
import { VALID_GROUPS, getProfilePresets, getActiveProfile, applyProfile, persistRuntimeProfile } from '../services/profiles.js';
import { reportRuntimeMcpProfile } from '../services/neural-interface.js';

export const profileSchema = {
  action: z.enum(['get', 'set']).describe(
    'get = inspect this runtime and its available presets. set = switch only this runtime to another profile and refresh the host tool list.'
  ),
  profile: z.string().optional().describe(
    'Profile to switch to (required for "set"). Call get for current presets, choose the narrowest one that supplies the needed tools, or pass valid comma-separated groups.'
  ),
};

export const profileDescription =
  'Always-available MCP capability router. If a task needs a tool that is not currently listed, call action="get", then action="set" with the narrowest suitable profile and continue after the host reloads its tools. Do not claim a SynaBun capability is unavailable before trying this. A switch affects only the current sidepanel/loop/schedule runtime and never changes other sessions or the future-session default.';

const ALWAYS_ON_TOOL_COUNT = 11;
const GROUP_TOOL_ESTIMATES: Record<string, number> = {
  git: 1,
  image: 1,
  whiteboard: 3,
  card: 4,
  tictactoe: 2,
  browser: 20,
  browser_twitter: 1,
  browser_facebook: 1,
  browser_tiktok: 4,
  browser_whatsapp: 2,
  browser_instagram: 5,
  browser_linkedin: 8,
  browser_bluesky: 15,
  leonardo: 5,
  discord: 8,
  gsc: 30,
  youtube: 11,
  styleguide: 1,
  morelogin: 1,
};

export async function handleProfile(args: { action: string; profile?: string }) {
  if (args.action === 'get') {
    const { profile, activeGroups } = getActiveProfile();
    const presets = Object.entries(getProfilePresets()).map(([name, groups]) => ({
      name,
      groups,
      toolEstimate: `~${ALWAYS_ON_TOOL_COUNT + groups.reduce((sum, group) => sum + (GROUP_TOOL_ESTIMATES[group] || 0), 0)}`,
    }));
    return text(JSON.stringify({
      currentProfile: profile,
      activeGroups,
      presets,
      validGroups: Array.from(VALID_GROUPS),
    }, null, 2));
  }

  if (args.action === 'set') {
    if (!args.profile) {
      return text('Error: "profile" parameter is required for action "set". Call action="get" for the available presets or use valid comma-separated groups.');
    }
    let result;
    try {
      result = applyProfile(args.profile);
    } catch (err) {
      return text(`Error: ${err instanceof Error ? err.message : String(err)}. Call action="get" for valid presets and groups.`);
    }
    const runtimeStatePersisted = persistRuntimeProfile(result.profile);
    const runtimeReport = await reportRuntimeMcpProfile(result.profile);
    return text(JSON.stringify({
      switched: true,
      profile: result.profile,
      enabled: result.enabled,
      disabled: result.disabled,
      totalTools: result.totalTools,
      scope: 'current-runtime',
      runtimeStatePersisted,
      runtimeStateReported: runtimeReport.reported,
      note: 'Tool list updated for this runtime only. Your client has been notified; continue with the newly loaded tools.',
    }, null, 2));
  }

  return text(`Unknown action "${args.action}". Use "get" or "set".`);
}
