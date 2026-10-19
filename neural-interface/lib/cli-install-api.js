// ═══════════════════════════════════════════
// SynaBun — /api/cli/install: the side panels' Install button
// ═══════════════════════════════════════════
//
//   GET  /api/cli/install         { ok, jobs: { [tool]: { state, step, code, error, log, … } } }
//   POST /api/cli/install/:tool   NDJSON: start, step, progress, log … done (lib/cli-install.js)
//   GET  /api/cli/git-bash        Git Bash for Claude Code on Windows (lib/git-bash/), and
//   POST /api/cli/git-bash/install|recheck  its download and a new look (createGitBashApi below)
//
// Installing software is the owner's own act on this computer, so these routes
// take the guards of SynaBun's other local mutating endpoints (lib/http-guards.js,
// as /api/whatsapp): a loopback socket and no proxy header, a localhost Host,
// no invite guest; a POST also its own Origin, a JSON body, X-SynaBun-UI: 1 and
// no agent header. (`/api/cli` is admin-only in lib/request-gate.js too.) A
// request names a tool and nothing else: what runs is fixed by
// lib/cli-install.js for this system.
//
// Refusals before anything starts are JSON: 400 UNKNOWN_TOOL, 409 BUSY (that
// tool is being installed), 422 UNSUPPORTED (no one-click method here). A tab
// that goes away does not stop an install; its result is in GET and in the next
// /api/system/tool-versions.

import { Router } from 'express';
import { guestForbidden, noStore, requireLocal, requireLocalHost, requireSameOriginJson, sendGuardError, uiOnly } from './http-guards.js';
import { openNdjsonStream } from './whatsapp/api.js';

export const INSTALLABLE_TOOLS = Object.freeze(['claude-code', 'codex', 'opencode']);

/**
 * @param {object} deps
 * @param {ReturnType<import('./cli-install.js').createCliInstaller>} deps.installer
 * @param {(req) => boolean} [deps.isGuestRequest]
 * @param {number|(() => number)} [deps.port]  the port the page is served from (Host / Origin checks)
 */
function localCliRouter({ isGuestRequest = () => false, port = 3344 } = {}) {
  const router = Router();
  const portOf = () => Number(typeof port === 'function' ? port() : port);
  const built = new Map();
  const perPort = (name, factory) => (req, res, next) => {
    const key = `${name}:${portOf()}`;
    let guard = built.get(key);
    if (!guard) {
      try { guard = factory(portOf()); } catch { return sendGuardError(res, 500, 'BAD_PORT', 'The install API has no valid port.'); }
      built.set(key, guard);
    }
    return guard(req, res, next);
  };

  router.use(noStore, guestForbidden(isGuestRequest), requireLocal, perPort('host', requireLocalHost));
  const mutating = [perPort('origin', requireSameOriginJson), uiOnly];
  return { router, mutating };
}

export function createCliInstallApi({ installer, isGuestRequest = () => false, port = 3344, log = () => {} } = {}) {
  if (!installer) throw new Error('createCliInstallApi needs the installer');
  const { router, mutating } = localCliRouter({ isGuestRequest, port });

  router.get('/', (req, res) => {
    res.json({ ok: true, jobs: installer.jobs() });
  });

  router.post('/:tool', ...mutating, (req, res) => {
    const tool = String(req.params.tool || '');
    if (!INSTALLABLE_TOOLS.includes(tool)) {
      return res.status(400).json({ ok: false, code: 'UNKNOWN_TOOL', error: `Unknown CLI: ${tool.slice(0, 40)}` });
    }
    let stream = null;
    const onEvent = (event) => {
      if (!stream) stream = openNdjsonStream(res);
      stream.write(event);
      if (event?.type === 'done') stream.end();
    };
    let started;
    try {
      started = installer.start(tool, { onEvent });
    } catch (error) {
      const code = error?.code === 'busy' ? 'BUSY' : error?.code === 'unsupported' ? 'UNSUPPORTED' : 'INTERNAL';
      if (code === 'INTERNAL') log(`[cli-install] ${tool} could not start: ${error?.message || error}`);
      if (stream) return stream.end({ type: 'done', ok: false, code: 'internal', error: String(error?.message || error) });
      return res.status(code === 'BUSY' ? 409 : code === 'UNSUPPORTED' ? 422 : 500).json({ ok: false, code, error: String(error?.message || error) });
    }
    if (!stream) stream = openNdjsonStream(res);
    stream.onAbort(() => started.unsubscribe());
  });

  return router;
}

/**
 * /api/cli/git-bash: the Git Bash every Claude Code SynaBun starts gets on Windows (lib/git-bash/manager.js),
 * beside the CLIs' install and PATH, with the same guards.
 *
 *   GET  /           { ok, state: unsupported | system | ready | missing | downloading | failed, … }
 *   POST /install    start the download of SynaBun's copy now (Settings: Download, Try again); answers at once,
 *                    the page follows it with GET. 422 UNSUPPORTED where there is no Windows Git to fetch
 *   POST /recheck    look again (a Git for Windows installed meanwhile), then the status
 *
 * A request names nothing: what is downloaded is the pinned release (lib/git-bash/pins.json), and a body is refused.
 */
export function createGitBashApi({ manager, onRecheck = async () => {}, isGuestRequest, port } = {}) {
  if (!manager) throw new Error('createGitBashApi needs the Git Bash manager');
  const { router, mutating } = localCliRouter({ isGuestRequest, port });
  const noBody = (req, res, next) => (Object.keys(req.body || {}).length ? res.status(400).json({ ok: false, code: 'UNEXPECTED_BODY' }) : next());
  router.get('/', (req, res) => { res.json({ ok: true, ...manager.status() }); });
  router.post('/install', ...mutating, noBody, (req, res) => {
    const before = manager.status();
    if (before.state === 'unsupported') return res.status(422).json({ ok: false, code: 'UNSUPPORTED', ...before });
    manager.ensure({ reason: 'settings' });
    res.json({ ok: true, ...manager.status() });
  });
  router.post('/recheck', ...mutating, noBody, async (req, res) => {
    manager.refresh();
    try { await onRecheck(); } catch { /* the status says what is known */ }
    res.json({ ok: true, ...manager.status() });
  });
  return router;
}

/** The same owner/localhost/Origin/UI guards as Install. Never accepts a folder. */
export function createCliPathApi({ pathManager, resolver, diagnostics = async () => ({}), isGuestRequest, port } = {}) {
  const { router, mutating } = localCliRouter({ isGuestRequest, port });
  router.get('/', async (req, res) => {
    try { res.json({ ok: true, ...await diagnostics() }); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  router.post('/:tool', ...mutating, async (req, res) => {
    if (!INSTALLABLE_TOOLS.includes(req.params.tool)) return res.status(400).json({ ok: false, code: 'UNKNOWN_TOOL' });
    if (Object.keys(req.body || {}).length) return res.status(400).json({ ok: false, code: 'UNEXPECTED_BODY' });
    try {
      const status = await resolver.resolve(req.params.tool, { force: true });
      const result = await pathManager.add(status);
      if (!result.changed) return res.status(409).json({ ok: false, code: 'NOT_NEEDED', ...result });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(error.status || 500).json({ ok: false, error: error.message }); }
  });
  return router;
}
