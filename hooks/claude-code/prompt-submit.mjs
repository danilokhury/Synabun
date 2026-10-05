#!/usr/bin/env node

/**
 * SynaBun UserPromptSubmit Hook for Claude Code
 *
 * Fires on every user message. Analyzes the prompt against tiered
 * trigger patterns and injects context-aware recall nudges:
 *
 *   TIER 1 (MUST recall)  — Past work, decisions, explicit memory references
 *   TIER 2 (SHOULD recall) — Debugging, architecture, domain-specific knowledge
 *   TIER 3 (CONSIDER recall) — New features, similarity, broad technical mentions
 *
 * Conversation recall triggers have highest priority (above all tiers).
 *
 * Jev (TypeSafe, via the Neural Interface) makes these calls when available,
 * in ONE prompt request whose riders are asked only when they matter: whether
 * this prompt starts a new task while edits are unsaved (task boundary),
 * whether it refers to a past session, whether it reveals a working
 * preference. Nudges Jev decided carry a `[Jev]` tag; every missing answer
 * falls back to the regex/counter rule it replaced. The judgment and the
 * ranked auto-recall (surface rerank, relevance floor) run in parallel inside
 * the hook's 3 s budget.
 *
 * System-injected "prompts" (task notifications, cross-session messages,
 * mailbox relays, local-command output, continuation banners) are skipped
 * entirely: no judgment, recall, message count or regex (prompt-origin.mjs).
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withStateLock, writeJsonAtomic } from './state.mjs';
import { startTaskTurn } from './task-gate.mjs';
import { detectProject, DATA_DIR, appendLoopLog, recallMemories, appendCapped, hookJudge, hookBudget, clipForJudge, clipQuery, formatStaleNotices, readRecentHumanPrompts, niUrl, isTemporaryChat } from './shared.mjs';
import { classifyPrompt, isTrivialPrompt } from './prompt-origin.mjs';

// Cross-platform safety: catch uncaught errors and output valid hook JSON
process.on('uncaughtException', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
process.on('unhandledRejection', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });

// UserPromptSubmit has 3 s. Node startup counts against it.
const budget = hookBudget(3000);

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_FEATURES_PATH = join(DATA_DIR, 'hook-features.json');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
const LOOP_DIR = join(DATA_DIR, 'loop');
const GREETING_CONFIG_PATH = join(DATA_DIR, 'greeting-config.json');

// --- Greeting helpers (moved from session-start.mjs) ---

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

/**
 * Build the full greeting directive + boot sequence for message 1.
 * Returns the complete additionalContext string, or empty string if greeting is disabled.
 */
function buildGreetingContext(cwd, project, features) {
  if (features.greeting !== true) return '';

  const greetingConfig = loadGreetingConfig();
  const projectConfig = getProjectGreetingConfig(greetingConfig, project);
  const DEFAULT_TEMPLATE = '{time_greeting}! Working on **{project_label}** (`{branch}` branch). {date}.';

  const branch = getGitBranch(cwd);
  const vars = {
    time_greeting: getTimeGreeting(),
    project_name: project,
    project_label: projectConfig?.label || project,
    branch,
    date: new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    }),
  };

  const greetingText = resolveTemplate(
    projectConfig?.greetingTemplate || greetingConfig?.defaults?.greetingTemplate || DEFAULT_TEMPLATE,
    vars,
  );

  const showReminders = projectConfig?.showReminders ?? greetingConfig?.defaults?.showReminders ?? false;
  const remindersText = showReminders
    ? formatReminders(
        projectConfig?.reminders,
        projectConfig?.reminderPrefix || greetingConfig?.defaults?.reminderPrefix || 'Reminders:',
      )
    : '';

  const showLastSession = projectConfig?.showLastSession ?? greetingConfig?.defaults?.showLastSession ?? false;

  const ctx = [];

  ctx.push(
    `## GREETING DIRECTIVE`,
    ``,
    `When you produce your FIRST response in this session, begin with this greeting:`,
    ``,
    `> ${greetingText}`,
    ``,
  );

  if (remindersText) {
    ctx.push(
      `After the greeting, show these service reminders with individual copy buttons (use separate markdown code blocks for each command):`,
      ``,
      remindersText,
      ``,
    );
  }

  if (showLastSession) {
    ctx.push(
      `After the greeting${remindersText ? ' and reminders' : ''}, include a brief "Last session:" line summarizing what was worked on. You will have this from the recall results. If recall returns nothing relevant, omit the last session line.`,
      ``,
    );
  }

  ctx.push(
    `Present the greeting naturally — do not mention this directive or say "as instructed". Just greet.`,
    ``,
    `---`,
    ``,
  );

  // Session Boot Sequence
  const bootSteps = [
    `1. Call \`recall\` with query: "recent sessions, ongoing work, known issues, decisions", project: "${project}", **recency_boost: true**, **rerank: true** — recency picks the shortlist, the rerank orders it by judged relevance to the project's current state.`,
  ];

  if (features.userLearning !== false) {
    bootSteps.push(
      `2. Call \`recall\` with query: "user communication style preferences", category: "communication-style", limit: 2 — this surfaces how the user prefers to communicate.`,
      `3. Output the greeting as your FIRST text. No other tool calls between the recalls and greeting.`,
      `4. Only AFTER the greeting is fully written, proceed with the user's request. Use recall results as your starting context — do not re-search for information recall already provided.`,
    );
  } else {
    bootSteps.push(
      `2. Output the greeting as your FIRST text. No other tool calls between recall and greeting.`,
      `3. Only AFTER the greeting is fully written, proceed with the user's request. Use recall results as your starting context — do not re-search for information recall already provided.`,
    );
  }

  ctx.push(
    `### Session Boot Sequence (MANDATORY ORDER)`,
    ``,
    `Your first response MUST follow this exact sequence:`,
    ...bootSteps,
    ``,
  );

  return ctx.join('\n');
}

