// ═══════════════════════════════════════════
// SynaBun Assistant — hosts (terminal tab + sidepanel)
// ═══════════════════════════════════════════
// One Assistant component (asst-panel.js mountAssistant) is mounted by two
// hosts: the terminal tab (ui-terminal.js) and the sidepanel
// (asst-sidepanel.js). Each host keeps its own window chrome; this module owns
// what they share, so they cannot drift apart:
//   - server create/resume (once, here)
//   - one session lives in one host (resume/focus goes to where it is open)
//   - the last-used session (Apps → Assistant, `a`, Ctrl+A)
//   - the guest gate
// DOM-free on purpose: node:test suites import it. The app wiring with real
// dependencies lives in ../ui-assistant.js.
//
// Adapter contract (registered by each host):
//   { id,
//     has(sessionId) → bool,
//     sessions() → sessionId[]            (preferred first: the active tab)
//     focus(sessionId, { prompt })        (show + focus; send prompt if given)
//     mount({ sessionId, meta, brain, label, floating, prompt, reattach })
//     close(sessionId, { closeServer })
//     toggle(sessionId|null)              (hide if visible, else show/focus)
//     toast?(text) }                      (errors shown in the host; else deps.toast)

import { normalizeBrain } from './asst-state.js';

export const ASSISTANT_CLOSED_STATUSES = new Set(['closed', 'ended', 'deleted', 'archived', 'destroyed']);
export const ASSISTANT_GONE_STATUSES = new Set(['deleted', 'destroyed']);

/** A session still open on the server (not closed, ended, deleted…): boot restores saved tabs only to these. */
export function isAssistantSessionLive(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.closedAt || meta.endedAt || meta.deletedAt) return false;
  return !ASSISTANT_CLOSED_STATUSES.has(String(meta.status || '').toLowerCase());
}

/**
 * A session the user can reopen (Sessions menu, /resume, a notification): any
 * record the server still has, an ended one included — attaching revives it on
 * its own brain, which resumes the stored Claude session / Codex thread.
 */
export function isAssistantSessionRestorable(meta) {
  if (!meta || typeof meta !== 'object' || meta.deletedAt) return false;
  return !ASSISTANT_GONE_STATUSES.has(String(meta.status || '').toLowerCase());
}

/** English note for a session the server started on another model (session.fallback). */
export function describeBrainFallback(fallback) {
  if (!fallback || typeof fallback !== 'object') return '';
  const to = fallback.label || fallback.to || 'another model';
  return fallback.reason === 'provider'
    ? `Every ${fallback.fromProvider || fallback.from} model is disabled in the Assistant's Models list — started on ${to}.`
    : `${fallback.from} is disabled in the Assistant's Models list — started on ${to}.`;
}

/**
 * deps: { api: { list(), get(id), create({brain,label,fallback}) },
 *         isBlocked() → bool, toast(text), storedBrain() → brain|null,
 *         fallbackText(session.fallback) → text, defaultHost: 'terminal' }
 */
