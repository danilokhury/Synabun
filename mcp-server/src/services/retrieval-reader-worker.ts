/**
 * The retrieval reader's thread (retrieval-reader.ts): one SQLite connection of its own that only reads, so recall's
 * full-text searches and id lists never run on the thread that called them. In WAL mode a reader never waits for the
 * writer and sees every committed transaction as each statement starts.
 *
 * Self-contained on purpose (node: modules only): under the test runner the TypeScript file itself is started.
 * Only erasable TypeScript syntax here.
 */
import { parentPort } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';

interface ReadRequest { id: number; sql?: string; params?: SQLInputValue[]; path?: string; generation?: number; close?: boolean }

// The connection is closed after this long without a request, so an idle reader never keeps a database file that a
// restore or a move replaces (the session-cache worker does the same per job).
const IDLE_CLOSE_MS = 5_000;
const STATEMENTS = 64;
let db: DatabaseSync | null = null;
let openKey = '';
let idle: ReturnType<typeof setTimeout> | undefined;
const statements = new Map<string, StatementSync>();

function close(): void {
  statements.clear();
  try { db?.close(); } catch { /* already closed */ }
  db = null;
  openKey = '';
}

function connection(path: string, generation: number): DatabaseSync {
  const key = `${generation}\0${path}`;
  if (db && openKey === key) return db;
  close();
  // Never create a database: the caller's own connection made this file.
  if (!existsSync(path)) throw Object.assign(new Error(`No database at ${path}`), { reader: true });
  const next = new DatabaseSync(path);
  try {
    next.exec('PRAGMA busy_timeout = 5000');
    next.exec('PRAGMA query_only = ON');
  } catch (error) { next.close(); throw error; }
  db = next;
  openKey = key;
  return next;
}

parentPort?.on('message', (request: ReadRequest) => {
  clearTimeout(idle);
  if (request.close) { close(); return; }
  try {
    const d = connection(String(request.path), Number(request.generation));
    let statement = statements.get(request.sql!);
    if (!statement) {
      statement = d.prepare(request.sql!);
      statements.set(request.sql!, statement);
      if (statements.size > STATEMENTS) statements.delete(statements.keys().next().value!);
    }
    parentPort!.postMessage({ id: request.id, rows: statement.all(...(request.params ?? [])) });
  } catch (error) {
    const e = error as Error & { reader?: boolean; errcode?: number; code?: string };
    // `reader`: this thread could not serve the read at all (the caller reads on its own connection instead);
    // otherwise SQLite refused the statement and the caller sees that error, as from its own connection.
    parentPort!.postMessage({ id: request.id, error: { message: e.message, reader: !!e.reader || e.message?.includes('database is locked') || false, errcode: e.errcode, code: e.code } });
  }
  idle = setTimeout(close, IDLE_CLOSE_MS);
  idle.unref?.();
});
