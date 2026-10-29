// SynaBun — OpenCode plugin for the Assistant's route gate.
// Loaded only by the assistant brain's isolated `opencode serve` (its
// opencode.json's `plugins` entry, { package: <this folder as a file URL>,
// options }, written by patchOpenCodeAssistantConfig); the OpenCode sidepanel
// never loads it. OpenCode 2's plugin API: the default export is
// `{ id, setup(context) }`; the hook it registers with
// `context.tool.hook('execute.before', …)` sees `{ tool, sessionID, input }`
// and refuses a call by throwing (OpenCode records
// the message as that tool's error and the loop continues; only
// permission/question rejections stop a turn). Before every tool call it asks
// the Neural Interface whether the call may run (the route gate, and plan
// mode's read-only policy on every session of this serve). When the gate
// allows, the user's own OpenCode permission rules apply exactly as before.
// OpenCode calls two tools by other names than the rest of SynaBun knows
// (`shell` for bash, `subagent` for task): the gate is asked with those names.
// The call's whole arguments travel (the remote denylist reads paths from
// them), marked inputComplete; arguments too big to send go as their
// command/action only. No answer at all (the server unreachable or slow)
// allows the call — except with `remote` (a WhatsApp session's serve), where a
// call SynaBun could not check is refused. An answer that is not a decision
// (the check itself refused, such as 403 PEER_REFUSED, an error status, a body
// without `allow`) refuses the call in every session and says what SynaBun
// answered: a refusal never passes for an allow.
//
// Every request carries the session's pin (X-Synabun-Assistant): this plugin
// runs inside the brain's `opencode serve`, an AI agent's process tree, which
// SynaBun's owner gate (lib/owner-authority.js) refuses unless the call says
// it is an agent's own. The per-session `token` in the body is what the route
// itself checks.
//
// On load it says hello: until the Neural Interface hears it, it enforces the
// gate reactively (interrupting a turn after an unrouted tool started), so a
// plugin that never loads still leaves the brain gated. A WhatsApp session
// runs no turn at all until the hello arrives.

const MAX_INPUT_BYTES = 256 * 1024;
const UNCHECKED = 'SynaBun could not check this call, so a WhatsApp session does not run it.';
const V1_NAMES = { shell: 'bash', subagent: 'task' };
const PIN_HEADER = 'x-synabun-assistant';

/** The session id as a header value (printable ASCII only: fetch refuses anything else before sending). */
function pinOf(session) {
  return String(session).replace(/[^\x21-\x7e]/g, '').slice(0, 200);
}

/** The refusal of a call whose check got an answer that is not a decision: what SynaBun answered, in short. */
function notADecision(status, body) {
  const code = body && typeof body === 'object' && typeof body.code === 'string' ? ` ${body.code.slice(0, 64)}` : '';
  const said = body && typeof body === 'object' && typeof body.error === 'string' ? `: ${body.error.slice(0, 300)}` : '';
  return `SynaBun could not check this call (its route gate answered ${status}${code}${said}), so it did not run.`;
}

/** { input, inputComplete }: the whole arguments when small enough to send, else their command/action. */
function callArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { input: {}, inputComplete: false };
  let size = Infinity;
  try { size = JSON.stringify(args).length; } catch {}
  if (size <= MAX_INPUT_BYTES) return { input: args, inputComplete: true };
  const subset = {};
  for (const key of ['command', 'action']) {
    if (typeof args[key] === 'string' && args[key].length <= 64 * 1024) subset[key] = args[key];
  }
  return { input: subset, inputComplete: false };
}

export default {
  id: 'synabun.route-gate',
  async setup(context) {
    const { url, session, token, remote = false } = context?.options || {};
    if (!url || !session || !token) return;
    const post = (body) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PIN_HEADER]: pinOf(session) },
      body: JSON.stringify({ session, token, host: 'opencode', ...body }),
      signal: AbortSignal.timeout(5000),
    });
    // Never blocks loading; a lost hello only keeps the reactive fallback on (a refused one is said in the serve's log).
    post({ hello: true }).then((response) => {
      if (!response.ok) console.error(`[SynaBun] the route gate refused this serve's hello (${response.status}); every tool call will be refused until it answers`);
    }).catch(() => {});
    await context.tool.hook('execute.before', async (call) => {
      const name = String(call?.tool || '');
      let response;
      try {
        response = await post({ tool: V1_NAMES[name] || name, providerSessionId: call?.sessionID || null, ...callArguments(call?.input) });
      } catch {
        if (remote === true) throw new Error(UNCHECKED);
        return;
      }
      let decision = null;
      try { decision = await response.json(); } catch { decision = null; }
      if (response.ok && decision && decision.allow === true) return;
      if (response.ok && decision && decision.allow === false) throw new Error(String(decision.reason || 'SynaBun route gate: call agent_route first.'));
      throw new Error(notADecision(response.status, decision));
    });
  },
};
