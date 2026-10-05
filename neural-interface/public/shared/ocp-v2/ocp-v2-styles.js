// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 Sidepanel — visual styles (1:1 match to legacy ocp/ocp-styles.js)
// Same dimensions, glass background, header / messages / compose card stack,
// JetBrains Mono typography, slide-in transition. Class names stay .ocpv2-*
// so the renderer doesn't change.
// ─────────────────────────────────────────────────────────────────────────────

const STYLE_ID = 'ocp-v2-styles';

const CSS = `
/* ── Panel shell ──────────────────────────────────────────────────────── */
.ocpv2-panel {
  position: fixed;
  top: calc(var(--navbar-height, 48px) + 20px);
  right: 20px;
  bottom: 20px;
  width: 22%;
  min-width: 320px;
  max-width: 700px;
  z-index: 10001;
  display: flex;
  flex-direction: column;
  background: rgba(16, 18, 22, 0.92);
  backdrop-filter: blur(28px) saturate(1.45);
  -webkit-backdrop-filter: blur(28px) saturate(1.45);
  border: 0.5px solid rgba(255,255,255,0.08);
  border-radius: 16px;
  box-shadow:
    0 0 0 0.5px rgba(0,0,0,0.3),
    0 1px 2px rgba(0,0,0,0.15),
    0 4px 8px rgba(0,0,0,0.12),
    0 12px 24px rgba(0,0,0,0.14),
    0 32px 64px rgba(0,0,0,0.18);
  overflow: hidden;
  transform: translateX(calc(100% + 20px));
  opacity: 0;
  transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.28s ease;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 12.5px;
  line-height: 1.55;
  color: rgba(255,255,255,0.86);
}
.ocpv2-panel.ocpv2-open {
  transform: translateX(0);
  opacity: 1;
  overflow: visible;
}
/* Keep footer menus above focused floating terminal windows. */
.ocpv2-panel:has(.ocpv2-dropdown.open) {
  z-index: 99999;
}

/* ── Resize handle (left edge — panel is anchored right) ─────────────── */
.ocpv2-resize-handle {
  position: absolute;
  top: 14px;
  left: 0;
  width: 6px;
  height: calc(100% - 28px);
  cursor: col-resize;
  z-index: 10;
  border-radius: 0 3px 3px 0;
}
.ocpv2-resize-handle:hover,
.ocpv2-resize-handle:active {
  background: linear-gradient(180deg, rgba(232,224,220,0.12), transparent 50%, rgba(232,224,220,0.12));
}

/* ── Header card ──────────────────────────────────────────────────────── */
/* The same card as the other side panels: the split title control on the left
   (session button, then the rename pencil), the action buttons on the right
   edge, the session menu under the card. */
.ocpv2-header {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  margin: 8px 8px 0 8px;
  padding: 10px 10px 10px 14px;
  background: rgba(22, 22, 26, 0.95);
  border-radius: 10px;
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.2), 0 5px 14px rgba(0,0,0,0.12)), 0 0 0 1px rgba(255,255,255,0.06);
  z-index: 3;
}

/* Session button + rename pencil: one split control, as wide as its title */
.ocpv2-session-btn {
  background: rgba(255,255,255,0.03);
  border: none;
  display: flex;
  align-items: center;
  gap: 5px;
  color: rgba(255,255,255,0.55);
  font-size: 11px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  line-height: normal;
  cursor: pointer;
  padding: 5px 10px;
  border-radius: 8px 0 0 8px;
  transition: background 0.15s, color 0.15s;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
}
.ocpv2-session-btn:hover {
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.75);
}
/* A sub-agent panel's title: the same chip, with no menu behind it. */
.ocpv2-session-btn-static,
.ocpv2-session-btn-static:hover {
  background: rgba(255,255,255,0.03);
  color: rgba(255,255,255,0.55);
  cursor: default;
}
.ocpv2-session-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ocpv2-rename-input {
  width: 100%;
  min-width: 0;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(100,160,255,0.3);
  border-radius: 4px;
  color: rgba(255,255,255,0.9);
  font-size: 11px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  padding: 2px 6px;
  margin: 0;
  outline: none;
}
.ocpv2-rename-input:focus { border-color: rgba(100,160,255,0.5); }
.ocpv2-rename-input::placeholder { color: rgba(255,255,255,0.3); }
.ocpv2-session-btn .ocpv2-dd-arrow {
  font-size: 9px;
  padding: 4px 6px;
  margin: -4px -6px -4px 0;
  border-radius: 0 6px 6px 0;
  cursor: pointer;
  pointer-events: auto;
  transition: background 0.15s, color 0.2s, transform 0.2s;
}
.ocpv2-session-btn .ocpv2-dd-arrow:hover {
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.5);
}
.ocpv2-header-rename {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  align-self: stretch;
  border-radius: 0 8px 8px 0;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.03);
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  flex-shrink: 0;
}
.ocpv2-header-rename:hover:not(:disabled) {
  color: rgba(100,160,255,0.95);
  background: rgba(100,160,255,0.14);
}
.ocpv2-header-rename:active:not(:disabled) { transform: scale(0.92); transition-duration: 0.06s; }
.ocpv2-header-rename:disabled { opacity: 0.4; cursor: not-allowed; }
.ocpv2-header-rename svg {
  width: 12px; height: 12px;
  stroke: currentColor; fill: none;
  stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  pointer-events: none;
}

/* Session dropdown menu */
.ocpv2-session-menu {
  display: none;
  position: absolute;
  top: calc(100% + 2px);
  left: 8px;
  right: 8px;
  background: rgba(12, 12, 14, 0.98);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  padding: 4px;
  z-index: 310;
  max-height: 360px;
  overflow-y: auto;
  box-shadow: var(--shadow-lg, 0 2px 4px rgba(0,0,0,0.3), 0 6px 16px rgba(0,0,0,0.2), 0 20px 44px rgba(0,0,0,0.15));
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.06) transparent;
}
.ocpv2-session-menu.open { display: block; }
.ocpv2-session-menu::-webkit-scrollbar { width: 3px; }
.ocpv2-session-menu::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
.ocpv2-session-item {
  position: relative;
  display: flex;
  align-items: center;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: rgba(255,255,255,0.5);
  cursor: pointer;
  transition: background 0.12s;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  gap: 6px;
}
.ocpv2-session-item:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.8); }
.ocpv2-session-item.active {
  color: rgba(255,255,255,0.75);
  background: rgba(255,255,255,0.08);
}
.ocpv2-session-item-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ocpv2-session-item-delete {
  opacity: 0;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: rgba(255,82,82,0.6);
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
}
.ocpv2-session-item:hover .ocpv2-session-item-delete { opacity: 1; }
.ocpv2-session-item-delete:hover {
  color: #ff5252;
  background: rgba(255,82,82,0.12);
}
.ocpv2-session-item-delete svg { width: 10px; height: 10px; }
.ocpv2-session-menu-empty {
  padding: 10px;
  font-size: 10.5px;
  color: rgba(255,255,255,0.35);
  text-align: center;
}
.ocpv2-session-menu .ocpv2-session-menu-empty {
  padding: 12px 8px;
  font-size: 10px;
  color: rgba(255,255,255,0.2);
}
/* The session's state (idle, running, awaiting permission, …). It reads in the
   footer toolbar's left group, after the agent buttons, and takes only the
   room that is left there: the dot stays when the text does not fit. */
.ocpv2-footer-status {
  flex: 1 1 0;
  min-width: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  line-height: 16px;
  color: rgba(255,255,255,0.55);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.02em;
}
.ocpv2-footer-status::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 999px;
  vertical-align: middle;
  background: rgba(200,180,140,0.85);
}
.ocpv2-footer-status.ocpv2-status-ready::before    { background: rgba(140,200,160,0.75); }
.ocpv2-footer-status.ocpv2-status-running::before  { background: rgba(140,180,220,0.85); animation: ocpv2-pulse 1s infinite; }
.ocpv2-footer-status.ocpv2-status-error::before    { background: rgba(220,120,120,0.85); }
.ocpv2-footer-status.ocpv2-status-healing,
.ocpv2-footer-status.ocpv2-status-reconnecting    { color: rgba(180,205,255,0.9); }
.ocpv2-footer-status.ocpv2-status-healing::before,
.ocpv2-footer-status.ocpv2-status-reconnecting::before { background: rgba(120,170,255,0.9); animation: ocpv2-pulse 1.1s infinite; }
.ocpv2-footer-status.ocpv2-status-awaiting        { color: rgba(255,200,120,0.95); }
.ocpv2-footer-status.ocpv2-status-awaiting::before { background: rgba(232,180,80,0.9); animation: ocpv2-pulse 1.2s infinite; }
/* ── Context settings: the header cog and its popover (ocp-v2-context-menu.js) ── */
.ocpv2-cog-btn { position: relative; }
.ocpv2-cog-btn[aria-expanded="true"] { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.75); }
.ocpv2-cog-dot { position: absolute; top: 2px; right: 2px; width: 6px; height: 6px; border-radius: 50%; background: #d4a848; pointer-events: none; }
.ocpv2-cog-dot[hidden] { display: none; }
.ocpv2-cog-dot-critical { background: #ef7070; }
/* One grammar: a 28px head (title, at most one action) and 28px rows (label
   left, one value on the right edge). 12px around, 12px + a hairline + 12px
   between sections. The popover is a child of <body>. */
.ocpv2-ctxpop { position: fixed; box-sizing: border-box; overflow-x: hidden; overflow-y: auto; padding: 12px; background: rgba(22,22,26,0.98); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); font: 400 11px/16px 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.86); outline: none; }
.ocpv2-ctxpop-section + .ocpv2-ctxpop-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); }
.ocpv2-ctxpop-head, .ocpv2-ctxpop-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 28px; }
.ocpv2-ctxpop-head { margin-bottom: 4px; }
.ocpv2-ctxpop-title { flex: 1 1 0; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 11px/16px 'JetBrains Mono', ui-monospace, monospace; color: rgba(255,255,255,0.92); }
.ocpv2-ctxpop-act { display: inline-flex; flex-shrink: 0; }
.ocpv2-ctxpop-bar { height: 4px; margin: 8px 0; border-radius: 2px; background: rgba(255,255,255,0.08); overflow: hidden; }
.ocpv2-ctxpop-fill { height: 100%; border-radius: 2px; background: rgba(232,224,220,0.55); }
.ocpv2-ctxpop-fill.ocpv2-ctxpop-high { background: #d4a848; }
.ocpv2-ctxpop-fill.ocpv2-ctxpop-critical { background: #ef7070; }
.ocpv2-ctxpop-usage { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 20px; margin-bottom: 4px; }
.ocpv2-ctxpop-used { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ocpv2-ctxpop-share { flex-shrink: 0; }
.ocpv2-ctxpop-k { flex: 0 0 auto; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,0.6); }
.ocpv2-ctxpop-v { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: rgba(255,255,255,0.86); }
.ocpv2-ctxpop-muted { color: rgba(255,255,255,0.4); }
.ocpv2-ctxpop-row-server > .ocpv2-ctxpop-k { flex: 1 1 0; min-width: 0; max-width: none; }
.ocpv2-ctxpop-row-server > .ocpv2-ctxpop-v { flex: 0 0 auto; }
.ocpv2-ctxpop-status { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.ocpv2-ctxpop-dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.3); }
.ocpv2-ctxpop-dot-ok { background: #5fcf83; }
.ocpv2-ctxpop-dot-warn { background: #d4a848; }
.ocpv2-ctxpop-dot-err { background: #ef7070; }
.ocpv2-ctxpop-btn { box-sizing: border-box; height: 22px; padding: 0 10px; border: 1px solid rgba(255,255,255,0.08); border-radius: 5px; background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.92); font: 400 11px/20px 'JetBrains Mono', ui-monospace, monospace; cursor: pointer; }
.ocpv2-ctxpop-btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
.ocpv2-ctxpop-btn:disabled { opacity: 0.45; cursor: default; pointer-events: none; }
.ocpv2-ctxpop-link { flex: 0 0 auto; height: 20px; padding: 0; border: none; background: none; color: rgba(180,205,255,0.9); font: 400 11px/20px 'JetBrains Mono', ui-monospace, monospace; text-decoration: none; cursor: pointer; }
.ocpv2-ctxpop-link:hover:not(:disabled) { filter: brightness(1.2); }
.ocpv2-ctxpop-link:disabled { color: rgba(255,255,255,0.4); cursor: default; pointer-events: none; }
.ocpv2-ctxpop-switch { display: inline-flex; align-items: center; gap: 6px; }
.ocpv2-ctxpop-copy { padding: 0; border: none; background: none; font: inherit; line-height: 20px; cursor: pointer; }
.ocpv2-ctxpop-copy:hover, .ocpv2-ctxpop-copy.ocpv2-ctxpop-copied { color: rgba(180,205,255,0.9); }
.ocpv2-ctxpop-btn:focus-visible, .ocpv2-ctxpop-link:focus-visible, .ocpv2-ctxpop-copy:focus-visible { outline: 1px solid rgba(255,255,255,0.45); outline-offset: 2px; }
.ocpv2-header-btn {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.55);
  padding: 4px 10px;
  font-size: 10.5px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.02em;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}
.ocpv2-header-btn:hover {
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.85);
  border-color: rgba(255,255,255,0.12);
}

/* ── Header action buttons (detach / + / cog / minimize / close / slide) ─── */
.ocpv2-actions {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  flex-shrink: 0;
}
.ocpv2-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  border: none;
  background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ocpv2-btn:hover {
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.75);
  transform: scale(1.05);
}
.ocpv2-btn:active { transform: scale(0.92); transition-duration: 0.06s; }
.ocpv2-btn svg {
  width: 12px; height: 12px;
  stroke: currentColor; fill: none;
  stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  pointer-events: none;
}
.ocpv2-btn-new:hover { color: rgba(110,181,255,0.95); background: rgba(110,181,255,0.14); }
.ocpv2-btn-minimize:hover { color: rgba(255,200,50,0.95); background: rgba(255,200,50,0.14); }
.ocpv2-btn-danger:hover { color: rgba(255,82,82,0.95); background: rgba(255,82,82,0.14); }
.ocpv2-btn-danger svg,
.ocpv2-btn-slide svg { stroke-width: 2.5; }

@keyframes ocpv2-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.45; }
}

/* ── Tray pill (minimize-to-pill) ───────────────────────────────────────── */
@property --ocpv2-pill-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
.ocpv2-session-pill {
  position: relative;
  overflow: hidden;
  border-color: rgba(232, 224, 220, 0.12);
  transition: border-color 0.2s;
}
.ocpv2-session-pill::before {
  content: '';
  position: absolute; inset: 0;
  border-radius: 8px;
  padding: 1px;
  pointer-events: none;
  background: transparent;
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  opacity: 0;
}
.ocpv2-session-pill.ocpv2-pill-running {
  border-color: transparent;
}
.ocpv2-session-pill.ocpv2-pill-running::before {
  background: conic-gradient(
    from var(--ocpv2-pill-angle, 0deg),
    rgba(232,224,220,0.0) 0%,
    rgba(232,224,220,0.55) 25%,
    rgba(232,224,220,0.10) 50%,
    rgba(232,224,220,0.55) 75%,
    rgba(232,224,220,0.0) 100%
  );
  animation: ocpv2-pill-border-spin 2.4s linear infinite;
  opacity: 1;
}
@keyframes ocpv2-pill-border-spin {
  to { --ocpv2-pill-angle: 360deg; }
}
.ocpv2-session-pill .term-minimized-pill-icon { color: rgba(232, 224, 220, 0.45); transition: color 0.2s; }
.ocpv2-session-pill.ocpv2-pill-running .term-minimized-pill-icon { color: rgba(232, 224, 220, 1); }
.ocpv2-session-pill:hover { border-color: rgba(232, 224, 220, 0.24); }
.ocpv2-session-pill:hover .term-minimized-pill-icon { color: rgba(232, 224, 220, 0.85); }
.ocpv2-session-pill:hover.ocpv2-pill-running::before {
  background: conic-gradient(
    from var(--ocpv2-pill-angle, 0deg),
    rgba(232,224,220,0.0) 0%,
    rgba(232,224,220,0.75) 25%,
    rgba(232,224,220,0.20) 50%,
    rgba(232,224,220,0.75) 75%,
    rgba(232,224,220,0.0) 100%
  );
}
.ocpv2-session-pill.ocpv2-pill-running .term-minimized-pill-label::before {
  content: '';
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 999px;
  background: rgba(232, 224, 220, 1);
  box-shadow: 0 0 8px rgba(232, 224, 220, 0.75), 0 0 14px rgba(232, 224, 220, 0.35);
  vertical-align: middle;
  animation: ocpv2-pill-pulse 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
/* Left-edge accent so a running pill announces itself even when the label is
   truncated and the dot is clipped. */
.ocpv2-session-pill.ocpv2-pill-running::after {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: linear-gradient(180deg, rgba(232,224,220,0), rgba(232,224,220,0.9), rgba(232,224,220,0));
  animation: ocpv2-pill-pulse 1.2s ease-in-out infinite;
  pointer-events: none;
}
@keyframes ocpv2-pill-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

/* Parent pill marker: sub-agent attached → arrow appears after the label.
   Brightens + pulses when the child is actively running. Without this a
   minimized parent looks idle even while its sub-agent is doing work. */
.ocpv2-session-pill.ocpv2-pill-has-child .term-minimized-pill-label::after {
  content: ' ↳';
  margin-left: 4px;
  color: rgba(180, 200, 255, 0.7);
  font-weight: 600;
}
.ocpv2-session-pill.ocpv2-pill-child-running .term-minimized-pill-label::after {
  color: rgba(180, 200, 255, 1);
  text-shadow: 0 0 6px rgba(180, 200, 255, 0.55);
  animation: ocpv2-pill-pulse 1.4s ease-in-out infinite;
}

/* A sub-agent of this session waits for an answer (a permission, a question):
   the marker turns amber, so it is noticeable without opening anything. */
.ocpv2-session-pill.ocpv2-pill-child-waiting .term-minimized-pill-label::after {
  content: ' ↳ ?';
  color: #f5a524;
  text-shadow: 0 0 6px rgba(245, 165, 36, 0.6);
  animation: ocpv2-pill-pulse 1.2s ease-in-out infinite;
}

/* ── New-session modal (project + branch + name) ────────────────────────── */
.ocpv2-name-modal-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
  border-radius: 16px;
  animation: ocpv2-name-fade 0.16s ease-out;
}
@keyframes ocpv2-name-fade { from { opacity: 0; } to { opacity: 1; } }
.ocpv2-name-modal {
  background: rgba(24,26,30,0.98);
  border: 0.5px solid rgba(255,255,255,0.12);
  border-radius: 12px;
  padding: 18px 18px 14px;
  width: calc(100% - 48px);
  max-width: 380px;
  box-shadow: 0 20px 40px rgba(0,0,0,0.4);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ocpv2-name-modal-title {
  color: rgba(255,255,255,0.9);
  font-size: 13px;
  font-weight: 500;
}
.ocpv2-name-modal-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ocpv2-name-modal-label {
  font-size: 10px;
  opacity: 0.55;
  color: rgba(255,255,255,0.7);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ocpv2-name-modal-select,
.ocpv2-name-modal-input {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px;
  padding: 8px 10px;
  color: rgba(255,255,255,0.92);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.ocpv2-name-modal-select {
  appearance: none;
  -webkit-appearance: none;
}
.ocpv2-name-modal-select:focus,
.ocpv2-name-modal-input:focus {
  border-color: rgba(232,224,220,0.4);
  background: rgba(255,255,255,0.08);
}
.ocpv2-name-modal-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ocpv2-name-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.ocpv2-name-modal-btn {
  padding: 6px 14px;
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  border: 1px solid transparent;
}
.ocpv2-name-modal-btn.skip {
  background: transparent;
  color: rgba(255,255,255,0.5);
  border-color: rgba(255,255,255,0.1);
}
.ocpv2-name-modal-btn.skip:hover {
  color: rgba(255,255,255,0.85);
  background: rgba(255,255,255,0.04);
}
.ocpv2-name-modal-btn.save {
  background: rgba(232,224,220,0.15);
  border-color: rgba(232,224,220,0.3);
  color: rgba(232,224,220,0.95);
}
.ocpv2-name-modal-btn.save:hover {
  background: rgba(232,224,220,0.25);
}

/* ── Messages container card ──────────────────────────────────────────── */
.ocpv2-messages-container {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  margin: 6px 8px 6px;
  background: rgba(0,0,0,0.18);
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.03);
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.2);
}
.ocpv2-messages {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 12px 12px 6px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.2) transparent;
  contain: layout style;
}
.ocpv2-messages > * { flex-shrink: 0; }
.ocpv2-messages::-webkit-scrollbar { width: 10px; }
.ocpv2-messages::-webkit-scrollbar-track { background: transparent; }
.ocpv2-messages::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.2);
  border-radius: 5px;
  min-height: 40px;
}
.ocpv2-messages::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,0.35);
}

/* ── Message bubbles ──────────────────────────────────────────────────── */
.ocpv2-msg {
  padding: 6px 10px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.55;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
.ocpv2-msg + .ocpv2-msg { margin-top: 6px; }
.ocpv2-msg-assistant + .ocpv2-msg-continuation { margin-top: 2px; }
.ocpv2-msg-role {
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.34);
  margin-bottom: 4px;
  font-weight: 500;
}
.ocpv2-msg-user {
  background: rgba(232,224,220,0.08);
  color: rgba(255,255,255,0.85);
  align-self: flex-end;
  max-width: 85%;
  padding: 8px 12px;
  border-bottom-right-radius: 4px;
}
/* Assistant bubble: minimal — no border, transparent bg, single subtle column.
   The avatar is a small inline pip on the role row, not an absolutely-positioned box. */
.ocpv2-msg-assistant {
  position: relative;
  background: transparent;
  border: none;
  color: rgba(255,255,255,0.86);
  align-self: stretch;
  max-width: 100%;
  padding: 6px 4px 6px 28px;
  border-radius: 0;
}
.ocpv2-msg-assistant .ocpv2-msg-role {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 4px -22px;
  padding-left: 22px;
  position: relative;
}
.ocpv2-msg-assistant .ocpv2-msg-role::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background:
    rgba(232,224,220,0.1)
    url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2030%27%20fill%3D%27%23E8E0DC%27%3E%3Cpath%20d%3D%27M18%206H6V24H18V6ZM24%2030H0V0H24V30Z%27%2F%3E%3C%2Fsvg%3E")
    center / 8px no-repeat;
  pointer-events: none;
}
/* Continuation rows tuck under the previous bubble: no avatar, no role, just content */
.ocpv2-msg-continuation { padding-top: 2px; padding-bottom: 2px; }
/* Reasoning row inside an assistant bubble — when collapsed, it shouldn't
   look like a heavy boxed mini-bubble. Strip the bubble chrome. */
.ocpv2-msg-part-reasoning { padding-top: 4px; padding-bottom: 4px; }
.ocpv2-msg-part-reasoning .ocpv2-part-reasoning {
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
}
.ocpv2-msg-part-reasoning .ocpv2-part-reasoning[open] .ocpv2-reasoning-body {
  margin-top: 6px;
}
/* "Awaiting your answer…" stub — render as a quiet inline note, not a fat bubble */
.ocpv2-msg-part-tool .ocpv2-part-question-stub { padding: 0; }

/* ── Part: text (Markdown) ─────────────────────────────────────────────── */
.ocpv2-part { display: block; }
.ocpv2-part + .ocpv2-part { margin-top: 6px; }
.ocpv2-part-text { white-space: normal; }
.ocpv2-part-text p { margin: 0 0 8px; }
.ocpv2-part-text p:last-child { margin-bottom: 0; }
.ocpv2-part-text h1, .ocpv2-part-text h2, .ocpv2-part-text h3,
.ocpv2-part-text h4, .ocpv2-part-text h5, .ocpv2-part-text h6 {
  margin: 0.75em 0 0.3em;
  line-height: 1.35;
  color: rgba(255,255,255,0.96);
  font-weight: 600;
}
.ocpv2-part-text h1 { font-size: 16px; }
.ocpv2-part-text h2 { font-size: 14px; }
.ocpv2-part-text h3 { font-size: 13px; }
.ocpv2-part-text h4 { font-size: 12px; }
.ocpv2-part-text h5 { font-size: 11.5px; opacity: 0.92; }
.ocpv2-part-text h6 { font-size: 11px; opacity: 0.85; text-transform: uppercase; letter-spacing: 0.04em; }
.ocpv2-part-text ul, .ocpv2-part-text ol {
  margin: 0 0 8px 18px;
  padding: 0;
}
.ocpv2-part-text li + li { margin-top: 4px; }
.ocpv2-part-text a { color: rgba(151,214,255,0.92); text-decoration: none; }
.ocpv2-part-text a:hover { text-decoration: underline; }
.ocpv2-part-text code {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.06);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11.5px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.ocpv2-part-text pre {
  background: rgba(0,0,0,0.28);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 8px;
  padding: 10px;
  margin: 8px 0;
  overflow-x: auto;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.ocpv2-part-text pre code {
  background: none;
  border: none;
  padding: 0;
  font-size: inherit;
}
.ocpv2-part-text strong { color: rgba(255,255,255,0.95); font-weight: 600; }
.ocpv2-part-text em     { font-style: italic; color: rgba(255,255,255,0.78); }
.ocpv2-part-text del    { opacity: 0.55; text-decoration: line-through; }
.ocpv2-part-text hr {
  border: none;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin: 12px 0;
}
.ocpv2-part-text blockquote {
  margin: 6px 0;
  padding: 4px 12px;
  border-left: 3px solid rgba(232,224,220,0.25);
  color: rgba(255,255,255,0.72);
  background: rgba(255,255,255,0.02);
  border-radius: 0 6px 6px 0;
}
.ocpv2-part-text blockquote p { margin: 4px 0; }
.ocpv2-part-text table {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 11px;
  width: 100%;
  display: block;
  overflow-x: auto;
}
.ocpv2-part-text thead {
  background: rgba(255,255,255,0.04);
}
.ocpv2-part-text th,
.ocpv2-part-text td {
  border: 1px solid rgba(255,255,255,0.08);
  padding: 5px 8px;
  text-align: left;
  vertical-align: top;
}
.ocpv2-part-text th { font-weight: 600; color: rgba(255,255,255,0.92); }
.ocpv2-part-text input[type="checkbox"] {
  margin-right: 4px;
  vertical-align: middle;
}
.ocpv2-part-text img {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}

/* ── Part: reasoning (CLI-style streaming thinking block) ──────────────── */
.ocpv2-part-reasoning {
  background: rgba(255,255,255,0.025);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
  padding: 8px 12px 10px;
  margin: 4px 0;
}
.ocpv2-part-reasoning summary,
.ocpv2-part-reasoning .ocpv2-reasoning-summary {
  cursor: pointer;
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgba(232,224,220,0.6);
  user-select: none;
}
.ocpv2-part-reasoning summary::-webkit-details-marker { display: none; }
.ocpv2-part-reasoning .ocpv2-reasoning-summary::before {
  content: '▸';
  display: inline-block;
  transition: transform 0.18s;
  color: rgba(255,255,255,0.35);
}
.ocpv2-part-reasoning[open] .ocpv2-reasoning-summary::before { transform: rotate(90deg); }
/* ── AskUser question card (rendered when the model invokes the question tool) ── */
.ocpv2-question {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(232,224,220,0.18);
  border-radius: 12px;
  padding: 12px 14px;
  margin: 8px 0;
  font-size: 11.5px;
  color: rgba(255,255,255,0.86);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ocpv2-question-locked { opacity: 0.55; pointer-events: none; }
.ocpv2-question-header {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(232,224,220,0.7);
}
.ocpv2-question-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.ocpv2-question-section:last-of-type { border-bottom: none; padding-bottom: 0; }
.ocpv2-question-tag {
  align-self: flex-start;
  font-size: 9.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: rgba(232,224,220,0.85);
  background: rgba(232,224,220,0.08);
  border: 1px solid rgba(232,224,220,0.18);
  padding: 2px 8px;
  border-radius: 999px;
}
.ocpv2-question-title {
  color: rgba(255,255,255,0.92);
  font-size: 12.5px;
  line-height: 1.45;
}
.ocpv2-question-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ocpv2-question-option {
  text-align: left;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 8px 10px;
  color: rgba(255,255,255,0.86);
  font: inherit;
  cursor: pointer;
  transition: all 0.14s;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ocpv2-question-option:hover {
  background: rgba(232,224,220,0.1);
  border-color: rgba(232,224,220,0.35);
}
.ocpv2-question-option.selected {
  background: rgba(232,224,220,0.16);
  border-color: rgba(232,224,220,0.5);
}
.ocpv2-question-option-label {
  font-size: 11.5px;
  font-weight: 600;
  color: rgba(255,255,255,0.95);
}
.ocpv2-question-option-desc {
  font-size: 10.5px;
  color: rgba(255,255,255,0.55);
  line-height: 1.4;
}
.ocpv2-question-custom-input {
  width: 100%;
  background: rgba(0,0,0,0.25);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.92);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
  font-size: 11px;
  outline: none;
}
.ocpv2-question-custom-input:focus {
  border-color: rgba(232,224,220,0.4);
  background: rgba(0,0,0,0.4);
}
.ocpv2-question-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.ocpv2-question-submit {
  background: rgba(232,224,220,0.18);
  border: 1px solid rgba(232,224,220,0.4);
  color: rgba(232,224,220,0.95);
  padding: 6px 14px;
  border-radius: 6px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.ocpv2-question-submit:hover { background: rgba(232,224,220,0.28); }
.ocpv2-question-reject {
  align-self: flex-end;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.5);
  padding: 4px 10px;
  border-radius: 5px;
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.ocpv2-question-reject:hover {
  color: rgba(255,255,255,0.85);
  border-color: rgba(255,255,255,0.2);
  background: rgba(255,255,255,0.04);
}

/* ── Post-plan approval card ────────────────────────────────────────────── */
.ocpv2-post-plan-card {
  margin: 10px 0 4px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid rgba(140,210,170,0.32);
  background: linear-gradient(180deg, rgba(140,210,170,0.05) 0%, rgba(232,224,220,0.04) 100%);
  box-shadow: 0 12px 32px rgba(0,0,0,0.22), 0 0 0 1px rgba(140,210,170,0.08) inset;
  color: rgba(255,255,255,0.9);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ocpv2-post-plan-header {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(180,230,200,0.92);
  font-weight: 700;
  display: inline-block;
  align-self: flex-start;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(140,210,170,0.14);
  border: 1px solid rgba(140,210,170,0.28);
}
.ocpv2-post-plan-note {
  font-size: 11px;
  line-height: 1.45;
  color: rgba(255,255,255,0.62);
}
.ocpv2-post-plan-content {
  font-size: 12px;
  line-height: 1.55;
  color: rgba(255,255,255,0.88);
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0,0,0,0.18);
  border: 1px solid rgba(255,255,255,0.06);
  max-height: 320px;
  overflow: auto;
}
.ocpv2-post-plan-content > *:first-child { margin-top: 0; }
.ocpv2-post-plan-content > *:last-child  { margin-bottom: 0; }
.ocpv2-post-plan-content h1,
.ocpv2-post-plan-content h2,
.ocpv2-post-plan-content h3 {
  margin: 10px 0 6px;
  font-size: 12.5px;
  color: rgba(255,255,255,0.95);
}
.ocpv2-post-plan-content ul,
.ocpv2-post-plan-content ol {
  margin: 4px 0;
  padding-left: 18px;
}
.ocpv2-post-plan-content code {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(255,255,255,0.06);
}
.ocpv2-post-plan-content pre {
  margin: 6px 0;
  padding: 8px;
  border-radius: 4px;
  background: rgba(0,0,0,0.32);
  overflow-x: auto;
}
.ocpv2-post-plan-saved {
  font-size: 10.5px;
  color: rgba(180,230,200,0.7);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.02em;
}
.ocpv2-post-plan-body {
  font-size: 11.5px;
  line-height: 1.45;
  color: rgba(255,255,255,0.66);
}
.ocpv2-post-plan-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.ocpv2-post-plan-btn {
  min-height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.045);
  color: rgba(255,255,255,0.82);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.ocpv2-post-plan-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.085);
  border-color: rgba(255,255,255,0.2);
  color: rgba(255,255,255,0.94);
}
.ocpv2-post-plan-btn.primary {
  background: rgba(140,210,170,0.22);
  border-color: rgba(140,210,170,0.5);
  color: rgba(255,255,255,0.96);
  font-weight: 650;
}
.ocpv2-post-plan-btn.primary:hover:not(:disabled) {
  background: rgba(140,210,170,0.32);
  border-color: rgba(140,210,170,0.7);
}
.ocpv2-post-plan-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* Stub shown in place of raw question-tool JSON while the AskUser card handles it */
.ocpv2-part-question-stub {
  font-size: 10.5px;
  color: rgba(255,255,255,0.4);
  font-style: italic;
  padding: 4px 2px;
}

/* Simple "Thinking…" row shown while reasoning streams (no container, no body) */
.ocpv2-thinking-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  font-size: 11px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.04em;
  color: rgba(255,255,255,0.55);
}
.ocpv2-thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(140,200,255,0.85);
  flex-shrink: 0;
  animation: ocpv2-think-pulse 1.1s ease-in-out infinite;
}
@keyframes ocpv2-think-pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.85); }
  50%      { opacity: 1;   transform: scale(1.15); }
}
.ocpv2-thinking-label {
  color: rgba(255,255,255,0.65);
}
.ocpv2-thinking-ellipsis {
  display: inline-flex;
  gap: 1px;
  color: rgba(255,255,255,0.55);
}
.ocpv2-thinking-ellipsis span {
  animation: ocpv2-think-bounce 1.2s ease-in-out infinite;
}
.ocpv2-thinking-ellipsis span:nth-child(2) { animation-delay: 0.18s; }
.ocpv2-thinking-ellipsis span:nth-child(3) { animation-delay: 0.36s; }
@keyframes ocpv2-think-bounce {
  0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
  30%           { opacity: 1;    transform: translateY(-2px); }
}
.ocpv2-part-reasoning .ocpv2-reasoning-body {
  margin-top: 8px;
  padding: 8px 10px;
  background: rgba(0,0,0,0.18);
  border: 1px solid rgba(255,255,255,0.04);
  border-radius: 6px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  color: rgba(255,255,255,0.72);
  max-height: 360px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.ocpv2-part-reasoning .ocpv2-reasoning-body p { margin: 0 0 6px; }
.ocpv2-part-reasoning .ocpv2-reasoning-body p:last-child { margin-bottom: 0; }
.ocpv2-part-reasoning .ocpv2-reasoning-body strong { color: rgba(255,255,255,0.92); }
.ocpv2-part-reasoning .ocpv2-reasoning-body em     { color: rgba(255,255,255,0.78); font-style: italic; }
.ocpv2-part-reasoning .ocpv2-reasoning-body code {
  background: rgba(255,255,255,0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10.5px;
}

/* ── Part: tool card ───────────────────────────────────────────────────── */
.ocpv2-part-tool {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  overflow: hidden;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.015);
}
.ocpv2-tool-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  color: rgba(255,255,255,0.56);
}
.ocpv2-tool-name {
  flex: 1;
  color: rgba(245,239,235,0.88);
  font-weight: 600;
  letter-spacing: 0.01em;
}
.ocpv2-tool-status {
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.03);
  color: rgba(255,255,255,0.45);
  font-size: 10px;
  line-height: 1;
  text-transform: lowercase;
  letter-spacing: 0.02em;
}
.ocpv2-tool-status.ocpv2-tool-pending,
.ocpv2-tool-status.ocpv2-tool-running {
  color: rgba(232,224,220,0.75);
  background: rgba(232,224,220,0.06);
  border-color: rgba(232,224,220,0.12);
}
.ocpv2-tool-status.ocpv2-tool-completed {
  color: rgba(232,224,220,0.5);
  background: rgba(232,224,220,0.03);
  border-color: rgba(232,224,220,0.07);
}
.ocpv2-tool-status.ocpv2-tool-error {
  color: rgba(220,140,140,0.65);
  background: rgba(220,100,100,0.04);
  border-color: rgba(220,100,100,0.08);
}
.ocpv2-tool-input,
.ocpv2-tool-output {
  margin: 0;
  padding: 10px 12px;
  border-top: 1px solid rgba(255,255,255,0.05);
  background: rgba(0,0,0,0.24);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 10.5px;
  line-height: 1.5;
  color: rgba(255,255,255,0.78);
  max-height: 240px;
  overflow-y: auto;
}
.ocpv2-tool-input { color: rgba(255,255,255,0.55); }
.ocpv2-tool-output.ocpv2-tool-output-error {
  color: rgba(255,166,166,0.9);
  background: rgba(73,14,14,0.26);
  border-color: rgba(255,82,82,0.18);
}

/* ── SynaBun-branded tool cards (OpenCode cream palette) ───────────────── */
@property --ocpv2-sb-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
@keyframes ocpv2-sb-spin { to { --ocpv2-sb-angle: 360deg; } }

.ocpv2-part-tool.ocpv2-tool-synabun {
  position: relative;
  background: rgba(232,224,220,0.025);
  border: 1px solid rgba(232,224,220,0.14);
  border-left: 3px solid rgba(232,224,220,0.4);
  overflow: hidden;
}
.ocpv2-part-tool.ocpv2-tool-synabun:hover {
  border-color: rgba(232,224,220,0.22);
}
.ocpv2-part-tool.ocpv2-tool-synabun[data-status="error"] {
  border-left-color: rgba(220,140,140,0.5);
}
.ocpv2-part-tool.ocpv2-tool-synabun::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 12px;
  padding: 1px;
  background: conic-gradient(
    from var(--ocpv2-sb-angle, 0deg),
    rgba(232,224,220,0.0) 0%,
    rgba(232,224,220,0.35) 25%,
    rgba(232,224,220,0.06) 50%,
    rgba(232,224,220,0.35) 75%,
    rgba(232,224,220,0.0) 100%
  );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  opacity: 0;
  transition: opacity 0.4s;
  pointer-events: none;
  z-index: 1;
}
.ocpv2-part-tool.ocpv2-tool-synabun[data-status="running"]::before,
.ocpv2-part-tool.ocpv2-tool-synabun[data-status="pending"]::before {
  opacity: 1;
  animation: ocpv2-sb-spin 3s linear infinite;
}

.ocpv2-tool-synabun .ocpv2-sb-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
  position: relative;
  z-index: 2;
}
.ocpv2-tool-synabun .ocpv2-sb-head:hover {
  background: rgba(232,224,220,0.04);
}
.ocpv2-tool-synabun .ocpv2-sb-icon {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  background: rgba(232,224,220,0.08);
}
.ocpv2-tool-synabun .ocpv2-sb-icon img {
  display: block;
}
.ocpv2-tool-synabun .ocpv2-sb-titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ocpv2-tool-synabun .ocpv2-sb-name {
  color: rgba(245,239,235,0.92);
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 1.3;
}
.ocpv2-tool-synabun .ocpv2-sb-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(232,224,220,0.45);
  font-size: 10.5px;
  line-height: 1.35;
}
.ocpv2-tool-synabun .ocpv2-sb-chevron {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(232,224,220,0.35);
  transition: transform 0.18s;
  transform: rotate(0deg);
}
.ocpv2-tool-synabun.ocpv2-tool-expanded .ocpv2-sb-chevron {
  transform: rotate(90deg);
}
.ocpv2-tool-synabun .ocpv2-sb-body {
  display: none;
  flex-direction: column;
  border-top: 1px solid rgba(232,224,220,0.08);
  position: relative;
  z-index: 2;
}
.ocpv2-tool-synabun.ocpv2-tool-expanded .ocpv2-sb-body {
  display: flex;
}
.ocpv2-tool-synabun .ocpv2-sb-body .ocpv2-tool-input,
.ocpv2-tool-synabun .ocpv2-sb-body .ocpv2-tool-output {
  border-top: none;
}
.ocpv2-tool-synabun .ocpv2-sb-body .ocpv2-tool-input + .ocpv2-tool-output {
  border-top: 1px solid rgba(232,224,220,0.06);
}

/* ── Part: file chip ───────────────────────────────────────────────────── */
.ocpv2-part-file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 999px;
  font-size: 10.5px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255,255,255,0.62);
  width: fit-content;
}

/* ── Part: step marker ─────────────────────────────────────────────────── */
.ocpv2-part-step {
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.22);
  text-align: center;
  padding: 4px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ocpv2-part-step::before,
.ocpv2-part-step::after {
  content: '';
  flex: 1;
  height: 1px;
  background: rgba(255,255,255,0.06);
}

/* ── Permission card ───────────────────────────────────────────────────── */
.ocpv2-permission {
  background: rgba(232,180,80,0.04);
  border: 1px solid rgba(232,180,80,0.22);
  border-radius: 10px;
  padding: 10px 12px;
}
.ocpv2-permission-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.ocpv2-permission-icon {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  color: rgba(255,200,120,0.85);
}
.ocpv2-permission-icon svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ocpv2-permission-head-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  min-width: 0;
}
.ocpv2-permission-kind {
  font-size: 11.5px;
  font-weight: 500;
  color: rgba(255,200,120,0.92);
  letter-spacing: 0.01em;
}
.ocpv2-permission-action {
  font-size: 10.5px;
  color: rgba(255,255,255,0.55);
}
.ocpv2-permission-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ocpv2-permission-target code {
  display: block;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px;
  color: rgba(255,255,255,0.82);
  background: rgba(0,0,0,0.22);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 6px;
  padding: 6px 8px;
  white-space: pre-wrap;
  word-break: break-all;
}
.ocpv2-permission-patterns {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 10px;
}
.ocpv2-permission-patterns-label {
  color: rgba(255,255,255,0.42);
  margin-right: 2px;
}
.ocpv2-permission-patterns code {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  color: rgba(255,255,255,0.72);
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 4px;
  padding: 2px 5px;
}
.ocpv2-permission-diff summary {
  font-size: 10.5px;
  color: rgba(255,255,255,0.55);
  cursor: pointer;
  padding: 2px 0;
  user-select: none;
}
.ocpv2-permission-diff summary:hover {
  color: rgba(255,255,255,0.85);
}
.ocpv2-permission-diff pre {
  margin: 6px 0 0;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px;
  color: rgba(255,255,255,0.78);
  background: rgba(0,0,0,0.28);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 6px;
  padding: 8px 10px;
  max-height: 240px;
  overflow: auto;
  white-space: pre;
}
.ocpv2-permission-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.ocpv2-permission-btn {
  flex: 1;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.78);
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 10.5px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: all 0.15s;
}
.ocpv2-permission-btn:hover {
  background: rgba(255,255,255,0.08);
  border-color: rgba(255,255,255,0.14);
  color: rgba(255,255,255,0.95);
}
.ocpv2-permission-btn.ocpv2-perm-allow {
  color: rgba(140,200,160,0.85);
  border-color: rgba(140,200,160,0.18);
  background: rgba(140,200,160,0.04);
}
.ocpv2-permission-btn.ocpv2-perm-allow:hover {
  background: rgba(140,200,160,0.08);
  border-color: rgba(140,200,160,0.32);
}
.ocpv2-permission-btn.ocpv2-perm-reject {
  color: rgba(220,140,140,0.82);
  border-color: rgba(220,100,100,0.16);
  background: rgba(220,100,100,0.04);
}
.ocpv2-permission-btn.ocpv2-perm-reject:hover {
  background: rgba(220,100,100,0.1);
  border-color: rgba(220,100,100,0.3);
}
.ocpv2-permission.ocpv2-perm-locked {
  opacity: 0.55;
  pointer-events: none;
}

/* ── Error banner ──────────────────────────────────────────────────────── */
.ocpv2-error-banner {
  background: rgba(220,100,100,0.06);
  border: 1px solid rgba(220,100,100,0.22);
  color: rgba(255,166,166,0.92);
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 11.5px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}

/* ── Empty state ───────────────────────────────────────────────────────── */
.ocpv2-empty {
  color: rgba(255,255,255,0.32);
  text-align: center;
  padding: 40px 16px;
  font-size: 11.5px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.02em;
}
.ocpv2-empty-brand {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 0;
  pointer-events: none;
  user-select: none;
}
.ocpv2-empty-logo {
  width: 32px;
  height: 40px;
  opacity: 0.25;
  color: currentColor;
}
.ocpv2-empty-name {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: rgba(255,255,255,0.35);
}

/* ── Bottom area (input wrap + footer toolbar) — parity with cp / cxp ── */
.ocpv2-compose {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  margin: 0 8px 8px 8px;
  background: rgba(22, 22, 26, 0.95);
  padding-bottom: 4px;
  z-index: 2;
  position: relative;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.06);
}

/* ── Project bar (project + branch dropdowns) — parity with ocp v1 ─────── */
.ocpv2-projectbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px 0;
  flex-shrink: 0;
  position: relative;
  z-index: 10001;
}
.ocpv2-bar-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
.ocpv2-bar-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 5px;
  color: rgba(255,255,255,0.3);
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, transform 0.06s ease;
}
.ocpv2-bar-action:hover {
  color: rgba(255,255,255,0.7);
  background: rgba(255,255,255,0.06);
}
.ocpv2-bar-action:active { transform: scale(0.9); }
.ocpv2-bar-action:disabled { opacity: 0.3; cursor: not-allowed; }
.ocpv2-dropdown {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  background: transparent;
  border: none;
  border-radius: 4px;
  font-size: 9.5px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  cursor: pointer;
  user-select: none;
  padding: 3px 5px;
  transition: background 0.15s;
  max-width: 90px;
  flex-shrink: 1;
  min-width: 0;
}
.ocpv2-dropdown.ocpv2-dropdown-sm { max-width: 72px; }
.ocpv2-dropdown:hover { background: rgba(255,255,255,0.04); }
.ocpv2-dropdown.open { background: rgba(255,255,255,0.06); }
.ocpv2-dd-label {
  color: rgba(255,255,255,0.3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  letter-spacing: 0.02em;
}
.ocpv2-dropdown.has-value .ocpv2-dd-label { color: rgba(232,224,220,0.7); }
.ocpv2-dd-arrow {
  font-size: 7px;
  color: rgba(255,255,255,0.15);
  flex-shrink: 0;
  pointer-events: none;
  transition: transform 0.2s, color 0.2s;
}
.ocpv2-dropdown:hover .ocpv2-dd-arrow { color: rgba(255,255,255,0.3); }
.ocpv2-dropdown.open .ocpv2-dd-arrow {
  transform: rotate(180deg);
  color: rgba(232,224,220,0.55);
}
.ocpv2-dd-menu {
  display: none;
  position: absolute;
  bottom: calc(100% + 4px);
  left: auto;
  right: 0;
  min-width: 200px;
  max-width: 320px;
  max-height: 260px;
  overflow-y: auto;
  overflow-x: hidden;
  background: rgba(22,22,26,0.98);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  z-index: 50;
  padding: 4px;
}
.ocpv2-dd-menu.open { display: block; }
/* Project-bar menus open inside the panel. Anchored to each dropdown's right
   edge, a 200px menu under a 90px dropdown at the panel's left edge spilled
   over whatever sits beside the panel; anchored to the bar it cannot. */
.ocpv2-projectbar .ocpv2-dropdown { position: static; }
.ocpv2-projectbar .ocpv2-dd-menu {
  left: 10px;
  right: auto;
  max-width: min(320px, calc(100% - 20px));
}
.ocpv2-dd-menu::-webkit-scrollbar { width: 4px; }
.ocpv2-dd-menu::-webkit-scrollbar-track { background: transparent; }
.ocpv2-dd-menu::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.08);
  border-radius: 2px;
}
.ocpv2-dd-option {
  padding: 6px 10px;
  border-radius: 5px;
  font-size: 11px;
  color: rgba(255,255,255,0.65);
  cursor: pointer;
  overflow: hidden;
  display: flex;
  align-items: center;
  transition: background 0.1s;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ocpv2-dd-option:hover { background: rgba(255,255,255,0.07); }
.ocpv2-dd-option.selected {
  color: rgba(232,224,220,0.95);
  background: rgba(232,224,220,0.08);
}
.ocpv2-dd-hint {
  margin-left: auto;
  opacity: 0.4;
  font-size: 9px;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

.ocpv2-input-area {
  padding: 8px 8px 2px;
  display: flex;
  gap: 0;
  align-items: flex-end;
  position: relative;
}

/* ── Slash-command suggestions (parity with v1 .ocp-slash-browser) ── */
.ocpv2-slash-browser {
  position: absolute;
  bottom: calc(100% + 2px);
  left: 8px;
  right: 8px;
  background: rgba(20,16,14,0.97);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 10px;
  max-height: 360px;
  display: none;
  flex-direction: column;
  /* Must outrank .ocpv2-projectbar (z-index: 10001) — the projectbar sits in
     normal flow directly above the input-area, so the picker has to win at
     the same stacking layer. */
  z-index: 10050;
  box-shadow: 0 12px 40px rgba(0,0,0,0.55);
  overflow: hidden;
}
.ocpv2-slash-browser.open { display: flex; }
.ocpv2-slash-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: rgba(232,224,220,0.9);
  flex-shrink: 0;
}
.ocpv2-slash-search-icon { color: rgba(232,224,220,0.9); }
.ocpv2-slash-query {
  flex: 1;
  color: rgba(255,255,255,0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-height: 1em;
}
.ocpv2-slash-query:empty::after {
  content: 'type to search…';
  color: rgba(255,255,255,0.25);
}
.ocpv2-slash-count {
  color: rgba(255,255,255,0.35);
  font-size: 11px;
  flex-shrink: 0;
}
.ocpv2-slash-list { overflow-y: auto; padding: 4px 0; }
.ocpv2-slash-list::-webkit-scrollbar { width: 8px; }
.ocpv2-slash-list::-webkit-scrollbar-track { background: transparent; }
.ocpv2-slash-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
.ocpv2-slash-list::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.16); }
.ocpv2-slash-group { padding: 4px 0; }
.ocpv2-slash-group + .ocpv2-slash-group {
  border-top: 1px solid rgba(255,255,255,0.04);
  margin-top: 2px;
}
.ocpv2-slash-group-header {
  padding: 6px 12px 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255,255,255,0.35);
}
.ocpv2-slash-item {
  display: grid;
  grid-template-columns: 14px minmax(0, auto) 1fr;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  transition: background 0.08s;
}
.ocpv2-slash-item.active,
.ocpv2-slash-item:hover { background: rgba(255,255,255,0.06); }
.ocpv2-slash-icon { font-size: 11px; text-align: center; color: rgba(255,255,255,0.4); line-height: 1; }
.ocpv2-slash-icon[data-source="builtin"] { color: rgba(232,224,220,0.85); }
.ocpv2-slash-icon[data-source="skill"]   { color: rgba(120,200,255,0.85); }
.ocpv2-slash-icon[data-source="user"]    { color: rgba(160,220,150,0.9); }
.ocpv2-slash-name {
  color: rgba(232,224,220,0.92);
  font-weight: 500;
  white-space: nowrap;
}
.ocpv2-slash-name .ocpv2-slash-hl {
  color: rgba(255,255,255,1);
  font-weight: 700;
}
.ocpv2-slash-desc {
  color: rgba(255,255,255,0.4);
  font-size: 11px;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.ocpv2-slash-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: rgba(120,200,255,0.85);
  background: rgba(120,200,255,0.10);
  border: 1px solid rgba(120,200,255,0.18);
  vertical-align: 1px;
}
.ocpv2-slash-empty {
  padding: 16px 12px;
  color: rgba(255,255,255,0.4);
  font-size: 12px;
  text-align: center;
  font-family: 'JetBrains Mono', monospace;
}

/* Image strip — chips for whiteboard-attached / pending images, sits above
   the input area inside the compose card (parity with Codex / OCP v1). */
.ocpv2-image-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 8px 12px 0;
}
.ocpv2-image-strip[hidden] { display: none; }
.ocpv2-image-strip::-webkit-scrollbar,
.ocpv2-path-strip::-webkit-scrollbar { height: 4px; }
.ocpv2-image-strip::-webkit-scrollbar-track,
.ocpv2-path-strip::-webkit-scrollbar-track { background: transparent; }
.ocpv2-image-strip::-webkit-scrollbar-thumb,
.ocpv2-path-strip::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.08);
  border-radius: 999px;
}
.ocpv2-path-strip {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 8px 12px 0;
}
.ocpv2-path-strip[hidden] { display: none; }
.ocpv2-path-chip {
  min-width: 0;
  max-width: 100%;
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px 0 8px;
  border-radius: 7px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.045);
  color: rgba(232,224,220,0.86);
  font-size: 11px;
  line-height: 1;
}
.ocpv2-path-chip-icon {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  color: rgba(232,224,220,0.62);
}
.ocpv2-path-chip-icon svg {
  width: 13px;
  height: 13px;
  display: block;
}
.ocpv2-path-chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ocpv2-path-chip-remove {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 50%;
  padding: 0;
  background: rgba(0,0,0,0.28);
  color: rgba(232,224,220,0.72);
  cursor: pointer;
  font-size: 11px;
  line-height: 16px;
}
.ocpv2-path-chip-remove:hover {
  background: rgba(0,0,0,0.48);
  color: rgba(255,255,255,0.92);
}
.ocpv2-image-chip {
  position: relative;
  width: 54px;
  height: 54px;
  flex: 0 0 auto;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(0,0,0,0.4);
}
.ocpv2-image-chip img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.ocpv2-image-chip-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0,0,0,0.6);
  color: #fff;
  border: 0;
  padding: 0;
  cursor: pointer;
  font-size: 14px;
  line-height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ocpv2-image-chip-remove:hover { background: rgba(0,0,0,0.78); }

/* Inline preview inside a message bubble (user-sent or assistant-echoed) */
.ocpv2-part-image-wrap {
  display: block;
  margin-top: 4px;
  max-width: 100%;
}
.ocpv2-part-image-wrap img,
img.ocpv2-part-image {
  max-width: 240px;
  max-height: 200px;
  width: auto;
  height: auto;
  display: block;
  border-radius: 8px;
  object-fit: contain;
  background: rgba(0,0,0,0.25);
  border: 1px solid rgba(255,255,255,0.06);
}
.ocpv2-msg-user .ocpv2-part-image-wrap { margin-top: 6px; }
.ocpv2-msg-user img.ocpv2-part-image {
  max-width: 240px;
  max-height: 200px;
}

/* Tool result image (browser_screenshot / card_screenshot / whiteboard_screenshot / etc) */
.ocpv2-tool-output-image {
  padding: 6px 0 0;
  margin: 0;
}
img.ocpv2-tool-screenshot {
  display: block;
  max-width: 100%;
  max-height: 320px;
  width: auto;
  height: auto;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(0,0,0,0.25);
  object-fit: contain;
  cursor: zoom-in;
}

/* Animated conic-gradient border wrapper — cream highlight on focus */
@property --ocpv2-border-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
@keyframes ocpv2-border-spin {
  to { --ocpv2-border-angle: 360deg; }
}
.ocpv2-input-wrap {
  flex: 1;
  position: relative;
  border-radius: 14px;
  padding: 1px;
  background: rgba(255,255,255,0.05);
  transition: background 0.4s;
  min-width: 0;
  overflow: hidden;
}
.ocpv2-input-wrap::before {
  content: '';
  position: absolute; inset: 0;
  border-radius: 14px;
  padding: 1px;
  pointer-events: none;
  background: conic-gradient(
    from var(--ocpv2-border-angle, 0deg),
    rgba(232,224,220,0.0) 0%,
    rgba(232,224,220,0.45) 25%,
    rgba(232,224,220,0.10) 50%,
    rgba(232,224,220,0.45) 75%,
    rgba(232,224,220,0.0) 100%
  );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  opacity: 0;
  transition: opacity 0.4s;
}
.ocpv2-input-wrap:focus-within::before {
  opacity: 1;
  animation: ocpv2-border-spin 3s linear infinite;
}
.ocpv2-input-wrap:focus-within {
  background: rgba(232,224,220,0.04);
  box-shadow: 0 0 20px rgba(232,224,220,0.05), 0 0 60px rgba(232,224,220,0.02);
}

.ocpv2-input-inner {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  padding: 5px 5px 5px 14px;
  border-radius: 13px;
  background: rgba(12,12,16,0.9);
  position: relative;
}

.ocpv2-compose-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  color: rgba(255,255,255,0.9);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 12.5px;
  line-height: 1.55;
  padding: 6px 0;
  max-height: 180px;
  overflow-y: auto;
  overflow-wrap: break-word;
  word-break: break-word;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
  transition: scrollbar-color 0.3s;
}
.ocpv2-compose-input:hover,
.ocpv2-compose-input:focus {
  scrollbar-color: rgba(255,255,255,0.08) transparent;
}
.ocpv2-compose-input::-webkit-scrollbar { width: 4px; }
.ocpv2-compose-input::-webkit-scrollbar-track { background: transparent; }
.ocpv2-compose-input::-webkit-scrollbar-thumb { background: transparent; border-radius: 4px; }
.ocpv2-compose-input:hover::-webkit-scrollbar-thumb,
.ocpv2-compose-input:focus::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); }
.ocpv2-compose-input::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }
.ocpv2-compose-input::placeholder { color: rgba(255,255,255,0.18); transition: color 0.3s; }
.ocpv2-compose-input:focus::placeholder { color: rgba(255,255,255,0.24); }
.ocpv2-compose-input::selection { background: rgba(232,224,220,0.3); color: inherit; }

/* Send button — flat 28x28 square with cream sweep fill on enable */
.ocpv2-compose-btn {
  width: 28px;
  height: 28px;
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
  background: transparent;
  color: rgba(255,255,255,0.15);
  cursor: pointer;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: sticky;
  bottom: 3px;
  align-self: flex-end;
  overflow: hidden;
  transition: all 0.25s cubic-bezier(0.22, 0.68, 0, 1.2);
  padding: 0;
  font: inherit;
}
.ocpv2-compose-btn::before {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(135deg, rgba(232,224,220,0.16), rgba(232,224,220,0.04));
  border-radius: 7px;
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.3s cubic-bezier(0.22, 0.68, 0, 1.2);
}
.ocpv2-compose-btn:not(:disabled)::before {
  transform: scaleX(1);
}
.ocpv2-compose-btn:not(:disabled) {
  color: rgba(245,239,232,0.92);
  border-color: rgba(232,224,220,0.22);
}
.ocpv2-compose-btn:hover:not(:disabled) {
  border-color: rgba(232,224,220,0.4);
  color: rgba(252,246,240,0.98);
  box-shadow: 0 0 12px rgba(232,224,220,0.12);
  transform: translateY(-1px);
}
.ocpv2-compose-btn:hover:not(:disabled)::before {
  background: linear-gradient(135deg, rgba(232,224,220,0.26), rgba(232,224,220,0.08));
}
.ocpv2-compose-btn:active:not(:disabled) {
  transform: translateY(0px) scale(0.95);
  transition-duration: 0.08s;
}
.ocpv2-compose-btn:disabled { opacity: 0.4; cursor: default; }
.ocpv2-compose-btn svg {
  width: 12px;
  height: 12px;
  position: relative;
  z-index: 1;
  display: block;
}
.ocpv2-compose-btn .ocpv2-send-icon { display: inline-flex; align-items: center; justify-content: center; }
.ocpv2-compose-btn .ocpv2-stop-icon { display: none; align-items: center; justify-content: center; }

/* Abort/running state — red sweep + stop icon */
.ocpv2-compose-btn.ocpv2-compose-abort {
  border-color: rgba(255,70,70,0.2);
  color: rgba(255,100,100,0.85);
}
.ocpv2-compose-btn.ocpv2-compose-abort::before {
  transform: scaleX(1);
  background: linear-gradient(135deg, rgba(255,70,70,0.18), rgba(255,50,50,0.05));
  animation: ocpv2-abort-sweep 2s ease-in-out infinite;
}
.ocpv2-compose-btn.ocpv2-compose-abort:hover {
  color: #ff6666;
  border-color: rgba(255,70,70,0.4);
  box-shadow: 0 0 12px rgba(255,70,70,0.14);
  transform: translateY(-1px);
}
.ocpv2-compose-btn.ocpv2-compose-abort:active {
  transform: translateY(0px) scale(0.95);
}
.ocpv2-compose-btn.ocpv2-compose-abort .ocpv2-send-icon { display: none; }
.ocpv2-compose-btn.ocpv2-compose-abort .ocpv2-stop-icon { display: inline-flex; }
@keyframes ocpv2-abort-sweep {
  0%, 100% { opacity: 0.6; }
  50%      { opacity: 1; }
}

/* ── Footer toolbar — status-bar style row ──────────────────────────────── */
.ocpv2-footer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: nowrap;
  gap: 0;
  padding: 4px 10px 2px;
  flex-shrink: 0;
}
.ocpv2-footer-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.ocpv2-footer-right {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.ocpv2-brand-link {
  display: inline-flex;
  align-items: center;
  color: inherit;
  text-decoration: none;
  line-height: 0;
  flex-shrink: 0;
  opacity: 0.4;
  transition: opacity 0.15s;
}
.ocpv2-brand-link:hover { opacity: 0.85; }
.ocpv2-brand {
  width: 14px;
  height: 14px;
  color: rgba(232,224,220,0.92);
  filter: drop-shadow(0 0 6px rgba(232,224,220,0.18));
  flex-shrink: 0;
}
.ocpv2-mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 2px;
  border-radius: 7px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.035);
  flex-shrink: 0;
}
.ocpv2-mode-btn {
  height: 18px;
  padding: 0 8px;
  border-radius: 5px;
  border: 0;
  background: transparent;
  color: rgba(232,224,220,0.55);
  font: inherit;
  font-size: 10.5px;
  line-height: 18px;
  cursor: pointer;
}
.ocpv2-mode-btn:hover:not(:disabled) {
  color: rgba(232,224,220,0.88);
  background: rgba(255,255,255,0.045);
}
.ocpv2-mode-btn.active {
  color: rgba(255,255,255,0.94);
  background: rgba(232,224,220,0.16);
}
.ocpv2-mode-btn:disabled {
  cursor: default;
  opacity: 0.7;
}

/* ── Variant (reasoning effort) picker ──────────────────────────────────── */
#ocpv2-variant-dd {
  max-width: 110px;
  gap: 4px;
}
#ocpv2-variant-dd .ocpv2-variant-icon {
  display: inline-flex;
  align-items: center;
  color: rgba(232,224,220,0.45);
  flex-shrink: 0;
}
#ocpv2-variant-dd:hover .ocpv2-variant-icon,
#ocpv2-variant-dd.has-value .ocpv2-variant-icon {
  color: rgba(232,224,220,0.85);
}
#ocpv2-variant-dd .ocpv2-dd-menu {
  width: 160px;
  min-width: 140px;
  max-width: 180px;
  max-height: 240px;
  bottom: calc(100% + 6px);
  right: 0;
  padding: 4px;
  background: linear-gradient(180deg, rgba(26,27,31,0.98) 0%, rgba(18,19,22,0.985) 100%);
  border-color: rgba(255,255,255,0.12);
  box-shadow: 0 14px 42px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
  backdrop-filter: blur(14px) saturate(1.1);
  -webkit-backdrop-filter: blur(14px) saturate(1.1);
}
#ocpv2-variant-dd .ocpv2-dd-menu.open {
  animation: ocpv2-model-menu-in 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
  transform-origin: bottom right;
}
.ocpv2-dd-variant-name {
  text-transform: capitalize;
  letter-spacing: 0.02em;
}

/* ── Model picker (footer-right) ────────────────────────────────────────── */
#ocpv2-model-dd { max-width: 180px; }
#ocpv2-model-dd.open { z-index: 10002; }
@keyframes ocpv2-model-menu-in {
  from { opacity: 0; transform: translateY(4px) scale(0.985); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes ocpv2-cap-help-in {
  from { opacity: 0; transform: translateY(-3px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes ocpv2-cap-help-swap {
  0%   { opacity: 0.45; transform: translateY(-1px); filter: blur(0.4px); }
  55%  { opacity: 1;    transform: translateY(0);    filter: blur(0); }
  100% { opacity: 1;    transform: translateY(0);    filter: blur(0); }
}
#ocpv2-model-dd .ocpv2-dd-menu {
  width: min(520px, calc(100vw - 28px));
  max-width: min(520px, calc(100vw - 28px));
  max-height: 460px;
  bottom: calc(100% + 10px);
  right: 0;
  padding: 0 4px 4px;
  background: linear-gradient(180deg, rgba(26,27,31,0.98) 0%, rgba(18,19,22,0.985) 100%);
  border-color: rgba(255,255,255,0.12);
  box-shadow: 0 22px 70px rgba(0,0,0,0.52), inset 0 1px 0 rgba(255,255,255,0.055);
  backdrop-filter: blur(18px) saturate(1.12);
  -webkit-backdrop-filter: blur(18px) saturate(1.12);
}
#ocpv2-model-dd .ocpv2-dd-menu.open {
  animation: ocpv2-model-menu-in 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
  transform-origin: bottom right;
}
.ocpv2-dd-header {
  position: sticky;
  top: 0;
  z-index: 3;
  background: linear-gradient(180deg, rgba(28,29,34,0.98) 0%, rgba(22,23,27,0.96) 100%);
  border-radius: 8px 8px 0 0;
  border-bottom: 1px solid rgba(255,255,255,0.09);
  box-shadow: 0 10px 24px rgba(0,0,0,0.16);
}
.ocpv2-model-search {
  width: calc(100% + 8px);
  box-sizing: border-box;
  margin: 0 -4px;
  padding: 9px 30px 9px 12px;
  background: transparent;
  border: none;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px 8px 0 0;
  color: rgba(255,255,255,0.92);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  outline: none;
}
.ocpv2-model-search:focus {
  background: rgba(255,255,255,0.025);
  box-shadow: inset 0 -1px 0 rgba(247,244,239,0.14);
}
.ocpv2-model-search::placeholder { color: rgba(255,255,255,0.3); }
.ocpv2-cap-filter-toggle {
  position: absolute;
  right: 6px;
  top: 4px;
  width: 22px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: rgba(255,255,255,0.2);
  cursor: pointer;
  padding: 0;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.ocpv2-cap-filter-toggle:hover {
  color: rgba(255,255,255,0.45);
  background: rgba(255,255,255,0.05);
}
.ocpv2-cap-filter-toggle.collapsed { color: rgba(255,255,255,0.12); }
.ocpv2-cap-filter-toggle.has-active { color: rgba(232,224,220,0.7); }
.ocpv2-cap-filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 34px 7px 8px;
  background: rgba(255,255,255,0.01);
}
.ocpv2-cap-filter-bar--hidden { display: none; }
.ocpv2-cap-filter {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
  font-size: 9px;
  font-family: inherit;
  line-height: 1;
  padding: 3px 7px 3px 4px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.075);
  font-weight: 700;
  letter-spacing: 0;
  cursor: pointer;
  color: rgba(255,255,255,0.52);
  background: rgba(255,255,255,0.028);
  opacity: 1;
  transition: color 0.15s, background 0.15s, border-color 0.15s, transform 0.15s, box-shadow 0.15s;
  user-select: none;
}
.ocpv2-cap-filter:hover {
  color: rgba(255,255,255,0.78);
  background: rgba(255,255,255,0.055);
  border-color: rgba(255,255,255,0.13);
  transform: translateY(-1px);
}
.ocpv2-cap-filter.active {
  color: rgba(247,244,239,0.94);
  background: rgba(255,255,255,0.105);
  border-color: rgba(255,255,255,0.22);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 6px 16px rgba(0,0,0,0.18);
  transform: translateY(-1px);
}
.ocpv2-cap-filter-all { padding: 3px 9px; }
.ocpv2-cap-filter-letter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  font-size: 8.5px;
  font-weight: 800;
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  letter-spacing: 0;
  color: rgba(255,255,255,0.62);
  background: rgba(255,255,255,0.07);
  flex-shrink: 0;
}
.ocpv2-cap-filter.active .ocpv2-cap-filter-letter {
  color: rgba(18,19,22,0.94);
  background: rgba(247,244,239,0.88);
}
.ocpv2-cap-help {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 8px 8px;
  padding: 7px 9px;
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 6px;
  background: linear-gradient(90deg, rgba(255,255,255,0.045), rgba(255,255,255,0.018));
  color: rgba(255,255,255,0.52);
  font-size: 10.5px;
  line-height: 1.4;
  min-height: 32px;
  animation: ocpv2-cap-help-in 140ms ease-out;
  transition:
    opacity 180ms ease,
    max-height 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
    margin 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
    padding 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
    border-color 180ms ease,
    background 180ms ease;
  max-height: 80px;
  overflow: hidden;
}
.ocpv2-cap-help--active {
  border-color: rgba(255,255,255,0.11);
  background: linear-gradient(90deg, rgba(255,255,255,0.075), rgba(255,255,255,0.03));
}
.ocpv2-cap-help--collapsed {
  opacity: 0;
  max-height: 0;
  margin-top: 0;
  margin-bottom: 0;
  padding-top: 0;
  padding-bottom: 0;
  border-top-width: 0;
  border-bottom-width: 0;
  pointer-events: none;
}
.ocpv2-cap-help--swap { animation: ocpv2-cap-help-swap 180ms ease-out; }
.ocpv2-cap-help-title {
  flex: 0 0 auto;
  color: rgba(247,244,239,0.9);
  font-weight: 800;
}
.ocpv2-cap-help-text {
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: normal;
}
.ocpv2-dd-group-label {
  font-size: 9px;
  letter-spacing: 0;
  text-transform: uppercase;
  color: rgba(255,255,255,0.32);
  padding: 6px 10px 3px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-weight: 600;
}
.ocpv2-dd-fav-label { color: rgba(251,191,36,0.5) !important; }
.ocpv2-dd-sep {
  height: 1px;
  background: rgba(255,255,255,0.06);
  margin: 4px 8px;
}
.ocpv2-dd-model-option {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto 18px;
  grid-auto-flow: row;
  gap: 8px;
  align-items: center;
  min-height: 34px;
  padding: 7px 10px;
  border: 1px solid transparent;
  transition: background 0.13s ease, border-color 0.13s ease, transform 0.13s ease;
}
.ocpv2-dd-model-name + .ocpv2-dd-model-meta:empty { display: none; }
.ocpv2-dd-caps:empty { display: none; }
.ocpv2-dd-model-option:hover {
  background: rgba(255,255,255,0.055);
  border-color: rgba(255,255,255,0.055);
  transform: translateX(1px);
}
.ocpv2-dd-model-option.selected {
  background: rgba(255,255,255,0.075);
  border-color: rgba(255,255,255,0.105);
}
.ocpv2-dd-model-name {
  font-size: 11.5px;
  font-weight: 600;
  color: rgba(255,255,255,0.78);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.ocpv2-dd-model-option.selected .ocpv2-dd-model-name { color: rgba(232,224,220,0.96); }
.ocpv2-dd-caps {
  display: inline-flex;
  flex-wrap: nowrap;
  justify-content: flex-end;
  gap: 3px;
  opacity: 0.6;
  transition: opacity 0.15s;
}
.ocpv2-dd-model-option:hover .ocpv2-dd-caps,
.ocpv2-dd-model-option.selected .ocpv2-dd-caps { opacity: 1; }
.ocpv2-cap {
  display: inline-flex;
  align-items: center;
  font-size: 8.5px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 5px;
  font-weight: 700;
  letter-spacing: 0;
  white-space: nowrap;
  color: rgba(255,255,255,0.42);
  background: rgba(255,255,255,0.045);
  border: 1px solid rgba(255,255,255,0.055);
}
.ocpv2-dd-model-option:hover .ocpv2-cap,
.ocpv2-dd-model-option.selected .ocpv2-cap {
  color: rgba(255,255,255,0.66);
  background: rgba(255,255,255,0.065);
  border-color: rgba(255,255,255,0.09);
}
.ocpv2-dd-star {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: rgba(255,255,255,0.18);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 4px;
  opacity: 0.22;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}
.ocpv2-dd-model-option:hover .ocpv2-dd-star { opacity: 1; }
.ocpv2-dd-star:hover { color: rgba(232,224,220,0.6); background: rgba(255,255,255,0.06); }
.ocpv2-dd-star.active { color: rgba(247,244,239,0.72); opacity: 1; }
.ocpv2-dd-star.active:hover { color: rgba(255,220,120,1); }
.ocpv2-dd-empty {
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 6px;
  padding: 11px 10px;
  border: 1px dashed rgba(255,255,255,0.08);
  border-radius: 6px;
  background: rgba(255,255,255,0.018);
  color: rgba(255,255,255,0.42);
  font-size: 11px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.ocpv2-dd-empty-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ocpv2-dd-empty-clear {
  appearance: none;
  flex: 0 0 auto;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 5px;
  background: rgba(255,255,255,0.035);
  color: rgba(255,255,255,0.58);
  font: inherit;
  font-size: 10px;
  line-height: 1;
  padding: 5px 7px;
  cursor: pointer;
}
.ocpv2-dd-empty-clear:hover {
  color: rgba(255,255,255,0.82);
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.14);
}
`;

