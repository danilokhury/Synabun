import { acpReadOnlyKind, acpToolPaths } from './tool-call.js';
// ═══════════════════════════════════════════
// SynaBun — Antigravity homes: the Antigravity folder of each Assistant brain and each run
// ═══════════════════════════════════════════
//
// `agy acp --gemini-dir <dir>` reads everything that shapes a session from <dir> instead of
// ~/.gemini: its MCP servers (config/mcp_config.json), its hooks (config/hooks.json), its global
// rules (config/GEMINI.md), extra skill folders (config/skills.json) and its settings
// (antigravity-cli/settings.json: tool permissions, permission rules); its conversations are kept
// there too (antigravity-cli/conversations). The sign-in is not: agy keeps its token in the
// system keychain, which every gemini dir shares, so a SynaBun home never signs in or out.
// Measured on agy 1.4.12 (docs/antigravity-sidepanel.md → Assistant).
//
// So each brain and each run SynaBun starts gets a home of its own, written before agy starts:
//   - exactly the MCP servers the run may use (SynaBun's own entry, then the external servers its
//     tool list names, copied from the user's ~/.gemini/config/mcp_config.json); project MCP config
//     loads separately, so managed starts refuse enabled project servers before starting agy;
//   - one PreToolUse hook (lib/antigravity/policy-hook.mjs) that asks SynaBun about every call
//     before it runs (route gate, browser policy, worker confinement, MCP scope): a refusal reaches
//     the model with its reason and the turn goes on;
//   - settings that ask before writes, commands, MCP and the web (toolPermission request-review) and
//     deny Antigravity's own web reading and browser (read_url, execute_url) outright, plus the
//     user's own sign-in related keys (Gemini API key mode, Google Cloud project, AI credits);
//   - the user's global rules (a copy of ~/.gemini/config/GEMINI.md, SynaBun's block included) and
//     skills (~/.gemini/config/skills through skills.json).
// Plugins of the user's are not loaded (they can bring MCP servers and hooks of their own).
// A home is kept while its brain or run may resume; pruneAntigravityHomes removes the rest.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** The settings keys of the user's own Antigravity settings a SynaBun home keeps: how they sign in and which models they get. */
export const KEPT_USER_SETTINGS = Object.freeze(['modelProvider', 'customModelsConfig', 'gcp', 'useG1Credits']);
/** Antigravity's own web reading and browser: denied in every SynaBun home (the SynaBun browser policy). */
export const SYNABUN_HOME_DENY = Object.freeze(['read_url_content(*)', 'execute_url(*)']);
/** The hook's time limit, in seconds (Antigravity's default is 30). */
export const POLICY_HOOK_TIMEOUT_S = 20;

const HOME_KINDS = new Set(['brain', 'run', 'models']);

/** Where SynaBun's Antigravity homes live: <data home>/runtime/antigravity/homes (outside data/, which is backed up). */
export function antigravityHomesRoot(dataHome) {
  return resolve(String(dataHome || join(homedir(), '.synabun')), 'runtime', 'antigravity', 'homes');
}

/** The home of one brain ('brain', its Assistant session id) or run ('run', its run id): a stable folder name per id. */
export function antigravityHomeDir(root, kind, id) {
  if (!HOME_KINDS.has(kind)) throw new Error(`Unknown Antigravity home kind ${kind}`);
  const raw = String(id || '');
  if (!raw) throw new Error('An Antigravity home needs an id');
  const readable = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 10);
  return join(resolve(root), `${kind}-${readable}-${digest}`);
}

/** The user's own gemini dir (what agy reads without --gemini-dir). */
export function userGeminiDir(home = homedir()) {
  return join(home, '.gemini');
}

function readJson(path) {
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) return {};
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writePrivate(path, text) {
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* a filesystem without modes */ }
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* a filesystem without modes */ }
}

/** The MCP servers of the user's own Antigravity configuration ({ name: entry }), read loosely ({} when there is none). */
export function userAntigravityMcpServers(geminiDir = userGeminiDir()) {
  const config = readJson(join(geminiDir, 'config', 'mcp_config.json'));
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers) ? config.mcpServers : {};
  const out = {};
  for (const [name, entry] of Object.entries(servers)) if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[name] = entry;
  return out;
}

/** The user's own Antigravity settings (~/.gemini/antigravity-cli/settings.json), read loosely ({} when there are none). */
export function userAntigravitySettings(geminiDir = userGeminiDir()) {
  return readJson(join(geminiDir, 'antigravity-cli', 'settings.json'));
}

/**
 * An MCP server definition as mcp_config.json holds it: a remote server `{ serverUrl, headers }`, a local one
 * `{ command, args, env }` (the inventory of lib/mcp-external-servers.js names a remote address `url`).
 */
