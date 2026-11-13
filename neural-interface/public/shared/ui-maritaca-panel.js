// ═══════════════════════════════════════════
// SynaBun — Maritaca Panel (barrel re-export)
// The Maritaca side panel's entry point: one stable surface for the shared UI modules (navbar, tray, detached
// session windows). Implementation lives in ./mtc/.
// ═══════════════════════════════════════════

export {
  toggleMaritacaPanel,
  isMaritacaPanelOpen,
  bootMaritacaPanel,
  openMaritacaWithPrompt,
  maritacaPanelDefaults,
  endHostedMaritacaSessions,
  maritacaPanelDebug,
} from './mtc/mtc-panel.js';
