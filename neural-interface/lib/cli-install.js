// ═══════════════════════════════════════════
// SynaBun — install a missing CLI from its vendor
// ═══════════════════════════════════════════
//
// What the side panels' Install button runs (POST /api/cli/install/:tool,
// lib/cli-install-api.js) when Claude Code, Codex or OpenCode is not installed.
// Each tool is installed the way its vendor documents for the system, from the
// vendor's own source, with nothing else needed (no Node, npm, Homebrew or
// Scoop). The sources are fixed here; a request only names the tool.
//
//   Claude Code  Anthropic's native installer: https://claude.ai/install.sh
//                (bash) on macOS and Linux, https://claude.ai/install.ps1
//                (powershell.exe -NoProfile -ExecutionPolicy Bypass -File) on
//                Windows. Both check the binary they download against the
//                SHA-256 of Anthropic's signed release manifest.
//   Codex        OpenAI's standalone installer (learn.chatgpt.com/docs/codex/cli),
//                the install.sh / install.ps1 published with every
//                openai/codex release: taken from the latest release and
//                checked against the SHA-256 GitHub publishes for it, or, when
//                GitHub's API does not answer, from https://chatgpt.com/codex/
//                (the same file). The installer checks the package it fetches.
//   OpenCode     OpenCode 2's install script https://opencode.ai/v2/install
//                (bash) on macOS and Linux, the one `opencode upgrade` itself
//                runs (it puts opencode in ~/.opencode/bin). Windows has no
//                one-click install: OpenCode 2 comes from WinGet there
//                (Anomaly.OpenCode), and the banner shows that command.
//
// Every download is HTTPS, every redirect too, and only to the vendor's own
// hosts. Nothing runs as administrator; everything lands in the user's own
// folders. Install consents to adding the resolved CLI's folder to persistent
// PATH when the vendor did not do so. That is a visible final step, using the
// same writer as Add to PATH; a failed PATH write leaves the CLI installed and
// reports a warning. Installers run without a terminal and without questions
// (CODEX_NON_INTERACTIVE=1, PowerShell -NonInteractive).
//
// One install per tool at a time. Every failure is a CliInstallError with a
// `code` the page has words for. Nothing here throws to a caller of start().

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildInstallCommand } from './cli-update-planner.js';
import { packagedPathLast, rememberedPackagedPath, withPathEnv } from './augmented-path.js';

export const CLI_INSTALL_ERROR_CODES = Object.freeze([
  'unsupported',             // no official one-click method for this system
  'busy',                    // an install of this tool is already running
  'offline',                 // the vendor's server was not reached
  'http',                    // it answered, but not with the file
  'checksum',                // what arrived is not the published file
  'interrupted',             // the transfer ended early
  'timeout',                 // nothing arrived for too long, or the installer ran too long
  'installer-failed',        // the vendor's installer exited with an error
  'not-found-after-install', // it finished, but no working CLI is found
  'disk',                    // a file could not be written
  'cancelled',               // stopped (SynaBun shutting down)
  'internal',                // anything else
]);

export class CliInstallError extends Error {
  constructor(code, message, { cause, detail } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CliInstallError';
    this.code = CLI_INSTALL_ERROR_CODES.includes(code) ? code : 'internal';
    if (detail !== undefined) this.detail = detail;
  }
}

/** The vendor's install page for each tool (the banner's "Install guide"). */
export const CLI_INSTALL_GUIDES = Object.freeze({
  'claude-code': 'https://code.claude.com/docs/en/setup',
  codex: 'https://learn.chatgpt.com/docs/codex/cli',
  opencode: 'https://opencode.ai/v2/docs',
  gemini: 'https://github.com/google-gemini/gemini-cli',
});

const GITHUB_DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'];
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 6;
const LOG_KEEP = 200;
const SUPPORTED = { darwin: ['x64', 'arm64'], linux: ['x64', 'arm64'], win32: ['x64', 'arm64'] };

