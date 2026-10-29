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
  return getJson(port, '/api/health', { timeoutMs, requestImpl });
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

/**
 * Stop the server the app started (or one of this install the app has to
 * replace): ask it to shut down, wait for it and its supervisor to be gone,
 * and only then end what is left by force. The launcher process of a
 * background start leads its own process group (POSIX) or job object
 * (Windows), so ending it ends everything it started.
 *
 * A server that does not take the request while its supervisor lives is
 * between a crash and the start that replaces it (or still starting): it is
 * asked again as soon as it answers, so quitting then is a graceful stop of the
 * new server, not a wait for the deadline. So is a server that answers after
 * the one that took the request went away, or under another boot id: that stop
 * did not hold (a restart was under way, or it crashed on its way out and was
 * started again). A supervisor whose record says it gave up (`supervisorEnded`)
 * has no server to bring back: with its server gone, that is stopped, even
 * while it takes a moment more to write its logs.
 */
export async function stopBackend({
  port, launcherPid = null, supervisorPid = null, timeoutMs = 20000, platform = process.platform,
  health = fetchHealth, shutdown = requestShutdown, alive = pidAlive, kill = process.kill.bind(process), spawn = nodeSpawn,
  supervisorEnded = () => false,
  sleep = (ms) => new Promise(done => setTimeout(done, ms)), now = () => Date.now(), log = () => {},
}) {
  const bootOf = (answer) => (answer && typeof answer.bootId === 'string' && answer.bootId ? answer.bootId : null);
  // Which server took the request (its boot id, when it says one), and whether it has been seen gone since.
  let askedBoot = port ? bootOf(await health(port, { timeoutMs: 700 })) : null;
  let asked = port ? await shutdown(port) : false;
  let askedAt = now();
  let away = false;
  log(`backend stop: shutdown request ${asked ? 'accepted' : 'not answered'} (port ${port})`);
  const deadline = now() + timeoutMs;
  const ended = () => { try { return supervisorEnded() === true; } catch { return false; } };
  const gone = async () => !(await health(port, { timeoutMs: 700 })) && !alive(supervisorPid) && !alive(launcherPid);
  while (now() < deadline) {
    const answer = port ? await health(port, { timeoutMs: 700 }) : null;
    if (!answer) {
      if (asked) away = true;
      if (!alive(supervisorPid) && !alive(launcherPid)) { log('backend stop: stopped'); return { stopped: true, forced: false }; }
      if (ended()) { log('backend stop: stopped (its supervisor had given up)'); return { stopped: true, forced: false }; }
    } else {
      const boot = bootOf(answer);
      // Another server than the one that took the request: by its boot id, or (a server that says none) by having
      // been seen gone in between.
      if (asked && (boot && askedBoot ? boot !== askedBoot : away)) {
        asked = false;
        log(`backend stop: a server answers again after the stop (port ${port}); asking it too`);
      }
      if (!asked && now() - askedAt >= 1000) {
        // Back after a crash or a restart, or done starting: now it can take the request.
        asked = await shutdown(port);
        askedAt = now();
        askedBoot = boot;
        away = false;
        log(`backend stop: shutdown request ${asked ? 'accepted' : 'not answered'} on a new try (port ${port})`);
      }
    }
    await sleep(300);
  }
  log('backend stop: still running after the graceful stop; ending it');
  for (const pid of [launcherPid, supervisorPid].filter(pid => alive(pid))) {
    if (platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    } else {
      try { kill(-pid, 'SIGTERM'); } catch { try { kill(pid, 'SIGTERM'); } catch {} }
    }
  }
  const hard = now() + 5000;
  while (now() < hard) {
    if (await gone()) return { stopped: true, forced: true };
    await sleep(250);
  }
  if (platform !== 'win32') {
    for (const pid of [launcherPid, supervisorPid].filter(pid => alive(pid))) {
      try { kill(-pid, 'SIGKILL'); } catch { try { kill(pid, 'SIGKILL'); } catch {} }
    }
  }
  return { stopped: await gone(), forced: true };
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
  port, supervisorPid = null, launcherPid = null, onStopped, health = fetchHealth, alive = pidAlive, supervisorEnded = () => false,
  intervalMs = 3000, graceMs = 8000, restartLimitMs = 3 * 60 * 1000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, now = () => Date.now(),
}) {
  let silentSince = null;
  let fired = false;
  let busy = false;
  const timer = setIntervalImpl(async () => {
    if (fired || busy) return;
    busy = true;
    try {
      const answer = await health(port, { timeoutMs: 1500 });
      if (answer?.ok) { silentSince = null; return; }
      silentSince ??= now();
      let gaveUp = false;
      try { gaveUp = supervisorEnded() === true; } catch {}
      const supervised = !gaveUp && (alive(supervisorPid) || alive(launcherPid));
      const quiet = now() - silentSince;
      if (gaveUp || (!supervised && quiet >= graceMs) || quiet >= restartLimitMs) {
        fired = true;
        clearIntervalImpl(timer);
        onStopped?.(gaveUp ? { supervised: false, gaveUp: true } : { supervised });
      }
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer?.unref?.();
  return { stop() { fired = true; clearIntervalImpl(timer); } };
}
