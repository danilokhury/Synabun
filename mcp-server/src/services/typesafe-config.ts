/**
 * Runtime knobs and the judgment log for the TypeSafe client.
 *
 * Knobs are data, not constants. The Neural Interface mounts mcp-server/dist
 * in-process and every stdio MCP server is its own process, so a setting in
 * code needs a rebuild plus a restart of each of them before it changes. One
 * JSON row in kv_config, re-read at most every few seconds, is what lets the
 * Judgments tab flip a surface off and have every process obey it before the
 * next call goes out.
 *
 * This module imports only sqlite.js and browser-assist-gate.js, a leaf of node
 * builtins. Nothing beneath either imports the TypeSafe client, so typesafe.ts
 * can depend on it without a cycle. Every function here swallows storage
 * errors: a broken kv row or a closed database must degrade to the defaults,
 * never break `judge()`.
 */

import { getDb } from './sqlite.js';
import { autoHealGate, readTargetBench, DEFAULT_BROWSER_ASSIST, BROWSER_TARGET_DEFAULTS, type BrowserAssistConfig } from './browser-assist-gate.js';
export type { BrowserAssistConfig, BrowserTargetBench } from './browser-assist-gate.js';
// desktop-assist-gate.ts is a leaf as well (node builtins, the browser gate and the pure risk modules): no cycle back into this file.
import { desktopPressGate, readDesktopTargetBench, DEFAULT_DESKTOP_ASSIST, DESKTOP_TARGET_DEFAULTS, type DesktopAssistConfig } from './desktop-assist-gate.js';
export type { DesktopAssistConfig, DesktopTargetBench } from './desktop-assist-gate.js';

// --- Surfaces ---

export const SURFACES = [
  'relations', 'importance-kind', 'historical-query', 'rerank', 'prompt-urgency', 'agent-message',
  'duplicate-gate', 'secret-gate', 'category-check', 'stale-check', 'brief-rank', 'turn-worth',
  'loop-goal', 'trash-triage',
  'browser-page-state', 'browser-target', 'browser-social',
  'task-boundary', 'session-lookup', 'user-learning', 'claim-check',
  'edit-stale', 'supersession', 'compact-digest', 'plan-conflict',
  'worker-outcome', 'worker-claim', 'desktop-target',
] as const;
export type SurfaceName = typeof SURFACES[number];

/**
 * Who asked. `live` is the historical catch-all: rows written before origins
 * were split keep it, and the `live` log filter means every real-time origin
 * (everything except backfill and bench) so saved filters keep working.
 */
export const ORIGINS = ['live', 'hook', 'tool', 'maintenance', 'loop', 'ui', 'script', 'assistant', 'backfill', 'bench'] as const;
export type JudgeOrigin = typeof ORIGINS[number];

export interface SurfaceSettings {
  enabled: boolean; timeoutMs: number; minConfidence?: number;
  /** Noul P(yes) floor on surfaces that ask both kinds. Existing surfaces keep `minConfidence` as they always used it. */
  minProbability?: number;
  /** Relevance floor on the 0–4 rubric: a judged candidate below it is not injected (rerank / brief-rank in the hooks). */
  minScore?: number;
  /** Upper bound on items judged per event (edit-stale memories, digest messages, plan decisions). */
  maxItems?: number;
  /** Quiet period before a burst of events is judged once (edit-stale). */
  debounceMs?: number;
  /** turn-worth only: the stricter bar for a turn whose only work ran through Bash. */
  bashOnlyMinProbability?: number;
}
export interface SurfaceMeta {
  label: string; description: string; fallback: string;
  /** Asked inside that surface's request: shares its round trip and timeout. */
  ridesWith?: SurfaceName;
  /** Total budget of the hook that waits on this surface; the tab warns when the timeout leaves no room. */
  budgetMs?: number;
}

