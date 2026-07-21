import { on } from './state.js';
import { attachClaudeAutomation, detachClaudeAutomation, handleClaudeAutomationEvent } from './ui-claude-panel.js';
import { attachCodexAutomation, detachCodexAutomation, handleCodexAutomationEvent } from './ui-codex-panel.js';
import { attachOpenCodeAutomation, detachOpenCodeAutomation } from './ui-opencode-panel-v2.js';
import { nativeLoopWindowId } from './ui-native-window-id.js';
import {
  isNewerRunDescriptor,
  LocalReleaseTracker,
  resolveRouteClaim,
} from './ui-native-loop-router-state.js';

const DISMISSED_KEY = 'synabun-native-loop-dismissed';
const CLAIM_TTL_MS = 90_000;
const TERMINAL_RESTORE_LIMIT = 10;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const _windowId = nativeLoopWindowId;

const _attached = new Map();
const _ownedClaims = new Map();
const _dismissed = new Set();
const _routeQueues = new Map();
const _latestRuns = new Map();
const _providerEventBuffers = new Map();
const _localReleases = new LocalReleaseTracker();
let _initialized = false;
let _claimHeartbeat = null;
let _suspended = false;
let _suspendedClaims = new Map();
let _reconcilePromise = null;
let _claimToken = crypto.randomUUID();
let _claimEpoch = 0;

function mergeDismissed(raw) {
  let stored;
  try { stored = JSON.parse(raw || '[]'); }
  catch { return []; }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const added = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    if (!entry?.runId || Number(entry.at) < cutoff) continue;
    if (!_dismissed.has(entry.runId)) added.push(entry.runId);
    _dismissed.add(entry.runId);
    _latestRuns.delete(entry.runId);
    _providerEventBuffers.delete(entry.runId);
  }
  return added;
}

try { mergeDismissed(localStorage.getItem(DISMISSED_KEY)); } catch {}

function persistDismissed() {
  try {
    const existing = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]');
    const byId = new Map((Array.isArray(existing) ? existing : []).map((entry) => [entry?.runId, entry]));
    const now = Date.now();
    for (const runId of _dismissed) byId.set(runId, { runId, at: now });
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...byId.values()].filter((entry) => entry?.runId).slice(-500)));
  } catch {}
}

function descriptorFrom(payload) {
  if (!payload) return null;
  if (payload.run?.runId) return payload.run;
  if (payload.runId) return payload;
  return null;
}

function hasIdentity(run) {
  if (run.provider === 'codex') return !!(run.providerThreadId || run.providerSessionId);
  return !!run.providerSessionId;
}

export function getNativeLoopRouterWindowId() {
  return _windowId;
}

export function getNativeLoopRouterClaimToken() {
  return _claimToken;
}

function isNewerDescriptor(next, current) {
  return isNewerRunDescriptor(next, current, TERMINAL_STATUSES);
}

function recordLatestRun(run, focus) {
  if (!run?.runId || run.surface !== 'sidepanel' || _dismissed.has(run.runId)) return false;
  const previousEntry = _latestRuns.get(run.runId);
  if (previousEntry && !isNewerDescriptor(run, previousEntry.run)) return false;
  _latestRuns.set(run.runId, { run, focus: focus ?? previousEntry?.focus });
  trimLatestRuns();
  return true;
}

function trimLatestRuns() {
  if (_latestRuns.size <= 500) return;
  const removable = [..._latestRuns.entries()]
    .filter(([runId, entry]) => TERMINAL_STATUSES.has(entry.run.status) && !_routeQueues.has(runId))
    .sort((a, b) => String(a[1].run.updatedAt || '').localeCompare(String(b[1].run.updatedAt || '')));
  for (const [runId] of removable) {
    if (_latestRuns.size <= 500) break;
    _latestRuns.delete(runId);
    _providerEventBuffers.delete(runId);
  }
}

