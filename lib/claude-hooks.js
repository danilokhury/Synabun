import { accessSync, constants, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';
import { durableEntry, isReadOnlyVolumePath, isTransientPath, packagedRuntime } from './packaged-runtime.js';

// Handler identity must be byte-for-byte identical across settings scopes.
// Claude Code deduplicates matching settings handlers before executing them.
export const HOOK_SCRIPTS = Object.freeze([
  { event: 'SessionStart', script: 'session-start.mjs', timeout: 5 },
  { event: 'UserPromptSubmit', script: 'prompt-submit.mjs', timeout: 3 },
  { event: 'PreCompact', script: 'pre-compact.mjs', timeout: 10 },
  { event: 'Stop', script: 'stop.mjs', timeout: 3 },
  { event: 'PreToolUse', script: 'pre-websearch.mjs', timeout: 3, matcher: '^WebSearch$|^WebFetch$' },
  { event: 'PreToolUse', script: 'pre-task.mjs', timeout: 5, matcher: '^Task$|^Agent$' },
  { event: 'PostToolBatch', script: 'pre-task.mjs', timeout: 3 },
  { event: 'PostToolUse', script: 'post-remember.mjs', timeout: 3, matcher: '^Edit$|^Write$|^NotebookEdit$|Syna[Bb]un_+(remember|reflect|recall)$' },
  { event: 'PostToolUse', script: 'post-plan.mjs', timeout: 15, matcher: '^(Enter|Exit)PlanMode$' },
  { event: 'SubagentStart', script: 'subagent-start.mjs', timeout: 3 },
  { event: 'SubagentStop', script: 'subagent-stop.mjs', timeout: 3 },
].map(Object.freeze));

// The batch-completion handler is an installation dependency of the guards.
// Treat either event as the same group, including direct API callers.
export function hookDefinitionsForEvent(event) {
  if (!event) return HOOK_SCRIPTS;
  const events = ['PreToolUse', 'PostToolBatch'].includes(event)
    ? ['PreToolUse', 'PostToolBatch'] : [event];
  return HOOK_SCRIPTS.filter(def => events.includes(def.event));
}

// No install paths or downloads. Walk up from the project/cwd for checkout-only
// installs, then use the installed root. Single quotes inside JS work inside
// the command's double quotes on both cmd.exe and POSIX shells. Keep this
// versioned literal stable.
const BOOTSTRAP = "const f=require('node:fs'),p=require('node:path'),u=require('node:url'),s=process.argv[1];let r;const ok=d=>{try{return JSON.parse(f.readFileSync(p.join(d,'package.json'),'utf8')).name==='synabun'&&f.existsSync(p.join(d,'hooks','claude-code',s))}catch{return false}};for(let d=p.resolve(process.env.CLAUDE_PROJECT_DIR||process.cwd());;d=p.dirname(d)){if(ok(d)){r=d;break}if(d===p.dirname(d))break}if(!r&&process.env.SYNABUN_HOOK_ROOT&&ok(process.env.SYNABUN_HOOK_ROOT))r=process.env.SYNABUN_HOOK_ROOT;if(!r)throw Error('SynaBun hook root unavailable; repair the hook installation');import(u.pathToFileURL(p.join(r,'hooks','claude-code',s)).href)";

/**
 * A packaged application registers its own entry executable instead: the
 * person has no Node of their own, and an IDE started by itself never sees the
 * application's PATH. `<entry> claude-hook <script>` runs the handler with the
 * Node that came with the application (packaging/runtime/bootstrap.mjs).
 */
export const PACKAGED_HOOK_MODE = 'claude-hook';

// The entry inside the command's double quotes. A POSIX shell still reads
// \ " $ ` there. A Windows path has no quote in it, and forward slashes keep
// it one argument for cmd.exe and Git Bash alike.
function quoteHookEntry(entry) {
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(entry)) return `"${entry.replace(/\\/g, '/')}"`;
  return `"${entry.replace(/[\\"$`]/g, '\\$&')}"`;
}

// Windows: cmd.exe, PowerShell and Git Bash all run this, and a Windows program
// gets the user's PATH from the registry whoever starts it.
const nodeHookCommand = scriptName => `node -e "${BOOTSTRAP}" ${scriptName}`;

