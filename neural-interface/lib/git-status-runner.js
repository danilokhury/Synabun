// Shared, bounded git reads. A worktree owns its revision, flight and last good
// snapshot; callers arriving after an edit wait for a scan of that revision.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devNull, setPriority, constants as osConstants } from 'node:os';
import { gitReadArgs, gitReadEnv, withGitFallback, createMonitorMemo, readsIndex } from './git-read.js';
import { createTreeWatcher } from './file-explorer-watch.js';

// A watch request can contain 2,000 subfolders plus the root. Leave room
// for all of them so sequential badge reads cannot churn the bounded cache.
export const MAX_IGNORE_FOLDERS = 2048;
export const STATUS_ARGS = Object.freeze(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
const REDIRECTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES'];
const slash = p => p.replace(/\\/g, '/');
const failure = (code, extra = {}) => ({ ok: false, code, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), ...extra });
const live = child => !!child?.pid && child.exitCode == null && child.signalCode == null;

export function canonicalWorktree(cwd) {
  let folder;
  try { folder = realpathSync(cwd); } catch { folder = resolve(cwd); }
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(resolve(at, '.git'))) return at;
    if (dirname(at) === at) return folder;
  }
}
export function worktreeRelative(root, cwd, platform = process.platform) {
  return slash((platform === 'win32' ? win32 : posix).relative(root, cwd));
}
export function watchRelative(root, path, platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix;
  const rel = paths.isAbsolute(path || '') ? worktreeRelative(root, path, platform) : slash(path || '');
  return platform === 'win32' ? rel.toLowerCase() : rel;
}
// Membership is O(path depth), never a copied/scanned list on each filesystem event.
export function createIgnoredPrefixes(platform = process.platform, limit = 4096) {
  const paths = new Set();
  const normalize = p => platform === 'win32' ? slash(p).toLowerCase() : slash(p);
  return {
    add(path) {
      path = normalize(path);
      if (!paths.has(path) && paths.size >= limit) paths.delete(paths.values().next().value);
      paths.add(path);
    },
    has(path) {
      path = normalize(path).replace(/\/$/, '');
      if (paths.has(path) || paths.has(path + '/')) return true;
      for (let i = path.lastIndexOf('/'); i >= 0; i = path.lastIndexOf('/', i - 1)) if (paths.has(path.slice(0, i + 1))) return true;
      return false;
    },
    clear: () => paths.clear(),
    get size() { return paths.size; },
  };
}

export function parseStatus(buffer) {
  const fields = String(buffer).split('\0');
  const changes = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const [x, y] = entry;
    if ('RC'.includes(x) || 'RC'.includes(y)) i++;
    const xy = x + y;
    if (xy === '!!') continue;
    const status = xy === '??' ? 'untracked' : x === 'U' || y === 'U' || xy === 'DD' || xy === 'AA' ? 'conflict'
      : x === 'A' ? 'added' : x === 'D' || y === 'D' ? 'deleted' : x === 'R' ? 'renamed'
        : x !== ' ' && y !== ' ' ? 'mixed' : x !== ' ' ? 'staged' : 'modified';
    changes.push({ path: entry.slice(3), status, staged: x !== ' ' && x !== '?' });
  }
  return changes;
}

