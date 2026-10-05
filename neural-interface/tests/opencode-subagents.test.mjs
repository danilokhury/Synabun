// A panel and a pill per sub-agent (docs/opencode-sidepanel.md, "Sub-agent
// panels", S1 to S8). Until 2026-10-04 the panel kept one sub-agent panel: a
// new sub-agent of the same parent destroyed the previous one.
//   • the rules, without a DOM: ocp-v2-subagents-logic.js (this file)
//   • the real manager, sub-agent panels, composers and the shared side panel
//     controller under the DOM stand-in: opencode-subagents-glue.run.mjs,
//     started at the end of this file
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import { applyEvent } from '../public/shared/ocp-v2/ocp-v2-events.js';
import {
  MAIN_VIEW, decideVisibility, createSubagentRegistry, placeSubagent, pillState, traySummary, trayPills,
  createClosedSubagents, createShownSubagent, descendantsOf, createLimiter, closeSubagentConfirm,
  SUBAGENT_TRAY_ROWS, trayGroupHeight,
} from '../public/shared/ocp-v2/ocp-v2-subagents-logic.js';

const source = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');

// ── S5: the one function that decides which panels are on screen ────────────

test('S5: one OpenCode panel is visible at a time, and a request for another switches', () => {
  const views = [MAIN_VIEW, 'child-a', 'child-b', 'child-c'];
  // Nothing is on screen and nothing asks: nothing opens.
  assert.deepEqual(decideVisibility({ views, visible: [], request: {} }), { visible: [], show: [], hide: [] });
  // A click on a pill shows that sub-agent's panel and hides the one that was visible.
  assert.deepEqual(decideVisibility({ views, visible: [MAIN_VIEW], request: { show: 'child-a' } }),
    { visible: ['child-a'], show: ['child-a'], hide: [MAIN_VIEW] });
  assert.deepEqual(decideVisibility({ views, visible: ['child-a'], request: { show: 'child-b' } }),
    { visible: ['child-b'], show: ['child-b'], hide: ['child-a'] });
  // Back to the main panel (the breadcrumb, the parent's pill, the navbar).
  assert.deepEqual(decideVisibility({ views, visible: ['child-b'], request: { show: MAIN_VIEW } }),
    { visible: [MAIN_VIEW], show: [MAIN_VIEW], hide: ['child-b'] });
  // Asking for what is already there changes nothing.
  assert.deepEqual(decideVisibility({ views, visible: ['child-b'], request: { show: 'child-b' } }),
    { visible: ['child-b'], show: [], hide: [] });
  // Minimize: that panel goes, and no other takes its place by itself.
  assert.deepEqual(decideVisibility({ views, visible: ['child-b'], request: { hide: 'child-b' } }),
    { visible: [], show: [], hide: ['child-b'] });
  assert.deepEqual(decideVisibility({ views, visible: ['child-b'], request: { hide: 'child-a' } }),
    { visible: ['child-b'], show: [], hide: [] });
  // The navbar button closes whatever OpenCode panel is on screen.
  assert.deepEqual(decideVisibility({ views, visible: ['child-c'], request: { hideAll: true } }),
    { visible: [], show: [], hide: ['child-c'] });
  // A panel that does not exist is not shown, and what is on screen stays.
  assert.deepEqual(decideVisibility({ views, visible: [MAIN_VIEW], request: { show: 'child-gone' } }),
    { visible: [MAIN_VIEW], show: [], hide: [] });
  // The rule holds whatever came in: two panels on screen become one.
  assert.deepEqual(decideVisibility({ views, visible: ['child-a', 'child-b'], request: {} }),
    { visible: ['child-b'], show: [], hide: ['child-a'] });
  assert.deepEqual(decideVisibility({ views, visible: ['child-a', 'child-b'], request: { show: 'child-c' } }),
    { visible: ['child-c'], show: ['child-c'], hide: ['child-a', 'child-b'] });
});

