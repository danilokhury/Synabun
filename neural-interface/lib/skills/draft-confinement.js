// ── The skill-drafting worker's confinement (P3 review) ──
// A creation (lib/skills/creation.js) drafts a skill with ONE Claude Code worker of the Assistant's dispatcher. That
// worker reads sources that may be hostile (a web page, a transcript, someone else's skill), so what it can do is
// enforced, not asked for: lib/native-loop-providers.js gives a confined run only the tools below (`tools`), no MCP
// server at all (`strictMcpConfig`), no user or project settings (no user hooks, no allow rules), and checks every
// tool call with draftToolDecision() twice: in a PreToolUse hook, which Claude Code runs before any permission mode,
// and in canUseTool.
//
//   Read, Glob, Grep   inside the creation's workspace (its sources/ and what it wrote)
//   Write, Edit        inside the workspace's out/ folder only
//   anything else      refused: no shell, no web, no subagents, no MCP tools, no notebooks, no skills
//
// A path is checked as Claude Code would open it (relative to the workspace when not absolute), then at its real
// location (lib/path-confine.js realPathOf: links resolved, a dangling link refused), so neither a link nor ".." leads
// out; a ".." segment is refused outright. Glob and Grep patterns are relative and never climb. A file that is written
// must be a plain file with one name (no hard link to somewhere else). Anything that cannot be checked is refused.
// Only Claude Code runs confined: Codex runs MCP servers outside its sandbox and OpenCode answers its own permission
// prompts, so the dispatcher refuses a confined run on either (assistant-dispatch.js normalizeSpec).

import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isInside, realPathOf } from '../path-confine.js';

export const DRAFT_CONFINEMENT = 'skill-draft';
/** The writable folder under the workspace (creation-brief.js OUT_DIR). */
export const DRAFT_WRITABLE = 'out';
/** The only built-in tools a drafting worker has. */
export const DRAFT_TOOLS = Object.freeze(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
/** Removed as well, by name (belt and braces: `tools` already leaves them out, and a hook refuses whatever is not above). */
export const DRAFT_DISALLOWED_TOOLS = Object.freeze([
  'Bash', 'BashOutput', 'KillShell', 'KillBash', 'Monitor', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TaskStop', 'NotebookEdit',
  'NotebookRead', 'Skill', 'SlashCommand', 'TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'ListMcpResources',
  'ReadMcpResource', 'Workflow', 'CronCreate', 'ScheduleWakeup', 'RemoteTrigger', 'EnterWorktree', 'ExitWorktree', 'Artifact',
]);
const READERS = new Set(['Read', 'Glob', 'Grep']);
const WRITERS = new Set(['Write', 'Edit']);
const REFUSED = 'A skill-drafting run has only Read, Write, Edit, Glob and Grep, inside its own folder: no shell, no web, no MCP tools and no subagents.';

/**
 * A confinement as a run carries it, checked: { kind, root (the workspace's real path), writable (its out/) }.
 * Throws when it cannot be used (the run must not start unconfined).
 * @param {{ kind?: string }|null} confinement
 * @param {string} cwd the run's working directory (the creation's workspace)
 */
export function resolveDraftConfinement(confinement, cwd) {
  if (!confinement || confinement.kind !== DRAFT_CONFINEMENT) throw new Error('Unknown confinement.');
  const root = realpathSync(String(cwd || ''));
  const writableReal = realpathSync(join(root, DRAFT_WRITABLE));
  if (writableReal !== join(root, DRAFT_WRITABLE) || !lstatSync(writableReal).isDirectory()) throw new Error(`The workspace's ${DRAFT_WRITABLE}/ folder is not a plain folder.`);
  return { kind: DRAFT_CONFINEMENT, root, writable: writableReal };
}

/** A path the worker names, where it really is, or null when it cannot be one of the workspace's. */
function placeOf(raw, root) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('~')) return null;
  if (raw.split(/[\\/]+/).includes('..')) return null;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  try { return realPathOf(abs); } catch { return null; }
}

/** A Glob / Grep pattern: relative, no "..", no home. */
function patternProblem(p) {
  if (p === undefined || p === null) return null;
  if (typeof p !== 'string' || p.length > 1000 || /[\u0000-\u001f\u007f]/.test(p)) return 'is not a plain pattern';
  if (p.startsWith('/') || p.startsWith('\\') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return 'is absolute: patterns are relative to the drafting folder';
  if (p.split(/[\\/]+/).includes('..')) return 'climbs out with "..": patterns stay inside the drafting folder';
  return null;
}

/**
 * Whether a drafting worker may make this tool call: null when it may, else why not (the worker reads the reason).
 * @param {string} toolName
 * @param {object} input the tool's input
 * @param {{ root: string, writable: string }} confinement resolveDraftConfinement()'s answer
 */
export function draftToolDecision(toolName, input, confinement) {
  try {
    const name = String(toolName || '');
    const args = input && typeof input === 'object' ? input : {};
    const { root, writable } = confinement || {};
    if (!root || !writable) return 'This run\'s drafting folder is not known: nothing can be done.';
    if (!READERS.has(name) && !WRITERS.has(name)) return `${name || 'That tool'} is not available. ${REFUSED}`;
    if (name === 'Read') {
      const at = placeOf(args.file_path, root);
      if (!at || !isInside(root, at)) return `Read is limited to the drafting folder (${root}). ${REFUSED}`;
      return null;
    }
    if (name === 'Glob' || name === 'Grep') {
      if (args.path !== undefined && args.path !== null && args.path !== '') {
        const at = placeOf(args.path, root);
        if (!at || !isInside(root, at, { allowRoot: true })) return `${name} searches the drafting folder only (${root}).`;
      }
      const bad = name === 'Glob' ? patternProblem(args.pattern) : patternProblem(args.glob);
      if (name === 'Glob' && (typeof args.pattern !== 'string' || !args.pattern)) return 'Glob needs a pattern.';
      if (bad) return `The ${name === 'Glob' ? 'pattern' : 'glob'} ${bad}.`;
      return null;
    }
    // Write, Edit: a plain file under out/.
    const at = placeOf(args.file_path, root);
    if (!at || !isInside(writable, at)) return `${name} writes inside ${writable} only: the draft goes in ${DRAFT_WRITABLE}/<name>/. ${REFUSED}`;
    let st = null;
    try { st = lstatSync(at); } catch { st = null; }
    if (st && (!st.isFile() || st.nlink > 1)) return `${at} is not a plain file of the draft: it cannot be written.`;
    return null;
  } catch (err) {
    return `The call could not be checked (${err?.message || err}), so it is refused.`;
  }
}

/** The PreToolUse hook a confined run gets (no matcher: every tool call, subagents' included). */
export function draftPreToolUseHook(confinement) {
  return async (input) => {
    const reason = draftToolDecision(input?.tool_name, input?.tool_input || {}, confinement);
    return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
  };
}
