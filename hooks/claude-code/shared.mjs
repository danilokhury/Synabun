/**
 * Shared utilities for SynaBun Claude Code hooks.
 *
 * Extracted to avoid duplication across session-start, prompt-submit,
 * post-remember, pre-compact, and stop hooks.
 */

import { readFileSync, existsSync, writeFileSync, readdirSync, unlinkSync, appendFileSync, mkdirSync, statSync, renameSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { dirname, join, basename, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataHome } from '../../lib/paths.js';
import { classifyPrompt, isTrivialPrompt } from './prompt-origin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Neural Interface endpoint, TypeSafe kill switch, hook budgets ---

export function niUrl() {
  return (process.env.SYNABUN_NI_URL || 'http://localhost:3344').replace(/\/+$/, '');
}

/**
 * SYNABUN_TYPESAFE=off in the hook's own environment (the skin test and any
 * CLI spawned with `typesafe:'off'` set it). Read on every call, never cached:
 * no /api/hook-judge calls, recall with judge:false, no edit notices, no
 * digest or plan-conflict requests.
 */
export function typesafeOff() {
  return String(process.env.SYNABUN_TYPESAFE ?? '').trim().toLowerCase() === 'off' || isTemporaryChat();
}

/**
 * SYNABUN_TEMPORARY_CHAT=1 in the hook's own environment: a temporary chat of
 * the Claude sidepanel (docs/claude-sidepanel.md), set by its bridge for that
 * session's process. Nothing of such a session is stored, indexed, judged or
 * asked for, and it is named to nobody: every hook takes one early branch on
 * this, and a session without the marker never does. Read on every call,
 * never cached.
 */
export function isTemporaryChat() {
  return String(process.env.SYNABUN_TEMPORARY_CHAT ?? '').trim() === '1';
}

/** A network call whose timeout would be shorter than this is skipped. */
export const MIN_CALL_MS = 250;

/**
 * Deadline arithmetic for a hook with a fixed Claude Code timeout. The clock
 * starts at process start (node startup and imports count against the budget),
 * and `safetyMs` is left for writing the output and exiting.
 *   remaining()          ms until the deadline
 *   callTimeout(reserve) timeout for a call that must leave `reserve` ms of
 *                        work after it (150 ms of slack is always kept)
 */
export function hookBudget(totalMs, safetyMs = 250) {
  const startedAt = Date.now() - process.uptime() * 1000;
  const deadline = startedAt + totalMs - safetyMs;
  return {
    deadline,
    remaining: () => Math.max(0, Math.floor(deadline - Date.now())),
    callTimeout: (reserveMs = 0) => Math.max(0, Math.floor(deadline - Date.now() - 150 - reserveMs)),
  };
}

/**
 * The server refuses judgment text over 16000 characters, and prompts that
 * long used to get neither a judgment nor a recall. Keep the head and the
 * tail: requests usually open with the ask and close with the specifics.
 */
export function clipForJudge(text, max = 12000, head = 9000) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= max) return s;
  const marker = '\n[…]\n';
  return s.slice(0, head) + marker + s.slice(s.length - (max - head - marker.length));
}

/** Recall queries embed the head of the prompt only. */
export function clipQuery(text, max = 2000) {
  return (typeof text === 'string' ? text : '').slice(0, max);
}

function clipLine(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

function tailText(value, max) {
  const s = String(value ?? '').trim();
  return s.length > max ? `…${s.slice(s.length - (max - 1))}` : s;
}
const DATA_HOME = getDataHome();
export const DATA_DIR = join(DATA_HOME, 'data');
export const MCP_DATA_DIR = join(DATA_HOME, 'mcp-data');
export const ENV_PATH = join(DATA_HOME, '.env');
export const HOOK_FEATURES_PATH = join(DATA_DIR, 'hook-features.json');
export const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
export const LOOP_LOG_DIR = join(DATA_DIR, 'logs');

// --- Loop logging (mirrors neural-interface/lib/loop-logger.js) ---
// Writes per-loop entries from inside hooks into the same logfile the server uses.

let _loopLogDirEnsured = false;
function ensureLoopLogDir() {
  if (_loopLogDirEnsured) return;
  try {
    if (!existsSync(LOOP_LOG_DIR)) mkdirSync(LOOP_LOG_DIR, { recursive: true });
    _loopLogDirEnsured = true;
  } catch { /* ok */ }
}

function safeJsonInline(obj) {
  try {
    return JSON.stringify(obj, (_k, v) => {
      if (typeof v === 'string' && v.length > 800) return v.slice(0, 800) + `…(+${v.length - 800})`;
      return v;
    });
  } catch { return '<unserializable>'; }
}

/**
 * Append a line to a logfile, rotating it once if it exceeds maxBytes.
 * Hook debug logs (compact-debug.log, user-learning-debug.log, …) were plain
 * appendFileSync with no bound and grew to tens of MB. This keeps one `.1`
 * backup and starts fresh, capping on-disk size at ~2x maxBytes.
 */
export function appendCapped(filePath, line, maxBytes = 10 * 1024 * 1024) {
  try {
    if (existsSync(filePath) && statSync(filePath).size > maxBytes) {
      try { renameSync(filePath, filePath + '.1'); } catch { /* fall through to append */ }
    }
  } catch { /* stat failed — just append */ }
  try { appendFileSync(filePath, line); } catch { /* best effort */ }
}

/**
 * Delete pending-remember flag files older than maxAgeDays. These per-session
 * flags are created on first user message and never deleted, so they pile up
 * (hundreds of stale files). Safe to sweep by mtime — a live session rewrites
 * its flag on every message, keeping mtime fresh.
 */
export function cleanupStalePendingRemember(maxAgeDays = 30) {
  let deleted = 0;
  try {
    if (!existsSync(PENDING_REMEMBER_DIR)) return { deleted };
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const f of readdirSync(PENDING_REMEMBER_DIR)) {
      if (!f.endsWith('.json')) continue;
      const fp = join(PENDING_REMEMBER_DIR, f);
      try {
        if (statSync(fp).mtimeMs < cutoff) { unlinkSync(fp); deleted++; }
      } catch { /* skip racing/unreadable */ }
    }
  } catch { /* ok */ }
  return { deleted };
}

