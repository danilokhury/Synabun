// ── A tab's session settings (DOM-free) ──
// What a Claude Code session can be started or switched with beyond model,
// effort and permission mode: a fallback model, spend and turn limits, extra
// directories, local plugins, MCP strictness, standing instructions, the
// sandbox, thinking, fast mode, the output style, a main-thread agent.
// The tab keeps one object; every query sends it (`msg.session`), and the
// bridge validates it again (lib/claude-panel-session.js).

export const SESSION_DEFAULTS = Object.freeze({
  fastMode: false,
  thinking: 'default',          // 'default' | 'off'
  outputStyle: '',
  agent: '',
  fallbackModel: '',
  maxBudgetUsd: 0,
  maxTurns: 0,
  additionalDirectories: [],
  includeParentDir: true,
  plugins: [],
  strictMcp: false,
  systemPromptAppend: '',
  sandbox: { enabled: false, autoAllowBash: false },
  hookEvents: true,             // real hook events in the hook strip
  promptSuggestions: true,      // a suggested next prompt after each turn
  subagentText: true,           // what a subagent says, inside its card
  agentSummaries: false,        // model-written progress lines for subagents (costs tokens)
  // Advanced (a bridge with `session_settings_v2`):
  allowedTools: [],             // permission rules approved without asking, e.g. Bash(npm test:*)
  disallowedTools: [],          // tools removed from the session
  tools: [],                    // the built-in tools on offer (empty = Claude Code's own set)
  planModeInstructions: '',
  mcpServers: [],               // [{ name, type: 'http'|'sse', url, alwaysLoad, timeoutMs }] remote servers for this tab
  synabunAlwaysLoad: false,     // SynaBun's tools always in the prompt, never deferred behind tool search
  agents: [],                   // [{ name, description, prompt, tools?, model? }] subagents defined for this tab
  skills: [],                   // the skills the model may see (empty = all)
  debug: false,                 // a verbose log of the CLI process, in a file
  overlay: { language: '', autoCompact: 'default', promptCacheTtl: '', advisorModel: '' },
});

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** One path per line (or separated by commas), without blanks or duplicates. */
export function parseList(value, max = 10) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  return [...new Set(items.map(s => String(s).trim()).filter(Boolean))].slice(0, max);
}

// ── Advanced fields: text the card edits ⇄ the values the session keeps ──

const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_NAME = /^[A-Za-z][\w-]{0,63}$/;
// A built-in tool (Read) or an MCP tool (mcp__server or mcp__server__tool): what the bridge accepts.
const TOOL_NAME = /^(?:[A-Za-z][\w-]{0,79}|mcp__[\w-]+(?:__[\w-]+)?)$/;

function cleanMcpServer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 64);
  if (!MCP_NAME.test(name) || name.toLowerCase() === 'synabun') return null;
  let url;
  try { url = new URL(text(raw.url, 2000)); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const timeout = Number(raw.timeoutMs);
  return { name, type: raw.type === 'sse' ? 'sse' : 'http', url: url.href, alwaysLoad: raw.alwaysLoad === true, timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 3_600_000 ? Math.floor(timeout) : 0 };
}

/**
 * One server per line: `name url [sse] [always] [timeout=60]` (timeout in seconds).
 * @returns {{ servers: object[], errors: string[] }}
 */
export function parseMcpServerLines(value) {
  const servers = [];
  const errors = [];
  const seen = new Set();
  for (const line of String(value || '').split('\n').map(l => l.trim()).filter(Boolean)) {
    const [name, url, ...flags] = line.split(/\s+/);
    const timeout = flags.map(f => /^timeout=(\d+)$/i.exec(f)).find(Boolean);
    const server = cleanMcpServer({ name, url, type: flags.some(f => /^sse$/i.test(f)) ? 'sse' : 'http', alwaysLoad: flags.some(f => /^always$/i.test(f)), timeoutMs: timeout ? Number(timeout[1]) * 1000 : 0 });
    if (!server) { errors.push(`"${line.length > 60 ? `${line.slice(0, 59)}…` : line}": use a name (letters, digits, - or _; not SynaBun) and an http(s) URL`); continue; }
    if (seen.has(server.name.toLowerCase())) { errors.push(`"${server.name}" is listed twice`); continue; }
    seen.add(server.name.toLowerCase());
    servers.push(server);
  }
  if (servers.length > 8) errors.push('At most 8 servers per tab');
  return { servers: servers.slice(0, 8), errors };
}

