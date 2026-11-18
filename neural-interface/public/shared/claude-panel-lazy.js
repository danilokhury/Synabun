// SynaBun — the Claude Code side panel's facade (ui-claude-panel.js loads on first use: sidepanel-lazy.js).
// The names are the panel's own. A panel that has not loaded is not open.

import { claudePanelModule as panel } from './sidepanel-lazy.js';

export const toggleClaudePanel = panel.asyncExport('toggleClaudePanel');
export const bootClaudePanel = panel.asyncExport('bootClaudePanel');
export const sendToPanel = panel.asyncExport('sendToPanel');
export const attachClaudeAutomation = panel.asyncExport('attachClaudeAutomation');
export const detachClaudeAutomation = panel.asyncExport('detachClaudeAutomation');
export const handleClaudeAutomationEvent = panel.deferredExport('handleClaudeAutomationEvent');
export const isClaudePanelOpen = panel.syncExport('isClaudePanelOpen', false);
