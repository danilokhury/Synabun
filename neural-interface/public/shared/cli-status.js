// ═══════════════════════════════════════════
// SynaBun — CLI Status (shared)
// Detects whether Claude / Codex / OpenCode CLIs are installed by
// querying /api/system/tool-versions. Caches the response, fans out
// updates to subscribers, and auto-polls (every 30s) while at least
// one subscribed tool is not installed (missing, or found but broken).
//
// Each tool's answer carries `state` ('installed' | 'missing' | 'broken'),
// the version, where it was found, the error of a CLI that would not start,
// and `install`: whether the server can install it with one click from the
// vendor's official source. installCli() runs that install (POST
// /api/cli/install/:tool, an NDJSON stream) and re-checks when it ends.
// What the panels show for all of it is cli-install-view.js.
// ═══════════════════════════════════════════

import { cliStateOf, cliInstallOffer, INSTALLABLE_CLIS } from './cli-install-view.js';

export { cliStateOf, cliInstallOffer };

const TOOL_KEYS = ['claude-code', 'codex', 'opencode', 'gemini'];

// The vendors' install pages. The server's `guideUrl` wins when it sends one.
const CLI_DOC_URLS = {
  'claude-code': 'https://code.claude.com/docs/en/setup',
  'codex':       'https://learn.chatgpt.com/docs/codex/cli',
  'opencode':    'https://opencode.ai/v2/docs',
  'gemini':      'https://github.com/google-gemini/gemini-cli',
};

// Fallback only. The server computes the command that fits the machine (the
// vendor's recommended installer for its system, or the package manager the
// other CLIs came from: buildInstallCommand in lib/cli-update-planner.js) and
// returns it as `installCommand`. These apply only before the first
// tool-versions response.
const CLI_INSTALL_CMDS = {
  'claude-code': { posix: 'curl -fsSL https://claude.ai/install.sh | bash', windows: 'irm https://claude.ai/install.ps1 | iex' },
  'codex':       { posix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', windows: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"' },
  'opencode':    { posix: 'curl -fsSL https://opencode.ai/v2/install | bash', windows: 'winget install --id Anomaly.OpenCode --exact' },
  'gemini':      { posix: 'npm install -g @google/gemini-cli', windows: 'npm install -g @google/gemini-cli' },
};

const CLI_LABELS = {
  'claude-code': 'Claude Code',
  'codex':       'Codex',
  'opencode':    'OpenCode',
  'gemini':      'Gemini CLI',
};

const POLL_INTERVAL_MS = 30000;
const CACHE_TTL_MS = 10000;
// How often an install another window (or an earlier page) started is asked
// about, and for how long at most.
const INSTALL_POLL_MS = 2000;
const INSTALL_FOLLOW_MAX_MS = 30 * 60 * 1000;

let _cache = { fetchedAt: 0, tools: null };
// What a subscriber is handed for a CLI the answer says nothing about: not
// "missing" (nothing was said), and `installed: null` for the callers that only
// read that field.
const unknownInfo = () => ({ installed: null, state: 'unknown' });
let _inflight = null;
const _subscribers = new Map();
let _pollTimer = null;
const _installs = new Map(); // toolKey → { promise, listeners: Set }

function isWindowsPage() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  if (nav.userAgentData?.platform && /windows/i.test(nav.userAgentData.platform)) return true;
  return /windows/i.test(nav.userAgent || '');
}

export function getCliDocUrl(toolKey) {
  const fromServer = _cache.tools?.[toolKey]?.guideUrl;
  if (typeof fromServer === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(fromServer)) return fromServer;
  return CLI_DOC_URLS[toolKey] || null;
}

export function getCliInstallCommand(toolKey) {
  const fromServer = _cache.tools?.[toolKey]?.installCommand;
  if (fromServer) return fromServer;
  const fallback = CLI_INSTALL_CMDS[toolKey];
  if (!fallback) return '';
  return isWindowsPage() ? fallback.windows : fallback.posix;
}

