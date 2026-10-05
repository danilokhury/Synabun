// SynaBun — Codex Panel: Context settings, the header cog and its popover
//
// The cog (first of the header's buttons) opens a popover with what the old
// context bar showed and more: the context window and Compact, the connected
// tools, the versions, the session and its account. What it shows is decided in
// cdx-context-model.js; this file only renders it, as elements and text.
//
// The popover is a child of <body>, fixed and placed from the cog's rectangle:
// the panel's overflow cannot clip it, and a resized or moved panel is all the
// same to it. It holds no state of its own: every render asks the panel for the
// active tab's values again, so it follows the tab on screen.

import { contextReading, contextMenuModel, isUnset } from './cdx-context-model.js';

const LABEL = 'Context settings';
const WIDTH = 300;
const MARGIN = 8;   // kept clear of the viewport's edges
const GAP = 6;      // between the cog and the popover
const SVG_NS = 'http://www.w3.org/2000/svg';
const COG_PATH = 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function cogIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const hub = document.createElementNS(SVG_NS, 'circle');
  hub.setAttribute('cx', '12');
  hub.setAttribute('cy', '12');
  hub.setAttribute('r', '3');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', COG_PATH);
  svg.append(hub, path);
  return svg;
}

// One grammar for every section. A head: the title, and at most one action on
// its right. Then rows of one height: a label on the left, one value on the
// right edge. A value is text, a status (dot and word) or a text link; a missing
// one is muted. Nothing sits beside a row or under the rows.

function row(label, value, { tip = '', muted = false } = {}) {
  const r = el('div', 'cxp-ctxpop-row');
  r.appendChild(el('span', 'cxp-ctxpop-k', label));
  const v = typeof value === 'string' ? el('span', `cxp-ctxpop-v${muted ? ' cxp-ctxpop-muted' : ''}`, value) : value;
  if (tip) v.dataset.tooltip = tip;
  r.appendChild(v);
  return r;
}

// A [label, value, hover?] row of the model.
function modelRow([label, value, tip]) {
  return row(label, value, { tip, muted: isUnset(value) });
}

function action(className, label, act, name = '') {
  const b = el('button', className, label);
  b.type = 'button';
  b.dataset.act = act;
  if (name) b.setAttribute('aria-label', name);
  return b;
}

function status(tone, word) {
  const s = el('span', 'cxp-ctxpop-v cxp-ctxpop-status');
  s.appendChild(el('span', `cxp-ctxpop-dot${tone ? ` cxp-ctxpop-dot-${tone}` : ''}`));
  s.appendChild(el('span', '', word));
  return s;
}

function section(title, act = null) {
  const s = el('section', 'cxp-ctxpop-section');
  const head = el('div', 'cxp-ctxpop-head');
  head.appendChild(el('h3', 'cxp-ctxpop-title', title));
  if (act) head.appendChild(act);
  s.appendChild(head);
  return s;
}

