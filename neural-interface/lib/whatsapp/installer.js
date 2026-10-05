// On-demand installer for the WhatsApp connector runtime (Baileys and its
// dependencies, libsignal among them — GPL-3.0, which is why none of it is
// ever in a SynaBun package.json).
//
// install():
//   checking     connector files present and matching manifest.json, npm found,
//                free disk, single-install lock (O_EXCL, stale lock broken)
//   downloading  copy the connector into runtime/whatsapp.staging (its
//                npm-shrinkwrap.json as package-lock.json) and run
//                `<node> <npm-cli.js> ci --omit=dev --omit=optional --ignore-scripts
//                 --legacy-peer-deps --no-audit --no-fund` (5-minute limit, minimal
//                env, cache in DATA_HOME/cache/npm) — the lockfile pins every
//                tarball by integrity, and no install script ever runs
//   verifying    the installed baileys version, then `node host.js --probe`
//                against the staging copy
//   activating   swap staging → runtime/whatsapp (the caller stops the host
//                first); a failed swap puts the old install back
//
// Lines from npm are redacted, streamed to onProgress and appended to
// DATA_HOME/data/whatsapp/install.log. Nothing is written outside the runtime
// folders, that log and the npm cache.

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, statfsSync,
  writeFileSync,
} from 'node:fs';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAugmentedPath } from '../augmented-path.js';
import { isInside, resolveWhatsAppPaths } from './paths.js';
import { redactWa } from './redact.js';

const CONNECTOR_DIR = fileURLToPath(new URL('./connector/', import.meta.url));
const HOST_PATH = fileURLToPath(new URL('./host.js', import.meta.url));

/**
 * The committed lockfile. npm never publishes a file named package-lock.json
 * or .npmrc in a package, so the lock ships under the name npm does publish and
 * is copied into staging as package-lock.json (STAGED_NAMES), which `npm ci`
 * reads; .npmrc is written from CONNECTOR_NPMRC.
 */
export const CONNECTOR_LOCK = 'npm-shrinkwrap.json';
/** The connector files that ship with SynaBun, all copied into the staging folder. */
export const CONNECTOR_FILES = Object.freeze(['package.json', CONNECTOR_LOCK, 'entry.mjs', 'manifest.json']);
/** Source name → name in the staging folder (everything else keeps its name). */
export const STAGED_NAMES = Object.freeze({ [CONNECTOR_LOCK]: 'package-lock.json' });
export const CONNECTOR_NPMRC = 'legacy-peer-deps=true\nignore-scripts=true\nfund=false\naudit=false\nupdate-notifier=false\n';
export const NPM_CI_ARGS = Object.freeze(['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund']);
export const INSTALL_CODES = Object.freeze([
  'NPM_NOT_FOUND', 'OFFLINE', 'REGISTRY_REFUSED', 'DISK_FULL', 'NO_PERMISSION', 'FILE_IN_USE', 'TIMEOUT', 'VERIFY_FAILED', 'INSTALL_BUSY', 'ABORTED', 'UNKNOWN',
]);

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
const LOCK_STALE_MS = 15 * 60_000;
const MIN_FREE_BYTES = 150 * 1024 * 1024;
const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;
const NPM_ENV_ALLOW = Object.freeze([
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'ComSpec', 'PATHEXT',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
]);

