// ═══════════════════════════════════════════
// SynaBun Assistant — sidepanel styles ("gold on glass")
// ═══════════════════════════════════════════
// The frame and surface of the Assistant sidepanel: the same skeleton as the
// Claude Code / Codex / OpenCode panels (frosted glass, a header card, cards
// inside) in SynaBun gold. The header card is the only header row: the active
// tab's component toolbar sits in it, flush, with its own container queries. Everything is scoped to .assistant-panel / .asp-*,
// so the terminal tab keeps its own flush black look. The component's tokens
// (--asst-*, under :where(:root) in asst-styles.js) are re-set on
// .assistant-panel and inherit into it. Every gold derives from --asst-brand,
// so a skin can retheme it, and gold only means working or selected: the
// header and its window buttons are the component's capsules (sm here, 6px
// corners); the tray pill is the shared tray pill of styles.css. Animations
// pause while the UI is being dragged or resized (body.ui-interacting) and
// stop under prefers-reduced-motion.

import { injectAssistantStyles } from './asst-styles.js';

// The SynaBun two-pill mark as a mask (composer footer), same glyph as provider-icons.js.
const MARK_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='8' y='5.5' width='11' height='5' rx='2.5' transform='rotate(-12 13.5 8)'/><rect x='4.5' y='12.5' width='11' height='5' rx='2.5' transform='rotate(-12 10 15)'/></svg>";
const MARK_URL = `url("data:image/svg+xml,${encodeURIComponent(MARK_SVG)}")`;
// A faint grain over the warm wash: a gradient this subtle bands in 8-bit colour (WebKit most), and
// a little noise dithers the steps away. One 128px tile, drawn once.
const GRAIN_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .035 0'/></filter><rect width='128' height='128' filter='url(%23g)'/></svg>";
const GRAIN_URL = `url("data:image/svg+xml,${GRAIN_SVG.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, "'")}")`;

