// Review 2 of the Claude panel parity build, panel side: V04 (what a saved tab
// keeps across a server restart), V08 (Load earlier in a restored transcript),
// V09 (a cached transcript of another branch), V10 (replayed background
// commands), V11 to V14 (what the panel does with the server's answers).
// DOM-free decisions are tested directly; the rendering glue on the DOM
// stand-in; the monolith by source contract (it cannot be imported in Node).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scrubSavedTab, historyProjectOf, shownUuids, snapshotVerdict, pagerState } from '../public/shared/cp/cp-restore.js';
import { normalizeSession, parseAgentsJson, formatAgentsJson } from '../public/shared/cp/cp-session-model.js';
import { workEndedByRestart } from '../public/shared/cp/cp-tasks-model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(HERE, '..', 'public', 'shared', 'ui-claude-panel.js'), 'utf8').replace(/\r\n/g, '\n');
const fn = (name) => new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(panel)?.[0] || '';

// ── V04 ──

test('V04: a saved tab keeps its account, tool policy, permission mode and session settings across a server restart', () => {
  const session = normalizeSession({ maxBudgetUsd: 5, sandbox: { enabled: true }, disallowedTools: ['Bash'], additionalDirectories: ['/work/shared'], strictMcp: true,
    mcpServers: [{ name: 'docs', url: 'https://example.com/mcp' }], agents: { reviewer: { description: 'Reviews', prompt: 'Review.', tools: [] } }, overlay: { language: 'pt' } });
  const saved = {
    id: 'tab-1', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', label: 'Fix the build', titleState: 'manual', project: '/work/app', model: 'opus', effort: 'high',
    accountId: 'work', toolPolicy: 'read-only', permissionMode: 'default', session,
    // running state of the process that is gone
    running: true, sessionCost: 1.25, queue: ['next prompt'], queuePaused: true, planFilePath: '/tmp/plan.md', automationActive: true, automationRunId: 'run-1', automationOwnerId: 'w1',
  };
  const out = scrubSavedTab(saved);
  assert.equal(out.accountId, 'work', 'the conversation stays with the account it belongs to');
  assert.equal(out.toolPolicy, 'read-only', 'a restricted tab does not come back with every tool');
  assert.equal(out.permissionMode, 'default');
  assert.deepEqual(out.session, session, 'limits, sandbox, removed tools, directories, MCP servers, agents and overrides');
  assert.deepEqual(out.session.agents[0].tools, []);
  for (const gone of ['running', 'sessionCost', 'queue', 'queuePaused', 'planFilePath']) assert.equal(gone in out, false, `${gone} is running state`);
  assert.equal(out.automationActive, false);
  assert.deepEqual([out.id, out.sessionId, out.label, out.titleState, out.project, out.model, out.effort, out.automationRunId, out.automationOwnerId],
    ['tab-1', saved.sessionId, 'Fix the build', 'manual', '/work/app', 'opus', 'high', 'run-1', 'w1']);

  // Plan mode is a restriction too, in either spelling an older build saved.
  assert.equal(scrubSavedTab({ id: 'a', planMode: true }).permissionMode, 'plan');
  assert.equal(scrubSavedTab({ id: 'a', permissionMode: 'plan', planMode: true }).planMode, true);
  assert.equal(scrubSavedTab({ id: 'a', permissionMode: 'dontAsk' }).permissionMode, 'dontAsk');
  // Only what validates is kept: nothing a damaged entry says is taken on trust.
  const odd = scrubSavedTab({ id: 'b', accountId: '../../etc', toolPolicy: 'everything', permissionMode: 'root', session: 'x' });
  for (const key of ['accountId', 'toolPolicy', 'permissionMode', 'session']) assert.equal(key in odd, false, key);
  assert.equal('accountId' in scrubSavedTab({ id: 'c', accountId: '' }), false, 'the default account is the absence of one');
  assert.deepEqual(Object.keys(scrubSavedTab(null)).sort(), ['automationActive', 'automationOwnerId', 'automationRunId', 'effort', 'id', 'label', 'model', 'project', 'sessionId', 'titleState']);
});

