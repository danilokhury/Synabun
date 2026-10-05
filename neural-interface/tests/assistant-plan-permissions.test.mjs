// The assistant's plan mode blocks code changes and nothing else, on every
// brain: edits, patches and file-writing MCP tools are refused whatever the
// approval mode or the user's allow rules; commands, computer use and every
// other tool follow the approval mode (auto runs them, ask shows the normal
// card); reads never ask; a planning brain's workers run read-only. The
// read-only classifier keeps its semantics for remote (WhatsApp) sessions.
process.env.SYNABUN_TYPESAFE = 'off';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  booleanArg, claudePlanHookDecision, claudePlanPermission, claudeReadOnlyPermission, clampPlanDispatch, codexGrantWritesFiles,
  codexPlanPermission, codexReadOnlyPermission, isFileWritingMcpTool, isReadOnlyMcpTool, isReadOnlyShellCommand,
  opencodeReadOnlyPermission, PLAN_DISPATCH_NOTE, planDenyMessage, planToolDecision, readOnlyDenyMessage, readOnlyToolDecision, runCanChangeCode,
} from '../lib/assistant-plan-permissions.js';
import { ClaudeSession, configureClaudeBridge } from '../lib/claude-agent-bridge.js';
import { createClaudeBrain } from '../lib/assistant-brains/claude.js';
import { createCodexBrain } from '../lib/assistant-brains/codex.js';
import { createOpenCodeBrain, OPENCODE_PLAN_AGENT, OPENCODE_PLAN_INSTRUCTIONS, opencodeAutoDecision, patchOpenCodeAssistantConfig } from '../lib/assistant-brains/opencode.js';
import { planModeInstructions } from '../lib/assistant-persona.js';
import { createAssistantRuntime } from '../lib/assistant-runtime.js';
import { createAssistantApi } from '../lib/assistant-api.js';
import { createRemotePolicyRegistry } from '../lib/remote-policy.js';
import { NativeLoopRuntime } from '../lib/native-loop-runtime.js';
import { createAssistantDispatcher } from '../lib/assistant-dispatch.js';
import { createAssistantRouter } from '../lib/assistant-router.js';
import { createAssistantCatalog } from '../lib/assistant-catalog.js';
import { effectiveRouting } from '../lib/assistant-config.js';
import { PRICING, fakeFetch } from './assistant-catalog.fixtures.mjs';

const pending = async (promise) => (await Promise.race([promise, new Promise((r) => setTimeout(() => r('pending'), 20))]));
const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const v = predicate(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('Timed out waiting for condition');
};

// ── the read-only classifier (remote sessions, and what plan mode runs without a card) ──

test('read-only classifier: read-only tools run, edits, commands and writing MCP tools are refused (today\'s semantics)', () => {
  for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'mcp__SynaBun__recall', 'mcp__SynaBun__browser_snapshot', 'mcp__SynaBun__browser_extract_tweets', 'mcp__SynaBun__agent_route', 'mcp__plugin_context7_context7__query-docs']) {
    assert.equal(claudeReadOnlyPermission(tool, {}), 'allow', tool);
  }
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'CronCreate', 'mcp__SynaBun__remember', 'mcp__SynaBun__browser_click', 'mcp__SynaBun__git', 'mcp__SynaBun__discord_message', 'mcp__other__delete_file', 'mcp__SynaBun__agent_dispatch', 'mcp__SynaBun__agent_send']) {
    assert.equal(claudeReadOnlyPermission(tool, {}), 'deny', tool);
  }
  // agent_usage only reads the token ledger: a read-only (WhatsApp) session and a plan turn run it without a card.
  for (const tool of ['mcp__SynaBun__agent_usage', 'SynaBun_agent_usage']) assert.equal(isReadOnlyMcpTool(tool, {}), true, tool);
  assert.equal(claudeReadOnlyPermission('mcp__SynaBun__agent_usage', { assistant_session_id: 'a', task: 'all' }), 'allow');
  // Multiplexed tools read only for their read actions.
  assert.equal(isReadOnlyMcpTool('mcp__SynaBun__memories', { action: 'get' }), true);
  assert.equal(isReadOnlyMcpTool('mcp__SynaBun__memories', { action: 'undo' }), false);
  assert.equal(isReadOnlyMcpTool('mcp__SynaBun__category', { action: 'create' }), false);
  assert.equal(isReadOnlyMcpTool('SynaBun_recall', {}), true); // OpenCode naming
  assert.match(readOnlyDenyMessage('Edit'), /Plan mode is read-only.*Edit/);
});

test('read-only classifier: a screenshot that saves a file is a write, with save read the way the tool reads it', () => {
  // mcp-server/src/tools/utils.ts parseBooleanArg: true/false, "true"/"false" (any case), 1/0.
  for (const save of [true, 'true', ' TRUE ', 1, '1', 'yes', 'on', {}]) {
    assert.equal(isReadOnlyMcpTool('mcp__SynaBun__browser_screenshot', { save }), false, JSON.stringify(save));
  }
  for (const save of [false, 'false', 'False', 0, '0', undefined, null]) {
    assert.equal(isReadOnlyMcpTool('mcp__SynaBun__browser_screenshot', { save, fullPage: 'false' }), true, JSON.stringify(save));
  }
  assert.equal(isReadOnlyMcpTool('mcp__SynaBun__browser_screenshot', { save: 'false', path: '/work/app/shot.png' }), false, 'a path always saves');
  assert.equal(isReadOnlyMcpTool('SynaBun_browser_screenshot', { save: 'true' }), false, 'OpenCode naming');
  assert.deepEqual([true, 'TRUE', 1, '1', false, 'false', 0, '0', 'yes', '', null].map(booleanArg), [true, true, true, true, false, false, false, false, null, null, null]);
});

test('read-only classifier: Codex declines everything that leaves the read-only sandbox, questions stay with the user', () => {
  const req = (method, params = {}) => ({ request: { brain_native: { method, params } } });
  assert.equal(codexReadOnlyPermission(req('item/commandExecution/requestApproval', { command: 'rm -rf build' })), 'deny');
  assert.equal(codexReadOnlyPermission(req('item/fileChange/requestApproval')), 'deny');
  assert.equal(codexReadOnlyPermission(req('item/permissions/requestApproval')), 'deny');
  const mcp = (tool) => req('mcpServer/elicitation/request', { serverName: 'SynaBun', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: tool } });
  assert.equal(codexReadOnlyPermission(mcp('recall')), 'allow');
  assert.equal(codexReadOnlyPermission(mcp('remember')), 'deny');
  assert.equal(codexReadOnlyPermission(mcp('agent_dispatch')), 'deny');
  assert.equal(codexReadOnlyPermission(req('mcpServer/elicitation/request', { serverName: 'x', message: 'Pick a repo' })), null); // an MCP form
  assert.equal(codexReadOnlyPermission(req('item/tool/requestUserInput')), null);
});

test('read-only classifier: a WhatsApp session\'s OpenCode brain answers every ask read-only, whatever the approval mode', () => {
  const ask = (tool, kind = 'permission', command = null) => ({ request: { tool_name: tool, input: command ? { metadata: { command } } : {}, brain_native: { kind } } });
  for (const approvalMode of ['default', 'auto']) {
    for (const planMode of [true, false]) {
      const decide = (packet) => opencodeAutoDecision(packet, { approvalMode, planMode, readOnly: true });
      assert.equal(decide(ask('external_directory')), 'allow');
      assert.equal(decide(ask('webfetch')), 'allow');
      assert.equal(decide(ask('bash', 'permission', 'git status')), 'allow');
      assert.equal(decide(ask('bash', 'permission', 'npm install')), 'deny');
      assert.equal(decide(ask('edit')), 'deny');
      assert.equal(decide(ask('SynaBun_remember')), 'deny');
      assert.equal(decide(ask('q', 'question')), null);
    }
  }
  assert.equal(opencodeReadOnlyPermission(ask('read')), 'allow');
});

