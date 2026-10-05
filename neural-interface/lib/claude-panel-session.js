// ── Per-tab session settings of the Claude sidepanel → SDK query options ──
//
// A panel tab sends its session settings with every query (`msg.session`). This
// module is the bridge's reading of them: validate, split into what is fixed
// when the CLI process starts and what can change on a live session, and apply
// to the options. Pure functions; the bridge calls them for panel sessions only.

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
const list = (v, max, itemMax) => (Array.isArray(v) ? v : []).map(x => str(x, itemMax)).filter(Boolean).slice(0, max);

const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_NAME = /^[A-Za-z][\w-]{0,63}$/;
const TOOL_NAME = /^[A-Za-z][\w-]{0,79}$/;

// MCP servers a tab adds for itself: remote ones only (http / sse, an http(s)
// URL). A stdio server is a command line, and a web panel is not where one is
// typed in; headers are not accepted either (a token would sit in the UI
// state in clear text): a server that needs them belongs in the settings files.
export function normalizeMcpServers(v) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(v) ? v : []) {
    if (!raw || typeof raw !== 'object') continue;
    const name = str(raw.name, 64);
    if (!MCP_NAME.test(name) || name.toLowerCase() === 'synabun' || seen.has(name.toLowerCase())) continue;
    let url;
    try { url = new URL(str(raw.url, 2000)); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const timeout = Number(raw.timeoutMs);
    seen.add(name.toLowerCase());
    out.push({
      name,
      type: raw.type === 'sse' ? 'sse' : 'http',
      url: url.href,
      alwaysLoad: raw.alwaysLoad === true,
      timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 3_600_000 ? Math.floor(timeout) : 0,
    });
    if (out.length >= 8) break;
  }
  return out;
}

// Subagents defined for one tab: { name: { description, prompt, tools?, model? } }.
function normalizeAgents(v) {
  const entries = Array.isArray(v) ? v.map(a => [a?.name, a]) : (v && typeof v === 'object' ? Object.entries(v) : []);
  const out = [];
  const seen = new Set();
  for (const [rawName, def] of entries) {
    const name = str(rawName, 64);
    if (!AGENT_NAME.test(name) || seen.has(name) || !def || typeof def !== 'object') continue;
    const description = str(def.description, 500);
    const prompt = str(def.prompt, 8000);
    if (!description || !prompt) continue;
    const agent = { name, description, prompt };
    // No `tools` means the agent inherits its parent's. A list is a restriction,
    // and stays one: empty is "no tools", and a list whose entries are all
    // unusable is empty too, never "inherit".
    if (Array.isArray(def.tools)) agent.tools = list(def.tools, 40, 80).filter(t => TOOL_NAME.test(t) || /^mcp__[\w-]+(__[\w-]+)?$/.test(t));
    const model = str(def.model, 120);
    if (model) agent.model = model;
    seen.add(name);
    out.push(agent);
    if (out.length >= 10) break;
  }
  return out;
}

// Settings a tab overrides for itself, from an allowlist: nothing that carries
// hooks, permissions, environment or credentials goes through here.
function normalizeOverlay(v) {
  const r = v && typeof v === 'object' ? v : {};
  return {
    language: str(r.language, 40),
    autoCompact: r.autoCompact === 'on' || r.autoCompact === 'off' ? r.autoCompact : 'default',
    promptCacheTtl: r.promptCacheTtl === '5m' || r.promptCacheTtl === '1h' ? r.promptCacheTtl : '',
    advisorModel: str(r.advisorModel, 120),
  };
}

/** The overlay as flag settings: only the keys the tab set. */
export function overlaySettings(overlay) {
  const o = normalizeOverlay(overlay);
  const settings = {};
  if (o.language) settings.language = o.language;
  if (o.autoCompact !== 'default') settings.autoCompactEnabled = o.autoCompact === 'on';
  if (o.promptCacheTtl) settings.promptCacheTtl = o.promptCacheTtl;
  if (o.advisorModel) settings.advisorModel = o.advisorModel;
  return settings;
}
const OVERLAY_KEYS = ['language', 'autoCompactEnabled', 'promptCacheTtl', 'advisorModel'];

/**
 * @returns {{ start: object, live: object }}
 *   `start`: needs a fresh process to change. `live`: applied with applyFlagSettings.
 */
