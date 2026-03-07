#!/usr/bin/env node

/**
 * SynaBun Stop Hook for Claude Code
 *
 * Fires when Claude finishes responding. Enforces three requirements:
 *
 * 1. COMPACTION AUTO-STORE — If a pending-compact flag exists (set by
 *    PreCompact hook), blocks Claude until it stores the session via
 *    `remember` with category "conversations".
 *
 * 1.5. ACTIVE LOOP — If a loop state file exists (set by `loop start`
 *    MCP tool), blocks Claude to continue the next iteration until
 *    iteration cap or time cap is reached.
 *
 * 2. TASK AUTO-REMEMBER — If a pending-remember flag exists with 3+
 *    unremembered edits, blocks Claude until it stores the completed
 *    work via `remember` with any non-conversations category.
 *
 * Safety: Max 3 retries per flag to prevent infinite loops.
 * Loop: Max 50 iterations / 60 minutes hard cap.
 *
 * Input (stdin JSON):
 *   { session_id, transcript_path, cwd, hook_event_name: "Stop",
 *     stop_hook_active, last_assistant_message }
 *
 * Output (stdout JSON):
 *   { "decision": "block", "reason": "..." } to force Claude to continue
 *   {} to allow Claude to stop normally
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const PENDING_COMPACT_DIR = join(DATA_DIR, 'pending-compact');
const LOOP_DIR = join(DATA_DIR, 'loop');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
const HOOK_FEATURES_PATH = join(DATA_DIR, 'hook-features.json');
const MAX_RETRIES = 3;
const EDIT_THRESHOLD = 3;
const MESSAGE_THRESHOLD = 5;
const AUTO_STORE_MESSAGE_THRESHOLD = 3;

const UL_DEBUG = join(DATA_DIR, 'user-learning-debug.log');
function debugUL(msg) {
  try { appendFileSync(UL_DEBUG, `[${new Date().toISOString()}] STOP: ${msg}\n`); } catch { /* best effort */ }
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
 * Read hook features configuration.
 */
