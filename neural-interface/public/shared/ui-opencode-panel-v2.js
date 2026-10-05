// ═══════════════════════════════════════════
// SynaBun — OpenCode V2 Panel (barrel re-export)
// The OpenCode panel's entry point: one stable surface (toggleOpencodePanel /
// isOpencodePanelOpen / openOpencodeWithPrompt / attachPathToOpencode and the
// automation attach pair) for the shared UI modules to bind to.
// Implementation lives in ./ocp-v2/. The earlier panel (./ocp/ and its
// ./ui-opencode-panel.js barrel) was removed on 2026-10-04.
// ═══════════════════════════════════════════

export {
  toggleOpencodePanel,
  isOpencodePanelOpen,
  openOpencodeWithPrompt,
  attachPathToOpencode,
  attachOpenCodeAutomation,
  detachOpenCodeAutomation,
} from './ocp-v2/ocp-v2-panel.js';