/** What the Judgments tab shows beside each toggle. Fallbacks are the exact heuristics that run when a surface is off. */
export const SURFACE_META: Record<SurfaceName, SurfaceMeta> = {
  'relations': { label: 'Relations', description: 'How each indexed memory relates to its nearest neighbours: duplicate, conflict, related or unrelated.', fallback: '0.92 cosine cutoff plus the negation-word regex' },
  'importance-kind': { label: 'Importance & kind', description: 'Long-term importance band and record kind at index time. Importance is recorded, and applied only when the bench-gated toggle is on.', fallback: 'kind from the category-name regex; importance stays the writer\'s' },
  'historical-query': { label: 'Historical query', description: 'Whether a recall asks about the past, so superseded memories are included. Asked only when a superseded memory is among the candidates.', fallback: '/history|previous|old|antes|anterior/i' },
  'rerank': { label: 'Rerank', description: 'Reorders a recall shortlist by judged relevance: recall with rerank:true (the greeting boot directive asks for it only when the greeting is on), the prompt auto-recall hook and the Assistant\'s per-turn recall, which also drop memories below the relevance floor.', fallback: 'fusion order; cosine ≥ 0.4 decides what is injected', budgetMs: 3000 },
  'prompt-urgency': { label: 'Prompt urgency', description: 'How much searching memory would change the reply to a new prompt (UserPromptSubmit hook and the Assistant\'s per-turn recall, which skips or trims the injected memories by it).', fallback: 'Tier 1/2/3 regex ladder plus the non-English check (the Assistant: its skip regex)', budgetMs: 3000 },
  'agent-message': { label: 'Agent message', description: 'Whether the final assistant message is blocked on a human or waiting on the user (Stop hook).', fallback: 'substring phrase lists', budgetMs: 3000 },
  'duplicate-gate': { label: 'Duplicate gate', description: 'At remember, refuses a memory that restates a fact already stored and points at it.', fallback: 'no gate; maintenance relates duplicates later' },
  'secret-gate': { label: 'Secret gate', description: 'At remember and reflect, confirms credential-looking spans and redacts them before anything is embedded.', fallback: 'redact only high-precision patterns (sk-, ghp_, xox, AKIA, private keys, JWTs)' },
  'category-check': { label: 'Category check', description: 'At remember, which category fits the content; disagreement with the caller\'s pick is recorded and reported, never applied.', fallback: 'none; stored as requested' },
  'stale-check': { label: 'Stale check', description: 'In sync, whether a memory still describes a file whose checksum changed.', fallback: 'checksum diff only' },
  'brief-rank': { label: 'Brief rank', description: 'Ranks the memories injected into a subagent (PreToolUse Task and SubagentStart hooks) by judged relevance to its task, dropping those below the relevance floor.', fallback: 'fusion order', budgetMs: 3000 },
  'turn-worth': { label: 'Turn worth', description: 'At Stop, whether the turn produced work worth remembering before the unstored-edits nag fires. A turn whose only work ran through Bash needs the stricter bash-only bar.', fallback: 'edit-count threshold; Bash-only turns carry no obligation', budgetMs: 3000 },
  'loop-goal': { label: 'Loop goal', description: 'Ends a loop early when its stated task is judged complete, from the iteration\'s own output (native loops) or its journal. Never asked after the final iteration.', fallback: 'iteration budget', budgetMs: 3000 },
  'trash-triage': { label: 'Trash triage', description: 'Ranks forget candidates by how little they would be missed.', fallback: 'importance ascending, age descending' },
  'browser-page-state': { label: 'Browser page state', description: 'After browser_navigate and on empty extractor results: whether the page is usable, loading, behind a sign-in, verification or consent wall, errored or genuinely empty, and whether a stated intent is already satisfied. Advisory.', fallback: 'the navigation response and deterministic DOM signals, unannotated' },
  'browser-target': { label: 'Browser target', description: 'Ranks visible controls against a snapshot intent or a failed selector\'s target hint. Advisory; one safe auto-heal click only behind the benchmark gate.', fallback: 'exact ref/selector resolution, exact-name textHint healing, fuzzy hint order' },
  'browser-social': { label: 'Browser social', description: 'Reads an ambiguous Facebook or X composer state and names the likely submit or trigger control. Advisory; never clicks, types or publishes.', fallback: 'locale lists, structural heuristics and the publishing probes' },
  'task-boundary': { label: 'Task boundary', description: 'On a new prompt while edits are not yet stored in memory: does it start a different task, or continue or correct the work in progress? Decides the "store it before moving on" nudge.', fallback: 'nudge only when a Stop came after the edits; an interrupted turn means a correction', ridesWith: 'prompt-urgency', budgetMs: 3000 },
  'session-lookup': { label: 'Session lookup', description: 'Whether a prompt asks about an earlier session (what was decided, where work was left), which starts the conversation-recall workflow.', fallback: 'English-only phrase regexes', ridesWith: 'prompt-urgency', budgetMs: 3000 },
  'user-learning': { label: 'User learning', description: 'Whether a prompt shows a lasting preference about how the developer wants work done, which asks for a communication-style note.', fallback: 'every Nth message', ridesWith: 'prompt-urgency', budgetMs: 3000 },
  'claim-check': { label: 'Claim check', description: 'At Stop, whether the final message claims success (tests pass, fixed, verified) that the turn\'s own command output does not show. Blocks the stop at most once per prompt.', fallback: 'no check', ridesWith: 'agent-message', budgetMs: 3000 },
  'edit-stale': { label: 'Edit stale check', description: 'After an Edit or Write, whether memories that list the edited file still describe it. Runs off the request path after a quiet period; verdicts reach the next prompt or Stop and show as a recall flag.', fallback: 'checksum diff only; judged only by an explicit sync' },
  'supersession': { label: 'Supersession', description: 'At index time, whether a new memory is a newer statement of the same thing as an older one in its project and category. Writes a reversible supersedes relation, which hides the older memory from current-state recall.', fallback: 'supersedes only by hand (reflect supersedes)', ridesWith: 'relations' },
  'compact-digest': { label: 'Compaction digest', description: 'Before compaction, which messages across the whole session carry a goal, decision, finding or open issue, so the compaction memory keeps them.', fallback: 'the first 15 prompts and 5 replies', budgetMs: 10000 },
  'plan-conflict': { label: 'Plan conflict', description: 'When a plan is approved, whether it goes against a decision or preference already stored for the project. An advisory note; never blocks.', fallback: 'no check', budgetMs: 15000 },
  'worker-outcome': { label: 'Worker outcome', description: 'Assistant workers: reads done / blocked / needs input from a final message that has no ## Result block (instead of spending a retry turn), and what kept a failed or blocked run from finishing (capability, access, needs the user, transient), which decides whether escalation is offered.', fallback: 'one result-retry worker turn; every failed, blocked or result-less run offers a one-tier escalation' },
  'worker-claim': { label: 'Worker claim', description: 'Assistant workers: whether a run reported done while claiming success (tests pass, fixed, verified) that its own command output does not show. Flags the run so the Assistant verifies before reporting; asked only when the turn exposed commands or tool results.', fallback: 'no check', ridesWith: 'worker-outcome' },
  'desktop-target': { label: 'Desktop target', description: 'Computer use: ranks the visible controls of the front window against a computer_ax intent. Advisory; one low-risk press by intent only behind the desktop benchmark gate.', fallback: 'the full accessibility tree, or a word-overlap ranking when an intent is given' },
};

