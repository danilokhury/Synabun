#!/usr/bin/env node

/**
 * SynaBun PostToolUse Hook for Claude Code (unified handler)
 *
 * Matches: ^Edit$|^Write$|^NotebookEdit$|mcp__SynaBun__remember
 *
 * Two responsibilities:
 *
 * 1. EDIT TRACKING — When Claude uses Edit, Write, or NotebookEdit,
 *    increments a pending-remember counter. If Claude finishes responding
 *    with 3+ unremembered edits, the Stop hook will block it.
 *
 * 2. FLAG MANAGEMENT — When Claude calls `remember`:
 *    - category "conversations" → clears pending-compact flag (compaction enforcement)
 *    - any other category       → resets pending-remember flag (editCount→0,
 *      keeps rememberCount/totalEdits so subsequent edits start a fresh segment)
 *
 * Input (stdin JSON):
 *   { session_id, tool_name, tool_input: { ... }, tool_response: { ... } }
 *
 * Output (stdout JSON):
 *   - On edit at threshold multiples (3, 6, 9...): { additionalContext: "..." }
 *   - Otherwise: {} (side effects only)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const PENDING_COMPACT_DIR = join(DATA_DIR, 'pending-compact');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');

// Ensure directories exist
for (const dir of [PENDING_COMPACT_DIR, PENDING_REMEMBER_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
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

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch { /* proceed */ }

  const sessionId = input.session_id || '';
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (!sessionId) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // ─── EDIT TRACKING ───
  if (EDIT_TOOLS.has(toolName)) {
    const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    let flag = { editCount: 0, retries: 0, files: [], firstEditAt: null };

    // Read existing flag if present
    if (existsSync(flagPath)) {
      try {
        flag = JSON.parse(readFileSync(flagPath, 'utf-8'));
      } catch { /* start fresh */ }
    }

    // Increment edit counters
    flag.editCount = (flag.editCount || 0) + 1;
    flag.totalEdits = (flag.totalEdits || 0) + 1;
    if (!flag.firstEditAt) flag.firstEditAt = new Date().toISOString();
    flag.lastEditAt = new Date().toISOString();

    // Track file path if available
    const filePath = toolInput.file_path || toolInput.notebook_path || '';
    if (filePath && Array.isArray(flag.files) && !flag.files.includes(filePath)) {
      flag.files.push(filePath);
    }

    try {
      writeFileSync(flagPath, JSON.stringify(flag));
    } catch { /* ok */ }

    // Proactive nudge at every multiple of threshold (3, 6, 9, ...)
    if (flag.editCount > 0 && flag.editCount % EDIT_THRESHOLD === 0) {
      let nudgeText;
      if (flag.editCount <= EDIT_THRESHOLD) {
        nudgeText = `SynaBun: ${flag.editCount} file edits so far — remember to store this work in memory before wrapping up.`;
      } else if (flag.editCount <= EDIT_THRESHOLD * 2) {
        nudgeText = `SynaBun: ${flag.editCount} file edits without storing to memory. Call \`remember\` soon to avoid losing context.`;
      } else {
        nudgeText = `SynaBun: ${flag.editCount} file edits — this is significant work. You MUST call \`remember\` before continuing.`;
      }
      process.stdout.write(JSON.stringify({ additionalContext: nudgeText }));
    } else {
      process.stdout.write(JSON.stringify({}));
    }
    return;
  }

  // ─── REMEMBER FLAG CLEARING ───
  if (toolName.includes('remember')) {
    const category = toolInput.category || '';

    if (category === 'conversations') {
      // Clear pending-compact flag (compaction enforcement)
      const compactFlagPath = join(PENDING_COMPACT_DIR, `${sessionId}.json`);
      if (existsSync(compactFlagPath)) {
        try { unlinkSync(compactFlagPath); } catch { /* ok */ }
      }
      // Also reset pending-remember flag (conversations remember counts too)
      const rememberFlagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
      if (existsSync(rememberFlagPath)) {
        try {
          let flag = {};
          try { flag = JSON.parse(readFileSync(rememberFlagPath, 'utf-8')); } catch { /* fresh */ }
          flag.messageCount = 0;
          flag.retries = 0;
          flag.rememberCount = (flag.rememberCount || 0) + 1;
          flag.lastRememberedAt = new Date().toISOString();
          writeFileSync(rememberFlagPath, JSON.stringify(flag));
        } catch { /* ok */ }
      }
    } else if (category) {
      // Reset pending-remember flag (keep file, zero counters for next task segment)
      const rememberFlagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
      if (existsSync(rememberFlagPath)) {
        try {
          let flag = {};
          try { flag = JSON.parse(readFileSync(rememberFlagPath, 'utf-8')); } catch { /* start fresh */ }

          const prevTotal = flag.totalEdits || flag.editCount || 0;
          const prevRememberCount = flag.rememberCount || 0;

          // Reset edit + message tracking but keep session-level stats
          flag.editCount = 0;
          flag.messageCount = 0;
          flag.retries = 0;
          flag.files = [];
          flag.firstEditAt = null;
          flag.lastEditAt = null;
          flag.firstMessageAt = null;
          flag.lastMessageAt = null;
          flag.lastRememberedAt = new Date().toISOString();
          flag.rememberCount = prevRememberCount + 1;
          flag.totalEdits = prevTotal;

          writeFileSync(rememberFlagPath, JSON.stringify(flag));
        } catch {
          // If reset fails, fall back to deleting
          try { unlinkSync(rememberFlagPath); } catch { /* ok */ }
        }
      }
    }
  }

  // Always output empty (no additional context needed)
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