test('read-only classifier: inspection commands run; mutation, shell syntax, wrappers and writing flags are refused', () => {
  for (const command of ['rg -n "plan|mode" lib', 'git status', 'git diff --stat', 'git log --oneline -20', 'git show HEAD~1', 'ls -la', 'cat package.json', 'pwd', "grep -rn 'foo$' src", 'find . -name "*.js" -type f', 'head -40 README.md', 'wc -l lib/a.js', 'sort -k2 data.txt', 'sort -t, -k2 data.txt', 'rg -- foo', 'echo ~/x', 'git diff --output-indicator-new=+ a', 'git log --no-ext-diff -p', 'tree -L 2', 'cat "a b.md"']) {
    assert.equal(isReadOnlyShellCommand(command), true, command);
    assert.equal(claudeReadOnlyPermission('Bash', { command }), 'allow', command);
  }
  for (const command of ['rm -rf build', 'git commit -m x', 'git checkout .', 'git push', 'git -c core.pager=sh log', 'git -C /tmp status', 'git diff --output=x', 'git grep -O foo', 'ls > out.txt', 'cat a >> b', 'cat a | sh', 'cat a; rm b', 'ls && touch x', 'ls || rm x', 'ls & rm x', 'echo $(rm x)', 'echo `id`', 'cat "$HOME/x"', 'cat <(rm x)', 'find . -delete', 'find . -exec rm x', 'find . -fprint out', 'rg --pre ./x foo', 'rg --pre=./x foo', 'sort -o out a', 'sort -ro out a', 'tree -o out', 'env rm x', 'sudo ls', 'xargs rm', 'bash -c "ls"', 'sh -c ls', 'timeout 5 rm x', 'FOO=1 ls', 'sed -i s/a/b/ f', 'npm test', 'node -e 1', 'tee x', 'ls\nrm x', 'cat a\\ b', "ls 'unterminated", '',
    // globs can expand to a file named like an option (a `--pre=sh` file next to `rg x *`)
    'rg foo *', 'ls *.md', 'cat src/[ab].js', 'ls ?', 'ls ^x',
    // GNU getopt and git accept an unambiguous prefix of a long option
    'sort --out=x a', 'sort --outp x a', 'sort --comp=gzip a', 'sort --compress-program=sh a', 'sort -T . a', 'git grep --open=rm foo', 'git show --outp=x', 'git diff --ext',
    // writers hidden in options, odd white space, control characters
    'tree -R -L 2', 'tree -dR', 'ls -la', 'ls rm x', 'cat "a\u0000b"', 'ls\rrm x']) {
    assert.equal(isReadOnlyShellCommand(command), false, command);
    assert.equal(claudeReadOnlyPermission('Bash', { command }), 'deny', command);
  }
  // OpenCode asks with the whole line in metadata.command: its patterns are single commands and are not trusted.
  const ocBash = (command, patterns = [command]) => ({ request: { tool_name: 'bash', input: { patterns, metadata: command == null ? {} : { command } }, brain_native: { kind: 'permission' } } });
  assert.equal(opencodeReadOnlyPermission(ocBash('git status')), 'allow');
  assert.equal(opencodeReadOnlyPermission(ocBash('git status && rm -rf x', ['git status', 'rm -rf x'])), 'deny');
  assert.equal(opencodeReadOnlyPermission(ocBash('ls > out.txt', ['ls'])), 'deny', 'a redirect outside the pattern still counts');
  assert.equal(opencodeReadOnlyPermission(ocBash(null, ['ls'])), 'deny', 'no command line → refused');
});

test('read-only classifier: host pre-tool decisions — OpenCode checks bash lines, edits and MCP tools; Codex leaves commands to its sandbox', () => {
  const oc = (tool, input = {}) => readOnlyToolDecision(tool, input, { host: 'opencode' });
  assert.equal(oc('bash', { command: 'git log --oneline -5' }), null);
  assert.equal(oc('bash', { command: '> src/index.js' }), 'deny', 'a bare redirect OpenCode would never ask about');
  assert.equal(oc('bash', { command: 'declare -p > dump.txt' }), 'deny');
  assert.equal(oc('bash', {}), 'deny');
  for (const tool of ['edit', 'write', 'patch', 'apply_patch', 'SynaBun_agent_dispatch', 'SynaBun_remember', 'SynaBun_memories']) assert.equal(oc(tool), 'deny', tool);
  for (const tool of ['read', 'grep', 'glob', 'list', 'task', 'question', 'plan_exit', 'todowrite', 'SynaBun_recall', 'context7_query-docs']) assert.equal(oc(tool), null, tool);
  assert.equal(oc('SynaBun_memories', { action: 'get' }), null);
  const cx = (tool, input = {}) => readOnlyToolDecision(tool, input, { host: 'codex' });
  assert.equal(cx('Bash', { command: 'rm -rf x' }), null, 'the read-only sandbox decides');
  assert.equal(cx('apply_patch'), null);
  assert.equal(cx('mcp__SynaBun__agent_dispatch'), 'deny');
  assert.equal(cx('mcp__SynaBun__recall'), null);
  assert.equal(readOnlyToolDecision('Bash', { command: 'rm -rf x' }, { host: 'claude' }), 'deny');
});

// ── plan mode: no code changes ───────────────────────────────────────────────

test('plan policy: the edit family and file-writing MCP tools are the only code changes', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__filesystem__write_file', 'mcp__filesystem__edit_file', 'mcp__filesystem__move_file', 'mcp__filesystem__create_directory', 'mcp__fs__writeFile', 'mcp__desktop-commander__edit_block', 'mcp__editor__str_replace', 'mcp__github__create_or_update_file', 'mcp__github__push_files']) {
    assert.equal(claudePlanHookDecision(tool), 'deny', tool);
  }
  for (const tool of ['Bash', 'PowerShell', 'Read', 'Task', 'Agent', 'TodoWrite', 'ToolSearch', 'CronCreate', 'WebFetch', 'mcp__SynaBun__remember', 'mcp__SynaBun__agent_dispatch', 'mcp__SynaBun__agent_send', 'mcp__SynaBun__computer', 'mcp__SynaBun__browser_click', 'mcp__SynaBun__browser_upload', 'mcp__SynaBun__git', 'mcp__filesystem__read_file', 'mcp__filesystem__list_directory', 'mcp__filesystem__search_files', 'mcp__github__create_issue', 'mcp__memory__write', 'mcp__desktop-commander__start_process']) {
    assert.equal(claudePlanHookDecision(tool), null, tool);
  }
  assert.equal(isFileWritingMcpTool('write_file', { serverName: 'filesystem' }), true, 'a Codex elicitation names the server apart');
  assert.equal(isFileWritingMcpTool('SynaBun_whiteboard_update'), false, 'SynaBun\'s own tools never count');
  // Each host: its edit channel, and file-writing MCP tools under its naming.
  const cx = (tool, input = {}) => planToolDecision(tool, input, { host: 'codex' });
  for (const tool of ['apply_patch', 'mcp__filesystem__write_file']) assert.equal(cx(tool), 'deny', tool);
  for (const [tool, input] of [['Bash', { command: 'rm -rf build' }], ['mcp__SynaBun__agent_dispatch', {}], ['mcp__SynaBun__computer', { action: 'left_click' }], ['mcp__SynaBun__remember', {}]]) assert.equal(cx(tool, input), null, tool);
  const oc = (tool, input = {}) => planToolDecision(tool, input, { host: 'opencode' });
  for (const tool of ['edit', 'write', 'patch', 'multiedit', 'apply_patch', 'filesystem_write_file', 'github_push_files']) assert.equal(oc(tool), 'deny', tool);
  for (const [tool, input] of [['bash', { command: 'npm install' }], ['bash', { command: 'git stash' }], ['read', {}], ['task', {}], ['question', {}], ['SynaBun_remember', {}], ['SynaBun_agent_dispatch', {}], ['SynaBun_computer', { action: 'left_click' }], ['context7_query-docs', {}], ['filesystem_read_file', {}]]) {
    assert.equal(oc(tool, input), null, tool);
  }
  assert.equal(planToolDecision('Edit', {}, { host: 'claude' }), 'deny');
  assert.equal(planToolDecision('Bash', { command: 'rm -rf x' }, { host: 'claude' }), null);
  // The message says what plan mode allows, and how each host presents its plan.
  assert.match(planDenyMessage('Edit', { host: 'claude' }), /Plan mode blocks code changes only, so SynaBun did not run Edit\. Everything else stays available.*run commands, tests and scripts.*computer.*browser.*ExitPlanMode/);
  assert.match(planDenyMessage('apply_patch', { host: 'codex' }), /<proposed_plan> block/);
  assert.match(planDenyMessage('edit', { host: 'opencode' }), /<proposed_plan> block/);
});