const SURFACE_DEFAULTS: Record<SurfaceName, SurfaceSettings> = {
  'relations': { enabled: true, timeoutMs: 8000, minConfidence: 0.7 },
  'importance-kind': { enabled: true, timeoutMs: 8000, minConfidence: 0.6 },
  'historical-query': { enabled: true, timeoutMs: 1200 },
  // 1.5 sits between Tangential (1) and Background (2): an injected memory has to help.
  'rerank': { enabled: true, timeoutMs: 1500, minScore: 1.5 },
  'prompt-urgency': { enabled: true, timeoutMs: 1200 },
  'agent-message': { enabled: true, timeoutMs: 1200 },
  'duplicate-gate': { enabled: true, timeoutMs: 1500, minConfidence: 0.85 },
  'secret-gate': { enabled: true, timeoutMs: 1500, minConfidence: 0.7 },
  'category-check': { enabled: true, timeoutMs: 2000, minConfidence: 0.6 },
  'stale-check': { enabled: true, timeoutMs: 3000, minConfidence: 0.6 },
  'brief-rank': { enabled: true, timeoutMs: 1500, minScore: 1.5 },
  'turn-worth': { enabled: true, timeoutMs: 1200, minConfidence: 0.35, bashOnlyMinProbability: 0.8 },
  'loop-goal': { enabled: true, timeoutMs: 3000, minConfidence: 0.8 },
  'trash-triage': { enabled: true, timeoutMs: 8000 },
  'browser-page-state': { enabled: true, timeoutMs: 1000, minConfidence: 0.65, minProbability: 0.8 },
  'browser-target': { ...BROWSER_TARGET_DEFAULTS },
  'browser-social': { enabled: true, timeoutMs: 1200, minConfidence: 0.75 },
  // Riders share their lead's request; their timeout is the lead's.
  'task-boundary': { enabled: true, timeoutMs: 1200, minProbability: 0.6 },
  'session-lookup': { enabled: true, timeoutMs: 1200, minProbability: 0.7 },
  'user-learning': { enabled: true, timeoutMs: 1200, minProbability: 0.7 },
  // Can block a Stop, so the bar is high.
  'claim-check': { enabled: true, timeoutMs: 1200, minProbability: 0.9 },
  // P(still accurate) below minProbability is reported as stale.
  'edit-stale': { enabled: true, timeoutMs: 3000, minProbability: 0.4, maxItems: 3, debounceMs: 15000 },
  // It hides the older memory from current-state recall, so the bar is very high.
  'supersession': { enabled: true, timeoutMs: 8000, minProbability: 0.9 },
  'compact-digest': { enabled: true, timeoutMs: 5000, minConfidence: 0.5, maxItems: 40 },
  'plan-conflict': { enabled: true, timeoutMs: 4000, minProbability: 0.75, maxItems: 6 },
  // Off the brain's critical path: it runs where a worker turn or a result-retry turn would.
  'worker-outcome': { enabled: true, timeoutMs: 2500, minConfidence: 0.7 },
  // Rider of worker-outcome. Flags a run for verification, so the bar is the claim-check bar.
  'worker-claim': { enabled: true, timeoutMs: 2500, minProbability: 0.9 },
  'desktop-target': { ...DESKTOP_TARGET_DEFAULTS },
};

// --- Config shape ---

/** docs.typesafe.ai/models, 2026-09-19: aliases plus the versioned id they resolve to. */
export const KNOWN_MODELS = ['jev-latest', 'jev-preview', 'jev-1.13.0'];
export const DEFAULT_MODEL = 'jev-latest';
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
/** List price for jev-1.13.0, USD per million input tokens; output tokens are free. */
export const DEFAULT_COST_PER_MILLION_INPUT = 0.042;
export const DEFAULT_COST_PER_MILLION_OUTPUT = 0;

export interface BackfillEstimate {
  rows: number;
  meanChars: number;
  sample: { size: number; withCandidates: number; meanCandidates: number; meanCandidateChars: number };
  calls: { importanceKind: number; relations: number };
  tokens: { input: number; output: number };
  costUsd: number | null;
  rates: { input: number; output: number };
  /** Where the per-request token figures came from: measured backfill rows in the log, the bench, or the size formula. */
  basis: 'formula' | 'bench' | 'log';
  wallClockMs: number;
  concurrency: number;
  at: string;
}

export interface BackfillReport {
  startedAt: string | null; finishedAt: string; wallClockMs: number;
  total: number; judged: number; skipped: number; failures: number;
  relationsCreated: { similar: number; possible_conflict: number; duplicate_of: number };
  disagreements: { kind: number; kindRate: number; importance: number; importanceRate: number };
  tokensIn: number; tokensOut: number; costUsd: number | null; avgLatencyMs: number;
  coverageAfter: { judged: number; total: number };
}

export interface BackfillState {
  status: 'idle' | 'running' | 'paused' | 'cancelled' | 'done';
  startedAt: string | null; pausedAt: string | null; finishedAt: string | null;
  pausedReason: 'user' | 'failures' | null;
  limit: number | null; project: string | null; total: number;
  judged: number; skipped: number; failures: number; consecutiveFailures: number;
  relationsCreated: { similar: number; possible_conflict: number; duplicate_of: number };
  disagreements: { kind: number; importance: number };
  tokensIn: number; tokensOut: number; latencyMsTotal: number;
  lastError: string | null; lastErrorAt: string | null;
  estimate: BackfillEstimate | null; report: BackfillReport | null;
}

export interface BenchSummary { at: string; n: number; agreement: number | null; file: string | null; avgInputTokensPerItem?: number }

export interface TypeSafeConfig {
  version: 1;
  /** UI master switch. The env kill switch SYNABUN_TYPESAFE=off still wins. */
  enabled: boolean;
  model: string;
  /** null → env TYPESAFE_BASE_URL → DEFAULT_BASE_URL. */
  baseUrl: string | null;
  defaultTimeoutMs: number;
  costPerMillionInput: number;
  costPerMillionOutput: number;
  /** Default off; refused while benchRunAt is null. */
  applyJudgedImportance: boolean;
  applyMinConfidence: number;
  backfillConcurrency: number;
  benchRunAt: string | null;
  bench: Partial<Record<'importance' | 'kind' | 'relation' | 'historical', BenchSummary>>;
  surfaces: Record<SurfaceName, SurfaceSettings>;
  backfill: BackfillState;
  /** `autoHealEnabled` is intent; whether it takes effect is `autoHealGate()`, recomputed where the click would happen. */
  browserAssist: BrowserAssistConfig;
  /** `pressEnabled` is intent; whether it takes effect is `desktopPressGate()`, recomputed where the press would happen. */
  desktopAssist: DesktopAssistConfig;
  updatedAt: string | null;
}

