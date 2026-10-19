// ═══════════════════════════════════════════
// SynaBun Neural Interface — the CLI banner of the side panels (page side)
// ═══════════════════════════════════════════
//
// One banner for the Claude Code, Codex and OpenCode panels, above their
// transcript, whenever their CLI is not usable: not installed (with Install,
// which runs the vendor's official installer on the server, the command to run
// by hand and the install guide), being installed (its steps and the
// installer's last lines), failed to install, or found but failed to start
// (with the error it gave). Each panel keeps its own look through a class
// prefix: cp-cli-banner* (Claude), cxp-cli-banner* (Codex), ocp-cli-banner*
// (OpenCode); the panel element gets `<prefix>-cli-blocked` while sending is
// off.
//
// What it says is cli-install-view.js (DOM-free, tested under node); the data
// and the install stream are cli-status.js. A panel mounts one controller:
//
//   const cli = mountCliBanner({ toolKey: 'codex', prefix: 'cxp',
//     panel: () => panelEl, anchor: () => messagesContainer,
//     onBlockedChange: (blocked) => syncSendButton() });
//   cli.refresh();         when the panel is shown
//   cli.blocked();         before a send
//   cli.nudge();           a send that was held back
//   cli.flagFailure(text); a session could not start the CLI

import { subscribeCliStatus, recheckCliStatus, getCliDocUrl, getCliInstallCommand, getCliLabel, installCli, followCliInstall, getCliInstallJobs, addCliToPath } from './cli-status.js';
import { cliBannerView, cliInstallText, cliStateOf, reduceInstallJob, setCliInstallTranslator, INSTALLABLE_CLIS } from './cli-install-view.js';
import { t } from './i18n.js';

setCliInstallTranslator((key, params) => t(`cliInstall.${key}`, params));

/** How long the note about where an install put the CLI stays, when it has one. */
const DONE_NOTICE_MS = 12000;
const NUDGE_MS = 700;

/**
 * @param {object} o
 * @param {'claude-code' | 'codex' | 'opencode'} o.toolKey
 * @param {'cp' | 'cxp' | 'ocp'} o.prefix the panel's class prefix
 * @param {() => HTMLElement | null} o.panel the panel element (gets `<prefix>-cli-blocked`)
 * @param {() => HTMLElement | null} o.anchor the banner goes right before this element (the transcript's container)
 * @param {(blocked: boolean, view: object) => void} [o.onBlockedChange] sending was held back / let go
 * @param {number} [o.doneNoticeMs]
 */
