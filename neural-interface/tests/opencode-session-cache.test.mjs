import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

process.env.SYNABUN_TYPESAFE = 'off';

// Never the live store: every memory path points at a temp dir before any import.
const root = mkdtempSync(join(tmpdir(), 'synabun-opencode-cache-'));
process.env.SQLITE_DB_PATH = join(root, 'memory.db');
process.env.MEMORY_DATA_DIR = root;
process.env.SYNABUN_DATA_HOME = root;

function makeOpencodeDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT,
                          time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
  `);
  return db;
}

let seq = 0;
function addMessage(db, sessionId, role, text) {
  const mid = `msg-${++seq}`;
  db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(mid, sessionId, JSON.stringify({ role }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(`part-${seq}`, sessionId, mid, 1000 + seq, JSON.stringify({ type: 'text', text }));
}

test('the OpenCode session cache re-reads only sessions that changed', async (t) => {
  const { rebuildOpencodeCache } = await import('../lib/session-cache-builder.js');
  const { closeDb, getSessionCacheEntry } = await import('../lib/db.js');
  const oc = makeOpencodeDb(join(root, 'opencode.db'));
  t.after(() => {
    oc.close();
    closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  oc.prepare('INSERT INTO project VALUES (?, ?)').run('p1', join(root, 'project'));
  for (let s = 0; s < 3; s++) {
    oc.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, NULL)').run(`ses-${s}`, 'p1', `session ${s}`, join(root, 'project'), 100, 200 + s);
    addMessage(oc, `ses-${s}`, 'user', `question ${s}`);
    addMessage(oc, `ses-${s}`, 'assistant', `answer ${s}`);
  }
  const getOpencodeDb = () => oc;

  let r = rebuildOpencodeCache({ getOpencodeDb });
  assert.deepEqual([r.sessions, r.updated], [3, 3], 'first pass indexes everything');
  assert.equal(getSessionCacheEntry('ses-1', 'opencode').message_count, 2);

  r = rebuildOpencodeCache({ getOpencodeDb });
  assert.deepEqual([r.sessions, r.updated], [3, 0], 'an unchanged store re-reads nothing');

  addMessage(oc, 'ses-1', 'user', 'a follow-up');
  oc.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(900, 'ses-1');
  r = rebuildOpencodeCache({ getOpencodeDb });
  assert.deepEqual([r.sessions, r.updated], [3, 1], 'only the changed session is re-read');
  assert.equal(getSessionCacheEntry('ses-1', 'opencode').message_count, 3);
});