export const DEFAULT_BACKFILL_STATE: BackfillState = {
  status: 'idle', startedAt: null, pausedAt: null, finishedAt: null, pausedReason: null,
  limit: null, project: null, total: 0,
  judged: 0, skipped: 0, failures: 0, consecutiveFailures: 0,
  relationsCreated: { similar: 0, possible_conflict: 0, duplicate_of: 0 },
  disagreements: { kind: 0, importance: 0 },
  tokensIn: 0, tokensOut: 0, latencyMsTotal: 0,
  lastError: null, lastErrorAt: null, estimate: null, report: null,
};

export const DEFAULT_TYPESAFE_CONFIG: TypeSafeConfig = {
  version: 1,
  enabled: true,
  model: DEFAULT_MODEL,
  baseUrl: null,
  defaultTimeoutMs: 8000,
  costPerMillionInput: DEFAULT_COST_PER_MILLION_INPUT,
  costPerMillionOutput: DEFAULT_COST_PER_MILLION_OUTPUT,
  applyJudgedImportance: false,
  applyMinConfidence: 0.6,
  backfillConcurrency: 3,
  benchRunAt: null,
  bench: {},
  surfaces: SURFACE_DEFAULTS,
  backfill: DEFAULT_BACKFILL_STATE,
  browserAssist: DEFAULT_BROWSER_ASSIST,
  desktopAssist: DEFAULT_DESKTOP_ASSIST,
  updatedAt: null,
};

export interface TypeSafeConfigPatch {
  enabled?: boolean;
  model?: string;
  baseUrl?: string | null;
  defaultTimeoutMs?: number;
  costPerMillionInput?: number;
  costPerMillionOutput?: number;
  applyJudgedImportance?: boolean;
  applyMinConfidence?: number;
  backfillConcurrency?: number;
  benchRunAt?: string | null;
  bench?: TypeSafeConfig['bench'];
  surfaces?: Partial<Record<SurfaceName, Partial<SurfaceSettings>>>;
  backfill?: Partial<BackfillState>;
  browserAssist?: Partial<BrowserAssistConfig>;
  desktopAssist?: Partial<DesktopAssistConfig>;
}

const CONFIG_KEY = 'typesafe_config';
const CONFIG_TTL_MS = 3000;

/** Per-surface limits beyond the two thresholds: [min, max, integer]. */
const SURFACE_LIMITS = {
  minScore: [0, 4, false],
  maxItems: [1, 50, true],
  debounceMs: [0, 600000, true],
  bashOnlyMinProbability: [0, 1, false],
} as const;
const SURFACE_LIMIT_KEYS = Object.keys(SURFACE_LIMITS) as (keyof typeof SURFACE_LIMITS)[];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Layer a stored/partial config over the defaults. Unknown surfaces are ignored; missing ones keep their defaults. */
export function mergeTypeSafeConfig(base: TypeSafeConfig, patch: TypeSafeConfigPatch | Partial<TypeSafeConfig> | null | undefined): TypeSafeConfig {
  const next = clone(base);
  if (!isObject(patch)) return next;
  const p = patch as Record<string, unknown>;
  if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
  if (typeof p.model === 'string' && p.model.trim()) next.model = p.model.trim();
  if (p.baseUrl === null || typeof p.baseUrl === 'string') next.baseUrl = p.baseUrl ? String(p.baseUrl).trim() || null : null;
  for (const key of ['defaultTimeoutMs', 'costPerMillionInput', 'costPerMillionOutput', 'applyMinConfidence', 'backfillConcurrency'] as const) {
    const n = Number(p[key]);
    if (p[key] !== undefined && Number.isFinite(n)) (next as unknown as Record<string, number>)[key] = n;
  }
  if (typeof p.applyJudgedImportance === 'boolean') next.applyJudgedImportance = p.applyJudgedImportance;
  if (p.benchRunAt === null || typeof p.benchRunAt === 'string') next.benchRunAt = p.benchRunAt as string | null;
  if (isObject(p.bench)) next.bench = { ...next.bench, ...(p.bench as TypeSafeConfig['bench']) };
  if (isObject(p.surfaces)) {
    for (const name of SURFACES) {
      const s = (p.surfaces as Record<string, unknown>)[name];
      if (!isObject(s)) continue;
      const current = next.surfaces[name];
      if (typeof s.enabled === 'boolean') current.enabled = s.enabled;
      if (s.timeoutMs !== undefined && Number.isFinite(Number(s.timeoutMs))) current.timeoutMs = Number(s.timeoutMs);
      if (s.minConfidence !== undefined && Number.isFinite(Number(s.minConfidence))) current.minConfidence = Number(s.minConfidence);
      if (s.minProbability !== undefined && Number.isFinite(Number(s.minProbability))) current.minProbability = Number(s.minProbability);
      for (const key of SURFACE_LIMIT_KEYS) {
        if (s[key] !== undefined && Number.isFinite(Number(s[key]))) current[key] = Number(s[key]);
      }
    }
  }
  if (isObject(p.backfill)) {
    const b = p.backfill as Partial<BackfillState>;
    next.backfill = { ...next.backfill, ...b,
      relationsCreated: { ...next.backfill.relationsCreated, ...(isObject(b.relationsCreated) ? b.relationsCreated : {}) },
      disagreements: { ...next.backfill.disagreements, ...(isObject(b.disagreements) ? b.disagreements : {}) },
    };
  }
  if (isObject(p.browserAssist)) {
    const b = p.browserAssist as Record<string, unknown>;
    next.browserAssist ??= clone(DEFAULT_BROWSER_ASSIST);
    if (typeof b.autoHealEnabled === 'boolean') next.browserAssist.autoHealEnabled = b.autoHealEnabled;
    // A malformed stored bench reads as "keep what we had", which for a fresh
    // merge over the defaults is null: the gate stays shut.
    if (b.targetBench !== undefined) { const bench = readTargetBench(b.targetBench); if (bench !== undefined) next.browserAssist.targetBench = bench; }
  }
  if (isObject(p.desktopAssist)) {
    const d = p.desktopAssist as Record<string, unknown>;
    next.desktopAssist ??= clone(DEFAULT_DESKTOP_ASSIST);
    if (typeof d.pressEnabled === 'boolean') next.desktopAssist.pressEnabled = d.pressEnabled;
    // As for the browser record: a malformed stored bench keeps what we had, so a fresh merge stays locked.
    if (d.targetBench !== undefined) { const bench = readDesktopTargetBench(d.targetBench); if (bench !== undefined) next.desktopAssist.targetBench = bench; }
  }
  if (typeof p.updatedAt === 'string') next.updatedAt = p.updatedAt;
  return next;
}

