// ── CSS for cp/ feature modules ──
// Appended to the monolith's injected <style id="claude-panel-styles"> via
// injectStyles(). New selectors only — existing .tool-card / .perm-card /
// .post-plan-* families are inherited, these rules add the cp- sub-elements.

export const CP_STYLES = `
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
.cp-statusline { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding-right: 8px; }
.cp-sl-activity { display: inline-flex; align-items: center; gap: 5px; font: 10.5px/1 Inter, sans-serif; color: rgba(220,195,140,0.85); min-width: 0; overflow: hidden; }
.cp-sl-activity[hidden] { display: none; }
.cp-sl-spinner { color: #d4a848; font-size: 11px; width: 12px; text-align: center; }
.cp-sl-verb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.cp-sl-elapsed { color: rgba(255,255,255,0.35); font-family: "SF Mono", Menlo, monospace; font-size: 9.5px; }
.cp-sl-spacer { flex: 1; }
/* Permission-mode dropdown (project bar) — color-coded label per mode */
#cp-mode[hidden] { display: none; }
#cp-mode.cp-mode-acceptEdits .cp-dd-label { color: #e8c97d; }
#cp-mode.cp-mode-plan .cp-dd-label { color: #7db8e8; }
#cp-mode.cp-mode-bypassPermissions .cp-dd-label { color: #ef7070; }
.cp-sl-mcp { display: inline-flex; gap: 3px; }
.cp-sl-mcp-dot { width: 6px; height: 6px; border-radius: 50%; cursor: default; }
.cp-mcp-ok { background: #5fcf83; }
.cp-mcp-warn { background: #d4a848; }
.cp-mcp-err { background: #ef7070; }

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

/* ═══ Streaming tool stubs ═══ */
.tool-streaming { border-color: rgba(212,168,72,0.45) !important; animation: cp-tool-pulse 1.1s ease-in-out infinite; }
@keyframes cp-tool-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(212,168,72,0.0); } 50% { box-shadow: 0 0 8px 0 rgba(212,168,72,0.25); } }
`;
