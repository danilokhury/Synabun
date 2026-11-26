// ═══════════════════════════════════════════
// SynaBun — Assistant REST API (/api/assistant/*)
// ═══════════════════════════════════════════
//
// One router for everything the assistant UI and the MCP `agents` tool group
// need: catalog, dispatch + run control, waits, transcripts, assistant sessions,
// composer attachments, Claude/Codex account management, and the sidepanel tab registry.
// Mounted from server.js with `app.use('/api/assistant', createAssistantApi(deps))`.

import { assistantStopProvenance, pageStopProvenance, personAskedToStop } from './worker-stop.js';
import { dispatchInput } from './assistant-tools.js';
import { expandAgentProposals, getAgentResolver } from './agents/resolve.js'; // agents-p1
import { Router } from 'express';
import { DispatchError } from './assistant-dispatch.js';
import { openServable } from './assistant-media.js';
import { designFit, targetMakes } from './assistant-router.js';
import { normalizeEffort } from './effort-levels.js';
import { BUDGET_DEFAULT_USD, BUDGET_MAX_USD, BUDGET_MIN_USD, BUDGET_WARN_RATIO } from './assistant-budget.js';
import { tooLargeMessage } from './assistant-attachments.js';
import { getSessionPolicy, requiresHumanApproval } from './remote-policy.js';
import { clampPlanDispatch, PLAN_DISPATCH_NOTE, runCanChangeCode } from './assistant-plan-permissions.js';
import { noStore, requireJson, requireLocal, requireLocalHost, sendGuardError } from './http-guards.js';
import { setUntrustedFileHeaders } from './untrusted-file-headers.js';
import { PEER_VERDICT, peerAuthority } from './peer-identity.js';
import { sendPeerUnavailable } from './owner-authority.js';
import { registerAssistantTeamRoutes } from './teams/api.js'; // agents-p4
import { sharedTeamScheduler } from './teams/scheduler.js'; // agents-p4

/** The header whatsapp_send_file's caller proves it is the WhatsApp conversation's own brain with (assistant-runtime.js BRAIN_CREDENTIAL_RE). */
export const BRAIN_CREDENTIAL_HEADER = 'x-synabun-brain-token';
const SEND_FILE_FIELDS = Object.freeze(['path', 'caption', 'as']);

/**
 * How far each provider's spend can be held to the budget (the Budget modal shows it). Spend is
 * checked where the provider lets it be checked; between two checks a run can go past its share by
 * that much.
 */
export const BUDGET_ENFORCEMENT = Object.freeze({
  'claude-code': { metered: 'reported', share: 'Checked between model calls (each call at list price while the turn runs, the reported cost at its end), so one call can pass the share. The Claude CLI also stops a run at its ceiling, or at what the session had left when it started.', session: 'At the budget every run stops.' },
  opencode: { metered: 'reported', share: 'OpenCode reports each step\'s cost; the share is checked at every step, so one step can pass it.', session: 'At the budget every run stops.' },
  codex: { metered: 'estimated', share: 'Codex reports tokens: priced at list price (an API-price estimate; ChatGPT-plan accounts are billed by plan quota) as its rollout records them, so one record or turn can pass the share. A failed turn is priced from its rollout.', session: 'At the budget every run stops.' },
  antigravity: { metered: 'unpriced', share: 'Antigravity reports tokens, not prices (it is billed by its Google sign-in), so no budget can hold its spend: with a budget it takes no share and its runs are refused. Under No limit it runs and its tokens are counted.', session: 'With a budget no Antigravity run starts; one already running stops after its turn.' },
  brain: { metered: 'reported', share: 'Your Assistant\'s own turns draw from its provider\'s share, which keeps a reserve for them; checked before every brain turn. A Claude brain\'s CLI also stops at what that share had left when it started. A brain model with no price is refused.', session: 'At the budget the brain takes no turn until the budget is raised.' },
});

const OWNER_ONLY = { error: 'The assistant is available to the owner only', code: 'GUEST_FORBIDDEN' };
// What GET /catalog is made from when no catalog builder is wired: one object, so its answer is reused like any build's.
const NO_CATALOG = Object.freeze({});