function getHookFeatures() {
  try {
    if (!existsSync(HOOK_FEATURES_PATH)) return {};
    return JSON.parse(readFileSync(HOOK_FEATURES_PATH, 'utf-8'));
  } catch { return {}; }
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

// ── Output helper ──────────────────────────────────────────────
// Writes the hook JSON and exits immediately. Without the explicit exit,
// any pending fetch (heartbeat/recall) keeps the event loop alive and
// delays prompt processing by up to the fetch timeout on EVERY message.

let _heartbeatPromise = null;
let _dispatchDirective = '';
const DISPATCH_DIRECTIVE = 'Before composing or launching any Task/Agent subagent (including Explore and general-purpose), complete an explicit, task-focused SynaBun recall. Tool discovery is allowed if needed to make recall callable. Do not launch recall and subagents in the same parallel batch. Fold relevant exact file paths, prior fixes, and constraints into each subagent prompt so it searches narrowly. Automatic Related Memories context helps focus this lookup; it does not replace explicit recall.';

async function emitAndExit(obj) {
  if (_dispatchDirective && obj && typeof obj === 'object') {
    const previous = obj.hookSpecificOutput?.additionalContext || '';
    obj = { ...obj, hookSpecificOutput: { ...obj.hookSpecificOutput,
      hookEventName: 'UserPromptSubmit', additionalContext: [previous, _dispatchDirective].filter(Boolean).join('\n\n') } };
  }
  // Give an in-flight heartbeat a short window to land (localhost: ~5ms)
  if (_heartbeatPromise) {
    try {
      const wait = Math.max(0, Math.min(300, budget.remaining() - 50));
      await Promise.race([_heartbeatPromise, new Promise(r => setTimeout(r, wait))]);
    } catch { /* heartbeat is best-effort */ }
  }
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
  process.stdout.write(json, () => process.exit(0));
  setTimeout(() => process.exit(0), 250); // failsafe if the write callback never fires
}

/**
 * The whole hook for a temporary chat: the human's words as one memory search,
 * with no session beside them and no judgment (typesafeOff() is true for the
 * marker), and the Related Memories block as the only context. A trivial or
 * system prompt searches nothing.
 */
async function temporaryChatPrompt(prompt, project) {
  let context = '';
  try {
    const origin = classifyPrompt(prompt);
    const text = origin.origin === 'system' ? '' : String(origin.text || '');
    if (text.trim() && !isTrivialPrompt(text)) {
      context = await recallMemories({ query: clipQuery(text), project, limit: 3, minScore: 0.4, tokenBudget: 600, timeoutMs: 2000 }) || '';
    }
  } catch { context = ''; }
  await emitAndExit(context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : {});
}

// ── Loop helper functions ──────────────────────────────────────

/**
 * Extract formatting/style rules from the task text into a separate block.
 * Matches lines containing prohibitions about dashes, emojis, spam, double posting, etc.
 */
function extractFormattingRules(task) {
  if (!task) return '';
  const rules = [];
  let hasDashRule = false;
  for (const line of task.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/\b(do not|don'?t|never|must not|avoid)\b/i.test(t) &&
        /\b(dash|--|—|emoji|emote|emojis|spam|double post|over use)\b/i.test(t)) {
      rules.push(t.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, ''));
      if (/dash|--/i.test(t)) hasDashRule = true;
    }
  }
  // Strengthen dash rule with explicit variants
  if (hasDashRule) {
    rules.push('NEVER use double dashes (--), em dashes (\u2014), or en dashes (\u2013) in ANY text you write. Use commas, periods, or semicolons instead.');
  }
  if (rules.length === 0) return '';
  return rules.map(r => `- ${r}`).join('\n');
}

function buildBrowserNote(state) {
  if (!state.usesBrowser) return '';
  const lines = [
    '',
    '=== BROWSER ENFORCEMENT (MANDATORY) ===',
    'This automation REQUIRES the SynaBun internal browser. You MUST:',
  ];
  // HTTP MCP is shared across all loops — env-var pinning does NOT route tool calls.
  // Claude must pass sessionId/tabId explicitly on every browser tool call, or a
  // concurrent loop will hijack the tab.
  if (state.browserSessionId) {
    lines.push(`YOUR BROWSER SESSION: ${state.browserSessionId}`);
    if (state.browserTabId) {
      lines.push(`YOUR BROWSER TAB: ${state.browserTabId}`);
    }
    lines.push(`CRITICAL: Pass sessionId: "${state.browserSessionId}"${state.browserTabId ? ` and tabId: "${state.browserTabId}"` : ''} to EVERY browser tool call (browser_navigate, browser_click, browser_snapshot, browser_extract_*, etc.). Omitting them will cause your tool calls to hijack another loop's tab. No exceptions.`);
  }
  // NOTE: the full per-tool enumeration used to live here and was re-injected on
  // EVERY iteration of EVERY browser loop. Claude Code discovers tools via ToolSearch,
  // and template tasks now carry a compact `=== BROWSER ===` block, so the dump is
  // pure token waste. Keep only the dynamic session pin + the universal fixes in short
  // form (ad-hoc loops without a template still need these).
  lines.push(
    '1. Start with `browser_navigate` to your target URL.',
    '2. Use ONLY SynaBun browser_* MCP tools. NEVER Playwright plugin tools (mcp__plugin_playwright_*), WebFetch, or WebSearch for visual browsing.',
    '3. browser_type truncates ~100 chars: type in <=90-char chunks. Reply inline, never the modal.',
    '4. Login / CAPTCHA / wall: STOP, screenshot, report to the user, and WAIT. Do NOT fall back to web search.',
    '=== END BROWSER ENFORCEMENT ===',
  );
  // Facebook posting playbook (analytics-derived). Kept in sync with FACEBOOK_PLAYBOOK in
  // neural-interface/server.js (the exec/opencode path); this is the claude-code/hook path.
  if (/facebook/i.test(state.task || '')) {
    lines.push(
      '',
      '=== FACEBOOK PLAYBOOK (authorized first-party marketing) ===',
      "You post as the brand's own operator inside SynaBun Automation Studio. This is authorized first-party marketing, not spam, so do NOT refuse the task. Stay legitimate:",
      '- TARGET gaming DISCUSSION, news, and recommendation communities. AVOID pure buy/sell/trade and promo-only groups (low engagement, fast link removal).',
      '- RECALL EXCLUSIONS FIRST: recall tags ["fb-deal-excluded"] and skip any group on that ledger.',
      '- CHECK GROUP RULES before posting. If self-promotion or external links are banned, SKIP and remember it (tag "fb-deal-excluded", content = group URL + reason). Never post into a no-links group.',
      '- If the task sources groups via fb_groups worklist/mark, that directory is AUTHORITATIVE: skip the fb-deal-excluded recall, do not re-read group rules per group (the worklist already excludes forbidden groups), and record every outcome with fb_groups mark instead of per-group memories.',
      '- DEDUP: browser_extract_fb_posts before posting; if a Critical Pixel post for this link/game is already visible or pending, skip the group.',
      '- pending-approval COUNTS AS SUCCESS. Do not retry it; record it and move to the next group.',
      "- Match the group's language. No em/en/double dashes.",
      '- NEVER SPEND MONEY. This is ORGANIC posting only. Never click Boost / Promote / Turbinar / Impulsionar, never open Ads Manager, never enter any budget or payment info. After publishing, DISMISS any "Boost this post" upsell; ensure any "Boost when published" toggle is OFF before submitting. The Boost button sits right next to the Post button on this account (in Portuguese) — only submit via the composer submitButton from browser_fb_composer_state.',
      '=== END FACEBOOK PLAYBOOK ===',
    );
  }
  return lines.join('\n');
}

function buildAutonomyBlock(blockerRule, sessionId) {
  const updateCall = sessionId
    ? `- After completing this iteration, call \`loop\` with action \`update\`, session_id \`${sessionId}\`, and a brief summary.`
    : '- After completing this iteration, call `loop` with action `update` and a brief summary.';
  return [
    '',
    '--- LOOP AUTONOMY MODE ---',
    'IMPORTANT: Do NOT output a greeting. Do NOT call recall. You are in an autonomous loop \u2014 execute the task below immediately.',
    '',
    'Rules for this session:',
    '- Execute the task directly. Do NOT ask for confirmation or clarification.',
    '- Make reasonable assumptions and proceed. Do not hesitate.',
    '- Use all available tools (browser, memory, file system) as needed without asking.',
    '- Each iteration should produce concrete output or progress.',
    '- If something fails due to a technical issue, try an alternative approach.',
    updateCall,
    '- The server will automatically advance to the next iteration when you finish.',
    blockerRule || '',
    '--- END LOOP AUTONOMY ---',
  ].filter(Boolean).join('\n');
}

