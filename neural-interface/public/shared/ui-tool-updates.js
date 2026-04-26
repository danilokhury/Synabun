// ═══════════════════════════════════════════
// SynaBun Neural Interface — CLI Tool Update Badges
// Checks /api/system/tool-versions and shows green badges
// on toolbar buttons + Apps menu items when updates exist.
// Clicking the button/menu item (not just the tiny badge)
// runs the update command in a shell tab when an update exists.
// ═══════════════════════════════════════════

import { emit } from './state.js';

const $ = (id) => document.getElementById(id);

const TOOL_ELEMENTS = {
  'claude-code': { toolbar: 'claude-update-badge',   menu: 'claude-menu-update-badge' },
  'codex':       { toolbar: 'codex-update-badge',    menu: 'codex-menu-update-badge' },
  'opencode':    { toolbar: 'opencode-update-badge', menu: 'opencode-menu-update-badge' },
  'gemini':      { toolbar: null,                    menu: 'gemini-menu-update-badge' },
};

// Parent elements whose clicks get intercepted when an update badge is visible
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

function runUpdate(key, badge) {
  const info = _latestData?.tools?.[key];
  const cmd = info?.updateCommand;

  if (!cmd) {
    // Tool installed via a source we can't safely auto-update from
    // (winget, native installer, etc.) and has no built-in self-updater.
    const label = TOOL_LABELS[key] || key;
    const src = info?.installSource;
    const hint = src && src !== 'unknown' && src !== 'other'
      ? `via your installer (${src})`
      : 'using your original installer';
    alert(`${label} update available (v${info?.installed} → v${info?.latest}).\n\nPlease update ${hint}.`);
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

function wireParentIntercept(parentId, badgeId, key) {
  const parent = $(parentId);
  const badge = $(badgeId);
  if (!parent || !badge) return;
  // Capture phase fires before normal click handlers — intercept when badge is visible
  parent.addEventListener('click', (e) => {
    if (badge.textContent) {
      e.stopPropagation();
      e.preventDefault();
      runUpdate(key, badge);
    }
  }, true);
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
          : `v${info.installed} → v${info.latest} — update via ${info.installSource || 'your installer'}`)
      : '';
    const parents = PARENT_ELEMENTS[key];

    if (ids.toolbar) {
      const badge = $(ids.toolbar);
      if (badge) { badge.textContent = has ? '↑' : ''; badge.title = tip; }
      // Update parent button tooltip when update is available
      const parentBtn = parents?.toolbar && $(parents.toolbar);
      if (parentBtn) {
        if (!parentBtn.dataset.tooltipOriginal) parentBtn.dataset.tooltipOriginal = parentBtn.dataset.tooltip || '';
        parentBtn.dataset.tooltip = has ? `Update available: ${tip}` : parentBtn.dataset.tooltipOriginal;
      }
    }
    if (ids.menu) {
      const badge = $(ids.menu);
      if (badge) { badge.textContent = has ? '↑' : ''; badge.title = tip; }
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
        const parents = PARENT_ELEMENTS[key];
        // Wire parent button/menu item intercepts (capture phase)
        if (ids.toolbar && parents?.toolbar) wireParentIntercept(parents.toolbar, ids.toolbar, key);
        if (ids.menu && parents?.menu) wireParentIntercept(parents.menu, ids.menu, key);
      }
    }
  } catch { /* silent */ }
}

export async function forceCheckToolUpdates() {
  try {
    const res = await fetch('/api/system/tool-versions?force=1');
    if (!res.ok) return;
    applyBadges(await res.json());
  } catch { /* silent */ }
}
