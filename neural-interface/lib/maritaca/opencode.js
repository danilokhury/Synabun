// ═══════════════════════════════════════════
// SynaBun — Maritaca AI as an OpenCode provider (Settings → OpenCode → Providers)
// ═══════════════════════════════════════════
//
// Maritaca's API is OpenAI-compatible, so OpenCode's own `@opencode/ai/providers/openai-compatible` package drives
// it (the same package the Ollama card writes: nothing is installed). Its base URL is SynaBun's own route
// (lib/maritaca/opencode-proxy.js, http://127.0.0.1:<port>/api/maritaca/opencode/v1), not Maritaca's API: OpenCode 2
// refuses Maritaca's stream on the first tool call ("received content after the finish reason"), and the route puts
// the stream in the order OpenCode reads. A block written before that (Maritaca's address) reads as out of sync, so
// the Settings card offers Re-sync. The provider block goes into the user's global
// opencode.json under `providers.maritaca` with every Sabiá model of models.js, and the API key as a reference OpenCode
// resolves when it reads its configuration (`{file:<the key file>}` for a saved key, `{env:MARITACA_API_KEY}` for an
// environment key): the key itself is never written into opencode.json and never logged. OpenCode reads the change at
// once (reloadSharedOpencodeConfig in server.js, as the Ollama path does): no restart. The Maritaca panel's own chat
// (lib/maritaca/client.js) does not go through OpenCode; this is for OpenCode workers and the Assistant's catalog,
// which lists OpenCode's connected providers as `opencode` models (`maritaca/<model-id>`).
//
// The pure part (the entry, the key reference, the state of a document) is unit-tested; the factory takes what
// server.js has (the config document reader and writer, OpenCode's own conversion of an OpenCode 1 provider section,
// the reload, the broadcast) so nothing here opens a file by itself.

import { join } from 'node:path';
import { MARITACA_MODELS } from './models.js';
import { MARITACA_BASE_URL } from './client.js';
import { MARITACA_ENV_KEY, MARITACA_KEY_FILE } from './key-store.js';
import { MARITACA_OPENCODE_PROXY_URL_RE } from './opencode-proxy.js';
import { hasOpencode1Providers, providerOf, removeProvider, setProvider } from '../opencode-config.js';

export const MARITACA_OPENCODE_PROVIDER_ID = 'maritaca';
export const MARITACA_OPENCODE_PROVIDER_NAME = 'Maritaca AI';
export const MARITACA_OPENCODE_PACKAGE = '@opencode/ai/providers/openai-compatible';

/** How OpenCode is told the key: a reference it resolves itself, never the key. null without a key. */
export function maritacaApiKeyReference({ source, keyPath } = {}) {
  if (source === 'file' && keyPath) return `{file:${keyPath}}`;
  if (source === 'env') return `{env:${MARITACA_ENV_KEY}}`;
  return null;
}

/**
 * OpenCode's `models` map of the table: name, limits and whether the model takes tools (prices are in BRL and would be
 * read as USD). OpenCode 2's Config.Model says tools under `capabilities.tools` (default true when absent), so a row
 * with `toolcall: false` (S5-free) is written `capabilities: { tools: false }` and OpenCode never sends it tools.
 */
export function maritacaOpencodeModels(models = MARITACA_MODELS) {
  const out = {};
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m.id !== 'string' || !m.id.trim()) continue;
    const entry = { name: String(m.label || m.id) };
    const context = Number(m.contextWindow); const output = Number(m.maxOutput);
    if (context > 0 || output > 0) entry.limit = { ...(context > 0 ? { context } : {}), ...(output > 0 ? { output } : {}) };
    if (typeof m.toolcall === 'boolean') entry.capabilities = { tools: m.toolcall };
    out[m.id] = entry;
  }
  return out;
}

/** Each model's tools flag as a block says it: `{ id: true | false | null }` (null: the block does not say). */
function toolFlags(models) {
  const out = {};
  for (const [id, m] of Object.entries(models && typeof models === 'object' ? models : {})) {
    const tools = m?.capabilities?.tools;
    out[id] = typeof tools === 'boolean' ? tools : null;
  }
  return out;
}

/** The `providers.maritaca` block of opencode.json. `apiKey` is a reference from maritacaApiKeyReference, required. */
export function maritacaOpencodeProviderEntry({ apiKey, models = MARITACA_MODELS, baseUrl = MARITACA_BASE_URL } = {}) {
  if (typeof apiKey !== 'string' || !/^\{(file|env):[^{}]+\}$/.test(apiKey)) throw Object.assign(new Error('The API key must be an OpenCode reference ({file:…} or {env:…}).'), { code: 'KEY_REFERENCE' });
  return {
    name: MARITACA_OPENCODE_PROVIDER_NAME,
    package: MARITACA_OPENCODE_PACKAGE,
    settings: { baseURL: String(baseUrl).replace(/\/+$/, ''), apiKey },
    models: maritacaOpencodeModels(models),
  };
}

