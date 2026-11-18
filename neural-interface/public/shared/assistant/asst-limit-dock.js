// One countdown owner per mounted conversation. Transcript replay and run-card
// refreshes update keyed records; they never allocate their own waiting cards.
//
// Every card it shows can be dismissed (the card's ×, Esc inside it): the
// entry stays registered, since a run card re-registers its limit on every
// refresh and a reattach reports the brain's again, but the dismissal
// (asst-limit-dismissals.js: this conversation, the entry, its reset time)
// keeps that episode's card hidden. The next newest entry that is not
// dismissed takes the dock; a new episode (a later reset, another run) shows.
import { createLimitWait } from './asst-limit-wait.js';
import { createLimitDismissals } from './asst-limit-dismissals.js';

export function createLimitDock(transcript, {
  t,
  createWait = createLimitWait,
  createElement = () => document.createElement('div'),
  // The conversation the dismissals belong to (its session id); '' keeps them to this dock's page.
  scope = () => '',
  dismissals = createLimitDismissals(),
} = {}) {
  const host = createElement();
  host.className = 'asst-limit-dock';
  host.hidden = true;
  transcript.after(host);
  const entries = new Map();
  let active = null;
  let wait = null;
  let provider = null;
  let destroyed = false;
  const scopeId = () => { try { return String(scope() || ''); } catch { return ''; } };
  const hidden = (key, info) => { try { return !!dismissals.hides(scopeId(), key, info?.resetsAt ?? null); } catch { return false; } };

  function dismiss(key) {
    if (destroyed) return;
    const info = entries.get(key);
    if (!info) return;
    try { dismissals.dismiss(scopeId(), key, info.resetsAt ?? null); } catch { /* hidden for this render at least */ }
    // The host's own close (the brain's drops its entry); the dock's render below hides the rest.
    try { info.onClose?.(); } catch { /* the host reports its own failure */ }
    render();
  }

  function render() {
    const next = [...entries.entries()]
      .filter(([key, info]) => !hidden(key, info))
      .sort((a, b) => (b[1].since || 0) - (a[1].since || 0))[0];
    const key = next?.[0] || null;
    if (key !== active || next?.[1].provider !== provider) {
      wait?.destroy();
      host.replaceChildren();
      active = key;
      provider = next?.[1].provider;
      wait = next ? createWait({
        t, ...next[1],
        onRetry: next[1].onRetry ? () => entries.get(key)?.onRetry?.() : null,
        onSwitchProvider: next[1].onSwitchProvider ? (anchor) => entries.get(key)?.onSwitchProvider?.(anchor) : null,
        onClose: () => dismiss(key),
      }) : null;
      if (wait) host.appendChild(wait.el);
    } else if (wait) wait.update({ resetsAt: next[1].resetsAt });
    host.hidden = !wait;
    return wait;
  }
  return {
    el: host,
    set(key, info) {
      if (destroyed) return null;
      if (info) entries.set(key, { ...info, since: entries.get(key)?.since || info.since });
      else entries.delete(key);
      return render();
    },
    /** Hide `key`'s card for its current limit episode (what the card's × does). */
    dismiss,
    /** Whether `key` is registered but dismissed for its episode (tests, diagnostics). */
    isDismissed(key) { const info = entries.get(key); return !!info && hidden(key, info); },
    clear() { if (destroyed) return; entries.clear(); render(); },
    destroy() { destroyed = true; entries.clear(); wait?.destroy(); wait = null; active = null; host.remove(); },
  };
}
