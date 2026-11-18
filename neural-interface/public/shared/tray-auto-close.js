import { KEYS } from './constants.js';
import { trayColumnOf } from './ui-tray-columns.js';

const agents = ['cp', 'cxp', 'ocpv2', 'agy', 'mtc'].map(prefix => prefix + '-session-pill');
const excluded = ['asp-session-pill', 'sp-session-pill', 'sidepanel-tray-placeholder', 'ocpv2-session-pill-child'];
const unfinishedOrFailed = /^(?:running|waiting|error|errored|failed)$/i;

// Only direct provider pills can close. A collapsed Done column is still eligible.
export function canAutoClose(pill, tray) {
  if (pill.parentElement !== tray || pill.dataset.trayCol !== 'done' || pill.hidden || pill.style.display === 'none') return false;
  const classes = pill.classList;
  if (!agents.some(name => classes.contains(name)) || excluded.some(name => classes.contains(name))) return false;
  if (pill.querySelector('.cli-status-badge') || unfinishedOrFailed.test(pill.dataset.status) ||
      /\S+-pill-(?:error|errored|failed)(?:\s|$)/.test(pill.className)) return false;
  // The producer may have started another turn before the tray's next animation frame.
  return trayColumnOf(pill) === 'done';
}

export function initTrayAutoClose(tray, button, storage, t) {
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

  function close(pill) {
    pending.delete(pill);
    if (!enabled || !canAutoClose(pill, tray) || requested.has(pill)) return;
    const x = pill.querySelector(':scope > .term-minimized-pill-close');
    if (x) {
      requested.add(pill); // Some close handlers remove the pill asynchronously.
      x.click();
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
        attributeFilter: ['data-tray-col', 'data-status', 'class', 'style', 'hidden'] });
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
