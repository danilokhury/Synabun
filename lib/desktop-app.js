/**
 * SynaBun — the desktop app's server
 *
 * The Electron window of a packaged build (packaging/desktop/) does not decide
 * anything about the server itself: it runs `<entry> app-backend --json`
 * (packaging/runtime/bootstrap.mjs), which comes here. This module finds the
 * server the window should show, and starts one through the same Start Server
 * launcher an npm install uses (lib/start-launcher.js runLauncher: the launch
 * lock, the supervisor record, the health check), so two starts never race.
 *
 *   reuse      a server of this install (same entry, same version) answers:
 *              on the port the window used last, where this data home's
 *              supervisor says it listens, or on the configured port
 *   replace    a server of this install from before an update answers: it is
 *              asked to shut down, and the new version starts in its place
 *   refuse     another installation of SynaBun answers on the port with this
 *              same data home (or cannot say which one it uses): it is never
 *              stopped or adopted, and the window says so
 *   move       the port is taken by something else (a program, a SynaBun on
 *              another data home): this install starts on a free port
 *
 * Every step is reported as an event ({ type: 'plan' | 'existing' | 'step' |
 * 'supervisor' | 'ready' | 'conflict' | 'failed', ... }); the window shows them.
 */

import { createHash } from 'node:crypto';
import { realpathSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Which data home a server uses, without saying where it is: the first 16 hex
 * characters of a SHA-256 of its real path (lower case on Windows, where case
 * does not tell paths apart). /api/health reports it, so the app can tell a
 * second copy on the same data from one on another.
 */
export function dataHomeId(dataHome, platform = process.platform) {
  let path = resolve(String(dataHome || ''));
  try { path = realpathSync.native(path); } catch {}
  if (platform === 'win32') path = path.toLowerCase();
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

function samePath(a, b, platform) {
  const norm = (value) => {
    let path = String(value || '').replace(/\\/g, '/');
    try { path = realpathSync.native(path).replace(/\\/g, '/'); } catch {}
    return platform === 'win32' ? path.toLowerCase() : path;
  };
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * What answers on a port, for this install:
 *   'none'               nothing answers
 *   'other'              something answers that is not a SynaBun server
 *   'ours'               this install, this version
 *   'ours-stale'         this install, another version (from before an update)
 *   'foreign'            another installation, on another data home
 *   'foreign-same-data'  another installation on this data home, or one that does not say
 */
export function classifyServer(health, { entry, packageRoot, version, dataHomeId: ours, platform = process.platform, answered = true } = {}) {
  if (!health) return { kind: answered ? 'other' : 'none' };
  if (health.ok !== true || health.storage !== 'sqlite' || typeof health.projectDir !== 'string') return { kind: 'other', health };
  // This install: the entry it runs from (installEntry; `entry` is only the path that outlives the run, empty for a
  // copy on its disk image or a translocated one), or the very same application folder. An AppImage's folder is a
  // new mount every run, and its entry (the image file) is what matches.
  const theirEntry = health.installEntry || health.entry;
  if ((entry && theirEntry && samePath(theirEntry, entry, platform)) || (packageRoot && samePath(health.projectDir, packageRoot, platform))) {
    return { kind: String(health.version || '') === String(version) ? 'ours' : 'ours-stale', health };
  }
  if (health.dataHomeId && health.dataHomeId !== ours) return { kind: 'foreign', health };
  // Said so (the same data home), or said nothing (a server from before 2026-10-17 reports no data home).
  return { kind: 'foreign-same-data', health, known: !!health.dataHomeId };
}

/** A server that answers its health check completely: ready for the window. */
export function serverReady(health) {
  return !!health && health.ok === true && health.storage === 'sqlite' && typeof health.projectDir === 'string' && !!health.startLauncher;
}

async function defaultHealth(port, { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!response.ok) return { status: response.status };
    return await response.json();
  } catch {
    return null;
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Find or start the server for the desktop app. Resolves with the final event
 * ('ready', 'conflict' or 'failed'); `emit` receives every event on the way.
 * Everything that touches the system is a parameter, for the tests.
 */
export async function runAppBackend({
  env = process.env,
  runtime,
  packageRoot,
  dataHome,
  preferPort = null,
  platform = process.platform,
  emit = () => {},
  launcher,            // lib/start-launcher.js (runLauncher, resolvePort, portAccepts, launcherStatePaths, pidAlive)
  backgroundCommand,   // lib/desktop-pwa.js: the background start of a packaged build
  spawn,
  health = defaultHealth,
  shutdown = null,
  sleep = (ms) => new Promise(done => setTimeout(done, ms)),
  now = () => Date.now(),
  readyWaitMs = 5 * 60 * 1000,
  searchSpan = 20,
} = {}) {
  const ours = { entry: runtime?.entry || null, packageRoot: packageRoot || runtime?.packageRoot || null, version: runtime?.version || '', dataHomeId: dataHomeId(dataHome, platform), platform };
  const { runLauncher, resolvePort, portAccepts, launcherStatePaths, pidAlive } = launcher;
  const configured = resolvePort({ env, dataHome });
  const paths = launcherStatePaths(dataHome);
  const supervisorRecord = () => readJson(paths.supervisor);
  const look = async (port) => {
    const answer = await health(port);
    if (answer && answer.ok === undefined && answer.status) return classifyServer(null, { ...ours, answered: true });
    if (answer) return classifyServer(answer, ours);
    return classifyServer(null, { ...ours, answered: await portAccepts(port).catch(() => false) });
  };
  const ready = (port, extra) => {
    const record = supervisorRecord();
    return { type: 'ready', port, supervisorPid: record && !record.endedAt && pidAlive(record.pid) ? record.pid : null, ...extra };
  };
  const conflict = (port, found) => ({ type: 'conflict', port, projectDir: found.health?.projectDir || null, install: found.health?.install || null, version: found.health?.version || null });

  emit({ type: 'plan', dataHome, port: configured, preferredPort: configured, dataHomeId: ours.dataHomeId });

  // This install's server from before an update: its files are gone or replaced. It goes; the new one starts.
  const stopStale = async (stalePort, staleVersion) => {
    const asked = shutdown ? await shutdown(stalePort) : false;
    const deadline = now() + 20000;
    while (await portAccepts(stalePort).catch(() => false)) {
      if (now() >= deadline) return { type: 'failed', code: 'STALE_SERVER', message: `An older SynaBun server of this copy (v${staleVersion}) still runs on port ${stalePort} and did not stop${asked ? '' : ' when asked'}.`, log: paths.log };
      await sleep(300);
    }
    return null;
  };

  // 1. A server of this install that is already up: where the window was last,
  //    or where this data home's supervisor says its server listens. Another
  //    installation on this data home there is never a reason to start a second one.
  const record = supervisorRecord();
  const recordPort = record && !record.endedAt && pidAlive(record.pid) && record.phase === 'listening' ? Number(record.detail?.port) || null : null;
  for (const earlier of [...new Set([preferPort, recordPort].filter(value => value && value !== configured))]) {
    const seen = await look(earlier);
    if (seen.kind === 'none') continue;
    emit({ type: 'existing', port: earlier, kind: seen.kind, version: seen.health?.version || null });
    if (seen.kind === 'ours') return finish(ready(earlier, { reused: true, started: false, version: seen.health.version }));
    // Another installation on this data home, or one too old to say which data home it uses (every server from
    // before 2026-10-17): the window is told where it runs. Starting this install beside it could mean two
    // servers on one data home.
    if (seen.kind === 'foreign-same-data') return finish(conflict(earlier, seen));
    if (seen.kind === 'ours-stale') {
      const failed = await stopStale(earlier, seen.health.version);
      if (failed) return finish(failed);
    }
  }

  // 2. The configured port.
  let port = configured;
  let alternative = false;
  const found = await look(configured);
  if (found.kind !== 'none') emit({ type: 'existing', port: configured, kind: found.kind, version: found.health?.version || null });
  if (found.kind === 'ours') return finish(ready(configured, { reused: true, started: false, version: found.health.version }));
  if (found.kind === 'foreign-same-data') return finish(conflict(configured, found));
  if (found.kind === 'ours-stale') {
    const failed = await stopStale(configured, found.health.version);
    if (failed) return finish(failed);
  } else if (found.kind === 'foreign' || found.kind === 'other') {
    const free = await freePort([preferPort, ...Array.from({ length: searchSpan }, (_, i) => configured + 1 + i)]);
    if (!free) return finish({ type: 'failed', code: 'NO_PORT', message: `Port ${configured} is in use by another program, and no free port was found near it.`, log: paths.log });
    port = free;
    alternative = true;
    emit({ type: 'plan', dataHome, port, preferredPort: configured, alternativePort: true, dataHomeId: ours.dataHomeId });
  }

  async function freePort(candidates) {
    for (const candidate of [...new Set(candidates.filter(value => Number.isInteger(value) && value > 0 && value < 65536))]) {
      if (!(await portAccepts(candidate).catch(() => true))) return candidate;
    }
    return null;
  }

  // 3. Start, through the launcher (lock, supervisor record, background start).
  let launcherPid = null;
  let lastPhase = null;
  let lastStep = null;
  // A phase is said when it begins; the snapshot also says how far it is (its step, the bytes done), for the
  // window's progress bar.
  const reportPhase = (current) => {
    if (!current?.phase) return;
    const step = current.phase === 'snapshot' ? `${current.detail?.step ?? ''}:${current.detail?.done ?? ''}:${current.detail?.state ?? ''}` : null;
    if (current.phase === lastPhase && step === lastStep) return;
    lastPhase = current.phase;
    lastStep = step;
    emit({ type: 'supervisor', phase: current.phase, detail: current.detail || null });
  };
  const reporter = () => ({
    get listening() { return false; },
    listen: async () => false,
    step: (id) => emit({ type: 'step', id: String(id) }),
    supervisor: reportPhase,
    finish: () => {},
    linger: async () => {},
    close: () => {},
  });
  const result = await runLauncher({
    argv: ['--port', String(port)],
    env: { ...env, NEURAL_PORT: String(port) },
    packageRoot,
    background: true,
    beacon: reporter,
    spawnImpl: (file, args, options) => {
      const command = backgroundCommand(runtime, options.env);
      const child = spawn(command.file, command.args, { ...options, env: command.env, cwd: command.cwd || options.cwd });
      launcherPid = child.pid || null;
      return child;
    },
  });
  if (result.outcome === 'failed') {
    const failure = supervisorRecord();
    return finish({ type: 'failed', code: failure?.error?.code || 'START_FAILED', message: failure?.phase === 'failed' && failure.error?.message ? failure.error.message : 'SynaBun\'s server could not be started.', log: paths.log });
  }

  // 4. Until it answers completely (a first start downloads the automation browser and backs up the data).
  const deadline = now() + readyWaitMs;
  for (;;) {
    const answer = await health(port);
    if (serverReady(answer)) {
      const kind = classifyServer(answer, ours).kind;
      if (kind !== 'ours') return finish(kind === 'foreign-same-data' ? conflict(port, { health: answer }) : { type: 'failed', code: 'NOT_OURS', message: `Another program took port ${port} while SynaBun started.`, log: paths.log });
      return finish(ready(port, { reused: result.outcome !== 'started', started: result.outcome === 'started', launcherPid, version: answer.version, alternativePort: alternative, preferredPort: configured }));
    }
    const current = supervisorRecord();
    reportPhase(current);
    if (current?.phase === 'failed' && current.error) return finish({ type: 'failed', code: current.error.code || 'START_FAILED', message: current.error.message, log: paths.log });
    if (now() >= deadline) return finish({ type: 'failed', code: 'NO_ANSWER', message: `SynaBun's server did not answer within ${Math.round(readyWaitMs / 60000)} minutes.`, log: paths.log });
    await sleep(400);
  }

  function finish(event) {
    emit(event);
    return event;
  }
}

/** POST /api/server/shutdown on the loopback address: the server's own graceful stop. */
export async function requestServerShutdown(port, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/server/shutdown`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Where the launcher writes its log for a data home (what "Open logs" shows). */
export function launcherLogOf(dataHome) {
  return join(dataHome, 'data', 'launcher.log');
}
