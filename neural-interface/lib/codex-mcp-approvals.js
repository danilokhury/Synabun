const CODEX_MCP_APPROVAL_MODES = new Set(['auto', 'prompt', 'writes', 'approve']);

export function codexConfigKeyPathSegment(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Codex config key path segments cannot be empty');
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : JSON.stringify(text);
}

export function codexConfigKeyPath(segments = []) {
  if (!Array.isArray(segments) || !segments.length) {
    throw new Error('Codex config key path requires at least one segment');
  }
  return segments.map(codexConfigKeyPathSegment).join('.');
}

export function buildCodexConfigEdits(config, prefix = []) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const edits = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    const path = [...prefix, key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      edits.push(...buildCodexConfigEdits(value, path));
      continue;
    }
    edits.push({
      keyPath: codexConfigKeyPath(path),
      value,
      mergeStrategy: 'upsert',
    });
  }
  return edits;
}

export function buildCodexMcpServerApprovalEdit(serverName, approvalMode) {
  if (!CODEX_MCP_APPROVAL_MODES.has(approvalMode)) {
    throw new Error(`Unsupported Codex MCP approval mode: ${approvalMode || '(empty)'}`);
  }
  return {
    keyPath: codexConfigKeyPath(['mcp_servers', serverName, 'default_tools_approval_mode']),
    value: approvalMode,
    mergeStrategy: 'upsert',
  };
}

export function getCodexMcpServerConfig(config, serverName) {
  const servers = config?.mcp_servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null;
  const server = servers[String(serverName || '')];
  return server && typeof server === 'object' && !Array.isArray(server) ? server : null;
}

export function codexMcpServerApprovalMode(config, serverName) {
  const mode = getCodexMcpServerConfig(config, serverName)?.default_tools_approval_mode;
  return CODEX_MCP_APPROVAL_MODES.has(mode) ? mode : null;
}
