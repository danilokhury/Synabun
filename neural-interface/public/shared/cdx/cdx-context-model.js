// SynaBun — Codex Panel: Context settings popover, what it shows (no DOM)
//
// cdx-context-menu.js hands over the active tab's plain values and renders what
// comes back: sections of [label, value] rows, where a third item is what the
// value says on hover. Nothing here is a guess. The context in use and its
// window are the figures cdx-tabs.js already computed from Codex's
// thread/tokenUsage/updated (the window only ever the reported
// modelContextWindow); what Codex has not reported is said to be missing.

export const NOT_REPORTED = 'Not reported yet';
const DASH = '—';

/** A value that stands for one Codex has not given: the popover shows it muted. */
export const isUnset = (value) => value === NOT_REPORTED || value === DASH;

// Share of the window from which the header cog carries a dot, and its stronger form.
export const PRESSURE_HIGH = 80;
export const PRESSURE_CRITICAL = 90;

// An MCP server's status as a word and the tone of its dot.
const MCP_STATES = {
  ready: ['Connected', 'ok'],
  running: ['Connected', 'ok'],
  starting: ['Starting', 'run'],
  configured: ['Configured', ''],
  failed: ['Failed', 'err'],
  cancelled: ['Cancelled', 'err'],
  'login required': ['Needs sign-in', 'warn'],
};

