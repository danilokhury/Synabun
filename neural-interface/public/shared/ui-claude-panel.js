// ═══════════════════════════════════════════
// SynaBun — Claude Code Panel (Main Area)
// Stream-JSON renderer embedded in the Neural Interface viewport
// ═══════════════════════════════════════════

import { storage } from './storage.js';
import { emit } from './state.js';
import { fetchClaudeSessions } from './api.js';

const CLAUDE_ICON = '<svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';

let _panel = null;
let _visible = false;
let _totalCost = 0;
let _projects = [];
let _models = [];
let _skillsCache = null;    // cached skills list for slash command hints

// ── Multi-session tab system ──
let _tabs = [];           // TabState[]
let _activeTabIdx = -1;
const MAX_TABS = 5;
function activeTab() { return _tabs[_activeTabIdx] || null; }

// Marked.js (lazy loaded)
let _marked = null;
(async () => {
  try {
    const m = await import('https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js').catch(() => null);
    if (m) {
      _marked = m.marked || m.default;
      if (_marked?.setOptions) _marked.setOptions({ breaks: true, gfm: true });
    }
  } catch {}
})();

function md(text) {
  if (!_marked) return esc(text).replace(/\n/g, '<br>');
  try { return _marked.parse(text); }
  catch { return esc(text).replace(/\n/g, '<br>'); }
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const STOR = {
  session: 'synabun-claude-panel-session',
  project: 'synabun-claude-panel-project',
  model: 'synabun-claude-panel-model',
  tabs: 'synabun-claude-panel-tabs',
  effort: 'synabun-claude-panel-effort',
};

const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max'];
const EFFORT_LABELS = { off: 'Think', low: 'lo', medium: 'med', high: 'hi', max: 'max' };
const EFFORT_TITLES = {
  off: 'Extended thinking off — click to enable',
  low: 'Thinking: low — minimal extended reasoning',
  medium: 'Thinking: medium — balanced reasoning',
  high: 'Thinking: high — deep reasoning',
  max: 'Thinking: max — maximum reasoning depth',
};

// ── Build panel DOM ──
function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'claude-panel';
  panel.className = 'claude-panel';
  panel.innerHTML = `
    <div class="cp-resize-handle"></div>
    <div class="cp-header">
      <button class="cp-session-btn" id="cp-session-btn">
        <span class="cp-session-label">New chat</span>
        <span class="cp-dd-arrow">&#x25BE;</span>
      </button>
      <div class="cp-header-actions">
        <button class="cp-header-btn cp-new-btn" data-tooltip="New session">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="cp-header-btn cp-minimize-btn" data-tooltip="Minimize to pill">
          <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="cp-header-btn cp-close-btn" data-tooltip="Close panel">
          <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="cp-session-menu" id="cp-session-menu"></div>
    </div>
    <div class="cp-context-bar" id="cp-context-bar">
      <div class="cp-gauge" id="cp-gauge"></div>
      <span class="cp-gauge-label" id="cp-gauge-label"></span>
      <button class="cp-compact-btn" id="cp-compact-btn" title="Compress conversation context to free up space">compact</button>
    </div>
    <div class="cp-messages-container" id="cp-messages-container"></div>
    <div class="cp-bottom">
      <div class="cp-image-preview" id="cp-image-preview"></div>
      <div class="cp-input-area">
        <div class="cp-input-wrap">
          <div class="cp-input-inner">
            <button class="cp-attach" id="cp-attach" title="Attach file">
              <svg viewBox="0 0 24 24" width="14" height="14"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.49" fill="none" stroke="currentColor" stroke-width="2"/></svg>
              <span class="cp-attach-badge" hidden></span>
            </button>
            <textarea class="cp-input" id="cp-input" placeholder="Message SynaBun..." rows="1" autocomplete="off" spellcheck="false"></textarea>
            <div class="cp-slash-hints" id="cp-slash-hints"></div>
            <button class="cp-send" id="cp-send" disabled><svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></button>
          </div>
        </div>
      </div>
      <div class="cp-toolbar">
        <div class="cp-toolbar-left">
          <img class="cp-brand" src="favicon-32x32.png" alt="S">
          <div class="cp-dropdown" id="cp-project" data-placeholder="project..."><span class="cp-dd-label">project...</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
          <div class="cp-dropdown cp-dropdown-sm" id="cp-branch" data-placeholder="branch"><span class="cp-dd-label">branch</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
        </div>
        <div class="cp-toolbar-right">
          <button class="cp-think-toggle" id="cp-think-toggle" data-effort="off" data-tooltip="Extended thinking off — click to enable"><span class="cp-think-icon"><svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5L4 9h4l-1 5.5L12 7H8l1-5.5z"/></svg></span><span class="cp-think-label">Think</span><span class="cp-think-dots"></span></button>
          <button class="cp-plan-toggle" id="cp-plan-toggle" data-tooltip="Toggle plan mode — think without acting">Plan</button>
          <div class="cp-dropdown cp-dropdown-sm" id="cp-model" data-placeholder="model"><span class="cp-dd-label">model</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
          <span class="cp-cost" id="cp-cost">$0.00</span>
        </div>
      </div>
    </div>
  `;
  return panel;
}