test('plan policy: a Codex grant of file-write access is a code change; network-only grants are not', () => {
  assert.equal(codexGrantWritesFiles({ network: { enabled: true } }), false);
  assert.equal(codexGrantWritesFiles({ fileSystem: { read: ['/repo'] } }), false);
  assert.equal(codexGrantWritesFiles({ fileSystem: { read: ['/repo'], write: [] } }), false);
  assert.equal(codexGrantWritesFiles({ fileSystem: { write: ['/repo'] } }), true);
  assert.equal(codexGrantWritesFiles({ file_system: { entries: [{ path: '/repo', access: 'write' }] } }), true);
  assert.equal(codexGrantWritesFiles({ fileSystem: { entries: [{ path: '/repo', access: 'read' }] } }), false);
  assert.equal(codexGrantWritesFiles({ fileSystem: 'everything' }), true, 'a shape it cannot read counts as a write');
  assert.equal(codexGrantWritesFiles({ fileSystem: { unknown: ['/repo'] } }), true);
  assert.equal(codexGrantWritesFiles(null), false);
});

test('Claude policy: commands and every other tool follow the approval mode, edits never run, reads never ask', () => {
  for (const approvalMode of ['default', 'acceptEdits', 'bypassPermissions']) {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__filesystem__write_file']) {
      assert.equal(claudePlanPermission(tool, { file_path: '/tmp/a' }, { approvalMode, preApproved: [tool] }), 'deny', `${tool} under ${approvalMode}, even pre-approved`);
    }
    for (const [tool, input] of [['Bash', { command: 'git status' }], ['Bash', { command: 'rg -n plan lib' }], ['Read', {}], ['WebSearch', {}], ['mcp__SynaBun__recall', {}], ['mcp__SynaBun__computer', { action: 'screenshot' }]]) {
      assert.equal(claudePlanPermission(tool, input, { approvalMode }), 'allow', `${tool} is a read under ${approvalMode}`);
    }
  }
  const click = { action: 'left_click', coordinate: [10, 10] };
  // Ask ('default') and Accept Edits: anything else asks like outside plan mode (null → the normal card).
  for (const approvalMode of ['default', 'acceptEdits']) {
    assert.equal(claudePlanPermission('Bash', { command: 'npm install' }, { approvalMode }), null);
    assert.equal(claudePlanPermission('mcp__SynaBun__computer', click, { approvalMode }), null);
    assert.equal(claudePlanPermission('mcp__SynaBun__remember', {}, { approvalMode }), null);
  }
  // A tool the brain pre-approves (its allowedTools: computer use) runs as it does outside plan mode.
  assert.equal(claudePlanPermission('mcp__SynaBun__computer', click, { approvalMode: 'default', preApproved: ['mcp__SynaBun__computer'] }), 'allow');
  // Bypass: everything but a code change runs.
  for (const [tool, input] of [['Bash', { command: 'npm install' }], ['Bash', { command: 'sed -i s/a/b/ f' }], ['PowerShell', { command: 'Remove-Item x' }], ['mcp__SynaBun__computer', click], ['mcp__SynaBun__agent_dispatch', { task: 'x' }], ['mcp__other__do_thing', {}]]) {
    assert.equal(claudePlanPermission(tool, input, { approvalMode: 'bypassPermissions' }), 'allow', tool);
  }
});

// Claude: the brain's own ClaudeSession options, end to end through canUseTool and the PreToolUse hook.
function claudeBrainSession(brainState, deps = {}) {
  const captures = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(), includePartialMessages: false, writePlanFile: () => ({ ok: false }),
    queryFactory: ({ options }) => { captures.push(options); const g = (async function* () {})(); g.interrupt = async () => {}; return g; },
  });
  let inner = null;
  class Captured extends ClaudeSession { constructor(ws, opts) { super(ws, opts); inner = this; } }
  const sent = [];
  const brain = createClaudeBrain({ session: { id: 's1', brain: brainState }, sink: { send: (p) => sent.push(p) }, deps: { ClaudeSession: Captured, ...deps } });
  const cards = () => sent.filter((p) => p.type === 'control_request');
  const hook = () => { inner.ensureQuery(); const options = captures.at(-1); return { options, run: (tool_name, tool_input = {}, extra = {}) => options.hooks.PreToolUse.at(-1).hooks[0]({ tool_name, tool_input, ...extra }) }; };
  return { brain, inner: () => inner, sent, cards, hook, captures };
}

test('Claude: in plan mode with Ask, a mutating command gets the normal card, reads and computer use run, edits are refused even when always-allowed', async () => {
  const h = claudeBrainSession({ permissionMode: 'default', planMode: true });
  const session = h.inner();
  assert.equal(session.permissionMode, 'plan');
  assert.equal(await pending(session._onCanUseTool('Bash', { command: 'npm install' }, {})), 'pending');
  assert.equal(h.cards().at(-1).request.tool_name, 'Bash', 'the same card as outside plan mode');
  assert.equal((await session._onCanUseTool('Bash', { command: 'git diff --stat' }, {})).behavior, 'allow');
  assert.equal((await session._onCanUseTool('mcp__SynaBun__computer', { action: 'left_click', coordinate: [5, 5] }, {})).behavior, 'allow', 'computer use is pre-approved, as outside plan mode');
  assert.equal(h.cards().length, 1, 'reads and computer use raise no card');
  session.alwaysAllowed.add('Edit');
  const edit = await session._onCanUseTool('Edit', { file_path: '/tmp/a' }, {});
  assert.equal(edit.behavior, 'deny');
  assert.match(edit.message, /Plan mode blocks code changes only.*ExitPlanMode/);
  // Always-allowed from a card in plan mode: the approval mode's own shortcut still applies.
  session.alwaysAllowed.add('mcp__SynaBun__remember');
  assert.equal((await session._onCanUseTool('mcp__SynaBun__remember', { content: 'x' }, {})).behavior, 'allow');
  await h.brain.dispose();
});