const READING_STATES = {
  live: 'Live reading',
  'last known': 'Last known reading, from the saved thread',
  'read only': 'Read-only history: Codex reports usage on the next turn',
  stale: 'Stale reading',
  'live pending': 'Waiting for the first usage report of this thread',
  pending: 'Waiting for a usage report',
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 216431 → "216,431" in `locale` (the reader's own when none is given). */
export function formatCount(value, locale) {
  return Math.round(num(value)).toLocaleString(locale || undefined);
}

/**
 * The context in use against its window, from the reading cdx-tabs.js computed.
 * Without a reported window, or before any usage, there is no share and no pressure.
 */
export function contextReading(gauge) {
  const g = gauge && typeof gauge === 'object' ? gauge : {};
  const used = Math.floor(num(g.usedTokens));
  const size = Math.floor(num(g.contextWindow));
  const pct = used > 0 && size > 0 ? (used / size) * 100 : null;
  const pressure = pct == null ? '' : pct >= PRESSURE_CRITICAL ? 'critical' : pct >= PRESSURE_HIGH ? 'high' : '';
  return { used, size, pct, pressure };
}

// Compact is the panel's own compaction; the reasons are the ones its button gave.
function compactView(c) {
  if (!c) return null;
  const hint = c.compacting
    ? 'Compacting current thread context'
    : !c.hasThread
      ? 'Compaction becomes available after the first Codex turn'
      : !c.connected
        ? 'Connect Codex to compact this thread'
        : c.busy
          ? 'Cannot compact while Codex is processing'
          : 'Compact current thread context';
  return {
    label: c.compacting ? 'Compacting…' : 'Compact',
    disabled: !!(c.compacting || !c.hasThread || !c.connected || c.busy),
    hint,
  };
}

function serverRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.name)
    .map((r) => {
      const status = String(r.status || '').trim();
      // A status this list does not know is shown as Codex sent it.
      const [word, tone] = r.authRequired
        ? MCP_STATES['login required']
        : (MCP_STATES[status.toLowerCase()] || [status || 'Unknown', '']);
      const count = r.toolCount == null ? NaN : Number(r.toolCount);
      const detail = Number.isFinite(count) && count >= 0 ? `${count} ${count === 1 ? 'tool' : 'tools'}` : '';
      return {
        name: String(r.name),
        word: detail ? `${word} · ${detail}` : word,
        tone,
        tip: typeof r.error === 'string' ? r.error : '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const baseName = (path) => String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(path);

// One request's tokens, as the hover text of a row.
function breakdownTip(b, count) {
  if (!b) return '';
  return [
    `Input ${count(b.inputTokens)}`,
    `cached ${count(b.cachedInputTokens)}`,
    `output ${count(b.outputTokens)}`,
    `reasoning ${count(b.reasoningOutputTokens)}`,
  ].join(' · ');
}

/** Everything the popover shows, as text. `d` is what the menu read from the active tab. */
export function contextMenuModel(d = {}) {
  const gauge = d.gauge && typeof d.gauge === 'object' ? d.gauge : {};
  const r = contextReading(gauge);
  const count = (value) => formatCount(value, d.locale);
  const tokens = (value) => `${count(value)} tokens`;
  const config = d.config && typeof d.config === 'object' ? d.config : null;

  // The line under the bar: used / window on one side, the share on the other.
  // `headline` is the same reading as one string.
  const usage = r.used === 0
    ? NOT_REPORTED
    : r.pct == null
      ? `${count(r.used)} tokens used`
      : `${count(r.used)} / ${count(r.size)} tokens`;
  const share = r.pct == null ? '' : `${r.pct.toFixed(1)}%`;
  const headline = share ? `${usage} (${share})` : usage;
  const basis = gauge.basis === 'last' ? 'the input of the last request' : gauge.basis === 'total' ? 'the thread total (no last-request figure)' : '';
  const tip = [
    READING_STATES[gauge.state] || '',
    r.used > 0 && basis ? `Context in use: ${basis}` : '',
    r.size ? `Window: ${tokens(r.size)}, as Codex reported it` : '',
    gauge.updatedAt ? `Updated ${new Date(gauge.updatedAt).toLocaleString(d.locale || undefined)}` : '',
  ].filter(Boolean).join('\n');

  const model = gauge.model || d.model || config?.model || '';
  const contextRows = [['Model', model ? String(model) : DASH]];
  // The usage line carries the window; it has a row of its own only while that line cannot.
  if (r.pct == null) {
    contextRows.push(r.size
      ? ['Window', tokens(r.size), 'The context window Codex reported for this thread']
      : ['Window', NOT_REPORTED, r.used > 0 ? 'Codex has not reported a context window for this thread.' : '']);
  }
  if (r.used > 0) {
    const b = gauge.breakdown && typeof gauge.breakdown === 'object' ? gauge.breakdown : {};
    const cached = num(b.cachedInputTokens);
    const cacheWrite = num(b.cacheWriteInputTokens ?? b.cacheCreationInputTokens);
    const output = num(b.outputTokens);
    const reasoning = num(b.reasoningOutputTokens);
    // Input is the context in use; the cached part is counted inside it, never on top.
    contextRows.push(['Input', tokens(r.used), 'Everything sent with the request: the context in use']);
    if (cached > 0 || cacheWrite > 0) {
      contextRows.push([
        'Cached input',
        tokens(cached),
        [
          cached > 0 ? `${Math.min(100, Math.round((cached / r.used) * 100))}% of the input was read from cache` : '',
          cacheWrite > 0 ? `${tokens(cacheWrite)} written to cache` : '',
        ].filter(Boolean).join('\n'),
      ]);
    }
    if (output > 0) contextRows.push(['Output', tokens(output)]);
    if (reasoning > 0) contextRows.push(['Reasoning', tokens(reasoning)]);
    const last = gauge.last && typeof gauge.last === 'object' ? gauge.last : null;
    const lastTotal = last ? (num(last.totalTokens) || num(last.inputTokens) + num(last.outputTokens)) : 0;
    if (lastTotal > 0) contextRows.push(['Last turn', tokens(lastTotal), breakdownTip(last, count)]);
  }

  const mcp = d.mcp && typeof d.mcp === 'object' ? d.mcp : {};
  const servers = serverRows(mcp.rows);
  // Without servers the section still has its row: "MCP servers" and this.
  const toolsNote = servers.length
    ? null
    : mcp.loaded && !mcp.error
      ? ['None configured', 'Configure servers in ~/.codex/config.toml under [mcp_servers]']
      : [NOT_REPORTED, mcp.error ? String(mcp.error) : ''];

  const runtime = d.runtime && typeof d.runtime === 'object' ? d.runtime : null;
  const reported = !!(runtime && (runtime.cliVersion || runtime.sdkVersion || runtime.protocolBaseline));
  const versions = [
    ['Codex CLI', runtime?.cliVersion ? String(runtime.cliVersion) : NOT_REPORTED],
    runtime?.sdkVersion
      ? ['Codex SDK', String(runtime.sdkVersion), '@openai/codex-sdk, the client SynaBun automations run Codex through']
      : ['Codex SDK', reported ? 'Not installed' : NOT_REPORTED, reported ? '@openai/codex-sdk is not installed in SynaBun' : ''],
  ];
  if (runtime?.protocolBaseline) versions.push(['Protocol', String(runtime.protocolBaseline), 'The app-server protocol this panel speaks']);

  const threadId = d.threadId ? String(d.threadId) : '';
  // A setting Codex was asked for and has no value of its own for runs on Codex's default.
  const setting = (value) => (value ? String(value) : config?.loaded ? 'Codex default' : NOT_REPORTED);
  const settingTip = config?.loaded ? '' : (config?.error ? String(config.error) : '');
  const effort = d.effort && d.effort !== 'off' ? String(d.effort) : (config?.effort ? String(config.effort) : '');
  const sessionRows = [
    d.folder ? ['Folder', baseName(d.folder), String(d.folder)] : ['Folder', DASH],
    ['Effort', effort || 'Default', effort ? 'Reasoning effort' : 'Reasoning effort: the model\'s default'],
    ['Approval', setting(config?.approvalPolicy), settingTip || 'Approval policy in effect'],
    ['Sandbox', setting(config?.sandboxMode), settingTip || 'Sandbox mode in effect'],
  ];
  if (threadId) sessionRows.push(['Turns', String(Math.floor(num(d.turns))), 'Your messages in this transcript']);
  const cost = num(d.cost);
  if (cost > 0) sessionRows.push(['Cost', `~$${cost.toFixed(2)}`, 'Estimated cost based on token usage']);

  const account = d.account && typeof d.account === 'object'
    ? { label: String(d.account.label || 'Default'), tip: String(d.account.tip || 'Switch ChatGPT account for this tab') }
    : null;

  return {
    pressure: r.pressure,
    context: { pct: r.pct == null ? null : Math.min(100, Math.round(r.pct * 10) / 10), headline, usage, share, tip, rows: contextRows },
    compact: compactView(d.compact),
    tools: { servers, note: toolsNote, manage: !!d.canManage },
    versions,
    session: { id: threadId, rows: sessionRows, account, settings: !!d.canSettings },
  };
}
