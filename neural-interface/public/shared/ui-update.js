// ═══════════════════════════════════════════
// SynaBun Neural Interface — Update Alert
// Checks for npm updates on page load, shows toolbar badge,
// and provides a 3-step modal wizard with blocking backup gate.
// ═══════════════════════════════════════════

const $ = (id) => document.getElementById(id);

let _versionData = null;

export async function initUpdate() {
  try {
    const res = await fetch('/api/system/version');
    if (!res.ok) return;
    _versionData = await res.json();

    if (!_versionData.updateAvailable) return;

    const btn = $('topright-update-btn');
    if (!btn) return;

    btn.style.display = '';
    const badge = $('update-badge');
    if (badge) badge.textContent = '!';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openUpdateModal();
    });
  } catch { /* silent — no update UI if check fails */ }
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
    return `
      <h3 class="update-modal-title">Update Available</h3>
      <div class="update-version-diff">
        <span class="update-ver update-ver--old">v${esc(_versionData.current)}</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        <span class="update-ver update-ver--new">v${esc(_versionData.latest)}</span>
      </div>
      <p style="font-size:12px;color:var(--t-muted);margin:12px 0 18px">
        A new version of SynaBun is available on npm.
      </p>
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
    return `
      <h3 class="update-modal-title">Run the Update</h3>
      <p style="font-size:12px;color:var(--t-muted);margin:4px 0 12px">
        Run this command in your terminal to update SynaBun:
      </p>
      <div class="update-code-block">
        <code>npm install -g synabun@latest</code>
        <button class="update-copy-btn" data-copy="npm install -g synabun@latest" title="Copy">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
      <p style="font-size:12px;color:var(--t-muted);margin:12px 0 8px">
        Then restart the Neural Interface:
      </p>
      <div class="update-code-block">
        <code>node neural-interface/server.js</code>
        <button class="update-copy-btn" data-copy="node neural-interface/server.js" title="Copy">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
      <div class="tag-delete-modal-actions" style="margin-top:18px">
        <button class="action-btn action-btn--ghost" id="update-back">Back</button>
        <button class="action-btn action-btn--primary" id="update-done">Done</button>
      </div>`;
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
