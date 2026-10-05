// SynaBun — Codex PreToolUse hook: the browser policy of an Assistant task run.
// Installed only on the Codex workers the Assistant dispatches
// (native-loop-providers.js, createCodexNativeLoopAdapter with runMode "task"),
// as `codex exec` session flags the user's Codex trusts by hash
// (lib/assistant-route-gate-codex.js codexBrowserPolicyHook). Reads the
// PreToolUse payload from stdin and asks lib/browser-tool-policy.js here, with
// no server round trip; a refusal becomes permissionDecision "deny" with the
// reason. Script paths resolve against the payload's cwd, else
// SYNABUN_BROWSER_POLICY_CWD (the run's project). An unreadable payload allows
// the call: the policy is a speed bump, not a sandbox. A policy module that
// cannot load fails closed (logged on stderr): shell commands, web search and
// every MCP tool but SynaBun's are denied with that reason.

let browserToolDenial = null;
let loadError = null;
try { ({ browserToolDenial } = await import('../browser-tool-policy.js')); } catch (error) { loadError = error; }

// Codex's shell family and web search, by the names its hooks report.
const SHELL_OR_WEB = /^(?:bash|shell|shell_command|exec_command|local_shell|container\.exec|unified_exec|web_search|web_search_preview)$/i;

/** The refusal while the policy module is missing, else null. */
function unloadedDenial(tool) {
  const synabun = /^mcp__(?:[a-z0-9-]+_)*synabun__/i.test(tool) || /^synabun[_.:/-]/i.test(tool);
  if (synabun || !(SHELL_OR_WEB.test(tool) || /^mcp__/i.test(tool))) return null;
  return `SynaBun browser policy: ${tool} was refused — SynaBun's browser policy could not load (${loadError?.message || 'browserToolDenial is missing'}), so no command, web search or other server's tool can be checked for a browser launch. SynaBun's own tools still work. Stop and report this`;
}

let raw = '';
try { for await (const chunk of process.stdin) raw += chunk; } catch {}
let payload = {};
try { payload = JSON.parse(raw || '{}') || {}; } catch {}

try {
  const tool = String(payload.tool_name || payload.toolName || payload.tool || '');
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const cwd = (typeof payload.cwd === 'string' && payload.cwd) || process.env.SYNABUN_BROWSER_POLICY_CWD || process.cwd();
  if (typeof browserToolDenial !== 'function') process.stderr.write(`[SynaBun] browser policy could not load (${loadError?.message || 'browserToolDenial is missing'}); denying shell, web search and other servers' tools\n`);
  const reason = !tool ? null : typeof browserToolDenial === 'function' ? browserToolDenial(tool, input, { host: 'codex', cwd }) : unloadedDenial(tool);
  // Codex prints "Command blocked by PreToolUse hook: <reason>. Command: <cmd>", so
  // the reason goes without its own final period.
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason.replace(/[.\s]+$/, '') } }));
} catch {}
process.exit(0);
