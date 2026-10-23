/**
 * The app's half of protecting the data before an update. The other half runs
 * on SynaBun's own Node, through the headless entry (`<entry> update-snapshot
 * --json`, lib/update-snapshot.js): it takes the pre-update snapshot, decides
 * whether one taken earlier still stands for the data, and hands it over to the
 * new version's first start.
 *
 *   prepare()  while SynaBun still runs and an update waits for its moment, the
 *              snapshot is taken in the background; later preparations (at most
 *              one per PREPARE_EVERY_MS) keep it when it is still exact and take
 *              a new one when it is not
 *   protect()  at the install, after the server stopped (no writer of the app is
 *              left): the prepared snapshot when it is still exact, a new one
 *              otherwise, then the handoff. Each step reaches `onProgress`
 *   discard()  a quit without an install: the app forgets it (the file stays
 *              for the backup retention)
 *
 * "Still exact" is never what this process saw: the snapshot records what it
 * was taken from (every database's fingerprint, every other file's content) and
 * the command compares the data home with it at the moment it decides, so a
 * memory saved by any process since (the server on its way out, an AI tool's
 * own MCP server) makes a new snapshot. The new version's first start checks
 * again before its server runs (lib/first-launch-protection.js): what is written
 * while the app swaps itself is caught there.
 *
 * Plain Node; the spawn is handed in, so this is tested without Electron or
 * SynaBun's runtime (packaging/tests/desktop-data-guard.test.mjs).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** At most one background preparation in this long: a database that keeps changing is not copied over and over. */
export const PREPARE_EVERY_MS = 10 * 60 * 1000;
/** The snapshot command may take this long (a very large data home on a slow disk). */
export const SNAPSHOT_TIMEOUT_MS = 30 * 60 * 1000;

/** A fresh id for one install attempt: the plan, the handoff and the new copy's start name the same one. */
export function newInstallId() {
  return randomBytes(9).toString('base64url');
}

/**
 * Run `<entry> update-snapshot --json <args>`. `onEvent` gets every JSON line;
 * resolves the last one ({ type: 'done' | 'failed' }), which is also what a
 * command that died without saying so turns into.
 */
export function runSnapshotCommand({ entry, args, env, cwd, onEvent = () => {}, spawn = nodeSpawn, timeoutMs = SNAPSHOT_TIMEOUT_MS }) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(entry, ['update-snapshot', '--json', ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      done({ type: 'failed', code: 'SPAWN', message: `SynaBun's runtime could not be started: ${error.message}` });
      return;
    }
    let last = null;
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(event);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ type: 'failed', code: 'TIMEOUT', message: 'the snapshot did not finish in time' });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || !['progress', 'done', 'failed'].includes(event.type)) continue;
        last = event;
        try { onEvent(event); } catch {}
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => finish({ type: 'failed', code: 'SPAWN', message: `SynaBun's runtime could not be started: ${error.message}` }));
    child.on('close', (code) => {
      if (last && (last.type === 'done' || last.type === 'failed')) return finish(last);
      const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      finish({ type: 'failed', code: 'EXITED', message: tail || `the snapshot ended (exit ${code}) without a result` });
    });
  });
}

/**
 * The guard. `run(args, onEvent)` runs the command (runSnapshotCommand); the
 * data home has to hold a memory database for a preparation to be worth it.
 */
export function createDataGuard({
  dataHome, current, run, log = () => {}, now = () => Date.now(),
  databasePath = join(dataHome, 'mcp-data', 'memory.db'),
}) {
  let prepared = null;   // { path, stamp, target, at }
  let preparing = null;
  let lastPrepareAt = null;
  // An install that waits for a preparation still in progress hears its progress.
  let listener = null;

  const reuseArgs = (target) => (prepared && prepared.target === target
    ? ['--reuse', prepared.path, '--reuse-stamp', JSON.stringify(prepared.stamp)]
    : []);

  /**
   * Take the snapshot in the background, or confirm that the one taken earlier is still exact. Resolves the
   * prepared snapshot, or null. At most one run per PREPARE_EVERY_MS: in between, the one there is kept as it is
   * (the install checks it anyway).
   */
  function prepare({ target }) {
    if (!target) return Promise.resolve(null);
    if (preparing) return preparing;
    if (!existsSync(databasePath)) return Promise.resolve(null);
    if (lastPrepareAt !== null && now() - lastPrepareAt < PREPARE_EVERY_MS) return Promise.resolve(prepared?.target === target ? { ...prepared } : null);
    lastPrepareAt = now();
    preparing = (async () => {
      const started = now();
      const stale = prepared && prepared.target !== target ? prepared.path : null;
      log(prepared?.target === target
        ? `update v${target}: checking the snapshot prepared ahead against the data`
        : `update v${target}: preparing the pre-update snapshot in the background`);
      const result = await run([
        '--prepare', '--target', target, ...(current ? ['--current', current] : []), ...reuseArgs(target), ...(stale ? ['--discard', stale] : []),
      ], (event) => {
        if (event.type === 'progress' && listener) { try { listener(event); } catch {} }
      });
      if (result?.type !== 'done' || !result.path) {
        log(`update v${target}: the snapshot could not be prepared (${result?.message || result?.skipped || 'no result'}); it is taken at the install`);
        prepared = null;
        return null;
      }
      if (result.reused) log(`update v${target}: the snapshot prepared ahead is still exact (${Math.round((now() - started) / 100) / 10} s)`);
      else log(`update v${target}: snapshot prepared in ${Math.round((now() - started) / 100) / 10} s (${result.path})${result.stale ? `; the earlier one was not exact: ${result.stale}` : ''}`);
      prepared = { path: result.path, stamp: result.stamp, target, at: result.reused && prepared ? prepared.at : started };
      return { ...prepared };
    })().catch((error) => {
      log(`update: preparing the snapshot failed: ${error?.message || error}`);
      return null;
    }).finally(() => { preparing = null; });
    return preparing;
  }

  /**
   * At the install, once the server has stopped: the command compares the prepared snapshot with the data and uses
   * it when it is still exact, takes a new one otherwise, and writes the handoff. Resolves the command's last event:
   * { type: 'done', reused, stale, path } or { type: 'failed', code, message }.
   */
  async function protect({ target, installId, onProgress = () => {} }) {
    if (preparing) {
      listener = onProgress;
      try { await preparing; } finally { listener = null; }
    }
    const args = ['--target', target, '--install-id', installId, ...(current ? ['--current', current] : []), ...reuseArgs(target)];
    const stale = prepared && prepared.target !== target ? prepared.path : null;
    if (stale) args.push('--discard', stale);
    log(prepared?.target === target
      ? `update v${target}: the server has stopped; checking the snapshot prepared ahead against the data`
      : `update v${target}: the server has stopped; taking the pre-update snapshot`);
    const result = await run(args, (event) => { if (event.type === 'progress') { try { onProgress(event); } catch {} } });
    prepared = null;
    return result;
  }

  return {
    prepare,
    protect,
    discard() { prepared = null; },
    get prepared() { return prepared ? { ...prepared } : null; },
  };
}
