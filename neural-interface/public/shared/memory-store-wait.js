// SynaBun — the page while the memory database is being upgraded.
//
// /api/health answers `ok: true` with a `store` block while the store is migrating (or its upgrade failed): the server
// is up, so this is never the offline screen. A page that starts then waits here, says what is happening, and goes on
// with its normal boot when the store is back, instead of reading a 503 as "connection failed".
//
// No imports and no DOM unless `show` touches it: tests/memory-store-wait.test.mjs runs it under node.

/** What a health answer asks the page to show, or null when the store can be read. */
export function memoryStoreHold(health) {
  const state = health?.store?.state;
  if (state === 'migrating') return { state, titleKey: 'loading.memoryStore.migratingTitle', subKey: 'loading.memoryStore.migratingSub' };
  if (state === 'failed') return { state, titleKey: 'loading.memoryStore.failedTitle', detail: String(health.store.note || '') };
  return null;
}

/**
 * Wait until the store can be read. Resolves true when it had to wait (what was fetched meanwhile is stale), false
 * when it did not. A health request that fails is not a verdict: the page's own presence check decides about offline.
 * @param {object} health  the answer the page already has
 * @param {{ fetchHealth: () => Promise<object>, show: (hold: object) => void, sleep?: (ms: number) => Promise<void>, intervalMs?: number }} io
 */
export async function waitForMemoryStore(health, { fetchHealth, show, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), intervalMs = 2000 }) {
  let hold = memoryStoreHold(health);
  if (!hold) return false;
  let shown = '';
  while (hold) {
    const key = `${hold.state}\n${hold.detail || ''}`;
    if (key !== shown) { shown = key; show(hold); }
    await sleep(intervalMs);
    const next = await fetchHealth().catch(() => null);
    // No answer, or an answer without the block from a server that is restarting: keep what is shown and ask again.
    if (next?.ok === true) hold = memoryStoreHold(next);
  }
  return true;
}

/** The page's side: the loading overlay says it, in the page's language. */
export function holdForMemoryStore(health, { fetchHealth, t, showLoadingError, document: doc = globalThis.document }) {
  return waitForMemoryStore(health, {
    fetchHealth,
    show(hold) {
      if (hold.state === 'failed') { showLoadingError(t(hold.titleKey), hold.detail, false); return; }
      const overlay = doc?.getElementById('loading-overlay');
      overlay?.classList.remove('error', 'server-offline');
      const text = doc?.getElementById('loading-text');
      const sub = doc?.getElementById('loading-sub');
      if (text) text.textContent = t(hold.titleKey);
      if (sub) sub.textContent = t(hold.subKey);
    },
  });
}
