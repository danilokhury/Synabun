#!/usr/bin/env node

/**
 * SynaBun PostToolUse Hook for Claude Code (unified handler)
 *
 * Matches: ^Edit$|^Write$|^NotebookEdit$|Syna[Bb]un_+(remember|reflect)
 *
 * Two responsibilities:
 *
 * 1. EDIT TRACKING — When Claude uses Edit, Write, or NotebookEdit,
 *    increments a pending-remember counter. Once EDIT_THRESHOLD edits are
 *    unremembered, the Stop hook blocks until a memory is stored.
 *
 * 2. FLAG MANAGEMENT — When Claude calls `remember` or `reflect`:
 *    - ALWAYS resets the pending-remember flag (editCount→0, retries→0,
 *      files→[]), keeping rememberCount/totalEdits so subsequent edits start
 *      a fresh segment. This is deliberately NOT conditional on `category`.
 *    - category "conversations" ALSO clears pending-compact (compaction).
 *
 *    History: this used to be `else if (category)`, so a `remember` call that
 *    omitted `category` — which is what Claude Code actually sends when the
 *    schema lets it — cleared nothing, and the Stop hook blocked forever.
 *    Never re-gate the reset on a field the caller may legitimately omit.
 *
 * Input (stdin JSON):
 *   { session_id, tool_name, tool_input: { ... }, tool_response: { ... } }
 *
 * Output (stdout JSON):
 *   - On an edit that hits the threshold:
 *     { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }
 *   - Otherwise: {} (side effects only)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCategories, buildCategoryReference, detectProject, DATA_DIR } from './shared.mjs';

// Cross-platform safety: catch uncaught errors and output valid hook JSON
process.on('uncaughtException', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
process.on('unhandledRejection', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });

const __dirname = dirname(fileURLToPath(import.meta.url));
const PENDING_COMPACT_DIR = join(DATA_DIR, 'pending-compact');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');

// Ensure directories exist
for (const dir of [PENDING_COMPACT_DIR, PENDING_REMEMBER_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const EDIT_THRESHOLD = 1;

/**
 * Explicit-failure detection ONLY — everything ambiguous counts as SUCCESS.
 *
 * MCP tools return a CallToolResult: { content: [{type:'text',text}], isError? }.
 * Claude Code passes it through and snake_cases some fields depending on version,
 * so accept both spellings. A missing tool_response, a plain string, or an object
 * of unknown shape MUST fail open: a format change on the Claude Code side can
 * never be allowed to reintroduce the never-clears bug this hook exists to avoid.
 *
 * A schema rejection (InvalidParams) doesn't fire PostToolUse at all, which is
 * also correct — nothing was stored, so nothing should clear.
 */
