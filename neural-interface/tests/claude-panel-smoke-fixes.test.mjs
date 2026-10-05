// Browser smoke test 1 of the Claude panel (CP-01 to CP-06), run against a
// server that had not been restarted: the new panel files talking to the old
// bridge. One block per finding. Pure logic is imported; what lives in the
// monolith (it cannot be imported outside a browser) is pinned by source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasCapability, matchSlashCommands, listSlashCommands, slashMenuMaxHeight, splitCommandsByCapability } from '../public/shared/cp/cp-events.js';
import { sessionOpsSupported, sessionActionsAvailable, titleMatches, labelledSessionIds, mergeSessionSearch } from '../public/shared/cp/cp-sessions.js';
import { mcpRows } from '../public/shared/cp/cp-usage-model.js';
import { contextWindowSource } from '../public/shared/cp/cp-context-window.js';
import { contextReading, contextMenuModel, NOT_REPORTED } from '../public/shared/cp/cp-context-model.js';
import {
  historyHasResultSupport, historyResultsNotice, snapshotWantsResults, fullResultFromHistory,
  HISTORY_NO_RESULTS_CLASS, HISTORY_NO_RESULTS_TEXT,
} from '../public/shared/cp/cp-tool-results.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const panel = read('public/shared/ui-claude-panel.js');
const caps = (...names) => ({ capabilities: new Set(names) });

function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// ── CP-01: nothing the old bridge cannot serve is offered ──