export function normalizePanelSession(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const budget = Number(r.maxBudgetUsd);
  const turns = Number(r.maxTurns);
  const sandbox = r.sandbox && typeof r.sandbox === 'object' && r.sandbox.enabled === true
    ? { autoAllowBash: r.sandbox.autoAllowBash === true }
    : null;
  return {
    start: {
      fallbackModel: str(r.fallbackModel, 120),
      maxBudgetUsd: Number.isFinite(budget) && budget > 0 && budget <= 10_000 ? budget : 0,
      maxTurns: Number.isInteger(turns) && turns >= 1 && turns <= 1000 ? turns : 0,
      additionalDirectories: [...new Set(list(r.additionalDirectories, 10, 500))],
      // The parent of the working directory is readable by default (sibling
      // projects); a tab can remove that.
      includeParentDir: r.includeParentDir !== false,
      plugins: [...new Set(list(r.plugins, 10, 500))],
      strictMcp: r.strictMcp === true,
      systemPromptAppend: str(r.systemPromptAppend, 8000),
      sandbox,
      thinkingOff: r.thinking === 'off',
      // Extra message streams. Real hook events and prompt suggestions are on
      // unless the tab switched them off; subagent text too; the model-written
      // progress summaries of subagents cost tokens and are opt-in.
      hookEvents: r.hookEvents !== false,
      promptSuggestions: r.promptSuggestions !== false,
      subagentText: r.subagentText !== false,
      agentSummaries: r.agentSummaries === true,
      // Tools: rules approved without asking, tools removed, the built-in set
      // (empty = Claude Code's own), and what plan mode is told.
      allowedTools: [...new Set(list(r.allowedTools, 40, 200))],
      disallowedTools: [...new Set(list(r.disallowedTools, 40, 200))],
      tools: [...new Set(list(r.tools, 60, 80).filter(t => TOOL_NAME.test(t)))],
      planModeInstructions: str(r.planModeInstructions, 4000),
      // MCP: remote servers for this tab, and SynaBun's tools never deferred.
      mcpServers: normalizeMcpServers(r.mcpServers),
      synabunAlwaysLoad: r.synabunAlwaysLoad === true,
      // Subagents defined for this tab, and the skills the model may see (empty = all).
      agents: normalizeAgents(r.agents),
      skills: [...new Set(list(r.skills, 60, 120))],
      // A verbose log of the CLI process, written to a file the host names.
      debug: r.debug === true,
    },
    live: {
      fastMode: r.fastMode === true,
      outputStyle: str(r.outputStyle, 120),
      agent: str(r.agent, 120),
      overlay: normalizeOverlay(r.overlay),
    },
  };
}

/** The part that needs a fresh process, as a comparable string. */
export function startSignature(cfg) {
  return JSON.stringify(cfg?.start || {});
}

/**
 * The programmatic MCP server set of a session: the host's own entries (SynaBun,
 * a brain's extras) plus the tab's. Used at start and again by setMcpServers,
 * which replaces the whole dynamic set: the host's entries go in every time.
 * @returns {{ servers: object, notes: string[] }}
 */
export function mergeTabMcpServers(hostServers, start) {
  const servers = { ...(hostServers || {}) };
  const notes = [];
  const taken = new Set(Object.keys(servers).map(n => n.toLowerCase()));
  for (const sv of start?.mcpServers || []) {
    // The host's own entries (SynaBun) are never replaced by a tab's.
    if (taken.has(sv.name.toLowerCase())) { notes.push(`MCP server "${sv.name}" is already defined for this session: the tab's entry was not added.`); continue; }
    servers[sv.name] = { type: sv.type, url: sv.url, ...(sv.alwaysLoad ? { alwaysLoad: true } : {}), ...(sv.timeoutMs ? { timeout: sv.timeoutMs } : {}) };
    taken.add(sv.name.toLowerCase());
  }
  if (start?.synabunAlwaysLoad && servers.SynaBun) servers.SynaBun = { ...servers.SynaBun, alwaysLoad: true };
  return { servers, notes };
}

/**
 * Apply a tab's session settings to the options of a new query.
 * @param ctx.model         the model the query starts on
 * @param ctx.parentDir     the working directory's parent (already in options.additionalDirectories when granted)
 * @param ctx.validateDir   (path) => path|null, the bridge's working-directory check
 * @returns {string[]} notes for the user (a directory that does not exist, …)
 */
