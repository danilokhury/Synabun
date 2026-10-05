// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Auto-accept switch (a row of the Context settings popover)
// Answers this session's permission requests "once" without asking. Off by
// default, per session, never persisted: the flag lives in the panel store and
// resets when the panel binds another session. `doom_loop` requests still ask.
// The logic is in ocp-v2-approvals.js; this is the switch without its button:
// ocp-v2-context-menu.js draws it from the store's `autoAccept`.
// ─────────────────────────────────────────────────────────────────────────────

import { api, isDescendantSession } from './ocp-v2-ws.js';
import { getDefaultStore } from './ocp-v2-state.js';
import { setAutoAccept } from './ocp-v2-approvals.js';
import { captureBinding } from './ocp-v2-binding.js';

export function createAutoAcceptControl(store = getDefaultStore()) {
  async function toggle() {
    const s = store.getState();
    if (!s.sessionId) return;
    // The switch is flipped for the session on screen, at once; what is
    // awaited are the replies to what was already waiting (each checks the
    // binding itself, see autoAcceptRequest). A failure is this session's.
    const at = captureBinding(store);
    try {
      await setAutoAccept(store, api, !s.autoAccept, {
        cwd: s.cwd || s.sessionInfo?.directory || undefined,
        // Only this session's requests and its sub-agents' are answered.
        isDescendant: isDescendantSession,
      });
    } catch (err) {
      if (at.isCurrent()) store.pushError?.({ message: err?.message || 'Auto-accept failed' });
    }
  }

  return { toggle };
}