test('Claude: in plan mode with Bypass everything but a code change runs; Accept Edits still refuses edits and asks for commands', async () => {
  const bypass = claudeBrainSession({ permissionMode: 'bypassPermissions', planMode: true });
  const s = bypass.inner();
  for (const [tool, input] of [['Bash', { command: 'npm install' }], ['Bash', { command: 'rm -rf build' }], ['mcp__SynaBun__agent_dispatch', { task: 'x' }], ['mcp__other__do_thing', {}]]) {
    assert.equal((await s._onCanUseTool(tool, input, {})).behavior, 'allow', tool);
  }
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__filesystem__write_file']) assert.equal((await s._onCanUseTool(tool, { file_path: '/tmp/a' }, {})).behavior, 'deny', tool);
  assert.equal(bypass.cards().length, 0);
  await bypass.brain.dispose();
  const accept = claudeBrainSession({ permissionMode: 'acceptEdits', planMode: true });
  const a = accept.inner();
  assert.equal((await a._onCanUseTool('Write', { file_path: '/tmp/a' }, {})).behavior, 'deny');
  assert.equal(await pending(a._onCanUseTool('Bash', { command: 'npm install' }, {})), 'pending');
  assert.equal(accept.cards().at(-1).request.tool_name, 'Bash');
  await accept.brain.dispose();
});

test('Claude: the plan hook refuses edits before allow rules (subagents too) and lets commands, computer use and SynaBun tools through; the plan text rides in the CLI reminder', async () => {
  const h = claudeBrainSession({ permissionMode: 'default', planMode: true });
  const { options, run } = h.hook();
  assert.equal(options.permissionMode, 'plan');
  assert.equal(options.planModeInstructions, planModeInstructions({ provider: 'claude-code' }));
  for (const [tool, input, extra] of [['Edit', { file_path: '/tmp/a' }, {}], ['Write', { file_path: '/tmp/a' }, { agent_id: 'sub-1' }], ['MultiEdit', {}, {}], ['NotebookEdit', {}, {}], ['mcp__filesystem__write_file', { path: '/tmp/a' }, {}]]) {
    const out = await run(tool, input, extra);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', tool);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Plan mode blocks code changes only/);
  }
  for (const [tool, input, extra] of [['Bash', { command: 'find . -delete' }, {}], ['Bash', { command: 'npm test' }, { agent_id: 'sub-1' }], ['PowerShell', { command: 'ls' }, {}], ['mcp__SynaBun__agent_dispatch', { task: 'x' }, {}], ['mcp__SynaBun__agent_send', {}, {}], ['mcp__SynaBun__remember', {}, {}], ['mcp__SynaBun__computer', { action: 'left_click' }, {}], ['mcp__SynaBun__browser_click', {}, {}], ['Read', {}, {}]]) {
    assert.deepEqual(await run(tool, input, extra), {}, tool);
  }
  // The plan approved (permissionMode flips synchronously in _handleExitPlan): the hook steps aside.
  h.inner().permissionMode = 'default';
  assert.deepEqual(await run('Edit', { file_path: '/tmp/a' }), {});
  await h.brain.dispose();
  // The sidepanel (no plan options) gets neither the hook nor the plan text.
  new ClaudeSession({ readyState: 1, bufferedAmount: 0, send() {} }, { permissionMode: 'plan' }).ensureQuery();
  assert.equal(h.captures.at(-1).hooks.PreToolUse, undefined);
  assert.equal(h.captures.at(-1).planModeInstructions, undefined);
});

test('Claude: an approved plan hands asks back to the approval mode (edits no longer refused)', async () => {
  const h = claudeBrainSession({ permissionMode: 'default', planMode: true });
  const session = h.inner();
  const exit = session._onCanUseTool('ExitPlanMode', { plan: 'Do the thing' }, {});
  assert.equal(await pending(exit), 'pending');
  const card = h.cards().at(-1);
  assert.equal(card.request.tool_name, 'ExitPlanMode');
  session._resolvePermission(card.request_id, { behavior: 'allow' });
  assert.equal((await exit).behavior, 'allow');
  assert.equal(session.permissionMode, 'default');
  assert.equal(await pending(session._onCanUseTool('Edit', { file_path: '/tmp/a' }, {})), 'pending', 'an edit is asked like in any approval mode');
  assert.equal(h.cards().at(-1).request.tool_name, 'Edit');
  // AskUserQuestion is a question, never auto-answered.
  session.permissionMode = 'plan';
  assert.equal(await pending(session._onCanUseTool('AskUserQuestion', { questions: [] }, {})), 'pending');
  await h.brain.dispose();
});

test('Claude: a WhatsApp session at the read-only level keeps plan mode read-only (read at every call); at Ask it plans like the desktop', async () => {
  let level = 'read-only';
  const h = claudeBrainSession({ permissionMode: 'default', planMode: true }, { remoteLevel: 'read-only', planReadOnly: () => level === 'read-only' });
  const session = h.inner();
  const { options, run } = h.hook();
  assert.equal(options.planModeInstructions, undefined, 'a remote session keeps the CLI\'s read-only plan wording');
  const refused = await session._onCanUseTool('Bash', { command: 'npm install' }, {});
  assert.equal(refused.behavior, 'deny');
  assert.match(refused.message, /Plan mode is read-only/);
  assert.equal((await session._onCanUseTool('Bash', { command: 'git status' }, {})).behavior, 'allow');
  for (const [tool, input] of [['Bash', { command: 'find . -delete' }], ['mcp__SynaBun__remember', {}], ['mcp__SynaBun__agent_dispatch', {}], ['Edit', {}]]) {
    assert.equal((await run(tool, input)).hookSpecificOutput?.permissionDecision, 'deny', tool);
  }
  // The level rises to Ask without a restart: plan mode now refuses code changes only.
  level = 'ask';
  assert.equal(await pending(session._onCanUseTool('Bash', { command: 'npm install' }, {})), 'pending');
  assert.deepEqual(await run('mcp__SynaBun__remember', {}), {});
  assert.match((await session._onCanUseTool('Edit', { file_path: '/tmp/a' }, {})).message, /blocks code changes only/);
  await h.brain.dispose();
});

// Codex: the real brain behind a fake app-server socket.
function codexHarness(brainState, extraDeps = {}) {
  let socket = null;
  const received = [];
  const sinkPackets = [];
  const brain = createCodexBrain({
    session: { id: 's1', brain: brainState },
    sink: { send: (p) => sinkPackets.push(p) },
    persona: 'PERSONA',
    deps: {
      ...extraDeps,
      handleCodexSkinWebSocket: (ws) => {
        socket = ws;
        ws.on('message', (raw) => { const m = JSON.parse(String(raw)); received.push(m); if (m.type === 'bootstrap') ws.send({ type: 'ready' }); });
      },
    },
  });
  const request = (requestId, method, params = {}) => socket.send({ type: 'server_request', requestId, method, params: { threadId: 't1', ...params } });
  const replies = () => received.filter((m) => m.type === 'server_request_response');
  const replyTo = (id) => replies().find((m) => m.requestId === id) || null;
  const cards = () => sinkPackets.filter((p) => p.type === 'control_request');
  return { brain, request, replies, replyTo, cards, received };
}
const codexMcp = (tool, serverName = 'SynaBun', params = {}) => ({ serverName, _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: tool, tool_params: params } });

