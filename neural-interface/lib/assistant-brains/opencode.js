// ═══════════════════════════════════════════
// SynaBun — Assistant brain: OpenCode (isolated serve + SDK client)
// ═══════════════════════════════════════════
//
// One isolated `opencode serve` per assistant session (same helpers the
// OpenCode sidepanel uses). The persona is installed as a custom primary agent
// (`agent.assistant.prompt`) in the per-serve config so the model sees it as
// its system prompt; SSE events are translated to the unified envelope.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeOpenCodeModel } from '../native-loop-providers.js';
import { compactOrSummarize } from '../opencode-v2-client.js';
import { createOpenCodeEnvelopeTranslator, opencodeControlResponse } from '../assistant-envelope.js';
import { opencodePlanPermission, opencodeReadOnlyPermission, planDenyMessage, readOnlyDenyMessage } from '../assistant-plan-permissions.js';
import { planModeInstructions } from '../assistant-persona.js';

/** The MCP terminal pin of an assistant session's OpenCode brain. */
export function opencodeTermIdFor(sessionId) {
  return `assistant-oc-${String(sessionId).replace(/^assistant-/, '').slice(0, 24)}`;
}

/** Composer images ({ base64, mediaType }) → OpenCode file parts. */
export function opencodeImageParts(images = []) {
  const parts = [];
  (Array.isArray(images) ? images : []).forEach((image, index) => {
    const data = image?.base64 || image?.data || null;
    const mime = image?.mediaType || image?.media_type || image?.mime || 'image/png';
    if (!data || typeof data !== 'string') return;
    const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
    parts.push({ type: 'file', mime, filename: `image-${index + 1}.${ext}`, url: data.startsWith('data:') ? data : `data:${mime};base64,${data}` });
  });
  return parts;
}

/** The route-gate plugin (opencode-route-gate.js) as a file URL the serve can load. */
export const OPENCODE_ROUTE_GATE_PLUGIN = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'opencode-route-gate.js')).href;

/**
 * SynaBun's plan agent. OpenCode adds its own read-only reminder ("commands may
 * ONLY read/inspect… overrides ALL other instructions") to every turn of the
 * agent named `plan`, which no instruction of ours can outweigh; this agent has
 * the plan agent's permissions under another name: the edit family denied,
 * every command asked (the plan policy and the approval mode answer), questions allowed.
 */
export const OPENCODE_PLAN_AGENT = 'synabun-plan';

/**
 * `routeGate` ({ url, session, token }) installs the route-gate plugin in this
 * isolated serve's config only (assistant brains; never the shared sidepanel setup).
 */
export function patchOpenCodeAssistantConfig(xdgRoot, { persona = '', role = 'assistant', model = null, desktopGrant = null, routeGate = null } = {}) {
  const configPath = resolve(xdgRoot, 'opencode', 'config.json');
  if (!existsSync(configPath)) return false;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.mcp?.SynaBun && typeof config.mcp.SynaBun === 'object') {
    const envKey = config.mcp.SynaBun.environment ? 'environment' : (config.mcp.SynaBun.env ? 'env' : 'environment');
    const env = { ...(config.mcp.SynaBun[envKey] || {}), SYNABUN_ROLE: role };
    // Computer use: an unforgeable per-brain grant unlocks the `computer` group.
    if (desktopGrant) env.SYNABUN_DESKTOP_GRANT = desktopGrant;
    else delete env.SYNABUN_DESKTOP_GRANT;
    config.mcp.SynaBun[envKey] = env;
  }
  config.agent = { ...(config.agent || {}) };
  config.agent.assistant = {
    ...(config.agent.assistant || {}),
    mode: 'primary',
    description: 'SynaBun central assistant',
    prompt: persona || undefined,
    ...(model ? { model } : {}),
  };
  // SynaBun's plan agent (desktop plan turns): no code changes, anything else as the approval mode says.
  config.agent[OPENCODE_PLAN_AGENT] = {
    ...(config.agent[OPENCODE_PLAN_AGENT] || {}),
    mode: 'primary',
    hidden: true,
    description: 'SynaBun plan mode: explore, run commands and use every tool; no code changes',
    prompt: persona || undefined,
    ...(model ? { model } : {}),
    permission: { ...(config.agent[OPENCODE_PLAN_AGENT]?.permission || {}), edit: 'deny', bash: 'ask', question: 'allow', task: { general: 'deny' } },
  };
  // OpenCode's own plan agent (a WhatsApp session's read-only brain) refuses only
  // edits and runs any command without asking: here every command asks, so the
  // read-only classifier decides on the whole line.
  config.agent.plan = { ...(config.agent.plan || {}), permission: { ...(config.agent.plan?.permission || {}), bash: 'ask' } };
  const plugins = (Array.isArray(config.plugin) ? config.plugin : []).filter((entry) => (Array.isArray(entry) ? entry[0] : entry) !== OPENCODE_ROUTE_GATE_PLUGIN);
  // `remote`: a WhatsApp session's serve — the plugin refuses a call it could not check (fail closed).
  if (routeGate?.url && routeGate?.session && routeGate?.token) plugins.push([OPENCODE_ROUTE_GATE_PLUGIN, { url: routeGate.url, session: routeGate.session, token: routeGate.token, ...(routeGate.remote === true ? { remote: true } : {}) }]);
  if (plugins.length) config.plugin = plugins; else delete config.plugin;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return true;
}

