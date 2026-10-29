// ═══════════════════════════════════════════
// SynaBun — dispatched workers across a server restart
// ═══════════════════════════════════════════
//
// A worker's provider process is a child of the Neural Interface, so every
// restart of the server (`node --watch` on an edit of its code, an in-app
// restart, an update, Ctrl+C, a crash) used to end the run as interrupted. The
// dispatcher (assistant-dispatch.js) now suspends such a run at the shutdown and
// resumes its provider session on the next start, as the same run. This module is
// what that decision and the resume need besides the dispatcher's own state:
//
//   resumeRefusal     why a run may not be resumed, or null
//   readCostState     what the resumed CLI restores from its transcript (its cost
//                     counter and per-model usage), so its first turn is charged
//                     only for itself
//   endOrphanProcess  a CLI that outlived its server (a crash: no shutdown ended
//                     it), ended only once its command line shows it is that run's
//
// Measured with the SDK and the Claude Code SynaBun runs (0.3.288 / 2.1.310):
// a session whose CLI was killed in the middle of a tool call resumes, the CLI
// records that call as interrupted with its outcome unknown, and the next model
// call goes through; a CLI that gets SIGTERM ends the tool's process tree,
// records the call's result and its cost state, and exits within a second.

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** A run is resumed when the server is back within this long of its last update, and at most this many times. */
export const RESUME_WINDOW_MS = 15 * 60_000;
export const MAX_RESUMES = 3;

/** Rebuild OS isolation without dropping an earlier denial or relaxing strict local networking.
 * The channel is a fresh listener/token each boot; only that listener replaces the old allow-port.
 */
export function resumeSandboxPlan(current, previous, channelPort) {
  if (!current || !previous) throw new Error('the original worker confinement is unavailable');
  const paths = (a) => [...new Set(a || [])].sort();
  if (JSON.stringify(paths(current.allowPaths)) !== JSON.stringify(paths(previous.allowPaths))) {
    throw new Error('the worker confinement folders changed');
  }
  const ranges = [current.denyPortRange, previous.denyPortRange].filter(Boolean);
  return {
    ...current,
    denyPorts: [...new Set([...(current.denyPorts || []), ...(previous.denyPorts || [])])],
    denyLocalPorts: [...new Set([...(current.denyLocalPorts || []), ...(previous.denyLocalPorts || [])])],
    denyPaths: [...new Set([...(current.denyPaths || []), ...(previous.denyPaths || [])])],
    denyPortRange: ranges.length ? { from: Math.min(...ranges.map(r => r.from)), to: Math.max(...ranges.map(r => r.to)) } : null,
    strictLocal: previous.strictLocal || current.strictLocal ? { allowPorts: [channelPort].filter(Boolean) } : null,
  };
}

/**
 * Why `entry` (a dispatcher registry entry) cannot be resumed, or null. `atShutdown`: only what is known while the
 * server goes down (the rest is checked at the next start: the time it was away, its folder, its account).
 *
 * @param {object} entry
 * @param {object} o
 * @param {number} [o.now]
 * @param {number} [o.workLeftMs]  the run's work time left (max_minutes)
 * @param {boolean} [o.atShutdown]
 * @param {(path: string) => boolean} [o.isDirectory]
 * @param {(accountId: string) => string} [o.accountUnusable]  '' when the Claude account can be used
 */
export function resumeRefusal(entry, { now = Date.now(), workLeftMs = Infinity, atShutdown = false, isDirectory = () => true, accountUnusable = () => '' } = {}) {
  if (!entry) return 'the run is not known';
  if (!['claude-code', 'codex', 'opencode'].includes(entry.provider)) return 'this provider cannot continue after a restart';
  if (entry.confinement?.kind === 'skill-eval') return 'a skill evaluation run is a measurement and starts over instead';
  if (entry.confinement) return 'a skill drafting run is not resumed';
  if (entry.removedAt) return 'the run was removed';
  if (!(entry.provider === 'codex' ? entry.providerThreadId : entry.providerSessionId)) return `its ${entry.provider === 'codex' ? 'Codex thread' : entry.provider === 'opencode' ? 'OpenCode session' : 'Claude session'} had not started yet`;
  if (entry.provider === 'opencode' && !entry.resumeInfo?.persistentOpenCode) return 'its OpenCode session has no durable run data';
  const resumes = Number(entry.resumes) || 0;
  if (resumes >= MAX_RESUMES) return `it was resumed ${resumes} times already`;
  if (!(workLeftMs > 0)) return entry.maxMinutes ? `its ${entry.maxMinutes} minutes of work time are used up` : 'its work time is used up';
  if (atShutdown) return null;
  const since = Date.parse(entry.suspendedAt || '') || Date.parse(entry.updatedAt || '') || 0;
  if (since && now - since > RESUME_WINDOW_MS) return `the server was back ${Math.round((now - since) / 60_000)} minutes later (more than ${Math.round(RESUME_WINDOW_MS / 60_000)})`;
  if (!entry.cwd || !isDirectory(entry.cwd)) return `its working directory is gone (${entry.cwd || 'none'})`;
  let unusable = '';
  try { unusable = entry.provider === 'opencode' ? '' : String(accountUnusable((entry.provider === 'codex' ? entry.codexAccountId : entry.claudeAccountId) || 'default', entry.provider, entry) || ''); } catch (error) { unusable = error?.message || 'it could not be read'; }
  if (unusable) return `its ${entry.provider === 'codex' ? 'Codex' : 'Claude'} account (${entry.codexAccountId || entry.claudeAccountId || 'default'}) cannot be used: ${unusable}`;
  return null;
}