/**
 * Delete the files in `dir` last modified more than `maxAgeMs` ago (per-session
 * caches such as data/subagent-dispatch/ that nothing else removes).
 */
export function cleanupStaleFiles(dir, maxAgeMs) {
  let deleted = 0;
  try {
    if (!existsSync(dir)) return { deleted };
    const cutoff = Date.now() - maxAgeMs;
    for (const f of readdirSync(dir)) {
      const fp = join(dir, f);
      try {
        if (statSync(fp).mtimeMs < cutoff) { unlinkSync(fp); deleted++; }
      } catch { /* skip racing/unreadable */ }
    }
  } catch { /* ok */ }
  return { deleted };
}

/**
 * Append one log entry to the per-loop logfile and stderr.
 * tsid may be null/undefined; will fall back to SYNABUN_TERMINAL_SESSION env.
 */
export function appendLoopLog(tsid, tag, msg, meta = undefined) {
  const sid = tsid || process.env.SYNABUN_TERMINAL_SESSION || null;
  const line = `${new Date().toISOString()} | hook:${tag} | ${msg}${meta ? ' | ' + safeJsonInline(meta) : ''}\n`;
  try { process.stderr.write(`[loop:hook:${tag}] ${msg}${meta ? ' ' + safeJsonInline(meta) : ''}\n`); } catch { /* ok */ }
  if (!sid) return;
  ensureLoopLogDir();
  try {
    appendFileSync(pathResolve(LOOP_LOG_DIR, `loop-${sid}.log`), line);
  } catch { /* ok */ }
}

// --- Stdin ---

export function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('{}');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(guard); resolve(data); });
    // unref + clearTimeout: without both, this timer keeps the event loop alive
    // for its full duration AFTER 'end' already resolved, so every hook
    // invocation stalled ~2s against a 3s configured timeout.
    const guard = setTimeout(() => resolve(data || '{}'), 2000);
    guard.unref?.();
  });
}

// --- Transcript reading (session-scoped plan storage) ---

const CLAUDE_PROJECTS_DIR = join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects');

/**
 * Convert a cwd to Claude Code's transcript project-dir key.
 * Claude Code replaces every non-alphanumeric char with a hyphen, so
 * /Users/foo/Apps/Synabun → -Users-foo-Apps-Synabun.
 */
function cwdToProjectKey(cwd) {
  if (!cwd) return '';
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolve a readable transcript path for a session. Prefers the explicit
 * transcriptPath from the hook input; falls back to deriving it from
 * sessionId + cwd, then to scanning ~/.claude/projects/ for <sessionId>.jsonl
 * (covers sessions that cd'd into a subdir after launch).
 *
 * Returns an absolute path or null. Never guesses across sessions — the
 * returned transcript belongs to exactly the requested sessionId.
 */
export function resolveTranscriptPath(transcriptPath, sessionId, cwd) {
  try {
    if (transcriptPath && existsSync(transcriptPath)) return transcriptPath;
  } catch { /* fall through */ }

  if (!sessionId) return null;

  // Fast path: derive ~/.claude/projects/<key>/<sessionId>.jsonl from cwd.
  try {
    const key = cwdToProjectKey(cwd);
    if (key) {
      const derived = join(CLAUDE_PROJECTS_DIR, key, `${sessionId}.jsonl`);
      if (existsSync(derived)) return derived;
    }
  } catch { /* fall through */ }

  // Robust path: scan every project dir for <sessionId>.jsonl.
  try {
    if (existsSync(CLAUDE_PROJECTS_DIR)) {
      for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
        const candidate = join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        try { if (existsSync(candidate)) return candidate; } catch { /* skip */ }
      }
    }
  } catch { /* ok */ }

  return null;
}

/**
 * Read up to maxBytes from the END of a file as UTF-8. Bounded so a multi-MB
 * transcript never blows the Stop hook's short timeout. The first line of the
 * returned slice may be truncated — callers must tolerate unparseable lines.
 */
function readFileTail(filePath, maxBytes = 512 * 1024) {
  let fd = null;
  try {
    fd = openSync(filePath, 'r');
    const size = fstatSync(fd).size;
    const readBytes = Math.min(size, maxBytes);
    if (readBytes <= 0) return '';
    const start = size - readBytes;
    const buf = Buffer.allocUnsafe(readBytes);
    readSync(fd, buf, 0, readBytes, start);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ok */ } }
  }
}

/**
 * Scan a session transcript for the LAST ExitPlanMode tool_use and return its
 * authoritative plan payload. Because the transcript belongs to exactly one
 * session, this is session-scoped by construction — it can never surface
 * another session's plan (the root cause of the cross-session leak).
 *
 * Returns { plan, planFilePath, slug } or null when the session has no
 * ExitPlanMode (i.e. it never exited plan mode).
 */
export function readLastExitPlanMode(transcriptPath) {
  if (!transcriptPath) return null;
  const tail = readFileTail(transcriptPath);
  if (!tail) return null;

  const lines = tail.split('\n');
  // Walk backwards: the first ExitPlanMode found = the LAST in the file,
  // which is the final approved plan when a session re-plans. A declined one
  // (the user kept planning, the approval card expired, the stream closed) is
  // skipped: only an approved plan is owed to memory.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('ExitPlanMode') === -1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'tool_use' && block.name === 'ExitPlanMode') {
        const result = exitPlanResult(lines, i, block.id);
        if (result?.declined) break;
        const input = block.input || {};
        return {
          plan: typeof input.plan === 'string' ? input.plan : '',
          planFilePath: typeof input.planFilePath === 'string' ? input.planFilePath : '',
          slug: typeof entry.slug === 'string' ? entry.slug : '',
          // Where the CLI says the plan file is (it may never have been written).
          resultFilePath: result?.filePath || '',
        };
      }
    }
  }
  return null;
}

