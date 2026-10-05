// What the review of the sub-agent panels established (docs/opencode-sidepanel.md,
// "Sub-agent panels", F1 to F10):
//   • the rules without a DOM (this file)
//   • each rule as its sequence, with the real manager, sub-agent panels,
//     composers and socket layer under the DOM stand-in:
//     opencode-subagents-review-glue.run.mjs, started at the end of this file
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as logic from '../public/shared/ocp-v2/ocp-v2-subagents-logic.js';
import { autoAcceptInherited } from '../public/shared/ocp-v2/ocp-v2-approvals.js';

const source = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');
// The contract document lives in the development repository; a checkout without it checks the code alone.
const CONTRACT_URL = new URL('../../docs/opencode-sidepanel.md', import.meta.url);
const contract = () => readFileSync(CONTRACT_URL, 'utf8');

// ── F8 ──────────────────────────────────────────────────────────────────────

test('F8: the group of pills takes the room that is left under the other pills, however little', () => {
  const { trayGroupHeight } = logic;
  // Room to spare: eight rows.
  assert.equal(trayGroupHeight({ trayTop: 125, othersHeight: 36, viewportHeight: 900 }), 310);
  assert.equal(trayGroupHeight({ trayTop: 125, othersHeight: 540, viewportHeight: 835 }), 158);
  // Less than three rows are left: the group takes those, not 112 px.
  assert.equal(trayGroupHeight({ trayTop: 60, othersHeight: 720, viewportHeight: 900 }), 108);
  assert.equal(trayGroupHeight({ trayTop: 60, othersHeight: 810, viewportHeight: 900 }), 18);
  // Nothing is left: the group takes nothing.
  assert.equal(trayGroupHeight({ trayTop: 125, othersHeight: 700, viewportHeight: 835 }), 0);
  assert.equal(trayGroupHeight({ trayTop: 60, othersHeight: 2000, viewportHeight: 900 }), 0);
  // Whatever the layout: the tray's top, the other pills, the group and its margin end inside the window.
  for (const viewportHeight of [320, 600, 900, 1400]) {
    for (const trayTop of [0, 48, 125]) {
      for (let othersHeight = 0; othersHeight <= viewportHeight; othersHeight += 37) {
        const height = trayGroupHeight({ trayTop, othersHeight, viewportHeight });
        assert.ok(height >= 0 && height <= 310, 'between nothing and eight rows');
        if (trayTop + othersHeight + 12 <= viewportHeight) {
          assert.ok(trayTop + othersHeight + height + 12 <= viewportHeight, `the group ends below the window: ${JSON.stringify({ viewportHeight, trayTop, othersHeight, height })}`);
        } else {
          assert.equal(height, 0, 'the other pills already fill the window');
        }
      }
    }
  }
  assert.equal(trayGroupHeight({ trayTop: 0, othersHeight: 0, viewportHeight: 0 }), 310, 'no layout: the stylesheet bound');
});

// ── The helpers the fixes added (written with them: they could not fail first
//    on an assertion of their own; the sequences below did) ─────────────────

test('F3: what is below a session is found at any depth, by the chain a panel was made with and by the links known now', () => {
  const parentOf = new Map([['A', 'R'], ['B', 'A'], ['C', 'B'], ['X', 'R']]);
  assert.deepEqual(logic.lineageOf('C', parentOf), ['C', 'B', 'A', 'R']);
  assert.deepEqual(logic.lineageOf('R', parentOf), ['R']);
  assert.deepEqual(logic.lineageOf('', parentOf), []);
  assert.deepEqual(logic.lineageOf('P', new Map([['P', 'Q'], ['Q', 'P']])), ['P', 'Q'], 'a cycle ends');
  const entries = [
    { sessionId: 'A', chain: ['R'] }, { sessionId: 'B', chain: ['R', 'A'] },
    { sessionId: 'C', chain: ['R', 'A', 'B'] }, { sessionId: 'X', chain: ['R'] },
  ];
  const under = (id, links = parentOf, list = entries) => logic.entriesUnder(list, id, links).map((entry) => entry.sessionId);
  // A becomes an automation's session: A itself, B and C go; X does not.
  assert.deepEqual(under('A'), ['A', 'B', 'C']);
  assert.deepEqual(under('B'), ['B', 'C']);
  assert.deepEqual(under('R'), ['A', 'B', 'C', 'X']);
  assert.deepEqual(under('X'), ['X']);
  assert.deepEqual(under(''), []);
  // A link that was forgotten (the session in between was deleted): the chain the panel was made with says so.
  assert.deepEqual(under('A', new Map([['A', 'R'], ['C', 'B']])), ['A', 'B', 'C']);
  // A chain that is older than a link: the link says so.
  assert.deepEqual(under('A', new Map([['C', 'B'], ['B', 'A']]), [{ sessionId: 'C', chain: [] }]), ['C']);
});

