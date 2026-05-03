// ═══════════════════════════════════════════
// SynaBun Neural Interface — Update Alert
// Checks for npm updates on page load, shows toolbar badge,
// and provides a 3-step modal wizard with blocking backup gate.
// ═══════════════════════════════════════════

import { showUpdateToast } from './ui-tool-updates.js';

const $ = (id) => document.getElementById(id);
const SYNABUN_GITHUB_URL = 'https://github.com/danilokhury/Synabun';

let _versionData = null;
let _btnWired = false;
let _pollWired = false;

function sourceLabel(data) {
  const src = data?.source;
  if (src === 'both') return 'npm + GitHub';
  if (src === 'github') return 'GitHub';
  if (src === 'npm') return 'npm';
  return src || 'update';
}

function applyTopRightButton(data) {
  const btn = $('topright-update-btn');
  const badge = $('update-badge');
  if (!btn) return;
  const has = !!data?.updateAvailable;
  btn.style.display = has ? '' : 'none';
  if (badge) {
    badge.classList.add('update-click-target');
    badge.textContent = has ? '!' : '';
    if (has) badge.setAttribute('aria-label', 'Update SynaBun');
    else badge.removeAttribute('aria-label');
  }
  if (has) {
    const srcLabel = sourceLabel(data);
    btn.dataset.tooltip = `SynaBun update available: v${data.current} → v${data.latest} (${srcLabel}) · click green badge`;
  }
  if (!_btnWired) {
    _btnWired = true;
    btn.addEventListener('click', (e) => {
      const currentBadge = $('update-badge');
      if (!currentBadge?.textContent) return;
      if (e.target !== currentBadge && !currentBadge.contains(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      openUpdateModal();
    });
  }
}

function maybeShowUpdateAlert(data, { once = true } = {}) {
  if (!data?.updateAvailable) return;
  const key = `synabun-update-alert:${data.current}->${data.latest}:${sourceLabel(data)}`;
  try {
    if (once && sessionStorage.getItem(key) === '1') return;
    sessionStorage.setItem(key, '1');
  } catch {}

  setTimeout(() => {
    showUpdateToast({
      updates: [{ label: `SynaBun v${data.current} → v${data.latest}`, source: sourceLabel(data) }],
      errors: [],
      onClick: () => openSynabunUpdateModal(),
    });
  }, 500);
}

export async function initUpdate() {
  try {
    const res = await fetch('/api/system/version');
    if (!res.ok) return;
    _versionData = await res.json();
    applyTopRightButton(_versionData);
    maybeShowUpdateAlert(_versionData);

    if (!_pollWired) {
      _pollWired = true;
      setInterval(() => {
        forceCheckSynabunUpdate({ alert: true }).catch(() => {});
      }, 30 * 60 * 1000);
    }
  } catch { /* silent — no update UI if check fails */ }
}

// Force a fresh server-side check (bypasses 1h cache via ?force=1) and
// re-applies the top-right button + badge state. Returns the latest
// _synabunUpdateCache shape so callers can compose toasts.
export async function forceCheckSynabunUpdate({ alert = false } = {}) {
  try {
    const res = await fetch('/api/system/version?force=1');
    if (!res.ok) return null;
    _versionData = await res.json();
    applyTopRightButton(_versionData);
    if (alert) maybeShowUpdateAlert(_versionData);
    return _versionData;
  } catch {
    return null;
  }
}

export function openSynabunUpdateModal() {
  if (!_versionData?.updateAvailable) return;
  openUpdateModal();
}

// Read-only accessor for the Notifications drawer to mirror SynaBun core
// update state without re-fetching. May be null until initUpdate() resolves.
export function getSynabunUpdateData() {
  return _versionData;
}

// ── Modal Wizard ──

function openUpdateModal() {
  if (!_versionData) return;

  let step = 1;
  let backupDone = false;

  const overlay = document.createElement('div');
  overlay.className = 'tag-delete-overlay';
  overlay.style.zIndex = '300100';

  function render() {
    overlay.innerHTML = `
      <div class="tag-delete-modal update-modal" style="max-width:460px;text-align:left">
        ${renderStepDots(step)}
        ${step === 1 ? renderStep1() : step === 2 ? renderStep2() : renderStep3()}
      </div>`;
    document.body.appendChild(overlay);
    bindEvents();
  }

  function renderStepDots(current) {
    return `<div class="update-steps">
      ${[1, 2, 3].map(i => `<span class="update-step-dot${i === current ? ' active' : i < current ? ' done' : ''}"></span>`).join('')}
    </div>`;
  }

  function renderStep1() {
    const src = _versionData.source;
    const channel = _versionData.installedChannel || 'stable';
    const channelTag = channel === 'prerelease'
      ? '<span class="update-channel-pill update-channel-pill--beta">beta</span>'
      : '';

    const srcCopy = src === 'both'
      ? 'A new version of SynaBun is available on npm and GitHub.'
      : src === 'github'
        ? 'A new SynaBun release is tagged on GitHub. The npm publish may still be in progress.'
        : 'A new version of SynaBun has been published to npm.';

    const npmStable = _versionData.npmLatestStable
      ? `npm latest v${esc(_versionData.npmLatestStable)}`
      : 'npm latest —';
    const npmBeta = _versionData.npmLatestBeta
      ? ` · npm beta v${esc(_versionData.npmLatestBeta)}`
      : '';
    const gitBit = _versionData.gitLatest
      ? ` · GitHub v${esc(_versionData.gitLatest)}`
      : ' · GitHub —';

    return `
      <h3 class="update-modal-title">Update Available ${channelTag}</h3>
      <div class="update-version-diff">
        <span class="update-ver update-ver--old">v${esc(_versionData.current)}</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        <span class="update-ver update-ver--new">v${esc(_versionData.latest)}</span>
      </div>
      <p style="font-size:12px;color:var(--t-muted);margin:12px 0 6px">${srcCopy}</p>
      <p style="font-size:11px;color:var(--t-muted);opacity:.75;margin:0 0 18px">${npmStable}${npmBeta}${gitBit}</p>
      <div class="tag-delete-modal-actions">
        <button class="action-btn action-btn--ghost" id="update-cancel">Cancel</button>
        <button class="action-btn action-btn--primary" id="update-next">Next</button>
      </div>`;
  }

  function renderStep2() {
    return `
      <h3 class="update-modal-title">Back Up Your Data</h3>
      <p style="font-size:12px;color:var(--t-muted);margin:4px 0 14px">
        Before updating, create a full system backup to protect your memories, settings, and configurations.
      </p>
      <button class="action-btn update-backup-btn" id="update-backup-download" style="width:100%;margin-bottom:10px">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download Full Backup
      </button>
      <div class="update-backup-status" id="update-backup-status" style="display:none">
        <span class="update-backup-icon" id="update-backup-icon"></span>
        <span id="update-backup-text"></span>
      </div>
      <label class="update-skip-label" style="margin:8px 0 16px">
        <input type="checkbox" id="update-skip-backup" ${backupDone ? 'checked' : ''}>
        <span>I already have a backup</span>
      </label>
      <div class="tag-delete-modal-actions">
        <button class="action-btn action-btn--ghost" id="update-back">Back</button>
        <button class="action-btn action-btn--primary" id="update-next" ${backupDone ? '' : 'disabled'}>Next</button>
      </div>`;
  }

  function renderStep3() {
    const installPlan = _versionData.installPlan || {};
    const canAutoUpdate = installPlan.canAutoUpdate === true;
    const repoUrl = installPlan.openUrl || SYNABUN_GITHUB_URL;
    const installCmd = canAutoUpdate
      ? (installPlan.displayCommand || 'npm i -g synabun@latest')
      : repoUrl;
    const installIntro = canAutoUpdate
      ? 'SynaBun will close and run this command in a new terminal window:'
      : 'This SynaBun install was not detected as an npm install. Open the GitHub repository to update from your checkout or installer:';
    const title = canAutoUpdate ? 'Run the Update' : 'Update from GitHub';
    const installSource = canAutoUpdate
      ? 'Installing from npm.'
      : (installPlan.manualHint || 'Open the SynaBun repository for the correct update path.');
    const autoRestartControl = canAutoUpdate ? `
      <p style="font-size:11px;color:var(--t-muted);opacity:.75;margin:10px 0 0">
        SynaBun will relaunch automatically after the update finishes.
      </p>` : '';
    const manualButton = canAutoUpdate ? `
        <button class="action-btn action-btn--ghost" id="update-manual" title="Run the command yourself in your own terminal">Manual</button>` : '';
    const updateNowButton = canAutoUpdate ? `
        <button class="action-btn action-btn--primary" id="update-run-now">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>
          Update Now
        </button>` : `
        <button class="action-btn action-btn--primary" id="update-run-now" data-url="${esc(repoUrl)}">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          Open GitHub
        </button>`;

    return `
      <h3 class="update-modal-title">${title}</h3>
      <p style="font-size:12px;color:var(--t-muted);margin:4px 0 12px">
        ${esc(installIntro)}
      </p>
      <div class="update-code-block">
        <code>${esc(installCmd)}</code>
        <button class="update-copy-btn" data-copy="${esc(installCmd)}" title="Copy">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
      <p style="font-size:11px;color:var(--t-muted);opacity:.75;margin:8px 0 0">${esc(installSource)}</p>
      ${autoRestartControl}

      <div class="update-run-status" id="update-run-status" style="display:none;margin:10px 0 0">
        <span class="update-backup-icon" id="update-run-icon"></span>
        <span id="update-run-text"></span>
      </div>

      <div class="tag-delete-modal-actions" style="margin-top:14px;flex-wrap:wrap;gap:8px">
        <button class="action-btn action-btn--ghost" id="update-back">Back</button>
        ${manualButton}
        ${updateNowButton}
      </div>

      <p id="update-manual-note" style="display:none;font-size:11px;color:var(--t-muted);opacity:.75;margin:10px 0 0">
        After running the command, restart SynaBun with <code>synabun</code>.
      </p>`;
  }

  function bindEvents() {
    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // Cancel / Done
    overlay.querySelector('#update-cancel')?.addEventListener('click', close);
    overlay.querySelector('#update-done')?.addEventListener('click', close);

    // Next
    overlay.querySelector('#update-next')?.addEventListener('click', () => {
      step++;
      render();
    });

    // Back
    overlay.querySelector('#update-back')?.addEventListener('click', () => {
      step--;
      render();
    });

    // Copy buttons
    overlay.querySelectorAll('.update-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.dataset.copy;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#34c759" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
          setTimeout(() => {
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
          }, 1500);
        });
      });
    });

    // Backup download
    overlay.querySelector('#update-backup-download')?.addEventListener('click', handleBackupDownload);

    // Update Now — kick off click-to-update flow
    overlay.querySelector('#update-run-now')?.addEventListener('click', handleRunUpdate);

    // Manual — surface the command + relaunch hint, hide auto-update controls
    overlay.querySelector('#update-manual')?.addEventListener('click', () => {
      overlay.querySelector('#update-manual-note').style.display = '';
      const runNow = overlay.querySelector('#update-run-now');
      if (runNow) runNow.style.display = 'none';
    });

    // Skip checkbox
    const skipCb = overlay.querySelector('#update-skip-backup');
    if (skipCb) {
      skipCb.addEventListener('change', () => {
        backupDone = skipCb.checked;
        const nextBtn = overlay.querySelector('#update-next');
        if (nextBtn) nextBtn.disabled = !backupDone;
      });
    }
  }

  async function handleRunUpdate() {
    const installPlan = _versionData?.installPlan || {};
    const canAutoUpdate = installPlan.canAutoUpdate === true;
    const repoUrl = installPlan.openUrl || SYNABUN_GITHUB_URL;

    // Auto-restart is always on; server forces it true regardless of payload.
    const autoRestart = true;

    const runBtn = overlay.querySelector('#update-run-now');
    const backBtn = overlay.querySelector('#update-back');
    const manualBtn = overlay.querySelector('#update-manual');
    const status = overlay.querySelector('#update-run-status');
    const icon = overlay.querySelector('#update-run-icon');
    const text = overlay.querySelector('#update-run-text');

    if (!runBtn || !backBtn || !status || !icon || !text) return;

    if (!canAutoUpdate) {
      window.open(repoUrl, '_blank', 'noopener,noreferrer');
      status.style.display = 'flex';
      icon.className = 'update-backup-icon';
      icon.textContent = '↗';
      icon.style.color = '#4fc3f7';
      text.innerHTML = `<strong>GitHub repository opened</strong><span class="update-run-detail">Use the repository instructions to update this non-npm installation.</span>`;
      return;
    }

    runBtn.disabled = true;
    backBtn.disabled = true;
    if (manualBtn) manualBtn.disabled = true;
    runBtn.innerHTML = '<span class="update-spinner"></span> Launching updater...';
    status.style.display = 'flex';
    icon.className = 'update-backup-icon spin';
    icon.textContent = '⟳';
    icon.style.color = '';
    text.innerHTML = '<strong>Launching updater</strong><span class="update-run-detail">Opening a terminal window for the npm update.</span>';

    try {
      const res = await fetch('/api/system/run-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoRestart }),
      });
      if (!res.ok) {
        let msg = `Updater failed (${res.status})`;
        try { const b = await res.json(); msg = b.error || msg; } catch {}
        throw new Error(msg);
      }
      await res.json();

      icon.className = 'update-backup-icon';
      icon.textContent = '✓';
      icon.style.color = '#34c759';
      text.innerHTML = `<strong>Updater terminal launched</strong><span class="update-run-detail">SynaBun is shutting down so npm can replace the package. Watch the terminal for install progress; SynaBun will relaunch automatically when it finishes.</span><span class="update-run-hint">If no terminal window appears, run <code>${esc(installPlan.displayCommand || 'npm i -g synabun@latest')}</code> manually.</span>`;
      runBtn.innerHTML = 'Updater running…';

      // Server is shutting down. Optionally redirect to a friendly offline
      // notice — for now leave the page; user already understands from copy.
      // Re-enable Back so they can close the modal.
      setTimeout(() => { backBtn.disabled = false; }, 2500);
    } catch (err) {
      icon.className = 'update-backup-icon';
      icon.textContent = '✗';
      icon.style.color = 'var(--accent-red)';
      text.textContent = 'Failed to launch updater: ' + err.message;
      runBtn.disabled = false;
      backBtn.disabled = false;
      if (manualBtn) manualBtn.disabled = false;
      runBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg> Retry`;
    }
  }

  async function handleBackupDownload() {
    const btn = overlay.querySelector('#update-backup-download');
    const status = overlay.querySelector('#update-backup-status');
    const icon = overlay.querySelector('#update-backup-icon');
    const text = overlay.querySelector('#update-backup-text');
    if (!btn) return;

    btn.disabled = true;
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<span class="update-spinner"></span> Creating backup...';
    status.style.display = 'flex';
    icon.className = 'update-backup-icon spin';
    icon.textContent = '⟳';
    text.textContent = 'Collecting files and database...';

    try {
      const res = await fetch('/api/system/backup');
      if (!res.ok) {
        let errMsg = 'Backup failed';
        try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
        throw new Error(errMsg);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : 'synabun-backup.zip';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);

      icon.className = 'update-backup-icon';
      icon.textContent = '✓';
      icon.style.color = '#34c759';
      text.textContent = `${filename} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`;

      backupDone = true;
      const nextBtn = overlay.querySelector('#update-next');
      if (nextBtn) nextBtn.disabled = false;
      const skipCb = overlay.querySelector('#update-skip-backup');
      if (skipCb) skipCb.checked = true;
    } catch (err) {
      icon.className = 'update-backup-icon';
      icon.textContent = '✗';
      icon.style.color = 'var(--accent-red)';
      text.textContent = 'Backup failed: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHTML;
    }
  }

  function close() {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 150);
  }

  render();
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
