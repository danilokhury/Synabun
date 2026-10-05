// Same-origin session documents isolate each provider's module-level UI state.
export const hostedSidepanelId = (() => {
  try { return window.frameElement?.dataset.sidepanelSession || null; } catch { return null; }
})();

export function sidepanelHost() {
  return hostedSidepanelId ? window.parent.__synabunSessionPanels : window.__synabunSessionPanels;
}

export function routeSidepanelEvent(event, data) {
  const host = sidepanelHost();
  if (!host) return false;
  if (hostedSidepanelId) {
    if (!['open-plan-editor', 'open-changelog-editor', 'browser:reconnect'].includes(event)) return false;
    host.emitFromSession(hostedSidepanelId, event, data);
    return true;
  }
  return host.routeEvent(event, data);
}
