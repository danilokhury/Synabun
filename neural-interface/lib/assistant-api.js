// ═══════════════════════════════════════════
// SynaBun — Assistant REST API (/api/assistant/*)
// ═══════════════════════════════════════════
//
// One router for everything the assistant UI and the MCP `agents` tool group
// need: catalog, dispatch + run control, waits, transcripts, assistant sessions,
// composer attachments, Claude/Codex account management, and the sidepanel tab registry.
// Mounted from server.js with `app.use('/api/assistant', createAssistantApi(deps))`.

import { Router } from 'express';
import { DispatchError } from './assistant-dispatch.js';
import { openServable } from './assistant-media.js';
import { designFit, targetMakes } from './assistant-router.js';
import { normalizeEffort } from './effort-levels.js';
import { BUDGET_DEFAULTS, BUDGET_FIELDS, BUDGET_MAX_USD, BUDGET_MIN_USD } from './assistant-budget.js';
import { tooLargeMessage } from './assistant-attachments.js';
import { getSessionPolicy, requiresHumanApproval } from './remote-policy.js';
import { clampPlanDispatch, PLAN_DISPATCH_NOTE, runCanChangeCode } from './assistant-plan-permissions.js';

/**
 * How far each provider's spend can be held to a cap (shown in the Budget tab).
 * A cap is checked where the provider lets it be checked; between two checks a
 * run can go past it by that much.
 */
export const BUDGET_ENFORCEMENT = Object.freeze({
  'claude-code': { metered: 'reported', perRun: 'The Claude CLI stops the run (--max-budget-usd); it checks between model calls, so one call can pass the cap.', session: 'Checked after every turn; at the hard cap the run is stopped mid-turn.' },
  opencode: { metered: 'reported', perRun: 'OpenCode reports each step\'s cost; the run stops at the first step past its cap.', session: 'Checked at every step.' },
  codex: { metered: 'estimated', perRun: 'Codex reports tokens only when a turn ends: priced at the models.dev list price (an API-price estimate; ChatGPT-plan accounts are billed by plan quota) and checked after each turn, so one turn can pass the cap. A failed turn is priced from its rollout.', session: 'Checked after every turn.' },
  brain: { metered: 'reported', perRun: 'Checked before every brain turn; a Claude brain\'s CLI also stops at what is left of the brain cap. A Codex brain\'s tokens are priced at list price (estimated); a brain model with no price is refused.', session: 'The brain\'s spend counts toward the session hard cap.' },
});

const OWNER_ONLY = { error: 'The assistant is available to the owner only', code: 'GUEST_FORBIDDEN' };

