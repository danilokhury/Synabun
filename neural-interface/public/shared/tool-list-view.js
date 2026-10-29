// DOM-free presentation of the server's catalog. No second group/count/preset table.
export const TOOL_LIST_COPY = Object.freeze({
  label: 'Tools and MCP servers',
  defaultTools: 'Default tools',
  default: 'Default',
  templateDefault: 'Template default',
  noOverride: 'No override',
  all: 'All SynaBun tools',
  alwaysOn: 'Always-on tools',
  count: '{count} tools',
  countOne: '{count} tool',
  browser: 'Browser and social',
  workspace: 'Workspace',
  other: 'Other',
  addedBrowser: 'Added for browser use',
  addedDesign: 'Added for design work',
  focus: 'Loads every SynaBun tool on demand.',
  strict: 'Loads the selected SynaBun groups.',
  future: 'Applies to future runtimes. Running sessions keep their own tools.',
  servers: 'Your other MCP servers',
  allServers: 'All my servers',
  configuredExternally: 'Configured in provider',
  noServers: 'No external servers',
  blockedServer: 'Blocked by Agents may use it',
  unavailableServer: 'Unavailable on this provider',
  agentAccess: 'Agents may use it',
  agentAccessHelp: 'Applies to task workers and automations on Codex, OpenCode and Claude, including FleetView, plus the OpenCode tools picker. Other sessions you drive keep their servers.',
  loadFailed: 'Could not load the tool catalog. Try again.',
  saveFailed: 'Could not save the tool list. Try again.',
  saved: 'Default tools saved.',
  reloadFailed: 'OpenCode could not reload the requested tools.',
});

export function toolListWord(key, params = {}, translate) {
  const full = `toolList.${key}`;
  let translated;
  try { translated = translate?.(full, params); } catch {}
  const text = typeof translated === 'string' && translated !== full ? translated : TOOL_LIST_COPY[key] || key;
  return text.replace(/\{(\w+)\}/g, (whole, name) => params[name] ?? whole);
}

function groupWord(group, field, translate) {
  const key = `toolGroups.${group.id}.${field}`;
  try { const value = translate?.(key); if (typeof value === 'string' && value && value !== key) return value; } catch {}
  return group[field];
}

export const strictToolHost = provider => provider === 'opencode' || provider === 'gemini';
export const taskToolHost = provider => strictToolHost(provider) || provider === 'claude-code' || provider === 'codex';

/** Hidden-input encoding: inheritance differs from an explicit empty group list. */
export function toolListInput(tools) {
  return tools == null ? '__inherit__' : tools.join(',');
}
export function toolsFromInput(value, { inherit = true, externalSelection = false } = {}) {
  if (value == null || String(value).split(',').includes('__inherit__')) return inherit ? null : (externalSelection ? [] : ['mcp:*']);
  const items = String(value).split(',').filter(id => id && id !== 'memory' && id !== '__no_servers__');
  return [...new Set([...items, ...(!externalSelection && !items.some(id => id.startsWith('mcp:')) ? ['mcp:*'] : [])])];
}

export function toolListView(catalog, tools, { inheritLabel = null, usesBrowser, taskClass,
  provider = 'opencode', translate, includeServers = true } = {}) {
  const word = (key, params) => toolListWord(key, params, translate);
  const inherited = tools == null;
  const source = inherited ? catalog?.defaultTools ?? catalog?.default ?? [] : tools;
  const refs = source.filter(id => id.startsWith('mcp:'));
  const requested = source.filter(id => !id.startsWith('mcp:'));
  const all = requested.includes('all');
  const groups = catalog?.groups || [];
  const chosen = new Set(all ? groups.map(g => g.id) : requested);
  const added = [];
  const add = (id, why) => { if (groups.some(g => g.id === id) && !chosen.has(id)) { chosen.add(id); added.push({ id, why }); } };
  if (usesBrowser || groups.some(g => chosen.has(g.id) && g.browser) || (taskClass === 'design' && usesBrowser !== false)) add('browser', 'addedBrowser');
  if (taskClass === 'design') { add('image', 'addedDesign'); add('styleguide', 'addedDesign'); }
  const entries = [];
  if (inheritLabel) entries.push({ value: '__inherit__', label: inheritLabel, exclusive: true, selected: inherited });
  entries.push({ value: 'all', label: word('all'), caption: catalog?.effect?.[provider] === 'focus' ? word('focus') : null, exclusive: true, scope: 'groups', selected: !inherited && all });
  // A real value for explicit always-on avoids conflating it with the exclusive inheritance row.
  entries.push({ value: 'memory', label: word('alwaysOn'), exclusive: true, scope: 'groups', selected: !inherited && !requested.length });
  for (const section of ['browser', 'workspace', 'other']) {
    const options = groups.filter(g => g.section === section).map(g => {
      const automatic = added.find(a => a.id === g.id);
      return { value: g.id, scope: 'groups', label: `${groupWord(g, 'label', translate)} · ${word(g.count === 1 ? 'countOne' : 'count', { count: g.count })}`,
        caption: automatic ? word(automatic.why) : groupWord(g, 'purpose', translate),
        selected: (!inherited && !all && chosen.has(g.id)) || !!automatic,
        disabled: !!automatic, automatic: !!automatic };
    });
    if (options.length) entries.push({ group: word(section), options });
  }
  if (includeServers && provider !== 'gemini' && catalog?.externalServersVersion >= 2) {
    const wildcard = refs.includes('mcp:*');
    const rows = (catalog.servers || []).filter(row => row.selectable !== false);
    // A saved unavailable ref stays visible and round-trips; loading a catalog never silently clears it.
    for (const ref of refs) if (ref !== 'mcp:*' && !rows.some(row => row.ref === ref)) rows.push({ ref, label: ref.slice(4), providers: {} });
    const options = [
      { value: 'mcp:*', scope: 'servers', label: word('allServers'), exclusive: true, selected: !inherited && wildcard },
      { value: '__no_servers__', scope: 'servers', label: word('noServers'), exclusive: true, selected: !inherited && !refs.length },
      ...rows.map(row => {
        const availability = row.providers?.[provider];
        const unavailable = provider && provider !== 'all' ? availability !== 'deliverable' : !Object.values(row.providers || {}).includes('deliverable');
        return { value: row.ref, scope: 'servers', label: row.label || row.ref.slice(4), selected: !inherited && !wildcard && refs.includes(row.ref), disabled: row.blocked || unavailable, caption: row.blocked ? word('blockedServer') : unavailable ? word('unavailableServer') : row.ref };
      }),
    ];
    entries.push({ group: word('servers'), options });
  }
  const count = (catalog?.alwaysOn || 0) + groups.filter(g => chosen.has(g.id)).reduce((n, g) => n + g.count, 0);
  const labels = groups.filter(g => chosen.has(g.id)).map(g => groupWord(g, 'label', translate));
  const short = all ? word('all') : labels.length ? `${labels.slice(0, 2).join(', ')}${labels.length > 2 ? ` +${labels.length - 2}` : ''}` : word('alwaysOn');
  const serverLabel = refs.length ? ` · ${refs.includes('mcp:*') ? word('allServers') : refs.map(ref => ref.slice(4)).join(', ')}` : '';
  const summary = `${inherited ? `${inheritLabel || word('default')} · ` : ''}${short} · ${word('count', { count })}${serverLabel}`;
  return { entries, summary, count, added, groups: [...chosen], effect: catalog?.effect?.[provider] || (strictToolHost(provider) ? 'strict' : 'focus') };
}