export function formatMcpServerLines(servers) {
  return (Array.isArray(servers) ? servers : []).map(cleanMcpServer).filter(Boolean)
    .map(s => [s.name, s.url, s.type === 'sse' ? 'sse' : '', s.alwaysLoad ? 'always' : '', s.timeoutMs ? `timeout=${Math.round(s.timeoutMs / 1000)}` : ''].filter(Boolean).join(' ')).join('\n');
}

function cleanAgents(value) {
  const entries = Array.isArray(value) ? value.map(a => [a?.name, a]) : (value && typeof value === 'object' ? Object.entries(value) : []);
  const out = [];
  const problems = [];
  for (const [rawName, def] of entries) {
    const name = text(rawName, 64);
    if (!AGENT_NAME.test(name)) { problems.push(`"${String(rawName).slice(0, 40)}" is not a usable agent name`); continue; }
    const description = text(def?.description, 500);
    const prompt = text(def?.prompt, 8000);
    if (!description || !prompt) { problems.push(`${name} needs a description and a prompt`); continue; }
    const agent = { name, description, prompt };
    // No "tools" key: the agent inherits its parent's tools. A list is a
    // restriction and stays one, an empty list included ("no tools"); entries
    // that are not tool names are dropped and named, never widened to "inherit".
    if (Array.isArray(def.tools)) {
      const given = parseList(def.tools, 40);
      agent.tools = given.filter(t => TOOL_NAME.test(t));
      if (agent.tools.length !== given.length) problems.push(`${name}: not tool names, left out: ${given.filter(t => !TOOL_NAME.test(t)).join(', ').slice(0, 120)}`);
    } else if (def.tools !== undefined && def.tools !== null) {
      problems.push(`${name}: "tools" must be a list ([] for no tools); leave it out to inherit`);
      continue;
    }
    if (text(def.model, 120)) agent.model = text(def.model, 120);
    out.push(agent);
  }
  if (out.length > 10) problems.push('At most 10 agents per tab');
  return { agents: out.slice(0, 10), problems };
}

/**
 * The card's JSON: { "name": { "description", "prompt", "tools"?, "model"? } }.
 * @returns {{ agents: object[], error: string }}
 */
export function parseAgentsJson(value) {
  const src = String(value || '').trim();
  if (!src) return { agents: [], error: '' };
  let parsed;
  try { parsed = JSON.parse(src); } catch (err) { return { agents: [], error: `Not valid JSON: ${err.message}` }; }
  if (!parsed || typeof parsed !== 'object') return { agents: [], error: 'Expected an object: { "name": { "description": …, "prompt": … } }' };
  const { agents, problems } = cleanAgents(parsed);
  return { agents, error: problems.join('; ') };
}

export function formatAgentsJson(agents) {
  const list = cleanAgents(agents).agents;
  if (!list.length) return '';
  return JSON.stringify(Object.fromEntries(list.map(({ name, ...def }) => [name, def])), null, 2);
}

function cleanOverlay(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    language: text(r.language, 40),
    autoCompact: r.autoCompact === 'on' || r.autoCompact === 'off' ? r.autoCompact : 'default',
    promptCacheTtl: r.promptCacheTtl === '5m' || r.promptCacheTtl === '1h' ? r.promptCacheTtl : '',
    advisorModel: text(r.advisorModel, 120),
  };
}

export function normalizeSession(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const budget = Number(r.maxBudgetUsd);
  const turns = Number(r.maxTurns);
  return {
    fastMode: r.fastMode === true,
    thinking: r.thinking === 'off' ? 'off' : 'default',
    outputStyle: text(r.outputStyle, 120),
    agent: text(r.agent, 120),
    fallbackModel: text(r.fallbackModel, 120),
    maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? Math.min(budget, 10_000) : 0,
    maxTurns: Number.isInteger(turns) && turns >= 1 ? Math.min(turns, 1000) : 0,
    additionalDirectories: parseList(r.additionalDirectories),
    includeParentDir: r.includeParentDir !== false,
    plugins: parseList(r.plugins),
    strictMcp: r.strictMcp === true,
    systemPromptAppend: text(r.systemPromptAppend, 8000),
    sandbox: { enabled: r.sandbox?.enabled === true, autoAllowBash: r.sandbox?.enabled === true && r.sandbox?.autoAllowBash === true },
    hookEvents: r.hookEvents !== false,
    promptSuggestions: r.promptSuggestions !== false,
    subagentText: r.subagentText !== false,
    agentSummaries: r.agentSummaries === true,
    allowedTools: parseList(r.allowedTools, 40),
    disallowedTools: parseList(r.disallowedTools, 40),
    tools: parseList(r.tools, 60),
    planModeInstructions: text(r.planModeInstructions, 4000),
    mcpServers: (Array.isArray(r.mcpServers) ? r.mcpServers : []).map(cleanMcpServer).filter(Boolean).slice(0, 8),
    synabunAlwaysLoad: r.synabunAlwaysLoad === true,
    agents: cleanAgents(r.agents).agents,
    skills: parseList(r.skills, 60),
    debug: r.debug === true,
    overlay: cleanOverlay(r.overlay),
  };
}

