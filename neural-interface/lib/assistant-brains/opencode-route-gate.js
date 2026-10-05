// SynaBun — OpenCode plugin for the Assistant's route gate.
// Loaded only by the assistant brain's isolated `opencode serve` (its config's
// `plugin` entry, written by patchOpenCodeAssistantConfig); the OpenCode
// sidepanel never loads it. Before every tool call it asks the Neural
// Interface whether the call may run (the route gate, and plan mode's
// read-only policy on every session of this serve). A refusal is thrown as a plain Error:
// OpenCode records it as that tool's error and the loop continues (only
// permission/question rejections stop a turn). When the gate allows, the
// user's own OpenCode permission rules apply exactly as before. The call's
// whole arguments travel (the remote denylist reads paths from them), marked
// inputComplete; arguments too big to send go as their command/action only.
// Any failure (server unreachable, bad reply) allows the call — except with
// `remote` (a WhatsApp session's serve), where a call SynaBun could not check
// is refused.
//
// On load it says hello: until the Neural Interface hears it, it enforces the
// gate reactively (interrupting a turn after an unrouted tool started), so a
// plugin that never loads still leaves the brain gated. A WhatsApp session
// runs no turn at all until the hello arrives.

const MAX_INPUT_BYTES = 256 * 1024;
const UNCHECKED = 'SynaBun could not check this call, so a WhatsApp session does not run it.';

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

export default async function SynabunRouteGate(_input, options = {}) {
  const { url, session, token, remote = false } = options || {};
  if (!url || !session || !token) return {};
  const post = (body) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, token, host: 'opencode', ...body }),
    signal: AbortSignal.timeout(5000),
  });
  // Never blocks loading; a lost hello only keeps the reactive fallback on.
  post({ hello: true }).catch(() => {});
  return {
    'tool.execute.before': async (input, output) => {
      let decision = null;
      try {
        const response = await post({ tool: String(input?.tool || ''), providerSessionId: input?.sessionID || null, ...callArguments(output?.args) });
        decision = await response.json();
      } catch {
        if (remote === true) throw new Error(UNCHECKED);
        return;
      }
      if (decision && decision.allow === false) throw new Error(String(decision.reason || 'SynaBun route gate: call agent_route first.'));
      if (remote === true && !(decision && decision.allow === true)) throw new Error(UNCHECKED);
    },
  };
}
