// ── Context settings: the header cog and its popover ──
// The cog (#cp-cog-btn in the panel header) opens a popover with what the old
// context row showed and more: the context window and Compact, the connected
// tools, the versions, the session. It shows the active tab, from
// contextMenuModel(); this file only renders it, as elements and text.
//
// The popover is a child of <body>, fixed and placed from the cog's rectangle:
// the panel's overflow cannot clip it, and a dragged, resized or docked panel is
// all the same to it. It is built when it first opens, so nothing may assume its
// elements exist: state lives in the tab (and in the monolith's _compactingUI),
// and every render reads it again.

import { cpCtx } from './cp-ctx.js';
import { contextReading, contextMenuModel, isUnset } from './cp-context-model.js';

const POP_ID = 'cp-context-popover';
const LABEL = 'Context settings';
const WIDTH = 300;
const MARGIN = 8;   // kept clear of the viewport's edges
const GAP = 6;      // between the cog and the popover

let _pop = null;
let _open = false;
let _sig = '';          // what is rendered, so an unchanged model touches nothing
let _timer = null;
let _watch = null;
let _tooltip = '';      // the cog's data-tooltip, taken off while the popover is open
let _copiedUntil = 0;

function cog() { return cpCtx?.panel()?.querySelector('#cp-cog-btn') || null; }

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// One grammar for every section. A head: the title, and at most one action on
// its right. Then rows of one height: a label on the left, one value on the
// right edge. A value is text, a status (dot and word) or a text link; a missing
// one is muted. Nothing sits beside a row or under the rows.

