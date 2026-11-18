// ═══════════════════════════════════════════
// SynaBun Neural Interface — Settings → Tool permissions: the switch for every tool
// ═══════════════════════════════════════════
// The section's header has one switch for all of its groups, next to the total
// (ui-settings.js draws it and sends what this module says). It has three
// states, read from the tool switches themselves:
//
//   on     every tool is on            a click switches them all off
//   off    every tool is off           a click switches them all on
//   mixed  some are on                 a click switches them all on
//
// The groups of this section only: the social tools have their own section and
// their own "All". One request when the server takes several groups at once
// (`capabilities` of GET /api/claude-code/tool-permissions has `categories`);
// one request per group, in order, for a server from before that (public/ is
// reloaded at any time, the server only on a restart).
// No DOM, no imports: runs under node --test as well.

const K = 'settings.redesign.permissions.master';

/** 'on' | 'off' | 'mixed', or 'none' when the section has no tools. */
export function masterState(on, total) {
  const all = Number(total) || 0;
  const count = Math.max(0, Math.min(all, Number(on) || 0));
  if (all <= 0) return 'none';
  if (count === all) return 'on';
  return count === 0 ? 'off' : 'mixed';
}

/**
 * What the switch shows and what a click asks for.
 * @param {{ on: number, total: number }} counts
 * @param {{ tx: (key: string, params?: object) => string }} o
 * @returns {{ state: string, checked: 'true' | 'false' | 'mixed', enable: boolean, title: string, shown: boolean }}
 */
export function masterView({ on = 0, total = 0 } = {}, { tx = (key) => key } = {}) {
  const state = masterState(on, total);
  const shown = state !== 'none';
  return {
    state,
    shown,
    checked: state === 'on' ? 'true' : state === 'mixed' ? 'mixed' : 'false',
    // Everything on is the only state a click switches off: a mixed list is completed, never emptied.
    enable: state !== 'on',
    title: shown ? tx(`${K}.${state}`, { on: Math.max(0, Number(on) || 0), total: Number(total) || 0 }) : '',
  };
}

/** How many tools of these groups are on: `{ on, total }`. A tool the server did not answer for counts as on, as its row is drawn. */
export function countTools(categories, perms) {
  let on = 0, total = 0;
  for (const cat of Array.isArray(categories) ? categories : []) {
    for (const tool of Array.isArray(cat?.tools) ? cat.tools : []) {
      total++;
      if ((perms || {})[tool.key] !== false) on++;
    }
  }
  return { on, total };
}

/**
 * The bodies of the PUT /api/claude-code/tool-permissions requests that switch every tool of `categories`.
 * @param {{ categories: string[], enabled: boolean, capabilities?: string[] }} o
 */
export function masterRequests({ categories, enabled, capabilities } = {}) {
  const ids = [...new Set((Array.isArray(categories) ? categories : []).filter((id) => typeof id === 'string' && id))];
  if (!ids.length || typeof enabled !== 'boolean') return [];
  if (Array.isArray(capabilities) && capabilities.includes('categories')) return [{ categories: ids, enabled }];
  return ids.map((category) => ({ category, enabled }));
}