test('V04: the restart scrub in the panel goes through scrubSavedTab, and restore reads what it kept', () => {
  const scrub = fn('_scrubStaleTabState');
  assert.match(scrub, /scrubSavedTab\(t\)/);
  assert.doesNotMatch(scrub, /sessionId: t\.sessionId \|\| null,/, 'no second, shorter list of kept fields');
  const restore = fn('restoreTabs');
  // (The permission mode is read by restoredMode(): a saved Bypass comes back only as the user's recorded pick.)
  for (const field of ['saved.toolPolicy', 'saved.session', 'saved.accountId', 'restoredMode(saved, ']) assert.ok(restore.includes(field), field);
});

// ── V08 ──

test('V08: where a stored "Load earlier" note stands is read back from it', () => {
  assert.deepEqual(pagerState({ start: '380', total: '500' }), { start: 380, total: 500 });
  // A snapshot stored before the stamps: the sentence says it.
  assert.deepEqual(pagerState({}, 'Showing 120 of 500 entries'), { start: 380, total: 500 });
  assert.deepEqual(pagerState(undefined, '  Showing 1 of 2 entries  '), { start: 1, total: 2 });
  for (const [ds, label] of [[{ start: '0', total: '500' }, ''], [{}, 'Showing last 200 of 500 messages'], [{}, ''], [{ start: 'x', total: '5' }, ''], [{ start: '9', total: '5' }, ''], [{}, 'Showing 500 of 500 entries']]) {
    assert.equal(pagerState(ds, label), null, JSON.stringify([ds, label]));
  }
});

test('V08: a restored transcript gets a live "Load earlier", never a dead button', async () => {
  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const { rehydrateStoredTranscript } = await import('../public/shared/cp/cp-rehydrate.js');
  const dom = installMiniDom();
  try {
    const build = (dataset, labelText) => {
      const $msgs = dom.container('cp-messages');
      const note = document.createElement('div'); note.className = 'msg-status cp-history-pager'; Object.assign(note.dataset, dataset);
      const label = document.createElement('span'); label.textContent = labelText; note.appendChild(label);
      const btn = document.createElement('button'); btn.className = 'cp-engine-retry'; btn.textContent = 'Load earlier'; note.appendChild(btn);
      $msgs.appendChild(note);
      return { $msgs, note, btn };
    };
    // Stamped note: the hook is asked to put a live pager in its place.
    const a = build({ start: '380', total: '500' }, 'Showing 120 of 500 entries');
    const asked = [];
    const report = rehydrateStoredTranscript(a.$msgs, { restorePager: (note, state) => asked.push([note, state]) });
    assert.deepEqual(asked, [[a.note, { start: 380, total: 500 }]]);
    assert.equal(report.pagers, 1);
    // An older snapshot (no stamps) is read from its sentence.
    const b = build({}, 'Showing 120 of 500 entries');
    const askedB = [];
    rehydrateStoredTranscript(b.$msgs, { restorePager: (note, state) => askedB.push(state) });
    assert.deepEqual(askedB, [{ start: 380, total: 500 }]);
    // No hook, or a note that cannot be read: the sentence stays, the dead button goes.
    const c = build({ start: '380', total: '500' }, 'Showing 120 of 500 entries');
    rehydrateStoredTranscript(c.$msgs, {});
    assert.equal(c.note.querySelector('button'), null);
    assert.equal(c.note.isConnected, true);
    const d = build({}, 'Showing last 200 of 500 messages');
    rehydrateStoredTranscript(d.$msgs, { restorePager: () => { throw new Error('should not be asked'); } });
    assert.equal(d.note.querySelector('button'), null);
    // A hook that fails leaves no dead button either.
    const e = build({ start: '380', total: '500' }, 'Showing 120 of 500 entries');
    rehydrateStoredTranscript(e.$msgs, { restorePager: () => { throw new Error('boom'); } });
    assert.equal(e.note.querySelector('button'), null);
  } finally { dom.restore(); }
});

