import { KEYS } from './constants.js';

const COLUMNS = [
  ['running', 'Running', KEYS.TRAY_COL_RUNNING_COLLAPSED],
  ['waiting', 'Waiting', KEYS.TRAY_COL_WAITING_COLLAPSED],
  ['done', 'Done', KEYS.TRAY_COL_DONE_COLLAPSED],
];
const HEADER = 'tray-col-head';
const GROUP = 'ocpv2-subagent-pills';
const PILL = 'term-minimized-pill';
const STATUS_MARKS = {
  running: '<circle cx="6" cy="6" r="3" fill="currentColor" stroke="none"/>',
  waiting: '<circle cx="6" cy="6" r="5"/><path d="M6 3.5v2.8m0 2.2h.01"/>',
  done: '<path d="m2.5 6 2.3 2.3 4.7-4.7"/>',
};
const initialized = new WeakSet();

export function trayColumnOf(el) {
  if (el.classList.contains(GROUP)) {
    let parent = el.previousElementSibling;
    while (parent && (!parent.classList.contains(PILL))) {
      parent = parent.previousElementSibling;
    }
    return parent ? trayColumnOf(parent) : 'done';
  }

  const badgeStatus = el.querySelector('.cli-status-badge')?.dataset.status;
  const status = el.dataset.status;
  const classes = el.className.split(/\s+/);
  if (status === 'action' || badgeStatus === 'action' || classes.some(name => /-pill-(attention|waiting)$/.test(name))) {
    return 'waiting';
  }
  if (status === 'working' || badgeStatus === 'working' || classes.some(name => name.endsWith('-pill-running'))) {
    return 'running';
  }
  return 'done';
}

function setAttribute(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function isProducerVisible(el) {
  return !el.hidden && el.style.display !== 'none';
}

// Fill downward before borrowing room to the left of the heading.
export function accordionLayout(total, height) {
  for (const [row, gap] of [[32, 4], [28, 2], [24, 1], [24, 0]]) {
    if (total * (row + gap) - gap <= height) {
      return { row, gap, rows: Math.max(1, total), columns: 1 };
    }
  }
  const rows = Math.max(1, Math.floor(height / 24));
  return { row: 24, gap: 0, rows, columns: Math.ceil(total / rows) };
}

function setStyle(el, name, value) {
  if (el.style.setProperty) {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  } else {
    el.style[name] = value;
  }
}

function motionAllowed() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: no-preference)').matches;
}

function targetOf(pill) {
  return pill?.querySelector('.term-minimized-pill-label[tabindex]') || pill;
}

