// ═══════════════════════════════════════════
// SynaBun — Bypass in the Antigravity side panel: what an auto-approved permission request still meets
// ═══════════════════════════════════════════
//
// Antigravity has no per-session way to skip its approvals: `agy acp --dangerously-skip-permissions` is a flag of
// the whole process (one per panel window, every tab), and an ACP session offers no permission mode or config
// option (agy 1.4.12). So Bypass is the bridge's: a tab in Bypass gets every session/request_permission answered
// at once with the agent's own "allow once" option (never "always", which agy would save in ~/.gemini for later
// sessions), and the request still reaches SynaBun, so these hard rails stay in force:
//
//   browser   lib/browser-tool-policy.js: Antigravity's own web search, URL reading and browser, a shell that starts a
//             browser or browser automation code, another server's browser tools (pages go through SynaBun's browser)
//   protected a path or a command line that reaches one of SynaBun's protected home folders
//             (lib/worker-confinement.js PROTECTED_HOME_DIRS: SynaBun's data home, ~/.claude, ~/.codex, ~/.gemini,
//             ~/.ssh, ~/.aws, …: credentials and the runtimes' own settings)
//
// A call a rail catches is refused (the agent's reject option, else cancelled) and the page is told why. A request
// with no allow-once option is left to the owner's card. Lexical, like the rest of SynaBun's guards: a speed bump
// for an agent, not a sandbox.

import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { browserToolDenial } from '../browser-tool-policy.js';
import { PROTECTED_HOME_DIRS } from '../worker-confinement.js';
import { acpCall, acpPolicyInput, acpToolName, acpToolPaths, acpWebTool } from './tool-call.js';

export const BYPASS_RAILS = Object.freeze(['browser', 'protected']);

function inside(dir, path) {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function placeOf(raw, { cwd, home }) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text === '~' || text.startsWith('~/')) return resolve(home, text.slice(2));
  if (/^\$\{?HOME\}?(\/|$)/.test(text)) return resolve(home, text.replace(/^\$\{?HOME\}?\/?/, ''));
  if (isAbsolute(text)) return resolve(text);
  return cwd ? resolve(cwd, text) : null;
}

/** The protected folder a path or a command line reaches, else null. */
export function protectedTarget(call, { cwd = null, home = homedir() } = {}) {
  const dirs = PROTECTED_HOME_DIRS.map((d) => join(home, d));
  for (const raw of acpToolPaths(call)) {
    const place = placeOf(raw, { cwd, home });
    if (place) for (const dir of dirs) if (inside(dir, place)) return place;
  }
  const command = typeof call.command === 'string' ? call.command
    : typeof call.args?.command === 'string' ? call.args.command
      : Array.isArray(call.args?.command) ? call.args.command.join(' ')
        : typeof call.args?.CommandLine === 'string' ? call.args.CommandLine : '';
  if (command) {
    const words = command.split(/[\s'"`;|&<>()=]+/).filter(Boolean);
    for (const word of words) {
      const place = /^(~|\$\{?HOME\}?)(\/|$)/.test(word) || isAbsolute(word) ? placeOf(word, { cwd, home }) : null;
      if (place) for (const dir of dirs) if (inside(dir, place)) return place;
    }
  }
  return null;
}

/** The rail one permission request meets under Bypass: { rule, reason } or null when it may be approved. */
export function bypassRail(toolCall, { cwd = null, home = homedir(), roots = [] } = {}) {
  let call;
  try { call = acpCall(toolCall && typeof toolCall === 'object' ? toolCall : {}); } catch { return { rule: 'check-failed', reason: 'SynaBun could not read this request, so Bypass did not approve it.' }; }
  try {
    if ((!call.name && !call.title && call.kind === 'other')
        || (call.kind === 'mcp' && !call.mcp)
        || (call.kind === 'execute' && !call.command)
        || (['read', 'search', 'edit', 'delete', 'move'].includes(call.kind) && !acpToolPaths(call).length)) {
      return { rule: 'check-failed', reason: 'SynaBun could not read a complete tool call in this request, so Bypass did not approve it.' };
    }
    // A permission request often names no tool (only a title such as "Run `ls`"): a command is read as one.
    const name = !call.mcp && call.kind === 'execute' && call.command ? 'run_command' : acpToolName(call);
    const input = acpPolicyInput(call);
    const browser = browserToolDenial(acpWebTool(call) && !name.startsWith('mcp__') ? (call.name || 'search_web') : name, input, { host: 'antigravity', cwd, roots });
    if (browser) return { rule: 'browser', reason: browser };
    const place = protectedTarget(call, { cwd, home });
    if (place) return { rule: 'protected', reason: `${place} is inside one of SynaBun's protected folders (credentials and the runtimes' own settings): Bypass never approves it.`, target: place };
    return null;
  } catch (error) {
    return { rule: 'check-failed', reason: `SynaBun could not check this request (${String(error?.message || error).slice(0, 200)}), so Bypass did not approve it.` };
  }
}

/** The option Bypass answers with: the agent's allow-once option, never an "always" one; null when there is none. */
export function allowOnceOption(options) {
  const list = Array.isArray(options) ? options.filter((o) => o && typeof o.optionId === 'string') : [];
  return list.find((o) => o.kind === 'allow_once')
    || list.find((o) => !o.kind && /^allow(?!.*always)/i.test(`${o.optionId} ${o.name || ''}`) && !/always/i.test(`${o.optionId} ${o.name || ''}`))
    || null;
}

/** The option a refusal answers with: reject-once first, else null (then the request is cancelled). */
export function rejectOnceOption(options) {
  const list = Array.isArray(options) ? options.filter((o) => o && typeof o.optionId === 'string') : [];
  return list.find((o) => o.kind === 'reject_once') || null;
}
