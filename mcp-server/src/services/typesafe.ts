/**
 * TypeSafe System One client (Jev).
 *
 * Returns typed judgments — Choice / Noul / Score — where SynaBun would
 * otherwise hard-code a regex or a similarity constant. Raw `fetch` rather
 * than `@typesafe-ai/sdk`: the wire format is three fields and mcp-server
 * keeps a deliberately small dependency list.
 *
 * Contract (verified against the live API, 2026-09-18):
 *   POST https://api.typesafe.ai/v1/systemone
 *   { model, state, questions } -> { model, usage, answers }
 *   - noul   -> { type, noul }                                  P(yes); there is NO confidence field
 *   - choice -> { type, choice, confidence, probabilities }      probabilities sum to 1
 *   - score  -> { type, score, confidence, legend, probabilities }
 * The response `model` does not echo the request verbatim — never assert on it.
 *
 * Every call site must survive `null`. `judge()` never throws and never
 * rejects: on a missing key, a disabled surface, timeout, non-2xx or
 * malformed body it returns null and the caller falls back to its original
 * heuristic. That is error handling, not a feature flag — a network blip must
 * not break `remember`.
 *
 * Runtime knobs (master switch, per-surface enable/timeout, model, base URL)
 * come from typesafe-config.ts, which reads kv_config so the Judgments tab
 * changes them for every process without a restart. Only the API key and the
 * SYNABUN_TYPESAFE=off kill switch stay in the environment.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { getEnvPath } from '../config.js';
import { callerMemoryContext } from './identity.js';
import {
  typesafeConfig, surfaceConfig, writeTypeSafeLog, statePreview, cleanSessionId,
  DEFAULT_BASE_URL, DEFAULT_MODEL, type JudgeOrigin,
} from './typesafe-config.js';

const API_PATH = '/v1/systemone';
const CACHE_LIMIT = 500;

// --- Question builders (mirror the SDK's, so docs examples port verbatim) ---

export type Instructions = string | Record<string, unknown> | unknown[] | null;

export interface NoulQuestion { type: 'noul'; instructions: Instructions; criteria?: { true?: string; false?: string } }
export interface ChoiceQuestion { type: 'choice'; instructions: Instructions; criteria: Record<string, string | null> }
export interface ScoreQuestion { type: 'score'; instructions: Instructions; criteria: (string | null)[] }
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Yes/no. The answer is P(yes) — 0.5 means "equally likely", not "medium intensity". */
export function noul(instructions: Instructions, criteria?: { true?: string; false?: string }): NoulQuestion {
  return { type: 'noul', instructions, criteria };
}

/** One of a named set. `criteria` maps label -> description (null for undescribed). */
export function choice(instructions: Instructions, criteria: Record<string, string | null>): ChoiceQuestion {
  return { type: 'choice', instructions, criteria };
}

/** Ordered rubric; `criteria[0]` is the lowest level. At least two are required. */
export function score(instructions: Instructions, criteria: (string | null)[]): ScoreQuestion {
  if (criteria.length < 2) throw new Error('Score questions need at least two ordered levels.');
  return { type: 'score', instructions, criteria };
}

// --- Answers ---

export interface NoulAnswer { type: 'noul'; noul: number }
export interface ChoiceAnswer { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
export interface ScoreAnswer { type: 'score'; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> }
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Answers = Record<string, Answer>;

// --- Key resolution ---

let cachedKey: string | null | undefined;

function readDotenvKey(): string | null {
  try {
    const envPath = getEnvPath();
    if (!existsSync(envPath)) return null;
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      if (trimmed.slice(0, eq).trim() !== 'TYPESAFE_API_KEY') continue;
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      return value || null;
    }
  } catch { /* unreadable .env is the same as no key */ }
  return null;
}

/**
 * Environment first, then SynaBun's own .env. The `:3344` server inherits the
 * shell that launched it, which is not necessarily the shell that exported the
 * key — reading the .env as a fallback keeps a launcher-started server working.
 */
export function typesafeApiKey(): string | null {
  // Operational kill switch, not a privacy toggle: it exists so the test suite
  // is deterministic and so an operator can stop outbound calls during an
  // incident without editing code or revoking a key.
  if (process.env.SYNABUN_TYPESAFE === 'off') return null;
  if (cachedKey !== undefined) return cachedKey;
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return (cachedKey = fromEnv);
  return (cachedKey = readDotenvKey());
}

