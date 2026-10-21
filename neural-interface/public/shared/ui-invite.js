// ═══════════════════════════════════════════
// SynaBun Neural Interface — Invite / Share
// ═══════════════════════════════════════════
// Toolbar dropdown for session invitation management.
// Follows the same pattern as ui-workspaces.js.

import { emit, on } from './state.js';
import {
  fetchInviteStatus,
  generateInviteKey,
  revokeInviteKey,
  revokeAllInviteSessions,
  saveInviteProxy,
  fetchInvitePermissions,
  saveInvitePermissions,
} from './api.js';
import { isGuest } from './ui-sync.js';
import { createTunnelCard, drawInto } from './ui-tunnel.js';

const $ = (id) => document.getElementById(id);

let _isOpen = false;
let _data = { hasKey: false, maskedKey: null, activeSessions: 0, proxyConfig: { useProxy: false, proxyUrl: '' } };
// The Cloudflare tunnel: what the server says of it, read by tunnel-view.js; asked again by itself while a
// download or a start is on its way, for as long as the dropdown is open (ui-tunnel.js).
let _tunnelKind = null;
const _tunnel = createTunnelCard({
  alive: () => _isOpen,
  onChange(view) {
    if (!_isOpen) return;
    // The address coming or going changes the other sections too (the invite link); anything else only this block.
    const whole = view.kind !== _tunnelKind && (view.kind === 'running' || _tunnelKind === 'running');
    _tunnelKind = view.kind;
    if (whole) render(); else drawTunnel();
  },
});
let _keyMode = 'auto'; // 'auto' | 'custom'
let _revealedKey = null; // shown only right after generation
let _permissions = { terminal: false, whiteboard: false, memories: true, skills: false, cards: true, browser: false };
let _dataLoaded = false; // the status was read once (the badge's read at start-up counts)

// ─── Dropdown open/close ────────────────

function openDropdown() {
  const dd = $('invite-dropdown');
  if (!dd) return;
  _isOpen = true;
  dd.style.display = '';
  $('invite-btn')?.classList.add('active');
  emit('panel:close-all-dropdowns-except', 'invite');
  // The status as last read (the badge's read at start-up, an earlier open) paints at once once the tunnel's
  // state is known too (an earlier open asked it); the read below redraws only what changed, and never under a
  // field being typed in.
  const early = _dataLoaded && _tunnelKind !== null;
  if (early) render();
  loadAndRender({ inPlace: early });
}

function closeDropdown() {
  const dd = $('invite-dropdown');
  if (!dd) return;
  _isOpen = false;
  dd.style.display = 'none';
  $('invite-btn')?.classList.remove('active');
  _revealedKey = null;
}

function toggleDropdown() {
  _isOpen ? closeDropdown() : openDropdown();
}

// ─── Data fetching ──────────────────────

const inviteSnapshot = () => { try { return JSON.stringify([_data, _permissions, _tunnel.view()]); } catch { return ''; } };

async function loadAndRender({ inPlace = false } = {}) {
  const before = inPlace ? inviteSnapshot() : null;
  try {
    const [inviteRes, , permRes] = await Promise.all([
      fetchInviteStatus(),
      _tunnel.refresh(),
      fetchInvitePermissions(),
    ]);
    _data = inviteRes;
    _dataLoaded = true;
    if (permRes?.permissions) _permissions = permRes.permissions;
  } catch (err) {
    console.warn('[invite] Failed to load status:', err);
  }
  if (inPlace) {
    if (inviteSnapshot() === before) return;
    const typing = document.activeElement?.closest?.('#invite-dropdown') && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (typing) return; // the next open shows it
  }
  render();
}

// ─── URL helpers ────────────────────────

function getBaseUrl() {
  if (_data.proxyConfig?.useProxy && _data.proxyConfig?.proxyUrl) {
    return _data.proxyConfig.proxyUrl.replace(/\/+$/, '');
  }
  return _tunnel.view().url || null;
}

function getInviteUrl() {
  const base = getBaseUrl();
  return base ? base + '/invite' : null;
}

// ─── Clipboard helper ───────────────────

function flashCopied(el) {
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
}

async function copyText(text, feedbackId) {
  try {
    await navigator.clipboard.writeText(text);
    const el = $(feedbackId);
    if (el) flashCopied(el);
  } catch {}
}

// ─── Render ─────────────────────────────

