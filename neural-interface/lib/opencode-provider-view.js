// ═══════════════════════════════════════════
// SynaBun Neural Interface — OpenCode provider views
// ═══════════════════════════════════════════
// GET /api/opencode/providers/full answers with OpenCode's provider list,
// `{ all, default, connected }`. `all` is the whole models.dev catalog (on a
// typical install 231 providers and 9,069 models, about 7 MB of JSON) while a
// model picker only ever lists the providers that are connected (two or three).
// The compact view keeps those, with every field of their models a picker,
// the context gauge, the composer or the Assistant's catalog reads, and leaves
// out what none of them reads (credentials and request options included).
// Pure: no I/O, so the route, the catalog's in-process read and the tests share it.

const PROVIDER_FIELDS_LEFT_OUT = new Set(['env', 'options', 'key', 'npm', 'api']);
const MODEL_FIELDS_LEFT_OUT = new Set(['options', 'headers', 'provider']);

/** An answer of OpenCode's /provider: `{ all: [...] }` (an object; a web page or an error body is not one). */
export function isProviderCatalog(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return Array.isArray(data.all) || (!!data.all && typeof data.all === 'object');
}

function providersOf(data) {
  if (Array.isArray(data?.all)) return data.all;
  return data?.all && typeof data.all === 'object' ? Object.values(data.all) : [];
}

function slimModel(model) {
  if (!model || typeof model !== 'object') return model;
  const out = {};
  for (const [key, value] of Object.entries(model)) if (!MODEL_FIELDS_LEFT_OUT.has(key)) out[key] = value;
  return out;
}

function slimProvider(provider) {
  const out = {};
  for (const [key, value] of Object.entries(provider || {})) {
    if (PROVIDER_FIELDS_LEFT_OUT.has(key)) continue;
    if (key === 'models') {
      if (Array.isArray(value)) out.models = value.map(slimModel);
      else if (value && typeof value === 'object') out.models = Object.fromEntries(Object.entries(value).map(([id, model]) => [id, slimModel(model)]));
      else out.models = value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * The providers a picker lists: the connected ones (every provider when the
 * answer names none), in OpenCode's order, `default` and `connected` as given.
 */
export function compactProviderCatalog(data) {
  if (!isProviderCatalog(data)) return null;
  const connected = Array.isArray(data.connected) ? data.connected.map((entry) => String(entry && typeof entry === 'object' ? (entry.id || entry.name || '') : entry || '')).filter(Boolean) : null;
  const wanted = connected ? new Set(connected) : null;
  const all = providersOf(data).filter((provider) => provider?.id && (!wanted || wanted.has(String(provider.id)))).map(slimProvider);
  return {
    all,
    default: data.default && typeof data.default === 'object' ? { ...data.default } : {},
    ...(Array.isArray(data.connected) ? { connected: [...data.connected] } : {}),
    // How many providers the whole catalog has (Settings → OpenCode says how many it hides).
    total: providersOf(data).length,
  };
}

/** What makes two answers the same list for a picker: connected providers, their model ids, the defaults, the catalog's size. */
export function providerCatalogSignature(data) {
  if (!isProviderCatalog(data)) return '';
  const providers = providersOf(data);
  const connected = Array.isArray(data.connected) ? data.connected.map(String) : null;
  const listed = providers
    .filter((provider) => provider?.id && (!connected || connected.includes(String(provider.id))))
    .map((provider) => {
      const models = Array.isArray(provider.models) ? provider.models.map((m) => m?.id || '') : Object.keys(provider.models || {});
      return `${provider.id}:${models.join(',')}`;
    });
  let modelCount = 0;
  for (const provider of providers) modelCount += Array.isArray(provider?.models) ? provider.models.length : Object.keys(provider?.models || {}).length;
  return JSON.stringify([connected, listed, data.default || {}, providers.length, modelCount]);
}
