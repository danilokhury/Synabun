import { on, emit } from './state.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

let _open = false;
let _pollTimer = null;
let _data = { running: [], queued: [], deferred: [], upcoming: [] };

const POLL_MS = 5000;

function formatCountdown(nextRun) {
  if (!nextRun) return 'N/A';
  const diffMs = new Date(nextRun) - Date.now();
  if (diffMs <= 0) return 'Overdue';
  const totalSec = Math.floor(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

function gaugePercent(nextRun) {
  if (!nextRun) return 0;
  const diffMs = new Date(nextRun) - Date.now();
  if (diffMs <= 0) return 100;
  const maxWindow = 60 * 60 * 1000;
  return Math.min(100, Math.max(0, 100 - (diffMs / maxWindow) * 100));
}

function dot(color) {
  if (!color) return '';
  return `<span class="sq-dot" style="background:${esc(color)}"></span>`;
}

function renderSection(title, items, renderer) {
  if (!items?.length) return '';
  return `<div class="sq-section"><div class="sq-section-header"><span class="sq-section-title">${title}</span><span class="sq-section-count">${items.length}</span></div><div class="sq-items">${items.map(renderer).join('')}</div></div>`;
}

function renderRunningItem(r) {
  return `<div class="sq-item sq-item--running">${dot(r.groupColor)}<span class="sq-name">${esc(r.scheduleName)}</span><span class="sq-meta">${r.elapsedMin}m/${r.maxMinutes}m</span></div>`;
}

function renderDeferredItem(d) {
  return `<div class="sq-item sq-item--deferred">${dot(d.groupColor)}<span class="sq-name">${esc(d.name)}</span><span class="sq-meta sq-meta--warn">${d.deferredMin}m</span></div>`;
}

function renderUpcomingItem(u) {
  return `<div class="sq-item">${dot(u.groupColor)}<span class="sq-name">${esc(u.name)}</span><span class="sq-meta">${formatCountdown(u.nextRun)}</span></div>`;
}

function render() {
  const main = $('sq-main');
  if (!main) return;

  const next = _data.upcoming?.[0];
  const pct = next ? gaugePercent(next.nextRun) : 0;
  const hasAnything = _data.running.length || _data.deferred.length || _data.upcoming.length;

  let html = '';

  if (next) {
    html += `<div class="sq-next"><div class="sq-next-bar" style="width:${pct}%"></div><div class="sq-next-label">${dot(next.groupColor)}Next: <strong>${esc(next.name)}</strong> in ${formatCountdown(next.nextRun)}</div></div>`;
  }

  html += renderSection('Running', _data.running, renderRunningItem);
  html += renderSection('Blocked', _data.deferred, renderDeferredItem);
  const upList = next ? _data.upcoming.slice(1) : _data.upcoming;
  html += renderSection('Upcoming', upList, renderUpcomingItem);

  if (!hasAnything) {
    html = '<div class="sq-empty">No scheduled activity</div>';
  }

  main.innerHTML = html;
  updateBadge();
}

function updateBadge() {
  const badge = $('titlebar-queue-count');
  if (!badge) return;
  const count = _data.running.length + _data.deferred.length;
  badge.textContent = count;
  badge.hidden = count === 0;
}

async function fetchQueue() {
  try {
    const res = await fetch('/api/schedules/queue');
    if (!res.ok) return;
    _data = await res.json();
  } catch { /* silent */ }
}

let _lastDataJson = '';

async function poll() {
  if (document.hidden) return;
  await fetchQueue();
  // Re-render only when the queue actually changed — the steady state of an
  // open dropdown is "nothing changed" and a full render every tick is waste
  const json = JSON.stringify(_data);
  const changed = json !== _lastDataJson;
  _lastDataJson = json;
  if (_open && changed) render();
  else if (!_open) updateBadge();
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function openDropdown() {
  const dd = $('schedule-queue-dropdown');
  if (!dd) return;
  emit('panel:close-all-dropdowns');
  dd.style.display = '';
  _open = true;
  const btn = $('titlebar-queue-btn');
  if (btn) btn.classList.add('active');
  fetchQueue().then(render);
  startPolling();
}

function closeDropdown() {
  const dd = $('schedule-queue-dropdown');
  if (!dd) return;
  dd.style.display = 'none';
  _open = false;
  stopPolling();
  const btn = $('titlebar-queue-btn');
  if (btn) btn.classList.remove('active');
  emit('schedule-queue:closed');
}

export function toggleScheduleQueue() {
  if (_open) closeDropdown();
  else openDropdown();
}

function setupSync() {
  on('sync:schedule:fired', () => poll());
  on('sync:schedule:completed', () => poll());
  on('sync:schedule:failed', () => poll());
  on('sync:schedule:deferred', () => poll());
  on('sync:schedule:deferred-expired', () => poll());
}

export function initScheduleQueue() {
  setupSync();
  fetchQueue().then(updateBadge);
  setInterval(() => { if (!_open && !document.hidden) fetchQueue().then(updateBadge); }, 60_000);

  document.addEventListener('click', (e) => {
    if (_open && !e.target.closest('#schedule-queue-overlay')) closeDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _open) closeDropdown();
  });
  on('panel:close-all-dropdowns', () => { if (_open) closeDropdown(); });
  on('panel:close-all-dropdowns-except', (name) => {
    if (name !== 'schedule-queue' && _open) closeDropdown();
  });
}
