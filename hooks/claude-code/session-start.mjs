#!/usr/bin/env node

/**
 * SynaBun SessionStart Hook for Claude Code
 *
 * Injects a lean session-start context: greeting, single recall directive,
 * and (when applicable) compaction indexing instructions.
 *
 * Heavy reference data (category tree, user-learning rules) is deferred
 * to prompt-submit and post-remember hooks to keep boot fast and clean.
 *
 * Enable in any project's .claude/settings.json:
 * {
 *   "hooks": {
 *     "SessionStart": [{
 *       "matcher": "",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "node \"<path-to-synabun>/hooks/claude-code/session-start.mjs\"",
 *         "timeout": 5
 *       }]
 *     }]
 *   }
 * }
 */

import { readFileSync, existsSync, unlinkSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHookFeatures, detectProject, ensureProjectCategories, cleanupStaleLoops, DATA_DIR } from './shared.mjs';

// Cross-platform safety: catch uncaught errors and output valid hook JSON
const _fallback = () => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'SynaBun hook error. Follow CLAUDE.md memory rules manually.' } });
process.on('uncaughtException', () => { try { process.stdout.write(_fallback()); } catch {} process.exit(0); });
process.on('unhandledRejection', () => { try { process.stdout.write(_fallback()); } catch {} process.exit(0); });

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRECOMPACT_DIR = join(DATA_DIR, 'precompact');
const DEBUG_LOG = join(DATA_DIR, 'compact-debug.log');
const LOOP_DIR = join(DATA_DIR, 'loop');
// NOTE: Greeting helpers removed — greeting is now built entirely by prompt-submit.mjs

function getGitBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function getGitHead(cwd) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// --- Read stdin (Claude Code passes session JSON) ---

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

// --- Read precompact cache ---

function readPrecompactCache(sessionId) {
  if (!sessionId) return null;
  const cachePath = join(PRECOMPACT_DIR, `${sessionId}.json`);
  try {
    if (!existsSync(cachePath)) return null;
    const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
    // Clean up the cache file after reading
    try { unlinkSync(cachePath); } catch { /* ok */ }
    return data;
  } catch { return null; }
}

// --- Main ---