// ── Inject styles ──
function injectStyles() {
  if (document.getElementById('claude-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'claude-panel-styles';
  style.textContent = `
    /* ── Panel shell — matches Neural Interface glass system ── */
    .claude-panel {
      position: fixed;
      top: 42px; right: 0;
      width: 22%; min-width: 320px; max-width: 700px;
      bottom: 0;
      z-index: 200;
      display: flex;
      flex-direction: column;
      background: rgba(18, 18, 20, 0.92);
      backdrop-filter: blur(40px) saturate(1.4);
      -webkit-backdrop-filter: blur(40px) saturate(1.4);
      border-left: 1px solid rgba(255,255,255,0.04);
      transform: translateX(100%);
      transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .claude-panel.open { transform: translateX(0); }

    /* ── Resize handle (left edge) ── */
    .cp-resize-handle {
      position: absolute; top: 0; left: -3px; width: 6px; height: 100%;
      cursor: col-resize; z-index: 10;
    }
    .cp-resize-handle:hover, .cp-resize-handle:active {
      background: linear-gradient(180deg, rgba(255,255,255,0.06), transparent 50%, rgba(255,255,255,0.06));
    }

    /* ── Messages container (holds per-tab message divs) ── */
    .cp-messages-container { flex: 1; overflow: hidden; position: relative; }
    .cp-messages {
      position: absolute; inset: 0;
      overflow-y: auto;
      padding: 12px 0 6px;
      display: flex; flex-direction: column; gap: 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.06) transparent;
      opacity: 1; transform: translateY(0);
    }
    .cp-messages.cp-tab-enter {
      animation: cp-tab-in 0.25s cubic-bezier(0.2, 0, 0.2, 1) forwards;
    }
    .cp-messages.cp-tab-exit {
      animation: cp-tab-out 0.18s cubic-bezier(0.4, 0, 1, 1) forwards;
      pointer-events: none;
    }
    @keyframes cp-tab-in {
      0% { opacity: 0; transform: translateY(8px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    @keyframes cp-tab-out {
      0% { opacity: 1; transform: translateY(0); }
      100% { opacity: 0; transform: translateY(-6px); }
    }
    .cp-messages::before {
      content: ''; margin-top: auto;
    }
    .cp-messages::-webkit-scrollbar { width: 3px; }
    .cp-messages::-webkit-scrollbar-track { background: transparent; }
    .cp-messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
    .cp-messages::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

    /* ── User messages ── */
    .cp-messages .msg { padding: 3px 14px; }
    .cp-messages .msg-user { display: flex; justify-content: flex-end; padding: 10px 14px 4px; }
    .cp-messages .msg-bubble {
      background: var(--s-light);
      border: 1px solid var(--b-light);
      border-radius: 16px 16px 4px 16px;
      padding: 8px 14px; max-width: 82%;
      font-size: 12px; color: var(--t-bright);
      white-space: pre-wrap; word-break: break-word; line-height: 1.55;
      font-family: 'Inter', -apple-system, sans-serif;
    }

    /* ── Assistant messages ── */
    .cp-messages .msg-assistant { display: flex; gap: 10px; align-items: flex-start; padding: 8px 14px; }
    .cp-messages .msg-avatar {
      width: 24px; height: 24px; border-radius: 7px;
      background: rgba(255,255,255,0.06);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-top: 2px;
      color: rgba(255,255,255,0.5);
    }
    .cp-messages .msg-avatar svg { width: 14px; height: 14px; }
    .cp-messages .msg-content { flex: 1; min-width: 0; }
    .cp-messages .msg-body {
      font-size: 12px; color: var(--t-primary);
      line-height: 1.65; word-break: break-word;
      font-family: 'Inter', -apple-system, sans-serif;
    }
    .cp-messages .msg-body p { margin: 0 0 0.5em; }
    .cp-messages .msg-body p:last-child { margin-bottom: 0; }
    .cp-messages .msg-body h1,.cp-messages .msg-body h2,.cp-messages .msg-body h3 {
      color: var(--t-bright); margin: 0.7em 0 0.25em; font-weight: 600;
    }
    .cp-messages .msg-body h1 { font-size: 14px; }
    .cp-messages .msg-body h2 { font-size: 13px; }
    .cp-messages .msg-body h3 { font-size: 12px; }
    .cp-messages .msg-body code:not(pre code) {
      background: var(--s-subtle); border: 1px solid var(--b-subtle);
      border-radius: 4px; padding: 1px 5px; font-family: 'JetBrains Mono', monospace;
      font-size: 0.88em; color: var(--t-bright);
    }
    .cp-messages .msg-body pre {
      background: rgba(0,0,0,0.3); border: 1px solid var(--b-subtle);
      border-radius: 8px; padding: 10px; overflow-x: auto; margin: 0.5em 0;
    }
    .cp-messages .msg-body pre code {
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      color: var(--t-primary); background: none; border: none; padding: 0;
    }
    .cp-messages .msg-body a { color: var(--t-bright); text-decoration: none; }
    .cp-messages .msg-body a:hover { text-decoration: underline; }
    .cp-messages .msg-body strong { color: var(--t-bright); }
    .cp-messages .msg-body ul, .cp-messages .msg-body ol { padding-left: 1.3em; margin: 0.3em 0; }

    /* ── Tool cards ── */
    .cp-messages .tool-card {
      border: 1px solid var(--b-subtle); border-radius: 8px;
      margin: 4px 0; overflow: hidden; font-size: 11px;
      background: var(--s-subtle); transition: border-color 0.2s;
    }
    .cp-messages .tool-card:hover { border-color: var(--b-light); }
    .cp-messages .tool-card.tool-ok { border-left: 3px solid rgba(100,200,120,0.5); }
    .cp-messages .tool-card.tool-error { border-left: 3px solid rgba(255,82,82,0.5); }
    .cp-messages .tool-hdr {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 10px; cursor: pointer; user-select: none; transition: background 0.15s;
    }
    .cp-messages .tool-hdr:hover { background: var(--s-hover); }
    .cp-messages .tool-icon {
      width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
      font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 700;
      color: var(--t-primary); background: var(--s-light); border-radius: 5px;
    }
    .cp-messages .tool-name { font-family: 'JetBrains Mono', monospace; color: var(--t-primary); font-weight: 600; font-size: 10.5px; }
    .cp-messages .tool-detail { font-family: 'JetBrains Mono', monospace; color: var(--t-faint); font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cp-messages .tool-chevron { color: var(--t-faint); font-size: 13px; transition: transform 0.2s; }
    .cp-messages .tool-card.open .tool-chevron { transform: rotate(90deg); color: var(--t-secondary); }
    .cp-messages .tool-body { display: none; border-top: 1px solid var(--b-subtle); }
    .cp-messages .tool-card.open .tool-body { display: block; }
    .cp-messages .tool-section-label { font-size: 8.5px; color: var(--t-faint); padding: 5px 10px 2px; font-family: 'JetBrains Mono', monospace; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; }
    .cp-messages .tool-section { padding: 4px 10px 6px; font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--t-muted); white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; margin: 0; background: none; border: none; }

    /* ── AskUserQuestion interactive cards ── */
    .ask-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(100,160,255,0.12);
      border-radius: 10px; padding: 10px 12px;
      margin-top: 6px;
    }
    .ask-header {
      font-size: 10px; font-weight: 700; color: rgba(100,160,255,0.7);
      text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;
    }
    .ask-question {
      font-size: 12px; color: rgba(255,255,255,0.8); margin-bottom: 8px; line-height: 1.4;
    }
    .ask-options { display: flex; flex-direction: column; gap: 4px; }
    .ask-option {
      display: flex; flex-direction: column; gap: 1px;
      padding: 7px 10px; border-radius: 8px; cursor: pointer;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      text-align: left; transition: all 0.15s;
    }
    .ask-option:hover:not(:disabled) {
      background: rgba(100,160,255,0.08);
      border-color: rgba(100,160,255,0.2);
    }
    .ask-option.selected {
      background: rgba(100,160,255,0.12);
      border-color: rgba(100,160,255,0.35);
    }
    .ask-option:disabled:not(.selected) { opacity: 0.35; cursor: default; }
    .ask-option-label {
      font-size: 11.5px; font-weight: 600; color: rgba(255,255,255,0.85);
    }
    .ask-option-desc {
      font-size: 10px; color: rgba(255,255,255,0.35); line-height: 1.3;
    }
    .ask-hint {
      font-size: 10px; color: rgba(100,160,255,0.5);
      font-family: 'JetBrains Mono', monospace; font-style: italic;
    }

    /* ── Permission prompt cards ── */
    .perm-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,180,60,0.15);
      border-radius: 10px; padding: 10px 12px;
      margin-top: 6px;
    }
    .perm-tool-line {
      display: flex; align-items: center; gap: 6px; margin-bottom: 4px;
    }
    .perm-tool-icon {
      width: 20px; height: 20px; border-radius: 5px;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700; font-family: 'JetBrains Mono', monospace;
      background: rgba(255,180,60,0.10); color: rgba(255,180,60,0.7);
    }
    .perm-tool-name { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.85); }
    .perm-detail {
      font-size: 10px; font-family: 'JetBrains Mono', monospace;
      color: var(--t-faint); word-break: break-all; margin-bottom: 8px;
      padding: 4px 6px; background: rgba(0,0,0,0.15); border-radius: 4px;
    }
    .perm-actions { display: flex; gap: 6px; align-items: center; }
    .perm-btn {
      padding: 5px 14px; border-radius: 6px; font-size: 11px; font-weight: 600;
      cursor: pointer; border: 1px solid transparent; transition: all 0.15s;
    }
    .perm-btn-allow { background: rgba(80,200,120,0.12); color: rgba(80,200,120,0.9); border-color: rgba(80,200,120,0.2); }
    .perm-btn-allow:hover { background: rgba(80,200,120,0.2); }
    .perm-btn-deny { background: rgba(255,80,80,0.08); color: rgba(255,80,80,0.8); border-color: rgba(255,80,80,0.15); }
    .perm-btn-deny:hover { background: rgba(255,80,80,0.15); }
    .perm-always {
      font-size: 9px; color: var(--t-faint); margin-left: auto;
      display: flex; align-items: center; gap: 3px; cursor: pointer;
    }
    .perm-always input { width: 11px; height: 11px; cursor: pointer; }
    .perm-card.resolved { opacity: 0.5; }
    .perm-card.resolved .perm-btn { pointer-events: none; }

    /* ── Status / errors / thinking ── */
    .cp-messages .msg-status { padding: 2px 14px 2px 48px; font-size: 10px; color: var(--t-faint); font-family: 'JetBrains Mono', monospace; }
    .cp-messages .msg-error { padding: 4px 14px 4px 48px; font-size: 10.5px; color: #ff5252; font-family: 'JetBrains Mono', monospace; }
    .cp-messages .msg-tools-summary {
      font-size: 9.5px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2); padding: 3px 0; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cp-messages .thinking { display: flex; gap: 10px; align-items: center; padding: 10px 14px; }
    .cp-messages .think-avatar {
      width: 24px; height: 24px; border-radius: 7px;
      background: rgba(255,255,255,0.06);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; color: rgba(255,255,255,0.5);
    }
    .cp-messages .think-avatar svg { width: 14px; height: 14px; }
    .cp-messages .think-dots { display: flex; gap: 5px; align-items: center; }
    .cp-messages .think-dots span { width: 4px; height: 4px; border-radius: 50%; background: var(--t-secondary); animation: cp-pulse 1.4s ease-in-out infinite; }
    .cp-messages .think-dots span:nth-child(2) { animation-delay: 0.2s; }
    .cp-messages .think-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes cp-pulse { 0%,80%,100% { opacity: 0.15; transform: scale(0.6); } 40% { opacity: 1; transform: scale(1.1); } }

    /* ── Extended thinking blocks — matches tool-card design ── */
    .msg-thinking {
      border: 1px solid var(--b-subtle); border-radius: 8px;
      margin: 4px 0; overflow: hidden;
      background: var(--s-subtle); transition: border-color 0.2s;
    }
    .msg-thinking:hover { border-color: var(--b-light); }
    .msg-thinking summary {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 10px; cursor: pointer; user-select: none;
      transition: background 0.15s; list-style: none;
    }
    .msg-thinking summary::-webkit-details-marker { display: none; }
    .msg-thinking summary:hover { background: var(--s-hover); }
    .msg-thinking .msg-thinking-icon {
      width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
      font-size: 10px; color: var(--t-primary); background: var(--s-light); border-radius: 5px;
    }
    .msg-thinking .msg-thinking-label {
      font-family: 'JetBrains Mono', monospace; color: var(--t-primary);
      font-weight: 600; font-size: 10.5px;
    }
    .msg-thinking .msg-thinking-chevron {
      color: var(--t-faint); font-size: 13px; transition: transform 0.2s; margin-left: auto;
    }
    .msg-thinking[open] .msg-thinking-chevron { transform: rotate(90deg); color: var(--t-secondary); }
    .msg-thinking-content {
      display: none; border-top: 1px solid var(--b-subtle);
      padding: 6px 10px 8px; font-family: 'JetBrains Mono', monospace;
      font-size: 10px; color: var(--t-muted); white-space: pre-wrap;
      word-break: break-word; max-height: 300px; overflow-y: auto;
      line-height: 1.55; margin: 0; background: none;
    }
    .msg-thinking[open] .msg-thinking-content { display: block; }
    .msg-thinking-content::-webkit-scrollbar { width: 2px; }
    .msg-thinking-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

    .cp-messages .session-divider {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px; font-size: 9px; color: var(--t-faint);
      font-family: 'JetBrains Mono', monospace; letter-spacing: 0.05em;
    }
    .cp-messages .session-divider::before, .cp-messages .session-divider::after {
      content: ''; flex: 1; height: 1px; background: var(--b-subtle);
    }

    /* ── Bottom area (input + toolbar) ── */
    .cp-bottom {
      flex-shrink: 0;
      border-top: 1px solid rgba(255,255,255,0.04);
      background: rgba(14,14,18,0.4);
    }

    .cp-input-area {
      padding: 8px 12px 4px;
      display: flex; gap: 0; align-items: flex-end;
    }

    /* Animated border wrapper — conic gradient border on focus */
    .cp-input-wrap {
      flex: 1; position: relative;
      border-radius: 16px;
      padding: 1px; /* border thickness */
      background: rgba(255,255,255,0.06);
      transition: background 0.4s;
    }
    .cp-input-wrap::before {
      content: '';
      position: absolute; inset: 0;
      border-radius: 16px;
      padding: 1px;
      pointer-events: none;
      background: conic-gradient(
        from var(--cp-border-angle, 0deg),
        rgba(255,255,255,0.0) 0%,
        rgba(255,255,255,0.3) 25%,
        rgba(255,255,255,0.08) 50%,
        rgba(255,255,255,0.3) 75%,
        rgba(255,255,255,0.0) 100%
      );
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      opacity: 0;
      transition: opacity 0.4s;
    }
    .cp-input-wrap:focus-within::before {
      opacity: 1;
      animation: cp-border-spin 3s linear infinite;
    }
    .cp-input-wrap:focus-within {
      background: rgba(255,255,255,0.03);
      box-shadow: 0 0 20px rgba(255,255,255,0.04), 0 0 60px rgba(255,255,255,0.015);
    }
    @keyframes cp-border-spin {
      to { --cp-border-angle: 360deg; }
    }
    @property --cp-border-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }

    .cp-input-inner {
      display: flex; align-items: center;
      background: rgba(14,14,18,0.85);
      border-radius: 15px;
      padding: 4px 4px 4px 10px;
      gap: 2px;
      position: relative;
    }

    .cp-input {
      flex: 1; background: transparent; border: none;
      color: var(--t-bright); font-size: 12.5px;
      font-family: 'Inter', -apple-system, sans-serif; padding: 6px 0;
      resize: none; outline: none; line-height: 1.5;
      max-height: 150px; overflow-y: auto;
    }
    .cp-input::placeholder { color: rgba(255,255,255,0.18); transition: color 0.3s; }
    .cp-input:focus::placeholder { color: rgba(255,255,255,0.25); }

    .cp-send {
      background: linear-gradient(135deg, rgba(100,160,255,0.12), rgba(100,160,255,0.04));
      border: 1px solid rgba(100,160,255,0.1);
      border-radius: 10px;
      color: rgba(100,160,255,0.6); width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .cp-send:hover:not(:disabled) {
      transform: scale(1.08);
      background: linear-gradient(135deg, rgba(100,160,255,0.25), rgba(100,160,255,0.1));
      color: rgba(130,180,255,1);
      box-shadow: 0 0 12px rgba(100,160,255,0.15);
    }
    .cp-send:disabled { opacity: 0.12; cursor: default; }
    .cp-send.abort {
      background: linear-gradient(135deg, rgba(255,82,82,0.25), rgba(255,60,60,0.1));
      border-color: rgba(255,82,82,0.2);
      color: rgba(255,100,100,0.9);
      animation: cp-abort-pulse 1.5s ease-in-out infinite;
    }
    .cp-send.abort:hover {
      background: linear-gradient(135deg, rgba(255,82,82,0.4), rgba(255,60,60,0.2));
      color: #ff6666;
      box-shadow: 0 0 12px rgba(255,82,82,0.2);
    }
    @keyframes cp-abort-pulse {
      0%, 100% { border-color: rgba(255,82,82,0.2); }
      50% { border-color: rgba(255,82,82,0.45); }
    }
    .cp-send svg { width: 12px; height: 12px; }

    .cp-attach {
      background: none; border: none; cursor: pointer; padding: 2px 4px;
      color: rgba(235,235,240,0.25); position: relative; display: flex; align-items: center;
      flex-shrink: 0; transition: color 0.2s, transform 0.2s;
    }
    .cp-attach:hover { color: rgba(100,160,255,0.6); transform: rotate(-10deg); }
    .cp-attach-badge {
      position: absolute; top: -2px; right: -4px;
      background: #c8a050; color: #000; border-radius: 50%;
      font-size: 8px; width: 12px; height: 12px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700;
    }
    .cp-attach-badge[hidden] { display: none; }

    .file-link {
      color: #6ea8d8; text-decoration: none;
      border-bottom: 1px dotted rgba(110, 168, 216, 0.3);
      cursor: pointer;
    }
    .file-link:hover { text-decoration: underline; }

    /* ── Bottom toolbar ── */
    .cp-toolbar {
      display: flex; align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      padding: 4px 12px 8px;
      flex-shrink: 0;
    }
    .cp-toolbar-left { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
    .cp-toolbar-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

    .cp-brand {
      height: 16px; width: auto; opacity: 0.6; flex-shrink: 0;
    }

    .cp-dropdown {
      position: relative;
      display: flex; align-items: center; gap: 2px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 5px;
      padding: 2px 5px;
      cursor: pointer; user-select: none;
      max-width: 90px;
      flex-shrink: 1; min-width: 0;
      transition: border-color 0.15s, background 0.15s;
    }
    .cp-dropdown:hover { border-color: rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); }
    .cp-dropdown.open { border-color: rgba(255,255,255,0.15); background: rgba(255,255,255,0.06); }
    .cp-dropdown-sm { max-width: 72px; }
    .cp-dd-label {
      font-size: 9.5px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.4);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
    }
    .cp-dropdown.has-value .cp-dd-label { color: rgba(255,255,255,0.6); }
    .cp-dd-arrow {
      font-size: 8px; color: rgba(255,255,255,0.2); flex-shrink: 0;
      transition: transform 0.15s;
    }
    .cp-dropdown.open .cp-dd-arrow { transform: rotate(180deg); }
    .cp-dd-menu {
      display: none;
      position: absolute; bottom: calc(100% + 4px); left: 0;
      min-width: 100%; max-width: 200px;
      background: rgba(12, 12, 14, 0.98);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 4px;
      z-index: 300;
      box-shadow: 0 -8px 24px rgba(0,0,0,0.4);
      max-height: 200px; overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.06) transparent;
    }
    .cp-dropdown.open .cp-dd-menu { display: block; }
    .cp-dd-item {
      padding: 5px 8px;
      font-size: 10.5px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.55);
      border-radius: 5px; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background 0.1s, color 0.1s;
    }
    .cp-dd-item:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.8); }
    .cp-dd-item.selected { color: rgba(255,255,255,0.85); background: rgba(255,255,255,0.08); }

    .cp-cost {
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: var(--t-faint); padding: 1px 4px; border-radius: 6px;
      white-space: nowrap; flex-shrink: 0;
    }
    .cp-cost:hover { color: var(--t-secondary); }
    .cp-cost.flash { color: var(--t-primary); }

    .cp-btn {
      background: none; border: 1px solid var(--b-subtle); color: var(--t-faint);
      cursor: pointer; font-size: 12px; font-weight: 700;
      width: 20px; height: 20px; border-radius: 5px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s;
    }
    .cp-btn:hover { color: var(--t-primary); border-color: var(--b-hover); background: var(--s-hover); }

    /* Header button styles moved to .cp-header-btn */

    /* ── Image preview strip ── */
    .cp-image-preview {
      display: flex; gap: 6px; padding: 8px 12px 0;
      overflow-x: auto; flex-shrink: 0;
    }
    .cp-image-preview:empty { display: none; }
    .cp-thumb {
      position: relative; flex-shrink: 0;
      border-radius: 8px; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .cp-thumb img {
      height: 48px; width: auto; max-width: 80px;
      object-fit: cover; display: block;
    }
    .cp-thumb-x {
      position: absolute; top: 1px; right: 1px;
      background: rgba(0,0,0,0.7); border: none; color: rgba(255,255,255,0.7);
      width: 14px; height: 14px; border-radius: 50%;
      font-size: 10px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.15s;
    }
    .cp-thumb:hover .cp-thumb-x { opacity: 1; }
    .cp-thumb-x:hover { background: rgba(255,60,60,0.8); color: #fff; }

    /* ── File attachment chips ── */
    .cp-file-chip {
      display: flex; align-items: center; gap: 4px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px; padding: 3px 6px 3px 8px;
      flex-shrink: 0;
    }
    .cp-file-chip-name {
      font-size: 10px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.5); white-space: nowrap;
    }
    .cp-file-chip-x {
      background: none; border: none; color: rgba(255,255,255,0.25);
      cursor: pointer; font-size: 12px; line-height: 1; padding: 0 1px;
      transition: color 0.15s;
    }
    .cp-file-chip-x:hover { color: rgba(255,60,60,0.8); }

    /* ── Slash command hints ── */
    .cp-slash-hints {
      display: none;
      position: absolute; bottom: calc(100% + 4px); left: 0; right: 0;
      background: rgba(12,12,14,0.98);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; padding: 4px;
      z-index: 310; max-height: 200px; overflow-y: auto;
      box-shadow: 0 -8px 24px rgba(0,0,0,0.4);
    }
    .cp-slash-hints.open { display: block; }
    .cp-slash-item {
      padding: 6px 10px; border-radius: 6px; cursor: pointer;
      transition: background 0.12s;
    }
    .cp-slash-item:hover, .cp-slash-item.active { background: rgba(255,255,255,0.06); }
    .cp-slash-name {
      font-size: 11px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.7); font-weight: 600;
    }
    .cp-slash-desc {
      font-size: 9.5px; color: rgba(255,255,255,0.3);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* ── Drag-drop overlay ── */
    .cp-drop-overlay {
      position: absolute; inset: 0; z-index: 400;
      background: rgba(100,160,255,0.06);
      border: 2px dashed rgba(100,160,255,0.3);
      border-radius: inherit;
      display: flex; align-items: center; justify-content: center;
      color: rgba(100,160,255,0.5); font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      pointer-events: none;
    }

    /* ── Tool result images ── */
    .tool-result-content img {
      max-width: 100%; max-height: 300px;
      border-radius: 6px; margin: 4px 0; display: block;
    }

    /* ── Session selector header ── */
    .cp-header {
      position: relative;
      padding: 6px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      flex-shrink: 0;
      display: flex; align-items: center;
    }
    .cp-header-actions {
      display: flex; align-items: center; gap: 2px; margin-left: auto; flex-shrink: 0;
    }
    .cp-header-btn {
      display: flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; border-radius: 5px;
      border: none; background: transparent;
      color: rgba(255,255,255,0.35); cursor: pointer;
      transition: all 0.15s ease; position: relative;
    }
    .cp-header-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.7); }
    .cp-header-btn svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .cp-header-btn.cp-close-btn:hover { color: rgba(255,82,82,0.9); background: rgba(255,82,82,0.12); }
    .cp-header-btn.cp-close-btn svg { stroke-width: 2.5; }
    .cp-session-btn {
      background: none; border: none;
      display: flex; align-items: center; gap: 4px;
      color: rgba(255,255,255,0.45);
      font-size: 11px; font-family: 'JetBrains Mono', monospace;
      cursor: pointer; padding: 4px 8px; border-radius: 6px;
      transition: background 0.15s, color 0.15s;
      max-width: 100%; overflow: hidden;
    }
    .cp-session-btn:hover { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.65); }
    .cp-session-btn .cp-session-label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cp-session-menu {
      display: none; position: absolute;
      top: calc(100% + 2px); left: 8px; right: 8px;
      background: rgba(12, 12, 14, 0.98);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; padding: 4px;
      z-index: 310; max-height: 360px; overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.06) transparent;
    }
    .cp-session-menu.open { display: block; }
    .cp-session-menu::-webkit-scrollbar { width: 3px; }
    .cp-session-menu::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
    .cp-sess-group {
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2); letter-spacing: 0.5px;
      text-transform: uppercase; padding: 6px 8px 2px;
    }
    .cp-sess-group:first-child { padding-top: 4px; }
    .cp-sess-item {
      padding: 5px 8px; cursor: pointer; border-radius: 6px;
      transition: background 0.12s; position: relative;
    }
    .cp-sess-item:hover { background: rgba(255,255,255,0.06); }
    .cp-sess-item.active { background: rgba(255,255,255,0.08); }
    .cp-sess-prompt {
      font-size: 11px; color: rgba(255,255,255,0.5);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      line-height: 1.4;
    }
    .cp-sess-item:hover .cp-sess-prompt { color: rgba(255,255,255,0.8); }
    .cp-sess-item.active .cp-sess-prompt { color: rgba(255,255,255,0.75); }
    .cp-sess-meta {
      display: flex; align-items: center; gap: 5px;
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2); margin-top: 1px;
    }
    .cp-sess-branch {
      background: rgba(255,255,255,0.06);
      padding: 0 4px; border-radius: 3px;
    }
    .cp-rename-input {
      background: rgba(255,255,255,0.08); border: 1px solid rgba(100,160,255,0.3);
      border-radius: 4px; color: rgba(255,255,255,0.9);
      font-size: 11px; font-family: 'JetBrains Mono', monospace;
      padding: 2px 6px; width: 100%; outline: none;
    }
    .cp-rename-input:focus { border-color: rgba(100,160,255,0.5); }
    .cp-sess-rename {
      display: none; position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; padding: 2px 4px;
      color: rgba(255,255,255,0.15); font-size: 10px;
      transition: color 0.15s;
    }
    .cp-sess-item:hover .cp-sess-rename { display: block; }
    .cp-sess-rename:hover { color: rgba(100,160,255,0.7); }
    .cp-sess-new {
      padding: 5px 8px; cursor: pointer; border-radius: 6px;
      font-size: 11px; color: rgba(255,255,255,0.35);
      font-family: 'JetBrains Mono', monospace;
      transition: background 0.12s, color 0.12s;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      margin-bottom: 2px;
    }
    .cp-sess-new:hover { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.6); }
    .cp-sess-loading {
      padding: 12px 8px; text-align: center;
      font-size: 10px; color: rgba(255,255,255,0.2);
      font-family: 'JetBrains Mono', monospace;
    }

    /* ── Claude session pills in shared tray ── */
    .cp-session-pill .term-minimized-pill-icon { color: rgba(100, 160, 255, 0.6); }
    .cp-session-pill .term-minimized-pill-icon svg { width: 12px; height: 12px; }
    .cp-session-pill.cp-pill-enter {
      animation: cp-pill-pop-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    }
    @keyframes cp-pill-pop-in {
      0% { opacity: 0; transform: scale(0.6) translateX(12px); }
      100% { opacity: 1; transform: scale(1) translateX(0); }
    }
    .cp-session-pill.cp-pill-running .term-minimized-pill-label::before {
      content: ''; display: inline-block; width: 6px; height: 6px;
      border-radius: 50%; background: rgba(100, 200, 120, 0.7);
      margin-right: 5px; vertical-align: middle;
      animation: cp-pill-pulse 1.5s ease-in-out infinite;
    }
    @keyframes cp-pill-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

    /* ── Context gauge bar ── */
    .cp-context-bar {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 12px 5px; flex-shrink: 0;
    }
    .cp-gauge {
      flex: 1; height: 6px; border-radius: 3px;
      background: rgba(255,255,255,0.04);
      display: flex; overflow: hidden;
      position: relative; cursor: default;
      transition: background 0.4s;
    }
    .cp-gauge[data-urgency="warn"] { background: rgba(200,180,50,0.08); }
    .cp-gauge[data-urgency="high"] { background: rgba(220,130,50,0.12); }
    .cp-gauge[data-urgency="critical"] { background: rgba(220,60,60,0.15); }
    .cp-gauge-section {
      height: 100%; min-width: 1px;
      transition: width 0.4s ease;
      position: relative; border-radius: 1px;
    }
    .cp-gauge-section[data-cat="cache-read"] { background: rgba(100,140,200,0.5); }
    .cp-gauge-section[data-cat="cache-write"] { background: rgba(160,100,200,0.5); }
    .cp-gauge-section[data-cat="input"] { background: rgba(100,200,150,0.5); }
    .cp-gauge-section[data-cat="output"] { background: rgba(220,170,80,0.5); }
    .cp-gauge-tip {
      position: absolute; bottom: calc(100% + 8px); left: 50%;
      transform: translateX(-50%);
      background: rgba(8,8,10,0.95); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 4px; padding: 3px 7px;
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.7);
      white-space: nowrap; pointer-events: none;
      opacity: 0; transition: opacity 0.15s;
      z-index: 10;
    }
    .cp-gauge-section:hover .cp-gauge-tip { opacity: 1; }
    .cp-gauge-label {
      font-size: 8px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2); white-space: nowrap; flex-shrink: 0;
      transition: color 0.4s;
    }
    .cp-context-bar:has(.cp-gauge[data-urgency="warn"]) .cp-gauge-label { color: rgba(220,200,80,0.6); }
    .cp-context-bar:has(.cp-gauge[data-urgency="high"]) .cp-gauge-label { color: rgba(220,150,60,0.7); }
    .cp-context-bar:has(.cp-gauge[data-urgency="critical"]) .cp-gauge-label { color: rgba(220,80,60,0.8); }
    .cp-compact-btn {
      background: none; border: 1px solid rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.2); cursor: pointer;
      font-size: 8px; font-family: 'JetBrains Mono', monospace;
      padding: 1px 5px; border-radius: 3px;
      transition: all 0.15s; flex-shrink: 0;
      text-transform: uppercase; letter-spacing: 0.3px; font-weight: 600;
    }
    .cp-compact-btn:hover {
      color: rgba(255,255,255,0.5);
      border-color: rgba(255,255,255,0.15);
      background: rgba(255,255,255,0.04);
    }

    /* ── Think intensity toggle ── */
    .cp-think-toggle {
      background: none; border: 1px solid rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.3); cursor: pointer;
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      padding: 2px 7px; border-radius: 4px;
      transition: all 0.25s ease; flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 4px;
      position: relative; letter-spacing: 0.02em;
    }
    .cp-think-toggle:hover {
      color: rgba(255,255,255,0.55);
      border-color: rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.03);
    }
    .cp-think-icon { display: flex; align-items: center; transition: opacity 0.25s, transform 0.25s; opacity: 0.35; }
    .cp-think-icon svg { display: block; }
    .cp-think-label { transition: color 0.25s; font-weight: 500; }
    .cp-think-dots {
      display: flex; gap: 3px; align-items: center; margin-left: 1px;
    }
    .cp-think-dots i {
      display: block; width: 4px; height: 4px; border-radius: 50%;
      background: currentColor; opacity: 0.12; font-style: normal;
      transition: opacity 0.3s, background 0.3s, box-shadow 0.3s, transform 0.3s;
    }
    .cp-think-dots i.lit { opacity: 1; transform: scale(1.15); }
    /* off state — hide dots */
    .cp-think-toggle[data-effort="off"] .cp-think-dots { display: none; }
    /* low */
    .cp-think-toggle[data-effort="low"] {
      color: rgba(120,180,255,0.8); border-color: rgba(120,180,255,0.22);
      background: rgba(120,180,255,0.05);
    }
    .cp-think-toggle[data-effort="low"] .cp-think-icon { opacity: 0.7; }
    .cp-think-toggle[data-effort="low"] .cp-think-dots i.lit { background: rgba(120,180,255,0.9); }
    /* medium */
    .cp-think-toggle[data-effort="medium"] {
      color: rgba(140,170,255,0.8); border-color: rgba(140,170,255,0.2);
      background: rgba(140,170,255,0.05);
    }
    .cp-think-toggle[data-effort="medium"] .cp-think-icon { opacity: 0.8; }
    .cp-think-toggle[data-effort="medium"] .cp-think-dots i.lit { background: rgba(140,170,255,0.9); }
    /* high */
    .cp-think-toggle[data-effort="high"] {
      color: rgba(160,155,255,0.85); border-color: rgba(160,155,255,0.25);
      background: rgba(160,155,255,0.06);
    }
    .cp-think-toggle[data-effort="high"] .cp-think-icon { opacity: 0.9; }
    .cp-think-toggle[data-effort="high"] .cp-think-dots i.lit { background: rgba(160,155,255,0.9); }
    /* max */
    .cp-think-toggle[data-effort="max"] {
      color: rgba(180,160,255,0.9); border-color: rgba(180,160,255,0.28);
      background: rgba(180,160,255,0.07);
    }
    .cp-think-toggle[data-effort="max"] .cp-think-icon { opacity: 1; }
    .cp-think-toggle[data-effort="max"] .cp-think-dots i.lit { background: rgba(180,160,255,0.9); }

    /* ── Plan mode toggle ── */
    .cp-plan-toggle {
      background: none; border: 1px solid rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.25); cursor: pointer;
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      padding: 2px 6px; border-radius: 4px;
      transition: all 0.15s; flex-shrink: 0;
    }
    .cp-plan-toggle:hover {
      color: rgba(255,255,255,0.5);
      border-color: rgba(255,255,255,0.12);
    }
    .cp-plan-toggle.active {
      color: rgba(100,180,255,0.9);
      border-color: rgba(100,180,255,0.3);
      background: rgba(100,180,255,0.08);
    }

    /* ── Thinking timer ── */
    .cp-messages .think-timer {
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.12); margin-left: 4px;
    }

    /* ── Path attachment chips (for Send to AI) ── */
    .cp-path-chip {
      display: flex; align-items: center; gap: 5px;
      background: rgba(100,160,255,0.06);
      border: 1px solid rgba(100,160,255,0.12);
      border-radius: 6px; padding: 4px 6px 4px 8px;
      flex-shrink: 0;
    }
    .cp-path-chip-icon {
      color: rgba(100,160,255,0.4); flex-shrink: 0;
    }
    .cp-path-chip-icon svg { width: 12px; height: 12px; }
    .cp-path-chip-name {
      font-size: 10px; font-family: 'JetBrains Mono', monospace;
      color: rgba(100,160,255,0.6); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; max-width: 140px;
    }
    .cp-path-chip-x {
      background: none; border: none; color: rgba(255,255,255,0.2);
      cursor: pointer; font-size: 12px; line-height: 1; padding: 0 1px;
      transition: color 0.15s;
    }
    .cp-path-chip-x:hover { color: rgba(255,60,60,0.8); }
  `;
  document.head.appendChild(style);
}

// ── Custom dropdown helpers ──
function ddSetup(dd) {
  dd._value = '';
  dd.addEventListener('click', (e) => {
    if (e.target.closest('.cp-dd-item')) return;
    // close all others
    _panel.querySelectorAll('.cp-dropdown.open').forEach(d => { if (d !== dd) d.classList.remove('open'); });
    dd.classList.toggle('open');
  });
}
function ddPopulate(dd, items, selectedValue) {
  const menu = dd.querySelector('.cp-dd-menu');
  menu.innerHTML = '';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'cp-dd-item' + (item.value === selectedValue ? ' selected' : '');
    el.textContent = item.label;
    el.dataset.value = item.value;
    el.addEventListener('click', () => {
      dd._value = item.value;
      dd.querySelector('.cp-dd-label').textContent = item.label;
      dd.classList.add('has-value');
      dd.classList.remove('open');
      menu.querySelectorAll('.cp-dd-item').forEach(i => i.classList.remove('selected'));
      el.classList.add('selected');
      dd.dispatchEvent(new Event('change'));
    });
    menu.appendChild(el);
  }
  if (selectedValue) {
    const match = items.find(i => i.value === selectedValue);
    if (match) { dd.querySelector('.cp-dd-label').textContent = match.label; dd.classList.add('has-value'); dd._value = selectedValue; }
  }
}
function ddGetValue(dd) { return dd?._value || ''; }

// ── Think intensity helpers ──
function _setEffort(btn, level) {
  if (!btn) return;
  btn.dataset.effort = level;
  const label = btn.querySelector('.cp-think-label');
  if (label) label.textContent = EFFORT_LABELS[level] || 'Think';
  btn.setAttribute('data-tooltip', EFFORT_TITLES[level] || '');
  // Light up dots based on level
  const dots = btn.querySelectorAll('.cp-think-dots i');
  const count = { off: 0, low: 1, medium: 2, high: 3, max: 4 }[level] || 0;
  dots.forEach((d, i) => { d.classList.toggle('lit', i < count); });
}
function _getEffort() {
  const btn = _panel?.querySelector('#cp-think-toggle');
  const val = btn?.dataset.effort || 'off';
  return val === 'off' ? null : val;
}

// Close dropdowns on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.cp-dropdown')) {
    document.querySelectorAll('.cp-dropdown.open').forEach(d => d.classList.remove('open'));
  }
});

