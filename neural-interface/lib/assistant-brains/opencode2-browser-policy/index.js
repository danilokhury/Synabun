// SynaBun — an Assistant task run's browser policy as an OpenCode 2 plugin.
// The same policy as ../opencode-browser-policy.js (read that file for what it
// does and why), for OpenCode 2's plugin API: a directory OpenCode loads from
// the config's `plugins` entry, whose default export is `{ id, setup(context) }`
// with a hook on `tool.execute.before`; a refusal is thrown. OpenCode 2 calls
// the shell tool `shell` and the sub-agent tool `subagent`: the policy, written
// for OpenCode 1's names, is asked with `bash` and `task`.

// An absolute file URL: the policy loads from SynaBun's lib/ wherever OpenCode imports this file from.
const POLICY_URL = new URL('../../browser-tool-policy.js', import.meta.url).href;
const V1_NAMES = { shell: 'bash', subagent: 'task' };

// OpenCode's own tools that run no command and fetch no page (OpenCode 1's names).
const OWN_TOOLS = new Set([
  'read', 'list', 'glob', 'grep', 'edit', 'write', 'patch', 'multiedit', 'apply_patch', 'todowrite', 'todoread',
  'task', 'skill', 'lsp', 'codesearch', 'question', 'batch', 'invalid', 'plan_exit', 'plan_enter',
]);

export default {
  id: 'synabun.browser-policy',
  async setup(context) {
    const options = context?.options || {};
    let policy = null;
    let loadError = null;
    try { policy = await import(POLICY_URL); } catch (error) { loadError = error; }
    const cwd = (typeof options.cwd === 'string' && options.cwd) || context?.location?.directory || process.cwd();
    if (typeof policy?.browserToolDenial !== 'function') {
      const why = loadError?.message || 'browserToolDenial is missing';
      console.error(`[SynaBun] browser policy could not load from ${POLICY_URL} (${why}); refusing bash, webfetch, websearch and other servers' tools for this run`);
      await context.tool.hook('execute.before', async (call) => {
        const raw = String(call?.tool || '');
        const tool = V1_NAMES[raw] || raw;
        if (/^synabun_/i.test(tool) || OWN_TOOLS.has(tool.toLowerCase())) return;
        throw new Error(`SynaBun browser policy: ${tool} was refused — SynaBun's browser policy could not load (${why}), so no command, web tool or other server's tool can be checked for a browser launch. SynaBun's own tools (SynaBun_*) and file tools still work. Stop and report this.`);
      });
      return;
    }
    await context.tool.hook('execute.before', async (call) => {
      const raw = String(call?.tool || '');
      const reason = policy.browserToolDenial(V1_NAMES[raw] || raw, call?.input || {}, { host: 'opencode', cwd });
      if (reason) throw new Error(reason);
    });
  },
};
