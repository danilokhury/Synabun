// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: preferences
// ═══════════════════════════════════════════
//
// The editor's preferences: their defaults, the one normaliser both sides use
// (the server's lib/editor-config.js imports it from here), and the store the
// panel reads. The store talks to /api/editor/config when the server has it;
// against a server that does not, the preferences are these defaults, kept in
// memory for the page. No DOM and no imports: loaded by `node --test` as it is.

export const EDITOR_CONFIG_VERSION = 1;

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 18;
export const FONT_SIZE_DEFAULT = 12;
export const TAB_SIZES = Object.freeze([2, 4, 8]);
export const INDENT_WITH = Object.freeze(['auto', 'spaces', 'tabs']);
/** Where spaces and tabs are drawn: nowhere, in the selection, or everywhere. */
export const RENDER_WHITESPACE = Object.freeze(['none', 'selection', 'all']);
const AI_ENGINES = ['opencode', 'endpoint'];
const ENDPOINT_KINDS = ['ollama', 'openai'];
const ENDPOINT_SHAPES = ['fim', 'chat'];
const MAX_EXCLUDES = 200;

/** File name globs AI autocomplete never reads (docs/design/code-editor/SPEC.md, section 9.4). */
export const AI_EXCLUDE_DEFAULTS = Object.freeze([
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.kdbx',
  'id_rsa*', 'id_ed25519*', '.npmrc', '.netrc', '.pypirc', 'credentials*',
  'secrets.*', '*.secret', 'auth.json',
]);

