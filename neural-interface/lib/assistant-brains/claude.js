// ═══════════════════════════════════════════
// SynaBun — Assistant brain: Claude (Agent SDK via ClaudeSession)
// ═══════════════════════════════════════════
//
// Reuses the sidepanel's ClaudeSession end to end (streaming, permission cards,
// resume, idle reaping, cost accounting). The session talks to a virtual socket
// whose outbound packets are already the unified envelope, so they are forwarded
// verbatim to the assistant UI. Persona, memory hooks, role headers, the account
// config dir and the budget cap ride in through the ClaudeSession opts.

import { createVirtualSocket } from '../virtual-socket.js';
import { claudePlanHookDecision, claudePlanPermission, claudeReadOnlyHookDecision, claudeReadOnlyPermission, planDenyMessage, readOnlyDenyMessage } from '../assistant-plan-permissions.js';
import { planModeInstructions } from '../assistant-persona.js';
import { isComputerTool } from '../remote-policy.js';

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const APPROVAL_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions']);

/**
 * The SDK permission mode for an approval mode + the plan flag. Plan mode is
 * the SDK's 'plan'; approving the plan (ExitPlanMode) returns to the approval
 * mode — bypass included, which is why the session allows bypass up front.
 */
export function claudeSdkMode(approvalMode, planMode) {
  if (planMode || approvalMode === 'plan') return 'plan';
  return APPROVAL_MODES.has(approvalMode) ? approvalMode : 'default';
}

// Never gate these behind a permission card: routing must not wait on an
// approval prompt, and computer use is fully autonomous (its guards live in
// the desktop service, not in the host's permission layer).
export const CLAUDE_BRAIN_ALLOWED_TOOLS = Object.freeze([
  'mcp__SynaBun__agent_route', 'mcp__SynaBun__agent_catalog', 'mcp__SynaBun__agent_status', 'mcp__SynaBun__agent_read',
  'mcp__SynaBun__agent_list', 'mcp__SynaBun__agent_wait', 'mcp__SynaBun__agent_usage',
  'mcp__SynaBun__computer', 'mcp__SynaBun__computer_apps', 'mcp__SynaBun__computer_ax', 'mcp__SynaBun__computer_status',
]);

/**
 * The tools pre-approved for this brain. A remote (WhatsApp) brain pre-approves
 * no computer-use tool, whatever its level: its PreToolUse hook decides each
 * call (lib/remote-policy.js remoteComputerUse: refused, asked once per turn,
 * or allowed), so nothing here can let one through.
 */
export function claudeBrainAllowedTools(remoteLevel = null) {
  return remoteLevel ? CLAUDE_BRAIN_ALLOWED_TOOLS.filter((name) => !isComputerTool(name)) : [...CLAUDE_BRAIN_ALLOWED_TOOLS];
}

/** Bypass as a switch target: always for a desktop session (no remote level), only at autonomous for a remote one. */
export function claudeBypassAllowed(remoteLevel = null) {
  return !remoteLevel || remoteLevel === 'autonomous';
}

