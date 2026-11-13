// SynaBun — Maritaca Panel: Styles
//
// The Codex / Antigravity panels' visual language (DESIGN.md → Codex sidepanel `panel-codex`): the same shell,
// surfaces, edges, text levels, radii, type sizes and motion, under the panel's own --mtc-* names with the same
// values. The one colour of its own is the provider's (provider-icons.js PROVIDER_META.maritaca, Maritaca's green):
// its mark and nothing else. Every rule below uses a token; add a value to the block first.

export function injectMaritacaStyles() {
  if (document.getElementById('maritaca-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'maritaca-panel-styles';
  style.textContent = `
    .mtc-panel, .mtc-session-pill, .mtc-pop {
      --mtc-shell: rgba(16, 18, 22, 0.92);
      --mtc-shell-border: rgba(255,255,255,0.08);
      --mtc-pop-bg: rgb(22, 22, 26);
      --mtc-surface-1: var(--s-subtle);
      --mtc-surface-2: var(--s-hover);
      --mtc-surface-3: var(--s-active);
      --mtc-border: var(--b-light);
      --mtc-border-strong: var(--b-visible);
      --mtc-border-input: rgba(255,255,255,0.36);
      --mtc-text: var(--t-bright);
      --mtc-text-2: var(--t-primary);
      --mtc-text-3: var(--t-secondary);
      --mtc-text-off: var(--t-muted);
      --mtc-solid: #ededed;
      --mtc-solid-hover: #ffffff;
      --mtc-on-solid: #171717;
      --mtc-running: #0ea5e9;
      --mtc-success: #22c55e;
      --mtc-warning: #f59e0b;
      --mtc-danger: #ef4444;
      --mtc-link: var(--accent-blue);
      --mtc-focus: var(--t-primary);
      --mtc-brand: #70d44b;
      --mtc-radius-sm: 4px;
      --mtc-radius-md: var(--r-card);
      --mtc-radius-lg: 12px;
      --mtc-radius-pill: 999px;
      --mtc-radius-shell: 16px;
      --mtc-space-1: 4px;
      --mtc-space-2: 8px;
      --mtc-space-3: 12px;
      --mtc-space-4: 16px;
      --mtc-font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --mtc-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
      --mtc-fs-xs: calc(10px * var(--font-scale, 1));
      --mtc-fs-sm: calc(11px * var(--font-scale, 1));
      --mtc-fs-md: calc(12px * var(--font-scale, 1));
      --mtc-fs-lg: calc(13px * var(--font-scale, 1));
      --mtc-lh-tight: 1.35;
      --mtc-lh: 1.6;
      --mtc-dur: 0.25s;
      --mtc-dur-fast: 150ms;
      --mtc-ease: cubic-bezier(0.2, 0, 0, 1);
      --mtc-shadow-pop: 0 8px 24px rgba(0,0,0,0.35);
      /* The sibling panels' values: the cards of the header and the composer (the Claude panel's), the context
         pressure of the cog's dot and the meter (Claude / Codex / OpenCode), the dialog's scrim (Codex). */
      --mtc-card-bg: rgba(22, 22, 26, 0.95);
      --mtc-card-ring: 0 0 0 1px rgba(255,255,255,0.06);
      --mtc-radius-card: 10px;
      --mtc-pressure-high: #d4a848;
      --mtc-pressure-critical: #ef7070;
      --mtc-scrim: rgba(0,0,0,0.55);
      --mtc-space-5: 24px;
    }
    .mtc-panel {
      position: fixed; top: calc(var(--navbar-height, 48px) + 20px); right: 20px; width: 22%; min-width: 320px; max-width: 700px; bottom: 20px; z-index: 205;
      display: flex; flex-direction: column; background: var(--mtc-shell); backdrop-filter: blur(28px) saturate(1.45); -webkit-backdrop-filter: blur(28px) saturate(1.45);
      border: 0.5px solid var(--mtc-shell-border); border-radius: var(--mtc-radius-shell);
      box-shadow: 0 0 0 0.5px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.15), 0 4px 8px rgba(0,0,0,0.12), 0 12px 24px rgba(0,0,0,0.14), 0 32px 64px rgba(0,0,0,0.18);
      overflow: hidden; transform: translateX(calc(100% + 20px)); opacity: 0; transition: transform var(--mtc-dur) var(--mtc-ease), opacity var(--mtc-dur) ease;
      font-family: var(--mtc-font); font-size: var(--mtc-fs-md); color: var(--mtc-text);
    }
    .mtc-panel.open { transform: translateX(0); opacity: 1; overflow: visible; }
    html.platform-win32 .mtc-panel, html.desktop-titlebar--win32 .mtc-panel { backdrop-filter: none; -webkit-backdrop-filter: none; }
    .mtc-panel:has(.cc-dropdown.open) { z-index: 99999; }
    .mtc-panel :is(a, button, input, textarea, summary, [tabindex]):focus-visible, .mtc-pop :is(a, button, input, textarea, summary, [tabindex]):focus-visible, .mtc-session-pill:focus-visible { outline: 2px solid var(--mtc-focus); outline-offset: 2px; }
    .mtc-panel input::placeholder, .mtc-panel textarea::placeholder, .mtc-pop input::placeholder, .mtc-pop textarea::placeholder { color: var(--mtc-text-3); opacity: 1; }
    .mtc-panel [hidden], .mtc-pop [hidden] { display: none !important; }
    .mtc-resize-handle { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 2; }

    /* The header and the composer are the Claude panel's two cards: one dark fill, a hairline ring, the small shadow. */
    .mtc-header { position: relative; display: flex; align-items: center; flex-shrink: 0; margin: 8px 8px 0; padding: 10px 10px 10px 14px; border-radius: var(--mtc-radius-card); background: var(--mtc-card-bg); box-shadow: var(--shadow-sm), var(--mtc-card-ring); z-index: 3; container: mtc-header / inline-size; }
    .mtc-session-btn { display: flex; align-items: center; gap: 6px; min-width: 32px; flex: 1 0 88px; max-width: max-content; overflow: hidden; padding: 5px 10px; border: none; border-radius: var(--mtc-radius-md) 0 0 var(--mtc-radius-md); background: var(--mtc-surface-1); color: var(--mtc-text-2); font: 400 var(--mtc-fs-sm)/1.2 var(--mtc-font); cursor: pointer; transition: background var(--mtc-dur-fast), color var(--mtc-dur-fast); }
    .mtc-session-btn:hover, .mtc-session-btn[aria-expanded="true"] { background: var(--mtc-surface-2); color: var(--mtc-text); }
    .mtc-session-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
    .mtc-session-label input { width: 100%; min-width: 0; border: none; outline: none; background: transparent; color: var(--mtc-text); font: inherit; padding: 0; }
    .mtc-dd-arrow { font-size: var(--mtc-fs-xs); color: var(--mtc-text-3); flex-shrink: 0; }
    .mtc-mark { width: 14px; height: 14px; flex: 0 0 auto; display: inline-flex; color: var(--mtc-brand); }
    .mtc-mark svg { width: 14px; height: 14px; }
    .mtc-header-rename { display: inline-flex; align-items: center; justify-content: center; width: 24px; align-self: stretch; flex-shrink: 0; margin-right: 3px; border: none; border-left: 1px solid var(--mtc-border); border-radius: 0 var(--mtc-radius-md) var(--mtc-radius-md) 0; background: var(--mtc-surface-1); color: var(--mtc-text-3); cursor: pointer; }
    .mtc-header-rename:hover:not(:disabled) { color: var(--mtc-text); background: var(--mtc-surface-2); }
    .mtc-header-rename:disabled { opacity: 0.4; cursor: not-allowed; }
    .mtc-header-rename svg { width: 12px; height: 12px; }
    .mtc-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; flex-shrink: 0; }
    .mtc-btn { position: relative; width: 24px; height: 24px; padding: 0; border: none; border-radius: var(--mtc-radius-md); display: inline-flex; align-items: center; justify-content: center; background: var(--mtc-surface-1); color: var(--mtc-text-3); cursor: pointer; transition: background var(--mtc-dur-fast), color var(--mtc-dur-fast); }
    .mtc-btn:hover:not(:disabled) { background: var(--mtc-surface-2); color: var(--mtc-text); }
    .mtc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .mtc-btn svg { width: 12px; height: 12px; }
    .mtc-btn-danger:hover:not(:disabled) { color: var(--mtc-danger); }
    /* The cog: Context settings (the context window, the conversation, the connection; Settings from there). Its one
       decoration is a dot: context pressure from 80% / 90% of the window, or the warning colour while no key is set. */
    .mtc-btn.mtc-cog svg { width: 14px; height: 14px; }
    .mtc-btn.mtc-cog[aria-expanded="true"] { background: var(--mtc-surface-2); color: var(--mtc-text); }
    .mtc-cog-dot { position: absolute; top: 2px; right: 2px; width: 6px; height: 6px; border-radius: var(--mtc-radius-pill); background: var(--mtc-pressure-high); pointer-events: none; }
    .mtc-cog-dot-critical { background: var(--mtc-pressure-critical); }
    .mtc-cog-dot-nokey { background: var(--mtc-warning); }

    .mtc-tabs { display: flex; gap: 4px; padding: 6px 12px 0; overflow-x: auto; scrollbar-width: none; flex-shrink: 0; }
    .mtc-tabs:empty { display: none; }
    .mtc-tab { display: inline-flex; align-items: center; gap: 6px; max-width: 180px; padding: 3px 6px 3px 8px; flex-shrink: 0; border: 1px solid var(--mtc-border); border-radius: var(--mtc-radius-md); background: transparent; color: var(--mtc-text-3); font: var(--mtc-fs-sm)/1.35 var(--mtc-font); cursor: pointer; }
    .mtc-tab:hover { background: var(--mtc-surface-1); color: var(--mtc-text-2); }
    .mtc-tab[aria-selected="true"] { background: var(--mtc-surface-2); color: var(--mtc-text); border-color: var(--mtc-border-strong); }
    .mtc-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mtc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--mtc-text-off); flex: 0 0 auto; }
    .mtc-tab.running .mtc-dot { background: var(--mtc-running); animation: mtc-working 1.6s ease-in-out infinite; }
    .mtc-tab-close { border: 0; background: none; color: var(--mtc-text-3); cursor: pointer; padding: 0 2px; font-size: var(--mtc-fs-lg); line-height: 1; border-radius: var(--mtc-radius-sm); }
    .mtc-tab-close:hover { color: var(--mtc-text); background: var(--mtc-surface-2); }
    @keyframes mtc-working { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

    .mtc-messages-container { position: relative; flex: 1; min-height: 0; overflow: hidden; margin: 6px 8px; }
    .mtc-transcript { position: absolute; inset: 0; overflow-x: hidden; overflow-y: auto; padding: 12px 0 8px; display: flex; flex-direction: column; font-size: var(--mtc-fs-md); line-height: var(--mtc-lh); scrollbar-width: thin; scrollbar-color: var(--mtc-border-strong) transparent; }
    .mtc-transcript::before { content: ''; margin-top: auto; }
    .mtc-jump { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 4; padding: 4px 10px; border: 1px solid var(--mtc-border-strong); border-radius: var(--mtc-radius-pill); background: var(--mtc-pop-bg); color: var(--mtc-text-2); font: 500 var(--mtc-fs-sm)/1.2 var(--mtc-font); cursor: pointer; box-shadow: var(--mtc-shadow-pop); }
    .mtc-empty { margin: auto 0; min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px 18px; text-align: center; color: var(--mtc-text-3); }
    .mtc-empty-mark { display: flex; color: var(--mtc-brand); opacity: 0.7; }
    .mtc-empty-mark svg { width: 32px; height: 36px; }
    .mtc-empty-name { font-size: var(--mtc-fs-lg); font-weight: 500; color: var(--mtc-text-3); }
    .mtc-empty-status { font-size: var(--mtc-fs-sm); line-height: 1.5; max-width: 320px; }
    .mtc-empty-actions { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: 6px; }
    .mtc-link { color: var(--mtc-link); font-size: var(--mtc-fs-sm); text-decoration: none; }
    .mtc-link:hover { text-decoration: underline; }

    .mtc-system { align-self: center; box-sizing: border-box; max-width: calc(100% - 32px); margin: 4px 16px; padding: 4px 0; font-size: var(--mtc-fs-sm); line-height: 1.45; color: var(--mtc-text-3); text-align: center; overflow-wrap: anywhere; white-space: pre-wrap; flex-shrink: 0; }
    .mtc-system.error { color: var(--mtc-danger); }
    .mtc-system.warning { color: var(--mtc-warning); }
    .mtc-system.working { color: var(--mtc-running); align-self: flex-start; margin-left: var(--mtc-space-2); }
    .mtc-system.working::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentColor; vertical-align: 1px; animation: mtc-working 1.6s ease-in-out infinite; }
    .mtc-msg { display: flex; padding: var(--mtc-space-2); flex-shrink: 0; min-width: 0; }
    .mtc-msg-user { justify-content: flex-end; padding: var(--mtc-space-3) var(--mtc-space-2) var(--mtc-space-1); }
    .mtc-msg-user .mtc-msg-card { max-width: 85%; border-radius: var(--mtc-radius-lg); background: var(--mtc-surface-2); padding: var(--mtc-space-2) var(--mtc-space-3); }
    .mtc-msg-text { white-space: pre-wrap; word-break: break-word; font-size: var(--mtc-fs-md); line-height: var(--mtc-lh); }
    .mtc-msg-agent { flex-direction: column; color: var(--mtc-text); word-break: break-word; gap: 4px; }
    .mtc-md { font-size: var(--mtc-fs-md); line-height: var(--mtc-lh); color: var(--mtc-text); min-width: 0; overflow-wrap: anywhere; }
    .mtc-md > :first-child { margin-top: 0; } .mtc-md > :last-child { margin-bottom: 0; }
    .mtc-md :is(p, ul, ol, pre, blockquote, table) { margin: 0 0 8px; }
    .mtc-md :is(h1, h2, h3, h4) { margin: 12px 0 6px; font-size: var(--mtc-fs-lg); font-weight: 600; line-height: var(--mtc-lh-tight); }
    .mtc-md :is(ul, ol) { padding-left: 18px; }
    .mtc-md a { color: var(--mtc-link); }
    .mtc-md code { font-family: var(--mtc-mono); font-size: 0.92em; background: var(--mtc-surface-2); padding: 1px 4px; border-radius: var(--mtc-radius-sm); }
    .mtc-md pre { background: var(--mtc-surface-1); border-radius: var(--mtc-radius-md); padding: 8px 10px; overflow-x: auto; font: var(--mtc-fs-sm)/1.55 var(--mtc-mono); }
    .mtc-md pre code { background: none; padding: 0; }
    .mtc-md blockquote { border-left: 2px solid var(--mtc-border-strong); padding-left: 10px; color: var(--mtc-text-2); }
    .mtc-md table { border-collapse: collapse; display: block; overflow-x: auto; }
    .mtc-md :is(th, td) { border: 1px solid var(--mtc-border); padding: 3px 8px; text-align: left; }
    .mtc-thought { margin: 2px 0; font-size: var(--mtc-fs-sm); color: var(--mtc-text-3); flex-shrink: 0; }
    .mtc-thought summary { cursor: pointer; list-style: none; padding: 4px 0; display: inline-flex; align-items: center; gap: 6px; }
    .mtc-thought summary::-webkit-details-marker { display: none; }
    .mtc-thought summary::before { content: '\\25B8'; font-size: var(--mtc-fs-xs); transition: transform var(--mtc-dur-fast); }
    .mtc-thought[open] summary::before { transform: rotate(90deg); }
    .mtc-thought-body { white-space: pre-wrap; padding: 4px 0 6px 10px; border-left: 1px solid var(--mtc-border); line-height: 1.55; max-height: 240px; overflow: auto; }
    .mtc-turn-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; font-size: var(--mtc-fs-xs); color: var(--mtc-text-3); }
    .mtc-turn-meta { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
    .mtc-turn-actions { display: flex; gap: 2px; flex-shrink: 0; opacity: 0; transition: opacity var(--mtc-dur-fast); }
    .mtc-msg-agent:hover .mtc-turn-actions, .mtc-msg-agent:focus-within .mtc-turn-actions { opacity: 1; }
    .mtc-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: var(--mtc-radius-sm); background: none; color: var(--mtc-text-3); cursor: pointer; }
    .mtc-icon-btn:hover { color: var(--mtc-text); background: var(--mtc-surface-2); }
    .mtc-icon-btn svg { width: 12px; height: 12px; flex-shrink: 0; }

    .mtc-bottom { position: relative; z-index: 10; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; margin: 0 8px 8px; padding: 6px 0 4px; border-radius: var(--mtc-radius-card); background: var(--mtc-card-bg); box-shadow: var(--shadow-sm), var(--mtc-card-ring); }
    .mtc-bottom > :is(.mtc-banner, .mtc-edit-notice, .mtc-staged, .mtc-hints) { margin: 0 8px; }
    .mtc-bottom > .mtc-projectbar { padding: 0 8px; }
    .mtc-banner { padding: 6px 10px; border-radius: var(--mtc-radius-md); background: var(--mtc-surface-1); color: var(--mtc-text-2); font-size: var(--mtc-fs-sm); line-height: 1.45; }
    .mtc-banner.error { color: var(--mtc-danger); }
    .mtc-banner button { margin-left: 8px; border: none; background: none; color: var(--mtc-link); font: inherit; cursor: pointer; padding: 0; }
    .mtc-projectbar { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .mtc-projectbar .cc-dropdown { flex: 1 1 0; min-width: 0; }
    .mtc-projectbar .mtc-branch-dd { flex: 0 1 38%; }
    .mtc-projectbar .cc-dropdown[hidden] { display: none; }
    .mtc-composer { display: flex; flex-direction: column; gap: 6px; }
    .mtc-input-shell { display: flex; align-items: flex-end; gap: 4px; padding: 5px 5px 5px 14px; border: 1px solid var(--mtc-border-input); border-radius: var(--mtc-radius-lg); background: var(--mtc-surface-1); transition: border-color var(--mtc-dur-fast); }
    .mtc-input-shell:focus-within { border-color: var(--mtc-focus); }
    .mtc-input { flex: 1; min-width: 0; min-height: 22px; max-height: 180px; resize: none; border: none; outline: none; background: transparent; color: var(--mtc-text); font: var(--mtc-fs-lg)/1.5 var(--mtc-font); padding: 4px 0; overflow-wrap: break-word; scrollbar-width: thin; scrollbar-color: var(--mtc-border-strong) transparent; }
    /* Send: the panel's one solid control while there is something to send; Stop is a red outline (the Codex panel's). */
    .mtc-send { width: 28px; height: 28px; flex-shrink: 0; border: 1px solid var(--mtc-border); border-radius: var(--mtc-radius-md); background: transparent; color: var(--mtc-text-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; align-self: flex-end; transition: background var(--mtc-dur-fast), color var(--mtc-dur-fast), border-color var(--mtc-dur-fast), opacity var(--mtc-dur-fast); }
    .mtc-send:not(:disabled) { background: var(--mtc-solid); border-color: transparent; color: var(--mtc-on-solid); }
    .mtc-send:hover:not(:disabled) { background: var(--mtc-solid-hover); }
    .mtc-send:disabled { opacity: 0.5; cursor: default; }
    .mtc-send[data-mode="stop"], .mtc-send[data-mode="stop"]:not(:disabled) { background: transparent; border-color: var(--mtc-danger); color: var(--mtc-danger); }
    .mtc-send[data-mode="stop"]:hover:not(:disabled) { background: var(--mtc-surface-1); }
    .mtc-send svg { width: 12px; height: 12px; }
    .mtc-footer { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; padding: 2px 10px 0; container: mtc-footer / inline-size; }
    /* The controls on the right keep their size; the status line on the left gives way first (an ellipsis). */
    .mtc-footer-left { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 0; }
    .mtc-footer-left .mtc-status-line { flex: 1 1 auto; min-width: 0; }
    .mtc-footer-right { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; min-width: 0; }
    .mtc-footer .cc-dropdown { max-width: 160px; min-width: 0; }
    .mtc-footer .cc-dropdown-trigger { width: 100%; box-sizing: border-box; min-width: 0; max-width: 160px; border-color: transparent; background: transparent; }
    .mtc-footer .cc-dropdown-trigger:hover, .mtc-footer .cc-dropdown.open .cc-dropdown-trigger { background: var(--mtc-surface-2); border-color: var(--mtc-border); }
    .mtc-footer .cc-dropdown-menu { top: auto; bottom: calc(100% + 6px); left: auto; right: 0; min-width: 240px; max-height: 320px; overflow-y: auto; }
    .mtc-brand-link { display: inline-flex; color: var(--mtc-brand); opacity: 0.8; }
    .mtc-brand-link svg { width: 14px; height: 16px; }
    .mtc-brand-link:hover { opacity: 1; }
    .mtc-status-line { font-size: var(--mtc-fs-xs); color: var(--mtc-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .mtc-action { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px; border: 1px solid var(--mtc-border-strong); border-radius: var(--mtc-radius-md); background: transparent; color: var(--mtc-text); font: 500 var(--mtc-fs-md)/1 var(--mtc-font); text-decoration: none; cursor: pointer; user-select: none; transition: background var(--mtc-dur-fast), border-color var(--mtc-dur-fast); }
    .mtc-action:hover:not(:disabled) { background: var(--mtc-surface-2); }
    .mtc-action:disabled { opacity: 0.5; cursor: default; }
    .mtc-action.mtc-btn-primary { background: var(--mtc-solid); border-color: var(--mtc-solid); color: var(--mtc-on-solid); }
    .mtc-action.mtc-btn-primary:hover:not(:disabled) { background: var(--mtc-solid-hover); border-color: var(--mtc-solid-hover); }
    .mtc-action.mtc-btn-deny { color: var(--mtc-danger); }

    .mtc-pop { position: fixed; z-index: 100000; width: 340px; max-width: calc(100vw - 24px); max-height: min(70vh, 560px); overflow: auto; padding: 12px; border: 1px solid var(--mtc-border-strong); border-radius: var(--mtc-radius-lg); background: var(--mtc-pop-bg); color: var(--mtc-text); box-shadow: var(--mtc-shadow-pop); font-family: var(--mtc-font); font-size: var(--mtc-fs-md); display: flex; flex-direction: column; gap: 10px; }
    .mtc-pop-title { font-size: var(--mtc-fs-lg); font-weight: 600; }
    .mtc-field { display: flex; flex-direction: column; gap: 4px; font-size: var(--mtc-fs-sm); color: var(--mtc-text-2); }
    .mtc-field > span:first-child { font-weight: 500; }
    .mtc-field input[type="password"], .mtc-field input[type="number"], .mtc-field textarea, .mtc-session-search { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--mtc-border-input); border-radius: var(--mtc-radius-md); background: var(--mtc-surface-1); color: var(--mtc-text); font: var(--mtc-fs-md)/1.4 var(--mtc-font); outline: none; }
    .mtc-field input:focus, .mtc-field textarea:focus, .mtc-session-search:focus { border-color: var(--mtc-focus); }
    .mtc-field textarea { resize: vertical; min-height: 56px; }
    .mtc-field-row input[type="number"] { width: 90px; }
    .mtc-field-note { font-size: var(--mtc-fs-xs); color: var(--mtc-text-3); }
    .mtc-pop-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .mtc-pop-note { font-size: var(--mtc-fs-xs); color: var(--mtc-text-3); line-height: 1.45; min-height: 0; }
    .mtc-pop-note.error, .mtc-settings-notice.error { color: var(--mtc-danger); }
    .mtc-settings-notice.ok { color: var(--mtc-success); }
    .mtc-settings-notice:empty { display: none; }
    .mtc-pop-links { display: flex; flex-direction: column; gap: 4px; }
    .mtc-session-list { display: flex; flex-direction: column; gap: 2px; }
    .mtc-session-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 6px; padding: 6px 8px; border-radius: var(--mtc-radius-md); cursor: pointer; }
    .mtc-session-row:hover, .mtc-session-row.active { background: var(--mtc-surface-2); }
    .mtc-session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mtc-session-meta { font-size: var(--mtc-fs-xs); color: var(--mtc-text-3); white-space: nowrap; }
    .mtc-session-delete { font-size: var(--mtc-fs-lg); }

    .mtc-session-pill .term-minimized-pill-icon { color: var(--mtc-brand); display: inline-flex; }
    .mtc-session-pill .term-minimized-pill-icon svg { width: 12px; height: 13px; }
    .mtc-session-pill.mtc-pill-running .term-minimized-pill-icon { animation: mtc-working 1.6s ease-in-out infinite; }

    /* Parity states use the existing shell, tray geometry and semantic palette. */
    .mtc-panel .mtc-input:focus-visible { outline: none; }
    .mtc-panel :is(button, summary), .mtc-pop button { transition: background var(--mtc-dur-fast), color var(--mtc-dur-fast), opacity var(--mtc-dur-fast), transform var(--mtc-dur-fast); }
    .mtc-panel button:active:not(:disabled), .mtc-pop button:active:not(:disabled) { transform: translateY(1px); }
    .mtc-icon-btn:disabled { opacity: .4; cursor: default; }
    .mtc-messages-container::before, .mtc-messages-container::after { content: ''; position: absolute; left: 0; right: 0; height: 16px; z-index: 2; pointer-events: none; opacity: 0; transition: opacity var(--mtc-dur-fast); }
    .mtc-messages-container::before { top: 0; background: linear-gradient(var(--mtc-shell), transparent); }
    .mtc-messages-container::after { bottom: 0; background: linear-gradient(transparent, var(--mtc-shell)); }
    .mtc-messages-container.mtc-scroll-top::before, .mtc-messages-container.mtc-scroll-bottom::after { opacity: 1; }
    .mtc-stream-cursor { display: inline-block; width: 2px; height: 1em; background: var(--mtc-text-2); animation: mtc-working 1s ease-in-out infinite; }
    .mtc-thought.thinking summary { color: var(--mtc-text-2); text-shadow: 0 0 12px var(--mtc-text-off); animation: mtc-working 1.6s ease-in-out infinite; }
    .mtc-thought.thinking { border-left: 1px solid var(--mtc-border-strong); padding-left: var(--mtc-space-2); }
    .mtc-msg-user:hover .mtc-turn-actions, .mtc-msg-user:focus-within .mtc-turn-actions { opacity: 1; }
    .mtc-msg-user .mtc-turn-actions { justify-content: flex-end; }
    .mtc-usage-chip, .mtc-cost-pill { display: inline-flex; align-items: center; padding: 1px 5px; border-radius: var(--mtc-radius-sm); background: var(--mtc-surface-1); color: var(--mtc-text-3); font: var(--mtc-fs-xs)/1.5 var(--mtc-mono); }
    .mtc-cost-pill { color: var(--mtc-text-2); border: 1px solid var(--mtc-border); }
    .mtc-system.error { align-self: stretch; max-width: none; margin: var(--mtc-space-1) 0; padding: var(--mtc-space-2); border: 1px solid color-mix(in srgb, var(--mtc-danger) 35%, transparent); border-radius: var(--mtc-radius-md); background: color-mix(in srgb, var(--mtc-danger) 6%, transparent); text-align: left; }
    .mtc-banner { display: flex; gap: var(--mtc-space-2); align-items: flex-start; white-space: pre-wrap; }
    .mtc-banner > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .mtc-banner.error { box-shadow: inset 2px 0 0 var(--mtc-danger); }
    .mtc-banner.ok { color: var(--mtc-success); }
    .mtc-input-wrap { position: relative; margin: 2px 8px; border-radius: var(--mtc-radius-lg); padding: 1px; background: var(--mtc-border-input); min-width: 0; transition: background var(--mtc-dur-fast), box-shadow var(--mtc-dur-fast); }
    .mtc-input-shell { position: relative; border: none; border-radius: calc(var(--mtc-radius-lg) - 1px); background: var(--mtc-pop-bg); }
    .mtc-input-wrap:focus-within { background: var(--mtc-focus); box-shadow: 0 0 0 1px var(--mtc-focus); }
    .mtc-staged { display: flex; flex-wrap: wrap; gap: var(--mtc-space-1); max-height: 96px; overflow-y: auto; }
    .mtc-attachment { display: inline-flex; align-items: center; gap: var(--mtc-space-1); max-width: 100%; min-width: 0; padding: 2px 6px; background: var(--mtc-surface-2); border: 1px solid var(--mtc-border); border-radius: var(--mtc-radius-md); font-size: var(--mtc-fs-sm); }
    .mtc-attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mtc-attachment-size { color: var(--mtc-text-3); white-space: nowrap; font-family: var(--mtc-mono); }
    .mtc-attach svg { width: 16px; height: 16px; }
    .mtc-composer-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--mtc-space-2); padding: 0 10px 2px; color: var(--mtc-text-3); font-size: var(--mtc-fs-xs); }
    .mtc-edit-notice { display: flex; align-items: center; gap: var(--mtc-space-2); color: var(--mtc-text-2); font-size: var(--mtc-fs-sm); }
    .mtc-edit-notice > span { flex: 1; }
    .mtc-hints { max-height: 180px; overflow-y: auto; padding: var(--mtc-space-1); border: 1px solid var(--mtc-border); border-radius: var(--mtc-radius-md); background: var(--mtc-pop-bg); }
    .mtc-hint { display: flex; align-items: baseline; gap: var(--mtc-space-2); width: 100%; padding: 5px 8px; border: none; border-radius: var(--mtc-radius-sm); color: var(--mtc-text-2); background: transparent; font: var(--mtc-fs-sm)/1.4 var(--mtc-font); text-align: left; cursor: pointer; }
    .mtc-hint > span:first-child { font-family: var(--mtc-mono); color: var(--mtc-text); }
    .mtc-hint.active, .mtc-hint:hover { background: var(--mtc-surface-2); }
    .mtc-session-filter { display: flex; align-items: center; gap: var(--mtc-space-1); color: var(--mtc-text-2); font-size: var(--mtc-fs-sm); }
    .mtc-session-row { grid-template-columns: minmax(0, 1fr) auto; }
    .mtc-session-title { grid-column: 1; }
    .mtc-session-meta { grid-column: 1; grid-row: 2; overflow: hidden; text-overflow: ellipsis; }
    .mtc-session-delete { grid-column: 2; grid-row: 1 / 3; }
    .mtc-delete-confirm { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: var(--mtc-space-1); color: var(--mtc-text-2); font-size: var(--mtc-fs-sm); }
    .mtc-dragging .mtc-input-wrap { outline: 2px solid var(--mtc-focus); outline-offset: 2px; }
    .mtc-dragging .mtc-input-wrap::after { content: attr(data-drop-label); position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; border-radius: inherit; background: var(--mtc-pop-bg); color: var(--mtc-text); font-size: var(--mtc-fs-md); }

    /* OpenCode's compositor ring pattern: rotate a square under a masked hairline. */
    .mtc-pill-ring, .mtc-composer-ring { position: absolute; inset: 0; display: none; border-radius: inherit; padding: 1px; overflow: hidden; pointer-events: none; -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask-composite: exclude; }
    .mtc-pill-ring > i, .mtc-composer-ring > i { position: absolute; left: 50%; top: 50%; width: calc(100% + 64px); aspect-ratio: 1; translate: -50% -50%; background: conic-gradient(transparent, var(--mtc-text-2), var(--mtc-text-off), var(--mtc-text-2), transparent); animation: mtc-ring-turn 2.4s linear infinite; }
    .mtc-session-pill { position: relative; overflow: hidden; }
    .mtc-session-pill.mtc-pill-running { border-color: var(--mtc-border-strong); }
    .mtc-pill-running .mtc-pill-ring { display: block; }
    /* The composer's ring in Sabiá green (--mtc-brand), as the Claude panel's gold .cp-spin-ring and the
       Assistant's: a size container whose square (142cqmax + 4px) covers the box's diagonal at any shape,
       faded in on focus (slow turn) and while a reply streams (faster, brighter). Reduced motion (below)
       stops the turn; the ring stays as a still hairline. */
    .mtc-composer-ring { z-index: 1; display: block; container-type: size; opacity: 0; transition: opacity 0.4s; }
    .mtc-composer-ring > i { width: calc(142cqmax + 4px); animation: none; background: conic-gradient(transparent 0%, color-mix(in srgb, var(--mtc-brand) 38%, transparent) 25%, color-mix(in srgb, var(--mtc-brand) 10%, transparent) 50%, color-mix(in srgb, var(--mtc-brand) 38%, transparent) 75%, transparent 100%); }
    .mtc-input-wrap:focus-within > .mtc-composer-ring, .mtc-streaming .mtc-composer-ring { opacity: 1; }
    .mtc-input-wrap:focus-within > .mtc-composer-ring > i { animation: mtc-ring-turn 3s linear infinite; }
    .mtc-streaming .mtc-composer-ring > i { animation: mtc-ring-turn 1.8s linear infinite; background: conic-gradient(transparent 0%, color-mix(in srgb, var(--mtc-brand) 75%, transparent) 25%, color-mix(in srgb, var(--mtc-brand) 15%, transparent) 50%, color-mix(in srgb, var(--mtc-brand) 75%, transparent) 75%, transparent 100%); }
    @keyframes mtc-ring-turn { to { rotate: 360deg; } }


    /* ── Footer toggles (the Codex panel's): flat uppercase labels, an underline when on ── */
    .mtc-toolbar-toggle { position: relative; display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; padding: 4px 6px 6px; border: none; background: transparent; color: var(--mtc-text-3); font: 600 var(--mtc-fs-xs)/1 var(--mtc-font); text-transform: uppercase; cursor: pointer; transition: color var(--mtc-dur-fast); }
    .mtc-toolbar-toggle > svg { width: var(--mtc-space-3); height: var(--mtc-space-3); flex-shrink: 0; }
    .mtc-toolbar-toggle::after { content: ''; position: absolute; bottom: 0; left: 25%; right: 25%; height: 1.5px; background: var(--mtc-text-3); transform: scaleX(0); transition: transform var(--mtc-dur) var(--mtc-ease), background var(--mtc-dur-fast); }
    .mtc-toolbar-toggle:hover:not(:disabled) { color: var(--mtc-text-2); }
    .mtc-toolbar-toggle:hover:not(:disabled)::after { transform: scaleX(1); }
    .mtc-toolbar-toggle:disabled { opacity: 0.4; cursor: not-allowed; }
    .mtc-toolbar-toggle:disabled::after { transform: scaleX(0); }
    .mtc-toolbar-toggle .mtc-btn-label { font-size: var(--mtc-fs-xs); }
    .mtc-plan-toggle.active { color: var(--mtc-text); }
    .mtc-plan-toggle.active::after { transform: scaleX(1); background: var(--mtc-text); }
    /* Effort: the level reads from the lit dots and the underline's length (Off, Low, Medium, High). */
    .mtc-effort-wrap { position: relative; display: flex; align-items: center; }
    .mtc-effort-dots { display: flex; align-items: center; gap: 2px; margin-left: 2px; }
    .mtc-effort-dots i { display: block; width: 3px; height: 3px; border-radius: var(--mtc-radius-pill); background: currentColor; opacity: 0.25; transition: opacity var(--mtc-dur); }
    .mtc-effort-dots i.lit { opacity: 1; }
    .mtc-effort-toggle[data-effort="unsupported"] .mtc-effort-dots { display: none; }
    .mtc-effort-toggle[data-effort="low"]::after { transform: scaleX(0.4); }
    .mtc-effort-toggle[data-effort="medium"] { color: var(--mtc-text-2); }
    .mtc-effort-toggle[data-effort="medium"]::after { transform: scaleX(0.7); }
    .mtc-effort-toggle[data-effort="high"] { color: var(--mtc-text); }
    .mtc-effort-toggle[data-effort="high"]::after { transform: scaleX(1); background: var(--mtc-text-2); }
    .mtc-effort-toggle[aria-expanded="true"] { color: var(--mtc-text); }
    .mtc-effort-menu { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 45; width: 240px; max-height: 300px; overflow-y: auto; padding: 5px; border: 1px solid var(--mtc-border); border-radius: var(--mtc-radius-md); background: var(--mtc-pop-bg); box-shadow: var(--mtc-shadow-pop); }
    .mtc-effort-menu-item { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 7px 8px; border: 0; border-radius: var(--mtc-radius-sm); background: transparent; color: var(--mtc-text-2); font-family: var(--mtc-font); text-align: left; cursor: pointer; }
    .mtc-effort-menu-item:hover, .mtc-effort-menu-item:focus-visible { background: var(--mtc-surface-1); }
    .mtc-effort-menu-item.selected { background: var(--mtc-surface-2); color: var(--mtc-text); }
    .mtc-effort-menu-label { font-size: var(--mtc-fs-sm); font-weight: 600; }
    .mtc-effort-menu-desc { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--mtc-fs-xs); color: var(--mtc-text-3); }
    .mtc-effort-menu-empty { padding: 7px 8px; font-size: var(--mtc-fs-sm); color: var(--mtc-text-3); }
    /* A narrow footer keeps the icons and the dots; the words go first. */
    @container mtc-footer (width < 340px) {
      .mtc-toolbar-toggle .mtc-btn-label, .mtc-status-line { display: none; }
      .mtc-footer .cc-dropdown, .mtc-footer .cc-dropdown-trigger { max-width: 120px; }
    }

    /* ── Context settings popover (the sibling panels' grammar: 28px heads and rows, hairlines between sections) ── */
    .mtc-pop.mtc-ctxpop { display: block; gap: 0; width: 300px; padding: 12px; border: 1px solid var(--mtc-border); border-radius: var(--mtc-radius-md); font: 400 var(--mtc-fs-sm)/16px var(--mtc-font); font-variant-numeric: tabular-nums; outline: none; }
    .mtc-ctxpop-section + .mtc-ctxpop-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--mtc-border); }
    .mtc-ctxpop-head, .mtc-ctxpop-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 28px; }
    .mtc-ctxpop-head { margin-bottom: 4px; }
    .mtc-ctxpop-title { flex: 1 1 0; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 var(--mtc-fs-sm)/16px var(--mtc-font); color: var(--mtc-text); }
    .mtc-ctxpop-bar { height: 4px; margin: 8px 0; overflow: hidden; border-radius: var(--mtc-radius-sm); background: var(--mtc-surface-2); }
    .mtc-ctxpop-fill { height: 100%; border-radius: var(--mtc-radius-sm); background: var(--mtc-text-3); transition: width var(--mtc-dur) var(--mtc-ease); }
    .mtc-ctxpop-fill.mtc-ctxpop-high { background: var(--mtc-pressure-high); }
    .mtc-ctxpop-fill.mtc-ctxpop-critical { background: var(--mtc-pressure-critical); }
    .mtc-ctxpop-usage { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 20px; margin-bottom: 4px; }
    .mtc-ctxpop-used { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mtc-ctxpop-share { flex-shrink: 0; }
    .mtc-ctxpop-k { flex: 0 0 auto; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--mtc-text-2); }
    .mtc-ctxpop-v { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: var(--mtc-text); }
    .mtc-ctxpop-muted { color: var(--mtc-text-3); }
    .mtc-ctxpop-status { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
    .mtc-ctxpop-dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: var(--mtc-radius-pill); background: var(--mtc-text-off); }
    .mtc-ctxpop-dot-ok { background: var(--mtc-success); }
    .mtc-ctxpop-dot-warn { background: var(--mtc-warning); }
    .mtc-ctxpop-dot-err { background: var(--mtc-danger); }
    .mtc-ctxpop-link, .mtc-ctxpop-copy { height: 20px; padding: 0; border: none; background: none; font: 400 var(--mtc-fs-sm)/20px var(--mtc-font); text-decoration: none; cursor: pointer; }
    .mtc-ctxpop-link { flex: 0 0 auto; color: var(--mtc-link); }
    .mtc-ctxpop-link:hover { filter: brightness(1.2); }
    .mtc-ctxpop-copy { color: var(--mtc-text); font-family: var(--mtc-mono); }
    .mtc-ctxpop-copy:hover, .mtc-ctxpop-copy.mtc-ctxpop-copied { color: var(--mtc-link); }

    /* ── Plan mode: the chip on plan replies and the review card (the Codex panel's post-plan card) ── */
    .mtc-plan-chip { display: inline-flex; align-items: center; padding: 1px 5px; border: 1px solid var(--mtc-border-strong); border-radius: var(--mtc-radius-sm); color: var(--mtc-text-2); font: 600 var(--mtc-fs-xs)/1.5 var(--mtc-font); text-transform: uppercase; }
    .mtc-plan-msg { flex-shrink: 0; padding: 0 var(--mtc-space-2) var(--mtc-space-3); }
    .mtc-plan-card { display: grid; gap: var(--mtc-space-4); min-width: 0; padding: var(--mtc-space-3) var(--mtc-space-4); border: 1px solid var(--mtc-border-strong); border-radius: var(--mtc-radius-md); transition: opacity var(--mtc-dur-fast) ease; }
    .mtc-plan-card.is-busy { opacity: 0.72; }
    .mtc-plan-header { font-size: var(--mtc-fs-sm); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mtc-text-3); }
    .mtc-plan-note { margin-top: calc(var(--mtc-space-3) * -1); font-size: var(--mtc-fs-md); line-height: 1.5; color: var(--mtc-text-2); }
    .mtc-plan-decision { display: grid; }
    .mtc-plan-decision .mtc-request-btn { width: 100%; min-height: 36px; justify-content: center; }
    .mtc-plan-feedback-group { display: grid; gap: var(--mtc-space-2); min-width: 0; }
    .mtc-plan-feedback-label { color: var(--mtc-text-2); font: 500 var(--mtc-fs-md)/1.5 var(--mtc-font); }
    .mtc-plan-feedback { width: 100%; min-height: 56px; max-height: 132px; box-sizing: border-box; resize: none; overflow-y: auto; padding: var(--mtc-space-2) var(--mtc-space-3); border: 1px solid var(--mtc-border-input); border-radius: var(--mtc-radius-sm); background: transparent; color: var(--mtc-text); font: 400 var(--mtc-fs-md)/1.5 var(--mtc-font); transition: border-color var(--mtc-dur-fast) ease; }
    .mtc-plan-feedback:hover:not(:disabled), .mtc-plan-feedback:focus-visible { border-color: var(--mtc-text-3); }
    .mtc-plan-feedback:disabled { opacity: 0.6; }
    .mtc-plan-feedback-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--mtc-space-2); }
    .mtc-plan-feedback-hint { min-width: 0; color: var(--mtc-text-3); font: 400 var(--mtc-fs-sm)/1.5 var(--mtc-font); }
    .mtc-plan-utilities { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--mtc-space-2); }
    .mtc-plan-utilities .mtc-request-btn.secondary { border-color: transparent; color: var(--mtc-text-2); font-weight: 500; }
    .mtc-plan-utilities .mtc-request-btn.secondary:hover:not(:disabled) { border-color: transparent; background: var(--mtc-surface-2); color: var(--mtc-text); }

    /* ── Buttons of the dialog and the plan card: solid for the one primary action, hairline for the rest ── */
    .mtc-request-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 30px; padding: 5px var(--mtc-space-3); border: 1px solid transparent; border-radius: var(--mtc-radius-md); background: var(--mtc-solid); color: var(--mtc-on-solid); font: 600 var(--mtc-fs-md)/1.5 var(--mtc-font); cursor: pointer; transition: background var(--mtc-dur-fast), border-color var(--mtc-dur-fast), color var(--mtc-dur-fast); }
    .mtc-request-btn:hover:not(:disabled) { background: var(--mtc-solid-hover); }
    .mtc-request-btn.secondary, .mtc-request-btn.danger { border-color: var(--mtc-border-strong); background: transparent; color: var(--mtc-text); }
    .mtc-request-btn.danger { color: var(--mtc-danger); }
    .mtc-request-btn.secondary:hover:not(:disabled), .mtc-request-btn.danger:hover:not(:disabled) { background: var(--mtc-surface-1); border-color: var(--mtc-border-input); }
    .mtc-request-btn:disabled { opacity: 0.45; cursor: not-allowed; }

    /* ── Settings: a dialog inside the panel (the Codex panel's settings overlay) ── */
    .mtc-settings-overlay { position: absolute; inset: 0; z-index: 50; display: flex; align-items: flex-start; justify-content: center; padding-top: var(--mtc-space-5); border-radius: var(--mtc-radius-shell); background: var(--mtc-scrim); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); animation: mtc-fade-in var(--mtc-dur-fast) ease; }
    @keyframes mtc-fade-in { from { opacity: 0; } to { opacity: 1; } }
    .mtc-settings-panel { display: flex; flex-direction: column; width: 92%; max-height: calc(100% - 48px); overflow: hidden; border: 1px solid var(--mtc-border); border-radius: var(--mtc-radius-lg); background: var(--mtc-pop-bg); box-shadow: var(--mtc-shadow-pop); color: var(--mtc-text); font-family: var(--mtc-font); }
    .mtc-settings-header { display: flex; align-items: center; justify-content: space-between; gap: var(--mtc-space-2); padding: 14px 16px 12px; border-bottom: 1px solid var(--mtc-border); font-size: var(--mtc-fs-lg); font-weight: 600; }
    .mtc-settings-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mtc-settings-close { min-width: 24px; min-height: 24px; padding: 2px 4px; border: none; border-radius: var(--mtc-radius-sm); background: none; color: var(--mtc-text-3); font-size: var(--mtc-fs-lg); line-height: 1; cursor: pointer; }
    .mtc-settings-close:hover { color: var(--mtc-text); background: var(--mtc-surface-2); }
    .mtc-settings-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 16px 8px; scrollbar-width: thin; scrollbar-color: var(--mtc-border-strong) transparent; }
    .mtc-settings-section { display: grid; gap: var(--mtc-space-2); padding: 12px 0; border-bottom: 1px solid var(--mtc-border); }
    .mtc-settings-section:last-child { border-bottom: none; }
    .mtc-settings-section-title { margin: 0; font-size: var(--mtc-fs-xs); font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; color: var(--mtc-text-3); }
    .mtc-settings-status { display: flex; align-items: center; gap: 6px; font-size: var(--mtc-fs-sm); color: var(--mtc-text-2); }
    .mtc-settings-actions { display: flex; flex-wrap: wrap; gap: var(--mtc-space-2); }
    .mtc-settings-hint { font-size: var(--mtc-fs-xs); line-height: 1.5; color: var(--mtc-text-3); overflow-wrap: anywhere; }
    .mtc-settings-links { display: flex; flex-wrap: wrap; gap: var(--mtc-space-3); }
    .mtc-settings-notice:empty, .mtc-settings-result:empty { display: none; }
    .mtc-settings-notice, .mtc-settings-result { font-size: var(--mtc-fs-sm); line-height: 1.45; color: var(--mtc-text-2); }
    .mtc-settings-notice[data-tone="ok"], .mtc-settings-result[data-tone="ok"] { color: var(--mtc-success); }
    .mtc-settings-notice[data-tone="error"], .mtc-settings-result[data-tone="error"] { color: var(--mtc-danger); }
    .mtc-settings-footer { display: flex; align-items: center; justify-content: flex-end; gap: var(--mtc-space-2); padding: 10px 16px 12px; border-top: 1px solid var(--mtc-border); }
    .mtc-settings-footer .mtc-settings-result { flex: 1 1 auto; min-width: 0; margin-right: auto; }
    .mtc-config-row { display: flex; align-items: center; gap: var(--mtc-space-3); min-height: 30px; }
    .mtc-config-stack { display: grid; gap: 6px; }
    .mtc-config-label { flex: 0 0 104px; font-size: var(--mtc-fs-sm); color: var(--mtc-text-2); }
    .mtc-config-control { flex: 1 1 auto; min-width: 0; }
    .mtc-config-control .cc-dropdown, .mtc-config-control .cc-dropdown-trigger { width: 100%; max-width: none; box-sizing: border-box; }
    .mtc-config-control .cc-dropdown-trigger { min-height: 28px; font-size: var(--mtc-fs-sm); }
    .mtc-config-control .cc-dropdown-menu { max-height: 260px; overflow-y: auto; }
    .mtc-config-input { width: 100%; box-sizing: border-box; min-height: 28px; padding: 5px 8px; border: 1px solid var(--mtc-border-input); border-radius: var(--mtc-radius-sm); background: transparent; color: var(--mtc-text); font: 400 var(--mtc-fs-md)/1.45 var(--mtc-font); outline: none; transition: border-color var(--mtc-dur-fast); }
    .mtc-config-input:hover { border-color: var(--mtc-text-3); }
    .mtc-config-input:focus-visible { border-color: var(--mtc-text-2); outline: 2px solid var(--mtc-focus); outline-offset: 1px; }
    textarea.mtc-config-input { min-height: 84px; resize: vertical; }
    input.mtc-config-input[type="number"] { max-width: 120px; }
    @container mtc-header (width < 300px) { .mtc-header-rename { display: none; } }
    body.ui-interacting :is(.mtc-thought.thinking summary, .mtc-stream-cursor, .mtc-dot, .mtc-pill-ring > i, .mtc-composer-ring > i, .mtc-pill-running .term-minimized-pill-icon) { animation-play-state: paused !important; }
    html.sp-resizing .mtc-panel { backdrop-filter: none; -webkit-backdrop-filter: none; transition: none; }
    @media (prefers-reduced-motion: reduce) {
      .mtc-panel, .mtc-panel *, .mtc-panel *::before, .mtc-panel *::after, .mtc-session-pill, .mtc-session-pill *, .mtc-pop, .mtc-pop * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
    }
  `;
  document.head.appendChild(style);
}