test('V08: the panel stamps the pager and rebuilds it on restore', () => {
  const pager = fn('_addHistoryPager');
  assert.match(pager, /note\.dataset\.start = String\(start\)/);
  assert.match(pager, /note\.dataset\.total = String\(data\.total\)/);
  const stored = fn('renderStoredSession');
  assert.match(stored, /restorePager: \(note, state\) =>/);
  assert.match(stored, /_addHistoryPager\(tab, \$msgs, sid, /);
});

// ── V09 ──

test('V09: a cached transcript is rebuilt when the active branch changed, even when it is not longer', () => {
  const snap = { itemCount: 4, results: 1, html: '<div></div>' };
  const shown = new Set(['u1', 'a1', 'u2', 'a2']);
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: 'a2' }, shown), 'keep');
  // A rewind replaced the second turn with one of the same length…
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: 'a3' }, shown), 'rebuild');
  // …or with a shorter conversation.
  assert.equal(snapshotVerdict(snap, { visible: 2, leaf: 'a9' }, shown), 'rebuild');
  // Growth, as before.
  assert.equal(snapshotVerdict(snap, { visible: 9, leaf: 'a2' }, shown), 'rebuild');
  assert.equal(snapshotVerdict(snap, { total: 9 }, shown), 'rebuild', 'a server that predates `visible`');
  // The tab's account is gone: the rebuild says so instead of keeping a stale view.
  assert.equal(snapshotVerdict(snap, { code: 'account_unavailable', error: 'gone', messages: [] }, shown), 'rebuild');
  // The server could not say (a refusal, an older server with no leaf): the snapshot stays.
  assert.equal(snapshotVerdict(snap, { error: 'Not a registered project', messages: [] }, shown), 'keep');
  assert.equal(snapshotVerdict(snap, { visible: 4 }, shown), 'keep');
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: '' }, shown), 'keep');
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: 'a2' }, shown, { wantsResults: true }), 'rebuild');
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: 'a2' }, ['a2']), 'keep', 'a plain list works too');
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: 'a2' }, new Set()), 'rebuild', 'rows without uuids cannot vouch for the branch');
});

test('V09: the uuids a restored transcript shows, and the project a history request names', async () => {
  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const dom = installMiniDom();
  try {
    const $msgs = dom.container('cp-messages');
    const mk = (cls, data) => { const el = document.createElement('div'); el.className = cls; Object.assign(el.dataset, data); $msgs.appendChild(el); return el; };
    mk('msg msg-user', { uuid: 'u1' });
    mk('msg msg-assistant', { uuids: 'a1 a1b' });
    mk('msg msg-user', {});
    mk('msg msg-assistant', { uuids: 'a2' });
    assert.deepEqual([...shownUuids($msgs)].sort(), ['a1', 'a1b', 'a2', 'u1']);
    assert.equal(shownUuids(null).size, 0);
  } finally { dom.restore(); }
  // The tab's own project; the picker stands in only for the active tab.
  assert.equal(historyProjectOf({ project: '/work/app' }, { pickerProject: '/work/other', isActive: true }), '/work/app');
  assert.equal(historyProjectOf({ project: '' }, { pickerProject: '/work/other', isActive: true }), '/work/other');
  assert.equal(historyProjectOf({ project: '' }, { pickerProject: '/work/other', isActive: false }), '', 'a background tab is not looked up in the active tab\'s project');
  assert.equal(historyProjectOf(null, {}), '');
});

