// ═══════════════════════════════════════════
// SynaBun Neural Interface — CLI Tool Update Badges
// Checks /api/system/tool-versions and shows green badges
// on toolbar buttons + Apps menu items when updates exist.
// Only clicking the tiny green badge runs the update command; the
// normal toolbar/menu target keeps launching the selected CLI.
// ═══════════════════════════════════════════

import { emit } from './state.js';

const $ = (id) => document.getElementById(id);

const TOOL_ELEMENTS = {
  'claude-code': { toolbar: 'claude-update-badge',   menu: 'claude-menu-update-badge' },
  'codex':       { toolbar: 'codex-update-badge',    menu: 'codex-menu-update-badge' },
  'opencode':    { toolbar: 'opencode-update-badge', menu: 'opencode-menu-update-badge' },
  'gemini':      { toolbar: null,                    menu: 'gemini-menu-update-badge' },
};

// Parent elements whose tooltips are updated when an update badge is visible.
const PARENT_ELEMENTS = {
  'claude-code': { toolbar: 'topright-claude-panel-btn', menu: 'menu-terminal-claude' },
  'codex':       { toolbar: 'topright-codex-panel-btn',  menu: 'menu-terminal-codex' },
  'opencode':    { toolbar: 'topright-opencode-panel-btn', menu: 'menu-terminal-opencode' },
  'gemini':      { toolbar: null,                         menu: 'menu-terminal-gemini' },
};

const TOOL_LABELS = {
  'claude-code': 'Claude Code',
  'codex':       'Codex',
  'opencode':    'OpenCode',
  'gemini':      'Gemini CLI',
};

// Cached server response so click handlers can read per-tool updateCommand
// without re-fetching. Refreshed on every applyBadges() call.
let _latestData = null;

// Reads better than the raw source key — "update via Homebrew", not
// "update via brew-cask". Mirrors installSourceLabel in
// lib/cli-update-planner.js (kept separate: that module is server-side).
const SOURCE_LABELS = {
  'brew-cask': 'Homebrew',
  'brew-formula': 'Homebrew',
  'npm': 'npm',
  'bun': 'Bun',
  'pnpm': 'pnpm',
  'yarn': 'Yarn',
  'volta': 'Volta',
  'standalone': 'the official installer',
  'native': 'the native installer',
  'winget': 'winget',
  'scoop': 'Scoop',
  'choco': 'Chocolatey',
};

function sourceLabel(src) {
  return SOURCE_LABELS[src] || 'your installer';
}

function runUpdate(key, badge) {
  const info = _latestData?.tools?.[key];
  const cmd = info?.updateCommand;

  if (!cmd) {
    // Tool installed via a source we can't safely auto-update from
    // (winget, native installer, etc.) and has no built-in self-updater.
    const label = TOOL_LABELS[key] || key;
    const hint = sourceLabel(info?.installSource);
    alert(`${label} update available (v${info?.installed} → v${info?.latest}).\n\nPlease update via ${hint}.`);
    return;
  }

  emit('terminal:run-command', { command: cmd, label: `Update ${TOOL_LABELS[key] || key}` });
  // Optimistically clear BOTH toolbar + menu badges and restore parent tooltips.
  const ids = TOOL_ELEMENTS[key];
  const parents = PARENT_ELEMENTS[key];
  for (const which of ['toolbar', 'menu']) {
    const b = ids?.[which] && $(ids[which]);
    if (b) b.textContent = '';
    const pBtn = parents?.[which] && $(parents[which]);
    if (pBtn?.dataset.tooltipOriginal) pBtn.dataset.tooltip = pBtn.dataset.tooltipOriginal;
  }
  // Poll repeatedly until the server confirms the new version is installed
  // (updateAvailable flips to false for this tool) or we hit the max window.
  // Native installer updates can take 1–3min; npm-global 5–60s.
  schedulePostUpdatePolling(key);
}

// Poll /api/system/tool-versions?force=1 until the specified tool reports
// updateAvailable=false, or a max window elapses. Safe to call repeatedly —
// latest call supersedes any prior poll loop for the same tool.
const _pollTimers = new Map();
function schedulePostUpdatePolling(key) {
  const prior = _pollTimers.get(key);
  if (prior) clearTimeout(prior);

  const startedAt = Date.now();
  const maxMs = 10 * 60 * 1000;
  const initialDelay = 10000;
  const interval = 10000;

  const tick = async () => {
    try {
      const res = await fetch('/api/system/tool-versions?force=1');
      if (res.ok) {
        const data = await res.json();
        applyBadges(data);
        const info = data?.tools?.[key];
        if (info && !info.updateAvailable) {
          _pollTimers.delete(key);
          return;
        }
      }
    } catch { /* ignore, will retry */ }

    if (Date.now() - startedAt >= maxMs) {
      _pollTimers.delete(key);
      return;
    }
    _pollTimers.set(key, setTimeout(tick, interval));
  };

  _pollTimers.set(key, setTimeout(tick, initialDelay));
}

function wireBadgeClick(badgeId, key) {
  const badge = $(badgeId);
  if (!badge) return;
  badge.classList.add('update-click-target');
  badge.addEventListener('click', (e) => {
    if (badge.textContent) {
      e.stopPropagation();
      e.preventDefault();
      runUpdate(key, badge);
    }
  });
}

