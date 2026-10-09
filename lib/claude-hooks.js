import { resolve } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';
import { durableEntry, packagedRuntime } from './packaged-runtime.js';

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

// No shell-specific environment expansion, install paths, or downloads. Walk
// up from the project/cwd for checkout-only installs, then use the installed
// root. Single quotes inside JS work inside the command's double quotes on
// both cmd.exe and POSIX shells. Keep this versioned literal stable.
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

const nodeHookCommand = scriptName => `node -e "${BOOTSTRAP}" ${scriptName}`;

// Whatever entry wrote it: an application that moved must still find, and
// repair, its own handlers.
const PACKAGED_HOOK_COMMAND = new RegExp(`^"(?:[^"\\\\]|\\\\.)+"\\s+${PACKAGED_HOOK_MODE}\\s+(\\S+)$`);

export function hookCommandString(scriptName, _targetProjectPath, runtime = packagedRuntime()) {
  if (!HOOK_SCRIPTS.some(h => h.script === scriptName)) throw new Error('Unknown SynaBun hook');
  const entry = durableEntry(runtime);
  return entry ? `${quoteHookEntry(entry)} ${PACKAGED_HOOK_MODE} ${scriptName}` : nodeHookCommand(scriptName);
}

export function isSynaBunHookCommand(command, scriptName) {
  if (typeof command !== 'string') return false;
  // Both canonical forms, whichever kind of install is reading: moving between
  // an npm install and the application must not leave two handlers behind.
  if (command === nodeHookCommand(scriptName)) return true;
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
 * temporary copy) would leave every handler pointing at nothing.
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

export function ensureHookRoot(settings, targetProjectPath, packageRoot = PACKAGE_ROOT, runtime = packagedRuntime()) {
  // A packaged application's command finds its own handlers, and its package
  // root can be a mount that ends with the run.
  if (runtime) return false;
  // The checked-in template must not acquire a machine-specific env path.
  if (targetProjectPath && resolve(targetProjectPath) === resolve(packageRoot)) return false;
  if (settings.env?.SYNABUN_HOOK_ROOT === resolve(packageRoot)) return false;
  settings.env = { ...settings.env, SYNABUN_HOOK_ROOT: resolve(packageRoot) };
  return true;
}

export function sweepSettingsHooks(settings, targetProjectPath, stats = {}, packageRoot = PACKAGE_ROOT, runtime = packagedRuntime()) {
  if (!settings?.hooks || hookInstallBlocker(runtime)) return false;
  let changed = false;
  let ownsHooks = false;
  for (const def of HOOK_SCRIPTS) {
    const entries = settings.hooks[def.event];
    if (!Array.isArray(entries)) continue;
    const command = hookCommandString(def.script, targetProjectPath, runtime);
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
  if (ownsHooks && ensureHookRoot(settings, targetProjectPath, packageRoot, runtime)) changed = true;
  return changed;
}
