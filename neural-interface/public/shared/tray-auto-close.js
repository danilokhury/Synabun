import { KEYS } from './constants.js';
import { trayColumnOf } from './ui-tray-columns.js';

// What a tray pill tells this toggle it must leave open: a tab whose close would destroy what the user cannot get
// back (a Claude Code temporary chat, an unsent draft). The panels decide; this module only asks. A pill says it
// twice: `pill.keepFromAutoClose()` is the live answer asked right before a close, and the attribute below is the
// signal the observer watches, so a reason that appears or goes away while the pill sits in Done is checked again
// at once. The user's own X asks neither. (Here, not in a module of their own: this one is loaded before the page
// is shown and the panels are not, tests/boot-critical-path.test.mjs.)
export const AUTO_CLOSE_KEEP_ATTR = 'data-auto-close-keep';

/** Whether a composer holds something unsent: text that is not only blanks, or any attachment list with an entry. */
export function composerHoldsDraft(text, ...attachments) {
  return !!String(text ?? '').trim() || attachments.some(list => (list?.length || 0) > 0);
}

/** Writes a pill's reason ('' or none: nothing to keep), only when it changed (the toggle observes it). */
export function markAutoCloseKeep(pill, reason) {
  if (!pill?.dataset) return;
  const value = reason ? String(reason) : '';
  if ((pill.dataset.autoCloseKeep || '') === value) return;
  if (value) pill.dataset.autoCloseKeep = value;
  else delete pill.dataset.autoCloseKeep;
}

const agents = ['cp', 'cxp', 'ocpv2', 'agy', 'mtc'].map(prefix => prefix + '-session-pill');
const excluded = ['asp-session-pill', 'sp-session-pill', 'sidepanel-tray-placeholder', 'ocpv2-session-pill-child'];
const unfinishedOrFailed = /^(?:running|waiting|error|errored|failed)$/i;
// The provider a pill's automation run belongs to, by the pill's own class (a run the server no longer
// keeps names no provider: ui-native-loop-router.js autoCloseNativeLoopTab).
const runProviders = { 'cp-session-pill': 'claude-code', 'cxp-session-pill': 'codex', 'ocpv2-session-pill': 'opencode', 'agy-session-pill': 'antigravity' };
const runProviderOf = pill => runProviders[Object.keys(runProviders).find(name => pill.classList.contains(name))] || null;

// Only direct provider pills can close. A collapsed Done column is still eligible.
export function canAutoClose(pill, tray) {
  if (pill.parentElement !== tray || pill.dataset.trayCol !== 'done' || pill.hidden || pill.style.display === 'none') return false;
  const classes = pill.classList;
  if (!agents.some(name => classes.contains(name)) || excluded.some(name => classes.contains(name))) return false;
  if (pill.querySelector('.cli-status-badge') || unfinishedOrFailed.test(pill.dataset.status) ||
      /\S+-pill-(?:error|errored|failed)(?:\s|$)/.test(pill.className)) return false;
  // The producer may have started another turn or queued a prompt before the next frame. A pill whose close
  // would destroy what the user cannot get back (a temporary chat, an unsent draft) says so (AUTO_CLOSE_KEEP_ATTR).
  return trayColumnOf(pill) === 'done' && !pill.hasQueuedWorkerPrompts?.() && !pill.keepFromAutoClose?.();
}

export function initTrayAutoClose(tray, button, storage, t, closeAutomationTab) {
  if (!button) return;
  // The standalone glass buttons have ID-scoped surfaces in styles.css.
  const style = button.ownerDocument.createElement('style');
  style.textContent = `
    :root { --topright-buttons: 298px; }
    #topright-auto-close-btn {
      width: 32px; height: 32px; border-radius: 10px;
      background: rgba(18, 18, 22, 0.65); border: 1px solid rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(var(--blur-heavy)) saturate(1.3);
      -webkit-backdrop-filter: blur(var(--blur-heavy)) saturate(1.3);
      box-shadow: var(--shadow-md), var(--shadow-highlight);
    }
    #topright-auto-close-btn:hover { background: rgba(24, 24, 30, 0.8); border-color: rgba(255, 255, 255, 0.1); }
  `;
  button.ownerDocument.head.append(style);

  let enabled = storage.getItem(KEYS.TRAY_AUTO_CLOSE) === 'true';
  const pending = new Map();
  let requested = new WeakSet();

  function cancel(pill) {
    clearTimeout(pending.get(pill));
    pending.delete(pill);
  }

  async function close(pill) {
    pending.delete(pill);
    if (!enabled || !canAutoClose(pill, tray) || requested.has(pill)) return;
    const x = pill.querySelector(':scope > .term-minimized-pill-close');
    if (x) {
      requested.add(pill); // Some close handlers remove the pill asynchronously.
      const runId = pill.getAutomationRunId?.();
      // A pill whose X destroys something (OpenCode's deletes the session) has a close of its own for this.
      if (!runId && !pill.detachForAutoClose) { x.click(); return; }
      // An idle automation also appears in Done. Its X is a deliberate stop.
      // Only the conditional completion path may dismiss it automatically.
      try {
        if (runId) await closeAutomationTab?.(runId, runProviderOf(pill));
        else await pill.detachForAutoClose();
      } finally { requested.delete(pill); }
    }
  }

  function reconcile(pill, immediate = false) {
    if (!canAutoClose(pill, tray)) {
      cancel(pill);
      requested.delete(pill);
    } else if (!requested.has(pill) && !pending.has(pill)) {
      if (immediate) close(pill);
      else pending.set(pill, setTimeout(() => close(pill), 1500));
    }
  }

  // The dispatcher can settle the result after the pill already entered Done.
  tray.addEventListener('worker-end-changed', ({ detail }) => {
    if (!enabled) return;
    for (const pill of tray.children) {
      if (pill.getAutomationRunId?.() === detail.runId) reconcile(pill);
    }
  });

  const observer = new MutationObserver(records => {
    const changed = new Set();
    for (const record of records) {
      if (record.type === 'childList' && record.target === tray) {
        for (const node of record.removedNodes) cancel(node);
        for (const node of record.addedNodes) if (node.nodeType === 1) changed.add(node);
      } else {
        // A complete round trip out of Done can be delivered in one observer batch.
        if (record.attributeName === 'data-tray-col' && record.oldValue === 'done') {
          cancel(record.target);
          requested.delete(record.target);
        }
        const pill = record.target.closest('.term-minimized-pill');
        if (pill?.parentElement === tray) changed.add(pill);
      }
    }
    for (const pill of changed) reconcile(pill);
  });

  function apply(immediate) {
    const label = t(enabled ? 'toolbar.trayAutoCloseOn' : 'toolbar.trayAutoCloseOff');
    button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(enabled));
    button.classList.toggle('active', enabled);
    if (enabled) {
      observer.observe(tray, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
        attributeFilter: ['data-tray-col', 'data-status', 'class', 'style', 'hidden', AUTO_CLOSE_KEEP_ATTR] });
      for (const pill of [...tray.children]) reconcile(pill, immediate);
    } else {
      observer.disconnect();
      requested = new WeakSet();
      for (const pill of pending.keys()) cancel(pill);
    }
  }
  apply(false);
  button.addEventListener('click', () => {
    enabled = !enabled;
    storage.setItem(KEYS.TRAY_AUTO_CLOSE, String(enabled));
    apply(true);
  });
}