const trimUrl = (url) => String(url ?? '').trim().replace(/\/+$/, '');

/**
 * Where a block's base URL sends OpenCode: 'synabun' (a SynaBun server's route, lib/maritaca/opencode-proxy.js),
 * 'maritaca' (Maritaca's API itself: a block written before the route, whose tool calls OpenCode refuses), 'other'
 * (anything else, a hand edit), or null (no base URL).
 */
export function maritacaOpencodeRoute(baseUrl) {
  const url = trimUrl(baseUrl);
  if (!url) return null;
  if (MARITACA_OPENCODE_PROXY_URL_RE.test(url)) return 'synabun';
  if (url === trimUrl(MARITACA_BASE_URL)) return 'maritaca';
  return 'other';
}

/**
 * What a document and the key store say together: whether the provider is registered, how many models it lists,
 * whether the block matches what SynaBun would write now (`inSync`: the key reference, the model ids and the base URL
 * `baseUrl`, this server's route), and where the block sends OpenCode (`route`). Never the key.
 */
export function maritacaOpencodeState({ config, keyStatus, keyPath, models = MARITACA_MODELS, baseUrl = MARITACA_BASE_URL } = {}) {
  const entry = providerOf(config, MARITACA_OPENCODE_PROVIDER_ID);
  const source = keyStatus?.configured ? keyStatus.source || null : null;
  const expectedKey = maritacaApiKeyReference({ source, keyPath });
  const currentKey = typeof entry?.settings?.apiKey === 'string' ? entry.settings.apiKey : null;
  const currentIds = Object.keys(entry?.models && typeof entry.models === 'object' ? entry.models : {}).sort();
  const expectedModels = maritacaOpencodeModels(models);
  const expectedIds = Object.keys(expectedModels).sort();
  // A block written before the tools flag (or edited by hand) is out of sync: OpenCode would send S5-free tools.
  const currentTools = toolFlags(entry?.models);
  const expectedTools = toolFlags(expectedModels);
  const toolsInSync = expectedIds.every((id) => currentTools[id] === expectedTools[id]);
  const currentUrl = typeof entry?.settings?.baseURL === 'string' ? trimUrl(entry.settings.baseURL) : '';
  const registered = !!entry;
  const inSync = registered && !!expectedKey && currentKey === expectedKey && JSON.stringify(currentIds) === JSON.stringify(expectedIds)
    && currentUrl === trimUrl(baseUrl) && toolsInSync;
  return {
    registered, modelCount: currentIds.length, inSync,
    // The block's models for the card's per-model visibility list (OpenCode lists them as `maritaca/<id>`).
    models: currentIds.map((id) => ({ id, name: typeof entry.models[id]?.name === 'string' ? entry.models[id].name : id, tools: currentTools[id] })), route: registered ? maritacaOpencodeRoute(currentUrl) : null, keyConfigured: !!expectedKey, keySource: source,
    // A reference is said by its kind only; a literal key typed by hand into opencode.json is never echoed.
    keyReference: currentKey ? (/^\{(file|env):.*\}$/.test(currentKey) ? currentKey.replace(/^\{(file|env):.*\}$/, '{$1:…}') : 'literal (hidden)') : null,
    opencode1: hasOpencode1Providers(config, MARITACA_OPENCODE_PROVIDER_ID),
  };
}

export function maritacaOpencodeError(code, message, status = 500) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * The sync: status / configure / remove, and what a key change does. Dependencies are server.js's:
 *   keyStore          lib/maritaca/key-store.js (status(), dir)
 *   readConfig()      the global opencode.json as an object (readOpencodeConfigDocument(path).config)
 *   updateConfig(fn)  updateOpencodeConfigFile(dir, fn) → the path written
 *   configPath()      the path of that file (for messages)
 *   convertProviders()  opencodeConvertedProviders(path): the `providers` OpenCode converted from an OpenCode 1
 *                     section (object), or undefined when OpenCode cannot say now
 *   reload()          reloadSharedOpencodeConfig(); broadcast() tells the panels `providers:changed`
 *   catalogChanged()  refreshOpencodeProviderConsumers(): OpenCode's kept provider list read again and the Assistant's
 *                     catalog rebuilt, so agent_catalog and the Routes editor list maritaca/<id> at once (the catalog
 *                     keeps a build for 30 s and nothing else tells it about a file SynaBun wrote). Not awaited.
 *   baseUrl           the base URL the block gives OpenCode: a string, or a function read at each call. server.js hands
 *                     this server's route (maritacaOpencodeProxyBaseUrl(PORT)); Maritaca's own API is only the default
 *                     of a sync built without a server (tests), whose blocks OpenCode cannot use for tool calls.
 */
