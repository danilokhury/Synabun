// ═══════════════════════════════════════════
// SynaBun — OpenCode Panel: CSS Styles
// All classes use ocp- prefix. Accent: #E8E0DC
// ═══════════════════════════════════════════

export function injectStyles() {
  if (document.getElementById('ocp-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'ocp-panel-styles';
  style.textContent = `
    /* ── Panel shell ── */
    .ocp-panel {
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
      backdrop-filter: blur(60px) saturate(1.45);
      -webkit-backdrop-filter: blur(60px) saturate(1.45);
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
    .ocp-panel.open {
      transform: translateX(0);
      opacity: 1;
      overflow: visible;
    }

    /* ── Resize handle ── */
    .ocp-resize-handle {
      position: absolute;
      top: 14px;
      left: 0;
      width: 6px;
      height: calc(100% - 28px);
      cursor: col-resize;
      z-index: 10;
      border-radius: 0 3px 3px 0;
    }
    .ocp-resize-handle:hover,
    .ocp-resize-handle:active {
      background: linear-gradient(180deg, rgba(232,224,220,0.12), transparent 50%, rgba(232,224,220,0.12));
    }

    /* ── Header ── */
    .ocp-header {
      position: relative;
      padding: 10px 10px 10px 14px;
      border-radius: 10px;
      margin: 8px 8px 0 8px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      background: rgba(22, 22, 26, 0.95);
      z-index: 3;
      box-shadow: 0 6px 18px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.06);
    }
    .ocp-session-btn {
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
    .ocp-session-btn:hover {
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.75);
    }
    .ocp-session-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
      text-align: left;
    }
    .ocp-rename-input {
      width: 100%;
      min-width: 0;
      border: none;
      outline: none;
      background: transparent;
      color: rgba(255,255,255,0.86);
      font: inherit;
      padding: 0;
      margin: 0;
    }
    .ocp-rename-input::placeholder {
      color: rgba(255,255,255,0.3);
    }
    .ocp-dna-btn {
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
    .ocp-dna-btn:hover {
      color: rgba(255,180,80,0.9);
      background: rgba(255,180,80,0.08);
      border-color: rgba(255,180,80,0.3);
    }
    /* ── Name session modal ── */
    .ocp-name-modal-overlay {
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
      animation: ocp-name-fade 0.16s ease-out;
    }
    @keyframes ocp-name-fade { from { opacity: 0; } to { opacity: 1; } }
    .ocp-name-modal {
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
    .ocp-name-modal-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ocp-name-modal-label {
      font-size: 10px;
      opacity: 0.55;
      color: rgba(255,255,255,0.7);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .ocp-name-modal-select {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      padding: 8px 10px;
      color: rgba(255,255,255,0.92);
      font: inherit;
      font-size: 12px;
      outline: none;
      appearance: none;
      -webkit-appearance: none;
    }
    .ocp-name-modal-select:focus {
      border-color: rgba(232,224,220,0.4);
      background: rgba(255,255,255,0.08);
    }
    .ocp-name-modal-select:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .ocp-name-modal-title {
      color: rgba(255,255,255,0.9);
      font-size: 13px;
      font-weight: 500;
    }
    .ocp-name-modal-input {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      padding: 8px 10px;
      color: rgba(255,255,255,0.92);
      font: inherit;
      font-size: 12px;
      outline: none;
    }
    .ocp-name-modal-input:focus {
      border-color: rgba(232,224,220,0.4);
      background: rgba(255,255,255,0.08);
    }
    .ocp-name-modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .ocp-name-modal-btn {
      padding: 6px 14px;
      border-radius: 6px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
      border: 1px solid transparent;
    }
    .ocp-name-modal-btn.skip {
      background: transparent;
      color: rgba(255,255,255,0.5);
      border-color: rgba(255,255,255,0.1);
    }
    .ocp-name-modal-btn.skip:hover {
      color: rgba(255,255,255,0.85);
      background: rgba(255,255,255,0.04);
    }
    .ocp-name-modal-btn.save {
      background: rgba(232,224,220,0.15);
      border-color: rgba(232,224,220,0.3);
      color: rgba(232,224,220,0.95);
    }
    .ocp-name-modal-btn.save:hover {
      background: rgba(232,224,220,0.25);
    }
    .ocp-dd-arrow {
      font-size: 7px;
      color: rgba(255,255,255,0.15);
      flex-shrink: 0;
      pointer-events: none;
      transition: transform 0.2s, color 0.2s;
    }
    .ocp-session-btn:hover .ocp-dd-arrow {
      color: rgba(255,255,255,0.3);
    }
    .ocp-header-rename {
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
    .ocp-header-rename:hover:not(:disabled) {
      color: rgba(232,224,220,0.95);
      background: rgba(232,224,220,0.14);
    }
    .ocp-header-rename:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .ocp-header-rename svg {
      width: 12px; height: 12px;
      stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }

    /* ── Actions row ── */
    .ocp-actions {
      display: flex;
      align-items: center;
      gap: 3px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .ocp-btn {
      width: 24px; height: 24px;
      border: none; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.4);
      cursor: pointer;
      transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .ocp-btn:hover:not(:disabled) {
      background: rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.75);
      transform: scale(1.05);
    }
    .ocp-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .ocp-btn svg {
      width: 12px; height: 12px;
      stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }
    .ocp-btn#ocp-new:hover:not(:disabled) {
      color: rgba(232,224,220,0.95);
      background: rgba(232,224,220,0.14);
    }
    .ocp-btn#ocp-minimize:hover:not(:disabled) {
      color: rgba(255,200,50,0.95);
      background: rgba(255,200,50,0.14);
    }
    .ocp-btn-danger:hover:not(:disabled) {
      color: rgba(255,82,82,0.95) !important;
      background: rgba(255,82,82,0.14) !important;
    }
    .ocp-toolbar-sep {
      width: 1px; height: 18px;
      background: rgba(255,255,255,0.08);
      margin: 0 2px; flex-shrink: 0;
    }

    /* ── Context bar ── */
    .ocp-contextbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      flex-shrink: 0;
      margin: 6px 8px 0;
      background: rgba(22, 22, 26, 0.95);
      border-radius: 10px;
      z-index: 2;
      box-shadow: 0 6px 16px rgba(0,0,0,0.18), 0 0 0 1px rgba(255,255,255,0.06);
    }
    .ocp-ctx-gauge {
      flex: 1;
      min-width: 0;
      height: 16px;
      border-radius: 6px;
      background: rgba(255,255,255,0.03);
      position: relative;
      overflow: hidden;
      cursor: default;
    }
    .ocp-ctx-fill {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      border-radius: 6px;
      width: 0%;
      background: rgba(232,224,220,0.18);
      transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1), background 0.5s;
    }
    .ocp-ctx-label {
      position: absolute;
      left: 6px; right: 6px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 9px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.35);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }
    .ocp-ctx-label[title]:hover::after {
      content: attr(title);
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      background: rgba(22, 22, 26, 0.98);
      color: rgba(255,255,255,0.8);
      font-size: 10px;
      font-family: 'JetBrains Mono', monospace;
      line-height: 1.5;
      padding: 8px 12px;
      border-radius: 8px;
      white-space: pre;
      z-index: 100;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.08);
      pointer-events: none;
      min-width: 220px;
    }
    .ocp-compact-btn {
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
    .ocp-compact-btn:hover:not(:disabled) {
      color: rgba(255,255,255,0.65);
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.14);
      transform: scale(1.03);
    }
    .ocp-compact-btn:active:not(:disabled) { transform: scale(0.96); }
    .ocp-compact-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .ocp-status-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
      transition: background 0.3s;
    }
    .ocp-status-dot.connecting { background: rgba(200, 180, 140, 0.85); animation: ocp-pulse 1.2s infinite; }
    .ocp-status-dot.ready { background: rgba(140, 200, 160, 0.7); }
    .ocp-status-dot.working { background: rgba(140, 180, 220, 0.85); animation: ocp-pulse 1s infinite; }
    .ocp-status-dot.offline { background: rgba(200, 120, 120, 0.7); }
    .ocp-status-dot.error { background: rgba(200, 120, 120, 0.85); }
    .ocp-status-text {
      font-size: 9px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.42);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 170px;
      flex-shrink: 1;
    }
    @keyframes ocp-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .ocp-start-btn {
      background: rgba(232,224,220,0.12);
      border: none; border-radius: 4px;
      color: rgba(232,224,220,0.8);
      font-size: 10px; padding: 2px 8px;
      cursor: pointer; margin-left: 4px;
      font-family: 'JetBrains Mono', monospace;
    }
    .ocp-start-btn:hover {
      background: rgba(232,224,220,0.2);
      color: rgba(232,224,220,1);
    }

    /* ── Session menu ── */
    .ocp-session-menu {
      display: none;
      position: absolute;
      top: calc(100% + 6px); left: 8px; right: 8px;
      background: rgba(22,22,26,0.98);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      z-index: 50;
      max-height: 280px;
      overflow-y: auto;
      padding: 4px;
    }
    .ocp-session-menu.open { display: block; }
    .ocp-session-item {
      display: flex; align-items: center;
      padding: 7px 10px; border-radius: 6px;
      font-size: 11px; color: rgba(255,255,255,0.6);
      cursor: pointer; transition: background 0.12s;
      font-family: 'JetBrains Mono', monospace;
      gap: 6px;
    }
    .ocp-session-item:hover { background: rgba(255,255,255,0.06); }
    .ocp-session-item.active { color: rgba(232,224,220,0.95); background: rgba(232,224,220,0.08); }
    .ocp-session-item-label {
      flex: 1; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .ocp-session-item-delete {
      opacity: 0; width: 16px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      border: none; background: none; color: rgba(255,82,82,0.6);
      cursor: pointer; border-radius: 4px; flex-shrink: 0;
    }
    .ocp-session-item:hover .ocp-session-item-delete { opacity: 1; }
    .ocp-session-item-delete:hover { color: #ff5252; background: rgba(255,82,82,0.12); }
    .ocp-session-item-delete svg { width: 10px; height: 10px; }


    /* ── Tray pills (minimized sessions) ── */
    @property --ocp-pill-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }
    .ocp-session-pill {
      position: relative;
      overflow: hidden;
      border-color: transparent;
    }
    .ocp-session-pill::before {
      content: '';
      position: absolute; inset: 0;
      border-radius: 8px;
      padding: 1px;
      pointer-events: none;
      background: conic-gradient(
        from var(--ocp-pill-angle, 0deg),
        rgba(232,224,220,0.0) 0%,
        rgba(232,224,220,0.30) 25%,
        rgba(232,224,220,0.06) 50%,
        rgba(232,224,220,0.30) 75%,
        rgba(232,224,220,0.0) 100%
      );
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      animation: ocp-pill-border-spin 3s linear infinite;
    }
    @keyframes ocp-pill-border-spin {
      to { --ocp-pill-angle: 360deg; }
    }
    .ocp-session-pill .term-minimized-pill-icon { color: rgba(232, 224, 220, 0.7); }
    .ocp-session-pill:hover { border-color: transparent; }
    .ocp-session-pill:hover::before {
      background: conic-gradient(
        from var(--ocp-pill-angle, 0deg),
        rgba(232,224,220,0.0) 0%,
        rgba(232,224,220,0.45) 25%,
        rgba(232,224,220,0.10) 50%,
        rgba(232,224,220,0.45) 75%,
        rgba(232,224,220,0.0) 100%
      );
    }
    .ocp-session-pill.ocp-pill-running .term-minimized-pill-label::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      margin-right: 6px;
      border-radius: 999px;
      background: rgba(232, 224, 220, 0.95);
      box-shadow: 0 0 10px rgba(232, 224, 220, 0.55);
      vertical-align: middle;
      animation: ocp-pill-pulse 1.5s ease-in-out infinite;
    }
    @keyframes ocp-pill-pulse {
      0%, 100% { opacity: 0.45; }
      50% { opacity: 1; }
    }

    /* ── Messages ── */
    .ocp-messages-container {
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
    .ocp-messages {
      position: absolute;
      inset: 0;
      overflow-y: auto;
      padding: 12px 12px 6px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scroll-behavior: smooth;
    }
    .ocp-messages > * {
      flex-shrink: 0;
    }
    .ocp-messages::-webkit-scrollbar { width: 4px; }
    .ocp-messages::-webkit-scrollbar-track { background: transparent; }
    .ocp-messages::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.08);
      border-radius: 2px;
    }

    /* ── Message bubbles ── */
    .ocp-msg {
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 12.5px;
      line-height: 1.55;
      font-family: 'JetBrains Mono', monospace;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .ocp-msg-user {
      background: rgba(232,224,220,0.08);
      color: rgba(255,255,255,0.85);
      align-self: flex-end;
      max-width: 85%;
      border-bottom-right-radius: 4px;
    }
    .ocp-msg-user-meta {
      margin-top: 6px;
      font-size: 10px;
      color: rgba(255,255,255,0.52);
      letter-spacing: 0.02em;
    }
    .ocp-msg-assistant {
      background: transparent;
      color: rgba(255,255,255,0.86);
      max-width: 100%;
    }
    .ocp-msg-assistant.pending {
      padding: 0;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.015);
    }
    .ocp-msg-assistant p { margin: 0 0 8px; }
    .ocp-msg-assistant p:last-child { margin-bottom: 0; }
    .ocp-msg-assistant h1,
    .ocp-msg-assistant h2,
    .ocp-msg-assistant h3 {
      margin: 0.75em 0 0.3em;
      font-size: 13px;
      line-height: 1.35;
      color: rgba(255,255,255,0.96);
    }
    .ocp-msg-assistant h3 { font-size: 12px; }
    .ocp-msg-assistant ul,
    .ocp-msg-assistant ol {
      margin: 0 0 8px 18px;
      padding: 0;
    }
    .ocp-msg-assistant li + li {
      margin-top: 4px;
    }
    .ocp-msg-assistant blockquote {
      margin: 8px 0;
      padding-left: 10px;
      border-left: 2px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.62);
    }
    .ocp-msg-assistant a {
      color: rgba(151,214,255,0.92);
      text-decoration: none;
    }
    .ocp-msg-assistant a:hover {
      text-decoration: underline;
    }
    .ocp-msg-assistant code {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.06);
      padding: 1px 5px;
      border-radius: 4px;
      font-size: 11.5px;
    }
    .ocp-msg-assistant pre {
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
    .ocp-msg-assistant pre code {
      background: none;
      border: none;
      padding: 0;
      font-size: inherit;
      color: inherit;
    }
    .ocp-copy-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.58);
      font-size: 10px;
      font-family: inherit;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s, background 0.15s, color 0.15s;
    }
    .ocp-msg-assistant pre:hover .ocp-copy-btn,
    .ocp-tool-pre:hover .ocp-copy-btn {
      opacity: 1;
    }
    .ocp-copy-btn:hover {
      background: rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.82);
    }
    .ocp-copy-btn.copied {
      color: rgba(140, 200, 160, 0.85);
      border-color: rgba(140, 200, 160, 0.25);
    }
    .ocp-lang-label {
      position: absolute;
      top: 6px;
      left: 8px;
      font-size: 9px;
      font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.35);
      background: rgba(255,255,255,0.06);
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: lowercase;
      pointer-events: none;
      letter-spacing: 0.3px;
    }
    .ocp-file-link {
      color: rgba(149,209,255,0.85);
      text-decoration: none;
      cursor: pointer;
      border-bottom: 1px dashed rgba(149,209,255,0.4);
      transition: color 0.15s, border-color 0.15s;
    }
    .ocp-file-link:hover {
      color: rgba(149,209,255,1);
      border-bottom-color: rgba(149,209,255,0.7);
    }
    .ocp-file-link.copied {
      color: rgba(140, 200, 160, 0.85);
      border-bottom-color: rgba(140, 200, 160, 0.4);
    }

    /* ── Syntax highlighting token colors ── */
    .ocp-msg-assistant .hljs-keyword,
    .ocp-msg-assistant .hljs-selector-tag,
    .ocp-msg-assistant .hljs-built_in,
    .ocp-msg-assistant .hljs-name,
    .ocp-msg-assistant .hljs-tag { color: #ff7b72; }
    .ocp-msg-assistant .hljs-string,
    .ocp-msg-assistant .hljs-title,
    .ocp-msg-assistant .hljs-section,
    .ocp-msg-assistant .hljs-attribute,
    .ocp-msg-assistant .hljs-literal,
    .ocp-msg-assistant .hljs-template-tag,
    .ocp-msg-assistant .hljs-template-variable,
    .ocp-msg-assistant .hljs-type,
    .ocp-msg-assistant .hljs-addition { color: #a5d6ff; }
    .ocp-msg-assistant .hljs-deletion,
    .ocp-msg-assistant .hljs-selector-attr,
    .ocp-msg-assistant .hljs-selector-pseudo,
    .ocp-msg-assistant .hljs-meta { color: #ffa657; }
    .ocp-msg-assistant .hljs-comment,
    .ocp-msg-assistant .hljs-quote { color: #8b949e; font-style: italic; }
    .ocp-msg-assistant .hljs-number,
    .ocp-msg-assistant .hljs-regexp,
    .ocp-msg-assistant .hljs-symbol,
    .ocp-msg-assistant .hljs-bullet,
    .ocp-msg-assistant .hljs-link { color: #79c0ff; }
    .ocp-msg-assistant .hljs-variable,
    .ocp-msg-assistant .hljs-template-variable { color: #ffa657; }
    .ocp-msg-assistant .hljs-function,
    .ocp-msg-assistant .hljs-title.function_ { color: #d2a8ff; }
    .ocp-msg-assistant .hljs-params { color: rgba(255,255,255,0.7); }
    .ocp-msg-assistant .hljs-subst { color: rgba(255,255,255,0.8); }
    .ocp-msg-assistant .hljs-emphasis { font-style: italic; }
    .ocp-msg-assistant .hljs-strong { font-weight: bold; }
    .ocp-msg-assistant .hljs-link { text-decoration: underline; }

    .ocp-msg-assistant pre { padding-left: 12px; }

    .ocp-msg-error {
      background: rgba(200, 100, 100, 0.05);
      border: 1px solid rgba(200, 100, 100, 0.1);
      color: rgba(220, 140, 140, 0.75);
    }

    /* ── Tool cards ── */
    /* ── Synabun tool card border animation ── */
    @property --ocp-synabun-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }
    @keyframes ocp-synabun-spin {
      to { --ocp-synabun-angle: 360deg; }
    }
    .ocp-tool-card.ocp-tool-synabun {
      position: relative;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      overflow: hidden;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.015);
    }
    .ocp-tool-card.ocp-tool-synabun::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 12px;
      padding: 1px;
      background: conic-gradient(
        from var(--ocp-synabun-angle, 0deg),
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
    .ocp-tool-card.ocp-tool-synabun[data-status="running"]::before {
      opacity: 1;
      animation: ocp-synabun-spin 3s linear infinite;
    }
    .ocp-tool-card.ocp-tool-synabun[data-status="running"] {
      background: rgba(232,224,220,0.02);
      box-shadow: 0 0 20px rgba(232,224,220,0.03), 0 0 60px rgba(232,224,220,0.01), inset 0 1px 0 rgba(255,255,255,0.015);
    }
    .ocp-tool-card:not(.ocp-tool-synabun) {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      overflow: hidden;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.015);
    }
    .ocp-tool-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      cursor: pointer;
      color: rgba(255,255,255,0.56);
      transition: background 0.12s;
    }
    .ocp-tool-header:hover { background: rgba(255,255,255,0.035); }
    .ocp-tool-card.expanded .ocp-tool-header {
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .ocp-tool-icon {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 1px;
    }
    .ocp-tool-icon svg {
      width: 14px;
      height: 14px;
      stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }
    .ocp-tool-titles {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ocp-tool-name {
      color: rgba(245,239,235,0.88);
      font-weight: 600;
      line-height: 1.3;
    }
    .ocp-tool-summary {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: rgba(255,255,255,0.36);
      line-height: 1.35;
    }
    .ocp-tool-pill {
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      color: rgba(255,255,255,0.45);
      font-size: 10px;
      line-height: 1;
      text-transform: lowercase;
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    .ocp-tool-chevron {
      transition: transform 0.2s;
      color: rgba(255,255,255,0.22);
    }
    .ocp-tool-card:not(.expanded) .ocp-tool-chevron { transform: rotate(-90deg); }
    .ocp-tool-card[data-status="running"] .ocp-tool-pill {
      color: rgba(232, 224, 220, 0.75);
      background: rgba(232, 224, 220, 0.06);
      border-color: rgba(232, 224, 220, 0.12);
    }
    .ocp-tool-card[data-status="complete"] .ocp-tool-pill {
      color: rgba(232, 224, 220, 0.5);
      background: rgba(232, 224, 220, 0.03);
      border-color: rgba(232, 224, 220, 0.07);
    }
    .ocp-tool-card[data-status="error"] .ocp-tool-pill {
      color: rgba(220, 140, 140, 0.65);
      background: rgba(220, 100, 100, 0.04);
      border-color: rgba(220, 100, 100, 0.08);
    }
    .ocp-tool-body {
      display: none;
      padding: 0 12px 12px;
      color: rgba(255,255,255,0.62);
      max-height: 280px;
      overflow-y: auto;
    }
    .ocp-tool-card.expanded .ocp-tool-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .ocp-tool-section + .ocp-tool-section {
      margin-top: 10px;
    }
    .ocp-tool-section-label {
      margin-bottom: 6px;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.34);
    }
    .ocp-tool-meta {
      margin-top: 8px;
      font-size: 10.5px;
      color: rgba(255,140,140,0.82);
    }
    .ocp-tool-pre {
      margin: 0;
      padding: 10px;
      border-radius: 8px;
      background: rgba(0,0,0,0.24);
      border: 1px solid rgba(255,255,255,0.05);
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 10.5px;
      line-height: 1.5;
      color: rgba(255,255,255,0.78);
    }
    .ocp-tool-pre.error {
      color: rgba(255,166,166,0.9);
      border-color: rgba(255,82,82,0.18);
      background: rgba(73,14,14,0.26);
    }
    .ocp-tool-pre code {
      background: none;
      border: none;
      padding: 0;
      font-size: inherit;
      color: inherit;
    }

    /* ── Projectbar action buttons ── */
    .ocp-bar-actions { display: flex; align-items: center; gap: 2px; }
    .ocp-bar-btn {
      width: 22px; height: 22px; border: none; border-radius: 5px;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent; color: rgba(255,255,255,0.25);
      cursor: pointer; transition: all 0.15s;
    }
    .ocp-bar-btn:hover:not(:disabled) { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.55); }
    .ocp-bar-btn:disabled { opacity: 0.25; cursor: not-allowed; }
    .ocp-bar-btn svg { width: 11px; height: 11px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

    /* ── Bottom section ── */
    .ocp-bottom {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      border-top: none;
      border-radius: 10px;
      margin: 0 8px 8px 8px;
      background: rgba(22, 22, 26, 0.95);
      padding-bottom: 4px;
      z-index: 2;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.06);
    }

    /* ── Project bar ── */
    .ocp-projectbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px 0;
    }
    .ocp-dropdown-sm { max-width: 72px; }
    .ocp-dropdown {
      position: relative;
      display: flex; align-items: center;
      gap: 2px;
      background: transparent;
      border: none; border-radius: 4px;
      font-size: 9.5px;
      font-family: 'JetBrains Mono', monospace;
      cursor: pointer; user-select: none;
      padding: 3px 5px;
      transition: background 0.15s;
      max-width: 90px;
      flex-shrink: 1; min-width: 0;
    }
    .ocp-dropdown:hover { background: rgba(255,255,255,0.04); }
    .ocp-dropdown.open { background: rgba(255,255,255,0.06); }
    .ocp-dd-label {
      color: rgba(255,255,255,0.3);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1; min-width: 0;
    }
    .ocp-dropdown.has-value .ocp-dd-label { color: rgba(255,255,255,0.5); }
    .ocp-dropdown:hover .ocp-dd-arrow { color: rgba(255,255,255,0.3); }
    .ocp-dropdown.open .ocp-dd-arrow { transform: rotate(180deg); color: rgba(255,255,255,0.4); }
    .ocp-dd-menu {
      display: none;
      position: absolute;
      bottom: calc(100% + 4px); left: auto; right: 0;
      min-width: 200px; max-width: 320px;
      max-height: 260px; overflow-y: auto; overflow-x: hidden;
      background: rgba(22,22,26,0.98);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      z-index: 50; padding: 0 4px 4px;
    }
    .ocp-dd-menu:not(:has(.ocp-model-search)) { padding: 4px; }
    .ocp-dd-menu.open { display: block; }
    .ocp-dd-header {
      position: sticky;
      top: 0;
      z-index: 3;
      background: rgba(22,22,26,0.98);
      border-radius: 8px 8px 0 0;
    }
    .ocp-cap-filter-toggle {
      position: absolute;
      right: 6px; top: 2px;
      width: 22px; height: 26px;
      display: flex; align-items: center; justify-content: center;
      background: none; border: none;
      color: rgba(255,255,255,0.2);
      cursor: pointer; padding: 0;
      border-radius: 4px;
      transition: color 0.15s, background 0.15s;
    }
    .ocp-cap-filter-toggle:hover {
      color: rgba(255,255,255,0.45);
      background: rgba(255,255,255,0.05);
    }
    .ocp-cap-filter-toggle.collapsed { color: rgba(255,255,255,0.12); }
    .ocp-cap-filter-toggle.has-active { color: rgba(96,165,250,0.7); }
    .ocp-cap-filter-bar--hidden { display: none; }
    .ocp-dd-option {
      padding: 6px 10px; border-radius: 5px;
      font-size: 11px; color: rgba(255,255,255,0.65);
      cursor: pointer; overflow: hidden;
      display: flex; align-items: center;
      transition: background 0.1s;
      position: relative;
    }
    .ocp-dd-model-name {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ocp-dd-option:hover { background: rgba(255,255,255,0.07); }
    .ocp-dd-option.selected { color: rgba(232,224,220,0.95); background: rgba(232,224,220,0.08); }
    .ocp-dd-caps {
      display: inline-flex;
      align-items: center;
      padding-left: 6px;
      flex-shrink: 0;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .ocp-dd-option:hover .ocp-dd-caps { opacity: 1; }
    .ocp-dd-option.selected .ocp-dd-caps { opacity: 0.75; }
    .ocp-cap {
      display: inline-block;
      font-size: 8px;
      line-height: 1;
      padding: 2px 4px;
      margin-left: 3px;
      border-radius: 3px;
      font-weight: 600;
      letter-spacing: 0.3px;
      vertical-align: middle;
      white-space: nowrap;
      opacity: 0.85;
    }
    .ocp-cap-filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      padding: 5px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .ocp-cap-filter {
      display: inline-block;
      font-size: 9px;
      line-height: 1;
      padding: 3px 6px;
      border-radius: 3px;
      font-weight: 600;
      letter-spacing: 0.3px;
      cursor: pointer;
      opacity: 0.55;
      transition: opacity 0.15s, box-shadow 0.15s, filter 0.15s;
      user-select: none;
    }
    .ocp-cap-filter:hover { opacity: 0.8; }
    .ocp-cap-filter.active {
      opacity: 1;
      box-shadow: inset 0 0 0 1.5px currentColor;
      filter: brightness(1.5);
    }
    .ocp-dd-group-label {
      padding: 6px 10px 3px;
      font-size: 9px; font-weight: 600;
      color: rgba(255,255,255,0.3);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .ocp-dd-fav-label { color: rgba(251,191,36,0.5) !important; }
    .ocp-dd-star {
      flex-shrink: 0;
      margin-left: 4px;
      background: none; border: none;
      color: rgba(255,255,255,0.15);
      font-size: 9px; line-height: 1;
      cursor: pointer; padding: 0 2px;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s;
    }
    .ocp-dd-option:hover .ocp-dd-star { opacity: 1; }
    .ocp-dd-star.active { color: #fbbf24; opacity: 1; }
    .ocp-dd-star:hover { color: rgba(251,191,36,0.8); opacity: 1; }
    .ocp-dd-sep {
      height: 1px;
      background: rgba(255,255,255,0.06);
      margin: 4px 8px;
    }
    .ocp-model-search {
      width: 100%; box-sizing: border-box;
      padding: 6px 28px 6px 10px;
      background: transparent;
      border: none;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px 8px 0 0;
      color: var(--t-bright, #eee);
      font-size: 11px; font-family: inherit;
      outline: none;
      margin: 0 -4px;
      width: calc(100% + 8px);
    }
    .ocp-model-search::placeholder { opacity: 0.4; }
    .ocp-model-search:focus { background: rgba(28,28,32,0.98); }

    /* ── Input area ── */
    @property --ocp-input-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }
    @keyframes ocp-input-spin {
      to { --ocp-input-angle: 360deg; }
    }
    .ocp-input-wrap {
      position: relative;
      padding: 4px 10px;
    }
    .ocp-image-strip {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding: 0 2px 8px;
    }
    .ocp-image-strip[hidden] { display: none; }
    .ocp-image-strip::-webkit-scrollbar { height: 4px; }
    .ocp-image-strip::-webkit-scrollbar-track { background: transparent; }
    .ocp-image-strip::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.08);
      border-radius: 999px;
    }
    .ocp-image-chip {
      position: relative;
      width: 54px;
      height: 54px;
      flex: 0 0 auto;
      border-radius: 10px;
      overflow: hidden;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .ocp-image-chip img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .ocp-image-chip-remove {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 999px;
      background: rgba(0,0,0,0.58);
      color: rgba(255,255,255,0.92);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
    }
    .ocp-image-chip-remove:hover {
      background: rgba(0,0,0,0.78);
    }
    .ocp-input-shell {
      position: relative;
      display: flex; align-items: flex-end;
      background: rgba(255,255,255,0.04);
      border-radius: 10px;
      padding: 6px 8px;
      transition: background 0.4s;
      overflow: hidden;
    }
    .ocp-input-shell::before {
      content: '';
      position: absolute; inset: 0;
      border-radius: 10px;
      padding: 1px;
      background: conic-gradient(
        from var(--ocp-input-angle),
        rgba(232,224,220,0.0) 0%,
        rgba(232,224,220,0.55) 25%,
        rgba(232,224,220,0.08) 50%,
        rgba(232,224,220,0.55) 75%,
        rgba(232,224,220,0.0) 100%
      );
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      opacity: 0;
      transition: opacity 0.4s;
      pointer-events: none;
    }
    .ocp-input-shell:focus-within::before {
      opacity: 1;
      animation: ocp-input-spin 3s linear infinite;
    }
    .ocp-input-shell:focus-within {
      background: rgba(232,224,220,0.03);
      box-shadow: 0 0 20px rgba(232,224,220,0.04), 0 0 60px rgba(232,224,220,0.015);
    }
    .ocp-input {
      flex: 1;
      background: none; border: none; outline: none;
      color: rgba(255,255,255,0.85);
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      resize: none;
      max-height: 120px;
      line-height: 1.5;
      padding: 2px 4px;
    }
    .ocp-input::placeholder { color: rgba(255,255,255,0.2); }
    .ocp-attach {
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: rgba(255,255,255,0.3);
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.18s;
    }
    .ocp-attach:hover {
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.62);
    }
    .ocp-attach svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .ocp-send {
      width: 28px; height: 28px;
      border: none; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(232,224,220,0.1);
      color: rgba(232,224,220,0.6);
      cursor: pointer; flex-shrink: 0;
      transition: all 0.18s;
    }
    .ocp-send:hover:not(:disabled) {
      background: rgba(232,224,220,0.18);
      color: rgba(232,224,220,0.95);
    }
    .ocp-send:disabled { opacity: 0.3; cursor: not-allowed; }
    .ocp-send svg {
      width: 14px; height: 14px;
      stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }
    .ocp-send .ocp-stop-icon { display: none; }
    .ocp-send.running .ocp-send-icon { display: none; }
    .ocp-send.running .ocp-stop-icon { display: block; }
    .ocp-send.running {
      background: rgba(230, 140, 80, 0.18);
      color: #f5a365;
      animation: ocp-send-stop-pulse 1.8s ease-out infinite;
    }
    .ocp-send.running:hover:not(:disabled) {
      background: rgba(230, 140, 80, 0.34);
      color: #ffd1a8;
    }
    @keyframes ocp-send-stop-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(245, 163, 101, 0.38); }
      70%  { box-shadow: 0 0 0 9px rgba(245, 163, 101, 0); }
      100% { box-shadow: 0 0 0 0 rgba(245, 163, 101, 0); }
    }

    /* ── Slash command hints ── */
    .ocp-slash-hints {
      position: absolute;
      bottom: calc(100% + 4px);
      left: 0; right: 0;
      background: rgba(20,16,14,0.96);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      max-height: 200px;
      overflow-y: auto;
      z-index: 100;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .ocp-slash-hints.open { display: block; }
    .ocp-slash-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .ocp-slash-item:hover, .ocp-slash-item.active {
      background: rgba(255,255,255,0.06);
    }
    .ocp-slash-name {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: rgba(232,224,220,0.9);
      font-weight: 500;
    }
    .ocp-slash-desc {
      font-size: 11px;
      color: rgba(255,255,255,0.35);
      margin-left: auto;
    }

    /* ── Footer toolbar ── */
    .ocp-footer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: nowrap;
      gap: 0;
      padding: 4px 10px 2px;
      flex-shrink: 0;
    }
    .ocp-footer-left {
      display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;
    }
    .ocp-footer-right {
      display: flex; align-items: center; gap: 2px; flex-shrink: 0;
    }
    .ocp-mode-toggle {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border-radius: 999px;
      background: rgba(255,255,255,0.035);
      border: 1px solid rgba(255,255,255,0.05);
    }
    .ocp-mode-btn {
      border: none;
      background: transparent;
      color: rgba(255,255,255,0.34);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.02em;
      font-family: 'JetBrains Mono', monospace;
      padding: 4px 8px;
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, opacity 0.15s;
    }
    .ocp-mode-btn:hover:not(:disabled) {
      color: rgba(255,255,255,0.72);
      background: rgba(255,255,255,0.06);
    }
    .ocp-mode-btn.active {
      color: rgba(20,18,18,0.92);
      background: rgba(232,224,220,0.92);
    }
    .ocp-mode-btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    #ocp-model-dd {
      min-width: 120px;
      max-width: 180px;
    }
    .ocp-brand-link {
      display: inline-flex; align-items: center;
      color: inherit; text-decoration: none;
      opacity: 0.3; transition: opacity 0.15s;
    }
    .ocp-brand-link:hover { opacity: 0.7; }
    .ocp-brand {
      width: 14px; height: 14px;
    }
    .ocp-token-counter {
      font-size: 9px;
      color: rgba(255,255,255,0.2);
      font-family: 'JetBrains Mono', monospace;
      white-space: nowrap;
    }

    /* ── Thinking blocks ── */
    .ocp-think-block {
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 8px;
      margin: 4px 0;
      overflow: hidden;
      background: rgba(255,255,255,0.03);
      transition: border-color 0.2s;
    }
    .ocp-think-block:hover { border-color: rgba(255,255,255,0.12); }
    .ocp-think-block summary {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 10px; cursor: pointer; user-select: none;
      list-style: none; transition: background 0.15s;
    }
    .ocp-think-block summary::-webkit-details-marker { display: none; }
    .ocp-think-block summary:hover { background: rgba(255,255,255,0.04); }
    .ocp-think-icon {
      width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
      color: rgba(232,224,220,0.8); background: rgba(232,224,220,0.08); border-radius: 5px;
      flex-shrink: 0;
    }
    .ocp-think-icon svg { width: 10px; height: 10px; }
    .ocp-think-label {
      font-family: 'JetBrains Mono', monospace; color: rgba(232,224,220,0.7);
      font-weight: 600; font-size: 10.5px;
    }
    .ocp-think-chevron {
      color: rgba(255,255,255,0.2); font-size: 14px; transition: transform 0.2s; margin-left: auto;
    }
    .ocp-think-block[open] .ocp-think-chevron { transform: rotate(90deg); color: rgba(255,255,255,0.4); }
    .ocp-think-content {
      display: none; border-top: 1px solid rgba(255,255,255,0.06);
      padding: 6px 10px 8px; font-family: 'JetBrains Mono', monospace;
      font-size: 10px; color: rgba(255,255,255,0.4); white-space: pre-wrap;
      word-break: break-word; max-height: 300px; overflow-y: auto;
      line-height: 1.55; background: none;
    }
    .ocp-think-block[open] .ocp-think-content { display: block; }
    .ocp-think-content::-webkit-scrollbar { width: 2px; }
    .ocp-think-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

    /* ── Empty state ── */
    .ocp-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: rgba(255,255,255,0.15);
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      gap: 8px;
      padding: 40px 20px;
      text-align: center;
    }
    .ocp-empty svg {
      width: 32px; height: 32px;
      stroke: currentColor; fill: none;
      stroke-width: 1; opacity: 0.3;
    }
    .ocp-cli-banner {
      flex-shrink: 0;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 10px;
      align-items: center;
      margin: 8px 12px 0;
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
    .ocp-cli-banner-icon {
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%;
      background: rgba(255,180,80,0.25);
      color: rgba(255,210,140,1);
      font-weight: 700;
    }
    .ocp-cli-banner-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .ocp-cli-banner-title {
      font-size: 12px; font-weight: 600;
      color: rgba(255,210,140,0.95);
    }
    .ocp-cli-banner-body {
      font-size: 11px;
      color: rgba(255,255,255,0.7);
      word-break: break-word;
    }
    .ocp-cli-banner-body code {
      padding: 1px 5px;
      background: rgba(0,0,0,0.35);
      border-radius: 3px;
      font-size: 10.5px;
      color: rgba(255,255,255,0.85);
    }
    .ocp-cli-banner-actions { display: flex; gap: 6px; }
    .ocp-cli-banner-link, .ocp-cli-banner-recheck {
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
    .ocp-cli-banner-link:hover, .ocp-cli-banner-recheck:hover {
      background: rgba(255,255,255,0.12);
      border-color: rgba(255,255,255,0.4);
    }
    .ocp-cli-banner-recheck:disabled { opacity: 0.5; cursor: default; }
    .ocp-panel.ocp-cli-blocked .ocp-input { opacity: 0.7; }

    /* ── Thinking indicator ── */
    .ocp-thinking {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      color: rgba(232,224,220,0.4);
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
    }
    .ocp-thinking-avatar {
      width: 22px;
      height: 22px;
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: rgba(232,224,220,0.62);
      background: rgba(255,255,255,0.04);
      flex-shrink: 0;
    }
    .ocp-thinking-avatar svg {
      width: 12px;
      height: 15px;
    }
    .ocp-thinking-title {
      color: rgba(255,255,255,0.56);
      flex-shrink: 0;
    }
    .ocp-thinking-detail {
      color: rgba(255,255,255,0.28);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
    }
    .ocp-thinking-timer {
      color: rgba(255,255,255,0.3);
      min-width: 24px;
      text-align: right;
      flex-shrink: 0;
    }
    .ocp-thinking-dots span {
      display: inline-block;
      width: 4px; height: 4px;
      background: rgba(232, 224, 220, 0.5);
      border-radius: 50%;
      animation: ocp-pulse 1.4s infinite;
    }
    .ocp-thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .ocp-thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
    .ocp-thinking-waiting .ocp-thinking-dots span {
      background: rgba(232, 224, 220, 0.7);
    }
    .ocp-thinking-waiting .ocp-thinking-title {
      color: rgba(232, 224, 220, 0.6);
    }

    /* ── Question cards (AskUserQuestion) ── */
    .ocp-question-card {
      background: rgba(232,224,220,0.04);
      border: 1px solid rgba(232,224,220,0.14);
      border-radius: 10px;
      margin: 6px 0;
      overflow: hidden;
    }
    .ocp-question-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(232,224,220,0.08);
    }
    .ocp-question-icon {
      width: 16px; height: 16px;
      color: rgba(232,224,220,0.7);
      flex-shrink: 0;
    }
    .ocp-question-title {
      font-size: 11px;
      font-weight: 600;
      color: rgba(232,224,220,0.85);
      letter-spacing: 0.3px;
    }
    .ocp-question-body {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .ocp-question-intro {
      font-size: 11px;
      line-height: 1.5;
      color: rgba(255,255,255,0.5);
      margin-bottom: 2px;
    }
    .ocp-question-block {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
    }
    .ocp-question-block + .ocp-question-block {
      margin-top: 2px;
    }
    .ocp-question-header-chip {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      color: rgba(232,224,220,0.75);
      background: rgba(232,224,220,0.1);
      padding: 2px 8px;
      border-radius: 4px;
      letter-spacing: 0.3px;
      align-self: flex-start;
    }
    .ocp-question-text {
      font-size: 12px;
      line-height: 1.5;
      color: rgba(255,255,255,0.82);
    }
    .ocp-question-multi-hint {
      font-size: 10px;
      color: rgba(232,224,220,0.45);
      font-style: italic;
    }
    .ocp-question-options {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ocp-question-option {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 10px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 7px;
      cursor: pointer;
      transition: all 0.15s;
      text-align: left;
      font-family: inherit;
      font-size: 12px;
      color: rgba(255,255,255,0.72);
      line-height: 1.4;
    }
    .ocp-question-option:hover {
      background: rgba(232,224,220,0.08);
      border-color: rgba(232,224,220,0.2);
      color: rgba(255,255,255,0.9);
    }
    .ocp-question-option.selected {
      background: rgba(232,224,220,0.1);
      border-color: rgba(232,224,220,0.35);
      color: rgba(232,224,220,0.95);
    }
    .ocp-question-option-radio {
      width: 14px; height: 14px;
      border: 1.5px solid rgba(255,255,255,0.2);
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 1px;
      position: relative;
      transition: all 0.15s;
    }
    /* Multi-select: square checkbox instead of circle */
    .ocp-question-option.multi .ocp-question-option-radio {
      border-radius: 3px;
    }
    .ocp-question-option.selected .ocp-question-option-radio {
      border-color: rgba(232,224,220,0.7);
    }
    .ocp-question-option.selected .ocp-question-option-radio::after {
      content: '';
      position: absolute;
      top: 3px; left: 3px;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: rgba(232,224,220,0.85);
    }
    .ocp-question-option.multi.selected .ocp-question-option-radio::after {
      border-radius: 1px;
    }
    .ocp-question-option-label {
      font-weight: 500;
      color: inherit;
    }
    .ocp-question-option-desc {
      font-size: 11px;
      color: rgba(255,255,255,0.4);
      margin-top: 2px;
    }
    .ocp-question-option.selected .ocp-question-option-desc {
      color: rgba(232,224,220,0.55);
    }
    .ocp-question-other {
      margin-top: 4px;
    }
    .ocp-question-other-input {
      width: 100%;
      padding: 7px 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      color: rgba(255,255,255,0.85);
      font-family: inherit;
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s;
      box-sizing: border-box;
    }
    .ocp-question-other-input:focus {
      border-color: rgba(232,224,220,0.35);
    }
    .ocp-question-other-input::placeholder {
      color: rgba(255,255,255,0.3);
    }
    .ocp-question-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      padding-top: 4px;
    }
    .ocp-question-submit {
      padding: 6px 16px;
      border: none;
      border-radius: 6px;
      background: rgba(232,224,220,0.14);
      color: rgba(232,224,220,0.8);
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      letter-spacing: 0.3px;
    }
    .ocp-question-submit:hover:not(:disabled) {
      background: rgba(232,224,220,0.22);
      color: rgba(232,224,220,1);
    }
    .ocp-question-submit:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .ocp-question-card.locked {
      opacity: 0.55;
      pointer-events: none;
    }
    .ocp-question-card.locked .ocp-question-option.selected {
      background: rgba(232,224,220,0.06);
    }

    /* ── Permission card ── */
    .ocp-permission-card {
      position: relative;
      margin: 8px 0;
      padding: 0;
      background: rgba(28,28,30,0.55);
      border: 1px solid rgba(232,224,220,0.1);
      border-left: 2px solid rgba(234,179,8,0.55);
      border-radius: 8px;
      overflow: hidden;
    }
    .ocp-permission-card[data-locked="1"] {
      opacity: 0.55;
      pointer-events: none;
      border-left-color: rgba(232,224,220,0.2);
    }
    .ocp-permission-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px 8px;
    }
    .ocp-permission-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px; height: 22px;
      border-radius: 5px;
      background: rgba(234,179,8,0.1);
      color: rgba(234,179,8,0.9);
      flex-shrink: 0;
    }
    .ocp-permission-icon svg {
      width: 13px; height: 13px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .ocp-permission-head-text {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .ocp-permission-kind {
      font-size: 12px;
      font-weight: 600;
      color: rgba(232,224,220,0.92);
      letter-spacing: 0.1px;
    }
    .ocp-permission-action {
      font-size: 10.5px;
      color: rgba(232,224,220,0.45);
      letter-spacing: 0.2px;
    }
    .ocp-permission-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 4px 12px 12px;
    }
    .ocp-permission-target code {
      display: block;
      padding: 8px 10px;
      background: rgba(0,0,0,0.35);
      border: 1px solid rgba(232,224,220,0.06);
      border-radius: 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      line-height: 1.45;
      color: rgba(232,224,220,0.88);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 120px;
      overflow-y: auto;
    }
    .ocp-permission-patterns {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      font-size: 10px;
      color: rgba(232,224,220,0.45);
    }
    .ocp-permission-patterns-label {
      text-transform: uppercase;
      letter-spacing: 0.6px;
      font-weight: 600;
    }
    .ocp-permission-patterns code {
      padding: 1px 6px;
      background: rgba(232,224,220,0.06);
      border-radius: 3px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px;
      color: rgba(232,224,220,0.75);
    }
    .ocp-permission-diff summary {
      cursor: pointer;
      font-size: 10.5px;
      color: rgba(232,224,220,0.55);
      padding: 2px 0;
      user-select: none;
    }
    .ocp-permission-diff summary:hover {
      color: rgba(232,224,220,0.8);
    }
    .ocp-permission-diff pre {
      margin: 6px 0 0;
      padding: 8px 10px;
      background: rgba(0,0,0,0.35);
      border: 1px solid rgba(232,224,220,0.06);
      border-radius: 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      line-height: 1.45;
      color: rgba(232,224,220,0.82);
      max-height: 240px;
      overflow: auto;
      white-space: pre;
    }
    .ocp-permission-actions {
      display: flex;
      gap: 6px;
      padding-top: 2px;
    }
    .ocp-permission-btn {
      flex: 1 1 auto;
      padding: 7px 10px;
      border: 1px solid rgba(232,224,220,0.12);
      background: rgba(232,224,220,0.04);
      color: rgba(232,224,220,0.78);
      border-radius: 5px;
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
    }
    .ocp-permission-btn:hover:not(:disabled) {
      background: rgba(232,224,220,0.1);
      color: rgba(232,224,220,0.95);
      border-color: rgba(232,224,220,0.2);
    }
    .ocp-permission-allow {
      border-color: rgba(34,197,94,0.25);
      color: rgba(134,239,172,0.9);
      background: rgba(34,197,94,0.06);
    }
    .ocp-permission-allow:hover:not(:disabled) {
      background: rgba(34,197,94,0.14);
      color: rgba(187,247,208,1);
      border-color: rgba(34,197,94,0.4);
    }
    .ocp-permission-always {
      border-color: rgba(34,197,94,0.18);
      color: rgba(134,239,172,0.75);
    }
    .ocp-permission-always:hover:not(:disabled) {
      background: rgba(34,197,94,0.1);
      color: rgba(187,247,208,0.95);
      border-color: rgba(34,197,94,0.3);
    }
    .ocp-permission-reject {
      border-color: rgba(239,68,68,0.25);
      color: rgba(248,113,113,0.85);
      background: rgba(239,68,68,0.05);
    }
    .ocp-permission-reject:hover:not(:disabled) {
      background: rgba(239,68,68,0.16);
      color: rgba(252,165,165,1);
      border-color: rgba(239,68,68,0.4);
    }
    .ocp-permission-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* ── Post-plan action card ── */
    .ocp-post-plan-card {
      background: rgba(232,224,220,0.04);
      border: 1px solid rgba(232,224,220,0.14);
      border-radius: 10px;
      margin: 10px 0 6px;
      overflow: hidden;
    }
    .ocp-post-plan-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(232,224,220,0.08);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.8px;
      color: rgba(232, 224, 220, 0.7);
    }
    .ocp-post-plan-icon {
      width: 16px; height: 16px;
      color: rgba(232, 224, 220, 0.55);
      flex-shrink: 0;
    }
    .ocp-post-plan-note {
      padding: 10px 12px;
      font-size: 11px;
      line-height: 1.5;
      color: rgba(255,255,255,0.5);
    }
    .ocp-post-plan-actions {
      display: flex;
      gap: 8px;
      padding: 0 12px 12px;
      flex-wrap: wrap;
    }
    .ocp-post-plan-btn {
      padding: 7px 14px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 7px;
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.65);
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .ocp-post-plan-btn:hover {
      background: rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.88);
      border-color: rgba(255,255,255,0.18);
    }
    .ocp-post-plan-btn.primary {
      background: rgba(232,224,220,0.14);
      border-color: rgba(232,224,220,0.25);
      color: rgba(232,224,220,0.92);
      font-weight: 600;
    }
    .ocp-post-plan-btn.primary:hover {
      background: rgba(232,224,220,0.22);
      color: rgba(232,224,220,1);
      border-color: rgba(232,224,220,0.35);
    }

    /* ── Tool activity dock (sibling surface, matches Claude todo dock aesthetic) ── */
    .ocp-activity-dock {
      position: absolute;
      bottom: 0;
      right: calc(100% + 6px);
      display: flex;
      flex-direction: row-reverse;
      align-items: flex-end;
      z-index: 20;
      pointer-events: none;
      max-height: 100%;
    }
    .ocp-activity-tag {
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      padding: 9px 6px;
      background: rgba(18, 18, 20, 0.92);
      backdrop-filter: blur(60px) saturate(1.5);
      -webkit-backdrop-filter: blur(60px) saturate(1.5);
      border: 0.5px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
      color: rgba(232, 224, 220, 0.78);
      cursor: pointer;
      font-family: 'JetBrains Mono', monospace;
      font-variant-numeric: tabular-nums;
      box-shadow:
        0 0 0 0.5px rgba(0, 0, 0, 0.3),
        0 1px 2px rgba(0, 0, 0, 0.15),
        0 4px 8px rgba(0, 0, 0, 0.12),
        0 12px 24px rgba(0, 0, 0, 0.14);
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .ocp-activity-tag:hover {
      background: rgba(28, 26, 22, 0.94);
      border-color: rgba(255, 255, 255, 0.12);
      color: rgba(232, 224, 220, 0.98);
    }
    .ocp-activity-tag.running { color: #b5edc1; }
    .ocp-activity-tag-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: rgba(232, 224, 220, 0.45);
    }
    .ocp-activity-tag.running .ocp-activity-tag-dot {
      background: #6fd18a;
      box-shadow: 0 0 6px rgba(111, 209, 138, 0.7);
      animation: ocp-activity-pulse 1.4s ease-in-out infinite;
    }
    .ocp-activity-tag-count {
      font-size: 9.5px;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      letter-spacing: 0.04em;
      opacity: 0.85;
    }

    .ocp-activity-drawer {
      pointer-events: auto;
      width: 0;
      max-width: 0;
      overflow: hidden;
      opacity: 0;
      background: rgba(18, 18, 20, 0.92);
      backdrop-filter: blur(60px) saturate(1.5);
      -webkit-backdrop-filter: blur(60px) saturate(1.5);
      border: 0.5px solid rgba(255, 255, 255, 0.06);
      border-radius: 14px;
      box-shadow:
        0 0 0 0.5px rgba(0, 0, 0, 0.3),
        0 1px 2px rgba(0, 0, 0, 0.15),
        0 4px 8px rgba(0, 0, 0, 0.12),
        0 12px 24px rgba(0, 0, 0, 0.14),
        0 32px 64px rgba(0, 0, 0, 0.18);
      display: flex;
      flex-direction: column;
      margin-right: 6px;
      max-height: 100%;
      transition: width 0.22s cubic-bezier(0.2, 0, 0.2, 1), max-width 0.22s cubic-bezier(0.2, 0, 0.2, 1), opacity 0.18s ease;
    }
    .ocp-activity-dock.open .ocp-activity-drawer {
      width: 320px;
      max-width: 320px;
      opacity: 1;
    }
    .ocp-activity-dock.open .ocp-activity-tag { display: none; }
    .ocp-activity-header-hide {
      margin-left: 6px;
      background: none;
      border: none;
      color: rgba(232, 224, 220, 0.55);
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      padding: 2px 5px;
      border-radius: 4px;
      transition: background 0.12s, color 0.12s;
    }
    .ocp-activity-header-hide:hover {
      color: rgba(232, 224, 220, 1);
      background: rgba(255, 255, 255, 0.06);
    }
    .ocp-activity-header {
      padding: 12px 14px 8px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: rgba(232, 224, 220, 0.55);
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .ocp-activity-header-title {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      margin-right: auto;
    }
    .ocp-activity-header-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #6fd18a;
      box-shadow: 0 0 6px rgba(111, 209, 138, 0.7);
      animation: ocp-activity-pulse 1.4s ease-in-out infinite;
    }
    .ocp-activity-header-count {
      font-weight: 500;
      color: rgba(232, 224, 220, 0.45);
      letter-spacing: 0.05em;
    }
    .ocp-activity-list {
      max-height: 56vh;
      overflow-y: auto;
      padding: 8px 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ocp-activity-empty {
      padding: 16px 12px;
      text-align: center;
      color: rgba(232, 224, 220, 0.4);
      font-size: 12px;
      font-style: italic;
    }

    /* Row */
    .ocp-activity-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 10px 8px;
      border-radius: 10px;
      color: rgba(232, 224, 220, 0.9);
      font-size: 12px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid rgba(255, 255, 255, 0.06);
      transition: background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .ocp-activity-row:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.11);
    }
    .ocp-activity-row.ocp-activity-run {
      border-color: rgba(111, 209, 138, 0.2);
      box-shadow: inset 0 0 0 1px rgba(111, 209, 138, 0.06);
    }
    .ocp-activity-row-head {
      display: grid;
      grid-template-columns: 12px 16px 1fr auto;
      gap: 8px;
      align-items: start;
      min-width: 0;
      cursor: pointer;
    }
    .ocp-activity-row-caret {
      font-size: 9px;
      line-height: 1;
      padding-top: 4px;
      color: rgba(232, 224, 220, 0.35);
      transition: transform 0.18s ease, color 0.18s ease;
    }
    .ocp-activity-row-caret.is-open {
      transform: rotate(90deg);
      color: rgba(232, 224, 220, 0.7);
    }
    .ocp-activity-row-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(232, 224, 220, 0.6);
      padding-top: 1px;
    }
    .ocp-activity-row-body {
      min-width: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .ocp-activity-row-name-line {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .ocp-activity-row-name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ocp-activity-row-subtype {
      display: inline-block;
      padding: 1px 7px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: lowercase;
      border-radius: 999px;
      color: rgba(232, 224, 220, 0.9);
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .ocp-activity-row-subtype.tone-blue {
      color: #b9cbff;
      background: rgba(120, 150, 230, 0.14);
      border-color: rgba(120, 150, 230, 0.22);
    }
    .ocp-activity-row-subtype.tone-purple {
      color: #d0b9ff;
      background: rgba(172, 130, 230, 0.14);
      border-color: rgba(172, 130, 230, 0.22);
    }
    .ocp-activity-row-subtype.tone-green {
      color: #b5edc1;
      background: rgba(111, 209, 138, 0.14);
      border-color: rgba(111, 209, 138, 0.22);
    }
    .ocp-activity-row-subtype.tone-amber {
      color: #ffd1a8;
      background: rgba(230, 160, 90, 0.14);
      border-color: rgba(230, 160, 90, 0.22);
    }
    .ocp-activity-row-subtype.tone-neutral {
      color: rgba(232, 224, 220, 0.82);
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.1);
    }
    .ocp-activity-row-summary {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      font-size: 11px;
      color: rgba(232, 224, 220, 0.6);
      overflow: hidden;
      line-height: 1.35;
    }
    .ocp-activity-row-meta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 2px;
      font-size: 10px;
      color: rgba(232, 224, 220, 0.42);
      font-variant-numeric: tabular-nums;
    }
    .ocp-activity-row-tools {
      display: inline-flex;
      align-items: center;
      padding: 1px 7px;
      font-size: 10px;
      font-weight: 600;
      color: rgba(232, 224, 220, 0.7);
      background: rgba(255, 255, 255, 0.05);
      border-radius: 999px;
    }
    .ocp-activity-row-time {
      font-size: 10px;
      color: rgba(232, 224, 220, 0.42);
      font-variant-numeric: tabular-nums;
    }
    .ocp-activity-row-actions {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .ocp-activity-row:hover .ocp-activity-row-actions,
    .ocp-activity-row.ocp-activity-run .ocp-activity-row-actions {
      opacity: 1;
    }
    .ocp-activity-row-action {
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: rgba(232, 224, 220, 0.55);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .ocp-activity-row-action:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.08);
      color: rgba(232, 224, 220, 0.95);
    }
    .ocp-activity-row-action:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .ocp-activity-row-action svg {
      width: 13px;
      height: 13px;
    }
    .ocp-activity-row-abort:hover:not(:disabled) {
      background: rgba(242, 139, 130, 0.16);
      color: #f5a897;
    }
    .ocp-activity-row.ocp-activity-run .ocp-activity-row-icon {
      color: #6fd18a;
    }
    .ocp-activity-row.ocp-activity-err .ocp-activity-row-icon {
      color: #f28b82;
    }
    .ocp-activity-row.ocp-activity-err .ocp-activity-row-name {
      color: rgba(242, 139, 130, 0.92);
    }
    .ocp-activity-row.ocp-activity-abort .ocp-activity-row-icon {
      color: rgba(232, 224, 220, 0.35);
    }
    .ocp-activity-row.ocp-activity-abort {
      opacity: 0.65;
    }

    /* Steps */
    .ocp-activity-row-steps {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px 0 0 24px;
      border-left: 1px dashed rgba(255, 255, 255, 0.1);
      margin-left: 11px;
      overflow: hidden;
      transition: max-height 0.24s ease;
    }
    .ocp-activity-row-steps.is-expanded {
      max-height: 260px;
      overflow-y: auto;
      padding-bottom: 4px;
    }
    .ocp-activity-step {
      display: grid;
      grid-template-columns: 12px 16px 1fr;
      gap: 6px;
      align-items: center;
      padding: 3px 6px;
      border-radius: 5px;
      font-size: 11px;
      line-height: 1.35;
      color: rgba(232, 224, 220, 0.8);
    }
    .ocp-activity-step-status {
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(232, 224, 220, 0.5);
      font-size: 10px;
    }
    .ocp-activity-step-tool {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: rgba(232, 224, 220, 0.58);
      width: 14px;
      height: 14px;
    }
    .ocp-activity-step-tool svg {
      width: 12px;
      height: 12px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .ocp-activity-step-tool img {
      width: 12px;
      height: 12px;
      object-fit: contain;
    }
    .ocp-activity-step-body {
      min-width: 0;
      overflow: hidden;
    }
    .ocp-activity-step-name {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }
    .ocp-activity-step-summary {
      font-size: 10px;
      color: rgba(232, 224, 220, 0.45);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }
    .ocp-activity-step.run .ocp-activity-step-status {
      color: #6fd18a;
      animation: ocp-activity-pulse 1.4s ease-in-out infinite;
    }
    .ocp-activity-step.err .ocp-activity-step-status { color: #f28b82; }
    .ocp-activity-step.abort .ocp-activity-step-status { color: rgba(232, 224, 220, 0.35); }
    .ocp-activity-step.done .ocp-activity-step-status { color: rgba(111, 209, 138, 0.6); }
    .ocp-activity-step.is-active {
      background: rgba(111, 209, 138, 0.06);
    }
    .ocp-activity-step.synabun .ocp-activity-step-name {
      color: rgba(180, 200, 255, 0.9);
    }
    .ocp-activity-step.shimmer .ocp-activity-step-name {
      background: linear-gradient(90deg, rgba(232,224,220,0.45) 0%, rgba(232,224,220,0.9) 50%, rgba(232,224,220,0.45) 100%);
      background-size: 200% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      animation: ocp-activity-shimmer 1.8s linear infinite;
    }
    @keyframes ocp-activity-shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    .ocp-tool-card-focus {
      animation: ocp-tool-card-flash 1.4s ease-out;
    }
    @keyframes ocp-tool-card-flash {
      0%   { box-shadow: 0 0 0 2px rgba(232, 224, 220, 0.55), 0 0 24px rgba(232, 224, 220, 0.35); }
      100% { box-shadow: 0 0 0 0 rgba(232, 224, 220, 0), 0 0 0 rgba(232, 224, 220, 0); }
    }
    @keyframes ocp-activity-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.55; transform: scale(0.9); }
    }
  `;
  document.head.appendChild(style);
}