const hostIs = (...hosts) => (url) => hosts.includes(url.hostname);

/**
 * The one-click method for a tool on this system, or null when there is none
 * (Gemini CLI, OpenCode on Windows, a 32-bit or other system). Pure: tests ask
 * it for every OS.
 */
export function installPlanFor(toolKey, { platform = process.platform, arch = process.arch, env = process.env, home } = {}) {
  if (!(SUPPORTED[platform] || []).includes(arch)) return null;
  const windows = platform === 'win32';
  switch (toolKey) {
    case 'claude-code':
      return {
        tool: toolKey,
        kind: 'script',
        interpreter: windows ? 'powershell' : 'bash',
        url: windows ? 'https://claude.ai/install.ps1' : 'https://claude.ai/install.sh',
        allow: hostIs('claude.ai', 'downloads.claude.ai'),
        source: windows ? 'https://claude.ai/install.ps1' : 'https://claude.ai/install.sh',
        label: 'Anthropic native installer',
        env: {},
      };
    case 'codex':
      return {
        tool: toolKey,
        kind: 'script',
        interpreter: windows ? 'powershell' : 'sh',
        url: windows ? 'https://chatgpt.com/codex/install.ps1' : 'https://chatgpt.com/codex/install.sh',
        allow: hostIs('chatgpt.com', 'releases.openai.com'),
        release: { repo: 'openai/codex', asset: windows ? 'install.ps1' : 'install.sh' },
        source: windows ? 'https://chatgpt.com/codex/install.ps1' : 'https://chatgpt.com/codex/install.sh',
        label: 'OpenAI standalone installer',
        env: { CODEX_NON_INTERACTIVE: '1' },
      };
    case 'opencode':
      // OpenCode 2's own installer is a bash script; on Windows it comes from WinGet (no one-click install).
      if (windows) return null;
      return {
        tool: toolKey,
        kind: 'script',
        interpreter: 'bash',
        url: 'https://opencode.ai/v2/install',
        allow: (url) => url.hostname === 'opencode.ai' || (url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith('/anomalyco/opencode/')),
        source: 'https://opencode.ai/v2/install',
        label: 'OpenCode 2 install script',
        env: {},
      };
    default:
      return null;
  }
}

/** What the status of a tool says about its one-click install. */
export function describeInstall(toolKey, options) {
  const plan = installPlanFor(toolKey, options);
  return plan
    ? { available: true, method: plan.kind, source: plan.source, interpreter: plan.interpreter, label: plan.label }
    : { available: false, method: null, source: null, interpreter: null, label: null };
}

// ── Transfers ───────────────────────────────────────────────────────────────

function errorCode(error) {
  return error?.code || error?.cause?.code || null;
}

const DISK_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EDQUOT', 'EEXIST', 'EISDIR', 'ENOTDIR']);

function asInstallError(error, code, message) {
  if (error instanceof CliInstallError) return error;
  return new CliInstallError(code, message, { cause: error, detail: errorCode(error) || error?.message });
}

function nextHop(response, from, allow) {
  const location = response.headers.get('location');
  let next = null;
  try { next = new URL(location, from); } catch { next = null; }
  if (!location || !next) throw new CliInstallError('http', 'The download server sent a redirect without an address.');
  if (next.protocol !== 'https:') throw new CliInstallError('http', `The download server redirected to an address that is not HTTPS (${next.protocol}); it was not followed.`);
  if (!allow(next)) throw new CliInstallError('http', `The download server redirected to ${next.hostname}, which is not one of the vendor's own; it was not followed.`);
  return next;
}

async function writeAll(handle, buffer) {
  let at = 0;
  while (at < buffer.length) at += (await handle.write(buffer, at, buffer.length - at)).bytesWritten;
}

/**
 * Download `url` into `destination` (a new file), HTTPS only and only through
 * hosts `allow` accepts. Checks the size and, when given, the SHA-256.
 * Resolves { sha256, size, url } (the address the file came from).
 */