export function createGitStatusRunner({
  spawnImpl = spawn, spawnSyncImpl = spawnSync, kill = process.kill.bind(process), platform = process.platform,
  timeoutMs = 15000, debounceMs = 150, minIntervalMs = 2000, cacheMs = 30000, maxConcurrent = 2, maxRepos = 64,
  backoffMs = 30000, maxBackoffMs = 300000, uncoveredCacheMs = 2000, killGraceMs = 1500, taskkillMs = 1000,
  watch = true, watchFactory = createTreeWatcher, watchdog = spawnImpl === spawn, now = Date.now,
} = {}) {
  const binaries = new Map();
  const entries = new Map(), monitors = createMonitorMemo(), queue = [], children = new Set();
  let active = 0, closed = false, guard = null, guardReady = null;
  const nullDevice = platform === 'win32' ? String.raw`\\.\nul` : devNull;
  const keyOf = root => platform === 'win32' ? root.toLowerCase() : root;
  const directKill = child => { if (children.has(child) && live(child)) try { child.kill('SIGKILL'); } catch { /* already gone */ } };

  function killTree(child, sync = false) {
    if (!children.has(child) || !live(child)) return Promise.resolve();
    if (platform !== 'win32') {
      try { kill(-child.pid, 'SIGKILL'); } catch { directKill(child); }
      return Promise.resolve();
    }
    const args = ['/pid', String(child.pid), '/T', '/F'];
    if (sync) {
      // Only process 'exit' uses this last resort: Node cannot drain async work there.
      try { if (spawnSyncImpl('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: taskkillMs }).status !== 0) directKill(child); }
      catch { directKill(child); }
      return Promise.resolve();
    }
    return new Promise(done => {
      let task, timer, settled = false;
      const finish = code => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (code !== 0) directKill(child);
        done();
      };
      try {
        task = spawnImpl('taskkill', args, { windowsHide: true, stdio: 'ignore', shell: false });
        task.once('error', () => finish(-1));
        task.once('exit', finish); task.once('close', finish);
        timer = setTimeout(() => { try { if (live(task)) task.kill('SIGKILL'); } catch { /* gone */ } finish(-1); }, taskkillMs);
      } catch { finish(-1); }
    });
  }
  function sendGuard(message) {
    if (guard?.connected) try { guard.send(message, () => {}); } catch { /* guard failure aborts owned jobs */ }
  }
  function startGuard() {
    if (!watchdog) return Promise.resolve();
    if (guardReady) return guardReady;
    guardReady = new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('git watchdog did not start')), 3000);
      guard = spawn(process.execPath, [fileURLToPath(new URL('./git-status-watchdog.js', import.meta.url))], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
      const lost = error => { clearTimeout(timer); reject(error || new Error('git watchdog exited')); for (const owned of children) void killTree(owned); };
      guard.on('error', lost);
      guard.once('exit', () => { if (!closed) lost(); });
      // Do not launch a child until the guard has installed its IPC/disconnect handlers.
      guard.once('message', message => {
        if (message !== 'ready') return;
        clearTimeout(timer); guard.unref(); guard.channel?.unref(); done();
      });
    });
    return guardReady;
  }
  function forget(child) {
    if (!children.delete(child)) return;
    sendGuard({ remove: child.pid });
  }
  function pump() {
    while (!closed && active < maxConcurrent && queue.length) {
      const job = queue.shift();
      if (job.signal?.aborted) { job.done(failure('aborted')); continue; }
      active++;
      job.start().catch(() => failure('failed')).then(value => { active--; job.done(value); pump(); });
    }
  }
  function execute(binary, args, { cwd, env, maxBuffer = 64 * 1024 * 1024, timeoutMs: limit = timeoutMs, signal, input, resolvedBinary = false } = {}) {
    if (closed || signal?.aborted) return Promise.resolve(failure('aborted'));
    if (platform === 'win32' && binary === 'git' && !resolvedBinary) {
      const key = env?.PATH || env?.Path || process.env.PATH;
      if (!binaries.has(key)) {
        if (binaries.size >= 4) binaries.delete(binaries.keys().next().value);
        binaries.set(key, execute('where.exe', ['git'], { env, timeoutMs: 1000 }).then(result => {
          const paths = result.ok ? String(result.stdout).split(/\r?\n/).map(p => p.trim()).filter(Boolean) : [];
          return paths.find(p => /\.exe$/i.test(p)) || paths[0] || 'git';
        }));
      }
      return binaries.get(key).then(file => execute(file, args, { cwd, env, maxBuffer, timeoutMs: limit, signal, input, resolvedBinary: true }));
    }
    return new Promise(done => {
      const job = { done, signal, start: async () => {
        await startGuard();
        if (closed || signal?.aborted) return failure('aborted');
        return new Promise(finish => {
          let child, timer, fallback, reason = null, size = 0, settled = false;
          const out = [], err = [];
          const settle = code => {
            if (settled) return;
            settled = true; clearTimeout(timer); clearTimeout(fallback);
            signal?.removeEventListener('abort', abort);
            if (!live(child)) forget(child);
            child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
            child?.unref?.();
            finish({ ok: !reason && code === 0, code: reason || code, status: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut: reason === 'timed-out', tooLarge: reason === 'too-large' });
          };
          const stop = code => {
            if (reason || settled) return;
            reason = code;
            // A failed kill or a descendant holding stdio cannot strand a queue slot.
            fallback = setTimeout(() => settle(null), killGraceMs);
            void killTree(child).then(() => { if (reason && !settled) settle(null); });
          };
          const abort = () => stop('aborted');
          try {
            // .cmd/.bat shims require cmd.exe on Windows. All ordinary git reads
            // still use an argument array without a shell; preserve a resolved shim.
            const shell = platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
            child = spawnImpl(binary, args, { cwd, env, detached: platform !== 'win32', windowsHide: true, shell, stdio: ['pipe', 'pipe', 'pipe'] });
            children.add(child);
            try { if (spawnImpl === spawn && child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
            const hardLimit = Math.max(1, Math.min(limit || timeoutMs, timeoutMs));
            sendGuard({ add: child.pid, deadline: now() + hardLimit });
            timer = setTimeout(() => stop('timed-out'), hardLimit);
            const collect = list => chunk => {
              if (settled || reason) return;
              const bytes = Buffer.from(chunk); size += bytes.length;
              if (size > maxBuffer) stop('too-large'); else list.push(bytes);
            };
            child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
            child.stdin.on('error', () => {});
            child.once('error', error => { reason ||= error.code || 'failed'; void killTree(child); settle(null); });
            child.once('exit', code => {
              // Drop ownership immediately: this PID can be reused before close.
              forget(child); clearTimeout(timer);
              // close normally drains the remaining output. An inherited open pipe
              // must not keep a completed process occupying a slot indefinitely.
              if (!settled) { clearTimeout(fallback); fallback = setTimeout(() => settle(code), 100); }
            });
            child.once('close', code => { forget(child); settle(code); });
            child.stdin.end(input);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          } catch (error) {
            reason ||= error.code || 'failed';
            if (child) void killTree(child);
            settle(null);
          }
        });
      } };
      const cancelQueued = () => { const i = queue.indexOf(job); if (i >= 0) { queue.splice(i, 1); job.done(failure('aborted')); } };
      signal?.addEventListener('abort', cancelQueued, { once: true });
      job.done = value => { signal?.removeEventListener('abort', cancelQueued); done(value); };
      queue.push(job); pump();
    });
  }
  async function run(args, { cwd, binary = 'git', env = process.env, ...options } = {}) {
    const clean = { ...env };
    for (const name of REDIRECTING) delete clean[name];
    const safeEnv = gitReadEnv(clean);
    let monitor = false;
    if (readsIndex(args)) {
      monitor = monitors.get(cwd);
      if (monitor === undefined) {
        const probe = await execute(binary, ['--no-pager', '-c', `core.hooksPath=${nullDevice}`, 'config', '--type=bool', '--get', 'core.fsmonitor'], { ...options, timeoutMs: 3000, cwd, env: safeEnv });
        monitor = monitors.set(cwd, probe.ok && String(probe.stdout).trim() === 'true');
      }
    }
    return execute(binary, gitReadArgs(args, { monitor, nullDevice }), { ...options, cwd, env: safeEnv });
  }
  function drop(key, entry) {
    entry.controller?.abort(); entry.watcher?.close(); entries.delete(key);
  }
  function entryOf(cwd) {
    const root = canonicalWorktree(cwd), key = keyOf(root);
    let entry = entries.get(key);
    if (!entry) {
      for (const [k, e] of entries) if (entries.size >= maxRepos && !e.flight) { drop(k, e); break; }
      entry = { key, root, revision: 0, value: null, good: null, at: 0, nextStartAt: 0, retryAt: 0, failures: 0, flight: null, flightRevision: null, consumers: new Set(), ignored: new Map(), ignoreRevision: 0, ignoreAt: now(), ignoredPaths: createIgnoredPrefixes(platform) };
      entries.set(key, entry);
    }
    if (watch && !entry.watcher && existsSync(resolve(root, '.git'))) {
      entry.watcher = watchFactory({ root, onError: () => invalidate(root), ignoresGit: path => entry.ignoredPaths.has(watchRelative(root, path, platform)), onChange: ({ git, ignores }) => { if (git || ignores) invalidate(root, { ignores }); } });
      entry.watcher.setDirs?.([root]);
    }
    return entry;
  }
  function invalidate(cwd, { ignores = false, refresh = false } = {}) {
    const entry = entries.get(keyOf(canonicalWorktree(cwd)));
    if (!entry) return;
    entry.revision++;
    if (refresh) { entry.failures = 0; entry.retryAt = 0; }
    if (ignores) { entry.ignoreRevision++; entry.ignored.clear(); entry.ignoredPaths.clear(); entry.ignoreAt = now(); }
  }
  function store(entry, result, revision) {
    const value = { ...result, repo: entry.root, revision };
    if (result.code === 'aborted') return value;
    entry.at = now();
    if (result.ok) {
      entry.good = value; entry.failures = 0; entry.retryAt = 0;
    } else {
      entry.retryAt = now() + Math.min(maxBackoffMs, backoffMs * 2 ** Math.min(entry.failures++, 20));
      value.changes = entry.good?.changes || [];
      value.branch ||= entry.good?.branch || null;
      value.isGit ||= !!entry.good?.isGit;
      value.partial = true; value.stale = true; value.retryAt = entry.retryAt;
    }
    entry.value = value;
    return value;
  }
  function read(cwd, { signal, refresh = false } = {}) {
    if (!cwd || closed || signal?.aborted) return Promise.resolve(failure('aborted'));
    const entry = entryOf(cwd);
    if (refresh) invalidate(cwd, { refresh: true });
    if (entry.flight && entry.controller?.signal.aborted) return entry.flight.then(() => read(cwd, { signal }));
    // Watcher churn cannot bypass a failing repository's backoff. Refresh can.
    if (!entry.flight && entry.value && !entry.value.ok && now() < entry.retryAt) return Promise.resolve(entry.value);
    const coverage = entry.watcher?.state?.();
    const ttl = coverage && (coverage.scope !== 'tree' || coverage.live !== 'full') ? Math.min(cacheMs, uncoveredCacheMs) : cacheMs;
    if (!entry.flight && entry.value?.ok && now() - entry.at < ttl && entry.value.revision === entry.revision) return Promise.resolve(entry.value);
    if (!entry.flight) {
      entry.controller = new AbortController();
      const control = entry.controller;
      let started = false;
      entry.flight = (async () => {
        const delay = Math.max(debounceMs, entry.nextStartAt - now());
        await new Promise(done => { const abort = () => { clearTimeout(timer); done(); }; const timer = setTimeout(() => { control.signal.removeEventListener('abort', abort); done(); }, delay); control.signal.addEventListener('abort', abort, { once: true }); });
        if (control.signal.aborted) return failure('aborted');
        started = true;
        const revision = entry.flightRevision = entry.revision;
        const options = { cwd: entry.root, signal: control.signal };
        const named = await run(['symbolic-ref', '--short', '-q', 'HEAD'], options);
        let branch = named.ok ? String(named.stdout).trim() : '';
        const inside = await run(['rev-parse', '--is-inside-work-tree'], options);
        if (!inside.ok) {
          const notGit = inside.status === 128 && /not a git repository/i.test(String(inside.stderr));
          return store(entry, { ...inside, ...(notGit ? { ok: true } : {}), isGit: !notGit && (inside.timedOut || !!entry.good?.isGit), branch, changes: [] }, revision);
        }
        if (!branch) { const head = await run(['rev-parse', '--short', 'HEAD'], options); if (head.ok) branch = String(head.stdout).trim(); }
        const status = await run(STATUS_ARGS, { ...options, timeoutMs: 10000 });
        return store(entry, { ...status, stdout: Buffer.alloc(0), isGit: true, branch, changes: status.ok ? parseStatus(status.stdout) : [] }, revision);
      })().finally(() => { entry.flight = null; entry.flightRevision = null; entry.controller = null; if (started) entry.nextStartAt = now() + minIntervalMs; });
    }
    const revision = entry.revision, token = {};
    entry.consumers.add(token);
    return new Promise(done => {
      let finished = false;
      const finish = value => {
        if (finished) return;
        finished = true; signal?.removeEventListener('abort', abort); entry.consumers.delete(token);
        if (!signal?.aborted && value.ok && value.revision < revision) done(read(cwd, { signal }));
        else done(value);
      };
      const abort = () => { finish(failure('aborted')); if (!entry.consumers.size) entry.controller?.abort(); };
      signal?.addEventListener('abort', abort, { once: true });
      entry.flight.then(finish, () => finish(failure('failed')));
      if (signal?.aborted) abort();
    });
  }
  // null means unknown, [] means checked and not ignored. Listings may warm the
  // cache without waiting; searches wait so they never descend an unknown cache.
  async function ignored(cwd, paths, { signal, cacheOnly = false } = {}) {
    const entry = entryOf(cwd);
    if (!existsSync(resolve(entry.root, '.git'))) return [];
    if (now() - entry.ignoreAt >= cacheMs) invalidate(cwd, { ignores: true });
    const input = paths.filter(p => p && !p.includes('\0'));
    if (!input.length) return [];
    const key = `${keyOf(cwd)}\0${input.join('\0')}`;
    let known = entry.ignored.get(key);
    if (!known || now() - known.at >= cacheMs) {
      if (!known?.flight) {
        const revision = entry.ignoreRevision;
        known = { at: now(), paths: null };
        const record = known;
        known.flight = run(['check-ignore', '-z', '--stdin'], { cwd, signal: cacheOnly ? undefined : signal, input: input.join('\0') + '\0', maxBuffer: 4 * 1024 * 1024 }).then(result => {
          record.paths = result.ok ? String(result.stdout).split('\0').filter(Boolean) : result.status === 1 && result.code === 1 ? [] : null;
          record.at = now(); record.flight = null;
          if (revision !== entry.ignoreRevision) return null;
          const prefix = worktreeRelative(entry.root, cwd, platform);
          for (const path of record.paths || []) entry.ignoredPaths.add((prefix ? prefix + '/' : '') + path);
          return record.paths;
        });
        if (entry.ignored.size >= MAX_IGNORE_FOLDERS) entry.ignored.delete(entry.ignored.keys().next().value);
        entry.ignored.set(key, known);
      }
    }
    if (known.flight) return cacheOnly ? null : known.flight;
    return known.paths;
  }
  function release(cwd) {
    const entry = entries.get(keyOf(canonicalWorktree(cwd)));
    if (!entry) return;
    entry.watcher?.close(); entry.watcher = null;
    if (!entry.consumers.size) entry.controller?.abort();
  }
  function shutdown({ sync = false } = {}) {
    closed = true;
    for (const entry of entries.values()) { entry.controller?.abort(); entry.watcher?.close(); }
    for (const job of queue.splice(0)) job.done(failure('aborted'));
    for (const child of children) void killTree(child, sync);
    if (guard?.connected) guard.disconnect();
  }
  return { read, run, runRaw: (args, options = {}) => execute(options.binary || 'git', args, { ...options, env: withGitFallback(options.env) }), ignored, invalidate, release, shutdown, stats: () => ({ active, queued: queue.length, children: children.size, repos: entries.size }) };
}

export function projectStatus(result, cwd, platform = process.platform) {
  let folder;
  try { folder = realpathSync(cwd); } catch { folder = platform === 'win32' ? win32.resolve(cwd) : resolve(cwd); }
  const below = result.repo ? worktreeRelative(result.repo, folder, platform) : '';
  const prefix = below ? `${below}/` : '';
  const compare = p => platform === 'win32' ? p.toLowerCase() : p;
  return { ...result, changes: (result.changes || []).filter(c => !prefix || compare(c.path).startsWith(compare(prefix))).map(c => ({ ...c, path: prefix ? c.path.slice(prefix.length) : c.path })) };
}
export const gitStatusRunner = createGitStatusRunner();
process.on('exit', () => gitStatusRunner.shutdown({ sync: true }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  gitStatusRunner.shutdown();
  if (process.listenerCount(signal) === 1) process.exit(signal === 'SIGINT' ? 130 : 143);
});