async function claim(run) {
  const claimToken = _claimToken;
  const claimEpoch = _claimEpoch;
  try {
    const response = await fetch(`/api/sidepanel-runs/${encodeURIComponent(run.runId)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId: _windowId, claimToken }),
    });
    if (!response.ok) return false;
    if (_suspended || claimEpoch !== _claimEpoch || claimToken !== _claimToken) {
      fetch(`/api/sidepanel-runs/${encodeURIComponent(run.runId)}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId: _windowId }),
        keepalive: true,
      }).catch(() => {});
      return false;
    }
    const data = await response.json();
    const claimedRun = data?.run || run;
    _ownedClaims.set(run.runId, { provider: run.provider, status: claimedRun.status });
    recordLatestRun(claimedRun);
    return claimedRun;
  } catch {
    return false;
  }
}

async function attach(run, focus) {
  const provider = run.provider;
  const options = {
    focus,
    isCancelled: () => _suspended || _dismissed.has(run.runId) || !_ownedClaims.has(run.runId),
  };
  if (provider === 'claude-code' || provider === 'claude') {
    return attachClaudeAutomation(run, options);
  }
  if (provider === 'codex') return attachCodexAutomation(run, options);
  if (provider === 'opencode') return attachOpenCodeAutomation(run, options);
  return { ok: false, reason: 'unsupported_provider' };
}

async function detachProviderRun(runId, provider) {
  try {
    if (provider === 'claude-code' || provider === 'claude') return await detachClaudeAutomation(runId);
    if (provider === 'codex') return await detachCodexAutomation(runId);
    if (provider === 'opencode') return await detachOpenCodeAutomation(runId);
  } catch {}
  return false;
}

async function loseClaim(runId, provider) {
  _ownedClaims.delete(runId);
  _attached.delete(runId);
  _providerEventBuffers.delete(runId);
  await detachProviderRun(runId, provider);
}

function deliverProviderEvent(message) {
  const run = descriptorFrom(message);
  const payload = message?.event;
  if (!run?.runId || !payload) return false;
  try {
    if (payload.provider === 'claude-code' || payload.provider === 'claude') {
      return handleClaudeAutomationEvent(run.runId, payload);
    }
    if (payload.provider === 'codex') return handleCodexAutomationEvent(run.runId, payload);
  } catch {}
  return false;
}

function flushProviderEvents(runId) {
  const buffered = _providerEventBuffers.get(runId) || [];
  _providerEventBuffers.delete(runId);
  for (const message of buffered) deliverProviderEvent(message);
}

