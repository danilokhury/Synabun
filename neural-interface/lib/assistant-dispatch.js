// ═══════════════════════════════════════════
// SynaBun — Assistant dispatcher (task-mode runs on NativeLoopRuntime)
// ═══════════════════════════════════════════
//
// A "dispatch" is one worker run launched by the central assistant: a single
// provider conversation (Claude / Codex / OpenCode) that executes one task,
// then stays warm for follow-up turns until the assistant completes it or the
// idle timeout fires. It rides on NativeLoopRuntime (ledger, claims, sidepanel
// attach) through the per-launch buildPrompt/wrapAdapter overrides, so the
// existing router shows it as an automation tab in the matching sidepanel.
//
// This module owns: validation + rails (concurrency, budgets, quarantine),
// the task adapter wrapper (turn loop), result capture, the permission broker
// for 'ask' dispatches, waits, transcripts, the dispatch registry, the
// auto-remember hook, and the runs' usage meters (assistant-usage.js: exact
// tokens per task into the usage ledger, and the Codex / OpenCode dollars).
// It never touches server.js internals directly — every server dependency is
// injected.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  RESULT_STATUSES, buildTaskPrompt, buildFollowUpPrompt, buildResultRetryPrompt, parseResultContract,
} from './assistant-task-prompt.js';
import { normalizeCapability, normalizePermissionPolicy } from './native-loop-providers.js';
import { contextVariantOf, defaultIsHidden, defaultModelRow, findModel, hiddenModelId, providerAllHidden, providerEmpty, rowMakes } from './assistant-catalog.js';
import { TASK_CLASS_META, classPlaybook, collectedMedia, describeTarget, designFit, requiredOutput, requiresVision, runContract } from './assistant-router.js';
import { MAX_MEDIA_BYTES, MAX_RUN_MEDIA_BYTES, copyRunMedia, mediaType, mediaUrl, servableRunMedia } from './assistant-media.js';
import { loadPlaybook } from './assistant-playbooks.js';
import { loadStyleGuideForRun } from './style-guide/store.js';
import { normalizeEffort } from './effort-levels.js';
import { createTurnEvidence, recordProviderEvent, evidenceSnapshot, claimEvidenceLine } from './assistant-evidence.js';
import { codexUsageCostUsd } from './assistant-budget.js';
import { CLAUDE_ESTIMATE_SOURCE, CODEX_USAGE_KEYS, TOKEN_KEYS, addTokens, codexUsageTokens, createClaudeMeter, createCodexMeter, createOpenCodeMeter, totalTokens, withTotal, zeroTokens } from './assistant-usage.js';
import { claudeTokensCostUsd } from './assistant-pricing.js';
import { RemotePolicyError, clampDispatchSpec, getSessionPolicy, readRegisteredProjects } from './remote-policy.js';

export const NATIVE_PROVIDERS = new Set(['claude-code', 'codex', 'opencode']);
// awaiting_route: an un-routed dispatch held until the user picks a model on
// the route card (ask modes). It is active but consumes no rails.
export const ACTIVE_STATES = new Set(['queued', 'awaiting_route', 'starting', 'running', 'idle', 'awaiting_permission']);
export const TERMINAL_STATES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const WAITING_STATES = new Set(['queued', 'awaiting_route']);

/**
 * The run status a view reports beside its state (the agent_status contract:
 * queued, starting, running, completed, failed, stopped, interrupted). A warm
 * worker between turns (idle, awaiting_permission) is still running; a run
 * held for the user's model choice is still queued.
 */
export function runStatusFromState(state) {
  const value = String(state || '');
  if (TERMINAL_STATES.has(value)) return value;
  if (WAITING_STATES.has(value)) return 'queued';
  if (value === 'starting') return 'starting';
  return ACTIVE_STATES.has(value) ? 'running' : null;
}

export const DEFAULT_LIMITS = Object.freeze({
  perProvider: Object.freeze({ 'claude-code': 3, codex: 4, opencode: 3 }),
  perCodexAccount: 2,
  perSession: 6,
  queuedPerSession: 20,
  heldPerSession: 10,
  maxFanOut: 6,
  defaultMaxMinutes: 45,
  maxMaxMinutes: 240,
  // Budget caps (USD). The live values come from assistant-config.json through
  // `readLimits` (assistant-budget.js); these are the defaults.
  defaultBudgetUsd: 5,
  maxBudgetUsd: 25,
  sessionSoftBudgetUsd: 10,
  sessionWarnUsd: 8,
  sessionHardBudgetUsd: 25,
  brainBudgetUsd: 10,
  permissionTimeoutMs: 10 * 60_000,
  questionTimeoutMs: 30 * 60_000,
  idleTimeoutMs: 20 * 60_000,
  minIdleTimeoutMs: 30_000,
  maxIdleTimeoutMs: 6 * 60 * 60_000,
  maxTurns: 6,
  maxMaxTurns: 20,
  waitCapMs: 120_000,
  stalledAfterMs: 15 * 60_000,
  ringSize: 2000,
  ringChars: 200_000,
  retention: 500,
  idempotencyTtlMs: 24 * 60 * 60_000,
  // How often a running Codex turn's rollout is read for new usage (assistant-usage.js).
  usagePollMs: 2000,
  // How long an OpenCode turn's end waits for the serve's stored messages. Past it the turn is
  // settled as not reconciled (partial) and the run is free for its next turn.
  usageReconcileMs: 10_000,
  // What an image / video creation or design run may collect (assistant-media.js): per file, and every turn together.
  mediaFileBytes: MAX_MEDIA_BYTES,
  mediaRunBytes: MAX_RUN_MEDIA_BYTES,
});

/**
 * What a class's run gets when the dispatch leaves a field out (undefined, null
 * or ''): a design run works in its project with the SynaBun browser for an hour.
 * Explicit values win. The browser profile comes with the browser: an explicit
 * uses_browser:false keeps the run off it (no `browser` profile, which would turn
 * browser use back on, and no tab), on the normal default profile. The browser
 * rule for capability "full" (QUARANTINE_VIOLATION) still applies. Any class's
 * browser run on Codex / OpenCode without an mcp_profile gets BROWSER_PROFILE
 * (normalizeSpec): the stock default profiles have no browser tools.
 */
export const CLASS_DEFAULTS = Object.freeze({
  design: Object.freeze({ capability: 'workspace', usesBrowser: true, mcpProfile: 'browser', maxMinutes: 60 }),
});
/** The MCP profile of a Codex / OpenCode browser run that names none (Claude workers always get 'full'). */
export const BROWSER_PROFILE = 'browser';
// MCP presets that turn browser use on (normalizeSpec reads a run on one as a browser run),
// and the stock presets with no browser tools (profiles.ts: core, standard).
const BROWSER_PROFILE_RE = /^(browser|twitter|facebook|tiktok|whatsapp|instagram|linkedin|bluesky|gsc|youtube)$/i;
const NO_BROWSER_PRESETS = new Set(['core', 'standard']);
function turnsBrowserOn(profile) {
  const name = String(profile || '');
  return BROWSER_PROFILE_RE.test(name) || /browser/i.test(name);
}
/**
 * Browser settings of a run (any class) that cannot work together, after CLASS_DEFAULTS (so a
 * uses_browser false and any mcp_profile are the brain's own): the text of a
 * BROWSER_SETTINGS_CONFLICT (400) that says what to change, else null. An explicit browser
 * profile would turn an explicit uses_browser:false back on; a stock profile without the browser
 * tools leaves a Codex / OpenCode worker unable to use the browser the run gets (Claude workers
 * always get the full catalog). `provider` null: only the first check (it does not depend on it).
 */
export function browserSettingsConflict(spec, provider = null) {
  const profile = String(spec?.mcpProfile || '').trim();
  if (!profile) return null;
  if (spec.usesBrowser === false && turnsBrowserOn(profile)) {
    return `uses_browser is false, but mcp_profile "${profile}" is a browser profile, which turns browser use back on (the run would take a browser tab). Drop mcp_profile or pick one without the browser (such as "standard"), or set uses_browser to true.`;
  }
  if (provider && provider !== 'claude-code' && spec.usesBrowser === true && NO_BROWSER_PRESETS.has(profile.toLowerCase())) {
    return `This run uses the SynaBun browser (uses_browser is on), but mcp_profile "${profile}" has no browser tools, so the ${provider} worker could not use it. Use mcp_profile "browser" or drop mcp_profile, or set uses_browser to false.`;
  }
  return null;
}
/** `spec` with its class's defaults filled in where it leaves a field out. */
export function withClassDefaults(spec, taskClass) {
  if (!spec) return spec;
  const defaults = CLASS_DEFAULTS[taskClass];
  // "true" / "false" strings are the booleans they name, in every class (normalizeSpec would read
  // "false" as browser use, and browserSettingsConflict checks the booleans).
  const named = spec.usesBrowser === 'true' || spec.usesBrowser === 'false';
  if (!defaults && !named) return spec;
  const out = { ...spec };
  if (named) out.usesBrowser = out.usesBrowser === 'true';
  if (!defaults) return out;
  for (const [key, value] of Object.entries(defaults)) {
    if (!(out[key] === undefined || out[key] === null || out[key] === '')) continue;
    if (key === 'mcpProfile' && out.usesBrowser === false) continue;
    out[key] = value;
  }
  return out;
}

export class DispatchError extends Error {
  constructor(code, message, { status = 400, ...extra } = {}) {
    super(message);
    this.name = 'DispatchError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
  toJSON() {
    const { code, message, status, ...rest } = { code: this.code, message: this.message, status: this.status, ...this };
    const out = { code, message };
    for (const [key, value] of Object.entries(rest)) if (!['name', 'stack'].includes(key)) out[key] = value;
    return out;
  }
}

/**
 * Why a run of a class that needs a model that can see (design) cannot run on provider/model,
 * else null: MODEL_CANNOT_SEE or MODEL_UNAVAILABLE (409, with suggestions). The verdict is the
 * router's designFit(), so a claude-* id the catalog does not list is not known to see here
 * either. It fails closed: with no catalog value sight cannot be confirmed, so the run is refused
 * (reason catalog_unavailable; agent_route declines design without a catalog too). Image / video
 * creation's backstop still skips its check without a catalog.
 */
function designRefusal(catalogValue, provider, model, taskClass) {
  if (!requiresVision(taskClass)) return null;
  const label = TASK_CLASS_META[taskClass].label;
  if (!catalogValue) {
    return new DispatchError('MODEL_CANNOT_SEE', `Can't confirm that ${model ? `model "${model}"` : `the ${provider} default model`} can see images right now: the model catalog is unavailable. ${label} only runs on a model known to see; try again shortly.`, { status: 409, reason: 'catalog_unavailable' });
  }
  const fit = designFit(catalogValue, { kind: 'dispatch', provider, model: model || null });
  if (fit === 'ok') return null;
  const who = model ? `Model "${model}"` : `The ${provider} default model`;
  const suggestions = (catalogValue.models?.[provider] || []).filter((r) => r.vision === true && r.status !== 'unavailable').slice(0, 5).map((r) => r.id);
  if (fit === 'unavailable') return new DispatchError('MODEL_UNAVAILABLE', `${who} is marked unavailable in the catalog; ${label} needs an available model that can see.`, { status: 409, suggestions });
  return new DispatchError('MODEL_CANNOT_SEE', `${who} ${fit === 'blind' ? 'cannot see images' : 'is not known to see images'}; ${label} needs a model that can (agent_catalog marks them vision).`, { status: 409, suggestions });
}

function iso(now = Date.now()) { return new Date(now).toISOString(); }
function readJson(path, fallback = null) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}
function clip(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function isDirectory(path) { try { return statSync(path).isDirectory(); } catch { return false; } }

/** One-line human summary of a provider stream event (used for transcript tails). */
export function summarizeProviderEvent(payload = {}) {
  const event = payload.event || {};
  const eventType = payload.eventType || event.type || '';
  if (eventType === 'synabun.user_prompt') return `user: ${clip(event.text, 200)}`;
  if (eventType === 'synabun.permission_request') return `permission requested: ${event.toolName || event.kind || 'tool'} ${clip(JSON.stringify(event.input || {}), 120)}`;
  if (eventType === 'synabun.permission_resolved') return `permission ${event.behavior || 'resolved'}: ${event.toolName || ''}`;
  if (eventType === 'synabun.error') return `error: ${clip(event.message, 200)}`;
  if (payload.provider === 'claude-code') {
    if (event.type === 'assistant') {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      const lines = [];
      for (const block of blocks) {
        if (block?.type === 'text' && block.text?.trim()) lines.push(`assistant: ${clip(block.text, 200)}`);
        else if (block?.type === 'tool_use') lines.push(`tool: ${block.name}(${clip(JSON.stringify(block.input || {}), 140)})`);
      }
      return lines.length ? lines.join('\n') : null;
    }
    if (event.type === 'user') {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      const results = blocks.filter((block) => block?.type === 'tool_result');
      if (!results.length) return null;
      return results.map((block) => {
        const content = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.map((c) => c?.text || '').join(' ') : '';
        return `${block.is_error ? 'tool_error' : 'tool_result'}: ${clip(content, 160)}`;
      }).join('\n');
    }
    if (event.type === 'result') return `result(${event.subtype || 'unknown'}): ${clip(event.result, 200)}`;
    if (event.type === 'system' && event.subtype === 'init') return `system: session ${event.session_id || ''} model ${event.model || ''}`;
    return null;
  }
  if (payload.provider === 'codex') {
    if (event.type === 'item.completed' || event.type === 'item.started') {
      const item = event.item || {};
      const phase = event.type === 'item.started' ? 'started' : 'done';
      if (item.type === 'agent_message') return phase === 'done' ? `assistant: ${clip(item.text, 200)}` : null;
      if (item.type === 'command_execution') return `command ${phase}: ${clip(item.command, 140)}${item.exit_code !== undefined && phase === 'done' ? ` (exit ${item.exit_code})` : ''}`;
      if (item.type === 'file_change') return `file_change ${phase}: ${clip((item.changes || []).map((c) => c.path).join(', '), 160)}`;
      if (item.type === 'mcp_tool_call') return `tool ${phase}: ${item.server || ''}.${item.tool || ''}`;
      if (item.type === 'reasoning') return null;
      if (item.type === 'web_search') return `web_search: ${clip(item.query, 120)}`;
      return `${item.type || 'item'} ${phase}`;
    }
    if (event.type === 'turn.completed') return `turn completed${event.usage ? ` (in ${event.usage.input_tokens || 0} / out ${event.usage.output_tokens || 0} tokens)` : ''}`;
    if (event.type === 'turn.failed') return `error: ${clip(event.error?.message, 200)}`;
    if (event.type === 'error') return `error: ${clip(event.message, 200)}`;
    return null;
  }
  if (payload.provider === 'opencode') {
    if (/^message[.:]part[.:]updated$/i.test(eventType)) {
      const part = event.part || {};
      if (part.type === 'tool') return `tool: ${part.tool || part.name || 'tool'} ${part.state?.status || ''}`.trim();
      return null;
    }
    if (/^session[.:]idle$/i.test(eventType)) return 'turn completed';
    if (/^session[.:]error$/i.test(eventType)) return `error: ${clip(event.error?.message || event.error || 'session error', 200)}`;
    if (/permission\.asked/i.test(eventType)) return `permission asked: ${event.permission || event.type || ''}`;
    if (/question\.asked/i.test(eventType)) return `question asked: ${clip((event.questions || []).map((q) => q.question).join(' | '), 200)}`;
    return null;
  }
  return null;
}

function mergeLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, perProvider: { ...DEFAULT_LIMITS.perProvider } };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (key === 'perProvider' && value && typeof value === 'object') Object.assign(limits.perProvider, value);
    else if (value !== undefined && value !== null) limits[key] = value;
  }
  // Older configs name a soft budget and warned at 80 % of it.
  const soft = Number(overrides?.sessionSoftBudgetUsd);
  if ((overrides?.sessionWarnUsd === undefined || overrides?.sessionWarnUsd === null) && Number.isFinite(soft) && soft > 0) limits.sessionWarnUsd = Math.round(soft * 80) / 100;
  return limits;
}

const r4 = (value) => Number((Number(value) || 0).toFixed(4));
const usd = (value) => `$${(Number(value) || 0).toFixed(2)}`;
// How sure a run's cost is, weakest last: a run shows the weakest basis any of its turns had.
const COST_BASIS_RANK = { none: 0, tokens: 1, free: 2, reported: 3, estimated: 4, unpriced: 5 };
function weakerBasis(current, next) {
  if (!next) return current || 'none';
  return (COST_BASIS_RANK[next] ?? 0) > (COST_BASIS_RANK[current] ?? 0) ? next : (current || 'none');
}
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return ['input_tokens', 'output_tokens', 'reasoning_tokens'].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
}
/** The keys of a Codex thread's running usage total that are differenced (its total_tokens is input + output). */
const CODEX_TOTAL_KEYS = CODEX_USAGE_KEYS.filter((key) => key !== 'total_tokens');
/** OpenCode message tokens ({ input, output, reasoning, cache: { read, write } }) → usage keys. */
function openCodeUsage(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  return {
    input_tokens: Number(tokens.input) || 0, output_tokens: Number(tokens.output) || 0, reasoning_tokens: Number(tokens.reasoning) || 0,
    cache_read_input_tokens: Number(tokens.cache?.read) || 0, cache_write_input_tokens: Number(tokens.cache?.write) || 0,
  };
}
/** A message that is one JSON object (bare, or inside a single code fence), else null. */
function parseJsonObject(text) {
  const raw = String(text || '').trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw);
  let value = null;
  try { value = JSON.parse(fence ? fence[1] : raw); } catch { return null; }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * @param {object} deps  see plan §1.4; everything is injected so the module is unit-testable.
 */
