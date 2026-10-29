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
 * Registry config → a `~/.gemini/settings.json` mcpServers entry.
 * Gemini CLI addresses streamable HTTP as `httpUrl` and SSE as `url`.
 */
export function buildGeminiMcpEntry(config) {
  const source = asObject(config);
  if (!isRemoteMcp(source)) {
    const entry = { command: source.command || '' };
    if (source.args?.length) entry.args = [...source.args];
    const env = hasKeys(source.env);
    if (env) entry.env = { ...env };
    return entry;
  }
  const entry = source.type === 'sse' ? { url: source.url } : { httpUrl: source.url };
  const headers = hasKeys(source.headers);
  if (headers) entry.headers = { ...headers };
  return entry;
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

export function mergeGeminiMcpConfig(existing, definition) {
  const config = asObject(existing);
  return {
    ...config,
    mcpServers: {
      ...asObject(config.mcpServers),
      SynaBun: {
        command: definition.command,
        args: [...(definition.args || [])],
        env: { ...asObject(definition.env) },
        trust: true,
      },
    },
  };
}
