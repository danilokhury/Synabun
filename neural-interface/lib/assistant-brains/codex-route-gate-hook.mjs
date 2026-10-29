// SynaBun — Codex PreToolUse hook for the Assistant's route gate.
// Installed only on the assistant brain's app-server (session flag, see
// lib/assistant-route-gate-codex.js). Asks the Neural Interface whether the
// tool may run; a refusal becomes permissionDecision "deny" with the reason.
// The call's whole tool_input travels (the remote denylist reads paths from
// it), marked inputComplete; one too big to send goes as its command/action
// only, marked incomplete. No env or no answer at all (the server unreachable
// or slow) allows the call — except in a WhatsApp session
// (SYNABUN_ROUTE_GATE_REMOTE=1), where a call SynaBun could not check is
// denied. An answer that is not a decision (the check itself refused, such as
// 403 PEER_REFUSED, an error status, a body without `allow`) denies the call in
// every session and says what SynaBun answered: a refusal never passes for an
// allow.
//
// The request carries the session's pin (X-Synabun-Assistant): this hook runs
// under the brain's Codex app-server, an AI agent's process tree, which
// SynaBun's owner gate (lib/owner-authority.js) refuses unless the call says
// it is an agent's own. The per-session token in the body is what the route
// itself checks.

const url = process.env.SYNABUN_ROUTE_GATE_URL;
const session = process.env.SYNABUN_ROUTE_GATE_SESSION;
const token = process.env.SYNABUN_ROUTE_GATE_TOKEN;
const remote = process.env.SYNABUN_ROUTE_GATE_REMOTE === '1';
const MAX_INPUT_BYTES = 256 * 1024;
const UNCHECKED = 'SynaBun could not check this call, so a WhatsApp session does not run it.';
const PIN_HEADER = 'x-synabun-assistant';

let raw = '';
try { for await (const chunk of process.stdin) raw += chunk; } catch {}
let input = {};
try { input = JSON.parse(raw || '{}'); } catch {}

/** { input, inputComplete }: the whole tool_input when the host gave one small enough to send. */
function callArguments(toolInput) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return { input: {}, inputComplete: false };
  let size = Infinity;
  try { size = Buffer.byteLength(JSON.stringify(toolInput)); } catch {}
  if (size <= MAX_INPUT_BYTES) return { input: toolInput, inputComplete: true };
  const subset = {};
  for (const key of ['command', 'action']) {
    if (typeof toolInput[key] === 'string' && toolInput[key].length <= 64 * 1024) subset[key] = toolInput[key];
  }
  return { input: subset, inputComplete: false };
}
// Codex prints "Command blocked by PreToolUse hook: <reason>. Command: <cmd>", so the
// reason goes without its own final period.
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: String(reason).replace(/[.\s]+$/, '') } }));
}
/** The refusal of a call whose check got an answer that is not a decision: what SynaBun answered, in short. */
function notADecision(status, body) {
  const code = body && typeof body === 'object' && typeof body.code === 'string' ? ` ${body.code.slice(0, 64)}` : '';
  const said = body && typeof body === 'object' && typeof body.error === 'string' ? `: ${body.error.slice(0, 300)}` : '';
  return `SynaBun could not check this call (its route gate answered ${status}${code}${said}), so it did not run.`;
}

if (url && session && token) {
  let response = null;
  try {
    response = await fetch(url, {
      method: 'POST',
      // The session id as a header value: printable ASCII only (fetch refuses anything else before sending).
      headers: { 'content-type': 'application/json', [PIN_HEADER]: String(session).replace(/[^\x21-\x7e]/g, '').slice(0, 200) },
      body: JSON.stringify({ session, token, host: 'codex', tool: String(input.tool_name || input.toolName || input.tool || ''), agent: input.agent_id || null, ...callArguments(input.tool_input) }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { response = null; }
  if (!response) {
    if (remote) deny(UNCHECKED);
  } else {
    let decision = null;
    try { decision = await response.json(); } catch { decision = null; }
    if (response.ok && decision && decision.allow === true) { /* allowed: Codex runs the call */ }
    else if (response.ok && decision && decision.allow === false) deny(decision.reason || 'SynaBun refused this call.');
    else deny(notADecision(response.status, decision));
  }
}
process.exit(0);