/**
 * The result of the ExitPlanMode call on line `at`: { declined, filePath }, or
 * null when none is there yet. An error result is a decline. "You are not in
 * plan mode" is one too, unless the transcript shows an approval anyway: the
 * session was in plan mode for that turn and the approval left it before the
 * call ran (older CLIs did that to most approvals), or the Claude sidepanel's
 * simulated plan mode was approved with its "Continue with implementation"
 * prompt. Without either, the session was never in plan mode.
 */
function exitPlanResult(lines, at, id) {
  if (!id) return null;
  const needle = `"tool_use_id":"${id}"`;
  for (let j = at + 1; j < lines.length; j++) {
    if (lines[j].indexOf(needle) === -1) continue;
    let entry;
    try { entry = JSON.parse(lines[j]); } catch { continue; }
    const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    const block = content.find((b) => b && b.type === 'tool_result' && b.tool_use_id === id);
    if (!block) continue;
    const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
    const approvedAnyway = /not in plan mode/i.test(text) && (planModeTurn(lines, at) || sidepanelContinued(lines, j + 1));
    return {
      declined: block.is_error === true && !approvedAnyway,
      filePath: typeof entry.toolUseResult?.filePath === 'string' ? entry.toolUseResult.filePath : '',
    };
  }
  return null;
}

// Transcript lines parsed only when they can decide (a plan-mode reminder, a
// mode change, a user entry).
function parsedIf(line, ...needles) {
  if (!line || !needles.some((needle) => line.indexOf(needle) !== -1)) return null;
  try { return JSON.parse(line); } catch { return null; }
}
// What the user sent, as the transcript records it: not a tool result, a hook's
// injected text (isMeta) or a compaction summary. Stamped or not, it starts a turn.
function isPrompt(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isCompactSummary) return false;
  const content = entry.message?.content;
  return !(Array.isArray(content) && content.some((b) => b && b.type === 'tool_result'));
}
function promptText(entry) {
  const content = entry.message?.content;
  return typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('\n') : '';
}

/**
 * Whether the session was in plan mode during the turn of the entry on line
 * `at`, walking back no further than the prompt that started it. The CLI writes
 * a `plan_mode` attachment (its plan-mode reminder) only while the permission
 * mode is plan, a `permission-mode` entry when the mode changes, and stamps a
 * prompt with `permissionMode`. A `plan_mode_exit` attachment first means plan
 * mode had already ended. The turn's prompt ends the walk: an unstamped one
 * leaves the mode unknown, so nothing was approved, and nothing before it
 * counts. The sidepanel's simulated plan mode runs in default and leaves none
 * of them.
 */
function planModeTurn(lines, at) {
  for (let k = at - 1; k >= 0; k--) {
    const entry = parsedIf(lines[k], '"plan_mode', '"permission-mode"', '"type":"user"');
    if (!entry) continue;
    if (entry.type === 'attachment') {
      if (entry.attachment?.type === 'plan_mode_exit') return false;
      if (entry.attachment?.type === 'plan_mode') return true;
      continue;
    }
    if (entry.type === 'permission-mode') return entry.permissionMode === 'plan';
    if (isPrompt(entry)) return entry.permissionMode === 'plan';
  }
  return false;
}

// The Claude sidepanel's "Continue with implementation" prompts (ui-claude-panel.js
// renderPostPlanActions): the approval of a plan made in its simulated plan mode.
const SIDEPANEL_PLAN_APPROVAL = /(?:^|\n)(?:Continue with the implementation based on the approved plan\.|The user has reviewed and approved this updated plan:)/;

// A slash command and its output (the PLAN COMPLETE card's "Compact context" runs /compact).
const COMMAND_ECHO = /^\s*<(?:command-|local-command-)/;

/**
 * Whether the first prompt from line `from` on is the sidepanel's approval of
 * the plan before it. A slash command or its output in between is not an answer.
 */
function sidepanelContinued(lines, from) {
  for (let j = from; j < lines.length; j++) {
    const entry = parsedIf(lines[j], '"type":"user"');
    if (!isPrompt(entry)) continue;
    const text = promptText(entry);
    if (COMMAND_ECHO.test(text)) continue;
    return SIDEPANEL_PLAN_APPROVAL.test(text);
  }
  return false;
}

// --- Transcript entries (turn activity, recent prompts) ---
//
// Transcript lines are {type:'user'|'assistant', message:{role, content},
// isMeta?, isSidechain?, promptId?, promptSource?, toolUseResult?}. Other line
// types (attachment, file-history, ai-title, …) can be megabytes each, so a
// line is only parsed when its head carries a `"message":` key and no
// `"attachment":` key (checked on 7,878 live entries: `"message":` always sits
// in the first 180 characters).

const MEMORY_WRITE_TOOL = /(?:^|__)Syna[Bb]un_+(?:remember|reflect)$/;
const MEMORY_TOOL = /(?:^|__)Syna[Bb]un_+(?:remember|reflect|recall|memories|forget|restore|sync)$/;
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
// Results that say nothing about whether the work succeeded.
const QUIET_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'TodoWrite', 'NotebookRead',
  'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

export function transcriptEntries(filePath, maxBytes = 2 * 1024 * 1024) {
  if (!filePath) return [];
  let fd = null;
  let text = '';
  let truncated = false;
  try {
    fd = openSync(filePath, 'r');
    const size = fstatSync(fd).size;
    const readBytes = Math.min(size, maxBytes);
    if (readBytes <= 0) return [];
    truncated = readBytes < size;
    const buf = Buffer.allocUnsafe(readBytes);
    readSync(fd, buf, 0, readBytes, size - readBytes);
    text = buf.toString('utf-8');
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ok */ } }
  }
  const lines = text.split('\n');
  if (truncated) lines.shift(); // started mid-line
  const entries = [];
  for (const line of lines) {
    if (!line) continue;
    const head = line.slice(0, 600);
    if (head.includes('"attachment":') || !head.includes('"message":')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry && (entry.type === 'user' || entry.type === 'assistant')) entries.push(entry);
  }
  return entries;
}

