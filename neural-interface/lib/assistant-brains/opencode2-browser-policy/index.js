// SynaBun — OpenCode plugin: the browser policy of an Assistant task run.
// Loaded only by the isolated `opencode serve` of a worker the Assistant
// dispatched (its opencode.json's `plugins` entry, { package: <this folder as a
// file URL>, options }, added by withOpenCodeBrowserPolicy from server.js
// setupOpencodeLoopConfig); loops, schedules and the OpenCode sidepanel never
// load it. OpenCode 2's plugin API: the default export is `{ id, setup(context) }`,
// registering `context.tool.hook('execute.before', …)`, which sees `{ tool, sessionID, input }`;
// a refusal is thrown as a plain Error, which OpenCode records as that tool's
// error, and the loop continues. Before every tool call it asks
// lib/browser-tool-policy.js here, with no server round trip. OpenCode calls the
// shell tool `shell` and the sub-agent tool `subagent`: the policy is asked with
// the names the rest of SynaBun knows (`bash`, `task`). Script paths resolve
// against the run's cwd (the plugin options), else the serve's directory; the
// options' `roots` name the registered code projects its test runners may also
// run in (the serve is sandboxed and cannot read SynaBun's data home: server.js
// lists them as the run starts). A
// policy module that cannot load fails closed: the failure is logged once, and
// the shell, webfetch, websearch and every tool that is not OpenCode's own or
// SynaBun's (another MCP server's, another plugin's) are refused with that
// reason until the run ends.

// An absolute file URL: the policy loads from SynaBun's lib/ wherever OpenCode imports this file from.
const POLICY_URL = new URL('../../browser-tool-policy.js', import.meta.url).href;
const V1_NAMES = { shell: 'bash', subagent: 'task' };

// OpenCode's own tools that run no command, fetch no page and open no browser (by the names above). The shell,
// webfetch, websearch and OpenCode's browser are not here; any other name belongs to an MCP server or a plugin.
const OWN_TOOLS = new Set([
  'read', 'list', 'glob', 'grep', 'edit', 'write', 'patch', 'todo', 'task', 'skill', 'lsp', 'question',
  'invalid', 'plan_exit', 'plan_enter',
]);

export default {
  id: 'synabun.browser-policy',
  async setup(context) {
    const options = context?.options || {};
    let policy = null;
    let loadError = null;
    try { policy = await import(POLICY_URL); } catch (error) { loadError = error; }
    const cwd = (typeof options.cwd === 'string' && options.cwd) || context?.location?.directory || process.cwd();
    const roots = Array.isArray(options.roots) ? options.roots.filter((path) => typeof path === 'string') : [];
    if (typeof policy?.browserToolDenial !== 'function') {
      const why = loadError?.message || 'browserToolDenial is missing';
      console.error(`[SynaBun] browser policy could not load from ${POLICY_URL} (${why}); refusing the shell, webfetch, websearch and other servers' tools for this run`);
      await context.tool.hook('execute.before', async (call) => {
        const raw = String(call?.tool || '');
        const tool = V1_NAMES[raw] || raw;
        if (/^synabun_/i.test(tool) || OWN_TOOLS.has(tool.toLowerCase())) return;
        throw new Error(`SynaBun browser policy: ${raw} was refused — SynaBun's browser policy could not load (${why}), so no command, web tool or other server's tool can be checked for a browser launch. SynaBun's own tools (SynaBun_*) and file tools still work. Stop and report this.`);
      });
      return;
    }
    await context.tool.hook('execute.before', async (call) => {
      const raw = String(call?.tool || '');
      const reason = policy.browserToolDenial(V1_NAMES[raw] || raw, call?.input || {}, { host: 'opencode', cwd, roots });
      if (reason) throw new Error(reason);
    });
  },
};
