// The activity rack's vocabulary (asst-tool-kinds.js): which kind a call is,
// what the stage bubble says about it, when narration folds into the rack,
// how a call ended, a row's aggregate and the settled receipt sentence.
// Pure module, no DOM. The rack itself runs in assistant-render-events.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

const K = await import('../public/shared/assistant/asst-tool-kinds.js');
const { describeComputerAction } = await import('../public/shared/assistant/asst-computer.js');
const say = (name, input = {}, extra = {}, ctx = {}) => K.sayCall({ name, input, ...extra }, { describeComputer: describeComputerAction, ...ctx });
const calls = (n, extra = {}) => Array.from({ length: n }, () => ({ ...extra }));

test('kindOf: every tool of the table, any case, both prefixes', () => {
  const table = {
    shell: ['Bash', 'bash', 'BashOutput', 'KillShell', 'shell', 'exec_command', 'commandExecution', 'mcp__codex__exec_command'],
    read: ['Read', 'read', 'NotebookRead', 'view'],
    edit: ['Edit', 'edit', 'MultiEdit', 'Write', 'write', 'NotebookEdit', 'patch', 'apply_patch', 'fileChange'],
    search: ['Grep', 'grep', 'Glob', 'glob', 'LS', 'list', 'codesearch', 'ToolSearch'],
    web: ['WebFetch', 'webfetch', 'WebSearch', 'mcp__SynaBun__browser_navigate', 'SynaBun_browser_click', 'synabun_browser_snapshot', 'browser_screenshot'],
    subagent: ['Task', 'task', 'Agent', 'collabToolCall', 'TaskStop'],
    plan: ['TodoWrite', 'todowrite', 'TodoRead', 'update_plan'],
    memory: ['mcp__SynaBun__recall', 'SynaBun_remember', 'mcp__synabun__reflect', 'mcp__SynaBun__forget', 'SynaBun_restore', 'mcp__SynaBun__memories', 'mcp__SynaBun__sync', 'mcp__SynaBun__category', 'recall'],
    runs: ['mcp__SynaBun__agent_wait', 'SynaBun_agent_read', 'mcp__SynaBun__agent_dispatch', 'agent_status'],
    computer: ['mcp__SynaBun__computer', 'SynaBun_computer_apps', 'mcp__SynaBun__computer_ax', 'computer_status'],
    mcp: ['mcp__github__search_code', 'github_search_code', 'mcp__claude_ai_Claude_Docs__batch', 'ExitPlanMode', 'Skill'],
  };
  for (const [kind, names] of Object.entries(table)) {
    for (const name of names) assert.equal(K.kindOf(name, {}), kind, name);
  }
});

test('kindOf: SynaBun tools stay SynaBun; the same names on other servers are theirs', () => {
  assert.equal(K.kindOf('mcp__playwright__browser_navigate'), 'mcp', "another server's browser is not SynaBun's web row");
  assert.equal(K.kindOf('mcp__foo__sync'), 'mcp');
  assert.equal(K.kindOf('mcp__foo__agent_wait'), 'mcp');
  assert.equal(K.kindOf('mcp__foo__bash'), 'shell', 'a shell is a shell on any server');
  assert.equal(K.kindOf('playwright_browser_navigate'), 'mcp', 'OpenCode <server>_ prefix');
  assert.equal(K.kindOf('github_read'), 'read', 'OpenCode <server>_ prefix, a read');
  assert.equal(K.kindOf(''), 'mcp');
  assert.equal(K.kindOf(undefined), 'mcp');
});

test('rows: one per kind, one per server for mcp; labels and specs for every kind', () => {
  assert.equal(K.stationKey('shell', 'Bash'), 'shell');
  assert.equal(K.stationKey('mcp', 'mcp__github__search_code'), 'mcp:github');
  assert.equal(K.stationKey('mcp', 'github_create_issue'), 'mcp:github');
  assert.equal(K.mcpServerOf('mcp__claude_ai_Claude_Docs__batch'), 'claude_ai_Claude_Docs');
  assert.equal(K.prettyServer('claude_ai_Claude_Docs'), 'claude ai Claude Docs');
  assert.equal(K.mcpServerOf('ExitPlanMode'), 'ExitPlanMode');
  assert.deepEqual(Object.keys(K.KIND_SPECS).sort(), [...K.KIND_IDS].sort());
  for (const id of K.KIND_IDS) {
    const spec = K.KIND_SPECS[id];
    assert.match(spec.label[0], /^assistant\.rack\.kind\./, id);
    assert.ok(spec.glyph && K.VERBS[spec.verb], id);
  }
  assert.equal(K.toolWords('mcp__SynaBun__browser_navigate'), 'navigate');
  assert.equal(K.toolWords('mcp__github__search_code'), 'search code');
  assert.equal(K.toolWords('ExitPlanMode'), 'exit plan mode');
});

test('verbs are tense pairs', () => {
  const pairs = { run: ['Running', 'Ran'], read: ['Reading', 'Read'], edit: ['Editing', 'Edited'], search: ['Searching', 'Searched'], open: ['Opening', 'Opened'], delegate: ['Delegating', 'Delegated'], plan: ['Planning', 'Planned'], recall: ['Recalling', 'Recalled'], save: ['Saving', 'Saved'], click: ['Clicking', 'Clicked'], think: ['Thinking', 'Thought'] };
  for (const [id, [now, done]] of Object.entries(pairs)) {
    assert.equal(K.verbText(id, true), now);
    assert.equal(K.verbText(id, false), done);
  }
  const seen = [];
  const t = (key, fallback) => { seen.push(key); return fallback; };
  K.verbText('run', true, t);
  K.verbText('run', false, t);
  assert.deepEqual(seen, ['assistant.rack.verb.run.now', 'assistant.rack.verb.run.done']);
});

