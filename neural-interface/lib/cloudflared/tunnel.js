// ═══════════════════════════════════════════
// SynaBun — the public address (a Cloudflare quick tunnel)
// ═══════════════════════════════════════════
//
// `cloudflared tunnel --url http://localhost:<port>`: no Cloudflare account, an
// address under trycloudflare.com for as long as the process runs. One tunnel
// at a time. What server.js keeps of it are three thin routes (/api/tunnel/…)
// and the address itself, which it needs for its Host and remote rules: it
// gets every change through `onUrl`, the moment cloudflared prints the address.
//
//   start()   answers at once. Behind it: the copy of cloudflared to run
//             (manager.js: a download on a machine that has none), then the
//             process, then its address. A second start while one is on its
//             way, or running, changes nothing.
//   stop()    ends the process, and whatever a start was still waiting for.
//   status()  what is happening, for the page: idle, downloading (with
//             progress), starting, running (the address, which copy runs and
//             its version), failed (a code and a sentence; a start tries again).
//   shutdown()  stop(), then waits (a bounded time) until cloudflared has
//             really exited. killNow(): at the server's exit, kill it now.
//
// A copy of SynaBun's own is started with --no-autoupdate: it is a pinned file,
// and cloudflared would otherwise replace itself where it stands, inside an
// installed application too. The user's own cloudflared is started as before.
// Whatever copy it is, the manager checks it once more right before the start
// (confirm: the very file its check read, by its real path), and that path is
// what is started, at once.
//
// An ended process is not forgotten: it is asked to end (SIGTERM), killed when
// it is still there a moment later (SIGKILL), and kept until it has exited.
//
// Each cloudflared it starts is on record from its spawn until it has exited
// (`records`: lib/opencode-serve-records.js, kind 'quick', in
// DATA_HOME/runtime/tunnels), with a token of its start in its environment. A
// server that ends without its exit handlers (a native crash) leaves its
// cloudflared running on macOS and Linux (Windows ends a child with its parent),
// the old address still pointing at the port the next server listens on: the
// next server ends it by that record (server.js sweepLeftoverTunnels), and only
// while the OS still reports that very process.

import { spawn as nodeSpawn } from 'node:child_process';

const exited = (proc) => !proc.pid || proc.exitCode !== null || proc.signalCode !== null;

/**
 * End a child process for sure: SIGTERM now, SIGKILL when it is still there `killAfterMs` later. Resolves once it
 * has exited (at once for one that is gone, or never started). How long to wait for that is the caller's choice.
 */
export function endChild(proc, { killAfterMs = 1000 } = {}) {
  return new Promise((done) => {
    if (!proc || exited(proc)) { done(); return; }
    let timer = null;
    proc.once('exit', () => { clearTimeout(timer); done(); });
    try { proc.kill('SIGTERM'); } catch { /* gone already */ }
    timer = setTimeout(() => {
      if (!exited(proc)) { try { proc.kill('SIGKILL'); } catch { /* gone already */ } }
    }, killAfterMs);
  });
}

/** The address of a quick tunnel, as cloudflared prints it. */
const TUNNEL_URL = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/g;
/** Names under trycloudflare.com that are Cloudflare's own, never a tunnel's (they appear in its error lines). */
const NOT_A_TUNNEL = new Set(['api', 'www']);
const OUTPUT_KEPT = 4096;

/** The first quick-tunnel address in a piece of cloudflared's output, or null. */
export function tunnelUrlIn(text) {
  TUNNEL_URL.lastIndex = 0;
  for (let match = TUNNEL_URL.exec(text); match; match = TUNNEL_URL.exec(text)) {
    if (!NOT_A_TUNNEL.has(match[1])) return match[0];
  }
  return null;
}

/** The arguments cloudflared is started with for a copy from `source` (manager.js). */
export function tunnelArguments(port, source) {
  return ['tunnel', ...(source === 'system' ? [] : ['--no-autoupdate']), '--url', `http://localhost:${port}`];
}

/** The kind of the tunnel's records (lib/opencode-serve-records.js createServeRecords `kinds`). */
export const TUNNEL_KINDS = Object.freeze(['quick']);

/**
 * Are `args` (a command line's arguments, as the platform reads them: lib/opencode-serve-records.js commandArgs) a
 * quick tunnel to this server's `port` (`… tunnel … --url http://localhost:<port>`, as tunnelArguments makes them)?
 * What a tunnel record must name.
 */
export function tunnelsToPort(args, port) {
  const p = Number(port);
  if (!Array.isArray(args) || !Number.isInteger(p) || p <= 0 || p > 65535) return false;
  if (!args.includes('tunnel')) return false;
  const url = `http://localhost:${p}`;
  return args.some((arg, i) => arg === `--url=${url}` || (arg === '--url' && args[i + 1] === url));
}

