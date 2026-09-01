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
 * 2. TASK MEMORY — If 3+ file edits have occurred without a `remember`
 *    call, blocks Claude to store the work. Also catches unstored plans.
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

import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStaleLoops, detectProject, DATA_DIR, appendLoopLog, appendCapped, resolveTranscriptPath, readLastExitPlanMode } from './shared.mjs';

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
    writeFileSync(ACTIVE_POINTER_PATH, JSON.stringify(payload, null, 2));
  } catch { /* ok */ }
}

function clearActivePointer() {
  try { if (existsSync(ACTIVE_POINTER_PATH)) unlinkSync(ACTIVE_POINTER_PATH); } catch { /* ok */ }
}
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
const STORED_PLANS_PATH = join(DATA_DIR, 'stored-plans.json');
const PLAN_DEBUG_LOG = join(DATA_DIR, 'plan-debug.log');
const MAX_RETRIES = 3;
const EDIT_THRESHOLD = 1;
// Session ceiling on task-memory blocks. `retries` resets whenever a new edit
// segment starts (post-remember.mjs), so it alone can no longer bound the
// block↔respond cycle. `stop_hook_active` is not honored by this hook, so this
// is the only backstop against an agent that edits-then-stops forever.
const MAX_TASK_BLOCKS = 12;

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
      rememberCount: flag.rememberCount || 0,
      autoStoreTriggered: flag.autoStoreTriggered || false,
      firstMessageAt: flag.firstMessageAt,
      lastMessageAt: flag.lastMessageAt,
      userLearningNudgeCount: flag.userLearningNudgeCount || 0,
      userLearningPending: false,
      userLearningRetries: 0,
      userLearningObserved: flag.userLearningObserved || false,
    };

    writeFileSync(flagPath, JSON.stringify(cleaned));
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

    const content = (exitPlan.plan || '').trim();
    if (!content) return null;

    // Dedup key: basename(planFilePath), falling back to <slug>.md for older
    // Claude Code builds that omit planFilePath. Both post-plan.mjs and this
    // hook key stored-plans.json by the same basename so dedup is reliable.
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
    if (stored[base]) {
      planDebug(`stop: plan ${base} already stored — skipping (session ${sessionId})`);
      return null;
    }

    const title = (content.match(/^#\s+(.+)$/m) || [])[1] || base;
    return { basename: base, content, title };
  } catch {
    return null;
  }
}

/**
 * Mark a plan file as stored in the dedup tracker so it's not re-triggered.
 */
