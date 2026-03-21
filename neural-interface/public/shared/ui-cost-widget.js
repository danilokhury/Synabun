// ═══════════════════════════════════════════
// UI-COST-WIDGET — Cost tracker (dockable + floating)
// ═══════════════════════════════════════════
//
// Glass panel showing cost breakdown with daily bar chart,
// filter tabs, and drag/collapse persistence.
// Can dock to navbar (next to ?) or float freely.

import { on, emit } from './state.js';
import { KEYS } from './constants.js';
import { storage } from './storage.js';

// ── State ──

let _widget = null;        // Root DOM element
let _costData = null;      // Cached API response
let _activeTab = 'today';  // 'today' | 'month' | 'last30' | 'all'
let _collapsed = false;
let _drag = null;
let _pinnedOpen = false;   // Toggled open from Claude Panel (independent of focus mode)
let _docked = false;       // Docked to navbar

// ── Init ──

export function initCostWidget() {
  const container = document.getElementById('static-bg');
  console.log('[cost-widget] init, container:', !!container);
  if (!container) return;

  _collapsed = storage.getItem(KEYS.COST_WIDGET_COLLAPSED) === 'true';
  _docked = storage.getItem(KEYS.COST_WIDGET_DOCKED) === 'true';

  _widget = document.createElement('div');
  _widget.id = 'cost-widget';
  _widget.className = 'glass cost-widget' + (_collapsed ? ' collapsed' : '') + (_docked ? ' cw-docked' : '');

  // Restore position or default to bottom-right (clamped to viewport)
  if (!_docked) {
    const savedPos = _loadPos();
    if (savedPos) {
      const maxLeft = window.innerWidth - 270;
      const maxTop = window.innerHeight - 60;
      _widget.style.left = Math.max(0, Math.min(savedPos.left, maxLeft)) + 'px';
      _widget.style.top = Math.max(0, Math.min(savedPos.top, maxTop)) + 'px';
    } else {
      _widget.style.right = '24px';
      _widget.style.bottom = '24px';
    }
  }

  _widget.innerHTML = `
    <div class="cw-header">
      <span class="cw-drag" title="Drag to undock and move">⠿</span>
      <span class="cw-total">$0.00</span>
      <span class="cw-month-label"></span>
      <button class="cw-scan" title="Scan CLI sessions">⟳</button>
      <button class="cw-collapse" title="Collapse">${_collapsed ? '▸' : '▾'}</button>
    </div>
    <div class="cw-body">
      <div class="cw-tabs">
        <button class="cw-tab active" data-tab="today">Today</button>
        <button class="cw-tab" data-tab="month">Month</button>
        <button class="cw-tab" data-tab="last30">30d</button>
        <button class="cw-tab" data-tab="all">All</button>
      </div>
      <div class="cw-chart"></div>
      <div class="cw-list"></div>
      <div class="cw-footer"></div>
    </div>
  `;

  document.body.appendChild(_widget);

  // Show/hide based on current state
  const focusOn = container.classList.contains('visible');
  if (_docked) {
    _widget.style.display = 'none'; // starts hidden, toggled by navbar click
  } else {
    _widget.style.display = focusOn ? '' : 'none';
  }

  // Events
  _widget.querySelector('.cw-collapse').addEventListener('click', _toggleCollapse);
  _widget.querySelector('.cw-scan').addEventListener('click', _scanCliSessions);
  _widget.querySelector('.cw-tabs').addEventListener('click', _onTabClick);
  _makeDraggable(_widget.querySelector('.cw-header'));

  // Close docked widget when clicking outside
  document.addEventListener('mousedown', (e) => {
    if (!_docked || !_widget || _widget.style.display === 'none') return;
    const costBtn = document.getElementById('titlebar-cost-btn');
    if (_widget.contains(e.target) || costBtn?.contains(e.target)) return;
    _widget.style.display = 'none';
    _pinnedOpen = false;
  });

  // Listen for focus mode changes
  on('viz:toggle', (vizEnabled) => {
    if (_docked) return; // dock mode ignores focus mode
    // vizEnabled=false means focus mode is ON
    if (_widget) {
      if (!vizEnabled) { _widget.style.display = ''; _pinnedOpen = false; }
      else if (!_pinnedOpen) _widget.style.display = 'none';
    }
    if (!vizEnabled) _fetchAndRender();
  });

  // Toggle from Claude Panel cost label (floating mode)
  on('cost:toggle', () => {
    if (!_widget || _docked) return;
    _pinnedOpen = !_pinnedOpen;
    _widget.style.display = _pinnedOpen ? '' : 'none';
    if (_pinnedOpen) _fetchAndRender();
  });

  // Toggle from navbar button (dock mode)
  on('cost:dock-toggle', () => {
    if (!_widget) return;
    if (!_docked) {
      // First click docks it
      _dock();
      _pinnedOpen = true;
      _widget.style.display = '';
      _fetchAndRender();
    } else {
      // Already docked — toggle visibility
      _pinnedOpen = !_pinnedOpen;
      _widget.style.display = _pinnedOpen ? '' : 'none';
      if (_pinnedOpen) {
        _positionDocked();
        _fetchAndRender();
      }
    }
  });

  // Real-time cost updates from Claude Panel
  on('cost:updated', (data) => {
    if (!_costData || !data) return;
    _optimisticUpdate(data.amount);
  });

  // Emit initial dock state for navbar button
  emit('cost:dock-state', _docked);

  // Initial fetch if already in focus mode or docked
  if (_docked) { _positionDocked(); _fetchAndRender(); }
  else if (focusOn) _fetchAndRender();
}

