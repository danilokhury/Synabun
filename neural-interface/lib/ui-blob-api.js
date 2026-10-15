// ── The UI blob store's routes ──
// Per-entry storage for the fat keys of the interface's state (rendered
// transcript snapshots, graph node positions, the code editor's copies of
// unsaved buffers): a write sends one entry, not the whole map.
//
//   GET    /api/ui-blobs/:ns        every entry of a namespace, { [id]: value }
//   GET    /api/ui-blobs/:ns/:id    one entry (404 when there is none)
//   PUT    /api/ui-blobs/:ns/:id    write one entry; ?maxEntries= / ?maxChars= evict the oldest → { ok, evicted }
//   POST   /api/ui-blobs/:ns/:id    the same (navigator.sendBeacon can only POST)
//   DELETE /api/ui-blobs/:ns/:id    → { ok }
//
// A namespace is one of a fixed list, by its exact name as the router decoded
// it. One of them may be the owner's alone (the editor's copies hold file
// content): for it the `ownerGuard` is asked on every route, so the refusal
// holds however the path was spelled.
//
// A write or a delete may carry `?rev=<n>&writer=<id>` (public/shared/blob-store.js).
// Of two requests of one page for one entry, the one with the higher number is
// what stays, whichever arrives first: the other answers { ok: true, stale: true }
// and changes nothing (lib/ui-blob-store.js createBlobOrder). Without the two
// fields, and from another page, a request is applied as it arrives. A number
// counts once the store has done what was asked, not before: a write or a
// delete that failed (500) is applied when the page sends it again.

import { Router } from 'express';
import { blobRevision, createBlobOrder } from './ui-blob-store.js';

/**
 * @param {object} deps
 * @param {Iterable<string>} deps.namespaces the namespaces there are
 * @param {{ getNamespace: Function, get: Function, put: Function, delete: Function, prune: Function }} deps.store
 *   lib/ui-blob-store.js: blobGetNamespace, blobGet, blobPut, blobDelete, blobPrune
 * @param {string} [deps.ownerNamespace] the namespace only the owner reaches
 * @param {{ refusal: (req: object) => ({ status: number, code: string, error: string } | null) }} [deps.ownerGuard]
 *   lib/http-guards.js ownerRouteGuard
 * @param {{ stale: Function, applied: Function }} [deps.order] which request of a page is the newer
 *   (createBlobOrder). The store's `put` and `delete` are synchronous: nothing comes between the question
 *   (`stale`), the store's work and its record (`applied`).
 */
export function createUiBlobRouter({ namespaces, store, ownerNamespace = null, ownerGuard = null, order = createBlobOrder() } = {}) {
  if (!store) throw new Error('createUiBlobRouter requires a store');
  const known = new Set(namespaces || []);
  const router = Router();

  function namespaceOf(req, res) {
    const ns = req.params.ns;
    if (!known.has(ns)) { res.status(400).json({ error: `unknown namespace: ${ns}` }); return null; }
    // The namespace as Express decoded it: the editor's copies of unsaved buffers hold file content.
    if (ownerNamespace && ns === ownerNamespace && ownerGuard) {
      const refused = ownerGuard.refusal(req);
      if (refused) { res.status(refused.status).json({ ok: false, code: refused.code, error: refused.error }); return null; }
    }
    return ns;
  }

  router.get('/api/ui-blobs/:ns', (req, res) => {
    const ns = namespaceOf(req, res);
    if (!ns) return;
    try { res.json(store.getNamespace(ns)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/api/ui-blobs/:ns/:id', (req, res) => {
    const ns = namespaceOf(req, res);
    if (!ns) return;
    try {
      const value = store.get(ns, req.params.id);
      if (value === null) return res.status(404).json({ error: 'not found' });
      res.json(value);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  function write(req, res) {
    const ns = namespaceOf(req, res);
    if (!ns) return;
    try {
      const revision = blobRevision(req.query);
      // Older than what this page already had applied to the entry (a write that arrives after its own delete,
      // or after a newer write): it changes nothing.
      if (order.stale(ns, req.params.id, revision)) return res.json({ ok: true, evicted: [], stale: true });
      store.put(ns, req.params.id, req.body);
      // Counted now that it is stored, and not before: a write the store refused is sent again with its number.
      order.applied(ns, req.params.id, revision);
      const maxEntries = parseInt(req.query.maxEntries, 10) || 0;
      const maxChars = parseInt(req.query.maxChars, 10) || 0;
      let evicted = [];
      if (maxEntries || maxChars) evicted = store.prune(ns, { maxEntries, maxTotalChars: maxChars });
      res.json({ ok: true, evicted });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
  router.put('/api/ui-blobs/:ns/:id', write);
  // POST alias — sendBeacon can only POST
  router.post('/api/ui-blobs/:ns/:id', write);

  router.delete('/api/ui-blobs/:ns/:id', (req, res) => {
    const ns = namespaceOf(req, res);
    if (!ns) return;
    try {
      const revision = blobRevision(req.query);
      if (order.stale(ns, req.params.id, revision)) return res.json({ ok: true, stale: true });
      store.delete(ns, req.params.id);
      order.applied(ns, req.params.id, revision);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
