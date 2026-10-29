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
// Every provider holds a drafting worker the way it can (draftConfinementSupport): Claude Code as above, exactly;
// Codex under its sandbox (writes inside the workspace only, no network, no web search, every MCP server of its
// config disabled; it keeps its shell, which the sandbox confines: codexDraftOptions); OpenCode with its shell, web,
// subagent and skill tools switched off, no MCP server, and every edit asked and answered by draftToolDecision
// inside the workspace (openCodeDraftConfig, draftOpenCodeDecision). The dispatcher refuses a provider that cannot
// (assistant-dispatch.js normalizeSpec), never starts a run unconfined and never escalates it onto one that cannot.

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
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

// ── The other providers ──

/** The providers a drafting run can be confined on, in the order the Create page lists them. */
export const DRAFT_CONFINED_PROVIDERS = Object.freeze(['claude-code', 'codex', 'opencode']);

/**
 * What a provider can hold a drafting worker to: { ok: true, level, note } or { ok: false, reason }. `level`:
 * 'strict' (file tools only, every call checked), 'sandbox' (the OS sandbox around a shell), 'rules' (the
 * provider's permission rules plus its tool switches).
 */
export function draftConfinementSupport(provider, { platform = process.platform } = {}) {
  const name = String(provider || '');
  if (name === 'claude-code') return { ok: true, level: 'strict', note: 'Read, Write, Edit, Glob and Grep inside its folder only; no shell, no web, no MCP tools, no subagents.' };
  if (name === 'codex') {
    return {
      ok: true, level: 'sandbox',
      note: `Codex keeps its shell under its ${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Seatbelt' : 'Linux'} sandbox: writes inside its folder only, no network, no web search, no MCP server.`,
    };
  }
  if (name === 'opencode') return { ok: true, level: 'rules', note: 'OpenCode with its shell, web, subagent and skill tools switched off, no MCP server, and every edit answered inside its folder only.' };
  return { ok: false, reason: `${name || 'That provider'} cannot be held to a drafting folder.` };
}

/** The MCP server names a Codex config.toml declares ([mcp_servers.NAME] tables), for disabling them one by one. */
export function codexMcpServerNames(codexHome) {
  const names = new Set();
  try {
    const file = join(String(codexHome || ''), 'config.toml');
    if (!codexHome || !existsSync(file)) return [];
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/.exec(line);
      if (m) names.add(m[1] ?? m[2] ?? m[3]);
    }
  } catch { /* an unreadable config declares nothing we can name; SynaBun's own entry is disabled by name anyway */ }
  return [...names];
}

/**
 * Codex: the thread options and the config overrides of a confined drafting run. The sandbox holds the shell
 * (writable roots: the workspace and Codex's own temp folders; no parent folder, no network); every MCP server the
 * account's config declares, and SynaBun's, is disabled; web search is off.
 */
export function codexDraftOptions(confined, { codexHome = null, projectDir = null } = {}) {
  if (!confined || confined.kind !== DRAFT_CONFINEMENT) throw new Error('Unknown confinement.');
  // The account's config.toml and a project-level .codex/config.toml in the drafting folder (SynaBun makes that folder,
  // so there is none; checked all the same). Servers a Codex plugin brings cannot be named here: Codex loads plugins
  // from its own home, which the sandbox does not reach, and SynaBun installs none for a worker.
  const servers = new Set(['SynaBun', ...codexMcpServerNames(codexHome), ...(projectDir ? codexMcpServerNames(join(String(projectDir), '.codex')) : [])]);
  const mcp_servers = {};
  for (const name of servers) mcp_servers[name] = { enabled: false };
  return {
    thread: { sandboxMode: 'workspace-write', networkAccessEnabled: false, webSearchMode: 'disabled', additionalDirectories: undefined },
    config: { mcp_servers },
  };
}

/**
 * OpenCode's tools a drafting run does without: refused by its rules (OpenCode 2's permission actions). `execute` is
 * Code Mode, whose `opencode` namespace moves the session to another folder (seen live on 2.1.4: a moved session read
 * a file outside the workspace with external_directory denied), creates and removes worktrees and reads MCP
 * resources; `question` would wait for an answer nobody gives.
 */
export const OPENCODE_DRAFT_TOOLS_OFF = Object.freeze(['shell', 'webfetch', 'websearch', 'subagent', 'skill', 'todo', 'lsp', 'external_directory', 'browser', 'execute', 'question']);

/**
 * OpenCode: the config a confined drafting run's serve and session get: OpenCode 2's permission rules (every edit
 * asked, every other tool refused) and no MCP server.
 */
export function openCodeDraftConfig() {
  return {
    permissions: [
      { action: 'edit', resource: '*', effect: 'ask' },
      ...OPENCODE_DRAFT_TOOLS_OFF.map((action) => ({ action, resource: '*', effect: 'deny' })),
    ],
    mcp: 'off',
  };
}

/** An OpenCode permission ask under the draft confinement: null when it may go ahead, else why not. */
export function draftOpenCodeDecision(request, confined) {
  const kind = String(request?.permission || request?.type || '').toLowerCase();
  if (/^(?:edit|write|patch|multiedit|apply_patch)$/.test(kind)) {
    const meta = request?.metadata && typeof request.metadata === 'object' ? request.metadata : {};
    let raw = null;
    for (const key of ['filePath', 'filepath', 'file_path', 'path']) if (typeof meta[key] === 'string' && meta[key]) { raw = meta[key]; break; }
    if (!raw) {
      const pattern = request?.pattern ?? request?.patterns;
      raw = typeof pattern === 'string' ? pattern : Array.isArray(pattern) && typeof pattern[0] === 'string' ? pattern[0] : null;
    }
    return draftToolDecision('Write', { file_path: raw }, confined);
  }
  return `${kind || 'That tool'} is not available. ${REFUSED}`;
}
