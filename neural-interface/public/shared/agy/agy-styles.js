// SynaBun — Antigravity Panel: Styles
//
// The Codex panel's visual language (DESIGN.md → Codex sidepanel `panel-codex`; docs/codex-sidepanel.md → Visual
// language): the same shell, surfaces, edges, text levels, radii, type sizes, motion and card anatomy, under the
// panel's own --agy-* names with the same values. The one colour of its own is the provider's
// (provider-icons.js PROVIDER_META.antigravity): its mark and nothing else. Every rule below uses a token; add a
// value to the block first. The tokens are declared on everything the panel puts outside itself too (popovers,
// the tray pill).

export function injectAntigravityStyles() {
  if (document.getElementById('antigravity-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'antigravity-panel-styles';
  style.textContent = `
    .agy-panel, .agy-session-pill, .agy-pop {
      --agy-shell: rgba(16, 18, 22, 0.92);
      --agy-shell-border: rgba(255,255,255,0.08);
      --agy-pop-bg: rgb(22, 22, 26);
      --agy-surface-1: rgba(255,255,255,0.04);
      --agy-surface-2: rgba(255,255,255,0.08);
      --agy-surface-3: rgba(255,255,255,0.14);
      --agy-scrim: rgba(0,0,0,0.55);
      --agy-border: rgba(255,255,255,0.10);
      --agy-border-strong: rgba(255,255,255,0.22);
      --agy-border-input: rgba(255,255,255,0.36);
      --agy-text: rgba(255,255,255,0.9);
      --agy-text-2: rgba(255,255,255,0.7);
      --agy-text-3: rgba(255,255,255,0.5);
      --agy-text-off: rgba(255,255,255,0.3);
      --agy-solid: #ededed;
      --agy-solid-hover: #ffffff;
      --agy-on-solid: #171717;
      --agy-running: #0ea5e9;
      --agy-success: #22c55e;
      --agy-warning: #f59e0b;
      --agy-danger: #ef4444;
      --agy-pressure-high: #d4a848;
      --agy-pressure-critical: #ef7070;
      --agy-link: #9dc3ff;
      --agy-focus: rgba(255,255,255,0.7);
      --agy-brand: #669DF6;
      --agy-radius-sm: 4px;
      --agy-radius-md: 8px;
      --agy-radius-lg: 12px;
      --agy-radius-pill: 999px;
      --agy-radius-shell: 16px;
      --agy-space-1: 4px;
      --agy-space-2: 8px;
      --agy-space-3: 12px;
      --agy-space-4: 16px;
      --agy-space-5: 24px;
      --agy-font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --agy-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
      --agy-fs-xs: 10px;
      --agy-fs-sm: 11px;
      --agy-fs-md: 12px;
      --agy-fs-lg: 13px;
      --agy-lh-tight: 1.35;
      --agy-lh: 1.6;
      --agy-dur-fast: 150ms;
      --agy-dur: 250ms;
      --agy-ease: cubic-bezier(0.2, 0, 0, 1);
      --agy-shadow-pop: 0 12px 32px rgba(0,0,0,0.4);
    }
    @keyframes agy-working { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
    @keyframes agy-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
    @keyframes agy-nudge { 0%, 100% { transform: none; } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }

    /* ── Shell (kept in step with the sibling side panels) ── */
    .agy-panel {
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
      background: var(--agy-shell);
      backdrop-filter: blur(28px) saturate(1.45);
      -webkit-backdrop-filter: blur(28px) saturate(1.45);
      border: 0.5px solid var(--agy-shell-border);
      border-radius: var(--agy-radius-shell);
      box-shadow: 0 0 0 0.5px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.15), 0 4px 8px rgba(0,0,0,0.12), 0 12px 24px rgba(0,0,0,0.14), 0 32px 64px rgba(0,0,0,0.18);
      overflow: hidden;
      transform: translateX(calc(100% + 20px));
      opacity: 0;
      transition: transform var(--agy-dur) var(--agy-ease), opacity var(--agy-dur) ease;
      font-family: var(--agy-font);
      font-size: var(--agy-fs-md);
      color: var(--agy-text);
    }
    .agy-panel.open { transform: translateX(0); opacity: 1; overflow: visible; }
    .agy-panel:has(.cc-dropdown.open) { z-index: 99999; }
    .agy-panel :is(a, button, input, textarea, summary, [tabindex]):focus-visible,
    .agy-pop :is(a, button, input, textarea, summary, [tabindex]):focus-visible,
    .agy-session-pill:focus-visible { outline: 2px solid var(--agy-focus); outline-offset: 2px; }
    .agy-panel :is(.agy-card-head, .agy-thought summary, .agy-session-btn, .agy-header-rename):focus-visible { outline-offset: -2px; }
    .agy-panel input::placeholder, .agy-panel textarea::placeholder { color: var(--agy-text-3); opacity: 1; }
    .agy-panel [hidden], .agy-pop [hidden] { display: none !important; }
    .agy-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .agy-resize-handle { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 2; }
    .agy-mono { font-family: var(--agy-mono); }

    /* ── Header ── */
    .agy-header {
      position: relative; display: flex; align-items: center; flex-shrink: 0;
      margin: 8px 8px 0; padding: 10px 10px 10px 14px; border-radius: var(--agy-radius-lg);
      background: var(--agy-surface-1); z-index: 3;
    }
    .agy-session-btn {
      display: flex; align-items: center; gap: 6px; min-width: 32px; flex: 1 0 88px; max-width: max-content; overflow: hidden;
      padding: 5px 10px; border: none; border-radius: var(--agy-radius-md) 0 0 var(--agy-radius-md);
      background: var(--agy-surface-1); color: var(--agy-text-2); font: var(--agy-fs-sm)/1.35 var(--agy-font); cursor: pointer;
      transition: background var(--agy-dur-fast), color var(--agy-dur-fast);
    }
    .agy-session-btn:hover { background: var(--agy-surface-2); color: var(--agy-text); }
    .agy-session-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
    .agy-session-label input { width: 100%; min-width: 0; border: none; outline: none; background: transparent; color: var(--agy-text); font: inherit; padding: 0; }
    .agy-dd-arrow { font-size: var(--agy-fs-xs); color: var(--agy-text-3); flex-shrink: 0; }
    .agy-mark { width: 14px; height: 14px; flex: 0 0 auto; display: inline-flex; color: var(--agy-brand); }
    .agy-mark svg { width: 14px; height: 14px; }
    .agy-header-rename {
      display: inline-flex; align-items: center; justify-content: center; width: 24px; align-self: stretch; flex-shrink: 0; margin-right: 3px;
      border: none; border-left: 1px solid var(--agy-border); border-radius: 0 var(--agy-radius-md) var(--agy-radius-md) 0;
      background: var(--agy-surface-1); color: var(--agy-text-3); cursor: pointer; transition: background var(--agy-dur-fast), color var(--agy-dur-fast);
    }
    .agy-header-rename:hover:not(:disabled) { color: var(--agy-text); background: var(--agy-surface-2); }
    .agy-header-rename:disabled { opacity: 0.4; cursor: not-allowed; }
    .agy-header-rename svg { width: 12px; height: 12px; }
    .agy-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; flex-shrink: 0; }
    .agy-actions > * { flex-shrink: 0; }
    .agy-btn {
      position: relative; width: 24px; height: 24px; padding: 0; border: none; border-radius: var(--agy-radius-md);
      display: inline-flex; align-items: center; justify-content: center; background: var(--agy-surface-1); color: var(--agy-text-3);
      cursor: pointer; transition: background var(--agy-dur-fast), color var(--agy-dur-fast);
    }
    .agy-btn:hover:not(:disabled) { background: var(--agy-surface-2); color: var(--agy-text); }
    .agy-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .agy-btn svg { width: 12px; height: 12px; }
    .agy-btn-danger:hover:not(:disabled) { color: var(--agy-danger); }
    .agy-cog-dot { position: absolute; top: 3px; right: 3px; width: 6px; height: 6px; border-radius: 50%; background: var(--agy-pressure-high); }
    .agy-cog-dot.critical { background: var(--agy-pressure-critical); }

    /* ── Tabs (two or more) ── */
    .agy-tabs { display: flex; gap: 4px; padding: 6px 12px 0; overflow-x: auto; scrollbar-width: none; flex-shrink: 0; }
    .agy-tabs:empty { display: none; }
    .agy-tab {
      display: inline-flex; align-items: center; gap: 6px; max-width: 180px; padding: 3px 6px 3px 8px; flex-shrink: 0;
      border: 1px solid var(--agy-border); border-radius: var(--agy-radius-md); background: transparent;
      color: var(--agy-text-3); font: var(--agy-fs-sm)/1.35 var(--agy-font); cursor: pointer; transition: background var(--agy-dur-fast), color var(--agy-dur-fast);
    }
    .agy-tab:hover { background: var(--agy-surface-1); color: var(--agy-text-2); }
    .agy-tab[aria-selected="true"] { background: var(--agy-surface-2); color: var(--agy-text); border-color: var(--agy-border-strong); }
    .agy-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agy-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--agy-text-off); flex: 0 0 auto; }
    .agy-tab.running .agy-dot { background: var(--agy-running); animation: agy-working 1.6s ease-in-out infinite; }
    .agy-tab.needs-you .agy-dot { background: var(--agy-warning); }
    .agy-tab-close { border: 0; background: none; color: var(--agy-text-3); cursor: pointer; padding: 0 2px; font-size: var(--agy-fs-lg); line-height: 1; border-radius: var(--agy-radius-sm); }
    .agy-tab-close:hover { color: var(--agy-text); background: var(--agy-surface-2); }

    /* ── Transcript ── */
    .agy-messages-container { position: relative; flex: 1; min-height: 0; overflow: hidden; margin: 6px 8px; }
    .agy-transcript {
      position: absolute; inset: 0; overflow-x: hidden; overflow-y: auto; padding: 12px 0 8px;
      display: flex; flex-direction: column; gap: 0; font-size: var(--agy-fs-md); line-height: var(--agy-lh);
      scrollbar-width: thin; scrollbar-color: var(--agy-border-strong) transparent;
    }
    .agy-transcript::before { content: ''; margin-top: auto; }
    .agy-transcript::-webkit-scrollbar { width: 10px; }
    .agy-transcript::-webkit-scrollbar-thumb { background: var(--agy-border-strong); border-radius: var(--agy-radius-sm); min-height: 40px; }
    .agy-jump {
      position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 4;
      padding: 4px 10px; border: 1px solid var(--agy-border-strong); border-radius: var(--agy-radius-pill);
      background: var(--agy-pop-bg); color: var(--agy-text-2); font: 500 var(--agy-fs-sm)/1.2 var(--agy-font); cursor: pointer; box-shadow: var(--agy-shadow-pop);
    }
    .agy-jump:hover { color: var(--agy-text); }
    .agy-empty {
      margin: auto 0; min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 8px; padding: 24px 18px; text-align: center; color: var(--agy-text-3);
    }
    .agy-empty-mark { display: flex; color: var(--agy-text-off); }
    .agy-empty-mark svg { width: 32px; height: 32px; }
    .agy-empty-name { font-size: var(--agy-fs-lg); font-weight: 500; color: var(--agy-text-3); }
    .agy-empty-status { font-size: var(--agy-fs-sm); line-height: 1.5; max-width: 300px; }
    .agy-empty-keys { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; font-size: var(--agy-fs-sm); }
    kbd { display: inline-block; min-width: 16px; padding: 0 4px; border: 1px solid var(--agy-border-strong); border-radius: var(--agy-radius-sm); font: 500 var(--agy-fs-xs)/16px var(--agy-mono); color: var(--agy-text-2); text-align: center; }

    /* System notices: a quiet centred line; a tone adds a mark and a colour. */
    .agy-system {
      align-self: center; box-sizing: border-box; max-width: calc(100% - 32px); margin: 4px 16px; padding: 4px 0;
      font-size: var(--agy-fs-sm); line-height: 1.45; color: var(--agy-text-3); text-align: center; overflow-wrap: anywhere; white-space: pre-wrap; flex-shrink: 0;
    }
    .agy-system.error { color: var(--agy-danger); }
    .agy-system.warning { color: var(--agy-warning); }
    .agy-system.error::before { content: '\\2715'; margin-right: 6px; }
    .agy-system.working { color: var(--agy-running); }
    .agy-system.working::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentColor; vertical-align: 1px; animation: agy-working 1.6s ease-in-out infinite; }

    /* Messages */
    .agy-msg { display: flex; padding: var(--agy-space-2); flex-shrink: 0; min-width: 0; }
    .agy-msg-user { justify-content: flex-end; padding: var(--agy-space-3) var(--agy-space-2) var(--agy-space-1); }
    .agy-msg-user .agy-msg-card { max-width: 85%; border-radius: var(--agy-radius-lg); background: var(--agy-surface-2); padding: var(--agy-space-2) var(--agy-space-3); }
    .agy-msg-text { white-space: pre-wrap; word-break: break-word; font-size: var(--agy-fs-md); line-height: var(--agy-lh); }
    .agy-msg-agent, .agy-msg-relay { flex-direction: column; color: var(--agy-text); word-break: break-word; }
    .agy-msg-relay { margin: 0 var(--agy-space-2); border-left: 2px solid var(--agy-border-strong); padding-left: var(--agy-space-3); }
    .agy-msg-relay-label { font-size: var(--agy-fs-sm); color: var(--agy-text-3); }
    .agy-md { font-size: var(--agy-fs-md); line-height: var(--agy-lh); color: var(--agy-text); min-width: 0; overflow-wrap: anywhere; }
    .agy-md > :first-child { margin-top: 0; } .agy-md > :last-child { margin-bottom: 0; }
    .agy-md :is(p, ul, ol, pre, blockquote, table) { margin: 0 0 8px; }
    .agy-md :is(h1, h2, h3, h4) { margin: 12px 0 6px; font-size: var(--agy-fs-lg); font-weight: 600; line-height: var(--agy-lh-tight); }
    .agy-md :is(ul, ol) { padding-left: 18px; }
    .agy-md a { color: var(--agy-link); }
    .agy-md code { font-family: var(--agy-mono); font-size: 0.92em; background: var(--agy-surface-2); padding: 1px 4px; border-radius: var(--agy-radius-sm); }
    .agy-md pre { background: var(--agy-surface-1); border-radius: var(--agy-radius-md); padding: 8px 10px; overflow-x: auto; font: var(--agy-fs-sm)/1.55 var(--agy-mono); }
    .agy-md pre code { background: none; padding: 0; }
    .agy-md blockquote { border-left: 2px solid var(--agy-border-strong); padding-left: 10px; color: var(--agy-text-2); }
    .agy-md table { border-collapse: collapse; display: block; overflow-x: auto; }
    .agy-md :is(th, td) { border: 1px solid var(--agy-border); padding: 3px 8px; text-align: left; }
    .agy-attach-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .agy-msg-image { display: block; width: min(220px, 100%); max-height: 180px; object-fit: cover; border-radius: var(--agy-radius-sm); }
    .agy-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 220px; padding: 2px 6px; border-radius: var(--agy-radius-sm); background: var(--agy-surface-2); color: var(--agy-text-2); font-size: var(--agy-fs-sm); }
    .agy-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agy-chip img { width: 18px; height: 18px; object-fit: cover; border-radius: 3px; }
    .agy-chip button { border: 0; background: none; color: var(--agy-text-3); cursor: pointer; padding: 0 2px; font-size: var(--agy-fs-lg); line-height: 1; }
    .agy-chip button:hover { color: var(--agy-text); }

    /* Thoughts */
    .agy-thought { margin: 2px var(--agy-space-2); font-size: var(--agy-fs-sm); color: var(--agy-text-3); flex-shrink: 0; }
    .agy-thought summary { cursor: pointer; list-style: none; padding: 4px 0; display: inline-flex; align-items: center; gap: 6px; }
    .agy-thought summary::-webkit-details-marker { display: none; }
    .agy-thought summary::before { content: '\\25B8'; font-size: var(--agy-fs-xs); transition: transform var(--agy-dur-fast); }
    .agy-thought[open] summary::before { transform: rotate(90deg); }
    .agy-thought summary:hover { color: var(--agy-text-2); }
    .agy-thought-body { white-space: pre-wrap; padding: 4px 0 6px 10px; border-left: 1px solid var(--agy-border); line-height: 1.55; }

    /* ── One card anatomy: head (icon, title, subtitle, status, chevron) then a body ── */
    .agy-card { margin: var(--agy-space-1) var(--agy-space-2); border: 1px solid var(--agy-border); border-radius: var(--agy-radius-md); background: transparent; overflow: hidden; flex-shrink: 0; }
    .agy-card.agy-collapsed > .agy-card-body { display: none; }
    .agy-card-head { display: flex; align-items: center; gap: var(--agy-space-2); min-height: 40px; padding: 6px var(--agy-space-3) 6px var(--agy-space-2); user-select: none; }
    .agy-card-head[role="button"] { cursor: pointer; transition: background var(--agy-dur-fast); }
    .agy-card-head[role="button"]:hover { background: var(--agy-surface-1); }
    .agy-card-icon { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; color: var(--agy-text-3); flex-shrink: 0; }
    .agy-card-titles { flex: 1; min-width: 0; }
    .agy-card-title, .agy-card-subtitle { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: var(--agy-lh-tight); }
    .agy-card-title { font-size: var(--agy-fs-md); font-weight: 600; color: var(--agy-text); }
    .agy-card-title .agy-mono { font-weight: 500; font-size: var(--agy-fs-sm); }
    .agy-card-subtitle { margin-top: 1px; font-size: var(--agy-fs-sm); color: var(--agy-text-3); }
    .agy-card-subtitle a { color: inherit; }
    .agy-card-chevron { width: 16px; height: 16px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--agy-text-3); font-size: var(--agy-fs-xs); transition: transform var(--agy-dur-fast) var(--agy-ease); }
    .agy-card-chevron::after { content: '\\25BE'; }
    .agy-collapsed > .agy-card-head > .agy-card-chevron { transform: rotate(-90deg); }
    .agy-card-body { padding: 0 var(--agy-space-3) var(--agy-space-3); display: flex; flex-direction: column; gap: var(--agy-space-2); min-width: 0; }
    .agy-card-text { margin: 0; color: var(--agy-text-2); font-size: var(--agy-fs-sm); line-height: 1.5; overflow-wrap: anywhere; }
    .agy-card-error { color: var(--agy-danger); font-size: var(--agy-fs-sm); white-space: pre-wrap; }
    .agy-card-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .agy-card-state { font-size: var(--agy-fs-sm); color: var(--agy-text-3); }
    .agy-card-hint { font-size: var(--agy-fs-xs); color: var(--agy-text-3); }
    .agy-status-pill { flex-shrink: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--agy-fs-sm); color: var(--agy-text-3); }
    .agy-status-pill[data-tone]::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentColor; vertical-align: 1px; }
    .agy-status-pill[data-tone="running"] { color: var(--agy-running); }
    .agy-status-pill[data-tone="running"]::before { animation: agy-working 1.6s ease-in-out infinite; }
    .agy-status-pill[data-tone="warning"] { color: var(--agy-warning); }
    .agy-status-pill[data-tone="error"] { color: var(--agy-danger); }
    .agy-status-pill[data-tone="success"] { color: var(--agy-success); }
    .agy-request { box-shadow: inset 2px 0 0 var(--agy-warning); }
    .agy-request .agy-card-title { white-space: normal; overflow-wrap: anywhere; }
    .agy-request.agy-request-done { box-shadow: none; opacity: 0.7; }
    .agy-tool-image { max-width: 100%; max-height: 220px; border-radius: var(--agy-radius-sm); object-fit: contain; align-self: flex-start; }

    /* Buttons inside cards and the setup card: solid for the one primary action, hairline for the rest, red text for denial. */
    .agy-action {
      display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px; border: 1px solid var(--agy-border-strong);
      border-radius: var(--agy-radius-md); background: transparent; color: var(--agy-text); font: 500 var(--agy-fs-md)/1 var(--agy-font);
      text-decoration: none; cursor: pointer; user-select: none; transition: background var(--agy-dur-fast), border-color var(--agy-dur-fast);
    }
    .agy-action:hover:not(:disabled) { background: var(--agy-surface-2); }
    .agy-action:disabled { opacity: 0.5; cursor: default; }
    .agy-action.agy-btn-primary { background: var(--agy-solid); border-color: var(--agy-solid); color: var(--agy-on-solid); }
    .agy-action.agy-btn-primary:hover:not(:disabled) { background: var(--agy-solid-hover); border-color: var(--agy-solid-hover); }
    .agy-action.agy-btn-deny { color: #fca5a5; }
    .agy-link-btn { align-self: flex-start; border: none; background: none; padding: 2px 0; color: var(--agy-link); font: var(--agy-fs-sm)/1.4 var(--agy-font); cursor: pointer; }
    .agy-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: var(--agy-radius-sm); background: none; color: var(--agy-text-3); cursor: pointer; }
    .agy-icon-btn:hover { color: var(--agy-text); background: var(--agy-surface-2); }
    .agy-icon-btn svg { width: 12px; height: 12px; flex-shrink: 0; }

    /* Code, output, raw input */
    .agy-pre-wrap { position: relative; min-width: 0; }
    .agy-pre {
      margin: 0; max-height: 320px; overflow: auto; padding: 8px 10px; background: var(--agy-surface-1); border-radius: var(--agy-radius-sm);
      font: var(--agy-fs-sm)/1.55 var(--agy-mono); color: var(--agy-text-2); white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 8;
    }
    .agy-pre-terminal { color: var(--agy-text); }
    .agy-pre-note { font-size: var(--agy-fs-xs); color: var(--agy-text-3); }
    .agy-copy-btn {
      position: absolute; top: 4px; right: 4px; z-index: 1; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
      padding: 0; border: 1px solid var(--agy-border); border-radius: var(--agy-radius-sm); background: var(--agy-pop-bg); color: var(--agy-text-3);
      cursor: pointer; opacity: 0; transition: opacity var(--agy-dur-fast);
    }
    .agy-pre-wrap:hover > .agy-copy-btn, .agy-pre-wrap:focus-within > .agy-copy-btn, .agy-diff-header:hover .agy-copy-btn, .agy-diff-header:focus-within .agy-copy-btn { opacity: 1; }
    .agy-copy-btn:hover { color: var(--agy-text); }
    .agy-raw-label { font-size: var(--agy-fs-xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--agy-text-3); margin-bottom: 4px; }
    .agy-locations { display: flex; flex-wrap: wrap; gap: 4px 10px; }
    .agy-file-link { font: var(--agy-fs-sm)/1.4 var(--agy-mono); color: var(--agy-link); text-decoration: none; overflow-wrap: anywhere; }
    .agy-file-link:hover { text-decoration: underline; }
    .agy-terminal { display: flex; flex-direction: column; gap: 4px; }
    .agy-terminal--waiting { font-size: var(--agy-fs-sm); color: var(--agy-text-3); }
    .agy-terminal-foot { display: flex; justify-content: space-between; gap: 8px; font-size: var(--agy-fs-xs); color: var(--agy-text-3); }
    .agy-terminal-state[data-tone="running"] { color: var(--agy-running); animation: agy-working 1.6s ease-in-out infinite; }
    .agy-terminal-state[data-tone="success"] { color: var(--agy-success); }
    .agy-terminal-state[data-tone="error"] { color: var(--agy-danger); }

    /* Unified diffs: path and counts, numbered rows, faint tints. */
    .agy-diff { min-width: 0; border-top: 1px solid var(--agy-border); padding-top: 4px; }
    .agy-diff:first-child { border-top: none; padding-top: 0; }
    .agy-diff-header { position: relative; display: flex; align-items: baseline; gap: var(--agy-space-2); padding: 4px 28px 4px 0; }
    .agy-diff-header .agy-copy-btn { top: 2px; right: 0; }
    .agy-diff-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--agy-text); font: var(--agy-fs-sm)/1.5 var(--agy-mono); text-decoration: none; }
    .agy-diff-path:hover { text-decoration: underline; }
    .agy-diff-status, .agy-diff-stats { flex-shrink: 0; color: var(--agy-text-3); font: var(--agy-fs-sm)/1.5 var(--agy-font); }
    .agy-diff-stats .add { color: var(--agy-success); } .agy-diff-stats .del { color: var(--agy-danger); }
    .agy-diff-lines { max-height: 480px; overflow-y: auto; overflow-x: hidden; border-radius: var(--agy-radius-sm); background: var(--agy-surface-1); }
    .agy-diff-line { display: grid; grid-template-columns: 4ch 4ch 2ch minmax(0, 1fr); font: var(--agy-fs-sm)/1.65 var(--agy-mono); color: var(--agy-text-2); }
    .agy-diff-old, .agy-diff-new { text-align: right; padding-right: 1ch; color: var(--agy-text-3); user-select: none; overflow: hidden; }
    .agy-diff-sign { text-align: center; user-select: none; }
    .agy-diff-text { white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 8; }
    .agy-diff-line[data-kind="add"] { background: color-mix(in srgb, var(--agy-success) 10%, transparent); }
    .agy-diff-line[data-kind="add"] .agy-diff-sign { color: var(--agy-success); }
    .agy-diff-line[data-kind="delete"] { background: color-mix(in srgb, var(--agy-danger) 10%, transparent); }
    .agy-diff-line[data-kind="delete"] .agy-diff-sign { color: var(--agy-danger); }
    .agy-diff-line[data-kind="hunk"], .agy-diff-line[data-kind="note"] { color: var(--agy-text-3); }
    .agy-diff-empty { font-size: var(--agy-fs-sm); color: var(--agy-text-3); padding: 2px 0 6px; }

    /* Plans */
    .agy-plan-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
    .agy-plan-item { display: flex; align-items: baseline; gap: 8px; font-size: var(--agy-fs-sm); color: var(--agy-text-2); line-height: 1.45; }
    .agy-plan-mark { width: 10px; height: 10px; flex-shrink: 0; border: 1px solid var(--agy-border-strong); border-radius: 50%; transform: translateY(1px); }
    .agy-plan-item[data-status="completed"] { color: var(--agy-text-3); text-decoration: line-through; }
    .agy-plan-item[data-status="completed"] .agy-plan-mark { background: var(--agy-success); border-color: var(--agy-success); }
    .agy-plan-item[data-status="in_progress"] { color: var(--agy-text); font-weight: 500; }
    .agy-plan-item[data-status="in_progress"] .agy-plan-mark { border-color: var(--agy-running); background: color-mix(in srgb, var(--agy-running) 35%, transparent); animation: agy-working 1.6s ease-in-out infinite; }
    .agy-plan-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .agy-plan-priority { flex-shrink: 0; font-size: var(--agy-fs-xs); color: var(--agy-warning); }

    /* Turn footer: usage, time, Copy, Retry */
    .agy-turn-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 var(--agy-space-2) var(--agy-space-2); min-height: 22px; font-size: var(--agy-fs-xs); color: var(--agy-text-3); flex-shrink: 0; }
    .agy-turn-meta { display: inline-flex; flex-wrap: wrap; gap: 6px; font-family: var(--agy-mono); }
    .agy-turn-actions { display: inline-flex; gap: 2px; opacity: 0.55; transition: opacity var(--agy-dur-fast); }
    .agy-turn-foot:hover .agy-turn-actions, .agy-turn-actions:focus-within { opacity: 1; }

    /* Elicitation forms */
    .agy-elicit-form { display: flex; flex-direction: column; gap: 10px; }
    .agy-field { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; border: none; min-width: 0; }
    .agy-field-label { font-size: var(--agy-fs-sm); font-weight: 500; color: var(--agy-text-2); padding: 0; }
    .agy-field-input { box-sizing: border-box; width: 100%; height: 28px; padding: 0 8px; border: 1px solid var(--agy-border-input); border-radius: var(--agy-radius-sm); background: rgba(0,0,0,0.25); color: var(--agy-text); font: var(--agy-fs-md)/1.4 var(--agy-font); }
    .agy-field-help { font-size: var(--agy-fs-xs); color: var(--agy-text-3); }
    .agy-field-error { font-size: var(--agy-fs-xs); color: var(--agy-danger); }
    .agy-choices { display: flex; flex-wrap: wrap; gap: 6px; }
    .agy-choice, .agy-check { display: inline-flex; align-items: center; gap: 6px; font-size: var(--agy-fs-sm); color: var(--agy-text-2); cursor: pointer; }
    .agy-choice { padding: 3px 8px; border: 1px solid var(--agy-border); border-radius: var(--agy-radius-md); }
    .agy-choice:has(input:checked) { border-color: var(--agy-border-strong); background: var(--agy-surface-2); color: var(--agy-text); }
    .agy-url-box code { display: block; padding: 4px 8px; background: var(--agy-surface-2); border-radius: var(--agy-radius-sm); font: var(--agy-fs-sm)/1.5 var(--agy-mono); overflow-wrap: anywhere; }

    /* ── Setup: not installed, installing, failed, failed to start, sign-in ── */
    .agy-setup {
      flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center;
      margin: var(--agy-space-2); padding: 20px 18px 18px; border: 1px solid var(--agy-border); border-radius: var(--agy-radius-lg);
      background: var(--agy-surface-1); color: var(--agy-text-2);
    }
    .agy-setup--centered { margin: auto var(--agy-space-2); }
    .agy-setup[data-tone="err"] { box-shadow: inset 0 2px 0 var(--agy-danger); }
    .agy-setup[data-tone="busy"] { box-shadow: inset 0 2px 0 var(--agy-running); }
    .agy-setup[data-tone="ok"] { box-shadow: inset 0 2px 0 var(--agy-success); }
    .agy-setup--path { flex-direction: column; align-items: stretch; text-align: left; padding: 12px; }
    .agy-setup--path .agy-setup-mark { display: none; }
    .agy-setup-mark { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: var(--agy-radius-lg); background: var(--agy-surface-2); color: var(--agy-brand); }
    .agy-setup-mark svg { width: 20px; height: 20px; }
    .agy-setup[data-tone="busy"] .agy-setup-mark { animation: agy-working 1.6s ease-in-out infinite; }
    .agy-setup-title { margin: 0; font-size: var(--agy-fs-lg); font-weight: 600; line-height: var(--agy-lh-tight); color: var(--agy-text); }
    .agy-setup-body { margin: 0; max-width: 340px; font-size: var(--agy-fs-sm); line-height: 1.5; color: var(--agy-text-2); overflow-wrap: anywhere; }
    .agy-steps { display: flex; justify-content: center; gap: 4px; margin: 2px 0; padding: 0; list-style: none; width: 100%; max-width: 360px; }
    .agy-step { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; position: relative; font-size: var(--agy-fs-xs); color: var(--agy-text-3); }
    .agy-step:not(:last-child)::after { content: ''; position: absolute; top: 8px; left: calc(50% + 12px); right: calc(-50% + 12px); height: 1px; background: var(--agy-border-strong); }
    .agy-step[data-state="done"]:not(:last-child)::after { background: var(--agy-success); }
    .agy-step-dot { width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--agy-border-strong); display: flex; align-items: center; justify-content: center; color: var(--agy-on-solid); }
    .agy-step-dot svg { width: 10px; height: 10px; }
    .agy-step[data-state="active"] { color: var(--agy-text); }
    .agy-step[data-state="active"] .agy-step-dot { border-color: var(--agy-running); background: color-mix(in srgb, var(--agy-running) 30%, transparent); animation: agy-working 1.6s ease-in-out infinite; }
    .agy-step[data-state="done"] { color: var(--agy-text-2); }
    .agy-step[data-state="done"] .agy-step-dot { border-color: var(--agy-success); background: var(--agy-success); }
    .agy-step[data-state="failed"] { color: var(--agy-danger); }
    .agy-step[data-state="failed"] .agy-step-dot { border-color: var(--agy-danger); background: var(--agy-danger); }
    .agy-step-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    .agy-setup-progress { width: 100%; max-width: 340px; display: flex; flex-direction: column; gap: 4px; }
    .agy-setup-step-text { font-size: var(--agy-fs-sm); color: var(--agy-text-2); }
    .agy-bar { height: 3px; border-radius: 2px; background: var(--agy-surface-2); overflow: hidden; position: relative; }
    .agy-bar > span { display: block; height: 100%; width: 0; background: var(--agy-running); transition: width var(--agy-dur-fast) var(--agy-ease); }
    .agy-bar--busy > span { width: 40%; animation: agy-slide 1.4s ease-in-out infinite; }
    .agy-command { display: flex; align-items: stretch; gap: 0; width: 100%; max-width: 360px; border: 1px solid var(--agy-border-strong); border-radius: var(--agy-radius-md); overflow: hidden; background: rgba(0,0,0,0.25); text-align: left; }
    .agy-command code { flex: 1; min-width: 0; padding: 6px 10px; font: var(--agy-fs-sm)/1.5 var(--agy-mono); color: var(--agy-text); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
    .agy-command-copy { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; padding: 0 10px; border: none; border-left: 1px solid var(--agy-border); background: var(--agy-surface-1); color: var(--agy-text-2); font: 500 var(--agy-fs-sm)/1 var(--agy-font); cursor: pointer; }
    .agy-command-copy:hover { color: var(--agy-text); background: var(--agy-surface-2); }
    .agy-setup-error { width: 100%; max-width: 360px; text-align: left; }
    .agy-setup-error code { display: block; max-height: 96px; overflow: auto; padding: 6px 8px; border-radius: var(--agy-radius-sm); background: color-mix(in srgb, var(--agy-danger) 10%, transparent); color: #fca5a5; font: var(--agy-fs-sm)/1.5 var(--agy-mono); white-space: pre-wrap; word-break: break-word; }
    .agy-setup-note { max-width: 340px; font-size: var(--agy-fs-sm); color: var(--agy-text-2); overflow-wrap: anywhere; }
    .agy-setup-log { width: 100%; max-width: 360px; text-align: left; font-size: var(--agy-fs-sm); }
    .agy-setup-log summary { cursor: pointer; color: var(--agy-text-3); }
    .agy-setup-log pre { margin: 4px 0 0; max-height: 120px; overflow: auto; padding: 6px 8px; background: rgba(0,0,0,0.25); border-radius: var(--agy-radius-sm); font: var(--agy-fs-xs)/1.45 var(--agy-mono); color: var(--agy-text-3); white-space: pre-wrap; word-break: break-all; }
    .agy-setup-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 2px; }
    .agy-setup--path .agy-setup-actions { justify-content: flex-start; }
    .agy-setup-guide { font-size: var(--agy-fs-sm); color: var(--agy-link); text-decoration: none; }
    .agy-setup-guide:hover { text-decoration: underline; }
    .agy-setup.agy-nudge { animation: agy-nudge 0.5s var(--agy-ease); }

    /* ── Bottom: banner, queue, project bar, attachments, input, hints, toolbar ── */
    .agy-bottom { flex-shrink: 0; position: relative; z-index: 10; margin: 0 8px 8px; padding-bottom: 4px; border-radius: var(--agy-radius-lg); background: var(--agy-surface-1); }
    .agy-banner { display: flex; align-items: center; gap: 8px; margin: 8px 8px 0; padding: 6px 10px; border: 1px solid var(--agy-border); border-radius: var(--agy-radius-md); box-shadow: inset 2px 0 0 var(--agy-running); font-size: var(--agy-fs-sm); color: var(--agy-text-2); }
    .agy-banner[data-tone="warn"] { box-shadow: inset 2px 0 0 var(--agy-warning); }
    .agy-banner[data-tone="err"] { box-shadow: inset 2px 0 0 var(--agy-danger); }
    .agy-banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .agy-banner .agy-action { height: 22px; font-size: var(--agy-fs-sm); }
    .agy-queue { margin: 8px 8px 0; padding: 6px 8px; border: 1px solid var(--agy-border); border-radius: var(--agy-radius-md); max-height: 140px; overflow-y: auto; }
    .agy-queue-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; font-size: var(--agy-fs-sm); font-weight: 600; color: var(--agy-text-2); }
    .agy-queue-badge { display: inline-block; min-width: 16px; margin-left: 4px; padding: 0 4px; border-radius: var(--agy-radius-pill); background: var(--agy-surface-3); color: var(--agy-text); font-size: var(--agy-fs-xs); text-align: center; }
    .agy-queue-actions { display: flex; gap: 4px; }
    .agy-queue-item { display: flex; align-items: center; gap: 4px; margin-bottom: 2px; padding: 3px 6px; border-radius: var(--agy-radius-sm); background: var(--agy-surface-1); font-size: var(--agy-fs-sm); color: var(--agy-text-2); }
    .agy-queue-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agy-projectbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px 10px 0; }
    .agy-folder-chip { display: inline-flex; align-items: center; gap: 2px; max-width: 140px; padding: 1px 2px 1px 6px; border-radius: var(--agy-radius-sm); background: var(--agy-surface-2); color: var(--agy-text-2); font-size: var(--agy-fs-xs); }
    .agy-folder-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agy-folder-chip button { border: none; background: none; color: var(--agy-text-3); cursor: pointer; padding: 0 3px; font-size: var(--agy-fs-md); line-height: 1; }
    .agy-folder-chip button:hover { color: var(--agy-text); }
    .agy-bar-action { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: var(--agy-radius-sm); background: none; color: var(--agy-text-3); cursor: pointer; }
    .agy-bar-action:hover:not(:disabled) { color: var(--agy-text); background: var(--agy-surface-2); }
    .agy-bar-action:disabled { opacity: 0.4; cursor: not-allowed; }
    .agy-bar-action svg { width: 12px; height: 12px; }
    .agy-staged { display: flex; gap: 6px; padding: 6px 10px 0; overflow-x: auto; }
    .agy-input-wrap { position: relative; margin: 8px 8px 2px; padding: 1px; border-radius: var(--agy-radius-lg); background: var(--agy-border-input); transition: background var(--agy-dur-fast), box-shadow var(--agy-dur-fast); min-width: 0; }
    .agy-input-wrap:focus-within { background: var(--agy-focus); box-shadow: 0 0 0 1px var(--agy-focus); }
    .agy-panel.agy-dragging .agy-input-wrap { background: var(--agy-running); }
    .agy-input-shell { display: flex; align-items: flex-end; gap: 4px; padding: 5px 5px 5px 14px; border-radius: calc(var(--agy-radius-lg) - 1px); background: var(--agy-pop-bg); }
    .agy-input {
      flex: 1; min-width: 0; resize: none; border: none; outline: none; background: transparent; color: var(--agy-text);
      font: var(--agy-fs-lg)/1.5 var(--agy-font); padding: 6px 0; max-height: 180px; overflow-y: auto; overflow-wrap: break-word; scrollbar-width: thin;
    }
    .agy-panel .agy-input:focus-visible { outline: none; }
    /* Detached, the floating windows' focus rule (styles.css, --fw-focus) would ring the textarea too: the wrap rings it. */
    html body .agy-panel.sp-floating .agy-input-shell .agy-input:focus-visible { outline: none; }
    .agy-input:disabled { opacity: 0.6; }
    .agy-send, .agy-mic {
      width: 28px; height: 28px; flex-shrink: 0; align-self: flex-end; display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--agy-border); border-radius: var(--agy-radius-md); background: transparent; color: var(--agy-text-3); cursor: pointer;
      transition: background var(--agy-dur-fast), color var(--agy-dur-fast), border-color var(--agy-dur-fast);
    }
    .agy-send:not(:disabled) { color: var(--agy-on-solid); border-color: transparent; background: var(--agy-solid); }
    .agy-send:hover:not(:disabled) { background: var(--agy-solid-hover); }
    .agy-send:disabled { opacity: 0.5; cursor: default; }
    .agy-send[data-mode="stop"] { border-color: var(--agy-danger); background: transparent; color: var(--agy-danger); }
    .agy-send[data-mode="stop"]:hover:not(:disabled) { background: var(--agy-surface-1); }
    .agy-send[data-mode="queue"]:not(:disabled) { background: transparent; color: var(--agy-text); border-color: var(--agy-border-strong); }
    .agy-send svg, .agy-mic svg { width: 12px; height: 12px; }
    .agy-mic:hover { color: var(--agy-text); border-color: var(--agy-border-strong); }
    .agy-mic.recording { color: var(--agy-warning); border-color: var(--agy-warning); animation: agy-working 1.6s ease-in-out infinite; }
    .agy-panel.agy-blocked .agy-send { opacity: 0.4; cursor: not-allowed; }
    .agy-hints { margin: 4px 8px; max-height: 220px; overflow-y: auto; background: var(--agy-pop-bg); border: 1px solid var(--agy-border); border-radius: var(--agy-radius-md); padding: 4px; }
    .agy-hint-group { padding: 4px 8px 2px; font-size: var(--agy-fs-xs); font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--agy-text-3); }
    .agy-hint { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 5px 8px; border-radius: var(--agy-radius-sm); font-size: var(--agy-fs-md); color: var(--agy-text-2); cursor: pointer; }
    .agy-hint.active, .agy-hint:hover { background: var(--agy-surface-2); color: var(--agy-text); }
    .agy-hint-name { flex-shrink: 0; font: 500 var(--agy-fs-md)/1.4 var(--agy-mono); color: var(--agy-text); }
    .agy-hint-arg { color: var(--agy-text-3); font-family: var(--agy-mono); font-size: var(--agy-fs-sm); }
    .agy-hint-desc { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--agy-fs-sm); color: var(--agy-text-3); }
    .agy-hint-empty { padding: 6px 8px; font-size: var(--agy-fs-sm); color: var(--agy-text-3); }
    .agy-footer { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 10px 2px; flex-wrap: wrap; }
    .agy-footer-left { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 auto; }
    .agy-footer-right { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; row-gap: 4px; justify-content: flex-end; min-width: 0; }
    .agy-brand-link { display: inline-flex; color: var(--agy-brand); line-height: 0; flex-shrink: 0; }
    .agy-brand-link svg { width: 15px; height: 15px; }
    .agy-attach { display: inline-flex; align-items: center; padding: 2px 4px; border: none; background: none; color: var(--agy-text-3); cursor: pointer; flex-shrink: 0; }
    .agy-attach:hover:not(:disabled) { color: var(--agy-text); }
    .agy-attach svg { width: 13px; height: 13px; }
    .agy-status-line { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--agy-fs-xs); color: var(--agy-text-3); }
    .agy-status-line.working { color: var(--agy-running); }
    .agy-status-line.attention { color: var(--agy-warning); }

    /* Bypass (agy-bypass.js): the tab runs tools without asking. Danger everywhere it shows, like the Claude panel's. */
    .agy-panel .agy-footer .cc-dropdown[data-state="bypass"] .cc-dropdown-trigger,
    .agy-panel .agy-footer .cc-dropdown[data-state="bypass"] .cc-dropdown-trigger:hover:not(:disabled) { color: var(--agy-danger); }
    .agy-panel .agy-footer .cc-dropdown[data-state="bypass"] .cc-dropdown-arrow { stroke: var(--agy-danger); }
    .agy-bypass-strip {
      margin: 0 12px 6px; padding: 5px 9px; border: 1px solid color-mix(in srgb, var(--agy-danger) 45%, transparent);
      border-radius: var(--agy-radius-md); background: color-mix(in srgb, var(--agy-danger) 10%, transparent);
      color: var(--agy-danger); font: 500 var(--agy-fs-sm)/var(--agy-lh-tight) var(--agy-font);
    }
    .agy-panel[data-bypass] .agy-input-shell { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agy-danger) 55%, transparent); }
    .agy-bypass-badge {
      flex-shrink: 0; margin-left: 6px; padding: 1px 6px; border: 1px solid color-mix(in srgb, var(--agy-danger) 55%, transparent);
      border-radius: var(--agy-radius-pill); color: var(--agy-danger); font: 600 var(--agy-fs-xs)/1.3 var(--agy-font);
    }
    .agy-tab.bypass .agy-tab-label { color: var(--agy-danger); }
    .agy-bypass-confirm {
      display: flex; flex-direction: column; gap: 8px; margin: 0 12px 6px; padding: 9px 10px;
      border: 1px solid color-mix(in srgb, var(--agy-danger) 45%, transparent); border-radius: var(--agy-radius-md);
      background: var(--agy-pop-bg); color: var(--agy-text-2); font-size: var(--agy-fs-sm); line-height: var(--agy-lh-tight);
    }
    .agy-bypass-confirm[hidden], .agy-bypass-strip[hidden], .agy-bypass-badge[hidden] { display: none; }
    .agy-bypass-confirm-text { display: flex; flex-direction: column; gap: 3px; }
    .agy-bypass-confirm-text strong { color: var(--agy-danger); font-weight: 600; }
    .agy-bypass-confirm-actions { display: flex; justify-content: flex-end; gap: 6px; }
    .agy-bypass-confirm .agy-action { height: 22px; font-size: var(--agy-fs-sm); }

    /* Footer pickers: the app's .cc-dropdown, drawn flat like the Codex footer's. */
    .agy-panel .agy-footer .cc-dropdown, .agy-panel .agy-projectbar .cc-dropdown { min-width: 0; max-width: 180px; flex-shrink: 1; }
    .agy-panel .agy-footer .cc-dropdown-trigger, .agy-panel .agy-projectbar .cc-dropdown-trigger {
      min-width: 0; padding: 3px 5px; gap: 3px; border: none; border-radius: var(--agy-radius-sm); background: transparent;
      color: var(--agy-text-3); font: 500 var(--agy-fs-xs)/1.3 var(--agy-font); letter-spacing: normal;
    }
    .agy-panel .agy-projectbar .cc-dropdown-trigger { color: var(--agy-text-2); }
    .agy-panel :is(.agy-footer, .agy-projectbar) .cc-dropdown-trigger:hover:not(:disabled) { background: var(--agy-surface-1); color: var(--agy-text-2); }
    .agy-panel :is(.agy-footer, .agy-projectbar) .cc-dropdown.open .cc-dropdown-trigger { background: var(--agy-surface-2); color: var(--agy-text); }
    .agy-panel :is(.agy-footer, .agy-projectbar) .cc-dropdown-trigger:disabled { opacity: 0.45; cursor: default; }
    .agy-panel :is(.agy-footer, .agy-projectbar) .cc-dropdown-arrow { width: 9px; height: 9px; stroke: var(--agy-text-3); }
    .agy-panel .cc-dropdown-menu, .agy-pop .cc-dropdown-menu {
      min-width: 200px; max-width: 320px; max-height: 280px; overflow-y: auto; padding: 4px; background: var(--agy-pop-bg);
      border: 1px solid var(--agy-border); border-radius: var(--agy-radius-md); box-shadow: var(--agy-shadow-pop);
    }
    .agy-panel .cc-dropdown-item, .agy-pop .cc-dropdown-item { padding: 6px 10px; font: var(--agy-fs-sm)/1.4 var(--agy-font); color: var(--agy-text-2); border-radius: var(--agy-radius-sm); }
    .agy-panel .cc-dropdown-item:hover, .agy-panel .cc-dropdown-item.highlight, .agy-pop .cc-dropdown-item:hover, .agy-pop .cc-dropdown-item.highlight { background: var(--agy-surface-1); color: var(--agy-text); }
    .agy-panel .cc-dropdown-item.active, .agy-pop .cc-dropdown-item.active { background: var(--agy-surface-2); color: var(--agy-text); }
    .agy-panel .cc-dropdown-group, .agy-pop .cc-dropdown-group { padding: 6px 10px 2px; font-size: var(--agy-fs-xs); font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; color: var(--agy-text-3); }

    /* ── Popovers: the session menu, Session settings, the folder menu (children of <body>) ── */
    .agy-pop {
      position: fixed; z-index: 100000; min-width: 240px; max-width: 360px; max-height: min(480px, calc(100vh - 32px)); overflow-y: auto;
      padding: 4px; background: var(--agy-pop-bg); border: 1px solid var(--agy-border-strong); border-radius: var(--agy-radius-md); box-shadow: var(--agy-shadow-pop);
      font: var(--agy-fs-md)/1.4 var(--agy-font); color: var(--agy-text); scrollbar-width: thin; scrollbar-color: var(--agy-border-strong) transparent;
    }
    .agy-pop-wide { width: 320px; max-width: calc(100vw - 32px); }
    .agy-pop-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: none; border-radius: var(--agy-radius-sm); background: none; color: var(--agy-text-2); font: inherit; text-align: left; cursor: pointer; }
    .agy-pop-item:hover, .agy-pop-item:focus-visible, .agy-pop-item.active { background: var(--agy-surface-2); color: var(--agy-text); outline: none; }
    .agy-pop-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .agy-pop-item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--agy-fs-sm); }
    .agy-pop-item-meta { font-size: var(--agy-fs-xs); color: var(--agy-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agy-pop-row-actions { display: inline-flex; gap: 2px; opacity: 0; transition: opacity var(--agy-dur-fast); }
    .agy-pop-row:hover .agy-pop-row-actions, .agy-pop-row:focus-within .agy-pop-row-actions { opacity: 1; }
    .agy-pop-row { position: relative; display: flex; align-items: center; border-radius: var(--agy-radius-sm); }
    .agy-pop-row.active { background: var(--agy-surface-2); }
    .agy-pop-search { display: block; box-sizing: border-box; width: calc(100% - 8px); margin: 4px; height: 26px; padding: 0 8px; border: 1px solid var(--agy-border-input); border-radius: var(--agy-radius-sm); background: rgba(0,0,0,0.25); color: var(--agy-text); font: var(--agy-fs-sm)/1.4 var(--agy-font); }
    .agy-pop-note { padding: 8px; font-size: var(--agy-fs-sm); color: var(--agy-text-3); }
    .agy-pop-sep { height: 1px; margin: 4px 0; background: var(--agy-border); }
    .agy-pop-confirm { display: flex; align-items: center; gap: 6px; padding: 6px 8px; font-size: var(--agy-fs-sm); color: var(--agy-text-2); }
    .agy-pop-confirm .agy-action { height: 22px; font-size: var(--agy-fs-sm); }
    .agy-sec { padding: 6px 4px; border-top: 1px solid var(--agy-border); }
    .agy-sec:first-child { border-top: none; }
    .agy-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 4px 4px; }
    .agy-sec-title { font-size: var(--agy-fs-xs); font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--agy-text-3); }
    .agy-sec-head .agy-action { height: 22px; padding: 0 8px; font-size: var(--agy-fs-sm); }
    .agy-kv { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 28px; padding: 0 4px; font-size: var(--agy-fs-sm); }
    .agy-kv-label { color: var(--agy-text-2); flex-shrink: 0; }
    .agy-kv-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--agy-text); text-align: right; }
    .agy-kv-value.muted { color: var(--agy-text-3); }
    .agy-kv-value.mono { font-family: var(--agy-mono); font-size: var(--agy-fs-xs); }
    .agy-kv-value button { border: none; background: none; color: inherit; font: inherit; cursor: pointer; padding: 0; }
    .agy-kv .cc-dropdown { min-width: 0; max-width: 60%; }
    .agy-kv .cc-dropdown-trigger { min-width: 120px; background: var(--agy-surface-1); border: 1px solid var(--agy-border); border-radius: var(--agy-radius-sm); color: var(--agy-text); font: var(--agy-fs-sm)/1.3 var(--agy-font); }
    .agy-kv-help { padding: 0 4px 4px; font-size: var(--agy-fs-xs); color: var(--agy-text-3); line-height: 1.45; }
    .agy-ctx-bar { height: 4px; margin: 4px 4px 2px; border-radius: 2px; background: var(--agy-surface-2); overflow: hidden; }
    .agy-ctx-bar > span { display: block; height: 100%; background: var(--agy-text-2); }
    .agy-ctx-bar.high > span { background: var(--agy-pressure-high); }
    .agy-ctx-bar.critical > span { background: var(--agy-pressure-critical); }
    .agy-switch { position: relative; width: 28px; height: 16px; flex-shrink: 0; border: none; border-radius: var(--agy-radius-pill); background: var(--agy-surface-3); cursor: pointer; padding: 0; transition: background var(--agy-dur-fast); }
    .agy-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--agy-text-2); transition: transform var(--agy-dur-fast) var(--agy-ease); }
    .agy-switch[aria-checked="true"] { background: var(--agy-running); }
    .agy-switch[aria-checked="true"]::after { transform: translateX(12px); background: #fff; }
    .agy-switch:disabled { opacity: 0.45; cursor: not-allowed; }
    .agy-seg { display: inline-flex; border: 1px solid var(--agy-border); border-radius: var(--agy-radius-sm); overflow: hidden; }
    .agy-seg button { padding: 3px 8px; border: none; background: none; color: var(--agy-text-3); font: 500 var(--agy-fs-xs)/1.3 var(--agy-font); cursor: pointer; }
    .agy-seg button + button { border-left: 1px solid var(--agy-border); }
    .agy-seg button[aria-pressed="true"] { background: var(--agy-surface-2); color: var(--agy-text); }

    /* ── The tray pill ── */
    .agy-session-pill .agy-mark { color: var(--agy-brand); }
    .agy-session-pill.agy-pill-running .term-minimized-pill-label::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: var(--agy-running); vertical-align: middle; animation: agy-working 1.6s ease-in-out infinite; }
    .agy-session-pill.agy-pill-attention { border-color: color-mix(in srgb, var(--agy-warning) 42%, transparent); }
    .agy-session-pill.agy-pill-attention .term-minimized-pill-icon { color: var(--agy-warning); }

    /* Narrow panels: the toolbar's labels give way first. */
    .agy-panel { container: agy-panel / inline-size; }
    @container agy-panel (width < 380px) {
      .agy-footer .cc-dropdown { max-width: 110px; }
      .agy-status-line { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .agy-panel { transition: none; }
      .agy-panel *, .agy-pop * { animation: none !important; transition: none !important; }
    }
  `;
  document.head.appendChild(style);
}
