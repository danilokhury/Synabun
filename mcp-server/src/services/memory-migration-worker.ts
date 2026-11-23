/**
 * The thread a server migrates its memory store on (started by sqlite.ts ensureDatabase, never imported).
 *
 * The safety copy of a large store takes tens of seconds of synchronous SQLite work. On the thread that speaks MCP
 * that is longer than clients wait for `initialize`, and they stop a server that does not answer. Here it holds no
 * one up: this thread opens its own connection, sets it up exactly as getDb() does (`setup`, handed over by
 * sqlite.ts so there is one list), and runs the same migrateMemory() a script would run in place.
 *
 * The outcome goes back on `port`, and only then is `flags` set: [1] when this thread runs, [0] when it is done,
 * whatever the outcome. `flags` is shared with the starting thread, which may be waiting on it without an event loop
 * (a synchronous getDb() during the migration) and then reads the outcome out of the port in place. An error is
 * reported, never thrown: the starting thread goes by what the migration answered (sqlite.ts upgradeVerdict), and
 * for anything else opens the store the ordinary way and meets the same condition itself.
 */
import { workerData, type MessagePort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

interface Job { dbPath: string; setup: string[]; flags: SharedArrayBuffer; port: MessagePort }
type Outcome = { ok: true; applied: number[]; backup: string | null; deferred?: { versions: number[]; reason: string } }
  | { ok: false; error: { message: string; code?: string } };

const job = workerData as Job;
const flags = new Int32Array(job.flags);
Atomics.store(flags, 1, 1);

let outcome: Outcome;
try {
  // The test runner loads these modules from src/, where the worker is the TypeScript file and Node runs it as it
  // is; the './x.js' its modules import is then './x.ts'. A build has only .js files and none of this runs.
  const fromSource = import.meta.url.endsWith('.ts');
  if (fromSource) {
    const { registerHooks } = await import('node:module') as unknown as { registerHooks?: (hooks: { resolve: (specifier: string, context: unknown, next: (specifier: string, context: unknown) => unknown) => unknown }) => void };
    registerHooks?.({
      resolve(specifier, context, next) {
        if (/^\.{1,2}\//.test(specifier) && specifier.endsWith('.js')) {
          try { return next(`${specifier.slice(0, -3)}.ts`, context); } catch { /* a real .js file */ }
        }
        return next(specifier, context);
      },
    });
  }
  const { migrateMemory } = await import(new URL(fromSource ? './memory-schema.ts' : './memory-schema.js', import.meta.url).href) as typeof import('./memory-schema.js');
  const d = new DatabaseSync(job.dbPath);
  try {
    for (const sql of job.setup) d.exec(sql);
    outcome = { ok: true, ...migrateMemory(d, job.dbPath) };
  } finally { d.close(); }
} catch (error) {
  outcome = { ok: false, error: { message: error instanceof Error ? error.message : String(error), code: (error as { code?: string })?.code } };
}
try { job.port.postMessage(outcome); }
finally {
  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
}