function build(m, { copied = false } = {}) {
  const frag = document.createDocumentFragment();

  // Compact says what it does, or why it cannot, on hover. A disabled button
  // takes no hover in every engine, so its cell says it then.
  let compactCell = null;
  if (m.compact) {
    const compact = action('cxp-ctxpop-btn', m.compact.label, 'compact');
    compact.disabled = m.compact.disabled;
    compact.dataset.tooltip = m.compact.hint;
    compact.setAttribute('aria-description', m.compact.hint);
    compactCell = el('span', 'cxp-ctxpop-act');
    if (m.compact.disabled) compactCell.dataset.tooltip = m.compact.hint;
    compactCell.appendChild(compact);
  }

  const ctx = section('Context window', compactCell);
  const bar = el('div', 'cxp-ctxpop-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Context used');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  if (m.context.pct != null) bar.setAttribute('aria-valuenow', String(Math.round(m.context.pct)));
  bar.setAttribute('aria-valuetext', m.context.headline);
  const fill = el('div', `cxp-ctxpop-fill${m.pressure ? ` cxp-ctxpop-${m.pressure}` : ''}`);
  fill.style.width = m.context.pct == null ? '0%' : `${m.context.pct}%`;
  bar.appendChild(fill);
  ctx.appendChild(bar);
  // Under the bar, flanking it: used / window on the left, the share on the right.
  const usage = el('div', 'cxp-ctxpop-usage');
  usage.appendChild(el('span', `cxp-ctxpop-used${isUnset(m.context.usage) ? ' cxp-ctxpop-muted' : ''}`, m.context.usage));
  if (m.context.share) usage.appendChild(el('span', 'cxp-ctxpop-share', m.context.share));
  if (m.context.tip) usage.dataset.tooltip = m.context.tip;
  ctx.appendChild(usage);
  for (const r of m.context.rows) ctx.appendChild(modelRow(r));
  frag.appendChild(ctx);

  const tools = section('Connected tools', m.tools.manage ? action('cxp-ctxpop-link', 'Manage', 'manage', 'Manage MCP servers') : null);
  for (const s of m.tools.servers) {
    const line = row(s.name, status(s.tone, s.word), { tip: s.tip });
    line.classList.add('cxp-ctxpop-row-server');
    tools.appendChild(line);
  }
  if (m.tools.note) tools.appendChild(row('MCP servers', m.tools.note[0], { tip: m.tools.note[1], muted: true }));
  frag.appendChild(tools);

  const versions = section('Versions');
  for (const r of m.versions) versions.appendChild(modelRow(r));
  frag.appendChild(versions);

  const session = section('Session', m.session.settings ? action('cxp-ctxpop-link', 'Settings', 'settings', 'Codex settings') : null);
  if (m.session.id) {
    // The whole value copies the id, and says so in its place.
    const copy = action(`cxp-ctxpop-v cxp-ctxpop-copy${copied ? ' cxp-ctxpop-copied' : ''}`, copied ? 'Copied' : m.session.id, 'copy-thread', 'Copy thread ID');
    copy.dataset.value = m.session.id;
    session.appendChild(row('Thread ID', copy, { tip: `${m.session.id}\nClick to copy` }));
  } else {
    session.appendChild(row('Thread ID', 'Not started', { muted: true }));
  }
  for (const r of m.session.rows) session.appendChild(modelRow(r));
  if (m.session.account) {
    // The account is its own switch: the value opens the panel's account menu.
    const pick = action('cxp-ctxpop-v cxp-ctxpop-link', m.session.account.label, 'account', 'Switch ChatGPT account');
    session.appendChild(row('Account', pick, { tip: m.session.account.tip }));
  }
  frag.appendChild(session);

  return frag;
}

/**
 * Puts the cog first in `actionsEl` (the header's buttons) of `panelEl`.
 *   opts.reading()     the active tab's { usedTokens, contextWindow } for the dot;
 *                      null while the values at hand are another tab's
 *   opts.data()        the active tab's values for contextMenuModel(); null likewise
 *   opts.onOpen()      the popover is about to open (the panel closes its other
 *                      menus and reads what the tab's state does not hold)
 *   opts.onCompact()   the panel's compaction; without it there is no Compact
 *   opts.onManage()    opens the MCP servers; without it there is no "Manage"
 *   opts.onSettings()  opens Codex settings; without it there is no "Settings"
 *   opts.onAccount()   opens the account menu; without it there is no Account row
 * Returns { element, open(), close({ focus }), isOpen(), sync(), destroy() }.
 */
