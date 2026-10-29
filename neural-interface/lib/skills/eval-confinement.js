// ── The confinement of a skill-evaluation run (P4) ──
// An evaluation (lib/skills/evals.js) runs untrusted skill text with real models: a skill under test can tell the
// model anything. So every run of an evaluation is held to its own job folder, the way a drafting run is
// (lib/skills/draft-confinement.js), by what each provider can enforce, and it never sees SynaBun's MCP server, the
// owner's skills or the owner's runtime folders: the skill under test is copied into the run's own folder, in the
// project skill folder its runtime reads (EVAL_SKILL_ROOTS), and nothing is ever installed for a test.
//
//   role      what it does                                     its tools (Claude Code names)
//   trial     the case's request, with or without the skill    Read, Glob, Grep in its folder; Write, Edit in its folder
//                                                              but never in a skill folder (.claude, .agents, .opencode);
//                                                              Skill; Bash only when `shell` (the case asks for one AND
//                                                              the run is under the OS sandbox: server.js wraps it)
//   grader    grades one answer against its assertions       Read, Glob, Grep in its folder; its JSON answer
//   judge     compares two answers blind                     the same
//   proposer  proposes a description (the optimiser)         the same
//
// Claude Code: `tools` is exactly the list above, no MCP server (strictMcpConfig), no settings file at all
// (settingSources []: no project, user or local settings, no CLAUDE.md), hooks and a skill's inline shell switched off
// in the flag settings (disableAllHooks, disableSkillShellExecution: a skill's own frontmatter hooks and `!` commands
// never run; SynaBun's SDK hooks still do), the skill under test loaded as the one local plugin `workspace` from the
// run's .claude folder (`skills` names it, so nothing else is in its catalog; a baseline loads none), and every call
// checked twice (a PreToolUse hook Claude Code runs before any permission mode, and canUseTool). Codex: its sandbox
// (workspace-write in the folder for a trial, read-only otherwise), no network, no web search, every MCP server
// disabled; it keeps its shell, which its sandbox holds to writes in the folder but not to reads: Codex is the owner's
// opt-in per skill version (lib/skills/evals.js). OpenCode: no project configuration (OPENCODE_DISABLE_PROJECT_CONFIG:
// no opencode.json, no .opencode plugin, agent, command or tool of the folder, no AGENTS.md at its top), no formatter
// and no snapshot (OPENCODE_EVAL_SETTINGS), the skill under test copied into the run's own configuration folder
// (placeOpenCodeEvalSkill), Code Mode, web, subagents, todo, LSP and question tools off, the shell off unless `shell`,
// the skill tool on for a trial only, no MCP server, reads outside the folder denied, and every edit asked and answered
// inside the folder (evalOpenCodeDecision). Every run gets git's safety settings (evalGitSafetyEnv). A shell, where a
// case asks, runs under the evaluation's own macOS sandbox (lib/skills/eval-sandbox.js). A run whose confinement
// cannot be set up never starts (CONFINEMENT_UNSUPPORTED), and it is never escalated to another provider.

import { constants as fsConstants, copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isInside, realPathOf } from '../path-confine.js';
import { DRAFT_DISALLOWED_TOOLS, codexMcpServerNames } from './draft-confinement.js';
import { evalConfigPathProblem } from '../../public/shared/skills/ss-evals.js';

export const EVAL_CONFINEMENT = 'skill-eval';
/** Part of every run's experiment identity: a change to what an evaluation run may do is a new version. */
export const EVAL_CONFINEMENT_VERSION = 'skill-eval/5';
export const EVAL_ROLES = Object.freeze(['trial', 'grader', 'judge', 'proposer']);
/** Where a trial's copy of the skill goes in its folder: the project skill folder each runtime reads. */
export const EVAL_SKILL_ROOTS = Object.freeze({ 'claude-code': '.claude/skills', codex: '.agents/skills', opencode: '.opencode/skills' });
/** The skill folders of a trial (SynaBun writes them; no tool does: a skill folder written mid-run would change what the
 *  runtime sees). Every other folder or file a runtime reads its settings or code from is refused the same way
 *  (ss-evals.js evalConfigPathProblem); an instruction file (CLAUDE.md, AGENTS.md) is a file a trial may write. */
