// Review 3 of the Claude panel parity build, panel side: T01 (every message
// that can start a tab's session brings the tab's configuration), T03 (a
// cached transcript the authoritative one is a truncation of), T06 (a
// transcript that is not in the tab's project is said to be, and looked for
// where the session's own metadata says it is).
// DOM-free decisions are tested directly; the monolith by source contract (it
// cannot be imported in Node).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scrubSavedTab, historyProjectOf, shownUuids, shownTail, snapshotVerdict,
  START_CONFIG_TYPES, withStartConfig, transcriptOwner, historyOutcome, historyNotFoundText,
} from '../public/shared/cp/cp-restore.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(HERE, '..', 'public', 'shared', 'ui-claude-panel.js'), 'utf8').replace(/\r\n/g, '\n');
const fn = (name) => new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(panel)?.[0] || '';
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

// ── T01 ──

test('T01: every query the panel builds goes through _applySessionOptions before it is sent', () => {
  // Each `type: 'query'` literal, up to the send that follows it.
  const starts = [...panel.matchAll(/type: 'query',/g)].map(m => m.index);
  assert.equal(starts.length, 5, 'the message, the queue, /btw, the shell shortcut, the ask fallback');
  for (const at of starts) {
    const upToSend = panel.slice(at, panel.indexOf('tab.ws.send(JSON.stringify(', at));
    assert.match(upToSend, /_applySessionOptions\(tab, \w+\);/, `the query at offset ${at} is sent without the tab's account and restrictions: ${panel.slice(at, at + 60)}`);
  }
  // The shell shortcut was the one the review found.
  const bang = panel.slice(panel.indexOf("if (text.startsWith('!') && text.length > 1) {"), panel.indexOf('if (tab.pendingAsk && text) {'));
  assert.match(bang, /_applySessionOptions\(tab, msg\);[\s\S]*tab\.ws\.send\(JSON\.stringify\(msg\)\);/);
});

test('T01: every message that can start the session is sent with the tab\'s configuration', () => {
  // No raw send of a starting control is left.
  for (const type of START_CONFIG_TYPES) {
    assert.equal(panel.includes(`ws.send(JSON.stringify({ type: '${type}'`), false, `${type} is sent without the configuration`);
    assert.ok(panel.includes(`_sendControl(tab, { type: '${type}'`), `${type} goes through _sendControl`);
  }
  assert.match(fn('_sendControl'), /tab\.ws\.send\(JSON\.stringify\(withStartConfig\(msg, _startConfig\(tab\)\)\)\);/);
  // The configuration is what a query states: the same options function, the same base fields.
  const config = fn('_startConfig');
  assert.match(config, /_applySessionOptions\(tab, config\);/);
  for (const field of ['cwd:', 'sessionId: tab.sessionId', 'model:', 'effort:', 'windowId: _windowId']) assert.ok(config.includes(field), field);
  // A tab that is not the active one states its own project, not the picker's.
  assert.match(config, /active \? ddGetValue\(_panel\?\.querySelector\('#cp-project'\)\) : tab\.project/);
  // Every other raw send is a message that starts nothing.
  const raw = [...panel.matchAll(/ws\??\.send\(JSON\.stringify\(\{\s*type: '([a-z_]+)'/g)].map(m => m[1]);
  for (const type of raw) assert.ok(['reattach', 'dispose', 'heartbeat', 'control_response', 'abort', 'set_permission_mode', 'reload_plugins', 'reload_skills', 'stop_task', 'background_tasks'].includes(type), `${type} is sent raw: route it through _sendControl if it can start the session`);
});

test('T01: what a restored tab kept is what its first message states', () => {
  // The scrub keeps the configuration (V04); the wire helper attaches it untouched.
  const saved = scrubSavedTab({ id: 't', sessionId: SID, project: '/work/app', accountId: 'work', toolPolicy: 'read-only', permissionMode: 'plan', planMode: true, session: { maxTurns: 3 } });
  const config = { cwd: saved.project, sessionId: saved.sessionId, accountId: saved.accountId, toolPolicy: saved.toolPolicy, permissionMode: saved.permissionMode, session: saved.session };
  const wire = withStartConfig({ type: 'rewind', userMessageUuid: 'u1' }, config);
  assert.deepEqual(wire.config, config);
  assert.equal(wire.config.accountId, 'work');
  assert.equal(wire.config.toolPolicy, 'read-only');
  assert.equal(wire.config.permissionMode, 'plan');
});

// ── T03 ──

test('T03: a cached transcript is rebuilt when the authoritative one is a truncation of it', () => {
  const snap = { itemCount: 4, results: 1, html: '<div></div>' };
  const shown = new Set(['u1', 'a1', 'u2', 'a2']);
  // Rewound to a1: fewer rows, and a1 is among the rows shown. The cache ends on a2.
  assert.equal(snapshotVerdict(snap, { visible: 2, leaf: 'a1' }, shown), 'rebuild', 'a leaf that is displayed but is not the end');
  assert.equal(snapshotVerdict(snap, { visible: 3, leaf: 'u2' }, shown), 'rebuild');
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: 'a2' }, shown), 'keep', 'the same end');
  // The caller names the end of what is shown; it wins over the list's order.
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: 'a2' }, shown, { tail: 'a2' }), 'keep');
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: 'a1' }, shown, { tail: 'a2' }), 'rebuild');
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: 'a2' }, new Set(['a2', 'u1']), { tail: 'a2' }), 'keep');
  assert.equal(snapshotVerdict(snap, { visible: 4, leaf: 'a2' }, shown, { tail: '' }), 'rebuild', 'no row can vouch for the end');
});

