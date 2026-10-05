// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Context settings: the header cog and its popover
// The cog (in the panel header's actions) opens a popover with what the old
// context row showed and more: the context window and Compact, the connected
// tools, the versions, the session. One per panel (the main one and every
// sub-agent's), each on its own store; what it shows is decided in
// ocp-v2-context-model.js, this file only renders it, as elements and text.
//
// The popover is a child of <body>, fixed and placed from the cog's rectangle:
// the panel's overflow cannot clip it, and a resized or moved panel is all the
// same to it. It is built when it first opens and holds no state of its own:
// every render reads the store again.
// ─────────────────────────────────────────────────────────────────────────────

import { api, supports, onEvent, sdkVersion } from './ocp-v2-ws.js';
import { getDefaultStore } from './ocp-v2-state.js';
import { replyFailed, replyError } from './ocp-v2-caps.js';
import { boundReader, onRebind } from './ocp-v2-binding.js';
import { sessionCostOf } from './ocp-v2-tools-logic.js';
import { updateAvailableVersion } from './ocp-v2-status.js';
import { contextReading, contextMenuModel, isUnset } from './ocp-v2-context-model.js';

const LABEL = 'Context settings';
const WIDTH = 300;
const MARGIN = 8;   // kept clear of the viewport's edges
const GAP = 6;      // between the cog and the popover
const SVG_NS = 'http://www.w3.org/2000/svg';
const COG_PATH = 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z';

let _popSeq = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function cogIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', COG_PATH);
  const hub = document.createElementNS(SVG_NS, 'circle');
  hub.setAttribute('cx', '12');
  hub.setAttribute('cy', '12');
  hub.setAttribute('r', '3');
  svg.append(path, hub);
  return svg;
}

// One grammar for every section. A head: the title, and at most one action on
// its right. Then rows of one height: a label on the left, one value on the
// right edge. A value is text, a status (dot and word) or a text link; a missing
// one is muted. Nothing sits beside a row or under the rows.

function row(label, value, { tip = '', muted = false } = {}) {
  const r = el('div', 'ocpv2-ctxpop-row');
  r.appendChild(el('span', 'ocpv2-ctxpop-k', label));
  const v = typeof value === 'string' ? el('span', `ocpv2-ctxpop-v${muted ? ' ocpv2-ctxpop-muted' : ''}`, value) : value;
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
  const s = el('span', 'ocpv2-ctxpop-v ocpv2-ctxpop-status');
  s.appendChild(el('span', `ocpv2-ctxpop-dot${tone ? ` ocpv2-ctxpop-dot-${tone}` : ''}`));
  s.appendChild(el('span', '', word));
  return s;
}

function section(title, act = null) {
  const s = el('section', 'ocpv2-ctxpop-section');
  const head = el('div', 'ocpv2-ctxpop-head');
  head.appendChild(el('h3', 'ocpv2-ctxpop-title', title));
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
    const compact = action('ocpv2-ctxpop-btn', m.compact.label, 'compact');
    compact.disabled = m.compact.disabled;
    compact.dataset.tooltip = m.compact.hint;
    compact.setAttribute('aria-description', m.compact.hint);
    compactCell = el('span', 'ocpv2-ctxpop-act');
    if (m.compact.disabled) compactCell.dataset.tooltip = m.compact.hint;
    compactCell.appendChild(compact);
  }

  const ctx = section('Context window', compactCell);
  const bar = el('div', 'ocpv2-ctxpop-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Context used');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  if (m.context.pct != null) bar.setAttribute('aria-valuenow', String(Math.round(m.context.pct)));
  bar.setAttribute('aria-valuetext', m.context.headline);
  const fill = el('div', `ocpv2-ctxpop-fill${m.pressure ? ` ocpv2-ctxpop-${m.pressure}` : ''}`);
  fill.style.width = m.context.pct == null ? '0%' : `${m.context.pct}%`;
  bar.appendChild(fill);
  ctx.appendChild(bar);
  // Under the bar, flanking it: used / window on the left, the share on the right.
  const usage = el('div', 'ocpv2-ctxpop-usage');
  usage.appendChild(el('span', `ocpv2-ctxpop-used${isUnset(m.context.usage) ? ' ocpv2-ctxpop-muted' : ''}`, m.context.usage));
  if (m.context.share) usage.appendChild(el('span', 'ocpv2-ctxpop-share', m.context.share));
  if (m.context.tip) usage.dataset.tooltip = m.context.tip;
  ctx.appendChild(usage);
  for (const r of m.context.rows) ctx.appendChild(modelRow(r));
  frag.appendChild(ctx);

  const tools = section('Connected tools', m.tools.manage ? action('ocpv2-ctxpop-link', 'Manage', 'manage', 'Manage servers') : null);
  for (const s of m.tools.servers) {
    const line = row(s.name, status(s.tone, s.word), { tip: s.tip });
    line.classList.add('ocpv2-ctxpop-row-server');
    tools.appendChild(line);
  }
  if (m.tools.note) tools.appendChild(row('MCP servers', m.tools.note[0], { tip: m.tools.note[1], muted: true }));
  frag.appendChild(tools);

  const versions = section('Versions');
  for (const r of m.versions) versions.appendChild(modelRow(r));
  frag.appendChild(versions);

  const session = section('Session');
  if (m.session.id) {
    // The whole value copies the id, and says so in its place.
    const copy = action(`ocpv2-ctxpop-v ocpv2-ctxpop-copy${copied ? ' ocpv2-ctxpop-copied' : ''}`, copied ? 'Copied' : m.session.id, 'copy-session', 'Copy session ID');
    copy.dataset.value = m.session.id;
    session.appendChild(row('Session ID', copy, { tip: `${m.session.id}\nClick to copy` }));
  } else {
    session.appendChild(row('Session ID', 'Not started', { muted: true }));
  }
  for (const r of m.session.rows) session.appendChild(modelRow(r));
  if (m.session.autoAccept) {
    // The switch is its own value: the word, with a dot while it is on.
    const a = m.session.autoAccept;
    const toggle = action('ocpv2-ctxpop-link ocpv2-ctxpop-switch', '', 'autoaccept', 'Auto-accept permission requests');
    if (a.on) toggle.appendChild(el('span', 'ocpv2-ctxpop-dot ocpv2-ctxpop-dot-warn'));
    toggle.appendChild(el('span', '', a.word));
    toggle.setAttribute('aria-pressed', a.on ? 'true' : 'false');
    toggle.disabled = a.disabled;
    const cell = el('span', 'ocpv2-ctxpop-act');
    cell.appendChild(toggle);
    session.appendChild(row('Auto-accept', cell, { tip: a.hint }));
  }
  frag.appendChild(session);

  return frag;
}

