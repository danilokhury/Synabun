// ═══════════════════════════════════════════
// SynaBun — Desktop REST API (/api/desktop/*)
// ═══════════════════════════════════════════
//
// UI routes (status, setup, stop, resume, frames, audit, config) serve the
// assistant panel; agent routes (act, apps, ax, agent-status) serve the MCP
// `computer` tools and require an X-Synabun-Desktop-Grant header. Guests and
// tunnel requests (cf-connecting-ip) never reach any of it, and UI-only
// routes refuse requests that carry agent headers — an agent cannot set
// itself up, resume after a stop, or change the guards.
// Mounted with `app.use('/api/desktop', createDesktopApi({ desktop, isGuestRequest }))`.

import { Router } from 'express';

function send(res, result, fallbackStatus = 200) {
  if (result?.forbidden) return res.status(403).json(result);
  return res.status(fallbackStatus).json(result);
}

export function createDesktopApi({ desktop, isGuestRequest = () => false, log = () => {} } = {}) {
  if (!desktop) throw new Error('createDesktopApi requires the desktop service');
  const router = Router();

  router.use((req, res, next) => {
    if (isGuestRequest(req)) return res.status(403).json({ ok: false, code: 'GUEST_FORBIDDEN', error: 'Computer use is available to the owner only' });
    if (req.get('cf-connecting-ip')) return res.status(403).json({ ok: false, code: 'REMOTE_FORBIDDEN', error: 'Computer use is local only' });
    next();
  });
  const hasAgentHeaders = (req) => !!(req.get('x-synabun-desktop-grant') || req.get('x-synabun-terminal') || req.get('x-synabun-role'));
  function uiOnly(req, res, next) {
    if (hasAgentHeaders(req)) return res.status(403).json({ ok: false, code: 'UI_ONLY', error: 'This desktop control is reserved for the user.' });
    next();
  }
  const grantOf = (req) => String(req.get('x-synabun-desktop-grant') || '').trim();
  function agentOnly(req, res, next) {
    if (!grantOf(req)) return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Missing X-Synabun-Desktop-Grant.' });
    next();
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  router.get('/status', (req, res) => { try { res.json(desktop.status()); } catch (error) { res.status(500).json({ ok: false, error: error?.message || String(error) }); } });
  router.post('/setup', uiOnly, async (req, res) => {
    try { res.json(await desktop.setup(String(req.body?.step || 'start'), { pane: req.body?.pane || null })); }
    catch (error) { res.status(error?.status || 500).json({ ok: false, code: error?.code || 'SETUP_ERROR', error: error?.message || String(error) }); }
  });
  // Stopping is always allowed (an agent may stop itself too); resuming is the user's call.
  router.post('/stop', async (req, res) => {
    try {
      const body = req.body || {};
      const result = await desktop.stop({ scope: body.scope || 'all', assistantSessionId: body.assistantSessionId || null, runId: body.runId || null, reason: body.reason || (hasAgentHeaders(req) ? 'agent' : 'user'), interrupt: body.interrupt !== false });
      res.json({ ok: true, stopped: result });
    } catch (error) { res.status(500).json({ ok: false, error: error?.message || String(error) }); }
  });
  router.post('/resume', uiOnly, (req, res) => { try { res.json(desktop.resume()); } catch (error) { res.status(500).json({ ok: false, error: error?.message || String(error) }); } });
  const serveFrame = (req, res) => {
    const frame = desktop.frame(req.params.id);
    if (!frame) return res.status(404).json({ ok: false, code: 'FRAME_NOT_FOUND', error: 'Frame expired' });
    res.set('Cache-Control', 'no-store');
    res.type(frame.mime || 'image/jpeg');
    res.send(frame.bytes);
  };
  router.get('/frames/:id.jpg', serveFrame);
  router.get('/frames/:id/thumb.jpg', serveFrame);
  router.get('/audit', uiOnly, (req, res) => {
    res.json({ ok: true, entries: desktop.recentAudit({ limit: Number(req.query.limit) || 50, assistantSessionId: req.query.session || null }) });
  });
  router.get('/config', uiOnly, (req, res) => res.json({ ok: true, config: desktop.config() }));
  router.put('/config', uiOnly, (req, res) => {
    try { res.json({ ok: true, config: desktop.updateConfig(req.body?.config || req.body || {}) }); }
    catch (error) { res.status(error?.status || 400).json({ ok: false, code: error?.code || 'CONFIG_INVALID', field: error?.field || null, error: error?.message || String(error) }); }
  });

  // ── agents (MCP computer tools) ────────────────────────────────────────────
  router.post('/act', agentOnly, async (req, res) => {
    try { send(res, await desktop.act(grantOf(req), req.body || {})); }
    catch (error) { log('desktop:act-error', error?.message || String(error)); res.status(500).json({ ok: false, code: 'INTERNAL', error: error?.message || String(error) }); }
  });
  router.post('/apps', agentOnly, async (req, res) => {
    try { send(res, await desktop.apps(grantOf(req), req.body || {})); }
    catch (error) { res.status(500).json({ ok: false, code: 'INTERNAL', error: error?.message || String(error) }); }
  });
  router.post('/ax', agentOnly, async (req, res) => {
    try { send(res, await desktop.ax(grantOf(req), req.body || {})); }
    catch (error) { res.status(500).json({ ok: false, code: 'INTERNAL', error: error?.message || String(error) }); }
  });
  router.post('/agent-status', agentOnly, async (req, res) => {
    try { send(res, await desktop.agentStatus(grantOf(req), req.body || {})); }
    catch (error) { res.status(500).json({ ok: false, code: 'INTERNAL', error: error?.message || String(error) }); }
  });

  return router;
}
