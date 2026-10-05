// Review 1 of the Claude panel parity build (R03 to R14): one test per finding,
// each failing without its fix. Pure logic is imported; what lives in the
// monolith (it cannot be imported outside a browser) is pinned by source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { slashCommandRoute } from '../public/shared/cp/cp-events.js';
import { sessionActionsAvailable, sessionOpsSupported } from '../public/shared/cp/cp-sessions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const panel = read('public/shared/ui-claude-panel.js');
const caps = (...names) => ({ capabilities: new Set(names) });
const has = (tab) => (name) => !!tab.capabilities?.has(name);

// ── R03: a hello without capabilities (a server that was not restarted) ──

test('R03: a command the old bridge ran keeps going to the CLI when its replacement is not supported', () => {
  const oldServer = { has: () => false };
  // The CLI ran these itself before the rebuild; the local handlers need bridge support.
  for (const [cmd, spec] of [
    ['add-dir', { name: 'add-dir' }],
    ['context', { name: 'context' }],
    ['mcp', { name: 'mcp' }],
    ['init', { name: 'init' }],
    ['doctor', { name: 'doctor' }],
    ['usage', { name: 'usage', needs: 'session_requests' }],
    ['fast', { name: 'fast', needs: 'session_settings' }],
    ['output-style', { name: 'output-style', needs: 'session_settings' }],
    ['unknown-skill', null],
  ]) assert.equal(slashCommandRoute(cmd, spec, oldServer), 'cli', `/${cmd} must reach the CLI`);
  // Answered from what the session itself reported: no bridge support needed.
  for (const cmd of ['status', 'permissions', 'agents', 'plugin', 'help', 'clear', 'tasks']) {
    assert.equal(slashCommandRoute(cmd, { name: cmd }, oldServer), 'local', `/${cmd} is answered by the panel`);
  }
});

test('R03: with the capability the panel answers; init and doctor always stay with the CLI', () => {
  const tab = caps('session_settings', 'session_requests');
  const ctx = { has: has(tab) };
  assert.equal(slashCommandRoute('add-dir', { name: 'add-dir' }, ctx), 'local');
  assert.equal(slashCommandRoute('context', { name: 'context' }, ctx), 'local');
  assert.equal(slashCommandRoute('mcp', { name: 'mcp' }, ctx), 'local');
  assert.equal(slashCommandRoute('usage', { name: 'usage', needs: 'session_requests' }, ctx), 'local');
  assert.equal(slashCommandRoute('fast', { name: 'fast', needs: 'session_settings' }, ctx), 'local');
  assert.equal(slashCommandRoute('init', { name: 'init' }, ctx), 'cli');
  assert.equal(slashCommandRoute('doctor', { name: 'doctor' }, ctx), 'cli');
  assert.equal(slashCommandRoute('account', { name: 'account', needs: 'accounts' }, ctx), 'cli', 'a capability this server lacks');
  // There is one engine: the route no longer depends on which one answered, and
  // a tab that has no hello yet has no capability, so the CLI keeps what it ran.
  assert.equal(slashCommandRoute('doctor', { name: 'doctor' }, { sdkMode: false, has: () => false }), 'cli');
  assert.equal(slashCommandRoute('add-dir', { name: 'add-dir' }, { sdkMode: false, has: () => false }), 'cli');
  assert.equal(slashCommandRoute('add-dir', { name: 'add-dir' }), 'cli');
  assert.equal(slashCommandRoute('status', { name: 'status' }), 'local');
});