function toolCallFailed(resp) {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return false;
  if (resp.isError === true || resp.is_error === true) return true;
  if (resp.success === false) return true;
  if (typeof resp.status === 'string' && resp.status.toLowerCase() === 'error') return true;
  return false;
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

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch { /* proceed */ }

  const sessionId = input.session_id || '';
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || '';

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

    // A new edit segment starts a fresh obligation. `retries` is per-segment
    // backoff, not a session budget — without this reset, MAX_RETRIES blocks
    // permanently disable task-memory enforcement for the rest of the session
    // (the only other reset paths require editCount to already be 0).
    if ((flag.editCount || 0) === 0) flag.retries = 0;

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

    // Proactive nudge at every multiple of EDIT_THRESHOLD
    if (flag.editCount > 0 && flag.editCount % EDIT_THRESHOLD === 0) {
      let nudgeText;
      if (flag.editCount <= EDIT_THRESHOLD) {
        nudgeText = `SynaBun: ${flag.editCount} file edits so far — remember to store this work in memory before wrapping up.`;
      } else if (flag.editCount <= EDIT_THRESHOLD * 2) {
        nudgeText = `SynaBun: ${flag.editCount} file edits without storing to memory. Call \`remember\` soon to avoid losing context.`;
      } else {
        nudgeText = `SynaBun: ${flag.editCount} file edits — this is significant work. You MUST call \`remember\` before continuing.`;
      }

      // On first threshold hit, append the full category reference (lazy injection)
      if (!flag.categoryTreeInjected) {
        try {
          const categories = loadCategories();
          const project = detectProject(cwd);
          const categoryRef = buildCategoryReference(categories, project);
          nudgeText += `\n\n${categoryRef}`;
          flag.categoryTreeInjected = true;
          writeFileSync(flagPath, JSON.stringify(flag));
        } catch { /* category tree optional — nudge still works without it */ }
      }

      // PostToolUse reads additionalContext from hookSpecificOutput. A bare
      // top-level { additionalContext } is silently discarded — which is why
      // these nudges never reached the model.
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudgeText },
      }));
    } else {
      process.stdout.write(JSON.stringify({}));
    }
    return;
  }

  // ─── USER LEARNING CLEARING (remember or reflect for communication-style/personality) ───
  // Since user learning is non-blocking (prompt-submit nudge only), any remember or
  // reflect targeting communication-style clears the flag immediately.
  const UL_CATEGORIES = ['communication-style', 'personality'];
  const isRememberUL = toolName.includes('remember') && UL_CATEGORIES.includes(toolInput.category || '');
  const isReflectUL = toolName.includes('reflect');

  if (isRememberUL || isReflectUL) {
    const ulFlagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (existsSync(ulFlagPath)) {
      try {
        const ulFlag = JSON.parse(readFileSync(ulFlagPath, 'utf-8'));
        if (ulFlag.userLearningPending && (isRememberUL || isReflectUL)) {
          ulFlag.userLearningPending = false;
          ulFlag.userLearningObserved = true;
          writeFileSync(ulFlagPath, JSON.stringify(ulFlag));
        }
      } catch { /* ok */ }
    }
  }

  // ─── MEMORY-STORED CLEARING ───
  // ANY successful remember/reflect resets edit tracking, regardless of category.
  // Claude Code routinely calls remember with { content } only, and reflect rarely
  // carries a category — gating this reset on category truthiness is what made the
  // Stop hook block forever. Category only decides the EXTRA compaction clear below.
  const storedMemory = (toolName.includes('remember') || toolName.includes('reflect'))
    && !toolCallFailed(input.tool_response);

  if (storedMemory) {
    // A "conversations" memory ALSO satisfies the compaction obligation.
    // Clear every pending-compact flag — the session ID changes after compaction.
    if ((toolInput.category || '') === 'conversations') {
      try {
        if (existsSync(PENDING_COMPACT_DIR)) {
          for (const f of readdirSync(PENDING_COMPACT_DIR).filter(f => f.endsWith('.json'))) {
            try { unlinkSync(join(PENDING_COMPACT_DIR, f)); } catch { /* ok */ }
          }
        }
      } catch { /* ok */ }
    }

    // Reset pending-remember (keep the file, zero counters for the next segment).
    // Never create it here — prompt-submit.mjs owns creation, and manufacturing a
    // flag for a session that never edited would resurrect stale-file buildup.
    const rememberFlagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (existsSync(rememberFlagPath)) {
      try {
        let flag = {};
        try { flag = JSON.parse(readFileSync(rememberFlagPath, 'utf-8')); } catch { /* start fresh */ }

        // Preserve session-level stats before zeroing the segment counters.
        flag.totalEdits = flag.totalEdits || flag.editCount || 0;
        flag.rememberCount = (flag.rememberCount || 0) + 1;
        flag.lastRememberedAt = new Date().toISOString();

        flag.editCount = 0;
        flag.messageCount = 0;
        flag.retries = 0;
        flag.taskBlockTotal = 0;
        flag.files = [];
        flag.firstEditAt = null;
        flag.lastEditAt = null;
        flag.firstMessageAt = null;
        flag.lastMessageAt = null;
        // categoryTreeInjected is intentionally NOT reset — the category tree is
        // injected once per session, not once per task segment.

        writeFileSync(rememberFlagPath, JSON.stringify(flag));
      } catch {
        // If reset fails, fall back to deleting
        try { unlinkSync(rememberFlagPath); } catch { /* ok */ }
      }
    }
  }

  // Update loop memory tracking when a memory is stored during an active loop
  if (storedMemory) {
    const LOOP_DIR = join(DATA_DIR, 'loop');
    const loopPath = join(LOOP_DIR, `${sessionId}.json`);
    if (existsSync(loopPath)) {
      try {
        const loop = JSON.parse(readFileSync(loopPath, 'utf-8'));
        if (loop.active) {
          loop.lastMemoryAt = loop.currentIteration || 0;
          loop.memoryPending = false;
          loop.memoryRetries = 0;
          writeFileSync(loopPath, JSON.stringify(loop, null, 2));
        }
      } catch { /* ok */ }
    }
  }

  // Always output empty (no additional context needed)
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
