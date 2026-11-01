// ═══════════════════════════════════════════
// SynaBun — Assistant brain: Google Antigravity (`agy acp`, in the brain's own Antigravity home)
// ═══════════════════════════════════════════
//
// One `agy acp` process and one ACP session per Assistant session (lib/antigravity/acp-connection.js), started in
// the brain's own Antigravity home (lib/antigravity/home.js: `--gemini-dir`): SynaBun's MCP server (its child gets
// the assistant role, the session pin, the desktop grant and the brain's credential from the agent's environment)
// beside the user's own servers, the user's global rules and skills, and the policy hook that asks this process
// about every tool call before it runs (lib/antigravity/policy.js → deps.policyCheck: the browser policy, plan mode,
// a remote session's read-only rules and the route gate; a refusal reaches the model with its reason and the turn
// goes on). The persona rides as the session's appended system prompt (_meta.antigravity.systemPrompt.append, which
// agy advertises in initialize). ACP session/update notifications become the unified envelope
// (assistant-envelope.js createAcpEnvelopeTranslator); a permission request the approval mode does not answer
// becomes a card (control_request), answered once (never "always": Antigravity would save it for later sessions).
// The model and the thinking level are the session's config options, switched per turn; images ride as ACP image
// blocks; Stop is session/cancel; a resumed conversation is session/resume (no replay) in the same home.

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acpErrorInfo, createAcpConnection, isAuthRequired } from '../antigravity/acp-connection.js';
import { assertSafeAntigravityProject, antigravityHomeReadPolicy, antigravityHomeSettings, homeMcpTools, policyHookCommand, prepareAntigravityHome, toAntigravityMcpEntry, userAntigravityMcpServers, userAntigravitySettings, userGeminiDir } from '../antigravity/home.js';
import { acpCall, acpReadOnlyKind, acpToolPaths, acpUiToolName } from '../antigravity/tool-call.js';
import { splitAntigravityModel } from '../antigravity/catalog.js';
import { acpTurnUsage } from '../antigravity/usage.js';
import { createAcpEnvelopeTranslator } from '../assistant-envelope.js';
import { planModeInstructions } from '../assistant-persona.js';

/** The hook script of every SynaBun Antigravity home. */
export const ANTIGRAVITY_BRAIN_POLICY_HOOK = fileURLToPath(new URL('../antigravity/policy-hook.mjs', import.meta.url));
const CANCEL_GRACE_MS = 8_000;
const MCP_WATCH_MS = 120_000;
const LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** The Assistant's Antigravity approval mode: 'auto' (every call the policy allows runs) or 'default' (cards). */
export function antigravityApprovalMode(mode) {
  return mode === 'auto' || mode === 'acceptEdits' || mode === 'bypassPermissions' ? 'auto' : 'default';
}

/** Composer images ({ base64 | data, mediaType }) → ACP image blocks. */
export function acpImageBlocks(images = []) {
  const blocks = [];
  for (const image of Array.isArray(images) ? images : []) {
    let data = image?.base64 || image?.data || null;
    let mimeType = image?.mediaType || image?.media_type || image?.mime || image?.mimeType || 'image/png';
    if (!data || typeof data !== 'string') continue;
    const inline = /^data:([^;,]+);base64,(.*)$/s.exec(data);
    if (inline) { mimeType = inline[1]; data = inline[2]; }
    blocks.push({ type: 'image', mimeType, data });
  }
  return blocks;
}

/** The ACP permission option for an answer: explicit kinds only, never allow-always. */
function permissionOption(options, wanted) {
  const list = Array.isArray(options) ? options.filter((option) => option && typeof option.optionId === 'string') : [];
  for (const kind of wanted) {
    if (kind === 'allow_always') continue;
    const found = list.find((option) => option.kind === kind);
    if (found) return found.optionId;
  }
  return null;
}

/**
 * The MCP servers of a brain's home: SynaBun's own entry, then every enabled server of the user's own Antigravity
 * configuration (a brain keeps the user's servers, as a Claude brain keeps the user's settings).
 */
export function antigravityBrainServers({ synabunMcpEntry = null, userGemini = userGeminiDir() } = {}) {
  const servers = {};
  const user = userAntigravityMcpServers(userGemini);
  const own = synabunMcpEntry || user.SynaBun || null;
  if (own) servers.SynaBun = toAntigravityMcpEntry(own);
  for (const [name, entry] of Object.entries(user)) {
    if (name === 'SynaBun' || entry?.disabled === true) continue;
    servers[name] = toAntigravityMcpEntry(entry);
  }
  return servers;
}

