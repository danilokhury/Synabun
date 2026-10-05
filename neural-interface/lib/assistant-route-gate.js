// ═══════════════════════════════════════════
// SynaBun — Assistant route gate (route before working, per turn)
// ═══════════════════════════════════════════
//
// Every brain turn starts unrouted. Until agent_route answers in that turn,
// every tool call outside the exempt set is refused before it runs, and the
// refusal tells the model what to do instead; the turn goes on so it can route.
// One module for every host: the Claude PreToolUse hook, the OpenCode plugin
// (opencode-route-gate.js), the Codex PreToolUse hook (codex-route-gate-hook.mjs)
// and the reactive fallback all ask the same gate.
//
//   unrouted  turn start: exempt tools only
//   open      agent_route approved kind "direct" with no continuation: every tool, for the rest of the turn
//   held      approved dispatch / pending / continuation / declined / expired, or a "chat" route,
//             or questions to the user still open (agent_clarify pending, agent_route "clarifying"):
//             exempt tools only, and the refusal names the next step
//   failed    agent_route itself errored (router or catalog failure): open for the rest of the turn
//
// Another agent_route call in the same turn re-evaluates the state. After
// ROUTE_GATE_MAX_REFUSALS refusals in one turn the caller aborts the turn.
// A brain that cannot reach agent_route at all (its SynaBun MCP server failed,
// or it lacks the assistant role) is marked unavailable and not gated.

export const ROUTE_GATE_MAX_REFUSALS = 8;

/** Always allowed, matched by base name (lower case) whatever the host prefix. */
export const ROUTE_GATE_EXEMPT = Object.freeze([
  // Memory
  'recall', 'remember', 'reflect', 'memories', 'forget', 'restore', 'category', 'sync',
  // Orchestration (agent_dispatch is gated by the router and the clarifier itself)
  'agent_route', 'agent_clarify', 'agent_catalog', 'agent_list', 'agent_status', 'agent_read', 'agent_send', 'agent_wait', 'agent_stop', 'agent_focus', 'agent_usage', 'agent_dispatch',
  // Asking the user (OpenCode's own tool is `question`)
  'AskUserQuestion', 'choice', 'question',
  // Profile, the images the user attached, the desktop lease
  'profile', 'image_staged', 'computer_status',
  // Host plumbing routing needs: MCP tools are deferred behind ToolSearch
  'ToolSearch', 'TodoWrite',
]);
const EXEMPT = new Set(ROUTE_GATE_EXEMPT.map((name) => name.toLowerCase()));

/** "mcp__SynaBun__recall" / "SynaBun_recall" / "SynaBun.recall" → "recall"; other names unchanged. */
export function toolBaseName(name) {
  const text = String(name ?? '').trim();
  const match = /^mcp__synabun__(.+)$/i.exec(text) || /^synabun[_.:/-]+(.+)$/i.exec(text);
  return match ? match[1] : text;
}

export function isExemptTool(name) {
  return EXEMPT.has(toolBaseName(name).toLowerCase());
}

/** A held gate while the user has not answered the brain's clarify questions. */
export const CLARIFY_HOLD_TEXT = 'Waiting for the user\'s answers to your questions: end your turn now with one short line. The answers arrive as a [SynaBun Mailbox] clarify_answered event, or as the user\'s next message. Work that does not depend on them: route and dispatch it with independent:true.';

function targetLabel(target) {
  if (!target) return 'the chosen model';
  const model = target.model || target.label || 'default';
  return target.kind === 'direct' ? (target.label || target.model || 'the chosen model') : `${target.provider}/${model}`;
}

/**
 * The gate state a route result leads to: { state, text } where text is the
 * next step a held gate names in its refusals. `taskClass` is the class the
 * brain routed: a "chat" route unlocks nothing (conversation needs no tools),
 * so it cannot be used to skip the user's saved routes.
 */
