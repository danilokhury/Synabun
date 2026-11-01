// ═══════════════════════════════════════════
// The top-right toolbar's overflow: one row, always.
// When the row is wider than its band (#topright-controls' max-width), the lowest-priority buttons leave the row,
// from the start of OVERFLOW_ORDER (topright-overflow-logic.js), and are listed in the ⋯ menu (#topright-overflow-btn) instead: icon, label,
// badge and active state copied from the button each time the menu opens, a click forwarded to the button itself,
// so every handler stays the button's own. The workspace switcher and the ⋯ never leave the row; the tools toggle
// leaves it last of all, in a band too narrow for anything else.
// An item that opens a dropdown of its own (bookmarks, share) is pinned back into the row before it is clicked, so
// its dropdown hangs where it always does; the pin is let go when its dropdown closes.
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { t } from './i18n.js';
import { OVERFLOW_ORDER, overflowCount, clampDropdownX } from './topright-overflow-logic.js';

export { OVERFLOW_ORDER, overflowCount };

// The element that leaves the row for each entry (a button inside an overlay goes with its overlay) and the button
// the menu forwards to.
const ROW_ITEM = { 'topright-bookmarks-btn': 'bookmarks-overlay', 'invite-overlay': 'invite-overlay' };
const BUTTON = { 'invite-overlay': 'invite-btn' };
const DROPDOWN = { 'topright-bookmarks-btn': 'bookmarks-dropdown', 'invite-overlay': 'invite-dropdown' };

const labelOf = (btn) => btn.getAttribute('aria-label') || btn.dataset.tooltip || btn.title || btn.id;

