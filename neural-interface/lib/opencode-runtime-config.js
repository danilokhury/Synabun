import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The browser-policy plugin (assistant-brains/opencode-browser-policy.js) as a file URL a serve can load. */
export const OPENCODE_BROWSER_POLICY_PLUGIN = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'assistant-brains', 'opencode-browser-policy.js')).href;
/** Its OpenCode 2 form: a plugin folder, listed under `plugins` (OpenCode 1 ignores that key). */
export const OPENCODE2_BROWSER_POLICY_PLUGIN = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'assistant-brains', 'opencode2-browser-policy')).href;

/**
 * An Assistant task run's serve config gets SynaBun's browser policy as a
 * plugin (`cwd`: the run's project, for the scripts it reads), for OpenCode 1
 * (`plugin`) and OpenCode 2 (`plugins`). The user's own plugins stay; an
 * earlier entry of ours is replaced. Returns `config`.
 */
export function withOpenCodeBrowserPolicy(config, { cwd = null } = {}) {
  const options = cwd ? { cwd: String(cwd) } : {};
  const plugins = (Array.isArray(config.plugin) ? config.plugin : []).filter((entry) => (Array.isArray(entry) ? entry[0] : entry) !== OPENCODE_BROWSER_POLICY_PLUGIN);
  plugins.push([OPENCODE_BROWSER_POLICY_PLUGIN, options]);
  config.plugin = plugins;
  const plugins2 = (Array.isArray(config.plugins) ? config.plugins : []).filter((entry) => (entry && typeof entry === 'object' ? entry.package : entry) !== OPENCODE2_BROWSER_POLICY_PLUGIN);
  plugins2.push({ package: OPENCODE2_BROWSER_POLICY_PLUGIN, options });
  config.plugins = plugins2;
  return config;
}

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
