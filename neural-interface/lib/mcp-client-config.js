/** Pure configuration builders for the non-Codex MCP clients. */

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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

export function toOpenCodeMcpEntry(mcpConfig) {
  const source = asObject(mcpConfig);
  const { type: _type, command, args, env, environment, ...rest } = source;
  const entry = { type: 'local', ...rest };
  if (command) entry.command = Array.isArray(command) ? [...command] : [command, ...(args || [])];
  const envObj = environment || env;
  if (envObj && Object.keys(envObj).length > 0) entry.environment = { ...envObj };
  return entry;
}

export function mergeOpenCodeMcpConfig(existing, name, mcpConfig) {
  const config = asObject(existing);
  return {
    ...config,
    mcp: {
      ...asObject(config.mcp),
      [name]: toOpenCodeMcpEntry(mcpConfig),
    },
  };
}
