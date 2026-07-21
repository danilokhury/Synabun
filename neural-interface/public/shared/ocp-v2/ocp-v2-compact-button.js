// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Compact button (mounts inside the contextbar, next to gauge)
// Calls the proper SDK route via api.compact → server WS session:compact →
// opencodeV2Client.session.compact (which prefers client.v2.session.compact and
// falls back to client.session.compact / client.session.summarize).
// Disabled when there's no session, a turn is running, or a compact request is
// already in flight. The server's session.idle + message events repaint state
// automatically — no local message juggling required.
// ─────────────────────────────────────────────────────────────────────────────

import { api } from './ocp-v2-ws.js';
import { getDefaultStore } from './ocp-v2-state.js';

const ICON_COMPACT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/><path d="M9 12h6"/></svg>';

export function mountCompactButton(rootEl, store = getDefaultStore()) {
  if (!rootEl) return { element: null, destroy() {} };

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ocpv2-compact-btn';
  btn.setAttribute('data-tooltip', 'Compact context');
  btn.setAttribute('data-tooltip-pos', 'bottom');
  btn.innerHTML = `${ICON_COMPACT}<span class="ocpv2-compact-btn-label">compact</span>`;
  rootEl.appendChild(btn);

  let compacting = false;
  let destroyed = false;

  function sync() {
    if (destroyed) return;
    const s = store.getState();
    const hasSession = !!s.sessionId;
    const running = !!s.running;
    btn.disabled = !hasSession || running || compacting;
    btn.classList.toggle('ocpv2-compact-btn-busy', compacting);
    btn.setAttribute(
      'data-tooltip',
      compacting ? 'Compacting…'
        : !hasSession ? 'No active session'
        : running ? 'Wait for the current turn to finish'
        : 'Compact context',
    );
  }

  async function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (btn.disabled) return;
    const s = store.getState();
    if (!s.sessionId) return;
    compacting = true;
    sync();
    try {
      const res = await api.compact({
        sessionId: s.sessionId,
        cwd: s.cwd || undefined,
        mcpProfile: s.mcpProfile || undefined,
      });
      if (res?.error || res?.ok === false) {
        const msg = res?.error || res?.data?.error || 'Compact failed';
        store.pushError?.({ message: msg });
      }
    } catch (err) {
      store.pushError?.({ message: err?.message || 'Compact failed' });
    } finally {
      compacting = false;
      sync();
    }
  }

  btn.addEventListener('click', onClick);
  const unsubscribe = store.subscribe(() => sync());
  sync();

  return {
    element: btn,
    destroy() {
      destroyed = true;
      try { unsubscribe?.(); } catch {}
      btn.removeEventListener('click', onClick);
      btn.remove();
    },
  };
}
