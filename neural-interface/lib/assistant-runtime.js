// ═══════════════════════════════════════════
// SynaBun — Assistant runtime (sessions, brains, unified WebSocket, mailbox)
// ═══════════════════════════════════════════
//
// Owns every assistant session: its record (persisted), its brain (Claude /
// Codex / OpenCode, created lazily), the attached UI sockets (zero or more; a
// bounded packet buffer bridges detached periods), the transcript log used for
// rehydration, per-turn auto-recall, dispatch mailbox delivery, and the memory
// obligation nudges. All server dependencies are injected.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createClaudeBrain } from './assistant-brains/claude.js';
import { createCodexBrain } from './assistant-brains/codex.js';
import { createOpenCodeBrain } from './assistant-brains/opencode.js';
import { buildAssistantPersona, formatMailbox, reconcileRouteItems } from './assistant-persona.js';
import { codexUsageCostUsd } from './assistant-budget.js';
import { CLAUDE_ESTIMATE_SOURCE, createClaudeMeter, createCodexMeter, createOpenCodeMeter, totalTokens, withTotal, zeroTokens } from './assistant-usage.js';
import { claudeTokensCostUsd } from './assistant-pricing.js';
import { normalizeRouteMode } from './assistant-config.js';
import { TASK_CLASS_META } from './assistant-router.js';
import { defaultIsHidden, enabledStandIn, findModel, providerAllHidden, selectSheetModels } from './assistant-catalog.js';
import { normalizeEffort } from './effort-levels.js';
import { claudeRouteAvailability, createRouteGate, mcpStatusRouteAvailability, ROUTE_GATE_LOOP_MESSAGE } from './assistant-route-gate.js';
import { claudeReadOnlyPermission, planDenyMessage, planToolDecision, readOnlyDenyMessage, readOnlyToolDecision } from './assistant-plan-permissions.js';
import { codexRouteGateBootstrap } from './assistant-route-gate-codex.js';
import { proposedPlanText } from './assistant-envelope.js';
import { clampBrainModes, clampRouteMode, defaultRemotePolicyRegistry, effectiveLevel, isComputerTool, readRegisteredProjects, remoteBrainLimited, remoteComputerDenial, remoteComputerUse, remoteToolDenial, runExceedsPolicy } from './remote-policy.js';
import { browserToolDenial } from './browser-tool-policy.js';

export const BRAIN_PROVIDERS = new Set(['claude-code', 'codex', 'opencode']);
// Every tab is called SynaBun; the session title (the history list) comes from
// the first prompt. Legacy "Assistant N" titles still count as unnamed.
export const DEFAULT_SESSION_TITLE = 'SynaBun';
export function isDefaultSessionTitle(title) { return !title || /^(?:SynaBun|Assistant(?: \d+)?)$/.test(String(title).trim()); }
const MAILBOX_REASONS = new Set(['turn_completed', 'needs_input', 'permission_request', 'failed', 'interrupted', 'stalled', 'budget_warning', 'budget_exceeded', 'budget_unpriced', 'queue_started', 'user_intervened', 'stopped']);
// A stopped run reaches the brain when the user stopped it or it ran out of money.
const MAILBOX_STOP_REASONS = new Set(['user', 'budget_cap', 'session_budget_cap', 'budget_unpriced']);
const usd = (value) => `$${(Number(value) || 0).toFixed(2)}`;
const TRANSCRIPT_EVENT_TYPES = new Set(['assistant', 'user', 'result', 'system']);
// Below the autonomous level a remote session's brain asks before any tool the
// read-only classifier would refuse. These stay unasked: questions and plans (they reach
// the user anyway), in-session bookkeeping, subagent launches (their own calls
// are asked), memory writes, and agent_dispatch (its route card is the approval).
const REMOTE_ASK_EXEMPT = new Set([
  'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'TodoWrite', 'TodoRead', 'ToolSearch', 'Task', 'Agent',
  'mcp__SynaBun__remember', 'mcp__SynaBun__reflect', 'mcp__SynaBun__category', 'mcp__SynaBun__agent_dispatch',
]);
// An OpenCode brain of a remote session reaches the web through these on its own
// (no SynaBun browser, no approval): the gate plugin refuses them.
const REMOTE_OPENCODE_WEB_TOOLS = new Set(['webfetch', 'websearch', 'codesearch']);
// Computer use from a remote session (see "computer use from a remote session"): what the
// brain is told when its computer tool does not run.
const COMPUTER_NO_TURN_NOTE = 'Computer use from WhatsApp runs only inside the task that asked for it; no such task is running.';
const COMPUTER_DECLINED_NOTE = 'The user did not allow computer use for this task. Do not retry it or work around it in this task: say what you could not do.';
const COMPUTER_CLOSED_NOTE = 'The request to control the Mac closed without an answer, so nothing was allowed. Do not retry it in this task.';
const COMPUTER_SUPERSEDED_NOTE = 'The user sent a newer message, so computer use for this task ended. Do not retry it or work around it: end your turn now; their message is next.';
// "Keep planning" without a note (asst-control.js buildClaude): no feedback to plan on.
const KEEP_PLANNING_DEFAULT = 'Keep planning — revise the plan.';

/**
 * The plan a Codex / OpenCode plan turn proposed, from its `result` event, or
 * '' when the turn asked or answered instead. Only an explicit proposal counts:
 * Codex's plan item or <proposed_plan> block, and the <proposed_plan> block
 * OpenCode's plan-mode instructions ask for (assistant-brains/opencode.js).
 * Nothing is guessed from the reply's shape: a numbered clarifying question
 * looks like a plan and a prose plan does not, and a false card invites
 * approving what is not a plan, while a missing one only leaves plan mode on.
 */
export function planTurnText(result = {}) {
  return String(result.plan || '').trim() || proposedPlanText(result.result);
}

/**
 * A provider's usage-limit report (the Claude Agent SDK's `rate_limit_info`) as the one notice a
 * session shows: `{ status: 'allowed_warning' | 'rejected', resetsAt: epoch ms | null, rateLimitType }`.
 * `null`: the limit is no longer near, or its reset time has passed. `undefined`: the report names
 * no status, so the notice stays as it is.
 */
export function limitNotice(info, nowMs = Date.now()) {
  const status = info?.status;
  if (status === 'allowed') return null;
  if (status !== 'allowed_warning' && status !== 'rejected') return undefined;
  const raw = Number(info.resetsAt);
  const resetsAt = raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : null; // the SDK reports seconds
  if (resetsAt !== null && resetsAt <= nowMs) return null;
  return { status, resetsAt, rateLimitType: info.rateLimitType || null };
}
const limitKey = (limit) => (limit ? `${limit.status}|${limit.resetsAt ?? ''}` : '');

function iso(now = Date.now()) { return new Date(now).toISOString(); }
function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}
function clip(value, max = 200) { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }

/**
 * A brain effort checked against its model (effort-levels.js). "off" (or a
 * model with no levels) stays "off" for Claude and Codex, which reset to the
 * model's default on it; OpenCode has no such variant, so it gets null.
 */
export function checkBrainEffort(provider, model, effort, catalog) {
  if (!effort) return null;
  if (!catalog) return String(effort);
  const next = normalizeEffort({ provider, model, effort, catalog }).effort;
  return next || (provider === 'opencode' ? null : 'off');
}

/** `catalog` (a catalog value) checks the effort against the brain's model (effort-levels.js). */
export function normalizeBrain(input = {}, defaults = {}, { catalog = null } = {}) {
  // Plan mode is a flag beside the approval mode ('plan' as a mode is the legacy form).
  const legacyPlan = input?.permissionMode === 'plan';
  const provider = BRAIN_PROVIDERS.has(input?.provider) ? input.provider : (BRAIN_PROVIDERS.has(defaults.provider) ? defaults.provider : 'claude-code');
  const model = input?.model ? String(input.model) : (defaults.model || null);
  const effort = input?.effort ? String(input.effort) : (defaults.effort || null);
  return {
    provider,
    model,
    effort: checkBrainEffort(provider, model, effort, catalog),
    agent: input?.agent ? String(input.agent) : null,
    accountId: input?.accountId ? String(input.accountId) : (provider === 'opencode' ? null : 'default'),
    cwd: input?.cwd ? String(input.cwd) : (input?.project ? String(input.project) : (defaults.cwd || null)),
    mcpProfile: input?.mcpProfile ? String(input.mcpProfile) : (provider === 'claude-code' ? 'full' : (defaults.mcpProfile || null)),
    permissionMode: input?.permissionMode && !legacyPlan ? String(input.permissionMode) : 'default',
    planMode: typeof input?.planMode === 'boolean' ? input.planMode : (legacyPlan || defaults?.planMode === true),
  };
}

/** A brain's `mode_changed` → the record fields it changes (Claude leaving 'plan' = the plan was approved). */
export function brainModeUpdate(brain, mode, planMode, { fromBrain = false } = {}) {
  const patch = {};
  if (mode === 'plan') patch.planMode = true;
  else if (mode) {
    patch.permissionMode = String(mode);
    if (fromBrain && brain?.provider === 'claude-code') patch.planMode = false;
  }
  if (typeof planMode === 'boolean') patch.planMode = planMode;
  return patch;
}

/** Claude SDK hook maps merged per event (either side may be null). */
export function mergeHooks(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { ...a };
  for (const [event, matchers] of Object.entries(b)) out[event] = [...(out[event] || []), ...matchers];
  return out;
}