function markPlanStored(fileName) {
  try {
    let stored = {};
    if (existsSync(STORED_PLANS_PATH)) {
      stored = JSON.parse(readFileSync(STORED_PLANS_PATH, 'utf-8'));
    }
    stored[fileName] = { memoryId: 'pending-remember', storedAt: new Date().toISOString() };
    writeFileSync(STORED_PLANS_PATH, JSON.stringify(stored, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

/**
 * Detect if the agent's last message indicates it's waiting for human action
 * in the browser (login, CAPTCHA, 2FA, etc.). Used to pause the loop instead
 * of advancing to the next iteration.
 */
function isHumanBlocker(msg) {
  if (!msg) return false;
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
function isWaitingForUser(msg) {
  if (!msg) return false;
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
    writeFileSync(flagPath, JSON.stringify(flag));
  } catch { /* ok */ }

  return {
    shouldBlock: true,
    reason: buildReason(flag, retries + 1),
  };
}

async function main() {
  let sessionId = '';
  let lastMessage = '';
  let cwd = '';
  let transcriptPath = '';
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    sessionId = input.session_id || '';
    lastMessage = (input.last_assistant_message || '').toLowerCase();
    cwd = input.cwd || '';
    transcriptPath = input.transcript_path || '';
  } catch { /* proceed */ }

  if (!sessionId) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

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
    try {
      if (existsSync(PENDING_COMPACT_DIR)) {
        const files = readdirSync(PENDING_COMPACT_DIR)
          .filter(f => f.endsWith('.json') && !f.startsWith('test-'));
        if (files.length > 0) {
          let newest = null;
          let newestTime = 0;
          for (const f of files) {
            const fp = join(PENDING_COMPACT_DIR, f);
            try {
              const flag = JSON.parse(readFileSync(fp, 'utf-8'));
              const t = new Date(flag.created_at || 0).getTime();
              if (t > newestTime) { newestTime = t; newest = fp; }
            } catch { /* skip corrupt */ }
          }
          compactFlagPath = newest;
        }
      }
    } catch { /* ok */ }

    try {
      appendCapped(DEBUG_LOG, `[${new Date().toISOString()}] STOP session_id=${sessionId} compactFlagPath=${compactFlagPath}\n`);
    } catch { /* ok */ }

    if (compactFlagPath) {
      const compactResult = checkFlag(
        compactFlagPath,
        (_flag, attempt) =>
          `SynaBun: Session compacted but not indexed yet — log it in 'conversations' first. (${attempt}/${MAX_RETRIES})`
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
    // Also clean up any pending-compact flags — they'll never be handled during a loop
    // and would just accumulate. Delete them so they don't stall post-loop stops.
    try {
      if (existsSync(PENDING_COMPACT_DIR)) {
        const compactFiles = readdirSync(PENDING_COMPACT_DIR)
          .filter(f => f.endsWith('.json') && !f.startsWith('test-'));
        for (const cf of compactFiles) {
          try { unlinkSync(join(PENDING_COMPACT_DIR, cf)); } catch { /* ok */ }
        }
      }
    } catch { /* ok */ }
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

    // Check cap — iteration limit only (time cap removed; inactivity catches stuck loops)
    if (iterationsDone >= totalIterations) {
      // Loop finished — delete the file (no history keeping)
      try { unlinkSync(loopFlagPath); } catch { /* ok */ }
      clearActivePointer();
      // Fall through to remember/conversation checks
    } else if (loop.memoryPending && (loop.memoryRetries || 0) < MAX_RETRIES) {
      // Memory enforcement: block until Claude stores progress in memory
      loop.memoryRetries = (loop.memoryRetries || 0) + 1;
      try { writeFileSync(loopFlagPath, JSON.stringify(loop, null, 2)); } catch { /* ok */ }

      const reason = [
        `SynaBun Loop: Memory checkpoint required (iteration ${iterationsDone}/${totalIterations}).`,
        `You've completed ${iterationsDone - (loop.lastMemoryAt || 0)} iterations since your last memory save.`,
        `Call \`remember\` with progress from iterations ${(loop.lastMemoryAt || 0) + 1}-${iterationsDone}.`,
        `Include: what was accomplished, accounts/targets engaged, key findings, strategies that worked.`,
        `Category: use the task's appropriate category or "social-interactions". Importance: 6-7. Tags: ["loop", "progress"].`,
        `Then the loop will continue automatically.`,
      ].join('\n');

      process.stdout.write(JSON.stringify({ decision: 'block', reason }));
      return;
    } else if (loop.usesBrowser && isHumanBlocker(lastMessage)) {
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
        try { writeFileSync(loopFlagPath, JSON.stringify(loop, null, 2)); } catch { /* ok */ }
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
        writeFileSync(loopFlagPath, JSON.stringify(loop, null, 2));
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
        writeFileSync(loopFlagPath, JSON.stringify(loop, null, 2));
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
  const waitingForUser = isWaitingForUser(lastMessage);

  // Resolve THIS session's unstored plan once — shared by CHECK 5 (bundled)
  // and the standalone plan check below, so the transcript is read at most once.
  const sessionPlan = getUnstoredSessionPlan({ transcriptPath, sessionId, cwd });

  if (existsSync(rememberFlagPath)) {
    try {
      flag = JSON.parse(readFileSync(rememberFlagPath, 'utf-8'));
    } catch {
      try { unlinkSync(rememberFlagPath); } catch { /* ok */ }
    }
  }

  if (flag) {
    const editCount = flag.editCount || 0;
    const rememberCount = flag.rememberCount || 0;

    // CHECK 2: Task remember (edits without memory entry)
    if (editCount >= EDIT_THRESHOLD) {
      const retries = flag.retries || 0;
      const taskBlockTotal = flag.taskBlockTotal || 0;
      if (retries < MAX_RETRIES && taskBlockTotal < MAX_TASK_BLOCKS) {
        flag.retries = retries + 1;
        flag.taskBlockTotal = taskBlockTotal + 1;
        const files = Array.isArray(flag.files) ? flag.files : [];
        const fileList = files.length > 0
          ? ` Files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}`
          : '';
        obligations.push({
          type: 'task',
          short: `**Task memory**: unstored edits — call \`remember\` with what/why/how.${fileList}`,
          verbose: `SynaBun: Unstored file edits — call \`remember\` before finishing.${fileList}`,
        });
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
      if (planRetries < MAX_RETRIES) {
        flag.planRetries = planRetries + 1;
        const project = detectProject(cwd);
        // Mark stored now to prevent re-triggering. Claude stores it via MCP;
        // if that fails, the plan file still exists on disk as a safety net.
        markPlanStored(sessionPlan.basename);
        planDebug(`stop: CHECK5 block plan ${sessionPlan.basename} (session ${sessionId}, project ${project})`);
        obligations.push({
          type: 'plan',
          short: `**Plan memory**: "${sessionPlan.title}" — call \`remember\` category \`plans-${project}\`, importance 7, tags ["plan", "implementation", "${project}"], source "auto-saved". Include the full plan content.`,
          verbose: `SynaBun: Plan "${sessionPlan.title}" was approved but not stored in memory (PostToolUse hook missed it). Call \`remember\` with the plan content below. Category: \`plans-${project}\`, importance: 7, tags: ["plan", "implementation", "${project}"], source: "auto-saved".\n\nPlan file: ${sessionPlan.basename}\n\n${sessionPlan.content.slice(0, 4000)}`,
        });
      }
    }

    // Write flag once after all checks (single write instead of per-check writes)
    try { writeFileSync(rememberFlagPath, JSON.stringify(flag)); } catch { /* ok */ }

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

  // ─── STANDALONE PLAN CHECK (no pending-remember flag needed) ───
  // Catches plans even when there's no flag file (e.g. very short sessions).
  // Reuses the session-scoped lookup computed above — no extra transcript read.
  if (sessionPlan) {
    const project = detectProject(cwd);
    // Mark stored NOW to prevent re-triggering on the next stop cycle.
    // Claude remembers it via MCP; if that fails, the plan file still on disk.
    markPlanStored(sessionPlan.basename);
    planDebug(`stop: STANDALONE block plan ${sessionPlan.basename} (session ${sessionId}, project ${project})`);
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `SynaBun: Plan "${sessionPlan.title}" was approved but not stored in memory. Call \`remember\` with the plan content. Category: \`plans-${project}\`, importance: 7, tags: ["plan", "implementation", "${project}"], source: "auto-saved".\n\nPlan file: ${sessionPlan.basename}\n\n${sessionPlan.content.slice(0, 4000)}`,
    }));
    return;
  }

  // No flags, no unstored plans → allow stop
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
