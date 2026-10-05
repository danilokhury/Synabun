// ═══════════════════════════════════════════
// SynaBun — Assistant plan mode: what a planning brain may do
// ═══════════════════════════════════════════
//
// Plan mode blocks code changes and nothing else. While it is on, a brain's
// file-edit channel is refused whatever the approval mode or the user's allow
// rules: Claude's edit tools (subagents included), Codex patches and grants of
// file-write access, OpenCode's edit family, and another MCP server's tools
// whose purpose is writing files. Everything else — shell commands, computer
// use, the browser, every other MCP tool, subagents, skills — runs exactly as
// outside plan mode, under the session's approval mode; read-only inspection
// runs without a card in every approval mode. Whether a shell command should
// change files is the brain's instructions' business (assistant-persona.js
// planModeInstructions), not this module's. Each brain keeps its native plan
// mode on top: Claude's SDK 'plan' (ExitPlanMode), Codex's plan collaboration
// mode in a read-only sandbox (so a patch still has to ask), and SynaBun's
// plan agent on OpenCode.
//
// The read-only classifier (claudeReadOnlyPermission & co.) keeps the old
// read-only plan semantics: a remote (WhatsApp) session at the read-only level
// plans with it, remote-policy asks below the autonomous level for whatever it
// refuses, and plan mode auto-allows what it allows.

// ── the read-only classifier ─────────────────────────────────────────────────

// Claude built-ins that only read. Edit/Write & co. are refused; Bash runs only
// read-only inspection commands (isReadOnlyShellCommand) — the CLI already runs
// the ones it can prove read-only itself, this covers the ones it asks about.
const CLAUDE_READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'Skill',
  'BashOutput', 'TaskOutput', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
]);

// SynaBun MCP tools that only read (or browse the public web).
const SYNABUN_READ_TOOLS = new Set([
  'recall',
  'browser_snapshot', 'browser_content', 'browser_screenshot', 'browser_console', 'browser_cheatsheet',
  'browser_navigate', 'browser_go_back', 'browser_go_forward', 'browser_reload', 'browser_scroll', 'browser_wait', 'browser_hover',
  'browser_x_compose_state', 'browser_fb_composer_state',
  'card_list', 'card_screenshot', 'whiteboard_read', 'whiteboard_screenshot', 'computer_status',
  'bluesky_feed', 'bluesky_timeline', 'bluesky_thread', 'bluesky_profile', 'bluesky_author_feed',
  'bluesky_search_actors', 'bluesky_search_posts', 'bluesky_resolve',
  // The assistant's own coordination tools: the route gate needs agent_route every turn,
  // and agent_clarify only asks the user. agent_dispatch and agent_send are not reads:
  // they start or steer a worker with its own capability.
  'agent_route', 'agent_clarify', 'agent_catalog', 'agent_list', 'agent_status', 'agent_read', 'agent_wait', 'agent_stop', 'agent_focus', 'agent_usage',
]);
// Multiplexed SynaBun tools: read-only for these actions only.
const SYNABUN_READ_ACTIONS = {
  memories: new Set(['recent', 'stats', 'by-category', 'by-project', 'get', 'get-batch', 'history', 'context', 'triage']),
  category: new Set(['list']),
  profile: new Set(['get']),
  computer: new Set(['screenshot', 'cursor_position']),
  computer_apps: new Set(['list', 'windows', 'frontmost']),
  computer_ax: new Set(['snapshot']),
};
// Another server's tool reads when its name starts with a read verb (query-docs, search_threads).
const READ_VERB = /^(?:get|list|read|search|query|fetch|find|lookup|resolve|describe|view|show)(?:[_-]|$)/i;

// OpenCode permission kinds that change files or run commands.
const OPENCODE_GUARDED = /^(?:edit|write|patch|multiedit|apply_patch|bash)$/i;
const OPENCODE_READ_KINDS = new Set(['read', 'list', 'glob', 'grep', 'webfetch', 'websearch', 'codesearch', 'external_directory', 'doom_loop', 'lsp', 'task', 'skill', 'todowrite', 'todoread']);
// OpenCode's own tools; any other tool name is an MCP tool (<server>_<tool>).
const OPENCODE_NATIVE_TOOLS = new Set([...OPENCODE_READ_KINDS, 'bash', 'edit', 'write', 'patch', 'multiedit', 'apply_patch', 'question', 'plan_exit', 'plan_enter', 'batch', 'invalid']);

