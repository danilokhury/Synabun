// One countdown owner per mounted conversation. Transcript replay and run-card
// refreshes update keyed records; they never allocate their own waiting cards.
import { createLimitWait } from './asst-limit-wait.js';

export function createLimitDock(transcript, { t, createWait = createLimitWait, createElement = () => document.createElement('div') } = {}) {
  const host = createElement();
  host.className = 'asst-limit-dock';
  host.hidden = true;
  transcript.after(host);
  const entries = new Map();
  let active = null;
  let wait = null;
  let provider = null;
  let destroyed = false;
  function render() {
    const next = [...entries.entries()].sort((a, b) => (b[1].since || 0) - (a[1].since || 0))[0];
    const key = next?.[0] || null;
    if (key !== active || next?.[1].provider !== provider) {
      wait?.destroy();
      host.replaceChildren();
      active = key;
      provider = next?.[1].provider;
      wait = next ? createWait({ t, ...next[1], onRetry: next[1].onRetry ? () => entries.get(key)?.onRetry?.() : null }) : null;
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
    clear() { if (destroyed) return; entries.clear(); render(); },
    destroy() { destroyed = true; entries.clear(); wait?.destroy(); wait = null; active = null; host.remove(); },
  };
}