/** Whether `path` is `root` or inside it (both resolved; a missing path is compared as written). */
export function isInside(path, root) {
  if (!path || !root) return false;
  const real = (value) => { try { return realpathSync(value); } catch { return resolve(String(value)); } };
  const rel = relative(real(root), real(path));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/** "14:05": a time of day on this computer's clock, or '' for no time. */
export function clockTime(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * The transcript of a Claude session: <config dir>/projects/<project folder>/<sessionId>.jsonl, the config dir being
 * the run's account's (CLAUDE_CONFIG_DIR) or ~/.claude. Every project folder is looked in (the CLI names it after
 * the real path of the working directory). null when there is none.
 */
export function findClaudeTranscript({ sessionId, configDir = null, home = homedir() } = {}) {
  const id = String(sessionId || '');
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return null;
  const projects = join(configDir || join(home, '.claude'), 'projects');
  let folders = [];
  try { folders = readdirSync(projects, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name); } catch { return null; }
  for (const folder of folders) {
    const path = join(projects, folder, `${id}.jsonl`);
    try { if (statSync(path).isFile()) return path; } catch { /* not here */ }
  }
  return null;
}

/** The last `maxBytes` of a file as text (a partial first line is dropped). */
function readTail(path, maxBytes = 1024 * 1024) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; } finally { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } }
}

/**
 * The cost state a resumed CLI starts from: the last `cost-state` line of the session's transcript, which the CLI
 * writes when it exits cleanly (a SIGTERM included) and reads back when the session is resumed. →
 * { totalCostUsd, modelUsage } (modelUsage as result.modelUsage spells it), or null when there is none (a CLI that
 * was killed outright starts its counters at zero).
 */
export function readCostState(path, sessionId = null) {
  if (!path || !existsSync(path)) return null;
  const lines = readTail(path).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"cost-state"')) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== 'cost-state') continue;
    if (sessionId && row.sessionId && row.sessionId !== sessionId) continue;
    const total = Number(row.totalCostUSD);
    return {
      totalCostUsd: Number.isFinite(total) && total > 0 ? total : 0,
      modelUsage: row.modelUsage && typeof row.modelUsage === 'object' && !Array.isArray(row.modelUsage) ? row.modelUsage : null,
    };
  }
  return null;
}

/** Whether a process with this pid exists (one of another user's counts as existing). */
export function processExists(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  try { process.kill(id, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** The command line of a process, or null when it cannot be read (no such process, no `ps`, Windows without CIM). */
export function processCommandLine(pid, { platform = process.platform, run = execFileSync } = {}) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    if (platform === 'win32') {
      const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${id}").CommandLine`], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return String(out || '').trim() || null;
    }
    const out = run('ps', ['-o', 'command=', '-p', String(id)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out || '').trim() || null;
  } catch { return null; }
}

/**
 * A run's own Claude Code CLI: started by the Agent SDK (stream-json both ways) with the run's id in its SynaBun MCP
 * headers (X-Synabun-Terminal). Anything else with the pid is left alone.
 */
export function isRunCliCommand(command, runId) {
  const text = String(command || '');
  return !!runId && text.includes(String(runId)) && ((text.includes('--input-format') && text.includes('stream-json')) || (text.includes('app-server') && text.includes('synabun_worker_run=')));
}

/** Windows: end a process and every process it started (taskkill /T /F, as the server's own shutdown does). */
export function endProcessTree(pid, { run = execFileSync } = {}) {
  run('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true, stdio: 'ignore' });
}

/**
 * End the CLI a run had before the server went down, when it is still there (a crash ended no process). It is ended
 * only when its command line shows it is that run's CLI: SIGTERM, then SIGKILL after `graceMs` once the pid still
 * shows that command line (it may have gone to another process meanwhile). Windows has no SIGTERM (a signal stops the
 * CLI alone and leaves its tool's processes, a dev server keeps its port): the tree is ended with taskkill.
 * → { state: 'gone' | 'ended' | 'killed' | 'still_running' | 'not_ours' | 'unknown' }.
 * 'unknown': a process has the pid but its command line cannot be read, so it is not touched.
 */
export async function endOrphanProcess({ pid, runId, graceMs = 2000, platform = process.platform, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), readCommand = processCommandLine, exists = processExists, kill = (id, signal) => process.kill(id, signal), killTree = endProcessTree } = {}) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0 || id === process.pid || !exists(id)) return { state: 'gone' };
  const command = readCommand(id);
  // No command line: a process that exited meanwhile is gone; one still there is not touched.
  if (command === null) return { state: exists(id) ? 'unknown' : 'gone' };
  if (!isRunCliCommand(command, runId)) return { state: 'not_ours' };
  if (platform === 'win32') {
    try { killTree(id); } catch { /* gone meanwhile, or not allowed: checked below */ }
    for (let waited = 0; waited < graceMs; waited += 100) {
      await sleep(100);
      if (!exists(id)) return { state: 'killed' };
    }
    return { state: 'still_running' };
  }
  try { kill(id, 'SIGTERM'); } catch { /* gone meanwhile */ }
  for (let waited = 0; waited < graceMs; waited += 100) {
    await sleep(100);
    if (!exists(id)) return { state: 'ended' };
  }
  const again = readCommand(id);
  if (again === null) return { state: exists(id) ? 'still_running' : 'ended' };
  if (!isRunCliCommand(again, runId)) return { state: 'ended' };
  try { kill(id, 'SIGKILL'); } catch { /* gone meanwhile */ }
  await sleep(200);
  return { state: exists(id) ? 'still_running' : 'killed' };
}