// Read-only inspection programs → the options that would make them write or run
// something (a long one is refused abbreviated too). No wrappers (env, sudo,
// xargs, bash -c, timeout…): not listed.
const READ_PROGRAMS = new Map([
  ['ls', []], ['pwd', []], ['cat', []], ['head', []], ['tail', []], ['wc', []], ['stat', []], ['du', []],
  ['tree', ['-o', '-R']], // -R writes 00Tree.html into every directory
  ['grep', []], ['egrep', []], ['fgrep', []], ['rg', ['--pre', '--pre-glob', '--hostname-bin']],
  ['find', ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']],
  ['which', []], ['echo', []], ['basename', []], ['dirname', []], ['realpath', []], ['readlink', []],
  ['diff', []], ['cmp', []], ['sort', ['-o', '--output', '-T', '--temporary-directory', '--compress-program']], ['jq', []],
]);
// `git <sub>` only, no global options first (`git -c` can run programs through config).
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'shortlog', 'describe', 'cat-file', 'merge-base', 'show-ref']);
const GIT_BLOCKED = ['--output', '--ext-diff', '--open-files-in-pager', '-O'];

// Outside quotes: operators, redirects, substitution, subshells, braces, escapes,
// history, comments, and globs (bash/zsh, extendedglob's ^ included): a glob
// can expand to a file named like an option (`rg x *` next to a `--pre=sh` file).
const SHELL_SPECIAL = new Set('|;&<>`$(){}\\!#*?[]^');

/**
 * A command line → its words, or null when it has shell syntax (SHELL_SPECIAL),
 * a control character or white space other than a plain space/tab.
 * Single quotes are literal; double quotes refuse $ ` \ !.
 */
export function shellWords(command) {
  const words = [];
  let word = '';
  let quoted = false;
  let quote = null;
  for (const ch of String(command ?? '')) {
    if (ch !== '\t' && /\p{Cc}/u.test(ch)) return null;
    if (quote === "'") { if (ch === "'") quote = null; else word += ch; continue; }
    if (quote === '"') { if (ch === '"') quote = null; else if ('$`\\!'.includes(ch)) return null; else word += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; quoted = true; continue; }
    if (ch === ' ' || ch === '\t') { if (word || quoted) words.push(word); word = ''; quoted = false; continue; }
    if (SHELL_SPECIAL.has(ch) || /\s/u.test(ch)) return null;
    word += ch;
  }
  if (quote) return null;
  if (word || quoted) words.push(word);
  return words;
}

function blockedFlag(word, flags) {
  return flags.some((flag) => word === flag || word.startsWith(`${flag}=`)
    // an abbreviated long option (GNU getopt and git take any unambiguous prefix: --out=x)
    || (flag.startsWith('--') && /^--[^-=]/.test(word) && flag.startsWith(word.split('=')[0]))
    // a short flag, alone or inside a cluster (-ro = -r -o)
    || (/^-[a-zA-Z]$/.test(flag) && /^-[a-zA-Z]/.test(word) && word.slice(1).includes(flag[1])));
}

/** A genuinely read-only inspection command (rg, git status/diff/log, ls, cat, pwd…)? */
export function isReadOnlyShellCommand(command) {
  const words = shellWords(command);
  if (!words || !words.length) return false;
  const [program, ...args] = words;
  if (program === 'git') {
    const [sub, ...rest] = args;
    return GIT_READ.has(sub) && !rest.some((w) => blockedFlag(w, GIT_BLOCKED));
  }
  const blocked = READ_PROGRAMS.get(program);
  return !!blocked && !args.some((w) => blockedFlag(w, blocked));
}

const CODEX_EXECUTION_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);

/** What the model reads when the read-only classifier refused a tool (a WhatsApp session at the read-only level). */
export function readOnlyDenyMessage(tool) {
  return `Plan mode is read-only, so SynaBun did not run ${tool || 'this tool'}. Keep exploring with read-only tools and put this step in the plan; it runs after the user approves the plan.`;
}