test('summarizeCommand: no leading cd, the home as ~, long tokens cut in the middle', () => {
  assert.equal(K.summarizeCommand('cd /Users/me/Apps/Synabun && npm test'), 'npm test');
  assert.equal(K.summarizeCommand("cd '/Users/me/My Apps' && ls -la"), 'ls -la');
  assert.equal(K.summarizeCommand('cd x; npm test'), 'cd x; npm test', 'only `cd <dir> &&` is dropped');
  assert.equal(K.summarizeCommand('ls /Users/me/Apps'), 'ls ~/Apps');
  assert.equal(K.summarizeCommand('cat /home/dev/.bashrc'), 'cat ~/.bashrc');
  assert.equal(K.summarizeCommand('ls $HOME/.synabun'), 'ls ~/.synabun');
  assert.equal(K.summarizeCommand('echo  a\n  b'), 'echo a b', 'whitespace collapsed');
  assert.equal(K.summarizeCommand('rg -n "createMascot" /Users/me/Apps/Synabun/neural-interface/public/shared'), 'rg -n "createMascot" ~/…/public/shared');
  assert.equal(K.summarizeCommand('node --test neural-interface/tests/assistant-render-events.browser.mjs'), 'node --test …/assistant-render-events.browser.mjs', 'a long file name reads best whole');
  const cut = K.summarizeCommand(`echo ${'x'.repeat(60)}`).split(' ')[1];
  assert.equal(cut.length, 28);
  assert.match(cut, /^x+…x+$/);
  for (const tok of K.summarizeCommand('curl https://example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p?q=1').split(' ')) assert.ok(tok.length <= 44, tok);
  assert.equal(K.commandOf({ command: ['bash', '-lc', 'npm test'] }), 'npm test', 'Codex argv');
  assert.equal(K.commandOf({ cmd: ['git', 'status'] }), 'git status');
  assert.equal(K.commandOf({ command: 'ls' }), 'ls');
  assert.equal(K.commandOf(null), '');
});

test('middleEllipsis: fits, else keeps ≥24 tail chars, cutting at token boundaries', () => {
  assert.equal(K.middleEllipsis('short', 40), 'short');
  const long = '$ node --test ~/Apps/Synabun/neural-interface/tests/assistant-render-events.browser.mjs --test-name-pattern webkit';
  const out = K.middleEllipsis(long, 60, 24);
  assert.ok(out.length <= 60, out);
  assert.equal(out.split('…').length, 2, 'one cut');
  assert.ok(out.split('…')[1].length >= 24, 'at least 24 tail chars');
  assert.ok(long.endsWith(out.split('…')[1]), 'the tail is the text\'s own end');
  assert.equal(out.split('…')[1], '--test-name-pattern webkit', 'the tail starts at a token');
  const path = K.middleEllipsis('~/Apps/Synabun/neural-interface/public/shared/assistant/asst-render.js', 40);
  assert.match(path, /\/assistant\/asst-render\.js$/, path);
  assert.ok(path.startsWith('~/Apps/'), path);
  assert.equal(K.middleEllipsis('a'.repeat(100), 30, 24).split('…')[1].length, 24);
});

test('shouldFoldNarration: short plain narration folds; code, lists, headings and long text do not', () => {
  for (const s of ['Let me check the logs.', 'Now `npm test`.', 'Found it.\nChecking the callers.', 'x'.repeat(240)]) assert.equal(K.shouldFoldNarration(s), true, JSON.stringify(s));
  for (const s of ['', '   ', 'x'.repeat(241), 'Para one.\n\nPara two.', '```js\nx()\n```', 'Here:\n    indented code', '- a\n- b', '* one', '1. first', '2) second', '# Heading', '### Plan', '> quoted', '| a | b |', '~~~\ncode\n~~~']) {
    assert.equal(K.shouldFoldNarration(s), false, JSON.stringify(s));
  }
});

