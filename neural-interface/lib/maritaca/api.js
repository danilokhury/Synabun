// ═══════════════════════════════════════════
// SynaBun — Maritaca AI: the REST routes (/api/maritaca)
// ═══════════════════════════════════════════
//
//   GET    /api/maritaca/panel      what the side panel's socket offers on this server ({ socket, capabilities, live })
//   GET    /api/maritaca/models     the Sabiá models: the API's list merged over the table, else the table ({ models, source })
//   GET    /api/maritaca/settings   { configured, source: 'file' | 'env' | null, masked, settings }  — never the key
//   PUT    /api/maritaca/settings   { key?, model?, reasoningEffort?, systemPrompt?, temperature? }; `key` is saved to the key file
//   DELETE /api/maritaca/settings/key   forgets the saved key (an environment key stays in force)
//   POST   /api/maritaca/test       asks Maritaca whether the key is accepted ({ key? } tests a key before saving it)
//   GET    /api/maritaca/sessions   the conversations ({ sessions }), `?project=` narrows
//   GET    /api/maritaca/sessions/:id    one conversation with its messages
//   DELETE /api/maritaca/sessions/:id
//   GET    /api/maritaca/opencode/status      Maritaca as an OpenCode provider (lib/maritaca/opencode.js): registered, modelCount, inSync, key source; never the key
//   POST   /api/maritaca/opencode/configure   writes the provider block into the global opencode.json (412 NO_KEY, 409 OPENCODE1_PROVIDERS)
//   DELETE /api/maritaca/opencode/configure   takes it out
//   (the three answer 503 OPENCODE_SYNC_UNAVAILABLE on a server built without the sync; status also carries `proxy`,
//   the counts of the route below and the shape of its last repair, never a key or a value)
//   POST   /api/maritaca/opencode/v1/chat/completions   OpenCode's requests for a Sabiá model, sent on to Maritaca with the
//          stream put in the order OpenCode reads (lib/maritaca/opencode-proxy.js): loopback only, and only for a caller
//          that presents the saved key; errors in OpenAI's shape; 503 OPENCODE_PROXY_UNAVAILABLE on a server without it
//
// Registered on the app one by one (`registerMaritacaRoutes(app, deps)`, the form tests/request-gate.test.mjs asks
// every helper for), each behind `guard` (server.js's ownerRouteGuard: this server's Hosts, own Origin on a write, no
// guests); the prefix is admin-only in lib/request-gate.js too. A request body never outlives its handler
// with a key in it, an error from Maritaca is answered by its code, never its text verbatim when it could echo
// input, and nothing here logs a key.

import express from 'express';
import { MARITACA_PANEL_CAPABILITIES, MARITACA_WS_PATH } from './panel-bridge.js';
import { isSessionId } from './sessions.js';
import { requireLocal } from '../http-guards.js';

const STATUS_FOR = { KEY_REJECTED: 401, RATE_LIMITED: 429, MODEL_UNKNOWN: 404, BAD_REQUEST: 400, UPSTREAM: 502, UNREACHABLE: 503, TIMEOUT: 504, NO_KEY: 412, INVALID_KEY: 400, ABORTED: 499 };