function sendError(res, error, fallbackStatus = 500) {
  if (error instanceof DispatchError || (error && error.code && error.status)) {
    const status = Number(error.status) || fallbackStatus;
    const body = typeof error.toJSON === 'function' ? error.toJSON() : { code: error.code, message: error.message };
    return res.status(status).json({ ok: false, error: body.message, ...body });
  }
  return res.status(fallbackStatus).json({ ok: false, error: error?.message || String(error), code: error?.code || 'INTERNAL' });
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clipSummary(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// A WhatsApp conversation never holds a turn open for workers (docs/whatsapp.md): the wait returns
// after this long (the dispatcher's shortest wait) and says what to do instead.
export const CHAT_WAIT_MS = 1000;
export const CHAT_WAIT_NEXT = 'This conversation is on WhatsApp: you do not wait for workers here. End your turn now with one short line that says what is running. Each result reaches you as a [SynaBun Mailbox] event, and you tell the user then. Do not call agent_wait again for these runs.';
export const CHAT_CLARIFY_NEXT = 'This conversation is on WhatsApp, where a question is asked in plain text, not on a card: nothing was shown to the user. Ask it in your reply (one short question; name the options inside the sentence only when they help) and end your turn. The user\'s next message is the answer. Work that does not depend on the answer may go ahead.';

/**
 * A run view for a brain (agent_wait / agent_status): the worker's full text
 * is dropped (`lastText`, `lastResult.raw`, `turns[].text`, `turns[].result.raw`)
 * and each turn keeps its status and a summary of at most 300 characters.
 * A 4.2k-character worker message used to make a 26.6k-character view, which
 * the MCP client truncated before the brain reached `lastResult`.
 * `agent_read format:"text"` still returns the full text.
 */
export function slimRunView(run) {
  if (!run || typeof run !== 'object') return run;
  const { lastText: _lastText, ...out } = run;
  if (run.lastResult && typeof run.lastResult === 'object') {
    const { raw: _raw, ...result } = run.lastResult;
    out.lastResult = result;
  }
  if (Array.isArray(run.turns)) {
    out.turns = run.turns.map((turn) => {
      if (!turn || typeof turn !== 'object') return turn;
      const { text: _text, result, ...rest } = turn;
      return { ...rest, status: result?.status || null, summary: clipSummary(result?.summary) };
    });
  }
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.dispatcher       createAssistantDispatcher()
 * @param {object} [deps.runtime]        createAssistantRuntime() (sessions; optional until wired)
 * @param {object} [deps.claudeAccounts] createClaudeAccounts()
 * @param {object} [deps.codexAccounts]  { listForClient(), rename(id,label), remove(id, {inUse}), addStart() }
 * @param {Function} [deps.buildCatalog] async () => catalog object (models/accounts/projects/profiles)
 * @param {Function} [deps.createLoginTerminal] async ({ env, cwd, profile, accountId }) => { terminalSessionId, profile }
 * @param {object} [deps.attachments]    createAttachmentStore() (POST /attachments)
 */
export function createAssistantApi({
  dispatcher,
  runtime = null,
  usage = null,
  claudeAccounts = null,
  codexAccounts = null,
  buildCatalog = null,
  createLoginTerminal = null,
  broadcastSync = () => {},
  isGuestRequest = () => false,
  log = () => {},
  tabTtlMs = 90_000,
  now = Date.now,
  // Routing: assistant-router.js service, assistant-catalog.js, assistant-config.js store.
  assistantRouter = null,
  catalog = null,
  configStore = null,
  taskClasses = null,
  // Codex list prices (assistant-budget.js createModelPricing): its status shows in the Budget tab.
  pricing = null,
  // Clarification (assistant-clarify.js): agent_clarify, clarify-card answers, briefs.
  clarifier = null,
  // Composer uploads (assistant-attachments.js createAttachmentStore).
  attachments = null,
  // Remote sessions (lib/remote-policy.js): the session's policy, or null. Defaults
  // to the runtime's view, else the process-wide registry.
  sessionPolicy = null,
} = {}) {
  if (!dispatcher) throw new Error('createAssistantApi requires a dispatcher');
  const router = Router();
  const uiTabs = new Map(); // windowId → { panels, at }
  let catalogCache = null;

  router.use((req, res, next) => {
    if (isGuestRequest(req)) return res.status(403).json(OWNER_ONLY);
    next();
  });

  // Resolve who is calling: the UI (no pin), an assistant brain (assistant-<uuid>
  // pin), or a dispatched worker (run id pin → forbidden for orchestration).
  function callerContext(req) {
    const pin = String(req.get('x-synabun-terminal') || req.get('x-synabun-assistant') || '').trim();
    const bodySession = req.body?.assistantSessionId || req.body?.assistant_session_id || req.query?.assistantSessionId || null;
    if (!pin) return { kind: 'ui', assistantSessionId: bodySession ? String(bodySession) : null };
    if (dispatcher.get(pin)) return { kind: 'worker', forbidden: true, pin };
    // A brain's pin resolves to its session (Claude pins the session id; the
    // OpenCode brain pins assistant-oc-<24>, which must never be taken as an id).
    const resolved = runtime?.resolveTerminal?.(pin) || null;
    if (resolved) return { kind: 'assistant', assistantSessionId: resolved, pin };
    if (/^assistant-oc-/.test(pin)) return { kind: 'assistant', assistantSessionId: bodySession ? String(bodySession) : null, pin };
    if (/^assistant-/.test(pin)) return { kind: 'assistant', assistantSessionId: pin, pin };
    return { kind: 'unknown', assistantSessionId: bodySession ? String(bodySession) : null, pin };
  }
  /**
   * The plan mode of the brain making this call: 'read-only' (a remote session
   * at the read-only level: no worker at all), 'plan' (no code changes: its
   * workers run read-only), or null (not planning, or not a brain: the UI, the
   * user, is never limited).
   */
  function planState(req, assistantSessionId) {
    if (!assistantSessionId || !brainCaller(req)) return null;
    try {
      if (runtime?.isPlanning?.(String(assistantSessionId)) !== true) return null;
      return runtime?.isPlanReadOnly?.(String(assistantSessionId)) === true ? 'read-only' : 'plan';
    } catch { return null; }
  }
  /** A read-only plan (a remote session's read-only level) starts and steers no worker: 409 PLAN_MODE_READ_ONLY. */
  function planRefusal(req, res, assistantSessionId, what) {
    if (planState(req, assistantSessionId) !== 'read-only') return false;
    res.status(409).json({ ok: false, code: 'PLAN_MODE_READ_ONLY', error: `Plan mode is read-only, so SynaBun did not ${what}. Keep exploring with read-only tools and put the delegation in the plan; it runs after the user approves the plan.` });
    return true;
  }
  /** A planning brain steers only workers that cannot change code: 409 PLAN_MODE_CODE_CHANGE for a workspace / full run. */
  function planSendRefusal(res, run) {
    if (!run || !runCanChangeCode(run)) return false;
    res.status(409).json({ ok: false, code: 'PLAN_MODE_CODE_CHANGE', error: `Plan mode blocks code changes, so SynaBun did not send run ${run.runId} a message: it runs with capability "${run.capability || 'full'}" and can change code. Put that step in the plan; it runs after the user approves the plan. To explore meanwhile, dispatch a worker (it runs read-only while you plan).` });
    return true;
  }
  /** Milliseconds left before the MCP caller gives up (X-Synabun-Deadline), or null. */
  function callerBudgetMs(req) {
    const deadline = Number(req.get('x-synabun-deadline'));
    return Number.isFinite(deadline) && deadline > 0 ? deadline - now() : null;
  }
  function orchestrationGuard(req, res, next) {
    const caller = callerContext(req);
    if (caller.forbidden) return res.status(403).json({ ok: false, code: 'AGENTS_NOT_PERMITTED', error: 'Dispatched workers cannot orchestrate other agents.' });
    req.assistantCaller = caller;
    next();
  }
  /**
   * The caller when it is an assistant brain, else null. Brains pin their
   * session (Claude) or assistant-oc-<24> (OpenCode); the Codex brain's MCP
   * child pins codex-sp-<uuid>, which no session resolves, but it sends
   * X-Synabun-Role: assistant. The UI, workers and other sessions never count.
   */
  function brainCaller(req) {
    const caller = req.assistantCaller || callerContext(req);
    if (caller.kind === 'assistant') return caller;
    if (caller.kind === 'unknown' && String(req.get('x-synabun-role') || '').trim().toLowerCase() === 'assistant') return caller;
    return null;
  }
  /** A remote session whose workers only a person may answer (strict worker approvals below autonomous). */
  function humanApprovalRequired(assistantSessionId) {
    if (!assistantSessionId) return false;
    let policy = null;
    try {
      policy = typeof sessionPolicy === 'function' ? sessionPolicy(String(assistantSessionId))
        : (runtime?.sessionPolicy ? runtime.sessionPolicy(String(assistantSessionId)) : getSessionPolicy(String(assistantSessionId)));
    } catch { policy = null; }
    return requiresHumanApproval(policy || null);
  }
  /**
   * A brain read these runs' results: once the response is out, record the
   * turn it saw, so the mailbox does not hand it the same result again.
   */
  function noteBrainRead(req, res, runs, via) {
    if (typeof dispatcher.markDelivered !== 'function') return;
    const caller = brainCaller(req);
    if (!caller) return;
    const marks = (Array.isArray(runs) ? runs : [runs])
      .filter((run) => run && run.runId)
      .map((run) => ({ runId: run.runId, turn: Number(run.resultTurn) || 0, state: run.state || null }));
    if (!marks.length) return;
    res.on('finish', () => {
      for (const mark of marks) {
        try { dispatcher.markDelivered(mark.runId, { turn: mark.turn, state: mark.state, via, assistantSessionId: caller.assistantSessionId || null }); } catch {}
      }
    });
  }
  /** Where a session's conversation happens: 'whatsapp' (WhatsApp Link), or null (the panel). */
  function channelOf(assistantSessionId) {
    if (!assistantSessionId) return null;
    const id = String(assistantSessionId);
    try { const own = runtime?.sessionChannel?.(id); if (own) return own; } catch {}
    try {
      const policy = typeof sessionPolicy === 'function' ? sessionPolicy(id) : (runtime?.sessionPolicy ? runtime.sessionPolicy(id) : getSessionPolicy(id));
      return policy?.channel || null;
    } catch { return null; }
  }
  /** The assistant session a wait is for: the calling brain's, else the one that owns the runs. */
  function waitSession(req, { runId = null, runIds = null, workflowId = null } = {}) {
    const own = req.assistantCaller?.assistantSessionId || null;
    if (own) return own;
    try {
      const first = runId || (Array.isArray(runIds) ? runIds[0] : null);
      if (first) return dispatcher.get(first)?.assistantSessionId || null;
      if (workflowId) return dispatcher.list({ workflowId, limit: 1 })?.[0]?.assistantSessionId || null;
    } catch {}
    return null;
  }
  /**
   * A brain talking to its user on WhatsApp never sits in agent_wait: the wait
   * returns at once (what is done already is still reported) and tells the
   * brain to end its turn, because the result arrives as a mailbox event. The
   * user keeps chatting meanwhile. Desktop sessions wait as asked.
   */
  function chatWait(req, target) {
    return !!brainCaller(req) && channelOf(waitSession(req, target)) === 'whatsapp';
  }
  function chatWaitView(result) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.pending) || !result.pending.length) return result;
    return { ...result, channel: 'whatsapp', next: CHAT_WAIT_NEXT };
  }
  /** Wait/status payloads for a brain carry slim run views (see slimRunView). */
  function brainWaitView(result) {
    if (!result || typeof result !== 'object') return result;
    return {
      ...result,
      done: Array.isArray(result.done) ? result.done.map(slimRunView) : result.done,
      pending: Array.isArray(result.pending) ? result.pending.map(slimRunView) : result.pending,
    };
  }

  // ── catalog ────────────────────────────────────────────────────────────────
  router.get('/catalog', async (req, res) => {
    try {
      const force = req.query.refresh === '1';
      // Brain view / search: compact rows (OpenCode can list hundreds of models).
      const view = req.query.view === 'brain' ? 'brain' : req.query.view === 'manage' ? 'manage' : 'full';
      const provider = req.query.provider ? String(req.query.provider) : null;
      const q = req.query.q || req.query.search ? String(req.query.q || req.query.search) : null;
      // The Models manager: every row with hidden: true|false.
      if (view === 'manage' && catalog?.get) return res.json({ ok: true, ...(await catalog.get({ force, view: 'manage', provider })) });
      if (catalog?.get && (view === 'brain' || provider || q)) {
        let preferences = {};
        try { preferences = configStore?.routing?.().preferences || {}; } catch {}
        const brief = await catalog.get({ force, view: 'brain', provider, q, preferences });
        return res.json({ ok: true, generatedAt: new Date(now()).toISOString(), ...brief, limits: dispatcher.limits, runs: dispatcher.list({ activeOnly: true }), totals: dispatcher.totals() });
      }
      // Reuse only while the catalog underneath is the same build (invalidate() drops it).
      if (!force && catalogCache && now() - catalogCache.at < 30_000 && (!catalog?.peek || catalog.peek() === catalogCache.base)) return res.json(catalogCache.value);
      const base = typeof buildCatalog === 'function' ? await buildCatalog({ force }) : {};
      // Hidden rows stay server-side (view=manage lists them); the lists themselves ship.
      const { hiddenRows: _hiddenRows, ...visible } = base || {};
      const value = {
        ok: true,
        generatedAt: new Date(now()).toISOString(),
        ...visible,
        accounts: {
          ...(base.accounts || {}),
          'claude-code': claudeAccounts ? claudeAccounts.listForClient() : (base.accounts?.['claude-code'] || []),
          codex: codexAccounts ? codexAccounts.listForClient() : (base.accounts?.codex || []),
        },
        limits: dispatcher.limits,
        runs: dispatcher.list({ activeOnly: true }),
        totals: dispatcher.totals(),
        sidepanelTabs: listTabs(),
        assistantSessions: runtime ? runtime.listSessions() : [],
      };
      catalogCache = { at: now(), value, base };
      res.json(value);
    } catch (error) { sendError(res, error); }
  });

  // ── dispatch + runs ────────────────────────────────────────────────────────
  router.post('/dispatch', orchestrationGuard, async (req, res) => {
    try {
      const body = req.body || {};
      const spec = {
        ...body,
        accountId: body.accountId || body.account_id || body.codexAccountId || body.claudeAccountId || null,
        mcpProfile: body.mcpProfile || body.mcp_profile,
        permissionPolicy: body.permissionPolicy || body.permission_policy,
        maxMinutes: body.maxMinutes ?? body.max_minutes,
        budgetUsd: body.budgetUsd ?? body.budget_usd,
        usesBrowser: body.usesBrowser ?? body.uses_browser,
        workflowId: body.workflowId || body.workflow_id,
        parentRunId: body.parentRunId || body.parent_run_id,
        outputSchema: body.outputSchema || body.output_schema,
        idempotencyKey: body.idempotencyKey || body.idempotency_key,
        queueIfBusy: body.queueIfBusy ?? body.queue_if_busy,
        idleTimeoutMs: body.idleTimeoutMs ?? (body.idle_timeout_sec ? Number(body.idle_timeout_sec) * 1000 : undefined),
        maxTurns: body.maxTurns ?? body.max_turns,
        routeId: body.routeId || body.route_id || null,
        taskClass: body.taskClass || body.task_class || null,
        confidence: body.confidence ?? null,
        usesComputer: body.usesComputer ?? body.uses_computer,
        agent: body.agent || null,
        // The user's brief after agent_clarify (the server attaches it; a body never carries one).
        briefId: body.briefId || body.brief_id || null,
        independent: body.independent === true || body.independent === 'true',
      };
      delete spec.brief;
      const assistantSessionId = req.assistantCaller.assistantSessionId || null;
      if (planRefusal(req, res, assistantSessionId, 'dispatch a worker')) return;
      // A planning brain's worker runs read-only (it cannot change code); the run's notes and the answer say so.
      const planning = planState(req, assistantSessionId) === 'plan';
      const notes = [];
      const result = planning
        ? await dispatcher.dispatch(clampPlanDispatch(spec, { notes }), { assistantSessionId, origin: req.assistantCaller.kind, notes })
        : await dispatcher.dispatch(spec, { assistantSessionId, origin: req.assistantCaller.kind });
      if (assistantSessionId && runtime?.noteDispatch) { try { runtime.noteDispatch(assistantSessionId, result.run.runId); } catch {} }
      res.status(result.queued ? 202 : 200).json(planning ? { ...result, planMode: { capability: 'read-only', note: PLAN_DISPATCH_NOTE } } : result);
    } catch (error) { sendError(res, error); }
  });

  // ── routing ────────────────────────────────────────────────────────────────
  function requireRouter(res) {
    if (!assistantRouter) { res.status(503).json({ ok: false, code: 'ROUTING_UNAVAILABLE', error: 'Routing is not available' }); return false; }
    return true;
  }
  function routingPayload() {
    const routing = configStore?.routing?.() || assistantRouter?.routing?.() || {};
    return {
      ok: true, version: configStore?.version?.() ?? 0, routing,
      // requires: the medium the model must generate (image / video creation); vision (only when true): only models
      // that can see (design); dispatchOnly: always a worker.
      taskClasses: Object.entries(taskClasses || {}).map(([id, meta]) => ({ id, label: meta.label, description: meta.description, defaultKind: meta.defaultKind, requires: meta.requires || null, ...(meta.vision === true ? { vision: true } : {}), dispatchOnly: meta.dispatchOnly === true })),
      modes: ['always-ask', 'ask-unsure', 'never'],
    };
  }
  function routingInvalid(field, message) {
    const error = new Error(message);
    error.code = 'ROUTING_INVALID';
    error.field = field;
    error.status = 400;
    return error;
  }
  /** The same saved route (kind, provider, model, effort), whatever its label or bookkeeping. */
  function samePreference(a, b) {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    return (a.kind || 'dispatch') === (b.kind || 'dispatch') && String(a.provider || '') === String(b.provider || '')
      && String(a.model || '') === String(b.model || '') && String(a.effort || '') === String(b.effort || '');
  }
  /**
   * PUT /routing, classes that need sight (design): a new or changed route must be a worker on a
   * model confirmed to see and available (the router's designFit). It fails closed: without a
   * catalog value the route is refused. Clearing the row is always allowed, and a route the user
   * already has is not checked again. Image / video routes keep their own check below.
   */
  async function checkSightPreferences(preferences) {
    const saved = configStore?.routing?.()?.preferences || {};
    let cat;
    for (const [key, pref] of Object.entries(preferences)) {
      const meta = taskClasses?.[key] || null;
      if (meta?.vision !== true || !pref || typeof pref !== 'object' || samePreference(pref, saved[key])) continue;
      if (pref.kind === 'direct') throw routingInvalid(`preferences.${key}`, `${meta.label} always runs on a worker: pick a model, not "here".`);
      if (!pref.provider) continue; // patchRouting refuses it with the precise field
      const name = pref.label || pref.model || `the ${pref.provider} default model`;
      if (cat === undefined) {
        cat = null;
        if (catalog?.full) { try { cat = await catalog.full(); } catch { cat = catalog.peek?.() || null; } }
      }
      if (!cat) throw routingInvalid(`preferences.${key}`, `Can't confirm that ${name} can see images right now: the model catalog is unavailable. Try again shortly, or clear the ${meta.label} row.`);
      const fit = designFit(cat, { ...pref, kind: 'dispatch' });
      if (fit !== 'ok') {
        throw routingInvalid(`preferences.${key}`, `${name} ${fit === 'blind' ? "can't see images" : fit === 'unavailable' ? "isn't available right now" : "isn't known to see images"}; ${meta.label} needs a model that can.`);
      }
    }
  }
  router.get('/routing', (req, res) => {
    if (!requireRouter(res)) return;
    try { res.json(routingPayload()); } catch (error) { sendError(res, error); }
  });
  router.put('/routing', async (req, res) => {
    if (!requireRouter(res)) return;
    if (!configStore?.patchRouting) return res.status(503).json({ ok: false, code: 'CONFIG_UNAVAILABLE', error: 'Routing settings are read-only' });
    if (callerContext(req).kind !== 'ui') return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Routing settings are changed from the assistant panel only.' });
    try {
      const body = req.body || {};
      const patch = body.routing && typeof body.routing === 'object' ? body.routing : body;
      const { version: _v, ...clean } = patch;
      const expectedVersion = body.version ?? patch.version ?? null;
      // Each preference's effort is checked against its model; corrections are reported.
      // An image / video creation route must be a worker on a model that makes the medium;
      // a design route is checked first, on its own (checkSightPreferences).
      const corrections = [];
      if (clean.preferences && typeof clean.preferences === 'object') await checkSightPreferences(clean.preferences);
      if (clean.preferences && typeof clean.preferences === 'object' && catalog?.full) {
        let cat = null;
        try { cat = await catalog.full(); } catch { cat = catalog.peek?.() || null; }
        const preferences = {};
        for (const [key, raw] of Object.entries(clean.preferences)) {
          let pref = raw;
          const meta = taskClasses?.[key] || null;
          if (pref && typeof pref === 'object' && meta?.requires) {
            if (meta.dispatchOnly) pref = { ...pref, kind: 'dispatch' };
            if (cat && pref.provider && !targetMakes(cat, pref, meta.requires)) {
              throw routingInvalid(`preferences.${key}`, `${pref.label || pref.model || `the ${pref.provider} default model`} can't generate ${meta.requires === 'video' ? 'videos' : 'images'}; ${meta.label} needs a model that does.`);
            }
          }
          if (!pref || typeof pref !== 'object' || !pref.effort) { preferences[key] = pref; continue; }
          const { effort, corrected } = normalizeEffort({ provider: pref.provider, model: pref.model || null, effort: pref.effort, catalog: cat });
          if (corrected) corrections.push({ key, field: 'effort', from: corrected.from, to: corrected.to, reason: 'effort_unsupported' });
          preferences[key] = { ...pref, effort };
        }
        clean.preferences = preferences;
      }
      configStore.patchRouting(clean, { expectedVersion, taskClasses: [...Object.keys(taskClasses || {}), 'vision'] });
      broadcastSync({ type: 'assistant:routing-changed', version: configStore.version() });
      res.json({ ...routingPayload(), corrections });
    } catch (error) {
      if (error?.code === 'ROUTING_INVALID') return res.status(400).json({ ok: false, code: error.code, error: error.message, message: error.message, field: error.field || null });
      sendError(res, error, 400);
    }
  });
  router.delete('/routing/preferences/:key', (req, res) => {
    if (!requireRouter(res)) return;
    if (callerContext(req).kind !== 'ui') return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Routing settings are changed from the assistant panel only.' });
    try {
      configStore.patchRouting({ preferences: { [req.params.key]: null } }, { taskClasses: [...Object.keys(taskClasses || {}), 'vision'] });
      broadcastSync({ type: 'assistant:routing-changed', version: configStore.version() });
      res.json(routingPayload());
    } catch (error) { sendError(res, error, 400); }
  });
  // ── budget ─────────────────────────────────────────────────────────────────
  function budgetPayload(sessionId = null) {
    const current = configStore.budget();
    const budget = Object.fromEntries(BUDGET_FIELDS.map((field) => [field, current[field]]));
    let session = null;
    if (sessionId) { try { session = dispatcher.sessionBudget?.(String(sessionId)) || null; } catch { session = null; } }
    let pricingStatus = null;
    try { pricingStatus = pricing?.status?.() || null; } catch { pricingStatus = null; }
    return {
      ok: true, version: current.version, budget, defaults: { ...BUDGET_DEFAULTS }, sources: current.sources, repairs: current.repairs,
      bounds: { minUsd: BUDGET_MIN_USD, maxUsd: BUDGET_MAX_USD }, session, pricing: pricingStatus, enforcement: BUDGET_ENFORCEMENT,
    };
  }
  router.get('/budget', (req, res) => {
    if (!configStore?.budget) return res.status(503).json({ ok: false, code: 'CONFIG_UNAVAILABLE', error: 'Budget settings are not available' });
    try { res.json(budgetPayload(req.query.sessionId || null)); } catch (error) { sendError(res, error); }
  });
  router.put('/budget', (req, res) => {
    if (!configStore?.patchBudget) return res.status(503).json({ ok: false, code: 'CONFIG_UNAVAILABLE', error: 'Budget settings are read-only' });
    if (callerContext(req).kind !== 'ui') return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Budget settings are changed from the assistant panel only.' });
    try {
      const body = req.body || {};
      const patch = body.budget && typeof body.budget === 'object' ? body.budget : {};
      const expectedVersion = body.version ?? null;
      const saved = configStore.patchBudget(patch, { expectedVersion });
      // Applies now: the dispatcher re-reads its limits, the runtime re-checks every session.
      try { dispatcher.refreshLimits?.(); } catch {}
      try { runtime?.onBudgetChanged?.(); } catch {}
      broadcastSync({ type: 'assistant:budget-changed', version: saved.version });
      res.json(budgetPayload(body.sessionId || null));
    } catch (error) {
      if (error?.code === 'BUDGET_INVALID' || error?.code === 'VERSION_CONFLICT') {
        return res.status(error.status || 400).json({ ok: false, code: error.code, error: error.message, message: error.message, field: error.field || null, version: error.version ?? null });
      }
      sendError(res, error, 400);
    }
  });

  // The route gate's answer for one tool call, asked by the assistant brains'
  // OpenCode plugin and Codex hook (each holds a per-session token).
  router.post('/route-gate/check', (req, res) => {
    if (!runtime?.gateCheck) return res.json({ allow: true });
    const body = req.body || {};
    const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {};
    // inputComplete: the hook sent the call's whole arguments (a remote session refuses a call checked without them).
    try { res.json(runtime.gateCheck({ session: body.session, token: body.token, tool: body.tool, input, inputComplete: body.inputComplete === true, providerSessionId: body.providerSessionId || null, agent: body.agent || null, hello: body.hello === true, host: typeof body.host === 'string' ? body.host : null })); }
    catch (error) { sendError(res, error); }
  });
  // agent_route: the brain proposes; the router approves, asks, or says pending.
  router.post('/route', orchestrationGuard, async (req, res) => {
    if (!requireRouter(res)) return;
    try {
      const body = req.body || {};
      const sessionId = req.assistantCaller.assistantSessionId || body.assistantSessionId || body.assistant_session_id || null;
      if (!sessionId) return res.status(400).json({ ok: false, code: 'SESSION_REQUIRED', error: 'assistant_session_id is required' });
      const budget = callerBudgetMs(req);
      const waitMs = budget === null ? null : Math.max(0, budget - 5000);
      const controller = new AbortController();
      req.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const result = await assistantRouter.propose({ sessionId: String(sessionId), body, origin: 'agent_route', waitMs, signal: controller.signal });
      res.status(result.status === 'pending' ? 202 : 200).json(result);
    } catch (error) { sendError(res, error); }
  });
  // agent_clarify: the brain's 1-3 questions go to the user on a card; the
  // answers (or "pending") come back, and dispatches carry the brief.
  function requireClarifier(res) {
    if (!clarifier) { res.status(503).json({ ok: false, code: 'CLARIFY_UNAVAILABLE', error: 'Clarification is not available' }); return false; }
    return true;
  }
  router.post('/clarify', orchestrationGuard, async (req, res) => {
    if (!requireClarifier(res)) return;
    try {
      const body = req.body || {};
      const sessionId = req.assistantCaller.assistantSessionId || body.assistantSessionId || body.assistant_session_id || null;
      if (!sessionId) return res.status(400).json({ ok: false, code: 'SESSION_REQUIRED', error: 'assistant_session_id is required' });
      // On WhatsApp a question is asked in the chat itself: no card is raised, so nothing waits behind one.
      if (channelOf(sessionId) === 'whatsapp') return res.json({ ok: false, status: 'text_only', code: 'CLARIFY_TEXT_ONLY', next: CHAT_CLARIFY_NEXT });
      const budget = callerBudgetMs(req);
      const waitMs = budget === null ? null : Math.max(0, budget - 5000);
      const controller = new AbortController();
      req.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const result = await clarifier.ask({ sessionId: String(sessionId), body, waitMs, signal: controller.signal });
      res.status(result.status === 'pending' ? 202 : 200).json(result);
    } catch (error) { sendError(res, error); }
  });
  // A card answer as it came over HTTP, without `superseded`: that marker ("the user wrote something
  // else": a silent cancel) is the WhatsApp bridge's alone and is never taken from a request.
  function cardAnswer(req) {
    const raw = req.body?.response || req.body || {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const { superseded: _dropped, ...response } = raw;
    return response;
  }
  router.post('/clarify/:requestId/answer', (req, res) => {
    if (!requireClarifier(res)) return;
    if (callerContext(req).kind !== 'ui') return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Clarify cards are answered by the user.' });
    try { res.json(clarifier.answer(req.params.requestId, cardAnswer(req), { origin: 'rest' })); } catch (error) { sendError(res, error); }
  });
  router.get('/briefs/:briefId', (req, res) => {
    if (!requireClarifier(res)) return;
    const brief = clarifier.get(req.params.briefId);
    if (!brief) return res.status(404).json({ ok: false, code: 'BRIEF_NOT_FOUND', error: `Unknown brief ${req.params.briefId}` });
    res.json({ ok: true, brief });
  });
  router.get('/sessions/:id/clarify', (req, res) => {
    if (!requireClarifier(res)) return;
    res.json({ ok: true, cards: clarifier.pendingCards(req.params.id) });
  });

  router.get('/routes/:routeId', (req, res) => {
    if (!requireRouter(res)) return;
    const status = assistantRouter.status(req.params.routeId);
    if (!status) return res.status(404).json({ ok: false, code: 'ROUTE_NOT_FOUND', error: `Unknown route ${req.params.routeId}` });
    res.json({ ok: true, route: status });
  });
  router.post('/routes/:routeId/answer', async (req, res) => {
    if (!requireRouter(res)) return;
    if (callerContext(req).kind !== 'ui') return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Route cards are answered by the user.' });
    try { res.json(await assistantRouter.answer(req.params.routeId, cardAnswer(req), { origin: 'rest' })); } catch (error) { sendError(res, error); }
  });
  router.get('/sessions/:id/routes', (req, res) => {
    if (!requireRouter(res)) return;
    res.json({ ok: true, cards: assistantRouter.pendingCards(req.params.id) });
  });
  router.post('/runs/:runId/escalate', orchestrationGuard, async (req, res) => {
    try {
      const result = await dispatcher.escalate(req.params.runId, { target: req.body?.target || null });
      const sessionId = result?.run?.assistantSessionId;
      if (sessionId && runtime?.noteDispatch) { try { runtime.noteDispatch(sessionId, result.run.runId); } catch {} }
      res.status(result?.queued ? 202 : 200).json(result);
    } catch (error) { sendError(res, error); }
  });

  router.get('/runs', (req, res) => {
    try {
      const active = req.query.active === '1' || req.query.activeOnly === '1';
      res.json({
        ok: true,
        runs: dispatcher.list({
          activeOnly: active,
          assistantSessionId: req.query.assistantSessionId || null,
          workflowId: req.query.workflowId || null,
          status: req.query.status || null,
          limit: clampInt(req.query.limit, 1, 500, 100),
        }),
        totals: dispatcher.totals({ assistantSessionId: req.query.assistantSessionId || null, workflowId: req.query.workflowId || null }),
      });
    } catch (error) { sendError(res, error); }
  });

  router.post('/wait', orchestrationGuard, async (req, res) => {
    try {
      const body = req.body || {};
      const target = { runId: body.runId || body.run_id || null, runIds: body.runIds || body.run_ids || null, workflowId: body.workflowId || body.workflow_id || null };
      const chat = chatWait(req, target);
      const result = await dispatcher.wait({
        ...target,
        assistantSessionId: req.assistantCaller.assistantSessionId || null,
        until: body.until || 'idle',
        mode: body.mode || 'all',
        timeoutMs: chat ? CHAT_WAIT_MS : (body.timeoutMs ?? (body.timeout_seconds ? Number(body.timeout_seconds) * 1000 : 30_000)),
      });
      const brain = brainCaller(req);
      if (brain) noteBrainRead(req, res, result?.done, 'agent_wait');
      res.json(brain ? brainWaitView(chat ? chatWaitView(result) : result) : result);
    } catch (error) { sendError(res, error); }
  });

  router.post('/kill-all', orchestrationGuard, async (req, res) => {
    try {
      const body = req.body || {};
      const assistantSessionId = body.assistantSessionId || body.assistant_session_id || req.assistantCaller.assistantSessionId || null;
      const workflowId = body.workflowId || body.workflow_id || null;
      // Only the user may stop every run of every session; a brain must name
      // its own session (or a workflow).
      if (!assistantSessionId && !workflowId && req.assistantCaller.kind !== 'ui') {
        return res.status(400).json({ ok: false, code: 'SCOPE_REQUIRED', error: 'Pass assistant_session_id (your ASSISTANT_SESSION_ID) or workflow_id to stop runs.' });
      }
      const result = await dispatcher.killAll({ assistantSessionId, workflowId, reason: body.reason || 'kill_all' });
      res.json(result);
    } catch (error) { sendError(res, error); }
  });

  router.get('/runs/:runId', (req, res) => {
    const run = dispatcher.get(req.params.runId);
    if (!run) return res.status(404).json({ ok: false, code: 'RUN_NOT_FOUND', error: `Unknown run ${req.params.runId}` });
    const brain = brainCaller(req);
    if (brain) noteBrainRead(req, res, run, 'agent_status');
    res.json({ ok: true, run: brain ? slimRunView(run) : run });
  });
  router.get('/runs/:runId/result', (req, res) => {
    try {
      const out = dispatcher.transcript(req.params.runId, { format: 'result' });
      if (out?.result) {
        const run = dispatcher.get(req.params.runId);
        if (run) noteBrainRead(req, res, run, 'agent_read');
      }
      res.json({ ok: true, ...out });
    } catch (error) { sendError(res, error); }
  });
  router.get('/runs/:runId/transcript', (req, res) => {
    try {
      const format = req.query.format || 'tail';
      const out = dispatcher.transcript(req.params.runId, {
        format,
        tail: clampInt(req.query.tail, 1, 500, 40),
        maxChars: clampInt(req.query.maxChars, 200, 20_000, 4000),
      });
      // Only the full text is a read of the result; a tail of events is not.
      if (format === 'text') {
        const run = dispatcher.get(req.params.runId);
        if (run) noteBrainRead(req, res, run, 'agent_read');
      }
      res.json({ ok: true, ...out });
    } catch (error) { sendError(res, error); }
  });
  // The images / videos an image or video creation run generated: only files the
  // dispatcher recorded for that run (copied under data/media/<runId>/), never a
  // path from the request; owner-only like everything here. sendFile answers
  // Range requests, so a video seeks.
  router.get('/runs/:runId/media/:n', async (req, res) => {
    const notFound = () => res.status(404).json({ ok: false, code: 'MEDIA_NOT_FOUND', error: `No media ${req.params.n} for run ${req.params.runId}` });
    if (!/^\d{1,4}$/.test(String(req.params.n))) return notFound();
    let file = null;
    try { file = dispatcher.mediaFile?.(req.params.runId, Number(req.params.n)) || null; } catch { file = null; }
    // Opened once (O_NOFOLLOW, still the checked file) and streamed from that handle: nothing swapped in after the check is served.
    const opened = file?.path ? await openServable(file.path) : null;
    if (!opened) return notFound();
    const { handle, size } = opened;
    let start = 0;
    let end = size - 1;
    // One range only: several ("bytes=0-1,3-4") are ignored and the whole file is sent, as RFC 9110 allows.
    const header = String(req.get('range') || '').trim();
    const range = header.includes(',') ? '' : header;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m && (m[1] || m[2])) {
        if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
        else start = Math.max(0, size - Number(m[2]));
      }
      if (!m || (!m[1] && !m[2]) || start > end || start >= size) {
        await handle.close().catch(() => {});
        return res.status(416).set('Content-Range', `bytes */${size}`).end();
      }
    }
    res.status(range ? 206 : 200).set({
      'Content-Type': file.mime || 'application/octet-stream', 'Content-Length': String(size ? end - start + 1 : 0),
      'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600',
    });
    if (range) res.set('Content-Range', `bytes ${start}-${end}/${size}`);
    if (req.method === 'HEAD' || !size) { await handle.close().catch(() => {}); return res.end(); }
    const stream = handle.createReadStream({ start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  router.get('/runs/:runId/wait', orchestrationGuard, async (req, res) => {
    try {
      const chat = chatWait(req, { runId: req.params.runId });
      const result = await dispatcher.wait({
        runId: req.params.runId,
        until: req.query.until || 'idle',
        timeoutMs: chat ? CHAT_WAIT_MS : clampInt(req.query.timeout, 1000, 120_000, 30_000),
      });
      const brain = brainCaller(req);
      if (brain) noteBrainRead(req, res, result?.done, 'agent_wait');
      res.json(brain ? brainWaitView(chat ? chatWaitView(result) : result) : result);
    } catch (error) { sendError(res, error); }
  });
  router.post('/runs/:runId/send', orchestrationGuard, (req, res) => {
    try {
      const body = req.body || {};
      const assistantSessionId = req.assistantCaller.assistantSessionId || dispatcher.get(req.params.runId)?.assistantSessionId || null;
      if (planRefusal(req, res, assistantSessionId, 'send a worker a message')) return;
      if (planState(req, assistantSessionId) === 'plan' && planSendRefusal(res, dispatcher.get(req.params.runId))) return;
      const origin = body.origin === 'user' ? 'user' : (req.assistantCaller.kind === 'ui' ? (body.origin || 'assistant') : 'assistant');
      res.json(dispatcher.sendTurn(req.params.runId, body.text ?? body.message, { origin, queue: body.queue !== false }));
    } catch (error) { sendError(res, error); }
  });
  router.post('/runs/:runId/permission', orchestrationGuard, (req, res) => {
    try {
      const body = req.body || {};
      const requestId = body.requestId || body.request_id;
      if (!requestId) return res.status(400).json({ ok: false, code: 'REQUEST_ID_REQUIRED', error: 'requestId is required' });
      // A brain answers the workers of its own session only (allow and deny alike): the run's session
      // against the caller's, which is its pin's (Claude, OpenCode) or the one it declares (a Codex
      // brain's MCP child, whose pin resolves to no session). A brain caller with no session at all
      // cannot be placed and is left as it was; the UI (a person) answers any run.
      const brain = brainCaller(req);
      const runSession = dispatcher.get(req.params.runId)?.assistantSessionId || null;
      if (brain?.assistantSessionId && runSession && String(runSession) !== String(brain.assistantSessionId)) {
        return res.status(403).json({ ok: false, code: 'RUN_NOT_IN_SESSION', error: `Run ${req.params.runId} belongs to another assistant session` });
      }
      // A remote session under strict worker approvals: only a person answers its workers.
      if (brain && humanApprovalRequired(runSession)) {
        return res.status(403).json({ ok: false, code: 'HUMAN_APPROVAL_REQUIRED', error: 'This run belongs to a WhatsApp session with strict worker approvals: the user answers its permission requests (on their phone or in SynaBun). Tell the user it is waiting for them.' });
      }
      // Who resolved it is the caller: only the UI may name another origin.
      const origin = req.assistantCaller.kind === 'ui' ? (body.origin || 'user') : 'assistant';
      res.json({ ok: true, run: dispatcher.respondPermission(req.params.runId, requestId, body, { origin }) });
    } catch (error) { sendError(res, error); }
  });
  router.post('/runs/:runId/stop', orchestrationGuard, async (req, res) => {
    try { res.json(await dispatcher.stop(req.params.runId, req.body?.reason || (req.assistantCaller.kind === 'ui' ? 'user' : 'assistant'))); } catch (error) { sendError(res, error); }
  });
  // Finished runs are cleared from the agents tray by the user, never by an agent.
  router.delete('/runs/:runId', async (req, res) => {
    if (callerContext(req).kind !== 'ui') return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Finished runs are removed from the assistant panel only.' });
    try { res.json(await dispatcher.remove(req.params.runId, { assistantSessionId: req.query.assistantSessionId || req.body?.assistantSessionId || null })); } catch (error) { sendError(res, error); }
  });
  router.post('/runs/clear-finished', async (req, res) => {
    if (callerContext(req).kind !== 'ui') return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Finished runs are removed from the assistant panel only.' });
    const body = req.body || {};
    const assistantSessionId = body.assistantSessionId || body.assistant_session_id || null;
    const workflowId = body.workflowId || body.workflow_id || null;
    const runIds = Array.isArray(body.runIds) ? body.runIds : null;
    if (!assistantSessionId && !workflowId && !runIds) return res.status(400).json({ ok: false, code: 'SCOPE_REQUIRED', error: 'Pass assistantSessionId, workflowId or runIds.' });
    try { res.json(await dispatcher.removeFinished({ assistantSessionId, workflowId, runIds })); } catch (error) { sendError(res, error); }
  });
  router.post('/runs/:runId/complete', orchestrationGuard, (req, res) => {
    try { res.json(dispatcher.complete(req.params.runId)); } catch (error) { sendError(res, error); }
  });
  router.post('/runs/:runId/focus', (req, res) => {
    const run = dispatcher.get(req.params.runId);
    if (!run) return res.status(404).json({ ok: false, code: 'RUN_NOT_FOUND', error: `Unknown run ${req.params.runId}` });
    const focus = req.body?.focus !== false;
    broadcastSync({ type: 'assistant:focus', runId: run.runId, provider: run.provider, providerSessionId: run.providerSessionId, providerThreadId: run.providerThreadId, assistantSessionId: run.assistantSessionId, focus });
    res.json({ ok: true, focused: true, runId: run.runId, provider: run.provider });
  });

  // ── assistant sessions ─────────────────────────────────────────────────────
  function requireRuntime(res) {
    if (!runtime) { res.status(503).json({ ok: false, code: 'RUNTIME_UNAVAILABLE', error: 'Assistant runtime is not available' }); return false; }
    return true;
  }
  router.get('/sessions', (req, res) => {
    if (!requireRuntime(res)) return;
    res.json({ ok: true, sessions: runtime.listSessions() });
  });
  router.post('/sessions', async (req, res) => {
    if (!requireRuntime(res)) return;
    try {
      const session = await runtime.createSession(req.body || {});
      res.status(201).json({ ok: true, session });
    } catch (error) { sendError(res, error); }
  });
  router.get('/sessions/:id/usage', (req, res) => {
    if (!requireRuntime(res)) return;
    const id = req.params.id;
    if (!runtime.getSession(id, { transcript: false })) return res.status(404).json({ ok: false, code: 'SESSION_NOT_FOUND', error: `Unknown assistant session ${id}` });
    try {
      const task = typeof req.query.task === 'string' && req.query.task ? req.query.task : 'current';
      // The headline is the same everywhere (the gauge's packet, this endpoint, agent_usage): the
      // session block, every task of the session added up from the ledger file.
      // No ledger wired: an explicit null, so a caller can tell "no metering" from a dropped body.
      if (task === 'all') {
        // With `run`: that run's tokens over every task it worked in, in the same answer.
        const run = typeof req.query.run === 'string' && req.query.run ? req.query.run : null;
        const session = usage?.sessionView(id) ?? null;
        // Whether work is in progress is the runtime's to say (a turn that has no tokens yet).
        const head = session ? runtime.usageView?.(id, 'current')?.session || null : null;
        return res.json({ ok: true, session: session && head ? { ...session, live: head.live, fidelity: head.fidelity } : session, ...(run ? { run: usage?.runView?.(id, run) ?? null } : {}) });
      }
      res.json({ ok: true, usage: runtime.usageView?.(id, task) ?? usage?.taskView(id, task) ?? null });
    } catch (error) { sendError(res, error); }
  });
  router.get('/sessions/:id', (req, res) => {
    if (!requireRuntime(res)) return;
    const session = runtime.getSession(req.params.id, { transcript: req.query.transcript !== '0', limit: clampInt(req.query.limit, 1, 2000, 400) });
    if (!session) return res.status(404).json({ ok: false, code: 'SESSION_NOT_FOUND', error: `Unknown assistant session ${req.params.id}` });
    res.json({ ok: true, session });
  });
  router.patch('/sessions/:id', async (req, res) => {
    if (!requireRuntime(res)) return;
    // The computer toggle belongs to the user, never to an agent.
    if (req.body && 'computerUse' in req.body && (req.get('x-synabun-terminal') || req.get('x-synabun-desktop-grant'))) {
      return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Only the user can switch computer use on or off.' });
    }
    try {
      const session = await runtime.updateSession(req.params.id, req.body || {});
      if (!session) return res.status(404).json({ ok: false, code: 'SESSION_NOT_FOUND', error: `Unknown assistant session ${req.params.id}` });
      res.json({ ok: true, session });
    } catch (error) { sendError(res, error); }
  });
  router.post('/sessions/:id/close', async (req, res) => {
    if (!requireRuntime(res)) return;
    try { res.json({ ok: true, session: await runtime.closeSession(req.params.id) }); } catch (error) { sendError(res, error); }
  });
  router.delete('/sessions/:id', async (req, res) => {
    if (!requireRuntime(res)) return;
    try { res.json({ ok: true, removed: await runtime.destroySession(req.params.id) }); } catch (error) { sendError(res, error); }
  });

  // ── attachments ────────────────────────────────────────────────────────────
  // The paperclip's files that do not go inline: the raw body streams to disk
  // (assistant-attachments.js) and the brain gets the absolute path. Guests are
  // refused above; the octet-stream type and the X-Synabun-Filename header make
  // a cross-site post a preflighted request, which this server never allows.
  router.post('/attachments', async (req, res) => {
    if (!attachments) return res.status(503).json({ ok: false, code: 'ATTACHMENTS_UNAVAILABLE', error: 'Attachments are not available on this server' });
    const rawName = req.get('x-synabun-filename');
    let name = null;
    try { name = rawName ? decodeURIComponent(rawName) : null; } catch { name = null; }
    if (!req.is('application/octet-stream') || !name) {
      return res.status(400).json({ ok: false, code: 'ATTACHMENT_BAD_REQUEST', error: 'Send the file as application/octet-stream with an X-Synabun-Filename header' });
    }
    const declared = Number(req.get('content-length'));
    if (Number.isFinite(declared) && declared > attachments.maxBytes) {
      res.set('Connection', 'close');
      return res.status(413).json({ ok: false, code: 'ATTACHMENT_TOO_LARGE', error: tooLargeMessage(attachments.maxBytes), limit: attachments.maxBytes });
    }
    try {
      const attachment = await attachments.save(req, { name, sessionId: req.query.assistantSessionId || null, mime: req.get('x-synabun-mime') || '' });
      log('attachment', `${attachment.name} (${attachment.size} bytes) → ${attachment.path}`);
      res.json({ ok: true, attachment });
    } catch (error) {
      if (res.headersSent) return;
      if (error?.code === 'ATTACHMENT_TOO_LARGE') res.set('Connection', 'close');
      sendError(res, error);
    }
  });

  // ── accounts ───────────────────────────────────────────────────────────────
  function accountInUse(provider) {
    return (accountId) => {
      if (dispatcher.accountInUse(provider, accountId)) return `Stop the dispatched ${provider} runs using account ${accountId} first`;
      if (runtime?.accountInUse?.(provider, accountId)) return `Close the assistant sessions using account ${accountId} first`;
      return null;
    };
  }
  router.get('/claude/accounts', (req, res) => {
    if (!claudeAccounts) return res.status(503).json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Claude accounts are not available' });
    res.json({ ok: true, accounts: claudeAccounts.listForClient() });
  });
  router.post('/claude/accounts', async (req, res) => {
    if (!claudeAccounts) return res.status(503).json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Claude accounts are not available' });
    try {
      const account = claudeAccounts.create({ label: req.body?.label });
      let login = null;
      if (req.body?.login !== false && typeof createLoginTerminal === 'function') {
        login = await startClaudeLogin(account.id);
      }
      res.status(201).json({ ok: true, account: claudeAccounts.listForClient().find((row) => row.id === account.id) || account, login });
    } catch (error) { sendError(res, error); }
  });
  async function startClaudeLogin(accountId) {
    const command = claudeAccounts.loginCommand(accountId);
    const terminal = await createLoginTerminal({ env: command.env, cwd: command.cwd, profile: 'claude-code', accountId, command: command.command });
    claudeAccounts.watchLogin(accountId, {
      onLogin: (identity) => {
        broadcastSync({ type: 'assistant:accounts-changed', provider: 'claude-code', accountId, email: identity?.email || null });
        catalogCache = null;
      },
    });
    return { mode: 'terminal', terminalSessionId: terminal?.terminalSessionId || terminal?.id || null, profile: terminal?.profile || 'claude-code' };
  }
  router.post('/claude/accounts/:id/login', async (req, res) => {
    if (!claudeAccounts) return res.status(503).json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Claude accounts are not available' });
    if (typeof createLoginTerminal !== 'function') return res.status(501).json({ ok: false, code: 'LOGIN_UNAVAILABLE', error: 'Login terminals are not wired' });
    try {
      if (!claudeAccounts.get(req.params.id)) return res.status(404).json({ ok: false, code: 'ACCOUNT_NOT_FOUND', error: `Unknown Claude account ${req.params.id}` });
      res.json({ ok: true, login: await startClaudeLogin(req.params.id) });
    } catch (error) { sendError(res, error); }
  });
  router.patch('/claude/accounts/:id', (req, res) => {
    if (!claudeAccounts) return res.status(503).json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Claude accounts are not available' });
    try {
      const account = claudeAccounts.rename(req.params.id, req.body?.label);
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'claude-code', accountId: req.params.id });
      res.json({ ok: true, account });
    } catch (error) { sendError(res, error); }
  });
  router.delete('/claude/accounts/:id', (req, res) => {
    if (!claudeAccounts) return res.status(503).json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Claude accounts are not available' });
    try {
      const result = claudeAccounts.remove(req.params.id, { inUse: accountInUse('claude-code') });
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'claude-code', accountId: req.params.id, removed: true });
      res.json({ ok: true, ...result });
    } catch (error) { sendError(res, error); }
  });
  router.get('/codex/accounts', (req, res) => {
    if (!codexAccounts) return res.status(503).json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Codex accounts are not available' });
    res.json({ ok: true, accounts: codexAccounts.listForClient() });
  });
  router.post('/codex/accounts/add-start', async (req, res) => {
    if (!codexAccounts?.addStart) return res.status(501).json({ ok: false, code: 'NOT_IMPLEMENTED', error: 'Add a Codex account from the Codex sidepanel account menu' });
    try {
      const result = await codexAccounts.addStart(req.body || {});
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'codex', accountId: result?.accountId || null });
      res.status(201).json({ ok: true, ...result });
    } catch (error) { sendError(res, error); }
  });
  router.patch('/codex/accounts/:id', (req, res) => {
    if (!codexAccounts?.rename) return res.status(503).json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Codex accounts are not available' });
    try {
      const account = codexAccounts.rename(req.params.id, req.body?.label);
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'codex', accountId: req.params.id });
      res.json({ ok: true, account });
    } catch (error) { sendError(res, error); }
  });
  router.delete('/codex/accounts/:id', (req, res) => {
    if (!codexAccounts?.remove) return res.status(503).json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Codex accounts are not available' });
    try {
      const result = codexAccounts.remove(req.params.id, { inUse: accountInUse('codex') });
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'codex', accountId: req.params.id, removed: true });
      res.json({ ok: true, ...result });
    } catch (error) { sendError(res, error); }
  });

  // ── sidepanel tab registry (UI heartbeat) ──────────────────────────────────
  function listTabs() {
    const cutoff = now() - tabTtlMs;
    const out = [];
    for (const [windowId, row] of uiTabs) {
      if (row.at < cutoff) { uiTabs.delete(windowId); continue; }
      out.push({ windowId, at: new Date(row.at).toISOString(), panels: row.panels });
    }
    return out;
  }
  router.post('/ui/tabs', (req, res) => {
    const windowId = String(req.body?.windowId || '').trim().slice(0, 128);
    if (!windowId) return res.status(400).json({ ok: false, code: 'WINDOW_ID_REQUIRED', error: 'windowId is required' });
    const panels = req.body?.panels && typeof req.body.panels === 'object' ? req.body.panels : {};
    uiTabs.set(windowId, { panels, at: now() });
    if (uiTabs.size > 50) uiTabs.delete(uiTabs.keys().next().value);
    res.json({ ok: true, windows: uiTabs.size });
  });
  router.get('/ui/tabs', (req, res) => res.json({ ok: true, windows: listTabs() }));
  router.post('/ui/focus', (req, res) => {
    const body = req.body || {};
    broadcastSync({ type: 'assistant:focus', provider: body.provider || null, tabId: body.tabId || null, providerSessionId: body.sessionId || body.providerSessionId || null, runId: body.runId || null, focus: body.focus !== false });
    res.json({ ok: true });
  });

  router.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    log('assistant-api', error?.message || String(error));
    sendError(res, error);
  });

  return router;
}
