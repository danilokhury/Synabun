// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Context settings popover: what it shows (no DOM)
// ocp-v2-context-menu.js hands over a panel's plain values and renders what
// comes back: sections of [label, value] rows, where a third item is what the
// value says on hover. Nothing here is a guess: what OpenCode has not reported
// is said to be missing, and the context window is only ever the size the
// gauge read from the provider model's limit.context.
// ─────────────────────────────────────────────────────────────────────────────

import { updateNoticeText } from './ocp-v2-status-logic.js';
import { formatCost } from './ocp-v2-tools-logic.js';

export const NOT_REPORTED = 'Not reported yet';
const DASH = '—';

/** A value that stands for one OpenCode has not given: the popover shows it muted. */
export const isUnset = (value) => value === NOT_REPORTED || value === DASH;

// Share of the window from which the header cog carries a dot, and its stronger form.
export const PRESSURE_HIGH = 80;
export const PRESSURE_CRITICAL = 90;

// An MCP server's status as a word and the tone of its dot.
const MCP_STATES = {
  connected: ['Connected', 'ok'],
  disabled: ['Disabled', ''],
  failed: ['Failed', 'err'],
  needs_auth: ['Needs sign-in', 'warn'],
  needs_client_registration: ['Needs registration', 'warn'],
};

const exact = (n) => `${(Number(n) || 0).toLocaleString('en-US')} tokens`;

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

/**
 * The context in use against its window, from the store's `contextGauge`.
 * Without a window there is no share and no pressure.
 */
export function contextReading(gauge) {
  const g = gauge && typeof gauge === 'object' ? gauge : {};
  const used = Math.max(0, Number(g.usedTokens) || 0);
  const size = Math.max(0, Number(g.contextWindow) || 0);
  const pct = used > 0 && size > 0 ? Math.min(100, (used / size) * 100) : null;
  const pressure = pct == null ? '' : pct >= PRESSURE_CRITICAL ? 'critical' : pct >= PRESSURE_HIGH ? 'high' : '';
  return { used, size, pct, pressure };
}

// "provider/model" of the newest token block, else of the model the picker is on.
function modelLabel(gauge, model) {
  if (gauge?.model) return gauge.providerID ? `${gauge.providerID}/${gauge.model}` : String(gauge.model);
  if (typeof model === 'string') return model;
  const id = model?.modelID || model?.id || '';
  const provider = model?.providerID || '';
  return id ? (provider ? `${provider}/${id}` : String(id)) : '';
}

function compactView(c) {
  if (!c) return null;
  if (c.compacting) return { label: 'Compacting…', disabled: true, hint: 'Summarising the conversation.' };
  if (!c.hasSession) return { label: 'Compact', disabled: true, hint: 'No active session.' };
  if (c.running) return { label: 'Compact', disabled: true, hint: 'Available when the current turn finishes.' };
  return { label: 'Compact', disabled: false, hint: 'Summarises the conversation to free up context.' };
}

function serverRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.name).map((r) => {
    // A status this list does not know is shown as OpenCode sent it.
    const [word, tone] = MCP_STATES[r.status] || [String(r.status || 'Unknown'), ''];
    return {
      name: String(r.name),
      word,
      tone,
      tip: r.managed === true ? 'Managed by SynaBun' : (typeof r.error === 'string' ? r.error : ''),
    };
  });
}

const baseName = (path) => String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(path);

