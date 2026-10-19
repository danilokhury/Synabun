// ═══════════════════════════════════════════
// SynaBun — Git Bash: the copy in use, and its download
// ═══════════════════════════════════════════
//
// On Windows a Claude Code without Git Bash has no Bash tool and runs every
// hook in PowerShell. The manager keeps the answer to "which Git Bash does a
// Claude Code started by SynaBun get" (resolver.js) and, on a PC that has
// none, puts SynaBun's own copy of Git for Windows in place:
//
//   bundled      inside an installed app: <resources>\git (the Windows x64
//                installer carries it; packaging/lib/git-bash.mjs)
//   downloaded   on an npm install: DATA_HOME/runtime/git/<version>/, fetched
//                once from the pinned release (pins.js), checked and unpacked
//                by install.js, outside data/ so no backup holds it
//
// It downloads only on Windows, only for a processor a release is pinned for,
// and only when neither the PC nor the app has a Git Bash: at the server's
// start (ensure) or at the first Claude Code start that finds none (childEnv),
// once per process. A failed download is not tried again by itself: Settings
// shows why and has the button that tries again. SYNABUN_GIT_BASH=off turns all
// of it off: no download, nothing added to any environment.
//
//   resolution()   the Git Bash in use (refreshed when older than half a minute)
//   childEnv(env)  the environment of a Claude Code process SynaBun starts
//   gitExecutable() git.exe of SynaBun's copy when it is the one in use (SynaBun's own git features)
//   ensure()       download when there is no Git Bash at all; never rejects
//   status()       what Settings shows: missing / downloading / ready / failed, and the rest
//   onChange(fn)   told when the Git Bash in use changes (the settings of the user's own `claude` follow it)
//   housekeep()    what an earlier run left in the data home: a stopped attempt's work folder, a version the
//                  pins no longer name (the server runs it once, in the background)

import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataHome } from '../../../lib/paths.js';
import { packagedRuntime } from '../../../lib/packaged-runtime.js';
import { pathEnvValue } from '../augmented-path.js';
import { sweepStaleWork } from '../cloudflared/install.js';
import { checkInstalled, GitBashError, installGitBash } from './install.js';
import { BUNDLED_FOLDER, gitBashPinFor, inTree, MARKER, readGitBashPins } from './pins.js';
import { gitBashChildEnv, resolveGitBash } from './resolver.js';

const VERSION_FOLDER = /^\d+\.\d+\.\d+\.\d+$/;

/** `DATA_HOME/runtime/git`: where a downloaded Git for Windows lives. */
export function gitRoot(dataHome = getDataHome()) {
  return join(dataHome, 'runtime', 'git');
}

const describe = (error) => ({
  code: error instanceof GitBashError ? error.code : 'disk',
  message: String(error?.message || error),
});

const same = (a, b) => !!a && !!b && a.path === b.path && a.source === b.source && a.passToClaude === b.passToClaude && a.cmdDir === b.cmdDir;

/**
 * @param {object} [o]
 * @param {string} [o.dataHome]
 * @param {{ resources: string } | null} [o.packaged]  lib/packaged-runtime.js packagedRuntime()
 * @param {object} [o.pins]               pins.js readGitBashPins() (read here when left out; unreadable pins never throw)
 * @param {() => string} [o.pathValue]    the PATH a git of the PC is looked for on
 * @param {() => (string|null)} [o.settingsValue]  CLAUDE_CODE_GIT_BASH_PATH of the user's ~/.claude/settings.json
 * @param {typeof fetch} [o.fetchImpl]
 * @param {boolean} [o.worker]            unpack in a worker thread (the server); tests unpack inline
 * @param {(line: string) => void} [o.log]
 */
