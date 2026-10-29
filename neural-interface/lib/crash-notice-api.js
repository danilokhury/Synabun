// ═══════════════════════════════════════════
// SynaBun — /api/system/crash-notice: the notice after an automatic restart
// ═══════════════════════════════════════════
//
//   GET  /api/system/crash-notice           { ok, notice }   null, or the crash the supervisor recovered from
//   POST /api/system/crash-notice/dismiss   { id }           { ok, notice }: what is left (a newer crash's, or null)
//
// When the server crashes after it was up, its supervisor (lib/server-supervisor.js at the package root) starts
// it again and leaves DATA_HOME/data/server-crash.json (lib/server-crash-record.js) for it. The owner's pages ask
// for it when they load and every time their sync socket connects (a page that was open through the crash
// reconnects, it is not reloaded: public/shared/ui-crash-notice.js), and show it until the owner dismisses it. A
// dismissal removes the record, and every open tab and window drops the notice at once (`crash-notice:changed`
// on the sync socket); none shows it again after a reload. The next crash writes a new record, with a new id,
// which shows again. A record that cannot be removed (a read-only data folder) is kept dismissed in memory for
// the life of this server.
//
// The owner's only: /api/system is admin-only (lib/request-gate.js), and every route takes the owner's guard by
// itself (lib/http-guards.js ownerRouteGuard: this server's Host, its Origin on the write, no guest, no cross-site
// write) and refuses an agent's request (uiOnly: X-SynaBun-Terminal, -Role, -Assistant, -Desktop-Grant, as
// /api/system/app does). The dismissal is the owner's write from SynaBun's own page: X-SynaBun-UI: 1, a JSON body,
// and this boot's page secret (lib/page-session.js, as Skills Studio's owner writes), which a local process that
// merely leaves the agent headers out lacks; a tab that stayed open through the restart carries the previous boot's
// cookie, and the page's own recovery (public/shared/page-session.js) gets this boot's and sends the dismissal once
// more. A request names an id, never a path.

import { Router } from 'express';
import { clearCrashRecord, readCrashRecord } from '../../lib/server-crash-record.js';
import { sendGuardError, uiOnly } from './http-guards.js';

const ID = /^[0-9a-f]{16}$/;

/** What a page is shown of a record (already checked field by field when it was read), or null. */
export function crashNoticeOf(record) {
  if (!record || typeof record !== 'object') return null;
  const { v, ...notice } = record;
  return notice;
}

/**
 * @param {object} deps
 * @param {string} deps.dataHome
 * @param {import('express').RequestHandler} deps.guard   the owner's guard (lib/http-guards.js ownerRouteGuard)
 * @param {{ verify(req): boolean, require: import('express').RequestHandler }} [deps.pageSession]  lib/page-session.js:
 *   the page secret a dismissal carries (server.js hands it in; without one, as in a unit test, none is asked)
 * @param {(message: object) => void} [deps.broadcast]     the owner's open pages (server.js broadcastSync keeps
 *   `crash-notice:` from invite guests)
 * @param {() => Promise<{ tunnel?: 'unknown' }>} [deps.leftovers]  what the crashed server may have left running that
 *   this one could not end (server.js: its cloudflared, sweepLeftoverTunnels): added to the notice
 */
export function createCrashNoticeApi({
  dataHome, guard, pageSession = null, broadcast = () => {}, log = () => {}, read = readCrashRecord, clear = clearCrashRecord,
  leftovers = async () => ({}),
} = {}) {
  if (!dataHome || typeof guard !== 'function') throw new Error('createCrashNoticeApi needs the data home and the owner\'s guard');
  const router = Router();
  // Dismissed while the record could not be removed: never shown again by this server.
  const dismissed = new Set();
  const current = () => {
    const notice = crashNoticeOf(read(dataHome));
    return notice && !dismissed.has(notice.id) ? notice : null;
  };
  // The notice as a page is shown it: the record, and what the crashed server may have left open.
  const shown = async (notice) => {
    if (!notice) return null;
    let left = {};
    try { left = await leftovers(); } catch { left = {}; }
    return { ...notice, ...(left?.tunnel === 'unknown' ? { tunnel: 'unknown' } : {}) };
  };

  router.use(guard, uiOnly, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/', async (req, res) => { res.json({ ok: true, notice: await shown(current()) }); });

  router.post('/dismiss', (req, res, next) => {
    if (req.get('x-synabun-ui') !== '1') return sendGuardError(res, 403, 'UI_HEADER_REQUIRED', 'A notice is dismissed from SynaBun\'s own page.');
    // The page secret: what a local process that merely sends the page's headers lacks.
    if (pageSession && !pageSession.verify(req)) return pageSession.require(req, res, next);
    next();
  }, async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ ok: false, code: 'JSON_REQUIRED', error: 'Send JSON.' });
    const id = req.body?.id;
    if (typeof id !== 'string' || !ID.test(id)) return res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Send { id } of the notice.' });
    if (!clear(dataHome, { id })) {
      const still = crashNoticeOf(read(dataHome));
      if (still?.id === id) {
        dismissed.add(id);
        log(`[crash-notice] the record could not be removed; ${id} stays dismissed until the server restarts`);
      }
    } else {
      log(`[crash-notice] dismissed ${id}`);
    }
    const notice = await shown(current());
    try { broadcast({ type: 'crash-notice:changed', notice }); } catch {}
    res.json({ ok: true, notice });
  });

  return router;
}
