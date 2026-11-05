// ── Who owns a browser tab, as the routes read it (DOM-free) ──
//
// Every automation that uses SynaBun's browser names itself in X-Synabun-Terminal (its MCP sends it on every
// request): a loop's terminal id, a native run's or a dispatched worker's run id, a sidepanel's owner key, an MCP
// process's client id, and `agent:<uuid>` for an automation-window agent (server.js launchAgentController). Before
// 2026-11-04 two routes only took `[A-Za-z0-9_-]`, so an agent's own id was read as no id at all: its recovery was
// filed under a random owner, and its next call was refused that tab as "claimed by another" (a create loop and an
// orphan tab per round). One test for every route: browserOwnerId(). The MCP side (mcp-server identity.ts
// sanitizePin) accepts the same characters.

/** The ids the server mints: letters, digits, `_`, `-`, and `:` (`agent:<uuid>`). No spaces, no template junk. */
export const BROWSER_OWNER_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;

/** `value` as an owner id, or null (absent, not a string, or not shaped like one the server mints). */
export function browserOwnerId(value) {
  return typeof value === 'string' && BROWSER_OWNER_ID_RE.test(value) ? value : null;
}

/**
 * The owner keys of one session as GET /api/browser/sessions shows them. The owner's own page (`reveal`) sees every
 * key (collision debugging). Anyone else sees its own key as it is and the other owners only as `other-1`, `other-2`…
 * in a stable order: an automation needs to know that another one holds a tab (never adopt it), not which run that is.
 * A run's key is what X-Synabun-Terminal names, so handing it out would let one agent speak as another run.
 * @param {Map<string,string>|null|undefined} tabOwners  owner key → tab id
 * @param {{ loops?: Iterable<string>, interactive?: Iterable<string>, agents?: Iterable<string> }} sets
 * @param {{ caller?: string|null, reveal?: boolean }} opts
 * @returns {{ tabOwners: Record<string,string>, owners: { loops: string[], interactive: string[], agents: string[] } }}
 */
export function listedOwners(tabOwners, { loops = [], interactive = [], agents = [] } = {}, { caller = null, reveal = false } = {}) {
  const tabEntries = tabOwners ? [...tabOwners] : [];
  const lists = { loops: [...loops], interactive: [...interactive], agents: [...agents] };
  if (reveal) return { tabOwners: Object.fromEntries(tabEntries), owners: lists };
  const labels = new Map();
  const label = (key) => {
    if (caller && key === caller) return key;
    if (!labels.has(key)) labels.set(key, `other-${labels.size + 1}`);
    return labels.get(key);
  };
  return {
    tabOwners: Object.fromEntries(tabEntries.map(([key, tabId]) => [label(key), tabId])),
    // An agent is listed by its agent id; its routing key is `agent:<id>`: the caller's own when it is that agent.
    owners: {
      loops: lists.loops.map(label),
      interactive: lists.interactive.map(label),
      agents: lists.agents.map((agentId) => (caller && caller === `agent:${agentId}` ? agentId : label(`agent:${agentId}`))),
    },
  };
}
