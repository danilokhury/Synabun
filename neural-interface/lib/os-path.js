// ═══════════════════════════════════════════
// SynaBun — the OS PATH a new terminal would get
// ═══════════════════════════════════════════
//
// A process keeps the PATH it was started with. SynaBun started from Finder,
// the Dock, the Start menu or a login item got the desktop's PATH, often
// without ~/.local/bin or Homebrew; started before a CLI was installed, it
// never sees the folder the installer added. This reads the PATH the
// operating system would give a terminal opened now:
//
//   Windows        the machine PATH, then the user PATH, from the registry
//                  (`reg query`; REG_EXPAND_SZ expanded with this process's
//                  environment), which is how Windows builds a new process's
//                  PATH. No PowerShell.
//   macOS, Linux   the PATH the user's login shell ends up with
//                  (`$SHELL -i -l -c`, which runs .zprofile/.zshrc,
//                  .bash_profile/.bashrc: nvm, asdf, mise, fnm, Homebrew's
//                  shellenv), started from the launchd default PATH, in a
//                  session of its own with no terminal, under a short timeout;
//                  on macOS also /etc/paths and /etc/paths.d
//
// The answer is cached briefly (`ttlMs`), read again in the background when it
// goes stale, and handed to augmented-path.js (rememberOsPath), whose PATH
// every lookup and spawn of a user's CLI uses. Re-check reads it again at once
// (refresh({ force: true })). A failed read keeps the previous answer and is
// retried sooner. Nothing here throws.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rememberOsPath } from './augmented-path.js';

/** Where Windows keeps PATH: the machine's, then the user's (the order Windows joins them in). */
export const WINDOWS_PATH_KEYS = Object.freeze([
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
]);

/** The PATH launchd gives an app on macOS (and a sane start on Linux): what a new terminal's shell begins from. */
export const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** Shells that take `-i -l -c`. Others (csh, nu, xonsh, pwsh …) are read through /bin/sh -l. */
const INTERACTIVE_LOGIN_SHELLS = new Set(['bash', 'zsh', 'ksh', 'ksh93', 'mksh', 'fish', 'yash']);
const LOGIN_ONLY_SHELLS = new Set(['sh', 'dash']);
const MAX_SHELL_OUTPUT = 1024 * 1024;

export function splitPathValue(value, platform = process.platform) {
  return String(value || '').split(platform === 'win32' ? ';' : ':')
    .map(entry => platform === 'win32' ? entry.trim().replace(/^"(.*)"$/, '$1').trim() : entry.trim())
    .filter(Boolean);
}

export function dedupePath(entries, platform = process.platform) {
  const seen = new Set();
  return entries.filter((entry) => {
    const text = String(entry || '').trim();
    if (!text) return false;
    const key = platform === 'win32' ? text.toLowerCase().replace(/[\\/]+$/, '') : text.replace(/\/+$/, '') || '/';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The Path value in what `reg query <key> /v Path` prints:
 *
 *   HKEY_CURRENT_USER\Environment
 *       Path    REG_EXPAND_SZ    %USERPROFILE%\AppData\Local\Microsoft\WindowsApps;C:\Users\you\.local\bin
 *
 * → { type: 'REG_EXPAND_SZ', value: '…' }, or null when there is none.
 */
export function parseRegQuery(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s+(\S+)\s+(REG_EXPAND_SZ|REG_SZ)(?:\s+(.*))?$/i);
    if (match && match[1].toLowerCase() === 'path') return { type: match[2].toUpperCase(), value: (match[3] || '').trim() };
  }
  return null;
}

/** %NAME% replaced from `env` (names compared without case, as Windows does); unknown names stay as written. */
export function expandWindowsVars(value, env = process.env) {
  const lookup = new Map(Object.entries(env || {}).map(([name, val]) => [name.toUpperCase(), val]));
  return String(value || '').replace(/%([^%;]+)%/g, (whole, name) => {
    const found = lookup.get(name.toUpperCase());
    return found == null || found === '' ? whole : String(found);
  });
}

function decodeUtf8(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; }
}

/**
 * `reg query <key> /v Path`, its output as text. reg.exe writes in the
 * console's code page; a folder name outside ASCII (C:\Users\João) is then not
 * UTF-8, and the query is asked again through a console switched to UTF-8
 * (chcp 65001). Fixed strings only: nothing of a request reaches either line.
 */