/**
 * Turn an untrusted request body into a patch, or throw with a message the
 * endpoint can return as a 400. Lives here so the HTTP route, the tests and
 * the UI all agree on the limits.
 */
export function validateTypeSafeConfigPatch(body: unknown, current: TypeSafeConfig = typesafeConfig()): TypeSafeConfigPatch {
  if (!isObject(body)) throw new Error('Config patch must be an object.');
  const patch: TypeSafeConfigPatch = {};
  const num = (key: string, min: number, max: number, integer = false) => {
    const raw = body[key];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
    return n;
  };
  if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean.'); patch.enabled = body.enabled; }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 64 || !/^[A-Za-z0-9._-]+$/.test(body.model.trim())) throw new Error('model must be a short model id such as jev-latest.');
    patch.model = body.model.trim();
  }
  if (body.baseUrl !== undefined) {
    if (body.baseUrl === null || body.baseUrl === '') patch.baseUrl = null;
    else if (typeof body.baseUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(body.baseUrl.trim())) throw new Error('baseUrl must be an http(s) URL or empty for the default.');
    else patch.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
  }
  const defaultTimeoutMs = num('defaultTimeoutMs', 200, 30000, true); if (defaultTimeoutMs !== undefined) patch.defaultTimeoutMs = defaultTimeoutMs;
  const costIn = num('costPerMillionInput', 0, 1000); if (costIn !== undefined) patch.costPerMillionInput = costIn;
  const costOut = num('costPerMillionOutput', 0, 1000); if (costOut !== undefined) patch.costPerMillionOutput = costOut;
  const minConf = num('applyMinConfidence', 0, 1); if (minConf !== undefined) patch.applyMinConfidence = minConf;
  const concurrency = num('backfillConcurrency', 1, 8, true); if (concurrency !== undefined) patch.backfillConcurrency = concurrency;
  if (body.applyJudgedImportance !== undefined) {
    if (typeof body.applyJudgedImportance !== 'boolean') throw new Error('applyJudgedImportance must be a boolean.');
    if (body.applyJudgedImportance && !current.benchRunAt) throw new Error('Run the importance bench before applying judged importance.');
    patch.applyJudgedImportance = body.applyJudgedImportance;
  }
  if (body.surfaces !== undefined) {
    if (!isObject(body.surfaces)) throw new Error('surfaces must be an object keyed by surface name.');
    patch.surfaces = {};
    for (const [name, value] of Object.entries(body.surfaces)) {
      if (!(SURFACES as readonly string[]).includes(name)) throw new Error(`Unknown surface: ${name}`);
      if (!isObject(value)) throw new Error(`surfaces.${name} must be an object.`);
      const s: Partial<SurfaceSettings> = {};
      if (value.enabled !== undefined) { if (typeof value.enabled !== 'boolean') throw new Error(`surfaces.${name}.enabled must be a boolean.`); s.enabled = value.enabled; }
      if (value.timeoutMs !== undefined) {
        const n = Number(value.timeoutMs);
        if (!Number.isInteger(n) || n < 200 || n > 30000) throw new Error(`surfaces.${name}.timeoutMs must be an integer between 200 and 30000.`);
        s.timeoutMs = n;
      }
      if (value.minConfidence !== undefined) {
        const n = Number(value.minConfidence);
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`surfaces.${name}.minConfidence must be between 0 and 1.`);
        s.minConfidence = n;
      }
      if (value.minProbability !== undefined) {
        const n = Number(value.minProbability);
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`surfaces.${name}.minProbability must be between 0 and 1.`);
        s.minProbability = n;
      }
      for (const key of SURFACE_LIMIT_KEYS) {
        if (value[key] === undefined) continue;
        const [min, max, integer] = SURFACE_LIMITS[key];
        const n = Number(value[key]);
        if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`surfaces.${name}.${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
        s[key] = n;
      }
      patch.surfaces[name as SurfaceName] = s;
    }
  }
  // Last on purpose: the gate is judged against current + THIS request, so one
  // PUT cannot lower a threshold and switch auto-heal on together.
  if (body.browserAssist !== undefined) {
    if (!isObject(body.browserAssist)) throw new Error('browserAssist must be an object.');
    const b = body.browserAssist;
    if (b.targetBench !== undefined) throw new Error('browserAssist.targetBench is written by the browser benchmark, not by the settings API.');
    const extra = Object.keys(b).find(key => key !== 'autoHealEnabled');
    if (extra) throw new Error(`Unknown browserAssist field: ${extra}`);
    if (b.autoHealEnabled !== undefined) {
      if (typeof b.autoHealEnabled !== 'boolean') throw new Error('browserAssist.autoHealEnabled must be a boolean.');
      if (b.autoHealEnabled) {
        const gate = autoHealGate(mergeTypeSafeConfig(current, patch));
        if (!gate.eligible) throw new Error(`Safe auto-heal stays locked: ${gate.reasons.join(' ')}`);
      }
      patch.browserAssist = { autoHealEnabled: b.autoHealEnabled };
    }
  }
  // After browserAssist, for the same reason: judged against current + everything else this request changes.
  if (body.desktopAssist !== undefined) {
    if (!isObject(body.desktopAssist)) throw new Error('desktopAssist must be an object.');
    const d = body.desktopAssist;
    if (d.targetBench !== undefined) throw new Error('desktopAssist.targetBench is written by the desktop benchmark, not by the settings API.');
    const extra = Object.keys(d).find(key => key !== 'pressEnabled');
    if (extra) throw new Error(`Unknown desktopAssist field: ${extra}`);
    if (d.pressEnabled !== undefined) {
      if (typeof d.pressEnabled !== 'boolean') throw new Error('desktopAssist.pressEnabled must be a boolean.');
      if (d.pressEnabled) {
        const gate = desktopPressGate(mergeTypeSafeConfig(current, patch));
        if (!gate.eligible) throw new Error(`Press by intent stays locked: ${gate.reasons.join(' ')}`);
      }
      patch.desktopAssist = { pressEnabled: d.pressEnabled };
    }
  }
  return patch;
}

let cached: TypeSafeConfig | null = null;
let cachedAt = 0;

function readStored(): Partial<TypeSafeConfig> | null {
  try {
    const row = getDb().prepare('SELECT value FROM kv_config WHERE key=?').get(CONFIG_KEY) as { value?: string } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(String(row.value)) as unknown;
    return isObject(parsed) ? parsed as Partial<TypeSafeConfig> : null;
  } catch { return null; }
}

/** The effective config, re-read from kv_config at most every CONFIG_TTL_MS. Never throws. */
export function typesafeConfig(): TypeSafeConfig {
  const now = Date.now();
  if (cached && now - cachedAt < CONFIG_TTL_MS) return cached;
  cached = mergeTypeSafeConfig(DEFAULT_TYPESAFE_CONFIG, readStored());
  cachedAt = now;
  return cached;
}

/** Drop the cached copy so the next read hits the database (called after every write in this process). */
export function invalidateTypeSafeConfig(): void { cached = null; cachedAt = 0; }

/** Per-surface settings; unknown names get the global default so a new surface is never silently disabled. */
export function surfaceConfig(name: string): SurfaceSettings {
  const cfg = typesafeConfig();
  return cfg.surfaces[name as SurfaceName] ?? { enabled: true, timeoutMs: cfg.defaultTimeoutMs };
}

export function typesafeMasterEnabled(): boolean { return typesafeConfig().enabled; }

/**
 * Read-merge-write under BEGIN IMMEDIATE so two writers (the settings PUT and
 * the backfill progress flush) cannot lose each other's fields. Callers must
 * not hold a transaction of their own; if one is open the write still lands,
 * just without the lock.
 */
export function mutateTypeSafeConfig(fn: (current: TypeSafeConfig) => TypeSafeConfig | TypeSafeConfigPatch): TypeSafeConfig {
  const d = getDb();
  const write = () => {
    const current = mergeTypeSafeConfig(DEFAULT_TYPESAFE_CONFIG, readStored());
    const result = fn(current);
    const next = mergeTypeSafeConfig(current, result);
    next.updatedAt = new Date().toISOString();
    d.prepare('INSERT INTO kv_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(CONFIG_KEY, JSON.stringify(next));
    return next;
  };
  let next: TypeSafeConfig;
  let locked = false;
  try { d.exec('BEGIN IMMEDIATE'); locked = true; } catch { locked = false; }
  try {
    next = write();
    if (locked) d.exec('COMMIT');
  } catch (error) {
    if (locked) { try { d.exec('ROLLBACK'); } catch { /* already rolled back */ } }
    throw error;
  }
  invalidateTypeSafeConfig();
  return next;
}

export function updateTypeSafeConfig(patch: TypeSafeConfigPatch): TypeSafeConfig {
  return mutateTypeSafeConfig(() => patch);
}

// --- Judgment log ---

export interface TypeSafeLogRow {
  id?: number;
  created_at?: string;
  surface: string;
  origin: JudgeOrigin;
  entity_id: string | null;
  model: string | null;
  question_count: number;
  state_preview: string;
  answers: unknown;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cached: 0 | 1;
  error: string | null;
  /** Claude session, native loop run, or MCP memory session that asked. */
  session_id?: string | null;
  project?: string | null;
  /** Lead surface first, then the riders whose questions shared the request; null means [surface]. */
  surfaces?: string[] | null;
  /** What the caller did with the answer (injected vs dropped, stale or not…), written after the fact. */
  outcome?: unknown;
}

/** Rows kept. ~1 KB each; 2,000 covered two minutes of a backfill, 20,000 covers a few hours. */
export const LOG_KEEP = 20000;
const PRUNE_EVERY = 25;
let insertsSincePrune = 0;
const OUTCOME_MAX_CHARS = 4096;
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A session id fit for the log, or null. */
export function cleanSessionId(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID_RE.test(value) ? value : null;
}

/**
 * The session a memory was written from, read back from its `source_ref`
 * (`remember` stores the caller's session there; compaction stores
 * `synabun-compaction:<session>:<generation>`).
 */
export function logSessionFromRef(ref: unknown): string | null {
  if (typeof ref !== 'string' || !ref) return null;
  const compaction = ref.match(/^synabun-compaction:([^:]+):/);
  return cleanSessionId(compaction ? compaction[1] : ref);
}

/** Append one row and return its id. Never throws: the log is diagnostics, not the judgment. */
export function writeTypeSafeLog(row: TypeSafeLogRow): number | null {
  try {
    const d = getDb();
    const result = d.prepare(`INSERT INTO typesafe_log(created_at,surface,origin,entity_id,model,question_count,state_preview,answers,latency_ms,input_tokens,output_tokens,cached,error,session_id,project,surfaces)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.created_at ?? new Date().toISOString(), row.surface, row.origin, row.entity_id, row.model, row.question_count,
      row.state_preview, row.answers == null ? null : JSON.stringify(row.answers),
      Math.round(row.latency_ms), row.input_tokens, row.output_tokens, row.cached, row.error,
      cleanSessionId(row.session_id), typeof row.project === 'string' && row.project ? row.project.slice(0, 200) : null,
      row.surfaces?.length ? JSON.stringify(row.surfaces) : null,
    );
    if (++insertsSincePrune >= PRUNE_EVERY) { insertsSincePrune = 0; pruneTypeSafeLog(); }
    return Number(result.lastInsertRowid);
  } catch { return null; /* diagnostics must never fail the caller */ }
}

