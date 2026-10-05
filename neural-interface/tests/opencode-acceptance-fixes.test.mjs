// Four fixes from the first live test of the rebuilt OpenCode panel (2026-10-04):
//   1. What publishes or destroys is asked in the panel, in two steps. A native
//      dialog (window.confirm) is accepted by an automated browser by itself:
//      one click on Share published the session.
//   2. The "shared" badge goes when sharing stops (OpenCode 1.18.34 keeps the
//      link in the session row and reports it with every later read).
//   3. /help is a card under the transcript, not "/" back in the box.
//   4. The footer under an answer says what OpenCode reports it cost, zero included.
// This file holds the DOM-free parts. The glue runs under the DOM stand-in,
// started at the end of the file: opencode-acceptance-panel.run.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import {
  createConfirmations, CONFIRM_TIMEOUT_MS, CONFIRM_MIN_DELAY_MS,
} from '../public/shared/ocp-v2/ocp-v2-confirm-logic.js';
import {
  createStoppedShares, deleteMessageConfirmText, shareView, SHARE_CONFIRM_TEXT,
} from '../public/shared/ocp-v2/ocp-v2-sessions-logic.js';
import { shareSession, unshareSession } from '../public/shared/ocp-v2/ocp-v2-session-actions.js';
import { applyEvent } from '../public/shared/ocp-v2/ocp-v2-events.js';
import {
  buildSlashCatalog, helpCardView, resolveSlash, HELP_COMMANDS_PER_SOURCE,
} from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';
import { formatCost, formatReportedCost, messageMetaText } from '../public/shared/ocp-v2/ocp-v2-tools-logic.js';

const PANEL_DIR = new URL('../public/shared/ocp-v2/', import.meta.url);
const source = (name) => readFileSync(new URL(name, PANEL_DIR), 'utf8');
const ok = (data) => ({ status: 200, data });
function boundStore(sessionId = 'ses_a', info = {}) {
  const store = createPanelStore();
  store.setSession(sessionId, { id: sessionId, ...info });
  return store;
}
// A clock and timers the test moves by hand.
function fakeTime() {
  let now = 1_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) { if (timer.at <= now) { timers.delete(id); timer.fn(); } }
    },
    pending: () => timers.size,
  };
}
// What a promise has resolved to by now, 'pending' when it has not: a question
// that is wrongly still armed fails its test instead of hanging the file.
async function outcome(promise) {
  let value = 'pending';
  promise.then((resolved) => { value = resolved; }, (err) => { value = err; });
  await new Promise((resolve) => setImmediate(resolve));
  return value;
}
const QUESTION = { key: 'share:ses_a', text: 'Share this session? It becomes public.', confirmLabel: 'Share publicly', surface: 'menu' };

// ═══ 1. Two steps, in the panel ═════════════════════════════════════════════

test('1: armed is not agreed: asking alone never resolves true, and the question on screen says what will happen', async () => {
  const time = fakeTime();
  const confirms = createConfirmations({ ...time });
  const seen = [];
  confirms.onChange((view, reason) => seen.push([view?.key || null, reason]));
  let answer = 'pending';
  confirms.ask(QUESTION).then((agreed) => { answer = agreed; });
  await Promise.resolve();
  assert.equal(answer, 'pending', 'one click (ask) agreed to nothing');
  assert.deepEqual(confirms.armed(), { key: 'share:ses_a', text: QUESTION.text, confirmLabel: 'Share publicly', cancelLabel: 'Cancel', surface: 'menu' });
  assert.equal(confirms.isArmed('share:ses_a'), true);
  assert.deepEqual(seen, [['share:ses_a', 'armed']]);
  // A question that does not say what will happen, or names no action, is not asked.
  const bare = createConfirmations({ ...time });
  assert.equal(await bare.ask({ key: 'x', text: '   ' }), false);
  assert.equal(await bare.ask({ text: 'Delete?' }), false);
  assert.equal(await bare.ask(), false);
  assert.equal(bare.armed(), null);
  assert.equal(time.pending(), 1, 'only the armed question has a timer');
});

