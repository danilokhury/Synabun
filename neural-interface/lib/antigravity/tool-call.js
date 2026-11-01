// ═══════════════════════════════════════════
// SynaBun — what an Antigravity tool call is, read one way everywhere
// ═══════════════════════════════════════════
//
// Antigravity describes a tool call in two shapes: an ACP tool call (session/update tool_call,
// session/request_permission: { toolCallId, name, kind, title, locations, rawInput }) and the
// payload of a PreToolUse hook ({ toolCall: { name, args } }, no kind). Both name the tool by
// Antigravity's own word (read_file, run_command, write_to_file, call_mcp_tool …); an MCP call
// names its server and tool in its arguments ({ ServerName, ToolName, Arguments }), a command
// its line in CommandLine. Measured on agy 1.4.12 (docs/antigravity-sidepanel.md → Assistant).
//
//   acpCall(value)        either shape → { id, name, kind, title, args, locations, mcp, command }
//   acpToolName(call)     the name SynaBun's policies read: mcp__<server>__<tool> for an MCP call
//   acpUiToolName(call)   the name the Assistant panel shows: <server>_<tool> (SynaBun_agent_route) for MCP
//   acpToolKind(call)     ACP kind, from the call or from the tool's name when the hook payload has none
//   acpWebTool(call)      Antigravity's own web search, URL reading or browser (the browser policy refuses it)
//   acpToolPaths(call)    every path the call names
//
// Pure: no I/O.

export const ACP_MCP_TOOL = 'call_mcp_tool';

// Antigravity's own tools, by what they do (the names its agent and its hooks use).
const READ_TOOLS = new Set([
  'read_file', 'view_file', 'view_file_outline', 'view_code_item', 'view_content_chunk', 'list_dir', 'list_directory',
  'grep_search', 'find_by_name', 'find', 'codebase_search', 'code_search', 'read_resource', 'list_resources',
  'read_terminal', 'command_status', 'read_notebook', 'trajectory_search', 'internal_search', 'retrieve_memory',
  'find_all_references',
]);
const EDIT_TOOLS = new Set([
  'write_to_file', 'write_file', 'create_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file',
  'apply_patch', 'propose_code', 'file_change', 'edit_notebook', 'write_blob',
]);
const DELETE_TOOLS = new Set(['delete_file', 'delete_directory']);
const MOVE_TOOLS = new Set(['move_file', 'move', 'rename_file']);
const EXECUTE_TOOLS = new Set(['run_command', 'shell_exec', 'send_command_input', 'execute_notebook', 'run_extension_code']);
// Antigravity's own web: search, URL reading, its browser and browser subagent.
const WEB_TOOLS = new Set([
  'search_web', 'read_url_content', 'execute_url', 'open_browser_url', 'read_browser_page', 'browser_subagent', 'list_browser_pages',
  'capture_browser_screenshot', 'capture_browser_console_logs', 'execute_browser_javascript', 'click_browser_pixel',
]);
const THINK_TOOLS = new Set(['task_boundary', 'notify_user', 'ask_question', 'suggested_responses', 'checkpoint']);

const PATH_KEYS = ['path', 'Path', 'file_path', 'filePath', 'filepath', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchPath', 'SearchDirectory', 'target', 'dest', 'destination', 'Destination', 'newPath', 'new_path', 'source', 'Source', 'from', 'to', 'oldPath', 'old_path'];
const COMMAND_KEYS = ['CommandLine', 'command', 'cmd'];

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const text = (value) => (typeof value === 'string' ? value : '');

/** The MCP server, tool and arguments of an Antigravity MCP call, else null. */
export function acpMcpTarget(nameOrCall, rawArgs) {
  const name = typeof nameOrCall === 'string' ? nameOrCall : text(nameOrCall?.name);
  const args = asObject(typeof nameOrCall === 'string' ? rawArgs : (nameOrCall?.rawInput ?? nameOrCall?.args));
  const server = text(args.ServerName || args.serverName || args.server).trim();
  const tool = text(args.ToolName || args.toolName || args.tool).trim();
  if (name !== ACP_MCP_TOOL && !(server && tool && /mcp/i.test(name || text(nameOrCall?.title)))) return null;
  if (!server || !tool) return null;
  let inner = args.Arguments ?? args.arguments ?? {};
  if (typeof inner === 'string') inner = JSON.parse(inner);
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) throw new Error('MCP arguments must be an object');
  return { server, tool, args: inner };
}

/**
 * Either shape as one: { id, name, kind, title, args, locations, mcp, command }. `name` is Antigravity's own
 * word for the tool ('' when the call names none: an older agy, a stand-in), `kind` the ACP kind (from the
 * name when the shape has none), `mcp` the MCP target ({ server, tool, args }) or null.
 */
