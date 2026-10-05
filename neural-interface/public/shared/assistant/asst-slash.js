// ═══════════════════════════════════════════
// SynaBun Assistant — slash command parser
// ═══════════════════════════════════════════
// Pure module (no DOM, no i18n import) so node:test can exercise it. The
// composer resolves `descKey` through i18n and falls back to `desc`.

import { normalizeComputerMode, normalizeProvider, normalizeRouteMode } from './asst-state.js';

export const SLASH_COMMANDS = [
  { name: 'dispatch', usage: '/dispatch <provider> [--model m] [--effort e] [--agent a] [--project p] [--mcp profile] [--account id] [--ask] [--title "t"] <task>', descKey: 'assistant.slash.dispatch', desc: 'Dispatch a task to a sidepanel agent' },
  { name: 'agents', usage: '/agents [all]', descKey: 'assistant.slash.agents', desc: 'List dispatched runs' },
  { name: 'recall', usage: '/recall <query>', descKey: 'assistant.slash.recall', desc: 'Search memories' },
  { name: 'remember', usage: '/remember <text>', descKey: 'assistant.slash.remember', desc: 'Store a memory' },
  { name: 'model', usage: '/model [provider/]<model> [effort]', descKey: 'assistant.slash.model', desc: 'Switch model (and brain)' },
  { name: 'project', usage: '/project <path>', descKey: 'assistant.slash.project', desc: 'Set the working project' },
  { name: 'routes', usage: '/routes [always|unsure|never]', descKey: 'assistant.slash.routes', desc: 'Set when to ask before routing (or open the model routes)' },
  { name: 'models', usage: '/models [list | archived | hide <id…> | show <id…>]', descKey: 'assistant.slash.models', desc: 'Switch models off or on for the Assistant (or open the Models list)' },
  { name: 'budget', usage: '/budget', descKey: 'assistant.slash.budget', desc: 'Set the money caps (per run, session, brain)' },
  { name: 'computer', usage: '/computer [on|off]', descKey: 'assistant.slash.computer', desc: 'Let the assistant use your Mac' },
  { name: 'stop', usage: '/stop [runId|all]', descKey: 'assistant.slash.stop', desc: 'Stop a run, everything, or the current turn' },
  { name: 'new', usage: '/new [provider]', descKey: 'assistant.slash.new', desc: 'Start a fresh session' },
  { name: 'resume', usage: '/resume [sessionId]', descKey: 'assistant.slash.resume', desc: 'Resume a previous session' },
  { name: 'compact', usage: '/compact', descKey: 'assistant.slash.compact', desc: 'Compact the context' },
  { name: 'clear', usage: '/clear', descKey: 'assistant.slash.clear', desc: 'Clear the transcript' },
  { name: 'help', usage: '/help', descKey: 'assistant.slash.help', desc: 'Show commands' },
];

const KNOWN = new Set(SLASH_COMMANDS.map(c => c.name));

// Flag aliases → canonical option name.
export const DISPATCH_FLAGS = {
  model: 'model', m: 'model',
  effort: 'effort', e: 'effort',
  agent: 'agent',
  project: 'project', p: 'project', cwd: 'project',
  mcp: 'mcp', profile: 'mcp',
  account: 'account', a: 'account',
  title: 'title', t: 'title',
  budget: 'budget',
  minutes: 'minutes',
  ask: 'ask',
  auto: 'auto',
  focus: 'focus',
  browser: 'browser',
};
const BOOLEAN_FLAGS = new Set(['ask', 'auto', 'focus', 'browser']);

/** Shell-like tokenizer with quote support. Returns [{ value, start, end, quoted }]. */
export function tokenize(input) {
  const s = String(input ?? '');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    let value = '';
    let quoted = false;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      quoted = true;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && i + 1 < s.length) i++;
        value += s[i];
        i++;
      }
      i++; // closing quote (or end of input)
    } else {
      while (i < s.length && !/\s/.test(s[i])) {
        if (s[i] === '\\' && i + 1 < s.length) i++;
        value += s[i];
        i++;
      }
    }
    tokens.push({ value, start, end: i, quoted });
  }
  return tokens;
}

