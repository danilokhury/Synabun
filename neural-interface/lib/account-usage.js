// Subscription quota only. Credentials stay inside the reader; public values are
// constructed from numeric windows, never spread from a provider response.
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const percent = n => typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
const date = value => {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
};
const unknown = (source = 'unknown', at = Date.now()) => ({ windows: [], remainingPercent: null, limited: null, resetsAt: null, source, fetchedAt: new Date(at).toISOString() });

export function normalizeAccountUsage(provider, raw, at = Date.now()) {
  let windows = [], rejected = false;
  if (provider === 'claude-code') {
    windows = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].map(kind => ({ kind, usedPercent: percent(raw?.[kind]?.utilization), resetsAt: date(raw?.[kind]?.resets_at) }));
  } else {
    const snapshot = raw?.rateLimits || raw;
    // rateLimitsByLimitId can contain model-specific quotas; the account-wide
    // rateLimits snapshot is the quota shared by the subscription.
    windows = ['primary', 'secondary'].map(kind => ({ kind, usedPercent: percent(snapshot?.[kind]?.usedPercent), resetsAt: date(snapshot?.[kind]?.resetsAt) }));
    rejected = !!snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true || raw?.ordinaryUsageAllowed === false;
  }
  return summarize(windows, provider === 'codex' ? 'codex-app-server' : 'claude-oauth', at, rejected);
}

function summarize(input, source, at, rejected = false) {
  // Once a window resets its old percentage is unknown, not an invented 0%.
  const windows = input.filter(w => (w.usedPercent !== null || w.rejected) && (!w.resetsAt || Date.parse(w.resetsAt) > at));
  if (!windows.length && !rejected) return unknown(source, at);
  const values = windows.map(w => w.usedPercent).filter(n => n !== null);
  const limited = rejected || windows.some(w => w.usedPercent >= 100 || w.rejected);
  const binding = limited ? windows.filter(w => w.usedPercent >= 100 || w.rejected) : windows.filter(w => w.usedPercent === Math.max(...values));
  const resets = binding.map(w => w.resetsAt).filter(Boolean).sort();
  return { windows: windows.map(({ kind, usedPercent, resetsAt }) => ({ kind, usedPercent, resetsAt })), remainingPercent: limited ? 0 : values.length ? 100 - Math.max(...values) : null, limited, resetsAt: limited && binding.some(w => !w.resetsAt) ? null : resets.at(-1) || null, source, fetchedAt: new Date(at).toISOString() };
}

// Matches Claude Code's directory-scoped macOS keychain service (verified in
// installed CLI 2.1.302, D1). Never refresh or write OAuth credentials here.
export async function readClaudeUsageToken(row, { env = process.env, platform = process.platform, signal, now = Date.now, read = readFile, keychain = execFile } = {}) {
  const config = row.id !== 'default' || !!env.CLAUDE_CONFIG_DIR;
  const scope = row.id === 'default' && env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined ? env.CLAUDE_SECURESTORAGE_CONFIG_DIR : config ? row.home : '';
  let credentials;
  if (platform === 'darwin') {
    const suffix = scope ? `-${createHash('sha256').update(scope.normalize('NFC')).digest('hex').slice(0, 8)}` : '';
    const user = /^[a-zA-Z0-9._-]+$/.test(env.USER || '') ? env.USER : 'claude-code-user';
    try {
      const value = await new Promise((resolve, reject) => keychain('/usr/bin/security', ['find-generic-password', '-a', user, '-w', '-s', `Claude Code-credentials${suffix}`], { timeout: 1500, maxBuffer: 1024 * 1024, signal }, (error, stdout) => error ? reject(new Error('credential unavailable')) : resolve(stdout)));
      credentials = JSON.parse(value);
    } catch { /* Linux/file fallback is also used by some macOS installs. */ }
  }
  if (!credentials) {
    try { credentials = JSON.parse(await read(join(scope || row.home, '.credentials.json'), { encoding: 'utf8', signal })); } catch { return null; }
  }
  const oauth = credentials?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken || (oauth.expiresAt != null && Number(oauth.expiresAt) <= now())) return null;
  return oauth.accessToken;
}