export function acpCall(value) {
  const source = asObject(value);
  const inner = source.toolCall && typeof source.toolCall === 'object' ? source.toolCall : source;
  const args = asObject(inner.rawInput ?? inner.args ?? inner.input);
  const name = text(inner.name).trim();
  const mcp = acpMcpTarget(name || text(inner.title), args) || (name ? null : acpMcpTarget({ name: ACP_MCP_TOOL, rawInput: args }));
  const call = {
    id: text(inner.toolCallId) || null,
    name,
    kind: '',
    title: text(inner.title),
    args,
    locations: Array.isArray(inner.locations) ? inner.locations : [],
    mcp,
    command: '',
  };
  call.kind = acpToolKind({ ...call, kind: text(inner.kind) });
  for (const key of COMMAND_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) { call.command = v; break; }
    if (Array.isArray(v) && v.length) { call.command = v.map(String).join(' '); break; }
  }
  return call;
}

/** The ACP kind of a call: its own when it has one (and it is not an MCP call), else read from its name. */
export function acpToolKind(call) {
  const named = text(call?.name).toLowerCase();
  if (call?.mcp || named === ACP_MCP_TOOL) return 'mcp';
  const own = text(call?.kind).toLowerCase();
  if (own && own !== 'other') return own;
  if (READ_TOOLS.has(named)) return named.includes('search') || named.startsWith('find') ? 'search' : 'read';
  if (EDIT_TOOLS.has(named)) return 'edit';
  if (DELETE_TOOLS.has(named)) return 'delete';
  if (MOVE_TOOLS.has(named)) return 'move';
  if (EXECUTE_TOOLS.has(named)) return 'execute';
  if (WEB_TOOLS.has(named) || /^browser_/.test(named)) return 'fetch';
  if (THINK_TOOLS.has(named)) return 'think';
  return own || 'other';
}

/** The name SynaBun's policies read: mcp__<server>__<tool> for an MCP call (the Claude spelling), else Antigravity's word. */
export function acpToolName(value) {
  const call = value?.args && 'mcp' in value ? value : acpCall(value);
  if (call.mcp) return `mcp__${call.mcp.server}__${call.mcp.tool}`;
  return call.name || call.title || call.kind || 'tool';
}

/** The name the Assistant panel shows: <server>_<tool> for an MCP call (SynaBun_agent_route, as OpenCode's), else Antigravity's word. */
export function acpUiToolName(value) {
  const call = value?.args && 'mcp' in value ? value : acpCall(value);
  if (call.mcp) return `${call.mcp.server}_${call.mcp.tool}`;
  return call.name || call.kind || 'tool';
}

/** Whether this is Antigravity's own web search, URL reading or browser (never SynaBun's browser tools). */
export function acpWebTool(value) {
  const call = value?.args && 'mcp' in value ? value : acpCall(value);
  if (call.mcp) return false;
  const named = call.name.toLowerCase();
  return WEB_TOOLS.has(named) || /^browser_/.test(named) || (!named && call.kind === 'fetch');
}

/** Every path the call names, including nested path-like values in an MCP call's arguments. */
export function acpToolPaths(value) {
  const call = value?.args && 'mcp' in value ? value : acpCall(value);
  const out = [];
  for (const location of call.locations) if (typeof location?.path === 'string' && location.path) out.push(location.path);
  if (call.mcp) {
    let nodes = 0;
    const visit = (value, key = '', depth = 0) => {
      if (++nodes > 10000 || depth > 32) throw new Error('MCP arguments exceed the path inspection limit');
      if (typeof value === 'string') {
        if (PATH_KEYS.includes(key) || /[\\/]|^(?:[~.]|\$\{?HOME\}?)/.test(value.trim())) out.push(value.trim());
      } else if (Array.isArray(value)) {
        for (const item of value) visit(item, key, depth + 1);
      } else if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
      }
    };
    visit(call.mcp.args);
  } else {
    for (const key of PATH_KEYS) {
      const v = call.args[key];
      if (typeof v === 'string' && v) out.push(v);
      else if (Array.isArray(v)) for (const item of v) if (typeof item === 'string' && item) out.push(item);
    }
  }
  return [...new Set(out)];
}

/** Whether a call only reads (Antigravity's read and search tools), for plan mode and the read-only level. */
export function acpReadOnlyKind(kind) {
  return kind === 'read' || kind === 'search' || kind === 'think';
}

/**
 * The call as the arguments a host-agnostic policy reads: an MCP call's own arguments, a command as `command`
 * (and its working folder as `cwd`), paths as `file_path`; the rest as Antigravity sent them.
 */
export function acpPolicyInput(value) {
  const call = value?.args && 'mcp' in value ? value : acpCall(value);
  if (call.mcp) return { ...call.mcp.args };
  const out = { ...call.args };
  if (call.command && typeof out.command !== 'string') out.command = call.command;
  if (typeof call.args.Cwd === 'string' && call.args.Cwd && typeof out.cwd !== 'string') out.cwd = call.args.Cwd;
  const paths = acpToolPaths(call);
  if (paths.length && typeof out.file_path !== 'string') out.file_path = paths[0];
  return out;
}