function parseDispatch(rest) {
  const tokens = tokenize(rest);
  if (!tokens.length) return { name: 'dispatch', error: 'missing_provider' };
  const provider = normalizeProvider(tokens[0].value);
  if (!provider) return { name: 'dispatch', error: 'invalid_provider', provider: tokens[0].value };

  const options = {};
  let taskStart = -1;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.quoted && tok.value.startsWith('--') && tok.value.length > 2) {
      let key = tok.value.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      const canon = DISPATCH_FLAGS[key.toLowerCase()];
      if (!canon) return { name: 'dispatch', provider, error: 'unknown_flag', flag: key };
      if (BOOLEAN_FLAGS.has(canon)) {
        options[canon] = val === undefined ? true : !/^(false|0|no|off)$/i.test(val);
        continue;
      }
      if (val === undefined) {
        const next = tokens[i + 1];
        if (!next || (!next.quoted && next.value.startsWith('--'))) {
          return { name: 'dispatch', provider, error: 'missing_flag_value', flag: key };
        }
        val = next.value;
        i++;
      }
      options[canon] = val;
      continue;
    }
    taskStart = i;
    break;
  }

  let task = '';
  if (taskStart >= 0) {
    const onlyToken = tokens.length - taskStart === 1 && tokens[taskStart].quoted;
    task = onlyToken ? tokens[taskStart].value : rest.slice(tokens[taskStart].start).trim();
  }
  if (!task) return { name: 'dispatch', provider, options, error: 'missing_task' };
  return {
    name: 'dispatch',
    provider,
    options,
    task,
    permissionPolicy: options.ask ? 'ask' : 'auto',
  };
}

function parseModel(rest) {
  const tokens = tokenize(rest).map(t => t.value);
  if (!tokens.length) return { name: 'model', provider: null, model: null, effort: null };
  const first = tokens[0];
  let provider = null;
  let model = first;
  const slash = first.indexOf('/');
  if (slash > 0 && normalizeProvider(first.slice(0, slash))) {
    provider = normalizeProvider(first.slice(0, slash));
    model = first.slice(slash + 1) || null;
  } else if (normalizeProvider(first)) {
    provider = normalizeProvider(first);
    model = null;
  }
  return { name: 'model', provider, model, effort: tokens[1] || null };
}

/**
 * Parse a composer submission. Returns null when the text is not a slash
 * command ("//literal", "/ path", plain prose). Unknown commands are returned
 * with `passthrough: true` so the panel can forward them to the brain (Claude
 * skills such as /synabun, Codex builtins, …).
 */
