// ═══════════════════════════════════════════
// SynaBun — Antigravity Panel (facade)
// The Antigravity side panel's entry point: one stable surface for the shared
// UI modules (navbar, tray, detached session windows, the native-loop router,
// the File Explorer's Send to). Implementation lives in ./agy/, loaded on first
// use or in idle time after the page is shown (sidepanel-lazy.js). A panel that
// has not loaded is not open.
// ═══════════════════════════════════════════

import { antigravityPanelModule as panel } from './sidepanel-lazy.js';

export const toggleAntigravityPanel = panel.asyncExport('toggleAntigravityPanel');
export const isAntigravityPanelOpen = panel.syncExport('isAntigravityPanelOpen', false);
export const bootAntigravityPanel = panel.deferredExport('bootAntigravityPanel');
export const openAntigravityWithPrompt = panel.asyncExport('openAntigravityWithPrompt');
export const attachPathToAntigravity = panel.deferredExport('attachPathToAntigravity');
export const attachAntigravityAutomation = panel.asyncExport('attachAntigravityAutomation');
export const detachAntigravityAutomation = panel.deferredExport('detachAntigravityAutomation');
export const handleAntigravityAutomationEvent = panel.deferredExport('handleAntigravityAutomationEvent');
export const antigravityPanelDefaults = panel.syncExport('antigravityPanelDefaults', () => ({ project: '' }));
export const endHostedAntigravitySessions = panel.syncExport('endHostedAntigravitySessions', undefined);
