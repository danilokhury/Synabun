import { extensionUpdateView } from './extension-update-view.js';

const listeners = new Set();
let current = null, revision = 0, reading = null;
export function acceptExtensionUpdate(update) {
  revision++;
  current = update;
  for (const show of listeners) show(update);
}
export function watchExtensionUpdate(show) {
  listeners.add(show); show(current);
  return () => listeners.delete(show);
}
// Capture this before a read of either the full Settings card or the small notice endpoint.
// A slower response cannot overwrite a newer read or the response to an explicit action.
export function beginExtensionUpdateRead() {
  const started = revision;
  return update => { if (revision === started) acceptExtensionUpdate(update); };
}
// One owner-only read for all the notices. A slow read started before a click cannot undo its response.
export function refreshExtensionUpdate() {
  if (reading) return reading;
  const accept = beginExtensionUpdateRead();
  reading = fetch('/api/browser/extension/update/status', { cache: 'no-store' }).then(async response => {
    if (response.ok) {
      const update = await response.json();
      accept(update);
    } else if ([401, 403, 404].includes(response.status)) accept(null);
  }).catch(() => {}).finally(() => { reading = null; });
  return reading;
}

export const extensionUpdateSettings = { tab: 'browser', expand: 'bcg-profiles', scrollTo: 'bc-extension-update-flow' };
export function openExtensionUpdate() {
  return import('./ui-settings-entry.js').then(({ openSettingsModal }) => openSettingsModal(extensionUpdateSettings));
}

// Emit only a change in the short banner, so progress polls cannot replace a focused action.
export function watchExtensionUpdateMention(tx, show) {
  let previous = '';
  return watchExtensionUpdate(update => {
    const view = extensionUpdateView(update, tx);
    const text = view?.due ? view.title : '';
    if (text === previous) return;
    previous = text;
    show(text, { label: tx('browserExtension.updateFlow.review'), onClick: openExtensionUpdate });
  });
}

// Only closing the notification dismisses it. Settings and the Assistant still offer the update in this session.
export function extensionUpdateToast({ tx, showNotice, session, open = openExtensionUpdate }) {
  const storageKey = 'synabun-extension-update-dismissed';
  let dismissed, visible, clear;
  try { dismissed = session?.getItem(storageKey); } catch {}
  return update => {
    const view = extensionUpdateView(update, tx);
    const show = view?.due && view.key !== dismissed;
    const signature = show ? JSON.stringify([view.key, view.title]) : null;
    if (signature === visible) return;
    clear?.(); clear = null; visible = signature;
    if (show) clear = showNotice({
      title: view.title, action: tx('browserExtension.updateFlow.review'), closeLabel: tx('browserExtension.updateFlow.dismiss'),
      onAction: open, onClose() {
        dismissed = view.key;
        try { session?.setItem(storageKey, dismissed); } catch {}
        clear?.(); clear = null; visible = null;
      },
    });
  };
}
export function startExtensionUpdateNotices({ tx, showNotice }) {
  let session;
  try { session = window.sessionStorage; } catch {}
  watchExtensionUpdate(extensionUpdateToast({ tx, showNotice, session }));
  let timer;
  async function poll() {
    clearTimeout(timer);
    if (!document.hidden) await refreshExtensionUpdate();
    clearTimeout(timer);
    timer = setTimeout(poll, current && !['idle', 'done'].includes(current.phase) ? 2000 : 30000);
  }
  document.addEventListener('visibilitychange', poll);
  if (window.location.hash === '#browser-extension-update') {
    history.replaceState(history.state, '', location.pathname + location.search);
    void refreshExtensionUpdate().then(openExtensionUpdate);
  }
  return poll();
}
