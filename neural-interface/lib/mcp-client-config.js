/** Pure configuration builders for the non-Codex MCP clients. */

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const REMOTE_TYPES = new Set(['http', 'sse']);

/** Remote servers are addressed by URL and never spawn a subprocess. */
export function isRemoteMcp(config) {
  return REMOTE_TYPES.has(asObject(config).type);
}

function hasKeys(value) {
  const obj = asObject(value);
  return Object.keys(obj).length > 0 ? obj : null;
}

export function mergeClaudeMcpConfig(existing, url) {
  const config = asObject(existing);
  return {
    ...config,
    mcpServers: {
      ...asObject(config.mcpServers),
      SynaBun: { type: 'http', url },
    },
  };
}

/**
 * Registry config → a `~/.claude.json` mcpServers entry.
 * Remote servers keep `headers` and the `oauth` block ({clientId, callbackPort});
 * dropping either is what breaks an OAuth-authenticated server on re-sync.
 */
export function buildClaudeMcpEntry(config) {
  const source = asObject(config);
  if (!isRemoteMcp(source)) {
    const entry = { command: source.command };
    if (source.args?.length) entry.args = [...source.args];
    const env = hasKeys(source.env);
    if (env) entry.env = { ...env };
    return entry;
  }
  const entry = { type: source.type, url: source.url };
  const headers = hasKeys(source.headers);
  if (headers) entry.headers = { ...headers };
  const oauth = hasKeys(source.oauth);
  if (oauth) entry.oauth = { ...oauth };
  return entry;
}

/**
 * Registry config → an entry of Antigravity's `~/.gemini/config/mcp_config.json` mcpServers
 * (the file `agy mcp add` writes, shared by the CLI and the Antigravity app): a local server is
 * `{ command, args, env, disabled }`, a remote one `{ serverUrl, headers, disabled }` whatever
 * its transport (Antigravity tells streamable HTTP and SSE apart by itself).
 */
export function buildAntigravityMcpEntry(config) {
  const source = asObject(config);
  if (!isRemoteMcp(source)) {
    const entry = { command: source.command || '' };
    if (source.args?.length) entry.args = [...source.args];
    const env = hasKeys(source.env);
    if (env) entry.env = { ...env };
    entry.disabled = false;
    return entry;
  }
  const entry = { serverUrl: source.url };
  const headers = hasKeys(source.headers);
  if (headers) entry.headers = { ...headers };
  entry.disabled = false;
  return entry;
}

/** The transport and address of an Antigravity mcp_config.json entry ({ transport, url? , command? }), for the installed list. */
export function describeAntigravityMcpEntry(entry) {
  const source = asObject(entry);
  if (typeof source.serverUrl === 'string' && source.serverUrl) return { transport: 'http', url: source.serverUrl, disabled: source.disabled === true };
  return { transport: 'stdio', command: typeof source.command === 'string' ? source.command : '', args: Array.isArray(source.args) ? source.args : [], disabled: source.disabled === true };
}

/** An Antigravity mcp_config.json's text as an object: an empty file (as Antigravity creates it) is `{}`. Throws on JSON that is not an object. */
export function parseAntigravityMcpConfig(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mcp_config.json does not hold a JSON object');
  return value;
}

/**
 * Registry config → the key/value pairs for a `[mcp_servers.<name>]` TOML section.
 * Remote servers get `url` and never a `command`, which Codex would treat as stdio.
 */
export function buildCodexMcpKv(config) {
  const source = asObject(config);
  if (!isRemoteMcp(source)) {
    const kv = { command: source.command || '' };
    if (source.args?.length) kv.args = [...source.args];
    const env = hasKeys(source.env);
    if (env) kv.env = { ...env };
    return kv;
  }
  const kv = { url: source.url };
  const headers = hasKeys(source.headers);
  if (headers) kv.http_headers = { ...headers };
  return kv;
}

/** SynaBun's own entry in Antigravity's mcp_config.json; every other server and key is kept as it was. */
export function mergeAntigravityMcpConfig(existing, definition) {
  const config = asObject(existing);
  return {
    ...config,
    mcpServers: {
      ...asObject(config.mcpServers),
      SynaBun: {
        command: definition.command,
        args: [...(definition.args || [])],
        env: { ...asObject(definition.env) },
        disabled: false,
      },
    },
  };
}

/** Antigravity's mcp_config.json without SynaBun's entry (and without an emptied `mcpServers`). */
export function removeAntigravityMcpServer(existing, name = 'SynaBun') {
  const config = { ...asObject(existing) };
  const servers = { ...asObject(config.mcpServers) };
  delete servers[name];
  if (Object.keys(servers).length) config.mcpServers = servers;
  else delete config.mcpServers;
  return config;
}
