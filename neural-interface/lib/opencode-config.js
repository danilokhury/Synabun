// ─────────────────────────────────────────────────────────────────────────────
// OpenCode 2's configuration, as SynaBun reads and writes it.
//
// OpenCode 2 reads its global configuration from `opencode.json` and
// `opencode.jsonc` in its configuration folder (OPENCODE_CONFIG_DIR when set,
// else $XDG_CONFIG_HOME/opencode, else ~/.config/opencode), the .jsonc after
// the .json, and never reads `config.json` (OpenCode 1's legacy file, which
// older SynaBun releases wrote). It still accepts OpenCode 1's field shapes in
// those files and converts them as it reads them; SynaBun writes OpenCode 2's
// shapes only:
//   mcp.servers.<name>   { type: 'local', command: [...], environment, disabled }
//                        or { type: 'remote', url, headers, disabled }
//   permissions          [{ action, resource, effect: 'allow'|'ask'|'deny' }],
//                        the last matching rule deciding; OpenCode 1's
//                        `permission` object (read first) is converted here the
//                        way OpenCode converts it (bash → shell, task → subagent)
//   agents.<name>        { system, description, mode, hidden, model, steps, permissions }
//   plugins              [package | { package, options }]
//   providers.<id>       { name, package, settings: { baseURL }, models }
//   compaction           { auto, buffer, keep: { tokens } }
//   snapshots            boolean
// SynaBun writes `opencode.json` and never the .jsonc (its comments are the
// user's): OpenCode merges both, so an entry of SynaBun's in opencode.json is
// in effect unless the user's .jsonc overrides it.
//
// Pure, apart from the read and write helpers at the end that take a path.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json';
/** The global documents OpenCode 2 reads, lowest precedence first. */
export const OPENCODE_CONFIG_FILES = Object.freeze(['opencode.json', 'opencode.jsonc']);
/** The one SynaBun writes. */
export const OPENCODE_CONFIG_FILE = 'opencode.json';

/**
 * Permission actions of OpenCode 2's own tools (its edit, write and patch tools all ask `edit`), in the order
 * Settings → OpenCode lists them. MCP tools are actions too, named `<server>_<tool>`.
 */
export const OPENCODE_TOOL_ACTIONS = Object.freeze([
  'read', 'edit', 'shell', 'glob', 'grep', 'list', 'lsp', 'webfetch', 'websearch',
  'subagent', 'skill', 'question', 'external_directory', 'browser', 'doom_loop',
]);
/** What OpenCode 2 decides for an action no rule names (its default agent: everything allowed, its browser denied). */
export const OPENCODE_DEFAULT_EFFECTS = Object.freeze({ browser: 'deny' });
export const PERMISSION_EFFECTS = Object.freeze(['allow', 'ask', 'deny']);

/** OpenCode 1 names of permission actions OpenCode 2 renamed. */
const RENAMED_ACTIONS = Object.freeze({ bash: 'shell', task: 'subagent' });

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const asObject = (value) => (isObject(value) ? value : {});

/** OpenCode's configuration folder: OPENCODE_CONFIG_DIR, else $XDG_CONFIG_HOME/opencode, else ~/.config/opencode. */
export function opencodeConfigDir({ env = process.env, home = os.homedir() } = {}) {
  if (env.OPENCODE_CONFIG_DIR) return resolve(String(env.OPENCODE_CONFIG_DIR));
  if (env.XDG_CONFIG_HOME) return join(String(env.XDG_CONFIG_HOME), 'opencode');
  return join(home, '.config', 'opencode');
}

/** The file SynaBun writes in a configuration folder. */
export function opencodeConfigFilePath(dir) {
  return join(dir, OPENCODE_CONFIG_FILE);
}

// ── JSONC ────────────────────────────────────────────────────────────────────

/**
 * The value of a JSON-with-comments text (`//` and block comments, trailing commas), as OpenCode reads its
 * .jsonc. Throws a SyntaxError on text that is not JSON once comments and trailing commas are gone.
 */
