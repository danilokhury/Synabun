// ── Context settings popover: what it shows ──
// Pure (no DOM, no panel state): the monolith hands over a tab's plain values
// (_contextMenuData) and cp-context-menu.js renders what comes back. Nothing
// here is a guess: what the session has not reported is said to be missing,
// and a context window is shown only when something named it.

import { mcpRows } from './cp-usage-model.js';

export const NOT_REPORTED = 'Not reported yet';
const DASH = '—';

/** A value that stands for one the session has not given: the popover shows it muted. */
export const isUnset = (value) => value === NOT_REPORTED || value === DASH;

// Share of the window from which the header cog carries a dot, and its stronger form.
export const PRESSURE_HIGH = 80;
export const PRESSURE_CRITICAL = 90;

const WINDOW_SOURCES = { reported: 'reported by Claude Code', catalog: 'from the model list', id: 'from the model id' };
const MCP_WORDS = { connected: 'Connected', pending: 'Connecting', 'needs-auth': 'Needs sign-in', failed: 'Failed', disabled: 'Disabled', unknown: 'Unknown' };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** 216431 → "216k", 1000000 → "1M". Always formats a number. */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return (Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)) + 'M';
  }
  if (v >= 1000) return Math.round(v / 1000) + 'k';
  return String(v);
}