export function initToprightOverflow() {
  const $ = (id) => document.getElementById(id);
  const controls = $('topright-controls');
  const inner = $('topright-inner');
  const group = $('topright-buttons');
  const moreBtn = $('topright-overflow-btn');
  const menu = $('topright-overflow-menu');
  if (!controls || !inner || !group || !moreBtn || !menu) return null;

  const entries = OVERFLOW_ORDER.map((id) => ({
    id,
    item: $(ROW_ITEM[id] || id),
    button: $(BUTTON[id] || id),
    dropdown: DROPDOWN[id] ? $(DROPDOWN[id]) : null,
  })).filter((e) => e.item && e.button);
  let pinned = null;
  let open = false;

  const shownInRow = (el) => el.offsetParent !== null || getComputedStyle(el).display !== 'none';
  const isOverflowed = (e) => e.item.classList.contains('tr-overflowed');

  // The dividers of the dock: one with no shown tool after it (up to the next divider or the end) goes too.
  const tidyDividers = () => {
    for (const div of inner.querySelectorAll(':scope > .tr-divider')) {
      let el = div.nextElementSibling;
      let any = false;
      while (el && !el.classList.contains('tr-divider')) {
        if (!el.classList.contains('tr-overflowed') && el.style.display !== 'none') { any = true; break; }
        el = el.nextElementSibling;
      }
      div.classList.toggle('tr-overflowed', !any);
    }
  };

  const fit = () => {
    for (const e of entries) e.item.classList.remove('tr-overflowed');
    for (const div of inner.querySelectorAll(':scope > .tr-divider')) div.classList.remove('tr-overflowed');
    const available = parseFloat(getComputedStyle(controls).maxWidth);
    const gap = parseFloat(getComputedStyle(controls).columnGap) || 0;
    const innerGap = parseFloat(getComputedStyle(inner).columnGap) || 0;
    const groupGap = parseFloat(getComputedStyle(group).columnGap) || 0;
    const dockShown = !controls.classList.contains('tools-hidden');
    // the row as it would be with everything in it and no ⋯ (the ⋯ is left out, not hidden: hiding it here would
    // change the bar's class and wake the observers again)
    const moreShown = controls.classList.contains('has-overflow') ? moreBtn.getBoundingClientRect().width + groupGap : 0;
    const total = (dockShown ? inner.getBoundingClientRect().width + gap : 0) + group.getBoundingClientRect().width - moreShown;
    if (!Number.isFinite(available)) return;
    const widths = entries.map((e) => {
      if (!shownInRow(e.item) || e.item.style.display === 'none') return 0;
      const inDock = inner.contains(e.item);
      if (inDock && !dockShown) return 0;
      return e.item.getBoundingClientRect().width + (inDock ? innerGap : groupGap);
    });
    const menuWidth = 32 + groupGap;
    const pinnedIdx = pinned ? [entries.indexOf(pinned)] : [];
    const { hidden } = overflowCount({ total, available, widths, menuWidth, pinned: pinnedIdx });
    for (const i of hidden) entries[i].item.classList.add('tr-overflowed');
    // The dock's dividers: the 2px margins and gaps they free are not counted above, so the row only gets narrower.
    tidyDividers();
    if (controls.classList.contains('has-overflow') !== hidden.length > 0) controls.classList.toggle('has-overflow', hidden.length > 0);
    if (!hidden.length && open) close();
    else if (open) render();
  };

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; fit(); });
  };

  const render = () => {
    menu.textContent = '';
    // in the row's own order, as they would stand in it
    const listed = entries.filter(isOverflowed)
      .sort((a, b) => (a.item.compareDocumentPosition(b.item) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    for (const e of listed) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'topright-overflow-item';
      row.setAttribute('role', 'menuitem');
      row.dataset.target = e.id;
      if (e.button.classList.contains('active')) row.classList.add('active');
      const icon = document.createElement('span');
      icon.className = 'topright-overflow-icon';
      const svg = e.button.querySelector('svg');
      if (svg) icon.appendChild(svg.cloneNode(true));
      const label = document.createElement('span');
      label.className = 'topright-overflow-label';
      label.textContent = labelOf(e.button);
      row.append(icon, label);
      const badge = e.button.querySelector('.count-badge');
      const text = badge?.textContent.trim();
      if (badge && text && getComputedStyle(badge).display !== 'none') {
        const b = document.createElement('span');
        b.className = `${badge.className} topright-overflow-badge`;
        b.removeAttribute('id');
        b.textContent = text;
        row.appendChild(b);
      }
      row.addEventListener('click', () => activate(e));
      menu.appendChild(row);
    }
  };

  const items = () => [...menu.querySelectorAll('.topright-overflow-item')];

  function openMenu(focusFirst) {
    emit('panel:close-all-dropdowns');
    render();
    open = true;
    menu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    moreBtn.classList.add('active');
    if (focusFirst) items()[0]?.focus();
  }
  function close(refocus) {
    if (!open) return;
    open = false;
    menu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.classList.remove('active');
    if (refocus) moreBtn.focus();
  }

  function activate(e) {
    close();
    if (e.dropdown) {
      pinned = e;
      fit();
      // let go of the pin once its dropdown closes
      const watch = new MutationObserver(() => {
        if (e.dropdown.style.display === 'none') { watch.disconnect(); if (pinned === e) { pinned = null; schedule(); } }
      });
      watch.observe(e.dropdown, { attributes: true, attributeFilter: ['style'] });
      setTimeout(() => e.button.click(), 0);
      return;
    }
    e.button.click();
  }

  moreBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (open) close(); else openMenu(ev.detail === 0);
  });
  moreBtn.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); if (!open) openMenu(false); const list = items(); (ev.key === 'ArrowUp' ? list.at(-1) : list[0])?.focus(); }
  });
  menu.addEventListener('keydown', (ev) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (ev.key === 'Home') { ev.preventDefault(); list[0]?.focus(); }
    else if (ev.key === 'End') { ev.preventDefault(); list.at(-1)?.focus(); }
    else if (ev.key === 'Tab') close();
  });
  document.addEventListener('keydown', (ev) => { if (open && ev.key === 'Escape') { ev.stopPropagation(); close(true); } }, true);
  document.addEventListener('pointerdown', (ev) => { if (open && !menu.contains(ev.target) && !moreBtn.contains(ev.target)) close(); }, true);
  on('panel:close-all-dropdowns', () => close());

  moreBtn.setAttribute('aria-label', t('toolbar.more'));
  moreBtn.dataset.tooltip = t('toolbar.more');

  // Live: the band (window, side panels, explorers, Focus Mode) and the row's own contents.
  const ro = new ResizeObserver(schedule);
  ro.observe(document.documentElement);
  ro.observe(controls);
  for (const e of entries) ro.observe(e.item);
  ro.observe(inner.querySelector('#workspace-overlay') || inner);
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
  new MutationObserver(schedule).observe(controls, { attributes: true, attributeFilter: ['class'] });
  for (const e of entries) new MutationObserver(schedule).observe(e.item, { attributes: true, attributeFilter: ['style'] });
  const bg = $('static-bg');
  if (bg) new MutationObserver(schedule).observe(bg, { attributes: true, attributeFilter: ['class'] });
  // The dropdowns of the bar, kept whole on screen: right of the band's clip (sidebar, Focus Mode rail and left
  // panels + 20px, as #topright-controls' clip-path) and left of the viewport's edge, as wide as that room at most.
  const EDGE = 8;
  const place = (dd) => {
    dd.style.translate = '';
    dd.style.maxWidth = '';
    if (dd.style.display === 'none' || !dd.isConnected) return;
    const sidebar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-total-width')) || 0;
    const minLeft = Math.max(EDGE, sidebar + 20);
    const maxRight = document.documentElement.clientWidth - EDGE;
    let r = dd.getBoundingClientRect();
    const first = clampDropdownX({ left: r.left, width: r.width, minLeft, maxRight });
    if (first.maxWidth !== null) { dd.style.maxWidth = `${first.maxWidth}px`; r = dd.getBoundingClientRect(); }
    const { shift } = clampDropdownX({ left: r.left, width: r.width, minLeft, maxRight });
    if (shift) dd.style.translate = `${shift}px 0`;
  };
  const dropdowns = ['ws-dropdown', 'bookmarks-dropdown', 'invite-dropdown'].map((id) => $(id)).filter(Boolean);
  for (const dd of dropdowns) {
    // its own writes change the style too: act on a change of shown / hidden only
    let shown = dd.style.display !== 'none';
    new MutationObserver(() => {
      const now = dd.style.display !== 'none';
      if (now !== shown) { shown = now; place(dd); }
    }).observe(dd, { attributes: true, attributeFilter: ['style'] });
  }
  let placing = 0;
  const placeOpen = () => { cancelAnimationFrame(placing); placing = requestAnimationFrame(() => dropdowns.forEach(place)); };
  window.addEventListener('resize', placeOpen);
  new ResizeObserver(placeOpen).observe(controls);
  window.addEventListener('resize', schedule);
  fit();
  return { fit, close };
}