export function parseJsonc(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('Unterminated comment');
      i = end + 2;
      continue;
    }
    if (ch === ',') {
      // A comma followed (after blanks and comments) by a closing bracket is a trailing comma.
      let j = i + 1;
      for (;;) {
        while (j < s.length && /\s/.test(s[j])) j++;
        if (s[j] === '/' && s[j + 1] === '/') { while (j < s.length && s[j] !== '\n') j++; continue; }
        if (s[j] === '/' && s[j + 1] === '*') { const end = s.indexOf('*/', j + 2); if (end < 0) break; j = end + 2; continue; }
        break;
      }
      if (s[j] === '}' || s[j] === ']') { i++; continue; }
    }
    out += ch;
    i++;
  }
  return out.trim() ? JSON.parse(out) : {};
}

// ── MCP servers ──────────────────────────────────────────────────────────────

// A remote server's OAuth client as OpenCode 2 names it (seen on 2.1.4: it keeps these and drops any other name,
// `clientId` and `callbackPort` included), from the names SynaBun's MCP registry and Claude Code use.
const OAUTH_NAMES = { clientId: 'client_id', clientSecret: 'client_secret', scope: 'scope', callbackPort: 'callback_port', redirectUri: 'redirect_uri' };
const OAUTH_KEPT = new Set(Object.values(OAUTH_NAMES));