test('S5: the slot at the right edge is shared with Claude and Codex', () => {
  const views = [MAIN_VIEW, 'child-a', 'child-b'];
  // Another provider's panel took the slot: the shared controller hid the
  // OpenCode panel that was there. No other OpenCode panel takes it back.
  assert.deepEqual(decideVisibility({ views, visible: ['child-a'], request: { yielded: 'child-a' } }),
    { visible: [], show: [], hide: [] });
  assert.deepEqual(decideVisibility({ views, visible: [MAIN_VIEW], request: { yielded: MAIN_VIEW } }),
    { visible: [], show: [], hide: [] });
  // A panel that is closed leaves the slot empty too.
  assert.deepEqual(decideVisibility({ views: [MAIN_VIEW, 'child-b'], visible: ['child-a'], request: { removed: 'child-a' } }),
    { visible: [], show: [], hide: [] });
  // The glue asks this function and nothing else: the manager applies its
  // answer, and the panels ask the manager.
  const manager = source('ocp-v2-manager.js');
  assert.match(manager, /export function requestOpencodeView\(request\) \{[\s\S]{0,400}decideVisibility\(\{ views, visible, request \}\)/);
  assert.equal((manager.match(/decideVisibility\(/g) || []).length, 1, 'one caller of the decision in the manager');
  const child = source('ocp-v2-childpanel.js');
  assert.equal(/setSidepanelVisible\(PANEL_OWNER, (true|next)\)/.test(child.replace(/function applyRequested[\s\S]*?\n  \}/, '')), false,
    'a sub-agent panel shows itself only through the manager');
  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /function setVisible\(nextVisible\) \{\s+requestOpencodeView\(nextVisible \? \{ show: MAIN_VIEW \} : \{ hide: MAIN_VIEW \}\);\s+\}/);
  assert.equal(/hideActiveChildPanel|isActiveChildPanelOpen/.test(panel + manager + child), false, 'the single-child calls are gone');
});

// ── S1, S8: one entry per sub-agent session, kept per parent ────────────────

test('S1: a second and a third sub-agent each get an entry; none replaces another; no cap', () => {
  const reg = createSubagentRegistry();
  const first = reg.add({ sessionId: 'c1', parentSessionId: 'root', rootSessionId: 'root', startedAt: 10, panelId: 'p1' });
  const second = reg.add({ sessionId: 'c2', parentSessionId: 'root', rootSessionId: 'root', startedAt: 20, panelId: 'p2' });
  const third = reg.add({ sessionId: 'c3', parentSessionId: 'root', rootSessionId: 'root', startedAt: 30, panelId: 'p3' });
  assert.equal(reg.size(), 3);
  assert.equal(reg.get('c1'), first, 'the first entry is the object it was');
  assert.notEqual(second, first);
  assert.notEqual(third, second);
  // A session that already has a panel keeps it: the entry is not replaced.
  const again = reg.add({ sessionId: 'c1', parentSessionId: 'root', rootSessionId: 'root', startedAt: 99, panelId: 'p1-new' });
  assert.equal(again, first);
  assert.equal(reg.get('c1').panelId, 'p1');
  assert.equal(reg.byPanelId('p2'), second);
  // In the order they were started, whatever order they were added in.
  reg.add({ sessionId: 'c0', parentSessionId: 'root', rootSessionId: 'root', startedAt: 5, panelId: 'p0' });
  reg.add({ sessionId: 'cx', parentSessionId: 'root', rootSessionId: 'root', panelId: 'px' });          // start unknown: after the known ones
  reg.add({ sessionId: 'cy', parentSessionId: 'root', rootSessionId: 'root', startedAt: 20, panelId: 'py' }); // a tie keeps arrival order
  assert.deepEqual(reg.ofRoot('root').map((e) => e.sessionId), ['c0', 'c1', 'c2', 'cy', 'c3', 'cx']);
  // No cap.
  for (let i = 0; i < 300; i += 1) reg.add({ sessionId: `many-${i}`, parentSessionId: 'root', rootSessionId: 'root', startedAt: 100 + i, panelId: `pm-${i}` });
  assert.equal(reg.ofRoot('root').length, 306);
  assert.equal(reg.get('c1'), first);
});