/** Record what the caller did with a judgment. Bounded; never throws. */
export function annotateTypeSafeLog(id: number | null | undefined, outcome: unknown): void {
  if (!id) return;
  try {
    let text = JSON.stringify(outcome);
    if (text.length > OUTCOME_MAX_CHARS) text = JSON.stringify({ truncated: true, chars: text.length });
    getDb().prepare('UPDATE typesafe_log SET outcome=? WHERE id=?').run(text, id);
  } catch { /* diagnostics */ }
}

/** Point rows logged under a provisional entity id at the one that was finally stored. */
export function relinkTypeSafeLog(fromEntity: string, toEntity: string): void {
  if (!fromEntity || !toEntity || fromEntity === toEntity) return;
  try { getDb().prepare('UPDATE typesafe_log SET entity_id=? WHERE entity_id=?').run(toEntity, fromEntity); } catch { /* diagnostics */ }
}

/** Keep only the newest `keep` rows. Returns the number deleted. */
export function pruneTypeSafeLog(keep = LOG_KEEP): number {
  try {
    const result = getDb().prepare('DELETE FROM typesafe_log WHERE id <= (SELECT id FROM typesafe_log ORDER BY id DESC LIMIT 1 OFFSET ?)').run(keep);
    return Number(result.changes);
  } catch { return 0; }
}

