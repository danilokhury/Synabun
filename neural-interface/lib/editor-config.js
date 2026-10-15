// ── The code editor's preferences (DATA_HOME/data/editor-config.json) ──
// Word wrap, font size, indentation and the AI autocomplete settings of the
// File Explorer's editor. The defaults and the normaliser are the client's own
// (public/shared/editor/editor-prefs.js): one definition, so the file on disk
// and the page can never disagree about what a valid configuration is. Unknown
// keys are dropped and out-of-range values clamped on the way in and on the
// way out.
//
// The endpoint API key of AI autocomplete is not kept here: it is
// SYNABUN_EDITOR_AI_KEY in the environment, and only whether one is set
// (`hasEndpointKey`) ever reaches the page.

import { Router } from 'express';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { replaceFileAtomic } from './confined-fs.js';
import { defaultEditorConfig, mergeEditorConfig, normalizeEditorConfig } from '../public/shared/editor/editor-prefs.js';

export { defaultEditorConfig, normalizeEditorConfig };
export const EDITOR_CONFIG_SYNC_TYPE = 'editor:config-changed';
/** What these routes add to the editor (GET /api/editor/capabilities). */
export const EDITOR_CONFIG_CAPABILITIES = Object.freeze(['config']);

/**
 * The stored configuration. Read again when the file's modification time changes; written atomically.
 * @param {{ path: string, log?: (tag: string, message: string) => void }} o
 */
export function createEditorConfigStore({ path, log = () => {} } = {}) {
  if (!path) throw new Error('createEditorConfigStore requires path');
  let cached = null; // { mtimeMs, config }

  const mtime = () => { try { return statSync(path).mtimeMs; } catch { return 0; } };

  /** The configuration in effect: the file's, normalised, or the defaults when there is no (readable) file. */
  function read() {
    const m = mtime();
    if (cached && cached.mtimeMs === m) return cached.config;
    let config = defaultEditorConfig();
    if (m) {
      try { config = normalizeEditorConfig(JSON.parse(readFileSync(path, 'utf8'))); }
      catch (error) { log('editor-config:unreadable', error?.message || String(error)); }
    }
    cached = { mtimeMs: m, config };
    return config;
  }

  /**
   * Apply a partial change and save.
   * @returns {{ config: object, changed: boolean }}
   */
  function update(partial) {
    const current = read();
    const config = mergeEditorConfig(current, partial);
    const changed = JSON.stringify(config) !== JSON.stringify(current);
    if (changed) {
      mkdirSync(dirname(path), { recursive: true });
      replaceFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
      cached = { mtimeMs: mtime(), config };
    }
    return { config, changed };
  }

  return { read, update, path };
}

export const ENDPOINT_KEY_NAME = 'SYNABUN_EDITOR_AI_KEY';
// A bearer token as providers issue them. Nothing that could start a new line or a comment in a .env file.
const ENDPOINT_KEY_FORMAT = /^[A-Za-z0-9._~+/=:@-]{1,500}$/;

/**
 * The API key of AI autocomplete's endpoint: SYNABUN_EDITOR_AI_KEY in the data home's .env, beside the other
 * secrets, and in the environment of the running server. Written the way the TypeSafe key is (read the file,
 * change one name, write the file).
 * @param {object} deps
 * @param {string} deps.envPath the .env file
 * @param {(path: string) => object} deps.parseEnvFile server.js's reader
 * @param {(path: string, vars: object) => void} deps.writeEnvFile server.js's writer
 * @param {object} [deps.env] the running environment (process.env)
 */
export function createEndpointKeyStore({ envPath, parseEnvFile, writeEnvFile, env = process.env } = {}) {
  if (!envPath || typeof parseEnvFile !== 'function' || typeof writeEnvFile !== 'function') {
    throw new Error('createEndpointKeyStore requires envPath, parseEnvFile and writeEnvFile');
  }
  const get = () => String(env[ENDPOINT_KEY_NAME] || '').trim();
  return {
    get,
    has: () => !!get(),
    /** Store a key, or remove it with ''. Throws on a value that is not a key. */
    set(value) {
      if (typeof value !== 'string') throw new Error('The endpoint key must be text');
      const key = value.trim();
      if (key && !ENDPOINT_KEY_FORMAT.test(key)) throw new Error('The endpoint key has an unexpected format');
      const vars = parseEnvFile(envPath);
      if (key) { vars[ENDPOINT_KEY_NAME] = key; env[ENDPOINT_KEY_NAME] = key; }
      else { delete vars[ENDPOINT_KEY_NAME]; delete env[ENDPOINT_KEY_NAME]; }
      writeEnvFile(envPath, vars);
      return !!key;
    },
  };
}

/**
 * GET /  → { ok, config, hasEndpointKey }
 * PUT /  (a partial configuration) → the same, after the change; other windows are told when it changed anything.
 *        `endpointKey` in the body stores the endpoint's API key ('' removes it); it is never part of an answer.
 * Mounted at /api/editor/config. The owner's only: `guard` refuses everybody else on the router itself.
 * @param {object} deps
 * @param {{ read: () => object, update: (partial: object) => { config: object, changed: boolean } }} deps.store
 * @param {(message: object) => void} [deps.broadcastSync]
 * @param {() => boolean} [deps.hasEndpointKey]
 * @param {(key: string) => void} [deps.setEndpointKey] stores or removes the key; without it a key cannot be saved
 * @param {(req: object, res: object, next: () => void) => void} [deps.guard] who may use these routes
 *   (lib/http-guards.js ownerRouteGuard); without one, anybody who reaches them
 */
export function createEditorConfigRouter({ store, broadcastSync = () => {}, hasEndpointKey = () => false, setEndpointKey = null, guard = null } = {}) {
  if (!store) throw new Error('createEditorConfigRouter requires a store');
  const router = Router();
  if (typeof guard === 'function') router.use(guard);
  const view = (config) => ({ ok: true, config, hasEndpointKey: !!hasEndpointKey() });

  router.get('/', (req, res) => {
    try { res.json(view(store.read())); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });

  router.put('/', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ ok: false, error: 'The body must be an object holding the preferences to change' });
    }
    const { endpointKey, ...partial } = req.body;
    try {
      let keyChanged = false;
      if (endpointKey !== undefined) {
        if (typeof setEndpointKey !== 'function') return res.status(400).json({ ok: false, error: 'Key storage is not wired in this server' });
        const had = !!hasEndpointKey();
        try { setEndpointKey(endpointKey); }
        catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
        keyChanged = had !== !!hasEndpointKey();
      }
      const { config, changed } = store.update(partial);
      if (changed || keyChanged) broadcastSync({ type: EDITOR_CONFIG_SYNC_TYPE, config, hasEndpointKey: !!hasEndpointKey() });
      res.json(view(config));
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  return router;
}