test('S8: the entries belong to their parent session; a switch swaps the set and the way back restores it', () => {
  const reg = createSubagentRegistry();
  for (const [sid, root, at] of [['a1', 'ses_a', 1], ['a2', 'ses_a', 2], ['b1', 'ses_b', 3], ['a3', 'ses_a', 4]]) {
    reg.add({ sessionId: sid, parentSessionId: root, rootSessionId: root, startedAt: at, panelId: `p-${sid}` });
  }
  const onA = reg.ofRoot('ses_a');
  assert.deepEqual(onA.map((e) => e.sessionId), ['a1', 'a2', 'a3']);
  assert.deepEqual(reg.ofRoot('ses_b').map((e) => e.sessionId), ['b1']);
  assert.deepEqual(reg.ofRoot('ses_c'), []);
  // Back on A: the same entries, the same objects, the same order.
  const back = reg.ofRoot('ses_a');
  assert.equal(back.length, 3);
  back.forEach((entry, i) => assert.equal(entry, onA[i]));
  // The tray shows the set of the session the main panel is on, and only that.
  const states = new Map([['a1', { state: 'done' }], ['a2', { state: 'waiting' }], ['a3', { state: 'running' }], ['b1', { state: 'running' }]]);
  const tray = (shownRoot, visiblePanelId = '') => trayPills({ entries: reg.all(), shownRoot, visiblePanelId, stateOf: (e) => states.get(e.sessionId) });
  assert.deepEqual(tray('ses_a').pills.map((p) => p.sessionId), ['a1', 'a2', 'a3']);
  assert.deepEqual(tray('ses_b').pills.map((p) => p.sessionId), ['b1']);
  assert.deepEqual(tray('ses_a').pills.map((p) => p.sessionId), ['a1', 'a2', 'a3'], 'back on A: as it was');
  assert.deepEqual(tray('').pills, []);
  assert.deepEqual(tray('ses_a', 'p-a2').pills.map((p) => [p.sessionId, p.shown]), [['a1', false], ['a2', true], ['a3', false]]);
  // The parent's own pill says what its sub-agents are doing, for every parent.
  assert.deepEqual(tray('ses_a').parents.get('ses_a'), { hasChild: true, running: true, waiting: true });
  assert.deepEqual(tray('ses_a').parents.get('ses_b'), { hasChild: true, running: true, waiting: false });
  // The parent session is deleted, or its tab closed: its set goes, the other stays.
  const gone = reg.removeRoot('ses_a');
  assert.deepEqual(gone.map((e) => e.sessionId), ['a1', 'a2', 'a3']);
  assert.deepEqual(reg.all().map((e) => e.sessionId), ['b1']);
  assert.equal(reg.remove('b1').sessionId, 'b1');
  assert.equal(reg.remove('b1'), null);
});

// ── S6: sub-agents of sub-agents ────────────────────────────────────────────

test('S6: a sub-agent of a sub-agent is placed under the session the main panel shows, with its chain of parents', () => {
  const parentOf = new Map([['child', 'root'], ['grand', 'child'], ['great', 'grand']]);
  const isRoot = (id) => id === 'root';
  assert.deepEqual(placeSubagent({ parentSessionId: 'root', childSessionId: 'child', parentOf, isRoot }),
    { rootSessionId: 'root', chain: ['root'] });
  assert.deepEqual(placeSubagent({ parentSessionId: 'child', childSessionId: 'grand', parentOf, isRoot }),
    { rootSessionId: 'root', chain: ['root', 'child'] });
  assert.deepEqual(placeSubagent({ parentSessionId: 'grand', childSessionId: 'great', parentOf, isRoot }),
    { rootSessionId: 'root', chain: ['root', 'child', 'grand'] });
  // A parent whose own parent is unknown belongs to nobody's set: no panel.
  assert.equal(placeSubagent({ parentSessionId: 'stranger', childSessionId: 'x', parentOf, isRoot }), null);
  // Another window's session is not a root here.
  assert.equal(placeSubagent({ parentSessionId: 'root', childSessionId: 'child', parentOf, isRoot: () => false }), null);
  // A session is not its own sub-agent, and a loop in the links ends.
  assert.equal(placeSubagent({ parentSessionId: 'root', childSessionId: 'root', parentOf, isRoot }), null);
  const loop = new Map([['a', 'b'], ['b', 'a']]);
  assert.equal(placeSubagent({ parentSessionId: 'a', childSessionId: 'c', parentOf: loop, isRoot }), null);
  // A session list (the reload, or a server without session:children) gives
  // the same tree: every descendant with its parent, in the order they started.
  const list = [
    { id: 'root', time: { created: 1 } },
    { id: 'other', time: { created: 2 } },
    { id: 'c2', parentID: 'root', time: { created: 30 } },
    { id: 'c1', parentID: 'root', time: { created: 20 } },
    { id: 'g1', parentID: 'c1', time: { created: 25 } },
    { id: 'o1', parentID: 'other', time: { created: 26 } },
  ];
  assert.deepEqual(descendantsOf(list, 'root').map((s) => [s.id, s.parentID]), [['c1', 'root'], ['g1', 'c1'], ['c2', 'root']]);
  assert.deepEqual(descendantsOf(list, 'nobody'), []);
});