function contentBlocks(entry) {
  const content = entry?.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text || '' : '')).filter(Boolean).join('\n');
  return '';
}

/** The text a user entry carries (tool results excluded). */
export function userEntryText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' ? b.text || '' : '')).filter(Boolean).join('\n');
}

/**
 * A user entry that starts a turn: typed (or injected) text, not a tool result,
 * not Claude Code's own meta line (Stop-hook feedback, caveats), not a sidechain.
 */
export function isTurnStart(entry) {
  if (!entry || entry.type !== 'user' || entry.isMeta || entry.isSidechain) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content) || content.length === 0) return false;
  return !content.some((b) => b && b.type === 'tool_result');
}

/** Human-typed prompt text of a turn-start entry, or '' for system-injected ones. */
export function humanPromptText(entry) {
  if (!isTurnStart(entry) || entry.promptSource === 'system') return '';
  const cls = classifyPrompt(userEntryText(entry));
  return cls.origin === 'human' ? cls.text : '';
}

// Checks that could back a claim like "tests pass" or "it builds".
const TEST_OR_BUILD = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:.-]*(?:test|build|check|lint|typecheck|verify)[\w:.-]*|npx\s+(?:vitest|jest|mocha|tsc|playwright|eslint)|node\s+(?:--test\b|\S*(?:test|spec|bench|verify)\S*)|vitest|jest|mocha|pytest|tsc|go\s+(?:test|build|vet)|cargo\s+(?:test|build|check|clippy)|make\b|mvn\b|gradle\w*|dotnet\s+(?:test|build)|swift\s+(?:test|build)|xcodebuild|ruff|eslint|playwright\s+test)/i;

export function isTestOrBuildCommand(command) {
  return TEST_OR_BUILD.test(String(command || ''));
}

const READ_ONLY_COMMAND = /^(?:ls|ll|cat|bat|head|tail|less|more|grep|egrep|fgrep|rg|ag|find|fd|pwd|echo|printf|wc|which|type|whereis|stat|file|du|df|tree|sort|uniq|cut|tr|awk|jq|column|diff|cmp|date|true|basename|dirname|realpath|readlink|env|printenv|cd|sed\s+-n|git\s+(?:status|log|diff|show|branch|rev-parse|remote|ls-files|blame|shortlog|describe|config\s+--get))\b/i;

/**
 * True when every segment of a shell command only reads. A redirect into a
 * file makes a segment a write. Used to decide whether a Bash-only turn did
 * anything that could be worth a memory; the judgment makes the final call.
 */
export function isReadOnlyCommand(command) {
  const segments = String(command || '').split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return true;
  return segments.every((segment) => {
    const bare = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    const withoutHarmless = bare.replace(/\d?>>?\s*\/dev\/null/g, '').replace(/\d?>&\d/g, '');
    if (/>/.test(withoutHarmless)) return false;
    return READ_ONLY_COMMAND.test(bare);
  });
}

function bashResultText(result) {
  if (!result) return '';
  const fromBlock = blockText(result.block?.content);
  if (fromBlock) return fromBlock;
  const tur = result.tur;
  if (tur && typeof tur === 'object') return [tur.stdout, tur.stderr].filter((s) => typeof s === 'string' && s).join('\n');
  return typeof tur === 'string' ? tur : '';
}

function bashExit(input, result) {
  if (!result) return input?.run_in_background ? 'background' : 'interrupted';
  const tur = result.tur;
  if (tur && typeof tur === 'object') {
    if (tur.interrupted === true) return 'interrupted';
    if (tur.backgroundTaskId) return 'background';
  }
  if (result.block?.is_error === true) {
    return /interrupted by user/i.test(bashResultText(result)) ? 'interrupted' : 'error';
  }
  return input?.run_in_background ? 'background' : 'ok';
}

/**
 * What the current turn did, read from the transcript: everything after the
 * last turn-start user entry (see isTurnStart).
 *
 *   bash_commands  ≤12 most recent Bash calls of the WHOLE turn:
 *                  {command ≤240, description ≤100, exit, output_tail ≤300,
 *                   after_memory_write}. The turn usually runs its tests, then
 *                   calls `remember`, then reports — the claim check must see
 *                   the test run, so the window is the turn, not the part
 *                   after the last memory write.
 *   checks         every test/build command of the turn (≤10 most recent)
 *   tool_results   ≤6 non-Bash results that can show success or failure
 *   edited_files   files edited this turn
 *   tool_counts    tool name → calls this turn
 *   memory_written_this_turn  a SynaBun remember/reflect ran this turn
 *   prompt_id      promptId of the turn-start entry, when recorded
 */