export function gateStateFor(result, { taskClass = null } = {}) {
  if (!result || typeof result !== 'object' || result.ok === false || !result.status) return { state: 'failed', text: null };
  const target = result.target || null;
  switch (result.status) {
    case 'approved':
      if (String(taskClass || '').toLowerCase() === 'chat') return { state: 'held', text: 'A chat route unlocks no tools: answer in text, or route this task again with its real task_class (quick, research, code, browser, …).' };
      if (result.continuation || target?.continuation) return { state: 'held', text: `Continuing on ${targetLabel(target)}: end your turn now with one short line; SynaBun runs the task on that model next.` };
      if (target?.kind === 'dispatch') return { state: 'held', text: `Routed to ${targetLabel(target)}: call agent_dispatch with route_id ${result.routeId}; do not do this task here.` };
      return { state: 'open', text: null };
    case 'pending':
      return { state: 'held', text: 'Waiting for the user\'s route choice: end your turn now with one short line. The choice arrives as a [SynaBun Mailbox] route_decided event.' };
    case 'declined':
      // Image / video creation with no model that makes the medium (design: none that can see): nothing can run it.
      if (result.reason === 'no_capable_model' && result.needs === 'vision') return { state: 'held', text: 'No model in the catalog can see images, which this task needs: do not start or dispatch it; tell the user which Model routes row needs a model.' };
      if (result.reason === 'no_capable_model') return { state: 'held', text: 'No model in the catalog can make what this task creates: do not start or dispatch it; tell the user which Model routes row needs a model.' };
      return { state: 'held', text: 'The user declined this route: do not start the task; ask what they would like instead.' };
    case 'expired':
    case 'cancelled':
      return { state: 'held', text: 'This route is no longer valid: do not start the task; ask the user how to proceed.' };
    case 'clarifying':
      return { state: 'held', text: CLARIFY_HOLD_TEXT };
    default:
      return { state: 'failed', text: null };
  }
}

const ROUTE_TOOL_RE = /^(?:mcp__synabun__|synabun[_.:/-]+)agent_route$/i;
const DOWN_STATUSES = new Set(['failed', 'disabled', 'needs_auth', 'needs-auth', 'needs_client_registration', 'cancelled']);

/**
 * Whether a Claude brain can route, from its `system/init` event:
 * { available, reason } or null when it cannot tell yet (still connecting).
 */
export function claudeRouteAvailability(event) {
  const servers = Array.isArray(event?.mcp_servers) ? event.mcp_servers : null;
  if (!servers) return null;
  const synabun = servers.find((s) => String(s?.name || '').toLowerCase() === 'synabun');
  if (!synabun) return { available: false, reason: 'this brain has no SynaBun MCP server' };
  const status = String(synabun.status || '').toLowerCase();
  if (status === 'connected') {
    if (!Array.isArray(event.tools)) return null;
    return event.tools.some((t) => ROUTE_TOOL_RE.test(String(t)))
      ? { available: true }
      : { available: false, reason: 'agent_route is missing from its SynaBun tools' };
  }
  if (DOWN_STATUSES.has(status)) return { available: false, reason: `its SynaBun MCP server is ${status.replace(/[_-]/g, ' ')}` };
  return null;
}

/**
 * The same from an `mcp_status` event: OpenCode's `{ name: { status } }` map
 * or Codex's `[{ name, status }]` startup list. null when SynaBun is not in it
 * or its status says nothing yet.
 */
export function mcpStatusRouteAvailability(servers) {
  let status;
  if (Array.isArray(servers)) {
    const row = servers.find((s) => String(s?.name || '').toLowerCase() === 'synabun');
    if (!row) return null;
    status = row.status;
  } else if (servers && typeof servers === 'object') {
    const key = Object.keys(servers).find((k) => k.toLowerCase() === 'synabun');
    if (!key) return null;
    status = servers[key]?.status ?? servers[key];
  } else return null;
  const s = String(status || '').toLowerCase();
  if (s === 'connected' || s === 'ready') return { available: true };
  if (DOWN_STATUSES.has(s)) return { available: false, reason: `its SynaBun MCP server is ${s.replace(/[_-]/g, ' ')}` };
  return null;
}