test('1: confirmed: only the second step resolves true, for the question that is armed, and not within the same gesture', async () => {
  const time = fakeTime();
  const confirms = createConfirmations({ ...time });
  const asked = confirms.ask(QUESTION);
  // Nothing armed under that name, or no name at all: nothing confirmed.
  assert.equal(confirms.confirm('session-delete:ses_a'), false);
  assert.equal(confirms.confirm(), false);
  assert.equal(confirms.isArmed('share:ses_a'), true);
  // A second click that comes with the first (a double click) confirms nothing; the question stays.
  time.advance(CONFIRM_MIN_DELAY_MS - 1);
  assert.equal(confirms.confirm('share:ses_a'), false);
  assert.equal(confirms.isArmed('share:ses_a'), true);
  time.advance(1);
  assert.equal(confirms.confirm('share:ses_a'), true);
  assert.equal(await outcome(asked), true);
  assert.equal(confirms.armed(), null);
  assert.equal(time.pending(), 0, 'its timer is gone');
  // Answered once: a second confirm of the same key is nothing.
  assert.equal(confirms.confirm('share:ses_a'), false);
});

test('1: cancelled: Cancel, a newer question and a closed surface all answer no', async () => {
  const time = fakeTime();
  const confirms = createConfirmations({ ...time });
  const reasons = [];
  confirms.onChange((view, reason) => reasons.push(reason));
  const first = confirms.ask(QUESTION);
  assert.equal(confirms.cancel('other-key'), false, 'another key cancels nothing');
  assert.equal(confirms.cancel('share:ses_a'), true);
  assert.equal(await outcome(first), false);
  // A newer question takes the place of the one that was up.
  const second = confirms.ask(QUESTION);
  const third = confirms.ask({ key: 'session-delete:ses_b', text: 'Delete "B"?', confirmLabel: 'Delete session', surface: 'menu' });
  assert.equal(await outcome(second), false);
  assert.equal(confirms.armed().key, 'session-delete:ses_b');
  time.advance(CONFIRM_MIN_DELAY_MS);
  assert.equal(confirms.confirm('share:ses_a'), false, 'the replaced question cannot be confirmed');
  // The surface it was drawn on is closed.
  assert.equal(confirms.cancel((view) => view.surface === 'dialog'), false);
  assert.equal(confirms.cancel((view) => view.surface === 'menu'), true);
  assert.equal(await outcome(third), false);
  assert.equal(confirms.cancel(), false, 'nothing left to cancel');
  assert.deepEqual(reasons, ['armed', 'cancelled', 'armed', 'replaced', 'armed', 'cancelled']);
});

test('1: timed out: a question nobody answers is a no, and its button no longer works', async () => {
  const time = fakeTime();
  const confirms = createConfirmations({ ...time });
  const reasons = [];
  confirms.onChange((view, reason) => reasons.push(reason));
  const asked = confirms.ask(QUESTION);
  time.advance(CONFIRM_TIMEOUT_MS - 1);
  assert.equal(confirms.isArmed('share:ses_a'), true);
  time.advance(1);
  assert.equal(await outcome(asked), false);
  assert.equal(confirms.armed(), null);
  assert.equal(confirms.confirm('share:ses_a'), false);
  assert.deepEqual(reasons, ['armed', 'timeout']);
  // Also when the timer itself is late (a throttled tab): the click checks the clock.
  const slow = fakeTime();
  const late = createConfirmations({ now: slow.now, setTimer: () => 0, clearTimer: () => {} });
  const pending = late.ask(QUESTION);
  slow.advance(CONFIRM_TIMEOUT_MS);
  assert.equal(late.confirm('share:ses_a'), false);
  assert.equal(await outcome(pending), false);
});