export function createAccountUsage({ accounts = {}, readCodex = null, fetchImpl = fetch, tokenReader = readClaudeUsageToken, now = Date.now, ttlMs = 90_000, timeoutMs = 3500 } = {}) {
  const cache = new Map(), inflight = new Map(), overlays = new Map(), generations = new Map();
  const keyOf = (p, id) => `${p}:${id}`;
  const rowOf = (p, id) => accounts[p]?.describe(id);
  const signature = row => JSON.stringify([row?.mode, row?.signedIn, row?.identity, row?.home]);
  function note(provider, id, raw) {
    const row = rowOf(provider, id);
    if (row?.mode !== 'subscription' || row.signedIn !== true) return;
    const at = now(), key = keyOf(provider, id);
    if (provider === 'claude-code') {
      const info = raw?.rate_limit_info || raw;
      const kind = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'overage'].includes(info?.rateLimitType) ? info.rateLimitType : 'subscription';
      const previous = overlays.get(key);
      const windows = previous?.signature === signature(row) ? previous.windows.filter(w => w.kind !== kind) : [];
      windows.push({ kind, usedPercent: percent(typeof info?.utilization === 'number' ? info.utilization * 100 : null), resetsAt: date(info?.resetsAt), rejected: info?.status === 'rejected', at });
      overlays.set(key, { signature: signature(row), windows, at });
    } else {
      const value = normalizeAccountUsage(provider, raw, at);
      cache.set(key, { signature: signature(row), value, at });
    }
  }
  function overlay(provider, id, value) {
    const item = overlays.get(keyOf(provider, id));
    if (!item || item.signature !== signature(rowOf(provider, id))) return value;
    const probeAt = cache.get(keyOf(provider, id))?.probeAt ?? Date.parse(value.fetchedAt);
    const fresh = item.windows.filter(w => now() - w.at < ttlMs && (!value.windows.length || w.at >= probeAt) && (!w.resetsAt || Date.parse(w.resetsAt) > now()));
    if (!fresh.length) return value;
    const combined = summarize([...value.windows.filter(w => !fresh.some(f => f.kind === w.kind)), ...fresh], 'claude-sdk', now());
    combined.fetchedAt = new Date(Math.max(...fresh.map(w => w.at), value.windows.length ? Date.parse(value.fetchedAt) : 0)).toISOString();
    return combined;
  }
  // `stale`: a reading older than ttlMs still counts (a display that refreshes in the background); the
  // account's own state must still match it, and a window past its reset is still unknown.
  function peek(provider, id, { stale = false } = {}) {
    const row = rowOf(provider, id);
    if (row?.mode === 'apiKey' || row?.mode === 'api') return unknown('not_applicable', now());
    const item = cache.get(keyOf(provider, id));
    const value = item?.signature === signature(row) && (stale || now() - item.at < ttlMs) ? summarize(item.value.windows, item.value.source, Date.parse(item.value.fetchedAt), item.value.limited && !item.value.windows.some(w => w.usedPercent >= 100)) : unknown('unknown', now());
    // Do not keep a limited window alive after its reset.
    if (value.windows.some(w => w.resetsAt && Date.parse(w.resetsAt) <= now())) return overlay(provider, id, unknown('unknown', now()));
    return overlay(provider, id, value);
  }
  async function read(provider, id, { force = false } = {}) {
    const row = rowOf(provider, id), key = keyOf(provider, id), sig = signature(row);
    const generation = generations.get(key) || 0;
    const flightKey = JSON.stringify([key, sig, generation]);
    if (!row || row.mode !== 'subscription' || row.signedIn !== true) return peek(provider, id);
    const existing = cache.get(key);
    if (!force && existing?.signature === sig && now() - existing.at < ttlMs && !existing.value.windows.some(w => w.resetsAt && Date.parse(w.resetsAt) <= now())) return peek(provider, id);
    if (inflight.has(flightKey)) return inflight.get(flightKey);
    const startedAt = now();
    const job = (async () => {
      const controller = new AbortController(); let timer;
      try {
        const raw = await Promise.race([
          (async () => {
            if (provider === 'codex') return readCodex?.(id, { signal: controller.signal, timeoutMs });
            const token = await tokenReader(row, { signal: controller.signal, now });
            if (!token || controller.signal.aborted) return null;
            const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: controller.signal, redirect: 'error' });
            return response.ok ? response.json() : null;
          })(),
          new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); }),
        ]);
        const at = now();
        // A passive notification received during the probe is newer.
        if ((generations.get(key) || 0) === generation && signature(rowOf(provider, id)) === sig && (!cache.has(key) || cache.get(key) === existing)) cache.set(key, { signature: sig, value: normalizeAccountUsage(provider, raw, at), at, probeAt: startedAt });
      } catch {
        if ((generations.get(key) || 0) === generation && signature(rowOf(provider, id)) === sig && (!cache.has(key) || cache.get(key) === existing)) cache.set(key, { signature: sig, value: unknown('unknown', now()), at: now(), probeAt: startedAt });
      } finally { clearTimeout(timer); controller.abort(); inflight.delete(flightKey); }
      return peek(provider, id);
    })();
    inflight.set(flightKey, job);
    return job;
  }
  async function refresh(provider = null) {
    await Promise.all(Object.entries(accounts).filter(([p]) => !provider || p === provider).flatMap(([p, service]) => service.list().map(row => read(p, row.id))));
    return list();
  }
  function list({ stale = false } = {}) { return Object.fromEntries(Object.entries(accounts).map(([p, service]) => [p, service.listForClient().map(row => ({ ...row, usage: peek(p, row.id, { stale }) }))])); }
  function invalidate(p, id) { const key = keyOf(p, id); generations.set(key, (generations.get(key) || 0) + 1); cache.delete(key); overlays.delete(key); }
  return { read, peek, note, refresh, list, invalidate };
}

/** Resolve once at route time. Concrete selections stay binding at dispatch. */
export function chooseUsageAccount(rows, choice, defaultId = 'default') {
  const pinned = rows.find(row => row.id === choice);
  const candidates = rows.filter(row => row.mode === 'subscription' && row.signedIn === true);
  if (choice !== 'auto' && (!pinned || pinned.signedIn === false || pinned.mode !== 'subscription' || !pinned.usage?.limited)) return { row: pinned, reason: null };
  const available = candidates.filter(row => !row.usage?.limited);
  const known = available.filter(row => typeof row.usage?.remainingPercent === 'number');
  const highest = Math.max(...known.map(row => row.usage.remainingPercent));
  const best = known.filter(row => row.usage.remainingPercent === highest);
  let row = (best.length > 1 ? available.find(row => row.id === defaultId) : null) || best.find(row => row.id === defaultId) || best[0];
  if (!row) row = available.find(row => row.id === defaultId) || available[0];
  let reason = choice === 'auto' ? 'account_auto' : 'account_limited';
  if (!available.length && candidates.length) {
    row = [...candidates].sort((a, b) => (Date.parse(a.usage?.resetsAt) || Infinity) - (Date.parse(b.usage?.resetsAt) || Infinity) || Number(b.id === defaultId) - Number(a.id === defaultId))[0];
    reason = 'accounts_all_limited';
  }
  // With no eligible subscription, retain the existing default behavior.
  return { row: row || (choice === 'auto' ? null : pinned), reason };
}