test('V09: the snapshot probe asks for the owning tab\'s project and account and compares the branch', () => {
  const load = fn('loadSessionHistory');
  assert.match(load, /snapshotVerdict\(snap, probeData, shownUuids\(\$msgs\)/);
  assert.match(load, /_historyProject\(tab\)/);
  assert.match(fn('_historyProject'), /historyProjectOf\(tab, \{ pickerProject: [^}]*isActive: !tab \|\| tab === activeTab\(\) \}\)/);
  const probe = load.slice(load.indexOf("limit: '1'"), load.indexOf('snapshotVerdict('));
  assert.match(probe, /params\.set\('account', /, 'the probe reads the account the tab runs under');
  assert.doesNotMatch(load, /const project = ddGetValue\(\$project\) \|\| undefined;/, 'not the project picker of whatever tab is active');
});

// ── V10 ──

test('V10: a replayed typed Bash result registers no running background task', async () => {
  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const { setCpCtx } = await import('../public/shared/cp/cp-ctx.js');
  const { buildBashCard, updateBashResult } = await import('../public/shared/cp/cp-bash.js');
  const dom = installMiniDom();
  try {
    setCpCtx({ esc: (s) => String(s), md: (s) => String(s), toolIconSvg: () => '', scrollEnd: () => {}, activeTab: () => null, saveTabs: () => {}, panel: () => null, linkifyFilePaths: () => {}, addCopyButtons: () => {} });
    const block = { id: 'toolu_bg', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } };
    const result = { tool_use_id: 'toolu_bg', content: 'Command running in background with ID: b46v84ew2', tool_use_result: { backgroundTaskId: 'b46v84ew2' } };
    const view = { bgTaskId: 'b46v84ew2' };

    // Replay (history, "Load earlier", a past subagent's transcript).
    const replayed = { bgTasks: new Map(), _replaying: 1, messagesEl: dom.container('cp-messages') };
    const card = buildBashCard(block, replayed);
    updateBashResult(card, result, replayed, view);
    assert.equal(replayed.bgTasks.size, 0, 'the launch happened in the past: the live task list says what runs now');

    // Live: the same result registers the task, as before.
    const live = { bgTasks: new Map(), _replaying: 0, messagesEl: dom.container('cp-messages') };
    const liveCard = buildBashCard(block, live);
    updateBashResult(liveCard, result, live, view);
    assert.equal(live.bgTasks.get('toolu_bg')?.status, 'running');
    assert.equal(live.bgTasks.get('toolu_bg')?.bashId, 'b46v84ew2');
    // A command moved to the background after it started (no entry yet), live.
    const moved = { bgTasks: new Map(), _replaying: 0, messagesEl: dom.container('cp-messages') };
    const movedCard = buildBashCard({ id: 'toolu_fg', name: 'Bash', input: { command: 'sleep 99' } }, moved);
    updateBashResult(movedCard, { ...result, tool_use_id: 'toolu_fg' }, moved, view);
    assert.equal(moved.bgTasks.get('toolu_fg')?.status, 'running');
    // …and the same thing replayed leaves nothing.
    const movedReplay = { bgTasks: new Map(), _replaying: 2, messagesEl: dom.container('cp-messages') };
    const movedReplayCard = buildBashCard({ id: 'toolu_fg', name: 'Bash', input: { command: 'sleep 99' } }, movedReplay);
    updateBashResult(movedReplayCard, { ...result, tool_use_id: 'toolu_fg' }, movedReplay, view);
    assert.equal(movedReplay.bgTasks.size, 0);
  } finally { dom.restore(); }
});

// ── V11 ──

test('V11: a named-account tab asks for its own settings, and without server support shows none as its own', () => {
  const perms = panel.slice(panel.indexOf("case 'permissions': {"), panel.indexOf("case 'effective-settings': {"));
  assert.match(perms, /hasCapability\(tab, 'account_settings'\)/);
  assert.match(perms, /ruleParams\.set\('account', tab\.accountId\)/);
  assert.match(perms, /named && !hasCapability\(tab, 'account_settings'\)\s*\? Promise\.resolve\(undefined\)/, 'an old server is not asked: it would answer with the default account\'s rules');
  const eff = panel.slice(panel.indexOf("case 'effective-settings': {"), panel.indexOf("case 'tools': {"));
  assert.match(eff, /hasCapability\(tab, 'account_settings'\)/);
  assert.match(eff, /params\.set\('account', tab\.accountId\)|account=\$\{encodeURIComponent\(tab\.accountId\)\}/);
  const card = fn('_renderPermissionsCard');
  assert.match(card, /account: tab\.accountId/, 'Remove names the account whose file it edits');
  assert.match(card, /shared with the default account/i);
});