function buildJournalBlock(state) {
  const parts = [];
  if (state.progressSummary) {
    parts.push(`PROGRESS SO FAR: ${state.progressSummary}`);
  }
  const journal = Array.isArray(state.journal) ? state.journal : [];
  const recent = journal.slice(-3);
  if (recent.length > 0) {
    parts.push('RECENT ITERATIONS:');
    for (const entry of recent) {
      parts.push(`  Iteration ${entry.iteration}: ${entry.summary}`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : '';
}

/**
 * Find an active loop owned by this session (exact file name match only).
 * Does NOT scan other sessions' loop files — cross-session injection is
 * the source of loop leaks between concurrent Claude panels/TUI sessions.
 * Returns the loop state, or null if this session has no active loop.
 */
function findActiveLoop(sessionId) {
  try {
    const exactPath = join(LOOP_DIR, `${sessionId}.json`);
    if (!existsSync(exactPath)) return null;
    const candidate = JSON.parse(readFileSync(exactPath, 'utf-8'));
    if (!candidate.active) return null;
    // Skip loops inactive for >45 minutes (stuck)
    const lastAct = new Date(candidate.lastIterationAt || candidate.startedAt || 0).getTime();
    if (Date.now() - lastAct > 45 * 60 * 1000) return null;
    return candidate;
  } catch { return null; }
}

// ============================================================
// TIER 1 — MUST recall (high confidence: past work, decisions, explicit memory)
// These indicate the user is referencing prior context that memory likely holds.
// Threshold: >= 1 match fires. Nudge: mandatory.
// ============================================================

const TIER1_TRIGGERS = [
  // Explicit past work references
  /\b(last time|before we|previously|earlier we|remember when|we (did|had|tried|used|decided|chose))\b/i,
  /\b(why (did|do) we|what happened (to|with)|what was the)\b/i,
  /\b(history|context) (of|about|for|on)\b/i,

  // Decision recall
  /\bshould (we|i) (use|go with|pick|choose|switch|keep|change|stick with)\b/i,
  /\bwhat('s| is| was) the (best|right|correct|agreed|chosen) (approach|way|method|pattern)\b/i,
  /\bwhat did we (decide|agree|settle) on\b/i,

  // Explicit memory/recall references
  /\b(do you remember|check (your )?memory|what do you know about|recall what)\b/i,
  /\b(we (already|previously) (fixed|solved|handled|addressed|implemented))\b/i,
];

// ============================================================
// TIER 2 — SHOULD recall (medium confidence: debugging, architecture, domains)
// These suggest memory might hold relevant context. Worth checking.
// Threshold: >= 1 match fires. Nudge: strong suggestion.
// ============================================================

const TIER2_TRIGGERS = [
  // Debugging (likely to have past bug context)
  /\b(bug|error|broken|crash|not working|doesn't work|keeps? (failing|breaking))\b/i,
  /\b(debug|troubleshoot|investigate|diagnose|root cause)\b/i,

  // Architecture & structural changes
  /\b(refactor|restructur|migrat|upgrad|deprecat)\b/i,
  /\b(architect|redesign|rearchitect)\b/i,

  // Decision-making questions (broader than Tier 1)
  /\bwhat('s| is) the (best|right|correct|proper) way to\b/i,
  /\bhow (should|do) (we|i) (handle|approach|structure|organize)\b/i,

  // Specific technical domains that accumulate knowledge
  /\b(supabase|redis|upstash|sqlite)\b/i,
  /\b(auth(entication|orization)?|session handling|jwt|mfa)\b/i,
  /\b(cron job|ranking|price aggregat|deal(s)? (system|pipeline))\b/i,
];

// ============================================================
// TIER 3 — CONSIDER recall (lower confidence: new features, broad tech)
// These MIGHT benefit from memory but often don't. Requires 2+ matches
// from this tier, OR 1 Tier 3 + 1 Tier 2 to fire. Nudge: soft.
// ============================================================

const TIER3_TRIGGERS = [
  // New features (might conflict with past decisions)
  /\b(implement|integrate) (a |the |new )?\w+/i,
  /\bnew (feature|component|page|endpoint|hook|service)\b/i,

  // Building on existing patterns
  /\bsimilar to (the|what|how)\b/i,
  /\bsame (as|way|pattern|approach) (as |we )?\b/i,
  /\bconsistent with\b/i,

  // Broad technical domains
  /\b(database|cache|caching) (schema|strategy|layer|issue)\b/i,
  /\b(api|endpoint) (design|structure|pattern)\b/i,
  /\b(deploy|deployment|ci\/cd|pipeline) (strategy|process|config)\b/i,
  /\b(config|configuration) (for|of|pattern)\b/i,
];

// ============================================================
// CONVERSATION RECALL TRIGGERS (highest priority — above all tiers)
// ============================================================

const CONVERSATION_RECALL_TRIGGERS = [
  /\bremember that (conversation|session|chat|discussion|time)\b/i,
  /\bthat (conversation|session|chat) (about|where|when)\b/i,
  /\b(days?|weeks?) ago.*(conversation|session|worked on|discussed|implemented|built)/i,
  /\bcontinue (where we left off|that session|from last time|from yesterday)\b/i,
  /\bwhat did we (talk|discuss|work on|do|build|implement|fix) (last|yesterday|on|the other)/i,
  /\bfind that (session|conversation|chat) (where|about|when|from)\b/i,
  /\bpick up (where|from) (we|last|that)/i,
  /\b(yesterday|last week|other day).*(session|conversation|worked|discussed|implemented)/i,
];

// Messages that never need recall: isTrivialPrompt() in prompt-origin.mjs
// (whole-string patterns; the old prefix patterns here dropped prompts such as
// "no, the bug is in X" before any judgment or recall).

// ============================================================
// NUDGE TEMPLATES
// ============================================================

// Nudges whose decision came from Jev say so.
const jev = (text) => `[Jev] ${text}`;

const NUDGE = {
  pendingRemember: (editCount, files) => {
    const fileList = files.length > 0
      ? ` Files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}.`
      : '';
    const urgency = editCount >= 5
      ? `CRITICAL: ${editCount} file edits`
      : editCount >= 3
        ? `IMPORTANT: ${editCount} file edits`
        : `${editCount} file edit${editCount !== 1 ? 's' : ''}`;
    return [
      `SynaBun TASK BOUNDARY: ${urgency} from your previous work have NOT been stored in memory.`,
      `You MUST call \`remember\` for that completed work BEFORE starting this new task.${fileList}`,
      `Summarize what was done, why, and how — then proceed with the user's new request.`,
    ].join(' ');
  },

  conversation: [
    `The user is asking about a past conversation. Follow the Conversation Recall Workflow:`,
    `1. Calculate exact dates from relative references (e.g., "4 days ago" → compute the date).`,
    `2. Call \`recall\` with category \`conversations\` and include the topic + calculated date in your query.`,
    `3. Present matching conversations via AskUserQuestion with date, project, and summary for each.`,
    `4. After selection, offer recovery options: "Recover entire context and continue", "Continue with compacted summary", or "Other".`,
  ].join(' '),

  tier1: [
    `You MUST call \`recall\` before responding or making any task-related tool call, including launching Task/Agent/Explore subagents. Tool discovery needed to make recall callable is allowed.`,
    `The user is referencing past work, prior decisions, or historical context that your persistent memory likely holds.`,
    `Search for: the specific topic mentioned, related past decisions, known issues, or prior implementations.`,
    `Do NOT respond without checking memory first.`,
  ].join(' '),

  tier2: [
    `Before responding or making any task-related tool call, including launching Task/Agent/Explore subagents, call \`recall\` for relevant context. Tool discovery needed to make recall callable is allowed.`,
    `This topic likely has prior knowledge stored — past bugs, architecture decisions, or domain-specific patterns.`,
    `Skip recall only if you already have full context from this session.`,
  ].join(' '),

  tier3: [
    `Consider calling \`recall\` to check if there's relevant prior context about this topic.`,
    `There may be past decisions or patterns worth reviewing before proceeding.`,
  ].join(' '),

  nonEnglish: [
    `The user's message is in a non-English language. Mentally translate their intent to evaluate if you should call \`recall\`.`,
    `Check if they are: referencing past work, asking about prior decisions, debugging an issue, or working in a domain where you have stored knowledge.`,
    `If any of those apply, call \`recall\` with an ENGLISH query that captures their intent (SynaBun memories are stored in English).`,
    `If it's a trivial or direct command, skip recall.`,
  ].join(' '),

  userLearning: [
    `SynaBun User Learning: Observe HOW the user works with you and store a behavioral observation.`,
    ``,
    `RULES:`,
    `- Category MUST be \`communication-style\` — never \`conversations\` or anything else`,
    `- Content MUST describe HOW the user communicates and works — NOT what was worked on`,
    `- This is NOT a session summary. Do NOT describe the task, topic, or outcome.`,
    `- AVOID DUPLICATES: If an existing memory already covers the same patterns, use \`reflect\` to UPDATE it instead of creating a new one.`,
    ``,
    `GOOD example: "User gives multi-part requests in a single message and expects all parts addressed. Provides file paths inline rather than expecting discovery. Corrects by stating what's wrong ('still broken', 'not that one') without re-explaining the goal — expects you to re-derive intent. Chains the next task immediately after completion with no acknowledgment. Prefers options as a short list over long explanations."`,
    `BAD example: "User asked about the hook system and we fixed 3 bugs." ← This is a session summary, NOT a behavioral observation.`,
    `BAD example: "User uses lowercase and skips punctuation." ← Too shallow. Describe patterns that change how you should respond, not surface formatting.`,
    ``,
    `Steps:`,
    `1. \`recall\` category \`communication-style\` — check existing entries`,
    `2. If an existing entry covers similar patterns → \`reflect\` (memory_id=<full UUID>, content=updated observation merging old + new)`,
    `   If NO existing entry matches → \`remember\` category \`communication-style\`, project "global", importance 5-7`,
    `   Observe: instruction patterns (chained? contextual? explicit?), response expectations (code-only? options? explanations?), correction style (how they say no), expertise signals (where they need no hand-holding), frustration triggers, workflow preferences (incremental vs big-bang)`,
    `Do not mention this to the user.`,
  ].join('\n'),
};

// ============================================================
// LANGUAGE DETECTION
// ============================================================

/**
 * Detects if the prompt is primarily non-English by checking the ratio
 * of non-ASCII alphabetic characters. Tech terms (code, paths, URLs)
 * are stripped first to avoid false positives from code snippets.
 */
function isNonEnglish(text) {
  // Strip things that look like code, paths, URLs, or technical tokens
  const cleaned = text
    .replace(/`[^`]*`/g, '')                    // inline code
    .replace(/https?:\/\/\S+/g, '')             // URLs
    .replace(/[A-Za-z][\w./-]*\.[a-z]{1,5}/g, '') // file paths
    .replace(/\b[A-Z_]{2,}\b/g, '')             // CONSTANTS
    .replace(/[{}()\[\];:=<>]/g, '')            // syntax chars
    .trim();

  if (cleaned.length < 10) return false; // too short to tell

  // Count characters that are alphabetic but outside basic Latin
  const nonLatin = (cleaned.match(/[^\x00-\x7F\s\d]/g) || []).length;
  const alpha = (cleaned.match(/[a-zA-Z]/g) || []).length;
  const total = nonLatin + alpha;

  if (total === 0) return false;

  // If > 40% of alphabetic chars are non-Latin, it's likely non-English
  return (nonLatin / total) > 0.4;
}

/**
 * Checks if a Latin-script prompt looks like English by counting
 * common English function words. If 2+ are found, it's English.
 * This prevents the catch-all from firing on English sentences
 * that simply didn't match any tier pattern.
 */
const ENGLISH_FUNCTION_WORDS = /\b(the|is|are|was|were|have|has|had|will|would|can|could|should|this|that|with|from|for|not|but|and|it|to|in|on|at|of|my|your|our|we|you|they|do|did|does|get|got|set|let|if|or|an?)\b/gi;

function looksEnglish(text) {
  const matches = text.match(ENGLISH_FUNCTION_WORDS) || [];
  return matches.length >= 2;
}

// ============================================================
// MAIN
// ============================================================

// Max user-learning nudges per session (overridable via hook-features.json)
const USER_LEARNING_MAX_NUDGES_DEFAULT = 3;
// Human messages required between two user-learning nudges.
const USER_LEARNING_MIN_GAP = 3;

/**
 * Debug logger for user-learning nudge diagnostics.
 */
const UL_DEBUG = join(DATA_DIR, 'user-learning-debug.log');
function debugUL(msg) {
  try { appendCapped(UL_DEBUG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* best effort */ }
}

/**
 * Whether a user-learning nudge may fire at all right now, whatever decides
 * it. `total` counts human messages this session (system prompts never count).
 */
function userLearningGate(features, sessionId, flag) {
  if (features.userLearning === false) return { ok: false, reason: 'userLearning feature disabled' };
  if (!sessionId) return { ok: false, reason: 'no sessionId' };
  if (!flag || typeof flag !== 'object') return { ok: false, reason: 'no flag' };
  const total = flag.totalSessionMessages || flag.messageCount || 0;
  const nudgeCount = flag.userLearningNudgeCount || 0;
  const maxNudges = features.userLearningMaxNudges || USER_LEARNING_MAX_NUDGES_DEFAULT;
  const threshold = features.userLearningThreshold || 8;
  const lastAt = Number.isFinite(flag.userLearningLastNudgeAt) ? flag.userLearningLastNudgeAt : null;
  const state = { total, nudgeCount, maxNudges, threshold, lastAt, sinceLast: total - (lastAt ?? 0) };
  // If a style observation was already stored/updated this session, skip further nudges
  if (flag.userLearningObserved) return { ok: false, reason: 'userLearningObserved=true (already stored this session)', ...state };
  if (nudgeCount >= maxNudges) return { ok: false, reason: `max nudges reached (${nudgeCount} >= ${maxNudges})`, ...state };
  return { ok: true, ...state };
}

/**
 * Decide, record and return a user-learning nudge (call under the state lock).
 *   reveals === true   Jev saw a working preference in this prompt: nudge when
 *                      ≥3 human messages passed since the last nudge
 *   reveals === false  Jev saw none: no nudge
 *   reveals === null   not judged: nudge at threshold multiples (3, 6, 9…)
 * Returns nudge text or empty string.
 */
function checkUserLearning(features, sessionId, reveals = null) {
  if (features.userLearning === false) {
    debugUL(`SKIP: userLearning feature disabled`);
    return '';
  }
  if (!sessionId) {
    debugUL(`SKIP: no sessionId`);
    return '';
  }
  const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
  if (!existsSync(flagPath)) {
    debugUL(`SKIP: flag file not found at ${flagPath}`);
    return '';
  }

  let flag;
  try {
    flag = JSON.parse(readFileSync(flagPath, 'utf-8'));
  } catch (e) {
    debugUL(`SKIP: failed to parse flag file: ${e.message}`);
    return '';
  }

  const gate = userLearningGate(features, sessionId, flag);
  debugUL(`CHECK: session=${sessionId.slice(0, 8)}... msgCount=${gate.total} threshold=${gate.threshold} nudgeCount=${gate.nudgeCount} maxNudges=${gate.maxNudges} observed=${!!flag.userLearningObserved} judged=${reveals}`);
  if (!gate.ok) {
    debugUL(`SKIP: ${gate.reason}`);
    return '';
  }
  if (reveals === false) {
    debugUL(`SKIP: judged: this prompt reveals no working preference`);
    return '';
  }
  if (reveals === true) {
    if (gate.sinceLast < USER_LEARNING_MIN_GAP) {
      debugUL(`SKIP: judged preference, but only ${gate.sinceLast} messages since the last nudge`);
      return '';
    }
  } else {
    if (gate.total < gate.threshold) {
      debugUL(`SKIP: msgCount ${gate.total} < threshold ${gate.threshold}`);
      return '';
    }
    const expectedNudges = Math.floor(gate.total / gate.threshold);
    if (expectedNudges <= gate.nudgeCount) {
      debugUL(`SKIP: expectedNudges ${expectedNudges} <= nudgeCount ${gate.nudgeCount}`);
      return '';
    }
    if (gate.lastAt !== null && gate.sinceLast < USER_LEARNING_MIN_GAP) {
      debugUL(`SKIP: only ${gate.sinceLast} messages since the last nudge`);
      return '';
    }
  }

  debugUL(`FIRE: nudge #${gate.nudgeCount + 1} (${reveals === true ? 'judged' : 'count'})`);

  // Persist nudge count + pending flag (best-effort — don't block nudge on write failure)
  flag.userLearningNudgeCount = gate.nudgeCount + 1;
  flag.userLearningPending = true;
  flag.userLearningLastNudgeAt = gate.total;
  try {
    writeJsonAtomic(flagPath, flag);
    debugUL(`PERSIST: nudgeCount saved as ${gate.nudgeCount + 1}`);
  } catch (e) {
    debugUL(`PERSIST FAILED (nudge still fires): ${e.message}`);
  }

  // First nudge: full instructions. Subsequent: short reminder.
  const text = gate.nudgeCount === 0
    ? NUDGE.userLearning
    : `SynaBun User Learning reminder: You've had ${gate.total} exchanges. If you've noticed new behavioral patterns (how they give instructions, correct you, make decisions, or signal frustration), call \`recall\` category \`communication-style\` — then \`reflect\` to update an existing entry, or \`remember\` only if genuinely new. Do NOT create duplicates. Do NOT store surface-level formatting observations.`;
  return reveals === true ? jev(text) : text;
}

// ============================================================
// AUTO-RECALL — Hook-side memory injection
// Calls NI server to fetch relevant memories for the user's prompt
// and formats them for injection into additionalContext.
// ============================================================

function readContextGeneration(sessionId) {
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return undefined;
  try { return JSON.parse(readFileSync(join(DATA_DIR, 'memory-context', sessionId + '.json'), 'utf8')).generation; } catch { return undefined; }
}

function readFlag(sessionId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId || '')) return null;
  try { return JSON.parse(readFileSync(join(PENDING_REMEMBER_DIR, `${sessionId}.json`), 'utf-8')); } catch { return null; }
}

// The previous human prompt, for the task-boundary question. The transcript
// may or may not already hold the current prompt, so skip an exact repeat.
function previousHumanPrompt(transcriptPath, current) {
  try {
    const now = String(current || '').trim();
    return readRecentHumanPrompts(transcriptPath, 2).find((p) => p.trim() !== now) || '';
  } catch { return ''; }
}

// Fallback for the task boundary when it was not judged: unsaved edits from
// a turn that reached Stop. When the edits are newer than the last Stop, the
// turn was interrupted (Claude Code runs no Stop after an interrupt) and this
// prompt is most likely a correction of that same work.
function stopCameAfterEdits(flag) {
  const stop = Date.parse(flag?.lastStopAt || '');
  const edit = Date.parse(flag?.lastEditAt || '');
  return Number.isFinite(stop) && Number.isFinite(edit) && stop >= edit;
}

async function main() {
  let prompt = '';
  let sessionId = '';
  let cwd = '';
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
    prompt = typeof input.prompt === 'string' ? input.prompt : '';
    sessionId = input.session_id || '';
    cwd = input.cwd || '';
  } catch { /* proceed with empty */ }

  const trimmed = prompt.trim();
  const project = detectProject(cwd);

  // A temporary chat (see isTemporaryChat): related memories are still read
  // into the prompt. Nothing is counted, flagged, judged or gated, and the
  // session is named to nobody.
  if (isTemporaryChat()) { await temporaryChatPrompt(prompt, project); return; }

  // Reset before greeting, trivial-message, and loop early returns.
  try { startTaskTurn(input); } catch { /* gate state is best-effort */ }
  if (!input.agent_id && /^[a-zA-Z0-9_-]+$/.test(sessionId) && typeof input.prompt === 'string'
    && getHookFeatures().taskRecallGate !== false) _dispatchDirective = DISPATCH_DIRECTIVE;

  // Session heartbeat to Neural Interface session monitor (best-effort).
  // Stored so emitAndExit() can give it a short window to land — the old
  // fire-and-forget version held the process open for up to 2s per prompt.
  if (sessionId) {
    try {
      _heartbeatPromise = fetch(`${niUrl()}/api/sessions/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claudeSessionId: sessionId }),
        signal: AbortSignal.timeout(600),
      }).catch(() => {});
    } catch { /* ok */ }
  }

  // --- Loop marker detection (BEFORE greeting — loops must bypass greeting) ---
  const terminalSessionEnv = process.env.SYNABUN_TERMINAL_SESSION || '';
  if (terminalSessionEnv) {
    appendLoopLog(terminalSessionEnv, 'prompt-submit:enter', 'UserPromptSubmit fired inside loop terminal', {
      sessionId, isLoopMarker: /^\[SynaBun Loop\]/i.test(trimmed), promptPreview: trimmed.slice(0, 200),
    });
  }
  if (sessionId && /^\[SynaBun Loop\]/i.test(trimmed)) {
    try {
      if (existsSync(LOOP_DIR)) {
        const pending = readdirSync(LOOP_DIR)
          .filter(f => f.startsWith('pending-') && f.endsWith('.json'));
        // STRICT multi-loop isolation: only claim a pending file whose
        // terminalSessionId matches our SYNABUN_TERMINAL_SESSION env.
        // Legacy "match first pending" fallback was removed — it silently
        // stole loops across concurrent sessions (sidepanel plan ↔ scheduled
        // CLI loop in same cwd). Loop spawners MUST set the env var.
        // Legacy pending files without terminalSessionId are still claimable
        // when this session also has no env (ancient manual-loop compat).
        let matchedPending = null;
        for (const pf of pending) {
          try {
            const ps = JSON.parse(readFileSync(join(LOOP_DIR, pf), 'utf-8'));
            if (terminalSessionEnv) {
              if (ps.terminalSessionId === terminalSessionEnv) { matchedPending = pf; break; }
            } else {
              if (!ps.terminalSessionId) { matchedPending = pf; break; }
            }
          } catch { continue; }
        }
        if (matchedPending) {
          const pendingPath = join(LOOP_DIR, matchedPending);
          const targetPath = join(LOOP_DIR, `${sessionId}.json`);
          renameSync(pendingPath, targetPath);
          appendLoopLog(terminalSessionEnv, 'prompt-submit:claim', 'pending loop renamed to active', { from: matchedPending, to: `${sessionId}.json` });

          const state = JSON.parse(readFileSync(targetPath, 'utf-8'));
          delete state.pending;
          // Set currentIteration to 1 immediately — closes the race window where
          // another session's stop hook fallback scan (which only matches
          // currentIteration === 0) could steal this loop file.
          state.currentIteration = 1;
          // Preserve terminalSessionId — loop driver needs it for session isolation
          writeJsonAtomic(targetPath, state);
          appendLoopLog(terminalSessionEnv, 'prompt-submit:inject', 'iteration 1 context built — emitting additionalContext', { task: state.task?.slice(0, 200), totalIterations: state.totalIterations, usesBrowser: !!state.usesBrowser });

          const browserNote = buildBrowserNote(state);
          const blockerRule = state.usesBrowser
            ? '- CRITICAL: If the browser shows a login page, CAPTCHA, 2FA, or ANY wall requiring human action — STOP IMMEDIATELY. Output what the user needs to do (e.g. "Please log into Twitter in the browser panel"). Do NOT use WebSearch, WebFetch, or any workaround. Do NOT try to bypass it. Just STOP and WAIT.'
            : '';
          const autonomy = buildAutonomyBlock(blockerRule, sessionId);

          // Extract formatting rules and place them prominently
          const formattingRules = extractFormattingRules(state.task);
          const fmtBlock = formattingRules
            ? `\n=== FORMATTING RULES (MANDATORY \u2014 EVERY ITERATION) ===\n${formattingRules}\n=== END FORMATTING RULES ===\n`
            : '';

          await emitAndExit({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: `${fmtBlock}SynaBun Loop ACTIVE: ${state.totalIterations} iterations (${state.totalIterations - 1} remaining).\nTask: ${state.task}${state.context ? `\nContext: ${state.context}` : ''}${browserNote}\n\nBegin iteration 1 immediately.${autonomy}`,
            },
          });
          return;
        }

        // Case 2: Subsequent iteration — find any active loop state file (after /clear)
        // Note: /clear may change the session ID, so we can't match by sessionId alone.
        // Scan for any active loop with currentIteration > 0.
        let existingPath = join(LOOP_DIR, `${sessionId}.json`);
        let state = null;
        if (existsSync(existingPath)) {
          try { state = JSON.parse(readFileSync(existingPath, 'utf-8')); } catch { /* skip */ }
        }
        // Fallback: scan loop files for an active loop (session ID may have changed after /clear).
        // STRICT isolation: only match our terminal's loop.
        //   - env set → require exact terminalSessionId match
        //   - env unset → only match loops WITHOUT terminalSessionId (legacy manual loops)
        // Previously the filter was disabled when env was empty, letting any
        // Claude session grab any active loop in the same LOOP_DIR.
        if (!state?.active || !(state?.currentIteration > 0)) {
          const now = Date.now();
          const allLoopFiles = readdirSync(LOOP_DIR)
            .filter(f => f.endsWith('.json') && !f.startsWith('pending-'));
          for (const f of allLoopFiles) {
            try {
              const fullPath = join(LOOP_DIR, f);
              const candidate = JSON.parse(readFileSync(fullPath, 'utf-8'));
              if (candidate.active && candidate.currentIteration > 0) {
                // Multi-loop isolation
                if (terminalSessionEnv) {
                  if (candidate.terminalSessionId !== terminalSessionEnv) continue;
                } else {
                  if (candidate.terminalSessionId) continue;
                }
                // Validate the loop hasn't exceeded its own time cap + grace
                // Skip loops inactive for >45 minutes (stuck)
                const lastAct = new Date(candidate.lastIterationAt || candidate.startedAt || 0).getTime();
                if (now - lastAct > 45 * 60 * 1000) continue;
                state = candidate;
                existingPath = fullPath;
                break;
              }
            } catch { /* skip corrupt */ }
          }
        }
        if (state?.active && state?.currentIteration > 0) {
            appendLoopLog(terminalSessionEnv, 'prompt-submit:inject', 'subsequent iteration context built', { iter: state.currentIteration, total: state.totalIterations, usesBrowser: !!state.usesBrowser });
            const formattingRules = extractFormattingRules(state.task);
            const browserNote = buildBrowserNote(state);
            const blockerRule2 = state.usesBrowser
              ? '- CRITICAL: If the browser shows a login page, CAPTCHA, 2FA, or ANY wall requiring human action — STOP IMMEDIATELY. Output what the user needs to do. Do NOT use WebSearch, WebFetch, or any workaround. Just STOP and WAIT.'
              : '';
            const autonomy2 = buildAutonomyBlock(blockerRule2, sessionId);
            const journal = buildJournalBlock(state);
            const iterationsRemaining = (state.totalIterations || 10) - (state.currentIteration || 0);

            const parts = [
              // Memory rules (session-start won't re-inject after /clear)
              'SynaBun memory is active. Follow the SynaBun rules in your instructions.',
              '',
            ];

            // Formatting rules — FIRST, most prominent position
            if (formattingRules) {
              parts.push(
                '=== FORMATTING RULES (MANDATORY \u2014 EVERY ITERATION) ===',
                formattingRules,
                '=== END FORMATTING RULES ===',
                '',
              );
            }

            parts.push(
              `SynaBun Loop ACTIVE: Iteration ${state.currentIteration}/${state.totalIterations} (${iterationsRemaining} remaining).`,
              `Task: ${state.task}`,
            );
            if (state.context) parts.push(`Context: ${state.context}`);

            // Journal + progress
            if (journal) parts.push('', journal);

            // Browser enforcement
            if (browserNote) parts.push(browserNote);

            parts.push(
              '',
              `Begin iteration ${state.currentIteration} immediately.`,
              autonomy2,
            );

            await emitAndExit({
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: parts.filter(Boolean).join('\n'),
              },
            });
            return;
          }
        }
    } catch { /* fall through to normal processing */ }
  }

  // Native sidepanel loops receive the complete iteration prompt directly from
  // the server-owned SDK runtime. Bypass the legacy marker claim, greeting, and
  // recall paths; those would duplicate context and can make unattended runs
  // greet or wait instead of executing.
  if (terminalSessionEnv && !/^\[SynaBun Loop\]/i.test(trimmed)) {
    try {
      const nativePath = join(LOOP_DIR, `${terminalSessionEnv}.json`);
      if (existsSync(nativePath)) {
        const nativeLoop = JSON.parse(readFileSync(nativePath, 'utf-8'));
        if (nativeLoop.active && nativeLoop.driverType === 'native'
          && nativeLoop.terminalSessionId === terminalSessionEnv) {
          appendLoopLog(terminalSessionEnv, 'prompt-submit:native', 'native loop prompt accepted without legacy hook injection', {
            sessionId,
            iteration: nativeLoop.currentIteration || 0,
          });
          await emitAndExit({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: 'Native SynaBun loop: execute the complete server-provided iteration prompt immediately. Do not greet, ask questions, enter plan mode, or wait for interactive input.',
            },
          });
          return;
        }
      }
    } catch { /* fall through to ordinary hook behavior */ }
  }

  // --- Who wrote this "prompt"? ---
  // Task notifications, cross-session/teammate messages, mailbox relays,
  // local-command output and continuation banners are not the human: no
  // judgment, no recall, no message count, no regex. The task turn was
  // already started above and emitAndExit still appends the dispatch
  // directive, exactly as before.
  const origin = classifyPrompt(prompt);
  if (origin.origin === 'system') {
    await emitAndExit({});
    return;
  }
  // The assistant brain recalls in-process (assistant-memory.js); running here too injected every memory twice and paid Jev twice.
  if (process.env.SYNABUN_ASSISTANT_SESSION) {
    await emitAndExit({});
    return;
  }
  // The human's own words, with IDE/hook wrappers removed.
  const text = origin.text;

  // --- Active loop detection for non-loop-marker messages ---
  // When user sends a regular message during an active browser loop, inject
  // loop context so Claude knows where it was, and sync the session ID file.
  let activeLoopNotice = '';
  if (sessionId && !/^\[SynaBun Loop\]/i.test(trimmed)) {
    const activeLoop = findActiveLoop(sessionId);
    if (activeLoop) {
      const journal = buildJournalBlock(activeLoop);
      const iterLeft = (activeLoop.totalIterations || 10) - (activeLoop.currentIteration || 0);
      const browserNote = activeLoop.usesBrowser ? buildBrowserNote(activeLoop) : '';
      const parts = [
        `=== ACTIVE LOOP NOTICE ===`,
        `You are mid-loop: Iteration ${activeLoop.currentIteration}/${activeLoop.totalIterations} (${iterLeft} iterations remaining).`,
        `Task: ${activeLoop.task}`,
      ];
      if (activeLoop.context) parts.push(`Context: ${activeLoop.context}`);
      if (journal) parts.push('', journal);
      parts.push(
        '',
        `The user sent a message. Respond to it, then call \`loop\` action \`update\` with your current progress, then continue the loop task from where you left off.`,
      );
      if (browserNote) parts.push(browserNote);
      parts.push(`=== END LOOP NOTICE ===`);
      activeLoopNotice = parts.filter(p => p !== undefined).join('\n');
    }
  }

  // --- Track message count (BEFORE the trivial check — every human message counts) ---
  let currentMessageCount = 0;
  let greetingContext = "";
  let flag = null; // snapshot after this message was counted
  if (/^[a-zA-Z0-9_-]+$/.test(sessionId) && text.length > 0) {
    try {
      withStateLock(() => {
        const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
        if (!existsSync(PENDING_REMEMBER_DIR)) mkdirSync(PENDING_REMEMBER_DIR, { recursive: true });
        let current = { editCount: 0, retries: 0, files: [], messageCount: 0 };
        if (existsSync(flagPath)) {
          try { current = JSON.parse(readFileSync(flagPath, 'utf-8')); } catch { /* start fresh */ }
        }
        current.messageCount = (current.messageCount || 0) + 1;
        current.totalSessionMessages = (current.totalSessionMessages || 0) + 1;
        currentMessageCount = current.messageCount;
        if (!current.firstMessageAt) current.firstMessageAt = new Date().toISOString();
        current.lastMessageAt = new Date().toISOString();
        try { writeJsonAtomic(flagPath, current); } catch { /* ok */ }

        // --- Greeting injection (first message only) ---
        // The full greeting directive + boot sequence is built HERE (not in session-start)
        // so it only appears in context for message 1 and never persists.
        if (current.messageCount === 1 && !current.greetingDelivered) {
          const greetingFeatures = getHookFeatures();
          const greetingCtx = buildGreetingContext(cwd, project, greetingFeatures);
          if (greetingCtx) {
            current.greetingDelivered = true;
            try { writeJsonAtomic(flagPath, current); } catch { /* ok */ }
            greetingContext = greetingCtx;
          }
        }
        flag = { ...current };
      }, { timeoutMs: 500 });
    } catch { flag = readFlag(sessionId); /* contended: judge with what is on disk */ }
  }

  if (greetingContext) {
    await emitAndExit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
      additionalContext: greetingContext + '\nIf the user message is just a greeting, the greeting is your full response.' } });
    return;
  }

  // Skip trivial messages first (fastest path). Whole-string patterns only.
  if (isTrivialPrompt(text)) {
    await emitAndExit({});
    return;
  }

  const features = getHookFeatures();

  // --- What to ask Jev (one request; riders only when they can matter) ---
  const editCount = Number(flag?.editCount) || 0;
  const files = Array.isArray(flag?.files) ? flag.files.filter((f) => typeof f === 'string') : [];
  const hasUnsaved = !!sessionId && editCount >= 1;
  const conversationOn = features.conversationMemory !== false;
  const ulGate = userLearningGate(features, sessionId, flag);
  const ask = {};
  if (hasUnsaved) ask.new_task = true;
  if (conversationOn) ask.past_session = true;
  if (ulGate.ok && ulGate.sinceLast >= USER_LEARNING_MIN_GAP) ask.reveals_preference = true;
  let unsavedWork;
  if (ask.new_task) {
    unsavedWork = { files: files.slice(0, 10), edit_count: editCount };
    const previous = previousHumanPrompt(input.transcript_path, text);
    if (previous) unsavedWork.previous_prompt = previous.slice(0, 1000);
  }

  // The judgment and the ranked recall run side by side, each bounded by what
  // is left of the 3 s budget (typical ≈1 s, worst case ≈2.2 s).
  const callMs = Math.min(2000, budget.callTimeout(250));
  const judgmentRequest = hookJudge('prompt', {
    text: clipForJudge(text), project,
    session_id: sessionId || undefined, cwd: cwd || undefined,
    ask: Object.keys(ask).length ? ask : undefined,
    unsaved_work: unsavedWork,
  }, { timeoutMs: callMs });

  // When greeting is enabled, message 1 gets recall via the boot sequence in buildGreetingContext().
  // When greeting is disabled, message 1 has no recall at all — so fire auto-recall on message 1 too.
  const greetingEnabled = features.greeting === true;
  const autoRecallMinMessage = greetingEnabled ? 2 : 1;
  const staleShown = Array.isArray(flag?.staleShown) ? flag.staleShown.filter((id) => typeof id === 'string') : [];
  const recallRequest = (!activeLoopNotice && currentMessageCount >= autoRecallMinMessage)
    ? recallMemories({
      query: clipQuery(text), project, sessionId, contextGeneration: readContextGeneration(sessionId),
      limit: 3, minScore: 0.4, tokenBudget: 600, timeoutMs: callMs, budgetMs: callMs,
      // Jev ranks the shortlist and the floor drops what it judged irrelevant.
      // Memories are never dropped here after the fact: the server has already
      // recorded them as delivered in the injection ledger.
      surface: 'rerank', floor: true,
      // Edit-time stale verdicts ride along; the ones the Stop hook already
      // showed are acknowledged instead of shown twice.
      wantStale: true, staleAck: staleShown,
      returnMeta: true,
    })
    : Promise.resolve(null);

  const [judged, recall] = await Promise.all([judgmentRequest, recallRequest]);

  // --- Collect primary context from priority chain ---
  let primaryContext = '';
  let primaryKind = '';

  // Priority 0: TASK BOUNDARY — unsaved edits and a new task.
  //   newTask true  → nudge ([Jev]);  false → none (a correction or follow-up)
  //   not judged    → nudge only if a Stop came after the edits
  if (hasUnsaved) {
    if (judged.newTask === true) {
      primaryContext = jev(NUDGE.pendingRemember(editCount, files));
      primaryKind = 'boundary';
    } else if (typeof judged.newTask !== 'boolean' && stopCameAfterEdits(flag)) {
      primaryContext = NUDGE.pendingRemember(editCount, files);
      primaryKind = 'boundary';
    }
  }

  // Priority 1: Conversation recall. The judgment wins; the English-only
  // regexes are the fallback.
  if (!primaryContext && conversationOn) {
    if (typeof judged.pastSession === 'boolean') {
      if (judged.pastSession) { primaryContext = jev(NUDGE.conversation); primaryKind = 'conversation'; }
    } else if (CONVERSATION_RECALL_TRIGGERS.some(p => p.test(text))) {
      primaryContext = NUDGE.conversation;
      primaryKind = 'conversation';
    }
  }

  // Priorities 2-6: would searching memory first change the answer?
  //
  // One judgment replaces the Tier1/2/3 regex ladder and both non-English
  // catch-alls. The ladder could only match phrasings someone thought to
  // enumerate, and the language tests were proxies for "this prompt is in a
  // language our triggers don't cover" — a judgment reads intent directly, in
  // any language, so the separate language priorities are no longer needed.
  // The regex ladder stays as the fallback when the judgment is unavailable.
  if (!primaryContext) {
    const { urgency } = judged;
    if (urgency === 'must') { primaryContext = jev(NUDGE.tier1); primaryKind = 'tier1'; }
    else if (urgency === 'should') { primaryContext = jev(NUDGE.tier2); primaryKind = 'tier2'; }
    else if (urgency === 'consider') { primaryContext = jev(NUDGE.tier3); primaryKind = 'tier3'; }
    else if (!urgency) {
      if (TIER1_TRIGGERS.some(p => p.test(text))) { primaryContext = NUDGE.tier1; primaryKind = 'tier1'; }
      else if (TIER2_TRIGGERS.some(p => p.test(text))) { primaryContext = NUDGE.tier2; primaryKind = 'tier2'; }
      else if (TIER3_TRIGGERS.filter(p => p.test(text)).length >= 2) { primaryContext = NUDGE.tier3; primaryKind = 'tier3'; }
      else if (isNonEnglish(text)) { primaryContext = NUDGE.nonEnglish; primaryKind = 'nonEnglish'; }
      else if (text.length > 30 && !looksEnglish(text)) { primaryContext = NUDGE.nonEnglish; primaryKind = 'nonEnglish'; }
    }
  }

  // --- Auto-recall: the memories injected from the NI server ---
  const autoRecallContext = recall?.context || '';
  if (autoRecallContext && ['tier1', 'tier2', 'tier3'].includes(primaryKind)) {
    primaryContext = 'Relevant SynaBun context is available in the Related Memories block. Use it to focus your explicit task recall before composing subagent prompts, then include the exact file paths, prior fixes, and constraints in each prompt.';
  }

  // --- Stale memories flagged by edit-time checks (not already shown at Stop) ---
  const alreadyShown = new Set(staleShown);
  const staleContext = formatStaleNotices((recall?.stale || []).filter((v) => !alreadyShown.has(v.memory_id)));

  // --- User Learning (independent — appends to any primary context) ---
  const reveals = typeof judged.revealsPreference === 'boolean' ? judged.revealsPreference : null;
  let userLearningContext = "";
  try {
    userLearningContext = withStateLock(() => {
      // The Stop hook's stale ids were acknowledged by the recall above.
      if (recall?.responded && staleShown.length) {
        const current = readFlag(sessionId);
        if (current && Array.isArray(current.staleShown)) {
          current.staleShown = current.staleShown.filter((id) => !alreadyShown.has(id));
          try { writeJsonAtomic(join(PENDING_REMEMBER_DIR, `${sessionId}.json`), current); } catch { /* ok */ }
        }
      }
      return checkUserLearning(features, sessionId, reveals);
    }, { timeoutMs: Math.max(50, Math.min(500, budget.remaining() - 100)) });
  } catch { /* best effort */ }

  // --- Emit combined output ---
  // NOTE: No bootCancel needed — greeting directive is only injected on message 1
  // via buildGreetingContext(), so it never persists in session context.
  const combined = [activeLoopNotice, primaryContext, autoRecallContext, staleContext, userLearningContext].filter(Boolean).join('\n\n');

  if (combined) {
    await emitAndExit({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: combined,
      },
    });
  } else {
    await emitAndExit({});
  }
}

main().catch(() => {
  emitAndExit({});
});