export function readTurnActivity(transcriptPath, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const activity = {
    prompt_id: null, bash_commands: [], checks: [], tool_results: [], edited_files: [],
    tool_counts: {}, memory_written_this_turn: false, bash_total: 0,
  };
  const entries = transcriptEntries(transcriptPath, maxBytes);
  if (!entries.length) return activity;
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isTurnStart(entries[i])) {
      start = i + 1;
      activity.prompt_id = typeof entries[i].promptId === 'string' ? entries[i].promptId : null;
      break;
    }
  }
  const turn = entries.slice(start);
  const results = new Map();
  const uses = [];
  for (const entry of turn) {
    for (const block of contentBlocks(entry)) {
      if (!block || typeof block !== 'object') continue;
      if (entry.type === 'user' && block.type === 'tool_result' && block.tool_use_id) {
        results.set(block.tool_use_id, { block, tur: entry.toolUseResult });
      } else if (entry.type === 'assistant' && block.type === 'tool_use') {
        uses.push(block);
      }
    }
  }
  let lastWrite = -1;
  uses.forEach((use, i) => { if (MEMORY_WRITE_TOOL.test(use.name || '')) lastWrite = i; });
  activity.memory_written_this_turn = lastWrite >= 0;

  const bash = [];
  const others = [];
  const edited = new Set();
  uses.forEach((use, i) => {
    const name = String(use.name || '');
    activity.tool_counts[name] = (activity.tool_counts[name] || 0) + 1;
    const input = use.input && typeof use.input === 'object' ? use.input : {};
    const result = results.get(use.id);
    if (name === 'Bash') {
      const command = String(input.command || '');
      const entry = {
        command: clipLine(command, 240),
        description: clipLine(input.description, 100),
        exit: bashExit(input, result),
        output_tail: tailText(bashResultText(result), 300),
        after_memory_write: i > lastWrite,
      };
      bash.push(entry);
      if (isTestOrBuildCommand(command)) activity.checks.push({ command: entry.command, exit: entry.exit, after_memory_write: entry.after_memory_write });
      return;
    }
    if (EDIT_TOOL_NAMES.has(name)) {
      const file = input.file_path || input.notebook_path;
      if (typeof file === 'string' && file) edited.add(file);
    }
    if (QUIET_TOOLS.has(name) || MEMORY_TOOL.test(name) || !result) return;
    others.push({ order: i, tool: name, is_error: result.block?.is_error === true, tail: tailText(blockText(result.block?.content) || (typeof result.tur === 'string' ? result.tur : ''), 300) });
  });
  activity.bash_total = bash.length;
  activity.bash_commands = bash.slice(-12);
  activity.checks = activity.checks.slice(-10);
  activity.edited_files = [...edited].slice(0, 50);
  // ≤6 results, errors first (they are the evidence that matters), then the
  // most recent; reported in the order they happened.
  const errors = others.filter((r) => r.is_error).slice(-6);
  const rest = others.filter((r) => !r.is_error).slice(-(6 - errors.length));
  activity.tool_results = [...errors, ...rest].sort((a, b) => a.order - b.order)
    .map(({ tool, is_error, tail }) => ({ tool, is_error, tail }));
  return activity;
}

/** The last n non-trivial human prompts in the transcript, most recent first. */
export function readRecentHumanPrompts(transcriptPath, n = 2, maxBytes = 512 * 1024) {
  const out = [];
  const entries = transcriptEntries(transcriptPath, maxBytes);
  for (let i = entries.length - 1; i >= 0 && out.length < n; i--) {
    const text = humanPromptText(entries[i]);
    if (text && !isTrivialPrompt(text)) out.push(text);
  }
  return out;
}

/** Text of the last assistant text block in the transcript, clipped. */
export function readLastAssistantText(transcriptPath, maxChars = 1200, maxBytes = 512 * 1024) {
  const entries = transcriptEntries(transcriptPath, maxBytes);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== 'assistant') continue;
    const blocks = contentBlocks(entries[i]).filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim());
    if (blocks.length) return blocks[blocks.length - 1].text.trim().slice(0, maxChars);
  }
  return '';
}

// --- Hook features ---

export function getHookFeatures() {
  try {
    if (!existsSync(HOOK_FEATURES_PATH)) return {};
    return JSON.parse(readFileSync(HOOK_FEATURES_PATH, 'utf-8'));
  } catch { return {}; }
}

// --- Memory recall (shared by prompt-submit and subagent-start hooks) ---