export function createAntigravityBrain({ session, sink, deps = {}, persona = '' } = {}) {
  if (typeof deps.antigravityLaunch !== 'function') throw new Error('Antigravity brain requires deps.antigravityLaunch');
  const brain = session.brain || {};
  const cwd = brain.cwd || deps.PACKAGE_ROOT || process.cwd();
  const connect = typeof deps.connect === 'function' ? deps.connect : createAcpConnection;
  const homeDir = typeof deps.antigravityHome === 'function' ? deps.antigravityHome(session.id) : null;
  const userGemini = deps.userGemini || userGeminiDir();
  const remoteReadOnly = deps.remoteReadOnly === true;
  let approvalMode = antigravityApprovalMode(brain.permissionMode);
  let planMode = brain.planMode === true || brain.permissionMode === 'plan';
  let conn = null;
  let sessionId = session.providerSessionId || null;
  let resumeWanted = !!sessionId;
  let registration = null;
  let configOptions = [];
  let turn = null; // { planned, cancelled, cancelTimer, model }
  let lastSessionUsage = deps.sessionUsageBase && typeof deps.sessionUsageBase === 'object' ? deps.sessionUsageBase : null;
  let startPromise = null;
  let disposed = false;
  let mcpTimer = null;
  let mcpReported = null;
  let replaying = false;
  const pendingControls = new Map(); // requestId → { resolve, options }

  const emit = (packet) => { if (!disposed) sink.send(packet); };
  const note = (text) => emit({ type: 'stderr', text });
  const optionOf = (category) => configOptions.find((o) => o?.category === category || o?.id === category) || null;
  const valuesOf = (option) => {
    const out = [];
    for (const entry of option?.options || []) for (const v of Array.isArray(entry?.options) ? entry.options : [entry]) if (v && v.value !== undefined) out.push(String(v.value));
    return out;
  };
  const currentValue = (category) => { const option = optionOf(category); return option?.currentValue !== undefined && option?.currentValue !== null ? String(option.currentValue) : null; };

  const translator = createAcpEnvelopeTranslator({
    emit,
    brain: { cwd, sessionId: () => sessionId, model: () => currentValue('model') || brain.model || null },
    planTurn: () => turn?.planned === true,
  });
  emit({ type: 'engine', engine: 'antigravity', brain: 'antigravity' });

  function applyModes(mode, plan) {
    if (mode === 'plan') planMode = true;
    else if (mode) approvalMode = antigravityApprovalMode(mode);
    if (typeof plan === 'boolean') planMode = plan;
  }

  /**
   * The policy hook's question for this brain: first the runtime's checks (deps.policyCheck: browser policy, plan mode, remote read-only, route gate); then the approval
   * mode: auto lets every call run, default lets reads and SynaBun's own tools run and asks about the rest.
   */
  function policyCheck(call) {
    let verdict = null;
    try { verdict = typeof deps.policyCheck === 'function' ? deps.policyCheck(call) : null; } catch (error) { return { decision: 'deny', reason: `SynaBun could not check this call (${error?.message || error}).` }; }
    if (verdict?.decision === 'deny') return verdict;
    const homeRead = antigravityHomeReadPolicy(call, { homeDir, cwd });
    if (homeRead) return homeRead;
    if (remoteReadOnly || approvalMode === 'auto') return { decision: 'allow' };
    if (acpReadOnlyKind(call.kind)) return { decision: 'allow' };
    if (call.mcp?.server === 'SynaBun') return { decision: 'allow' };
    return { decision: 'ask' };
  }

  function cancelControls(reason = 'turn_ended') {
    for (const [requestId, pending] of pendingControls) {
      pendingControls.delete(requestId);
      emit({ type: 'control_cancelled', request_id: requestId, reason });
      try { pending.resolve({ outcome: { outcome: 'cancelled' } }); } catch { /* answered */ }
    }
  }

  async function onPermission(params, { signal } = {}) {
    if (disposed) return { outcome: { outcome: 'cancelled' } };
    const call = acpCall(params);
    const options = params?.options || [];
    const pick = (kinds) => {
      const optionId = permissionOption(options, kinds);
      return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
    };
    const verdict = policyCheck(call);
    // The hook asked first; a refusal reaching here (a call the hook never saw) ends the turn, as a user's would.
    if (verdict.decision === 'deny') return pick(['reject_once', 'reject_always']);
    if (verdict.decision === 'allow') return pick(['allow_once']);
    const requestId = `agy-${randomUUID()}`;
    const packet = {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool', provider: 'antigravity', kind: 'permission',
        tool_name: acpUiToolName(call),
        input: call.mcp ? { ...call.mcp.args } : { ...call.args, ...(call.command ? { command: call.command } : {}) },
        title: call.title || null,
        brain_native: { kind: 'permission', toolCallId: call.id, sessionId: params?.sessionId || sessionId, toolCall: params?.toolCall || null },
      },
    };
    return new Promise((resolveAnswer) => {
      pendingControls.set(requestId, { resolve: resolveAnswer, options });
      signal?.addEventListener?.('abort', () => {
        if (!pendingControls.delete(requestId)) return;
        emit({ type: 'control_cancelled', request_id: requestId, reason: 'withdrawn' });
        resolveAnswer({ outcome: { outcome: 'cancelled' } });
      }, { once: true });
      emit(packet);
    });
  }

  function reportMcp() {
    if (!homeDir) return null;
    const tools = homeMcpTools(homeDir, 'SynaBun');
    const status = tools.length ? 'connected' : null;
    if (status && mcpReported !== status) {
      mcpReported = status;
      emit({ type: 'event', event: { type: 'system', subtype: 'mcp_status', servers: [{ name: 'SynaBun', status, tools: tools.length }] } });
    }
    return status;
  }
  function watchMcp() {
    if (!homeDir || mcpTimer) return;
    const until = Date.now() + MCP_WATCH_MS;
    mcpTimer = setInterval(() => {
      if (disposed || reportMcp() || Date.now() > until) { clearInterval(mcpTimer); mcpTimer = null; }
    }, 1000);
    mcpTimer.unref?.();
  }

  async function openSession() {
    const meta = persona ? { antigravity: { systemPrompt: { append: persona } } } : undefined;
    const init = await conn.initialize();
    let answer = null;
    if (sessionId && resumeWanted) {
      const caps = init?.agentCapabilities?.sessionCapabilities || {};
      // agy 1.4.12 sends the conversation's history again while it resumes (session/resume as session/load): the
      // panel has it already, so nothing that arrives before the answer is shown.
      replaying = true;
      try {
        answer = await conn.request(caps.resume ? 'session/resume' : 'session/load', { sessionId, cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) });
        sessionId = String(answer?.sessionId || sessionId);
      } catch (error) {
        if (isAuthRequired(error)) throw error;
        note(`Antigravity could not resume its conversation (${acpErrorInfo(error).message}); this brain starts a new one.`);
        answer = null;
        sessionId = null;
      } finally {
        replaying = false;
      }
    }
    if (!answer) {
      answer = await conn.request('session/new', { cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) });
      sessionId = String(answer?.sessionId || '');
      if (!sessionId) throw new Error('Antigravity did not return a session id');
      lastSessionUsage = null;
    }
    resumeWanted = false;
    configOptions = Array.isArray(answer?.configOptions) ? answer.configOptions : [];
    try { deps.onAntigravitySession?.(sessionId); } catch { /* bookkeeping */ }
    reportMcp();
    watchMcp();
  }

  async function boot() {
    if (disposed) throw new Error('Antigravity brain disposed');
    const launch = deps.antigravityLaunch();
    if (!launch?.command) throw new Error('The Antigravity CLI (agy) is not installed. Install it from the Antigravity side panel, sign in there, then try again — or switch the Assistant to another provider.');
    assertSafeAntigravityProject(cwd);
    let hookCommand = null;
    if (homeDir) {
      if (deps.policy?.register && deps.policyUrl) hookCommand = policyHookCommand({ script: deps.policyHookScript || ANTIGRAVITY_BRAIN_POLICY_HOOK });
      prepareAntigravityHome({
        dir: homeDir,
        mcpServers: antigravityBrainServers({ synabunMcpEntry: typeof deps.synabunMcpEntry === 'function' ? deps.synabunMcpEntry() : deps.synabunMcpEntry, userGemini }),
        hookCommand,
        settings: antigravityHomeSettings({ userSettings: userAntigravitySettings(userGemini) }),
        userGemini,
      });
    }
    if (hookCommand) registration = deps.policy.register((call) => (disposed ? { decision: 'deny', reason: 'This Assistant session ended.' } : policyCheck(call)), { label: `brain ${session.id}` });
    const base = typeof deps.childEnv === 'function' ? deps.childEnv() : { ...process.env };
    for (const key of ['SYNABUN_TOOLS', 'SYNABUN_TOOLS_PATH', 'SYNABUN_PROFILE', 'SYNABUN_RUNTIME_PROFILE_PATH', 'SYNABUN_TOOL_CATALOG_MODE', 'SYNABUN_AGY_POLICY_URL', 'SYNABUN_AGY_POLICY_TOKEN', 'SYNABUN_BROWSER_SESSION', 'SYNABUN_BROWSER_TAB']) delete base[key];
    const env = {
      ...base,
      // The brain's SynaBun MCP child (stdio) reads who it serves from here (mcp-server/src/services/identity.ts).
      SYNABUN_ROLE: 'assistant',
      SYNABUN_TERMINAL_SESSION: String(session.id),
      ...(deps.desktopGrant ? { SYNABUN_DESKTOP_GRANT: String(deps.desktopGrant) } : {}),
      ...(deps.brainCredential ? { SYNABUN_BRAIN_TOKEN: String(deps.brainCredential) } : {}),
      ...(registration ? { SYNABUN_AGY_POLICY_URL: deps.policyUrl, SYNABUN_AGY_POLICY_TOKEN: registration.token } : {}),
    };
    conn = connect({
      command: launch.command,
      args: launch.args || [],
      acpArgs: homeDir ? ['--gemini-dir', homeDir] : [],
      cwd,
      env,
      clientInfo: { name: 'synabun', title: 'SynaBun Assistant', version: '0' },
      onUpdate: (params) => {
        if (disposed || replaying || !params?.update || !sessionId || params.sessionId !== sessionId) return;
        // Between turns only titles and the like count: a stray message of a turn that already ended is not shown.
        if (!turn && params.update.sessionUpdate !== 'session_info_update') return;
        translator.handle(params.update);
      },
      onPermission,
      onExit: (info) => {
        if (disposed) return;
        cancelControls('agent_exited');
        const why = info?.error || (info?.signal ? `signal ${info.signal}` : `code ${info?.code}`);
        if (turn) finishTurn(null, new Error(`Antigravity exited (${why})${info?.stderr ? `: ${String(info.stderr).trim().split('\n').slice(-2).join(' ')}` : ''}`));
        else note(`Antigravity exited (${why}); the next message starts it again.`);
        conn = null;
        startPromise = null;
        resumeWanted = !!sessionId;
      },
    });
    try {
      await openSession();
    } catch (error) {
      const auth = isAuthRequired(error);
      const message = auth ? 'Antigravity is not signed in: open the Antigravity panel (or run `agy` in a terminal) and sign in, then try again.' : `Antigravity could not start: ${acpErrorInfo(error).message}`;
      registration?.dispose();
      registration = null;
      try { await conn?.close(); } catch { /* gone */ }
      conn = null;
      startPromise = null;
      throw Object.assign(new Error(message), { code: auth ? 'AUTH_REQUIRED' : 'START_FAILED' });
    }
    return true;
  }
  function start() {
    if (!startPromise) startPromise = boot();
    return startPromise;
  }

  async function setOption(category, value, label) {
    const option = optionOf(category);
    if (!value || !option) return;
    if (String(option.currentValue) === String(value)) return;
    const accepted = valuesOf(option);
    if (accepted.length && !accepted.includes(String(value))) { note(`Antigravity offers no ${label} "${value}" here; it keeps ${option.currentValue}.`); return; }
    try {
      const answer = await conn.request('session/set_config_option', { sessionId, configId: option.id, value: String(value) });
      if (Array.isArray(answer?.configOptions)) configOptions = answer.configOptions;
    } catch (error) { note(`Antigravity kept its ${label} (${acpErrorInfo(error).message}).`); }
  }
  /** The turn's model and thinking level (the record may have changed since the session started; a routed turn names its own). */
  async function applyModel(model, effort) {
    const wanted = splitAntigravityModel(model, valuesOf(optionOf('model')));
    if (wanted.model) await setOption('model', wanted.model, 'model');
    const level = effort && LEVELS.has(String(effort).toLowerCase()) ? String(effort).toLowerCase() : wanted.effort;
    if (level) await setOption('thought_level', level, 'thinking level');
  }

  function finishTurn(answer, error = null) {
    const current = turn;
    if (!current) return;
    turn = null;
    if (current.cancelTimer) clearTimeout(current.cancelTimer);
    cancelControls('turn_ended');
    const usage = answer?.usage ? acpTurnUsage(answer.usage, lastSessionUsage) : null;
    if (answer?.usage) {
      lastSessionUsage = answer.usage;
      try { deps.onAntigravitySessionUsage?.(sessionId, answer.usage); } catch { /* bookkeeping */ }
    }
    if (usage) { try { deps.onAntigravityUsage?.({ usage, model: currentValue('model') || brain.model || null, sessionId }); } catch { /* metering never breaks a turn */ } }
    const stopReason = current.cancelled ? 'cancelled' : (answer?.stopReason || 'end_turn');
    translator.endTurn({ stopReason, usage, error: error && !current.cancelled ? (error.message || String(error)) : null, planned: current.planned === true });
  }

  async function runPrompt(blocks, { planned = false } = {}) {
    translator.reset();
    turn = { planned, cancelled: false, cancelTimer: null };
    const mine = turn;
    conn.request('session/prompt', { sessionId, prompt: blocks }, { timeoutMs: 0 })
      .then((answer) => { if (turn === mine) finishTurn(answer); })
      .catch((error) => { if (turn === mine) finishTurn(null, new Error(acpErrorInfo(error).message)); });
  }

  return {
    kind: 'antigravity',
    start,
    async sendUserTurn({ text, images = [], model = null, effort = null, permissionMode: mode = null, planMode: plan = null } = {}) {
      await start();
      if (disposed || !conn) return false;
      if (turn) throw new Error('Antigravity is still answering the last message');
      applyModes(mode, plan);
      if (resumeWanted && sessionId) await openSession();
      await applyModel(model || brain.model || null, effort || brain.effort || null);
      // A plan turn carries what plan mode means here (a remote session's read-only brain does not).
      const planned = planMode && !remoteReadOnly;
      const body = planned ? `<system-reminder>\n${planModeInstructions({ provider: 'antigravity' })}\n</system-reminder>\n\n${String(text ?? '')}` : String(text ?? '');
      await runPrompt([{ type: 'text', text: body }, ...acpImageBlocks(images)], { planned });
      return true;
    },
    async abort() {
      if (!turn) { cancelControls('stopped'); return; }
      const current = turn;
      current.cancelled = true;
      cancelControls('stopped');
      try { if (conn && sessionId) await conn.notify('session/cancel', { sessionId }); } catch { /* the answer or the grace timer ends it */ }
      // An agent that never answers the cancelled prompt: the turn ends here anyway.
      current.cancelTimer = setTimeout(() => { if (turn === current) finishTurn(null); }, CANCEL_GRACE_MS);
      current.cancelTimer.unref?.();
    },
    async setPermissionMode(mode, { planMode: plan = null } = {}) { applyModes(mode, plan); emit({ type: 'mode_changed', mode: approvalMode, planMode }); },
    respondControl(requestId, response = {}) {
      const pending = pendingControls.get(String(requestId));
      if (!pending) { emit({ type: 'error', message: `No pending Antigravity request ${requestId}` }); return; }
      pendingControls.delete(String(requestId));
      // Once, whatever the answer says about "always": Antigravity would save it for every later session.
      const allow = response?.behavior === 'allow';
      const optionId = permissionOption(pending.options, allow ? ['allow_once'] : ['reject_once', 'reject_always']);
      pending.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    },
    // Antigravity's own /compact command, as a turn of its own (busy until it ends).
    async compact() {
      await start();
      if (disposed || !conn || turn) return;
      await runPrompt([{ type: 'text', text: '/compact' }]);
    },
    async mcpStatus() { if (!reportMcp()) emit({ type: 'event', event: { type: 'system', subtype: 'mcp_status', servers: [] } }); },
    // The conversation to pick up: resumed before the next message (session/resume in the brain's home).
    async resume(id) { if (!id) return; sessionId = String(id); resumeWanted = true; lastSessionUsage = null; },
    async listSessions() { return []; },
    isBusy() { return !!turn || pendingControls.size > 0; },
    // The route gate: its hook checks every call before it runs; without one (no policy wired) the runtime checks
    // the tool starts it sees (the reactive fallback).
    get gateMode() { return registration ? 'hook' : 'reactive'; },
    identity() {
      return { providerSessionId: sessionId, providerThreadId: null, accountId: null, model: currentValue('model') || brain.model || null, effort: currentValue('thought_level') || brain.effort || null, cwd, busy: !!turn, home: homeDir };
    },
    async dispose() {
      if (disposed) return;
      const wasRunning = !!turn;
      cancelControls('brain_disposed');
      if (wasRunning && conn && sessionId) { try { await conn.notify('session/cancel', { sessionId }); } catch { /* closing anyway */ } }
      disposed = true;
      if (mcpTimer) { clearInterval(mcpTimer); mcpTimer = null; }
      if (turn?.cancelTimer) clearTimeout(turn.cancelTimer);
      turn = null;
      registration?.dispose();
      registration = null;
      try { await conn?.close(); } catch { /* gone */ }
      conn = null;
    },
  };
}
