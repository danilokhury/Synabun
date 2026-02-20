#!/usr/bin/env node

/**
 * SynaBun Stop Hook for Claude Code
 *
 * Fires when Claude finishes responding. Enforces two requirements:
 *
 * 1. COMPACTION AUTO-STORE — If a pending-compact flag exists (set by
 *    PreCompact hook), blocks Claude until it stores the session via
 *    `remember` with category "conversations".
 *
 * 2. TASK AUTO-REMEMBER — If a pending-remember flag exists with 3+
 *    unremembered edits, blocks Claude until it stores the completed
 *    work via `remember` with any non-conversations category.
 *
 * Safety: Max 3 retries per flag to prevent infinite loops.
 *
 * Input (stdin JSON):
 *   { session_id, transcript_path, cwd, hook_event_name: "Stop",
 *     stop_hook_active, last_assistant_message }
 *
 * Output (stdout JSON):
 *   { "decision": "block", "reason": "..." } to force Claude to continue
 *   {} to allow Claude to stop normally
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const PENDING_COMPACT_DIR = join(DATA_DIR, 'pending-compact');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
const MAX_RETRIES = 3;
const EDIT_THRESHOLD = 3;

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
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    sessionId = input.session_id || '';
  } catch { /* proceed */ }

  if (!sessionId) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // ─── CHECK 1: Pending compact (higher priority) ───
  const compactResult = checkFlag(
    join(PENDING_COMPACT_DIR, `${sessionId}.json`),
    (_flag, attempt) =>
      `SynaBun: Compacted session not yet indexed — store in conversations category before finishing. (${attempt}/${MAX_RETRIES})`
  );

  if (compactResult?.shouldBlock) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: compactResult.reason,
    }));
    return;
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

    // Below threshold → allow stop, clean up flag
    if (editCount < EDIT_THRESHOLD) {
      try { unlinkSync(rememberFlagPath); } catch { /* ok */ }
      process.stdout.write(JSON.stringify({}));
      return;
    }

    // Above threshold → enforce
    const retries = flag.retries || 0;

    if (retries >= MAX_RETRIES) {
      try { unlinkSync(rememberFlagPath); } catch { /* ok */ }
      process.stdout.write(JSON.stringify({}));
      return;
    }

    flag.retries = retries + 1;
    try {
      writeFileSync(rememberFlagPath, JSON.stringify(flag));
    } catch { /* ok */ }

    const reason = `SynaBun: ${editCount} edits not yet stored in memory — remember this work before finishing. (${retries + 1}/${MAX_RETRIES})`;

    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason,
    }));
    return;
  }

  // No flags → allow stop
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
