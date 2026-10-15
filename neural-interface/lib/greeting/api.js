// ═══════════════════════════════════════════
// SynaBun — Greeting: the HTTP surface (/api/greeting)
// ═══════════════════════════════════════════
//
//   GET  /            the setting, what the engine can do, the last greeting shown
//   PUT  /            { enabled }                              the one switch
//   POST /open        { surface, cwd?, project?, session?, note? }   a fresh interactive session opened
//   POST /preview     { project?, cwd?, write? }               what a new session would be greeted with now
//   POST /rearm       { project?, cwd? }                       greet the next session there once (first live look)
//
// Mounted synchronously, before the engine exists: until then, and when it did
// not start, every route answers 503 with the reason, so Settings can tell an
// engine that failed from a server that is older than the page (404). A
// greeting is about the owner's own work: invite guests get 403.

import { Router, json } from 'express';
import { ID_RE, SURFACES } from './budgets.js';

const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);

export function createGreetingApi({ getEngine = () => null, getError = () => null, isGuestRequest = () => false, defaultProject = () => 'global', log = () => {} } = {}) {
  const router = Router();
  router.use(json({ limit: '32kb' }));
  router.use((req, res, next) => {
    let guest = false;
    try { guest = !!isGuestRequest(req); } catch { guest = true; }
    if (guest) return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Not available to guests' });
    const engine = getEngine();
    if (!engine) {
      let reason = null;
      try { reason = getError(); } catch { reason = null; }
      return res.status(503).json({ ok: false, code: 'GREETING_UNAVAILABLE', error: 'The greeting engine is not running', reason: reason || 'starting' });
    }
    req.greeting = engine;
    next();
  });
  const place = (body = {}) => {
    const project = text(body.project, 120);
    const cwd = text(body.cwd, 2048);
    if (project && /^[A-Za-z0-9_.-]+$/.test(project)) return { project };
    if (cwd) return { cwd };
    return {};
  };
  const fail = (res, error) => {
    log('greeting:api-error', error?.message || String(error));
    res.status(500).json({ ok: false, error: String(error?.message || error).slice(0, 200) });
  };

  router.get('/', (req, res) => {
    try { res.json({ ok: true, ...req.greeting.status() }); } catch (error) { fail(res, error); }
  });

  router.put('/', (req, res) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'enabled must be true or false' });
      req.greeting.setEnabled(req.body.enabled);
      res.json({ ok: true, ...req.greeting.status() });
    } catch (error) { fail(res, error); }
  });

  router.post('/open', async (req, res) => {
    try {
      const body = req.body || {};
      const surface = text(body.surface, 40);
      if (!surface || !Object.prototype.hasOwnProperty.call(SURFACES, surface)) return res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Unknown surface' });
      const session = text(body.session, 160);
      const answer = await req.greeting.open({ surface, ...place(body), session: session && ID_RE.test(session) ? session : null, note: body.note === true });
      res.json({ ok: true, ...answer });
    } catch (error) { fail(res, error); }
  });

  router.post('/preview', async (req, res) => {
    try {
      const where = place(req.body || {});
      if (!where.project && !where.cwd) { try { where.project = String(defaultProject() || 'global'); } catch { where.project = 'global'; } }
      res.json({ ok: true, preview: await req.greeting.preview({ ...where, write: req.body?.write === true }) });
    } catch (error) { fail(res, error); }
  });

  router.post('/rearm', (req, res) => {
    try {
      const where = place(req.body || {});
      if (!where.project && !where.cwd) { try { where.project = String(defaultProject() || 'global'); } catch { where.project = 'global'; } }
      res.json({ ok: true, project: req.greeting.rearm(where) });
    } catch (error) { fail(res, error); }
  });

  return router;
}
