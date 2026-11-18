// ═══════════════════════════════════════════
// SynaBun — Teams: the integration tests under the worker sandbox (Agents system, phase P4)
// ═══════════════════════════════════════════
//
// A team's test command runs on each commit of the integration branch (lib/teams/integration.js). What it runs is
// the team's work: code several workers wrote, each held to its own worktree while it wrote it. The default runner
// (lib/teams/test-runner.js) starts it with the server's own rights, which would hand that code what its authors
// never had: SynaBun's control port (and with it the owner's authority), SynaBun's data home, and the owner's
// checkout of the project.
//
// So the scheduler's runner starts the command the way a protected worker's process tree is started
// (lib/worker-sandbox.js): on macOS, under sandbox-exec with a profile that blocks SynaBun's own port and its
// reserved relay ports on every address, blocks reads and writes of SynaBun's data home, and lets the command
// write in the project only inside the team's integration worktree (the owner's checkout and the slices'
// worktrees stay as they are, whatever a test does). The internet, reads elsewhere, the temp folder and the
// toolchains' own caches work as normal, so the project's tests run as they do for a worker.
//
// NOT EQUIVALENT OFF macOS. Where sandbox-exec is not there (Linux, Windows, a Mac without it) the command runs
// with the default runner, unconfined, and every result says so (`sandbox: 'none'`, with why).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_EXEC, buildWorkerSandboxProfile, canonicalPath, sandboxExecAvailable, sandboxSupported } from '../worker-sandbox.js';
import { createTestRunner } from './test-runner.js';

const sexpr = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The Seatbelt profile of one test run: the worker profile (ports, the data home), then the project's own files:
 * written only inside the integration worktree.
 * @param {object} o
 * @param {string} o.projectPath     the project (the owner's checkout is its root)
 * @param {string} o.cwd             the integration worktree
 * @param {number|null} [o.serverPort]
 * @param {{ from: number, to: number }|null} [o.reservedPortRange]
 * @param {string[]} [o.denyPaths]   trees the command neither reads nor writes (SynaBun's data home)
 * @param {string} [o.note]
 */
export function teamTestProfile({ projectPath, cwd, serverPort = null, reservedPortRange = null, denyPaths = [], note = '' } = {}) {
  const base = buildWorkerSandboxProfile({
    denyPorts: Number(serverPort) > 0 ? [Number(serverPort)] : [],
    denyPortRange: reservedPortRange || null,
    denyPaths, allowPaths: [], note,
  });
  const lines = [base.replace(/\n+$/, '')];
  if (projectPath) {
    lines.push('; the project: written only inside the team\'s integration worktree');
    lines.push(`(deny file-write* (subpath ${sexpr(canonicalPath(projectPath))}))`);
    if (cwd) lines.push(`(allow file-write* (subpath ${sexpr(canonicalPath(cwd))}))`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A test-command runner for createTeams({ runTests }) that confines the command where the platform can.
 *
 * @param {object} [o]
 * @param {() => number|null} [o.serverPort]            SynaBun's own port
 * @param {() => ({ from: number, to: number }|null)} [o.reservedPortRange]  the ports SynaBun keeps for its serves
 * @param {() => string[]} [o.denyPaths]                trees the tests must not read or write (the data home)
 * @param {string} o.profileDir                         where the profiles are written (a folder of SynaBun's own)
 * @param {Function} [o.base]                           the runner that starts the command (default: createTestRunner())
 * @param {string} [o.platform]
 * @param {() => boolean} [o.available]                 is sandbox-exec usable (default: the boot probe)
 * @param {(tag: string, detail: any) => void} [o.log]
 */
export function createSandboxedTestRunner({
  serverPort = () => null, reservedPortRange = () => null, denyPaths = () => [], profileDir,
  base = createTestRunner(), platform = process.platform, available = () => sandboxExecAvailable(), log = () => {},
} = {}) {
  let warned = false;
  return async function runTests(run = {}) {
    const text = typeof run.command === 'string';
    const usable = sandboxSupported(platform) && (() => { try { return available() === true; } catch { return false; } })();
    // No command (or no folder): nothing to confine; the base runner says what is missing.
    const has = text ? run.command.trim().length > 0 : Array.isArray(run.command) && run.command.length > 0;
    if (!usable || !profileDir || !run.cwd || !has) {
      if (!usable && !warned) { warned = true; try { log('teams:tests-unconfined', `sandbox-exec is not available on ${platform}: integration tests run unconfined`); } catch { /* a log never stops a test */ } }
      const out = await base(run);
      return { ...out, sandbox: 'none', sandboxNote: usable ? 'no profile folder' : `sandbox-exec is not available on ${platform}` };
    }
    let profilePath = null;
    try {
      mkdirSync(profileDir, { recursive: true });
      profilePath = join(profileDir, `${String(run.teamId || 'team').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)}.sb`);
      writeFileSync(profilePath, teamTestProfile({
        projectPath: run.projectPath || null, cwd: run.cwd, serverPort: serverPort(), reservedPortRange: reservedPortRange(),
        denyPaths: denyPaths() || [], note: `synabun team tests ${run.teamId || ''} ${run.sliceId || ''}`.trim(),
      }), { mode: 0o600 });
    } catch (error) {
      // Never unconfined because a profile could not be written: the run counts as failed, and says why.
      return { ok: false, exitCode: null, signal: null, timedOut: false, output: '', durationMs: 0, sandbox: 'failed', error: `the test sandbox profile could not be written: ${error?.message || error}` };
    }
    // Text is what the owner would type: it goes through the shell, inside the sandbox. A list is started directly.
    const argv = text ? [SANDBOX_EXEC, '-f', profilePath, '/bin/sh', '-c', run.command] : [SANDBOX_EXEC, '-f', profilePath, ...run.command];
    const out = await base({ ...run, command: argv });
    return { ...out, sandbox: 'seatbelt' };
  };
}
