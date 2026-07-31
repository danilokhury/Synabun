// SynaBun Neural Interface - Dedicated Schedules Studio

import { emit, on } from './state.js';
import { storage } from './storage.js';
import { isGuest, hasPermission, showGuestToast } from './ui-sync.js';
import { sendToPanel } from './ui-claude-panel.js';
import { getProviderMeta } from './provider-icons.js';
import {
  getNativeLoopRouterClaimToken,
  getNativeLoopRouterWindowId,
} from './ui-native-loop-router.js';
import {
  CLI_PROFILES,
  ensureModelsForProfile,
  fetchMcpProfilePresets,
  fetchCodexAccounts,
  getCachedCodexAccounts,
  getCachedMcpProfilePresets,
  getEffortLevelsForProfile,
  getModelsForProfile,
  formatModelOptionLabel,
  isDynamicModelProfile,
  modelSelectorValue,
  modelMatchesSelector,
  normalizeEffortForProfile,
  profileSupportsEffort,
} from './agent-runtime-options.js';
import {
  fetchLoopTemplates,
  fetchSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  testSchedule,
  startScheduleTimer,
  cancelScheduleTimer,
  fetchScheduleTimers,
  fetchScheduleGroups,
  createScheduleGroup,
  updateScheduleGroup,
  deleteScheduleGroup,
  reorderScheduleGroups,
  createQuickTimer,
  fetchQuickTimers,
  cancelQuickTimer,
  triggerQuickTimerNow,
} from './api.js';

const $ = (id) => document.getElementById(id);
const PANEL_ID = 'schedules-studio-panel';
const POLL_INTERVAL = 1000;

let _panel = null;
let _backdrop = null;
let _docListeners = [];
let _templates = [];
let _schedules = [];
let _groups = [];
let _scheduleTimerData = {};
let _quickTimers = [];
let _tab = 'cron';
let _selectedGroup = 'all';
let _scheduleEditor = null;
let _groupEditorId = null;
let _groupEditorDraft = null;
let _draggingScheduleId = null;
let _pollTimer = null;
let _selectedQtMinutes = null;
let _qtUsesBrowser = null;
let _syncReady = false;
let _promptModal = null;
let _promptBackdrop = null;
let _promptKeyHandler = null;
const _modelLoadRequests = new Set();

let _launchProfile = storage.getItem('as-launch-profile') || 'claude-code';
let _launchModel = storage.getItem('as-launch-model') || null;
let _launchEffort = storage.getItem('as-launch-effort') || 'off';
let _launchMcpProfile = storage.getItem('as-launch-mcp-profile') || 'full';
let _launchAccount = storage.getItem('as-launch-account') || 'default'; // Codex ChatGPT account (CODEX_HOME)
let _codexAccountsRequested = false; // lazy-fetch guard for account selects

const _s = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  clock: _s('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 2.5"/>'),
  plus: _s('<path d="M8 3v10M3 8h10"/>'),
  bolt: _s('<path d="M9 2L4 9h4l-1 5 5-7H8l1-5z"/>'),
  edit: _s('<path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z"/>'),
  script: _s('<path d="M3.5 2h6.5l3 3v8.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z"/><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3"/>'),
  close: _s('<path d="M4 4l8 8M12 4l-8 8"/>'),
  pause: _s('<path d="M5 3v10M11 3v10"/>'),
  play: _s('<path d="M5 3l8 5-8 5V3z"/>'),
  back: _s('<path d="M10 3L5 8l5 5"/>'),
  down: _s('<path d="M3 6l5 5 5-5"/>'),
  folder: _s('<path d="M2.5 5h4l1 1.5h6v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>'),
  list: _s('<path d="M5 4h8M5 8h8M5 12h8"/><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>'),
  eye: _s('<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z"/><circle cx="8" cy="8" r="2"/>'),
  sparkle: _s('<path d="M8 2L9.2 6.8L14 8L9.2 9.2L8 14L6.8 9.2L2 8L6.8 6.8L8 2z"/>'),
  lock: _s('<rect x="4" y="7" width="8" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
};

const CRON_PRESET_GROUPS = [
  { group: 'Frequency', presets: [
    { label: 'Every 15 Min', cron: '*/15 * * * *', desc: 'Every 15 minutes' },
    { label: 'Every 30 Min', cron: '*/30 * * * *', desc: 'Every 30 minutes' },
    { label: 'Every Hour', cron: '0 * * * *', desc: 'Every hour at :00' },
    { label: 'Every 2 Hours', cron: '0 */2 * * *', desc: 'Every 2 hours at :00' },
    { label: 'Every 6 Hours', cron: '0 */6 * * *', desc: 'Every 6 hours at :00' },
  ] },
  { group: 'Daily', presets: [
    { label: 'Morning 9am', cron: '0 9 * * *', desc: 'Every day at 09:00' },
    { label: 'Midday 12pm', cron: '0 12 * * *', desc: 'Every day at 12:00' },
    { label: 'Evening 6pm', cron: '0 18 * * *', desc: 'Every day at 18:00' },
    { label: '2x Daily', cron: '0 10,18 * * *', desc: 'Every day at 10:00 and 18:00' },
    { label: '3x Daily', cron: '0 9,14,19 * * *', desc: 'Every day at 09:00, 14:00, 19:00' },
  ] },
  { group: 'Weekly', presets: [
    { label: 'Weekdays 9am', cron: '0 9 * * 1-5', desc: 'Mon-Fri at 09:00' },
    { label: 'Weekdays 2x', cron: '0 10,18 * * 1-5', desc: 'Mon-Fri at 10:00 and 18:00' },
    { label: 'Weekends 10am', cron: '0 10 * * 0,6', desc: 'Sat-Sun at 10:00' },
    { label: 'Mon/Wed/Fri', cron: '0 9 * * 1,3,5', desc: 'Mon, Wed, Fri at 09:00' },
    { label: 'Tue/Thu', cron: '0 9 * * 2,4', desc: 'Tue, Thu at 09:00' },
  ] },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function showToast(msg) {
  const existing = document.querySelector('.as-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'as-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 180);
  }, 2500);
}

function getTemplate(id) {
  return _templates.find(t => t.id === id) || null;
}

function getGroup(id) {
  return _groups.find(g => g.id === id) || null;
}

function describeCronClient(cronStr) {
  const fields = String(cronStr || '').trim().split(/\s+/);
  if (fields.length !== 5) return cronStr || '';
  const [minute, hour, , , dayOfWeek] = fields;
  const pad = (n) => String(n).padStart(2, '0');
  let dayPart = '';
  if (dayOfWeek === '*') dayPart = 'Every day';
  else if (dayOfWeek === '1-5') dayPart = 'Weekdays';
  else if (dayOfWeek === '0,6') dayPart = 'Weekends';
  else dayPart = dayOfWeek.split(',').map(d => DAY_NAMES[+d] || d).join(', ');

  const minStep = minute.match(/^\*\/(\d+)$/);
  if (minStep && hour === '*') return `${dayPart}, every ${minStep[1]} minutes`;
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep) return `${dayPart}, every ${hourStep[1]} hours at :${pad(+minute)}`;
  if (hour.includes(',')) return `${dayPart} at ${hour.split(',').map(h => `${pad(+h)}:${pad(+minute)}`).join(', ')}`;
  if (hour === '*') return `${dayPart}, every hour at :${pad(+minute)}`;
  return `${dayPart} at ${pad(+hour)}:${pad(+minute)}`;
}