test('R03: the router asks the model and the session actions need an advertised capability', () => {
  const router = /function runSlashCommand\(tab, raw\) \{[\s\S]*?\n  switch \(cmd\) \{/.exec(panel)?.[0] || '';
  assert.match(router, /slashCommandRoute\(cmd, spec, \{ has: \(name\) => hasCapability\(tab, name\) \}\) === 'cli'\) return false;/);
  assert.doesNotMatch(panel, /SDK_NATIVE_COMMANDS/, 'the set lives in cp-events.js now');

  assert.equal(sessionActionsAvailable(caps()), false, 'no capability list: no fork, delete, CLI rename');
  assert.equal(sessionActionsAvailable({}), false);
  assert.equal(sessionActionsAvailable(caps('session_ops')), true);
  assert.equal(sessionActionsAvailable({ ...caps('session_ops'), accountId: 'work' }), false, 'another account keeps none of these');
  assert.equal(sessionActionsAvailable({ ...caps('session_ops'), accountId: 'default' }), true);
  assert.equal(sessionOpsSupported([caps(), caps('session_ops')]), true);
  assert.equal(sessionOpsSupported([caps('session_settings'), {}]), false);
  assert.equal(sessionOpsSupported([]), false);

  // The session menu builds Fork and Delete only when a connected server has the routes.
  assert.match(panel, /const sessionOps = sessionOpsSupported\(_tabs\);/);
  const gated = /\$\{sessionOps \? `([\s\S]*?)` : ''\}/.exec(panel)?.[1] || '';
  for (const cls of ['cp-sess-tag-btn', 'cp-sess-fork', 'cp-sess-delete']) {
    assert.ok(gated.includes(`class="cp-sess-rename ${cls}"`), `${cls} is inside the capability check`);
    assert.equal(panel.split(`class="cp-sess-rename ${cls}"`).length - 1, 1, `${cls} appears nowhere else in the markup`);
  }
});

// ── R04: an elicitation's completion must not wait behind its own card ──

test('R04: elicitation_complete passes the prompt buffer; ordinary events are still held', async () => {
  const { bypassesPromptBuffer } = await import('../public/shared/cp/cp-events.js');
  assert.equal(bypassesPromptBuffer({ type: 'event', event: { type: 'system', subtype: 'elicitation_complete', elicitation_id: 'e-9' } }), true);
  for (const type of ['control_request', 'control_cancelled', 'reattach_result']) assert.equal(bypassesPromptBuffer({ type }), true, type);
  for (const msg of [
    { type: 'event', event: { type: 'assistant' } },
    { type: 'event', event: { type: 'system', subtype: 'status' } },
    { type: 'event', event: { type: 'stream_event' } },
    { type: 'tool_result' }, { type: 'done' }, {}, null,
  ]) assert.equal(bypassesPromptBuffer(msg), false, JSON.stringify(msg));
  const handler = /function handleTabMsg\(tab, msg\) \{[\s\S]*?\n\}/.exec(panel)?.[0] || '';
  assert.match(handler, /const _bufferBypass = bypassesPromptBuffer\(msg\);/);
});

test('R04: the confirmation settles the waiting card once and releases the queue', async () => {
  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const { setCpCtx } = await import('../public/shared/cp/cp-ctx.js');
  const { renderElicitationCard } = await import('../public/shared/cp/cp-permissions.js');
  const { renderSdkEvent } = await import('../public/shared/cp/cp-event-rows.js');
  const dom = installMiniDom();
  try {
    const tab = { id: 't', messagesEl: dom.container('cp-messages') };
    const row = (t, text) => { const el = document.createElement('div'); el.textContent = text; t.messagesEl.appendChild(el); return el; };
    setCpCtx({ scrollEnd: () => {}, activeTab: () => tab, appendStatus: row, appendWarn: row, appendError: row, panel: () => null, esc: String });
    const sent = [];
    let resolved = 0;
    renderElicitationCard(tab, 'elicit-1', { subtype: 'elicitation', server_name: 'stripe', message: 'Sign in', mode: 'url', url: 'https://auth.example/start', elicitation_id: 'e-9' },
      { sendResponse: (id, body) => sent.push([id, body]), onResolved: () => { resolved++; } });
    const done = { type: 'system', subtype: 'elicitation_complete', elicitation_id: 'e-9', mcp_server_name: 'stripe' };
    renderSdkEvent(tab, tab, { ...done, elicitation_id: 'someone-else' });
    assert.equal(sent.length, 0, 'another elicitation does not settle this card');
    renderSdkEvent(tab, tab, done);
    renderSdkEvent(tab, tab, done);
    assert.deepEqual(sent, [['elicit-1', { action: 'accept' }]]);
    assert.equal(resolved, 1, 'the permission queue is released once');
  } finally { dom.restore(); }
});

// ── R05: a reloaded tab gets its task controls and wakeups back ──

test('R05: the live task list rebuilds the task map a reload emptied', async () => {
  const { adoptLiveTasks, reconcileTasks, taskRows, isTaskRunning } = await import('../public/shared/cp/cp-tasks-model.js');
  const tasks = new Map(); // what a freshly loaded tab has
  const live = [
    { task_id: 't1', task_type: 'local_agent', description: 'Explore the repo' },
    { task_id: 'm1', task_type: 'monitor', description: 'watch CI', ambient: true },
    { description: 'no id' },
  ];
  assert.equal(adoptLiveTasks(tasks, live, 1000), 2);
  const rows = taskRows(tasks, 2000);
  assert.equal(rows.length, 1, 'ambient work stays out of the card');
  assert.deepEqual([rows[0].id, rows[0].title, rows[0].running, rows[0].foreground], ['t1', 'agent: Explore the repo', true, false]);
  // Adopting again changes nothing; a task the map already tracks keeps its own data.
  tasks.get('t1').tokens = 1234;
  assert.equal(adoptLiveTasks(tasks, live, 3000), 0);
  assert.equal(tasks.get('t1').tokens, 1234);
  assert.equal(tasks.get('t1').startedAt, 1000);
  // Once it leaves the live list it has ended (it was seen live when adopted).
  assert.equal(reconcileTasks(tasks, [{ task_id: 'm1' }], 4000), 1);
  assert.equal(isTaskRunning(tasks.get('t1')), false);
  assert.equal(adoptLiveTasks(null, live), 0);
  assert.equal(adoptLiveTasks(tasks, null), 0);

  const setBg = /function _setBackgroundWork\(tab, tasks\) \{[\s\S]*?\n\}/.exec(panel)?.[0] || '';
  assert.match(setBg, /adoptLiveTasks\(tab\.tasks, tasks\)/, 'reattach and background_tasks_changed both pass through it');
  assert.ok(setBg.indexOf('adoptLiveTasks(') < setBg.indexOf('reconcileTasks('), 'adopt first, then end what left the list');
  const reattach = panel.slice(panel.indexOf("case 'reattach_result': {"), panel.indexOf("case 'reattach_result': {") + 1600);
  assert.match(reattach, /if \(Array\.isArray\(msg\.sessionCronList\)\) tab\.sessionCrons = msg\.sessionCronList;/);
});

// ── R06: fork "from here" names the prompt; the server finds where the copy ends ──

test('R06: the panel sends the prompt it forks before, with its own guess only as a fallback', async () => {
  const sessions = await import('../public/shared/cp/cp-sessions.js');
  const seen = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push([url, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'new' }) }; };
  try {
    await sessions.forkSession('sid-1', { beforeMessageId: 'prompt-uuid', upToMessageId: 'row-guess', title: 'Fork', project: '/p' });
    assert.deepEqual(seen[0], ['/api/claude-code/sessions/sid-1/fork', { upToMessageId: 'row-guess', beforeMessageId: 'prompt-uuid', title: 'Fork', project: '/p' }]);
  } finally { globalThis.fetch = prevFetch; }
  assert.match(panel, /forkClaudeSession\(tab\.sessionId, \{ beforeMessageId: uuid, upToMessageId: before, title, project: tab\.project \}\)/);
});