// ── Tab lifecycle ──
function createTab(sessionId = null, label = 'New chat', { autoSwitch = true } = {}) {
  if (_tabs.length >= MAX_TABS) return null;
  const tab = {
    id: crypto.randomUUID(),
    sessionId,
    label,
    ws: null,
    reconnectTimer: null,
    running: false,
    sessionCost: 0,
    messagesEl: null,
    thinkingEl: null,
    currentMsgEl: null,
    currentMsgId: null,
    attachedFiles: [],
    attachedImages: [],
    pendingAsk: null,
    pendingAskToolUseId: null,
    pendingAskRequestId: null,
    pillEl: null,
    draft: '',
    usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    turns: 0,
    thinkStartedAt: null,
    thinkTimerInterval: null,
    sendStartedAt: null,
    planMode: false,
  };
  // Create messages div
  const container = _panel.querySelector('#cp-messages-container');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'cp-messages';
  msgDiv.dataset.tabId = tab.id;
  msgDiv.style.display = 'none';
  container.appendChild(msgDiv);
  tab.messagesEl = msgDiv;
  // Connect WebSocket
  connectTab(tab);
  // Create pill (rendered in shared tray, not inside panel)
  tab.pillEl = _createTrayPill(tab);
  _tabs.push(tab);
  if (autoSwitch) switchTab(_tabs.length - 1);
  if (sessionId) loadSessionHistory(sessionId, tab.messagesEl);
  renderPills();
  if (autoSwitch) saveTabs();
  return tab;
}

