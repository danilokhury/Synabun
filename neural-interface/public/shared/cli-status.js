// ═══════════════════════════════════════════
// SynaBun — CLI Status (shared)
// Detects whether Claude / Codex / OpenCode CLIs are installed by
// querying /api/system/tool-versions. Caches the response, fans out
// updates to subscribers, and auto-polls (every 30s) while at least
// one subscribed tool reports installed=null.
// ═══════════════════════════════════════════

const TOOL_KEYS = ['claude-code', 'codex', 'opencode', 'gemini'];

const CLI_DOC_URLS = {
  'claude-code': 'https://docs.claude.com/en/docs/claude-code/setup',
  'codex':       'https://developers.openai.com/codex/cli/',
  'opencode':    'https://opencode.ai/docs/',
  'gemini':      'https://github.com/google-gemini/gemini-cli',
};

// Fallback only. The server computes the channel-correct command (see
// buildInstallCommand in lib/cli-update-planner.js) and returns it as
// `installCommand`, so a Homebrew user is told `brew install --cask codex`
// rather than an npm command that would create a second conflicting install.
// These npm defaults apply only before the first tool-versions response.
const CLI_INSTALL_CMDS = {
  'claude-code': 'npm install -g @anthropic-ai/claude-code',
  'codex':       'npm install -g @openai/codex',
  'opencode':    'npm install -g opencode-ai',
  'gemini':      'npm install -g @google/gemini-cli',
};

const CLI_LABELS = {
  'claude-code': 'Claude Code',
  'codex':       'Codex',
  'opencode':    'OpenCode',
  'gemini':      'Gemini CLI',
};

const POLL_INTERVAL_MS = 30000;
const CACHE_TTL_MS = 10000;

let _cache = { fetchedAt: 0, tools: null };
let _inflight = null;
const _subscribers = new Map();
let _pollTimer = null;

export function getCliDocUrl(toolKey) {
  return CLI_DOC_URLS[toolKey] || null;
}

export function getCliInstallCommand(toolKey) {
  return _cache.tools?.[toolKey]?.installCommand || CLI_INSTALL_CMDS[toolKey] || '';
}

export function getCliLabel(toolKey) {
  return CLI_LABELS[toolKey] || toolKey;
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

// `force` makes a deliberate re-check notify subscribers even when the
// version string is unchanged. Without it the Re-check button was a no-op by
// construction: a panel that latched a "CLI not installed" banner after a
// spawn error could only clear the latch from this callback, but the version
// had not changed, so the callback never fired and the banner was permanent.
// The background poller deliberately keeps the change-only behaviour.
function _emitChange(prevTools, nextTools, { force = false } = {}) {
  for (const key of TOOL_KEYS) {
    const prev = prevTools?.[key]?.installed ?? null;
    const next = nextTools?.[key]?.installed ?? null;
    const subs = _subscribers.get(key);
    if (!subs || !subs.size) continue;
    if (force || prev !== next || prevTools == null) {
      const info = nextTools?.[key] || { installed: null };
      for (const cb of subs) {
        try { cb(info); } catch (e) { console.error('[cli-status] subscriber error:', e); }
      }
    }
  }
}

function _hasMissingSubscribed() {
  for (const key of _subscribers.keys()) {
    const subs = _subscribers.get(key);
    if (!subs?.size) continue;
    const installed = _cache.tools?.[key]?.installed ?? null;
    if (!installed) return true;
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
  return tools?.[toolKey] || { installed: null, latest: null };
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
      try { callback(tools?.[toolKey] || { installed: null }); } catch {}
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
  return next?.[toolKey] || { installed: null };
}
