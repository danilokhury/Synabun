// Assistant tool selections share the MCP catalog; no provider-specific preset table.
import { DEFAULT_TOOLS, isBrowserGroup, toolCatalogView } from '../../mcp-server/dist/services/tool-catalog.js';
import { resolveToolList } from '../../mcp-server/dist/services/tool-list.js';
import { requireToolList } from './tool-lists.js';

export const OPENCODE_BRAIN_TOOLS = Object.freeze(requireToolList(resolveToolList([...DEFAULT_TOOLS.filter(id => id !== 'git'), 'browser'], { source: 'runtime' })).items);

export function dispatchTools(spec = {}) {
  if (spec.mcpProfile !== undefined || spec.mcp_profile !== undefined) {
    throw Object.assign(new Error('MCP profiles were removed; pass tools: [group ids].'), { code: 'MCP_PROFILE_REMOVED', status: 400 });
  }
  if (spec.tools !== undefined && !Array.isArray(spec.tools)) {
    throw Object.assign(new Error('tools must be an array of group ids'), { code: 'TOOLS_INVALID', status: 400 });
  }
  return requireToolList(resolveToolList(spec.tools, {
    source: 'dispatch', provider: spec.provider, usesBrowser: spec.usesBrowser, taskClass: spec.taskClass,
  }));
}

export function browserToolsConflict(spec) {
  dispatchTools(spec);
  // Test the named list, before automatic browser/design additions.
  const named = requireToolList(resolveToolList(spec.tools ?? [], { source: 'runtime' }));
  const browser = named.groups.filter(isBrowserGroup);
  return spec.usesBrowser === false && browser.length
    ? `uses_browser is false but tools names browser groups (${browser.join(', ')}); drop them or set uses_browser to true.`
    : null;
}

/** Capture additions too, so restarts launch exactly the same selection. */
export function launchTools(selection) {
  return requireToolList(resolveToolList([...selection.items, ...selection.added.map(item => item.id)], { source: 'runtime' })).items;
}

export function toolsView(entry) {
  const selected = dispatchTools({ tools: entry.toolsRequested ?? undefined, provider: entry.provider, usesBrowser: entry.usesBrowser, taskClass: entry.taskClass });
  const current = requireToolList(resolveToolList(entry.tools ?? launchTools(selected), { source: 'runtime', provider: entry.provider }));
  const label = entry.provider === 'claude-code' ? 'Claude Code' : entry.provider === 'codex' ? 'Codex' : entry.provider || 'This worker';
  return { requested: entry.toolsRequested ?? null, groups: current.groups, added: selected.added, effect: current.effect, count: current.count, servers: entry.externalServers?.names || [], disabledServers: entry.externalServers?.disabled || [],
    note: current.effect === 'focus' ? `${label} reaches every SynaBun tool on demand; this list is its focus.` : 'Loads exactly these SynaBun groups, plus always-on tools and role/grant tools.' };
}

/** Public dispatch is tools-only, including requests that also contain a valid array. */
export function dispatchInput(body) {
  dispatchTools(body);
  return { ...body };
}

export function workerToolsLine(catalog = toolCatalogView()) {
  return `SynaBun tools for workers: pass tools: [group ids] on agent_dispatch. Always there: ${catalog.alwaysOnTools.join(', ')}. With no tools a worker gets ${catalog.default.join(', ')}. Groups: ${catalog.groups.map(group => `${group.id} (${group.count})`).join(' · ')}. Host effect: ${Object.entries(catalog.effect).map(([host, effect]) => `${host}: ${effect}`).join(', ')}. Strict hosts load exactly those groups; Claude Code and Codex always reach every SynaBun tool on demand and the list only sets their focus. Never assume a Claude Code or Codex worker lacks a group you left out. Your MCP servers: name them as mcp:<name> in tools (or mcp:* for all allowed servers). Every unnamed external server is off for that worker on every supported provider. Available server refs: ${(catalog.servers || []).filter(row => row.selectable !== false).map(row => row.ref).join(', ') || 'none listed'}.`;
}