test('Codex: plan mode with Ask declines patches and file-write grants, runs reads, and shows the normal card for commands, network and MCP tools', async () => {
  const h = codexHarness({ permissionMode: 'default', planMode: true });
  h.request(1, 'item/commandExecution/requestApproval', { command: 'npm install' });
  h.request(2, 'item/commandExecution/requestApproval', { command: 'git status' });
  h.request(3, 'item/fileChange/requestApproval', { itemId: 'i1' });
  h.request(4, 'item/permissions/requestApproval', { permissions: { network: { enabled: true } } });
  h.request(5, 'item/permissions/requestApproval', { permissions: { fileSystem: { write: ['/repo'] } } });
  h.request(6, 'mcpServer/elicitation/request', codexMcp('recall'));
  h.request(7, 'mcpServer/elicitation/request', codexMcp('computer', 'SynaBun', { action: 'left_click' }));
  h.request(8, 'mcpServer/elicitation/request', codexMcp('write_file', 'filesystem'));
  h.request(9, 'item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Which?' }] });
  assert.equal(h.replyTo(2).result.decision, 'accept', 'a read-only command runs without a card');
  assert.equal(h.replyTo(3).result.decision, 'decline', 'a patch is a code change');
  assert.deepEqual(h.replyTo(5).result, { permissions: {}, scope: 'turn' }, 'a file-write grant is a code change');
  assert.equal(h.replyTo(6).result.action, 'accept');
  assert.equal(h.replyTo(8).result.action, 'decline', 'a file-writing MCP tool is a code change');
  for (const id of [1, 4, 7, 9]) assert.equal(h.replyTo(id), null, `request ${id} waits for the user`);
  assert.deepEqual(h.cards().map((c) => c.request.tool_name), ['Bash', 'Permissions', 'AskUserQuestion', 'AskUserQuestion'], 'the normal cards: command, network grant, MCP approval, question');
  await h.brain.sendUserTurn({ text: 'plan it' });
  const query = h.received.find((m) => m.type === 'query');
  assert.equal(query.planMode, true);
  assert.equal(query.autoAccept, false, 'the brain\'s policy sees every approval');
  assert.equal(query.developerInstructions, `PERSONA\n\n${planModeInstructions({ provider: 'codex' })}`, 'a plan turn carries what plan mode means');
  await h.brain.dispose();
});

test('Codex: plan mode with Auto-accept runs commands, escalations, network grants and MCP tools, and still declines every code change', async () => {
  const h = codexHarness({ permissionMode: 'auto', planMode: true });
  h.request(1, 'item/commandExecution/requestApproval', { command: 'touch x' });
  h.request(2, 'item/fileChange/requestApproval', { itemId: 'i1' });
  h.request(3, 'item/permissions/requestApproval', { permissions: { network: { enabled: true } } });
  h.request(4, 'item/permissions/requestApproval', { permissions: { fileSystem: { write: ['/repo'] } } });
  h.request(5, 'mcpServer/elicitation/request', codexMcp('computer', 'SynaBun', { action: 'left_click' }));
  h.request(6, 'mcpServer/elicitation/request', codexMcp('edit_file', 'filesystem'));
  assert.equal(h.replyTo(1).result.decision, 'acceptForSession', 'as Auto-accept does outside plan mode');
  assert.equal(h.replyTo(2).result.decision, 'decline');
  assert.deepEqual(h.replyTo(3).result, { permissions: { network: { enabled: true } }, scope: 'session' });
  assert.deepEqual(h.replyTo(4).result, { permissions: {}, scope: 'turn' });
  assert.equal(h.replyTo(5).result.action, 'accept', 'a computer click runs under auto');
  assert.equal(h.replyTo(6).result.action, 'decline');
  assert.equal(h.cards().length, 0);
  // Leaving plan restores each mode: auto accepts a patch again, default shows its card.
  await h.brain.setPermissionMode('auto', { planMode: false });
  h.request(7, 'item/fileChange/requestApproval', { itemId: 'i2' });
  assert.match(h.replyTo(7).result.decision, /^accept/);
  await h.brain.setPermissionMode('default', { planMode: false });
  h.request(8, 'item/fileChange/requestApproval', { itemId: 'i3' });
  assert.equal(h.replyTo(8), null);
  assert.equal(h.cards().at(-1).request.tool_name, 'Edit', 'approval "default" outside plan shows the card');
  await h.brain.sendUserTurn({ text: 'go', planMode: false });
  assert.equal(h.received.filter((m) => m.type === 'query').at(-1).developerInstructions, 'PERSONA', 'a turn outside plan carries the persona only');
  await h.brain.dispose();
});

test('Codex brain of a WhatsApp session: the read-only sandbox (network off) on every turn and compact, every escalation declined, even outside plan mode', async () => {
  const h = codexHarness({ permissionMode: 'auto', planMode: false }, { remoteReadOnly: true });
  await h.brain.sendUserTurn({ text: 'look around', permissionMode: 'auto', planMode: false });
  const query = h.received.find((m) => m.type === 'query');
  assert.equal(query.sandboxMode, 'read-only');
  assert.equal(query.autoAccept, false, 'auto-accept never applies');
  await h.brain.compact();
  assert.equal(h.received.filter((m) => m.type === 'query').at(-1).sandboxMode, 'read-only', '/compact too');
  h.request(1, 'item/commandExecution/requestApproval', { command: 'touch x' });
  h.request(2, 'item/fileChange/requestApproval', { itemId: 'i' });
  h.request(3, 'item/permissions/requestApproval', { permissions: { network: true } });
  const [cmd, patch, grant] = h.replies();
  assert.deepEqual([cmd.result.decision, patch.result.decision], ['decline', 'decline']);
  assert.deepEqual(grant.result, { permissions: {}, scope: 'turn' }, 'a permission grant: nothing granted');
  assert.equal(h.cards().length, 0, 'nothing to approve on a phone');
  // Planning too: the read-only classifier answers, and no plan text rides along.
  await h.brain.sendUserTurn({ text: 'plan', planMode: true });
  assert.equal(h.received.filter((m) => m.type === 'query').at(-1).developerInstructions, 'PERSONA');
  h.request(4, 'item/commandExecution/requestApproval', { command: 'npm test' });
  assert.equal(h.replyTo(4).result.decision, 'decline');
  await h.brain.dispose();
  // A desktop Codex brain keeps its configured sandbox.
  const desk = codexHarness({ permissionMode: 'default', planMode: false });
  await desk.brain.sendUserTurn({ text: 'x' });
  assert.equal(desk.received.find((m) => m.type === 'query').sandboxMode, undefined);
  await desk.brain.dispose();
});

// OpenCode

test('OpenCode: plan mode refuses the edit family and file-writing MCP tools, runs reads, and hands commands and tools to the approval mode', () => {
  const ask = (tool, command = null, kind = 'permission') => ({ request: { tool_name: tool, input: command ? { metadata: { command } } : {}, brain_native: { kind } } });
  for (const approvalMode of ['default', 'auto']) {
    const decide = (packet) => opencodeAutoDecision(packet, { approvalMode, planMode: true });
    for (const tool of ['edit', 'write', 'patch', 'multiedit', 'apply_patch', 'filesystem_write_file']) assert.equal(decide(ask(tool)), 'deny', `${tool} under ${approvalMode}`);
    for (const [tool, command] of [['bash', 'git status'], ['bash', 'rg -n plan lib'], ['read'], ['webfetch'], ['external_directory'], ['SynaBun_recall']]) assert.equal(decide(ask(tool, command)), 'allow', `${tool} ${command || ''} is a read`);
    assert.equal(decide(ask('q', null, 'question')), null, 'questions are the user\'s');
  }
  const ask_ = (packet) => opencodeAutoDecision(packet, { approvalMode: 'default', planMode: true });
  const auto = (packet) => opencodeAutoDecision(packet, { approvalMode: 'auto', planMode: true });
  for (const [tool, command] of [['bash', 'npm install'], ['bash', 'git stash'], ['SynaBun_computer'], ['SynaBun_remember'], ['SynaBun_agent_dispatch']]) {
    assert.equal(ask_(ask(tool, command)), null, `${tool} ${command || ''}: the normal card under Ask`);
    assert.equal(auto(ask(tool, command)), 'allow', `${tool} ${command || ''}: runs under Auto-accept`);
  }
  // Outside plan mode nothing changed.
  assert.equal(opencodeAutoDecision(ask('edit'), { approvalMode: 'auto', planMode: false }), 'allow');
  assert.equal(opencodeAutoDecision(ask('webfetch'), { approvalMode: 'default', planMode: false }), null);
});

