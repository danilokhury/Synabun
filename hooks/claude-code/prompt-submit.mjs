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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const HOOK_FEATURES_PATH = join(DATA_DIR, 'hook-features.json');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');

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
  /\b(supabase|redis|upstash|qdrant)\b/i,
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
    `SynaBun User Learning: You've had several exchanges this session. Briefly reflect — have you noticed any patterns in how the user communicates, what they prefer, or how they work?`,
    `If you've observed something meaningful that isn't already stored, call \`recall\` with category \`user-profile\` to check, then \`remember\` if it's genuinely new.`,
    `Max 1-2 observations. Skip if nothing stands out.`,
  ].join(' '),
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

async function main() {
  let prompt = '';
  let sessionId = '';
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    prompt = input.prompt || '';
    sessionId = input.session_id || '';
  } catch { /* proceed with empty */ }

  const trimmed = prompt.trim();

  // --- Track message count (BEFORE skip check — all messages count) ---
  if (sessionId && trimmed.length > 0) {
    const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (!existsSync(PENDING_REMEMBER_DIR)) mkdirSync(PENDING_REMEMBER_DIR, { recursive: true });
    let flag = { editCount: 0, retries: 0, files: [], messageCount: 0 };
    if (existsSync(flagPath)) {
      try { flag = JSON.parse(readFileSync(flagPath, 'utf-8')); } catch { /* start fresh */ }
    }
    flag.messageCount = (flag.messageCount || 0) + 1;
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
            additionalContext: 'SynaBun: This is the FIRST message of the session. Output the greeting from the GREETING DIRECTIVE in your session context NOW, then respond to the user\'s message. If their message is just a greeting (hi, hello, hey, or a single character), the greeting IS your full response — no need to ask what they need.',
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

  // --- Priority 0: TASK BOUNDARY — pending-remember check (highest priority) ---
  if (sessionId) {
    const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (existsSync(flagPath)) {
      try {
        const flag = JSON.parse(readFileSync(flagPath, 'utf-8'));
        const editCount = flag.editCount || 0;
        if (editCount >= 1) {
          const files = Array.isArray(flag.files) ? flag.files : [];
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: NUDGE.pendingRemember(editCount, files),
            },
          }));
          return;
        }
      } catch { /* corrupt flag — ignore, don't block */ }
    }
  }

  // --- Priority 1: Conversation recall (highest recall priority) ---
  const conversationMemoryEnabled = features.conversationMemory !== false;
  if (conversationMemoryEnabled) {
    const convMatches = CONVERSATION_RECALL_TRIGGERS.filter(p => p.test(prompt));
    if (convMatches.length >= 1) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: NUDGE.conversation,
        },
      }));
      return;
    }
  }

  // --- Priority 2: Tier 1 — MUST recall (>= 1 match) ---
  const t1 = TIER1_TRIGGERS.filter(p => p.test(prompt));
  if (t1.length >= 1) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: NUDGE.tier1,
      },
    }));
    return;
  }

  // --- Priority 3: Tier 2 — SHOULD recall (>= 1 match) ---
  const t2 = TIER2_TRIGGERS.filter(p => p.test(prompt));
  if (t2.length >= 1) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: NUDGE.tier2,
      },
    }));
    return;
  }

  // --- Priority 4: Tier 3 — CONSIDER recall (>= 2 matches from Tier 3) ---
  const t3 = TIER3_TRIGGERS.filter(p => p.test(prompt));
  if (t3.length >= 2) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: NUDGE.tier3,
      },
    }));
    return;
  }

  // --- Priority 5: Non-English (non-Latin scripts) — delegate to Claude ---
  if (isNonEnglish(prompt)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: NUDGE.nonEnglish,
      },
    }));
    return;
  }

  // --- Priority 6: Catch-all for Latin-script non-English prompts ---
  // Fires on longer prompts that don't match any English tier AND lack
  // common English function words — likely Spanish, French, Portuguese, etc.
  if (trimmed.length > 30 && !looksEnglish(trimmed)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: NUDGE.nonEnglish,
      },
    }));
    return;
  }

  // --- Priority 7: User Learning nudge (quiet-only, one-time per session) ---
  const userLearningEnabled = features.userLearning !== false;
  if (userLearningEnabled && sessionId) {
    const userLearningThreshold = features.userLearningThreshold || 8;
    const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (existsSync(flagPath)) {
      try {
        const flag = JSON.parse(readFileSync(flagPath, 'utf-8'));
        if ((flag.messageCount || 0) >= userLearningThreshold && !flag.userLearningNudged) {
          flag.userLearningNudged = true;
          writeFileSync(flagPath, JSON.stringify(flag));
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: NUDGE.userLearning,
            },
          }));
          return;
        }
      } catch { /* ignore */ }
    }
  }

  // No triggers matched — no nudge
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
