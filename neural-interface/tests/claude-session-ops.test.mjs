import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { installMiniDom } from './fixtures/mini-dom.mjs';
import { createSessionOps, SessionOpError } from '../lib/claude-session-ops.js';
import { forkTitle, entryBefore, promptText, removeFrom, cacheCostText } from '../public/shared/cp/cp-sessions.js';
import { describeEvent } from '../public/shared/cp/cp-events.js';

// Session management of the Claude sidepanel through the Agent SDK's own
// functions: a title the CLI can read, fork, delete (confirmed), subagent
// transcripts; and the panel's side of a conversation rewind.

const SID = '0a1b2c3d-1111-2222-3333-444455556666';
const MID = '9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff';

function fakeSdk() {
  const calls = [];
  return {
    calls,
    renameSession: async (...a) => { calls.push(['rename', ...a]); },
    tagSession: async (...a) => { calls.push(['tag', ...a]); },
    forkSession: async (...a) => { calls.push(['fork', ...a]); return { sessionId: 'new-session-id' }; },
    deleteSession: async (...a) => { calls.push(['delete', ...a]); },
    listSubagents: async (...a) => { calls.push(['subagents', ...a]); return ['agent-a1', '../../etc', 'agent_b2']; },
    getSubagentMessages: async (...a) => {
      calls.push(['messages', ...a]);
      return [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Find the call sites' } },
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' } }] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '3 files' }] } },
      ];
    },
  };
}
const projects = () => [{ path: '/repo/app' }];

test('rename writes the title through the SDK, for a registered project only', async () => {
  const sdk = fakeSdk();
  const ops = createSessionOps({ sdk, projects });
  assert.deepEqual(await ops.rename(SID, '  Fix the tests  ', '/repo/app'), { ok: true, sessionId: SID, title: 'Fix the tests' });
  assert.deepEqual(sdk.calls[0], ['rename', SID, 'Fix the tests', { dir: '/repo/app' }]);
  await ops.rename(SID, 'No project');
  assert.deepEqual(sdk.calls[1], ['rename', SID, 'No project', {}], 'without a project the SDK searches all of them');
  await assert.rejects(ops.rename(SID, 'x', '/etc'), (e) => e instanceof SessionOpError && e.status === 400 && /registered project/.test(e.message));
  await assert.rejects(ops.rename(SID, '   '), /title is required/);
  await assert.rejects(ops.rename('../../x', 'y'), /Not a session id/);
  assert.equal(sdk.calls.length, 2);
});

test('tag sets and clears', async () => {
  const sdk = fakeSdk();
  const ops = createSessionOps({ sdk, projects });
  assert.equal((await ops.tag(SID, ' release ')).tag, 'release');
  assert.equal((await ops.tag(SID, '')).tag, null);
  assert.deepEqual(sdk.calls.map(c => c[2]), ['release', null]);
});

test('fork copies the session, whole or up to a message', async () => {
  const sdk = fakeSdk();
  const ops = createSessionOps({ sdk, projects });
  assert.deepEqual(await ops.fork(SID, { title: 'Fork of Fix', project: '/repo/app' }), { ok: true, sessionId: 'new-session-id', forkedFrom: SID });
  assert.deepEqual(sdk.calls[0], ['fork', SID, { dir: '/repo/app', title: 'Fork of Fix' }]);
  await ops.fork(SID, { upToMessageId: MID });
  assert.deepEqual(sdk.calls[1], ['fork', SID, { upToMessageId: MID }]);
  await assert.rejects(ops.fork(SID, { upToMessageId: 'not-a-uuid' }), /Not a message id/);
  const broken = createSessionOps({ sdk: { ...sdk, forkSession: async () => ({}) }, projects });
  await assert.rejects(broken.fork(SID), /did not return a session/);
});

test('delete refuses a session a tab is using, and cleans up after a real one', async () => {
  const sdk = fakeSdk();
  const cleaned = [];
  let busy = 'This session is open in a tab. Close the tab first.';
  const ops = createSessionOps({ sdk, projects, isBusy: () => busy, afterDelete: (id) => cleaned.push(id) });
  await assert.rejects(ops.remove(SID), (e) => e.status === 409 && /open in a tab/.test(e.message));
  assert.equal(sdk.calls.length, 0, 'nothing was deleted');
  busy = '';
  assert.deepEqual(await ops.remove(SID, '/repo/app'), { ok: true, sessionId: SID });
  assert.deepEqual(sdk.calls[0], ['delete', SID, { dir: '/repo/app' }]);
  assert.deepEqual(cleaned, [SID]);
});

