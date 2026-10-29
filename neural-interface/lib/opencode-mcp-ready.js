// OpenCode connects MCP in the background, then debounces tool registration by 100 ms.
// A connected status alone is too early for either direct tools or the Code Mode catalog.
import { resolve } from 'node:path';
import { mcpServersOf, opencodeConfigFilePath, readOpencodeConfigDocument } from './opencode-config.js';
import { mcpStatusRouteAvailability } from './assistant-route-gate.js';

export const OPENCODE_MCP_READY_TIMEOUT_MS = 35_000;
export const OPENCODE_MCP_SETTLE_MS = 750;
export const OPENCODE_MCP_LIST_GRACE_MS = 3_000;
const states = new WeakMap();
const knob = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;

export function synabunMcpState(servers) {
  const verdict = mcpStatusRouteAvailability(servers);
  if (verdict?.available) return 'connected';
  if (verdict) return 'down';
  const names = Array.isArray(servers) ? servers.map((server) => server?.name) : Object.keys(servers || {});
  return names.some((name) => String(name || '').toLowerCase() === 'synabun') ? 'starting' : 'missing';
}

export function synabunConfigured(xdgRoot) {
  try {
    const doc = readOpencodeConfigDocument(opencodeConfigFilePath(resolve(xdgRoot, 'opencode')));
    if (!doc.exists || doc.error) return false;
    const entry = Object.entries(mcpServersOf(doc.config)).find(([name]) => name.toLowerCase() === 'synabun')?.[1];
    return !!entry && entry.disabled !== true;
  } catch { return false; }
}

function stateFor(client, directory) {
  let directories = states.get(client);
  if (!directories) { directories = new Map(); states.set(client, directories); }
  const key = directory || '';
  if (!directories.has(key)) directories.set(key, { readyAt: Date.now(), seenAt: null, gaveUp: false });
  return directories.get(key);
}

/** Reconnects invalidate only this client's directory; the reconnect and next prompt share the same settle. */
export function invalidateSynabunTools(client, directory) {
  Object.assign(stateFor(client, directory), { readyAt: Date.now(), seenAt: null, gaveUp: false });
}

// Bound even a hung status request; an AbortSignal wakes both a request and a settle immediately.
async function interruptible(promise, ms, signal) {
  let timer, abort;
  try {
    return await Promise.race([
      Promise.resolve(promise).then((value) => ({ value }), () => ({ failed: true })),
      new Promise((done) => {
        timer = setTimeout(() => done({ timedOut: true }), Math.max(0, ms));
        abort = () => done({ aborted: true });
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** false means Stop/dispose: the caller must send no prompt. Cached per serve client + directory. */
export async function waitForSynabunTools(client, {
  directory, expected = true, signal, stopped = () => false, onStatus = null, onTimeout = () => {},
  readyTimeoutMs, settleMs, listGraceMs, pollMs,
} = {}) {
  const cancelled = () => signal?.aborted || stopped();
  if (cancelled()) return false;
  if (!expected && !onStatus) return !cancelled();
  if (typeof client?.mcp?.status !== 'function') return !cancelled();
  const state = stateFor(client, directory);
  const cap = knob(readyTimeoutMs, OPENCODE_MCP_READY_TIMEOUT_MS);
  const settle = knob(settleMs, OPENCODE_MCP_SETTLE_MS);
  const grace = knob(listGraceMs, OPENCODE_MCP_LIST_GRACE_MS);
  const poll = Math.max(1, knob(pollMs, 100));
  const deadline = Date.now() + cap;
  const expired = () => {
    if (!state.gaveUp) { state.gaveUp = true; onTimeout(cap); }
    return !cancelled();
  };
  for (;;) {
    const statusBudget = state.gaveUp || !expected ? poll : Math.max(1, deadline - Date.now());
    const response = await interruptible(Promise.resolve().then(() => client.mcp.status({ directory })), statusBudget, signal);
    if (cancelled() || response.aborted) return false;
    if (response.timedOut) return expected ? expired() : true;
    if (response.failed || response.value?.error || Number(response.value?.status) >= 400) return true;
    const servers = response.value?.data || response.value || [];
    if (!expected) { onStatus?.(servers); return !cancelled(); }
    const status = synabunMcpState(servers);
    const now = Date.now();
    let pause = poll;
    if (status === 'connected') {
      state.seenAt ??= now;
      const left = state.seenAt + settle - now;
      if (left <= 0) { state.gaveUp = false; onStatus?.(servers); return !cancelled(); }
      // Recovering after a previous cap still settles once; it never repeats the startup bound.
      pause = Math.min(poll, left);
    } else {
      state.seenAt = null;
      if (status === 'down' || (status === 'missing' && now - state.readyAt >= grace)) { onStatus?.(servers); return !cancelled(); }
      if (state.gaveUp) { onStatus?.(servers); return true; }
    }
    if (now >= deadline) { onStatus?.(servers); return expired(); }
    await interruptible(new Promise(() => {}), Math.min(pause, deadline - now), signal);
    if (cancelled()) return false;
  }
}

export function synabunToolsTimeoutText(ms, surface = 'session') {
  return `SynaBun's tools are not ready in this OpenCode ${surface}: its SynaBun MCP server has not connected after ${Math.round(ms / 1000)} s, so this turn goes out without them${surface === 'brain' ? ' (no routing or memory)' : ''}. Check Settings → OpenCode or recreate this ${surface}.`;
}
