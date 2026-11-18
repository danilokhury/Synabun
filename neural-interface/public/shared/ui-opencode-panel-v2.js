// ═══════════════════════════════════════════
// SynaBun — OpenCode V2 Panel (facade)
// The OpenCode panel's entry point: one stable surface (toggleOpencodePanel /
// isOpencodePanelOpen / openOpencodeWithPrompt / attachPathToOpencode and the
// automation attach pair) for the shared UI modules to bind to.
// Implementation lives in ./ocp-v2/, loaded on first use or in idle time after
// the page is shown (sidepanel-lazy.js; its module-level `opencode-panel:*`
// listeners are kept working before that). The earlier panel (./ocp/ and its
// ./ui-opencode-panel.js barrel) was removed on 2026-10-04.
// ═══════════════════════════════════════════

import { opencodePanelModule as panel } from './sidepanel-lazy.js';

export const toggleOpencodePanel = panel.asyncExport('toggleOpencodePanel');
export const isOpencodePanelOpen = panel.syncExport('isOpencodePanelOpen', false);
export const bootOpencodePanel = panel.asyncExport('bootOpencodePanel');
export const openOpencodeWithPrompt = panel.asyncExport('openOpencodeWithPrompt');
export const attachPathToOpencode = panel.asyncExport('attachPathToOpencode');
export const attachOpenCodeAutomation = panel.asyncExport('attachOpenCodeAutomation');
export const detachOpenCodeAutomation = panel.asyncExport('detachOpenCodeAutomation');
