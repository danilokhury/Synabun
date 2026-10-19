// ═══════════════════════════════════════════
// SynaBun Neural Interface — the Git Bash row of Settings
// ═══════════════════════════════════════════
//
// The page side of git-bash-view.js: the row of Settings → AI connections →
// Executable paths that shows the Git Bash every Claude Code SynaBun starts
// gets on Windows, with Download / Try again and Re-check. It asks
// GET /api/cli/git-bash, follows a download while it runs (a few times a
// second, until the row has left the page), and posts what the buttons ask
// with the guards of SynaBun's other local routes (a JSON body, X-SynaBun-UI).
// A server that has no such route (an older one), and every macOS or Linux
// server, leaves the row hidden.

import { gitBashText, gitBashView } from './git-bash-view.js';

const POST = Object.freeze({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' }, body: '{}' });

const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v12h16V6H4zm2.3 2.3 3.7 3.7-3.7 3.7-1.4-1.4L7.2 12 4.9 9.7l1.4-1.4zM11 15h6v2h-6v-2z"/></svg>';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** The row's markup: hidden until the server says there is something to show (Windows). */
export function gitBashRowHtml() {
  return `
            <div class="cli-path-row" id="cli-git-bash" data-git-bash hidden>
              <div class="cli-path-icon" style="color:var(--t-secondary)">${ICON}</div>
              <div class="cli-path-field">
                <span class="cli-path-label" id="cli-git-bash-label">${escapeHtml(gitBashText('label'))}</span>
                <div class="cli-path-input-row">
                  <span class="stg-help" data-git-bash-line role="status" aria-live="polite" aria-labelledby="cli-git-bash-label" style="flex:1;min-width:0;margin:0"></span>
                  <button type="button" class="cli-detect-btn" data-git-bash-action hidden></button>
                  <button type="button" class="cli-detect-btn" data-git-bash-recheck hidden>${escapeHtml(gitBashText('recheck'))}</button>
                  <span class="cli-path-status" data-git-bash-badge></span>
                </div>
                <div class="stg-help" data-git-bash-note hidden></div>
                <div class="stg-help">${escapeHtml(gitBashText('help'))}</div>
              </div>
            </div>`;
}

/**
 * Fill the row and keep it current. `fetchImpl`, `schedule` and `cancel` are the page's own unless a test gives
 * others. Returns `{ refresh, stop }`; the row stops following a download by itself once it is off the page.
 */
export function wireGitBashRow(row, { fetchImpl = (...args) => fetch(...args), pollMs = 1500, schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id) } = {}) {
  if (!row) return { refresh: async () => null, stop: () => {} };
  const badge = row.querySelector('[data-git-bash-badge]');
  const line = row.querySelector('[data-git-bash-line]');
  const note = row.querySelector('[data-git-bash-note]');
  const action = row.querySelector('[data-git-bash-action]');
  const recheck = row.querySelector('[data-git-bash-recheck]');
  let timer = null;
  let stopped = false;

  const clearPoll = () => { if (timer !== null) { cancel(timer); timer = null; } };
  const stop = () => { stopped = true; clearPoll(); };

  function draw(status) {
    const view = gitBashView(status);
    row.hidden = !view.visible;
    clearPoll();
    if (!view.visible) return view;
    if (badge) {
      badge.textContent = view.badge?.text || '';
      badge.className = `cli-path-status${view.badge?.tone ? ` ${view.badge.tone}` : ''}`;
    }
    if (line) line.textContent = view.line;
    if (note) { note.textContent = view.note || ''; note.hidden = !view.note; }
    if (action) {
      action.hidden = !view.action;
      action.disabled = false;
      action.textContent = view.action ? gitBashText(view.action) : '';
    }
    if (recheck) {
      recheck.hidden = !view.recheck;
      recheck.disabled = false;
      recheck.textContent = gitBashText('recheck');
    }
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
    // A refusal that still says how things are (422: nothing to fetch here) is drawn as it is.
    if (!res.ok && !(body && typeof body.state === 'string')) throw new Error(body?.error || body?.code || `HTTP ${res.status}`);
    return body;
  }

  const said = (error) => { if (line) line.textContent = gitBashText('errorRequest', { message: error?.message || String(error) }); };

  async function refresh() {
    try { return draw(await ask('/api/cli/git-bash')); } catch {
      // An older server, or none: there is no row to show.
      row.hidden = true;
      return null;
    }
  }

  action?.addEventListener('click', async () => {
    action.disabled = true;
    try { draw(await ask('/api/cli/git-bash/install', POST)); } catch (error) { said(error); action.disabled = false; }
  });
  recheck?.addEventListener('click', async () => {
    recheck.disabled = true;
    recheck.textContent = gitBashText('checking');
    try { draw(await ask('/api/cli/git-bash/recheck', POST)); } catch (error) {
      said(error);
      recheck.disabled = false;
      recheck.textContent = gitBashText('recheck');
    }
  });

  refresh();
  return { refresh, stop };
}
