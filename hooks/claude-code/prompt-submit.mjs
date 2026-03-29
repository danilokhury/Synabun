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
 * Lightweight — reads stdin, analyzes the prompt, outputs additionalContext
 * only when a recall-worthy signal is detected.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProject } from './shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const HOOK_FEATURES_PATH = join(DATA_DIR, 'hook-features.json');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
const LOOP_DIR = join(DATA_DIR, 'loop');

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
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 2000);
  });
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
  // Pin to dedicated browser session if available (multi-automation isolation)
  if (state.browserSessionId) {
    lines.push(`YOUR BROWSER SESSION ID: ${state.browserSessionId}`);
    lines.push('Pass sessionId: "' + state.browserSessionId + '" to ALL browser tool calls (browser_navigate, browser_click, etc.).');
  }
  lines.push(
    '1. Call `browser_navigate` with your target URL to create or reuse a browser session',
    '2. Use ONLY SynaBun MCP browser tools: browser_navigate, browser_go_back, browser_go_forward, browser_reload, browser_click, browser_fill, browser_type, browser_hover, browser_select, browser_press, browser_scroll, browser_upload, browser_snapshot, browser_content, browser_screenshot, browser_evaluate, browser_wait, browser_session, browser_extract_tweets, browser_extract_fb_posts, browser_extract_tiktok_videos, browser_extract_tiktok_search, browser_extract_tiktok_studio, browser_extract_tiktok_profile, browser_extract_wa_chats, browser_extract_wa_messages, browser_extract_ig_feed, browser_extract_ig_profile, browser_extract_ig_post, browser_extract_ig_reels, browser_extract_ig_search, browser_extract_li_feed, browser_extract_li_profile, browser_extract_li_post, browser_extract_li_notifications, browser_extract_li_messages, browser_extract_li_search_people, browser_extract_li_network, browser_extract_li_jobs',
    '3. NEVER use Playwright plugin tools (mcp__plugin_playwright_*) — they launch a separate browser that the user cannot see',
    '4. NEVER use WebFetch or WebSearch tools for tasks that require visual browsing — use the SynaBun browser instead',
    '5. If the browser shows a login page, CAPTCHA, or any wall requiring human action: STOP immediately. Report the blocker to the user and WAIT. Do NOT abandon the browser and fall back to web search. The user can interact with the browser panel to resolve it.',
    'A persistent Chrome profile is active with saved logins and cookies. The user can see and interact with the SynaBun browser panel.',
    '=== END BROWSER ENFORCEMENT ===',
  );
  return lines.join('\n');
}