test('callOutcome: exit codes win for shell; rg / grep / diff / test exit 1 with no output is neutral', () => {
  const sh = (command, text, isError) => K.callOutcome({ kind: 'shell', input: { command } }, text, isError);
  assert.deepEqual(sh('npm test', 'ok 12 passed', false), { state: 'ok', code: null });
  assert.deepEqual(sh('npm test', 'Exit code 1\nnpm ERR! missing script: test', true), { state: 'error', code: 1, detail: 'npm ERR! missing script: test' }, 'Claude');
  assert.deepEqual(sh('npm test', 'Error: Exit code 2\nfailed', true), { state: 'error', code: 2, detail: 'failed' });
  assert.deepEqual(sh('tail server.log', 'permission denied\n[exit 1]', true), { state: 'error', code: 1, detail: 'permission denied' }, 'Codex');
  assert.deepEqual(sh('ls nope', 'exit code: 2', false), { state: 'error', code: 2, detail: 'exit 2' }, 'OpenCode reports a failed exit as ok: the code decides');
  assert.deepEqual(sh('npm test', 'ok\n[exit 0]', true), { state: 'ok', code: 0 });
  assert.deepEqual(sh('npm test', 'Timed out', true), { state: 'error', code: null, detail: 'Timed out' }, 'no code: the status decides');
  for (const cmd of ['rg foo', 'grep -r x .', 'cd src && rg -c y', 'git grep z', 'diff a b', 'test -f x', '[ -d y ]', 'FOO=1 rg x']) {
    assert.equal(sh(cmd, 'Exit code 1', true).state, 'neutral', cmd);
    assert.equal(sh(cmd, '\n[exit 1]', true).state, 'neutral', `${cmd} (Codex)`);
  }
  assert.equal(sh('rg foo', 'Exit code 1\nrg: bad regex', true).state, 'error', 'stderr means a real failure');
  assert.equal(sh('rg foo', 'Exit code 2', true).state, 'error', 'exit 2 is an error');
  assert.equal(sh('npm test', 'Exit code 1', true).state, 'error');
  assert.deepEqual(K.callOutcome({ kind: 'read' }, 'Error: ENOENT\nstack', true), { state: 'error', code: null, detail: 'ENOENT' });
  assert.deepEqual(K.callOutcome({ kind: 'read' }, 'contents', false), { state: 'ok', code: null });
  assert.deepEqual(K.parseExit('out\n[exit 3]'), { code: 3, body: 'out' });
  assert.deepEqual(K.parseExit('plain'), { code: null, body: 'plain' });
});

test('what shell calls say: "$ " + the command, its description as the caption', () => {
  const b = say('Bash', { command: 'cd /Users/me/x && npm test -- --grep rack', description: 'Run the rack tests', run_in_background: true });
  assert.deepEqual([b.verb, b.text, b.mono, b.caption, b.tag, b.copy], ['run', '$ npm test -- --grep rack', true, 'Run the rack tests', 'background', 'cd /Users/me/x && npm test -- --grep rack']);
  assert.deepEqual([say('BashOutput', { bash_id: '2' }).verb, say('BashOutput', { bash_id: '2' }).text], ['check', 'output of shell 2']);
  assert.equal(`${K.verbText('check', true)} ${say('BashOutput', { bash_id: '2' }).text}`, 'Checking output of shell 2');
  assert.equal(`${K.verbText(say('KillShell', { shell_id: 'x' }).verb, true)} ${say('KillShell', {}).text}`, 'Stopping a background command');
  assert.equal(say('exec_command', { cmd: ['bash', '-lc', 'git status'] }).text, '$ git status');
});

test('what reads, edits and searches say', () => {
  const r = say('Read', { file_path: '/Users/me/Apps/Synabun/neural-interface/public/shared/assistant/asst-render.js', offset: 120, limit: 60 });
  assert.equal(r.text, 'shared/assistant/asst-render.js:120-180');
  assert.deepEqual(r.segments, [{ text: 'shared/assistant/', cls: 'dim' }, { text: 'asst-render.js', cls: 'strong' }, { text: ':120-180', cls: 'dim' }], 'the basename bold, its last two folders dim');
  assert.equal(say('read', { filePath: '/a/b.js' }).text, 'a/b.js', 'OpenCode camelCase');
  assert.equal(say('Read', { file_path: 'x.js', offset: 40 }).text, 'x.js:40');
  const e = say('Edit', { file_path: '/p/a.js', old_string: 'a\nb', new_string: 'a\nb\nc' });
  assert.deepEqual([e.verb, e.text, e.meta], ['edit', 'a.js', ['+3 −2']]);
  assert.deepEqual(say('MultiEdit', { file_path: '/p/a.js', edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'x\ny', new_string: 'z' }] }).meta, ['+3 −3'], 'MultiEdit sums its edits');
  assert.deepEqual(say('Write', { file_path: '/p/new.js', content: Array.from({ length: 84 }, (_, i) => `l${i}`).join('\n') }).meta, ['new file, 84 lines']);
  assert.deepEqual(say('edit', { filePath: '/p/a.js', oldString: 'a', newString: 'b' }).meta, ['+1 −1'], 'OpenCode camelCase');
  const codex = say('Edit', { changes: [{ path: '/p/src/a.js', kind: 'update' }, { path: '/p/src/b.js', kind: 'add' }] });
  assert.deepEqual([codex.text, codex.meta], ['a.js +1', []], 'Codex fileChange: the path only');
  const patch = say('apply_patch', { input: '*** Begin Patch\n*** Update File: src/x.js\n@@\n-old\n+new\n+more\n*** End Patch' });
  assert.deepEqual([patch.text, patch.meta], ['x.js', ['+2 −1']]);
  assert.deepEqual(K.editDiff('Edit', { old_string: 'a', new_string: 'b' }), [{ sign: '-', text: 'a' }, { sign: '+', text: 'b' }], 'the mini diff');
  const g = say('Grep', { pattern: 'TODO', path: '/p/src', glob: '*.js', '-i': true }, { result: 'src/a.js:3\nsrc/b.js:9', state: 'ok' });
  assert.deepEqual([g.text, g.meta], ['"TODO" in src/ *.js -i', ['12 matches in 2 files']]);
  assert.deepEqual(say('Grep', { pattern: 'x' }, { result: 'Found 4 files\na\nb\nc\nd' }).meta, ['4 files']);
  assert.deepEqual(say('Grep', { pattern: 'x' }, { result: 'No files found' }).meta, ['no matches']);
  assert.deepEqual(say('Grep', { pattern: 'x' }, { result: 'a.js:1:foo\na.js:4:bar\nb.js:2:baz' }).meta, ['3 matches in 2 files']);
  assert.equal(say('Glob', { pattern: 'tests/*.mjs' }).text, 'tests/*.mjs');
  assert.deepEqual([say('LS', { path: '/p/src' }).verb, say('LS', { path: '/p/src' }).text], ['browse', '/p/src']);
});

