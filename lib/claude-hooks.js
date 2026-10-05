import { resolve } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';

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

export function hookCommandString(scriptName) {
  if (!HOOK_SCRIPTS.some(h => h.script === scriptName)) throw new Error('Unknown SynaBun hook');
  return `node -e "${BOOTSTRAP}" ${scriptName}`;
}

export function isSynaBunHookCommand(command, scriptName) {
  if (typeof command !== 'string') return false;
  if (command === hookCommandString(scriptName)) return true;
  // Recognize only the old direct-node path forms, including cross-OS installs.
  const match = command.trim().match(/^node\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*$/);
  if (!match) return false;
  const script = (match[1] || match[2] || match[3]).replace(/\\/g, '/');
  return script === `hooks/claude-code/${scriptName}` || script.endsWith(`/hooks/claude-code/${scriptName}`);
}

export function ensureHookRoot(settings, targetProjectPath, packageRoot = PACKAGE_ROOT) {
  // The checked-in template must not acquire a machine-specific env path.
  if (targetProjectPath && resolve(targetProjectPath) === resolve(packageRoot)) return false;
  if (settings.env?.SYNABUN_HOOK_ROOT === resolve(packageRoot)) return false;
  settings.env = { ...settings.env, SYNABUN_HOOK_ROOT: resolve(packageRoot) };
  return true;
}

export function sweepSettingsHooks(settings, targetProjectPath, stats = {}, packageRoot = PACKAGE_ROOT) {
  if (!settings?.hooks) return false;
  let changed = false;
  let ownsHooks = false;
  for (const def of HOOK_SCRIPTS) {
    const entries = settings.hooks[def.event];
    if (!Array.isArray(entries)) continue;
    const command = hookCommandString(def.script);
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
  if (ownsHooks && ensureHookRoot(settings, targetProjectPath, packageRoot)) changed = true;
  return changed;
}