function formatMemoryAge(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

export const MEMORY_BLOCK_HEADER = '=== SynaBun: Related Memories ===';
export const MEMORY_BLOCK_END = '=== End Memories ===';

/**
 * The `=== SynaBun: Related Memories ===` block (the header is load-bearing:
 * the assistant persona and tests look for it). When the server ranked the
 * shortlist, the closing line says so, with the number of candidates the
 * relevance floor removed.
 */
export function formatMemoryBlock(data, { ranked = false, dropped = 0 } = {}) {
  if (!data || !Array.isArray(data.results) || data.results.length === 0) return '';
  const n = Number(dropped) || 0;
  const tag = ranked ? ` [ranked by Jev${n > 0 ? `; ${n} low-relevance ${n === 1 ? 'match' : 'matches'} dropped` : ''}]` : '';
  if (data.context) {
    return [MEMORY_BLOCK_HEADER, data.context,
      `Use these as evidence; fetch full UUIDs only when more detail is needed.${tag}`, MEMORY_BLOCK_END].join('\n');
  }
  const lines = data.results.map((r, i) => {
    const score = (r.score * 100).toFixed(0);
    const age = formatMemoryAge(r.created_at);
    const tags = r.tags?.length ? r.tags.join(', ') : 'none';
    const files = r.related_files?.length ? r.related_files.slice(0, 3).join(', ') : 'none';
    return `${i + 1}. [${r.category} | importance ${r.importance}, ${age}, ${score}% match] ${r.content}\n   Tags: ${tags} | Files: ${files}`;
  });
  return [MEMORY_BLOCK_HEADER, ...lines,
    `These memories may be relevant. Use as context — call recall for deeper search if needed.${tag}`, MEMORY_BLOCK_END].join('\n');
}

/**
 * Fetch relevant memories from the Neural Interface server and format them
 * into the `=== SynaBun: Related Memories ===` block used for additionalContext.
 *
 * @param {object} opts
 * @param {string} opts.query    Text to search memories with.
 * @param {string} [opts.project] Resolved project label (omit/'global' searches globally).
 * @param {number} [opts.limit]  Max results (default 3).
 * @param {number} [opts.minScore] Minimum cosine score (default 0.4).
 * @param {number} [opts.timeoutMs] Fetch timeout (default 1500).
 * @param {number} [opts.tokenBudget] Compact context budget (default 600).
 * @param {boolean} [opts.returnMeta] Return { context, alreadyPresent, ranked, rank_surface, dropped, stale }.
 * @param {string} [opts.sessionId] Claude session: injection dedup ledger AND log attribution.
 * @param {string} [opts.logSessionId] Log attribution only (a subagent must not be
 *   deduplicated against memories that live in its parent's context).
 * @param {boolean} [opts.rank] Legacy flag: rank with surface brief-rank.
 * @param {'rerank'|'brief-rank'} [opts.surface] Rank with this surface (implies ranking).
 * @param {boolean} [opts.floor] Drop judged candidates under the surface's minScore.
 * @param {number} [opts.budgetMs] Remaining hook budget for this call; also the fetch timeout.
 * @param {boolean} [opts.wantStale] Return (and mark delivered) this session's stale verdicts.
 * @param {string[]} [opts.staleAck] Verdicts already shown elsewhere: mark delivered, do not return.
 * @returns {Promise<string|object>} Empty on failure.
 */
export async function recallMemories({ query, project, limit = 3, minScore = 0.4, timeoutMs = 1500, tokenBudget = 600,
  returnMeta = false, sessionId, logSessionId, contextGeneration, rank = false, surface, floor = false, budgetMs,
  wantStale = false, staleAck } = {}) {
  // responded: the server answered (so staleAck was received and applied).
  const meta = { responded: false, ranked: false, rank_surface: null, dropped: [], stale: [] };
  const result = (context = '', alreadyPresent = false) => returnMeta ? { context, alreadyPresent, ...meta } : context;
  const trimmed = (query || '').trim();
  if (!trimmed) return result();
  const effective = Math.floor(Math.min(Number(timeoutMs) || 0, budgetMs === undefined ? Infinity : Number(budgetMs) || 0));
  if (!(effective >= MIN_CALL_MS)) return result();
  const off = typesafeOff();
  const ranking = !off && (rank || !!surface);
  try {
    const resp = await fetch(`${niUrl()}/api/hook-recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: trimmed,
        project: project && project !== 'global' ? project : undefined,
        limit,
        min_score: minScore,
        token_budget: tokenBudget, format: 'compact',
        caller: 'claude-code-hook', claudeSessionId: sessionId, context_generation: contextGeneration,
        session_id: sessionId || logSessionId || undefined,
        // Ranking judges the shortlist server-side and must fit this hook's
        // deadline. `rank:true` is what an older server understands (surface
        // brief-rank); a `surface` alone implies ranking on a current server,
        // so the prompt path stays unranked on an old one.
        rank: (rank && !off) || undefined,
        rank_timeout_ms: ranking ? Math.max(300, effective - 400) : undefined,
        surface: surface || undefined,
        floor: floor || undefined,
        judge: off ? false : undefined,
        budget_ms: budgetMs === undefined ? undefined : effective,
        want_stale: wantStale || undefined,
        stale_ack: Array.isArray(staleAck) && staleAck.length ? staleAck.slice(0, 50) : undefined,
      }),
      signal: AbortSignal.timeout(effective),
    });

    if (!resp.ok) return result();
    const data = await resp.json();
    if (!data || typeof data !== 'object') return result();
    meta.responded = true;
    meta.ranked = data.ranked === true;
    meta.rank_surface = typeof data.rank_surface === 'string' ? data.rank_surface : null;
    meta.dropped = Array.isArray(data.dropped) ? data.dropped : [];
    meta.stale = Array.isArray(data.stale) ? data.stale.filter((v) => v && typeof v.memory_id === 'string') : [];
    if (data.already_present) return result('', true);
    if (!data.results || data.results.length === 0) return result();
    return result(formatMemoryBlock(data, { ranked: meta.ranked, dropped: meta.dropped.length }));
  } catch {
    // NI down, timeout, or error — silently skip
    return result();
  }
}

/**
 * POST /api/hook-judge. Hooks never hold the API key and never call the vendor
 * directly. Always resolves; {} means "not judged" and every caller falls back
 * to its own rule. No network at all when SYNABUN_TYPESAFE=off, when the
 * request says judge:false, or when the budget left is under MIN_CALL_MS.
 */
export async function hookJudge(kind, fields = {}, { timeoutMs = 1500 } = {}) {
  const body = fields && typeof fields === 'object' ? fields : {};
  if (typesafeOff() || body.judge === false) return {};
  const t = Math.floor(Number(timeoutMs) || 0);
  if (!(t >= MIN_CALL_MS)) return {};
  try {
    const resp = await fetch(`${niUrl()}/api/hook-judge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, kind, budget_ms: body.budget_ms ?? t }),
      signal: AbortSignal.timeout(t),
    });
    if (!resp.ok) return {};
    const data = await resp.json();
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Ask the Neural Interface for a typed judgment of a text (TypeSafe, server-side).
 *
 * @param {'prompt'|'agent-message'|'stop-turn'|'loop-goal'} kind
 * @param {string} text
 * @param {{project?:string, timeoutMs?:number, extra?:Record<string, any>,
 *          budget?:ReturnType<typeof hookBudget>, reserveMs?:number}} [opts]
 *   `extra` carries kind-specific state (files edited, loop task and journal).
 *   With `budget`, the timeout is also bounded by budget.callTimeout(reserveMs).
 * @returns {Promise<Record<string, any>>}
 */
export async function judgeText(kind, text, { project, timeoutMs = 1500, extra = {}, budget, reserveMs = 0 } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) return {};
  const t = budget ? Math.min(timeoutMs, budget.callTimeout(reserveMs)) : timeoutMs;
  return hookJudge(kind, { ...extra, text: trimmed, project }, { timeoutMs: t });
}

/**
 * Fire-and-forget POST that may wait at most `waitMs` for the answer and never
 * keeps the process alive past that. Resolves true only on a 2xx.
 */
