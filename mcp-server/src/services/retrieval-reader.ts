/**
 * Recall's reads that cannot be sliced, off the calling thread.
 *
 * The MCP endpoint runs inside the Neural Interface, so every recall of an Assistant brain, a hook or a Claude Code
 * session ran its full-text searches on the server's event loop. One FTS5 statement over 149k session chunks or 35k
 * memories (MATCH with OR'ed terms, ordered by bm25) cannot yield: 40-90 ms warm, 0.3-1.4 s cold or after a capture
 * (docs/startup-freeze-and-agents-audit.md → Third pass). readRows() runs such a SELECT on a worker thread with its
 * own read-only connection (retrieval-reader-worker.ts) and resolves with exactly the rows the caller's connection
 * would have returned, in the same order.
 *
 * When the worker cannot answer (no worker for an in-memory store, SYNABUN_RETRIEVAL_READER=off, a worker that
 * failed, exited or did not answer in time), the same statement runs on the caller's connection, as before: recall
 * never fails because of this module. A failed worker is replaced on a later read, after 1 s, then 5 s, then 30 s.
 */
import { Worker } from 'node:worker_threads';
import type { SQLInputValue } from 'node:sqlite';
import { getDb, getDbPath, onDatabaseClose } from './sqlite.js';

type Row = Record<string, any>;
interface Pending { resolve: (rows: Row[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_AFTER_MS = [1_000, 5_000, 30_000];

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let seenConnection: object | null = null;
let generation = 0;
let failures = 0;
let retryAt = 0;

/** What the reader did since the process started (diagnostics and tests). */
export const retrievalReaderStats = { worker: 0, fallback: 0, failures: 0, started: 0, lastError: '' };

/** Why a read ran on the caller's connection instead: the worker could not serve it (never SQLite refusing the statement). */
class ReaderUnavailable extends Error {}

function workerUrl(): URL {
  // The test runner loads this module from src/: the worker is then the TypeScript file, which Node runs as it is.
  return new URL(import.meta.url.endsWith('.ts') ? './retrieval-reader-worker.ts' : './retrieval-reader-worker.js', import.meta.url);
}

function fail(failed: Worker, error: Error): void {
  if (worker !== failed) return;
  worker = null;
  failures++;
  retrievalReaderStats.failures++;
  retrievalReaderStats.lastError = error.message;
  retryAt = Date.now() + RETRY_AFTER_MS[Math.min(failures, RETRY_AFTER_MS.length) - 1];
  for (const [id, request] of pending) { clearTimeout(request.timer); pending.delete(id); request.reject(new ReaderUnavailable(error.message)); }
  void failed.terminate().catch(() => {});
}

function start(): Worker {
  const spawned = new Worker(workerUrl(), { execArgv: process.execArgv.filter(arg => arg === '--experimental-sqlite') });
  spawned.unref();
  retrievalReaderStats.started++;
  spawned.on('message', (message: { id: number; rows?: Row[]; error?: { message: string; reader: boolean; errcode?: number; code?: string } }) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (!pending.size) spawned.unref();
    if (!message.error) { failures = 0; request.resolve(message.rows ?? []); return; }
    const { message: text, reader, errcode, code } = message.error;
    request.reject(reader ? new ReaderUnavailable(text) : Object.assign(new Error(text), { errcode, code }));
  });
  spawned.on('error', error => fail(spawned, error));
  spawned.on('exit', code => fail(spawned, new Error(`retrieval reader exited (${code})`)));
  return spawned;
}

function ask(sql: string, params: SQLInputValue[], path: string): Promise<Row[]> {
  if (!worker) worker = start();
  const target = worker;
  const id = nextId++;
  return new Promise<Row[]>((resolve, reject) => {
    const timer = setTimeout(() => fail(target, new Error(`retrieval reader did not answer in ${REQUEST_TIMEOUT_MS} ms`)), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    target.ref();
    try { target.postMessage({ id, sql, params, path, generation }); }
    catch (error) { fail(target, error as Error); }
  });
}

/**
 * All rows of one read-only statement, read on the retrieval reader's thread; the caller's connection when it cannot.
 * A statement SQLite refuses rejects with SQLite's error, as `getDb().prepare(sql).all()` would throw it.
 */
export async function readRows(sql: string, params: SQLInputValue[] = []): Promise<Row[]> {
  const d = getDb();
  // Another connection object means the database was closed and opened again (a restore, a move, a test's store):
  // the reader opens it again too.
  if (d !== seenConnection) { seenConnection = d; generation++; }
  const path = getDbPath();
  if (process.env.SYNABUN_RETRIEVAL_READER !== 'off' && path !== ':memory:' && Date.now() >= retryAt) {
    try {
      const rows = await ask(sql, params, path);
      retrievalReaderStats.worker++;
      return rows;
    } catch (error) {
      if (!(error instanceof ReaderUnavailable)) throw error;
      retrievalReaderStats.lastError = error.message;
    }
  }
  retrievalReaderStats.fallback++;
  return getDb().prepare(sql).all(...params) as Row[];
}

/** Close the reader's connection now (the caller's database was closed). The thread stays for the next read. */
export function releaseRetrievalReader(): void {
  seenConnection = null;
  try { worker?.postMessage({ close: true }); } catch { /* the worker is gone already */ }
}

/** End the reader's thread (tests, shutdown). A later read starts a new one. */
export async function closeRetrievalReader(): Promise<void> {
  const current = worker;
  worker = null;
  failures = 0;
  retryAt = 0;
  for (const [id, request] of pending) { clearTimeout(request.timer); pending.delete(id); request.reject(new ReaderUnavailable('retrieval reader closed')); }
  if (current) await current.terminate().catch(() => {});
}

/** The worker in use, for tests that make it fail. */
export function retrievalReaderWorker(): Worker | null { return worker; }

onDatabaseClose(releaseRetrievalReader);
