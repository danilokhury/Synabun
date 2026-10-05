// ═══════════════════════════════════════════
// SynaBun Assistant — tab state + pure helpers
// ═══════════════════════════════════════════
// DOM-free on purpose: this module is imported by node:test suites. Storage
// access is injected by the panel (it passes `storage` in), so nothing here
// touches window/document/localStorage at import time.

import { KEYS } from '../constants.js';
import { isNewerRunDescriptor } from '../ui-native-loop-router-state.js';
import { modelEffortIds } from '../agent-runtime-options.js';
import { usagePacketIsStale } from './asst-usage.js';

export const PROVIDERS = ['claude-code', 'codex', 'opencode'];

export const PROVIDER_ALIASES = {
  'claude-code': 'claude-code',
  claude: 'claude-code',
  cc: 'claude-code',
  anthropic: 'claude-code',
  codex: 'codex',
  cx: 'codex',
  openai: 'codex',
  opencode: 'opencode',
  oc: 'opencode',
};

export const PROVIDER_SHORT_LABELS = {
  'claude-code': 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

// Providers whose brain carries an account profile picker.
export const ACCOUNT_PROVIDERS = new Set(['claude-code', 'codex']);

// Approval modes are sent as `permissionMode` (`set_permission_mode {mode}` /
// `query.permissionMode`). Claude uses the SDK enum; Codex/OpenCode brains only
// distinguish "ask me" from "auto-approve". Plan mode is a separate flag
// (`planMode`) that combines with any approval mode, each provider in its own
// way: Claude runs the SDK 'plan' mode and returns to the approval mode once
// the plan is approved; Codex runs its native plan collaboration mode (read-only
// sandbox); OpenCode runs its own `plan` agent.
export const PERMISSION_MODES = {
  'claude-code': [
    { id: 'default', label: 'Default' },
    { id: 'acceptEdits', label: 'Accept Edits' },
    { id: 'bypassPermissions', label: 'Bypass' },
  ],
  codex: [
    { id: 'default', label: 'Default' },
    { id: 'auto', label: 'Auto-accept' },
  ],
  opencode: [
    { id: 'default', label: 'Default' },
    { id: 'auto', label: 'Auto-accept' },
  ],
};

export const PLAN_MODE_PROVIDERS = new Set(['claude-code', 'codex', 'opencode']);

export const DEFAULT_BRAIN = Object.freeze({
  provider: 'claude-code',
  model: '',
  effort: null,
  agent: null,
  project: null,
  mcpProfile: '',
  accountId: null,
  permissionMode: 'default',
  planMode: false,
});

export const RUN_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
export const RUN_ACTIVE_STATUSES = new Set(['queued', 'starting', 'running']);

// ── Providers / brains ──────────────────────────────────────────────────────

export function normalizeProvider(value, fallback = null) {
  const key = String(value || '').trim().toLowerCase();
  return PROVIDER_ALIASES[key] || fallback;
}

export function providerShortLabel(provider) {
  return PROVIDER_SHORT_LABELS[provider] || String(provider || '');
}

function str(value) {
  if (value == null) return '';
  return String(value).trim();
}

/** Coerce anything (storage JSON, server session metadata) into a brain object. */
export function normalizeBrain(raw, fallback = DEFAULT_BRAIN) {
  const base = { ...DEFAULT_BRAIN, ...(fallback || {}) };
  const src = raw && typeof raw === 'object' ? raw : {};
  const provider = normalizeProvider(src.provider ?? src.brain, base.provider) || 'claude-code';
  const modes = PERMISSION_MODES[provider] || PERMISSION_MODES['claude-code'];
  const rawMode = str(src.permissionMode);
  // 'plan' used to be one of Claude's permission modes: it is the plan flag now.
  const legacyPlan = rawMode === 'plan';
  const mode = legacyPlan ? 'default' : rawMode;
  return {
    provider,
    model: str(src.model),
    effort: str(src.effort) || null,
    agent: provider === 'opencode' ? (str(src.agent) || null) : null,
    project: str(src.project ?? src.cwd) || null,
    mcpProfile: str(src.mcpProfile),
    accountId: ACCOUNT_PROVIDERS.has(provider) ? (str(src.accountId) || null) : null,
    permissionMode: modes.some(m => m.id === mode) ? mode : 'default',
    planMode: PLAN_MODE_PROVIDERS.has(provider) && (src.planMode === true || legacyPlan),
  };
}

/**
 * A `mode_changed` report from a brain → the brain fields it changes. 'plan'
 * turns plan mode on; for Claude any other mode means the SDK left plan mode
 * (the plan was approved), while Codex/OpenCode report their approval mode and
 * say whether plan mode is on with `planMode`.
 */
export function brainModePatch(brain, mode, planMode) {
  const b = normalizeBrain(brain);
  const value = str(mode);
  const patch = {};
  const modes = PERMISSION_MODES[b.provider] || PERMISSION_MODES['claude-code'];
  if (value === 'plan') patch.planMode = true;
  else if (modes.some(m => m.id === value)) {
    patch.permissionMode = value;
    if (b.provider === 'claude-code') patch.planMode = false;
  }
  if (planMode === true || planMode === false) patch.planMode = planMode;
  if (patch.planMode !== undefined && !PLAN_MODE_PROVIDERS.has(b.provider)) delete patch.planMode;
  return patch;
}

function pickDefault(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.find(m => m?.tier === 'default' || m?.isDefault === true) || list[0];
}

/**
 * Fill in missing or invalid brain fields from a catalog snapshot.
 * catalog: {
 *   models: { [provider]: [{ id, tier?, effortLevels?, isDefault? }] },
 *   efforts: { [provider]: [{ id, tier? }] },
 *   accounts: { [provider]: [{ id, label }] },
 *   agents: [{ name, mode? }],                 // OpenCode
 *   mcpProfiles: { [id]: { label } }, defaultMcpProfile,
 *   projects: [{ path, label }],
 * }
 */
export function resolveBrainDefaults(brain, catalog = {}) {
  const b = normalizeBrain(brain);
  const models = catalog.models?.[b.provider] || [];
  if (models.length && !models.some(m => m?.id === b.model || m?.selector === b.model)) {
    b.model = pickDefault(models)?.id || b.model || '';
  }

  // Efforts are per model: the model row's own levels when it lists them, else
  // the list the caller computed for this model (catalog.efforts). An effort the
  // model does not run falls back to its default, else auto (null). OpenCode
  // efforts are the model's variants.
  const effortSource = Array.isArray(catalog.efforts?.[b.provider]) ? catalog.efforts[b.provider] : null;
  const row = models.find(m => m?.id === b.model || m?.selector === b.model) || null;
  const ids = modelEffortIds(row)
    ?? (effortSource ? effortSource.map(e => (typeof e === 'string' ? e : e?.id)).filter(id => id && id !== 'off') : null);
  if (ids) {
    if (!ids.length) b.effort = null;
    else if (b.effort && !ids.includes(b.effort)) {
      const fallback = row?.defaultEffort || row?.defaultReasoningEffort || pickDefault(effortSource)?.id || null;
      b.effort = fallback && ids.includes(fallback) ? fallback : null;
    }
  }
  if (b.provider === 'opencode') {
    const agents = Array.isArray(catalog.agents) ? catalog.agents : [];
    if (agents.length && !agents.some(a => (a?.name || a?.id) === b.agent)) {
      const primary = agents.find(a => a?.mode === 'primary' || a?.mode === 'all') || agents[0];
      b.agent = primary?.name || primary?.id || null;
    }
  }

  if (ACCOUNT_PROVIDERS.has(b.provider)) {
    const accounts = catalog.accounts?.[b.provider] || [];
    if (!b.accountId || (accounts.length && !accounts.some(a => a?.id === b.accountId))) {
      b.accountId = accounts.find(a => a?.isDefault)?.id || accounts[0]?.id || 'default';
    }
  } else {
    b.accountId = null;
  }

  const profiles = catalog.mcpProfiles && typeof catalog.mcpProfiles === 'object' ? catalog.mcpProfiles : null;
  if (profiles) {
    const ids = Object.keys(profiles);
    if (ids.length && !ids.includes(b.mcpProfile)) {
      b.mcpProfile = ids.includes(catalog.defaultMcpProfile) ? catalog.defaultMcpProfile : (ids.includes('full') ? 'full' : ids[0]);
    }
  } else if (!b.mcpProfile && catalog.defaultMcpProfile) {
    b.mcpProfile = catalog.defaultMcpProfile;
  }

  if (!b.project && Array.isArray(catalog.projects) && catalog.projects.length === 1) {
    b.project = catalog.projects[0]?.path || null;
  }
  return b;
}

/** "Plan, then Bypass", "Auto-accept", "Default" — the mode chip (a sentence, never a dot-joined pair). `label(id, fallback)` translates. */
export function permissionModeLabel(brain, label = (_id, fallback) => fallback) {
  const b = normalizeBrain(brain);
  const modes = PERMISSION_MODES[b.provider] || PERMISSION_MODES['claude-code'];
  const mode = modes.find(m => m.id === b.permissionMode) || modes[0];
  const approval = label(mode.id, mode.label);
  if (!b.planMode) return approval;
  if (mode.id === 'default') return label('plan', 'Plan');
  return String(label('planThen', 'Plan, then {mode}')).replace('{mode}', approval);
}

/** Short human label: "Claude · sonnet · high". */
export function brainLabel(brain) {
  const b = normalizeBrain(brain);
  const parts = [providerShortLabel(b.provider)];
  if (b.model) parts.push(modelShortName(b.model));
  if (b.provider === 'opencode' ? b.agent : b.effort) parts.push(b.provider === 'opencode' ? b.agent : b.effort);
  return parts.join(' · ');
}

export function modelShortName(model) {
  const id = str(model);
  if (!id) return '';
  const tail = id.includes('/') ? id.split('/').pop() : id;
  return tail.replace(/:\d+$/, '');
}

/** Does switching from `a` to `b` require a fresh server session (switch_brain)? */
export function brainRequiresSwitch(a, b) {
  const x = normalizeBrain(a);
  const y = normalizeBrain(b);
  return x.provider !== y.provider || x.accountId !== y.accountId || x.mcpProfile !== y.mcpProfile;
}

// ── Runs ────────────────────────────────────────────────────────────────────

export function isTerminalRunStatus(status) {
  return RUN_TERMINAL_STATUSES.has(String(status || ''));
}

// Dispatcher views carry `state` (queued, awaiting_route, starting, running,
// idle, awaiting_permission, completed, failed, stopped, interrupted); runtime
// descriptors (sidepanel:run-*) carry `status`. The tray reads `status`.
const STATE_STATUS = { queued: 'queued', awaiting_route: 'queued', starting: 'starting', running: 'running', idle: 'running', awaiting_permission: 'running' };

export function runStatusFromState(state) {
  const value = str(state);
  if (RUN_TERMINAL_STATUSES.has(value)) return value;
  return STATE_STATUS[value] || null;
}

/** 'dispatch' (assistant dispatcher view), 'runtime' (native loop descriptor) or null. */
export function runFeed(run) {
  if (!run || typeof run !== 'object') return null;
  if (typeof run.state === 'string' && run.state) return 'dispatch';
  if (run.runtimeType === 'native' || run.surface === 'sidepanel') return 'runtime';
  return null;
}

/** A dispatcher view's `status` always follows its `state` (older servers sent none). */
export function normalizeRunDescriptor(run) {
  if (!run || typeof run !== 'object') return null;
  if (runFeed(run) !== 'dispatch') return run;
  const status = runStatusFromState(run.state);
  const out = status ? { ...run, status } : { ...run };
  if (!out.completedAt && out.finishedAt) out.completedAt = out.finishedAt;
  return out;
}

/** A warm worker waiting between turns: its task turn is done, the run is not. */
export function isRunIdle(run) {
  if (!run || isTerminalRunStatus(run.status) || runNeedsAttention(run)) return false;
  return run.state === 'idle' || (run.state == null && run.turnState === 'idle');
}

/** A finished task can be cleared even while its worker is warm for follow-ups. */
export function isRemovableRun(run) {
  if (!run) return false;
  if (isTerminalRunStatus(run.status)) return true;
  return isRunIdle(run) && ['done', 'blocked'].includes(run.lastResult?.status || run.outcome);
}

export function isRunActive(run) {
  if (!run) return false;
  return !isTerminalRunStatus(run.status);
}

export function runNeedsAttention(run) {
  if (!run) return false;
  return run.turnState === 'awaiting_permission' || run.turnState === 'needs_input'
    || run.state === 'awaiting_route' || run.route?.status === 'pending';
}

// Fields a runtime descriptor may fill on a run the dispatcher already describes.
const RUNTIME_FILL_KEYS = ['providerSessionId', 'providerThreadId', 'claimedBy', 'claimedAt', 'browserSessionId', 'browserTabId', 'terminalSessionId', 'runMode'];

function endFrom(out, source) {
  out.status = source.status;
  out.state = source.status;
  out.turnState = 'terminal';
  out.completedAt = source.completedAt || source.finishedAt || source.updatedAt || out.completedAt || null;
  if (source.stoppedReason) out.stoppedReason = source.stoppedReason;
  if (source.error && !out.error) out.error = source.error;
  return out;
}

/**
 * Merge two descriptors for the same run. Within one feed the newer
 * descriptor (terminal status > version > updatedAt > iteration) wins for
 * every key it defines; the older one only fills gaps. Across feeds the
 * versions are different counters, so they are never compared: the
 * dispatcher owns the lifecycle, and a runtime descriptor only fills its own
 * fields — or ends the run when it reports a terminal status first (the
 * dispatcher's 'failed' can wait for its judged cause). `costUsd` is monotonic.
 */
export function mergeRunDescriptor(current, next) {
  const a = current && typeof current === 'object' ? normalizeRunDescriptor(current) : null;
  const b = next && typeof next === 'object' ? normalizeRunDescriptor(next) : null;
  if (!b) return a ? { ...a } : null;
  if (!a) return stripUndefined(b);
  const aDispatch = runFeed(a) === 'dispatch';
  const bFeed = runFeed(b);
  let out;
  if (bFeed === 'runtime' && aDispatch) {
    out = { ...a };
    for (const key of RUNTIME_FILL_KEYS) if (b[key] != null && b[key] !== '') out[key] = b[key];
    if (isTerminalRunStatus(b.status) && !isTerminalRunStatus(a.status)) endFrom(out, b);
  } else if (bFeed === 'dispatch' && !aDispatch) {
    out = { ...a, ...stripUndefined(b) };
    if (isTerminalRunStatus(a.status) && !isTerminalRunStatus(b.status)) endFrom(out, a);
  } else {
    const newer = isNewerRunDescriptor(b, a, RUN_TERMINAL_STATUSES);
    out = newer ? { ...a, ...stripUndefined(b) } : { ...stripUndefined(b), ...stripUndefined(a) };
  }
  const costA = Number(a.costUsd);
  const costB = Number(b.costUsd);
  if (Number.isFinite(costA) || Number.isFinite(costB)) {
    out.costUsd = Math.max(Number.isFinite(costA) ? costA : 0, Number.isFinite(costB) ? costB : 0);
  }
  if (!out.title && (a.title || b.title)) out.title = a.title || b.title;
  return out;
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

const STATUS_ORDER = { queued: 0, starting: 1, running: 1, completed: 2, failed: 2, stopped: 2, interrupted: 2 };

/** Active runs first (attention first), then newest first. Pure — returns a new array. */
export function sortRuns(list) {
  const runs = Array.isArray(list) ? list.filter(Boolean) : [];
  return runs.slice().sort((x, y) => {
    const ax = runNeedsAttention(x) ? -1 : (STATUS_ORDER[x.status] ?? 1);
    const ay = runNeedsAttention(y) ? -1 : (STATUS_ORDER[y.status] ?? 1);
    if (ax !== ay) return ax - ay;
    const tx = toMs(x.startedAt || x.updatedAt);
    const ty = toMs(y.startedAt || y.updatedAt);
    return ty - tx;
  });
}

/** Visual tone for a run: queued | running | idle | action | done | error. */
export function runTone(run) {
  if (!run) return 'idle';
  if (runNeedsAttention(run)) return 'action';
  if (run.status === 'failed' || run.status === 'interrupted') return 'error';
  if (run.status === 'completed' || run.status === 'stopped') return 'done';
  if (run.status === 'queued' || run.queued === true) return 'queued';
  if (run.turnState === 'idle') return 'idle';
  return 'running';
}

function toMs(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** "12s" · "3m 04s" · "1h 12m" · "2d 3h". Empty string for invalid input. */
export function fmtElapsed(from, to = Date.now()) {
  const start = toMs(from);
  const end = toMs(to);
  if (!start || !end || end < start) return '';
  const secs = Math.floor((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** "$0.00" · "<$0.01" · "$0.12" · "$1.50". Empty string when unknown. */
export function fmtCost(usd) {
  const n = Number(usd);
  if (usd == null || usd === '' || !Number.isFinite(n) || n < 0) return '';
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function shortId(id, len = 8) {
  const s = str(id);
  return s.length > len ? s.slice(0, len) : s;
}

/** One-line run summary used by the dock, cards and /agents: "#3 codex/gpt-5.4-mini · title · running · 1m 04s · $0.02". */
export function fmtRunLine(run, { index = null, now = Date.now() } = {}) {
  if (!run) return '';
  const parts = [];
  const who = [run.provider, modelShortName(run.model)].filter(Boolean).join('/');
  // "#n provider/model" is one segment (matches the persona's terse report format)
  if (index != null) parts.push(who ? `#${index} ${who}` : `#${index}`);
  else if (who) parts.push(who);
  if (run.title) parts.push(run.title);
  parts.push(run.turnState === 'awaiting_permission' ? 'awaiting permission'
    : (run.state === 'awaiting_route' ? 'awaiting model choice' : (run.status || 'unknown')));
  const elapsed = fmtElapsed(run.startedAt, isTerminalRunStatus(run.status) ? (run.completedAt || run.updatedAt || now) : now);
  if (elapsed) parts.push(elapsed);
  const cost = fmtCost(run.costUsd);
  if (cost) parts.push(cost);
  return parts.join(' · ');
}

// ── Routing + computer use ─────────────────────────────────────────────────
// Route mode decides when the assistant shows the route card before a task:
// 'always-ask' (every task), 'ask-unsure' (the brain routes on its own when
// confident) and 'never' (fully autonomous). `null` means "server default".

export const ROUTE_MODES = ['always-ask', 'ask-unsure', 'never'];
export const DEFAULT_ROUTE_MODE = 'ask-unsure';

const ROUTE_MODE_ALIASES = {
  'always-ask': 'always-ask', always: 'always-ask', ask: 'always-ask', 'ask-always': 'always-ask',
  'ask-unsure': 'ask-unsure', unsure: 'ask-unsure', 'when-unsure': 'ask-unsure', 'ask-when-unsure': 'ask-unsure',
  never: 'never', 'never-ask': 'never', auto: 'never', autonomous: 'never',
};

/** 'always'/'ask' → 'always-ask' · 'unsure' → 'ask-unsure' · 'auto'/'autonomous'/'never' → 'never'. */
export function normalizeRouteMode(value, fallback = null) {
  const key = str(value).toLowerCase().replace(/[\s_]+/g, '-');
  return ROUTE_MODE_ALIASES[key] || fallback;
}

const COMPUTER_ON = new Set(['on', 'true', '1', 'yes', 'enable', 'enabled']);
const COMPUTER_OFF = new Set(['off', 'false', '0', 'no', 'disable', 'disabled']);

/** on/off/true/false (and booleans) → true | false; anything else → fallback (null = server default). */
export function normalizeComputerMode(value, fallback = null) {
  if (value === true || value === false) return value;
  const key = str(value).toLowerCase();
  if (COMPUTER_ON.has(key)) return true;
  if (COMPUTER_OFF.has(key)) return false;
  return fallback;
}

/** Confidence as a percentage: 0..1 or 0..100 → "86%". Empty string when unknown. */
export function fmtConfidence(value) {
  if (value == null || value === '' || typeof value === 'boolean') return '';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  const pct = n <= 1 ? n * 100 : n;
  return `${Math.round(Math.min(100, pct))}%`;
}

/** Display label of a route target/option: its label, else the short model name, else the provider. */
export function routeTargetLabel(target, { effort = false } = {}) {
  if (!target || typeof target !== 'object') return '';
  const provider = normalizeProvider(target.provider, str(target.provider));
  const label = str(target.label) || modelShortName(target.model) || providerShortLabel(provider);
  if (!effort) return label;
  const level = str(target.effort);
  return level && level !== 'off' ? `${label} · ${level}` : label;
}

export const ROUTE_KIND_LABELS = { direct: 'here', dispatch: 'dispatch', computer: 'computer' };

/** Human word for a route kind: direct → "here", dispatch → "dispatch", computer → "computer". */
export function routeKindLabel(kind) {
  const key = str(kind).toLowerCase();
  return ROUTE_KIND_LABELS[key] || key;
}

// ── Mailbox ────────────────────────────────────────────────────────────────

export const MAILBOX_KINDS = new Set([
  'result', 'needs_input', 'permission_request', 'failed', 'stalled', 'interrupted',
  'queue_started', 'budget_warning', 'budget_exceeded', 'budget_unpriced', 'memory_due', 'user_intervened',
  'clarify_answered', 'clarify_declined',
]);

/** Group mailbox events by kind for chip rendering: [{ kind, count, runIds }].
 *  Accepts an array, `{ items }` (what the runtime sends) or `{ events }`. */
export function summarizeMailbox(events) {
  const list = Array.isArray(events) ? events
    : Array.isArray(events?.items) ? events.items
      : Array.isArray(events?.events) ? events.events : [];
  const byKind = new Map();
  for (const ev of list) {
    const kind = str(ev?.kind || ev?.type || ev?.event) || 'event';
    const entry = byKind.get(kind) || { kind, count: 0, runIds: [] };
    entry.count++;
    const runId = ev?.runId || ev?.run?.runId;
    if (runId && !entry.runIds.includes(runId)) entry.runIds.push(runId);
    byKind.set(kind, entry);
  }
  return [...byKind.values()];
}

// ── Tab state + persistence ─────────────────────────────────────────────────

/** The last-used brain (KEYS.ASSISTANT_BRAIN), normalized. Storage is injected. */
export function readStoredBrain(storage) {
  try { return normalizeBrain(JSON.parse(storage?.getItem?.(KEYS.ASSISTANT_BRAIN) || 'null')); } catch { return normalizeBrain(null); }
}

export function tabStorageKey(sessionId) {
  return `${KEYS.ASSISTANT_TAB_PREFIX}${sessionId}`;
}

export function createTabState(sessionId, brain, extra = {}) {
  return {
    sessionId,
    brain: normalizeBrain(brain),
    title: '',
    running: false,
    connected: false,
    attachedElsewhere: false,
    turnStartedAt: 0,
    queue: [],
    runs: new Map(),
    pendingControls: new Map(),
    costUsd: 0,
    providerSessionId: null,
    dockOpen: true,
    dockShowAll: false,
    draft: '',
    routeMode: null,     // explicit per-session route mode; null = server default
    computerUse: null,   // explicit per-session computer use; null = server default
    usageView: null,
    limit: null,         // the provider's usage limit notice (applyLimit); never persisted, the server re-sends it on attach
    ...extra,
  };
}

/** JSON-safe subset persisted under tabStorageKey(sessionId). */
export function serializeTabState(state) {
  if (!state) return null;
  return {
    v: 1,
    sessionId: state.sessionId,
    brain: normalizeBrain(state.brain),
    title: str(state.title),
    dockOpen: state.dockOpen !== false,
    dockShowAll: state.dockShowAll === true,
    draft: typeof state.draft === 'string' ? state.draft.slice(0, 20000) : '',
    costUsd: Number.isFinite(Number(state.costUsd)) ? Number(state.costUsd) : 0,
    routeMode: normalizeRouteMode(state.routeMode, null),
    computerUse: normalizeComputerMode(state.computerUse, null),
    usageView: compactUsageView(state.usageView),
    updatedAt: Date.now(),
  };
}

/** Tolerant of older payloads: missing routeMode / computerUse read as null (server default). */
export function deserializeTabState(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return null; }
  }
  if (!data || typeof data !== 'object') return null;
  return {
    sessionId: str(data.sessionId) || null,
    brain: normalizeBrain(data.brain),
    title: str(data.title),
    dockOpen: data.dockOpen !== false,
    dockShowAll: data.dockShowAll === true,
    draft: typeof data.draft === 'string' ? data.draft : '',
    costUsd: Number.isFinite(Number(data.costUsd)) ? Number(data.costUsd) : 0,
    routeMode: normalizeRouteMode(data.routeMode, null),
    computerUse: normalizeComputerMode(data.computerUse, null),
    usageView: compactUsageView(data.usageView),
  };
}

/**
 * Keep a bounded, display-ready snapshot while the socket reconnects (and across a reload): the
 * session headline (totals, both sides, dollars, models) and the current task with its agents.
 */
export function compactUsageView(view) {
  if (!view?.task?.id || !Number.isSafeInteger(view.task?.tokens?.total) || view.task.tokens.total < 0) return null;
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  const tokenKeys = ['input', 'cacheWrite', 'cacheRead', 'output', 'reasoning', 'total'];
  const tokens = (value) => {
    const out = Object.fromEntries(tokenKeys.map((key) => [key, count(value?.[key]) ? value[key] : 0]));
    // The two sides are kept only when the server sent them: a zero would read as "no input".
    for (const key of ['inputTotal', 'outputTotal']) if (count(value?.[key])) out[key] = value[key];
    return out;
  };
  const models = (rows) => (Array.isArray(rows) ? rows : []).slice(0, 24).map((row) => ({
    provider: row?.provider ?? null, model: row?.model == null ? null : String(row.model).slice(0, 160), tokens: tokens(row?.tokens), costUsd: row?.costUsd, costBasis: row?.costBasis ?? null,
  }));
  const task = view.task;
  const session = view.session || {};
  return {
    sessionId: String(view.sessionId || '').slice(0, 160),
    task: {
      id: String(task.id).slice(0, 160), n: task.n, title: String(task.title || '').slice(0, 500), live: !!task.live,
      fidelity: task.fidelity, partialReason: task.partialReason, tokens: tokens(task.tokens), costUsd: task.costUsd,
      agents: (Array.isArray(task.agents) ? task.agents : []).slice(0, 100).map((agent) => ({
        key: String(agent.key || '').slice(0, 160), scope: agent.scope, runId: agent.runId,
        title: String(agent.title || '').slice(0, 500), state: agent.state, provider: agent.provider,
        model: agent.model, tokens: tokens(agent.tokens), subagents: { total: agent.subagents?.total || 0 },
        fidelity: agent.fidelity, partialReason: agent.partialReason,
      })),
    },
    session: {
      tokens: tokens(session.tokens), costUsd: session.costUsd, tasks: session.tasks,
      // What orders two views (settled tokens only grow) and labels the headline: kept when the server sent them.
      ...(count(session.pending?.total) ? { pending: { total: session.pending.total } } : {}),
      ...(session.fidelity ? { fidelity: session.fidelity, live: !!session.live } : {}),
      ...(session.costBasis ? { costBasis: session.costBasis } : {}),
      ...(Array.isArray(session.models) ? { models: models(session.models) } : {}),
    },
    recent: (Array.isArray(view.recent) ? view.recent : []).slice(0, 5).map((item) => ({
      id: item.id, n: item.n, title: String(item.title || '').slice(0, 500), total: item.total,
      ...(count(item.inputTotal) && count(item.outputTotal) ? { inputTotal: item.inputTotal, outputTotal: item.outputTotal } : {}),
      costUsd: item.costUsd, fidelity: item.fidelity, live: !!item.live,
    })),
  };
}

/**
 * Apply server usage. A view computed earlier than the one shown never replaces it: the
 * session's settled tokens only grow, so fewer of them means an older view (see
 * usagePacketIsStale, which also keeps the older rules for views that cannot say).
 */
export function applyUsagePacket(state, packet) {
  const view = packet?.type === 'assistant:usage' ? packet : { ...packet, type: 'assistant:usage' };
  if (view.sessionId !== state.sessionId || !view.task?.id || !Number.isSafeInteger(view.task?.tokens?.total) || view.task.tokens.total < 0) return false;
  if (usagePacketIsStale(state.usageView, view)) return false;
  state.usageView = view;
  return true;
}

// ── Provider usage limit ───────────────────────────────────────────────────
// One notice per tab, replaced in place: `state.limit` is one object or null,
// never a list. The runtime sends it as an `assistant:limit` view when it
// changes; an older server forwards the SDK's `rate_limit_info` with every
// response, which goes through the same upsert.

/**
 * A limit report → `{ status: 'warning' | 'rejected', resetsAt: epoch ms | null }`,
 * `null` (no limit near, or its reset time passed) or `undefined` (it names no
 * status: the notice stays as it is).
 */
export function normalizeLimit(info, now = Date.now()) {
  if (info === null) return null;
  const status = info?.status;
  if (status === 'allowed') return null;
  if (status !== 'allowed_warning' && status !== 'warning' && status !== 'rejected') return undefined;
  const raw = Number(info.resetsAt);
  const resetsAt = raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : null; // the SDK reports seconds
  if (resetsAt !== null && resetsAt <= now) return null;
  return { status: status === 'rejected' ? 'rejected' : 'warning', resetsAt };
}

/** Upsert the tab's limit notice. True when what is shown changed: set, updated or cleared. */
export function applyLimit(state, info, now = Date.now()) {
  const next = normalizeLimit(info, now);
  if (next === undefined) return false;
  const was = state.limit || null;
  if ((was?.status ?? null) === (next?.status ?? null) && (was?.resetsAt ?? null) === (next?.resetsAt ?? null)) return false;
  state.limit = next;
  return true;
}

/** Apply the runtime's `assistant:limit` view (`limit: null` clears); another session's is ignored. */
export function applyLimitPacket(state, packet, now = Date.now()) {
  if (!packet || !('limit' in packet) || (packet.sessionId && packet.sessionId !== state.sessionId)) return false;
  return applyLimit(state, packet.limit ?? null, now);
}

/** Milliseconds until the notice's reset time (0 once it passed); null when there is no notice or it names none. */
export function limitExpiresIn(limit, now = Date.now()) {
  return limit?.resetsAt ? Math.max(0, limit.resetsAt - now) : null;
}

/** "Approaching the usage limit · resets 13:00" (local time). `tr(key, fallback, params)` translates. */
export function limitNoticeText(limit, tr = (_key, fallback, params) => String(fallback).replace(/\{(\w+)\}/g, (_m, key) => params?.[key] ?? `{${key}}`)) {
  if (!limit) return '';
  const head = limit.status === 'rejected' ? tr('assistant.status.rateLimited', 'Usage limit reached') : tr('assistant.status.rateLimitWarn', 'Approaching the usage limit');
  if (!limit.resetsAt) return head;
  const time = new Date(limit.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${head} · ${tr('assistant.status.resetsAt', 'resets {time}', { time })}`;
}

/** Descriptor from a sync payload — `{run}` wrapper, bare descriptor, or null. */
/**
 * Dedupe key of an `assistant` event. The Claude Agent SDK sends one event per
 * content block, all under the same API message id, so the id alone would drop
 * every block after the first: the SDK message's uuid is the key, and brains
 * without one (Codex, OpenCode) fall back to the id plus a block signature.
 */
export function assistantEventKey(ev) {
  if (ev?.uuid) return String(ev.uuid);
  const blocks = Array.isArray(ev?.message?.content) ? ev.message.content : [];
  return `${ev?.message?.id ?? ''}|${blocks.map((b) => `${b?.type}:${b?.id || String(b?.text ?? b?.thinking ?? '').length}`).join(',')}`;
}

export function runFromPayload(payload) {
  if (!payload) return null;
  if (payload.run?.runId) return normalizeRunDescriptor(payload.run);
  if (payload.runId) return normalizeRunDescriptor(payload);
  return null;
}