export const EVAL_PROTECTED_DIRS = Object.freeze(['.claude', '.agents', '.opencode', '.codex']);
/** The local plugin a Claude Code trial loads the skill under test from (its catalog names it workspace:<skill>). */
export const EVAL_CLAUDE_PLUGIN = 'workspace';
/** Claude Code's flag settings for every evaluation run: no hook of any settings file, plugin or skill, no inline shell. */
export const EVAL_CLAUDE_SETTINGS = Object.freeze({ disableAllHooks: true, disableSkillShellExecution: true });

/**
 * git's settings for every evaluation run's process tree (the runtime and what it starts outside the evaluation's
 * shell sandbox: Claude Code's and OpenCode's own git calls, Codex and its shell). The job folder never holds a
 * repository: no `.git` is copied there (ss-evals.js), written there by a tool (evalToolDecision) or by a shell step
 * (lib/skills/eval-sandbox.js, whose git keeps its repository outside the folder). On top of that, git here never looks
 * above the job folder for one (GIT_CEILING_DIRECTORIES), never takes a folder as a bare repository it was not pointed
 * at (a HEAD, objects/ and refs/ left in the folder: safe.bareRepository), reads no system and no global configuration
 * (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null: no ~/.gitconfig or $XDG_CONFIG_HOME/git/config, wherever HOME and
 * XDG_CONFIG_HOME point), and runs no fsmonitor program and no hook (command-line scope: what a repository's own
 * configuration cannot override). So no configuration a run could have written is read by the runtime's git.
 */
export function evalGitSafetyEnv(root) {
  return {
    // withServeEnv clears the prefix first, then installs only these deliberate settings. A list of known names
    // misses alternate object/index paths and command-line config (including future GIT_* variables).
    'GIT_*': null,
    GIT_CEILING_DIRECTORIES: dirname(String(root)),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'safe.bareRepository', GIT_CONFIG_VALUE_0: 'explicit',
    GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/dev/null',
  };
}
export const EVAL_TRIAL_TOOLS = Object.freeze(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill']);
export const EVAL_READER_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'StructuredOutput']);
const READERS = new Set(['Read', 'Glob', 'Grep']);
const WRITERS = new Set(['Write', 'Edit']);
const REFUSED = 'An evaluation run works only inside its own folder: no web, no MCP tools, no subagents.';

/** The providers an evaluation can run on, in the order the Test tab lists them. */
export const EVAL_CONFINED_PROVIDERS = Object.freeze(['claude-code', 'codex', 'opencode']);

/**
 * What a provider can hold an evaluation run to: { ok, level, note, shell } or { ok: false, reason }. `shell`:
 * 'sandbox' (a shell only under the OS sandbox: macOS, Protect workers = Enforce), 'own-sandbox' (Codex's own, always
 * on), 'never'.
 */
export function evalConfinementSupport(provider, { platform = process.platform } = {}) {
  const name = String(provider || '');
  if (name === 'claude-code') return { ok: true, level: 'strict', shell: platform === 'darwin' ? 'sandbox' : 'never', optIn: false, note: 'Read, Write, Edit, Glob, Grep and Skill inside its folder; no settings file, hook or plugin but the skill under test; a shell only under the evaluation\'s macOS sandbox (no network, no home folder); no web, no MCP tools, no subagents.' };
  if (name === 'codex') return { ok: true, level: 'sandbox', shell: 'own-sandbox', optIn: true, note: `Codex keeps its shell under its ${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Seatbelt' : 'Linux'} sandbox: writes inside its folder only, no network, no web search, no MCP server; its shell can read files anywhere on this computer, and what it reads can reach its model provider.` };
  if (name === 'opencode') return { ok: true, level: 'rules', shell: platform === 'darwin' ? 'sandbox' : 'never', optIn: false, note: 'OpenCode with no project configuration or plugin of the folder, its web, subagent and todo tools off, no MCP server, reads and edits inside its folder only; a shell only under the evaluation\'s macOS sandbox (no network, no home folder).' };
  return { ok: false, reason: `${name || 'That provider'} cannot be held to an evaluation folder.` };
}