export function toAntigravityMcpEntry(definition) {
  const source = definition && typeof definition === 'object' ? definition : {};
  const url = typeof source.serverUrl === 'string' && source.serverUrl ? source.serverUrl : (typeof source.url === 'string' ? source.url : '');
  if (url) {
    const entry = { serverUrl: url };
    if (source.headers && typeof source.headers === 'object' && Object.keys(source.headers).length) entry.headers = { ...source.headers };
    return entry;
  }
  const entry = { command: typeof source.command === 'string' ? source.command : '' };
  if (Array.isArray(source.args) && source.args.length) entry.args = source.args.map(String);
  if (source.env && typeof source.env === 'object' && Object.keys(source.env).length) entry.env = { ...source.env };
  if (typeof source.cwd === 'string' && source.cwd) entry.cwd = source.cwd;
  return entry;
}

/**
 * The settings of a SynaBun home: `toolPermission` (request-review asks before writes, commands, MCP and the
 * web; Antigravity's own default), SynaBun's deny rules plus `deny`, and the user's own KEPT_USER_SETTINGS.
 */
export function antigravityHomeSettings({ userSettings = {}, toolPermission = 'request-review', deny = [], allow = [] } = {}) {
  const out = {};
  for (const key of KEPT_USER_SETTINGS) if (userSettings[key] !== undefined) out[key] = userSettings[key];
  out.toolPermission = toolPermission;
  const denyRules = [...new Set([...SYNABUN_HOME_DENY, ...(Array.isArray(deny) ? deny : [])].filter((rule) => typeof rule === 'string' && rule))];
  const allowRules = [...new Set((Array.isArray(allow) ? allow : []).filter((rule) => typeof rule === 'string' && rule))];
  out.permissions = { deny: denyRules, ...(allowRules.length ? { allow: allowRules } : {}) };
  return out;
}

/** The hooks.json of a SynaBun home: one PreToolUse hook for every tool, the command `hookCommand`. */
export function antigravityHomeHooks(hookCommand, { timeoutSec = POLICY_HOOK_TIMEOUT_S } = {}) {
  return { 'synabun-policy': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand, timeout: timeoutSec }] }] } };
}

/** A shell word for the hook command line (sh -c on Unix, cmd /c on Windows): double quotes, inner ones escaped. */
export function shellWord(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** The command line that runs the policy hook: Node, the hook script. */
export function policyHookCommand({ node = process.execPath, script } = {}) {
  if (!script) throw new Error('The policy hook needs its script');
  return `${shellWord(node)} ${shellWord(script)}`;
}

/**
 * Write (or rewrite) a home before agy starts. `mcpServers`: { name: entry } exactly as mcp_config.json holds
 * them; `hookCommand`: the policy hook's command line (null: no hook, which only a test does); `settings`:
 * antigravityHomeSettings(); `userGemini`: the user's gemini dir (rules and skills come from there).
 * → { dir, configDir, appDir }. Conversations already in the home are kept (a resume needs them).
 */
export function prepareAntigravityHome({ dir, mcpServers = {}, hookCommand = null, settings = null, userGemini = userGeminiDir(), rules = true, skills = true } = {}) {
  if (!dir) throw new Error('prepareAntigravityHome needs a dir');
  const configDir = join(dir, 'config');
  const appDir = join(dir, 'antigravity-cli');
  ensurePrivateDir(dir);
  ensurePrivateDir(configDir);
  ensurePrivateDir(appDir);
  writePrivate(join(configDir, 'mcp_config.json'), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  if (hookCommand) writePrivate(join(configDir, 'hooks.json'), `${JSON.stringify(antigravityHomeHooks(hookCommand), null, 2)}\n`);
  else rmSync(join(configDir, 'hooks.json'), { force: true });
  writePrivate(join(appDir, 'settings.json'), `${JSON.stringify(settings || antigravityHomeSettings({ userSettings: userAntigravitySettings(userGemini) }), null, 2)}\n`);
  // The user's global rules (SynaBun's own block included), as they are now.
  const rulesTarget = join(configDir, 'GEMINI.md');
  const rulesSource = join(userGemini, 'config', 'GEMINI.md');
  if (rules && existsSync(rulesSource)) {
    try { writePrivate(rulesTarget, readFileSync(rulesSource, 'utf8')); } catch { rmSync(rulesTarget, { force: true }); }
  } else rmSync(rulesTarget, { force: true });
  // The user's skills folder, read in place (Skills Studio installs Antigravity skills there).
  const skillsTarget = join(configDir, 'skills.json');
  const skillsSource = join(userGemini, 'config', 'skills');
  let hasSkills = false;
  try { hasSkills = skills && statSync(skillsSource).isDirectory(); } catch { hasSkills = false; }
  if (hasSkills) writePrivate(skillsTarget, `${JSON.stringify({ entries: [{ path: resolve(skillsSource) }] }, null, 2)}\n`);
  else rmSync(skillsTarget, { force: true });
  return { dir, configDir, appDir };
}

/** Whether a home holds Antigravity's record of a conversation (a resume needs it). */
export function homeHasConversation(dir, sessionId) {
  const id = String(sessionId || '');
  if (!dir || !/^[A-Za-z0-9_-]{4,128}$/.test(id)) return false;
  return existsSync(join(dir, 'antigravity-cli', 'conversations', `${id}.db`)) || existsSync(join(dir, 'antigravity-cli', 'brain', id));
}

/** Whether Antigravity has listed the tools of an MCP server in a home (it writes one schema file per tool once connected). */
export function homeMcpTools(dir, server) {
  try {
    return readdirSync(join(dir, 'antigravity-cli', 'mcp', String(server)))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5));
  } catch { return []; }
}

