// ── Session settings card (DOM glue over cp-session-model.js) ──
// One card for everything a tab's session can be started or switched with.
// Opened by /session; the quick commands (/fast, /add-dir, …) change single
// fields of the same object.

import { cpCtx } from './cp-ctx.js';
import { normalizeSession, parseList, parseMcpServerLines, formatMcpServerLines, parseAgentsJson, formatAgentsJson } from './cp-session-model.js';

function field(labelText, control, hint = '') {
  const row = document.createElement('label');
  row.className = 'cp-elicit-field cp-session-field';
  const label = document.createElement('span');
  label.className = 'cp-elicit-label';
  label.textContent = labelText;
  row.append(label, control);
  if (hint) {
    const h = document.createElement('span');
    h.className = 'cp-elicit-hint';
    h.textContent = hint;
    row.appendChild(h);
  }
  return row;
}

function select(options, value) {
  const el = document.createElement('select');
  el.className = 'cp-elicit-input';
  for (const [v, label] of options) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = label;
    el.appendChild(opt);
  }
  // A stored value the session does not list (yet) stays selectable.
  if (value && !options.some(([v]) => v === value)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    el.appendChild(opt);
  }
  el.value = value || '';
  return el;
}

function input(type, value, placeholder = '') {
  const el = document.createElement('input');
  el.type = type;
  el.className = 'cp-elicit-input';
  el.value = value == null || value === 0 ? '' : String(value);
  if (placeholder) el.placeholder = placeholder;
  return el;
}

function checkbox(checked) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.checked = !!checked;
  return el;
}

function area(value, placeholder, rows = 2) {
  const el = document.createElement('textarea');
  el.className = 'cp-elicit-input';
  el.rows = rows;
  el.value = value || '';
  el.placeholder = placeholder;
  return el;
}

/**
 * @param o.session       the tab's current session settings
 * @param o.models        [{value, displayName}] the session reported (may be empty before the first turn)
 * @param o.agents        [{name, description}]
 * @param o.outputStyles  string[]
 * @param o.fastSupported whether the model in use supports fast mode
 * @param o.advanced      the bridge reads the advanced fields (tools, MCP servers, agents, skills, overlay, debug)
 * @param o.onSave        (session) => void
 */