export async function downloadFile({
  url,
  allow,
  destination,
  maxBytes,
  expectedSize = null,
  sha256 = null,
  fetchImpl = fetch,
  signal,
  onProgress = () => {},
  stallMs = 60_000,
  accept = 'application/octet-stream',
}) {
  let current;
  try { current = new URL(url); } catch { throw new CliInstallError('internal', `Not an address: ${url}`); }
  if (current.protocol !== 'https:' || !allow(current)) throw new CliInstallError('internal', `${url} is not one of the vendor's HTTPS addresses.`);
  const stop = new AbortController();
  const onAbort = () => stop.abort(new CliInstallError('cancelled', 'The download was stopped.'));
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  let timer = null;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop.abort(new CliInstallError('timeout', `Nothing arrived from ${current.hostname} for ${Math.round(stallMs / 1000)} seconds.`)), stallMs);
    timer.unref?.();
  };
  let handle = null;
  let made = false;
  let answered = false;
  let received = 0;
  const hash = createHash('sha256');
  try {
    alive();
    let response = null;
    for (let hop = 0; ; hop++) {
      response = await fetchImpl(current, { redirect: 'manual', signal: stop.signal, headers: { accept, 'accept-encoding': 'identity', 'user-agent': 'synabun' } });
      if (response.status < 300 || response.status >= 400) break;
      const next = nextHop(response, current, allow);
      try { await response.body?.cancel(); } catch { /* nothing to drain */ }
      if (hop >= MAX_REDIRECTS) throw new CliInstallError('http', 'The download server redirected too many times.');
      current = next;
      alive();
    }
    if (response.status !== 200 || !response.body) {
      try { await response.body?.cancel(); } catch { /* nothing to drain */ }
      throw new CliInstallError('http', `${current.hostname} answered ${response.status} instead of the file.`, { detail: String(response.status) });
    }
    const announced = Number(response.headers.get('content-length'));
    if (Number.isFinite(announced) && announced > 0 && ((expectedSize && announced !== expectedSize) || announced > maxBytes)) {
      try { await response.body.cancel(); } catch { /* nothing to drain */ }
      throw new CliInstallError('checksum', `${current.hostname} offered ${announced} bytes${expectedSize ? `; the published file has ${expectedSize}` : ''}. It was not downloaded.`);
    }
    answered = true;
    handle = await open(destination, 'wx', 0o600);
    made = true;
    const total = expectedSize || (Number.isFinite(announced) && announced > 0 ? announced : 0);
    onProgress({ received: 0, total });
    // Read through a reader of our own, cancelled on a stall or a stop: the transfer ends then whatever the
    // transport does with the signal.
    const reader = response.body.getReader();
    const onStop = () => { reader.cancel(stop.signal.reason).catch(() => {}); };
    stop.signal.addEventListener('abort', onStop, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (stop.signal.aborted) throw stop.signal.reason;
        if (done) break;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        alive();
        received += chunk.length;
        if (received > (expectedSize || maxBytes)) throw new CliInstallError('checksum', 'The download is larger than the published file. It was stopped and removed.');
        hash.update(chunk);
        await writeAll(handle, chunk);
        onProgress({ received, total });
      }
    } finally {
      stop.signal.removeEventListener('abort', onStop);
    }
    if (expectedSize && received !== expectedSize) throw new CliInstallError('interrupted', `The download ended after ${received} of ${expectedSize} bytes.`);
    const digest = hash.digest('hex');
    if (sha256 && digest !== String(sha256).toLowerCase()) {
      throw new CliInstallError('checksum', 'The download does not match the SHA-256 its vendor published. It was removed and never run.', { detail: digest });
    }
    await handle.sync();
    await handle.close();
    handle = null;
    return { sha256: digest, size: received, url: current.href };
  } catch (error) {
    try { await handle?.close(); } catch { /* closed */ }
    handle = null;
    if (made) rmSync(destination, { force: true });
    if (stop.signal.aborted && stop.signal.reason instanceof CliInstallError) throw stop.signal.reason;
    if (error instanceof CliInstallError) throw error;
    if (DISK_CODES.has(errorCode(error))) throw asInstallError(error, 'disk', `The download could not be saved (${errorCode(error)}).`);
    if (answered) throw new CliInstallError('interrupted', `The download from ${current.hostname} ended after ${received} bytes.`, { cause: error, detail: errorCode(error) || error?.message });
    throw asInstallError(error, 'offline', `${current.hostname} could not be reached.`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** GET a GitHub API document (api.github.com only, followed redirects stay there). */
export async function fetchGithubJson(url, { fetchImpl = fetch, signal, timeoutMs = 20_000 } = {}) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  timer.unref?.();
  const onAbort = () => stop.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { signal: stop.signal, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'synabun' } });
    const final = new URL(response.url || url);
    if (final.protocol !== 'https:' || final.hostname !== 'api.github.com') throw new CliInstallError('http', 'GitHub\'s API answered from another address.');
    if (!response.ok) throw new CliInstallError('http', `GitHub's API answered ${response.status}${response.status === 403 || response.status === 429 ? ' (rate limited)' : ''}.`, { detail: String(response.status) });
    const text = await response.text();
    if (text.length > MAX_JSON_BYTES) throw new CliInstallError('http', 'GitHub\'s API answered with too much.');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof CliInstallError) throw error;
    if (signal?.aborted) throw new CliInstallError('cancelled', 'Stopped.');
    if (error instanceof SyntaxError) throw new CliInstallError('http', 'GitHub\'s API answered with something that is not JSON.');
    throw asInstallError(error, 'offline', 'GitHub\'s API could not be reached.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** "sha256:abc…" (GitHub's asset digest) → "abc…", or null. */