/** An MCP tool name → { server, leaf }: mcp__<server>__<tool> (Claude, Codex) or SynaBun_<tool> (OpenCode). */
export function mcpToolParts(name, serverName = null) {
  const text = String(name || '');
  const prefixed = /^mcp__(.+?)__(.+)$/.exec(text);
  if (prefixed) return { server: prefixed[1], leaf: prefixed[2] };
  const opencode = /^synabun_(.+)$/i.exec(text);
  if (opencode) return { server: 'SynaBun', leaf: opencode[1] };
  return { server: serverName ? String(serverName) : null, leaf: text };
}

/**
 * A boolean argument the way SynaBun's MCP tools read it (mcp-server/src/tools/utils.ts
 * parseBooleanArg): true / false, "true" / "false" (any case, trimmed) or 1 / 0 (number
 * or string). null for anything else, which the tool refuses.
 */
export function booleanArg(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
  }
  return null;
}

export function isReadOnlyMcpTool(name, input = {}, { serverName = null } = {}) {
  const { server, leaf } = mcpToolParts(name, serverName);
  if (!leaf) return false;
  if (/^synabun$/i.test(server || '')) {
    // A screenshot saved as a file (save / path) writes one. Any save but a clear false counts.
    const save = input?.save;
    if (leaf === 'browser_screenshot' && (input?.path || (save !== undefined && save !== null && booleanArg(save) !== false))) return false;
    if (SYNABUN_READ_TOOLS.has(leaf) || /^browser_extract_/.test(leaf)) return true;
    const actions = SYNABUN_READ_ACTIONS[leaf];
    return !!actions && actions.has(String(input?.action || ''));
  }
  return READ_VERB.test(leaf);
}

/**
 * The read-only classifier for Claude: 'allow' or 'deny'. ExitPlanMode and
 * AskUserQuestion never get here: they stay with the user.
 */
export function claudeReadOnlyPermission(toolName, input = {}) {
  const tool = String(toolName || '');
  if (tool.startsWith('mcp__')) return isReadOnlyMcpTool(tool, input) ? 'allow' : 'deny';
  if (tool === 'Bash') return isReadOnlyShellCommand(input?.command) ? 'allow' : 'deny';
  return CLAUDE_READ_TOOLS.has(tool) ? 'allow' : 'deny';
}

// The tools a user allow rule can pre-approve so canUseTool never sees them
// (Bash(find:*), mcp__SynaBun__*). Other built-ins keep the CLI's own handling.
const CLAUDE_HOOKED = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * The read-only classifier as Claude's PreToolUse hook (runs before permission
 * rules): 'deny' for a shell command, an edit or an MCP tool it refuses, else null.
 */
export function claudeReadOnlyHookDecision(toolName, input = {}) {
  const tool = String(toolName || '');
  if (!CLAUDE_HOOKED.has(tool) && !tool.startsWith('mcp__')) return null;
  return claudeReadOnlyPermission(tool, input) === 'allow' ? null : 'deny';
}

/**
 * The read-only classifier for a tool call about to run, from a host's pre-tool
 * hook (the OpenCode plugin, the Codex hook): 'deny' or null (the host's own
 * rules apply). `input` carries the call's `command` and `action`. Codex
 * commands and patches stay with its read-only sandbox; its MCP tools are checked here.
 */
export function readOnlyToolDecision(toolName, input = {}, { host = null } = {}) {
  const tool = String(toolName || '');
  if (host === 'claude') return claudeReadOnlyHookDecision(tool, input);
  if (host === 'codex') return /^mcp__/.test(tool) && !isReadOnlyMcpTool(tool, input) ? 'deny' : null;
  if (host !== 'opencode') return null;
  const kind = tool.toLowerCase();
  if (kind === 'bash') return isReadOnlyShellCommand(input?.command) ? null : 'deny';
  if (OPENCODE_GUARDED.test(kind)) return 'deny';
  if (OPENCODE_NATIVE_TOOLS.has(kind)) return null;
  const cut = tool.indexOf('_');
  return cut > 0 && isReadOnlyMcpTool(`mcp__${tool.slice(0, cut)}__${tool.slice(cut + 1)}`, input) ? null : 'deny';
}

