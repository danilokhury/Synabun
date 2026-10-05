// Review 5 of the Claude panel parity build, browser side.
// W05: Compact set only `tab.compacting`, which neither a second Compact click
// nor a send looked at, so both could reach a session that was still closing
// the old conversation's process. Now a Compact the user started holds the
// composer until its turn ends: a second Compact does nothing and a prompt
// waits in the queue, as it does behind a running turn.
// cp/cp-compose.js is DOM-free and runs here; the panel file is checked by
// source contract (it cannot be imported in Node).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compactHolds, isCompactCommand, COMPACT_HOLD_MS } from '../public/shared/cp/cp-compose.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(HERE, '..', 'public', 'shared', 'ui-claude-panel.js'), 'utf8').replace(/\r\n/g, '\n');
const fn = (name) => new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(panel)?.[0] || '';
const NOW = 1_800_000_000_000;

// ── The decision ──

test('W05: a Compact the user started holds the composer until its turn ends', () => {
  const tab = { running: false, compacting: false };
  assert.equal(compactHolds(tab, NOW), false, 'nothing was sent: nothing is held');
  // The click: the panel notes when it sent the Compact.
  tab.compacting = true;
  tab._compactSentAt = NOW;
  assert.equal(compactHolds(tab, NOW), true);
  assert.equal(compactHolds(tab, NOW + 90_000), true, 'for as long as it takes');
  // An event of the compaction clears the "compacting" label before the turn is over: still held.
  tab.compacting = false;
  assert.equal(compactHolds(tab, NOW + 1000), true, 'the hold follows the turn, not the label');
  // The turn ended (finishTab drops the note).
  tab._compactSentAt = 0;
  assert.equal(compactHolds(tab, NOW + 2000), false);
});

test('W05: a running turn is not this hold: the rules of a running turn apply to it', () => {
  assert.equal(compactHolds({ running: true, compacting: true, _compactSentAt: NOW }, NOW), false);
});

test('W05: a compaction the CLI started by itself holds nothing', () => {
  assert.equal(compactHolds({ running: false, compacting: true }, NOW), false);
  assert.equal(compactHolds({ running: false, compacting: true, _compactSentAt: 0, _lastWsActivity: NOW }, NOW), false);
});

test('W05: a Compact that is never answered does not hold the tab for ever', () => {
  const tab = { running: false, compacting: true, _compactSentAt: NOW };
  assert.equal(compactHolds(tab, NOW + COMPACT_HOLD_MS - 1), true);
  assert.equal(compactHolds(tab, NOW + COMPACT_HOLD_MS), false, 'silent for as long as a running turn is waited on: the hold lapses');
  // A session that is still talking keeps it.
  tab._lastWsActivity = NOW + COMPACT_HOLD_MS - 1000;
  assert.equal(compactHolds(tab, NOW + COMPACT_HOLD_MS), true);
  assert.equal(compactHolds(tab, NOW + 2 * COMPACT_HOLD_MS), false);
  assert.equal(compactHolds(null, NOW), false);
  assert.equal(compactHolds(undefined), false);
});

test('W05: /compact, with or without arguments, is the Compact command', () => {
  for (const text of ['/compact', ' /compact ', '/COMPACT', '/compact keep the plan', '/compact\nkeep']) assert.equal(isCompactCommand(text), true, JSON.stringify(text));
  for (const text of ['', null, undefined, 'compact', '/compaction', '/compac', 'please /compact', '/clear']) assert.equal(isCompactCommand(text), false, JSON.stringify(text));
});

// ── The panel uses it ──

test('W05: each of the three ways to Compact does nothing while one is under way, and notes when it sends one', () => {
  const sends = panel.split("_sendControl(tab, { type: 'compact' });");
  assert.equal(sends.length - 1, 3, 'the Compact button, /compact and the plan card');
  for (const before of sends.slice(0, 3)) {
    const lead = before.slice(-900);
    const running = lead.lastIndexOf('Cannot compact while Claude is processing.');
    const held = lead.lastIndexOf('if (compactHolds(tab))');
    const noted = lead.lastIndexOf('tab._compactSentAt = Date.now();');
    assert.ok(running >= 0, 'a running turn still refuses it, with the reason');
    assert.ok(held > running, 'then: a Compact already under way makes this one do nothing');
    assert.ok(noted > held, 'then: the tab notes that it sent one');
    // Nothing is said and nothing is sent on that path.
    const heldLine = lead.slice(held, lead.indexOf('\n', held));
    assert.match(heldLine, /return( true)?;/);
    assert.equal(/appendStatus|_sendControl/.test(heldLine), false);
  }
});