// ── Dock / Undock ──

function _dock() {
  _docked = true;
  storage.setItem(KEYS.COST_WIDGET_DOCKED, 'true');
  _widget.classList.add('cw-docked');
  // Clear inline position styles — CSS handles docked positioning
  _widget.style.left = '';
  _widget.style.top = '';
  _widget.style.right = '';
  _widget.style.bottom = '';
  _positionDocked();
  emit('cost:dock-state', true);
}

function _undock() {
  _docked = false;
  storage.setItem(KEYS.COST_WIDGET_DOCKED, 'false');
  _widget.classList.remove('cw-docked');
  emit('cost:dock-state', false);
}

function _positionDocked() {
  const anchor = document.getElementById('titlebar-cost-btn');
  if (!anchor || !_widget) return;
  const rect = anchor.getBoundingClientRect();
  _widget.style.top = (rect.bottom + 6) + 'px';
  _widget.style.right = (window.innerWidth - rect.right) + 'px';
  _widget.style.left = '';
  _widget.style.bottom = '';
}

// ── Data ──

async function _fetchAndRender() {
  try {
    const res = await fetch('/api/claude-skin/cost');
    if (!res.ok) return;
    _costData = await res.json();
    _render();
  } catch {}
}

function _optimisticUpdate(amount) {
  if (!_costData || typeof amount !== 'number') return;
  const month = _costData.month;
  if (!month) return;
  month.totalUsd = Math.round((month.totalUsd + amount) * 1e6) / 1e6;
  month.queries = (month.queries || 0) + 1;
  // Update daily
  if (!month.days) month.days = {};
  const day = new Date().getDate().toString().padStart(2, '0');
  if (!month.days[day]) month.days[day] = { totalUsd: 0, queries: 0 };
  month.days[day].totalUsd = Math.round((month.days[day].totalUsd + amount) * 1e6) / 1e6;
  month.days[day].queries += 1;
  // Also update history
  if (_costData.history && _costData.currentMonth) {
    _costData.history[_costData.currentMonth] = month;
  }
  _render();
  // Flash the total
  const total = _widget?.querySelector('.cw-total');
  if (total) { total.classList.add('flash'); setTimeout(() => total.classList.remove('flash'), 800); }
}

// ── Render ──