// ── S3: what a pill says ────────────────────────────────────────────────────

const bound = (id = 'ses_child') => { const store = createPanelStore(); store.setSession(id, { id, title: 'explore' }); return store; };
const say = (store, role = 'assistant', id = 'msg_1', extra = {}) => store.upsertMessage({ id, role, sessionID: store.getState().sessionId, time: { created: 1, completed: 2 }, ...extra });

test('S3: a pill says running, waiting for an answer, done or failed, and which one is on screen', () => {
  const store = bound();
  assert.deepEqual(pillState(store.getState()), { state: 'idle', kind: '', text: '', waiting: false, running: false, shown: false });
  // Running.
  applyEvent(store, 'session.status', { sessionID: 'ses_child', status: { type: 'busy' } });
  assert.equal(pillState(store.getState()).state, 'running');
  assert.equal(pillState(store.getState()).running, true);
  // Waiting for an answer wins over running: it is what needs the user.
  applyEvent(store, 'permission.asked', { id: 'per_1', sessionID: 'ses_child', permission: 'bash' });
  assert.deepEqual(pillState(store.getState()), { state: 'waiting', kind: 'permission', text: '!', waiting: true, running: true, shown: false });
  applyEvent(store, 'permission.replied', { requestID: 'per_1', sessionID: 'ses_child' });
  applyEvent(store, 'question.asked', { id: 'que_1', sessionID: 'ses_child', questions: [] });
  assert.deepEqual(pillState(store.getState()), { state: 'waiting', kind: 'question', text: '?', waiting: true, running: true, shown: false });
  applyEvent(store, 'question.asked', { id: 'que_2', sessionID: 'ses_child', questions: [] });
  assert.equal(pillState(store.getState()).text, '2');
  applyEvent(store, 'question.replied', { requestID: 'que_1', sessionID: 'ses_child' });
  applyEvent(store, 'question.rejected', { requestID: 'que_2', sessionID: 'ses_child' });
  assert.equal(pillState(store.getState()).state, 'running');
  // Done: the turn ended and there is a transcript.
  say(store);
  applyEvent(store, 'session.idle', { sessionID: 'ses_child' });
  assert.deepEqual(pillState(store.getState()), { state: 'done', kind: 'done', text: '✓', waiting: false, running: false, shown: false });
  // Failed: the session reported an error...
  applyEvent(store, 'session.error', { sessionID: 'ses_child', error: { name: 'APIError', data: { message: 'boom' } } });
  assert.deepEqual(pillState(store.getState()), { state: 'failed', kind: 'error', text: '!', waiting: false, running: false, shown: false });
  // ...or, after a reload, its last answer carries one. Stopping is not failing.
  const reloaded = bound();
  say(reloaded, 'assistant', 'msg_a', { error: { name: 'APIError', data: { message: 'boom' } } });
  assert.equal(pillState(reloaded.getState()).state, 'failed');
  const stopped = bound();
  say(stopped, 'assistant', 'msg_a', { error: { name: 'MessageAbortedError', data: { message: 'x' } } });
  assert.equal(pillState(stopped.getState()).state, 'done');
  // A notice (a kept prompt) is not a failure of the sub-agent.
  const noticed = bound();
  say(noticed);
  noticed.pushError({ message: 'kept', notice: true });
  assert.equal(pillState(noticed.getState()).state, 'done');
  // Which one is the visible panel.
  assert.equal(pillState(store.getState(), { visible: true }).shown, true);
});