test('1: session changed while armed: the question is off, also for A → B → A, and nothing is confirmed', async () => {
  const time = fakeTime();
  const store = boundStore('ses_a');
  const confirms = createConfirmations({ store, ...time });
  const reasons = [];
  confirms.onChange((view, reason) => reasons.push(reason));
  const asked = confirms.ask(QUESTION);
  // Metadata of the same session is not a move.
  store.setSessionInfo({ id: 'ses_a', title: 'renamed' });
  assert.equal(confirms.isArmed('share:ses_a'), true);
  store.setSession('ses_b', { id: 'ses_b' });
  assert.equal(await outcome(asked), false);
  assert.equal(confirms.armed(), null);
  assert.deepEqual(reasons, ['armed', 'moved']);
  // Back on the session it was asked on: still off.
  store.setSession('ses_a', { id: 'ses_a' });
  time.advance(CONFIRM_MIN_DELAY_MS);
  assert.equal(confirms.confirm('share:ses_a'), false);
  // A question asked now belongs to this binding, and is confirmed on it.
  const again = confirms.ask(QUESTION);
  time.advance(CONFIRM_MIN_DELAY_MS);
  assert.equal(confirms.confirm('share:ses_a'), true);
  assert.equal(await outcome(again), true);
  // The click itself checks the binding (a listener that has not run yet changes nothing).
  const quiet = { getState: () => ({ sessionId: 'ses_q' }), getBinding: () => quiet.binding, binding: 1, subscribe: () => () => {} };
  const unheard = createConfirmations({ store: quiet, ...time });
  const pending = unheard.ask(QUESTION);
  quiet.binding = 2;
  time.advance(CONFIRM_MIN_DELAY_MS);
  assert.equal(unheard.confirm('share:ses_a'), false);
  assert.equal(await outcome(pending), false);
});

test('1: sharing through the panel\'s question: one click publishes nothing; the second step does; a move in between publishes nothing', async () => {
  const time = fakeTime();
  const store = boundStore('ses_a');
  const confirms = createConfirmations({ store, ...time });
  let shared = 0;
  const api = { sessionShare: async () => { shared += 1; return ok({ id: 'ses_a', share: { url: 'https://opncd.ai/share/a' } }); } };
  const ask = () => confirms.ask({ key: 'share:ses_a', surface: 'menu', text: SHARE_CONFIRM_TEXT, confirmLabel: 'Share publicly' });
  // The question says that the transcript becomes readable at a public URL.
  assert.match(SHARE_CONFIRM_TEXT, /published at a public URL\. Anyone with the link can read it until you stop sharing\./);
  const first = shareSession(store, api, ask);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shared, 0, 'the first click published the session');
  time.advance(CONFIRM_MIN_DELAY_MS);
  confirms.confirm('share:ses_a');
  assert.deepEqual(await outcome(first), { ok: true, url: 'https://opncd.ai/share/a' });
  assert.equal(shared, 1);
  // Cancel.
  const second = shareSession(store, api, ask);
  confirms.cancel('share:ses_a');
  assert.deepEqual(await outcome(second), { ok: false, cancelled: true });
  // The panel moves while the question is up.
  const third = shareSession(store, api, ask);
  store.setSession('ses_b', { id: 'ses_b' });
  assert.deepEqual(await outcome(third), { ok: false, cancelled: true });
  assert.equal(shared, 1, 'nothing more was published');
});

