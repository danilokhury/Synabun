// ═══════════════════════════════════════════
// SynaBun — WhatsApp Link REST API (/api/whatsapp/*)
// ═══════════════════════════════════════════
//
// Every route answers the person at this computer only: no guests, no
// tunnel or proxy, a loopback socket and a localhost Host header
// (lib/http-guards.js), and nothing is cached. Every state-changing route
// also needs the page's own Origin, a JSON body and X-SynaBun-UI: 1, and
// refuses agent headers — an agent cannot link, unlink or raise the level.
// POST /pause is the exception: it only lowers privileges, so agents may
// call it (a JSON body is still required, which a cross-site page cannot
// send without a preflight).
//
// POST /link and POST /owner/claim answer with NDJSON streamed to the
// requesting tab alone (one JSON object per line); the QR, the pairing code
// and the claim code never travel anywhere else. The tab closing the
// response cancels what it started.
//
// Mounted with `app.use('/api/whatsapp', service.router)`; tests mount
// createWhatsAppApi({ service: fakeOps, port }) directly.

import { Router } from 'express';
import { AGENT_HEADERS, guestForbidden, noStore, requireJson, requireLocal, requireLocalHost, requireSameOriginJson, sendGuardError, uiOnly } from '../http-guards.js';

/** Open an NDJSON response. → { write(obj), end(obj?), onAbort(fn), closed } */
export function openNdjsonStream(res) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();
  res.on('error', () => {});
  let ended = false;
  const aborters = new Set();
  res.on('close', () => {
    if (ended) return;
    ended = true;
    for (const fn of aborters) { try { fn(); } catch {} }
  });
  const stream = {
    write(payload) {
      if (ended || res.writableEnded || res.destroyed) return false;
      try { res.write(`${JSON.stringify(payload)}\n`); return true; } catch { return false; }
    },
    end(payload) {
      if (ended) return;
      if (payload) stream.write(payload);
      ended = true;
      try { res.end(); } catch {}
    },
    onAbort(fn) { if (typeof fn === 'function') aborters.add(fn); },
    get closed() { return ended || res.destroyed; },
  };
  return stream;
}

function fail(res, error, log) {
  const status = Number(error?.status) || 500;
  const body = { ok: false, code: error?.code || (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'), error: error?.message || String(error) };
  if (error?.field) body.field = error.field;
  if (Number.isFinite(error?.retryAfterMs)) {
    body.retryAfterMs = Math.max(0, Math.round(error.retryAfterMs));
    res.set('Retry-After', String(Math.max(1, Math.ceil(body.retryAfterMs / 1000))));
  }
  if (Number.isFinite(error?.version)) body.version = error.version;
  if (status >= 500) log('whatsapp:api-error', body.error);
  res.status(status).json(body);
}

/**
 * @param {object} deps
 * @param {object} deps.service  the service's ops (status, setup, link, …) — see lib/whatsapp/service.js
 * @param {(req)=>boolean} [deps.isGuestRequest]
 * @param {number|(()=>number)} deps.port  the port the page is served from (Host/Origin checks)
 */
export function createWhatsAppApi({ service, isGuestRequest = () => false, port = 3344, log = () => {} } = {}) {
  if (!service) throw new Error('createWhatsAppApi requires the WhatsApp service');
  const router = Router();

  // The port is read per request, so a server (or a test) that learns it after listen() can pass a function.
  const portOf = () => (typeof port === 'function' ? port() : port);
  const built = new Map();
  const perPort = (name, factory) => (req, res, next) => {
    const key = `${name}:${portOf()}`;
    let guard = built.get(key);
    if (!guard) {
      try { guard = factory(portOf()); } catch { return sendGuardError(res, 500, 'BAD_PORT', 'The WhatsApp API has no valid port.'); }
      built.set(key, guard);
    }
    return guard(req, res, next);
  };

  router.use(noStore, guestForbidden(isGuestRequest), requireLocal, perPort('host', requireLocalHost));
  const mutating = [perPort('origin', requireSameOriginJson), uiOnly];

  const handle = (fn) => async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      fail(res, error, log);
    }
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const stream = (res) => () => openNdjsonStream(res);
  const byAgent = (req) => AGENT_HEADERS.some((name) => req.headers?.[name] !== undefined);

  // ── status & setup ─────────────────────────────────────────────────────────
  router.get('/status', handle(() => service.status()));
  router.post('/setup', ...mutating, handle((req) => service.setup(body(req))));

  // ── connector ──────────────────────────────────────────────────────────────
  router.post('/connector/install', ...mutating, handle((req) => service.installConnector(body(req))));
  router.delete('/connector/install', ...mutating, handle(() => service.cancelInstall()));
  router.delete('/connector', ...mutating, handle(() => service.removeConnector()));
  router.get('/connector/log', handle((req) => service.connectorLog({ limit: req.query.limit })));

  // ── linking and the owner (streams go to this tab only) ────────────────────
  router.post('/link', ...mutating, handle((req, res) => service.link(body(req), stream(res))));
  router.post('/owner/confirm', ...mutating, handle((req) => service.confirmOwner(body(req))));
  router.post('/owner/claim', ...mutating, handle((req, res) => service.claimOwner(body(req), stream(res))));
  router.delete('/owner', ...mutating, handle(() => service.resetOwner()));

  // ── controls ───────────────────────────────────────────────────────────────
  router.post('/test', ...mutating, handle(() => service.test()));
  // Pausing only lowers privileges: agents may do it (no Origin / UI header / agent-header checks).
  router.post('/pause', requireJson, handle((req) => service.pause({ by: byAgent(req) ? 'agent' : 'desktop' })));
  router.post('/resume', ...mutating, handle(() => service.resume()));
  router.post('/reconnect', ...mutating, handle(() => service.reconnect()));
  router.post('/unlink', ...mutating, handle(() => service.unlink()));
  router.post('/remove', ...mutating, handle((req) => service.remove(body(req))));

  // ── settings, activity, conversation ───────────────────────────────────────
  router.get('/config', handle(() => service.getConfig()));
  router.put('/config', ...mutating, handle((req) => service.putConfig(body(req))));
  router.get('/activity', handle((req) => service.listActivity({ limit: req.query.limit })));
  router.delete('/activity', ...mutating, handle(() => service.clearActivity()));
  router.post('/session/new', ...mutating, handle(() => service.newSession()));

  // ── fake transport (SYNABUN_WHATSAPP_FAKE=1 only; otherwise it does not exist) ──
  router.post('/__fake', (req, res, next) => (service.fakeEnabled?.() ? next() : sendGuardError(res, 404, 'NOT_FOUND', 'Not found')), ...mutating, handle((req) => service.fake(body(req))));

  router.use((req, res) => sendGuardError(res, 404, 'NOT_FOUND', 'Not found'));
  return router;
}
