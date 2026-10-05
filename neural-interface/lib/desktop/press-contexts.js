// ═══════════════════════════════════════════
// SynaBun — Desktop press contexts (press by intent, single use)
// ═══════════════════════════════════════════
//
// An intent snapshot taken with purpose "press" while press by intent is
// unlocked mints one context: the candidates of THAT snapshot that may be
// pressed, kept here and never sent anywhere. A press by intent can only name
// a candidate inside a context, so "this caller, this snapshot, at most once,
// within 30 s, nothing that was not pressable" are facts the Neural Interface
// holds, not promises the MCP layer makes (the browser's heal contexts in
// browser-semantic-context.js work the same way).
//
//   - one context per owner key: a newer one replaces the older
//   - consumed before it is validated: spent whether or not the press happens
//   - only `pressable` entries are stored, and only for a screen with no text
//     addressing the agent and no open sheet or dialog
//   - dropAll(reason) on user input, stops, session off, release, shutdown;
//     a dropped context answers with that reason once, then is forgotten

import { randomBytes } from 'node:crypto';

export const PRESS_CONTEXT_TTL_MS = 30_000;

/** Why a context was dropped, as consume reports it (PRESS_REFUSED reasons). */
export const DROP_REASONS = Object.freeze(['user_input', 'stopped']);

/**
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]       lifetime of a context
 * @param {() => number} [opts.now]
 * @param {number} [opts.maxEntries]  contexts kept at once (the oldest go first)
 * @param {(entry:object) => boolean} [opts.isPressable] which entries may be stored
 */
export function createPressContextStore({ ttlMs = PRESS_CONTEXT_TTL_MS, now = Date.now, maxEntries = 16, isPressable = (entry) => entry?.pressable === true } = {}) {
  const contexts = new Map(); // id → { owner, snapshotId, entries: Map(candidateId → entry), expiresAt }
  const owners = new Map();   // owner key → id
  const dropped = new Map();  // id → reason (tombstones, bounded)
  let lastDrop = null;

  function forget(id) {
    const ctx = contexts.get(id);
    if (!ctx) return null;
    contexts.delete(id);
    if (owners.get(ctx.owner) === id) owners.delete(ctx.owner);
    return ctx;
  }
  function tombstone(id, reason) {
    dropped.set(id, reason);
    while (dropped.size > maxEntries * 4) dropped.delete(dropped.keys().next().value);
  }

  /**
   * A new context for `key`, or null when nothing on this screen may be pressed.
   * `entries` is the snapshot's candidate list (objects with an `id`); only the
   * pressable ones are kept.
   */
  function mint({ key, snapshotId, entries, agentText = 0, dialogOpen = false } = {}) {
    if (typeof key !== 'string' || !key || typeof snapshotId !== 'string' || !snapshotId) return null;
    // A screen that talks to the agent, or shows a sheet / dialog, is never pressed by intent.
    if (Number(agentText) !== 0 || dialogOpen !== false) return null;
    const kept = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry && typeof entry.id === 'string' && isPressable(entry)) kept.set(entry.id, entry);
    }
    if (!kept.size) return null;
    const previous = owners.get(key);
    if (previous) forget(previous);
    const id = `pc_${randomBytes(12).toString('base64url')}`;
    contexts.set(id, { owner: key, snapshotId, entries: kept, expiresAt: now() + ttlMs });
    owners.set(key, id);
    while (contexts.size > maxEntries) forget(contexts.keys().next().value);
    return id;
  }

  /** Deletes first, then validates: a context is spent whether or not it was valid. */
  function consume({ contextId, candidateId, key } = {}) {
    if (typeof contextId !== 'string' || !contextId) return { error: 'malformed' };
    const ctx = forget(contextId);
    if (!ctx) {
      const reason = dropped.get(contextId);
      if (reason) { dropped.delete(contextId); return { error: reason }; }
      return { error: 'unknown_context' };
    }
    if (now() > ctx.expiresAt) return { error: 'expired_context' };
    if (ctx.owner !== key) return { error: 'foreign_context' };
    const entry = typeof candidateId === 'string' ? ctx.entries.get(candidateId) : undefined;
    if (!entry) return { error: 'unknown_candidate' };
    return { entry, snapshotId: ctx.snapshotId };
  }

  /** Drop every live context; a later consume of one of them answers `reason`. */
  function dropAll(reason = 'stopped') {
    const why = DROP_REASONS.includes(reason) ? reason : 'stopped';
    const ids = [...contexts.keys()];
    for (const id of ids) { forget(id); tombstone(id, why); }
    if (ids.length) lastDrop = { reason: why, count: ids.length, at: now() };
    return ids.length;
  }

  function clear() { contexts.clear(); owners.clear(); dropped.clear(); }

  return { mint, consume, dropAll, clear, size: () => contexts.size, lastDrop: () => lastDrop };
}