function sendError(res, error, fallbackStatus = 500) {
  if (error instanceof DispatchError || (error && error.code && error.status)) {
    const status = Number(error.status) || fallbackStatus;
    const body = typeof error.toJSON === 'function' ? error.toJSON() : { code: error.code, message: error.message, ...(error.problems ? { problems: error.problems } : {}) };
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
 * @param {object} [deps.codexAccounts]  createCodexAccounts() (lib/codex-accounts.js)
 * @param {Function} [deps.buildCatalog] async () => catalog object (models/accounts/projects/tools)
 * @param {Function} [deps.createLoginTerminal] async ({ env, cwd, profile, accountId }) => { terminalSessionId, profile }
 * @param {Function} [deps.claudeSignIn]  async (accountId) => { sessionId, status, error } — Claude Code's own
 *   `auth login` in a SynaBun terminal under the account's config directory (lib/provider-panel-terminal-auth.js)
 * @param {Function} [deps.claudeSetMode] async (accountId, mode) => row — what the account's sessions use
 * @param {Function} [deps.claudeAccountInUse] (accountId) => '' | why it cannot be removed now
 * @param {Function} [deps.codexSignIn]   async (accountId) => { sessionId, status, error } — `codex login` in a SynaBun
 *   terminal under the account's CODEX_HOME (lib/provider-panel-terminal-auth.js)
 * @param {Function} [deps.codexSetMode]  async (accountId, mode) => row — what the account's sessions use
 * @param {Function} [deps.codexAccountInUse] (accountId) => '' | why it cannot be removed now
 * @param {object} [deps.attachments]    createAttachmentStore() (POST /attachments)
 */
export function createAssistantApi({
  dispatcher,
  runtime = null,
  usage = null,
  claudeAccounts = null,
  codexAccounts = null,
  accountUsage = null,
  buildCatalog = null,
  createLoginTerminal = null,
  claudeSignIn = null,
  claudeSetMode = null,
  claudeAccountInUse = null,
  codexSignIn = null,
  codexSetMode = null,
  codexAccountInUse = null,
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
  // The user-context engine (assistant-user-context.js) and the project a new conversation starts in.
  userContext = null,
  // Why the engine did not start on this server (a string or null), for the settings page.
  userContextError = () => null,
  defaultProject = () => 'global',
  // whatsapp_send_file: the WhatsApp service ({ sendFile }) or a function returning it (it is built
  // after this router), and the port the server listens on (the Host check of that route).
  whatsapp = null,
  port = 3344,
  // agents-p4: the team scheduler (lib/teams/scheduler.js), or what returns it. Default: the one server.js shares
  // (shareTeamScheduler); none: the team routes answer 503.
  teamScheduler = sharedTeamScheduler,
  // The Admin sandbox setting (lib/agent-sandbox-setting.js): one global value for every agent SynaBun starts.
  adminSandbox = null,
  // Protect workers (lib/worker-guard-setting.js): what capability read-only / workspace means for every worker.
  workerGuard = null,
  // Let the automation browser act as owner (lib/automation-browser-owner-access.js): the owner's page only.
  automationBrowserOwnerAccess = null,
  // The page secret (lib/page-session.js): a request without an agent pin is the owner's page only when it carries
  // this boot's cookie; a local process that merely sends no headers is nobody (never 'ui').
  pageSession = null,
  // The Background tasks view of a Claude brain: lib/claude-bg-tasks.js over the brain's own transcript
  // ({ list(identity), output(identity, q) } built in server.js). None: those routes answer 404.
  backgroundTasks = null,
  // Whether a pin counts (lib/terminal-tokens.js verdict, server.js): (pin, req) → { accepted, code, error, httpStatus }.
  // A pin SynaBun gave a proof to (a run's terminal token, a brain's launch credential) counts only with it: a request
  // that names a worker's run, or a brain's id, without it is refused (403 TERMINAL_TOKEN_REQUIRED / _INVALID) instead
  // of reading that run as its own worker. Without it (a test, an older host) every pin is taken as it is said.
  terminalVerdict = null,
  // agents-p1: the agent resolver (lib/agents/resolve.js), or what returns it. Default: the one of the process.
  agents = getAgentResolver,
} = {}) {
  if (!dispatcher) throw new Error('createAssistantApi requires a dispatcher');
  const router = Router();
  const uiTabs = new Map(); // windowId → { panels, at }
  let catalogCache = null;

  router.use((req, res, next) => {
    if (isGuestRequest(req)) return res.status(403).json(OWNER_ONLY);
    next();
  });

  // agents-p1: the agents the owner approved, as agent_catalog lists them (what a dispatch names with agent_ref):
  // every one, or the ones on `provider` / whose id, name or description holds `q`. [] on a server without agents.
  function runnableAgents({ provider = null, q = null } = {}) {
    let rows = [];
    try { rows = (typeof agents === 'function' ? agents() : agents)?.runnable?.() || []; } catch { rows = []; }
    const needle = q ? String(q).trim().toLowerCase() : '';
    return rows.filter((row) => (!provider || row.provider === provider)
      && (!needle || [row.id, row.name, row.description].some((value) => String(value || '').toLowerCase().includes(needle))));
  }

  // Resolve who is calling: the UI (the page secret cookie, no pin), a dispatched worker (run id pin →
  // forbidden for orchestration), or nobody known. A brain is NOT decided here: a pin only records which
  // session a request *claims* to be (for attribution), never that the request is that session's brain.
  // Brain authority is the per-launch credential alone (brainCaller) — the final pre-restart review
  // (run f283e53b) showed a forged `X-Synabun-Terminal: assistant-*`, and equally a real but non-secret
  // session id (a worker's environment and its task text both carry one), would otherwise pass as the brain.
  function callerContext(req) {
    const pin = String(req.get('x-synabun-terminal') || req.get('x-synabun-assistant') || '').trim();
    const bodySession = req.body?.assistantSessionId || req.body?.assistant_session_id || req.query?.assistantSessionId || null;
    if (!pin) {
      // The page: this boot's page secret cookie (the browser sends it by itself). Without a page session wired
      // (a test, an older host) every pinless request is the page, as before. A request whose peer could not be
      // identified (macOS, the lookup failed) never verifies: it is nobody here, and its refusals say 503
      // PEER_UNAVAILABLE (uiOnly, refuseRunRead) rather than a 403 the page could not cure.
      if (pageSession && typeof pageSession.verify === 'function' && !pageSession.verify(req)) return { kind: 'unknown', assistantSessionId: bodySession ? String(bodySession) : null, pin: '', pageless: true };
      return { kind: 'ui', verifiedPage: typeof pageSession?.verify === 'function', assistantSessionId: bodySession ? String(bodySession) : null };
    }
    // The pin counts only with its proof: a forged one names nobody here, not even for attribution.
    let verdict = null;
    try { verdict = typeof terminalVerdict === 'function' ? terminalVerdict(pin, req) : null; } catch { verdict = { accepted: false, code: 'TERMINAL_TOKEN_INVALID', error: 'The run this request names could not be checked.', httpStatus: 403 }; }
    if (verdict && verdict.accepted === false) {
      return { kind: 'refused', forbidden: true, pin, refusal: { status: Number(verdict.httpStatus) || 403, code: String(verdict.code || 'TERMINAL_TOKEN_INVALID'), error: String(verdict.error || 'This request names a run it cannot prove it is.') } };
    }
    if (dispatcher.get(pin)) return { kind: 'worker', forbidden: true, pin };
    // The session a request claims, for attribution once a credential has proven it a brain: a Claude brain's
    // pin resolves to its session; the OpenCode brain pins assistant-oc-<24> (never taken as an id) and names
    // the session in the body. The claim grants nothing on its own.
    const resolved = runtime?.resolveTerminal?.(pin) || null;
    const claimed = resolved
      || (/^assistant-oc-/.test(pin) ? (bodySession ? String(bodySession) : null)
        : /^assistant-/.test(pin) ? pin
          : (bodySession ? String(bodySession) : null));
    return { kind: 'unknown', assistantSessionId: claimed, pin };
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
    if (caller.refusal) return refusePin(res, caller.refusal);
    if (caller.forbidden) return res.status(403).json({ ok: false, code: 'AGENTS_NOT_PERMITTED', error: 'Dispatched workers cannot orchestrate other agents.' });
    // The user's own page (this boot's page secret cookie): the only caller that orchestrates without being a brain.
    if (caller.kind === 'ui') { req.assistantCaller = caller; return next(); }
    // The only other caller allowed is an Assistant brain, and only its per-launch credential proves it (brainCaller):
    // never a pin, never a session id, which a worker's environment and its task text both carry. This is the forged-
    // and known-pin bypass the final pre-restart review found (run f283e53b, assistant-api.js:189): an
    // `X-Synabun-Terminal: assistant-*` header, or a real live session id, used to pass here as the brain.
    const brain = brainCaller(req);
    if (brain) { req.assistantCaller = brain; return next(); }
    return uiOnly(req, res, 'Orchestration is the user\'s (from SynaBun\'s own page) and the Assistant\'s brain\'s: this request is neither (no page secret, no brain launch credential a live session knows).');
  }
  /**
   * The caller when it is an assistant brain, else null. The one proof is the per-launch credential
   * (X-Synabun-Brain-Token, SYNABUN_BRAIN_TOKEN in the brain's own environment only, minted per brain launch and
   * resolved by runtime.sessionForBrainCredential over the live brains): a pin or a session id names nobody here,
   * because any local process can send a header and a session id is not secret (a worker carries its own, and ids
   * appear in task text). The credential's session is authoritative, whatever pin or body the request carries. The
   * UI, workers and other sessions never count.
   */
  function brainCaller(req) {
    if (req.assistantCaller?.credentialed) return req.assistantCaller;
    if (String(req.get('x-synabun-role') || '').trim().toLowerCase() !== 'assistant') return null;
    let session = null;
    try { session = runtime?.sessionForBrainCredential?.(req.get('x-synabun-brain-token')) || null; } catch { session = null; }
    if (!session) return null;
    const caller = req.assistantCaller || callerContext(req);
    // A pin the request cannot prove (another brain's, a worker's, an ended one) is refused, credential or not.
    if (caller.refusal) return null;
    return { ...caller, kind: 'assistant', assistantSessionId: String(session), credentialed: true };
  }
  /**
   * Who may READ a run (GET /runs/:id, /result, /transcript): the owner's page (ui), a credential-verified
   * Assistant brain (its session's runs, as today), or the worker of that very run — a worker's pin is its own
   * run id, so it reads only itself, never another run. Everyone else (a pinless local process with no page
   * secret, a worker naming another run) is refused. Listing and deletion are owner-or-brain only (never a worker):
   * the list is not "its own run", and a finished run is cleared by the owner or the brain that owns its session.
   */
  function runReadAllowed(req, runId) {
    const caller = callerContext(req);
    if (caller.kind === 'ui') return true;
    const brain = brainCaller(req);
    if (brain) {
      // A brain reads only its OWN session's runs (like DELETE): another session's run is not readable through the
      // credential. A run with no session, or a sessionless brain, falls through as before (nothing to scope to).
      const runSession = dispatcher.get(runId)?.assistantSessionId || null;
      if (runSession && brain.assistantSessionId && String(runSession) !== String(brain.assistantSessionId)) return false;
      return true;
    }
    if (caller.kind === 'worker' && caller.pin && String(caller.pin) === String(runId)) return true;
    return false;
  }
  /**
   * The request's peer could not be identified (lib/peer-identity.js, macOS: the lookup failed), so neither the page
   * secret nor a brain credential could count: the peer verdict's own reading (peerAuthority), or the page session's
   * (a request that carries the secret and was never identified). → { retryable, reason } or null.
   */
  function peerDown(req) {
    const auth = peerAuthority(req?.[PEER_VERDICT]);
    if (auth.decision === 'unavailable') return auth;
    try { return typeof pageSession?.peerUnavailable === 'function' ? (pageSession.peerUnavailable(req) || null) : null; } catch { return null; }
  }
  /** "Only the owner's page": 403 UI_ONLY, or 503 PEER_UNAVAILABLE when the caller could not be identified (a reload,
   *  or the brain's retry, may cure that; a refusal would not). */
  function uiOnly(req, res, error) {
    const down = peerDown(req);
    if (down) return sendPeerUnavailable(res, req, down);
    return res.status(403).json({ ok: false, code: 'UI_ONLY', error });
  }
  function refuseRunRead(req, res) {
    const down = peerDown(req);
    if (down) return sendPeerUnavailable(res, req, down);
    const refused = callerContext(req).refusal;
    if (refused) return refusePin(res, refused);
    return res.status(403).json({ ok: false, code: 'RUN_FORBIDDEN', error: 'This run is readable by the owner (from SynaBun\'s own page), its own worker and the Assistant brain of its session only.' });
  }
  /** A request that names a run or a brain it cannot prove it is: 403 TERMINAL_TOKEN_REQUIRED / _INVALID (never a token). */
  function refusePin(res, refusal) {
    return res.status(refusal.status || 403).json({ ok: false, code: refusal.code, error: refusal.error });
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
  /**
   * A brain read these events with agent_wait until:"event" (Agents P2): once the response is out they are settled
   * in its mailbox by their ids, so they do not come back as a mailbox turn. Asking again with the same after_seq
   * still returns them (the wait reads the log), which is how a lost answer is recovered.
   */
  function noteBrainEvents(req, res, events) {
    if (typeof dispatcher.markEventsDelivered !== 'function' || !Array.isArray(events) || !events.length) return;
    const caller = brainCaller(req);
    if (!caller?.assistantSessionId) return;
    const ids = events.map((event) => event?.id).filter(Boolean);
    if (!ids.length) return;
    res.on('finish', () => { try { dispatcher.markEventsDelivered(caller.assistantSessionId, ids); } catch {} });
  }
  /** agent_wait's `kinds`: a list, or one comma-separated value (a query string). → string[] | null */
  function waitKinds(value) {
    if (value === undefined || value === null || value === '') return null;
    const list = (Array.isArray(value) ? value : String(value).split(',')).map((kind) => String(kind).trim()).filter(Boolean);
    return list.length ? list : null;
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
      // Quotas are shown as last read and read again in the background (the probe can take seconds; the
      // dispatcher and the router read them fresh before they choose an account).
      accountUsage?.refresh()?.catch?.(() => {});
      const usage = () => accountUsage?.list({ stale: true });
      // refresh=1 rebuilds from the providers' endpoints; deep=1 also makes them ask the CLI / app-server again.
      const deep = req.query.deep === '1';
      const force = req.query.refresh === '1' || deep;
      // Brain view / search: compact rows (OpenCode can list hundreds of models).
      const view = req.query.view === 'brain' ? 'brain' : req.query.view === 'manage' ? 'manage' : 'full';
      const provider = req.query.provider ? String(req.query.provider) : null;
      const q = req.query.q || req.query.search ? String(req.query.q || req.query.search) : null;
      // The Models manager: every row with hidden: true|false.
      if (view === 'manage' && catalog?.get) return res.json({ ok: true, ...(await catalog.get({ force, deep, view: 'manage', provider })) });
      if (catalog?.get && (view === 'brain' || provider || q)) {
        let preferences = {};
        try { preferences = configStore?.routing?.().preferences || {}; } catch {}
        const brief = await catalog.get({ force, deep, view: 'brain', provider, q, preferences });
        // Accounts are read live (the catalog build can be seconds old): every Claude and Codex account with
        // its mode, whether it is signed in and its identity, and the account a worker gets when a dispatch
        // names none.
        const accounts = {
          ...(brief.accounts || {}),
          ...(claudeAccounts ? { 'claude-code': usage()?.['claude-code'] || claudeAccounts.listForClient() } : {}),
          ...(codexAccounts ? { codex: usage()?.codex || codexAccounts.listForClient() } : {}),
        };
        return res.json({ ok: true, generatedAt: new Date(now()).toISOString(), ...brief, accounts, claudeWorkerAccount: claudeWorkerAccountId(), codexWorkerAccount: codexWorkerAccountId(), limits: dispatcher.limits, runs: dispatcher.list({ activeOnly: true }), totals: dispatcher.totals(), agents: runnableAgents({ provider, q }) });
      }
      // The catalog says how long one of its builds is good for (one without a verified list is redone
      // within seconds), so it is asked every time: this answer is reused only while it hands back the
      // build the answer was made from (a rebuild or invalidate() gives another one).
      const base = typeof buildCatalog === 'function' ? await buildCatalog({ force, deep }) : NO_CATALOG;
      if (!force && catalogCache && catalogCache.base === base && now() - catalogCache.at < 30_000) return res.json(accountUsage ? { ...catalogCache.value, accounts: { ...catalogCache.value.accounts, ...usage() } } : catalogCache.value);
      // Hidden rows stay server-side (view=manage lists them); the lists themselves ship.
      const { hiddenRows: _hiddenRows, ...visible } = base || {};
      const value = {
        ok: true,
        generatedAt: new Date(now()).toISOString(),
        ...visible,
        accounts: {
          ...(base.accounts || {}),
          'claude-code': usage()?.['claude-code'] || (claudeAccounts ? claudeAccounts.listForClient() : (base.accounts?.['claude-code'] || [])),
          codex: usage()?.codex || (codexAccounts ? codexAccounts.listForClient() : (base.accounts?.codex || [])),
        },
        claudeWorkerAccount: claudeWorkerAccountId(),
        codexWorkerAccount: codexWorkerAccountId(),
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
        ...dispatchInput(body),
        accountId: body.accountId || body.account_id || body.codexAccountId || body.claudeAccountId || null,
        permissionPolicy: body.permissionPolicy || body.permission_policy,
        maxMinutes: body.maxMinutes ?? body.max_minutes,
        budgetUsd: body.budgetUsd ?? body.budget_usd,
        usesBrowser: body.usesBrowser ?? body.uses_browser,
        // The MoreLogin profile of the worker's browser tab (an id or a name); none = the default browser.
        moreloginProfile: body.moreloginProfile ?? body.morelogin_profile ?? null,
        workflowId: body.workflowId || body.workflow_id,
        workerIndex: body.workerIndex ?? body.worker_index,
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
    if (callerContext(req).kind !== 'ui') return uiOnly(req, res, 'Routing settings are changed from the assistant panel only.');
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
    if (callerContext(req).kind !== 'ui') return uiOnly(req, res, 'Routing settings are changed from the assistant panel only.');
    try {
      configStore.patchRouting({ preferences: { [req.params.key]: null } }, { taskClasses: [...Object.keys(taskClasses || {}), 'vision'] });
      broadcastSync({ type: 'assistant:routing-changed', version: configStore.version() });
      res.json(routingPayload());
    } catch (error) { sendError(res, error, 400); }
  });
  // ── budget ─────────────────────────────────────────────────────────────────
  /** A session's budget view (dispatcher → budget planner): the setting, spend, and the live split. */
  function sessionBudgetView(sessionId) {
    if (!sessionId) return null;
    try { return dispatcher.sessionBudget?.(String(sessionId)) || null; } catch { return null; }
  }
  function budgetPayload(sessionId = null) {
    const current = configStore.budget();
    let pricingStatus = null;
    try { pricingStatus = pricing?.status?.() || null; } catch { pricingStatus = null; }
    return {
      ok: true, version: current.version,
      budget: { unlimited: current.unlimited === true, amountUsd: current.amountUsd, version: current.version, updatedAt: current.updatedAt || null, source: current.source || 'saved' },
      defaults: { unlimited: false, amountUsd: BUDGET_DEFAULT_USD }, bounds: { minUsd: BUDGET_MIN_USD, maxUsd: BUDGET_MAX_USD }, warnRatio: BUDGET_WARN_RATIO,
      session: sessionBudgetView(sessionId), pricing: pricingStatus, enforcement: BUDGET_ENFORCEMENT,
    };
  }
  // ── User context (Settings → Automation behavior): the three layers and what a new conversation is told ──
  function userContextPayload(req) {
    let fallback = 'global';
    try { fallback = String(defaultProject() || 'global'); } catch { fallback = 'global'; }
    const project = String(req.query?.project || '').trim().slice(0, 200) || fallback;
    return { ok: true, settings: configStore.userContext(), capabilities: userContext.capabilities(), preview: userContext.preview({ project }) };
  }
  const userContextReady = (res) => {
    if (userContext && configStore?.userContext) return true;
    let reason = null;
    try { reason = typeof userContextError === 'function' ? userContextError() : userContextError; } catch { reason = null; }
    res.status(503).json({ ok: false, code: 'USER_CONTEXT_UNAVAILABLE', error: 'User context is not available on this server', reason: reason ? String(reason).slice(0, 300) : null });
    return false;
  };
  router.get('/user-context', (req, res) => {
    if (!userContextReady(res)) return;
    try { res.json(userContextPayload(req)); } catch (error) { sendError(res, error); }
  });
  router.put('/user-context', (req, res) => {
    if (!userContextReady(res)) return;
    if (!configStore.patchUserContext) return res.status(503).json({ ok: false, code: 'CONFIG_UNAVAILABLE', error: 'User context settings are read-only' });
    if (callerContext(req).kind !== 'ui') return uiOnly(req, res, 'User context settings are changed from Settings only.');
    try {
      const body = req.body || {};
      const { project: _project, ...patch } = body.settings && typeof body.settings === 'object' ? body.settings : body;
      configStore.patchUserContext(patch);
      // Read live by the engine: the next turn (and the next brain start) follows it.
      broadcastSync({ type: 'assistant:user-context-changed', settings: configStore.userContext() });
      res.json(userContextPayload(req));
    } catch (error) {
      if (error?.code === 'USER_CONTEXT_INVALID') return res.status(400).json({ ok: false, code: error.code, error: error.message, message: error.message, field: error.field || null });
      sendError(res, error, 400);
    }
  });

  router.get('/budget', (req, res) => {
    if (!configStore?.budget) return res.status(503).json({ ok: false, code: 'CONFIG_UNAVAILABLE', error: 'Budget settings are not available' });
    try { res.json(budgetPayload(req.query.sessionId || null)); } catch (error) { sendError(res, error); }
  });
  router.put('/budget', (req, res) => {
    if (!configStore?.patchBudget) return res.status(503).json({ ok: false, code: 'CONFIG_UNAVAILABLE', error: 'Budget settings are read-only' });
    if (callerContext(req).kind !== 'ui') return uiOnly(req, res, 'Budget settings are changed from the assistant panel only.');
    try {
      const body = req.body || {};
      const patch = body.budget && typeof body.budget === 'object' && !Array.isArray(body.budget) ? body.budget : null;
      if (!patch) return res.status(400).json({ ok: false, code: 'BUDGET_INVALID', error: 'Send { budget: { unlimited?, amountUsd? }, version }', message: 'Send { budget: { unlimited?, amountUsd? }, version }', field: 'budget', version: null });
      const expectedVersion = body.version ?? null;
      const saved = configStore.patchBudget(patch, { expectedVersion });
      // Applies now: the planner divides every open session's budget again, the runtime re-checks
      // every session (held mailboxes, the brain's next turn) and every panel hears it.
      try { dispatcher.refreshLimits?.(); } catch {}
      if (runtime?.onBudgetChanged) { try { runtime.onBudgetChanged(); } catch {} }
      else { try { dispatcher.budget?.onBudgetChanged?.(); } catch {} }
      broadcastSync({ type: 'assistant:budget-changed', version: saved.version, budget: { unlimited: saved.unlimited, amountUsd: saved.amountUsd, version: saved.version, updatedAt: saved.updatedAt || null } });
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
  // ── whatsapp_send_file (docs/whatsapp.md → Sending files) ──────────────────
  // A local file to the owner, for the WhatsApp conversation whose brain is calling. Who calls is the
  // credential that brain alone holds (X-Synabun-Brain-Token: assistant-runtime.js mintBrainCredential),
  // resolved to its session in constant time; never X-Synabun-Role or X-Synabun-Terminal, which any
  // local process can send. A loopback socket and a localhost Host only (the checks of /api/whatsapp);
  // guests were refused above. Only { path, caption?, as? }. Exactly one send, never retried.
  const portOf = () => (typeof port === 'function' ? port() : port);
  let hostGuard = null;
  const localHostOnly = (req, res, next) => {
    const current = portOf();
    if (!hostGuard || hostGuard.port !== current) {
      try { hostGuard = { port: current, check: requireLocalHost(current) }; } catch { return sendGuardError(res, 500, 'BAD_PORT', 'The file route has no valid port.'); }
    }
    return hostGuard.check(req, res, next);
  };
  router.post('/whatsapp/send-file', noStore, requireLocal, localHostOnly, requireJson, async (req, res) => {
    let sessionId = null;
    try { sessionId = runtime?.sessionForBrainCredential?.(req.get(BRAIN_CREDENTIAL_HEADER)) || null; } catch { sessionId = null; }
    if (!sessionId) return sendGuardError(res, 403, 'BRAIN_CREDENTIAL_REQUIRED', 'Only the WhatsApp conversation\'s own Assistant sends files to the phone: nothing was sent.');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendGuardError(res, 400, 'BAD_REQUEST', 'Send { path, caption?, as? }.');
    const extra = Object.keys(body).find((key) => !SEND_FILE_FIELDS.includes(key));
    if (extra !== undefined) return sendGuardError(res, 400, 'BAD_REQUEST', `Unknown field "${extra.slice(0, 40)}": a file send takes path, caption and as only.`, extra.slice(0, 40));
    let service = null;
    try { service = typeof whatsapp === 'function' ? whatsapp() : whatsapp; } catch { service = null; }
    if (typeof service?.sendFile !== 'function') return sendGuardError(res, 503, 'WHATSAPP_UNAVAILABLE', 'WhatsApp is not available on this computer: nothing was sent.');
    try {
      res.json(await service.sendFile(sessionId, body));
    } catch (error) {
      const status = Number(error?.status) || 500;
      const out = { ok: false, code: error?.code || 'INTERNAL', error: error?.message || String(error) };
      if (error?.field) out.field = error.field;
      if (error?.uncertain === true) out.uncertain = true;
      if (Number.isFinite(error?.retryAfterMs)) out.retryAfterMs = Math.max(0, Math.round(error.retryAfterMs));
      if (status >= 500) log('assistant:whatsapp-send-file', `${sessionId}: ${out.code}${out.uncertain ? ' (delivery unknown)' : ''}`);
      res.status(status).json(out);
    }
  });

  // agent_route: the brain proposes; the router approves, asks, or says pending.
  router.post('/route', orchestrationGuard, async (req, res) => {
    if (!requireRouter(res)) return;
    try {
      // agents-p1: a proposal that names an agent (agent_ref) gets the provider, model, effort and account the agent
      // runs on, where it names none itself (lib/agents/resolve.js); a body without one is passed on as it is.
      const body = expandAgentProposals(agents, req.body || {});
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
    if (callerContext(req).kind !== 'ui') return uiOnly(req, res, 'Clarify cards are answered by the user.');
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
    if (callerContext(req).kind !== 'ui') return uiOnly(req, res, 'Route cards are answered by the user.');
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
    // Listing is owner-or-brain only: a worker reads its own run by id, never the roster of every run.
    const caller = callerContext(req);
    const brain = brainCaller(req);
    if (caller.kind !== 'ui' && !brain) return refuseRunRead(req, res);
    try {
      const active = req.query.active === '1' || req.query.activeOnly === '1';
      // A brain sees only its OWN session's runs (its session id forced over whatever the query asks); the owner's
      // page may list any session.
      const scopedSession = (brain && caller.kind !== 'ui') ? (brain.assistantSessionId || null) : (req.query.assistantSessionId || null);
      res.json({
        ok: true,
        runs: dispatcher.list({
          activeOnly: active,
          assistantSessionId: scopedSession,
          workflowId: req.query.workflowId || null,
          status: req.query.status || null,
          limit: clampInt(req.query.limit, 1, 500, 100),
        }),
        totals: dispatcher.totals({ assistantSessionId: scopedSession, workflowId: req.query.workflowId || null }),
      });
    } catch (error) { sendError(res, error); }
  });

  router.post('/wait', orchestrationGuard, async (req, res) => {
    try {
      const body = req.body || {};
      const target = { runId: body.runId || body.run_id || null, runIds: body.runIds || body.run_ids || null, workflowId: body.workflowId || body.workflow_id || null };
      const chat = chatWait(req, target);
      const brain = brainCaller(req);
      const result = await dispatcher.wait({
        ...target,
        assistantSessionId: req.assistantCaller.assistantSessionId || null,
        until: body.until || 'idle',
        // 'all' for a state wait (a barrier), 'any' for an event wait (the next event of any of the runs).
        mode: body.mode || null,
        timeoutMs: chat ? CHAT_WAIT_MS : (body.timeoutMs ?? (body.timeout_seconds ? Number(body.timeout_seconds) * 1000 : 30_000)),
        // Agents P2 (until "event"): the cursor of an earlier answer, the kinds wanted, and, for a brain that passes
        // no cursor, what it has not been told yet.
        afterSeq: body.afterSeq ?? body.after_seq ?? null,
        kinds: waitKinds(body.kinds),
        unseenFor: brain?.assistantSessionId || null,
      });
      if (brain) { noteBrainRead(req, res, result?.done, 'agent_wait'); noteBrainEvents(req, res, result?.events); }
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
      const stopProvenance = { ...assistantStopProvenance(req.assistantCaller, body.action), scope: workflowId ? 'workflow' : assistantSessionId ? 'session' : 'all' };
      // 'user' is recorded only for a control a person operated, whatever the request says.
      const reason = body.reason && (body.reason !== 'user' || personAskedToStop(stopProvenance)) ? body.reason : 'kill_all';
      const result = await dispatcher.killAll({ assistantSessionId, workflowId, reason, stopProvenance });
      // Keep the scope in the operational log as well as provenance on each stopped run.
      const caller = req.assistantCaller.kind === 'ui' ? 'the page' : `the brain of ${req.assistantCaller.assistantSessionId || 'an unknown session'}`;
      const scope = [assistantSessionId ? `session ${assistantSessionId}` : null, workflowId ? `workflow ${workflowId}` : null].filter(Boolean).join(', ') || 'every session';
      const stopped = Array.isArray(result?.stopped) ? result.stopped : [];
      log('kill-all', `${new Date(now()).toISOString()} ${caller} stopped ${stopped.length} run(s) of ${scope} (${reason})${stopped.length ? `: ${stopped.join(', ')}` : ''}`);
      res.json(result);
    } catch (error) { sendError(res, error); }
  });

  router.get('/runs/:runId', (req, res) => {
    if (!runReadAllowed(req, req.params.runId)) return refuseRunRead(req, res);
    const run = dispatcher.get(req.params.runId);
    if (!run) return res.status(404).json({ ok: false, code: 'RUN_NOT_FOUND', error: `Unknown run ${req.params.runId}` });
    const brain = brainCaller(req);
    if (brain) noteBrainRead(req, res, run, 'agent_status');
    res.json({ ok: true, run: brain ? slimRunView(run) : run });
  });
  router.get('/runs/:runId/result', (req, res) => {
    if (!runReadAllowed(req, req.params.runId)) return refuseRunRead(req, res);
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
    if (!runReadAllowed(req, req.params.runId)) return refuseRunRead(req, res);
    try {
      const format = req.query.format || 'tail';
      const out = dispatcher.transcript(req.params.runId, {
        format,
        tail: clampInt(req.query.tail, 1, 500, 40),
        maxChars: clampInt(req.query.maxChars, 200, 20_000, 4000),
        // Agents P2: where the page starts (omit it for the end of the text, as before).
        offset: req.query.offset === undefined || req.query.offset === '' ? null : clampInt(req.query.offset, 0, 100_000_000, 0),
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
    if (!runReadAllowed(req, req.params.runId)) return refuseRunRead(req, res);
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
    // A run's media is what a worker made: opened by its address it runs nothing, and an SVG is a download.
    setUntrustedFileHeaders(res, file.path, file.mime);
    if (req.method === 'HEAD' || !size) { await handle.close().catch(() => {}); return res.end(); }
    const stream = handle.createReadStream({ start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  router.get('/runs/:runId/wait', orchestrationGuard, async (req, res) => {
    try {
      const chat = chatWait(req, { runId: req.params.runId });
      const brain = brainCaller(req);
      const after = req.query.afterSeq ?? req.query.after_seq;
      const result = await dispatcher.wait({
        runId: req.params.runId,
        until: req.query.until || 'idle',
        timeoutMs: chat ? CHAT_WAIT_MS : clampInt(req.query.timeout, 1000, 120_000, 30_000),
        afterSeq: after === undefined || after === '' ? null : Number(after),
        kinds: waitKinds(req.query.kinds),
        unseenFor: brain?.assistantSessionId || null,
      });
      if (brain) { noteBrainRead(req, res, result?.done, 'agent_wait'); noteBrainEvents(req, res, result?.events); }
      res.json(brain ? brainWaitView(chat ? chatWaitView(result) : result) : result);
    } catch (error) { sendError(res, error); }
  });
  router.post('/runs/:runId/send', orchestrationGuard, async (req, res) => {
    try {
      const body = req.body || {};
      const assistantSessionId = req.assistantCaller.assistantSessionId || dispatcher.get(req.params.runId)?.assistantSessionId || null;
      if (planRefusal(req, res, assistantSessionId, 'send a worker a message')) return;
      if (planState(req, assistantSessionId) === 'plan' && planSendRefusal(res, dispatcher.get(req.params.runId))) return;
      const origin = body.origin === 'user' ? 'user' : (req.assistantCaller.kind === 'ui' ? (body.origin || 'assistant') : 'assistant');
      // A run whose provider share is used up: the session's unspent budget is divided again first, then
      // sendTurn decides (it refuses with BUDGET_SHARE_EXHAUSTED when no money could move).
      try { await dispatcher.coverFollowUp?.(req.params.runId); } catch { /* sendTurn decides on the shares as they are */ }
      res.json(await dispatcher.sendTurn(req.params.runId, body.text ?? body.message, { origin, queue: body.queue !== false }));
    } catch (error) { sendError(res, error); }
  });
  // Steer: the user changed work in flight. With runId, that run's current turn is interrupted and the steer follows
  // (dispatcher.steerRun; the run must be this session's); without, the session's own brain is steered (the page only:
  // a brain never steers itself). → { ok, target: { kind, runId? }, interruptedTurn }.
  router.post('/steer', orchestrationGuard, async (req, res) => {
    try {
      const body = req.body || {};
      const caller = req.assistantCaller;
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return res.status(400).json({ ok: false, code: 'MESSAGE_REQUIRED', error: 'text is required' });
      const runId = typeof (body.runId ?? body.run_id) === 'string' ? String(body.runId ?? body.run_id).trim() : '';
      // A brain's session is the one its credential proves, whatever the body says.
      const sessionId = caller.credentialed ? (caller.assistantSessionId || null) : (body.assistantSessionId || body.assistant_session_id || null);
      if (runId) {
        const run = dispatcher.get(runId);
        if (!run) return res.status(404).json({ ok: false, code: 'RUN_NOT_FOUND', error: `Unknown run ${runId}` });
        if (!sessionId && caller.kind !== 'ui') return res.status(404).json({ ok: false, code: 'SESSION_NOT_FOUND', error: 'The caller has no assistant session.' });
        if (sessionId && String(run.assistantSessionId || '') !== String(sessionId)) {
          return res.status(404).json({ ok: false, code: 'RUN_NOT_FOUND', error: `Run ${runId} does not belong to assistant session ${sessionId}` });
        }
        if (planRefusal(req, res, sessionId, 'steer a worker')) return;
        if (planState(req, sessionId) === 'plan' && planSendRefusal(res, run)) return;
        const from = caller.kind === 'ui' ? 'user' : 'assistant';
        try { await dispatcher.coverFollowUp?.(runId); } catch { /* steerRun decides */ }
        const steered = await dispatcher.steerRun(runId, text, { from, assistantSessionId: sessionId });
        return res.json({ ok: true, target: steered.target, interruptedTurn: steered.interruptedTurn, followUpId: steered.followUpId, run: steered.run });
      }
      if (caller.kind !== 'ui') return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Only the user\'s page steers the Assistant itself; a brain steers a worker with runId.' });
      if (!sessionId) return res.status(400).json({ ok: false, code: 'SESSION_REQUIRED', error: 'assistantSessionId is required' });
      if (typeof runtime?.steerBrain !== 'function') return res.status(503).json({ ok: false, code: 'STEER_UNAVAILABLE', error: 'This server cannot steer the Assistant yet; restart it.' });
      const out = await runtime.steerBrain(String(sessionId), { text, origin: 'ui' });
      if (!out?.ok) {
        const status = out?.code === 'SESSION_NOT_FOUND' ? 404 : out?.code === 'MESSAGE_REQUIRED' ? 400 : 409;
        return res.status(status).json({ ok: false, code: out?.code || 'STEER_FAILED', error: out?.message || 'The steer did not reach the Assistant.', interruptedTurn: !!out?.interruptedTurn });
      }
      res.json({ ok: true, target: { kind: 'brain' }, interruptedTurn: !!out.interruptedTurn });
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
    const caller = req.assistantCaller;
    const stopProvenance = assistantStopProvenance(caller, req.body?.action);
    // 'user' is recorded only for a control a person operated, whatever the request says.
    const said = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const person = personAskedToStop(stopProvenance);
    const reason = said && (said !== 'user' || person) ? said : person ? 'user' : caller.credentialed ? 'assistant' : 'unknown';
    try { res.json(await dispatcher.stop(req.params.runId, reason, stopProvenance)); } catch (error) { sendError(res, error); }
  });
  // Finished runs are cleared from the agents tray by the owner (the page) or the Assistant brain of the run's
  // own session; never by a worker (even its own run). A brain's delete is scoped to its session's runs.
  router.delete('/runs/:runId', async (req, res) => {
    const caller = callerContext(req);
    const brain = brainCaller(req);
    if (caller.kind !== 'ui' && !brain) return uiOnly(req, res, 'Finished runs are removed by the owner (from SynaBun\'s own page) or the Assistant brain of the run\'s session.');
    if (brain && caller.kind !== 'ui') {
      // A brain removes only the runs of its own session: another session's run is left untouched.
      const runSession = dispatcher.get(req.params.runId)?.assistantSessionId || null;
      if (runSession && brain.assistantSessionId && String(runSession) !== String(brain.assistantSessionId)) {
        return res.status(403).json({ ok: false, code: 'RUN_NOT_IN_SESSION', error: `Run ${req.params.runId} belongs to another assistant session` });
      }
    }
    const assistantSessionId = (brain && caller.kind !== 'ui')
      ? (brain.assistantSessionId || null)
      : (req.query.assistantSessionId || req.body?.assistantSessionId || null);
    try { res.json(await dispatcher.remove(req.params.runId, { assistantSessionId })); } catch (error) { sendError(res, error); }
  });
  router.post('/runs/clear-finished', async (req, res) => {
    if (callerContext(req).kind !== 'ui') return uiOnly(req, res, 'Finished runs are removed from the assistant panel only.');
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
  // The user closed the sidepanel tab of a worker that finished its task: completed, never "stopped
  // by the user" (409 RUN_NOT_FINISHED for any other run, which the tab then stops as before).
  router.post('/runs/:runId/tab-closed', (req, res) => {
    const caller = callerContext(req);
    if (caller.kind !== 'ui') return uiOnly(req, res, 'Only the sidepanel that closed the tab reports it.');
    const action = req.body?.action === 'tray_auto_close' ? 'tray_auto_close' : 'tab_close';
    try { res.json(dispatcher.completeClosedTab(req.params.runId, pageStopProvenance(action, caller.verifiedPage))); } catch (error) { sendError(res, error); }
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
  // A session's budget and its live split (the spend chip, the Budget modal): the same view the
  // `assistant:budget` packet carries.
  router.get('/sessions/:id/budget', (req, res) => {
    if (!requireRuntime(res)) return;
    const id = req.params.id;
    if (!runtime.getSession(id, { transcript: false })) return res.status(404).json({ ok: false, code: 'SESSION_NOT_FOUND', error: `Unknown assistant session ${id}` });
    try { res.json({ ok: true, budget: sessionBudgetView(id) }); } catch (error) { sendError(res, error); }
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
        return res.json({ ok: true, session: session && head ? { ...session, live: head.live, fidelity: head.fidelity } : session, ...(run ? { run: usage?.runView?.(id, run) ?? null } : {}), budget: sessionBudgetView(id) });
      }
      // The session budget rides along (agent_usage: the mode and each provider's share / spent / left).
      res.json({ ok: true, usage: runtime.usageView?.(id, task) ?? usage?.taskView(id, task) ?? null, budget: sessionBudgetView(id) });
    } catch (error) { sendError(res, error); }
  });
  // The shell commands of a session's OpenCode brain (which tool call each belongs to, whether it runs, how it
  // ended) and a page of what one printed: what the panel's terminal blocks show. The owner's page alone reads
  // them (this boot's page secret, no agent header): what a command printed is display data, so no brain and no
  // worker gets it here, and with it nothing of it reaches a model's context. The session in the path is the one
  // whose own brain is asked, and that brain reads only a command it ran itself (runtime.shellOutput).
  function shellReader(req, res) {
    const agent = ['x-synabun-terminal', 'x-synabun-assistant', 'x-synabun-role', 'x-synabun-brain-token', 'x-synabun-desktop-grant'].some((name) => req.get(name));
    if (agent || isGuestRequest(req) || callerContext(req).kind !== 'ui') { uiOnly(req, res, 'A command\'s output is shown in the user\'s own Assistant panel only.'); return false; }
    // The automation browser verifies as the owner while the owner's setting lets it act as owner; it still never
    // reads what a command printed (review S4): a page an agent drives would hand it to that agent's model.
    let fromAutomationBrowser = false;
    try { fromAutomationBrowser = typeof pageSession?.isAutomationBrowser === 'function' && pageSession.isAutomationBrowser(req) === true; } catch { fromAutomationBrowser = true; }
    if (fromAutomationBrowser) { res.status(403).json({ ok: false, code: 'WORKER_BROWSER', error: 'A command\'s output is shown in the owner\'s own browser or the app, never in SynaBun\'s automation browser.' }); return false; }
    return true;
  }
  router.get('/sessions/:id/shells', noStore, (req, res) => {
    if (!requireRuntime(res) || !shellReader(req, res)) return;
    const shells = typeof runtime.shellList === 'function' ? runtime.shellList(req.params.id) : null;
    if (!shells) return res.status(404).json({ ok: false, code: 'SESSION_NOT_FOUND', error: `Unknown assistant session ${req.params.id}` });
    res.json({ ok: true, shells });
  });
  router.get('/sessions/:id/shells/:shellId/output', noStore, async (req, res) => {
    if (!requireRuntime(res) || !shellReader(req, res)) return;
    if (typeof runtime.shellOutput !== 'function') return res.status(404).json({ ok: false, code: 'SHELL_OUTPUT_GONE', error: 'The output of that command is no longer available.' });
    const shellId = String(req.params.shellId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(shellId)) return res.status(400).json({ ok: false, code: 'SHELL_ID_INVALID', error: 'That is not a command of this conversation.' });
    const number = (value) => (typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : undefined);
    try {
      const page = await runtime.shellOutput(req.params.id, { shellId, cursor: number(req.query.cursor), tail: number(req.query.tail), limit: number(req.query.limit) });
      if (!page || page.ok === false) return res.status(Number(page?.status) >= 400 ? Number(page.status) : 502).json({ ok: false, code: page?.code || 'SHELL_OUTPUT_FAILED', error: page?.error || 'The output could not be read.' });
      res.json({ ok: true, ...page.data });
    } catch (error) { sendError(res, error); }
  });
  // The background shells and watches of a session's Claude brain (the panel's Background tasks view), a page of
  // what one printed, and the owner's Stop. The same reader as a command's output (shellReader): the owner's page
  // alone, never a brain, a worker or the automation browser. The brain named in the path is the one asked, and its
  // transcript is the only one read (lib/claude-bg-tasks.js: only the file it reported for a task it ran).
  const bgTaskId = (value) => (/^[A-Za-z0-9_-]{1,128}$/.test(String(value || '')) ? String(value) : '');
  function bgSource(req, res) {
    if (!requireRuntime(res) || !shellReader(req, res)) return null;
    const source = typeof runtime.backgroundTaskSource === 'function' ? runtime.backgroundTaskSource(req.params.id) : null;
    if (source === null && typeof runtime.getSession === 'function' && !runtime.getSession(req.params.id, { transcript: false })) {
      res.status(404).json({ ok: false, code: 'SESSION_NOT_FOUND', error: `Unknown assistant session ${req.params.id}` });
      return null;
    }
    if (!source || !backgroundTasks) { res.json({ ok: true, tasks: [], live: null, supported: false }); return null; }
    return source;
  }
  router.get('/sessions/:id/background-tasks', noStore, (req, res) => {
    const source = bgSource(req, res);
    if (!source) return;
    try {
      const listed = backgroundTasks.list(source);
      res.json({ ok: true, supported: true, tasks: listed?.tasks || [], live: Array.isArray(source.live) ? source.live : null });
    } catch (error) {
      if (Number(error?.status) === 404) return res.json({ ok: true, supported: true, tasks: [], live: Array.isArray(source.live) ? source.live : null });
      sendError(res, error);
    }
  });
  router.get('/sessions/:id/background-tasks/:taskId/output', noStore, async (req, res) => {
    const taskId = bgTaskId(req.params.taskId);
    if (!taskId) { if (requireRuntime(res) && shellReader(req, res)) res.status(400).json({ ok: false, code: 'TASK_ID_INVALID', error: 'That is not a background task of this conversation.' }); return; }
    const source = bgSource(req, res);
    if (!source) return;
    const number = (value) => (typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : undefined);
    try {
      const running = Array.isArray(source.live) ? source.live.some((t) => t.task_id === taskId) : null;
      const page = await backgroundTasks.output(source, { taskId, cursor: number(req.query.cursor), tail: number(req.query.tail), limit: number(req.query.limit), running });
      if (!page || page.ok === false) return res.status(Number(page?.status) >= 400 ? Number(page.status) : 502).json({ ok: false, code: page?.code || 'OUTPUT_FAILED', error: page?.error || 'The output could not be read.' });
      res.json({ ok: true, ...page.data });
    } catch (error) { sendError(res, error); }
  });
  router.post('/sessions/:id/background-tasks/:taskId/stop', noStore, async (req, res) => {
    if (!requireRuntime(res) || !shellReader(req, res)) return;
    const taskId = bgTaskId(req.params.taskId);
    if (!taskId) return res.status(400).json({ ok: false, code: 'TASK_ID_INVALID', error: 'That is not a background task of this conversation.' });
    if (typeof runtime.stopBackgroundTask !== 'function') return res.status(404).json({ ok: false, code: 'NOT_SUPPORTED', error: 'Stopping a background task needs the SynaBun server restart.' });
    try {
      const out = await runtime.stopBackgroundTask(req.params.id, taskId);
      if (!out || out.ok === false) return res.status(Number(out?.status) >= 400 ? Number(out.status) : 409).json({ ok: false, code: out?.code || 'STOP_FAILED', error: out?.error || 'The task could not be stopped.' });
      res.json({ ok: true, taskId });
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
    // Test density is the user's setting too: an agent cannot raise or lower it.
    if (req.body && 'testDensity' in req.body && (req.get('x-synabun-terminal') || req.get('x-synabun-desktop-grant'))) {
      return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Only the user can change the Test density.' });
    }
    // agents-p4: Agent density is the user's setting as well: no agent raises the number of workers it may be given.
    // Any agent header refuses it, and so does a caller that is not the owner's own page (callerContext: the page
    // secret where one is wired; a worker's or a brain's pin is never the page).
    if (req.body && 'agentDensity' in req.body && (req.get('x-synabun-terminal') || req.get('x-synabun-desktop-grant') || req.get('x-synabun-role') || req.get('x-synabun-brain-token') || callerContext(req).kind !== 'ui')) {
      return uiOnly(req, res, 'Only the user can change the Agent density.');
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
  // Remove (the Sessions menu): the record, its transcript and its usage journal go for good, after its
  // running turn and the workers it dispatched are stopped. Memories made from it stay.
  router.delete('/sessions/:id', async (req, res) => {
    if (!requireRuntime(res)) return;
    try {
      if (runtime.removeSession) {
        const { removed, stoppedRuns } = await runtime.removeSession(req.params.id);
        return res.json({ ok: true, removed, stoppedRuns });
      }
      res.json({ ok: true, removed: await runtime.destroySession(req.params.id) });
    } catch (error) { sendError(res, error); }
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
      if (provider === 'claude-code' && typeof claudeAccountInUse === 'function') return claudeAccountInUse(accountId) || null;
      if (provider === 'codex' && typeof codexAccountInUse === 'function') return codexAccountInUse(accountId) || null;
      return null;
    };
  }
  // The Claude account a Claude Code worker runs under when its dispatch names none (null = Default).
  function claudeWorkerAccountId() {
    try { return configStore?.workers?.().claudeAccount || null; } catch { return null; }
  }
  // The same for Codex workers.
  function codexWorkerAccountId() {
    try { return configStore?.workers?.().codexAccount || null; } catch { return null; }
  }
  const claudeUnavailable = (res) => res.status(503).json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Claude accounts are not available' });
  // Every Claude account as every surface shows it (lib/claude-accounts.js describe()): mode, signed in,
  // identity (an email or a masked key, never a key). `?refresh=1` asks Claude Code about each first.
  router.get('/claude/accounts', async (req, res) => {
    if (!claudeAccounts) return claudeUnavailable(res);
    try {
      if (req.query.refresh === '1' || req.query.refresh === 'true') await claudeAccounts.refreshStatus?.(null, { force: true });
      else Promise.resolve(claudeAccounts.refreshStatus?.()).catch(() => {});
      await accountUsage?.refresh('claude-code');
      res.json({ ok: true, accounts: accountUsage?.list()?.['claude-code'] || claudeAccounts.listForClient(), workerAccountId: claudeWorkerAccountId() });
    } catch (error) { sendError(res, error); }
  });
  // Create an account. `login: true` also opens its Claude sign-in in a SynaBun terminal; otherwise the
  // caller offers the two ways to sign it in (Claude, or an API key pasted into it).
  router.post('/claude/accounts', async (req, res) => {
    if (!claudeAccounts) return claudeUnavailable(res);
    try {
      const account = claudeAccounts.create({ label: req.body?.label });
      let login = null;
      if (req.body?.login === true) login = await startClaudeLogin(account.id);
      catalogCache = null;
      res.status(201).json({ ok: true, account: claudeAccounts.listForClient().find((row) => row.id === account.id) || account, login });
    } catch (error) { sendError(res, error); }
  });
  async function startClaudeLogin(accountId) {
    // Claude Code's own `auth login` under the account's config directory, in a SynaBun terminal (the
    // panel's sign-in). The account list says when it is signed in (claude:accounts-changed).
    if (typeof claudeSignIn === 'function') {
      const terminal = await claudeSignIn(accountId);
      if (terminal?.status === 'error') throw Object.assign(new Error(terminal.error || 'Could not open the sign-in terminal.'), { status: 500, code: 'LOGIN_FAILED' });
      return { mode: 'terminal', terminalSessionId: terminal?.sessionId || null, status: terminal?.status || 'pending', profile: 'shell' };
    }
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
    if (!claudeAccounts) return claudeUnavailable(res);
    if (typeof claudeSignIn !== 'function' && typeof createLoginTerminal !== 'function') return res.status(501).json({ ok: false, code: 'LOGIN_UNAVAILABLE', error: 'Login terminals are not wired' });
    try {
      const row = claudeAccounts.get(req.params.id);
      if (!row || row.id !== req.params.id) return res.status(404).json({ ok: false, code: 'ACCOUNT_NOT_FOUND', error: `Unknown Claude account ${req.params.id}` });
      res.json({ ok: true, login: await startClaudeLogin(req.params.id) });
    } catch (error) { sendError(res, error); }
  });
  // Rename (`label`) and/or choose what the account's sessions use (`mode`: 'subscription' | 'apiKey').
  router.patch('/claude/accounts/:id', async (req, res) => {
    if (!claudeAccounts) return claudeUnavailable(res);
    try {
      const row = claudeAccounts.get(req.params.id);
      if (!row || row.id !== req.params.id) return res.status(404).json({ ok: false, code: 'ACCOUNT_NOT_FOUND', error: `Unknown Claude account ${req.params.id}` });
      const { label, mode } = req.body || {};
      if (label === undefined && mode === undefined) return res.status(400).json({ ok: false, code: 'NOTHING_TO_CHANGE', error: 'Send a label or a mode.' });
      if (label !== undefined) claudeAccounts.rename(req.params.id, label);
      if (mode !== undefined) {
        if (typeof claudeSetMode === 'function') await claudeSetMode(req.params.id, mode);
        else claudeAccounts.setMode(req.params.id, mode);
      }
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'claude-code', accountId: req.params.id });
      res.json({ ok: true, account: claudeAccounts.describeForClient ? claudeAccounts.describeForClient(req.params.id) : claudeAccounts.get(req.params.id) });
    } catch (error) { sendError(res, error); }
  });
  router.delete('/claude/accounts/:id', (req, res) => {
    if (!claudeAccounts) return claudeUnavailable(res);
    try {
      const result = claudeAccounts.remove(req.params.id, { inUse: accountInUse('claude-code') });
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'claude-code', accountId: req.params.id, removed: true });
      res.json({ ok: true, ...result });
    } catch (error) { sendError(res, error); }
  });
  // The account a Claude Code worker uses when its dispatch names none. Signed-out accounts are refused.
  router.put('/claude/worker-account', (req, res) => {
    if (!claudeAccounts || !configStore?.patchWorkers) return claudeUnavailable(res);
    try {
      const wanted = req.body?.accountId === null || req.body?.accountId === undefined || req.body?.accountId === '' ? 'default' : String(req.body.accountId);
      const row = claudeAccounts.get(wanted);
      if (!row || row.id !== wanted) return res.status(404).json({ ok: false, code: 'ACCOUNT_NOT_FOUND', error: `Unknown Claude account ${wanted}` });
      const unusable = claudeAccounts.unusableReason?.(wanted) || '';
      if (unusable) return res.status(409).json({ ok: false, code: 'ACCOUNT_SIGNED_OUT', error: unusable });
      const workers = configStore.patchWorkers({ claudeAccount: wanted });
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'claude-code', accountId: wanted, worker: true });
      res.json({ ok: true, workerAccountId: workers.claudeAccount });
    } catch (error) { sendError(res, error); }
  });
  const codexUnavailable = (res) => res.status(503).json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Codex accounts are not available' });
  // Every Codex account as every surface shows it (lib/codex-accounts.js describe()): mode, signed in,
  // identity (an email or a masked key, never a key). `?refresh=1` asks Codex about each own store first.
  router.get('/codex/accounts', async (req, res) => {
    if (!codexAccounts) return codexUnavailable(res);
    try {
      if (req.query.refresh === '1' || req.query.refresh === 'true') await codexAccounts.refreshStatus?.(null, { force: true });
      else Promise.resolve(codexAccounts.refreshStatus?.()).catch(() => {});
      await accountUsage?.refresh('codex');
      res.json({ ok: true, accounts: accountUsage?.list()?.codex || codexAccounts.listForClient(), workerAccountId: codexWorkerAccountId() });
    } catch (error) { sendError(res, error); }
  });
  // `codex login` under the account's CODEX_HOME, in a SynaBun terminal (the panel's sign-in). The account
  // list says when it is signed in (codex:accounts-changed).
  async function startCodexLogin(accountId) {
    if (typeof codexSignIn !== 'function') throw Object.assign(new Error('Login terminals are not wired'), { status: 501, code: 'LOGIN_UNAVAILABLE' });
    const terminal = await codexSignIn(accountId);
    if (terminal?.status === 'error') throw Object.assign(new Error(terminal.error || 'Could not open the sign-in terminal.'), { status: 500, code: 'LOGIN_FAILED' });
    return { mode: 'terminal', terminalSessionId: terminal?.sessionId || null, status: terminal?.status || 'pending', profile: 'shell' };
  }
  // Create an account. `login: true` also opens its ChatGPT sign-in in a SynaBun terminal; otherwise the
  // caller offers the two ways to sign it in (ChatGPT, or an API key pasted into it).
  router.post('/codex/accounts', async (req, res) => {
    if (!codexAccounts?.create) return codexUnavailable(res);
    try {
      const account = codexAccounts.create({ label: req.body?.label });
      const login = req.body?.login === true ? await startCodexLogin(account.id) : null;
      catalogCache = null;
      res.status(201).json({ ok: true, account: codexAccounts.describeForClient?.(account.id) || account, login });
    } catch (error) { sendError(res, error); }
  });
  // Older pages: create the account and open its ChatGPT sign-in at once.
  router.post('/codex/accounts/add-start', async (req, res) => {
    if (!codexAccounts?.create) return codexUnavailable(res);
    try {
      const account = codexAccounts.create({ label: req.body?.label });
      const login = await startCodexLogin(account.id).catch((error) => ({ error: error.message }));
      catalogCache = null;
      res.status(201).json({ ok: true, accountId: account.id, account: codexAccounts.describeForClient?.(account.id) || account, login });
    } catch (error) { sendError(res, error); }
  });
  router.post('/codex/accounts/:id/login', async (req, res) => {
    if (!codexAccounts) return codexUnavailable(res);
    try {
      const row = codexAccounts.describe?.(req.params.id);
      if (!row || row.id !== req.params.id) return res.status(404).json({ ok: false, code: 'ACCOUNT_NOT_FOUND', error: `Unknown Codex account ${req.params.id}` });
      res.json({ ok: true, login: await startCodexLogin(req.params.id) });
    } catch (error) { sendError(res, error); }
  });
  // Rename (`label`) and/or choose what the account's sessions use (`mode`: 'subscription' (ChatGPT) | 'apiKey').
  router.patch('/codex/accounts/:id', async (req, res) => {
    if (!codexAccounts) return codexUnavailable(res);
    try {
      const row = codexAccounts.describe?.(req.params.id);
      if (!row || row.id !== req.params.id) return res.status(404).json({ ok: false, code: 'ACCOUNT_NOT_FOUND', error: `Unknown Codex account ${req.params.id}` });
      const { label, mode } = req.body || {};
      if (label !== undefined) codexAccounts.rename(req.params.id, label);
      if (mode !== undefined) {
        if (typeof codexSetMode === 'function') await codexSetMode(req.params.id, mode);
        else codexAccounts.setMode(req.params.id, mode);
      }
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'codex', accountId: req.params.id });
      res.json({ ok: true, account: codexAccounts.describeForClient(req.params.id) });
    } catch (error) { sendError(res, error); }
  });
  router.delete('/codex/accounts/:id', (req, res) => {
    if (!codexAccounts?.remove) return codexUnavailable(res);
    try {
      const result = codexAccounts.remove(req.params.id, { inUse: accountInUse('codex') });
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'codex', accountId: req.params.id, removed: true });
      res.json({ ok: true, ...result });
    } catch (error) { sendError(res, error); }
  });
  // The account a Codex worker uses when its dispatch names none. Signed-out accounts are refused.
  router.put('/codex/worker-account', (req, res) => {
    if (!codexAccounts || !configStore?.patchWorkers) return codexUnavailable(res);
    try {
      const wanted = req.body?.accountId === null || req.body?.accountId === undefined || req.body?.accountId === '' ? 'default' : String(req.body.accountId);
      const row = codexAccounts.describe?.(wanted);
      if (!row || row.id !== wanted) return res.status(404).json({ ok: false, code: 'ACCOUNT_NOT_FOUND', error: `Unknown Codex account ${wanted}` });
      const unusable = codexAccounts.unusableReason?.(wanted) || '';
      if (unusable) return res.status(409).json({ ok: false, code: 'ACCOUNT_SIGNED_OUT', error: unusable });
      const workers = configStore.patchWorkers({ codexAccount: wanted });
      catalogCache = null;
      broadcastSync({ type: 'assistant:accounts-changed', provider: 'codex', accountId: wanted, worker: true });
      res.json({ ok: true, workerAccountId: workers.codexAccount });
    } catch (error) { sendError(res, error); }
  });

  // ── Admin sandbox (lib/agent-sandbox-setting.js) ───────────────────────────
  // Whether an agent SynaBun starts may use a sandbox whose setup needs Windows administrator
  // approval. Global, not per session. The user's setting: an agent cannot change it.
  router.get('/admin-sandbox', (req, res) => {
    if (!adminSandbox) return res.status(503).json({ ok: false, code: 'ADMIN_SANDBOX_UNAVAILABLE', error: 'The Admin sandbox setting is not available on this server' });
    res.json({ ok: true, ...adminSandbox.view() });
  });
  router.put('/admin-sandbox', requireJson, (req, res) => {
    if (!adminSandbox) return res.status(503).json({ ok: false, code: 'ADMIN_SANDBOX_UNAVAILABLE', error: 'The Admin sandbox setting is not available on this server' });
    if (req.get('x-synabun-desktop-grant')) return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Only the user can change the Admin sandbox.' });
    if (callerContext(req).kind !== 'ui') return uiOnly(req, res, 'Only the user can change the Admin sandbox.');
    const value = req.body?.adminSandbox;
    if (typeof value !== 'boolean') return res.status(400).json({ ok: false, code: 'INVALID_VALUE', error: 'adminSandbox must be true or false.' });
    try { res.json({ ok: true, ...adminSandbox.set(value) }); } catch (error) { sendError(res, error); }
  });

  // ── Protect workers (lib/worker-guard-setting.js) ──────────────────────────
  // What capability read-only / workspace means for every worker the dispatcher starts
  // (lib/worker-confinement.js): enforce (default), warn, off. The user's setting: an agent cannot change it.
  router.get('/worker-guard', (req, res) => {
    if (!workerGuard) return res.status(503).json({ ok: false, code: 'WORKER_GUARD_UNAVAILABLE', error: 'The Protect workers setting is not available on this server' });
    res.json({ ok: true, ...workerGuard.view() });
  });
  router.put('/worker-guard', requireJson, (req, res) => {
    if (!workerGuard) return res.status(503).json({ ok: false, code: 'WORKER_GUARD_UNAVAILABLE', error: 'The Protect workers setting is not available on this server' });
    if (req.get('x-synabun-desktop-grant') || req.get('x-synabun-role')) return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Only the user can change Protect workers.' });
    if (callerContext(req).kind !== 'ui') return uiOnly(req, res, 'Only the user can change Protect workers.');
    const value = req.body?.mode;
    if (typeof value !== 'string' || !workerGuard.view().modes.includes(value)) return res.status(400).json({ ok: false, code: 'INVALID_VALUE', error: `mode must be one of ${workerGuard.view().modes.join(', ')}.` });
    try { res.json({ ok: true, ...workerGuard.set(value) }); } catch (error) { sendError(res, error); }
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

  // ── Let the automation browser act as owner (lib/automation-browser-owner-access.js) ──────────────────
  // The read is any local caller's (the page draws it; an agent may know it). The write is the owner's page alone:
  // this boot's page secret, no agent header of any kind, and never SynaBun's automation browser (its marker or its
  // peer process), whatever the setting says: a browser worker must not be able to grant itself the owner's powers.
  router.get('/automation-browser-owner-access', (req, res) => {
    if (!automationBrowserOwnerAccess) return res.status(503).json({ ok: false, code: 'OWNER_ACCESS_UNAVAILABLE', error: 'The automation-browser owner access setting is not available on this server' });
    res.json({ ok: true, ...automationBrowserOwnerAccess.view() });
  });
  router.put('/automation-browser-owner-access', requireJson, (req, res) => {
    if (!automationBrowserOwnerAccess) return res.status(503).json({ ok: false, code: 'OWNER_ACCESS_UNAVAILABLE', error: 'The automation-browser owner access setting is not available on this server' });
    if (['x-synabun-desktop-grant', 'x-synabun-role', 'x-synabun-terminal', 'x-synabun-assistant', 'x-synabun-brain-token'].some((name) => req.get(name))) {
      return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'Only the user can let the automation browser act as owner.' });
    }
    let fromAutomationBrowser = false;
    try { fromAutomationBrowser = typeof pageSession?.isAutomationBrowser === 'function' && pageSession.isAutomationBrowser(req) === true; } catch { fromAutomationBrowser = true; }
    if (fromAutomationBrowser) return res.status(403).json({ ok: false, code: 'WORKER_BROWSER', error: 'This setting is changed from the owner\'s own browser or the app, never from SynaBun\'s automation browser.' });
    if (callerContext(req).kind !== 'ui') return uiOnly(req, res, 'Only the user can let the automation browser act as owner.');
    const value = req.body?.enabled;
    if (typeof value !== 'boolean') return res.status(400).json({ ok: false, code: 'INVALID_VALUE', error: 'enabled must be true or false.' });
    try { res.json({ ok: true, ...automationBrowserOwnerAccess.set(value) }); } catch (error) { sendError(res, error); }
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

  // ── agents-p4 BEGIN: teams (lib/teams/api.js) ──────────────────────────────
  // agent_team (a brain by its launch credential, or the owner's page) and a worker's `team` tool (a run that proves
  // its pin and works a team slice now; its team is read from the scheduler, never from the request).
  registerAssistantTeamRoutes(router, {
    scheduler: teamScheduler, orchestrationGuard, callerContext,
    density: (sessionId) => { try { return dispatcher.agentDensity?.(sessionId) ?? null; } catch { return null; } },
    // A planning brain starts, retries, lands and discards no team (planState: null for the owner's page).
    planning: (req, sessionId) => planState(req, sessionId),
  });
  // ── agents-p4 END ──────────────────────────────────────────────────────────

  return router;
}
