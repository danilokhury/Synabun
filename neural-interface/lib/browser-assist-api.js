/**
 * Read-only browser-assist routes. Mounted under /api/browser after the
 * request middleware, so deadlines, cancellation and the `actionStarted`
 * stamp apply as they do to every other browser route. Nothing here marks an
 * action as started: a caller may retry these freely.
 *
 * A Router factory rather than routes in server.js, so the route tests can
 * mount the real thing beside their stubbed session map.
 */
import { Router } from 'express';
import { runBrowserRequest, measureBrowserPhase } from './browser-execution.js';
import { collectSemanticContext } from './browser-semantic-context.js';

const PURPOSES = new Set(['navigation', 'page-state', 'empty-extractor', 'social', 'batch']);

export function createBrowserAssistRouter({ browserSessions, getTargetPage, normalizeSelector = s => s }) {
  const router = Router();

  // POST /api/browser/sessions/:id/semantic-context  { tabId?, purpose?, scope?, social? }
  router.post('/sessions/:id/semantic-context', async (req, res) => {
    const session = browserSessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const routed = getTargetPage(session, req);
    if (!routed) return res.status(404).json({ error: `Tab ${req.body?.tabId} not found in session` });
    const { purpose, scope, social } = req.body || {};
    try {
      const context = await runBrowserRequest(req, () => measureBrowserPhase('semanticContext', () => collectSemanticContext(routed.page, {
        purpose: PURPOSES.has(purpose) ? purpose : 'page-state',
        scopeSel: typeof scope === 'string' && scope.trim() ? normalizeSelector(scope.trim()).slice(0, 300) : null,
        social: social === true,
      })), 4000);
      res.json({ ok: true, context });
    } catch (err) {
      // Static text: a collector error can quote page content.
      res.status(err?.code === 'BROWSER_REQUEST_CANCELLED' || err?.code === 'BROWSER_OPERATION_TIMEOUT' ? 408 : 500)
        .json({ error: 'Semantic context unavailable.', code: err?.code || 'SEMANTIC_CONTEXT_FAILED' });
    }
  });

  return router;
}