// Settings that are fixed when the CLI process starts: changing one restarts
// the session (with resume) at the next message.
const START_KEYS = {
  thinking: 'thinking',
  fallbackModel: 'fallback model',
  maxBudgetUsd: 'spend limit',
  maxTurns: 'turn limit',
  additionalDirectories: 'directories',
  includeParentDir: 'parent directory access',
  plugins: 'plugins',
  strictMcp: 'MCP servers',
  systemPromptAppend: 'instructions',
  sandbox: 'sandbox',
  hookEvents: 'hook events',
  promptSuggestions: 'prompt suggestions',
  subagentText: 'subagent text',
  agentSummaries: 'agent progress summaries',
  allowedTools: 'auto-approved tools',
  disallowedTools: 'removed tools',
  tools: 'tool list',
  planModeInstructions: 'plan-mode instructions',
  mcpServers: 'MCP servers',
  synabunAlwaysLoad: 'MCP servers',
  agents: 'custom agents',
  skills: 'skills',
  debug: 'debug log',
};

/** The start-level settings that differ between two session objects, as words. */
export function changedStartSettings(before, after) {
  const a = normalizeSession(before);
  const b = normalizeSession(after);
  return [...new Set(Object.entries(START_KEYS).filter(([k]) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(([, label]) => label))];
}

/** Short words for the statusline: what is switched on for this tab. */
export function sessionFlags(session, { toolPolicy = 'full', fastModeState = '', account = '' } = {}) {
  const s = normalizeSession(session);
  const flags = [];
  if (account && account !== 'default') flags.push(`account ${account}`);
  if (s.fastMode) flags.push(fastModeState === 'cooldown' ? 'fast (cooldown)' : 'fast');
  if (s.thinking === 'off') flags.push('no thinking');
  if (s.sandbox.enabled) flags.push('sandbox');
  if (toolPolicy && toolPolicy !== 'full') flags.push(toolPolicy);
  if (s.strictMcp) flags.push('SynaBun MCP only');
  if (s.agent) flags.push(`agent ${s.agent}`);
  if (s.maxBudgetUsd > 0) flags.push(`$${s.maxBudgetUsd} cap`);
  return flags;
}

/** Rows for /status and for the note after a change: [label, value]. */
export function sessionRows(session) {
  const s = normalizeSession(session);
  const rows = [];
  if (s.fastMode) rows.push(['Fast mode', 'on']);
  if (s.thinking === 'off') rows.push(['Thinking', 'off']);
  if (s.outputStyle) rows.push(['Output style', s.outputStyle]);
  if (s.agent) rows.push(['Agent', s.agent]);
  if (s.fallbackModel) rows.push(['Fallback model', s.fallbackModel]);
  if (s.maxBudgetUsd > 0) rows.push(['Spend limit', `$${s.maxBudgetUsd}`]);
  if (s.maxTurns > 0) rows.push(['Turn limit', String(s.maxTurns)]);
  const dirs = [...s.additionalDirectories];
  rows.push(['Directories', `${s.includeParentDir ? 'the project folder and its parent' : 'the project folder only'}${dirs.length ? `, plus ${dirs.join(', ')}` : ''}`]);
  if (s.plugins.length) rows.push(['Plugin directories', s.plugins.join(', ')]);
  if (s.strictMcp) rows.push(['MCP servers', 'SynaBun only']);
  if (s.systemPromptAppend) rows.push(['Instructions', s.systemPromptAppend.length > 80 ? `${s.systemPromptAppend.slice(0, 79)}…` : s.systemPromptAppend]);
  if (s.sandbox.enabled) rows.push(['Sandbox', s.sandbox.autoAllowBash ? 'on, sandboxed commands run without asking' : 'on']);
  const off = [!s.hookEvents && 'hook events', !s.promptSuggestions && 'prompt suggestions', !s.subagentText && 'subagent text'].filter(Boolean);
  if (off.length) rows.push(['Switched off', off.join(', ')]);
  if (s.agentSummaries) rows.push(['Agent progress summaries', 'on']);
  if (s.allowedTools.length) rows.push(['Approved without asking', s.allowedTools.join(', ')]);
  if (s.disallowedTools.length) rows.push(['Removed tools', s.disallowedTools.join(', ')]);
  if (s.tools.length) rows.push(['Built-in tools', `only ${s.tools.join(', ')}`]);
  if (s.planModeInstructions) rows.push(['Plan-mode instructions', s.planModeInstructions.length > 80 ? `${s.planModeInstructions.slice(0, 79)}…` : s.planModeInstructions]);
  if (s.mcpServers.length) rows.push(['MCP servers of this tab', s.mcpServers.map(m => `${m.name} (${m.url})`).join(', ')]);
  if (s.synabunAlwaysLoad) rows.push(["SynaBun's tools", 'always loaded']);
  if (s.agents.length) rows.push(['Custom agents', s.agents.map(a => a.name).join(', ')]);
  if (s.skills.length) rows.push(['Skills', `only ${s.skills.join(', ')}`]);
  const overlay = [s.overlay.language && `language ${s.overlay.language}`, s.overlay.autoCompact !== 'default' && `auto-compact ${s.overlay.autoCompact}`, s.overlay.promptCacheTtl && `prompt cache ${s.overlay.promptCacheTtl}`, s.overlay.advisorModel && `advisor ${s.overlay.advisorModel}`].filter(Boolean);
  if (overlay.length) rows.push(['Settings for this tab', overlay.join(', ')]);
  if (s.debug) rows.push(['Debug log', 'on']);
  return rows;
}

/** Whether the model in use supports fast mode, from the session's model list. */
export function fastModeSupported(models, modelId) {
  const list = Array.isArray(models) ? models : [];
  const id = String(modelId || '').toLowerCase();
  const exact = id ? list.find(m => String(m?.value || m?.id || '').toLowerCase() === id) : null;
  if (exact) return exact.supportsFastMode === true;
  return list.some(m => m?.supportsFastMode === true);
}

/**
 * The picker's catalog (from the server's discovery) brought in line with what
 * a running session reported: a model the session can run and the catalog does
 * not list is added, and the capability flags of the ones both know come from
 * the session. Nothing is removed: another tab's session may differ.
 * @returns {{ models: object[], changed: boolean }}
 */
export function mergeSessionModels(catalog, sessionModels) {
  const base = Array.isArray(catalog) ? catalog : [];
  const session = (Array.isArray(sessionModels) ? sessionModels : []).filter(m => m && typeof m.value === 'string' && m.value);
  if (!session.length) return { models: base, changed: false };
  const byId = new Map(session.map(m => [m.value.toLowerCase(), m]));
  let changed = false;
  const models = base.map((row) => {
    const live = byId.get(String(row?.id || '').toLowerCase());
    if (!live) return row;
    const flags = {
      supportsAutoMode: live.supportsAutoMode === true,
      supportsFastMode: live.supportsFastMode === true,
      supportsAdaptiveThinking: live.supportsAdaptiveThinking === true,
    };
    if (Object.entries(flags).every(([k, v]) => (row[k] === true) === v)) return row;
    changed = true;
    return { ...row, ...flags };
  });
  const known = new Set(base.map(r => String(r?.id || '').toLowerCase()));
  for (const m of session) {
    if (known.has(m.value.toLowerCase())) continue;
    changed = true;
    const effortLevels = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String).filter(Boolean) : [];
    models.push({
      id: m.value,
      label: String(m.displayName || m.value),
      desc: String(m.description || '').slice(0, 80),
      description: String(m.description || ''),
      resolvedModel: String(m.resolvedModel || ''),
      contextWindow: /\[1m\]/i.test(m.value) ? 1_000_000 : 200_000,
      effortLevels,
      supportsEffort: m.supportsEffort === true && effortLevels.length > 0,
      supportsFastMode: m.supportsFastMode === true,
      supportsAutoMode: m.supportsAutoMode === true,
      supportsAdaptiveThinking: m.supportsAdaptiveThinking === true,
      cliReady: true,
      fromSession: true,
    });
  }
  return { models, changed };
}

const FAST_REASONS = {
  free: 'not available on this plan',
  preference: 'turned off in the settings',
  extra_usage_disabled: 'extra usage is off',
  network_error: 'could not be checked (network)',
  sdk_opt_in_required: 'needs an opt-in for SDK sessions',
  unknown: 'unavailable',
};
export function fastModeReason(reason) {
  return reason ? (FAST_REASONS[reason] || String(reason).replace(/_/g, ' ')) : '';
}