/**
 * A confinement as a run carries it, checked: { kind, role, shell, root (the folder's real path), protected (the
 * skill folders' places), skill (the name under test, or null) }. Throws when it cannot be used: the run must not
 * start unconfined.
 */
export function resolveEvalConfinement(confinement, cwd) {
  if (!confinement || confinement.kind !== EVAL_CONFINEMENT) throw new Error('Unknown confinement.');
  const role = EVAL_ROLES.includes(confinement.role) ? confinement.role : null;
  if (!role) throw new Error('Unknown evaluation role.');
  const root = realpathSync(String(cwd || ''));
  if (!lstatSync(root).isDirectory()) throw new Error('The evaluation folder is not a folder.');
  const skill = typeof confinement.skill === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(confinement.skill) ? confinement.skill : null;
  return { kind: EVAL_CONFINEMENT, role, shell: role === 'trial' && confinement.shell === true, root, trialDir: dirname(root), protected: EVAL_PROTECTED_DIRS.map((d) => join(root, d)), skill };
}

function placeOf(raw, root) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('~')) return null;
  if (raw.split(/[\\/]+/).includes('..')) return null;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  try { return realPathOf(abs); } catch { return null; }
}
function patternProblem(p) {
  if (p === undefined || p === null) return null;
  if (typeof p !== 'string' || p.length > 1000 || /[\u0000-\u001f\u007f]/.test(p)) return 'is not a plain pattern';
  if (p.startsWith('/') || p.startsWith('\\') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return 'is absolute: patterns are relative to the evaluation folder';
  if (p.split(/[\\/]+/).includes('..')) return 'climbs out with "..": patterns stay inside the evaluation folder';
  return null;
}
const inProtected = (confined, at) => confined.protected.some((dir) => at === dir || isInside(dir, at));
/** Why a place of the folder holds a runtime's settings or code (a skill folder, .git, opencode.json, …), or null. */
function configPlace(confined, at) {
  if (inProtected(confined, at)) return 'a skill folder (.claude, .agents, .opencode, .codex): the skill under test stays as it is';
  const rel = relative(confined.root, at).split(sep).join('/');
  const why = rel ? evalConfigPathProblem(rel) : null;
  return why ? `${why.name}, which ${why.who || 'a runtime'} reads as its own settings or code` : null;
}

/**
 * Whether an evaluation run may make this tool call: null when it may, else why not (the model reads the reason).
 * @param {string} toolName @param {object} input @param {object} confined resolveEvalConfinement()'s answer
 */
export function evalToolDecision(toolName, input, confined) {
  try {
    const name = String(toolName || '');
    const args = input && typeof input === 'object' ? input : {};
    const { root, role } = confined || {};
    if (!root || !role) return 'This run\'s evaluation folder is not known: nothing can be done.';
    if (name === 'StructuredOutput' && role !== 'trial') return null;   // the answer itself (an output schema), no file access
    const trial = role === 'trial';
    if (trial && name === 'Skill') return null;   // the catalog is the run's own folder: only the skill under test is in it
    if (trial && name === 'Bash') return confined.shell ? null : `Bash is not available in this evaluation (the case does not ask for a shell, or no OS sandbox holds one). ${REFUSED}`;
    if (!READERS.has(name) && !(trial && WRITERS.has(name))) return `${name || 'That tool'} is not available. ${REFUSED}`;
    if (name === 'Read') {
      const at = placeOf(args.file_path, root);
      if (!at || !isInside(root, at)) return `Read is limited to this run's folder (${root}). ${REFUSED}`;
      return null;
    }
    if (name === 'Glob' || name === 'Grep') {
      if (args.path !== undefined && args.path !== null && args.path !== '') {
        const at = placeOf(args.path, root);
        if (!at || !isInside(root, at, { allowRoot: true })) return `${name} searches this run's folder only (${root}).`;
      }
      if (name === 'Glob' && (typeof args.pattern !== 'string' || !args.pattern)) return 'Glob needs a pattern.';
      const bad = name === 'Glob' ? patternProblem(args.pattern) : patternProblem(args.glob);
      if (bad) return `The ${name === 'Glob' ? 'pattern' : 'glob'} ${bad}.`;
      return null;
    }
    // Write, Edit (trials only): a plain file inside the folder, never in a skill folder.
    const at = placeOf(args.file_path, root);
    if (!at || !isInside(root, at)) return `${name} writes inside this run's folder only (${root}). ${REFUSED}`;
    const place = configPlace(confined, at);
    if (place) return `${name} cannot write into ${place}.`;
    let st = null;
    try { st = lstatSync(at); } catch { st = null; }
    if (st && (!st.isFile() || st.nlink > 1)) return `${at} is not a plain file of this run: it cannot be written.`;
    return null;
  } catch (err) {
    return `The call could not be checked (${err?.message || err}), so it is refused.`;
  }
}

/** The PreToolUse hook an evaluation run gets (no matcher: every call). */
export function evalPreToolUseHook(confined) {
  return async (input) => {
    const reason = evalToolDecision(input?.tool_name, input?.tool_input || {}, confined);
    return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
  };
}

/**
 * Claude Code's options for an evaluation run: the tools, what is removed by name, no settings file of any source,
 * the flag settings that switch hooks and inline shell off, the one plugin (a trial with the skill: the run's .claude
 * folder, where SynaBun copied the skill and wrote the plugin's manifest; anything else: none), the skills it may use
 * (that one, as workspace:<skill>; a baseline and the helpers: none) and git's safety settings for its environment.
 */
export function evalClaudeOptions(confined) {
  const trial = confined.role === 'trial';
  const tools = trial ? [...EVAL_TRIAL_TOOLS, ...(confined.shell ? ['Bash'] : [])] : [...EVAL_READER_TOOLS];
  const disallowed = DRAFT_DISALLOWED_TOOLS.filter((t) => !tools.includes(t));
  const withSkill = trial && !!confined.skill;
  return {
    tools, disallowedTools: disallowed, settingSources: [], settings: { ...EVAL_CLAUDE_SETTINGS },
    plugins: withSkill ? [{ type: 'local', path: join(confined.root, '.claude') }] : [],
    skills: withSkill ? [`${EVAL_CLAUDE_PLUGIN}:${confined.skill}`] : [],
    env: evalGitSafetyEnv(confined.root),
  };
}

/** The manifest of a trial's Claude Code plugin (<root>/.claude/.claude-plugin/plugin.json): its name, nothing else. */
export function evalClaudePluginManifest() {
  return `${JSON.stringify({ name: EVAL_CLAUDE_PLUGIN, version: '1.0.0', description: 'The skill under test (a SynaBun evaluation).' }, null, 2)}\n`;
}

/**
 * Codex: the thread options and the config overrides of an evaluation run. A trial writes in its folder (the
 * sandbox's writable root, no parent folder); the others read only. No network, no web search, every MCP server the
 * account's config declares (and SynaBun's) disabled.
 */
export function codexEvalOptions(confined, { codexHome = null, projectDir = null } = {}) {
  if (!confined || confined.kind !== EVAL_CONFINEMENT) throw new Error('Unknown confinement.');
  const servers = new Set(['SynaBun', ...codexMcpServerNames(codexHome), ...(projectDir ? codexMcpServerNames(join(String(projectDir), '.codex')) : [])]);
  const mcp_servers = {};
  for (const name of servers) mcp_servers[name] = { enabled: false };
  return {
    thread: { sandboxMode: confined.role === 'trial' ? 'workspace-write' : 'read-only', networkAccessEnabled: false, webSearchMode: 'disabled', additionalDirectories: undefined },
    config: { mcp_servers },
  };
}

/**
 * OpenCode's tools an evaluation run does without: refused by its rules (OpenCode 2's permission actions; a tool
 * denied everywhere leaves the model's tool list). `execute` is Code Mode, which reaches the `opencode` namespace
 * (session_move to another folder, worktree_create / worktree_remove, MCP resources) and the browser; `question`
 * would wait for an answer nobody gives. What is left is Claude Code's list: read, write, edit, glob, grep, skill
 * (and the shell when the case asks for it).
 */
export const OPENCODE_EVAL_TOOLS_OFF = Object.freeze(['webfetch', 'websearch', 'subagent', 'todo', 'lsp', 'external_directory', 'browser', 'execute', 'question']);

/**
 * OpenCode settings every evaluation serve reads last of its configuration files (OPENCODE_CONFIG, after the run's own
 * configuration, which starts from the owner's): no formatter (OpenCode 2 runs one after an edit, outside any sandbox,
 * when a configuration turns them on, and prettier or biome would then load the folder's prettier.config.js or
 * biome.json: a test file would run as code) and no snapshot (OpenCode 2 snapshots a git project's files with git).
 */
export const OPENCODE_EVAL_SETTINGS = Object.freeze({ formatter: false, snapshots: false });
/** Where an evaluation serve's last configuration file goes: the trial's own folder, beside the job folder (no tool or
 *  shell step of the run writes there). */
export const OPENCODE_EVAL_CONFIG_FILE = 'opencode-eval.json';

/**
 * OpenCode: the environment of an evaluation run's serve. No project configuration of the folder at all (no
 * opencode.json, no .opencode plugin, agent, command, tool or skill, no .agents skill, no AGENTS.md at the top:
 * OPENCODE_DISABLE_PROJECT_CONFIG), nothing of Claude Code's (OPENCODE_DISABLE_CLAUDE_CODE), no file watcher (nothing is
 * loaded again mid-run), OPENCODE_EVAL_SETTINGS (written here, as OPENCODE_CONFIG), git's safety settings. An inherited
 * OPENCODE_CONFIG_DIR is removed (null), not merely left unset: OpenCode 2 reads that folder in place of its global one
 * (config.directory, before XDG), so a SynaBun launched from a shell that exports it would lose the run's own
 * configuration (its providers, rules and the skill under test placed in it; seen live on 2.1.4: "Model unavailable"
 * for a provider the configuration defines). Every inherited GIT_* variable is removed before evalGitSafetyEnv's
 * deliberate settings are applied, so none points the runtime's git around them. The skill under test goes into the
 * run's configuration folder (placeOpenCodeEvalSkill). OpenCode's OPENCODE_CONFIG_CONTENT stays server.js's (the
 * runtime overlay of every isolated serve).
 */
export function openCodeEvalEnv(confined) {
  const file = join(confined.trialDir || dirname(confined.root), OPENCODE_EVAL_CONFIG_FILE);
  rmSync(file, { force: true });
  writeFileSync(file, `${JSON.stringify(OPENCODE_EVAL_SETTINGS)}\n`, { flag: 'wx', mode: 0o600 });
  return {
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_FILEWATCHER: '1',
    OPENCODE_CONFIG: file,
    // An inherited OPENCODE_CONFIG_DIR takes the place of the run's own configuration folder (OpenCode 2 reads
    // config.directory = process.env.OPENCODE_CONFIG_DIR, before XDG): removed, or SynaBun launched from a shell that
    // set it would lose this run's isolated config (and the skill under test placed in it). A value of null tells
    // server.js ensureIsolatedServe (withServeEnv) to delete the variable.
    OPENCODE_CONFIG_DIR: null,
    ...evalGitSafetyEnv(confined.root),
  };
}

/** The most a skill copy may hold (lib/skills/evals.js wrote it from a library revision, which is bounded already). */
const OPENCODE_SKILL_COPY_LIMITS = Object.freeze({ entries: 2000, bytes: 64 * 1024 * 1024 });

/**
 * OpenCode: a trial's copy of the skill under test placed in the run's own configuration folder (`configDir`, the
 * folder server.js writes the run's configuration into and removes with its serve; OpenCode reads skills/<name>
 * there as a global skill). Copied from the trial's .opencode/skills/<name>, which lib/skills/evals.js wrote and checked
 * before the run, without following a link: regular files and folders only, bounded. → the folder, or null for a run
 * without the skill (a baseline, a grader). Throws when the copy cannot be placed: a trial without its skill tests
 * nothing, so it must not start.
 */
export function placeOpenCodeEvalSkill(confined, configDir) {
  if (!confined || confined.kind !== EVAL_CONFINEMENT) throw new Error('Unknown confinement.');
  if (confined.role !== 'trial' || !confined.skill) return null;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(confined.skill))) throw new Error('The skill under test has no usable name.');
  if (typeof configDir !== 'string' || !isAbsolute(configDir)) throw new Error('The run has no configuration folder.');
  const from = join(confined.root, EVAL_SKILL_ROOTS.opencode, confined.skill);
  const to = join(configDir, 'skills', confined.skill);
  const top = lstatSync(from, { throwIfNoEntry: false });
  if (!top || !top.isDirectory()) throw new Error(`The trial has no copy of the skill (${EVAL_SKILL_ROOTS.opencode}/${confined.skill}).`);
  rmSync(to, { recursive: true, force: true });
  let entries = 0;
  let bytes = 0;
  const copy = (src, dest) => {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(src)) {
      if (++entries > OPENCODE_SKILL_COPY_LIMITS.entries) throw new Error('The skill copy holds too many files.');
      const s = join(src, name);
      const st = lstatSync(s);
      if (st.isDirectory()) copy(s, join(dest, name));
      else if (st.isFile()) {
        bytes += st.size;
        if (bytes > OPENCODE_SKILL_COPY_LIMITS.bytes) throw new Error('The skill copy is too large.');
        copyFileSync(s, join(dest, name), fsConstants.COPYFILE_EXCL);
      } else throw new Error(`The skill copy holds something that is not a file or a folder (${relative(from, s)}).`);
    }
  };
  copy(from, to);
  return to;
}

