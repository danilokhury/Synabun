// Persistent PATH changes happen only after Add to PATH or Install. Never at
// detection/spawn time. Dependencies are injectable: tests use temp homes and
// a fake reg.exe, and never change the host's PATH or startup files.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandWindowsVars, parseRegQuery, runRegQuery, splitPathValue, osPath as defaultReader } from './os-path.js';
import { withPathEnv } from './augmented-path.js';

export const PATH_BEGIN = '# >>> SynaBun PATH >>>';
export const PATH_END = '# <<< SynaBun PATH <<<' ;
export const ENVIRONMENT_BROADCAST = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SynaBunEnvironment { [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result); }'; $result = [UIntPtr]::Zero; if ([SynaBunEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$result) -eq [IntPtr]::Zero) { throw 'Environment broadcast timed out or failed' }`;

export function pathContains(entries, dir, platform = process.platform, env = process.env) {
  const key = value => {
    let text = String(value || '').trim().replace(/^"(.*)"$/, '$1');
    if (platform === 'win32') text = expandWindowsVars(text, env).replace(/\//g, '\\').toLowerCase();
    return text.replace(/[\\/]+$/, '') || '/';
  };
  return entries.some(entry => key(entry) === key(dir));
}

const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const fishQuote = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Replace only our marked block; preserve all other bytes and existing mode/symlinks. */
export function updatePathBlock(file, dir, { fish = false } = {}) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const start = text.indexOf(PATH_BEGIN);
  const end = start < 0 ? -1 : text.indexOf(PATH_END, start);
  if (start >= 0 && end < 0) throw new Error(`Incomplete SynaBun PATH block in ${file}; repair its closing marker first.`);
  const oldBlock = start < 0 ? '' : text.slice(start, end + PATH_END.length);
  const dirs = [];
  for (const match of oldBlock.matchAll(/^# path: (.+)$/gm)) {
    try { const value = JSON.parse(match[1]); if (typeof value === 'string') dirs.push(value); } catch { /* no generated entry */ }
  }
  if (!dirs.includes(dir)) dirs.push(dir);
  // Shell code needs LF even when surrounding comments/dotfile bytes use CRLF.
  const eol = '\n';
  const lines = [PATH_BEGIN, ...dirs.map(value => `# path: ${JSON.stringify(value)}`)];
  for (const value of dirs) lines.push(fish
    ? `fish_add_path --append --path ${fishQuote(value)}`
    : `case ":\$PATH:" in *:${quote(value)}:*) ;; *) export PATH="\$PATH":${quote(value)} ;; esac`);
  lines.push(PATH_END);
  const block = lines.join(eol);
  const next = start < 0 ? text + (text && !text.endsWith('\n') ? eol : '') + block + eol : text.slice(0, start) + block + text.slice(end + PATH_END.length);
  if (next === text) return false;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 });
  return true;
}

export function shellPathFiles({ env = process.env, home = env.HOME || os.homedir(), platform = process.platform } = {}) {
  const shell = path.posix.basename(env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'));
  if (shell === 'fish') return [{ file: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'conf.d', 'synabun.fish'), fish: true }];
  if (shell === 'zsh') {
    const root = env.ZDOTDIR || home;
    const rc = path.join(root, '.zshrc');
    const profile = path.join(root, '.zprofile');
    let loginSourcesRc = false;
    try { loginSourcesRc = /^\s*(?:source|\.)\s+[^\n#]*\.zshrc(?:["']|\s|$)/m.test(readFileSync(profile, 'utf8')); } catch { /* absent */ }
    // CLI wrappers are non-interactive login shells: they need .zprofile
    // unless it already sources .zshrc. Terminal.app reads .zshrc as well.
    return [{ file: rc }, ...loginSourcesRc ? [] : [{ file: profile }]];
  }
  if (shell === 'bash' || shell === 'sh') {
    const login = ['.bash_profile', '.bash_login', '.profile'].map(name => path.join(home, name)).find(existsSync)
      || path.join(home, platform === 'darwin' ? '.bash_profile' : '.profile');
    return [{ file: path.join(home, '.bashrc') }, { file: login }];
  }
  return [];
}

export function createCliPathManager({ platform = process.platform, env = process.env, home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir(), reader = defaultReader, execFileImpl = execFile, onChanged = () => {} } = {}) {
  let tail = Promise.resolve(); // serialize read/append/write across tools
  const execute = (file, args) => new Promise((resolve, reject) => {
    try { execFileImpl(file, args, { env: withPathEnv(env, undefined, platform), encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout || ''))); }
    catch (error) { reject(error); }
  });
  function inspect(status, snapshot = reader.snapshot()) {
    const dir = status?.path ? (platform === 'win32' ? path.win32 : path.posix).dirname(status.path) : null;
    const onPath = dir && snapshot.ok ? pathContains(snapshot.entries, dir, platform, env) : null;
    return { dir, onPath, canAdd: !!dir && status?.state === 'installed' && onPath === false && (platform === 'win32' || shellPathFiles({ env, home, platform }).length > 0) };
  }
  async function addNow(status) {
    if (status?.state !== 'installed' || !status.path) throw Object.assign(new Error('No installed CLI was resolved.'), { status: 409 });
    await reader.refresh({ force: true });
    const state = inspect(status);
    if (state.onPath === true) return { ...state, added: false, changed: false, files: [], warning: null };
    if (state.onPath == null) throw new Error('The persistent PATH could not be read. Re-check and try again.');
    const dir = state.dir;
    if (/[\r\n\0]/.test(dir) || (platform === 'win32' && /[;"%]/.test(dir)) || (platform !== 'win32' && dir.includes(':'))) throw new Error('This CLI folder cannot be represented safely in PATH.');
    let files = [];
    let warning = null;
    let changed = false;
    if (platform === 'win32') {
      const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
      const reg = path.win32.join(root, 'System32', 'reg.exe');
      let raw;
      try { raw = parseRegQuery(await runRegQuery('HKCU\\Environment', { env: withPathEnv(env, undefined, platform), execFileImpl })); }
      catch {
        // A missing Path is safe to create only if the key itself can be read.
        raw = parseRegQuery(await execute(reg, ['query', 'HKCU\\Environment']));
      }
      if (raw && pathContains(splitPathValue(raw.value, 'win32'), dir, 'win32', env)) return { ...state, onPath: true, added: false, changed: false, files: [], warning: null };
      const value = raw?.value ? `${raw.value}${raw.value.endsWith(';') ? '' : ';'}${dir}` : dir;
      await execute(reg, ['add', 'HKCU\\Environment', '/v', 'Path', '/t', raw?.type || 'REG_EXPAND_SZ', '/d', value, '/f']);
      changed = true;
      files = ['HKCU\\Environment\\Path'];
      try { await execute(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ENVIRONMENT_BROADCAST]); }
      catch (error) { warning = `PATH saved; environment broadcast failed: ${error.message}`; }
    } else {
      const targets = shellPathFiles({ env, home, platform });
      if (!targets.length) throw Object.assign(new Error('This shell has no supported PATH startup file.'), { status: 422 });
      for (const target of targets) if (updatePathBlock(target.file, dir, target)) { files.push(target.file); changed = true; }
    }
    reader.invalidate();
    await reader.refresh({ force: true });
    onChanged();
    return { dir, onPath: true, added: changed, changed, files, warning };
  }
  function add(status) {
    const result = tail.then(() => addNow(status));
    tail = result.catch(() => {});
    return result;
  }
  return { inspect, add };
}