function connectTab(tab) {
  if (tab.ws && (tab.ws.readyState === WebSocket.OPEN || tab.ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  tab.ws = new WebSocket(`${proto}//${location.host}/ws/claude-skin`);
  tab.ws.addEventListener('open', () => clearTimeout(tab.reconnectTimer));
  tab.ws.addEventListener('message', (e) => { try { handleTabMsg(tab, JSON.parse(e.data)); } catch (err) { console.error('[claude-panel] handleTabMsg error:', err, e.data?.slice?.(0, 200)); } });
  tab.ws.addEventListener('close', () => { tab.reconnectTimer = setTimeout(() => connectTab(tab), 2000); });
  tab.ws.addEventListener('error', () => tab.ws.close());
}

function switchTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const prev = activeTab();
  if (prev && prev !== _tabs[idx]) {
    const $input = _panel?.querySelector('#cp-input');
    if ($input) prev.draft = $input.value;
    // Animate out
    prev.messagesEl.classList.remove('cp-tab-enter');
    prev.messagesEl.classList.add('cp-tab-exit');
    const prevEl = prev.messagesEl;
    prevEl.addEventListener('animationend', () => {
      prevEl.classList.remove('cp-tab-exit');
      prevEl.style.display = 'none';
    }, { once: true });
  }
  _activeTabIdx = idx;
  const tab = activeTab();
  tab.messagesEl.style.display = '';
  tab.messagesEl.classList.remove('cp-tab-exit');
  tab.messagesEl.classList.add('cp-tab-enter');
  tab.messagesEl.addEventListener('animationend', () => {
    tab.messagesEl.classList.remove('cp-tab-enter');
  }, { once: true });
  // Restore draft
  const $input = _panel?.querySelector('#cp-input');
  if ($input) { $input.value = tab.draft || ''; autoResize(); }
  // Update header
  const headerLabel = _panel?.querySelector('.cp-session-label');
  if (headerLabel) headerLabel.textContent = tab.label || 'New chat';
  _updateCostLabel();
  // Update send button state
  const $send = _panel?.querySelector('#cp-send');
  if ($send && $input) {
    if (tab.running) {
      $send.disabled = false;
      $send.classList.add('abort');
      $send.innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
      $input.disabled = true;
    } else {
      $send.classList.remove('abort');
      $send.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
      $input.disabled = false;
      $send.disabled = !$input.value.trim() && !tab.attachedImages.length;
    }
  }
  // Scroll
  requestAnimationFrame(() => { tab.messagesEl.scrollTop = tab.messagesEl.scrollHeight; });
  updateAttachBadge();
  // Rebuild image/file preview for this tab
  const preview = _panel?.querySelector('#cp-image-preview');
  if (preview) {
    preview.innerHTML = '';
    tab.attachedImages.forEach((img, i) => addImagePreview(`data:${img.mediaType};base64,${img.base64}`, i));
    tab.attachedFiles.forEach((f, i) => {
      if (f.path) _addPathChip(tab, f.name, f.path, i);
      else addFilePreview(f.name, i);
    });
  }
  // Sync plan toggle
  const $plan = _panel?.querySelector('#cp-plan-toggle');
  if ($plan) $plan.classList.toggle('active', tab.planMode);
  // Sync context gauge
  renderGauge(tab);
  renderPills();
  saveTabs();
}

function closeTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const tab = _tabs[idx];
  clearTimeout(tab.reconnectTimer);
  if (tab.ws) { tab.ws.onclose = null; tab.ws.close(); }
  tab.messagesEl.remove();
  if (tab.pillEl) tab.pillEl.remove();
  _tabs.splice(idx, 1);
  if (_tabs.length === 0) {
    _activeTabIdx = -1;
    createTab(null, 'New chat');
    return;
  }
  if (_activeTabIdx === idx) {
    _activeTabIdx = Math.min(idx, _tabs.length - 1);
    switchTab(_activeTabIdx);
  } else if (_activeTabIdx > idx) {
    _activeTabIdx--;
  }
  renderPills();
  saveTabs();
}

const _CP_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

function _createTrayPill(tab) {
  const tray = document.getElementById('term-minimized-tray');
  if (!tray) return null;
  const pill = document.createElement('div');
  pill.className = 'term-minimized-pill cp-session-pill';
  pill.dataset.tabId = tab.id;
  pill.innerHTML = `
    <span class="term-minimized-pill-icon">${_CP_ICON_SVG}</span>
    <span class="term-minimized-pill-label">${escH(trunc(tab.label, 16))}</span>
    <button class="term-minimized-pill-close" data-tooltip="Close">&times;</button>
  `;
  pill.addEventListener('click', () => {
    const idx = _tabs.indexOf(tab);
    if (idx >= 0) {
      if (!_visible) toggleClaudePanel();
      switchTab(idx);
    }
  });
  pill.querySelector('.term-minimized-pill-close').addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = _tabs.indexOf(tab);
    if (idx >= 0) closeTab(idx);
  });
  pill.style.display = 'none'; // Hidden by default; renderPills() controls visibility
  tray.appendChild(pill);
  return pill;
}

function renderPills() {
  const activeIdx = _activeTabIdx;
  const panelOpen = _visible;
  for (let i = 0; i < _tabs.length; i++) {
    const tab = _tabs[i];
    if (!tab.pillEl) tab.pillEl = _createTrayPill(tab);
    if (!tab.pillEl) continue;
    const isActive = i === activeIdx;
    const shouldShow = !isActive || !panelOpen;
    const wasHidden = tab.pillEl.style.display === 'none';
    tab.pillEl.style.display = shouldShow ? '' : 'none';
    // Animate pill appearing
    if (shouldShow && wasHidden) {
      tab.pillEl.classList.remove('cp-pill-enter');
      void tab.pillEl.offsetWidth; // force reflow
      tab.pillEl.classList.add('cp-pill-enter');
      tab.pillEl.addEventListener('animationend', () => {
        tab.pillEl.classList.remove('cp-pill-enter');
      }, { once: true });
    }
  }
}

function updatePillLabel(tab) {
  if (!tab.pillEl) return;
  const lbl = tab.pillEl.querySelector('.term-minimized-pill-label');
  if (lbl) lbl.textContent = trunc(tab.label, 16);
}

function updatePillRunning(tab) {
  if (tab.pillEl) tab.pillEl.classList.toggle('cp-pill-running', tab.running);
}

function saveTabs() {
  try {
    storage.setItem(STOR.tabs, JSON.stringify({
      tabs: _tabs.map(t => ({ id: t.id, sessionId: t.sessionId, label: t.label })),
      activeIdx: _activeTabIdx,
    }));
  } catch {}
}

function restoreTabs() {
  try {
    const raw = storage.getItem(STOR.tabs);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.tabs?.length) {
        for (const saved of data.tabs) {
          createTab(saved.sessionId, saved.label, { autoSwitch: false });
        }
        switchTab(Math.min(data.activeIdx || 0, _tabs.length - 1));
        return;
      }
    }
  } catch {}
  // Backward compat: old single-session storage
  const oldSid = storage.getItem(STOR.session);
  if (oldSid) {
    const label = getLabel(oldSid) || oldSid.slice(0, 8) + '...';
    createTab(oldSid, label);
  } else {
    createTab(null, 'New chat');
  }
}

// ── Session selector helpers ──
const LABEL_PREFIX = 'synabun-session-label:';
function getLabel(id) { try { return storage.getItem(LABEL_PREFIX + id) || ''; } catch { return ''; } }
function cleanPrompt(raw) { return (raw || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function relDate(d) {
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000), h = Math.floor(ms / 3600000), dy = Math.floor(ms / 86400000);
  if (m < 1) return 'now'; if (m < 60) return m + 'm ago'; if (h < 24) return h + 'h ago'; if (dy < 30) return dy + 'd ago';
  return Math.floor(dy / 30) + 'mo ago';
}
function timeGroup(d) {
  const now = new Date(), dt = new Date(d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = today - new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  if (diff <= 0) return 'Today'; if (diff <= 86400000) return 'Yesterday';
  if (diff <= 604800000) return 'This Week'; return 'Older';
}
function trunc(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }
function escH(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function renderSessionMenu() {
  const menu = _panel?.querySelector('#cp-session-menu');
  if (!menu) return;
  menu.innerHTML = '<div class="cp-sess-loading">loading sessions...</div>';
  try {
    const $project = _panel?.querySelector('#cp-project');
    const currentProject = ddGetValue($project) || undefined;
    const data = await fetchClaudeSessions({ limit: 30, project: currentProject });
    if (!data?.projects?.length) { menu.innerHTML = '<div class="cp-sess-loading">no sessions found</div>'; return; }
    let html = '<div class="cp-sess-new">+ New chat</div>';
    for (const proj of data.projects) {
      const groups = {};
      for (const s of (proj.sessions || [])) {
        if (s.deleted) continue;
        const g = timeGroup(s.modified || s.created);
        (groups[g] = groups[g] || []).push(s);
      }
      for (const g of ['Today', 'Yesterday', 'This Week', 'Older']) {
        if (!groups[g]?.length) continue;
        html += `<div class="cp-sess-group">${escH(g)}</div>`;
        for (const s of groups[g]) {
          const label = getLabel(s.sessionId) || cleanPrompt(s.firstPrompt) || 'Empty session';
          const active = s.sessionId === activeTab()?.sessionId ? ' active' : '';
          html += `<div class="cp-sess-item${active}" data-sid="${escH(s.sessionId)}" data-cwd="${escH(proj.path)}">`;
          html += `<div class="cp-sess-prompt">${escH(trunc(label, 60))}</div>`;
          html += `<button class="cp-sess-rename" data-sid="${escH(s.sessionId)}" title="Rename">&#x270E;</button>`;
          html += `<div class="cp-sess-meta"><span>${relDate(s.modified || s.created)}</span>`;
          if (s.gitBranch) html += `<span class="cp-sess-branch">${escH(s.gitBranch)}</span>`;
          if (s.messageCount) html += `<span>${s.messageCount} msgs</span>`;
          html += `</div></div>`;
        }
      }
    }
    menu.innerHTML = html;
    // Wire clicks
    menu.querySelector('.cp-sess-new')?.addEventListener('click', () => {
      selectSession(null, 'New chat');
      menu.classList.remove('open');
    });
    menu.querySelectorAll('.cp-sess-item').forEach(el => {
      el.addEventListener('click', () => {
        const sid = el.dataset.sid;
        const label = el.querySelector('.cp-sess-prompt')?.textContent || 'Resumed';
        selectSession(sid, label);
        // Update cwd to match the session's project
        const $project = _panel?.querySelector('#cp-project');
        if ($project && el.dataset.cwd) {
          ddPopulate($project, _projects.map(p => ({ value: p.path, label: p.label || p.path.split(/[/\\]/).pop() })), el.dataset.cwd);
          storage.setItem(STOR.project, el.dataset.cwd);
        }
        menu.classList.remove('open');
      });
    });
    // Wire rename buttons
    menu.querySelectorAll('.cp-sess-rename').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sid;
        const item = btn.closest('.cp-sess-item');
        const promptEl = item?.querySelector('.cp-sess-prompt');
        if (!promptEl) return;
        const currentName = getLabel(sid) || promptEl.textContent;
        const input = document.createElement('input');
        input.type = 'text'; input.value = currentName;
        input.className = 'cp-rename-input';
        input.placeholder = 'Session name...';
        promptEl.textContent = '';
        promptEl.appendChild(input);
        btn.style.display = 'none';
        input.focus(); input.select();

        function commit() {
          const val = input.value.trim();
          input.remove();
          if (val) {
            storage.setItem(LABEL_PREFIX + sid, val);
            promptEl.textContent = trunc(val, 60);
          } else {
            storage.removeItem(LABEL_PREFIX + sid);
            promptEl.textContent = currentName;
          }
          btn.style.display = '';
          // Update header + pill if this is the active session
          const curTab = activeTab();
          if (curTab && sid === curTab.sessionId) {
            const headerLabel = _panel?.querySelector('.cp-session-label');
            if (headerLabel) headerLabel.textContent = val || currentName;
            curTab.label = val || currentName;
            updatePillLabel(curTab);
            saveTabs();
          }
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
          if (e.key === 'Escape') { input.value = currentName; input.blur(); }
        });
      });
    });
  } catch (err) {
    menu.innerHTML = '<div class="cp-sess-loading">failed to load</div>';
  }
}

