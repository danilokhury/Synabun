// ── Questions a sidepanel tab asks its live session ──
//
// One request/response pair on the socket (`session_request` → `session_response`)
// for the Query's control calls the panel shows as cards: context usage, plan
// usage, MCP server status and control, a rewind preview. The answers are
// trimmed here: the panel needs the numbers, not every tool description.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const text = (v, max = 300) => String(v ?? '').slice(0, max);
const top = (list, n, by = 'tokens') => (Array.isArray(list) ? [...list] : []).sort((a, b) => num(b?.[by]) - num(a?.[by])).slice(0, n);

export function slimContextUsage(r) {
  const o = r && typeof r === 'object' ? r : {};
  return {
    model: text(o.model, 120),
    totalTokens: num(o.totalTokens),
    maxTokens: num(o.maxTokens),
    rawMaxTokens: num(o.rawMaxTokens),
    percentage: num(o.percentage),
    autoCompact: { enabled: o.isAutoCompactEnabled === true, threshold: num(o.autoCompactThreshold) },
    categories: (Array.isArray(o.categories) ? o.categories : []).map(c => ({ name: text(c?.name, 80), tokens: num(c?.tokens), kind: text(c?.kind, 20), deferred: c?.isDeferred === true })),
    memoryFiles: top(o.memoryFiles, 12).map(f => ({ path: text(f?.path, 300), type: text(f?.type, 40), tokens: num(f?.tokens) })),
    mcpTools: top(o.mcpTools, 15).map(t => ({ name: text(t?.name, 120), server: text(t?.serverName, 80), tokens: num(t?.tokens), loaded: t?.isLoaded !== false })),
    mcpToolCount: Array.isArray(o.mcpTools) ? o.mcpTools.length : 0,
    agents: top(o.agents, 12).map(a => ({ name: text(a?.agentType, 80), source: text(a?.source, 40), tokens: num(a?.tokens) })),
    skills: o.skills ? { total: num(o.skills.totalSkills), included: num(o.skills.includedSkills), tokens: num(o.skills.tokens) } : null,
    slashCommands: o.slashCommands ? { total: num(o.slashCommands.totalCommands), included: num(o.slashCommands.includedCommands), tokens: num(o.slashCommands.tokens) } : null,
  };
}

const windowOf = (w) => (w && typeof w === 'object' ? { utilization: w.utilization == null ? null : num(w.utilization), resetsAt: w.resets_at || null } : null);

export function slimUsage(r) {
  const o = r && typeof r === 'object' ? r : {};
  const s = o.session && typeof o.session === 'object' ? o.session : {};
  const rl = o.rate_limits && typeof o.rate_limits === 'object' ? o.rate_limits : null;
  return {
    session: {
      costUsd: num(s.total_cost_usd),
      apiDurationMs: num(s.total_api_duration_ms),
      durationMs: num(s.total_duration_ms),
      linesAdded: num(s.total_lines_added),
      linesRemoved: num(s.total_lines_removed),
      models: Object.entries(s.model_usage && typeof s.model_usage === 'object' ? s.model_usage : {}).map(([model, u]) => ({
        model: text(model, 120),
        input: num(u?.inputTokens) + num(u?.cacheReadInputTokens) + num(u?.cacheCreationInputTokens),
        output: num(u?.outputTokens),
        costUsd: num(u?.costUSD),
      })),
    },
    subscription: o.subscription_type ? text(o.subscription_type, 60) : '',
    limitsAvailable: o.rate_limits_available === true && !!rl,
    limits: rl ? {
      fiveHour: windowOf(rl.five_hour),
      sevenDay: windowOf(rl.seven_day),
      sevenDayOpus: windowOf(rl.seven_day_opus),
      sevenDaySonnet: windowOf(rl.seven_day_sonnet),
      models: (Array.isArray(rl.model_scoped) ? rl.model_scoped : []).slice(0, 8).map(m => ({ name: text(m?.display_name, 80), ...windowOf(m) })),
      extraUsage: rl.extra_usage ? {
        enabled: rl.extra_usage.is_enabled === true,
        monthlyLimit: rl.extra_usage.monthly_limit == null ? null : num(rl.extra_usage.monthly_limit),
        used: rl.extra_usage.used_credits == null ? null : num(rl.extra_usage.used_credits),
        currency: rl.extra_usage.currency || '',
      } : null,
    } : null,
  };
}

