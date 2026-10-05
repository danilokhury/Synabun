// Code review 1 of the OpenCode panel rebuild: dialog, session switch, composer.
// F01 project and branch names never become markup.
// F06 selecting a session restores what it last ran with (from a real list row).
// F07 the agent list is asked again once OpenCode is up, per directory.
// F08 Retry and Undo keep the prompt's attachments.
// F09 a worktree creation only accepts its own completion.
// F10 a session in a new worktree never switches the project's checkout.
// F11 one composer's command catalog does not replace another's.
// F12 a slash-command turn carries attached paths and mentions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeNode } from './opencode-panel-dom.fixtures.mjs';
import { setSelectOptions, projectOptionRows } from '../public/shared/ocp-v2/ocp-v2-select.js';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import {
  replayablePrompt, pathOfFileUrl, hasSessionDetail, sessionSelections,
} from '../public/shared/ocp-v2/ocp-v2-sessions-logic.js';
import {
  retryFromMessage, revertToMessage, restoreDraftAttachments, loadSessionDetail, applySessionSelections,
} from '../public/shared/ocp-v2/ocp-v2-session-actions.js';
import {
  createAgentCatalog, createAgentChoice, resolveAgent, createSlashCatalogCache, buildSlashCatalog, resolveSlash,
  commandFileParts, imageFileParts, mentionFileParts,
} from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';
import {
  watchWorktree, waitForWorktree, newSessionPlan, checkoutOutcome,
} from '../public/shared/ocp-v2/ocp-v2-changes-logic.js';
import { mapSessionListRow } from '../lib/opencode-v2-ws-requests.js';

const source = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');

// ── F01 ─────────────────────────────────────────────────────────────────────

test('F01: a hostile project or branch name is an option label, never markup', () => {
  const hostile = '<select><img src=x onerror=alert(1)>';
  const select = makeNode('select');
  select.ownerDocument;   // the stand-in resolves it lazily
  const rows = projectOptionRows([{ path: `/Users/me/${hostile}` }, '/Users/me/plain', { path: '' }, null]);
  assert.deepEqual(rows, [
    { value: `/Users/me/${hostile}`, label: hostile },
    { value: '/Users/me/plain', label: 'plain' },
  ]);
  const made = [];
  const doc = { createElement: (tag) => { const node = makeNode(tag); made.push(node); return node; } };
  Object.defineProperty(select, 'ownerDocument', { value: doc, configurable: true });
  const options = setSelectOptions(select, rows, { placeholder: '(none)' });
  assert.equal(options.length, 3);
  assert.deepEqual(options.map((o) => [o.tagName, o.value, o.textContent]), [
    ['OPTION', '', '(none)'],
    ['OPTION', `/Users/me/${hostile}`, hostile],
    ['OPTION', '/Users/me/plain', 'plain'],
  ]);
  assert.equal(select.innerHTML, '', 'nothing was written as HTML');
  assert.equal(made.every((node) => node.innerHTML === ''), true);
  assert.deepEqual(select.children, options);

  // Branch names: plain strings in, same treatment; a refill replaces the options.
  const branch = setSelectOptions(select, ['main', '"><script>alert(1)</script>']);
  assert.deepEqual(branch.map((o) => o.textContent), ['main', '"><script>alert(1)</script>']);
  assert.deepEqual(branch.map((o) => o.value), ['main', '"><script>alert(1)</script>']);
  assert.equal(select.children.length, 2);
  assert.deepEqual(setSelectOptions(null, ['x']), []);
});

