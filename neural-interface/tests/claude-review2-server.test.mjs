// Review 2 of the Claude panel parity build, server side: V06 (fork target),
// V07 (page extension), V09 (the active branch's leaf), V11 (a named account's
// settings), V12 (an agent's empty tool list), V14 (a failed cleanup is
// reported). Each fails without its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createChainIndex, createHistoryCollector, pageHistory } from '../lib/claude-history.js';
import { createSessionOps } from '../lib/claude-session-ops.js';
import { createSessionCleanup, deleteSessionRows, cleanupFailures } from '../lib/claude-session-cleanup.js';
import { readPermissionRules, removePermissionRule, userSettingsFile, PermissionRuleError } from '../lib/claude-permission-rules.js';
import { normalizePanelSession, applyPanelSessionOptions, startSignature } from '../lib/claude-panel-session.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(HERE, '..', 'server.js'), 'utf8');
const u = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

// ── V06 ──

// A turn that ends on an end-turn tool: call, result carrier, then the
// structured_output attachment that holds the turn's real output. Then a prompt.
function endTurnTranscript() {
  return [
    { type: 'user', uuid: u(1), parentUuid: null, message: { role: 'user', content: 'extract it' } },
    { type: 'assistant', uuid: u(2), parentUuid: u(1), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'StructuredOutput', input: {} }] } },
    { type: 'user', uuid: u(3), parentUuid: u(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
    { type: 'attachment', uuid: u(4), parentUuid: u(3), attachment: { type: 'structured_output', data: { answer: 42 } } },
    { type: 'progress', uuid: u(5), parentUuid: u(4) },
    { type: 'user', uuid: u(6), parentUuid: u(5), message: { role: 'user', content: 'now something else' } },
  ];
}

test('V06: the entry a fork ends on is the retained turn\'s last chain entry, its structured output included', () => {
  const chain = createChainIndex();
  for (const line of endTurnTranscript()) chain.add(line);
  assert.equal(chain.parentOf(u(6), { forkable: true }), u(4), 'the structured_output attachment, not the carrier before it');
  assert.equal(chain.parentOf(u(6), { messagesOnly: true }), u(3), 'what the fork used before: the attachment was cut off');
  assert.equal(chain.parentOf(u(6)), u(5), 'the raw parent (a progress line is not something a fork can end on)');
  assert.equal(chain.parentOf(u(1), { forkable: true }), '', 'the first prompt follows nothing');
  assert.equal(chain.parentOf(u(99), { forkable: true }), null);
  // A link that leaves the file: nothing is known above it.
  const broken = createChainIndex();
  broken.add({ type: 'user', uuid: u(7), parentUuid: u(50), message: { role: 'user', content: 'x' } });
  assert.equal(broken.parentOf(u(7), { forkable: true }), '');
});

test('V06: the fork route asks for the forkable parent, and a fork is refused when the transcript cannot say', async () => {
  const ops = /const claudeSessionOps = createSessionOps\(\{[\s\S]*?\n\}\);/.exec(server)?.[0] || '';
  assert.match(ops, /chain\.parentOf\(uuid, \{ forkable: true \}\)/);
  assert.doesNotMatch(ops, /messagesOnly: true/);

  const calls = [];
  const sdk = { forkSession: async (...a) => { calls.push(a); return { sessionId: 'new-session-id' }; } };
  const mk = (parentOf) => createSessionOps({ sdk, projects: () => [{ path: '/repo/app' }], parentOf });
  const PROMPT = u(6); const GUESS = u(2);
  // The page's own guess (an earlier rendered row) no longer stands in for the transcript.
  await assert.rejects(() => mk(async () => null).fork(SID, { beforeMessageId: PROMPT, upToMessageId: GUESS }), (e) => e.status === 409);
  await assert.rejects(() => mk(async () => { throw new Error('EACCES'); }).fork(SID, { beforeMessageId: PROMPT, upToMessageId: GUESS }), (e) => e.status === 409);
  assert.equal(calls.length, 0);
  await mk(async () => u(4)).fork(SID, { beforeMessageId: PROMPT, upToMessageId: GUESS });
  assert.deepEqual(calls[0], [SID, { upToMessageId: u(4) }]);
  // A host that wired no transcript lookup keeps the old contract.
  await createSessionOps({ sdk, projects: () => [] }).fork(SID, { beforeMessageId: PROMPT, upToMessageId: GUESS });
  assert.deepEqual(calls[1], [SID, { upToMessageId: GUESS }]);
});

