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
import { createAssistantSession, getAssistantSession, listAssistantSessions } from './assistant/asst-api.js';
import { providerShortLabel, readStoredBrain } from './assistant/asst-state.js';

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
  api: { list: listAssistantSessions, get: getAssistantSession, create: createAssistantSession },
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
  on('assistant:resume', (data) => {
    if (data?.sessionId) hosts.open({ resume: data.sessionId, host: data?.host || null, floating: data?.floating });
  });
  on('assistant:toggle', () => hosts.toggle());
  // Notification clicks (toasts and OS banners) — see ui-notifications _getNotifMeta.
  on('assistant:show', (data) => hosts.show(data?.sessionId || null, { host: data?.host || null }));
  on('assistant:focused', (data) => hosts.noteFocus(data?.sessionId, data?.host));
  // Another client closed a session → drop its tab without re-closing it server-side.
  on('sync:assistant:session-ended', (msg) => {
    const id = msg?.sessionId || msg?.session?.id || msg?.id;
    if (id) hosts.ended(id);
  });
  registerAction('launch-assistant', () => hosts.openOrFocus());
  registerAction('toggle-assistant', () => hosts.toggle());
}