/** Forget the resolved key so a .env edit takes effect without a restart. */
export function resetTypeSafeKey(): void { cachedKey = undefined; }

export interface KeyInfo { hasKey: boolean; last4: string | null; source: 'env' | 'dotenv' | 'none'; shadowed: boolean }

/**
 * Where the key in use comes from, read fresh (bypasses the cache and the kill
 * switch). `shadowed` means a key saved in .env is being ignored because the
 * process was launched from a shell that exported a different one — the
 * settings page has to say so, or "Save" looks broken.
 */
export function typesafeKeyInfo(): KeyInfo {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim() || null;
  const fromFile = readDotenvKey();
  const active = fromEnv ?? fromFile;
  if (!active) return { hasKey: false, last4: null, source: 'none', shadowed: false };
  const source: KeyInfo['source'] = fromEnv && fromEnv !== fromFile ? 'env' : 'dotenv';
  return { hasKey: true, last4: active.slice(-4), source, shadowed: Boolean(fromEnv && fromFile && fromEnv !== fromFile) };
}

export interface BaseUrlInfo { url: string; source: 'env' | 'config' | 'default'; shadowed: boolean }

export function typesafeBaseUrl(): BaseUrlInfo {
  const fromEnv = process.env.TYPESAFE_BASE_URL?.trim().replace(/\/+$/, '') || null;
  const fromConfig = typesafeConfig().baseUrl?.replace(/\/+$/, '') || null;
  if (fromEnv) return { url: fromEnv, source: 'env', shadowed: Boolean(fromConfig && fromConfig !== fromEnv) };
  if (fromConfig) return { url: fromConfig, source: 'config', shadowed: false };
  return { url: DEFAULT_BASE_URL, source: 'default', shadowed: false };
}

/** Env kill switch off, kv master switch on, and a key resolved. */
export function typesafeEnabled(): boolean {
  if (process.env.SYNABUN_TYPESAFE === 'off') return false;
  if (!typesafeConfig().enabled) return false;
  return typesafeApiKey() !== null;
}

// --- Cache ---

/**
 * Judgments are pure in (state, questions, model), so identical inputs reuse
 * the answer. Insertion-ordered Map evicting the oldest entry is enough: the
 * hot case is a maintenance re-index over rows whose content did not change.
 */
const cache = new Map<string, Answers>();

function cacheKey(model: string, state: unknown, questions: Record<string, Question>): string {
  return createHash('sha256').update(JSON.stringify({ model, state, questions })).digest('hex');
}

export function typesafeCacheSize(): number { return cache.size; }
export function clearTypeSafeCache(): void { cache.clear(); }

// --- Metrics (surfaced through /api/typesafe/config for cost/latency review) ---

export interface SurfaceMetrics { calls: number; hits: number; failures: number; cached: number; skipped: number; inputTokens: number; outputTokens: number; totalMs: number }

const emptySurface = (): SurfaceMetrics => ({ calls: 0, hits: 0, failures: 0, cached: 0, skipped: 0, inputTokens: 0, outputTokens: 0, totalMs: 0 });

export const typesafeMetrics = {
  calls: 0, hits: 0, failures: 0, cached: 0, skipped: 0,
  inputTokens: 0, outputTokens: 0, totalMs: 0,
  lastError: null as string | null,
  lastErrorAt: null as string | null,
  /** Set from a 429's retry-after header; the backfill waits it out. */
  retryAfterUntil: 0,
  surfaces: {} as Record<string, SurfaceMetrics>,
};

function surfaceMetrics(name: string): SurfaceMetrics {
  return (typesafeMetrics.surfaces[name] ??= emptySurface());
}

export function resetTypeSafeMetrics(): void {
  Object.assign(typesafeMetrics, { calls: 0, hits: 0, failures: 0, cached: 0, skipped: 0, inputTokens: 0, outputTokens: 0, totalMs: 0, lastError: null, lastErrorAt: null, retryAfterUntil: 0, surfaces: {} });
}