function selectSession(sid, label) {
  const tab = activeTab();
  if (!tab) return;
  tab.sessionId = sid;
  tab.sessionCost = 0;
  tab.currentMsgEl = null;
  tab.currentMsgId = null;
  tab.label = label || 'New chat';
  tab.usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  tab.turns = 0;
  _updateCostLabel();
  renderGauge(tab);
  updatePillLabel(tab);
  const btn = _panel?.querySelector('.cp-session-label');
  if (btn) btn.textContent = tab.label;
  tab.messagesEl.innerHTML = '';
  if (sid) loadSessionHistory(sid, tab.messagesEl);
  saveTabs();
}

function renameSession(sid, currentLabel) {
  if (!sid) return;
  const btn = _panel?.querySelector('.cp-session-label');
  if (!btn) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentLabel || '';
  input.className = 'cp-rename-input';
  input.placeholder = 'Session name...';
  btn.textContent = '';
  btn.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    input.remove();
    if (val) {
      storage.setItem(LABEL_PREFIX + sid, val);
      btn.textContent = val;
    } else {
      storage.removeItem(LABEL_PREFIX + sid);
      btn.textContent = getLabel(sid) || sid.slice(0, 8) + '...';
    }
    const tab = activeTab();
    if (tab && tab.sessionId === sid) {
      tab.label = btn.textContent;
      updatePillLabel(tab);
      saveTabs();
    }
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentLabel || ''; input.blur(); }
  });
}

async function loadSessionHistory(sid, $msgs) {
  if (!$msgs) $msgs = activeTab()?.messagesEl;
  if (!$msgs) return;
  const $project = _panel?.querySelector('#cp-project');
  const project = ddGetValue($project) || undefined;
  const params = new URLSearchParams({ limit: '500' });
  if (project) params.set('project', project);
  try {
    const res = await fetch(`/api/claude-code/sessions/${encodeURIComponent(sid)}/messages?${params}`);
    const data = await res.json();
    if (!data.messages?.length) {
      $msgs.innerHTML = '<div class="msg-status">No messages in this session</div>';
      return;
    }
    for (const m of data.messages) {
      if (m.role === 'user') {
        const el = document.createElement('div'); el.className = 'msg msg-user';
        const bubble = document.createElement('div'); bubble.className = 'msg-bubble'; bubble.textContent = m.text;
        el.appendChild(bubble); $msgs.appendChild(el);
      } else if (m.role === 'assistant') {
        const el = document.createElement('div'); el.className = 'msg msg-assistant';
        const avatar = document.createElement('div'); avatar.className = 'msg-avatar';
        avatar.innerHTML = CLAUDE_ICON; el.appendChild(avatar);
        const wrap = document.createElement('div'); wrap.className = 'msg-content';
        if (m.text) {
          const body = document.createElement('div'); body.className = 'msg-body';
          body.innerHTML = md(m.text);
          linkifyFilePaths(body);
          wrap.appendChild(body);
        }
        if (m.tools?.length) {
          for (const t of m.tools) {
            if (typeof t === 'object' && t.name) {
              wrap.appendChild(buildTool(t));
            } else {
              // Legacy: tool name string only
              const summary = document.createElement('div'); summary.className = 'msg-tools-summary';
              summary.textContent = String(t).replace(/^mcp__SynaBun__/, '');
              wrap.appendChild(summary);
            }
          }
        }
        el.appendChild(wrap); $msgs.appendChild(el);
      } else if (m.role === 'tool_result' && m.toolUseId) {
        // Match result to its tool card
        const card = $msgs.querySelector(`.tool-card[data-tool-id="${CSS.escape(m.toolUseId)}"]`);
        if (card) {
          const rLbl = card.querySelector('.tool-result-label');
          const rSec = card.querySelector('.tool-result-content');
          if (rSec && m.text) {
            rSec.textContent = m.text.slice(0, 2000);
            rLbl.hidden = false; rSec.hidden = false;
            card.classList.add(m.isError ? 'tool-error' : 'tool-ok');
          }
        }
      }
    }
    if (data.total > data.messages.length) {
      const note = document.createElement('div'); note.className = 'msg-status';
      note.textContent = `Showing last ${data.messages.length} of ${data.total} messages`;
      $msgs.prepend(note);
    }
    // Populate context gauge from session history usage
    const tab = activeTab();
    if (tab && data.usage) {
      tab.usage.inputTokens = data.usage.input_tokens || 0;
      tab.usage.outputTokens = data.usage.output_tokens || 0;
      tab.usage.cacheRead = data.usage.cache_read_input_tokens || 0;
      tab.usage.cacheWrite = data.usage.cache_creation_input_tokens || 0;
      tab.turns = data.turns || 0;
      renderGauge(tab);
    }
    scrollEnd();
  } catch {
    $msgs.innerHTML = '<div class="msg-status">Failed to load history</div>';
  }
}

// ── File path linking ──
function linkifyFilePaths(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const pathRe = /(?:(?:[A-Za-z]:)?(?:[/\\][\w.@\-]+){2,}(?::(\d+))?)(?=\s|$|[)"',;])/g;
  for (const node of nodes) {
    if (node.parentElement?.closest('pre, code, a')) continue;
    const text = node.textContent;
    pathRe.lastIndex = 0;
    if (!pathRe.test(text)) continue;
    pathRe.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, match;
    while ((match = pathRe.exec(text))) {
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const a = document.createElement('a');
      a.className = 'file-link';
      a.href = '#';
      a.textContent = match[0];
      a.title = 'Click to copy path';
      const path = match[0].replace(/:\d+$/, '');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(path);
        a.style.opacity = '0.5';
        setTimeout(() => a.style.opacity = '', 300);
      });
      frag.appendChild(a);
      last = match.index + match[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (last > 0) node.parentNode.replaceChild(frag, node);
  }
}

// ── Cost loading ──
async function loadMonthlyCost() {
  try {
    const res = await fetch('/api/claude-skin/cost').then(r => r.json());
    if (res.month) {
      _totalCost = res.month.totalUsd || 0;
    }
  } catch {}
  _updateCostLabel();
}

function _updateCostLabel() {
  const $cost = _panel?.querySelector('#cp-cost');
  if (!$cost) return;
  const sc = activeTab()?.sessionCost || 0;
  $cost.textContent = `$${sc.toFixed(2)}`;
  const monthLabel = new Date().toLocaleString('en', { month: 'short' });
  $cost.title = `Session cost · ${monthLabel} total: $${_totalCost.toFixed(2)}`;
}

// ── Context gauge ──
const CONTEXT_WINDOW = 200000;

function renderGauge(tab) {
  const $gauge = _panel?.querySelector('#cp-gauge');
  const $label = _panel?.querySelector('#cp-gauge-label');
  if (!$gauge) return;

  const u = tab.usage;
  const total = u.inputTokens;
  if (total === 0) {
    $gauge.innerHTML = '';
    $gauge.dataset.urgency = '';
    if ($label) { $label.textContent = ''; $label.title = ''; }
    return;
  }

  const cacheRead = u.cacheRead || 0;
  const cacheWrite = u.cacheWrite || 0;
  const uncachedInput = Math.max(0, u.inputTokens - cacheRead - cacheWrite);

  const pct = (v) => Math.max(0, (v / CONTEXT_WINDOW) * 100).toFixed(2) + '%';
  const fmt = (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v);

  const sections = [
    { cat: 'cache-read', val: cacheRead, label: `Cached: ${fmt(cacheRead)} tokens` },
    { cat: 'cache-write', val: cacheWrite, label: `New cache: ${fmt(cacheWrite)} tokens` },
    { cat: 'input', val: uncachedInput, label: `Input: ${fmt(uncachedInput)} tokens` },
  ].filter(s => s.val > 0);

  $gauge.innerHTML = sections.map(s =>
    `<div class="cp-gauge-section" data-cat="${s.cat}" style="width:${pct(s.val)}"><div class="cp-gauge-tip">${s.label}</div></div>`
  ).join('');

  const pctUsed = Math.round((total / CONTEXT_WINDOW) * 100);
  $gauge.dataset.urgency = pctUsed < 50 ? '' : pctUsed < 75 ? 'warn' : pctUsed < 90 ? 'high' : 'critical';

  if ($label) {
    $label.textContent = `${fmt(total)}/${fmt(CONTEXT_WINDOW)}`;
    $label.title = `${pctUsed}% context · ${fmt(u.outputTokens || 0)} output · ${tab.turns} turn${tab.turns !== 1 ? 's' : ''}`;
  }
}

// ── File attachment ──
const _TEXT_EXTENSIONS = new Set([
  'txt','md','js','ts','jsx','tsx','json','html','css','scss','less','xml','svg',
  'py','rb','go','rs','java','c','cpp','h','hpp','cs','php','sh','bash','zsh',
  'yml','yaml','toml','ini','cfg','conf','env','gitignore','dockerignore',
  'sql','graphql','proto','csv','tsv','log','diff','patch','vue','svelte',
  'mjs','cjs','mts','cts','astro','mdx','rst','tex','lua','r','swift','kt',
  'dockerfile','makefile','cmake','gradle','bat','ps1','fish',
]);
function _isTextFile(name) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return _TEXT_EXTENSIONS.has(ext) || !name.includes('.');
}

function buildPromptWithAttachments(tab, userText) {
  if (!tab.attachedFiles.length) return userText;
  let prompt = '';
  for (const f of tab.attachedFiles) {
    const pathAttr = f.path || f.name;
    prompt += `<file path="${pathAttr}">\n${f.content}\n</file>\n\n`;
  }
  prompt += userText;
  tab.attachedFiles = [];
  updateAttachBadge();
  _panel?.querySelectorAll('.cp-file-chip').forEach(c => c.remove());
  return prompt;
}

function updateAttachBadge() {
  const badge = _panel?.querySelector('.cp-attach-badge');
  if (badge) {
    const tab = activeTab();
    const count = (tab?.attachedFiles.length || 0) + (tab?.attachedImages.length || 0);
    badge.textContent = count || '';
    badge.hidden = !count;
  }
}

// ── WebSocket (per-tab) ──
function handleTabMsg(tab, msg) {
  if (msg.type === 'control_request') console.log('[claude-panel] Got control_request msg:', msg.type, msg.request_id, msg.request?.subtype, msg.request?.tool_name);
  switch (msg.type) {
    case 'event': handleTabEvent(tab, msg.event); break;
    case 'control_request': handleControlRequest(tab, msg); break;
    case 'stderr': if (msg.text?.trim()) appendStatus(tab, msg.text.trim()); break;
    case 'done': finishTab(tab); break;
    case 'aborted': finishTab(tab); appendStatus(tab, 'Aborted.'); break;
    case 'error': finishTab(tab); appendError(tab, msg.message); break;
  }
}

function handleTabEvent(tab, ev) {
  if (!ev?.type) return;

  if (ev.type === 'system' && (ev.subtype === 'compact' || ev.subtype === 'compact_started')) {
    appendStatus(tab, ev.message || 'Compacting context...');
    return;
  }
  if (ev.type === 'system' && ev.subtype === 'init') {
    if (ev.session_id) {
      tab.sessionId = ev.session_id;
      if (tab.label === 'New chat') {
        const label = getLabel(ev.session_id);
        tab.label = label || ev.session_id.slice(0, 8) + '...';
        updatePillLabel(tab);
      }
      if (tab === activeTab()) {
        const btn = _panel?.querySelector('.cp-session-label');
        if (btn) btn.textContent = tab.label;
      }
      saveTabs();
    }
    return;
  }
  if (ev.type === 'assistant' && ev.message) {
    if (ev.message.usage) {
      const u = ev.message.usage;
      tab.usage.inputTokens = u.input_tokens || 0;
      tab.usage.outputTokens = u.output_tokens || 0;
      tab.usage.cacheRead = u.cache_read_input_tokens || 0;
      tab.usage.cacheWrite = u.cache_creation_input_tokens || 0;
      if (tab === activeTab()) renderGauge(tab);
    }
    renderAssistant(tab, ev.message);
    // Reposition thinking indicator to bottom (stays visible while running)
    if (tab.thinkingEl && tab.running) {
      tab.thinkingEl.remove();
      tab.messagesEl.appendChild(tab.thinkingEl);
      if (tab === activeTab()) scrollEnd();
    }
    return;
  }
  if (ev.type === 'tool_result') {
    updateToolResult(tab, ev);
    // Re-show thinking — Claude is processing the tool result
    if (tab.running && !tab.pendingAsk) showThinking(tab);
    return;
  }
  if (ev.type === 'result') {
    finishTab(tab);
    tab.turns++;
    if (ev.usage) {
      const u = ev.usage;
      tab.usage.inputTokens = u.input_tokens || tab.usage.inputTokens;
      tab.usage.outputTokens = u.output_tokens || tab.usage.outputTokens;
      tab.usage.cacheRead = u.cache_read_input_tokens || tab.usage.cacheRead;
      tab.usage.cacheWrite = u.cache_creation_input_tokens || tab.usage.cacheWrite;
      if (tab === activeTab()) renderGauge(tab);
    }
    if (ev.total_cost_usd != null) {
      tab.sessionCost += ev.total_cost_usd;
      _totalCost += ev.total_cost_usd;
      if (tab === activeTab()) {
        _updateCostLabel();
        const $cost = _panel?.querySelector('#cp-cost');
        if ($cost) { $cost.classList.add('flash'); setTimeout(() => $cost.classList.remove('flash'), 800); }
      }
      emit('cost:updated', { amount: ev.total_cost_usd, total: _totalCost });
    }
    if (ev.session_id) { tab.sessionId = ev.session_id; saveTabs(); }
  }
}

