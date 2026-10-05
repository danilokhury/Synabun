// SynaBun — Codex Panel: Styles

export function injectStyles() {
  if (document.getElementById('codex-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'codex-panel-styles';
  style.textContent = `
    /* ── Visual language ─────────────────────────────────────────────
       Every colour, radius, type size and duration below comes from these
       tokens (docs/codex-sidepanel.md → Visual language). Add a value here
       before using it anywhere else. The lightbox, the minimized pill and
       the Context settings popover live outside the panel, so they carry the
       tokens too. */
    .codex-panel,
    .cxp-lightbox,
    .cxp-session-pill,
    .cxp-ctxpop {
      /* Surfaces: one treatment per level */
      --cxp-shell: rgba(16, 18, 22, 0.92);
      --cxp-shell-border: rgba(255,255,255,0.08);
      --cxp-pop: rgb(22, 22, 26);
      --cxp-surface-1: rgba(255,255,255,0.04);
      --cxp-surface-2: rgba(255,255,255,0.08);
      --cxp-surface-3: rgba(255,255,255,0.14);
      --cxp-scrim: rgba(0,0,0,0.55);
      /* Borders: hairline, control edge, input edge (3:1) */
      --cxp-border: rgba(255,255,255,0.10);
      --cxp-border-strong: rgba(255,255,255,0.22);
      --cxp-border-input: rgba(255,255,255,0.36);
      /* Text levels */
      --cxp-text: rgba(255,255,255,0.9);
      --cxp-text-2: rgba(255,255,255,0.7);
      --cxp-text-3: rgba(255,255,255,0.5);
      --cxp-text-off: rgba(255,255,255,0.3);
      --cxp-solid: #ededed;
      --cxp-solid-hover: #ffffff;
      --cxp-on-solid: #171717;
      /* Colour carries meaning only */
      --cxp-running: #0ea5e9;
      --cxp-success: #22c55e;
      --cxp-warning: #f59e0b;
      --cxp-danger: #ef4444;
      /* Context pressure (the cog's dot, the popover's bar): the sibling panels' two values */
      --cxp-pressure-high: #d4a848;
      --cxp-pressure-critical: #ef7070;
      --cxp-link: #9dc3ff;
      --cxp-focus: rgba(255,255,255,0.7);
      --cxp-synabun: #73d5a7;
      --cxp-brand: #10a37f;
      /* Shape */
      --cxp-radius-sm: 4px;
      --cxp-radius-md: 8px;
      --cxp-radius-lg: 12px;
      --cxp-radius-pill: 999px;
      --cxp-radius-shell: 16px;
      /* Space */
      --cxp-space-1: 4px;
      --cxp-space-2: 8px;
      --cxp-space-3: 12px;
      --cxp-space-4: 16px;
      --cxp-space-5: 24px;
      /* Type */
      --cxp-font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --cxp-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
      --cxp-fs-xs: 10px;
      --cxp-fs-sm: 11px;
      --cxp-fs-md: 12px;
      --cxp-fs-lg: 13px;
      --cxp-lh-tight: 1.35;
      --cxp-lh: 1.6;
      /* Motion */
      --cxp-dur-fast: 150ms;
      --cxp-dur: 250ms;
      --cxp-ease: cubic-bezier(0.2, 0, 0, 1);
      /* Elevation: floating layers only */
      --cxp-shadow-pop: 0 12px 32px rgba(0,0,0,0.4);
    }
    /* Include modal/search/settings fields as well as transcript inputs. */
    .codex-panel input::placeholder,
    .codex-panel textarea::placeholder {
      color: var(--cxp-text-2);
      opacity: 1;
    }
    /* The one working indicator: a slow opacity pulse. */
    @keyframes cxp-working {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 1; }
    }
    @keyframes cxp-fade-in { from { opacity: 0; } to { opacity: 1; } }

    /* ── Shell (kept in step with the sibling side panels) ── */
    .codex-panel {
      position: fixed;
      top: calc(var(--navbar-height, 48px) + 20px);
      right: 20px;
      width: 22%;
      min-width: 320px;
      max-width: 700px;
      bottom: 20px;
      z-index: 205;
      display: flex;
      flex-direction: column;
      background: var(--cxp-shell);
      backdrop-filter: blur(28px) saturate(1.45);
      -webkit-backdrop-filter: blur(28px) saturate(1.45);
      border: 0.5px solid var(--cxp-shell-border);
      border-radius: var(--cxp-radius-shell);
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.3),
        0 1px 2px rgba(0,0,0,0.15),
        0 4px 8px rgba(0,0,0,0.12),
        0 12px 24px rgba(0,0,0,0.14),
        0 32px 64px rgba(0,0,0,0.18);
      overflow: hidden;
      transform: translateX(calc(100% + 20px));
      opacity: 0;
      transition: transform var(--cxp-dur) var(--cxp-ease), opacity var(--cxp-dur) ease;
      font-family: var(--cxp-font);
      color: var(--cxp-text);
    }
    .codex-panel.open {
      transform: translateX(0);
      opacity: 1;
      overflow: visible;
    }
    /* A floating terminal is promoted above the panel when focused. Raise the
       whole stacking context while a footer menu is open so it stays visible. */
    .codex-panel:has(.cxp-dropdown.open) {
      z-index: 99999;
    }
    /* Keyboard focus: one neutral ring on every focusable element. */
    .codex-panel :is(a, button, input, select, textarea, summary, [tabindex]):focus-visible,
    .cxp-session-pill:focus-visible {
      outline: 2px solid var(--cxp-focus);
      outline-offset: 2px;
    }
    /* Inside clipping containers the ring sits on the element instead of around it. */
    .codex-panel :is(.cxp-fold-summary, .cxp-reasoning summary, .cxp-effort-menu-item, .cxp-account-row-main, .cxp-account-row-remove, .cxp-image-chip-remove, .cxp-sess-rename, .cxp-sess-archive-btn, .cxp-sess-unarchive-btn, .cxp-sess-search-input, .cxp-session-btn, .cxp-header-rename):focus-visible {
      outline-offset: -2px;
    }
    .cxp-resize-handle {
      position: absolute;
      top: 14px;
      left: 0;
      width: 6px;
      height: calc(100% - 28px);
      cursor: col-resize;
      z-index: 10;
      border-radius: 0 var(--cxp-radius-sm) var(--cxp-radius-sm) 0;
      transition: background var(--cxp-dur-fast) ease;
    }
    .cxp-resize-handle:hover,
    .cxp-resize-handle:active {
      background: var(--cxp-surface-2);
    }

    /* ── Header ── */
    .cxp-header {
      position: relative;
      padding: 10px 10px 10px 14px;
      border-bottom: none;
      border-radius: var(--cxp-radius-lg);
      margin: 8px 8px 0 8px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      background: var(--cxp-surface-1);
      z-index: 3;
    }
    .cxp-session-btn {
      background: var(--cxp-surface-1);
      border: none;
      display: flex;
      align-items: center;
      gap: 5px;
      color: var(--cxp-text-2);
      font-size: var(--cxp-fs-sm);
      font-family: var(--cxp-font);
      cursor: pointer;
      padding: 5px 10px;
      border-radius: var(--cxp-radius-md) 0 0 var(--cxp-radius-md);
      transition: background var(--cxp-dur-fast), color var(--cxp-dur-fast);
      max-width: 100%;
      overflow: hidden;
      flex-shrink: 1;
      min-width: 0;
    }
    .cxp-session-btn:hover {
      background: var(--cxp-surface-2);
      color: var(--cxp-text);
    }
    .cxp-session-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
      text-align: left;
    }
    .cxp-session-label .cxp-rename-input {
      width: 100%;
    }
    .cxp-dd-arrow {
      font-size: var(--cxp-fs-xs);
      color: var(--cxp-text-3);
      flex-shrink: 0;
      pointer-events: none;
      transition: transform var(--cxp-dur-fast), color var(--cxp-dur-fast);
    }
    .cxp-session-btn .cxp-dd-arrow {
      padding: 4px 6px;
      margin: -4px -6px -4px 0;
      border-radius: 0 var(--cxp-radius-md) var(--cxp-radius-md) 0;
    }
    .cxp-session-btn:hover .cxp-dd-arrow {
      color: var(--cxp-text-2);
    }
    .cxp-header-rename {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      align-self: stretch;
      border-radius: 0 var(--cxp-radius-md) var(--cxp-radius-md) 0;
      border: none;
      border-left: 1px solid var(--cxp-border);
      background: var(--cxp-surface-1);
      color: var(--cxp-text-3);
      cursor: pointer;
      transition: background var(--cxp-dur-fast), color var(--cxp-dur-fast);
      flex-shrink: 0;
    }
    .cxp-header-rename:hover:not(:disabled) {
      color: var(--cxp-text);
      background: var(--cxp-surface-2);
    }
    .cxp-header-rename:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .cxp-header-rename svg {
      width: 12px;
      height: 12px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .cxp-actions {
      display: flex;
      align-items: center;
      gap: 3px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .cxp-btn {
      width: 24px;
      height: 24px;
      border: none;
      border-radius: var(--cxp-radius-md);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--cxp-surface-1);
      color: var(--cxp-text-3);
      font-family: var(--cxp-font);
      cursor: pointer;
      transition: background var(--cxp-dur-fast), color var(--cxp-dur-fast);
    }
    .cxp-btn:hover:not(:disabled) {
      background: var(--cxp-surface-2);
      color: var(--cxp-text);
    }
    .cxp-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .cxp-btn svg {
      width: 12px;
      height: 12px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .cxp-btn-danger:hover:not(:disabled) {
      color: var(--cxp-danger);
    }
    .cxp-toolbar-sep {
      width: 1px;
      height: 18px;
      background: var(--cxp-border);
      margin: 0 2px;
      flex-shrink: 0;
    }

    /* ── Footer toggles: flat labels, an underline when on ── */
    .cxp-toolbar-toggle {
      background: transparent; border: none;
      color: var(--cxp-text-3); cursor: pointer;
      font-size: var(--cxp-fs-xs); font-family: var(--cxp-font); font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.3px;
      padding: 4px 6px 6px;
      transition: color var(--cxp-dur-fast);
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 3px;
      position: relative;
    }
    .cxp-toolbar-toggle::after {
      content: '';
      position: absolute; bottom: 0; left: 25%; right: 25%;
      height: 1.5px;
      background: var(--cxp-text-3);
      transform: scaleX(0);
      transition: transform var(--cxp-dur) var(--cxp-ease), background var(--cxp-dur-fast);
    }
    .cxp-toolbar-toggle:hover { color: var(--cxp-text-2); }
    .cxp-toolbar-toggle:hover::after { transform: scaleX(1); }
    .cxp-btn-label {
      font-size: var(--cxp-fs-xs);
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    /* ── Effort toggle: level reads from the dots and the underline length ── */
    .cxp-effort-dots {
      display: flex; gap: 2px; align-items: center; margin-left: 2px;
    }
    .cxp-effort-dots i {
      display: block; width: 3px; height: 3px; border-radius: 50%;
      background: currentColor; opacity: 0.25; font-style: normal;
      transition: opacity var(--cxp-dur);
    }
    .cxp-effort-dots i.lit { opacity: 1; }
    .cxp-toolbar-toggle[data-effort="off"] .cxp-effort-dots { display: none; }
    .cxp-effort-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }
    .cxp-effort-menu {
      display: none;
      position: absolute;
      right: 0;
      bottom: calc(100% + 8px);
      width: 220px;
      max-height: 300px;
      overflow-y: auto;
      padding: 5px;
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-md);
      background: var(--cxp-pop);
      box-shadow: var(--cxp-shadow-pop);
      z-index: 45;
    }
    .cxp-effort-menu.open { display: block; }
    .cxp-effort-menu-item {
      width: 100%;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      padding: 7px 8px;
      border: 0;
      border-radius: var(--cxp-radius-sm);
      background: transparent;
      color: var(--cxp-text-2);
      font-family: var(--cxp-font);
      text-align: left;
      cursor: pointer;
    }
    .cxp-effort-menu-item:hover { background: var(--cxp-surface-1); }
    .cxp-effort-menu-item.selected {
      background: var(--cxp-surface-2);
      color: var(--cxp-text);
    }
    .cxp-effort-menu-label { font-size: var(--cxp-fs-sm); font-weight: 600; }
    .cxp-effort-menu-desc {
      min-width: 0;
      font-size: var(--cxp-fs-xs);
      color: var(--cxp-text-3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #cxp-effort-toggle[data-effort="minimal"]::after { transform: scaleX(0.25); }
    #cxp-effort-toggle[data-effort="low"]::after { transform: scaleX(0.4); }
    #cxp-effort-toggle[data-effort="medium"] { color: var(--cxp-text-2); }
    #cxp-effort-toggle[data-effort="medium"]::after { transform: scaleX(0.6); }
    #cxp-effort-toggle[data-effort="high"] { color: var(--cxp-text-2); }
    #cxp-effort-toggle[data-effort="high"]::after { transform: scaleX(0.8); }
    #cxp-effort-toggle[data-effort="xhigh"],
    #cxp-effort-toggle[data-effort="max"],
    #cxp-effort-toggle[data-effort="ultra"] { color: var(--cxp-text); }
    #cxp-effort-toggle[data-effort="xhigh"]::after,
    #cxp-effort-toggle[data-effort="max"]::after,
    #cxp-effort-toggle[data-effort="ultra"]::after { transform: scaleX(1); background: var(--cxp-text-2); }

    /* ── Plan, Auto and extended context: on is bright text plus the underline ── */
    #cxp-plan-toggle.active,
    #cxp-autoaccept-toggle.active,
    #cxp-context-toggle.active { color: var(--cxp-text); }
    #cxp-plan-toggle.active::after,
    #cxp-autoaccept-toggle.active::after,
    #cxp-context-toggle.active::after { transform: scaleX(1); background: var(--cxp-text); }
    #cxp-context-toggle[data-context-status="mismatch"] { color: var(--cxp-warning); }
    #cxp-context-toggle[data-context-status="mismatch"]::after { transform: scaleX(1); background: var(--cxp-warning); }
    #cxp-context-toggle:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    #cxp-context-toggle:disabled::after { transform: scaleX(0); }
    #cxp-context-retry[hidden] { display: none; }
    #cxp-context-retry { color: var(--cxp-text); }
    .cxp-model-catalog-status { padding: 8px 12px; font-size: var(--cxp-fs-sm); color: var(--cxp-text-3); }

    /* ── Session menu ── */
    .cxp-session-menu {
      display: none;
      position: absolute;
      top: calc(100% + 2px);
      left: 8px;
      right: 8px;
      background: var(--cxp-pop);
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-md);
      padding: 4px;
      z-index: 310;
      max-height: 360px;
      overflow-y: auto;
      box-shadow: var(--cxp-shadow-pop);
      scrollbar-width: thin;
      scrollbar-color: var(--cxp-border-strong) transparent;
    }
    .cxp-session-menu.open {
      display: block;
    }
    .cxp-session-menu::-webkit-scrollbar {
      width: 3px;
    }
    .cxp-session-menu::-webkit-scrollbar-thumb {
      background: var(--cxp-border-strong);
      border-radius: var(--cxp-radius-sm);
    }
    .cxp-sess-loading,
    .cxp-sess-empty {
      padding: 12px 8px;
      text-align: center;
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-3);
    }
    .cxp-sess-group {
      font-size: var(--cxp-fs-xs);
      font-weight: 600;
      color: var(--cxp-text-3);
      letter-spacing: 0.5px;
      text-transform: uppercase;
      padding: 6px 8px 2px;
    }
    .cxp-sess-group:first-child {
      padding-top: 4px;
    }
    .cxp-sess-new,
    .cxp-sess-item {
      cursor: pointer;
      transition: background var(--cxp-dur-fast), color var(--cxp-dur-fast);
    }
    .cxp-sess-new {
      padding: 5px 8px;
      border-radius: var(--cxp-radius-sm);
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-2);
      border-bottom: 1px solid var(--cxp-border);
      margin-bottom: 2px;
    }
    .cxp-sess-new:hover {
      background: var(--cxp-surface-1);
      color: var(--cxp-text);
    }
    .cxp-sess-item {
      position: relative;
      padding: 5px 46px 5px 8px;
      border-radius: var(--cxp-radius-sm);
    }
    .cxp-sess-item:hover {
      background: var(--cxp-surface-1);
    }
    .cxp-sess-item.active {
      background: var(--cxp-surface-2);
    }
    .cxp-sess-prompt {
      padding-right: 22px;
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-2);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.4;
    }
    .cxp-sess-item:hover .cxp-sess-prompt,
    .cxp-sess-item.active .cxp-sess-prompt {
      color: var(--cxp-text);
    }
    .cxp-sess-meta {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: var(--cxp-fs-xs);
      color: var(--cxp-text-3);
      margin-top: 1px;
      padding-right: 8px;
    }
    .cxp-sess-source {
      color: var(--cxp-text-3);
    }
    .cxp-sess-actions-inline {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      gap: 2px;
      z-index: 2;
    }
    .cxp-sess-rename {
      display: none;
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 4px;
      color: var(--cxp-text-3);
      font-size: var(--cxp-fs-xs);
      transition: color var(--cxp-dur-fast);
    }
    .cxp-sess-item:hover .cxp-sess-rename,
    .cxp-sess-item:focus-within .cxp-sess-rename {
      display: block;
    }
    .cxp-sess-rename:hover {
      color: var(--cxp-text);
    }
    .cxp-sess-rename svg {
      width: 10px;
      height: 10px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .cxp-rename-input {
      background: var(--cxp-surface-2);
      border: 1px solid var(--cxp-border-input);
      border-radius: var(--cxp-radius-sm);
      color: var(--cxp-text);
      font-size: var(--cxp-fs-sm);
      font-family: var(--cxp-font);
      padding: 2px 6px;
      width: 100%;
    }
    .cxp-dna-btn {
      background: var(--cxp-surface-1);
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-sm);
      color: var(--cxp-text-3);
      font-size: var(--cxp-fs-xs);
      font-family: var(--cxp-font);
      padding: 2px 6px;
      margin-left: 6px;
      cursor: pointer;
      white-space: nowrap;
      transition: color var(--cxp-dur-fast), background var(--cxp-dur-fast), border-color var(--cxp-dur-fast);
    }
    .cxp-dna-btn:hover {
      color: var(--cxp-text);
      background: var(--cxp-surface-2);
      border-color: var(--cxp-border-strong);
    }

    /* ── Name-session modal ── */
    .cxp-name-modal-overlay {
      position: absolute; inset: 0;
      background: var(--cxp-scrim);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      z-index: 300; border-radius: var(--cxp-radius-shell);
      animation: cxp-fade-in var(--cxp-dur-fast) ease-out;
    }
    .cxp-name-modal {
      background: var(--cxp-pop);
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-lg); padding: 18px 18px 14px;
      width: calc(100% - 48px); max-width: 380px;
      box-shadow: var(--cxp-shadow-pop);
      display: flex; flex-direction: column; gap: 12px;
    }
    .cxp-name-modal-row {
      display: flex; flex-direction: column; gap: 4px;
    }
    .cxp-name-modal-label {
      font-size: var(--cxp-fs-xs); font-weight: 600;
      color: var(--cxp-text-3);
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .cxp-name-modal-select,
    .cxp-name-modal-input {
      background: var(--cxp-surface-1);
      border: 1px solid var(--cxp-border-input);
      border-radius: var(--cxp-radius-sm); padding: 8px 10px;
      color: var(--cxp-text);
      font: inherit; font-size: var(--cxp-fs-md);
      font-family: var(--cxp-font);
    }
    .cxp-name-modal-select {
      appearance: none; -webkit-appearance: none;
    }
    .cxp-name-modal-select:focus,
    .cxp-name-modal-input:focus {
      background: var(--cxp-surface-2);
    }
    .cxp-name-modal-select:disabled {
      opacity: 0.5; cursor: not-allowed;
    }
    .cxp-name-modal-title {
      color: var(--cxp-text); font-size: var(--cxp-fs-lg); font-weight: 600;
    }
    .cxp-name-modal-actions {
      display: flex; justify-content: flex-end; gap: 8px;
    }
    .cxp-name-modal-btn {
      padding: 6px 14px; border-radius: var(--cxp-radius-md);
      font: inherit; font-size: var(--cxp-fs-md); font-weight: 600;
      font-family: var(--cxp-font);
      cursor: pointer;
      transition: background var(--cxp-dur-fast), color var(--cxp-dur-fast), border-color var(--cxp-dur-fast);
      border: 1px solid transparent;
    }
    .cxp-name-modal-btn.skip {
      background: transparent;
      color: var(--cxp-text-2);
      border-color: var(--cxp-border-strong);
    }
    .cxp-name-modal-btn.skip:hover {
      color: var(--cxp-text);
      background: var(--cxp-surface-1);
    }
    .cxp-name-modal-btn.save {
      background: var(--cxp-solid);
      color: var(--cxp-on-solid);
    }
    .cxp-name-modal-btn.save:hover {
      background: var(--cxp-solid-hover);
    }

    /* ── Session menu search and filters ── */
    .cxp-sess-search {
      position: sticky; top: 0; z-index: 2;
      background: var(--cxp-pop);
      padding: 6px 6px 0; display: flex; flex-direction: column; gap: 4px;
    }
    .cxp-sess-search-row {
      display: flex; align-items: center; gap: 4px;
    }
    .cxp-sess-search-input {
      flex: 1; background: var(--cxp-surface-1); border: 1px solid var(--cxp-border-input);
      border-radius: var(--cxp-radius-sm); color: var(--cxp-text); font-size: var(--cxp-fs-sm);
      font-family: var(--cxp-font); padding: 5px 8px 5px 26px;
    }
    .cxp-sess-search-input::placeholder { color: var(--cxp-text-3); }
    .cxp-sess-search-icon {
      position: absolute; left: 8px; top: 50%; transform: translateY(-50%);
      width: 12px; height: 12px; color: var(--cxp-text-3); pointer-events: none;
    }
    .cxp-sess-search-wrap { position: relative; flex: 1; display: flex; align-items: center; }
    .cxp-sess-refresh-btn {
      background: none; border: none; cursor: pointer; padding: 4px;
      color: var(--cxp-text-3); transition: color var(--cxp-dur-fast);
      display: flex; align-items: center; justify-content: center;
    }
    .cxp-sess-refresh-btn:hover { color: var(--cxp-text); }
    .cxp-sess-refresh-btn.spinning { animation: cxp-sess-spin 0.6s linear; }
    @keyframes cxp-sess-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .cxp-sess-filters {
      display: flex; align-items: center; gap: 4px; padding: 0 2px 4px;
      flex-wrap: wrap;
    }
    .cxp-sess-filter-pill {
      background: transparent; border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-sm); color: var(--cxp-text-3); font-size: var(--cxp-fs-xs);
      font-family: var(--cxp-font); padding: 2px 6px;
      cursor: pointer; transition: color var(--cxp-dur-fast), background var(--cxp-dur-fast), border-color var(--cxp-dur-fast); user-select: none;
      white-space: nowrap;
    }
    .cxp-sess-filter-pill:hover { color: var(--cxp-text-2); border-color: var(--cxp-border-strong); }
    .cxp-sess-filter-pill.active {
      background: var(--cxp-surface-2); border-color: var(--cxp-border-strong);
      color: var(--cxp-text);
    }
    .cxp-sess-archive-btn,
    .cxp-sess-unarchive-btn {
      display: none;
      background: none; border: none; cursor: pointer; padding: 2px 4px;
      color: var(--cxp-text-3); font-size: var(--cxp-fs-xs); transition: color var(--cxp-dur-fast);
    }
    .cxp-sess-item:hover .cxp-sess-archive-btn,
    .cxp-sess-item:focus-within .cxp-sess-archive-btn { display: block; }
    .cxp-sess-archive-btn:hover,
    .cxp-sess-unarchive-btn:hover { color: var(--cxp-text); }
    .cxp-sess-item--archived .cxp-sess-prompt { font-style: italic; color: var(--cxp-text-3); }
    .cxp-sess-item--archived:hover .cxp-sess-unarchive-btn,
    .cxp-sess-item--archived:focus-within .cxp-sess-unarchive-btn { display: block; }
    .cxp-sess-sentinel {
      display: flex; align-items: center; justify-content: center;
      padding: 8px; min-height: 24px;
    }
    .cxp-sess-sentinel-spinner {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--cxp-text-3);
      animation: cxp-working 1.6s ease-in-out infinite;
    }
    .cxp-sess-no-more {
      font-size: var(--cxp-fs-xs); color: var(--cxp-text-3);
      text-align: center; padding: 6px;
    }

    /* ── Project bar and dropdowns ── */
    .cxp-projectbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px 0;
      flex-shrink: 0;
    }
    .cxp-dropdown {
      position: relative;
      display: flex;
      align-items: center;
      gap: 2px;
      background: transparent;
      border: none;
      border-radius: var(--cxp-radius-sm);
      padding: 3px 5px;
      cursor: pointer;
      user-select: none;
      max-width: 180px;
      flex-shrink: 1;
      min-width: 0;
      transition: background var(--cxp-dur-fast);
    }
    .cxp-dropdown-sm { max-width: 72px; }
    #cxp-profile { max-width: 80px; }
    .cxp-dropdown:hover {
      background: var(--cxp-surface-1);
    }
    .cxp-dropdown.open {
      background: var(--cxp-surface-2);
      z-index: 20;
    }
    .cxp-dropdown.has-value .cxp-dd-label {
      color: var(--cxp-text-2);
    }
    .cxp-dd-label {
      font-size: var(--cxp-fs-xs);
      font-family: var(--cxp-font);
      color: var(--cxp-text-3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .cxp-dropdown:hover .cxp-dd-arrow {
      color: var(--cxp-text-2);
    }
    .cxp-dropdown.open .cxp-dd-arrow {
      transform: rotate(180deg);
      color: var(--cxp-text-2);
    }
    .cxp-dd-menu {
      display: none;
      position: absolute;
      bottom: calc(100% + 4px);
      left: auto; right: 0;
      min-width: 200px;
      max-width: 320px;
      max-height: 260px;
      overflow-y: auto;
      overflow-x: hidden;
      background: var(--cxp-pop);
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-md);
      padding: 4px;
      z-index: 300;
      box-shadow: var(--cxp-shadow-pop);
    }
    .cxp-dropdown.open .cxp-dd-menu {
      display: block;
    }
    .cxp-dd-item {
      padding: 6px 10px;
      font-size: var(--cxp-fs-sm);
      font-family: var(--cxp-font);
      color: var(--cxp-text-2);
      border-radius: var(--cxp-radius-sm);
      cursor: pointer;
      overflow: hidden;
      display: flex;
      align-items: center;
      transition: background var(--cxp-dur-fast);
    }
    .cxp-dd-item:hover {
      background: var(--cxp-surface-1);
    }
    .cxp-dd-item.selected {
      color: var(--cxp-text);
      background: var(--cxp-surface-2);
    }
    .cxp-dropdown--busy { opacity: 0.55; pointer-events: none; }
    .cxp-model-item { min-width: 230px; }
    .cxp-model-item-copy {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .cxp-model-item-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-model-item-desc {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--cxp-fs-xs);
      color: var(--cxp-text-3);
    }

    /* ── Account menu (under the header; opened from the Context settings popover) ── */
    .cxp-account-menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 8px;
      min-width: 230px;
      max-width: 300px;
      background: var(--cxp-pop);
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-md);
      box-shadow: var(--cxp-shadow-pop);
      padding: 6px;
      z-index: 50;
      display: none;
      flex-direction: column;
      gap: 2px;
    }
    .cxp-account-menu.open { display: flex; }
    .cxp-account-empty {
      padding: 8px 10px;
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-3);
    }
    .cxp-account-row {
      display: flex;
      align-items: stretch;
      gap: 2px;
      border-radius: var(--cxp-radius-sm);
      overflow: hidden;
    }
    .cxp-account-row.active { background: var(--cxp-surface-2); }
    .cxp-account-row-main {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
      padding: 7px 9px;
      background: transparent;
      border: none;
      cursor: pointer;
      text-align: left;
      font-family: var(--cxp-font);
      color: var(--cxp-text);
    }
    .cxp-account-row-main:hover { background: var(--cxp-surface-1); }
    .cxp-account-check {
      width: 12px;
      flex-shrink: 0;
      color: var(--cxp-text);
      font-size: var(--cxp-fs-sm);
    }
    .cxp-account-row-text { display: flex; flex-direction: column; min-width: 0; }
    .cxp-account-row-label {
      font-size: var(--cxp-fs-md);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-account-row-sub {
      font-size: var(--cxp-fs-xs);
      color: var(--cxp-text-3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-account-row-remove {
      flex-shrink: 0;
      width: 26px;
      background: transparent;
      border: none;
      color: var(--cxp-text-3);
      cursor: pointer;
      font-size: var(--cxp-fs-sm);
      transition: color var(--cxp-dur-fast), background var(--cxp-dur-fast);
    }
    .cxp-account-row-remove:hover { color: var(--cxp-danger); background: var(--cxp-surface-1); }
    .cxp-account-add {
      margin-top: 4px;
      padding: 8px 10px;
      background: transparent;
      border: 1px dashed var(--cxp-border-strong);
      border-radius: var(--cxp-radius-sm);
      color: var(--cxp-text-2);
      font-size: var(--cxp-fs-sm);
      font-family: var(--cxp-font);
      cursor: pointer;
      text-align: center;
      transition: color var(--cxp-dur-fast), background var(--cxp-dur-fast);
    }
    .cxp-account-add:hover { background: var(--cxp-surface-1); color: var(--cxp-text); }

    /* ── Context settings: the header cog and its popover (cdx-context-menu.js) ──
       One grammar: a 28px head (title, at most one action) and 28px rows (label
       left, one value on the right edge). 12px around, 12px + a hairline + 12px
       between sections. The popover is a child of <body>. */
    .cxp-cog-btn { position: relative; }
    .cxp-btn.cxp-cog-btn svg { width: 14px; height: 14px; stroke-width: 1.5; }
    .cxp-cog-btn[aria-expanded="true"] { background: var(--cxp-surface-2); color: var(--cxp-text); }
    .cxp-cog-dot {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 6px;
      height: 6px;
      border-radius: var(--cxp-radius-pill);
      background: var(--cxp-pressure-high);
      pointer-events: none;
    }
    .cxp-cog-dot[hidden] { display: none; }
    .cxp-cog-dot-critical { background: var(--cxp-pressure-critical); }
    .cxp-ctxpop {
      position: fixed;
      box-sizing: border-box;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 12px;
      background: var(--cxp-pop);
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-md);
      box-shadow: var(--cxp-shadow-pop);
      font: 400 var(--cxp-fs-sm)/16px var(--cxp-font);
      font-variant-numeric: tabular-nums;
      color: var(--cxp-text);
      outline: none;
    }
    .cxp-ctxpop-section + .cxp-ctxpop-section {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--cxp-border);
    }
    .cxp-ctxpop-head,
    .cxp-ctxpop-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      height: 28px;
    }
    .cxp-ctxpop-head { margin-bottom: 4px; }
    .cxp-ctxpop-title {
      flex: 1 1 0;
      min-width: 0;
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 500 var(--cxp-fs-sm)/16px var(--cxp-font);
      color: var(--cxp-text);
    }
    .cxp-ctxpop-act { display: inline-flex; flex-shrink: 0; }
    .cxp-ctxpop-bar {
      height: 4px;
      margin: 8px 0;
      border-radius: var(--cxp-radius-sm);
      background: var(--cxp-surface-2);
      overflow: hidden;
    }
    .cxp-ctxpop-fill { height: 100%; border-radius: var(--cxp-radius-sm); background: var(--cxp-text-3); }
    .cxp-ctxpop-fill.cxp-ctxpop-high { background: var(--cxp-pressure-high); }
    .cxp-ctxpop-fill.cxp-ctxpop-critical { background: var(--cxp-pressure-critical); }
    .cxp-ctxpop-usage {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      height: 20px;
      margin-bottom: 4px;
    }
    .cxp-ctxpop-used { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cxp-ctxpop-share { flex-shrink: 0; }
    .cxp-ctxpop-k {
      flex: 0 0 auto;
      max-width: 60%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--cxp-text-2);
    }
    .cxp-ctxpop-v {
      flex: 1 1 0;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: right;
      color: var(--cxp-text);
    }
    .cxp-ctxpop-muted { color: var(--cxp-text-3); }
    .cxp-ctxpop-row-server > .cxp-ctxpop-k { flex: 1 1 0; min-width: 0; max-width: none; }
    .cxp-ctxpop-row-server > .cxp-ctxpop-v { flex: 0 0 auto; }
    .cxp-ctxpop-status { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
    .cxp-ctxpop-dot {
      flex-shrink: 0;
      width: 6px;
      height: 6px;
      border-radius: var(--cxp-radius-pill);
      background: var(--cxp-text-off);
    }
    .cxp-ctxpop-dot-ok { background: var(--cxp-success); }
    .cxp-ctxpop-dot-run { background: var(--cxp-running); }
    .cxp-ctxpop-dot-warn { background: var(--cxp-warning); }
    .cxp-ctxpop-dot-err { background: var(--cxp-danger); }
    .cxp-ctxpop-btn {
      box-sizing: border-box;
      height: 22px;
      padding: 0 10px;
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-sm);
      background: var(--cxp-surface-2);
      color: var(--cxp-text);
      font: 400 var(--cxp-fs-sm)/20px var(--cxp-font);
      cursor: pointer;
      transition: background var(--cxp-dur-fast);
    }
    .cxp-ctxpop-btn:hover:not(:disabled) { background: var(--cxp-surface-3); }
    .cxp-ctxpop-btn:disabled { opacity: 0.45; cursor: default; pointer-events: none; }
    .cxp-ctxpop-link,
    .cxp-ctxpop-copy {
      height: 20px;
      padding: 0;
      border: none;
      background: none;
      font: 400 var(--cxp-fs-sm)/20px var(--cxp-font);
      text-decoration: none;
      cursor: pointer;
    }
    .cxp-ctxpop-link { flex: 0 0 auto; color: var(--cxp-link); }
    /* A value that is a link keeps the value's width and ellipsis. */
    .cxp-ctxpop-v.cxp-ctxpop-link { flex: 1 1 0; }
    .cxp-ctxpop-link:hover:not(:disabled) { filter: brightness(1.2); }
    .cxp-ctxpop-link:disabled { color: var(--cxp-text-3); cursor: default; pointer-events: none; }
    .cxp-ctxpop-copy:hover,
    .cxp-ctxpop-copy.cxp-ctxpop-copied { color: var(--cxp-link); }
    .cxp-ctxpop button:focus-visible { outline: 2px solid var(--cxp-focus); outline-offset: 2px; }

    /* ── Transcript ──────────────────────────────────────────────────
       Levels: the transcript sits on the shell, cards get a hairline,
       blocks inside a card get a faint fill. Nothing gets both. */
    .cxp-messages-container {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      margin: 6px 8px 6px;
    }
    .cxp-messages {
      position: absolute;
      inset: 0;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 12px 0 8px;
      display: flex;
      flex-direction: column;
      gap: 0;
      scrollbar-width: thin;
      scrollbar-color: var(--cxp-border-strong) transparent;
      contain: layout style;
    }
    .cxp-messages::before {
      content: '';
      margin-top: auto;
    }
    .cxp-messages::-webkit-scrollbar {
      width: 10px;
    }
    .cxp-messages::-webkit-scrollbar-track {
      background: transparent;
    }
    .cxp-messages::-webkit-scrollbar-thumb {
      background: var(--cxp-border-strong);
      border-radius: var(--cxp-radius-sm);
      min-height: 40px;
    }
    .cxp-messages::-webkit-scrollbar-thumb:hover {
      background: var(--cxp-border-input);
    }
    .cxp-empty {
      margin: auto 0;
      min-height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 24px 18px;
      text-align: center;
      color: var(--cxp-text-3);
    }
    .cxp-empty-logo { display: flex; align-items: center; justify-content: center; color: var(--cxp-text-off); }
    .cxp-empty-logo svg { width: 32px; height: 32px; }
    .cxp-empty-name { font-size: var(--cxp-fs-lg); font-weight: 500; color: var(--cxp-text-3); }
    .cxp-empty-status { font-size: var(--cxp-fs-sm); color: var(--cxp-text-3); line-height: 1.5; min-height: 1em; }
    .cxp-cli-banner {
      flex-shrink: 0;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 10px;
      align-items: center;
      margin: 6px 8px 0;
      padding: 10px 12px;
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-md);
      box-shadow: inset 2px 0 0 var(--cxp-warning);
      color: var(--cxp-text-2);
      font-size: var(--cxp-fs-sm);
      line-height: 1.4;
      position: relative;
      z-index: 5;
    }
    .cxp-cli-banner-icon {
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%;
      border: 1px solid var(--cxp-warning);
      color: var(--cxp-warning);
      font-weight: 700;
    }
    .cxp-cli-banner-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .cxp-cli-banner-title {
      font-size: var(--cxp-fs-md); font-weight: 600;
      color: var(--cxp-text);
    }
    .cxp-cli-banner-body {
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-2);
      word-break: break-word;
    }
    .cxp-cli-banner-body code {
      padding: 1px 4px;
      background: var(--cxp-surface-2);
      border-radius: var(--cxp-radius-sm);
      font-family: var(--cxp-mono);
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text);
    }
    .cxp-cli-banner-actions { display: flex; gap: 6px; }
    .cxp-cli-banner-link, .cxp-cli-banner-recheck {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 9px;
      font-size: var(--cxp-fs-sm);
      font-weight: 500;
      border-radius: var(--cxp-radius-md);
      border: 1px solid var(--cxp-border-strong);
      background: transparent;
      color: var(--cxp-text);
      text-decoration: none;
      cursor: pointer;
      user-select: none;
      font-family: inherit;
      transition: background var(--cxp-dur-fast);
    }
    .cxp-cli-banner-link:hover, .cxp-cli-banner-recheck:hover {
      background: var(--cxp-surface-2);
    }
    .cxp-cli-banner-recheck:disabled { opacity: 0.5; cursor: default; }
    .codex-panel.cxp-cli-blocked .cxp-send { opacity: 0.4 !important; cursor: not-allowed !important; }
    .codex-panel.cxp-cli-blocked .cxp-input { opacity: 0.7; }

    /* System notices: a quiet centred line. Tone adds a mark and a colour. */
    .cxp-system {
      align-self: center;
      box-sizing: border-box;
      min-width: 0;
      max-width: calc(100% - 32px);
      margin: 4px 16px;
      padding: 4px 0;
      font-size: var(--cxp-fs-sm);
      line-height: 1.45;
      color: var(--cxp-text-3);
      text-align: center;
      flex-shrink: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .cxp-system.error { color: var(--cxp-danger); }
    .cxp-system.working { color: var(--cxp-running); }
    .cxp-system.success { color: var(--cxp-success); }
    .cxp-system.error::before { content: '\\2715'; margin-right: 6px; }
    .cxp-system.success::before { content: '\\2713'; margin-right: 6px; }
    .cxp-system.working::before {
      content: '';
      display: inline-block;
      width: 6px; height: 6px;
      margin-right: 6px;
      border-radius: 50%;
      background: currentColor;
      vertical-align: 1px;
      animation: cxp-working 1.6s ease-in-out infinite;
    }
    .cxp-mcp-startup-notice {
      align-self: stretch;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: none;
      margin: 4px 8px;
      padding: 12px;
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-md);
      box-shadow: inset 2px 0 0 currentColor;
      text-align: left;
      white-space: normal;
    }
    .cxp-system.cxp-mcp-startup-notice::before { content: none; }
    .cxp-mcp-startup-title {
      color: currentColor;
      font-size: var(--cxp-fs-md);
      font-weight: 600;
    }
    .cxp-mcp-startup-error {
      min-width: 0;
      color: var(--cxp-text-2);
      font-family: var(--cxp-mono);
      font-size: var(--cxp-fs-sm);
      line-height: 1.55;
      overflow-wrap: anywhere;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .cxp-mcp-startup-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .cxp-mcp-startup-status {
      min-width: 0;
      color: var(--cxp-text-3);
      font-size: var(--cxp-fs-sm);
      overflow-wrap: anywhere;
    }
    .cxp-mcp-startup-auth {
      flex: 0 0 auto;
      min-height: 28px;
      padding: 5px 10px;
      border: 1px solid var(--cxp-border-strong);
      border-radius: var(--cxp-radius-md);
      background: transparent;
      color: var(--cxp-text);
      font: 600 var(--cxp-fs-sm)/1.2 var(--cxp-font);
      cursor: pointer;
      transition: background var(--cxp-dur-fast);
    }
    .cxp-mcp-startup-auth:hover:not(:disabled) {
      background: var(--cxp-surface-2);
    }
    .cxp-mcp-startup-auth:focus-visible {
      outline: 2px solid var(--cxp-focus);
      outline-offset: 2px;
    }
    .cxp-mcp-startup-auth:disabled {
      cursor: default;
      opacity: 0.6;
    }
    @media (max-width: 390px) {
      .cxp-mcp-startup-actions {
        align-items: stretch;
        flex-direction: column;
      }
      .cxp-mcp-startup-auth { align-self: flex-start; }
    }

    /* ── Messages ── */
    .cxp-msg {
      display: flex;
      gap: var(--cxp-space-2);
      align-items: flex-start;
      padding: var(--cxp-space-2);
      flex-shrink: 0;
    }
    .cxp-msg.cxp-msg-empty {
      display: none;
    }
    .cxp-msg-user {
      justify-content: flex-end;
      padding: var(--cxp-space-3) var(--cxp-space-2) var(--cxp-space-1);
    }
    .cxp-msg-avatar {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: -2px;
      color: var(--cxp-text-3);
    }
    .cxp-msg-user .cxp-msg-avatar {
      display: none;
    }
    .cxp-msg-avatar svg {
      width: 16px;
      height: 16px;
    }
    .cxp-msg-card {
      flex: 1;
      min-width: 0;
      max-width: 100%;
    }
    .cxp-msg-user .cxp-msg-card {
      flex: 0 1 auto;
      max-width: 85%;
      border-radius: var(--cxp-radius-lg);
      background: var(--cxp-surface-2);
      overflow: hidden;
    }
    .cxp-msg-assistant .cxp-msg-card {
      background: transparent;
      border: none;
      overflow: visible;
    }
    .cxp-msg-head {
      display: flex;
      align-items: center;
      gap: var(--cxp-space-2);
      padding: 0 0 var(--cxp-space-1);
    }
    .cxp-msg-user .cxp-msg-head {
      display: none;
    }
    .cxp-msg-label,
    .cxp-msg-phase {
      font-size: var(--cxp-fs-sm);
      font-weight: 500;
      line-height: 20px;
      color: var(--cxp-text-3);
    }
    .cxp-msg-phase {
      margin-left: auto;
    }
    .cxp-msg-assistant[data-phase="commentary"] .cxp-msg-head {
      display: none;
    }
    .cxp-msg-body {
      padding: 0;
      color: var(--cxp-text);
      font-size: var(--cxp-fs-md);
      line-height: var(--cxp-lh);
      word-break: break-word;
    }
    .cxp-msg-summary {
      color: var(--cxp-text-2);
      font-size: var(--cxp-fs-md);
      line-height: var(--cxp-lh);
      white-space: pre-wrap;
    }
    .cxp-msg-verbose-fold {
      margin-top: var(--cxp-space-2);
    }
    .cxp-msg-verbose-body {
      color: var(--cxp-text);
      font-size: var(--cxp-fs-md);
      line-height: var(--cxp-lh);
      word-break: break-word;
    }
    .cxp-msg-user .cxp-msg-body {
      padding: var(--cxp-space-2) var(--cxp-space-3);
    }
    .cxp-msg-user-text {
      white-space: pre-wrap;
    }
    .cxp-msg-user-image {
      display: block;
      width: min(220px, 100%);
      max-height: 180px;
      object-fit: cover;
      border-radius: var(--cxp-radius-sm);
      margin-bottom: var(--cxp-space-2);
    }
    .cxp-msg-user-attachment {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0 0 var(--cxp-space-1);
      color: var(--cxp-text-2);
      font-size: var(--cxp-fs-sm);
      line-height: var(--cxp-lh-tight);
      overflow-wrap: anywhere;
    }

    /* ── Markdown ── */
    .cxp-msg-body p:first-child,
    .cxp-msg-body ul:first-child,
    .cxp-msg-body ol:first-child,
    .cxp-msg-body pre:first-child,
    .cxp-msg-body h1:first-child,
    .cxp-msg-body h2:first-child,
    .cxp-msg-body h3:first-child {
      margin-top: 0;
    }
    .cxp-msg-body p:last-child,
    .cxp-msg-body ul:last-child,
    .cxp-msg-body ol:last-child,
    .cxp-msg-body pre:last-child {
      margin-bottom: 0;
    }
    .cxp-msg-body p {
      margin: 0 0 var(--cxp-space-2);
    }
    .cxp-msg-body h1,
    .cxp-msg-body h2,
    .cxp-msg-body h3 {
      margin: var(--cxp-space-4) 0 var(--cxp-space-1);
      font-size: var(--cxp-fs-md);
      font-weight: 600;
      line-height: var(--cxp-lh-tight);
      color: var(--cxp-text);
    }
    .cxp-msg-body h1 {
      font-size: var(--cxp-fs-lg);
    }
    .cxp-msg-body h3 {
      margin-top: var(--cxp-space-3);
    }
    .cxp-msg-body code:not(pre code),
    .cxp-card-meta code:not(pre code),
    .cxp-card-body code:not(pre code) {
      background: var(--cxp-surface-2);
      border-radius: var(--cxp-radius-sm);
      padding: 1px 4px;
      font-family: var(--cxp-mono);
      font-size: max(var(--cxp-fs-sm), 0.92em);
      color: var(--cxp-text);
    }
    .cxp-msg-body pre,
    .cxp-card-pre {
      margin: 0;
      padding: var(--cxp-space-2) var(--cxp-space-3);
      border-radius: var(--cxp-radius-sm);
      background: var(--cxp-surface-1);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--cxp-text-2);
      font-family: var(--cxp-mono);
      font-size: var(--cxp-fs-sm);
      line-height: 1.55;
    }
    .cxp-msg-body pre {
      margin: var(--cxp-space-2) 0;
      color: var(--cxp-text);
    }
    .cxp-card-pre.cxp-card-pre-log,
    .cxp-card-pre.cxp-card-pre-diff {
      white-space: pre;
      word-break: normal;
      overflow-x: auto;
      overflow-y: auto;
      max-height: 320px;
    }
    .cxp-card-pre.cxp-card-pre-json,
    .cxp-card-pre.cxp-card-pre-result,
    .cxp-card-pre.cxp-card-pre-prompt {
      max-height: 260px;
      overflow: auto;
    }
    .cxp-msg-body pre code,
    .cxp-card-pre code {
      background: none;
      border: none;
      padding: 0;
      color: inherit;
      font-family: inherit;
      font-size: inherit;
    }
    .cxp-msg-body pre code.hljs,
    .cxp-card-pre code.hljs {
      background: transparent;
      padding: 0;
    }
    .cxp-copy-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      min-height: 24px;
      padding: 2px 8px;
      border-radius: var(--cxp-radius-sm);
      font-size: var(--cxp-fs-sm);
      font-family: var(--cxp-font);
      color: var(--cxp-text-2);
      background: var(--cxp-pop);
      border: 1px solid var(--cxp-border);
      cursor: pointer;
      opacity: 0;
      transition: opacity var(--cxp-dur-fast), color var(--cxp-dur-fast);
      z-index: 1;
    }
    .cxp-msg-body pre:hover .cxp-copy-btn,
    .cxp-card-pre:hover .cxp-copy-btn,
    .cxp-copy-btn:focus-visible {
      opacity: 1;
    }
    .cxp-copy-btn:hover {
      color: var(--cxp-text);
      border-color: var(--cxp-border-strong);
    }
    .cxp-file-link {
      color: var(--cxp-link);
      text-decoration: none;
      border-bottom: 1px dotted currentColor;
      cursor: pointer;
    }
    .cxp-file-link:hover {
      border-bottom-style: solid;
    }
    .cxp-file-link-copied {
      color: var(--cxp-success) !important;
    }
    .cxp-msg-body a,
    .cxp-card-body a {
      color: var(--cxp-link);
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 2px;
    }
    .cxp-msg-body a.cxp-file-link,
    .cxp-card-body a.cxp-file-link {
      text-decoration: none;
    }
    .cxp-msg-body a:hover,
    .cxp-card-body a:hover {
      text-decoration-thickness: 2px;
    }
    .cxp-msg-body strong,
    .cxp-card-body strong {
      font-weight: 600;
      color: var(--cxp-text);
    }
    .cxp-msg-body ul,
    .cxp-msg-body ol {
      margin: var(--cxp-space-1) 0 var(--cxp-space-2);
      padding-left: 1.4em;
    }
    .cxp-msg-body li > ul,
    .cxp-msg-body li > ol {
      margin: 0;
    }
    .cxp-msg-body ul {
      list-style: none;
    }
    .cxp-msg-body ul li {
      position: relative;
    }
    .cxp-msg-body ul li::before {
      content: '';
      position: absolute;
      left: -1em;
      top: 0.7em;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--cxp-text-3);
    }
    .cxp-msg-body ol li::marker {
      color: var(--cxp-text-3);
      font-size: var(--cxp-fs-sm);
    }
    .cxp-msg-body blockquote {
      margin: var(--cxp-space-2) 0;
      padding: 0 0 0 var(--cxp-space-3);
      border-left: 2px solid var(--cxp-border-strong);
      color: var(--cxp-text-2);
    }
    .cxp-msg-body hr {
      border: none;
      height: 1px;
      margin: var(--cxp-space-3) 0;
      background: var(--cxp-border);
    }
    /* A wide table scrolls sideways inside the message instead of crushing its columns. */
    .cxp-msg-body table {
      display: block;
      width: max-content;
      max-width: 100%;
      overflow-x: auto;
      border-collapse: collapse;
      margin: var(--cxp-space-2) 0;
      font-size: var(--cxp-fs-sm);
    }
    .cxp-msg-body th,
    .cxp-msg-body td {
      padding: var(--cxp-space-1) var(--cxp-space-3) var(--cxp-space-1) 0;
      text-align: left;
      vertical-align: top;
      word-break: normal;
      overflow-wrap: normal;
      border-bottom: 1px solid var(--cxp-border);
    }
    .cxp-msg-body th {
      font-weight: 600;
      color: var(--cxp-text);
      white-space: nowrap;
      border-bottom-color: var(--cxp-border-strong);
    }
    .cxp-msg-body td {
      color: var(--cxp-text-2);
    }

    /* ── Working indicators ── */
    .cxp-think-dots {
      display: inline-flex;
      gap: 3px;
      align-items: center;
      margin-left: auto;
      margin-right: 6px;
    }
    .cxp-think-dots span,
    .cxp-thinking .cxp-msg-think-dots span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--cxp-running);
      animation: cxp-working 1.6s ease-in-out infinite;
    }
    .cxp-think-dots span:nth-child(2),
    .cxp-thinking .cxp-msg-think-dots span:nth-child(2) { animation-delay: 0.2s; }
    .cxp-think-dots span:nth-child(3),
    .cxp-thinking .cxp-msg-think-dots span:nth-child(3) { animation-delay: 0.4s; }
    .cxp-reasoning.cxp-reasoning-done .cxp-think-dots { display: none; }
    .cxp-thinking {
      display: flex;
      gap: var(--cxp-space-2);
      align-items: center;
      padding: var(--cxp-space-2);
      flex-shrink: 0;
    }
    .cxp-thinking .cxp-think-avatar {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--cxp-text-3);
    }
    .cxp-thinking .cxp-think-avatar svg { width: 16px; height: 16px; }
    .cxp-thinking .cxp-msg-think-dots {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .cxp-thinking .cxp-think-title {
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-2);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .cxp-thinking .cxp-think-detail {
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-3);
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-thinking .cxp-think-timer {
      font-size: var(--cxp-fs-sm);
      font-variant-numeric: tabular-nums;
      color: var(--cxp-text-3);
      min-width: 24px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .cxp-thinking--waiting .cxp-msg-think-dots span {
      background: var(--cxp-warning);
    }
    .cxp-thinking--waiting .cxp-think-title {
      color: var(--cxp-warning);
    }

    /* ── Cards: one anatomy ──────────────────────────────────────────
       head (icon · title / subtitle · status · chevron) and body. Card
       types differ by icon and title, never by a different box. */
    .cxp-card {
      margin: var(--cxp-space-1) var(--cxp-space-2);
      border-radius: var(--cxp-radius-md);
      border: 1px solid var(--cxp-border);
      background: transparent;
      overflow: hidden;
      flex-shrink: 0;
    }
    .cxp-card.cxp-collapsed > .cxp-card-body {
      display: none;
    }
    .codex-panel .cxp-card-head:focus-visible {
      outline: 2px solid var(--cxp-focus);
      outline-offset: -2px;
    }
    .cxp-card-head,
    .cxp-reasoning summary {
      display: flex;
      align-items: center;
      gap: var(--cxp-space-2);
      min-height: 48px;
      padding: var(--cxp-space-2) var(--cxp-space-3);
      cursor: pointer;
      user-select: none;
      transition: background var(--cxp-dur-fast);
    }
    .cxp-card-head:hover,
    .cxp-reasoning summary:hover {
      background: var(--cxp-surface-1);
    }
    .cxp-card-chevron {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--cxp-text-3);
      transition: transform var(--cxp-dur-fast) var(--cxp-ease);
      font-size: var(--cxp-fs-xs);
    }
    .cxp-card-chevron::after {
      content: '\\25BE';
    }
    .cxp-collapsed > .cxp-card-head > .cxp-card-chevron {
      transform: rotate(-90deg);
    }
    .cxp-card-icon {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--cxp-text-3);
      flex-shrink: 0;
    }
    .cxp-card-icon svg {
      width: 14px;
      height: 14px;
    }
    .cxp-card-titles {
      flex: 1;
      min-width: 0;
    }
    .cxp-card-title,
    .cxp-card-subtitle {
      display: block;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: var(--cxp-lh-tight);
    }
    .cxp-card-title {
      font-size: var(--cxp-fs-md);
      font-weight: 600;
      color: var(--cxp-text);
    }
    .cxp-card-subtitle {
      margin-top: 1px;
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-3);
    }
    .cxp-card-subtitle:empty {
      display: none;
    }
    /* Status: a plain label. Only a status that needs attention gets a mark and a colour. */
    .cxp-status-pill {
      flex-shrink: 0;
      max-width: 45%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-3);
    }
    .cxp-status-pill[data-tone]::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      margin-right: 6px;
      border-radius: 50%;
      background: currentColor;
      vertical-align: 1px;
    }
    .cxp-status-pill[data-tone="running"] { color: var(--cxp-running); }
    .cxp-status-pill[data-tone="running"]::before { animation: cxp-working 1.6s ease-in-out infinite; }
    .cxp-status-pill[data-tone="warning"] { color: var(--cxp-warning); }
    .cxp-status-pill[data-tone="error"] { color: var(--cxp-danger); }
    .cxp-status-pill[data-tone="success"] { color: var(--cxp-success); }
    /* SynaBun identity: the logo and a thin accent, not a filled box. */
    .cxp-card.cxp-card-synabun-tool,
    .cxp-card.cxp-card-synabun-request,
    .cxp-synabun-inline-card {
      box-shadow: inset 2px 0 0 var(--cxp-synabun);
    }
    .cxp-card.cxp-card-synabun-tool .cxp-card-icon,
    .cxp-card.cxp-card-synabun-request .cxp-card-icon {
      color: var(--cxp-synabun);
    }
    .cxp-card-body {
      padding: 0 var(--cxp-space-3) var(--cxp-space-3);
      display: flex;
      flex-direction: column;
      gap: var(--cxp-space-2);
    }
    .cxp-card-meta {
      font-size: var(--cxp-fs-sm);
      line-height: 1.5;
      color: var(--cxp-text-3);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .cxp-card-meta:empty {
      display: none;
    }
    .cxp-card-section {
      display: flex;
      flex-direction: column;
      gap: var(--cxp-space-1);
    }
    .cxp-card-section[hidden] {
      display: none;
    }
    .cxp-card-section-label,
    .cxp-fold-label {
      font-size: var(--cxp-fs-sm);
      font-weight: 500;
      color: var(--cxp-text-3);
    }
    .cxp-fold {
      overflow: hidden;
    }
    .cxp-fold[hidden] {
      display: none;
    }
    .cxp-fold-summary {
      list-style: none;
      display: flex;
      align-items: center;
      gap: var(--cxp-space-2);
      min-height: 28px;
      cursor: pointer;
      user-select: none;
      transition: color var(--cxp-dur-fast);
    }
    .cxp-fold-summary:hover .cxp-fold-label,
    .cxp-fold-summary:hover .cxp-card-chevron {
      color: var(--cxp-text-2);
    }
    .cxp-fold-summary::marker,
    .cxp-fold-summary::-webkit-details-marker {
      display: none;
      content: '';
    }
    .cxp-fold-label {
      flex: 1;
      min-width: 0;
    }
    .cxp-fold > .cxp-fold-summary > .cxp-card-chevron {
      margin-left: auto;
    }
    .cxp-fold:not([open]) > .cxp-fold-summary > .cxp-card-chevron {
      transform: rotate(-90deg);
    }
    .cxp-fold-body {
      padding: 0;
    }
    .cxp-reasoning summary::marker {
      content: '';
    }
    .cxp-reasoning summary::-webkit-details-marker {
      display: none;
    }
    .cxp-reasoning:not([open]) summary .cxp-card-chevron {
      transform: rotate(-90deg);
    }
    /* The three dots are the live mark here, so the status label stays plain. */
    .cxp-reasoning .cxp-status-pill[data-tone]::before {
      display: none;
    }
    /* Generic cards whose body is a sentence, not output. */
    .cxp-card:is([data-item-type="sleep"], [data-item-type="threadGoal"], [data-item-type="subAgentActivity"], [data-item-type="enteredReviewMode"], [data-item-type="exitedReviewMode"]) .cxp-card-pre {
      font-family: var(--cxp-font);
      font-size: var(--cxp-fs-md);
    }
    .cxp-reasoning-body {
      padding: 0 var(--cxp-space-3) var(--cxp-space-3);
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--cxp-text-2);
      font-size: var(--cxp-fs-md);
      line-height: var(--cxp-lh);
      max-height: min(360px, 42vh);
      overflow-y: auto;
    }

    /* ── Requests: approval, question, elicitation ── */
    .cxp-card.cxp-ask {
      border-color: var(--cxp-border-strong);
    }
    .cxp-msg-body > .cxp-card-section.cxp-ask {
      gap: var(--cxp-space-2);
      margin-top: var(--cxp-space-3);
      padding-top: var(--cxp-space-3);
      border-top: 1px solid var(--cxp-border);
    }
    .cxp-ask .cxp-config-row {
      flex-wrap: wrap;
      gap: var(--cxp-space-1);
      padding: 0;
      border-bottom: none;
    }
    .cxp-ask .cxp-config-label {
      flex: 1 0 100%;
      text-align: left;
      font-family: var(--cxp-font);
      font-size: var(--cxp-fs-md);
      font-weight: 500;
      color: var(--cxp-text);
    }
    .cxp-ask .cxp-config-input {
      padding: var(--cxp-space-2) var(--cxp-space-3);
      font-family: var(--cxp-font);
      font-size: var(--cxp-fs-md);
    }
    .cxp-ask-question-card {
      display: flex;
      flex-direction: column;
      gap: var(--cxp-space-2);
    }
    .cxp-ask-question-card + .cxp-ask-question-card {
      padding-top: var(--cxp-space-3);
      border-top: 1px solid var(--cxp-border);
    }
    .cxp-ask-question {
      font-size: var(--cxp-fs-md);
      color: var(--cxp-text);
      line-height: var(--cxp-lh);
    }
    .cxp-ask-options {
      display: flex;
      flex-direction: column;
      gap: var(--cxp-space-2);
    }
    .cxp-ask-option,
    .cxp-inline-choice {
      width: 100%;
      padding: var(--cxp-space-2) var(--cxp-space-3);
      text-align: left;
      border-radius: var(--cxp-radius-md);
      border: 1px solid var(--cxp-border-strong);
      background: transparent;
      color: var(--cxp-text);
      font-family: var(--cxp-font);
      font-size: var(--cxp-fs-md);
      line-height: 1.45;
      cursor: pointer;
      transition: border-color var(--cxp-dur-fast), background var(--cxp-dur-fast);
    }
    .cxp-ask-option:hover:not(:disabled),
    .cxp-inline-choice:hover:not(.chosen) {
      background: var(--cxp-surface-1);
    }
    .cxp-ask-option.selected,
    .cxp-inline-choice.chosen {
      border-color: var(--cxp-text-2);
      background: var(--cxp-surface-2);
    }
    .cxp-ask-option.selected .cxp-ask-option-label::after,
    .cxp-inline-choice.chosen .cxp-inline-choice-label::after {
      content: '\\2713';
      float: right;
      margin-left: var(--cxp-space-2);
    }
    .cxp-ask-option:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .cxp-ask-option-label {
      display: block;
      font-size: var(--cxp-fs-md);
      font-weight: 600;
    }
    .cxp-ask-option-desc {
      display: block;
      margin-top: 2px;
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-3);
      line-height: 1.45;
    }
    .cxp-ask-option-desc:empty {
      display: none;
    }
    .cxp-ask-input,
    .cxp-request-input,
    .cxp-request-select,
    .cxp-request-textarea,
    .cxp-card-textarea,
    .cxp-terminal-input {
      width: 100%;
      padding: var(--cxp-space-2) var(--cxp-space-3);
      border-radius: var(--cxp-radius-sm);
      border: 1px solid var(--cxp-border-input);
      background: transparent;
      color: var(--cxp-text);
      font: inherit;
      font-family: var(--cxp-font);
      font-size: var(--cxp-fs-md);
      box-sizing: border-box;
    }
    .cxp-ask-input::placeholder,
    .cxp-request-input::placeholder,
    .cxp-request-textarea::placeholder,
    .cxp-card-textarea::placeholder,
    .cxp-terminal-input::placeholder {
      color: var(--cxp-text-3);
    }
    .cxp-ask-other {
      display: grid;
      gap: var(--cxp-space-2);
    }
    .cxp-inline-choices {
      display: flex;
      flex-direction: column;
      gap: var(--cxp-space-2);
      margin: var(--cxp-space-2) 0 var(--cxp-space-1);
    }
    .cxp-inline-choice.chosen {
      cursor: default;
    }
    .cxp-inline-choice.dismissed {
      opacity: 0.4;
      cursor: default;
      pointer-events: none;
    }
    .cxp-inline-choices.cxp-inline-choices-synabun {
      margin-top: 2px;
    }
    .cxp-inline-choice-label {
      font-weight: 600;
    }
    .cxp-inline-choice-desc {
      margin-left: 4px;
      color: var(--cxp-text-3);
    }
    .cxp-synabun-inline-card {
      position: relative;
      overflow: hidden;
      display: grid;
      gap: var(--cxp-space-2);
      margin: var(--cxp-space-2) 0 var(--cxp-space-1);
      padding: var(--cxp-space-3);
      border-radius: var(--cxp-radius-md);
      border: 1px solid var(--cxp-border);
    }
    .cxp-synabun-inline-head {
      display: flex;
      align-items: center;
      gap: var(--cxp-space-2);
    }
    .cxp-synabun-inline-logo {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .cxp-synabun-inline-logo img {
      width: 15px;
      height: 15px;
      object-fit: contain;
    }
    .cxp-synabun-inline-title {
      font-size: var(--cxp-fs-sm);
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--cxp-synabun);
    }
    .cxp-synabun-inline-prompt {
      font-size: var(--cxp-fs-md);
      line-height: var(--cxp-lh);
      color: var(--cxp-text-2);
    }
    .cxp-ask-actions,
    .cxp-ask-submit-bar {
      display: flex;
      justify-content: flex-end;
      gap: var(--cxp-space-2);
    }
    .cxp-request-note {
      font-size: var(--cxp-fs-md);
      line-height: var(--cxp-lh);
      color: var(--cxp-text-2);
    }
    .cxp-request-fields {
      display: flex;
      flex-direction: column;
      gap: var(--cxp-space-3);
    }
    .cxp-request-field {
      display: flex;
      flex-direction: column;
      gap: var(--cxp-space-1);
    }
    .cxp-request-fieldhead {
      display: flex;
      align-items: baseline;
      gap: 6px;
      flex-wrap: wrap;
    }
    .cxp-request-fieldhead strong {
      font-size: var(--cxp-fs-md);
      font-weight: 500;
      color: var(--cxp-text);
    }
    .cxp-request-required {
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-3);
    }
    .cxp-request-help {
      font-size: var(--cxp-fs-sm);
      line-height: 1.45;
      color: var(--cxp-text-3);
    }
    .cxp-request-textarea {
      min-height: 92px;
      resize: vertical;
    }
    .cxp-request-select[multiple] {
      min-height: 104px;
    }
    .cxp-request-check {
      display: inline-flex;
      align-items: center;
      gap: var(--cxp-space-2);
      font-size: var(--cxp-fs-md);
      color: var(--cxp-text);
    }
    .cxp-request-check input {
      margin: 0;
      accent-color: var(--cxp-solid);
    }
    .cxp-request-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--cxp-space-2);
      flex-wrap: wrap;
    }
    /* Buttons: solid for the one primary action, hairline for the rest, red text for the destructive one. */
    .cxp-request-btn,
    .cxp-ask-submit {
      min-height: 32px;
      padding: 6px var(--cxp-space-3);
      border-radius: var(--cxp-radius-md);
      border: 1px solid transparent;
      background: var(--cxp-solid);
      color: var(--cxp-on-solid);
      cursor: pointer;
      font-family: var(--cxp-font);
      font-size: var(--cxp-fs-md);
      font-weight: 600;
      line-height: 1.5;
      transition: background var(--cxp-dur-fast), border-color var(--cxp-dur-fast), color var(--cxp-dur-fast);
    }
    .cxp-request-btn:hover:not(:disabled),
    .cxp-ask-submit:hover:not(:disabled) {
      background: var(--cxp-solid-hover);
    }
    .cxp-request-btn.secondary,
    .cxp-request-btn.danger {
      border-color: var(--cxp-border-strong);
      background: transparent;
      color: var(--cxp-text);
    }
    .cxp-request-btn.danger {
      color: var(--cxp-danger);
    }
    .cxp-request-btn.secondary:hover:not(:disabled),
    .cxp-request-btn.danger:hover:not(:disabled) {
      background: var(--cxp-surface-1);
      border-color: var(--cxp-border-input);
    }
    .cxp-request-btn:disabled,
    .cxp-ask-submit:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    [data-mcp-app] .cxp-request-btn:focus-visible,
    [data-mcp-app] .cxp-card-pre:focus-visible {
      outline: 2px solid var(--cxp-solid);
      outline-offset: 2px;
    }
    .cxp-request-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: var(--cxp-fs-md);
      color: var(--cxp-link);
      text-decoration: underline;
      text-underline-offset: 2px;
      word-break: break-all;
    }

    /* ── Plan document and review ── */
    .cxp-plan-document-toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--cxp-space-2);
      padding: var(--cxp-space-3) 0 0;
      border-top: 1px solid var(--cxp-border);
      margin-top: var(--cxp-space-4);
    }
    .cxp-plan-document-label {
      margin-bottom: var(--cxp-space-3);
      font: 500 var(--cxp-fs-md)/1.5 var(--cxp-font);
      color: var(--cxp-text-3);
    }
    .cxp-plan-document-content {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .cxp-plan-document-content pre,
    .cxp-plan-document-content table {
      max-width: 100%;
      overflow-x: auto;
      overflow-wrap: normal;
      word-break: normal;
    }
    .cxp-plan-document-content pre { white-space: pre; }
    .cxp-plan-document-content table { display: block; }
    .cxp-plan-editor-notice {
      color: var(--cxp-warning);
      font-size: var(--cxp-fs-md);
    }
    .cxp-plan-editor-notice[hidden],
    .cxp-plan-document-toolbar [hidden],
    .cxp-use-as-plan[hidden],
    [data-plan-source-hidden="1"] { display: none !important; }
    .cxp-use-as-plan { margin-top: var(--cxp-space-3); }
    .cxp-plan-card > .cxp-card-body { max-height: none; }
    .cxp-post-plan-msg {
      /* Align with the document text without repeating its avatar/header. */
      padding: 0 var(--cxp-space-2) var(--cxp-space-3) calc(var(--cxp-space-2) + 24px + var(--cxp-space-2));
    }
    .cxp-post-plan-card {
      display: grid;
      gap: var(--cxp-space-4);
      min-width: 0;
    }
    .cxp-post-plan-msg .cxp-post-plan-card {
      font-family: var(--cxp-font);
    }
    /* Compaction awaits a decision, with the same neutral hairline as requests. */
    .cxp-post-compact-card {
      position: relative;
      gap: var(--cxp-space-3);
      overflow: hidden;
      border: 1px solid var(--cxp-border-strong);
      background: transparent;
      border-radius: var(--cxp-radius-md);
      padding: var(--cxp-space-3) var(--cxp-space-4);
      transition: opacity var(--cxp-dur-fast) ease;
    }
    .cxp-post-compact-card::before {
      content: none;
    }
    .cxp-post-plan-card.is-busy {
      opacity: 0.72;
    }
    .cxp-post-plan-card .cxp-request-btn:focus-visible {
      outline: 2px solid var(--cxp-focus);
      outline-offset: 2px;
    }
    .cxp-post-plan-header {
      font-size: var(--cxp-fs-sm);
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--cxp-text-3);
    }
    .cxp-post-plan-note {
      font-size: var(--cxp-fs-md);
      line-height: 1.5;
      color: var(--cxp-text-2);
    }
    .cxp-post-plan-decision {
      display: grid;
    }
    .cxp-post-plan-decision .cxp-request-btn.primary {
      width: 100%;
      min-height: 36px;
      justify-content: center;
    }
    .cxp-post-plan-feedback-group {
      display: grid;
      gap: var(--cxp-space-2);
      min-width: 0;
    }
    .cxp-post-plan-feedback-label {
      color: var(--cxp-text-2);
      font: 500 var(--cxp-fs-md)/1.5 var(--cxp-font);
    }
    .cxp-post-plan-feedback {
      width: 100%;
      min-height: 56px;
      max-height: 132px;
      box-sizing: border-box;
      resize: none;
      overflow-y: auto;
      border: 1px solid var(--cxp-border-input);
      border-radius: var(--cxp-radius-sm);
      padding: var(--cxp-space-2) var(--cxp-space-3);
      background: transparent;
      color: var(--cxp-text);
      caret-color: currentColor;
      font: 400 var(--cxp-fs-md)/1.5 var(--cxp-font);
      transition: border-color var(--cxp-dur-fast) ease;
    }
    .cxp-post-plan-feedback::placeholder {
      color: var(--cxp-text-3);
    }
    .cxp-post-plan-feedback:hover:not(:disabled) {
      border-color: var(--cxp-text-3);
    }
    .cxp-post-plan-feedback:focus-visible {
      border-color: var(--cxp-text-3);
      outline: 2px solid var(--cxp-focus);
      outline-offset: 2px;
    }
    .cxp-post-plan-feedback:disabled {
      opacity: 0.6;
    }
    .cxp-post-plan-feedback-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--cxp-space-2);
      flex-wrap: wrap;
    }
    .cxp-post-plan-feedback-hint {
      min-width: 0;
      color: var(--cxp-text-3);
      font: 400 var(--cxp-fs-sm)/1.5 var(--cxp-font);
    }
    .cxp-post-plan-update {
      min-height: 32px;
      flex: 0 0 auto;
    }
    .cxp-post-plan-feedback-error {
      color: var(--cxp-danger);
      font: 400 var(--cxp-fs-md)/1.5 var(--cxp-font);
    }
    .cxp-post-plan-feedback-error[hidden] {
      display: none;
    }
    .cxp-post-plan-utilities {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--cxp-space-2);
      flex-wrap: wrap;
    }
    .cxp-plan-document-toolbar .cxp-request-btn,
    .cxp-post-plan-msg .cxp-request-btn.secondary {
      min-height: 32px;
      padding: 6px var(--cxp-space-2);
      border-color: transparent;
      background: transparent;
      color: var(--cxp-text-2);
      font-weight: 500;
    }
    .cxp-plan-document-toolbar .cxp-request-btn:hover:not(:disabled),
    .cxp-post-plan-msg .cxp-request-btn.secondary:hover:not(:disabled) {
      border-color: transparent;
      background: var(--cxp-surface-2);
      color: var(--cxp-text);
    }
    .cxp-plan-document-toolbar .cxp-request-btn:focus-visible,
    .cxp-post-plan-msg .cxp-request-btn:focus-visible {
      outline: 2px solid var(--cxp-focus);
      outline-offset: 2px;
    }
    .cxp-post-plan-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--cxp-space-2);
    }
    .cxp-post-plan-actions .cxp-request-btn {
      min-width: 0;
      flex: 1 1 180px;
      justify-content: center;
    }
    @media (max-width: 390px) {
      .cxp-post-compact-card { padding: var(--cxp-space-3); }
      .cxp-post-plan-feedback-footer {
        align-items: stretch;
        flex-direction: column;
      }
      .cxp-post-plan-update { width: 100%; justify-content: center; }
      .cxp-post-plan-utilities { justify-content: flex-start; }
      .cxp-post-plan-utilities .cxp-request-btn { flex: 1; justify-content: center; }
    }

    /* ── Composer ── */
    .cxp-bottom {
      flex-shrink: 0;
      border-top: none;
      border-radius: var(--cxp-radius-lg);
      margin: 0 8px 8px 8px;
      background: var(--cxp-surface-1);
      padding-bottom: 4px;
      z-index: 10;
      position: relative;
    }
    /* The wrap draws the input's edge: 1px of padding over a border-coloured fill. */
    .cxp-input-wrap {
      flex: 1; position: relative;
      margin: 8px 8px 2px;
      border-radius: var(--cxp-radius-lg);
      padding: 1px;
      background: var(--cxp-border-input);
      transition: background var(--cxp-dur-fast), box-shadow var(--cxp-dur-fast);
      min-width: 0; overflow: hidden;
    }
    .cxp-input-wrap:focus-within {
      background: var(--cxp-focus);
      box-shadow: 0 0 0 1px var(--cxp-focus);
    }
    .cxp-input-shell {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      padding: 5px 5px 5px 14px;
      border-radius: calc(var(--cxp-radius-lg) - 1px);
      background: var(--cxp-pop);
      border: none;
    }
    .cxp-input {
      flex: 1;
      min-width: 0;
      resize: none;
      border: none;
      outline: none;
      background: transparent;
      color: var(--cxp-text);
      font-family: var(--cxp-font);
      font-size: var(--cxp-fs-lg);
      line-height: 1.5;
      padding: 6px 0;
      max-height: 180px;
      overflow-y: auto;
      overflow-wrap: break-word;
      word-break: break-word;
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
      transition: scrollbar-color var(--cxp-dur);
    }
    /* The wrap above shows the ring for the textarea. */
    .codex-panel .cxp-input:focus-visible {
      outline: none;
    }
    .cxp-input:hover,
    .cxp-input:focus {
      scrollbar-color: var(--cxp-border-strong) transparent;
    }
    .cxp-input::-webkit-scrollbar { width: 4px; }
    .cxp-input::-webkit-scrollbar-track { background: transparent; }
    .cxp-input::-webkit-scrollbar-thumb { background: transparent; border-radius: var(--cxp-radius-sm); }
    .cxp-input:hover::-webkit-scrollbar-thumb,
    .cxp-input:focus::-webkit-scrollbar-thumb { background: var(--cxp-border-strong); }
    .cxp-input.scrollable {
      -webkit-mask-image: linear-gradient(to bottom, transparent 0px, black 6px, black calc(100% - 10px), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0px, black 6px, black calc(100% - 10px), transparent 100%);
    }
    .cxp-input::placeholder {
      color: var(--cxp-text-3);
    }
    .cxp-send,
    .cxp-mic-btn {
      width: 28px;
      height: 28px;
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-md);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: var(--cxp-text-3);
      cursor: pointer;
      flex-shrink: 0;
      transition: background var(--cxp-dur-fast), color var(--cxp-dur-fast), border-color var(--cxp-dur-fast);
      position: sticky;
      bottom: 3px;
      align-self: flex-end;
    }
    .cxp-send {
      overflow: hidden;
    }
    .cxp-send:not(:disabled) {
      color: var(--cxp-on-solid);
      border-color: transparent;
      background: var(--cxp-solid);
    }
    .cxp-send:hover:not(:disabled) {
      background: var(--cxp-solid-hover);
    }
    .cxp-send:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .cxp-send svg {
      width: 12px;
      height: 12px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-linejoin: round;
      position: relative;
      z-index: 1;
    }
    .cxp-send.cxp-send-stopping {
      border-color: var(--cxp-danger);
      background: transparent;
      color: var(--cxp-danger);
    }
    .cxp-send.cxp-send-stopping:hover:not(:disabled) {
      background: var(--cxp-surface-1);
    }
    .cxp-send.cxp-send-stopping .cxp-send-icon { display: none; }
    .cxp-send.cxp-send-stopping .cxp-stop-icon { display: block !important; }
    .cxp-send:not(.cxp-send-stopping) .cxp-stop-icon { display: none; }
    .cxp-footer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: nowrap;
      gap: 0;
      padding: 4px 10px 2px;
      flex-shrink: 0;
    }
    .cxp-footer-toolbar .cxp-toolbar-toggle,
    .cxp-footer-toolbar .cxp-btn-label { letter-spacing: normal; }
    .cxp-footer-left {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1 0 auto;
      min-width: 0;
    }
    .cxp-brand {
      height: 16px; width: auto; flex-shrink: 0;
      color: var(--cxp-brand);
    }
    .cxp-brand-link {
      display: inline-flex;
      align-items: center;
      color: inherit;
      text-decoration: none;
      line-height: 0;
      flex-shrink: 0;
    }
    .cxp-bar-action {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      background: none;
      border: none;
      border-radius: var(--cxp-radius-sm);
      color: var(--cxp-text-3);
      cursor: pointer;
      transition: background var(--cxp-dur-fast), color var(--cxp-dur-fast);
      padding: 0;
      flex-shrink: 0;
    }
    .cxp-bar-action:hover {
      color: var(--cxp-text);
      background: var(--cxp-surface-2);
    }
    .cxp-projectbar-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-left: auto;
    }
    /* Keep every control and label visible; narrow panels use a second row. */
    .cxp-footer-right {
      display: flex;
      align-items: center;
      gap: calc(var(--cxp-space-1) / 4);
      flex-wrap: wrap;
      row-gap: var(--cxp-space-1);
      flex-shrink: 1;
      min-width: 0;
    }
    .cxp-footer-right > .cxp-dropdown { flex-shrink: 0; }

    /* ── Minimized session pill (lives in the terminal dock) ── */
    .cxp-session-pill {
      position: relative;
      overflow: hidden;
    }
    .cxp-session-pill .term-minimized-pill-icon { color: var(--cxp-text-3); transition: color var(--cxp-dur-fast); }
    .cxp-session-pill:hover .term-minimized-pill-icon,
    .cxp-session-pill.cxp-pill-running .term-minimized-pill-icon { color: var(--cxp-text); }
    .cxp-session-pill.cxp-pill-running .term-minimized-pill-label::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      margin-right: 6px;
      border-radius: 50%;
      background: var(--cxp-running);
      vertical-align: middle;
      animation: cxp-working 1.6s ease-in-out infinite;
      flex-shrink: 0;
    }
    .cxp-hint {
      margin-top: 8px;
      font-size: var(--cxp-fs-xs);
      color: var(--cxp-text-3);
      padding: 0 12px;
    }

    /* ── Dynamic tool textarea and terminal input ── */
    .cxp-card-textarea {
      resize: vertical;
    }
    .cxp-terminal-input-wrap {
      display: flex;
      gap: 6px;
      margin-top: 6px;
    }
    .cxp-terminal-input {
      flex: 1;
      width: auto;
      min-width: 0;
      padding: 4px 8px;
      font-family: var(--cxp-mono);
    }
    /* Text buttons share the icon button's height and grow to fit their label. */
    .cxp-btn-sm {
      width: auto;
      min-width: 24px;
      padding: 3px 10px;
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-2);
      white-space: nowrap;
    }

    /* ── Lightbox ── */
    .cxp-lightbox {
      position: fixed;
      inset: 0;
      z-index: 100000;
      background: var(--cxp-scrim);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: zoom-out;
    }
    .cxp-lightbox img {
      max-width: 90vw;
      max-height: 90vh;
      border-radius: var(--cxp-radius-md);
      box-shadow: var(--cxp-shadow-pop);
    }
    .cxp-image-preview {
      padding: 4px 0;
    }

    /* ── Settings and feature overlays ── */
    .cxp-settings-overlay {
      position: absolute;
      inset: 0;
      z-index: 50;
      background: var(--cxp-scrim);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 24px;
      animation: cxp-fade-in var(--cxp-dur-fast) ease;
    }
    .cxp-settings-panel {
      background: var(--cxp-pop);
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-lg);
      width: 92%;
      max-height: calc(100% - 48px);
      overflow-y: auto;
      box-shadow: var(--cxp-shadow-pop);
    }
    .cxp-settings-panel::-webkit-scrollbar { width: 4px; }
    .cxp-settings-panel::-webkit-scrollbar-track { background: transparent; }
    .cxp-settings-panel::-webkit-scrollbar-thumb { background: var(--cxp-border-strong); border-radius: var(--cxp-radius-sm); }
    .cxp-settings-header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px 12px;
      background: var(--cxp-pop);
      border-bottom: 1px solid var(--cxp-border);
      font-size: var(--cxp-fs-lg);
      font-weight: 600;
      color: var(--cxp-text);
    }
    .cxp-settings-close {
      min-width: 24px;
      min-height: 24px;
      background: none;
      border: none;
      color: var(--cxp-text-3);
      font-size: var(--cxp-fs-lg);
      line-height: 1;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: var(--cxp-radius-sm);
      transition: color var(--cxp-dur-fast), background var(--cxp-dur-fast);
    }
    .cxp-settings-close:hover { color: var(--cxp-text); background: var(--cxp-surface-2); }
    .cxp-settings-body { padding: 8px 14px 14px; }
    .cxp-settings-section {
      margin-bottom: 4px;
      padding: 10px 0;
      border-bottom: 1px solid var(--cxp-border);
    }
    .cxp-settings-section:last-child { border-bottom: none; margin-bottom: 0; }
    .cxp-settings-section .cxp-settings-section { margin-bottom: 0; padding: 6px 0; }
    .cxp-settings-section-title {
      font-size: var(--cxp-fs-xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--cxp-text-3);
      margin-bottom: 8px;
    }
    .cxp-settings-loading {
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-3);
    }
    .cxp-settings-value {
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-2);
      overflow-wrap: anywhere;
    }
    summary.cxp-settings-value { cursor: pointer; }
    .cxp-settings-hint {
      font-size: var(--cxp-fs-xs);
      line-height: 1.5;
      color: var(--cxp-text-3);
      margin-top: 4px;
      overflow-wrap: anywhere;
    }
    pre.cxp-settings-hint {
      font-family: var(--cxp-mono);
      white-space: pre-wrap;
    }
    .cxp-settings-login-btn,
    .cxp-config-save {
      font-size: var(--cxp-fs-xs);
      font-family: var(--cxp-font);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--cxp-text);
      background: transparent;
      border: 1px solid var(--cxp-border-strong);
      border-radius: var(--cxp-radius-md);
      cursor: pointer;
      transition: background var(--cxp-dur-fast), border-color var(--cxp-dur-fast);
    }
    .cxp-settings-login-btn {
      padding: 4px 12px;
      margin-top: 6px;
    }
    .cxp-settings-login-btn:hover,
    .cxp-config-save:hover:not(:disabled) { background: var(--cxp-surface-2); border-color: var(--cxp-border-input); }
    .cxp-mcp-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      border-radius: var(--cxp-radius-sm);
      margin-bottom: 2px;
      border: 1px solid var(--cxp-border);
      font-size: var(--cxp-fs-sm);
    }
    .cxp-mcp-name {
      flex: 1;
      min-width: 0;
      color: var(--cxp-text-2);
    }
    .cxp-permission-root-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--cxp-mono);
    }
    .cxp-mcp-status {
      font-size: var(--cxp-fs-xs);
      color: var(--cxp-text-3);
      text-transform: uppercase;
      letter-spacing: 0.3px;
      white-space: nowrap;
    }
    .cxp-mcp-status[data-status="running"] { color: var(--cxp-success); }
    .cxp-mcp-status[data-status="failed"] { color: var(--cxp-danger); }
    .cxp-config-form {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .cxp-config-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 0;
      border-bottom: 1px solid var(--cxp-border);
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-2);
    }
    .cxp-config-row:last-of-type { border-bottom: none; }
    .cxp-config-label {
      flex: 0 0 110px;
      font-size: var(--cxp-fs-xs);
      font-family: var(--cxp-font);
      color: var(--cxp-text-3);
      text-align: right;
    }
    .cxp-config-input {
      flex: 1;
      min-width: 0;
      background: transparent;
      border: 1px solid var(--cxp-border-input);
      border-radius: var(--cxp-radius-sm);
      color: var(--cxp-text);
      font-size: var(--cxp-fs-sm);
      font-family: var(--cxp-font);
      padding: 5px 8px;
      transition: background var(--cxp-dur-fast);
    }
    .cxp-config-input:hover,
    .cxp-config-input:focus {
      background: var(--cxp-surface-1);
    }
    .cxp-config-input::placeholder {
      color: var(--cxp-text-3);
    }
    .cxp-config-checkbox {
      accent-color: var(--cxp-solid);
      width: 13px;
      height: 13px;
      cursor: pointer;
    }
    .cxp-config-save {
      margin-top: 12px;
      align-self: stretch;
      padding: 7px 16px;
    }
    .cxp-config-save:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .cxp-config-layer {
      font-size: var(--cxp-fs-xs);
      color: var(--cxp-text-3);
      margin-left: 4px;
      white-space: nowrap;
    }

    /* ── Session actions ── */
    .cxp-sess-actions {
      display: flex;
      gap: 6px;
      padding: 4px 12px;
      border-bottom: 1px solid var(--cxp-border);
    }
    .cxp-sess-fork, .cxp-sess-archive-current {
      font-size: var(--cxp-fs-xs);
      padding: 2px 8px;
      border-radius: var(--cxp-radius-sm);
      background: transparent;
      border: 1px solid var(--cxp-border-strong);
      color: var(--cxp-text-2);
      cursor: pointer;
    }
    .cxp-sess-fork:hover, .cxp-sess-archive-current:hover {
      background: var(--cxp-surface-2);
      color: var(--cxp-text);
    }

    /* ── Queue tray ── */
    .cxp-queue-tray {
      border-bottom: 1px solid var(--cxp-border);
      padding: 6px 12px;
      max-height: 140px;
      overflow-y: auto;
    }
    .cxp-queue-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .cxp-queue-title {
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-2);
      font-weight: 600;
    }
    .cxp-queue-badge {
      display: inline-block;
      min-width: 16px;
      text-align: center;
      padding: 0 4px;
      border-radius: var(--cxp-radius-pill);
      background: var(--cxp-surface-3);
      color: var(--cxp-text);
      font-size: var(--cxp-fs-xs);
      margin-left: 4px;
    }
    .cxp-queue-actions {
      display: flex;
      gap: 4px;
    }
    .cxp-queue-tray .cxp-btn-sm {
      width: 24px;
      padding: 0;
    }
    .cxp-queue-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 6px;
      border-radius: var(--cxp-radius-sm);
      font-size: var(--cxp-fs-sm);
      color: var(--cxp-text-2);
      background: var(--cxp-surface-1);
      margin-bottom: 2px;
      cursor: grab;
    }
    .cxp-queue-item.dragging { opacity: 0.4; }
    .cxp-queue-item.drag-over { box-shadow: inset 0 2px 0 var(--cxp-text-2); }
    .cxp-queue-item-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-queue-edit, .cxp-queue-remove {
      cursor: pointer;
    }

    /* ── Attachment strips ── */
    .cxp-image-strip {
      display: flex;
      gap: 6px;
      padding: 6px 12px;
      overflow-x: auto;
      flex-wrap: nowrap;
    }
    .cxp-image-strip:empty { display: none; }
    .cxp-image-chip {
      position: relative;
      flex-shrink: 0;
      width: 56px;
      height: 56px;
      border-radius: var(--cxp-radius-sm);
      overflow: hidden;
      border: 1px solid var(--cxp-border);
    }
    .cxp-image-chip img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .cxp-image-chip-remove {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--cxp-pop);
      color: var(--cxp-text);
      border: none;
      font-size: var(--cxp-fs-xs);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .cxp-path-strip {
      display: flex;
      gap: 4px;
      padding: 4px 12px;
      flex-wrap: wrap;
    }
    .cxp-path-strip:empty { display: none; }
    .cxp-path-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      max-width: 100%;
      padding: 2px 8px;
      border-radius: var(--cxp-radius-sm);
      background: var(--cxp-surface-2);
      color: var(--cxp-text-2);
      font-size: var(--cxp-fs-sm);
      font-family: var(--cxp-mono);
      overflow-wrap: anywhere;
    }
    .cxp-path-chip-remove {
      flex-shrink: 0;
      appearance: none;
      border: 0;
      padding: 0;
      background: transparent;
      color: var(--cxp-text-3);
      cursor: pointer;
      font-size: var(--cxp-fs-xs);
    }
    .cxp-path-chip-remove:hover { color: var(--cxp-text); }
    .cxp-path-chip--mention {
      color: var(--cxp-text);
    }

    /* ── Attach and mic buttons ── */
    .cxp-attach-btn {
      background: none;
      border: none;
      color: var(--cxp-text-3);
      cursor: pointer;
      padding: 2px 4px;
      display: flex;
      align-items: center;
      flex-shrink: 0;
      transition: color var(--cxp-dur-fast);
      position: relative;
    }
    .cxp-attach-btn svg,
    .cxp-mic-btn svg {
      width: 13px;
      height: 13px;
    }
    .cxp-attach-btn:hover {
      color: var(--cxp-text);
    }
    .cxp-mic-btn:hover {
      color: var(--cxp-text);
      border-color: var(--cxp-border-strong);
    }
    .cxp-mic-btn.cxp-mic-active {
      color: var(--cxp-warning);
      border-color: var(--cxp-warning);
    }
    .cxp-mic-btn.cxp-mic-active svg {
      animation: cxp-working 1.6s ease-in-out infinite;
    }

    /* ── Slash hints ── */
    .cxp-slash-hints {
      background: var(--cxp-pop);
      border: 1px solid var(--cxp-border);
      border-radius: var(--cxp-radius-md);
      margin: 4px 12px;
      max-height: 160px;
      overflow-y: auto;
    }
    .cxp-slash-hint-item {
      display: flex;
      align-items: baseline;
      min-width: 0;
      padding: 6px 12px;
      font-size: var(--cxp-fs-md);
      color: var(--cxp-text-2);
      cursor: pointer;
    }
    .cxp-slash-hint-item:hover, .cxp-slash-hint-item.active {
      background: var(--cxp-surface-2);
      color: var(--cxp-text);
    }
    .cxp-slash-hint-cmd {
      flex-shrink: 0;
      font-family: var(--cxp-mono);
      font-weight: 500;
      color: var(--cxp-text);
    }
    .cxp-slash-hint-desc {
      min-width: 0;
      margin-left: 8px;
      color: var(--cxp-text-3);
      font-size: var(--cxp-fs-sm);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Drag overlay ── */
    .cxp-drop-overlay {
      position: absolute;
      inset: 0;
      z-index: 10;
      background: var(--cxp-scrim);
      border: 2px dashed var(--cxp-border-input);
      border-radius: var(--cxp-radius-shell);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--cxp-text);
      font-size: var(--cxp-fs-lg);
      pointer-events: none;
    }

    /* Shared readable answers, terminal blocks and unified diffs. */
    .cxp-readable, .cxp-output-source { position: relative; }
    .cxp-output-controls { display: flex; justify-content: flex-end; align-items: baseline; gap: var(--cxp-space-2); }
    .cxp-readable > .cxp-output-controls, .cxp-output-source > .cxp-output-controls {
      position: absolute; top: 6px; right: 6px; z-index: 1; opacity: 0;
      transition: opacity var(--cxp-dur-fast);
    }
    .cxp-readable:hover > .cxp-output-controls, .cxp-output-source:hover > .cxp-output-controls,
    .cxp-readable:focus-within > .cxp-output-controls, .cxp-output-source:focus-within > .cxp-output-controls { opacity: 1; }
    .cxp-readable > .cxp-output-controls .cxp-output-control,
    .cxp-output-source > .cxp-output-controls .cxp-output-control { background: var(--cxp-pop); min-height: 24px; padding: 2px 8px; }
    /* Reserve room above the first line, even when controls wrap at narrow widths. */
    .cxp-readable > .cxp-structured-tree, .cxp-readable > .cxp-output-raw,
    .cxp-output-source > .cxp-output-raw, .cxp-card-pre:has(> .cxp-copy-btn),
    .cxp-msg-body pre:has(> .cxp-copy-btn) { padding-top: calc(var(--cxp-space-4) * 2); }
    .cxp-diff-view > .cxp-output-controls { margin: 0; }
    .cxp-diff-view > .cxp-output-controls > .cxp-card-meta { flex: 1; margin: 0; }
    .cxp-diff-view > .cxp-output-controls > .cxp-output-control { opacity: 0; }
    .cxp-diff-view:hover > .cxp-output-controls > .cxp-output-control,
    .cxp-diff-view:focus-within > .cxp-output-controls > .cxp-output-control { opacity: 1; }
    .cxp-output-note[hidden] { display: none; }
    .cxp-copy-btn:focus-visible { outline: 2px solid var(--cxp-focus); outline-offset: -2px; }
    .cxp-output-control {
      border: 1px solid var(--cxp-border); border-radius: var(--cxp-radius-sm);
      background: transparent; color: var(--cxp-text-2); padding: 4px 8px;
      font: inherit; font-family: var(--cxp-font); font-size: var(--cxp-fs-sm); cursor: pointer;
    }
    .cxp-output-control:hover { border-color: var(--cxp-border-strong); color: var(--cxp-text); }
    .cxp-output-control:focus-visible, .cxp-diff-header:focus-visible {
      outline: 2px solid var(--cxp-focus); outline-offset: -2px;
    }
    .cxp-readable, .cxp-pre-structured { white-space: normal; font-family: var(--cxp-font); font-size: var(--cxp-fs-md); }
    .cxp-structured-entry { margin: var(--cxp-space-2) 0; min-width: 0; }
    .cxp-structured-key { color: var(--cxp-text-3); font-size: var(--cxp-fs-sm); margin-bottom: var(--cxp-space-1); overflow-wrap: anywhere; }
    .cxp-structured-value { color: var(--cxp-text); white-space: pre-wrap; overflow-wrap: anywhere; }
    .cxp-structured-tree { max-height: 640px; overflow: auto; }
    .cxp-structured-entry:has(> .cxp-value-number), .cxp-structured-entry:has(> .cxp-value-boolean), .cxp-structured-entry:has(> .cxp-value-null) { display: flex; gap: var(--cxp-space-2); align-items: baseline; flex-wrap: wrap; }
    .cxp-structured-entry > .cxp-structured-object, .cxp-structured-entry > .cxp-structured-array {
      margin-left: var(--cxp-space-2); padding-left: var(--cxp-space-2); border-left: 1px solid var(--cxp-border);
    }
    .cxp-structured-array { padding-left: var(--cxp-space-4); margin: 0; }
    .cxp-output-more { margin-top: var(--cxp-space-2); }
    .cxp-output-more > summary { width: fit-content; }
    .cxp-output-note { color: var(--cxp-text-3); font: var(--cxp-fs-sm)/1.5 var(--cxp-font); margin: var(--cxp-space-2) 0; }
    .cxp-card-pre, .cxp-msg-body pre, .cxp-card-pre.cxp-card-pre-log, .cxp-card-pre.cxp-card-pre-diff {
      white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; tab-size: 8;
      max-height: 320px; overflow: auto; min-width: 0;
    }
    .cxp-msg-body pre code { white-space: pre-wrap; overflow-wrap: anywhere; }
    .cxp-card-pre.cxp-pre-structured { max-height: none; white-space: normal; }
    .cxp-output-raw { max-height: 320px; }
    .cxp-diff-view { min-width: 0; }
    .cxp-diff-file { border-top: 1px solid var(--cxp-border); }
    .cxp-diff-header { display: flex; flex-wrap: nowrap; align-items: baseline; gap: var(--cxp-space-2); padding: var(--cxp-space-2) 0; cursor: pointer; }
    .cxp-diff-header::before { content: '▸'; color: var(--cxp-text-3); }
    .cxp-diff-file[open] > .cxp-diff-header::before { content: '▾'; }
    .cxp-diff-header::-webkit-details-marker { display: none; }
    .cxp-diff-path { flex: 1; min-width: 0; white-space: nowrap; overflow-x: auto; color: var(--cxp-text); font: var(--cxp-fs-sm)/1.5 var(--cxp-mono); }
    .cxp-diff-status, .cxp-diff-stats { flex-shrink: 0; color: var(--cxp-text-3); font: var(--cxp-fs-sm)/1.5 var(--cxp-font); }
    .cxp-diff-lines { max-height: 480px; overflow-y: auto; overflow-x: hidden; }
    .cxp-diff-line { display: grid; grid-template-columns: 4ch 4ch 2ch minmax(0, 1fr); font: var(--cxp-fs-sm)/1.65 var(--cxp-mono); color: var(--cxp-text-2); }
    .cxp-diff-old, .cxp-diff-new { text-align: right; padding-right: 1ch; color: var(--cxp-text-3); user-select: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .cxp-diff-sign { text-align: center; }
    .cxp-diff-text { white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 8; }
    .cxp-diff-line[data-kind="add"] { background: color-mix(in srgb, var(--cxp-success) 10%, transparent); }
    .cxp-diff-line[data-kind="delete"] { background: color-mix(in srgb, var(--cxp-danger) 10%, transparent); }
    .cxp-diff-line[data-kind="hunk"], .cxp-diff-line[data-kind="note"] { color: var(--cxp-text-3); }
    .cxp-diff-body > .cxp-output-control { margin: var(--cxp-space-2) 0; }

    /* ── Reduced motion: no pulse, no slide, no fades ── */
    @media (prefers-reduced-motion: reduce) {
      .codex-panel,
      .codex-panel *,
      .codex-panel *::before,
      .codex-panel *::after,
      .cxp-session-pill,
      .cxp-session-pill *,
      .cxp-session-pill *::before,
      .cxp-lightbox {
        animation: none !important;
        transition: none !important;
      }
    }
`;
  document.head.appendChild(style);
}