test('S3: many pills: the tray lists them in a bounded, scrolling group and counts what needs attention', () => {
  const states = [{ state: 'running' }, { state: 'waiting' }, { state: 'done' }, { state: 'failed' }, { state: 'waiting' }, { state: 'idle' }];
  assert.deepEqual(traySummary(states), { total: 6, running: 1, waiting: 2, failed: 1, done: 1, text: '6 sub-agents · 2 waiting · 1 running · 1 failed' });
  assert.equal(traySummary([{ state: 'done' }]).text, '1 sub-agent');
  assert.equal(traySummary([]).text, '');
  // The header shows once the group can scroll; a waiting sub-agent is then
  // counted there even while its pill is scrolled out of view.
  const entries = Array.from({ length: 40 }, (_, i) => ({ sessionId: `c${i}`, rootSessionId: 'root', parentSessionId: 'root', panelId: `p${i}`, depth: 0 }));
  const plan = trayPills({ entries, shownRoot: 'root', stateOf: (e) => ({ state: e.sessionId === 'c33' ? 'waiting' : 'done' }) });
  assert.equal(plan.pills.length, 40, 'every sub-agent keeps its pill');
  assert.equal(plan.scrolls, true);
  assert.equal(plan.summary.text, '40 sub-agents · 1 waiting');
  assert.equal(plan.firstWaiting, 'c33');
  assert.equal(trayPills({ entries: entries.slice(0, SUBAGENT_TRAY_ROWS), shownRoot: 'root', stateOf: () => ({ state: 'done' }) }).scrolls, false);
  // The tray ends inside the window: the group takes the room the tray's
  // other pills (every provider's tabs) leave under the tray's top edge, eight
  // rows at most, however little that is (F8: no forced minimum), and scrolls
  // inside it. It never pushes the pills under it off the page.
  assert.equal(trayGroupHeight({ trayTop: 125, othersHeight: 36, viewportHeight: 900 }), 310);
  assert.equal(trayGroupHeight({ trayTop: 125, othersHeight: 540, viewportHeight: 835 }), 158);
  assert.equal(trayGroupHeight({ trayTop: 125, othersHeight: 640, viewportHeight: 835 }), 58);
  assert.equal(trayGroupHeight({ trayTop: 125, othersHeight: 700, viewportHeight: 835 }), 0);
  assert.equal(trayGroupHeight({ trayTop: 0, othersHeight: 0, viewportHeight: 0 }), 310, 'no layout: the stylesheet bound');
  assert.match(source('ocp-v2-manager.js'), /_groupHeight = trayGroupHeight\(\{ trayTop: trayBox\.top,/);
  assert.match(source('ocp-v2-manager.js'), /_groupEl\.style\.maxHeight = `\$\{_groupHeight\}px`;/);
  // The group is bounded in the stylesheet: it scrolls instead of growing.
  const css = source('ocp-v2-styles.js');
  assert.match(css, /\.ocpv2-subagent-pills \{[^}]*max-height:[^;}]+;[^}]*overflow-y: auto;/);
  // A badge that has something to say is displayed (the rule that hid every badge is gone).
  assert.match(css, /\.ocpv2-pill-badge\[data-kind\]:not\(\[data-kind=""\]\) \{\s*display: inline-flex;/);
  assert.match(css, /\.ocpv2-session-pill-child\.ocpv2-pill-waiting/);
  assert.match(css, /\.ocpv2-session-pill-child\.ocpv2-pill-shown/);
});

// ── S7: closing ─────────────────────────────────────────────────────────────

test('S7: a sub-agent the user closed stays closed, across a reload, until it is opened again or its parent goes', () => {
  let saved = null;
  const io = { load: () => saved, save: (entries) => { saved = JSON.parse(JSON.stringify(entries)); } };
  const closed = createClosedSubagents(io);
  assert.equal(closed.isClosed('c1'), false);
  closed.close('c1', 'root');
  closed.close('c2', 'root');
  closed.close('d1', 'other');
  assert.equal(closed.isClosed('c1'), true);
  // A reload: another instance on the same storage.
  const reloaded = createClosedSubagents(io);
  assert.deepEqual(['c1', 'c2', 'd1', 'c9'].map((id) => reloaded.isClosed(id)), [true, true, true, false]);
  // "Open sub-agent" on the task card brings one back.
  reloaded.reopen('c1');
  assert.equal(createClosedSubagents(io).isClosed('c1'), false);
  // The parent session is deleted: nothing of it is remembered.
  reloaded.forgetRoot('root');
  assert.deepEqual(saved, { d1: 'other' });
  reloaded.forget('d1');
  assert.deepEqual(saved, {});
  // A storage that is broken forgets, it does not throw.
  const broken = createClosedSubagents({ load: () => { throw new Error('no'); }, save: () => { throw new Error('no'); } });
  broken.close('x', 'root');
  assert.equal(broken.isClosed('x'), true);
  // Bounded: the oldest closes are forgotten first.
  const small = createClosedSubagents({ load: () => null, save: () => {}, max: 3 });
  for (const id of ['a', 'b', 'c', 'd']) small.close(id, 'root');
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => small.isClosed(id)), [false, true, true, true]);
});

