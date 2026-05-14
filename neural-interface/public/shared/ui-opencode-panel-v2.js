// ═══════════════════════════════════════════
// SynaBun — OpenCode V2 Panel (barrel re-export)
// Clean-slate replacement for ./ui-opencode-panel.js. Keeps the same exported
// surface (toggleOpencodePanel / isOpencodePanelOpen / openOpencodeWithPrompt
// / attachPathToOpencode) so shared UI modules bind without further edits.
// Implementation lives in ./ocp-v2/ — old ./ocp/ files remain on disk but
// are no longer reachable from the UI.
// ═══════════════════════════════════════════

export {
  toggleOpencodePanel,
  isOpencodePanelOpen,
  openOpencodeWithPrompt,
  attachPathToOpencode,
} from './ocp-v2/ocp-v2-panel.js';