export function createClaudeBrain({ session, sink, deps = {}, persona = '', hooks = null, mcpHeaders = {} } = {}) {
  if (!deps.ClaudeSession) throw new Error('Claude brain requires deps.ClaudeSession');
  const brain = session.brain || {};
  const windowId = `assistant-${session.id}`;
  let providerSessionId = session.providerSessionId || null;
  let costUsd = 0;
  let disposed = false;
  const socket = createVirtualSocket({
    name: `claude-brain-${session.id}`,
    onSend: (packet) => {
      if (disposed || !packet || typeof packet !== 'object') return;
      if (packet.type === 'event') {
        const event = packet.event || {};
        if (event.type === 'system' && event.subtype === 'init' && event.session_id) providerSessionId = event.session_id;
        if (event.type === 'result') {
          if (event.session_id) providerSessionId = event.session_id;
          const cost = Number(event.total_cost_usd);
          if (Number.isFinite(cost)) costUsd = cost;
        }
      }
      if (packet.type === 'engine') { sink.send({ ...packet, brain: 'claude-code' }); return; }
      sink.send(packet);
    },
  });
  let approvalMode = APPROVAL_MODES.has(brain.permissionMode) ? brain.permissionMode : 'default';
  let planMode = brain.planMode === true || brain.permissionMode === 'plan';
  const permissionMode = claudeSdkMode(approvalMode, planMode);
  const allowedTools = claudeBrainAllowedTools(deps.remoteLevel);
  // A remote (WhatsApp) session at the read-only level plans read-only (its level
  // is read now, so a lowered level applies without a restart); every other
  // session's plan mode refuses code changes only.
  const planReadOnly = () => typeof deps.planReadOnly === 'function' && deps.planReadOnly() === true;
  const inner = new deps.ClaudeSession(socket, {
    ownerKey: session.id,
    windowId,
    sessionId: providerSessionId,
    model: brain.model || null,
    effort: brain.effort || null,
    cwd: brain.cwd || deps.PACKAGE_ROOT || null,
    permissionMode,
    // The mode an approved plan continues in, and bypass allowed as a switch
    // target (the SDK refuses bypassPermissions later without it). A remote
    // session (WhatsApp) allows it only at the autonomous level.
    planExitMode: approvalMode,
    allowDangerouslySkipPermissions: claudeBypassAllowed(deps.remoteLevel),
    // Plan mode refuses code changes (Edit, Write, MultiEdit, NotebookEdit, a
    // file-writing MCP tool) whatever the approval mode; reads run without a
    // card, and everything else is asked as outside plan mode. ExitPlanMode
    // still waits for the user. The hook refuses before the user's allow rules
    // run (canUseTool alone never sees an allow-listed tool), subagents included.
    planPermission: (tool, input, { approvalMode: mode = 'default' } = {}) => (planReadOnly()
      ? claudeReadOnlyPermission(tool, input)
      : claudePlanPermission(tool, input, { approvalMode: mode, preApproved: allowedTools })),
    planHook: (tool, input) => (planReadOnly() ? claudeReadOnlyHookDecision(tool, input) : claudePlanHookDecision(tool, input)),
    planDenyMessage: (tool) => (planReadOnly() ? readOnlyDenyMessage(tool) : planDenyMessage(tool, { host: 'claude' })),
    // What plan mode means here, inside the CLI's own plan-mode reminder. A remote
    // session keeps the CLI's read-only wording: its level can hold plan mode read-only.
    planModeInstructions: deps.remoteLevel ? undefined : planModeInstructions({ provider: 'claude-code' }),
    systemPromptAppend: persona || undefined,
    // User-level settings (global permissions, CLAUDE.md) apply; project hooks
    // are CLI-oriented (greeting, loop driver, stop nudges) and are not loaded.
    settingSources: Array.isArray(deps.settingSources) ? deps.settingSources : ['user'],
    hooks: hooks || undefined,
    mcpHeaders: {
      'X-Synabun-Role': 'assistant', 'X-Synabun-Terminal': session.id, 'X-Synabun-Memory-Session': session.id,
      ...(deps.desktopGrant ? { 'X-Synabun-Desktop-Grant': deps.desktopGrant } : {}),
      ...mcpHeaders,
    },
    // A remote (WhatsApp) session never pre-approves computer use: its PreToolUse hook refuses, asks or allows each call.
    allowedTools,
    // The user-level SynaBun hooks run in this CLI too (settingSources 'user').
    // The marker tells them the brain recalls in-process (assistant-memory.js):
    // prompt-submit.mjs steps aside (it injected every memory twice and paid Jev
    // twice) and stop.mjs skips the claim check (a relayed worker "tests pass"
    // has its evidence in the worker's turn, not here). Hooks read it from env.
    env: {
      ...(typeof deps.claudeAccountEnv === 'function' ? deps.claudeAccountEnv(brain.accountId) : {}),
      SYNABUN_ASSISTANT_SESSION: String(session.id),
    },
    maxBudgetUsd: Number(deps.maxBudgetUsd) > 0 ? Number(deps.maxBudgetUsd) : undefined,
  });
  sink.send({ type: 'engine', engine: 'sdk', brain: 'claude-code', sdkVersion: deps.sdkVersion || null });

  const handle = (msg) => { if (!disposed) return inner.handleMessage(msg); return undefined; };
  function applyModes(mode, plan) {
    if (mode === 'plan') planMode = true;
    else if (APPROVAL_MODES.has(mode)) approvalMode = mode;
    if (typeof plan === 'boolean') planMode = plan;
    // The session's own setter; a session without it (an older bridge, a test double) takes the field.
    if (typeof inner.setPlanExitMode === 'function') inner.setPlanExitMode(approvalMode);
    else if (inner.opts && typeof inner.opts === 'object') inner.opts.planExitMode = approvalMode;
    return claudeSdkMode(approvalMode, planMode);
  }

  // Per-turn model switch. ClaudeSession._handleQuery pushes the prompt before
  // calling setModel (the turn can start on the old model) and skips the switch
  // entirely when its model was null, so the brain switches first itself.
  async function applyTurnModel(model) {
    const want = model || null;
    if (typeof inner.setModel === 'function') {
      const switched = await inner.setModel(want);
      if (!switched.ok) sink.send({ type: 'stderr', text: `Model switch failed: ${switched.error}` });
      return;
    }
    if ((inner.model || null) === want) return;
    if (inner.q?.setModel) {
      try { await inner.q.setModel(want || undefined); }
      catch (error) { sink.send({ type: 'stderr', text: `Model switch failed: ${error?.message || error}` }); return; }
    }
    inner.model = want; // ensureQuery() reads it when the next query is created
  }

  return {
    kind: 'claude-code',
    async start() { return true; },
    async sendUserTurn({ text, images = [], cwd = null, model = null, effort = null, permissionMode: mode = null, planMode: plan = null } = {}) {
      await applyTurnModel(model);
      const query = { type: 'query', prompt: text, windowId };
      if (Array.isArray(images) && images.length) query.images = images;
      if (providerSessionId) query.sessionId = providerSessionId;
      if (cwd) query.cwd = cwd;
      if (effort) query.effort = effort;
      if ((mode && PERMISSION_MODES.has(mode)) || typeof plan === 'boolean') query.permissionMode = applyModes(mode, plan);
      await handle(query);
      return true;
    },
    async abort() { await handle({ type: 'abort' }); },
    async setPermissionMode(mode, { planMode: plan = null } = {}) {
      if (!PERMISSION_MODES.has(mode) && typeof plan !== 'boolean') return;
      await handle({ type: 'set_permission_mode', mode: applyModes(mode, plan) });
    },
    respondControl(requestId, response) { handle({ type: 'control_response', request_id: requestId, response }); },
    async compact() { await handle({ type: 'compact' }); },
    async mcpStatus() { await handle({ type: 'mcp_status' }); },
    async resume(sessionId) { providerSessionId = sessionId || null; inner.sessionId = providerSessionId; if (inner.q) await inner._endQuery?.({ graceful: true }); },
    async listSessions() { return []; },
    isBusy() { return !!(inner.inTurn || inner.pendingPerms?.size > 0 || inner.pendingTurns > 0); },
    // Background agents or scheduled wakeups still running after their turn
    // ended. Not "busy" (the mailbox may deliver), but disposing would kill them.
    hasPendingWork() { return !!inner._hasPendingWork?.(); },
    identity() {
      return {
        providerSessionId: inner.sessionId || providerSessionId, providerThreadId: null, accountId: brain.accountId || 'default',
        model: inner.model || brain.model || null, effort: inner.effort || brain.effort || null, cwd: inner.cwd || brain.cwd || null,
        costUsd, busy: !!(inner.inTurn || inner.pendingPerms?.size > 0),
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { inner.destroy(); } catch {}
      socket.close();
    },
  };
}