export function injectAssistantSidepanelStyles() {
  injectAssistantStyles(); // the component's sheet first, so these rules come after it
  if (document.getElementById('assistant-sidepanel-styles')) return;
  const style = document.createElement('style');
  style.id = 'assistant-sidepanel-styles';
  style.textContent = `
    /* ── Frame: frosted glass, the sibling panels' geometry ─────────── */
    .assistant-panel {
      --asp-gold: var(--asst-brand);
      --asp-gold-strong: color-mix(in srgb, var(--asp-gold) 42%, transparent);
      --asp-gold-soft: color-mix(in srgb, var(--asp-gold) 16%, transparent);
      --asp-gold-faint: color-mix(in srgb, var(--asp-gold) 7%, transparent);
      --asp-card: rgba(22, 22, 26, 0.95);
      --asp-ring: rgba(255, 255, 255, 0.06);
      --asp-card-shadow: var(--shadow-sm, 0 6px 18px rgba(0, 0, 0, 0.28));
      /* The component's surface tokens, re-set for glass (they inherit). */
      --asst-bg: transparent;
      --asst-card: var(--asp-card);
      --asst-card-ring: var(--asp-ring);
      --asst-card-ring-focus: var(--asp-gold-strong);
      --asst-card-shadow: var(--asp-card-shadow);
      /* The pill and motion scales, restated so the glass frame keeps them
         when a skin retunes the terminal tab's :root values. */
      --asst-pill-h-xs: 18px;
      --asst-pill-h-sm: 22px;
      --asst-pill-h-md: 28px;
      --asst-pill-r-xs: 5px;
      --asst-pill-r-sm: 6px;
      --asst-pill-r-md: 8px;
      --asst-pill-px-xs: 6px;
      --asst-pill-px-sm: 8px;
      --asst-pill-px-md: 11px;
      --asst-dur-instant: 80ms;
      --asst-dur-fast: 140ms;
      --asst-dur-base: 200ms;
      --asst-dur-moderate: 240ms;
      --asst-dur-slow: 320ms;
      --asst-ease-standard: cubic-bezier(.2,0,.38,.9);
      --asst-ease-enter: cubic-bezier(0,0,.38,.9);
      --asst-ease-exit: cubic-bezier(.2,0,1,.9);
      --asst-ease-emphasized: cubic-bezier(.4,.14,.3,1);
      --asst-ease-spring: linear(0, 0.35 9%, 0.78 21%, 1.03 40%, 0.99 60%, 1);
      position: fixed;
      top: calc(var(--navbar-height, 48px) + 20px);
      right: 20px;
      bottom: 20px;
      width: 22%;
      min-width: 320px;
      max-width: 700px;
      z-index: 205;
      display: flex;
      flex-direction: column;
      color: var(--asst-text);
      /* The warm wash, eased over more stops (fewer bands) and dithered by a faint grain. */
      background:
        ${GRAIN_URL} 0 0 / 128px 128px,
        radial-gradient(120% 55% at 0% 0%,
          var(--asp-gold-faint) 0%,
          color-mix(in srgb, var(--asp-gold) 5.4%, transparent) 14%,
          color-mix(in srgb, var(--asp-gold) 3.6%, transparent) 28%,
          color-mix(in srgb, var(--asp-gold) 2%, transparent) 42%,
          color-mix(in srgb, var(--asp-gold) .8%, transparent) 54%,
          transparent 66%),
        rgba(18, 18, 20, 0.92);
      backdrop-filter: blur(28px) saturate(1.5);
      -webkit-backdrop-filter: blur(28px) saturate(1.5);
      border: 0.5px solid rgba(255, 255, 255, 0.07);
      border-radius: 16px;
      box-shadow:
        0 0 0 0.5px rgba(0, 0, 0, 0.3),
        0 1px 2px rgba(0, 0, 0, 0.15),
        0 4px 8px rgba(0, 0, 0, 0.12),
        0 12px 24px rgba(0, 0, 0, 0.14),
        0 32px 64px rgba(0, 0, 0, 0.18);
      overflow: hidden;
      transform: translateX(calc(100% + 20px));
      opacity: 0;
      transition: transform var(--asst-dur-slow) var(--asst-ease-enter), opacity var(--asst-dur-moderate) var(--asst-ease-standard);
    }
    .assistant-panel.open { transform: translateX(0); opacity: 1; overflow: visible; }
    html .assistant-panel.sp-floating.sp-window-focused { border-color: color-mix(in srgb, var(--asp-gold) 34%, rgba(148, 163, 184, 0.3)); }
    /* While a right-edge panel is drag-resized: no blur, near-opaque (see styles.css sp-resizing). */
    html.sp-resizing .assistant-panel {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      background: rgba(18, 18, 20, 0.985) !important;
    }

    .asp-resize-handle {
      position: absolute;
      top: 14px;
      left: 0;
      z-index: 10;
      width: 6px;
      height: calc(100% - 28px);
      border-radius: 0 3px 3px 0;
      cursor: col-resize;
      transition: background-color var(--asst-dur-fast) var(--asst-ease-standard);
    }
    .asp-resize-handle:is(:hover, :active) { background: var(--asst-fill-2); }

    /* ── Header card, the one header row: mark · name ▾ · rename · status ·
       the active tab's toolbar · window buttons, all sm (22px) ──────────── */
    .asp-header {
      container: asp-head / inline-size;
      position: relative;
      z-index: 3;
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
      min-width: 0;
      margin: 8px 8px 0;
      /* 12px from a 312px panel, down to 8px at 300px and below */
      padding: 8px 8px 8px clamp(8px, calc(100% - 300px), 12px);
      border-radius: 10px;
      background: var(--asp-card);
      box-shadow: var(--asp-card-shadow), 0 0 0 1px var(--asp-ring);
    }
    .asp-header::after {
      content: '';
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--asst-line-2), transparent);
      pointer-events: none;
    }
    .asp-mark { display: inline-flex; flex-shrink: 0; color: var(--asst-text-2); }
    .asp-mark svg { width: 16px; height: 16px; }
    .asp-mark + .asp-tabs-btn { margin-left: 2px; }
    /* The tab's name ▾: a label capsule (sans), its count an xs value (mono). */
    .asp-tabs-btn {
      position: relative;
      isolation: isolate;
      display: inline-flex;
      flex: 0 1 auto;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 24ch;
      height: var(--asst-pill-h-sm);
      padding: 0 7px 0 var(--asst-pill-px-sm);
      border: 0;
      border-radius: var(--asst-pill-r-sm);
      background: var(--asst-fill-1);
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text);
      font: inherit;
      font-size: 11px;
      font-weight: 500;
      line-height: 1;
      cursor: pointer;
      transition:
        background-color var(--asst-dur-fast) var(--asst-ease-standard),
        box-shadow var(--asst-dur-fast) var(--asst-ease-standard),
        transform var(--asst-dur-instant) var(--asst-ease-standard);
    }
    .asp-tabs-btn::after { content: ''; position: absolute; inset: -3px; z-index: -1; border-radius: inherit; }
    .asp-tabs-btn:hover { background: var(--asst-fill-2); box-shadow: inset 0 0 0 1px var(--asst-line-2); }
    .asp-tabs-btn[aria-expanded="true"] { background: var(--asst-pill-on-fill); box-shadow: inset 0 0 0 1px var(--asst-pill-on-ring); }
    .asp-tabs-btn:active { transform: scale(.97); transition-duration: 90ms; }
    .asp-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The mark stands in for the name when the panel is too narrow for it (the tooltip and aria-label keep the name). */
    .asp-tabs-mark { display: none; flex-shrink: 0; color: var(--asst-text-2); }
    .asp-tabs-mark svg { width: 12px; height: 12px; }
    .asp-tabs-count {
      display: inline-flex;
      flex-shrink: 0;
      align-items: center;
      justify-content: center;
      min-width: var(--asst-pill-h-xs);
      height: var(--asst-pill-h-xs);
      margin-right: -3px;
      padding: 0 var(--asst-pill-px-xs);
      border-radius: var(--asst-pill-r-xs);
      background: var(--asst-fill-2);
      color: var(--asst-text);
      font-family: var(--asst-mono);
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
    }
    .asp-tabs-count[hidden] { display: none; }
    .asp-caret { display: inline-flex; flex-shrink: 0; color: var(--asst-text-3); transition: transform var(--asst-dur-base) var(--asst-ease-standard); }
    .asp-tabs-btn[aria-expanded="true"] .asp-caret { transform: rotate(180deg); }
    .asp-caret svg { width: 8px; height: 8px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    .asp-rename-input {
      width: 100%;
      min-width: 0;
      height: 18px;
      padding: 0 6px;
      border: 0;
      border-radius: var(--asst-pill-r-xs);
      outline: none;
      background: rgba(0, 0, 0, 0.3);
      box-shadow: inset 0 0 0 1px var(--asst-line-2);
      color: var(--asst-text);
      font: inherit;
      font-size: 11px;
      font-weight: 500;
    }
    /* Status: a 6px dot at rest, the cameo while working, a diamond when it
       needs you, a check when a turn finished out of sight. */
    .asp-status {
      position: relative;
      display: inline-flex;
      flex-shrink: 0;
      align-items: center;
      justify-content: center;
      width: 10px;
      height: var(--asst-pill-h-sm);
      margin: 0 4px;
      color: var(--asst-text-3);
    }
    .asp-status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .asp-status .syna-cameo { display: none; }
    .asp-status[data-status="working"] { color: var(--asst-brand); }
    .asp-status[data-status="working"]::before { display: none; }
    .asp-status[data-status="working"] .syna-cameo { display: inline-flex; }
    .asp-status[data-status="action"] { color: var(--asst-warn); }
    .asp-status[data-status="action"]::before { width: 5px; height: 5px; border-radius: 1px; transform: rotate(45deg); }
    .asp-status[data-status="done"] { color: var(--asst-text-2); }
    .asp-status[data-status="done"]::before { width: 7px; height: 3.5px; margin-top: -2px; border: solid currentColor; border-width: 0 0 1.5px 1.5px; border-radius: 0; background: none; transform: rotate(-45deg); }
    .asp-actions { display: flex; flex-shrink: 0; align-items: center; gap: 4px; margin-left: auto; }
    /* The toolbar slot takes the room left; the name gives way first (it truncates). */
    .asp-bar-slot {
      container: asp-bar / inline-size;
      display: flex;
      flex: 1 0 116px;
      align-self: stretch;
      align-items: center;
      min-width: 116px;
    }
    .asp-tab-bar { display: none; flex: 1 1 auto; align-items: center; min-width: 0; }
    .asp-tab-bar.active { display: flex; }
    /* 3px on the right: room for the last control's hit margin. */
    .asp-tab-bar .asst-bar { flex: 1 1 auto; gap: 4px; height: var(--asst-pill-h-sm); padding: 0 3px 0 0; border-bottom: 0; background: transparent; }
    .asp-tab-bar .asst-bar-group + .asst-bar-group::before { margin: 0 4px; }
    /* Window buttons (rename · move · detach · minimize · close): bare sm
       squares with the row's 6px corners, the glyph grid-centred, one hover
       for all, 28px to hit. */
    .asp-btn {
      position: relative;
      isolation: isolate;
      display: inline-grid;
      flex-shrink: 0;
      place-content: center;
      place-items: center;
      width: var(--asst-pill-h-sm);
      height: var(--asst-pill-h-sm);
      padding: 0;
      border: 0;
      border-radius: var(--asst-pill-r-sm);
      background: transparent;
      color: var(--asst-text-3);
      cursor: pointer;
      transition:
        background-color var(--asst-dur-fast) var(--asst-ease-standard),
        box-shadow var(--asst-dur-fast) var(--asst-ease-standard),
        color var(--asst-dur-fast) var(--asst-ease-standard),
        opacity var(--asst-dur-fast) var(--asst-ease-standard),
        transform var(--asst-dur-instant) var(--asst-ease-standard);
    }
    .asp-btn::after { content: ''; position: absolute; inset: -3px; z-index: -1; border-radius: inherit; }
    .asp-btn:hover:not(:disabled) { background: var(--asst-fill-2); box-shadow: inset 0 0 0 1px var(--asst-line-2); color: var(--asst-text); }
    .asp-btn:active:not(:disabled) { transform: scale(.97); transition-duration: 90ms; }
    .asp-btn[aria-pressed="true"] { color: var(--asst-text-2); }
    .asp-btn:is(:disabled, [aria-disabled="true"]) { opacity: 0.4; cursor: not-allowed; }
    .asp-btn svg { display: block; width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

    /* ── Body: one viewport per tab (only the active one shows) ──────── */
    .asp-body { position: relative; flex: 1 1 0; min-height: 0; }
    .asp-viewport {
      position: absolute;
      inset: 0;
      display: none;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      color: var(--asst-text);
    }
    .asp-viewport.active { display: flex; }
    .asp-placeholder {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 24px;
      color: var(--asst-text-3);
      font-size: 12.5px;
      text-align: center;
    }
    .asp-placeholder .asp-mark svg { width: 28px; height: 28px; }
    /* Starting: the empty state's character (same size, so the hand-off does
       not jump) over a gold sweep — the panel is working. */
    .asp-placeholder[data-state="starting"] { color: var(--asst-text-2); }
    .asp-placeholder-track { position: relative; width: 132px; height: 2px; overflow: hidden; border-radius: 2px; background: color-mix(in srgb, var(--asp-gold) 12%, transparent); }
    .asp-placeholder-track::after { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 38%; background: linear-gradient(90deg, transparent, var(--asp-gold), transparent); animation: asp-sweep 1.8s var(--asst-ease-emphasized) infinite; }
    .asp-placeholder-reason { max-width: 340px; color: var(--asst-text-2); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .asp-placeholder-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
    .asp-toast {
      position: absolute;
      left: 50%;
      bottom: 92px;
      z-index: 30;
      max-width: calc(100% - 32px);
      padding: 8px 14px;
      border-radius: 9px;
      background: rgba(20, 20, 24, 0.96);
      color: var(--asst-text-2);
      font-size: 12px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--asst-line-2);
      opacity: 0;
      transform: translate(-50%, 6px);
      transition: opacity var(--asst-dur-base) var(--asst-ease-standard), transform var(--asst-dur-base) var(--asst-ease-standard);
      pointer-events: none;
    }
    .asp-toast.visible { opacity: 1; transform: translate(-50%, 0); }

    /* Narrow header: ✎ steps aside (Rename… is in the name ▾ menu), then the
       mark and the tab count; the toolbar's capsules drop their labels (route
       mode and Computer, then project · MCP), then cost, project · MCP,
       Computer and agents go in that order ("⋯" lists what is hidden). Route
       ▾, ☰, ＋, ⋯ and the window buttons always stay. */
    @container asp-head (max-width: 420px) {
      .asp-rename { display: none; }
    }
    @container asp-head (max-width: 360px) {
      .asp-header > .asp-mark, .asp-tabs-count { display: none; }
      .asp-tabs-btn { gap: 4px; padding: 0 6px 0 7px; }
    }
    /* A panel under 300px (its header's content box is under 266px there; 282px at the
       default 320px): the name would be one letter, so the chip is the mark and its caret. */
    @container asp-head (max-width: 265px) {
      .asp-tabs-btn .asp-title { display: none; }
      .asp-tabs-btn .asp-tabs-mark { display: inline-flex; }
    }
    /* Glyph only, the component's three rules (asst-styles.js, Capsules): grid-centred, padding 0,
       no label half or caret, the glyph half without its seam, so one glyph is a --cap-h square. */
    @container asp-bar (max-width: 600px) {
      .asp-tab-bar :is(.asst-route-chip:not([data-waiting]), .asst-computer-toggle) { display: grid; place-content: center; place-items: center; padding: 0; }
      .asp-tab-bar :is(.asst-route-chip:not([data-waiting]), .asst-computer-toggle) > :is(.asst-dd-label, .asst-tb-label, .asst-dd-caret) { display: none; }
      .asp-tab-bar :is(.asst-route-chip:not([data-waiting]), .asst-computer-toggle) > .asst-icon:not([hidden]) { margin: 0; padding: 0 var(--cap-glyph-pad); box-shadow: none; }
      .asp-tab-bar .asst-route-chip[data-waiting] > .asst-dd-label { display: none; }
    }
    @container asp-bar (max-width: 440px) {
      .asp-tab-bar .asst-cost { display: none !important; }
      /* The project keeps its name, cut with an ellipsis; MCP becomes its glyph. */
      .asp-tab-bar .asst-dd-project .asst-dd-label { max-width: 7ch; }
      .asp-tab-bar .asst-dd.asst-dd-mcp { display: grid; place-content: center; place-items: center; padding: 0; }
      .asp-tab-bar .asst-dd.asst-dd-mcp > :is(.asst-dd-label, .asst-dd-caret) { display: none; }
      .asp-tab-bar .asst-dd.asst-dd-mcp > .asst-icon:not([hidden]) { margin: 0; padding: 0 var(--cap-glyph-pad); box-shadow: none; }
    }
    @container asp-bar (max-width: 400px) {
      .asp-tab-bar .asst-bar-group[data-group="context"] { display: none !important; }
    }
    @container asp-bar (max-width: 220px) {
      .asp-tab-bar .asst-bar-group[data-group="computer"] { display: none !important; }
    }
    @container asp-bar (max-width: 180px) {
      .asp-tab-bar .asst-act-agents { display: none !important; }
    }

    /* ── The component on glass: inset well · composer card ─────────── */
    .assistant-panel .asst-root { background: transparent; }
    .assistant-panel .asst-transcript {
      margin: 6px var(--asst-inline);
      padding: 12px 12px 14px;
      border: 1px solid rgba(255, 255, 255, 0.03);
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.18);
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.2);
    }
    .assistant-panel .asst-bottom { margin: 0 var(--asst-inline) 8px; }
    .assistant-panel .asst-usage-host { min-width: 0; }
    /* The composer you are writing in: one static 1px gold ring (selected), no spin, no glow. */
    .assistant-panel .asst-bottom:has(.asst-input:focus) {
      box-shadow: var(--asp-card-shadow), 0 0 0 1px var(--asp-gold-strong);
    }
    .assistant-panel .asst-input::selection { background: color-mix(in srgb, var(--asp-gold) 28%, transparent); }
    /* Footer row: the mark (gold while you are writing) · attach … send. */
    .assistant-panel .asst-composer-actions { justify-content: flex-start; }
    .assistant-panel .asst-composer-actions::before {
      content: '';
      flex-shrink: 0;
      width: 14px;
      height: 14px;
      margin: 0 2px 0 6px;
      background: var(--asst-text-3);
      opacity: 0.6;
      -webkit-mask: ${MARK_URL} center / contain no-repeat;
      mask: ${MARK_URL} center / contain no-repeat;
      transition: background-color var(--asst-dur-base) var(--asst-ease-standard), opacity var(--asst-dur-base) var(--asst-ease-standard);
    }
    .assistant-panel .asst-bottom:has(.asst-input:focus) .asst-composer-actions::before { background: var(--asp-gold); opacity: 0.8; }
    /* Send: an md square. Ready is gold (the one armed action) and fills from
       the left. Stop is the component's own neutral white ■ (asst-styles.js),
       the same in both hosts: red only ever means failed. */
    .assistant-panel .asst-send {
      overflow: hidden;
      margin-left: auto;
      background: transparent;
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text-3);
    }
    .assistant-panel .asst-send::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: var(--asst-pill-on-fill);
      transform: scaleX(0);
      transform-origin: left;
      transition: transform var(--asst-dur-moderate) var(--asst-ease-enter);
    }
    .assistant-panel .asst-send svg { position: relative; z-index: 1; }
    .assistant-panel .asst-send:hover:not(:disabled) { background: transparent; }
    .assistant-panel .asst-send[data-state="empty"] { background: transparent; box-shadow: inset 0 0 0 1px var(--asst-line); color: var(--asst-text-3); }
    .assistant-panel .asst-send[data-state="ready"] { box-shadow: inset 0 0 0 1px var(--asst-pill-on-ring); color: color-mix(in srgb, var(--asp-gold) 78%, #fff); }
    .assistant-panel .asst-send[data-state="ready"]::before { transform: scaleX(1); }
    .assistant-panel .asst-send[data-state="ready"]:hover { box-shadow: inset 0 0 0 1px var(--asp-gold); }

    /* ── Tray pill (#term-minimized-tray, outside the panel) ─────────────
       The shared .term-minimized-pill of styles.css, drawn exactly like the
       Claude, Codex and OpenCode pills: 32px, 8px corners, a 1px hairline,
       icon · name · ✕, no geometry of its own. Only the identity is
       SynaBun's: the two-pill mark, and the cameo in its place while working
       (gold, with a gold hairline); a session that needs you tints the mark
       and the hairline. It is a button (Enter/Space) with the panel's focus
       ring, and its ✕ keeps the tray's 24px target. */
    .asp-session-pill .term-minimized-pill-icon .syna-cameo { display: none; }
    .asp-session-pill.asp-pill-running { border-color: var(--asst-pill-on-ring); }
    .asp-session-pill.asp-pill-running .term-minimized-pill-icon { color: var(--asst-brand); }
    .asp-session-pill.asp-pill-running .term-minimized-pill-icon > svg:not(.syna-cameo) { display: none; }
    .asp-session-pill.asp-pill-running .term-minimized-pill-icon .syna-cameo { display: inline-flex; }
    .asp-session-pill.asp-pill-attention { border-color: var(--asst-pill-warn-ring); }
    .asp-session-pill.asp-pill-attention .term-minimized-pill-icon { color: var(--asst-warn); }

    /* ── Motion ─────────────────────────────────────────────────────── */
    @keyframes asp-sweep { from { transform: translateX(-100%); } to { transform: translateX(270%); } }

    body.ui-interacting .asp-placeholder .asp-mark,
    body.ui-interacting .asp-placeholder-track::after,
    body.ui-interacting .asp-status .syna-cameo-eye,
    body.ui-interacting .asp-session-pill .syna-cameo-eye { animation-play-state: paused !important; }

    @media (prefers-reduced-motion: reduce) {
      .assistant-panel { transition: opacity 0.15s ease; }
      .asp-placeholder .asp-mark,
      .asp-placeholder-track::after,
      .asp-status .syna-cameo-eye,
      .asp-session-pill .syna-cameo-eye,
      .assistant-panel .asst-send::before { animation: none !important; }
      .asp-placeholder-track::after { left: 31%; }
    }
  `;
  document.head.appendChild(style);
}