export function registerMaritacaRoutes(app, { client, keyStore, sessions, bridge = null, opencode = null, proxy = null, guard = (req, res, next) => next(), localOnly = requireLocal, log = () => {} } = {}) {
  if (!client || !keyStore || !sessions) throw new Error('registerMaritacaRoutes needs client, keyStore and sessions');
  const noStore = (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };
  const body = express.json({ limit: '256kb' });
  // Every route: the guard, then no-store. `router` below is a tiny shim so each handler reads as a route line.
  const router = {
    get: (path, ...rest) => app.get(`/api/maritaca${path}`, guard, noStore, ...rest),
    put: (path, ...rest) => app.put(`/api/maritaca${path}`, guard, noStore, ...rest),
    post: (path, ...rest) => app.post(`/api/maritaca${path}`, guard, noStore, ...rest),
    delete: (path, ...rest) => app.delete(`/api/maritaca${path}`, guard, noStore, ...rest),
  };
  const fail = (res, error) => {
    const code = error?.code || 'ERROR';
    const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : STATUS_FOR[code] || 500;
    res.status(status).json({ ok: false, code, error: error?.message || 'Something went wrong.' });
  };

  router.get('/panel', (req, res) => {
    res.json({ ok: true, socket: MARITACA_WS_PATH, capabilities: [...MARITACA_PANEL_CAPABILITIES], live: bridge?.liveCount?.() || 0, turns: bridge?.turnsRunning?.() || 0 });
  });

  router.get('/models', async (req, res) => {
    try {
      const listed = await client.listModels({ key: keyStore.readKey() });
      res.json({ ok: true, models: listed.models, source: listed.source, configured: !!keyStore.readKey(), ...(listed.error ? { error: listed.error } : {}) });
    } catch (error) { fail(res, error); }
  });

  router.get('/settings', (req, res) => {
    try { res.json({ ok: true, ...keyStore.status() }); } catch (error) { fail(res, error); }
  });

  router.put('/settings', body, async (req, res) => {
    let key = req.body?.key;
    if (req.body) delete req.body.key;
    try {
      let keySaved = false;
      if (typeof key === 'string' && key.trim()) { keyStore.saveKey(key); keySaved = true; }
      const { model, reasoningEffort, systemPrompt, temperature } = req.body || {};
      const patch = {};
      if (model !== undefined) patch.model = model;
      if (reasoningEffort !== undefined) patch.reasoningEffort = reasoningEffort;
      if (systemPrompt !== undefined) patch.systemPrompt = systemPrompt;
      if (temperature !== undefined) patch.temperature = temperature;
      if (Object.keys(patch).length) keyStore.saveSettings(patch);
      const status = keyStore.status();
      try { bridge?.notifySettingsChanged?.(); } catch { /* no panel open */ }
      // A registered OpenCode provider block follows the key (never throws).
      const opencodeSync = keySaved && opencode ? await opencode.onKeyChanged() : null;
      res.json({ ok: true, ...status, ...(opencodeSync ? { opencode: opencodeSync } : {}) });
    } catch (error) { fail(res, error); }
    finally { key = null; }
  });

  router.delete('/settings/key', async (req, res) => {
    try {
      keyStore.clearKey();
      try { bridge?.notifySettingsChanged?.(); } catch { /* no panel open */ }
      const opencodeSync = opencode ? await opencode.onKeyChanged() : null;
      res.json({ ok: true, ...keyStore.status(), ...(opencodeSync ? { opencode: opencodeSync } : {}) });
    } catch (error) { fail(res, error); }
  });

  router.post('/test', body, async (req, res) => {
    let key = req.body?.key;
    if (req.body) delete req.body.key;
    try {
      const candidate = typeof key === 'string' && key.trim() ? key.trim() : keyStore.readKey();
      if (!candidate) return fail(res, Object.assign(new Error('Save a Maritaca API key first.'), { code: 'NO_KEY', status: 412 }));
      const verdict = await client.verifyKey({ key: candidate });
      res.json({ ok: true, via: verdict.via });
    } catch (error) {
      log(`[maritaca] key test: ${error?.code || 'ERROR'}`);
      fail(res, error);
    } finally { key = null; }
  });

  // ── Maritaca as an OpenCode provider ──
  const noSync = (res) => res.status(503).json({ ok: false, code: 'OPENCODE_SYNC_UNAVAILABLE', error: 'This server cannot register Maritaca in OpenCode yet. Restart SynaBun.' });

  router.get('/opencode/status', (req, res) => {
    if (!opencode) return noSync(res);
    try { res.json({ ok: true, ...opencode.status(), ...(proxy ? { proxy: proxy.status() } : {}) }); } catch (error) { fail(res, error); }
  });

  router.post('/opencode/configure', async (req, res) => {
    if (!opencode) return noSync(res);
    try {
      const result = await opencode.configure();
      res.json({ ok: true, ...result, ...opencode.status() });
    } catch (error) {
      log(`[maritaca] OpenCode provider configure: ${error?.code || 'ERROR'}`);
      fail(res, error);
    }
  });

  router.delete('/opencode/configure', async (req, res) => {
    if (!opencode) return noSync(res);
    try {
      const result = await opencode.remove();
      res.json({ ok: true, ...result, ...opencode.status() });
    } catch (error) { fail(res, error); }
  });

  // OpenCode's requests for a Sabiá model (the provider block's baseURL). Its answers are in OpenAI's error shape, which
  // is what OpenCode shows, never this module's { ok, code, error }.
  router.post('/opencode/v1/chat/completions', localOnly, (req, res) => {
    if (!proxy) return res.status(503).json({ error: { message: 'This SynaBun server cannot carry OpenCode\'s Maritaca requests yet. Restart SynaBun.', type: 'synabun_maritaca_proxy', code: 'OPENCODE_PROXY_UNAVAILABLE' } });
    Promise.resolve().then(() => proxy.handle(req, res)).catch((error) => {
      log(`[maritaca] OpenCode proxy: ${error?.code || 'ERROR'}`);
      if (!res.headersSent) res.status(500).json({ error: { message: 'SynaBun could not send this request on to Maritaca.', type: 'synabun_maritaca_proxy', code: 'PROXY_ERROR' } });
      else { try { res.end(); } catch { /* gone */ } }
    });
  });

  router.get('/sessions', (req, res) => {
    try { res.json({ ok: true, sessions: sessions.list({ project: typeof req.query.project === 'string' ? req.query.project : null, limit: req.query.limit }) }); }
    catch (error) { fail(res, error); }
  });

  router.get('/sessions/:id', (req, res) => {
    if (!isSessionId(req.params.id)) return res.status(400).json({ ok: false, code: 'SESSION_INVALID', error: 'Unknown conversation.' });
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ ok: false, code: 'SESSION_UNKNOWN', error: 'That conversation no longer exists.' });
    res.json({ ok: true, session });
  });

  router.delete('/sessions/:id', (req, res) => {
    if (!isSessionId(req.params.id)) return res.status(400).json({ ok: false, code: 'SESSION_INVALID', error: 'Unknown conversation.' });
    res.json({ ok: true, ...(bridge?.removeSession ? bridge.removeSession(req.params.id) : { deleted: sessions.remove(req.params.id) }) });
  });

  router.put('/sessions/:id', body, (req, res) => {
    if (!isSessionId(req.params.id)) return res.status(400).json({ ok: false, code: 'SESSION_INVALID', error: 'Unknown conversation.' });
    if (typeof req.body?.title !== 'string') return res.status(400).json({ ok: false, code: 'TITLE_INVALID', error: 'A title is required.' });
    try {
      const result = bridge?.renameSession ? bridge.renameSession(req.params.id, req.body.title) : { session: sessions.update(req.params.id, { title: req.body.title }) };
      if (!result.session) return res.status(404).json({ ok: false, code: 'SESSION_UNKNOWN', error: 'That conversation no longer exists.' });
      res.json({ ok: true, ...result });
    } catch (error) { fail(res, error); }
  });

  return app;
}
