// ── Statusline: what is happening right now ──
// The activity verb with its elapsed time, the background work and a usage
// limit that is close: each shows only while it has something to say. It sits
// in the bottom toolbar, left of the toggles. What a tab is and has (context,
// MCP servers, session settings) is in the context settings popover
// (cp-context-menu.js), which is refreshed from here.

import { cpCtx } from './cp-ctx.js';
import { syncContextMenu } from './cp-context-menu.js';

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
    case 'TaskCreate': case 'TaskUpdate': case 'TaskList': case 'TaskGet': return 'Updating tasks';
    case 'TaskStop': return 'Stopping a background task';
    case 'Monitor': return `Monitoring ${(i.description || '').slice(0, 40)}`.trim();
    case 'ScheduleWakeup': return i.stop ? 'Stopping the loop' : 'Scheduling a wakeup';
    case 'CronCreate': case 'CronDelete': case 'CronList': return 'Managing scheduled jobs';
    case 'Workflow': return `Starting workflow ${(i.title || i.name || '').slice(0, 40)}`.trim();
    case 'EnterWorktree': return 'Entering a worktree';
    case 'ExitWorktree': return 'Leaving the worktree';
    case 'PushNotification': return 'Sending a notification';
    case 'Skill': return `Loading skill ${i.skill || ''}`.trim();
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
  const bar = $panel.querySelector('.cp-toolbar-left');
  if (!bar) return null;
  let sl = bar.querySelector('#cp-statusline');
  if (!sl) {
    sl = document.createElement('div');
    sl.id = 'cp-statusline';
    sl.className = 'cp-statusline';
    sl.innerHTML = `
      <span class="cp-sl-activity" id="cp-sl-activity" hidden><span class="cp-sl-spinner"></span><span class="cp-sl-verb"></span><span class="cp-sl-elapsed"></span></span>
      <span class="cp-sl-bg" id="cp-sl-bg" hidden></span>
      <span class="cp-sl-limit" id="cp-sl-limit" hidden></span>`;
    bar.appendChild(sl);
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

  // Background work — agents and shells still running after their turn ended.
  // Shown whether or not a turn is running.
  const bg = sl.querySelector('#cp-sl-bg');
  const work = tab.backgroundWork || [];
  if (bg) {
    const crons = Array.isArray(tab.sessionCrons) ? tab.sessionCrons.length : 0;
    bg.hidden = work.length === 0 && crons === 0;
    bg.textContent = [
      work.length ? `⧗ ${work.length} background task${work.length === 1 ? '' : 's'}` : '',
      crons ? `${crons} scheduled` : '',
    ].filter(Boolean).join(' · ');
    bg.title = [...work.map(w => w.description || w.type), crons ? 'Click for details (/tasks)' : ''].filter(Boolean).join('\n');
    if (!bg._wired) {
      bg._wired = true;
      bg.addEventListener('click', () => { const t = cpCtx.activeTab(); if (t) { try { cpCtx.openTasks(t); } catch {} } });
    }
  }

  // Plan usage limit (rate_limit_event): shown while a limit is close or reached.
  const limit = sl.querySelector('#cp-sl-limit');
  if (limit) {
    const rl = tab.rateLimit;
    limit.hidden = !rl?.pill;
    limit.textContent = rl?.pill || '';
    limit.title = rl?.text || '';
    limit.className = `cp-sl-limit${rl ? ` cp-sl-limit-${rl.level}` : ''}`;
  }

  // The popover shows the running state, the servers and the session settings
  // that change with the calls that end up here.
  syncContextMenu(tab);
}

export function setActivity(tab, verb) {
  tab.currentActivity = verb ? { verb, at: Date.now() } : null;
  renderStatusline(tab);
}