function renderAssistant(tab, msg) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  const content = msg.content || [];
  const thinks = content.filter(b => b.type === 'thinking');
  const texts = content.filter(b => b.type === 'text');
  const tools = content.filter(b => b.type === 'tool_use');
  // Suppress thinking display when Think toggle is off
  if (!_getEffort()) thinks.length = 0;
  if (!texts.length && !tools.length && !thinks.length) return;

  const askTools = tools.filter(t => t.name === 'AskUserQuestion');
  const regularTools = tools.filter(t => t.name !== 'AskUserQuestion');

  // Partial message dedup
  const msgId = msg.id || null;
  if (msgId && msgId === tab.currentMsgId && tab.currentMsgEl) {
    const wrap = tab.currentMsgEl.querySelector('.msg-content');
    if (wrap) {
      // Update thinking block
      if (thinks.length) {
        const thinkText = thinks.map(b => b.thinking || '').join('\n').trim();
        if (thinkText) {
          let thinkEl = wrap.querySelector('.msg-thinking');
          if (thinkEl) {
            thinkEl.querySelector('.msg-thinking-content').textContent = thinkText;
          } else {
            thinkEl = document.createElement('details');
            thinkEl.className = 'msg-thinking';
            thinkEl.innerHTML = `<summary><span class="msg-thinking-icon">&#x26A1;</span><span class="msg-thinking-label">Thinking</span><span class="msg-thinking-chevron">&#x203A;</span></summary><div class="msg-thinking-content"></div>`;
            thinkEl.querySelector('.msg-thinking-content').textContent = thinkText;
            wrap.insertBefore(thinkEl, wrap.firstChild);
          }
        }
      }
      const existingBody = wrap.querySelector('.msg-body');
      if (texts.length) {
        const html = md(texts.map(b => b.text).join('\n'));
        if (existingBody) {
          existingBody.innerHTML = html;
          linkifyFilePaths(existingBody);
        } else {
          const body = document.createElement('div');
          body.className = 'msg-body';
          body.innerHTML = html;
          linkifyFilePaths(body);
          const afterThink = wrap.querySelector('.msg-thinking');
          if (afterThink) afterThink.after(body);
          else wrap.insertBefore(body, wrap.firstChild);
        }
      }
      const existingToolIds = new Set([...wrap.querySelectorAll('.tool-card')].map(c => c.dataset.toolId));
      for (const t of regularTools) {
        if (!existingToolIds.has(t.id || '')) wrap.appendChild(buildTool(t));
      }
      const existingAskIds = new Set([...wrap.querySelectorAll('.ask-card')].map(c => c.dataset.toolId));
      for (const t of askTools) {
        if (!existingAskIds.has(t.id || '')) {
          wrap.appendChild(buildAskFromToolUse(tab, t));
        }
      }
    }
    if (tab === activeTab()) scrollEnd();
    return;
  }

  // New assistant message
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = CLAUDE_ICON;
  el.appendChild(avatar);
  const wrap = document.createElement('div');
  wrap.className = 'msg-content';
  if (thinks.length) {
    const thinkText = thinks.map(b => b.thinking || '').join('\n').trim();
    if (thinkText) {
      const thinkEl = document.createElement('details');
      thinkEl.className = 'msg-thinking';
      thinkEl.innerHTML = `<summary><span class="msg-thinking-icon">&#x26A1;</span><span class="msg-thinking-label">Thinking</span><span class="msg-thinking-chevron">&#x203A;</span></summary><div class="msg-thinking-content"></div>`;
      thinkEl.querySelector('.msg-thinking-content').textContent = thinkText;
      wrap.appendChild(thinkEl);
    }
  }
  if (texts.length) {
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = md(texts.map(b => b.text).join('\n'));
    linkifyFilePaths(body);
    wrap.appendChild(body);
  }
  for (const t of regularTools) wrap.appendChild(buildTool(t));
  for (const t of askTools) wrap.appendChild(buildAskFromToolUse(tab, t));
  el.appendChild(wrap);
  $msgs.appendChild(el);

  if (msgId) { tab.currentMsgId = msgId; tab.currentMsgEl = el; }
  if (tab === activeTab()) scrollEnd();
}

/** Build an interactive AskUserQuestion card from a tool_use block */
function buildAskFromToolUse(tab, block) {
  const input = block.input || {};
  const toolUseId = block.id || '';
  tab.pendingAskToolUseId = toolUseId;

  // Normalize: accept questions array, single question object, or flat input
  const questions = Array.isArray(input.questions) ? input.questions
    : (input.question || input.text || input.options) ? [input]
    : [input];
  const container = document.createElement('div');
  container.className = 'ask-card';
  container.dataset.toolId = toolUseId;

  for (const q of questions) {
    const questionText = q.question || q.text || q.header || '';

    if (q.header) {
      const hdr = document.createElement('div');
      hdr.className = 'ask-header';
      hdr.textContent = q.header;
      container.appendChild(hdr);
    }
    if (questionText && questionText !== q.header) {
      const qEl = document.createElement('div');
      qEl.className = 'ask-question';
      qEl.textContent = questionText;
      container.appendChild(qEl);
    }

    if (q.options?.length) {
      const opts = document.createElement('div');
      opts.className = 'ask-options';
      for (const opt of q.options) {
        const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || String(opt));
        const optDesc = typeof opt === 'string' ? '' : (opt.description || '');
        const btn = document.createElement('button');
        btn.className = 'ask-option';
        const lbl = document.createElement('span');
        lbl.className = 'ask-option-label';
        lbl.textContent = optLabel;
        btn.appendChild(lbl);
        if (optDesc) {
          const desc = document.createElement('span');
          desc.className = 'ask-option-desc';
          desc.textContent = optDesc;
          btn.appendChild(desc);
        }
        btn.addEventListener('click', () => {
          opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = true; });
          btn.classList.add('selected');
          const answers = {};
          answers[questionText] = optLabel;
          sendAskAnswer(tab, input.questions || [q], answers);
        });
        opts.appendChild(btn);
      }
      container.appendChild(opts);
    } else {
      const hint = document.createElement('div');
      hint.className = 'ask-hint';
      hint.textContent = 'Type your answer below and press Enter';
      container.appendChild(hint);
      tab.pendingAsk = { requestId: null, toolUseId, questions: input.questions || [q], questionText };
      setRunning(tab, false);
    }
  }

  hideThinking(tab);
  setRunning(tab, false);
  return container;
}

function sendAskAnswer(tab, questions, answers) {
  if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;

  const requestId = tab.pendingAskRequestId;
  console.log('[claude-panel] sendAskAnswer request_id:', requestId, 'answers:', JSON.stringify(answers).slice(0, 200));

  if (!requestId) {
    // control_request hasn't arrived yet — buffer the answer and send when it does
    console.log('[claude-panel] No request_id yet, buffering answer');
    tab.pendingAskBufferedAnswer = { questions, answers };
    showThinking(tab);
    setRunning(tab, true);
    return;
  }

  tab.ws.send(JSON.stringify({
    type: 'control_response',
    request_id: requestId,
    response: { updatedInput: { questions, answers } },
  }));
  tab.pendingAskRequestId = null;
  tab.pendingAskToolUseId = null;
  tab.pendingAskBufferedAnswer = null;
  showThinking(tab);
  setRunning(tab, true);
}

function buildTool(block) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.toolId = block.id || '';
  const hdr = document.createElement('div');
  hdr.className = 'tool-hdr';
  const icon = document.createElement('span'); icon.className = 'tool-icon';
  const iconMap = { Read:'F', Edit:'E', Write:'W', Bash:'$', Glob:'*', Grep:'?', Agent:'A', WebSearch:'S', WebFetch:'U' };
  icon.textContent = iconMap[block.name] || '#';
  const name = document.createElement('span'); name.className = 'tool-name'; name.textContent = block.name;
  const detail = document.createElement('span'); detail.className = 'tool-detail';
  const i = block.input || {};
  if (['Read','Edit','Write'].includes(block.name)) detail.textContent = (i.file_path || '').split(/[/\\]/).pop() || '';
  else if (block.name === 'Bash') detail.textContent = (i.command || '').slice(0, 40);
  else if (block.name === 'Glob' || block.name === 'Grep') detail.textContent = i.pattern || '';
  const chevron = document.createElement('span'); chevron.className = 'tool-chevron'; chevron.innerHTML = '&#x203A;';
  hdr.append(icon, name, detail, chevron);
  hdr.addEventListener('click', () => card.classList.toggle('open'));

  const body = document.createElement('div'); body.className = 'tool-body';
  if (block.input && Object.keys(block.input).length) {
    const lbl = document.createElement('div'); lbl.className = 'tool-section-label'; lbl.textContent = 'INPUT';
    const sec = document.createElement('pre'); sec.className = 'tool-section'; sec.textContent = JSON.stringify(block.input, null, 2);
    body.append(lbl, sec);
  }
  const rLbl = document.createElement('div'); rLbl.className = 'tool-section-label tool-result-label'; rLbl.textContent = 'RESULT'; rLbl.hidden = true;
  const rSec = document.createElement('div'); rSec.className = 'tool-section tool-result-content'; rSec.hidden = true;
  body.append(rLbl, rSec);
  card.append(hdr, body);
  return card;
}

function updateToolResult(tab, ev) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  const card = $msgs.querySelector(`.tool-card[data-tool-id="${CSS.escape(ev.tool_use_id)}"]`);
  if (!card) return;
  const rLbl = card.querySelector('.tool-result-label');
  const rSec = card.querySelector('.tool-result-content');
  if (!rSec) return;
  rSec.innerHTML = '';
  if (Array.isArray(ev.content)) {
    for (const b of ev.content) {
      if (b.type === 'image') {
        // Image content block — render as <img>
        const data = b.source?.data || b.data || '';
        const mime = b.source?.media_type || b.media_type || 'image/png';
        if (data) {
          const img = document.createElement('img');
          img.src = `data:${mime};base64,${data}`;
          rSec.appendChild(img);
        }
      } else {
        // Text content block
        const text = b.text || b.data || '';
        if (text) {
          const pre = document.createElement('pre');
          pre.style.cssText = 'margin:0;background:none;border:none;white-space:pre-wrap;word-break:break-all;';
          pre.textContent = text.slice(0, 2000) + (text.length > 2000 ? '\n...' : '');
          rSec.appendChild(pre);
        }
      }
    }
  } else if (typeof ev.content === 'string') {
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;background:none;border:none;white-space:pre-wrap;word-break:break-all;';
    pre.textContent = ev.content.slice(0, 2000) + (ev.content.length > 2000 ? '\n...' : '');
    rSec.appendChild(pre);
  }
  rLbl.hidden = false; rSec.hidden = false;
  card.classList.add(ev.is_error ? 'tool-error' : 'tool-ok');
}

// ── Control requests (AskUserQuestion, permission prompts) ──
const _autoAllowTools = new Set(); // per-session "always allow" set

function handleControlRequest(tab, msg) {
  // Normalize: request may be nested or flat depending on CLI version
  const req = msg.request || msg;
  const requestId = msg.request_id || req.request_id;
  const toolName = req.tool_name;
  const subtype = req.subtype || (toolName ? 'can_use_tool' : undefined);
  console.log('[claude-panel] handleControlRequest:', subtype, toolName, 'request_id:', requestId, 'raw:', JSON.stringify(msg).slice(0, 300));
  if (!requestId) { console.warn('[claude-panel] control_request missing request_id, ignoring'); return; }

  if (toolName === 'AskUserQuestion') {
    // AskUserQuestion: save the request_id — answer is sent via control_response when user picks an option
    tab.pendingAskRequestId = requestId;
    // If tool_use block hasn't rendered the ask card yet, render from control_request input
    if (!tab.pendingAskToolUseId) {
      renderAskUserQuestion(tab, requestId, req.input);
    }
    // Flush buffered answer if user already clicked before control_request arrived
    if (tab.pendingAskBufferedAnswer) {
      const buffered = tab.pendingAskBufferedAnswer;
      tab.pendingAskBufferedAnswer = null;
      console.log('[claude-panel] Flushing buffered ask answer');
      sendAskAnswer(tab, buffered.questions, buffered.answers);
    }
    return;
  }

  if (toolName) {
    // Permission prompt — auto-allow if previously approved, otherwise show UI
    if (_autoAllowTools.has(toolName)) {
      sendPermissionResponse(tab, requestId, 'allow');
      return;
    }
    renderPermissionPrompt(tab, requestId, req);
    return;
  }

  console.warn('[claude-panel] Unhandled control_request:', JSON.stringify(msg).slice(0, 500));
}

function renderAskUserQuestion(tab, requestId, input) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  hideThinking(tab);

  // Normalize: accept questions array, single question object, or flat input
  const questions = Array.isArray(input?.questions) ? input.questions
    : (input?.question || input?.text || input?.options) ? [input]
    : input ? [input] : [];
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = CLAUDE_ICON;
  el.appendChild(avatar);

  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  for (const q of questions) {
    const questionText = q.question || q.text || q.header || '';
    const card = document.createElement('div');
    card.className = 'ask-card';

    if (q.header) {
      const hdr = document.createElement('div');
      hdr.className = 'ask-header';
      hdr.textContent = q.header;
      card.appendChild(hdr);
    }
    if (questionText && questionText !== q.header) {
      const qEl = document.createElement('div');
      qEl.className = 'ask-question';
      qEl.textContent = questionText;
      card.appendChild(qEl);
    }

    if (q.options?.length) {
      const opts = document.createElement('div');
      opts.className = 'ask-options';
      for (const opt of q.options) {
        const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || String(opt));
        const optDesc = typeof opt === 'string' ? '' : (opt.description || '');
        const btn = document.createElement('button');
        btn.className = 'ask-option';
        const lbl = document.createElement('span');
        lbl.className = 'ask-option-label';
        lbl.textContent = optLabel;
        btn.appendChild(lbl);
        if (optDesc) {
          const desc = document.createElement('span');
          desc.className = 'ask-option-desc';
          desc.textContent = optDesc;
          btn.appendChild(desc);
        }
        btn.addEventListener('click', () => {
          opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = true; });
          btn.classList.add('selected');
          const answers = {};
          answers[questionText] = optLabel;
          sendAskAnswer(tab, input.questions || [q], answers);
        });
        opts.appendChild(btn);
      }
      card.appendChild(opts);
    } else {
      const hint = document.createElement('div');
      hint.className = 'ask-hint';
      hint.textContent = 'Type your answer below and press Enter';
      card.appendChild(hint);
      tab.pendingAsk = { requestId: null, toolUseId: tab.pendingAskToolUseId, questions: input.questions || [q], questionText };
      setRunning(tab, false);
    }
    wrap.appendChild(card);
  }
  el.appendChild(wrap);
  $msgs.appendChild(el);
  setRunning(tab, false);
  if (tab === activeTab()) scrollEnd();
}