/**
 * Remove the homes under `root` nobody needs: older than `maxAgeMs` (by their last change) and not named in
 * `keep` (folder names). Never a folder outside the root or one that is not a home. → the names removed.
 */
export function pruneAntigravityHomes(root, { keep = new Set(), maxAgeMs = 7 * 24 * 60 * 60_000, now = Date.now(), kinds = ['run', 'models'] } = {}) {
  const removed = [];
  let names = [];
  try { names = readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name); } catch { return removed; }
  const keepSet = keep instanceof Set ? keep : new Set(keep || []);
  for (const name of names) {
    const kind = name.split('-')[0];
    if (!kinds.includes(kind) || keepSet.has(name)) continue;
    const path = join(root, name);
    // Its last use: the folder, its MCP list (rewritten at every start) or its conversations, whichever is newest.
    let changed = 0;
    for (const part of ['', join('config', 'mcp_config.json'), join('antigravity-cli', 'conversations')]) {
      try { changed = Math.max(changed, statSync(part ? join(path, part) : path).mtimeMs); } catch { /* not there */ }
    }
    if (!changed || now - changed < maxAgeMs) continue;
    try { rmSync(path, { recursive: true, force: true }); removed.push(name); } catch { /* left for the next pass */ }
  }
  return removed;
}

/** Project MCP processes start before PreToolUse. Refuse them before any managed agent/session starts.
 * Scan ancestors too, so a nested cwd cannot hide a project config. Even a named server could replace the
 * trusted definition with an arbitrary command: managed sessions use only their prepared home definitions.
 */
export function assertSafeAntigravityProject(cwd) {
  for (let dir = resolve(cwd || process.cwd()); ; dir = dirname(dir)) {
    const file = join(dir, '.agents', 'mcp_config.json');
    const unsafe = (reason) => Object.assign(new Error(`Antigravity did not start: ${file} ${reason}. Project MCP processes start before SynaBun's policy. Disable those project servers and use the session's configured MCP servers.`), { code: 'PROJECT_MCP_UNSAFE' });
    let config;
    try {
      if (statSync(file).size > 1024 * 1024) throw unsafe('exceeds the configuration size limit');
      config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '') || '{}');
    } catch (error) {
      if (error.code !== 'ENOENT') throw unsafe('could not be safely read');
    }
    if (config !== undefined) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw unsafe('is not a valid configuration');
      const servers = config.mcpServers;
      if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw unsafe('has an invalid server list');
      if (Object.values(servers || {}).some((entry) => !entry || typeof entry !== 'object' || entry.disabled !== true)) throw unsafe('defines enabled MCP servers');
    }
    if (dirname(dir) === dir) break;
  }
}

/** The only automatic reads in a managed home are MCP tool schemas. Config/settings copy credentials.
 * null for a call outside the home; deny mixed reads so a safe schema cannot mask another file.
 */
export function antigravityHomeReadPolicy(call, { homeDir, cwd } = {}) {
  if (!homeDir || !acpReadOnlyKind(call.kind)) return null;
  const paths = acpToolPaths(call).map((raw) => {
    const path = raw.trim();
    if (path === '~' || path.startsWith('~/')) return resolve(homedir(), path.slice(2));
    if (/^\$\{?HOME\}?(\/|$)/.test(path)) return resolve(homedir(), path.replace(/^\$\{?HOME\}?\/?/, ''));
    return resolve(cwd || process.cwd(), path);
  });
  const inside = (path) => { const rel = relative(resolve(homeDir), path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  if (!paths.some(inside)) return null;
  if (paths.every((path) => inside(path) && /^antigravity-cli[\\/]mcp[\\/][^\\/]+[\\/][^\\/]+\.json$/.test(relative(resolve(homeDir), path)))) return { decision: 'allow' };
  return { decision: 'deny', reason: 'SynaBun refuses reads of its Antigravity home configuration: it can contain MCP credentials and sign-in settings. Only tool schemas may be read here.' };
}
