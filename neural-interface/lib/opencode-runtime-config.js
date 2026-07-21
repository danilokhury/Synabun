/**
 * Build the SynaBun MCP entry used by managed OpenCode runtimes.
 *
 * Managed sidepanels/automations must always use a local MCP child. Reusing a
 * user's remote entry would ignore process environment pins and collapse all
 * sessions onto the shared HTTP server. Preserve harmless local options, but
 * remove remote-only transport fields and canonicalize command/environment.
 */
export function buildManagedOpenCodeSynabunEntry(existing, {
  command,
  defaults = {},
  overrides = {},
  clearEnv = [],
} = {}) {
  const source = existing && typeof existing === 'object' ? existing : {};
  const {
    url: _url,
    headers: _headers,
    oauth: _oauth,
    environment: _environment,
    env: _env,
    command: _command,
    type: _type,
    ...safeOptions
  } = source;
  const environment = {
    ...(source.environment || source.env || {}),
    ...defaults,
    ...overrides,
  };
  for (const key of clearEnv) delete environment[key];
  return {
    ...safeOptions,
    type: 'local',
    command: Array.isArray(command) ? [...command] : command,
    enabled: true,
    environment,
    env: { ...environment },
  };
}