export interface LogQuery {
  limit?: number; surface?: string; origin?: string; entityId?: string; before?: string;
  sessionId?: string; project?: string; after?: string; order?: 'asc' | 'desc';
}

const parseJson = (value: unknown): unknown => {
  if (value == null) return null;
  try { return JSON.parse(String(value)); } catch { return String(value); }
};

export function readTypeSafeLog(query: LogQuery = {}): TypeSafeLogRow[] {
  const limit = Math.max(1, Math.min(500, Math.floor(Number(query.limit) || 50)));
  const where: string[] = [];
  const params: (string | number)[] = [];
  // A rider is found by its own name too: it shares its lead's row.
  if (query.surface) { where.push("(surface=? OR EXISTS(SELECT 1 FROM json_each(COALESCE(surfaces,'[]')) WHERE value=?))"); params.push(String(query.surface), String(query.surface)); }
  if (query.origin === 'live') where.push("origin NOT IN ('backfill','bench')");
  else if (query.origin) { where.push('origin=?'); params.push(String(query.origin)); }
  if (query.entityId) { where.push('entity_id=?'); params.push(String(query.entityId)); }
  if (query.sessionId) { where.push('session_id=?'); params.push(String(query.sessionId)); }
  if (query.project) { where.push('project=?'); params.push(String(query.project)); }
  if (query.before) { where.push('created_at<?'); params.push(String(query.before)); }
  if (query.after) { where.push('created_at>=?'); params.push(String(query.after)); }
  const order = query.order === 'asc' ? 'ASC' : 'DESC';
  try {
    const rows = getDb().prepare(`SELECT * FROM typesafe_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ${order} LIMIT ?`).all(...params, limit);
    return rows.map(row => ({
      ...(row as unknown as TypeSafeLogRow),
      answers: parseJson(row.answers),
      surfaces: (parseJson(row.surfaces) as string[] | null) ?? null,
      outcome: parseJson(row.outcome),
    }));
  } catch { return []; }
}

export function typesafeLogCount(): number {
  try { return Number((getDb().prepare('SELECT count(*) AS n FROM typesafe_log').get() as { n: number }).n); } catch { return 0; }
}

export interface LogWindowStats { calls: number; failures: number; avgMs: number; inputTokens: number }
export interface TypeSafeLogStats {
  at: string; oldest: string | null;
  surfaces: Record<string, { h24: LogWindowStats; d7: LogWindowStats }>;
  totals: { h24: LogWindowStats; d7: LogWindowStats };
}

let statsCache: { at: number; value: TypeSafeLogStats } | null = null;
const STATS_TTL_MS = 10_000;
const emptyWindow = (): LogWindowStats => ({ calls: 0, failures: 0, avgMs: 0, inputTokens: 0 });

/**
 * Real-time judgments over the last 24 h and 7 days, read from the log rather
 * than from per-process counters, so they survive a restart and include every
 * process. Riders count toward their own surface; tokens count toward the lead,
 * which is the request that paid for them. Backfill and bench are excluded.
 */
export function typesafeLogStats(): TypeSafeLogStats {
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const h24 = new Date(now - 86_400_000).toISOString();
  const d7 = new Date(now - 7 * 86_400_000).toISOString();
  const value: TypeSafeLogStats = { at: new Date(now).toISOString(), oldest: null, surfaces: {}, totals: { h24: emptyWindow(), d7: emptyWindow() } };
  try {
    const d = getDb();
    value.oldest = (d.prepare('SELECT MIN(created_at) AS t FROM typesafe_log').get() as { t: string | null } | undefined)?.t ?? null;
    const perSurface = d.prepare(`SELECT s.value AS surface,
        SUM(l.created_at>=?) AS calls24, SUM(l.created_at>=? AND l.error IS NOT NULL) AS failures24,
        AVG(CASE WHEN l.created_at>=? AND l.error IS NULL AND l.cached=0 THEN l.latency_ms END) AS avg24,
        SUM(CASE WHEN l.created_at>=? AND s.value=l.surface THEN l.input_tokens ELSE 0 END) AS tokens24,
        COUNT(*) AS calls7, SUM(l.error IS NOT NULL) AS failures7,
        AVG(CASE WHEN l.error IS NULL AND l.cached=0 THEN l.latency_ms END) AS avg7,
        SUM(CASE WHEN s.value=l.surface THEN l.input_tokens ELSE 0 END) AS tokens7
      FROM typesafe_log l, json_each(COALESCE(l.surfaces, json_array(l.surface))) s
      WHERE l.created_at>=? AND l.origin NOT IN ('backfill','bench') GROUP BY s.value`).all(h24, h24, h24, h24, d7);
    for (const r of perSurface) {
      value.surfaces[String(r.surface)] = {
        h24: { calls: Number(r.calls24) || 0, failures: Number(r.failures24) || 0, avgMs: Math.round(Number(r.avg24) || 0), inputTokens: Number(r.tokens24) || 0 },
        d7: { calls: Number(r.calls7) || 0, failures: Number(r.failures7) || 0, avgMs: Math.round(Number(r.avg7) || 0), inputTokens: Number(r.tokens7) || 0 },
      };
    }
    const totals = d.prepare(`SELECT SUM(created_at>=?) AS calls24, SUM(created_at>=? AND error IS NOT NULL) AS failures24,
        AVG(CASE WHEN created_at>=? AND error IS NULL AND cached=0 THEN latency_ms END) AS avg24,
        SUM(CASE WHEN created_at>=? THEN input_tokens ELSE 0 END) AS tokens24,
        COUNT(*) AS calls7, SUM(error IS NOT NULL) AS failures7,
        AVG(CASE WHEN error IS NULL AND cached=0 THEN latency_ms END) AS avg7, SUM(input_tokens) AS tokens7
      FROM typesafe_log WHERE created_at>=? AND origin NOT IN ('backfill','bench')`).get(h24, h24, h24, h24, d7) as Record<string, unknown> | undefined;
    if (totals) {
      value.totals = {
        h24: { calls: Number(totals.calls24) || 0, failures: Number(totals.failures24) || 0, avgMs: Math.round(Number(totals.avg24) || 0), inputTokens: Number(totals.tokens24) || 0 },
        d7: { calls: Number(totals.calls7) || 0, failures: Number(totals.failures7) || 0, avgMs: Math.round(Number(totals.avg7) || 0), inputTokens: Number(totals.tokens7) || 0 },
      };
    }
  } catch { /* an unreadable log reads as empty */ }
  statsCache = { at: now, value };
  return value;
}