function render() {
  const dd = $('invite-dropdown');
  if (!dd) return;

  const inviteUrl = getInviteUrl();
  const useProxy = _data.proxyConfig?.useProxy || false;

  dd.innerHTML = `
    <div class="invite-section">
      <div class="invite-section-label">Connection</div>
      ${useProxy ? `
        <input type="text" class="invite-proxy-input" id="invite-proxy-url"
          placeholder="https://your-domain.com"
          value="${escHtml(_data.proxyConfig?.proxyUrl || '')}">
        <div class="invite-action-row" style="margin-top:6px">
          <button class="invite-btn primary" id="invite-proxy-save">Save</button>
          <button class="invite-alt-link" id="invite-mode-tunnel">Use Cloudflare tunnel</button>
        </div>
      ` : `
        <div id="invite-tunnel"></div>
      `}
    </div>

    <div class="invite-section">
      <div class="invite-section-label">Invite Key</div>
      ${_keyMode === 'custom' ? `
        <input type="text" class="invite-custom-input" id="invite-custom-pw"
          placeholder="Enter a password (min 6 chars)" autocomplete="off" spellcheck="false">
      ` : ''}
      ${_revealedKey ? `
        <div class="invite-key-box">
          ${escHtml(_revealedKey)}
          <button class="invite-copy-icon" id="invite-copy-key" data-tooltip="Copy key"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        </div>
        <div class="invite-key-meta">
          <span class="invite-warn">Copy now — won't be shown again</span>
          <span class="invite-copied" id="invite-copied-fb">Copied</span>
          ${inviteUrl ? `<button class="invite-btn primary" id="invite-copy-url" style="margin-left:auto">Copy Link</button>` : ''}
        </div>
      ` : `
        <div class="invite-action-row">
          ${_data.hasKey ? `
            <span class="invite-key-status">${_data.maskedKey}</span>
            <button class="invite-btn primary" id="invite-generate">Rotate</button>
            <button class="invite-btn danger" id="invite-revoke-key">Revoke</button>
          ` : `
            <button class="invite-btn primary" id="invite-generate">Generate</button>
          `}
          <button class="invite-alt-link" id="${_keyMode === 'custom' ? 'invite-km-auto' : 'invite-km-custom'}">${_keyMode === 'custom' ? 'Use auto key' : 'Custom password'}</button>
        </div>
      `}
    </div>

    ${_data.activeSessions > 0 ? `
    <div class="invite-section">
      <div class="invite-sessions-row">
        <span class="invite-sessions-dot"></span>
        <span>${_data.activeSessions} active session${_data.activeSessions !== 1 ? 's' : ''}</span>
        <button class="invite-btn danger" id="invite-revoke-sessions" style="margin-left:auto">Revoke</button>
      </div>
    </div>
    ` : ''}

    ${_data.hasKey ? `
    <div class="invite-section">
      <div class="invite-section-label">Guest access</div>
      ${renderPermToggle('memories', 'Memories')}
      ${renderPermToggle('cards', 'Memory Cards')}
      ${renderPermToggle('whiteboard', 'Whiteboard')}
      ${renderPermToggle('terminal', 'Terminal')}
      ${renderPermToggle('skills', 'Skills Studio')}
      ${renderPermToggle('browser', 'Browser')}
    </div>
    ` : ''}
  `;

  wireTunnel();
  drawTunnel();
  wireEvents();
  updateBadge();
}

// ─── The tunnel block ───────────────────
// Drawn by itself: while cloudflared is being downloaded the progress changes every second, and the rest of the
// dropdown (a password being typed, a key just shown) must not be drawn over for that.

const COPY_ICON = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const SPINNER = '<svg viewBox="0 0 24 24" class="invite-spin invite-tunnel-spinner" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
const USE_CUSTOM = '<button class="invite-alt-link" id="invite-mode-proxy">Use custom URL</button>';

