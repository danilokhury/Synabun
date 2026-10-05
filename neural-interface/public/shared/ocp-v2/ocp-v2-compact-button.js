// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Compact (the button is in the Context settings popover)
// Calls the proper SDK route via api.compact → server WS session:compact →
// opencodeV2Client.session.compact (which prefers client.v2.session.compact and
// falls back to client.session.compact / client.session.summarize).
// This is the control without its button: ocp-v2-context-menu.js draws it from
// view() and starts it with run(). Not available without a session, while a
// turn is running, or while a compact request is already in flight. The
// server's session.idle + message events repaint state automatically — no
// local message juggling required.
// ─────────────────────────────────────────────────────────────────────────────

import { api } from './ocp-v2-ws.js';
import { getDefaultStore } from './ocp-v2-state.js';
import { captureBinding, onRebind } from './ocp-v2-binding.js';

export function createCompactControl(store = getDefaultStore()) {
  let compacting = false;
  let destroyed = false;
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) { try { fn(); } catch { /* listener's problem */ } } };

  /** What the button shows: read again on every render. */
  function view() {
    const s = store.getState();
    return { hasSession: !!s.sessionId, running: !!s.running, compacting };
  }

  async function run() {
    if (destroyed || compacting) return;
    const s = store.getState();
    if (!s.sessionId || s.running) return;
    // The session being compacted. `s` is the live state and is only read
    // here, before the request; the busy state and a failure are that
    // session's, and are neither shown in nor cleared for another one.
    const at = captureBinding(store);
    compacting = true;
    changed();
    try {
      const res = await api.compact({
        sessionId: at.sessionId,
        cwd: s.cwd || undefined,
        mcpProfile: s.mcpProfile || undefined,
        // OpenCode 1.18 compacts through session.summarize, which needs a model.
        model: s.model || undefined,
      });
      if (at.isCurrent() && (res?.error || res?.ok === false)) {
        const msg = res?.error || res?.data?.error || 'Compact failed';
        store.pushError?.({ message: msg });
      }
    } catch (err) {
      if (at.isCurrent()) store.pushError?.({ message: err?.message || 'Compact failed' });
    } finally {
      if (at.isCurrent()) {
        compacting = false;
        changed();
      }
    }
  }

  // Another session is on screen: "Compacting…" was the previous one's.
  const unsubscribeRebind = onRebind(store, () => { compacting = false; changed(); });

  return {
    view,
    run,
    /** Calls `fn` when the busy state changes. Returns the unsubscribe. */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() {
      destroyed = true;
      listeners.clear();
      try { unsubscribeRebind(); } catch {}
    },
  };
}
