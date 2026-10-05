// ═══════════════════════════════════════════
// SynaBun — Assistant brain: Codex (app-server via the codex-skin handler)
// ═══════════════════════════════════════════
//
// Drives the existing `handleCodexSkinWebSocket` (accounts, thread lifecycle,
// approvals, MCP pins, rate limits) through a virtual socket, speaking the
// sidepanel protocol with a fixed ownership envelope. Packets coming back are
// translated into the unified envelope; the persona rides as
// `developerInstructions` on every query (collaborationMode.settings).

import { randomUUID } from 'node:crypto';
import { createVirtualSocket } from '../virtual-socket.js';
import { createCodexEnvelopeTranslator, codexControlResponse } from '../assistant-envelope.js';
import { baseModelId, contextVariantOf } from '../assistant-catalog.js';
import { codexPlanPermission, codexReadOnlyPermission, planDenyMessage, readOnlyDenyMessage } from '../assistant-plan-permissions.js';
import { planModeInstructions } from '../assistant-persona.js';

const READY_TIMEOUT_MS = 90_000;
// Approvals the Codex sidepanel's Auto-accept answers on its own (cdx-requests.js).
const AUTO_ACCEPT_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);

/** The assistant's Codex approval mode: 'auto' (auto-accept) or 'default'. Claude's names read as auto. */
export function codexApprovalMode(mode) {
  return mode === 'auto' || mode === 'acceptEdits' || mode === 'bypassPermissions' ? 'auto' : 'default';
}