export async function postNotice(path, body, waitMs = 200) {
  let timer;
  try {
    const request = fetch(`${niUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(50, waitMs)),
    }).then((resp) => resp.ok, () => false);
    const giveUp = new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); timer.unref?.(); });
    return await Promise.race([request, giveUp]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Edit-time stale verdicts (StaleVerdict[] from /api/hook-recall or stop-turn)
 * as one short advisory block: at most 3, excerpts clipped to 160 characters.
 */
export function formatStaleNotices(list) {
  const items = (Array.isArray(list) ? list : []).filter((v) => v && typeof v.memory_id === 'string').slice(0, 3);
  if (!items.length) return '';
  const lines = items.map((v) => {
    const parts = [];
    if (v.category) parts.push(String(v.category));
    const p = Number(v.probability);
    if (v.probability !== undefined && v.probability !== null && Number.isFinite(p)) parts.push(`p(still accurate)=${p.toFixed(2)}`);
    if (v.file) parts.push(String(v.file));
    const excerpt = clipLine(v.excerpt, 160);
    return `- [${v.memory_id}]${parts.length ? ` (${parts.join(', ')})` : ''}${excerpt ? ` "${excerpt}"` : ''}`;
  });
  return [
    'SynaBun [Jev] stale-memory check: a recent edit may have made these memories inaccurate.',
    ...lines,
    'Check each against the current code, then `reflect` to correct it or `forget` it if it no longer holds.',
  ].join('\n');
}

// --- Environment / connection ---

function parseEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return vars;
  } catch { return {}; }
}

export function getActiveConnectionId() {
  const vars = parseEnvFile(ENV_PATH);
  return vars.SYNABUN_ACTIVE_CONNECTION || vars.QDRANT_ACTIVE || 'default';
}

export function getCategoriesPath() {
  const connId = getActiveConnectionId();
  return join(MCP_DATA_DIR, `custom-categories-${connId}.json`);
}

/**
 * Returns the path to the MCP server's categories file (no connection suffix).
 * This is the file the MCP server watches — hooks that need the MCP server to
 * pick up changes (e.g., schema refresh) MUST write to this file.
 */
export function getMcpCategoriesPath() {
  return join(MCP_DATA_DIR, 'custom-categories.json');
}

// --- Project detection (reads from claude-code-projects.json) ---

const PROJECTS_PATH = join(DATA_DIR, 'claude-code-projects.json');

export function loadRegisteredProjects() {
  try {
    if (!existsSync(PROJECTS_PATH)) return [];
    return JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
  } catch { return []; }
}

export function normalizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function detectProject(cwd) {
  if (!cwd) return 'global';
  const lower = cwd.toLowerCase().replace(/\\/g, '/');
  const projects = loadRegisteredProjects();

  // Sort by path length descending — most specific match wins
  const sorted = projects
    .map((p) => ({
      path: p.path.toLowerCase().replace(/\\/g, '/'),
      label: normalizeLabel(p.label),
    }))
    .sort((a, b) => b.path.length - a.path.length);

  // 1. Exact path prefix match (cwd is inside a registered project)
  for (const p of sorted) {
    if (lower.startsWith(p.path + '/') || lower === p.path) return p.label;
  }

  // 2. Substring match — cwd folder name contains a registered project's folder name
  //    e.g. "MyAppWebsite" contains "myapp" → matches the MyApp project
  for (const p of sorted) {
    const projFolder = basename(p.path).toLowerCase();
    if (lower.includes(projFolder)) return p.label;
  }

  // 3. Fallback to directory basename
  const base = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return base || 'global';
}

// --- Category tree ---

export function loadCategories() {
  try {
    const data = JSON.parse(readFileSync(getCategoriesPath(), 'utf-8'));
    if (data.version === 1 && Array.isArray(data.categories)) {
      return data.categories;
    }
  } catch { /* no categories available */ }
  return [];
}

export function buildCategoryTree(categories) {
  if (!categories || categories.length === 0) {
    return '(No categories defined yet. Use `category` with action "create" to set up your first category.)';
  }

  const parents = categories.filter((c) => c.is_parent);
  const children = categories.filter((c) => c.parent);
  const standalone = categories.filter((c) => !c.is_parent && !c.parent);

  const lines = [];

  for (const parent of parents) {
    const kids = children.filter((c) => c.parent === parent.name);
    lines.push(`${parent.name} (PARENT) — ${parent.description}`);
    for (const kid of kids) {
      lines.push(`  └─ ${kid.name} — ${kid.description}`);
    }
    if (kids.length === 0) {
      lines.push(`  (no children yet)`);
    }
  }

  if (standalone.length > 0) {
    for (const cat of standalone) {
      lines.push(`${cat.name} — ${cat.description}`);
    }
  }

  return lines.join('\n');
}

// --- Auto-category creation ---

/**
 * Standalone categories required by hooks. Always created regardless of projects.
 */
const STANDALONE_DEFAULTS = [
  { name: 'conversations', description: 'Session summaries and conversation indexing' },
  { name: 'communication-style', description: 'User communication patterns and preferences' },
  { name: 'plans', description: 'Implementation plans stored after plan mode approval', is_parent: true, color: '#06d6a0' },
];

/**
 * Default child categories for every registered project.
 * Created under a project parent, never standalone.
 */
const PROJECT_CHILDREN = [
  { suffix: 'project', description: 'General project knowledge, decisions, and milestones' },
  { suffix: 'architecture', description: 'System design, tech stack, data flow, and component architecture' },
  { suffix: 'bugs', description: 'Bug fixes, debugging sessions, and known issues' },
  { suffix: 'config', description: 'Configuration, deployment, environment, and infrastructure' },
];

/**
 * Ensure all registered projects have a parent category with default children,
 * and that standalone hook-required categories exist.
 *
 * Writes to the MCP server's categories file (no connection suffix) so the
 * MCP server's file watcher picks up changes and refreshes tool schemas.
 *
 * Idempotent: only adds missing categories, never modifies or removes existing ones.
 *
 * @returns {{ created: string[], total: number }}
 */
export function ensureProjectCategories() {
  const projects = loadRegisteredProjects();
  const catPath = getMcpCategoriesPath();

  let data;
  try {
    data = JSON.parse(readFileSync(catPath, 'utf-8'));
  } catch {
    data = { version: 1, categories: [] };
  }

  const categories = data.categories || [];
  const existingNames = new Set(categories.map((c) => c.name));
  const created = [];
  const now = new Date().toISOString();

  // 1. Ensure standalone defaults exist
  for (const def of STANDALONE_DEFAULTS) {
    if (!existingNames.has(def.name)) {
      const cat = { name: def.name, description: def.description, created_at: now };
      if (def.is_parent) cat.is_parent = true;
      if (def.color) cat.color = def.color;
      categories.push(cat);
      existingNames.add(def.name);
      created.push(def.name);
    }
  }

  // 2. Ensure project parents + children exist
  for (const proj of projects) {
    let label = normalizeLabel(proj.label);
    // Truncate to 16 chars so children stay within 30-char limit (16 + 1 + 12 = 29)
    if (label.length > 16) label = label.slice(0, 16).replace(/-$/, '');

    // Ensure parent exists
    if (!existingNames.has(label)) {
      categories.push({
        name: label,
        description: `Knowledge and context for the ${proj.label} project`,
        is_parent: true,
        created_at: now,
      });
      existingNames.add(label);
      created.push(label);
    } else {
      // Parent exists — ensure it has is_parent flag
      const existing = categories.find((c) => c.name === label);
      if (existing && !existing.is_parent) existing.is_parent = true;
    }

    // Ensure each default child exists
    for (const child of PROJECT_CHILDREN) {
      const childName = `${label}-${child.suffix}`;
      if (!existingNames.has(childName)) {
        categories.push({
          name: childName,
          description: `${child.description} for ${proj.label}`,
          parent: label,
          created_at: now,
        });
        existingNames.add(childName);
        created.push(childName);
      }
    }
  }

  // Only write if we created something new
  if (created.length > 0) {
    data.categories = categories;
    writeFileSync(catPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  return { created, total: categories.length };
}

/**
 * Build the full category reference block for lazy injection.
 * Includes tree, available names, selection rules, project scoping, and tool notes.
 */
export function buildCategoryReference(categories, project) {
  const tree = buildCategoryTree(categories);
  const names = categories.map((c) => c.name).join(', ');

  return [
    `## SynaBun Category Reference`,
    ``,
    `### Project: ${project}`,
    ``,
    tree,
    ``,
    `Available names: ${names || '(none)'}`,
    ``,
    `### Category Selection`,
    ``,
    `1. Match existing child category by description → use it.`,
    `2. No child fits but parent does → \`category\` with action "create" for a new child under that parent → use it.`,
    `3. No parent fits → \`category\` with action "create" for a new parent + child → use it.`,
    `4. Uncertain → \`AskUserQuestion\` with 2-3 options + "Create new category" → use what user picks.`,
    ``,
    `NEVER guess. NEVER use parent directly. NEVER skip categorization.`,
    ``,
    `### Project Scoping`,
    ``,
    `- Project-specific (bugs, architecture, config) → "${project}"`,
    `- Universal (language features, library APIs) → "global"`,
    `- Cross-project (shared infra) → "shared"`,
  ].join('\n');
}

// --- Loop staleness cleanup ---

const LOOP_STALE_INACTIVITY_MS = 45 * 60 * 1000; // 45 min — browser iterations can be long

/**
 * Scan loop directory and delete stale/inactive loop files.
 * No history keeping — ended loops are removed immediately.
 *
 * A loop is stale if:
 * 1. active + exceeded its maxMinutes + 5min grace
 * 2. active + no iteration activity for 10 minutes (session died)
 *
 * @param {string} loopDir - path to data/loop/
 * @returns {{ deactivated: string[], deleted: string[] }}
 */
export function cleanupStaleLoops(loopDir) {
  const deactivated = [];
  const deleted = [];
  if (!existsSync(loopDir)) return { deactivated, deleted };

  const now = Date.now();
  try {
    const files = readdirSync(loopDir).filter(f => f.endsWith('.json') && !f.startsWith('pending-') && f !== 'active-pointer.json');
    for (const f of files) {
      const fp = join(loopDir, f);
      try {
        const loop = JSON.parse(readFileSync(fp, 'utf-8'));

        if (loop.active) {
          const lastActivity = new Date(loop.lastIterationAt || loop.startedAt || 0).getTime();
          const noRecentActivity = (now - lastActivity) >= LOOP_STALE_INACTIVITY_MS;

          if (noRecentActivity) {
            // Stale loop (no activity for 45 min) — delete immediately
            try { unlinkSync(fp); deleted.push(f); } catch { /* ok */ }
          }
        } else {
          // Inactive loop — delete immediately (no history keeping)
          try { unlinkSync(fp); deleted.push(f); } catch { /* ok */ }
        }
      } catch { /* skip corrupt files */ }
    }
  } catch { /* ok */ }

  // Drop active-pointer.json if its target flag no longer exists
  try {
    const ptrPath = join(loopDir, 'active-pointer.json');
    if (existsSync(ptrPath)) {
      const ptr = JSON.parse(readFileSync(ptrPath, 'utf-8'));
      const targetPath = ptr?.sessionId ? join(loopDir, `${ptr.sessionId}.json`) : null;
      if (!targetPath || !existsSync(targetPath)) {
        try { unlinkSync(ptrPath); } catch { /* ok */ }
      }
    }
  } catch { /* ok */ }

  // Delete stale pending-*.json files (client never claimed them)
  try {
    const pendingFiles = readdirSync(loopDir)
      .filter(f => f.startsWith('pending-') && f.endsWith('.json'));
    for (const f of pendingFiles) {
      const fp = join(loopDir, f);
      try {
        const loop = JSON.parse(readFileSync(fp, 'utf-8'));
        const lastActivity = new Date(loop.lastIterationAt || loop.startedAt || 0).getTime();
        if ((now - lastActivity) >= LOOP_STALE_INACTIVITY_MS) {
          try { unlinkSync(fp); deleted.push(f); } catch { /* ok */ }
        }
      } catch { /* skip corrupt */ }
    }
  } catch { /* ok */ }

  return { deactivated, deleted };
}