test('W05: a prompt sent while a Compact is under way waits in the queue; an empty send and a second /compact do nothing', () => {
  const send = fn('send');
  assert.ok(send, 'send() found');
  const held = send.indexOf('const compactHeld = compactHolds(tab);');
  const second = send.indexOf('if (compactHeld && isCompactCommand(text)) {');
  const empty = send.indexOf('if (compactHeld && !text && !tab.attachedImages.length && !tab.attachedFiles.length) return;');
  const busy = send.indexOf('if (tab.running || compactHeld) {');
  const stop = send.indexOf("tab.ws.send(JSON.stringify({ type: 'abort' })); return;");
  const btw = send.indexOf('if (shift && !compactHeld) {');
  const queued = send.indexOf('addToQueue(tab, text, images, files);');
  const slash = send.indexOf('if (runSlashCommand(tab, text)) {');
  const query = send.indexOf("type: 'query', prompt,");
  for (const [name, at] of Object.entries({ held, second, empty, busy, stop, btw, queued, slash, query })) assert.ok(at >= 0, name);
  assert.ok(held < second && second < empty && empty < busy, 'decided before anything is sent');
  assert.ok(busy < stop && stop < btw && btw < queued, 'the queue path of a running turn is the one it takes');
  assert.ok(queued < slash && queued < query, 'before the slash router and before the query is built');
  // The stop (an empty send) and the interrupt (Shift+Enter) stay a running turn's alone.
  assert.equal(send.slice(empty, stop).includes("type: 'abort'"), false);
  assert.match(send.slice(second, empty), /\$input\.value = ''; autoResize\(\); hideSlashHints\(\); return; }/, 'the second /compact is dropped from the input, and nothing is sent');
  assert.equal(send.includes('\n  if (tab.running) {\n'), false, 'one busy branch, not two');
});

test('W05: the queue does not advance into a Compact, and goes on when its turn ends', () => {
  const advance = fn('advanceQueue');
  const guard = advance.indexOf('if (compactHolds(tab)) return;');
  assert.ok(guard >= 0 && guard < advance.indexOf('tab.queue.shift()'), 'checked before an item is taken off the queue');
  // The turn's end drops the note (finishTab runs for done, stopped and error), and `done` advances the queue.
  const finish = fn('finishTab');
  assert.match(finish, /tab\._compactSentAt = 0;/);
  const done = panel.slice(panel.indexOf("finishTab(tab, !tab.running);"), panel.indexOf("case 'aborted':"));
  assert.match(done, /setTimeout\(\(\) => advanceQueue\(tab\), 300\);/);
});

test('W05: nothing leaves the hold behind: a closed socket and another conversation drop the note too', () => {
  const close = panel.slice(panel.indexOf("ws.addEventListener('close', () => {"), panel.indexOf("ws.addEventListener('error', () => ws.close());"));
  assert.match(close, /tab\._compactSentAt = 0;/);
  assert.match(panel, /tab\.compacting = false;\n  tab\._compactSentAt = 0;\n  _setCompactingUI\(false\);\n  tab\.turns = 0;/, 'New chat and the session menu');
  // The note is running state: it is not saved with the tab.
  assert.equal(fn('saveTabs').includes('_compactSentAt'), false);
  // Set by the three senders, dropped in three places, read only through compactHolds().
  assert.equal(panel.split('tab._compactSentAt = Date.now();').length - 1, 3);
  assert.equal(panel.split('tab._compactSentAt = 0;').length - 1, 3);
  assert.equal(panel.split('_compactSentAt').length - 1, 6);
});