test('what web, subagent, plan, memory, runs, computer, thinking and other calls say', () => {
  const nav = say('mcp__SynaBun__browser_navigate', { url: 'https://example.com/docs/intro?utm=x#top' });
  assert.deepEqual([nav.verb, nav.text], ['open', 'example.com/docs/intro'], 'host + path, no query');
  assert.deepEqual([say('WebSearch', { query: 'css anchor' }).verb, say('WebSearch', { query: 'css anchor' }).text], ['search', '"css anchor"']);
  assert.equal(`${K.verbText(say('SynaBun_browser_click', { element: 'Sign in' }).verb, false)} ${say('SynaBun_browser_click', { element: 'Sign in' }).text}`, 'Clicked Sign in');
  assert.equal(say('mcp__SynaBun__browser_fill', { selector: '#email', value: 'secret@x.com' }).text, '#email', 'never the typed value');
  assert.equal(say('mcp__SynaBun__browser_type', { ref: 'e12', text: 'hunter2' }).text, 'e12');
  assert.equal(`${K.verbText(say('mcp__SynaBun__browser_snapshot').verb, true)} ${say('mcp__SynaBun__browser_snapshot').text}`, 'Reading the page');
  assert.equal(`${K.verbText(say('mcp__SynaBun__browser_screenshot').verb, true)} ${say('mcp__SynaBun__browser_screenshot').text}`, 'Taking a screenshot');
  assert.equal(say('Task', { subagent_type: 'Explore', description: 'Research the mascot' }).text, 'Explore: Research the mascot');
  assert.equal(say('Task', { description: 'x'.repeat(80) }).text.length, 60, 'the description is cut at 60');
  assert.equal(say('Task', { tool: 'spawn', prompt: 'Draft the notes\nwith detail' }).text, 'spawn: Draft the notes', 'Codex collab call');
  const plan = say('TodoWrite', { todos: [{ content: 'A', status: 'completed', activeForm: 'Doing A' }, { content: 'B', status: 'completed', activeForm: 'Doing B' }, { content: 'C', status: 'completed', activeForm: 'Doing C' }, { content: 'D', status: 'in_progress', activeForm: 'Wiring the rack' }, { content: 'E', status: 'pending', activeForm: 'e' }, { content: 'F', status: 'pending', activeForm: 'f' }, { content: 'G', status: 'pending', activeForm: 'g' }] });
  assert.deepEqual([plan.verb, plan.text, plan.meta], ['plan', 'Wiring the rack', ['3 of 7']]);
  assert.deepEqual(say('update_plan', { plan: [{ step: 'Kinds', status: 'completed' }, { step: 'Rack', status: 'in_progress' }] }).meta, ['1 of 2']);
  const recall = say('mcp__SynaBun__recall', { query: 'panel polish' }, { result: 'Found 5 memories', state: 'ok' });
  assert.deepEqual([recall.verb, recall.text, recall.meta], ['recall', '"panel polish"', ['5 found']]);
  const remember = say('mcp__SynaBun__remember', { content: '## Rack architecture\nbody', category: 'neural-interface' });
  assert.deepEqual([remember.verb, remember.text, remember.meta], ['save', 'Rack architecture', ['neural-interface']]);
  assert.equal(`${K.verbText(say('mcp__SynaBun__reflect', { memory_id: '1a2b3c4d-9999' }).verb, true)} ${say('mcp__SynaBun__reflect', { memory_id: '1a2b3c4d-9999' }).text}`, 'Updating 1a2b3c4d');
  assert.equal(`${K.verbText(say('mcp__SynaBun__forget', { memory_id: '1a2b3c4d-9999' }).verb, true)} ${say('mcp__SynaBun__forget', { memory_id: '1a2b3c4d-9999' }).text}`, 'Trashing 1a2b3c4d');
  assert.deepEqual(say('mcp__SynaBun__recall', {}, { auto: true, memories: [{}, {}], state: 'ok' }).meta, ['2 found'], 'the prompt-time recall');
  const runCtx = { runLabel: () => 'Polish the side panel', runState: () => 'running' };
  const wait = say('mcp__SynaBun__agent_wait', { run_id: 'r1' }, {}, runCtx);
  assert.equal(`${K.verbText(wait.verb, true)} ${wait.text}`, 'Waiting on Polish the side panel');
  assert.deepEqual(wait.meta, ['running']);
  assert.equal(`${K.verbText(say('mcp__SynaBun__agent_read', { run_id: 'r1' }, {}, runCtx).verb, true)} ${say('mcp__SynaBun__agent_read', {}, {}, runCtx).text}`, 'Checking on Polish the side panel');
  assert.equal(`${K.verbText(say('mcp__SynaBun__agent_dispatch', {}).verb, true)} ${say('mcp__SynaBun__agent_dispatch', {}).text}`, 'Dispatching an agent');
  assert.equal(`${K.verbText(say('mcp__SynaBun__agent_route', {}).verb, true)} ${say('mcp__SynaBun__agent_route', {}).text}`, 'Picking a model');
  const comp = say('mcp__SynaBun__computer', { action: 'left_click', coordinate: [640, 412] }, { app: 'TextEdit' });
  assert.deepEqual([comp.text, comp.detail, comp.meta], ['TextEdit', 'Click (640, 412)', ['Click (640, 412)']], 'the app, and the action');
  assert.equal(say('mcp__SynaBun__computer', { action: 'screenshot' }).text, 'the computer');
  const think = K.sayCall({ name: 'thinking', kind: 'think', text: `${'a'.repeat(100)} the end` }, {});
  assert.equal(think.text.length, 80);
  assert.ok(think.text.startsWith('…') && think.text.endsWith('the end'), 'the last 80 chars');
  assert.equal(K.sayCall({ name: 'thinking', kind: 'think', text: '' }, {}).text, '…', 'dots when redacted');
  const other = say('mcp__github__search_code', { q: 'mascot', per_page: 5 });
  assert.deepEqual([other.verb, other.text], ['use', 'search code “mascot”']);
  assert.equal(say('mcp__x__y', { a: 'z'.repeat(90) }).text.length, 'y “”'.length + 60, 'the first string argument, cut at 60');
});