/** The markup of the tunnel block for a reading of tunnel-view.js. */
function tunnelBlock(view) {
  const label = escHtml(view.label);
  const detail = view.detail ? `<div class="invite-tunnel-detail">${escHtml(view.detail)}</div>` : '';
  if (view.kind === 'running') {
    return `
      <div class="invite-status-row" role="status">
        <span class="invite-status-dot active" aria-hidden="true"></span>
        <span class="invite-url-text" title="${label}">${escHtml(view.url)}</span>
        <button class="invite-copy-icon" id="invite-copy-base-url" data-tooltip="Copy" aria-label="Copy">${COPY_ICON}</button>
        <span class="invite-copied" id="invite-copied-url">Copied</span>
      </div>
      ${view.copy ? `<div class="invite-tunnel-detail invite-tunnel-copy">${escHtml(view.copy)}${view.copyNote ? ` ${escHtml(view.copyNote)}` : ''}</div>` : ''}
      <div class="invite-action-row">
        <button class="invite-btn" id="invite-tunnel-stop">${escHtml(view.actionLabel)}</button>
        ${USE_CUSTOM}
      </div>`;
  }
  if (view.kind === 'downloading' || view.kind === 'starting') {
    return `
      <div class="invite-status-row" role="status">
        ${SPINNER}
        <span class="invite-tunnel-state">${label}</span>
        ${view.progress ? `<span class="invite-tunnel-percent">${escHtml(view.progress.text)}</span>` : ''}
      </div>
      ${view.progress ? `<div class="invite-progress" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${view.progress.percent}"><span style="width:${view.progress.percent}%"></span></div>` : ''}
      ${detail}
      <div class="invite-action-row">
        <button class="invite-btn" id="invite-tunnel-stop">${escHtml(view.actionLabel)}</button>
        ${USE_CUSTOM}
      </div>`;
  }
  if (view.kind === 'failed') {
    return `
      <div class="invite-status-row" role="alert">
        <span class="invite-status-dot error" aria-hidden="true"></span>
        <span class="invite-tunnel-state error">${label}</span>
      </div>
      ${detail}
      <div class="invite-action-row">
        <button class="invite-btn primary" id="invite-tunnel-start">${escHtml(view.actionLabel)}</button>
        ${USE_CUSTOM}
      </div>`;
  }
  if (view.kind === 'idle') {
    return `
      ${detail}
      <div class="invite-action-row">
        <button class="invite-btn primary" id="invite-tunnel-start">${escHtml(view.actionLabel)}</button>
        ${USE_CUSTOM}
      </div>`;
  }
  // No tunnel can be started from here (the server needs a restart first, or this system has no tunnel
  // program): the state, why, and the other way to an address.
  return `
    <div class="invite-status-row" role="status">
      <span class="invite-status-dot${view.tone === 'warn' ? ' warn' : ''}" aria-hidden="true"></span>
      <span class="invite-tunnel-state">${label}</span>
    </div>
    ${detail}
    <div class="invite-action-row">
      ${USE_CUSTOM}
    </div>`;
}

function drawTunnel() {
  const box = $('invite-tunnel');
  if (box) drawInto(box, tunnelBlock(_tunnel.view()));
}

/** One listener for the block: its buttons come and go with the state. */
function wireTunnel() {
  const box = $('invite-tunnel');
  if (!box) return;
  box.addEventListener('click', async (e) => {
    const button = e.target.closest('button');
    if (!button || !box.contains(button)) return;
    e.stopPropagation();
    if (button.id === 'invite-tunnel-start') {
      // Shown at once: the server answers immediately too, and then says what it is doing.
      _tunnel.show({ ...(_tunnel.status() || {}), state: 'starting', starting: true, url: null, error: null });
      await _tunnel.start();
    } else if (button.id === 'invite-tunnel-stop') {
      await _tunnel.stop();
    } else if (button.id === 'invite-copy-base-url') {
      const url = getBaseUrl();
      if (url) copyText(url, 'invite-copied-url');
    } else if (button.id === 'invite-mode-proxy') {
      await saveInviteProxy({ useProxy: true, proxyUrl: _data.proxyConfig?.proxyUrl || '' });
      _data.proxyConfig = { useProxy: true, proxyUrl: _data.proxyConfig?.proxyUrl || '' };
      _revealedKey = null;
      render();
    }
  });
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PERM_ICONS = {
  memories:   '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>',
  cards:      '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>',
  whiteboard: '<svg viewBox="0 0 24 24"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>',
  terminal:   '<svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  skills:     '<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  browser:    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
};

function renderPermToggle(key, label) {
  const on = !!_permissions[key];
  return `<div class="invite-perm-row" data-perm="${key}">
    <div class="invite-perm-left">
      <span class="invite-perm-icon">${PERM_ICONS[key] || ''}</span>
      <span class="invite-perm-label">${label}</span>
    </div>
    <div class="invite-perm-toggle ${on ? 'on' : ''}"><div class="invite-perm-knob"></div></div>
  </div>`;
}

// ─── Event wiring ───────────────────────

function wireEvents() {
  // URL mode pills
  $('invite-mode-tunnel')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await saveInviteProxy({ useProxy: false, proxyUrl: _data.proxyConfig?.proxyUrl || '' });
    _data.proxyConfig = { useProxy: false, proxyUrl: _data.proxyConfig?.proxyUrl || '' };
    _revealedKey = null;
    render();
  });

  // (The tunnel block's own buttons, "Use custom URL" among them, are wired in wireTunnel.)

  // Proxy save
  $('invite-proxy-save')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const url = $('invite-proxy-url')?.value.trim() || '';
    await saveInviteProxy({ useProxy: true, proxyUrl: url });
    _data.proxyConfig = { useProxy: true, proxyUrl: url };
    _revealedKey = null;
    render();
  });

  // Key mode pills
  $('invite-km-auto')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _keyMode = 'auto';
    _revealedKey = null;
    render();
  });

  $('invite-km-custom')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _keyMode = 'custom';
    _revealedKey = null;
    render();
  });

  // Generate / rotate
  $('invite-generate')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      let res;
      if (_keyMode === 'custom') {
        const pw = $('invite-custom-pw')?.value.trim();
        if (!pw || pw.length < 6) {
          $('invite-custom-pw')?.focus();
          return;
        }
        res = await generateInviteKey(pw);
      } else {
        res = await generateInviteKey();
      }
      _revealedKey = res.key;
      _data.hasKey = true;
      _data.maskedKey = '***' + res.key.slice(-8);
      _data.activeSessions = 0;
      render();
    } catch (err) {
      console.error('[invite] Generate failed:', err);
    }
  });

  // Copy key
  $('invite-copy-key')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_revealedKey) copyText(_revealedKey, 'invite-copied-fb');
  });

  // Copy URL (with key as fragment)
  $('invite-copy-url')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const url = getInviteUrl();
    if (url && _revealedKey) {
      copyText(url + '#' + encodeURIComponent(_revealedKey), 'invite-copied-fb');
    }
  });

  // Revoke key
  $('invite-revoke-key')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await revokeInviteKey();
      _data.hasKey = false;
      _data.maskedKey = null;
      _data.activeSessions = 0;
      _revealedKey = null;
      render();
    } catch (err) {
      console.error('[invite] Revoke key failed:', err);
    }
  });

  // Revoke sessions
  $('invite-revoke-sessions')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await revokeAllInviteSessions();
      _data.activeSessions = 0;
      render();
    } catch (err) {
      console.error('[invite] Revoke sessions failed:', err);
    }
  });

  // Stop clicks inside dropdown from closing it
  $('invite-dropdown')?.addEventListener('click', (e) => e.stopPropagation());

  // Stop input/button focus from closing
  const proxyInput = $('invite-proxy-url');
  if (proxyInput) {
    proxyInput.addEventListener('click', (e) => e.stopPropagation());
    proxyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('invite-proxy-save')?.click();
      }
    });
  }

  const customInput = $('invite-custom-pw');
  if (customInput) {
    customInput.addEventListener('click', (e) => e.stopPropagation());
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('invite-generate')?.click();
      }
    });
    // Auto-focus the custom password input
    setTimeout(() => customInput.focus(), 50);
  }

  // Permission toggles
  $('invite-dropdown')?.querySelectorAll('.invite-perm-row').forEach((row) => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const key = row.dataset.perm;
      if (!key) return;
      const newVal = !_permissions[key];
      _permissions[key] = newVal;
      // Optimistic toggle
      const toggle = row.querySelector('.invite-perm-toggle');
      if (toggle) toggle.classList.toggle('on', newVal);
      try {
        await saveInvitePermissions({ [key]: newVal });
      } catch (err) {
        // Revert on failure
        _permissions[key] = !newVal;
        if (toggle) toggle.classList.toggle('on', !newVal);
        console.error('[invite] Permission save failed:', err);
      }
    });
  });
}

// ─── Badge ──────────────────────────────

function updateBadge() {
  const badge = $('invite-session-count');
  if (!badge) return;
  if (_data.activeSessions > 0) {
    badge.textContent = _data.activeSessions;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// ─── Init ───────────────────────────────

export function initInvite() {
  const btn = $('invite-btn');
  if (!btn) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown();
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (_isOpen && !e.target.closest('#invite-overlay')) {
      closeDropdown();
    }
  });

  // Close when other dropdowns request exclusivity
  on('panel:close-all-dropdowns', () => closeDropdown());
  on('panel:close-all-dropdowns-except', (name) => {
    if (name !== 'invite') closeDropdown();
  });

  // Hide Share button for guests (admin only)
  on('session:info', ({ isGuest: guest }) => {
    const overlay = $('invite-overlay');
    if (overlay) overlay.style.display = guest ? 'none' : '';
  });

  // Load initial badge count
  fetchInviteStatus().then((res) => {
    _data = res;
    _dataLoaded = true;
    updateBadge();
  }).catch(() => {});
}