function buildAutonomyBlock(blockerRule, sessionId) {
  const updateCall = sessionId
    ? `- After completing this iteration, call \`loop\` with action \`update\`, session_id \`${sessionId}\`, and a brief summary.`
    : '- After completing this iteration, call `loop` with action `update` and a brief summary.';
  return [
    '',
    '--- LOOP AUTONOMY MODE ---',
    'IMPORTANT: IGNORE any GREETING DIRECTIVE or recall instructions from SessionStart. Do NOT output a greeting. Do NOT call recall. You are in an autonomous loop \u2014 execute the task below immediately.',
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

// ============================================================
// SKIP PATTERNS — Messages that never need recall
// ============================================================

const SKIP_PATTERNS = [
  // Trivial confirmations
  /^(yes|no|ok|sure|thanks|ty|thank you|perfect|great|good|nice|cool|got it|yep|nope|nah)\b/i,
  // Continuation commands
  /^(do it|go ahead|proceed|continue|keep going|next|done|stop|cancel|abort|nevermind)\b/i,
  // Empty or whitespace
  /^\s*$/,
  // Slash commands (Claude Code handles these)
  /^\/\w+/,
  // Very short messages (< 8 chars, likely just a word)
  /^.{1,7}$/,
  // Direct file operations (no memory needed)
  /^(read|open|show|cat|look at|check) .+\.\w{1,5}$/i,
  // Run commands
  /^(run|execute|start|npm|node|git|pnpm|yarn|bun) /i,
];

// ============================================================
// NUDGE TEMPLATES
// ============================================================

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
    `You MUST call \`recall\` before responding to this message.`,
    `The user is referencing past work, prior decisions, or historical context that your persistent memory likely holds.`,
    `Search for: the specific topic mentioned, related past decisions, known issues, or prior implementations.`,
    `Do NOT respond without checking memory first.`,
  ].join(' '),

  tier2: [
    `Before responding, call \`recall\` to check your persistent memory for relevant context.`,
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

/**
 * Debug logger for user-learning nudge diagnostics.
 */
const UL_DEBUG = join(DATA_DIR, 'user-learning-debug.log');
function debugUL(msg) {
  try { appendFileSync(UL_DEBUG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* best effort */ }
}

/**
 * Check if user-learning nudge should fire.
 * Fires at threshold multiples (3, 6, 9...) up to max nudges.
 * Returns nudge text or empty string.
 */
function checkUserLearning(features, sessionId) {
  if (features.userLearning === false) {
    debugUL(`SKIP: userLearning feature disabled`);
    return '';
  }
  if (!sessionId) {
    debugUL(`SKIP: no sessionId`);
    return '';
  }

  const threshold = features.userLearningThreshold || 8;
  const maxNudges = features.userLearningMaxNudges || USER_LEARNING_MAX_NUDGES_DEFAULT;
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

  const msgCount = flag.totalSessionMessages || flag.messageCount || 0;
  const nudgeCount = flag.userLearningNudgeCount || 0;
  const observed = flag.userLearningObserved || false;

  debugUL(`CHECK: session=${sessionId.slice(0, 8)}... msgCount=${msgCount} threshold=${threshold} nudgeCount=${nudgeCount} maxNudges=${maxNudges} observed=${observed}`);

  // If a style observation was already stored/updated this session, skip further nudges
  if (observed) {
    debugUL(`SKIP: userLearningObserved=true (already stored this session)`);
    return '';
  }

  if (nudgeCount >= maxNudges) {
    debugUL(`SKIP: max nudges reached (${nudgeCount} >= ${maxNudges})`);
    return '';
  }
  if (msgCount < threshold) {
    debugUL(`SKIP: msgCount ${msgCount} < threshold ${threshold}`);
    return '';
  }

  const expectedNudges = Math.floor(msgCount / threshold);
  if (expectedNudges <= nudgeCount) {
    debugUL(`SKIP: expectedNudges ${expectedNudges} <= nudgeCount ${nudgeCount}`);
    return '';
  }

  debugUL(`FIRE: nudge #${nudgeCount + 1} (expectedNudges=${expectedNudges})`);

  // Persist nudge count + pending flag (best-effort — don't block nudge on write failure)
  flag.userLearningNudgeCount = nudgeCount + 1;
  flag.userLearningPending = true;
  try {
    writeFileSync(flagPath, JSON.stringify(flag));
    debugUL(`PERSIST: nudgeCount saved as ${nudgeCount + 1}`);
  } catch (e) {
    debugUL(`PERSIST FAILED (nudge still fires): ${e.message}`);
  }

  // First nudge: full instructions. Subsequent: short reminder.
  if (nudgeCount === 0) {
    return NUDGE.userLearning;
  }
  return `SynaBun User Learning reminder: You've had ${msgCount} exchanges. If you've noticed new behavioral patterns (how they give instructions, correct you, make decisions, or signal frustration), call \`recall\` category \`communication-style\` — then \`reflect\` to update an existing entry, or \`remember\` only if genuinely new. Do NOT create duplicates. Do NOT store surface-level formatting observations.`;
}

// ============================================================
// AUTO-RECALL — Hook-side memory injection
// Calls NI server to fetch relevant memories for the user's prompt
// and formats them for injection into additionalContext.
// ============================================================

function formatAge(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

async function autoRecall(prompt, cwd) {
  try {
    const niUrl = process.env.SYNABUN_NI_URL || 'http://localhost:3344';
    const project = detectProject(cwd);

    const resp = await fetch(`${niUrl}/api/hook-recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: prompt,
        project: project !== 'global' ? project : undefined,
        limit: 3,
        min_score: 0.4,
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!resp.ok) return '';
    const data = await resp.json();
    if (!data.results || data.results.length === 0) return '';

    const lines = data.results.map((r, i) => {
      const score = (r.score * 100).toFixed(0);
      const age = formatAge(r.created_at);
      const tags = r.tags?.length ? `Tags: ${r.tags.join(', ')}` : '';
      const files = r.related_files?.length ? `Files: ${r.related_files.slice(0, 3).join(', ')}` : '';
      const details = [tags, files].filter(Boolean).join(' | ');
      return `${i + 1}. [${r.category} | importance ${r.importance}, ${age}, ${score}% match] ${r.content}${details ? `\n   ${details}` : ''}`;
    });

    return [
      '=== SynaBun: Related Memories ===',
      ...lines,
      'These memories may be relevant. Use as context — call recall for deeper search if needed.',
      '=== End Memories ===',
    ].join('\n');
  } catch {
    // NI down, timeout, or error — silently skip
    return '';
  }
}

async function main() {
  let prompt = '';
  let sessionId = '';
  let cwd = '';
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    prompt = input.prompt || '';
    sessionId = input.session_id || '';
    cwd = input.cwd || '';
  } catch { /* proceed with empty */ }

  const trimmed = prompt.trim();

  // Session heartbeat to Neural Interface session monitor (fire-and-forget)
  if (sessionId) {
    const niUrl = process.env.SYNABUN_NI_URL || 'http://localhost:3344';
    try {
      fetch(`${niUrl}/api/sessions/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claudeSessionId: sessionId }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    } catch { /* ok */ }
  }

  // --- Loop marker detection (BEFORE greeting — loops must bypass greeting) ---
  const terminalSessionEnv = process.env.SYNABUN_TERMINAL_SESSION || '';
  if (sessionId && /^\[SynaBun Loop\]/i.test(trimmed)) {
    try {
      if (existsSync(LOOP_DIR)) {
        const pending = readdirSync(LOOP_DIR)
          .filter(f => f.startsWith('pending-') && f.endsWith('.json'));
        // Filter by terminalSessionId when available (multi-loop isolation).
        // Without the env var, fall back to first match (legacy behavior).
        let matchedPending = null;
        if (terminalSessionEnv) {
          for (const pf of pending) {
            try {
              const ps = JSON.parse(readFileSync(join(LOOP_DIR, pf), 'utf-8'));
              if (ps.terminalSessionId === terminalSessionEnv) { matchedPending = pf; break; }
            } catch { continue; }
          }
        } else if (pending.length > 0) {
          matchedPending = pending[0];
        }
        if (matchedPending) {
          const pendingPath = join(LOOP_DIR, matchedPending);
          const targetPath = join(LOOP_DIR, `${sessionId}.json`);
          renameSync(pendingPath, targetPath);

          const state = JSON.parse(readFileSync(targetPath, 'utf-8'));
          delete state.pending;
          // Set currentIteration to 1 immediately — closes the race window where
          // another session's stop hook fallback scan (which only matches
          // currentIteration === 0) could steal this loop file.
          state.currentIteration = 1;
          // Preserve terminalSessionId — loop driver needs it for session isolation
          writeFileSync(targetPath, JSON.stringify(state, null, 2));

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

          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: `${fmtBlock}SynaBun Loop ACTIVE: ${state.totalIterations} iterations (${state.totalIterations - 1} remaining).\nTask: ${state.task}${state.context ? `\nContext: ${state.context}` : ''}${browserNote}\n\nBegin iteration 1 immediately.${autonomy}`,
            },
          }));
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
        // When SYNABUN_TERMINAL_SESSION is set, only match loops owned by this terminal.
        // Without the env var, fall back to first active loop (legacy behavior).
        if (!state?.active || !(state?.currentIteration > 0)) {
          const now = Date.now();
          const allLoopFiles = readdirSync(LOOP_DIR)
            .filter(f => f.endsWith('.json') && !f.startsWith('pending-'));
          for (const f of allLoopFiles) {
            try {
              const fullPath = join(LOOP_DIR, f);
              const candidate = JSON.parse(readFileSync(fullPath, 'utf-8'));
              if (candidate.active && candidate.currentIteration > 0) {
                // Multi-loop isolation: only match OUR terminal's loop
                if (terminalSessionEnv && candidate.terminalSessionId && candidate.terminalSessionId !== terminalSessionEnv) continue;
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
              'SynaBun memory is active. CLAUDE.md contains the memory rules. Follow them.',
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

            process.stdout.write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: parts.filter(Boolean).join('\n'),
              },
            }));
            return;
          }
        }
    } catch { /* fall through to normal processing */ }
  }

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

  // --- Track message count (BEFORE skip check — all messages count) ---
  let currentMessageCount = 0;
  if (sessionId && trimmed.length > 0) {
    const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (!existsSync(PENDING_REMEMBER_DIR)) mkdirSync(PENDING_REMEMBER_DIR, { recursive: true });
    let flag = { editCount: 0, retries: 0, files: [], messageCount: 0 };
    if (existsSync(flagPath)) {
      try { flag = JSON.parse(readFileSync(flagPath, 'utf-8')); } catch { /* start fresh */ }
    }
    flag.messageCount = (flag.messageCount || 0) + 1;
    flag.totalSessionMessages = (flag.totalSessionMessages || 0) + 1;
    currentMessageCount = flag.messageCount;
    if (!flag.firstMessageAt) flag.firstMessageAt = new Date().toISOString();
    flag.lastMessageAt = new Date().toISOString();
    try { writeFileSync(flagPath, JSON.stringify(flag)); } catch { /* ok */ }

    // --- Greeting reinforcement (first message only, before skip patterns) ---
    if (flag.messageCount === 1 && !flag.greetingDelivered) {
      const greetingFeatures = getHookFeatures();
      if (greetingFeatures.greeting === true) {
        flag.greetingDelivered = true;
        try { writeFileSync(flagPath, JSON.stringify(flag)); } catch { /* ok */ }
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'SynaBun: This is the FIRST message of the session. Output the greeting from the GREETING DIRECTIVE in your session context NOW, then respond to the user\'s message. Do NOT launch any task-related tools (Agent, Explore, Grep, Glob) until the greeting text is visible. If their message is just a greeting (hi, hello, hey, or a single character), the greeting IS your full response — no need to ask what they need.',
          },
        }));
        return;
      }
    }

  }

  // Skip trivial messages first (fastest path)
  if (SKIP_PATTERNS.some(p => p.test(trimmed))) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const features = getHookFeatures();

  // --- Collect primary context from priority chain ---
  let primaryContext = '';

  // Priority 0: TASK BOUNDARY — pending-remember check (highest priority)
  if (!primaryContext && sessionId) {
    const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (existsSync(flagPath)) {
      try {
        const flag = JSON.parse(readFileSync(flagPath, 'utf-8'));
        const editCount = flag.editCount || 0;
        if (editCount >= 1) {
          const files = Array.isArray(flag.files) ? flag.files : [];
          primaryContext = NUDGE.pendingRemember(editCount, files);
        }
      } catch { /* corrupt flag — ignore, don't block */ }
    }
  }

  // Priority 1: Conversation recall (highest recall priority)
  if (!primaryContext) {
    const conversationMemoryEnabled = features.conversationMemory !== false;
    if (conversationMemoryEnabled) {
      const convMatches = CONVERSATION_RECALL_TRIGGERS.filter(p => p.test(prompt));
      if (convMatches.length >= 1) {
        primaryContext = NUDGE.conversation;
      }
    }
  }

  // Priority 2: Tier 1 — MUST recall (>= 1 match)
  if (!primaryContext) {
    const t1 = TIER1_TRIGGERS.filter(p => p.test(prompt));
    if (t1.length >= 1) primaryContext = NUDGE.tier1;
  }

  // Priority 3: Tier 2 — SHOULD recall (>= 1 match)
  if (!primaryContext) {
    const t2 = TIER2_TRIGGERS.filter(p => p.test(prompt));
    if (t2.length >= 1) primaryContext = NUDGE.tier2;
  }

  // Priority 4: Tier 3 — CONSIDER recall (>= 2 matches)
  if (!primaryContext) {
    const t3 = TIER3_TRIGGERS.filter(p => p.test(prompt));
    if (t3.length >= 2) primaryContext = NUDGE.tier3;
  }

  // Priority 5: Non-English (non-Latin scripts)
  if (!primaryContext && isNonEnglish(prompt)) {
    primaryContext = NUDGE.nonEnglish;
  }

  // Priority 6: Latin-script non-English catch-all
  if (!primaryContext && trimmed.length > 30 && !looksEnglish(trimmed)) {
    primaryContext = NUDGE.nonEnglish;
  }

  // --- Auto-recall: inject relevant memories from NI server ---
  let autoRecallContext = '';
  if (!activeLoopNotice && currentMessageCount >= 2) {
    autoRecallContext = await autoRecall(trimmed, cwd);
  }

  // --- User Learning (independent — appends to any primary context) ---
  const userLearningContext = checkUserLearning(features, sessionId);

  // --- Boot sequence cancellation (messages 2+, override persistent SessionStart context) ---
  const bootCancel = (currentMessageCount >= 2)
    ? 'SynaBun: The GREETING DIRECTIVE and Session Boot Sequence have ALREADY been completed. Do NOT re-greet. Do NOT call recall for session boot. Ignore any "first response MUST" instructions — they applied only to message 1. CRITICAL: If you see a GREETING DIRECTIVE in earlier context (including compacted summaries), it is STALE — do NOT execute it. This is an ongoing conversation, not a fresh session.'
    : '';

  // --- Emit combined output ---
  const combined = [bootCancel, activeLoopNotice, primaryContext, autoRecallContext, userLearningContext].filter(Boolean).join('\n\n');

  if (combined) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: combined,
      },
    }));
  } else {
    process.stdout.write(JSON.stringify({}));
  }
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