/** SHA-256 of the lockfile with line endings normalized (a CRLF checkout must not read as "outdated"). */
export function lockDigest(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Find npm without trusting PATH first:
 *   1. $npm_execpath when it is npm's own CLI
 *   2. realpath(node)/../lib/node_modules/npm/bin/npm-cli.js   (Unix prefix layout)
 *   3. dirname(node)/node_modules/npm/bin/npm-cli.js            (Windows layout)
 *   4. npm / npm.cmd on the augmented PATH (shell only on Windows)
 * @returns {{command:string, args:string[], shell:boolean, source:string} | null}
 */
export function resolveNpmCli({
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  exists = existsSync,
  realpath = realpathSync,
  augmentedPath = getAugmentedPath,
} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const candidates = [];
  const fromEnv = env.npm_execpath;
  if (typeof fromEnv === 'string' && /^npm-cli\.(?:c?js|mjs)$/i.test(p.basename(fromEnv))) candidates.push({ file: fromEnv, source: 'npm_execpath' });
  let real = execPath;
  try { real = realpath(execPath) || execPath; } catch {}
  candidates.push({ file: p.join(p.dirname(real), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), source: 'node-prefix' });
  candidates.push({ file: p.join(p.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), source: 'node-dir' });
  for (const c of candidates) {
    const file = p.normalize(c.file);
    if (exists(file)) return { command: execPath, args: [file], shell: false, source: c.source };
  }
  const bin = platform === 'win32' ? 'npm.cmd' : 'npm';
  const delimiter = platform === 'win32' ? ';' : ':';
  let searchPath = '';
  try { searchPath = String(augmentedPath() || ''); } catch {}
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    if (exists(p.join(dir, bin))) {
      return platform === 'win32'
        ? { command: bin, args: [], shell: true, source: 'path' }
        : { command: p.join(dir, bin), args: [], shell: false, source: 'path' };
    }
  }
  return null;
}

/** npm's stderr (or a spawn error) → one of INSTALL_CODES. */
export function mapNpmError(text) {
  const s = String(text || '');
  if (/ENOSPC|no space left on device|EDQUOT|disk quota exceeded/i.test(s)) return 'DISK_FULL';
  if (/EINTEGRITY|integrity checksum failed/i.test(s)) return 'VERIFY_FAILED';
  if (/EBUSY|resource busy or locked|being used by another process|EPERM[^\n]*\b(?:rename|unlink|rmdir|scandir)\b|operation not permitted, (?:rename|unlink|rmdir)/i.test(s)) return 'FILE_IN_USE';
  if (/EACCES|EPERM|permission denied|operation not permitted|EROFS|read-only file system/i.test(s)) return 'NO_PERMISSION';
  if (/\bE(?:401|403|404|418|429|5\d\d)\b|401 Unauthorized|403 Forbidden|404 Not Found|ERR_SSL|SELF_SIGNED_CERT|UNABLE_TO_(?:GET|VERIFY)_|CERT_(?:HAS_EXPIRED|UNTRUSTED|NOT_YET_VALID)|unable to verify the first certificate/i.test(s)) return 'REGISTRY_REFUSED';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up|getaddrinfo|network (?:request|connectivity|is unreachable)|request to \S+ failed|fetch failed/i.test(s)) return 'OFFLINE';
  if (/Cannot find module[^\n]*npm|npm: command not found|'npm' is not recognized|spawn \S*npm\S* ENOENT/i.test(s)) return 'NPM_NOT_FOUND';
  return 'UNKNOWN';
}

const MESSAGES = {
  NPM_NOT_FOUND: 'npm was not found next to Node.js or on the PATH',
  OFFLINE: 'the npm registry could not be reached — check the internet connection or proxy',
  REGISTRY_REFUSED: 'the npm registry refused the download (proxy, certificate or registry settings)',
  DISK_FULL: 'there is not enough free disk space',
  NO_PERMISSION: 'SynaBun is not allowed to write the WhatsApp runtime folder',
  FILE_IN_USE: 'a file in the WhatsApp runtime folder is in use — stop WhatsApp and try again',
  TIMEOUT: 'the install took longer than 5 minutes',
  VERIFY_FAILED: 'the downloaded connector did not pass verification',
  INSTALL_BUSY: 'another install is already running',
  ABORTED: 'the install was cancelled',
  UNKNOWN: 'the install failed',
};

