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
// What it says is cli-install-view.js (DOM-free, tested under node); the state
// (the answer, the install, Re-check, Add to PATH) is cli-install-controller.js,
// which the Antigravity panel's setup card uses too. A panel mounts one banner:
//
//   const cli = mountCliBanner({ toolKey: 'codex', prefix: 'cxp',
//     panel: () => panelEl, anchor: () => messagesContainer,
//     onBlockedChange: (blocked) => syncSendButton() });
//   cli.refresh();         when the panel is shown
//   cli.blocked();         before a send
//   cli.nudge();           a send that was held back
//   cli.flagFailure(text); a session could not start the CLI

import { cliInstallText, setCliInstallTranslator } from './cli-install-view.js';
import { createCliInstallController, DONE_NOTICE_MS } from './cli-install-controller.js';
import { t } from './i18n.js';

setCliInstallTranslator((key, params) => t(`cliInstall.${key}`, params));

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
  let el = null;
  let lastBlocked = null;
  let destroyed = false;
  let controller = null;

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
    root.querySelector(`.${cls('install')}`).addEventListener('click', () => { controller?.install(); });
    root.querySelector(`.${cls('recheck')}`).addEventListener('click', () => { controller?.recheck(); });
    root.querySelector(`.${cls('path')}`).addEventListener('click', () => { controller?.addPath(); });
    root.querySelector(`.${cls('dismiss')}`).addEventListener('click', () => { controller?.clearDone(); });
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
    el.className = `${p}-cli-banner ${p}-cli-banner--${v.kind}${v.nudging ? ` ${p}-cli-banner--nudge` : ''}`;
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
    recheckButton.disabled = !!v.checking;
    recheckButton.textContent = cliInstallText(v.checking ? 'checking' : 'recheck');
    const pathButton = el.querySelector(`.${cls('path')}`);
    pathButton.hidden = !v.addPath;
    pathButton.textContent = v.addPath?.label || '';
    pathButton.disabled = !!v.addPath?.disabled;
    const dismiss = el.querySelector(`.${cls('dismiss')}`);
    dismiss.hidden = !v.dismiss;
    dismiss.textContent = cliInstallText('dismiss');
  }

  function render() {
    if (destroyed || !controller) return;
    const v = controller.view();
    const panelEl = panel?.();
    if (panelEl) panelEl.classList.toggle(`${p}-cli-blocked`, v.blocked);
    if (v.show && place()) paint(v);
    else if (!v.show && el) el.remove();
    if (v.blocked !== lastBlocked) {
      lastBlocked = v.blocked;
      try { onBlockedChange(v.blocked, v); } catch (error) { console.error('[cli-banner] onBlockedChange:', error); }
    }
  }

  controller = createCliInstallController({ toolKey, doneNoticeMs, onChange: () => render() });
  render();

  return {
    /** Draw again (the panel was shown, or rebuilt). */
    refresh: render,
    /** Sending is held back: the CLI is missing, broken, failed to install, or being installed. */
    blocked: () => controller.blocked(),
    /** What the banner shows now (cli-install-view.js cliBannerView). */
    view: () => controller.view(),
    /** A send was held back: draw attention to the banner for a moment. */
    nudge: () => controller.nudge(),
    /**
     * A session could not start the CLI ("Claude CLI not found", a spawn error): show "failed to start" with its
     * words at once, then ask the server again; its answer decides what stays.
     */
    flagFailure: (reason = null) => controller.flagFailure(reason),
    /** Install from the banner's own button (for a panel's own entry point). */
    install: () => controller.install(),
    destroy() {
      destroyed = true;
      controller.destroy();
      el?.remove();
      el = null;
    },
  };
}