test('T03: an empty authoritative transcript does not keep a cached conversation', () => {
  const snap = { itemCount: 4, results: 1, html: '<div></div>' };
  const shown = new Set(['u1', 'a1', 'u2', 'a2']);
  assert.equal(snapshotVerdict(snap, { messages: [], total: 0, start: 0, visible: 0, turns: 0, leaf: '' }, shown), 'rebuild');
  // Rows without a uuid (a snapshot of an older build) are a conversation too.
  assert.equal(snapshotVerdict(snap, { messages: [], total: 0, start: 0, visible: 0, leaf: '' }, new Set()), 'rebuild');
  // Nothing cached, nothing there: nothing to rebuild.
  assert.equal(snapshotVerdict({ itemCount: 0 }, { messages: [], total: 0, start: 0, visible: 0, leaf: '' }, new Set()), 'keep');
  // A server that was not restarted sends no `visible` and no `leaf`: it cannot say, the cache stays.
  assert.equal(snapshotVerdict(snap, { messages: [], total: 0 }, shown), 'keep');
  assert.equal(snapshotVerdict(snap, { messages: [] }, shown), 'keep');
  // The transcript is not where the tab looks: the rebuild finds it or says so.
  assert.equal(snapshotVerdict(snap, { error: 'x', code: 'transcript_not_found', scope: 'project', messages: [] }, shown), 'rebuild');
  // Any other refusal: the server could not say.
  assert.equal(snapshotVerdict(snap, { error: 'Not a registered project', messages: [] }, shown), 'keep');
});

test('T03: the end of what a restored transcript shows is its last top-level row with a uuid', async () => {
  const { installMiniDom } = await import('./fixtures/mini-dom.mjs');
  const dom = installMiniDom();
  try {
    const $msgs = dom.container('cp-messages');
    const mk = (parent, cls, data) => { const el = document.createElement('div'); el.className = cls; Object.assign(el.dataset, data); parent.appendChild(el); return el; };
    assert.equal(shownTail($msgs), '');
    mk($msgs, 'msg msg-user', { uuid: 'u1' });
    const reply = mk($msgs, 'msg msg-assistant', { uuids: 'a1 a1b' });
    assert.equal(shownTail($msgs), 'a1b', 'the last line of the last reply');
    // A subagent's rows inside a card are not the conversation's end.
    mk(reply, 'msg msg-assistant', { uuids: 'sub-1' });
    assert.equal(shownTail($msgs), 'a1b');
    mk($msgs, 'msg msg-user', { uuid: 'u2' });
    mk($msgs, 'msg-status', {});
    assert.equal(shownTail($msgs), 'u2', 'rows without a uuid after it do not count');
    assert.equal(shownUuids($msgs).has('sub-1'), true);
    assert.equal(shownTail(null), '');
  } finally { dom.restore(); }
});

test('T03: the panel compares the end of the cache, and drops a cache whose transcript is empty', () => {
  const load = fn('loadSessionHistory');
  assert.match(load, /snapshotVerdict\(snap, probeData, shownUuids\(\$msgs\), \{ tail: shownTail\(\$msgs\) \}\)/);
  // An empty transcript replaces the restored rows and forgets the snapshot.
  const empty = load.slice(load.indexOf("historyOutcome(data) === 'empty'"));
  assert.match(empty.slice(0, 500), /_dropSessionSnapshot\(sid\)/);
});

// ── T06 ──