test('parallel calls share one subject; a re-read counts', () => {
  const read = (p) => ({ name: 'Read', input: { file_path: p } });
  assert.equal(K.groupSubject('read', [read('/a/a.js'), read('/a/b.js'), read('/a/c.js')]), 'a.js, b.js +1');
  assert.equal(K.groupSubject('read', [read('/a/a.js'), read('/a/b.js')]), 'a.js, b.js');
  assert.equal(K.groupSubject('read', [read('/a/server.js')], [read('/a/server.js'), read('/a/server.js')]), 'server.js ×2');
  assert.equal(K.groupSubject('read', [read('/a/server.js')], [read('/a/server.js')]), '', 'one call: its own subject');
  assert.equal(K.groupSubject('shell', [{ input: { command: 'ls' } }, { input: { command: 'cd /x && npm test' } }]), '$ npm test +1');
  assert.equal(K.groupSubject('search', [{ input: { pattern: 'a' } }, { input: { pattern: 'b' } }]), '"a", "b"');
});

test('rows: the aggregate names the count and the failures', () => {
  assert.equal(K.stationAggregate('shell', [...calls(3, { state: 'ok' }), { state: 'error' }]), '4 commands, 1 failed');
  assert.equal(K.stationAggregate('shell', [{ state: 'neutral' }]), '1 command', 'no matches is not a failure');
  assert.equal(K.stationAggregate('read', [{ input: { file_path: 'a' } }, { input: { file_path: 'a' } }, { input: { file_path: 'b' } }]), '2 files', 'files, not calls');
  assert.equal(K.stationAggregate('plan', [{ name: 'TodoWrite', input: { todos: [{ status: 'completed' }, { status: 'pending' }, { status: 'in_progress' }] } }]), '1 of 3 done');
  assert.equal(K.stationAggregate('think', calls(2)), '2 thoughts');
  assert.equal(K.stationAggregate('mcp', calls(1)), '1 call');
});