export function typesafeStats() {
  const surfaces: Record<string, SurfaceMetrics & { avgMs: number }> = {};
  for (const [name, m] of Object.entries(typesafeMetrics.surfaces)) surfaces[name] = { ...m, avgMs: m.hits ? Math.round(m.totalMs / m.hits) : 0 };
  return {
    calls: typesafeMetrics.calls, hits: typesafeMetrics.hits, failures: typesafeMetrics.failures, cached: typesafeMetrics.cached, skipped: typesafeMetrics.skipped,
    inputTokens: typesafeMetrics.inputTokens, outputTokens: typesafeMetrics.outputTokens, totalMs: typesafeMetrics.totalMs,
    lastError: typesafeMetrics.lastError, lastErrorAt: typesafeMetrics.lastErrorAt,
    retryAfterMs: Math.max(0, typesafeMetrics.retryAfterUntil - Date.now()),
    enabled: typesafeEnabled(),
    killSwitch: process.env.SYNABUN_TYPESAFE === 'off',
    masterEnabled: typesafeConfig().enabled,
    cacheSize: cache.size,
    avgMs: typesafeMetrics.hits ? Math.round(typesafeMetrics.totalMs / typesafeMetrics.hits) : 0,
    surfaces,
  };
}

/** Milliseconds a 429 asked us to wait, or 0. */
export function typesafeRetryAfterMs(): number { return Math.max(0, typesafeMetrics.retryAfterUntil - Date.now()); }

// --- The call ---

export interface JudgeUsage {
  inputTokens: number; outputTokens: number; latencyMs: number; cached: boolean;
  /** The versioned id the API says answered; for reports only, never asserted on. */
  model?: string | null;
}