export function createAssistantDispatcher({
  getRuntime,
  dataDir,
  loopDir = null,
  broadcastSync = () => {},
  log = () => {},
  PACKAGE_ROOT = process.cwd(),
  findCodexAccount = () => null,
  getCodexAccount = () => null,
  CODEX_DEFAULT_HOME = null,
  claudeAccounts = null,
  isValidMcpProfileValue = () => true,
  normalizeMcpProfileName = (value) => value,
  readActiveMcpProfile = () => 'full',
  acquireLoopBrowserAndTab = null,
  releaseSharedBrowserTab = async () => {},
  reconcileKeepAwake = () => {},
  memory = null,
  detectProject = () => 'global',
  limits: limitOverrides = {},
  now = Date.now,
  randomId = () => randomBytes(16).toString('hex'),
  strictResult = true,
  // Routing (assistant-router.js) and the model catalog (assistant-catalog.js);
  // both optional so the dispatcher still works (and tests) without them.
  router = null,
  catalog = null,
  // Computer use (lib/desktop/service.js): { isSupported(), isReady(), setupState(),
  // sessionAllows(sessionId), mintGrant(meta), revokeFor({runId}), releaseOwner({runId}) }.
  desktop = null,
  // Jev (assistant-jev.js): { workerOutcome(input, ask, ctx), annotate(logId, outcome) }.
  // null keeps the pre-Jev behaviour: a result-retry turn, and every failure offers escalation.
  judge = null,
  // Clarification (assistant-clarify.js): { forDispatch(sessionId, { briefId, independent }) }.
  // A brain's dispatch waits while its questions are open and carries the user's brief.
  clarifier = null,
  // Budget: live limit overrides (assistant-config.json, re-read on every
  // check), the brain's own spend per assistant session (the runtime) and list
  // prices for Codex usage (assistant-budget.js createModelPricing).
  readLimits = null,
  brainSpend = () => 0,
  pricing = null,
  // Exact token accounting (assistant-usage.js): the ledger (createUsageLedger) and the task of
  // the brain turn in progress, (assistantSessionId) => taskId | null. Both optional: without
  // them the meters still run for cost and the run's own numbers, and nothing is written.
  usage: ledger = null,
  currentTask = null,
  // Remote sessions (lib/remote-policy.js): the session's policy, or null, and
  // the registered project paths a remote session's workers must run in.
  sessionPolicy = getSessionPolicy,
  registeredProjects = () => readRegisteredProjects(),
  // The project's Style Guide for a run's prompt (lib/style-guide/store.js): (cwd, taskClass) =>
  // { summary, designPath, tokenFiles, proposals } | null. Reads <dataDir>/style-guides.
  loadStyleGuide = (cwd, taskClass) => loadStyleGuideForRun(cwd, taskClass, { dataDir }),
} = {}) {
  if (typeof getRuntime !== 'function') throw new Error('createAssistantDispatcher requires getRuntime()');
  if (!dataDir) throw new Error('createAssistantDispatcher requires dataDir');
  const limits = mergeLimits(limitOverrides);
  /**
   * Re-read the live limits (the Budget tab writes assistant-config.json): a
   * change applies to the next dispatch, follow-up, turn end and metered step
   * without a restart. `limits` stays the same object (dispatcher.limits).
   */
  function refreshLimits() {
    if (typeof readLimits !== 'function') return limits;
    let fresh = null;
    try { fresh = readLimits(); } catch { fresh = null; }
    if (!fresh || typeof fresh !== 'object') return limits;
    const next = mergeLimits({ ...limitOverrides, ...fresh });
    for (const key of Object.keys(next)) limits[key] = next[key];
    return limits;
  }
  const registryPath = resolve(dataDir, 'assistant-dispatches.json');
  // What image / video creation runs generated, and design runs' screenshots: <dataDir>/media/<runId>/<n>-<name>.
  const mediaRoot = resolve(dataDir, 'media');
  /** A known task class, else null. */
  const knownClass = (value) => (Object.prototype.hasOwnProperty.call(TASK_CLASS_META, String(value || '')) ? String(value) : null);
  const entries = new Map();          // runId → entry (persisted shape)
  const live = new Map();             // runId → live state (in-memory only)
  const listeners = new Set();
  const queue = [];                   // runIds in FIFO order (state 'queued')
  const idempotency = new Map();      // `${sessionId}:${key}` → { runId, at }
  const sessionBudgetWarned = new Map();   // assistantSessionId → the warning threshold it fired at
  const sessionBudgetExceeded = new Map(); // assistantSessionId → the hard cap it was stopped at
  // Usage meters (assistant-usage.js), apart from the live state: a Claude result can arrive
  // after its turn was aborted or its run left the list.
  const meters = new Map();           // runId → { claude, codex, opencode }
  let persistTimer = null;
  let stalledTimer = null;
  let unsubscribeRuntime = null;

  // ── persistence ────────────────────────────────────────────────────────────
  function loadRegistry() {
    const rows = readJson(registryPath, []);
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row?.runId) continue;
      const entry = { ...row };
      // A failure cause being judged when the server went down is never coming.
      delete entry.judging;
      if (ACTIVE_STATES.has(entry.state)) {
        entry.state = 'interrupted';
        entry.completionReason = entry.completionReason || 'server_restart';
        entry.finishedAt = entry.finishedAt || iso(now());
        entry.pending = [];
        entry.turnState = 'terminal';
        closeUsageState(entry);
      }
      entries.set(entry.runId, entry);
    }
  }
  function persist({ force = false } = {}) {
    const write = () => {
      const rows = [...entries.values()]
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const active = rows.filter((row) => ACTIVE_STATES.has(row.state));
      const terminal = rows.filter((row) => !ACTIVE_STATES.has(row.state));
      const retained = [...active, ...terminal.slice(0, Math.max(0, limits.retention - active.length))];
      const retainedIds = new Set(retained.map((row) => row.runId));
      for (const row of terminal) if (!retainedIds.has(row.runId)) { entries.delete(row.runId); live.delete(row.runId); meters.delete(row.runId); }
      try { writeJsonAtomic(registryPath, retained); } catch (error) { log(null, 'assistant:registry-error', error?.message || String(error)); }
    };
    if (force) { if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; } write(); return; }
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; write(); }, 200);
    persistTimer.unref?.();
  }

  // ── views + events ─────────────────────────────────────────────────────────
  /** The task of a live run's turn in progress (or the last one it started); null for a run that ended or has not started one. */
  function turnTaskOf(entry) {
    return (ACTIVE_STATES.has(entry.state) ? live.get(entry.runId)?.usageTurn?.taskId : null) || null;
  }
  /**
   * What a usage packet needs about one run, straight from the registry entry. The gauge asks
   * several times a second, for every run of the task: no full view, no ledger read and no memory
   * lookup (get() does all three).
   */
  function peek(runId) {
    const entry = entries.get(String(runId || '')) || null;
    if (!entry) return null;
    return {
      runId: entry.runId, title: entry.title || null, state: entry.state, turnState: entry.turnState || null,
      taskId: entry.taskId || null, turnTaskId: turnTaskOf(entry), provider: entry.provider || null, model: entry.model || null,
    };
  }
  function view(entry) {
    if (!entry) return null;
    const runtimeRun = safeRuntime()?.get?.(entry.runId) || null;
    const startedAt = entry.startedAt || entry.createdAt;
    const end = entry.finishedAt ? new Date(entry.finishedAt).getTime() : now();
    const elapsedMs = startedAt ? Math.max(0, end - new Date(startedAt).getTime()) : 0;
    // The brief goes to the worker's prompt; views name it only. The meters' state stays inside.
    const { rawSpec: _rawSpec, brief: _brief, usageState: _usageState, ...rest } = entry;
    return {
      ...rest,
      briefId: entry.brief?.briefId || null,
      taskId: entry.taskId || null,
      // The task of the turn in progress (or the last one started): a follow-up may work for a
      // later task than the run's own. null once the run has ended.
      turnTaskId: turnTaskOf(entry),
      tokens: tokensView(entry),
      status: runStatusFromState(entry.state),
      completedAt: entry.finishedAt || null,
      removed: !!entry.removedAt,
      route: entry.route || null,
      escalation: entry.escalation || null,
      modelInfo: entry.modelInfo || null,
      usesComputer: !!entry.usesComputer,
      awaitingRoute: entry.state === 'awaiting_route',
      dispatchId: entry.runId,
      active: ACTIVE_STATES.has(entry.state),
      terminal: TERMINAL_STATES.has(entry.state),
      outcome: entry.lastResult?.status || null,
      elapsedMs,
      turnCount: Array.isArray(entry.turns) ? entry.turns.length : 0,
      // The turn whose result this view carries: what a brain has read once it sees it.
      resultTurn: (Array.isArray(entry.turns) ? entry.turns.at(-1)?.n : null) ?? 0,
      pending: Array.isArray(entry.pending) ? entry.pending : [],
      runtime: runtimeRun ? {
        status: runtimeRun.status, turnState: runtimeRun.turnState, stoppedReason: runtimeRun.stoppedReason,
        error: runtimeRun.error, claimedBy: runtimeRun.claimedBy, providerSessionId: runtimeRun.providerSessionId,
        providerThreadId: runtimeRun.providerThreadId,
      } : (entry.runtime || null),
      providerSessionId: runtimeRun?.providerSessionId || entry.providerSessionId || null,
      providerThreadId: runtimeRun?.providerThreadId || entry.providerThreadId || null,
    };
  }
  function safeRuntime() { try { return getRuntime(); } catch { return null; } }
  function touch(entry) { entry.version = (Number(entry.version) || 0) + 1; entry.updatedAt = iso(now()); }
  function emit(entry, reason, extra = {}) {
    touch(entry);
    persist({ force: TERMINAL_STATES.has(entry.state) });
    const payload = { type: 'assistant:dispatch', reason, run: view(entry), ...extra };
    try { broadcastSync(payload); } catch {}
    for (const listener of listeners) { try { listener(payload); } catch {} }
    notifyWaiters(entry.runId, reason);
  }

  // ── delivery (what the owning brain already read) ──────────────────────────
  /**
   * High-water mark of the run results a brain has read (agent_wait,
   * agent_read, agent_status). The runtime drops `result` / `needs_input`
   * mailbox items at or below it, so a result the brain waited for does not
   * come back as a second turn. Persisted WITHOUT a version bump or an event:
   * a bump would wake `until:'event'` waits. A read by another session is
   * refused; a terminal state read while its cause is still being judged is
   * not recorded (the 'failed' event with the cause is still to come).
   */
  function markDelivered(runId, { turn = 0, state = null, via = null, assistantSessionId = null } = {}) {
    const entry = entries.get(runId);
    if (!entry) return false;
    if (assistantSessionId && entry.assistantSessionId && String(assistantSessionId) !== String(entry.assistantSessionId)) return false;
    const prev = entry.delivered && typeof entry.delivered === 'object' ? entry.delivered : null;
    const n = Math.max(0, Math.floor(Number(turn) || 0));
    const nextTurn = Math.max(Number(prev?.turn) || 0, n);
    let nextState = prev?.state || null;
    if (state && !(TERMINAL_STATES.has(state) && entry.judging)) nextState = String(state);
    if (prev && nextTurn === (Number(prev.turn) || 0) && nextState === (prev.state || null)) return true;
    entry.delivered = { turn: nextTurn, state: nextState, via: via ? String(via) : (prev?.via || null), at: iso(now()) };
    persist();
    return true;
  }
  function deliveryState(runId) {
    const mark = entries.get(runId)?.delivered;
    return mark && typeof mark === 'object' ? { ...mark } : null;
  }

  // ── waiters ────────────────────────────────────────────────────────────────
  const waiters = new Set(); // { check(): boolean, resolve() }
  function notifyWaiters() {
    for (const waiter of [...waiters]) {
      try { if (waiter.check()) { waiters.delete(waiter); waiter.resolve(); } } catch {}
    }
  }
  function satisfies(entry, until, sinceVersion) {
    if (!entry) return true;
    // A failed run whose cause is still being judged is not final yet: its
    // 'failed' event (with the cause and the matching escalation) follows
    // within the surface timeout.
    const terminal = TERMINAL_STATES.has(entry.state) && !entry.judging;
    if (until === 'terminal') return terminal;
    if (until === 'event') return terminal || entry.state === 'awaiting_permission' || entry.state === 'awaiting_route' || (Number(entry.version) || 0) !== sinceVersion;
    // 'idle' (default): the run is not busy — idle, awaiting a decision (a
    // permission or the user's model choice), or finished.
    return entry.state === 'idle' || entry.state === 'awaiting_permission' || entry.state === 'awaiting_route' || terminal;
  }

  // ── validation ─────────────────────────────────────────────────────────────
  function suggestModels(catalogValue, provider, model) {
    const rows = catalogValue?.models?.[provider] || [];
    const needle = String(model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const score = (row) => { const id = String(row.id).toLowerCase().replace(/[^a-z0-9]/g, ''); let s = 0; for (const ch of new Set(needle)) if (id.includes(ch)) s += 1; return s; };
    return [...rows].sort((a, b) => score(b) - score(a)).slice(0, 5).map((row) => row.id);
  }

  /** `taskClass`: the run's class (its route's, else the spec's); image / video creation needs a model that makes the medium. */
  function normalizeSpec(spec = {}, { catalogValue = null, codexAskFallback = false, taskClass = null } = {}) {
    const provider = String(spec.provider || '').trim().toLowerCase();
    if (!NATIVE_PROVIDERS.has(provider)) throw new DispatchError('INVALID_PROVIDER', `provider must be one of ${[...NATIVE_PROVIDERS].join(', ')}`);
    const task = String(spec.task || '').trim();
    if (!task) throw new DispatchError('TASK_REQUIRED', 'task is required');
    if (task.length > 20_000) throw new DispatchError('TASK_TOO_LONG', 'task must be at most 20000 characters');
    const cwd = String(spec.cwd || spec.project || PACKAGE_ROOT).trim();
    if (!cwd || !isDirectory(cwd)) throw new DispatchError('CWD_INVALID', `cwd is not a directory: ${cwd}`);
    let permissionPolicy = normalizePermissionPolicy(spec.permissionPolicy);
    const capability = normalizeCapability(spec.capability || 'full');
    const notes = [];
    if (provider === 'codex' && permissionPolicy === 'ask') {
      // A route card may move an 'ask' dispatch onto Codex: degrade instead of failing.
      if (!codexAskFallback) throw new DispatchError('PERMISSION_POLICY_UNSUPPORTED', 'Codex dispatches cannot use permissionPolicy "ask" (the Codex SDK has no approval channel). Use "restricted" for a workspace-write sandbox or "auto".', { suggested: 'restricted' });
      permissionPolicy = 'restricted';
      notes.push('permission policy "ask" became "restricted" (Codex has no approval channel)');
    }
    // "auto" (or nothing) = let routing pick / use the provider default.
    let model = spec.model && String(spec.model).trim() && String(spec.model).trim().toLowerCase() !== 'auto' ? String(spec.model).trim() : null;
    let modelInfo = null;
    let modelContextWindow = null;
    // Models the user hid (Assistant → Models; Settings → OpenCode) never run.
    if (catalogValue && providerAllHidden(catalogValue, provider)) {
      throw new DispatchError('MODEL_DISABLED', `Every ${provider} model is disabled in the Assistant's Models list. Pick another provider from agent_catalog, or ask the user to enable one (⋯ → Models…).`, { status: 400 });
    }
    // The provider answered and has no model connected (OpenCode's empty `connected` list): nothing can run there.
    if (catalogValue && providerEmpty(catalogValue, provider)) {
      throw new DispatchError('PROVIDER_NOT_CONNECTED', `No ${provider} model is connected. Pick another provider from agent_catalog, or ask the user to connect one.`, { status: 400 });
    }
    if (!model && catalogValue && defaultIsHidden(catalogValue, provider)) {
      // No model = the provider default, which the user hid: pin the first visible model.
      const pinned = defaultModelRow(catalogValue, provider);
      if (pinned) {
        model = pinned.id;
        notes.push(`the ${provider} default model is disabled; using ${pinned.id}`);
      }
    }
    if (model && catalogValue) {
      const hit = findModel(catalogValue, provider, model);
      const disabled = hit === null ? hiddenModelId(catalogValue, provider, model) : null;
      if (disabled) {
        throw new DispatchError('MODEL_DISABLED', `${provider} model "${disabled}" is disabled in the Assistant's Models list. Pick an enabled model from agent_catalog (provider "${provider}"), or ask the user to enable it there (⋯ → Models…).`, { status: 400, suggestions: suggestModels(catalogValue, provider, model) });
      }
      if (hit === null) {
        throw new DispatchError('MODEL_UNKNOWN', `Unknown ${provider} model "${model}". Pick one from agent_catalog (provider "${provider}"), or omit model for the provider default.`, { status: 400, suggestions: suggestModels(catalogValue, provider, model) });
      }
      const row = hit.row;
      modelInfo = { tier: row?.tier || null, vision: row ? row.vision ?? null : (hit.match === 'unlisted' ? true : null), price: row?.price || null, validated: hit.match === 'exact' || hit.match === 'resolved' ? 'catalog' : hit.match };
      // Codex "<id>[extended]": the worker runs <id> with model_context_window at this size.
      if (provider === 'codex' && contextVariantOf(row?.id) === 'extended') modelContextWindow = row.contextWindow || null;
    }
    // The model a run's usage is priced as: the provider default's row when none is named.
    let pricingModel = model;
    if (!model && catalogValue) {
      const row = defaultModelRow(catalogValue, provider);
      if (row) {
        pricingModel = row.id;
        if (!modelInfo) modelInfo = { tier: row.tier || null, vision: row.vision ?? null, price: row.price || null, validated: 'default' };
      }
    }
    // The effort is checked against the model the run gets (effort-levels.js);
    // an unsupported level becomes the nearest one it runs, recorded on the run.
    const checked = normalizeEffort({ provider, model, effort: spec.effort, catalog: catalogValue });
    const effortCorrection = checked.corrected || null;
    if (effortCorrection) notes.push(`effort "${effortCorrection.from}" is not supported by ${model || `the ${provider} default model`}; using ${effortCorrection.to ? `"${effortCorrection.to}"` : 'the model default'}`);
    // The run's own browser settings must agree on the provider it gets, whatever its class.
    const conflict = browserSettingsConflict(spec, provider);
    if (conflict) throw new DispatchError('BROWSER_SETTINGS_CONFLICT', conflict, { status: 400 });
    const usesBrowser = !!spec.usesBrowser || turnsBrowserOn(spec.mcpProfile);
    const usesComputer = spec.usesComputer === true || spec.usesComputer === 'true';
    const tags = Array.isArray(spec.tags) ? spec.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 10) : [];
    if ((usesBrowser || usesComputer) && capability === 'full' && !tags.includes('user-authorized-full')) {
      throw new DispatchError('QUARANTINE_VIOLATION', `${usesComputer ? 'Computer-use' : 'Browser-reading'} runs must use capability "read-only" or "workspace" unless tagged "user-authorized-full" by explicit user request.`);
    }
    if (usesComputer) {
      if (!desktop || !desktop.isSupported?.()) throw new DispatchError('COMPUTER_UNAVAILABLE', 'Computer use is not available on this machine (macOS only).', { status: 409 });
      if (!desktop.isReady?.()) throw new DispatchError('COMPUTER_UNAVAILABLE', `Computer use is not set up yet (${desktop.setupState?.() || 'setup required'}). Ask the user to finish the one-time setup in the assistant panel.`, { status: 409 });
      if (modelInfo && modelInfo.vision === false) throw new DispatchError('COMPUTER_NEEDS_VISION', `Model "${model}" cannot see images; computer use needs a vision-capable model.`, { status: 400, suggestions: (catalogValue?.models?.[provider] || []).filter((row) => row.vision).slice(0, 5).map((row) => row.id) });
    }
    // Image / video creation (the router already routed it to a maker; this is the backstop).
    const medium = requiredOutput(taskClass);
    if (medium && catalogValue) {
      const row = model ? findModel(catalogValue, provider, model)?.row || null : defaultModelRow(catalogValue, provider);
      if (!rowMakes(row, medium)) {
        const words = medium === 'video' ? 'videos' : 'images';
        throw new DispatchError('MODEL_CANNOT_GENERATE', `${model ? `Model "${model}"` : `The ${provider} default model`} cannot generate ${words}; ${TASK_CLASS_META[taskClass].label} needs a model that does (agent_catalog marks them ${medium}-out).`, { status: 400, suggestions: (catalogValue.models?.[provider] || []).filter((r) => rowMakes(r, medium)).slice(0, 5).map((r) => r.id) });
      }
    }
    // Design (the router already routed it to a model that can see; this is the backstop for every way a
    // target is chosen: routes, held picks, UI dispatches, escalations).
    const sightRefusal = designRefusal(catalogValue, provider, model, taskClass);
    if (sightRefusal) throw sightRefusal;
    const agent = provider === 'opencode' && spec.agent ? String(spec.agent).trim().slice(0, 60) || null : null;
    let mcpProfile = null;
    if (provider === 'claude-code') mcpProfile = 'full';
    else {
      // A browser run needs the browser tools: the active profile (core by default) has none.
      mcpProfile = normalizeMcpProfileName(spec.mcpProfile || (usesBrowser ? BROWSER_PROFILE : readActiveMcpProfile()));
      if (mcpProfile && !isValidMcpProfileValue(mcpProfile)) throw new DispatchError('MCP_PROFILE_INVALID', `Invalid MCP profile: ${mcpProfile}`);
    }
    let codexAccount = null;
    let claudeAccount = null;
    const accountId = spec.accountId || spec.codexAccountId || spec.claudeAccountId || null;
    if (provider === 'codex') {
      codexAccount = accountId ? findCodexAccount(accountId) : getCodexAccount(null);
      if (!codexAccount) throw new DispatchError('ACCOUNT_NOT_FOUND', `Codex account not found: ${accountId || 'default'}`);
    }
    if (provider === 'claude-code' && accountId && accountId !== 'default') {
      claudeAccount = claudeAccounts?.find?.(accountId) || null;
      if (!claudeAccount) throw new DispatchError('ACCOUNT_NOT_FOUND', `Claude account not found: ${accountId}`);
    }
    const maxMinutes = Math.min(Math.max(Number(spec.maxMinutes) || limits.defaultMaxMinutes, 1), limits.maxMaxMinutes);
    const budgetUsd = Math.min(Math.max(Number(spec.budgetUsd) || limits.defaultBudgetUsd, 0.1), limits.maxBudgetUsd);
    const idleTimeoutMs = Math.min(Math.max(Number(spec.idleTimeoutMs) || limits.idleTimeoutMs, limits.minIdleTimeoutMs), limits.maxIdleTimeoutMs);
    const maxTurns = Math.min(Math.max(Number(spec.maxTurns) || limits.maxTurns, 1), limits.maxMaxTurns);
    const outputSchema = spec.outputSchema && typeof spec.outputSchema === 'object' ? spec.outputSchema : null;
    const title = clip(spec.title || task.split('\n')[0], 80);
    return {
      provider, task, context: String(spec.context || '').trim() || null, cwd,
      project: detectProject(cwd) || 'global',
      model, modelContextWindow, pricingModel,
      effort: checked.effort || null, effortCorrection,
      agent, modelInfo, notes,
      mcpProfile, permissionPolicy, capability, usesBrowser, usesComputer,
      codexAccountId: codexAccount?.id || null,
      codexHome: codexAccount ? (codexAccount.home || CODEX_DEFAULT_HOME) : null,
      claudeAccountId: claudeAccount?.id || (provider === 'claude-code' ? 'default' : null),
      claudeConfigDir: claudeAccount ? (claudeAccounts?.homeFor?.(claudeAccount.id) || null) : null,
      accountId: provider === 'codex' ? (codexAccount?.id || 'default') : provider === 'claude-code' ? (claudeAccount?.id || 'default') : null,
      maxMinutes, budgetUsd, idleTimeoutMs, maxTurns, outputSchema, title, tags,
      focus: spec.focus === true,
      workflowId: spec.workflowId ? String(spec.workflowId) : null,
      parentRunId: spec.parentRunId ? String(spec.parentRunId) : null,
      idempotencyKey: spec.idempotencyKey || spec.idempotency_key ? String(spec.idempotencyKey || spec.idempotency_key).slice(0, 200) : null,
      queueIfBusy: spec.queueIfBusy !== false,
      requestedBrowserSessionId: spec.browserSessionId || null,
    };
  }

  // ── rails ──────────────────────────────────────────────────────────────────
  function activeEntries(filter = () => true) {
    return [...entries.values()].filter((entry) => ACTIVE_STATES.has(entry.state) && !WAITING_STATES.has(entry.state) && filter(entry));
  }
  function railBlock(spec, assistantSessionId) {
    // One desktop, one controller: computer-use runs never overlap.
    if (spec.usesComputer && activeEntries((e) => e.usesComputer).length >= 1) return 'another computer-use run is active (one at a time)';
    const perProvider = limits.perProvider[spec.provider] ?? 3;
    if (activeEntries((e) => e.provider === spec.provider).length >= perProvider) return `provider ${spec.provider} at its concurrency limit (${perProvider})`;
    if (spec.provider === 'codex' && activeEntries((e) => e.provider === 'codex' && e.accountId === spec.accountId).length >= limits.perCodexAccount) {
      return `Codex account ${spec.accountId} at its concurrency limit (${limits.perCodexAccount})`;
    }
    if (assistantSessionId && activeEntries((e) => e.assistantSessionId === assistantSessionId).length >= limits.perSession) {
      return `assistant session at its concurrency limit (${limits.perSession})`;
    }
    if (spec.workflowId && activeEntries((e) => e.workflowId === spec.workflowId).length >= limits.maxFanOut) {
      return `workflow ${spec.workflowId} at its fan-out limit (${limits.maxFanOut})`;
    }
    return null;
  }
  /** What the session's runs spent (removed runs included: the money was spent). */
  function sessionSpend(assistantSessionId) {
    if (!assistantSessionId) return 0;
    let total = 0;
    for (const entry of entries.values()) if (entry.assistantSessionId === assistantSessionId) total += Number(entry.costUsd) || 0;
    return total;
  }
  function sessionBrainSpend(assistantSessionId) {
    if (!assistantSessionId) return 0;
    try { return Math.max(0, Number(brainSpend(assistantSessionId)) || 0); } catch { return 0; }
  }
  /** The session's whole spend: the central brain plus every run. The hard cap is checked against this. */
  function sessionTotal(assistantSessionId) { return sessionSpend(assistantSessionId) + sessionBrainSpend(assistantSessionId); }
  function runRemaining(entry) { return Math.max(0, (Number(entry.budgetUsd) || 0) - (Number(entry.costUsd) || 0)); }
  /**
   * What the session's started runs may still spend: each live run's cap minus
   * its spend. A new run only gets what the hard cap leaves after this, so the
   * runs together cannot pass the cap (up to one provider step; see docs).
   */
  function sessionReserved(assistantSessionId, { except = null } = {}) {
    if (!assistantSessionId) return 0;
    let total = 0;
    for (const entry of entries.values()) {
      if (entry.assistantSessionId !== assistantSessionId || entry.runId === except) continue;
      if (!ACTIVE_STATES.has(entry.state) || WAITING_STATES.has(entry.state)) continue;
      total += runRemaining(entry);
    }
    return total;
  }
  /** The session's money view (Budget tab, cost chip, agent_list totals). */
  function sessionBudget(assistantSessionId) {
    refreshLimits();
    const dispatchUsd = sessionSpend(assistantSessionId);
    const brainUsd = sessionBrainSpend(assistantSessionId);
    const totalUsd = dispatchUsd + brainUsd;
    const reservedUsd = sessionReserved(assistantSessionId);
    let unpricedRuns = 0;
    for (const entry of entries.values()) if (entry.assistantSessionId === assistantSessionId && Number(entry.unpricedTurns) > 0) unpricedRuns += 1;
    return {
      brainUsd: r4(brainUsd), dispatchUsd: r4(dispatchUsd), totalUsd: r4(totalUsd), reservedUsd: r4(reservedUsd),
      availableUsd: r4(Math.max(0, limits.sessionHardBudgetUsd - totalUsd - reservedUsd)),
      warnUsd: limits.sessionWarnUsd, hardUsd: limits.sessionHardBudgetUsd,
      defaultRunUsd: limits.defaultBudgetUsd, maxRunUsd: limits.maxBudgetUsd, brainCapUsd: limits.brainBudgetUsd,
      warned: totalUsd >= limits.sessionWarnUsd, exceeded: totalUsd >= limits.sessionHardBudgetUsd, unpricedRuns,
    };
  }
  /**
   * Why a run's spend could not be held to the dollar caps (no price for its
   * model), else null. Enforced only with a price source (`pricing`): Claude
   * reports cost, Codex needs a list price, OpenCode a catalog price (a free
   * model is fine).
   */
  function unpricedReason(entry) {
    if (!pricing || entry.provider === 'claude-code') return null;
    const model = entry.pricingModel || entry.model || null;
    if (entry.provider === 'codex') {
      let price = null;
      try { price = model ? pricing.codexPrice?.(model) || null : null; } catch { price = null; }
      return price ? null : `no list price is known for Codex model ${model || '(the default model)'}`;
    }
    return entry.modelInfo?.price ? null : `no price is known for OpenCode model ${model || '(the default model)'}`;
  }
  function refuseUnpriced(entry) {
    const why = unpricedReason(entry);
    if (!why) return;
    throw new DispatchError('BUDGET_UNPRICED', `Not dispatched: ${why}, so the budget caps could not hold its spend. Pick a priced model or a free one (agent_catalog shows prices).`, { status: 409, provider: entry.provider, model: entry.pricingModel || entry.model || null });
  }
  /** Why this run may not spend more (unpriced usage, its own cap, or the session's hard cap), else null. */
  function budgetBlock(entry) {
    if (pricing && Number(entry.unpricedTurns) > 0) {
      return { code: 'BUDGET_UNPRICED', reason: 'budget_unpriced', message: `its usage could not be priced (${entry.unpricedReason || 'no price'}), so the budget caps cannot hold it`, detail: { unpricedTurns: entry.unpricedTurns } };
    }
    const cap = Number(entry.budgetUsd) || 0;
    const cost = Number(entry.costUsd) || 0;
    if (cap > 0 && cost >= cap) {
      return { code: 'RUN_BUDGET_EXCEEDED', reason: 'budget_cap', message: `run spent ${usd(cost)} of its ${usd(cap)} cap`, detail: { runSpent: r4(cost), runCap: cap } };
    }
    const sessionId = entry.assistantSessionId;
    if (sessionId) {
      const total = sessionTotal(sessionId);
      if (total >= limits.sessionHardBudgetUsd) {
        return { code: 'BUDGET_EXCEEDED', reason: 'session_budget_cap', message: `assistant session spent ${usd(total)} (brain + agents), at or above its hard cap of ${usd(limits.sessionHardBudgetUsd)}`, detail: { sessionSpent: r4(total), sessionCap: limits.sessionHardBudgetUsd } };
      }
    }
    return null;
  }
  /**
   * Fit a run's cap into what the session has left (hard cap − spend − the
   * live runs' reservations). Throws BUDGET_EXCEEDED when not a cent is left.
   */
  function fitBudget(entry) {
    const sessionId = entry.assistantSessionId;
    if (!sessionId) return;
    const spent = sessionTotal(sessionId);
    const reserved = sessionReserved(sessionId, { except: entry.runId });
    const hard = limits.sessionHardBudgetUsd;
    // Whole cents: a run never gets a fraction of a cent the session does not have.
    const available = Math.floor((hard - spent - reserved) * 100 + 1e-6) / 100;
    if (available <= 0) {
      throw new DispatchError('BUDGET_EXCEEDED', `No session budget left for another run: ${usd(spent)} spent (brain + agents) and ${usd(reserved)} reserved by live runs, against the hard cap of ${usd(hard)}. Complete finished runs (agent_complete) to release their reservation, or ask the user to raise the cap (Assistant → Budget).`, { status: 409, sessionSpent: r4(spent), sessionReserved: r4(reserved), sessionCap: hard });
    }
    if ((Number(entry.budgetUsd) || 0) > available) {
      const from = Number(entry.budgetUsd);
      entry.budgetUsd = available;
      entry.budgetClamped = { from, to: entry.budgetUsd, at: iso(now()) };
      entry.notes.push(`budget lowered from ${usd(from)} to ${usd(entry.budgetUsd)}: the session hard cap ${usd(hard)} minus ${usd(spent)} spent and ${usd(reserved)} reserved by live runs`);
    }
  }
  /**
   * After money moved in a session: one warning at the warning threshold, and
   * at the hard cap every live, queued and held run of the session stops.
   * Returns the session's budget view.
   */
  function checkSession(assistantSessionId, { source = null } = {}) {
    if (!assistantSessionId) return null;
    const money = sessionBudget(assistantSessionId);
    const anchor = source || [...entries.values()].filter((e) => e.assistantSessionId === assistantSessionId)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
    if (money.warned && !money.exceeded && sessionBudgetWarned.get(assistantSessionId) !== money.warnUsd) {
      sessionBudgetWarned.set(assistantSessionId, money.warnUsd);
      if (anchor) {
        emit(anchor, 'budget_warning', {
          sessionSpent: money.totalUsd, warnAt: money.warnUsd, softCap: money.warnUsd, hardCap: money.hardUsd,
          text: `session budget warning: ${usd(money.totalUsd)} spent (brain ${usd(money.brainUsd)} + agents ${usd(money.dispatchUsd)}), warning at ${usd(money.warnUsd)}, hard cap ${usd(money.hardUsd)}. Ask the user before spending more.`,
        });
      }
    }
    if (money.exceeded) {
      const victims = [...entries.values()].filter((e) => e.assistantSessionId === assistantSessionId && ACTIVE_STATES.has(e.state));
      for (const victim of victims) {
        victim.completionReason = victim.completionReason || 'session_budget_cap';
        if (!(victim.notes || []).some((note) => note.startsWith('stopped: session hard cap'))) victim.notes.push(`stopped: session hard cap ${usd(money.hardUsd)} reached (${usd(money.totalUsd)} spent)`);
        stop(victim.runId, 'session_budget_cap').catch(() => {});
      }
      if (anchor && sessionBudgetExceeded.get(assistantSessionId) !== money.hardUsd) {
        sessionBudgetExceeded.set(assistantSessionId, money.hardUsd);
        emit(anchor, 'budget_exceeded', {
          sessionSpent: money.totalUsd, hardCap: money.hardUsd, stopped: victims.map((e) => e.runId),
          text: `session hard cap reached: ${usd(money.totalUsd)} spent of ${usd(money.hardUsd)}; ${victims.length} run${victims.length === 1 ? '' : 's'} stopped and new dispatches are refused until the user raises the cap (Assistant → Budget).`,
        });
      }
    }
    return money;
  }

  // ── dispatch ───────────────────────────────────────────────────────────────
  /** Entry fields that come straight from a normalized spec. */
  function specFields(spec) {
    return {
      provider: spec.provider, model: spec.model, effort: spec.effort, effortCorrection: spec.effortCorrection || null, agent: spec.agent || null, accountId: spec.accountId,
      codexAccountId: spec.codexAccountId, codexHome: spec.codexHome, claudeAccountId: spec.claudeAccountId, claudeConfigDir: spec.claudeConfigDir,
      cwd: spec.cwd, project: spec.project, mcpProfile: spec.mcpProfile,
      permissionPolicy: spec.permissionPolicy, capability: spec.capability, usesBrowser: spec.usesBrowser, usesComputer: !!spec.usesComputer,
      title: spec.title, task: spec.task, context: spec.context, tags: spec.tags,
      maxMinutes: spec.maxMinutes, budgetUsd: spec.budgetUsd, idleTimeoutMs: spec.idleTimeoutMs, maxTurns: spec.maxTurns,
      outputSchema: spec.outputSchema, focus: spec.focus, workflowId: spec.workflowId, parentRunId: spec.parentRunId,
      idempotencyKey: spec.idempotencyKey, requestedBrowserSessionId: spec.requestedBrowserSessionId,
      modelInfo: spec.modelInfo || null, modelContextWindow: spec.modelContextWindow || null, pricingModel: spec.pricingModel || spec.model || null,
    };
  }
  function baseEntry(runId, sessionId, origin) {
    return {
      runId, assistantSessionId: sessionId, origin,
      state: 'queued', turnState: null, turns: [], lastResult: null, costUsd: 0, usage: null, costBasis: 'none',
      pending: [], notes: [], createdAt: iso(now()), startedAt: null, finishedAt: null, completionReason: null,
      memoryId: null, memoryStored: false, browserSessionId: null, browserTabId: null, version: 0, updatedAt: iso(now()),
      runtime: null, providerSessionId: null, providerThreadId: null, degraded: null,
      route: null, escalation: null, escalationDepth: 0,
      taskId: null, // the task (one human prompt) this run was dispatched for: assistant-usage.js
    };
  }
  async function catalogSnapshot() {
    if (!catalog) return null;
    try { return await (catalog.full ? catalog.full() : catalog.get()); } catch { return catalog.peek?.() || null; }
  }

  /**
   * The user's brief for a brain's dispatch (assistant-clarify.js): null for a
   * clear request; CLARIFICATION_PENDING (409) while the questions it depends
   * on are open; BRIEF_UNKNOWN (400) for a brief_id this session does not have.
   */
  function briefFor(rawSpec, sessionId, origin) {
    if (!clarifier?.forDispatch || origin === 'ui' || !sessionId) return null;
    const independent = rawSpec.independent === true || rawSpec.independent === 'true';
    try {
      return clarifier.forDispatch(sessionId, { briefId: rawSpec.briefId ? String(rawSpec.briefId) : null, independent }) || null;
    } catch (error) {
      if (!error?.code) throw error;
      throw new DispatchError(error.code, error.message, { status: Number(error.status) || 409, ...(error.briefId ? { briefId: error.briefId } : {}) });
    }
  }

  /**
   * A remote session's dispatch, clamped to its level (every origin: the level
   * belongs to the session): REMOTE_READ_ONLY / REMOTE_CWD_NOT_ALLOWED (409),
   * or a copy without computer use and, below autonomous, within the rules of
   * clampDispatchSpec. What changed goes to `notes` (the run's notes).
   */
  function clampRemote(spec, sessionId, notes = []) {
    if (!sessionId || typeof sessionPolicy !== 'function') return spec;
    let policy = null;
    try { policy = sessionPolicy(String(sessionId)) || null; } catch { policy = { level: 'read-only', failClosed: true }; }
    if (!policy) return spec;
    let projects = [];
    try { projects = (typeof registeredProjects === 'function' ? registeredProjects() : registeredProjects) || []; } catch { projects = []; }
    try {
      return clampDispatchSpec(policy, spec, { registeredProjects: projects, defaultCwd: PACKAGE_ROOT, now: now(), notes });
    } catch (error) {
      if (error instanceof RemotePolicyError) throw new DispatchError(error.code, error.message, { status: error.status || 409 });
      throw error;
    }
  }

  /** BROWSER_SETTINGS_CONFLICT (400) for a spec whose browser settings cannot agree, whatever the provider. */
  function refuseBrowserConflict(spec) {
    const conflict = browserSettingsConflict(spec, null);
    if (conflict) throw new DispatchError('BROWSER_SETTINGS_CONFLICT', conflict, { status: 400 });
  }

  /**
   * `brief`: a brief carried over from an earlier run (escalation, retry); never from a request body.
   * `notes`: what the caller changed in the spec (a planning brain's read-only clamp), for the run's notes.
   */
  async function dispatch(rawSpec = {}, { assistantSessionId = null, origin = 'assistant', brief: carried = null, notes: callerNotes = null } = {}) {
    const sessionId = assistantSessionId ? String(assistantSessionId) : null;
    const idempotencyKey = rawSpec.idempotencyKey || rawSpec.idempotency_key ? String(rawSpec.idempotencyKey || rawSpec.idempotency_key).slice(0, 200) : null;
    if (idempotencyKey && sessionId) {
      const hit = idempotency.get(`${sessionId}:${idempotencyKey}`);
      if (hit && now() - hit.at < limits.idempotencyTtlMs && entries.has(hit.runId)) {
        const prior = entries.get(hit.runId);
        return { ok: true, replayed: true, queued: WAITING_STATES.has(prior.state), awaitingRoute: prior.state === 'awaiting_route', run: view(prior) };
      }
    }
    refreshLimits();
    const spent = sessionTotal(sessionId);
    if (sessionId && spent >= limits.sessionHardBudgetUsd) {
      throw new DispatchError('BUDGET_EXCEEDED', `Assistant session spent $${spent.toFixed(2)} (brain + agents), at or above the hard cap of $${limits.sessionHardBudgetUsd}. Ask the user to raise it (Assistant → Budget) before dispatching more.`, { status: 409, sessionSpent: r4(spent), sessionCap: limits.sessionHardBudgetUsd });
    }
    // "true" (a string) is computer use too: normalizeSpec reads it so, and so must the gate.
    rawSpec = { ...rawSpec, usesComputer: rawSpec.usesComputer === true || rawSpec.usesComputer === 'true' };
    // A design dispatch's defaults fill what it leaves out, before any clamp; any dispatch's own browser
    // settings must agree before a route card is shown (normalizeSpec re-checks the final target, provider included).
    rawSpec = withClassDefaults(rawSpec, knownClass(rawSpec.taskClass));
    refuseBrowserConflict(rawSpec);
    // A remote session (WhatsApp): its level decides what a worker may be (lib/remote-policy.js).
    // Before the computer gate: a remote run drops computer use with a note on the run, rather than
    // being refused with "turn the Computer toggle on", which the phone cannot do.
    const remoteNotes = Array.isArray(callerNotes) ? callerNotes.map(String).filter(Boolean) : [];
    rawSpec = clampRemote(rawSpec, sessionId, remoteNotes);
    if (rawSpec.usesComputer && desktop && sessionId && typeof desktop.sessionAllows === 'function' && !desktop.sessionAllows(sessionId)) {
      throw new DispatchError('COMPUTER_SESSION_OFF', 'Computer use is switched off for this assistant session. Ask the user to turn the Computer toggle on.', { status: 409 });
    }
    // Clarification first: work that depends on open questions waits for the
    // user's answers (no route card, no hold), and carries them once answered.
    const brief = carried && typeof carried === 'object' ? carried : briefFor(rawSpec, sessionId, origin);
    const catalogValue = await catalogSnapshot();
    // Routing (ask modes may hold the run until the user picks a model).
    let routed = null;
    if (router && origin !== 'ui' && sessionId) {
      routed = await router.resolveDispatch({ sessionId, spec: rawSpec, origin });
      // A hold names an open card, but an answer that was already in flight (it waited on the same
      // catalog read) can decide that card before this continuation runs. Approved for this
      // session: the dispatch is resolved again with that route_id, so the run starts on it as any
      // dispatch with an approved route does (its validation, the remote clamps and claim, the
      // rails). Declined, cancelled or expired: the attachment below fails and it is refused.
      for (let i = 0; i < 2 && routed?.action === 'hold' && routeApprovedFor(routed.routeId, sessionId); i += 1) {
        routed = { ...(await router.resolveDispatch({ sessionId, spec: { ...rawSpec, routeId: routed.routeId }, origin })), approvedMeanwhile: true };
      }
    }
    // A remote session's approved route, claimed by resolveDispatch, is used up only by the run it
    // starts: a dispatch refused before its run exists gives the route back, so retrying the route_id
    // gets the route again (it runs, or is refused for the same reason), never a fresh route of another class.
    let runId = null;
    try {
      // An approved route may have moved it to another provider: clamp for that one
      // (a route approved for design brings design's defaults).
      const input = routed?.spec ? clampRemote(withClassDefaults(routed.spec, knownClass(routed.route?.taskClass)), sessionId, remoteNotes) : rawSpec;
      // A route approved for other work cannot carry image / video creation or design, nor the other way round:
      // the class decides the model's capability check, the worker's media block or rules and what is collected.
      const declaredClass = knownClass(rawSpec.taskClass);
      const routeClass = knownClass(routed?.route?.taskClass);
      if (declaredClass && routeClass && runContract(declaredClass) !== runContract(routeClass)) {
        throw new DispatchError('ROUTE_CLASS_MISMATCH', `Route ${routed.route.routeId || ''} was approved for ${routeClass} work, but this dispatch says task_class "${declaredClass}". Call agent_route with task_class "${declaredClass}" and dispatch with its route_id.`, { status: 409, routeId: routed.route.routeId || null, routeClass, taskClass: declaredClass });
      }
      // The route's spec (a route_id alone can make it a design dispatch, with design's defaults):
      // its browser settings must agree too (the route already exists).
      if (routed?.spec) refuseBrowserConflict(input);
      if (routed?.action === 'hold') return holdForRoute(input, routed, { sessionId, origin, idempotencyKey, brief, remoteNotes });
      // The run's class: its route's (the brain may omit task_class with a route_id), else the spec's.
      // Its capability backstop runs in normalizeSpec on the final target, however that was chosen.
      const taskClass = routeClass || knownClass(input.taskClass);
      const spec = normalizeSpec(input, { catalogValue, taskClass });
      const queuedCount = [...entries.values()].filter((e) => e.state === 'queued' && e.assistantSessionId === sessionId).length;
      runId = randomId();
      const entry = { ...baseEntry(runId, sessionId, origin), ...specFields(spec), notes: [...(spec.notes || []), ...remoteNotes] };
      if (taskClass) entry.taskClass = taskClass;
      if (brief) { entry.brief = brief; entry.notes.push(`carries the user's brief ${brief.briefId || ''}`.trim()); }
      if (routed?.route) entry.route = routed.route;
      entries.set(runId, entry);
      try { refuseUnpriced(entry); fitBudget(entry); } catch (error) { entries.delete(runId); throw error; }
      entry.taskId = taskAtDispatch(sessionId);
      if (spec.idempotencyKey && sessionId) idempotency.set(`${sessionId}:${spec.idempotencyKey}`, { runId, at: now() });
      const launched = await launchOrQueue(entry, spec, { queuedCount, strict: true });
      // The route's own "decided" event (it had no run attached) still tells the brain to dispatch.
      return routed?.approvedMeanwhile
        ? { ...launched, next: 'The user picked this route while the dispatch was on its way, so this run started on it. Do not dispatch it again when the route_decided event for this route arrives.' }
        : launched;
    } catch (error) {
      // A run that exists (it failed or stopped at start) used the route; a refusal before one did not.
      if (routed?.claimed && !(runId && entries.has(runId))) router.releaseRoute?.(routed.route?.routeId);
      throw error;
    }
  }

  /** The router decided this route as approved, for this session (after a hold was returned on its card). */
  function routeApprovedFor(routeId, sessionId) {
    let decided = null;
    try { decided = router?.status?.(routeId) || null; } catch { decided = null; }
    return decided?.status === 'approved' && String(decided.sessionId || '') === String(sessionId || '');
  }

  async function launchOrQueue(entry, spec, { queuedCount = 0, strict = false } = {}) {
    const block = railBlock(spec, entry.assistantSessionId);
    if (block) {
      if (strict && !spec.queueIfBusy) {
        entries.delete(entry.runId);
        throw new DispatchError('MAX_CONCURRENT', block, { status: 409 });
      }
      if (strict && queuedCount >= limits.queuedPerSession) {
        entries.delete(entry.runId);
        throw new DispatchError('QUEUE_FULL', `assistant session already has ${queuedCount} queued dispatches`, { status: 409 });
      }
      entry.notes.push(`queued: ${block}`);
      entry.state = 'queued';
      queue.push(entry.runId);
      emit(entry, 'queued', { position: queue.length });
      return { ok: true, queued: true, position: queue.length, run: view(entry) };
    }
    await start(entry);
    return { ok: true, queued: false, run: view(entry) };
  }

  /** Accept a dispatch the router is holding for the user's model choice. */
  function holdForRoute(input, routed, { sessionId, origin, idempotencyKey, brief = null, remoteNotes = [] }) {
    const task = String(input.task || '').trim();
    if (!task) throw new DispatchError('TASK_REQUIRED', 'task is required');
    if (task.length > 20_000) throw new DispatchError('TASK_TOO_LONG', 'task must be at most 20000 characters');
    const cwd = String(input.cwd || input.project || PACKAGE_ROOT).trim();
    if (!cwd || !isDirectory(cwd)) throw new DispatchError('CWD_INVALID', `cwd is not a directory: ${cwd}`);
    const held = [...entries.values()].filter((e) => e.state === 'awaiting_route' && e.assistantSessionId === sessionId).length;
    if (held >= limits.heldPerSession) throw new DispatchError('HELD_FULL', `assistant session already has ${held} dispatches waiting for a model choice`, { status: 409 });
    const runId = randomId();
    const entry = {
      ...baseEntry(runId, sessionId, origin),
      state: 'awaiting_route',
      provider: NATIVE_PROVIDERS.has(String(input.provider || '')) ? String(input.provider) : null,
      model: input.model ? String(input.model) : null, effort: input.effort ? String(input.effort) : null,
      cwd, project: detectProject(cwd) || 'global', title: clip(input.title || task.split('\n')[0], 80), task,
      context: String(input.context || '').trim() || null,
      tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 10) : [],
      workflowId: input.workflowId ? String(input.workflowId) : null, parentRunId: input.parentRunId ? String(input.parentRunId) : null,
      usesBrowser: !!input.usesBrowser, usesComputer: input.usesComputer === true, capability: normalizeCapability(input.capability || 'full'),
      idempotencyKey, rawSpec: { ...input }, route: routed.route,
      notes: ['awaiting the user\'s model choice on the route card', ...remoteNotes],
    };
    const heldClass = knownClass(routed.route?.taskClass) || knownClass(input.taskClass);
    if (heldClass) entry.taskClass = heldClass;
    if (brief) entry.brief = brief;
    // A held run belongs to the task that asked for it, whenever the user picks its model.
    entry.taskId = taskAtDispatch(sessionId);
    // The run waits on its route card, so the card must still be open: one that closed meanwhile
    // (the user wrote something else, a Stop) would leave a run nothing ever starts or declines.
    // Attached before the run exists: a refusal leaves no entry and no idempotency key behind.
    if (typeof router?.holdRuns === 'function' && router.holdRuns(routed.routeId, [runId]) === false) {
      const closed = router.routeClosedError?.(routed.routeId);
      throw new DispatchError('ROUTE_CANCELLED', closed?.message || 'This route is no longer valid: its card closed before the run could wait on it. Nothing was started; ask the user how to proceed.', { status: 409, routeId: routed.routeId });
    }
    entries.set(runId, entry);
    if (idempotencyKey && sessionId) idempotency.set(`${sessionId}:${idempotencyKey}`, { runId, at: now() });
    emit(entry, 'route_pending', { routeId: routed.routeId });
    return {
      ok: true, queued: true, awaitingRoute: true, routeId: routed.routeId, run: view(entry),
      next: 'This run is waiting for the user to pick its model on the route card. Do not dispatch it again. It starts automatically after the pick; the decision arrives as a [SynaBun Mailbox] route_decided event.',
    };
  }

  /**
   * Why the held run `runId` could not start on `target`, else null: the router's checkHeld, asked
   * before it approves a route card's pick, so a pick resolveRoute would refuse is not approved,
   * saved or reported started. The refusals resolveRoute raises for design runs (sight on the
   * catalog as it stands: MODEL_CANNOT_SEE, MODEL_UNAVAILABLE) and, for every run, browser
   * settings on that provider (BROWSER_SETTINGS_CONFLICT). Other refusals still come in resolveRoute.
   */
  function heldRouteRefusal(runId, target) {
    const entry = entries.get(String(runId || ''));
    if (!entry || entry.state !== 'awaiting_route' || !target?.provider) return null;
    const provider = String(target.provider).trim().toLowerCase();
    const model = target.model && String(target.model).trim() ? String(target.model).trim() : null;
    let catalogValue = null;
    try { catalogValue = catalog?.peek?.() || null; } catch { catalogValue = null; }
    const refusal = designRefusal(catalogValue, provider, model, entry.taskClass || null);
    if (refusal) return refusal;
    const conflict = browserSettingsConflict({ ...(entry.rawSpec || {}), provider, model }, provider);
    return conflict ? new DispatchError('BROWSER_SETTINGS_CONFLICT', conflict, { status: 400 }) : null;
  }

  /** The user picked a target for a held run: validate, then start or queue it. */
  async function resolveRoute(runId, { target, routeId = null, decidedBy = 'user', remembered = false, optionId = null } = {}) {
    const entry = entries.get(runId);
    if (!entry || entry.state !== 'awaiting_route' || !target?.provider) return { ok: false, code: 'NOT_HELD' };
    const catalogValue = await catalogSnapshot();
    let input = { ...(entry.rawSpec || {}), provider: target.provider, model: target.model || null, effort: target.effort ?? entry.rawSpec?.effort ?? null };
    let spec;
    // The picked provider may need another clamp (Codex under strict worker approvals), or the level fell meanwhile.
    const remoteNotes = [];
    try { input = clampRemote(input, entry.assistantSessionId, remoteNotes); spec = normalizeSpec(input, { catalogValue, codexAskFallback: true, taskClass: entry.taskClass || null }); }
    catch (error) {
      entry.state = 'failed'; entry.completionReason = 'route_invalid'; entry.finishedAt = iso(now()); entry.turnState = 'terminal';
      entry.error = error?.message || String(error);
      entry.notes.push(`route target rejected: ${entry.error}`);
      delete entry.rawSpec;
      emit(entry, 'failed');
      return { ok: false, error };
    }
    Object.assign(entry, specFields(spec));
    entry.notes.push(...(spec.notes || []), ...remoteNotes.filter((note) => !entry.notes.includes(note)), `route decided by ${decidedBy}: ${spec.provider}/${spec.model || 'default'}`);
    entry.route = {
      ...(entry.route || {}), routeId: routeId || entry.route?.routeId || null, status: 'approved', decidedBy, remembered, optionId,
      target: describeTarget(target, { catalog: catalogValue }), decidedAt: iso(now()),
    };
    delete entry.rawSpec;
    entry.state = 'queued';
    emit(entry, 'route_decided', { routeId });
    try { return await launchOrQueue(entry, spec); }
    catch (error) { entry.notes.push(`start after route failed: ${error?.message || error}`); return { ok: false, error }; }
  }

  function declineRoute(runId, { reason = 'route_declined' } = {}) {
    const entry = entries.get(runId);
    if (!entry || entry.state !== 'awaiting_route') return false;
    entry.state = 'stopped'; entry.completionReason = reason; entry.finishedAt = iso(now()); entry.turnState = 'terminal'; entry.pending = [];
    entry.route = { ...(entry.route || {}), status: reason === 'route_expired' ? 'expired' : 'declined', decidedBy: reason === 'route_expired' ? 'timeout' : 'user', decidedAt: iso(now()) };
    delete entry.rawSpec;
    emit(entry, 'stopped');
    return true;
  }

  /** Re-dispatch a failed/blocked run one tier up, or on the same model after a transient failure (the user pressed Escalate / Retry). */
  async function escalate(runId, { target = null } = {}) {
    const entry = requireEntry(runId);
    const to = target?.provider ? target : entry.escalation?.to;
    if (!to?.provider) throw new DispatchError('NO_ESCALATION', `Run ${runId} has no escalation target`, { status: 409 });
    // A transient failure (timeout, rate limit, outage) is retried as it was, not escalated.
    const retry = entry.escalation?.kind === 'retry' && to.provider === entry.provider && String(to.model || '') === String(entry.model || '');
    const summary = entry.lastResult?.summary ? clip(entry.lastResult.summary, 1500) : null;
    const note = retry
      ? `RETRY: a previous attempt on ${entry.provider}/${entry.model || 'default'} ended ${entry.escalation?.reason || entry.state} on a temporary failure (a timeout, rate limit, outage or crash).${summary ? ` Its result: ${summary}` : ''} Try again, continuing from there.`
      : `ESCALATION: a previous attempt on ${entry.provider}/${entry.model || 'default'} ended ${entry.escalation?.reason || entry.state}.${summary ? ` Its result: ${summary}` : ''} Continue from there.`;
    const context = [entry.context, note].filter(Boolean).join('\n\n');
    const result = await dispatch({
      provider: to.provider, model: to.model || null, effort: to.effort || null, task: entry.task, cwd: entry.cwd, context,
      title: clip(`${entry.title} ${retry ? '↻' : '↑'}`, 80), tags: entry.tags, workflowId: entry.workflowId, parentRunId: runId,
      mcpProfile: entry.provider === to.provider ? entry.mcpProfile : undefined, capability: entry.capability,
      permissionPolicy: to.provider === 'codex' && entry.permissionPolicy === 'ask' ? 'restricted' : entry.permissionPolicy,
      usesBrowser: entry.usesBrowser, usesComputer: entry.usesComputer, maxMinutes: entry.maxMinutes, budgetUsd: entry.budgetUsd,
      outputSchema: entry.outputSchema, taskClass: entry.taskClass || null,
    }, { assistantSessionId: entry.assistantSessionId, origin: 'ui', brief: entry.brief || null });
    const child = entries.get(result?.run?.runId);
    if (child) { child.escalationDepth = (Number(entry.escalationDepth) || 0) + 1; child.escalatedFrom = runId; }
    entry.notes.push(`${retry ? 'retried on' : 'escalated to'} ${to.provider}/${to.model || 'default'} as ${result?.run?.runId || '?'}`);
    emit(entry, 'escalated', { childRunId: result?.run?.runId || null });
    return result;
  }
  function computeEscalation(entry, stateOverride = null) {
    if (!router?.escalationFor) return null;
    try { return router.escalationFor({ run: stateOverride ? { ...entry, state: stateOverride } : entry, depth: Number(entry.escalationDepth) || 0 }) || null; }
    catch { return null; }
  }

  // ── Jev (worker-outcome, rider worker-claim) ────────────────────────────────
  // judge() is bounded by the surface timeout; this guard only keeps a wrapper
  // bug from holding a turn or a 'failed' event forever.
  const JUDGE_GUARD_MS = 10_000;
  function bounded(promise) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise).catch(() => null),
      new Promise((resolveGuard) => { timer = setTimeout(() => resolveGuard(null), JUDGE_GUARD_MS); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
  }
  function lastParagraph(text) {
    const parts = String(text || '').split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }
  function tailOf(text, max = 300) {
    const s = String(text || '').trim();
    return s.length > max ? s.slice(s.length - max) : s;
  }
  function judgeContext(entry) {
    return { runId: entry.runId, assistantSessionId: entry.assistantSessionId || null, project: entry.project || null };
  }
  /**
   * What Jev answered for the asked questions, applied or not. The log keeps it
   * beside what was applied, so a cause judged below minConfidence (the 0.61
   * "transient" of the acceptance run) does not read as a missing judgment.
   */
  function judgedView(judged) {
    const v = judged?.verdict;
    if (!v || typeof v !== 'object') return null;
    const round = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);
    const out = {};
    if (judged.asked?.status && typeof v.status === 'string') { out.status = v.status; out.statusConfidence = round(v.statusConfidence); }
    if (judged.asked?.cause && typeof v.cause === 'string') { out.cause = v.cause; out.causeConfidence = round(v.causeConfidence); }
    return Object.keys(out).length ? out : null;
  }
  /**
   * One request about a finished turn, before any result-retry turn: the
   * status (only without a ## Result block, and never for output_schema runs),
   * the cause (no block, or blocked), and the claim (a possible "done" with
   * something to check it against).
   */
  async function judgeTurn(entry, { text, parsed, noBlock, evidence, followUp }) {
    if (!judge?.workerOutcome) return null;
    const ask = {
      status: noBlock && !entry.outputSchema,
      cause: noBlock || parsed.status === 'blocked',
      claim: (noBlock || parsed.status === 'done') && evidence.hasEvidence,
    };
    if (!ask.status && !ask.cause && !ask.claim) return null;
    const judged = await bounded(judge.workerOutcome({
      task: followUp ? `${entry.task}\n\nFollow-up: ${followUp}` : entry.task,
      message: text,
      declared: parsed.found ? { status: parsed.status, summary: parsed.summary, question: parsed.question } : null,
      run: { provider: entry.provider, state: 'idle', completionReason: null, error: null },
      filesEdited: evidence.files, commands: evidence.commands, toolResults: evidence.results,
    }, ask, judgeContext(entry)));
    if (!judged || typeof judged !== 'object') return null;
    // Only answers to questions this turn asked count.
    return {
      ...judged,
      status: ask.status ? judged.status || null : null,
      cause: ask.cause ? judged.cause || null : null,
      claimFlagged: ask.claim ? !!judged.claimFlagged : false,
      claimProbability: ask.claim ? judged.claimProbability ?? null : null,
    };
  }
  /**
   * A failed run: what kept it from finishing (capability / access / needs the
   * user / transient) decides which escalation is offered, so 'failed' waits
   * for it — at most the surface timeout. Without Jev it is emitted at once.
   */
  function emitFailed(entry, evidenceAcc = null) {
    const done = () => { delete entry.judging; entry.escalation = computeEscalation(entry); emit(entry, 'failed'); };
    if (!judge?.workerOutcome || entry.completionReason === 'budget_cap') { done(); return Promise.resolve(); }
    entry.judging = true;
    const evidence = evidenceSnapshot(evidenceAcc);
    const error = [entry.error, ...(entry.notes || []).slice(-3)].filter(Boolean).map((line) => String(line)).join('\n');
    const last = entry.lastResult && typeof entry.lastResult === 'object' ? entry.lastResult : null;
    return bounded(judge.workerOutcome({
      task: entry.task,
      message: entry.lastText || '',
      declared: last?.found ? { status: last.status, summary: last.summary, question: last.question } : null,
      run: { provider: entry.provider, state: 'failed', completionReason: entry.completionReason || null, error },
      filesEdited: evidence.files, commands: evidence.commands, toolResults: evidence.results,
    }, { status: false, cause: true, claim: false }, judgeContext(entry))).then((judged) => {
      const view = judgedView(judged);
      try {
        if (judged?.cause) {
          entry.failure = { cause: judged.cause, confidence: judged.causeConfidence, needs: clip(entry.error || error || lastParagraph(entry.lastText) || tailOf(entry.lastText), 200) || null, source: 'jev' };
        } else if (view?.cause) {
          // Judged, but below minConfidence: not applied (the escalation stays the old ladder), still visible.
          entry.failure = { cause: null, confidence: null, needs: null, source: 'jev', judgedCause: view.cause, judgedConfidence: view.causeConfidence };
        }
      } catch { /* the failure stays unjudged */ }
      delete entry.judging;
      entry.escalation = computeEscalation(entry);
      if (judged?.logId) {
        try { judge.annotate?.(judged.logId, { run: entry.runId, turn: null, source: 'failure', retried: false, status: 'failed', cause: judged.cause || null, claim: null, escalation: entry.escalation?.kind || null, judged: view, applied: { cause: !!judged.cause } }); } catch {}
      }
      emit(entry, 'failed');
    }).catch(() => { if (entry.judging) done(); });
  }

  async function start(entry) {
    const runtime = safeRuntime();
    if (!runtime) throw new DispatchError('RUNTIME_UNAVAILABLE', 'Native loop runtime is not available', { status: 503 });
    // A queued or held run starts under the caps that apply now.
    refreshLimits();
    try { refuseUnpriced(entry); fitBudget(entry); } catch (error) {
      entry.state = 'stopped'; entry.completionReason = error?.code === 'BUDGET_UNPRICED' ? 'budget_unpriced' : 'session_budget_cap'; entry.finishedAt = iso(now()); entry.turnState = 'terminal'; entry.pending = [];
      entry.notes.push(`not started: ${error?.message || error}`);
      emit(entry, 'stopped');
      throw error;
    }
    if (loopDir && !existsSync(loopDir)) mkdirSync(loopDir, { recursive: true });
    let browserSessionId = null;
    let browserTabId = null;
    if (entry.usesBrowser && typeof acquireLoopBrowserAndTab === 'function') {
      const acq = await acquireLoopBrowserAndTab({ requestedBrowserSessionId: entry.requestedBrowserSessionId, terminalSessionId: entry.runId, logTag: 'assistant:browser' });
      if (acq?.error) {
        entry.state = 'failed'; entry.completionReason = 'browser_unavailable'; entry.finishedAt = iso(now()); entry.notes.push(acq.error);
        emit(entry, 'failed');
        throw new DispatchError('PROVIDER_UNAVAILABLE', acq.error, { status: 500 });
      }
      browserSessionId = acq.browserSessionId || null;
      browserTabId = acq.browserTabId || null;
    }
    entry.browserSessionId = browserSessionId;
    entry.browserTabId = browserTabId;
    const liveState = {
      entry, ctx: null, ring: [], ringChars: 0, followUps: [], waitResolve: null, idleTimer: null,
      pendingResolvers: new Map(), dead: false, lastEventAt: now(), stalledFlagged: false, turnCounter: 0, abortReason: null,
      evidence: null, // the current turn's commands / tool results / edited files (assistant-evidence.js)
    };
    live.set(entry.runId, liveState);
    const extraEnv = {};
    if (entry.claudeConfigDir) extraEnv.CLAUDE_CONFIG_DIR = entry.claudeConfigDir;
    // Computer use: an unforgeable per-run grant unlocks the `computer` MCP
    // group for this worker only. Passed as a function so the loop runtime's
    // JSON state file never contains it.
    let desktopGrant = null;
    if (entry.usesComputer && desktop?.mintGrant) {
      try { desktopGrant = desktop.mintGrant({ kind: 'run', assistantSessionId: entry.assistantSessionId, runId: entry.runId, provider: entry.provider, model: entry.model, vision: entry.modelInfo?.vision ?? null }); }
      catch (error) { entry.notes.push(`desktop grant failed: ${error?.message || error}`); }
    }
    const state = {
      active: true, task: entry.task, context: entry.context, totalIterations: 1, currentIteration: 0,
      maxMinutes: entry.maxMinutes, startedAt: iso(now()), lastIterationAt: null, retries: 0, pending: false,
      terminalSessionId: entry.runId, usesBrowser: entry.usesBrowser, usesComputer: !!entry.usesComputer, browserSessionId, browserTabId,
      profile: entry.provider, provider: entry.provider, agent: entry.agent || null,
      model: entry.model, modelContextWindow: entry.modelContextWindow || null, effort: entry.effort, mcpProfile: entry.mcpProfile,
      codexAccountId: entry.codexAccountId, codexHome: entry.provider === 'codex' ? (entryCodexHome(entry)) : null,
      claudeAccountId: entry.claudeAccountId, claudeConfigDir: entry.claudeConfigDir,
      driverType: 'native', runtimeType: 'native', surface: 'sidepanel', runId: entry.runId, cwd: entry.cwd,
      runMode: 'task', assistantSessionId: entry.assistantSessionId, permissionPolicy: entry.permissionPolicy,
      capability: entry.capability, budgetUsd: entry.budgetUsd, maxBudgetUsd: entry.provider === 'claude-code' ? entry.budgetUsd : null,
      idleTimeoutMs: entry.idleTimeoutMs, maxTurns: entry.maxTurns, outputSchema: entry.outputSchema, project: entry.project,
      title: entry.title, tags: entry.tags, workflowId: entry.workflowId, parentRunId: entry.parentRunId,
      // The user's brief after a clarification (assistant-task-prompt.js briefBlock).
      brief: entry.brief || null,
      // Image / video creation: the prompt's media block and what the adapter collects ('image' | 'video');
      // design collects its screenshots and images the same way ('image').
      taskClass: entry.taskClass || null, collectMedia: collectedMedia(entry.taskClass),
      // extraEnv is a plain object, so it IS written to the loop state file;
      // keep secrets out of it. The desktop grant rides as a function instead.
      extraEnv,
      desktopGrantProvider: desktopGrant ? () => desktopGrant : null,
      // What the adapter reports while it starts (a Codex worker whose browser-policy hook is not trusted).
      onNote: (text) => { const note = String(text || '').trim(); if (note && !entry.notes.includes(note)) entry.notes.push(note); },
    };
    if (entry.permissionPolicy === 'ask') state.permissionBroker = createBroker(entry.runId);
    // A class's rules (design), read now so an edited override applies without a restart;
    // they go to the prompt only, not into the loop state file.
    const playbook = playbookFor(entry);
    // The project's Style Guide, read now like the rules: its summary and file paths go to the
    // prompt only (never the loop state file). null without a saved guide, or for a class it keeps out.
    const styleGuide = styleGuideFor(entry);
    entry.state = 'starting';
    entry.turnState = 'starting';
    entry.startedAt = state.startedAt;
    try {
      const descriptor = await runtime.launch({
        runId: entry.runId,
        state,
        source: 'assistant',
        focus: entry.focus === true,
        title: entry.title,
        buildPrompt: () => buildTaskPrompt(playbook || styleGuide ? { ...state, ...(playbook ? { playbook } : {}), ...(styleGuide ? { styleGuide } : {}) } : state),
        wrapAdapter: (adapter, ctx) => createTaskAdapter(adapter, ctx, liveState, state),
      });
      entry.runtime = { status: descriptor.status };
      emit(entry, 'started');
      reconcileKeepAwake();
      return descriptor;
    } catch (error) {
      entry.state = 'failed'; entry.completionReason = 'launch_error'; entry.finishedAt = iso(now());
      entry.notes.push(error?.message || String(error));
      if (browserSessionId) await releaseSharedBrowserTab(browserSessionId, entry.runId).catch(() => {});
      releaseDesktop(entry);
      // The escalation and the 'failed' event follow the cause (fire-and-forget; at once without Jev).
      emitFailed(entry, liveState.evidence || null);
      throw error;
    }
  }
  /**
   * What the run's prompt says about its project's Style Guide (lib/style-guide/store.js): the
   * summary for the run's class, DESIGN.md and the token files. null when the project has no saved
   * guide, when the guide keeps this class out, or when reading it fails: a run never waits on it.
   */
  function styleGuideFor(entry) {
    try { return loadStyleGuide(entry.cwd, entry.taskClass || null) || null; } catch { return null; }
  }
  /**
   * The rules a run of the entry's class follows (assistant-playbooks.js: the user's override
   * at <dataDir>/playbooks/<name>.md, else the shipped copy), or null. The run's notes say
   * when the override was used or why it was not.
   */
  function playbookFor(entry) {
    const name = classPlaybook(entry.taskClass);
    if (!name) return null;
    let playbook = null;
    try { playbook = loadPlaybook(name, { dataDir }); } catch { playbook = null; }
    if (!playbook) return { name, text: '', source: 'missing' };
    if (playbook.source === 'override') entry.notes.push(`${name} rules: your override ${playbook.path}`);
    if (playbook.note) entry.notes.push(`${name} rules: ${playbook.note}`);
    return playbook;
  }
  function releaseDesktop(entry) {
    if (!entry?.usesComputer || !desktop) return;
    try { desktop.revokeFor?.({ runId: entry.runId }); } catch {}
    try { desktop.releaseOwner?.({ runId: entry.runId }); } catch {}
  }
  function entryCodexHome(entry) {
    if (entry.codexHome) return entry.codexHome;
    const account = entry.codexAccountId ? findCodexAccount(entry.codexAccountId) : getCodexAccount(null);
    return account?.home || CODEX_DEFAULT_HOME || null;
  }

  // ── permission broker ('ask' policy) ──────────────────────────────────────
  function createBroker(runId) {
    return {
      request: (request = {}) => new Promise((resolvePermission) => {
        const entry = entries.get(runId);
        const liveState = live.get(runId);
        if (!entry || !liveState) { resolvePermission({ behavior: 'deny', message: 'Run is no longer tracked.' }); return; }
        const requestId = `perm-${randomBytes(6).toString('hex')}`;
        const kind = request.kind === 'ask' ? 'question' : 'permission';
        const timeoutMs = kind === 'question' ? limits.questionTimeoutMs : limits.permissionTimeoutMs;
        const pending = {
          requestId, kind, toolName: request.toolName || null, input: request.input ?? null,
          questions: Array.isArray(request.questions) ? request.questions : [], createdAt: iso(now()), expiresAt: iso(now() + timeoutMs),
        };
        entry.pending = [...(entry.pending || []), pending];
        entry.state = 'awaiting_permission';
        entry.turnState = 'awaiting_permission';
        liveState.ctx?.setTurnState?.('awaiting_permission');
        liveState.ctx?.emit?.({ type: 'synabun.permission_request', requestId, kind, toolName: pending.toolName, input: pending.input, questions: pending.questions });
        const timer = setTimeout(() => finishPending(runId, requestId, { behavior: 'deny', message: `No decision within ${Math.round(timeoutMs / 60000)} minutes.`, resolvedBy: 'timeout' }), timeoutMs);
        timer.unref?.();
        liveState.pendingResolvers.set(requestId, { resolve: resolvePermission, timer });
        try { broadcastSync({ type: 'assistant:permission-request', runId, assistantSessionId: entry.assistantSessionId, provider: entry.provider, request_id: requestId, request: pending }); } catch {}
        emit(entry, kind === 'question' ? 'needs_input' : 'permission_request', { request: pending });
        const abortSignal = request.signal;
        if (abortSignal && typeof abortSignal.addEventListener === 'function') {
          abortSignal.addEventListener('abort', () => finishPending(runId, requestId, { behavior: 'deny', message: 'Run aborted.', resolvedBy: 'abort' }), { once: true });
        }
      }),
    };
  }
  function finishPending(runId, requestId, response, { origin = 'system' } = {}) {
    const entry = entries.get(runId);
    const liveState = live.get(runId);
    if (!entry || !liveState) return false;
    const resolver = liveState.pendingResolvers.get(requestId);
    if (!resolver) return false;
    clearTimeout(resolver.timer);
    liveState.pendingResolvers.delete(requestId);
    const request = (entry.pending || []).find((item) => item.requestId === requestId) || null;
    entry.pending = (entry.pending || []).filter((item) => item.requestId !== requestId);
    if (entry.state === 'awaiting_permission' && entry.pending.length === 0) {
      entry.state = 'running';
      entry.turnState = 'running';
      liveState.ctx?.setTurnState?.('running');
    }
    const reply = { behavior: response?.behavior === 'allow' ? 'allow' : 'deny', ...response };
    liveState.ctx?.emit?.({ type: 'synabun.permission_resolved', requestId, behavior: reply.behavior, toolName: request?.toolName || null, resolvedBy: reply.resolvedBy || origin });
    try { broadcastSync({ type: 'assistant:permission-resolved', runId, assistantSessionId: entry.assistantSessionId, requestId, behavior: reply.behavior, resolvedBy: reply.resolvedBy || origin }); } catch {}
    entry.notes.push(`${request?.kind || 'permission'} ${requestId} ${reply.behavior} by ${reply.resolvedBy || origin}`);
    resolver.resolve(reply);
    emit(entry, 'permission_resolved', { requestId, behavior: reply.behavior, resolvedBy: reply.resolvedBy || origin });
    return true;
  }
  function respondPermission(runId, requestId, response = {}, { origin = 'assistant' } = {}) {
    const entry = entries.get(runId);
    if (!entry) throw new DispatchError('RUN_NOT_FOUND', `Unknown run ${runId}`, { status: 404 });
    const liveState = live.get(runId);
    if (!liveState?.pendingResolvers.has(requestId)) {
      const known = (entry.notes || []).some((note) => note.includes(String(requestId)));
      throw new DispatchError(known ? 'PERMISSION_ALREADY_RESOLVED' : 'NO_PENDING_REQUEST', known ? `Request ${requestId} was already resolved` : `No pending request ${requestId} on run ${runId}`, { status: 409 });
    }
    const behavior = response.behavior === 'allow' || response.decision === 'allow' || response.decision === 'answer' ? 'allow' : 'deny';
    finishPending(runId, requestId, {
      behavior, updatedInput: response.updatedInput, message: response.message || response.note, always: !!response.always,
      answers: response.answers, resolvedBy: origin,
    }, { origin });
    return view(entry);
  }

  // ── task adapter (turn loop) ───────────────────────────────────────────────
  function createTaskAdapter(inner, ctx, liveState, state) {
    const entry = liveState.entry;
    liveState.ctx = ctx;
    liveState.inner = inner;
    startUsageMetering(entry, liveState);
    const waitForFollowUp = () => new Promise((resolveWait) => {
      const finish = (value) => { if (liveState.idleTimer) { clearTimeout(liveState.idleTimer); liveState.idleTimer = null; } liveState.waitResolve = null; resolveWait(value); };
      if (liveState.followUps.length) { finish(liveState.followUps.shift()); return; }
      if (liveState.abortReason) { finish({ kind: 'abort' }); return; }
      liveState.waitResolve = finish;
      liveState.idleTimer = setTimeout(() => finish({ kind: 'timeout' }), entry.idleTimeoutMs);
      liveState.idleTimer.unref?.();
    });
    const runInnerTurn = async (prompt, meta, { origin = 'assistant', label = null, followUp = null, taskId = entry.taskId || null } = {}) => {
      liveState.turnCounter += 1;
      const turnNumber = liveState.turnCounter;
      const startedAt = iso(now());
      // The task this turn works for: every usage row it settles carries it (a result-retry turn included).
      liveState.usageTurn = { n: turnNumber, taskId };
      // Saved with the run: a result that arrives after a restart belongs to the turn that was
      // started, whether or not it was ever recorded.
      usageStateOf(entry).turn = { n: turnNumber, taskId };
      liveState.turnUsage = null;
      liveState.turnTokens = zeroTokens();
      liveState.turnOpen = true;
      startUsagePolling(entry, liveState);
      entry.state = 'running';
      entry.turnState = 'running';
      ctx.setTurnState('running');
      emit(entry, 'turn_started', { turn: turnNumber });
      // What this turn runs (commands, tool results, edited files): the evidence behind a "done".
      liveState.evidence = createTurnEvidence();
      // Money booked while this turn runs (OpenCode steps, Codex rollout records).
      liveState.turnMeteredUsd = 0;
      let raw = await inner.runTurn(prompt, { ...meta, turn: turnNumber, outputSchema: entry.outputSchema || undefined });
      if (entry.provider === 'codex') settleCodexTurn(entry, liveState, raw);
      let text = typeof raw?.text === 'string' ? raw.text : '';
      let parsed = parseResultContract(text);
      parsed.source = parsed.found ? 'contract' : null;
      // A run with an output schema answers with bare JSON: that object is its result, no retry turn.
      if (!parsed.found) parsed = structuredResult(entry, raw, text) || parsed;
      const noBlock = !parsed.found && strictResult && !!text.trim() && !liveState.dead;
      const evidence = evidenceSnapshot(liveState.evidence);
      // One Jev request before any retry turn (null without Jev: today's behaviour).
      const judged = await judgeTurn(entry, { text, parsed, noBlock, evidence, followUp });
      let retried = false;
      let retryCost = 0;
      if (judged?.status) {
        // The status its message reports is enough: no result-retry turn.
        parsed.status = judged.status;
        parsed.source = 'jev';
        parsed.judged = { status: judged.status, confidence: judged.statusConfidence };
        if (judged.status === 'needs_input') parsed.question = clip(lastParagraph(text), 500);
        if (evidence.files.length) { parsed.files = [...evidence.files]; parsed.changes = evidence.files.map((path) => ({ path, note: '' })); }
      } else if (noBlock && !liveState.dead) {
        retried = true;
        try {
          const retry = await inner.runTurn(buildResultRetryPrompt(), { ...meta, turn: turnNumber, retry: true });
          const retryText = typeof retry?.text === 'string' ? retry.text : '';
          const retryParsed = parseResultContract(retryText);
          if (retryParsed.found) { parsed = { ...retryParsed, source: 'retry' }; text = `${text}\n\n${retryText}`; }
          retryCost = accumulateCost(entry, retry);
          if (entry.provider === 'codex') settleCodexTurn(entry, liveState, retry);
        } catch (error) {
          retryCost = accumulateCost(entry, error);
          if (entry.provider === 'codex') settleCodexTurn(entry, liveState, error);
          entry.notes.push(`result retry failed: ${error?.message || error}`);
        }
      }
      if (judged) {
        // Why it stopped short (blocked, or still no usable status): decides the escalation offered.
        const usable = parsed.found || parsed.source === 'jev';
        if (judged.cause && (parsed.status === 'blocked' || !usable)) {
          parsed.cause = judged.cause;
          parsed.causeConfidence = judged.causeConfidence;
          parsed.needs = clip(parsed.question || (parsed.found ? parsed.summary : '') || lastParagraph(text) || tailOf(text, 300), 200) || null;
        }
        // "Done" while the turn's own output does not show it.
        if (parsed.status === 'done' && judged.claimFlagged) {
          parsed.unverifiedClaim = { probability: judged.claimProbability, evidence: claimEvidenceLine(evidence) };
        }
      }
      // Image / video creation: the files this turn generated, copied under data/media/<runId>/.
      const media = await collectTurnMedia(entry, raw, parsed);
      parsed.media = media.map(({ kind, path, url, mime, bytes }) => ({ kind, path, url, mime, bytes }));
      if (media.length) parsed.files = [...new Set([...(parsed.files || []), ...media.map((m) => m.path)])];
      // The turn's own usage. Codex was read from its rollout at each provider turn's end; OpenCode
      // is reconciled with what its serve stored (child sessions included) before it is settled.
      liveState.turnOpen = false;
      stopUsagePolling(liveState);
      let turnUsage = raw?.usage || null;
      if (entry.provider === 'codex') turnUsage = liveState.turnUsage || null;
      else if (entry.provider === 'opencode') turnUsage = (await settleOpenCodeTurn(entry, liveState)) || turnUsage;
      // A reported cost below an earlier turn's estimate can make this negative: a turn never reads below $0.
      const turnCost = Math.max(0, accumulateCost(entry, raw) + retryCost + (Number(liveState.turnMeteredUsd) || 0));
      // `usage` is what the provider reported (Claude: the first result's main loop only). `tokens`
      // is the whole turn: every row settled for it, the retry turn and sub-agents included.
      const turn = {
        n: turnNumber, taskId, origin, label, startedAt, endedAt: iso(now()), promptPreview: clip(prompt, 200), text: text.slice(0, 20_000),
        usage: turnUsage, tokens: withTotal(liveState.turnTokens), costUsd: Number(turnCost.toFixed(8)), result: parsed, structured: raw?.structured ?? null,
      };
      // Rows that settle from here on (a late rollout record) go to the record itself.
      liveState.turnTokens = null;
      entry.turns = [...(entry.turns || []), turn].slice(-50);
      entry.lastResult = parsed;
      entry.lastText = text.slice(0, 20_000);
      // Blocked or contract-less turns offer a one-tier escalation (the run
      // itself stays warm for follow-ups; the brain or the user decides). A
      // status Jev read from the message is a usable result.
      entry.escalation = parsed.status === 'blocked' || (!parsed.found && parsed.source !== 'jev') ? computeEscalation(entry, 'idle') : null;
      if (judged?.logId) {
        try {
          judge.annotate?.(judged.logId, {
            run: entry.runId, turn: turnNumber, source: parsed.source, retried, status: parsed.status, cause: parsed.cause || null,
            claim: judged.claimProbability === null || judged.claimProbability === undefined ? null : !!parsed.unverifiedClaim,
            escalation: entry.escalation ? (entry.escalation.kind || 'escalate') : null,
            judged: judgedView(judged), applied: { status: parsed.source === 'jev', cause: !!parsed.cause },
          });
        } catch {}
      }
      // The worker remembers before its ## Result block: this turn's events carry that memory.
      syncMemory(entry);
      if (parsed.status === 'needs_input') emit(entry, 'needs_input', { turn: turnNumber, question: parsed.question });
      emit(entry, 'turn_completed', { turn: turnNumber });
      announceUnpriced(entry);
      checkSession(entry.assistantSessionId, { source: entry });
      return parsed;
    };
    return {
      identity: () => (typeof inner.identity === 'function' ? inner.identity() : {}),
      isAlive: () => !liveState.dead && (typeof inner.isAlive === 'function' ? inner.isAlive() : true),
      describe: () => ({ ...(typeof inner.describe === 'function' ? inner.describe() : {}), runMode: 'task' }),
      async runTurn(prompt, meta = {}) {
        try {
          await runInnerTurn(prompt, meta, { origin: 'dispatch' });
        } catch (error) {
          return handleTurnError(error, liveState, entry, ctx);
        }
        for (;;) {
          // Out of money (the run's cap or the session's): stop instead of idling warm.
          refreshLimits();
          const spentOut = budgetBlock(entry);
          if (spentOut) return budgetStop(entry, spentOut);
          entry.state = 'idle';
          entry.turnState = 'idle';
          ctx.setTurnState('idle');
          emit(entry, 'idle');
          const next = await waitForFollowUp();
          if (next.kind === 'abort') { entry.completionReason = entry.completionReason || liveState.abortReason || 'aborted'; return { providerSessionId: inner.identity?.()?.providerSessionId }; }
          if (next.kind === 'complete') { entry.completionReason = 'complete'; return { providerSessionId: inner.identity?.()?.providerSessionId }; }
          if (next.kind === 'timeout') { entry.completionReason = 'idle_timeout'; return { providerSessionId: inner.identity?.()?.providerSessionId }; }
          if (liveState.turnCounter >= entry.maxTurns) {
            entry.completionReason = 'max_turns';
            entry.notes.push(`follow-up dropped: max turns (${entry.maxTurns}) reached`);
            return { providerSessionId: inner.identity?.()?.providerSessionId };
          }
          refreshLimits();
          const blocked = budgetBlock(entry);
          if (blocked) {
            entry.notes.push(`follow-up dropped: ${blocked.message}`);
            return budgetStop(entry, blocked);
          }
          try {
            const followPrompt = buildFollowUpPrompt(next.text, state, { turn: liveState.turnCounter + 1, maxTurns: entry.maxTurns, origin: next.origin });
            await runInnerTurn(followPrompt, meta, { origin: next.origin, label: clip(next.text, 80), followUp: next.text, taskId: next.taskId || entry.taskId || null });
          } catch (error) {
            return handleTurnError(error, liveState, entry, ctx);
          }
        }
      },
      async abort(reason = 'aborted') {
        liveState.abortReason = reason;
        if (liveState.waitResolve) liveState.waitResolve({ kind: 'abort' });
        for (const requestId of [...liveState.pendingResolvers.keys()]) finishPending(entry.runId, requestId, { behavior: 'deny', message: 'Run aborted.', resolvedBy: 'abort' });
        try { return await inner.abort?.(reason); } catch { return true; }
      },
      async dispose(options) {
        liveState.dead = true;
        stopUsagePolling(liveState);
        if (liveState.waitResolve) liveState.waitResolve({ kind: 'abort' });
        try { return await inner.dispose?.(options); } catch { return undefined; }
      },
    };
  }
  /**
   * The files one turn generated: what the adapter found (Codex rollout /
   * generated_images/, OpenCode file parts) plus, for an image / video creation
   * or design run, the paths the worker listed under media: (files made during
   * the run only). Each is copied once into <dataDir>/media/<runId>/ and appended to
   * entry.media, whose index is its URL (GET /api/assistant/runs/:runId/media/:n).
   */
  async function collectTurnMedia(entry, raw, parsed) {
    const found = Array.isArray(raw?.media) ? raw.media.filter((item) => item && (item.path || item.data)) : [];
    const named = collectedMedia(entry.taskClass) && Array.isArray(parsed?.media) ? parsed.media.filter((p) => typeof p === 'string' && p.trim()) : [];
    if (!found.length && !named.length) return [];
    const known = new Set((entry.media || []).map((m) => m.original).filter(Boolean));
    const items = [];
    const add = (item, path) => {
      if (path) { if (known.has(path)) return; known.add(path); }
      items.push(path ? { ...item, path } : item);
    };
    for (const item of found) add(item, item.path ? resolve(String(item.path)) : null);
    for (const path of named) add({ source: 'contract' }, isAbsolute(path) ? resolve(path) : resolve(entry.cwd || PACKAGE_ROOT, path));
    const start = (entry.media || []).length;
    const startedMs = Date.parse(entry.startedAt || entry.createdAt || '') || 0;
    // Every turn of the run shares one byte budget.
    const used = (entry.media || []).reduce((sum, m) => sum + (Number(m.bytes) || 0), 0);
    let copied = [];
    try {
      copied = await copyRunMedia({
        root: mediaRoot, runId: entry.runId, items, start, sinceMs: startedMs ? startedMs - 5000 : 0,
        maxBytes: limits.mediaFileBytes, budgetBytes: Math.max(0, limits.mediaRunBytes - used),
      });
    } catch (error) { entry.notes.push(`media copy failed: ${error?.message || error}`); }
    const records = copied.map((m, i) => ({ ...m, url: mediaUrl(entry.runId, start + i) }));
    if (records.length) entry.media = [...(entry.media || []), ...records];
    const skipped = items.length - records.length;
    if (skipped > 0) entry.notes.push(`${skipped} generated file${skipped === 1 ? '' : 's'} not collected (missing, a symlink, not an image or video, too large, over the run's media budget, or older than the run)`);
    return records;
  }
  /**
   * The n-th recorded file of a run for the media route: { path (its real path), mime, kind, bytes }
   * or null. A symlink put in place of the file or of media/<runId>/ is never followed.
   */
  function mediaFile(runId, n) {
    const entry = entries.get(String(runId));
    const item = entry && Number.isInteger(n) && n >= 0 ? entry.media?.[n] : null;
    const real = item?.path ? servableRunMedia(mediaRoot, entry.runId, item.path) : null;
    if (!real) return null;
    return { path: real, mime: mediaType(item.path)?.mime || null, kind: item.kind || null, bytes: item.bytes ?? null };
  }

  /**
   * The result of a turn that answered with structured output and no ## Result block: Claude's
   * structured_output, or (a run with an output schema) a final message that is the JSON itself.
   * null when the turn carried no such object.
   */
  function structuredResult(entry, raw, text) {
    const given = raw?.structured;
    const json = given && typeof given === 'object' && !Array.isArray(given) ? given : (entry.outputSchema ? parseJsonObject(text) : null);
    if (!json) return null;
    const status = typeof json.status === 'string' ? json.status.trim().toLowerCase() : '';
    return {
      found: true, parseFailed: false, status: RESULT_STATUSES.includes(status) ? status : 'done',
      summary: typeof json.summary === 'string' ? json.summary : clip(text, 600), changes: [], files: [], follow_ups: [], media: [],
      question: typeof json.question === 'string' ? json.question : '', json, jsonError: null, raw: text, source: 'structured',
    };
  }

  function handleTurnError(error, liveState, entry, ctx) {
    // A failed turn was still paid for (a budget-capped run used to read $0).
    liveState.turnOpen = false;
    stopUsagePolling(liveState);
    accumulateCost(entry, error);
    // Codex reports no usage for a failed or aborted turn: its rollout has it (the final poll).
    // Without a rollout nothing is known, so nothing is booked and nothing is flagged.
    if (entry.provider === 'codex') settleCodexTurn(entry, liveState, error);
    // OpenCode: what streamed before the failure, as it stands (its serve may be gone: no reconcile).
    else if (entry.provider === 'opencode') bookOpenCodeTurn(entry, liveState, { reconciled: false });
    announceUnpriced(entry);
    checkSession(entry.assistantSessionId, { source: entry });
    if (budgetStopReason(entry.completionReason)) return { providerSessionId: null };
    if (error?.code === 'BUDGET_CAP') {
      entry.completionReason = 'budget_cap';
      entry.notes.push('stopped: per-run budget cap reached');
      const runtime = safeRuntime();
      runtime?.stop?.(entry.runId, 'budget_cap').catch(() => {});
      return { providerSessionId: null };
    }
    if (liveState.abortReason || /AbortError|aborted/i.test(String(error?.name || error?.message || ''))) {
      entry.completionReason = entry.completionReason || liveState.abortReason || 'aborted';
      return { providerSessionId: null };
    }
    // Fatal provider error: never let the runtime re-send the whole task.
    liveState.dead = true;
    entry.completionReason = entry.completionReason || 'provider_error';
    entry.notes.push(`provider error: ${error?.message || error}`);
    throw error;
  }
  function budgetStopReason(reason) { return reason === 'budget_cap' || reason === 'session_budget_cap' || reason === 'budget_unpriced'; }
  /** Stop a run that is out of money; the runtime ends it as stopped with this reason. */
  function budgetStop(entry, block) {
    entry.completionReason = block.reason;
    entry.notes.push(`stopped: ${block.message}`);
    safeRuntime()?.stop?.(entry.runId, block.reason).catch(() => {});
    return { providerSessionId: null };
  }
  /**
   * Codex usage (raw provider keys) at the list price (assistant-pricing.js, else models.dev) of
   * the model that spent it: the one its rollout recorded, else the run's. null when that model
   * has no list price; another model's rate never stands in for it. `long`: the usage is of
   * responses whose prompt was over / under the long-context size (the meter knows it per
   * response); null when that is not known, and the run's context window decides.
   */
  function priceCodexUsage(entry, usage, rowModel = null, long = null) {
    const model = rowModel || entry.pricingModel || entry.model || null;
    let price = null;
    try { price = model ? pricing?.codexPrice?.(model) || null : null; } catch { price = null; }
    if (!price) return null;
    return codexUsageCostUsd(usage, price, { contextWindow: entry.modelContextWindow || null, long });
  }
  /** Usage no price covers: recorded and flagged, never booked as $0. */
  function markUnpriced(entry, reason) {
    entry.unpricedTurns = (Number(entry.unpricedTurns) || 0) + 1;
    entry.unpricedReason = String(reason || 'no price');
    entry.costBasis = weakerBasis(entry.costBasis, 'unpriced');
  }
  function announceUnpriced(entry) {
    if (!(Number(entry.unpricedTurns) > 0) || entry.unpricedAnnounced) return;
    entry.unpricedAnnounced = true;
    emit(entry, 'budget_unpriced', { text: `this run's usage could not be priced (${entry.unpricedReason}); its tokens are recorded but the dollar caps cannot meter it.` });
  }
  function codexThreadId(entry) {
    try { return entry.providerThreadId || live.get(entry.runId)?.inner?.identity?.()?.providerThreadId || null; } catch { return entry.providerThreadId || null; }
  }
  /** Add dollars to the run; returns the amount added. */
  function bookCost(entry, cost, basis) {
    const added = Number.isFinite(cost) && cost > 0 ? cost : 0;
    if (added) { entry.costUsd = Number(((Number(entry.costUsd) || 0) + added).toFixed(8)); entry.costBasis = weakerBasis(entry.costBasis, basis || 'reported'); }
    return added;
  }
  /** Add a usage object (provider keys) to the run's legacy running total, entry.usage. */
  function addLegacyUsage(entry, used) {
    if (!used || typeof used !== 'object') return;
    const prev = entry.usage || {};
    const next = {};
    for (const [key, value] of Object.entries(used)) if (Number.isFinite(Number(value))) next[key] = (Number(prev[key]) || 0) + Number(value);
    entry.usage = { ...prev, ...next };
    if (!entry.costBasis || entry.costBasis === 'none') entry.costBasis = 'tokens';
  }
  /**
   * Add one provider turn's charge to the run. `raw.costUsd` is that turn's own
   * charge (the Claude adapter turns the CLI's running total into it); a
   * rejected turn carries it on the error. Codex reports tokens only, and its
   * turn.completed.usage is the thread's running total: they are booked from
   * its rollout instead (settleCodexTurn). Returns the amount added.
   */
  function accumulateCost(entry, raw) {
    if (!raw) return 0;
    const cost = Number(raw.costUsd);
    const added = bookCost(entry, cost, raw.basis || 'reported');
    if (entry.provider !== 'codex') addLegacyUsage(entry, raw.usage);
    return added;
  }

  // ── usage (exact tokens: assistant-usage.js) ───────────────────────────────
  // One meter per run. Each settled row goes to the ledger with the run's task and turn; the
  // legacy entry.usage / entry.costUsd keep the run's own numbers, with or without a ledger.
  const usageStateOf = (entry) => (entry.usageState && typeof entry.usageState === 'object' ? entry.usageState : (entry.usageState = {}));
  const metersOf = (entry) => { if (!meters.has(entry.runId)) meters.set(entry.runId, {}); return meters.get(entry.runId); };
  /** The task of the brain turn in progress (the runtime's), or null. */
  function taskNow(sessionId) {
    if (!sessionId || typeof currentTask !== 'function') return null;
    let task = null;
    try { task = currentTask(sessionId); } catch { task = null; }
    const id = task && typeof task === 'object' ? task.id : task;
    return id ? String(id) : null;
  }
  /** The task a new run belongs to: the brain's current one, else the ledger's (created when the session has none). */
  function taskAtDispatch(sessionId) {
    const id = taskNow(sessionId);
    if (id || !ledger || !sessionId) return id;
    try { return ledger.ensureTask(sessionId)?.id || null; } catch { return null; }
  }
  /**
   * The turn a row belongs to: the one running, else the last one started as saved with the run
   * (after a restart the live stamp is gone and that turn may never have been recorded), else
   * the last one recorded (a run saved before the stamp was).
   */
  function turnStamp(entry) {
    const running = live.get(entry.runId)?.usageTurn;
    if (running) return running;
    const started = entry.usageState?.turn;
    if (started && typeof started === 'object') return { n: started.n ?? null, taskId: started.taskId || entry.taskId || null };
    const last = Array.isArray(entry.turns) ? entry.turns.at(-1) : null;
    return { n: last?.n ?? null, taskId: last?.taskId || entry.taskId || null };
  }
  /** Count a settled row in its turn's tokens: the turn in progress, else that turn's record. */
  function countTurnTokens(entry, stamp, tokens) {
    const liveState = live.get(entry.runId);
    if (liveState?.turnTokens && liveState.usageTurn?.n === stamp.n) { liveState.turnTokens = addTokens(liveState.turnTokens, tokens); return; }
    const turn = stamp.n === null ? null : (entry.turns || []).find((item) => item.n === stamp.n);
    if (turn) turn.tokens = withTotal(addTokens(turn.tokens, tokens));
  }
  /** One settled row: into its turn's tokens, and to the ledger (skipped without one, or for a run outside an assistant session). */
  function settleUsage(entry, row) {
    const stamp = turnStamp(entry);
    countTurnTokens(entry, stamp, row.tokens);
    if (!ledger || !entry.assistantSessionId) return null;
    try {
      return ledger.settle({ sessionId: entry.assistantSessionId, taskId: stamp.taskId, scope: 'run', runId: entry.runId, turn: stamp.n, provider: entry.provider, ...row });
    } catch (error) { log(entry.runId, 'assistant:usage-error', error?.message || String(error)); return null; }
  }
  /** The run's provisional tokens (a turn still running). A finished run has none: what comes late is settled or dropped. */
  function setPendingUsage(entry, tokens, model = null) {
    if (!ledger || !entry.assistantSessionId) return;
    try {
      if (TERMINAL_STATES.has(entry.state) || totalTokens(tokens) === 0) ledger.clearPending(entry.assistantSessionId, entry.runId);
      else ledger.setPending(entry.assistantSessionId, entry.runId, { taskId: turnStamp(entry).taskId, scope: 'run', runId: entry.runId, provider: entry.provider, model: model || entry.model || null, tokens });
    } catch (error) { log(entry.runId, 'assistant:usage-error', error?.message || String(error)); }
  }
  /** The run's exact tokens from the ledger (settled + provisional); null without a ledger or a session. */
  function tokensView(entry) {
    if (!ledger || !entry.assistantSessionId) return null;
    let seen = null;
    try { seen = ledger.runView(entry.assistantSessionId, entry.runId); } catch { seen = null; }
    const zero = withTotal(zeroTokens());
    return { ...(seen?.tokens || zero), pending: seen?.pending || zero, subagents: { total: seen?.subagents?.total || 0 }, fidelity: seen?.fidelity || 'exact' };
  }
  /**
   * A run that will not take another turn: only what a late Claude result needs is kept (the
   * snapshot it is differenced against and the turn it belongs to), the rest is dropped.
   */
  function closeUsageState(entry) {
    const kept = entry.usageState?.claude || null;
    const turn = entry.provider === 'claude-code' ? entry.usageState?.turn || null : null;
    entry.usageState = { ...(kept ? { claude: kept } : {}), ...(turn ? { turn } : {}), closed: true };
  }
  function stopUsagePolling(liveState) {
    if (liveState?.usageTimer) { clearInterval(liveState.usageTimer); liveState.usageTimer = null; }
  }
  /** A run's worker is up: point its meter at the run (OpenCode's root session). */
  function startUsageMetering(entry, liveState) {
    if (entry.provider !== 'opencode') return;
    let root = null;
    try { root = liveState.inner?.identity?.()?.providerSessionId || null; } catch { root = null; }
    if (root) openCodeMeterOf(entry).setRoot(root);
  }
  /**
   * A Codex turn began: while it runs, new rollout records are booked as they land and the caps
   * are checked. The timer ends with the turn (an idle run writes nothing) and starts again with
   * the next one.
   */
  function startUsagePolling(entry, liveState) {
    if (entry.provider !== 'codex' || liveState.usageTimer) return;
    liveState.usageTimer = setInterval(() => {
      if (liveState.dead || !liveState.turnOpen || TERMINAL_STATES.has(entry.state)) { stopUsagePolling(liveState); return; }
      try { if (pollCodex(entry, liveState).rows) enforceMidTurn(entry, liveState); } catch (error) { log(entry.runId, 'assistant:meter-error', error?.message || String(error)); }
    }, Math.max(20, Number(limits.usagePollMs) || 2000));
    liveState.usageTimer.unref?.();
  }

  /**
   * Claude rows into the ledger. The CLI reports what a counted call cost. An estimate row (a
   * call the stream showed and no result counts) has no reported cost: it is priced at list
   * price and added to the run's dollars.
   */
  function settleClaudeRows(entry, rows, settled = null) {
    for (const row of rows || []) {
      const estimate = row.source === CLAUDE_ESTIMATE_SOURCE;
      const costUsd = estimate ? claudeTokensCostUsd(row.model, row.tokens) : row.costUsd;
      if (estimate && costUsd === null) markUnpriced(entry, `no list price for ${row.model}`);
      else if (estimate) bookCost(entry, costUsd, 'estimated');
      settleUsage(entry, {
        model: row.model, part: row.part, tokens: row.tokens, costUsd, costBasis: estimate ? (costUsd === null ? 'unpriced' : 'estimated') : 'reported',
        fidelity: row.fidelity || settled?.fidelity, reason: row.reason ?? settled?.reason ?? null, source: row.source || settled?.source,
      });
    }
  }

  // Claude: every SDK message the adapter forwards.
  function claudeMeterOf(entry) {
    const held = metersOf(entry);
    if (!held.claude) {
      const saved = entry.usageState?.claude || null;
      held.claude = createClaudeMeter({ state: saved || undefined });
      // Earlier turns and no snapshot: the first result cannot be differenced, only its main loop is known.
      if (!saved && (entry.turns || []).length) held.claude.expectHistory();
    }
    return held.claude;
  }
  /**
   * A `result` settles the turn's per-model delta of result.modelUsage (main loop, sub-agents,
   * compaction, helper calls). It does not wait for the turn promise: a result that arrives after
   * an abort is still booked. Dollars stay with total_cost_usd (accumulateCost).
   */
  function meterClaude(entry, message) {
    if (!message || (message.type !== 'assistant' && message.type !== 'stream_event' && message.type !== 'result')) return;
    const meter = claudeMeterOf(entry);
    const { settled, pendingChanged } = meter.onEvent(message);
    if (settled) {
      settleClaudeRows(entry, settled.rows, settled);
      usageStateOf(entry).claude = meter.state();
      // At once: a kill inside the debounce would leave the saved snapshot behind the ledger, and
      // the next result would be counted against the older one.
      persist({ force: true });
    }
    if (!settled && !pendingChanged) return;
    // A result ends the estimate and settle() cleared the ledger's; what streams after it (a
    // background sub-agent) is provisional again until the next result, or dropped when none will come.
    if (TERMINAL_STATES.has(entry.state)) meter.clearPending();
    const pending = meter.pending();
    setPendingUsage(entry, pending.tokens, pending.byModel[0]?.model || null);
  }

  // Codex: the rollout files of the run's thread and its sub-agent threads.
  function codexMeterOf(entry) {
    const state = entry.usageState || {};
    if (state.closed) return null;
    const held = metersOf(entry);
    if (held.codex) return held.codex;
    // Without a thread no model call was made.
    const threadId = codexThreadId(entry);
    if (!threadId) return null;
    held.codex = createCodexMeter({
      codexHome: entryCodexHome(entry) || undefined, threadId, sinceMs: Date.parse(entry.startedAt || entry.createdAt) || 0,
      // A response whose prompt is over its model's long-context size is priced whole at the long rates.
      longPromptTokens: (model) => { try { return pricing?.codexPrice?.(model || entry.pricingModel || entry.model)?.long?.size || 0; } catch { return 0; } },
      state: state.codex || undefined, now,
    });
    return held.codex;
  }
  /**
   * Book Codex usage (raw provider keys) at the list price of `model` ('estimated'), or flag it
   * unpriced. `model` is the one the row's rollout recorded; none means the run's own.
   * `reportedCostUsd`: the turn result carried its own charge, already booked by accumulateCost.
   * `long`: see priceCodexUsage. Returns { added, unpriced }.
   */
  function bookCodexUsage(entry, liveState, used, { model = null, part = 'main', tokens, fidelity, reason, source, reportedCostUsd = null, long = null }) {
    let cost = reportedCostUsd;
    let added = 0;
    if (cost === null) {
      cost = priceCodexUsage(entry, used, model, long);
      if (cost !== null) added = bookCost(entry, cost, 'estimated');
    }
    addLegacyUsage(entry, used);
    if (liveState) {
      const prev = liveState.turnUsage || {};
      liveState.turnUsage = { ...prev, ...Object.fromEntries(Object.entries(used).map(([key, value]) => [key, (Number(prev[key]) || 0) + (Number(value) || 0)])) };
      liveState.turnMeteredUsd = (Number(liveState.turnMeteredUsd) || 0) + added;
    }
    settleUsage(entry, {
      model: model || entry.model || null, part, tokens, costUsd: cost,
      costBasis: cost === null ? 'unpriced' : reportedCostUsd === null ? 'estimated' : 'reported', fidelity, reason, source,
    });
    return { added, unpriced: cost === null && usageTokens(used) > 0 };
  }
  /**
   * What is left of a main-thread rollout row once the usage a turn's own report already booked
   * for that thread (state.codexAdvance, see settleCodexTurn) is taken off it, key by key: the row
   * itself when nothing was advanced, null when the advance covers it.
   */
  function afterCodexAdvance(state, used) {
    const advance = state.codexAdvance;
    if (!advance) return used;
    const rest = { ...used };
    for (const key of CODEX_TOTAL_KEYS) {
      const take = Math.min(Number(used[key]) || 0, Number(advance[key]) || 0);
      rest[key] = (Number(used[key]) || 0) - take;
      advance[key] = (Number(advance[key]) || 0) - take;
    }
    if (!CODEX_TOTAL_KEYS.some((key) => advance[key] > 0)) delete state.codexAdvance;
    rest.total_tokens = rest.input_tokens + rest.output_tokens;
    return usageTokens(rest) > 0 ? rest : null;
  }
  /**
   * Read what the rollouts recorded since the last poll: one row per thread and turn, per model
   * response, compaction calls and sub-agent threads included. `discover`: look for new rollout
   * files now (the meter itself looks every 15 s). Returns { rows, added }.
   */
  function pollCodex(entry, liveState = live.get(entry.runId) || null, { discover = false } = {}) {
    const meter = codexMeterOf(entry);
    if (!meter) return { rows: 0, added: 0 };
    let rows = [];
    try { rows = meter.poll({ discover }); } catch (error) { log(entry.runId, 'assistant:meter-error', error?.message || String(error)); return { rows: 0, added: 0 }; }
    if (!rows.length) return { rows: 0, added: 0 };
    const state = usageStateOf(entry);
    let added = 0;
    let unpriced = null;
    for (const row of rows) {
      const main = row.part === 'main';
      const used = main ? afterCodexAdvance(state, row.usage) : row.usage;
      if (!used) continue;
      const booked = bookCodexUsage(entry, liveState, used, {
        model: row.model, part: row.part, tokens: used === row.usage ? row.tokens : codexUsageTokens(used).tokens,
        fidelity: row.fidelity, reason: row.reason, source: row.source, long: row.long ?? null,
      });
      // What the main thread has booked, in the keys its turns report their running total in.
      if (main) state.codexBooked = Object.fromEntries(CODEX_TOTAL_KEYS.map((key) => [key, (Number(state.codexBooked?.[key]) || 0) + (Number(used[key]) || 0)]));
      added += booked.added;
      if (booked.unpriced) unpriced = row.model || entry.pricingModel || entry.model || 'the Codex default model';
    }
    if (unpriced) markUnpriced(entry, `no list price for ${unpriced}`);
    state.codex = meter.state();
    persist();
    return { rows: rows.length, added };
  }
  /**
   * The end of one Codex provider turn, completed or failed: the final poll (new rollout files
   * are looked for at once, so a sub-agent thread born seconds before the end is in this turn),
   * then the check against the turn's own report. turn.completed.usage is the main thread's
   * running total. What it shows above everything booked for that thread (its rollout was not
   * found, or this turn's records are not in it) is booked now, flagged partial, and taken off
   * the records should they turn up later. Records above the report (they include the compaction
   * call) book nothing more. A failed turn reports none, so without a rollout it books nothing.
   */
  function settleCodexTurn(entry, liveState, raw) {
    const state = usageStateOf(entry);
    if (state.closed) return;
    pollCodex(entry, liveState, { discover: true });
    const total = raw?.usage && typeof raw.usage === 'object' ? raw.usage : null;
    if (total) {
      const delta = Object.fromEntries(CODEX_TOTAL_KEYS.map((key) => [key, Math.max(0, (Number(total[key]) || 0) - (Number(state.codexBooked?.[key]) || 0))]));
      // The report is the base from here on: records above it (compaction) must not hide what a
      // later turn's records miss.
      state.codexBooked = Object.fromEntries(CODEX_TOTAL_KEYS.map((key) => [key, Number(total[key]) || 0]));
      if (usageTokens(delta) > 0) {
        delta.total_tokens = delta.input_tokens + delta.output_tokens;
        state.codexAdvance = Object.fromEntries(CODEX_TOTAL_KEYS.map((key) => [key, (Number(state.codexAdvance?.[key]) || 0) + delta[key]]));
        const reported = Number(raw?.costUsd);
        const result = bookCodexUsage(entry, liveState, delta, {
          tokens: codexUsageTokens(delta).tokens, fidelity: 'partial', reason: 'codex-rollout-missing', source: 'codex-turn-usage',
          reportedCostUsd: Number.isFinite(reported) ? reported : null,
        });
        if (result.unpriced) markUnpriced(entry, `no list price for ${entry.pricingModel || entry.model || 'the Codex default model'}`);
      }
    }
    // At once, not debounced: a kill must not leave the saved meter state behind the ledger.
    persist({ force: true });
  }

  // OpenCode: every session of the run's own serve (the root and the `task` tool's child sessions).
  function openCodeMeterOf(entry) {
    const held = metersOf(entry);
    // Its state is not saved with the run: a run does not outlive the process that holds its serve.
    if (!held.opencode) held.opencode = createOpenCodeMeter();
    return held.opencode;
  }
  /** The run's own session id, for a message that names none. */
  function openCodeRoot(entry, liveState) {
    try { return liveState?.inner?.identity?.()?.providerSessionId || entry.providerSessionId || null; } catch { return entry.providerSessionId || null; }
  }
  /**
   * OpenCode reports each assistant message's cost ($) and tokens while the
   * turn runs (message.updated), for the run's session and its child sessions.
   * Tokens go to the meter (live until the turn settles). Cost deltas are booked
   * as they arrive, so a turn that fails or is aborted is still paid for, and
   * the caps are checked at every step instead of only at the turn's end.
   */
  function meterOpenCode(entry, liveState, payload = {}) {
    if (entry.usageState?.closed) return;
    const type = String(payload.eventType || '');
    const ev = payload.event || {};
    const meter = openCodeMeterOf(entry);
    if (/^session[.:](created|updated)$/i.test(type)) { meter.onEvent(type, ev); return; }
    if (!/^message[.:]updated$/i.test(type)) return;
    const found = ev.info || ev.message?.info || ev.properties?.info || null;
    if (!found?.id || found.role !== 'assistant') return;
    const info = found.sessionID ? found : { ...found, sessionID: ev.sessionID || openCodeRoot(entry, liveState) || 'root' };
    if (meter.onEvent('message.updated', { info })) {
      const running = meter.live();
      setPendingUsage(entry, running.tokens, openCodeModel(entry, running));
    }
    bookOpenCodeMessage(entry, liveState, info);
  }
  /** The model an OpenCode row names: the run's, else the one that spent most ("provider/model"). */
  function openCodeModel(entry, sum) {
    const top = sum?.byModel?.[0] || null;
    return entry.model || (top ? [top.provider, top.model].filter(Boolean).join('/') : null);
  }
  /**
   * The price of the model an OpenCode message ran on, with its name: the message's own
   * providerID / modelID (a child session may run another model than the run) from the catalog,
   * the run's for a message that names none. price is null when it is not known; the run
   * model's rate never stands in for another model's.
   */
  function openCodePrice(entry, info) {
    const own = info.modelID ? [info.providerID, info.modelID].filter(Boolean).join('/') : null;
    const runModel = entry.pricingModel || entry.model || null;
    if (!own || (runModel && own.toLowerCase() === String(runModel).toLowerCase())) return { price: entry.modelInfo?.price || null, model: runModel };
    let row = null;
    try { const known = catalog?.peek?.() || null; row = known ? findModel(known, 'opencode', own)?.row || null : null; } catch { row = null; }
    return { price: row?.price || null, model: own };
  }
  /**
   * One assistant message's dollars and legacy usage, by what grew since it was last seen. A
   * finished message with tokens and no cost is a free model, or one OpenCode could not price:
   * it is estimated at its own model's price. The estimate is provisional. When the message
   * reports a cost later (the stored copy at the turn's end), only the difference is booked.
   */
  function bookOpenCodeMessage(entry, liveState, info) {
    // A finished run keeps no message book: what comes late is dropped, not booked from zero.
    if (entry.usageState?.closed) return;
    const book = liveState.meter || (liveState.meter = new Map());
    const key = `${info.sessionID || ''}:${info.id}`;
    const prev = book.get(key) || { cost: 0, usage: null, completed: false, estimate: 0 };
    const reported = Number(info.cost);
    const cost = Number.isFinite(reported) && reported > prev.cost ? reported : prev.cost;
    const used = openCodeUsage(info.tokens) || prev.usage;
    const completed = prev.completed || !!info.time?.completed;
    const usageDelta = used ? Object.fromEntries(Object.entries(used).map(([name, value]) => [name, Math.max(0, value - (Number(prev.usage?.[name]) || 0))])) : null;
    let estimate = Number(prev.estimate) || 0;
    let delta = cost - prev.cost;
    // The reported cost replaces the estimate booked for this message (the difference can be negative).
    if (delta > 0 && estimate > 0) { delta -= estimate; estimate = 0; }
    // Dollars of this turn (the turn record) and of the run's OpenCode messages (the ledger row).
    const paid = (amount) => {
      liveState.turnMeteredUsd = (Number(liveState.turnMeteredUsd) || 0) + amount;
      liveState.openCodeUsd = (Number(liveState.openCodeUsd) || 0) + amount;
    };
    if (delta > 0 || usageTokens(usageDelta) > 0) accumulateCost(entry, { costUsd: delta > 0 ? delta : 0, usage: usageDelta, basis: 'reported' });
    if (delta < 0) entry.costUsd = Number(Math.max(0, (Number(entry.costUsd) || 0) + delta).toFixed(8));
    if (delta) paid(delta);
    if (completed && !prev.completed && !(cost > 0) && usageTokens(used) > 0) {
      const { price, model } = openCodePrice(entry, info);
      if (price?.basis === 'free') entry.costBasis = weakerBasis(entry.costBasis, 'free');
      else if (price && (Number(price.input) > 0 || Number(price.output) > 0)) {
        estimate = Number((((used.input_tokens * price.input) + ((used.output_tokens + used.reasoning_tokens) * price.output)
          + (used.cache_read_input_tokens * (price.cacheRead ?? price.input)) + (used.cache_write_input_tokens * price.input)) / 1e6).toFixed(8));
        accumulateCost(entry, { costUsd: estimate, basis: 'estimated' });
        paid(estimate);
      } else markUnpriced(entry, `OpenCode reported no cost for ${model || 'its default model'} and it has no list price`);
    }
    book.set(key, { cost, usage: used, completed, estimate });
    if (delta > 0 || completed) enforceMidTurn(entry, liveState);
  }
  /**
   * Settle what the meter counted since the last turn: the root session as 'main', the child
   * sessions as 'subagents'. Exact when the serve's stored messages were merged first. Returns the
   * turn's own usage (provider keys), or null when it used nothing.
   */
  function bookOpenCodeTurn(entry, liveState, { reconciled = false } = {}) {
    if (entry.usageState?.closed) return null;
    const meter = openCodeMeterOf(entry);
    const delta = meter.markTurn();
    const fidelity = reconciled ? 'exact' : 'partial';
    const reason = reconciled ? null : 'opencode-not-reconciled';
    const source = reconciled ? 'opencode-messages' : 'opencode-events';
    const model = openCodeModel(entry, delta);
    // The dollars were booked per message as they streamed: the main row carries what was booked
    // since the last settle (reported steps and estimates, child sessions included).
    const usdNow = Number(liveState?.openCodeUsd) || 0;
    const paidUsd = Number((usdNow - (Number(liveState?.openCodeUsdSettled) || 0)).toFixed(8));
    // A net refund (a reported cost below an estimate an earlier row carried) cannot be a row:
    // the mark stays, so the next dollars are booked net of it.
    if (liveState && paidUsd >= 0) liveState.openCodeUsdSettled = usdNow;
    const shared = { model, costBasis: ['none', 'tokens'].includes(entry.costBasis) ? null : entry.costBasis, fidelity, reason, source };
    settleUsage(entry, { ...shared, part: 'main', tokens: delta.main, costUsd: paidUsd > 0 ? paidUsd : null });
    settleUsage(entry, { ...shared, part: 'subagents', tokens: delta.subagents, costUsd: null });
    setPendingUsage(entry, zeroTokens());
    // At once, not debounced: a kill must not leave the saved run behind the ledger.
    persist({ force: true });
    if (totalTokens(delta.tokens) === 0) return null;
    const t = delta.tokens;
    return { input_tokens: t.input, output_tokens: t.output, reasoning_tokens: t.reasoning, cache_read_input_tokens: t.cacheRead, cache_write_input_tokens: t.cacheWrite };
  }
  /** A finished OpenCode turn: merge what the serve stored (a message the stream missed, child sessions), then settle. */
  async function settleOpenCodeTurn(entry, liveState) {
    let fetchers = null;
    try { fetchers = liveState.inner?.usageFetchers?.() || null; } catch { fetchers = null; }
    let reconciled = false;
    if (fetchers && !entry.usageState?.closed) {
      let failed = false;
      const root = openCodeRoot(entry, liveState);
      // One failed read ends the reconcile: the rest fail at once instead of each waiting on a dead
      // serve. An answer that comes after that (or after the time limit below) is not used: the
      // turn was settled without it, and the next turn's reconcile reads the serve again.
      const guarded = (name, after = () => {}) => async (sessionId) => {
        if (failed) throw new Error('OpenCode usage was not reconciled');
        try {
          const rows = await fetchers[name](sessionId);
          if (failed) throw new Error('OpenCode usage was not reconciled');
          after(rows, sessionId);
          return rows;
        } catch (error) { failed = true; throw error; }
      };
      const meter = openCodeMeterOf(entry);
      // A serve that never answers must not hold the run's next turn.
      let timer = null;
      const expired = new Promise((resolveExpired) => {
        timer = setTimeout(() => {
          failed = true;
          log(entry.runId, 'assistant:meter-error', 'OpenCode usage reconcile timed out');
          resolveExpired();
        }, Math.max(1, Number(limits.usageReconcileMs) || 10_000));
        timer.unref?.();
      });
      try {
        await Promise.race([expired, meter.reconcile({
          children: guarded('children'),
          // A stored message the stream never delivered is paid for like any other.
          messages: guarded('messages', (rows, sessionId) => {
            for (const item of Array.isArray(rows) ? rows : []) {
              const info = item?.info || item;
              if (info?.id && info.role === 'assistant') bookOpenCodeMessage(entry, liveState, info.sessionID ? info : { ...info, sessionID: sessionId || root || 'root' });
            }
          }),
        })]);
        reconciled = !failed;
      } catch (error) { log(entry.runId, 'assistant:meter-error', error?.message || String(error)); }
      clearTimeout(timer);
    }
    return bookOpenCodeTurn(entry, liveState, { reconciled });
  }
  /** The run ended: last rows in, nothing provisional left, and only what a late Claude result needs is kept. */
  function finishUsage(entry, liveState) {
    stopUsagePolling(liveState);
    if (liveState) liveState.turnOpen = false;
    if (entry.provider === 'codex') settleCodexTurn(entry, liveState, null);
    else if (entry.provider === 'opencode' && meters.get(entry.runId)?.opencode) bookOpenCodeTurn(entry, liveState, { reconciled: false });
    // Settled: the per-message book (one snapshot per message of the run) is not needed again.
    if (liveState?.meter) liveState.meter = null;
    // A Claude call the stream showed and no result counted (the run was stopped mid-turn, or a
    // background sub-agent reported after the last result) was still spent: no further turn will
    // settle it, so it is booked as an estimate. A result that arrives late takes it off its delta.
    const claude = meters.get(entry.runId)?.claude;
    if (claude) {
      const rows = typeof claude.settlePending === 'function' ? claude.settlePending({ reason: 'no-result' }) : (claude.clearPending(), []);
      if (rows.length) { settleClaudeRows(entry, rows); usageStateOf(entry).claude = claude.state(); }
    }
    if (ledger && entry.assistantSessionId) { try { ledger.clearPending(entry.assistantSessionId, entry.runId); } catch {} }
    closeUsageState(entry);
    const held = meters.get(entry.runId);
    if (held) { held.codex = null; held.opencode = null; }
  }
  /** Caps checked between provider steps: the run stops as soon as it is out of money. */
  function enforceMidTurn(entry, liveState) {
    if (TERMINAL_STATES.has(entry.state) || liveState.budgetStopping) return;
    refreshLimits();
    const block = budgetBlock(entry);
    if (block) {
      liveState.budgetStopping = true;
      entry.completionReason = block.reason;
      entry.notes.push(`stopped mid-turn: ${block.message}`);
      safeRuntime()?.stop?.(entry.runId, block.reason).catch(() => {});
    }
    checkSession(entry.assistantSessionId, { source: entry });
  }

  // ── run ↔ memory ───────────────────────────────────────────────────────────
  /**
   * A memory whose source_ref is the run id covers the run: the worker's own
   * (its task prompt asks for it), the brain's, or the auto memory. Without
   * this lookup a run whose worker remembered read memoryStored:false for
   * good, and the brain got memory_due for work that was already stored.
   */
  function syncMemory(entry, { announce = false } = {}) {
    if (!entry || entry.memoryStored) return !!entry?.memoryStored;
    if (typeof memory?.memoryForRun !== 'function') return false;
    let memoryId = null;
    try { memoryId = memory.memoryForRun(entry.runId) || null; } catch { memoryId = null; }
    if (!memoryId) return false;
    entry.memoryId = String(memoryId);
    entry.memoryStored = true;
    if (announce) emit(entry, 'memory_stored', { memoryId: entry.memoryId });
    else persist();
    return true;
  }

  // ── follow-ups / lifecycle controls ────────────────────────────────────────
  function requireEntry(runId) {
    const entry = entries.get(runId);
    if (!entry) throw new DispatchError('RUN_NOT_FOUND', `Unknown run ${runId}`, { status: 404 });
    return entry;
  }
  function sendTurn(runId, text, { origin = 'assistant', queue: allowQueue = true } = {}) {
    const entry = requireEntry(runId);
    const message = String(text || '').trim();
    if (!message) throw new DispatchError('MESSAGE_REQUIRED', 'text is required');
    if (message.length > 20_000) throw new DispatchError('MESSAGE_TOO_LONG', 'text must be at most 20000 characters');
    if (TERMINAL_STATES.has(entry.state)) throw new DispatchError('RUN_NOT_ACTIVE', `Run ${runId} is ${entry.state}; dispatch a new run with the previous result as context.`, { status: 409, resumable: false });
    if (entry.state === 'queued') throw new DispatchError('RUN_NOT_STARTED', `Run ${runId} is still queued`, { status: 409 });
    const liveState = live.get(runId);
    if (!liveState) throw new DispatchError('RUN_NOT_ACTIVE', `Run ${runId} has no live worker`, { status: 409 });
    if (liveState.turnCounter >= entry.maxTurns) throw new DispatchError('MAX_TURNS', `Run ${runId} reached its max turns (${entry.maxTurns})`, { status: 409 });
    refreshLimits();
    const blocked = budgetBlock(entry);
    if (blocked) {
      throw new DispatchError(blocked.code, `Run ${runId} cannot take a follow-up: ${blocked.message}. ${blocked.reason === 'budget_cap' ? 'Dispatch a new run with its result as context.' : 'Ask the user to raise the cap (Assistant → Budget).'}`, { status: 409, ...blocked.detail });
    }
    // A follow-up works for the task in progress when it is sent, which may be a later one than the run's.
    const item = { kind: 'follow-up', text: message, origin, at: iso(now()), taskId: taskNow(entry.assistantSessionId) || entry.taskId || null };
    if (origin === 'user') emit(entry, 'user_intervened', { text: clip(message, 200) });
    if (liveState.waitResolve) { liveState.waitResolve(item); return { ok: true, queued: false, turn: liveState.turnCounter + 1, run: view(entry) }; }
    if (!allowQueue) throw new DispatchError('TURN_ACTIVE', `Run ${runId} is busy; retry when idle or pass queue:true`, { status: 409 });
    liveState.followUps.push(item);
    emit(entry, 'follow_up_queued', { queued: liveState.followUps.length });
    return { ok: true, queued: true, position: liveState.followUps.length, run: view(entry) };
  }
  function complete(runId) {
    const entry = requireEntry(runId);
    const liveState = live.get(runId);
    if (TERMINAL_STATES.has(entry.state)) return { ok: true, run: view(entry) };
    if (liveState?.waitResolve) { liveState.waitResolve({ kind: 'complete' }); return { ok: true, run: view(entry) }; }
    return stop(runId, 'complete');
  }
  async function stop(runId, reason = 'assistant') {
    const entry = requireEntry(runId);
    if (WAITING_STATES.has(entry.state)) {
      const held = entry.state === 'awaiting_route';
      const index = queue.indexOf(runId);
      if (index !== -1) queue.splice(index, 1);
      entry.state = 'stopped'; entry.completionReason = reason; entry.finishedAt = iso(now()); entry.turnState = 'terminal';
      delete entry.rawSpec;
      if (held) { try { router?.cancelForRun?.(runId, 'run_stopped'); } catch {} }
      emit(entry, 'stopped');
      return { ok: true, run: view(entry) };
    }
    if (TERMINAL_STATES.has(entry.state)) return { ok: true, run: view(entry), alreadyTerminal: true };
    entry.completionReason = entry.completionReason || reason;
    const runtime = safeRuntime();
    const stopped = runtime ? await runtime.stop(runId, reason) : false;
    if (!stopped) finalize(entry, { status: 'stopped', stoppedReason: reason });
    return { ok: true, run: view(entry) };
  }
  async function killAll({ assistantSessionId = null, workflowId = null, reason = 'kill_all' } = {}) {
    const targets = [...entries.values()].filter((entry) => ACTIVE_STATES.has(entry.state)
      && (!assistantSessionId || entry.assistantSessionId === assistantSessionId)
      && (!workflowId || entry.workflowId === workflowId));
    const stopped = [];
    for (const entry of targets) { try { await stop(entry.runId, reason); stopped.push(entry.runId); } catch {} }
    return { ok: true, stopped };
  }

  // ── runtime feed → registry ────────────────────────────────────────────────
  function finalize(entry, runtimeRun) {
    if (TERMINAL_STATES.has(entry.state)) return;
    const status = runtimeRun?.status || 'completed';
    entry.state = TERMINAL_STATES.has(status) ? status : 'completed';
    entry.turnState = 'terminal';
    entry.finishedAt = iso(now());
    entry.completionReason = entry.completionReason || runtimeRun?.stoppedReason || (status === 'completed' ? 'complete' : status);
    if (runtimeRun?.error) entry.error = runtimeRun.error;
    const liveState = live.get(entry.runId);
    try { finishUsage(entry, liveState || null); } catch (error) { log(entry.runId, 'assistant:meter-error', error?.message || String(error)); }
    if (liveState) {
      liveState.dead = true;
      if (liveState.idleTimer) clearTimeout(liveState.idleTimer);
      if (liveState.waitResolve) liveState.waitResolve({ kind: 'abort' });
      for (const requestId of [...liveState.pendingResolvers.keys()]) finishPending(entry.runId, requestId, { behavior: 'deny', message: 'Run ended.', resolvedBy: 'run_ended' });
    }
    entry.pending = [];
    releaseDesktop(entry);
    if (entry.state === 'failed' && entry.completionReason !== 'budget_cap' && judge?.workerOutcome) {
      // State, queue and desktop move on now; the 'failed' event waits for its cause.
      emitFailed(entry, liveState?.evidence || null);
      processQueue().catch(() => {});
      return;
    }
    if (entry.state === 'failed' || entry.lastResult?.status === 'blocked') entry.escalation = computeEscalation(entry);
    emit(entry, entry.state);
    // A memory already stored for the run (by the worker or the brain) is the run's memory.
    if (memory?.rememberDispatch && !syncMemory(entry, { announce: true }) && (entry.state === 'completed' || (entry.state === 'stopped' && entry.lastResult))) {
      Promise.resolve(memory.rememberDispatch(view(entry))).then((memoryId) => {
        if (!memoryId) return;
        entry.memoryId = memoryId;
        entry.memoryStored = true;
        emit(entry, 'memory_stored', { memoryId });
      }).catch(() => {});
    }
    processQueue().catch(() => {});
  }
  function onRuntimeMessage(message) {
    const runId = message?.run?.runId;
    if (!runId || !entries.has(runId)) return;
    const entry = entries.get(runId);
    if (message.type === 'sidepanel:provider-event') {
      const liveState = live.get(runId);
      // Not tied to the live turn: a result that arrives after an abort is still settled.
      if (entry.provider === 'claude-code') { try { meterClaude(entry, message.event?.event); } catch (error) { log(runId, 'assistant:meter-error', error?.message || String(error)); } }
      if (liveState) {
        liveState.lastEventAt = now();
        liveState.stalledFlagged = false;
        if (liveState.evidence) { try { recordProviderEvent(liveState.evidence, message.event); } catch {} }
        if (entry.provider === 'opencode') { try { meterOpenCode(entry, liveState, message.event || {}); } catch (error) { log(runId, 'assistant:meter-error', error?.message || String(error)); } }
        const summary = summarizeProviderEvent(message.event || {});
        if (summary) {
          const line = `${iso(now()).slice(11, 19)} ${summary}`;
          liveState.ring.push(line);
          liveState.ringChars += line.length;
          while (liveState.ring.length > limits.ringSize || liveState.ringChars > limits.ringChars) {
            const removed = liveState.ring.shift();
            liveState.ringChars -= removed?.length || 0;
          }
        }
      }
      return;
    }
    const run = message.run;
    entry.runtime = { status: run.status, turnState: run.turnState, stoppedReason: run.stoppedReason, error: run.error, claimedBy: run.claimedBy, providerSessionId: run.providerSessionId, providerThreadId: run.providerThreadId };
    if (run.providerSessionId) entry.providerSessionId = run.providerSessionId;
    if (run.providerThreadId) entry.providerThreadId = run.providerThreadId;
    if (message.type === 'sidepanel:run-updated' && message.reason === 'started' && entry.state === 'starting') {
      entry.state = 'running';
      entry.turnState = 'running';
      emit(entry, 'running');
      return;
    }
    if (['sidepanel:run-completed', 'sidepanel:run-failed', 'sidepanel:run-stopped'].includes(message.type) || TERMINAL_STATES.has(run.status)) {
      finalize(entry, run);
    }
  }
  function attachRuntime() {
    const runtime = safeRuntime();
    if (!runtime?.subscribe || unsubscribeRuntime) return;
    unsubscribeRuntime = runtime.subscribe(onRuntimeMessage);
  }

  // ── queue + stalled watchdog ───────────────────────────────────────────────
  async function processQueue() {
    refreshLimits();
    for (const runId of [...queue]) {
      const entry = entries.get(runId);
      if (!entry || entry.state !== 'queued') { queue.splice(queue.indexOf(runId), 1); continue; }
      const spec = { provider: entry.provider, accountId: entry.accountId, workflowId: entry.workflowId, usesComputer: !!entry.usesComputer };
      if (railBlock(spec, entry.assistantSessionId)) continue;
      queue.splice(queue.indexOf(runId), 1);
      try { await start(entry); emit(entry, 'queue_started'); } catch (error) { entry.notes.push(`queue start failed: ${error?.message || error}`); }
    }
  }
  function checkStalled() {
    for (const [runId, liveState] of live) {
      const entry = entries.get(runId);
      if (!entry || entry.state !== 'running' || liveState.stalledFlagged) continue;
      if (now() - liveState.lastEventAt > limits.stalledAfterMs) {
        liveState.stalledFlagged = true;
        entry.notes.push(`stalled: no provider events for ${Math.round((now() - liveState.lastEventAt) / 60000)} min`);
        emit(entry, 'stalled', { sinceMs: now() - liveState.lastEventAt });
      }
    }
  }

  // ── queries ────────────────────────────────────────────────────────────────
  function get(runId) {
    const entry = entries.get(runId) || null;
    // agent_status reads here: a remember made since the run's last event counts.
    if (entry && !entry.memoryStored && (entry.lastResult || TERMINAL_STATES.has(entry.state))) syncMemory(entry);
    return view(entry);
  }
  function list({ activeOnly = false, assistantSessionId = null, workflowId = null, status = null, limit = 100, includeRemoved = false } = {}) {
    return [...entries.values()]
      .filter((entry) => (includeRemoved || !entry.removedAt)
        && (!activeOnly || ACTIVE_STATES.has(entry.state))
        && (!assistantSessionId || entry.assistantSessionId === assistantSessionId)
        && (!workflowId || entry.workflowId === workflowId)
        && (!status || status === 'all' || (status === 'active' ? ACTIVE_STATES.has(entry.state) : status === 'terminal' ? TERMINAL_STATES.has(entry.state) : entry.state === status)))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
      .map((entry) => view(entry));
  }
  function totals({ assistantSessionId = null, workflowId = null } = {}) {
    const rows = [...entries.values()].filter((entry) => (!assistantSessionId || entry.assistantSessionId === assistantSessionId) && (!workflowId || entry.workflowId === workflowId));
    // tokens: the five classes plus total, from the runs' ledger views (a run without one counts its legacy input / output).
    const out = { active: 0, queued: 0, awaitingRoute: 0, completed: 0, failed: 0, stopped: 0, interrupted: 0, costUsd: 0, tokens: withTotal(zeroTokens()) };
    for (const entry of rows) {
      // A removed run leaves the counts but keeps its spend and its tokens: both were spent.
      if (!entry.removedAt) {
        if (entry.state === 'queued') out.queued += 1;
        else if (entry.state === 'awaiting_route') out.awaitingRoute += 1;
        else if (ACTIVE_STATES.has(entry.state)) out.active += 1;
        else if (out[entry.state] !== undefined) out[entry.state] += 1;
      }
      out.costUsd += Number(entry.costUsd) || 0;
      const used = tokensView(entry);
      if (used) { for (const key of [...TOKEN_KEYS, 'total', 'inputTotal', 'outputTotal']) out.tokens[key] += used[key]; continue; }
      const input = Number(entry.usage?.input_tokens) || 0;
      const output = Number(entry.usage?.output_tokens) || 0;
      out.tokens.input += input;
      out.tokens.output += output;
      out.tokens.inputTotal += input;
      out.tokens.outputTotal += output;
      out.tokens.total += input + output;
    }
    out.costUsd = Number(out.costUsd.toFixed(4));
    if (assistantSessionId) out.budget = sessionBudget(assistantSessionId);
    out.queue = queue.map((runId, index) => ({ runId, position: index + 1, title: entries.get(runId)?.title || null, provider: entries.get(runId)?.provider || null }));
    return out;
  }
  function transcript(runId, { format = 'result', tail = 40, maxChars = 4000 } = {}) {
    const entry = requireEntry(runId);
    const liveState = live.get(runId);
    const cap = Math.max(200, Math.min(20_000, Number(maxChars) || 4000));
    const base = { runId, state: entry.state, turnState: entry.turnState, outcome: entry.lastResult?.status || null, turns: (entry.turns || []).length };
    if (format === 'result') return { ...base, result: entry.lastResult, turnsSummary: (entry.turns || []).map((turn) => ({ n: turn.n, origin: turn.origin, status: turn.result?.status || null, summary: clip(turn.result?.summary, 200), costUsd: turn.costUsd })) };
    if (format === 'text') {
      const text = String(entry.lastText || '');
      return { ...base, text: text.length > cap ? text.slice(-cap) : text, truncated: text.length > cap };
    }
    if (format === 'files') return { ...base, files: entry.lastResult?.files || [] };
    if (format === 'events' || format === 'tail') {
      const lines = liveState ? liveState.ring.slice(-Math.max(1, Math.min(500, Number(tail) || 40))) : [];
      const joined = lines.join('\n');
      return { ...base, tail: lines, text: joined.length > cap ? joined.slice(-cap) : joined, truncated: joined.length > cap, unavailable: !liveState ? 'transcript buffer is only kept for live runs' : null };
    }
    throw new DispatchError('INVALID_FORMAT', `Unknown transcript format ${format}`);
  }
  function pendingPermissions(runId) { return [...(requireEntry(runId).pending || [])]; }

  async function wait({ runId = null, runIds = null, workflowId = null, assistantSessionId = null, until = 'idle', mode = 'all', timeoutMs = 30_000 } = {}) {
    let ids = Array.isArray(runIds) ? [...runIds] : runId ? [runId] : [];
    if (workflowId) ids = [...new Set([...ids, ...[...entries.values()].filter((e) => e.workflowId === workflowId && (!assistantSessionId || e.assistantSessionId === assistantSessionId)).map((e) => e.runId)])];
    ids = ids.slice(0, 20);
    if (!ids.length) throw new DispatchError('RUN_IDS_REQUIRED', 'runId, runIds or workflowId is required');
    for (const id of ids) requireEntry(id);
    const started = now();
    const budget = Math.max(1000, Math.min(limits.waitCapMs, Number(timeoutMs) || 30_000));
    const baseline = new Map(ids.map((id) => [id, Number(entries.get(id)?.version) || 0]));
    const check = () => {
      const satisfied = ids.filter((id) => satisfies(entries.get(id), until, baseline.get(id)));
      return mode === 'any' ? satisfied.length > 0 : satisfied.length === ids.length;
    };
    if (!check()) {
      await new Promise((resolveWait) => {
        const waiter = { check, resolve: () => { clearTimeout(timer); resolveWait(); } };
        const timer = setTimeout(() => { waiters.delete(waiter); resolveWait(); }, budget);
        timer.unref?.();
        waiters.add(waiter);
      });
    }
    const done = ids.filter((id) => satisfies(entries.get(id), until, baseline.get(id)));
    const pendingIds = ids.filter((id) => !done.includes(id));
    const timedOut = !check();
    return {
      ok: true, timedOut, waitedMs: now() - started, until, mode,
      done: done.map((id) => view(entries.get(id))),
      pending: pendingIds.map((id) => view(entries.get(id))),
      needsInput: ids.map((id) => entries.get(id)).filter((e) => e?.lastResult?.status === 'needs_input' && e.state === 'idle').map((e) => ({ runId: e.runId, question: e.lastResult.question })),
      permissions: ids.flatMap((id) => (entries.get(id)?.pending || []).map((request) => ({ runId: id, ...request }))),
    };
  }

  // ── removal (the user clears finished runs from the agents tray) ──────────
  /**
   * A removed run leaves lists and trays but stays in the registry until
   * retention drops it: its spend still counts against the session caps, and a
   * brain holding its id can still read it. Only finished runs qualify — a
   * failed run whose cause is still being judged is not finished yet.
   */
  function removable(entry) { return TERMINAL_STATES.has(entry.state) && !entry.judging; }
  function finishedIdle(entry) {
    return entry.state === 'idle' && !entry.judging
      && ['done', 'blocked'].includes(entry.lastResult?.status)
      && !(live.get(entry.runId)?.followUps?.length);
  }
  async function finishIdleForRemoval(entry) {
    if (!finishedIdle(entry)) return;
    await complete(entry.runId);
    await wait({ runId: entry.runId, until: 'terminal', timeoutMs: 5_000 });
  }
  function announceRemoved(removedEntries) {
    const bySession = new Map();
    for (const entry of removedEntries) {
      const key = entry.assistantSessionId || null;
      bySession.set(key, [...(bySession.get(key) || []), entry.runId]);
    }
    for (const [assistantSessionId, runIds] of bySession) {
      const payload = { type: 'assistant:run-removed', assistantSessionId, runIds };
      try { broadcastSync(payload); } catch {}
      for (const listener of listeners) { try { listener(payload); } catch {} }
    }
  }
  function markRemoved(targets) {
    const at = iso(now());
    for (const entry of targets) { entry.removedAt = at; live.delete(entry.runId); meters.delete(entry.runId); }
    if (targets.length) { persist({ force: true }); announceRemoved(targets); }
    return targets.map((entry) => entry.runId);
  }
  async function remove(runId, { assistantSessionId = null } = {}) {
    const entry = requireEntry(runId);
    if (assistantSessionId && String(assistantSessionId) !== String(entry.assistantSessionId || '')) {
      throw new DispatchError('RUN_NOT_IN_SESSION', `Run ${runId} belongs to another assistant session`, { status: 403 });
    }
    if (entry.removedAt) return { ok: true, removed: [], alreadyRemoved: true };
    await finishIdleForRemoval(entry);
    if (!removable(entry)) {
      throw new DispatchError('RUN_ACTIVE', `Run ${runId} is ${entry.judging ? 'still finishing' : entry.state}; stop it before removing it.`, { status: 409, state: entry.state });
    }
    return { ok: true, removed: markRemoved([entry]) };
  }
  async function removeFinished({ assistantSessionId = null, workflowId = null, runIds = null } = {}) {
    const wanted = Array.isArray(runIds) ? new Set(runIds.map(String)) : null;
    const scoped = [...entries.values()].filter((entry) => !entry.removedAt
      && (!assistantSessionId || entry.assistantSessionId === String(assistantSessionId))
      && (!workflowId || entry.workflowId === String(workflowId))
      && (!wanted || wanted.has(entry.runId)));
    await Promise.all(scoped.filter(finishedIdle).map((entry) => finishIdleForRemoval(entry).catch(() => {})));
    const targets = scoped.filter(removable);
    return { ok: true, removed: markRemoved(targets), skipped: scoped.filter((entry) => !removable(entry)).map((entry) => entry.runId) };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('subscribe requires a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  async function shutdown(reason = 'server_shutdown') {
    if (stalledTimer) clearInterval(stalledTimer);
    if (unsubscribeRuntime) { try { unsubscribeRuntime(); } catch {} unsubscribeRuntime = null; }
    for (const entry of entries.values()) {
      if (ACTIVE_STATES.has(entry.state)) {
        entry.state = 'interrupted'; entry.completionReason = reason; entry.finishedAt = iso(now()); entry.turnState = 'terminal'; entry.pending = [];
        delete entry.rawSpec;
        // What the run's meter can still read is booked now; nothing provisional outlives the process.
        try { finishUsage(entry, live.get(entry.runId) || null); } catch {}
        releaseDesktop(entry);
      }
    }
    persist({ force: true });
  }

  loadRegistry();
  attachRuntime();
  stalledTimer = setInterval(() => { attachRuntime(); checkStalled(); }, 60_000);
  stalledTimer.unref?.();

  return {
    dispatch, sendTurn, complete, stop, killAll, get, peek, list, totals, wait, transcript, pendingPermissions,
    respondPermission, subscribe, shutdown, limits,
    sessionBudget, checkSession, refreshLimits,
    resolveRoute, declineRoute, heldRouteRefusal, escalate,
    markDelivered, deliveryState,
    remove, removeFinished,
    mediaFile,
    accountInUse: (provider, accountId) => activeEntries((e) => e.provider === provider && e.accountId === accountId).length > 0,
    _internals: { entries, live, queue, processQueue, attachRuntime, registryPath },
  };
}
