// Gaps the first run left partial, finished in run 2.
// O11 symbols and MCP resources in the @ picker   O30 references from a picker
// O21 adding an MCP server from the panel         (O29: tests/opencode-panel-approvals.test.mjs)
// The file-part shapes were checked against a live OpenCode 1.18.34 serve with
// `noReply`: a file is read, a symbol's line range is read, an MCP resource is
// read through its client, a reference directory is listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mentionGroups, mentionFileParts, mentionPart, relativeTo, createKeyedCache, commandFileParts,
  MENTION_GROUP_LIMIT, MENTION_GROUPS,
} from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';
import {
  mcpNameVerdict, parseMcpServerInput, splitCommandLine, addMcpServer, MANAGED_MCP_NAMES,
} from '../public/shared/ocp-v2/ocp-v2-status-logic.js';
import { runtimeMcpConfigFor } from '../lib/opencode-v2-ws-requests.js';

const source = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');

const SYMBOL = { name: 'runPipeline', kind: 12, path: '/proj/src/app.js', range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } };
const RESOURCE = { name: 'Run Book', uri: 'docs://runbook', client: 'docs', description: 'How to run', mimeType: 'text/markdown' };
const REFERENCE = { name: 'styleguide', path: '/refs/styleguide', description: 'House style rules' };

// ── O11 / O30: the picker ───────────────────────────────────────────────────

test('O11: the picker lists files, symbols, MCP resources and references in groups', () => {
  const groups = mentionGroups({
    query: 'ru', cwd: '/proj', files: ['src/run.js', 'src/run.js', 7],
    symbols: [SYMBOL, { name: 'nameless' }, { name: '', path: '/x' }],
    resources: [RESOURCE, { name: 'no client', uri: 'x://y' }, { name: 'Other', uri: 'docs://other', client: 'docs' }],
    references: [REFERENCE, { name: 'unrelated', path: '/refs/u' }],
  });
  assert.deepEqual(groups.map((g) => [g.id, g.label, g.items.length]), [
    ['file', 'Files', 1], ['symbol', 'Symbols', 1], ['resource', 'MCP resources', 1], ['reference', 'References', 1],
  ]);
  const [file, symbol, resource, reference] = groups.map((g) => g.items[0]);
  assert.deepEqual([file.token, file.label], ['src/run.js', 'src/run.js']);
  assert.deepEqual([symbol.token, symbol.label, symbol.detail], ['src/app.js#runPipeline', 'runPipeline', 'src/app.js:1']);
  assert.deepEqual([resource.token, resource.label, resource.detail], ['docs:Run-Book', 'Run Book', 'docs · docs://runbook']);
  assert.deepEqual([reference.token, reference.label, reference.detail], ['ref:styleguide', 'styleguide', 'House style rules']);
  for (const item of [file, symbol, resource, reference]) assert.equal(/\s/.test(item.token), false, 'a token is one word');
});

test('O11: resources and references are filtered by what is typed; empty groups are left out; a group is capped', () => {
  const all = mentionGroups({ query: '', resources: [RESOURCE], references: [REFERENCE] });
  assert.deepEqual(all.map((g) => g.id), ['resource', 'reference'], 'with nothing typed the whole lists show');
  assert.deepEqual(mentionGroups({ query: 'house', resources: [RESOURCE], references: [REFERENCE] }).map((g) => g.id), ['reference']);
  assert.deepEqual(mentionGroups({ query: 'RUNBOOK', resources: [RESOURCE], references: [REFERENCE] }).map((g) => g.id), ['resource']);
  assert.deepEqual(mentionGroups({ query: 'zzz', resources: [RESOURCE], references: [REFERENCE] }), []);
  const many = mentionGroups({ files: Array.from({ length: 40 }, (_, i) => `f${i}.js`) });
  assert.equal(many[0].items.length, MENTION_GROUP_LIMIT);
  assert.deepEqual(MENTION_GROUPS.map((g) => g.id), ['file', 'symbol', 'resource', 'reference']);
  assert.equal(relativeTo('/proj/', '/proj/src/a.js'), 'src/a.js');
  assert.equal(relativeTo('/proj', '/elsewhere/a.js'), '/elsewhere/a.js');
});