async function release(runId) {
  _ownedClaims.delete(runId);
  const releaseToken = _localReleases.mark(runId);
  try {
    const response = await fetch(`/api/sidepanel-runs/${encodeURIComponent(runId)}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId: _windowId }),
    });
    const data = response.ok ? await response.json().catch(() => null) : null;
    if (!data?.released) _localReleases.clear(runId, releaseToken);
    return !!data?.released;
  } catch {
    _localReleases.clear(runId, releaseToken);
    return false;
  }
}

async function routeLatest(runId) {
  const entry = _latestRuns.get(runId);
  if (_suspended) return false;
  if (!entry || _dismissed.has(runId)) return false;
  let { run } = entry;
  const resolution = await resolveRouteClaim({
    entry,
    alreadyOwned: _ownedClaims.has(runId),
    claim,
    getLatestEntry: () => _latestRuns.get(runId),
    windowId: _windowId,
    claimTtlMs: CLAIM_TTL_MS,
    terminalStatuses: TERMINAL_STATUSES,
  });
  if (!resolution.ok) {
    if (TERMINAL_STATUSES.has(run.status)) _providerEventBuffers.delete(runId);
    if (resolution.reason === 'foreign_claim') {
      await loseClaim(runId, run.provider);
    } else if (resolution.release) {
      await release(runId);
    }
    return false;
  }
  if (_dismissed.has(runId)) {
    await release(runId);
    return false;
  }
  run = resolution.run;
  const owned = _ownedClaims.get(runId);
  if (owned) {
    owned.provider = run.provider;
    owned.status = run.status;
  }
  const shouldFocus = resolution.focus
    ?? (typeof run.focus === 'boolean'
      ? run.focus
      : (!_attached.has(run.runId) && run.source === 'manual'));
  let result;
  try {
    result = await attach(run, shouldFocus);
  } catch {
    await detachProviderRun(runId, run.provider);
    await release(runId);
    return false;
  }
  if (_suspended || _dismissed.has(runId) || !_ownedClaims.has(runId)) {
    await detachProviderRun(runId, run.provider);
    await release(runId);
    return false;
  }
  if (result?.ok) {
    _attached.set(run.runId, {
      provider: run.provider,
      iteration: run.currentIteration,
      status: run.status,
    });
    flushProviderEvents(run.runId);
    if (TERMINAL_STATUSES.has(run.status)) _attached.delete(run.runId);
    return true;
  }
  await detachProviderRun(runId, run.provider);
  await release(run.runId);
  return false;
}

export function routeNativeLoopRun(payload, { focus, retry = false } = {}) {
  const run = descriptorFrom(payload);
  if (!run?.runId || run.surface !== 'sidepanel') return Promise.resolve(false);
  if (_dismissed.has(run.runId)) return Promise.resolve(false);
  const previousEntry = _latestRuns.get(run.runId);
  if (previousEntry && !isNewerDescriptor(run, previousEntry.run)) {
    if (!retry || _routeQueues.has(run.runId) || _ownedClaims.has(run.runId)) {
      return _routeQueues.get(run.runId) || Promise.resolve(false);
    }
  } else {
    recordLatestRun(run, focus);
  }
  const latestRun = _latestRuns.get(run.runId)?.run || run;
  if (!hasIdentity(latestRun) || _suspended) return Promise.resolve(false);
  const previous = _routeQueues.get(run.runId) || Promise.resolve();
  let queued;
  queued = previous.catch(() => false)
    .then(() => routeLatest(run.runId))
    .finally(() => {
      if (_routeQueues.get(run.runId) === queued) _routeQueues.delete(run.runId);
    });
  _routeQueues.set(run.runId, queued);
  return queued;
}

async function reconcileRuns() {
  try {
    const response = await fetch('/api/sidepanel-runs');
    if (!response.ok) return;
    const data = await response.json();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const newestFirst = (data.runs || [])
      .filter(hasIdentity)
      .sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')));
    const activeRuns = newestFirst.filter((run) => run.status === 'starting' || run.status === 'running');
    const terminalRuns = newestFirst.filter((run) => {
      if (!TERMINAL_STATUSES.has(run.status)) return false;
      if (new Date(run.updatedAt || run.startedAt || 0).getTime() < cutoff) return false;
      const claimAge = run.claimedAt ? Date.now() - new Date(run.claimedAt).getTime() : Infinity;
      return !run.claimedBy || run.claimedBy === _windowId || claimAge > CLAIM_TTL_MS;
    }).slice(0, TERMINAL_RESTORE_LIMIT);
    for (const run of activeRuns) await routeNativeLoopRun(run, { focus: false, retry: true });
    for (const run of terminalRuns) await routeNativeLoopRun(run, { focus: false, retry: true });
  } catch {}
}

function scheduleReconcile() {
  if (_suspended) return Promise.resolve();
  if (_reconcilePromise) return _reconcilePromise;
  _reconcilePromise = reconcileRuns().finally(() => { _reconcilePromise = null; });
  return _reconcilePromise;
}

export function initNativeLoopRouter() {
  if (_initialized) return;
  _initialized = true;
  const route = (message) => routeNativeLoopRun(message).catch(() => {});
  on('sync:sidepanel:run-created', route);
  on('sync:sidepanel:run-updated', (message) => {
    const run = descriptorFrom(message);
    if (message?.reason === 'claim-released' && run?.runId && _localReleases.consume(run.runId)) {
      recordLatestRun(run);
      return;
    }
    route(message);
  });
  on('sync:sidepanel:run-claimed', (message) => {
    const run = descriptorFrom(message);
    if (!run?.runId) return;
    if (run.claimedBy && run.claimedBy !== _windowId) {
      if (_ownedClaims.has(run.runId)) loseClaim(run.runId, run.provider);
      return;
    }
    if (run.claimedBy === _windowId && (_ownedClaims.has(run.runId) || _routeQueues.has(run.runId))) {
      recordLatestRun(run);
      return;
    }
    route(message);
  });
  on('sync:sidepanel:run-completed', route);
  on('sync:sidepanel:run-failed', route);
  on('sync:sidepanel:run-stopped', route);
  on('sync:sidepanel:provider-event', (message) => {
    const run = descriptorFrom(message);
    if (_suspended || !run?.runId || _dismissed.has(run.runId)) return;
    const claimAge = run.claimedAt ? Date.now() - new Date(run.claimedAt).getTime() : Infinity;
    if (run.claimedBy && run.claimedBy !== _windowId && claimAge <= CLAIM_TTL_MS) {
      _providerEventBuffers.delete(run.runId);
      if (_ownedClaims.has(run.runId)) loseClaim(run.runId, run.provider);
      return;
    }
    if (_attached.has(run.runId)) {
      deliverProviderEvent(message);
      return;
    }
    const buffered = _providerEventBuffers.get(run.runId) || [];
    buffered.push(message);
    if (buffered.length > 500) buffered.shift();
    _providerEventBuffers.set(run.runId, buffered);
    if (!_routeQueues.has(run.runId)) routeNativeLoopRun(run, { focus: false }).catch(() => {});
  });
  on('sync:schedule:completed', (message) => {
    if (message?.surface === 'sidepanel') route(message.run || message);
  });
  window.addEventListener('pagehide', () => {
    _suspended = true;
    _claimEpoch++;
    _suspendedClaims = new Map(_ownedClaims);
    if (_claimHeartbeat) clearInterval(_claimHeartbeat);
    _claimHeartbeat = null;
    fetch('/api/sidepanel-runs/release-window', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId: _windowId, claimToken: _claimToken }),
      keepalive: true,
    }).catch(() => {});
    _ownedClaims.clear();
    _attached.clear();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted && !_suspended) return;
    _suspended = false;
    _claimToken = crypto.randomUUID();
    startClaimHeartbeat();
    const previouslyOwned = new Map(_suspendedClaims);
    _suspendedClaims.clear();
    scheduleReconcile().then(async () => {
      for (const [runId, owned] of previouslyOwned) {
        if (!_ownedClaims.has(runId)) await detachProviderRun(runId, owned.provider);
      }
    }).catch(() => {});
  });
  window.addEventListener('native-loop:dismissed', (event) => {
    const runId = event?.detail?.runId;
    if (!runId) return;
    _dismissed.add(runId);
    _attached.delete(runId);
    _latestRuns.delete(runId);
    _providerEventBuffers.delete(runId);
    persistDismissed();
    release(runId);
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== DISMISSED_KEY) return;
    for (const runId of mergeDismissed(event.newValue)) {
      const provider = _ownedClaims.get(runId)?.provider || _attached.get(runId)?.provider;
      detachProviderRun(runId, provider);
      release(runId);
    }
  });
  startClaimHeartbeat();
  scheduleReconcile();
}

function startClaimHeartbeat() {
  if (_claimHeartbeat) return;
  _claimHeartbeat = setInterval(() => {
    if (_suspended) return;
    for (const [runId, owned] of _ownedClaims) {
      fetch(`/api/sidepanel-runs/${encodeURIComponent(runId)}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId: _windowId, claimToken: _claimToken }),
      }).then((response) => {
        if (!response.ok) {
          loseClaim(runId, owned.provider);
        }
      }).catch(() => {});
    }
    scheduleReconcile();
  }, 30_000);
}