function _render() {
  if (!_widget || !_costData) return;

  const prepared = _prepareData();
  const { dataPoints, listRows, totalUsd, label, avgPerDay, projected } = prepared;

  // Header
  _widget.querySelector('.cw-total').textContent = '$' + totalUsd.toFixed(2);
  _widget.querySelector('.cw-month-label').textContent = label;

  // Chart
  _renderBarChart(_widget.querySelector('.cw-chart'), dataPoints);

  // List
  _renderList(_widget.querySelector('.cw-list'), listRows);

  // Footer
  const footer = _widget.querySelector('.cw-footer');
  const parts = [];
  if (prepared.queries != null) parts.push(`${prepared.queries} queries`);
  if (avgPerDay != null) parts.push(`avg $${avgPerDay.toFixed(2)}/day`);
  if (projected != null) parts.push(`~$${projected.toFixed(0)}/mo`);
  footer.textContent = parts.join('  ·  ');

  // Session count in header tooltip
  const totalEl = _widget.querySelector('.cw-total');
  if (totalEl && _costData) {
    const currentMonth = _costData.currentMonth;
    const month = _costData.history?.[currentMonth] || _costData.month;
    const sessions = month?.sessions?.length || 0;
    totalEl.title = `${sessions} sessions · ${month?.queries || 0} queries`;
  }

  // Navbar cost label is managed by ui-claude-panel._updateCostLabel() (session cost)
}

function _prepareData() {
  const history = _costData.history || {};
  const currentMonth = _costData.currentMonth;

  if (_activeTab === 'today') {
    return _prepareTodayData(history[currentMonth] || _costData.month);
  } else if (_activeTab === 'month') {
    return _prepareMonthData(history[currentMonth] || _costData.month, currentMonth);
  } else if (_activeTab === 'last30') {
    return _prepareLast30Data(history);
  } else {
    return _prepareAllData(history);
  }
}

function _prepareTodayData(month) {
  const now = new Date();
  const dayKey = now.getDate().toString().padStart(2, '0');
  const today = month?.days?.[dayKey] || { totalUsd: 0, queries: 0 };
  const totalUsd = today.totalUsd || 0;
  const queries = today.queries || 0;
  const dateLabel = now.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });

  // Show last 7 days as bar chart for context
  const dataPoints = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const mk = d.toISOString().slice(0, 7);
    const dk = d.getDate().toString().padStart(2, '0');
    const mData = _costData.history?.[mk];
    const val = mData?.days?.[dk]?.totalUsd || 0;
    const q = mData?.days?.[dk]?.queries || 0;
    const dayLabel = d.toLocaleDateString('en', { weekday: 'short' }).slice(0, 2);
    dataPoints.push({
      label: dayLabel,
      value: val,
      queries: q,
      tooltip: `$${val.toFixed(2)} · ${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })}`,
      highlight: i === 0,
    });
  }

  return {
    dataPoints,
    listRows: [],
    totalUsd,
    label: dateLabel,
    queries,
    avgPerDay: null,
    projected: null,
  };
}

function _prepareMonthData(month, monthKey) {
  const days = month?.days || {};
  const now = new Date();
  const year = parseInt(monthKey?.slice(0, 4) || now.getFullYear());
  const mo = parseInt(monthKey?.slice(5, 7) || (now.getMonth() + 1));
  const daysInMonth = new Date(year, mo, 0).getDate();
  const todayDay = now.getDate().toString().padStart(2, '0');
  const monthLabel = new Date(year, mo - 1).toLocaleString('en', { month: 'short', year: 'numeric' });

  const dataPoints = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = d.toString().padStart(2, '0');
    const val = days[key]?.totalUsd || 0;
    dataPoints.push({
      label: d.toString(),
      value: val,
      queries: days[key]?.queries || 0,
      tooltip: `$${val.toFixed(2)} on ${monthLabel.split(' ')[0]} ${d}`,
      highlight: key === todayDay,
    });
  }

  const totalUsd = month?.totalUsd || 0;
  const activeDays = Object.keys(days).length || 1;
  const avgPerDay = totalUsd / activeDays;
  const dayOfMonth = now.getDate();
  const projected = (totalUsd / dayOfMonth) * daysInMonth;

  // List rows — most recent days first
  const listRows = Object.entries(days)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 10)
    .map(([d, data]) => ({
      label: `${monthLabel.split(' ')[0]} ${parseInt(d)}`,
      cost: data.totalUsd,
      queries: data.queries,
    }));

  return { dataPoints, listRows, totalUsd, label: monthLabel, avgPerDay, projected };
}