/**
 * One gate per assistant session.
 * @param {object} [opts]
 * @param {string} [opts.sessionId]        named in the refusal (assistant_session_id)
 * @param {() => string} [opts.routeTool]  the agent_route name this host's model sees
 * @param {number} [opts.maxRefusals]
 */
export function createRouteGate({ sessionId = null, routeTool = () => 'agent_route', maxRefusals = ROUTE_GATE_MAX_REFUSALS } = {}) {
  let state = 'unrouted';
  let heldText = null;
  let refusals = 0;
  let turn = 0;
  let aborted = false;
  let routeId = null;
  let unavailable = null;

  /** `carry` keeps the refusal count (the reactive fallback's follow-up turn still counts toward the loop guard). */
  function startTurn({ open = false, carry = false } = {}) {
    turn += 1;
    state = open ? 'open' : 'unrouted';
    heldText = null;
    if (!carry) { refusals = 0; aborted = false; }
    routeId = null;
  }
  /** `meta.taskClass`: the class the brain routed (a chat route holds). */
  function onRouteResult(result, meta = {}) {
    const next = gateStateFor(result, meta);
    state = next.state;
    heldText = next.text;
    routeId = result?.routeId || null;
    return snapshot();
  }
  function onRouteError() {
    state = 'failed';
    heldText = null;
    return snapshot();
  }
  /**
   * agent_clarify answered: still waiting for the user holds the rest of the
   * turn (nothing that depends on the answers may start); answered or skipped
   * in the call leaves the gate as it was (the task is routed next).
   */
  function onClarify(result) {
    if (result?.status !== 'pending') return snapshot();
    state = 'held';
    heldText = CLARIFY_HOLD_TEXT;
    return snapshot();
  }
  function refusalText(tool) {
    const name = toolBaseName(tool) || 'this tool';
    if (state === 'held' && heldText) return `SynaBun route gate: ${name} was refused. ${heldText}`;
    return `SynaBun route gate: ${name} was refused because this turn is not routed. Call ${routeTool()} first (task_class, one-line summary, confidence, 1-3 proposals${sessionId ? `, assistant_session_id "${sessionId}"` : ''}) and follow its status: approved + direct opens every tool for this turn. Memory tools, agent_* tools and asking the user work without routing. For plain conversation, just answer in text.`;
  }
  /**
   * The brain cannot reach agent_route (reason), or can again (null). While
   * unavailable nothing is refused: a brain that cannot route must not be
   * locked out of every tool. Survives turn starts; the host re-evaluates it.
   */
  function setUnavailable(reason) { unavailable = reason ? String(reason) : null; }
  /** { allow, exempt?, reason?, refusals, abort } — abort is true once, on the refusal that reaches the limit. */
  function check(tool) {
    if (isExemptTool(tool)) return { allow: true, exempt: true, state, refusals };
    if (unavailable) return { allow: true, state, refusals, unavailable: true };
    if (state === 'open' || state === 'failed') return { allow: true, state, refusals };
    refusals += 1;
    const abort = !aborted && refusals >= maxRefusals;
    if (abort) aborted = true;
    return { allow: false, state, refusals, abort, reason: refusalText(tool) };
  }
  function snapshot() { return { state, turn, refusals, routeId, held: heldText, aborted, unavailable }; }

  return { startTurn, onRouteResult, onRouteError, onClarify, setUnavailable, check, snapshot, isOpen: () => !!unavailable || state === 'open' || state === 'failed' };
}

export const ROUTE_GATE_LOOP_MESSAGE = 'Stopped: the assistant kept working without routing.';