// ── Child sub-agent panel (spawned by ocp-v2-manager) ────────────────────
const CHILD_CSS = `
.ocpv2-panel-child {
  /* Stack to the LEFT of any panels reserved before us. The right offset is
     set inline via --right-panel-offset-{owner}. */
  border: 0.5px dashed rgba(180, 200, 255, 0.18);
}
.ocpv2-panel-child .ocpv2-child-crumbs {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  flex-shrink: 1;
  overflow: hidden;
  margin-right: 6px;
}
.ocpv2-panel-child .ocpv2-child-crumbs:empty { display: none; }
.ocpv2-panel-child .ocpv2-child-crumb-sep {
  flex-shrink: 0;
  color: rgba(180, 200, 255, 0.4);
  font-size: 10px;
}
.ocpv2-panel-child .ocpv2-child-crumb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 6px;
  color: rgba(180, 200, 255, 0.65);
  font: inherit;
  font-size: 10.5px;
  padding: 2px 6px 2px 4px;
  cursor: pointer;
  max-width: 140px;
  min-width: 26px;
  flex-shrink: 1;
  overflow: hidden;
}
.ocpv2-panel-child .ocpv2-child-crumb:hover {
  color: rgba(200, 215, 255, 0.9);
  border-color: rgba(180, 200, 255, 0.18);
}
.ocpv2-panel-child .ocpv2-child-parent-arrow {
  display: inline-flex;
  width: 10px;
  height: 10px;
  opacity: 0.7;
}
.ocpv2-panel-child .ocpv2-child-parent-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Sub-agent pill: physically docked to its parent. Anchored to the parent's
   right edge, top-right squared, and lifted up to kiss the parent's bottom
   border so the pair reads as one stacked unit instead of two floating pills.
   Hover slides it leftward with a soft spring — since the tray is right-aligned,
   "out" means "left", which is what makes the pop feel graceful.
   The squared-corner + negative-margin "docking" geometry is gated behind
   .ocpv2-pill-docked so a child pill standing alone in the tray (parent
   panel open, parent not minimized) renders as a normal pill instead of a
   broken half-rectangle floating into the tray's edge. */
.ocpv2-session-pill.ocpv2-pill-has-child.ocpv2-pill-parent-docked {
  border-bottom-right-radius: 0;
}
.ocpv2-session-pill-child {
  border-color: rgba(180, 200, 255, 0.32) !important;
  background: rgba(20, 24, 40, 0.78);
  position: relative;
  z-index: 0;
  transition: transform 0.32s cubic-bezier(0.34, 1.25, 0.5, 1),
              border-color 0.2s,
              box-shadow 0.25s;
}
.ocpv2-session-pill-child.ocpv2-pill-docked {
  margin-right: 0;
  margin-top: -5px;
  border-top-right-radius: 0;
}
/* One pill per sub-agent of the session the main panel shows, in the order
   they were started, in one group under their parent's pill. The group is
   bounded (eight rows): with many sub-agents it scrolls instead of growing
   down the page, so the tray never reaches the compose box. */
.ocpv2-subagent-pills {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  max-height: min(310px, 45vh);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 2px 0 2px 14px;
  scrollbar-width: thin;
  scrollbar-color: rgba(180, 200, 255, 0.28) transparent;
  overscroll-behavior: contain;
}
.ocpv2-subagent-pills.ocpv2-pills-docked {
  margin-top: -5px;
  padding-top: 0;
}
.ocpv2-subagent-pills > .term-minimized-pill { flex-shrink: 0; }
.ocpv2-subagent-pills .ocpv2-session-pill-child:hover { transform: none; }
/* A sub-agent of a sub-agent sits a step in from the edge. */
.ocpv2-session-pill-child[data-depth="1"] { margin-right: 10px; }
.ocpv2-session-pill-child[data-depth="2"] { margin-right: 20px; }
.ocpv2-session-pill-child[data-depth="3"] { margin-right: 30px; }
/* How many there are and how many need attention: shown once the group scrolls. */
.ocpv2-subagent-summary {
  position: sticky;
  top: 0;
  z-index: 2;
  flex-shrink: 0;
  /* As wide as the group, so the pills scroll under it and not beside it. */
  align-self: stretch;
  text-align: right;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid rgba(180, 200, 255, 0.18);
  background: rgba(14, 16, 26, 0.97);
  color: rgba(200, 215, 255, 0.8);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  white-space: nowrap;
}
.ocpv2-subagent-summary[hidden] { display: none; }
.ocpv2-subagent-summary.ocpv2-summary-waiting {
  color: #ffd591;
  border-color: rgba(245, 165, 36, 0.55);
}
/* Waiting for an answer: the one state that needs the user. */
.ocpv2-session-pill-child.ocpv2-pill-waiting {
  border-color: rgba(245, 165, 36, 0.85) !important;
  animation: ocpv2-pill-waiting 1.6s ease-in-out infinite;
}
.ocpv2-session-pill-child.ocpv2-pill-waiting .term-minimized-pill-icon { color: #f5a524; }
@keyframes ocpv2-pill-waiting {
  0%, 100% { box-shadow: 0 0 0 1px rgba(245, 165, 36, 0.25), 0 0 8px rgba(245, 165, 36, 0.2); }
  50%      { box-shadow: 0 0 0 1px rgba(245, 165, 36, 0.5), 0 0 16px rgba(245, 165, 36, 0.5); }
}
.ocpv2-session-pill-child.ocpv2-pill-failed { border-color: rgba(217, 59, 59, 0.6) !important; }
/* The sub-agent whose panel is the one on screen. */
.ocpv2-session-pill-child.ocpv2-pill-shown {
  border-color: rgba(200, 215, 255, 0.9) !important;
  background: rgba(46, 58, 96, 0.92);
}
.ocpv2-session-pill-child.ocpv2-pill-shown .term-minimized-pill-label { color: #fff; }
.ocpv2-session-pill-child .term-minimized-pill-icon { color: rgba(180, 200, 255, 0.7); }
.ocpv2-session-pill-child.ocpv2-pill-running .term-minimized-pill-icon { color: rgba(200, 215, 255, 1); }
.ocpv2-session-pill-child:hover {
  transform: translateX(-8px);
  border-color: rgba(180, 200, 255, 0.55) !important;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(180, 200, 255, 0.16);
  z-index: 1;
}
/* Sub-agent spawn entrance — pill slides in from the right with a soft glow
   burst so the transition from "parent only" → "parent + child" is obvious.
   Class is removed after ~1.6s by the child panel so subsequent hover/idle
   states aren't shadowed by the glow. */
.ocpv2-session-pill-child.ocpv2-pill-spawning {
  animation: ocpv2-child-pill-spawn 0.55s cubic-bezier(0.34, 1.18, 0.5, 1) both;
  box-shadow: 0 0 0 1px rgba(180, 200, 255, 0.55),
              0 0 22px rgba(180, 200, 255, 0.45),
              0 6px 22px rgba(0, 0, 0, 0.38);
}
.ocpv2-session-pill-child.ocpv2-pill-spawning::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  pointer-events: none;
  background: radial-gradient(120% 80% at 100% 50%, rgba(180,200,255,0.30), transparent 60%);
  animation: ocpv2-child-pill-flash 1.4s ease-out forwards;
}
@keyframes ocpv2-child-pill-spawn {
  0%   { transform: translateX(28px) scale(0.85); opacity: 0; }
  55%  { transform: translateX(-4px) scale(1.02); opacity: 1; }
  100% { transform: translateX(0)    scale(1);    opacity: 1; }
}
@keyframes ocpv2-child-pill-flash {
  0%   { opacity: 0.9; }
  100% { opacity: 0;   }
}

/* Parent pill nudge when a sub-agent is attached — a subtle leftward shimmy
   on attach so the user's eye is drawn to the new pair, not just the new pill.
   Triggered by ocpv2-pill-spawning being toggled OFF after the child lands. */
.ocpv2-session-pill.ocpv2-pill-has-child {
  transition: transform 0.4s cubic-bezier(0.34, 1.2, 0.5, 1),
              border-color 0.2s, box-shadow 0.2s;
}

/* Child panel entrance — when the user clicks the child pill to expand it,
   the panel slides in like the primary but also briefly tints with the
   sub-agent accent so the user can tell at a glance "this is the child, not
   the parent that was just here." */
.ocpv2-panel-child.ocpv2-open {
  animation: ocpv2-child-panel-flash 0.9s ease-out;
}
@keyframes ocpv2-child-panel-flash {
  0%   { box-shadow:
          0 0 0 1px rgba(180, 200, 255, 0.55),
          0 0 32px rgba(180, 200, 255, 0.35),
          0 1px 2px rgba(0,0,0,0.15),
          0 12px 24px rgba(0,0,0,0.14),
          0 32px 64px rgba(0,0,0,0.18); }
  100% { box-shadow:
          0 0 0 0.5px rgba(0,0,0,0.3),
          0 1px 2px rgba(0,0,0,0.15),
          0 4px 8px rgba(0,0,0,0.12),
          0 12px 24px rgba(0,0,0,0.14),
          0 32px 64px rgba(0,0,0,0.18); }
}
.ocpv2-pill-badge {
  display: none;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  margin-left: 4px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  background: rgba(255,255,255,0.16);
}
.ocpv2-pill-badge[data-kind]:not([data-kind=""]) {
  display: inline-flex;
}
.ocpv2-pill-badge[data-kind="question"]   { background: #2f6bff; }
.ocpv2-pill-badge[data-kind="permission"] { background: #f5a524; color: #1a1208; }
.ocpv2-pill-badge[data-kind="error"]      { background: #d93b3b; }
.ocpv2-pill-badge[data-kind="done"]       { background: rgba(80, 200, 120, 0.85); }
`;