function _prepareLast30Data(history) {
  const now = new Date();
  const dataPoints = [];
  const listRows = [];
  let total = 0;

  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const monthKey = d.toISOString().slice(0, 7);
    const dayKey = d.getDate().toString().padStart(2, '0');
    const month = history[monthKey];
    const val = month?.days?.[dayKey]?.totalUsd || 0;
    const queries = month?.days?.[dayKey]?.queries || 0;
    total += val;

    const dayLabel = `${d.getMonth() + 1}/${d.getDate()}`;
    dataPoints.push({
      label: i % 5 === 0 ? dayLabel : '',
      value: val,
      queries,
      tooltip: `$${val.toFixed(2)} on ${dayLabel}`,
      highlight: i === 0,
    });

    if (val > 0) {
      listRows.push({
        label: d.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
        cost: val,
        queries,
      });
    }
  }

  const activeDays = dataPoints.filter(p => p.value > 0).length || 1;
  const avgPerDay = total / activeDays;

  return {
    dataPoints,
    listRows: listRows.slice(0, 10),
    totalUsd: Math.round(total * 1e6) / 1e6,
    label: 'Last 30 days',
    avgPerDay,
    projected: avgPerDay * 30,
  };
}

function _prepareAllData(history) {
  const months = Object.entries(history).sort((a, b) => a[0].localeCompare(b[0]));
  let total = 0;
  let totalQueries = 0;

  const dataPoints = months.map(([key, data]) => {
    const val = data.totalUsd || 0;
    total += val;
    totalQueries += data.queries || 0;
    const [y, m] = key.split('-');
    const label = new Date(parseInt(y), parseInt(m) - 1).toLocaleString('en', { month: 'short' });
    return {
      label,
      value: val,
      queries: data.queries || 0,
      tooltip: `$${val.toFixed(2)} in ${label} ${y}`,
      highlight: key === new Date().toISOString().slice(0, 7),
    };
  });

  const listRows = months.reverse().slice(0, 10).map(([key, data]) => {
    const [y, m] = key.split('-');
    return {
      label: new Date(parseInt(y), parseInt(m) - 1).toLocaleString('en', { month: 'short', year: 'numeric' }),
      cost: data.totalUsd || 0,
      queries: data.queries || 0,
    };
  });

  return {
    dataPoints,
    listRows,
    totalUsd: Math.round(total * 1e6) / 1e6,
    label: 'All time',
    avgPerDay: null,
    projected: null,
  };
}

// ── Bar Chart (SVG) ──

function _renderBarChart(container, dataPoints) {
  if (!container) return;
  const W = 230, H = 72, PAD_BOTTOM = 14, PAD_TOP = 4;
  const chartH = H - PAD_BOTTOM - PAD_TOP;
  const barCount = dataPoints.length;
  if (barCount === 0) { container.innerHTML = ''; return; }

  const maxVal = Math.max(...dataPoints.map(p => p.value), 0.01);
  const barW = Math.max(2, Math.min(8, (W - 8) / barCount - 1));
  const gap = Math.max(1, ((W - 8) - barW * barCount) / barCount);
  const totalW = barCount * (barW + gap);
  const offsetX = (W - totalW) / 2;

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;

  // Bars
  dataPoints.forEach((p, i) => {
    const x = offsetX + i * (barW + gap);
    const h = Math.max(1, (p.value / maxVal) * chartH);
    const y = PAD_TOP + chartH - h;
    const fill = p.highlight ? 'var(--accent-gold)' : 'var(--accent-blue)';
    const opacity = p.value > 0 ? (p.highlight ? 0.9 : 0.6) : 0.15;
    const rx = Math.min(barW / 2, 2);
    svg += `<rect class="cw-bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="${rx}" fill="${fill}" opacity="${opacity}" data-idx="${i}"><title>${p.tooltip}</title></rect>`;

    // X-axis labels (sparse)
    if (p.label) {
      svg += `<text x="${x + barW / 2}" y="${H - 1}" text-anchor="middle" fill="var(--t-faint)" font-size="7" font-family="'JetBrains Mono', monospace">${p.label}</text>`;
    }
  });

  svg += '</svg>';
  container.innerHTML = svg;
}