function row(label, value, { tip = '', muted = false } = {}) {
  const r = el('div', 'cp-ctxpop-row');
  r.appendChild(el('span', 'cp-ctxpop-k', label));
  const v = typeof value === 'string' ? el('span', `cp-ctxpop-v${muted ? ' cp-ctxpop-muted' : ''}`, value) : value;
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

function section(title, act = null) {
  const s = el('section', 'cp-ctxpop-section');
  const head = el('div', 'cp-ctxpop-head');
  head.appendChild(el('h3', 'cp-ctxpop-title', title));
  if (act) head.appendChild(act);
  s.appendChild(head);
  return s;
}

function build(m, { copied = false } = {}) {
  const frag = document.createDocumentFragment();

  // Compact says what it does, or why it cannot, on hover. A disabled button
  // takes no hover in every engine, so its cell says it then.
  const compact = action('cp-ctxpop-btn', m.compact.label, 'compact');
  compact.id = 'cp-compact-btn';
  compact.disabled = m.compact.disabled;
  compact.dataset.tooltip = m.compact.hint;
  compact.setAttribute('aria-description', m.compact.hint);
  const compactCell = el('span', 'cp-ctxpop-act');
  if (m.compact.disabled) compactCell.dataset.tooltip = m.compact.hint;
  compactCell.appendChild(compact);

  const ctx = section('Context window', compactCell);
  const bar = el('div', 'cp-ctxpop-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Context used');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  if (m.context.pct != null) bar.setAttribute('aria-valuenow', String(Math.round(m.context.pct)));
  bar.setAttribute('aria-valuetext', m.context.headline);
  const fill = el('div', `cp-ctxpop-fill${m.pressure ? ` cp-ctxpop-${m.pressure}` : ''}`);
  fill.style.width = m.context.pct == null ? '0%' : `${m.context.pct}%`;
  bar.appendChild(fill);
  ctx.appendChild(bar);
  // Under the bar, flanking it: used / window on the left, the share on the right.
  const usage = el('div', 'cp-ctxpop-usage');
  usage.appendChild(el('span', `cp-ctxpop-used${isUnset(m.context.usage) ? ' cp-ctxpop-muted' : ''}`, m.context.usage));
  if (m.context.share) usage.appendChild(el('span', 'cp-ctxpop-share', m.context.share));
  if (m.context.tip) usage.dataset.tooltip = m.context.tip;
  ctx.appendChild(usage);
  for (const r of m.context.rows) ctx.appendChild(modelRow(r));
  ctx.appendChild(row('Breakdown', action('cp-ctxpop-link', 'Show', 'breakdown', 'Show breakdown')));
  frag.appendChild(ctx);

  const tools = section('Connected tools', action('cp-ctxpop-link', 'Manage', 'mcp', 'Manage servers'));
  for (const s of m.tools.servers) {
    const status = el('span', 'cp-ctxpop-v cp-ctxpop-status');
    status.appendChild(el('span', `cp-ctxpop-dot${s.tone ? ` cp-ctxpop-dot-${s.tone}` : ''}`));
    status.appendChild(el('span', '', s.detail ? `${s.word} · ${s.detail}` : s.word));
    const line = row(s.name, status);
    line.classList.add('cp-ctxpop-row-server');
    tools.appendChild(line);
  }
  if (m.tools.note) tools.appendChild(row('MCP servers', m.tools.note, { muted: true }));
  for (const r of m.tools.totals) tools.appendChild(modelRow(r));
  frag.appendChild(tools);

  const versions = section('Versions');
  for (const r of m.versions) versions.appendChild(modelRow(r));
  frag.appendChild(versions);

  const session = section('Session', action('cp-ctxpop-link', 'Settings', 'session', 'Session settings'));
  if (m.session.id) {
    // The whole value copies the id, and says so in its place.
    const copy = action(`cp-ctxpop-v cp-ctxpop-copy${copied ? ' cp-ctxpop-copied' : ''}`, copied ? 'Copied' : m.session.id, 'copy-session', 'Copy session ID');
    copy.dataset.value = m.session.id;
    session.appendChild(row('Session ID', copy, { tip: `${m.session.id}\nClick to copy` }));
  } else {
    session.appendChild(row('Session ID', 'Not started', { muted: true }));
  }
  for (const r of m.session.rows) session.appendChild(modelRow(r));
  if (m.session.hasBackground) session.appendChild(row('Tasks', action('cp-ctxpop-link', 'Show', 'tasks', 'Show tasks')));
  frag.appendChild(session);

  return frag;
}

// A label or a value its ellipsis cut says the whole of it on hover.
function tipClipped() {
  for (const cell of _pop.querySelectorAll('.cp-ctxpop-k, .cp-ctxpop-v')) {
    if (!cell.dataset.tooltip && cell.scrollWidth > cell.clientWidth) cell.dataset.tooltip = cell.textContent;
  }
}

// Below the cog, its right edge on the cog's; above it when there is more room
// there; always inside the viewport, scrolling inside when it is taller.
function place() {
  const $cog = cog();
  if (!_open || !_pop || !$cog) return;
  const r = $cog.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.max(0, Math.min(WIDTH, vw - MARGIN * 2));
  _pop.style.width = `${width}px`;
  const below = vh - r.bottom - GAP - MARGIN;
  const above = r.top - GAP - MARGIN;
  const up = below < 220 && above > below;
  _pop.style.maxHeight = `${Math.max(120, up ? above : below)}px`;
  const height = _pop.offsetHeight;
  const left = Math.max(MARGIN, Math.min(r.right - width, vw - width - MARGIN));
  const top = up
    ? Math.max(MARGIN, r.top - GAP - height)
    : Math.max(MARGIN, Math.min(r.bottom + GAP, vh - MARGIN - height));
  _pop.style.left = `${Math.round(left)}px`;
  _pop.style.top = `${Math.round(top)}px`;
  // Once it has its width: only now is a cut value known.
  tipClipped();
}

// The cog's only decoration: a dot from 80% of the window, stronger from 90%.
function paintCog(reading) {
  const $cog = cog();
  const dot = $cog?.querySelector('.cp-cog-dot');
  if (!dot) return;
  dot.hidden = !reading.pressure;
  dot.className = `cp-cog-dot${reading.pressure ? ` cp-cog-dot-${reading.pressure}` : ''}`;
  $cog.setAttribute('aria-label', reading.pressure ? `${LABEL}, context ${Math.round(reading.pct)}% used` : LABEL);
}

/** Paints the cog for `tab` and, while the popover is open, its content. Other tabs are ignored. */
export function syncContextMenu(tab) {
  if (!cpCtx || !tab || tab !== cpCtx.activeTab()) return;
  const showing = _open && !!_pop;
  let data;
  try { data = cpCtx.contextMenuData(tab, { full: showing }); } catch { return; }
  paintCog(contextReading(data));
  if (!showing) return;
  const copied = Date.now() < _copiedUntil;
  const model = contextMenuModel(data);
  const sig = `${JSON.stringify(model)}|${copied}`;
  if (sig === _sig) return;
  _sig = sig;
  const focused = _pop.contains(document.activeElement) ? document.activeElement.dataset?.act || '' : null;
  _pop.replaceChildren(build(model, { copied }));
  // A re-render replaces the control that had the focus: it goes to the same
  // control, or to the popover when that one is now disabled.
  if (focused) (_pop.querySelector(`[data-act="${focused}"]:not(:disabled)`) || _pop).focus({ preventScroll: true });
  place();
}

function onClick(e) {
  const btn = e.target.closest?.('[data-act]');
  if (!btn || btn.disabled) return;
  const tab = cpCtx.activeTab();
  if (!tab) return;
  const act = btn.dataset.act;
  if (act === 'copy-session') {
    const id = btn.dataset.value || '';
    if (!id || !navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(id).then(() => {
      _copiedUntil = Date.now() + 1400;
      syncContextMenu(cpCtx.activeTab());
      setTimeout(() => syncContextMenu(cpCtx.activeTab()), 1450);
    }).catch(() => {});
    return;
  }
  // Compact answers in the popover (its button says so); the others answer in
  // the message list, which the popover would cover.
  if (act !== 'compact') closeContextMenu();
  try { cpCtx.contextMenuAction(tab, act); } catch {}
  syncContextMenu(tab);
}

function onOutside(e) {
  if (_pop?.contains(e.target) || cog()?.contains(e.target)) return;
  closeContextMenu();
}

function onKey(e) {
  if (e.key !== 'Escape') return;
  // The popover takes this Escape: it must not also stop a turn or close a menu.
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu({ focus: true });
}

export function isContextMenuOpen() { return _open; }

export function openContextMenu() {
  const $panel = cpCtx?.panel();
  const $cog = cog();
  const tab = cpCtx?.activeTab();
  if (_open || !$panel || !$cog || !tab) return;
  if (!_pop) {
    _pop = el('div', 'cp-ctxpop');
    _pop.id = POP_ID;
    _pop.tabIndex = -1;
    _pop.setAttribute('role', 'dialog');
    _pop.setAttribute('aria-label', LABEL);
    _pop.addEventListener('click', onClick);
  }
  _open = true;
  _sig = '';
  // The session menu stays open on a click inside the header: one menu at a time.
  $panel.querySelector('#cp-session-menu')?.classList.remove('open');
  // Above the panel wherever the layout put it (docked, floating, focused).
  _pop.style.zIndex = String((parseInt(getComputedStyle($panel).zIndex, 10) || 200) + 1);
  document.body.appendChild(_pop);
  $cog.setAttribute('aria-expanded', 'true');
  // Its hover label would sit on the popover.
  _tooltip = $cog.getAttribute('data-tooltip') || _tooltip;
  $cog.removeAttribute('data-tooltip');
  syncContextMenu(tab);
  place();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  if (typeof ResizeObserver === 'function') {
    _watch = new ResizeObserver(place);
    _watch.observe($panel);
  }
  // Most changes arrive through syncContextMenu(); this catches the rest
  // (a mode painted elsewhere, a session id, a cost).
  _timer = setInterval(() => syncContextMenu(cpCtx.activeTab()), 1000);
  _pop.focus({ preventScroll: true });
}

/** Closes the popover. `focus` puts the focus back on the cog (Escape). */
export function closeContextMenu({ focus = false } = {}) {
  if (!_open) return;
  _open = false;
  clearInterval(_timer);
  _timer = null;
  _watch?.disconnect();
  _watch = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  _pop?.remove();
  const $cog = cog();
  if (!$cog) return;
  $cog.setAttribute('aria-expanded', 'false');
  if (_tooltip) $cog.setAttribute('data-tooltip', _tooltip);
  if (focus) $cog.focus();
}

/** Wires the cog. Called once the panel exists. */
export function initContextMenu() {
  const $cog = cog();
  if (!$cog || $cog._wired) return;
  $cog._wired = true;
  $cog.addEventListener('click', () => { if (_open) closeContextMenu(); else openContextMenu(); });
}
