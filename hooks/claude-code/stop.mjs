#!/usr/bin/env node

/**
 * SynaBun Stop Hook for Claude Code
 *
 * Fires when Claude finishes responding. Enforces requirements:
 *
 * 1. COMPACTION AUTO-STORE — If a pending-compact flag exists (set by
 *    PreCompact hook), blocks Claude until it stores the session via
 *    `remember` with category "conversations".
 *
 * 1.5. ACTIVE LOOP — If a loop state file exists (set by `loop start`
 *    MCP tool), blocks Claude to continue the next iteration until
 *    iteration cap or time cap is reached.
 *
 * 2. TASK MEMORY — If file edits have occurred without a `remember`
 *    call, blocks Claude to store the work. Also catches unstored plans.
 *    Jev (stop-turn) decides whether the edits are worth a memory, whether a
 *    Bash-only turn's shell work is (CHECK 2b), and whether the final message
 *    claims a result the turn's output does not show (CHECK 6, at most one
 *    block per prompt). Stale-memory verdicts join the unstored-work reason.
 *
 * The turn judgment and a hook loop's goal judgment run in parallel inside
 * the 3 s budget; native and exec loops are never judged (their runtimes own
 * the iteration, and the answer used to be thrown away).
 *
 * Safety: Max 3 retries per flag to prevent infinite loops.
 * Loop: Iteration cap is authoritative. Inactivity (45 min) catches stuck loops.
 *
 * Input (stdin JSON):
 *   { session_id, transcript_path, cwd, hook_event_name: "Stop",
 *     stop_hook_active, last_assistant_message }
 *
 * Output (stdout JSON):
 *   { "decision": "block", "reason": "..." } to force Claude to continue
 *   {} to allow Claude to stop normally
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync, readdirSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withStateLock, writeJsonAtomic, compactionSourceRef, planMemoryKey, planReceiptMatches, planStoredInDb } from './state.mjs';
import { cleanupStaleLoops, detectProject, DATA_DIR, appendLoopLog, appendCapped, resolveTranscriptPath, readLastExitPlanMode, judgeText,
  hookBudget, typesafeOff, readTurnActivity, readLastAssistantText, formatStaleNotices, isReadOnlyCommand, clipForJudge, isTemporaryChat } from './shared.mjs';

// Cross-platform safety: catch uncaught errors and output valid hook JSON
process.on('uncaughtException', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
process.on('unhandledRejection', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });

const __dirname = dirname(fileURLToPath(import.meta.url));
const PENDING_COMPACT_DIR = join(DATA_DIR, 'pending-compact');
const LOOP_DIR = join(DATA_DIR, 'loop');
const ACTIVE_POINTER_PATH = join(LOOP_DIR, 'active-pointer.json');

function writeActivePointer(sessionId, terminalSessionId, claudeSessionId) {
  try {
    const payload = {
      sessionId,
      terminalSessionId: terminalSessionId || null,
      claudeSessionId: claudeSessionId || null,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(ACTIVE_POINTER_PATH, payload);
  } catch { /* ok */ }
}

function clearActivePointer() {
  try { if (existsSync(ACTIVE_POINTER_PATH)) unlinkSync(ACTIVE_POINTER_PATH); } catch { /* ok */ }
}
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');

// Read-only peeks taken BEFORE the state lock, so the judgments they feed can
// run outside it (state.mjs refuses async work inside withStateLock). Every
// consumer re-reads the real state under the lock; these only shape the
// question, never the decision.
function peekPendingRemember(sessionId) {
  try {
    const flag = JSON.parse(readFileSync(join(PENDING_REMEMBER_DIR, `${sessionId}.json`), 'utf-8'));
    return {
      files: Array.isArray(flag.files) ? flag.files.slice(0, 20) : [], editCount: flag.editCount || 0,
      claimBlockedPromptId: typeof flag.claimBlockedPromptId === 'string' ? flag.claimBlockedPromptId : null,
    };
  } catch { return { files: [], editCount: 0, claimBlockedPromptId: null }; }
}

const LOOP_INACTIVE_MS = 45 * 60 * 1000;
const loopKind = (loop) => (loop.driverType === 'native' ? 'native' : loop.driverType === 'exec' ? 'exec' : 'hook');
const loopIsStale = (loop, now = Date.now()) => now - new Date(loop.lastIterationAt || loop.startedAt || 0).getTime() > LOOP_INACTIVE_MS;

/**
 * Which loop owns this Stop, resolved the way handleStop resolves it, but
 * read-only (no /clear rename, no cleanup): the native loop of this terminal,
 * the exact session file, then the terminalSessionId scan that finds a hook
 * loop after /clear gave the session a new id.
 * Returns { kind: 'native'|'exec'|'hook'|null, loop }.
 */
function peekLoop(sessionId) {
  const terminalSessionEnv = process.env.SYNABUN_TERMINAL_SESSION || '';
  if (terminalSessionEnv) {
    try {
      const nativeLoop = JSON.parse(readFileSync(join(LOOP_DIR, `${terminalSessionEnv}.json`), 'utf-8'));
      if (nativeLoop?.active && nativeLoop.driverType === 'native'
        && nativeLoop.terminalSessionId === terminalSessionEnv) return { kind: 'native', loop: nativeLoop };
    } catch { /* no native loop for this terminal */ }
  }
  const exactPath = join(LOOP_DIR, `${sessionId}.json`);
  if (existsSync(exactPath)) {
    try {
      const loop = JSON.parse(readFileSync(exactPath, 'utf-8'));
      if (!loop?.active || loopIsStale(loop)) return { kind: null, loop: null };
      return { kind: loopKind(loop), loop };
    } catch { /* corrupt: handleStop removes it and scans */ }
  }
  try {
    for (const f of readdirSync(LOOP_DIR)) {
      if (!f.endsWith('.json') || f.startsWith('pending-')) continue;
      let candidate;
      try { candidate = JSON.parse(readFileSync(join(LOOP_DIR, f), 'utf-8')); } catch { continue; }
      if (!candidate?.active || loopIsStale(candidate)) continue;
      if (terminalSessionEnv && candidate.terminalSessionId === terminalSessionEnv) return { kind: loopKind(candidate), loop: candidate };
      if (!terminalSessionEnv && candidate.currentIteration === 0 && !candidate.terminalSessionId) return { kind: loopKind(candidate), loop: candidate };
    }
  } catch { /* no loop dir */ }
  return { kind: null, loop: null };
}

