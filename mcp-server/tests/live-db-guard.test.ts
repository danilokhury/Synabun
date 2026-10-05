import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { getDbPath, getDb, closeDatabase } from '../src/services/sqlite.js';

/**
 * The guard that should have existed on 2026-09-18.
 *
 * `tests/setup.ts` redirects SQLITE_DB_PATH at a temp dir, but it only runs
 * when a vitest config lists it under `setupFiles` — and it wasn't wired in.
 * `memory-v2.test.ts` opens with `DELETE FROM memories`, so the whole live
 * corpus went silently. A guard living inside setup.ts cannot help, because
 * setup.ts is the thing that didn't run; it has to sit in getDb().
 *
 * These tests assert the guard fires, not merely that it exists.
 */
describe('live database guard', () => {
  const original = process.env.SQLITE_DB_PATH;
  afterEach(() => {
    closeDatabase();
    if (original === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = original;
  });

  it('runs tests against a disposable database in the temp directory', () => {
    // If this fails, setupFiles is not wired in and nothing else here matters.
    expect(process.env.VITEST).toBeTruthy();
    expect(getDbPath().startsWith(os.tmpdir())).toBe(true);
  });

  it('accepts an explicit /tmp path, which is not under os.tmpdir() on macOS', () => {
    // os.tmpdir() is /var/folders/... on macOS. A guard that only compares
    // against it rejects the /tmp paths people actually type.
    const dir = fs.mkdtempSync('/tmp/synabun-guard-');
    try {
      process.env.SQLITE_DB_PATH = path.join(dir, 'memory.db');
      closeDatabase();
      expect(() => getDb()).not.toThrow();
      closeDatabase();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // A directory that exists and is not under a temp root. ~/.synabun would do on a
  // machine that runs SynaBun, but on a fresh checkout (CI) it is missing, and
  // getDbPath() answers a missing parent with the temp default, which the guard
  // rightly accepts. The package directory exists everywhere the suite runs.
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  const cwdIsTemp = [os.tmpdir(), '/tmp'].flatMap(r => [r, real(r)]).some(r => real(process.cwd()).startsWith(r));
  const outsideTemp = (run: (dbPath: string) => void) => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.guard-probe-'));
    try { run(path.join(dir, 'memory.db')); } finally { closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); }
  };

  it.skipIf(cwdIsTemp)('refuses to open a database outside the temp directory under vitest', () => {
    outsideTemp((dbPath) => {
      process.env.SQLITE_DB_PATH = dbPath;
      closeDatabase();
      expect(() => getDb()).toThrow(/Refusing to open/);
      expect(fs.existsSync(dbPath)).toBe(false);
    });
  });

  it.skipIf(cwdIsTemp)('names setupFiles and the silent parent-directory fallback in the error', () => {
    outsideTemp((dbPath) => {
      process.env.SQLITE_DB_PATH = dbPath;
      closeDatabase();
      // The message has to tell whoever hits it what to actually check.
      expect(() => getDb()).toThrow(/setupFiles/);
      expect(() => getDb()).toThrow(/parent is missing/);
    });
  });
});