export function getCliLabel(toolKey) {
  return CLI_LABELS[toolKey] || toolKey;
}

/** This CLI in the latest answer, or null before the first one. */
export function getCliInfo(toolKey) {
  return _cache.tools?.[toolKey] || null;
}

/** 'installed' | 'missing' | 'broken' | 'unknown' (no answer yet), from the latest answer. */
export function getCliState(toolKey) {
  return cliStateOf(getCliInfo(toolKey));
}

/** The error a found-but-broken CLI gave when it was started, or null. */
export function getCliError(toolKey) {
  const info = getCliInfo(toolKey);
  return cliStateOf(info) === 'broken' && typeof info?.error === 'string' && info.error ? info.error : null;
}

/** The one-click install the server offers for this CLI, or null (none for this system, or an older server). */
export function getCliInstallOffer(toolKey) {
  return cliInstallOffer(getCliInfo(toolKey));
}

async function _fetchToolVersions(force) {
  if (!force && _cache.tools && (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS) {
    return _cache.tools;
  }
  if (_inflight) return _inflight;
  const url = force ? '/api/system/tool-versions?force=1' : '/api/system/tool-versions';
  _inflight = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      _cache = { fetchedAt: Date.now(), tools: data?.tools || {} };
      return _cache.tools;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

// What a subscriber is told about: a change of state, version or place. A
// broken CLI and a missing one both have `installed: null`, so the version
// alone would hide a CLI that went from missing to broken (or back).
function _signature(info) {
  if (!info) return 'none';
  return [cliStateOf(info), info.installed ?? '', info.binPath ?? '', info.error ?? '', JSON.stringify(info.pathStatus || null)].join('|');
}

/** Explicit consent from Add to PATH. The server accepts only a tool key. */
export async function addCliToPath(toolKey) {
  if (!INSTALLABLE_CLIS.includes(toolKey)) throw new Error('Unknown CLI');
  const res = await fetch(`/api/cli/path/${encodeURIComponent(toolKey)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' }, body: '{}',
  });
  const result = await res.json();
  if (!res.ok && !(res.status === 409 && result.code === 'NOT_NEEDED')) throw new Error(result.error || result.code || `HTTP ${res.status}`);
  await recheckCliStatus(toolKey);
  return result;
}

// `force` makes a deliberate re-check notify subscribers even when the
// version string is unchanged. Without it the Re-check button was a no-op by
// construction: a panel that latched a "CLI not installed" banner after a
// spawn error could only clear the latch from this callback, but the version
// had not changed, so the callback never fired and the banner was permanent.
// The background poller deliberately keeps the change-only behaviour.
function _emitChange(prevTools, nextTools, { force = false } = {}) {
  for (const key of TOOL_KEYS) {
    const subs = _subscribers.get(key);
    if (!subs || !subs.size) continue;
    if (force || prevTools == null || _signature(prevTools?.[key]) !== _signature(nextTools?.[key])) {
      const info = nextTools?.[key] || unknownInfo();
      for (const cb of subs) {
        try { cb(info); } catch (e) { console.error('[cli-status] subscriber error:', e); }
      }
    }
  }
}

// Asked again every 30 s while a subscribed CLI is missing or broken: one
// installed (or repaired) meanwhile is found without a click. A CLI the answer
// says nothing about is not waited for.
function _hasMissingSubscribed() {
  for (const key of _subscribers.keys()) {
    const subs = _subscribers.get(key);
    if (!subs?.size) continue;
    if (!_cache.tools) return true;
    const info = _cache.tools[key];
    if (!info) continue;
    const state = cliStateOf(info);
    if (state === 'missing' || state === 'broken') return true;
  }
  return false;
}

function _maybeStartPoller() {
  if (_pollTimer) return;
  if (!_hasMissingSubscribed()) return;
  _pollTimer = setInterval(async () => {
    if (document.hidden) return;
    if (!_hasMissingSubscribed()) {
      _stopPoller();
      return;
    }
    const prev = _cache.tools;
    try {
      const next = await _fetchToolVersions(true);
      _emitChange(prev, next);
      if (!_hasMissingSubscribed()) _stopPoller();
    } catch { /* ignore — retry next tick */ }
  }, POLL_INTERVAL_MS);
}

function _stopPoller() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

export async function getCliStatus(toolKey, { force = false } = {}) {
  const tools = await _fetchToolVersions(force);
  return tools?.[toolKey] || { ...unknownInfo(), latest: null };
}

export function subscribeCliStatus(toolKey, callback) {
  if (!TOOL_KEYS.includes(toolKey)) return () => {};
  let set = _subscribers.get(toolKey);
  if (!set) { set = new Set(); _subscribers.set(toolKey, set); }
  set.add(callback);

  const cached = _cache.tools?.[toolKey];
  if (cached) {
    try { callback(cached); } catch (e) { console.error('[cli-status] subscriber error:', e); }
    _maybeStartPoller();
  } else {
    _fetchToolVersions(false).then((tools) => {
      try { callback(tools?.[toolKey] || unknownInfo()); } catch {}
      _maybeStartPoller();
    }).catch(() => {});
  }

  return () => {
    const s = _subscribers.get(toolKey);
    if (!s) return;
    s.delete(callback);
    if (!s.size) _subscribers.delete(toolKey);
    if (!_hasMissingSubscribed()) _stopPoller();
  };
}

export async function recheckCliStatus(toolKey) {
  const prev = _cache.tools;
  const next = await _fetchToolVersions(true);
  _emitChange(prev, next, { force: true });
  return next?.[toolKey] || unknownInfo();
}

// ── One-click install ──────────────────────────────────────────────────────

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a refusal before the stream (a JSON answer) means, as a `done` event. */
function _refusal(status, body) {
  const code = String(body?.code || '');
  let reason = 'internal';
  if (code === 'UNSUPPORTED' || code === 'UNKNOWN_TOOL' || status === 422) reason = 'unsupported';
  else if (status === 403 || status === 415) reason = 'refused';
  return {
    type: 'done', ok: false, code: reason,
    error: typeof body?.error === 'string' && body.error ? body.error : (code || `HTTP ${status}`),
    manualCommand: typeof body?.manualCommand === 'string' ? body.manualCommand : null,
    guideUrl: typeof body?.guideUrl === 'string' ? body.guideUrl : null,
  };
}

/**
 * The installs the server knows about: { [tool]: { state: 'running' | 'done' | 'failed', step, code, error,
 * log, startedAt, endedAt } }. An older server (no install route) answers {}.
 */
export async function getCliInstallJobs() {
  try {
    const res = await fetch('/api/cli/install', { headers: { Accept: 'application/json' } });
    if (!res.ok) return {};
    const data = await res.json();
    return data?.jobs && typeof data.jobs === 'object' ? data.jobs : {};
  } catch {
    return {};
  }
}

/**
 * Follow an install that is already running on the server (started from another window, or before this page
 * was loaded) through GET /api/cli/install: its steps and new log lines go to `onEvent`, and the end is a
 * `done` event like the stream's. Resolves that event.
 */
export async function followCliInstall(toolKey, { onEvent = () => {}, pollMs = INSTALL_POLL_MS, maxMs = INSTALL_FOLLOW_MAX_MS } = {}) {
  const startedAt = Date.now();
  let seenLines = 0;
  let lastStep = null;
  let sawJob = false;
  for (;;) {
    const job = (await getCliInstallJobs())[toolKey];
    if (job && typeof job === 'object') {
      sawJob = true;
      if (job.step && job.step !== lastStep) {
        lastStep = job.step;
        onEvent({ type: 'step', step: job.step });
      }
      const log = Array.isArray(job.log) ? job.log : [];
      if (log.length < seenLines) seenLines = 0; // a new job: its log starts again
      for (const entry of log.slice(seenLines)) onEvent({ type: 'log', line: entry });
      seenLines = log.length;
      if (job.state && job.state !== 'running') {
        if (job.state === 'done') {
          const status = await recheckCliStatus(toolKey).catch(() => null);
          const done = { type: 'done', ok: true, status, path: job.path && typeof job.path === 'object' ? job.path : null };
          onEvent(done);
          return done;
        }
        const failed = { type: 'done', ok: false, code: job.code || 'internal', error: job.error || null, manualCommand: job.manualCommand || null, guideUrl: job.guideUrl || null, log };
        onEvent(failed);
        return failed;
      }
    } else if (sawJob || Date.now() - startedAt > pollMs * 3) {
      // The job is gone (a restarted server), or never showed up: ask about the CLI itself.
      const status = await recheckCliStatus(toolKey).catch(() => null);
      const done = cliStateOf(status) === 'installed'
        ? { type: 'done', ok: true, status, path: null }
        : { type: 'done', ok: false, code: 'connection', error: null };
      onEvent(done);
      return done;
    }
    if (Date.now() - startedAt > maxMs) {
      const done = { type: 'done', ok: false, code: 'timeout', error: null };
      onEvent(done);
      return done;
    }
    await wait(pollMs);
  }
}

async function _readNdjson(res, onEvent) {
  let final = null;
  const take = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let event;
    try { event = JSON.parse(trimmed); } catch { return; }
    if (!event || typeof event !== 'object') return;
    onEvent(event);
    if (event.type === 'done') final = event;
  };
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        take(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    }
    buffer += decoder.decode();
    take(buffer);
  } else {
    for (const piece of String(await res.text()).split('\n')) take(piece);
  }
  return final;
}

/**
 * Install a CLI with one click: the server runs the vendor's official installer for its system and streams what
 * happens (`start`, `step`, `progress`, `log`, then one `done`). Every event goes to `onEvent`; the promise
 * resolves the `done` event. After a successful install the status is asked again (with force), so every panel
 * subscribed to this CLI hears of it. Never rejects.
 *
 * One install per CLI at a time in this page: a second call follows the first one.
 * An install already running on the server (409 BUSY) is followed through GET /api/cli/install.
 */
export function installCli(toolKey, { onEvent = () => {}, pollMs = INSTALL_POLL_MS } = {}) {
  const running = _installs.get(toolKey);
  if (running) {
    running.listeners.add(onEvent);
    return running.promise;
  }
  const listeners = new Set([onEvent]);
  const emit = (event) => {
    for (const listener of listeners) {
      try { listener(event); } catch (e) { console.error('[cli-status] install listener error:', e); }
    }
  };
  const promise = (async () => {
    if (!INSTALLABLE_CLIS.includes(toolKey)) {
      const refused = { type: 'done', ok: false, code: 'unsupported', error: null };
      emit(refused);
      return refused;
    }
    let final = null;
    try {
      const res = await fetch(`/api/cli/install/${encodeURIComponent(toolKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1', Accept: 'application/x-ndjson' },
        body: '{}',
      });
      if (!res.ok) {
        let body = {};
        try { body = await res.json(); } catch { /* no body */ }
        if (res.status === 409 && String(body?.code || '').toUpperCase() === 'BUSY') {
          return await followCliInstall(toolKey, { onEvent: emit, pollMs });
        }
        final = _refusal(res.status, body);
        emit(final);
        return final;
      }
      final = await _readNdjson(res, emit);
    } catch {
      final = null;
    }
    if (!final) {
      // The connection closed without an end: the server may still be at it.
      return await followCliInstall(toolKey, { onEvent: emit, pollMs });
    }
    if (final.ok) await recheckCliStatus(toolKey).catch(() => null);
    return final;
  })().finally(() => { _installs.delete(toolKey); });
  _installs.set(toolKey, { promise, listeners });
  return promise;
}

/** Whether this page has an install of this CLI under way. */
export function isCliInstalling(toolKey) {
  return _installs.has(toolKey);
}