export function mountContextMenu(actionsEl, panelEl, opts = {}) {
  if (!actionsEl || !panelEl) return { element: null, open() {}, close() {}, isOpen: () => false, sync() {}, destroy() {} };

  const popId = 'cxp-context-popover';
  const cog = el('button', 'cxp-btn cxp-cog-btn');
  cog.id = 'cxp-context-cog';
  cog.type = 'button';
  cog.setAttribute('data-tooltip', LABEL);
  cog.setAttribute('data-tooltip-pos', 'bottom');
  cog.setAttribute('aria-label', LABEL);
  cog.setAttribute('aria-haspopup', 'dialog');
  cog.setAttribute('aria-expanded', 'false');
  cog.setAttribute('aria-controls', popId);
  cog.appendChild(cogIcon());
  const dot = el('span', 'cxp-cog-dot');
  dot.hidden = true;
  cog.appendChild(dot);
  // Right after New, the same place as in the other side panels: New, cog, then the window buttons.
  actionsEl.insertBefore(cog, actionsEl.firstElementChild ? actionsEl.firstElementChild.nextSibling : null);

  let pop = null;
  let open = false;
  let destroyed = false;
  let sig = '';           // what is rendered, so an unchanged model touches nothing
  let timer = null;
  let syncTimer = 0;
  let watch = null;
  let copiedUntil = 0;

  function data() {
    const d = typeof opts.data === 'function' ? opts.data() : null;
    if (!d) return null;
    return {
      ...d,
      compact: typeof opts.onCompact === 'function' ? d.compact : null,
      account: typeof opts.onAccount === 'function' ? d.account : null,
      canManage: typeof opts.onManage === 'function',
      canSettings: typeof opts.onSettings === 'function',
    };
  }

  // A label or a value its ellipsis cut says the whole of it on hover.
  function tipClipped() {
    for (const cell of pop.querySelectorAll('.cxp-ctxpop-k, .cxp-ctxpop-v')) {
      if (!cell.dataset.tooltip && cell.scrollWidth > cell.clientWidth) cell.dataset.tooltip = cell.textContent;
    }
  }

  // Below the cog, its right edge on the cog's; above it when there is more room
  // there; always inside the viewport, scrolling inside when it is taller.
  function place() {
    if (!open || !pop) return;
    const r = cog.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(0, Math.min(WIDTH, vw - MARGIN * 2));
    pop.style.width = `${width}px`;
    const below = vh - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const up = below < 220 && above > below;
    pop.style.maxHeight = `${Math.max(120, up ? above : below)}px`;
    const height = pop.offsetHeight;
    const left = Math.max(MARGIN, Math.min(r.right - width, vw - width - MARGIN));
    const top = up
      ? Math.max(MARGIN, r.top - GAP - height)
      : Math.max(MARGIN, Math.min(r.bottom + GAP, vh - MARGIN - height));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    // Once it has its width: only now is a cut value known.
    tipClipped();
  }

  // The cog's only decoration: a dot from 80% of the window, stronger from 90%.
  function paintCog() {
    const gauge = typeof opts.reading === 'function' ? opts.reading() : undefined;
    if (gauge === null) return;   // another tab's update: the dot is the active tab's
    const reading = contextReading(gauge);
    const className = `cxp-cog-dot${reading.pressure ? ` cxp-cog-dot-${reading.pressure}` : ''}`;
    if (dot.className !== className) dot.className = className;
    dot.hidden = !reading.pressure;
    const label = reading.pressure ? `${LABEL}, context ${Math.round(reading.pct)}% used` : LABEL;
    if (cog.getAttribute('aria-label') !== label) cog.setAttribute('aria-label', label);
  }

  /** Paints the cog and, while the popover is open, its content. */
  function sync() {
    if (destroyed) return;
    paintCog();
    if (!open || !pop) return;
    const d = data();
    if (!d) return;   // another tab's update: what is shown stays
    const copied = Date.now() < copiedUntil;
    const model = contextMenuModel(d);
    const next = `${JSON.stringify(model)}|${copied}`;
    if (next === sig) return;
    sig = next;
    const focused = pop.contains(document.activeElement) ? document.activeElement.dataset?.act || '' : null;
    pop.replaceChildren(build(model, { copied }));
    // A re-render replaces the control that had the focus: it goes to the same
    // control, or to the popover when that one is now disabled.
    if (focused) (pop.querySelector(`[data-act="${focused}"]:not(:disabled)`) || pop).focus({ preventScroll: true });
    place();
  }

  // A streaming turn reports many times a second: one render for them.
  function scheduleSync() {
    if (destroyed) return;
    if (!open) { paintCog(); return; }
    if (syncTimer) return;
    syncTimer = setTimeout(() => { syncTimer = 0; sync(); }, 80);
  }

  function run(fn) {
    try { fn?.(); } catch { /* the panel's problem */ }
  }

  function onClick(e) {
    const btn = e.target.closest?.('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'copy-thread') {
      const id = btn.dataset.value || '';
      if (!id || !navigator.clipboard?.writeText) return;
      navigator.clipboard.writeText(id).then(() => {
        copiedUntil = Date.now() + 1400;
        sync();
        setTimeout(sync, 1450);
      }).catch(() => {});
      return;
    }
    // Compact answers in the popover (its button says so); the settings, the
    // servers and the account menu are surfaces of the panel, which the popover
    // would cover.
    if (act === 'compact') { run(opts.onCompact); sync(); return; }
    const surface = act === 'manage' ? opts.onManage : act === 'settings' ? opts.onSettings : act === 'account' ? opts.onAccount : null;
    if (!surface) return;
    close();
    run(surface);
  }

  function onOutside(e) {
    if (pop?.contains(e.target) || cog.contains(e.target)) return;
    close();
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    // The popover takes this Escape: it must not also stop a turn or close a menu.
    e.preventDefault();
    e.stopImmediatePropagation();
    close({ focus: true });
  }

  // The panel went (hidden, minimized, slid away, closed) with the popover open.
  function tick() {
    if (!cog.isConnected || !panelEl.classList.contains('open')) { close(); return; }
    sync();
  }

  function openMenu() {
    if (open || destroyed || !cog.isConnected) return;
    if (!pop) {
      pop = el('div', 'cxp-ctxpop');
      pop.id = popId;
      pop.tabIndex = -1;
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', LABEL);
      pop.addEventListener('click', onClick);
    }
    open = true;
    sig = '';
    run(opts.onOpen);
    // Above the panel wherever the layout put it.
    pop.style.zIndex = String((parseInt(getComputedStyle(panelEl).zIndex, 10) || 205) + 1);
    document.body.appendChild(pop);
    cog.setAttribute('aria-expanded', 'true');
    // Its hover label would sit on the popover.
    cog.removeAttribute('data-tooltip');
    sync();
    place();
    document.addEventListener('pointerdown', onOutside, true);
    // At the window, ahead of the panel's and the page's own Escape handlers.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    if (typeof ResizeObserver === 'function') {
      watch = new ResizeObserver(place);
      watch.observe(panelEl);
    }
    // Most changes arrive through the panel's own update paths; this catches
    // the rest and a panel that went away.
    timer = setInterval(tick, 1000);
    pop.focus({ preventScroll: true });
  }

  /** Closes the popover. `focus` puts the focus back on the cog (Escape). */
  function close({ focus = false } = {}) {
    if (!open) return;
    open = false;
    clearInterval(timer);
    timer = null;
    clearTimeout(syncTimer);
    syncTimer = 0;
    watch?.disconnect();
    watch = null;
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    pop?.remove();
    cog.setAttribute('aria-expanded', 'false');
    cog.setAttribute('data-tooltip', LABEL);
    if (focus && cog.isConnected) cog.focus();
  }

  cog.addEventListener('click', (event) => {
    event.stopPropagation();
    if (open) close(); else openMenu();
  });
  paintCog();

  return {
    element: cog,
    open: openMenu,
    close,
    isOpen: () => open,
    // The panel's update paths call this: the dot at once, an open popover soon.
    sync: scheduleSync,
    destroy() {
      close();
      destroyed = true;
      cog.remove();
      pop = null;
    },
  };
}
