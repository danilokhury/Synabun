// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — one read of the provider list for every module
// The model picker, the variant picker, the context gauge and the composer
// each need the provider list. They ask through here, so opening the panel
// reads it once: the compact view of GET /api/opencode/providers/full (the
// connected providers, opencode-providers.js), kept in the page's data cache
// and given at once on every later open. A change (`ocp-providers-changed`)
// drops the copy and reads it again.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchOpencodeProviders, opencodeProviders } from '../opencode-providers.js';

// Long enough to cover the burst of readers at mount and at a refresh, short
// enough that a later, deliberate refresh reads the server again.
export const PROVIDERS_SHARE_MS = 3000;

/** A cache around `fetchJson()`: concurrent and near-simultaneous callers share one read. */
export function createSharedFetch(fetchJson, { shareMs = PROVIDERS_SHARE_MS, now = () => Date.now() } = {}) {
  let promise = null;
  let startedAt = 0;
  const read = () => {
    if (promise && now() - startedAt < shareMs) return promise;
    startedAt = now();
    const current = Promise.resolve().then(fetchJson);
    promise = current;
    // A failed read is not kept: the next caller tries again.
    current.catch(() => { if (promise === current) promise = null; });
    return current;
  };
  read.invalidate = () => { promise = null; };
  return read;
}

/** The parsed body of the provider list: `{ ok, data: { all, default, connected } }` (connected providers). */
export const fetchProvidersFull = Object.assign(() => fetchOpencodeProviders(), {
  invalidate: () => opencodeProviders.invalidate(''),
});