test('O11: each picked kind becomes the file part OpenCode reads', () => {
  const groups = mentionGroups({ cwd: '/proj', files: ['src/app.js'], symbols: [SYMBOL], resources: [RESOURCE], references: [REFERENCE] });
  const picked = new Map(groups.flatMap((g) => g.items).map((item) => [item.token, item]));
  const text = '@src/app.js @src/app.js#runPipeline @docs:Run-Book @ref:styleguide explain';
  const parts = mentionFileParts(text, picked, '/proj');
  assert.deepEqual(parts, [
    { type: 'file', mime: 'text/plain', filename: 'app.js', url: 'file:///proj/src/app.js',
      source: { type: 'file', path: '/proj/src/app.js', text: { value: '@src/app.js', start: 0, end: 11 } } },
    // A ranged file URL: OpenCode reads lines start..end (1-based).
    { type: 'file', mime: 'text/plain', filename: 'app.js', url: 'file:///proj/src/app.js?start=1&end=3',
      source: { type: 'symbol', path: '/proj/src/app.js', range: SYMBOL.range, name: 'runPipeline', kind: 12,
        text: { value: '@src/app.js#runPipeline', start: 12, end: 35 } } },
    // An MCP resource is read through the client that offers it.
    { type: 'file', mime: 'text/markdown', filename: 'Run Book', url: 'docs://runbook',
      source: { type: 'resource', clientName: 'docs', uri: 'docs://runbook', text: { value: '@docs:Run-Book', start: 36, end: 50 } } },
    // A reference is a path OpenCode keeps for the project.
    { type: 'file', mime: 'text/plain', filename: 'styleguide', url: 'file:///refs/styleguide',
      source: { type: 'file', path: '/refs/styleguide', text: { value: '@ref:styleguide', start: 51, end: 66 } } },
  ]);
  // "@src/app.js" inside "@src/app.js#runPipeline" is not the file mention.
  const onlySymbol = mentionFileParts('see @src/app.js#runPipeline', picked, '/proj');
  assert.deepEqual(onlySymbol.map((p) => p.source.type), ['symbol']);
  // A mention the user deleted from the text sends nothing; a typed @word neither.
  assert.deepEqual(mentionFileParts('nothing here @docs:other', picked, '/proj'), []);
  // The older Set of paths still works.
  assert.equal(mentionFileParts('@src/app.js', new Set(['src/app.js']), '/proj')[0].source.type, 'file');
  assert.equal(mentionPart({ kind: 'symbol', path: '/p/a.js', range: { start: { line: 9 }, end: { line: 4 } }, name: 'x' }, {}, '/p').url, 'file:///p/a.js?start=10&end=10');
  // In a slash-command turn the same picks keep their source (it is how
  // OpenCode reads a resource: review 2, N04) and lose only the text position.
  assert.deepEqual(commandFileParts({ mentions: parts }).map((p) => [p.url, p.source.type, p.source.text]), [
    ['file:///proj/src/app.js', 'file', { value: '@src/app.js', start: 0, end: 0 }],
    ['file:///proj/src/app.js?start=1&end=3', 'symbol', { value: '@src/app.js#runPipeline', start: 0, end: 0 }],
    ['docs://runbook', 'resource', { value: '@docs:Run-Book', start: 0, end: 0 }],
    ['file:///refs/styleguide', 'file', { value: '@ref:styleguide', start: 0, end: 0 }],
  ]);
});

test('O11: the resource and reference lists are read once per session and directory, then again after a while', async () => {
  let clock = 0;
  const loads = [];
  const cache = createKeyedCache(async (key) => { loads.push(key); return [`${key}#${loads.length}`]; }, { ttlMs: 30_000, now: () => clock });
  assert.deepEqual(await cache.get('ses_1|/p'), ['ses_1|/p#1']);
  assert.deepEqual(await cache.get('ses_1|/p'), ['ses_1|/p#1']);
  assert.deepEqual(await cache.get('ses_2|/p'), ['ses_2|/p#2']);
  clock = 31_000;
  assert.deepEqual(await cache.get('ses_1|/p'), ['ses_1|/p#3']);
  // A failed read is an empty list now and is asked again next time.
  let fail = true;
  const flaky = createKeyedCache(async () => { if (fail) throw new Error('offline'); return ['ok']; }, { now: () => clock });
  assert.deepEqual(await flaky.get('k'), []);
  fail = false;
  assert.deepEqual(await flaky.get('k'), ['ok']);
});

