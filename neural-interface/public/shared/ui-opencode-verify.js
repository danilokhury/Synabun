// ═══════════════════════════════════════════
// SynaBun Neural Interface — the Verify OpenCode row of Settings
// ═══════════════════════════════════════════
//
// The page side of opencode-verify-view.js: the row of Settings → AI connections → Executable paths that shows each
// OpenCode serve SynaBun runs and the result of its runtime authentication check, with Verify again. It asks
// GET /api/cli/opencode-serves, follows a check under way (a few times a second, until the row has left the page),
// and posts Verify again with the guards of SynaBun's other local routes (a JSON body, X-SynaBun-UI). A server that
// has no such route (an older one) leaves the row hidden. It reuses the Executable paths rows' own classes.

import { opencodeVerifyText, opencodeVerifyView } from './opencode-verify-view.js';

const POST = Object.freeze({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' }, body: '{}' });

const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3zm-1.2 14.2-3.5-3.5 1.4-1.4 2.1 2.1 4.9-4.9 1.4 1.4-6.3 6.3z"/></svg>';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** The row's markup: hidden until the server answers. */
export function opencodeVerifyRowHtml() {
  return `
            <div class="cli-path-row" id="cli-opencode-verify" data-opencode-verify hidden>
              <div class="cli-path-icon" style="color:var(--t-secondary)">${ICON}</div>
              <div class="cli-path-field">
                <span class="cli-path-label" id="cli-opencode-verify-label">${escapeHtml(opencodeVerifyText('label'))}</span>
                <div class="cli-path-input-row">
                  <span class="stg-help" data-opencode-verify-line role="status" aria-live="polite" aria-labelledby="cli-opencode-verify-label" style="flex:1;min-width:0;margin:0"></span>
                  <button type="button" class="cli-detect-btn" data-opencode-verify-run>${escapeHtml(opencodeVerifyText('verify'))}</button>
                  <span class="cli-path-status" data-opencode-verify-badge></span>
                </div>
                <div data-opencode-verify-serves></div>
                <div class="stg-help" data-opencode-verify-exe hidden></div>
                <div class="stg-help" data-opencode-verify-fix hidden>${escapeHtml(opencodeVerifyText('fix'))}</div>
                <div class="stg-help" data-opencode-verify-fix-foreign hidden>${escapeHtml(opencodeVerifyText('fixForeign'))}</div>
                <div class="stg-help">${escapeHtml(opencodeVerifyText('help'))}</div>
              </div>
            </div>`;
}

/**
 * Fill the row and keep it current. `fetchImpl`, `schedule` and `cancel` are the page's own unless a test gives
 * others. Returns `{ refresh, stop }`.
 */
export function wireOpencodeVerifyRow(row, { fetchImpl = (...args) => fetch(...args), pollMs = 1000, schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id) } = {}) {
  if (!row) return { refresh: async () => null, stop: () => {} };
  const badge = row.querySelector('[data-opencode-verify-badge]');
  const line = row.querySelector('[data-opencode-verify-line]');
  const list = row.querySelector('[data-opencode-verify-serves]');
  const exe = row.querySelector('[data-opencode-verify-exe]');
  const fix = row.querySelector('[data-opencode-verify-fix]');
  const fixForeign = row.querySelector('[data-opencode-verify-fix-foreign]');
  const run = row.querySelector('[data-opencode-verify-run]');
  let timer = null;
  let stopped = false;

  const clearPoll = () => { if (timer !== null) { cancel(timer); timer = null; } };
  const stop = () => { stopped = true; clearPoll(); };

  function draw(status) {
    const view = opencodeVerifyView(status);
    row.hidden = !view.visible;
    clearPoll();
    if (!view.visible) return view;
    if (badge) {
      badge.textContent = view.badge?.text || '';
      badge.className = `cli-path-status${view.badge?.tone ? ` ${view.badge.tone}` : ''}`;
    }
    if (line) line.textContent = view.line;
    if (list) {
      // One block per serve: its state in words and by the block's edge colour (data-state), the file it runs, its checks.
      list.innerHTML = view.serves.map((serve) => `
                  <div class="opencode-verify-serve" data-state="${serve.tone}" data-own="${serve.own ? '1' : '0'}">
                    <div class="stg-help opencode-verify-serve-line">${escapeHtml(serve.text)}</div>${serve.path ? `
                    <div class="stg-help opencode-verify-path">${escapeHtml(serve.path)}</div>` : ''}${serve.checks.length ? `
                    <div class="stg-help">${serve.checks.map(escapeHtml).join(' · ')}</div>` : ''}
                  </div>`).join('');
    }
    if (exe) { exe.textContent = view.executable || ''; exe.hidden = !view.executable; }
    if (fix) fix.hidden = !view.fix;
    if (fixForeign) fixForeign.hidden = !view.fixForeign;
    if (run) { run.disabled = false; run.textContent = opencodeVerifyText('verify'); }
    if (view.busy && !stopped) {
      timer = schedule(() => {
        timer = null;
        if (row.isConnected === false) { stop(); return; }
        refresh();
      }, pollMs);
    }
    return view;
  }

  async function ask(path, init) {
    const res = await fetchImpl(path, init);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok || !body || body.ok !== true) throw new Error(body?.error || body?.code || `HTTP ${res.status}`);
    return body;
  }

  async function refresh() {
    try { return draw(await ask('/api/cli/opencode-serves')); } catch {
      // An older server, or none: there is no row to show.
      row.hidden = true;
      return null;
    }
  }

  run?.addEventListener('click', async () => {
    run.disabled = true;
    run.textContent = opencodeVerifyText('checking');
    try { draw(await ask('/api/cli/opencode-serves/verify', POST)); } catch (error) {
      if (line) line.textContent = opencodeVerifyText('errorRequest', { message: error?.message || String(error) });
      run.disabled = false;
      run.textContent = opencodeVerifyText('verify');
    }
  });

  refresh();
  return { refresh, stop };
}
