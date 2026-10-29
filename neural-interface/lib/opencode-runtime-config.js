import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mcpServersOf, normalizeMcpServers, parseJsonc, setMcpServer, withPlugin } from './opencode-config.js';

/** The browser-policy plugin (assistant-brains/opencode2-browser-policy/, a plugin folder) as a file URL a serve can load. */
export const OPENCODE_BROWSER_POLICY_PLUGIN = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'assistant-brains', 'opencode2-browser-policy')).href;

/**
 * An Assistant task run's serve config gets SynaBun's browser policy as a
 * plugin (`cwd`: the run's project, for the scripts it reads; `roots`: the
 * registered code projects its test runners may also run in, as the run
 * starts), listed under `plugins`. The user's own plugins stay; an earlier
 * entry of ours is replaced. Returns `config`.
 */
export function withOpenCodeBrowserPolicy(config, { cwd = null, roots = [] } = {}) {
  const list = (Array.isArray(roots) ? roots : []).filter((path) => typeof path === 'string' && path);
  return withPlugin(config, OPENCODE_BROWSER_POLICY_PLUGIN, { ...(cwd ? { cwd: String(cwd) } : {}), ...(list.length ? { roots: list } : {}) });
}

/**
 * Build the SynaBun MCP entry used by managed OpenCode runtimes, in OpenCode
 * 2's shape (`mcp.servers.SynaBun`: type local, the command as an array, its
 * `environment`).
 *
 * Managed sidepanels/automations must always use a local MCP child. Reusing a
 * user's remote entry would ignore process environment pins and collapse all
 * sessions onto the shared HTTP server. Preserve harmless local options (its
 * timeout, its working folder), but remove remote-only transport fields and a
 * switch that turned it off, and canonicalize command/environment. SynaBun tools are always direct calls;
 * OpenCode 2.1 otherwise hides them behind Code Mode (`execute`). Other servers keep their own settings.
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
    args: _args,
    type: _type,
    enabled: _enabled,
    disabled: _disabled,
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
    codemode: false,
    command: Array.isArray(command) ? [...command] : [command],
    environment,
  };
}

/** Pin only SynaBun on the shared serve, preserving an inherited overlay and the owner's other servers. */
export function buildSharedOpenCodeConfigOverlay(config, content) {
  const overlay = normalizeMcpServers(parseJsonc(content || '{}'));
  const synabun = mcpServersOf(config).SynaBun;
  const inherited = mcpServersOf(overlay).SynaBun;
  if (!synabun && !inherited) return content;
  setMcpServer(overlay, 'SynaBun', { ...synabun, ...inherited, codemode: false });
  return JSON.stringify(overlay);
}