test('receipts: plain sentences, plural forms, the first phrase capitalised', () => {
  const r = (kind, list, ctx = {}) => K.receiptPhrases(kind, list, ctx);
  assert.deepEqual([r('shell', calls(1)), r('shell', calls(4))], [['ran 1 command'], ['ran 4 commands']]);
  assert.deepEqual(r('read', [{ input: { file_path: 'a' } }, { input: { file_path: 'b' } }, { input: { file_path: 'c' } }]), ['read 3 files']);
  assert.deepEqual(r('edit', [{ name: 'Edit', input: { file_path: 'a', old_string: 'x', new_string: 'y\nz' } }, { name: 'Edit', input: { file_path: 'b', old_string: 'q', new_string: 'r' } }]), ['edited 2 files (+3 −2)']);
  assert.deepEqual(r('edit', [{ name: 'Edit', input: { changes: [{ path: 'a' }] } }]), ['edited 1 file'], 'no line counts known');
  assert.deepEqual([r('search', calls(1)), r('search', calls(2))], [['searched 1 pattern'], ['searched 2 patterns']]);
  assert.deepEqual(r('web', [{ name: 'WebFetch', input: {} }, { name: 'mcp__SynaBun__browser_navigate', input: {} }, { name: 'WebSearch', input: {} }, { name: 'mcp__SynaBun__browser_click', input: {} }]), ['visited 2 pages', 'searched the web once', 'used the browser once']);
  assert.deepEqual([r('subagent', calls(1)), r('subagent', calls(3))], [['ran 1 agent'], ['ran 3 agents']]);
  assert.deepEqual(r('plan', [{ name: 'TodoWrite', input: { todos: [{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }, ...calls(4, { status: 'pending' })] } }]), ['finished 3 of 7 plan steps'], 'a sentence, not "plan: 3 of 7 done"');
  assert.deepEqual(r('plan', [{ name: 'TodoWrite', input: { todos: [{ status: 'completed' }] } }]), ['finished 1 of 1 plan step']);
  assert.deepEqual(r('memory', [{ name: 'mcp__SynaBun__recall' }, { name: 'mcp__SynaBun__recall' }, { name: 'mcp__SynaBun__remember' }]), ['recalled 2 times', 'saved 1 memory']);
  assert.deepEqual(r('memory', [{ name: 'mcp__SynaBun__recall' }]), ['recalled once']);
  assert.deepEqual(r('runs', [{ name: 'mcp__SynaBun__agent_dispatch' }, { name: 'mcp__SynaBun__agent_wait' }, { name: 'mcp__SynaBun__agent_read' }]), ['dispatched 1 agent', 'checked 2 times']);
  assert.deepEqual(r('computer', [{ app: 'Safari' }, {}, {}]), ['used Safari for 3 actions']);
  assert.deepEqual(r('computer', [{}]), ['used the computer for 1 action']);
  assert.deepEqual(r('think', [{ startedAt: 1000, endedAt: 20000 }]), ['thought for 19 s']);
  assert.deepEqual(r('think', [{ startedAt: 0, endedAt: 0 }, { timed: false }]), ['thought 2 times'], 'duration unknown');
  assert.deepEqual(r('think', [{ startedAt: 5000, endedAt: 5040 }]), ['thought once'], 'under 0.1 s: never "thought for 0.0 s"');
  assert.deepEqual(r('think', [{ startedAt: 5000, endedAt: 5000 }, { startedAt: 5000, endedAt: 5000 }]), ['thought 2 times'], 'two journal lines with one timestamp');
  assert.deepEqual(r('mcp', calls(3), { server: 'claude_ai_Claude_Docs' }), ['used claude ai Claude Docs 3 times']);
  assert.deepEqual(r('mcp', calls(1), { server: 'github' }), ['used github once']);
  const sentence = K.receiptSentence([
    { kind: 'shell', calls: calls(4) },
    { kind: 'read', calls: [{ input: { file_path: 'a' } }, { input: { file_path: 'b' } }, { input: { file_path: 'c' } }] },
    { kind: 'search', calls: calls(2) },
  ]);
  assert.equal(sentence, 'Ran 4 commands, read 3 files, searched 2 patterns', 'Intl.ListFormat conjunction, narrow; first phrase capitalised');
  assert.equal(K.receiptSentence([{ kind: 'read', calls: [{ input: { file_path: 'a' } }] }]), 'Read 1 file');
  assert.equal(K.receiptSentence([]), '');
  // Localized through the caller's t(key, fallback, params); plurals resolve key.one / key.other.
  const seen = [];
  const t = (key, fallback, params) => { seen.push(key); return K.fill(fallback, params); };
  K.receiptPhrases('shell', calls(2), { t });
  K.receiptPhrases('shell', calls(1), { t });
  assert.deepEqual(seen, ['assistant.rack.receipt.shell.other', 'assistant.rack.receipt.shell.one']);
});

test('fmtDuration: tabular seconds, then minutes and hours', () => {
  assert.equal(K.fmtDuration(400), '0.4 s');
  assert.equal(K.fmtDuration(100), '0.1 s', 'from 0.1 s');
  assert.equal(K.fmtDuration(99), '', 'under 0.1 s says nothing');
  assert.equal(K.fmtDuration(0), '', 'identical timestamps say nothing');
  assert.equal(K.MIN_SHOWN_MS, 100);
  assert.equal(K.fmtDuration(19_000), '19 s');
  assert.equal(K.fmtDuration(59_400), '59 s');
  assert.equal(K.fmtDuration(120_000), '2 min');
  assert.equal(K.fmtDuration(125_000), '2 min 5 s');
  assert.equal(K.fmtDuration(3_780_000), '1 h 3 min');
  assert.equal(K.fmtDuration(-1), '');
  assert.equal(K.fmtDuration(Number.NaN), '');
});