test('F4: auto-accept is inherited along the sessions\' parent links, with or without a panel in between', () => {
  const parents = { C: 'B', B: 'A', A: 'R' };
  const parentOf = (id) => parents[id] || '';
  const on = (...ids) => (id) => ids.includes(id);
  // Neither A nor B has a panel: only the session in the main panel says "on".
  assert.equal(autoAcceptInherited('C', { parentOf, isOn: on('R') }), true);
  assert.equal(autoAcceptInherited('C', { parentOf, isOn: on('B') }), true);
  assert.equal(autoAcceptInherited('A', { parentOf, isOn: on('R') }), true);
  assert.equal(autoAcceptInherited('C', { parentOf, isOn: on() }), false);
  assert.equal(autoAcceptInherited('C', { parentOf, isOn: on('C') }), false, 'its own switch is its own, not inherited');
  assert.equal(autoAcceptInherited('R', { parentOf, isOn: on('R') }), false, 'the session in the main panel inherits from nobody');
  assert.equal(autoAcceptInherited('C', { parentOf: (id) => ({ C: 'B' }[id] || ''), isOn: on('R') }), false, 'a link that is not known is not assumed');
  assert.equal(autoAcceptInherited('X', { parentOf: (id) => ({ X: 'Y', Y: 'X' }[id] || ''), isOn: on() }), false, 'a cycle ends');
  assert.equal(autoAcceptInherited('', { parentOf, isOn: on('R') }), false);
  assert.equal(autoAcceptInherited('C', {}), false);
  // The socket layer asks it with the sessions' links, not with the stores of open panels.
  const ws = source('ocp-v2-ws.js');
  assert.match(ws, /return autoAcceptInherited\(s\.sessionId, \{\s+parentOf: \(sessionId\) => \(sessionId === s\.sessionId && s\.parentSessionId\) \|\| parentSessionOf\(sessionId\),/);
});

test('F1: a prompt that was on its way when its panel went is kept whole for its sub-agent, and the main panel is told', () => {
  const unsent = logic.createUnsentPrompts();
  const item = { id: 'q3', sending: true, text: 'deploy it', images: [{ name: 'a.png' }], paths: ['/x'], mentions: [{ type: 'file' }] };
  assert.equal(unsent.keep('child', item), true);
  assert.equal(unsent.keep('child', { text: '/review x', images: [], paths: [], mentions: [], command: { command: 'review', args: 'x' } }), true);
  assert.equal(unsent.keep('', item), false);
  assert.equal(unsent.keep('child', null), false);
  assert.deepEqual(unsent.peek('child').map((kept) => kept.text), ['deploy it', '/review x']);
  assert.equal(unsent.size(), 1);
  const back = unsent.take('child');
  assert.deepEqual(back[0], { text: 'deploy it', images: [{ name: 'a.png' }], paths: ['/x'], mentions: [{ type: 'file' }] }, 'whole, and nothing but the prompt');
  assert.deepEqual(back[1].command, { command: 'review', args: 'x' }, 'a command stays that command');
  assert.deepEqual([unsent.take('child'), unsent.peek('other'), unsent.size()], [[], [], 0], 'handed out once');
  const notice = logic.unsentSubagentNotice({ item, label: 'explore the repo', error: 'HTTP 500' });
  assert.match(notice, /^Not sent: “deploy it” with 2 attachments was on its way to the sub-agent “explore the repo” when its panel went away, and the send failed \(HTTP 500\)\./);
  assert.match(notice, /it is back in the compose box/);
  assert.match(logic.unsentSubagentNotice({ item: { text: '', images: [{}] } }), /^Not sent: \(attachments\) with 1 attachment was on its way to a sub-agent/);
  // The close question says what closing means for a prompt that is on its way.
  const one = logic.closeSubagentConfirm({ items: [{ text: 'deploy it', sending: true }], label: 'explore' });
  assert.match(one, /“deploy it”/);
  assert.match(one, /It is being sent: that goes on\. If it fails, the prompt is kept for this sub-agent and is back in its compose box/);
  assert.match(logic.closeSubagentConfirm({ items: [{ text: 'a', sending: true }, { text: 'b' }] }), /One of them is being sent/);
  assert.match(logic.closeSubagentConfirm({ items: [{ text: 'a', sending: true }, { text: 'b', sending: true }, { text: 'c' }] }), /2 of them are being sent/);
  assert.equal(/being sent/.test(logic.closeSubagentConfirm({ items: [{ text: 'b' }] })), false);
  assert.equal(logic.closeSubagentConfirm({ items: [] }), '');
});

test('F10 and F8: a pill that was rebuilt says done without a transcript, and a group that got little room scrolls and counts', () => {
  assert.equal(logic.pillState({ messageOrder: [] }).state, 'idle', 'a sub-agent that just started');
  assert.equal(logic.pillState({ messageOrder: [] }, { started: true }).state, 'done', 'one that ran before the page knew it');
  assert.equal(logic.pillState({ messageOrder: [], running: true }, { started: true }).state, 'running');
  assert.equal(logic.pillState({ messageOrder: [], pendingQuestions: [{}] }, { started: true }).state, 'waiting');
  assert.equal(logic.pillState({ messageOrder: [], errors: [{ message: 'x' }] }, { started: true }).state, 'failed');
  assert.equal(logic.trayGroupScrolls({ count: 8, height: 310 }), false);
  assert.equal(logic.trayGroupScrolls({ count: 9, height: 310 }), true);
  assert.equal(logic.trayGroupScrolls({ count: 3, height: 108 }), false);
  assert.equal(logic.trayGroupScrolls({ count: 4, height: 108 }), true);
  assert.equal(logic.trayGroupScrolls({ count: 1, height: 0 }), true);
  assert.equal(logic.trayGroupScrolls({ count: 3 }), false, 'not measured yet: the stylesheet bound');
  assert.equal(logic.trayGroupScrolls({ count: 0, height: 0 }), false);
});

test('F2: a compose box keeps nothing across a reload, in the main panel and in a sub-agent\'s panel alike', () => {
  // One composer for both kinds of panel. All it writes to storage: the agent
  // picked last and the history of the prompts that were sent.
  const send = source('ocp-v2-send.js');
  const writes = [...send.matchAll(/(?:sessionStorage|localStorage|storage)\.setItem\(([A-Z_]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(writes, ['STOR_HISTORY', 'STOR_MODE']);
  for (const file of ['ocp-v2-composer-logic.js', 'ocp-v2-send-logic.js', 'ocp-v2-childpanel.js']) {
    assert.equal(/(?:sessionStorage|localStorage|storage)\.setItem\(/.test(source(file)), false, `${file} stores nothing`);
  }
  assert.match(source('ocp-v2-childpanel.js'), /_composer = mountCompose\(compose, store, \{/);
  // The contract says so, for both.
  if (existsSync(CONTRACT_URL)) {
    assert.match(contract(), /The main panel keeps nothing of a compose box across a page\s+reload: its draft, its attachments and\s+its queue/);
    assert.match(contract(), /a sub-agent's panel keeps exactly that/);
  }
});

test('F6: what a composer registers, it removes when it is unmounted', () => {
  const send = source('ocp-v2-send.js');
  assert.match(send, /const releasePlanLifecycle = configurePlanLifecycle\(\{/);
  const unmount = send.slice(send.indexOf('    unmount() {'), send.indexOf('    focus,'));
  for (const call of ['unsubscribe();', 'unsubscribeQueue();', 'unsubscribeCaps();', 'releasePlanLifecycle();', 'for (const stop of [..._turnWatches])', '_mentionHints.destroy();', '_slashHints.destroy();']) {
    assert.ok(unmount.includes(call), `unmount: ${call}`);
  }
  assert.equal(/clearInterval\(pollHandle\)/.test(send.replace('const stopPolling = () => { clearInterval(pollHandle); _turnWatches.delete(stopPolling); };', '')), false, 'the transcript poll is stopped through its watch only');
});

// ── The DOM glue, under the stand-in ────────────────────────────────────────

test('F1 to F10: each rule as its sequence, with the real manager, panels, composers and socket layer', () => {
  const script = fileURLToPath(new URL('./opencode-subagents-review-glue.run.mjs', import.meta.url));
  const env = { ...process.env, SYNABUN_TYPESAFE: 'off' };
  delete env.SYNABUN_ASSISTANT_SESSION;
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 120_000, env });
  const stdout = String(result.stdout || '');
  const output = `${stdout}\n${result.stderr || ''}`;
  assert.equal(result.status, 0, output.slice(-6000));
  const steps = stdout.split('\n').filter((line) => /^(ok  |FAIL) /.test(line));
  assert.deepEqual(steps.filter((line) => line.startsWith('FAIL')), [], output.slice(-6000));
  for (const id of [
    'F1 close', 'F1 tab', 'F1 deleted', 'F1 accepted', 'F1 answer', 'F1 reach', 'F3 after', 'F3 before', 'F3 between', 'F4 reload', 'F4 live',
    'F5 a request', 'F5 nested', 'F5 link', 'F6 plan', 'F6 timers', 'F7', 'F8', 'F9', 'F10 reload', 'F10 reconnect',
  ]) {
    assert.ok(steps.some((line) => line.startsWith('ok  ') && line.includes(id)), `a step for ${id} ran`);
  }
  assert.match(stdout, /\nno problems\s*$/, output.slice(-6000));
});