test('O11 / O30: the composer asks only for what the server answers and keeps picks as items', () => {
  const send = source('ocp-v2-send.js');
  assert.match(send, /const MENTION_SOURCES = \['find:files', 'find:symbols', 'resource:list', 'reference:list'\];/);
  assert.match(send, /supports\('find:symbols'\) && query\.trim\(\)\.length >= 2/);
  assert.match(send, /supports\('resource:list'\) \? _mcpResources\.get\(key\) : \[\],/);
  assert.match(send, /supports\('reference:list'\) \? _references\.get\(key\) : \[\],/);
  assert.match(send, /onPick: \(item\) => \{ _pickedMentions\.set\(item\.token, item\); \},/);
  const hints = source('ocp-v2-mention-hints.js');
  assert.match(hints, /applyMention\(inputEl\.value, token, entry\.token\)/);
  assert.equal(/innerHTML\s*=\s*[^'"]/.test(hints.replace(/browser\.innerHTML = '';/g, '')), false, 'labels and details are set as text');
  // O30: a reference can also be attached from the env popover.
  const status = source('ocp-v2-status.js');
  assert.match(status, /attach\.addEventListener\('click', \(\) => \{ close\(\); opts\.onAttachPath\(ref\.path\); \}\);/);
  assert.match(source('ocp-v2-panel.js'), /onAttachPath: \(path\) => appendPathToCompose\(path\),/);
});

// ── O21: adding an MCP server ───────────────────────────────────────────────

test('O21: the SynaBun entry cannot be added or replaced; names are plain tokens and unique', () => {
  for (const name of [...MANAGED_MCP_NAMES, 'synabun', ' SYNABUN ']) {
    const verdict = mcpNameVerdict(name, []);
    assert.equal(verdict.ok, false, name);
    assert.match(verdict.error, /managed by SynaBun/);
  }
  assert.equal(mcpNameVerdict('', []).ok, false);
  assert.equal(mcpNameVerdict('has space', []).ok, false);
  assert.equal(mcpNameVerdict('../etc', []).ok, false);
  assert.match(mcpNameVerdict('ctx7', [{ name: 'ctx7' }]).error, /already listed/);
  assert.deepEqual(mcpNameVerdict(' ctx7 ', [{ name: 'other' }]), { ok: true, name: 'ctx7' });
});

test('O21: a typed line is a remote URL or a command with its environment', () => {
  assert.deepEqual(parseMcpServerInput('https://mcp.example.test/sse'), { ok: true, config: { url: 'https://mcp.example.test/sse' } });
  assert.deepEqual(parseMcpServerInput('npx -y @upstash/context7-mcp'), { ok: true, config: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } });
  assert.deepEqual(parseMcpServerInput('API_KEY=abc DEBUG=1 node "/path with space/server.js" --port 3'),
    { ok: true, config: { command: 'node', args: ['/path with space/server.js', '--port', '3'], env: { API_KEY: 'abc', DEBUG: '1' } } });
  for (const bad of ['', '   ', 'ftp://x.test', 'javascript://x', 'node "unclosed', 'ONLY=env']) {
    assert.equal(parseMcpServerInput(bad).ok, false, bad);
  }
  assert.deepEqual(splitCommandLine(`a 'b c' "d \\" e" f\\ g ''`), ['a', 'b c', 'd " e', 'f g', '']);
  assert.equal(splitCommandLine('"open'), null);
  // What the form produces is what the server accepts.
  assert.deepEqual(runtimeMcpConfigFor(parseMcpServerInput('K=v npx -y x').config),
    { ok: true, config: { type: 'local', command: ['npx', '-y', 'x'], environment: { K: 'v' }, enabled: true } });
  assert.equal(runtimeMcpConfigFor(parseMcpServerInput('https://mcp.example.test/sse').config).config.type, 'remote');
});

test('O21: a server is registered on the session serve and saved by the same request, only when it starts', async () => {
  const calls = [];
  // What mcp:add answers: the rows, and `saved` when it wrote the config (review 2, N01).
  const register = (rows, extra = { saved: true }) => async (p) => { calls.push(['register', p.name, p.config, p.persist]); return { status: 200, data: rows, ...extra }; };
  const confirm = async () => true;

  const ok = await addMcpServer({
    name: 'docs', input: 'node /srv/docs.js', rows: [{ name: 'SynaBun' }], confirm,
    register: register([{ name: 'SynaBun', status: 'connected', managed: true }, { name: 'docs', status: 'connected' }]),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.saved, true);
  assert.equal(ok.rows.length, 2);
  assert.deepEqual(calls, [['register', 'docs', { command: 'node', args: ['/srv/docs.js'] }, true]], 'one request, nothing else');

  // It did not start (the live answer for a missing binary: HTTP 200, status failed).
  calls.length = 0;
  const failed = await addMcpServer({
    name: 'broken', input: 'not-a-binary', confirm,
    register: register([{ name: 'broken', status: 'failed', error: 'Executable not found in $PATH: "not-a-binary"' }], { saved: false }),
  });
  assert.deepEqual([failed.ok, failed.saved, failed.error], [false, false, 'Executable not found in $PATH: "not-a-binary"']);

  // Refused by the server, or by the name check: nothing is sent or saved.
  calls.length = 0;
  const refused = await addMcpServer({ name: 'x', input: 'https://x.test', register: async () => ({ ok: false, status: 403, error: 'no' }) });
  assert.deepEqual([refused.ok, refused.error, calls.length], [false, 'no', 0]);
  const managed = await addMcpServer({ name: 'SynaBun', input: 'node evil.js', confirm, register: register([]) });
  assert.equal(managed.ok, false);
  assert.equal(calls.length, 0, 'SynaBun is refused before anything is sent');
  const unparsed = await addMcpServer({ name: 'x', input: '', confirm, register: register([]) });
  assert.equal(unparsed.ok, false);
  assert.equal(calls.length, 0);

  // Needs sign-in is not a failure: it is saved, and the list offers "Sign in".
  // A remote server starts nothing here, so there is nothing to confirm.
  const auth = await addMcpServer({ name: 'remote', input: 'https://x.test/mcp', register: register([{ name: 'remote', status: 'needs_auth' }]) });
  assert.deepEqual([auth.ok, auth.saved], [true, true]);

  // Running but not saved: the user is told which half worked.
  const unsaved = await addMcpServer({
    name: 'docs2', input: 'node /srv/docs.js', confirm,
    register: register([{ name: 'docs2', status: 'connected' }], { saved: false, saveError: 'EACCES' }),
  });
  assert.deepEqual([unsaved.ok, unsaved.saved], [true, false]);
  assert.match(unsaved.note, /was not saved for later ones: EACCES/);
});

test('O21: the popover offers the form only with mcp:add and saves in the same request, not through the Settings route', () => {
  const status = source('ocp-v2-status.js');
  assert.match(status, /if \(!s\.sessionId \|\| !supports\('mcp:add'\)\) return;/);
  assert.equal(status.includes('/api/opencode/mcp'), false, 'that route registers on the shared serve too: a second start');
  assert.match(status, /canPersist: supports\('feature:mcp-add-persist'\),/);
  // The start of a command is asked in the popover, in two steps: never a
  // native dialog, which an automated browser accepts by itself.
  assert.match(status, /confirm: \(text\) => confirms\.ask\(\{ key: 'mcp-start', surface: 'env', text, confirmLabel: 'Start this command' \}\),/);
  assert.equal(/window\.confirm/.test(status), false);
  // (Review 4, V11: the form says which session a sign-in may be for before the request goes out.)
  assert.match(status, /register: \(\{ name: serverName, config, persist \}\) => \{\s+[^\n]*\n\s+const attempt = _signInFailures\.expect\(targetSessionId, serverName\);\s+return api\.mcpAdd\(/);
  assert.match(source('ocp-v2-ws.js'), /mcpAdd:\s+\(\{ sessionId, name, config, persist, cwd \} = \{\}\) => gated\(\{ type: 'mcp:add', sessionId, name, config, persist: persist === true, cwd \}, 60_000\),/);
});