test('OpenCode: the assistant serve installs SynaBun\'s plan agent (edit family denied, every command asked) beside OpenCode\'s own plan agent', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'asst-plan-oc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'opencode'), { recursive: true });
  writeFileSync(resolve(root, 'opencode', 'config.json'), JSON.stringify({ agent: { plan: { permission: { webfetch: 'allow' } } } }));
  assert.equal(patchOpenCodeAssistantConfig(root, { persona: 'p' }), true);
  const config = JSON.parse(readFileSync(resolve(root, 'opencode', 'config.json'), 'utf8'));
  const agent = config.agent[OPENCODE_PLAN_AGENT];
  assert.equal(OPENCODE_PLAN_AGENT, 'synabun-plan', 'not "plan": OpenCode adds its read-only reminder to that name only');
  assert.deepEqual(agent.permission, { edit: 'deny', bash: 'ask', question: 'allow', task: { general: 'deny' } });
  assert.deepEqual([agent.mode, agent.hidden, agent.prompt], ['primary', true, 'p']);
  assert.deepEqual(config.agent.plan.permission, { webfetch: 'allow', bash: 'ask' }, 'OpenCode\'s own plan agent (a WhatsApp session\'s) still asks for every command');
  assert.equal(config.agent.assistant.mode, 'primary');
});

function openCodeClient(reply = () => 'ok') {
  const prompts = [];
  const replies = [];
  let listener = null;
  const client = {
    waitUntilConnected: async () => {},
    session: {
      create: async () => ({ data: { id: 'oc-1' } }),
      promptAsync: async (request) => { prompts.push(request); const text = reply(request); setTimeout(() => { listener?.({ eventType: 'message.updated', event: { info: { id: `m${prompts.length}`, role: 'assistant', sessionID: 'oc-1' } } }); listener?.({ eventType: 'message.part.updated', event: { part: { id: `p${prompts.length}`, messageID: `m${prompts.length}`, sessionID: 'oc-1', type: 'text', text } } }); listener?.({ eventType: 'session.idle', event: { sessionID: 'oc-1' } }); }, 5); return { status: 200, data: {} }; },
      abort: async () => {},
    },
    permission: { reply: async (body) => { replies.push(body); return {}; } },
    mcp: { status: async () => ({ data: [] }) },
    onEvent: (fn) => { listener = fn; return () => { listener = null; }; },
  };
  const emit = (eventType, event) => listener?.({ eventType, event: { sessionID: 'oc-1', ...event } });
  return { client, prompts, replies, emit };
}

test('OpenCode brain: a desktop plan turn runs on SynaBun\'s plan agent with the plan text; asks follow the approval mode; a WhatsApp session keeps OpenCode\'s read-only plan agent', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'asst-plan-ocb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'opencode'), { recursive: true });
  writeFileSync(resolve(root, 'opencode', 'config.json'), JSON.stringify({ mcp: { SynaBun: { environment: {} } } }));
  const oc = openCodeClient();
  const sent = [];
  const deps = { ensureIsolatedServe: async () => ({ client: oc.client, sessions: new Set() }), stopIsolatedServe: () => {}, setupOpencodeSidepanelConfig: () => root };
  const brain = createOpenCodeBrain({ session: { id: 'plan-1', brain: { provider: 'opencode', permissionMode: 'default', planMode: true } }, sink: { send: (p) => sent.push(p) }, persona: 'PERSONA', deps });
  t.after(() => brain.dispose());
  await brain.sendUserTurn({ text: 'plan the cache move', planMode: true });
  assert.deepEqual([oc.prompts[0].agent, oc.prompts[0].system], [OPENCODE_PLAN_AGENT, OPENCODE_PLAN_INSTRUCTIONS]);
  // Asks under Ask: a read runs, a mutating command and a computer click get the normal card, an edit is refused.
  oc.emit('permission.asked', { id: 'r1', permission: 'bash', patterns: ['git status'], metadata: { command: 'git status' } });
  oc.emit('permission.asked', { id: 'r2', permission: 'bash', patterns: ['npm install'], metadata: { command: 'npm install' } });
  oc.emit('permission.asked', { id: 'r3', permission: 'SynaBun_computer', metadata: { action: 'left_click' } });
  oc.emit('permission.asked', { id: 'r4', permission: 'edit', patterns: ['src/a.js'], metadata: { filepath: 'src/a.js' } });
  await waitFor(() => oc.replies.length === 2);
  assert.deepEqual(oc.replies.map((r) => [r.requestID, r.reply]), [['r1', 'once'], ['r4', 'reject']]);
  assert.match(oc.replies[1].message, /Plan mode blocks code changes only.*<proposed_plan>/);
  assert.deepEqual(sent.filter((p) => p.type === 'control_request').map((p) => p.request_id), ['r2', 'r3']);
  // Auto-accept: the command runs, the edit is still refused.
  await brain.setPermissionMode('auto', { planMode: true });
  oc.emit('permission.asked', { id: 'r5', permission: 'bash', patterns: ['npm install'], metadata: { command: 'npm install' } });
  oc.emit('permission.asked', { id: 'r6', permission: 'write', patterns: ['src/b.js'], metadata: { filepath: 'src/b.js' } });
  await waitFor(() => oc.replies.length === 4);
  assert.deepEqual(oc.replies.slice(2).map((r) => [r.requestID, r.reply]), [['r5', 'once'], ['r6', 'reject']]);
  // Out of plan: the assistant agent, no plan text.
  await brain.setPermissionMode('default', { planMode: false });
  await brain.sendUserTurn({ text: 'do it', planMode: false });
  assert.equal(oc.prompts[1].agent, 'assistant');
  assert.equal(oc.prompts[1].system, undefined);
  // A WhatsApp session: OpenCode's own plan agent, the persona only, the read-only classifier on asks.
  const remote = openCodeClient();
  const remoteSent = [];
  const remoteBrain = createOpenCodeBrain({ session: { id: 'remote-1', brain: { provider: 'opencode', planMode: true } }, sink: { send: (p) => remoteSent.push(p) }, persona: 'PERSONA', deps: { ...deps, ensureIsolatedServe: async () => ({ client: remote.client, sessions: new Set() }), remoteReadOnly: true } });
  t.after(() => remoteBrain.dispose());
  await remoteBrain.sendUserTurn({ text: 'look around', planMode: true });
  assert.deepEqual([remote.prompts[0].agent, remote.prompts[0].system], ['plan', 'PERSONA']);
  remote.emit('permission.asked', { id: 'w1', permission: 'bash', patterns: ['npm install'], metadata: { command: 'npm install' } });
  await waitFor(() => remote.replies.length === 1);
  assert.equal(remote.replies[0].reply, 'reject');
  assert.match(remote.replies[0].message, /Plan mode is read-only/);
});

// ── the runtime's gate (Codex hook / OpenCode plugin), the API, routing ──────

