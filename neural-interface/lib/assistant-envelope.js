// ═══════════════════════════════════════════
// SynaBun — Assistant envelope translators (Codex / OpenCode → Claude-shaped)
// ═══════════════════════════════════════════
//
// The assistant UI renders one wire format: the claude-skin envelope
// (`engine|event|control_request|control_cancelled|done|aborted|error`), where
// `event` payloads are Claude Agent SDK messages (system/init, stream_event
// deltas, assistant, user tool_result, result). The Codex and OpenCode brains
// speak their own protocols; these pure translators map them onto that shape so
// every brain looks the same to the panel. No I/O here.

import { randomUUID } from 'node:crypto';

export function synthesizeInit({ brain, sessionId = null, cwd = null, model = null, permissionMode = null } = {}) {
  return {
    type: 'system', subtype: 'init', session_id: sessionId, model, cwd, brain,
    permissionMode: permissionMode || null, tools: [], mcp_servers: [], slash_commands: [],
  };
}

function textDelta(text, index = 0) {
  return { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } };
}
function thinkingDelta(text, index = 0) {
  return { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } } };
}
function messageStart(id) {
  return { type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant', content: [] } } };
}
function messageStop() {
  return { type: 'stream_event', event: { type: 'message_stop' } };
}
function assistantMessage(blocks, id = null) {
  return { type: 'assistant', message: { id: id || `msg-${randomUUID()}`, role: 'assistant', content: blocks } };
}
function toolResult(toolUseId, content, isError = false) {
  const text = content == null ? '' : typeof content === 'string' ? content : safeJson(content);
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: !!isError }] } };
}
function safeJson(value) { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
function clip(value, max = 20_000) { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max)}…` : text; }

/** The last <proposed_plan> block of a plan-mode reply ('' without one): Codex's convention, which the OpenCode brain asks for too. */
export function proposedPlanText(text) {
  const matches = [...String(text || '').matchAll(/<proposed_plan>\s*\n?([\s\S]*?)\n?\s*<\/proposed_plan>/g)];
  return matches.at(-1)?.[1]?.trim() || '';
}

/**
 * Text of an MCP tool result: text blocks joined, image/audio blocks reduced to
 * a placeholder (a desktop screenshot would otherwise dump ~200 KB of base64
 * into the transcript). Non-MCP shapes fall back to JSON.
 */
export function mcpResultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const blocks = Array.isArray(result) ? result : Array.isArray(result.content) ? result.content : null;
  if (!blocks) return safeJson(result);
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image' || block.type === 'input_image' || block.type === 'inputImage') parts.push(`[image: ${block.mimeType || block.mime_type || block.media_type || 'image'}]`);
    else if (block.type === 'audio') parts.push(`[audio: ${block.mimeType || 'audio'}]`);
    else if (block.type === 'resource' && block.resource?.text) parts.push(String(block.resource.text));
    else if (block.type === 'resource_link' && block.uri) parts.push(`[resource: ${block.uri}]`);
  }
  if (!parts.length) return safeJson(result);
  const text = parts.join('\n');
  return result.isError ? `Error: ${text}` : text;
}

// ── Codex ────────────────────────────────────────────────────────────────────

const CODEX_TOOL_NAMES = {
  commandExecution: 'Bash',
  fileChange: 'Edit',
  webSearch: 'WebSearch',
  collabToolCall: 'Task',
};

export function codexToolUseFromItem(item = {}) {
  const type = item.type;
  if (type === 'commandExecution') return { id: item.id, name: 'Bash', input: { command: item.command || '', cwd: item.cwd || undefined } };
  if (type === 'fileChange') return { id: item.id, name: 'Edit', input: { changes: (item.changes || []).map((c) => ({ path: c.path, kind: c.kind || c.type || 'update' })) } };
  if (type === 'mcpToolCall') return { id: item.id, name: `mcp__${item.server || 'mcp'}__${item.tool || 'tool'}`, input: item.arguments ?? {} };
  if (type === 'webSearch') return { id: item.id, name: 'WebSearch', input: { query: item.query || '' } };
  if (type === 'collabToolCall') return { id: item.id, name: 'Task', input: { tool: item.tool || '', prompt: item.prompt || item.arguments || '' } };
  if (type === 'dynamicToolCall') return { id: item.id, name: item.tool || 'tool', input: item.arguments ?? {} };
  return null;
}

export function codexToolResultFromItem(item = {}) {
  const type = item.type;
  if (type === 'commandExecution') {
    const output = item.aggregatedOutput ?? item.output ?? '';
    const suffix = item.exitCode != null ? `\n[exit ${item.exitCode}]` : '';
    return { content: `${clip(output)}${suffix}`, isError: item.exitCode != null && Number(item.exitCode) !== 0 };
  }
  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const summary = changes.map((c) => `${c.kind || c.type || 'update'} ${c.path}`).join('\n');
    const output = item.aggregatedOutput ? `\n${clip(typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : safeJson(item.aggregatedOutput), 8000)}` : '';
    return { content: `${summary || 'file change'}${output}`, isError: item.status === 'failed' || item.status === 'error' };
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const content = item.error ? safeJson(item.error) : item.result != null ? mcpResultText(item.result) : (item.contentItems ? mcpResultText({ content: item.contentItems }) : '');
    return { content: clip(content), isError: !!item.error || item.status === 'failed' };
  }
  if (type === 'webSearch') return { content: clip(item.results ? safeJson(item.results) : 'search completed'), isError: false };
  if (type === 'collabToolCall') return { content: clip(item.result ? safeJson(item.result) : item.summary || 'delegation completed'), isError: item.status === 'failed' };
  return null;
}

/** Map a Codex server_request to the control_request card model the UI understands. */
export function codexControlRequestFromServerRequest(packet = {}) {
  const method = packet.method || '';
  const params = packet.params || {};
  let toolName = 'codex';
  let kind = 'permission';
  let input = params;
  if (method === 'item/commandExecution/requestApproval') { toolName = 'Bash'; input = { command: params.command, cwd: params.cwd, reason: params.reason, commandActions: params.commandActions }; }
  else if (method === 'item/fileChange/requestApproval') { toolName = 'Edit'; input = { grantRoot: params.grantRoot, itemId: params.itemId, reason: params.reason, changes: params.changes }; }
  else if (method === 'item/permissions/requestApproval') { toolName = 'Permissions'; input = { permissions: params.permissions, reason: params.reason }; }
  else if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') { toolName = 'AskUserQuestion'; kind = 'question'; input = { questions: params.questions || [] }; }
  else if (method === 'mcpServer/elicitation/request') { toolName = 'AskUserQuestion'; kind = 'elicitation'; input = { message: params.message, requestedSchema: params.requestedSchema, serverName: params.serverName, mode: params.mode }; }
  else if (method === 'item/tool/call') { toolName = params.tool || 'tool'; kind = 'tool_call'; input = params.arguments ?? params; }
  return {
    request_id: String(packet.requestId),
    request: {
      subtype: 'can_use_tool', provider: 'codex', kind, method, tool_name: toolName, input,
      // rpcId: the app-server's JSON-RPC id as sent (a number); request_id above is its string key.
      brain_native: { method, params, rpcId: packet.requestId ?? null, threadId: packet.threadId || null, turnId: packet.turnId || null, toolCallId: params.toolCallId || params.itemId || null, availableDecisions: params.availableDecisions || null },
    },
  };
}

function normalizeUserInputAnswers(answers) {
  if (!answers || typeof answers !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(answers)) {
    if (value && typeof value === 'object' && Array.isArray(value.answers)) out[key] = { answers: value.answers.map(String) };
    else if (Array.isArray(value)) out[key] = { answers: value.map(String) };
    else if (value != null && value !== '') out[key] = { answers: [String(value)] };
  }
  return out;
}

/**
 * Build the `server_request_response` body for a pending Codex request.
 * `pending` is the control_request produced above; `response` is the UI/assistant reply
 * ({ behavior:'allow'|'deny', always?, answers?, content?, message?, decision? }).
 */
export function codexControlResponse(pending, response = {}) {
  const native = pending?.request?.brain_native || {};
  const method = native.method || pending?.request?.method || '';
  const allow = response.behavior === 'allow';
  // Codex matches a reply by id value and type: 0 and "0" are different requests to it.
  const base = { requestId: native.rpcId ?? pending.request_id, responseToken: randomUUID(), threadId: native.threadId || null, turnId: native.turnId || null, toolCallId: native.toolCallId || null };
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    const available = Array.isArray(native.availableDecisions) && native.availableDecisions.length
      ? native.availableDecisions.map((d) => (typeof d === 'string' ? d : Object.keys(d)[0]))
      : ['accept', 'acceptForSession', 'decline', 'cancel'];
    let decision;
    if (response.decision && available.includes(response.decision)) decision = response.decision;
    else if (allow) decision = response.always && available.includes('acceptForSession') ? 'acceptForSession' : 'accept';
    else decision = response.cancel && available.includes('cancel') ? 'cancel' : 'decline';
    return { ...base, result: { decision } };
  }
  if (method === 'item/permissions/requestApproval') {
    return { ...base, result: allow ? { permissions: native.params?.permissions || {}, scope: 'session' } : { permissions: {}, scope: 'turn' } };
  }
  // The UI builds its reply as { behavior, result: { answers | content } } while
  // the assistant (agent_send) sends top-level answers — accept both.
  const replyAnswers = response.answers ?? response.result?.answers ?? response.updatedInput?.answers;
  if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
    if (!allow) return { ...base, error: { code: -32000, message: response.message || 'The user declined to answer.' } };
    return { ...base, result: { answers: normalizeUserInputAnswers(replyAnswers) } };
  }
  if (method === 'mcpServer/elicitation/request') {
    if (!allow) {
      const action = response.result?.action === 'decline' || response.decline === true || response.action === 'decline' ? 'decline' : 'cancel';
      return { ...base, result: { action, content: null, _meta: {} } };
    }
    const content = response.content ?? response.result?.content ?? replyAnswers ?? {};
    return { ...base, result: { action: 'accept', content: content && typeof content === 'object' ? content : {}, _meta: {} } };
  }
  if (allow) return { ...base, result: response.result || {} };
  return { ...base, error: { code: -32000, message: response.message || 'Declined by the assistant.' } };
}

/**
 * Stateful translator for one Codex brain session. `emit(packet)` receives
 * unified-envelope packets; the callbacks report thread/turn lifecycle.
 */
/** A Codex brain thread's running cost: tokenUsage.total (camelCase or snake_case) priced by `priceUsage`, else null. */
export function codexThreadCost(tokenUsage, priceUsage) {
  const total = tokenUsage?.total || null;
  if (!total || typeof priceUsage !== 'function') return null;
  const pick = (camel, snake) => Number(total[camel] ?? total[snake]) || 0;
  let cost = null;
  try {
    cost = priceUsage({
      input_tokens: pick('inputTokens', 'input_tokens'), cached_input_tokens: pick('cachedInputTokens', 'cached_input_tokens'),
      output_tokens: pick('outputTokens', 'output_tokens'), cache_write_input_tokens: pick('cacheWriteInputTokens', 'cache_write_input_tokens'),
    });
  } catch { cost = null; }
  return Number.isFinite(cost) ? cost : null;
}

export function createCodexEnvelopeTranslator({ emit, onThread = () => {}, onTurnStart = () => {}, onTurnEnd = () => {}, onUsage = () => {}, brain = {}, priceUsage = null, planTurn = () => false } = {}) {
  // Plan mode (`planTurn()`, read as a turn starts: the brain asked Codex for its
  // plan collaboration mode): the proposed plan arrives in its own `plan` item
  // (planByItem while it streams, planText once complete); `order` says whether
  // it came after the last text. The `turn/plan/updated` checklist is progress,
  // never a proposal, and a turn outside plan mode keeps its text as Codex said it.
  const state = { threadId: null, turnId: null, lastText: '', textByItem: new Map(), planTurn: false, planByItem: new Map(), planText: '', order: 0, textOrder: 0, planOrder: 0, started: false, usage: null, openTools: new Set(), announcedInit: false };
  const event = (payload) => emit({ type: 'event', event: payload });
  const startMessageIfNeeded = () => {
    if (state.started) return;
    state.started = true;
    event(messageStart(`codex-turn-${state.turnId || randomUUID()}`));
  };
  function handleNotify(method, params = {}) {
    if (method === 'turn/started') {
      state.turnId = params.turn?.id || params.turnId || state.turnId;
      state.lastText = ''; state.textByItem.clear(); state.started = false;
      state.planByItem.clear(); state.planText = ''; state.textOrder = 0; state.planOrder = 0;
      state.planTurn = planTurn() === true;
      onTurnStart(state.turnId);
      return;
    }
    if (method === 'item/plan/delta') {
      // A plan turn's proposed plan streams like text, set apart from what came before it.
      if (!state.planTurn) return;
      startMessageIfNeeded();
      const prev = state.planByItem.get(params.itemId) || '';
      const delta = String(params.delta || '');
      state.planByItem.set(params.itemId, prev + delta);
      event(textDelta(!prev && state.textByItem.size ? `\n\n${delta}` : delta));
      return;
    }
    if (method === 'item/agentMessage/delta') {
      startMessageIfNeeded();
      const delta = String(params.delta || '');
      const prev = state.textByItem.get(params.itemId) || '';
      state.textByItem.set(params.itemId, prev + delta);
      event(textDelta(delta));
      return;
    }
    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      startMessageIfNeeded();
      event(thinkingDelta(String(params.delta || '')));
      return;
    }
    if (method === 'item/started') {
      const item = params.item || {};
      const tool = codexToolUseFromItem(item);
      if (tool) {
        startMessageIfNeeded();
        state.openTools.add(tool.id);
        event(assistantMessage([{ type: 'tool_use', ...tool }], `codex-item-${tool.id}`));
      }
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage') {
        const text = typeof item.text === 'string' ? item.text : (state.textByItem.get(item.id) || '');
        if (text) { state.lastText = text; state.textOrder = ++state.order; }
        return; // full message is emitted once at turn/completed
      }
      if (item.type === 'plan') {
        const text = String(typeof item.text === 'string' ? item.text : (state.planByItem.get(item.id) || '')).trim();
        if (state.planTurn && text) { state.planText = text; state.planOrder = ++state.order; }
        return; // a plan turn's proposal joins the final message at turn/completed
      }
      if (item.type === 'reasoning') {
        const text = item.text || item.summary || (Array.isArray(item.summary) ? item.summary.join('\n') : '');
        if (text) { startMessageIfNeeded(); event(assistantMessage([{ type: 'thinking', thinking: String(text) }], `codex-item-${item.id}`)); }
        return;
      }
      if (item.type === 'contextCompaction') { event({ type: 'system', subtype: 'compact_boundary', message: 'Context compacted' }); return; }
      const result = codexToolResultFromItem(item);
      if (result) {
        if (!state.openTools.has(item.id)) {
          const tool = codexToolUseFromItem(item);
          if (tool) { startMessageIfNeeded(); event(assistantMessage([{ type: 'tool_use', ...tool }], `codex-item-${tool.id}`)); }
        }
        state.openTools.delete(item.id);
        event(toolResult(item.id, result.content, result.isError));
      }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      state.usage = params.tokenUsage || params.usage || params;
      // Metering only: its failure is the hook owner's to log, never the turn's.
      try { onUsage(state.usage); } catch {}
      return;
    }
    if (method === 'turn/completed') {
      const turn = params.turn || {};
      const failed = turn.status === 'failed' || turn.status === 'error';
      // A plan turn: its plan item joins the final text (in the order they came); tags never show.
      // Any other turn ends with exactly what Codex said.
      const said = state.planTurn ? String(state.lastText || '').replace(/<\/?proposed_plan>/g, '').trim() : state.lastText;
      const planned = state.planTurn ? state.planText || [...state.planByItem.values()].at(-1)?.trim() || '' : '';
      const text = planned && !said.includes(planned)
        ? (state.planOrder && state.planOrder < state.textOrder ? [planned, said] : [said, planned]).filter(Boolean).join('\n\n')
        : said;
      const plan = state.planTurn ? planned || proposedPlanText(state.lastText) : '';
      if (state.started) event(messageStop());
      if (text) event(assistantMessage([{ type: 'text', text }], `codex-final-${state.turnId || randomUUID()}`));
      const usage = turn.usage || state.usage || null;
      const failure = failed ? (turn.error?.message || (typeof turn.error === 'string' ? turn.error : null) || 'Codex turn failed') : null;
      if (failure) emit({ type: 'error', message: failure });
      // Codex reports tokens, not dollars: the thread's running token total is
      // priced at list price (estimated); null when the model has no price.
      const cost = codexThreadCost(state.usage, priceUsage);
      event({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', result: text, plan: plan || undefined, usage, total_cost_usd: cost, cost_basis: cost === null ? 'unpriced' : 'estimated', brain: 'codex', num_turns: 1, duration_ms: null, error: failure || undefined });
      emit({ type: 'done', code: failed ? 1 : 0 });
      onTurnEnd({ status: failed ? 'failed' : 'completed', text, usage });
      state.started = false;
      return;
    }
    if (method === 'thread/name/updated') { event({ type: 'system', subtype: 'thread_title', title: params.name || params.title || '' }); return; }
    if (method === 'turn/plan/updated') { return; }
    if (method === 'mcpServer/startupStatus/updated') { event({ type: 'system', subtype: 'mcp_status', servers: [params] }); }
  }
  return {
    state,
    handle(packet = {}) {
      switch (packet.type) {
        case 'ready':
          state.threadId = packet.threadId || state.threadId;
          onThread(state.threadId);
          if (!state.announcedInit) { state.announcedInit = true; event(synthesizeInit({ brain: 'codex', sessionId: state.threadId, cwd: brain.cwd || null, model: brain.model || null })); }
          return true;
        case 'notify':
          if (packet.threadId && !state.threadId) { state.threadId = packet.threadId; onThread(state.threadId); }
          handleNotify(packet.method, packet.params || {});
          return true;
        case 'turn':
          state.turnId = packet.turn?.id || state.turnId;
          return true;
        case 'server_request':
          if (packet.resolved) return true;
          emit({ type: 'control_request', ...codexControlRequestFromServerRequest(packet) });
          return true;
        case 'server_request_response_result':
          if (packet.ok === false) emit({ type: 'error', message: packet.error || 'Codex rejected the reply', requestId: packet.requestId });
          return true;
        case 'interrupt_ack':
          if (state.started) event(messageStop());
          state.started = false;
          emit({ type: 'aborted' });
          onTurnEnd({ status: 'aborted', text: state.lastText, usage: state.usage });
          return true;
        case 'error':
          emit({ type: 'error', message: packet.message || 'Codex error', requestId: packet.requestId || null });
          return true;
        case 'mcp_status':
          event({ type: 'system', subtype: 'mcp_status', servers: packet.servers || packet.status || [] });
          return true;
        case 'thread_loaded_list':
        case 'history':
        case 'status_snapshot':
        case 'capabilities':
        case 'model_list':
        case 'rate_limits':
        case 'account_info':
        case 'account_list':
        case 'reattach_result':
        case 'turn_steered':
        case 'config_data':
        case 'config_requirements':
        case 'experimental_features':
        case 'skills_list':
        case 'app_list':
        case 'catalogs_changed':
        case 'closed':
          return false;
        default:
          return false;
      }
    },
  };
}

// ── OpenCode ─────────────────────────────────────────────────────────────────

export function opencodeControlRequestFromEvent(eventType, event = {}) {
  if (/permission\.asked/i.test(eventType)) {
    const id = String(event.id || event.requestID || event.permissionID || randomUUID());
    return {
      request_id: id,
      request: {
        subtype: 'can_use_tool', provider: 'opencode', kind: 'permission',
        tool_name: event.permission || event.type || 'permission',
        input: { title: event.title || null, patterns: event.patterns || [], metadata: event.metadata || {}, always: event.always || null },
        brain_native: { requestID: id, kind: 'permission', sessionID: event.sessionID || null },
      },
    };
  }
  if (/question\.asked/i.test(eventType)) {
    const id = String(event.id || event.requestID || randomUUID());
    return {
      request_id: id,
      request: {
        subtype: 'can_use_tool', provider: 'opencode', kind: 'question', tool_name: 'AskUserQuestion',
        input: { questions: Array.isArray(event.questions) ? event.questions : [] },
        brain_native: { requestID: id, kind: 'question', sessionID: event.sessionID || null },
      },
    };
  }
  return null;
}

/** Reply payload for the OpenCode SDK from a UI/assistant response. */
export function opencodeControlResponse(pending, response = {}) {
  const native = pending?.request?.brain_native || {};
  const allow = response.behavior === 'allow';
  if (native.kind === 'question') {
    if (!allow) return { kind: 'question', requestID: native.requestID, reject: true };
    let answers = response.answers ?? response.updatedInput?.answers ?? [];
    if (answers && !Array.isArray(answers) && typeof answers === 'object') {
      const questions = pending.request?.input?.questions || [];
      answers = questions.length
        ? questions.map((q, index) => { const v = answers[q.question] ?? answers[q.header] ?? answers[q.id] ?? answers[String(index)]; return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]; })
        : Object.values(answers).map((v) => (Array.isArray(v) ? v.map(String) : [String(v)]));
    }
    return { kind: 'question', requestID: native.requestID, answers };
  }
  const explicit = ['once', 'always', 'reject'].includes(response.reply) ? response.reply : null;
  if (explicit) return { kind: 'permission', requestID: native.requestID, reply: explicit };
  return { kind: 'permission', requestID: native.requestID, reply: allow ? (response.always ? 'always' : 'once') : 'reject' };
}

/**
 * Stateful translator for one OpenCode brain session: SSE events → envelope.
 * Only events for `sessionId` are considered.
 */
// `planTurn()`: the current turn runs in plan mode with the proposal
// instructions (assistant-brains/opencode.js): its <proposed_plan> block is the
// plan (`result.plan`), and the tags never show, streamed or final.
export function createOpenCodeEnvelopeTranslator({ sessionId, emit, onTurnEnd = () => {}, onUsageEvent = () => {}, brain = {}, planTurn = () => false } = {}) {
  // costUsd is the session's running total: OpenCode reports cost per assistant
  // message, so costs are summed by message id (the runtime takes deltas).
  const state = { sessionId, roles: new Map(), order: [], textParts: new Map(), reasoningParts: new Map(), tools: new Map(), started: false, announcedInit: false, lastText: '', costUsd: 0, costByMessage: new Map(), usage: null };
  const event = (payload) => emit({ type: 'event', event: payload });
  const belongs = (ev) => {
    const sid = ev?.sessionID || ev?.sessionId || ev?.part?.sessionID || ev?.info?.sessionID || ev?.info?.id || ev?.session?.id || null;
    return !sid || sid === sessionId;
  };
  const startIfNeeded = () => { if (state.started) return; state.started = true; event(messageStart(`opencode-turn-${randomUUID()}`)); };
  // A plan turn's tags never stream either: a trailing "<…" that could still
  // become one waits for its part's next delta, and goes out as it is once that
  // part stops (another part streams) or the turn ends.
  const held = { key: '', text: '' };
  const flushHeld = () => {
    if (held.text) { startIfNeeded(); event(textDelta(held.text)); }
    held.key = ''; held.text = '';
  };
  function planTextDelta(key, delta) {
    if (held.key !== key) flushHeld();
    const text = `${held.text}${delta}`.replace(/<\/?proposed_plan>/g, '');
    const at = text.lastIndexOf('<');
    const cut = at !== -1 && ['<proposed_plan>', '</proposed_plan>'].some((tag) => tag.startsWith(text.slice(at))) ? at : text.length;
    held.key = key; held.text = text.slice(cut);
    return text.slice(0, cut);
  }
  const latestAssistantText = () => {
    for (let i = state.order.length - 1; i >= 0; i--) {
      const id = state.order[i];
      if (state.roles.get(id) === 'user') continue;
      const parts = state.textParts.get(id);
      const text = parts ? [...parts.values()].join('\n').trim() : '';
      if (text) return text;
    }
    return '';
  };
  function handlePart(part = {}) {
    if (!part.messageID) return;
    if (state.roles.get(part.messageID) === 'user') return;
    if (part.type === 'text' && typeof part.text === 'string') {
      let parts = state.textParts.get(part.messageID);
      if (!parts) { parts = new Map(); state.textParts.set(part.messageID, parts); }
      const key = part.id || `${parts.size}`;
      const prev = parts.get(key) || '';
      const next = part.text;
      parts.set(key, next);
      const delta = next.startsWith(prev) ? next.slice(prev.length) : next;
      const shown = delta && planTurn() === true ? planTextDelta(`${part.messageID}:${key}`, delta) : delta;
      if (shown) { startIfNeeded(); event(textDelta(shown)); }
      return;
    }
    if (part.type === 'reasoning' && typeof part.text === 'string') {
      const key = `${part.messageID}:${part.id || 'r'}`;
      const prev = state.reasoningParts.get(key) || '';
      state.reasoningParts.set(key, part.text);
      const delta = part.text.startsWith(prev) ? part.text.slice(prev.length) : part.text;
      if (delta) { startIfNeeded(); event(thinkingDelta(delta)); }
      return;
    }
    if (part.type === 'tool') {
      const id = part.callID || part.id;
      const status = part.state?.status || 'pending';
      const known = state.tools.get(id);
      if (!known) {
        state.tools.set(id, { status });
        startIfNeeded();
        event(assistantMessage([{ type: 'tool_use', id, name: part.tool || 'tool', input: part.state?.input ?? {} }], `opencode-tool-${id}`));
      }
      if ((status === 'completed' || status === 'error') && known?.status !== status) {
        state.tools.set(id, { status });
        const output = status === 'error' ? (part.state?.error || 'tool error') : (part.state?.output ?? part.state?.title ?? '');
        event(toolResult(id, clip(typeof output === 'string' ? output : safeJson(output)), status === 'error'));
      }
    }
  }
  return {
    state,
    handle(eventType, ev = {}) {
      // Metering only (child sessions too, before the filter): a throw here must not drop the event.
      if (/^(?:message|session)[.:](?:updated|created)$/i.test(eventType)) { try { onUsageEvent(eventType, ev); } catch {} }
      if (!belongs(ev)) return false;
      if (!state.announcedInit) { state.announcedInit = true; event(synthesizeInit({ brain: 'opencode', sessionId, cwd: brain.cwd || null, model: brain.model || null })); }
      if (/^message[.:]updated$/i.test(eventType)) {
        const info = ev.info || ev.message?.info || {};
        if (info.id) {
          if (!state.roles.has(info.id)) state.order.push(info.id);
          state.roles.set(info.id, info.role || state.roles.get(info.id) || null);
          if (info.role === 'assistant') {
            if (Number.isFinite(Number(info.cost))) {
              state.costByMessage.set(info.id, Number(info.cost));
              let total = 0;
              for (const value of state.costByMessage.values()) total += value;
              state.costUsd = Number(total.toFixed(6));
            }
            if (info.tokens) state.usage = info.tokens;
          }
        }
        return true;
      }
      if (/^message[.:]part[.:]updated$/i.test(eventType)) { handlePart(ev.part || {}); return true; }
      if (/^session[.:]idle$/i.test(eventType)) {
        if (state.errored) { state.errored = false; state.started = false; return true; } // error already closed this turn
        const said = latestAssistantText();
        const planning = planTurn() === true;
        const text = planning ? said.replace(/<\/?proposed_plan>/g, '').trim() : said;
        const plan = planning ? proposedPlanText(said) : '';
        state.lastText = text;
        flushHeld();
        if (state.started) event(messageStop());
        if (text) event(assistantMessage([{ type: 'text', text }], `opencode-final-${randomUUID()}`));
        event({ type: 'result', subtype: 'success', result: text, plan: plan || undefined, usage: state.usage, total_cost_usd: state.costUsd || null, brain: 'opencode', num_turns: 1 });
        emit({ type: 'done', code: 0 });
        onTurnEnd({ status: 'completed', text, costUsd: state.costUsd, usage: state.usage });
        state.started = false;
        return true;
      }
      if (/^session[.:]error$/i.test(eventType)) {
        const message = ev.error?.message || ev.error?.data?.message || (typeof ev.error === 'string' ? ev.error : 'OpenCode session error');
        flushHeld();
        if (state.started) event(messageStop());
        state.errored = true;
        emit({ type: 'error', message });
        emit({ type: 'done', code: 1 });
        onTurnEnd({ status: 'failed', text: latestAssistantText(), error: message });
        state.started = false;
        return true;
      }
      const control = opencodeControlRequestFromEvent(eventType, ev);
      if (control) { emit({ type: 'control_request', ...control }); return true; }
      if (/^session[.:]updated$/i.test(eventType) && ev.info?.title) { event({ type: 'system', subtype: 'thread_title', title: ev.info.title }); return true; }
      return false;
    },
  };
}
