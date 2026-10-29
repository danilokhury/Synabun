// ═══════════════════════════════════════════
// SynaBun Neural Interface — Settings' reads
// ═══════════════════════════════════════════
// The answers the Settings modal is built from (openSettingsModal in
// ui-settings.js), kept in the page's data cache (data-cache.js): Settings
// opens from them at once and they are read again in the background once they
// are old. Only a first open waits for them; the launch prefetch reads them
// once the page has painted, and closing Settings reads them again, so the next
// open shows what was changed in this one. Each open gets its own copy (the
// panes edit theirs in place). Never kept in sessionStorage: this is
// configuration.
// No DOM: runs under node --test as well.

import { createDataCache } from '../data-cache.js';

const MINUTE = 60_000;

// `ok`: the endpoint says it answered (`{ ok: true, … }`). `raw`: the status and body are kept as they came, for
// a reader that tells the states apart itself (settings-greeting.js, settings-user-context.js).
const okBody = (body) => !!body && typeof body === 'object' && body.ok !== false && !body.error;
export const SETTINGS_READS = Object.freeze({
  settings: { url: '/api/settings', accept: okBody },
  connections: { url: '/api/connections', accept: (body) => Array.isArray(body?.connections) },
  // Raw: the hooks' row tells a refusal, an old server and an unreadable file apart (settings-claude-hooks.js).
  integrations: { url: '/api/claude-code/integrations', raw: true },
  skills: { url: '/api/claude-code/skills', accept: (body) => body?.ok === true },
  // The tunnel changes by itself (starting, stopping from the Share menu): asked again after a few seconds.
  tunnel: { url: '/api/tunnel/status', accept: (body) => body?.ok === true, ttlMs: 10_000 },
  mcpKey: { url: '/api/mcp-key', accept: (body) => body?.ok === true },
  openclaw: { url: '/api/bridges/openclaw', accept: (body) => body?.ok === true },
  greeting: { url: '/api/greeting', raw: true },
  setup: { url: '/api/setup/status', accept: (body) => body?.ok === true },
  cli: { url: '/api/cli/config', accept: (body) => body?.ok === true },
  toolPermissions: { url: '/api/claude-code/tool-permissions', accept: (body) => body?.ok === true },
  toolCategories: { url: '/api/claude-code/tool-categories', accept: (body) => body?.ok === true, ttlMs: 10 * MINUTE },
  discord: { url: '/api/discord/config', accept: (body) => body?.ok === true },
  skins: { url: '/api/skins', accept: (body) => body?.ok === true },
  icons: { url: '/api/file-icons', accept: (body) => body?.ok === true },
  youtube: { url: '/api/youtube/config', accept: (body) => body?.ok === true },
  typesafe: { url: '/api/typesafe/config', accept: (body) => body?.ok === true },
  userContext: { url: '/api/assistant/user-context', raw: true },
  workerGuard: { url: '/api/assistant/worker-guard', raw: true },
});

const caches = Object.fromEntries(Object.entries(SETTINGS_READS).map(([name, spec]) => [name, createDataCache(`settings:${name}`, {
  ttlMs: spec.ttlMs || MINUTE,
  load: async () => {
    const res = await fetch(spec.url);
    if (spec.raw) return { status: res.status, body: await res.json().catch(() => null) };
    if (!res.ok) throw new Error(`${spec.url}: HTTP ${res.status}`);
    return res.json();
  },
  accept: spec.raw ? (value) => value?.status >= 200 && value.status < 300 && !!value.body : spec.accept,
})]));

function copy(value) {
  try { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); } catch { return value; }
}

/**
 * Every read, as Promise.allSettled gives them: `{ [name]: { status: 'fulfilled', value } | { status: 'rejected',
 * reason } }`. A kept answer is given at once (a copy of it) and read again in the background when it is old;
 * a read never made waits for its request, as the modal always did.
 */
export async function readSettingsData() {
  const names = Object.keys(SETTINGS_READS);
  const settled = await Promise.allSettled(names.map((name) => caches[name].get('')));
  return Object.fromEntries(names.map((name, i) => [name, settled[i].status === 'fulfilled' ? { status: 'fulfilled', value: copy(settled[i].value) } : settled[i]]));
}

/** Read whatever is not fresh now (launch prefetch); resolves when done, never rejects. */
export function prefetchSettingsData() {
  return Promise.allSettled(Object.values(caches).map((cache) => cache.prefetch(''))).then(() => undefined);
}

/**
 * The answers are due (Settings closed: something may have been changed in it; a sync event said so): the next
 * open waits for none of them that are read again in time, and `names` limits it to some.
 */
export function refreshSettingsData(names = null) {
  for (const [name, cache] of Object.entries(caches)) {
    if (names && !names.includes(name)) continue;
    cache.invalidate('', { refetch: true });
  }
}

/** True when every read has an answer kept (Settings can open without waiting). */
export function settingsDataReady() {
  return Object.values(caches).every((cache) => cache.has(''));
}
