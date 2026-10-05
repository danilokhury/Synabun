// Final verification 6 of the OpenCode panel: N01 to N06. The three invariants
// of review 4 are still the frame:
//   A. Nothing the user typed, attached, picked or queued is ever lost.
//   B. A late continuation acts only on the binding, the turn and the intent it
//      started for, and is not dropped when it should have been retried.
//   C. What the audit table says is what the code does.
// This file holds the DOM-free parts. The glue runs under the DOM stand-in,
// started at the end of the file:
//   opencode-review6-glue.run.mjs   the real composer, plan lifecycle, env popover and notices
//   opencode-review6-panel.run.mjs  the real panel: Archive, rename, a session deleted elsewhere
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createParkedPrompts, samePrompts, keptPromptNotice, keptPromptDraft, mentionFileParts, mentionItemOfPart,
} from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';
import * as composerLogic from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';
import { createPendingRenames } from '../public/shared/ocp-v2/ocp-v2-sessions-logic.js';
import { createSignInFailures } from '../public/shared/ocp-v2/ocp-v2-status-logic.js';

const source = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');
const IMAGE = { name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' };

// ═══ N01: Archive asks about the prompts, not about how many there are ══════

test('N01: the prompts the user confirmed are compared by what they are, not by their number', () => {
  const p = { id: 'q1', text: 'P', images: [], paths: [], mentions: [] };
  const q = { id: 'q2', text: 'Q', images: [], paths: [], mentions: [] };
  assert.equal(samePrompts([p], [{ ...p, id: 'q9' }]), true, 'the same prompt under another queue id');
  assert.equal(samePrompts([p], [q]), false, 'one removed and another queued: the same count, another prompt');
  assert.equal(samePrompts([p, q], [q, p]), true, 'the order does not matter (a prompt that came back goes in front)');
  assert.equal(samePrompts([p, p], [p]), false, 'twice the same prompt is two prompts');
  assert.equal(samePrompts([], []), true);
  assert.equal(samePrompts([p], []), false);
  assert.equal(samePrompts(undefined, []), true);
  // The same text with another attachment, path, mention or command is another prompt.
  assert.equal(samePrompts([{ ...p, images: [IMAGE] }], [p]), false);
  assert.equal(samePrompts([{ ...p, images: [IMAGE] }], [{ ...p, images: [{ ...IMAGE }] }]), true);
  assert.equal(samePrompts([{ ...p, paths: ['/work/a'] }], [p]), false);
  assert.equal(samePrompts([{ ...p, mentions: [{ type: 'file', url: 'file:///x' }] }], [p]), false);
  assert.equal(samePrompts([{ ...p, command: { command: 'review', args: '' } }], [p]), false);

  const panel = source('ocp-v2-panel.js');
  const archive = panel.slice(panel.indexOf("archiveBtn.addEventListener('click'"), panel.indexOf('item.appendChild(archiveBtn);'));
  // (The question is the panel's own, in two steps; what was agreed to is
  // read when it has been answered: mayCloseTab answers for exactly those.)
  assert.match(archive, /if \(closesTab && !\(await mayCloseTab\(sid, question\(\)\)\)\) return;\s+\/\/[^\n]*\n\s+const confirmed = closesTab \? promptsWaitingFor\(sid\) : \[\];/);
  assert.ok(archive.indexOf('if (closesTab && !(await mayCloseTab(sid, question()))) return;') < archive.indexOf('api.sessionUpdate('), 'asked before the archive leaves');
  assert.match(archive, /const mayClose = closesTab && \(samePrompts\(promptsWaitingFor\(sid\), confirmed\) \|\| await mayCloseTab\(sid, question\(\)\)\);\s+if \(mayClose && _tabSessionIds\.includes\(sid\)\) await handlePillClose\(sid, \{ byUser: true \}\)/);
  assert.equal(/askedAbout/.test(panel), false, 'no count comparison left');
});

// ═══ N02: prompts whose session went away by itself are kept, whole ═════════

test('N02: the notice of a kept prompt says what it holds and promises nothing the code does not do', () => {
  assert.equal(
    keptPromptNotice({ item: { text: 'fix the login', images: [], paths: [], mentions: [] }, label: 'Fix the build' }),
    'Not sent: “fix the login” was waiting for “Fix the build”, and that session is gone. It is kept here until you put it back into the box or discard it; reloading the page drops it.',
  );
  assert.equal(
    keptPromptNotice({ item: { text: 'look at @README.md', images: [IMAGE], paths: ['/work/a/src'], mentions: [{ type: 'file' }] }, label: 'L' }),
    'Not sent: “look at @README.md” with 2 attachments and 1 mention was waiting for “L”, and that session is gone. It is kept here until you put it back into the box or discard it; reloading the page drops it.',
  );
  assert.match(keptPromptNotice({ item: { text: '', images: [IMAGE] } }), /^Not sent: \(attachments\) with 1 attachment was waiting for a session that is gone\. /);
  assert.match(keptPromptNotice({ item: { text: '/review the diff', command: { command: 'review', args: 'the diff' } }, label: 'L' }), /^Not sent: “\/review the diff” \(command\) was waiting for “L”/);
  assert.match(keptPromptNotice({ item: { text: 'x'.repeat(200) }, label: 'L' }), /^Not sent: “x{60}…” was waiting/);
  assert.equal(keptPromptNotice({}), '');
  // The promise review 6 found untrue is gone with the function that made it.
  assert.equal('droppedPromptsNotice' in composerLogic, false);
  for (const name of ['ocp-v2-composer-logic.js', 'ocp-v2-send.js', 'ocp-v2-panel.js']) {
    assert.equal(/still in the prompt history/.test(source(name)), false, `${name} no longer points at the prompt history`);
  }
});

test('N02: a kept prompt goes back into the draft whole: text under what is being written, attachments, paths, and its mentions as picked mentions', () => {
  // The file parts a queued prompt carries, as the composer made them.
  const picked = new Map([
    ['README.md', { kind: 'file', token: 'README.md', path: 'README.md' }],
    ['boot', { kind: 'symbol', token: 'boot', path: '/work/a/src/main.js', name: 'boot', symbolKind: 12, range: { start: { line: 4 }, end: { line: 9 } } }],
    ['linear:issue', { kind: 'resource', token: 'linear:issue', uri: 'linear://issue/1', client: 'linear', label: 'issue', mimeType: 'text/plain' }],
  ]);
  const text = 'read @README.md then @boot and @linear:issue please';
  const mentions = mentionFileParts(text, picked, '/work/a');
  assert.equal(mentions.length, 3, 'setup: three mention parts');
  const item = { text, images: [IMAGE], paths: ['/work/a/src'], mentions };

  const empty = keptPromptDraft(item, '');
  assert.equal(empty.text, text);
  assert.deepEqual(empty.images, [IMAGE]);
  assert.deepEqual(empty.paths, ['/work/a/src']);
  assert.deepEqual(empty.mentions.map((m) => m.token), ['README.md', 'boot', 'linear:issue']);
  assert.deepEqual(empty.lost, []);
  // Sent from the draft it was put back into, the prompt carries the very same parts.
  const again = mentionFileParts(empty.text, new Map(empty.mentions.map((m) => [m.token, m])), '/work/elsewhere');
  assert.deepEqual(again, mentions, 'a symbol\'s range and a resource\'s source survive the round trip');

  // A draft that is being written is kept: the prompt goes under it.
  const under = keptPromptDraft(item, 'half a thought');
  assert.equal(under.text, `half a thought\n\n${text}`);
  const moved = mentionFileParts(under.text, new Map(under.mentions.map((m) => [m.token, m])), '/work/a');
  assert.deepEqual(moved.map((part) => part.url), mentions.map((part) => part.url));
  assert.equal(moved[0].source.text.start, under.text.indexOf('@README.md'), 'the token is found where it stands now');
  // Attachments only.
  assert.deepEqual(keptPromptDraft({ text: '', images: [IMAGE], paths: [], mentions: [] }, 'draft'), { text: 'draft', images: [IMAGE], paths: [], mentions: [], lost: [] });
  // A mention part that does not say which token it was typed as cannot be a
  // picked mention again: it is named, never dropped without a word.
  const odd = { type: 'file', mime: 'text/plain', filename: 'odd.txt', url: 'file:///work/a/odd.txt' };
  assert.equal(mentionItemOfPart(odd), null);
  assert.deepEqual(keptPromptDraft({ text: 't', mentions: [odd] }, '').lost, ['odd.txt']);
});

test('N02: a banner entry may carry actions; the composer keeps a lost session\'s prompts on notices of its own', () => {
  const render = source('ocp-v2-render.js');
  const banner = render.slice(render.indexOf('function renderErrorBanner(err, store) {'), render.indexOf('// ── Helpers'));
  assert.match(banner, /for \(const action of actions\) \{/);
  assert.match(banner, /if \(err\.id && store\?\.dismissError && !actions\.length\) \{/, 'a notice that keeps something has no anonymous ×');
  const send = source('ocp-v2-send.js');
  assert.match(send, /function keepPrompts\(items, label\) \{/);
  assert.match(send, /\{ label: 'Put back', run: \(err\) => \{ if \(putBackKept\(kept\)\) store\.dismissError\(err\.id\); \} \},\s+\{ label: 'Discard', run: \(err\) => store\.dismissError\(err\.id\) \},/);
  const forget = send.slice(send.indexOf('forgetSession(sessionId, {'), send.indexOf('sendTextMessage,\n  };'));
  assert.match(forget, /if \(lost\) keepPrompts\(dropped, label \|\| sessionLabel\(sessionId\)\);/);
  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /_composer\?\.forgetSession\?\.\(sessionId, \{ lost: !byUser, label: tabLabelFor\(sessionId\) \}\);/);
});

// ═══ N03: a rename that is waiting for its answer ═══════════════════════════

test('N03: a pending rename is known until it is answered, and a refused one never comes back through a newer rename', () => {
  const renames = createPendingRenames();
  assert.equal(renames.isPending('ses_a'), false);
  const before = { state: 'auto', title: 'Generated' };
  const one = renames.begin('ses_a', 'First try', before);
  assert.equal(renames.isPending('ses_a'), true);
  assert.equal(renames.isPending('ses_b'), false);
  assert.deepEqual([one.sessionId, one.title, one.before], ['ses_a', 'First try', before]);
  // A second rename of the same session leaves while the first is still out:
  // what it found as the session's title state is the first one's attempt.
  const two = renames.begin('ses_a', 'Second try', { state: 'manual', title: 'First try' });
  // The first is refused: the second's way back is no longer the refused title.
  assert.equal(renames.end(one, false), true);
  assert.equal(renames.isPending('ses_a'), true, 'the second is still out');
  assert.deepEqual(two.before, before, 'a refusal of the second leads back to what the session had, not to the refused first');
  assert.equal(renames.end(two, false), true);
  assert.equal(renames.isPending('ses_a'), false);
  assert.equal(renames.end(two, false), false, 'answered once');

  // An accepted rename changes nobody's way back.
  const a = renames.begin('ses_a', 'Kept', before);
  const b = renames.begin('ses_a', 'Newer', { state: 'manual', title: 'Kept' });
  assert.equal(renames.end(a, true), true);
  assert.deepEqual(b.before, { state: 'manual', title: 'Kept' });
  // Only a later rename is re-pointed: an earlier one that started from the same title is not.
  const c = renames.begin('ses_c', 'T1', { state: 'manual', title: 'X' });
  const d = renames.begin('ses_c', 'X', { state: 'manual', title: 'T1' });
  renames.end(d, false);
  assert.deepEqual(c.before, { state: 'manual', title: 'X' });
  // The session's tab is gone: nothing is pending, and a late answer finds nothing to settle.
  renames.forget('ses_a');
  assert.equal(renames.isPending('ses_a'), false);
  assert.equal(renames.end(b, false), false);
  assert.equal(renames.begin('', 'x', null).sessionId, '');
  assert.equal(renames.isPending(''), false);
});

test('N03: while a rename is out the panel neither shows nor pushes its title, and a refusal puts the title state back', () => {
  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /function keepOwnSessionTitle\(s\) \{\s+(?:\/\/[^\n]*\n\s+)*if \(_pendingRenames\.isPending\(s\.sessionId\)\) return;/);
  assert.match(panel, /function _titleNeedsReassert\(sessionId\) \{\s+(?:\/\/[^\n]*\n\s+)*if \(_pendingRenames\.isPending\(sessionId\)\) return;/);
  // Both renames of the panel: pending before the title is marked, settled with the answer.
  assert.match(panel, /rename = _pendingRenames\.begin\(target\.sessionId, next, titleStateBefore\(target\.sessionId\)\);\s+markOpenCodeTitleManual\(target\.sessionId, next\);\s+cancelTitleReassert\(target\.sessionId\);\s+return renameSession\(getDefaultStore\(\), api, next, \{ binding: target \}\);/);
  assert.match(panel, /const rename = _pendingRenames\.begin\(sid, nextTitle, titleStateBefore\(sid\)\);\s+markOpenCodeTitleManual\(sid, nextTitle\);\s+cancelTitleReassert\(sid\);\s+const result = await renameSession\(getDefaultStore\(\), api, nextTitle, \{ binding: target \}\);\s+(?:\/\/[^\n]*\n\s+)*settleRename\(rename, result\.ok\);/);
  assert.equal((panel.match(/settleRename\(rename, result\.ok\);/g) || []).length, 2, 'the header box and the naming dialog');
  assert.match(panel, /function settleRename\(rename, ok\) \{\s+(?:\/\/[^\n]*\n\s+)*if \(!_pendingRenames\.end\(rename, ok\) \|\| ok\) return;\s+takeBackRenamedTitle\(rename\.sessionId, rename\.before, rename\.title\);/);
  const remove = panel.slice(panel.indexOf('function removeTab(sessionId, {'), panel.indexOf('function tabLabelFor(sessionId) {'));
  assert.match(remove, /_pendingRenames\.forget\(sessionId\);/, 'a closed tab leaves no pending marker behind');
});

// ═══ N04: a sign-in link lives as long as its attempt ═══════════════════════

test('N04: the link goes when its request has ended, and open popovers are told', () => {
  let clock = 1_000;
  let changes = 0;
  const failures = createSignInFailures({ now: () => clock, ttlMs: 60_000, onChange: () => { changes += 1; } });
  const rows = [{ name: 'linear', status: 'needs_auth' }];
  const attempt = failures.expect('ses_a', 'linear');
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth?state=a' }), 'ses_a');
  assert.deepEqual(failures.forSession('ses_a', rows), [{ mcpName: 'linear', url: 'https://linear.app/oauth?state=a' }]);
  assert.equal(changes, 0, 'recording is announced by its caller, as before');
  attempt.done();
  assert.deepEqual(failures.forSession('ses_a', rows), [], 'the request ended: its link is gone');
  assert.equal(changes, 1, 'a link that went repaints the popovers');
  assert.equal(failures.size(), 0);
  attempt.done();
  assert.equal(changes, 1, 'twice is harmless, and silent');
  // An attempt that never had a link ends without a repaint.
  failures.expect('ses_a', 'linear').done();
  assert.equal(changes, 1);
});

test('N04: a second session signing in to a same-named server makes the first one\'s link ambiguous: it is gone, for good', () => {
  let changes = 0;
  const failures = createSignInFailures({ onChange: () => { changes += 1; } });
  const rows = [{ name: 'linear', status: 'needs_auth' }];
  const a = failures.expect('ses_a', 'linear');
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth?state=a' }), 'ses_a');
  const b = failures.expect('ses_b', 'linear');
  assert.deepEqual(failures.forSession('ses_a', rows), [], 'nothing says the link is still the one to open');
  assert.deepEqual(failures.forSession('ses_b', rows), []);
  assert.equal(changes, 1, 'the popover that showed it is repainted');
  // It does not come back when the other attempt ends.
  b.done();
  assert.deepEqual(failures.forSession('ses_a', rows), []);
  assert.equal(changes, 1);
  // A's attempt is still open: a new failure, now unambiguous, is A's again.
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth?state=a2' }), 'ses_a');
  assert.deepEqual(failures.forSession('ses_a', rows), [{ mcpName: 'linear', url: 'https://linear.app/oauth?state=a2' }]);
  // Another server name is another matter.
  failures.expect('ses_b', 'github');
  assert.deepEqual(failures.forSession('ses_a', rows), [{ mcpName: 'linear', url: 'https://linear.app/oauth?state=a2' }]);
  // The same session asking again: the earlier page is no longer the one to open.
  failures.expect('ses_a', 'linear');
  assert.deepEqual(failures.forSession('ses_a', rows), []);
  assert.equal(changes, 2);
  a.done();
  // The session is gone: so are its attempts and links.
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth?state=a3' }), 'ses_a');
  failures.forget('ses_a');
  assert.deepEqual(failures.forSession('ses_a', rows), []);
  assert.equal(changes, 3);
  assert.equal(failures.open(), 1, 'only B\'s github attempt is left');
});

test('N04: a link expires with its attempt, by the clock and by a timer of its own', async () => {
  let clock = 1_000;
  let changes = 0;
  const failures = createSignInFailures({ now: () => clock, ttlMs: 40, onChange: () => { changes += 1; } });
  const rows = [{ name: 'linear', status: 'needs_auth' }];
  failures.expect('ses_a', 'linear');
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth' }), 'ses_a');
  clock += 41;
  assert.deepEqual(failures.forSession('ses_a', rows), [], 'an expired attempt offers nothing, whoever asks');
  // The request never ended and nobody called anything: the attempt's own timer retires it.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(changes, 1, 'the popover is repainted when the attempt expires');
  assert.equal(failures.open(), 0);

  const status = source('ocp-v2-status.js');
  assert.match(status, /const _signInFailures = createSignInFailures\(\{ onChange: \(\) => notifyAll\(\) \}\);/);
});

// ═══ N05: a failed final transcript read ════════════════════════════════════

test('N05: an error reply is not an empty transcript; the read is retried a bounded number of times and then the idle plan turn is ended', () => {
  const plan = source('ocp-v2-plan.js');
  assert.match(plan, /export const PLAN_READ_ATTEMPTS = 3;/);
  assert.match(plan, /if \(!replyFailed\(list\)\) return \{ items: Array\.isArray\(list\.data\) \? list\.data : \[\] \};/);
  assert.match(plan, /for \(let attempt = 1; attempt <= PLAN_READ_ATTEMPTS; attempt \+= 1\) \{/);
  assert.equal(/const items = Array\.isArray\(list\?\.data\) \? list\.data : \[\];/.test(plan), false, 'the reply is checked before it is read');
  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /could not read the plan/, 'the failure line starts no recovery that would clear it');
});

// ═══ N06: nothing is parked for a session that has no tab ═══════════════════

test('N06: a late failure for a session whose gone marker aged out is not parked for nobody', () => {
  const tabs = new Set(['ses_open']);
  const parked = createParkedPrompts({ hasTab: (sessionId) => tabs.has(sessionId) });
  const item = { text: 'sent long ago', images: [IMAGE], paths: [], mentions: [] };
  // 257 tabs are closed after ses_old: its marker is the oldest and falls out.
  parked.forget('ses_old');
  for (let i = 0; i < 257; i += 1) parked.forget(`ses_${i}`);
  assert.equal(parked.park('ses_old', { item, error: 'timeout' }), false, 'no tab: not parked');
  assert.equal(parked.size(), 0, 'nothing counts against the capacity');
  assert.equal(parked.goneAs('ses_old'), 'lost', 'nothing remembers how it went: its prompt is kept for the user, not dropped');
  assert.equal(parked.leave('ses_old', [item]), 0);
  // A session the user closed is still remembered as closed.
  assert.equal(parked.goneAs('ses_256'), 'closed');
  // A session with a tab is parked for, as always; so is any session when nobody says which have tabs.
  assert.equal(parked.park('ses_open', { item }), true);
  assert.equal(parked.goneAs('ses_open'), '');
  assert.equal(createParkedPrompts().park('ses_any', { item }), true);
  assert.equal(createParkedPrompts().goneAs('ses_any'), '');

  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /hasTab: \(sessionId\) => _tabSessionIds\.includes\(sessionId\),/);
  const send = source('ocp-v2-send.js');
  assert.match(send, /const _parked = createParkedPrompts\(\{ hasTab: opts\.hasTab \}\);/);
});

function runGlue(name) {
  const file = fileURLToPath(new URL(`./${name}`, import.meta.url));
  const env = { ...process.env, SYNABUN_TYPESAFE: 'off' };
  delete env.SYNABUN_ASSISTANT_SESSION;
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 120_000, env });
  const stdout = String(result.stdout || '');
  const output = `${stdout}\n${result.stderr || ''}`;
  assert.equal(result.status, 0, output.slice(-6000));
  assert.match(stdout, /no problems/, output.slice(-6000));
  return stdout;
}

test('N02, N04, N05, N06: the real composer, plan lifecycle, env popover and notices', () => {
  const stdout = runGlue('opencode-review6-glue.run.mjs');
  assert.ok((stdout.match(/^ok {3}/gm) || []).length >= 8, stdout.slice(-3000));
});

test('N01, N02, N03: the real panel', () => {
  const stdout = runGlue('opencode-review6-panel.run.mjs');
  assert.ok((stdout.match(/^ok {3}/gm) || []).length >= 5, stdout.slice(-3000));
});
