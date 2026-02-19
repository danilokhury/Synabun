#!/usr/bin/env node

/**
 * SynaBun PostToolUse Hook for Claude Code
 *
 * Matches: mcp__SynaBun__remember
 *
 * When Claude calls `remember` with category "conversations",
 * this hook clears the pending compact flag — signaling to the
 * Stop hook that the compaction auto-store requirement is satisfied.
 *
 * Input (stdin JSON):
 *   { session_id, tool_name: "mcp__SynaBun__remember",
 *     tool_input: { content, category, ... }, tool_response: { ... } }
 *
 * Output (stdout JSON): {} (no-op, just clears the flag as side effect)
 */

import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PENDING_DIR = join(__dirname, '..', '..', 'data', 'pending-compact');

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
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch { /* proceed */ }

  const sessionId = input.session_id || '';
  const toolInput = input.tool_input || {};

  // Only clear flag if this remember call is for conversations category
  if (sessionId && toolInput.category === 'conversations') {
    const flagPath = join(PENDING_DIR, `${sessionId}.json`);
    if (existsSync(flagPath)) {
      try { unlinkSync(flagPath); } catch { /* ok */ }
    }
  }

  // Always output empty (no additional context needed)
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