export async function runRegQuery(key, { env = process.env, timeoutMs = 3000, execFileImpl = execFile } = {}) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const reg = path.win32.join(systemRoot, 'System32', 'reg.exe');
  const comspec = env.ComSpec || env.COMSPEC || path.win32.join(systemRoot, 'System32', 'cmd.exe');
  const run = (file, args, extra = {}) => new Promise((resolve) => {
    try {
      execFileImpl(file, args, { encoding: 'buffer', timeout: timeoutMs, windowsHide: true, env, maxBuffer: 1024 * 1024, ...extra }, (error, stdout) => {
        resolve({ error, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || '')) });
      });
    } catch (error) {
      resolve({ error, stdout: Buffer.alloc(0) });
    }
  });
  const first = await run(reg, ['query', key, '/v', 'Path']);
  if (!first.stdout.length) throw first.error || new Error('reg.exe printed nothing');
  const text = decodeUtf8(first.stdout);
  if (text !== null) return text;
  const second = await run(comspec, ['/d', '/s', '/c', `"chcp 65001 >nul & "${reg}" query "${key}" /v Path"`], { windowsVerbatimArguments: true });
  return (second.stdout.length && decodeUtf8(second.stdout)) || first.stdout.toString('latin1');
}

/** The registry's PATH: machine entries, then user entries, each once. */
export async function readWindowsPath({ env = process.env, query = runRegQuery, timeoutMs = 3000 } = {}) {
  const entries = [];
  const sources = [];
  const errors = [];
  for (const key of WINDOWS_PATH_KEYS) {
    try {
      const found = parseRegQuery(await query(key, { env, timeoutMs }));
      if (found) {
        const part = splitPathValue(expandWindowsVars(found.value, env), 'win32');
        entries.push(...part);
        sources.push(...part.map(dir => ({ dir, source: key.startsWith('HKLM') ? 'system' : 'user' })));
      }
    } catch (error) {
      errors.push(`${key}: ${String(error?.message || error).split(/\r?\n/)[0]}`);
    }
  }
  return { entries: dedupePath(entries, 'win32'), sources, ok: entries.length > 0, errors };
}

/** The user's login shell: $SHELL, else the account's (a launchd- or desktop-started app may have no SHELL). */
export function loginShellOf({ env = process.env, userInfo = () => os.userInfo() } = {}) {
  if (env.SHELL) return env.SHELL;
  try { return userInfo()?.shell || null; } catch { return null; }
}

/**
 * How to ask `shell` for the PATH a login session ends with. The PATH is
 * printed on a line of its own between two marker lines, so whatever the
 * startup files print around it (banners, warnings) is ignored.
 */
export function loginShellCommand(shell, marker) {
  const name = path.posix.basename(String(shell || '')).toLowerCase();
  const script = `printf '%s\\n' '${marker}' "$PATH" '${marker}'`;
  if (INTERACTIVE_LOGIN_SHELLS.has(name)) return { file: shell, args: ['-i', '-l', '-c', script] };
  if (LOGIN_ONLY_SHELLS.has(name)) return { file: shell, args: ['-l', '-c', script] };
  return { file: '/bin/sh', args: ['-l', '-c', script] };
}

/** The PATH line between the two markers, or null. */
export function parseLoginShellOutput(text, marker) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i + 2 < lines.length; i++) {
    if (lines[i] === marker && lines[i + 2] === marker) return lines[i + 1];
  }
  return null;
}

/**
 * The PATH the user's login shell builds. Started in a session of its own
 * (detached: no controlling terminal, so a startup file cannot wait on
 * /dev/tty), from the launchd default PATH, in the home folder; killed with
 * its whole group after `timeoutMs`.
 */