export function mountCliBanner({ toolKey, prefix, panel, anchor, onBlockedChange = () => {}, doneNoticeMs = DONE_NOTICE_MS } = {}) {
  const p = String(prefix || 'cp');
  let info = null;        // this CLI in the latest answer of /api/system/tool-versions (null: none yet)
  let forced = null;      // { reason }: a session could not start it, and the server was not asked again yet
  let job = null;         // the install under way or just ended (cli-install-view.js reduceInstallJob)
  let installing = false;
  let addingPath = false;
  let pathError = '';
  let looked = false;     // asked whether the server is already installing it since it went missing
  let el = null;
  let doneTimer = null;
  let nudgeTimer = null;
  let lastBlocked = null;
  let destroyed = false;

  const view = () => cliBannerView({
    toolKey,
    label: getCliLabel(toolKey),
    info,
    forced,
    job,
    addingPath, pathError,
    guideUrl: getCliDocUrl(toolKey),
    installCommand: getCliInstallCommand(toolKey),
  }, { t: cliInstallText });

  const cls = (name) => `${p}-cli-banner-${name}`;

  function build() {
    const root = document.createElement('div');
    root.className = `${p}-cli-banner`;
    root.dataset.cliTool = toolKey;
    root.innerHTML = `
      <div class="${cls('icon')}" aria-hidden="true"></div>
      <div class="${cls('text')}">
        <div class="${cls('title')}"></div>
        <div class="${cls('body')}"></div>
        <div class="${cls('command')}" hidden><code></code><button class="${cls('copy')}" type="button"></button></div>
        <div class="${cls('error')}" hidden><code></code></div>
        <div class="${cls('note')}" hidden></div>
        <div class="${cls('progress')}" hidden><div class="${cls('step')}"></div><div class="${cls('bar')}" hidden><span></span></div></div>
        <pre class="${cls('log')}" hidden></pre>
        <div class="${cls('actions')}">
          <button class="${cls('install')}" type="button" hidden></button>
          <a class="${cls('link')}" target="_blank" rel="noopener noreferrer"></a>
          <button class="${cls('recheck')}" type="button"></button>
          <button class="${cls('path')}" type="button" hidden></button>
          <button class="${cls('dismiss')}" type="button" hidden></button>
        </div>
      </div>
    `;
    root.querySelector(`.${cls('install')}`).addEventListener('click', () => { startInstall(); });
    root.querySelector(`.${cls('recheck')}`).addEventListener('click', () => { recheck(); });
    root.querySelector(`.${cls('path')}`).addEventListener('click', () => { addPath(); });
    root.querySelector(`.${cls('dismiss')}`).addEventListener('click', () => { clearDone(); });
    root.querySelector(`.${cls('copy')}`).addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const command = root.querySelector(`.${cls('command')} code`)?.textContent || '';
      if (!command) return;
      try { await navigator.clipboard.writeText(command); } catch { return; }
      button.textContent = cliInstallText('copied');
      setTimeout(() => { if (button.isConnected) button.textContent = cliInstallText('copy'); }, 1500);
    });
    return root;
  }

  function place() {
    const before = anchor?.();
    if (!before || !before.parentNode) return false;
    if (!el) el = build();
    if (el.parentNode !== before.parentNode || el.nextSibling !== before) before.parentNode.insertBefore(el, before);
    return true;
  }

  function paint(v) {
    el.className = `${p}-cli-banner ${p}-cli-banner--${v.kind}${nudgeTimer ? ` ${p}-cli-banner--nudge` : ''}`;
    el.setAttribute('role', v.live === 'assertive' ? 'alert' : 'status');
    el.setAttribute('aria-live', v.live);
    el.querySelector(`.${cls('icon')}`).textContent = v.icon;
    el.querySelector(`.${cls('title')}`).textContent = v.title;
    const body = el.querySelector(`.${cls('body')}`);
    body.textContent = v.text;
    body.hidden = !v.text;

    const command = el.querySelector(`.${cls('command')}`);
    command.hidden = !v.command;
    command.querySelector('code').textContent = v.command || '';
    const copy = command.querySelector(`.${cls('copy')}`);
    if (copy.textContent !== cliInstallText('copied')) copy.textContent = cliInstallText('copy');

    const error = el.querySelector(`.${cls('error')}`);
    error.hidden = !v.error;
    error.querySelector('code').textContent = v.error || '';

    const note = el.querySelector(`.${cls('note')}`);
    note.hidden = !v.note;
    note.textContent = v.note || '';
    // The command to run by hand is announced after the note that introduces it. (Moved only when it is
    // elsewhere: a node that moves loses the focus of what is in it.)
    const before = v.kind === 'failed' && v.note && v.command ? note : body;
    if (command.previousElementSibling !== before) before.after(command);

    const progress = el.querySelector(`.${cls('progress')}`);
    progress.hidden = !v.progress;
    el.querySelector(`.${cls('step')}`).textContent = v.progress?.text || '';
    const bar = el.querySelector(`.${cls('bar')}`);
    const percent = v.progress?.percent;
    bar.hidden = !(typeof percent === 'number');
    if (typeof percent === 'number') {
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-valuenow', String(percent));
      bar.firstElementChild.style.width = `${percent}%`;
    }

    const log = el.querySelector(`.${cls('log')}`);
    log.hidden = !v.log.length;
    log.setAttribute('aria-label', cliInstallText('logLabel'));
    const logText = v.log.join('\n');
    if (log.textContent !== logText) {
      log.textContent = logText;
      log.scrollTop = log.scrollHeight;
    }

    const install = el.querySelector(`.${cls('install')}`);
    install.hidden = !v.install;
    if (v.install) {
      install.textContent = v.install.label;
      install.disabled = !!v.install.disabled;
      install.setAttribute('aria-busy', v.kind === 'installing' ? 'true' : 'false');
    }
    const link = el.querySelector(`.${cls('link')}`);
    link.hidden = !v.guide;
    if (v.guide) { link.href = v.guide; link.textContent = cliInstallText('guide'); }
    else link.removeAttribute('href');
    const recheckButton = el.querySelector(`.${cls('recheck')}`);
    recheckButton.hidden = !v.recheck;
    if (!recheckButton.disabled) recheckButton.textContent = cliInstallText('recheck');
    const pathButton = el.querySelector(`.${cls('path')}`);
    pathButton.hidden = !v.addPath;
    pathButton.textContent = v.addPath?.label || '';
    pathButton.disabled = !!v.addPath?.disabled;
    const dismiss = el.querySelector(`.${cls('dismiss')}`);
    dismiss.hidden = !v.dismiss;
    dismiss.textContent = cliInstallText('dismiss');
  }

  function render() {
    if (destroyed) return;
    const v = view();
    const panelEl = panel?.();
    if (panelEl) panelEl.classList.toggle(`${p}-cli-blocked`, v.blocked);
    if (v.show && place()) paint(v);
    else if (!v.show && el) el.remove();
    if (v.blocked !== lastBlocked) {
      lastBlocked = v.blocked;
      try { onBlockedChange(v.blocked, v); } catch (error) { console.error('[cli-banner] onBlockedChange:', error); }
    }
  }

  function clearDone() {
    clearTimeout(doneTimer);
    doneTimer = null;
    if (job?.phase === 'done') job = null;
    render();
  }

  function apply(event) {
    if (!job && event?.type !== 'start') job = reduceInstallJob(null, { type: 'start' });
    job = reduceInstallJob(job, event);
    if (event?.type === 'done' && event.ok && event.status && typeof event.status === 'object') {
      info = event.status;
      forced = null;
    }
    render();
  }

  function settle(final) {
    if (job?.phase === 'running' && final) job = reduceInstallJob(job, final);
    if (job?.phase === 'done') {
      clearTimeout(doneTimer);
      const where = job.path;
      if (where && (where.onPath === false || where.added === true)) doneTimer = setTimeout(clearDone, doneNoticeMs);
      else job = null;
    }
    render();
  }

  async function startInstall() {
    if (installing || !INSTALLABLE_CLIS.includes(toolKey)) return;
    installing = true;
    clearTimeout(doneTimer);
    job = reduceInstallJob(null, { type: 'start' });
    render();
    let final = null;
    try {
      final = await installCli(toolKey, { onEvent: apply });
    } catch (error) {
      final = { type: 'done', ok: false, code: 'internal', error: error?.message || null };
    } finally {
      installing = false;
      settle(final);
    }
  }

  async function addPath() {
    if (addingPath) return;
    addingPath = true; pathError = ''; render();
    try {
      const result = await addCliToPath(toolKey);
      info = { ...info, pathStatus: { dir: result.dir, onPath: true, canAdd: false } };
      job = reduceInstallJob(null, { type: 'done', ok: true, status: info, path: { ...result, added: true } });
      settle();
    } catch (error) { pathError = error.message; }
    finally { addingPath = false; render(); }
  }

  // An install the server is already running (another window started it, or this page was reloaded during
  // one): followed here as if this banner had started it.
  async function followRunning() {
    if (installing) return;
    const jobs = await getCliInstallJobs();
    if (destroyed || installing || jobs?.[toolKey]?.state !== 'running') return;
    installing = true;
    job = reduceInstallJob(null, { type: 'start' });
    render();
    let final = null;
    try {
      final = await followCliInstall(toolKey, { onEvent: apply });
    } catch (error) {
      final = { type: 'done', ok: false, code: 'connection', error: error?.message || null };
    } finally {
      installing = false;
      settle(final);
    }
  }

  async function recheck() {
    const button = el?.querySelector(`.${cls('recheck')}`);
    if (button) { button.disabled = true; button.textContent = cliInstallText('checking'); }
    // Asking again starts over: an earlier failure is not repeated over a fresh answer.
    if (job?.phase === 'failed') job = null;
    try {
      const next = await recheckCliStatus(toolKey);
      info = next || info;
      if (cliStateOf(info) === 'installed' || cliStateOf(info) === 'broken') forced = null;
    } catch { /* the banner stays as it is */ }
    finally {
      if (button?.isConnected) { button.disabled = false; button.textContent = cliInstallText('recheck'); }
      render();
    }
  }

  const unsubscribe = subscribeCliStatus(toolKey, (next) => {
    info = next || null;
    const state = cliStateOf(info);
    if (state === 'installed') {
      forced = null;
      if (job?.phase === 'failed') job = null;
    }
    if (state === 'missing') {
      if (!looked) { looked = true; followRunning().catch(() => {}); }
    } else {
      looked = false;
    }
    render();
  });

  return {
    /** Draw again (the panel was shown, or rebuilt). */
    refresh: render,
    /** Sending is held back: the CLI is missing, broken, failed to install, or being installed. */
    blocked: () => view().blocked,
    /** What the banner shows now (cli-install-view.js cliBannerView). */
    view,
    /** A send was held back: draw attention to the banner for a moment. */
    nudge() {
      if (!view().show) return;
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => { nudgeTimer = null; render(); }, NUDGE_MS);
      render();
    },
    /**
     * A session could not start the CLI ("Claude CLI not found", a spawn error): show "failed to start" with its
     * words at once, then ask the server again; its answer decides what stays.
     */
    flagFailure(reason = null) {
      forced = { reason: reason ? String(reason).slice(0, 300) : null };
      render();
      recheckCliStatus(toolKey)
        .then((next) => {
          info = next || info;
          const state = cliStateOf(info);
          if (state === 'installed' || state === 'broken') forced = null;
          render();
        })
        .catch(() => {});
    },
    /** Install from the banner's own button (for a panel's own entry point). */
    install: startInstall,
    destroy() {
      destroyed = true;
      unsubscribe();
      clearTimeout(doneTimer);
      clearTimeout(nudgeTimer);
      el?.remove();
      el = null;
    },
  };
}
