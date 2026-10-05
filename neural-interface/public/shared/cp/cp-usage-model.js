// ── Context usage, plan usage, MCP servers, rewind preview → rows (DOM-free) ──
// The bridge answers `session_request` with trimmed data (lib/claude-panel-requests.js);
// these functions turn it into the rows and sentences the cards show.

import { fmtTokens, fmtDuration, fmtResetTime } from './cp-events.js';

// A limit window's utilisation as the SDK reports it: already a percentage,
// 0-100 (SDKControlGetUsageResponse in sdk.d.ts), or null when there is no data.
// 1 is one percent; null is "unavailable", never 0%.
const pct = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n > 0 && n < 1 ? Math.max(0.1, Math.round(n * 10) / 10) : Math.round(n);
};

/** /context: headline, category rows, and the largest contributors. */
export function contextCard(data) {
  const d = data && typeof data === 'object' ? data : {};
  const max = Number(d.maxTokens) || 0;
  const total = Number(d.totalTokens) || 0;
  const percentage = max > 0 ? Math.round((total / max) * 100) : Math.round(Number(d.percentage) || 0);
  const rows = [];
  for (const c of Array.isArray(d.categories) ? d.categories : []) {
    if (!c?.name || c.kind === 'free') continue;
    const share = max > 0 ? ` (${Math.max(0, Math.round((c.tokens / max) * 1000) / 10)}%)` : '';
    // The CLI's own names for deferred categories already say so ("MCP tools (deferred)").
    const label = c.deferred && !/\(deferred\)/i.test(c.name) ? `${c.name} (deferred)` : c.name;
    rows.push([label, `${fmtTokens(c.tokens)}${share}`, c.kind === 'buffer' ? 'muted' : '']);
  }
  const free = (Array.isArray(d.categories) ? d.categories : []).find(c => c?.kind === 'free');
  if (free) rows.push(['Free', fmtTokens(free.tokens), 'ok']);
  const notes = [];
  if (d.autoCompact?.enabled && d.autoCompact.threshold > 0) notes.push(`Auto-compact at ${fmtTokens(d.autoCompact.threshold)} tokens.`);
  else if (d.autoCompact && !d.autoCompact.enabled) notes.push('Auto-compact is off.');
  const sections = [];
  const list = (label, items, fmt) => { if (items?.length) sections.push({ label, rows: items.map(fmt) }); };
  list('Memory files', d.memoryFiles, f => [f.path, fmtTokens(f.tokens)]);
  list(`MCP tools${d.mcpToolCount > (d.mcpTools?.length || 0) ? ` (largest ${d.mcpTools.length} of ${d.mcpToolCount})` : ''}`, d.mcpTools, t => [`${t.server ? `${t.server}: ` : ''}${t.name}${t.loaded ? '' : ' (deferred)'}`, fmtTokens(t.tokens)]);
  list('Agents', d.agents, a => [`${a.name}${a.source ? ` (${a.source})` : ''}`, fmtTokens(a.tokens)]);
  if (d.skills) sections.push({ label: 'Skills', rows: [[`${d.skills.included} of ${d.skills.total} listed`, fmtTokens(d.skills.tokens)]] });
  return {
    headline: `${fmtTokens(total)} of ${fmtTokens(max)} tokens (${percentage}%)${d.model ? ` · ${d.model}` : ''}`,
    percentage,
    rows,
    notes,
    sections,
  };
}

function limitRow(label, w, now) {
  if (!w) return null;
  const p = pct(w.utilization);
  const resets = w.resetsAt ? fmtResetTime(Date.parse(w.resetsAt), now) : '';
  if (p == null && !resets) return null;
  return [label, `${p != null ? `${p}% used` : 'no data'}${resets ? ` · resets ${resets}` : ''}`, p != null && p >= 90 ? 'warn' : ''];
}