// ── List ──

function _renderList(container, rows) {
  if (!container) return;
  if (rows.length === 0) {
    container.innerHTML = '<div class="cw-empty">No data yet</div>';
    return;
  }
  container.innerHTML = rows.map(r =>
    `<div class="cw-row">
      <span class="cw-row-label">${r.label}</span>
      <span class="cw-row-cost">$${r.cost.toFixed(2)}</span>
      <span class="cw-row-queries">${r.queries}q</span>
    </div>`
  ).join('');
}

// ── CLI Scan ──

async function _scanCliSessions() {
  const btn = _widget?.querySelector('.cw-scan');
  if (!btn) return;
  btn.classList.add('spinning');
  btn.disabled = true;
  try {
    const res = await fetch('/api/claude-skin/cost/scan', { method: 'POST' });
    const data = await res.json();
    if (data.added > 0) {
      // Refetch to get updated totals
      await _fetchAndRender();
      const total = _widget?.querySelector('.cw-total');
      if (total) { total.classList.add('flash'); setTimeout(() => total.classList.remove('flash'), 800); }
    }
  } catch {} finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
}

// ── Tabs ──

function _onTabClick(e) {
  const btn = e.target.closest('.cw-tab');
  if (!btn) return;
  const tab = btn.dataset.tab;
  if (tab === _activeTab) return;
  _activeTab = tab;
  _widget.querySelectorAll('.cw-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  _render();
}

// ── Collapse ──

function _toggleCollapse() {
  _collapsed = !_collapsed;
  _widget.classList.toggle('collapsed', _collapsed);
  _widget.querySelector('.cw-collapse').textContent = _collapsed ? '▸' : '▾';
  storage.setItem(KEYS.COST_WIDGET_COLLAPSED, _collapsed ? 'true' : 'false');
}

// ── Drag ──

function _makeDraggable(header) {
  header.style.cursor = 'grab';

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.cw-collapse') || e.target.closest('.cw-scan')) return;
    e.preventDefault();

    // If docked, undock on drag
    if (_docked) _undock();

    const rect = _widget.getBoundingClientRect();
    _drag = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top,
    };
    header.style.cursor = 'grabbing';

    // Reset right/bottom positioning and switch to left/top
    _widget.style.right = 'auto';
    _widget.style.bottom = 'auto';
    _widget.style.left = _drag.origLeft + 'px';
    _widget.style.top = _drag.origTop + 'px';

    const onMove = (ev) => {
      if (!_drag) return;
      const dx = ev.clientX - _drag.startX;
      const dy = ev.clientY - _drag.startY;
      let newLeft = _drag.origLeft + dx;
      let newTop = _drag.origTop + dy;
      // Constrain to viewport
      const ww = _widget.offsetWidth;
      const wh = _widget.offsetHeight;
      newLeft = Math.max(0, Math.min(window.innerWidth - ww, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - wh, newTop));
      _widget.style.left = newLeft + 'px';
      _widget.style.top = newTop + 'px';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      header.style.cursor = 'grab';
      if (_drag) {
        _savePos(parseInt(_widget.style.left), parseInt(_widget.style.top));
        _drag = null;
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Persistence ──

function _loadPos() {
  try {
    const raw = storage.getItem(KEYS.COST_WIDGET_POS);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    return (typeof pos.left === 'number' && typeof pos.top === 'number') ? pos : null;
  } catch { return null; }
}

function _savePos(left, top) {
  storage.setItem(KEYS.COST_WIDGET_POS, JSON.stringify({ left, top }));
}
