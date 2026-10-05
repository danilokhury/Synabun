// SynaBun — Codex PreToolUse hook for the Assistant's route gate.
// Installed only on the assistant brain's app-server (session flag, see
// lib/assistant-route-gate-codex.js). Asks the Neural Interface whether the
// tool may run; a refusal becomes permissionDecision "deny" with the reason.
// The call's whole tool_input travels (the remote denylist reads paths from
// it), marked inputComplete; one too big to send goes as its command/action
// only, marked incomplete. Any failure (no env, server unreachable, bad reply)
// allows the call — except in a WhatsApp session (SYNABUN_ROUTE_GATE_REMOTE=1),
// where a call SynaBun could not check is denied.

const url = process.env.SYNABUN_ROUTE_GATE_URL;
const session = process.env.SYNABUN_ROUTE_GATE_SESSION;
const token = process.env.SYNABUN_ROUTE_GATE_TOKEN;
const remote = process.env.SYNABUN_ROUTE_GATE_REMOTE === '1';
const MAX_INPUT_BYTES = 256 * 1024;
const UNCHECKED = 'SynaBun could not check this call, so a WhatsApp session does not run it.';

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

if (url && session && token) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, token, host: 'codex', tool: String(input.tool_name || input.toolName || input.tool || ''), agent: input.agent_id || null, ...callArguments(input.tool_input) }),
      signal: AbortSignal.timeout(5000),
    });
    const decision = await response.json();
    if (decision && decision.allow === false) deny(decision.reason || 'SynaBun refused this call.');
    else if (remote && !(decision && decision.allow === true)) deny(UNCHECKED);
  } catch {
    if (remote) deny(UNCHECKED);
  }
}
process.exit(0);