/** /usage: this session's totals and the plan's limit windows. */
export function usageCard(data, now = Date.now()) {
  const d = data && typeof data === 'object' ? data : {};
  const s = d.session || {};
  const session = [];
  if (s.costUsd > 0) session.push(['Cost', `$${s.costUsd.toFixed(4)}`, '']);
  if (s.durationMs > 0) session.push(['Duration', `${fmtDuration(s.durationMs)}${s.apiDurationMs > 0 ? ` (${fmtDuration(s.apiDurationMs)} in API calls)` : ''}`, '']);
  if (s.linesAdded || s.linesRemoved) session.push(['Lines changed', `+${s.linesAdded || 0} −${s.linesRemoved || 0}`, '']);
  for (const m of Array.isArray(s.models) ? s.models : []) session.push([m.model, `${fmtTokens(m.input)} in · ${fmtTokens(m.output)} out${m.costUsd > 0 ? ` · $${m.costUsd.toFixed(4)}` : ''}`, '']);
  const limits = [];
  if (d.limitsAvailable && d.limits) {
    const l = d.limits;
    for (const row of [limitRow('5-hour limit', l.fiveHour, now), limitRow('Weekly limit', l.sevenDay, now), limitRow('Weekly Opus limit', l.sevenDayOpus, now), limitRow('Weekly Sonnet limit', l.sevenDaySonnet, now)]) if (row) limits.push(row);
    for (const m of l.models || []) { const row = limitRow(m.name, m, now); if (row) limits.push(row); }
    if (l.extraUsage) {
      const e = l.extraUsage;
      limits.push(['Extra usage', e.enabled ? `on${e.used != null ? ` · ${e.used} used` : ''}${e.monthlyLimit != null ? ` of ${e.monthlyLimit}` : ''}${e.currency ? ` ${e.currency}` : ''}` : 'off', '']);
    }
  }
  return {
    session,
    limits,
    plan: d.subscription || '',
    limitsNote: d.limitsAvailable ? '' : 'Plan limits do not apply to this session (API key or cloud provider).',
  };
}

const MCP_TONE = { connected: 'ok', pending: 'warn', 'needs-auth': 'warn', failed: 'err', disabled: 'muted' };

/** /mcp: one entry per server, with what can be done about it. */
export function mcpRows(servers, { controls = true } = {}) {
  return (Array.isArray(servers) ? servers : []).map((s) => {
    const status = s?.status || 'unknown';
    return {
      name: s?.name || '',
      status,
      tone: MCP_TONE[status] || 'warn',
      detail: [s?.scope, s?.version, s?.toolCount != null ? `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
      error: s?.error || (status === 'needs-auth' ? 'Needs sign-in. Run `claude mcp` in a terminal, or the server\'s own sign-in flow.' : ''),
      // `controls: false`: nothing can act on the list (no live session, or a
      // server that cannot take the request), so no button is offered.
      canReconnect: controls && (status === 'failed' || status === 'needs-auth' || status === 'pending'),
      canDisable: controls && status !== 'disabled',
      canEnable: controls && status === 'disabled',
    };
  }).filter(r => r.name);
}

/** What a rewind to a message would change, in one sentence. */
export function rewindPreviewText(r) {
  const d = r && typeof r === 'object' ? r : {};
  if (d.canRewind === false) return d.error || 'No checkpoint for this message: files cannot be rewound to it.';
  const n = Number(d.fileCount) || (Array.isArray(d.filesChanged) ? d.filesChanged.length : 0);
  if (!n) return 'No file would change: nothing was edited after this message.';
  const names = (d.filesChanged || []).slice(0, 4).map(f => String(f).split(/[/\\]/).pop());
  const more = n > names.length ? `, +${n - names.length} more` : '';
  const skipped = Number(d.skippedLinks) > 0 ? ` ${d.skippedLinks} link${d.skippedLinks === 1 ? '' : 's'} would be skipped.` : '';
  return `${n} file${n === 1 ? '' : 's'} would be restored (+${d.insertions || 0} −${d.deletions || 0} lines): ${names.join(', ')}${more}.${skipped}`;
}

export function rewindResultText(msg) {
  const n = Number(msg?.fileCount);
  if (!Number.isFinite(n)) return 'Files rewound to checkpoint';
  if (!n) return 'Rewound: no file needed to change.';
  return `Files rewound: ${n} file${n === 1 ? '' : 's'} restored (+${msg.insertions || 0} −${msg.deletions || 0} lines).`;
}