function installError(code, message) {
  const err = new Error(message || MESSAGES[code] || code);
  err.code = code;
  return err;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * @param {object} o
 * @param {string} o.dataHome
 * @param {object} [o.paths]        resolveWhatsAppPaths() result
 * @param {Function} [o.spawnImpl]  child_process.spawn-compatible
 * @param {string} [o.connectorDir] source of the connector files (tests)
 * @param {string} [o.hostPath]     host.js used for the probe (tests)
 */
export function createWhatsAppInstaller({
  dataHome,
  paths = null,
  spawnImpl = nodeSpawn,
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  log = () => {},
  now = () => Date.now(),
  connectorDir = CONNECTOR_DIR,
  hostPath = HOST_PATH,
  exists = existsSync,
  realpath = realpathSync,
  augmentedPath = getAugmentedPath,
  timeoutMs = INSTALL_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof dataHome !== 'string' || !dataHome) throw new TypeError('createWhatsAppInstaller: dataHome is required');
  const p = path; // real filesystem paths are always host-native
  const wp = paths || resolveWhatsAppPaths({ dataHome, env, platform: process.platform });
  const runtimeRoot = p.dirname(wp.runtimeDir);
  const oldDir = `${wp.runtimeDir}.old`;
  const fake = env.SYNABUN_WHATSAPP_FAKE === '1';

  const say = (msg, level = 'info') => {
    try {
      if (typeof log === 'function') log(msg, level);
      else log?.[level]?.(msg);
    } catch {}
  };

  /** Never delete anything but our own runtime folders. */
  function rmOwned(dir) {
    const base = p.basename(dir);
    if (!isInside(dir, runtimeRoot, process.platform) || !/^whatsapp(?:\.staging|\.old)?$/.test(base)) {
      throw installError('UNKNOWN', `refusing to delete ${base}`);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }

  function appendLog(text) {
    try {
      mkdirSync(p.dirname(wp.installLogPath), { recursive: true, mode: 0o700 });
      appendFileSync(wp.installLogPath, text, { mode: 0o600 });
      const st = statSync(wp.installLogPath);
      if (st.size > LOG_MAX_BYTES) {
        const buf = readFileSync(wp.installLogPath);
        writeFileSync(wp.installLogPath, buf.subarray(buf.length - LOG_KEEP_BYTES));
      }
    } catch {}
  }

  function readManifest(dir = connectorDir) {
    const m = JSON.parse(readFileSync(p.join(dir, 'manifest.json'), 'utf8'));
    if (typeof m?.package !== 'string' || typeof m?.version !== 'string' || typeof m?.lockSha256 !== 'string') {
      throw installError('VERIFY_FAILED', 'the connector manifest is malformed');
    }
    return m;
  }

  function fileDigest(file) {
    return lockDigest(readFileSync(file, 'utf8'));
  }

  function readInstalled() {
    try {
      const info = JSON.parse(readFileSync(p.join(wp.runtimeDir, '.installed.json'), 'utf8'));
      return info && typeof info.version === 'string' ? info : null;
    } catch {
      return null;
    }
  }

  function status() {
    let manifest = null;
    try { manifest = readManifest(); } catch {}
    const pinned = manifest?.version ?? null;
    const approxSizeMB = manifest?.approxSizeMB ?? null;
    if (fake) return { installed: true, version: 'fake', pinned, outdated: false, path: null, installedAt: null, approxSizeMB };
    const info = readInstalled();
    const installed = !!info
      && existsSync(p.join(wp.runtimeDir, 'entry.mjs'))
      && existsSync(p.join(wp.runtimeDir, 'node_modules', 'baileys', 'package.json'));
    let entryDigest = null;
    try { entryDigest = fileDigest(p.join(connectorDir, 'entry.mjs')); } catch {}
    const outdated = installed && !!manifest && (
      info.version !== manifest.version
      || info.lockSha256 !== manifest.lockSha256
      || (!!entryDigest && !!info.entrySha256 && info.entrySha256 !== entryDigest)
    );
    return {
      installed,
      version: installed ? info.version : null,
      pinned,
      outdated,
      path: installed ? wp.runtimeDir : null,
      installedAt: installed ? info.installedAt ?? null : null,
      approxSizeMB,
    };
  }

  async function lockIsStale(lockPath) {
    let st;
    try { st = await stat(lockPath); } catch { return false; }
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return true;
    try {
      const { pid } = JSON.parse(await readFile(lockPath, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return true;
    } catch {} // being written right now: not stale
    return false;
  }

  /** O_EXCL lock file holding {pid, startedAt}; a stale or orphaned one is broken. */
  async function acquireLock() {
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(wp.installLockPath, 'wx', 0o600);
        try {
          await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString() }));
        } finally {
          await fh.close();
        }
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await unlink(wp.installLockPath).catch(() => {});
        };
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }
      if (!(await lockIsStale(wp.installLockPath))) break;
      say('[whatsapp-install] breaking a stale install lock', 'warn');
      await unlink(wp.installLockPath).catch(() => {});
    }
    throw installError('INSTALL_BUSY');
  }

  function npmEnv(searchPath) {
    const win = platform === 'win32';
    const allow = new Set(win ? NPM_ENV_ALLOW.map((k) => k.toUpperCase()) : NPM_ENV_ALLOW);
    const out = {};
    for (const [key, value] of Object.entries(env || {})) {
      if (typeof value === 'string' && allow.has(win ? key.toUpperCase() : key)) out[key] = value;
    }
    out.PATH = searchPath;
    out.npm_config_cache = wp.npmCacheDir;
    out.npm_config_update_notifier = 'false';
    out.npm_config_fund = 'false';
    out.npm_config_audit = 'false';
    return out;
  }

  /** Run a command, stream its lines, resolve {code, signal, stdout, stderr, timedOut, aborted, error}. */
  function runCommand(command, args, { cwd, childEnv, shell = false, limitMs, signal, stage, onLine }) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(command, args, { cwd, env: childEnv, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ code: null, signal: null, stdout: '', stderr: '', error });
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const splitter = (which) => {
        let buf = '';
        return (chunk) => {
          const s = String(chunk);
          if (which === 'stdout') stdout = (stdout + s).slice(-256 * 1024);
          else stderr = (stderr + s).slice(-256 * 1024);
          buf += s;
          let i;
          while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (line.trim()) onLine?.(stage, line);
          }
          if (buf.length > 16 * 1024) {
            onLine?.(stage, buf.slice(0, 2000));
            buf = '';
          }
        };
      };
      child.stdout?.on('data', splitter('stdout'));
      child.stderr?.on('data', splitter('stderr'));
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});
      const kill = () => {
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref?.();
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, limitMs);
      const onAbort = () => { aborted = true; kill(); };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolve({ stdout, stderr, timedOut, aborted, ...result });
      };
      child.on('error', (error) => done({ code: null, signal: null, error }));
      child.on('close', (code, sig) => done({ code, signal: sig }));
    });
  }

  function parseProbe(stdout) {
    const lines = String(stdout || '').trim().split('\n').reverse();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && 'ok' in obj) return obj;
      } catch {}
    }
    return null;
  }

  async function probe(dir, { signal, onLine } = {}) {
    const res = await runCommand(execPath, ['--disable-warning=ExperimentalWarning', hostPath, '--probe', '--runtime', dir], {
      cwd: dir,
      childEnv: npmEnv(env.PATH || ''),
      limitMs: probeTimeoutMs,
      signal,
      stage: 'verifying',
      onLine: null,
    });
    const out = parseProbe(res.stdout);
    if (onLine && res.stderr.trim()) for (const line of res.stderr.trim().split('\n').slice(-5)) onLine('verifying', line);
    if (res.aborted) return { ok: false, code: 'ABORTED' };
    if (res.timedOut) return { ok: false, code: 'VERIFY_FAILED', message: 'the connector probe timed out' };
    if (!out?.ok) return { ok: false, code: 'VERIFY_FAILED', message: out?.error ? `the connector probe failed: ${out.error}` : 'the connector probe failed' };
    return { ok: true, version: out.version ?? null };
  }

  function freeBytes(dir) {
    try {
      const st = statfsSync(dir);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      return Infinity;
    }
  }

  async function install({ onProgress, signal } = {}) {
    const emit = (stage, line) => {
      const clean = line == null ? null : redactWa(String(line)).slice(0, 2000);
      if (clean) appendLog(`${new Date(now()).toISOString()} [${stage}] ${clean}\n`);
      try { onProgress?.({ stage, line: clean }); } catch {}
    };
    if (fake) {
      emit('checking', 'fake connector (SYNABUN_WHATSAPP_FAKE=1): nothing to install');
      return { ok: true, version: 'fake' };
    }
    let release = null;
    let stage = 'checking';
    const started = now();
    try {
      emit(stage, 'checking the connector, npm and free disk space');
      if (signal?.aborted) throw installError('ABORTED');
      release = await acquireLock();
      const manifest = readManifest();
      for (const name of CONNECTOR_FILES) {
        if (!existsSync(p.join(connectorDir, name))) throw installError('VERIFY_FAILED', `the connector file ${name} is missing`);
      }
      const lockSha = fileDigest(p.join(connectorDir, CONNECTOR_LOCK));
      if (lockSha !== manifest.lockSha256) throw installError('VERIFY_FAILED', 'the connector lockfile does not match its manifest');
      const entrySha = fileDigest(p.join(connectorDir, 'entry.mjs'));
      if (freeBytes(dataHome) < MIN_FREE_BYTES) throw installError('DISK_FULL');
      const searchPath = (() => { try { return String(augmentedPath() || ''); } catch { return env.PATH || ''; } })();
      const npm = resolveNpmCli({ platform, execPath, env, exists, realpath, augmentedPath: () => searchPath });
      if (!npm) throw installError('NPM_NOT_FOUND');
      emit(stage, `npm: ${npm.source}`);

      rmOwned(wp.stagingDir);
      mkdirSync(wp.stagingDir, { recursive: true, mode: 0o700 });
      for (const name of CONNECTOR_FILES) copyFileSync(p.join(connectorDir, name), p.join(wp.stagingDir, STAGED_NAMES[name] || name));
      writeFileSync(p.join(wp.stagingDir, '.npmrc'), CONNECTOR_NPMRC, { mode: 0o600 });
      mkdirSync(wp.npmCacheDir, { recursive: true, mode: 0o700 });

      stage = 'downloading';
      emit(stage, `installing ${manifest.package}@${manifest.version} (about ${manifest.approxSizeMB ?? '?'} MB)`);
      const res = await runCommand(npm.command, [...npm.args, ...NPM_CI_ARGS], {
        cwd: wp.stagingDir,
        childEnv: npmEnv(searchPath),
        shell: npm.shell,
        limitMs: timeoutMs,
        signal,
        stage,
        onLine: emit,
      });
      if (res.aborted) throw installError('ABORTED');
      if (res.timedOut) throw installError('TIMEOUT');
      if (res.error) {
        const code = res.error.code === 'ENOENT' ? 'NPM_NOT_FOUND' : mapNpmError(`${res.error.code} ${res.error.message}`);
        throw installError(code, `${MESSAGES[code] || MESSAGES.UNKNOWN} (${res.error.code || res.error.message})`);
      }
      if (res.code !== 0) {
        const code = mapNpmError(`${res.stderr}\n${res.stdout}`);
        throw installError(code, `${MESSAGES[code] || MESSAGES.UNKNOWN} (npm exited with ${res.code ?? res.signal})`);
      }

      stage = 'verifying';
      emit(stage, 'verifying the installed connector');
      let installedVersion = null;
      try {
        installedVersion = JSON.parse(readFileSync(p.join(wp.stagingDir, 'node_modules', manifest.package, 'package.json'), 'utf8')).version;
      } catch {}
      if (installedVersion !== manifest.version) {
        throw installError('VERIFY_FAILED', `expected ${manifest.package}@${manifest.version}, found ${installedVersion ?? 'nothing'}`);
      }
      const probed = await probe(wp.stagingDir, { signal, onLine: emit });
      if (!probed.ok) throw installError(probed.code, probed.message);
      if (probed.version && probed.version !== manifest.version) {
        throw installError('VERIFY_FAILED', `the connector reports ${probed.version}, expected ${manifest.version}`);
      }
      writeFileSync(p.join(wp.stagingDir, '.installed.json'), `${JSON.stringify({
        version: manifest.version,
        lockSha256: lockSha,
        entrySha256: entrySha,
        installedAt: new Date(now()).toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });

      stage = 'activating';
      emit(stage, 'activating the new connector');
      if (signal?.aborted) throw installError('ABORTED');
      rmOwned(oldDir);
      let movedOld = false;
      if (existsSync(wp.runtimeDir)) {
        renameSync(wp.runtimeDir, oldDir);
        movedOld = true;
      }
      try {
        renameSync(wp.stagingDir, wp.runtimeDir);
      } catch (err) {
        if (movedOld) { try { renameSync(oldDir, wp.runtimeDir); } catch {} }
        throw err;
      }
      try { rmOwned(oldDir); } catch {}
      emit(stage, `installed ${manifest.package}@${manifest.version} in ${Math.round((now() - started) / 1000)} s`);
      return { ok: true, version: manifest.version };
    } catch (err) {
      let code = typeof err?.code === 'string' && INSTALL_CODES.includes(err.code) ? err.code : mapNpmError(`${err?.code || ''} ${err?.message || ''}`);
      if (!INSTALL_CODES.includes(code)) code = 'UNKNOWN';
      const message = err?.code === code && err?.message
        ? err.message
        : `${MESSAGES[code] || MESSAGES.UNKNOWN}${err?.code ? ` (${err.code})` : ''}`;
      emit(stage, `failed: ${code} — ${message}`);
      say(`[whatsapp-install] ${code}: ${redactWa(message)}`, 'warn');
      if (code !== 'INSTALL_BUSY') { try { rmOwned(wp.stagingDir); } catch {} }
      return { ok: false, code, message: redactWa(message) };
    } finally {
      await release?.();
    }
  }

  async function uninstall() {
    if (fake) return { ok: true };
    let release;
    try {
      release = await acquireLock();
      rmOwned(wp.stagingDir);
      rmOwned(oldDir);
      rmOwned(wp.runtimeDir);
      return { ok: true };
    } catch (err) {
      const code = err?.code === 'INSTALL_BUSY' ? 'INSTALL_BUSY' : mapNpmError(`${err?.code || ''} ${err?.message || ''}`);
      return { ok: false, code, message: MESSAGES[code] || MESSAGES.UNKNOWN };
    } finally {
      await release?.();
    }
  }

  async function verify() {
    if (fake) return { ok: true, version: 'fake' };
    if (!status().installed) return { ok: false, code: 'VERIFY_FAILED', message: 'the WhatsApp connector is not installed' };
    const res = await probe(wp.runtimeDir);
    return res.ok ? { ok: true, version: res.version } : { ok: false, code: res.code, message: res.message || MESSAGES[res.code] };
  }

  function logTail(n = 50) {
    try {
      const lines = readFileSync(wp.installLogPath, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(1000, n))).map((l) => redactWa(l));
    } catch {
      return [];
    }
  }

  return { status, install, uninstall, verify, logTail, get paths() { return wp; } };
}
