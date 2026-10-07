// ═══════════════════════════════════════════
// SynaBun Assistant — styles ("black with faint panels")
// ═══════════════════════════════════════════
// Injected once like cdx/cdx-styles.js. The palette is a small token set under
// `:where(:root)` — zero specificity, so body-level menus, modals, the
// lightbox and the float chip see it and skins can still override any token.
// A flush toolbar sits under the terminal tabs (the tab already names the
// session, so there is no header); the black transcript runs below it, and one
// faint card at the bottom holds the trays and the composer.
// No backdrop blur and no standing compositor-layer hints anywhere: blur over
// a repainting body forces a compositor re-blur, and a permanent layer per tab
// costs GPU memory.
// Every pill, chip, badge and button is one capsule (see Capsules), a rounded
// rectangle on the --asst-pill-* and --asst-dur-* / --asst-ease-* scales.
// Infinite animations pause during drags (body.ui-interacting) and stop under
// prefers-reduced-motion.

export function injectAssistantStyles() {
  if (document.getElementById('assistant-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'assistant-panel-styles';
  style.textContent = `
    /* ── Tokens ─────────────────────────────────────────────────────── */
    :where(:root) {
      --asst-bg: #0a0a0c;
      --asst-card: #0f0f11;
      --asst-bar: var(--asst-card);
      --asst-card-ring: rgba(255,255,255,.06);
      --asst-card-ring-focus: rgba(255,255,255,.13);
      --asst-card-shadow: 0 1px 2px rgba(0,0,0,.45);
      --asst-card-hi: inset 0 1px 0 rgba(255,255,255,.025);
      --asst-popover: #131316;
      --asst-popover-ring: rgba(255,255,255,.09);
      --asst-popover-shadow: 0 18px 44px rgba(0,0,0,.62), 0 3px 10px rgba(0,0,0,.5);
      --asst-scrim: rgba(0,0,0,.6);
      --asst-scrim-strong: rgba(0,0,0,.84);
      --asst-fill-1: rgba(255,255,255,.04);
      --asst-fill-2: rgba(255,255,255,.065);
      --asst-fill-3: rgba(255,255,255,.10);
      --asst-field: rgba(255,255,255,.025);
      --asst-line: rgba(255,255,255,.07);
      --asst-line-2: rgba(255,255,255,.12);
      --asst-text: var(--t-bright, rgba(255,255,255,.9));
      --asst-text-2: rgba(255,255,255,.64);
      --asst-text-3: rgba(255,255,255,.52); /* text: ≈5.7:1 on the card */
      --asst-text-4: rgba(255,255,255,.28);
      --asst-brand: var(--accent-gold, rgba(255,215,0,.85));
      --asst-brand-line: color-mix(in srgb, var(--asst-brand) 36%, transparent);
      --asst-focus: var(--accent-blue, hsl(199, 92%, 64%));
      --asst-info: color-mix(in srgb, var(--asst-focus) 62%, rgba(255,255,255,.7));
      --asst-live: var(--accent-red, #FF5252);
      --asst-warn: var(--accent-orange, #FFB74D);
      --asst-r-card: 10px;
      --asst-r-field: 8px;
      --asst-r-bubble: 14px;
      --asst-r-ctl: 7px;
      --asst-col: 860px;
      --asst-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
      --asst-ink: #0a0a0c; /* text on a light fill (primary button, send) */
      /* Pills: xs counts and meta · sm status and the toolbar · md the composer, cards, buttons. */
      --asst-pill-h-xs: 18px;
      --asst-pill-h-sm: 22px;
      --asst-pill-h-md: 28px;
      /* Corners at about a quarter of the height, like the tray pills (8px on 32): rounded rectangles, never full capsules. */
      --asst-pill-r-xs: 5px;
      --asst-pill-r-sm: 6px;
      --asst-pill-r-md: 8px;
      --asst-pill-px-xs: 6px;
      --asst-pill-px-sm: 8px;
      --asst-pill-px-md: 11px;
      /* The only tinted fills: gold for selected or working, red for failed. */
      --asst-pill-on-fill: color-mix(in srgb, var(--asst-brand) 16%, transparent);
      --asst-pill-on-ring: color-mix(in srgb, var(--asst-brand) 42%, transparent);
      --asst-pill-err-fill: color-mix(in srgb, var(--asst-live) 12%, transparent);
      --asst-pill-err-ring: color-mix(in srgb, var(--asst-live) 42%, transparent);
      --asst-pill-warn-ring: color-mix(in srgb, var(--asst-warn) 42%, transparent);
      /* Motion (Carbon productive curves). Transitions name their properties. */
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
    }

    /* ── Viewport shell ─────────────────────────────────────────────────
       styles.css gives non-terminal tabs an inset card (inset 6px 8px 8px,
       radius 12px, float padding) and the open file tree a 16px radius.
       The assistant is edge to edge; its own cards carry the inset. */
    .term-viewport.assistant-viewport {
      inset: 0 !important;
      padding: 0 !important;
      border-radius: 0 !important;
      display: flex;
      flex-direction: column;
      background: var(--asst-bg);
      color: var(--asst-text);
      contain: layout paint;
    }
    .term-float-tab-body:has(> .term-float-viewport-wrap > .assistant-viewport) { padding: 0 !important; }

    /* The UA [hidden] rule loses to any display declaration below. */
    :is(.asst-root, .asst-bar, .asst-dd-menu, .asst-modal-overlay, .asst-lightbox) [hidden],
    .asst-root[hidden],
    .term-float-brain-chip[hidden] { display: none !important; }

    .asst-root {
      container: asst / size;
      --asst-inline: max(8px, calc((100% - var(--asst-col)) / 2));
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      height: 100%;
      background: var(--asst-bg);
      color: var(--asst-text);
      font-size: 13px;
      line-height: 1.45;
    }
    .asst-icon { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .asst-icon svg { width: 14px; height: 14px; }
    /* Thin dark scrollbars on every inner scroller (code blocks, tool output,
       trays). Standard properties for Chromium/Firefox; ::-webkit-scrollbar for
       WebKit (the Safari web app), which ignores the standard ones. */
    :is(.asst-root, .asst-dd-menu, .asst-modal) * { scrollbar-width: thin; scrollbar-color: var(--asst-fill-3) transparent; }
    :is(.asst-root, .asst-dd-menu, .asst-modal) *::-webkit-scrollbar { width: 8px; height: 8px; }
    :is(.asst-root, .asst-dd-menu, .asst-modal) *::-webkit-scrollbar-track { background: transparent; }
    :is(.asst-root, .asst-dd-menu, .asst-modal) *::-webkit-scrollbar-corner { background: transparent; }
    :is(.asst-root, .asst-dd-menu, .asst-modal) *::-webkit-scrollbar-thumb { background: var(--asst-fill-3); border: 2px solid transparent; border-radius: 8px; background-clip: padding-box; }

    /* ── Capsules ───────────────────────────────────────────────────────
       Every pill, chip, badge and button is one capsule: an optional glyph
       half, a 1px seam (the two-pill mark), a label half. Its corners are a
       quarter of its height (--asst-pill-r-*: 5/6/8px), a rounded rectangle
       like the tray pills, never a full capsule.
       md (28) is the default here: the composer row, cards and buttons; the
       toolbar and chips are sm (22); counts and meta are xs (18). A value
       (a field, a count, a status) wears a fill and a ring; an icon-only
       action is a bare square of its row's height until hovered. Labels are
       sans 500, values (model ids, paths, counts, durations) mono. Gold only
       for selected or working, red only for failed.
       Glyphs sit dead centre, by one rule: a glyph is inset by --cap-glyph-pad
       on both sides, (--cap-h − --cap-icon) / 2, so a glyph half is a --cap-h
       square (then the seam), and a capsule down to its glyph (the container
       queries at the end) is that square alone: grid-centred, padding 0, no
       seam, no label half. Icon-only actions are --cap-h squares, grid-centred.
       SVGs are display:block, so no baseline gap moves them. */
    :is(.asst-dd, .asst-tb-btn, .asst-iconbtn, .asst-btn, .asst-chip, .asst-cost, .asst-send) {
      --cap-h: var(--asst-pill-h-md);
      --cap-r: var(--asst-pill-r-md);
      --cap-px: var(--asst-pill-px-md);
      --cap-gap: 7px;
      --cap-icon: 14px;
      --cap-fs: 12px;
      --cap-glyph-pad: calc((var(--cap-h) - var(--cap-icon)) / 2);
      position: relative;
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      gap: var(--cap-gap);
      height: var(--cap-h);
      min-width: var(--cap-h);
      padding: 0 var(--cap-px);
      border: 0;
      border-radius: var(--cap-r);
      background: var(--asst-fill-1);
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text-2);
      font: inherit;
      font-size: var(--cap-fs);
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
      text-decoration: none;
      cursor: pointer;
      transition:
        background-color var(--asst-dur-fast) var(--asst-ease-standard),
        box-shadow var(--asst-dur-fast) var(--asst-ease-standard),
        color var(--asst-dur-fast) var(--asst-ease-standard),
        opacity var(--asst-dur-fast) var(--asst-ease-standard),
        transform var(--asst-dur-instant) var(--asst-ease-standard);
    }
    :is(.asst-dd, .asst-tb-btn, .asst-iconbtn, .asst-btn, .asst-cost, .asst-send) > svg,
    :is(.asst-dd, .asst-tb-btn, .asst-chip, .asst-btn) > .asst-icon svg { display: block; width: var(--cap-icon); height: var(--cap-icon); }
    :is(.asst-tb-btn, .asst-iconbtn, .asst-send) > svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    /* sm: the toolbar (terminal tab or sidepanel header) and chips; xs: counts and meta. */
    .asst-bar :is(.asst-dd, .asst-tb-btn, .asst-iconbtn, .asst-cost), .asst-chip {
      --cap-h: var(--asst-pill-h-sm);
      --cap-r: var(--asst-pill-r-sm);
      --cap-px: var(--asst-pill-px-sm);
      --cap-gap: 6px;
      --cap-icon: 12px;
      --cap-fs: 11px;
    }
    /* The glyph half runs from the pill's leading edge to the seam: the glyph centred, --cap-glyph-pad each side. */
    :is(.asst-dd, .asst-tb-btn, .asst-chip) > .asst-icon:not([hidden]):not(:last-child) {
      align-self: stretch;
      margin-left: calc(-1 * var(--cap-px));
      padding: 0 calc(var(--cap-glyph-pad) + 1px) 0 var(--cap-glyph-pad);
      box-shadow: inset -1px 0 0 var(--asst-line);
      color: var(--asst-text-3);
      transition: box-shadow var(--asst-dur-fast) var(--asst-ease-standard), color var(--asst-dur-fast) var(--asst-ease-standard);
    }
    :is(.asst-dd, .asst-tb-btn, .asst-chip):hover > .asst-icon { box-shadow: inset -1px 0 0 var(--asst-line-2); color: var(--asst-text-2); }
    :is(.asst-dd, .asst-tb-btn):is([aria-expanded="true"], [role="switch"][aria-checked="true"]) > .asst-icon { box-shadow: inset -1px 0 0 var(--asst-pill-on-ring); color: var(--asst-brand); }
    /* Icon-only actions: bare squares with their row's corners until hovered, the glyph grid-centred. */
    :is(.asst-iconbtn, .asst-tb-btn.asst-attach) { display: grid; place-items: center; width: var(--cap-h); padding: 0; background: transparent; box-shadow: none; color: var(--asst-text-3); }
    .asst-iconbtn:has(> .asst-count:not([hidden])) { display: inline-flex; width: auto; gap: 4px; padding: 0 2px 0 calc(var(--cap-px) - 2px); }
    /* States */
    :is(.asst-dd, .asst-tb-btn, .asst-iconbtn, .asst-btn, .asst-cost):hover:not(:disabled) {
      background: var(--asst-fill-2);
      box-shadow: inset 0 0 0 1px var(--asst-line-2);
      color: var(--asst-text);
    }
    :is(.asst-dd, .asst-tb-btn, .asst-iconbtn, .asst-btn, .asst-cost, .asst-send, .asst-chip-x, .asst-chip.asst-suggestion):active:not(:disabled) { transform: scale(.97); transition-duration: 90ms; }
    /* Selected: the control whose menu is open, a switch that is on, a pressed toggle. */
    :is(.asst-dd, .asst-tb-btn, .asst-iconbtn, .asst-cost):is([aria-expanded="true"], [aria-pressed="true"], [role="switch"][aria-checked="true"]),
    :is(.asst-dd, .asst-tb-btn, .asst-iconbtn, .asst-cost):is([aria-expanded="true"], [aria-pressed="true"], [role="switch"][aria-checked="true"]):hover:not(:disabled) {
      background: var(--asst-pill-on-fill);
      box-shadow: inset 0 0 0 1px var(--asst-pill-on-ring);
      color: var(--asst-text);
    }
    :is(.asst-dd, .asst-tb-btn, .asst-iconbtn, .asst-btn, .asst-cost):is(:disabled, [aria-disabled="true"]) { opacity: .4; cursor: default; }
    :is(.asst-dd, .asst-tb-btn)[aria-busy="true"] { cursor: progress; opacity: .7; }
    /* Interactive xs/sm pills reach 24px+ with an invisible margin (under their content). */
    :is(.asst-bar :is(.asst-dd, .asst-tb-btn, .asst-iconbtn, .asst-cost), .asst-chip-x) { isolation: isolate; }
    :is(.asst-bar :is(.asst-dd, .asst-tb-btn, .asst-iconbtn, .asst-cost), .asst-chip-x)::after { content: ''; position: absolute; inset: -3px; z-index: -1; border-radius: inherit; }
    /* A count: xs, mono, tabular. */
    .asst-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: var(--asst-pill-h-xs);
      height: var(--asst-pill-h-xs);
      padding: 0 var(--asst-pill-px-xs);
      border-radius: var(--asst-pill-r-xs);
      background: var(--asst-fill-2);
      color: var(--asst-text);
      font-family: var(--asst-mono);
      font-size: 10.5px;
      font-weight: 500;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .asst-count.attention { color: var(--asst-warn); box-shadow: inset 0 0 0 1px var(--asst-pill-warn-ring); }
    /* The running cameo: the mascot's two pill eyes, glancing ±1.2px every 1.4s.
       One form everywhere (the header status, the tray pill, run pills):
       mascotCameoSvg() from synabun-mascot.js, a 10×7 SVG. */
    .syna-cameo { display: inline-block; flex-shrink: 0; overflow: visible; color: var(--asst-brand); }
    .syna-cameo-eye { transform-box: fill-box; animation: asst-cameo 2.8s var(--asst-ease-emphasized) infinite; }

    /* ── Toolbar: flush under the terminal tabs ─────────────────────────
       Edge to edge like the tab bar above it (same hairline), no card and no
       title: the tab names the session. Left: brain · route · context ·
       computer groups (thin separators; a group with nothing shown disappears
       with its separator). Right: agents · cost · history · new · "⋯", never
       squeezed out — container queries hide left controls first. */
    .asst-bar {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      height: 36px;
      padding: 0 6px 0 8px;
      background: var(--asst-bar);
      border-bottom: 1px solid var(--asst-card-ring);
    }
    .asst-bar-left {
      display: flex;
      flex: 1 1 auto;
      align-items: center;
      min-width: 0;
      overflow: hidden;
      /* room for the focus ring inside the clipped group */
      margin: -4px 0 -4px -4px;
      padding: 4px;
    }
    .asst-bar-group { display: flex; flex: 0 1 auto; align-items: center; gap: 4px; min-width: 0; }
    .asst-bar-group:not(:has(> :not([hidden]))) { display: none; }
    .asst-bar-group + .asst-bar-group::before {
      content: '';
      flex-shrink: 0;
      width: 1px;
      height: 16px;
      margin: 0 6px;
      background: var(--asst-line);
    }
    .asst-bar-right { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
    /* Cost: a value (mono); over the cap is a failure and says so with a bang. */
    .asst-cost { font-family: var(--asst-mono); font-variant-numeric: tabular-nums; }
    .asst-cost[data-tone="warn"] { color: var(--asst-warn); box-shadow: inset 0 0 0 1px var(--asst-pill-warn-ring); }
    .asst-cost[data-tone="over"] { background: var(--asst-pill-err-fill); box-shadow: inset 0 0 0 1px var(--asst-pill-err-ring); color: var(--asst-text); }
    .asst-cost[data-tone="over"]::before { content: '!'; margin-right: -2px; color: var(--asst-live); font-weight: 700; }
    /* The float header's brain chip would repeat the model field right below it. */
    .term-float-tab:has(.assistant-viewport) .term-float-brain-chip { display: none !important; }

    /* ── Banners ────────────────────────────────────────────────────── */
    .asst-banners { flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; margin: 6px var(--asst-inline) 0; }
    .asst-banners:empty { display: none; }
    .asst-banner {
      --tone: var(--asst-warn);
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 30px;
      padding: 3px 4px 3px 10px;
      border-radius: var(--asst-r-field);
      background: transparent;
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text-2);
      font-size: 12px;
    }
    .asst-banner::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--tone); flex-shrink: 0; }
    .asst-banner.info { --tone: var(--asst-text-3); }
    .asst-banner.error { --tone: var(--asst-live); }
    .asst-banner-text { flex: 1; min-width: 0; }

    /* ── Transcript ─────────────────────────────────────────────────── */
    .asst-transcript {
      flex: 1 1 auto;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 14px calc(var(--asst-inline) + 12px) 16px;
      background: var(--asst-bg);
      overscroll-behavior: contain;
      scroll-behavior: smooth;
      scrollbar-width: thin;
      scrollbar-color: var(--asst-fill-3) transparent;
    }
    .asst-transcript::-webkit-scrollbar { width: 10px; }
    .asst-transcript::-webkit-scrollbar-track { background: transparent; }
    .asst-transcript::-webkit-scrollbar-thumb { background: var(--asst-fill-3); border: 3px solid transparent; border-radius: 10px; background-clip: padding-box; }
    .asst-transcript::-webkit-scrollbar-thumb:hover { background-color: rgba(255,255,255,.18); }
    .asst-transcript > * + * { margin-top: 12px; }
    .asst-transcript > .asst-msg.msg-assistant + .asst-msg.msg-assistant,
    .asst-transcript > .asst-status + .asst-status,
    .asst-transcript > .asst-route-line + .asst-route-line { margin-top: 4px; }
    .asst-transcript > .asst-working { margin-top: 8px; }

    /* ── Empty state ────────────────────────────────────────────────── */
    .asst-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      min-height: 100%;
      padding: 16px 4px;
      text-align: center;
    }
    .asst-empty-title { color: var(--asst-text); font-family: var(--ff-heading, inherit); font-size: 20px; font-weight: 600; letter-spacing: -.01em; }
    .asst-empty-body { max-width: 440px; color: var(--asst-text-3); font-size: 13px; line-height: 1.55; }
    .asst-suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; max-width: 560px; margin-top: 6px; }
    .asst-chip.asst-suggestion { --cap-h: var(--asst-pill-h-md); --cap-r: var(--asst-pill-r-md); --cap-px: var(--asst-pill-px-md); --cap-fs: 12px; justify-content: flex-start; text-align: left; }
    .asst-chip.asst-suggestion > .asst-icon svg { width: 20px; height: 14px; }
    .asst-chip.asst-suggestion > .asst-icon { color: var(--asst-text-3); }
    .asst-chip.asst-suggestion:is(:hover, :focus-visible) > .asst-icon { color: var(--asst-text); }

    /* ── Messages ───────────────────────────────────────────────────── */
    .asst-msg { display: flex; flex-direction: column; min-width: 0; }
    .asst-msg-content { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .asst-msg.msg-user { align-items: flex-end; }
    .asst-msg.msg-user .asst-msg-content {
      max-width: min(80%, 620px);
      gap: 6px;
      padding: 8px 12px;
      border-radius: var(--asst-r-bubble);
      background: var(--asst-fill-2);
      color: var(--asst-text);
      font-size: 14px;
      line-height: 1.5;
    }
    .asst-msg-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .asst-msg-attachments { display: flex; flex-wrap: wrap; gap: 4px; }
    /* A prompt written outside the panel (WhatsApp Link). */
    .asst-msg-origin { margin-top: 3px; padding: 0 4px; color: var(--asst-text-3, var(--asst-text-2)); font-size: 11px; line-height: 1.3; }

    .asst-md { color: var(--asst-text); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
    .asst-md > :first-child { margin-top: 0; }
    .asst-md > :last-child { margin-bottom: 0; }
    .asst-md p { margin: 0 0 10px; }
    .asst-md :is(h1, h2, h3, h4) { margin: 16px 0 8px; color: var(--asst-text); font-weight: 600; line-height: 1.3; }
    .asst-md h1 { font-size: 18px; }
    .asst-md h2 { font-size: 16px; }
    .asst-md :is(h3, h4) { font-size: 14px; }
    .asst-md :is(ul, ol) { margin: 0 0 10px; padding-left: 22px; }
    .asst-md li { margin: 3px 0; }
    .asst-md li::marker { color: var(--asst-text-3); }
    .asst-md code { padding: 1px 5px; border-radius: 5px; background: var(--asst-fill-2); font-family: var(--asst-mono); font-size: .86em; }
    .asst-md pre { margin: 8px 0 12px; padding: 10px 12px; overflow-x: auto; border: 1px solid var(--asst-line); border-radius: 8px; background: var(--asst-field); }
    .asst-md pre code { padding: 0; background: transparent; font-size: 12.5px; line-height: 1.55; }
    .asst-md blockquote { margin: 8px 0; padding: 2px 12px; border-left: 2px solid var(--asst-line-2); color: var(--asst-text-2); }
    .asst-md :is(a, .file-link) { color: var(--asst-focus); text-decoration: none; cursor: pointer; }
    .asst-md a:hover { text-decoration: underline; }
    .asst-md table { display: block; max-width: 100%; overflow-x: auto; margin: 8px 0 12px; border-collapse: collapse; font-size: 12.5px; }
    .asst-md :is(th, td) { padding: 5px 10px; border: 1px solid var(--asst-line); text-align: left; }
    .asst-md th { color: var(--asst-text-2); font-weight: 600; background: var(--asst-field); }
    .asst-md hr { margin: 12px 0; border: 0; border-top: 1px solid var(--asst-line); }

    .asst-thinking { color: var(--asst-text-3); font-size: 12.5px; }
    .asst-thinking summary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: -6px;
      padding: 2px 8px 2px 6px;
      border-radius: 6px;
      color: var(--asst-text-3);
      list-style: none;
      cursor: pointer;
      user-select: none;
    }
    .asst-thinking summary::-webkit-details-marker { display: none; }
    .asst-thinking summary:hover { background: var(--asst-fill-1); color: var(--asst-text-2); }
    .asst-thinking-chev { display: inline-block; transition: transform var(--asst-dur-base) var(--asst-ease-standard); }
    .asst-thinking[open] .asst-thinking-chev { transform: rotate(90deg); }
    .asst-thinking-content {
      max-height: 240px;
      overflow-y: auto;
      margin: 4px 0 2px 5px;
      padding: 2px 0 2px 12px;
      border-left: 1px solid var(--asst-line);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.55;
    }

    .asst-status { color: var(--asst-text-3); font-size: 12px; }
    .asst-status.info { color: var(--asst-text-2); }
    .asst-status.error { color: var(--asst-live); }
    .asst-divider { display: flex; align-items: center; gap: 10px; color: var(--asst-text-3); font-size: 11px; }
    .asst-divider::before, .asst-divider::after { content: ''; flex: 1; height: 1px; background: var(--asst-line); }

    /* "Thinking" is always the last transcript row: the mascot thinking (56×28) and the verb,
       when no other character is on screen (asst-render.js syncWorkingFace), else the verb alone. */
    .asst-working { display: flex; align-items: center; gap: 10px; min-height: 28px; color: var(--asst-text-2); font-size: 12.5px; }
    .asst-working-face { display: inline-flex; flex-shrink: 0; color: var(--asst-text); line-height: 0; }
    .asst-working-face:empty { display: none; }
    .asst-working-face svg { display: block; width: 56px; height: 28px; }
    /* The hero's hand-off (asst-render.js settleHero): the face flies in from the empty state, over the prompt. */
    .asst-working.is-flip .asst-working-face { position: relative; z-index: 3; }

    /* ── Tool rows ──────────────────────────────────────────────────── */
    .asst-tool { min-width: 0; font-size: 12.5px; }
    .asst-tool-hdr {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      margin: 0 -8px;
      padding: 4px 8px;
      border-radius: var(--asst-r-ctl);
      color: var(--asst-text-2);
      cursor: pointer;
      user-select: none;
    }
    .asst-tool-hdr:hover { background: var(--asst-fill-1); }
    .asst-tool-name { flex-shrink: 0; color: var(--asst-text); font-weight: 500; }
    .asst-tool-detail { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--asst-text-3); font-family: var(--asst-mono); font-size: 11.5px; }
    .asst-tool-state { flex-shrink: 0; color: var(--asst-text-3); font-size: 11px; }
    .asst-tool-body { display: none; margin: 2px 0 6px 7px; padding: 2px 0 2px 14px; border-left: 1px solid var(--asst-line); }
    .asst-tool-label { margin: 6px 0 4px; color: var(--asst-text-3); font-size: 11px; }
    .asst-tool-section {
      max-height: 260px;
      overflow: auto;
      margin: 0;
      padding: 8px 10px;
      border: 1px solid var(--asst-line);
      border-radius: var(--asst-r-field);
      background: var(--asst-field);
      color: var(--asst-text-2);
      font-family: var(--asst-mono);
      font-size: 11.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .asst-agent-feed { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }

    /* Computer-use frames: outside the collapsible body, visible while collapsed. */
    .asst-computer-frame {
      position: relative;
      display: block;
      width: min(100% - 24px, 260px);
      aspect-ratio: 16 / 10;
      margin: 2px 0 4px 24px;
      padding: 0;
      border: 0;
      border-radius: var(--asst-r-field);
      overflow: hidden;
      background: var(--asst-field);
      box-shadow: 0 0 0 1px var(--asst-line);
      cursor: zoom-in;
    }
    .asst-computer-frame:hover { box-shadow: 0 0 0 1px var(--asst-line-2); }
    .asst-computer-frame img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .asst-computer-frame.failed { display: none; }
    .asst-computer-frame.compact {
      display: inline-flex;
      align-items: center;
      width: auto;
      height: 24px;
      aspect-ratio: auto;
      padding: 0 10px;
      border-radius: var(--asst-pill-r-sm);
      background: transparent;
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text-3);
      font: inherit;
      font-size: 11.5px;
      cursor: pointer;
    }
    .asst-computer-frame.compact .asst-frame-marker { display: none; }
    .asst-frame-marker {
      position: absolute;
      width: 14px;
      height: 14px;
      margin: -7px 0 0 -7px;
      border: 2px solid var(--asst-live);
      border-radius: 50%;
      box-shadow: 0 0 0 2px rgba(0,0,0,.5);
      pointer-events: none;
    }

    /* ── Chips ──────────────────────────────────────────────────────── */
    .asst-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .asst-chips-label { margin-right: 2px; color: var(--asst-text-3); font-size: 11px; }
    /* Chips (sm): attachments, the queue, memories, suggestions (md). The label truncates, the chip never clips its ✕. */
    .asst-chip { justify-content: flex-start; max-width: 280px; }
    .asst-chip:hover:not(.static) { background: var(--asst-fill-2); box-shadow: inset 0 0 0 1px var(--asst-line-2); color: var(--asst-text); }
    .asst-chip.static { cursor: default; }
    .asst-chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .asst-chip:is([data-kind="file"], [data-kind="upload"], [data-kind="image"]) .asst-chip-text { font-family: var(--asst-mono); font-weight: 400; }
    .asst-chip-meta { flex-shrink: 0; color: var(--asst-text-3); font-family: var(--asst-mono); font-size: 10.5px; font-weight: 400; font-variant-numeric: tabular-nums; }
    .asst-chip.mailbox.attention { color: var(--asst-warn); box-shadow: inset 0 0 0 1px var(--asst-pill-warn-ring); }
    .asst-composer-queue .asst-chip-meta { font-family: inherit; font-size: 11px; }
    .asst-chip img { width: 14px; height: 14px; flex-shrink: 0; margin-left: -2px; object-fit: cover; border-radius: 4px; }
    .asst-chip-x {
      position: relative;
      display: inline-flex;
      flex-shrink: 0;
      align-items: center;
      justify-content: center;
      width: var(--asst-pill-h-xs);
      height: var(--asst-pill-h-xs);
      margin-right: calc(4px - var(--cap-px));
      padding: 0;
      border: 0;
      border-radius: var(--asst-pill-r-xs);
      background: transparent;
      color: var(--asst-text-3);
      font: inherit;
      cursor: pointer;
      transition: background-color var(--asst-dur-fast) var(--asst-ease-standard), color var(--asst-dur-fast) var(--asst-ease-standard), transform var(--asst-dur-instant) var(--asst-ease-standard);
    }
    .asst-chip-x svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; }
    .asst-chip-x:hover { background: var(--asst-fill-3); color: var(--asst-text); }
    /* An upload in flight fills the chip left to right (--asst-upload, set by the composer). */
    .asst-chip.static[data-state="uploading"] {
      background: linear-gradient(90deg, var(--asst-fill-3) var(--asst-upload, 0%), var(--asst-fill-1) var(--asst-upload, 0%));
      color: var(--asst-text-2);
    }

    /* ── Route lines ────────────────────────────────────────────────── */
    .asst-route-line { font-size: 12.5px; }
    .asst-route-line-head {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: calc(100% + 8px);
      min-height: 26px;
      margin-left: -8px;
      padding: 3px 8px;
      border: 0;
      border-radius: var(--asst-r-ctl);
      background: transparent;
      color: var(--asst-text-2);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .asst-route-line-head:hover { background: var(--asst-fill-1); }
    .asst-route-glyph { color: var(--asst-brand); }
    .asst-route-arrow, .asst-route-chev { color: var(--asst-text-4); }
    .asst-route-kind { color: var(--asst-text-3); font-size: 11.5px; }
    .asst-route-icon svg { width: 12px; height: 12px; }
    .asst-route-target { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--asst-text); font-weight: 500; }
    .asst-route-meta, .asst-route-state { flex-shrink: 0; color: var(--asst-text-3); white-space: nowrap; }
    .asst-route-line.pending .asst-route-state { color: var(--asst-warn); }
    .asst-route-line.muted .asst-route-glyph { color: var(--asst-text-4); }
    .asst-route-line.muted .asst-route-class { color: var(--asst-text-3); }
    .asst-route-chev { transition: transform var(--asst-dur-base) var(--asst-ease-standard); }
    .asst-route-line.open .asst-route-chev { transform: rotate(90deg); }
    .asst-route-detail {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin: 2px 0 4px 5px;
      padding: 4px 0 4px 14px;
      border-left: 1px solid var(--asst-line);
      color: var(--asst-text-3);
      font-size: 12px;
    }
    .asst-link { padding: 0; border: 0; background: transparent; color: var(--asst-focus); font: inherit; text-align: left; cursor: pointer; }
    .asst-link:hover { text-decoration: underline; }
    .asst-link:disabled { color: var(--asst-text-4); cursor: default; text-decoration: none; }

    /* ── Run cards (transcript + agents tray) ───────────────────────── */
    .asst-run {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      column-gap: 10px;
      row-gap: 2px;
      align-items: center;
      padding: 8px 10px;
      border: 1px solid var(--asst-line);
      border-radius: var(--asst-r-card);
      background: transparent;
      font-size: 12.5px;
    }
    .asst-run.compact { padding: 5px 8px; border-color: transparent; border-radius: var(--asst-r-ctl); }
    .asst-run.compact:hover { background: var(--asst-fill-1); }
    .asst-run-icon {
      grid-row: 1 / span 2;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: var(--asst-pill-r-sm);
      background: var(--asst-fill-1);
      color: var(--asst-text-2);
      transition: color var(--asst-dur-fast) var(--asst-ease-standard);
    }
    .asst-run:hover .asst-run-icon { color: var(--asst-provider-color, var(--asst-text-2)); }
    .asst-run-icon svg { width: 12px; height: 12px; }
    .asst-run-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .asst-run-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--asst-text); }
    .asst-run-meta { grid-column: 2; min-width: 0; color: var(--asst-text-3); font-size: 11px; line-height: 1.5; }
    .asst-run-meta > span:not(.asst-run-sep) { white-space: nowrap; }
    .asst-run-route { color: var(--asst-text-2); }
    .asst-run-actions { grid-row: 1 / span 2; grid-column: 3; display: flex; align-items: center; gap: 2px; }
    .asst-run-summary { grid-column: 2 / span 2; max-height: 160px; overflow: auto; margin-top: 4px; color: var(--asst-text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
    /* Image / video creation: what the run generated (a click opens the lightbox; videos play inline). */
    .asst-run-media { grid-column: 2 / span 2; display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .asst-run-media-thumb { display: block; width: 88px; height: 88px; padding: 0; border: 0; border-radius: var(--asst-r-field); overflow: hidden; background: var(--asst-field); box-shadow: 0 0 0 1px var(--asst-line); cursor: zoom-in; }
    .asst-run-media-thumb:hover { box-shadow: 0 0 0 1px var(--asst-line-2); }
    .asst-run-media-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .asst-run-media-thumb.failed { display: none; }
    .asst-run-media-video { display: block; width: min(100%, 320px); max-height: 220px; border-radius: var(--asst-r-field); background: #000; box-shadow: 0 0 0 1px var(--asst-line); }
    .asst-run-escalate { grid-column: 2 / span 2; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
    .asst-run-escalate-reason { color: var(--asst-warn); font-size: 11.5px; }
    /* A run's status pill (sm): the shape says the state, the fill only for working (gold) or failed (red). */
    .asst-pill {
      display: inline-flex;
      flex-shrink: 0;
      align-items: center;
      gap: 6px;
      height: var(--asst-pill-h-sm);
      padding: 0 var(--asst-pill-px-sm) 0 7px;
      border-radius: var(--asst-pill-r-sm);
      background: var(--asst-fill-1);
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text-2);
      font-size: 11px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
    }
    .asst-pill::before { content: ''; flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--asst-text-3); }
    .asst-pill > .syna-cameo { display: none; }
    .asst-pill[data-tone="running"] { background: var(--asst-pill-on-fill); box-shadow: inset 0 0 0 1px var(--asst-pill-on-ring); color: var(--asst-text); }
    .asst-pill[data-tone="running"]::before { display: none; }
    .asst-pill[data-tone="running"] > .syna-cameo { display: inline-block; margin-left: 1px; }
    .asst-pill[data-tone="action"] { box-shadow: inset 0 0 0 1px var(--asst-pill-warn-ring); color: var(--asst-text); }
    .asst-pill[data-tone="action"]::before { width: 5px; height: 5px; border-radius: 1px; background: var(--asst-warn); transform: rotate(45deg); }
    .asst-pill[data-tone="done"] { background: transparent; color: var(--asst-text-3); }
    .asst-pill[data-tone="done"]::before { width: 7px; height: 3.5px; margin: -2px 0 0 1px; border: solid currentColor; border-width: 0 0 1.5px 1.5px; border-radius: 0; background: none; transform: rotate(-45deg); }
    .asst-pill[data-tone="error"] { background: var(--asst-pill-err-fill); box-shadow: inset 0 0 0 1px var(--asst-pill-err-ring); color: var(--asst-text); }
    .asst-pill[data-tone="error"]::before { content: '!'; width: auto; height: auto; margin: 0 -1px 0 1px; border-radius: 0; background: none; color: var(--asst-live); font-weight: 700; }
    .asst-pill[data-tone="queued"] { background: transparent; color: var(--asst-text-3); }
    .asst-pill[data-tone="queued"]::before { background: transparent; box-shadow: inset 0 0 0 1.5px var(--asst-text-3); }
    .asst-pill[data-tone="idle"] { color: var(--asst-text-3); }

    /* ── Bottom card: computer tray · agents tray · composer ────────── */
    .asst-bottom {
      position: relative;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      max-height: 62%;
      margin: 0 var(--asst-inline) 8px;
      background: var(--asst-card);
      border-radius: var(--asst-r-card);
      box-shadow: var(--asst-card-shadow), 0 0 0 1px var(--asst-card-ring), var(--asst-card-hi);
      transition: box-shadow var(--asst-dur-base) var(--asst-ease-standard);
    }
    .asst-bottom:has(.asst-input:focus) { box-shadow: var(--asst-card-shadow), 0 0 0 1px var(--asst-card-ring-focus), var(--asst-card-hi); }
    .asst-computer-host, .asst-dock-host { flex: 0 1 auto; min-height: 0; overflow-y: auto; }
    .asst-composer-host { flex: 0 0 auto; min-width: 0; }

    .asst-dock { display: flex; flex-direction: column; min-height: 0; border-bottom: 1px solid var(--asst-line); }
    .asst-dock-head { display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 4px 6px; }
    .asst-dock-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      height: var(--asst-pill-h-md);
      padding: 0 10px 0 8px;
      border: 0;
      border-radius: var(--asst-pill-r-md);
      background: transparent;
      color: var(--asst-text-2);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: background-color var(--asst-dur-fast) var(--asst-ease-standard);
    }
    .asst-dock-toggle:hover { background: var(--asst-fill-1); }
    .asst-dock-chev { color: var(--asst-text-3); transition: transform var(--asst-dur-base) var(--asst-ease-standard); }
    .asst-dock.open .asst-dock-chev { transform: rotate(90deg); }
    .asst-dock-title { color: var(--asst-text); font-weight: 500; }
    .asst-dock-summary { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--asst-text-3); }
    .asst-dock.attention .asst-dock-summary { color: var(--asst-warn); }
    .asst-dock-spacer { flex: 1; }
    .asst-dock-body { display: flex; flex-direction: column; gap: 2px; max-height: min(40cqh, 260px); overflow-y: auto; padding: 0 6px 6px; }


    .asst-usage-host {
      --asst-usage-neutral-0: color-mix(in srgb, var(--asst-text) 82%, var(--asst-popover));
      --asst-usage-neutral-1: color-mix(in srgb, var(--asst-text) 74%, var(--asst-popover));
      --asst-usage-neutral-2: color-mix(in srgb, var(--asst-text) 66%, var(--asst-popover));
      --asst-usage-neutral-3: color-mix(in srgb, var(--asst-text) 58%, var(--asst-popover));
      --asst-usage-neutral-4: color-mix(in srgb, var(--asst-text) 78%, var(--asst-popover));
      --asst-usage-neutral-5: color-mix(in srgb, var(--asst-text) 70%, var(--asst-popover));
      --asst-usage-neutral-6: color-mix(in srgb, var(--asst-text) 62%, var(--asst-popover));
      --asst-usage-neutral-7: color-mix(in srgb, var(--asst-text) 54%, var(--asst-popover));
      position: relative;
      flex: 0 0 auto;
      min-width: 0;
      padding: 8px 6px;
      border-bottom: 1px solid var(--asst-line);
      container: asst-usage / inline-size;
    }
    .asst-usage-host[hidden] { display: none !important; }
    .asst-usage-strip {
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      height: 28px;
      min-width: 0;
      padding: 0 8px;
      border: 0;
      border-radius: var(--asst-pill-r-md);
      background: transparent;
      color: var(--asst-text-2);
      text-align: start;
      cursor: pointer;
      transition: background-color var(--asst-dur-fast) var(--asst-ease-standard);
    }
    .asst-usage-strip::before { content: ''; position: absolute; inset: -8px 0; }
    .asst-usage-strip:hover { background: var(--asst-fill-2); }
    .asst-usage-strip[aria-expanded="true"] { background: var(--asst-fill-1); }
    .asst-usage-strip:focus-visible, .asst-usage-copy:focus-visible {
      outline: 2px solid var(--asst-focus);
      outline-offset: 2px;
    }
    .asst-usage-dot { position: relative; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--asst-text-3); }
    .asst-usage-host[data-status="live"] .asst-usage-dot { background: var(--asst-brand); animation: asst-usage-pulse 1.8s ease-in-out infinite; }
    .asst-usage-host[data-status="partial"] .asst-usage-dot { background: var(--asst-warn); }
    .asst-usage-host[data-connection="offline"] .asst-usage-dot { background: var(--asst-warn); animation: none; }
    .asst-usage-host[data-connection="paused"] .asst-usage-dot { background: var(--asst-warn); animation: none; }
    .asst-usage-label { flex: none; color: var(--asst-text-2); font-size: 11px; font-weight: 500; }
    .asst-usage-segments {
      display: flex;
      flex: 1 1 auto;
      align-items: stretch;
      gap: 2px;
      min-width: 18px;
      height: 7px;
      overflow: hidden;
      border-radius: 2px;
      background: var(--asst-fill-3);
    }
    .asst-usage-segment { flex: 0 1 0; min-width: 0; height: 100%; background: var(--usage-fill, var(--asst-usage-neutral-0)); transition: flex-grow 280ms var(--asst-ease-standard); }
    .asst-usage-segment[data-positive="true"] { min-width: 1px; }
    .asst-usage-segment[data-working="true"] { background: var(--asst-brand); }
    .asst-usage-mark { flex: none; width: 12px; color: var(--asst-brand); font: 700 13px/1 var(--asst-mono); text-align: center; }
    .asst-usage-host[data-status="partial"] .asst-usage-mark { color: var(--asst-warn); }
    .asst-usage-host[data-status="exact"] .asst-usage-mark { visibility: hidden; }
    .asst-usage-compact {
      flex: none;
      min-width: 10.5ch;
      color: var(--asst-text);
      font: 500 11px/1 var(--asst-mono);
      font-variant-numeric: tabular-nums;
      text-align: end;
      white-space: nowrap;
    }
    /* The two sides and the dollars: inside the strip when it is wide enough, on a line under it otherwise. */
    .asst-usage-io { display: none; flex: none; gap: 8px; color: var(--asst-text-2); font: 500 11px/1 var(--asst-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .asst-usage-strip-cost { display: none; flex: none; color: var(--asst-text-2); font: 500 11px/1 var(--asst-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .asst-usage-subline { padding: 2px 8px 0 23px; color: var(--asst-text-3); font: 500 10px/1.3 var(--asst-mono); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .asst-usage-io[hidden], .asst-usage-strip-cost[hidden], .asst-usage-subline[hidden] { display: none !important; }
    @container asst-usage (min-width: 460px) {
      .asst-usage-io { display: inline-flex; }
      .asst-usage-strip-cost { display: inline; }
      .asst-usage-subline { display: none; }
    }
    .asst-usage-chevron { flex: none; color: var(--asst-text-3); font-size: 13px; line-height: 1; transition: transform var(--asst-dur-base) var(--asst-ease-standard); }
    .asst-usage-strip[aria-expanded="true"] .asst-usage-chevron { transform: rotate(180deg); }
    .asst-usage-popover {
      position: absolute;
      inset-inline: 4px;
      bottom: calc(100% + 8px);
      z-index: 20;
      max-height: min(72dvh, 780px);
      min-width: 0;
      overflow: auto;
      overscroll-behavior: contain;
      padding: 12px;
      border: 1px solid var(--asst-popover-ring);
      border-radius: var(--asst-r-card);
      background: var(--asst-popover);
      box-shadow: var(--asst-popover-shadow);
      scrollbar-width: thin;
      scrollbar-color: var(--asst-fill-3) transparent;
    }
    .asst-usage-popover[hidden] { display: none !important; }
    .asst-usage-head { display: flex; align-items: flex-start; gap: 8px; }
    .asst-usage-head-main { flex: 1 1 auto; min-width: 0; }
    .asst-usage-eyebrow, .asst-usage-section-title {
      color: var(--asst-text-3); font-size: 10px; font-weight: 600; letter-spacing: .10em; text-transform: uppercase;
    }
    .asst-usage-task-title { margin: 3px 0 0; color: var(--asst-text-2); font-size: 11px; font-weight: 400; line-height: 1.45; overflow-wrap: anywhere; }
    .asst-usage-copy { flex: none; min-width: 58px; min-height: 44px; margin-block-start: -7px; margin-inline-end: -6px; padding: 0 8px; border: 0; border-radius: var(--asst-pill-r-sm); background: transparent; color: var(--asst-text-2); font-size: 11px; cursor: pointer; }
    .asst-usage-copy:hover { background: var(--asst-fill-2); color: var(--asst-text); }
    .asst-usage-total-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; margin-top: 12px; }
    .asst-usage-total { color: var(--asst-text); font: 500 25px/1.1 var(--asst-mono); font-variant-numeric: tabular-nums; letter-spacing: -.06em; white-space: nowrap; }
    .asst-usage-total-unit { color: var(--asst-text-3); font-size: 11px; }
    .asst-usage-sides { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px 12px; margin: 10px 0 0; }
    .asst-usage-side { min-width: 0; }
    .asst-usage-side dt { color: var(--asst-text-3); font-size: 10px; }
    .asst-usage-side dd { margin: 3px 0 0; color: var(--asst-text); font: 500 13px/1.3 var(--asst-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .asst-usage-note { margin: 9px 0 0; color: var(--asst-text-3); font-size: 10px; line-height: 1.45; }
    .asst-usage-model-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
    .asst-usage-model { min-width: 0; padding: 7px 0; border-top: 1px solid var(--asst-line); }
    .asst-usage-model:first-child { padding-top: 0; border-top: 0; }
    .asst-usage-model-top { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
    .asst-usage-model-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; color: var(--asst-text); font-size: 11px; font-weight: 500; line-height: 1.35; }
    .asst-usage-model-cost { flex: none; color: var(--asst-text); font: 500 11px/1.3 var(--asst-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .asst-usage-model-io { display: flex; flex-wrap: wrap; gap: 2px 10px; margin-top: 3px; color: var(--asst-text-2); font: 500 10px/1.4 var(--asst-mono); font-variant-numeric: tabular-nums; }
    .asst-usage-model-meta { margin-top: 2px; color: var(--asst-text-3); font-size: 10px; line-height: 1.4; }
    .asst-usage-model[data-cost-basis="unpriced"] .asst-usage-model-meta { color: var(--asst-warn); }
    .asst-usage-task-name { color: var(--asst-text); font-size: 11px; font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; }
    .asst-usage-task-line { margin-top: 3px; color: var(--asst-text-2); font: 500 10px/1.5 var(--asst-mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .asst-usage-task-line[data-fidelity="partial"] { color: var(--asst-warn); }
    .asst-usage-agents-title { margin: 10px 0 8px; color: var(--asst-text-3); font-size: 10px; font-weight: 500; }
    .asst-usage-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 9px; color: var(--asst-text-2); font-size: 11px; }
    .asst-usage-cost { color: var(--asst-text-2); font-family: var(--asst-mono); font-variant-numeric: tabular-nums; }
    .asst-usage-status { display: inline-flex; align-items: center; gap: 5px; color: var(--asst-text-2); }
    .asst-usage-status::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--asst-text-3); }
    .asst-usage-host[data-status="live"] .asst-usage-status::before { background: var(--asst-brand); }
    .asst-usage-host[data-status="partial"] .asst-usage-status { color: var(--asst-warn); }
    .asst-usage-host[data-status="partial"] .asst-usage-status::before { background: var(--asst-warn); }
    .asst-usage-reason { width: 100%; color: var(--asst-warn); line-height: 1.45; }
    .asst-usage-connection { width: 100%; color: var(--asst-warn); font-size: 11px; line-height: 1.45; }
    .asst-usage-section { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--asst-line); }
    .asst-usage-section-title { margin: 0 0 9px; }
    .asst-usage-classes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 12px; margin: 0; }
    .asst-usage-class { min-width: 0; }
    .asst-usage-class dt { color: var(--asst-text-3); font-size: 10px; }
    .asst-usage-class dd { margin: 3px 0 0; color: var(--asst-text); font: 500 11px/1.3 var(--asst-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .asst-usage-agent-list, .asst-usage-recent-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
    .asst-usage-agent-empty { color: var(--asst-text-3); font-size: 11px; }
    .asst-usage-agent { min-width: 0; padding: 9px 0; border-top: 1px solid var(--asst-line); }
    .asst-usage-agent:first-child { padding-top: 0; border-top: 0; }
    .asst-usage-agent:last-child { padding-bottom: 0; }
    .asst-usage-agent-top { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
    .asst-usage-agent-title { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; color: var(--asst-text); font-size: 11px; font-weight: 500; line-height: 1.35; }
    .asst-usage-agent-total { flex: none; color: var(--asst-text); font: 500 11px/1.3 var(--asst-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .asst-usage-agent-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 5px; margin-top: 3px; color: var(--asst-text-3); font-size: 10px; line-height: 1.45; }
    .asst-usage-agent-model { min-width: 0; overflow-wrap: anywhere; }
    .asst-usage-agent-state[data-state="running"] { color: var(--asst-brand); }
    .asst-usage-agent-state[data-state="failed"] { color: var(--asst-live); }
    .asst-usage-agent-state[data-fidelity="partial"] { color: var(--asst-warn); }
    .asst-usage-agent-reason { margin-top: 3px; color: var(--asst-warn); font-size: 10px; line-height: 1.4; }
    .asst-usage-agent-share { height: 4px; margin-top: 6px; overflow: hidden; border-radius: 2px; background: var(--asst-fill-3); }
    .asst-usage-agent-share > span { display: block; height: 100%; width: 0; background: var(--usage-fill, var(--asst-usage-neutral-0)); transition: width 280ms var(--asst-ease-standard); }
    .asst-usage-agent[data-state="running"] .asst-usage-agent-share > span { background: var(--asst-brand); }
    .asst-usage-subagents { margin-top: 4px; color: var(--asst-text-3); font-size: 10px; }
    .asst-usage-judgments { padding: 9px 0 0; margin: 9px 0 0; border-top: 1px solid var(--asst-line); list-style: none; }
    .asst-usage-session { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
    .asst-usage-session strong { color: var(--asst-text); font: 500 12px/1.3 var(--asst-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .asst-usage-session-meta { margin-top: 3px; color: var(--asst-text-3); font-size: 10px; }
    .asst-usage-recent-item { display: flex; gap: 6px; min-width: 0; padding: 6px 0; border-top: 1px solid var(--asst-line); color: var(--asst-text-2); font-size: 10px; line-height: 1.4; }
    .asst-usage-recent-item:first-child { border-top: 0; padding-top: 0; }
    .asst-usage-recent-title { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
    .asst-usage-recent-meta { display: block; margin-top: 2px; color: var(--asst-text-3); }
    .asst-usage-recent-total { flex: none; color: var(--asst-text); font-family: var(--asst-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .asst-usage-recent-status[data-fidelity="partial"] { color: var(--asst-warn); }
    .asst-usage-recent-empty { color: var(--asst-text-3); font-size: 10px; }
    .asst-usage-announcer { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    @container asst-usage (min-width: 380px) { .asst-usage-classes { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @container asst-usage (min-width: 520px) { .asst-usage-classes { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
    @container asst-usage (max-width: 340px) {
      .asst-usage-strip { gap: 6px; padding: 0 6px; }
      .asst-usage-popover { padding: 11px; }
      .asst-usage-total { font-size: 23px; }
    }
    @keyframes asst-usage-pulse { 50% { opacity: .45; } }
    @media (prefers-reduced-motion: reduce) {
      .asst-usage-host *, .asst-usage-host *::before, .asst-usage-host *::after { animation: none !important; transition: none !important; }
    }

    .asst-usage-run-tokens { color: var(--asst-text-3); font-family: var(--asst-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }

    /* The provider's usage limit: one line under the gauge, replaced in place (never a transcript row). */
    .asst-limit {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 6px 14px;
      border-bottom: 1px solid var(--asst-line);
      color: var(--asst-warn);
      font-size: 12px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .asst-limit[hidden] { display: none !important; }
    .asst-limit::before { content: ''; flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .8; }
    .asst-limit[data-status="rejected"] { color: var(--asst-live); font-weight: 500; }
    .asst-limit[data-status="rejected"]::before { opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, var(--asst-live) 24%, transparent); }

    .asst-computer { display: block; }
    .asst-computer-tray { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--asst-line); }
    .asst-computer-tray-head { display: flex; align-items: center; gap: 8px; color: var(--asst-text); font-size: 12.5px; font-weight: 500; }
    .asst-computer-tray-head .asst-icon { color: var(--asst-text-2); }
    .asst-computer-tray-body { display: flex; flex-direction: column; gap: 6px; }
    .asst-computer-tray-note { color: var(--asst-text-3); font-size: 12px; line-height: 1.5; }
    .asst-computer-tray-error { color: var(--asst-live); font-size: 12px; }
    .asst-computer-tray-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .asst-computer-log {
      max-height: 120px;
      overflow: auto;
      margin: 0;
      padding: 8px 10px;
      border-radius: var(--asst-r-field);
      background: var(--asst-field);
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text-3);
      font-family: var(--asst-mono);
      font-size: 11px;
      white-space: pre-wrap;
    }
    .asst-computer-perms { display: flex; flex-direction: column; gap: 2px; }
    .asst-computer-perm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 30px; }
    .asst-computer-perm-state { width: 6px; height: 6px; flex-shrink: 0; margin: 0 1px; border-radius: 1px; background: var(--asst-warn); transform: rotate(45deg); }
    .asst-computer-perm[data-granted="1"] .asst-computer-perm-state { border-radius: 50%; background: var(--asst-text-3); transform: none; }
    .asst-computer-perm-label { color: var(--asst-text); font-size: 12.5px; }
    .asst-computer-perm-status { margin-right: auto; color: var(--asst-text-3); font-size: 11.5px; }
    .asst-spinner {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      border: 1.5px solid var(--asst-line-2);
      border-top-color: var(--asst-text-2);
      border-radius: 50%;
      animation: asst-spin .8s linear infinite;
    }
    .asst-computer-activity { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 7px 8px 7px 12px; border-bottom: 1px solid var(--asst-line); }
    .asst-live-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--asst-live); animation: asst-live 1.4s var(--asst-ease-standard) infinite; }
    .asst-computer-activity[data-state="paused_user"] .asst-live-dot { background: var(--asst-warn); animation: none; }
    .asst-computer-stopped-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 1px; background: var(--asst-text-3); }
    .asst-computer-thumb {
      position: relative;
      flex-shrink: 0;
      width: 72px;
      height: 45px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      overflow: hidden;
      background: var(--asst-field);
      box-shadow: 0 0 0 1px var(--asst-line);
      cursor: zoom-in;
    }
    .asst-computer-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .asst-computer-activity-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
    .asst-computer-activity-title, .asst-computer-activity-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .asst-computer-activity-title { color: var(--asst-text); font-size: 12.5px; font-weight: 500; }
    .asst-computer-activity-sub { color: var(--asst-text-3); font-size: 11.5px; }

    /* ── Composer ───────────────────────────────────────────────────── */
    .asst-composer { position: relative; display: flex; flex-direction: column; min-width: 0; }
    .asst-composer.drag-over { outline: 1.5px dashed var(--asst-line-2); outline-offset: -4px; border-radius: var(--asst-r-card); }
    .asst-composer-queue, .asst-composer-attachments { display: flex; flex-wrap: wrap; gap: 6px; max-height: 96px; overflow-y: auto; padding: 10px 12px 0; }
    .asst-input {
      display: block;
      width: 100%;
      min-height: 40px;
      max-height: min(220px, 32cqh);
      padding: 10px 12px 4px;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--asst-text);
      font: inherit;
      font-size: 14px;
      line-height: 1.5;
      resize: none;
      overflow-y: auto;
    }
    .asst-input::placeholder { color: var(--asst-text-3); }
    .asst-composer.disabled .asst-input { opacity: .55; cursor: not-allowed; }

    /* Footer row: attach · the brain's fields · send. The fields clip what does
       not fit but keep 4px for the focus ring. */
    .asst-composer-actions { display: flex; align-items: center; justify-content: flex-start; gap: 6px; min-width: 0; padding: 2px 8px 8px; }
    .asst-brain { display: contents; }
    .asst-composer-actions .asst-send { margin-left: auto; }
    .asst-composer-brain { display: flex; flex: 0 1 auto; align-items: center; gap: 6px; min-width: 0; margin: -4px; padding: 4px; overflow: hidden; }

    /* Fields (toolbar and composer): glyph · seam · value ▾ */
    .asst-dd { flex: 0 1 auto; justify-content: flex-start; max-width: calc(18ch + 60px); }
    .asst-dd .asst-dd-label { min-width: 0; max-width: 18ch; overflow: hidden; text-overflow: ellipsis; }
    /* A display name ("Sonnet 5", a project) is sans; a raw model id (opus[1m]) is mono. */
    .asst-dd.asst-dd-model[data-raw] .asst-dd-label { font-family: var(--asst-mono); font-weight: 400; }
    .asst-dd-caret {
      display: inline-flex;
      flex-shrink: 0;
      margin: 0 -2px 0 -2px;
      color: var(--asst-text-3);
      transition: transform var(--asst-dur-base) var(--asst-ease-standard), color var(--asst-dur-fast) var(--asst-ease-standard);
    }
    .asst-dd-caret svg { width: 8px; height: 8px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .asst-dd:is(:hover, [aria-expanded="true"]) .asst-dd-caret { color: var(--asst-text-2); }
    .asst-dd[aria-expanded="true"] .asst-dd-caret { transform: rotate(180deg); }
    .asst-dd.asst-dd-model:is(:hover, [aria-expanded="true"]) > .asst-icon:not([hidden]):not(:last-child) { color: var(--asst-provider-color, var(--asst-text-2)); }
    /* A pending route card the panel is not showing: the chip says so (its menu replays it). */
    .asst-route-chip .asst-route-waiting {
      display: inline-flex;
      flex-shrink: 0;
      align-items: center;
      height: var(--asst-pill-h-xs);
      margin-right: -2px;
      padding: 0 var(--asst-pill-px-xs);
      border-radius: var(--asst-pill-r-xs);
      box-shadow: inset 0 0 0 1px var(--asst-pill-warn-ring);
      color: var(--asst-warn);
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .asst-route-chip .asst-route-waiting[hidden] { display: none; }
    .asst-route-chip[data-waiting] { max-width: calc(18ch + 110px); }
    .asst-tb-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    /* Computer: the state dot and the screen share the glyph half (one centred pair). Off is a ring,
       ready a dot, setup a diamond, controlling the red live dot. */
    .asst-computer-toggle > .asst-icon { gap: 4px; }
    .asst-computer-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--asst-text-3); }
    .asst-computer-toggle[data-state="ready"] .asst-computer-dot { background: var(--asst-focus); box-shadow: none; }
    .asst-computer-toggle[data-state="setup"] .asst-computer-dot { border-radius: 1px; background: var(--asst-warn); box-shadow: none; transform: rotate(45deg) scale(.9); }
    .asst-computer-toggle[data-state="active"] .asst-computer-dot { background: var(--asst-live); box-shadow: none; animation: asst-live 1.4s var(--asst-ease-standard) infinite; }

    /* Attach and send are md squares. Send: white when there is something to send, quiet when empty. */
    .asst-send { display: grid; place-items: center; width: var(--cap-h); padding: 0; background: var(--asst-text); box-shadow: none; color: var(--asst-ink); }
    .asst-send > svg { width: 15px; height: 15px; stroke-width: 2.4; }
    .asst-send:hover:not(:disabled) { background: #fff; }
    .asst-send[data-state="empty"] { background: var(--asst-fill-1); box-shadow: inset 0 0 0 1px var(--asst-line); color: var(--asst-text-3); cursor: default; }
    /* Stop: one neutral white square with the ■ glyph in every host (red only ever means failed). */
    .asst-root .asst-send[data-state="stop"],
    .asst-root .asst-send[data-state="stop"]:hover:not(:disabled) { background: var(--asst-text); box-shadow: none; color: var(--asst-ink); }
    .asst-root .asst-send[data-state="stop"]:hover:not(:disabled) { background: #fff; }

    .asst-slash-menu {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 6px);
      z-index: 20;
      max-height: min(260px, 50cqh);
      overflow-y: auto;
      padding: 4px;
      border-radius: 10px;
      background: var(--asst-popover);
      box-shadow: var(--asst-popover-shadow), 0 0 0 1px var(--asst-popover-ring);
    }
    /* Rows sit concentric in the 10px popover (4px padding). */
    .asst-slash-item {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 2px;
      min-height: var(--asst-pill-h-md);
      padding: 5px 10px;
      border-radius: calc(var(--asst-r-card) - 4px);
      cursor: pointer;
      transition: background-color var(--asst-dur-fast) var(--asst-ease-standard);
    }
    .asst-slash-item:is(.focused, :hover) { background: var(--asst-fill-2); }
    .asst-slash-name { color: var(--asst-text); font-family: var(--asst-mono); font-size: 12px; }
    .asst-slash-desc { color: var(--asst-text-3); font-size: 11.5px; }
    .asst-slash-item:is(.focused, :hover) .asst-slash-desc { color: var(--asst-text-2); }

    /* ── Control cards: [data-kind] picks the tone pair ─────────────── */
    /* A card that waits on you: a 1px hairline in its tone (no accent bar), a still blocked
       cameo and the kind as a capsule with the ◆ glyph half. Gold never: it means live. */
    .asst-control {
      --tone: var(--asst-warn);
      --tone-line: color-mix(in srgb, var(--tone) 30%, transparent);
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
      padding: 12px 14px;
      border: 1px solid var(--tone-line);
      border-radius: var(--asst-r-card);
      background: transparent;
      font-size: 13px;
    }
    .asst-control[data-kind="permission"] { --tone: var(--asst-warn); }
    .asst-control[data-kind="computer"] { --tone: var(--asst-warn); }
    .asst-control:is([data-kind="question"], [data-kind="elicitation"]) { --tone: var(--asst-info); }
    .asst-control:is([data-kind="plan"], [data-kind="route"], [data-kind="clarify"]) { --tone: var(--asst-text-2); --tone-line: var(--asst-line-2); }
    .asst-control.resolved { --tone: var(--asst-text-3); --tone-line: var(--asst-line); opacity: .8; }
    .asst-control-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .asst-control-face { display: inline-flex; flex-shrink: 0; color: var(--asst-text-2); line-height: 0; }
    .asst-control-face svg { display: block; width: 28px; height: 14px; }
    .asst-control-kind {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      height: var(--asst-pill-h-sm);
      padding: 0 var(--asst-pill-px-sm) 0 0;
      border-radius: var(--asst-pill-r-sm);
      background: var(--asst-fill-1);
      box-shadow: inset 0 0 0 1px var(--tone-line);
      color: var(--asst-text);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .asst-control-kind::before {
      content: '◆' / '';
      align-self: stretch;
      display: inline-flex;
      align-items: center;
      padding: 0 6px 0 8px;
      box-shadow: inset -1px 0 0 var(--tone-line);
      color: var(--tone);
      font-size: 9px;
    }
    .asst-control.resolved .asst-control-kind::before { content: '✓' / ''; font-size: 10px; }
    /* Where a relayed card came from: an xs capsule, the provider glyph · seam · run id. */
    .asst-control-origin { display: inline-flex; align-items: center; gap: 4px; height: var(--asst-pill-h-xs); padding: 0 var(--asst-pill-px-xs) 0 0; border-radius: var(--asst-pill-r-xs); background: var(--asst-fill-1); box-shadow: inset 0 0 0 1px var(--asst-line); color: var(--asst-text-2); font-size: 10.5px; font-weight: 500; }
    .asst-control-origin > .asst-icon { align-self: stretch; padding: 0 3px 0 5px; box-shadow: inset -1px 0 0 var(--asst-line); }
    .asst-control-origin svg { width: 10px; height: 10px; }
    .asst-control-status { margin-left: auto; color: var(--asst-text-2); font-size: 11.5px; font-weight: 500; }
    .asst-control-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .asst-control-tool { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
    .asst-control-tool-name { color: var(--asst-text); font-family: var(--asst-mono); font-size: 12px; }
    .asst-control-tool-note { color: var(--asst-text-2); }
    .asst-control-preview-label, .asst-control-desc { margin-bottom: 4px; color: var(--asst-text-3); font-size: 11.5px; }
    :is(.asst-control-cmd, .asst-control-deny-msg, .asst-control-custom) {
      width: 100%;
      padding: 7px 10px;
      border: 0;
      border-radius: var(--asst-r-field);
      outline: none;
      background: var(--asst-field);
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text);
      font: inherit;
      font-size: 12.5px;
      resize: vertical;
    }
    :is(.asst-control-cmd, .asst-control-deny-msg, .asst-control-custom):focus { box-shadow: inset 0 0 0 1px var(--asst-line-2); }
    .asst-control-cmd { font-family: var(--asst-mono); }
    .asst-control-detail {
      max-height: 200px;
      overflow: auto;
      margin: 0;
      padding: 8px 10px;
      border-radius: var(--asst-r-field);
      background: var(--asst-field);
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text-2);
      font-family: var(--asst-mono);
      font-size: 11.5px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .asst-control-kv { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
    .asst-control-kv-row { display: flex; gap: 8px; min-width: 0; }
    .asst-control-kv-key { min-width: 80px; color: var(--asst-text-3); }
    .asst-control-kv-val { min-width: 0; color: var(--asst-text-2); overflow-wrap: anywhere; }
    .asst-control-patterns { color: var(--asst-text-2); font-family: var(--asst-mono); font-size: 11.5px; }
    .asst-control-suggestions { display: flex; flex-direction: column; gap: 4px; }
    .asst-control-suggestion { display: flex; align-items: center; gap: 8px; color: var(--asst-text-2); font-size: 12.5px; cursor: pointer; }
    .asst-control-suggestion input { margin: 0; accent-color: var(--asst-text); }
    .asst-control-message { color: var(--asst-text); }
    .asst-control-q { display: flex; flex-direction: column; gap: 6px; }
    .asst-control-q + .asst-control-q { padding-top: 10px; border-top: 1px solid var(--asst-line); }
    .asst-control-q-header { color: var(--asst-text-3); font-size: 11.5px; font-weight: 500; }
    .asst-control-q-text { color: var(--asst-text); }
    .asst-control-q-hint { color: var(--asst-text-3); font-size: 11.5px; }
    .asst-control-assume { color: var(--asst-text-3); font-size: 11.5px; padding-top: 8px; border-top: 1px solid var(--asst-line); overflow-wrap: anywhere; }
    .asst-control-options { display: flex; flex-direction: column; gap: 4px; }
    .asst-control-option {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 7px 10px;
      border: 0;
      border-radius: var(--asst-r-field);
      background: transparent;
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text);
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    .asst-control-option:hover { background: var(--asst-fill-1); }
    .asst-control-option.selected { background: var(--asst-fill-2); box-shadow: inset 0 0 0 1px var(--asst-line-2), inset 2px 0 0 var(--tone); }
    .asst-control-option-desc { color: var(--asst-text-3); font-size: 11.5px; }
    .asst-control-plan-body { min-width: 0; }
    .asst-control-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

    /* Route card */
    .asst-route-summary { color: var(--asst-text); }
    .asst-route-reasons { margin-top: -4px; color: var(--asst-text-3); font-size: 11.5px; }
    .asst-route-options { display: flex; flex-direction: column; gap: 4px; }
    .asst-route-option {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      padding: 7px 10px;
      border-radius: var(--asst-r-field);
      box-shadow: inset 0 0 0 1px var(--asst-line);
      cursor: pointer;
    }
    .asst-route-option:hover { background: var(--asst-fill-1); }
    .asst-route-option.selected { background: var(--asst-fill-2); box-shadow: inset 0 0 0 1px var(--asst-line-2); }
    .asst-route-option[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
    /* The option's key: an xs square; gold once it is the pick. */
    .asst-route-num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: var(--asst-pill-h-xs);
      height: var(--asst-pill-h-xs);
      border-radius: var(--asst-pill-r-xs);
      background: var(--asst-fill-1);
      box-shadow: inset 0 0 0 1px var(--asst-line-2);
      color: var(--asst-text-2);
      font-family: var(--asst-mono);
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
      transition: background-color var(--asst-dur-fast) var(--asst-ease-standard), box-shadow var(--asst-dur-fast) var(--asst-ease-standard), color var(--asst-dur-fast) var(--asst-ease-standard);
    }
    .asst-route-option.selected .asst-route-num { background: var(--asst-pill-on-fill); box-shadow: inset 0 0 0 1px var(--asst-pill-on-ring); color: var(--asst-text); }
    .asst-route-opt-icon svg { width: 14px; height: 14px; }
    .asst-route-opt-main { display: flex; flex: 1; flex-direction: column; gap: 1px; min-width: 0; }
    .asst-route-opt-title, .asst-route-opt-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .asst-route-opt-title { color: var(--asst-text); }
    .asst-route-opt-sub { color: var(--asst-text-3); font-size: 11.5px; }
    .asst-route-opt-warn { color: var(--asst-warn); font-size: 11.5px; }
    .asst-route-badge {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      height: var(--asst-pill-h-xs);
      padding: 0 var(--asst-pill-px-xs);
      border-radius: var(--asst-pill-r-xs);
      background: var(--asst-fill-1);
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text-2);
      font-size: 10.5px;
      font-weight: 500;
      white-space: nowrap;
    }
    .asst-route-badge[data-badge="suggested"] { box-shadow: inset 0 0 0 1px var(--asst-line-2); color: var(--asst-text); }
    .asst-route-remember { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--asst-text-2); font-size: 12.5px; cursor: pointer; }
    .asst-route-remember input { margin: 0; accent-color: var(--asst-text); }
    .asst-route-remember-current { color: var(--asst-text-3); font-size: 11.5px; }
    .asst-route-error { color: var(--asst-live); font-size: 12px; }
    .asst-route-countdown { margin-left: auto; color: var(--asst-text-2); font-family: var(--asst-mono); font-size: 11px; font-variant-numeric: tabular-nums; }
    .asst-route-keys { margin-right: auto; color: var(--asst-text-3); font-size: 11px; }
    .asst-route-card.pending .asst-route-options { opacity: .7; }

    /* ── Buttons: md capsules (blue only for :focus-visible and links) ── */
    .asst-btn { color: var(--asst-text); }
    .asst-btn-secondary { background: var(--asst-fill-1); box-shadow: inset 0 0 0 1px var(--asst-line-2); color: var(--asst-text); }
    .asst-btn-primary { background: var(--asst-text); box-shadow: none; color: var(--asst-ink); }
    .asst-btn-primary:hover:not(:disabled) { background: #fff; box-shadow: none; color: var(--asst-ink); }
    /* Deny / Decline: a neutral ghost with ✕ (red only ever means failed). */
    .asst-btn-danger { background: transparent; box-shadow: inset 0 0 0 1px var(--asst-line-2); color: var(--asst-text-2); }
    .asst-btn-danger:hover:not(:disabled) { background: var(--asst-fill-1); box-shadow: inset 0 0 0 1px var(--asst-text-3); color: var(--asst-text); }
    .asst-btn-icon { display: inline-flex; margin-left: -2px; }
    .asst-btn-icon svg { width: 12px; height: 12px; }

    /* ── Focus: one ring for everything the Assistant draws ──────────────
       2px of --asst-focus, 1px out: the component, its menus and modals, the
       sidepanel chrome (.asp-*, the window buttons) and the tray pill with its
       close button. Scrollers and menu rows draw the same ring 2px inside
       (outside it would be clipped). */
    :is(.asst-root, .asst-bar, .asst-dd-menu, .asst-modal-overlay, .asst-lightbox) :is(button, a, summary, [role="radio"], [role="button"], [role="tab"], [tabindex]):focus-visible,
    .assistant-panel.sp-sidepanel :is(button, [role="button"], [tabindex]):focus-visible,
    .assistant-panel :is(.asp-header, .asp-body) :is(button, [role="button"], [tabindex]):focus-visible,
    .asp-session-pill:focus-visible,
    .asp-session-pill .term-minimized-pill-close:focus-visible,
    :is(.asst-control-cmd, .asst-control-deny-msg, .asst-control-custom):focus-visible {
      outline: 2px solid var(--asst-focus);
      outline-offset: 1px;
    }
    .asst-root .asst-transcript:focus-visible,
    .assistant-panel .asp-body .asst-transcript:focus-visible,
    .asst-root .asst-rack-receipt:focus-visible,
    .asst-dd-menu .asst-dd-item:focus-visible { outline-offset: -2px; }
    :is(.asst-root, .asst-bar, .asst-dd-menu, .asst-modal-overlay) :is(button, [tabindex]):focus:not(:focus-visible) { outline: none; }

    /* ── Menus (asst-menu.js) ───────────────────────────────────────── */
    .asst-dd-menu {
      position: fixed;
      z-index: 100030; /* above modals (100020): the routes editor opens model menus */
      display: flex;
      flex-direction: column;
      min-width: 200px;
      max-width: min(380px, calc(100vw - 16px));
      max-height: 380px;
      overflow: hidden;
      padding: 4px;
      border-radius: 10px;
      outline: none;
      background: var(--asst-popover);
      box-shadow: var(--asst-popover-shadow), 0 0 0 1px var(--asst-popover-ring);
      color: var(--asst-text);
      font-size: 12.5px;
      line-height: 1.4;
    }
    .asst-dd-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--asst-fill-3) transparent; }
    .asst-dd-list::-webkit-scrollbar { width: 8px; }
    .asst-dd-list::-webkit-scrollbar-thumb { background: var(--asst-fill-3); border: 2px solid transparent; border-radius: 8px; background-clip: padding-box; }
    .asst-dd-menu-title { flex-shrink: 0; padding: 6px 10px 4px; color: var(--asst-text-3); font-size: 11.5px; font-weight: 500; }
    .asst-dd-group { display: flex; align-items: center; gap: 6px; padding: 8px 10px 3px; color: var(--asst-text-3); font-size: 11.5px; font-weight: 500; }
    .asst-dd-group .asst-icon svg { width: 11px; height: 11px; }
    .asst-dd-group-note { margin-left: auto; color: var(--asst-text-3); font-size: 11px; font-weight: 400; }
    .asst-dd-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 30px;
      padding: 5px 10px;
      border: 0;
      border-radius: calc(var(--asst-r-card) - 4px);
      background: transparent;
      color: var(--asst-text);
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition: background-color var(--asst-dur-fast) var(--asst-ease-standard);
    }
    .asst-dd-item:is(:hover, .focused) { background: var(--asst-fill-2); }
    .asst-dd-item:is(:hover, .focused) .asst-dd-item-desc { color: var(--asst-text-2); }
    .asst-dd-item:disabled { opacity: .45; cursor: default; }
    .asst-dd-item.danger { color: var(--asst-live); }
    .asst-dd-check { display: inline-flex; flex-shrink: 0; width: 14px; color: var(--asst-text); }
    .asst-dd-check svg { width: 13px; height: 13px; }
    .asst-dd-item .asst-icon { width: 16px; color: var(--asst-text-2); }
    .asst-dd-item-main { display: flex; flex: 1; flex-direction: column; gap: 1px; min-width: 0; }
    .asst-dd-item-label, .asst-dd-item-desc { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .asst-dd-item-desc { color: var(--asst-text-3); font-size: 11px; }
    .asst-dd-item-tag { flex-shrink: 0; margin-left: auto; color: var(--asst-text-3); font-size: 11px; }
    .asst-dd-kbd { flex-shrink: 0; margin-left: auto; color: var(--asst-text-3); font-family: var(--asst-mono); font-size: 10.5px; }
    .asst-dd-sep { flex-shrink: 0; height: 1px; margin: 4px 6px; background: var(--asst-line); }
    .asst-dd-info { display: flex; align-items: center; gap: 8px; padding: 5px 10px; color: var(--asst-text-3); font-size: 11.5px; }
    .asst-dd-info-value { margin-left: auto; color: var(--asst-text-2); font-variant-numeric: tabular-nums; }
    .asst-dd-tagrow { padding: 4px 10px; }
    .asst-dd-tag { display: inline-flex; align-items: center; height: var(--asst-pill-h-xs); padding: 0 var(--asst-pill-px-xs); border-radius: var(--asst-pill-r-xs); background: var(--asst-fill-1); box-shadow: inset 0 0 0 1px var(--asst-line); color: var(--asst-text-2); font-size: 10.5px; font-weight: 500; }
    .asst-dd-input {
      display: block;
      flex-shrink: 0;
      width: 100%;
      height: 30px;
      margin: 4px 0;
      padding: 0 10px;
      border: 0;
      border-radius: calc(var(--asst-r-card) - 4px);
      outline: none;
      background: var(--asst-field);
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text);
      font: inherit;
      font-size: 12.5px;
      -webkit-appearance: none;
      appearance: none;
    }
    .asst-dd-input:focus { box-shadow: inset 0 0 0 1px var(--asst-line-2); }
    .asst-dd-input::placeholder { color: var(--asst-text-3); }
    .asst-dd-filter { margin: 2px 0 4px; }
    .asst-dd-empty { padding: 8px 10px; color: var(--asst-text-3); }

    /* ── Modals (help, accounts, model routes) ──────────────────────── */
    .asst-modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 100020;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      background: var(--asst-scrim);
    }
    .asst-modal {
      display: flex;
      flex-direction: column;
      width: min(560px, 100%);
      max-height: min(84vh, 760px);
      overflow: hidden;
      border-radius: 12px;
      background: var(--asst-popover);
      box-shadow: var(--asst-popover-shadow), 0 0 0 1px var(--asst-popover-ring);
      color: var(--asst-text);
      font-size: 13px;
    }
    .asst-modal-head { display: flex; flex-shrink: 0; align-items: center; gap: 8px; padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--asst-line); font-size: 13.5px; font-weight: 600; }
    .asst-modal-head .asst-icon { color: var(--asst-brand); }
    .asst-modal-head .asst-icon svg { width: 15px; height: 15px; }
    .asst-modal-head .asst-iconbtn { margin-left: auto; }
    .asst-modal-body { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow-y: auto; padding: 14px 16px; }
    .asst-modal-foot { display: flex; flex-shrink: 0; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--asst-line); }
    .asst-modal-spacer { flex: 1; }
    .asst-modal-note { color: var(--asst-text-3); font-size: 12px; line-height: 1.5; }
    .asst-account-list { display: flex; flex-direction: column; gap: 2px; }
    .asst-account-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: var(--asst-r-field); }
    .asst-account-row:hover { background: var(--asst-fill-1); }
    .asst-account-main { display: flex; flex: 1; flex-direction: column; min-width: 0; }
    .asst-account-label, .asst-account-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .asst-account-label { color: var(--asst-text); }
    .asst-account-sub { color: var(--asst-text-3); font-size: 11px; }
    .asst-account-row input.asst-dd-input { margin: 0; }
    .asst-login-box { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--asst-r-field); box-shadow: inset 0 0 0 1px var(--asst-line-2); }
    .asst-login-code { color: var(--asst-text); font-family: var(--asst-mono); font-size: 15px; letter-spacing: .1em; }

    .asst-routes-modal { width: min(660px, 100%); }
    .asst-budget-row { align-items: flex-start; }
    .asst-budget-desc, .asst-budget-meta { color: var(--asst-text-3); font-size: 11.5px; line-height: 1.4; }
    .asst-budget-meta { font-variant-numeric: tabular-nums; }
    .asst-budget-field-error { color: var(--asst-live); font-size: 11.5px; line-height: 1.4; }
    .asst-budget-amount { display: flex; flex-shrink: 0; align-items: center; gap: 6px; }
    .asst-budget-unit { color: var(--asst-text-3); font-size: 11px; white-space: nowrap; }
    .asst-budget-input { width: 96px; margin: 0; font-variant-numeric: tabular-nums; }
    .asst-budget-input[aria-invalid="true"] { box-shadow: inset 0 0 0 1px var(--asst-live); }
    .asst-budget-meter { position: relative; height: 6px; overflow: hidden; border-radius: 3px; background: var(--asst-line); }
    .asst-budget-meter-fill { position: absolute; inset: 0 auto 0 0; background: var(--asst-text-3); }
    .asst-budget-meter[data-tone="warn"] .asst-budget-meter-fill { background: var(--asst-warn); }
    .asst-budget-meter[data-tone="over"] .asst-budget-meter-fill { background: var(--asst-live); }
    .asst-budget-meter-warn { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--asst-warn); }
    .asst-budget-unpriced { color: var(--asst-warn); }
    .asst-budget-enforcement { margin: 0; padding-left: 18px; color: var(--asst-text-2, var(--asst-text-3)); font-size: 11.5px; line-height: 1.5; }
    .asst-budget-enforcement li + li { margin-top: 4px; }
    .asst-routes-section { display: flex; flex-direction: column; gap: 8px; }
    .asst-routes-section + .asst-routes-section { margin-top: 6px; }
    .asst-routes-section-title { color: var(--asst-text-3); font-size: 11.5px; font-weight: 500; }
    .asst-routes-modes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
    .asst-routes-mode {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 3px;
      padding: 9px 11px;
      border: 0;
      border-radius: var(--asst-r-field);
      background: transparent;
      box-shadow: inset 0 0 0 1px var(--asst-line);
      color: var(--asst-text);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .asst-routes-mode:hover { background: var(--asst-fill-1); }
    .asst-routes-mode[aria-checked="true"] { background: var(--asst-fill-2); box-shadow: inset 0 0 0 1px var(--asst-line-2), inset 2px 0 0 var(--asst-brand); }
    .asst-routes-mode-label { font-size: 12.5px; font-weight: 500; }
    .asst-routes-mode-desc { color: var(--asst-text-3); font-size: 11.5px; line-height: 1.4; }
    .asst-routes-list { display: flex; flex-direction: column; }
    .asst-routes-row { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px 2px; border-top: 1px solid var(--asst-line); }
    .asst-routes-row:first-child { border-top: 0; }
    .asst-routes-row-main { flex: 1; min-width: 0; }
    .asst-routes-row-label { color: var(--asst-text); font-size: 12.5px; }
    .asst-routes-row-desc { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--asst-text-3); font-size: 11.5px; }
    .asst-routes-row-note { color: var(--asst-warn); font-size: 11.5px; }
    .asst-routes-model { max-width: 200px; box-shadow: inset 0 0 0 1px var(--asst-line); }
    .asst-routes-source { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; min-width: 72px; height: var(--asst-pill-h-xs); padding: 0 var(--asst-pill-px-xs); border-radius: var(--asst-pill-r-xs); background: var(--asst-fill-1); box-shadow: inset 0 0 0 1px var(--asst-line); color: var(--asst-text-2); font-size: 10.5px; font-weight: 500; }
    .asst-routes-source[data-source="yours"] { color: var(--asst-text); box-shadow: inset 0 0 0 1px var(--asst-line-2); }
    .asst-routes-source[data-source="remembered"] { color: var(--asst-text); box-shadow: inset 0 0 0 1px var(--asst-line-2); }
    .asst-routes-error { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--asst-r-field); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--asst-live) 45%, transparent); color: var(--asst-text); font-size: 12.5px; }
    .asst-routes-error span { flex: 1; }
    .asst-routes-source[data-source="disabled"] { color: var(--asst-text-3); text-decoration: line-through; }
    .asst-routes-source[data-source="incapable"] { color: var(--asst-warn); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--asst-warn) 45%, transparent); }
    .asst-models-filter { width: 100%; margin: 0 0 4px; }
    .asst-models-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .asst-models-count { font-weight: 500; letter-spacing: normal; text-transform: none; }
    .asst-models-inuse { min-width: 0; height: 18px; margin-left: 4px; vertical-align: middle; font-size: 10.5px; }
    .asst-models-switch { position: relative; flex-shrink: 0; width: 30px; height: 18px; padding: 0; border: 0; border-radius: var(--asst-pill-r-xs); background: var(--asst-fill-2); box-shadow: inset 0 0 0 1px var(--asst-line-2); cursor: pointer; }
    .asst-models-switch[aria-checked="true"] { background: var(--asst-brand); box-shadow: none; }
    .asst-models-switch:disabled { opacity: .6; cursor: progress; }
    .asst-models-knob { position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; border-radius: 3px; background: var(--asst-text-3); transition: transform var(--asst-dur-fast) var(--asst-ease-standard); }
    .asst-models-switch[aria-checked="true"] .asst-models-knob { transform: translateX(12px); background: #fff; }
    .asst-models-tabs { display: flex; gap: 4px; padding: 0 16px; box-shadow: inset 0 -1px 0 var(--asst-line); }
    .asst-models-tab { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border: 0; background: transparent; color: var(--asst-text-2); font: inherit; font-size: 12.5px; cursor: pointer; box-shadow: inset 0 -2px 0 transparent; }
    .asst-models-tab:hover { color: var(--asst-text); }
    .asst-models-tab.is-active { color: var(--asst-text); box-shadow: inset 0 -2px 0 var(--asst-brand); }
    .asst-models-badge { min-width: var(--asst-pill-h-xs); height: var(--asst-pill-h-xs); padding: 0 var(--asst-pill-px-xs); border-radius: var(--asst-pill-r-xs); background: var(--asst-fill-2); color: var(--asst-text); font-family: var(--asst-mono); font-size: 10.5px; line-height: var(--asst-pill-h-xs); font-variant-numeric: tabular-nums; text-align: center; }
    .asst-models-ctx { margin-left: 6px; padding: 0 5px; border-radius: var(--asst-pill-r-xs); box-shadow: inset 0 0 0 1px var(--asst-line-2); color: var(--asst-text-2); font-size: 10.5px; vertical-align: middle; }
    .asst-routes-source[data-source="unlisted"] { color: var(--asst-text-3); }
    .asst-models-restore, .asst-models-restore-all { flex-shrink: 0; }
    .asst-models-head .asst-models-restore-all { margin-left: auto; }
    .asst-models-group { border-radius: var(--asst-r-field); box-shadow: inset 0 0 0 1px var(--asst-line); }
    .asst-models-group + .asst-models-group { margin-top: 4px; }
    .asst-models-group-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; color: var(--asst-text); font-size: 12.5px; cursor: pointer; }
    .asst-models-group-body { display: flex; flex-direction: column; gap: 2px; padding: 0 6px 6px; }
    .asst-models-group-body > .asst-models-restore-all { align-self: flex-start; margin: 2px 4px 4px; }
    @media (max-width: 600px) {
      .asst-routes-modes { grid-template-columns: 1fr; }
      .asst-routes-row { flex-wrap: wrap; }
    }

    /* ── Frame lightbox ─────────────────────────────────────────────── */
    .asst-lightbox { position: fixed; inset: 0; z-index: 100040; display: flex; align-items: center; justify-content: center; background: var(--asst-scrim-strong); }
    .asst-lightbox-figure { display: flex; flex-direction: column; align-items: center; gap: 10px; margin: 0; }
    .asst-lightbox-frame { position: relative; display: inline-block; overflow: hidden; line-height: 0; border-radius: 8px; box-shadow: var(--asst-popover-shadow), 0 0 0 1px var(--asst-popover-ring); }
    .asst-lightbox-img { display: block; width: auto; height: auto; max-width: 92vw; max-height: 86vh; }
    .asst-lightbox-caption { max-width: 92vw; color: var(--asst-text-2); font-size: 12.5px; text-align: center; }
    .asst-lightbox-close { position: absolute; top: 14px; right: 14px; background: var(--asst-popover); box-shadow: 0 0 0 1px var(--asst-popover-ring); color: var(--asst-text); }

    /* ── Float header brain chip (lives in ui-terminal's float window) ─ */
    .term-float-brain-chip {
      display: inline-flex;
      align-items: center;
      flex-shrink: 1;
      min-width: 0;
      max-width: 200px;
      height: 18px;
      margin-left: 4px;
      padding: 0 8px;
      border: 0;
      border-radius: var(--asst-pill-r-xs);
      background: transparent;
      box-shadow: inset 0 0 0 1px var(--asst-line-2);
      color: var(--asst-text-2);
      font-size: 10.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── Empty state character (shared/synabun-mascot.js, the onboarding eyes) ──
       The rig moves by itself (idle, blinks, the cursor); nothing floats it.
       A send hands it over to the "Thinking" row at once; with no such row it
       fades out where it stood (.asst-hero-dock, positioned by asst-render.js). */
    .asst-empty-mascot { display: flex; justify-content: center; margin-bottom: 2px; color: var(--asst-text); pointer-events: none; user-select: none; }
    :is(.asst-empty-mascot, .asst-hero-dock) svg { display: block; }
    .asst-hero-dock { position: absolute; z-index: 4; display: flex; align-items: center; justify-content: center; color: var(--asst-text); pointer-events: none; user-select: none; }

    /* ── System notices ─────────────────────────────────────────────── */
    .asst-status { white-space: pre-wrap; overflow-wrap: anywhere; }
    .asst-status.warn { color: var(--asst-warn); }
    .asst-msg.asst-msg-error .asst-msg-content { padding: 6px 10px; border-radius: var(--asst-r-field); box-shadow: inset 2px 0 0 var(--asst-live), inset 0 0 0 1px color-mix(in srgb, var(--asst-live) 28%, transparent); }
    .asst-local-output { padding-left: 12px; border-left: 2px solid var(--asst-line-2); }
    .asst-local-output .asst-md { color: var(--asst-text-2); font-size: 13px; }

    /* The panel's one status line for screen readers (the transcript is not a live region). */
    .asst-announce { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }

    /* ── Keybind icon in the keybinds modal ─────────────────────────── */
    .kb-cli-assistant { color: var(--accent-gold); }

    /* ── Narrow / short containers (the tab or float window) ──────────
       Toolbar priority, highest first: route mode · Computer · project ·
       MCP. The composer row (attach · model · effort · permission mode ·
       account) keeps model; account hides ≤720px. A capsule that runs out of
       room drops its label half first and stays a glyph (its words remain in
       aria-label and the tooltip): route mode and Computer ≤960px, the mode
       ≤540px, every composer field but the model ≤440px. Model, history, new
       and "⋯" never hide; whatever hides stays in "⋯". A toolbar placed
       outside the root (the sidepanel header) is out of reach of these rules:
       its host sizes it (asst-sidepanel-styles.js).
       Glyph only is the same three rules everywhere (see Capsules): the
       capsule grid-centres its glyph with padding 0, the label half and the
       caret go (display: none), and the glyph half keeps --cap-glyph-pad on
       both sides without its seam, so one glyph makes a --cap-h square (the
       Computer pair a centred capsule). Route mode with route cards waiting
       keeps its glyph half and the count; only its label goes. */
    @container asst (max-width: 960px) {
      .asst-bar :is(.asst-route-chip:not([data-waiting]), .asst-computer-toggle) { display: grid; place-content: center; place-items: center; padding: 0; }
      .asst-bar :is(.asst-route-chip:not([data-waiting]), .asst-computer-toggle) > :is(.asst-dd-label, .asst-tb-label, .asst-dd-caret) { display: none; }
      .asst-bar :is(.asst-route-chip:not([data-waiting]), .asst-computer-toggle) > .asst-icon:not([hidden]) { margin: 0; padding: 0 var(--cap-glyph-pad); box-shadow: none; }
      .asst-bar .asst-route-chip[data-waiting] > .asst-dd-label { display: none; }
    }
    @container asst (max-width: 720px) {
      :is(.asst-dd-mcp, .asst-dd-account, .asst-dd-project, .asst-bar-group[data-group="context"]) { display: none !important; }
      .asst-route-keys { display: none; }
    }
    @container asst (max-width: 540px) {
      .asst-composer-brain .asst-dd.asst-dd-mode { display: grid; place-content: center; place-items: center; padding: 0; }
      .asst-composer-brain .asst-dd.asst-dd-mode > :is(.asst-dd-label, .asst-dd-caret) { display: none; }
      .asst-composer-brain .asst-dd.asst-dd-mode > .asst-icon:not([hidden]) { margin: 0; padding: 0 var(--cap-glyph-pad); box-shadow: none; }
      .asst-dd-model .asst-dd-label { max-width: 14ch; }
      .asst-route-badge { display: none; }
    }
    @container asst (max-width: 440px) {
      .asst-composer-brain .asst-dd:is(.asst-dd-effort, .asst-dd-variant, .asst-dd-mode, .asst-dd-account) { display: grid; place-content: center; place-items: center; padding: 0; }
      .asst-composer-brain .asst-dd:is(.asst-dd-effort, .asst-dd-variant, .asst-dd-mode, .asst-dd-account) > :is(.asst-dd-label, .asst-dd-caret) { display: none; }
      .asst-composer-brain .asst-dd:is(.asst-dd-effort, .asst-dd-variant, .asst-dd-mode, .asst-dd-account) > .asst-icon:not([hidden]) { margin: 0; padding: 0 var(--cap-glyph-pad); box-shadow: none; }
    }
    @container asst (max-width: 400px) {
      .asst-root > * { --asst-inline: 6px; }
      :is(.asst-cost, .asst-bar-group[data-group="context"]) { display: none !important; }
      .asst-suggestions { flex-direction: column; align-items: stretch; width: 100%; }
      .asst-chip.asst-suggestion { justify-content: flex-start; max-width: none; }
      .asst-msg.msg-user .asst-msg-content { max-width: 92%; }
      .asst-dd-model .asst-dd-label { max-width: 9ch; }
      .asst-route-opt-sub { display: none; }
      .asst-run-main { flex-wrap: wrap; row-gap: 2px; }
      .asst-run-title { flex-basis: 100%; }
    }
    @container asst (max-width: 320px) {
      .asst-bar-group[data-group="computer"] { display: none !important; }
      /* The model keeps a readable name (at least 5ch): the composer row wraps instead of truncating it. */
      .asst-dd-model .asst-dd-label { min-width: 5ch; max-width: 14ch; }
      .asst-composer-actions { flex-wrap: wrap; row-gap: 6px; }
      .asst-composer-brain { flex-wrap: wrap; row-gap: 6px; }
    }
    @container asst (max-height: 260px) {
      /* the toolbar stays: it carries the controls */
      :is(.asst-empty-body, .asst-empty-mascot, .asst-suggestions) { display: none !important; }
      .asst-empty { gap: 4px; padding: 4px; }
      .asst-empty-title { font-size: 14px; }
      .asst-bottom { margin-top: 6px; }
    }

    /* ── Motion ─────────────────────────────────────────────────────────
       One pulse (asst-live) for everything live, the cameo's glance for
       everything running, the spinner for loading. Transforms and opacity
       only. They pause while the UI is dragged; under reduced motion the
       whole Assistant holds still: the component, its menus and modals, the
       sidepanel frame and its header (.asp-*), and the tray pills. */
    @keyframes asst-live { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.8); } }
    @keyframes asst-cameo { 0%, 42% { transform: translateX(-1.2px); } 50%, 92% { transform: translateX(1.2px); } 100% { transform: translateX(-1.2px); } }
    @keyframes asst-spin { to { transform: rotate(360deg); } }

    body.ui-interacting :is(.asst-live-dot, .asst-spinner, .asst-computer-dot, .syna-cameo-eye) { animation-play-state: paused !important; }

    @media (prefers-reduced-motion: reduce) {
      .asst-transcript { scroll-behavior: auto; }
      :is(.asst-root, .asst-bar, .asst-dd-menu, .asst-modal-overlay, .asst-lightbox, .assistant-panel, .term-minimized-pill) *,
      :is(.asst-root, .asst-bar, .asst-dd-menu, .asst-modal-overlay, .asst-lightbox, .assistant-panel, .term-minimized-pill) *::before,
      :is(.asst-root, .asst-bar, .asst-dd-menu, .asst-modal-overlay, .asst-lightbox, .assistant-panel, .term-minimized-pill) *::after,
      .term-minimized-pill,
      .term-minimized-pill::before,
      .term-minimized-pill::after { animation: none !important; transition: none !important; }
    }
  `;
  document.head.appendChild(style);
}
