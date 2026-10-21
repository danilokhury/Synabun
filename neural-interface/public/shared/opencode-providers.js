// ═══════════════════════════════════════════
// SynaBun Neural Interface — OpenCode's providers, as the pickers read them
// ═══════════════════════════════════════════
// GET /api/opencode/providers/full?view=compact: the connected providers only,
// with every field their models carry (the whole models.dev catalog is
// megabytes, and only Settings → OpenCode lists it). One copy in the data
// cache (data-cache.js) for every module that reads it: the OpenCode panel's
// model and variant pickers, its context gauge and composer, the Assistant's
// and the Studios' model lists. A provider change (`ocp-providers-changed`,
// which reaches every window: the OpenCode socket where a panel is open, the
// sync socket everywhere) drops it and asks for it again at once.

import { createDataCache } from './data-cache.js';
import { registerLaunchPrefetch } from './launch-prefetch.js';

export const OPENCODE_PROVIDERS_URL = '/api/opencode/providers/full?view=compact';

export const opencodeProviders = createDataCache('opencode-providers', {
  ttlMs: 5 * 60_000,
  persist: true,
  load: async (_key, { force }) => {
    const resp = await fetch(force ? `${OPENCODE_PROVIDERS_URL}&refresh=1` : OPENCODE_PROVIDERS_URL);
    // A body that is not JSON (a web page) throws: nothing is kept.
    return resp.json();
  },
  // Only a provider list is kept: `{ ok: false }` (the serve is not running, an error) never is.
  accept: (body) => !!body && body.ok !== false && !!body.data && typeof body.data === 'object' && !Array.isArray(body.data),
});

/** The parsed body `{ ok, data: { all, default, connected } }`, connected providers only. */
export function fetchOpencodeProviders({ force = false } = {}) {
  return opencodeProviders.get('', { force });
}

if (typeof document !== 'undefined') {
  document.addEventListener('ocp-providers-changed', () => opencodeProviders.invalidate('', { refetch: true }));
  // Launch: read once the page has painted, so the first OpenCode picker opens from it.
  registerLaunchPrefetch('opencode-providers', () => opencodeProviders.prefetch(''), { order: 8, owner: true });
}