/** Everything the popover shows, as text. `d` is what the menu read from its panel. */
export function contextMenuModel(d = {}) {
  const r = contextReading(d.gauge);
  const breakdown = d.gauge?.breakdown && typeof d.gauge.breakdown === 'object' ? d.gauge.breakdown : {};
  const num = (v) => Math.max(0, Number(v) || 0);

  // The line under the bar: used / window on one side, the share on the other.
  // `headline` is the same reading as one string.
  const usage = r.used === 0
    ? NOT_REPORTED
    : r.pct == null
      ? `${fmtTokens(r.used)} tokens used`
      : `${fmtTokens(r.used)} / ${fmtTokens(r.size)} tokens`;
  const share = r.pct == null ? '' : `${Math.round(r.pct)}%`;
  const headline = share ? `${usage} (${share})` : usage;
  const windowTip = r.size ? `${exact(r.size)}, the context limit in the provider's model list` : '';

  const contextRows = [['Model', modelLabel(d.gauge, d.model) || DASH]];
  // The usage line carries the window; it has a row of its own only while that line cannot.
  if (r.pct == null) {
    contextRows.push(r.size
      ? ['Window', `${fmtTokens(r.size)} tokens`, windowTip]
      : ['Window', NOT_REPORTED, r.used > 0 ? 'The provider\'s model list has no context limit for this model.' : '']);
  }
  if (r.used > 0) {
    const input = num(breakdown.inputTokens);
    const cacheRead = num(breakdown.cacheReadTokens);
    const cacheWrite = num(breakdown.cacheWriteTokens);
    const output = num(breakdown.outputTokens);
    const reasoning = num(breakdown.reasoningTokens);
    if (input > 0) contextRows.push(['Input', `${fmtTokens(input)} tokens`, exact(input)]);
    if (cacheRead > 0 || cacheWrite > 0) {
      contextRows.push([
        'Cache',
        [cacheRead > 0 ? `${fmtTokens(cacheRead)} read` : '', cacheWrite > 0 ? `${fmtTokens(cacheWrite)} written` : ''].filter(Boolean).join(' · '),
        cacheRead > 0 ? `${Math.round((cacheRead / r.used) * 100)}% of the context read from cache` : exact(cacheWrite),
      ]);
    }
    if (output > 0) contextRows.push(['Output', `${fmtTokens(output)} tokens`, exact(output)]);
    if (reasoning > 0) contextRows.push(['Reasoning', `${fmtTokens(reasoning)} tokens`, exact(reasoning)]);
  }

  const mcp = d.mcp && typeof d.mcp === 'object' ? d.mcp : {};
  const servers = mcp.supported && mcp.loaded && !mcp.error ? serverRows(mcp.rows) : [];
  // Without servers the section still has its row: "MCP servers" and this.
  const toolsNote = servers.length
    ? null
    : !mcp.supported
      ? [NOT_REPORTED, 'Restart SynaBun to see MCP servers here.']
      : mcp.error
        ? [NOT_REPORTED, String(mcp.error)]
        : mcp.loaded ? ['None configured', ''] : [NOT_REPORTED, ''];

  const notice = updateNoticeText(d.updateAvailable, d.serverVersion);
  const versions = [['OpenCode', d.serverVersion ? String(d.serverVersion) : NOT_REPORTED]];
  if (notice) versions.push(['Update', `${String(d.updateAvailable).replace(/^v/i, '')} available`, notice]);
  versions.push(d.sdkVersion
    ? ['OpenCode SDK', String(d.sdkVersion), '@opencode-ai/sdk, the client SynaBun talks to OpenCode through']
    : ['OpenCode SDK', NOT_REPORTED, d.serverVersion ? 'Restart SynaBun to see the SDK version here.' : '']);

  const sessionId = d.sessionId ? String(d.sessionId) : '';
  const sessionRows = [
    d.folder ? ['Folder', baseName(d.folder), String(d.folder)] : ['Folder', DASH],
    ['Agent', d.agent ? String(d.agent) : DASH],
  ];
  if (sessionId) sessionRows.push(['Turns', String(num(d.turns))]);
  const cost = formatCost(d.cost);
  if (cost) sessionRows.push(['Cost', cost, 'Cost of this session as reported by OpenCode']);

  const autoOn = !!d.autoAccept?.on;
  const autoAccept = d.autoAccept ? {
    on: autoOn,
    disabled: !sessionId,
    word: autoOn ? 'On' : 'Off',
    hint: !sessionId
      ? 'No active session.'
      : autoOn
        ? 'Permission requests of this session are approved once without asking. Click to turn off.'
        : 'Approve this session\'s permission requests once without asking. Click to turn on.',
  } : null;

  return {
    pressure: r.pressure,
    context: { pct: r.pct == null ? null : Math.round(r.pct * 10) / 10, headline, usage, share, tip: share ? windowTip : '', rows: contextRows },
    compact: compactView(d.compact),
    tools: { servers, note: toolsNote, manage: !!d.canManage },
    versions,
    session: { id: sessionId, rows: sessionRows, autoAccept },
  };
}