// The state loop-goal judges: only a hook loop mid-run with iterations left.
function hookLoopGoalState(loop) {
  if (!loop || !(loop.currentIteration > 0) || !loop.task) return null;
  const total = loop.totalIterations || 10;
  if (loop.currentIteration >= total) return null; // the budget ends it anyway
  return {
    task: String(loop.task), context: loop.context ? String(loop.context) : null,
    journal: Array.isArray(loop.journal) ? loop.journal.slice(-5) : [],
    progress_summary: loop.progressSummary ? String(loop.progressSummary) : null,
    iteration: loop.currentIteration || 0, total,
  };
}

/** Shell work this turn that changed something and came after the last memory write. */
function unsavedShellWork(judged, activity) {
  if (judged.bashOnlyWorth !== true || !activity) return [];
  return (activity.bash_commands || []).filter((c) => c.after_memory_write && !isReadOnlyCommand(c.command));
}

const clipCommand = (command, max = 80) => {
  const s = String(command || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Deterministic evidence for a claim block, read from the turn's own output. */
function claimEvidence(activity) {
  const checks = Array.isArray(activity?.checks) ? activity.checks : [];
  if (!checks.length) return 'no test/build command ran this turn';
  const last = checks[checks.length - 1];
  const cmd = `\`${clipCommand(last.command)}\``;
  if (last.exit === 'error') return `the last ${cmd} exited with an error`;
  if (last.exit === 'interrupted') return `the last ${cmd} was interrupted`;
  if (last.exit === 'background') return `${cmd} was still running in the background`;
  const bash = Array.isArray(activity?.bash_commands) ? activity.bash_commands : [];
  const lastRun = bash[bash.length - 1];
  if (lastRun && lastRun.exit === 'error') return `the last command, \`${clipCommand(lastRun.command)}\`, exited with an error`;
  return `the last check, ${cmd}, exited ok, but the message reports more than this turn's output shows`;
}
const STORED_PLANS_PATH = join(DATA_DIR, 'stored-plans.json');
const PLAN_DEBUG_LOG = join(DATA_DIR, 'plan-debug.log');
const MAX_RETRIES = 3;
const EDIT_THRESHOLD = 1;
// Session ceiling on task-memory blocks. `retries` resets whenever a new edit
// segment starts (post-remember.mjs), so it alone can no longer bound the
// block↔respond cycle. `stop_hook_active` is not honored for task memory (only
// for plan memory), so this is the only backstop against an agent that
// edits-then-stops forever.
const MAX_TASK_BLOCKS = 12;
// Session ceiling on plan blocks. `planRetries` resets whenever the plan key
// changes, and Claude Code reuses one plan file path across re-plans within a
// session, so re-planning alone used to buy a fresh round of MAX_RETRIES blocks.
const MAX_PLAN_BLOCKS = 3;

function planDebug(msg) {
  try { appendCapped(PLAN_DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ok */ }
}

/**
 * Soft-cleanup a pending-remember flag file.
 * Resets enforcement fields (editCount, retries, files) while preserving
 * session-wide tracking (messageCount, greetingDelivered, etc.) to prevent
 * the greeting from re-firing mid-session.
 */
function softCleanupFlag(flagPath) {
  try {
    if (!existsSync(flagPath)) return;
    const flag = JSON.parse(readFileSync(flagPath, 'utf-8'));

    const cleaned = {
      editCount: 0,
      retries: 0,
      taskBlockTotal: 0,
      files: [],
      messageCount: flag.messageCount || 0,
      totalSessionMessages: flag.totalSessionMessages || 0,
      totalEdits: flag.totalEdits || 0,
      greetingDelivered: flag.greetingDelivered || false,
      categoryTreeInjected: flag.categoryTreeInjected || false,
      rememberCount: flag.rememberCount || 0,
      planRetries: flag.planRetries || 0,
      planBlockTotal: flag.planBlockTotal || 0,
      planKey: flag.planKey || null,
      autoStoreTriggered: flag.autoStoreTriggered || false,
      firstMessageAt: flag.firstMessageAt,
      lastMessageAt: flag.lastMessageAt,
      userLearningNudgeCount: flag.userLearningNudgeCount || 0,
      userLearningPending: false,
      userLearningRetries: 0,
      userLearningObserved: flag.userLearningObserved || false,
      // Every field added to the flag must be listed here or it is dropped.
      userLearningLastNudgeAt: Number.isFinite(flag.userLearningLastNudgeAt) ? flag.userLearningLastNudgeAt : undefined,
      staleShown: Array.isArray(flag.staleShown) ? flag.staleShown.slice(-50) : [],
      claimBlockedPromptId: flag.claimBlockedPromptId || null,
      noticedFiles: flag.noticedFiles && typeof flag.noticedFiles === 'object' && !Array.isArray(flag.noticedFiles) ? flag.noticedFiles : {},
      // A Stop completed after whatever edits the flag held (task-boundary fallback).
      lastStopAt: new Date().toISOString(),
    };

    writeJsonAtomic(flagPath, cleaned);
  } catch {
    // If we can't clean up gracefully, leave the file as-is
    // (better than deleting and resetting greeting tracking)
  }
}

/**
 * Session-scoped lookup for an unstored plan.
 *
 * Reads THIS session's transcript, takes the LAST ExitPlanMode tool_use, and
 * returns its authoritative plan ({ basename, content, title }). Returns null
 * when the session never exited plan mode, when the transcript can't be
 * resolved, or when the plan is already in stored-plans.json.
 *
 * This replaces the old mtime scan of the shared global ~/.claude/plans/
 * directory, which was session-blind and would grab a concurrent session's
 * freshly-written plan (the cross-session leak). Sourcing the plan from the
 * session's own ExitPlanMode payload makes selection session-accurate by
 * construction; if the transcript can't be read we skip (never fall back to
 * mtime — that is the bug we're removing).
 */
function getUnstoredSessionPlan({ transcriptPath, sessionId, cwd }) {
  try {
    const resolved = resolveTranscriptPath(transcriptPath, sessionId, cwd);
    if (!resolved) {
      planDebug(`stop: no transcript for session ${sessionId} — skipping plan check`);
      return null;
    }

    const exitPlan = readLastExitPlanMode(resolved);
    if (!exitPlan) return null; // session never exited plan mode → nothing to store

    const content = exitPlan.plan || '';
    if (!content.trim()) return null;

    // Display name only. It used to be the dedup key, which is precisely why
    // this check was broken: Claude Code names its file <slug>-<random>.md while
    // post-plan.mjs names its copy after the plan's title, so the two basenames
    // could never collide and post-plan's receipt was invisible here.
    let base = '';
    if (exitPlan.planFilePath) base = basename(exitPlan.planFilePath);
    else if (exitPlan.slug) base = `${exitPlan.slug}.md`;
    if (!base) return null;

    let stored = {};
    try {
      if (existsSync(STORED_PLANS_PATH)) {
        stored = JSON.parse(readFileSync(STORED_PLANS_PATH, 'utf-8'));
      }
    } catch { /* ok */ }
    const project = detectProject(cwd);
    const sourcePath = planSourcePath(exitPlan, content) || join(cwd || DATA_DIR, base);
    // Content-addressed, so post-plan.mjs computes the identical key from the
    // same plan text without either hook agreeing on a path.
    const key = planMemoryKey(project, content);
    // The database is authoritative; the receipt file is only a fallback for when
    // it can't be opened. The basename alias stays strict — Claude Code reuses one
    // path across re-plans, so a stale basename must not suppress a new plan.
    if (planStoredInDb(project, content)
      || planReceiptMatches(stored[key], project, content, { strict: false })
      || planReceiptMatches(stored[base], project, content)) {
      planDebug(`stop: plan ${base} already stored — skipping (session ${sessionId})`);
      return null;
    }

    const title = (content.match(/^#\s+(.+)$/m) || [])[1] || base;
    return { basename: base, content, title, key, sourcePath };
  } catch {
    return null;
  }
}

/**
 * A readable file holding this plan, for the plan-memory demand to point at:
 * the file ExitPlanMode named, else the one the CLI reported, else SynaBun's
 * copy (the Neural Interface writes one before its approval card; post-plan.mjs
 * after approval), else a copy written now. A named file counts only while it
 * holds this plan: Claude Code reuses one plan file per session, so it may
 * still hold an earlier plan (or another one entirely). Never a path that does
 * not exist: the assistant brain's plan mode refuses writing ~/.claude/plans/,
 * so its plan lives only in ExitPlanMode's input. '' when nothing could be written.
 */
function planSourcePath(exitPlan, content) {
  const holds = (path) => { try { return !!path && readFileSync(path, 'utf-8').trim() === content.trim(); } catch { return false; } };
  if (holds(exitPlan.planFilePath)) return exitPlan.planFilePath;
  if (holds(exitPlan.resultFilePath)) return exitPlan.resultFilePath;
  // Named like the Neural Interface's writePlanFile names its copy.
  const title = ((content.match(/^#\s+(.+)$/m) || [])[1] || content.split('\n').find((l) => l.trim()) || '').trim();
  const slug = title.toLowerCase().replace(/^plan[:\s]+/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
  const d = new Date();
  const dir = join(DATA_DIR, 'plans', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  for (let n = 1; n <= 20; n++) {
    const path = join(dir, n === 1 ? `${slug}.md` : `${slug}-${n}.md`);
    if (holds(path)) return path;
    if (existsSync(path)) continue;
    try { mkdirSync(dir, { recursive: true }); writeFileSync(path, content, 'utf-8'); return path; } catch { return ''; }
  }
  return '';
}

/**
 * Detect if the agent's last message indicates it's waiting for human action
 * in the browser (login, CAPTCHA, 2FA, etc.). Used to pause the loop instead
 * of advancing to the next iteration.
 */
function isHumanBlocker(msg, judged = {}) {
  if (!msg) return false;
  if (typeof judged.humanBlocker === 'boolean') return judged.humanBlocker;
  const blockerPhrases = [
    'login', 'log in', 'sign in', 'signin',
    'captcha', 'recaptcha',
    'authentication', 'authenticate',
    '2fa', 'two-factor', 'two factor', 'verification code',
    'waiting for your', 'waiting for you',
    'browser panel',
    'human action', 'manual action',
    'please log', 'need to log', 'need to sign',
    'requires login', 'requires authentication',
    'login wall', 'login page',
    'blocked by', 'access denied',
  ];
  // Must match at least one blocker phrase AND a "waiting/stop" signal
  const hasBlocker = blockerPhrases.some(p => msg.includes(p));
  const hasWaitSignal = ['wait', 'stop', 'pause', 'cannot', 'can\'t', 'unable', 'need to', 'requires', 'please', 'blocked'].some(w => msg.includes(w));
  return hasBlocker && hasWaitSignal;
}

/**
 * Detect if the agent's last message indicates it's waiting for ANY user action
 * (file upload, selection, login, CAPTCHA, etc.). Used to suppress soft obligations
 * (user learning, conversation turns) that would interrupt interactive flows.
 */
function isWaitingForUser(msg, judged = {}) {
  if (!msg) return false;
  if (typeof judged.waitingForUser === 'boolean') return judged.waitingForUser;
  const phrases = [
    // Interactive flow pauses
    'attach', 'upload', 'provide', 'select continue',
    'when ready', 'when you\'re ready', 'once you',
    'let me know', 'your turn',
    'waiting for you', 'waiting for your',
    // Human blockers (login, CAPTCHA, 2FA)
    'login', 'log in', 'sign in', 'signin',
    'captcha', 'recaptcha',
    'authentication', 'authenticate',
    '2fa', 'two-factor', 'two factor', 'verification code',
    'browser panel',
    'human action', 'manual action',
    'please log', 'need to log', 'need to sign',
    'requires login', 'requires authentication',
    'login wall', 'login page',
    'blocked by', 'access denied',
  ];
  return phrases.some(p => msg.includes(p));
}

function readStdin() {
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

/**
 * Check a pending flag and return a block decision if needed.
 * Returns { shouldBlock, reason } or null if no action needed.
 */
function checkFlag(flagPath, buildReason) {
  if (!existsSync(flagPath)) return null;

  let flag;
  try {
    flag = JSON.parse(readFileSync(flagPath, 'utf-8'));
  } catch {
    // Corrupt flag → delete and skip
    try { unlinkSync(flagPath); } catch { /* ok */ }
    return null;
  }

  const retries = flag.retries || 0;

  // Safety valve: max retries reached → give up
  if (retries >= MAX_RETRIES) {
    try { unlinkSync(flagPath); } catch { /* ok */ }
    return null;
  }

  // Increment retry counter
  flag.retries = retries + 1;
  try {
    writeJsonAtomic(flagPath, flag);
  } catch { /* ok */ }

  return {
    shouldBlock: true,
    reason: buildReason(flag, retries + 1),
  };
}

async function main() {
  // Stop has 3 s. Node startup counts against it.
  const budget = hookBudget(3000);
  let sessionId = '';
  let rawMessage = '';
  let cwd = '';
  let transcriptPath = '';
  let stopHookActive = false;
  let promptId = '';
  let permissionMode = '';
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    sessionId = input.session_id || '';
    // The phrase lists need lowercase; the judgment wants the message as written.
    rawMessage = String(input.last_assistant_message || '');
    cwd = input.cwd || '';
    transcriptPath = input.transcript_path || '';
    stopHookActive = input.stop_hook_active === true;
    promptId = typeof input.prompt_id === 'string' ? input.prompt_id : '';
    permissionMode = typeof input.permission_mode === 'string' ? input.permission_mode : '';
  } catch { /* proceed */ }

  // A temporary chat (see isTemporaryChat) owes no memory: it stops when it
  // stops, and nothing about the turn is judged, flagged or written.
  if (isTemporaryChat()) { process.stdout.write(JSON.stringify({})); return; }

  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Judged before the lock is taken: a round trip must not hold state that
  // other hooks are waiting on. {} whenever unavailable, and every reader
  // below falls back to its phrase list or counter.
  //   stop-turn: human blocker, waiting on user, whether the turn's edits (or,
  //   with no edits, its shell work) are worth a memory, whether the final
  //   message claims a result the turn's output does not show, and any
  //   edit-time stale verdicts for this session (peek only).
  //   loop-goal: whether a hook-driven loop's task is already complete.
  // Native and exec loops are not judged at all: their runtimes own the
  // iteration and the answer was always thrown away.
  const loopPeek = peekLoop(sessionId);
  const runtimeLoop = loopPeek.kind === 'native' || loopPeek.kind === 'exec';
  let judged = {};
  let activity = null;
  let promptKey = promptId;
  if (!runtimeLoop) {
    const resolved = resolveTranscriptPath(transcriptPath, sessionId, cwd);
    if (!rawMessage && resolved) rawMessage = readLastAssistantText(resolved, 4000);
    if (!typesafeOff() && rawMessage.trim()) {
      activity = readTurnActivity(resolved);
      promptKey = promptId || activity.prompt_id || '';
      const pending = peekPendingRemember(sessionId);
      const project = detectProject(cwd);
      // Not in the assistant brain: a relayed worker "tests pass" has its evidence in the worker's turn (worker-claim checks it there).
      const askClaim = !stopHookActive && loopPeek.kind !== 'hook' && !!promptKey
        && pending.claimBlockedPromptId !== promptKey && rawMessage.trim().length >= 40 && !process.env.SYNABUN_ASSISTANT_SESSION;
      const callMs = Math.min(2000, budget.callTimeout(200));
      const goalState = loopPeek.kind === 'hook' ? hookLoopGoalState(loopPeek.loop) : null;
      // The server refuses text over 16000 characters: keep head and tail.
      const message = clipForJudge(rawMessage);
      const [turn, goal] = await Promise.all([
        judgeText('stop-turn', message, { timeoutMs: callMs, extra: {
          files: pending.files, edit_count: pending.editCount,
          bash_commands: activity.bash_commands, tool_results: activity.tool_results,
          ask: { unsupported_claim: askClaim }, want_stale: true,
          session_id: sessionId, cwd: cwd || undefined, project,
        } }),
        goalState
          ? judgeText('loop-goal', message, { timeoutMs: callMs, extra: { ...goalState, session_id: sessionId, cwd: cwd || undefined, project } })
          : Promise.resolve({}),
      ]);
      judged = { ...turn };
      // Only an answer to a question this Stop asked counts.
      if (!askClaim) delete judged.unsupportedClaim;
      if (typeof goal.goalMet === 'boolean') { judged.goalMet = goal.goalMet; judged.goalProbability = goal.goalProbability; }
    }
  }

  const lockMs = Math.max(100, Math.min(1500, budget.remaining() - 300));
  return withStateLock(() => handleStop({
    sessionId, lastMessage: rawMessage.toLowerCase(), cwd, transcriptPath, judged, activity, stopHookActive, promptKey, permissionMode,
  }), { timeoutMs: lockMs });
}

function handleStop({ sessionId, lastMessage, cwd, transcriptPath, judged = {}, activity = null, stopHookActive = false, promptKey = '', permissionMode = '' }) {
  // ─── PRE-CHECK: Quick loop scan ───
  // Determine if a loop is active BEFORE checking compaction. Loops must NEVER
  // be blocked by compaction — it stalls iteration transitions and kills the loop.
  // We do a fast scan here; the full loop logic is below in CHECK 1.5.
  // When SYNABUN_TERMINAL_SESSION is set (server-launched loop), only count
  // loops owned by THIS terminal — prevents other automations from suppressing
  // compaction in unrelated sessions.
  const terminalSessionEnv = process.env.SYNABUN_TERMINAL_SESSION || '';
  appendLoopLog(terminalSessionEnv || null, 'stop:enter', 'Stop hook fired', { sessionId, hasEnv: !!terminalSessionEnv });
  let hasActiveLoop = false;
  try {
    if (existsSync(LOOP_DIR)) {
      const loopFiles = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json'));
      for (const f of loopFiles) {
        try {
          const candidate = JSON.parse(readFileSync(join(LOOP_DIR, f), 'utf-8'));
          if (candidate.active && (candidate.currentIteration || 0) > 0) {
            // STRICT isolation. Before: `terminalSessionEnv &&` gated the
            // mismatch check, so a session with no env would pick up ANY
            // loop and wrongly suppress its own compaction. Now:
            //   - env set → require exact terminalSessionId match
            //   - env unset → only count loops WITHOUT terminalSessionId
            if (terminalSessionEnv) {
              if (candidate.terminalSessionId !== terminalSessionEnv) continue;
            } else {
              if (candidate.terminalSessionId) continue;
            }
            hasActiveLoop = true;
            break;
          }
        } catch { continue; }
      }
    }
  } catch { /* ok */ }

  // ─── CHECK 1: Pending compact ───
  // SKIP compaction when a loop is active — compaction blocks iteration transitions
  // and causes the loop to stall. The compact flag will be handled after the loop ends.
  const DEBUG_LOG = join(DATA_DIR, 'compact-debug.log');
  let compactFlagPath = null;

  if (!hasActiveLoop) {
    const ownedFlag = join(PENDING_COMPACT_DIR, `${sessionId}.json`);
    if (existsSync(ownedFlag)) compactFlagPath = ownedFlag;

    try {
      appendCapped(DEBUG_LOG, `[${new Date().toISOString()}] STOP session_id=${sessionId} compactFlagPath=${compactFlagPath}\n`);
    } catch { /* ok */ }

    if (compactFlagPath) {
      const compactResult = checkFlag(
        compactFlagPath,
        (flag, attempt) =>
          `SynaBun: Session compacted but not indexed yet — call remember in category 'conversations'${flag.generation ? ` with source_ref ${JSON.stringify(compactionSourceRef(sessionId, flag.generation))}` : ''}. (${attempt}/${MAX_RETRIES})`
      );

      if (compactResult?.shouldBlock) {
        try {
          appendCapped(DEBUG_LOG, `[${new Date().toISOString()}] STOP BLOCKING session_id=${sessionId} reason=${compactResult.reason}\n`);
        } catch { /* ok */ }
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: compactResult.reason,
        }));
        return;
      }
    }
  } else {
    try {
      appendCapped(DEBUG_LOG, `[${new Date().toISOString()}] STOP session_id=${sessionId} SKIPPING compaction (active loop)\n`);
    } catch { /* ok */ }
    // Keep the originating session's obligation for after the loop. Never
    // consume another session's pending compaction.

  }

  // ─── CHECK 1.5: Active loop ───
  // Native loops keep their state at {runId}.json for the server-owned runtime.
  // Return before the legacy /clear ownership scan can rename that file to the
  // Claude session ID and make the runtime believe its state was deleted.
  if (terminalSessionEnv) {
    try {
      const nativePath = join(LOOP_DIR, `${terminalSessionEnv}.json`);
      if (existsSync(nativePath)) {
        const nativeLoop = JSON.parse(readFileSync(nativePath, 'utf-8'));
        if (nativeLoop?.active && nativeLoop.driverType === 'native'
          && nativeLoop.terminalSessionId === terminalSessionEnv) {
          appendLoopLog(terminalSessionEnv, 'stop:native', 'leaving iteration transition to native runtime', {
            sessionId,
            currentIteration: nativeLoop.currentIteration || 0,
          });
          process.stdout.write(JSON.stringify({}));
          return;
        }
      }
    } catch { /* fall through to legacy ownership scan */ }
  }

  // Deactivate stale loops first (session died, terminal closed, time expired)
  cleanupStaleLoops(LOOP_DIR);
  // After /clear, session ID may change. Try exact match first, then scan for any active loop.
  let loopFlagPath = join(LOOP_DIR, `${sessionId}.json`);
  let loop = null;

  if (existsSync(loopFlagPath)) {
    try {
      loop = JSON.parse(readFileSync(loopFlagPath, 'utf-8'));
      if (loop?.active) {
        writeActivePointer(sessionId, loop.terminalSessionId || terminalSessionEnv, sessionId);
      }
    } catch {
      try { unlinkSync(loopFlagPath); } catch { /* ok */ }
    }
  }

  // Fallback scan — two strategies depending on whether we know our terminal ID.
  //
  // Strategy A (SYNABUN_TERMINAL_SESSION set — server-launched loop):
  //   Match by terminalSessionId field. This is safe for ANY currentIteration
  //   because the env var proves ownership. Rename the file to {sessionId}.json
  //   so future stop-hook calls get an exact match.
  //
  // Strategy B (no env var — manual/legacy loop):
  //   ONLY match unclaimed loops (currentIteration === 0, no terminalSessionId).
  //   Running loops (currentIteration > 0) are NOT picked up here to prevent
  //   cross-session leaks when multiple Claude panels are open simultaneously.
  if (!loop) {
    try {
      const allFiles = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json') && !f.startsWith('pending-'));
      const now = Date.now();
      for (const f of allFiles) {
        const fp = join(LOOP_DIR, f);
        try {
          const candidate = JSON.parse(readFileSync(fp, 'utf-8'));
          if (!candidate.active) continue;
          // Skip loops inactive for >45 minutes (stuck, not time-capped)
          const lastAct = new Date(candidate.lastIterationAt || candidate.startedAt || 0).getTime();
          if (now - lastAct > 45 * 60 * 1000) continue;

          // Strategy A: env-based ownership proof — safe for any iteration
          if (terminalSessionEnv && candidate.terminalSessionId === terminalSessionEnv) {
            loop = candidate;
            const newPath = join(LOOP_DIR, `${sessionId}.json`);
            if (fp !== newPath) {
              try {
                renameSync(fp, newPath);
                loopFlagPath = newPath;
                appendLoopLog(terminalSessionEnv, 'stop:claim', 'matched loop via Strategy A (env), renamed', { from: f, to: `${sessionId}.json`, currentIteration: candidate.currentIteration });
              } catch (err) {
                loopFlagPath = fp;
                appendLoopLog(terminalSessionEnv, 'stop:claim', 'matched loop via Strategy A (env), rename FAILED', { from: f, err: err.message });
              }
            } else {
              loopFlagPath = fp;
              appendLoopLog(terminalSessionEnv, 'stop:claim', 'matched loop via Strategy A (env), already named correctly', { file: f, currentIteration: candidate.currentIteration });
            }
            writeActivePointer(sessionId, terminalSessionEnv, sessionId);
            break;
          }

          // Strategy B: legacy — only unclaimed iteration-0 loops without terminalSessionId
          if (!terminalSessionEnv && candidate.currentIteration === 0 && !candidate.terminalSessionId) {
            loop = candidate;
            const newPath = join(LOOP_DIR, `${sessionId}.json`);
            if (fp !== newPath) {
              try { renameSync(fp, newPath); loopFlagPath = newPath; } catch { loopFlagPath = fp; }
            } else {
              loopFlagPath = fp;
            }
            writeActivePointer(sessionId, candidate.terminalSessionId || null, sessionId);
            break;
          }
        } catch { continue; }
      }
    } catch { /* ok */ }
  }

  // Skip server-driven exec/native loops. Their runtimes own iteration transitions.
  if (loop?.active && (loop.driverType === 'exec' || loop.driverType === 'native')) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  if (loop?.active) {
    const iterationsDone = loop.currentIteration || 0;
    const totalIterations = loop.totalIterations || 10;

    if (judged.goalMet === true && iterationsDone > 0) {
      // The task was judged complete from the journal and the last message:
      // end now instead of spending the rest of the iteration budget. The
      // budget stays the fallback whenever the judgment is unavailable.
      appendLoopLog(loop.terminalSessionId || terminalSessionEnv, 'stop:goal-met', 'loop ended early: task judged complete', { iteration: iterationsDone, total: totalIterations, probability: judged.goalProbability });
      try { unlinkSync(loopFlagPath); } catch { /* ok */ }
      clearActivePointer();
      // Fall through to remember/conversation checks
    } else if (iterationsDone >= totalIterations) {
    // Check cap — iteration limit only (time cap removed; inactivity catches stuck loops)
      // Loop finished — delete the file (no history keeping)
      try { unlinkSync(loopFlagPath); } catch { /* ok */ }
      clearActivePointer();
      // Fall through to remember/conversation checks
    } else if (loop.memoryPending && (loop.memoryRetries || 0) < MAX_RETRIES) {
      // Memory enforcement: block until Claude stores progress in memory
      loop.memoryRetries = (loop.memoryRetries || 0) + 1;
      try { writeJsonAtomic(loopFlagPath, loop); } catch { /* ok */ }

      const reason = [
        `SynaBun Loop: Memory checkpoint required (iteration ${iterationsDone}/${totalIterations}).`,
        `You've completed ${iterationsDone - (loop.lastMemoryAt || 0)} iterations since your last memory save.`,
        `Call \`remember\` with progress from iterations ${(loop.lastMemoryAt || 0) + 1}-${iterationsDone}.`,
        `Include: what was accomplished, accounts/targets engaged, key findings, strategies that worked.`,
        `Category: use the task's appropriate category or "social-interactions". Importance: 4-5 for a routine progress log; 6-7 only for a finding, a decision, or a change of strategy. Tags: ["loop", "progress"].`,
        `Then the loop will continue automatically.`,
      ].join('\n');

      process.stdout.write(JSON.stringify({ decision: 'block', reason }));
      return;
    } else if (loop.usesBrowser && isHumanBlocker(lastMessage, judged)) {
      // Agent is waiting for human action (login, CAPTCHA, etc.) — pause loop
      process.stdout.write(JSON.stringify({}));
      return;
    } else if (loop.usesBrowser && iterationsDone > 0) {
      // Browser loop: enforce journal update before advancing so next iteration
      // has context of what was accomplished (critical after /clear resets context)
      const lastJournalIter = Array.isArray(loop.journal) && loop.journal.length > 0
        ? loop.journal[loop.journal.length - 1].iteration
        : 0;
      const loopUpdateRetries = loop.loopUpdateRetries || 0;
      if (lastJournalIter < iterationsDone && loopUpdateRetries < MAX_RETRIES) {
        loop.loopUpdateRetries = loopUpdateRetries + 1;
        try { writeJsonAtomic(loopFlagPath, loop); } catch { /* ok */ }
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: `SynaBun Loop: Before this iteration ends, call \`loop\` action \`update\` with a brief summary of what you accomplished (e.g. which groups were posted, which platforms covered, what's left to do). This preserves context for the next iteration after /clear. Then stop — the loop will advance automatically.`,
        }));
        return;
      }
      // Reset loopUpdateRetries for next iteration
      loop.loopUpdateRetries = 0;
      // Fresh-context iteration: let Claude stop, server drives next via /clear
      loop.currentIteration = iterationsDone + 1;
      loop.lastIterationAt = new Date().toISOString();
      loop.retries = 0;

      // Memory enforcement check — browser loops get a higher default interval
      // to avoid blocking mid-task at unpredictable points
      const memoryInterval = loop.usesBrowser
        ? (loop.memoryInterval || 15)
        : (loop.memoryInterval || 5);
      const iterationsSinceMemory = loop.currentIteration - (loop.lastMemoryAt || 0);
      if (iterationsSinceMemory >= memoryInterval) {
        loop.memoryPending = true;
        loop.memoryRetries = 0;
      }

      // Signal server loop driver to send /clear + next iteration prompt
      loop.awaitingNext = true;
      try {
        writeJsonAtomic(loopFlagPath, loop);
        appendLoopLog(loop.terminalSessionId || terminalSessionEnv, 'stop:awaitingNext', 'set awaitingNext=true', { iter: loop.currentIteration, total: loop.totalIterations, file: loopFlagPath });
      } catch (err) {
        appendLoopLog(loop.terminalSessionId || terminalSessionEnv, 'stop:awaitingNext', 'write FAILED', { err: err.message });
      }

      // Reset edit tracking for fresh iteration context
      const rememberFlagForReset = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
      if (existsSync(rememberFlagForReset)) {
        try { unlinkSync(rememberFlagForReset); } catch { /* ok */ }
      }

      // Allow stop — server loop driver will send /clear + next iteration message
      process.stdout.write(JSON.stringify({}));
      return;
    } else {
      // Non-browser loop (or iteration 0): advance normally
      loop.currentIteration = iterationsDone + 1;
      loop.lastIterationAt = new Date().toISOString();
      loop.retries = 0;

      const memoryInterval = loop.memoryInterval || 5;
      const iterationsSinceMemory = loop.currentIteration - (loop.lastMemoryAt || 0);
      if (iterationsSinceMemory >= memoryInterval) {
        loop.memoryPending = true;
        loop.memoryRetries = 0;
      }

      loop.awaitingNext = true;
      try {
        writeJsonAtomic(loopFlagPath, loop);
        appendLoopLog(loop.terminalSessionId || terminalSessionEnv, 'stop:awaitingNext', 'set awaitingNext=true', { iter: loop.currentIteration, total: loop.totalIterations, file: loopFlagPath });
      } catch (err) {
        appendLoopLog(loop.terminalSessionId || terminalSessionEnv, 'stop:awaitingNext', 'write FAILED', { err: err.message });
      }

      const rememberFlagForReset = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
      if (existsSync(rememberFlagForReset)) {
        try { unlinkSync(rememberFlagForReset); } catch { /* ok */ }
      }

      process.stdout.write(JSON.stringify({}));
      return;
    }
  }

  // ─── TASK-END OBLIGATIONS ───
  // Block for: unstored edits, unstored plans, and user learning (bundled).
  // User learning is bundled with task memory when both are pending (zero extra blocks),
  // or fires as a lightweight standalone block (1 retry) when only UL is pending.
  // Suppressed when Claude is waiting for user action (interactive flows).
  const obligations = [];
  const rememberFlagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
  let flag = null;
  const waitingForUser = isWaitingForUser(lastMessage, judged);

  // Resolve THIS session's unstored plan once — shared by CHECK 5 (bundled)
  // and the standalone plan check below, so the transcript is read at most once.
  // Not while the session is planning (plan mode refuses `remember`, so the
  // demand could not be met) nor on a Stop this hook already blocked (the
  // counters bring it back on a later turn): either way it would loop.
  const sessionPlan = stopHookActive || permissionMode === 'plan' ? null : getUnstoredSessionPlan({ transcriptPath, sessionId, cwd });

  if (existsSync(rememberFlagPath)) {
    try {
      flag = JSON.parse(readFileSync(rememberFlagPath, 'utf-8'));
    } catch {
      try { unlinkSync(rememberFlagPath); } catch { /* ok */ }
    }
  }

  // Shell work and claim checks can apply to a session whose flag was never
  // created (no prompt hook ran), like an unstored plan.
  const shellWork = unsavedShellWork(judged, activity);
  const claimJudged = judged.unsupportedClaim === true && !stopHookActive && !!promptKey;
  if (!flag && (sessionPlan || shellWork.length || claimJudged)) flag = {editCount:0,files:[],retries:0};
  if (sessionPlan && flag.planKey !== sessionPlan.key) {
    flag.planKey = sessionPlan.key;
    flag.planRetries = 0;
  }

  if (flag) {
    const editCount = flag.editCount || 0;
    const rememberCount = flag.rememberCount || 0;
    let taskObligation = null;

    // CHECK 2: Task remember (edits without memory entry). The raw edit count
    // says something changed; the judgment says whether it was work worth a
    // memory. A confident "trivial" (surface turn-worth) suppresses the nag;
    // no judgment keeps the old behaviour.
    if (editCount >= EDIT_THRESHOLD && judged.worthRemembering !== false) {
      const retries = flag.retries || 0;
      const taskBlockTotal = flag.taskBlockTotal || 0;
      if (retries < MAX_RETRIES && taskBlockTotal < MAX_TASK_BLOCKS) {
        flag.retries = retries + 1;
        flag.taskBlockTotal = taskBlockTotal + 1;
        const files = Array.isArray(flag.files) ? flag.files : [];
        const fileList = files.length > 0
          ? ` Files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}`
          : '';
        taskObligation = {
          type: 'task',
          short: `**Task memory**: unstored edits — call \`remember\` with what/why/how.${fileList}`,
          verbose: `SynaBun: Unstored file edits — call \`remember\` before finishing.${fileList}`,
        };
        obligations.push(taskObligation);
      }
    }

    // CHECK 2b: A Bash-only turn. No file edits, but shell commands that
    // changed something ran after the last memory write, and Jev judged the
    // work worth a memory (turn-worth.bashOnlyMinProbability). Same retry
    // counters as CHECK 2. A memory written after all of it clears it.
    if (editCount === 0 && shellWork.length) {
      const retries = flag.retries || 0;
      const taskBlockTotal = flag.taskBlockTotal || 0;
      if (retries < MAX_RETRIES && taskBlockTotal < MAX_TASK_BLOCKS) {
        flag.retries = retries + 1;
        flag.taskBlockTotal = taskBlockTotal + 1;
        const names = shellWork.slice(-3).map((c) => `\`${clipCommand(c.command)}\``).join(', ');
        taskObligation = {
          type: 'task',
          short: `**Task memory**: shell work not stored (${names}) — call \`remember\` with what/why/how.`,
          verbose: `SynaBun [Jev]: this turn changed things from the shell and none of it is in memory yet: ${names}. Call \`remember\` with what was done, why, and how before finishing.`,
        };
        obligations.push(taskObligation);
      }
    }

    // Stale-memory verdicts (edit-time checks) join the unstored-work reason:
    // never a block of their own. The ids shown are recorded so the next
    // prompt acknowledges them instead of showing them again.
    if (taskObligation && Array.isArray(judged.stale)) {
      const shown = new Set(Array.isArray(flag.staleShown) ? flag.staleShown : []);
      const fresh = judged.stale.filter((v) => v && typeof v.memory_id === 'string' && !shown.has(v.memory_id)).slice(0, 3);
      if (fresh.length) {
        taskObligation.verbose += `\n\n${formatStaleNotices(fresh)}`;
        taskObligation.short += ` Also check possibly stale memories ${fresh.map((v) => `[${v.memory_id}]`).join(', ')} (\`reflect\` or \`forget\`).`;
        flag.staleShown = [...shown, ...fresh.map((v) => v.memory_id)].slice(-50);
      }
    }

    // CHECK 2.5: User learning (bundled with task or standalone)
    // Skipped when waiting for user action (interactive flows like Leonardo questionnaires).
    // Limited to 1 retry to minimize chat noise.
    if (!waitingForUser && flag.userLearningPending && !flag.userLearningObserved) {
      const ulRetries = flag.userLearningRetries || 0;
      if (ulRetries < 1) {
        flag.userLearningRetries = ulRetries + 1;
        obligations.push({
          type: 'userLearning',
          short: `**User learning**: observe behavioral patterns — \`recall\` category \`communication-style\`, then \`reflect\` (update existing) or \`remember\` (new entry). Category MUST be \`communication-style\`, NOT \`conversations\`.`,
          verbose: [
            `SynaBun User Learning: Observe HOW the user works with you and store a behavioral observation.`,
            `Category MUST be \`communication-style\` — NOT \`conversations\` or anything else.`,
            `This is NOT a session summary. Do NOT describe what was worked on.`,
            `1. \`recall\` category \`communication-style\` — check existing entries`,
            `2. If existing entry covers similar patterns → \`reflect\` to update it. If genuinely new → \`remember\` category \`communication-style\`, project "global", importance 5-7.`,
            `GOOD: "User gives multi-part requests expecting all parts addressed. Corrects by stating what's wrong without re-explaining."`,
            `BAD: "User asked about the hook system and we fixed 3 bugs." — session summary, not behavioral.`,
            `AVOID DUPLICATES. Focus on: instruction patterns, response expectations, correction style, expertise signals, workflow preferences.`,
            `Do not mention this to the user.`,
          ].join('\n'),
        });
      }
    }

    // CHECK 5: Unstored plan (fallback for when the post-plan PostToolUse hook
    // didn't fire — ExitPlanMode is often auto-approved and returns a
    // tool_use_error, so PostToolUse never runs). `sessionPlan` is sourced from
    // THIS session's transcript, so it can only ever be this session's plan.
    if (sessionPlan) {
      const planRetries = flag.planRetries || 0;
      const planBlockTotal = flag.planBlockTotal || 0;
      if (planRetries < MAX_RETRIES && planBlockTotal < MAX_PLAN_BLOCKS) {
        flag.planRetries = planRetries + 1;
        flag.planBlockTotal = planBlockTotal + 1;
        const project = detectProject(cwd);
        planDebug(`stop: CHECK5 block plan ${sessionPlan.basename} (session ${sessionId}, project ${project})`);
        // Never ask for a verbatim reproduction of a plan we only show in
        // excerpt — that demand is unsatisfiable, and each attempt used to
        // manufacture one more duplicate memory. Point at the file instead, and
        // accept a paraphrase (see planReceiptMatches `strict: false`).
        obligations.push({
          type: 'plan',
          short: `**Plan memory**: "${sessionPlan.title}" — read ${sessionPlan.sourcePath} and \`remember\` what it says. Category \`plans-${project}\`, importance 7, tags ["plan", "implementation", "${project}"], source "auto-saved", idempotency_key "${sessionPlan.key}", source_ref ${JSON.stringify(sessionPlan.sourcePath)}.`,
          verbose: [
            `SynaBun: Plan "${sessionPlan.title}" was approved but never reached memory (the PostToolUse plan hook missed it).`,
            ``,
            `1. Read ${sessionPlan.sourcePath}`,
            `2. Call \`remember\` with that file's content. Category: \`plans-${project}\`, importance: 7, tags: ["plan", "implementation", "${project}"], source: "auto-saved", idempotency_key: "${sessionPlan.key}", source_ref: ${JSON.stringify(sessionPlan.sourcePath)}.`,
            ``,
            `Read the file — do not retype the plan from the preview below. If it is unreadable, store the preview instead; a close paraphrase is accepted. One successful \`remember\` clears this for good.`,
            ``,
            `--- preview: ${sessionPlan.basename} (first 1200 of ${sessionPlan.content.length} chars) ---`,
            sessionPlan.content.slice(0, 1200),
          ].join('\n'),
        });
      }
    }

    // CHECK 6: A claim the turn's output does not support ("tests pass", "the
    // fix works", "verified") — Jev at claim-check.minProbability. One block
    // per prompt, never on a stop-hook continuation, never while waiting for
    // the user. The reason names what the transcript shows.
    if (claimJudged && !waitingForUser && flag.claimBlockedPromptId !== promptKey) {
      flag.claimBlockedPromptId = promptKey;
      const evidence = claimEvidence(activity);
      obligations.push({
        type: 'claim',
        short: `**Unverified result**: ${evidence} — run the check and report its actual output, or say plainly that it is unverified.`,
        verbose: `SynaBun [Jev] claim check: your final message reports a result (tests passing, a fix working, something verified) that this turn's output does not support: ${evidence}. Run the check now and report its actual output, or say plainly that the result is unverified. This check blocks once per prompt.`,
      });
    }

    flag.lastStopAt = new Date().toISOString();

    // Write flag once after all checks (single write instead of per-check writes)
    try { writeJsonAtomic(rememberFlagPath, flag); } catch { /* ok */ }

    // ─── Emit combined block or soft cleanup ───
    if (obligations.length > 0) {
      let reason;
      if (obligations.length === 1) {
        reason = obligations[0].verbose;
      } else {
        const items = obligations.map((o, i) => `${i + 1}. ${o.short}`).join('\n');
        reason = `SynaBun: Complete before stopping:\n\n${items}`;
      }
      process.stdout.write(JSON.stringify({ decision: 'block', reason }));
      return;
    }

    // No blocking conditions → soft cleanup and allow stop
    softCleanupFlag(rememberFlagPath);
  }

  // No flags, no unstored plans → allow stop
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