/**
 * Where a hook started without the login PATH looks for Node after `node` on
 * PATH: the official installer's and Homebrew's folders and Volta's shim (the
 * Node a terminal finds, as a rule), then SYNABUN_NODE. The same names on every
 * machine.
 */
export const HOOK_NODE_FOLDERS = Object.freeze(['/usr/local/bin/node', '/opt/homebrew/bin/node', '$HOME/.volta/bin/node']);

// macOS and Linux: Claude Code runs a settings hook with /bin/sh in its own
// environment. Started from a terminal that has the login PATH; started from
// the Dock, Finder, a desktop app or launchd it is /usr/bin:/bin:/usr/sbin:/sbin,
// where `node` is not found and every hook exits 127. So: `node` on PATH, as a
// terminal finds it, then the usual folders, then the Node the installer named
// in the user's settings (SYNABUN_NODE: nvm and the like have no usual folder).
// Nothing in it names this machine, so the tracked template and the projects'
// settings carry it as they are.
const POSIX_NODE_FINDER = `n=$(command -v node) || for n in ${HOOK_NODE_FOLDERS.map(p => (p.startsWith('$') ? `"${p}"` : p)).join(' ')} "$SYNABUN_NODE"; do [ -f "$n" ] && [ -x "$n" ] && break; n=node; done; `;
const posixHookCommand = scriptName => `${POSIX_NODE_FINDER}exec "$n" -e "${BOOTSTRAP}" ${scriptName}`;

// Whatever entry wrote it: an application that moved must still find, and
// repair, its own handlers.
const PACKAGED_HOOK_COMMAND = new RegExp(`^"(?:[^"\\\\]|\\\\.)+"\\s+${PACKAGED_HOOK_MODE}\\s+(\\S+)$`);

export function hookCommandString(scriptName, _targetProjectPath, runtime = packagedRuntime(), platform = process.platform) {
  if (!HOOK_SCRIPTS.some(h => h.script === scriptName)) throw new Error('Unknown SynaBun hook');
  const entry = durableEntry(runtime);
  if (entry) return `${quoteHookEntry(entry)} ${PACKAGED_HOOK_MODE} ${scriptName}`;
  return platform === 'win32' ? nodeHookCommand(scriptName) : posixHookCommand(scriptName);
}

export function isSynaBunHookCommand(command, scriptName) {
  if (typeof command !== 'string') return false;
  // Every canonical form, whichever kind of install and system is reading:
  // moving between an npm install and the application, or a settings file
  // shared between Windows and macOS, must not leave two handlers behind.
  if (command === nodeHookCommand(scriptName) || command === posixHookCommand(scriptName)) return true;
  // Any version of the POSIX finder in front of the same bootstrap.
  if (command.startsWith('n=$(command -v node)') && command.endsWith(` -e "${BOOTSTRAP}" ${scriptName}`)) return true;
  const packaged = command.trim().match(PACKAGED_HOOK_COMMAND);
  if (packaged) return packaged[1] === scriptName;
  // Recognize only the old direct-node path forms, including cross-OS installs.
  const match = command.trim().match(/^node\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*$/);
  if (!match) return false;
  const script = (match[1] || match[2] || match[3]).replace(/\\/g, '/');
  return script === `hooks/claude-code/${scriptName}` || script.endsWith(`/hooks/claude-code/${scriptName}`);
}

/**
 * Why this run must not write hook commands, or null when it may. A packaged
 * application with no path that outlives the run (macOS started it from a
 * temporary copy, or from the disk image it came in) would leave every handler
 * pointing at nothing.
 */
export function hookInstallBlocker(runtime = packagedRuntime()) {
  if (!runtime || durableEntry(runtime)) return null;
  return 'SynaBun is running from a temporary location, so its hooks would stop working when it closes. Move SynaBun to its permanent place (Applications on macOS), open it again, then turn the hooks on.';
}

/**
 * What a request to enable hooks may do in this run: 'write' them, 'refuse'
 * it, or 'register-only'. Adding a project is more than its hooks, so a run
 * that cannot write them still registers a new project; a request that asks
 * for nothing but hooks (all of them globally, one event, or a project that
 * is already registered) is refused with the blocker's sentence.
 */
export function hookInstallPlan({ target, registered = false, hook } = {}, runtime = packagedRuntime()) {
  if (!hookInstallBlocker(runtime)) return 'write';
  return target === 'project' && !registered && !hook ? 'register-only' : 'refuse';
}

