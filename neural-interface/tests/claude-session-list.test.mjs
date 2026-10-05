// C46 / C47: the CLI's own titles, summaries and tags over SynaBun's session list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSessionListOverlay, overlaySessions, matchesSessionFilter } from '../lib/claude-session-list.js';
import { sessionListLabel, collectTags } from '../public/shared/cp/cp-sessions.js';

const rows = [
  { sessionId: 's1', summary: 'Fix the tests', customTitle: 'Test fixes', tag: 'bug', createdAt: 1000, lastModified: 2000, cwd: '/repo' },
  { sessionId: 's2', summary: 'first prompt text', lastModified: 1500 },
  { nope: true },
];

test('the list is read once per project, served while it refreshes, and never breaks the menu', async () => {
  let calls = 0;
  let clock = 0;
  let fail = false;
  const overlay = createSessionListOverlay({
    listSessions: async ({ dir }) => { calls++; if (fail) throw new Error('EACCES'); return dir === '/repo' ? rows : []; },
    ttlMs: 1000, now: () => clock,
  });
  const first = await overlay.forProject('/repo');
  assert.deepEqual(first.get('s1'), { title: 'Test fixes', summary: 'Fix the tests', tag: 'bug', createdAt: 1000 });
  assert.deepEqual(first.get('s2'), { title: '', summary: 'first prompt text', tag: '', createdAt: null });
  assert.equal(first.size, 2);
  await overlay.forProject('/repo');
  assert.equal(calls, 1, 'fresh: no second read');
  clock = 5000;
  const stale = await overlay.forProject('/repo');
  assert.equal(stale, first, 'the stale list is served at once');
  await new Promise(r => setTimeout(r, 5));
  assert.equal(calls, 2, 'and refreshed behind it');
  // A read that fails keeps the last good list.
  fail = true; clock = 20000;
  await overlay.forProject('/repo');
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await overlay.forProject('/repo')).get('s1').tag, 'bug');
  // A project that was never read and cannot be: an empty map, not an error.
  assert.equal((await overlay.forProject('/other')).size, 0);
  assert.equal((await overlay.forProject('')).size, 0);
  // After a rename, tag, fork or delete the next request reads again.
  fail = false;
  const before = calls;
  overlay.invalidate();
  await overlay.forProject('/repo');
  await new Promise(r => setTimeout(r, 5));
  assert.equal(calls, before + 1);
});

test('a first list that is slow does not hold the menu', async () => {
  const overlay = createSessionListOverlay({ listSessions: () => new Promise(r => setTimeout(() => r(rows), 80)), firstWaitMs: 10 });
  const t = Date.now();
  assert.equal((await overlay.forProject('/repo')).size, 0);
  assert.ok(Date.now() - t < 70, 'returned before the list was ready');
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await overlay.forProject('/repo')).size, 2, 'the list is there for the next request');
});

test('entries get the title and tag; search and the tag filter see them', () => {
  const meta = new Map([['s1', { title: 'Test fixes', summary: 'Fix the tests', tag: 'bug', createdAt: 1 }]]);
  const entries = overlaySessions([{ sessionId: 's1', firstPrompt: 'please fix' }, { sessionId: 's9', firstPrompt: 'other' }], meta);
  assert.deepEqual(entries[0], { sessionId: 's1', firstPrompt: 'please fix', title: 'Test fixes', summary: 'Fix the tests', tag: 'bug' });
  assert.deepEqual(entries[1], { sessionId: 's9', firstPrompt: 'other' });
  assert.equal(matchesSessionFilter(entries[0], { search: 'test fix' }), true, 'a title set in the terminal is searchable');
  assert.equal(matchesSessionFilter(entries[0], { search: 'bug' }), true);
  assert.equal(matchesSessionFilter(entries[1], { search: 'bug' }), false);
  assert.equal(matchesSessionFilter(entries[0], { tag: 'bug' }), true);
  assert.equal(matchesSessionFilter(entries[1], { tag: 'bug' }), false);
  assert.equal(matchesSessionFilter(entries[1], {}), true);
  assert.deepEqual(overlaySessions(null, meta), []);
});

test('the menu shows the name the user gave here, then the CLI\'s title, then the first prompt', () => {
  assert.equal(sessionListLabel({ title: 'Test fixes', firstPrompt: 'please fix' }, 'My label'), 'My label');
  assert.equal(sessionListLabel({ title: 'Test fixes', firstPrompt: 'please fix' }, ''), 'Test fixes');
  assert.equal(sessionListLabel({ title: '', firstPrompt: 'please fix' }, ''), 'please fix');
  assert.equal(sessionListLabel({}, ''), '');
  assert.deepEqual(collectTags([{ tag: 'bug' }, { tag: '' }, { tag: 'release' }, { tag: 'bug' }, {}]), ['bug', 'release']);
});

test('server.js overlays the list, filters by tag, and forgets the list after a change', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/claude-code/sessions', async"), server.indexOf('// GET /api/codex/sessions'));
  assert.match(route, /const meta = await claudeSessionOverlay\.forProject\(proj\.path\);/);
  assert.match(route, /entries = overlaySessions\(entries, meta\)/);
  assert.match(route, /matchesSessionFilter\(e, \{ search, tag: tagFilter \}\)/);
  assert.match(route, /title: e\.title \|\| '',/);
  assert.match(route, /tag: e\.tag \|\| '',/);
  assert.match(server, /if \(req\.method !== 'GET'\) claudeSessionOverlay\.invalidate\(\);/);
});

test('the panel menu: CLI title in the label, a tag chip, a tag action behind session_ops, a tag filter', () => {
  const panel = readFileSync(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(panel, /const label = getLabel\(s\.sessionId\) \|\| cleanPrompt\(sessionListLabel\(s\)\) \|\| 'Empty session';/);
  // The chip's markup moved to sessionRowParts() in cp/cp-sessions.js (review 2, V01:
  // every value of the row is escaped there, for text and for attributes); the row passes the tag in.
  const rowParts = readFileSync(new URL('../public/shared/cp/cp-sessions.js', import.meta.url), 'utf8');
  assert.match(rowParts, /if \(tag\) metaHtml \+= `<span class="cp-sess-branch cp-sess-tag" title="Tag">#\$\{escapeHtml\(tag\)\}<\/span>`;/);
  assert.match(panel, /sessionRowParts\(\{[\s\S]{0,200}tag: s\.tag,/);
  assert.match(panel, /\$\{sessionOps \? `<button class="cp-sess-rename cp-sess-tag-btn"/, 'the tag action needs the server routes');
  assert.match(panel, /tagClaudeSession\(s\.sessionId, next, projectPath\)/);
  assert.match(panel, /if \(_cpSessTag && \(s\.tag \|\| ''\) !== _cpSessTag\) return false;/);
  assert.match(panel, /opt\.textContent = `#\$\{t\}`;/, 'tag names reach the filter as text');
});