test('S7: closing a sub-agent panel that still holds unsent prompts asks first and names them', () => {
  assert.equal(closeSubagentConfirm({ items: [], label: 'explore' }), '');
  const one = closeSubagentConfirm({ items: [{ text: 'and then check the tests' }], label: 'explore' });
  assert.match(one, /^Close the sub-agent panel “explore”\?/);
  assert.match(one, /A prompt is still waiting to be sent there and will be discarded:\n• “and then check the tests”/);
  assert.match(one, /The sub-agent session itself is not deleted/);
  const two = closeSubagentConfirm({ items: [{ text: 'a' }, { text: 'b' }], label: '' });
  assert.match(two, /^Close this sub-agent panel\?/);
  assert.match(two, /2 prompts are still waiting/);
});

// ── S8: the reload ──────────────────────────────────────────────────────────

test('S8: the sub-agent panel that was on screen is remembered across a reload, and restored once', () => {
  let saved = null;
  const io = { load: () => saved, save: (value) => { saved = value; } };
  const page1 = createShownSubagent(io);
  assert.equal(page1.restoreFor('root'), '', 'nothing was on screen before');
  page1.note({ rootSessionId: 'root', sessionId: 'c2' });
  assert.deepEqual(saved, { rootSessionId: 'root', sessionId: 'c2' });
  // The reload.
  const page2 = createShownSubagent(io);
  // The main panel opens first (the user opened OpenCode): that does not
  // forget what was on screen before the reload.
  page2.note(null);
  assert.deepEqual(saved, { rootSessionId: 'root', sessionId: 'c2' });
  assert.equal(page2.restoreFor('root'), 'c2');
  assert.equal(page2.restoreFor('root'), '', 'once');
  // From here on it follows what is on screen.
  page2.note(null);
  assert.equal(saved, null);
  // The session that comes up after the reload is another one: nothing is restored.
  page1.note({ rootSessionId: 'root', sessionId: 'c2' });
  const page3 = createShownSubagent(io);
  assert.equal(page3.restoreFor('other'), '');
  assert.equal(page3.restoreFor('root'), '', 'and not later either');
  // A choice the user makes before the children are read wins over the restore.
  page1.note({ rootSessionId: 'root', sessionId: 'c2' });
  const page4 = createShownSubagent(io);
  page4.note({ rootSessionId: 'root', sessionId: 'c5' });
  assert.equal(page4.restoreFor('root'), '');
  assert.deepEqual(saved, { rootSessionId: 'root', sessionId: 'c5' });
  // OpenCode is not on screen when the children are read (an automation
  // booted the panel): nothing opens by itself. The restore waits for the
  // user to open OpenCode, and for the children to have been read.
  page4.note({ rootSessionId: 'root', sessionId: 'c2' });
  const page5 = createShownSubagent(io);
  assert.equal(page5.restoreFor('root', { mainVisible: false, ready: true }), '');
  page5.note(null);
  assert.deepEqual(saved, { rootSessionId: 'root', sessionId: 'c2' }, 'still remembered: a second reload restores it too');
  assert.equal(page5.restoreFor('root', { mainVisible: true, ready: false }), '', 'the children are still being read');
  assert.equal(page5.restoreFor('root', { mainVisible: true, ready: true }), 'c2');
  assert.equal(page5.restoreFor('root', { mainVisible: true, ready: true }), '', 'once');
  // The user opened OpenCode on another session first: the restore is over.
  page4.note({ rootSessionId: 'root', sessionId: 'c2' });
  const page6 = createShownSubagent(io);
  assert.equal(page6.restoreFor('other', { mainVisible: false }), '');
  assert.equal(page6.restoreFor('other', { mainVisible: true, ready: false }), '');
  assert.equal(page6.restoreFor('root', { mainVisible: true, ready: true }), '');
  // The main panel was on screen at the reload: nothing to restore.
  page4.note(null);
  assert.equal(createShownSubagent(io).restoreFor('root'), '');
});

