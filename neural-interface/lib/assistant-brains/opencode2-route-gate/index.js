// SynaBun — the Assistant's route gate as an OpenCode 2 plugin.
// The same gate as ../opencode-route-gate.js (read that file for what it does
// and why), for OpenCode 2's plugin API: a directory OpenCode loads from the
// config's `plugins` entry ({ package: <this folder as a file URL>, options }),
// whose default export is `{ id, setup(context) }`; a hook on
// `tool.execute.before` sees `{ tool, sessionID, input }` and refuses a call by
// throwing (OpenCode records the message as that tool's error). OpenCode 2
// calls two tools by other names than OpenCode 1 (`shell` for bash,
// `subagent` for task): the gate is asked with OpenCode 1's names, which the
// rest of SynaBun knows. OpenCode 1 never reads this folder (it loads the
// `plugin` entry), and OpenCode 2 never loads the 1.x file.

const MAX_INPUT_BYTES = 256 * 1024;
const UNCHECKED = 'SynaBun could not check this call, so a WhatsApp session does not run it.';
const V1_NAMES = { shell: 'bash', subagent: 'task' };

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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, token, host: 'opencode', ...body }),
      signal: AbortSignal.timeout(5000),
    });
    // Never blocks loading; a lost hello only keeps the reactive fallback on.
    post({ hello: true }).catch(() => {});
    await context.tool.hook('execute.before', async (call) => {
      const name = String(call?.tool || '');
      let decision = null;
      try {
        const response = await post({ tool: V1_NAMES[name] || name, providerSessionId: call?.sessionID || null, ...callArguments(call?.input) });
        decision = await response.json();
      } catch {
        if (remote === true) throw new Error(UNCHECKED);
        return;
      }
      if (decision && decision.allow === false) throw new Error(String(decision.reason || 'SynaBun route gate: call agent_route first.'));
      if (remote === true && !(decision && decision.allow === true)) throw new Error(UNCHECKED);
    });
  },
};