function applyBadges(data) {
  if (!data.tools) return;
  _latestData = data;

  for (const [key, ids] of Object.entries(TOOL_ELEMENTS)) {
    const info = data.tools[key];
    const has = info && info.updateAvailable;
    const canUpdate = has && info?.canUpdate;
    const tip = has
      ? (canUpdate
          ? `v${info.installed} → v${info.latest} — click to update`
          : `v${info.installed} → v${info.latest} — update via ${sourceLabel(info.installSource)}`)
      : '';
    const parents = PARENT_ELEMENTS[key];

    if (ids.toolbar) {
      const badge = $(ids.toolbar);
      if (badge) {
        badge.textContent = has ? '↑' : '';
        badge.title = tip;
        if (has) badge.setAttribute('aria-label', `Update ${TOOL_LABELS[key] || key}`);
        else badge.removeAttribute('aria-label');
      }
      // Update parent button tooltip when update is available
      const parentBtn = parents?.toolbar && $(parents.toolbar);
      if (parentBtn) {
        if (!parentBtn.dataset.tooltipOriginal) parentBtn.dataset.tooltipOriginal = parentBtn.dataset.tooltip || '';
        parentBtn.dataset.tooltip = has ? `${parentBtn.dataset.tooltipOriginal} · update badge available` : parentBtn.dataset.tooltipOriginal;
      }
    }
    if (ids.menu) {
      const badge = $(ids.menu);
      if (badge) {
        badge.textContent = has ? '↑' : '';
        badge.title = tip;
        if (has) badge.setAttribute('aria-label', `Update ${TOOL_LABELS[key] || key}`);
        else badge.removeAttribute('aria-label');
      }
    }
  }
}

let _wired = false;

export async function initToolUpdates() {
  try {
    const res = await fetch('/api/system/tool-versions');
    if (!res.ok) return;
    applyBadges(await res.json());

    if (!_wired) {
      _wired = true;
      for (const [key, ids] of Object.entries(TOOL_ELEMENTS)) {
        if (ids.toolbar) wireBadgeClick(ids.toolbar, key);
        if (ids.menu) wireBadgeClick(ids.menu, key);
      }
    }
  } catch { /* silent */ }
}

export async function forceCheckToolUpdates() {
  try {
    const res = await fetch('/api/system/tool-versions?force=1');
    if (!res.ok) return null;
    const data = await res.json();
    applyBadges(data);
    return data;
  } catch { return null; }
}

// Re-export human-readable tool labels so toast/menu code can build summaries
// without redefining the label map.
export { TOOL_LABELS };

// Read-only accessor for the Notifications drawer. May be null until
// initToolUpdates() resolves the first /api/system/tool-versions call.
export function getToolUpdateData() {
  return _latestData;
}

// Public wrapper around runUpdate so external surfaces (Notifications drawer)
// can trigger the same flow used by the toolbar/menu badges.
export function runToolUpdate(key) {
  runUpdate(key);
}

// ── Update-check toast ──
// Bottom-right ephemeral pill. One of three modes: updates available (with
// list + optional click handler), all-clear, or check-failed. Auto-dismisses.

function _toastEsc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

export function showUpdateToast({ updates, errors, onClick } = {}) {
  document.querySelectorAll('.update-check-toast').forEach(el => el.remove());

  const toast = document.createElement('div');
  toast.className = 'update-check-toast';

  const hasUpdates = Array.isArray(updates) && updates.length > 0;
  const hasErrors  = Array.isArray(errors)  && errors.length  > 0;
  const clickable  = hasUpdates && typeof onClick === 'function';
  if (clickable) toast.classList.add('update-check-toast--clickable');

  if (hasUpdates) {
    const items = updates.map(u => {
      const label = _toastEsc(u?.label || '');
      const src = u?.source ? `<span class="utc-src">${_toastEsc(u.source)}</span>` : '';
      return `<li>${label}${src}</li>`;
    }).join('');
    toast.innerHTML = `
      <div class="utc-icon utc-icon--up">↑</div>
      <div class="utc-body">
        <div class="utc-title">Updates available</div>
        <ul class="utc-list">${items}</ul>
        ${clickable ? '<div class="utc-hint">Click to open update guide</div>' : ''}
      </div>`;
  } else if (hasErrors) {
    toast.innerHTML = `
      <div class="utc-icon utc-icon--err">!</div>
      <div class="utc-body">
        <div class="utc-title">Update check failed</div>
        <div class="utc-sub">${_toastEsc(errors.join(' · '))}</div>
      </div>`;
  } else {
    toast.innerHTML = `
      <div class="utc-icon utc-icon--ok">✓</div>
      <div class="utc-body">
        <div class="utc-title">All up to date</div>
      </div>`;
  }

  if (clickable) {
    toast.addEventListener('click', () => {
      try { onClick(); } catch {}
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 250);
    });
  }

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  const ttl = hasUpdates ? 7000 : hasErrors ? 5000 : 3500;
  setTimeout(() => {
    if (!toast.isConnected) return;
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 250);
  }, ttl);
}
