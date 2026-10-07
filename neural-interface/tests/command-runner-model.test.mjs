import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCommandGroups, commandLaunchPayload, isCommandLaunchAvailable } from '../public/shared/command-runner-model.js';

const library = () => ({
  categories: [{ id: 'dev', name: 'Développement', order: 1, collapsed: true }, { id: 'check', name: 'Quality checks', order: 0 }, { id: 'empty', name: 'Deployment', order: 2 }],
  commands: [
    { id: 'server', categoryId: 'dev', name: 'Start server', command: 'npm run dev', cwd: '/work/My project', order: 1 },
    { id: 'watch', categoryId: 'dev', name: 'Watch files', command: 'node --watch server.js', cwd: null, order: 0, lastRunAt: 200 },
    { id: 'tests', categoryId: 'check', name: 'Test suite', command: 'npm test', cwd: '/work/My project', order: 0, lastRunAt: 100 },
  ],
});

test('saved order includes empty groups and does not mutate the library or collapse state', () => {
  const data = library(), before = structuredClone(data);
  const groups = selectCommandGroups(data);
  assert.deepEqual(groups.map(g => g.category.id), ['check', 'dev', 'empty']);
  assert.deepEqual(groups[1].commands.map(c => c.id), ['watch', 'server']);
  assert.equal(groups[2].commands.length, 0);
  assert.deepEqual(data, before);
});

test('search matches names, accent-insensitive groups, command text, and full directories', () => {
  const data = library();
  for (const [query, ids] of [['START', ['server']], ['developpement', ['watch', 'server']], ['--watch', ['watch']], ['/work/My project', ['tests', 'server']]]) {
    assert.deepEqual(selectCommandGroups(data, { query }).flatMap(g => g.commands.map(c => c.id)), ids);
  }
});

test('all search terms must match and group filtering intersects search results', () => {
  assert.deepEqual(selectCommandGroups(library(), { query: 'npm project', categoryId: 'dev' }).flatMap(g => g.commands.map(c => c.id)), ['server']);
  assert.deepEqual(selectCommandGroups(library(), { query: 'npm watch' }), []);
  assert.deepEqual(selectCommandGroups(library(), { categoryId: 'missing' }), []);
});

test('whitespace search preserves empty groups and special characters are literal', () => {
  assert.equal(selectCommandGroups(library(), { query: '  \t  ' }).length, 3);
  assert.deepEqual(selectCommandGroups(library(), { query: '[.*' }), []);
});

test('recent order brings recently used groups and commands forward without changing saved order', () => {
  const data = library(), before = structuredClone(data);
  data.commands[0].lastRunAt = 300;
  const recent = selectCommandGroups(data, { sort: 'recent' });
  assert.deepEqual(recent.map(g => g.category.id), ['dev', 'check', 'empty']);
  assert.deepEqual(recent[0].commands.map(c => c.id), ['server', 'watch']);
  assert.deepEqual(selectCommandGroups(data)[1].commands.map(c => c.id), before.commands.filter(c => c.categoryId === 'dev').reverse().map(c => c.id));
});

test('long translated names and RTL text remain searchable', () => {
  const data = library();
  data.commands[0].name = 'Reiniciar todos os servidores de desenvolvimento — '.repeat(8) + 'خادم';
  assert.deepEqual(selectCommandGroups(data, { query: 'خادم desenvolvimento' }).flatMap(g => g.commands.map(c => c.id)), ['server']);
});

test('launch preserves shell quoting, newlines, long commands, cwd spaces, and label', () => {
  const cmd = { name: 'Quoted command', command: `printf '%s' "a b" 'c$d'\necho ${'x'.repeat(300)}`, cwd: '/work/My project', categoryId: 'dev', lastRunAt: 10 };
  assert.deepEqual(commandLaunchPayload(cmd), { command: cmd.command, cwd: cmd.cwd, label: cmd.name });
  assert.equal(commandLaunchPayload({ ...cmd, cwd: '' }).cwd, null);
  assert.equal(commandLaunchPayload({ ...cmd, cwd: null }).cwd, null);
});

test('local terminal commands remain available without internet, remote commands require connectivity', () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', '::1']) assert.equal(isCommandLaunchAvailable(false, hostname), true);
  assert.equal(isCommandLaunchAvailable(false, 'workspace.example.com'), false);
  assert.equal(isCommandLaunchAvailable(true, 'workspace.example.com'), true);
});