// Rules for the SDK 1.18 surfaces (errors, retries, compaction, the approval
// queue). Same palette as above: white alphas, the amber of the permission
// card, the red of the error banner, the blue of the running states.
const PARITY_CSS = `
/* ── Notes: subtask / agent / patch markers, retries, "Stopped" ───────── */
.ocpv2-part-note {
  font-size: 10.5px;
  color: rgba(255,255,255,0.4);
  padding: 4px 2px;
  overflow-wrap: anywhere;
}
.ocpv2-part-note-warn { color: rgba(255,200,120,0.8); }

/* ── Live reasoning preview ───────────────────────────────────────────── */
.ocpv2-thinking-live { display: flex; flex-direction: column; gap: 2px; }
.ocpv2-thinking-preview {
  font-size: 10.5px;
  color: rgba(255,255,255,0.4);
  padding: 0 2px 2px 16px;
  max-height: 3.2em;
  overflow: hidden;
  overflow-wrap: anywhere;
}

/* ── Per-message error ────────────────────────────────────────────────── */
.ocpv2-message-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  background: rgba(220,100,100,0.06);
  border: 1px solid rgba(220,100,100,0.22);
  color: rgba(255,166,166,0.92);
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 11px;
}
.ocpv2-message-error-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ocpv2-inline-action {
  flex-shrink: 0;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.78);
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 10px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.02em;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.15s;
}
.ocpv2-inline-action:hover:not(:disabled) {
  background: rgba(255,255,255,0.08);
  border-color: rgba(255,255,255,0.14);
  color: rgba(255,255,255,0.95);
}
.ocpv2-inline-action:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── Error banner: dismissible ────────────────────────────────────────── */
.ocpv2-error-banner { display: flex; align-items: flex-start; gap: 8px; }
.ocpv2-error-banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ocpv2-error-banner-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  color: rgba(255,166,166,0.6);
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
}
.ocpv2-error-banner-dismiss:hover { color: rgba(255,166,166,1); }

/* ── Retry banner ─────────────────────────────────────────────────────── */
.ocpv2-retry-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  background: rgba(120,170,255,0.08);
  border: 1px solid rgba(120,170,255,0.35);
  color: rgba(180,205,255,0.95);
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 11px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.ocpv2-retry-title { font-weight: 600; }
.ocpv2-retry-message { flex: 1; min-width: 0; color: rgba(255,255,255,0.62); overflow-wrap: anywhere; }

/* ── Permission card: origin, what "Always" remembers, reject reason ──── */
.ocpv2-permission-origin {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 9px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgba(255,200,120,0.95);
  border: 1px solid rgba(232,180,80,0.22);
  border-radius: 999px;
  padding: 1px 7px;
}
.ocpv2-permission-always,
.ocpv2-permission-more {
  font-size: 10px;
  color: rgba(255,255,255,0.4);
  overflow-wrap: anywhere;
}
.ocpv2-permission-always code { color: rgba(255,255,255,0.62); }
.ocpv2-permission-more { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
.ocpv2-permission-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: rgba(255,255,255,0.55);
  text-decoration: underline;
  cursor: pointer;
}
.ocpv2-permission-link:hover { color: rgba(255,255,255,0.9); }
.ocpv2-permission-reason { display: flex; gap: 6px; }
.ocpv2-permission-reason[hidden] { display: none; }
.ocpv2-permission-reason-input {
  flex: 1;
  min-width: 0;
  background: rgba(0,0,0,0.25);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.92);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
  font-size: 11px;
  outline: none;
}
.ocpv2-permission-reason-input:focus { border-color: rgba(232,224,220,0.4); background: rgba(0,0,0,0.4); }
.ocpv2-permission-reason .ocpv2-permission-btn { flex: 0 0 auto; }

/* ── Message actions (copy / undo / fork / delete / retry) ───────────── */
.ocpv2-msg-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.ocpv2-msg:hover .ocpv2-msg-actions,
.ocpv2-msg:hover + .ocpv2-msg-actions-row .ocpv2-msg-actions,
.ocpv2-msg-actions:focus-within { opacity: 1; }
.ocpv2-msg-actions-row { padding-top: 0; padding-bottom: 0; }
.ocpv2-msg-action {
  background: none;
  border: none;
  padding: 0;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
}
.ocpv2-msg-action:hover:not(:disabled) { color: rgba(255,255,255,0.9); }
.ocpv2-msg-action:disabled { opacity: 0.4; cursor: default; }
.ocpv2-msg-action[data-action="delete"]:hover:not(:disabled) { color: rgba(255,166,166,0.92); }

/* ── Copy button on code blocks ───────────────────────────────────────── */
.ocpv2-code-block { position: relative; }
.ocpv2-code-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(22, 22, 26, 0.95);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.55);
  border-radius: 6px;
  padding: 1px 6px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 9px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.ocpv2-code-block:hover .ocpv2-code-copy,
.ocpv2-code-copy:focus { opacity: 1; }
.ocpv2-code-copy:hover { color: rgba(255,255,255,0.9); }

/* ── Reverted (undone) banner: the retry banner in neutral tones ──────── */
.ocpv2-revert-banner {
  background: rgba(255,255,255,0.04);
  border-color: rgba(255,255,255,0.08);
}

/* ── Session menu: search, sections, per-item actions ─────────────────── */
.ocpv2-session-search {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  gap: 4px;
  padding: 6px 6px 4px;
  background: rgba(12, 12, 14, 0.98);
}
.ocpv2-session-search-input {
  flex: 1;
  min-width: 0;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.8);
  border-radius: 6px;
  padding: 5px 8px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  outline: none;
  transition: border-color 0.15s;
}
.ocpv2-session-search-input::placeholder { color: rgba(255,255,255,0.2); }
.ocpv2-session-search-input:focus { border-color: rgba(100,160,255,0.35); }
.ocpv2-session-menu-note {
  padding: 4px 12px;
  font-size: 9.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.32);
}
.ocpv2-session-menu .ocpv2-session-menu-note {
  padding: 6px 8px 2px;
  font-size: 9px;
  letter-spacing: 0.5px;
  color: rgba(255,255,255,0.2);
}
.ocpv2-session-menu-sep { height: 1px; background: rgba(255,255,255,0.06); margin: 4px 8px; }
.ocpv2-session-item-meta { font-size: 9px; opacity: 0.45; margin-left: 6px; }
.ocpv2-session-item-action {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0 4px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 9px;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.ocpv2-session-item:hover .ocpv2-session-item-action { opacity: 1; }
.ocpv2-session-item-action:hover { color: rgba(255,255,255,0.9); }
.ocpv2-session-share-url {
  padding: 2px 12px 6px;
  font-size: 10px;
  color: rgba(255,255,255,0.55);
  overflow-wrap: anywhere;
  user-select: text;
}

/* ── Composer: queue tray ─────────────────────────────────────────────── */
.ocpv2-queue-tray {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 10px 4px;
  padding: 6px 8px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  max-height: 120px;
  overflow-y: auto;
}
.ocpv2-queue-tray[hidden] { display: none; }
.ocpv2-queue-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 9.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.4);
}
.ocpv2-queue-head span { flex: 1; min-width: 0; }
.ocpv2-queue-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: rgba(255,255,255,0.62);
}
.ocpv2-queue-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ocpv2-queue-action {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0 2px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
}
.ocpv2-queue-action:hover { color: rgba(255,255,255,0.9); }

/* ── Composer: shell mode (the amber of the permission card: this runs) ─ */
.ocpv2-input-wrap.ocpv2-shell-mode {
  background: rgba(232,180,80,0.22);
  box-shadow: 0 0 20px rgba(232,180,80,0.04);
}
.ocpv2-input-wrap.ocpv2-shell-mode::before { opacity: 0; animation: none; }
.ocpv2-input-wrap.ocpv2-shell-mode .ocpv2-input-inner::before {
  content: '!';
  align-self: center;
  margin-right: 4px;
  font-weight: 700;
  color: rgba(255,200,120,0.95);
}
.ocpv2-input-wrap.ocpv2-shell-mode .ocpv2-compose-input { color: rgba(255,200,120,0.95); }

/* ── Composer: attach button, agent toggle with more than two agents ──── */
.ocpv2-attach-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 7px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.035);
  color: rgba(232,224,220,0.55);
  cursor: pointer;
}
.ocpv2-attach-btn:hover { color: rgba(232,224,220,0.88); background: rgba(255,255,255,0.045); }
.ocpv2-mode-toggle { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.ocpv2-mode-toggle::-webkit-scrollbar { display: none; }
.ocpv2-mode-btn { white-space: nowrap; flex-shrink: 0; }
.ocpv2-image-strip .ocpv2-path-chip { align-self: center; }

/* ── Tool cards (collapsible; same shell as .ocpv2-part-tool) ─────────── */
.ocpv2-tool-card .ocpv2-tc-head { cursor: pointer; user-select: none; transition: background 0.12s; }
.ocpv2-tool-card .ocpv2-tc-head:hover { background: rgba(255,255,255,0.03); }
.ocpv2-tc-icon {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.62);
}
.ocpv2-tc-icon svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ocpv2-tc-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ocpv2-tc-titles .ocpv2-tool-name { flex: none; line-height: 1.3; }
.ocpv2-tc-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255,255,255,0.45);
  font-size: 10.5px;
  line-height: 1.35;
}
.ocpv2-tc-meta { flex-shrink: 0; font-size: 10px; color: rgba(255,255,255,0.4); white-space: nowrap; }
.ocpv2-tc-chevron {
  flex-shrink: 0;
  display: inline-flex;
  color: rgba(255,255,255,0.32);
  transition: transform 0.18s;
}
.ocpv2-tool-card.ocpv2-tool-expanded .ocpv2-tc-chevron { transform: rotate(90deg); }
.ocpv2-tc-body { display: none; flex-direction: column; }
.ocpv2-tool-card.ocpv2-tool-expanded .ocpv2-tc-body { display: flex; }
.ocpv2-tc-more {
  display: block;
  margin-top: 6px;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: rgba(255,255,255,0.55);
  text-decoration: underline;
  cursor: pointer;
}
.ocpv2-tc-more:hover { color: rgba(255,255,255,0.9); }
.ocpv2-tc-actions {
  display: flex;
  gap: 10px;
  padding: 6px 12px;
  border-top: 1px solid rgba(255,255,255,0.05);
}
.ocpv2-tc-diff { white-space: pre; overflow-x: auto; }
.ocpv2-diff-line { min-height: 1.5em; }
.ocpv2-diff-add { color: rgba(140,200,160,0.85); background: rgba(140,200,160,0.04); }
.ocpv2-diff-del { color: rgba(220,140,140,0.82); background: rgba(220,100,100,0.04); }
.ocpv2-diff-hunk { color: rgba(180,205,255,0.9); }
.ocpv2-diff-meta { color: rgba(255,255,255,0.4); }

/* ── Todos: the widget above the composer and the todowrite card ──────── */
.ocpv2-todo-widget {
  flex-shrink: 0;
  margin: 0 8px 4px;
  background: rgba(22, 22, 26, 0.95);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  overflow: hidden;
}
.ocpv2-todo-widget[hidden] { display: none; }
.ocpv2-todo-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  font: inherit;
  color: rgba(255,255,255,0.62);
  cursor: pointer;
  text-align: left;
}
.ocpv2-todo-head:hover { background: rgba(255,255,255,0.03); }
.ocpv2-todo-count {
  flex-shrink: 0;
  font-size: 9.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.4);
}
.ocpv2-todo-active { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ocpv2-todo-list { padding: 2px 10px 8px; max-height: 160px; overflow-y: auto; }
.ocpv2-todo-item { display: flex; gap: 8px; line-height: 1.5; color: rgba(255,255,255,0.62); }
.ocpv2-todo-mark { flex-shrink: 0; width: 1em; text-align: center; color: rgba(255,255,255,0.4); }
.ocpv2-todo-text { min-width: 0; overflow-wrap: anywhere; }
.ocpv2-todo-completed { color: rgba(255,255,255,0.4); }
.ocpv2-todo-completed .ocpv2-todo-mark { color: rgba(140,200,160,0.85); }
.ocpv2-todo-completed .ocpv2-todo-text,
.ocpv2-todo-cancelled .ocpv2-todo-text { text-decoration: line-through; }
.ocpv2-todo-in_progress { color: rgba(255,255,255,0.92); }
.ocpv2-todo-in_progress .ocpv2-todo-mark { color: rgba(140,200,255,0.85); }
.ocpv2-todo-cancelled { color: rgba(255,255,255,0.32); }

/* ── Per-message meta ─────────────────────────────────────────────────── */
.ocpv2-msg-meta {
  font-size: 9.5px;
  letter-spacing: 0.02em;
  color: rgba(255,255,255,0.32);
  overflow-wrap: anywhere;
}

/* ── Changes: the bar above the composer and the diff viewer ──────────── */
.ocpv2-changes-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin: 0 8px 4px;
  padding: 6px 10px;
  background: rgba(22, 22, 26, 0.95);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  color: rgba(255,255,255,0.62);
  cursor: pointer;
  text-align: left;
}
.ocpv2-changes-bar[hidden] { display: none; }
.ocpv2-changes-bar:hover { border-color: rgba(255,255,255,0.14); color: rgba(255,255,255,0.9); }
.ocpv2-changes-bar-label { flex: 1; min-width: 0; }
.ocpv2-changes-stat { flex-shrink: 0; font-size: 10px; color: rgba(255,255,255,0.45); }
.ocpv2-changes-bar-action {
  flex-shrink: 0;
  font-size: 9.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.55);
}
.ocpv2-changes-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  z-index: 300;
  border-radius: 16px;
  padding: 10px;
}
.ocpv2-changes-sheet {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: rgba(22,22,26,0.98);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  overflow: hidden;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.ocpv2-changes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.ocpv2-changes-head .ocpv2-msg-action { font-size: 10.5px; }
.ocpv2-changes-list { flex: 1; overflow-y: auto; padding: 6px; }
.ocpv2-changes-file {
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  margin-bottom: 6px;
  overflow: hidden;
}
.ocpv2-changes-file-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 11px;
  color: rgba(255,255,255,0.78);
  cursor: pointer;
  list-style: none;
}
.ocpv2-changes-file-head::-webkit-details-marker { display: none; }
.ocpv2-changes-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.ocpv2-changes-mark { flex-shrink: 0; width: 1em; text-align: center; font-weight: 700; color: rgba(180,205,255,0.9); }
.ocpv2-changes-added { color: rgba(140,200,160,0.85); }
.ocpv2-changes-deleted { color: rgba(220,140,140,0.82); }
.ocpv2-changes-file .ocpv2-tool-output { max-height: 320px; }

/* ── New-session dialog: worktree option ──────────────────────────────── */
.ocpv2-name-modal-worktree[hidden],
.ocpv2-name-modal-worktrees[hidden] { display: none; }
.ocpv2-name-modal-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: rgba(255,255,255,0.78);
  cursor: pointer;
}
.ocpv2-name-modal-worktrees {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10px;
  color: rgba(255,255,255,0.4);
  max-height: 72px;
  overflow-y: auto;
}

/* ── Environment popover ("Manage" in Context settings), under the header ── */
.ocpv2-env-popover {
  position: absolute;
  top: 58px;
  left: 8px;
  right: 8px;
  max-height: 60%;
  overflow-y: auto;
  background: rgba(22,22,26,0.98);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  z-index: 60;
  padding: 6px 4px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
}
.ocpv2-env-popover[hidden] { display: none; }
.ocpv2-env-section { padding: 2px 0 6px; }
.ocpv2-env-section > .ocpv2-permission-link { margin: 2px 12px; font-size: 10px; }
.ocpv2-env-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  color: rgba(255,255,255,0.78);
}
.ocpv2-env-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ocpv2-env-state { flex-shrink: 0; font-size: 10px; }
.ocpv2-env-row .ocpv2-permission-link { flex-shrink: 0; font-size: 10px; }
.ocpv2-env-note { padding: 0 12px 2px; font-size: 10px; color: rgba(255,255,255,0.4); overflow-wrap: anywhere; }
.ocpv2-env-ok { color: rgba(140,200,160,0.85); }
.ocpv2-env-warn { color: rgba(255,200,120,0.95); }
.ocpv2-env-error { color: rgba(255,166,166,0.92); }
.ocpv2-env-muted { color: rgba(255,255,255,0.4); }
/* "Add a server…": name, command or URL, Add. Wraps in a narrow panel. */
.ocpv2-env-section .ocpv2-permission-reason { flex-wrap: wrap; padding: 4px 12px; }
.ocpv2-env-section .ocpv2-permission-reason-input { flex: 1 1 150px; }
.ocpv2-env-section .ocpv2-permission-reason-input:first-child { flex: 0 1 110px; }

/* ── Model picker: status and catalog price of a model ────────────────── */
.ocpv2-dd-model-meta { flex-shrink: 0; font-size: 9px; color: rgba(255,255,255,0.4); white-space: nowrap; }
.ocpv2-dd-model-status { color: rgba(255,200,120,0.95); margin-right: 4px; }

/* ── In-panel confirmation: the revert banner with its two answers ───── */
.ocpv2-confirm { margin: 4px 0; }
.ocpv2-confirm .ocpv2-confirm-text { flex: 1 1 100%; white-space: pre-line; }
.ocpv2-confirm-yes { color: rgba(255,166,166,0.92); border-color: rgba(255,82,82,0.6); }
.ocpv2-confirm-yes:hover:not(:disabled) { color: #ff5252; background: rgba(255,82,82,0.12); border-color: rgba(255,82,82,0.6); }
/* Tab close and message delete ask above the compose box, whatever is scrolled. */
.ocpv2-confirm-slot { padding: 0 12px; }
.ocpv2-confirm-slot:empty { display: none; }
.ocpv2-session-menu .ocpv2-confirm, .ocpv2-env-section .ocpv2-confirm { margin: 4px 8px; }

/* ── /help card: the plan card's frame, one line per thing ───────────── */
.ocpv2-help-card .ocpv2-session-menu-note { padding: 4px 0 0; }
.ocpv2-help-row { display: flex; align-items: baseline; gap: 8px; font-size: 10.5px; line-height: 1.45; }
.ocpv2-help-name { flex-shrink: 0; color: rgba(232,224,220,0.95); font-family: 'JetBrains Mono', ui-monospace, monospace; }
.ocpv2-help-text { flex: 1; min-width: 0; color: rgba(255,255,255,0.62); overflow-wrap: anywhere; }
.ocpv2-help-row .ocpv2-session-item-meta { flex-shrink: 0; margin-left: 0; }
`;

export function injectStyles() {
  const full = CSS + '\n' + PARITY_CSS + '\n' + CHILD_CSS;
  const existing = document.getElementById(STYLE_ID);
  if (existing) {
    if (existing.textContent !== full) existing.textContent = full;
    return;
  }
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = full;
  document.head.appendChild(tag);
}
