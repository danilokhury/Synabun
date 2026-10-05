// Deleting a session also drops what SynaBun keeps about it (review 1, "not reviewed").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatabaseSync } from 'node:sqlite';
import { createSessionCleanup, dropSessionCost, deleteSessionRows } from '../lib/claude-session-cleanup.js';
import { createSessionOps } from '../lib/claude-session-ops.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(HERE, '..', 'server.js'), 'utf8');
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('every record is dropped, and one failing step does not stop the others', () => {
  const calls = [];
  const logs = [];
  const cleanup = createSessionCleanup({
    steps: {
      cost: (id) => calls.push(['cost', id]),
      chunks: () => { throw new Error('database is locked'); },
      snapshot: (id) => calls.push(['snapshot', id]),
      notAFunction: 'x',
    },
    log: (m) => logs.push(m),
  });
  assert.deepEqual(cleanup(ID), { cost: 'ok', chunks: 'failed: database is locked', snapshot: 'ok' });
  assert.deepEqual(calls, [['cost', ID], ['snapshot', ID]]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /chunks/);
  // Anything that is not a session id touches nothing.
  assert.deepEqual(cleanup('../../x'), {});
  assert.deepEqual(cleanup(undefined), {});
  assert.equal(calls.length, 2);
});

test('the cost row goes, the month totals stay', () => {
  const data = { months: { '2026-10': { totalUsd: 3.5, sessions: [ID] } }, sessionCosts: { [ID]: 1.25, other: 2 } };
  assert.equal(dropSessionCost(data, ID), true);
  assert.deepEqual(data.sessionCosts, { other: 2 });
  assert.equal(data.months['2026-10'].totalUsd, 3.5);
  assert.equal(dropSessionCost(data, ID), false);
  assert.equal(dropSessionCost({}, ID), false);
});

test('the rows of one session go; other sessions, other providers and memories stay', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE session_chunks (id TEXT PRIMARY KEY, session_id TEXT, content TEXT);
    CREATE TABLE session_cache (session_id TEXT NOT NULL, provider TEXT NOT NULL, first_prompt TEXT);
    CREATE VIRTUAL TABLE session_fts USING fts5(session_id UNINDEXED, provider UNINDEXED, body);
    CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT);`);
  const OTHER = '11111111-2222-3333-4444-555555555555';
  db.prepare('INSERT INTO session_chunks VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)').run('c1', ID, 'a', 'c2', ID, 'b', 'c3', OTHER, 'c');
  db.prepare('INSERT INTO session_cache VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)').run(ID, 'claude-code', 'p', ID, 'codex', 'p', OTHER, 'claude-code', 'p');
  db.prepare('INSERT INTO session_fts VALUES (?, ?, ?), (?, ?, ?)').run(ID, 'claude-code', 'body', OTHER, 'claude-code', 'body');
  db.prepare('INSERT INTO memories VALUES (?, ?)').run('m1', 'kept');
  assert.deepEqual(deleteSessionRows(db, ID, 'claude-code'), { chunks: 2, cache: 1, fts: 1 });
  const count = (sql) => db.prepare(sql).get().n;
  assert.equal(count('SELECT COUNT(*) n FROM session_chunks'), 1);
  assert.equal(count('SELECT COUNT(*) n FROM session_cache'), 2, 'the other provider and the other session stay');
  assert.equal(count('SELECT COUNT(*) n FROM session_fts'), 1);
  assert.equal(count('SELECT COUNT(*) n FROM memories'), 1);
  assert.deepEqual(deleteSessionRows(db, "x' OR 1=1 --", 'claude-code'), { chunks: 0, cache: 0, fts: 0 });
  assert.equal(count('SELECT COUNT(*) n FROM session_chunks'), 1);
  // A store without the tables is not an error.
  assert.deepEqual(deleteSessionRows(new DatabaseSync(':memory:'), ID, 'claude-code'), { chunks: 0, cache: 0, fts: 0 });
  db.close();
});

test('delete runs the cleanup after the SDK removed the transcript, and only then', async () => {
  const order = [];
  const sdk = { deleteSession: async (id) => { order.push(['sdk', id]); } };
  const ops = createSessionOps({ sdk, projects: () => [], afterDelete: (id) => order.push(['cleanup', id]) });
  await ops.remove(ID);
  assert.deepEqual(order, [['sdk', ID], ['cleanup', ID]]);

  // A delete the SDK refused leaves SynaBun's records alone.
  const failing = createSessionOps({ sdk: { deleteSession: async () => { throw new Error('ENOENT'); } }, projects: () => [], afterDelete: () => order.push(['cleanup-after-failure']) });
  await assert.rejects(() => failing.remove(ID), /ENOENT/);
  // A busy session is not deleted and not cleaned.
  const busy = createSessionOps({ sdk, projects: () => [], isBusy: () => 'open in a tab', afterDelete: () => order.push(['cleanup-while-busy']) });
  await assert.rejects(() => busy.remove(ID), /open in a tab/);
  assert.equal(order.length, 2);
});

test('server.js wires the hook with the four records', () => {
  const block = /const claudeSessionCleanup = createSessionCleanup\(\{[\s\S]*?\n\}\);/.exec(server)?.[0] || '';
  assert.ok(block, 'the cleanup is built in server.js');
  for (const step of ['cost:', 'chunks:', 'listCache:', 'snapshot:']) assert.ok(block.includes(step), `${step} step`);
  assert.match(block, /dropSessionCost\(/);
  assert.match(block, /deleteSessionRows\(getDb\(\), sessionId, 'claude-code'\)/);
  assert.match(block, /blobDelete\('claude-snapshots', sessionId\)/);
  const opsBlock = /const claudeSessionOps = createSessionOps\(\{[\s\S]*?\n\}\);/.exec(server)?.[0] || '';
  assert.match(opsBlock, /afterDelete: \(sessionId\) => claudeSessionCleanup\(sessionId\),/);
});