test('a subagent transcript comes back as history rows', async () => {
  const sdk = fakeSdk();
  const ops = createSessionOps({ sdk, projects });
  assert.deepEqual((await ops.subagents(SID)).agents, ['agent-a1', 'agent_b2'], 'ids that are not plain names are dropped');
  const { messages } = await ops.subagentMessages(SID, 'agent-a1', '/repo/app');
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool_result']);
  assert.equal(messages[1].tools[0].name, 'Grep');
  assert.deepEqual(sdk.calls.at(-1), ['messages', SID, 'agent-a1', { dir: '/repo/app', limit: 400 }]);
  await assert.rejects(ops.subagentMessages(SID, '../secret'), /Not an agent id/);
});

// ── Panel helpers ──

test('fork titles, and the cache-cost sentence', () => {
  assert.equal(forkTitle('Fix the tests'), 'Fork of Fix the tests');
  assert.equal(forkTitle('Fork of Fix the tests'), 'Fork of Fix the tests');
  assert.equal(forkTitle('New chat'), 'Fork');
  assert.equal(cacheCostText({ estimated_cache_write_usd: 0.4231, seconds_since_last_response: 7200 }), 'The prompt cache of this session has expired (idle for 2h 00m): the next reply re-caches the context, about $0.42.');
  assert.equal(cacheCostText({ estimated_cache_write_usd: 0.004 }), 'The prompt cache of this session has expired: the next reply re-caches the context, about $0.0040.');
  assert.equal(cacheCostText({ estimated_cache_write_usd: 0 }), '');
  assert.equal(describeEvent({ type: 'system', subtype: 'cache_cost', estimated_cache_write_usd: 1 }).kind, 'cache_cost');
});

test('a conversation rewind resumes at the entry before the prompt, and removes what followed', () => {
  const dom = installMiniDom();
  try {
    const $msgs = dom.container('cp-messages');
    const mk = (cls, data = {}, text = '') => {
      const el = document.createElement('div');
      el.className = cls;
      Object.assign(el.dataset, data);
      if (cls.includes('msg-user')) { const b = document.createElement('div'); b.className = 'msg-bubble'; const chip = document.createElement('span'); chip.textContent = 'file.txt'; b.append(chip, text); el.appendChild(b); }
      $msgs.appendChild(el);
      return el;
    };
    const first = mk('msg msg-user', { uuid: 'u1' }, 'first prompt');
    mk('msg msg-assistant', { uuids: 'a1 a2 a3' });
    mk('cp-turn-footer');
    const second = mk('msg msg-user', { uuid: 'u2' }, 'second prompt');
    mk('msg msg-assistant', { uuids: 'b1' });
    const status = mk('msg-status');

    assert.equal(entryBefore(second), 'a3', 'the last entry of the reply before it');
    assert.equal(entryBefore(first), '', 'nothing precedes the first prompt: no rewind, no fork up to here');
    const third = mk('msg msg-user', { uuid: 'u3' }, 'third');
    $msgs.insertBefore(third, status);
    $msgs.children[4].dataset.uuids = ''; // a reply whose uuids were never stamped
    assert.equal(entryBefore(third), 'u2', 'falls back to the previous prompt');
    assert.equal(promptText(second), 'second prompt', 'attachment chips are not part of the prompt');
    assert.equal(removeFrom(second), 4);
    assert.deepEqual($msgs.children.map(c => c.className), ['msg msg-user', 'msg msg-assistant', 'cp-turn-footer']);
  } finally { dom.restore(); }
});

// ── Server and panel wiring (source contracts) ──