function getHookFeatures() {
  try {
    if (!existsSync(HOOK_FEATURES_PATH)) return {};
    return JSON.parse(readFileSync(HOOK_FEATURES_PATH, 'utf-8'));
  } catch { return {}; }
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

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('{}');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 2000);
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
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    sessionId = input.session_id || '';
    lastMessage = (input.last_assistant_message || '').toLowerCase();
  } catch { /* proceed */ }

  if (!sessionId) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // ─── CHECK 1: Pending compact (higher priority) ───
  // Session IDs can differ between PreCompact and post-compaction Stop,
  // so scan ALL pending-compact files and pick the most recent one.
  const DEBUG_LOG = join(DATA_DIR, 'compact-debug.log');
  let compactFlagPath = null;
  try {
    if (existsSync(PENDING_COMPACT_DIR)) {
      const files = readdirSync(PENDING_COMPACT_DIR)
        .filter(f => f.endsWith('.json') && !f.startsWith('test-'));
      if (files.length > 0) {
        // Pick the most recently created flag
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
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] STOP session_id=${sessionId} compactFlagPath=${compactFlagPath}\n`);
  } catch { /* ok */ }

  if (compactFlagPath) {
    const compactResult = checkFlag(
      compactFlagPath,
      (_flag, attempt) =>
        `SynaBun: Session compacted but not indexed yet — log it in 'conversations' first. (${attempt}/${MAX_RETRIES})`
    );

    if (compactResult?.shouldBlock) {
      try {
        appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] STOP BLOCKING session_id=${sessionId} reason=${compactResult.reason}\n`);
      } catch { /* ok */ }
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: compactResult.reason,
      }));
      return;
    }
  }

  // ─── CHECK 1.5: Active loop ───
  const loopFlagPath = join(LOOP_DIR, `${sessionId}.json`);

  if (existsSync(loopFlagPath)) {
    let loop;
    try {
      loop = JSON.parse(readFileSync(loopFlagPath, 'utf-8'));
    } catch {
      // Corrupt file → delete and fall through
      try { unlinkSync(loopFlagPath); } catch { /* ok */ }
    }

    if (loop?.active) {
      const elapsed = Date.now() - new Date(loop.startedAt).getTime();
      const maxMs = (loop.maxMinutes || 30) * 60 * 1000;
      const iterationsDone = loop.currentIteration || 0;
      const totalIterations = loop.totalIterations || 10;

      // Check caps — iteration limit or time limit reached
      if (iterationsDone >= totalIterations || elapsed >= maxMs) {
        // Loop finished — deactivate and allow stop
        loop.active = false;
        loop.finishedAt = new Date().toISOString();
        try { writeFileSync(loopFlagPath, JSON.stringify(loop, null, 2)); } catch { /* ok */ }
        // Fall through to remember/conversation checks
      } else if (loop.usesBrowser && isHumanBlocker(lastMessage)) {
        // Agent is waiting for human action (login, CAPTCHA, etc.) — pause loop
        // Don't increment iteration, don't block. Let agent stop and wait for user input.
        // Loop stays active, so when user sends next message the loop resumes.
        process.stdout.write(JSON.stringify({}));
        return;
      } else {
        // Continue loop — increment and block
        loop.currentIteration = iterationsDone + 1;
        loop.lastIterationAt = new Date().toISOString();
        loop.retries = 0; // reset retries on successful iteration
        try { writeFileSync(loopFlagPath, JSON.stringify(loop, null, 2)); } catch { /* ok */ }

        const timeLeft = Math.round((maxMs - elapsed) / 60000);
        const browserRule = loop.usesBrowser
          ? '\nBROWSER ENFORCEMENT: Use ONLY SynaBun browser tools. If the browser shows a login page, CAPTCHA, or any wall requiring human action: STOP and tell the user what to do. Do NOT fall back to WebSearch or WebFetch. NEVER abandon the browser.'
          : '';
        const reason = [
          `SynaBun Loop: Iteration ${loop.currentIteration}/${totalIterations} (${timeLeft}min remaining).`,
          `Task: ${loop.task}`,
          loop.context ? `Context: ${loop.context}` : '',
          '',
          `LOOP AUTONOMY: Execute directly. No confirmations. Use all tools freely. If a technical issue occurs, try alternatives. Produce concrete progress this iteration.${browserRule}`,
        ].filter(Boolean).join('\n');

        process.stdout.write(JSON.stringify({ decision: 'block', reason }));
        return;
      }
    }
  }

  // ─── CHECK 2: Pending remember (task enforcement) ───
  const rememberFlagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
  if (existsSync(rememberFlagPath)) {
    let flag;
    try {
      flag = JSON.parse(readFileSync(rememberFlagPath, 'utf-8'));
    } catch {
      try { unlinkSync(rememberFlagPath); } catch { /* ok */ }
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const editCount = flag.editCount || 0;

    // Above edit threshold → enforce remember
    if (editCount >= EDIT_THRESHOLD) {
      const retries = flag.retries || 0;
      if (retries < MAX_RETRIES) {
        flag.retries = retries + 1;
        try { writeFileSync(rememberFlagPath, JSON.stringify(flag)); } catch { /* ok */ }

        const rememberCount = flag.rememberCount || 0;
        const statsNote = rememberCount > 0
          ? ` (${rememberCount} task${rememberCount !== 1 ? 's' : ''} already stored this session)`
          : '';
        const reason = `SynaBun: ${editCount} edits without a memory entry — store this work before you finish.${statsNote} (${retries + 1}/${MAX_RETRIES})`;

        process.stdout.write(JSON.stringify({ decision: 'block', reason }));
        return;
      }
    }

    // ─── CHECK 2.5: User learning enforcement ───
    debugUL(`CHECK 2.5: pending=${flag.userLearningPending} retries=${flag.userLearningRetries || 0} editCount=${editCount}`);
    if (flag.userLearningPending) {
      const ulRetries = flag.userLearningRetries || 0;
      if (ulRetries < MAX_RETRIES) {
        flag.userLearningRetries = ulRetries + 1;
        try { writeFileSync(rememberFlagPath, JSON.stringify(flag)); } catch { /* ok */ }

        const reason = ulRetries === 0
          ? [
            `SynaBun: User behavioral observation required before stopping.`,
            `Category MUST be \`communication-style\` — NOT \`conversations\` or anything else.`,
            `Content MUST describe HOW the user works with you — NOT what was worked on. This is NOT a session summary.`,
            `AVOID DUPLICATES: If an existing memory already covers the same patterns, use \`reflect\` to UPDATE it.`,
            ``,
            `GOOD: "User chains tasks with no acknowledgment of completion. Gives terse corrections ('not that one') expecting you to re-derive context. Reports bugs by symptoms, iterates by testing. Prefers diving in over planning."`,
            `BAD: "User asked about hooks and we fixed bugs." ← session summary, not behavioral observation.`,
            `BAD: "User types in lowercase." ← too shallow. Capture patterns that change how you should respond.`,
            ``,
            `1. \`recall\` category \`communication-style\` — check existing entries`,
            `2. If existing entry matches → \`reflect\` (memory_id=<full UUID>, content=merged observation)`,
            `   If no match → \`remember\` category \`communication-style\`, project "global", importance 5-7`,
            `   Observe: instruction patterns, response expectations, correction style, expertise signals, frustration triggers, workflow preferences`,
            `(${ulRetries + 1}/${MAX_RETRIES})`,
          ].join('\n')
          : `SynaBun: User learning STILL pending. \`recall\` category \`communication-style\`, then \`reflect\` to update an existing entry or \`remember\` if none exists. Content must describe HOW the user works with you — NOT what was discussed. Focus on: instruction patterns, correction style, response expectations, workflow preferences. (${ulRetries + 1}/${MAX_RETRIES})`;

        debugUL(`BLOCK: user learning retry ${ulRetries + 1}/${MAX_RETRIES}`);
        process.stdout.write(JSON.stringify({ decision: 'block', reason }));
        return;
      }
      // Max retries — clear pending and fall through
      debugUL(`GIVE UP: max retries reached for user learning`);
      flag.userLearningPending = false;
      flag.userLearningRetries = 0;
      try { writeFileSync(rememberFlagPath, JSON.stringify(flag)); } catch { /* ok */ }
    }

    // ─── CHECK 3: Conversation turn enforcement ───
    const messageCount = flag.messageCount || 0;
    const rememberCount = flag.rememberCount || 0;
    if (messageCount >= MESSAGE_THRESHOLD && rememberCount === 0 && editCount < EDIT_THRESHOLD) {
      const retries = flag.retries || 0;
      if (retries < MAX_RETRIES) {
        flag.retries = retries + 1;
        try { writeFileSync(rememberFlagPath, JSON.stringify(flag)); } catch { /* ok */ }

        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: `SynaBun: ${messageCount} exchanges and nothing saved yet — drop a quick memory before wrapping up. (${retries + 1}/${MAX_RETRIES})`,
        }));
        return;
      }
    }

    // No blocking conditions → soft cleanup and allow stop
    softCleanupFlag(rememberFlagPath);
  }

  // ─── CHECK 4: Auto-store session on end ───
  // When enabled, blocks once to ask Claude to store a session summary in
  // "conversations" if the session had meaningful activity. This ensures every
  // non-trivial session gets a conversation memory without manual intervention.
  const features = getHookFeatures();
  if (features.autoStoreOnEnd !== false) {
    const rememberFlagPath2 = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    let flag = null;
    try {
      if (existsSync(rememberFlagPath2)) {
        flag = JSON.parse(readFileSync(rememberFlagPath2, 'utf-8'));
      }
    } catch { /* ok */ }

    if (flag) {
      const totalMessages = flag.totalSessionMessages || flag.messageCount || 0;
      const totalEdits = flag.totalEdits || 0;
      const rememberCount = flag.rememberCount || 0;
      const autoStoreTriggered = flag.autoStoreTriggered || false;

      // Trigger if: meaningful session, not already triggered, and no conversation
      // memory was stored via the compact chain
      const hasMeaningfulActivity =
        totalMessages >= AUTO_STORE_MESSAGE_THRESHOLD || totalEdits > 0;

      if (hasMeaningfulActivity && !autoStoreTriggered) {
        // Mark triggered so we only block once
        flag.autoStoreTriggered = true;
        try { writeFileSync(rememberFlagPath2, JSON.stringify(flag)); } catch { /* ok */ }

        const statsNote = rememberCount > 0
          ? ` You stored ${rememberCount} task memor${rememberCount !== 1 ? 'ies' : 'y'} this session — now add a brief session summary.`
          : '';
        const editNote = totalEdits > 0 ? ` ${totalEdits} file edits made.` : '';

        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: `SynaBun: Session ending — store a brief session summary in category \`conversations\` (${totalMessages} messages.${editNote}).${statsNote} Include: what was worked on, key decisions, and current state. Use source: "auto-saved".`,
        }));
        return;
      }
    }
  }

  // No flags → allow stop
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