export function createAssistantHosts({
  api,
  isBlocked = () => false,
  toast = () => {},
  storedBrain = () => null,
  fallbackText = describeBrainFallback,
  defaultHost = 'terminal',
} = {}) {
  const adapters = new Map(); // id → adapter; registration order breaks ties
  let last = null;            // { hostId, sessionId } — the last-used session

  function register(adapter) {
    if (!adapter?.id) throw new Error('Assistant host adapter needs an id');
    adapters.set(adapter.id, adapter);
    return () => {
      if (adapters.get(adapter.id) !== adapter) return;
      adapters.delete(adapter.id);
      if (last?.hostId === adapter.id) last = null;
    };
  }

  function ownerOf(sessionId) {
    if (!sessionId) return null;
    for (const adapter of adapters.values()) {
      try { if (adapter.has(sessionId)) return adapter.id; } catch { /* a broken host owns nothing */ }
    }
    return null;
  }

  function sessionsOf(hostId) {
    try { return (adapters.get(hostId)?.sessions?.() || []).filter(Boolean); } catch { return []; }
  }

  function noteFocus(sessionId, hostId) {
    if (sessionId && hostId && adapters.has(hostId)) last = { hostId, sessionId };
  }

  /** The requested host, else the default, else whichever registered first. */
  function hostFor(hostId) {
    return adapters.get(hostId) || adapters.get(defaultHost) || adapters.values().next().value || null;
  }

  function focusIn(hostId, sessionId, prompt = '') {
    const adapter = adapters.get(hostId);
    if (!adapter) return null;
    adapter.focus(sessionId, { prompt: prompt || '' });
    noteFocus(sessionId, hostId);
    return { host: hostId, sessionId, focused: true };
  }

  /** Map(id → session) of the sessions still open on the server (boot's saved-tab restore). */
  async function fetchLive() {
    try {
      const list = await api.list();
      return new Map((Array.isArray(list) ? list : [])
        .filter(s => s?.id && isAssistantSessionLive(s))
        .map(s => [s.id, s]));
    } catch { return new Map(); }
  }

  /**
   * Open a session in a host. `resume` names an existing session: if a host
   * already has it, it is focused there; an ended one is reopened as it was;
   * only one the server no longer has is replaced by a fresh one. Ownership is
   * re-checked after every await, so a session mounted meanwhile by the other
   * host is focused, never doubled.
   */
  async function open({ host = null, brain = null, resume = null, label = '', floating = false, prompt = '' } = {}) {
    if (isBlocked()) return null;
    let sessionId = resume ? String(resume) : null;
    let meta = null;
    if (sessionId) {
      const owner = ownerOf(sessionId);
      if (owner) return focusIn(owner, sessionId, prompt);
      try {
        const data = await api.get(sessionId);
        meta = data?.session || data;
        if (!isAssistantSessionRestorable(meta)) { meta = null; sessionId = null; }
      } catch { meta = null; sessionId = null; }
      const owned = ownerOf(sessionId);
      if (owned) return focusIn(owned, sessionId, prompt);
    }
    const target = hostFor(host);
    const say = (text) => { if (target?.toast) target.toast(text); else toast(text); };
    if (!target) { toast('Assistant unavailable'); return null; }
    if (!sessionId) {
      const b = normalizeBrain(brain || storedBrain());
      let res;
      try {
        // A model disabled since it was picked (Assistant → Models) must not
        // lock the Assistant out: the server starts on its enabled stand-in.
        res = await api.create({ brain: b, label: label || undefined, fallback: true });
      } catch (err) {
        say(`Assistant unavailable: ${err?.message || err}`);
        return null;
      }
      meta = res?.session || res;
      sessionId = meta?.id || res?.sessionId || res?.id || null;
      if (!sessionId) { say('Assistant session could not be created'); return null; }
      if (!meta?.brain) meta = { ...(meta || {}), brain: b };
      if (meta?.fallback) say(fallbackText(meta.fallback) || describeBrainFallback(meta.fallback));
    }
    const owner = ownerOf(sessionId);
    if (owner) return focusIn(owner, sessionId, prompt);
    const adapter = hostFor(host);
    if (!adapter) { say('Assistant unavailable'); return null; }
    adapter.mount({
      sessionId,
      meta,
      // A substituted model is what the tab shows (and saves as the last used brain).
      brain: meta?.fallback ? meta.brain : (brain || meta?.brain || null),
      label: label || '',
      floating: floating === true,
      prompt: prompt || '',
      reattach: !!resume,
    });
    noteFocus(sessionId, adapter.id);
    return { host: adapter.id, sessionId, mounted: true };
  }

  /** The last-used live session, if its host still has it. */
  function lastOpen() {
    return last && ownerOf(last.sessionId) === last.hostId ? last : null;
  }

  /** Hosts in preference order: the requested one, the default, then the rest. */
  function hostOrder(preferred) {
    return [...new Set([preferred, defaultHost, ...adapters.keys()].filter(id => id && adapters.has(id)))];
  }

  /**
   * Apps → Assistant / `a`: focus an open session (the named one, else the
   * last used, else any), otherwise open a new one in the default host.
   */
  async function openOrFocus(opts = {}) {
    if (isBlocked()) return null;
    if (opts.sessionId) {
      const owner = ownerOf(opts.sessionId);
      if (owner) return focusIn(owner, opts.sessionId, opts.prompt);
    }
    if (!opts.fresh) {
      const recent = lastOpen();
      if (recent) return focusIn(recent.hostId, recent.sessionId, opts.prompt);
      for (const hostId of hostOrder(opts.host)) {
        const [sessionId] = sessionsOf(hostId);
        if (sessionId) return focusIn(hostId, sessionId, opts.prompt);
      }
    }
    return open({ ...opts, resume: null, host: opts.host || defaultHost });
  }

  /** Ctrl+A: hide or show the last-used session in its host; open one if none. */
  function toggle() {
    if (isBlocked()) return null;
    const recent = lastOpen();
    if (recent) {
      adapters.get(recent.hostId).toggle(recent.sessionId);
      return { host: recent.hostId, sessionId: recent.sessionId, toggled: true };
    }
    for (const hostId of hostOrder(null)) {
      const [sessionId] = sessionsOf(hostId);
      if (sessionId) {
        adapters.get(hostId).toggle(sessionId);
        return { host: hostId, sessionId, toggled: true };
      }
    }
    return open({ host: defaultHost });
  }

  /** Notification click: focus the session where it lives, or resume it. */
  async function show(sessionId, { host = null } = {}) {
    if (!sessionId) return openOrFocus({});
    if (isBlocked()) return null;
    const owner = ownerOf(sessionId);
    if (owner) return focusIn(owner, sessionId);
    return open({ resume: sessionId, host: host || lastOpen()?.hostId || defaultHost });
  }

  /** Another client ended the session: drop it where it is open, without re-closing it server-side. */
  function ended(sessionId) {
    const owner = ownerOf(sessionId);
    if (last?.sessionId === sessionId) last = null;
    if (!owner) return false;
    adapters.get(owner).close(sessionId, { closeServer: false });
    return true;
  }

  return {
    register,
    ownerOf,
    open,
    openOrFocus,
    toggle,
    show,
    ended,
    noteFocus,
    fetchLive,
    isLive: isAssistantSessionLive,
    lastUsed: () => lastOpen(),
    hosts: () => [...adapters.keys()],
  };
}