/** `false` (no OAuth), the OAuth client in OpenCode 2's names, or undefined (nothing to say: OpenCode's own default). */
function opencodeOauth(oauth) {
  if (oauth === false) return false;
  if (!isObject(oauth)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(oauth)) {
    const name = OAUTH_NAMES[key] || (OAUTH_KEPT.has(key) ? key : null);
    if (name && value !== undefined && value !== null && value !== '') out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * An MCP server as OpenCode 2 takes it (`mcp.servers.<name>`), from what SynaBun describes as
 * `{ command, args, env }` / `{ url, headers, oauth }`, or from an entry of either major (`enabled: false` →
 * `disabled`). Every word of a command goes through as it is: an argument may be empty or carry spaces on purpose.
 */
export function opencodeMcpServerEntry(input = {}) {
  const source = asObject(input);
  const disabled = source.disabled === true || source.enabled === false;
  const timeout = isObject(source.timeout)
    ? { ...source.timeout }
    : (Number(source.timeout) > 0 ? { startup: Number(source.timeout), catalog: Number(source.timeout), execution: Number(source.timeout) } : null);
  // Options OpenCode 2 takes on either kind of server, as they are.
  const shared = {
    ...(typeof source.codemode === 'boolean' ? { codemode: source.codemode } : {}),
    ...(source.protocol !== undefined && source.protocol !== null ? { protocol: source.protocol } : {}),
    ...(timeout ? { timeout } : {}),
    ...(disabled ? { disabled: true } : {}),
  };
  if (source.type === 'remote' || (typeof source.url === 'string' && source.url && source.type !== 'local')) {
    const oauth = opencodeOauth(source.oauth);
    return {
      type: 'remote',
      url: String(source.url || ''),
      ...(isObject(source.headers) && Object.keys(source.headers).length ? { headers: { ...source.headers } } : {}),
      ...(oauth !== undefined ? { oauth } : {}),
      ...shared,
    };
  }
  const head = Array.isArray(source.command) ? source.command : (source.command != null ? [source.command] : []);
  const command = [...head, ...(Array.isArray(source.args) ? source.args : [])].filter((part) => typeof part === 'string');
  const environment = isObject(source.environment) ? source.environment : (isObject(source.env) ? source.env : null);
  return {
    type: 'local',
    command,
    ...(environment && Object.keys(environment).length ? { environment: { ...environment } } : {}),
    ...(typeof source.cwd === 'string' && source.cwd ? { cwd: source.cwd } : {}),
    ...shared,
  };
}

/** The MCP servers a config names, OpenCode 1 entries (`mcp.<name>`) as OpenCode 2 reads them: `{ name: entry }`. */
export function mcpServersOf(config) {
  const mcp = asObject(asObject(config).mcp);
  const out = {};
  for (const [name, entry] of Object.entries(mcp)) {
    if (name === 'servers' || name === 'timeout' || !isObject(entry)) continue;
    Object.defineProperty(out, name, { value: opencodeMcpServerEntry(entry), enumerable: true, configurable: true, writable: true });
  }
  for (const [name, entry] of Object.entries(asObject(mcp.servers))) if (isObject(entry)) Object.defineProperty(out, name, { value: { ...entry }, enumerable: true, configurable: true, writable: true });
  return out;
}

/** `config` with MCP server `name` set to `entry` (an OpenCode 1 entry of that name taken out). Mutates and returns it. */
export function setMcpServer(config, name, entry) {
  const mcp = asObject(config.mcp);
  delete mcp[name];
  mcp.servers = { ...asObject(mcp.servers), [name]: opencodeMcpServerEntry(entry) };
  config.mcp = mcp;
  return config;
}

/** `config` without MCP server `name`, in either shape; empty containers go. Mutates and returns it. */
export function removeMcpServer(config, name) {
  if (!isObject(config.mcp)) return config;
  delete config.mcp[name];
  if (isObject(config.mcp.servers)) {
    delete config.mcp.servers[name];
    if (!Object.keys(config.mcp.servers).length) delete config.mcp.servers;
  }
  if (!Object.keys(config.mcp).length) delete config.mcp;
  return config;
}

/**
 * Every MCP server of `config` moved into `mcp.servers` (OpenCode 1 entries converted), so SynaBun's own entries
 * and the user's live in one shape before SynaBun changes any. Mutates and returns it.
 */
export function normalizeMcpServers(config) {
  if (!isObject(config.mcp)) return config;
  const servers = mcpServersOf(config);
  const timeout = config.mcp.timeout;
  config.mcp = { ...(isObject(timeout) ? { timeout } : {}), ...(Object.keys(servers).length ? { servers } : {}) };
  if (!Object.keys(config.mcp).length) delete config.mcp;
  return config;
}

// ── Permission rules ─────────────────────────────────────────────────────────

/** The OpenCode 2 name of a permission action (OpenCode 1's bash → shell, task → subagent). */
export function opencodeAction(name) {
  const key = String(name ?? '');
  return RENAMED_ACTIONS[key] || key;
}

/** One permission rule. */
export function permissionRule(action, effect, resource = '*') {
  return { action: opencodeAction(action), resource: String(resource), effect };
}

/** OpenCode 1's `permission` object as OpenCode 2's rules, the way OpenCode converts it. */
export function rulesFromPermissionObject(permission) {
  if (typeof permission === 'string') return PERMISSION_EFFECTS.includes(permission) ? [permissionRule('*', permission)] : [];
  const rules = [];
  for (const [action, value] of Object.entries(asObject(permission))) {
    if (typeof value === 'string') {
      if (PERMISSION_EFFECTS.includes(value)) rules.push(permissionRule(action, value));
    } else if (isObject(value)) {
      for (const [resource, effect] of Object.entries(value)) {
        if (PERMISSION_EFFECTS.includes(effect)) rules.push(permissionRule(action, effect, resource));
      }
    }
  }
  return rules;
}

/** Every rule of a config, in the order OpenCode applies them: OpenCode 1's object first, then `permissions`. */
export function permissionRulesOf(config) {
  const source = asObject(config);
  const v2 = Array.isArray(source.permissions)
    ? source.permissions.filter((rule) => isObject(rule) && typeof rule.action === 'string' && PERMISSION_EFFECTS.includes(rule.effect))
      .map((rule) => ({ action: rule.action, resource: typeof rule.resource === 'string' ? rule.resource : '*', effect: rule.effect }))
    : [];
  return [...rulesFromPermissionObject(source.permission), ...v2];
}

function wildcardMatch(pattern, value) {
  const text = String(pattern ?? '');
  if (text === '*') return true;
  const re = new RegExp(`^${text.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(String(value ?? ''));
}

/**
 * The effect the last rule matching `action` on `resource` gives ('allow' | 'ask' | 'deny'), or null when no rule
 * names it. `exact` counts only rules naming the action itself (not a wildcard).
 */
export function effectFor(rules, action, { resource = '*', exact = false } = {}) {
  const wanted = opencodeAction(action);
  let effect = null;
  for (const rule of Array.isArray(rules) ? rules : []) {
    const named = exact ? rule.action === wanted : wildcardMatch(rule.action, wanted);
    if (named && (rule.resource === '*' || wildcardMatch(rule.resource, resource))) effect = rule.effect;
  }
  return effect;
}

/** What a config decides for each of OpenCode's own tool actions, for resource `*` (its defaults where no rule says). */
export function toolEffectsOf(config) {
  const rules = permissionRulesOf(config);
  const out = {};
  for (const action of OPENCODE_TOOL_ACTIONS) out[action] = effectFor(rules, action) || OPENCODE_DEFAULT_EFFECTS[action] || 'allow';
  return out;
}

/**
 * `config` with an `allow` rule for each of `actions` that has no rule of its own (an explicit deny or ask of the
 * user's stays the user's). Mutates and returns it.
 */
export function allowActions(config, actions) {
  const rules = permissionRulesOf(config);
  const list = Array.isArray(config.permissions) ? config.permissions : [];
  for (const action of actions || []) {
    if (effectFor(rules, action, { exact: true }) == null) list.push(permissionRule(action, 'allow'));
  }
  if (list.length) config.permissions = list;
  return config;
}

/**
 * `config` with exactly one rule deciding `action` for every resource: `effect`. Earlier `*` rules of that action
 * go (OpenCode 1's string value too); rules for particular resources stay. Mutates and returns it.
 */
export function setActionEffect(config, action, effect) {
  if (!PERMISSION_EFFECTS.includes(effect)) throw new Error(`Unknown permission effect: ${effect}`);
  const wanted = opencodeAction(action);
  if (isObject(config.permission)) {
    for (const [key, value] of Object.entries(config.permission)) {
      if (opencodeAction(key) === wanted && typeof value === 'string') delete config.permission[key];
    }
    if (!Object.keys(config.permission).length) delete config.permission;
  }
  const list = (Array.isArray(config.permissions) ? config.permissions : []).filter((rule) => !(isObject(rule) && rule.action === wanted && (rule.resource ?? '*') === '*'));
  list.push(permissionRule(wanted, effect));
  config.permissions = list;
  return config;
}

/** `config` with `rules` appended to its `permissions` (each converted to OpenCode 2's action names). Mutates and returns it. */
export function appendRules(config, rules) {
  const list = Array.isArray(config.permissions) ? config.permissions : [];
  for (const rule of rules || []) if (isObject(rule) && PERMISSION_EFFECTS.includes(rule.effect)) list.push(permissionRule(rule.action, rule.effect, rule.resource ?? '*'));
  if (list.length) config.permissions = list;
  return config;
}

// ── Agents ───────────────────────────────────────────────────────────────────

/** An agent as OpenCode 2 takes it, from an entry of either major (`prompt` → `system`, `permission` → rules). */
export function opencodeAgentEntry(input = {}) {
  const source = asObject(input);
  const { prompt, permission, permissions, tools: _tools, ...rest } = source;
  const out = { ...rest };
  if (typeof prompt === 'string' && out.system === undefined) out.system = prompt;
  const rules = [...rulesFromPermissionObject(permission), ...(Array.isArray(permissions) ? permissions.filter(isObject) : [])];
  if (rules.length) out.permissions = rules;
  return out;
}

/** Agent `name` of a config in OpenCode 2's shape (an OpenCode 1 `agent.<name>` converted), or `{}`. */
export function agentOf(config, name) {
  const v1 = asObject(asObject(config).agent)[name];
  const v2 = asObject(asObject(config).agents)[name];
  if (!isObject(v1) && !isObject(v2)) return {};
  const converted = opencodeAgentEntry(v1 || {});
  const own = opencodeAgentEntry(v2 || {});
  const permissions = [...(converted.permissions || []), ...(own.permissions || [])];
  return { ...converted, ...own, ...(permissions.length ? { permissions } : {}) };
}

/** `config` with agent `name` set to `agent` (an OpenCode 1 `agent.<name>` taken out). Mutates and returns it. */
export function setAgent(config, name, agent) {
  if (isObject(config.agent)) {
    delete config.agent[name];
    if (!Object.keys(config.agent).length) delete config.agent;
  }
  config.agents = { ...asObject(config.agents), [name]: opencodeAgentEntry(agent) };
  return config;
}

// ── Plugins ──────────────────────────────────────────────────────────────────

const pluginPackage = (entry) => (isObject(entry) ? entry.package : Array.isArray(entry) ? entry[0] : entry);

/** `config` with plugin `pkg` (a file URL or package name) listed once, with `options`. Mutates and returns it. */
export function withPlugin(config, pkg, options = {}) {
  const list = (Array.isArray(config.plugins) ? config.plugins : []).filter((entry) => pluginPackage(entry) !== pkg);
  list.push({ package: pkg, options: { ...asObject(options) } });
  config.plugins = list;
  return config;
}

/** `config` without plugin `pkg`, in either list. Mutates and returns it. */
export function withoutPlugin(config, pkg) {
  for (const key of ['plugins', 'plugin']) {
    if (!Array.isArray(config[key])) continue;
    config[key] = config[key].filter((entry) => pluginPackage(entry) !== pkg);
    if (!config[key].length) delete config[key];
  }
  return config;
}

// ── Providers, compaction, snapshots ─────────────────────────────────────────

/** Provider `id` of a config, either shape (`provider.<id>` or `providers.<id>`), or null. */
export function providerOf(config, id) {
  const source = asObject(config);
  const v2 = asObject(source.providers)[id];
  if (isObject(v2)) return v2;
  const v1 = asObject(source.provider)[id];
  return isObject(v1) ? v1 : null;
}

/**
 * Whether a document keeps providers other than `id` in OpenCode 1's `provider` section. OpenCode 2 reads one
 * provider section per document: its own `providers` replaces OpenCode 1's whole when both are there, so an entry
 * of SynaBun's in `providers` would hide every one of those.
 */
export function hasOpencode1Providers(config, id = null) {
  return Object.keys(asObject(asObject(config).provider)).some((key) => key !== id);
}

/**
 * `config` with provider `id` set to `entry` (OpenCode 2's shape; an OpenCode 1 entry of that id taken out).
 * Throws (code OPENCODE1_PROVIDERS) when the document keeps other providers in OpenCode 1's section: they are
 * moved to `providers` first (as OpenCode converted them: GET /api/config), never dropped.
 */
export function setProvider(config, id, entry) {
  if (hasOpencode1Providers(config, id)) {
    throw Object.assign(new Error('This OpenCode configuration keeps its providers in OpenCode 1\'s "provider" section, which a "providers" section would hide.'), { code: 'OPENCODE1_PROVIDERS' });
  }
  removeProvider(config, id);
  config.providers = { ...asObject(config.providers), [id]: { ...asObject(entry) } };
  return config;
}

/** `config` without provider `id`, in either shape. Mutates and returns it. */
export function removeProvider(config, id) {
  for (const key of ['provider', 'providers']) {
    if (!isObject(config[key])) continue;
    delete config[key][id];
    if (!Object.keys(config[key]).length) delete config[key];
  }
  return config;
}

/**
 * A request timeout (ms) for provider `id` of a config written for one of SynaBun's serves, unless the provider
 * sets one: `providers.<id>.settings.timeout`. A document that keeps its providers in OpenCode 1's section is left
 * as it is (a `providers` section would hide them: hasOpencode1Providers). Mutates and returns it.
 */
export function withProviderTimeout(config, id, timeoutMs) {
  if (!id || isObject(config.provider)) return config;
  const existing = asObject(asObject(config.providers)[id]);
  const settings = { ...asObject(existing.settings) };
  if (settings.timeout == null) settings.timeout = timeoutMs;
  config.providers = { ...asObject(config.providers), [id]: { ...existing, settings } };
  return config;
}

/** `{ auto, buffer }` of a config's compaction (OpenCode 1's `reserved` read as `buffer`); null where unset. */
export function compactionOf(config) {
  const compaction = asObject(asObject(config).compaction);
  return {
    auto: typeof compaction.auto === 'boolean' ? compaction.auto : null,
    buffer: Number.isFinite(compaction.buffer) ? compaction.buffer : (Number.isFinite(compaction.reserved) ? compaction.reserved : null),
  };
}

/**
 * `config` with its compaction set (`auto`, `buffer`) in OpenCode 2's shape (OpenCode 1's `prune`, `reserved`
 * gone). A `buffer` of null takes it out: OpenCode's own default applies again.
 */
export function setCompaction(config, { auto, buffer } = {}) {
  const current = asObject(config.compaction);
  const { prune: _prune, reserved, ...rest } = current;
  const next = { ...rest };
  if (rest.buffer === undefined && Number.isFinite(reserved)) next.buffer = reserved;
  if (typeof auto === 'boolean') next.auto = auto;
  if (buffer === null) delete next.buffer;
  else if (buffer !== undefined) {
    const value = Math.round(Number(buffer));
    if (!Number.isFinite(value) || value < 0) throw new Error('The compaction buffer must be a whole number of tokens, 0 or more.');
    next.buffer = value;
  }
  config.compaction = next;
  return config;
}

/** Whether a config keeps snapshots (OpenCode 1's `snapshot` read too); null where unset. */
export function snapshotsOf(config) {
  const source = asObject(config);
  if (typeof source.snapshots === 'boolean') return source.snapshots;
  if (typeof source.snapshot === 'boolean') return source.snapshot;
  return null;
}

/** `config` with `snapshots` set (OpenCode 1's `snapshot` gone). Mutates and returns it. */
export function setSnapshots(config, enabled) {
  delete config.snapshot;
  config.snapshots = enabled === true;
  return config;
}

// ── Files ────────────────────────────────────────────────────────────────────

/**
 * One configuration document: `{ path, exists, config, error }`. A .jsonc is read with its comments; a file that is
 * not JSON is `{ config: null, error }`, never thrown.
 */
export function readOpencodeConfigDocument(path) {
  if (!existsSync(path)) return { path, exists: false, config: {}, error: null };
  try {
    const text = readFileSync(path, 'utf8');
    const value = path.endsWith('.jsonc') ? parseJsonc(text) : (text.trim() ? JSON.parse(text.replace(/^﻿/, '')) : {});
    if (!isObject(value)) return { path, exists: true, config: null, error: 'it does not hold a JSON object' };
    return { path, exists: true, config: value, error: null };
  } catch (error) {
    return { path, exists: true, config: null, error: error?.message || String(error) };
  }
}

/** The global documents of a configuration folder, lowest precedence first. */
export function readOpencodeConfigDocuments(dir) {
  return OPENCODE_CONFIG_FILES.map((name) => readOpencodeConfigDocument(join(dir, name)));
}

/**
 * Read `opencode.json` of `dir`, change it with `mutate(config)` and write it back (a new file when there is none),
 * whole, through a temporary file and a rename. A file that is not JSON is never overwritten: throws instead.
 * Resolves the path written.
 */
export function updateOpencodeConfigFile(dir, mutate) {
  const path = opencodeConfigFilePath(dir);
  const doc = readOpencodeConfigDocument(path);
  if (doc.error) throw new Error(`${path} could not be read (${doc.error}); SynaBun did not change it.`);
  const config = doc.exists ? doc.config : { $schema: OPENCODE_CONFIG_SCHEMA };
  const next = mutate(config) || config;
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.synabun-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
  return path;
}

/**
 * The user's global configuration as one object, for a serve of SynaBun's own whose configuration folder is
 * another (XDG_CONFIG_HOME set to it): opencode.json, then opencode.jsonc over it (top-level keys replaced; `mcp`
 * servers, agents, providers and permission rules merged the way OpenCode merges them). A document that cannot be
 * read is left out.
 */
export function mergedOpencodeConfig(documents) {
  const merged = {};
  for (const doc of documents || []) {
    const config = doc?.config;
    if (!isObject(config)) continue;
    for (const [key, value] of Object.entries(config)) {
      if (key === 'permission' || key === 'permissions') continue;
      if (key === 'mcp' && isObject(value)) {
        const servers = { ...mcpServersOf(merged), ...mcpServersOf(config) };
        merged.mcp = { ...(isObject(value.timeout) ? { timeout: value.timeout } : (isObject(merged.mcp?.timeout) ? { timeout: merged.mcp.timeout } : {})), ...(Object.keys(servers).length ? { servers } : {}) };
      } else if ((key === 'agents' || key === 'agent' || key === 'providers' || key === 'provider') && isObject(value)) {
        merged[key] = { ...asObject(merged[key]), ...value };
      } else if ((key === 'plugins' || key === 'plugin' || key === 'instructions') && Array.isArray(value)) {
        merged[key] = [...(Array.isArray(merged[key]) ? merged[key] : []), ...value];
      } else {
        merged[key] = value;
      }
    }
    // A document's rules in OpenCode's order (its OpenCode 1 object first), after the earlier document's.
    const rules = permissionRulesOf(config);
    if (rules.length) merged.permissions = [...(Array.isArray(merged.permissions) ? merged.permissions : []), ...rules];
  }
  return merged;
}
