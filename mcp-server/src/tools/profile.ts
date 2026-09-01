import { z } from 'zod';
import { text } from './response.js';
import { VALID_GROUPS, getProfilePresets, persistRuntimeProfile, type ProfileRuntime } from '../services/profiles.js';
import { reportRuntimeMcpProfile, type RuntimeMcpProfileReport } from '../services/neural-interface.js';

export const profileSchema = {
  action: z.enum(['get', 'set']).describe(
    'get = inspect this runtime and its available presets. set = switch only this runtime to another profile and refresh the host tool list.'
  ),
  profile: z.string().optional().describe(
    'Profile to switch to (required for "set"). Call get for current presets, choose the narrowest one that supplies the needed tools, or pass valid comma-separated groups.'
  ),
};

export const profileDescription =
  'Always-available MCP capability router. If a task needs a tool that is not currently listed, call action="get", then action="set" with the narrowest suitable profile and continue after the host refreshes its tools. Codex advertises the complete SynaBun catalog as deferred tools from turn start, so its profile is a focus selection and needs no reload. Do not claim a SynaBun capability is unavailable before trying this. A switch affects only the current sidepanel/loop/schedule runtime and never changes other sessions or the future-session default.';

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

export async function handleProfile(runtime: ProfileRuntime, args: { action: string; profile?: string }) {
  if (args.action === 'get') {
    const { profile, activeGroups } = runtime.getActiveProfile();
    const presets = Object.entries(getProfilePresets()).map(([name, groups]) => ({
      name,
      groups,
      toolEstimate: `~${ALWAYS_ON_TOOL_COUNT + groups.reduce((sum, group) => sum + (GROUP_TOOL_ESTIMATES[group] || 0), 0)}`,
    }));
    return text(JSON.stringify({
      currentProfile: profile,
      activeGroups,
      catalogMode: runtime.getCatalogMode(),
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
      result = runtime.applyProfile(args.profile);
    } catch (err) {
      return text(`Error: ${err instanceof Error ? err.message : String(err)}. Call action="get" for valid presets and groups.`);
    }
    const runtimeStatePersisted = persistRuntimeProfile(result.profile);
    const runtimeReport: RuntimeMcpProfileReport = await reportRuntimeMcpProfile(result.profile, {
      catalogMode: result.catalogMode,
    });
    let hostRefresh: 'scheduled' | 'notification' | 'unavailable' | 'not-needed' = 'not-needed';
    let toolListNotification: 'scheduled' | 'unavailable' | 'not-needed' = 'not-needed';
    if (result.catalogMode === 'profiled') {
      // Always queue one post-response MCP notification. Managed sidepanels
      // may also perform a host-level reconnect. Queue this even when the
      // requested profile already matches so an explicit retry can repair a
      // stale/lost host catalog instead of becoming a silent no-op.
      const notificationScheduled = runtime.scheduleProfileChangedNotification();
      toolListNotification = notificationScheduled ? 'scheduled' : 'unavailable';
      hostRefresh = runtimeReport.hostRefresh === 'scheduled'
        ? 'scheduled'
        : notificationScheduled ? 'notification' : 'unavailable';
    } else {
      // Codex snapshots deferred MCP schemas at turn start, so its SynaBun
      // process advertises the complete deferred catalog from the beginning.
      // Changing the focus profile updates runtime/UI state only; no tool-list
      // mutation or global MCP reload is needed.
      hostRefresh = 'not-needed';
    }
    return text(JSON.stringify({
      switched: true,
      changed: result.changed,
      profile: result.profile,
      enabled: result.enabled,
      disabled: result.disabled,
      totalTools: result.totalTools,
      scope: 'current-runtime',
      catalogMode: result.catalogMode,
      runtimeStatePersisted,
      runtimeStateReported: runtimeReport.reported,
      hostRefresh,
      toolListNotification,
      ...(runtimeReport.runtimeKind ? { runtimeKind: runtimeReport.runtimeKind } : {}),
      ...(runtimeReport.correlationId ? { refreshCorrelationId: runtimeReport.correlationId } : {}),
      ...(runtimeReport.error ? { refreshReportError: runtimeReport.error } : {}),
      note: result.catalogMode === 'deferred'
        ? 'The Codex focus profile changed. Its complete SynaBun catalog was already available through deferred tools, so no MCP reload was needed.'
        : hostRefresh === 'not-needed'
          ? 'This runtime already uses the requested profile.'
          : hostRefresh === 'unavailable'
            ? 'The runtime profile changed, but the host refresh could not be scheduled. Retry the switch or use the sidepanel selector.'
            : 'The runtime profile changed. The host tool refresh is queued; continue with the newly loaded tools.',
    }, null, 2));
  }

  return text(`Unknown action "${args.action}". Use "get" or "set".`);
}
