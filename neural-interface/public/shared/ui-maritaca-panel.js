// ═══════════════════════════════════════════
// SynaBun — Maritaca Panel (facade)
// The Maritaca side panel's entry point: one stable surface for the shared UI modules (navbar, tray, detached
// session windows). Implementation lives in ./mtc/, loaded on first use or in idle time after the page is shown
// (sidepanel-lazy.js). A panel that has not loaded is not open.
// ═══════════════════════════════════════════

import { maritacaPanelModule as panel } from './sidepanel-lazy.js';

export const toggleMaritacaPanel = panel.asyncExport('toggleMaritacaPanel');
export const isMaritacaPanelOpen = panel.syncExport('isMaritacaPanelOpen', false);
export const bootMaritacaPanel = panel.deferredExport('bootMaritacaPanel');
export const openMaritacaWithPrompt = panel.asyncExport('openMaritacaWithPrompt');
export const maritacaPanelDefaults = panel.syncExport('maritacaPanelDefaults', () => ({ project: '' }));
export const endHostedMaritacaSessions = panel.syncExport('endHostedMaritacaSessions', undefined);
export const maritacaPanelDebug = panel.syncExport('maritacaPanelDebug', null);
