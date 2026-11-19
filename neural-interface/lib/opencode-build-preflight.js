// A throwaway OpenCode build check, before a native context is admitted. MoreLogin's port protection has a
// 0.0.0.0 bypass (see the live diagnostic): it is additional protection, never permission to expose a new build.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSpecFor, servePasswordReader } from './opencode-protocol.js';
import { moreLoginProcessesRunning } from './process-identity.js';

/** Strictly parse the observed MoreLogin /api/env/detail response; never retain cookies or other profile data. */
export function portProtectionOf(detail) {
  const value = detail?.advancedSetting?.port_scan_protection;
  if (!value || ![0, 1].includes(value.switcher) || (value.value !== null && typeof value.value !== 'string')) return null;
  const words = value.value?.trim() ? value.value.split(',').map(s => s.trim()) : [];
  if (words.some(s => !/^\d{1,5}$/.test(s) || +s < 1 || +s > 65535)) return null;
  return { enabled: value.switcher === 1, ports: [...new Set(words.map(Number))] };
}

// Never copy arbitrary API response text: it can contain profile credentials.
export function moreLoginFailureDetail(error) {
  if (error?.status === 401 || error?.status === 403 || /auth|sign|unauthor|forbidden/i.test(error?.message || '')) return 'authentication refused';
  if (error?.status === 404 || /not found|not exist/i.test(error?.message || '')) return 'profile not found';
  if (error?.code === 'MORELOGIN_UNREACHABLE') return 'transport unavailable';
  if (error?.code === 'MORELOGIN_SHAPE') return 'malformed API response';
  return 'API request failed';
}
function profileError(code, message, envId) {
  return Object.assign(new Error(message), { code, sharedPreflight: true, offenders: envId ? [{ envId, reason: code }] : [] });
}
export async function reconcilePreflightProfiles(profiles, list, { requested = [], allowUnavailable = false,
  browserProcesses = moreLoginProcessesRunning, log = () => {} } = {}) {
  let live;
  try { live = await list(); } catch (error) {
    // Optional only for starting OpenCode: keep verifying its build/serves without MoreLogin port exclusions.
    // Browser work still requires the API, and native attachment still waits for the serve boundary. Never
    // interpret an answering API (including a partial listing), a reset or an unknown failure as an empty list.
    if (allowUnavailable && error?.code === 'MORELOGIN_UNREACHABLE' && error.unavailable === true && !error.apiAnswered) {
      // Profile windows can outlive the desktop API, including windows SynaBun has never attached to.
      let running = null;
      try { running = await browserProcesses(); } catch { /* unknown: fail closed, without OS/process details */ }
      if (running !== false) throw profileError(running === true ? 'MORELOGIN_BROWSER_RUNNING' : 'MORELOGIN_PROCESS_UNREADABLE',
        running === true ? 'MoreLogin API is unavailable but a MoreLogin process is still running. OpenCode build verification has not started.'
          : 'MoreLogin API is unavailable and browser processes could not be checked. OpenCode build verification has not started.');
      log('MoreLogin local API unavailable (MORELOGIN_UNREACHABLE) and no MoreLogin browser processes found; continuing OpenCode build verification without profile port exclusions. Native browser attachment still requires verified serves.');
      return [];
    }
    throw profileError('MORELOGIN_LIST_UNREADABLE', `MoreLogin profile listing failed: ${moreLoginFailureDetail(error)}. OpenCode build verification has not started.`);
  }
  if (!Array.isArray(live) || live.moreloginError || live.some(p => !p?.id)) throw profileError('MORELOGIN_LIST_UNREADABLE', 'MoreLogin profile listing is malformed or incomplete.');
  const byId = new Map(live.map(p => [String(p.id), p]));
  for (const id of requested) if (!byId.has(String(id))) throw profileError('MORELOGIN_PROFILE_MISSING', `Explicitly requested MoreLogin profile ${id} is missing.`, String(id));
  return profiles.flatMap(profile => {
    const row = byId.get(profile.envId);
    if (row) return [!profile.name && row.name ? { ...profile, name: row.name } : profile];
    log(`Skipping stale MoreLogin profile ${profile.envId}: absent from the complete live listing.`);
    return [];
  });
}