export interface JudgeOptions {
  model?: string;
  timeoutMs?: number;
  /** Skip the cache for this call (used by the bench, which measures cold latency). */
  noCache?: boolean;
  /** Caller cancellation. Combined with the timeout, never instead of it. */
  signal?: AbortSignal;
  /**
   * What the log row shows instead of a preview of `state`. Browser surfaces
   * judge page content, which must not reach typesafe_log; they pass metadata
   * here, and a `browser-*` or `desktop-*` call that forgets to is logged as `[withheld]`.
   * Still credential-redacted and cut like any other preview.
   */
  logPreview?: string;
  /** Which SynaBun surface is asking; drives the enable/timeout lookup and the log row. */
  surface?: string;
  origin?: JudgeOrigin;
  /** The memory (or other entity) this judgment is about, for the log. */
  entityId?: string;
  /** Which session asked (Claude session, loop run). Defaults to the MCP caller's memory session. */
  sessionId?: string | null;
  /** Which project it was asked for. Defaults to the MCP caller's project. */
  project?: string | null;
  /** Surfaces whose questions ride in this request, logged beside the lead `surface`. */
  riders?: string[];
  /** Called with the log row id, so the caller can annotate what it did with the answer. */
  onLogged?: (id: number | null) => void;
  /** Called with token/latency usage on every answered call, including cache hits. */
  onUsage?: (usage: JudgeUsage) => void;
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

/**
 * Ask one or more independent judgments over a single state.
 *
 * Batch freely: questions in one request run in parallel and cannot see each
 * other's answers, so N judgments over the same evidence cost one round trip.
 * Split into a second request only when an answer is needed to build the next
 * state. Returns null on any failure — callers fall back to their heuristic.
 */
export async function judge(
  state: unknown,
  questions: Record<string, Question>,
  options: JudgeOptions = {},
): Promise<Answers | null> {
  const surface = options.surface ?? 'unknown';
  const origin: JudgeOrigin = options.origin ?? 'live';
  if (!typesafeEnabled()) return null;
  if (!Object.keys(questions).length) return null;
  const settings = surfaceConfig(surface);
  if (options.surface && !settings.enabled) {
    // A disabled surface is a decision, not a failure: no request, no log
    // row, so the counters show it was skipped rather than that it broke.
    surfaceMetrics(surface).skipped++;
    typesafeMetrics.skipped++;
    return null;
  }
  const key = typesafeApiKey();
  if (!key) return null;

  const cfg = typesafeConfig();
  const model = options.model ?? cfg.model ?? DEFAULT_MODEL;
  const questionCount = Object.keys(questions).length;
  const metrics = surfaceMetrics(surface);
  // Withheld by default for browser and desktop surfaces: one forgotten call
  // site must not put 500 characters of someone's page or screen into the log.
  const preview = options.logPreview !== undefined ? statePreview(options.logPreview)
    : /^(?:browser|desktop)-/.test(surface) ? '[withheld]' : statePreview(state);
  // Attribution: an explicit session/project wins; otherwise the MCP caller's
  // own context (the HTTP identity or the stdio server's environment).
  let caller: { project?: string; session?: string } = {};
  if (options.sessionId === undefined || options.project === undefined) { try { caller = callerMemoryContext() ?? {}; } catch { caller = {}; } }
  const sessionId = cleanSessionId(options.sessionId === undefined ? caller.session : options.sessionId);
  const project = (options.project === undefined ? caller.project : options.project) || null;
  const riders = options.riders?.filter(r => r && r !== surface) ?? [];
  const log = (fields: { answers?: Answers | null; latencyMs: number; inputTokens: number; outputTokens: number; cached: boolean; error: string | null; model?: string | null }) => {
    const id = writeTypeSafeLog({
      surface, origin, entity_id: options.entityId ?? null, model: fields.model ?? model,
      question_count: questionCount, state_preview: preview, answers: fields.answers ?? null,
      latency_ms: fields.latencyMs, input_tokens: fields.inputTokens, output_tokens: fields.outputTokens,
      cached: fields.cached ? 1 : 0, error: fields.error,
      session_id: sessionId, project, surfaces: riders.length ? [surface, ...riders] : null,
    });
    try { options.onLogged?.(id); } catch { /* a caller's bookkeeping must not break the judgment */ }
  };

  const hash = cacheKey(model, state, questions);
  if (!options.noCache) {
    const cached = cache.get(hash);
    if (cached) {
      typesafeMetrics.cached++; metrics.cached++;
      options.onUsage?.({ inputTokens: 0, outputTokens: 0, latencyMs: 0, cached: true });
      log({ answers: cached, latencyMs: 0, inputTokens: 0, outputTokens: 0, cached: true, error: null });
      return cached;
    }
  }

  const baseUrl = typesafeBaseUrl().url;
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs ?? cfg.defaultTimeoutMs;
  const started = Date.now();
  typesafeMetrics.calls++; metrics.calls++;
  const fail = (message: string) => {
    typesafeMetrics.failures++; metrics.failures++;
    typesafeMetrics.lastError = message;
    typesafeMetrics.lastErrorAt = new Date().toISOString();
    log({ latencyMs: Date.now() - started, inputTokens: 0, outputTokens: 0, cached: false, error: message });
    return null;
  };
  try {
    const response = await fetch(`${baseUrl}${API_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'synabun-mcp',
      },
      body: JSON.stringify({ model, state, questions }),
      // A caller's signal used to replace the timeout, so a cancellable call
      // could wait forever. Both hold now.
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Never surface the body verbatim: it echoes the request, which carries
      // memory content. Status alone is enough to tell quota from outage.
      if (response.status === 429) {
        const wait = parseRetryAfter(response.headers?.get?.('retry-after') ?? null) || 30_000;
        typesafeMetrics.retryAfterUntil = Date.now() + wait;
      }
      return fail(`HTTP ${response.status}`);
    }
    const body = await response.json() as { model?: string; answers?: Answers; usage?: { input_tokens?: number; output_tokens?: number } };
    if (!body?.answers || typeof body.answers !== 'object') return fail('malformed response');
    const latencyMs = Date.now() - started;
    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    typesafeMetrics.hits++; metrics.hits++;
    typesafeMetrics.totalMs += latencyMs; metrics.totalMs += latencyMs;
    typesafeMetrics.inputTokens += inputTokens; metrics.inputTokens += inputTokens;
    typesafeMetrics.outputTokens += outputTokens; metrics.outputTokens += outputTokens;
    if (!options.noCache) {
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      cache.set(hash, body.answers);
    }
    const answeredBy = typeof body.model === 'string' ? body.model : null;
    options.onUsage?.({ inputTokens, outputTokens, latencyMs, cached: false, model: answeredBy });
    log({ answers: body.answers, latencyMs, inputTokens, outputTokens, cached: false, error: null, model: answeredBy ?? model });
    return body.answers;
  } catch (error) {
    return fail((error as Error).name === 'TimeoutError' ? 'timeout' : (error as Error).message);
  }
}

// --- Typed answer readers (a wrong-typed answer is a miss, not a crash) ---

export function readNoul(answer: Answer | undefined): number | null {
  return answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : null;
}

export function readChoice(answer: Answer | undefined): { choice: string; confidence: number } | null {
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string') return null;
  return { choice: answer.choice, confidence: Number.isFinite(answer.confidence) ? answer.confidence : 0 };
}

export function readScore(answer: Answer | undefined): { score: number; confidence: number } | null {
  if (answer?.type !== 'score' || !Number.isFinite(answer.score)) return null;
  return { score: answer.score, confidence: Number.isFinite(answer.confidence) ? answer.confidence : 0 };
}