function runtimeHarness(t, { remotePolicy = null } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'asst-plan-rt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const created = [];
  const factory = ({ session, sink, deps, hooks }) => {
    created.push({ deps, hooks });
    return {
      kind: session.brain.provider, gateMode: null, sink,
      async start() {}, async sendUserTurn() { setTimeout(() => sink.send({ type: 'done', code: 0 }), 5); },
      async abort() {}, isBusy: () => false, identity: () => ({ providerSessionId: 'oc-main' }), async dispose() {}, async setPermissionMode() {},
    };
  };
  const router = { owns: () => false, pendingCards: () => [], cancelForSession() {}, stamp: () => ({ text: '', changed: false, commit() {} }) };
  const runtime = createAssistantRuntime({
    dataDir: dir, brainFactories: { 'claude-code': factory, opencode: factory, codex: factory }, router,
    catalog: { peek: () => ({ models: {} }), brainInfo: () => null, hiddenId: () => null }, gateUrl: 'http://127.0.0.1:1/api/assistant/route-gate/check',
    codexGateBootstrap: async () => null, ...(remotePolicy ? { remotePolicy } : {}),
  });
  t.after(() => runtime.shutdown());
  return { runtime, created };
}

test('runtime: plan turns skip routing; commands, computer use and SynaBun tools run, edits and file-writing MCP tools are refused (subagents too); approval routes the work', async (t) => {
  const { runtime, created } = runtimeHarness(t);
  const session = await runtime.createSession({ brain: { provider: 'opencode', planMode: true } });
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.runQuery(live, { text: 'plan the refactor' });
  const { token } = created[0].deps.routeGate;
  const check = (tool, input = {}, providerSessionId = 'oc-main') => runtime.gateCheck({ session: session.id, token, tool, input, providerSessionId, host: 'opencode' });
  assert.equal(runtime.isPlanning(session.id), true);
  assert.equal(runtime.isPlanReadOnly(session.id), false);
  for (const [tool, input] of [['bash', { command: 'git status' }], ['bash', { command: 'git stash' }], ['bash', { command: 'npm test' }], ['read', {}], ['SynaBun_agent_route', {}], ['SynaBun_agent_dispatch', { task: 'x' }], ['SynaBun_computer', { action: 'left_click' }], ['SynaBun_remember', {}]]) {
    assert.equal(check(tool, input).allow, true, `${tool} ${input.command || ''}: no agent_route needed while planning`);
  }
  for (const tool of ['edit', 'write', 'patch', 'filesystem_write_file']) {
    const refused = check(tool, { filePath: 'src/a.js' });
    assert.equal(refused.allow, false, tool);
    assert.match(refused.reason, /Plan mode blocks code changes only.*<proposed_plan>/);
  }
  assert.equal(check('write', { filePath: 'x' }, 'oc-explore-child').allow, false, 'a subagent session is refused too');
  assert.equal(check('bash', { command: 'rm -rf build' }, 'oc-explore-child').allow, true, 'a subagent runs commands too');
  assert.equal(live.gate.snapshot().refusals, 0, 'plan refusals never feed the route loop guard');
  // Codex's hook: a patch is refused, commands and SynaBun tools run.
  const codex = await runtime.createSession({ brain: { provider: 'codex', planMode: true } });
  const codexLive = runtime._internals.sessions.get(codex.id);
  await runtime._internals.runQuery(codexLive, { text: 'plan it' });
  const cx = (tool, input = {}) => runtime.gateCheck({ session: codex.id, token: codexLive.gateToken, tool, input, host: 'codex' });
  assert.equal(cx('apply_patch').allow, false);
  assert.equal(cx('mcp__filesystem__write_file').allow, false);
  for (const [tool, input] of [['Bash', { command: 'rm -rf build' }], ['mcp__SynaBun__computer', { action: 'left_click' }], ['mcp__SynaBun__agent_dispatch', {}]]) assert.equal(cx(tool, input).allow, true, tool);
  // The plan approved mid-turn (the brain reports it): the work is routed first.
  runtime._internals.onBrainPacket(live, { type: 'mode_changed', mode: 'default', planMode: false });
  assert.equal(runtime.isPlanning(session.id), false);
  assert.equal(live.gate.snapshot().state, 'unrouted');
  assert.equal(check('bash', { command: 'git stash' }).allow, false, 'now the route gate asks for agent_route');
  assert.match(check('bash', { command: 'git stash' }).reason, /agent_route/);
});

test('runtime: a WhatsApp session at the read-only level plans read-only (the read-only classifier, its message, the 409)', async (t) => {
  const registry = createRemotePolicyRegistry();
  const { runtime, created } = runtimeHarness(t, { remotePolicy: registry });
  const session = await runtime.createSession({ brain: { provider: 'opencode', planMode: true } }, { remote: { level: 'read-only', channel: 'whatsapp' } });
  const live = runtime._internals.sessions.get(session.id);
  live.gatePluginAt = Date.now(); // the plugin said hello
  await runtime._internals.runQuery(live, { text: 'look around' });
  const { token } = created[0].deps.routeGate;
  const check = (tool, input = {}) => runtime.gateCheck({ session: session.id, token, tool, input, inputComplete: true, providerSessionId: 'oc-main', host: 'opencode' });
  assert.equal(runtime.isPlanning(session.id), true);
  assert.equal(runtime.isPlanReadOnly(session.id), true);
  assert.equal(check('bash', { command: 'git status' }).allow, true);
  const refused = check('bash', { command: 'git stash' });
  assert.equal(refused.allow, false);
  assert.match(refused.reason, /Plan mode is read-only/);
  assert.equal(check('SynaBun_agent_dispatch', { task: 'x' }).allow, false);
  // A desktop session in plan mode is not read-only.
  const desk = await runtime.createSession({ brain: { provider: 'opencode', planMode: true } });
  assert.equal(runtime.isPlanReadOnly(desk.id), false);
});