export interface TypeSafeSessionRow {
  session_id: string; project: string | null; first_at: string; last_at: string;
  calls: number; failures: number; surfaces: Record<string, number>;
}

/** Sessions that asked for judgments, newest first, with per-surface counts (riders included). */
export function typesafeSessions(query: { since?: string; project?: string; limit?: number } = {}): TypeSafeSessionRow[] {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(query.limit) || 30)));
  const since = query.since && Number.isFinite(Date.parse(query.since)) ? new Date(query.since).toISOString() : new Date(Date.now() - 7 * 86_400_000).toISOString();
  try {
    const d = getDb();
    const where = ['session_id IS NOT NULL', 'created_at>=?'];
    const params: (string | number)[] = [since];
    if (query.project) { where.push('project=?'); params.push(String(query.project)); }
    const rows = d.prepare(`SELECT session_id, MAX(project) AS project, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
        COUNT(*) AS calls, SUM(error IS NOT NULL) AS failures
      FROM typesafe_log WHERE ${where.join(' AND ')} GROUP BY session_id ORDER BY last_at DESC LIMIT ?`).all(...params, limit);
    if (!rows.length) return [];
    const ids = rows.map(r => String(r.session_id));
    const counts = d.prepare(`SELECT l.session_id, s.value AS surface, COUNT(*) AS n
      FROM typesafe_log l, json_each(COALESCE(l.surfaces, json_array(l.surface))) s
      WHERE l.session_id IN (${ids.map(() => '?').join(',')}) AND l.created_at>=? GROUP BY l.session_id, s.value`).all(...ids, since);
    const bySession = new Map<string, Record<string, number>>();
    for (const c of counts) {
      const key = String(c.session_id);
      const entry = bySession.get(key) ?? {};
      entry[String(c.surface)] = Number(c.n) || 0;
      bySession.set(key, entry);
    }
    return rows.map(r => ({
      session_id: String(r.session_id), project: r.project == null ? null : String(r.project),
      first_at: String(r.first_at), last_at: String(r.last_at),
      calls: Number(r.calls) || 0, failures: Number(r.failures) || 0,
      surfaces: bySession.get(String(r.session_id)) ?? {},
    }));
  } catch { return []; }
}

// --- Credential redaction (shared by the log preview and the secret gate) ---

export interface CredentialPattern { type: string; re: RegExp; /** capture group that holds the secret; the rest of the match is kept */ group?: number; precise: boolean }

/**
 * `precise` patterns are unambiguous on their own (a prefix or envelope that
 * only a real token has). The rest need context or a judgment before they
 * are treated as secrets: `token=abcdef12` might be an example.
 */
export const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  { type: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, precise: true },
  { type: 'api-key', re: /\b(?:sk|rk|pk)[-_](?:live|test|proj|ant|or|api)?[-_]?[A-Za-z0-9_-]{16,}/g, precise: true },
  { type: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, precise: true },
  { type: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, precise: true },
  { type: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g, precise: true },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, precise: true },
  { type: 'bearer', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1, precise: false },
  { type: 'secret', re: /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|pwd|token|secret|authorization)\s*["']?\s*[:=]\s*["']?([^\s"',;]{8,})/gi, group: 1, precise: false },
];

export interface CredentialSpan { start: number; end: number; text: string; type: string; precise: boolean }

/** Every credential-looking span, non-overlapping, earliest first. */
export function findCredentialSpans(text: string): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of text.matchAll(pattern.re)) {
      const whole = match[0];
      const secret = pattern.group ? match[pattern.group] : whole;
      if (!secret) continue;
      const offset = pattern.group ? whole.indexOf(secret) : 0;
      const start = (match.index ?? 0) + offset;
      spans.push({ start, end: start + secret.length, text: secret, type: pattern.type, precise: pattern.precise });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: CredentialSpan[] = [];
  for (const span of spans) {
    const last = kept[kept.length - 1];
    if (last && span.start < last.end) continue;
    kept.push(span);
  }
  return kept;
}

/** Replace the given spans (or every credential-looking span) with `[redacted:<type>]`. */
export function redactSpans(text: string, spans: CredentialSpan[] = findCredentialSpans(text)): string {
  let out = '';
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start) + `[redacted:${span.type}]`;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

export function redactCredentials(text: string): string { return redactSpans(text); }

/** A bounded, credential-free preview of a judgment's state for the log. Redact first, then cut. */
export function statePreview(state: unknown, limit = 500): string {
  let text: string;
  try { text = typeof state === 'string' ? state : JSON.stringify(state); } catch { text = String(state); }
  const clean = redactCredentials(text ?? '');
  return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean;
}
