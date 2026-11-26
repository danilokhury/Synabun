/**
 * The app's side of SynaBun's server. The deciding is done where the rest of
 * SynaBun's start logic lives, by the packaged runtime: the window asks the
 * headless entry (`<entry> app-backend --json`), which reuses the Start Server
 * launcher (lock, supervisor record, health) to reuse or start the server,
 * says each step as a JSON line, and exits once the server answers. This
 * module runs that, watches the server it got, and stops it again.
 *
 * Plain Node, no Electron: tested in packaging/tests/desktop-backend.test.mjs.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { request } from 'node:http';
import { inspectProcessesUnder, killVerifiedProcessWindows, queryWindowsProcess } from './updater/win-swap.mjs';

/** Every line the helper writes is one of these, as JSON: what the window shows while it waits. */
export const HELPER_EVENTS = Object.freeze(['plan', 'existing', 'step', 'supervisor', 'ready', 'conflict', 'failed']);

/**
 * Run `<entry> app-backend --json`. `onEvent` gets every event as it comes;
 * the promise resolves with the last one ('ready', 'conflict' or 'failed'),
 * which is also what a helper that died without saying so turns into.
 */
export function runBackendHelper({ entry, env, preferPort = null, onEvent = () => {}, spawn = nodeSpawn, timeoutMs = 12 * 60 * 1000, cwd }) {
  return new Promise((done) => {
    const args = ['app-backend', '--json', ...(preferPort ? ['--prefer-port', String(preferPort)] : [])];
    let child;
    try {
      child = spawn(entry, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      done({ type: 'failed', code: 'HELPER_SPAWN', message: `the SynaBun runtime could not be started: ${error.message}` });
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
      finish({ type: 'failed', code: 'HELPER_TIMEOUT', message: 'SynaBun\'s server did not answer in time.' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || !HELPER_EVENTS.includes(event.type)) continue;
        last = event;
        try { onEvent(event); } catch {}
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => finish({ type: 'failed', code: 'HELPER_SPAWN', message: `the SynaBun runtime could not be started: ${error.message}` }));
    child.on('close', (code) => {
      if (last && ['ready', 'conflict', 'failed'].includes(last.type)) return finish(last);
      const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      finish({ type: 'failed', code: 'HELPER_EXITED', message: tail || `the SynaBun runtime ended (exit ${code}) without starting the server` });
    });
  });
}

/** GET /api/health on the loopback address, without any proxy. Resolves the JSON, or null. */
export function fetchHealth(port, { timeoutMs = 1500, requestImpl = request } = {}) {
  return getJson(port, '/api/health', { timeoutMs, requestImpl, okOnly: true });
}

/**
 * GET /api/system/activity: what runs on the server that a restart would end
 * (`{ idle, busy }`). Null when the server does not answer with it, which the
 * updater reads as "not idle".
 */
export function fetchActivity(port, { timeoutMs = 3000, requestImpl = request } = {}) {
  return getJson(port, '/api/system/activity', { timeoutMs, requestImpl, okOnly: true });
}

function getJson(port, path, { timeoutMs, requestImpl, okOnly = false }) {
  return new Promise((done) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; done(value); } };
    try {
      const req = requestImpl({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        if (okOnly && (res.statusCode < 200 || res.statusCode >= 300)) { res.resume(); finish(null); return; }
        res.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
        res.on('end', () => { try { finish(JSON.parse(body)); } catch { finish(null); } });
        res.on('error', () => finish(null));
      });
      req.on('timeout', () => { req.destroy(); finish(null); });
      req.on('error', () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

/** POST /api/server/shutdown: the server's own graceful stop (children first, the database last). */
export function requestShutdown(port, { timeoutMs = 3000, requestImpl = request } = {}) {
  return new Promise((done) => {
    try {
      const req = requestImpl({
        host: '127.0.0.1', port, path: '/api/server/shutdown', method: 'POST', timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': '2', 'x-synabun-ui': '1' },
      }, (res) => { res.resume(); res.on('end', () => done(res.statusCode >= 200 && res.statusCode < 300)); });
      req.on('timeout', () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
      req.end('{}');
    } catch {
      done(false);
    }
  });
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** At attach, bind the OS listener between two health reads of the same server boot. */
export async function attachBackend({ port, entry, instDir, platform = process.platform,
  health = fetchHealth, query = queryWindowsProcess, realpath, log = () => {},
}) {
  const answer = await health(port);
  const key = value => platform === 'win32' ? value?.replaceAll('\\', '/').toLowerCase() : value;
  const ours = answer?.ok === true && entry && typeof answer.installEntry === 'string' && key(answer.installEntry) === key(entry);
  const bootId = ours && typeof answer.bootId === 'string' ? answer.bootId : null;
  let listener = null;
  if (bootId && platform === 'win32') {
    const proc = await query({ port });
    if (proc) {
      const { verified } = inspectProcessesUnder([proc], instDir, { realpath, backendOnly: true });
      if (verified.length && (await health(port))?.bootId === bootId) listener = verified[0];
      else log(`backend attach: leaving unverified listener ${proc.name} (pid ${proc.pid}) running`);
    }
  }
  return { bootId, listener };
}

/** Request a graceful shutdown first. Windows force is limited to the OS listener bound at attach. */
export async function stopBackend({
  port, launcherPid = null, supervisorPid = null, bootId = null, listener = null, instDir = null,
  timeoutMs = 20000, platform = process.platform, health = fetchHealth, shutdown = requestShutdown,
  alive = pidAlive, kill = process.kill.bind(process), exec, realpath, supervisorEnded = () => false,
  sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now, log = () => {},
}) {
  const windows = platform === 'win32';
  const readHealth = () => port ? health(port, { timeoutMs: 700 }) : null;
  const initial = await readHealth();
  const sameBoot = answer => !!bootId && answer?.ok === true && answer.bootId === bootId;
  let asked = port && (!bootId || sameBoot(initial)) ? await shutdown(port) : false;
  let askedAt = now();
  log(`backend stop: shutdown request ${asked ? 'accepted' : 'not answered'} (port ${port})`);
  const gone = (answer, allowGaveUp = false) => {
    if (answer?.ok || (listener && alive(listener.pid))) return false;
    if (!alive(supervisorPid) && !alive(launcherPid)) return true;
    try { return allowGaveUp && supervisorEnded() === true; } catch { return false; }
  };
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const answer = await readHealth();
    if (gone(answer, true)) return { stopped: true, forced: false };
    if (!asked && sameBoot(answer) && now() - askedAt >= 1000) {
      asked = await shutdown(port);
      askedAt = now();
    }
    await sleep(Math.min(300, Math.max(0, deadline - now())));
  }

  const force = async (signal, until) => {
    if (windows) {
      if (listener && instDir) {
        await killVerifiedProcessWindows(listener, { instDir, backendOnly: true, realpath, exec, now, timeoutMs: until - now(), log });
      } else {
        log('backend stop: no verified Windows listener to force');
      }
      return;
    }
    for (const pid of new Set([launcherPid, supervisorPid])) {
      if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) continue;
      try { kill(-pid, signal); } catch { try { kill(pid, signal); } catch {} }
    }
  };
  const waitForExit = async until => {
    while (now() < until) {
      if (gone(await readHealth())) return true;
      await sleep(Math.min(250, Math.max(0, until - now())));
    }
    return false;
  };
  log('backend stop: still running after the graceful stop');
  const hard = now() + 5000;
  await force('SIGTERM', hard);
  if (await waitForExit(hard)) return { stopped: true, forced: true };
  const retryUntil = now() + 2000;
  await force('SIGKILL', retryUntil);
  if (windows && await waitForExit(retryUntil)) return { stopped: true, forced: true };
  return { stopped: gone(await readHealth()), forced: true };
}

/**
 * Watches the server the window shows. A server that does not answer while its
 * supervisor lives is restarting (Restart Server, an update of its own, a crash
 * it is started again after); one whose supervisor is gone and that does not
 * answer has stopped. `onStopped` runs once, after `graceMs` of silence with no
 * supervisor, or at once when the supervisor's record says it gave up
 * (`supervisorEnded`: the crash-loop guard, a start that failed), even while
 * that supervisor still takes a moment to write its logs.
 */
export function watchBackend({
  port, supervisorPid = null, launcherPid = null, onStopped, onRecovered, health = fetchHealth, alive = pidAlive, supervisorEnded = () => false,
  intervalMs = 3000, graceMs = 8000, restartLimitMs = 3 * 60 * 1000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, now = () => Date.now(),
}) {
  let silentSince = null;
  let stopped = false;
  let fired = false;
  let busy = false;
  const timer = setIntervalImpl(async () => {
    if (fired || busy) return;
    busy = true;
    try {
      const answer = await health(port, { timeoutMs: 1500 });
      if (fired) return;
      if (answer?.ok === true && !answer.restarting) {
        const wasOffline = silentSince !== null;
        silentSince = null;
        stopped = false;
        if (wasOffline) onRecovered?.();
        return;
      }
      if (stopped) return;
      silentSince ??= now();
      let gaveUp = false;
      try { gaveUp = supervisorEnded() === true; } catch {}
      const supervised = !gaveUp && (alive(supervisorPid) || alive(launcherPid));
      const quiet = now() - silentSince;
      if (gaveUp || (!supervised && quiet >= graceMs) || quiet >= restartLimitMs) {
        stopped = true;
        onStopped?.(gaveUp ? { supervised: false, gaveUp: true } : { supervised });
      }
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer?.unref?.();
  return { stop() { fired = true; clearIntervalImpl(timer); } };
}