// ── R14: a replayed background command is history, not live work ──

test('R14: replaying a background command registers no running task', async () => {
  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const { setCpCtx } = await import('../public/shared/cp/cp-ctx.js');
  const { buildBashCard } = await import('../public/shared/cp/cp-bash.js');
  const dom = installMiniDom();
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0; // the card's elapsed ticker is not under test
  try {
    setCpCtx({ toolIconSvg: () => '', esc: String, panel: () => null, activeTab: () => null, scrollEnd: () => {} });
    const block = { id: 'toolu_bg', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } };
    const replayed = { bgTasks: new Map(), _replaying: true, messagesEl: dom.container() };
    buildBashCard(block, replayed);
    assert.equal(replayed.bgTasks.size, 0, 'a launch from the transcript is not live work');
    const live = { bgTasks: new Map(), messagesEl: dom.container() };
    buildBashCard(block, live);
    assert.equal(live.bgTasks.size, 1, 'a live launch is tracked');
    assert.equal(live.bgTasks.get('toolu_bg').status, 'running');
  } finally { globalThis.setInterval = realSetInterval; dom.restore(); }
});

// ── R10: a transcript restored from its snapshot keeps its read-only actions ──

test('R10: restore disables stale prompts only, and re-wires what a snapshot loses', async () => {
  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const { rehydrateStoredTranscript } = await import('../public/shared/cp/cp-rehydrate.js');
  const dom = installMiniDom();
  try {
    const $msgs = dom.container('cp-messages');
    const mk = (tag, cls, parent, data = {}) => { const el = document.createElement(tag); el.className = cls; Object.assign(el.dataset, data); (parent || $msgs).appendChild(el); return el; };
    // A prompt with its uuid and a stale rewind button, and one without a uuid.
    const prompt = mk('div', 'msg msg-user', null, { uuid: 'prompt-1' });
    mk('button', 'cp-rewind-btn', prompt);
    const bare = mk('div', 'msg msg-user');
    // A permission card that was pending, and an answered one.
    const pending = mk('div', 'perm-card active-perm', mk('div', 'msg msg-assistant'));
    const answered = mk('div', 'perm-card resolved', null);
    const allow = mk('button', 'perm-btn', answered);
    // A generic tool card with a clipped result, a Bash card, an agent card of a past subagent.
    const tool = mk('div', 'tool-card', null, { toolId: 'toolu_1' });
    const pre = mk('pre', 'cp-result-text', tool); pre.textContent = 'clipped';
    const more = mk('button', 'cp-result-more', tool); more.textContent = 'Show all (9,000 characters)';
    const bash = mk('div', 'tool-card cp-bash-card tool-streaming', null, { toolId: 'toolu_2' });
    const agent = mk('div', 'tool-card cp-agent-card', null, { toolId: 'toolu_3', agentId: 'agent-7', transcript: 'loading' });
    const pill = mk('span', 'cp-agent-pill cp-agent-running', agent);
    mk('div', 'thinking');
    const input = mk('input', 'cp-elicit-input', mk('div', 'perm-card cp-elicit-card resolved'));

    const rewinds = [];
    const subagents = [];
    const asked = [];
    const report = rehydrateStoredTranscript($msgs, {
      attachRewind: (row, uuid) => rewinds.push([row, uuid]),
      wireSubagent: (card, id) => subagents.push([card, id]),
      loadFullResult: async (toolId) => { asked.push(toolId); return 'the full nine thousand characters'; },
    });

    assert.equal(pending.parentElement?.isConnected ?? false, false, 'a prompt that was waiting is gone with its row');
    assert.equal($msgs.querySelector('.thinking'), null);
    assert.equal(allow.disabled, true, 'an answered card stays read-only');
    assert.equal(input.disabled, true);
    assert.equal(prompt.querySelector('.cp-rewind-btn'), null, 'the dead button is dropped');
    assert.deepEqual(rewinds, [[prompt, 'prompt-1']], 'and a live one is attached from the saved uuid');
    assert.equal(rewinds.some(([row]) => row === bare), false);
    assert.equal(bash.dataset.restored, '1');
    assert.equal(agent.dataset.restored, '1');
    assert.equal(bash.classList.contains('tool-streaming'), false);
    assert.equal(pill.classList.contains('cp-agent-running'), false);
    assert.deepEqual(subagents, [[agent, 'agent-7']]);
    assert.equal(agent.dataset.transcript, '', 'a load that was cut by the reload can start again');
    assert.deepEqual(report, { rewinds: 1, cards: 2, results: 1, subagents: 1 });

    // Show all: enabled, and one click fetches the result the snapshot could not hold.
    assert.equal(more.disabled, false);
    more.click();
    more.click();
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(asked, ['toolu_1'], 'asked once');
    assert.equal(pre.textContent, 'the full nine thousand characters');
    assert.equal(more.isConnected, false);
  } finally { dom.restore(); }
});