// ── V07 ──

const call = (...ids) => ({ role: 'assistant', tools: ids.map(id => ({ id, name: 'Bash', input: {} })) });
const result = (id) => ({ role: 'tool_result', toolUseId: id, text: id });
const reply = (text) => ({ role: 'assistant', text });
const completeCalls = (page) => {
  const called = new Set(page.messages.flatMap(m => (m.tools || []).map(t => t.id)));
  return page.messages.filter(m => m.role === 'tool_result' && !called.has(m.toolUseId)).map(m => m.toolUseId);
};

test('V07: extending a page never exposes a result without its call', () => {
  // The review's example: the extension to call B brings result A into the page.
  const rows = [call('A'), call('B'), result('A'), result('B'), reply('done')];
  const page = pageHistory(rows, { limit: 2 });
  assert.equal(page.start, 0);
  assert.deepEqual(completeCalls(page), []);

  // Chained: each extension uncovers another result.
  const chained = [call('A'), call('B'), result('A'), call('C'), result('B'), result('C'), reply('x')];
  const p2 = pageHistory(chained, { limit: 2 });
  assert.equal(p2.start, 0);
  assert.deepEqual(completeCalls(p2), []);

  // A call far above the page (more than the old 200-row bound) is still reached.
  const far = [call('FAR'), ...Array.from({ length: 450 }, (_, i) => reply(`r${i}`)), result('FAR'), reply('end')];
  const p3 = pageHistory(far, { limit: 2 });
  assert.equal(p3.start, 0);
  assert.deepEqual(completeCalls(p3), []);

  // "Load earlier" pages are complete too, and the next page ends where this one starts.
  const p4 = pageHistory(chained, { limit: 2, before: 5 });
  assert.deepEqual(completeCalls(p4), []);
  assert.equal(p4.messages.at(-1), chained[4]);

  // A result whose call is not in the transcript at all pulls nothing in.
  const orphan = [reply('a'), reply('b'), result('GONE'), reply('c')];
  assert.equal(pageHistory(orphan, { limit: 2 }).start, 2);
  // And a page with nothing to complete is the plain slice.
  const plain = Array.from({ length: 10 }, (_, i) => reply(`r${i}`));
  assert.equal(pageHistory(plain, { limit: 3 }).start, 7);
});

// ── V09 ──

test('V09: the history page names the last entry of the active branch', () => {
  const lines = [
    { type: 'user', uuid: u(1), parentUuid: null, message: { role: 'user', content: 'first' } },
    { type: 'assistant', uuid: u(2), parentUuid: u(1), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
    { type: 'user', uuid: u(3), parentUuid: u(2), message: { role: 'user', content: 'abandoned prompt' } },
    { type: 'assistant', uuid: u(4), parentUuid: u(3), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'abandoned reply' }] } },
  ];
  const before = createHistoryCollector();
  for (const l of lines) before.add(l);
  const a = before.finish({ limit: 1 });
  assert.equal(a.leaf, u(4));
  // A conversation rewind to before the second prompt, then a continuation of
  // the same length: the row count is the same, the leaf is not.
  const after = createHistoryCollector();
  for (const l of [...lines,
    { type: 'user', uuid: u(5), parentUuid: u(2), message: { role: 'user', content: 'replacement prompt' } },
    { type: 'assistant', uuid: u(6), parentUuid: u(5), message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'replacement reply' }] } },
  ]) after.add(l);
  const b = after.finish({ limit: 1 });
  assert.equal(b.visible, a.visible, 'the count alone cannot tell');
  assert.equal(b.leaf, u(6));
  assert.equal(createHistoryCollector().finish({}).leaf, '');
  // A slash command typed after the last reply does not move the leaf: the panel stamps no uuid on that row.
  const cmd = createHistoryCollector();
  for (const l of [...lines.slice(0, 2), { type: 'user', uuid: u(9), parentUuid: u(2), message: { role: 'user', content: '<command-name>/context</command-name>' } }]) cmd.add(l);
  assert.equal(cmd.finish({}).leaf, u(2));
  const route = /app\.get\('\/api\/claude-code\/sessions\/:sessionId\/messages'[\s\S]*?\n\}\);/.exec(server)?.[0] || '';
  assert.match(route, /leaf: page\.leaf/);
});

