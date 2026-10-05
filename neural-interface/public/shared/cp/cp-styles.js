// ── CSS for cp/ feature modules ──
// Appended to the monolith's injected <style id="claude-panel-styles"> via
// injectStyles(). New selectors only — existing .tool-card / .perm-card /
// .post-plan-* families are inherited, these rules add the cp- sub-elements.

export const CP_STYLES = `
/* ═══ Temporary chat (cp-temporary-view.js) ═══ */
.cp-temp-banner { margin: 8px 14px 6px; padding: 6px 10px; border: 1px dashed rgba(255,255,255,0.2); border-radius: 6px; font: 10.5px/1.5 Inter, sans-serif; color: var(--t-secondary); background: rgba(255,255,255,0.03); }
.cp-temp-banner.ended { border-color: rgba(239,112,112,0.55); color: #ef7070; }
.cp-messages:has(.cp-temp-banner) .cp-empty { height: calc(100% - 72px); }
.cp-empty .cp-temp-choice { pointer-events: auto; margin-top: 10px; padding: 4px 12px; border: 1px dashed rgba(255,255,255,0.2); border-radius: 12px; background: transparent; color: rgba(255,255,255,0.35); font: 11px/1.4 Inter, sans-serif; cursor: pointer; }
.cp-empty .cp-temp-choice:hover { color: var(--t-secondary); border-color: rgba(255,255,255,0.35); }
.cp-empty .cp-temp-choice.on { color: var(--t-primary); border-style: solid; border-color: rgba(255,255,255,0.35); background: rgba(255,255,255,0.06); }
.cp-session-pill.cp-pill-temporary { border-style: dashed; }
.cp-session-pill.cp-pill-temporary .term-minimized-pill-label { font-style: italic; }
/* ═══ Diff cards ═══ */
.cp-diff-card .tool-body { padding: 6px 8px; }
.cp-diff-path { font: 10px/1.4 "SF Mono", Menlo, monospace; color: rgba(220,195,140,0.75); padding: 2px 0 6px; word-break: break-all; }
.cp-diff-section-label { font: 600 9px/1.6 Inter, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.35); margin: 6px 0 2px; }
.cp-diff { border: 1px solid rgba(180,140,60,0.12); border-radius: 6px; overflow: hidden; font: 10.5px/1.5 "SF Mono", Menlo, monospace; background: rgba(0,0,0,0.25); }
.cp-diff-line { display: flex; white-space: pre-wrap; word-break: break-all; }
.cp-diff-gutter { flex: 0 0 16px; text-align: center; user-select: none; opacity: 0.7; }
.cp-diff-text { flex: 1; padding-right: 6px; }
.cp-diff-add { background: rgba(80,200,120,0.10); color: #9fe3b4; }
.cp-diff-add .cp-diff-gutter { color: #5fcf83; }
.cp-diff-del { background: rgba(255,90,90,0.10); color: #f0a3a3; }
.cp-diff-del .cp-diff-gutter { color: #ef7070; }
.cp-diff-ctx { color: rgba(255,255,255,0.45); }
.cp-diff-gap { color: rgba(255,255,255,0.28); font-style: italic; padding-left: 16px; background: rgba(255,255,255,0.02); }
.cp-diff-stats { display: inline-flex; gap: 5px; margin-left: auto; font: 600 10px/1 "SF Mono", Menlo, monospace; }
.cp-diff-stat-add { color: #5fcf83; }
.cp-diff-stat-del { color: #ef7070; }
.cp-diff-badge { font: 600 8.5px/1 Inter, sans-serif; letter-spacing: 0.06em; text-transform: uppercase; color: #d4a848; border: 1px solid rgba(212,168,72,0.35); border-radius: 4px; padding: 2px 5px; margin-left: 6px; }
.cp-diff-card .tool-hdr .cp-diff-stats { margin-left: 6px; }
.cp-diff-preview { margin: 8px 0 2px; }
.cp-diff-preview-head { display: flex; align-items: center; gap: 8px; padding-bottom: 4px; }
.cp-diff-preview .cp-diff { max-height: 260px; overflow-y: auto; }

/* ═══ Bash cards ═══ */
.cp-bash-card .tool-detail { font-family: "SF Mono", Menlo, monospace; }
.cp-bash-cmd { margin: 4px 0; padding: 6px 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(180,140,60,0.12); border-radius: 6px; font: 10.5px/1.5 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.85); white-space: pre-wrap; word-break: break-all; }
.cp-bash-desc { font: 10.5px/1.4 Inter, sans-serif; color: rgba(255,255,255,0.4); padding: 2px 0 4px; }
.cp-bash-out { margin: 4px 0 0; padding: 6px 8px; background: rgba(0,0,0,0.35); border-radius: 6px; font: 10px/1.5 "SF Mono", Menlo, monospace; color: rgba(220,220,210,0.8); white-space: pre-wrap; word-break: break-all; max-height: 320px; overflow-y: auto; }
.cp-exit-pill { font: 700 9px/1 "SF Mono", Menlo, monospace; border-radius: 8px; padding: 2px 6px; margin-left: 6px; }
.cp-exit-ok { color: #5fcf83; background: rgba(80,200,120,0.12); }
.cp-exit-err { color: #ef7070; background: rgba(255,90,90,0.14); }
.cp-bash-elapsed, .cp-agent-elapsed { font: 9.5px/1 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.3); margin-left: 6px; }
.cp-bg-badge { font: 700 8px/1 Inter, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: #7db8e8; border: 1px solid rgba(125,184,232,0.4); border-radius: 4px; padding: 2px 4px; margin-left: 6px; }

/* ═══ Background task tray ═══ */
.cp-bg-tray { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 10px 0; }
.cp-bg-tray[hidden] { display: none; }
.cp-bg-chip { display: inline-flex; align-items: center; gap: 5px; font: 10px/1 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.65); background: rgba(0,0,0,0.3); border: 1px solid rgba(180,140,60,0.15); border-radius: 10px; padding: 4px 4px 4px 8px; cursor: pointer; transition: border-color 0.15s; }
.cp-bg-chip:hover { border-color: rgba(212,168,72,0.4); }
.cp-bg-dot { width: 6px; height: 6px; border-radius: 50%; background: #5fcf83; flex-shrink: 0; }
.cp-bg-running .cp-bg-dot { background: #d4a848; animation: cp-bg-pulse 1.2s ease-in-out infinite; }
.cp-bg-stopped .cp-bg-dot { background: #ef7070; }
.cp-bg-done .cp-bg-dot { background: #5fcf83; }
@keyframes cp-bg-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.cp-bg-label { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-bg-close { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; color: rgba(255,255,255,0.28); font: 700 12px/1 "SF Mono", Menlo, monospace; opacity: 0; transition: opacity 0.12s, color 0.12s, background 0.12s; flex-shrink: 0; margin-left: 1px; user-select: none; }
.cp-bg-chip:hover .cp-bg-close,
.cp-bg-close:focus-visible { opacity: 1; }
.cp-bg-close:hover { color: rgba(255,82,82,0.95); background: rgba(255,82,82,0.12); }
.cp-bg-close:active { background: rgba(255,82,82,0.2); }

/* ═══ Agent (subagent) cards ═══ */
.cp-agent-card { border-color: rgba(150,120,200,0.22) !important; }
.cp-agent-card .cp-agent-icon { color: #b49ae0; }
.cp-agent-type { font: 700 9px/1 Inter, sans-serif; letter-spacing: 0.06em; text-transform: uppercase; color: #b49ae0; border: 1px solid rgba(150,120,200,0.35); border-radius: 4px; padding: 2px 5px; }
.cp-agent-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-agent-pill { font: 11px/1 monospace; margin-left: 4px; }
.cp-agent-running { color: #d4a848; animation: cp-bg-pulse 1.2s ease-in-out infinite; }
.cp-agent-done { color: #5fcf83; }
.cp-agent-error { color: #ef7070; }
.cp-agent-todos-badge { font: 600 9px/1 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.5); background: rgba(255,255,255,0.06); border-radius: 7px; padding: 2px 5px; margin-left: 4px; }
.cp-agent-now { font: 10px/1.4 "SF Mono", Menlo, monospace; color: rgba(180,154,224,0.7); padding: 2px 10px 5px 28px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-agent-card.open .cp-agent-now { display: none; }
.cp-agent-feed { display: none; border-top: 1px solid rgba(150,120,200,0.15); margin: 0 6px 6px; padding: 6px 4px 2px; max-height: 420px; overflow-y: auto; }
.cp-agent-card.open .cp-agent-feed { display: block; }
.cp-agent-feed .msg { margin: 4px 0; }
.cp-agent-feed .msg-avatar { display: none; }
.cp-agent-feed .msg-content { margin-left: 0; }
.cp-agent-feed .msg-body { font-size: 11px; }
.cp-agent-feed .tool-card { transform: scale(0.98); transform-origin: left top; }
.cp-agent-result { font: 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.55); background: rgba(150,120,200,0.07); border-radius: 6px; padding: 6px 8px; margin: 6px 0 2px; }

/* ═══ Permission card upgrades ═══ */
.cp-perm-preview { margin: 6px 0; }
.cp-perm-preview-label { font: 600 9px/1.6 Inter, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.35); }
.cp-perm-cmd-edit { width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.35); border: 1px solid rgba(180,140,60,0.2); border-radius: 6px; color: rgba(255,255,255,0.88); font: 10.5px/1.5 "SF Mono", Menlo, monospace; padding: 6px 8px; resize: vertical; }
.cp-perm-cmd-edit:focus { outline: none; border-color: rgba(212,168,72,0.5); }
.cp-perm-kv { display: flex; flex-direction: column; gap: 2px; background: rgba(0,0,0,0.25); border-radius: 6px; padding: 6px 8px; }
.cp-perm-kv-row { display: flex; gap: 8px; font: 10px/1.5 "SF Mono", Menlo, monospace; }
.cp-perm-kv-key { color: rgba(220,195,140,0.8); flex: 0 0 auto; }
.cp-perm-kv-val { color: rgba(255,255,255,0.6); word-break: break-all; }
.cp-perm-suggestions { display: flex; flex-direction: column; gap: 3px; margin: 6px 0; }
.cp-perm-suggestion { display: flex; align-items: flex-start; gap: 6px; font: 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.6); cursor: pointer; }
.cp-perm-suggestion input { accent-color: #d4a848; margin-top: 2px; }
.cp-perm-deny-msg { width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,90,90,0.18); border-radius: 6px; color: rgba(255,255,255,0.85); font: 10.5px/1.5 Inter, sans-serif; padding: 5px 8px; resize: vertical; margin-top: 6px; }
.cp-perm-deny-msg:focus { outline: none; border-color: rgba(255,90,90,0.45); }

.cp-perm-title { font: 600 11.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.9); margin: 4px 0 2px; }
.cp-perm-desc { font: 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.55); margin-bottom: 4px; white-space: pre-wrap; }
.cp-perm-context { display: flex; flex-direction: column; gap: 2px; margin: 4px 0 6px; }
.cp-perm-dest { display: flex; align-items: center; gap: 6px; font: 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.45); margin-top: 3px; }
.cp-perm-dest-select, .cp-elicit-input { background: rgba(0,0,0,0.35); border: 1px solid rgba(180,140,60,0.2); border-radius: 6px; color: rgba(255,255,255,0.88); font: 10.5px/1.5 Inter, sans-serif; padding: 3px 6px; }
.cp-perm-dest-select:focus, .cp-elicit-input:focus { outline: none; border-color: rgba(212,168,72,0.5); }
.cp-perm-suggestions .cp-perm-suggestion { cursor: default; }
.cp-perm-default-no .perm-btn-allow, .cp-perm-default-no .perm-btn-always { opacity: 0.75; }
.cp-perm-card [hidden] { display: none !important; }
.cp-elicit-form { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; }
.cp-elicit-field { display: flex; flex-direction: column; gap: 2px; }
.cp-elicit-label { font: 600 10px/1.5 Inter, sans-serif; color: rgba(220,195,140,0.85); }
.cp-elicit-hint { font: 10px/1.4 Inter, sans-serif; color: rgba(255,255,255,0.4); }
.cp-elicit-error { font: 10px/1.4 Inter, sans-serif; color: #ef7070; }
.cp-elicit-field input[type="checkbox"] { align-self: flex-start; accent-color: #d4a848; }
#cp-mode.cp-mode-dontAsk .cp-dd-label { color: #ef9a5a; }
#cp-mode.cp-mode-auto .cp-dd-label { color: #9fe3b4; }
.ask-preview { margin: 6px 0 2px; padding: 6px 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(180,140,60,0.12); border-radius: 6px; font: 10px/1.5 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.75); white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto; }
.ask-preview[hidden] { display: none; }
.ask-notes { width: 100%; box-sizing: border-box; margin-top: 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(180,140,60,0.2); border-radius: 6px; color: rgba(255,255,255,0.85); font: 10.5px/1.5 Inter, sans-serif; padding: 5px 8px; resize: vertical; }
.ask-notes:focus { outline: none; border-color: rgba(212,168,72,0.5); }
.ask-answered { margin-top: 6px; font: 600 10.5px/1.5 Inter, sans-serif; color: #e6c374; }

/* ═══ Plan approval card ═══ */
.cp-plan-approval-card { border: 1px solid rgba(212,168,72,0.3); border-radius: 10px; background: linear-gradient(180deg, rgba(212,168,72,0.06), rgba(0,0,0,0.15)); padding: 10px 12px; }
.cp-plan-approval-header { color: #d4a848; font: 700 10px/1 Inter, sans-serif; letter-spacing: 0.12em; }
.cp-plan-approval-body { max-height: 50vh; overflow-y: auto; margin: 8px 0; font-size: 11.5px; padding-right: 4px; }
.cp-plan-feedback { width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(180,140,60,0.2); border-radius: 6px; color: rgba(255,255,255,0.85); font: 10.5px/1.5 Inter, sans-serif; padding: 5px 8px; resize: vertical; margin: 4px 0 6px; }
.cp-plan-feedback:focus { outline: none; border-color: rgba(212,168,72,0.5); }
.cp-plan-approval-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.post-plan-btn { padding: 5px 11px; border-radius: 6px; font: 600 10.5px/1 Inter, sans-serif; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.72); cursor: pointer; transition: all 0.15s; }
.post-plan-btn:hover:not(:disabled) { background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.26); color: rgba(255,255,255,0.95); }
.post-plan-btn:disabled { opacity: 0.5; cursor: default; }
.cp-plan-btn-approve { border-color: rgba(212,168,72,0.45) !important; color: #e6c374 !important; background: rgba(212,168,72,0.12) !important; }
.cp-plan-btn-accept-edits { border-color: rgba(95,207,131,0.4) !important; color: #9fe3b4 !important; }
.cp-plan-btn-keep { border-color: rgba(125,184,232,0.35) !important; color: #a8cef0 !important; }
.cp-plan-approval-card.resolved { opacity: 0.75; }

/* ═══ Statusline ═══ */
.cp-statusline { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; overflow: hidden; padding-right: 8px; }
.cp-sl-activity { display: inline-flex; align-items: center; gap: 5px; font: 10.5px/1 Inter, sans-serif; color: rgba(220,195,140,0.85); min-width: 0; overflow: hidden; }
.cp-sl-activity[hidden] { display: none; }
.cp-sl-spinner { color: #d4a848; font-size: 11px; width: 12px; text-align: center; flex-shrink: 0; }
.cp-sl-verb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 200px; }
.cp-sl-elapsed { color: rgba(255,255,255,0.35); font-family: "SF Mono", Menlo, monospace; font-size: 9.5px; flex-shrink: 0; }
.cp-sl-bg { font: 10.5px/1 Inter, sans-serif; color: rgba(220,195,140,0.6); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; cursor: default; }
.cp-sl-bg[hidden] { display: none; }
/* Permission-mode dropdown (project bar) — color-coded label per mode */
#cp-mode[hidden] { display: none; }
/* It says whether tools run without asking, so its label is sized to its text: up to the longest label there is
   (43 characters), not the small dropdowns' 72px, which cut "From settings · auto-approve" and "Bypass → Default"
   to 56px. Short of room it shrinks like the others and the ellipsis takes the end of the label, but never its
   first --cp-mode-keep characters ("Bypass", the mode after the arrow: set with the label). 5.7px is one character
   of the label (9.5px JetBrains Mono); 19px is the control's padding, gap and arrow. */
#cp-mode { max-width: 270px; min-width: calc(var(--cp-mode-keep, 0) * 5.7px + 19px); }
#cp-mode.cp-mode-acceptEdits .cp-dd-label { color: #e8c97d; }
#cp-mode.cp-mode-plan .cp-dd-label { color: #7db8e8; }
#cp-mode.cp-mode-bypassPermissions .cp-dd-label { color: #ef7070; }
/* Tools run without asking (a tab in Bypass, or the Auto-approve toggle on): the control itself is marked. */
#cp-mode.cp-mode-unasked { border-color: rgba(239,112,112,0.55); background: rgba(239,112,112,0.08); }
#cp-mode.cp-mode-unasked .cp-dd-label { color: #ef7070; font-weight: 600; }
#cp-mode .cp-dd-item.cp-dd-disabled { color: rgba(255,255,255,0.3); cursor: default; }
#cp-mode .cp-dd-item.cp-dd-disabled:hover { background: transparent; }
#cp-mode .cp-dd-item-note { margin-left: 6px; font-size: 9.5px; color: rgba(255,255,255,0.35); }
.cp-plan-btn-bypass { border-color: rgba(239,112,112,0.45) !important; color: #ef7070 !important; }

/* ═══ Rewind ═══ */
.msg-user { position: relative; }
.cp-rewind-btn { position: absolute; top: -8px; right: 4px; opacity: 0; pointer-events: none; transition: opacity 0.15s; font: 600 9px/1 Inter, sans-serif; color: rgba(220,195,140,0.9); background: rgba(30,25,18,0.95); border: 1px solid rgba(212,168,72,0.35); border-radius: 8px; padding: 3px 7px; cursor: pointer; z-index: 3; }
.msg-user:hover .cp-rewind-btn { opacity: 1; pointer-events: auto; }
.cp-rewind-btn:hover { border-color: rgba(212,168,72,0.7); }
.cp-rewind-btn[disabled] { opacity: 0.3 !important; cursor: not-allowed; }
.cp-rewind-confirm { position: absolute; top: 18px; right: 4px; z-index: 5; background: rgba(28,24,16,0.98); border: 1px solid rgba(212,168,72,0.4); border-radius: 8px; padding: 8px 10px; width: 220px; box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
.cp-rewind-confirm-text { font: 10.5px/1.45 Inter, sans-serif; color: rgba(255,255,255,0.75); margin-bottom: 7px; }
.cp-rewind-confirm-actions { display: flex; gap: 6px; justify-content: flex-end; }
.cp-rewind-confirm-actions button { font: 600 9.5px/1 Inter, sans-serif; border-radius: 6px; padding: 4px 9px; cursor: pointer; background: transparent; }
.cp-rewind-yes { color: #e8c97d; border: 1px solid rgba(232,201,125,0.5); }
.cp-rewind-no { color: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.18); }
.cp-rewound { opacity: 0.45; }

/* ═══ Slash argument hints ═══ */
.cp-slash-arg { font: italic 10px/1 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.3); margin-left: 6px; }

/* ═══ Event rows ═══ */
/* Shown only in the transcript view (Ctrl+O): events with no renderer of their own. */
.cp-messages .cp-transcript-only { display: none; padding: 2px 14px 2px 48px; font-size: 10px; color: var(--t-faint); font-family: 'JetBrains Mono', monospace; }
.cp-messages.cp-view-transcript .cp-transcript-only { display: block; }
.cp-messages .cp-engine-error { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cp-engine-retry { font: 600 9.5px/1 Inter, sans-serif; border-radius: 6px; padding: 4px 9px; cursor: pointer; background: transparent; color: #e8c97d; border: 1px solid rgba(232,201,125,0.5); }
.cp-engine-retry:disabled { opacity: 0.5; cursor: default; }

.cp-messages .msg-status.cp-row-notice { color: rgba(220,195,140,0.75); }
.cp-messages .cp-limit-row.cp-limit-blocked { color: #ef7070; }
.cp-messages .msg-assistant.cp-limit-msg .msg-body { border-left: 2px solid rgba(212,168,72,0.6); padding-left: 8px; }
.cp-messages .msg-assistant.cp-limit-msg.cp-limit-blocked .msg-body { border-left-color: rgba(255,90,90,0.6); }
.cp-messages .msg-assistant.cp-retracted { opacity: 0.45; text-decoration: line-through; }
.cp-messages .cp-turn-footer { padding: 2px 14px 6px 48px; font: 9.5px/1.5 'JetBrains Mono', monospace; color: rgba(255,255,255,0.28); cursor: default; }
.cp-messages .cp-reset-divider { display: flex; align-items: center; gap: 10px; margin: 10px 14px; font: 600 9px/1 Inter, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.35); }
.cp-messages .cp-reset-divider::before, .cp-messages .cp-reset-divider::after { content: ''; flex: 1; height: 1px; background: rgba(180,140,60,0.18); }
.cp-msg-note { font: italic 10px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.35); margin-top: 3px; }
.cp-assistant-error { margin-top: 6px; padding: 6px 8px; border: 1px solid rgba(255,90,90,0.25); border-radius: 6px; background: rgba(255,90,90,0.06); color: #f0a3a3; font: 10.5px/1.5 Inter, sans-serif; }
.cp-thinking-redacted { font: italic 10px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.35); padding: 2px 0 4px; }
.think-tokens { font: 9.5px/1 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.3); margin-left: 8px; }
.cp-command-output { white-space: normal; }

/* ═══ Tool card state from events ═══ */
.cp-denied-badge { font: 700 8px/1 Inter, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: #ef7070; border: 1px solid rgba(255,90,90,0.4); border-radius: 4px; padding: 2px 4px; margin-left: 6px; }
.tool-card.tool-denied { border-color: rgba(255,90,90,0.3) !important; }
.cp-denied-reason { font: 10.5px/1.5 Inter, sans-serif; color: #f0a3a3; padding: 2px 10px 6px 28px; }
.cp-tool-elapsed { font: 9.5px/1 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.3); margin-left: 6px; }
.cp-tool-summary { font: 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.45); padding: 2px 0 4px; }
.cp-tool-group { margin: 4px 0; }
.cp-tool-group > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; font: 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.6); padding: 3px 0; }
.cp-tool-group > summary::-webkit-details-marker { display: none; }
.cp-tool-group-count { font: 600 9px/1 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.06); border-radius: 7px; padding: 2px 5px; flex-shrink: 0; }
.cp-tool-group-body { padding-left: 8px; border-left: 1px solid rgba(180,140,60,0.15); }
.cp-citations { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 6px; }
.cp-citations-label { font: 600 9px/1.6 Inter, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.35); }
.cp-citation { font: 10px/1.4 Inter, sans-serif; color: rgba(220,195,140,0.85); border: 1px solid rgba(180,140,60,0.2); border-radius: 8px; padding: 2px 7px; text-decoration: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
a.cp-citation:hover { border-color: rgba(212,168,72,0.5); }
.cp-messages .cp-memory-recall { margin: 2px 14px 2px 48px; font: 10px/1.5 'JetBrains Mono', monospace; color: var(--t-faint); }
.cp-memory-recall > summary { cursor: pointer; }
.cp-memory-recall-row { display: flex; gap: 8px; padding: 1px 0 1px 12px; }
.cp-memory-recall-scope { color: rgba(220,195,140,0.7); flex-shrink: 0; }
.cp-memory-recall-path { word-break: break-all; }
.cp-memory-recall-content { margin: 2px 0 4px 12px; padding: 6px 8px; background: rgba(0,0,0,0.3); border-radius: 6px; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }

/* ═══ Typed tool results ═══ */
.cp-chip { font: 600 9px/1 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.5); background: rgba(255,255,255,0.06); border-radius: 7px; padding: 2px 6px; margin-left: 5px; white-space: nowrap; flex-shrink: 0; text-decoration: none; }
.cp-chip-ok { color: #5fcf83; background: rgba(80,200,120,0.12); }
.cp-chip-warn { color: #d4a848; background: rgba(212,168,72,0.12); }
.cp-chip-err { color: #ef7070; background: rgba(255,90,90,0.14); }
.cp-chip-info { color: #7db8e8; background: rgba(125,184,232,0.12); }
a.cp-chip:hover { text-decoration: underline; }
.cp-result-section { margin: 6px 0 2px; }
.cp-result-text { margin: 0; background: none; border: none; white-space: pre-wrap; word-break: break-all; font: 10px/1.5 "SF Mono", Menlo, monospace; color: rgba(220,220,210,0.8); }
.cp-result-err .cp-result-text { color: #f0a3a3; }
.cp-result-more { margin-top: 4px; font: 600 9.5px/1 Inter, sans-serif; border-radius: 6px; padding: 4px 9px; cursor: pointer; background: transparent; color: rgba(220,195,140,0.9); border: 1px solid rgba(212,168,72,0.35); }
.cp-result-links { display: flex; flex-direction: column; gap: 2px; }
.cp-result-link { font: 10.5px/1.5 Inter, sans-serif; color: rgba(220,195,140,0.9); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-result-link:hover { text-decoration: underline; }
.cp-result-item { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
.cp-result-item:last-child { border-bottom: none; }
.cp-result-item-title { font: 600 10px/1.5 "SF Mono", Menlo, monospace; color: rgba(220,195,140,0.85); }
.cp-result-item-text { font: 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.7); }
.cp-result-item-note { font: 10px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.4); }
.cp-tool-note { font: 10px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.45); padding: 4px 0 0; word-break: break-all; }
.cp-agent-stats { font: 9.5px/1.5 "SF Mono", Menlo, monospace; color: rgba(180,154,224,0.75); padding: 4px 2px 2px; }
.cp-diff-lineno { flex: 0 0 34px; text-align: right; padding-right: 6px; user-select: none; color: rgba(255,255,255,0.25); }
.cp-perm-target { font: 11px/1.5 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.9); background: rgba(0,0,0,0.3); border: 1px solid rgba(180,140,60,0.2); border-radius: 6px; padding: 6px 8px; word-break: break-all; margin-bottom: 4px; }

/* ═══ Replayed questions and plans ═══ */
.cp-ask-history-row { padding: 4px 0; }
.cp-ask-history-q { font: 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.6); }
.cp-ask-history-a { font: 600 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.35); padding-left: 10px; }
.cp-ask-history-a.cp-answered { color: #e6c374; }
.cp-plan-history-body { font-size: 11.5px; max-height: 50vh; overflow-y: auto; }
.cp-messages .cp-history-pager { display: flex; align-items: center; gap: 8px; }

/* ═══ Background work, suggestions ═══ */
.cp-sl-bg { cursor: pointer; }
.cp-task-row { padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
.cp-task-row:last-child { border-bottom: none; }
.cp-task-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cp-task-title { font: 600 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.8); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-task-line { font: 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.55); }
.cp-task-stats { font: 9.5px/1.5 "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.35); }
.cp-suggestion { display: flex; align-items: center; gap: 6px; margin: 0 10px 4px; padding: 4px 8px; border: 1px dashed rgba(180,140,60,0.3); border-radius: 8px; font: 10.5px/1.5 Inter, sans-serif; color: rgba(255,255,255,0.55); cursor: pointer; }
.cp-suggestion[hidden] { display: none; }
.cp-suggestion:hover { border-color: rgba(212,168,72,0.6); color: rgba(255,255,255,0.8); }
.cp-suggestion-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-suggestion-key { font: 600 9px/1 "SF Mono", Menlo, monospace; color: rgba(220,195,140,0.8); border: 1px solid rgba(212,168,72,0.35); border-radius: 4px; padding: 2px 4px; flex-shrink: 0; }
.cp-hook-ev.cp-hook-error .cp-hook-dot { background: #ef7070; }
.cp-hook-ev.cp-hook-cancelled .cp-hook-dot { background: #d4a848; }

/* ═══ Session actions ═══ */
/* Fork and delete sit left of the archive (right: 24px) and rename buttons of a session row. */
.cp-sess-item .cp-sess-fork { right: 44px; }
.cp-sess-item .cp-sess-delete { right: 64px; }
.cp-sess-item .cp-sess-delete:hover { color: rgba(255,90,90,0.9); }
.cp-sess-delete-armed { color: #ef7070 !important; font: 600 9.5px/1 Inter, sans-serif; }
.cp-rewind-confirm { width: 250px; }
.cp-rewind-confirm-actions { flex-wrap: wrap; }
.cp-rewind-preview { color: rgba(220,195,140,0.85); }
.cp-agent-transcript { border-bottom: 1px solid rgba(150,120,200,0.15); margin-bottom: 6px; padding-bottom: 4px; }

/* ═══ Session settings ═══ */
.cp-session-card textarea.cp-elicit-input { resize: vertical; font-family: "SF Mono", Menlo, monospace; }
.cp-session-card .cp-session-field input[type="checkbox"] { align-self: flex-start; accent-color: #d4a848; }
.cp-session-card:not(.active-perm) { opacity: 0.7; }

/* ═══ Statusline: usage limit ═══ */
.cp-sl-limit { font: 600 9.5px/1 "SF Mono", Menlo, monospace; border-radius: 8px; padding: 2px 6px; white-space: nowrap; flex-shrink: 0; cursor: default; color: #d4a848; background: rgba(212,168,72,0.12); }
.cp-sl-limit[hidden] { display: none; }
.cp-sl-limit-blocked { color: #ef7070; background: rgba(255,90,90,0.14); }

/* ═══ Streaming tool stubs ═══ */
.tool-streaming { border-color: rgba(212,168,72,0.45) !important; animation: cp-tool-pulse 1.1s ease-in-out infinite; }
@keyframes cp-tool-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(212,168,72,0.0); } 50% { box-shadow: 0 0 8px 0 rgba(212,168,72,0.25); } }
/* ═══ Context settings: the header cog and its popover (cp-context-menu.js) ═══ */
/* The cog is a .cp-header-btn like its neighbours. Its one decoration is the
   pressure dot: amber from 80% of the context window, red from 90%. */
.cp-header-btn.cp-cog-btn[aria-expanded="true"] { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.75); }
.cp-cog-dot { position: absolute; top: 2px; right: 2px; width: 6px; height: 6px; border-radius: 50%; background: #d4a848; pointer-events: none; }
.cp-cog-dot[hidden] { display: none; }
.cp-cog-dot-critical { background: #ef7070; }
/* A child of <body>: left, top, width, max-height and z-index are set from the cog's rectangle. */
.cp-ctxpop { position: fixed; box-sizing: border-box; overflow-x: hidden; overflow-y: auto; padding: 12px; background: rgba(22,22,26,0.98); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); font: 400 12px/16px Inter, -apple-system, sans-serif; font-variant-numeric: tabular-nums; color: var(--t-bright); outline: none; }
/* One column on a 4px grid: 12px around the card, and 12px, one hairline, 12px between two sections. */
.cp-ctxpop-section + .cp-ctxpop-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); }
/* A head and a row are the same 28px line, from the left edge to the right one:
   a title and at most one action, or a label and one value. */
.cp-ctxpop-head, .cp-ctxpop-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 28px; }
.cp-ctxpop-head { margin-bottom: 4px; }
.cp-ctxpop-title { flex: 1 1 0; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px Inter, -apple-system, sans-serif; color: var(--t-bright); }
.cp-ctxpop-act { display: inline-flex; flex-shrink: 0; }
.cp-ctxpop-bar { height: 4px; margin: 8px 0; border-radius: 2px; background: rgba(255,255,255,0.08); overflow: hidden; }
.cp-ctxpop-fill { height: 100%; border-radius: 2px; background: rgba(232,224,220,0.55); }
.cp-ctxpop-fill.cp-ctxpop-high { background: #d4a848; }
.cp-ctxpop-fill.cp-ctxpop-critical { background: #ef7070; }
/* Under the bar and as wide: used / window at its left end, the share at its right end. */
.cp-ctxpop-usage { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 20px; margin-bottom: 4px; }
.cp-ctxpop-used { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-ctxpop-share { flex-shrink: 0; }
.cp-ctxpop-k { flex: 0 0 auto; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,0.6); }
.cp-ctxpop-v { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: var(--t-bright); }
.cp-ctxpop-muted { color: rgba(255,255,255,0.4); }
/* A server's name can be long and its status cannot: there the name gives way. */
.cp-ctxpop-row-server > .cp-ctxpop-k { flex: 1 1 0; min-width: 0; max-width: none; }
.cp-ctxpop-row-server > .cp-ctxpop-v { flex: 0 0 auto; }
.cp-ctxpop-status { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.cp-ctxpop-dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.3); }
.cp-ctxpop-dot-ok { background: #5fcf83; }
.cp-ctxpop-dot-warn { background: #d4a848; }
.cp-ctxpop-dot-err { background: #ef7070; }
/* The one push button. Disabled it lets the hover through to its cell, which holds its reason. */
.cp-ctxpop-btn { box-sizing: border-box; height: 22px; padding: 0 10px; border: 1px solid rgba(255,255,255,0.08); border-radius: 5px; background: rgba(255,255,255,0.07); color: var(--t-bright); font: 400 12px/20px Inter, -apple-system, sans-serif; cursor: pointer; }
.cp-ctxpop-btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
.cp-ctxpop-btn:disabled { opacity: 0.45; cursor: default; pointer-events: none; }
/* Every other action is text in the panel's link colour (.cp-result-link): in a head, or as the value of a row. */
.cp-ctxpop-link { flex: 0 0 auto; height: 20px; padding: 0; border: none; background: none; color: rgba(220,195,140,0.9); font: 400 12px/20px Inter, -apple-system, sans-serif; text-decoration: none; cursor: pointer; }
.cp-ctxpop-link:hover { filter: brightness(1.2); }
/* The session id: the whole value copies it. */
.cp-ctxpop-copy { padding: 0; border: none; background: none; font: inherit; line-height: 20px; cursor: pointer; }
.cp-ctxpop-copy:hover, .cp-ctxpop-copy.cp-ctxpop-copied { color: rgba(220,195,140,0.9); }
.cp-ctxpop-btn:focus-visible, .cp-ctxpop-link:focus-visible, .cp-ctxpop-copy:focus-visible { outline: 1px solid rgba(255,255,255,0.45); outline-offset: 2px; }
`;