export function createMaritacaOpencodeSync({
  keyStore, readConfig, updateConfig, configPath = () => 'opencode.json', convertProviders = async () => undefined,
  reload = async () => false, broadcast = () => {}, catalogChanged = () => {}, log = () => {}, models = MARITACA_MODELS, baseUrl = MARITACA_BASE_URL,
} = {}) {
  if (!keyStore || typeof readConfig !== 'function' || typeof updateConfig !== 'function') throw new Error('createMaritacaOpencodeSync needs keyStore, readConfig and updateConfig');
  const keyPath = () => join(keyStore.dir, MARITACA_KEY_FILE);
  const currentBaseUrl = () => trimUrl(typeof baseUrl === 'function' ? baseUrl() : baseUrl);

  function status() {
    const keyStatus = keyStore.status();
    const state = maritacaOpencodeState({ config: readConfig(), keyStatus, keyPath: keyPath(), models, baseUrl: currentBaseUrl() });
    return { ...state, configPath: configPath() };
  }

  async function announce() {
    try { await reload(); } catch { /* the serve is not running: it reads the file when it starts */ }
    try { broadcast(); } catch { /* no panel */ }
    // After the reload: the serve already reads the new file when the list is asked again. The answer to Configure
    // does not wait for a catalog build.
    try { const pending = catalogChanged(); pending?.catch?.(() => {}); } catch { /* no Assistant */ }
  }

  /** Writes the block. Throws NO_KEY (412) without a key, OPENCODE1_PROVIDERS (409) when the file cannot take a `providers` section now. */
  async function configure() {
    const keyStatus = keyStore.status();
    const apiKey = maritacaApiKeyReference({ source: keyStatus.configured ? keyStatus.source : null, keyPath: keyPath() });
    if (!apiKey) throw maritacaOpencodeError('NO_KEY', 'Save a Maritaca API key first (the Maritaca panel, the cog).', 412);
    const target = currentBaseUrl();
    const entry = maritacaOpencodeProviderEntry({ apiKey, models, baseUrl: target });
    const converted = hasOpencode1Providers(readConfig(), MARITACA_OPENCODE_PROVIDER_ID) ? await convertProviders() : null;
    if (converted === undefined) {
      throw maritacaOpencodeError('OPENCODE1_PROVIDERS', `${configPath()} keeps its providers in OpenCode 1's "provider" section. Start OpenCode so SynaBun can move them to "providers" first, or move them yourself.`, 409);
    }
    const written = updateConfig((cfg) => {
      if (converted) { delete cfg.provider; cfg.providers = { ...converted, ...(cfg.providers && typeof cfg.providers === 'object' ? cfg.providers : {}) }; }
      return setProvider(cfg, MARITACA_OPENCODE_PROVIDER_ID, entry);
    });
    const modelsConfigured = Object.keys(entry.models).length;
    const via = maritacaOpencodeRoute(target) === 'synabun' ? `through SynaBun at ${target}` : `straight to ${target}`;
    log(`[maritaca] Registered ${modelsConfigured} model(s) as OpenCode provider "${MARITACA_OPENCODE_PROVIDER_ID}" in ${written} (key by ${keyStatus.source === 'env' ? 'environment' : 'file'} reference, ${via})`);
    await announce();
    return { modelsConfigured, keySource: keyStatus.source, configPath: written };
  }

  /** Takes the block out (either shape). Returns whether there was one. */
  async function remove() {
    const had = !!providerOf(readConfig(), MARITACA_OPENCODE_PROVIDER_ID);
    if (had) {
      updateConfig((cfg) => removeProvider(cfg, MARITACA_OPENCODE_PROVIDER_ID));
      log('[maritaca] Removed the OpenCode provider block');
      await announce();
    }
    return { removed: had };
  }

  /**
   * After the key store changed (a key saved or forgotten): a registered block is written again (the reference may
   * move between file and environment), and one left without any key is removed, because a dangling `{file:…}`
   * would make OpenCode's configuration unreadable. Never throws: the key save must not fail for this.
   */
  async function onKeyChanged() {
    try {
      if (!providerOf(readConfig(), MARITACA_OPENCODE_PROVIDER_ID)) return { action: 'none' };
      if (!keyStore.status().configured) { await remove(); return { action: 'removed' }; }
      await configure();
      return { action: 'resynced' };
    } catch (error) {
      log(`[maritaca] OpenCode provider re-sync skipped: ${error?.code || 'ERROR'}`);
      return { action: 'failed', code: error?.code || 'ERROR' };
    }
  }

  return { status, configure, remove, onKeyChanged };
}