/**
 * The Node a hook falls back to when Claude Code was started without the login
 * PATH (SYNABUN_NODE): the one running SynaBun, which is known to run its hooks,
 * when its path outlives this run. null on Windows (its programs get the user's
 * PATH) and for a Node in a temporary place.
 */
export function hookNodePin({ execPath = process.execPath, platform = process.platform, env = process.env, writable } = {}) {
  if (platform === 'win32' || typeof execPath !== 'string' || !isAbsolute(execPath)) return null;
  if (isTransientPath(execPath, env) || isReadOnlyVolumePath(execPath, { platform, writable })) return null;
  const temporary = [tmpdir(), '/tmp', '/private/tmp', '/private/var/folders', '/var/folders'];
  if (temporary.some(dir => resolve(execPath).startsWith(`${resolve(dir)}${sep}`))) return null;
  return execPath;
}

export function ensureHookRoot(settings, targetProjectPath, packageRoot = PACKAGE_ROOT, runtime = packagedRuntime(), { node = hookNodePin() } = {}) {
  // A packaged application's command finds its own handlers, and its package
  // root can be a mount that ends with the run.
  if (runtime) return false;
  // The checked-in template must not acquire a machine-specific env path.
  if (targetProjectPath && resolve(targetProjectPath) === resolve(packageRoot)) return false;
  let changed = false;
  if (settings.env?.SYNABUN_HOOK_ROOT !== resolve(packageRoot)) {
    settings.env = { ...settings.env, SYNABUN_HOOK_ROOT: resolve(packageRoot) };
    changed = true;
  }
  // The user's own settings only (this machine's file): every session gets its env.
  if (!targetProjectPath && node && settings.env?.SYNABUN_NODE !== node) {
    settings.env = { ...settings.env, SYNABUN_NODE: node };
    changed = true;
  }
  return changed;
}

export function sweepSettingsHooks(settings, targetProjectPath, stats = {}, packageRoot = PACKAGE_ROOT, runtime = packagedRuntime(), { platform = process.platform, node = hookNodePin({ platform }) } = {}) {
  if (!settings?.hooks || hookInstallBlocker(runtime)) return false;
  let changed = false;
  let ownsHooks = false;
  for (const def of HOOK_SCRIPTS) {
    const entries = settings.hooks[def.event];
    if (!Array.isArray(entries)) continue;
    const command = hookCommandString(def.script, targetProjectPath, runtime, platform);
    const matches = entries.flatMap(e => (e.hooks || []).filter(h => isSynaBunHookCommand(h.command, def.script)).map(h => ({ entry: e, hook: h })));
    if (!matches.length) continue;
    ownsHooks = true;
    const canonical = matches.find(({ hook }) => hook.command === command);
    const matcherOk = canonical && (canonical.entry.matcher || '') === (def.matcher || '');
    if (matches.length === 1 && matcherOk && canonical.hook.timeout === def.timeout && canonical.hook.type === 'command') continue;
    stats.removed = (stats.removed || 0) + matches.length - 1;
    if (!canonical) stats.repaired = (stats.repaired || 0) + 1;
    else if (!matcherOk) stats.matchers = (stats.matchers || 0) + 1;
    const rest = entries.flatMap(entry => {
      const hooks = (entry.hooks || []).filter(h => !isSynaBunHookCommand(h.command, def.script));
      return hooks.length ? [{ ...entry, hooks }] : [];
    });
    settings.hooks[def.event] = [...rest, { matcher: def.matcher || '', hooks: [{ type: 'command', command, timeout: def.timeout }] }];
    changed = true;
  }
  if (ownsHooks && ensureHookRoot(settings, targetProjectPath, packageRoot, runtime, { node })) changed = true;
  return changed;
}

// ── What is really installed (Settings → Automations → Claude Code hooks) ────

/**
 * What one settings file holds of SynaBun's handlers. `handlers`: one per
 * HOOK_SCRIPTS entry, with `copies` (SynaBun handlers for that script in any
 * form) and `current` (one of them is this machine's command, matcher and
 * timeout); `events`: every handler of the event present; `installed` /
 * `current` / `total` count handlers, `duplicates` the extra copies (each runs).
 */
