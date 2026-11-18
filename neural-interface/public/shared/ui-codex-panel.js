// ═══════════════════════════════════════════
// SynaBun — Codex Panel (facade)
// Actual implementation in ./cdx/ directory, loaded on first use or in idle time after the page
// is shown (sidepanel-lazy.js). The names are the panel's own; a panel that has not loaded is
// not open.
// ═══════════════════════════════════════════

import { codexPanelModule as panel, codexTabsModule as tabs } from './sidepanel-lazy.js';

export const toggleCodexPanel = panel.asyncExport('toggleCodexPanel');
export const isCodexPanelOpen = panel.syncExport('isCodexPanelOpen', false);
export const bootCodexPanel = panel.deferredExport('bootCodexPanel');
export const attachCodexAutomation = panel.asyncExport('attachCodexAutomation');
export const detachCodexAutomation = panel.asyncExport('detachCodexAutomation');
export const handleCodexAutomationEvent = panel.deferredExport('handleCodexAutomationEvent');
// A path chip in the active Codex tab (the File Explorer's Send to, after the panel opened).
export const addPathChip = tabs.deferredExport('addPathChip');