/**
 * The read-only classifier for Codex (a translated control_request): 'allow',
 * 'deny', or null for the user (questions, MCP forms, anything unknown).
 * Commands already run inside the read-only sandbox without asking; an approval
 * is an escalation out of it (or a patch, or a permission grant), so it is declined.
 */
export function codexReadOnlyPermission(packet) {
  const request = packet?.request || {};
  const native = request.brain_native || {};
  const method = native.method || request.method || '';
  if (CODEX_EXECUTION_METHODS.has(method)) return 'deny';
  if (method === 'mcpServer/elicitation/request') {
    const params = native.params || {};
    const meta = params._meta ?? params.meta ?? {};
    if (meta.codex_approval_kind !== 'mcp_tool_call' || !meta.tool_name) return null;
    return isReadOnlyMcpTool(meta.tool_name, meta.tool_params || meta.arguments || {}, { serverName: params.serverName }) ? 'allow' : 'deny';
  }
  return null;
}

/** The read-only classifier for OpenCode (a translated permission ask): 'allow', 'deny', or null for the user (questions). */
export function opencodeReadOnlyPermission(packet) {
  const request = packet?.request || {};
  if ((request.brain_native || {}).kind === 'question') return null;
  const kind = String(request.tool_name || request.toolName || '');
  // The whole command line (metadata.command): OpenCode's patterns are single
  // commands of it and can leave out what surrounds them.
  if (/^bash$/i.test(kind)) return isReadOnlyShellCommand(request.input?.metadata?.command) ? 'allow' : 'deny';
  if (OPENCODE_GUARDED.test(kind)) return 'deny';
  if (OPENCODE_READ_KINDS.has(kind.toLowerCase())) return 'allow';
  return isReadOnlyMcpTool(kind, request.input?.metadata || {}) ? 'allow' : 'deny';
}

/** An OpenCode tool name (<server>_<tool>) as mcp__<server>__<tool>. */
function opencodeMcpName(tool) {
  const text = String(tool || '');
  const cut = text.indexOf('_');
  return cut > 0 ? `mcp__${text.slice(0, cut)}__${text.slice(cut + 1)}` : text;
}

// ── plan mode: no code changes ───────────────────────────────────────────────

// Each host's file-edit channel. Codex's hook may name a patch apply_patch.
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CODEX_EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'Write', 'MultiEdit']);
const OPENCODE_EDIT_KINDS = /^(?:edit|write|patch|multiedit|apply_patch)$/i;
// Approval modes that approve an ask without the user (Claude's bypass, Codex / OpenCode auto-accept).
const AUTO_APPROVAL = new Set(['bypassPermissions', 'auto']);

// Another MCP server's tool whose purpose is writing files: a filesystem
// server's tools other than reads, an editor's str_replace, and a verb that
// writes paired with a file noun (write_file, edit_file, move_file,
// create_directory, create_or_update_file, push_files). A bare write / edit
// elsewhere (a memory server's) is not. SynaBun's own tools never count.
const FILE_SERVER = /^(?:fs|files?|file_system|filesystem)$/;
const FILE_EDIT_LEAVES = new Set([
  'multiedit', 'multi_edit', 'apply_patch', 'str_replace', 'str_replace_editor',
  'str_replace_based_edit_tool', 'text_editor', 'notebook_edit', 'edit_notebook', 'edit_block',
]);
const FILE_EDIT_NAME = /^(?:write|edit|create|delete|remove|move|rename|copy|append|patch|overwrite|save|replace|insert|truncate|modify|update|push)(?:_[a-z0-9]+){0,3}_(?:file|files|dir|dirs|directory|directories|folder|folders|notebook|notebooks|cell|cells)$/;
const snakeCase = (text) => String(text || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s.]+/g, '_').toLowerCase();

/** Another MCP server's tool that writes files (mcp__<server>__<tool>; `serverName` for a bare name). */
export function isFileWritingMcpTool(name, { serverName = null } = {}) {
  const { server, leaf } = mcpToolParts(name, serverName);
  if (!leaf || /^synabun$/i.test(server || '')) return false;
  const words = snakeCase(leaf);
  if (FILE_SERVER.test(snakeCase(server)) && !READ_VERB.test(words)) return true;
  if (FILE_EDIT_LEAVES.has(words)) return true;
  // Every `_` boundary: an OpenCode name (<server>_<tool>) can cut a server name that has one.
  const parts = words.split('_');
  return parts.some((_, i) => FILE_EDIT_NAME.test(parts.slice(i).join('_')));
}