export function applyPanelSessionOptions(options, cfg, ctx = {}) {
  const notes = [];
  if (!cfg) return notes;
  const { start, live } = cfg;
  const valid = typeof ctx.validateDir === 'function' ? ctx.validateDir : (p) => p;

  if (start.fallbackModel && start.fallbackModel !== ctx.model) options.fallbackModel = start.fallbackModel;
  if (start.maxBudgetUsd > 0) options.maxBudgetUsd = start.maxBudgetUsd;
  if (start.maxTurns > 0) options.maxTurns = start.maxTurns;

  const dirs = start.includeParentDir ? [...(options.additionalDirectories || [])] : [];
  for (const dir of start.additionalDirectories) {
    if (valid(dir)) { if (!dirs.includes(dir)) dirs.push(dir); } else notes.push(`Directory not found, not added: ${dir}`);
  }
  if (dirs.length) options.additionalDirectories = dirs; else delete options.additionalDirectories;

  const plugins = [];
  for (const path of start.plugins) {
    if (valid(path)) plugins.push({ type: 'local', path }); else notes.push(`Plugin directory not found, not loaded: ${path}`);
  }
  if (plugins.length) options.plugins = plugins;

  // Only the servers this bridge passes itself (SynaBun): none from settings or .mcp.json.
  if (start.strictMcp) options.strictMcpConfig = true;
  if (start.systemPromptAppend) options.systemPrompt = { type: 'preset', preset: 'claude_code', append: start.systemPromptAppend };
  if (start.sandbox) {
    options.sandbox = {
      enabled: true,
      autoAllowBashIfSandboxed: start.sandbox.autoAllowBash,
      // SynaBun's MCP server and hooks are HTTP on this machine.
      network: { allowedDomains: ['localhost', '127.0.0.1'], allowLocalBinding: true },
    };
  }
  if (start.thinkingOff) options.thinking = { type: 'disabled' };
  if (start.hookEvents) options.includeHookEvents = true;
  if (start.promptSuggestions) options.promptSuggestions = true;
  if (start.subagentText) options.forwardSubagentText = true;
  if (start.agentSummaries) options.agentProgressSummaries = true;

  // Fast mode is always stated: Off is `false`, not an absent key, or a
  // `fastMode: true` in the user's settings would win while the panel says Off.
  if (start.allowedTools?.length) options.allowedTools = [...new Set([...(options.allowedTools || []), ...start.allowedTools])];
  if (start.disallowedTools?.length) options.disallowedTools = [...new Set([...(options.disallowedTools || []), ...start.disallowedTools])];
  // An empty list would switch every built-in tool off: only a real list is passed.
  if (start.tools?.length) options.tools = [...start.tools];
  if (start.planModeInstructions) options.planModeInstructions = start.planModeInstructions;

  if (start.mcpServers?.length || start.synabunAlwaysLoad) {
    const merged = mergeTabMcpServers(options.mcpServers, start);
    notes.push(...merged.notes);
    if (Object.keys(merged.servers).length) options.mcpServers = merged.servers;
  }

  if (start.agents?.length) {
    options.agents = { ...(options.agents || {}) };
    for (const a of start.agents) {
      options.agents[a.name] = { description: a.description, prompt: a.prompt, ...(a.tools ? { tools: [...a.tools] } : {}), ...(a.model ? { model: a.model } : {}) };
    }
  }
  if (start.skills?.length) options.skills = [...start.skills];
  if (start.debug) {
    if (ctx.debugFile) { options.debug = true; options.debugFile = ctx.debugFile; }
    else notes.push('The debug log is not available on this server: the session starts without it.');
  }

  const settings = { fastMode: live.fastMode === true, ...overlaySettings(live.overlay) };
  if (live.outputStyle) settings.outputStyle = live.outputStyle;
  if (Object.keys(settings).length) options.settings = settings;
  if (live.agent) options.agent = live.agent;
  return notes;
}

/**
 * What applyFlagSettings needs to move a live session from one set of live
 * settings to another (null clears a key), or null when nothing changed.
 */
export function liveSettingsPatch(prev, next) {
  const a = prev || { fastMode: false, outputStyle: '', agent: '' };
  const b = next || { fastMode: false, outputStyle: '', agent: '' };
  const patch = {};
  // false, not null: null removes the flag and restores the inherited setting.
  if (a.fastMode !== b.fastMode) patch.fastMode = b.fastMode === true;
  if (a.outputStyle !== b.outputStyle) patch.outputStyle = b.outputStyle || null;
  if (a.agent !== b.agent) patch.agent = b.agent || null;
  // The overlay: a key the tab set travels with its value, one it cleared goes
  // back to what the settings files say (null removes it from the flag layer).
  const before = overlaySettings(a.overlay);
  const after = overlaySettings(b.overlay);
  for (const key of OVERLAY_KEYS) {
    if (before[key] !== after[key]) patch[key] = key in after ? after[key] : null;
  }
  return Object.keys(patch).length ? patch : null;
}
