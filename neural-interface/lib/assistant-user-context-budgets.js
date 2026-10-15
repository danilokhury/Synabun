// ═══════════════════════════════════════════
// SynaBun — Assistant user context: every number and name in one place
// ═══════════════════════════════════════════
//
// The user-context engine (assistant-user-context.js: what the Assistant knows
// about the user, the nudges from recent conversations, the learning loop)
// reads all of its limits from here. Pure: no I/O, no SynaBun imports.

/** `assistant-config.json` → `userContext`: the three layers, all on by default. */
export const USER_CONTEXT_DEFAULTS = Object.freeze({ knowledge: true, nudges: true, trace: true });

/** The settings as booleans; anything that is not exactly `false` reads as on. */
export function normalizeUserContext(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return { knowledge: value.knowledge !== false, nudges: value.nudges !== false, trace: value.trace !== false };
}

// Where the engine keeps what it learns: two child categories, created on first use.
export const CATEGORIES = Object.freeze({
  knowledge: 'user-knowledge',
  knowledgeParent: 'communication-style',
  threads: 'assistant-threads',
  threadsParent: 'conversations',
});
export const CATEGORY_DESCRIPTIONS = Object.freeze({
  knowledge: 'One statement per memory about how the user wants the Assistant to work: line 1 is the statement, then Evidence lines and a "Seen N× · confidence X · facet F" line. Written by the SynaBun Assistant\'s learning loop; edit line 1 to correct a statement. Do not store session summaries here.',
  knowledgeParent: 'How the user communicates and wants work done: preferences, corrections, standing instructions.',
  threads: 'One memory per SynaBun Assistant conversation, rewritten in place by the harness: title, time span, the last asks, runs with outcomes and open items. Do not store anything else here.',
  threadsParent: 'Records of past conversations and sessions.',
});

/** What a statement is about. A memory's `subcategory` is one of these. */
export const FACETS = Object.freeze(['instructions', 'expectations', 'decisions', 'corrections', 'expertise', 'rules', 'goals']);
/** The memory kinds a statement can have. */
export const KNOWLEDGE_KINDS = Object.freeze(['preference', 'decision', 'fact']);
/** facet → memory kind. */
export const FACET_KIND = Object.freeze({
  instructions: 'preference', expectations: 'preference', corrections: 'preference', rules: 'preference',
  decisions: 'decision', expertise: 'fact', goals: 'fact',
});

/** The digest in the system-level slot. */
export const DIGEST = Object.freeze({
  maxTokens: 300,
  perFacet: 3,
  statementMaxChars: 160,
  // Rows read from the store before ranking (newest first): bounds the work, not the digest.
  readLimit: 400,
});

/** The per-turn block. */
export const TURN_BLOCK = Object.freeze({
  firstTokens: 120,
  laterTokens: 80,
  // One item: short enough that the later budget holds the header and one of them.
  itemMaxChars: 160,
  // Deltas (knowledge learned since the digest was frozen) said in one turn.
  deltasPerTurn: 2,
});

/** Nudges from recent interactions. */
export const NUDGES = Object.freeze({
  // The last thread is offered at session open when it is in the same project, or this recent.
  lastThreadHours: 24,
  // A pause this long between two turns of one conversation is said once.
  gapHours: 4,
  openItemsShown: 2,
  // Significant words an open item shares with the prompt before it counts as overlapping.
  overlapWords: 2,
  // Keys kept in assistant-user-context.json.
  nudgedKept: 500,
  threadsKept: 300,
});

/** The learning loop. */
export const LEARN = Object.freeze({
  minChars: 16,
  // A paste this long, or this many lines, is not the user's typed words.
  pasteChars: 200,
  pasteLines: 4,
  messageClip: 2000,
  replyClip: 600,
  maxSentences: 12,
  sentenceClip: 300,
  knownStatements: 6,
  // Jev thresholds: a durable signal, a match with a known statement, a contradiction
  // (the bar automatic supersession uses), the writer's statement adding nothing.
  durableMin: 0.8,
  matchMin: 0.7,
  contradictMin: 0.9,
  faithfulMin: 0.8,
  evidenceMax: 3,
  quoteMax: 200,
  // Per session.
  gateCap: 30,
  writerCap: 8,
  writeCap: 6,
  hashesKept: 60,
  timeoutMs: 4000,
});

/** The thread record (one memory per conversation). */
export const THREAD = Object.freeze({
  asks: 6,
  askClip: 120,
  runs: 8,
  openItems: 6,
  itemClip: 160,
  // The memory is rewritten this long after the conversation's last turn ended.
  writeDebounceMs: 45_000,
});

/** The statement writer (a Claude one-shot on the cheapest Claude model). */
export const WRITER = Object.freeze({
  timeoutMs: 20_000,
  // The CLI's own alias: used when the catalog names no cheaper Claude model.
  fallbackModel: 'haiku',
});

/** The repo's estimator (mcp-server memory-retrieval `estimateTokens`): UTF-8 bytes / 3, which over-counts. */
export function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(String(value ?? ''), 'utf8') / 3);
}