// The agent a row names: the one the composer is on, and in a sub-agent's
// panel the one its newest answer ran as.
function agentOf(s, hint) {
  if (hint) return String(hint);
  if (s.parentSessionId) {
    const order = Array.isArray(s.messageOrder) ? s.messageOrder : [];
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const info = s.messages?.get?.(order[i])?.info;
      if (info?.role === 'assistant' && info.agent) return String(info.agent);
    }
  }
  return s.agent || '';
}

function turnsOf(s) {
  let turns = 0;
  for (const msg of s.messages?.values?.() || []) {
    if ((msg?.role || msg?.info?.role) === 'user') turns += 1;
  }
  return turns;
}

/**
 * Puts the cog first in `actionsEl` (the header's buttons) of `panelEl`.
 *   opts.compact      the panel's compaction (createCompactControl); without it there is no Compact
 *   opts.autoAccept   the auto-accept switch (createAutoAcceptControl); without it there is no row
 *   opts.onManage()   opens the MCP manager; without it there is no "Manage"
 *   opts.onOpen()     the popover is about to open (the panel closes its other menus)
 *   opts.agent()      the agent this panel's session runs as, when the panel knows better than the store
 * Returns { element, open(), close({ focus }), isOpen(), sync(), destroy() }.
 */
export function mountContextMenu(actionsEl, panelEl, store = getDefaultStore(), opts = {}) {
  if (!actionsEl || !panelEl) return { element: null, open() {}, close() {}, isOpen: () => false, sync() {}, destroy() {} };

  const popId = `ocpv2-context-popover-${++_popSeq}`;
  const cog = el('button', 'ocpv2-btn ocpv2-cog-btn');
  cog.type = 'button';
  cog.setAttribute('data-tooltip', LABEL);
  cog.setAttribute('data-tooltip-pos', 'bottom');
  cog.setAttribute('aria-label', LABEL);
  cog.setAttribute('aria-haspopup', 'dialog');
  cog.setAttribute('aria-expanded', 'false');
  cog.setAttribute('aria-controls', popId);
  cog.appendChild(cogIcon());
  const dot = el('span', 'ocpv2-cog-dot');
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
  // The MCP servers of the session on screen, read when the popover opens.
  // They belong to the binding they were read on.
  let mcp = { loaded: false, rows: [], error: '' };
  const readMcp = boundReader(store);

  function data() {
    const s = store.getState();
    return {
      gauge: s.contextGauge,
      model: s.model,
      compact: opts.compact ? opts.compact.view() : null,
      mcp: { supported: supports('mcp:status'), ...mcp },
      canManage: typeof opts.onManage === 'function',
      // A sub-agent's store hears the version only on a status change; the
      // main one has it from init, and there is one OpenCode behind both.
      serverVersion: s.serverVersion || getDefaultStore().getState().serverVersion || '',
      sdkVersion: sdkVersion(),
      updateAvailable: updateAvailableVersion(),
      sessionId: s.sessionId || '',
      folder: s.cwd || s.sessionInfo?.directory || '',
      agent: agentOf(s, typeof opts.agent === 'function' ? opts.agent() : ''),
      turns: turnsOf(s),
      cost: sessionCostOf(s),
      autoAccept: opts.autoAccept ? { on: !!s.autoAccept } : null,
    };
  }

  // boundReader takes the binding before the request: an answer for a session
  // the panel has left is dropped.
  function loadMcp() {
    if (!supports('mcp:status')) return;
    readMcp(
      (at) => api.mcpStatus({ sessionId: at.sessionId, cwd: at.cwd || undefined }).catch((err) => ({ ok: false, error: err?.message })),
      (res) => {
        mcp = replyFailed(res)
          ? { loaded: true, rows: [], error: replyError(res, 'Could not read the MCP servers') }
          : { loaded: true, rows: Array.isArray(res?.data) ? res.data : [], error: '' };
        sync();
      },
    ).catch(() => {});
  }

  // A label or a value its ellipsis cut says the whole of it on hover.
  function tipClipped() {
    for (const cell of pop.querySelectorAll('.ocpv2-ctxpop-k, .ocpv2-ctxpop-v')) {
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
    const reading = contextReading(store.getState().contextGauge);
    const className = `ocpv2-cog-dot${reading.pressure ? ` ocpv2-cog-dot-${reading.pressure}` : ''}`;
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
    const copied = Date.now() < copiedUntil;
    const model = contextMenuModel(data());
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

  // A streaming turn changes the store many times a second: one render for them.
  function scheduleSync() {
    if (syncTimer || destroyed) return;
    syncTimer = setTimeout(() => { syncTimer = 0; sync(); }, 80);
  }

  function onClick(e) {
    const btn = e.target.closest?.('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'copy-session') {
      const id = btn.dataset.value || '';
      if (!id || !navigator.clipboard?.writeText) return;
      navigator.clipboard.writeText(id).then(() => {
        copiedUntil = Date.now() + 1400;
        sync();
        setTimeout(sync, 1450);
      }).catch(() => {});
      return;
    }
    // Compact and the switch answer in the popover (the button and the word
    // say so); the manager is a surface of its own, which the popover would cover.
    if (act === 'compact') { opts.compact?.run(); sync(); return; }
    if (act === 'autoaccept') { Promise.resolve(opts.autoAccept?.toggle()).finally(sync); return; }
    if (act === 'manage') {
      close();
      try { opts.onManage?.(); } catch { /* the manager's problem */ }
    }
  }

  function onOutside(e) {
    if (pop?.contains(e.target) || cog.contains(e.target)) return;
    close();
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    // The popover takes this Escape: it must not also stop a turn or close a menu.
    e.preventDefault();
    e.stopPropagation();
    close({ focus: true });
  }

  // The panel went (hidden, minimized, closed) with the popover open.
  function tick() {
    if (!cog.isConnected || !panelEl.classList.contains('ocpv2-open')) { close(); return; }
    sync();
  }

  function openMenu() {
    if (open || destroyed || !cog.isConnected) return;
    if (!pop) {
      pop = el('div', 'ocpv2-ctxpop');
      pop.id = popId;
      pop.tabIndex = -1;
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', LABEL);
      pop.addEventListener('click', onClick);
    }
    open = true;
    sig = '';
    // One menu at a time: the panel closes its session menu and its manager.
    try { opts.onOpen?.(); } catch { /* the panel's problem */ }
    // Above the panel wherever the layout put it.
    pop.style.zIndex = String((parseInt(getComputedStyle(panelEl).zIndex, 10) || 10001) + 1);
    document.body.appendChild(pop);
    cog.setAttribute('aria-expanded', 'true');
    // Its hover label would sit on the popover.
    cog.removeAttribute('data-tooltip');
    loadMcp();
    sync();
    place();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    if (typeof ResizeObserver === 'function') {
      watch = new ResizeObserver(place);
      watch.observe(panelEl);
    }
    // Most changes arrive through the store; this catches the rest (an update
    // notice, the versions after a reconnect) and a panel that went away.
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
    document.removeEventListener('keydown', onKey, true);
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

  // The gauge writes its reading to the store (context:gauge): that is what
  // keeps the dot, and an open popover, current.
  const unsubscribeStore = store.subscribe((event) => {
    const type = event?.type;
    if (type === 'context:gauge' || type === 'session:set') paintCog();
    if (open) scheduleSync();
  });
  // Bound to another session: the servers were the previous session's.
  const unsubscribeRebind = onRebind(store, () => {
    readMcp.cancel();
    mcp = { loaded: false, rows: [], error: '' };
    if (open) { loadMcp(); scheduleSync(); }
  });
  const unsubscribeEvents = onEvent((eventType) => {
    if (open && eventType === 'mcp.tools.changed') loadMcp();
  });
  const unsubscribeCompact = opts.compact?.onChange?.(() => { if (open) scheduleSync(); });
  paintCog();

  return {
    element: cog,
    open: openMenu,
    close,
    isOpen: () => open,
    sync,
    destroy() {
      close();
      destroyed = true;
      try { unsubscribeStore(); } catch {}
      try { unsubscribeRebind(); } catch {}
      try { unsubscribeEvents(); } catch {}
      try { unsubscribeCompact?.(); } catch {}
      readMcp.cancel();
      cog.remove();
      pop = null;
    },
  };
}
