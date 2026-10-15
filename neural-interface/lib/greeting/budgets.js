// ═══════════════════════════════════════════
// SynaBun — Greeting: every number and name in one place
// ═══════════════════════════════════════════
//
// The greeting engine (engine.js: what SynaBun says to a person who comes back
// and opens a fresh session, on every surface) reads all of its limits from
// here. Pure: no I/O, no SynaBun imports.

/** `DATA_HOME/data/greeting.json`: one switch, on by default. */
export const GREETING_DEFAULTS = Object.freeze({ enabled: true });

/** The settings as booleans; anything that is not exactly `false` reads as on. */
export function normalizeGreetingSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return { enabled: value.enabled !== false };
}

/** The environment's kill switch: SYNABUN_GREETING=off (also "0" / "false"). */
export function greetingKilled(env = process.env) {
  return /^(off|0|false|no)$/i.test(String(env?.SYNABUN_GREETING ?? '').trim());
}

/** The surfaces a greeting can open on, and how the writer is told about each. */
export const SURFACES = Object.freeze({
  assistant: 'the SynaBun Assistant',
  'claude-panel': 'Claude Code (side panel)',
  'codex-panel': 'Codex (side panel)',
  'opencode-panel': 'OpenCode (side panel)',
  'claude-cli': 'Claude Code (terminal)',
});

/** A greeting is for a return: the last human message in the project is at least this old. */
export const RETURN = Object.freeze({ gapMs: 60 * 60_000 });

/** The sentence itself. */
export const TEXT = Object.freeze({
  maxChars: 280,
  maxSentences: 2,
  // A name (a thread title, a run title) may be shortened with an ellipsis; a fact never is.
  titleChars: 90,
  quoteChars: 120,
  itemChars: 160,
});

/** What is read to build a greeting. */
export const FACTS = Object.freeze({
  threads: 3,
  sessions: 4,
  memories: 3,
  // Memories of the last working period count when someone thought them significant.
  memoryImportance: 7,
  memoryWindowMs: 36 * 3_600_000,
  excerptChars: 260,
  openItems: 2,
  runs: 4,
  schedules: 3,
  elsewhere: 3,
  // News older than this is not news.
  newsWindowMs: 14 * 24 * 3_600_000,
  ownerNotes: 4,
  ownerWords: 2,
});

/** Preparing ahead of time. */
export const PREPARE = Object.freeze({
  // A project is prepared once its last human message is this old (the session went quiet).
  settleMs: 10 * 60_000,
  sweepMs: 5 * 60_000,
  bootDelayMs: 45_000,
  // While the person stays away, a project is written again at most this often (then the last value).
  intervalsMs: Object.freeze([10 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000]),
  // Writer calls per local day, every project together; past it the fallback line is used.
  dailyCalls: 40,
  projects: 8,
  activeDays: 14,
});

/** The writer (a Claude one-shot on the cheapest Claude model). */
export const WRITER = Object.freeze({ timeoutMs: 15_000, fallbackModel: 'haiku' });

/** Kept in greeting-state.json. */
export const STATE = Object.freeze({ greetingsKept: 60, sessionsKept: 300, toldKept: 400, projectsKept: 60 });

/** A session key or a greeting id as it may arrive from a client. */
export const ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;

/** The repo's estimator (mcp-server memory-retrieval `estimateTokens`): UTF-8 bytes / 3, which over-counts. */
export function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(String(value ?? ''), 'utf8') / 3);
}
