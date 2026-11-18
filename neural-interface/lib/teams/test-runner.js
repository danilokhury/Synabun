// ═══════════════════════════════════════════
// SynaBun — Teams: the default test-command runner
// ═══════════════════════════════════════════
//
// A team's test command is run on each commit of the integration branch, in the integration worktree, before a
// slice counts as joined (lib/teams/integration.js). The runner is injected there; this is the default one.
//
// It starts the command the owner configured, the way they would type it: text goes through the shell, a list of
// arguments is started directly. It runs with the server's own rights and is not sandboxed: the code it runs is the
// team's work, so a scheduler that wants the tests confined supplies its own runner. What it does keep away is
// SynaBun's own credentials: every SYNABUN_* and TYPESAFE_* variable is left out of the command's environment, and
// so is anything that would aim git at another repository.
//
// It answers, never throws: `{ ok, exitCode, signal, timedOut, output, durationMs }`. `output` is the end of what
// the command wrote (both streams), bounded.

import { spawn } from 'node:child_process';

export const TEAM_TEST_TIMEOUT_MS = 30 * 60_000;

const DROPPED_ENV = /^(?:SYNABUN_|TYPESAFE_|GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_COMMON_DIR$|GIT_NAMESPACE$|GIT_PREFIX$)/;

/** The environment a test command gets: the given one without SynaBun's own variables. */
export function testEnv(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) if (!DROPPED_ENV.test(name) && value !== undefined) out[name] = value;
  return out;
}

/**
 * @param {object} [options]
 * @param {object} [options.env]          the environment to start from (default: this process's)
 * @param {number} [options.timeoutMs]    how long one run may take (default 30 minutes)
 * @param {number} [options.outputBytes]  how much of the output's end is kept (default 16,000 characters)
 * @returns {(run: { cwd: string, command: string|string[], commit?: string, teamId?: string, sliceId?: string,
 *   signal?: AbortSignal, timeoutMs?: number }) => Promise<{ ok: boolean, exitCode: number|null, signal: string|null,
 *   timedOut: boolean, output: string, durationMs: number, error?: string }>}
 */
export function createTestRunner({ env = process.env, timeoutMs = TEAM_TEST_TIMEOUT_MS, outputBytes = 16_000 } = {}) {
  return function runTests({ cwd, command, signal = null, timeoutMs: limit = timeoutMs } = {}) {
    const started = Date.now();
    return new Promise((done) => {
      const text = typeof command === 'string';
      if (!cwd || (!text && !(Array.isArray(command) && command.length))) {
        done({ ok: false, exitCode: null, signal: null, timedOut: false, output: '', durationMs: 0, error: 'no test command, or no folder to run it in' });
        return;
      }
      let child;
      let tail = '';
      let timedOut = false;
      let settled = false;
      const keep = (chunk) => { tail = (tail + String(chunk)).slice(-outputBytes); };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', stop);
        done({ timedOut, output: tail, durationMs: Date.now() - started, ...result });
      };
      // The command and what it started: its own process group where the platform has one.
      const stop = () => {
        if (!child || child.exitCode !== null) return;
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* gone already */ }
        setTimeout(() => {
          try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* gone already */ }
        }, 5000).unref();
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1000, Number(limit) || timeoutMs));
      try {
        child = text
          ? spawn(command, { cwd, env: testEnv(env), shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
          : spawn(command[0], command.slice(1), { cwd, env: testEnv(env), shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      } catch (error) {
        finish({ ok: false, exitCode: null, signal: null, error: error?.message || String(error) });
        return;
      }
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      child.on('error', (error) => finish({ ok: false, exitCode: null, signal: null, error: error?.message || String(error) }));
      child.on('close', (code, sig) => finish({ ok: code === 0 && !timedOut, exitCode: code, signal: sig || null }));
      if (signal) {
        if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
      }
    });
  };
}