/** A fresh copy of the defaults. */
export function defaultEditorConfig() {
  return {
    version: EDITOR_CONFIG_VERSION,
    editing: {
      fontSize: FONT_SIZE_DEFAULT,
      ligatures: true,
      wordWrap: true,
      tabSize: 'auto',
      indentWith: 'auto',
      indentGuides: true,
      minimap: true,
      renderWhitespace: 'none',
      trimTrailingWhitespace: false,
      insertFinalNewline: false,
    },
    ai: {
      enabled: false,
      engine: 'opencode',
      model: null,
      endpoint: { kind: 'ollama', url: '', model: '', shape: 'fim' },
      debounceMs: 300,
      maxLines: 12,
      neighbors: true,
      exclude: [...AI_EXCLUDE_DEFAULTS],
    },
  };
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const clampInt = (v, min, max, fallback) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const shortText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function normalizeTabSize(v, fallback) {
  if (v === 'auto') return 'auto';
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return TAB_SIZES.includes(n) ? n : fallback;
}

function normalizeModel(v) {
  const id = shortText(v, 300);
  return id && id.includes('/') && !id.startsWith('/') && !id.endsWith('/') ? id : null;
}

function normalizeUrl(v) {
  const url = shortText(v, 2000);
  return /^https?:\/\//i.test(url) ? url : '';
}

function normalizeExcludes(v, fallback) {
  if (!Array.isArray(v)) return [...fallback];
  const out = [];
  for (const item of v) {
    const glob = shortText(item, 200);
    if (glob && !glob.includes('/') && !glob.includes('\\') && !out.includes(glob)) out.push(glob);
    if (out.length >= MAX_EXCLUDES) break;
  }
  return out;
}

/**
 * A complete, valid configuration from anything: unknown keys are dropped, a value of the wrong type or outside
 * its list takes the default, and a number outside its range is brought to the nearest end.
 */
export function normalizeEditorConfig(input) {
  const d = defaultEditorConfig();
  const src = isObject(input) ? input : {};
  const e = isObject(src.editing) ? src.editing : {};
  const a = isObject(src.ai) ? src.ai : {};
  const ep = isObject(a.endpoint) ? a.endpoint : {};
  return {
    version: EDITOR_CONFIG_VERSION,
    editing: {
      fontSize: clampInt(e.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, d.editing.fontSize),
      ligatures: bool(e.ligatures, d.editing.ligatures),
      wordWrap: bool(e.wordWrap, d.editing.wordWrap),
      tabSize: normalizeTabSize(e.tabSize, d.editing.tabSize),
      indentWith: oneOf(e.indentWith, INDENT_WITH, d.editing.indentWith),
      indentGuides: bool(e.indentGuides, d.editing.indentGuides),
      minimap: bool(e.minimap, d.editing.minimap),
      renderWhitespace: oneOf(e.renderWhitespace, RENDER_WHITESPACE, d.editing.renderWhitespace),
      trimTrailingWhitespace: bool(e.trimTrailingWhitespace, d.editing.trimTrailingWhitespace),
      insertFinalNewline: bool(e.insertFinalNewline, d.editing.insertFinalNewline),
    },
    ai: {
      enabled: bool(a.enabled, d.ai.enabled),
      engine: oneOf(a.engine, AI_ENGINES, d.ai.engine),
      model: normalizeModel(a.model),
      endpoint: {
        kind: oneOf(ep.kind, ENDPOINT_KINDS, d.ai.endpoint.kind),
        url: normalizeUrl(ep.url),
        model: shortText(ep.model, 200),
        shape: oneOf(ep.shape, ENDPOINT_SHAPES, d.ai.endpoint.shape),
      },
      debounceMs: clampInt(a.debounceMs, 100, 2000, d.ai.debounceMs),
      maxLines: clampInt(a.maxLines, 1, 40, d.ai.maxLines),
      neighbors: bool(a.neighbors, d.ai.neighbors),
      exclude: normalizeExcludes(a.exclude, d.ai.exclude),
    },
  };
}

/**
 * `current` with a partial change applied, normalised. Objects merge key by key; an array or a plain value
 * replaces what was there. A key the change does not name keeps its value.
 */
export function mergeEditorConfig(current, partial) {
  const merge = (base, change) => {
    if (!isObject(change)) return base;
    const out = { ...base };
    for (const [key, value] of Object.entries(change)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = isObject(value) && isObject(base?.[key]) ? merge(base[key], value) : value;
    }
    return out;
  };
  return normalizeEditorConfig(merge(normalizeEditorConfig(current), partial));
}

const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The page's copy of the preferences.
 * @param {{ fetchImpl?: typeof fetch }} [o]
 * @returns {{
 *   get: () => object, synced: () => boolean,
 *   load: () => Promise<boolean>, set: (partial: object) => Promise<boolean>,
 *   applyRemote: (config: object) => boolean, subscribe: (fn: (config: object) => void) => () => void,
 * }}
 *   `load()` reads the server's copy (false, and the defaults stay, when the server has no such route);
 *   `set()` applies a change here at once and saves it when the server keeps preferences;
 *   `applyRemote()` takes a configuration another window saved.
 */
export function createEditorPrefs({ fetchImpl = (...args) => fetch(...args) } = {}) {
  let config = defaultEditorConfig();
  let synced = false;
  const listeners = new Set();

  const replace = (next) => {
    if (sameConfig(next, config)) return false;
    config = next;
    for (const fn of [...listeners]) { try { fn(config); } catch { /* a listener's own failure */ } }
    return true;
  };

  async function load() {
    try {
      const res = await fetchImpl('/api/editor/config');
      if (!res.ok) { synced = false; return false; }
      const body = await res.json();
      if (!body?.ok || !isObject(body.config)) { synced = false; return false; }
      synced = true;
      replace(normalizeEditorConfig(body.config));
      return true;
    } catch {
      synced = false;
      return false;
    }
  }

  let writes = 0;
  async function set(partial) {
    replace(mergeEditorConfig(config, partial));
    if (!synced) return true;
    const mine = ++writes;
    try {
      const res = await fetchImpl('/api/editor/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok || !isObject(body.config)) return false;
      // An answer to an older change must not undo a newer one made while it was on its way.
      if (mine === writes) replace(normalizeEditorConfig(body.config));
      return true;
    } catch {
      return false;
    }
  }

  return {
    get: () => config,
    synced: () => synced,
    load,
    set,
    applyRemote: (next) => replace(normalizeEditorConfig(next)),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