test('R10: a result that cannot be fetched says so and stays clipped', async () => {
  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const { rehydrateStoredTranscript } = await import('../public/shared/cp/cp-rehydrate.js');
  const dom = installMiniDom();
  try {
    const $msgs = dom.container('cp-messages');
    const tool = document.createElement('div'); tool.className = 'tool-card'; tool.dataset.toolId = 'toolu_9'; $msgs.appendChild(tool);
    const pre = document.createElement('pre'); pre.className = 'cp-result-text'; pre.textContent = 'clipped'; tool.appendChild(pre);
    const more = document.createElement('button'); more.className = 'cp-result-more'; tool.appendChild(more);
    rehydrateStoredTranscript($msgs, { loadFullResult: async () => null });
    more.click();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(pre.textContent, 'clipped');
    assert.equal(more.disabled, true);
    assert.match(more.textContent, /not available/);
    // Without a loader (no session behind the container) the button cannot work: it goes.
    const other = dom.container('cp-messages');
    const b = document.createElement('button'); b.className = 'cp-result-more'; other.appendChild(b);
    rehydrateStoredTranscript(other, {});
    assert.equal(b.isConnected, false);
  } finally { dom.restore(); }
});

test('R10: the monolith restores through the module and toggles restored cards', () => {
  const restore = /function renderStoredSession\(snapshot, \$msgs, tab\) \{[\s\S]*?\n\}/.exec(panel)?.[0] || '';
  assert.match(restore, /rehydrateStoredTranscript\(\$msgs, \{/);
  assert.match(restore, /attachRewind: \(row, uuid\) => _attachRewindButton\(tab, row, uuid\)/);
  assert.match(restore, /wireSubagent: \(card, agentId\) => _wireSubagentTranscript\(tab, card, agentId\)/);
  assert.match(restore, /loadFullResult: \(toolUseId\) => _fetchToolResultText\(tab, toolUseId\)/);
  assert.doesNotMatch(restore, /querySelectorAll\('button, input, select, textarea'\)/, 'the blanket disable moved into the module, with its exceptions');
  // Bash, diff and agent cards lose their own header listener in a snapshot.
  assert.match(panel, /if \(card && \(card\.dataset\.restored === '1' \|\| \(!card\.classList\.contains\('cp-bash-card'\)/);
});

// ── R08: an account that is gone is an error the tab shows, not the default identity ──

test('R08: history of a removed account is refused by the server and explained by the panel', () => {
  const server = read('server.js');
  const route = /app\.get\('\/api\/claude-code\/sessions\/:sessionId\/messages'[\s\S]*?\n\}\);/.exec(server)?.[0] || '';
  assert.match(route, /if \(!accountHome\) return res\.status\(404\)\.json\(\{ error: [^\n]*code: 'account_unavailable'/);
  assert.doesNotMatch(route, /catch \{ accountHome = null; \}\s*\}\s*const claudeProjectsDir = join\(accountHome \|\| /, 'no silent fall to the default folder');
  const loader = panel.slice(panel.indexOf('if (accountTab?.accountId) params.set'), panel.indexOf('if (accountTab?.accountId) params.set') + 1400);
  assert.match(loader, /if \(data\.code === 'account_unavailable'\) \{/);
  assert.match(loader, /note\.textContent = /, 'server text is shown as text');
});

// ═══ Run 2 gaps ═══

// ── C82: the CLI's own word on the session state ──

test('C82: the state event is kept, and an idle session ends a tab that never got its done', async () => {
  const { describeEvent, idleEndsTurn } = await import('../public/shared/cp/cp-events.js');
  assert.deepEqual(describeEvent({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' }), { kind: 'session_state', label: 'system/session_state_changed', state: 'requires_action' });
  assert.equal(describeEvent({ type: 'system', subtype: 'session_state_changed', state: 'napping' }).kind, 'ignore', 'a state this build does not know');
  const tab = { running: true, sessionState: 'idle', _lastWsActivity: 100, _msgBuffer: [] };
  assert.equal(idleEndsTurn(tab, 100), true, 'idle, nothing since, still shown as running: the done was lost');
  assert.equal(idleEndsTurn({ ...tab, running: false }, 100), false);
  assert.equal(idleEndsTurn({ ...tab, sessionState: 'running' }, 100), false, 'a new turn started meanwhile');
  assert.equal(idleEndsTurn({ ...tab, _lastWsActivity: 250 }, 100), false, 'something arrived after the idle: let it play out');
  assert.equal(idleEndsTurn({ ...tab, _activePerm: {} }, 100), false, 'a prompt is waiting for the user');
  assert.equal(idleEndsTurn({ ...tab, pendingAskRequestId: 'r1' }, 100), false);
  assert.equal(idleEndsTurn({ ...tab, _msgBuffer: [{}] }, 100), false);
  assert.equal(idleEndsTurn({ ...tab, closed: true }, 100), false);
  assert.match(panel, /sessionStateChanged: \(tab, state\) => _onSessionState\(tab, state\),/);
  const handler = /function _onSessionState\(tab, state\) \{[\s\S]*?\n\}/.exec(panel)?.[0] || '';
  assert.match(handler, /if \(idleEndsTurn\(tab, seenAt\)\) finishTab\(tab, true\);/);
});

test('C82: the row glue records the state and tells the panel', async () => {
  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const { setCpCtx } = await import('../public/shared/cp/cp-ctx.js');
  const { renderSdkEvent } = await import('../public/shared/cp/cp-event-rows.js');
  const dom = installMiniDom();
  try {
    const tab = { id: 't', messagesEl: dom.container('cp-messages') };
    const seen = [];
    setCpCtx({ activeTab: () => null, scrollEnd: () => {}, panel: () => null, sessionStateChanged: (t, state) => seen.push([t, state]) });
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'session_state_changed', state: 'idle' });
    assert.equal(tab.sessionState, 'idle');
    assert.deepEqual(seen, [[tab, 'idle']]);
    assert.equal(tab.messagesEl.childElementCount, 0, 'no transcript row');
  } finally { dom.restore(); }
});

// ── C54: the cost of a model change ──

test('C54: the notice after a model change says what the next reply re-caches', async () => {
  const { cacheCostText } = await import('../public/shared/cp/cp-sessions.js');
  assert.equal(cacheCostText({ source: 'model_switch', to_model: 'claude-sonnet-5-5', context_tokens: 84000, prompt_cache_warm: true, estimated_cache_write_usd: 0.31 }),
    'Model changed to claude-sonnet-5-5: the conversation (84k tokens) is cached again for it with the next reply, about $0.31. The cache of the previous model is no longer used.');
  assert.equal(cacheCostText({ source: 'model_switch', estimated_cache_write_usd: 0.004 }), 'Model changed: the conversation is cached again for it with the next reply, about $0.0040.');
  assert.equal(cacheCostText({ source: 'model_switch', estimated_cache_write_usd: 0 }), '');
  assert.match(cacheCostText({ source: 'resume', seconds_since_last_response: 7200, estimated_cache_write_usd: 0.42 }), /^The prompt cache of this session has expired/);
});

// ── C33: MCP servers changed on the live session ──

test('C33: the /mcp card applies a tab\'s servers live, keeps the tab\'s settings in step, and offers per-server prompts', () => {
  const card = panel.slice(panel.indexOf('function _decorateMcpCard(tab, card, { live }) {'), panel.indexOf('// ── Slash command router ──'));
  assert.match(card, /if \(live && hasCapability\(tab, 'mcp_dynamic'\)\) \{/);
  assert.match(card, /_sessionRequest\(tab, 'mcp_permission_mode', \{ serverName, mode \}\)/);
  assert.match(card, /if \(!hasCapability\(tab, 'session_settings_v2'\)\) return;/, 'the server list needs a bridge that reads it');
  assert.match(card, /const parsed = parseMcpServerLines\(area\.value\);\n    if \(parsed\.errors\.length\) \{/);
  assert.match(card, /_sessionRequest\(tab, 'mcp_set_servers', \{ servers: parsed\.servers \}\)/);
  assert.match(card, /tab\.session = normalizeSession\(\{ \.\.\.normalizeSession\(tab\.session\), mcpServers: d\.applied \|\| parsed\.servers \}\);/);
  assert.match(card, /_patchSession\(tab, \{ mcpServers: parsed\.servers \}/, 'without a live session the servers start with the next one');
  assert.doesNotMatch(card, /innerHTML/, 'server names and errors are set as text');
});