/**
 * OpenCode: the config an evaluation run's serve and session get: OpenCode 2's permission rules (a trial's edits
 * and shell asked, its skill allowed; a grader's refused) and no MCP server.
 */
export function openCodeEvalConfig(confined) {
  const trial = confined?.role === 'trial';
  const shell = !!confined?.shell;
  const rule = (action, effect) => ({ action, resource: '*', effect });
  return {
    permissions: [
      // read / grep / glob are asked, not allowed: OpenCode 2's FileAccess.resolve checks only that a path is
      // syntactically inside the folder. The adapter answers each ask by evalOpenCodeDecision, which resolves the real
      // path and refuses one that leaves the folder. On its own that is check-then-open (TOCTOU): a shell step could
      // swap a job-folder symlink between the ask and the read tool's open, which runs in the runtime's own process,
      // not under the shell's sandbox — so the ask cannot bind the path finally opened. What closes it is that no
      // symlink can exist in the job folder to swap: the eval shell's Seatbelt profile denies symlink creation in every
      // writable place (lib/skills/eval-sandbox.js), SynaBun's skill copy follows none, Write/Edit make plain files
      // only, and the folder starts empty — the shell is the sole possible symlink writer. With the race surface gone
      // this realpath check is sound (and stays as defense in depth). (A denied tool would leave the model's list;
      // 'ask' keeps it.)
      rule('read', 'ask'),
      rule('grep', 'ask'),
      rule('glob', 'ask'),
      rule('edit', trial ? 'ask' : 'deny'),
      rule('shell', shell ? 'ask' : 'deny'),
      rule('skill', trial ? 'allow' : 'deny'),
      ...OPENCODE_EVAL_TOOLS_OFF.map((action) => rule(action, 'deny')),
    ],
    mcp: 'off',
  };
}

