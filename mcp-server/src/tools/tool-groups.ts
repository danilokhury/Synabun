import { z } from 'zod/v3';
import { text } from './response.js';
import { isBrowserV2Enabled, reportRuntimeTools, type RuntimeToolsReport } from '../services/neural-interface.js';
import { ALWAYS_ON_TOOLS, GATED_GROUP_IDS, TOOL_GROUPS, sortGroups, toolsOfGroup } from '../services/tool-catalog.js';
import { resolveToolList, type AddedGroup } from '../services/tool-list.js';
import { legacyProfileValue, persistRuntimeTools, runtimeToolsWithExternalRefs, type ToolApplyResult, type ToolRuntime } from '../services/tool-runtime.js';

export const toolGroupsSchema = {
  action: z.enum(['get', 'add', 'set']).describe(
    'get = this runtime\'s groups, what they do on this host, and the catalog. add = load more groups for this runtime. set = replace this runtime\'s groups.'
  ),
  groups: z.array(z.string().min(1).max(72)).max(32).optional().describe(
    'Group ids for add and set, from the catalog that get returns, e.g. ["gsc"] or ["browser_whatsapp"]; "all" is every group. The memory tools, loop, tool_groups and choice are always there; agents, skills and computer follow your role and grants.'
  ),
};

export const toolGroupsDescription =
  'Always-available router for SynaBun\'s tool groups. When a task needs a SynaBun tool this runtime does not list, call action="get", then action="add" with the group that has it, and continue once the host refreshes its tools. On Codex and Claude Code every SynaBun tool is already reachable on demand, so there it only moves the focus and needs no reload. Do not report a SynaBun capability unavailable before trying this. A change affects only this runtime, never other sessions or the default for new ones.';

export interface RuntimeToolsChange {
  result: ToolApplyResult;
  persisted: string | null;
  report: RuntimeToolsReport;
  hostRefresh: 'scheduled' | 'notification' | 'unavailable' | 'not-needed';
  toolListNotification: 'scheduled' | 'unavailable' | 'not-needed';
}

/**
 * Change this runtime's groups: apply them (a list that could not be read is fixed by this, and the runtime
 * returns to its host's mode), save them for a restarted child of the same runtime, tell the Neural Interface,
 * and refresh the host. Never the default for new runtimes.
 */
export async function changeRuntimeTools(runtime: ToolRuntime, groups: readonly string[], added: AddedGroup[]): Promise<RuntimeToolsChange> {
  const result = runtime.apply({ groups: [...groups], added, listError: null, mode: runtime.getHostMode(), source: 'tool_groups' });
  const persisted = persistRuntimeTools(result.groups);
  const inBand = result.mode === 'strict' && runtime.hasInBandRefresh();
  const report = await reportRuntimeTools(runtimeToolsWithExternalRefs(result.groups), { mode: result.mode, legacyProfile: legacyProfileValue(result.groups), ...(inBand ? { refresh: 'in-band' as const } : {}) });
  if (result.mode === 'strict') {
    if (inBand) {
      // OpenCode supports list_changed, but snapshots its registry on each step. A delayed
      // notification/reconnect lets the next step capture stale tools. Keep the current HTTP
      // call alive while the host fetches the new schemas and its registry debounce settles.
      const refreshed = await runtime.refreshBeforeReply();
      return { result, persisted, report, toolListNotification: refreshed ? 'scheduled' : 'unavailable', hostRefresh: refreshed ? 'notification' : 'unavailable' };
    }
    // Always queue one notification, after this answer: a managed host may also reconnect, and repeating the same
    // groups is how a host whose tool list went stale is repaired, so it must not be a silent no-op.
    const scheduled = runtime.scheduleToolsChangedNotification();
    return {
      result, persisted, report,
      toolListNotification: scheduled ? 'scheduled' : 'unavailable',
      hostRefresh: report.hostRefresh === 'scheduled' ? 'scheduled' : scheduled ? 'notification' : 'unavailable',
    };
  }
  // A focus host already has every tool; only one coming back from an unreadable list changes what it advertises.
  if (!result.advertisedChanged) return { result, persisted, report, toolListNotification: 'not-needed', hostRefresh: 'not-needed' };
  const scheduled = runtime.scheduleToolsChangedNotification();
  return { result, persisted, report, toolListNotification: scheduled ? 'scheduled' : 'unavailable', hostRefresh: scheduled ? 'notification' : 'unavailable' };
}