test('T06: what the history route\'s answer means', () => {
  assert.equal(historyOutcome({ messages: [{ role: 'user', text: 'x' }], total: 1 }), 'rows');
  assert.equal(historyOutcome({ messages: [], total: 0, start: 0, visible: 0 }), 'empty');
  assert.equal(historyOutcome({ messages: [] }), 'empty', 'a server that was not restarted');
  assert.equal(historyOutcome({ error: 'gone', code: 'account_unavailable', messages: [] }), 'account_unavailable');
  assert.equal(historyOutcome({ error: 'x', code: 'transcript_not_found', scope: 'project', messages: [] }), 'not_in_project');
  assert.equal(historyOutcome({ error: 'x', code: 'transcript_not_found', scope: 'registered', messages: [] }), 'not_found');
  assert.equal(historyOutcome({ error: 'Not a registered project', messages: [] }), 'refused');
  assert.equal(historyOutcome(null), 'empty');
});

test('T06: the owning project comes from the session\'s own entry in the session list', () => {
  const list = { projects: [
    { path: '/work/app', sessions: [{ sessionId: 'aaaa' }] },
    { path: '/work/site', sessions: [{ sessionId: SID }, { sessionId: 'bbbb' }] },
  ] };
  assert.equal(transcriptOwner(list, SID, '/work/app'), '/work/site');
  assert.equal(transcriptOwner(list, SID, '/work/site'), '', 'the project already asked is not an answer');
  assert.equal(transcriptOwner(list, 'cccc', '/work/app'), '', 'a session the list does not have');
  assert.equal(transcriptOwner({ projects: [{ sessions: [{ sessionId: SID }] }] }, SID, ''), '', 'an entry without a path');
  assert.equal(transcriptOwner(null, SID, ''), '');
  // A search by text can return other sessions: only the id counts.
  assert.equal(transcriptOwner({ projects: [{ path: '/work/x', sessions: [{ sessionId: 'not-it', firstPrompt: SID }] }] }, SID, ''), '');
});

test('T06: a tab remembers where its session\'s transcript is, for that session only', () => {
  const tab = { sessionId: SID, project: '/work/app', transcriptAt: { sessionId: SID, project: '/work/site' } };
  assert.equal(historyProjectOf(tab, { pickerProject: '/work/app', isActive: true }), '/work/site');
  // Another session in the same tab: the tab's own project again.
  assert.equal(historyProjectOf({ ...tab, sessionId: 'other' }, { pickerProject: '/work/app', isActive: true }), '/work/app');
  assert.equal(historyProjectOf(tab, { sessionId: 'other' }), '/work/app');
  assert.equal(historyProjectOf({ ...tab, transcriptAt: { sessionId: SID, project: 42 } }, {}), '/work/app');
  // It survives the restart scrub, and only in a usable shape.
  assert.deepEqual(scrubSavedTab({ id: 't', sessionId: SID, transcriptAt: { sessionId: SID, project: '/work/site', extra: 1 } }).transcriptAt, { sessionId: SID, project: '/work/site' });
  assert.equal('transcriptAt' in scrubSavedTab({ id: 't', sessionId: SID, transcriptAt: { sessionId: 'another', project: '/work/site' } }), false);
  assert.equal('transcriptAt' in scrubSavedTab({ id: 't', sessionId: SID, transcriptAt: 'x' }), false);
});

test('T06: "not found in this project" is its own sentence, not "No messages"', () => {
  const inProject = historyNotFoundText({ code: 'transcript_not_found', scope: 'project', error: 'x' }, { project: '/work/app' });
  assert.match(inProject, /not found in this tab's project \(app\)/);
  assert.match(inProject, /session menu/);
  const anywhere = historyNotFoundText({ code: 'transcript_not_found', scope: 'registered', error: 'x' }, {});
  assert.match(anywhere, /not found in any registered project/);
  assert.doesNotMatch(inProject + anywhere, /No messages/);
  // The panel asks where it is, reads it from there and says so.
  const load = fn('loadSessionHistory');
  assert.match(load, /historyOutcome\(data\) === 'not_in_project'/);
  // (Review 4, T06: the lookup also names the tab's account.)
  assert.match(load, /_transcriptOwner\(sid, project, accountTab\?\.accountId \|\| ''\)/);
  assert.match(load, /transcriptAt = \{ sessionId: sid, project: owner \}/);
  assert.match(load, /historyNotFoundText\(data, /);
  assert.match(fn('_transcriptOwner'), /fetchClaudeSessions\(\{ search: sid, limit: 5, account: account \|\| '' \}\)/);
  assert.match(fn('_transcriptOwner'), /transcriptOwner\(/);
  // Saved with the tab, restored with it.
  assert.match(fn('saveTabs'), /transcriptAt: t\.transcriptAt \|\| null/);
  assert.match(fn('restoreTabs'), /saved\.transcriptAt/);
});