/** The path a read / grep / glob ask names: its resource (read: the file; the search root otherwise) or metadata. */
function evalReadPathOf(request, kind) {
  const meta = request?.metadata && typeof request.metadata === 'object' ? request.metadata : {};
  // grep / glob carry the search root in metadata.path (its resource is the pattern); read carries the file in its resource.
  if (kind === 'grep' || kind === 'glob') {
    for (const key of ['path', 'directory', 'root']) if (typeof meta[key] === 'string' && meta[key]) return meta[key];
    return '.';
  }
  for (const key of ['filePath', 'filepath', 'file_path', 'path']) if (typeof meta[key] === 'string' && meta[key]) return meta[key];
  const pattern = request?.pattern ?? request?.patterns;
  return typeof pattern === 'string' ? pattern : Array.isArray(pattern) && typeof pattern[0] === 'string' ? pattern[0] : null;
}

/** A read / grep / glob ask under an evaluation confinement: null when the real path is inside the folder, else why not. */
function evalReadDecision(request, confined, kind) {
  const raw = evalReadPathOf(request, kind);
  const root = confined?.root;
  if (!root) return 'This run\'s evaluation folder is not known: nothing can be read.';
  const at = placeOf(raw, root);
  // placeOf follows every symlink (realPathOf): a link that leaves the folder resolves outside it and is refused.
  // This check is race-free because the eval shell's sandbox denies symlink creation (lib/skills/eval-sandbox.js), so
  // no link can be planted or repointed between this resolve and the read tool's open.
  if (!at || !isInside(root, at, { allowRoot: true })) return `${kind === 'read' ? 'Read' : kind === 'grep' ? 'Grep' : 'Glob'} stays inside this run's folder (${root}); a path that resolves outside it (a symlink) is refused. ${REFUSED}`;
  return null;
}