const PRESENT_PLAN = {
  claude: 'present the plan with ExitPlanMode',
  codex: 'present the plan in a <proposed_plan> block',
  opencode: 'present the plan in a <proposed_plan> block',
};
/** What the model reads when plan mode refused a code change. `host`: claude / codex / opencode. */
export function planDenyMessage(tool, { host = null } = {}) {
  const present = PRESENT_PLAN[host === 'claude-code' ? 'claude' : host] || 'present the plan for the user to approve';
  return `Plan mode blocks code changes only, so SynaBun did not run ${tool || 'this tool'}. Everything else stays available while you plan: run commands, tests and scripts, and use the computer, the browser and every other tool to explore and verify. To make this change, put it in the plan and ${present}; it runs after the user approves the plan.`;
}

/**
 * Claude's PreToolUse hook in plan mode (runs before the user's allow rules,
 * subagents included): 'deny' for an edit tool or a file-writing MCP tool, else null.
 */
export function claudePlanHookDecision(toolName) {
  const tool = String(toolName || '');
  if (CLAUDE_EDIT_TOOLS.has(tool)) return 'deny';
  return tool.startsWith('mcp__') && isFileWritingMcpTool(tool) ? 'deny' : null;
}

/**
 * Claude (ClaudeSession canUseTool in SDK mode 'plan', which asks for edits and
 * for MCP tools with no allow rule): 'deny' for a code change, 'allow' for a
 * read, for what the approval mode (the one an approved plan continues in)
 * approves on its own and for the brain's pre-approved tools (`preApproved`:
 * the CLI never asks for them outside plan mode), else null: the ask goes on as
 * outside plan mode (the session's always-allowed tools, else a card).
 * ExitPlanMode and AskUserQuestion never get here: they stay with the user.
 */
export function claudePlanPermission(toolName, input = {}, { approvalMode = 'default', preApproved = null } = {}) {
  const tool = String(toolName || '');
  if (claudePlanHookDecision(tool) === 'deny') return 'deny';
  if (claudeReadOnlyPermission(tool, input) === 'allow') return 'allow';
  if (approvalMode === 'bypassPermissions') return 'allow';
  const pre = preApproved instanceof Set ? preApproved : new Set(Array.isArray(preApproved) ? preApproved : []);
  return pre.has(tool) ? 'allow' : null;
}

/**
 * A tool call about to run in plan mode, from a host's pre-tool hook (the
 * OpenCode plugin, the Codex hook): 'deny' for a code change, else null (the
 * host's own rules and the approval mode apply).
 */
export function planToolDecision(toolName, input = {}, { host = null } = {}) {
  const tool = String(toolName || '');
  if (host === 'claude') return claudePlanHookDecision(tool);
  if (host === 'codex') return CODEX_EDIT_TOOLS.has(tool) || (/^mcp__/.test(tool) && isFileWritingMcpTool(tool)) ? 'deny' : null;
  if (host !== 'opencode') return null;
  const kind = tool.toLowerCase();
  if (OPENCODE_EDIT_KINDS.test(kind)) return 'deny';
  if (OPENCODE_NATIVE_TOOLS.has(kind)) return null;
  return isFileWritingMcpTool(opencodeMcpName(tool)) ? 'deny' : null;
}

/**
 * A Codex permission request that grants file-write access (fileSystem.write,
 * a write entry); a shape it cannot read counts as one. Network-only grants do not.
 */
