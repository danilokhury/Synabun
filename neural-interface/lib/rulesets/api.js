// ═══════════════════════════════════════════
// SynaBun — rules REST API (/api/setup/rules/*)
// ═══════════════════════════════════════════
//
// Registered on the main app with absolute paths, so the admin-only
// `/api/setup` prefix in server.js covers every route here (invite guests get
// 403 before they reach it). Literal routes come before `/:host`.
//
//   GET    /api/setup/rules                 status of every host, pasted copies, notice
//   GET    /api/setup/rules/:host/text      the rendered text (`coexistence` is the copy-only snippet)
//   POST   /api/setup/rules/:host {force?}  install
//   DELETE /api/setup/rules/:host {force?}  remove (`?force=1` works too); an edited copy stays unless forced
//   POST   /api/setup/rules/install-all {hosts?}
//   PUT    /api/setup/rules/settings {autoUpdate}
//   POST   /api/setup/rules/legacy/remove {path}
//   POST   /api/setup/rules/notice/ack
//
// A request the files said no to is a 409 with the installer's own result as
// the body: `state` (`modified`, `conflict`, `not-installed`, `error`) or a
// `code` says why, and `error` is the sentence to show. Codes:
// `REMOVE_INCOMPLETE` (rules SynaBun could not take out: damaged markers, a
// block stamped for another tool, a symlinked owned file; `kept` lists them),
// `CHANGED_UNDERNEATH` (a file changed, or vanished, between the moment it was
// read and the write: it was left as it is) and `BUSY` (another SynaBun
// process on the same data home held the rules lock for the whole wait:
// nothing was changed, `retryable: true`). The last two mean "try again". A
// lock file that cannot be used at all is `LOCK_UNAVAILABLE`, a 500: nothing
// was changed, and trying again will not help until the data home is fixed. A
// remove that leaves a copy to the user (an edited one, or for OpenCode one
// that the user's own line in config.json points at) is not a refusal: 200,
// `ok: true`, `kept: [{path, reason}]`.
//
// Every installer call is synchronous and runs to its end inside the handler,
// so two requests never interleave in this process. The one thing a writing
// route can wait for is the writer lock another SynaBun process holds, for at
// most the installer's `lockTimeoutMs` (see lock.js and the header of
// installer.js). GET routes take no lock.
//
// The two older read-only endpoints the current UI calls keep their response
// shapes (registerLegacyRulesetRoutes) and are answered by the same renderer.

import { isRulesetHost, readRulesetManifest, renderCoexistenceSnippet, renderRuleset, RULESET_HOSTS } from './render.js';

// The pre-2.0 `format` names, as the onboarding wizard and Settings still send them.
const LEGACY_FORMATS = Object.freeze({ claude: 'claude', codex: 'codex', cursor: 'cursor', generic: 'opencode', opencode: 'opencode', gemini: 'gemini' });
const LEGACY_VERSION_FORMATS = Object.freeze(['claude', 'codex', 'cursor', 'generic', 'gemini']);
// A copy someone edited, damaged markers, a CLI that is not there: the request was fine, the files said no.
const REFUSED_STATES = new Set(['not-installed', 'modified', 'conflict', 'error']);
const REFUSED_CODES = new Set(['REMOVE_INCOMPLETE', 'CHANGED_UNDERNEATH', 'BUSY']);
// The lock file itself is broken: the server's fault, not the request's and not the files'.
const FAILED_CODES = new Set(['LOCK_UNAVAILABLE']);

function fail(res, error, fallback = 500) {
  const status = error?.code === 'UNKNOWN_HOST' ? 400 : fallback;
  return res.status(status).json({ ok: false, error: error?.message || String(error) });
}

function sendResult(res, result) {
  if (result?.ok === false) {
    const refused = !FAILED_CODES.has(result.code) && (REFUSED_STATES.has(result.state) || REFUSED_CODES.has(result.code));
    return res.status(refused ? 409 : 500).json(result);
  }
  return res.json(result);
}