/** An OpenCode permission ask under an evaluation confinement: null when it may go ahead, else why not. */
export function evalOpenCodeDecision(request, confined) {
  const kind = String(request?.permission || request?.type || '').toLowerCase();
  const trial = confined?.role === 'trial';
  if (kind === 'read' || kind === 'grep' || kind === 'glob') return evalReadDecision(request, confined, kind);
  if (trial && kind === 'skill') return null;
  if (trial && kind === 'bash') return confined.shell ? null : `The shell is not available in this evaluation. ${REFUSED}`;
  if (trial && /^(?:edit|write|patch|multiedit|apply_patch)$/.test(kind)) {
    const meta = request?.metadata && typeof request.metadata === 'object' ? request.metadata : {};
    let raw = null;
    for (const key of ['filePath', 'filepath', 'file_path', 'path']) if (typeof meta[key] === 'string' && meta[key]) { raw = meta[key]; break; }
    if (!raw) {
      const pattern = request?.pattern ?? request?.patterns;
      raw = typeof pattern === 'string' ? pattern : Array.isArray(pattern) && typeof pattern[0] === 'string' ? pattern[0] : null;
    }
    return evalToolDecision('Write', { file_path: raw }, confined);
  }
  return `${kind || 'That tool'} is not available. ${REFUSED}`;
}