export function codexGrantWritesFiles(permissions) {
  if (!permissions || typeof permissions !== 'object') return false;
  const fs = permissions.fileSystem ?? permissions.file_system ?? permissions.filesystem;
  if (fs === undefined || fs === null) return false;
  if (typeof fs !== 'object' || Array.isArray(fs)) return true;
  for (const [key, value] of Object.entries(fs)) {
    if (key === 'read' || key === 'globScanMaxDepth' || key === 'glob_scan_max_depth') continue;
    if (key === 'write') { if (value != null && !(Array.isArray(value) && value.length === 0)) return true; continue; }
    if (key === 'entries') {
      if (value == null) continue;
      if (!Array.isArray(value)) return true;
      if (value.some((entry) => !['read', 'deny', 'none'].includes(String(entry?.access ?? entry?.mode ?? '').toLowerCase()))) return true;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Codex in plan mode (a translated control_request; plan collaboration mode in
 * a read-only sandbox): 'deny' for a patch, a grant of file-write access or a
 * file-writing MCP tool; 'allow' for a read-only command or MCP tool, or
 * anything when the approval mode is auto; else null: a card, as outside plan
 * mode (questions and MCP forms always).
 */
export function codexPlanPermission(packet, { approvalMode = 'default' } = {}) {
  const request = packet?.request || {};
  const native = request.brain_native || {};
  const method = native.method || request.method || '';
  const params = native.params || {};
  const auto = AUTO_APPROVAL.has(approvalMode);
  if (method === 'item/fileChange/requestApproval') return 'deny';
  if (method === 'item/permissions/requestApproval') {
    if (codexGrantWritesFiles(params.permissions ?? request.input?.permissions)) return 'deny';
    return auto ? 'allow' : null;
  }
  if (method === 'item/commandExecution/requestApproval') {
    const command = params.command ?? request.input?.command;
    if (isReadOnlyShellCommand(Array.isArray(command) ? command.join(' ') : command)) return 'allow';
    return auto ? 'allow' : null;
  }
  if (method === 'mcpServer/elicitation/request') {
    const meta = params._meta ?? params.meta ?? {};
    if (meta.codex_approval_kind !== 'mcp_tool_call' || !meta.tool_name) return null;
    const server = { serverName: params.serverName };
    if (isFileWritingMcpTool(meta.tool_name, server)) return 'deny';
    if (isReadOnlyMcpTool(meta.tool_name, meta.tool_params || meta.arguments || {}, server)) return 'allow';
    return auto ? 'allow' : null;
  }
  return null;
}

/**
 * OpenCode in plan mode (a translated permission ask, SynaBun's plan agent):
 * 'deny' for the edit family or a file-writing MCP tool; 'allow' for a read
 * (a read-only command line included), or anything when the approval mode is
 * auto; else null: a card, as outside plan mode (questions always).
 */
export function opencodePlanPermission(packet, { approvalMode = 'default' } = {}) {
  const request = packet?.request || {};
  if ((request.brain_native || {}).kind === 'question') return null;
  const kind = String(request.tool_name || request.toolName || '');
  const auto = AUTO_APPROVAL.has(approvalMode);
  if (OPENCODE_EDIT_KINDS.test(kind)) return 'deny';
  // The whole command line (metadata.command), never OpenCode's per-command patterns.
  if (/^bash$/i.test(kind)) return isReadOnlyShellCommand(request.input?.metadata?.command) || auto ? 'allow' : null;
  if (OPENCODE_READ_KINDS.has(kind.toLowerCase())) return 'allow';
  if (!OPENCODE_NATIVE_TOOLS.has(kind.toLowerCase())) {
    const mcp = opencodeMcpName(kind);
    if (isFileWritingMcpTool(mcp)) return 'deny';
    if (isReadOnlyMcpTool(mcp, request.input?.metadata || {})) return 'allow';
  }
  return auto ? 'allow' : null;
}

// ── workers of a planning brain ──────────────────────────────────────────────

/** A run that can change code: capability workspace or full (an unknown one reads as full). */
export function runCanChangeCode(run) {
  return String(run?.capability || 'full').trim().toLowerCase() !== 'read-only';
}

export const PLAN_DISPATCH_NOTE = 'plan mode: this worker runs with capability "read-only" (a worker dispatched while planning cannot change code); dispatch the implementation after the user approves the plan';

/**
 * What a planning brain's dispatch becomes: a copy with capability "read-only".
 * `notes` collects PLAN_DISPATCH_NOTE when the capability changed (clampDispatchSpec's pattern).
 */
export function clampPlanDispatch(spec = {}, { notes = null } = {}) {
  const asked = String(spec?.capability || 'full').trim().toLowerCase();
  if (asked !== 'read-only' && Array.isArray(notes) && !notes.includes(PLAN_DISPATCH_NOTE)) notes.push(PLAN_DISPATCH_NOTE);
  return { ...spec, capability: 'read-only' };
}