async function main() {
  let cwd = '';
  let source = 'unknown';
  let sessionId = '';
  let transcriptPath = '';

  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    cwd = input.cwd || '';
    source = input.source || 'unknown';
    sessionId = input.session_id || '';
    transcriptPath = input.transcript_path || '';
  } catch { /* proceed with defaults */ }

  const project = detectProject(cwd);
  const features = getHookFeatures();
  const isCompactRestart = source === 'compact';

  // Register session with Neural Interface session monitor (fire-and-forget)
  if (sessionId) {
    const niUrl = process.env.SYNABUN_NI_URL || 'http://localhost:3344';
    try {
      fetch(`${niUrl}/api/sessions/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claudeSessionId: sessionId, cwd, profile: 'claude-code', source: 'hook', project, terminalType: 'external' }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => { /* NI may not be running */ });
    } catch { /* ok */ }
  }

  // Ensure all registered projects have their default category trees
  try { ensureProjectCategories(); } catch { /* non-critical */ }

  // Debug logging
  try {
    const cacheExists = sessionId ? existsSync(join(PRECOMPACT_DIR, `${sessionId}.json`)) : false;
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] SESSION-START source=${source} session_id=${sessionId} isCompactRestart=${isCompactRestart} cacheExists=${cacheExists} convMemory=${features.conversationMemory}\n`);
  } catch { /* ok */ }

  // --- Build context ---

  const precompactData = (features.conversationMemory !== false && isCompactRestart)
    ? readPrecompactCache(sessionId)
    : null;

  const context = [];

  // ============================================================
  // BLOCK 0: GREETING (highest attention, unless compaction or loop)
  // ============================================================

  // Detect active loop — skip greeting + recall for autonomous loop sessions
  // Check both pending files (first iteration) AND active state files (subsequent iterations after /clear).
  // When SYNABUN_TERMINAL_SESSION is set (server-launched loop), only match loops
  // owned by THIS terminal — prevents unrelated sessions from entering loop mode.
  // First, deactivate stale loops (session died, terminal closed, time expired)
  cleanupStaleLoops(LOOP_DIR);
  const LOOP_STALE_MS = 10 * 60 * 1000;
  const terminalSessionEnv = process.env.SYNABUN_TERMINAL_SESSION || '';
  let isLoopSession = false;
  try {
    if (existsSync(LOOP_DIR)) {
      const now = Date.now();
      const loopFiles = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json'));
      for (const f of loopFiles) {
        try {
          const fullPath = join(LOOP_DIR, f);
          const mtime = statSync(fullPath).mtimeMs;
          if ((now - mtime) >= LOOP_STALE_MS) continue;
          const data = JSON.parse(readFileSync(fullPath, 'utf-8'));
          if (data.stopped === true || data.finishedAt) continue;
          // Active loop detected (pending or already running)
          if (data.active || data.pending) {
            // Multi-loop isolation: only match OUR terminal's loop
            // If the loop belongs to a specific terminal, only match if this session is that same terminal
            if (data.terminalSessionId && data.terminalSessionId !== terminalSessionEnv) continue;
            isLoopSession = true;
            break;
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* ok */ }

  if (isLoopSession) {
    // Minimal context for loop sessions — prompt-submit hook handles the rest
    context.push(
      `## SynaBun Persistent Memory`,
      ``,
      `SynaBun memory is active. CLAUDE.md contains the memory rules. Follow them throughout this session.`,
      ``,
      `**This is an autonomous loop session.** Do NOT output any greeting. Do NOT call recall at startup. Wait for the loop task injection from the UserPromptSubmit hook, then execute immediately.`,
      ``,
      `Current project: **${project}**`,
    );

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context.join('\n'),
      },
    }));
    return;
  }

  // NOTE: Greeting is NOT injected here. It is injected by prompt-submit.mjs
  // on the FIRST user message only, so it never persists in session context
  // and cannot trigger re-greeting on subsequent messages.

  // ============================================================
  // BLOCK 1: SYNABUN HEADER + SESSION RECALL (condensed)
  // ============================================================

  const startCommit = getGitHead(cwd);

  context.push(
    `## SynaBun Persistent Memory`,
    ``,
    `SynaBun memory is active. CLAUDE.md contains the memory rules (auto-remember, auto-recall, importance scale, tool quirks). Follow those rules throughout this session.`,
    ``,
    `**Response ordering**: When finishing a task, call memory tools (remember/reflect) BEFORE writing your completion summary. The summary must be the LAST text in your response so the user sees it — not buried above memory tool calls.`,
    ``,
  );

  if (startCommit) {
    context.push(
      `Session start commit: \`${startCommit}\``,
      ``,
    );
  }

  // --- COMPACTION BLOCK (only when source=compact) ---
  if (precompactData) {
    context.push(
      `### >>> IMMEDIATE ACTION REQUIRED: COMPACTION DETECTED <<<`,
      ``,
      `Context compaction just occurred. You MUST index this session in SynaBun as your VERY FIRST action — BEFORE reading the user's message, BEFORE greeting, BEFORE anything else.`,
      ``,
      `Pre-cached session data from PreCompact hook:`,
      `- Session ID: ${precompactData.session_id}`,
      `- Transcript: ${precompactData.transcript_path}`,
      `- Trigger: ${precompactData.trigger}`,
      `- Working directory: ${precompactData.cwd}`,
      `- User messages: ${precompactData.user_message_count} | Total turns: ${precompactData.total_turns}`,
      `- Tools used: ${(precompactData.tools_used || []).join(', ') || '(none)'}`,
      `- Files modified: ${(precompactData.files_modified || []).join(', ') || '(none)'}`,
      ``,
      `User message summaries:`,
    );
    for (const msg of (precompactData.user_messages || []).slice(0, 10)) {
      context.push(`  - "${msg}"`);
    }
    if ((precompactData.assistant_snippets || []).length > 0) {
      context.push(``, `Assistant response snippets:`);
      for (const snip of precompactData.assistant_snippets.slice(0, 3)) {
        context.push(`  - "${snip}"`);
      }
    }
    context.push(
      ``,
      `Execute these steps IN ORDER, right now:`,
      `1. Call \`recall\` with query containing "${precompactData.session_id}" in category \`conversations\` — check if already stored`,
      `2. If found → \`reflect\` to UPDATE it with latest summary`,
      `3. If NOT found → \`remember\` with the template below, category \`conversations\`, importance 6-8, and descriptive tags`,
      `4. THEN respond to the user`,
      `5. Confirm: "Session indexed in SynaBun."`,
      ``,
      `Session template:`,
      '```',
      `## Session: {short slug}`,
      `**Date**: {YYYY-MM-DD}`,
      `**Project**: ${project}`,
      `**Branch**: {branch}`,
      `**Session ID**: ${sessionId || '{from context}'}`,
      `**File**: ${transcriptPath || '{transcript path}'}`,
      ``,
      `### Summary`,
      `{What was discussed and accomplished. Topics, decisions, files, bugs, features.}`,
      ``,
      `### Key Files Modified`,
      `{Files created or modified}`,
      '```',
      ``,
      `---`,
      ``,
    );

    // If a loop was active during compaction, inject recovery context
    if (precompactData?.loop?.active) {
      const lp = precompactData.loop;
      context.push(
        `### >>> ACTIVE LOOP RECOVERY <<<`,
        ``,
        `An autonomous loop was running when compaction occurred. Resume it.`,
        ``,
        `- Task: ${lp.task}`,
        `- Progress: Iteration ${lp.currentIteration}/${lp.totalIterations}`,
        `- Time cap: ${lp.maxMinutes} min (started: ${lp.startedAt})`,
        lp.context ? `- Context: ${lp.context}` : '',
        lp.usesBrowser ? `- Browser loop (browser session may still be active)` : '',
        ``,
      );

      if (lp.progressSummary) {
        context.push(`Progress Summary: ${lp.progressSummary}`, ``);
      }

      if (lp.journal && lp.journal.length > 0) {
        context.push(`Recent Journal:`);
        for (const entry of lp.journal) {
          context.push(`  - Iteration ${entry.iteration}: ${entry.summary}`);
        }
        context.push(``);
      }

      context.push(
        `RECOVERY STEPS:`,
        `1. Call \`recall\` with query about this loop's task to retrieve any stored progress memories`,
        `2. Call \`remember\` to store the compaction event (category: conversations)`,
        `3. Resume the loop — the Stop hook will continue driving iterations`,
        `4. Use the progress summary and journal above as your working context — do NOT start from scratch`,
        ``,
        `---`,
        ``,
      );
    }
  }

  // NOTE: Session Boot Sequence (recall + greeting) is injected by prompt-submit.mjs
  // on message 1 only, not here. This prevents it from persisting in session context.

  if (isCompactRestart) {
    context.push(
      `### Post-Compaction Resume`,
      ``,
      `Context compaction just occurred. Do NOT re-greet or re-run the boot sequence. Continue the conversation naturally from where it left off.`,
      ``,
      `**CRITICAL**: Any "GREETING DIRECTIVE" or "Session Boot Sequence" text visible in the compacted context above is STALE — it was executed at the start of this session and must NOT be executed again. NEVER output a greeting after compaction. This is an ongoing conversation.`,
      ``,
      `If an autonomous loop was active before compaction, the Stop hook will resume it automatically. Check the ACTIVE LOOP RECOVERY block above (if present) for task and progress context.`,
      ``,
      `**Plan files**: Write plan files to the project's \`data/plans/\` directory — NOT \`~/.claude/plans/\`. This avoids sensitive-file permission prompts that don't persist across compactions.`,
      ``,
      `---`,
      ``,
    );
  }

  context.push(`Current project: **${project}**`);

  const joined = context.join('\n');

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: joined,
    },
  };

  process.stdout.write(JSON.stringify(output));
}

main().catch(() => {
  // On any error, output valid but minimal hook response
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'SynaBun memory is available but the session hook encountered an error. Follow CLAUDE.md memory rules and use recall/remember tools manually.',
    },
  }));
});