export function sha256OfDigest(digest) {
  const match = String(digest || '').match(/^sha256:([0-9a-f]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

/** The named asset of a release, when it is downloaded from that repository's own releases. */
export function releaseAsset(release, name, repo) {
  const asset = (release?.assets || []).find(item => item?.name === name);
  if (!asset) return null;
  const url = String(asset.browser_download_url || '');
  if (!url.startsWith(`https://github.com/${repo}/releases/download/`)) return null;
  return { name, url, size: Number(asset.size) || null, sha256: sha256OfDigest(asset.digest) };
}

// ── Output ──────────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMNOZc]/g;

/**
 * Turns an installer's output into lines: escapes stripped, a carriage return
 * (a progress bar redrawing itself) keeping only what came after it, empty
 * lines dropped, each line at most 500 characters.
 */
export function createLineSplitter(onLine) {
  let pending = '';
  const emit = (raw) => {
    // A line's own CR (Windows' CRLF) ends it; a CR inside it is a redraw.
    const segments = raw.replace(/\r+$/, '').split('\r');
    const text = segments[segments.length - 1].replace(ANSI, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
    if (text.trim()) onLine(text.slice(0, 500));
  };
  return {
    push(chunk) {
      pending += String(chunk);
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        emit(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
      if (pending.length > 16_384) { emit(pending); pending = ''; }
    },
    end() {
      if (pending) emit(pending);
      pending = '';
    },
  };
}

function sameDir(a, b, platform) {
  const clean = (value) => {
    const text = String(value || '').replace(/[\\/]+$/, '');
    return platform === 'win32' ? text.toLowerCase().replace(/\//g, '\\') : text;
  };
  return clean(a) === clean(b);
}

/** Whether `dir` is on a PATH list. */
export function onPathList(dir, entries, platform = process.platform) {
  return (entries || []).some(entry => sameDir(entry, dir, platform));
}

// ── The installer ───────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {{ resolve: Function }} deps.resolver  cli-resolver.js: the final check (force)
 * @param {() => Promise<string[]>} [deps.readOsPath]  the OS PATH a new terminal gets, read afresh
 * @param {(tool: string, ok: boolean, status: object|null) => void} [deps.onFinished]
 */
export function createCliInstaller({
  resolver,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir(),
  tmpRoot = os.tmpdir(),
  fetchImpl = fetch,
  spawnImpl = spawn,
  readOsPath = async () => [],
  addToPath = null,
  installerPath = null,
  onFinished = () => {},
  log = () => {},
  timeoutMs = 15 * 60_000,
  stallMs = 60_000,
} = {}) {
  if (!resolver?.resolve) throw new Error('createCliInstaller needs the CLI resolver');
  const jobs = new Map();
  const windows = platform === 'win32';
  const planFor = (toolKey) => installPlanFor(toolKey, { platform, arch, env, home });
  const guideOf = (toolKey) => CLI_INSTALL_GUIDES[toolKey] || null;
  const manualOf = (toolKey) => buildInstallCommand(toolKey, 'unknown', { platform });

  function publicJob(job) {
    return {
      tool: job.tool,
      state: job.state,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      step: job.step,
      code: job.code,
      error: job.error,
      method: job.plan.kind,
      source: job.source || job.plan.source,
      log: job.log.slice(-40),
      path: job.path || null,
    };
  }

  function emit(job, event) {
    if (event.type === 'done' && event.path) job.path = event.path;
    if (event.type === 'log') {
      job.log.push(event.line);
      if (job.log.length > LOG_KEEP) job.log.splice(0, job.log.length - LOG_KEEP);
    }
    if (event.type === 'step') job.step = event.step;
    for (const listener of [...job.listeners]) {
      try { listener(event); } catch { /* a closed stream */ }
    }
  }

  function stepper(job) {
    return {
      step: (step) => emit(job, { type: 'step', step }),
      line: (line) => emit(job, { type: 'log', line }),
      progress: (() => {
        let last = 0;
        return ({ received, total }) => {
          const now = Date.now();
          if (received !== total && now - last < 250) return;
          last = now;
          emit(job, { type: 'progress', received, total });
        };
      })(),
    };
  }

  function interpreterFor(plan) {
    if (plan.interpreter === 'powershell') {
      const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
      return { file: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] };
    }
    const candidates = plan.interpreter === 'sh' ? ['/bin/sh', '/usr/bin/sh'] : ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'];
    const file = candidates.find(candidate => existsSync(candidate));
    if (!file) throw new CliInstallError('unsupported', `${plan.interpreter} is not installed on this computer; the ${plan.label} needs it.`);
    return { file, args: (script) => [script] };
  }

  /** PATH for an installer: the one a new terminal has (so its own "is it on PATH?" checks see the truth), plus the system's folders. */
  function installerPathValue(osEntries) {
    if (installerPath) return installerPath;
    const delimiter = windows ? ';' : ':';
    const base = osEntries.length ? osEntries : String(env.PATH || env.Path || '').split(delimiter);
    const system = windows
      ? [path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32'), path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'), env.SystemRoot || 'C:\\Windows']
      : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const seen = new Set();
    const value = [...base, ...system].filter((entry) => {
      const key = windows ? String(entry).toLowerCase() : String(entry);
      if (!entry || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).join(delimiter);
    // A packaged application's own Node runtime and npm, after everything of the user's: an installer that looks for
    // node or npm finds the user's own first, and these on a machine that has none (lib/augmented-path.js).
    const packaged = rememberedPackagedPath();
    return packaged.last.length || packaged.extra.length ? packagedPathLast(value, { platform, ...packaged }) : value;
  }

  async function fetchScript(job, plan, workDir, { step, line, progress }) {
    const file = path.join(workDir, windows ? 'install.ps1' : 'install.sh');
    step('download');
    let source = plan.url;
    let expected = null;
    let allow = plan.allow;
    if (plan.release) {
      try {
        const release = await fetchGithubJson(`https://api.github.com/repos/${plan.release.repo}/releases/latest`, { fetchImpl, signal: job.abort.signal });
        const asset = releaseAsset(release, plan.release.asset, plan.release.repo);
        if (asset?.sha256) {
          source = asset.url;
          expected = asset.sha256;
          allow = (url) => GITHUB_DOWNLOAD_HOSTS.includes(url.hostname);
          line(`${plan.label}: ${plan.release.asset} of ${plan.release.repo} ${release.tag_name || ''}`.trim());
        }
      } catch (error) {
        if (error?.code === 'cancelled') throw error;
        line(`GitHub's release list did not answer (${error?.message || error}); downloading ${plan.url} instead.`);
      }
    }
    job.source = source;
    const got = await downloadFile({ url: source, allow, destination: file, maxBytes: MAX_SCRIPT_BYTES, sha256: expected, fetchImpl, signal: job.abort.signal, onProgress: progress, stallMs, accept: '*/*' });
    step('verify');
    if (expected) line(`SHA-256 matches the published one (${got.sha256.slice(0, 12)}…).`);
    const handle = await open(file, 'r');
    const head = Buffer.alloc(64);
    try { await handle.read(head, 0, 64, 0); } finally { await handle.close(); }
    const start = head.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    // A region the vendor does not serve, a portal or a proxy answers with a page: never run that.
    if (start.startsWith('<') || (!windows && !start.startsWith('#!'))) {
      throw new CliInstallError('http', `${new URL(got.url).hostname} answered with a web page, not the installer (the download service may not be available in this region).`);
    }
    return file;
  }

  function runScript(job, plan, scriptFile, workDir, osEntries, { line }) {
    const interpreter = interpreterFor(plan);
    const childEnv = { ...withPathEnv({ ...env, ...plan.env }, installerPathValue(osEntries), platform), TERM: 'dumb', NO_COLOR: '1' };
    delete childEnv.FORCE_COLOR;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(interpreter.file, interpreter.args(scriptFile), {
          cwd: workDir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // POSIX: a session of its own, without a terminal, so nothing can ask on /dev/tty, and the
          // whole group can be stopped.
          detached: !windows,
        });
      } catch (error) {
        reject(asInstallError(error, 'installer-failed', `${interpreter.file} could not be started.`));
        return;
      }
      job.child = child;
      const out = createLineSplitter(line);
      const err = createLineSplitter(line);
      child.stdout?.on('data', chunk => out.push(chunk.toString('utf8')));
      child.stderr?.on('data', chunk => err.push(chunk.toString('utf8')));
      let settled = false;
      const timer = setTimeout(() => {
        stopChild(child, windows, spawnImpl);
        finish(new CliInstallError('timeout', `The installer was still running after ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => { stopChild(child, windows, spawnImpl); finish(new CliInstallError('cancelled', 'The install was stopped.')); };
      job.abort.signal.addEventListener('abort', onAbort, { once: true });
      function finish(error, code) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.abort.signal.removeEventListener('abort', onAbort);
        out.end();
        err.end();
        job.child = null;
        if (error) reject(error);
        else if (code !== 0) reject(new CliInstallError('installer-failed', `The ${plan.label} stopped with exit code ${code}.`, { detail: code }));
        else resolve();
      }
      child.on('error', error => finish(asInstallError(error, 'installer-failed', `${interpreter.file} could not be started (${errorCode(error) || error?.message}).`)));
      child.on('close', (code, signal) => finish(null, code ?? (signal ? 128 : 1)));
    });
  }

  async function run(job) {
    const { plan, tool } = job;
    const io = stepper(job);
    let workDir = null;
    let before = [];
    try {
      emit(job, { type: 'start', tool, method: plan.kind, source: plan.source, label: plan.label, platform, arch });
      try { before = await readOsPath(); } catch { before = []; }
      workDir = await mkdtemp(path.join(tmpRoot, `synabun-cli-install-${tool}-`));
      const script = await fetchScript(job, plan, workDir, io);
      io.step('run');
      await runScript(job, plan, script, workDir, before, io);
      io.step('check');
      const status = await resolver.resolve(tool, { force: true });
      if (status?.state !== 'installed') {
        const where = status?.path ? ` ${status.path}: ${status.error || 'it does not answer --version'}` : ' no working copy was found in any known place';
        throw new CliInstallError('not-found-after-install', `The installer finished, but${where}.`);
      }
      let after = [];
      try { after = await readOsPath(); } catch { after = []; }
      const dir = status.path ? path[windows ? 'win32' : 'posix'].dirname(status.path) : null;
      let onPath = dir ? onPathList(dir, after, platform) : false;
      let added = onPath && !onPathList(dir, before, platform);
      let warning = null;
      if (!onPath && addToPath) {
        io.step('path');
        try {
          const result = await addToPath(status);
          onPath = result.onPath;
          added = result.added;
          warning = result.warning || null;
          if (added) emit(job, { type: 'path', dir, added: true });
          if (warning) io.line(warning);
        } catch (error) {
          warning = error.message;
          io.line(`PATH could not be updated: ${warning}`);
        }
      }
      job.state = 'done';
      job.endedAt = new Date().toISOString();
      emit(job, { type: 'done', ok: true, status, path: { dir, onPath, added, ...(warning ? { warning } : {}) } });
      try { onFinished(tool, true, status); } catch { /* the caller's */ }
    } catch (failure) {
      const error = failure instanceof CliInstallError ? failure : asInstallError(failure, DISK_CODES.has(errorCode(failure)) ? 'disk' : 'internal', String(failure?.message || failure));
      job.state = 'failed';
      job.endedAt = new Date().toISOString();
      job.code = error.code;
      job.error = error.message;
      log(`[cli-install] ${tool} failed (${error.code}): ${error.message}`);
      emit(job, { type: 'done', ok: false, code: error.code, error: error.message, manualCommand: manualOf(tool), guideUrl: guideOf(tool), log: job.log.slice(-12) });
      try { onFinished(tool, false, null); } catch { /* the caller's */ }
    } finally {
      job.listeners.clear();
      if (workDir) { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* temp */ } }
    }
  }

  return {
    describe: (toolKey) => describeInstall(toolKey, { platform, arch, env, home }),
    guideUrl: guideOf,
    manualCommand: manualOf,
    jobs() {
      return Object.fromEntries([...jobs.entries()].map(([tool, job]) => [tool, publicJob(job)]));
    },
    running(toolKey) {
      return jobs.get(toolKey)?.state === 'running';
    },
    /**
     * Start installing `toolKey`; `onEvent` hears every event of this run
     * (start, step, progress, log, done). Throws CliInstallError 'busy' /
     * 'unsupported' before anything starts.
     */
    start(toolKey, { onEvent = null } = {}) {
      const plan = planFor(toolKey);
      if (!plan) throw new CliInstallError('unsupported', `SynaBun has no one-click install of ${toolKey} for ${platform}-${arch}.`);
      if (jobs.get(toolKey)?.state === 'running') throw new CliInstallError('busy', 'An install of this CLI is already running.');
      const job = {
        tool: toolKey,
        plan,
        state: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
        step: null,
        code: null,
        error: null,
        source: null,
        log: [],
        listeners: new Set(onEvent ? [onEvent] : []),
        abort: new AbortController(),
        child: null,
      };
      jobs.set(toolKey, job);
      job.done = run(job);
      return { job: publicJob(job), done: job.done, unsubscribe: () => { if (onEvent) job.listeners.delete(onEvent); } };
    },
    /** Stop every running install (SynaBun is shutting down). */
    stopAll() {
      for (const job of jobs.values()) if (job.state === 'running') job.abort.abort();
    },
  };
}

/** End an installer and everything it started. */
function stopChild(child, windows, spawnImpl) {
  if (!child?.pid) return;
  if (windows) {
    try { spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  const hard = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }, 5000);
  hard.unref?.();
}