function formatNextRun(nextRun) {
  if (!nextRun) return 'N/A';
  const diffMs = new Date(nextRun) - Date.now();
  if (diffMs <= 0) return 'Overdue';
  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

function formatDateTime(value) {
  if (!value) return 'Never';
  try { return new Date(value).toLocaleString(); } catch { return value; }
}

function formatTimerCountdown(firesAtISO) {
  const diff = new Date(firesAtISO) - Date.now();
  if (diff <= 0) return 'firing';
  const mins = Math.ceil(diff / 60_000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

function scheduleStatusBadge(schedule) {
  if (!schedule.enabled) return '<span class="sched-badge sched-badge--paused">Paused</span>';
  if (schedule.lastRunResult === 'template_missing') return '<span class="sched-badge sched-badge--error">Missing Template</span>';
  if (schedule.lastRunResult?.startsWith('error:')) return '<span class="sched-badge sched-badge--error">Error</span>';
  return '<span class="sched-badge sched-badge--ok">Active</span>';
}

export function initSchedulesStudio() {
  on('automations:open-schedules', (opts) => openPanel(opts || {}));
  on('schedules:open', (opts) => openPanel(opts || {}));
  setupSync();
}

async function openPanel(opts = {}) {
  if (isGuest() && !hasPermission('automations')) {
    showGuestToast('Schedules are disabled by the host');
    return;
  }
  if (_panel) {
    applyOpenOptions(opts);
    _panel.focus();
    return;
  }

  _backdrop = document.createElement('div');
  _backdrop.className = 'studio-backdrop';
  document.body.appendChild(_backdrop);

  _panel = document.createElement('div');
  _panel.className = 'schedules-studio-panel glass resizable';
  _panel.id = PANEL_ID;
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);
  _panel.style.left = Math.max(20, (window.innerWidth - 980) / 2) + 'px';
  _panel.style.top = Math.max(48, (window.innerHeight - 620) / 2) + 'px';

  wirePanel();
  await loadData();
  applyOpenOptions(opts);
  render();
  requestAnimationFrame(() => {
    _backdrop?.classList.add('open');
    _panel?.classList.add('open');
  });
  startPolling();
}

function applyOpenOptions(opts = {}) {
  if (opts.tab) _tab = opts.tab;
  if (opts.groupId) _selectedGroup = opts.groupId;
  if (opts.action === 'new-schedule') {
    _scheduleEditor = {};
    _tab = 'cron';
  } else if (opts.action === 'new-group') {
    _tab = 'groups';
    _scheduleEditor = null;
  } else if (opts.action === 'quick-timer') {
    _tab = 'timers';
    _scheduleEditor = null;
  }
  if (_panel) render();
}

function closePanel() {
  if (!_panel) return;
  stopPolling();
  closePromptScheduleModal();
  for (const [evt, fn] of _docListeners) document.removeEventListener(evt, fn);
  _docListeners = [];
  _backdrop?.remove();
  _backdrop = null;
  _panel.remove();
  _panel = null;
  _scheduleEditor = null;
  _draggingScheduleId = null;
}

function buildPanelHTML() {
  return `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>

    <div class="sched-header drag-handle" data-drag="${PANEL_ID}">
      <div class="sched-header-left">
        <span class="sched-header-icon">${ICONS.clock}</span>
        <h3>Schedules</h3>
        <span class="sched-count" id="sched-total-count"></span>
      </div>
      <div class="sched-header-actions">
        <button class="sched-header-btn" data-action="schedule-new">${ICONS.plus} New Schedule</button>
        <button class="sched-header-btn" data-action="group-new">${ICONS.folder} New Group</button>
      </div>
      <button class="backdrop-toggle-btn" id="sched-backdrop-toggle" data-tooltip="Toggle backdrop">${ICONS.eye}</button>
      <button class="sched-close" id="sched-close">&times;</button>
    </div>

    <div class="sched-body">
      <aside class="sched-sidebar" id="sched-sidebar"></aside>
      <main class="sched-main" id="sched-main"></main>
    </div>
  `;
}

function wirePanel() {
  $('sched-close')?.addEventListener('click', closePanel);
  $('sched-backdrop-toggle')?.addEventListener('click', () => {
    _backdrop?.classList.toggle('backdrop-hidden');
    $('sched-backdrop-toggle')?.classList.toggle('active', _backdrop?.classList.contains('backdrop-hidden'));
  });

  _panel.addEventListener('click', handleClick);
  _panel.addEventListener('change', handleChange);
  _panel.addEventListener('dragstart', handleDragStart);
  _panel.addEventListener('dragend', handleDragEnd);
  _panel.addEventListener('dragover', handleDragOver);
  _panel.addEventListener('drop', handleDrop);

  const onEsc = (e) => {
    if (e.key !== 'Escape' || !_panel) return;
    if (_promptModal) return;
    if (_scheduleEditor) {
      _scheduleEditor = null;
      render();
      return;
    }
    closePanel();
  };
  document.addEventListener('keydown', onEsc);
  _docListeners.push(['keydown', onEsc]);
}

async function loadData() {
  try { _templates = await fetchLoopTemplates(); } catch { _templates = []; }
  try { _schedules = await fetchSchedules(); } catch { _schedules = []; }
  try { _groups = await fetchScheduleGroups(); } catch { _groups = []; }
  try { _scheduleTimerData = await fetchScheduleTimers(); } catch { _scheduleTimerData = {}; }
  try { _quickTimers = await fetchQuickTimers(); } catch { _quickTimers = []; }
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(() => {
    if (!_panel) { stopPolling(); return; }
    if (document.hidden) return; // no point ticking countdowns in a hidden tab
    updateTimerCountdowns();
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
}

function render() {
  if (!_panel) return;
  const count = $('sched-total-count');
  if (count) count.textContent = String(_schedules.length);
  renderSidebar();
  if (_scheduleEditor) renderScheduleEditor();
  else renderMain();
}

function renderSidebar() {
  const sidebar = $('sched-sidebar');
  if (!sidebar) return;

  const ungroupedCount = _schedules.filter(s => !s.groupId || !getGroup(s.groupId)).length;
  const activeCount = _schedules.filter(s => s.enabled).length;
  const groupRows = _groups.map(group => {
    const count = _schedules.filter(s => s.groupId === group.id).length;
    return `
      <button class="sched-group-row${_selectedGroup === group.id ? ' active' : ''}" data-action="select-group" data-group-id="${esc(group.id)}" data-drop-group="${esc(group.id)}">
        <span class="sched-group-color" style="background:${esc(group.color || 'rgba(255,255,255,0.22)')}"></span>
        <span class="sched-group-name">${esc(group.name)}</span>
        ${group.mutualExclusion ? `<span class="sched-group-mutex-icon" data-tooltip="Mutual exclusion active">${ICONS.lock}</span>` : ''}
        <span class="sched-group-count">${count}</span>
      </button>`;
  }).join('');

  sidebar.innerHTML = `
    <div class="sched-sidebar-summary">
      <div><span>${activeCount}</span><label>Active</label></div>
      <div><span>${_groups.length}</span><label>Groups</label></div>
    </div>
    <button class="sched-group-row${_selectedGroup === 'all' ? ' active' : ''}" data-action="select-group" data-group-id="all" data-drop-group="">
      <span class="sched-group-icon">${ICONS.list}</span>
      <span class="sched-group-name">All Schedules</span>
      <span class="sched-group-count">${_schedules.length}</span>
    </button>
    <button class="sched-group-row${_selectedGroup === 'ungrouped' ? ' active' : ''}" data-action="select-group" data-group-id="ungrouped" data-drop-group="">
      <span class="sched-group-icon">${ICONS.folder}</span>
      <span class="sched-group-name">Ungrouped</span>
      <span class="sched-group-count">${ungroupedCount}</span>
    </button>
    <div class="sched-sidebar-label">Groups</div>
    <div class="sched-group-list">${groupRows || '<div class="sched-sidebar-empty">No schedule groups yet.</div>'}</div>
    <button class="sched-sidebar-prompt" data-action="schedule-prompt" data-tooltip="Let AI build a schedule for you">${ICONS.sparkle} Prompt a Schedule</button>
    <button class="sched-sidebar-new" data-action="group-new">${ICONS.plus} Create Group</button>
  `;
}

function renderMain() {
  const main = $('sched-main');
  if (!main) return;
  const tabs = [
    ['cron', 'Cron'],
    ['timers', 'Timers'],
    ['groups', 'Groups'],
    ['activity', 'Activity'],
  ].map(([id, label]) => `<button class="sched-tab${_tab === id ? ' active' : ''}" data-action="set-tab" data-tab="${id}">${label}</button>`).join('');

  main.innerHTML = `
    <div class="sched-tabs">${tabs}</div>
    <div class="sched-content" id="sched-content"></div>
  `;

  if (_tab === 'cron') renderCronTab();
  else if (_tab === 'timers') renderTimersTab();
  else if (_tab === 'groups') renderGroupsTab();
  else renderActivityTab();
}

function schedulesForSelectedGroup() {
  if (_selectedGroup === 'all') return [..._schedules];
  if (_selectedGroup === 'ungrouped') return _schedules.filter(s => !s.groupId || !getGroup(s.groupId));
  return _schedules.filter(s => s.groupId === _selectedGroup);
}

function sortSchedules(list) {
  return [...list].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const an = a.nextRun ? new Date(a.nextRun).getTime() : Infinity;
    const bn = b.nextRun ? new Date(b.nextRun).getTime() : Infinity;
    if (an !== bn) return an - bn;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function renderCronTab() {
  const content = $('sched-content');
  if (!content) return;

  const active = _schedules.filter(s => s.enabled).length;
  const paused = _schedules.length - active;
  const overdue = _schedules.filter(s => s.enabled && s.nextRun && new Date(s.nextRun) < new Date()).length;
  const title = _selectedGroup === 'all' ? 'All Schedules'
    : _selectedGroup === 'ungrouped' ? 'Ungrouped'
      : getGroup(_selectedGroup)?.name || 'Group';

  content.innerHTML = `
    <div class="sched-stat-strip">
      <div><span>${active}</span><label>Active</label></div>
      <div><span>${paused}</span><label>Paused</label></div>
      <div><span>${overdue}</span><label>Overdue</label></div>
      <button class="sched-primary" data-action="schedule-new">${ICONS.plus} New Cron</button>
    </div>
    <div class="sched-section-head">
      <h4>${esc(title)}</h4>
      <span>${schedulesForSelectedGroup().length} schedules</span>
    </div>
    <div class="sched-card-list" id="sched-card-list"></div>
  `;
  renderScheduleCards($('sched-card-list'), schedulesForSelectedGroup());
}

function renderScheduleCards(container, list) {
  if (!container) return;
  const schedules = sortSchedules(list);
  if (!schedules.length) {
    container.innerHTML = `
      <div class="sched-empty">
        <div>No schedules here.</div>
        <button class="sched-primary" data-action="schedule-new">${ICONS.plus} Create Schedule</button>
      </div>`;
    return;
  }

  const groupOptions = [
    '<option value="">Ungrouped</option>',
    ..._groups.map(g => `<option value="${esc(g.id)}">%NAME%</option>`.replace('%NAME%', esc(g.name))),
  ].join('');

  container.innerHTML = schedules.map(s => {
    const tpl = getTemplate(s.templateId);
    const group = getGroup(s.groupId);
    const profile = s.profile ? CLI_PROFILES.find(p => p.id === s.profile)?.label || s.profile : 'Template default';
    const runtimeParts = [
      profile,
      s.model,
      s.effort ? `think:${s.effort}` : '',
      s.mcpProfile ? `mcp:${s.mcpProfile}` : '',
      s.usesBrowser === true ? 'browser:on' : s.usesBrowser === false ? 'browser:off' : '',
    ].filter(Boolean);
    return `
      <article class="sched-card${s.enabled ? '' : ' is-paused'}" draggable="true" data-schedule-id="${esc(s.id)}">
        <div class="sched-card-main">
          <div class="sched-card-title-row">
            <h4>${esc(s.name)}</h4>
            ${scheduleStatusBadge(s)}
          </div>
          <div class="sched-card-meta">${esc(tpl?.name || 'Missing template')} &middot; ${esc(describeCronClient(s.cron))}</div>
          <div class="sched-card-sub">
            <span>Next: <span class="sched-countdown" data-countdown="${esc(s.nextRun || '')}">${esc(formatNextRun(s.nextRun))}</span></span>
            <span>Runs: ${s.runCount || 0}</span>
            <span>${esc(runtimeParts.join(' · '))}</span>
            ${group ? `<span>${esc(group.name)}</span>` : '<span>Ungrouped</span>'}
          </div>
        </div>
        <div class="sched-card-controls">
          <select class="sched-card-group-select" data-schedule-id="${esc(s.id)}" data-value="${esc(s.groupId || '')}">
            ${groupOptions}
          </select>
          <button class="sched-icon-btn" data-action="schedule-toggle" data-id="${esc(s.id)}" data-tooltip="${s.enabled ? 'Pause' : 'Enable'}">${s.enabled ? ICONS.pause : ICONS.play}</button>
          <button class="sched-icon-btn" data-action="schedule-test" data-id="${esc(s.id)}" data-tooltip="Run now">${ICONS.bolt}</button>
          <button class="sched-icon-btn" data-action="schedule-edit-prompt" data-id="${esc(s.id)}" data-template-id="${esc(s.templateId || '')}" data-tooltip="Edit prompt">${ICONS.script}</button>
          <button class="sched-icon-btn" data-action="schedule-edit" data-id="${esc(s.id)}" data-tooltip="Edit schedule">${ICONS.edit}</button>
          <button class="sched-icon-btn danger" data-action="schedule-delete" data-id="${esc(s.id)}" data-tooltip="Delete">${ICONS.close}</button>
        </div>
      </article>`;
  }).join('');

  container.querySelectorAll('.sched-card-group-select').forEach(select => {
    select.value = select.dataset.value || '';
  });
}

function renderTimersTab() {
  const content = $('sched-content');
  if (!content) return;
  const templateOptions = _templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  const scheduleOptions = _schedules.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  const profileOptions = CLI_PROFILES.map(p => `<option value="${p.id}"${p.id === _launchProfile ? ' selected' : ''}>${p.label}</option>`).join('');
  const modelOptions = renderModelOptions(_launchProfile, _launchModel);
  const effortOptions = renderEffortOptions(_launchProfile, _launchEffort);
  const mcpOptions = renderMcpOptions(_launchMcpProfile);
  const accountOptions = renderAccountOptions(_launchAccount, false);
  const showEffort = profileSupportsEffort(_launchProfile);
  const showMcp = _launchProfile !== 'claude-code';
  const showAccount = _launchProfile === 'codex';
  const qtPresetButtons = [5, 15, 30, 60, 120, 240]
    .map(min => `<button class="sched-time-chip${_selectedQtMinutes === min ? ' active' : ''}" data-action="qt-select" data-minutes="${min}">${min >= 60 ? `${min / 60}h` : `${min}m`}</button>`)
    .join('');

  if (isDynamicModelProfile(_launchProfile) && !_modelLoadRequests.has(_launchProfile)) {
    _modelLoadRequests.add(_launchProfile);
    ensureModelsForProfile(_launchProfile).then(() => { if (_panel && _tab === 'timers') renderTimersTab(); });
  }
  if (showAccount) ensureCodexAccountsLoaded(() => { if (_panel && _tab === 'timers') renderTimersTab(); });
  if (showMcp && !Object.keys(getCachedMcpProfilePresets()).length) {
    fetchMcpProfilePresets().then(() => { if (_panel && _tab === 'timers') renderTimersTab(); });
  }

  content.innerHTML = `
    ${renderActiveTimers()}
    <section class="sched-tool-section">
      <div class="sched-section-head"><h4>Quick Timer</h4><span>Launch a template once after a delay</span></div>
      <div class="sched-form-grid">
        <label class="sched-field wide"><span>Automation</span><select id="sched-qt-template"><option value="">Select automation...</option>${templateOptions}</select></label>
        <label class="sched-field"><span>CLI</span><select id="sched-qt-profile">${profileOptions}</select></label>
        <label class="sched-field"><span>Model</span><select id="sched-qt-model">${modelOptions}</select></label>
        <label class="sched-field" style="${showEffort ? '' : 'display:none'}"><span>Think</span><select id="sched-qt-effort">${effortOptions}</select></label>
        <label class="sched-field" style="${showMcp ? '' : 'display:none'}"><span>MCP</span><select id="sched-qt-mcp">${mcpOptions}</select></label>
        <label class="sched-field" id="sched-qt-account-field" style="${showAccount ? '' : 'display:none'}"><span>OpenAI Account</span><select id="sched-qt-account">${accountOptions}</select></label>
        <label class="sched-toggle"><input type="checkbox" id="sched-qt-browser"><span>Uses browser</span></label>
      </div>
      <div class="sched-time-row">
        ${qtPresetButtons}
        <input class="sched-min-input" id="sched-qt-custom-min" type="number" min="1" max="1440" placeholder="min">
        <button class="sched-primary" data-action="qt-go">${ICONS.play} Go</button>
        <button class="sched-secondary" data-action="qt-now">${ICONS.bolt} Run Now</button>
      </div>
    </section>
    <section class="sched-tool-section">
      <div class="sched-section-head"><h4>Saved Schedule Timer</h4><span>Fire an existing cron schedule once after a delay</span></div>
      <div class="sched-form-grid compact">
        <label class="sched-field wide"><span>Schedule</span><select id="sched-existing-timer-schedule"><option value="">Select schedule...</option>${scheduleOptions}</select></label>
        <label class="sched-field"><span>Minutes</span><input id="sched-existing-timer-min" type="number" min="1" max="1440" placeholder="15"></label>
        <button class="sched-primary align-end" data-action="schedule-timer-create">Set Timer</button>
      </div>
    </section>
  `;

  const qtProfile = $('sched-qt-profile');
  qtProfile?.addEventListener('change', () => {
    _launchProfile = qtProfile.value;
    storage.setItem('as-launch-profile', _launchProfile);
    const models = getModelsForProfile(_launchProfile);
    _launchModel = (models.find(m => m.tier === 'default') || models[0])?.id || '';
    storage.setItem('as-launch-model', _launchModel);
    _launchEffort = 'off';
    storage.setItem('as-launch-effort', _launchEffort);
    renderTimersTab();
  });
  $('sched-qt-model')?.addEventListener('change', (e) => {
    _launchModel = e.target.value || null;
    storage.setItem('as-launch-model', _launchModel);
  });
  $('sched-qt-effort')?.addEventListener('change', (e) => {
    _launchEffort = e.target.value || 'off';
    storage.setItem('as-launch-effort', _launchEffort);
  });
  $('sched-qt-mcp')?.addEventListener('change', (e) => {
    _launchMcpProfile = e.target.value || 'full';
    storage.setItem('as-launch-mcp-profile', _launchMcpProfile);
  });
  $('sched-qt-account')?.addEventListener('change', (e) => {
    _launchAccount = e.target.value || 'default';
    storage.setItem('as-launch-account', _launchAccount);
  });
  $('sched-qt-browser')?.addEventListener('change', (e) => { _qtUsesBrowser = e.target.checked; });
  $('sched-qt-template')?.addEventListener('change', (e) => {
    const template = getTemplate(e.target.value);
    const browser = $('sched-qt-browser');
    if (browser && template) {
      browser.checked = !!template.usesBrowser;
      _qtUsesBrowser = null;
    }
  });
}

function renderModelOptions(profile, selected, { showService = false } = {}) {
  const models = getModelsForProfile(profile);
  if (!models.length) {
    // List not loaded yet — preserve any stored selection so saving the form cannot
    // blank it (a blank <select> makes save send model:null, which DELETES the override).
    if (selected) {
      return [
        '<option value="">Template/default</option>',
        `<option value="${esc(selected)}" selected>${esc(selected)}</option>`,
      ].join('');
    }
    return '<option value="" selected>Default</option>';
  }
  const known = !!selected && models.some(m => modelMatchesSelector(m, selected));
  const current = selected || '';
  const opts = [
    `<option value=""${!current ? ' selected' : ''}>Template/default</option>`,
    ...models.map(m => {
      const val = modelSelectorValue(m);
      const label = formatModelOptionLabel(m, {
        includeService: showService && profile === 'opencode',
      });
      return `<option value="${esc(val)}"${modelMatchesSelector(m, current) ? ' selected' : ''}>${esc(label)}</option>`;
    }),
  ];
  // Preserve a stored model that isn't in the (still-loading or curated) list so the
  // dropdown never silently blanks it and a save can't wipe the persisted override.
  if (selected && !known) {
    opts.push(`<option value="${esc(selected)}" selected>${esc(selected)} (saved)</option>`);
  }
  return opts.join('');
}

function renderEffortOptions(profile, selected) {
  const levels = getEffortLevelsForProfile(profile);
  if (!levels.length) return '<option value="off" selected>Default</option>';
  const current = selected && levels.some(e => e.id === selected) ? selected : null;
  return levels.map(e => `<option value="${esc(e.id)}"${e.id === current ? ' selected' : ''}>${esc(e.label)}${e.desc ? ' - ' + esc(e.desc) : ''}</option>`).join('');
}

function renderMcpOptions(selected) {
  const presets = getCachedMcpProfilePresets();
  const entries = Object.entries(presets);
  if (!entries.length) {
    if (!selected) return '<option value="">Loading...</option>';
    return `<option value="${esc(selected)}" selected>${esc(selected)} (loading...)</option>`;
  }
  const current = selected ? (presets[selected] ? selected : (presets.full ? 'full' : entries[0][0])) : null;
  return entries.map(([id, p]) => {
    const label = p.label || id;
    const tools = p.tools != null ? ` - ${p.tools} tools` : '';
    return `<option value="${esc(id)}"${id === current ? ' selected' : ''}>${esc(label)}${esc(tools)}</option>`;
  }).join('');
}

// Render <option>s for the Codex account selector. `allowInherit` adds a
// "Template/group default" option (used by schedule/group forms); the timers
// tab passes false so it always resolves to a concrete account.
function renderAccountOptions(selected, allowInherit = false) {
  const accounts = getCachedCodexAccounts();
  const current = accounts.some(a => a.id === selected) ? selected : (allowInherit ? '' : 'default');
  const opts = accounts.map(a => {
    const label = a.label || a.email || (a.isDefault ? 'Default' : a.id);
    const plan = a.planType ? ` (${a.planType})` : '';
    return `<option value="${esc(a.id)}"${a.id === current ? ' selected' : ''}>${esc(label)}${esc(plan)}</option>`;
  });
  if (allowInherit) {
    opts.unshift(`<option value=""${!current ? ' selected' : ''}>Template/group default</option>`);
  }
  return opts.join('');
}

// Kick off a one-time fetch of accounts; re-render the active tab when ready.
function ensureCodexAccountsLoaded(rerender) {
  if (_codexAccountsRequested) return;
  _codexAccountsRequested = true;
  fetchCodexAccounts().then(() => { if (_panel) rerender?.(); }).catch(() => {});
}

function renderActiveTimers() {
  const scheduleTimers = Object.entries(_scheduleTimerData).map(([scheduleId, timer]) => {
    const schedule = _schedules.find(s => s.id === scheduleId);
    return `
      <div class="sched-active-timer">
        <span>${esc(schedule?.name || 'Schedule')}</span>
        <strong>${formatTimerCountdown(timer.firesAt)}</strong>
        <button class="sched-icon-btn" data-action="schedule-timer-cancel" data-id="${esc(scheduleId)}">${ICONS.close}</button>
      </div>`;
  }).join('');

  const quickTimers = _quickTimers.map(timer => `
    <div class="sched-active-timer">
      <span>${esc(timer.templateName)}${timer.profile ? ` · ${esc(timer.profile)}` : ''}${timer.model ? ` · ${esc(timer.model)}` : ''}${timer.effort ? ` · think:${esc(timer.effort)}` : ''}${timer.mcpProfile ? ` · mcp:${esc(timer.mcpProfile)}` : ''}</span>
      <strong>${formatTimerCountdown(timer.firesAt)}</strong>
      <button class="sched-icon-btn" data-action="qt-cancel" data-id="${esc(timer.id)}">${ICONS.close}</button>
    </div>
  `).join('');

  if (!scheduleTimers && !quickTimers) return '';
  return `<section class="sched-active-timers">${quickTimers}${scheduleTimers}</section>`;
}

function renderGroupOverrideSummary(group) {
  const parts = [];
  if (group.profile) {
    const p = CLI_PROFILES.find(c => c.id === group.profile);
    parts.push(p ? p.label : group.profile);
  }
  if (group.model) parts.push(group.model);
  if (group.effort) parts.push(`think:${group.effort}`);
  if (group.mcpProfile) parts.push(`mcp:${group.mcpProfile}`);
  if (group.usesBrowser === true) parts.push('browser:on');
  else if (group.usesBrowser === false) parts.push('browser:off');
  return parts.length ? `<span class="sched-group-overrides">${esc(parts.join(' · '))}</span>` : '';
}

function renderGroupEditor(group) {
  const d = _groupEditorDraft || group;
  const profileForModels = d.profile || 'claude-code';
  const profileOptions = [
    `<option value=""${!d.profile ? ' selected' : ''}>No override</option>`,
    ...CLI_PROFILES.map(p => `<option value="${p.id}"${d.profile === p.id ? ' selected' : ''}>${p.label}</option>`),
  ].join('');
  const modelOptions = renderModelOptions(profileForModels, d.model || '', { showService: true });
  const effortOptions = renderEffortOptions(profileForModels, d.effort || '');
  const mcpOptions = renderMcpOptions(d.mcpProfile || '');
  const accountOptions = renderAccountOptions(d.codexAccountId || '', true);
  const showEffort = profileSupportsEffort(profileForModels);
  const showMcp = profileForModels !== 'claude-code';
  const showAccount = profileForModels === 'codex';
  if (showAccount) ensureCodexAccountsLoaded(() => renderGroupsTab());
  if (showMcp && !Object.keys(getCachedMcpProfilePresets()).length) {
    fetchMcpProfilePresets().then(() => { if (_panel && _groupEditorId) renderGroupsTab(); });
  }
  const browserValue = d.usesBrowser === true ? 'true' : d.usesBrowser === false ? 'false' : '';
  return `
    <div class="sched-group-editor-body">
      <div class="sched-form-grid compact">
        <label class="sched-field wide"><span>Name</span><input id="sched-ge-name" type="text" value="${esc(group.name)}"></label>
        <label class="sched-field"><span>Color</span><input id="sched-ge-color" type="color" value="${esc(group.color || '#4fc3f7')}"></label>
      </div>
      <div class="sched-section-head" style="margin-top:10px"><h4>Launch Overrides</h4><span>Applies to all schedules in this group (schedule-level overrides take priority)</span></div>
      <div class="sched-form-grid">
        <label class="sched-field"><span>CLI</span><select id="sched-ge-profile">${profileOptions}</select></label>
        <label class="sched-field"><span>Model</span><select id="sched-ge-model">${modelOptions}</select></label>
        <label class="sched-field" style="${showEffort ? '' : 'display:none'}"><span>Think</span><select id="sched-ge-effort">
          <option value=""${!d.effort ? ' selected' : ''}>No override</option>
          ${effortOptions}
        </select></label>
        <label class="sched-field" style="${showMcp ? '' : 'display:none'}"><span>MCP</span><select id="sched-ge-mcp">
          <option value=""${!d.mcpProfile ? ' selected' : ''}>No override</option>
          ${mcpOptions}
        </select></label>
        <label class="sched-field" id="sched-ge-account-field" style="${showAccount ? '' : 'display:none'}"><span>OpenAI Account</span><select id="sched-ge-account">${accountOptions}</select></label>
        <label class="sched-field"><span>Browser</span><select id="sched-ge-browser">
          <option value=""${browserValue === '' ? ' selected' : ''}>No override</option>
          <option value="true"${browserValue === 'true' ? ' selected' : ''}>Force on</option>
          <option value="false"${browserValue === 'false' ? ' selected' : ''}>Force off</option>
        </select></label>
      </div>
      <div class="sched-group-editor-actions">
        <button class="sched-secondary" data-action="group-editor-cancel">Cancel</button>
        <button class="sched-primary" data-action="group-editor-save" data-id="${esc(group.id)}">Save Changes</button>
      </div>
    </div>`;
}

function renderGroupsTab() {
  const content = $('sched-content');
  if (!content) return;
  const rows = _groups.map((group, idx) => {
    const count = _schedules.filter(s => s.groupId === group.id).length;
    const isEditing = _groupEditorId === group.id;
    const overrideSummary = renderGroupOverrideSummary(group);
    return `
      <article class="sched-group-card${isEditing ? ' editing' : ''}" data-group-id="${esc(group.id)}">
        <div class="sched-group-card-main">
          <span class="sched-group-color large" style="background:${esc(group.color || 'rgba(255,255,255,0.22)')}"></span>
          <div>
            <h4>${esc(group.name)}</h4>
            <span>${count} schedules${overrideSummary ? ' · ' : ''}${overrideSummary}</span>
          </div>
        </div>
        <div class="sched-group-card-actions">
          <label class="sched-mutex-toggle" data-tooltip="When enabled, only one schedule across all mutex-enabled groups can run at a time.">
            <input type="checkbox" data-action="group-mutex-toggle" data-id="${esc(group.id)}" ${group.mutualExclusion ? 'checked' : ''}>
            <span class="sched-mutex-label">${ICONS.lock} Mutex</span>
          </label>
          <button class="sched-icon-btn" data-action="group-up" data-id="${esc(group.id)}" ${idx === 0 ? 'disabled' : ''}>Up</button>
          <button class="sched-icon-btn" data-action="group-down" data-id="${esc(group.id)}" ${idx === _groups.length - 1 ? 'disabled' : ''}>Down</button>
          <button class="sched-icon-btn" data-action="group-edit" data-id="${esc(group.id)}">${ICONS.edit}</button>
          <button class="sched-icon-btn danger" data-action="group-delete" data-id="${esc(group.id)}">${ICONS.close}</button>
        </div>
        ${isEditing ? renderGroupEditor(group) : ''}
      </article>`;
  }).join('');

  content.innerHTML = `
    <section class="sched-tool-section">
      <div class="sched-section-head"><h4>Create Group</h4><span>Use groups to categorize schedules freely</span></div>
      <div class="sched-form-grid compact">
        <label class="sched-field wide"><span>Name</span><input id="sched-group-name" type="text" placeholder="e.g. Twitter cadence"></label>
        <label class="sched-field"><span>Color</span><input id="sched-group-color" type="color" value="#4fc3f7"></label>
        <label class="sched-mutex-toggle sched-mutex-create" data-tooltip="Only one schedule across all mutex-enabled groups can run at a time">
          <input type="checkbox" id="sched-group-mutex"><span class="sched-mutex-label">${ICONS.lock} Mutex</span>
        </label>
        <button class="sched-primary align-end" data-action="group-save-new">${ICONS.plus} Create</button>
      </div>
    </section>
    <div class="sched-group-card-list">${rows || '<div class="sched-empty">No groups yet.</div>'}</div>
  `;

  if (_groupEditorId && _groupEditorDraft) {
    const profileSelect = $('sched-ge-profile');
    if (profileSelect) {
      profileSelect.addEventListener('change', () => {
        _groupEditorDraft.profile = profileSelect.value || null;
        _groupEditorDraft.model = null;
        _groupEditorDraft.effort = null;
        _groupEditorDraft.mcpProfile = null;
        _groupEditorDraft.codexAccountId = null;
        ensureModelsForProfile(_groupEditorDraft.profile || 'claude-code').then(() => renderGroupsTab());
        renderGroupsTab();
      });
    }
    $('sched-ge-account')?.addEventListener('change', (e) => {
      _groupEditorDraft.codexAccountId = e.target.value || null;
    });
  }
}

function renderActivityTab() {
  const content = $('sched-content');
  if (!content) return;
  const rows = [..._schedules]
    .sort((a, b) => new Date(b.lastRun || 0) - new Date(a.lastRun || 0))
    .map(s => `
      <div class="sched-activity-row">
        <div>
          <strong>${esc(s.name)}</strong>
          <span>${esc(getTemplate(s.templateId)?.name || 'Missing template')}</span>
        </div>
        ${scheduleStatusBadge(s)}
        <span>${esc(s.lastRunResult || 'not run')}</span>
        <span>${esc(formatDateTime(s.lastRun))}</span>
        <span>Next ${esc(formatNextRun(s.nextRun))}</span>
      </div>
    `).join('');

  content.innerHTML = `
    <div class="sched-section-head"><h4>Schedule Activity</h4><span>Last run state and upcoming runs</span></div>
    <div class="sched-activity-list">${rows || '<div class="sched-empty">No activity yet.</div>'}</div>
  `;
}

function renderScheduleEditor() {
  const main = $('sched-main');
  if (!main) return;
  const s = _scheduleEditor || {};
  const isEdit = !!s.id;
  const templateOptions = _templates.map(t => `<option value="${esc(t.id)}"${s.templateId === t.id ? ' selected' : ''}>${esc(t.name)} (${esc(t.category || 'custom')})</option>`).join('');
  const groupOptions = [
    `<option value=""${!s.groupId ? ' selected' : ''}>Ungrouped</option>`,
    ..._groups.map(g => `<option value="${esc(g.id)}"${s.groupId === g.id ? ' selected' : ''}>${esc(g.name)}</option>`),
  ].join('');
  const tz = s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const profileOptions = [
    `<option value=""${!s.profile ? ' selected' : ''}>Template default</option>`,
    ...CLI_PROFILES.map(p => `<option value="${p.id}"${s.profile === p.id ? ' selected' : ''}>${p.label}</option>`),
  ].join('');
  const template = getTemplate(s.templateId);
  const profileForModels = s.profile || template?.profile || 'claude-code';
  const modelOptions = renderModelOptions(profileForModels, s.model || '', { showService: true });
  const effortOptions = renderEffortOptions(profileForModels, s.effort || '');
  const mcpOptions = renderMcpOptions(s.mcpProfile || '');
  const accountOptions = renderAccountOptions(s.codexAccountId || '', true);
  const showEffort = profileSupportsEffort(profileForModels);
  const showMcp = profileForModels !== 'claude-code';
  const showAccount = profileForModels === 'codex';
  if (showAccount) ensureCodexAccountsLoaded(() => { if (_panel && _scheduleEditor) renderScheduleEditor(); });
  const browserValue = s.usesBrowser === true ? 'true' : s.usesBrowser === false ? 'false' : '';
  const presetsHTML = CRON_PRESET_GROUPS.map(group => `
    <div class="sched-preset-group">
      <span>${esc(group.group)}</span>
      <div>${group.presets.map(p => `<button class="sched-preset" data-action="cron-preset" data-cron="${esc(p.cron)}" data-tooltip="${esc(p.desc)}">${esc(p.label)}</button>`).join('')}</div>
    </div>`).join('');
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  const dayThemes = dayOrder.map(idx => `
    <label class="sched-day-field">
      <span>${DAY_NAMES[idx]}</span>
      <input type="text" data-day="${idx}" value="${esc(s.dayThemes?.[String(idx)]?.contextOverride || '')}" placeholder="Optional context override">
    </label>`).join('');

  if (isDynamicModelProfile(profileForModels) && !_modelLoadRequests.has(profileForModels)) {
    _modelLoadRequests.add(profileForModels);
    ensureModelsForProfile(profileForModels).then(() => { if (_panel && _scheduleEditor) renderScheduleEditor(); });
  }
  if (showMcp && !Object.keys(getCachedMcpProfilePresets()).length) {
    fetchMcpProfilePresets().then(() => { if (_panel && _scheduleEditor) renderScheduleEditor(); });
  }

  main.innerHTML = `
    <div class="sched-editor">
      <div class="sched-editor-head">
        <button class="sched-icon-btn" data-action="schedule-editor-close">${ICONS.back}</button>
        <div>
          <h3>${isEdit ? 'Edit Schedule' : 'New Schedule'}</h3>
          <span>${isEdit ? esc(s.name) : 'Create a recurring cron launch'}</span>
        </div>
      </div>
      <div class="sched-editor-body">
        <div class="sched-form-grid">
          <label class="sched-field"><span>Name</span><input id="sched-ed-name" type="text" value="${esc(s.name || '')}" placeholder="Morning post"></label>
          <label class="sched-field"><span>Automation</span><select id="sched-ed-template"><option value="">Select automation...</option>${templateOptions}</select></label>
          <label class="sched-field"><span>Group</span><select id="sched-ed-group">${groupOptions}</select></label>
          <label class="sched-field"><span>Timezone</span><input id="sched-ed-tz" type="text" value="${esc(tz)}"></label>
        </div>

        <section class="sched-editor-section">
          <div class="sched-section-head"><h4>Cron</h4><span id="sched-ed-cron-desc">${esc(describeCronClient(s.cron || '0 9 * * *'))}</span></div>
          <div class="sched-presets">${presetsHTML}</div>
          <input class="sched-cron-input" id="sched-ed-cron" type="text" value="${esc(s.cron || '0 9 * * *')}" placeholder="0 9 * * *">
        </section>

        <section class="sched-editor-section">
          <div class="sched-section-head"><h4>Launch Overrides</h4><span>Leave blank to use automation defaults</span></div>
          <div class="sched-form-grid">
            <label class="sched-field"><span>CLI</span><select id="sched-ed-profile">${profileOptions}</select></label>
            <label class="sched-field"><span>Model</span><select id="sched-ed-model">${modelOptions}</select></label>
            <label class="sched-field" style="${showEffort ? '' : 'display:none'}"><span>Think</span><select id="sched-ed-effort">
              <option value=""${!s.effort ? ' selected' : ''}>Template/default</option>
              ${effortOptions}
            </select></label>
            <label class="sched-field" style="${showMcp ? '' : 'display:none'}"><span>MCP</span><select id="sched-ed-mcp">
              <option value=""${!s.mcpProfile ? ' selected' : ''}>Template/default</option>
              ${mcpOptions}
            </select></label>
            <label class="sched-field" id="sched-ed-account-field" style="${showAccount ? '' : 'display:none'}"><span>OpenAI Account</span><select id="sched-ed-account">${accountOptions}</select></label>
            <label class="sched-field"><span>Browser</span><select id="sched-ed-browser">
              <option value=""${browserValue === '' ? ' selected' : ''}>Template default</option>
              <option value="true"${browserValue === 'true' ? ' selected' : ''}>Force on</option>
              <option value="false"${browserValue === 'false' ? ' selected' : ''}>Force off</option>
            </select></label>
          </div>
        </section>

        <section class="sched-editor-section">
          <div class="sched-section-head"><h4>Day Themes</h4><span>Optional context per weekday</span></div>
          <div class="sched-day-grid" id="sched-ed-daythemes">${dayThemes}</div>
        </section>

        <label class="sched-toggle"><input id="sched-ed-enabled" type="checkbox" ${s.enabled !== false ? 'checked' : ''}><span>Enabled</span></label>
      </div>
      <div class="sched-editor-actions">
        <button class="sched-secondary" data-action="schedule-editor-close">Cancel</button>
        <button class="sched-primary" data-action="schedule-editor-save">${isEdit ? 'Save Changes' : 'Create Schedule'}</button>
      </div>
    </div>
  `;

  $('sched-ed-cron')?.addEventListener('input', updateCronDesc);
  $('sched-ed-template')?.addEventListener('change', (e) => {
    collectScheduleEditorDraft();
    _scheduleEditor.templateId = e.target.value || null;
    _scheduleEditor.model = null;
    _scheduleEditor.effort = null;
    _scheduleEditor.mcpProfile = null;
    _scheduleEditor.codexAccountId = null;
    renderScheduleEditor();
  });
  $('sched-ed-profile')?.addEventListener('change', (e) => {
    collectScheduleEditorDraft();
    _scheduleEditor.profile = e.target.value || null;
    _scheduleEditor.model = null;
    _scheduleEditor.effort = null;
    _scheduleEditor.mcpProfile = null;
    _scheduleEditor.codexAccountId = null;
    renderScheduleEditor();
  });
}

function updateCronDesc() {
  const input = $('sched-ed-cron');
  const desc = $('sched-ed-cron-desc');
  if (input && desc) desc.textContent = describeCronClient(input.value);
}

function collectScheduleEditorDraft() {
  if (!_scheduleEditor) return;
  const dayThemes = {};
  _panel?.querySelectorAll('#sched-ed-daythemes input[data-day]').forEach(input => {
    const val = input.value.trim();
    if (val) dayThemes[input.dataset.day] = { contextOverride: val };
  });
  const browserRaw = $('sched-ed-browser')?.value || '';
  Object.assign(_scheduleEditor, {
    name: $('sched-ed-name')?.value ?? _scheduleEditor.name,
    templateId: $('sched-ed-template')?.value || _scheduleEditor.templateId,
    groupId: $('sched-ed-group')?.value || null,
    timezone: $('sched-ed-tz')?.value || _scheduleEditor.timezone,
    cron: $('sched-ed-cron')?.value || _scheduleEditor.cron,
    profile: $('sched-ed-profile')?.value || null,
    model: $('sched-ed-model')?.value || null,
    effort: $('sched-ed-effort')?.value || null,
    mcpProfile: $('sched-ed-mcp')?.value || null,
    codexAccountId: $('sched-ed-account')?.value || null,
    usesBrowser: browserRaw === '' ? undefined : browserRaw === 'true',
    enabled: $('sched-ed-enabled')?.checked ?? _scheduleEditor.enabled,
    dayThemes,
  });
}

async function saveScheduleFromEditor() {
  const name = $('sched-ed-name')?.value?.trim();
  const templateId = $('sched-ed-template')?.value;
  const cron = $('sched-ed-cron')?.value?.trim();
  const timezone = $('sched-ed-tz')?.value?.trim();
  const groupId = $('sched-ed-group')?.value || null;
  const profile = $('sched-ed-profile')?.value || null;
  const model = $('sched-ed-model')?.value || null;
  const template = getTemplate(templateId);
  const effectiveProfile = profile || template?.profile || 'claude-code';
  const effort = normalizeEffortForProfile(effectiveProfile, $('sched-ed-effort')?.value || null);
  const mcpProfile = $('sched-ed-mcp')?.value || null;
  const codexAccountId = effectiveProfile === 'codex' ? ($('sched-ed-account')?.value || null) : null;
  const browserRaw = $('sched-ed-browser')?.value || '';
  const enabled = $('sched-ed-enabled')?.checked ?? true;

  if (!name) { showToast('Name is required'); return; }
  if (!templateId) { showToast('Select an automation'); return; }
  if (!cron || cron.split(/\s+/).length !== 5) { showToast('Valid 5-field cron expression required'); return; }

  const dayThemes = {};
  _panel.querySelectorAll('#sched-ed-daythemes input[data-day]').forEach(input => {
    const val = input.value.trim();
    if (val) dayThemes[input.dataset.day] = { contextOverride: val };
  });

  const payload = {
    name, templateId, cron, timezone, groupId, enabled, dayThemes,
    profile, model, effort, mcpProfile, codexAccountId,
    usesBrowser: browserRaw === '' ? null : browserRaw === 'true',
  };

  try {
    if (_scheduleEditor?.id) {
      const updated = await updateSchedule(_scheduleEditor.id, payload);
      const idx = _schedules.findIndex(s => s.id === updated.id);
      if (idx >= 0) _schedules[idx] = updated;
      showToast('Schedule updated');
    } else {
      const created = await createSchedule(payload);
      if (!_schedules.some(s => s.id === created.id)) _schedules.push(created);
      showToast('Schedule created');
    }
    _scheduleEditor = null;
    render();
  } catch (err) {
    showToast('Save failed: ' + err.message);
  }
}

async function handleClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !_panel?.contains(el)) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case 'set-tab':
      _tab = el.dataset.tab || 'cron';
      _scheduleEditor = null;
      render();
      break;
    case 'select-group':
      _selectedGroup = el.dataset.groupId || 'all';
      _tab = 'cron';
      render();
      break;
    case 'schedule-new':
      _scheduleEditor = { groupId: _selectedGroup !== 'all' && _selectedGroup !== 'ungrouped' ? _selectedGroup : null };
      render();
      break;
    case 'schedule-edit': {
      const schedule = _schedules.find(s => s.id === id);
      if (schedule) {
        _scheduleEditor = { ...schedule, dayThemes: { ...(schedule.dayThemes || {}) } };
        render();
      }
      break;
    }
    case 'schedule-edit-prompt': {
      const templateId = el.dataset.templateId;
      if (!templateId) { showToast('No automation linked to this schedule'); break; }
      closePanel();
      emit('automations:open', { templateId });
      break;
    }
    case 'schedule-editor-close':
      _scheduleEditor = null;
      render();
      break;
    case 'schedule-editor-save':
      await saveScheduleFromEditor();
      break;
    case 'cron-preset': {
      const cronInput = $('sched-ed-cron');
      if (cronInput) {
        cronInput.value = el.dataset.cron || cronInput.value;
        updateCronDesc();
      }
      break;
    }
    case 'schedule-toggle':
      await toggleSchedule(id);
      break;
    case 'schedule-test':
      await fireSchedule(id);
      break;
    case 'schedule-delete':
      await removeSchedule(id);
      break;
    case 'group-new':
      _tab = 'groups';
      _scheduleEditor = null;
      render();
      setTimeout(() => $('sched-group-name')?.focus(), 0);
      break;
    case 'schedule-prompt':
      openPromptScheduleModal();
      break;
    case 'prompt-modal-close':
      closePromptScheduleModal();
      break;
    case 'prompt-modal-pick':
      handlePromptPick(el.dataset.runtime);
      break;
    case 'group-save-new':
      await saveNewGroup();
      break;
    case 'group-mutex-toggle':
      await toggleGroupMutex(id, el.checked);
      break;
    case 'group-edit':
      await editGroup(id);
      break;
    case 'group-editor-save':
      await saveGroupFromEditor(id);
      break;
    case 'group-editor-cancel':
      _groupEditorId = null;
      _groupEditorDraft = null;
      renderGroupsTab();
      break;
    case 'group-delete':
      await removeGroup(id);
      break;
    case 'group-up':
      await moveGroup(id, -1);
      break;
    case 'group-down':
      await moveGroup(id, 1);
      break;
    case 'qt-select':
      _selectedQtMinutes = Number(el.dataset.minutes);
      renderTimersTab();
      break;
    case 'qt-go':
      await createQuickTimerFromForm(false);
      break;
    case 'qt-now':
      await createQuickTimerFromForm(true);
      break;
    case 'qt-cancel':
      await cancelQuickTimerById(id);
      break;
    case 'schedule-timer-create':
      await createExistingScheduleTimer();
      break;
    case 'schedule-timer-cancel':
      await cancelExistingScheduleTimer(id);
      break;
  }
}

async function handleChange(e) {
  const select = e.target.closest('.sched-card-group-select');
  if (!select) return;
  const scheduleId = select.dataset.scheduleId;
  try {
    const updated = await updateSchedule(scheduleId, { groupId: select.value || null });
    const idx = _schedules.findIndex(s => s.id === updated.id);
    if (idx >= 0) _schedules[idx] = updated;
    showToast(select.value ? `Moved to ${getGroup(select.value)?.name || 'group'}` : 'Moved to Ungrouped');
    render();
  } catch (err) {
    showToast('Move failed: ' + err.message);
  }
}

function handleDragStart(e) {
  const card = e.target.closest('.sched-card');
  if (!card) return;
  _draggingScheduleId = card.dataset.scheduleId;
  card.classList.add('dragging');
  try { e.dataTransfer.setData('text/plain', _draggingScheduleId); } catch {}
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd() {
  _draggingScheduleId = null;
  _panel?.querySelectorAll('.sched-card.dragging').forEach(el => el.classList.remove('dragging'));
  _panel?.querySelectorAll('.sched-group-row.drop-target').forEach(el => el.classList.remove('drop-target'));
}

function handleDragOver(e) {
  if (!_draggingScheduleId) return;
  const target = e.target.closest('[data-drop-group]');
  if (!target) return;
  e.preventDefault();
  target.classList.add('drop-target');
}

async function handleDrop(e) {
  if (!_draggingScheduleId) return;
  const target = e.target.closest('[data-drop-group]');
  if (!target) return;
  e.preventDefault();
  const groupId = target.dataset.dropGroup || null;
  try {
    const updated = await updateSchedule(_draggingScheduleId, { groupId });
    const idx = _schedules.findIndex(s => s.id === updated.id);
    if (idx >= 0) _schedules[idx] = updated;
    _selectedGroup = groupId || 'ungrouped';
    showToast(groupId ? `Moved to ${getGroup(groupId)?.name || 'group'}` : 'Moved to Ungrouped');
    render();
  } catch (err) {
    showToast('Move failed: ' + err.message);
  } finally {
    handleDragEnd();
  }
}

async function toggleSchedule(id) {
  const schedule = _schedules.find(s => s.id === id);
  if (!schedule) return;
  try {
    const updated = await updateSchedule(id, { enabled: !schedule.enabled });
    const idx = _schedules.findIndex(s => s.id === id);
    if (idx >= 0) _schedules[idx] = updated;
    showToast(updated.enabled ? 'Schedule enabled' : 'Schedule paused');
    render();
  } catch (err) {
    showToast('Toggle failed: ' + err.message);
  }
}

async function fireSchedule(id) {
  try {
    await testSchedule(id, {
      sidepanelWindowId: getNativeLoopRouterWindowId(),
      sidepanelClaimToken: getNativeLoopRouterClaimToken(),
    });
    showToast('Launching schedule…');
  } catch (err) {
    showToast('Run failed: ' + err.message);
  }
}

async function removeSchedule(id) {
  if (!confirm('Delete this schedule?')) return;
  try {
    await deleteSchedule(id);
    _schedules = _schedules.filter(s => s.id !== id);
    render();
    showToast('Schedule deleted');
  } catch (err) {
    showToast('Delete failed: ' + err.message);
  }
}

async function saveNewGroup() {
  const name = $('sched-group-name')?.value?.trim();
  const color = $('sched-group-color')?.value || null;
  const mutualExclusion = $('sched-group-mutex')?.checked || false;
  if (!name) { showToast('Group name is required'); return; }
  try {
    const group = await createScheduleGroup({ name, color, mutualExclusion });
    if (!_groups.some(g => g.id === group.id)) _groups.push(group);
    _selectedGroup = group.id;
    _tab = 'cron';
    render();
    showToast('Group created');
  } catch (err) {
    showToast('Group failed: ' + err.message);
  }
}

async function editGroup(id) {
  if (_groupEditorId === id) {
    _groupEditorId = null;
    _groupEditorDraft = null;
  } else {
    _groupEditorId = id;
    const group = getGroup(id);
    if (group) {
      _groupEditorDraft = { name: group.name, color: group.color, profile: group.profile || null, model: group.model || null, effort: group.effort || null, mcpProfile: group.mcpProfile || null, codexAccountId: group.codexAccountId || null, usesBrowser: group.usesBrowser };
      ensureModelsForProfile(_groupEditorDraft.profile || 'claude-code').then(() => renderGroupsTab());
    }
  }
  renderGroupsTab();
}

async function saveGroupFromEditor(id) {
  const name = $('sched-ge-name')?.value?.trim();
  if (!name) { showToast('Group name is required'); return; }
  const color = $('sched-ge-color')?.value || null;
  const profile = $('sched-ge-profile')?.value || null;
  const model = $('sched-ge-model')?.value || null;
  const effectiveProfile = profile || 'claude-code';
  const effort = normalizeEffortForProfile(effectiveProfile, $('sched-ge-effort')?.value || null);
  const mcpProfile = $('sched-ge-mcp')?.value || null;
  const codexAccountId = effectiveProfile === 'codex' ? ($('sched-ge-account')?.value || null) : null;
  const browserRaw = $('sched-ge-browser')?.value || '';
  const usesBrowser = browserRaw === '' ? null : browserRaw === 'true';
  // Send only the launch fields the user actually changed. The server pushes changed
  // group launch fields onto every schedule in the group, so sending an unchanged field
  // would needlessly re-propagate onto (and historically clobber) per-schedule overrides.
  // name/color always go.
  const group = getGroup(id) || {};
  const norm = (v) => (v === '' || v == null ? null : v);
  const payload = { name, color };
  for (const [k, v] of [['profile', profile], ['model', model], ['effort', effort], ['mcpProfile', mcpProfile], ['codexAccountId', codexAccountId], ['usesBrowser', usesBrowser]]) {
    if (norm(v) !== norm(group[k])) payload[k] = v;
  }
  try {
    const updated = await updateScheduleGroup(id, payload);
    const idx = _groups.findIndex(g => g.id === id);
    if (idx >= 0) _groups[idx] = updated;
    _groupEditorId = null;
    _groupEditorDraft = null;
    // Group launch overrides are written through to each schedule server-side;
    // reload so the schedule cards immediately reflect the propagated values.
    await loadData();
    render();
    showToast('Group updated');
  } catch (err) {
    showToast('Group update failed: ' + err.message);
  }
}

async function toggleGroupMutex(id, checked) {
  try {
    const updated = await updateScheduleGroup(id, { mutualExclusion: !!checked });
    const idx = _groups.findIndex(g => g.id === id);
    if (idx >= 0) _groups[idx] = updated;
    render();
    showToast(checked ? 'Mutual exclusion enabled' : 'Mutual exclusion disabled');
  } catch (err) {
    showToast('Mutex toggle failed: ' + err.message);
  }
}

async function removeGroup(id) {
  const count = _schedules.filter(s => s.groupId === id).length;
  if (!confirm(`Delete this group? ${count} schedules will move to Ungrouped.`)) return;
  try {
    await deleteScheduleGroup(id);
    _groups = _groups.filter(g => g.id !== id);
    for (const schedule of _schedules) if (schedule.groupId === id) schedule.groupId = null;
    if (_selectedGroup === id) _selectedGroup = 'ungrouped';
    render();
    showToast('Group deleted');
  } catch (err) {
    showToast('Group delete failed: ' + err.message);
  }
}

function openPromptScheduleModal() {
  if (_promptModal) return;

  _promptBackdrop = document.createElement('div');
  _promptBackdrop.className = 'sched-prompt-backdrop';
  _promptBackdrop.addEventListener('click', closePromptScheduleModal);
  document.body.appendChild(_promptBackdrop);

  const claudeMeta = getProviderMeta('claude-code');
  const opencodeMeta = getProviderMeta('opencode');
  const codexMeta = getProviderMeta('codex');
  _promptModal = document.createElement('div');
  _promptModal.className = 'sched-prompt-modal glass';
  _promptModal.innerHTML = `
    <header class="sched-prompt-head">
      <div class="sched-prompt-head-text">
        <span class="sched-prompt-icon">${ICONS.sparkle}</span>
        <div>
          <h3>Prompt a Schedule</h3>
          <p>Start the schedule draft in a sidepanel.</p>
        </div>
      </div>
      <button class="sched-prompt-close" data-action="prompt-modal-close" aria-label="Close">${ICONS.close}</button>
    </header>
    <div class="sched-prompt-tiles">
      <button class="sched-prompt-tile" style="--provider-color:${claudeMeta.color};" data-action="prompt-modal-pick" data-runtime="claude-code">
        <span class="sched-prompt-tile-logo" aria-hidden="true">${claudeMeta.icon}</span>
        <span class="sched-prompt-tile-body">
          <span class="sched-prompt-tile-title">${claudeMeta.label}</span>
          <span class="sched-prompt-tile-sub">Anthropic</span>
        </span>
        <span class="sched-prompt-pill sched-prompt-pill--active">Ready</span>
      </button>
      <button class="sched-prompt-tile disabled" style="--provider-color:${opencodeMeta.color};" disabled aria-disabled="true">
        <span class="sched-prompt-tile-logo" aria-hidden="true">${opencodeMeta.icon}</span>
        <span class="sched-prompt-tile-body">
          <span class="sched-prompt-tile-title">${opencodeMeta.label}</span>
          <span class="sched-prompt-tile-sub">Multi-provider</span>
        </span>
        <span class="sched-prompt-pill">Planned</span>
      </button>
      <button class="sched-prompt-tile disabled" style="--provider-color:${codexMeta.color};" disabled aria-disabled="true">
        <span class="sched-prompt-tile-logo" aria-hidden="true">${codexMeta.icon}</span>
        <span class="sched-prompt-tile-body">
          <span class="sched-prompt-tile-title">Codex CLI</span>
          <span class="sched-prompt-tile-sub">OpenAI</span>
        </span>
        <span class="sched-prompt-pill">Planned</span>
      </button>
    </div>
  `;
  _promptModal.addEventListener('click', handlePromptModalClick);
  document.body.appendChild(_promptModal);

  _promptKeyHandler = (e) => { if (e.key === 'Escape') closePromptScheduleModal(); };
  document.addEventListener('keydown', _promptKeyHandler);

  requestAnimationFrame(() => {
    _promptBackdrop?.classList.add('open');
    _promptModal?.classList.add('open');
    _promptModal?.querySelector('.sched-prompt-tile:not(.disabled)')?.focus();
  });
}

function handlePromptModalClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !_promptModal?.contains(el)) return;
  const action = el.dataset.action;
  if (action === 'prompt-modal-close') {
    closePromptScheduleModal();
  } else if (action === 'prompt-modal-pick') {
    handlePromptPick(el.dataset.runtime, el);
  }
}

function closePromptScheduleModal() {
  if (_promptKeyHandler) {
    document.removeEventListener('keydown', _promptKeyHandler);
    _promptKeyHandler = null;
  }
  _promptBackdrop?.remove();
  _promptModal?.remove();
  _promptBackdrop = null;
  _promptModal = null;
}

async function handlePromptPick(runtime, triggerEl = null) {
  if (runtime !== 'claude-code') {
    showToast('Coming soon — Claude Code only for now');
    return;
  }
  if (triggerEl) {
    triggerEl.disabled = true;
    triggerEl.setAttribute('aria-busy', 'true');
  }
  try {
    await sendToPanel('/synabun schedule', { newTab: true, tabLabel: 'Schedule Wizard', autoSubmit: true });
  } catch (err) {
    showToast('Failed to open Claude panel: ' + err.message);
  } finally {
    closePromptScheduleModal();
  }
}

async function moveGroup(id, direction) {
  const idx = _groups.findIndex(g => g.id === id);
  const next = idx + direction;
  if (idx < 0 || next < 0 || next >= _groups.length) return;
  const copy = [..._groups];
  const [moved] = copy.splice(idx, 1);
  copy.splice(next, 0, moved);
  try {
    await reorderScheduleGroups(copy.map(g => g.id));
    _groups = copy.map((g, i) => ({ ...g, order: i }));
    render();
  } catch (err) {
    showToast('Reorder failed: ' + err.message);
  }
}

async function createQuickTimerFromForm(runNow) {
  const templateId = $('sched-qt-template')?.value;
  if (!templateId) { showToast('Select an automation first'); return; }
  const customVal = Number($('sched-qt-custom-min')?.value);
  const minutes = customVal >= 1 ? customVal : _selectedQtMinutes;
  if (!runNow && !minutes) { showToast('Select a time or enter minutes'); return; }
  const template = getTemplate(templateId);
  const profile = $('sched-qt-profile')?.value || 'claude-code';
  const model = $('sched-qt-model')?.value || null;
  const effortRaw = $('sched-qt-effort')?.value || null;
  const effort = normalizeEffortForProfile(profile, effortRaw);
  const mcpProfile = profile !== 'claude-code' ? ($('sched-qt-mcp')?.value || _launchMcpProfile || null) : null;
  const codexAccountId = profile === 'codex' ? ($('sched-qt-account')?.value || _launchAccount || 'default') : undefined;
  const usesBrowser = _qtUsesBrowser !== null ? _qtUsesBrowser : !!template?.usesBrowser;
  try {
    if (runNow) {
      const result = await triggerQuickTimerNow(templateId, {
        profile, model, effort, mcpProfile, usesBrowser, codexAccountId,
        sidepanelWindowId: getNativeLoopRouterWindowId(),
        sidepanelClaimToken: getNativeLoopRouterClaimToken(),
      });
      showToast(`Running now: ${result.templateName}`);
    } else {
      const result = await createQuickTimer(templateId, minutes, { profile, model, effort, mcpProfile, usesBrowser, codexAccountId });
      if (!_quickTimers.some(t => t.id === result.timerId)) {
        _quickTimers.push({ id: result.timerId, templateId, templateName: result.templateName, firesAt: result.firesAt, minutes: result.minutes, profile: result.profile, model: result.model, effort: result.effort, mcpProfile: result.mcpProfile, usesBrowser: result.usesBrowser });
      }
      _selectedQtMinutes = null;
      showToast(`Timer set: ${result.templateName}`);
    }
    renderTimersTab();
  } catch (err) {
    showToast((runNow ? 'Run now' : 'Timer') + ' failed: ' + err.message);
  }
}

async function cancelQuickTimerById(id) {
  try {
    await cancelQuickTimer(id);
    _quickTimers = _quickTimers.filter(t => t.id !== id);
    renderTimersTab();
    showToast('Timer cancelled');
  } catch (err) {
    showToast('Cancel failed: ' + err.message);
  }
}

async function createExistingScheduleTimer() {
  const scheduleId = $('sched-existing-timer-schedule')?.value;
  const minutes = Number($('sched-existing-timer-min')?.value);
  if (!scheduleId) { showToast('Select a schedule'); return; }
  if (!minutes || minutes < 1) { showToast('Enter minutes'); return; }
  try {
    const result = await startScheduleTimer(scheduleId, minutes);
    _scheduleTimerData[scheduleId] = { firesAt: result.firesAt, minutes: result.minutes };
    renderTimersTab();
    showToast('Schedule timer set');
  } catch (err) {
    showToast('Timer failed: ' + err.message);
  }
}

async function cancelExistingScheduleTimer(id) {
  try {
    await cancelScheduleTimer(id);
    delete _scheduleTimerData[id];
    renderTimersTab();
    showToast('Timer cancelled');
  } catch (err) {
    showToast('Cancel failed: ' + err.message);
  }
}

function updateTimerCountdowns() {
  _panel?.querySelectorAll('.sched-active-timer').forEach(row => {
    const button = row.querySelector('[data-action="qt-cancel"], [data-action="schedule-timer-cancel"]');
    const id = button?.dataset.id;
    let timer = _quickTimers.find(t => t.id === id);
    if (!timer) timer = _scheduleTimerData[id];
    const strong = row.querySelector('strong');
    if (timer && strong) strong.textContent = formatTimerCountdown(timer.firesAt);
  });
  _panel?.querySelectorAll('[data-countdown]').forEach(el => {
    const iso = el.dataset.countdown;
    el.textContent = formatNextRun(iso || null);
  });
}

function setupSync() {
  if (_syncReady) return;
  _syncReady = true;

  on('sync:schedule:created', (data) => {
    if (!data?.schedule) return;
    if (!_schedules.some(s => s.id === data.schedule.id)) _schedules.push(data.schedule);
    if (_panel) render();
  });
  on('sync:schedule:updated', (data) => {
    if (!data?.schedule) return;
    const idx = _schedules.findIndex(s => s.id === data.schedule.id);
    if (idx >= 0) _schedules[idx] = data.schedule;
    else _schedules.push(data.schedule);
    if (_panel) render();
  });
  on('sync:schedule:deleted', (data) => {
    if (!data?.scheduleId) return;
    _schedules = _schedules.filter(s => s.id !== data.scheduleId);
    if (_panel) render();
  });
  on('sync:schedule:fired', (data) => {
    if (data?.scheduleName) showToast(`Schedule fired: ${data.scheduleName}`);
  });
  on('sync:schedule:completed', (data) => {
    loadData().then(() => { if (_panel) render(); });
    if (data?.terminalSessionId && data.surface !== 'sidepanel') {
      emit('terminal:attach-floating', {
        terminalSessionId: data.terminalSessionId,
        profile: data.profile || 'claude-code',
        snapToPanel: false,
      });
    }
  });
  on('sync:schedule:failed', (data) => {
    if (data?.reason) showToast(`Schedule failed: ${data.reason}`);
    loadData().then(() => { if (_panel) render(); });
  });
  on('sync:schedule:timer-set', (data) => {
    if (data?.scheduleId && data?.firesAt) {
      _scheduleTimerData[data.scheduleId] = { firesAt: data.firesAt, minutes: data.minutes };
      if (_panel && _tab === 'timers') renderTimersTab();
    }
  });
  on('sync:schedule:timer-fired', (data) => {
    if (data?.scheduleName) showToast(`Timer fired: ${data.scheduleName}`);
    if (data?.scheduleId) delete _scheduleTimerData[data.scheduleId];
    if (_panel) render();
  });
  on('sync:schedule:timer-cancelled', (data) => {
    if (data?.scheduleId) delete _scheduleTimerData[data.scheduleId];
    if (_panel && _tab === 'timers') renderTimersTab();
  });
  on('sync:schedule-group:created', (data) => {
    if (data?.group && !_groups.some(g => g.id === data.group.id)) _groups.push(data.group);
    if (_panel) render();
  });
  on('sync:schedule-group:updated', (data) => {
    if (!data?.group) return;
    const idx = _groups.findIndex(g => g.id === data.group.id);
    if (idx >= 0) _groups[idx] = data.group;
    else _groups.push(data.group);
    if (_panel) render();
  });
  on('sync:schedule-group:deleted', (data) => {
    if (!data?.groupId) return;
    _groups = _groups.filter(g => g.id !== data.groupId);
    for (const schedule of _schedules) if (schedule.groupId === data.groupId) schedule.groupId = null;
    if (_selectedGroup === data.groupId) _selectedGroup = 'ungrouped';
    if (_panel) render();
  });
  on('sync:schedule-group:reordered', (data) => {
    if (Array.isArray(data?.groups)) _groups = data.groups;
    if (_panel) render();
  });
  on('sync:quick-timer:set', (data) => {
    if (data?.timerId && !_quickTimers.some(t => t.id === data.timerId)) {
      _quickTimers.push({ id: data.timerId, templateName: data.templateName, firesAt: data.firesAt, minutes: data.minutes, profile: data.profile, model: data.model, effort: data.effort, mcpProfile: data.mcpProfile, usesBrowser: data.usesBrowser });
      if (_panel && _tab === 'timers') renderTimersTab();
    }
  });
  on('sync:quick-timer:fired', (data) => {
    if (data?.templateName) showToast(`Timer fired: ${data.templateName}`);
    if (data?.timerId) _quickTimers = _quickTimers.filter(t => t.id !== data.timerId);
    if (_panel && _tab === 'timers') renderTimersTab();
  });
  on('sync:quick-timer:fired-now', (data) => {
    if (data?.templateName) showToast(`Running now: ${data.templateName}`);
  });
  on('sync:quick-timer:cancelled', (data) => {
    if (data?.timerId) _quickTimers = _quickTimers.filter(t => t.id !== data.timerId);
    if (_panel && _tab === 'timers') renderTimersTab();
  });
  on('sync:quick-timer:failed', (data) => {
    if (data?.reason) showToast(`Timer failed: ${data.reason}`);
  });
}
