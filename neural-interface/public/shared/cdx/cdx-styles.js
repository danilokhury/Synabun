// SynaBun — Codex Panel: Styles

export function injectStyles() {
  if (document.getElementById('codex-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'codex-panel-styles';
  style.textContent = `
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
    .cxp-resize-handle {
      position: absolute;
      top: 14px;
      left: 0;
      width: 6px;
      height: calc(100% - 28px);
      cursor: col-resize;
      z-index: 10;
      border-radius: 0 3px 3px 0;
    }
    .cxp-resize-handle:hover,
    .cxp-resize-handle:active {
      background: linear-gradient(180deg, rgba(255,255,255,0.06), transparent 50%, rgba(255,255,255,0.06));
    }
    .cxp-header {
      position: relative;
      padding: 10px 10px 10px 14px;
      border-bottom: none;
      border-radius: 10px;
      margin: 8px 8px 0 8px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      background: rgba(22, 22, 26, 0.95);
      z-index: 3;
      box-shadow: var(--shadow-sm, 0 6px 18px rgba(0,0,0,0.28)), 0 0 0 1px rgba(255,255,255,0.06);
    }
    .cxp-session-btn {
      background: rgba(255,255,255,0.03);
      border: none;
      display: flex;
      align-items: center;
      gap: 5px;
      color: rgba(255,255,255,0.55);
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      cursor: pointer;
      padding: 5px 10px;
      border-radius: 8px 0 0 8px;
      transition: background 0.15s, color 0.15s;
      max-width: 100%;
      overflow: hidden;
      flex-shrink: 1;
      min-width: 0;
    }
    .cxp-session-btn:hover {
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.75);
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
      font-size: 7px;
      color: rgba(255,255,255,0.15);
      flex-shrink: 0;
      pointer-events: none;
      transition: transform 0.2s, color 0.2s;
    }
    .cxp-session-btn .cxp-dd-arrow {
      padding: 4px 6px;
      margin: -4px -6px -4px 0;
      border-radius: 0 6px 6px 0;
    }
    .cxp-session-btn:hover .cxp-dd-arrow {
      color: rgba(255,255,255,0.3);
    }
    .cxp-header-rename {
      display: inline-flex;
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
      flex-shrink: 0;
    }
    .cxp-header-rename:hover:not(:disabled) {
      color: rgba(100,160,255,0.95);
      background: rgba(100,160,255,0.14);
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
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.4);
      cursor: pointer;
      transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .cxp-btn:hover:not(:disabled) {
      background: rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.75);
      transform: scale(1.05);
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
    .cxp-btn#cxp-new:hover:not(:disabled) {
      color: rgba(110,181,255,0.95);
      background: rgba(110,181,255,0.14);
    }
    .cxp-btn-danger:hover:not(:disabled) {
      color: rgba(255,82,82,0.95);
      background: rgba(255,82,82,0.14);
    }
    .cxp-toolbar-sep {
      width: 1px;
      height: 18px;
      background: rgba(255,255,255,0.08);
      margin: 0 2px;
      flex-shrink: 0;
    }
    /* ── Flat pill toggles (matches Claude panel style) ── */
    .cxp-toolbar-toggle {
      background: transparent; border: none;
      color: rgba(255,255,255,0.22); cursor: pointer;
      font-size: 9px; font-family: 'JetBrains Mono', monospace; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.6px;
      padding: 4px 7px 6px;
      transition: color 0.2s, transform 0.2s;
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 3px;
      position: relative;
    }
    /* underline indicator — hidden by default */
    .cxp-toolbar-toggle::after {
      content: '';
      position: absolute; bottom: 0; left: 25%; right: 25%;
      height: 1.5px; border-radius: 1px;
      background: rgba(255,255,255,0.35);
      transform: scaleX(0);
      transition: transform 0.25s cubic-bezier(0.22, 0.68, 0, 1.2), background 0.2s;
    }
    .cxp-toolbar-toggle:hover {
      color: rgba(255,255,255,0.5);
      transform: translateY(-1px);
    }
    .cxp-toolbar-toggle:hover::after {
      transform: scaleX(1);
      background: rgba(255,255,255,0.2);
    }
    .cxp-toolbar-toggle:active {
      transform: translateY(0px) scale(0.96);
      transition-duration: 0.08s;
    }
    .cxp-btn-label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      transition: color 0.25s;
    }

    /* ── Effort toggle — progressive brightness + underline ── */
    .cxp-effort-dots {
      display: flex; gap: 2px; align-items: center; margin-left: 2px;
    }
    .cxp-effort-dots i {
      display: block; width: 3px; height: 3px; border-radius: 50%;
      background: currentColor; opacity: 0.1; font-style: normal;
      transition: opacity 0.3s, background 0.3s, transform 0.3s;
    }
    .cxp-effort-dots i.lit { opacity: 1; transform: scale(1.2); }
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
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      background: rgba(22,22,26,0.99);
      box-shadow: 0 12px 32px rgba(0,0,0,0.34);
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
      border-radius: 5px;
      background: transparent;
      color: rgba(255,255,255,0.7);
      text-align: left;
      cursor: pointer;
    }
    .cxp-effort-menu-item:hover { background: rgba(255,255,255,0.06); }
    .cxp-effort-menu-item.selected {
      background: rgba(59,130,246,0.12);
      color: rgba(255,255,255,0.95);
    }
    .cxp-effort-menu-label { font-size: 11px; font-weight: 600; }
    .cxp-effort-menu-desc {
      min-width: 0;
      font-size: 9px;
      color: rgba(255,255,255,0.38);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #cxp-effort-toggle[data-effort="minimal"] { color: rgba(255,255,255,0.3); }
    #cxp-effort-toggle[data-effort="minimal"]::after { transform: scaleX(0.25); background: rgba(255,255,255,0.16); }
    #cxp-effort-toggle[data-effort="minimal"] .cxp-effort-dots i.lit { background: rgba(255,255,255,0.3); }

    #cxp-effort-toggle[data-effort="low"] { color: rgba(255,255,255,0.35); }
    #cxp-effort-toggle[data-effort="low"]::after { transform: scaleX(0.4); background: rgba(255,255,255,0.2); }
    #cxp-effort-toggle[data-effort="low"] .cxp-effort-dots i.lit { background: rgba(255,255,255,0.35); }

    #cxp-effort-toggle[data-effort="medium"] { color: rgba(255,255,255,0.45); }
    #cxp-effort-toggle[data-effort="medium"]::after { transform: scaleX(0.6); background: rgba(255,255,255,0.3); }
    #cxp-effort-toggle[data-effort="medium"] .cxp-effort-dots i.lit { background: rgba(255,255,255,0.4); }

    #cxp-effort-toggle[data-effort="high"] { color: rgba(255,255,255,0.55); }
    #cxp-effort-toggle[data-effort="high"]::after { transform: scaleX(0.8); background: rgba(255,255,255,0.4); }
    #cxp-effort-toggle[data-effort="high"] .cxp-effort-dots i.lit { background: rgba(255,255,255,0.5); }

    #cxp-effort-toggle[data-effort="xhigh"] { color: rgba(255,255,255,0.7); }
    #cxp-effort-toggle[data-effort="xhigh"]::after { transform: scaleX(1); background: rgba(255,255,255,0.5); }
    #cxp-effort-toggle[data-effort="xhigh"] .cxp-effort-dots i.lit { background: rgba(255,255,255,0.65); }

    /* ── Plan toggle active — blue underline ── */
    #cxp-plan-toggle.active { color: rgba(130, 175, 255, 0.85); }
    #cxp-plan-toggle.active::after { transform: scaleX(1); background: rgba(130, 175, 255, 0.6); }
    #cxp-plan-toggle.active:hover { color: rgba(150, 190, 255, 1); transform: translateY(-1px); }

    /* ── Auto toggle active — green underline ── */
    #cxp-autoaccept-toggle.active { color: rgba(100, 210, 140, 0.85); }
    #cxp-autoaccept-toggle.active::after { transform: scaleX(1); background: rgba(100, 210, 140, 0.6); }
    #cxp-autoaccept-toggle.active:hover { color: rgba(120, 230, 160, 1); transform: translateY(-1px); }

    /* ── Extended context — secondary purple, warning amber on mismatch ── */
    #cxp-context-toggle.active { color: rgba(196, 181, 253, 0.9); }
    #cxp-context-toggle.active::after { transform: scaleX(1); background: rgba(139, 92, 246, 0.75); }
    #cxp-context-toggle.active:hover { color: rgba(221, 214, 254, 1); transform: translateY(-1px); }
    #cxp-context-toggle[data-context-status="mismatch"] { color: rgba(245, 158, 11, 0.95); }
    #cxp-context-toggle[data-context-status="mismatch"]::after { background: rgba(245, 158, 11, 0.8); }
    #cxp-context-toggle:disabled {
      opacity: 0.32;
      cursor: not-allowed;
      transform: none;
    }
    #cxp-context-toggle:disabled::after { transform: scaleX(0); }
    .cxp-cost {
      font-size: 9px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.18);
      padding: 2px 6px;
      flex-shrink: 0;
      white-space: nowrap;
      transition: color 0.2s;
    }
    .cxp-session-menu {
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
      box-shadow: var(--shadow-lg, 0 16px 40px rgba(0,0,0,0.4));
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.06) transparent;
    }
    .cxp-session-menu.open {
      display: block;
    }
    .cxp-session-menu::-webkit-scrollbar {
      width: 3px;
    }
    .cxp-session-menu::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.08);
      border-radius: 3px;
    }
    .cxp-sess-loading,
    .cxp-sess-empty {
      padding: 12px 8px;
      text-align: center;
      font-size: 10px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2);
    }
    .cxp-sess-group {
      font-size: 9px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2);
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
      transition: background 0.12s, color 0.12s;
    }
    .cxp-sess-new {
      padding: 5px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.35);
      border-bottom: 1px solid rgba(255,255,255,0.04);
      margin-bottom: 2px;
    }
    .cxp-sess-new:hover {
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.6);
    }
    .cxp-sess-item {
      position: relative;
      padding: 5px 46px 5px 8px;
      border-radius: 6px;
    }
    .cxp-sess-item:hover {
      background: rgba(255,255,255,0.06);
    }
    .cxp-sess-item.active {
      background: rgba(255,255,255,0.08);
    }
    .cxp-sess-prompt {
      padding-right: 22px;
      font-size: 11px;
      color: rgba(255,255,255,0.5);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.4;
    }
    .cxp-sess-item:hover .cxp-sess-prompt {
      color: rgba(255,255,255,0.8);
    }
    .cxp-sess-item.active .cxp-sess-prompt {
      color: rgba(255,255,255,0.75);
    }
    .cxp-sess-meta {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 9px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2);
      margin-top: 1px;
      padding-right: 8px;
    }
    .cxp-sess-source {
      color: rgba(255,255,255,0.24);
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
      color: rgba(255,255,255,0.15);
      font-size: 10px;
      transition: color 0.15s;
    }
    .cxp-sess-item:hover .cxp-sess-rename {
      display: block;
    }
    .cxp-sess-rename:hover {
      color: rgba(100,160,255,0.7);
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
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(100,160,255,0.3);
      border-radius: 4px;
      color: rgba(255,255,255,0.9);
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      padding: 2px 6px;
      width: 100%;
      outline: none;
    }
    .cxp-rename-input:focus {
      border-color: rgba(100,160,255,0.5);
    }
    .cxp-dna-btn {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 4px;
      color: rgba(255,255,255,0.4);
      font-size: 10px;
      font-family: 'JetBrains Mono', monospace;
      padding: 2px 6px;
      margin-left: 6px;
      cursor: pointer;
      white-space: nowrap;
      transition: color 0.15s, background 0.15s, border-color 0.15s;
    }
    .cxp-dna-btn:hover {
      color: rgba(255,180,80,0.9);
      background: rgba(255,180,80,0.08);
      border-color: rgba(255,180,80,0.3);
    }

    /* ── Name session modal ── */
    .cxp-name-modal-overlay {
      position: absolute; inset: 0;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      z-index: 300; border-radius: 16px;
      animation: cxp-name-fade 0.16s ease-out;
    }
    @keyframes cxp-name-fade { from { opacity: 0; } to { opacity: 1; } }
    .cxp-name-modal {
      background: rgba(24,26,30,0.98);
      border: 0.5px solid rgba(255,255,255,0.12);
      border-radius: 12px; padding: 18px 18px 14px;
      width: calc(100% - 48px); max-width: 380px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.4);
      display: flex; flex-direction: column; gap: 12px;
    }
    .cxp-name-modal-row {
      display: flex; flex-direction: column; gap: 4px;
    }
    .cxp-name-modal-label {
      font-size: 10px; opacity: 0.55;
      color: rgba(255,255,255,0.7);
      text-transform: uppercase; letter-spacing: 0.04em;
      font-family: 'JetBrains Mono', monospace;
    }
    .cxp-name-modal-select {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px; padding: 8px 10px;
      color: rgba(255,255,255,0.92);
      font: inherit; font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      outline: none;
      appearance: none; -webkit-appearance: none;
    }
    .cxp-name-modal-select:focus {
      border-color: rgba(120,180,150,0.45);
      background: rgba(255,255,255,0.08);
    }
    .cxp-name-modal-select:disabled {
      opacity: 0.5; cursor: not-allowed;
    }
    .cxp-name-modal-title {
      color: rgba(255,255,255,0.9); font-size: 13px; font-weight: 500;
    }
    .cxp-name-modal-input {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px; padding: 8px 10px;
      color: rgba(255,255,255,0.92);
      font: inherit; font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      outline: none;
    }
    .cxp-name-modal-input:focus {
      border-color: rgba(120,180,150,0.45);
      background: rgba(255,255,255,0.08);
    }
    .cxp-name-modal-actions {
      display: flex; justify-content: flex-end; gap: 8px;
    }
    .cxp-name-modal-btn {
      padding: 6px 14px; border-radius: 6px;
      font: inherit; font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
      border: 1px solid transparent;
    }
    .cxp-name-modal-btn.skip {
      background: transparent;
      color: rgba(255,255,255,0.5);
      border-color: rgba(255,255,255,0.1);
    }
    .cxp-name-modal-btn.skip:hover {
      color: rgba(255,255,255,0.85);
      background: rgba(255,255,255,0.04);
    }
    .cxp-name-modal-btn.save {
      background: rgba(120,180,150,0.18);
      border-color: rgba(120,180,150,0.35);
      color: rgba(180,230,200,0.95);
    }
    .cxp-name-modal-btn.save:hover {
      background: rgba(120,180,150,0.28);
    }

    /* ── Session menu search & filters ── */
    .cxp-sess-search {
      position: sticky; top: 0; z-index: 2;
      background: rgba(12, 12, 14, 0.98);
      padding: 6px 6px 0; display: flex; flex-direction: column; gap: 4px;
    }
    .cxp-sess-search-row {
      display: flex; align-items: center; gap: 4px;
    }
    .cxp-sess-search-input {
      flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px; color: rgba(255,255,255,0.8); font-size: 10px;
      font-family: 'JetBrains Mono', monospace; padding: 5px 8px 5px 26px;
      outline: none; transition: border-color 0.15s;
    }
    .cxp-sess-search-input::placeholder { color: rgba(255,255,255,0.2); }
    .cxp-sess-search-input:focus { border-color: rgba(100,160,255,0.35); }
    .cxp-sess-search-icon {
      position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
      width: 12px; height: 12px; color: rgba(255,255,255,0.2); pointer-events: none;
    }
    .cxp-sess-search-wrap { position: relative; flex: 1; display: flex; align-items: center; }
    .cxp-sess-refresh-btn {
      background: none; border: none; cursor: pointer; padding: 4px;
      color: rgba(255,255,255,0.2); transition: color 0.15s, transform 0.3s;
      display: flex; align-items: center; justify-content: center;
    }
    .cxp-sess-refresh-btn:hover { color: rgba(255,255,255,0.5); }
    .cxp-sess-refresh-btn.spinning { animation: cxp-sess-spin 0.6s linear; }
    @keyframes cxp-sess-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .cxp-sess-filters {
      display: flex; align-items: center; gap: 4px; padding: 0 2px 4px;
      flex-wrap: wrap;
    }
    .cxp-sess-filter-pill {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px; color: rgba(255,255,255,0.3); font-size: 9px;
      font-family: 'JetBrains Mono', monospace; padding: 2px 6px;
      cursor: pointer; transition: all 0.12s; user-select: none;
      white-space: nowrap;
    }
    .cxp-sess-filter-pill:hover { color: rgba(255,255,255,0.5); border-color: rgba(255,255,255,0.1); }
    .cxp-sess-filter-pill.active {
      background: rgba(100,160,255,0.12); border-color: rgba(100,160,255,0.25);
      color: rgba(100,160,255,0.8);
    }
    .cxp-sess-archive-btn {
      display: none;
      background: none; border: none; cursor: pointer; padding: 2px 4px;
      color: rgba(255,255,255,0.15); font-size: 10px; transition: color 0.15s;
    }
    .cxp-sess-item:hover .cxp-sess-archive-btn { display: block; }
    .cxp-sess-archive-btn:hover { color: rgba(255,180,50,0.7); }
    .cxp-sess-item--archived { opacity: 0.35; }
    .cxp-sess-item--archived .cxp-sess-prompt { font-style: italic; }
    .cxp-sess-unarchive-btn {
      display: none;
      background: none; border: none; cursor: pointer; padding: 2px 4px;
      color: rgba(100,200,120,0.4); font-size: 10px; transition: color 0.15s;
    }
    .cxp-sess-item--archived:hover .cxp-sess-unarchive-btn { display: block; }
    .cxp-sess-unarchive-btn:hover { color: rgba(100,200,120,0.8); }
    .cxp-sess-sentinel {
      display: flex; align-items: center; justify-content: center;
      padding: 8px; min-height: 24px;
    }
    .cxp-sess-sentinel-spinner {
      width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.06);
      border-top-color: rgba(100,160,255,0.4); border-radius: 50%;
      animation: cxp-sess-spin 0.6s linear infinite;
    }
    .cxp-sess-no-more {
      font-size: 9px; color: rgba(255,255,255,0.12);
      font-family: 'JetBrains Mono', monospace;
      text-align: center; padding: 6px;
    }

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
      border-radius: 4px;
      padding: 3px 5px;
      cursor: pointer;
      user-select: none;
      max-width: 180px;
      flex-shrink: 1;
      min-width: 0;
      transition: background 0.15s;
    }
    .cxp-dropdown-sm { max-width: 72px; }
    #cxp-profile { max-width: 80px; }
    .cxp-dropdown:hover {
      background: rgba(255,255,255,0.04);
    }
    .cxp-dropdown.open {
      background: rgba(255,255,255,0.06);
      z-index: 20;
    }
    .cxp-dropdown.has-value .cxp-dd-label {
      color: rgba(255,255,255,0.5);
    }
    .cxp-dd-label {
      font-size: 9.5px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .cxp-dropdown:hover .cxp-dd-arrow {
      color: rgba(255,255,255,0.3);
    }
    .cxp-dropdown.open .cxp-dd-arrow {
      transform: rotate(180deg);
      color: rgba(255,255,255,0.4);
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
      background: rgba(22,22,26,0.98);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 4px;
      z-index: 300;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .cxp-dropdown.open .cxp-dd-menu {
      display: block;
    }
    .cxp-dd-item {
      padding: 6px 10px;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.65);
      border-radius: 5px;
      cursor: pointer;
      overflow: hidden;
      display: flex;
      align-items: center;
      transition: background 0.1s;
    }
    .cxp-dd-item:hover {
      background: rgba(255,255,255,0.07);
    }
    .cxp-dd-item.selected {
      color: rgba(232,224,220,0.95);
      background: rgba(232,224,220,0.08);
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
      font-size: 9px;
      color: rgba(255,255,255,0.35);
    }
    .cxp-statusbar {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      background: rgba(255,255,255,0.02);
      font-size: 11px;
      color: rgba(255,255,255,0.6);
      min-height: 52px;
    }
    .cxp-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: rgba(255,255,255,0.26);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.06);
      flex-shrink: 0;
      margin-top: 5px;
    }
    .cxp-status-copy {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .cxp-status-row,
    .cxp-status-meta-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .cxp-status-meta-row[hidden] {
      display: none;
    }
    .cxp-status-row {
      justify-content: space-between;
    }
    #cxp-status {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: rgba(255,255,255,0.74);
    }
    .cxp-status-elapsed {
      flex-shrink: 0;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.42);
    }
    .cxp-status-step {
      min-width: 0;
      flex: 1;
      font-size: 10px;
      color: rgba(255,255,255,0.42);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cxp-status-badges {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .cxp-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      border-radius: 999px;
      font-size: 9px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      border: 1px solid rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.48);
      background: rgba(255,255,255,0.04);
    }
    .cxp-contextbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      flex-shrink: 0;
      margin: 6px 8px 0;
      background: rgba(22, 22, 26, 0.95);
      border-radius: 10px;
      z-index: 2;
      position: relative;
      box-shadow: var(--shadow-sm, 0 6px 16px rgba(0,0,0,0.18)), 0 0 0 1px rgba(255,255,255,0.06);
    }
    .cxp-account-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 150px;
      height: 22px;
      padding: 2px 7px;
      flex-shrink: 0;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 6px;
      color: rgba(255,255,255,0.55);
      font-size: 10px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .cxp-account-chip:hover {
      color: rgba(115,213,167,0.95);
      background: rgba(115,213,167,0.10);
      border-color: rgba(115,213,167,0.25);
    }
    .cxp-account-chip svg { flex-shrink: 0; opacity: 0.85; }
    .cxp-account-chip .cxp-account-label {
      max-width: 96px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-account-chip .cxp-dd-arrow { font-size: 8px; opacity: 0.6; }
    .cxp-account-menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 8px;
      min-width: 230px;
      max-width: 300px;
      background: rgba(20, 20, 24, 0.98);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45);
      padding: 6px;
      z-index: 50;
      display: none;
      flex-direction: column;
      gap: 2px;
    }
    .cxp-account-menu.open { display: flex; }
    .cxp-account-empty {
      padding: 8px 10px;
      font-size: 11px;
      color: rgba(255,255,255,0.4);
    }
    .cxp-account-row {
      display: flex;
      align-items: stretch;
      gap: 2px;
      border-radius: 7px;
      overflow: hidden;
    }
    .cxp-account-row.active { background: rgba(115,213,167,0.10); }
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
      color: rgba(255,255,255,0.8);
    }
    .cxp-account-row-main:hover { background: rgba(255,255,255,0.05); }
    .cxp-account-check {
      width: 12px;
      flex-shrink: 0;
      color: rgba(115,213,167,0.95);
      font-size: 11px;
    }
    .cxp-account-row-text { display: flex; flex-direction: column; min-width: 0; }
    .cxp-account-row-label {
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-account-row-sub {
      font-size: 10px;
      color: rgba(255,255,255,0.4);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-account-row-remove {
      flex-shrink: 0;
      width: 26px;
      background: transparent;
      border: none;
      color: rgba(255,255,255,0.3);
      cursor: pointer;
      font-size: 11px;
      transition: all 0.15s;
    }
    .cxp-account-row-remove:hover { color: rgba(255,120,120,0.9); background: rgba(255,80,80,0.10); }
    .cxp-account-add {
      margin-top: 4px;
      padding: 8px 10px;
      background: transparent;
      border: 1px dashed rgba(255,255,255,0.14);
      border-radius: 7px;
      color: rgba(115,213,167,0.85);
      font-size: 11px;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }
    .cxp-account-add:hover { background: rgba(115,213,167,0.10); border-color: rgba(115,213,167,0.35); }
    .cxp-gauge {
      flex: 1;
      min-width: 0;
      height: 16px;
      border-radius: 6px;
      background: rgba(255,255,255,0.03);
      position: relative;
      overflow: hidden;
      cursor: default;
    }
    .cxp-ctx-fill {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      border-radius: 6px;
      width: 0%;
      background: rgba(232,224,220,0.18);
      transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1), background 0.5s;
    }
    .cxp-gauge-label {
      position: absolute;
      left: 6px; right: 6px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 9px;
      font-family: 'JetBrains Mono', monospace;
      font-variant-numeric: tabular-nums;
      color: rgba(255,255,255,0.35);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }
    .cxp-compact-btn {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px;
      color: rgba(255,255,255,0.35);
      font-size: 9px;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 2px 8px;
      height: 22px;
      cursor: pointer;
      flex-shrink: 0;
      position: relative;
      overflow: hidden;
      transition: all 0.15s;
    }
    .cxp-compact-btn:hover:not(:disabled) {
      color: rgba(255,255,255,0.65);
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.14);
      transform: scale(1.03);
    }
    .cxp-compact-btn:active:not(:disabled) {
      transform: scale(0.96);
    }
    .cxp-compact-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
    }
    .cxp-compact-btn.compacting {
      color: rgba(140,130,220,0.7);
      border-color: rgba(140,130,220,0.2);
      background: rgba(140,130,220,0.06);
      pointer-events: none;
      opacity: 1;
    }
    .cxp-compact-btn.compacting::after {
      content: '';
      position: absolute;
      left: 0;
      bottom: 0;
      width: 100%;
      height: 2px;
      background: linear-gradient(90deg, transparent, rgba(140,130,220,0.6), transparent);
      animation: cxp-compact-sweep 1.2s ease-in-out infinite;
    }
    @keyframes cxp-compact-sweep {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    .cxp-gauge.compacting {
      opacity: 0.6;
    }
    .cxp-gauge-label.compacting {
      color: rgba(140,130,220,0.4) !important;
    }
    .cxp-status-badge[data-state="ready"] {
      color: rgba(152, 233, 188, 0.94);
      border-color: rgba(115, 213, 167, 0.24);
      background: rgba(115, 213, 167, 0.08);
    }
    .cxp-status-badge[data-state="starting"] {
      color: rgba(149, 209, 255, 0.94);
      border-color: rgba(102, 180, 255, 0.2);
      background: rgba(102, 180, 255, 0.08);
    }
    .cxp-status-badge[data-state="failed"],
    .cxp-status-badge[data-state="cancelled"] {
      color: rgba(255, 160, 160, 0.94);
      border-color: rgba(255, 107, 107, 0.22);
      background: rgba(255, 107, 107, 0.08);
    }
    .cxp-statusbar[data-tone="ready"] .cxp-status-dot {
      background: #73d5a7;
      box-shadow: 0 0 10px rgba(115, 213, 167, 0.55);
    }
    .cxp-statusbar[data-tone="working"] .cxp-status-dot {
      background: #66b4ff;
      box-shadow: 0 0 10px rgba(102, 180, 255, 0.52);
    }
    .cxp-statusbar[data-tone="error"] .cxp-status-dot {
      background: #ff6b6b;
      box-shadow: 0 0 10px rgba(255, 107, 107, 0.5);
    }
    .cxp-messages-container {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      margin: 6px 8px 6px;
      background: rgba(0,0,0,0.16);
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.03);
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.2);
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
      scrollbar-color: rgba(255,255,255,0.2) transparent;
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
      background: rgba(255,255,255,0.2);
      border-radius: 5px;
      min-height: 40px;
    }
    .cxp-messages::-webkit-scrollbar-thumb:hover {
      background: rgba(255,255,255,0.35);
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
      color: rgba(255,255,255,0.4);
    }
    .cxp-empty-logo { display: flex; align-items: center; justify-content: center; }
    .cxp-empty-logo svg { width: 32px; height: 32px; opacity: 0.25; }
    .cxp-empty-name { font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.35); letter-spacing: 0.02em; }
    .cxp-empty-status { font-size: 11px; color: rgba(255,255,255,0.28); line-height: 1.5; min-height: 1em; }
    .cxp-cli-banner {
      flex-shrink: 0;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 10px;
      align-items: center;
      margin: 6px 8px 0;
      padding: 10px 12px;
      border: 1px solid rgba(255,180,80,0.45);
      border-radius: 8px;
      background: rgba(255,180,80,0.08);
      color: rgba(255,235,200,0.92);
      font-size: 11px;
      line-height: 1.4;
      position: relative;
      z-index: 5;
    }
    .cxp-cli-banner-icon {
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%;
      background: rgba(255,180,80,0.25);
      color: rgba(255,210,140,1);
      font-weight: 700;
    }
    .cxp-cli-banner-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .cxp-cli-banner-title {
      font-size: 12px; font-weight: 600;
      color: rgba(255,210,140,0.95);
    }
    .cxp-cli-banner-body {
      font-size: 11px;
      color: rgba(255,255,255,0.7);
      word-break: break-word;
    }
    .cxp-cli-banner-body code {
      padding: 1px 5px;
      background: rgba(0,0,0,0.35);
      border-radius: 3px;
      font-size: 10.5px;
      color: rgba(255,255,255,0.85);
    }
    .cxp-cli-banner-actions { display: flex; gap: 6px; }
    .cxp-cli-banner-link, .cxp-cli-banner-recheck {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 9px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.9);
      text-decoration: none;
      cursor: pointer;
      user-select: none;
      font-family: inherit;
    }
    .cxp-cli-banner-link:hover, .cxp-cli-banner-recheck:hover {
      background: rgba(255,255,255,0.12);
      border-color: rgba(255,255,255,0.4);
    }
    .cxp-cli-banner-recheck:disabled { opacity: 0.5; cursor: default; }
    .codex-panel.cxp-cli-blocked .cxp-send { opacity: 0.4 !important; cursor: not-allowed !important; }
    .codex-panel.cxp-cli-blocked .cxp-input { opacity: 0.7; }
    .cxp-system {
      align-self: center;
      box-sizing: border-box;
      min-width: 0;
      max-width: calc(100% - 32px);
      margin: 6px 16px;
      padding: 7px 12px;
      border-radius: 999px;
      font-size: 11px;
      line-height: 1.45;
      color: rgba(255,255,255,0.62);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .cxp-system.error {
      color: rgba(255, 160, 160, 0.96);
      background: rgba(255, 82, 82, 0.08);
      border-color: rgba(255, 82, 82, 0.18);
    }
    .cxp-system.working {
      color: rgba(149, 209, 255, 0.96);
      background: rgba(87, 157, 255, 0.08);
      border-color: rgba(87, 157, 255, 0.18);
    }
    .cxp-system.success {
      color: rgba(134, 239, 172, 0.96);
      background: rgba(34, 197, 94, 0.08);
      border-color: rgba(34, 197, 94, 0.2);
    }
    .cxp-mcp-startup-notice {
      align-self: stretch;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: none;
      padding: 12px;
      border-radius: 8px;
      white-space: normal;
    }
    .cxp-mcp-startup-title {
      color: currentColor;
      font-size: 11px;
      font-weight: 650;
      letter-spacing: 0.01em;
    }
    .cxp-mcp-startup-error {
      min-width: 0;
      color: rgba(255, 190, 190, 0.84);
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
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
      color: rgba(255,255,255,0.52);
      font-size: 9.5px;
      overflow-wrap: anywhere;
    }
    .cxp-mcp-startup-auth {
      flex: 0 0 auto;
      padding: 5px 10px;
      border: 1px solid rgba(59, 130, 246, 0.38);
      border-radius: 6px;
      background: rgba(59, 130, 246, 0.14);
      color: rgba(219, 234, 254, 0.96);
      font: 600 10px/1.2 Inter, sans-serif;
      cursor: pointer;
    }
    .cxp-mcp-startup-auth:hover:not(:disabled) {
      background: rgba(59, 130, 246, 0.24);
      border-color: rgba(147, 197, 253, 0.55);
    }
    .cxp-mcp-startup-auth:focus-visible {
      outline: 2px solid rgba(147, 197, 253, 0.82);
      outline-offset: 2px;
    }
    .cxp-mcp-startup-auth:disabled {
      cursor: default;
      opacity: 0.62;
    }
    @media (max-width: 390px) {
      .cxp-mcp-startup-actions {
        align-items: stretch;
        flex-direction: column;
      }
      .cxp-mcp-startup-auth { align-self: flex-start; }
    }
    .cxp-msg {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 8px 14px;
      flex-shrink: 0;
    }
    .cxp-msg.cxp-msg-empty {
      display: none;
    }
    .cxp-msg-user {
      justify-content: flex-end;
      padding: 10px 14px 4px;
    }
    .cxp-msg-avatar {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 2px;
      color: rgba(255,255,255,0.52);
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .cxp-msg-user .cxp-msg-avatar {
      display: none;
    }
    .cxp-msg-avatar svg {
      width: 14px;
      height: 14px;
    }
    .cxp-msg-card {
      flex: 1;
      min-width: 0;
      max-width: 100%;
    }
    .cxp-msg-user .cxp-msg-card {
      flex: 0 1 auto;
      max-width: 82%;
      border-radius: 16px 16px 4px 16px;
      border: 1px solid rgba(115, 213, 167, 0.14);
      background: rgba(115, 213, 167, 0.08);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
      overflow: hidden;
    }
    .cxp-msg-assistant .cxp-msg-card {
      background: transparent;
      border: none;
      box-shadow: none;
      overflow: visible;
    }
    .cxp-msg-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 1px 0 5px;
    }
    .cxp-msg-user .cxp-msg-head {
      display: none;
    }
    .cxp-msg-label {
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.38);
    }
    .cxp-msg-phase {
      margin-left: auto;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.5);
      font-size: 10px;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .cxp-msg-assistant[data-phase="commentary"] .cxp-msg-head {
      display: none;
    }
    .cxp-msg-assistant[data-phase="final_answer"] .cxp-msg-phase {
      color: rgba(115, 213, 167, 0.85);
      border-color: rgba(115, 213, 167, 0.24);
      background: rgba(115, 213, 167, 0.08);
    }
    .cxp-status-pill {
      padding: 3px 7px;
      border-radius: 999px;
      font-size: 10px;
      color: rgba(255,255,255,0.62);
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
    }
    .cxp-msg-body {
      padding: 0;
      color: rgba(255,255,255,0.9);
      font-size: 12px;
      line-height: 1.65;
      word-break: break-word;
    }
    .cxp-msg-summary {
      color: rgba(255,255,255,0.82);
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
    }
    .cxp-msg-verbose-fold {
      margin-top: 8px;
    }
    .cxp-msg-verbose-body {
      color: rgba(255,255,255,0.88);
      font-size: 12px;
      line-height: 1.65;
      word-break: break-word;
    }
    .cxp-msg-user .cxp-msg-body {
      padding: 8px 14px;
      color: rgba(219,255,238,0.98);
    }
    .cxp-msg-user-text {
      white-space: pre-wrap;
    }
    .cxp-msg-user-image {
      display: block;
      width: min(220px, 100%);
      max-height: 180px;
      object-fit: cover;
      border-radius: 10px;
      margin-bottom: 8px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(8,18,14,0.45);
    }
    .cxp-msg-user-attachment {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 0 0 8px;
      padding: 5px 9px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(8,18,14,0.42);
      color: rgba(219,255,238,0.82);
      font-size: 11px;
      line-height: 1.2;
    }
    .cxp-msg-body p:first-child,
    .cxp-msg-body ul:first-child,
    .cxp-msg-body ol:first-child,
    .cxp-msg-body pre:first-child {
      margin-top: 0;
    }
    .cxp-msg-body p:last-child,
    .cxp-msg-body ul:last-child,
    .cxp-msg-body ol:last-child,
    .cxp-msg-body pre:last-child {
      margin-bottom: 0;
    }
    .cxp-msg-body p {
      margin: 0 0 0.5em;
    }
    .cxp-msg-body h1,
    .cxp-msg-body h2,
    .cxp-msg-body h3 {
      margin: 0.7em 0 0.25em;
      font-weight: 600;
      color: rgba(255,255,255,0.96);
    }
    .cxp-msg-body h1 {
      font-size: 14px;
    }
    .cxp-msg-body h2 {
      font-size: 13px;
    }
    .cxp-msg-body h3 {
      font-size: 12px;
    }
    .cxp-msg-body code:not(pre code),
    .cxp-card-meta code:not(pre code),
    .cxp-card-body code:not(pre code) {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px;
      padding: 1px 5px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.88em;
      color: rgba(255,255,255,0.96);
    }
    .cxp-msg-body pre,
    .cxp-card-pre {
      margin: 0;
      padding: 10px;
      border-radius: 8px;
      background: rgba(0,0,0,0.24);
      border: 1px solid rgba(255,255,255,0.05);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: rgba(255,255,255,0.8);
      font-size: 11px;
      line-height: 1.55;
    }
    .cxp-card-pre.cxp-card-pre-log,
    .cxp-card-pre.cxp-card-pre-diff {
      white-space: pre;
      word-break: normal;
      overflow-x: auto;
      overflow-y: auto;
      max-height: 320px;
    }
    .cxp-card-pre.cxp-card-pre-diff {
      background:
        linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015)),
        rgba(0,0,0,0.28);
      border-color: rgba(255,255,255,0.08);
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
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-family: inherit;
      color: rgba(255,255,255,0.5);
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s;
      z-index: 1;
    }
    .cxp-msg-body pre:hover .cxp-copy-btn,
    .cxp-card-pre:hover .cxp-copy-btn {
      opacity: 1;
    }
    .cxp-copy-btn:hover {
      background: rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.8);
    }
    .cxp-file-link {
      color: rgba(149, 209, 255, 0.92);
      text-decoration: none;
      border-bottom: 1px dotted rgba(149, 209, 255, 0.3);
      cursor: pointer;
      transition: color 0.15s;
    }
    .cxp-file-link:hover {
      color: rgba(149, 209, 255, 1);
      border-bottom-color: rgba(149, 209, 255, 0.6);
    }
    .cxp-file-link-copied {
      color: rgba(115, 213, 167, 0.95) !important;
      border-bottom-color: rgba(115, 213, 167, 0.4) !important;
    }
    .cxp-think-dots {
      display: inline-flex;
      gap: 3px;
      align-items: center;
      margin-left: auto;
      margin-right: 6px;
    }
    .cxp-think-dots span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: rgba(149, 209, 255, 0.8);
      animation: cxp-think-pulse 1.4s ease-in-out infinite;
    }
    .cxp-think-dots span:nth-child(2) { animation-delay: 0.2s; }
    .cxp-think-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes cxp-think-pulse {
      0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1); }
    }
    .cxp-reasoning.cxp-reasoning-done .cxp-think-dots { display: none; }
    /* ── Inline thinking indicator (messages area) ── */
    .cxp-thinking {
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 10px 14px;
      flex-shrink: 0;
    }
    .cxp-thinking .cxp-think-avatar {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: rgba(255,255,255,0.52);
    }
    .cxp-thinking .cxp-think-avatar svg { width: 16px; height: 16px; }
    .cxp-thinking .cxp-msg-think-dots {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .cxp-thinking .cxp-msg-think-dots span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: rgba(149, 209, 255, 0.8);
      animation: cxp-think-pulse 1.4s ease-in-out infinite;
    }
    .cxp-thinking .cxp-msg-think-dots span:nth-child(2) { animation-delay: 0.2s; }
    .cxp-thinking .cxp-msg-think-dots span:nth-child(3) { animation-delay: 0.4s; }
    .cxp-thinking .cxp-think-title {
      font-size: 11px;
      color: rgba(255,255,255,0.5);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .cxp-thinking .cxp-think-detail {
      font-size: 10px;
      color: rgba(255,255,255,0.25);
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-thinking .cxp-think-timer {
      font-size: 11px;
      color: rgba(255,255,255,0.3);
      min-width: 24px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .cxp-thinking--waiting .cxp-msg-think-dots span {
      background: rgba(255, 191, 71, 0.7);
    }
    .cxp-thinking--waiting .cxp-think-title {
      color: rgba(255, 191, 71, 0.6);
    }
    .cxp-msg-body a,
    .cxp-card-body a {
      color: rgba(206, 228, 255, 0.94);
      text-decoration: none;
    }
    .cxp-msg-body a:hover,
    .cxp-card-body a:hover {
      text-decoration: underline;
    }
    .cxp-msg-body strong,
    .cxp-card-body strong {
      color: rgba(255,255,255,0.97);
    }
    .cxp-msg-body ul,
    .cxp-msg-body ol {
      margin: 0.3em 0;
      padding-left: 1.3em;
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
      top: 0.62em;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: rgba(255,255,255,0.22);
    }
    .cxp-msg-body ol li::marker {
      color: rgba(255,255,255,0.42);
      font-size: 11px;
    }
    .cxp-msg-body blockquote {
      margin: 0.5em 0;
      padding: 4px 0 4px 12px;
      border-left: 2px solid rgba(200, 160, 80, 0.28);
      color: rgba(255,255,255,0.68);
      font-style: italic;
    }
    .cxp-msg-body hr {
      border: none;
      height: 1px;
      margin: 0.8em 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08) 20%, rgba(255,255,255,0.08) 80%, transparent);
    }
    .cxp-msg-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 0.5em 0;
      font-size: 11px;
    }
    .cxp-msg-body th {
      text-align: left;
      padding: 4px 8px;
      font-weight: 600;
      color: rgba(255,255,255,0.95);
      background: rgba(255,255,255,0.04);
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .cxp-msg-body td {
      padding: 3px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.82);
    }
    .cxp-msg-body tr:hover td {
      background: rgba(255,255,255,0.02);
    }
    .cxp-card {
      margin: 4px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.05);
      background: rgba(255,255,255,0.03);
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.015);
      flex-shrink: 0;
    }
    .cxp-card.cxp-card-synabun-tool {
      border-color: rgba(115, 213, 167, 0.15);
      background: rgba(115, 213, 167, 0.025);
    }
    .cxp-card.cxp-card-synabun-tool:hover {
      border-color: rgba(115, 213, 167, 0.25);
    }
    .cxp-card.cxp-collapsed > .cxp-card-body {
      display: none;
    }
    .cxp-card-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 11px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      cursor: pointer;
      user-select: none;
    }
    .cxp-card.cxp-collapsed > .cxp-card-head {
      border-bottom: none;
    }
    .cxp-card.cxp-card-synabun-tool > .cxp-card-head {
      border-bottom-color: rgba(115, 213, 167, 0.08);
    }
    .cxp-card-chevron {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255,255,255,0.3);
      transition: transform 0.2s;
      font-size: 10px;
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
      border-radius: 7px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.74);
      flex-shrink: 0;
    }
    .cxp-card.cxp-card-synabun-tool .cxp-card-icon {
      background: rgba(115, 213, 167, 0.10);
      color: rgba(115, 213, 167, 0.85);
    }
    .cxp-card-icon svg {
      width: 13px;
      height: 13px;
    }
    .cxp-card-titles {
      flex: 1;
      min-width: 0;
    }
    .cxp-card-title {
      font-size: 12px;
      font-weight: 600;
      color: rgba(255,255,255,0.92);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cxp-card-subtitle {
      margin-top: 2px;
      font-size: 11px;
      color: rgba(255,255,255,0.48);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cxp-card.cxp-card-synabun-tool .cxp-card-subtitle {
      color: rgba(115, 213, 167, 0.45);
    }
    .cxp-card.cxp-card-synabun-request {
      border-color: rgba(115, 213, 167, 0.15);
      background: rgba(115, 213, 167, 0.025);
    }
    .cxp-card.cxp-card-synabun-request > .cxp-card-head {
      border-bottom-color: rgba(115, 213, 167, 0.08);
    }
    .cxp-card.cxp-card-synabun-request .cxp-card-icon {
      background: rgba(115, 213, 167, 0.10);
      color: rgba(115, 213, 167, 0.85);
    }
    .cxp-card-body {
      padding: 11px;
      display: flex;
      flex-direction: column;
      gap: 9px;
    }
    .cxp-card-meta {
      font-size: 11px;
      color: rgba(255,255,255,0.54);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .cxp-card-section {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .cxp-card-section[hidden] {
      display: none;
    }
    .cxp-card-section-label {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.34);
    }
    .cxp-fold {
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 10px;
      background: rgba(0,0,0,0.12);
      overflow: hidden;
    }
    .cxp-fold[hidden] {
      display: none;
    }
    .cxp-fold-summary {
      list-style: none;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
      color: rgba(255,255,255,0.76);
      background: rgba(255,255,255,0.02);
    }
    .cxp-fold-summary::marker,
    .cxp-fold-summary::-webkit-details-marker {
      display: none;
      content: '';
    }
    .cxp-fold-label {
      flex: 1;
      min-width: 0;
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.42);
    }
    .cxp-fold > .cxp-fold-summary > .cxp-card-chevron {
      margin-left: auto;
    }
    .cxp-fold:not([open]) > .cxp-fold-summary > .cxp-card-chevron {
      transform: rotate(-90deg);
    }
    .cxp-fold-body {
      padding: 0 10px 10px;
    }
    .cxp-reasoning summary {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 11px;
      color: rgba(255,255,255,0.9);
    }
    .cxp-reasoning summary::marker {
      content: '';
    }
    .cxp-reasoning summary::-webkit-details-marker {
      display: none;
    }
    .cxp-reasoning summary .cxp-card-chevron {
      margin-left: 2px;
    }
    .cxp-reasoning:not([open]) summary .cxp-card-chevron {
      transform: rotate(-90deg);
    }
    .cxp-reasoning summary .cxp-card-titles {
      flex: 1;
      min-width: 0;
    }
    .cxp-reasoning:not(.cxp-reasoning-done) {
      border-color: rgba(149, 209, 255, 0.11);
      background: rgba(149, 209, 255, 0.035);
    }
    .cxp-reasoning.cxp-reasoning-done {
      background: rgba(255,255,255,0.025);
    }
    .cxp-reasoning.cxp-reasoning-done .cxp-status-pill {
      color: rgba(255,255,255,0.45);
      background: rgba(255,255,255,0.035);
    }
    .cxp-reasoning-body {
      padding: 0 11px 11px;
      white-space: pre-wrap;
      word-break: break-word;
      color: rgba(255,255,255,0.78);
      font-size: 11.5px;
      line-height: 1.6;
      max-height: min(360px, 42vh);
      overflow-y: auto;
    }
    .cxp-ask {
      border-color: rgba(115, 213, 167, 0.14);
      background: rgba(115, 213, 167, 0.06);
    }
    .cxp-ask-question-card {
      display: flex;
      flex-direction: column;
      gap: 9px;
      padding: 12px;
      border-radius: 13px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.025);
    }
    .cxp-ask-question {
      font-size: 12px;
      color: rgba(255,255,255,0.88);
      line-height: 1.55;
    }
    .cxp-ask-options {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .cxp-ask-option {
      width: 100%;
      padding: 10px 12px;
      text-align: left;
      border-radius: 11px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.86);
      cursor: pointer;
      transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
    }
    .cxp-ask-option:hover:not(:disabled) {
      border-color: rgba(115, 213, 167, 0.26);
      background: rgba(115, 213, 167, 0.08);
      transform: translateY(-1px);
    }
    .cxp-ask-option.selected {
      border-color: rgba(115, 213, 167, 0.38);
      background: rgba(115, 213, 167, 0.12);
      color: rgba(219,255,238,0.98);
    }
    .cxp-ask-option:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .cxp-ask-option-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
    }
    .cxp-ask-option-desc {
      display: block;
      margin-top: 3px;
      font-size: 11px;
      color: rgba(255,255,255,0.56);
      line-height: 1.45;
    }
    .cxp-ask-input {
      width: 100%;
      padding: 10px 12px;
      border-radius: 11px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.88);
      outline: none;
      font: inherit;
      font-size: 12px;
    }
    .cxp-ask-input:focus {
      border-color: rgba(115, 213, 167, 0.24);
      box-shadow: 0 0 0 2px rgba(115, 213, 167, 0.08);
    }
    .cxp-ask-other {
      display: grid;
      gap: 8px;
      margin-top: 2px;
    }
    .cxp-inline-choices {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 8px 0 4px;
    }
    .cxp-inline-choice {
      width: 100%;
      padding: 9px 12px;
      text-align: left;
      border-radius: 11px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.86);
      cursor: pointer;
      transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
      font: inherit;
      font-size: 12px;
      line-height: 1.45;
    }
    .cxp-inline-choice:hover:not(.chosen) {
      border-color: rgba(115, 213, 167, 0.26);
      background: rgba(115, 213, 167, 0.08);
      transform: translateY(-1px);
    }
    .cxp-inline-choice.chosen {
      border-color: rgba(115, 213, 167, 0.38);
      background: rgba(115, 213, 167, 0.12);
      color: rgba(219,255,238,0.98);
      cursor: default;
    }
    .cxp-inline-choice.dismissed {
      opacity: 0.35;
      cursor: default;
      pointer-events: none;
    }
    .cxp-inline-choices.cxp-inline-choices-synabun {
      margin-top: 2px;
    }
    .cxp-inline-choices.cxp-inline-choices-synabun .cxp-inline-choice {
      border-color: rgba(115, 213, 167, 0.10);
      background: rgba(115, 213, 167, 0.04);
      color: rgba(255, 255, 255, 0.86);
    }
    .cxp-inline-choices.cxp-inline-choices-synabun .cxp-inline-choice:hover:not(.chosen) {
      border-color: rgba(115, 213, 167, 0.22);
      background: rgba(115, 213, 167, 0.08);
    }
    .cxp-inline-choices.cxp-inline-choices-synabun .cxp-inline-choice.chosen {
      border-color: rgba(115, 213, 167, 0.28);
      background: rgba(115, 213, 167, 0.10);
    }
    .cxp-inline-choice-label {
      font-weight: 600;
    }
    .cxp-inline-choice-desc {
      margin-left: 4px;
      color: rgba(255,255,255,0.52);
    }
    .cxp-synabun-inline-card {
      position: relative;
      overflow: hidden;
      display: grid;
      gap: 10px;
      margin: 6px 0 4px;
      padding: 12px;
      border-radius: 14px;
      border: 1px solid rgba(115, 213, 167, 0.15);
      background: rgba(115, 213, 167, 0.025);
    }
    .cxp-synabun-inline-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cxp-synabun-inline-logo {
      width: 24px;
      height: 24px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(115, 213, 167, 0.10);
    }
    .cxp-synabun-inline-logo img {
      width: 15px;
      height: 15px;
      object-fit: contain;
    }
    .cxp-synabun-inline-title {
      font-size: 10px;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: rgba(115, 213, 167, 0.7);
    }
    .cxp-synabun-inline-prompt {
      font-size: 12px;
      line-height: 1.55;
      color: rgba(255, 255, 255, 0.75);
    }
    .cxp-ask-actions,
    .cxp-ask-submit-bar {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .cxp-ask-submit {
      padding: 8px 12px;
      border-radius: 10px;
      border: 1px solid rgba(115, 213, 167, 0.18);
      background: rgba(115, 213, 167, 0.14);
      color: rgba(219,255,238,0.98);
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
    }
    .cxp-ask-submit:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .cxp-request-note {
      font-size: 11px;
      line-height: 1.55;
      color: rgba(255,255,255,0.68);
    }
    .cxp-request-fields {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .cxp-request-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .cxp-request-fieldhead {
      display: flex;
      align-items: baseline;
      gap: 6px;
      flex-wrap: wrap;
    }
    .cxp-request-fieldhead strong {
      font-size: 12px;
      color: rgba(255,255,255,0.92);
    }
    .cxp-request-required {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(255, 188, 128, 0.88);
    }
    .cxp-request-help {
      font-size: 11px;
      line-height: 1.45;
      color: rgba(255,255,255,0.5);
    }
    .cxp-request-input,
    .cxp-request-select,
    .cxp-request-textarea {
      width: 100%;
      padding: 10px 12px;
      border-radius: 11px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.88);
      outline: none;
      font: inherit;
      font-size: 12px;
      box-sizing: border-box;
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
      gap: 8px;
      font-size: 12px;
      color: rgba(255,255,255,0.88);
    }
    .cxp-request-check input {
      margin: 0;
    }
    .cxp-request-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }
    .cxp-request-btn {
      padding: 8px 12px;
      border-radius: 10px;
      border: 1px solid rgba(115, 213, 167, 0.18);
      background: rgba(115, 213, 167, 0.14);
      color: rgba(219,255,238,0.98);
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
    }
    .cxp-request-btn.secondary {
      border-color: rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.78);
    }
    .cxp-request-btn.danger {
      border-color: rgba(255, 107, 107, 0.18);
      background: rgba(255, 107, 107, 0.1);
      color: rgba(255, 190, 190, 0.96);
    }
    .cxp-request-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .cxp-post-plan-card {
      position: relative;
      display: grid;
      gap: 12px;
      overflow: hidden;
      border: 1px solid rgba(148, 163, 184, 0.14);
      background: rgba(15, 17, 24, 0.96);
      border-radius: 10px;
      padding: 14px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.025);
      transition: border-color 150ms ease, opacity 150ms ease;
    }
    .cxp-post-plan-card::before {
      content: '';
      position: absolute;
      inset: 0 auto 0 0;
      width: 2px;
      background: linear-gradient(180deg, #3b82f6 0%, #8b5cf6 58%, rgba(139,92,246,0.12) 100%);
    }
    .cxp-post-plan-card:focus-within {
      border-color: rgba(99, 142, 255, 0.28);
    }
    .cxp-post-plan-card.is-busy {
      opacity: 0.72;
    }
    .cxp-post-plan-card .cxp-request-btn:focus-visible {
      outline: 2px solid rgba(129,140,248,0.72);
      outline-offset: 2px;
    }
    .cxp-post-plan-topline {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .cxp-post-plan-mark {
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(129, 140, 248, 0.2);
      border-radius: 8px;
      color: rgba(196, 181, 253, 0.95);
      background: linear-gradient(135deg, rgba(59,130,246,0.13), rgba(139,92,246,0.13));
    }
    .cxp-post-plan-mark svg {
      width: 14px;
      height: 14px;
    }
    .cxp-post-plan-heading {
      min-width: 0;
      display: grid;
      gap: 3px;
    }
    .cxp-post-compact-card {
      border-color: rgba(115, 213, 167, 0.2);
      background: rgba(13, 23, 21, 0.96);
    }
    .cxp-post-compact-card::before {
      background: rgba(115, 213, 167, 0.72);
    }
    .cxp-post-compact-card .cxp-post-plan-header {
      color: rgba(168, 236, 205, 0.88);
    }
    .cxp-post-plan-header {
      font-size: 10px;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: rgba(147, 197, 253, 0.82);
    }
    .cxp-post-plan-title {
      overflow: hidden;
      color: rgba(248,250,252,0.94);
      font-family: Inter, sans-serif;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-post-plan-note {
      font-size: 11.5px;
      line-height: 1.5;
      color: rgba(226,232,240,0.62);
    }
    .cxp-post-plan-decision {
      display: grid;
    }
    .cxp-post-plan-decision .cxp-request-btn.primary {
      width: 100%;
      min-height: 34px;
      justify-content: center;
      border-color: rgba(96, 132, 255, 0.38);
      background: linear-gradient(105deg, rgba(59,130,246,0.9), rgba(111,82,211,0.9));
      color: #fff;
      box-shadow: 0 1px 0 rgba(255,255,255,0.12) inset;
    }
    .cxp-post-plan-decision .cxp-request-btn.primary:hover:not(:disabled) {
      border-color: rgba(147,197,253,0.5);
      background: linear-gradient(105deg, rgba(65,137,248,0.98), rgba(124,91,225,0.98));
    }
    .cxp-post-plan-divider {
      display: flex;
      align-items: center;
      gap: 8px;
      color: rgba(148,163,184,0.44);
      font: 500 9px/1 'JetBrains Mono', monospace;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .cxp-post-plan-divider::before,
    .cxp-post-plan-divider::after {
      content: '';
      height: 1px;
      flex: 1;
      background: rgba(148,163,184,0.1);
    }
    .cxp-post-plan-feedback-group {
      display: grid;
      gap: 7px;
      padding: 10px;
      border: 1px solid rgba(148,163,184,0.1);
      border-radius: 8px;
      background: rgba(2,6,23,0.24);
    }
    .cxp-post-plan-feedback-label {
      color: rgba(241,245,249,0.82);
      font: 500 11px/1.25 Inter, sans-serif;
    }
    .cxp-post-plan-feedback {
      width: 100%;
      min-height: 56px;
      max-height: 132px;
      box-sizing: border-box;
      resize: none;
      overflow-y: auto;
      border: 1px solid rgba(148,163,184,0.14);
      border-radius: 7px;
      padding: 8px 9px;
      outline: none;
      background: rgba(8,10,16,0.82);
      color: rgba(248,250,252,0.92);
      caret-color: #a78bfa;
      font: 400 11.5px/1.5 Inter, sans-serif;
      transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
    }
    .cxp-post-plan-feedback::placeholder {
      color: rgba(148,163,184,0.42);
    }
    .cxp-post-plan-feedback:hover:not(:disabled) {
      border-color: rgba(148,163,184,0.22);
    }
    .cxp-post-plan-feedback:focus-visible {
      border-color: rgba(129,140,248,0.68);
      box-shadow: 0 0 0 2px rgba(99,102,241,0.14);
      background: rgba(8,10,18,0.96);
    }
    .cxp-post-plan-feedback:disabled {
      opacity: 0.62;
    }
    .cxp-post-plan-feedback-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .cxp-post-plan-feedback-hint {
      min-width: 0;
      color: rgba(148,163,184,0.42);
      font: 400 8.5px/1.25 'JetBrains Mono', monospace;
    }
    .cxp-post-plan-update {
      min-height: 29px;
      flex: 0 0 auto;
      border-color: rgba(139,92,246,0.28) !important;
      background: rgba(139,92,246,0.11) !important;
      color: rgba(221,214,254,0.92) !important;
    }
    .cxp-post-plan-update:hover:not(:disabled) {
      border-color: rgba(167,139,250,0.42) !important;
      background: rgba(139,92,246,0.18) !important;
    }
    .cxp-post-plan-feedback-error {
      color: rgba(252,165,165,0.9);
      font: 400 10px/1.4 Inter, sans-serif;
    }
    .cxp-post-plan-feedback-error[hidden] {
      display: none;
    }
    .cxp-post-plan-utilities {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      padding-top: 2px;
    }
    .cxp-post-plan-utilities .cxp-request-btn {
      min-height: 28px;
      padding: 6px 9px;
      border-color: transparent;
      background: transparent;
      color: rgba(203,213,225,0.58);
    }
    .cxp-post-plan-utilities .cxp-request-btn:hover:not(:disabled) {
      border-color: rgba(148,163,184,0.12);
      background: rgba(148,163,184,0.06);
      color: rgba(241,245,249,0.82);
    }
    .cxp-post-plan-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .cxp-post-plan-actions .cxp-request-btn {
      min-width: 0;
      flex: 1 1 180px;
      justify-content: center;
    }
    .cxp-post-plan-actions .cxp-request-btn.primary {
      background: rgba(130, 175, 255, 0.16);
      border-color: rgba(130, 175, 255, 0.24);
      color: rgba(225, 236, 255, 0.96);
    }
    .cxp-post-plan-actions .cxp-request-btn.primary:hover:not(:disabled) {
      background: rgba(130, 175, 255, 0.24);
      border-color: rgba(130, 175, 255, 0.32);
    }
    @media (max-width: 390px) {
      .cxp-post-plan-card { padding: 12px; }
      .cxp-post-plan-feedback-footer {
        align-items: stretch;
        flex-direction: column;
      }
      .cxp-post-plan-update { width: 100%; justify-content: center; }
      .cxp-post-plan-utilities { justify-content: flex-start; }
      .cxp-post-plan-utilities .cxp-request-btn { flex: 1; justify-content: center; }
    }
    .cxp-request-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: rgba(206, 228, 255, 0.94);
      text-decoration: none;
      word-break: break-all;
    }
    .cxp-request-link:hover {
      text-decoration: underline;
    }
    .cxp-bottom {
      flex-shrink: 0;
      border-top: none;
      border-radius: 10px;
      margin: 0 8px 8px 8px;
      background: rgba(22, 22, 26, 0.95);
      padding-bottom: 4px;
      z-index: 10;
      position: relative;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.06);
    }
    /* Animated border wrapper — conic gradient border on focus (metallic dark green) */
    .cxp-input-wrap {
      flex: 1; position: relative;
      margin: 8px 8px 2px;
      border-radius: 14px;
      padding: 1px;
      background: rgba(255,255,255,0.05);
      transition: background 0.4s;
      min-width: 0; overflow: hidden;
    }
    .cxp-input-wrap::before {
      content: '';
      position: absolute; inset: 0;
      border-radius: 14px;
      padding: 1px;
      pointer-events: none;
      background: conic-gradient(
        from var(--cxp-border-angle, 0deg),
        rgba(16,163,127,0.0) 0%,
        rgba(16,163,127,0.35) 25%,
        rgba(10,110,80,0.10) 50%,
        rgba(16,163,127,0.35) 75%,
        rgba(16,163,127,0.0) 100%
      );
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      opacity: 0;
      transition: opacity 0.4s;
    }
    .cxp-input-wrap:focus-within::before {
      opacity: 1;
      animation: cxp-border-spin 3s linear infinite;
    }
    .cxp-input-wrap:focus-within {
      background: rgba(16,163,127,0.03);
      box-shadow: 0 0 20px rgba(16,163,127,0.04), 0 0 60px rgba(16,163,127,0.015);
    }
    @keyframes cxp-border-spin {
      to { --cxp-border-angle: 360deg; }
    }
    @property --cxp-border-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }
    .cxp-input-shell {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      padding: 5px 5px 5px 14px;
      border-radius: 13px;
      background: rgba(12,12,16,0.9);
      border: none;
    }
    .cxp-input {
      flex: 1;
      min-width: 0;
      resize: none;
      border: none;
      outline: none;
      background: transparent;
      color: rgba(255,255,255,0.9);
      font-family: 'Inter', -apple-system, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      padding: 6px 0;
      max-height: 180px;
      overflow-y: auto;
      overflow-wrap: break-word;
      word-break: break-word;
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
      transition: scrollbar-color 0.3s;
    }
    .cxp-input:hover,
    .cxp-input:focus {
      scrollbar-color: rgba(255,255,255,0.08) transparent;
    }
    .cxp-input::-webkit-scrollbar { width: 4px; }
    .cxp-input::-webkit-scrollbar-track { background: transparent; }
    .cxp-input::-webkit-scrollbar-thumb { background: transparent; border-radius: 4px; }
    .cxp-input:hover::-webkit-scrollbar-thumb,
    .cxp-input:focus::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); }
    .cxp-input::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }
    .cxp-input.scrollable {
      -webkit-mask-image: linear-gradient(to bottom, transparent 0px, black 6px, black calc(100% - 10px), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0px, black 6px, black calc(100% - 10px), transparent 100%);
    }
    .cxp-input::placeholder {
      color: rgba(255,255,255,0.16);
    }
    .cxp-send {
      width: 28px;
      height: 28px;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: rgba(255,255,255,0.15);
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.25s cubic-bezier(0.22, 0.68, 0, 1.2);
      position: sticky;
      bottom: 3px;
      align-self: flex-end;
      overflow: hidden;
    }
    .cxp-send:not(:disabled) {
      color: rgba(219,255,238,0.98);
      border-color: rgba(115, 213, 167, 0.2);
      background: rgba(115, 213, 167, 0.14);
    }
    .cxp-send:hover:not(:disabled) {
      background: rgba(115, 213, 167, 0.24);
      border-color: rgba(115, 213, 167, 0.35);
      box-shadow: 0 0 12px rgba(115, 213, 167, 0.1);
      transform: translateY(-1px);
    }
    .cxp-send:active:not(:disabled) {
      transform: translateY(0px) scale(0.95);
      transition-duration: 0.08s;
    }
    .cxp-send:disabled {
      opacity: 0.4;
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
      border-color: rgba(255,70,70,0.2);
      background: rgba(255,70,70,0.1);
      color: rgba(255,100,100,0.85);
    }
    .cxp-send.cxp-send-stopping:hover:not(:disabled) {
      color: #ff6666;
      border-color: rgba(255,70,70,0.35);
      box-shadow: 0 0 12px rgba(255,70,70,0.12);
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
    .cxp-footer-left {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }
    .cxp-brand {
      height: 16px; width: auto; opacity: 0.92; flex-shrink: 0;
      color: #10a37f;
      filter: drop-shadow(0 0 6px rgba(16, 163, 127, 0.18));
      transition: opacity 0.15s;
    }
    .cxp-brand-link {
      display: inline-flex;
      align-items: center;
      color: inherit;
      text-decoration: none;
      line-height: 0;
      flex-shrink: 0;
    }
    .cxp-brand:hover { opacity: 1; }
    .cxp-bar-action {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      background: none;
      border: none;
      border-radius: 5px;
      color: rgba(255,255,255,0.3);
      cursor: pointer;
      transition: all 0.15s ease;
      padding: 0;
      flex-shrink: 0;
    }
    .cxp-bar-action:hover {
      color: rgba(255,255,255,0.7);
      background: rgba(255,255,255,0.06);
    }
    .cxp-bar-action:active {
      transform: scale(0.9);
      transition-duration: 0.06s;
    }
    .cxp-projectbar-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-left: auto;
    }
    .cxp-footer-right {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    @property --cxp-pill-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }
    .cxp-session-pill {
      position: relative;
      overflow: hidden;
      border-color: rgba(115, 213, 167, 0.14);
      transition: border-color 0.2s;
    }
    .cxp-session-pill::before {
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
    .cxp-session-pill.cxp-pill-running {
      border-color: transparent;
    }
    .cxp-session-pill.cxp-pill-running::before {
      background: conic-gradient(
        from var(--cxp-pill-angle, 0deg),
        rgba(16,163,127,0.0) 0%,
        rgba(16,163,127,0.6) 25%,
        rgba(16,163,127,0.12) 50%,
        rgba(16,163,127,0.6) 75%,
        rgba(16,163,127,0.0) 100%
      );
      animation: cxp-pill-border-spin 2.4s linear infinite;
      opacity: 1;
    }
    @keyframes cxp-pill-border-spin {
      to { --cxp-pill-angle: 360deg; }
    }
    .cxp-session-pill .term-minimized-pill-icon { color: rgba(115, 213, 167, 0.45); transition: color 0.2s; }
    .cxp-session-pill.cxp-pill-running .term-minimized-pill-icon { color: rgba(115, 213, 167, 1); }
    .cxp-session-pill:hover { border-color: rgba(115, 213, 167, 0.28); }
    .cxp-session-pill:hover .term-minimized-pill-icon { color: rgba(115, 213, 167, 0.85); }
    .cxp-session-pill:hover.cxp-pill-running::before {
      background: conic-gradient(
        from var(--cxp-pill-angle, 0deg),
        rgba(16,163,127,0.0) 0%,
        rgba(16,163,127,0.8) 25%,
        rgba(16,163,127,0.20) 50%,
        rgba(16,163,127,0.8) 75%,
        rgba(16,163,127,0.0) 100%
      );
    }
    .cxp-session-pill.cxp-pill-running .term-minimized-pill-label::before {
      content: '';
      display: inline-block;
      width: 8px;
      height: 8px;
      margin-right: 6px;
      border-radius: 999px;
      background: rgba(115, 213, 167, 1);
      box-shadow: 0 0 8px rgba(115, 213, 167, 0.75), 0 0 14px rgba(115, 213, 167, 0.35);
      vertical-align: middle;
      animation: cxp-pill-pulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    .cxp-session-pill.cxp-pill-running::after {
      content: '';
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 2px;
      background: linear-gradient(180deg, rgba(115,213,167,0), rgba(115,213,167,0.95), rgba(115,213,167,0));
      animation: cxp-pill-pulse 1.2s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes cxp-pill-pulse {
      0%, 100% { opacity: 0.45; }
      50% { opacity: 1; }
    }
    .cxp-hint {
      margin-top: 8px;
      font-size: 10px;
      color: rgba(255,255,255,0.34);
      padding: 0 12px;
    }
    /* Phase 8: Dynamic tool textarea */
    .cxp-card-textarea {
      width: 100%;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.87);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 12px;
      resize: vertical;
      margin-top: 4px;
    }
    .cxp-card-textarea:focus {
      outline: none;
      border-color: rgba(200,160,80,0.5);
    }
    /* Phase 8: Terminal interaction input */
    .cxp-terminal-input-wrap {
      display: flex;
      gap: 6px;
      margin-top: 6px;
    }
    .cxp-terminal-input {
      flex: 1;
      background: rgba(0,0,0,0.4);
      border: 1px solid rgba(255,255,255,0.15);
      color: #e0e0e0;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 4px;
    }
    .cxp-terminal-input:focus {
      outline: none;
      border-color: rgba(200,160,80,0.5);
    }
    .cxp-btn-sm {
      padding: 3px 10px;
      font-size: 11px;
    }
    /* Phase 8: Lightbox overlay */
    .cxp-lightbox {
      position: fixed;
      inset: 0;
      z-index: 100000;
      background: rgba(0,0,0,0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: zoom-out;
    }
    .cxp-lightbox img {
      max-width: 90vw;
      max-height: 90vh;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .cxp-image-preview {
      padding: 4px 0;
    }
    /* Phase 6: Settings panel */
    .cxp-settings-btn {
      background: none;
      border: none;
      color: rgba(255,255,255,0.35);
      cursor: pointer;
      padding: 4px;
      display: none;
      align-items: center;
    }
    .cxp-settings-btn:hover { color: rgba(255,255,255,0.65); }
    .cxp-settings-overlay {
      position: absolute;
      inset: 0;
      z-index: 50;
      background: rgba(0,0,0,0.45);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 24px;
      animation: cxp-settings-fadein 0.2s ease;
    }
    @keyframes cxp-settings-fadein {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes cxp-settings-slidein {
      from { opacity: 0; transform: translateY(-8px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .cxp-settings-panel {
      background: rgba(18, 20, 24, 0.95);
      backdrop-filter: blur(40px) saturate(1.3);
      -webkit-backdrop-filter: blur(40px) saturate(1.3);
      border: 0.5px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      width: 92%;
      max-height: calc(100% - 48px);
      overflow-y: auto;
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.3),
        0 4px 8px rgba(0,0,0,0.12),
        0 12px 24px rgba(0,0,0,0.14),
        0 32px 64px rgba(0,0,0,0.18);
      animation: cxp-settings-slidein 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .cxp-settings-panel::-webkit-scrollbar { width: 4px; }
    .cxp-settings-panel::-webkit-scrollbar-track { background: transparent; }
    .cxp-settings-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
    .cxp-settings-header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px 12px;
      background: rgba(18, 20, 24, 0.98);
      border-bottom: 0.5px solid rgba(255,255,255,0.06);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: rgba(255,255,255,0.7);
    }
    .cxp-settings-close {
      background: none;
      border: none;
      color: rgba(255,255,255,0.3);
      font-size: 16px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      transition: color 0.15s, background 0.15s;
    }
    .cxp-settings-close:hover { color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.06); }
    .cxp-settings-body { padding: 8px 14px 14px; }
    .cxp-settings-section {
      margin-bottom: 4px;
      padding: 10px 0;
      border-bottom: 0.5px solid rgba(255,255,255,0.04);
    }
    .cxp-settings-section:last-child { border-bottom: none; margin-bottom: 0; }
    .cxp-settings-section-title {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: rgba(200,160,80,0.55);
      margin-bottom: 8px;
    }
    .cxp-settings-loading {
      font-size: 11px;
      color: rgba(255,255,255,0.3);
      font-family: 'JetBrains Mono', monospace;
    }
    .cxp-settings-value {
      font-size: 11px;
      color: rgba(255,255,255,0.5);
      font-family: 'JetBrains Mono', monospace;
    }
    .cxp-settings-hint {
      font-size: 9.5px;
      color: rgba(255,255,255,0.2);
      font-family: 'JetBrains Mono', monospace;
      margin-top: 4px;
    }
    .cxp-settings-login-btn {
      font-size: 9px;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: rgba(115,213,167,0.7);
      background: rgba(115,213,167,0.06);
      border: 0.5px solid rgba(115,213,167,0.15);
      border-radius: 4px;
      padding: 4px 12px;
      cursor: pointer;
      margin-top: 6px;
      transition: background 0.15s, color 0.15s;
    }
    .cxp-settings-login-btn:hover { background: rgba(115,213,167,0.12); color: rgba(115,213,167,0.9); }
    .cxp-mcp-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      border-radius: 6px;
      margin-bottom: 2px;
      background: rgba(255,255,255,0.02);
      font-size: 11px;
    }
    .cxp-mcp-row:hover { background: rgba(255,255,255,0.04); }
    .cxp-mcp-name {
      flex: 1;
      min-width: 0;
      color: rgba(255,255,255,0.6);
      font-family: 'JetBrains Mono', monospace;
    }
    .cxp-permission-root-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-mcp-status {
      font-size: 9px;
      padding: 2px 7px;
      border-radius: 3px;
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.4);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .cxp-mcp-status[data-status="running"] { color: rgba(115,213,167,0.8); background: rgba(115,213,167,0.08); }
    .cxp-mcp-status[data-status="failed"] { color: rgba(238,102,102,0.8); background: rgba(238,102,102,0.08); }
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
      border-bottom: 0.5px solid rgba(255,255,255,0.03);
    }
    .cxp-config-row:last-of-type { border-bottom: none; }
    .cxp-config-label {
      flex: 0 0 110px;
      font-size: 10px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.4);
      text-align: right;
    }
    .cxp-config-input {
      flex: 1;
      background: rgba(255,255,255,0.03);
      border: 0.5px solid rgba(255,255,255,0.07);
      border-radius: 5px;
      color: rgba(255,255,255,0.8);
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      padding: 5px 8px;
      outline: none;
      transition: border-color 0.15s, background 0.15s;
    }
    .cxp-config-input:hover {
      background: rgba(255,255,255,0.05);
      border-color: rgba(255,255,255,0.1);
    }
    .cxp-config-input:focus {
      border-color: rgba(115,213,167,0.35);
      background: rgba(115,213,167,0.03);
    }
    .cxp-config-input::placeholder {
      color: rgba(255,255,255,0.15);
    }
    .cxp-config-checkbox {
      accent-color: rgba(115,213,167,0.8);
      width: 13px;
      height: 13px;
      cursor: pointer;
    }
    .cxp-config-save {
      margin-top: 12px;
      align-self: stretch;
      padding: 7px 16px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(115,213,167,0.85);
      background: rgba(115,213,167,0.06);
      border: 0.5px solid rgba(115,213,167,0.15);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .cxp-config-save:hover:not(:disabled) {
      background: rgba(115,213,167,0.12);
      border-color: rgba(115,213,167,0.25);
    }
    .cxp-config-save:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .cxp-config-layer {
      font-size: 8px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2);
      margin-left: 4px;
      white-space: nowrap;
      letter-spacing: 0.2px;
    }
    /* Phase 5: Session actions */
    .cxp-sess-actions {
      display: flex;
      gap: 6px;
      padding: 4px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .cxp-sess-fork, .cxp-sess-archive-current {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.6);
      cursor: pointer;
    }
    .cxp-sess-fork:hover, .cxp-sess-archive-current:hover {
      background: rgba(200,160,80,0.15);
      color: rgba(200,160,80,0.9);
    }
    /* Phase 3: Queue tray */
    .cxp-queue-tray {
      border-top: 1px solid rgba(255,255,255,0.06);
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
      font-size: 11px;
      color: rgba(255,255,255,0.5);
      font-weight: 600;
    }
    .cxp-queue-badge {
      display: inline-block;
      min-width: 16px;
      text-align: center;
      padding: 0 4px;
      border-radius: 8px;
      background: rgba(200,160,80,0.25);
      color: rgba(200,160,80,0.9);
      font-size: 10px;
      margin-left: 4px;
    }
    .cxp-queue-actions {
      display: flex;
      gap: 4px;
    }
    .cxp-queue-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 6px;
      border-radius: 4px;
      font-size: 11px;
      color: rgba(255,255,255,0.6);
      background: rgba(255,255,255,0.03);
      margin-bottom: 2px;
      cursor: grab;
    }
    .cxp-queue-item.dragging { opacity: 0.4; }
    .cxp-queue-item.drag-over { border-top: 2px solid rgba(200,160,80,0.6); }
    .cxp-queue-item-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cxp-queue-edit, .cxp-queue-remove {
      opacity: 0.4;
      cursor: pointer;
    }
    .cxp-queue-edit:hover, .cxp-queue-remove:hover { opacity: 0.8; }
    /* Phase 2: Image strip */
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
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.1);
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
      background: rgba(0,0,0,0.7);
      color: #fff;
      border: none;
      font-size: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    /* Phase 2: Path strip */
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
      border-radius: 10px;
      background: rgba(200,160,80,0.15);
      color: rgba(200,160,80,0.9);
      font-size: 11px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      overflow-wrap: anywhere;
    }
    .cxp-path-chip-remove {
      flex-shrink: 0;
      appearance: none;
      border: 0;
      padding: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      opacity: 0.6;
      font-size: 10px;
    }
    .cxp-path-chip-remove:hover { opacity: 1; }
    .cxp-path-chip--mention {
      background: rgba(59,130,246,0.13);
      color: rgba(147,197,253,0.95);
    }
    /* Phase 2: Attach/mic buttons */
    .cxp-attach-btn {
      background: none;
      border: none;
      color: rgba(255,255,255,0.2);
      cursor: pointer;
      padding: 2px 4px;
      display: flex;
      align-items: center;
      flex-shrink: 0;
      transition: color 0.2s, transform 0.25s;
      position: relative;
    }
    .cxp-attach-btn svg {
      width: 13px;
      height: 13px;
    }
    .cxp-attach-btn:hover {
      color: rgba(255,255,255,0.55);
      transform: translateY(-1px);
    }
    .cxp-attach-btn:active {
      transform: translateY(0px) scale(0.92);
    }
    .cxp-mic-btn {
      background: transparent;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      color: rgba(255,255,255,0.25);
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.25s cubic-bezier(0.22, 0.68, 0, 1.2);
      position: sticky;
      bottom: 3px;
      align-self: flex-end;
    }
    .cxp-mic-btn svg {
      width: 13px;
      height: 13px;
    }
    .cxp-mic-btn:hover {
      color: rgba(255,255,255,0.6);
      border-color: rgba(255,255,255,0.15);
      box-shadow: 0 0 8px rgba(255,255,255,0.04);
      transform: translateY(-1px);
    }
    .cxp-mic-btn.cxp-mic-active {
      color: rgba(255,160,60,0.95);
      border-color: rgba(255,140,40,0.35);
      box-shadow: 0 0 12px rgba(255,140,40,0.15);
      animation: cxp-mic-pulse 1.5s ease-in-out infinite;
    }
    .cxp-mic-btn.cxp-mic-active:hover {
      color: #ffaa44;
      border-color: rgba(255,140,40,0.5);
      box-shadow: 0 0 16px rgba(255,140,40,0.2);
    }
    @keyframes cxp-mic-pulse {
      0%, 100% { box-shadow: 0 0 8px rgba(255,140,40,0.1); }
      50% { box-shadow: 0 0 16px rgba(255,140,40,0.25); }
    }
    /* Phase 2: Slash hints */
    .cxp-slash-hints {
      background: rgba(30,30,36,0.95);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      margin: 4px 12px;
      max-height: 160px;
      overflow-y: auto;
    }
    .cxp-slash-hint-item {
      display: flex;
      align-items: baseline;
      min-width: 0;
      padding: 6px 12px;
      font-size: 12px;
      color: rgba(255,255,255,0.7);
      cursor: pointer;
    }
    .cxp-slash-hint-item:hover, .cxp-slash-hint-item.active {
      background: rgba(200,160,80,0.15);
      color: rgba(255,255,255,0.9);
    }
    .cxp-slash-hint-cmd {
      flex-shrink: 0;
      font-weight: 600;
      color: rgba(200,160,80,0.9);
    }
    .cxp-slash-hint-desc {
      min-width: 0;
      margin-left: 8px;
      color: rgba(255,255,255,0.4);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Phase 2: Drag overlay */
    .cxp-drop-overlay {
      position: absolute;
      inset: 0;
      z-index: 10;
      background: rgba(200,160,80,0.1);
      border: 2px dashed rgba(200,160,80,0.5);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(200,160,80,0.8);
      font-size: 14px;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}
