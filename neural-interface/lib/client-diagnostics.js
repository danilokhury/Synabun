import express from 'express';
import { DIAGNOSTIC_BATCH, validDiagnosticEntry } from '../public/shared/loading-diagnostic-entry.js';

// Leave this stream for its route's small parser behind the request/peer gates.
// Every other request uses the same application/json match as express.json().
export function useDefaultJsonParser(req) {
  if (req.method === 'POST' && /^\/api\/client-diagnostics\/?$/i.test(req.path)) return false;
  return req.is('application/json');
}

// Cap chunked bodies and whitespace too. Parser errors can contain the raw body.
const parse = express.json({ limit: 12 * 1024, inflate: false });
export function parseClientDiagnostics(req, res, next) {
  if (!req.is('application/json')) return res.sendStatus(415);
  parse(req, res, err => err ? res.sendStatus(err.status || 400) : next());
}

export function createClientDiagnostics({ ownerPage, refuseOwner, log = console.log, now = Date.now }) {
  const pages = new Map();
  let resetAt = 0;
  return (req, res) => {
    // Host has already passed the server's host gate. Compare the scheme and port too.
    if (req.headers.origin !== `${req.protocol}://${req.headers.host}`) return res.sendStatus(403);
    if (!ownerPage(req)) return refuseOwner(req, res, 'Client diagnostics require the owner’s page.');
    const batch = req.body;
    if (!Array.isArray(batch) || !batch.length || batch.length > DIAGNOSTIC_BATCH) return res.sendStatus(400);
    if (!batch.every(entry => validDiagnosticEntry(entry) && entry.pageId === batch[0].pageId)) return res.sendStatus(400);

    const time = now();
    if (time >= resetAt) { pages.clear(); resetAt = time + 60000; }
    const id = batch[0].pageId;
    const count = pages.get(id) || 0;
    // One page can drain the entire retained trail at once. Bound the accounting
    // itself as well, even if an owner client invents a fresh ID for every request.
    if (count + batch.length > 240 || (!count && pages.size >= 256)) return res.sendStatus(429);
    pages.set(id, count + batch.length);
    for (const { iso, pageId, event, currentBoot, visibility, data } of batch) {
      log(`[client-diag] ${iso} ${pageId} ${event} ${JSON.stringify({ currentBoot, visibility, ...data })}`);
    }
    res.status(204).end();
  };
}
