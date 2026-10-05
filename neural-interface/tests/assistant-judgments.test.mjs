import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createJudgmentReader, judgmentDbPath } from '../lib/assistant-judgments.js';
import { createUsageLedger } from '../lib/assistant-usage.js';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

/** A temp memory database holding only the judgment log (the v5 + v7 columns the reader touches). */
function tempLog(t, rows = []) {
  const dir = mkdtempSync(resolve(tmpdir(), 'synabun-assistant-judgments-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = resolve(dir, 'memory.db');
  const db = new DatabaseSync(path);
  t.after(() => { try { db.close(); } catch {} });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE typesafe_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, surface TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'live',
      input_tokens INTEGER, output_tokens INTEGER, cached INTEGER DEFAULT 0, error TEXT, session_id TEXT
    );
    CREATE INDEX idx_typesafe_log_session ON typesafe_log(session_id, id) WHERE session_id IS NOT NULL;
  `);
  const insert = db.prepare('INSERT INTO typesafe_log(created_at, surface, session_id, input_tokens, output_tokens, cached, error) VALUES(?, ?, ?, ?, ?, ?, ?)');
  const add = (row) => insert.run(row.at, row.surface || 'rerank', row.session ?? null, row.input ?? 0, row.output ?? 0, row.cached ?? 0, row.error ?? null);
  for (const row of rows) add(row);
  return { dir, path, db, add };
}

test('the database path: the live handle\'s file, else SQLITE_DB_PATH while its folder exists, else the default', (t) => {
  const { dir, path, db } = tempLog(t);
  assert.equal(judgmentDbPath({ getDb: () => db, env: { SQLITE_DB_PATH: '/elsewhere/memory.db' }, defaultPath: '/default/memory.db' }), db.prepare('PRAGMA database_list').all()[0].file);
  assert.match(judgmentDbPath({ getDb: () => db, defaultPath: '/default/memory.db' }), /memory\.db$/);
  // No live handle (or one that throws): the configured path, the way getDbPath resolves it.
  const configured = resolve(dir, 'configured.db');
  assert.equal(judgmentDbPath({ getDb: () => { throw new Error('closed'); }, env: { SQLITE_DB_PATH: configured }, defaultPath: path }), configured);
  assert.equal(judgmentDbPath({ env: { SQLITE_DB_PATH: configured }, defaultPath: path }), configured);
  assert.equal(judgmentDbPath({ env: { SQLITE_DB_PATH: resolve(dir, 'missing-folder', 'memory.db') }, defaultPath: path }), path, 'a path from another machine falls back');
  assert.equal(judgmentDbPath({ env: {}, defaultPath: path }), path);
  assert.equal(judgmentDbPath({ env: {} }), '');
});

test('sums the real calls of the session, its runs and their provider sessions inside the task window', (t) => {
  const { path } = tempLog(t, [
    { at: at(10), session: 'assistant-1', input: 100, output: 1 },   // the brain's own judgment
    { at: at(20), session: 'run-1', input: 200, output: 2 },         // a worker, by run id
    { at: at(30), session: 'provider-1', input: 400, output: 4 },    // the same worker, by its provider session
    { at: at(40), session: 'assistant-1', input: 9000, output: 90, cached: 1 },          // a cache hit cost nothing
    { at: at(50), session: 'assistant-1', input: 7000, output: 0, error: 'timeout' },    // a failed call returned nothing
    { at: at(60), session: 'assistant-2', input: 5000, output: 50 }, // another session
    { at: at(70), session: 'run-2', input: 3000, output: 30 },       // a run of another task
    { at: at(-5), session: 'assistant-1', input: 800, output: 8 },   // before the task began
    { at: at(100), session: 'assistant-1', input: 1600, output: 16 }, // at the next task's start: not this one's
    { at: at(15), session: null, input: 6000, output: 60 },          // no session at all
  ]);
  const asked = [];
  // An open window (the current task) ends at the reader's clock.
  const read = createJudgmentReader({ dbPath: () => path, now: () => T0 + 200_000, runInfo: (runId) => { asked.push(runId); return runId === 'run-1' ? { providerSessionId: 'provider-1' } : null; } });
  assert.deepEqual(read({ sessionId: 'assistant-1', taskId: 'task-1', runIds: ['run-1'], sinceMs: T0, untilMs: T0 + 100_000 }), { input: 700, output: 7, calls: 3, costUsd: 0 }, 'the first read is the real answer, not null');
  assert.deepEqual(asked, ['run-1']);
  // The next task's window starts where this one ended.
  assert.deepEqual(read({ sessionId: 'assistant-1', taskId: 'task-2', runIds: ['run-2'], sinceMs: T0 + 100_000, untilMs: null }), { input: 1600, output: 16, calls: 1, costUsd: 0 });
  assert.deepEqual(read({ sessionId: 'assistant-9', taskId: 'task-1', runIds: [], sinceMs: 0, untilMs: null }), { input: 0, output: 0, calls: 0, costUsd: 0 });
  assert.equal(read({ sessionId: null, taskId: 'task-1', runIds: [], sinceMs: 0, untilMs: null }), null, 'nothing to look up');
});

test('one answer per task is kept for 5 s; a changed window or run list reads again', (t) => {
  const { path, add } = tempLog(t, [{ at: at(10), session: 'assistant-1', input: 10, output: 1 }]);
  let clock = T0 + 20_000;
  let opened = 0;
  const read = createJudgmentReader({ dbPath: () => { opened += 1; return path; }, now: () => clock });
  const task = { sessionId: 'assistant-1', taskId: 'task-1', runIds: [], sinceMs: T0, untilMs: null };
  assert.deepEqual(read(task), { input: 10, output: 1, calls: 1, costUsd: 0 });
  add({ at: at(15), session: 'assistant-1', input: 5, output: 0 });
  add({ at: at(16), session: 'run-1', input: 3, output: 0 });
  clock += 4000;
  assert.deepEqual(read(task), { input: 10, output: 1, calls: 1, costUsd: 0 }, 'inside the 5 s window: no second read');
  assert.equal(opened, 1);
  assert.deepEqual(read({ ...task, runIds: ['run-1'] }), { input: 18, output: 1, calls: 3, costUsd: 0 }, 'a new run of the task is asked for at once');
  assert.deepEqual(read({ ...task, taskId: 'task-2' }), { input: 15, output: 1, calls: 2, costUsd: 0 }, 'another task has its own answer');
  assert.equal(opened, 3);
  clock += 5000;
  assert.deepEqual(read(task), { input: 15, output: 1, calls: 2, costUsd: 0 }, 'after 5 s it reads again');
  assert.equal(opened, 4);
});

test('never throws and never writes: a missing file, a missing table and a throwing dependency answer null, logged once', (t) => {
  const { dir, path, db } = tempLog(t, [{ at: at(10), session: 'assistant-1', input: 10, output: 1 }]);
  const task = (taskId) => ({ sessionId: 'assistant-1', taskId, runIds: ['run-1'], sinceMs: T0, untilMs: T0 + 60_000 });
  const log = [];
  const missing = createJudgmentReader({ dbPath: () => resolve(dir, 'nowhere', 'memory.db'), log: (tag, message) => log.push([tag, message]) });
  assert.equal(missing(task('task-1')), null);
  assert.equal(missing(task('task-2')), null);
  assert.equal(log.length, 1, 'the failure is logged once');
  assert.equal(log[0][0], 'assistant:judgments-error');
  assert.equal(createJudgmentReader({ dbPath: () => { throw new Error('no path'); } })(task('task-1')), null);
  assert.equal(createJudgmentReader({ dbPath: () => '' })(task('task-1')), null);
  assert.equal(createJudgmentReader({ dbPath: () => path, log: () => { throw new Error('log broke'); } })(), null, 'no arguments, and a log that throws');
  // A dispatcher lookup that throws only loses that run's provider session.
  assert.deepEqual(createJudgmentReader({ dbPath: () => path, runInfo: () => { throw new Error('dispatcher gone'); } })(task('task-1')), { input: 10, output: 1, calls: 1, costUsd: 0 });
  db.exec('DROP TABLE typesafe_log');
  assert.equal(createJudgmentReader({ dbPath: () => path })(task('task-1')), null, 'a database without the log');
  // The handle is read-only: nothing was created next to the missing path.
  assert.throws(() => new DatabaseSync(resolve(dir, 'nowhere', 'memory.db'), { readOnly: true }));
});

test('the ledger shows a closed task its real Jev row on the first read', (t) => {
  const { dir, path } = tempLog(t);
  let clock = T0;
  const ledger = createUsageLedger({ dataDir: dir, now: () => clock, judgments: createJudgmentReader({ dbPath: () => path, now: () => clock }) });
  ledger.beginTask('assistant-1', { title: 'First', at: clock });
  ledger.settle({ sessionId: 'assistant-1', scope: 'brain', provider: 'claude-code', model: 'claude-test', tokens: { input: 50 } });
  const db = new DatabaseSync(path);
  t.after(() => { try { db.close(); } catch {} });
  db.prepare('INSERT INTO typesafe_log(created_at, surface, session_id, input_tokens, output_tokens, cached, error) VALUES(?, ?, ?, ?, ?, 0, NULL)').run(at(5), 'prompt-urgency', 'assistant-1', 120, 3);
  clock = T0 + 60_000;
  ledger.beginTask('assistant-1', { title: 'Second', at: clock });
  // task-1 is closed now: whatever the ledger reads first is what it keeps.
  const jev = ledger.taskView('assistant-1', 'task-1').task.agents.find((agent) => agent.key === 'judgments');
  assert.ok(jev, 'the first read already has the judgments');
  assert.equal(jev.calls, 1);
  assert.equal(jev.tokens.total, 123);
  assert.equal(ledger.taskView('assistant-1', 'task-2').task.agents.some((agent) => agent.key === 'judgments'), false);
});

test('Jev tokens in dollars: the configured rates, read on every answer; no rates, no dollars', (t) => {
  const { path } = tempLog(t, [{ at: at(10), session: 'assistant-1', input: 1_000_000, output: 2000 }]);
  let rate = { input: 0.042, output: 0 };
  let clock = T0 + 20_000;
  const read = createJudgmentReader({ dbPath: () => path, rates: () => rate, now: () => clock });
  const task = { sessionId: 'assistant-1', taskId: 'task-1', runIds: [], sinceMs: T0, untilMs: null };
  assert.deepEqual(read(task), { input: 1_000_000, output: 2000, calls: 1, costUsd: 0.042 }, '$0.042 per million input tokens, output free');
  rate = { input: 0.05, output: 1 };
  clock += 6000; // past the 5 s answer: the knob is read again
  assert.equal(read(task).costUsd, 0.052);
  assert.equal(createJudgmentReader({ dbPath: () => path, rates: () => { throw new Error('config gone'); } })(task).costUsd, 0, 'a failing knob never fails the count');
  // The ledger carries it into the task, the model row and the session.
  const dir = mkdtempSync(resolve(tmpdir(), 'synabun-assistant-jev-cost-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = createUsageLedger({ dataDir: dir, now: () => T0 + 30_000, judgments: createJudgmentReader({ dbPath: () => path, rates: () => ({ input: 0.042, output: 0 }) }) });
  ledger.beginTask('assistant-1', { at: T0 });
  const view = ledger.taskView('assistant-1');
  assert.deepEqual([view.task.costUsd, view.session.costUsd, view.session.tokens.inputTotal, view.session.tokens.outputTotal], [0.042, 0.042, 1_000_000, 2000]);
  assert.deepEqual(view.session.models, [{ provider: 'jev', model: 'jev', tokens: { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 2000, reasoning: 0, total: 1_002_000, inputTotal: 1_000_000, outputTotal: 2000 }, costUsd: 0.042, costBasis: 'estimated' }]);
});
