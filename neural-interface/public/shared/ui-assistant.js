// ═══════════════════════════════════════════
// SynaBun Neural Interface — Assistant hosts (app wiring)
// ═══════════════════════════════════════════
// The Assistant component (assistant/asst-panel.js) is mounted by two hosts:
// the terminal tab (ui-terminal.js) and the sidepanel
// (assistant/asst-sidepanel.js). Both register an adapter here; the rules they
// share (create/resume, one session in one host, last used, guest gate) live
// in assistant/asst-hosts.js. This module never imports a host — hosts
// register themselves, so there is no import cycle through it.

import { on } from './state.js';
import { storage } from './storage.js';
import { t } from './i18n.js';
import { registerAction } from './ui-keybinds.js';
import { isGuest, hasPermission, showGuestToast } from './ui-sync.js';
import { createAssistantHosts, describeBrainFallback } from './assistant/asst-hosts.js';
import { createAssistantSession, getAssistantSession, listAssistantSessions, removeAssistantSession } from './assistant/asst-api.js';
import { providerShortLabel, readStoredBrain, tabStorageKey } from './assistant/asst-state.js';

/** Guests need the terminal permission for the Assistant, in either host. */
export function assistantBlocked() {
  return isGuest() && !hasPermission('terminal');
}

/** The note for a session the server started on another model than the one asked for. */
function brainFallbackText(fallback) {
  const key = fallback?.reason === 'provider' ? 'assistant.brain.providerFallback' : 'assistant.brain.modelFallback';
  const text = t(key, { from: fallback?.from || '', provider: providerShortLabel(fallback?.fromProvider), to: fallback?.label || fallback?.to || '' });
  return text && text !== key ? text : describeBrainFallback(fallback);
}

const hosts = createAssistantHosts({
  api: { list: listAssistantSessions, get: getAssistantSession, create: createAssistantSession, remove: removeAssistantSession },
  isBlocked: assistantBlocked,
  toast: (text) => showGuestToast(text),
  storedBrain: () => readStoredBrain(storage),
  fallbackText: brainFallbackText,
  defaultHost: 'terminal',
});

export const registerAssistantHost = (adapter) => hosts.register(adapter);
export const assistantOwnerOf = (sessionId) => hosts.ownerOf(sessionId);
export const fetchLiveAssistantSessions = () => hosts.fetchLive();
export const isAssistantSessionLive = (meta) => hosts.isLive(meta);
/** opts: { host, brain, resume, label, floating, prompt } */
export const openAssistant = (opts = {}) => hosts.open(opts);
export const noteAssistantFocus = (sessionId, hostId) => hosts.noteFocus(sessionId, hostId);

let _initialized = false;

/** A removed session's per-tab UI state (composer draft, dock, route mode): written by its tab as it closes, then dropped. */
function forgetTabState(sessionId) {
  try { storage.removeItem(tabStorageKey(sessionId)); } catch { /* storage unavailable */ }
}

/** Bus events + keybinds for both hosts. Idempotent: initNavbar and initTerminal both call it. */
export function initAssistant() {
  if (_initialized) return;
  _initialized = true;
  on('assistant:open', (data) => hosts.openOrFocus(data || {}));
  on('assistant:new', (data) => hosts.open({
    host: data?.host || null,
    brain: data?.brain,
    label: data?.label,
    floating: data?.floating,
    prompt: data?.prompt,
  }));
  // `replaces`: the session the user left by picking this one, when nobody chatted in it: it goes.
  on('assistant:resume', async (data) => {
    if (!data?.sessionId) return;
    const res = await hosts.open({ resume: data.sessionId, host: data?.host || null, floating: data?.floating });
    if (res && data.replaces && data.replaces !== data.sessionId) hosts.discard(data.replaces);
  });
  // Sessions menu → Remove. `done(result)` tells the menu that asked how it went.
  on('assistant:remove', (data) => {
    if (!data?.sessionId) return;
    hosts.remove(data.sessionId, { host: data.host || null, fresh: data.fresh === true, brain: data.brain || null })
      .then((result) => {
        if (result?.ok) forgetTabState(data.sessionId);
        try { data.done?.(result); } catch { /* the menu is gone */ }
      });
  });
  // A session the server no longer has: its tab closes (a fresh one in its place when it was showing unused).
  on('assistant:gone', (data) => {
    if (data?.sessionId) hosts.gone(data.sessionId, { host: data.host || null, fresh: data.fresh === true, brain: data.brain || null }).finally(() => forgetTabState(data.sessionId));
  });
  on('assistant:toggle', () => hosts.toggle());
  // Notification clicks (toasts and OS banners) — see ui-notifications _getNotifMeta.
  on('assistant:show', (data) => hosts.show(data?.sessionId || null, { host: data?.host || null }));
  on('assistant:focused', (data) => hosts.noteFocus(data?.sessionId, data?.host));
  // Another client closed a session → drop its tab without re-closing it server-side.
  on('sync:assistant:session-ended', (msg) => {
    const id = msg?.sessionId || msg?.session?.id || msg?.id;
    if (id) hosts.ended(id);
    if (id && msg?.destroyed) forgetTabState(id); // removed for good: its tab's UI state goes too
  });
  registerAction('launch-assistant', () => hosts.openOrFocus());
  registerAction('toggle-assistant', () => hosts.toggle());
}