export function parseSlashCommand(text) {
  const trimmed = String(text ?? '').trimStart();
  if (!trimmed.startsWith('/') || trimmed === '/') return null;
  if (trimmed.startsWith('//') || /^\/\s/.test(trimmed)) return null;
  const m = trimmed.match(/^\/([A-Za-z][\w:-]*)[ \t]*([\s\S]*)$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const rest = m[2] ?? '';
  const restTrim = rest.trim();

  switch (name) {
    case 'dispatch': return parseDispatch(rest);
    case 'agents': return { name, all: /^all$/i.test(restTrim) };
    case 'recall': return restTrim ? { name, query: restTrim } : { name, error: 'missing_query' };
    case 'remember': return restTrim ? { name, text: restTrim } : { name, error: 'missing_text' };
    case 'model': return parseModel(rest);
    case 'project': return { name, path: restTrim || null };
    case 'routes': {
      if (!restTrim) return { name, mode: null };
      const mode = normalizeRouteMode(restTrim);
      return mode ? { name, mode } : { name, mode: null, error: 'invalid_mode', value: restTrim };
    }
    case 'models': return parseModels(rest);
    case 'budget': return { name };
    case 'computer': {
      if (!restTrim) return { name, mode: null };
      const enabled = normalizeComputerMode(restTrim);
      return enabled == null ? { name, mode: null, error: 'invalid_mode', value: restTrim } : { name, mode: enabled ? 'on' : 'off' };
    }
    case 'stop': return { name, target: restTrim && !/^all$/i.test(restTrim) ? restTrim : null, all: /^all$/i.test(restTrim) };
    case 'new': return { name, provider: restTrim ? normalizeProvider(restTrim) : null };
    case 'resume': return { name, sessionId: restTrim || null };
    case 'compact':
    case 'clear':
    case 'help':
      return { name };
    default:
      return { name, raw: trimmed, rest: restTrim, passthrough: true };
  }
}

/** /models → open the manager; /models archived → its Archived tab; /models list; /models hide|show <id…> (ids may be quoted). */
function parseModels(rest) {
  const tokens = tokenize(rest).map(tok => tok.value).filter(Boolean);
  if (!tokens.length) return { name: 'models', action: 'open' };
  const action = tokens[0].toLowerCase();
  const alias = { ls: 'list', list: 'list', archived: 'archived', archive: 'archived', hide: 'hide', off: 'hide', disable: 'hide', show: 'show', on: 'show', enable: 'show' }[action];
  if (!alias) return { name: 'models', action: null, error: 'invalid_action', value: tokens[0] };
  if (alias === 'list') return { name: 'models', action: 'list' };
  if (alias === 'archived') return { name: 'models', action: 'open', tab: 'archived' };
  const ids = [...new Set(tokens.slice(1).flatMap(tok => tok.split(',')).map(id => id.trim()).filter(Boolean))];
  return ids.length ? { name: 'models', action: alias, ids } : { name: 'models', action: alias, error: 'missing_ids' };
}

export function isKnownSlashCommand(name) {
  return KNOWN.has(String(name || '').toLowerCase());
}

/** Commands whose name starts with the typed prefix ("/di" → dispatch). */
export function matchSlashCommands(query) {
  const q = String(query ?? '').replace(/^\//, '').trim().toLowerCase();
  const head = q.split(/\s+/)[0] || '';
  return SLASH_COMMANDS.filter(c => c.name.startsWith(head));
}

/**
 * Build the POST /api/assistant/dispatch body from a parsed /dispatch command.
 * Only explicit flags set model/effort — the brain's project, MCP profile and
 * (same-provider) account are inherited, models are left to the server default.
 */
export function buildDispatchSpec(parsed, brain = {}, { assistantSessionId = null } = {}) {
  if (!parsed || parsed.name !== 'dispatch' || parsed.error) return null;
  const o = parsed.options || {};
  const spec = {
    provider: parsed.provider,
    task: parsed.task,
    permissionPolicy: parsed.permissionPolicy || (o.ask ? 'ask' : 'auto'),
    focus: o.focus === true,
  };
  const cwd = o.project || brain.project;
  if (cwd) spec.cwd = cwd;
  if (o.model) spec.model = o.model;
  if (o.effort) spec.effort = o.effort;
  if (o.agent) spec.agent = o.agent;
  const mcp = o.mcp || brain.mcpProfile;
  if (mcp) spec.mcpProfile = mcp;
  const account = o.account || (brain.provider === parsed.provider ? brain.accountId : null);
  if (account) {
    if (parsed.provider === 'codex') spec.codexAccountId = account;
    else if (parsed.provider === 'claude-code') spec.claudeAccountId = account;
  }
  if (o.title) spec.title = o.title;
  if (o.budget !== undefined && Number.isFinite(Number(o.budget))) spec.budgetUsd = Number(o.budget);
  if (o.minutes !== undefined && Number.isFinite(Number(o.minutes))) spec.maxMinutes = Number(o.minutes);
  if (o.browser) spec.usesBrowser = true;
  if (assistantSessionId) spec.assistantSessionId = assistantSessionId;
  return spec;
}

/** Markdown help block for /help. `describe(cmd)` may localize the description. */
export function slashHelpMarkdown(describe = (c) => c.desc) {
  const lines = SLASH_COMMANDS.map(c => `- \`${c.usage}\` — ${describe(c) || c.desc}`);
  return `**Slash commands**\n\n${lines.join('\n')}\n\nAnything else starting with \`/\` is sent to the brain as-is.`;
}
