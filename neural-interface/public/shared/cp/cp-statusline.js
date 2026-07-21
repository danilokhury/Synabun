// ── Statusline: activity verb + elapsed, permission-mode chip, MCP dots ──
// Lives inside the existing #cp-context-bar next to the gauge; renderGauge()
// stays untouched.

import { cpCtx } from './cp-ctx.js';

const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽'];
let _spinnerIdx = 0;
let _spinnerTimer = null;

export function cpActivityVerb(toolName, input) {
  const i = input || {};
  const base = (p) => (p || '').split(/[/\\]/).pop() || '';
  switch (toolName) {
    case 'Read': return `Reading ${base(i.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${base(i.file_path)}`;
    case 'Write': return `Writing ${base(i.file_path)}`;
    case 'NotebookEdit': return `Editing ${base(i.notebook_path)}`;
    case 'Bash': return `Running ${(i.command || '').split('\n')[0].slice(0, 40)}`;
    case 'BashOutput': return 'Checking background task';
    case 'Glob': return `Globbing ${i.pattern || ''}`;
    case 'Grep': return `Searching ${i.pattern || ''}`;
    case 'Task': case 'Agent': return `Spawning ${i.subagent_type || 'agent'}`;
    case 'WebFetch': return `Fetching ${(i.url || '').replace(/^https?:\/\//, '').slice(0, 40)}`;
    case 'WebSearch': return `Searching web: ${(i.query || '').slice(0, 40)}`;
    case 'TodoWrite': return 'Updating todos';
    case 'ToolSearch': return 'Loading tools';
    case 'AskUserQuestion': return 'Asking you';
    case 'ExitPlanMode': return 'Plan ready';
    default:
      if (toolName?.startsWith('mcp__')) {
        const parts = toolName.split('__');
        return `${parts[2] || toolName} (${parts[1] || 'mcp'})`;
      }
      return toolName ? `Using ${toolName}` : '';
  }
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function ensureDom() {
  const { panel } = cpCtx;
  const $panel = panel();
  if (!$panel) return null;
  const bar = $panel.querySelector('#cp-context-bar');
  if (!bar) return null;
  let sl = bar.querySelector('#cp-statusline');
  if (!sl) {
    sl = document.createElement('div');
    sl.id = 'cp-statusline';
    sl.className = 'cp-statusline';
    sl.innerHTML = `
      <span class="cp-sl-activity" id="cp-sl-activity" hidden><span class="cp-sl-spinner"></span><span class="cp-sl-verb"></span><span class="cp-sl-elapsed"></span></span>
      <span class="cp-sl-spacer"></span>
      <span class="cp-sl-mcp" id="cp-sl-mcp"></span>`;
    bar.insertBefore(sl, bar.firstChild);
  }
  return sl;
}

export function renderStatusline(tab) {
  const { activeTab } = cpCtx;
  if (tab !== activeTab()) return;
  const sl = ensureDom();
  if (!sl) return;

  // Activity
  const act = sl.querySelector('#cp-sl-activity');
  const verb = sl.querySelector('.cp-sl-verb');
  const elapsedEl = sl.querySelector('.cp-sl-elapsed');
  const spinner = sl.querySelector('.cp-sl-spinner');
  const a = tab.currentActivity;
  if (a?.verb && tab.running) {
    act.hidden = false;
    verb.textContent = a.verb;
    elapsedEl.textContent = tab.sendStartedAt ? fmtElapsed(Date.now() - tab.sendStartedAt) : '';
    if (!_spinnerTimer) {
      _spinnerTimer = setInterval(() => {
        const { activeTab: at } = cpCtx;
        const t = at();
        if (!t?.running || !t.currentActivity) {
          clearInterval(_spinnerTimer); _spinnerTimer = null;
          const slNow = document.querySelector('#cp-statusline #cp-sl-activity');
          if (slNow) slNow.hidden = true;
          return;
        }
        _spinnerIdx = (_spinnerIdx + 1) % SPINNER_FRAMES.length;
        const sp = document.querySelector('#cp-statusline .cp-sl-spinner');
        const elp = document.querySelector('#cp-statusline .cp-sl-elapsed');
        if (sp) sp.textContent = SPINNER_FRAMES[_spinnerIdx];
        if (elp && t.sendStartedAt) elp.textContent = fmtElapsed(Date.now() - t.sendStartedAt);
      }, 300);
    }
    spinner.textContent = SPINNER_FRAMES[_spinnerIdx];
  } else {
    act.hidden = true;
  }

  // (Permission mode moved to the project-bar #cp-mode dropdown)

  // MCP dots
  const mcp = sl.querySelector('#cp-sl-mcp');
  mcp.innerHTML = '';
  const servers = tab.mcpServers || [];
  for (const s of servers.slice(0, 8)) {
    const dot = document.createElement('span');
    const status = (s.status || '').toLowerCase();
    const tone = /connect|ok|ready|running/.test(status) ? 'ok' : /pend|start/.test(status) ? 'warn' : 'err';
    dot.className = `cp-sl-mcp-dot cp-mcp-${tone}`;
    dot.title = `${s.name}: ${s.status}`;
    mcp.appendChild(dot);
  }
}

export function setActivity(tab, verb) {
  tab.currentActivity = verb ? { verb, at: Date.now() } : null;
  renderStatusline(tab);
}
