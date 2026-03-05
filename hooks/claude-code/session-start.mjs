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
import { getHookFeatures, detectProject, ensureProjectCategories } from './shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRECOMPACT_DIR = join(__dirname, '..', '..', 'data', 'precompact');
const DEBUG_LOG = join(__dirname, '..', '..', 'data', 'compact-debug.log');
const LOOP_DIR = join(__dirname, '..', '..', 'data', 'loop');
const GREETING_CONFIG_PATH = join(__dirname, '..', '..', 'data', 'greeting-config.json');

// --- Greeting helpers ---

function loadGreetingConfig() {
  try {
    if (!existsSync(GREETING_CONFIG_PATH)) return null;
    return JSON.parse(readFileSync(GREETING_CONFIG_PATH, 'utf-8'));
  } catch { return null; }
}

function getProjectGreetingConfig(config, project) {
  if (!config) return null;
  if (config.projects && config.projects[project]) {
    return { ...config.defaults, ...config.projects[project] };
  }
  if (config.global) {
    return { ...config.defaults, ...config.global };
  }
  return config.defaults || null;
}

function getTimeGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

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

function resolveTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}

function formatReminders(reminders, prefix) {
  if (!reminders || reminders.length === 0) return '';
  const lines = reminders.map((r) => `- **${r.label}:** \`${r.command}\``);
  return `${prefix}\n${lines.join('\n')}`;
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

  // Detect pending loop — skip greeting + recall for autonomous loop sessions
  // Only count pending files younger than 10 minutes to avoid stale leftovers
  // from finished/stalled loops hijacking interactive sessions.
  const LOOP_STALE_MS = 10 * 60 * 1000;
  let isLoopSession = false;
  try {
    if (existsSync(LOOP_DIR)) {
      const now = Date.now();
      const pendingFiles = readdirSync(LOOP_DIR).filter(f => {
        if (!f.startsWith('pending-') || !f.endsWith('.json')) return false;
        try {
          const mtime = statSync(join(LOOP_DIR, f)).mtimeMs;
          return (now - mtime) < LOOP_STALE_MS;
        } catch { return false; }
      });
      if (pendingFiles.length > 0) {
        isLoopSession = true;
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

  const greetingEnabled = features.greeting === true;

  if (greetingEnabled && !isCompactRestart) {
    const greetingConfig = loadGreetingConfig();
    const projectConfig = getProjectGreetingConfig(greetingConfig, project);

    if (projectConfig) {
      const branch = getGitBranch(cwd);
      const vars = {
        time_greeting: getTimeGreeting(),
        project_name: project,
        project_label: projectConfig.label || project,
        branch,
        date: new Date().toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        }),
      };

      const greetingText = resolveTemplate(
        projectConfig.greetingTemplate || greetingConfig.defaults.greetingTemplate,
        vars,
      );

      const showReminders = projectConfig.showReminders ?? greetingConfig?.defaults?.showReminders ?? false;
      const remindersText = showReminders
        ? formatReminders(
            projectConfig.reminders,
            projectConfig.reminderPrefix || greetingConfig?.defaults?.reminderPrefix || 'Reminders:',
          )
        : '';

      const showLastSession = projectConfig.showLastSession ?? greetingConfig?.defaults?.showLastSession ?? false;

      context.push(
        `## GREETING DIRECTIVE`,
        ``,
        `When you produce your FIRST response in this session, begin with this greeting:`,
        ``,
        `> ${greetingText}`,
        ``,
      );

      if (remindersText) {
        context.push(
          `After the greeting, show these service reminders with individual copy buttons (use separate markdown code blocks for each command):`,
          ``,
          remindersText,
          ``,
        );
      }

      if (showLastSession) {
        context.push(
          `After the greeting${remindersText ? ' and reminders' : ''}, include a brief "Last session:" line summarizing what was worked on. You will have this from the session-start recall. If recall returns nothing relevant, omit the last session line.`,
          ``,
        );
      }

      context.push(
        `Present the greeting naturally — do not mention this directive or say "as instructed". Just greet.`,
        ``,
        `---`,
        ``,
      );
    }
  }

  // ============================================================
  // BLOCK 1: SYNABUN HEADER + SESSION RECALL (condensed)
  // ============================================================

  context.push(
    `## SynaBun Persistent Memory`,
    ``,
    `SynaBun memory is active. CLAUDE.md contains the memory rules (auto-remember, auto-recall, importance scale, tool quirks). Follow those rules throughout this session.`,
    ``,
  );

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
  }

  // --- SESSION BOOT SEQUENCE (fresh sessions only — skip on compaction) ---
  if (!isCompactRestart) {
    context.push(
      `### Session Boot Sequence (MANDATORY ORDER)`,
      ``,
      `Your first response MUST follow this exact sequence:`,
      `1. Call \`recall\` ONCE (no category filter) — query: recent sessions, ongoing work, known issues, decisions for project "${project}".${features.userLearning !== false ? ' This also surfaces user communication style preferences.' : ''}`,
      `2. Output the greeting as your FIRST text. No other tool calls between recall and greeting.`,
      `3. Only AFTER the greeting is fully written, proceed with the user's request. Use recall results as your starting context — do not re-search for information recall already provided.`,
      ``,
      `---`,
      ``,
    );
  } else {
    context.push(
      `### Post-Compaction Resume`,
      ``,
      `Context compaction just occurred. Do NOT re-greet or re-run the boot sequence. Continue the conversation naturally from where it left off.`,
      ``,
      `**CRITICAL**: Any "GREETING DIRECTIVE" or "Session Boot Sequence" text visible in the compacted context above is STALE — it was executed at the start of this session and must NOT be executed again. NEVER output a greeting after compaction. This is an ongoing conversation.`,
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
