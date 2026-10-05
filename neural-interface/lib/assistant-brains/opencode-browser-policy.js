// SynaBun — OpenCode plugin: the browser policy of an Assistant task run.
// Loaded only by the isolated `opencode serve` of a worker the Assistant
// dispatched (its config's `plugin` entry, added by withOpenCodeBrowserPolicy
// from server.js setupOpencodeLoopConfig); loops, schedules and the OpenCode
// sidepanel never load it. Before every tool call it asks
// lib/browser-tool-policy.js here, with no server round trip. A refusal is
// thrown as a plain Error: OpenCode records it as that tool's error and the
// loop continues. Script paths resolve against the run's cwd (the plugin
// options), else the serve's directory. A policy module that cannot load fails
// closed: the failure is logged once, and bash, webfetch, websearch and every
// tool that is not OpenCode's own or SynaBun's (another MCP server's, another
// plugin's) are refused with that reason until the run ends. The default
// export is the only export: OpenCode runs every function a plugin exports.

// An absolute file URL: the policy loads from SynaBun's lib/ wherever OpenCode imports this file from.
const POLICY_URL = new URL('../browser-tool-policy.js', import.meta.url).href;

// OpenCode's own tools that run no command and fetch no page. bash, webfetch and
// websearch are not here; any other name belongs to an MCP server or a plugin.
const OWN_TOOLS = new Set([
  'read', 'list', 'glob', 'grep', 'edit', 'write', 'patch', 'multiedit', 'apply_patch', 'todowrite', 'todoread',
  'task', 'skill', 'lsp', 'codesearch', 'question', 'batch', 'invalid', 'plan_exit', 'plan_enter',
]);

export default async function SynabunBrowserPolicy(input = {}, options = {}) {
  let policy = null;
  let loadError = null;
  try { policy = await import(POLICY_URL); } catch (error) { loadError = error; }
  if (typeof policy?.browserToolDenial !== 'function') {
    const why = loadError?.message || 'browserToolDenial is missing';
    console.error(`[SynaBun] browser policy could not load from ${POLICY_URL} (${why}); refusing bash, webfetch, websearch and other servers' tools for this run`);
    return {
      'tool.execute.before': async (call) => {
        const tool = String(call?.tool || '');
        if (/^synabun_/i.test(tool) || OWN_TOOLS.has(tool.toLowerCase())) return;
        throw new Error(`SynaBun browser policy: ${tool} was refused — SynaBun's browser policy could not load (${why}), so no command, web tool or other server's tool can be checked for a browser launch. SynaBun's own tools (SynaBun_*) and file tools still work. Stop and report this.`);
      },
    };
  }
  const cwd = (typeof options?.cwd === 'string' && options.cwd) || (typeof input?.directory === 'string' && input.directory) || process.cwd();
  return {
    'tool.execute.before': async (call, output) => {
      const reason = policy.browserToolDenial(String(call?.tool || ''), output?.args || {}, { host: 'opencode', cwd });
      if (reason) throw new Error(reason);
    },
  };
}
