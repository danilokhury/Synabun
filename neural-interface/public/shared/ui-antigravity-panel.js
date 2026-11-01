// ═══════════════════════════════════════════
// SynaBun — Antigravity Panel (barrel re-export)
// The Antigravity side panel's entry point: one stable surface for the shared
// UI modules (navbar, tray, detached session windows, the native-loop router,
// the File Explorer's Send to). Implementation lives in ./agy/.
// ═══════════════════════════════════════════

export {
  toggleAntigravityPanel,
  isAntigravityPanelOpen,
  bootAntigravityPanel,
  openAntigravityWithPrompt,
  attachPathToAntigravity,
  attachAntigravityAutomation,
  detachAntigravityAutomation,
  handleAntigravityAutomationEvent,
  antigravityPanelDefaults,
  endHostedAntigravitySessions,
} from './agy/agy-panel.js';