async function apiHarness(t, runtime, runs) {
  const dispatched = [];
  const sent = [];
  const dispatcher = {
    limits: {}, list: () => [], totals: () => ({}),
    get: (id) => runs[id] || null,
    dispatch: async (spec, meta) => { dispatched.push({ spec, meta }); return { ok: true, queued: false, run: { runId: 'run-new', capability: spec.capability, notes: [...(meta.notes || [])] } }; },
    sendTurn: (runId, text) => { sent.push([runId, text]); return { ok: true }; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher, runtime, isGuestRequest: () => false, broadcastSync() {} }));
  const server = await new Promise((done) => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}/api/assistant`;
  const call = async (path, body, pin) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(pin ? { 'X-Synabun-Terminal': pin } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  return { call, dispatched, sent };
}

test('API: a planning brain dispatches read-only workers and steers only read-only ones; the user and a brain out of plan mode are not limited', async (t) => {
  const { runtime } = runtimeHarness(t);
  const planning = await runtime.createSession({ brain: { provider: 'claude-code', planMode: true } });
  const working = await runtime.createSession({ brain: { provider: 'claude-code' } });
  const runs = {
    'run-full': { runId: 'run-full', assistantSessionId: planning.id, capability: 'full' },
    'run-ws': { runId: 'run-ws', assistantSessionId: planning.id, capability: 'workspace' },
    'run-ro': { runId: 'run-ro', assistantSessionId: planning.id, capability: 'read-only' },
  };
  const { call, dispatched, sent } = await apiHarness(t, runtime, runs);
  const task = { provider: 'claude-code', task: 'look into the cache', cwd: process.cwd(), capability: 'full' };
  const clamped = await call('/dispatch', task, planning.id);
  assert.equal(clamped.status, 200);
  assert.equal(dispatched[0].spec.capability, 'read-only', 'the worker cannot change code');
  assert.deepEqual(dispatched[0].meta.notes, [PLAN_DISPATCH_NOTE], 'the run\'s notes say why');
  assert.deepEqual(clamped.json.planMode, { capability: 'read-only', note: PLAN_DISPATCH_NOTE }, 'and so does the answer');
  assert.equal(clamped.json.run.capability, 'read-only');
  const asked = await call('/dispatch', { ...task, capability: 'read-only' }, planning.id);
  assert.deepEqual([asked.status, dispatched[1].meta.notes], [200, []], 'already read-only: nothing to note on the run');
  for (const runId of ['run-full', 'run-ws']) {
    const refused = await call(`/runs/${runId}/send`, { text: 'now edit it' }, planning.id);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'PLAN_MODE_CODE_CHANGE');
    assert.match(refused.json.error, /can change code/);
  }
  assert.equal((await call('/runs/run-ro/send', { text: 'also check the tests' }, planning.id)).status, 200, 'a read-only worker is steered');
  assert.equal((await call('/runs/run-full/send', { text: 'from the user' })).status, 200, 'the UI is never refused');
  assert.deepEqual(sent, [['run-ro', 'also check the tests'], ['run-full', 'from the user']]);
  // A brain out of plan mode dispatches what it asks for.
  const free = await call('/dispatch', task, working.id);
  assert.equal(dispatched[2].spec.capability, 'full');
  assert.equal(dispatched[2].meta.notes, undefined);
  assert.equal(free.json.planMode, undefined);
});

test('API: a WhatsApp session at the read-only level still starts and steers no worker (409 PLAN_MODE_READ_ONLY)', async (t) => {
  const registry = createRemotePolicyRegistry();
  const { runtime } = runtimeHarness(t, { remotePolicy: registry });
  const session = await runtime.createSession({ brain: { provider: 'claude-code', planMode: true } }, { remote: { level: 'read-only', channel: 'whatsapp' } });
  const { call, dispatched, sent } = await apiHarness(t, runtime, { 'run-ro': { runId: 'run-ro', assistantSessionId: session.id, capability: 'read-only' } });
  const refused = await call('/dispatch', { provider: 'claude-code', task: 'x', cwd: process.cwd() }, session.id);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'PLAN_MODE_READ_ONLY');
  assert.equal((await call('/runs/run-ro/send', { text: 'x' }, session.id)).json.code, 'PLAN_MODE_READ_ONLY');
  assert.deepEqual([dispatched, sent], [[], []]);
});

// The real router and dispatcher: route → dispatch completes for a read-only worker.
function routingHarness(t, mode) {
  const root = mkdtempSync(resolve(tmpdir(), 'asst-plan-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const RESULT = '## Result\nstatus: done\nsummary: looked\nchanges:\n- none\nfollow_ups:\n- none';
  const adapter = (state) => ({ identity: () => ({ providerSessionId: `sess-${state.runId.slice(0, 4)}` }), isAlive: () => true, async runTurn() { return { text: RESULT, costUsd: 0.01 }; }, async abort() {}, async dispose() {} });
  const runtime = new NativeLoopRuntime({
    stateDir: resolve(root, 'loop'), ledgerPath: resolve(root, 'runs.json'), buildPrompt: () => 'LOOP', iterationDelayMs: 0,
    providerFactories: { codex: async (s) => adapter(s), 'claude-code': async (s) => adapter(s), opencode: async (s) => adapter(s) },
  });
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING, readHidden: () => [] });
  let dispatcher = null;
  const sessions = new Map([['assistant-1', { brain: { provider: 'claude-code' }, routingMode: mode }]]);
  const cards = [];
  const router = createAssistantRouter({
    catalog, configStore: { routing: () => effectiveRouting({}), setPreference() {} },
    getSession: (id) => sessions.get(id) || null,
    sinks: {
      sendCard: (sid, packet) => cards.push(packet), routeEvent() {}, mailbox() {}, cancelCard() {},
      startHeld: (runId, target, meta) => dispatcher.resolveRoute(runId, { target, ...meta }),
      declineHeld: (runId, reason) => dispatcher.declineRoute(runId, { reason }),
    },
  });
  dispatcher = createAssistantDispatcher({
    getRuntime: () => runtime, dataDir: root, loopDir: resolve(root, 'loop'), PACKAGE_ROOT: root,
    getCodexAccount: () => ({ id: 'default', home: '/tmp/codex' }), findCodexAccount: () => null, CODEX_DEFAULT_HOME: '/tmp/codex',
    detectProject: () => 'proj', limits: { minIdleTimeoutMs: 50 }, router, catalog,
  });
  t.after(() => { router.shutdown(); dispatcher.shutdown('test'); });
  return { dispatcher, router, cards };
}

test('dispatch: a planning brain\'s worker stays read-only through routing — an approved route starts it at once, a held run after the user\'s pick', async (t) => {
  const planned = () => { const notes = []; return { spec: clampPlanDispatch({ provider: 'claude-code', task: 'map the cache readers', capability: 'workspace', title: 'Map readers' }, { notes }), notes }; };
  // Never ask: the route is approved at once and the worker starts.
  const auto = routingHarness(t, 'never');
  const first = planned();
  const started = await auto.dispatcher.dispatch(first.spec, { assistantSessionId: 'assistant-1', origin: 'assistant', notes: first.notes });
  assert.equal(started.queued, false);
  assert.equal(started.run.capability, 'read-only');
  assert.ok(started.run.notes.includes(PLAN_DISPATCH_NOTE));
  // Always ask: held on a route card (not forever: the user's pick starts it), and still read-only.
  const ask = routingHarness(t, 'always-ask');
  const second = planned();
  const held = await ask.dispatcher.dispatch(second.spec, { assistantSessionId: 'assistant-1', origin: 'assistant', notes: second.notes });
  assert.equal(held.awaitingRoute, true);
  assert.equal(held.run.capability, 'read-only');
  const card = ask.cards[0];
  await ask.router.answer(card.request_id, { optionId: card.request.options[0].id });
  const run = await waitFor(() => { const r = ask.dispatcher.get(held.run.runId); return r.state === 'idle' ? r : null; });
  assert.equal(run.capability, 'read-only', 'the user\'s pick keeps the read-only capability');
  assert.ok(run.notes.includes(PLAN_DISPATCH_NOTE));
  assert.equal(runCanChangeCode(run), false);
  assert.equal(runCanChangeCode({ capability: 'workspace' }), true);
  assert.equal(runCanChangeCode({}), true, 'an unknown capability reads as full');
});

test('instructions: every brain is told plan mode blocks code changes only, shell edits included', () => {
  for (const provider of ['claude-code', 'codex', 'opencode']) {
    const text = planModeInstructions({ provider });
    assert.match(text, /blocks code changes and nothing else/, provider);
    assert.match(text, /run commands, tests, builds and scripts; use the computer and the SynaBun browser; use every other tool/, provider);
    assert.match(text, /editing files through the shell \(sed -i, tee/, provider);
    assert.match(text, /agent_dispatch starts them read-only/, provider);
  }
  const claude = planModeInstructions({ provider: 'claude-code' });
  assert.match(claude, /ExitPlanMode/);
  assert.match(claude, /subagent you launch/);
  assert.doesNotMatch(claude, /<proposed_plan>/);
  for (const provider of ['codex', 'opencode']) assert.match(planModeInstructions({ provider }), /<proposed_plan>\n# Title/);
  assert.match(planModeInstructions({ provider: 'codex' }), /escalated permissions/);
  assert.equal(OPENCODE_PLAN_INSTRUCTIONS, planModeInstructions({ provider: 'opencode' }));
});
