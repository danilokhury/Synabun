// ═══════════════════════════════════════════
// SynaBun — Desktop frames (screenshots as evidence)
// ═══════════════════════════════════════════
//
// Every screenshot becomes a frame: a short-lived screenshot_id, the capture
// bounds (for coordinate mapping), the JPEG bytes (served to the UI by URL),
// and a sha256 (audit). Coordinate actions resolve against their owner's
// LATEST frame, which must be fresh: taken after the owner's last mutating
// action, within the TTL, and with no user input or display change since.
// Frames live in memory only (a bounded ring); nothing is written to disk.

import { createHash, randomBytes } from 'node:crypto';

export function createFrameStore({ now = Date.now, ttlMs = () => 120_000, memoryCount = () => 60, random = (n) => randomBytes(n).toString('hex') } = {}) {
  const frames = new Map();   // frameId → frame (insertion order = age)
  const latest = new Map();   // ownerKey → frameId (evidence frames only)
  const ttl = () => (typeof ttlMs === 'function' ? ttlMs() : ttlMs);
  const cap = () => Math.max(4, Number(typeof memoryCount === 'function' ? memoryCount() : memoryCount) || 60);

  function prune() {
    while (frames.size > cap()) {
      const oldest = frames.keys().next().value;
      frames.delete(oldest);
      for (const [owner, id] of latest) if (id === oldest) latest.delete(owner);
    }
  }

  /**
   * shot: helper screenshot result { displayId, bounds, image:{w,h,mime,data(base64)}, cursor, frontmost, capturedAt }
   * evidence:false for zoom captures (never used for coordinate mapping).
   */
  function add(ownerKeyValue, shot, { evidence = true, kind = 'screenshot' } = {}) {
    const bytes = Buffer.from(String(shot?.image?.data || ''), 'base64');
    const frame = {
      id: `f_${random(5)}`,
      screenshotId: `s_${random(6)}`,
      owner: ownerKeyValue,
      kind,
      displayId: shot?.displayId ?? null,
      bounds: shot?.bounds || null,
      image: { w: Number(shot?.image?.w) || 0, h: Number(shot?.image?.h) || 0, mime: shot?.image?.mime || 'image/jpeg' },
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      cursor: shot?.cursor || null,
      frontmost: shot?.frontmost || null,
      capturedAt: now(),
      stale: false,
      staleReason: null,
    };
    frames.set(frame.id, frame);
    if (evidence && ownerKeyValue) latest.set(ownerKeyValue, frame.id);
    prune();
    return frame;
  }
  function get(id) { return frames.get(String(id)) || null; }
  function latestFor(ownerKeyValue) { const id = latest.get(ownerKeyValue); return id ? frames.get(id) || null : null; }
  /** Mark evidence stale: one owner's (after its own mutating action) or everyone's ('*'). */
  function markStale(ownerKeyValue, reason) {
    for (const [owner, id] of latest) {
      if (ownerKeyValue !== '*' && owner !== ownerKeyValue) continue;
      const frame = frames.get(id);
      if (frame && !frame.stale) { frame.stale = true; frame.staleReason = reason; }
    }
  }
  /** → { ok:true, frame } | { ok:false, reason } */
  function fresh(ownerKeyValue, screenshotId = null) {
    const frame = latestFor(ownerKeyValue);
    if (!frame) return { ok: false, reason: 'no screenshot yet — take one first' };
    if (screenshotId && frame.screenshotId !== screenshotId) return { ok: false, reason: `screenshot ${screenshotId} is not your latest (${frame.screenshotId})` };
    if (frame.stale) return { ok: false, reason: `the screen may have changed (${frame.staleReason})` };
    if (now() - frame.capturedAt > ttl()) return { ok: false, reason: 'the latest screenshot is too old' };
    return { ok: true, frame };
  }
  function drop(ownerKeyValue) { latest.delete(ownerKeyValue); }
  function clear() { frames.clear(); latest.clear(); }
  return { add, get, latestFor, markStale, fresh, drop, clear, size: () => frames.size };
}
