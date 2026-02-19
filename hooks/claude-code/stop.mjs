#!/usr/bin/env node

/**
 * SynaBun Stop Hook for Claude Code
 *
 * Fires when Claude finishes responding. Enforces the compaction
 * auto-store requirement by BLOCKING Claude from stopping if a
 * pending compact flag exists (set by PreCompact hook).
 *
 * The flag is cleared by post-remember.mjs when Claude calls
 * `remember` with category "conversations".
 *
 * Safety: Max 3 retries to prevent infinite loops.
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
const PENDING_DIR = join(__dirname, '..', '..', 'data', 'pending-compact');
const MAX_RETRIES = 3;

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

  const flagPath = join(PENDING_DIR, `${sessionId}.json`);

  // No pending flag → allow stop
  if (!existsSync(flagPath)) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Read the flag
  let flag;
  try {
    flag = JSON.parse(readFileSync(flagPath, 'utf-8'));
  } catch {
    // Corrupt flag → delete and allow
    try { unlinkSync(flagPath); } catch { /* ok */ }
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const retries = flag.retries || 0;

  // Safety: max retries reached → give up, delete flag, allow stop
  if (retries >= MAX_RETRIES) {
    try { unlinkSync(flagPath); } catch { /* ok */ }
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Increment retry counter
  flag.retries = retries + 1;
  try {
    writeFileSync(flagPath, JSON.stringify(flag));
  } catch { /* ok */ }

  // BLOCK — force Claude to continue and store the session
  const reason = [
    `BLOCKED: You have not stored the compacted session in SynaBun.`,
    `A compaction occurred and the session MUST be indexed before you can finish responding.`,
    `Call \`remember\` with category \`conversations\` containing a summary of this session.`,
    `Then call \`reflect\` to set importance and tags.`,
    `Say "Session indexed in SynaBun." when done.`,
    `This is attempt ${retries + 1} of ${MAX_RETRIES}.`,
  ].join(' ');

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason,
  }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