/** What cloudflared said last that reads like a reason: its last error line, without the timestamp. */
function lastReason(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const said = [...lines].reverse().find((line) => /\b(?:ERR|error|failed)\b/i.test(line)) || '';
  return said.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+/, '').replace(/^(?:ERR|INF|WRN)\s+/, '').slice(0, 240);
}

/**
 * @param {object} o
 * @param {{ ensure: Function, inspect: Function, status: Function, cancel: Function, confirm?: Function, killNow?: Function }} o.cloudflared manager.js
 * @param {number | string} o.port the port of this server
 * @param {(url: string | null) => void} [o.onUrl] every change of the address: set when it is known, null when it is gone
 * @param {typeof nodeSpawn} [o.spawn]
 * @param {number} [o.urlTimeoutMs] how long a started cloudflared may take to print its address
 * @param {number} [o.killAfterMs] how long an ended cloudflared has to exit before it is killed
 * @param {(line: string) => void} [o.log]
 * @param {{ newToken: () => string, tokenEnv: string, record: (entry: object) => Promise<object|null>, remove: (entry: object) => boolean }} [o.records]
 *   where each cloudflared it starts is kept on record until it has exited (lib/opencode-serve-records.js, kind 'quick')
 */
export function createQuickTunnel({ cloudflared, port, onUrl = () => {}, spawn = nodeSpawn, urlTimeoutMs = 90_000, killAfterMs = 1000, log = () => {}, records = null }) {
  let phase = 'idle';   // idle | preparing | starting | running | failed
  let child = null;
  let url = null;
  let copy = null;      // { source, version } of the cloudflared that runs
  let error = null;     // { code, message, reason } of the start that failed, until the next one (`reason`: cloudflared's own words, when it gave any)
  let attempt = 0;      // a start that is not the current attempt any more does nothing
  let preparing = null; // the AbortController of the start that is getting its copy ready
  const ending = new Map();   // a process that was asked to end → its endChild(): kept until it has really exited

  /** Ask a process to end, kill it when it does not, and keep it until it has exited. */
  function end(proc) {
    if (!proc) return Promise.resolve();
    if (!ending.has(proc)) ending.set(proc, endChild(proc, { killAfterMs }).then(() => { ending.delete(proc); }));
    return ending.get(proc);
  }

  const setUrl = (value) => {
    if (url === value) return;
    url = value;
    try { onUrl(value); } catch { /* the address is still ours to report */ }
  };

  function fail(code, message, reason = null) {
    phase = 'failed';
    error = { code, message, reason };
    copy = null;
    setUrl(null);
    log(`  Tunnel:  ${code === 'ended' ? 'stopped' : 'not started'} (${code}): ${message}`);
  }

  // On record from its spawn until it has exited: what the next server ends when this one crashed (see above).
  function keepOnRecord(proc, token) {
    const pid = Number(proc?.pid) || null;
    if (!pid) return;
    const kept = Promise.resolve().then(() => records.record({ kind: TUNNEL_KINDS[0], port: Number(port), pid, token })).catch(() => null);
    proc.once('exit', () => { kept.then((entry) => { if (entry) records.remove(entry); }).catch(() => {}); });
  }

  function launch(found, mine) {
    // The token of this start, in its environment: made before the check below, so nothing runs between them.
    let token = null;
    try { token = records?.tokenEnv ? records.newToken() : null; } catch { token = null; }
    const options = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(token ? { env: { ...process.env, [records.tokenEnv]: token } } : {}) };
    // Checked once more as it is about to run (the manager's confirm: the very file its check read, still where
    // nobody else can change it), and started at once by the real path that was checked: nothing runs in between.
    let path = found.path;
    try {
      if (typeof cloudflared.confirm === 'function') path = cloudflared.confirm(found);
    } catch (failure) {
      return fail(typeof failure?.code === 'string' ? failure.code : 'launch', failure?.message || String(failure));
    }
    let proc;
    try {
      proc = spawn(path, tunnelArguments(port, found.source), options);
    } catch (failure) {
      return fail('launch', `cloudflared could not be started (${failure?.code || failure?.message || failure}).`);
    }
    if (token) keepOnRecord(proc, token);
    child = proc;
    copy = { source: found.source, version: found.version };
    phase = 'starting';
    let output = '';
    const timer = setTimeout(() => {
      if (mine !== attempt || phase !== 'starting') return;
      child = null;
      end(proc);
      fail('no_address', `cloudflared gave no address within ${Math.round(urlTimeoutMs / 1000)} seconds.`, lastReason(output) || null);
    }, urlTimeoutMs);
    timer.unref?.();
    // cloudflared prints the address to stderr, in pieces that can end anywhere: the search runs over what
    // came last, not over one piece.
    const read = (data) => {
      output = (output + data.toString()).slice(-OUTPUT_KEPT);
      if (mine !== attempt || phase !== 'starting') return;
      const address = tunnelUrlIn(output);
      if (!address) return;
      clearTimeout(timer);
      phase = 'running';
      setUrl(address);
      log(`  Tunnel:  ${address} (cloudflared ${found.version}, ${found.source})`);
    };
    proc.stdout?.on('data', read);
    proc.stderr?.on('data', read);
    proc.on('error', (failure) => {
      clearTimeout(timer);
      if (mine !== attempt || child !== proc) return;
      child = null;
      fail('launch', `cloudflared could not be started (${failure?.code || failure?.message || failure}).`);
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (mine !== attempt || child !== proc) return;   // stopped on request, or already accounted for
      child = null;
      const said = lastReason(output) || null;
      if (phase === 'running') fail('ended', 'The tunnel stopped by itself. Start it again for a new address.', said);
      else fail('exited', said || `cloudflared stopped before it gave an address (${signal || `exit ${code}`}).`, said);
    });
    return undefined;
  }

  function answer(message) {
    return { ok: true, state: phase, url, message };
  }

  function start() {
    if (phase === 'running') return { ...answer('Already running.') };
    if (phase === 'preparing' || phase === 'starting') return answer('Tunnel starting...');
    const mine = ++attempt;
    phase = 'preparing';
    error = null;
    copy = null;
    setUrl(null);
    // What the preparation runs (a hash, a `cloudflared --version`, a download) stops with this, on stop().
    const ready = new AbortController();
    preparing = ready;
    const done = () => { if (preparing === ready) preparing = null; };
    Promise.resolve().then(() => cloudflared.ensure({ signal: ready.signal })).then((found) => {
      done();
      if (mine === attempt) launch(found, mine);
    }, (failure) => {
      done();
      if (mine !== attempt) return;
      fail(typeof failure?.code === 'string' ? failure.code : 'unknown', failure?.message || String(failure));
    });
    return answer('Tunnel starting...');
  }

  function stop() {
    const was = phase;
    attempt++;
    const proc = child;
    child = null;
    phase = 'idle';
    error = null;
    copy = null;
    setUrl(null);
    if (preparing) { preparing.abort(); preparing = null; }
    if (was === 'preparing') { try { cloudflared.cancel(); } catch { /* nothing was running */ } }
    end(proc);
    return { ok: true, state: phase, message: was === 'idle' || was === 'failed' ? 'Not running.' : 'Tunnel stopped.' };
  }

  /**
   * stop(), and a wait until cloudflared has really exited (killed when it does not end by itself): at most
   * `timeoutMs`, so the server's shutdown never waits on it for long. `exited` says whether it did by then.
   */
  async function shutdown({ timeoutMs = 2000 } = {}) {
    const stopped = stop();
    let timer = null;
    const exitedInTime = await Promise.race([
      Promise.all([...ending.values()]).then(() => true),
      new Promise((done) => { timer = setTimeout(() => done(false), timeoutMs); }),
    ]);
    clearTimeout(timer);
    return { ...stopped, exited: exitedInTime && ending.size === 0 };
  }

  /** At the server's exit, when nothing can be waited for: every cloudflared this started that is still there is killed now. */
  function killNow() {
    stop();
    for (const proc of ending.keys()) { if (!exited(proc)) { try { proc.kill('SIGKILL'); } catch { /* gone already */ } } }
    try { cloudflared.killNow?.(); } catch { /* nothing of its own runs */ }
  }

  async function status() {
    // While a start waits for the copy, the manager is asked what it knows, not sent to look again.
    let tool;
    try { tool = phase === 'preparing' ? cloudflared.status() : await cloudflared.inspect(); } catch (failure) { tool = { ...cloudflared.status(), state: 'failed', error: { code: 'unknown', message: failure?.message || String(failure) } }; }
    const downloading = phase === 'preparing' && tool.state === 'downloading';
    return {
      ok: true,
      // What a page that predates the download reads: can a tunnel be started here, is one up, is one on its way.
      available: tool.state !== 'unsupported',
      running: phase === 'running' || phase === 'starting',
      starting: phase === 'preparing' || phase === 'starting',
      url,
      state: downloading ? 'downloading' : phase === 'preparing' ? 'starting' : phase,
      error,
      cloudflared: {
        ...tool,
        // The copy that runs, when one does; otherwise the one a start would run.
        source: copy?.source ?? tool.source,
        version: copy?.version ?? tool.version,
      },
    };
  }

  return { start, stop, status, url: () => url, phase: () => phase, shutdown, killNow };
}
