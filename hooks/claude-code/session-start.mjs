#!/usr/bin/env node

/**
 * SynaBun SessionStart Hook for Claude Code
 *
 * Injects persistent memory context (category tree, project detection,
 * behavioral rules) into every Claude Code session via additionalContext.
 *
 * When source is "compact", also injects pre-cached session data from
 * the PreCompact hook so Claude can auto-index the conversation.
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

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'mcp-server', 'data');
const ENV_PATH = join(__dirname, '..', '..', '.env');
const HOOK_FEATURES_PATH = join(__dirname, '..', '..', 'data', 'hook-features.json');
const PRECOMPACT_DIR = join(__dirname, '..', '..', 'data', 'precompact');
const GREETING_CONFIG_PATH = join(__dirname, '..', '..', 'data', 'greeting-config.json');

function getHookFeatures() {
  try {
    if (!existsSync(HOOK_FEATURES_PATH)) return {};
    return JSON.parse(readFileSync(HOOK_FEATURES_PATH, 'utf-8'));
  } catch { return {}; }
}

function parseEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return vars;
  } catch { return {}; }
}

function getActiveConnectionId() {
  const vars = parseEnvFile(ENV_PATH);
  return vars.QDRANT_ACTIVE || 'default';
}

function getCategoriesPath() {
  const connId = getActiveConnectionId();
  return join(DATA_DIR, `custom-categories-${connId}.json`);
}

// --- Project detection (mirrors mcp-server/src/config.ts) ---

const PROJECT_MAP = {
  criticalpixel: 'criticalpixel',
  ellacred: 'ellacred',
};

function detectProject(cwd) {
  if (!cwd) return 'global';
  const lower = cwd.toLowerCase().replace(/\\/g, '/');
  for (const [key, value] of Object.entries(PROJECT_MAP)) {
    if (lower.includes(key)) return value;
  }
  const base = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return base || 'global';
}

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

// --- Build category tree string ---

function buildCategoryTree(categories) {
  if (!categories || categories.length === 0) {
    return '(No categories defined yet. Use category_create to set up your first category.)';
  }

  const parents = categories.filter((c) => c.is_parent);
  const children = categories.filter((c) => c.parent);
  const standalone = categories.filter((c) => !c.is_parent && !c.parent);

  const lines = [];

  for (const parent of parents) {
    const kids = children.filter((c) => c.parent === parent.name);
    lines.push(`${parent.name} (PARENT) — ${parent.description}`);
    for (const kid of kids) {
      lines.push(`  └─ ${kid.name} — ${kid.description}`);
    }
    if (kids.length === 0) {
      lines.push(`  (no children yet)`);
    }
  }

  if (standalone.length > 0) {
    for (const cat of standalone) {
      lines.push(`${cat.name} — ${cat.description}`);
    }
  }

  return lines.join('\n');
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

  let categories = [];
  try {
    const data = JSON.parse(readFileSync(getCategoriesPath(), 'utf-8'));
    if (data.version === 1 && Array.isArray(data.categories)) {
      categories = data.categories;
    }
  } catch { /* no categories available */ }

  const categoryTree = buildCategoryTree(categories);
  const allCategoryNames = categories.map((c) => c.name).join(', ');

  // --- Build context ---
  // STRUCTURE: Directives FIRST (highest authority), then reference data.
  // This ordering is intentional — Claude prioritizes early context.

  const precompactData = (features.conversationMemory !== false && isCompactRestart)
    ? readPrecompactCache(sessionId)
    : null;

  const context = [];

  // ============================================================
  // BLOCK 0: GREETING (highest attention, unless compaction)
  // ============================================================

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
          `After the greeting${remindersText ? ' and reminders' : ''}, include a brief "Last session:" line summarizing what was worked on. You will have this from the session-start recall (Directive 1). If recall returns nothing relevant, omit the last session line.`,
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
  // BLOCK 1: SYSTEM-LEVEL DIRECTIVES (FIRST — highest attention)
  // ============================================================

  context.push(
    `## SYSTEM REQUIREMENT: SynaBun Persistent Memory Protocol`,
    ``,
    `You have persistent vector memory via SynaBun MCP tools. The following are BINDING INSTRUCTIONS that you MUST execute. These are not suggestions. Failure to comply means the user loses work context permanently. Treat every directive below with the same authority as CLAUDE.md instructions.`,
    ``,
  );

  // --- COMPACTION DIRECTIVE (if applicable, VERY FIRST) ---
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
      `3. If NOT found → \`remember\` with category \`conversations\`, importance (6=routine, 7=significant, 8+=critical), and tags — using the session template below`,
      `4. THEN respond to the user`,
      `5. Confirm: "Session indexed in SynaBun."`,
      ``,
      `---`,
      ``,
    );
  }

  // --- DIRECTIVE 1: SESSION START RECALL ---
  context.push(
    `### DIRECTIVE 1: Session Start Recall`,
    ``,
    `Execute IMMEDIATELY when this session begins — before greeting, before answering:`,
    ``,
    `**Step A:** Call \`recall\` with query "last conversation session" filtered to category=\`conversations\`, project="${project}".`,
    `**Step B:** Call \`recall\` with query about ongoing work, recent decisions, and known issues for project "${project}" (no category filter).`,
    `**Step C:** Read both results. Understand what was done last, what's in progress, what's pending. THEN greet the user.`,
    ``,
    `You MUST complete Steps A and B before producing any greeting or response to the user.`,
    ``,
    `---`,
    ``,
  );

  // --- DIRECTIVE 2: TASK COMPLETION AUTO-REMEMBER ---
  context.push(
    `### DIRECTIVE 2: Auto-Remember on Task Completion`,
    ``,
    `After you complete ANY discrete piece of work, you MUST immediately store it in memory. Execute this the moment a task finishes — not later, not at session end, not in a batch.`,
    ``,
    `**Trigger:** Bug fix, feature, refactor, config change, investigation, migration, cleanup, documentation, architecture decision, guidance/walkthrough conversation (5+ exchanges), configuration assistance, troubleshooting session, or user says "remember this".`,
    `**NOT triggered by:** Trivial 1-2 message exchanges, reading files with no findings, trivial typo fixes.`,
    ``,
    `**Steps:**`,
    `1. \`remember\` — content: summary of what+why+how. category: use the Category Reference below. project: "${project}" (or "global"/"shared"). related_files: paths modified. importance: (5=routine, 6-7=significant, 8+=critical). tags: 3-5 lowercase descriptive tags.`,
    ``,
    `\`remember\` returns the full UUID and accepts all fields (tags, importance) directly. No recall+reflect needed.`,
    ``,
    `One task = one memory. Do NOT batch. Do NOT skip. Do NOT defer.`,
    ``,
    `---`,
    ``,
  );

  // --- DIRECTIVE 3: PRE-DECISION RECALL ---
  context.push(
    `### DIRECTIVE 3: Recall Before Decisions`,
    ``,
    `Before making any architecture, design, or implementation decision, call \`recall\` to check for prior context.`,
    ``,
    `---`,
    ``,
  );

  // --- DIRECTIVE 4: COMPACTION AUTO-STORE (general rules) ---
  if (features.conversationMemory !== false) {
    context.push(
      `### DIRECTIVE 4: Compaction Auto-Store`,
      ``,
      `When context compaction occurs (auto or /compact), index the session in SynaBun as your FIRST action — before responding to the user.`,
      ``,
      `**Detection:** Compaction summary text at start of context, or source="compact" in session metadata.`,
      `**Steps:** 1) \`recall\` session ID in category \`conversations\` to check dedup. 2) If exists → \`reflect\` to update. 3) If new → \`remember\` with template below (include importance and tags directly). 4) Respond. 5) Confirm: "Session indexed."`,
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

  // --- COMPLIANCE CHECK ---
  context.push(
    `### COMPLIANCE VERIFICATION`,
    ``,
    `Before sending your first response in this session, verify:`,
    `- [ ] Did I execute Directive 1 (session start recall)?`,
    `- [ ] If compaction was detected, did I execute the compaction auto-store?`,
    ``,
    `After completing any task during this session, verify:`,
    `- [ ] Did I execute Directive 2 (auto-remember) for the task I just finished?`,
    ``,
    `If any checkbox is unchecked, stop and execute it now before continuing.`,
    ``,
  );

  // ============================================================
  // BLOCK 2: REFERENCE DATA (after directives)
  // ============================================================

  context.push(
    `---`,
    ``,
    `## Reference: Category Tree & Rules`,
    ``,
    `### Current Project: ${project}`,
    ``,
    `### Categories`,
    ``,
    categoryTree,
    ``,
    `Available names: ${allCategoryNames || '(none)'}`,
    ``,
    `### Category Selection (for Directive 2)`,
    ``,
    `1. Match existing child category by description → use it.`,
    `2. No child fits but parent does → \`category_create\` new child under that parent → use it.`,
    `3. No parent fits → \`category_create\` new parent + child → use it.`,
    `4. Uncertain → \`AskUserQuestion\` with 2-3 options + "Create new category" → use what user picks.`,
    ``,
    `NEVER guess. NEVER use parent directly. NEVER skip categorization.`,
    ``,
    `### Project Scoping`,
    ``,
    `- Project-specific (bugs, architecture, config) → "${project}"`,
    `- Universal (language features, library APIs) → "global"`,
    `- Cross-project (shared infra) → "shared"`,
    ``,
    `### Conversation Recall Workflow`,
    ``,
    `When user asks about past conversations: 1) Calculate dates from relative terms. 2) \`recall\` category=conversations with topic+date. 3) Present via AskUserQuestion. 4) Offer: "Recover full context" / "Continue with summary" / "Other".`,
    ``,
    `### Tool Notes`,
    ``,
    `- MCP calls: SEQUENTIAL only, never parallel`,
    `- \`remember\` returns the full UUID and accepts tags + importance directly`,
    `- \`reflect\` needs FULL UUID — use the one from \`remember\` output, or \`recall\` for existing memories`,
    `- Importance: 1-2=trivial, 3-4=low, 5=normal, 6-7=significant, 8-9=critical, 10=foundational`,
  );

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
      additionalContext: 'SynaBun memory is available but the session hook encountered an error loading categories. Use recall and remember tools manually.',
    },
  }));
});