test('helpers: plans, URLs, recall counts and search counts', () => {
  assert.deepEqual(K.planState({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Doing b' }] }), { items: [{ text: 'a', active: '', status: 'completed' }, { text: 'b', active: 'Doing b', status: 'in_progress' }], done: 1, total: 2, current: 'Doing b' });
  assert.equal(K.urlSubject('https://developer.mozilla.org/en-US/docs/'), 'developer.mozilla.org/en-US/docs');
  assert.equal(K.urlSubject('not a url'), 'not a url');
  assert.equal(K.recallCount('Found 3 memories'), 3);
  assert.equal(K.recallCount('[1a2b3c4d-1111] a\n[5e6f7a8b-2222] b'), 2);
  assert.equal(K.recallCount('No memories found'), 0);
  assert.equal(K.recallCount(''), null);
  assert.deepEqual(K.searchCounts('src/a.js\nsrc/b.js'), { matches: null, files: 2 });
  assert.equal(K.searchCounts('some prose'), null);
  assert.equal(K.isNoMatchCommand('npm test'), false);
  assert.equal(K.capitalize('ran 2 commands'), 'Ran 2 commands');
  assert.equal(K.plural(K.tFallback, 'k', 1, '1 x', '{count} xs'), '1 x');
  assert.equal(K.plural(K.tFallback, 'k', 3, '1 x', '{count} xs'), '3 xs');
});

// ── Fix pass (2026-09-29): review findings F2 F7 F8, visual QA ×N, receipt order, shell subjects ──

test('F7 callOutcome: rg / grep / diff / test exit 1 with an empty stderr is neutral, whatever is on stdout', () => {
  const sh = (command, text, isError, result = null) => K.callOutcome({ kind: 'shell', input: { command } }, text, isError, undefined, result);
  // diff prints the differences on stdout and exits 1: not a failure (Codex mixes stdout and stderr).
  assert.deepEqual(sh('diff a.txt b.txt', '1c1\n< old\n---\n> new\n[exit 1]', true), { state: 'neutral', code: 1, detail: '' });
  assert.equal(sh('diff -u a b', '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n[exit 1]', true).state, 'neutral', 'a unified diff on stdout');
  assert.equal(sh('grep -c foo src/a.js', 'Exit code 1\n0', true).state, 'neutral', 'grep -c prints 0 and exits 1');
  // Claude reports stdout and stderr apart (tool_use_result): only stderr decides.
  assert.equal(sh('rg -n TODO src', 'Exit code 1\nsrc/a.js', true, { stderr: '' }).state, 'neutral');
  assert.equal(sh('rg -n TODO src', 'Exit code 1\nnothing', true, { stderr: '\nShell cwd was reset to /Users/me/x' }).state, 'neutral', "Claude's own cwd notice is not the command's stderr");
  assert.deepEqual(sh('rg -n TODO nope/', 'Exit code 1', true, { stderr: 'rg: nope/: No such file or directory (os error 2)' }), { state: 'error', code: 1, detail: 'rg: nope/: No such file or directory (os error 2)' });
  assert.equal(sh('grep x f', 'Exit code 1\ngrep: f: No such file or directory', true).state, 'error', 'a diagnostic in mixed output is stderr');
  assert.equal(sh('test -f x', '[exit 1]', true).state, 'neutral');
  assert.equal(sh('diff a b', 'Exit code 2\ndiff: b: No such file or directory', true).state, 'error', 'exit 2 is trouble');
  assert.equal(sh('npm test', 'Exit code 1\nall on stdout', true, { stderr: '' }).state, 'error', 'only the no-match programs');
  // Claude read the exit code itself: "No matches found" with is_error false.
  assert.deepEqual(sh('grep -rn foo .', '(Bash completed with no output)', false, { stderr: '', interpretation: 'No matches found' }), { state: 'neutral', code: null, detail: '' });
  assert.deepEqual(sh('ls', 'a\nb', false, { stderr: '', interpretation: 'No matches found' }), { state: 'ok', code: null }, 'an interpretation only matters for the no-match programs');
  assert.deepEqual(K.resultDetail({ stdout: 'x', stderr: 'e', returnCodeInterpretation: 'Files differ', interrupted: false }), { stderr: 'e', interpretation: 'Files differ' });
  assert.equal(K.resultDetail('Error: Exit code 1'), null, 'a failed Claude call is a string');
  assert.equal(K.shellStderr('ok\nrg: regex parse error:\n  x'), 'rg: regex parse error:');
});

test('F8 shouldFoldNarration: a GFM table with or without the outer pipes never folds', () => {
  for (const s of ['a | b\n--- | ---\n1 | 2', 'Name | Size\n:--- | ---:', '| a |\n|---|', 'a|b\n-|-', 'Title\n-----', 'Title\n===']) assert.equal(K.shouldFoldNarration(s), false, JSON.stringify(s));
  for (const s of ['Checking a | b now.', 'Use x|y here.', 'Done - 3 files.']) assert.equal(K.shouldFoldNarration(s), true, JSON.stringify(s));
  assert.equal(K.isTableDelimiter('--- | :---: | ---:'), true);
  assert.equal(K.isTableDelimiter('|---|'), true);
  assert.equal(K.isTableDelimiter('a | b'), false);
  assert.equal(K.isTableDelimiter('---'), false, 'a rule has no pipe');
});

test('F2 redactInput: what a call types and every credential are masked "•••• (N chars)"; the echo too', () => {
  const type = K.redactInput('mcp__SynaBun__browser_type', { ref: 'e12', text: 'hunter2', sessionId: 's1' });
  assert.deepEqual(type.input, { ref: 'e12', text: '•••• (7 chars)', sessionId: 's1' });
  assert.deepEqual(type.hidden, [{ key: 'text', value: 'hunter2' }]);
  assert.deepEqual(K.redactInput('mcp__SynaBun__browser_fill', { selector: '#email', value: 'a@b.co' }).input, { selector: '#email', value: '•••• (6 chars)' });
  assert.deepEqual(K.redactInput('SynaBun_browser_fill', { selector: '#pin', value: 'x' }).input.value, '•••• (1 char)', 'OpenCode name; one char');
  assert.deepEqual(K.redactInput('mcp__playwright__browser_type', { element: 'Search', text: 'q' }).input.text, '•••• (1 char)', "another server's browser_type types too");
  assert.deepEqual(K.redactInput('mcp__SynaBun__computer', { action: 'type', text: 'secret phrase' }).input.text, '•••• (13 chars)', 'a desktop type action');
  assert.deepEqual(K.redactInput('mcp__SynaBun__computer', { action: 'left_click', coordinate: [1, 2] }).hidden, [], 'a click types nothing');
  assert.deepEqual(K.redactInput('mcp__SynaBun__browser_click', { text: 'Sign in' }).hidden, [], "a click's text is the target, not a value");
  const creds = K.redactInput('mcp__x__login', { user: 'me', password: 'pw123', auth: { apiToken: 'tok', client_secret: 's' }, max_tokens: 1000 });
  assert.deepEqual(creds.input, { user: 'me', password: '•••• (5 chars)', auth: { apiToken: '•••• (3 chars)', client_secret: '•••• (1 char)' }, max_tokens: 1000 }, 'credentials at any depth; a token count is not a credential');
  assert.deepEqual(K.redactInput('Read', { file_path: '/a' }), { input: { file_path: '/a' }, hidden: [] });
  assert.equal(K.maskEcho('Typed "hunter2" into ref "e12"', type.hidden), 'Typed "•••• (7 chars)" into ref "e12"');
  assert.equal(K.maskEcho('Filled #pin with "x" and x', [{ key: 'value', value: 'x' }]), 'Filled #pin with "•••• (1 char)" and x', 'a short value only where quoted');
  const seen = [];
  K.maskValue('abc', (key, fallback, params) => { seen.push(key); return K.fill(fallback, params); });
  assert.deepEqual(seen, ['assistant.rack.redacted.other']);
});

test('receipts: weighted (a failed kind first, then commands, edits, reads…), three clauses and "N more"', () => {
  const read = (p) => ({ input: { file_path: p } });
  assert.equal(K.receiptSentence([
    { kind: 'read', calls: [read('a'), read('b')] },
    { kind: 'plan', calls: [{ name: 'TodoWrite', input: { todos: [{ status: 'completed' }, { status: 'pending' }, { status: 'pending' }] } }] },
    { kind: 'shell', calls: calls(3) },
  ]), 'Ran 3 commands, read 2 files, finished 1 of 3 plan steps', 'commands before reads before the plan');
  assert.equal(K.receiptSentence([
    { kind: 'shell', calls: calls(2) },
    { kind: 'search', calls: [{ state: 'ok' }, { state: 'error' }] },
  ]), 'Searched 2 patterns, ran 2 commands', 'the kind with a failure leads');
  assert.equal(K.receiptSentence([
    { kind: 'think', calls: calls(4) },
    { kind: 'shell', calls: calls(20) },
    { kind: 'read', calls: ['a', 'b', 'c', 'd', 'e', 'f'].map(read) },
    { kind: 'edit', calls: [{ name: 'Edit', input: { file_path: 'x', old_string: 'a', new_string: 'b' } }] },
    { kind: 'search', calls: calls(2) },
  ]), 'Ran 20 commands, edited 1 file (+1 −1), read 6 files and 2 more', 'three clauses, then how many more');
  assert.equal(K.RECEIPT_CLAUSES, 3);
  assert.deepEqual(K.RECEIPT_ORDER, ['shell', 'edit', 'read', 'search', 'web', 'memory', 'plan']);
});

test('C8 shell subjects start at the program: env, NAME=value, env -u X and cd … && go', () => {
  const LONG = 'cd /Users/me/Apps/Synabun && env -u SYNABUN_ASSISTANT_SESSION SYNABUN_TYPESAFE=off node --test neural-interface/tests/assistant-render-events.browser.mjs';
  assert.equal(K.commandCore(LONG), 'node --test neural-interface/tests/assistant-render-events.browser.mjs');
  assert.equal(K.commandCore('FOO=1 BAR="a b" npm test'), 'npm test');
  assert.equal(K.commandCore('env -i PATH=/bin ls'), 'ls');
  assert.equal(K.commandCore("env --unset=A -u B C='x' rg -n y"), 'rg -n y');
  assert.equal(K.commandCore('env | grep PATH'), 'env | grep PATH', 'env printing the environment is the program');
  assert.equal(K.commandCore('env'), 'env');
  assert.equal(K.commandCore('envsubst < a > b'), 'envsubst < a > b');
  assert.equal(K.summarizeCommand(LONG), 'node --test …/assistant-render-events.browser.mjs');
  const b = say('Bash', { command: LONG });
  assert.equal(b.text, '$ node --test …/assistant-render-events.browser.mjs', 'the bubble');
  assert.equal(b.full, `$ ${LONG}`, 'the literal: the title and the opened bubble');
  assert.equal(b.copy, LONG);
  assert.equal(K.isNoMatchCommand('cd x && env -u A rg foo'), true);
});

test('B2 targetKey: a re-run or re-read has the same key; different targets do not', () => {
  const key = (name, input) => K.targetKey({ name, input });
  assert.equal(key('Bash', { command: 'npm test' }), key('Bash', { command: 'npm  test' }));
  assert.notEqual(key('Bash', { command: 'npm test' }), key('Bash', { command: 'npm run lint' }));
  assert.equal(key('Read', { file_path: '/a/server.js', offset: 10 }), key('Read', { file_path: '/a/server.js' }), 'another range of the same file is a re-read');
  assert.notEqual(key('Grep', { pattern: 'a' }), key('Glob', { pattern: 'a' }));
  assert.equal(key('mcp__SynaBun__recall', { query: 'x' }), key('mcp__SynaBun__recall', { query: 'x' }));
  assert.equal(K.targetKey({ name: 'TodoWrite', input: { todos: [] } }), '', 'a plan update names no target');
  assert.equal(K.targetKey({ name: 'thinking', kind: 'think' }), '');
});

test('titles never get a space before the ellipsis', () => {
  assert.equal(say('Task', { description: `${'word '.repeat(20)}end` }).text.endsWith(' …'), false);
  assert.match(say('Task', { description: `${'word '.repeat(20)}end` }).text, /\S…$/);
});