export function renderSessionSettingsCard(tab, o = {}) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return null;
  $msgs.querySelectorAll('.cp-session-card.active-perm').forEach(n => n.remove());
  const s = normalizeSession(o.session);

  const el = document.createElement('div');
  el.className = 'msg msg-info-card cp-session-card active-perm';
  const body = document.createElement('div');
  body.className = 'cp-info-body';
  const title = document.createElement('div');
  title.className = 'cp-info-title';
  title.textContent = 'Session settings for this tab';
  body.appendChild(title);
  const form = document.createElement('div');
  form.className = 'cp-elicit-form';

  const fast = checkbox(s.fastMode);
  fast.disabled = !o.fastSupported && !s.fastMode;
  const thinking = select([['default', 'Model default'], ['off', 'Off']], s.thinking);
  const style = (o.outputStyles || []).length
    ? select([['', 'Default'], ...o.outputStyles.filter(n => n && n !== 'default').map(n => [n, n])], s.outputStyle)
    : input('text', s.outputStyle, 'Default');
  const agent = (o.agents || []).length
    ? select([['', 'None'], ...o.agents.map(a => [a.name, a.description ? `${a.name}: ${String(a.description).slice(0, 60)}` : a.name])], s.agent)
    : input('text', s.agent, 'None');
  const fallback = (o.models || []).length
    ? select([['', 'None'], ...o.models.map(m => [m.value, m.displayName || m.value])], s.fallbackModel)
    : input('text', s.fallbackModel, 'None');
  const budget = input('number', s.maxBudgetUsd, 'No limit');
  const turns = input('number', s.maxTurns, 'No limit');
  const dirs = area(s.additionalDirectories.join('\n'), 'One path per line');
  const parent = checkbox(s.includeParentDir);
  const plugins = area(s.plugins.join('\n'), 'One plugin directory per line');
  const strict = checkbox(s.strictMcp);
  const append = area(s.systemPromptAppend, 'Standing instructions for this tab', 3);
  const sandbox = checkbox(s.sandbox.enabled);
  const sandboxAuto = checkbox(s.sandbox.autoAllowBash);
  const suggestions = checkbox(s.promptSuggestions);
  const hookEvents = checkbox(s.hookEvents);
  const subagentText = checkbox(s.subagentText);
  const summaries = checkbox(s.agentSummaries);

  form.append(
    field('Fast mode', fast, o.fastSupported ? 'Faster output at a higher price, on models that support it.' : 'The model in use does not report fast mode support.'),
    field('Thinking', thinking, 'Off starts the session without extended thinking.'),
    field('Output style', style),
    field('Run as agent', agent, "The main conversation uses the agent's prompt, tools and model."),
    field('Fallback model', fallback, 'Used when the main model is overloaded or unavailable.'),
    field('Spend limit (USD)', budget, 'The turn stops when this session has spent this much since it started.'),
    field('Turn limit', turns, 'The most model round-trips one message may take.'),
    field('Extra directories', dirs, 'Readable and writable without a prompt, besides the project folder.'),
    field('Also allow the parent of the project folder', parent, 'On by default, so sibling projects can be read.'),
    field('Plugin directories', plugins, 'Local plugins loaded for this tab only. Plugins run code and hooks.'),
    field("Only SynaBun's MCP server", strict, 'Ignore the MCP servers from settings and .mcp.json for this tab.'),
    field('Instructions', append, 'Appended to the system prompt when a session starts; a resumed session keeps what it started with until it compacts.'),
    field('Sandbox commands', sandbox, 'Bash runs isolated. Depends on the platform; a missing dependency ends the turn with an error.'),
    field('Run sandboxed commands without asking', sandboxAuto),
    field('Suggest the next prompt', suggestions, 'After each turn, one suggestion above the input (Tab accepts). Nearly free: it reuses the prompt cache.'),
    field('Show real hook events', hookEvents, 'The hook strip (Ctrl+Shift+H) lists the hooks that ran, with their outcome.'),
    field('Show what subagents say', subagentText, "A subagent's own text and thinking inside its card."),
    field('Agent progress summaries', summaries, 'A model-written line about what each subagent is doing, about every 30 s. Costs tokens.'),
  );
  body.appendChild(form);

  // Advanced: shown only when the connected server reads these fields. Values a
  // tab already has are kept either way (the save starts from the session).
  const adv = {};
  if (o.advanced) {
    adv.allowed = area(s.allowedTools.join('\n'), 'One rule per line, e.g. Bash(npm test:*)');
    adv.disallowed = area(s.disallowedTools.join('\n'), 'One tool or rule per line, e.g. WebFetch');
    adv.tools = area(s.tools.join('\n'), 'Empty: every built-in tool');
    adv.planInstructions = area(s.planModeInstructions, 'What plan mode should do differently', 2);
    adv.mcp = area(formatMcpServerLines(s.mcpServers), 'name https://host/mcp [sse] [always] [timeout=60]');
    adv.synabunAlways = checkbox(s.synabunAlwaysLoad);
    adv.agents = area(formatAgentsJson(s.agents), '{ "reviewer": { "description": "…", "prompt": "…", "tools": ["Read"], "model": "haiku" } }', 4);
    adv.skills = area(s.skills.join('\n'), 'Empty: every skill');
    adv.language = input('text', s.overlay.language, 'From your settings');
    adv.autoCompact = select([['default', 'From your settings'], ['on', 'On'], ['off', 'Off']], s.overlay.autoCompact);
    adv.cacheTtl = select([['', 'From your settings'], ['5m', '5 minutes'], ['1h', '1 hour']], s.overlay.promptCacheTtl);
    adv.advisor = input('text', s.overlay.advisorModel, 'From your settings');
    adv.debug = checkbox(s.debug);
    const details = document.createElement('details');
    details.className = 'cp-tool-group cp-session-advanced';
    const summary = document.createElement('summary');
    summary.textContent = 'Advanced: tools, MCP servers, agents, skills, settings overrides';
    const advForm = document.createElement('div');
    advForm.className = 'cp-elicit-form';
    advForm.append(
      field('Approve without asking', adv.allowed, 'Permission rules that never prompt in this tab.'),
      field('Remove tools', adv.disallowed, 'Added to what the tool policy (/tools) already removes.'),
      field('Only these built-in tools', adv.tools, 'Tool names, one per line. MCP tools are not affected.'),
      field('Plan-mode instructions', adv.planInstructions, 'Replaces the standard plan workflow text while plan mode is on.'),
      field('MCP servers for this tab', adv.mcp, 'Remote servers only (http or sse). A server that needs a command line or a token belongs in your Claude Code settings.'),
      field("Always load SynaBun's tools", adv.synabunAlways, 'Every SynaBun tool stays in the prompt instead of being found through tool search. Uses more context.'),
      field('Custom agents (JSON)', adv.agents, 'Subagents only this tab has: a description, a prompt, optionally tools and a model.'),
      field('Skills', adv.skills, 'Only these skills are offered to the model.'),
      field('Reply language', adv.language),
      field('Auto-compact', adv.autoCompact),
      field('Prompt cache lifetime', adv.cacheTtl, '1 hour costs more to write and survives longer pauses.'),
      field('Advisor model', adv.advisor),
      field('Debug log', adv.debug, 'A verbose log of the Claude Code process, written to a file on the server.'),
    );
    details.append(summary, advForm);
    body.appendChild(details);
  }
  const problems = document.createElement('div');
  problems.className = 'cp-elicit-error';
  problems.hidden = true;
  body.appendChild(problems);

  const actions = document.createElement('div');
  actions.className = 'perm-actions';
  const save = document.createElement('button');
  save.className = 'perm-btn perm-btn-allow';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.className = 'perm-btn perm-btn-deny';
  cancel.textContent = 'Close';
  const close = () => {
    el.classList.remove('active-perm');
    el.querySelectorAll('button, input, select, textarea').forEach(n => { n.disabled = true; });
  };
  save.addEventListener('click', () => {
    let advanced = {};
    if (o.advanced) {
      const mcp = parseMcpServerLines(adv.mcp.value);
      const agentDefs = parseAgentsJson(adv.agents.value);
      const errors = [...mcp.errors.map(e => `MCP servers: ${e}`), ...(agentDefs.error ? [`Custom agents: ${agentDefs.error}`] : [])];
      // Nothing is saved while a field cannot be read: a half-applied list would be a surprise.
      if (errors.length) { problems.textContent = errors.join('\n'); problems.hidden = false; return; }
      advanced = {
        allowedTools: parseList(adv.allowed.value, 40),
        disallowedTools: parseList(adv.disallowed.value, 40),
        tools: parseList(adv.tools.value, 60),
        planModeInstructions: adv.planInstructions.value,
        mcpServers: mcp.servers,
        synabunAlwaysLoad: adv.synabunAlways.checked,
        agents: agentDefs.agents,
        skills: parseList(adv.skills.value, 60),
        debug: adv.debug.checked,
        overlay: { language: adv.language.value, autoCompact: adv.autoCompact.value, promptCacheTtl: adv.cacheTtl.value, advisorModel: adv.advisor.value },
      };
    }
    const next = normalizeSession({
      ...s,
      ...advanced,
      fastMode: fast.checked,
      thinking: thinking.value,
      outputStyle: style.value,
      agent: agent.value,
      fallbackModel: fallback.value,
      maxBudgetUsd: Number(budget.value) || 0,
      maxTurns: Math.floor(Number(turns.value)) || 0,
      additionalDirectories: parseList(dirs.value),
      includeParentDir: parent.checked,
      plugins: parseList(plugins.value),
      strictMcp: strict.checked,
      systemPromptAppend: append.value,
      sandbox: { enabled: sandbox.checked, autoAllowBash: sandboxAuto.checked },
      promptSuggestions: suggestions.checked,
      hookEvents: hookEvents.checked,
      subagentText: subagentText.checked,
      agentSummaries: summaries.checked,
    });
    close();
    o.onSave?.(next);
  });
  cancel.addEventListener('click', close);
  actions.append(save, cancel);
  body.appendChild(actions);
  el.appendChild(body);
  $msgs.appendChild(el);
  if (tab === cpCtx.activeTab()) cpCtx.scrollEnd();
  return el;
}