// ── V12 ──

test('V12: the card keeps "no tools" apart from "inherit", and names what it leaves out', () => {
  const base = { description: 'Reviews', prompt: 'Review the diff.' };
  const s = normalizeSession({ agents: { inherit: { ...base }, none: { ...base, tools: [] }, some: { ...base, tools: ['Read', 'mcp__docs__search'] } } });
  const byName = Object.fromEntries(s.agents.map(a => [a.name, a]));
  assert.equal('tools' in byName.inherit, false);
  assert.deepEqual(byName.none.tools, []);
  assert.deepEqual(byName.some.tools, ['Read', 'mcp__docs__search']);
  // The JSON the card shows round-trips the empty list.
  const json = formatAgentsJson(s.agents);
  assert.match(json, /"tools": \[\]/);
  assert.deepEqual(parseAgentsJson(json).agents, s.agents);
  // A list that names something unusable is never widened, and the card says what it dropped.
  const bad = parseAgentsJson(JSON.stringify({ a: { ...base, tools: ['Read', 'rm -rf /'] }, b: { ...base, tools: ['???'] } }));
  assert.deepEqual(bad.agents.map(a => a.tools), [['Read'], []]);
  assert.match(bad.error, /not tool names/);
  // `tools` that is not a list at all is refused with the reason.
  const wrong = parseAgentsJson(JSON.stringify({ a: { ...base, tools: 'Read' } }));
  assert.deepEqual(wrong.agents, []);
  assert.match(wrong.error, /must be a list/);
});

// ── V13 ──

test('V13: what a restart of the session would end is named before it is done', () => {
  const tasks = new Map([
    ['t1', { id: 't1', status: 'running', description: 'Explore the repo', agentType: 'Explore' }],
    ['t2', { id: 't2', status: 'completed', description: 'done already' }],
    ['t3', { id: 't3', status: 'running', description: 'ambient watcher', ambient: true }],
  ]);
  const live = [{ task_id: 't1', description: 'Explore the repo' }, { task_id: 'b9', task_type: 'local_bash', description: 'npm run dev' }];
  const crons = [{ id: 'c1', schedule: 'in 20m', prompt: 'check CI' }];
  const w = workEndedByRestart({ tasks, live, crons });
  assert.deepEqual(w.tasks, ['Explore the repo', 'npm run dev']);
  assert.deepEqual(w.wakeups, ['in 20m: check CI']);
  assert.equal(w.sentence, 'This also ends 2 background tasks (Explore the repo; npm run dev) and 1 scheduled wake-up (in 20m: check CI).');
  assert.equal(workEndedByRestart({ tasks: new Map(), live: [], crons: [] }).sentence, '');
  assert.equal(workEndedByRestart().sentence, '');
  assert.match(workEndedByRestart({ crons }).sentence, /^This also ends 1 scheduled wake-up/);

  const card = fn('_renderPermissionsCard');
  assert.match(card, /workEndedByRestart\(/);
  assert.match(card, /confirm: true/);
  assert.match(card, /confirm_required/);
  assert.ok(card.indexOf('workEndedByRestart(') < card.indexOf("_sessionRequest(tab, 'forget_session_rules'"), 'asked before the request is sent');
});

// ── V14 ──

test('V14: the panel says when a deleted session left records behind', () => {
  const menu = panel.slice(panel.indexOf('deleteClaudeSession(s.sessionId, projectPath).then('), panel.indexOf('deleteClaudeSession(s.sessionId, projectPath).then(') + 1500);
  assert.match(menu, /\.warning/);
  assert.match(menu, /appendWarn\(/);
});