/** The assistant's OpenCode approval mode: 'auto' (auto-accept) or 'default'. */
export function opencodeApprovalMode(mode) {
  return mode === 'auto' || mode === 'acceptEdits' || mode === 'bypassPermissions' ? 'auto' : 'default';
}

/**
 * A plan turn's instructions (assistant-persona.js planModeInstructions): plan
 * mode blocks code changes only, and SynaBun shows its "Plan ready" card only
 * for a reply that proposes the plan in a <proposed_plan> block, the convention
 * of Codex's plan mode (the runtime's planTurnText). A question or a discussion
 * without the block gets no card.
 */
export const OPENCODE_PLAN_INSTRUCTIONS = planModeInstructions({ provider: 'opencode' });

/**
 * How an OpenCode ask is answered without the user: 'allow', 'deny', or null (a card).
 * `readOnly` (a WhatsApp session's brain): the read-only classifier answers
 * every ask. Plan mode refuses the edit family and file-writing MCP tools,
 * allows reads, and leaves the rest to the approval mode; outside plan,
 * auto-accept allows. Questions always need the user.
 */
export function opencodeAutoDecision(packet, { approvalMode, planMode, readOnly = false }) {
  if (packet?.request?.brain_native?.kind === 'question') return null;
  if (readOnly) return opencodeReadOnlyPermission(packet);
  if (planMode) return opencodePlanPermission(packet, { approvalMode });
  return approvalMode === 'auto' ? 'allow' : null;
}

/** Should this OpenCode ask be approved without the user? */
export function opencodeAutoAccepts(packet, modes) {
  return opencodeAutoDecision(packet, modes) === 'allow';
}