test('CP-01: the history list has no Tag, Fork or Delete until a server advertises session_ops', () => {
  const oldBridge = { capabilities: new Set() }; // a hello without a list
  assert.equal(sessionOpsSupported([oldBridge, {}]), false);
  assert.equal(sessionActionsAvailable(oldBridge), false);
  assert.equal(sessionOpsSupported([oldBridge, caps('session_ops')]), true);
  const item = fnBody(panel, 'function cpSessRenderItem(s, projectPath, menu) {');
  assert.match(item, /const sessionOps = sessionOpsSupported\(_tabs\);/);
  // The three buttons exist only inside the gated part of the row's markup.
  const gated = item.match(/\$\{sessionOps \? `([\s\S]*?)` : ''\}/);
  assert.ok(gated, 'the gated block of the row');
  for (const cls of ['cp-sess-tag-btn', 'cp-sess-fork', 'cp-sess-delete']) {
    assert.ok(gated[1].includes(cls), `${cls} is inside the gate`);
    assert.equal(item.split(`class="cp-sess-rename ${cls}"`).length, 2, `${cls} is rendered in one place only`);
  }
  // Renaming works everywhere (the name is the panel's own); the write to the CLI's title is gated.
  assert.match(item, /if \(sessionOpsSupported\(_tabs\)\) writeSessionTitle\(sid, val, item\.dataset\.cwd\);/);
  assert.doesNotMatch(panel, /^\s*writeSessionTitle\(/m, 'no ungated write of the CLI title');
});

test('CP-01: the MCP card offers Reconnect, Disable and Enable only for a live session', () => {
  const servers = [{ name: 'a', status: 'connected' }, { name: 'b', status: 'failed' }, { name: 'c', status: 'disabled' }];
  const live = mcpRows(servers);
  assert.deepEqual(live.map(r => [r.canReconnect, r.canDisable, r.canEnable]), [[false, true, false], [true, true, false], [false, false, true]]);
  const still = mcpRows(servers, { controls: false });
  assert.deepEqual(still.map(r => [r.canReconnect, r.canDisable, r.canEnable]), [[false, false, false], [false, false, false], [false, false, false]]);
  assert.deepEqual(still.map(r => [r.name, r.status]), [['a', 'connected'], ['b', 'failed'], ['c', 'disabled']], 'the list itself is unchanged');
  const mcp = fnBody(panel, 'function _showMcp(tab, servers = null) {');
  assert.match(mcp, /mcpRows\(list, \{ controls: live \}\)/);
  assert.match(mcp, /render\(known, \{ live: false \}\)/, 'what the statusline opens on an old bridge: the list, without controls');
  assert.match(mcp, /hasCapability\(tab, 'session_requests'\) \? [^:]+ : 'Reconnect, disable and enable need the SynaBun server restart\.'/);
});

test('CP-01: /help lists what the server can run and names what waits for the restart', () => {
  const commands = [{ name: 'help' }, { name: 'session', needs: 'session_settings' }, { name: 'usage', needs: 'session_requests' }, { name: 'tasks' }];
  const old = splitCommandsByCapability(commands, () => false);
  assert.deepEqual(old.available.map(c => c.name), ['help', 'tasks']);
  assert.deepEqual(old.locked.map(c => c.name), ['session', 'usage']);
  const tab = caps('session_settings');
  const some = splitCommandsByCapability(commands, (name) => hasCapability(tab, name));
  assert.deepEqual(some.locked.map(c => c.name), ['usage']);
  assert.deepEqual(splitCommandsByCapability(null), { available: [], locked: [] });
  const run = fnBody(panel, 'function runSlashCommand(tab, raw) {');
  assert.match(run, /splitCommandsByCapability\(SLASH_COMMANDS, \(name\) => hasCapability\(tab, name\)\)/);
  assert.match(run, /Available after the SynaBun server restart: /);
  // Cards that mention /session only do so where /session exists.
  assert.match(run, /hasCapability\(tab, 'session_settings'\) \? 'To run this tab as one of them, set "Run as agent" in <code>\/session<\/code>\. ' : ''/);
  assert.match(run, /hasCapability\(tab, 'session_settings'\) \? 'A local plugin directory can be loaded for this tab in <code>\/session<\/code>\.' : ''/);
});

test('CP-01: every message only the rebuilt bridge understands is sent behind its capability', () => {
  // inbound message type → the capability that says the bridge accepts it
  const NEEDS = {
    rewind_conversation: 'conversation_rewind',
    reload_plugins: 'reload_plugins',
    reload_skills: 'reload_skills',
    stop_task: 'task_control',
    background_tasks: 'task_control',
    session_request: 'session_requests',
    warm: 'warm_start',
  };
  for (const [type, cap] of Object.entries(NEEDS)) {
    const sends = [...panel.matchAll(new RegExp(`type: '${type}'`, 'g'))];
    assert.ok(sends.length >= 1, `${type} is sent somewhere`);
    for (const m of sends) {
      const before = panel.slice(Math.max(0, m.index - 1600), m.index);
      assert.ok(before.includes(`hasCapability(tab, '${cap}')`), `${type} is sent without checking ${cap}`);
    }
  }
  // Per-query additions ride on the query message, each behind its own check.
  for (const cap of ['tool_policy', 'session_settings', 'accounts', 'session_title', 'origin_human']) {
    assert.match(panel, new RegExp(`if \\(hasCapability\\(tab, '${cap}'\\)[^\\n]*\\) msg\\.`), `${cap} gates its query field`);
  }
  // Controls rendered only with their capability.
  assert.match(panel, /canInterrupt: hasCapability\(tab, 'deny_interrupt'\)/);
  assert.match(panel, /extended: hasCapability\(tab, 'permission_modes_v2'\)/);
  assert.match(panel, /if \(before && hasCapability\(tab, 'conversation_rewind'\)\) \{/);
  assert.match(panel, /if \(before && tab\.sessionId && sessionActionsAvailable\(tab\)\) \{/);
  assert.match(panel, /const canEdit = hasCapability\(tab, 'permission_rules_edit'\);/);
  assert.match(panel, /const canForget = hasCapability\(tab, 'permission_rules'\) && hasSessionRules\(tab\.grantedRules\);/);
  assert.match(panel, /const canControl = hasCapability\(tab, 'task_control'\) && /);
  // A temporary chat exists only against a bridge that announces it: the control is not drawn otherwise, and nothing of one is sent.
  assert.match(panel, /paintTemporary\(tab, \{ capable: hasCapability\(tab, TEMPORARY_CAPABILITY\), /);
  assert.match(panel, /temporaryRefusal\(tab, \{ capable: hasCapability\(tab, TEMPORARY_CAPABILITY\) \}\)/);
});

test('CP-01: the tasks card says why a running task has no Stop on the old bridge', async () => {
  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const { setCpCtx } = await import('../public/shared/cp/cp-ctx.js');
  const { renderTasksCard } = await import('../public/shared/cp/cp-tasks.js');
  const dom = installMiniDom();
  try {
    setCpCtx({ activeTab: () => null, scrollEnd: () => {} });
    const note = 'Stopping a task from here needs the SynaBun server restart.';
    const running = new Map([['a1', { id: 'a1', description: 'Explore the repo', status: 'running', startedAt: 1 }]]);
    const tab = { messagesEl: dom.container('cp-messages'), tasks: running, backgroundWork: [], sessionCrons: [] };
    const old = renderTasksCard(tab, { canControl: false, controlNote: note });
    assert.equal(old.querySelectorAll('button').length, 0, 'no control that cannot work');
    assert.equal(old.querySelector('.cp-task-note')?.textContent, note);
    // With the controls there is nothing to explain; without a running task neither.
    assert.equal(renderTasksCard(tab, { canControl: true, controlNote: note }).querySelector('.cp-task-note'), null);
    const idle = { messagesEl: dom.container('cp-messages'), tasks: new Map(), backgroundWork: [], sessionCrons: [] };
    assert.equal(renderTasksCard(idle, { canControl: false, controlNote: note }).querySelector('.cp-task-note'), null);
  } finally { dom.restore(); }
  const open = fnBody(panel, 'function _openTasks(tab) {');
  assert.match(open, /controlNote: hasCapability\(tab, 'task_control'\) \? '' : 'Stopping a task from here needs the SynaBun server restart\.'/);
});

// ── CP-02: a bare slash lists every command ──

test('CP-02: a bare "/" lists every command once; typed text still filters', () => {
  const list = [
    { name: 'help', description: 'h' },
    { name: 'usage', description: 'u', aliases: ['cost'] },
    { name: 'Help', description: 'duplicate by case' },
    { name: '', description: 'blank' },
    { name: 'heapdump', description: 'd' },
  ];
  assert.deepEqual(listSlashCommands(list).map(c => [c.name, c.via]), [['help', ''], ['usage', ''], ['heapdump', '']]);
  assert.deepEqual(listSlashCommands(null), []);
  assert.deepEqual(matchSlashCommands(list, 'h').map(c => c.name), ['help', 'Help', 'heapdump'], 'the filter itself is unchanged');
  const hints = fnBody(panel, 'async function showSlashHints(filter) {');
  assert.match(hints, /const matches = q \? matchSlashCommands\(merged, q\) : listSlashCommands\(merged\);/);
  assert.match(hints, /if \(!matches\.length\) \{ hideSlashHints\(\); return; \}/);
  assert.doesNotMatch(hints, /!filter/, 'an empty filter no longer hides the menu');
  // The input handler asks for hints on a bare slash too.
  assert.match(panel, /if \(!text\.includes\(' '\)\) \{ showSlashHints\(cmd\); \} else \{ hideSlashHints\(\); \}/);
});

test('CP-02: the list scrolls inside the space above the input', () => {
  assert.equal(slashMenuMaxHeight(600), 320, 'a tall panel keeps the cap');
  assert.equal(slashMenuMaxHeight(240), 232, 'a short one gets what is above the input, less the gap');
  assert.equal(slashMenuMaxHeight(40), 72, 'never less than two rows');
  assert.equal(slashMenuMaxHeight(0), 320, 'not laid out: the stylesheet cap');
  assert.equal(slashMenuMaxHeight(NaN), 320);
  assert.equal(slashMenuMaxHeight(500, { cap: 200 }), 200);
  const hints = fnBody(panel, 'async function showSlashHints(filter) {');
  assert.match(hints, /const anchor = \$hints\.parentElement;/);
  assert.match(hints, /\$hints\.style\.maxHeight = `\$\{slashMenuMaxHeight\(room\)\}px`;/);
  assert.match(panel, /\.cp-slash-hints \{[^}]*max-height: 320px; overflow-y: auto;/, 'the list scrolls, it does not grow');
  assert.match(fnBody(panel, 'function navigateSlashHints(dir) {'), /scrollIntoView\?\.\(\{ block: 'nearest' \}\)/, 'the highlighted row stays in view');
});

// ── CP-03: search finds the titles the list shows ──

test('CP-03: a session is found by the title the list displays for it', () => {
  const named = { sessionId: 'aaa', firstPrompt: 'please fix the footer', modified: '2026-09-30T10:00:00Z' };
  const cliTitled = { sessionId: 'bbb', title: 'Footer cleanup', firstPrompt: 'x', modified: '2026-10-01T10:00:00Z' };
  const byPrompt = { sessionId: 'ccc', firstPrompt: 'Redesign the FOOTERBOTTOMROW', modified: '2026-10-02T10:00:00Z' };
  // The name given in the panel wins over the CLI's title, which wins over the first prompt.
  assert.equal(titleMatches(named, 'FooterBottomRowRedesign', 'FooterBottomRowRedesign'), true);
  assert.equal(titleMatches(named, 'footerbottomrow', 'FooterBottomRowRedesign'), true, 'case-insensitive, partial');
  assert.equal(titleMatches(named, 'please fix', 'FooterBottomRowRedesign'), false, 'the first prompt is not what the list shows for a named session');
  assert.equal(titleMatches(cliTitled, 'cleanup'), true);
  assert.equal(titleMatches(byPrompt, 'footerbottomrow'), true);
  assert.equal(titleMatches(byPrompt, ''), false);

  assert.deepEqual(labelledSessionIds([['aaa', 'FooterBottomRowRedesign'], ['zzz', 'Other'], ['aaa', 'FooterBottomRowRedesign'], ['', 'FooterX']], 'footerbottomrowredesign'), ['aaa']);
  assert.deepEqual(labelledSessionIds([['a', 'x1'], ['b', 'x2'], ['c', 'x3']], 'x', 2), ['a', 'b'], 'capped');
  assert.deepEqual(labelledSessionIds([['a', 'x']], ''), []);
  assert.deepEqual(labelledSessionIds(null, 'x'), []);
});

test('CP-03: results merge the three sources, displayed-title matches first', () => {
  const labels = { aaa: 'FooterBottomRowRedesign' };
  const body1 = { sessionId: 'b1', firstPrompt: 'talks about a footer somewhere', modified: '2026-10-03T00:00:00Z' };
  const body2 = { sessionId: 'b2', firstPrompt: 'unrelated', modified: '2026-10-02T00:00:00Z' };
  const named = { sessionId: 'aaa', firstPrompt: 'please fix it', modified: '2026-09-30T00:00:00Z' };
  const prompt = { sessionId: 'ccc', firstPrompt: 'FooterBottomRowRedesign follow-up', modified: '2026-10-01T00:00:00Z' };
  const out = mergeSessionSearch('FooterBottomRowRedesign', {
    ranked: [body1, body2, prompt],
    listed: [prompt, named, { sessionId: '' }, null],
    labelOf: (id) => labels[id] || '',
  });
  assert.deepEqual(out.map(s => s.sessionId), ['ccc', 'aaa', 'b1', 'b2'], 'title matches newest first, then the full-text ranking; no duplicates');
  assert.deepEqual(mergeSessionSearch('x', {}), []);
  // The exact case of the report: the full-text search returns nothing, the name is only in the page.
  assert.deepEqual(mergeSessionSearch('FooterBottomRowRedesign', { ranked: [], listed: [named], labelOf: (id) => labels[id] || '' }).map(s => s.sessionId), ['aaa']);

  const search = fnBody(panel, 'async function _cpSessSearchAll(q) {');
  assert.match(search, /searchSessions\(\{ q, provider: 'claude-code', project, limit: 100 \}\)/, 'the conversations');
  assert.match(search, /fetchClaudeSessions\(\{ search: q, project, limit: 100 \}\)/, 'the list fields: first prompt, branch, CLI title and tag');
  assert.match(search, /k\.startsWith\(LABEL_PREFIX\)/, 'the names given in the panel');
  assert.match(search, /labelledSessionIds\(labels, q\)\.filter\(id => !have\.has\(id\)\)/);
  assert.match(search, /fetchClaudeSessions\(\{ search: id, project, limit: 5 \}\)/, 'a named session is fetched by its id');
  assert.match(search, /mergeSessionSearch\(q, \{ ranked, listed: \[\.\.\.listed, \.\.\.named\], labelOf: getLabel \}\)/);
  assert.match(fnBody(panel, 'async function cpSessLoadBatch(menu, listEl, refresh = false) {'), /data = await _cpSessSearchAll\(_cpSessSearch\.trim\(\)\);/);
  // What the row shows and what the search matches are the same function.
  assert.match(fnBody(panel, 'function cpSessRenderItem(s, projectPath, menu) {'), /getLabel\(s\.sessionId\) \|\| cleanPrompt\(sessionListLabel\(s\)\)/);
});

// ── CP-04: a replay without tool results says why ──

const OLD_ROUTE = { // what the route of a server that was not restarted returns
  total: 3,
  turns: 1,
  messages: [
    { role: 'user', text: 'run it' },
    { role: 'assistant', text: 'ok', tools: [{ id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'assistant', text: 'done' },
  ],
};

test('CP-04: an old history route with tool calls gets one line; a current one never does', () => {
  assert.equal(historyHasResultSupport(OLD_ROUTE), false);
  assert.equal(historyResultsNotice(OLD_ROUTE), HISTORY_NO_RESULTS_TEXT);
  assert.match(HISTORY_NO_RESULTS_TEXT, /SynaBun server restart/);
  // The current route says where its page starts, and returns the results.
  const current = { ...OLD_ROUTE, start: 0, visible: 3 };
  assert.equal(historyHasResultSupport(current), true);
  assert.equal(historyResultsNotice(current), '', 'a call without a result there was interrupted, not withheld');
  // Nothing to explain: no tool call at all, or results present.
  assert.equal(historyResultsNotice({ total: 2, messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] }), '');
  assert.equal(historyResultsNotice({ total: 2, messages: [...OLD_ROUTE.messages, { role: 'tool_result', toolUseId: 'toolu_1', text: 'a b' }] }), '');
  assert.equal(historyResultsNotice(null), '');
  assert.equal(historyResultsNotice({ messages: [] }), '');

  const load = fnBody(panel, 'async function loadSessionHistory(sid, $msgs) {');
  assert.match(load, /const noResults = historyResultsNotice\(data\);/);
  assert.match(load, /note\.className = `msg-status \$\{HISTORY_NO_RESULTS_CLASS\}`;/, 'a quiet status line, not a warning');
  assert.equal((load.match(/historyResultsNotice\(/g) || []).length, 1, 'one line per replay');
});

test('CP-04: a snapshot stored without results is rebuilt once the server can return them', () => {
  const current = { total: 40, visible: 12, start: 0 };
  const old = { total: 12 };
  const withNotice = { html: `<div class="msg msg-assistant"><div class="tool-card" data-tool-id="t1"></div></div><div class="msg-status ${HISTORY_NO_RESULTS_CLASS}">x</div>` };
  assert.equal(snapshotWantsResults(withNotice, current), true);
  assert.equal(snapshotWantsResults(withNotice, old), false, 'still the old server: nothing better to show');
  // Stored before the notice existed: tool cards, not one result.
  const bare = { html: '<div class="tool-card cp-bash-card" data-tool-id="t1"></div><div class="tool-card" data-tool-id="t2"></div>' };
  assert.equal(snapshotWantsResults(bare, current), true);
  assert.equal(snapshotWantsResults({ ...bare, results: 1 }, current), false, 'already rebuilt from a current server: the session has no results');
  // A live session's snapshot has results; one without tools has nothing to gain.
  assert.equal(snapshotWantsResults({ html: '<div class="tool-card tool-ok" data-tool-id="t1"></div><div class="tool-card"></div>' }, current), false);
  assert.equal(snapshotWantsResults({ html: '<div class="tool-card cp-bash-card tool-error"></div>' }, current), false);
  assert.equal(snapshotWantsResults({ html: '<div class="msg msg-user">hello</div>' }, current), false);
  assert.equal(snapshotWantsResults(null, current), false);

  const load = fnBody(panel, 'async function loadSessionHistory(sid, $msgs) {');
  assert.match(load, /\} else if \(snapshotWantsResults\(snap, probeData\)\) \{/);
  assert.match(load, /restored = \[\.\.\.\$msgs\.children\];/);
  assert.match(load, /if \(restored\) for \(const node of restored\) node\.remove\(\);/, 'the rebuild replaces the restored snapshot instead of following it');
  assert.match(load, /ownerTab\._historyResults = historyHasResultSupport\(data\);/);
  assert.match(fnBody(panel, 'function writeSessionSnapshot(tab) {'), /results: tab\._historyResults \|\| _sessionSnapshots\[sid\]\?\.results \? 1 : 0,/);
  assert.match(fnBody(panel, 'function _normalizeSnapshotEntry(entry) {'), /results: entry\.results \? 1 : 0,/);
});

test('CP-04: "Show all" on a restored card says when the server has to be restarted', async () => {
  assert.deepEqual(fullResultFromHistory({ messages: [{ role: 'tool_result', toolUseId: 't1', text: 'full text' }] }, 't1'), { text: 'full text', notice: '' });
  assert.deepEqual(fullResultFromHistory({ messages: [] }, 't1'), { text: null, notice: '' }, 'a current server that has no such result');
  // The old route ignores ?tool= and answers with the whole page.
  const old = fullResultFromHistory(OLD_ROUTE, 'toolu_1');
  assert.equal(old.text, null);
  assert.match(old.notice, /SynaBun server restart/);
  assert.match(fnBody(panel, 'async function _fetchToolResultText(tab, toolUseId) {'), /if \(full\.notice\) throw Object\.assign\(new Error\(full\.notice\), \{ notice: full\.notice \}\);/);

  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const { rehydrateStoredTranscript } = await import('../public/shared/cp/cp-rehydrate.js');
  const dom = installMiniDom();
  try {
    const $msgs = dom.container('cp-messages');
    const tool = document.createElement('div'); tool.className = 'tool-card'; tool.dataset.toolId = 'toolu_1'; $msgs.appendChild(tool);
    const pre = document.createElement('pre'); pre.className = 'cp-result-text'; pre.textContent = 'clipped'; tool.appendChild(pre);
    const more = document.createElement('button'); more.className = 'cp-result-more'; tool.appendChild(more);
    rehydrateStoredTranscript($msgs, { loadFullResult: async () => { throw Object.assign(new Error(old.notice), { notice: old.notice }); } });
    more.click();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(pre.textContent, 'clipped');
    assert.equal(more.disabled, true);
    assert.equal(more.textContent, old.notice);
  } finally { dom.restore(); }
});

// ── CP-05: the context reading (now in the context settings popover) ──
// It was a gauge whose label was fitted to the panel's width. The reading is in
// the header cog's popover, which has its own width; what it must never do is
// show a window nothing named.

test('CP-05: the popover shows a window only when something named it', () => {
  const models = [{ id: 'opus[1m]', tier: 'default', contextWindow: 1_000_000, label: 'Opus (1M)' }];
  assert.equal(contextWindowSource({ reported: 200_000, models, modelId: 'opus[1m]' }), 'reported');
  assert.equal(contextWindowSource({ models, modelId: 'opus[1m]' }), 'catalog');
  assert.equal(contextWindowSource({ modelId: 'opus[1m]' }), 'id', 'before the catalog loads, the marker');
  assert.equal(contextWindowSource({ modelId: 'opus' }), '', 'nothing names it: no default size');

  const usage = { inputTokens: 1000, cacheRead: 181_000, cacheWrite: 34_000, outputTokens: 12_000 };
  assert.equal(contextReading({ usage, window: 200_000, source: '' }).pct, null, 'no source, no share');
  assert.equal(contextReading({ usage, window: 1_000_000, source: 'catalog' }).pressure, '');
  assert.equal(contextReading({ usage, window: 270_000, source: 'reported' }).pressure, 'high', 'the cog dot from 80%');
  assert.equal(contextReading({ usage, window: 230_000, source: 'reported' }).pressure, 'critical', 'stronger from 90%');

  const fresh = contextMenuModel({});
  assert.equal(fresh.context.headline, NOT_REPORTED);
  assert.deepEqual(fresh.context.rows.find(r => r[0] === 'Window'), ['Window', NOT_REPORTED]);
  assert.deepEqual(fresh.versions.map(r => r[1]), [NOT_REPORTED, NOT_REPORTED]);
  assert.deepEqual(fresh.compact, { label: 'Compact', disabled: true, hint: 'Not connected to a session.' });

  const live = contextMenuModel({
    usage, window: 1_000_000, source: 'reported', connected: true, running: true, sessionId: 'abc',
    mcpServers: [{ name: 'claude.ai Docs', status: 'connected' }, { name: 'stripe', status: 'failed', toolCount: 0 }],
    toolCounts: { claude_ai_Docs: 3 }, init: { cliVersion: '2.1.278', tools: 40, skills: ['a', 'b'] }, sdkVersion: '0.3.278',
  });
  assert.equal(live.context.headline, '216k / 1M tokens (22%)');
  // The line under the bar says it in two halves, and what named the window on hover:
  // the window has a row of its own only while that line cannot carry it.
  assert.deepEqual([live.context.usage, live.context.share, live.context.tip], ['216k / 1M tokens', '22%', 'Window size reported by Claude Code']);
  assert.deepEqual(live.context.rows.map(r => r[0]), ['Model', 'Cache', 'Output']);
  assert.deepEqual(live.context.rows[1], ['Cache', '181k read \u00b7 34k written', '84% of the context read from cache']);
  assert.deepEqual([fresh.context.usage, fresh.context.share, fresh.context.tip], [NOT_REPORTED, '', '']);
  assert.deepEqual(contextMenuModel({ window: 1_000_000, source: 'catalog' }).context.rows[1], ['Window', '1M tokens', 'Window size from the model list']);
  assert.equal(fresh.tools.note, NOT_REPORTED, 'no servers: one "MCP servers" row says so');
  assert.equal(live.compact.disabled, true, 'disabled while a turn runs');
  assert.deepEqual(live.tools.servers, [
    { name: 'claude.ai Docs', tone: 'ok', word: 'Connected', detail: '3 tools' },
    { name: 'stripe', tone: 'err', word: 'Failed', detail: '0 tools' },
  ]);
  assert.deepEqual(live.versions, [['Claude Agent SDK', '0.3.278'], ['Claude Code', '2.1.278']]);
  assert.equal(contextMenuModel({ connected: true, compacting: true }).compact.label, 'Compacting\u2026');

  // Compact keeps its per-tab state while its button does not exist.
  assert.match(fnBody(panel, 'function _setCompactingUI(on) {'), /_compactingUI = !!on;/);
  assert.match(fnBody(panel, 'function renderGauge(tab) {'), /if \(tab !== activeTab\(\)\) return;\n\s+syncContextMenu\(tab\);/);
});

// ── CP-06: the footer cost is readable ──

test('CP-06: the footer cost uses the panel\'s muted text colour', () => {
  const rule = panel.match(/\n\s*\.cp-cost \{([^}]*)\}/);
  assert.ok(rule, '.cp-cost rule');
  assert.match(rule[1], /color: var\(--t-muted\);/);
  assert.doesNotMatch(rule[1], /rgba\(255,255,255,0\.18\)/);
  assert.match(panel, /\.cp-cost:hover \{ color: var\(--t-secondary\); \}/);
  assert.match(panel, /\.cp-cost\.flash \{ color: var\(--t-primary\); \}/);
  // Existing tokens, not new colours.
  const styles = read('public/shared/styles.css');
  for (const token of ['--t-muted', '--t-secondary', '--t-primary']) assert.match(styles, new RegExp(`${token}: rgba\\(`), `${token} is defined`);
});