test('1: no native dialog is left in the panel: every publishing or destructive action asks through the panel\'s own question', () => {
  const files = readdirSync(PANEL_DIR).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 40, 'the panel modules were found');
  const code = (name) => source(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const name of files) {
    const text = code(name);
    assert.equal(/\b(?:window|globalThis|self)\s*\.\s*(?:confirm|alert|prompt)\b/.test(text), false, `${name} reaches for a native dialog`);
    assert.equal(/(?:^|[^.\w$])(?:alert|prompt)\s*\(/m.test(text), false, `${name} calls alert() or prompt()`);
    // A bare confirm(…) is the callback a DOM-free action is handed, nowhere else.
    if (/(?:^|[^.\w$])confirm\s*\(/m.test(text)) {
      assert.ok(['ocp-v2-session-actions.js', 'ocp-v2-status-logic.js'].includes(name), `${name} calls confirm()`);
    }
  }
  assert.match(source('ocp-v2-session-actions.js'), /export async function shareSession\(store, api, confirm, \{ stopped = null \} = \{\}\) \{/);
  assert.match(source('ocp-v2-status-logic.js'), /export async function addMcpServer\(\{ name, input, rows = \[\], confirm, register, canPersist = true \}\) \{/);

  const panel = source('ocp-v2-panel.js');
  // Share: the menu item and /share go through one function, which asks in the menu.
  assert.match(panel, /share: \(\) => shareActiveSession\(\),/);
  assert.match(panel, /const shareItem = menuItem\('Share session…', \(\) => \{\s+shareActiveSession\(\)/);
  assert.match(panel, /const result = await shareSession\(getDefaultStore\(\), api, \(\) => _confirms\.ask\(\{\s+key: `share:\$\{sid\}`, surface: 'menu', text: SHARE_CONFIRM_TEXT, confirmLabel: 'Share publicly',\s+\}\), \{ stopped: _stoppedShares \}\);/);
  assert.equal((panel.match(/(?<![A-Za-z])shareSession\(/g) || []).length, 1, 'one way to share');
  // A question of the menu goes with the menu.
  assert.match(panel, /function closeSessionMenu\(\) \{\s+_sessionMenuEl\?\.classList\.remove\('open'\);\s+[^\n]*\n\s+_confirms\.cancel\(\(view\) => view\.surface === 'menu'\);/);
  // Removing a worktree (its directory and uncommitted changes) asks in the dialog, before the request.
  const worktree = panel.slice(panel.indexOf("remove.addEventListener('click', async () => {"), panel.indexOf('row.append(name, remove);'));
  assert.match(worktree, /const agreed = await _confirms\.ask\(\{\s+key, surface: 'dialog', confirmLabel: 'Remove worktree',\s+text: `Remove the worktree "\$\{tree\.name\}"\? Its directory and uncommitted changes are deleted\.`,\s+\}\);\s+if \(!agreed\) return;/);
  assert.ok(worktree.indexOf('if (!agreed) return;') < worktree.indexOf('api.worktreeRemove('), 'asked before the worktree is removed');
  assert.match(panel, /offWorktreeConfirm\(\);\s+_confirms\.cancel\(dialogQuestion\);\s+overlay\.remove\(\);/);
  // Deleting a message: the renderer asks through the panel, and deletes nothing when it cannot ask.
  const render = source('ocp-v2-render.js');
  assert.match(render, /const agreed = typeof opts\.confirm === 'function' && \(await opts\.confirm\(\{\s+key: `message-delete:\$\{msg\.id\}`, text: deleteMessageConfirmText\(msg\), confirmLabel: 'Delete message',\s+\}\)\) === true;\s+if \(!agreed\) return;\s+report\(await deleteMessage\(/);
  assert.match(panel, /confirm: \(question\) => _confirms\.ask\(\{ surface: 'panel', \.\.\.question \}\),/);
  // The row has the two answers and nothing else that acts.
  const row = source('ocp-v2-confirm.js');
  assert.match(row, /answer\('ocpv2-confirm-yes', view\.confirmLabel, \(\) => confirms\.confirm\(view\.key\)\),\s+answer\('ocpv2-confirm-no', view\.cancelLabel, \(\) => confirms\.cancel\(view\.key\)\),/);
  assert.match(row, /text\.textContent = view\.text;/);
});

test('1: the question before a message is deleted names the message', () => {
  const msg = (text) => ({ id: 'msg_1', role: 'user', parts: [{ type: 'text', text }] });
  assert.equal(deleteMessageConfirmText(msg('fix the\n  build')), 'Delete the message “fix the build” from the session? This cannot be undone.');
  assert.equal(deleteMessageConfirmText(msg('x'.repeat(200))), `Delete the message “${'x'.repeat(80)}…” from the session? This cannot be undone.`);
  assert.equal(deleteMessageConfirmText({ id: 'msg_2', role: 'user', parts: [{ type: 'file', url: 'data:x' }] }), 'Delete this message from the session? This cannot be undone.');
});

// ═══ 2. The "shared" badge ══════════════════════════════════════════════════

test('2: a link whose sharing was stopped is no share in any session info, until the session is shared again', () => {
  const saved = [];
  const stopped = createStoppedShares({ save: (entries) => saved.push({ ...entries }) });
  const URL_A = 'https://opncd.ai/share/aaaa1111';
  const row = { id: 'ses_a', title: 'A', share: { url: URL_A } };
  assert.equal(stopped.clean(row), row, 'nothing stopped: the row is the row');
  assert.equal(stopped.stop('ses_a', URL_A), true);
  assert.equal(stopped.isStopped('ses_a', URL_A), true);
  assert.deepEqual(saved.at(-1), { ses_a: URL_A });
  // What OpenCode still reports for that session: the link is taken out, explicitly (a merge clears it).
  const cleaned = stopped.clean(row);
  assert.deepEqual(cleaned, { id: 'ses_a', title: 'A', share: undefined });
  assert.ok('share' in cleaned);
  assert.equal(row.share.url, URL_A, 'the caller\'s object is not changed');
  assert.equal(shareView(cleaned, 'manual', () => true).canUnshare, false);
  assert.equal(shareView(cleaned, 'manual', () => true).canShare, true);
  // Other sessions, and info without a link, pass.
  const other = { id: 'ses_b', share: { url: URL_A } };
  assert.equal(stopped.clean(other), other);
  assert.equal(stopped.clean(null), null);
  assert.equal(stopped.clean({ sessionID: 'ses_a', share: { url: URL_A } }).share, undefined, 'the other spelling of the id');
  // Another link for that session is a new share made somewhere else: real, and the entry goes.
  const reshared = { id: 'ses_a', share: { url: 'https://opncd.ai/share/zzzz9999' } };
  assert.equal(stopped.clean(reshared), reshared);
  assert.equal(stopped.isStopped('ses_a', URL_A), false);
  assert.deepEqual(saved.at(-1), {});
  // Shared again from the panel (the same link comes back).
  stopped.stop('ses_a', URL_A);
  assert.equal(stopped.resume('ses_a'), true);
  assert.equal(stopped.clean(row), row);
  assert.equal(stopped.resume('ses_a'), false);
  // Nothing to remember without a link or a session.
  assert.equal(stopped.stop('ses_a', ''), false);
  assert.equal(stopped.stop('', URL_A), false);
  // Kept across a reload, and bounded: the oldest go first.
  const reloaded = createStoppedShares({ load: () => ({ ses_x: URL_A, bad: 7 }) });
  assert.equal(reloaded.isStopped('ses_x', URL_A), true);
  assert.equal(reloaded.size(), 1);
  assert.equal(createStoppedShares({ load: () => { throw new Error('unreadable'); } }).size(), 0);
  const small = createStoppedShares({ max: 2 });
  small.stop('s1', 'u1'); small.stop('s2', 'u2'); small.stop('s3', 'u3');
  assert.deepEqual([small.isStopped('s1', 'u1'), small.isStopped('s2', 'u2'), small.isStopped('s3', 'u3')], [false, true, true]);
});

test('2: Stop sharing clears the link in the store, although the reply, the events and the session reads still carry it', async () => {
  const URL_A = 'https://opncd.ai/share/aaaa1111';
  const stale = { id: 'ses_a', title: 'A', share: { url: URL_A }, version: '1.18.34' };   // what OpenCode's row says, for ever
  const stopped = createStoppedShares();
  const store = boundStore('ses_a', { share: { url: URL_A } });
  store.setSessionInfoFilter((info) => stopped.clean(info));
  assert.equal(store.getState().sessionInfo.share.url, URL_A, 'setup: shared');
  // The reply to the unshare is read from the stale row.
  const api = { sessionUnshare: async () => ok(stale), sessionShare: async () => ok(stale) };
  assert.deepEqual(await unshareSession(store, api, { stopped }), { ok: true });
  assert.equal(store.getState().sessionInfo.share, undefined, 'the reply put the link back');
  assert.equal(stopped.isStopped('ses_a', URL_A), true);
  // A session.updated built from the row (a new prompt touches the session).
  applyEvent(store, 'session.updated', { info: { ...stale, title: 'A, touched' } });
  assert.equal(store.getState().sessionInfo.title, 'A, touched');
  assert.equal(store.getState().sessionInfo.share, undefined, 'a session.updated put the link back');
  // The session read again (a tab switch, a recovery): a list row, then session:get.
  store.setSession('ses_b', { id: 'ses_b' });
  store.setSession('ses_a', stale);
  assert.equal(store.getState().sessionInfo.share, undefined, 'the tab\'s row put the link back');
  store.setSessionInfo(stale);
  assert.equal(store.getState().sessionInfo.share, undefined, 'session:get put the link back');
  assert.equal(store.getState().knownSessions.get('ses_a').share, undefined, 'the cached session info holds the link');
  store.setKnownSessions([stale, { id: 'ses_c', share: { url: 'https://opncd.ai/share/c' } }]);
  assert.equal(store.getState().knownSessions.get('ses_a').share, undefined);
  assert.equal(store.getState().knownSessions.get('ses_c').share.url, 'https://opncd.ai/share/c', 'another session\'s share is untouched');
  // Shared again from the panel: the same link is a share once more.
  const out = await shareSession(store, api, () => true, { stopped });
  assert.deepEqual(out, { ok: true, url: URL_A });
  assert.equal(store.getState().sessionInfo.share.url, URL_A);
  assert.equal(stopped.isStopped('ses_a', URL_A), false);
});

test('2: a stop that is answered after the panel moved on is still that session\'s; a refused one remembers nothing', async () => {
  const URL_A = 'https://opncd.ai/share/aaaa1111';
  const stopped = createStoppedShares();
  const store = boundStore('ses_a', { share: { url: URL_A } });
  store.setSessionInfoFilter((info) => stopped.clean(info));
  let release;
  const api = { sessionUnshare: () => new Promise((resolve) => { release = () => resolve(ok({ id: 'ses_a' })); }) };
  const pending = unshareSession(store, api, { stopped });
  store.setSession('ses_b', { id: 'ses_b' });
  release();
  assert.deepEqual(await outcome(pending), { ok: false, moved: true });
  assert.equal(stopped.isStopped('ses_a', URL_A), true, 'the stop was not recorded for the session it was made for');
  store.setSession('ses_a', { id: 'ses_a', share: { url: URL_A } });
  assert.equal(store.getState().sessionInfo.share, undefined, 'back on the session, its stale row shows it as shared');
  // Refused by the server: still shared, nothing remembered.
  const refusing = createStoppedShares();
  const shared = boundStore('ses_r', { share: { url: URL_A } });
  shared.setSessionInfoFilter((info) => refusing.clean(info));
  const refused = await unshareSession(shared, { sessionUnshare: async () => ({ ok: false, status: 500, error: 'share service down' }) }, { stopped: refusing });
  assert.equal(refused.ok, false);
  assert.equal(refusing.size(), 0);
  assert.equal(shared.getState().sessionInfo.share.url, URL_A);
  // The panel wires both: the list rows and the store.
  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /getDefaultStore\(\)\.setSessionInfoFilter\?\.\(\(info\) => _stoppedShares\.clean\(info\)\);/);
  assert.match(panel, /const all = menuSessions\(sessions, \{ search \}\)\.slice\(0, SESSION_MENU_LIMIT\)\.map\(\(row\) => _stoppedShares\.clean\(row\)\);/);
  assert.match(panel, /const result = await unshareSession\(getDefaultStore\(\), api, \{ stopped: _stoppedShares \}\);/);
  assert.equal(/_tabInfoCache\.set\((?![^\n]*_stoppedShares\.clean\()/.test(panel), false, 'the tab cache takes session info only through the filter');
});

// ═══ 3. /help ═══════════════════════════════════════════════════════════════

test('3: the help card lists what the composer can do, from the catalog the slash menu uses, each command with its source', () => {
  const supports = (type) => type !== 'reference:list';
  const serverCommands = [
    { name: 'review', description: 'Review the diff', source: 'command' },
    ...Array.from({ length: HELP_COMMANDS_PER_SOURCE + 3 }, (_, i) => ({ name: `skill-${i}`, description: `Skill ${i}`, source: 'skill' })),
    { name: 'summarise', description: 'An MCP prompt', source: 'mcp' },
  ];
  const catalog = buildSlashCatalog({ serverCommands, supports });
  const card = helpCardView({ catalog, supports });
  assert.equal(card.title, 'OpenCode panel help');
  assert.equal(card.note, 'Shown here only: nothing was sent to the model.');
  assert.deepEqual(card.sections.map((section) => section.title), ['Slash commands', 'Mentions', 'Shell mode', 'Queue', 'Message actions']);
  const commands = card.sections[0].rows;
  const row = (name) => commands.find((entry) => entry.name === name);
  assert.deepEqual(row('/new, /clear'), { name: '/new, /clear', text: 'Start a new session', source: 'panel' });
  assert.deepEqual(row('/help'), { name: '/help', text: 'Show what the composer can do', source: 'panel' });
  assert.deepEqual(row('/review'), { name: '/review', text: 'Review the diff', source: 'OpenCode command' });
  assert.deepEqual(row('/skill-0'), { name: '/skill-0', text: 'Skill 0', source: 'skill' });
  assert.deepEqual(row('/summarise'), { name: '/summarise', text: 'An MCP prompt', source: 'MCP prompt' });
  assert.deepEqual(row('/themes'), { name: '/themes', text: 'Pick a theme', source: 'opens the terminal' });
  // Every command the menu lists is on the card, or counted: nothing is invented, nothing dropped silently.
  assert.equal(commands.filter((entry) => entry.source === 'skill' && entry.name !== '…').length, HELP_COMMANDS_PER_SOURCE);
  assert.deepEqual(commands.find((entry) => entry.name === '…'), { name: '…', text: 'and 3 more: type / to list them all', source: 'skill' });
  const listed = commands.filter((entry) => entry.name !== '…').length;
  assert.equal(listed + 3, catalog.length);
  // What the server cannot do is not offered.
  assert.equal(card.sections[1].rows[0].text, 'Type @ and pick a file, a workspace symbol or an MCP resource: it is sent with the prompt.');
  assert.match(card.sections[2].rows[0].text, /^Press ! in the empty box to run a shell command/);
  assert.match(card.sections[3].rows[0].text, /While a turn runs, Enter queues the prompt\./);
  assert.deepEqual(card.sections[4].rows, [
    { name: 'Your prompts', text: 'Hover one: Copy, Undo to here, Fork from here, Delete.' },
    { name: 'Replies', text: 'Hover one: Copy, Retry.' },
  ]);
  // An older server (no capabilities) and a sub-agent panel: only what works there.
  const bare = helpCardView({ catalog: buildSlashCatalog({}), supports: () => false });
  assert.deepEqual(bare.sections.map((section) => section.title), ['Slash commands', 'Queue', 'Message actions']);
  assert.equal(bare.sections[0].rows.some((entry) => entry.name === '/share' || entry.name === '/undo'), false);
  assert.deepEqual(bare.sections[2].rows.map((entry) => entry.text), ['Hover one: Copy.', 'Hover one: Copy.']);
  assert.deepEqual(helpCardView({ catalog, supports, canAct: false }).sections[4].rows.map((entry) => entry.text), ['Hover one: Copy.', 'Hover one: Copy.']);
  assert.deepEqual(helpCardView().sections.map((section) => section.title), ['Queue', 'Message actions']);
});

test('3: /help is local: the composer shows the card and writes nothing into the box; the card goes when the panel moves', () => {
  assert.deepEqual(resolveSlash('/help', buildSlashCatalog({})), { kind: 'local', action: 'help', name: 'help', args: '' });
  const send = source('ocp-v2-send.js');
  const help = send.slice(send.indexOf("        case 'help':"), send.indexOf('        default: {'));
  assert.match(help, /store\.setHelpCard\?\.\(helpCardView\(\{\s+catalog: getSlashCatalog\(composerCwd\(\)\), supports, canAct: !s\.parentSessionId,\s+\}\)\);\s+return;/);
  assert.equal(/setText\(|sendTextMessage\(|api\./.test(help), false, '/help writes into the box or sends something');
  // The store keeps the card for the session it was asked in.
  const store = boundStore('ses_a');
  const events = [];
  store.subscribe((event) => events.push(event.type));
  const card = helpCardView({ catalog: buildSlashCatalog({}) });
  store.setHelpCard(card);
  assert.equal(store.getState().helpCard, card);
  store.setSessionInfo({ id: 'ses_a', title: 'renamed' });
  assert.equal(store.getState().helpCard, card, 'metadata of the same session keeps the card');
  assert.equal(store.getState().messageOrder.length, 0, 'the card is not a message');
  store.setSession('ses_b', { id: 'ses_b' });
  assert.equal(store.getState().helpCard, null, 'the card followed the panel to another session');
  store.setHelpCard(card);
  store.setHelpCard(null);
  assert.equal(store.getState().helpCard, null);
  assert.equal(events.filter((type) => type === 'help:set').length, 3);
  // The renderer draws it from data, as text.
  const render = source('ocp-v2-render.js');
  assert.match(render, /if \(s\.helpCard\) \{\s+desired\.push\(\{\s+key: 'help',/);
  const draw = render.slice(render.indexOf('function renderHelpCard('), render.indexOf('function renderPostPlanCard('));
  assert.equal(/innerHTML/.test(draw), false, 'the help card is built with textContent');
});

// ═══ 4. The cost of a free model ════════════════════════════════════════════

test('4: the footer under an answer shows the cost OpenCode reports, zero included, in the same place and format', () => {
  assert.equal(formatReportedCost(0), '$0.00');
  assert.equal(formatReportedCost(0.004321), formatCost(0.004321));
  assert.equal(formatReportedCost(0.5123), '$0.512');
  assert.equal(formatReportedCost(12.3456), '$12.35');
  // Nothing reported (an older transcript), or not a cost: nothing shown.
  for (const none of [undefined, null, '', '0', Number.NaN, -1, Infinity]) assert.equal(formatReportedCost(none), '', String(none));
  const free = { role: 'assistant', modelID: 'big-pickle', agent: 'build', cost: 0, tokens: { input: 900, output: 300, reasoning: 0 }, time: { created: 1000, completed: 5000 } };
  assert.equal(messageMetaText(free), 'big-pickle · build · 1.2k tok · $0.00 · 4.0s');
  assert.equal(messageMetaText({ ...free, cost: 0.0421 }), 'big-pickle · build · 1.2k tok · $0.042 · 4.0s', 'a paid answer reads as before');
  const { cost, ...unreported } = free;
  assert.equal(messageMetaText(unreported), 'big-pickle · build · 1.2k tok · 4.0s', 'no cost reported: none invented');
  // The session total in the context bar is unchanged: nothing to show for a free session.
  assert.equal(formatCost(0), '');
});

// ═══ The panel itself, under the DOM stand-in ═══════════════════════════════

test('1, 2, 3, 4: the real panel (share, /share, stop sharing, delete a session, delete a message, /help)', () => {
  const file = fileURLToPath(new URL('./opencode-acceptance-panel.run.mjs', import.meta.url));
  const env = { ...process.env, SYNABUN_TYPESAFE: 'off' };
  delete env.SYNABUN_ASSISTANT_SESSION;
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 120_000, env });
  const stdout = String(result.stdout || '');
  const output = `${stdout}\n${result.stderr || ''}`;
  assert.equal(result.status, 0, output.slice(-6000));
  assert.match(stdout, /no problems/, output.slice(-6000));
  assert.equal((stdout.match(/^ok {3}/gm) || []).length, 6, stdout.slice(-3000));
});
