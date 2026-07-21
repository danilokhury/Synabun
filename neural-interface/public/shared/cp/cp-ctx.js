// ── Shared context for cp/ feature modules ──
// The ui-claude-panel.js monolith owns all state; cp/ modules receive these
// references once at init (mirrors the cdx-render setRenderContext pattern
// without touching any cdx code). Every function the modules need from the
// monolith is injected here — cp/ modules never import the monolith directly.

export let cpCtx = null;

export function setCpCtx(ctx) {
  cpCtx = ctx;
}