/** The name a server has inside a tool name: "claude.ai Docs" → "claude_ai_Docs". */
export function mcpServerKey(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Tools per MCP server, from the "mcp__<server>__<tool>" names system/init lists. */
export function mcpToolCounts(tools) {
  const counts = {};
  for (const name of Array.isArray(tools) ? tools : []) {
    const m = /^mcp__(.+?)__/.exec(String(name));
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return counts;
}

/**
 * The context in use against its window. `source` says what named the window
 * (contextWindowSource); without one there is no window, no share and no pressure.
 * Counts can come back from a stored snapshot: they are numbers before they are
 * added up.
 */
export function contextReading({ usage = null, window = 0, source = '' } = {}) {
  const u = usage || {};
  const cacheRead = Number(u.cacheRead) || 0;
  const cacheWrite = Number(u.cacheWrite) || 0;
  const used = (Number(u.inputTokens) || 0) + cacheRead + cacheWrite;
  const size = source ? Number(window) || 0 : 0;
  const pct = used > 0 && size > 0 ? Math.min(100, (used / size) * 100) : null;
  const pressure = pct == null ? '' : pct >= PRESSURE_CRITICAL ? 'critical' : pct >= PRESSURE_HIGH ? 'high' : '';
  return { used, size, source: size ? source : '', pct, pressure, cacheRead, cacheWrite, output: Number(u.outputTokens) || 0 };
}

function compactState({ compacting = false, running = false, connected = false } = {}) {
  if (compacting) return { label: 'Compacting…', disabled: true, hint: 'Summarising the conversation.' };
  if (!connected) return { label: 'Compact', disabled: true, hint: 'Not connected to a session.' };
  if (running) return { label: 'Compact', disabled: true, hint: 'Available when Claude finishes this turn.' };
  return { label: 'Compact', disabled: false, hint: 'Summarises the conversation to free up context.' };
}

function serverRows(servers, toolCounts) {
  const list = Array.isArray(servers) ? servers : [];
  const counts = toolCounts && typeof toolCounts === 'object' ? toolCounts : {};
  return mcpRows(list, { controls: false }).map((row) => {
    const raw = list.find(s => s?.name === row.name) || {};
    // The server's own count when the bridge sent one, else the tools init listed under its name.
    const n = raw.toolCount != null ? Number(raw.toolCount) : Array.isArray(raw.tools) ? raw.tools.length : Number(counts[mcpServerKey(row.name)]);
    return {
      name: row.name,
      tone: ['ok', 'warn', 'err'].includes(row.tone) ? row.tone : '',
      word: MCP_WORDS[row.status] || String(row.status),
      detail: Number.isFinite(n) && n >= 0 ? plural(n, 'tool') : '',
    };
  });
}

/**
 * Everything the popover shows, as text: sections of [label, value] rows; a
 * third item is what the value says on hover. `d` is _contextMenuData(tab, { full: true }).
 */
export function contextMenuModel(d = {}) {
  const r = contextReading(d);
  const init = d.init && typeof d.init === 'object' ? d.init : null;
  const count = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);

  // The line under the bar: used / window on one side, the share on the other,
  // what named the window on hover. `headline` is the same reading as one string.
  const windowTip = r.size ? `Window size ${WINDOW_SOURCES[r.source] || r.source}` : '';
  const usage = r.used === 0
    ? NOT_REPORTED
    : r.pct == null
      ? `${fmtTokens(r.used)} tokens used`
      : `${fmtTokens(r.used)} / ${fmtTokens(r.size)} tokens`;
  const share = r.pct == null ? '' : `${Math.round(r.pct)}%`;
  const headline = share ? `${usage} (${share})` : usage;

  const contextRows = [['Model', d.modelLabel || init?.model || DASH]];
  // The usage line carries the window; it has a row of its own only while that line cannot.
  if (r.pct == null) contextRows.push(r.size ? ['Window', `${fmtTokens(r.size)} tokens`, windowTip] : ['Window', NOT_REPORTED]);
  if (r.used > 0) {
    if (r.cacheRead > 0 || r.cacheWrite > 0) {
      const cache = ['Cache', [r.cacheRead > 0 ? `${fmtTokens(r.cacheRead)} read` : '', r.cacheWrite > 0 ? `${fmtTokens(r.cacheWrite)} written` : ''].filter(Boolean).join(' · ')];
      if (r.cacheRead > 0) cache.push(`${Math.round((r.cacheRead / r.used) * 100)}% of the context read from cache`);
      contextRows.push(cache);
    }
    if (r.output > 0) contextRows.push(['Output', `${fmtTokens(r.output)} tokens`]);
  }

  const servers = serverRows(d.mcpServers, d.toolCounts);
  const totals = [];
  if (count(init?.tools) > 0) totals.push(['Tools', String(count(init.tools))]);
  if (count(init?.skills) > 0) totals.push(['Skills', String(count(init.skills))]);
  if (count(d.slashCommands) > 0) totals.push(['Slash commands', String(count(d.slashCommands))]);
  if (count(init?.agents) > 0) totals.push(['Agents', String(count(init.agents))]);
  if (count(init?.plugins) > 0) totals.push(['Plugins', String(count(init.plugins))]);
  // Without servers the section still has its row: "MCP servers" and this.
  const toolsNote = servers.length ? '' : init ? 'None in this session' : NOT_REPORTED;

  const sessionRowsOut = [
    ['Folder', d.folder || DASH],
    ['Permission mode', d.mode || DASH],
  ];
  if (d.account) sessionRowsOut.push(['Account', String(d.account)]);
  const flags = Array.isArray(d.flags) ? d.flags.filter(Boolean) : [];
  if (flags.length) sessionRowsOut.push(['Settings', flags.join(' · ')]);
  if (d.limit) sessionRowsOut.push(['Usage limit', String(d.limit)]);
  const tasks = count(d.backgroundTasks);
  const scheduled = count(d.scheduled);
  if (tasks || scheduled) sessionRowsOut.push(['Background', [tasks ? plural(tasks, 'task') : '', scheduled ? `${scheduled} scheduled` : ''].filter(Boolean).join(' · ')]);
  if (d.sessionId) sessionRowsOut.push(['Turns', String(count(d.turns))]);
  if (Number(d.cost) > 0) sessionRowsOut.push(['Cost', `$${Number(d.cost).toFixed(2)}`]);

  return {
    pressure: r.pressure,
    context: { pct: r.pct == null ? null : Math.round(r.pct * 10) / 10, headline, usage, share, tip: share ? windowTip : '', rows: contextRows },
    compact: compactState(d),
    tools: { servers, totals, note: toolsNote },
    versions: [
      ['Claude Agent SDK', d.sdkVersion ? String(d.sdkVersion) : NOT_REPORTED],
      ['Claude Code', init?.cliVersion ? String(init.cliVersion) : NOT_REPORTED],
    ],
    session: { id: d.sessionId ? String(d.sessionId) : '', rows: sessionRowsOut, hasBackground: !!(tasks || scheduled) },
  };
}
