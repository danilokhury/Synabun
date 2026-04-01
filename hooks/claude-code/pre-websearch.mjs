#!/usr/bin/env node

/**
 * SynaBun PreToolUse Hook — Block WebSearch/WebFetch when browser is active
 *
 * Matches: ^WebSearch$|^WebFetch$
 *
 * Blocks these tools when SynaBun's Neural Interface is reachable AND:
 *   1. An active loop with usesBrowser=true exists, OR
 *   2. Any browser session is currently open
 *
 * If the Neural Interface is unreachable (SynaBun offline), all checks are
 * skipped — loop files on disk may be stale and cannot be trusted.
 *
 * Input (stdin JSON):
 *   { session_id, tool_name, tool_input: { ... } }
 *
 * Output (stdout JSON):
 *   - If blocked: { decision: "block", reason: "..." }
 *   - If allowed: {}
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDataHome } from '../../lib/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_HOME = getDataHome();
const LOOP_DIR = join(DATA_HOME, 'data', 'loop');
const NI_BASE = process.env.SYNABUN_NI_URL || 'http://localhost:3344';

const BLOCK_REASON = (toolName) =>
  `BLOCKED: ${toolName} is not allowed while a SynaBun browser session is open. Use the SynaBun browser tools (browser_navigate, browser_click, browser_content, etc.) instead. If the page requires login or CAPTCHA, STOP and tell the user what they need to do in the browser panel. Do NOT fall back to web search.`;

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { input += chunk; });
// Timeout: if stdin never closes (PowerShell edge case), proceed with what we have
const stdinTimeout = setTimeout(() => {
  process.stdin.removeAllListeners('end');
  handleInput();
}, 2000);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  handleInput();
});
async function handleInput() {
  try {
    const { session_id, tool_name } = JSON.parse(input);

    // First, check if the Neural Interface is reachable.
    // If it's down, skip all checks — loop files may be stale.
    let niReachable = false;
    let activeBrowserSessions = [];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${NI_BASE}/api/browser/sessions`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        niReachable = true;
        const data = await res.json();
        activeBrowserSessions = data.sessions || [];
      }
    } catch {
      // Neural Interface not reachable — allow all tools
    }

    if (!niReachable) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    // Check 1: Active loop with usesBrowser (only trusted when NI is reachable)
    if (existsSync(LOOP_DIR)) {
      const files = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json') && !f.startsWith('pending-'));
      for (const file of files) {
        try {
          const loop = JSON.parse(readFileSync(join(LOOP_DIR, file), 'utf-8'));
          if (loop.active && loop.usesBrowser) {
            process.stdout.write(JSON.stringify({ decision: 'block', reason: BLOCK_REASON(tool_name) }));
            return;
          }
        } catch { /* skip corrupt files */ }
      }
    }

    // Check 2: Any active browser session via the NI response we already fetched
    if (activeBrowserSessions.length > 0) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: BLOCK_REASON(tool_name) }));
      return;
    }

    // No browser activity — allow the tool
    process.stdout.write(JSON.stringify({}));
  } catch {
    process.stdout.write(JSON.stringify({}));
  }
}