function renderPermissionPrompt(tab, requestId, req) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  hideThinking(tab);
  setRunning(tab, false);

  const toolName = req.tool_name || 'Unknown';
  const input = req.input || {};
  const iconMap = { Read:'F', Edit:'E', Write:'W', Bash:'$', Glob:'*', Grep:'?', Agent:'A', WebSearch:'S', WebFetch:'U' };

  // Detail line
  let detail = '';
  if (['Read','Edit','Write'].includes(toolName)) detail = input.file_path || '';
  else if (toolName === 'Bash') detail = input.command || '';
  else if (toolName === 'Glob' || toolName === 'Grep') detail = input.pattern || '';
  else if (toolName === 'Agent') detail = input.description || input.prompt?.slice(0, 80) || '';
  else detail = Object.keys(input).length ? JSON.stringify(input).slice(0, 120) : '';

  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = CLAUDE_ICON;
  el.appendChild(avatar);

  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  const card = document.createElement('div');
  card.className = 'perm-card';

  // Tool line
  const toolLine = document.createElement('div');
  toolLine.className = 'perm-tool-line';
  const icon = document.createElement('span');
  icon.className = 'perm-tool-icon';
  icon.textContent = iconMap[toolName] || '#';
  const name = document.createElement('span');
  name.className = 'perm-tool-name';
  name.textContent = toolName;
  toolLine.append(icon, name);
  card.appendChild(toolLine);

  // Detail
  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.className = 'perm-detail';
    detailEl.textContent = detail;
    card.appendChild(detailEl);
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'perm-actions';

  const allowBtn = document.createElement('button');
  allowBtn.className = 'perm-btn perm-btn-allow';
  allowBtn.textContent = 'Allow';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'perm-btn perm-btn-deny';
  denyBtn.textContent = 'Deny';

  const alwaysLbl = document.createElement('label');
  alwaysLbl.className = 'perm-always';
  const alwaysCb = document.createElement('input');
  alwaysCb.type = 'checkbox';
  alwaysLbl.append(alwaysCb, document.createTextNode('Always'));

  const resolve = (behavior) => {
    if (alwaysCb.checked && behavior === 'allow') _autoAllowTools.add(toolName);
    card.classList.add('resolved');
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    sendPermissionResponse(tab, requestId, behavior);
  };

  allowBtn.addEventListener('click', () => resolve('allow'));
  denyBtn.addEventListener('click', () => resolve('deny'));

  actions.append(allowBtn, denyBtn, alwaysLbl);
  card.appendChild(actions);
  wrap.appendChild(card);
  el.appendChild(wrap);
  $msgs.appendChild(el);
  if (tab === activeTab()) scrollEnd();
}

function sendPermissionResponse(tab, requestId, behavior) {
  if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
  console.log('[claude-panel] sendPermissionResponse:', behavior, 'request_id:', requestId);
  tab.ws.send(JSON.stringify({
    type: 'control_response',
    request_id: requestId,
    response: { behavior },
  }));
  showThinking(tab);
  setRunning(tab, true);
}

// ── UI helpers (per-tab) ──
function appendUser(tab, text, images) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  const el = document.createElement('div'); el.className = 'msg msg-user';
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble';
  if (images?.length) {
    for (const img of images) {
      const imgEl = document.createElement('img');
      imgEl.src = `data:${img.mediaType};base64,${img.base64}`;
      imgEl.style.cssText = 'max-width:200px;max-height:150px;border-radius:6px;margin-bottom:4px;display:block;';
      bubble.appendChild(imgEl);
    }
  }
  if (text) { const txt = document.createTextNode(text); bubble.appendChild(txt); }
  el.appendChild(bubble); $msgs.appendChild(el);
  if (tab === activeTab()) scrollEnd();
}

function showThinking(tab) {
  hideThinking(tab);
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  // Use sendStartedAt for total elapsed since user pressed send (persists across repositions)
  if (!tab.sendStartedAt) tab.sendStartedAt = Date.now();
  tab.thinkStartedAt = tab.sendStartedAt;
  const el = document.createElement('div'); el.className = 'thinking';
  el.innerHTML = '<div class="think-avatar">' + CLAUDE_ICON + '</div><div class="think-dots"><span></span><span></span><span></span></div><span class="think-timer"></span>';
  $msgs.appendChild(el); tab.thinkingEl = el;
  tab.thinkTimerInterval = setInterval(() => {
    const sec = Math.round((Date.now() - tab.sendStartedAt) / 1000);
    const timer = el.querySelector('.think-timer');
    if (timer) timer.textContent = sec > 0 ? `${sec}s` : '';
  }, 1000);
  if (tab === activeTab()) scrollEnd();
}
function hideThinking(tab) {
  if (tab.thinkTimerInterval) { clearInterval(tab.thinkTimerInterval); tab.thinkTimerInterval = null; }
  tab.thinkStartedAt = null;
  if (tab.thinkingEl) { tab.thinkingEl.remove(); tab.thinkingEl = null; }
}

function appendStatus(tab, text) {
  const $msgs = tab.messagesEl; if (!$msgs) return;
  const el = document.createElement('div'); el.className = 'msg-status'; el.textContent = text;
  $msgs.appendChild(el); if (tab === activeTab()) scrollEnd();
}
function appendError(tab, text) {
  const $msgs = tab.messagesEl; if (!$msgs) return;
  const el = document.createElement('div'); el.className = 'msg-error'; el.textContent = text;
  $msgs.appendChild(el); if (tab === activeTab()) scrollEnd();
}

function scrollEnd() {
  const tab = activeTab();
  const $msgs = tab?.messagesEl;
  if ($msgs) requestAnimationFrame(() => requestAnimationFrame(() => { $msgs.scrollTop = $msgs.scrollHeight; }));
}

function setRunning(tab, r) {
  tab.running = r;
  updatePillRunning(tab);
  if (tab !== activeTab()) return;
  const $send = _panel?.querySelector('#cp-send');
  const $input = _panel?.querySelector('#cp-input');
  if (!$send || !$input) return;
  $send.disabled = false;
  if (r) {
    $send.classList.add('abort'); $send.innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'; $input.disabled = true;
  } else {
    $send.classList.remove('abort'); $send.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'; $input.disabled = false; $input.focus();
  }
}
function finishTab(tab) { hideThinking(tab); setRunning(tab, false); tab.currentMsgEl = null; tab.currentMsgId = null; tab.pendingAskToolUseId = null; tab.pendingAskRequestId = null; tab.pendingAskBufferedAnswer = null; tab.sendStartedAt = null; }

function send() {
  const tab = activeTab();
  if (!tab) return;
  const $input = _panel?.querySelector('#cp-input');
  const $project = _panel?.querySelector('#cp-project');
  const $model = _panel?.querySelector('#cp-model');
  if (!$input) return;
  const text = $input.value.trim();
  if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
  if (tab.running) { tab.ws.send(JSON.stringify({ type: 'abort' })); return; }
  if (!text && !tab.attachedImages.length) return;

  if (text === '/clear') { $input.value = ''; tab.messagesEl.innerHTML = ''; hideSlashHints(); return; }
  if (text === '/compact') {
    $input.value = ''; hideSlashHints();
    if (tab.running) { appendStatus(tab, 'Cannot compact while Claude is processing.'); return; }
    if (tab.ws?.readyState === WebSocket.OPEN) {
      tab.ws.send(JSON.stringify({ type: 'compact' }));
      appendStatus(tab, 'Compacting context...');
    }
    return;
  }
  if (text === '/plan') {
    $input.value = ''; hideSlashHints();
    tab.planMode = !tab.planMode;
    const $plan = _panel?.querySelector('#cp-plan-toggle');
    if ($plan) $plan.classList.toggle('active', tab.planMode);
    appendStatus(tab, tab.planMode ? 'Plan mode ON — Claude will plan without making changes' : 'Plan mode OFF');
    return;
  }

  if (tab.pendingAsk && text) {
    $input.value = ''; autoResize();
    appendUser(tab, text); tab.sendStartedAt = Date.now(); showThinking(tab); setRunning(tab, true);
    const answers = {};
    answers[tab.pendingAsk.questionText] = text;
    sendAskAnswer(tab, tab.pendingAsk.questions, answers);
    tab.pendingAsk = null;
    return;
  }

  $input.value = ''; autoResize();
  const pendingImages = tab.attachedImages.length ? [...tab.attachedImages] : null;
  appendUser(tab, text, pendingImages); tab.sendStartedAt = Date.now(); showThinking(tab); setRunning(tab, true);
  let prompt = buildPromptWithAttachments(tab, text);
  if (tab.planMode && prompt) {
    prompt = `[PLAN MODE — think step by step, create a detailed plan, do NOT make code changes]\n\n${prompt}`;
  }

  // Update pill label on first message
  if (tab.label === 'New chat' && text) {
    tab.label = trunc(text, 20);
    updatePillLabel(tab);
    const headerLabel = _panel?.querySelector('.cp-session-label');
    if (headerLabel) headerLabel.textContent = tab.label;
    saveTabs();
  }

  const msg = {
    type: 'query', prompt,
    cwd: ddGetValue($project) || undefined,
    sessionId: tab.sessionId || undefined,
    model: ddGetValue($model) || undefined,
    effort: _getEffort() || undefined,
  };
  if (pendingImages) {
    msg.images = pendingImages.map(i => ({ base64: i.base64, mediaType: i.mediaType }));
    tab.attachedImages = [];
    updateAttachBadge();
    const preview = _panel?.querySelector('#cp-image-preview');
    if (preview) preview.innerHTML = '';
  }
  hideSlashHints();
  tab.ws.send(JSON.stringify(msg));
}

function autoResize() {
  const $input = _panel?.querySelector('#cp-input');
  if (!$input) return;
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
}

// ── Config loading ──
async function loadConfig() {
  try {
    const res = await fetch('/api/claude/config').then(r => r.json());
    if (!res.ok) return;
    _projects = res.projects || [];
    _models = res.models || [];

    const $project = _panel?.querySelector('#cp-project');
    const $model = _panel?.querySelector('#cp-model');

    if ($project) {
      const items = _projects.map(p => ({ value: p.path, label: p.label || p.path.split(/[/\\]/).pop() }));
      const saved = storage.getItem(STOR.project);
      ddPopulate($project, items, saved || '');
      if (saved) loadBranches(saved);
    }

    if ($model) {
      const items = _models.map(m => ({ value: m.id, label: m.label }));
      const saved = storage.getItem(STOR.model);
      ddPopulate($model, items, saved || '');
    }
  } catch {}
}

async function loadBranches(path) {
  const $branch = _panel?.querySelector('#cp-branch');
  if (!$branch) return;
  if (!path) { ddPopulate($branch, [], ''); return; }
  try {
    const res = await fetch(`/api/terminal/branches?path=${encodeURIComponent(path)}`).then(r => r.json());
    if (res.branches?.length) {
      const items = res.branches.map(b => ({ value: b, label: b }));
      ddPopulate($branch, items, res.current || '');
    }
  } catch {}
}

// ── Public API ──
export function toggleClaudePanel() {
  if (!_panel) {
    injectStyles();
    _panel = buildPanel();
    document.body.appendChild(_panel);
    wireEvents();
    loadConfig();
    loadSkills();
    restoreTabs();
    loadMonthlyCost();
  }
  _visible = !_visible;
  if (_visible) {
    _panel.classList.add('open');
    document.documentElement.style.setProperty('--claude-panel-width', _panel.style.width || '22%');
    _panel.querySelector('#cp-input')?.focus();
  } else {
    _panel.classList.remove('open');
    document.documentElement.style.setProperty('--claude-panel-width', '0px');
  }
  renderPills(); // Sync pill visibility with panel open/close state
  window.dispatchEvent(new Event('resize'));
}

export function isClaudePanelOpen() { return _visible; }

/** Open the panel (if closed) and pre-fill the input with text, placing cursor at the end.
 *  If opts.asFile is true or text looks like a file path, attach as a file chip instead. */
export function sendToPanel(text, opts = {}) {
  if (!_visible) toggleClaudePanel();
  const tab = activeTab();
  if (!tab) return;

  // Detect file paths — attach as file chip instead of text
  const looksLikePath = opts.asFile || /^[A-Za-z]:[/\\]/.test(text) || (text.startsWith('/') && text.includes('/') && !text.includes(' '));
  if (looksLikePath) {
    _attachPathToTab(tab, text);
    _panel?.querySelector('#cp-input')?.focus();
    return;
  }

  const $input = _panel?.querySelector('#cp-input');
  if (!$input) return;
  const existing = $input.value;
  if (existing && !existing.endsWith('\n') && !existing.endsWith(' ')) {
    $input.value = existing + ' ' + text;
  } else {
    $input.value = (existing || '') + text;
  }
  autoResize();
  $input.focus();
  $input.setSelectionRange($input.value.length, $input.value.length);
}