export function createCodexBrain({ session, sink, deps = {}, persona = '' } = {}) {
  if (typeof deps.handleCodexSkinWebSocket !== 'function') throw new Error('Codex brain requires deps.handleCodexSkinWebSocket');
  const brain = session.brain || {};
  const ownerSessionId = session.id;
  const connectionEpoch = randomUUID();
  const windowId = `assistant-${session.id}`;
  const pendingControls = new Map();
  let threadId = session.providerThreadId || null;
  let disposed = false;
  let readyResolve = null;
  let readyPromise = null;
  let turnActive = false;
  // The query sent whose turn has not started (its requestId). Codex answers a
  // query it refuses before any turn starts (turn/start rejected, a pending
  // approval, a turn already running) with an `error` for it and nothing else.
  let startingRequest = null;
  let lastTurn = null;
  let usage = null;
  // Approval mode and plan mode are independent: plan runs Codex's native plan
  // collaboration mode (read-only sandbox, so a patch has to ask) and its policy
  // (codexPlanPermission) declines patches and file-write grants, allows reads,
  // and leaves every other approval to the approval mode, as outside plan. The
  // server-side MCP auto-accept is off in plan so every approval reaches it.
  let approvalMode = codexApprovalMode(brain.permissionMode);
  let planMode = brain.planMode === true || brain.permissionMode === 'plan';
  // A remote (WhatsApp) session: Codex cannot ask before ordinary commands, so the
  // brain is read-only for good — the read-only sandbox (network off) on every
  // turn, every escalation declined as in plan mode, never auto-accept.
  const remoteReadOnly = deps.remoteReadOnly === true;
  const readOnlyTurn = () => (remoteReadOnly ? { sandboxMode: 'read-only' } : {});
  function applyModes(mode, plan) {
    if (mode === 'plan') planMode = true;
    else if (mode) approvalMode = codexApprovalMode(mode);
    if (typeof plan === 'boolean') planMode = plan;
  }
  // Route gate: 'hook' when the app-server runs the trusted PreToolUse hook,
  // 'reactive' otherwise (the runtime interrupts ungated tool starts).
  let gateMode = deps.routeGate ? 'reactive' : null;
  // Whether the last query asked for Codex's plan collaboration mode: only that
  // turn's proposed plan is a plan (the translator reads it as the turn starts).
  let queryPlanMode = false;

  const translator = createCodexEnvelopeTranslator({
    priceUsage: typeof deps.priceCodexUsage === 'function' ? deps.priceCodexUsage : null,
    brain: { cwd: brain.cwd || null, model: brain.model || null },
    planTurn: () => queryPlanMode,
    emit: (packet) => {
      if (disposed) return;
      // A WhatsApp session's brain answers every approval read-only (anything that
      // would leave the read-only sandbox is declined). Plan mode declines code
      // changes, allows reads, and hands the rest to the approval mode (auto
      // allows it here, default leaves it to a card below).
      let planned = null;
      if (packet.type === 'control_request') {
        if (remoteReadOnly) planned = codexReadOnlyPermission(packet);
        else if (planMode) planned = codexPlanPermission(packet, { approvalMode });
      }
      if (planned) {
        const method = packet.request?.brain_native?.method || packet.request?.method || '';
        const tool = packet.request?.brain_native?.params?._meta?.tool_name || packet.request?.tool_name || 'request';
        const response = planned === 'allow'
          ? { behavior: 'allow', ...(!remoteReadOnly && approvalMode === 'auto' ? { always: true } : {}) }
          : { behavior: 'deny', decline: true, message: remoteReadOnly ? readOnlyDenyMessage(tool) : planDenyMessage(tool, { host: 'codex' }) };
        send({ type: 'server_request_response', ...codexControlResponse(packet, response) });
        sink.send({ type: 'stderr', text: `${planMode ? 'Plan mode' : 'Read-only (WhatsApp)'}: ${planned === 'allow' ? 'allowed' : 'declined'} ${String(method).split('/').slice(1, -1).join('/') || 'request'} ${tool}${planned === 'allow' ? '' : remoteReadOnly ? ' (read-only)' : ' (no code changes)'}` });
        return;
      }
      if (packet.type === 'control_request' && !planMode && !remoteReadOnly && approvalMode === 'auto' && AUTO_ACCEPT_METHODS.has(packet.request?.brain_native?.method || packet.request?.method)) {
        // Auto-accept: approve at once (for the session when offered), as the Codex sidepanel does.
        send({ type: 'server_request_response', ...codexControlResponse(packet, { behavior: 'allow', always: true }) });
        sink.send({ type: 'stderr', text: `Auto-accepted: ${String(packet.request?.brain_native?.method || packet.request?.method).split('/').slice(1, -1).join('/')}` });
        return;
      }
      if (packet.type === 'control_request') pendingControls.set(packet.request_id, packet);
      // That error is the refused query's only answer: its turn, which never started, ends here.
      const refused = packet.type === 'error' && !!startingRequest && packet.requestId === startingRequest;
      if (packet.type === 'done' || packet.type === 'aborted' || packet.type === 'error') {
        if (packet.type !== 'error') { turnActive = false; startingRequest = null; }
        for (const [id, pending] of pendingControls) if (pending.request?.provider === 'codex') pendingControls.delete(id);
      }
      sink.send(packet);
      if (refused) {
        startingRequest = null;
        turnActive = false;
        sink.send({ type: 'done', code: 1 });
      }
    },
    // The thread hook is metering: a throw there must not leave the brain waiting for ready.
    onThread: (id) => { if (id) { threadId = id; try { deps.onCodexThread?.(id); } catch {} } readyResolve?.(); },
    onTurnStart: () => { turnActive = true; startingRequest = null; },
    onTurnEnd: (info) => { turnActive = false; lastTurn = info; },
    onUsage: (value) => { usage = value; try { deps.onCodexUsage?.(); } catch {} },
  });
  const socket = createVirtualSocket({
    name: `codex-brain-${session.id}`,
    onSend: (packet) => {
      if (disposed || !packet || typeof packet !== 'object') return;
      if (packet.type === 'ready') readyResolve?.();
      translator.handle(packet);
    },
  });
  deps.handleCodexSkinWebSocket(socket);
  const send = (message) => socket.receive({ ...message, sessionId: ownerSessionId, connectionEpoch });
  // A query: busy from before it is sent (a refusal may come back at once) until its turn ends or Codex refuses it.
  const sendQuery = (message) => {
    const requestId = randomUUID();
    startingRequest = requestId;
    turnActive = true;
    send({ ...message, type: 'query', requestId });
  };
  sink.send({ type: 'engine', engine: 'codex', brain: 'codex' });

  let startPromise = null;
  function start() {
    if (!startPromise) startPromise = boot();
    return startPromise;
  }
  async function boot() {
    if (disposed) throw new Error('Codex brain disposed');
    if (readyPromise) return readyPromise;
    let routeGate = null;
    if (typeof deps.routeGate === 'function') {
      try { routeGate = await deps.routeGate(); } catch { routeGate = null; }
      gateMode = routeGate ? 'hook' : 'reactive';
    }
    if (disposed) throw new Error('Codex brain disposed');
    readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex app-server did not become ready')), READY_TIMEOUT_MS);
      timer.unref?.();
      readyResolve = () => { clearTimeout(timer); resolve(true); };
    });
    send({
      type: 'bootstrap', windowId, accountId: brain.accountId || 'default', mcpProfile: brain.mcpProfile || null,
      cwd: brain.cwd || deps.PACKAGE_ROOT || undefined, threadId: threadId || null, role: 'assistant',
      // Unlocks the capability-gated `computer` MCP group for this brain only.
      desktopGrant: deps.desktopGrant || null,
      ...(routeGate ? { routeGate } : {}),
    });
    return readyPromise;
  }

  return {
    kind: 'codex',
    start,
    async sendUserTurn({ text, images = [], cwd = null, model = null, effort = null, permissionMode: mode = null, planMode: plan = null } = {}) {
      await start();
      applyModes(mode, plan);
      queryPlanMode = planMode;
      // "<id>[extended]" = the model at its extended context window (the sidepanel's contextMode).
      const picked = model || brain.model || null;
      sendQuery({
        prompt: text, images: Array.isArray(images) && images.length ? images : undefined,
        cwd: cwd || brain.cwd || deps.PACKAGE_ROOT || undefined, model: picked ? baseModelId(picked) : null, effort: effort || brain.effort || null,
        contextMode: contextVariantOf(picked) === 'extended' ? 'extended' : undefined,
        threadId: threadId || null, autoAccept: approvalMode === 'auto' && !planMode && !remoteReadOnly, planMode,
        // A plan turn carries what plan mode means here (a WhatsApp session's read-only brain does not).
        developerInstructions: [persona, planMode && !remoteReadOnly ? planModeInstructions({ provider: 'codex' }) : ''].filter(Boolean).join('\n\n') || null,
        windowId, ...readOnlyTurn(),
      });
      return true;
    },
    async abort() { send({ type: 'interrupt', threadId: threadId || null }); },
    async setPermissionMode(mode, { planMode: plan = null } = {}) { applyModes(mode, plan); sink.send({ type: 'mode_changed', mode: approvalMode, planMode }); },
    respondControl(requestId, response) {
      const pending = pendingControls.get(String(requestId));
      if (!pending) { sink.send({ type: 'error', message: `No pending Codex request ${requestId}` }); return; }
      pendingControls.delete(String(requestId));
      send({ type: 'server_request_response', ...codexControlResponse(pending, response) });
    },
    // A turn of its own: busy until its `done`, like sendUserTurn (the runtime starts nothing meanwhile).
    async compact() { queryPlanMode = false; sendQuery({ prompt: '/compact', threadId: threadId || null, cwd: brain.cwd || undefined, windowId, ...readOnlyTurn() }); },
    async mcpStatus() { send({ type: 'mcp_status' }); },
    async resume(id) { if (!id) return; threadId = id; send({ type: 'thread_resume', threadId: id, cwd: brain.cwd || undefined }); },
    async listSessions() { return []; },
    isBusy() { return turnActive || pendingControls.size > 0; },
    get gateMode() { return gateMode; },
    identity() {
      return { providerSessionId: threadId, providerThreadId: threadId, accountId: brain.accountId || 'default', model: brain.model || null, effort: brain.effort || null, cwd: brain.cwd || null, usage, lastTurn, busy: turnActive };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { send({ type: 'release', windowId }); } catch {}
      socket.close();
    },
  };
}