/** The outcome as both tool answers report it. */
export function runtimeChangeFields(change: RuntimeToolsChange) {
  const { result, report } = change;
  return {
    changed: result.changed,
    enabled: result.enabled,
    disabled: result.disabled,
    totalTools: result.totalTools,
    scope: 'current-runtime' as const,
    runtimeStatePersisted: !!change.persisted,
    runtimeStateReported: report.reported,
    hostRefresh: change.hostRefresh,
    toolListNotification: change.toolListNotification,
    ...(report.runtimeKind ? { runtimeKind: report.runtimeKind } : {}),
    ...(report.correlationId ? { refreshCorrelationId: report.correlationId } : {}),
    ...(report.error ? { refreshReportError: report.error } : {}),
  };
}

function changeNote(change: RuntimeToolsChange): string {
  const groups = change.result.groups.join(', ') || 'memory tools only';
  if (change.result.mode === 'focus') {
    return change.result.advertisedChanged
      ? 'Every SynaBun tool is back; continue once the host refreshes its tool list.'
      : `Every SynaBun tool was already available; no reload needed. This runtime's focus is now: ${groups}.`;
  }
  if (change.hostRefresh === 'unavailable') {
    return `The groups changed here, but the host refresh could not be scheduled. Retry tool_groups; if the tools still do not appear, finish with "needs SynaBun tools: ${change.result.groups.join(', ')}".`;
  }
  return 'Loaded; continue after the refresh.';
}

/** Keep what the runtime added before for the groups it still has, then what this change added. */
function mergeAdded(previous: readonly AddedGroup[], next: readonly AddedGroup[], groups: readonly string[]): AddedGroup[] {
  const merged = new Map<string, AddedGroup>();
  for (const entry of [...previous, ...next]) if (groups.includes(entry.id) && !merged.has(entry.id)) merged.set(entry.id, entry);
  return [...merged.values()];
}

export function toolGroupsView(runtime: ToolRuntime) {
  const browserV2 = isBrowserV2Enabled();
  const active = runtime.getActiveGroups();
  const mode = runtime.getMode();
  const listError = runtime.getListError();
  return {
    groups: runtime.getGroups(),
    effect: mode,
    source: runtime.getSource(),
    added: runtime.getAdded(),
    listError,
    role: runtime.getRole(),
    gated: Object.fromEntries(GATED_GROUP_IDS.map((id) => [id, active.has(id)])),
    alwaysOn: [...ALWAYS_ON_TOOLS],
    totalTools: runtime.getAdvertisedToolCount(),
    catalog: TOOL_GROUPS.filter((group) => !group.gate).map((group) => ({
      id: group.id,
      label: group.label,
      purpose: group.purpose,
      count: toolsOfGroup(group.id, { browserV2 }).length,
      active: active.has(group.id),
    })),
    note: listError
      ? mode === 'strict'
        ? `This runtime could not read its tool list (${listError}), so it has memory tools only: set or add the groups it needs.`
        : `This runtime could not read its tool list (${listError}); every SynaBun tool is still reachable on demand. Set or add groups to give it a focus.`
      : mode === 'focus'
        ? 'This host reaches every SynaBun tool on demand; these groups are its focus, and add or set only moves it.'
        : 'This host has exactly these groups and the always-on tools; add a group to load it.',
  };
}

export async function handleToolGroups(runtime: ToolRuntime, args: { action: string; groups?: string[] }) {
  if (args.action === 'get') return text(JSON.stringify(toolGroupsView(runtime), null, 2));

  if (args.action === 'add' || args.action === 'set') {
    if (!Array.isArray(args.groups)) {
      return text(`Error: "groups" is required for action "${args.action}". Call action="get" for the catalog.`);
    }
    if (args.groups.some(item => item.startsWith('mcp:'))) return text(JSON.stringify({ ok: false, code: 'TOOLS_INVALID', message: 'External MCP servers are fixed for this run; dispatch again with those refs in tools.' }));
    const resolved = resolveToolList(args.groups, { source: 'runtime' });
    if (!resolved.ok) {
      return text(JSON.stringify({
        ok: false,
        code: resolved.code,
        problems: resolved.problems,
        message: `${resolved.message}. Call tool_groups action="get" for the catalog.`,
      }, null, 2));
    }
    const groups = args.action === 'add' ? sortGroups([...runtime.getGroups(), ...resolved.groups]) : resolved.groups;
    const added = args.action === 'add' ? mergeAdded(runtime.getAdded(), resolved.added, groups) : resolved.added;
    const change = await changeRuntimeTools(runtime, groups, added);
    return text(JSON.stringify({
      ok: true,
      action: args.action,
      groups: change.result.groups,
      added: change.result.added,
      effect: change.result.mode,
      ...runtimeChangeFields(change),
      note: changeNote(change),
    }, null, 2));
  }

  return text(`Unknown action "${args.action}". Use "get", "add" or "set".`);
}