const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const panel = (await readFile(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('the routes exist; delete needs an explicit confirm and a session nobody is using', () => {
  for (const route of [
    "app.post('/api/claude-code/sessions/:sessionId/title'",
    "app.put('/api/claude-code/sessions/:sessionId/tag'",
    "app.post('/api/claude-code/sessions/:sessionId/fork'",
    "app.delete('/api/claude-code/sessions/:sessionId'",
    "app.get('/api/claude-code/sessions/:sessionId/subagents/:agentId/messages'",
  ]) assert.ok(server.includes(route), route);
  assert.match(server, /if \(req\.body\?\.confirm !== true\) \{ const e = new Error\('Deleting a session needs confirm: true'\); e\.status = 400; throw e; \}/);
  assert.match(server, /_claudeBridge\?\.isSessionLive\?\.\(sessionId\)/);
  assert.match(server, /Date\.now\(\) - lock\.lastHeartbeat <= SESSION_LOCK_STALE_MS/);
});

test('the panel: only manual renames write a title; delete is armed first; rewind and fork use the entry before the prompt', () => {
  assert.equal(panel.match(/writeSessionTitle\(/g).length, 3, 'the three places a user types a name');
  const autoTitle = panel.slice(panel.indexOf('requestGeneratedSessionTitle('), panel.indexOf('requestGeneratedSessionTitle(') + 1500);
  assert.doesNotMatch(autoTitle, /writeSessionTitle/, 'a generated title stays local');
  assert.match(panel, /if \(!delBtn\.classList\.contains\('cp-sess-delete-armed'\)\) \{/);
  assert.match(panel, /if \(_tabs\.some\(t => t\.sessionId === s\.sessionId\)\)/);
  assert.match(panel, /type: 'rewind_conversation', messageUuid: before, userMessageUuid: uuid/);
  // Fork names the prompt; the server reads the transcript for where the copy ends (review R06).
  assert.match(panel, /forkClaudeSession\(tab\.sessionId, \{ beforeMessageId: uuid, upToMessageId: before, title, project: tab\.project \}\)/);
  assert.match(panel, /hasCapability\(tab, 'session_title'\) && !tab\.sessionId && tab\.pendingLabel\) msg\.title = tab\.pendingLabel/);
});

// ── Review R06: "fork from here" ends where the transcript says the prompt begins ──

test('R06: fork before a prompt takes its end point from the transcript chain', async () => {
  const PROMPT = '22222222-2222-4222-8222-222222222222';
  const CARRIER = '33333333-3333-4333-8333-333333333333';
  const GUESS = '44444444-4444-4444-8444-444444444444';
  const calls = [];
  const sdk = { forkSession: async (...a) => { calls.push(a); return { sessionId: 'new-session-id' }; } };
  const asked = [];
  const mk = (parentOf) => createSessionOps({ sdk, projects: () => [{ path: '/repo/app' }], parentOf });

  // The transcript knows: its answer wins over what the page guessed from its rows.
  const ops = mk(async (...a) => { asked.push(a); return CARRIER; });
  await ops.fork(SID, { beforeMessageId: PROMPT, upToMessageId: GUESS, project: '/repo/app' });
  assert.deepEqual(asked[0], [SID, PROMPT, '/repo/app']);
  assert.deepEqual(calls[0], [SID, { dir: '/repo/app', upToMessageId: CARRIER }]);

  // The first prompt of a conversation has nothing before it.
  await assert.rejects(() => mk(async () => '').fork(SID, { beforeMessageId: PROMPT, upToMessageId: GUESS }), (e) => e.status === 400 && /Nothing comes before/.test(e.message));
  // The transcript cannot say (not found, lookup failed): the fork is refused.
  // (Review 2, V06: the page's value, an earlier rendered row, used to stand in
  // here and cut the retained turn short. tests/claude-review2-server.test.mjs.)
  await assert.rejects(() => mk(async () => null).fork(SID, { beforeMessageId: PROMPT, upToMessageId: GUESS }), (e) => e.status === 409);
  await assert.rejects(() => mk(async () => { throw new Error('EACCES'); }).fork(SID, { beforeMessageId: PROMPT, upToMessageId: GUESS }), (e) => e.status === 409);
  await assert.rejects(() => mk(async () => null).fork(SID, { beforeMessageId: PROMPT }), (e) => e.status === 409);
  await assert.rejects(() => mk(async () => CARRIER).fork(SID, { beforeMessageId: '../x' }), (e) => e.status === 400);
  await assert.rejects(() => mk(async () => 'not-a-uuid').fork(SID, { beforeMessageId: PROMPT }), (e) => e.status === 500);
  assert.equal(calls.length, 1);
});
