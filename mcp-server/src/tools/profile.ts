import { z } from 'zod';
import { text } from './response.js';
import { PROFILE_PRESETS, VALID_GROUPS, getActiveProfile, applyProfile, persistProfile } from '../services/profiles.js';

export const profileSchema = {
  action: z.enum(['get', 'set']).describe(
    'get = show current profile, available presets, and tool counts. set = switch to a different profile (enables/disables tool groups at runtime).'
  ),
  profile: z.string().optional().describe(
    'Profile to switch to (required for "set"). Preset names: core, standard, browser, full. Or comma-separated groups: "git,browser,discord".'
  ),
};

export const profileDescription =
  'Switch MCP tool profiles at runtime without restarting. Use "get" to see current profile and available presets. Use "set" to enable/disable tool groups dynamically — the client will be notified of the tool list change.';

export async function handleProfile(args: { action: string; profile?: string }) {
  if (args.action === 'get') {
    const { profile, activeGroups } = getActiveProfile();
    const presets = Object.entries(PROFILE_PRESETS).map(([name, groups]) => ({
      name,
      groups,
      toolEstimate: name === 'core' ? '~11' : name === 'standard' ? '~22' : name === 'browser' ? '~61' : '~74',
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
      return text('Error: "profile" parameter is required for action "set". Use a preset (core, standard, browser, full) or comma-separated groups.');
    }
    const result = applyProfile(args.profile);
    persistProfile(result.profile);
    return text(JSON.stringify({
      switched: true,
      profile: result.profile,
      enabled: result.enabled,
      disabled: result.disabled,
      totalTools: result.totalTools,
      note: 'Tool list updated. Your client has been notified of the change.',
    }, null, 2));
  }

  return text(`Unknown action "${args.action}". Use "get" or "set".`);
}