export function hookInstallState(settings, { targetProjectPath, runtime = packagedRuntime(), platform = process.platform } = {}) {
  const handlers = HOOK_SCRIPTS.map((def) => {
    const entries = Array.isArray(settings?.hooks?.[def.event]) ? settings.hooks[def.event] : [];
    const owned = entries.flatMap(entry => (Array.isArray(entry?.hooks) ? entry.hooks : [])
      .filter(hook => isSynaBunHookCommand(hook?.command, def.script)).map(hook => ({ entry, hook })));
    const command = hookCommandString(def.script, targetProjectPath, runtime, platform);
    const current = owned.some(({ entry, hook }) => hook.command === command && (entry.matcher || '') === (def.matcher || '') && hook.timeout === def.timeout);
    return { event: def.event, script: def.script, copies: owned.length, current };
  });
  const events = {};
  for (const h of handlers) events[h.event] = (events[h.event] ?? true) && h.copies > 0;
  return {
    handlers,
    events,
    installed: handlers.filter(h => h.copies > 0).length,
    current: handlers.filter(h => h.current).length,
    duplicates: handlers.reduce((sum, h) => sum + Math.max(0, h.copies - 1), 0),
    total: handlers.length,
  };
}

/** The commands of SynaBun's handlers in a settings file, script by script (to compare two scopes). */
export function hookCommandsOf(settings) {
  const out = {};
  for (const def of HOOK_SCRIPTS) {
    const entries = Array.isArray(settings?.hooks?.[def.event]) ? settings.hooks[def.event] : [];
    const commands = entries.flatMap(entry => (Array.isArray(entry?.hooks) ? entry.hooks : []))
      .map(hook => hook?.command).filter(command => isSynaBunHookCommand(command, def.script));
    out[`${def.event}:${def.script}`] = [...new Set(commands)].sort();
  }
  return out;
}

/**
 * Whether a project's SynaBun handlers run once next to the user's: Claude Code
 * runs one copy of identical handlers from both files, and both of different
 * ones. 'same' (nothing of SynaBun's there, or the same commands), 'different'.
 */
export function projectHooksAgree(userSettings, projectSettings) {
  const user = hookCommandsOf(userSettings);
  const project = hookCommandsOf(projectSettings);
  for (const [key, commands] of Object.entries(project)) {
    if (!commands.length) continue;
    const mine = user[key] || [];
    if (!mine.length) continue; // only the project runs it: once
    if (commands.some(command => !mine.includes(command))) return 'different';
  }
  return 'same';
}

/** Claude Code's own switches that stop SynaBun's handlers, in one settings file: the first that applies, or null. */
export function hooksSwitchedOff(settings, { managed = false } = {}) {
  if (!settings || typeof settings !== 'object') return null;
  if (settings.disableAllHooks === true) return 'disableAllHooks';
  // Only managed settings can keep user and project hooks from running.
  if (managed && settings.allowManagedHooksOnly === true) return 'allowManagedHooksOnly';
  return null;
}

/** Where Claude Code reads managed (organization) settings on this system. */
export function managedClaudeSettingsPath(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

/** The PATH macOS gives a program it starts from the Dock, Finder or launchd. */
export const LAUNCHD_PATH = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

function runnableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * The Node a SynaBun hook would run with in a Claude Code started without the
 * login PATH (the Dock, Finder, a desktop app, launchd): what the POSIX command
 * tries after PATH, in its order. { path, via: 'SYNABUN_NODE' | 'folder' } or
 * null (such a session would fail every hook). Windows: not asked (null).
 */
export function hookNodeWithoutPath({ env = {}, home = homedir(), platform = process.platform, runnable = runnableFile } = {}) {
  if (platform === 'win32') return null;
  // `command -v node` on the PATH such a launch has (a Linux distribution's own Node).
  for (const dir of LAUNCHD_PATH) if (runnable(`${dir}/node`)) return { path: `${dir}/node`, via: 'PATH' };
  for (const folder of HOOK_NODE_FOLDERS) {
    const path = folder.startsWith('$HOME/') ? join(home, folder.slice('$HOME/'.length)) : folder;
    if (runnable(path)) return { path, via: 'folder' };
  }
  const pinned = typeof env.SYNABUN_NODE === 'string' ? env.SYNABUN_NODE : '';
  if (pinned && runnable(pinned)) return { path: pinned, via: 'SYNABUN_NODE' };
  return null;
}
