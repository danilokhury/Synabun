// ═══════════════════════════════════════════
// SynaBun — Settings → OpenCode → Providers: the Maritaca card (DOM-free)
// ═══════════════════════════════════════════
//
// What the card next to the Ollama card says for an answer of GET /api/maritaca/opencode/status
// (lib/maritaca/opencode.js), and which actions it offers. `ui-settings.js` draws it; this decides.
// States: unavailable (an older server: 503 / no answer), no-key, not-registered, registered (in sync),
// stale (registered, but the key reference or the model list changed), configuring, error.

export const MARITACA_OPENCODE_STATES = Object.freeze(['unavailable', 'no-key', 'not-registered', 'registered', 'stale', 'configuring', 'error']);

/** The dot colours the Ollama card uses (the provider cards' own scale, not a theme token). */
const DOT = Object.freeze({ ok: '#4ade80', wait: '#facc15', off: 'rgba(248,113,113,0.7)' });

/** The i18n key (under settings.redesign.opencode) of every string the card can show. */
export const MARITACA_OPENCODE_KEYS = Object.freeze({
  subname: 'maritacaSubname',
  unavailableStatus: 'maritacaUnavailableStatus', unavailableNote: 'maritacaUnavailableNote',
  noKeyStatus: 'maritacaNoKeyStatus', noKeyNote: 'maritacaNoKeyNote', openPanel: 'maritacaOpenPanel',
  notRegisteredStatus: 'maritacaNotRegisteredStatus', notRegisteredNote: 'maritacaNotRegisteredNote', configure: 'maritacaConfigure',
  registeredStatus: 'maritacaRegisteredStatus', registeredTag: 'maritacaRegisteredTag', keyFile: 'maritacaKeyFile', keyEnv: 'maritacaKeyEnv',
  staleStatus: 'maritacaStaleStatus', staleNote: 'maritacaStaleNote', resync: 'maritacaResync',
  configuringStatus: 'configuring', configuringNote: 'writingProviderConfig',
  errorStatus: 'maritacaErrorStatus', error: 'error2',
  remove: 'remove', removing: 'removing', model: 'model',
  registeredToast: 'maritacaProviderRegistered', removedToast: 'maritacaProviderRemoved',
});

/**
 * The card's state for a status answer. `status` is the JSON of GET /api/maritaca/opencode/status (or null when the
 * request failed), `configuring` while a configure request is in flight, `error` the message of a failed configure.
 */
export function maritacaOpencodeCardState(status, { configuring = false, error = '' } = {}) {
  if (configuring) return 'configuring';
  if (error) return 'error';
  if (!status || status.ok === false || typeof status.registered !== 'boolean') return 'unavailable';
  if (status.registered) return status.inSync ? 'registered' : 'stale';
  return status.keyConfigured ? 'not-registered' : 'no-key';
}

/**
 * Everything the card shows: `t(key, vars)` translates a `settings.redesign.opencode.*` key (the key without the prefix).
 * → { state, dot, statusCls, statusText, note, tag, actions: [...'configure' | 'resync' | 'remove' | 'open-panel'], modelCount }
 */
export function maritacaOpencodeCardView(status, t, { configuring = false, error = '' } = {}) {
  const state = maritacaOpencodeCardState(status, { configuring, error });
  const K = MARITACA_OPENCODE_KEYS;
  const modelCount = Number(status?.modelCount) || 0;
  const keySource = status?.keySource === 'env' ? t(K.keyEnv) : t(K.keyFile);
  const view = { state, modelCount, actions: [], tag: '', note: '' };
  switch (state) {
    case 'configuring':
      Object.assign(view, { dot: DOT.wait, statusCls: 'stg-provider-status-key', statusText: t(K.configuringStatus), note: t(K.configuringNote) });
      break;
    case 'unavailable':
      Object.assign(view, { dot: DOT.off, statusCls: 'stg-provider-status-disconnected', statusText: t(K.unavailableStatus), note: t(K.unavailableNote) });
      break;
    case 'no-key':
      Object.assign(view, { dot: DOT.wait, statusCls: 'stg-provider-status-key', statusText: t(K.noKeyStatus), note: t(K.noKeyNote), actions: ['open-panel'] });
      break;
    case 'not-registered':
      Object.assign(view, { dot: DOT.wait, statusCls: 'stg-provider-status-key', statusText: t(K.notRegisteredStatus), note: t(K.notRegisteredNote, { source: keySource }), actions: ['configure'] });
      break;
    case 'stale':
      Object.assign(view, { dot: DOT.wait, statusCls: 'stg-provider-status-key', statusText: t(K.staleStatus), note: t(K.staleNote), actions: ['resync', 'remove'] });
      break;
    case 'error':
      Object.assign(view, { dot: DOT.off, statusCls: 'stg-provider-status-disconnected', statusText: t(K.errorStatus), note: t(K.error, { message: error }), actions: ['configure'] });
      break;
    default: // registered
      Object.assign(view, {
        dot: DOT.ok, statusCls: 'stg-provider-status-connected', statusText: t(K.registeredStatus),
        tag: t(K.registeredTag, { source: keySource }), note: '', actions: ['remove'],
      });
  }
  return view;
}

/** The OpenCode provider id the block is registered under: hidden ids are `maritaca/<model-id>`. */
export const MARITACA_OPENCODE_PROVIDER = 'maritaca';

/**
 * The card's per-model visibility list, the same denylist the other provider cards write (ocp-hidden-models.js,
 * "providerID/modelID"). Models come from the status answer (`status.models`, lib/maritaca/opencode.js); a server from
 * before that field sends none, and then `fallback` (the model ids OpenCode lists for `maritaca`) stands in.
 * Only a registered block (in sync or stale) has a list. → { rows: [{ id, fullId, name, hidden, tools }], enabled, total }
 */
export function maritacaOpencodeModelRows(status, hidden = new Set(), fallback = []) {
  const registered = !!status && status.ok !== false && status.registered === true;
  if (!registered) return { rows: [], enabled: 0, total: 0 };
  const has = (id) => (hidden && typeof hidden.has === 'function' ? hidden.has(id) : false);
  const source = Array.isArray(status.models) && status.models.length
    ? status.models
    : (Array.isArray(fallback) ? fallback : []).map((m) => (typeof m === 'string' ? { id: m } : m));
  const seen = new Set();
  const rows = [];
  for (const m of source) {
    const id = typeof m?.id === 'string' ? m.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fullId = `${MARITACA_OPENCODE_PROVIDER}/${id}`;
    rows.push({ id, fullId, name: typeof m.name === 'string' && m.name ? m.name : id, hidden: has(fullId), tools: typeof m.tools === 'boolean' ? m.tools : null });
  }
  return { rows, enabled: rows.filter((r) => !r.hidden).length, total: rows.length };
}