/** Attach a file path to the active tab — fetches content and shows chip */
async function _attachPathToTab(tab, fullPath) {
  const fileName = fullPath.split(/[/\\]/).pop() || fullPath;
  try {
    const res = await fetch(`/api/file-content?path=${encodeURIComponent(fullPath)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.content != null) {
        tab.attachedFiles.push({ name: fileName, path: fullPath, content: String(data.content).slice(0, 50000) });
      } else {
        // Binary or unreadable — still attach as path reference
        tab.attachedFiles.push({ name: fileName, path: fullPath, content: `[File: ${fullPath}]` });
      }
    } else {
      tab.attachedFiles.push({ name: fileName, path: fullPath, content: `[File: ${fullPath}]` });
    }
  } catch {
    tab.attachedFiles.push({ name: fileName, path: fullPath, content: `[File: ${fullPath}]` });
  }
  _addPathChip(tab, fileName, fullPath, tab.attachedFiles.length - 1);
  updateAttachBadge();
  const $send = _panel?.querySelector('#cp-send');
  if ($send) $send.disabled = false;
}

/** Add a path chip to the preview area */
function _addPathChip(tab, fileName, fullPath, idx) {
  const preview = _panel?.querySelector('#cp-image-preview');
  if (!preview) return;
  const chip = document.createElement('div');
  chip.className = 'cp-path-chip';
  chip.dataset.fileIdx = idx;
  chip.title = fullPath;
  chip.innerHTML = `
    <span class="cp-path-chip-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
    <span class="cp-path-chip-name">${escH(fileName)}</span>
  `;
  const x = document.createElement('button');
  x.className = 'cp-path-chip-x';
  x.textContent = '\u00d7';
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = parseInt(chip.dataset.fileIdx, 10);
    tab.attachedFiles.splice(i, 1);
    chip.remove();
    preview.querySelectorAll('.cp-path-chip, .cp-file-chip').forEach((c, j) => { c.dataset.fileIdx = j; });
    updateAttachBadge();
    const $send = _panel?.querySelector('#cp-send');
    if ($send && !tab.attachedFiles.length && !tab.attachedImages.length && !_panel?.querySelector('#cp-input')?.value.trim()) $send.disabled = true;
  });
  chip.appendChild(x);
  preview.appendChild(chip);
}

// ── Slash command hints ──
let _slashHintIdx = -1;
async function loadSkills() {
  if (_skillsCache) return _skillsCache;
  try {
    const res = await fetch('/api/claude-code/skills').then(r => r.json());
    _skillsCache = (res.skills || []).map(s => ({ name: s.name || s.dirName, description: s.description || '' }));
    // Dedup by name (server may return both bundled + global)
    const seen = new Set(_skillsCache.map(s => s.name));
    // Add built-in client/Claude Code commands
    const builtins = [
      { name: 'clear', description: 'Clear all messages' },
      { name: 'compact', description: 'Compact context — reload session' },
      { name: 'commit', description: 'Stage and commit changes' },
      { name: 'plan', description: 'Toggle plan mode' },
      { name: 'review-pr', description: 'Review a pull request' },
      { name: 'simplify', description: 'Review changed code for quality and efficiency' },
      { name: 'loop', description: 'Run a command on a recurring interval' },
    ];
    for (const b of builtins) { if (!seen.has(b.name)) { _skillsCache.push(b); seen.add(b.name); } }
    _skillsCache.sort((a, b) => a.name.localeCompare(b.name));
  } catch { _skillsCache = [{ name: 'clear', description: 'Clear all messages' }]; }
  return _skillsCache;
}
function showSlashHints(filter) {
  const $hints = _panel?.querySelector('#cp-slash-hints');
  if (!$hints || !_skillsCache) return;
  const q = filter.toLowerCase();
  const matches = _skillsCache.filter(s => s.name.toLowerCase().startsWith(q));
  if (!matches.length || !filter) { hideSlashHints(); return; }
  $hints.innerHTML = '';
  matches.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'cp-slash-item' + (i === 0 ? ' active' : '');
    el.innerHTML = `<div class="cp-slash-name">/${esc(s.name)}</div><div class="cp-slash-desc">${esc(s.description)}</div>`;
    el.addEventListener('click', () => {
      const $input = _panel?.querySelector('#cp-input');
      if ($input) { $input.value = '/' + s.name + ' '; $input.focus(); }
      hideSlashHints();
    });
    $hints.appendChild(el);
  });
  _slashHintIdx = 0;
  $hints.classList.add('open');
}
function hideSlashHints() {
  const $hints = _panel?.querySelector('#cp-slash-hints');
  if ($hints) { $hints.classList.remove('open'); $hints.innerHTML = ''; }
  _slashHintIdx = -1;
}
function navigateSlashHints(dir) {
  const $hints = _panel?.querySelector('#cp-slash-hints');
  if (!$hints) return;
  const items = $hints.querySelectorAll('.cp-slash-item');
  if (!items.length) return;
  items[_slashHintIdx]?.classList.remove('active');
  _slashHintIdx = Math.max(0, Math.min(items.length - 1, _slashHintIdx + dir));
  items[_slashHintIdx]?.classList.add('active');
}
function acceptSlashHint() {
  const $hints = _panel?.querySelector('#cp-slash-hints');
  if (!$hints) return false;
  const active = $hints.querySelector('.cp-slash-item.active');
  if (!active) return false;
  active.click();
  return true;
}

// ── Image preview helpers ──
function addImagePreview(dataUrl, idx) {
  const preview = _panel?.querySelector('#cp-image-preview');
  if (!preview) return;
  const thumb = document.createElement('div');
  thumb.className = 'cp-thumb';
  thumb.dataset.idx = idx;
  const img = document.createElement('img');
  img.src = dataUrl;
  const x = document.createElement('button');
  x.className = 'cp-thumb-x';
  x.textContent = '\u00d7';
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    const tab = activeTab();
    if (!tab) return;
    const i = parseInt(thumb.dataset.idx, 10);
    tab.attachedImages.splice(i, 1);
    thumb.remove();
    preview.querySelectorAll('.cp-thumb').forEach((t, j) => { t.dataset.idx = j; });
    updateAttachBadge();
    const $send = _panel?.querySelector('#cp-send');
    if ($send && !tab.attachedImages.length && !_panel?.querySelector('#cp-input')?.value.trim()) $send.disabled = true;
  });
  thumb.append(img, x);
  preview.appendChild(thumb);
}

function addFilePreview(name, idx) {
  const preview = _panel?.querySelector('#cp-image-preview');
  if (!preview) return;
  const chip = document.createElement('div');
  chip.className = 'cp-file-chip';
  chip.dataset.fileIdx = idx;
  const label = document.createElement('span');
  label.className = 'cp-file-chip-name';
  label.textContent = name.length > 18 ? name.slice(0, 15) + '...' : name;
  label.title = name;
  const x = document.createElement('button');
  x.className = 'cp-file-chip-x';
  x.textContent = '\u00d7';
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    const tab = activeTab();
    if (!tab) return;
    const i = parseInt(chip.dataset.fileIdx, 10);
    tab.attachedFiles.splice(i, 1);
    chip.remove();
    preview.querySelectorAll('.cp-file-chip').forEach((c, j) => { c.dataset.fileIdx = j; });
    updateAttachBadge();
    const $send = _panel?.querySelector('#cp-send');
    if ($send && !tab.attachedFiles.length && !tab.attachedImages.length && !_panel?.querySelector('#cp-input')?.value.trim()) $send.disabled = true;
  });
  chip.append(label, x);
  preview.appendChild(chip);
}

function handleImageDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  _panel?.querySelector('.cp-drop-overlay')?.remove();
  const files = e.dataTransfer?.files;
  if (!files) return;
  const tab = activeTab();
  if (!tab) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      const mediaType = file.type;
      tab.attachedImages.push({ base64, mediaType });
      updateAttachBadge();
      addImagePreview(dataUrl, tab.attachedImages.length - 1);
      const $send = _panel?.querySelector('#cp-send');
      if ($send) $send.disabled = false;
    };
    reader.readAsDataURL(file);
  }
}

function wireEvents() {
  const $input = _panel.querySelector('#cp-input');
  const $send = _panel.querySelector('#cp-send');
  const $project = _panel.querySelector('#cp-project');
  const $model = _panel.querySelector('#cp-model');
  const $branch = _panel.querySelector('#cp-branch');
  const $close = _panel.querySelector('.cp-close-btn');
  const $minimize = _panel.querySelector('.cp-minimize-btn');
  const $new = _panel.querySelector('.cp-new-btn');

  $input.addEventListener('input', () => {
    autoResize();
    const tab = activeTab();
    $send.disabled = !$input.value.trim() && !tab?.attachedImages.length && !tab?.running;
    // Slash command hints
    const text = $input.value;
    if (text.startsWith('/') && !text.includes('\n')) {
      const cmd = text.slice(1).split(/\s/)[0];
      if (!text.includes(' ')) { showSlashHints(cmd); } else { hideSlashHints(); }
    } else { hideSlashHints(); }
  });
  $input.addEventListener('keydown', (e) => {
    // Slash hint navigation
    const $hints = _panel?.querySelector('#cp-slash-hints');
    if ($hints?.classList.contains('open')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateSlashHints(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateSlashHints(-1); return; }
      if (e.key === 'Tab') { e.preventDefault(); acceptSlashHint(); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashHints(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); hideSlashHints(); if (!$send.disabled) send(); }
    // Ctrl+L to clear
    if (e.key === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const tab = activeTab(); if (tab?.messagesEl) tab.messagesEl.innerHTML = ''; }
    // Escape to abort
    if (e.key === 'Escape' && activeTab()?.running) { activeTab()?.ws?.send(JSON.stringify({ type: 'abort' })); }
  });
  $send.addEventListener('click', send);
  $close.addEventListener('click', () => toggleClaudePanel());
  $minimize.addEventListener('click', () => {
    // Always minimize to a fresh blank panel — never swap in an existing session
    if (_tabs.length >= MAX_TABS) return;
    createTab(null, 'New chat');
  });

  // Image paste — capture images from clipboard with thumbnail preview
  $input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const tab = activeTab();
        if (!tab) return;
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        const mediaType = item.type;
        tab.attachedImages.push({ base64, mediaType });
        updateAttachBadge();
        addImagePreview(dataUrl, tab.attachedImages.length - 1);
        $send.disabled = false;
      };
      reader.readAsDataURL(blob);
    }
  });

  // Image drag-and-drop
  const $bottom = _panel.querySelector('.cp-bottom');
  let dragCounter = 0;
  $bottom.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
      const overlay = document.createElement('div');
      overlay.className = 'cp-drop-overlay';
      overlay.textContent = 'Drop images here';
      $bottom.style.position = 'relative';
      $bottom.appendChild(overlay);
    }
  });
  $bottom.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; $bottom.querySelector('.cp-drop-overlay')?.remove(); }
  });
  $bottom.addEventListener('dragover', (e) => e.preventDefault());
  $bottom.addEventListener('drop', (e) => { dragCounter = 0; handleImageDrop(e); });

  // File attachment
  const $attach = _panel.querySelector('#cp-attach');
  if ($attach) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    $attach.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const tab = activeTab();
      if (!tab) return;
      for (const file of fileInput.files) {
        if (!_isTextFile(file.name)) {
          appendStatus(tab, `Skipped "${file.name}" — only text/code files supported`);
          continue;
        }
        if (file.size > 100000) {
          appendStatus(tab, `Skipped "${file.name}" — file too large (${Math.round(file.size/1024)}KB, max 100KB)`);
          continue;
        }
        const text = await file.text();
        tab.attachedFiles.push({ name: file.name, content: text.slice(0, 50000) });
        addFilePreview(file.name, tab.attachedFiles.length - 1);
      }
      updateAttachBadge();
      $send.disabled = false;
      fileInput.value = '';
    });
  }
  $new.addEventListener('click', () => {
    if (_tabs.length >= MAX_TABS) return;
    createTab(null, 'New chat');
  });

  // Think intensity toggle
  const $think = _panel.querySelector('#cp-think-toggle');
  if ($think) {
    // Build dot elements (4 dots for 4 levels)
    const dotsWrap = $think.querySelector('.cp-think-dots');
    dotsWrap.innerHTML = '<i></i><i></i><i></i><i></i>';
    // Restore from storage
    const savedEffort = storage.getItem(STOR.effort) || 'off';
    _setEffort($think, savedEffort);
    $think.addEventListener('click', () => {
      const cur = $think.dataset.effort || 'off';
      const idx = EFFORT_LEVELS.indexOf(cur);
      const next = EFFORT_LEVELS[(idx + 1) % EFFORT_LEVELS.length];
      _setEffort($think, next);
      storage.setItem(STOR.effort, next);
    });
  }

  // Plan mode toggle
  const $plan = _panel.querySelector('#cp-plan-toggle');
  if ($plan) {
    $plan.addEventListener('click', () => {
      const tab = activeTab();
      if (!tab) return;
      tab.planMode = !tab.planMode;
      $plan.classList.toggle('active', tab.planMode);
    });
  }

  // Compact button
  const $compact = _panel.querySelector('#cp-compact-btn');
  if ($compact) {
    $compact.addEventListener('click', () => {
      const tab = activeTab();
      if (!tab || !tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
      if (tab.running) { appendStatus(tab, 'Cannot compact while Claude is processing.'); return; }
      tab.ws.send(JSON.stringify({ type: 'compact' }));
      appendStatus(tab, 'Compacting context...');
    });
  }

  // Session selector
  const $sessBtn = _panel.querySelector('#cp-session-btn');
  const $sessMenu = _panel.querySelector('#cp-session-menu');
  $sessBtn.addEventListener('click', () => {
    const isOpen = $sessMenu.classList.toggle('open');
    if (isOpen) renderSessionMenu();
  });
  // Double-click session label to rename
  const $sessLabel = _panel.querySelector('.cp-session-label');
  $sessLabel?.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    $sessMenu.classList.remove('open');
    const tab = activeTab();
    if (tab?.sessionId) renameSession(tab.sessionId, $sessLabel.textContent);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cp-header')) $sessMenu?.classList.remove('open');
  });

  // Cost widget toggle
  const $cost = _panel.querySelector('#cp-cost');
  if ($cost) {
    $cost.style.cursor = 'pointer';
    $cost.addEventListener('click', () => emit('cost:toggle'));
  }

  ddSetup($project); ddSetup($model); ddSetup($branch);
  $project.addEventListener('change', () => {
    storage.setItem(STOR.project, ddGetValue($project));
    loadBranches(ddGetValue($project));
    // Reset session when switching projects
    selectSession(null, 'New chat');
  });
  $model.addEventListener('change', () => storage.setItem(STOR.model, ddGetValue($model)));
  $branch.addEventListener('change', async () => {
    if (!ddGetValue($branch) || !ddGetValue($project)) return;
    try {
      await fetch('/api/terminal/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: ddGetValue($project), branch: ddGetValue($branch) }),
      });
    } catch {}
  });

  // ── Resize handle drag ──
  const $handle = _panel.querySelector('.cp-resize-handle');
  if ($handle) {
    let dragging = false;
    $handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      _panel.style.transition = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.min(700, Math.max(320, window.innerWidth - e.clientX));
      _panel.style.width = w + 'px';
      document.documentElement.style.setProperty('--claude-panel-width', w + 'px');
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      _panel.style.transition = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.dispatchEvent(new Event('resize'));
    });
  }
}

export function initClaudePanel() {
  // Will be initialized on first toggle
}