export function readLoginShellPath({
  env = process.env,
  platform = process.platform,
  shell = loginShellOf({ env }),
  spawnImpl = spawn,
  timeoutMs = 4000,
  home = env.HOME || os.homedir(),
} = {}) {
  return new Promise((resolve) => {
    const marker = `SYNABUN_PATH_${randomBytes(6).toString('hex').toUpperCase()}`;
    const command = loginShellCommand(shell || '/bin/sh', marker);
    const childEnv = { ...env, PATH: LAUNCHD_PATH, TERM: 'dumb' };
    let child = null;
    let out = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ shell: command.file, ...result });
    };
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child?.kill('SIGKILL'); } catch { /* gone */ } }
    };
    try {
      child = spawnImpl(command.file, command.args, { env: childEnv, cwd: home, stdio: ['ignore', 'pipe', 'ignore'], detached: platform !== 'win32' });
    } catch (error) {
      return finish({ entries: [], ok: false, error: `${command.file} could not be started: ${error?.message || error}` });
    }
    timer = setTimeout(() => {
      killGroup();
      finish({ entries: [], ok: false, error: `${command.file} did not answer within ${Math.round(timeoutMs / 100) / 10} s` });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => finish({ entries: [], ok: false, error: `${command.file} could not be started: ${error?.message || error}` }));
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      out += chunk;
      if (out.length > MAX_SHELL_OUTPUT) {
        killGroup();
        finish({ entries: [], ok: false, error: `${command.file} printed too much` });
      }
    });
    child.on('close', () => {
      const line = parseLoginShellOutput(out, marker);
      if (line == null) return finish({ entries: [], ok: false, error: `${command.file} did not print a PATH` });
      finish({ entries: dedupePath(splitPathValue(line, platform), platform), ok: true, error: null });
    });
  });
}

/** macOS's /etc/paths, then each file of /etc/paths.d in name order (what path_helper builds a login PATH from). */
export function readEtcPaths({ readFile = readFileSync, readdir = readdirSync } = {}) {
  const out = [];
  const take = (file) => {
    try {
      for (const line of String(readFile(file, 'utf8')).split(/\r?\n/)) {
        const entry = line.trim();
        if (entry && !entry.startsWith('#')) out.push(entry);
      }
    } catch { /* not there */ }
  };
  take('/etc/paths');
  let names = [];
  try { names = readdir('/etc/paths.d').map(String).sort(); } catch { /* not there */ }
  for (const name of names) take(`/etc/paths.d/${name}`);
  return out;
}

/**
 * A cached reader of the OS PATH. `cached()` answers at once (and starts a
 * read in the background when the answer is stale); `refresh()` waits for one.
 */
export function createOsPathReader({
  platform = process.platform,
  env = process.env,
  ttlMs = 60_000,
  failureTtlMs = 15_000,
  readWindows = readWindowsPath,
  readLoginShell = readLoginShellPath,
  readEtc = readEtcPaths,
  remember = rememberOsPath,
  now = Date.now,
} = {}) {
  let state = { entries: [], at: 0, ok: false, source: null, error: null, shell: null };
  let inflight = null;

  async function read() {
    if (env.SYNABUN_TOOL_DISCOVERY === 'path') return { entries: [], ok: true, source: 'off', error: null, shell: null };
    if (platform === 'win32') {
      const found = await readWindows({ env });
      return { entries: found.entries, sources: found.sources || [], ok: found.ok, source: 'registry', error: found.errors?.length ? found.errors.join('; ') : null, shell: null };
    }
    const found = await readLoginShell({ env, platform });
    const etc = platform === 'darwin' ? readEtc() : [];
    const entries = dedupePath([...(found.entries || []), ...etc], platform);
    return {
      entries,
      ok: !!found.ok,
      source: found.ok ? 'login-shell' : etc.length ? 'etc-paths' : 'none',
      error: found.error || null,
      shell: found.shell || null,
    };
  }

  function snapshot() {
    return { entries: state.entries.slice(), sources: (state.sources || []).map(entry => ({ ...entry })), at: state.at, ok: state.ok, source: state.source, error: state.error, shell: state.shell };
  }

  function stale() {
    return !state.at || now() - state.at >= (state.ok ? ttlMs : failureTtlMs);
  }

  function refresh({ force = false } = {}) {
    if (inflight) return inflight;
    if (!force && !stale()) return Promise.resolve(snapshot());
    inflight = (async () => {
      let result;
      try { result = await read(); } catch (error) { result = { entries: [], ok: false, source: 'none', error: String(error?.message || error), shell: null }; }
      // A read that failed keeps what an earlier one found.
      const entries = result.ok || !state.entries.length ? result.entries : state.entries;
      state = { ...result, entries, at: now() };
      try { remember(entries); } catch { /* nothing to tell */ }
      return snapshot();
    })().finally(() => { inflight = null; });
    return inflight;
  }

  function cached() {
    if (stale() && !inflight) refresh().catch(() => {});
    return state.entries.slice();
  }

  function invalidate() {
    state = { ...state, at: 0 };
  }

  return { refresh, cached, invalidate, snapshot, stale };
}

/** This process's reader (server.js starts it at boot; Re-check forces it). */
export const osPath = createOsPathReader();