export async function preflightExcludedPorts(profiles, readDetail) {
  const ports = new Set();
  for (const profile of profiles) {
    const name = profile.name ? `${profile.name} (${profile.envId})` : profile.envId;
    let policy, detail = 'malformed port protection policy';
    try { policy = portProtectionOf(await readDetail(profile.envId)); } catch (error) { detail = moreLoginFailureDetail(error); }
    if (!policy) throw profileError('MORELOGIN_POLICY_UNREADABLE', `MoreLogin profile ${name}: port protection could not be read from /api/env/detail (${detail}). Check the MoreLogin local API and try again; OpenCode build verification has not started.`, profile.envId);
    if (!policy.enabled) throw profileError('MORELOGIN_POLICY_DISABLED', `MoreLogin profile ${name}: Port scan protection is off. Edit profile → Advanced settings → Port scan protection: Enable, then retry OpenCode build verification.`, profile.envId);
    for (const port of policy.ports) ports.add(port);
  }
  return ports;
}

// The OS reserves a random loopback port until the moment before spawn. A competing process that wins that small
// release/spawn race cannot pass the boundary's process-bound probe and is never signalled by the pre-flight.
export async function reservePreflightPort(excluded) {
  for (let attempt = 0; attempt < 128; attempt++) {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const release = () => new Promise(resolve => server.close(resolve));
    if (!excluded.has(port)) return { port, release };
    await release();
  }
  throw new Error('No random port outside the MoreLogin allow lists was available for OpenCode build verification');
}

/** track/verify/stop are the same boundary operations used for normal serves; stop confirms listener removal. */
export async function runOpencodeBuildPreflight(info, { excludedPorts = new Set(), track, verify, stop,
  spawnProcess = spawn, reservePort = reservePreflightPort, startupMs = 15_000 } = {}) {
  const reservation = await reservePort(excludedPorts);
  let dir, proc, released = false, stopped = true;
  try {
    dir = mkdtempSync(join(tmpdir(), 'synabun-opencode-preflight-'));
    for (const sub of ['home', 'config/opencode', 'data', 'state', 'cache', 'work']) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, 'config/opencode/opencode.json'), '{"autoupdate":false,"share":"disabled","snapshots":false}');
    const env = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: join(dir, 'home'), USERPROFILE: join(dir, 'home'), XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_DATA_HOME: join(dir, 'data'), XDG_STATE_HOME: join(dir, 'state'), XDG_CACHE_HOME: join(dir, 'cache'),
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' };
    const spec = serveSpecFor(reservation.port, { passwordFrom: 'stdout', env });
    await reservation.release(); released = true;
    proc = spawnProcess(info.identity.realpath, spec.args, { cwd: join(dir, 'work'), env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    track(proc, { ...info, port: reservation.port, safe: true });
    const read = servePasswordReader();
    let password = null, error = null;
    proc.on('error', e => { error = e; });
    proc.stdout?.on('data', chunk => { password = read(chunk) || password; });
    proc.stderr?.resume(); // Drain, never log raw output (it can contain a private password).
    const until = Date.now() + startupMs;
    while (!password && !error && proc.exitCode == null && proc.signalCode == null && Date.now() < until) await new Promise(r => setTimeout(r, 25));
    if (!password) throw new Error(error ? 'OpenCode build verification could not start the executable' : 'OpenCode build verification did not receive a private stdout password');
    return await verify(proc, { pid: proc.pid, password });
  } finally {
    if (!released) await reservation.release();
    if (proc) stopped = await stop(proc);
    // If termination cannot be confirmed, keep its state folder and the boundary's exposure record.
    if (dir && stopped) rmSync(dir, { recursive: true, force: true });
    if (!stopped) throw new Error(`OpenCode build verification could not confirm its throwaway serve stopped on port ${reservation.port}`);
  }
}
