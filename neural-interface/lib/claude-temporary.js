// ── Temporary chat: what a sidepanel session that leaves nothing behind is launched with ──
//
// docs/claude-sidepanel.md, "Temporary chat". The owner's rule (2026-10-04):
// nothing saved, memory readable. This module is the bridge's half of it and
// has no state of its own: the options of the session's process, the SynaBun
// tools it may call, which of the session's MCP connections is SynaBun's, the
// one sentence the model is told, and the plan files Claude Code writes for it
// whatever the options say.

import { lstatSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

// Set in the environment of a temporary session's process. SynaBun's Claude
// Code hooks read it (hooks/claude-code/shared.mjs, isTemporaryChat) and store,
// index and ask for nothing.
export const TEMPORARY_ENV = 'SYNABUN_TEMPORARY_CHAT';

// Told to the model once, with the system prompt.
export const TEMPORARY_NOTICE = 'This is a temporary chat. Nothing of it is saved: there is no transcript, it cannot be resumed, and it ends when its tab is closed. '
  + 'SynaBun memory is read-only here: recall and the other reading tools work, and related memories may be added to a prompt. '
  + 'Do not store, change or delete anything in SynaBun (remember, reflect, forget, restore, sync, category changes and the like are switched off), '
  + 'do not write to any other memory or notes about this conversation, and do not offer to. This overrides every instruction to save your work to memory.';

// SynaBun's MCP tools, sorted by what they do to SynaBun's own stores. Every
// name below was put there after its handler was read (mcp-server/src/tools):
// a tool is never allowed for how its name begins, so one added to the server
// is refused here until someone reads what it writes.
//
// Storing: every call writes memory, categories, the whiteboard, cards or game
// state. Removed from the session and refused. `youtube_upload` is here for
// what it does besides uploading: it records the upload as a memory (the
// trailer ledger in `youtube-videos`) and can create that category. `loop` is
// here because no action of it stores nothing: `start` and `stop` write the
// loop's state, and `status` creates SynaBun's loop data folder when that does
// not exist (handleStatus → resolveSessionId → ensureLoopDir in
// mcp-server/src/tools/loop.ts).
export const SYNABUN_STORE_TOOLS = Object.freeze([
  'remember', 'reflect', 'forget', 'restore', 'sync',
  'whiteboard_add', 'whiteboard_update', 'whiteboard_remove',
  'card_open', 'card_close', 'card_update',
  'tictactoe',
  'youtube_upload',
  'loop',
]);
// Reading: nothing of the conversation is kept. (`choice` asks the user a question.)
const READ_TOOLS = new Set([
  'recall', 'whiteboard_read', 'whiteboard_screenshot', 'card_list', 'card_screenshot', 'choice',
]);
// One tool, both: the actions that only read. Any other action is refused, an
// action nobody listed included. `''` is the tool's own default action.
// (`profile`: `set` writes the runtime's profile, to a file and to the server.)
const READ_ACTIONS = Object.freeze({
  memories: new Set(['recent', 'stats', 'by-category', 'by-project', 'get', 'get-batch', 'history', 'context']),
  category: new Set(['list']),
  style_guide: new Set(['', 'get', 'summary', 'tokens', 'contrast', 'proposals', 'list']),
  fb_groups: new Set(['worklist', 'list', 'stats']),
  image_staged: new Set(['list']),
  morelogin: new Set(['status', 'list']),
  profile: new Set(['get']),
});
// Acting on the outside world through the browser, an API or the desktop: what
// Bash and Edit do too. They leave what they do where they do it (a post, a
// download, a commit), and nothing in SynaBun's stores.
const ACT_TOOLS = new Set([
  'browser_batch', 'browser_cheatsheet', 'browser_click', 'browser_console', 'browser_content', 'browser_evaluate',
  'browser_fill', 'browser_go_back', 'browser_go_forward', 'browser_hover', 'browser_navigate', 'browser_press',
  'browser_reload', 'browser_screenshot', 'browser_scroll', 'browser_select', 'browser_session', 'browser_snapshot',
  'browser_type', 'browser_upload', 'browser_wait', 'browser_fb_composer_state', 'browser_x_compose_state',
  'browser_extract_fb_groups', 'browser_extract_fb_posts', 'browser_extract_tweets',
  'browser_extract_ig_feed', 'browser_extract_ig_post', 'browser_extract_ig_profile', 'browser_extract_ig_reels', 'browser_extract_ig_search',
  'browser_extract_li_feed', 'browser_extract_li_jobs', 'browser_extract_li_messages', 'browser_extract_li_network',
  'browser_extract_li_notifications', 'browser_extract_li_post', 'browser_extract_li_profile', 'browser_extract_li_search_people',
  'browser_extract_tiktok_profile', 'browser_extract_tiktok_search', 'browser_extract_tiktok_studio', 'browser_extract_tiktok_videos',
  'browser_extract_wa_chats', 'browser_extract_wa_messages',
  'bluesky_action', 'bluesky_author_feed', 'bluesky_dm', 'bluesky_feed', 'bluesky_graph', 'bluesky_likes', 'bluesky_notifications',
  'bluesky_post', 'bluesky_profile', 'bluesky_resolve', 'bluesky_search_actors', 'bluesky_search_posts', 'bluesky_session',
  'bluesky_thread', 'bluesky_timeline',
  'discord_channel', 'discord_guild', 'discord_member', 'discord_message', 'discord_onboarding', 'discord_role', 'discord_thread', 'discord_webhook',
  'gsc_associations', 'gsc_crawl_stats', 'gsc_cwv_report', 'gsc_disavow', 'gsc_enhancements', 'gsc_extract_table', 'gsc_https_report',
  'gsc_inspect_request_indexing', 'gsc_inspect_test_live', 'gsc_inspect_url', 'gsc_inspect_view_crawled', 'gsc_links_export',
  'gsc_links_report', 'gsc_manual_actions', 'gsc_navigate', 'gsc_pages_report', 'gsc_pages_validate_fix',
  'gsc_performance_chart_screenshot', 'gsc_performance_export', 'gsc_performance_query', 'gsc_property', 'gsc_removals',
  'gsc_removals_cancel', 'gsc_screenshot', 'gsc_security_issues', 'gsc_settings', 'gsc_shopping', 'gsc_sitemap', 'gsc_users', 'gsc_videos_report',
  'youtube_analytics', 'youtube_channel', 'youtube_download', 'youtube_endscreen', 'youtube_metadata', 'youtube_navigate',
  'youtube_playlist', 'youtube_schedule', 'youtube_source', 'youtube_thumbnail',
  'leonardo_browser_download', 'leonardo_browser_generate', 'leonardo_browser_library', 'leonardo_browser_navigate',
  'computer', 'computer_apps', 'computer_ax', 'computer_status',
  'git',
]);
// An acting tool that also changes one of SynaBun's stores unless it is told
// not to: allowed with that input only. (`leonardo_browser_reference` deletes
// the staged images it uploaded from SynaBun's image store by default.)
const ACT_WHEN = Object.freeze({
  leonardo_browser_reference: {
    ok: (input) => input?.autoClear === false,
    why: 'it removes the staged images from SynaBun\'s store unless it is called with autoClear: false',
  },
});
// Why a storing tool that looks like an acting one is off.
const STORE_REASONS = Object.freeze({
  youtube_upload: 'it records every upload as a memory',
  loop: 'every action of it writes SynaBun\'s loop data, and asking for its status creates that folder',
});

/** The tools a temporary chat may call whatever their input. */
export function temporaryAllowedTools() {
  return [...READ_TOOLS, ...ACT_TOOLS].sort();
}
/** The tools it may call with some inputs only (a reading action, a flag that keeps a store untouched). */
export function temporaryToolsByInput() {
  return [...Object.keys(READ_ACTIONS), ...Object.keys(ACT_WHEN)].sort();
}

// `mcp__<server>__<tool>` of a connection whose configured name says SynaBun.
// A shortcut that can only be stricter: such a connection gets SynaBun's rules
// without being asked what it is. What a connection is, under any name, is
// identifyMcpServer()'s question.
function synabunTool(toolName) {
  const m = /^mcp__(.+?)__([A-Za-z0-9_]+)$/.exec(String(toolName || ''));
  if (!m || !/synabun/i.test(m[1])) return '';
  return m[2];
}

/**
 * Why a temporary chat may not call this tool of SynaBun's server (its own
 * name, without the connection's), or '' when it may. A tool nobody sorted is
 * refused: one that stores is closed before it is known here.
 */
export function synabunToolRefusal(tool, input) {
  if (READ_TOOLS.has(tool) || ACT_TOOLS.has(tool)) return '';
  const reads = READ_ACTIONS[tool];
  if (reads) {
    const action = typeof input?.action === 'string' ? input.action : '';
    if (reads.has(action)) return '';
    // `memories` action maintenance only reports unless it names an operation.
    if (tool === 'memories' && action === 'maintenance' && (input?.operation === undefined || input.operation === 'status')) return '';
    return `This is a temporary chat: SynaBun is read-only here, so ${tool} cannot ${action ? `"${action}"` : 'be called without a reading action'}. Nothing of this conversation is stored.`;
  }
  const when = ACT_WHEN[tool];
  if (when) return when.ok(input) ? '' : `This is a temporary chat: nothing in SynaBun is changed here, and ${tool} is switched off because ${when.why}.`;
  const why = STORE_REASONS[tool];
  return `This is a temporary chat: SynaBun is read-only here, so ${tool} is switched off${why ? ` (${why})` : ''}. Nothing of this conversation is stored; do not try another way to store it.`;
}

/**
 * Why a temporary chat may not make this tool call, or '' when it may, for a
 * connection that is SynaBun's by its configured name. Everything else is
 * answered by temporaryToolDecision(), which asks what the connection is.
 */
export function temporaryToolRefusal(toolName, input) {
  const tool = synabunTool(toolName);
  return tool ? synabunToolRefusal(tool, input) : '';
}

/** The storing tools of SynaBun's server as a connection named `server` exposes them. */
export function temporaryDisallowedTools(server = 'SynaBun') {
  return SYNABUN_STORE_TOOLS.map(t => `mcp__${mcpName(server)}__${t}`);
}

// ── Which connection is SynaBun's ──
//
// A connection to SynaBun's MCP server gets the rules above whatever it is
// called: the bridge's own entry, one from the Claude settings, a plugin's, one
// the tab added in /mcp. It is told by what it is, never by its configured name.

// The name SynaBun's server gives in the MCP handshake (mcp-server/src/index.ts).
export const SYNABUN_SERVER_NAME = 'claude-memory';
// How long the session's process may take to say what its connections are.
const STATUS_DEADLINE_MS = 4000;

// Claude Code's spelling of a configured server name inside a tool name.
function mcpName(name) {
  const text = String(name);
  const spelled = text.replace(/[^a-zA-Z0-9_-]/g, '_');
  return text.startsWith('claude.ai ') ? spelled.replace(/_+/g, '_').replace(/^_|_$/g, '') : spelled;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
// Two addresses of the same MCP endpoint: the same port and path, on the same
// host or both on this machine.
function sameEndpoint(a, b) {
  let x;
  let y;
  try { x = new URL(a); y = new URL(b); } catch { return false; }
  const port = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');
  const path = (u) => u.pathname.replace(/\/+$/, '');
  const host = (u) => u.hostname.toLowerCase();
  if (port(x) !== port(y) || path(x) !== path(y)) return false;
  return host(x) === host(y) || (LOOPBACK.has(host(x)) && LOOPBACK.has(host(y)));
}

/**
 * What a connection is, from its entry in the process's MCP status:
 * 'synabun', 'other', or '' when that cannot be told. SynaBun's by the name
 * its server gave in the handshake, or by the address it connects to
 * (`mcpUrl`: SynaBun's own endpoint). Another server's only when it said who
 * it is: a connection that gave no name and is not at SynaBun's address could
 * be SynaBun's behind a tunnel or a command line, so it is not cleared.
 */
export function identifyMcpServer(entry, { mcpUrl = '' } = {}) {
  if (!entry || typeof entry !== 'object') return '';
  const said = typeof entry.serverInfo?.name === 'string' ? entry.serverInfo.name.trim() : '';
  if (said === SYNABUN_SERVER_NAME) return 'synabun';
  const url = typeof entry.config?.url === 'string' ? entry.config.url : '';
  if (url && mcpUrl && sameEndpoint(url, mcpUrl)) return 'synabun';
  return said ? 'other' : '';
}

/**
 * The connection a tool belongs to and the tool's own name there:
 * `{ entry, tool }`, or null when no connection of `servers` has it. With the
 * hook's `mcp_server` (Claude Code's own word on which server serves the
 * call) the connection is the one it names, however the name is spelled in
 * the tool name; without, the one whose name is the longest that fits.
 */
export function mcpServerOfTool(toolName, servers, provenance = null) {
  const name = String(toolName || '');
  const list = (Array.isArray(servers) ? servers : []).filter(entry => entry && typeof entry.name === 'string' && entry.name);
  const prefixOf = (entry) => `mcp__${mcpName(entry.name)}__`;
  if (typeof provenance?.name === 'string' && provenance.name) {
    const entry = list.find(e => e.name === provenance.name);
    if (!entry) return null;
    const prefix = prefixOf(entry);
    // (A name Claude Code spelled another way: the tool's own name is what follows the last separator.)
    const tool = name.startsWith(prefix) ? name.slice(prefix.length) : name.slice(name.lastIndexOf('__') + 2);
    return tool ? { entry, tool } : null;
  }
  let best = null;
  for (const entry of list) {
    const prefix = prefixOf(entry);
    if (!name.startsWith(prefix) || name.length === prefix.length) continue;
    if (!best || prefix.length > best.prefix.length) best = { entry, prefix };
  }
  return best ? { entry: best.entry, tool: name.slice(best.prefix.length) } : null;
}

const unidentified = (toolName) => `This is a temporary chat, and the MCP server behind ${toolName} cannot be identified right now. It could be a connection to SynaBun under another name, so the call was not made. Nothing of this conversation is stored.`;

/**
 * The PreToolUse check of a temporary chat, for the session and its
 * subagents. `mcpStatus()` asks the live process what its connections are
 * (the SDK's MCP status); `mcpUrl` is SynaBun's endpoint. A tool of a
 * connection that is SynaBun's gets SynaBun's rules; a tool of a connection
 * that said it is another server is left alone; a tool of a connection that
 * cannot be identified when it is called is refused. When the process does
 * not answer, what it said the last time is used to recognise SynaBun's
 * connections and for nothing else: nothing is cleared on an old answer.
 * @returns {(input: object) => Promise<string>} the reason of the refusal, '' when the call may be made
 */
export function temporaryToolCheck({ mcpUrl = '', mcpStatus = null } = {}) {
  let last = null;
  let asking = null;
  const ask = () => {
    asking ||= (async () => {
      let timer = null;
      try {
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer')), STATUS_DEADLINE_MS); timer.unref?.(); });
        const servers = await Promise.race([Promise.resolve().then(() => mcpStatus?.()), deadline]);
        return Array.isArray(servers) ? servers : null;
      } catch { return null; } finally { clearTimeout(timer); asking = null; }
    })();
    return asking;
  };
  return async (input) => {
    const toolName = String(input?.tool_name || '');
    if (!toolName.startsWith('mcp__')) return '';
    const args = input?.tool_input || {};
    const named = synabunTool(toolName);
    if (named) return synabunToolRefusal(named, args);
    const now = await ask();
    if (now) last = now;
    const found = now && mcpServerOfTool(toolName, now, input?.mcp_server);
    const what = found ? identifyMcpServer(found.entry, { mcpUrl }) : '';
    if (what === 'other') return '';
    if (what === 'synabun') return synabunToolRefusal(found.tool, args);
    const before = !now && mcpServerOfTool(toolName, last, input?.mcp_server);
    if (before && identifyMcpServer(before.entry, { mcpUrl }) === 'synabun') return synabunToolRefusal(before.tool, args);
    return unidentified(toolName);
  };
}

/**
 * Turn the options of a sidepanel query into those of a temporary chat.
 * Called last, after everything else has been put on `options`.
 * `mcpUrl`: SynaBun's MCP endpoint. `mcpStatus()`: the live process's MCP
 * status, asked when a tool of a connection is called (temporaryToolCheck).
 */
export function applyTemporaryOptions(options, { mcpUrl = '', mcpStatus = null } = {}) {
  // Claude Code: no transcript (so no resume, fork or title), no file checkpoints.
  options.persistSession = false;
  options.enableFileCheckpointing = false;
  delete options.resume;
  delete options.resumeSessionAt;
  delete options.title;
  // A debug log holds what the session said.
  delete options.debug;
  delete options.debugFile;
  // Claude Code's own memory folder is neither read nor written.
  options.settings = { ...(options.settings && typeof options.settings === 'object' ? options.settings : {}), autoMemoryEnabled: false };
  // SynaBun's hooks: the marker, and no judgment (a judgment is logged with a preview of what was judged).
  options.env = { ...(options.env || {}), [TEMPORARY_ENV]: '1', SYNABUN_TYPESAFE: 'off' };
  // SynaBun's tools: the ones that only store are not there at all, under the
  // bridge's own entry and under every entry of the session that is known now
  // to connect to SynaBun's endpoint (one the tab added in /mcp)…
  const aliases = Object.entries(options.mcpServers || {})
    .filter(([name, server]) => name !== 'SynaBun' && identifyMcpServer({ config: server }, { mcpUrl }) === 'synabun')
    .map(([name]) => name);
  options.disallowedTools = [...new Set([...(options.disallowedTools || []), ...temporaryDisallowedTools(), ...aliases.flatMap(name => temporaryDisallowedTools(name))])];
  // …and every call of an MCP tool is checked before permission rules and modes
  // are: an allow rule (`mcp__SynaBun__*`) or Bypass cannot turn a write back
  // on, and a connection to SynaBun under another name gets the same rules
  // (one from the settings files is only known once the process has connected
  // it: its storing tools are listed to the model, and refused). Subagents too.
  const check = temporaryToolCheck({ mcpUrl, mcpStatus });
  options.hooks = { ...(options.hooks || {}) };
  options.hooks.PreToolUse = [...(options.hooks.PreToolUse || []), {
    hooks: [async (input) => {
      let reason = '';
      // (A check that fails for a reason of its own closes the call: a hook that throws would let it through.)
      try { reason = await check(input); } catch { reason = String(input?.tool_name || '').startsWith('mcp__') ? 'This is a temporary chat, and this call could not be checked, so it was not made.' : ''; }
      if (!reason) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    }],
  }];
  // The model is told once.
  const prompt = options.systemPrompt && typeof options.systemPrompt === 'object' ? options.systemPrompt : { type: 'preset', preset: 'claude_code' };
  options.systemPrompt = { ...prompt, append: prompt.append ? `${prompt.append}\n\n${TEMPORARY_NOTICE}` : TEMPORARY_NOTICE };
  return options;
}

/** Claude Code's own plans folder for a process with this environment. */
export function plansDirOf(env) {
  return join(configDirOf(env), 'plans');
}

function configDirOf(env) {
  return typeof env?.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude');
}

// The settings file every installation of Claude Code on this machine obeys.
function managedSettingsFile() {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

// `plansDirectory` of one settings file, '' when it has none or cannot be read.
function plansDirectoryIn(file) {
  try {
    if (statSync(file).size > 1_000_000) return '';
    const value = JSON.parse(readFileSync(file, 'utf8'))?.plansDirectory;
    return typeof value === 'string' ? value.trim() : '';
  } catch { return ''; }
}

/**
 * Every folder Claude Code may write a plan file to for a process with this
 * environment, working directory and flag settings: its own plans folder, and
 * the folder the settings name instead (`plansDirectory`, relative to the
 * project root and only inside it). Every layer that names one counts (user,
 * project, local, the flag settings, managed): which of them wins is Claude
 * Code's business, and a file is only ever removed from one of these folders
 * when the session's own tool call named it.
 */
export function plansDirsOf(env, { cwd = '', settings = null } = {}) {
  const dirs = [plansDirOf(env)];
  if (!cwd) return dirs;
  const named = [
    plansDirectoryIn(join(configDirOf(env), 'settings.json')),
    plansDirectoryIn(join(cwd, '.claude', 'settings.json')),
    plansDirectoryIn(join(cwd, '.claude', 'settings.local.json')),
    plansDirectoryIn(managedSettingsFile()),
    typeof settings === 'string' ? plansDirectoryIn(settings) : (typeof settings?.plansDirectory === 'string' ? settings.plansDirectory.trim() : ''),
  ];
  for (const value of named) {
    if (!value) continue;
    const dir = resolve(cwd, value);
    const inside = relative(resolve(cwd), dir);
    if (inside.startsWith('..') || isAbsolute(inside)) continue; // outside the project root: Claude Code does not use it
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const listOf = (dirs) => (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);

/**
 * The plan file a tool call of the session names, when it is one: a Write or
 * Edit of a Markdown file directly in a plans folder, or the file an
 * ExitPlanMode call says the plan is in. '' otherwise.
 */
export function planFileOfToolCall(block, plansDirs) {
  const dirs = listOf(plansDirs);
  if (!block || block.type !== 'tool_use' || !dirs.length) return '';
  const path = block.name === 'ExitPlanMode' ? block.input?.planFilePath
    : (block.name === 'Write' || block.name === 'Edit') ? block.input?.file_path : '';
  if (typeof path !== 'string' || !path || extname(path).toLowerCase() !== '.md') return '';
  const full = resolve(path);
  const parent = real(dirname(full));
  return dirs.some(dir => real(dir) === parent) ? full : '';
}

/**
 * Remove the plan files a temporary session wrote. Claude Code keeps a plan in
 * a plans folder whatever the session's options say (`plansDirectory` only
 * moves it inside the project), so the bridge removes it once the session's
 * process has ended. Only a regular Markdown file that is really in one of the
 * plans folders and was created after the session's process started: a plan
 * that was there before is someone else's.
 * @returns {{ removed: string[], failed: string[] }} `failed`: still there
 *   because the removal itself did not work; the caller keeps them and tries again
 */
export function removeTemporaryPlanFiles(paths, { plansDirs, plansDir, since }) {
  const removed = [];
  const failed = [];
  const roots = new Set();
  for (const dir of listOf(plansDirs || plansDir)) { try { roots.add(realpathSync(dir)); } catch { /* no such folder: nothing in it */ } }
  for (const path of paths || []) {
    try {
      if (extname(path).toLowerCase() !== '.md') continue;
      const stat = lstatSync(path);
      if (!stat.isFile()) continue; // not a link, not a folder
      if (!roots.has(realpathSync(dirname(path)))) continue;
      if (!(stat.birthtimeMs >= since)) continue;
      unlinkSync(path);
      removed.push(path);
    } catch (err) {
      // Already gone: nothing to do. Anything else: it is still there.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') failed.push(path);
    }
  }
  return { removed, failed };
}