test('F01: the dialog builds no <option> from a template any more', () => {
  const panel = source('ocp-v2-panel.js');
  assert.equal(/<option[^`]*\$\{/.test(panel), false, 'no interpolated <option>');
  assert.equal(/\.innerHTML\s*=\s*branches\.map/.test(panel), false);
  assert.equal(/Sel\.innerHTML\s*=/.test(panel), false, 'neither select is filled through innerHTML');
  assert.match(panel, /setSelectOptions\(projectSel, projectOptionRows\(_projects\), \{ placeholder: '\(none\)' \}\);/);
  assert.match(panel, /setSelectOptions\(branchSel, branches\);/);
});

// ── F06 ─────────────────────────────────────────────────────────────────────

test('F06: the row the session menu hands over has no model; the whole session is read before restoring', async () => {
  // What session:list really sends (the reviewer's point: tests used an idealised Session).
  const row = mapSessionListRow({
    id: 'ses_b', title: 'Second', directory: '/proj', slug: 'second', project_id: 'p',
    time_created: 1_790_000_000_000, time_updated: 1_790_000_100_000, message_count: 4,
  });
  assert.equal(hasSessionDetail(row), false);
  assert.deepEqual(sessionSelections(row), { model: null, variant: null, agent: null });

  const store = createPanelStore();
  store.setSession('ses_a', { id: 'ses_a' });
  store.setModel({ providerID: 'anthropic', modelID: 'claude-of-session-a' });
  store.setVariant('high');
  store.setSession('ses_b', row);

  const asked = [];
  const api = {
    sessionGet: async (id) => {
      asked.push(id);
      return { status: 200, data: {
        id: 'ses_b', title: 'Second', directory: '/proj', version: '1.18.34', agent: 'plan',
        model: { providerID: 'deepseek', id: 'v4-pro', variant: 'max' }, time: { created: 1, updated: 2 },
      } };
    },
  };
  const detail = await loadSessionDetail(api, 'ses_b', row);
  const full = detail.info;
  assert.equal(detail.fresh, true);
  assert.deepEqual(asked, ['ses_b']);
  assert.equal(full.messageCount, 4, 'the row is completed, not replaced');
  const events = [];
  store.subscribe((event) => events.push(event.type));
  const picked = applySessionSelections(store, full);
  assert.deepEqual(picked, { model: { providerID: 'deepseek', modelID: 'v4-pro' }, variant: 'max', agent: 'plan' });
  assert.deepEqual(store.getState().model, { providerID: 'deepseek', modelID: 'v4-pro' });
  assert.equal(store.getState().agent, 'plan');
  assert.equal(store.getState().mode, 'plan');
  // The variant picker restores the variant it remembers for a model on config:model.
  assert.ok(events.includes('config:model'));
  assert.equal(events.includes('config:variant'), false, 'the variant is the variant picker\'s to set');
  // "default" is what OpenCode records when a turn named no variant (seen live on 1.18.34).
  assert.equal(sessionSelections({ model: { providerID: 'fake', id: 'fake-model', variant: 'default' } }).variant, null);

  // A whole Session is read again all the same: a cached one can be out of
  // date (review 2, R03; tests/opencode-review2.test.mjs).
  assert.equal((await loadSessionDetail(api, 'ses_b', full)).fresh, true);
  assert.equal(asked.length, 2);
});

test('F06: a session without a model keeps the picker as it is; a failed read keeps the row', async () => {
  const store = createPanelStore();
  store.setSession('ses_new', { id: 'ses_new' });
  store.setModel({ providerID: 'openai', modelID: 'gpt' });
  store.setVariant('low');
  applySessionSelections(store, { id: 'ses_new', version: '1.18.34', title: 'empty' });
  assert.deepEqual(store.getState().model, { providerID: 'openai', modelID: 'gpt' });
  assert.equal(store.getState().variant, 'low');
  // The same model again is not a model change (the pickers do not re-run).
  const events = [];
  store.subscribe((event) => events.push(event.type));
  applySessionSelections(store, { id: 'ses_new', version: '1', model: { providerID: 'openai', id: 'gpt' }, agent: 'build' });
  assert.deepEqual(events, []);

  const row = { id: 'ses_c', title: 'C' };
  for (const api of [
    { sessionGet: async () => ({ status: 404, error: 'gone' }) },
    { sessionGet: async () => { throw new Error('websocket closed'); } },
    { sessionGet: async () => ({ status: 200, data: { id: 'ses_other', version: '1' } }) },
  ]) assert.deepEqual(await loadSessionDetail(api, 'ses_c', row), { info: row, fresh: false });
});

test('F06: the panel restores on switch and on boot, and skips a session it already left', () => {
  const panel = source('ocp-v2-panel.js');
  const switchFn = panel.slice(panel.indexOf('async function switchToSession('), panel.indexOf('async function restoreSessionSelections('));
  assert.match(switchFn, /const detailed = restoreSessionSelections\(sid, info\);/);
  assert.equal(switchFn.includes('sessionModelOf(info)'), false, 'no restore from the list row');
  const restore = panel.slice(panel.indexOf('async function restoreSessionSelections('), panel.indexOf('function beginRenameSession()'));
  // Review 3 (T07): comparing session ids let an answer for an earlier visit
  // to the same session through (A → B → A). The read and its guards are
  // loadSelectedSession now, which checks the binding the selection was made
  // under (behaviour: tests/opencode-review3-flows.test.mjs).
  assert.match(restore, /return loadSelectedSession\(getDefaultStore\(\), api, sid, info, \(full\) => \{/);
  assert.equal(restore.includes('getState().sessionId !== sid'), false);
  const actions = source('ocp-v2-session-actions.js');
  const selected = actions.slice(actions.indexOf('export async function loadSelectedSession('));
  assert.match(selected, /const at = captureBinding\(store, \{ sessionId \}\);\s+const detail = await loadSessionDetail\(api, sessionId, info\);\s+if \(!at\.isCurrent\(\)\) return null;/);
  assert.match(selected, /if \(!detail\.fresh\) return detail\.info;/, 'nothing is restored from a cached Session');
  assert.match(restore, /applySessionSelections\(getDefaultStore\(\), full\);/);
  const boot = panel.slice(panel.indexOf('async function boot()'), panel.indexOf('function otherWindowTabIds()'));
  assert.match(boot, /restoreSessionSelections\(targetSid, targetInfo\)/);
});

// ── F07 ─────────────────────────────────────────────────────────────────────

test('F07: an empty agent list (OpenCode not up yet) is not kept; the next load gets the real one', async () => {
  let up = false;
  const asked = [];
  const catalog = createAgentCatalog(async (cwd) => {
    asked.push(cwd);
    return up ? [
      { name: 'plan', mode: 'primary' }, { name: 'build', mode: 'primary' },
      { name: 'reviewer', mode: 'all', description: 'reviews' }, { name: 'explore', mode: 'subagent' },
    ] : [];
  });
  assert.deepEqual(await catalog.load('/proj'), [], 'cold start: nothing yet');
  assert.equal(catalog.get('/proj'), null);
  up = true;
  const agents = await catalog.load('/proj');
  assert.deepEqual(agents.map((a) => a.name), ['build', 'plan', 'reviewer']);
  assert.equal(asked.length, 2, 'the empty answer was not cached');
  await catalog.load('/proj');
  assert.equal(asked.length, 2, 'a real answer is');
  await catalog.load('/proj', { force: true });
  assert.equal(asked.length, 3, 'a reconnect asks again');

  // A stored custom agent is validated only against a list that came from the server.
  assert.equal(resolveAgent('reviewer', agents), 'reviewer');
  assert.equal(resolveAgent('gone', agents), 'build');
});

test('F07: agents are kept per project directory, and a failed refresh keeps the last good list', async () => {
  let fail = false;
  const catalog = createAgentCatalog(async (cwd) => {
    if (fail) throw new Error('offline');
    return cwd === '/a' ? [{ name: 'build', mode: 'primary' }, { name: 'only-a', mode: 'primary' }] : [{ name: 'build', mode: 'primary' }];
  });
  assert.deepEqual((await catalog.load('/a')).map((a) => a.name), ['build', 'only-a']);
  assert.deepEqual((await catalog.load('/b')).map((a) => a.name), ['build']);
  assert.deepEqual(catalog.get('/a').map((a) => a.name), ['build', 'only-a']);
  fail = true;
  assert.deepEqual((await catalog.load('/a', { force: true })).map((a) => a.name), ['build', 'only-a']);
  // Two loads at once share one request.
  fail = false;
  let calls = 0;
  const shared = createAgentCatalog(async () => { calls += 1; return [{ name: 'build', mode: 'primary' }]; });
  await Promise.all([shared.load('/x'), shared.load('/x')]);
  assert.equal(calls, 1);
});

test('F07: the composer reloads agents on ready, on a capability change and on a project change', () => {
  const send = source('ocp-v2-send.js');
  assert.match(send, /const became = state\.serverStatus === 'ready' && _lastServerStatus !== 'ready';/);
  assert.match(send, /if \(became\) refreshAgents\(\{ force: true \}\);/);
  assert.match(send, /capabilities\.subscribe\(\(\) => \{\s+syncModeToggle\(\);[\s\S]{0,120}refreshAgents\(\{ force: true \}\);/);
  assert.match(send, /if \(cwd !== _composerCwd\) \{\s+_composerCwd = cwd;\s+loadSlashCatalog\(cwd\);[\s\S]{0,400}refreshAgents\(\);/);
  // Never validated against the built-in fallback, nor against another
  // directory's list (review 2, N02): createAgentChoice decides.
  assert.match(send, /const next = _agentChoice\.settle\(current, composerCwd\(\)\);/);
  assert.equal(createAgentChoice().settle('reviewer', '/proj'), null, 'the built-in fallback validates nothing');
  assert.match(send, /api\.agentList\(\{ cwd: cwd \|\| undefined \}\)/);
});

// ── F08 ─────────────────────────────────────────────────────────────────────

function turnStore() {
  const store = createPanelStore();
  store.setSession('ses_1', { id: 'ses_1' });
  store.upsertMessage({ id: 'msg_u', role: 'user' });
  store.upsertPart({ id: 'p1', messageID: 'msg_u', type: 'text', text: 'what is in this screenshot?' });
  store.upsertPart({ id: 'p2', messageID: 'msg_u', type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' });
  store.upsertPart({ id: 'p3', messageID: 'msg_u', type: 'text', synthetic: true, text: 'Called the Read tool with…' });
  store.upsertPart({
    id: 'p4', messageID: 'msg_u', type: 'file', mime: 'text/plain', filename: 'a b.js', url: 'file:///proj/src/a%20b.js',
    source: { type: 'file', path: '/proj/src/a b.js', text: { value: '@src/a b.js', start: 0, end: 11 } },
  });
  store.upsertMessage({ id: 'msg_a', role: 'assistant', parentID: 'msg_u', time: { completed: 2 } });
  store.upsertPart({ id: 'p5', messageID: 'msg_a', type: 'text', text: 'A cat.' });
  return store;
}

test('F08: Retry sends the original text and file parts, not the current draft', async () => {
  const store = turnStore();
  // Something else is being drafted meanwhile.
  store.addAttachedImage({ name: 'draft.png', mime: 'image/png', dataUrl: 'data:image/png;base64,DRAFT' });
  const order = [];
  const api = { sessionRevert: async (p) => { order.push(['revert', p.messageID]); return { status: 200, data: { id: 'ses_1', revert: { messageID: 'msg_u' } } }; } };
  let sentWith = null;
  const result = await retryFromMessage(store, api, 'msg_a', async (text, extra) => { order.push(['send', text]); sentWith = extra; return true; });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(order, [['revert', 'msg_u'], ['send', 'what is in this screenshot?']]);
  assert.deepEqual(sentWith.files, [
    { type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' },
    { type: 'file', mime: 'text/plain', filename: 'a b.js', url: 'file:///proj/src/a%20b.js',
      source: { type: 'file', path: '/proj/src/a b.js', text: { value: '@src/a b.js', start: 0, end: 11 } } },
  ]);
  assert.equal(store.getState().attachedImages.length, 1, 'the draft is untouched');
  assert.equal(store.getState().attachedImages[0].name, 'draft.png');
});

test('F08: an attachment-only prompt is retried; a prompt with nothing to resend is refused before the session changes', async () => {
  const onlyFile = createPanelStore();
  onlyFile.setSession('ses_1', { id: 'ses_1' });
  onlyFile.upsertMessage({ id: 'msg_u', role: 'user' });
  onlyFile.upsertPart({ id: 'p1', messageID: 'msg_u', type: 'file', mime: 'application/pdf', filename: 'spec.pdf', url: 'data:application/pdf;base64,PDF' });
  onlyFile.upsertMessage({ id: 'msg_a', role: 'assistant', parentID: 'msg_u' });
  assert.deepEqual(replayablePrompt(onlyFile.getState().messages.get('msg_u')), {
    text: '', files: [{ type: 'file', mime: 'application/pdf', filename: 'spec.pdf', url: 'data:application/pdf;base64,PDF' }], resources: [], replayable: true,
  });
  let sent = null;
  const okApi = { sessionRevert: async () => ({ status: 200, data: { id: 'ses_1' } }) };
  assert.deepEqual(await retryFromMessage(onlyFile, okApi, 'msg_a', async (text, extra) => { sent = [text, extra.files.length]; return true; }), { ok: true });
  assert.deepEqual(sent, ['', 1]);

  // Nothing but text OpenCode added itself: retrying would revert and then fail.
  const hollow = createPanelStore();
  hollow.setSession('ses_1', { id: 'ses_1' });
  hollow.upsertMessage({ id: 'msg_u', role: 'user' });
  hollow.upsertPart({ id: 'p1', messageID: 'msg_u', type: 'text', synthetic: true, text: 'The following tool was executed by the user' });
  hollow.upsertMessage({ id: 'msg_a', role: 'assistant', parentID: 'msg_u' });
  let reverted = false;
  const result = await retryFromMessage(hollow, { sessionRevert: async () => { reverted = true; return { status: 200, data: {} }; } }, 'msg_a', async () => true);
  assert.equal(result.ok, false);
  assert.equal(reverted, false, 'validated before the revert');

  // A send that fails after the revert hands the prompt back, files included.
  const failed = await retryFromMessage(turnStore(), okApi, 'msg_a', async () => false);
  assert.equal(failed.ok, false);
  assert.equal(failed.files.length, 2);
});

test('F08: Undo (edit and resend) puts the attachments back in the composer too', async () => {
  const store = turnStore();
  const api = { sessionRevert: async () => ({ status: 200, data: { id: 'ses_1', revert: { messageID: 'msg_u' } } }) };
  const result = await revertToMessage(store, api, 'msg_u');
  assert.equal(result.text, 'what is in this screenshot?');
  assert.equal(result.files.length, 2);
  // The screenshot goes back to the strip. The file was a path chip (its
  // "@src/a b.js" is not a word in the text), so it is a path chip again.
  assert.deepEqual(restoreDraftAttachments(store, result), { restored: 2, lost: [] });
  assert.deepEqual(store.getState().attachedImages, [{ name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }]);
  assert.deepEqual(store.getState().pendingPaths, ['/proj/src/a b.js']);
  assert.equal(pathOfFileUrl('https://example.test/x'), '');
  // What cannot be put back as what it was is named, never turned into something else.
  assert.deepEqual(restoreDraftAttachments(store, { files: [{ url: 'https://example.test/x' }, null] }), { restored: 0, lost: ['https://example.test/x'] });
});

test('F08: the panel sends a retry with the prompt own parts and restores attachments on undo', () => {
  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /onSendText: \(text, extra\) => composer\?\.sendTextMessage\(text, \{\s+images: \[\], paths: \[\], mentions: extra\?\.files \|\| \[\], allowEmptyText: true,/);
  assert.match(panel, /onComposeText: \(text, extra\) => putPromptInComposer\(composer, text, extra\),/);
  assert.match(panel, /restoreDraftAttachments\(\s+getDefaultStore\(\),\s+\{ text, files, resources, resourceList: prompt\?\.resourceList \},\s+\{ addMentions: \(items\) => composer\.restoreMentions\(items\) \},/);
  const render = source('ocp-v2-render.js');
  assert.match(render, /retryFromMessage\(store, api, msg\.id, \(text, extra\) => opts\.onSendText\(text, extra\)\)/);
});

// ── F09 ─────────────────────────────────────────────────────────────────────

function bus() {
  const listeners = new Set();
  return {
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (type, ev) => { for (const fn of [...listeners]) fn(type, ev); },
    size: () => listeners.size,
  };
}
function fakeTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
    run: (ms) => timers.filter((t) => t.live && t.ms === ms).forEach((t) => { t.live = false; t.fn(); }),
    live: () => timers.filter((t) => t.live).map((t) => t.ms),
  };
}
const settled = async (promise) => Promise.race([promise.then((v) => v), new Promise((r) => setTimeout(() => r('pending'), 5))]);

test('F09: another worktree becoming ready first does not start this session', async () => {
  const events = bus();
  const timers = fakeTimers();
  const watch = watchWorktree(events.subscribe, { timeoutMs: 60_000, ...timers });
  // Another window's creation finishes while ours is still being created.
  events.emit('worktree.ready', { name: 'other-window', branch: 'opencode/other-window' });
  assert.equal(await settled(watch.result), 'pending', 'nothing is decided before the worktree is identified');
  watch.identify('calm-river');
  assert.equal(await settled(watch.result), 'pending', "someone else's ready is not ours");
  events.emit('worktree.ready', { name: 'other-two' });
  assert.equal(await settled(watch.result), 'pending');
  events.emit('worktree.ready', { name: 'calm-river', branch: 'opencode/calm-river' });
  assert.deepEqual(await watch.result, { ok: true });
  assert.equal(events.size(), 0, 'unsubscribed');
  assert.deepEqual(timers.live(), [], 'no timer left running');
});

test('F09: its own ready that beat the create reply is not lost', async () => {
  const events = bus();
  const watch = watchWorktree(events.subscribe, fakeTimers());
  events.emit('worktree.ready', { name: 'calm-river' });
  watch.identify('calm-river');
  assert.deepEqual(await watch.result, { ok: true });
});

test('F09: a failure never ends a creation; its own ready decides, the timeout is the last resort', async () => {
  // worktree.failed names no worktree, so it may be another creation's (review 2, R05).
  const events = bus();
  const timers = fakeTimers();
  const watch = watchWorktree(events.subscribe, { timeoutMs: 60_000, ...timers });
  events.emit('worktree.failed', { message: 'start command exited 1' });
  assert.equal(await settled(watch.result), 'pending', 'not attributed before the worktree is known');
  watch.identify('calm-river');
  assert.deepEqual(timers.live(), [60_000], 'no failure timer');
  events.emit('worktree.ready', { name: 'calm-river' });
  assert.deepEqual(await watch.result, { ok: true }, 'the failure was another creation');

  // No ready follows: reported at the timeout, with the failure quoted as unattributed.
  const events2 = bus();
  const timers2 = fakeTimers();
  const failing = watchWorktree(events2.subscribe, { timeoutMs: 60_000, ...timers2 });
  failing.identify('sad-lake');
  events2.emit('worktree.failed', { message: 'start command exited 1' });
  assert.equal(await settled(failing.result), 'pending');
  assert.deepEqual(timers2.live(), [60_000]);
  timers2.run(60_000);
  const outcome = await failing.result;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureSeen, 'start command exited 1');
  assert.match(outcome.error, /may or may not be this one/);
  assert.equal(events2.size(), 0);
});

test('F09: timeout, cancel, a missing name, and the named wait', async () => {
  const timers = fakeTimers();
  const silent = watchWorktree(bus().subscribe, { timeoutMs: 1234, ...timers });
  silent.identify('x');
  timers.run(1234);
  assert.deepEqual(await silent.result, { ok: false, error: 'The worktree was not ready in time.' });

  const cancelled = watchWorktree(bus().subscribe, fakeTimers());
  cancelled.cancel();
  assert.equal((await cancelled.result).ok, false);

  const unnamed = watchWorktree(bus().subscribe, fakeTimers());
  unnamed.identify('');
  assert.deepEqual(await unnamed.result, { ok: false, error: 'OpenCode did not name the new worktree.' });

  const events = bus();
  const named = waitForWorktree(events.subscribe, 'calm-river', fakeTimers());
  events.emit('worktree.ready', { name: 'not-it' });
  events.emit('worktree.ready', {});
  assert.equal(await settled(named), 'pending');
  events.emit('worktree.ready', { name: 'calm-river' });
  assert.deepEqual(await named, { ok: true });

  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /const watch = watchWorktree\(onEvent, \{ timeoutMs: 60_000 \}\);/);
  assert.match(panel, /watch\.identify\(created\.data\.name\);\s+const state = await watch\.result;/);
  assert.equal(panel.includes("waitForWorktree(onEvent, ''"), false);
});

// ── F10 ─────────────────────────────────────────────────────────────────────

test('F10: a session in a new worktree never checks out the main project', () => {
  // Another branch picked together with the worktree box: no checkout.
  assert.deepEqual(newSessionPlan({ project: '/proj', branch: 'feature', currentBranch: 'main', wantsWorktree: true, cwd: '/proj' }),
    { worktree: true, checkout: null, projectChanged: false });
  // Without the worktree box the branch switch happens, as before.
  assert.deepEqual(newSessionPlan({ project: '/proj', branch: 'feature', currentBranch: 'main', wantsWorktree: false, cwd: '/other' }),
    { worktree: false, checkout: { path: '/proj', branch: 'feature' }, projectChanged: true });
  // Same branch, unknown current branch, or no project: nothing to switch.
  assert.equal(newSessionPlan({ project: '/proj', branch: 'main', currentBranch: 'main' }).checkout, null);
  assert.equal(newSessionPlan({ project: '/proj', branch: 'feature', currentBranch: '' }).checkout, null);
  assert.equal(newSessionPlan({ project: '', branch: 'feature', currentBranch: 'main', wantsWorktree: true }).worktree, false);
});

test('F10: a failed checkout is an error, and the dialog acts on the plan in the right order', () => {
  assert.deepEqual(checkoutOutcome(200, { ok: true, branch: 'feature' }), { ok: true });
  assert.deepEqual(checkoutOutcome(500, { error: "error: Your local changes would be overwritten" }),
    { ok: false, error: 'Could not switch branch: error: Your local changes would be overwritten' });
  assert.deepEqual(checkoutOutcome(400, null), { ok: false, error: 'Could not switch branch: HTTP 400' });
  assert.equal(checkoutOutcome(200, { error: 'Invalid branch name' }).ok, false);

  const panel = source('ocp-v2-panel.js');
  const commit = panel.slice(panel.indexOf('const commit = async (cancel) => {'), panel.indexOf("saveBtn.addEventListener('click'"));
  const worktree = commit.indexOf('if (plan.worktree) {');
  const checkout = commit.indexOf("fetch('/api/terminal/checkout'");
  assert.ok(worktree > 0 && checkout > worktree, 'the worktree path returns before any checkout');
  assert.match(commit, /if \(!outcome\.ok\) \{\s+pushError\(\{ message: outcome\.error \}\);\s+return;/, 'no session on the wrong base');
  assert.match(panel, /branchSel\.disabled = locked \|\| !branchesKnown;/, 'the branch picker is locked while the worktree box is on');
});

// ── F11 ─────────────────────────────────────────────────────────────────────

test('F11: a sub-agent composer loading its catalog leaves the parent project catalog alone', async () => {
  const supports = () => true;
  const loads = [];
  const cache = createSlashCatalogCache({
    load: async (cwd) => {
      loads.push(cwd);
      return buildSlashCatalog({
        serverCommands: cwd === '/proj' ? [{ name: 'deploy-proj', description: 'project command', source: 'command' }] : [{ name: 'review', source: 'command' }],
        supports,
      });
    },
    fallback: () => buildSlashCatalog({ supports }),
  });
  const parentCwd = '/proj';
  await cache.load(parentCwd);
  assert.deepEqual(resolveSlash('/deploy-proj now', cache.get(parentCwd)), { kind: 'command', command: 'deploy-proj', args: 'now' });

  // The child panel mounts with no cwd of its own and loads the default-directory catalog.
  await cache.load('');
  assert.equal(resolveSlash('/deploy-proj now', cache.get('')), null, 'not a command where the child runs');
  // Back in the parent, nothing was reloaded and the project command is still a command.
  assert.deepEqual(resolveSlash('/deploy-proj now', cache.get(parentCwd)), { kind: 'command', command: 'deploy-proj', args: 'now' });
  await cache.load(parentCwd);
  assert.deepEqual(loads, ['/proj', ''], 'each directory is loaded once');

  // Before a directory is loaded the built-ins are there; a failed load is not cached.
  assert.ok(cache.get('/never').some((c) => c.name === 'new'));
  let fail = true;
  const flaky = createSlashCatalogCache({
    load: async () => { if (fail) throw new Error('offline'); return [{ name: 'x', kind: 'command' }]; },
    fallback: () => [],
  });
  assert.deepEqual(await flaky.load('/p'), []);
  fail = false;
  assert.deepEqual((await flaky.load('/p')).map((c) => c.name), ['x']);

  // A capability change drops everything, including a load that was in flight.
  let release;
  const slow = createSlashCatalogCache({ load: () => new Promise((r) => { release = () => r([{ name: 'old' }]); }), fallback: () => [] });
  const pending = slow.load('/p');
  await new Promise((r) => setTimeout(r, 0));   // the load is under way
  slow.invalidate();
  release();
  await pending;
  assert.equal(slow.has('/p'), false, 'an answer for the old capabilities is not stored');
});

test('F11: the slash module has no single active catalog, and each composer reads its own directory', () => {
  const hints = source('ocp-v2-slash-hints.js');
  assert.equal(/\blet SLASH_COMMANDS\b/.test(hints), false);
  assert.equal(/\b_catalogCwd\b/.test(hints), false);
  assert.match(hints, /export function getSlashCatalog\(cwd = ''\) \{ return _catalogs\.get\(cwd\); \}/);
  assert.match(hints, /for \(const cmd of getSlashCatalog\(getCwd\(\)\)\) \{/);
  const send = source('ocp-v2-send.js');
  assert.equal(send.includes('getSlashCatalog()'), false, 'no catalog without a directory');
  assert.equal((send.match(/resolveSlash\(text, getSlashCatalog\(composerCwd\(\)\)\)/g) || []).length, 2);
  assert.match(send, /const composerCwd = \(\) => \{ const s = store\.getState\(\); return s\.cwd \|\| s\.sessionInfo\?\.directory \|\| ''; \};/);
  assert.match(send, /getCwd: composerCwd,/);
});

// ── F12 ─────────────────────────────────────────────────────────────────────

test('F12: a command turn carries attachments, attached paths and @ mentions', () => {
  const images = [{ name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }];
  const paths = ['/proj/docs/spec.md', '/proj/assets/'];
  const mentions = mentionFileParts('/review @src/app.js please', new Set(['src/app.js']), '/proj');
  assert.equal(mentions.length, 1);
  const parts = commandFileParts({ images, paths, mentions });
  assert.deepEqual(parts, [
    { type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' },
    { type: 'file', mime: 'text/plain', filename: 'spec.md', url: 'file:///proj/docs/spec.md' },
    { type: 'file', mime: 'application/x-directory', filename: 'assets', url: 'file:///proj/assets/' },
    // The mention keeps its source (review 2, N04); only the position is
    // dropped, because the command template rewrites the text.
    { type: 'file', mime: 'text/plain', filename: 'app.js', url: 'file:///proj/src/app.js',
      source: { type: 'file', path: '/proj/src/app.js', text: { value: '@src/app.js', start: 0, end: 0 } } },
  ]);
  assert.equal(parts.slice(0, 3).some((p) => 'source' in p), false, 'an attachment or a path has no source to keep');
  // The same file attached and mentioned goes out once.
  assert.equal(commandFileParts({ paths: ['/proj/src/app.js'], mentions }).length, 1);
  assert.deepEqual(commandFileParts(), []);
  assert.deepEqual(imageFileParts([{ name: 'x' }, null]), [], 'an attachment without data is dropped');
});

test('F12: the composer sends them, clears the chips, and puts them back when the command fails', () => {
  const send = source('ocp-v2-send.js');
  const run = send.slice(send.indexOf('function runCommand(slash, attached, outcome) {'), send.indexOf('// Reached only from doSend() while the composer is in shell mode.'));
  assert.match(run, /const parts = commandFileParts\(attached\);/);
  const doSend = send.slice(send.indexOf('async function doSend() {'), send.indexOf('async function sendTextMessage(text, options = {}) {'));
  assert.match(doSend, /if \(paths\.length\) store\.clearPendingPaths\(\);/);
  // Review 4 (V02): the command runs through runCommandFor, which parks it with
  // everything it took when it fails after the panel moved; on its own binding
  // the chips come back, never refused for the strip's limit.
  assert.match(run, /const ran = await runCommand\(item\.command, item, outcome\);\s+const here = at\.isCurrent\(\);\s+if \(!ran && !here\) parkFailed\(at\.sessionId, item, outcome\.error\);/);
  assert.match(doSend, /const \{ ran, here \} = await runCommandFor\(\{\s+text, images, paths, mentions, command: \{ command: slash\.command, args: slash\.args \},\s+\}\);/);
  assert.match(doSend, /if \(!ran && here\) \{\s+for \(const img of images\) store\.addAttachedImage\(img, \{ restore: true \}\);\s+for \(const path of paths\) store\.addPendingPath\(path\);/);
  // sendTextMessage still never interprets text (the shell-mode rule of run 1).
  const sendText = send.slice(send.indexOf('async function sendTextMessage(text, options = {}) {'), send.indexOf('async function waitForAsyncTurn('));
  assert.equal(/resolveSlash|runShell|runCommand/.test(sendText), false);
});