// ── V11 ──

function accountSandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'synabun-acct-')));
  const home = join(root, 'home');
  const accounts = join(root, 'data', 'claude-accounts');
  mkdirSync(join(home, '.claude'), { recursive: true });
  for (const id of ['shared', 'own', 'foreign', 'bare']) mkdirSync(join(accounts, id), { recursive: true });
  const defaultFile = join(home, '.claude', 'settings.json');
  writeFileSync(defaultFile, JSON.stringify({ permissions: { allow: ['Bash(default:*)', 'Read(//shared/**)'] }, model: 'opus' }, null, 2));
  symlinkSync(defaultFile, join(accounts, 'shared', 'settings.json'));
  writeFileSync(join(accounts, 'own', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(work:*)'], deny: ['WebFetch'] } }, null, 2));
  writeFileSync(join(root, 'elsewhere.json'), JSON.stringify({ permissions: { allow: ['Bash(elsewhere:*)'] } }));
  symlinkSync(join(root, 'elsewhere.json'), join(accounts, 'foreign', 'settings.json'));
  return { root, home, defaultFile, at: (id) => join(accounts, id), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('V11: a named account\'s rules are read from its own settings, and say when they are shared', () => {
  const s = accountSandbox();
  try {
    const own = readPermissionRules({ home: s.home, accountHome: s.at('own') });
    assert.deepEqual(own.user.allow, ['Bash(work:*)']);
    assert.deepEqual(own.user.deny, ['WebFetch']);
    assert.equal(own.user.path, join(s.at('own'), 'settings.json'));
    assert.equal(own.user.shared, false);
    const shared = readPermissionRules({ home: s.home, accountHome: s.at('shared') });
    assert.deepEqual(shared.user.allow, ['Bash(default:*)', 'Read(//shared/**)']);
    assert.equal(shared.user.shared, true, 'the same file as the default account: the view says so');
    const bare = readPermissionRules({ home: s.home, accountHome: s.at('bare') });
    assert.equal(bare.user.exists, false);
    assert.deepEqual(bare.user.allow, [], 'an account without a settings file has no user rules: not the default account\'s');
    // The default account is read as before, with no new keys.
    const def = readPermissionRules({ home: s.home });
    assert.deepEqual(def.user.allow, ['Bash(default:*)', 'Read(//shared/**)']);
    assert.equal('shared' in def.user, false);
  } finally { s.done(); }
});

test('V11: removing a rule in a named-account tab edits that account\'s file', () => {
  const s = accountSandbox();
  try {
    // Its own file: the default account's is untouched.
    assert.equal(removePermissionRule({ home: s.home, accountHome: s.at('own'), scope: 'user', list: 'allow', rule: 'Bash(work:*)' }).removed, true);
    assert.deepEqual(JSON.parse(readFileSync(join(s.at('own'), 'settings.json'), 'utf8')).permissions.allow, []);
    assert.deepEqual(JSON.parse(readFileSync(s.defaultFile, 'utf8')).permissions.allow, ['Bash(default:*)', 'Read(//shared/**)']);
    // A rule only the default account has is not found in the other account.
    assert.equal(removePermissionRule({ home: s.home, accountHome: s.at('own'), scope: 'user', list: 'allow', rule: 'Bash(default:*)' }).removed, false);
    assert.equal(removePermissionRule({ home: s.home, accountHome: s.at('bare'), scope: 'user', list: 'allow', rule: 'Bash(default:*)' }).removed, false);
    assert.deepEqual(JSON.parse(readFileSync(s.defaultFile, 'utf8')).permissions.allow, ['Bash(default:*)', 'Read(//shared/**)']);
    // A shared file: the rule is this account's too. It is removed from the one
    // file both read, and the link stays a link.
    const r = removePermissionRule({ home: s.home, accountHome: s.at('shared'), scope: 'user', list: 'allow', rule: 'Read(//shared/**)' });
    assert.equal(r.removed, true);
    assert.equal(lstatSync(join(s.at('shared'), 'settings.json')).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(readFileSync(s.defaultFile, 'utf8')).permissions.allow, ['Bash(default:*)']);
    assert.equal(JSON.parse(readFileSync(s.defaultFile, 'utf8')).model, 'opus', 'nothing else in the file changed');
    // A link to a file SynaBun does not manage is not written through.
    assert.throws(() => removePermissionRule({ home: s.home, accountHome: s.at('foreign'), scope: 'user', list: 'allow', rule: 'Bash(elsewhere:*)' }), (e) => e instanceof PermissionRuleError && e.status === 409);
    assert.deepEqual(JSON.parse(readFileSync(join(s.root, 'elsewhere.json'), 'utf8')).permissions.allow, ['Bash(elsewhere:*)']);
    // userSettingsFile is the one answer behind both.
    assert.deepEqual(userSettingsFile({ home: s.home }), { path: s.defaultFile, writePath: s.defaultFile, shared: false, own: true });
    assert.equal(userSettingsFile({ home: s.home, accountHome: s.at('shared') }).shared, true);
    assert.equal(userSettingsFile({ home: s.home, accountHome: s.at('own') }).own, true);
    assert.equal(userSettingsFile({ home: s.home, accountHome: s.at('foreign') }).writePath, '');
  } finally { s.done(); }
});

test('V11: the three settings routes resolve the tab\'s account and never fall back to the default one', () => {
  const helper = /function panelAccountHome\(value\) \{[\s\S]*?\n\}/.exec(server)?.[0] || '';
  assert.match(helper, /account_unavailable/);
  assert.match(helper, /homeFor\(/);
  const get = /app\.get\('\/api\/claude-code\/permission-rules'[\s\S]*?\n\}\);/.exec(server)?.[0] || '';
  assert.match(get, /panelAccountHome\(req\.query\.account\)/);
  assert.match(get, /readPermissionRules\(\{ home: [^}]*accountHome/);
  const del = /app\.delete\('\/api\/claude-code\/permission-rules'[\s\S]*?\n\}\);/.exec(server)?.[0] || '';
  assert.match(del, /panelAccountHome\(req\.body\?\.account\)/);
  assert.match(del, /removePermissionRule\(\{ home: [^}]*accountHome/);
  const resolved = /app\.get\('\/api\/claude-code\/settings\/resolved'[\s\S]*?\n\}\);/.exec(server)?.[0] || '';
  assert.match(resolved, /panelAccountHome\(req\.query\.account\)/);
  assert.match(resolved, /account_settings_unresolvable/);
  assert.ok(resolved.indexOf('account_settings_unresolvable') < resolved.indexOf('resolveSettings('), 'refused before the SDK resolves the default account\'s settings');
  assert.match(server, /accountSettings: true,/);
});

// ── V12 ──

test('V12: an agent with an explicit empty tool list stays without tools', () => {
  const base = { description: 'Reviews', prompt: 'Review the diff.' };
  const s = normalizePanelSession({ agents: {
    inherit: { ...base },
    none: { ...base, tools: [] },
    some: { ...base, tools: ['Read', 'Grep'] },
    filtered: { ...base, tools: ['not a tool name!', '../x'] },
    mixed: { ...base, tools: ['Read', 'not a tool name!'] },
    nullish: { ...base, tools: null },
  } });
  const byName = Object.fromEntries(s.start.agents.map(a => [a.name, a]));
  assert.equal('tools' in byName.inherit, false, 'absent: the agent inherits its parent\'s tools');
  assert.deepEqual(byName.none.tools, [], 'explicitly none');
  assert.deepEqual(byName.some.tools, ['Read', 'Grep']);
  assert.deepEqual(byName.filtered.tools, [], 'a list whose entries are all unusable does not turn into "inherit"');
  assert.deepEqual(byName.mixed.tools, ['Read']);
  assert.equal('tools' in byName.nullish, false);

  const options = {};
  applyPanelSessionOptions(options, s, {});
  assert.equal('tools' in options.agents.inherit, false);
  assert.deepEqual(options.agents.none.tools, []);
  assert.deepEqual(options.agents.filtered.tools, []);
  assert.deepEqual(options.agents.some.tools, ['Read', 'Grep']);
  // Giving an agent "no tools" instead of "all tools" is a different session.
  const withNone = normalizePanelSession({ agents: { a: { ...base, tools: [] } } });
  const withAll = normalizePanelSession({ agents: { a: { ...base } } });
  assert.notEqual(startSignature(withNone), startSignature(withAll));
});

// ── V14 ──

test('V14: a failed database cleanup is reported; a store that never indexed is not a failure', () => {
  // No tables at all: nothing to drop, nothing wrong.
  assert.deepEqual(deleteSessionRows(new DatabaseSync(':memory:'), SID, 'claude-code'), { chunks: 0, cache: 0, fts: 0 });
  // A database error on one table: the others are still tried, and the failure is thrown.
  const ran = [];
  const db = { prepare: (sql) => ({ run: () => { ran.push(sql.split(' ')[2]); if (sql.includes('session_fts')) throw new Error('database is locked'); if (sql.includes('session_cache')) throw new Error('no such table: session_cache'); return { changes: 3 }; } }) };
  assert.throws(() => deleteSessionRows(db, SID, 'claude-code'), (e) => /session_fts.*database is locked/.test(e.message) && e.partial.chunks === 3);
  assert.deepEqual(ran, ['session_chunks', 'session_fts', 'session_cache']);

  const logged = [];
  const cleanup = createSessionCleanup({ log: (m) => logged.push(m), steps: { cost: () => {}, chunks: (id) => deleteSessionRows(db, id, 'claude-code') } });
  const report = cleanup(SID);
  assert.equal(report.cost, 'ok');
  assert.match(report.chunks, /^failed: .*database is locked/);
  assert.equal(logged.length, 1);
  assert.deepEqual(cleanupFailures(report), ['chunks']);
  assert.deepEqual(cleanupFailures({ cost: 'ok' }), []);
  assert.deepEqual(cleanupFailures(undefined), []);
});

test('V14: the delete answer carries the cleanup report and says what was left behind', async () => {
  const sdk = { deleteSession: async () => {} };
  const failing = createSessionOps({ sdk, projects: () => [], afterDelete: () => ({ cost: 'ok', chunks: 'failed: database is locked' }) });
  const out = await failing.remove(SID);
  assert.equal(out.ok, true, 'the transcript is gone: that part cannot be undone');
  assert.deepEqual(out.cleanup, { cost: 'ok', chunks: 'failed: database is locked' });
  assert.deepEqual(out.cleanupFailed, ['chunks']);
  assert.match(out.warning, /chunks/);
  const clean = createSessionOps({ sdk, projects: () => [], afterDelete: () => ({ cost: 'ok', chunks: 'ok' }) });
  const ok = await clean.remove(SID);
  assert.deepEqual(ok.cleanup, { cost: 'ok', chunks: 'ok' });
  assert.equal('warning' in ok, false);
  assert.equal('cleanupFailed' in ok, false);
  // A cleanup that throws outright is a failure too, not a silent success.
  const thrown = await createSessionOps({ sdk, projects: () => [], afterDelete: () => { throw new Error('boom'); } }).remove(SID);
  assert.deepEqual(thrown.cleanupFailed, ['cleanup']);
  // No cleanup wired: the answer is what it was.
  assert.deepEqual(await createSessionOps({ sdk, projects: () => [] }).remove(SID), { ok: true, sessionId: SID });
});
