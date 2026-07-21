import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  clearOpenCodeHistory,
  clearOpenCodeHistoryInWorker,
  getOpenCodeHistoryStats,
  OPENCODE_HISTORY_CONFIRMATION,
} from '../lib/opencode-history.js';

const here = dirname(fileURLToPath(import.meta.url));
const neuralRoot = resolve(here, '..');

function createFixture() {
  const cleanupRoot = mkdtempSync(join(tmpdir(), 'synabun-opencode-history-'));
  const dataRoot = join(cleanupRoot, 'opencode');
  mkdirSync(dataRoot, { recursive: true });
  const dbPath = join(dataRoot, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      body TEXT
    );
    CREATE TABLE todo (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE session_share (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE event_sequence (id INTEGER PRIMARY KEY, aggregate_id TEXT);
    CREATE TABLE event (
      id INTEGER PRIMARY KEY,
      sequence_id INTEGER REFERENCES event_sequence(id) ON DELETE CASCADE,
      aggregate_id TEXT,
      payload TEXT
    );

    INSERT INTO account VALUES ('acct-1', 'user@example.test');
    INSERT INTO project VALUES ('project-1', '/tmp/example');
    INSERT INTO credential VALUES ('provider-1', 'encrypted-secret');
    INSERT INTO session VALUES ('ses_1', 'project-1'), ('ses_2', 'project-1');
    INSERT INTO message VALUES ('msg_1', 'ses_1'), ('msg_2', 'ses_2');
    INSERT INTO part VALUES ('part_1', 'msg_1', 'hello'), ('part_2', 'msg_2', 'world');
    INSERT INTO todo VALUES ('todo_1', 'ses_1');
    INSERT INTO session_share VALUES ('share_1', 'ses_2');
    INSERT INTO event_sequence VALUES (1, 'ses_1'), (2, 'ses_2');
    INSERT INTO event VALUES (1, 1, 'ses_1', '{}'), (2, 2, 'ses_2', '{}');
  `);
  db.close();

  const artifactFiles = [
    ['snapshot', 'snapshot.bin'],
    ['repos', 'repo.pack'],
    ['storage/session_diff', 'ses_1.json'],
    ['tool-output', 'tool.txt'],
  ];
  for (const [relativeDir, name] of artifactFiles) {
    const dir = join(dataRoot, relativeDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `history:${name}`);
  }
  return { cleanupRoot, dataRoot, dbPath, artifactFiles };
}

function verifyClearedAndPreserved(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  for (const table of ['session', 'message', 'part', 'todo', 'session_share', 'event', 'event_sequence']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count, 0, `${table} should be empty`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM credential').get().count, 1);
  assert.equal(db.prepare('SELECT value FROM credential WHERE id = ?').get('provider-1').value, 'encrypted-secret');
  db.close();

  for (const [relativeDir] of fixture.artifactFiles) {
    const path = join(fixture.dataRoot, relativeDir);
    assert.deepEqual(readDirNames(path), [], `${relativeDir} should remain present but empty`);
  }
}

function readDirNames(path) {
  return readdirSync(path);
}

test('clearOpenCodeHistory removes all history while retaining credentials and projects', () => {
  const fixture = createFixture();
  try {
    const before = getOpenCodeHistoryStats(fixture);
    assert.equal(before.sessions, 2);
    assert.ok(before.artifactBytes > 0);

    const result = clearOpenCodeHistory({ ...fixture, vacuum: false });
    assert.equal(result.sessionsDeleted, 2);
    assert.equal(result.messagesDeleted, 2);
    assert.equal(result.partsDeleted, 2);
    assert.equal(result.artifactEntriesDeleted, 4);
    assert.ok(result.artifactBytesDeleted > 0);
    assert.deepEqual(result.warnings, []);
    verifyClearedAndPreserved(fixture);

    const after = getOpenCodeHistoryStats(fixture);
    assert.equal(after.sessions, 0);
    assert.equal(after.artifactBytes, 0);
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test('worker entry point performs the same bounded history wipe', async () => {
  const fixture = createFixture();
  try {
    const result = await clearOpenCodeHistoryInWorker({
      dbPath: fixture.dbPath,
      dataRoot: fixture.dataRoot,
      vacuum: true,
    });
    assert.equal(result.sessionsDeleted, 2);
    assert.equal(result.vacuumed, true);
    verifyClearedAndPreserved(fixture);
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test('history clearing refuses a broad non-OpenCode data root', () => {
  const broadRoot = mkdtempSync(join(tmpdir(), 'synabun-opencode-unsafe-'));
  try {
    assert.throws(() => getOpenCodeHistoryStats({
      dbPath: join(broadRoot, 'opencode.db'),
      dataRoot: broadRoot,
    }), /not the OpenCode directory/);
  } finally {
    rmSync(broadRoot, { recursive: true, force: true });
  }
});

test('derived cache cleanup removes OpenCode rows without touching other providers', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-opencode-cache-'));
  const previousDbPath = process.env.SQLITE_DB_PATH;
  process.env.SQLITE_DB_PATH = join(root, 'memory.db');
  const {
    clearSessionCacheProvider,
    closeDb,
    getSessionCacheEntry,
    upsertSessionCache,
    upsertSessionFts,
  } = await import('../lib/db.js');
  t.after(() => {
    closeDb();
    if (previousDbPath === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = previousDbPath;
    rmSync(root, { recursive: true, force: true });
  });

  for (const provider of ['opencode', 'codex']) {
    upsertSessionCache({ session_id: `${provider}-session`, provider, first_prompt: provider });
    upsertSessionFts({ session_id: `${provider}-session`, provider, first_prompt: provider, body: 'history' });
  }
  assert.deepEqual(clearSessionCacheProvider('opencode'), { cached: 1, fts: 1 });
  assert.equal(getSessionCacheEntry('opencode-session', 'opencode'), null);
  assert.ok(getSessionCacheEntry('codex-session', 'codex'));
});

test('rendered snapshot cleanup is namespace-scoped', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-opencode-blobs-'));
  const {
    blobClearNamespace,
    blobGet,
    blobPut,
    closeBlobStore,
    initBlobStore,
  } = await import('../lib/ui-blob-store.js');
  initBlobStore(join(root, 'ui-blobs.db'));
  t.after(() => {
    closeBlobStore();
    rmSync(root, { recursive: true, force: true });
  });
  blobPut('ocp-snapshots', 'ses_1', { html: 'OpenCode' });
  blobPut('codex-snapshots', 'thread_1', { html: 'Codex' });
  assert.equal(blobClearNamespace('ocp-snapshots'), 1);
  assert.equal(blobGet('ocp-snapshots', 'ses_1'), null);
  assert.deepEqual(blobGet('codex-snapshots', 'thread_1'), { html: 'Codex' });
});

test('settings and API require the same explicit destructive confirmation', () => {
  assert.equal(OPENCODE_HISTORY_CONFIRMATION, 'DELETE OPENCODE HISTORY');
  const settingsSource = readFileSync(join(neuralRoot, 'public/shared/ui-settings.js'), 'utf8');
  const serverSource = readFileSync(join(neuralRoot, 'server.js'), 'utf8');
  assert.match(settingsSource, /Clear all OpenCode history/);
  assert.match(settingsSource, /This cannot be undone/);
  assert.match(settingsSource, /DELETE OPENCODE HISTORY/);
  assert.match(serverSource, /req\.body\?\.confirmation !== OPENCODE_HISTORY_CONFIRMATION/);
  assert.match(serverSource, /Stop all active OpenCode conversations and automations/);
});
