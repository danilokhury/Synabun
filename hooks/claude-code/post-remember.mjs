#!/usr/bin/env node

/**
 * SynaBun PostToolUse Hook for Claude Code (unified handler)
 *
 * Matches: ^Edit$|^Write$|^NotebookEdit$|Syna[Bb]un_+(remember|reflect|recall)$
 *
 * Two responsibilities:
 *
 * 1. EDIT TRACKING — When Claude uses Edit, Write, NotebookEdit or MultiEdit,
 *    increments a pending-remember counter. Once EDIT_THRESHOLD edits are
 *    unremembered, the Stop hook blocks until a memory is stored (it asks the
 *    turn-worth judgment first). The first edit of a session gets one quiet
 *    reminder plus the category reference; later edits add nothing to the
 *    context (the old per-edit escalation fired ~900 times in 4 days).
 *    Each edit also sends a fire-and-forget notice to /api/hook-edit so the
 *    server can check memories that reference the file (≤200 ms wait, one
 *    notice per file per 30 s, none when SYNABUN_TYPESAFE=off).
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
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { withStateLock, writeJsonAtomic, clearCompaction, memoryCategory } from './state.mjs';
import { loadCategories, buildCategoryReference, detectProject, DATA_DIR, getHookFeatures, typesafeOff, postNotice, isTemporaryChat } from './shared.mjs';
import { RECALL_TOOL, recordTaskRecall } from './task-gate.mjs';

// Cross-platform safety: catch uncaught errors and output valid hook JSON
process.on('uncaughtException', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
process.on('unhandledRejection', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });

const __dirname = dirname(fileURLToPath(import.meta.url));
const PENDING_COMPACT_DIR = join(DATA_DIR, 'pending-compact');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');

// Ensure directories exist (a temporary chat creates nothing: see main)
for (const dir of isTemporaryChat() ? [] : [PENDING_COMPACT_DIR, PENDING_REMEMBER_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
// Memory categories that record how the user works (user learning).
const UL_CATEGORIES = ['communication-style', 'personality'];
const FIRST_EDIT_REMINDER = 'SynaBun: first edit this session. When this piece of work is done, store it with `remember` (what/why/how); the Stop hook decides whether it is worth a memory.';
const NOTICE_THROTTLE_MS = 30 * 1000;
const NOTICED_FILES_MAX = 50;
const EXCERPT_MAX = 1500;
// Never ship excerpts of credentials, even to the local server.
const SENSITIVE_FILE = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.npmrc|\.netrc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)[^\\/]*|[^\\/]*(?:credential|secret)[^\\/]*|[^\\/]*\.(?:pem|key|p12|pfx|keystore|jks))$/i;

function editExcerpts(toolName, toolInput) {
  const str = (value) => (typeof value === 'string' ? value : '');
  if (toolName === 'Edit') return { old: str(toolInput.old_string), next: str(toolInput.new_string) };
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return {
      old: toolInput.edits.map((e) => str(e?.old_string)).filter(Boolean).join('\n…\n'),
      next: toolInput.edits.map((e) => str(e?.new_string)).filter(Boolean).join('\n…\n'),
    };
  }
  if (toolName === 'Write') return { old: '', next: str(toolInput.content) };
  if (toolName === 'NotebookEdit') return { old: '', next: str(toolInput.new_source) };
  return { old: '', next: '' };
}

function editNotice(input, toolName, toolInput, filePath) {
  const { old, next } = editExcerpts(toolName, toolInput);
  const cwd = input.cwd || '';
  return {
    session_id: input.session_id,
    prompt_id: typeof input.prompt_id === 'string' ? input.prompt_id : undefined,
    project: detectProject(cwd),
    cwd,
    file_path: filePath,
    tool: toolName,
    old_excerpt: old ? old.slice(0, EXCERPT_MAX) : undefined,
    new_excerpt: next ? next.slice(0, EXCERPT_MAX) : undefined,
  };
}

function writeOutput(output) {
  return new Promise((resolve) => {
    try { process.stdout.write(JSON.stringify(output), () => resolve()); }
    catch { resolve(); }
  });
}

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

  // A temporary chat (see isTemporaryChat): no edit is tracked or reported, no
  // receipt is kept, nothing is learned about the user.
  if (isTemporaryChat()) { await writeOutput({}); return; }

  // A recall receipt is separate from remember/edit obligations. Commit the
  // briefing only at PostToolBatch, after Claude can consume this result.
  if (RECALL_TOOL.test(input.tool_name || '')) {
    if (getHookFeatures().taskRecallGate !== false && !toolCallFailed(input.tool_response)) recordTaskRecall(input);
    await writeOutput({});
    return;
  }

  // A reflect names a memory, not a category. Look the category up BEFORE the
  // state lock (read-only database access never happens while holding it).
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  let reflectCategory = null;
  if (toolName.includes('reflect') && !toolCallFailed(input.tool_response)) {
    reflectCategory = (typeof toolInput.category === 'string' && toolInput.category) || memoryCategory(toolInput.memory_id);
  }

  let outcome = null;
  try { outcome = withStateLock(() => handleTool(input, { reflectCategory })); } catch { outcome = null; }
  // Printed after the lock is released; the notice never holds it either.
  await writeOutput(outcome?.output || {});
  if (outcome?.notice) await postNotice('/api/hook-edit', outcome.notice, 200);
  process.exit(0);
}

function handleTool(input, { reflectCategory = null } = {}) {
  const sessionId = input.session_id || '';
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = input.cwd || '';

  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return { output: {} };

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
    if (filePath && !Array.isArray(flag.files)) flag.files = [];
    if (filePath && !flag.files.includes(filePath)) {
      flag.files.push(filePath);
    }

    // One quiet reminder per session, with the category reference (lazy
    // injection). The Stop hook, gated by the turn-worth judgment, is the
    // authority on whether the work needs a memory; per-edit nagging is gone.
    let context = '';
    if (!flag.categoryTreeInjected) {
      context = FIRST_EDIT_REMINDER;
      try {
        const categoryRef = buildCategoryReference(loadCategories(), detectProject(cwd));
        context += `\n\n${categoryRef}`;
      } catch { /* category tree optional — the reminder works without it */ }
      flag.categoryTreeInjected = true;
    }

    // Edit-time stale check: at most one notice per file per 30 s.
    let notice = null;
    if (typeof filePath === 'string' && filePath && !typesafeOff() && !SENSITIVE_FILE.test(filePath)) {
      const noticed = flag.noticedFiles && typeof flag.noticedFiles === 'object' && !Array.isArray(flag.noticedFiles) ? flag.noticedFiles : {};
      const now = Date.now();
      if (now - (Number(noticed[filePath]) || 0) >= NOTICE_THROTTLE_MS) {
        noticed[filePath] = now;
        flag.noticedFiles = Object.fromEntries(Object.entries(noticed)
          .sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0)).slice(-NOTICED_FILES_MAX));
        notice = editNotice(input, toolName, toolInput, filePath);
      }
    }

    try {
      writeJsonAtomic(flagPath, flag);
    } catch { /* ok */ }

    // PostToolUse reads additionalContext from hookSpecificOutput. A bare
    // top-level { additionalContext } is silently discarded — which is why
    // the old nudges never reached the model.
    return {
      output: context ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } } : {},
      notice,
    };
  }

  // ─── USER LEARNING CLEARING (communication-style / personality) ───
  // A remember in a user-learning category, or a reflect whose memory is in
  // one, satisfies the obligation. Any other reflect does NOT: it used to
  // clear it for every reflect, whatever the memory was about.
  const isRememberUL = toolName.includes('remember') && UL_CATEGORIES.includes(toolInput.category || '');
  const isReflectUL = toolName.includes('reflect') && UL_CATEGORIES.includes(reflectCategory || '');

  if ((isRememberUL || isReflectUL) && !toolCallFailed(input.tool_response)) {
    const ulFlagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (existsSync(ulFlagPath)) {
      try {
        const ulFlag = JSON.parse(readFileSync(ulFlagPath, 'utf-8'));
        if (ulFlag.userLearningPending && (isRememberUL || isReflectUL)) {
          ulFlag.userLearningPending = false;
          ulFlag.userLearningObserved = true;
          writeJsonAtomic(ulFlagPath, ulFlag);
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
    // A completion can acknowledge only its session and captured generation.
    if ((toolInput.category || '') === 'conversations') {
      try { clearCompaction(sessionId, toolInput.source_ref); } catch { /* best effort */ }
    }

    // Record only an acknowledged plan write; Stop never manufactures receipts.
    if (toolInput.idempotency_key?.startsWith('plan:') && toolInput.source_ref && typeof toolInput.content === 'string') {
      const memoryId = JSON.stringify(input.tool_response || '').match(/Remembered \[([0-9a-f-]{36})\]/i)?.[1];
      if (memoryId) {
        const path = join(DATA_DIR, 'stored-plans.json');
        let stored = {};
        try { stored = JSON.parse(readFileSync(path, 'utf8')); } catch { /* no tracker */ }
        const receipt = {memoryId, project:toolInput.project, sourcePath:toolInput.source_ref,
          contentHash:createHash('sha256').update(toolInput.content).digest('hex'),storedAt:new Date().toISOString()};
        stored[toolInput.idempotency_key] = receipt;
        stored[basename(toolInput.source_ref)] = receipt;
        writeJsonAtomic(path, stored);
      }
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

        writeJsonAtomic(rememberFlagPath, flag);
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
          writeJsonAtomic(loopPath, loop);
        }
      } catch { /* ok */ }
    }
  }

  // Always output empty (no additional context needed)
  return { output: {} };
}

main().catch(() => {
  try { process.stdout.write(JSON.stringify({}), () => process.exit(0)); } catch { process.exit(0); }
});