test('rebuilding many sub-agent panels reads a few sessions at a time', async () => {
  const limit = createLimiter(2);
  let active = 0; let peak = 0; const order = [];
  const job = (name, ms) => limit(async () => {
    active += 1; peak = Math.max(peak, active); order.push(name);
    await new Promise((r) => setTimeout(r, ms));
    active -= 1;
    return name;
  });
  const results = await Promise.all([job('a', 20), job('b', 5), job('c', 5), job('d', 5)]);
  assert.deepEqual(results, ['a', 'b', 'c', 'd']);
  assert.equal(peak, 2);
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  // A read that fails does not hold the others up.
  const failing = limit(async () => { throw new Error('nope'); });
  await assert.rejects(failing, /nope/);
  assert.equal(await limit(async () => 'after'), 'after');
});

// ── The rule this replaces, and what the glue must keep ─────────────────────

test('the one-child rule is gone from the manager and the sub-agent panel', () => {
  const manager = source('ocp-v2-manager.js');
  const child = source('ocp-v2-childpanel.js');
  assert.equal(/_activeChild/.test(manager), false, 'no single active child');
  assert.equal(/destroyActiveChild|At most ONE child panel|REPLACES this panel/.test(manager + child), false);
  assert.match(manager, /const _panels = createSubagentRegistry\(\);/);
  // Nothing opens by itself: a spawn creates the pill, and only a request shows a panel.
  const spawn = manager.slice(manager.indexOf('function spawnChildPanel('), manager.indexOf('function destroyPanel('));
  assert.equal(/requestOpencodeView\(\{ show|\.show\(|applyRequested\(true\)/.test(spawn), false, 'spawning shows nothing');
  // Every sub-agent panel is re-read after the socket came back, each guarded by its own registration.
  assert.match(manager, /onReconnect\(\(\) => \{\s+for \(const entry of _panels\.all\(\)\)/);
  assert.match(manager, /isCurrent: \(\) => _panels\.get\(sessionId\)\?\.store === store,/);
  // A user's close is remembered; a late event or scan does not bring the panel back.
  assert.match(manager, /if \(!reopen && _closed\.isClosed\(childSid\)\) return null;/);
  // The main panel hands over what the set needs: which sessions are its tabs,
  // what is unsent in a tab's sub-agent panels (its close question lists it),
  // and the set of a tab that goes.
  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /ownsSession: \(sessionId\) => _tabSessionIds\.includes\(sessionId\),/);
  assert.match(panel, /keepPrompts: \(items, label\) => _composer\?\.keep\?\.\(items, label\),/);
  assert.match(panel, /return \[\.\.\.\(_composer\?\.waitingFor\?\.\(sessionId\) \|\| \[\]\), \.\.\.subagentPromptsWaiting\(sessionId\)\];/);
  assert.match(panel, /releaseSubagentPanels\(sessionId, \{ lost: !byUser \}\);/);
  assert.match(panel, /requestOpencodeView\(\{ hideAll: true \}\);/);
  // Each sub-agent panel asks its own questions, on its own store.
  assert.match(child, /const _confirms = createConfirmations\(\{ store \}\);/);
  assert.match(child, /confirm: \(question\) => _confirms\.ask\(\{ surface: 'panel', \.\.\.question \}\),/);
});

// ── The DOM glue, under the stand-in ────────────────────────────────────────

test('S1 to S8: the manager, the sub-agent panels and the shared side panel controller', () => {
  const script = fileURLToPath(new URL('./opencode-subagents-glue.run.mjs', import.meta.url));
  const env = { ...process.env, SYNABUN_TYPESAFE: 'off' };
  delete env.SYNABUN_ASSISTANT_SESSION;
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 120_000, env });
  const stdout = String(result.stdout || '');
  const output = `${stdout}\n${result.stderr || ''}`;
  assert.equal(result.status, 0, output.slice(-6000));
  const steps = stdout.split('\n').filter((line) => /^(ok  |FAIL) /.test(line));
  assert.deepEqual(steps.filter((line) => line.startsWith('FAIL')), [], output.slice(-6000));
  for (const id of ['S1', 'S2 event', 'S2 queue', 'S2 permission', 'S2 confirmation', 'S2 late answers', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8 switch', 'S8 reload']) {
    assert.ok(steps.some((line) => line.startsWith('ok  ') && line.includes(id)), `a step for ${id} ran`);
  }
  assert.match(stdout, /\nno problems\s*$/, output.slice(-6000));
});