export function createOpenCodeBrain({ session, sink, deps = {}, persona = '' } = {}) {
  for (const key of ['ensureIsolatedServe', 'stopIsolatedServe', 'setupOpencodeSidepanelConfig']) {
    if (typeof deps[key] !== 'function') throw new Error(`OpenCode brain requires deps.${key}`);
  }
  const brain = session.brain || {};
  const termId = opencodeTermIdFor(session.id);
  const cwd = brain.cwd || deps.PACKAGE_ROOT || process.cwd();
  const pendingControls = new Map();
  let entry = null;
  let client = null;
  let unsubscribe = null;
  let translator = null;
  let sessionId = session.providerSessionId || null;
  let disposed = false;
  let turnActive = false;
  let personaInstalled = false;
  let keepAliveTimer = null;
  let costUsd = 0;
  let startPromise = null;
  // The model the last turn ran on: what a compaction summarises with.
  let lastTurnModel = null;
  // Plan mode runs SynaBun's plan agent (OPENCODE_PLAN_AGENT; OpenCode's own
  // `plan` agent, the persona riding as `system`, when the config patch failed).
  let approvalMode = opencodeApprovalMode(brain.permissionMode);
  let planMode = brain.planMode === true || brain.permissionMode === 'plan';
  // A remote (WhatsApp) session: OpenCode keeps its own permissions, so the brain
  // is read-only for good — OpenCode's plan agent on every turn, the read-only
  // classifier on every ask, never auto-accept (web fetch / search are refused
  // by the gate plugin).
  const remoteReadOnly = deps.remoteReadOnly === true;
  const planning = () => planMode || remoteReadOnly;
  // The turn running now is a plan turn proper (not a remote session's read-only
  // plan agent): it was asked for a <proposed_plan> block (OPENCODE_PLAN_INSTRUCTIONS).
  let turnPlanned = false;
  function applyModes(mode, plan) {
    if (mode === 'plan') planMode = true;
    else if (mode) approvalMode = opencodeApprovalMode(mode);
    if (typeof plan === 'boolean') planMode = plan;
  }

  const emit = (packet) => {
    if (disposed) return;
    const decision = packet.type === 'control_request' && client ? opencodeAutoDecision(packet, { approvalMode: remoteReadOnly ? 'default' : approvalMode, planMode: planning(), readOnly: remoteReadOnly }) : null;
    if (decision) {
      const body = opencodeControlResponse(packet, { behavior: decision });
      const tool = packet.request?.tool_name;
      if (decision === 'deny') sink.send({ type: 'stderr', text: `Plan mode: declined ${tool || 'permission'}${remoteReadOnly ? ' (read-only)' : ' (no code changes)'}` });
      Promise.resolve(client.permission.reply({ requestID: body.requestID, reply: body.reply, directory: cwd, ...(decision === 'deny' ? { message: remoteReadOnly ? readOnlyDenyMessage(tool) : planDenyMessage(tool, { host: 'opencode' }) } : {}) }))
        .catch((error) => sink.send({ type: 'error', message: `OpenCode auto-${decision === 'allow' ? 'accept' : 'decline'} failed: ${error?.message || error}` }));
      return;
    }
    if (packet.type === 'control_request') pendingControls.set(packet.request_id, packet);
    if (packet.type === 'done' || packet.type === 'aborted') turnActive = false;
    sink.send(packet);
  };
  sink.send({ type: 'engine', engine: 'opencode', brain: 'opencode' });

  function bindTranslator() {
    translator = createOpenCodeEnvelopeTranslator({
      sessionId, emit, brain: { cwd, model: brain.model || null }, planTurn: () => turnPlanned,
      onUsageEvent: (type, event) => deps.onOpenCodeEvent?.(type, event),
      onTurnEnd: (info) => { turnActive = false; if (Number.isFinite(info?.costUsd)) costUsd = info.costUsd; },
    });
    if (unsubscribe) { try { unsubscribe(); } catch {} }
    const source = client?.onEvent ? client : client?.event;
    unsubscribe = source?.onEvent?.((envelope) => translator.handle(envelope?.eventType || '', envelope?.event || {})) || null;
  }

  /** The serve's MCP servers as an `mcp_status` event (the runtime reads whether SynaBun, and so agent_route, is reachable). */
  async function reportMcpStatus() {
    try { const status = await client?.mcp?.status?.({ directory: cwd }); sink.send({ type: 'event', event: { type: 'system', subtype: 'mcp_status', servers: status?.data || status || [] } }); } catch {}
  }

  async function start() {
    if (disposed) throw new Error('OpenCode brain disposed');
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const xdgRoot = deps.setupOpencodeSidepanelConfig(termId, brain.mcpProfile || null);
      try { personaInstalled = patchOpenCodeAssistantConfig(xdgRoot, { persona, model: null, desktopGrant: deps.desktopGrant || null, routeGate: deps.routeGate || null }); } catch { personaInstalled = false; }
      entry = await deps.ensureIsolatedServe(termId, { xdgRoot, keepAlive: true, mcpProfile: brain.mcpProfile || null });
      if (!entry?.client) throw new Error('OpenCode isolated serve failed to start');
      client = entry.client;
      await client.waitUntilConnected?.(20_000);
      if (!sessionId) {
        const created = await client.session.create({ directory: cwd, title: session.title || 'SynaBun Assistant' });
        sessionId = created?.data?.id || created?.id || null;
        if (!sessionId) throw new Error('OpenCode did not return a session id');
      }
      entry.sessions?.add?.(sessionId);
      deps.onOpenCodeRoot?.(sessionId);
      bindTranslator();
      keepAliveTimer = setInterval(() => { if (entry) entry.lastUsed = Date.now(); }, 60_000);
      keepAliveTimer.unref?.();
      await reportMcpStatus();
      return true;
    })();
    return startPromise;
  }

  return {
    kind: 'opencode',
    start,
    async sendUserTurn({ text, images = [], model = null, effort = null, permissionMode: mode = null, planMode: plan = null } = {}) {
      await start();
      applyModes(mode, plan);
      turnActive = true;
      // The runtime passes the effective model/effort on every turn (the record
      // may have changed since this brain started; routed turns override it).
      const parts = [{ type: 'text', text }, ...opencodeImageParts(images)];
      const request = {
        sessionID: sessionId, parts, model: normalizeOpenCodeModel(model || brain.model), directory: cwd,
      };
      if (request.model) lastTurnModel = request.model;
      if (effort) request.variant = String(effort);
      turnPlanned = planMode && !remoteReadOnly;
      if (turnPlanned && personaInstalled) {
        // SynaBun's plan agent carries the persona as its prompt; the turn carries what plan mode means.
        request.agent = OPENCODE_PLAN_AGENT;
        request.system = OPENCODE_PLAN_INSTRUCTIONS;
      } else if (planning()) {
        request.agent = 'plan';
        const system = [persona, turnPlanned ? OPENCODE_PLAN_INSTRUCTIONS : ''].filter(Boolean).join('\n\n');
        if (system) request.system = system;
      }
      else if (personaInstalled) request.agent = brain.agent || 'assistant';
      else { request.agent = brain.agent || 'build'; if (persona) request.system = persona; }
      if (entry) entry.lastUsed = Date.now();
      // SynaBun may have connected (or failed) since the last turn: the route gate follows it.
      await reportMcpStatus();
      const response = await client.session.promptAsync(request);
      const status = Number(response?.status);
      if (Number.isFinite(status) && status >= 400) { turnActive = false; throw new Error(`OpenCode prompt failed (${status})`); }
      return true;
    },
    async abort() { if (client && sessionId) await client.session.abort({ sessionID: sessionId, directory: cwd }).catch(() => {}); emit({ type: 'aborted' }); },
    async setPermissionMode(mode, { planMode: plan = null } = {}) { applyModes(mode, plan); sink.send({ type: 'mode_changed', mode: approvalMode, planMode }); },
    respondControl(requestId, response) {
      const pending = pendingControls.get(String(requestId));
      if (!pending || !client) { sink.send({ type: 'error', message: `No pending OpenCode request ${requestId}` }); return; }
      pendingControls.delete(String(requestId));
      const body = opencodeControlResponse(pending, response);
      const call = body.kind === 'question'
        ? (body.reject ? client.question.reject({ requestID: body.requestID, directory: cwd }) : client.question.reply({ requestID: body.requestID, answers: body.answers, directory: cwd }))
        : client.permission.reply({ requestID: body.requestID, reply: body.reply, directory: cwd });
      Promise.resolve(call).catch((error) => sink.send({ type: 'error', message: `OpenCode reply failed: ${error?.message || error}` }));
    },
    // OpenCode 1.18.34 answers v2.session.compact with 503 "not available yet":
    // compactOrSummarize then summarises on the model of the last turn.
    async compact() {
      await start();
      turnPlanned = false;
      await compactOrSummarize(client, { sessionID: sessionId, directory: cwd, model: lastTurnModel || normalizeOpenCodeModel(brain.model) });
    },
    async mcpStatus() { await reportMcpStatus(); },
    async reconcileUsage(meter) {
      if (!client || !sessionId || !meter) return false;
      let failed = false;
      await meter.reconcile({
        children: async (id) => {
          try {
            const result = client.session.children
              ? await client.session.children({ sessionID: id, directory: cwd })
              : await client.session.list({ directory: cwd, roots: false, limit: 10000 });
            if (result?.error) throw result.error;
            const rows = Array.isArray(result) ? result : result?.data || [];
            return client.session.children ? rows : rows.filter((row) => row.parentID === id);
          } catch { failed = true; return []; }
        },
        messages: async (id) => {
          try {
            const result = await client.session.messages({ sessionID: id, directory: cwd });
            if (result?.error) throw result.error;
            return Array.isArray(result) ? result : result?.data || [];
          } catch { failed = true; return []; }
        },
      });
      return !failed;
    },
    // The session resumed is the conversation now: the usage meter's root follows it.
    async resume(id) { if (!id) return; sessionId = id; deps.onOpenCodeRoot?.(id); if (client) bindTranslator(); },
    async listSessions() { await start(); const rows = await client.session.list({ directory: cwd }).catch(() => null); return Array.isArray(rows?.data) ? rows.data : []; },
    isBusy() { return turnActive || pendingControls.size > 0; },
    identity() { return { providerSessionId: sessionId, providerThreadId: null, accountId: null, model: brain.model || null, effort: null, cwd, costUsd, busy: turnActive, termId }; },
    termId,
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (unsubscribe) { try { unsubscribe(); } catch {} }
      try { deps.stopIsolatedServe(termId); } catch {}
    },
  };
}