function control(className, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  if (label) button.setAttribute('aria-label', label);
  return button;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// Keep the native close button a sibling of the keyboard opening target.
// Providers with their own keyboard handler (the Assistant) keep that handler.
function preparePill(pill) {
  const label = pill.querySelector('.term-minimized-pill-label');
  if (!label) return;
  if (!pill.hasAttribute('tabindex') && pill.tagName !== 'BUTTON') {
    setAttribute(label, 'role', 'button');
    setAttribute(label, 'tabindex', '0');
  }
  const close = pill.querySelector('.term-minimized-pill-close');
  if (close && (!close.hasAttribute('aria-label') || close.dataset.trayCloseName)) {
    const name = `Close ${label.textContent.trim() || 'session'}`;
    setAttribute(close, 'aria-label', name);
    setAttribute(close, 'data-tray-close-name', 'true');
  }
}

export function initTrayColumns(tray, preferences = globalThis.localStorage) {
  if (!tray || initialized.has(tray)) return;
  initialized.add(tray);
  tray.classList.add('tray-columns');

  let pendingFocus = null;
  const motion = new WeakMap();
  const folding = new Map();
  const headers = COLUMNS.map(([column, label, key]) => {
    const button = control(HEADER);
    button.dataset.trayCol = column;
    const mark = document.createElement('span');
    mark.className = 'tray-col-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">${STATUS_MARKS[column]}</svg>`;
    const name = document.createElement('span');
    name.className = 'tray-col-label';
    name.textContent = label;
    const count = document.createElement('span');
    count.className = 'tray-col-count';
    const chevron = document.createElement('span');
    chevron.className = 'tray-col-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    button.append(mark, name, ' ', count, chevron);

    const group = { column, label, key, button, count, items: [] };
    const saved = preferences?.getItem(key);
    setCollapsed(group, saved == null ? column === 'done' : saved === 'true');
    button.addEventListener('click', () => toggle(group));
    return group;
  });
  const firstPill = tray.firstElementChild;
  for (const { button } of headers) tray.insertBefore(button, firstPill);

  function setCollapsed({ column, label, button }, collapsed) {
    setAttribute(tray, `data-tray-${column}-collapsed`, String(collapsed));
    setAttribute(button, 'aria-expanded', String(!collapsed));
    setAttribute(button, 'data-tooltip', `${collapsed ? 'Expand' : 'Collapse'} ${label}`);
  }

  function stopFold(pill) {
    const animation = folding.get(pill);
    if (!animation) return;
    folding.delete(pill);
    animation.cancel();
    motion.delete(pill);
    pill.removeAttribute('inert');
  }

  function animateFromHeading(pill, button, closing = false) {
    motion.get(pill)?.cancel();
    const from = button.getBoundingClientRect();
    const to = pill.getBoundingClientRect();
    const x = from.right - to.right;
    const y = from.top + (from.height - to.height) / 2 - to.top;
    const frames = [{ translate: `${x}px ${y}px`, opacity: 0 }, { translate: 'none', opacity: 1 }];
    const animation = pill.animate(closing ? frames.reverse() : frames, {
      duration: closing ? 150 : 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    });
    motion.set(pill, animation);
    return animation;
  }

  function toggle(group) {
    const { button, key, items } = group;
    const collapsed = button.getAttribute('aria-expanded') === 'true';
    if (collapsed && items.some(pill => pill.contains(document.activeElement))) {
      button.focus({ preventScroll: true });
    }
    setCollapsed(group, collapsed);
    preferences?.setItem(key, String(collapsed));
    const animate = motionAllowed();
    if (collapsed && animate) {
      for (const pill of items) {
        if (!pill.animate) continue;
        const animation = animateFromHeading(pill, button, true);
        folding.set(pill, animation);
        setAttribute(pill, 'inert', '');
        setAttribute(pill, 'data-tray-view', 'folding');
        animation.onfinish = () => {
          if (folding.get(pill) !== animation) return;
          stopFold(pill);
          setAttribute(pill, 'data-tray-view', 'hidden');
          schedule();
        };
      }
    }
    update();
    if (!collapsed && animate) {
      for (const pill of group.items) {
        if (pill.animate) animateFromHeading(pill, button);
      }
    }
  }

  tray.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    const pill = event.target.closest(`.${PILL}`);
    const head = event.target.closest(`.${HEADER}`);
    const group = headers.find(({ column }) => column === (pill || head)?.dataset.trayCol);
    if (!group || group.button.getAttribute('aria-expanded') !== 'true') return;
    const index = group.items.indexOf(pill);
    if (event.key === 'Escape' && (head || index >= 0)) {
      event.preventDefault();
      event.stopPropagation();
      group.button.focus({ preventScroll: true });
      toggle(group);
    } else if (index >= 0 && event.key === 'Delete') {
      event.preventDefault();
      pill.querySelector('.term-minimized-pill-close')?.click();
    } else if (index >= 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      const next = Math.max(0, Math.min(group.items.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
      targetOf(group.items[next]).focus({ preventScroll: true });
    } else if (index >= 0 && (event.key === 'Enter' || event.key === ' ') &&
        event.target.classList.contains('term-minimized-pill-label') && event.target.getAttribute('role') === 'button') {
      event.preventDefault();
      pill.click();
    }
  });
  tray.addEventListener('focusin', event => { pendingFocus = event.target.closest(`.${PILL}`); });

  function update() {
    const blocks = { running: [], waiting: [], done: [] };
    let parentBlock;
    const moves = [];
    const focusedGroup = headers.find(group => group.items.includes(pendingFocus));
    const focusIndex = focusedGroup?.items.indexOf(pendingFocus) ?? -1;
    const animate = motionAllowed();
    for (const node of tray.children) {
      const group = node.classList.contains(GROUP);
      if (!group && !node.classList.contains(PILL)) continue;
      const column = trayColumnOf(node);
      const items = group ? node.querySelectorAll(`:scope > .${PILL}`) : [node];
      const visible = [];
      for (const pill of items) {
        const previous = pill.dataset.trayCol;
        if (animate && pill.animate && previous && previous !== column && pill.dataset.trayView === 'open') {
          const origin = pill.getBoundingClientRect();
          if (origin.width && origin.height) moves.push({ pill, origin });
        }
        setAttribute(pill, 'data-tray-col', column);
        if (isProducerVisible(node) && isProducerVisible(pill)) {
          preparePill(pill);
          visible.push(pill);
          if (!animate || previous !== column) stopFold(pill);
        } else {
          stopFold(pill);
          setAttribute(pill, 'data-tray-view', 'hidden');
        }
      }
      if (group) {
        setAttribute(node, 'data-tray-col', column);
        setAttribute(node, 'data-tray-group-empty', String(visible.length === 0));
        if (parentBlock) parentBlock.push(...visible);
        else blocks[column].push(visible);
      } else {
        parentBlock = visible;
        blocks[column].push(parentBlock);
      }
    }
    // Producers append sessions in creation order. Reverse the parent blocks,
    // keeping each provider's sub-agent order directly after its parent.
    const columns = Object.fromEntries(Object.entries(blocks).map(([column, list]) => [column, list.reverse().flat()]));
    for (const pill of folding.keys()) {
      if (!tray.contains(pill)) stopFold(pill);
    }

    const groups = Object.values(columns).filter(items => items.length).length;
    setAttribute(tray, 'data-tray-groups', String(groups));
    setAttribute(tray, 'data-tray-empty', String(groups === 0));
    const top = tray.getBoundingClientRect?.().top || 0;
    const headingHeight = globalThis.matchMedia?.('(pointer: coarse)').matches ? 44 : 28;
    const firstRow = headingHeight + 4;
    const available = (globalThis.innerHeight || 800) - top - firstRow - 8;
    let slot = 0;
    for (const { column, button, count } of headers) {
      const total = columns[column].length;
      setAttribute(button, 'data-tray-count', String(total));
      setAttribute(button, 'data-tray-slot', String(total ? ++slot : 1));
      setText(count, String(total));
    }

    // Allocate each open group's overflow lanes immediately to its left. Separate lanes
    // keep sessions and headings from overlapping when multiple groups are open.
    let lane = 0;
    let bottom = headingHeight;
    for (const group of headers.slice().reverse()) {
      const { column, button } = group;
      const items = columns[column];
      const open = button.getAttribute('aria-expanded') === 'true';
      group.items = open ? items : [];
      if (!items.length) continue;
      setStyle(button, '--tray-lane', String(lane));
      const shown = open || items.some(pill => folding.has(pill));
      const { row, gap, rows, columns: lanes } = accordionLayout(shown ? items.length : 0, available);
      items.forEach((pill, index) => {
        if (open) stopFold(pill);
        const fold = folding.has(pill);
        setAttribute(pill, 'data-tray-slot', button.dataset.traySlot);
        setAttribute(pill, 'data-tray-view', open ? 'open' : fold ? 'folding' : 'hidden');
        if (!open && !fold) return;
        setStyle(pill, '--tray-lane', String(lane + Math.floor(index / rows)));
        const y = firstRow + (index % rows) * (row + gap);
        setStyle(pill, '--tray-top', `${y}px`);
        bottom = Math.max(bottom, y + row);
        setStyle(pill, '--tray-row', `${row}px`);
      });
      lane += lanes;
    }
    setStyle(tray, '--tray-tracks', String(Math.max(1, lane)));
    setStyle(tray, '--tray-height', `${bottom}px`);
    setStyle(tray, '--tray-head-height', `${headingHeight}px`);

    for (const { pill, origin } of moves) {
      motion.get(pill)?.cancel();
      const destination = pill.getBoundingClientRect();
      if (!destination.width || !destination.height) continue;
      const x = origin.left - destination.left;
      const y = origin.top - destination.top;
      if (x || y) {
        motion.set(pill, pill.animate([{ translate: `${x}px ${y}px` }, { translate: 'none' }], {
          duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        }));
      }
    }

    if (pendingFocus && (!tray.contains(pendingFocus) || pendingFocus.dataset.trayView === 'hidden')) {
      const old = pendingFocus;
      pendingFocus = null;
      if (document.activeElement === document.body || old.contains(document.activeElement)) {
        const current = headers.find(group => group.column === old.dataset.trayCol);
        const next = current?.items[Math.min(Math.max(0, focusIndex), current.items.length - 1)];
        const fallback = headers.find(group => group.button.dataset.trayCount !== '0');
        (targetOf(next) || (current?.button.dataset.trayCount !== '0' && current?.button) ||
          fallback?.button)?.focus({ preventScroll: true });
      }
    }
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }
  update();
  new MutationObserver(records => {
    if (records.some(record => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!target || target.closest(`.${HEADER}`)) return false;
      if (record.type === 'attributes') {
        if (target === tray) return false;
        if (record.attributeName === 'style') {
          // Positioning is ours. Only a provider changing display affects membership.
          const wasHidden = /(?:^|;)\s*display:\s*none\b/i.test(record.oldValue || '');
          return wasHidden !== (target.style.display === 'none');
        }
        return true;
      }
      return target === tray || !!target.closest(`.${PILL}`) || target.classList.contains(GROUP);
    })) schedule();
  }).observe(tray, {
    childList: true, characterData: true, subtree: true, attributes: true, attributeOldValue: true,
    attributeFilter: ['class', 'data-status', 'style', 'hidden'],
  });
  if (globalThis.ResizeObserver) {
    const resize = new ResizeObserver(schedule);
    resize.observe(tray);
    if (tray.parentElement) resize.observe(tray.parentElement);
  }
  globalThis.addEventListener?.('resize', schedule);
}