export function createAssistantRuntime({
  dispatcher = null,
  claudeAccounts = null,
  ClaudeSession = null,
  sdkVersion = null,
  handleCodexSkinWebSocket = null,
  ensureIsolatedServe = null,
  stopIsolatedServe = null,
  setupOpencodeSidepanelConfig = null,
  broadcastSync = () => {},
  dataDir,
  memory = null,
  buildCatalog = null,
  detectProject = () => 'global',
  PACKAGE_ROOT = process.cwd(),
  config = {},
  log = () => {},
  now = Date.now,
  brainFactories = null,
  // Routing (assistant-router.js), the model catalog and the config store.
  router = null,
  catalog = null,
  configStore = null,
  // Computer use (lib/desktop/service.js).
  desktop = null,
  // Route gate: the loopback URL the OpenCode plugin and the Codex hook ask,
  // the Codex binary (for the hook's trust probe) and the bootstrap builder.
  gateUrl = null,
  codexBin = () => 'codex',
  codexGateBootstrap = codexRouteGateBootstrap,
  // Codex list prices (assistant-budget.js createModelPricing). When given, a
  // brain whose spend cannot be priced is refused (the caps fail closed).
  pricing = null,
  usage = null,
  // The meters of assistant-usage.js, by provider (tests swap one in).
  meterFactories = null,
  codexHomeForAccount = null,
  // Clarification (assistant-clarify.js): human prompts, the brain's own
  // question cards and the clarify cards' answers reach it from here.
  clarifier = null,
  // Remote sessions (lib/remote-policy.js): the level registry shared with the
  // dispatcher and the WhatsApp bridge, and the registered project paths a
  // remote session's workers must run in.
  remotePolicy = defaultRemotePolicyRegistry,
  registeredProjects = () => readRegisteredProjects(),
  // (capability) → boolean, the verifier of lib/remote-policy.js createPhoneAuthority(): is this the
  // capability of the one WhatsApp bridge? Without a verifier nothing can grant computer use remotely.
  phoneAuthority = null,
} = {}) {
  if (!dataDir) throw new Error('createAssistantRuntime requires dataDir');
  const settings = {
    idleDisposeMs: Math.max(60_000, Number(config.idleDisposeMinutes || 120) * 60_000),
    // A remote session on OpenCode waits this long for its gate plugin's hello before a turn (else refused).
    remoteGateHelloMs: Math.max(0, Number(config.remoteGateHelloMs ?? 5000)),
    // An OpenCode turn's end waits this long for the serve's stored messages (the usage meter's
    // reconcile); past it the turn is settled as not reconciled and the next turn may start.
    openCodeReconcileMs: Number(config.openCodeReconcileMs) > 0 ? Number(config.openCodeReconcileMs) : 10_000,
    bufferCap: 500,
    mailboxBatchMs: Number(config.mailboxBatchMs) || 2000,
    retention: 200,
    defaultBrain: config.defaultBrain || {},
    personaExtra: config.persona?.extra || '',
    maxBudgetUsd: Number(config.brains?.claude?.maxBudgetUsd) || 10,
    // A brain's approval or question card waits this long, then it is declined
    // (0 = wait forever). A pending card holds the turn and the mailbox.
    approvalTimeoutMs: Math.max(0, Number(config.approvalTimeoutMinutes ?? 10) * 60_000) || 0,
    questionTimeoutMs: Math.max(0, Number(config.questionTimeoutMinutes ?? 30) * 60_000) || 0,
  };
  const indexPath = resolve(dataDir, 'assistant-sessions.json');
  const sessions = new Map(); // id → live
  const listeners = new Set();
  // Passive packet observers (the WhatsApp bridge): they see every packet a
  // session sends, never count as delivery, and never hold a session open.
  const packetObservers = new Set();
  let unsubscribeDispatcher = null;
  let unsubscribePolicy = null;
  let unsubscribeUsage = null;
  const usageTimers = new Map();
  const usageSentAt = new Map();
  const meters = { 'claude-code': createClaudeMeter, codex: createCodexMeter, opencode: createOpenCodeMeter, ...(meterFactories || {}) };
  // Token metering is additive: a throw in a meter or the ledger is logged once
  // per kind and never reaches the turn logic (running, dollars, the turn's end).
  const usageErrors = new Set();
  function usageError(kind, error) {
    if (usageErrors.has(kind)) return;
    usageErrors.add(kind);
    log('assistant:usage-error', `${kind}: ${error?.message || String(error)}`);
  }
  function metered(kind, fn, fallback = null) {
    try { return fn(); } catch (error) { usageError(kind, error); return fallback; }
  }
  // shutdown(): no scheduler work starts any more.
  let shuttingDown = false;

  // ── persistence ────────────────────────────────────────────────────────────
  function transcriptPath(id) { return resolve(dataDir, 'assistant', id, 'transcript.jsonl'); }
  function loadIndex() {
    const rows = readJson(indexPath, []);
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row?.id) continue;
      sessions.set(row.id, makeLive({ ...row, status: row.status === 'ended' ? 'ended' : 'idle', windowIds: [] }));
      // A remote session nobody registered again since the restart reads as read-only.
      if (row.remote) {
        try { remotePolicy?.markRemote?.(row.id, { channel: row.remote.channel || row.channel || 'whatsapp' }); } catch {}
        try { remotePolicy?.setSessionBrain?.(row.id, row.brain?.provider || null); } catch {}
      }
    }
  }
  let persistTimer = null;
  function persist({ force = false } = {}) {
    const write = () => {
      const rows = [...sessions.values()].map((live) => publicRecord(live.record, { withLive: false, persisted: true }))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, settings.retention);
      try { writeJsonAtomic(indexPath, rows); } catch (error) { log('assistant:index-error', error?.message || String(error)); }
    };
    if (force) { if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; } write(); return; }
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; write(); }, 300);
    persistTimer.unref?.();
  }
  function appendTranscript(id, entry) {
    try {
      const path = transcriptPath(id);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
    } catch {}
  }
  function readTranscript(id, limit = 400) {
    const path = transcriptPath(id);
    if (!existsSync(path)) return [];
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, limit)).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  // ── records ────────────────────────────────────────────────────────────────
  function makeLive(record) {
    return {
      record, brain: null, brainProvider: null, brainMeter: null, brainMeterProvider: null, turnTaskId: null, turnTasks: [], sockets: new Set(), buffer: [], running: false, pendingControls: new Map(), controlTimers: new Map(),
      mailbox: [], mailboxTimer: null, obligations: new Set(), rememberedThisTurn: false, disposeTimer: null, personaText: '',
      lastPrompt: '', mailboxTurn: false, nudgedRuns: new Set(),
      // The provider's usage limit as last reported (limitNotice), or null: one state, never a list.
      limit: null,
      // Human prompts so far: one request cycle each (assistant-clarify.js briefs).
      promptCycle: 0,
      // Claude brains: the turns sent, keyed by their final text, for the in-process recall hook.
      turnMeta: new Map(),
      desktopGrant: null,
      // Route gate (assistant-route-gate.js): one per session while routing is wired.
      // gatePluginAt: when the OpenCode serve loaded the gate plugin (until then, reactive).
      // gateNudge: { reason, gen } while a reactive refusal waits for its turn to end.
      gate: null, gateToken: null, gateNudge: null, gatePluginAt: null,
      // Turns between runQuery's entry and its end (the prompt prefix awaits recall,
      // the catalog and the brain before `running` is set): busy all along.
      // `prompting`: the generation of the human prompt among them (one at a time).
      turnPending: 0, prompting: null,
      // Remote sessions: the last human prompt carried untrusted content (capped at ask
      // until the next one); the desktop approved the plan of the running turn; the
      // level the live brain was built for (bypass allowed only when autonomous).
      turnUntrusted: false, planApprovedByDesktop: false, brainSkipAllowed: null,
      // A Codex / OpenCode brain built read-only for a remote session (lib/remote-policy.js).
      brainRemoteReadOnly: false,
      // Computer use from a remote session (remoteComputerUse decides). computerTurn: the running
      // turn's own state { approved, by, declined }, null between turns; computerAsk: its open
      // "control your Mac for this?" request { requestId, followers }; computerGrantLive: the held
      // desktop grant is active now; brainComputerMode: what the live brain was built for.
      computerTurn: null, computerAsk: null, computerGrantLive: false, brainComputerMode: null,
      // A route card that said the Mac will be controlled (assistant-router.js computerConsent):
      // computerRoutes: routeId → { turn, epoch } recorded when the card was sent; computerRouteGrant:
      // the owner's yes to such a card, waiting for the mailbox turn that executes that route
      // ({ routeId, origin, epoch, at }); computerEpoch: bumped whenever remoteComputerUse's answer
      // changes, so a card or a yes from before the change counts for nothing.
      computerRoutes: new Map(), computerRouteGrant: null, computerEpoch: 0,
      // Codex / OpenCode plan turns end with the plan: the runtime's own "Plan ready"
      // card ({ requestId, plan }, the work scheduler's hold), the running turn that
      // offers one, its plan, and the generation it started in.
      planCard: null, planTurn: false, planText: '', planTurnGen: 0,
      // Plan cards closed unanswered (request id → reason): an answer still on its way is refused.
      closedPlanCards: new Map(),
      // The work scheduler (see "work scheduler"): the cancellation generation, the
      // queued work (kind → entry), the entry that holds the session now, the
      // fallback retry, and the generation each route card was raised in.
      // Closing (endSessionWork): the close under way (a promise), and the generation it started.
      gen: 0, work: new Map(), workActive: null, workTimer: null, workPumpQueued: false, routeGens: new Map(),
      closing: null, closedGen: 0,
    };
  }
  // ── remote sessions (lib/remote-policy.js) ─────────────────────────────────
  /**
   * The session's remote policy, or null. `brainProvider` is the session's own
   * brain (`provider` for a brain about to be set): a Codex / OpenCode brain
   * makes it read-only (effectiveLevel).
   */
  function remotePolicyFor(liveOrRecord, provider = null) {
    const record = liveOrRecord?.record || liveOrRecord || null;
    const id = record?.id || null;
    if (!id || !remotePolicy?.getSessionPolicy) return null;
    let policy = null;
    try { policy = remotePolicy.getSessionPolicy(id) || null; }
    catch { return record?.remote ? { level: 'read-only', failClosed: true } : null; }
    if (!policy) return null;
    const brainProvider = provider || record?.brain?.provider || policy.brainProvider || null;
    return brainProvider === policy.brainProvider ? policy : { ...policy, brainProvider };
  }
  /** The level the session's current turn runs at: null for a desktop session. */
  function remoteLevel(live) {
    const policy = remotePolicyFor(live);
    return policy ? effectiveLevel(policy, { untrusted: live.turnUntrusted === true, now: now() }) : null;
  }
  function registeredProjectPaths() {
    try { const rows = typeof registeredProjects === 'function' ? registeredProjects() : registeredProjects; return Array.isArray(rows) ? rows : []; } catch { return []; }
  }
  /**
   * A mode write: `next` is what was asked for (kept on the remote record, so a
   * level raised later gives it back); the record gets what the level allows.
   */
  function clampModeWrite(live, next, { fromBrain = false } = {}) {
    if (!remotePolicyFor(live)) return next;
    const before = live.record.remote?.modes || null;
    // A brain's own report changes the plan flag only: its approval mode is the clamped one it was given.
    const wanted = fromBrain && before
      ? { permissionMode: before.permissionMode || 'default', planMode: next.planMode === true }
      : { permissionMode: next.permissionMode || 'default', planMode: next.planMode === true };
    live.record.remote = { ...(live.record.remote || { channel: live.record.channel || 'whatsapp' }), modes: wanted };
    return clampedBrain(live, next);
  }
  function clampedBrain(live, brain) {
    const policy = remotePolicyFor(live, brain?.provider || null);
    if (!policy) return brain;
    const wanted = live.record.remote?.modes || { permissionMode: brain.permissionMode, planMode: brain.planMode === true };
    const modes = clampBrainModes(policy, wanted, { untrusted: live.turnUntrusted === true, now: now(), planApproved: live.planApprovedByDesktop === true });
    return { ...brain, ...modes };
  }
  /** Re-applies the level to the record and the live brain; true when the modes changed. */
  async function reclampLive(live) {
    if (!remotePolicyFor(live)) return false;
    const before = live.record.brain;
    const next = clampedBrain(live, before);
    if (next.permissionMode === before.permissionMode && (next.planMode === true) === (before.planMode === true)) return false;
    live.record.brain = next;
    touch(live);
    try { await live.brain?.setPermissionMode?.(next.permissionMode, { planMode: next.planMode === true }); } catch {}
    return true;
  }
  // ── computer use from a remote session ─────────────────────────────────────
  // remoteComputerUse (lib/remote-policy.js) is the one place that decides: off,
  // allowed (Autonomous, the owner's switch on) or allowed after one approval per
  // turn (Ask). Everything here asks it. A remote Claude brain is built with a
  // HELD desktop grant (its MCP headers are fixed at start); the grant is live
  // only while a turn runs and that turn may use the computer: unasked, or after
  // the owner's yes to the turn's one request. It is never persisted and ends
  // with the turn; a pause, a level change, the switch going off, a Stop, a stop
  // at the Mac, the brain going away and a shutdown all hold it again and stop
  // the action in progress (the desktop's lease is released).
  function desktopReady() { try { return !!desktop?.isReady?.(); } catch { return false; } }
  /**
   * Whether the running turn may use the computer unasked at Autonomous: only a
   * turn started by a trusted message from the owner's phone (computerTurn.unasked,
   * set from what started the turn, never from a session flag). Every other turn
   * of a remote session (a mailbox turn, a continuation, one the CLI started,
   * one typed on the desktop, one carrying a picture or third-party text) is
   * "untrusted" for computer use: it asks once. No turn running: the base answer.
   */
  function computerUntrusted(live) { return !!live?.computerTurn && live.computerTurn.unasked !== true; }
  /** remoteComputerUse for the session now (`untrusted`: overrides the running turn's own); null for a desktop session. */
  function computerDecision(liveOrRecord, { untrusted = null } = {}) {
    const policy = remotePolicyFor(liveOrRecord);
    if (!policy) return null;
    const live = liveOrRecord?.record ? liveOrRecord : sessions.get(liveOrRecord?.id) || null;
    return remoteComputerUse(policy, { untrusted: untrusted === null ? computerUntrusted(live) : untrusted === true, now: now(), desktop: { supported: computerSupported(), ready: desktopReady() } });
  }
  /**
   * A remote session's computer tools may run right now: a turn runs, the owner
   * did not say no in it, and it is allowed unasked or was approved.
   */
  function computerRuns(live) {
    const decision = computerDecision(live);
    if (!decision || !live.computerTurn || live.computerTurn.declined === true) return false;
    return decision.state === 'allowed' || (decision.state === 'ask' && live.computerTurn.approved === true);
  }
  /**
   * What one computer tool call of a remote session gets: { access: 'run' } |
   * { access: 'ask' } (the turn's one request) | { access: 'deny', reason, message }.
   */
  function computerAccess(live) {
    const decision = computerDecision(live);
    if (!decision) return null;
    if (decision.state === 'off') return { access: 'deny', reason: decision.reason, message: remoteComputerDenial(decision.reason) };
    if (!live.computerTurn) return { access: 'deny', reason: 'no_turn', message: COMPUTER_NO_TURN_NOTE };
    // A no (or an unanswered request) holds for the rest of the turn, whatever the level becomes.
    if (live.computerTurn.declined === true) return { access: 'deny', reason: 'declined', message: live.computerTurn.superseded === true ? COMPUTER_SUPERSEDED_NOTE : COMPUTER_DECLINED_NOTE };
    if (decision.state === 'allowed' || live.computerTurn.approved === true) return { access: 'run', reason: decision.reason };
    return { access: 'ask', reason: decision.reason };
  }
  /** The held grant goes live or dark. Going dark stops the session's action in progress and releases the desktop. */
  function setComputerGrant(live, runs) {
    const was = live.computerGrantLive === true;
    live.computerGrantLive = runs === true;
    if (live.desktopGrant && (was || runs)) {
      const channel = live.record.remote?.channel || live.record.channel || 'whatsapp';
      const approved = live.computerTurn?.approved === true;
      // The audit says where the session is driven from and how this use was allowed.
      const remote = runs ? { channel, approval: approved ? 'approved_turn' : 'unasked', approvedBy: approved ? live.computerTurn.by : null } : { channel };
      try { desktop?.setGrantActive?.(live.desktopGrant, runs === true, { remote }); } catch (error) { log('assistant:desktop-grant-error', error?.message || String(error)); }
    }
    if (was && !runs) {
      try { desktop?.onSessionToggle?.(live.record.id, false); } catch {}
      log('assistant:remote-policy', `${live.record.id}: computer use ended; the desktop grant is held again`);
    }
  }
  function syncComputerGrant(live) {
    if (remotePolicyFor(live)) setComputerGrant(live, computerRuns(live));
  }
  /**
   * The open "control your Mac for this?" request closes without a grant: every
   * computer tool call that waited on it is refused and the card closes.
   */
  function closeComputerAsk(live, reason, message = COMPUTER_CLOSED_NOTE) {
    const ask = live.computerAsk;
    if (!ask) return false;
    live.computerAsk = null;
    const shown = live.pendingControls.delete(ask.requestId);
    clearControlTimer(live, ask.requestId);
    for (const rid of [ask.requestId, ...ask.followers]) { try { live.brain?.respondControl?.(rid, { behavior: 'deny', message }); } catch {} }
    if (shown) sendToSockets(live, { type: 'control_cancelled', request_id: ask.requestId, reason });
    if (live.record.status === 'awaiting' && !live.pendingControls.size) live.record.status = live.running ? 'running' : 'idle';
    return true;
  }
  /**
   * A turn begins: nothing of the last one carries over (no approval, no open
   * request). `unasked`: it was started by a trusted message from the owner's
   * phone (the only kind of turn Autonomous lets use the computer without asking).
   * `id` names the turn to the desktop service: a call admitted in one turn never runs in another.
   */
  function beginComputerTurn(live, { unasked = false } = {}) {
    if (!remotePolicyFor(live)) return;
    closeComputerAsk(live, 'turn_ended');
    live.computerTurnSeq = (Number(live.computerTurnSeq) || 0) + 1;
    live.computerTurn = { id: `${live.record.id}#${live.computerTurnSeq}`, approved: false, by: null, declined: false, unasked: unasked === true };
    syncComputerGrant(live);
  }
  /**
   * A newer message from the owner's phone arrived (the bridge calls this before
   * it buffers or queues it): an approval the running turn holds ends at once and
   * the action in progress stops; a yes still waiting for its mailbox turn is void.
   * The turn itself goes on without the computer. A turn that runs unasked
   * (Autonomous, started by the owner's own message) holds no approval: it is not
   * ended here (the owner stops it with /stop). → true when an approval ended.
   */
  function supersedeComputerApproval(id) {
    const live = sessions.get(String(id || ''));
    if (!live || !remotePolicyFor(live)) return false;
    dropRouteComputer(live);
    const turn = live.computerTurn;
    if (!turn || turn.approved !== true) return false;
    turn.approved = false;
    turn.by = null;
    turn.declined = true;
    turn.superseded = true;
    setComputerGrant(live, computerRuns(live));
    log('assistant:remote-policy', `${live.record.id}: a newer phone message ended this turn's computer approval`);
    sendToSockets(live, { type: 'assistant:session', session: view(live), reason: 'computer' });
    return true;
  }
  /** The turn ended, was stopped, or its brain went: its approval and the live grant end with it. */
  function endComputerTurn(live, reason = 'turn_ended') {
    if (!live.computerTurn && !live.computerAsk && !live.computerGrantLive) return;
    const approved = live.computerTurn?.approved === true;
    closeComputerAsk(live, reason);
    live.computerTurn = null;
    setComputerGrant(live, false);
    // The panel's Computer switch said "on for this task": it reads the session again.
    if (approved && sessions.get(live.record.id) === live) sendToSockets(live, { type: 'assistant:session', session: view(live), reason: 'computer' });
  }
  /**
   * A Claude brain's permission request for a computer tool in a remote session
   * (its hook answered 'ask'). It is never shown as a generic tool card: the
   * first one of a turn becomes the turn's ONE request of its own kind (the
   * phone and the desktop can answer it), the ones that arrive while it is open
   * wait on the same answer, and one that needs no asking is answered at once.
   * → true when the packet was dealt with here.
   */
  function computerControlRequest(live, packet) {
    const request = packet.request || {};
    const tool = String(request.tool_name || request.toolName || '');
    if (!isComputerTool(tool) || !remotePolicyFor(live)) return false;
    const rid = String(packet.request_id);
    const access = computerAccess(live);
    const respond = (response) => { try { live.brain?.respondControl?.(rid, response); } catch {} };
    if (access.access === 'run') { respond({ behavior: 'allow' }); return true; }
    if (access.access === 'deny') { respond({ behavior: 'deny', message: access.message }); return true; }
    if (live.computerAsk) { live.computerAsk.followers.push(rid); return true; }
    const card = {
      type: 'control_request', request_id: rid,
      request: { subtype: 'computer_use', kind: 'computer_use', tool_name: 'computer_use', channel: live.record.remote?.channel || live.record.channel || 'whatsapp', level: computerDecision(live)?.level || null, reason: access.reason },
    };
    live.computerAsk = { requestId: rid, followers: [] };
    live.pendingControls.set(rid, card);
    live.record.status = 'awaiting';
    armControlTimeout(live, card);
    touch(live);
    log('assistant:remote-policy', `${live.record.id}: asking to control the Mac for this turn (${rid})`);
    sendToSockets(live, card);
    return true;
  }
  /** The running turn may use the computer from here on (the owner's yes): the grant goes live and every host hears it. */
  function approveComputerTurn(live, origin, how = 'request') {
    const turn = live.computerTurn;
    turn.approved = true;
    turn.by = origin;
    setComputerGrant(live, computerRuns(live));
    log('assistant:remote-policy', `${live.record.id}: computer use approved for this turn (${origin}, ${how})`);
    const status = { type: 'event', event: { type: 'system', subtype: 'status', text: `Computer use approved for this task (${origin === 'whatsapp' ? 'from WhatsApp' : 'on this computer'}). It ends with the task.` } };
    sendToSockets(live, status);
    appendTranscript(live.record.id, { at: iso(now()), packet: status });
    sendToSockets(live, { type: 'assistant:session', session: view(live), reason: 'computer' });
  }
  /** Nothing of a route card's computer consent outlives a new prompt, a Stop, a stop at the Mac or a changed decision. */
  function dropRouteComputer(live) {
    live.computerRoutes.clear();
    live.computerRouteGrant = null;
  }
  // The phone's authority is a capability, not a string. Only the WhatsApp bridge holds it (handed
  // over once, at wiring time, by the composition root), so no other caller in this process can
  // grant computer use, grant the Mac part of a route, or start a turn that counts as the owner's
  // own message from the phone, whatever `origin` it passes.
  function fromPhone(authority) {
    try { return typeof phoneAuthority === 'function' && typeof authority === 'symbol' && phoneAuthority(authority) === true; } catch { return false; }
  }
  /**
   * A route card that said the Mac will be controlled was approved on the option
   * it said it for (the router's computerApproved sink). The yes is the computer
   * approval of the turn that carries the route out, when: the card was bound
   * when it was sent, the answer came from the owner's phone or the desktop,
   * remoteComputerUse still says "ask" and has not changed since, and no newer
   * prompt, Stop or stop at the Mac came in between. `viaMailbox`: the turn that
   * raised the card is over, so the mailbox turn that executes the decided route
   * gets it (claimRouteComputer); otherwise the turn that raised it, if it is
   * still the one running. → true when the yes was taken.
   */
  function routerComputerApproved(id, { routeId, origin = null, viaMailbox = false, authority = null } = {}) {
    const live = sessions.get(String(id || ''));
    const key = String(routeId || '');
    const binding = live?.computerRoutes.get(key);
    if (!live || !binding) return false;
    live.computerRoutes.delete(key); // one answer per card
    // Granted only by the bridge's match on a message from the owner's phone, which it proves with
    // its capability (`origin` is audit text): an answer that arrived by socket or REST, or from any
    // other caller in this process, approves the route alone (the phone is then asked about the Mac).
    if (!fromPhone(authority)) return false;
    if (binding.epoch !== live.computerEpoch || computerDecision(live)?.state !== 'ask') {
      log('assistant:remote-policy', `${live.record.id}: route ${key} approved, but computer use changed since its card was sent: no computer approval`);
      return false;
    }
    if (viaMailbox === true) {
      live.computerRouteGrant = { routeId: key, origin, epoch: live.computerEpoch, at: now() };
      return true;
    }
    const turn = live.computerTurn;
    if (!turn || turn !== binding.turn || turn.declined === true) return false;
    approveComputerTurn(live, origin, `route ${key}`);
    // A computer call of this turn that was already waiting on its own request is answered by the same yes.
    const ask = live.computerAsk;
    if (ask) {
      live.computerAsk = null;
      if (live.pendingControls.delete(ask.requestId)) { clearControlTimer(live, ask.requestId); controlResolved(live, ask.requestId, origin); }
      for (const rid of [ask.requestId, ...ask.followers]) { try { live.brain?.respondControl?.(rid, { behavior: 'allow' }); } catch {} }
      if (live.record.status === 'awaiting' && !live.pendingControls.size) live.record.status = live.running ? 'running' : 'idle';
    }
    return true;
  }
  /**
   * A mailbox turn that executes decided routes begins: if one of them is the
   * route whose card carried the owner's computer approval, this turn has it.
   * Used once; void after a changed decision or the approval timeout.
   */
  function claimRouteComputer(live, routeIds = []) {
    const grant = live.computerRouteGrant;
    if (!grant || !routeIds.includes(grant.routeId)) return false;
    live.computerRouteGrant = null;
    const turn = live.computerTurn;
    if (!turn || turn.declined === true || grant.epoch !== live.computerEpoch || computerDecision(live)?.state !== 'ask') return false;
    if (settings.approvalTimeoutMs > 0 && now() - grant.at > settings.approvalTimeoutMs) return false;
    approveComputerTurn(live, grant.origin, `route ${grant.routeId}, mailbox turn`);
    return true;
  }
  /**
   * The turn's request was answered (the caller already took it out of the
   * pending cards, in the same synchronous step that found it). A yes from the
   * owner's phone or the desktop turns computer use on for this turn only, and
   * only while remoteComputerUse still says "ask" for it; anything else is a no
   * for the rest of the turn. → true when computer use runs now.
   */
  function settleComputerAsk(live, ask, approved, { origin = 'ui', message = null, authority = null } = {}) {
    if (live.computerAsk === ask) live.computerAsk = null;
    const decision = computerDecision(live);
    const turn = live.computerTurn;
    const trusted = fromPhone(authority);
    // Granted only by a yes the bridge matched on a message from the owner's phone (its capability says so; `origin` is audit text), while the turn lives and the decision is not "off".
    const granted = approved === true && trusted && !!turn && !!decision && decision.state !== 'off';
    if (granted && decision.state === 'ask') { turn.approved = true; turn.by = origin; }
    if (!granted && turn) { turn.declined = true; turn.approved = false; turn.by = null; }
    const runs = granted && computerRuns(live);
    if (runs && turn.approved === true) approveComputerTurn(live, origin);
    else setComputerGrant(live, runs);
    const denial = decision?.state === 'off' ? remoteComputerDenial(decision.reason) : (String(message || '').trim() || COMPUTER_DECLINED_NOTE);
    for (const rid of [ask.requestId, ...ask.followers]) { try { live.brain?.respondControl?.(rid, runs ? { behavior: 'allow' } : { behavior: 'deny', message: denial }); } catch {} }
    if (live.record.status === 'awaiting' && !live.pendingControls.size) live.record.status = live.running ? 'running' : 'idle';
    return runs;
  }
  /**
   * A level was registered, changed or cleared: computer use follows what
   * remoteComputerUse says now (a change of its answer ends the running turn's
   * approval and stops the action in progress), the brain's modes follow the
   * level, and the session's runs that go past the new level stop. A Claude brain
   * built for another level restarts when idle (bypass is only allowed to a brain
   * built at the autonomous level; its persona and its held grant follow the
   * computer-use mode it was built for).
   */
  function onRemotePolicyChanged(sessionId, previous = null) {
    const live = sessions.get(String(sessionId || ''));
    const policy = live ? remotePolicyFor(live) : null;
    if (!live || !policy) return;
    if (!live.record.remote) live.record.remote = { channel: policy.channel || 'whatsapp', since: iso(now()) };
    const after = computerDecision(live);
    const before = previous ? remoteComputerUse(previous, { untrusted: computerUntrusted(live), now: now(), desktop: { supported: computerSupported(), ready: desktopReady() } }) : null;
    if (!before || before.state !== after.state || before.reason !== after.reason) {
      // Did the running turn have the Mac (approved at Ask, or unasked at Autonomous)? Read before anything is closed.
      const hadControl = live.computerGrantLive === true || live.computerTurn?.approved === true;
      closeComputerAsk(live, 'policy');
      if (live.computerTurn) { live.computerTurn.approved = false; live.computerTurn.by = null; }
      // Computer use went off under a turn that had the Mac (the switch, a pause, an unlink, the bridge
      // gone): that turn is done with it. When the policy allows it again (a resume, a rebuilt bridge),
      // the turn neither gets it back nor asks again; the next message from the phone starts afresh.
      if (after?.state === 'off' && hadControl && live.computerTurn) { live.computerTurn.declined = true; live.computerTurn.unasked = false; }
      // A route card sent before the change no longer carries a computer approval, and a yes already given to one is void.
      live.computerEpoch += 1;
      dropRouteComputer(live);
    }
    syncComputerGrant(live);
    reclampLive(live).catch(() => {});
    stopRunsAboveLevel(live, policy);
    // Otherwise the next turn restarts it (runQuery).
    if (brainNeedsRestart(live) && !sessionBusy(live) && !live.brain?.hasPendingWork?.()) disposeBrain(live, 'policy').catch(() => {});
    touch(live);
    if (live.creating) return; // createSession announces it
    broadcast('assistant:session-updated', live);
    sendToSockets(live, { type: 'assistant:session', session: view(live), reason: 'remote' });
  }
  function stopRunsAboveLevel(live, policy) {
    if (!dispatcher?.list || !dispatcher?.stop) return;
    let runs = [];
    try { runs = dispatcher.list({ assistantSessionId: live.record.id, activeOnly: true }) || []; } catch { runs = []; }
    if (!runs.length) return;
    const projects = registeredProjectPaths();
    for (const run of runs) {
      if (!runExceedsPolicy(policy, run, { registeredProjects: projects, now: now() })) continue;
      log('assistant:remote-policy', `${live.record.id}: stopping ${run.runId} (above the ${effectiveLevel(policy, { now: now() })} level)`);
      Promise.resolve(dispatcher.stop(run.runId, 'remote_policy')).catch(() => {});
    }
  }
  /** Something runs: a turn, one on its way to the brain, the scheduler's work (a compact), the brain itself. */
  function sessionBusy(live) {
    return !!live && (live.running || (Number(live.turnPending) || 0) > 0 || !!activeWork(live) || !!live.brain?.isBusy?.());
  }
  /**
   * A Claude brain built for another level: without the remote hook (built
   * before the session became remote), or with bypass allowed at a level that
   * no longer allows it (or the reverse).
   */
  function brainNeedsRestart(live) {
    if (!live?.brain) return false;
    const policy = remotePolicyFor(live);
    // A Codex / OpenCode brain built before the session became remote is not read-only yet.
    if (live.brainProvider !== 'claude-code') return !!policy && live.brainRemoteReadOnly !== true;
    if (!policy) return false;
    if (live.brainSkipAllowed !== (effectiveLevel(policy, { now: now() }) === 'autonomous')) return true;
    // Its persona and its held desktop grant were built for another computer-use mode.
    return live.brainComputerMode !== (computerDecision(live, { untrusted: false })?.state || 'off');
  }
  function defaultRouteMode() {
    try { return configStore?.routing?.().defaultMode || 'ask-unsure'; } catch { return 'ask-unsure'; }
  }
  function routingView(record) {
    let askBelow = 0.75;
    try { askBelow = configStore?.routing?.().askBelow ?? askBelow; } catch {}
    const mode = normalizeRouteMode(record.routing?.mode) || null;
    // A remote session below the autonomous level asks on a route card for every task.
    const policy = remotePolicyFor(record);
    const effectiveMode = policy ? clampRouteMode(policy, mode || defaultRouteMode(), { now: now() }) : (mode || defaultRouteMode());
    return { mode, effectiveMode, defaultMode: defaultRouteMode(), askBelow };
  }
  function computerSupported() { try { return !!desktop?.isSupported?.(); } catch { return false; } }
  /**
   * Effective computer toggle: explicit per-session value, else the service default (ON after setup).
   * A remote session has no toggle of its own: on means remoteComputerUse does not say "off"
   * (whether a call runs right now is computerRuns: unasked, or after the turn's approval).
   */
  function computerEffective(record) {
    const remote = computerDecision(record);
    if (remote) return remote.state !== 'off';
    if (!computerSupported()) return false;
    if (record.computerUse === true || record.computerUse === false) return record.computerUse;
    try { return !!desktop.defaultSessionOn?.(); } catch { return false; }
  }
  function brainCapabilities(record) {
    try { return catalog?.brainInfo?.(record.brain) || null; } catch { return null; }
  }
  /** The hidden id (Assistant → Models) that `model` names for `provider`, else null. */
  /** An effort the model does not run becomes the nearest one it does; unknown models pass through. */
  function brainEffort(provider, model, effort) {
    try { return checkBrainEffort(provider, model, effort, catalog?.peek?.() || null); } catch { return effort || null; }
  }
  function hiddenBrainModel(provider, model) {
    if (!provider || !model) return null;
    try { return catalog?.hiddenId?.(provider, model) || null; } catch { return null; }
  }
  function modelDisabledError(model) {
    const error = new Error(`${model} is disabled in the Assistant's Models list. Pick an enabled model, or enable it in ⋯ → Models….`);
    error.code = 'MODEL_DISABLED';
    error.status = 400;
    return error;
  }
  function everyModelDisabledError(provider) {
    const error = new Error(`Every ${provider} model is disabled in the Assistant's Models list. Pick another provider, or enable one in ⋯ → Models….`);
    error.code = 'MODEL_DISABLED';
    error.status = 400;
    return error;
  }
  /** The catalog value; built on demand only when nothing is cached yet. */
  async function catalogValue() {
    const cached = catalog?.peek?.() || null;
    if (cached) return cached;
    try { return (await catalog?.full?.()) || null; } catch { return null; }
  }
  /**
   * The brain a new session (or a provider switch) runs on, never a model the
   * user disabled (Assistant → Models). A disabled model named by the caller is
   * refused, or with `fallback` (the UI's start path) replaced by the same
   * model at another context window, else the provider's enabled default, else
   * the default brain provider's. A null model is pinned when the provider's
   * own default is disabled (dispatch does the same). → { brain, fallback }:
   * fallback = { reason: 'model'|'provider', from, fromProvider, to, provider, label }
   * when the caller's model (or every model of its provider) was replaced.
   */
  async function enabledBrain(brain, { fallback = false, named = true } = {}) {
    const { provider, model } = brain;
    const disabled = model ? hiddenBrainModel(provider, model) : null;
    if (model && !disabled) return { brain, fallback: null };
    if (disabled && named && !fallback) throw modelDisabledError(model);
    const value = await catalogValue();
    if (!value) {
      if (disabled) throw modelDisabledError(model);
      return { brain, fallback: null };
    }
    if (!disabled && !defaultIsHidden(value, provider) && !providerAllHidden(value, provider)) return { brain, fallback: null };
    const note = (reason, row, to) => ({ reason, from: reason === 'model' ? model : provider, fromProvider: provider, to: row.id, provider: to, label: row.label || row.id });
    const same = enabledStandIn(value, provider, model);
    if (same) return { brain: normalizeBrain({ ...brain, model: same.id }, {}, { catalog: value }), fallback: disabled ? note('model', same, provider) : null };
    // Every model of this provider is disabled (or an OpenCode model is, whose default is OpenCode's own).
    if (!fallback) throw disabled ? modelDisabledError(model) : everyModelDisabledError(provider);
    const other = [settings.defaultBrain.provider, 'claude-code'].find((p) => BRAIN_PROVIDERS.has(p) && p !== provider);
    const row = other ? enabledStandIn(value, other) : null;
    if (!row) throw disabled ? modelDisabledError(model) : everyModelDisabledError(provider);
    const next = normalizeBrain({ provider: other, model: row.id, cwd: brain.cwd, mcpProfile: brain.mcpProfile, permissionMode: 'default' }, {}, { catalog: value });
    return { brain: next, fallback: note(disabled ? 'model' : 'provider', row, other) };
  }
  function publicRecord(record, { withLive = true, live = null, persisted = false } = {}) {
    const out = { ...record };
    if (!persisted) delete out.usageState;
    if (withLive && live) {
      out.running = live.running;
      out.attached = live.sockets.size;
      out.brainActive = !!live.brain;
      out.pendingControls = live.pendingControls.size;
      out.obligations = [...live.obligations];
      out.routing = routingView(record);
      out.brainCapabilities = brainCapabilities(record);
      out.pendingRoutes = router?.pendingCards ? router.pendingCards(record.id).length : 0;
      const policy = remotePolicyFor(record);
      const computer = policy ? computerDecision(live) : null;
      out.computerUse = computerEffective(record);
      // A remote session's computer use is not a per-conversation choice: no explicit value, and why it is what it is.
      out.computerUseExplicit = policy ? null : (record.computerUse === true || record.computerUse === false ? record.computerUse : null);
      out.computerRemote = computer ? { state: computer.state, reason: computer.reason, level: computer.level, approved: live.computerTurn?.approved === true } : null;
      out.features = { routing: !!router, computer: computerSupported() };
      out.budget = sessionMoney(record.id);
      out.remoteLevel = policy ? effectiveLevel(policy, { untrusted: live.turnUntrusted === true, now: now() }) : null;
    }
    return out;
  }
  function view(live) { return publicRecord(live.record, { withLive: true, live }); }
  function touch(live) { live.record.updatedAt = iso(now()); persist(); }
  function requireLive(id) {
    const live = sessions.get(id);
    if (!live) { const error = new Error(`Unknown assistant session ${id}`); error.code = 'SESSION_NOT_FOUND'; error.status = 404; throw error; }
    return live;
  }
  function broadcast(type, live, extra = {}) {
    try { broadcastSync({ type, session: view(live), ...extra }); } catch {}
    for (const listener of listeners) { try { listener({ type, session: view(live), ...extra }); } catch {} }
  }

  // ── sockets + forwarding ───────────────────────────────────────────────────
  function sendToSockets(live, packet) {
    const raw = JSON.stringify(packet);
    let delivered = 0;
    for (const ws of [...live.sockets]) {
      if (ws.readyState !== 1) { live.sockets.delete(ws); continue; }
      try { ws.send(raw); delivered += 1; } catch { live.sockets.delete(ws); }
    }
    if (!delivered) {
      live.buffer.push(packet);
      if (live.buffer.length > settings.bufferCap) live.buffer.splice(0, live.buffer.length - settings.bufferCap);
    }
    // Observers never count as delivery: the buffer, the replay and idle disposal stay the UI's.
    if (packetObservers.size) {
      const sessionId = live.record.id;
      for (const observer of [...packetObservers]) { try { observer({ sessionId, packet }); } catch {} }
    }
    return delivered;
  }
  /**
   * The task a turn's tokens belong to: the turn's own while one runs, else the
   * latest human task (record.taskId, which only a human prompt moves).
   */
  function currentTask(sessionId) {
    const live = sessions.get(sessionId);
    return live?.turnTaskId || live?.record.taskId || metered('task', () => usage?.currentTask?.(sessionId)?.id) || null;
  }
  /** The session's current task, made when it has none yet. Never throws. */
  function ensureTaskId(sessionId) {
    return metered('task', () => usage?.ensureTask?.(sessionId)?.id) || null;
  }
  /**
   * What the gauge, the usage endpoint and agent_usage show. `session` is the headline: every
   * task of the session added up from the ledger file, so a follow-up prompt, a re-attach, a
   * reload and a restart all show the same, growing total. `task` is one task's detail.
   */
  function usageView(sessionId, taskId = 'current') {
    if (!usage) return null;
    const live = sessions.get(sessionId);
    // 'current' is the latest human task, also while a mailbox turn works for an older one.
    const view = usage.taskView(sessionId, taskId === 'current' ? live?.record.taskId || 'current' : taskId);
    // Work in progress anywhere in the session makes its total provisional, whatever task is shown.
    const markSessionLive = () => { if (view.session) { view.session.live = true; view.session.fidelity = 'live'; } };
    if (live?.running) markSessionLive();
    if (!view.task) return view;
    const empty = () => withTotal(zeroTokens());
    view.task.agents = view.task.agents.map((agent) => {
      if (agent.key === 'brain') return { ...agent, title: 'Brain', state: live?.running && currentTask(sessionId) === view.task.id ? 'running' : 'idle' };
      if (agent.key === 'judgments') return { ...agent, title: 'Judgments (Jev)', state: 'done' };
      // peek: the few fields this needs, without the full view and the memory lookup get() does (a dispatcher without it: get).
      let run = null;
      try { run = typeof dispatcher?.peek === 'function' ? dispatcher.peek(agent.runId) : dispatcher?.get?.(agent.runId); } catch {}
      // A run the dispatcher dropped has ended: its tokens stay, under a short name.
      if (!run) return { ...agent, title: `Run ${String(agent.runId || agent.key).slice(0, 8)}`, state: 'done' };
      const state = run.state || 'idle';
      const displayState = state === 'completed' ? 'done' : state === 'starting' || state === 'awaiting_route' ? 'queued' : state === 'awaiting_permission' ? 'running' : state === 'interrupted' ? 'stopped' : state;
      return { ...agent, title: run.title || agent.runId, state: ['queued', 'running', 'idle', 'done', 'failed', 'stopped'].includes(displayState) ? displayState : 'idle' };
    });
    if (live?.running && currentTask(sessionId) === view.task.id && !view.task.agents.some((agent) => agent.key === 'brain')) {
      view.task.agents.unshift({ key: 'brain', scope: 'brain', runId: null, provider: live.record.brain?.provider || null, model: live.record.brain?.model || null, tokens: empty(), pending: empty(), subagents: { total: 0 }, fidelity: 'live', partialReason: null, title: 'Brain', state: 'running' });
    }
    let activeRuns = [];
    try { activeRuns = dispatcher?.list?.({ assistantSessionId: sessionId, activeOnly: true }) || []; } catch {}
    for (const run of Array.isArray(activeRuns) ? activeRuns : []) {
      if (!run?.runId || view.task.agents.some((agent) => agent.key === run.runId)) continue;
      // A warm run on a follow-up works for the task of that turn, which may be later than its own.
      const runTaskId = run.turnTaskId || run.taskId || run.turns?.at(-1)?.taskId || currentTask(sessionId);
      if (runTaskId !== view.task.id) continue;
      const state = run.state === 'running' || run.state === 'awaiting_permission' ? 'running' : run.state === 'idle' ? 'idle' : 'queued';
      view.task.agents.push({ key: run.runId, scope: 'run', runId: run.runId, provider: run.provider || null, model: run.model || null, tokens: empty(), pending: empty(), subagents: { total: 0 }, fidelity: 'exact', partialReason: null, title: run.title || run.runId, state });
    }
    if (view.task.agents.some((agent) => agent.state === 'running')) { view.task.live = true; view.task.fidelity = 'live'; }
    if (view.task.live || (Array.isArray(activeRuns) && activeRuns.some((run) => run?.state === 'running' || run?.state === 'awaiting_permission'))) markSessionLive();
    return view;
  }
  /**
   * A usage packet is a view, not an event: it goes to the open sockets only.
   * Never buffered or replayed (attach sends a fresh view), never shown to the
   * packet observers, and not built at all while no socket is attached.
   */
  function sendUsage(live) {
    if (!usage || !live || !sessions.has(live.record.id)) return;
    metered('packet', () => {
      const open = [...live.sockets].filter((ws) => ws.readyState === 1);
      if (!open.length) return;
      const raw = JSON.stringify({ type: 'assistant:usage', ...usageView(live.record.id) });
      for (const ws of open) { try { ws.send(raw); } catch {} }
      usageSentAt.set(live.record.id, Date.now());
    });
  }
  /**
   * The provider's usage limit is a view too: one state per session, sent to the open sockets
   * when it changes and to a socket when it attaches. Never buffered, replayed, journaled or
   * shown to the packet observers, so a provider that repeats its limit on every response
   * (the Claude SDK's `rate_limit_event`) yields one packet, and the next one only on a change.
   */
  function sendLimit(live, sockets = live.sockets) {
    // A notice whose reset time has passed is gone, whoever asks.
    if (live.limit?.resetsAt && live.limit.resetsAt <= now()) live.limit = null;
    const raw = JSON.stringify({ type: 'assistant:limit', sessionId: live.record.id, limit: live.limit });
    for (const ws of sockets) { if (ws.readyState === 1) { try { ws.send(raw); } catch {} } }
  }
  /** `next`: a limitNotice() value. True when the session's notice changed (and the sockets heard). */
  function setLimit(live, next) {
    if (next === undefined || limitKey(next) === limitKey(live.limit)) return false;
    live.limit = next ? { ...next, provider: live.brainProvider || live.record.brain?.provider || null, at: iso(now()) } : null;
    sendLimit(live);
    return true;
  }
  function scheduleUsage(sessionId) {
    if (!usage || !sessions.has(sessionId)) return;
    if (usageTimers.has(sessionId)) return;
    const wait = Math.max(0, 250 - (Date.now() - (usageSentAt.get(sessionId) || 0)));
    const timer = setTimeout(() => { usageTimers.delete(sessionId); sendUsage(sessions.get(sessionId)); }, wait);
    timer.unref?.();
    usageTimers.set(sessionId, timer);
  }
  /** The meter's state onto the session record. `force`: rows were just settled, so the record is written at once. */
  function saveMeter(live, { force = false } = {}) {
    if (!live.brainMeter || !live.brainMeterProvider) return;
    const state = metered('meter-state', () => live.brainMeter.state());
    if (!state) return;
    live.record.usageState ||= {};
    const key = live.brainMeterProvider === 'claude-code' ? 'claude' : live.brainMeterProvider;
    live.record.usageState[key] = state;
    // A kill between the ledger append and the debounced write would count those rows again.
    persist({ force });
  }
  function startMeter(live, provider) {
    if (!usage) return;
    live.brainMeter = null;
    live.turnTasks.length = 0;
    metered('meter-start', () => {
      const state = live.record.providerSessionId ? live.record.usageState?.[provider === 'claude-code' ? 'claude' : provider] : null;
      if (provider === 'claude-code') {
        const meter = meters['claude-code']({ state });
        if (!state && live.record.providerSessionId && live.record.turns) meter.expectHistory();
        live.brainMeter = meter;
      } else if (provider === 'opencode') {
        const meter = meters.opencode({ state });
        meter.setRoot(live.record.providerSessionId || null);
        live.brainMeter = meter;
      } // Codex needs the thread id first.
    });
    live.brainMeterProvider = provider;
    saveMeter(live);
  }
  /**
   * The brain resumed into another provider session. Claude's counters there
   * are not the ones this meter differenced: it starts over and treats the
   * first result as one with history (partial, never a huge false delta).
   * OpenCode keeps its per-session totals and takes the new session as its root.
   */
  function resetMeterIdentity(live, providerSessionId) {
    metered('resume', () => {
      if (live.brainMeterProvider === 'claude-code') { live.brainMeter?.reset(); live.brainMeter?.expectHistory(); }
      else if (live.brainMeterProvider === 'opencode') live.brainMeter?.setRoot(providerSessionId);
      // No brain yet: the saved Claude baseline must not be restored for the new session.
      if (!live.brainMeter && live.record.usageState) delete live.record.usageState.claude;
      usage?.clearPending?.(live.record.id, 'brain');
    });
    saveMeter(live);
  }
  /** The Codex brain's new rollout usage, settled. Never throws. */
  function pollCodex(live, { force = false } = {}) {
    if (!usage || live.brainProvider !== 'codex') return;
    metered('codex-poll', () => {
      const threadId = live.brain?.identity?.()?.providerThreadId || live.record.providerThreadId;
      if (!threadId) return;
      if (!live.brainMeter || live.brainMeterProvider !== 'codex' || live.codexMeterThreadId !== threadId) {
        const account = live.record.brain?.accountId || 'default';
        let home = null;
        try { home = codexHomeForAccount?.(account) || null; } catch {}
        if (!home) {
          const registry = readJson(resolve(dataDir, 'codex-accounts.json'), {});
          home = registry.accounts?.find((row) => row.id === account)?.home || null;
        }
        const state = live.record.usageState?.codexThreadId === threadId ? live.record.usageState?.codex : null;
        const sinceMs = !state && live.record.turns > 1 ? live.turnStartedMs || now() : Date.parse(live.record.createdAt) || 0;
        // A response whose prompt is over its model's long-context size is priced whole at the long rates.
        const longPromptTokens = (model) => { try { return pricing?.codexPrice?.(model || live.record.brain?.model)?.long?.size || 0; } catch { return 0; } };
        live.brainMeter = meters.codex({ codexHome: home || undefined, threadId, sinceMs, state, longPromptTokens });
        live.brainMeterProvider = 'codex';
        live.codexMeterThreadId = threadId;
        live.record.usageState ||= {};
        live.record.usageState.codexThreadId = threadId;
      }
      if (!force && Date.now() - (live.codexPolledAt || 0) < 2000) return;
      live.codexPolledAt = Date.now();
      const rows = live.brainMeter.poll();
      const taskId = rows.length ? currentTask(live.record.id) || ensureTaskId(live.record.id) : null;
      // The long-context tier follows the brain's configured id ("<id>[extended]"); a rollout names the plain model.
      const info = brainCapabilities(live.record) || {};
      const extended = /\[extended\]$/.test(String(live.record.brain?.model || info.id || ''));
      for (const row of rows) {
        const model = row.model || live.record.brain?.model || null;
        const price = (() => { try { return pricing?.codexPrice?.(model) || codexBrainPrice(live); } catch { return codexBrainPrice(live); } })();
        // row.usage is the provider's own keys (input includes cached): what the list price is per.
        // row.long: these responses' prompts were over the long-context size (priced whole at the long rates).
        const costUsd = price ? codexUsageCostUsd(row.usage, price, { contextWindow: extended ? info.contextWindow || null : null, long: row.long ?? null }) : null;
        usage.settle({ sessionId: live.record.id, taskId, scope: 'brain', runId: null, turn: live.record.turns, provider: 'codex', model, part: row.part, tokens: row.tokens, costUsd, costBasis: costUsd === null ? 'unpriced' : 'estimated', fidelity: row.fidelity, reason: row.reason, source: row.source });
      }
      saveMeter(live, { force: rows.length > 0 });
    });
  }
  function openCodeEvent(live, type, event) {
    if (!usage || live.brainMeterProvider !== 'opencode' || !live.brainMeter) return;
    metered('opencode-event', () => {
      if (!live.brainMeter.onEvent(type, event)) return;
      usage.setPending(live.record.id, 'brain', { taskId: currentTask(live.record.id), scope: 'brain', provider: 'opencode', model: live.record.brain?.model, tokens: live.brainMeter.live().tokens });
      saveMeter(live);
    });
  }
  /** An OpenCode turn's tokens, settled once its stored messages were read back. Never rejects. */
  async function finishOpenCode(live, meter, taskId, turn) {
    let reconciled = false;
    // A serve that never answers must not hold the next turn: past the limit the turn is settled as
    // not reconciled. What a late answer still adds to the meter is above the mark taken below, so
    // the next finish books it once.
    let timer = null;
    const expired = new Promise((done) => { timer = setTimeout(() => done(false), settings.openCodeReconcileMs); timer.unref?.(); });
    try { reconciled = await Promise.race([expired, Promise.resolve().then(() => live.brain?.reconcileUsage?.(meter)).then((ok) => ok === true)]); } catch {}
    clearTimeout(timer);
    metered('opencode-finish', () => {
      const delta = meter.markTurn();
      const parts = ['main', 'subagents'].filter((part) => totalTokens(delta[part]) > 0);
      if (!parts.length && delta.costUsd > 0) parts.push('main');
      // The turn's cost is one number: it rides on the first row, null on the other.
      parts.forEach((part, index) => {
        usage.settle({ sessionId: live.record.id, taskId, scope: 'brain', runId: null, turn, provider: 'opencode', model: live.record.brain?.model, part, tokens: delta[part], costUsd: index === 0 ? delta.costUsd : null, costBasis: 'reported', fidelity: reconciled ? 'exact' : 'partial', reason: reconciled ? null : 'opencode-not-reconciled', source: 'opencode-messages' });
      });
    });
    metered('opencode-finish', () => usage.clearPending(live.record.id, 'brain'));
    if (live.brainMeter === meter) saveMeter(live, { force: true });
    scheduleUsage(live.record.id);
  }
  /** One finish at a time: a second turn end waits for the first, and so does the next turn (runTurn). */
  function queueOpenCodeFinish(live, taskId, turn) {
    const meter = live.brainMeter;
    if (!usage || !meter || live.brainMeterProvider !== 'opencode') return;
    const chain = (live.openCodeFinalizing || Promise.resolve())
      .then(() => finishOpenCode(live, meter, taskId, turn))
      .catch((error) => usageError('opencode-finish', error))
      .then(() => { if (live.openCodeFinalizing === chain) live.openCodeFinalizing = null; });
    live.openCodeFinalizing = chain;
  }
  /**
   * One Claude row into the ledger. The CLI reports what a counted call cost. An estimate row (a
   * call cut off by an interrupt, which the CLI never counts) has no reported cost: it is priced
   * at list price and joins the brain's spend, so the caps see it too.
   */
  function settleClaudeRow(live, taskId, row, settled = null) {
    const id = live.record.id;
    const estimate = row.source === CLAUDE_ESTIMATE_SOURCE;
    const costUsd = estimate ? claudeTokensCostUsd(row.model, row.tokens) : row.costUsd;
    usage.settle({
      sessionId: id, taskId, scope: 'brain', runId: null, turn: live.record.turns, provider: 'claude-code', model: row.model, part: row.part, tokens: row.tokens,
      costUsd, costBasis: estimate ? (costUsd === null ? 'unpriced' : 'estimated') : 'reported',
      fidelity: row.fidelity || settled?.fidelity, reason: row.reason ?? settled?.reason ?? null, source: row.source || settled?.source,
    });
    if (estimate && costUsd > 0) {
      live.record.costUsd = Number(((Number(live.record.costUsd) || 0) + costUsd).toFixed(4));
      try { dispatcher?.checkSession?.(id); } catch {}
      sendCost(live);
    }
  }
  /** The Claude brain's own SDK messages: a result settles the task at the front of the FIFO, the rest is pending. */
  function claudeUsageEvent(live, event) {
    const id = live.record.id;
    metered('claude-meter', () => {
      const { settled, pendingChanged } = live.brainMeter.onEvent(event);
      const taskId = live.turnTasks[0] || currentTask(id) || ensureTaskId(id);
      if (settled) for (const row of settled.rows) settleClaudeRow(live, taskId, row, settled);
      if (pendingChanged) usage.setPending(id, 'brain', { taskId, scope: 'brain', provider: 'claude-code', model: live.record.brain?.model, tokens: live.brainMeter.pending().tokens });
      if (settled) saveMeter(live, { force: true });
    });
    // That turn has its result: the next queued prompt's task is in flight now.
    if (event.type === 'result') live.turnTasks.shift();
  }
  /**
   * The Claude brain's turn ended without a result that counts what the stream showed (an
   * interrupt, a dead process, the brain going away): those calls were spent, so the live
   * estimate is booked instead of dropped. A result that still arrives takes them off its delta.
   */
  function settleClaudeEstimate(live, reason) {
    if (!usage || live.brainMeterProvider !== 'claude-code' || !live.brainMeter) return;
    const id = live.record.id;
    metered('claude-meter', () => {
      const rows = typeof live.brainMeter.settlePending === 'function' ? live.brainMeter.settlePending({ reason }) : (live.brainMeter.clearPending?.(), []);
      const taskId = rows.length ? live.turnTasks[0] || currentTask(id) || ensureTaskId(id) : null;
      for (const row of rows) settleClaudeRow(live, taskId, row);
      usage.clearPending?.(id, 'brain');
      if (rows.length) saveMeter(live, { force: true });
    });
  }
  function onBrainPacket(live, packet) {
    if (!packet || typeof packet !== 'object') return;
    const id = live.record.id;
    if (packet.type === 'event') {
      const event = packet.event || {};
      // The usage limit comes with every response: the session keeps its state and says so when
      // it changes (assistant:limit). The event itself goes to no socket, buffer or observer.
      if (event.type === 'rate_limit_event') { setLimit(live, limitNotice(event.rate_limit_info, now())); return; }
      if (usage && live.brainProvider === 'claude-code' && live.brainMeterProvider === 'claude-code' && live.brainMeter && ['assistant', 'stream_event', 'result'].includes(event.type) && !event.brain) claudeUsageEvent(live, event);
      if (event.type === 'assistant' && live.gate && gateIsReactive(live)) reactiveGate(live, event);
      if (event.type === 'system' && event.subtype === 'init') {
        if (event.session_id && live.brainProvider === 'claude-code') live.record.providerSessionId = event.session_id;
        if (live.brainProvider === 'claude-code') applyRouteAvailability(live, claudeRouteAvailability(event));
        touch(live);
      }
      // OpenCode (after start and before each turn) and Codex (MCP startup) report their servers.
      if (event.type === 'system' && event.subtype === 'mcp_status' && live.brainProvider !== 'claude-code') applyRouteAvailability(live, mcpStatusRouteAvailability(event.servers));
      if (event.type === 'result') {
        const cost = Number(event.total_cost_usd);
        if (Number.isFinite(cost) && cost > 0) {
          // Brains report a running total; a smaller value means the provider
          // session restarted (resume, brain switch), so it counts in full.
          const last = Number(live.record.lastReportedCost) || 0;
          const delta = cost >= last ? cost - last : cost;
          live.record.costUsd = Number(((Number(live.record.costUsd) || 0) + delta).toFixed(4));
          live.record.lastReportedCost = cost;
          live.record.costBasis = event.cost_basis || 'reported';
          // The brain's spend counts toward the session caps: warn, or stop the session's runs.
          try { dispatcher?.checkSession?.(id); } catch {}
          sendCost(live);
        }
        // The Claude CLI's own cap stopped the brain: its process cannot run another turn.
        if (event.subtype === 'error_max_budget_usd' && live.brainProvider === 'claude-code') live.brainCapHit = true;
        if (live.planTurn) live.planText = planTurnText(event);
        touch(live);
      }
      if (TRANSCRIPT_EVENT_TYPES.has(event.type) && !(event.type === 'system' && event.subtype !== 'init')) appendTranscript(id, { at: iso(now()), packet });
    }
    // A remote session's computer tool asking for permission: the turn's one request, never a generic card.
    if (packet.type === 'control_request' && computerControlRequest(live, packet)) return;
    if (packet.type === 'control_cancelled' && live.computerAsk) {
      const rid = String(packet.request_id);
      const ask = live.computerAsk;
      // A call that waited on the open request went away: it was never a card of its own.
      if (ask.followers.includes(rid)) { ask.followers = ask.followers.filter((id) => id !== rid); return; }
      // The brain withdrew the request itself (its turn was interrupted): nothing was approved.
      if (ask.requestId === rid) {
        live.computerAsk = null;
        for (const id of ask.followers) { try { live.brain?.respondControl?.(id, { behavior: 'deny', message: COMPUTER_CLOSED_NOTE }); } catch {} }
      }
    }
    if (packet.type === 'control_request') {
      live.pendingControls.set(String(packet.request_id), packet);
      live.record.status = 'awaiting';
      armControlTimeout(live, packet);
      // A question the brain asks with its own tool joins the request's brief.
      try { clarifier?.onNativeQuestion?.(id, { requestId: String(packet.request_id), request: packet.request || {}, cycle: live.promptCycle, prompt: live.lastPrompt }); } catch {}
    }
    if (packet.type === 'control_cancelled') {
      live.pendingControls.delete(String(packet.request_id));
      clearControlTimer(live, String(packet.request_id));
      try { clarifier?.onNativeSettled?.(id, String(packet.request_id), 'cancelled'); } catch {}
    }
    const modeEvent = packet.type === 'mode_changed' ? packet : (packet.type === 'event' && packet.event?.type === 'mode_changed' ? packet.event : null);
    if (modeEvent && (modeEvent.mode || typeof modeEvent.planMode === 'boolean')) {
      const wasPlanning = isPlanningLive(live);
      const before = live.record.brain;
      const reported = { ...live.record.brain, ...brainModeUpdate(live.record.brain, modeEvent.mode, modeEvent.planMode, { fromBrain: true }) };
      // A remote session's level holds here too: a brain that left what it allows is put back.
      live.record.brain = clampModeWrite(live, reported, { fromBrain: true });
      if (live.record.brain.permissionMode !== reported.permissionMode || (live.record.brain.planMode === true) !== (reported.planMode === true)) {
        Promise.resolve(live.brain?.setPermissionMode?.(live.record.brain.permissionMode, { planMode: live.record.brain.planMode === true })).catch(() => {});
      }
      // The plan left mid-turn without passing the approval (answerControl clears
      // it there): the plan turn skipped routing, so the work it continues into
      // is routed first, like any other.
      if (wasPlanning && !isPlanningLive(live)) live.gate?.startTurn({ carry: true });
      touch(live);
      // Every other open host follows (this socket already has the packet).
      if (before.permissionMode !== live.record.brain.permissionMode || (before.planMode === true) !== (live.record.brain.planMode === true)) broadcast('assistant:session-updated', live);
    }
    // The CLI began a turn on its own (a background agent finished, a wakeup fired).
    if (packet.type === 'turn_started' && !live.running) {
      // A turn the CLI started itself is a new turn for the route gate too.
      live.gate?.startTurn();
      live.running = true;
      beginComputerTurn(live);
      if (usage) {
        // Its tokens go to the latest human task; its own result takes it off the FIFO again.
        live.turnTaskId ||= live.record.taskId || ensureTaskId(id);
        if (live.brainProvider === 'claude-code' && live.turnTaskId && !live.turnTasks.length) live.turnTasks.push(live.turnTaskId);
        scheduleUsage(id);
      }
      live.record.status = 'running';
      live.record.lastActiveAt = iso(now());
      if (live.disposeTimer) { clearTimeout(live.disposeTimer); live.disposeTimer = null; }
      touch(live);
    }
    let plan = '';
    let planGen = 0;
    if (packet.type === 'done' || packet.type === 'aborted' || packet.type === 'error') {
      if (packet.type !== 'error' || !live.brain?.isBusy?.()) {
        // The turn's tokens (none of this throws): Codex is polled once, here.
        if (live.brainProvider === 'codex') pollCodex(live, { force: true });
        if (live.brainProvider === 'opencode') queueOpenCodeFinish(live, currentTask(id), live.record.turns);
        // Claude: a turn that ended normally has its result (a background sub-agent still streaming is
        // settled by the next one). An aborted or dead turn may never get one: its estimate is booked.
        if (live.brainProvider === 'claude-code') {
          if (packet.type === 'done') metered('claude-meter', () => { if (live.brainMeter?.clearPending?.()) usage?.clearPending?.(id, 'brain'); });
          else settleClaudeEstimate(live, 'interrupted');
        }
        live.running = false;
        // A remote session's computer use ends with its turn (the approval and the live grant); a
        // prompt the CLI still holds starts its own turn, unapproved.
        endComputerTurn(live, packet.type === 'aborted' ? 'stopped' : 'turn_ended');
        if (live.brainProvider === 'claude-code' && live.brain?.isBusy?.()) beginComputerTurn(live);
        // A Claude prompt sent mid-turn is still queued in the CLI: its task is the turn in flight now.
        if (live.brainProvider !== 'claude-code' || !live.brain?.isBusy?.()) live.turnTasks.length = 0;
        live.turnTaskId = live.turnTasks[0] || null;
        live.record.status = 'idle';
        // A plan the desktop approved ran in this turn; the next one is read-only again.
        live.planApprovedByDesktop = false;
        // A Codex / OpenCode plan turn that ended with its plan: the card follows the `done`.
        if (packet.type === 'done' && !(Number(packet.code) > 0) && live.planTurn && isPlanningLive(live)) { plan = live.planText; planGen = live.planTurnGen; }
        live.planTurn = false;
        live.planText = '';
        // The brain's cards close with its turn. The runtime's plan card, open while
        // a compact, a Stop or an idle error ends one, stays answerable and timed.
        const keep = live.planCard?.requestId || null;
        settleNativeQuestions(live, 'turn_ended', keep);
        for (const rid of [...live.pendingControls.keys()]) if (rid !== keep) live.pendingControls.delete(rid);
        clearControlTimers(live, keep);
        if (keep) live.record.status = 'awaiting';
        touch(live);
        scheduleUsage(id);
        onTurnFinished(live);
      }
    }
    sendToSockets(live, packet);
    if (plan) offerPlanCard(live, plan, planGen);
  }
  /**
   * Codex and OpenCode end a plan turn with the plan instead of asking for
   * approval the way Claude's ExitPlanMode does: the runtime asks, with the same
   * "Plan ready" card (answerControl → answerPlanCard). It is the work
   * scheduler's hold (the mailbox and continuations wait, like behind a pending
   * Claude card), is declined after the question timeout, and a new prompt
   * replaces it. `gen`: the plan turn's generation. A newer prompt, a Stop or
   * the session closing since then means its plan is not the one to approve:
   * no card.
   */
  function offerPlanCard(live, plan, gen) {
    if (gen !== live.gen || live.record.status === 'ended') { log('assistant:plan', `${live.record.id}: no plan card (a newer prompt or a Stop came after the plan turn)`); return; }
    const requestId = `plan-${randomUUID()}`;
    const packet = { type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', kind: 'plan', tool_name: 'ExitPlanMode', input: { plan } } };
    holdWork(live, { requestId, plan });
    live.pendingControls.set(requestId, packet);
    live.record.status = 'awaiting';
    armControlTimeout(live, packet);
    touch(live);
    sendToSockets(live, packet);
  }
  /** A plan card closed unanswered: an answer still on its way is refused (answerControl). */
  function rememberClosedPlanCard(live, requestId, reason) {
    live.closedPlanCards.set(requestId, reason);
    while (live.closedPlanCards.size > 20) live.closedPlanCards.delete(live.closedPlanCards.keys().next().value);
  }
  /** The runtime's plan card closes unanswered (a new prompt, a Stop, the brain gone); plan mode stays on. */
  function closePlanCard(live, reason) {
    const card = live.planCard;
    if (!card || !releaseHold(live, card.requestId)) return;
    live.pendingControls.delete(card.requestId);
    clearControlTimer(live, card.requestId);
    rememberClosedPlanCard(live, card.requestId, reason);
    if (live.record.status === 'awaiting' && !live.pendingControls.size) live.record.status = live.running ? 'running' : 'idle';
    sendToSockets(live, { type: 'control_cancelled', request_id: card.requestId, reason });
  }
  /**
   * The user approved the plan: plan mode ends here, on the approval itself —
   * the record (persisted, so a reload and History show it off), every open host
   * (broadcast), the plan gate and policy, and the dispatch refusal — not when
   * the brain reports it later. "Auto-accept edits" on the card sets the approval
   * mode the work runs in. A remote session's level can keep plan mode on
   * (read-only). Leaving plan mid-turn resets the route gate: the approved work
   * is routed first, like any other.
   */
  function approvePlan(live, decision = null) {
    const wasPlanning = isPlanningLive(live);
    const mode = decision === 'acceptEdits' || decision === 'auto' ? (live.record.brain.provider === 'claude-code' ? 'acceptEdits' : 'auto') : null;
    if (!wasPlanning && !mode) return false;
    // A plain approval changes the plan flag only (a remote session keeps the approval mode it asked for).
    live.record.brain = clampModeWrite(live, { ...live.record.brain, ...(mode ? { permissionMode: mode } : {}), planMode: false }, { fromBrain: !mode });
    touch(live);
    if (isPlanningLive(live)) return false;
    if (wasPlanning) live.gate?.startTurn({ carry: true });
    log('assistant:plan', `${live.record.id}: plan approved; plan mode off (${live.record.brain.permissionMode})`);
    const status = { type: 'event', event: { type: 'system', subtype: 'status', text: 'Plan approved: plan mode is off.' } };
    sendToSockets(live, status);
    appendTranscript(live.record.id, { at: iso(now()), packet: status });
    sendToSockets(live, { type: 'assistant:session', session: view(live), reason: 'plan_approved' });
    broadcast('assistant:session-updated', live);
    return true;
  }
  /**
   * The runtime's own plan card answered (its hold released). Approved: plan
   * mode off, then the implementation turn is queued as the scheduler's 'plan'
   * work: the next turn. "Keep planning" with a note: the brain revises the plan
   * in a 'plan' turn too (plan mode stays on). Without one nothing runs.
   */
  function answerPlanCard(live, card, response = {}, { superseded = false } = {}) {
    releaseHold(live, card.requestId);
    if (live.record.status === 'awaiting' && !live.pendingControls.size) live.record.status = live.running ? 'running' : 'idle';
    if (response.behavior === 'allow') {
      approvePlan(live, response.planDecision || null);
      if (!isPlanningLive(live)) queueWork(live, { kind: 'plan', options: { text: `[SynaBun] The user approved your plan and plan mode is off. Carry it out now, from where the conversation left off.${router ? ' Route the work first, like any task.' : ''}`, permissionMode: live.record.brain.permissionMode } });
      return;
    }
    const note = String(response.message || '').trim();
    // `superseded`: the card closed because the user wrote something else (a remote channel); their message is the feedback.
    if (note && note !== KEEP_PLANNING_DEFAULT && superseded !== true) {
      queueWork(live, { kind: 'plan', revise: true, options: { text: `[SynaBun] The user did not approve the plan yet. Revise it with their feedback (plan mode stays on):\n\n${note}`, offerPlan: true } });
      return;
    }
    const status = { type: 'event', event: { type: 'system', subtype: 'status', text: 'Plan mode stays on: tell the assistant what to change.' } };
    sendToSockets(live, status);
    appendTranscript(live.record.id, { at: iso(now()), packet: status });
    // The panel went "working" when it answered: nothing runs.
    if (!sessionBusy(live)) sendToSockets(live, { type: 'reattach_result', ok: true, sessionId: live.record.id, running: false });
  }
  /**
   * Approval and question cards are bounded: unanswered after the timeout, the
   * brain gets a decline (Codex continues with "declined"; a Claude tool is
   * denied) and the card closes as cancelled. The 2026-09-27 Codex escalation
   * card held its turn — and every worker result behind it — for 34 minutes.
   */
  function controlTimeoutMs(request = {}) {
    const tool = String(request.tool_name || request.toolName || '');
    const question = request.kind === 'question' || request.kind === 'elicitation' || tool === 'AskUserQuestion' || tool === 'ExitPlanMode';
    return question ? settings.questionTimeoutMs : settings.approvalTimeoutMs;
  }
  function armControlTimeout(live, packet) {
    const id = String(packet.request_id);
    clearControlTimer(live, id);
    const ms = controlTimeoutMs(packet.request || {});
    if (!(ms > 0)) return;
    const timer = setTimeout(() => expireControl(live, id, packet, ms), ms);
    timer.unref?.();
    live.controlTimers.set(id, timer);
  }
  function clearControlTimer(live, id) {
    const timer = live.controlTimers.get(id);
    if (timer) { clearTimeout(timer); live.controlTimers.delete(id); }
  }
  /** `keep`: a request id whose timer stays (the open plan card). */
  function clearControlTimers(live, keep = null) {
    for (const [id, timer] of live.controlTimers) {
      if (id === keep) continue;
      clearTimeout(timer);
      live.controlTimers.delete(id);
    }
  }
  /** The brain's open question cards closed unanswered (turn over, brain gone): their brief rounds close too. */
  function settleNativeQuestions(live, reason, keep = null) {
    if (!clarifier?.onNativeSettled) return;
    for (const requestId of live.pendingControls.keys()) {
      if (requestId === keep) continue;
      try { clarifier.onNativeSettled(live.record.id, requestId, reason); } catch {}
    }
  }
  function expireControl(live, id, packet, ms) {
    live.controlTimers.delete(id);
    // Answered, cancelled, or a new request reusing the id (Codex restarts ids at 0).
    if (live.pendingControls.get(id) !== packet) return;
    live.pendingControls.delete(id);
    try { clarifier?.onNativeSettled?.(live.record.id, id, 'timeout'); } catch {}
    const minutes = Math.max(1, Math.round(ms / 60_000));
    const waited = `${minutes} minute${minutes === 1 ? '' : 's'}`;
    log('assistant:control-timeout', `${live.record.id}: ${id} (${packet.request?.tool_name || packet.request?.method || 'request'}) declined after ${waited}`);
    try {
      const ask = live.computerAsk?.requestId === id ? live.computerAsk : null;
      // The turn's "control your Mac?" request: unanswered is a no for the rest of the turn.
      if (ask) settleComputerAsk(live, ask, false, { origin: 'timeout', message: `No decision within ${waited}, so computer use was not allowed for this task. Do not retry it; tell the user what you could not do.` });
      // The runtime's own plan card has no brain request behind it: plan mode just stays on.
      else if (releaseHold(live, id)) rememberClosedPlanCard(live, id, 'timeout');
      else live.brain?.respondControl?.(id, { behavior: 'deny', message: `No decision within ${waited}, so SynaBun declined this request. Continue without it, or tell the user what still needs their approval.` });
    } catch (error) { log('assistant:control-timeout-error', error?.message || String(error)); }
    sendToSockets(live, { type: 'control_cancelled', request_id: id, reason: 'timeout' });
    const status = { type: 'event', event: { type: 'system', subtype: 'status', text: `No decision within ${waited}: the request was declined.` } };
    sendToSockets(live, status);
    appendTranscript(live.record.id, { at: iso(now()), packet: status });
    if (!live.pendingControls.size && live.record.status === 'awaiting') live.record.status = live.running ? 'running' : 'idle';
    touch(live);
  }
  function onTurnFinished(live) {
    if (live.mailboxTurn) { live.mailboxTurn = false; }
    // Non-Claude brains have no Stop hook: nudge once per run when obligations remain.
    if (live.brainProvider !== 'claude-code' && live.obligations.size && !live.rememberedThisTurn) {
      for (const runId of [...live.obligations]) {
        // Stored since the run's last event (the worker, or this brain's own remember, which a
        // Codex/OpenCode brain cannot report): no reminder. dispatcher.get re-reads the run's memory.
        let stored = false;
        try { stored = !!dispatcher?.get?.(runId)?.memoryStored; } catch { stored = false; }
        if (stored) { live.obligations.delete(runId); continue; }
        if (live.nudgedRuns.has(runId)) continue;
        live.nudgedRuns.add(runId);
        enqueueMailbox(live, { kind: 'memory_due', run: dispatcher?.get?.(runId) || { runId }, text: 'No memory was stored for this completed run. Call remember (category + project + related_files + source_ref = run id) before summarizing.' });
      }
    }
    live.rememberedThisTurn = false;
    // Reactive route gate (Codex without its hook, OpenCode without its plugin):
    // the interrupted turn is followed by one system turn that tells the brain to
    // route first (or, for a browser-policy refusal, why the call was stopped), in
    // the generation the refusal happened in.
    if (live.gateNudge) {
      const nudge = live.gateNudge;
      live.gateNudge = null;
      const marker = nudge.browser ? '[SynaBun Browser]' : '[SynaBun Router]';
      queueWork(live, { kind: 'nudge', gen: nudge.gen, options: { text: `${marker} Your last tool call was stopped before it finished. ${nudge.reason}`, gateCarry: true } });
    }
    // What comes next is the scheduler's (a plan card this turn offers holds it first).
    pumpSoon(live);
    scheduleDispose(live);
  }
  function scheduleDispose(live) {
    if (live.disposeTimer) clearTimeout(live.disposeTimer);
    if (live.sockets.size || live.running) return;
    live.disposeTimer = setTimeout(() => {
      live.disposeTimer = null;
      // Pending background work re-arms this timer through the `done` of the turn
      // the CLI starts when that work reports back.
      if (live.sockets.size || sessionBusy(live) || live.brain?.hasPendingWork?.()) return;
      disposeBrain(live, 'idle').catch(() => {});
    }, settings.idleDisposeMs);
    live.disposeTimer.unref?.();
  }

  // ── work scheduler ─────────────────────────────────────────────────────────
  // One queue per session for the work the runtime starts on its own. Each kind
  // has one slot (a newer entry replaces a queued one). Work runs one at a time,
  // only while the session is free, in this order: the turn an answered plan
  // card started ('plan': the approved work, or a revision), /compact, the route
  // gate's nudge, a "do it here" continuation, then the mailbox. The open plan
  // card is the one hold: the last three wait for its answer. A compact holds
  // everything until it settles.
  //
  // Cancellation is by generation. A user Stop, closing the session and every
  // human prompt start a new one (newGeneration). Each entry, and each route
  // card's continuation still on its way from the router, carries the
  // generation it was created in and is dropped once that is stale: when it
  // would start, after every await on its way to the brain (runTurn), and when a
  // late callback arrives (routerContinue). The mailbox belongs to no turn: it is
  // never stale, and a Stop lets it go on.
  const WORK_ORDER = ['plan', 'compact', 'nudge', 'continuation'];
  const HELD_BY_PLAN_CARD = new Set(['nudge', 'continuation']);

  function workCurrent(live, entry) {
    return !!entry && (entry.gen === null || entry.gen === live.gen) && sessions.get(live.record.id) === live && live.record.status !== 'ended';
  }
  /**
   * The entry that holds the session now. One a Stop or the session closing
   * made stale holds nothing: a turn on its way drops itself at its next check
   * (its runQuery still counts as busy until then), and a compact call that
   * never returns (a disposed OpenCode serve) cannot block the session for good.
   */
  function activeWork(live) {
    return live.workActive && workCurrent(live, live.workActive) ? live.workActive : null;
  }
  /** `entry`: { kind, gen?, options? } (`gen` defaults to the current generation). */
  function queueWork(live, entry) {
    live.work.set(entry.kind, { ...entry, gen: entry.gen === undefined ? live.gen : entry.gen });
    pumpSoon(live);
  }
  function dropWork(live, ...kinds) { for (const kind of kinds) live.work.delete(kind); }
  /**
   * A human prompt ('superseded'), a user Stop ('stopped') or the session
   * closing: the queued work goes, a turn still on its way to the brain is
   * dropped at its next check, a callback for the old generation is refused,
   * and the plan card closes (an answer still on its way gets PLAN_CARD_CLOSED).
   */
  function newGeneration(live, reason) {
    live.gen += 1;
    live.work.clear();
    closePlanCard(live, reason);
    // A newer prompt, a Stop or the session closing: a route card's computer consent does not outlive it.
    dropRouteComputer(live);
  }
  /**
   * The work a human prompt must not overtake: the plan's turn (the next turn
   * once the card is answered) and a /compact, queued or running. → the
   * refusal's message, else null.
   */
  function workReserved(live) {
    const find = (kind) => live.work.get(kind) || (activeWork(live)?.kind === kind ? live.workActive : null);
    const plan = find('plan');
    if (plan) return plan.revise ? 'The plan revision runs first; send this after it.' : 'The approved plan runs first; send this after it.';
    if (find('compact')) return 'The assistant is compacting its context; send this when it is done.';
    return null;
  }
  /** The open plan card holds the queue; each way it closes releases it, once (the release that wins pumps). */
  function holdWork(live, card) { live.planCard = card; }
  function releaseHold(live, requestId) {
    if (!live.planCard || live.planCard.requestId !== requestId) return false;
    live.planCard = null;
    pumpSoon(live);
    return true;
  }
  /** Pumps once the current synchronous work is done (a turn's `done` reaches the sockets, its plan card is offered). */
  function pumpSoon(live) {
    if (live.workPumpQueued) return;
    live.workPumpQueued = true;
    queueMicrotask(() => { live.workPumpQueued = false; pumpWork(live); });
  }
  /** The first entry allowed to start (stale ones are dropped on the way), or null. */
  function nextWork(live) {
    for (const kind of WORK_ORDER) {
      const entry = live.work.get(kind);
      if (!entry) continue;
      if (!workCurrent(live, entry)) { live.work.delete(kind); continue; }
      if (live.planCard && HELD_BY_PLAN_CARD.has(kind)) continue;
      return entry;
    }
    return null;
  }
  function pumpWork(live) {
    if (live.workTimer) { clearTimeout(live.workTimer); live.workTimer = null; }
    if (shuttingDown || live.closing || sessions.get(live.record.id) !== live || live.record.status === 'ended' || activeWork(live)) return;
    const entry = nextWork(live);
    // The mailbox waits for its batch window and the plan card.
    if (!entry && !(live.mailbox.length && !live.mailboxTimer && !live.planCard)) return;
    if (sessionBusy(live)) {
      // The running turn's end pumps again; this covers a brain that frees up without one.
      live.workTimer = setTimeout(() => { live.workTimer = null; pumpWork(live); }, settings.mailboxBatchMs);
      live.workTimer.unref?.();
      return;
    }
    if (entry) startWork(live, entry);
    else if (mailboxAllowed(live)) startWork(live, { kind: 'mailbox', gen: null });
  }
  /** Runs `entry` as the session's work until it reached the brain (a turn) or settled (a compact). */
  async function startWork(live, entry) {
    live.work.delete(entry.kind);
    live.workActive = entry;
    let result = null;
    try {
      if (entry.kind === 'compact') await runCompact(live, entry);
      else if (entry.kind === 'mailbox') result = await runMailboxTurn(live);
      else result = await runQuery(live, { ...entry.options, system: true, work: entry });
    } catch (error) { log(`assistant:${entry.kind}-error`, error?.message || String(error)); }
    if (live.workActive === entry) live.workActive = null;
    // A human prompt reached the brain first: this goes after its turn.
    if (result?.code === 'ASSISTANT_BUSY' && entry.kind !== 'mailbox' && workCurrent(live, entry) && !live.work.has(entry.kind)) live.work.set(entry.kind, entry);
    // Dropped on its way (a Stop, the session closing): a panel still "working" on it hears that nothing runs.
    if (result?.code === 'TURN_CANCELLED' && !sessionBusy(live) && sessions.get(live.record.id) === live) sendToSockets(live, { type: 'reattach_result', ok: true, sessionId: live.record.id, running: false });
    pumpSoon(live);
    return result;
  }
  /**
   * /compact: session work, so nothing starts until it settles. OpenCode's call
   * returns when the compaction is over; Claude and Codex compact in a turn of
   * their own, and the brain reports busy until its `done`.
   */
  async function runCompact(live, entry) {
    const brain = live.brain;
    // No brain, nothing to compact: the panel that asked stops "compacting…".
    if (!brain?.compact) { entry.reply?.({ type: 'reattach_result', ok: true, sessionId: live.record.id, running: !!live.running || (Number(live.turnPending) || 0) > 0 }); return; }
    try { await brain.compact(); }
    catch (error) {
      const packet = { type: 'error', message: error?.message || String(error) };
      if (entry.reply) entry.reply(packet); else sendToSockets(live, packet);
    }
  }

  // ── brains ─────────────────────────────────────────────────────────────────
  function dispatchSpend(sessionId) {
    try { return dispatcher ? Number(dispatcher.totals({ assistantSessionId: sessionId }).costUsd) || 0 : 0; } catch { return 0; }
  }
  /** The brain's own spend in a session (the dispatcher adds it to the session total). */
  function brainSpend(sessionId) { return Number(sessions.get(sessionId)?.record.costUsd) || 0; }
  /** Brain cap (USD per session): the Budget tab's value, read live. */
  function brainCapUsd() {
    try { const value = Number(configStore?.budget?.().brainUsd); if (value > 0) return value; } catch {}
    return settings.maxBudgetUsd;
  }
  function sessionMoney(sessionId) {
    try { return dispatcher?.sessionBudget?.(sessionId) || null; } catch { return null; }
  }
  /**
   * How the brain's spend is known: 'reported' (Claude; OpenCode with a list
   * price), 'estimated' (Codex tokens at list price), 'free', or null (no
   * price: the dollar caps could not hold it).
   */
  function brainCostBasis(live) {
    const brain = live.record.brain || {};
    if (brain.provider === 'claude-code') return 'reported';
    const info = brainCapabilities(live.record) || {};
    if (brain.provider === 'codex') {
      if (!pricing?.codexPrice) return null;
      try { return pricing.codexPrice(brain.model || info.id || null) ? 'estimated' : null; } catch { return null; }
    }
    if (info.price?.basis === 'free') return 'free';
    return info.price ? 'reported' : null;
  }
  function codexBrainPrice(live) {
    const brain = live.record.brain || {};
    try { return pricing?.codexPrice?.(brain.model || brainCapabilities(live.record)?.id || null) || null; } catch { return null; }
  }
  function sendCost(live) {
    const budget = sessionMoney(live.record.id);
    const basis = brainCostBasis(live);
    sendToSockets(live, { type: 'assistant:cost', sessionUsd: live.record.costUsd, dispatchUsd: dispatchSpend(live.record.id), budget, brainCapUsd: brainCapUsd(), brainMetered: basis !== null, brainCostBasis: basis });
  }
  /**
   * Why the brain may not start a turn: the session's hard cap (brain + agents)
   * or the brain cap, checked before every turn. A turn already running
   * finishes; the Claude CLI also gets the remaining brain budget as its own cap.
   */
  function brainBudgetBlock(live) {
    // Fail closed: a brain whose spend has no price could spend past every cap.
    if (pricing && brainCostBasis(live) === null) {
      const model = live.record.brain?.model || brainCapabilities(live.record)?.id || 'its default model';
      return { code: 'BRAIN_UNPRICED', message: `No price is known for the ${live.record.brain?.provider || ''} brain model ${model}, so the budget caps cannot hold its spend. Pick a priced or free model for the brain.` };
    }
    const money = sessionMoney(live.record.id);
    if (money && money.totalUsd >= money.hardUsd) {
      return { code: 'SESSION_BUDGET_EXCEEDED', message: `This session spent ${usd(money.totalUsd)} (brain ${usd(money.brainUsd)} + agents ${usd(money.dispatchUsd)}), at its hard cap of ${usd(money.hardUsd)}. Raise the cap in ⋯ → Budget… to continue.` };
    }
    const cap = brainCapUsd();
    const spent = Number(live.record.costUsd) || 0;
    if (spent >= cap) return { code: 'BRAIN_BUDGET_EXCEEDED', message: `The brain spent ${usd(spent)} in this session, at its cap of ${usd(cap)}. Raise the brain cap in ⋯ → Budget… to continue.` };
    return null;
  }
  /** The Budget tab saved new caps: held mailbox items may go now, and every open panel refreshes its chip. */
  function onBudgetChanged() {
    for (const live of sessions.values()) {
      if (live.record.status === 'ended') continue;
      try { dispatcher?.checkSession?.(live.record.id); } catch {}
      sendCost(live);
      if (live.mailbox.length && !brainBudgetBlock(live)) { live.budgetHoldNotified = false; scheduleMailbox(live, 0); }
    }
  }
  async function personaFor(live) {
    const brain = live.record.brain;
    let catalogValue = {};
    try { catalogValue = typeof buildCatalog === 'function' ? (await buildCatalog({ compact: true })) || {} : {}; } catch {}
    let routingCfg = { preferences: {}, askBelow: 0.75 };
    try { routingCfg = configStore?.routing?.() || routingCfg; } catch {}
    let sheet = null;
    try { if (catalogValue?.models) sheet = selectSheetModels(catalogValue, { brain, preferences: routingCfg.preferences || {}, max: 8 }); } catch {}
    let setupState = null;
    try { setupState = desktop?.setupState?.() || null; } catch {}
    return buildAssistantPersona({
      assistantSessionId: live.record.id,
      brain,
      project: live.record.project || 'global',
      toolPrefix: brain.provider === 'claude-code' ? 'mcp__SynaBun__' : 'SynaBun_',
      catalog: { models: catalogValue.models || {}, accounts: catalogValue.accounts || {}, projects: catalogValue.projects || [], profiles: catalogValue.profiles || catalogValue.mcpProfiles?.presets || [] },
      limits: dispatcher?.refreshLimits?.() || dispatcher?.limits || {},
      defaults: settings.defaultBrain,
      extra: settings.personaExtra,
      hasAskUserQuestion: brain.provider === 'claude-code',
      routing: router ? { mode: routingView(live.record).effectiveMode, askBelow: routingCfg.askBelow, preferences: routingCfg.preferences || {} } : null,
      sheet,
      opencodeTotal: catalogValue.opencodeTotal ?? null,
      hiddenTotal: Object.values(catalogValue.hiddenRows || {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0),
      brainInfo: brainCapabilities(live.record),
      // A remote session: what remoteComputerUse says for it (a turn with untrusted content is asked either way).
      computer: { available: computerSupported(), enabled: computerEffective(live.record), setupState, remote: computerDecision(live, { untrusted: false }) },
      taskClasses: TASK_CLASS_META,
      clarify: !!clarifier,
      channel: live.record.channel || live.record.remote?.channel || null,
    });
  }
  /**
   * The session's brain, starting it if needed → the brain, or null when this
   * start went stale (a close came after it began or is under way, or the
   * runtime shuts down): the caller drops its turn (runTurn). Checked when it
   * begins and after every await: a stale start assigns nothing, and a start
   * never replaces a brain another start of the session assigned meanwhile.
   */
  async function ensureBrain(live) {
    if (live.brain) return live.brain;
    const startGen = live.gen;
    const stale = () => shuttingDown || !!live.closing || live.closedGen > startGen;
    if (stale()) return null;
    // A remote session's brain starts at the modes its level allows.
    const remote = remotePolicyFor(live);
    if (remote) live.record.brain = clampedBrain(live, live.record.brain);
    const brain = live.record.brain;
    const sink = { send: (packet) => onBrainPacket(live, packet) };
    const persona = await personaFor(live);
    if (stale()) return null;
    if (live.brain) return live.brain;
    live.personaText = persona;
    // Computer use: one unforgeable grant per brain (the MCP `computer` group is
    // advertised only to callers presenting it). Revoked when the brain goes.
    // A remote session's Claude brain gets one only when remoteComputerUse does
    // not say "off" for it, and it is minted HELD: it resolves to nothing until
    // a turn may use the computer (syncComputerGrant). Codex / OpenCode: never.
    const computerMode = remote ? (brain.provider === 'claude-code' ? computerDecision(live, { untrusted: false })?.state || 'off' : 'off') : null;
    if ((!remote || computerMode !== 'off') && !live.desktopGrant && computerSupported() && desktop?.mintGrant) {
      try {
        const info = brainCapabilities(live.record);
        live.desktopGrant = desktop.mintGrant({
          kind: 'brain', assistantSessionId: live.record.id, runId: null, provider: brain.provider, model: brain.model || null, vision: info?.vision ?? null,
          ...(remote ? { held: true, remote: { channel: live.record.remote?.channel || live.record.channel || 'whatsapp' } } : {}),
        });
        live.computerGrantLive = false;
      } catch (error) { log('assistant:desktop-grant-error', error?.message || String(error)); }
    }
    const deps = {
      ClaudeSession, sdkVersion, PACKAGE_ROOT, handleCodexSkinWebSocket, ensureIsolatedServe, stopIsolatedServe, setupOpencodeSidepanelConfig,
      claudeAccountEnv: (accountId) => (claudeAccounts?.envFor?.(accountId) || {}),
      // The Claude CLI caps this process at what the session's brain budget has left.
      maxBudgetUsd: Math.max(0.1, Math.round((brainCapUsd() - (Number(live.record.costUsd) || 0)) * 100) / 100),
      // A Codex brain reports tokens: priced at the list price of its model (estimated).
      priceCodexUsage: (usage) => {
        const price = codexBrainPrice(live);
        if (!price) return null;
        // An "[extended]" window is priced at the long-context rate (never under-counted).
        const info = brainCapabilities(live.record) || {};
        const extended = /\[extended\]$/.test(String(live.record.brain?.model || info.id || ''));
        return codexUsageCostUsd(usage, price, { contextWindow: extended ? info.contextWindow || null : null });
      },
      onCodexThread: (threadId) => { if (threadId) live.record.providerThreadId = threadId; if (live.turnTaskId) pollCodex(live, { force: true }); },
      onCodexUsage: () => { if (live.turnTaskId) pollCodex(live); },
      onOpenCodeEvent: (type, event) => openCodeEvent(live, type, event),
      // Also a resume into another session: what the meter counts as the main loop follows it.
      onOpenCodeRoot: (sessionId) => { live.record.providerSessionId = sessionId; metered('meter-state', () => live.brainMeter?.setRoot?.(sessionId)); saveMeter(live); },
      desktopGrant: live.desktopGrant || null,
      // A remote session's level (lib/remote-policy.js): the Claude brain allows
      // bypass only at autonomous. null for a desktop session.
      remoteLevel: remote ? effectiveLevel(remote, { now: now() }) : null,
      // Plan mode stays read-only at a remote session's read-only level (read at every call).
      planReadOnly: () => planReadOnly(live),
      // A Codex / OpenCode brain of a remote session is read-only for good: the
      // read-only sandbox (Codex), the plan agent (OpenCode), no auto-accept.
      remoteReadOnly: !!remote && remoteBrainLimited(brain.provider),
    };
    const gate = ensureGate(live);
    // A remote session's hook / plugin refuses a call it could not check (fail closed).
    if (gate && brain.provider === 'opencode' && gateUrl) deps.routeGate = { url: gateUrl, session: live.record.id, token: live.gateToken, ...(remote ? { remote: true } : {}) };
    if (gate && brain.provider === 'codex') {
      deps.routeGate = gateUrl
        ? () => codexGateBootstrap({ url: gateUrl, session: live.record.id, token: live.gateToken, codexBin: typeof codexBin === 'function' ? codexBin() : codexBin, ...(remote ? { remote: true } : {}) })
        : async () => null;
    }
    const factories = brainFactories || { 'claude-code': createClaudeBrain, codex: createCodexBrain, opencode: createOpenCodeBrain };
    const factory = factories[brain.provider];
    if (!factory) throw new Error(`Unsupported brain provider ${brain.provider}`);
    const memoryHooks = brain.provider === 'claude-code' && memory?.claudeHooks ? memory.claudeHooks({
      session: live.record.id, project: live.record.project || 'global',
      getGeneration: () => live.record.memoryGeneration || 1,
      bumpGeneration: () => { live.record.memoryGeneration = (live.record.memoryGeneration || 1) + 1; touch(live); },
      markRemembered: () => { live.rememberedThisTurn = true; live.obligations.clear(); },
      hasPendingObligations: () => live.obligations.size > 0 && !live.rememberedThisTurn,
      onRecall: (recalled) => { if (recalled?.results?.length || recalled?.alreadyPresent) sendToSockets(live, { type: 'event', event: { type: 'synabun.memories', memories: recalled.results || [], alreadyPresent: !!recalled.alreadyPresent } }); },
      describeTurn: (text) => describeTurn(live, text),
    }) : null;
    // Claude: memory, the route gate, the browser policy (every session: plan mode and subagents too), a remote session's hook.
    const claude = brain.provider === 'claude-code';
    const hooks = mergeHooks(mergeHooks(mergeHooks(memoryHooks, claude && gate ? gateHooks(live) : null), claude ? browserHooks(live) : null), claude && (remote || live.record.remote) ? remoteHooks(live) : null);
    live.brainProvider = brain.provider;
    startMeter(live, brain.provider);
    const created = factory({ session: live.record, sink, deps, persona, hooks });
    live.brain = created;
    live.brainSkipAllowed = remote ? deps.remoteLevel === 'autonomous' : null;
    live.brainComputerMode = computerMode;
    live.brainRemoteReadOnly = deps.remoteReadOnly === true;
    live.record.status = 'idle';
    touch(live);
    try { await created.start?.(); } catch (error) {
      log('assistant:brain-start-error', error?.message || String(error));
      // A brain a close already took (disposed while it started) is not the session's any more.
      if (live.brain === created) {
        sendToSockets(live, { type: 'error', message: `Brain failed to start: ${error?.message || error}` });
        await disposeBrain(live, 'start_failed').catch(() => {});
      }
      throw error;
    }
    // Stale now: the close (or the shutdown) disposes it as the session's brain (disposeBrain), once.
    return stale() ? null : created;
  }
  async function disposeBrain(live, reason = 'closed') {
    const brain = live.brain;
    if (!brain) return;
    while (live.openCodeFinalizing) await live.openCodeFinalizing;
    try {
      const identity = brain.identity?.() || {};
      if (identity.providerSessionId) live.record.providerSessionId = identity.providerSessionId;
      if (identity.providerThreadId) live.record.providerThreadId = identity.providerThreadId;
    } catch {}
    live.brain = null;
    if (live.brainProvider === 'codex') pollCodex(live, { force: true });
    // No further turn will book them: a Claude brain's provisional tokens are booked as an estimate,
    // any other brain's go (Codex was just polled, OpenCode settled at its turn's end).
    if (live.brainMeterProvider === 'claude-code') settleClaudeEstimate(live, 'no-result');
    metered('dispose', () => { live.brainMeter?.clearPending?.(); usage?.clearPending?.(live.record.id, 'brain'); });
    saveMeter(live);
    live.brainMeter = null;
    live.brainMeterProvider = null;
    live.turnTasks.length = 0;
    live.turnTaskId = null;
    live.running = false;
    closePlanCard(live, 'brain_disposed');
    live.planTurn = false;
    // A remote session's computer use ends with its brain: the turn's approval, its open request, the live grant.
    endComputerTurn(live, reason === 'closed' ? 'session_closed' : 'brain_disposed');
    settleNativeQuestions(live, 'brain_disposed');
    live.pendingControls.clear();
    clearControlTimers(live);
    try { await brain.dispose?.(); } catch (error) { log('assistant:brain-dispose-error', error?.message || String(error)); }
    // The next brain reports its own routing reach, and its own OpenCode serve says hello again.
    live.gatePluginAt = null;
    live.gate?.setUnavailable(null);
    if (live.desktopGrant) {
      try { desktop?.revokeFor?.({ token: live.desktopGrant }); } catch {}
      try { desktop?.releaseOwner?.({ assistantSessionId: live.record.id }); } catch {}
      live.desktopGrant = null;
    }
    live.computerGrantLive = false;
    live.brainComputerMode = null;
    // A "do it here" continuation goes with its brain; the plan's turn does not (it starts the next brain).
    dropWork(live, 'continuation');
    try { router?.cancelForSession?.(live.record.id, reason === 'closed' ? 'session_closed' : 'brain_disposed', { origins: ['agent_route', 'vision_guard'] }); } catch {}
    // Clarify cards outlive a brain (the answers reach the next one as a mailbox turn), not the session.
    if (reason === 'closed') { try { clarifier?.cancelForSession?.(live.record.id, 'session_closed'); } catch {} }
    live.record.status = reason === 'closed' ? 'ended' : 'idle';
    touch(live);
    sendToSockets(live, { type: 'assistant:session', session: view(live), reason });
    // Work that waited for the old brain (a busy one) can start the next.
    pumpSoon(live);
  }

  // ── turns ──────────────────────────────────────────────────────────────────
  /** A vision model on the brain's own provider for a turn carrying images the brain cannot see. */
  function visionGuard(live) {
    const info = brainCapabilities(live.record);
    if (!info || info.vision !== false) return null;
    const provider = live.record.brain.provider;
    let pref = null;
    try { pref = configStore?.routing?.().preferences?.vision || null; } catch {}
    if (pref?.provider === provider && pref.model && !hiddenBrainModel(provider, pref.model)) return { model: pref.model, effort: pref.effort || null, label: pref.label || pref.model };
    const value = catalog?.peek?.();
    const rows = (value?.models?.[provider] || []).filter((row) => row.vision === true && row.status !== 'unavailable');
    rows.sort((a, b) => (a.price?.output ?? Number.POSITIVE_INFINITY) - (b.price?.output ?? Number.POSITIVE_INFINITY));
    return rows[0] ? { model: rows[0].id, effort: null, label: rows[0].label || rows[0].id } : null;
  }
  function emitRouteEvent(live, phase, route) {
    const packet = { type: 'event', event: { type: 'synabun.route', phase, route } };
    sendToSockets(live, packet);
    if (phase !== 'card') appendTranscript(live.record.id, { at: iso(now()), packet });
  }

  /**
   * The turn a Claude brain's UserPromptSubmit hook is looking at: the exact
   * text runQuery sent, else — when exactly one turn is pending — the one whose
   * prompt the text contains. Used once; null for turns the CLI starts itself
   * (the hook then classifies the text on its own).
   */
  function describeTurn(live, text) {
    const key = String(text ?? '').trim();
    const pending = live.turnMeta;
    if (!key || !pending?.size) return null;
    if (pending.has(key)) { const meta = pending.get(key); pending.delete(key); return meta; }
    if (pending.size === 1) {
      const [onlyKey, meta] = pending.entries().next().value;
      if (meta?.prompt && key.includes(String(meta.prompt).trim())) { pending.delete(onlyKey); return meta; }
    }
    return null;
  }

  /**
   * A turn refused before it reached the brain → { ok:false, code, message }.
   * A prompt a socket sent (`request`: { id, reply }) is answered to that socket
   * alone, with its request id: other hosts never saw the prompt, and the panel
   * puts the text back in its composer. Otherwise every socket hears it, except
   * ASSISTANT_BUSY: its caller (submit, the scheduler) has the result and
   * retries, so no host hears an error for a message it did not send.
   */
  function refuse(live, code, message, { packet = { type: 'error', code, message }, request = null } = {}) {
    if (request?.reply) request.reply(request.id ? { ...packet, request_id: request.id } : packet);
    else if (code !== 'ASSISTANT_BUSY') sendToSockets(live, packet);
    return { ok: false, code, message };
  }
  const BUSY_MESSAGE = 'The assistant is still working; wait for the turn to finish or abort it.';
  /**
   * A turn dropped on its way to the brain (its generation went stale, or its
   * session closed). A prompt a socket sent is answered to that socket, with
   * its request id: the panel puts the text back.
   */
  function dropTurn(live, request = null) {
    log('assistant:work', `${live.record.id}: a turn was cancelled before it reached the brain`);
    const message = 'The turn was cancelled before it started.';
    if (request?.reply) request.reply({ type: 'error', code: 'TURN_CANCELLED', message: 'The session was closed before this message reached the assistant.', ...(request.id ? { request_id: request.id } : {}) });
    return { ok: false, code: 'TURN_CANCELLED', message };
  }
  /**
   * One turn → { ok:true } or { ok:false, code, message }. Busy from entry to
   * end (turnPending): the prompt prefix awaits before `running` is set, and
   * the scheduler must not start a turn meanwhile.
   */
  async function runQuery(live, options = {}) {
    if (!options.system) {
      // A human prompt is refused before it supersedes anything: while the session
      // closes, before the approved plan's turn or a compact, behind another prompt
      // still on its way to the brain (prompts reach it in the order they came),
      // and while a Codex / OpenCode brain is mid-turn.
      if (live.closing) return refuse(live, 'SESSION_ENDED', 'This assistant session is closing.', { request: options.request });
      const reserved = workReserved(live)
        || (live.prompting !== null ? 'Another message is still on its way to the assistant; send this after it.' : null)
        || (live.running && live.brainProvider !== 'claude-code' ? BUSY_MESSAGE : null);
      if (reserved) return refuse(live, 'ASSISTANT_BUSY', reserved, { request: options.request });
      // A new generation, before anything awaits (recall, the catalog, the brain):
      // the plan card it replaces closes now, so an approval still on its way
      // cannot approve the plan this prompt supersedes (answerControl refuses
      // it), and the old turn's queued work (a "do it here" continuation) goes.
      newGeneration(live, 'superseded');
      live.prompting = live.gen;
    }
    // The generation the turn entered in: a close after it drops the turn (runTurn),
    // and its count (endSessionWork zeroed it).
    const turnGen = live.gen;
    live.turnPending = (Number(live.turnPending) || 0) + 1;
    try { return await runTurn(live, { ...options, turnGen }); }
    finally {
      if (live.closedGen <= turnGen) live.turnPending = Math.max(0, (Number(live.turnPending) || 1) - 1);
      if (!options.system && live.prompting === turnGen) live.prompting = null;
      pumpSoon(live);
    }
  }
  // `authority`: the WhatsApp bridge's capability; it alone makes a prompt count as the owner's own
  // plain message from the phone (fromPhone). `origin` below is audit text and decides nothing.
  // `origin`: who wrote a human prompt ('ui', 'whatsapp', 'api'); `untrusted`: its
  // text carries content the owner did not write (a remote session caps it at ask).
  // `offerPlan`: a system turn that revises a plan still ends with a plan card.
  // `work`: the scheduler entry this system turn is; `request`: { id, reply } of a
  // prompt a socket sent (refuse); `turnGen`: the generation runQuery entered in.
  async function runTurn(live, { text, images = [], cwd = null, model = null, effort = null, permissionMode = null, planMode = null, system = false, taskId = null, turnModel = null, turnEffort = null, gateOpen = false, gateCarry = false, origin = null, authority = null, untrusted = false, offerPlan = false, work = null, request = null, turnGen = live.gen, computerRoutes = null } = {}) {
    const prompt = String(text || '').trim();
    if (!prompt && !(Array.isArray(images) && images.length)) return refuse(live, 'EMPTY_PROMPT', 'No prompt provided', { packet: { type: 'error', message: 'No prompt provided' }, request });
    // The scheduler's turn goes once a Stop, the session closing or a newer
    // prompt made its generation stale. Any turn goes once its session closed
    // after it entered (a prompt still being set up and the mailbox too: a Stop
    // lets those run) or ended.
    // Checked after every await, the last time right before the brain gets it.
    const cancelled = () => live.closedGen > turnGen || (work ? !workCurrent(live, work) : sessions.get(live.record.id) !== live || live.record.status === 'ended');
    // The brain never switches onto, or runs a turn on, a model the user hid.
    const refused = [model && model !== live.record.brain.model ? model : null, turnModel].find((m) => m && hiddenBrainModel(live.record.brain.provider, m));
    if (refused) {
      const message = turnModel === refused
        ? `This turn did not run: ${refused} is disabled in the Assistant's Models list. Pick an enabled model, or enable it in ⋯ → Models….`
        : modelDisabledError(refused).message;
      return refuse(live, 'MODEL_DISABLED', message, { request });
    }
    // A cold catalog must not read as "no price": build it before judging the brain's price.
    if (pricing && live.record.brain?.provider !== 'claude-code' && catalog?.full && !catalog.peek?.()) {
      try { await catalog.full(); } catch {}
      if (cancelled()) return dropTurn(live, request);
    }
    const budgetBlock = brainBudgetBlock(live);
    if (budgetBlock) return refuse(live, budgetBlock.code, budgetBlock.message, { request });
    // A remote session: a human prompt sets the trust of this turn and the ones it leads to.
    const remote = remotePolicyFor(live);
    if (!system) live.turnUntrusted = untrusted === true;
    // A Claude brain its CLI cap stopped restarts with the budget it has now.
    if (live.brainCapHit && live.brain && !live.running) {
      live.brainCapHit = false;
      await disposeBrain(live, 'budget');
      if (cancelled()) return dropTurn(live, request);
    }
    // A Claude brain built for another remote level restarts (resuming its conversation).
    if (live.brain && !live.running && brainNeedsRestart(live)) {
      await disposeBrain(live, 'policy');
      if (cancelled()) return dropTurn(live, request);
    }
    const brain = await ensureBrain(live);
    if (!brain || cancelled()) return dropTurn(live, request);
    // The last OpenCode turn's tokens are still being read back: no new turn mid-reconcile.
    if (live.openCodeFinalizing) {
      while (live.openCodeFinalizing) await live.openCodeFinalizing;
      if (cancelled()) return dropTurn(live, request);
    }
    // A remote session on OpenCode runs only once its gate plugin is loaded: the
    // plugin is what refuses web fetch / search and the denylist before a call runs.
    if (remote && live.brainProvider === 'opencode') {
      const ready = await remoteGateReady(live);
      if (cancelled()) return dropTurn(live, request);
      if (!ready) {
        log('assistant:remote-policy', `${live.record.id}: the OpenCode gate plugin did not load; turn refused`);
        return refuse(live, 'REMOTE_GATE_MISSING', 'SynaBun could not load its safety plugin into OpenCode, so this WhatsApp conversation does not run on it. Switch the WhatsApp brain to Claude, or restart SynaBun and try again.', { request });
      }
    }
    if (live.running && live.brainProvider !== 'claude-code') {
      return refuse(live, 'ASSISTANT_BUSY', BUSY_MESSAGE, { packet: { type: 'error', message: BUSY_MESSAGE, code: 'ASSISTANT_BUSY' }, request });
    }
    let finalText = prompt;
    if (!system) {
      live.lastPrompt = prompt;
      // A prompt from elsewhere (WhatsApp, the API) is news to the panel: it goes live too.
      const promptPacket = { type: 'event', event: { type: 'synabun.user_prompt', text: prompt, images: images.length, ...(origin && origin !== 'ui' ? { origin: String(origin) } : {}) } };
      appendTranscript(live.record.id, { at: iso(now()), packet: promptPacket });
      if (origin && origin !== 'ui') sendToSockets(live, promptPacket);
      if (live.brainProvider !== 'claude-code' && memory?.recallForPrompt) {
        let recalled = null;
        try { recalled = await memory.recallForPrompt({ prompt, project: live.record.project, session: live.record.id, generation: live.record.memoryGeneration || 1 }); } catch {}
        // Closed while it recalled: the session that reopened hears nothing of this prompt, and its record keeps what came since.
        if (cancelled()) return dropTurn(live, request);
        try {
          if (recalled?.results?.length || recalled?.alreadyPresent) sendToSockets(live, { type: 'event', event: { type: 'synabun.memories', memories: recalled.results || [], alreadyPresent: !!recalled.alreadyPresent } });
          if (recalled?.block) finalText = `${recalled.block}\n\n${prompt}`;
        } catch {}
      }
      if (model || effort || cwd || permissionMode || typeof planMode === 'boolean') {
        const next = { ...live.record.brain };
        if (model) next.model = model;
        if (effort) next.effort = effort;
        if (model || effort) next.effort = brainEffort(next.provider, next.model, next.effort);
        if (cwd) { next.cwd = cwd; live.record.project = detectProject(cwd) || 'global'; }
        if (permissionMode) Object.assign(next, brainModeUpdate(next, permissionMode));
        if (typeof planMode === 'boolean') next.planMode = planMode;
        live.record.brain = permissionMode || typeof planMode === 'boolean' ? clampModeWrite(live, next) : next;
        touch(live);
      }
      // Route mode / remembered routes changed since the brain last saw them.
      if (router?.stamp) {
        try {
          const stamp = router.stamp(live.record.id);
          if (stamp?.changed) {
            // After the recalled-memories block (it stays first), before the prompt.
            finalText = finalText.endsWith(prompt) ? `${finalText.slice(0, finalText.length - prompt.length)}${stamp.text}\n\n${prompt}` : `${stamp.text}\n\n${finalText}`;
            stamp.commit();
          }
        } catch {}
      }
      // A new request cycle. Open clarify questions make this message the
      // user's reply (assistant-clarify.js); otherwise the last brief retires.
      live.promptCycle += 1;
      let clarified = null;
      try { clarified = clarifier?.onUserPrompt?.(live.record.id, { text: prompt, cycle: live.promptCycle }) || null; } catch { clarified = null; }
      if (clarified?.note) {
        finalText = finalText.endsWith(prompt) ? `${finalText.slice(0, finalText.length - prompt.length)}${clarified.note}\n\n${prompt}` : `${clarified.note}\n\n${finalText}`;
      }
      // A human prompt is a new task; the reply to a clarify question stays in the one that asked.
      if (usage) taskId = clarified?.note
        ? (live.record.taskId || ensureTaskId(live.record.id))
        : metered('task', () => usage.beginTask(live.record.id, { title: prompt.split('\n')[0].slice(0, 80), at: now() })?.id);
      // An image the brain's model cannot see: run this turn on a vision model
      // of the same provider (the conversation stays in the same session).
      if (Array.isArray(images) && images.length && !turnModel) {
        const guard = visionGuard(live);
        if (guard) {
          turnModel = guard.model;
          turnEffort = guard.effort;
          emitRouteEvent(live, 'auto', {
            routeId: `route-vision-${now()}`, runIds: [], taskClass: 'chat', taskClassLabel: 'Screenshots & images', summary: 'Image attached',
            confidence: null, reason: 'The current model cannot see images, so this turn runs on a model that can.',
            target: { kind: 'direct', provider: live.record.brain.provider, model: guard.model, effort: guard.effort, label: guard.label, vision: true },
            alternatives: [], decidedBy: 'rule', remembered: false, optionId: null, corrections: [],
          });
        }
      }
    }
    // A brain already on a model the user hid since keeps running, with a warning (once per model).
    const ownModel = live.record.brain.model || null;
    if (!turnModel && ownModel && live.hiddenModelWarned !== ownModel && hiddenBrainModel(live.record.brain.provider, ownModel)) {
      live.hiddenModelWarned = ownModel;
      sendToSockets(live, { type: 'event', event: { type: 'system', subtype: 'status', text: `This Assistant runs on ${ownModel}, which is disabled in the Models list. It keeps running; pick another model to switch.` } });
    }
    // The last check: from here on the turn is the brain's.
    if (cancelled()) return dropTurn(live, request);
    if (usage) {
      taskId ||= live.record.taskId || ensureTaskId(live.record.id);
      // record.taskId is the latest human task: a system turn that carries its own names only its turn.
      if (!system || !live.record.taskId) live.record.taskId = taskId;
      // The Claude CLI queues a prompt sent mid-turn: the turn in flight keeps its task (the FIFO's front).
      if (live.brainProvider === 'claude-code' && taskId) { live.turnTasks.push(taskId); live.turnTaskId = live.turnTasks[0]; }
      else live.turnTaskId = taskId;
      scheduleUsage(live.record.id);
    }
    // A remote session runs every turn at what its level allows now (an expired
    // autonomous window, an untrusted prompt): the modes go to the brain with the turn.
    if (remote) live.record.brain = clampedBrain(live, live.record.brain);
    // A Codex / OpenCode plan turn ends with the plan, not an approval request: the runtime asks.
    // (runQuery already closed the plan card this turn replaces.)
    live.planTurn = live.brainProvider !== 'claude-code' && live.record.brain.planMode === true && !remote && (!system || offerPlan === true);
    live.planTurnGen = live.gen;
    live.planText = '';
    // A remote session: this turn's computer use starts from nothing (no approval carries over).
    beginComputerTurn(live, { unasked: !system && fromPhone(authority) && untrusted !== true && !(Array.isArray(images) && images.length) });
    // …except the owner's yes to the route card this mailbox turn executes, when that card said the Mac will be controlled.
    if (system && Array.isArray(computerRoutes) && computerRoutes.length) claimRouteComputer(live, computerRoutes);
    live.running = true;
    live.record.status = 'running';
    live.record.lastActiveAt = iso(now());
    live.turnStartedMs = now();
    live.record.turns = (Number(live.record.turns) || 0) + 1;
    if (isDefaultSessionTitle(live.record.title)) {
      if (!system) { live.record.title = clip(prompt.split('\n')[0], 60); broadcast('assistant:session-updated', live); }
    }
    touch(live);
    // Every turn names its model: the brain was built from an older snapshot of
    // the record, and routed/continuation turns override it for one turn only.
    const effectiveModel = turnModel || live.record.brain.model || null;
    const effectiveEffort = brainEffort(live.record.brain.provider, effectiveModel, turnEffort || live.record.brain.effort || null);
    // The Claude brain recalls in its UserPromptSubmit hook, which sees only the
    // final text: record who wrote it (mailbox / router = system) and the user's
    // own words, so a router-stamped first turn recalls on the prompt itself.
    if (live.brainProvider === 'claude-code' && finalText.trim()) {
      live.turnMeta.delete(finalText.trim());
      live.turnMeta.set(finalText.trim(), { system: !!system, prompt: system ? null : prompt });
      while (live.turnMeta.size > 8) live.turnMeta.delete(live.turnMeta.keys().next().value);
    }
    // Every turn starts unrouted; a continuation or a route_decided "here" turn starts open.
    // Plan mode never routes: the brain explores read-only (the plan policy) and
    // the approved plan is routed on the next turn.
    ensureGate(live)?.startTurn({ open: gateOpen || live.record.brain?.planMode === true, carry: gateCarry });
    try {
      await brain.sendUserTurn({ text: finalText, images, cwd, model: effectiveModel, effort: effectiveEffort, permissionMode: permissionMode || remote ? live.record.brain.permissionMode : null, planMode: live.record.brain.planMode === true });
    } catch (error) {
      live.running = false;
      endComputerTurn(live, 'turn_failed');
      // The prompt never reached the brain: its task leaves the FIFO, a turn still in flight keeps its own.
      const queued = live.turnTasks.lastIndexOf(taskId);
      if (queued >= 0) live.turnTasks.splice(queued, 1);
      live.turnTaskId = live.turnTasks[0] || null;
      scheduleUsage(live.record.id);
      live.planTurn = false;
      live.record.status = 'idle';
      const message = error?.message || String(error);
      sendToSockets(live, { type: 'error', message });
      sendToSockets(live, { type: 'done', code: 1 });
      return { ok: false, code: 'TURN_FAILED', message };
    }
    return { ok: true };
  }

  /** The OpenCode serve of a remote session loaded the gate plugin (its hello), waiting up to remoteGateHelloMs. */
  async function remoteGateReady(live) {
    if (!live.gate || !gateUrl) return false;
    // Wall-clock time: an injected clock may stand still.
    const deadline = Date.now() + settings.remoteGateHelloMs;
    while (live.gatePluginAt == null) {
      if (Date.now() >= deadline) return false;
      await new Promise((done) => { const timer = setTimeout(done, 25); timer.unref?.(); });
    }
    return true;
  }

  // ── mailbox ────────────────────────────────────────────────────────────────
  function enqueueMailbox(live, item) {
    live.mailbox.push({ ...item, at: iso(now()) });
    if (live.mailbox.length > 40) live.mailbox.splice(0, live.mailbox.length - 40);
    scheduleMailbox(live);
  }
  /** Items that arrive together go in one turn: the scheduler delivers them once this window closes. */
  function scheduleMailbox(live, delay = settings.mailboxBatchMs) {
    if (!live.mailbox.length || live.mailboxTimer) return;
    live.mailboxTimer = setTimeout(() => { live.mailboxTimer = null; pumpWork(live); }, delay);
    live.mailboxTimer.unref?.();
  }
  /**
   * A result / needs_input item for a turn the brain already read with
   * agent_wait, agent_read or agent_status (the dispatcher's delivery mark).
   * Every other kind (memory_due, permission, route_*, stalled, budget…) is
   * always delivered.
   */
  function alreadyRead(item) {
    if (!item || (item.kind !== 'result' && item.kind !== 'needs_input')) return false;
    const turn = Number(item.turn);
    if (!Number.isFinite(turn) || turn <= 0 || !item.run?.runId) return false;
    let mark = null;
    try { mark = dispatcher?.deliveryState?.(item.run.runId) || null; } catch { mark = null; }
    return !!mark && Number(mark.turn) >= turn;
  }
  /** Out of money: the events wait (the Budget tab re-schedules them after a raise), said once. */
  function mailboxAllowed(live) {
    const budgetBlock = brainBudgetBlock(live);
    if (!budgetBlock) return true;
    if (!live.budgetHoldNotified) {
      live.budgetHoldNotified = true;
      sendToSockets(live, { type: 'error', code: budgetBlock.code, message: `${budgetBlock.message} ${live.mailbox.length} agent event${live.mailbox.length === 1 ? '' : 's'} will reach the brain after that.` });
    }
    return false;
  }
  /** The mailbox now, if the scheduler would start it (no batch window: it is asked for). */
  function deliverMailbox(live) {
    if (shuttingDown || live.closing || !live.mailbox.length || sessions.get(live.record.id) !== live || live.record.status === 'ended') return Promise.resolve(null);
    if (sessionBusy(live) || live.planCard || nextWork(live) || !mailboxAllowed(live)) { pumpSoon(live); return Promise.resolve(null); }
    return startWork(live, { kind: 'mailbox', gen: null });
  }
  /** The mailbox's turn (the scheduler's 'mailbox' work). */
  async function runMailboxTurn(live) {
    // Read while this batch waited (inside the 2 s window, or while the brain
    // was busy with the turn that waited for it): not news any more.
    let unread = live.mailbox.splice(0, live.mailbox.length).filter((item) => !alreadyRead(item));
    if (!unread.length) { scheduleDispose(live); return null; }
    // A decided route whose card carried the owner's computer approval is carried out in a turn of
    // its own: nothing else in the mailbox rides on that approval. The rest waits for the next turn.
    const marked = live.computerRouteGrant?.routeId || null;
    const own = marked ? unread.filter((item) => item?.kind === 'route_decided' && String(item.route?.routeId || '') === marked) : [];
    if (own.length && own.length < unread.length) {
      live.mailbox.unshift(...unread.filter((item) => !own.includes(item)));
      unread = own;
    }
    // A route decided with no run attached whose run exists by now is not asked to be dispatched again.
    let sessionRuns = [];
    try { sessionRuns = unread.some((item) => item?.kind === 'route_decided') ? (dispatcher?.list?.({ assistantSessionId: live.record.id, limit: 500 }) || []) : []; } catch { sessionRuns = []; }
    const items = reconcileRouteItems(unread, sessionRuns);
    const text = formatMailbox(items);
    sendToSockets(live, { type: 'event', event: { type: 'synabun.mailbox', items } });
    appendTranscript(live.record.id, { at: iso(now()), packet: { type: 'event', event: { type: 'synabun.mailbox', items } } });
    live.mailboxTurn = true;
    // The user picked "here" on a card: that turn does the task, so it starts open.
    const decidedHere = items.some((item) => item.kind === 'route_decided' && item.route?.target?.kind === 'direct' && !(item.runIds || []).length);
    const firstRun = items.find((item) => item.run);
    const taskId = firstRun?.run?.turns?.find((turn) => turn.n === firstRun.turn)?.taskId || firstRun?.run?.taskId || live.record.taskId || null;
    // The decided "here" routes this turn carries out (one of them may hold the owner's computer approval).
    const computerRoutes = items.filter((item) => item.kind === 'route_decided' && item.route?.target?.kind === 'direct' && !(item.runIds || []).length).map((item) => String(item.route?.routeId || '')).filter(Boolean);
    const result = await runQuery(live, { text, system: true, taskId, gateOpen: decidedHere, computerRoutes });
    // A human prompt reached the brain first: the items go after its turn.
    if (result?.code === 'ASSISTANT_BUSY') { live.mailbox.unshift(...items); live.mailboxTurn = false; }
    return result;
  }
  function onDispatchEvent(payload) {
    const run = payload?.run;
    if (!run?.assistantSessionId) return;
    const live = sessions.get(run.assistantSessionId);
    if (!live) return;
    if (!live.record.dispatchRunIds?.includes(run.runId)) { live.record.dispatchRunIds = [...(live.record.dispatchRunIds || []), run.runId].slice(-100); touch(live); }
    sendToSockets(live, { type: 'assistant:dispatch', reason: payload.reason, run });
    scheduleUsage(live.record.id);
    if (payload.reason === 'turn_completed' && (run.outcome === 'done' || run.outcome === 'blocked') && !run.memoryStored) live.obligations.add(run.runId);
    if (payload.reason === 'memory_stored' || run.memoryStored) live.obligations.delete(run.runId);
    if (payload.reason === 'completed' || payload.reason === 'failed' || payload.reason === 'stopped' || payload.reason === 'interrupted') {
      sendToSockets(live, { type: 'event', event: { type: 'synabun.dispatch_result', run, result: run.lastResult || null } });
    }
    if (!MAILBOX_REASONS.has(payload.reason)) return;
    if (payload.reason === 'stopped' && !MAILBOX_STOP_REASONS.has(run.completionReason)) return;
    // needs_input already carries the question; its turn_completed twin would
    // hand the brain the same event twice.
    if (payload.reason === 'turn_completed' && run.lastResult?.status === 'needs_input') return;
    const kind = payload.reason === 'turn_completed' ? 'result' : payload.reason;
    const carriesResult = kind === 'result' || kind === 'needs_input';
    const item = {
      kind, run, summary: run.lastResult?.summary ? clip(run.lastResult.summary, 400) : null, question: run.lastResult?.question || null,
      files: run.lastResult?.files || [], follow_ups: run.lastResult?.follow_ups || [], request: payload.request || null, error: run.error || null,
      text: payload.text || null,
      turn: Number.isFinite(Number(payload.turn)) ? Number(payload.turn) : null,
      // Jev's reading of the result: a "done" its own output does not show, and a status read without a ## Result block.
      unverified: carriesResult ? (run.lastResult?.unverifiedClaim?.evidence || null) : null,
      resultSource: carriesResult ? (run.lastResult?.source || null) : null,
      // Image / video creation: the files this turn generated ({ kind, path, url, mime, bytes }).
      media: carriesResult && Array.isArray(run.lastResult?.media) ? run.lastResult.media : [],
    };
    // Already read by the brain (agent_wait in the same turn that dispatched it): no second turn.
    if (alreadyRead(item)) return;
    enqueueMailbox(live, item);
  }
  function onRunRemoved(payload) {
    const live = payload?.assistantSessionId ? sessions.get(payload.assistantSessionId) : null;
    if (!live) return;
    const removed = new Set((payload.runIds || []).map(String));
    if (!removed.size) return;
    for (const runId of removed) {
      live.obligations.delete(runId);
      live.nudgedRuns.delete(runId);
    }
    // A result can be waiting in the mailbox while the user clears its run.
    // Do not let that stale result (or its memory reminder) start another turn.
    live.mailbox = live.mailbox.filter((item) => !removed.has(String(item?.run?.runId || item?.runId || '')));
    if (!live.mailbox.length && live.mailboxTimer) {
      clearTimeout(live.mailboxTimer);
      live.mailboxTimer = null;
    }
  }
  function onPermissionBroadcast(message) {
    const live = message?.assistantSessionId ? sessions.get(message.assistantSessionId) : null;
    if (!live) return;
    if (message.type === 'assistant:permission-request') {
      sendToSockets(live, { type: 'event', event: { type: 'synabun.dispatch_control_request', runId: message.runId, request_id: message.request?.requestId, provider: dispatcher?.get?.(message.runId)?.provider || null, request: message.request } });
    } else if (message.type === 'assistant:permission-resolved') {
      sendToSockets(live, { type: 'event', event: { type: 'synabun.dispatch_control_resolved', runId: message.runId, request_id: message.requestId, resolvedBy: message.resolvedBy, behavior: message.behavior } });
    }
  }

  // ── public API ─────────────────────────────────────────────────────────────
  function listSessions() {
    return [...sessions.values()].map((live) => view(live)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  function getSession(id, { transcript = true, limit = 400 } = {}) {
    const live = sessions.get(id);
    if (!live) return null;
    return { ...view(live), transcript: transcript ? readTranscript(id, limit) : undefined, persona: live.personaText || undefined };
  }
  /**
   * `fallback`: the UI's start path — a disabled model starts on its enabled stand-in (reported back) instead of refusing.
   * `channel`: where the conversation happens ('whatsapp'); the persona adapts to it.
   * `internal.remote` ({ channel, level, strictWorkerApprovals, autonomousUntil, computerUse }): an in-process
   * caller (the WhatsApp bridge) starts a remote session. REST callers pass only the body, so
   * they cannot. The record is flagged before it is persisted: after a restart without a new
   * registration the session reads as read-only.
   */
  async function createSession({ brain = {}, label = null, cwd = null, windowId = null, fallback = false, channel = null } = {}, internal = {}) {
    const id = `assistant-${randomUUID()}`;
    const requested = normalizeBrain({ ...brain, cwd: brain?.cwd || cwd || settings.defaultBrain.cwd || PACKAGE_ROOT }, settings.defaultBrain, { catalog: catalog?.peek?.() || null });
    const enabled = await enabledBrain(requested, { fallback: fallback === true, named: !!brain?.model });
    const normalized = enabled.brain;
    const record = {
      id, brain: normalized, title: label ? clip(label, 60) : DEFAULT_SESSION_TITLE, project: detectProject(normalized.cwd) || 'global',
      createdAt: iso(now()), updatedAt: iso(now()), lastActiveAt: null, status: 'idle', providerSessionId: null, providerThreadId: null,
      costUsd: 0, lastReportedCost: 0, dispatchRunIds: [], memoryGeneration: 1, windowId: windowId || null, turns: 0, taskId: null, usageState: {},
    };
    if (channel) record.channel = String(channel).trim().toLowerCase().slice(0, 40) || null;
    const live = makeLive(record);
    sessions.set(id, live);
    const remote = internal && typeof internal === 'object' && internal.remote && typeof internal.remote === 'object' ? internal.remote : null;
    if (remote) {
      const remoteChannel = String(remote.channel || record.channel || 'whatsapp');
      record.remote = { channel: remoteChannel, since: iso(now()), modes: { permissionMode: normalized.permissionMode || 'default', planMode: normalized.planMode === true } };
      record.computerUse = false;
      live.creating = true;
      // Every reader of the registry (dispatcher, bridge, API) sees the brain: Codex / OpenCode read as read-only.
      try { remotePolicy.setSessionBrain?.(id, normalized.provider); } catch {}
      try {
        remotePolicy.registerSessionPolicy(id, { level: remote.level, channel: remoteChannel, strictWorkerApprovals: remote.strictWorkerApprovals === true, autonomousUntil: remote.autonomousUntil ?? null, paused: remote.paused === true, computerUse: remote.computerUse === true });
      } catch (error) {
        // Never a remote session without a level: flagged, it reads as read-only.
        log('assistant:remote-policy', `${id}: registration failed (${error?.message || error}); read-only`);
        try { remotePolicy.markRemote?.(id, { channel: remoteChannel }); } catch {}
      }
      live.creating = false;
      record.brain = clampedBrain(live, record.brain);
    }
    persist({ force: true });
    broadcast('assistant:session-created', live);
    return enabled.fallback ? { ...view(live), fallback: enabled.fallback } : view(live);
  }
  function applyRouteMode(live, mode) {
    const normalized = mode === null || mode === undefined || mode === '' ? null : normalizeRouteMode(mode);
    if (mode && !normalized) { const error = new Error(`Unknown route mode ${mode}`); error.code = 'ROUTE_MODE_INVALID'; error.status = 400; throw error; }
    live.record.routing = { ...(live.record.routing || {}), mode: normalized };
  }
  function applyComputerUse(live, enabled) {
    // A remote session's computer use is not a per-conversation choice: the owner's switch and
    // the level decide (remoteComputerUse). A PATCH, the socket and updateSession change nothing.
    if (remotePolicyFor(live)) return;
    const value = enabled === null || enabled === undefined ? null : !!enabled;
    live.record.computerUse = value;
    try { desktop?.onSessionToggle?.(live.record.id, computerEffective(live.record)); } catch {}
  }
  async function updateSession(id, patch = {}) {
    const live = sessions.get(id);
    if (!live) return null;
    if (patch.title) live.record.title = clip(patch.title, 60);
    if (patch.routing && typeof patch.routing === 'object' && 'mode' in patch.routing) applyRouteMode(live, patch.routing.mode);
    if ('computerUse' in patch) applyComputerUse(live, patch.computerUse);
    if (patch.brain && typeof patch.brain === 'object') {
      // A provider switch that names no model starts from the new provider's
      // default, never from the old provider's model id.
      const switching = BRAIN_PROVIDERS.has(patch.brain.provider) && patch.brain.provider !== live.record.brain.provider;
      const base = switching && !patch.brain.model ? { ...live.record.brain, model: null } : live.record.brain;
      let next = normalizeBrain({ ...base, ...patch.brain, model: patch.brain.model || base.model }, base, { catalog: catalog?.peek?.() || null });
      const modelChanged = next.model !== live.record.brain.model || next.provider !== live.record.brain.provider;
      if (modelChanged) next = (await enabledBrain(next)).brain;
      // A remote session keeps what was asked for and runs what its level allows.
      if ('permissionMode' in patch.brain || 'planMode' in patch.brain) next = clampModeWrite(live, next);
      else next = clampedBrain(live, next);
      const providerChanged = next.provider !== live.record.brain.provider || next.accountId !== live.record.brain.accountId || next.cwd !== live.record.brain.cwd || next.mcpProfile !== live.record.brain.mcpProfile;
      // A usage limit is the account's: another provider or account starts without the notice.
      if (next.provider !== live.record.brain.provider || next.accountId !== live.record.brain.accountId) setLimit(live, null);
      live.record.brain = next;
      live.record.project = detectProject(next.cwd) || live.record.project || 'global';
      if (providerChanged) {
        await disposeBrain(live, 'switched');
        live.record.providerSessionId = null;
        live.record.providerThreadId = null;
        if (live.record.usageState) delete live.record.usageState[next.provider === 'claude-code' ? 'claude' : next.provider];
        if (live.record.usageState) delete live.record.usageState.codexThreadId;
        live.record.status = 'idle';
        // A remote session's level follows its brain (a switch to Codex / OpenCode is read-only at once).
        try { remotePolicy?.setSessionBrain?.(live.record.id, next.provider); } catch {}
      } else if (live.brain) {
        if (next.permissionMode !== (patch.previousPermissionMode || null) || typeof patch.brain.planMode === 'boolean') { try { await live.brain.setPermissionMode?.(next.permissionMode, { planMode: next.planMode === true }); } catch {} }
      }
    }
    touch(live);
    broadcast('assistant:session-updated', live);
    sendToSockets(live, { type: 'assistant:session', session: view(live), reason: 'updated' });
    return view(live);
  }
  /**
   * Nothing pending outlives a session, and closing starts before anything
   * awaits (one close at a time). A new generation drops the queued work, every
   * turn still on its way to the brain (a prompt being set up and the mailbox
   * too: runTurn) with its busy count, and the plan card. Until the brain is gone
   * (`closing`, → the call that ends it) nothing starts and no prompt is taken,
   * and a socket that attaches waits (handleWebSocket): the session reopens clean.
   */
  async function endSessionWork(live) {
    while (live.closing) await live.closing;
    let done = null;
    live.closing = new Promise((resolve) => { done = resolve; });
    newGeneration(live, 'brain_disposed');
    live.closedGen = live.gen;
    live.turnPending = 0;
    live.prompting = null;
    live.workActive = null;
    if (live.workTimer) { clearTimeout(live.workTimer); live.workTimer = null; }
    live.gateNudge = null;
    return () => { live.closing = null; done(); };
  }
  async function closeSession(id) {
    const live = requireLive(id);
    const closed = await endSessionWork(live);
    try {
      await disposeBrain(live, 'closed');
      live.record.status = 'ended';
      touch(live);
      persist({ force: true });
      broadcast('assistant:session-ended', live);
    } finally { closed(); }
    return view(live);
  }
  async function destroySession(id) {
    const live = sessions.get(id);
    if (!live) return false;
    const closed = await endSessionWork(live);
    try {
      await disposeBrain(live, 'closed');
      for (const ws of live.sockets) { try { ws.close(1000, 'session destroyed'); } catch {} }
      sessions.delete(id);
      const usageTimer = usageTimers.get(id);
      if (usageTimer) clearTimeout(usageTimer);
      usageTimers.delete(id);
      usageSentAt.delete(id);
      metered('drop', () => usage?.dropSession?.(id));
      try { remotePolicy?.forgetSession?.(id); } catch {}
      try { rmSync(resolve(dataDir, 'assistant', id), { recursive: true, force: true }); } catch {}
      persist({ force: true });
      broadcast('assistant:session-ended', live, { destroyed: true });
    } finally { closed(); }
    return true;
  }
  /**
   * MCP terminal pin → assistant session id. Claude brains pin the session id
   * itself; the OpenCode brain pins `assistant-oc-<24>` (its isolated serve).
   */
  function resolveTerminal(pin) {
    if (!pin) return null;
    if (sessions.has(pin)) return pin;
    for (const [id, live] of sessions) {
      if (live.brain?.termId === pin) return id;
      if (/^assistant-oc-/.test(pin) && `assistant-oc-${String(id).replace(/^assistant-/, '').slice(0, 24)}` === pin) return id;
    }
    return null;
  }
  function accountInUse(provider, accountId) {
    for (const live of sessions.values()) {
      if (live.brain && live.record.brain?.provider === provider && (live.record.brain?.accountId || 'default') === accountId) return true;
    }
    return false;
  }
  function ownsIsolatedServe(termId) {
    for (const live of sessions.values()) if (live.brain?.termId === termId) return true;
    return false;
  }
  function noteDispatch(sessionId, runId) {
    const live = sessions.get(sessionId);
    if (!live || live.record.dispatchRunIds?.includes(runId)) return;
    live.record.dispatchRunIds = [...(live.record.dispatchRunIds || []), runId].slice(-100);
    touch(live);
  }

  // ── programmatic surface (the WhatsApp bridge; the socket uses the same paths) ──
  /** Every packet any session sends, as { sessionId, packet }. Returns the unsubscribe. */
  function observe(listener) {
    if (typeof listener !== 'function') throw new Error('observe requires a function');
    packetObservers.add(listener);
    return () => packetObservers.delete(listener);
  }
  /** Something runs, or the approved plan's turn or a compact is waiting to (a prompt would be refused). */
  function isBusy(id) { const live = sessions.get(String(id || '')); return sessionBusy(live) || (!!live && !!workReserved(live)); }
  /** The session's remote policy (lib/remote-policy.js), or null. */
  function sessionPolicy(id) { const live = sessions.get(String(id || '')); return live ? remotePolicyFor(live) : null; }
  /** Where the session's conversation happens: 'whatsapp' (WhatsApp Link), or null for the panel. */
  function sessionChannel(id) { const live = sessions.get(String(id || '')); return live ? (live.record.channel || live.record.remote?.channel || null) : null; }
  /**
   * A human prompt from outside the panel → { ok:true } or { ok:false, code, message }.
   * `requireIdle` refuses while anything runs (ASSISTANT_BUSY) instead of queueing
   * behind it; `untrusted` marks text the owner did not write (capped at ask).
   */
  async function submit(id, { text = '', images = [], origin = 'api', requireIdle = true, untrusted = false, authority = null } = {}) {
    const live = sessions.get(String(id || ''));
    if (!live) return { ok: false, code: 'SESSION_NOT_FOUND', message: `Unknown assistant session ${id}` };
    if (live.record.status === 'ended' || live.closing) return { ok: false, code: 'SESSION_ENDED', message: 'This assistant session was closed.' };
    if (requireIdle && isBusy(live.record.id)) return { ok: false, code: 'ASSISTANT_BUSY', message: 'The assistant is still working; wait for the turn to finish or stop it.' };
    const pictures = (Array.isArray(images) ? images : []).filter((img) => img && img.base64).map((img) => ({ base64: String(img.base64), mediaType: String(img.mediaType || 'image/jpeg') }));
    try {
      return await runQuery(live, { text, images: pictures, origin: String(origin || 'api'), untrusted: untrusted === true, authority });
    } catch (error) {
      return { ok: false, code: error?.code || 'BRAIN_START_FAILED', message: error?.message || String(error) };
    }
  }
  /**
   * Stop the running turn (the panel's Stop, WhatsApp's /stop): everything
   * pending for the session goes too. A new generation drops the queued work
   * (the approved plan's turn, a revision, a continuation, the nudge, a queued
   * compact) and a turn still on its way to the brain (a slow brain start
   * included), and closes the plan card (late answers are refused), which
   * releases its hold: the mailbox goes on. The in-turn route cards close.
   */
  async function stopTurn(id, { origin = 'api' } = {}) {
    const live = sessions.get(String(id || ''));
    if (!live) return { ok: false, code: 'SESSION_NOT_FOUND', message: `Unknown assistant session ${id}` };
    newGeneration(live, 'stopped');
    // A remote session: computer use stops with the turn, before the brain is even asked to (its
    // approval, its open request, the live grant; an action in progress is aborted).
    endComputerTurn(live, 'stopped');
    try { router?.cancelForSession?.(live.record.id, 'aborted', { origins: ['agent_route', 'vision_guard'] }); } catch {}
    if (origin !== 'ui') log('assistant:stop', `${live.record.id}: turn stopped from ${origin}`);
    try { await live.brain?.abort?.(); } catch (error) { return { ok: false, code: 'STOP_FAILED', message: error?.message || String(error) }; }
    return { ok: true };
  }
  function controlResolved(live, requestId, origin) {
    sendToSockets(live, { type: 'control_resolved', request_id: requestId, origin: String(origin || 'ui') });
  }
  /**
   * Answer an open card of this session: a route card (the router), a clarify
   * card (the clarifier) or the brain's own request, which must be pending — an
   * unknown id never reaches the brain, and a card of another session is unknown
   * here. → { ok, kind, code?, message? }; on success every socket hears
   * control_resolved with the origin.
   *
   * `superseded` (an option, with a denial): the card closes because the user
   * wrote something else instead of answering it (the WhatsApp bridge). Nothing
   * is approved, and it is not the user's own "no": a route is cancelled without
   * a "declined" event, a clarify round without "go with your assumptions". Only
   * an in-process caller can pass it: a `superseded` key inside a response (a
   * socket, the REST API, a brain) is dropped and never honoured.
   */
  async function answerControl(id, requestId, response = {}, { origin = 'ui', superseded: movedOn = false, authority = null } = {}) {
    const live = sessions.get(String(id || ''));
    if (!live) return { ok: false, code: 'SESSION_NOT_FOUND', message: `Unknown assistant session ${id}` };
    const rid = String(requestId ?? '');
    if (!rid) return { ok: false, code: 'REQUEST_ID_REQUIRED', message: 'request_id is required' };
    const { superseded: _dropped, ...inner } = response && typeof response === 'object' ? response : {};
    const superseded = movedOn === true && (inner.decline === true || inner.behavior === 'deny');
    const sid = live.record.id;
    // Route cards are answered by the router and never reach the brain.
    if (router?.owns?.(rid, sid)) {
      if (superseded && typeof router.cancel === 'function') {
        controlResolved(live, rid, origin);
        router.cancel(rid, 'superseded', { sessionId: sid });
        return { ok: true, kind: 'route', superseded: true };
      }
      let decided = null;
      try { decided = await router.answer(rid, inner, { origin, sessionId: sid, authority }); }
      catch (error) { return { ok: false, kind: 'route', code: error?.code || 'ROUTE_INVALID', message: error?.message || String(error) }; }
      // A "do it here" pick whose turn is gone (routerContinue refused it): the
      // router closed the card as expired on every host, and nothing was approved.
      if (decided?.status === 'expired') {
        return { ok: false, kind: 'route', code: 'ROUTE_EXPIRED', reason: decided.reason || 'expired', message: 'That route card expired: a newer message, a Stop or closing the session came after its turn, so nothing was approved.' };
      }
      controlResolved(live, rid, origin);
      return { ok: true, kind: 'route' };
    }
    // Clarify cards are answered by the clarifier; the brain hears it in its tool result or its mailbox.
    if (clarifier?.owns?.(rid, sid)) {
      if (superseded && typeof clarifier.cancel === 'function') {
        controlResolved(live, rid, origin);
        clarifier.cancel(rid, 'superseded', { sessionId: sid });
        return { ok: true, kind: 'clarify', superseded: true };
      }
      try { clarifier.answer(rid, inner, { origin, sessionId: sid }); }
      catch (error) { return { ok: false, kind: 'clarify', code: error?.code || 'CLARIFY_INVALID', message: error?.message || String(error) }; }
      controlResolved(live, rid, origin);
      return { ok: true, kind: 'clarify' };
    }
    // Computer use of a WhatsApp session is granted on the owner's phone only (the bridge's match,
    // proved by its capability): an "allow" from anyone else, whatever origin it names, is refused
    // here, before the request is touched. It stays open.
    if (live.computerAsk?.requestId === rid && !fromPhone(authority) && inner.behavior === 'allow') {
      return { ok: false, kind: 'computer', code: 'COMPUTER_PHONE_ONLY', message: 'Controlling the Mac from a WhatsApp conversation is approved on the owner\'s phone only. It can be denied here.' };
    }
    const pending = live.pendingControls.get(rid);
    if (!pending) {
      // A plan card a newer turn replaced (or that expired): its plan is not the one to approve.
      const closed = live.closedPlanCards.get(rid);
      if (closed) {
        const message = closed === 'superseded'
          ? 'That plan card expired: a newer message replaced it, so nothing was approved.'
          : closed === 'stopped' ? 'That plan card was closed by Stop, so nothing was approved.' : 'That plan card expired, so nothing was approved.';
        return { ok: false, kind: 'plan', code: 'PLAN_CARD_CLOSED', reason: closed, message };
      }
      return { ok: false, kind: 'brain', code: 'CONTROL_UNKNOWN', message: `No open request ${rid} in this session.` };
    }
    live.pendingControls.delete(rid);
    clearControlTimer(live, rid);
    // A remote turn's "control your Mac for this?" request: the runtime's own, claimed and settled
    // in this same synchronous step (the brain's waiting calls get the answer from here).
    const ask = live.computerAsk?.requestId === rid ? live.computerAsk : null;
    if (ask) {
      // Closed because the owner wrote something else (`movedOn`): never a grant, whatever the response says.
      const granted = settleComputerAsk(live, ask, inner.behavior === 'allow' && movedOn !== true, { origin, message: inner.message, authority });
      controlResolved(live, rid, origin);
      return { ok: true, kind: 'computer', granted };
    }
    // The runtime's own plan card (a Codex / OpenCode plan turn that ended) never reaches the brain.
    const card = live.planCard?.requestId === rid ? live.planCard : null;
    if (card) {
      answerPlanCard(live, card, inner, { superseded });
      controlResolved(live, rid, origin);
      return { ok: true, kind: 'plan' };
    }
    // An answer to the brain's own question card joins the request's brief.
    try { clarifier?.onNativeAnswer?.(live.record.id, { requestId: rid, response: inner }); } catch {}
    // A plan approved on the desktop may run even in a read-only remote session (this turn only).
    const tool = String(pending.request?.tool_name || pending.request?.toolName || '');
    if (origin === 'ui' && tool === 'ExitPlanMode' && inner.behavior === 'allow') live.planApprovedByDesktop = true;
    // Plan mode ends before the brain hears the approval (Claude continues in the same turn).
    if (tool === 'ExitPlanMode' && inner.behavior === 'allow') approvePlan(live, inner.planDecision || null);
    live.brain?.respondControl?.(rid, inner);
    controlResolved(live, rid, origin);
    return { ok: true, kind: 'brain' };
  }
  /** Answer a worker's permission request of this session; the run records `origin` as who resolved it. */
  function answerDispatchControl(id, runId, requestId, response = {}, { origin = 'ui' } = {}) {
    if (!dispatcher?.respondPermission) return { ok: false, code: 'DISPATCH_UNAVAILABLE', message: 'Dispatch is not available' };
    const live = sessions.get(String(id || ''));
    if (!live) return { ok: false, code: 'SESSION_NOT_FOUND', message: `Unknown assistant session ${id}` };
    let run = null;
    try { run = dispatcher.get?.(runId) || null; } catch { run = null; }
    if (run?.assistantSessionId && String(run.assistantSessionId) !== live.record.id) {
      return { ok: false, code: 'RUN_NOT_IN_SESSION', message: `Run ${runId} belongs to another assistant session` };
    }
    try {
      dispatcher.respondPermission(runId, requestId, response || {}, { origin: String(origin || 'ui') });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error?.code || 'PERMISSION_FAILED', message: error?.message || String(error) };
    }
  }
  /** The open cards of a session, as the panel replays them: the brain's own, then route and clarify cards. */
  function pendingControls(id) {
    const live = sessions.get(String(id || ''));
    if (!live) return [];
    const out = [...live.pendingControls.values()];
    try { out.push(...(router?.pendingCards?.(live.record.id) || [])); } catch {}
    try { out.push(...(clarifier?.pendingCards?.(live.record.id) || [])); } catch {}
    return out;
  }

  // ── WebSocket handling ─────────────────────────────────────────────────────
  function sessionIdFromUrl(url) {
    const pathname = typeof url === 'string' ? url : url?.pathname || '';
    const match = /\/ws\/assistant\/([^/?#]+)/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : null;
  }
  async function handleWebSocket(ws, url) {
    const id = sessionIdFromUrl(url);
    const live = id ? sessions.get(id) : null;
    if (!live) {
      try { ws.send(JSON.stringify({ type: 'error', message: 'Unknown assistant session', code: 'SESSION_NOT_FOUND' })); ws.close(4404, 'unknown session'); } catch {}
      return;
    }
    const receive = (msg) => handleClientMessage(live, ws, msg).catch((error) => {
      log('assistant:ws-error', error?.message || String(error));
      // A prompt that failed to start carries its request id back: the panel restores its text.
      const requestId = msg?.type === 'query' && msg.request_id ? { request_id: String(msg.request_id) } : {};
      try { ws.send(JSON.stringify({ type: 'error', code: error?.code || undefined, message: error?.message || String(error), ...requestId })); } catch {}
    });
    // A close still disposing the brain: this socket attaches once it is over (the
    // session reopens clean, nothing of the old brain's turns left), and what it
    // sends meanwhile is handled after that, in order.
    let held = live.closing ? [] : null;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (held) held.push(msg); else receive(msg);
    });
    ws.on('close', () => {
      live.sockets.delete(ws);
      scheduleDispose(live);
    });
    if (held) {
      while (live.closing) await live.closing;
      if (sessions.get(id) !== live) {
        try { ws.send(JSON.stringify({ type: 'error', message: 'Unknown assistant session', code: 'SESSION_NOT_FOUND' })); ws.close(4404, 'unknown session'); } catch {}
        return;
      }
      if (ws.readyState !== 1) return; // gone while it waited
    }
    if (live.disposeTimer) { clearTimeout(live.disposeTimer); live.disposeTimer = null; }
    live.sockets.add(ws);
    live.record.status = live.record.status === 'ended' ? 'idle' : live.record.status;
    const engine = live.brain ? { type: 'engine', engine: live.brainProvider === 'claude-code' ? 'sdk' : live.brainProvider, brain: live.brainProvider, sdkVersion } : { type: 'engine', engine: 'assistant', brain: live.record.brain.provider, sdkVersion };
    try { ws.send(JSON.stringify(engine)); } catch {}
    try { ws.send(JSON.stringify({ type: 'assistant:session', session: view(live), reason: 'attached' })); } catch {}
    if (usage) try { ws.send(JSON.stringify({ type: 'assistant:usage', ...usageView(live.record.id) })); } catch {}
    // The limit notice as it is now (null clears one this panel still shows from before).
    sendLimit(live, [ws]);
    const replay = live.buffer.splice(0, live.buffer.length);
    try { ws.send(JSON.stringify({ type: 'reattach_result', ok: true, sessionId: live.record.id, running: live.running, replayed: replay.length })); } catch {}
    for (const packet of replay) { try { ws.send(JSON.stringify(packet)); } catch {} }
    for (const pending of live.pendingControls.values()) { try { ws.send(JSON.stringify(pending)); } catch {} }
    // Route and clarify cards live in the router / clarifier, not the brain: replay the open ones.
    for (const card of router?.pendingCards?.(live.record.id) || []) { try { ws.send(JSON.stringify(card)); } catch {} }
    for (const card of clarifier?.pendingCards?.(live.record.id) || []) { try { ws.send(JSON.stringify(card)); } catch {} }
    const waiting = held || [];
    held = null;
    for (const msg of waiting) receive(msg);
  }
  async function handleClientMessage(live, ws, msg) {
    const reply = (packet) => { try { ws.send(JSON.stringify(packet)); } catch {} };
    switch (msg.type) {
      case 'query': {
        // `request_id`: the panel's id for this prompt. A refusal reaches this socket
        // alone and carries it back, so this panel (only) puts the text back.
        const request = { id: msg.request_id ? String(msg.request_id) : null, reply };
        const result = await runQuery(live, { text: msg.prompt, images: msg.images || [], cwd: msg.cwd || null, model: msg.model || null, effort: msg.effort || null, permissionMode: msg.permissionMode || null, planMode: typeof msg.planMode === 'boolean' ? msg.planMode : null, origin: 'ui', request });
        // Refused before it ran: the panel, "working" since it sent, shows what runs now.
        if (result && !result.ok && result.code !== 'TURN_FAILED') reply({ type: 'reattach_result', ok: true, sessionId: live.record.id, running: isBusy(live.record.id) });
        return;
      }
      case 'control_response': {
        const requestId = String(msg.request_id || msg.response?.request_id || '');
        const inner = msg.response?.response || msg.response || {};
        if (!requestId) return;
        const answered = await answerControl(live.record.id, requestId, inner, { origin: 'ui' });
        // A rejected route or clarify answer keeps its card open with the message; an
        // unknown brain request is dropped, as the brain itself would. A route card
        // that expired meanwhile already reads Expired: this host hears why.
        if (!answered.ok && answered.code === 'ROUTE_EXPIRED') {
          try { ws.send(JSON.stringify({ type: 'event', event: { type: 'system', subtype: 'status', text: answered.message } })); } catch {}
        } else if (!answered.ok && (answered.kind === 'route' || answered.kind === 'clarify')) {
          try { ws.send(JSON.stringify({ type: 'error', code: answered.code, request_id: requestId, message: answered.message })); } catch {}
        }
        // An "allow" for computer use that only the phone may give: the card stays open and says so.
        if (!answered.ok && answered.code === 'COMPUTER_PHONE_ONLY') {
          try { ws.send(JSON.stringify({ type: 'event', event: { type: 'system', subtype: 'status', text: answered.message } })); } catch {}
        }
        // A refused answer to a closed plan card: that card shows it expired, and the
        // panel, which went "working" on the answer, shows what really runs.
        if (!answered.ok && answered.kind === 'plan') {
          for (const packet of [
            { type: 'control_cancelled', request_id: requestId, reason: answered.reason },
            { type: 'event', event: { type: 'system', subtype: 'status', text: answered.message } },
            { type: 'reattach_result', ok: true, sessionId: live.record.id, running: sessionBusy(live) },
          ]) { try { ws.send(JSON.stringify(packet)); } catch {} }
        }
        return;
      }
      case 'abort':
        await stopTurn(live.record.id, { origin: 'ui' });
        return;
      case 'set_route_mode':
        applyRouteMode(live, msg.mode);
        touch(live);
        broadcast('assistant:session-updated', live);
        sendToSockets(live, { type: 'assistant:session', session: view(live), reason: 'routing' });
        return;
      case 'set_computer_use':
        applyComputerUse(live, msg.enabled);
        touch(live);
        broadcast('assistant:session-updated', live);
        sendToSockets(live, { type: 'assistant:session', session: view(live), reason: 'computer' });
        return;
      case 'desktop_stop':
        try { await desktop?.stop?.({ scope: 'all', reason: 'ui', assistantSessionId: live.record.id }); } catch (error) { log('assistant:desktop-stop-error', error?.message || String(error)); }
        return;
      case 'set_permission_mode':
        if (msg.mode || typeof msg.planMode === 'boolean') {
          const asked = { ...live.record.brain, ...(msg.mode ? brainModeUpdate(live.record.brain, msg.mode) : {}) };
          if (typeof msg.planMode === 'boolean') asked.planMode = msg.planMode;
          const next = clampModeWrite(live, asked);
          live.record.brain = next;
          touch(live);
          await live.brain?.setPermissionMode?.(next.permissionMode, { planMode: next.planMode === true });
          // The panel shows what the level allows, not what it asked for.
          if (next !== asked) sendToSockets(live, { type: 'assistant:session', session: view(live), reason: 'remote' });
        }
        return;
      case 'compact':
        live.record.memoryGeneration = (live.record.memoryGeneration || 1) + 1;
        touch(live);
        // Session work: it starts once a running turn ends, and nothing else starts until it settles.
        queueWork(live, { kind: 'compact', reply });
        return;
      case 'clear':
        live.record.memoryGeneration = (live.record.memoryGeneration || 1) + 1;
        touch(live);
        return;
      case 'heartbeat':
        live.record.lastActiveAt = iso(now());
        if (msg.windowId) live.record.windowId = msg.windowId;
        return;
      case 'reattach':
        try { ws.send(JSON.stringify({ type: 'reattach_result', ok: true, sessionId: live.record.id, running: live.running })); } catch {}
        // The panel draws route and clarify cards only from control_request packets (deduped by request_id).
        for (const card of router?.pendingCards?.(live.record.id) || []) { try { ws.send(JSON.stringify(card)); } catch {} }
        for (const card of clarifier?.pendingCards?.(live.record.id) || []) { try { ws.send(JSON.stringify(card)); } catch {} }
        return;
      case 'switch_brain':
        await updateSession(live.record.id, { brain: { provider: msg.brain || msg.provider, model: msg.model, effort: msg.effort, accountId: msg.accountId, mcpProfile: msg.mcpProfile, cwd: msg.cwd, agent: msg.agent, permissionMode: msg.permissionMode, planMode: typeof msg.planMode === 'boolean' ? msg.planMode : undefined } });
        return;
      case 'list_sessions': {
        const rows = listSessions();
        try { ws.send(JSON.stringify({ type: 'assistant:sessions', sessions: rows })); } catch {}
        return;
      }
      case 'resume':
        if (msg.providerSessionId) {
          const moved = msg.providerSessionId !== live.record.providerSessionId;
          live.record.providerSessionId = msg.providerSessionId;
          // Another provider session: the meter's baseline was the old one's.
          if (moved) resetMeterIdentity(live, msg.providerSessionId);
          touch(live);
          await live.brain?.resume?.(msg.providerSessionId);
        }
        return;
      case 'mcp_status':
        await live.brain?.mcpStatus?.();
        return;
      case 'dispatch_control_response': {
        if (!dispatcher) return;
        const answered = answerDispatchControl(live.record.id, msg.runId, msg.request_id, msg.response || {}, { origin: 'user' });
        if (!answered.ok) { try { ws.send(JSON.stringify({ type: 'error', message: answered.message })); } catch {} }
        return;
      }
      default:
        return;
    }
  }

  // ── router sinks (wired lazily in server.js; see assistant-router.js) ──────
  function routerSession(id) {
    const live = sessions.get(id);
    if (!live) return null;
    // A remote session below autonomous: one route card per task is the task's approval.
    const policy = remotePolicyFor(live);
    const routingMode = policy ? clampRouteMode(policy, live.record.routing?.mode || null, { untrusted: live.turnUntrusted === true, now: now() }) : (live.record.routing?.mode || null);
    // remote: a decided route authorizes one dispatch only (assistant-router.js).
    // computer: what remoteComputerUse says for the running turn ("ask": a computer route card done here also asks for the Mac).
    const computer = policy ? computerDecision(live) : null;
    return { brain: live.record.brain, routingMode, running: live.running, remote: !!policy, computer: computer ? { state: computer.state, reason: computer.reason } : null };
  }
  /**
   * The panel's route chip counts pending routes from the session view, so a card
   * whose packet never reached the panel (a half-open socket) is still one click
   * away: the chip offers it and a `reattach` replays pending cards. Deferred a
   * tick so a decided/expired card is already closed in the router's count.
   */
  function publishPendingRoutes(live) {
    queueMicrotask(() => { if (sessions.get(live.record.id) === live) sendToSockets(live, { type: 'assistant:session', session: view(live), reason: 'routes' }); });
  }
  function routerSend(id, packet) {
    const live = sessions.get(id);
    const isCard = packet?.type === 'control_request' && (packet.request?.subtype === 'route' || packet.request?.kind === 'route');
    if (!live || !packet) { if (isCard) log('assistant:route-card', `${packet.request_id} → session ${id} not live`); return; }
    const delivered = sendToSockets(live, packet);
    if (isCard) {
      // The generation a "do it here" pick on this card continues in (routerContinue).
      const routeId = String(packet.request?.routeId || packet.request_id || '');
      if (routeId) { live.routeGens.set(routeId, live.gen); while (live.routeGens.size > 50) live.routeGens.delete(live.routeGens.keys().next().value); }
      // The card says the Mac will be controlled: bound here, once, to the turn that raised it and to
      // what remoteComputerUse says now. A card sent again, or one the decision no longer backs, binds nothing.
      if (routeId && packet.request?.computer?.optionId && !live.computerRoutes.has(routeId) && live.computerTurn && computerDecision(live)?.state === 'ask') {
        live.computerRoutes.set(routeId, { turn: live.computerTurn, epoch: live.computerEpoch });
        while (live.computerRoutes.size > 20) live.computerRoutes.delete(live.computerRoutes.keys().next().value);
      }
      // A trace for the next "the card never showed" report: how many sockets took it.
      log('assistant:route-card', `${packet.request_id} → ${delivered} socket(s)${delivered ? '' : ' (buffered for the next attach)'}`);
      publishPendingRoutes(live);
    }
  }
  function routerEvent(id, phase, route) {
    const live = sessions.get(id);
    if (!live) return;
    emitRouteEvent(live, phase, route);
    if (phase !== 'card' && phase !== 'pending' && phase !== 'auto') publishPendingRoutes(live);
  }
  function routerMailbox(id, item) { const live = sessions.get(id); if (live && item) enqueueMailbox(live, item); }
  /** agent_route answered (or failed) for this session: the route gate follows it (`meta.taskClass`: a chat route holds). */
  function routerRouted(id, result, meta = {}) { const live = sessions.get(id); if (live) ensureGate(live)?.onRouteResult(result, meta); }
  function routerRouteFailed(id, error) {
    const live = sessions.get(id);
    if (!live) return;
    log('assistant:route-gate', `agent_route failed for ${id} (${error?.code || error?.message || error}); the gate stays open this turn`);
    ensureGate(live)?.onRouteError(error);
  }
  /**
   * A "do it here with <model>" pick: the scheduler's continuation, in the
   * generation of the turn the route came from (its card's, else the current
   * one). The router awaits the catalog before it calls this, so a pick that
   * arrives after a newer prompt, a Stop or the session closing is refused
   * (false): the router then approves nothing and the card expires.
   */
  function routerContinue(id, { target = null, route = null } = {}) {
    const live = sessions.get(id);
    if (!live || !target) return false;
    const gen = live.routeGens.get(String(route?.routeId || '')) ?? live.gen;
    if (gen !== live.gen || live.record.status === 'ended' || live.closing) {
      log('assistant:work', `${id}: a late "do it here" pick (${route?.routeId || 'route'}) was dropped: a newer prompt or a Stop came after its turn`);
      return false;
    }
    const row = target.model ? findModel(catalog?.peek?.() || null, target.provider, target.model)?.row : null;
    const label = row?.label || target.model || 'the chosen model';
    const summary = route?.summary || '';
    const text = `[SynaBun Router] The user chose to run ${summary ? `"${summary}"` : 'this task'} here on ${label}${target.effort ? ` (effort ${target.effort})` : ''}. Continue that task now on this model, from where the conversation left off.`;
    queueWork(live, { kind: 'continuation', gen, options: { text, turnModel: target.model || null, turnEffort: target.effort || null, gateOpen: true } });
    return true;
  }
  function routerSinks() {
    return {
      sendCard: (sessionId, packet) => routerSend(sessionId, packet),
      cancelCard: (sessionId, requestId, reason) => routerSend(sessionId, { type: 'control_cancelled', request_id: requestId, reason }),
      routeEvent: (sessionId, phase, route) => routerEvent(sessionId, phase, route),
      mailbox: (sessionId, item) => routerMailbox(sessionId, item),
      continueDirect: (sessionId, payload) => routerContinue(sessionId, payload),
      routed: (sessionId, result, meta) => routerRouted(sessionId, result, meta),
      routeFailed: (sessionId, error) => routerRouteFailed(sessionId, error),
      computerApproved: (sessionId, payload) => routerComputerApproved(sessionId, payload),
    };
  }

  // ── clarifier sinks (wired lazily in server.js; see assistant-clarify.js) ──
  /** The user's own words of this request: the last human prompt (the transcript after a restart). */
  function lastUserPrompt(live) {
    if (live.lastPrompt) return live.lastPrompt;
    const entries = readTranscript(live.record.id, 200);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const event = entries[i]?.packet?.event;
      if (event?.type === 'synabun.user_prompt' && event.text) return String(event.text);
    }
    return '';
  }
  function clarifySession(id) {
    const live = sessions.get(id);
    if (!live) return null;
    return { lastPrompt: lastUserPrompt(live), cycle: live.promptCycle || 0 };
  }
  function clarifyEvent(id, phase, brief) {
    const live = sessions.get(id);
    if (!live) return;
    const packet = { type: 'event', event: { type: 'synabun.clarify', phase, brief } };
    sendToSockets(live, packet);
    // The card itself replays from the clarifier while it is open; its outcome is history.
    if (phase !== 'card') appendTranscript(live.record.id, { at: iso(now()), packet });
  }
  /** agent_clarify is waiting for the user: the route gate holds the rest of the turn. */
  function clarifyGate(id, result) {
    const live = sessions.get(id);
    if (live) ensureGate(live)?.onClarify?.(result);
  }
  function clarifySinks() {
    return {
      sendCard: (sessionId, packet) => routerSend(sessionId, packet),
      cancelCard: (sessionId, requestId, reason) => routerSend(sessionId, { type: 'control_cancelled', request_id: requestId, reason }),
      event: (sessionId, phase, brief) => clarifyEvent(sessionId, phase, brief),
      mailbox: (sessionId, item) => routerMailbox(sessionId, item),
      gate: (sessionId, result) => clarifyGate(sessionId, result),
    };
  }

  // ── route gate (assistant-route-gate.js) ───────────────────────────────────
  function ensureGate(live) {
    if (!router) return null;
    if (!live.gate) {
      live.gate = createRouteGate({ sessionId: live.record.id, routeTool: () => (live.record.brain?.provider === 'claude-code' ? 'mcp__SynaBun__agent_route' : 'SynaBun_agent_route') });
      live.gateToken = randomUUID();
    }
    return live.gate;
  }
  /** Stop a turn that keeps calling tools without routing (the loop guard). */
  function stopForGateLoop(live) {
    dropWork(live, 'continuation', 'nudge');
    live.gateNudge = null;
    const text = `${ROUTE_GATE_LOOP_MESSAGE} ${live.gate?.snapshot?.().refusals || ''} tool calls were refused this turn; route the task (or rephrase it) and try again.`.replace(/\s+/g, ' ').trim();
    log('assistant:route-gate', `${live.record.id}: loop guard stopped the turn`);
    sendToSockets(live, { type: 'error', code: 'ROUTE_GATE_LOOP', message: text });
    const status = { type: 'event', event: { type: 'system', subtype: 'status', text } };
    sendToSockets(live, status);
    appendTranscript(live.record.id, { at: iso(now()), packet: status });
    setTimeout(() => { Promise.resolve(live.brain?.abort?.()).catch(() => {}); }, 0).unref?.();
  }
  function decide(live, tool) {
    // Plan mode: the plan policy (planGate) decides, never the route gate.
    if (isPlanningLive(live)) return { allow: true, state: 'plan', refusals: 0 };
    const decision = live.gate.check(tool);
    if (decision.abort) stopForGateLoop(live);
    return decision;
  }
  function isPlanningLive(live) { return live?.record?.brain?.planMode === true; }
  function isPlanning(id) { return isPlanningLive(sessions.get(String(id || ''))); }
  /**
   * Plan mode stays read-only (the read-only classifier) for a remote session at
   * the read-only level, the level that holds it in plan mode (clampBrainModes);
   * everywhere else it refuses code changes only.
   */
  function planReadOnly(live) { return !!live && remoteLevel(live) === 'read-only'; }
  function isPlanReadOnly(id) { const live = sessions.get(String(id || '')); return isPlanningLive(live) && planReadOnly(live); }
  /**
   * Plan mode's policy for a tool call a host's pre-tool hook reports (every
   * session of the brain, subagents included): { allow:false, reason } or null.
   */
  function planGate(live, host, tool, input) {
    if (!isPlanningLive(live)) return null;
    const readOnly = planReadOnly(live);
    const decision = readOnly ? readOnlyToolDecision(tool, input || {}, { host }) : planToolDecision(tool, input || {}, { host });
    if (decision !== 'deny') return null;
    log('assistant:plan', `${live.record.id}: declined ${tool} (${readOnly ? 'read-only' : 'no code changes'})`);
    return { allow: false, plan: true, reason: readOnly ? readOnlyDenyMessage(tool) : planDenyMessage(tool, { host }) };
  }
  /**
   * Checks after the tool started: a Codex brain whose hook is not trusted, and
   * an OpenCode brain whose serve has not loaded the gate plugin (no hello yet).
   */
  function gateIsReactive(live) {
    return live.brain?.gateMode === 'reactive' || (live.brainProvider === 'opencode' && !live.gatePluginAt);
  }
  /**
   * A brain that cannot reach agent_route (its SynaBun MCP server is down, or
   * connected without the assistant role) is not gated: it could never route,
   * so every turn would end in the loop guard. null = cannot tell yet (no change).
   * Said once per change, in the transcript.
   */
  function applyRouteAvailability(live, verdict) {
    const gate = ensureGate(live);
    if (!gate || !verdict) return;
    const reason = verdict.available ? null : (verdict.reason || 'routing is unavailable');
    const before = gate.snapshot().unavailable || null;
    if (before === reason) return;
    gate.setUnavailable(reason);
    const text = reason
      ? `Route gate off for this brain: ${reason}. It can use every tool without routing until that is fixed.`
      : 'Route gate back on: this brain can route again.';
    log('assistant:route-gate', `${live.record.id}: ${text}`);
    const packet = { type: 'event', event: { type: 'system', subtype: 'status', text } };
    sendToSockets(live, packet);
    appendTranscript(live.record.id, { at: iso(now()), packet });
  }
  /**
   * The gate's answer for one tool call, for hosts outside this process (the
   * OpenCode plugin, the Codex hook). `token` is the per-session secret they
   * were given; `providerSessionId` names the OpenCode session making the call
   * (a subagent's own session is not gated: launching it was).
   */
  function gateCheck({ session, token, tool, input = {}, inputComplete = false, providerSessionId = null, agent = null, hello = false, host = null } = {}) {
    const live = session ? sessions.get(String(session)) : null;
    if (!live?.gate || !live.gateToken || String(token || '') !== live.gateToken) {
      const error = new Error('Unknown route gate'); error.code = 'ROUTE_GATE_UNKNOWN'; error.status = 404; throw error;
    }
    // The OpenCode plugin says hello when its serve loads it (any check it makes
    // proves the same): from then on the plugin gates before each tool runs,
    // not the reactive fallback.
    if (hello) { live.gatePluginAt = now(); return { ok: true, hello: true }; }
    if (host === 'opencode' && !live.gatePluginAt) live.gatePluginAt = now();
    const planned = planGate(live, host, tool, input);
    if (planned) return planned;
    // A remote session never runs these, subagents included (nor a call the host sent without its arguments).
    const remoteDenied = remoteGate(live, tool, input, { argsComplete: inputComplete === true, host });
    if (remoteDenied) return remoteDenied;
    // The browser policy: every session, plan mode and subagents included.
    const browserDenied = browserGate(live, tool, input, { host, argsComplete: inputComplete === true });
    if (browserDenied) return browserDenied;
    if (agent) return { allow: true, subagent: true };
    const own = live.brain?.identity?.()?.providerSessionId || live.record.providerSessionId || null;
    if (providerSessionId && own && String(providerSessionId) !== String(own)) return { allow: true, subagent: true };
    const decision = decide(live, tool);
    return decision.allow ? { allow: true } : { allow: false, reason: decision.reason, refusals: decision.refusals, stopped: !!decision.abort };
  }
  /**
   * A remote session's hard refusal for one tool call (every level), else null.
   * `argsComplete: false`: the host did not pass the call's arguments. An
   * OpenCode brain's own web tools are refused (the read-only level's network rule).
   */
  function remoteGate(live, tool, input = {}, { argsComplete = true, host = null, computer = undefined } = {}) {
    if (!remotePolicyFor(live)) return null;
    let reason = null;
    if (host === 'opencode' && REMOTE_OPENCODE_WEB_TOOLS.has(String(tool || '').toLowerCase())) {
      reason = `${tool}: a WhatsApp conversation on OpenCode is read-only and does not reach the web on its own; use SynaBun's browser tools, or switch the WhatsApp brain to Claude.`;
    } else if (isComputerTool(tool)) {
      // `computer`: what computerAccess said for this call (the Claude hook passes it). Any other
      // caller (the Codex hook, the OpenCode plugin) asks here: those brains never get past "off".
      const access = computer === undefined ? computerAccess(live) : computer;
      if (!access || access.access === 'deny') reason = access?.message || remoteComputerDenial(access?.reason || null);
      // Allowed to run, or to ask: the rest of the checks (its arguments) still apply.
      else reason = remoteToolDenial(tool, input, { argsComplete, computerAllowed: true });
    } else {
      reason = remoteToolDenial(tool, input, { argsComplete });
    }
    if (!reason) return null;
    log('assistant:remote-policy', `${live.record.id}: refused ${tool} (${reason})`);
    return { allow: false, remote: true, reason: `${reason} Tell the user to do this in SynaBun on their computer if they need it.` };
  }
  /**
   * The browser policy (lib/browser-tool-policy.js) for one brain tool call:
   * { allow:false, browser:true, reason } or null. Every provider and session,
   * plan mode and subagents included; scripts resolve against the session's
   * project cwd. `argsComplete: false` (the host sent only the command /
   * action of an oversized call): checked on what arrived.
   */
  function browserGate(live, tool, input = {}, { host = null, argsComplete = true } = {}) {
    const kind = host || (live.brainProvider === 'claude-code' ? 'claude' : live.brainProvider);
    const reason = browserToolDenial(tool, input && typeof input === 'object' ? input : {}, { host: kind, cwd: live.record.brain?.cwd || PACKAGE_ROOT });
    if (!reason) return null;
    log('assistant:browser-policy', `${live.record.id}: refused ${tool}${argsComplete ? '' : ' (partial arguments)'}`);
    return { allow: false, browser: true, reason };
  }
  /**
   * Claude brain: the browser policy as an in-process PreToolUse hook. Unlike
   * gateHooks it runs for subagents (agent_id) and in plan mode (decide()
   * steps aside while planning; this does not).
   */
  function browserHooks(live) {
    return {
      PreToolUse: [{
        hooks: [async (input) => {
          const toolInput = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
          const denied = browserGate(live, String(input?.tool_name || ''), toolInput, { host: 'claude' });
          return denied ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denied.reason } } : {};
        }],
      }],
    };
  }
  /**
   * Claude brain of a remote session: an in-process PreToolUse hook that runs
   * for subagents too (never skipped on agent_id). Every level refuses what
   * remoteToolDenial names. Below autonomous, a tool the read-only classifier
   * would refuse is 'ask': the SDK then asks canUseTool even when a user allow
   * rule (or allowedTools) matches, so the card reaches the phone or the desktop.
   */
  function remoteHooks(live) {
    return {
      PreToolUse: [{
        hooks: [async (input) => {
          const tool = String(input?.tool_name || '');
          const argsComplete = !!input?.tool_input && typeof input.tool_input === 'object';
          const toolInput = argsComplete ? input.tool_input : {};
          if (!remotePolicyFor(live)) return {};
          const computer = isComputerTool(tool) ? computerAccess(live) : undefined;
          const denied = remoteGate(live, tool, toolInput, { argsComplete, computer });
          if (denied) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denied.reason } };
          // A computer tool: it runs (Autonomous with the owner's switch on, or a turn the owner
          // approved), or the SDK asks canUseTool, which onBrainPacket turns into the turn's one
          // "control your Mac for this?" request (computerControlRequest).
          if (computer) {
            return computer.access === 'run'
              ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Computer use is on for this WhatsApp turn.' } }
              : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'The user is asked once per task before the Mac is controlled from WhatsApp.' } };
          }
          if (remoteLevel(live) === 'autonomous' || REMOTE_ASK_EXEMPT.has(tool)) return {};
          if (claudeReadOnlyPermission(tool, toolInput) !== 'deny') return {};
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `This session is driven from ${live.record.remote?.channel === 'whatsapp' || !live.record.remote?.channel ? 'WhatsApp' : live.record.remote.channel}: the user approves ${tool} first.` } };
        }],
      }],
    };
  }
  /**
   * Claude brain: an in-process PreToolUse hook (subagent calls pass; launching
   * them was gated), and after an approved ExitPlanMode a note that the work it
   * continues into is routed first (answerControl reset the gate).
   */
  function gateHooks(live) {
    return {
      PreToolUse: [{
        hooks: [async (input) => {
          if (!live.gate || input?.agent_id) return {};
          const decision = decide(live, input?.tool_name);
          if (decision.allow) return {};
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } };
        }],
      }],
      PostToolUse: [{
        matcher: 'ExitPlanMode',
        hooks: [async (input) => {
          if (!live.gate || input?.agent_id || isPlanningLive(live) || live.gate.isOpen()) return {};
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'SynaBun: the plan is approved and plan mode is off. Route the approved work first (agent_route), then carry it out here or dispatch it.' } };
        }],
      }],
    };
  }
  /**
   * Reactive fallback (a Codex brain whose app-server could not run the hook, an
   * OpenCode brain whose serve never loaded the plugin): a tool the gate or the
   * browser policy refuses has already started, so the turn is interrupted and
   * one system turn says why. A route refusal counts toward the loop guard.
   */
  function reactiveGate(live, event) {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of blocks) {
      if (block?.type !== 'tool_use' || live.gateNudge) continue;
      const browser = browserGate(live, block.name, block.input || {});
      const decision = browser || decide(live, block.name);
      if (decision.allow || decision.abort) continue;
      live.gateNudge = { reason: decision.reason, gen: live.gen, browser: !!browser };
      log(browser ? 'assistant:browser-policy' : 'assistant:route-gate', `${live.record.id}: interrupting ${block.name} (reactive)`);
      Promise.resolve(live.brain?.abort?.()).catch(() => {});
      return;
    }
  }

  // ── desktop service hooks (lib/desktop/service.js) ─────────────────────────
  /** The desktop gate's question: may this session act right now. A remote session: only inside a turn that may (computerRuns). */
  function getComputerUse(id) {
    const live = sessions.get(id);
    if (!live) return false;
    return remotePolicyFor(live) ? computerRuns(live) : computerEffective(live.record);
  }
  /** The turn a remote session's computer use belongs to right now (null: none, or a desktop session): the desktop service binds every admitted call to it. */
  function getComputerTurn(id) {
    const live = sessions.get(id);
    return live && remotePolicyFor(live) ? (live.computerTurn?.id ?? null) : null;
  }
  /** The desktop stopped this session (Esc, the corner, a Stop button; `reason` says which): its turn is interrupted. */
  async function abortTurn(id, { reason = null } = {}) {
    const live = sessions.get(id);
    if (!live) return false;
    dropWork(live, 'continuation');
    if (remotePolicyFor(live)) {
      // Driven from a phone: its computer use ends here, and the phone hears it (the bridge says it in one line).
      endComputerTurn(live, 'desktop_stop');
      dropRouteComputer(live);
      const status = { type: 'event', event: { type: 'system', subtype: 'status', text: 'Computer control was stopped on this Mac.' } };
      sendToSockets(live, status);
      appendTranscript(live.record.id, { at: iso(now()), packet: status });
      sendToSockets(live, { type: 'assistant:computer', phase: 'stopped', by: 'mac', reason: reason ? String(reason).slice(0, 40) : null });
    }
    try { await live.brain?.abort?.(); } catch {}
    return true;
  }
  function notifySession(id, packet) { const live = sessions.get(id); if (live && packet) sendToSockets(live, packet); }

  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  async function shutdown() {
    if (unsubscribeDispatcher) { try { unsubscribeDispatcher(); } catch {} unsubscribeDispatcher = null; }
    if (unsubscribePolicy) { try { unsubscribePolicy(); } catch {} unsubscribePolicy = null; }
    if (unsubscribeUsage) { try { unsubscribeUsage(); } catch {} unsubscribeUsage = null; }
    for (const timer of usageTimers.values()) clearTimeout(timer);
    usageTimers.clear();
    packetObservers.clear();
    shuttingDown = true;
    for (const live of sessions.values()) {
      if (live.mailboxTimer) clearTimeout(live.mailboxTimer);
      if (live.disposeTimer) clearTimeout(live.disposeTimer);
      if (live.workTimer) clearTimeout(live.workTimer);
      await disposeBrain(live, 'shutdown').catch(() => {});
      live.record.status = 'idle';
    }
    persist({ force: true });
    // Rows whose append failed get one more try before the process goes.
    metered('flush', () => usage?.flush?.());
  }

  loadIndex();
  if (usage?.subscribe) unsubscribeUsage = metered('subscribe', () => usage.subscribe((sessionId) => scheduleUsage(sessionId)));
  if (remotePolicy?.subscribe) {
    unsubscribePolicy = remotePolicy.subscribe(({ sessionId, previous }) => { try { onRemotePolicyChanged(sessionId, previous); } catch (error) { log('assistant:remote-policy', error?.message || String(error)); } });
  }
  if (dispatcher?.subscribe) {
    unsubscribeDispatcher = dispatcher.subscribe((payload) => {
      if (payload?.type === 'assistant:dispatch') onDispatchEvent(payload);
      else if (payload?.type === 'assistant:run-removed') onRunRemoved(payload);
    });
  }
  const originalBroadcast = broadcastSync;
  // Permission broadcasts come from the dispatcher through broadcastSync; observe them here too.
  broadcastSync = (message) => { try { originalBroadcast(message); } catch {} if (message?.type === 'assistant:permission-request' || message?.type === 'assistant:permission-resolved') onPermissionBroadcast(message); };

  return {
    handleWebSocket, listSessions, getSession, createSession, updateSession, closeSession, destroySession,
    resolveTerminal, accountInUse, ownsIsolatedServe, noteDispatch, subscribe, shutdown,
    observeBroadcast: onPermissionBroadcast,
    routerSession, routerSend, routerEvent, routerMailbox, routerContinue, routerSinks, routerRouted, routerRouteFailed, routerComputerApproved, gateCheck, isPlanning, isPlanReadOnly,
    clarifySession, clarifyEvent, clarifyGate, clarifySinks,
    getComputerUse, getComputerTurn, supersedeComputerApproval, abortTurn, notifySession,
    brainSpend, brainCapUsd, onBudgetChanged, currentTask, usageView,
    // Programmatic surface (the WhatsApp bridge) and remote sessions.
    observe, submit, stopTurn, answerControl, answerDispatchControl, pendingControls, isBusy, sessionPolicy, sessionChannel,
    _internals: { sessions, ensureBrain, disposeBrain, runQuery, enqueueMailbox, deliverMailbox, settings, ensureGate, onBrainPacket, onTurnFinished, remoteHooks, packetObservers },
  };
}