export function slimMcpStatus(list) {
  return (Array.isArray(list) ? list : []).map(s => ({
    name: text(s?.name, 120),
    status: text(s?.status, 20),
    error: s?.error ? text(s.error, 400) : '',
    scope: text(s?.scope || s?.source || '', 40),
    version: s?.serverInfo?.version ? text(`${s.serverInfo.name || ''} ${s.serverInfo.version}`.trim(), 80) : '',
    toolCount: Array.isArray(s?.tools) ? s.tools.length : 0,
    tools: (Array.isArray(s?.tools) ? s.tools : []).slice(0, 60).map(t => text(t?.name, 100)),
  }));
}

export function slimRewind(r) {
  const o = r && typeof r === 'object' ? r : {};
  return {
    canRewind: o.canRewind !== false,
    error: o.error ? text(o.error, 300) : '',
    filesChanged: (Array.isArray(o.filesChanged) ? o.filesChanged : []).slice(0, 100).map(f => text(f, 400)),
    fileCount: Array.isArray(o.filesChanged) ? o.filesChanged.length : 0,
    insertions: num(o.insertions),
    deletions: num(o.deletions),
    skippedLinks: num(o.skippedLinks),
  };
}

// The experimental usage call is named so that hosts expect it to change: find
// it by its prefix instead of hard-coding the whole name.
function usageMethod(q) {
  if (!q) return null;
  for (const key of ['usage', 'getUsage']) if (typeof q[key] === 'function') return key;
  let proto = q;
  for (let depth = 0; proto && depth < 4; depth++, proto = Object.getPrototypeOf(proto)) {
    const hit = Object.getOwnPropertyNames(proto).find(k => k.startsWith('usage_') && typeof q[k] === 'function');
    if (hit) return hit;
  }
  return null;
}

// (`permission_rules` and `forget_session_rules` are answered by the bridge
// itself: they are about the session object, not a Query call.)
// (`mcp_set_servers` too: it needs the host's own server entries.)
export const SESSION_REQUESTS = ['context_usage', 'usage', 'mcp_status', 'mcp_reconnect', 'mcp_toggle', 'rewind_preview', 'permission_rules', 'forget_session_rules', 'mcp_set_servers', 'mcp_permission_mode'];

/**
 * Run one request against a live Query.
 * @returns the data for the session_response; throws with a message for the user.
 */
export async function runSessionRequest(q, what, args = {}) {
  if (!q) throw new Error('No active session. Send a message first.');
  const need = (name) => { if (typeof q[name] !== 'function') throw new Error('Not supported by this Claude Code version'); };
  switch (what) {
    case 'context_usage':
      need('getContextUsage');
      // `full` costs token-count calls: only when the user asked for it.
      return slimContextUsage(await q.getContextUsage({ detail: args.detail === 'full' ? 'full' : 'summary' }));
    case 'usage': {
      const method = usageMethod(q);
      if (!method) throw new Error('Not supported by this Claude Code version');
      return slimUsage(await q[method]({ skipBehaviors: true }));
    }
    case 'mcp_status':
      need('mcpServerStatus');
      return { servers: slimMcpStatus(await q.mcpServerStatus()) };
    case 'mcp_reconnect': {
      need('reconnectMcpServer');
      const name = String(args.serverName || '');
      if (!name) throw new Error('Missing server name');
      await q.reconnectMcpServer(name);
      return { servers: slimMcpStatus(await q.mcpServerStatus()) };
    }
    case 'mcp_toggle': {
      need('toggleMcpServer');
      const name = String(args.serverName || '');
      if (!name) throw new Error('Missing server name');
      await q.toggleMcpServer(name, args.enabled === true);
      return { servers: slimMcpStatus(await q.mcpServerStatus()) };
    }
    case 'mcp_permission_mode': {
      // Force a prompt for every call of one server ('default'), hand its calls
      // to the auto-mode classifier ('auto'), or clear the override (null).
      need('setMcpPermissionModeOverride');
      const name = String(args.serverName || '');
      if (!name) throw new Error('Missing server name');
      const mode = args.mode === 'default' || args.mode === 'auto' ? args.mode : null;
      const r = await q.setMcpPermissionModeOverride(name, mode);
      return { serverName: name, mode, warning: typeof r?.warning === 'string' ? r.warning.slice(0, 300) : '' };
    }
    case 'rewind_preview': {
      need('rewindFiles');
      const uuid = String(args.userMessageUuid || '');
      if (!uuid) throw new Error('Missing message id');
      return slimRewind(await q.rewindFiles(uuid, { dryRun: true }));
    }
    default:
      throw new Error(`Unknown request: ${what}`);
  }
}