export function registerRulesetRoutes(app, { installer, render = renderRuleset } = {}) {
  if (!app || !installer) throw new Error('registerRulesetRoutes requires an app and an installer');

  app.get('/api/setup/rules', (req, res) => {
    try { res.json(installer.status()); } catch (error) { fail(res, error); }
  });

  app.post('/api/setup/rules/install-all', (req, res) => {
    try {
      const hosts = Array.isArray(req.body?.hosts) ? req.body.hosts.filter((host) => typeof host === 'string') : null;
      const result = installer.installAll({ hosts, force: req.body?.force === true });
      // Nothing ran at all (the lock could not be taken): a refusal, not a list of per-host results.
      if (result.ok === false && result.code) return sendResult(res, result);
      res.json({ ...result, status: installer.status() });
    } catch (error) { fail(res, error); }
  });

  app.put('/api/setup/rules/settings', (req, res) => {
    try {
      if (typeof req.body?.autoUpdate !== 'boolean') return res.status(400).json({ ok: false, error: 'autoUpdate must be true or false' });
      sendResult(res, installer.setAutoUpdate(req.body.autoUpdate));
    } catch (error) { fail(res, error); }
  });

  app.post('/api/setup/rules/legacy/remove', (req, res) => {
    try {
      const path = req.body?.path;
      if (typeof path !== 'string' || !path) return res.status(400).json({ ok: false, error: 'path is required' });
      const result = installer.removeLegacy(path);
      if (result.ok === false) return res.status(result.code === 'NOT_A_CANDIDATE' ? 403 : FAILED_CODES.has(result.code) ? 500 : REFUSED_CODES.has(result.code) ? 409 : 400).json(result);
      res.json(result);
    } catch (error) { fail(res, error); }
  });

  app.post('/api/setup/rules/notice/ack', (req, res) => {
    try { sendResult(res, installer.ackNotice()); } catch (error) { fail(res, error); }
  });

  app.get('/api/setup/rules/:host/text', (req, res) => {
    try {
      const host = String(req.params.host || '').toLowerCase();
      if (host === 'coexistence') return res.json({ ok: true, host, copyOnly: true, ...renderCoexistenceSnippet() });
      if (!isRulesetHost(host)) return res.status(400).json({ ok: false, error: `Unknown host: ${host}. Use ${RULESET_HOSTS.join(', ')}.` });
      const { text, version, hash } = render(host);
      res.json({ ok: true, host, text, version, hash });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/setup/rules/:host', (req, res) => {
    try {
      const host = String(req.params.host || '').toLowerCase();
      const force = req.body?.force === true;
      sendResult(res, installer.install(host, { force }));
    } catch (error) { fail(res, error); }
  });

  app.delete('/api/setup/rules/:host', (req, res) => {
    try {
      const host = String(req.params.host || '').toLowerCase();
      const force = req.body?.force === true || ['1', 'true'].includes(String(req.query?.force ?? '').toLowerCase());
      sendResult(res, installer.remove(host, { force }));
    } catch (error) { fail(res, error); }
  });
}

/** `{ok, ruleset, format}` for GET /api/claude-code/ruleset?format=, or `{status, error}` when the format is unknown. */
export function legacyRulesetPayload(format, { render = renderRuleset } = {}) {
  const name = String(format || 'claude').toLowerCase();
  if (name === 'coexistence') return { ok: true, ruleset: renderCoexistenceSnippet().text, format: name };
  const host = LEGACY_FORMATS[name];
  if (!host) return { status: 400, error: `Invalid format: ${name}. Use claude, cursor, generic, gemini, codex, or coexistence.` };
  return { ok: true, ruleset: render(host).text, format: name };
}

/** `{ok, formats:{<format>:{fingerprint, version, summary, updatedAt, source}}}` for the Updates drawer. */
export function legacyRulesetVersionsPayload() {
  const manifest = readRulesetManifest();
  const formats = {};
  for (const format of LEGACY_VERSION_FORMATS) {
    formats[format] = {
      fingerprint: `v:${manifest.version}`,
      version: manifest.version,
      summary: manifest.summary || '',
      updatedAt: manifest.updatedAt || '',
      source: 'manifest',
    };
  }
  return { ok: true, formats };
}

/** The two endpoints the pre-2.0 UI reads. Same shapes as before, served from the renderer. */
export function registerLegacyRulesetRoutes(app, { render = renderRuleset } = {}) {
  // Supports ?format=claude (default) | cursor | generic | gemini | codex | coexistence
  app.get('/api/claude-code/ruleset', (req, res) => {
    try {
      const payload = legacyRulesetPayload(req.query.format, { render });
      if (payload.error) return res.status(payload.status).json({ error: payload.error });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get('/api/claude-code/ruleset/versions', (req, res) => {
    try {
      res.json(legacyRulesetVersionsPayload());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