export function createGitBashManager({
  dataHome = getDataHome(),
  packaged = packagedRuntime(),
  pins,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  pathValue = () => pathEnvValue(env),
  settingsValue = () => null,
  fetchImpl,
  stallMs,
  worker = true,
  maxAgeMs = 30_000,
  isFile,
  install = installGitBash,
  check = checkInstalled,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  if (!pins) {
    try {
      pins = readGitBashPins();
    } catch (error) {
      pins = Object.freeze({ version: null, platforms: Object.freeze({}) });
      if (platform === 'win32') log(`[git-bash] ${error?.message || error} SynaBun downloads no Git for Windows until this is repaired.`);
    }
  }
  const off = String(env.SYNABUN_GIT_BASH || '').trim().toLowerCase() === 'off';
  const pin = gitBashPinFor(pins, platform, arch);
  // `platform` decides which rules apply (Windows'); paths on this disk are in the separators of the system that
  // runs this (the same thing on a Windows PC; tests ask the Windows rules from any system).
  const host = process.platform;
  const root = gitRoot(dataHome);
  const bundledRoot = platform === 'win32' && packaged?.resources ? join(packaged.resources, BUNDLED_FOLDER) : null;
  const downloadedRoot = pin ? join(root, pin.version) : null;
  const ownRoots = [bundledRoot, root].filter(Boolean);

  const verified = new Map();   // copy root → { sig, result }: a copy is hashed again only when its marker changes
  const listeners = new Set();
  let current = null;
  let refreshedAt = 0;
  let download = null;          // { promise, stop, step, progress } while one runs
  let lastError = null;
  let attempted = false;        // a download was started in this process (the first-need trigger fires once)
  let settings = null;          // what the last sync of the user's settings did (noteSettings)

  /** SynaBun's own copies, checked: the app's, then the data home's. */
  function copies() {
    if (!pin) return [];
    const out = [];
    for (const [source, copyRoot] of [['bundled', bundledRoot], ['downloaded', downloadedRoot]]) {
      if (!copyRoot) continue;
      let sig = null;
      try { const info = statSync(join(copyRoot, MARKER)); sig = `${info.size}:${info.mtimeMs}:${info.ino}`; } catch { sig = null; }
      let result;
      if (sig === null) result = { ok: false, reason: 'missing' };
      else {
        const known = verified.get(copyRoot);
        const fresh = !(known && known.sig === sig);
        result = fresh ? check(copyRoot, pin, { platform: host }) : known.result;
        // A copy that could not be read just now is asked again next time; a verdict is remembered with its marker.
        verified.set(copyRoot, { sig, result });
        // The tree's empty folders, which an installer of files does not carry (the Windows installer makes them;
        // this puts back one that is gone). Asked once per verdict.
        if (fresh && result.ok) for (const rel of pin.folders || []) { try { mkdirSync(inTree(copyRoot, rel, host), { recursive: true }); } catch { /* a folder SynaBun cannot write: bash runs without it */ } }
      }
      out.push({ source, root: copyRoot, ok: result.ok, reason: result.reason, bash: inTree(copyRoot, pin.bash, host), git: inTree(copyRoot, pin.git, host) });
    }
    return out;
  }

  function refresh() {
    let next;
    // macOS, Linux, the kill switch: nothing to look at (no settings read, no PATH walked).
    if (off || platform !== 'win32') next = resolveGitBash({ platform: off ? 'off' : platform });
    else {
      let settingsBash = null;
      try { settingsBash = settingsValue(); } catch { settingsBash = null; }
      let searchPath = '';
      try { searchPath = pathValue(); } catch { searchPath = pathEnvValue(env); }
      next = resolveGitBash({ platform, env, settingsValue: settingsBash, pathValue: searchPath, copies: copies(), ownRoots, ...(isFile ? { isFile } : {}) });
    }
    const changed = !same(current, next);
    current = next;
    refreshedAt = now();
    if (changed) for (const listener of [...listeners]) { try { listener(next); } catch { /* the listener's */ } }
    return current;
  }

  function resolution({ maxAge = maxAgeMs } = {}) {
    if (!current || now() - refreshedAt > maxAge) refresh();
    return current;
  }

  /** Versions the pins no longer name, removed without holding the event loop (some ten thousand files each). */
  async function pruneOtherVersions() {
    let names = [];
    try { names = readdirSync(root); } catch { return []; }
    const removed = [];
    for (const name of names) {
      if (!VERSION_FOLDER.test(name) || name === pin?.version) continue;
      // A copy still in use (a Claude Code started before the update) cannot be removed on Windows: the next start tries again.
      try { await rm(join(root, name), { recursive: true, force: true, maxRetries: 2 }); removed.push(name); log(`[git-bash] Removed Git for Windows ${name}, which the pins no longer name.`); } catch { /* in use */ }
    }
    return removed;
  }

  /** Windows: a work folder a stopped attempt left (when no attempt runs now), and versions the pins no longer name. */
  async function housekeep() {
    if (platform !== 'win32' || off || !pin) return { swept: [], removed: [] };
    const swept = download ? [] : sweepStaleWork(root);
    return { swept, removed: await pruneOtherVersions() };
  }

  /** Download SynaBun's copy when there is no Git Bash at all. Resolves the status; never rejects. */
  function ensure({ reason = 'start' } = {}) {
    if (platform !== 'win32' || !pin || off) return Promise.resolve(status());
    if (download) return download.promise.then(() => status());
    if (refresh().source) return Promise.resolve(status());
    attempted = true;
    lastError = null;
    const stop = new AbortController();
    const job = { stop, step: 'download', progress: { phase: 'download', received: 0, total: pin.size } };
    log(`[git-bash] No Git Bash on this PC (${reason}): downloading Git for Windows ${pin.version} (${(pin.size / 1024 / 1024).toFixed(1)} MB) from ${pin.url}`);
    job.promise = install({
      pins, pin, root, fetchImpl, stallMs, worker, platform: host, signal: stop.signal,
      onStep: (step) => { job.step = step; },
      onProgress: (progress) => { job.progress = progress; },
    }).then(async (placed) => {
      log(`[git-bash] Git for Windows ${pin.version} is in place, release file and tree checked: ${placed.path}`);
      verified.delete(downloadedRoot);
      await pruneOtherVersions();
    }, (error) => {
      lastError = describe(error);
      log(`[git-bash] Git for Windows ${pin.version} could not be put in place (${lastError.code}): ${lastError.message}`);
    }).finally(() => {
      if (download === job) download = null;
      // The listeners hear the change (SynaBun's copy now in use); Settings asks for the status itself.
      refresh();
    });
    download = job;
    return job.promise.then(() => status());
  }

  function childEnv(base = env) {
    const r = resolution();
    // The first Claude Code start that finds no Git Bash at all fetches one (once per process; Settings retries).
    if (platform === 'win32' && pin && !off && !r.source && !download && !attempted) ensure({ reason: 'first-need' });
    return gitBashChildEnv(base, r, { platform });
  }

  function gitExecutable() {
    const r = resolution();
    return r.passToClaude && r.git ? r.git : null;
  }

  function status() {
    const r = current || resolution();
    const base = {
      supported: platform === 'win32',
      pinned: pin ? { version: pin.version, tag: pin.tag, file: pin.file, size: pin.size, url: pin.url } : null,
      source: r.source,
      path: r.path,
      passToClaude: r.passToClaude,
      step: null,
      progress: null,
      error: null,
      settings,
      checkedAt: new Date(refreshedAt || now()).toISOString(),
    };
    if (platform !== 'win32') return { ...base, state: 'unsupported' };
    if (off) return { ...base, state: 'off' };
    if (download) {
      const { phase, received = 0, consumed = 0, total = 0 } = download.progress || {};
      const done = phase === 'extract' ? consumed : received;
      return { ...base, state: 'downloading', step: download.step, progress: { phase, done, total, percent: total ? Math.min(100, Math.floor((done / total) * 100)) : 0 } };
    }
    if (r.source === 'bundled' || r.source === 'downloaded') return { ...base, state: 'ready' };
    if (r.source) return { ...base, state: 'system' };
    // Windows on a processor no release is pinned for (arm64): nothing to download, nothing to retry.
    if (!pin) return { ...base, state: 'unsupported' };
    if (lastError) return { ...base, state: 'failed', error: lastError };
    return { ...base, state: 'missing' };
  }

  return {
    pin,
    root,
    ownRoots,
    resolution,
    refresh,
    childEnv,
    gitExecutable,
    ensure,
    status,
    housekeep,
    cancel: () => { if (!download) return false; download.stop.abort(); return true; },
    noteSettings: (result) => { settings = result || null; },
    onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
