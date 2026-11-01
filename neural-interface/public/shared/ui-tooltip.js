// ═══════════════════════════════════════════
// SynaBun Neural Interface — Tooltip System
// Body-appended, overflow-proof tooltip for data-tooltip attributes
// ═══════════════════════════════════════════

import { boundsForPoint, frameRect } from './app-frame.js';
import { isWindowsPlatform } from './desktop-bridge.js';

/**
 * Initialize the tooltip system.
 * Creates a body-appended tooltip element and delegates
 * mouseover/mouseout on any [data-tooltip] elements.
 */
export function initTooltip() {
  if (document.documentElement?.classList) {
    document.documentElement.classList.toggle('platform-win32', isWindowsPlatform(globalThis.window));
  }
  const tip = document.createElement('div');
  tip.className = 'ui-tooltip';
  const arrowEl = document.createElement('span');
  arrowEl.className = 'ui-tooltip-arrow';
  const textEl = document.createElement('span');
  textEl.className = 'ui-tooltip-text';
  tip.append(arrowEl, textEl);
  document.body.appendChild(tip);

  let showTimer = null;
  let hideTimer = null;
  let currentTarget = null;
  let repositionRunHandler = null;
  let repositionEndHandler = null;
  let repositionRafId = 0;

  // Dropdowns that keep their open menu inside the [data-tooltip] control
  // (the sidepanels' cp/cx/ocpv2 project-bar, model and mode controls). Hovering
  // that menu still resolves closest() to the control, which pinned the
  // control's tooltip over the open menu: while one is open, the control stays
  // quiet.
  const OPEN_MENU_INSIDE = '.cp-dropdown.open > .cp-dd-menu, .cxp-dropdown.open > .cxp-dd-menu, .ocpv2-dropdown.open > .ocpv2-dd-menu';
  function openMenuInside(el) {
    if (el.classList?.contains('term-minimized-pill') || el.classList?.contains('term-minimized-pill-close')) return false;
    return !!el.querySelector(OPEN_MENU_INSIDE);
  }

  const rectKey = (r) => r.left + ',' + r.top + ',' + r.width + ',' + r.height;

  // Swap the placement class only: a reposition (the follow loop below) must keep .visible.
  function setPlacement(placement) {
    tip.classList.remove('above', 'below', 'left', 'right');
    tip.classList.add(placement);
  }

  function positionTip(el, knownRect = null) {
    const r = knownRect || el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 8;
    const preferred = el.getAttribute('data-tooltip-pos');
    // Kept inside the app frame for a control in it; one on the bar or an explorer keeps the window.
    const b = boundsForPoint(frameRect(), r.left + r.width / 2, r.top + r.height / 2)
      || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };

    // Left-side placement (session dropdowns in sidepanels)
    // Anchor to the left edge of the containing sidepanel so tooltip always appears fully outside
    if (preferred === 'left') {
      const panel = el.closest('.claude-panel, .codex-panel, .ocp-panel, .agy-panel, .assistant-panel, .menubar-dropdown--resume');
      const anchorLeft = panel ? panel.getBoundingClientRect().left : r.left;
      if (anchorLeft - gap - tw > b.left + 4) {
        setPlacement('left');
        tip.style.top = (r.top + r.height / 2 - th / 2) + 'px';
        tip.style.left = (anchorLeft - gap - tw) + 'px';
        tip.style.setProperty('--arrow-y', (th / 2) + 'px');
        return { rect: r, width: tw };
      }
    }

    // Right-side placement (explorer sidebar, whiteboard toolbar, Resume dropdown)
    const inWbToolbar = !!el.closest('#wb-toolbar');
    const rightAnchor = el.closest('.menubar-dropdown--resume');
    const anchorRight = rightAnchor ? rightAnchor.getBoundingClientRect().right : r.right;
    if ((preferred === 'right' || inWbToolbar) && anchorRight + gap + tw < b.right - 4) {
      setPlacement('right');
      tip.style.top = (r.top + r.height / 2 - th / 2) + 'px';
      tip.style.left = (anchorRight + gap) + 'px';
      tip.style.setProperty('--arrow-y', (th / 2) + 'px');
      return { rect: r, width: tw };
    }

    // Elements near the top (title bar) → force below
    const forceBelow = preferred === 'below' || el.closest('#title-bar');
    let top = forceBelow ? r.bottom + gap : r.top - th - gap;
    let placement = forceBelow ? 'below' : 'above';
    if (!forceBelow && top < b.top + 4) {
      top = r.bottom + gap;
      placement = 'below';
    }
    let left = r.left + r.width / 2 - tw / 2;
    if (left + tw > b.right - 4) left = b.right - 4 - tw;
    if (left < b.left + 4) left = b.left + 4;
    setPlacement(placement);
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
    const arrowLeft = r.left + r.width / 2 - left;
    tip.style.setProperty('--arrow-x', arrowLeft + 'px');
    tip.style.setProperty('--arrow-y', '');
    return { rect: r, width: tw };
  }

  function suppressTitle(el) {
    // Remove native title from the element and its children to prevent double-tooltip
    if (el.hasAttribute('title')) {
      el._savedTitle = el.getAttribute('title');
      el.removeAttribute('title');
    }
    const titledChildren = [...el.querySelectorAll('[title]')];
    if (titledChildren.length) {
      el._savedTitleNodes = titledChildren;
      for (const child of titledChildren) {
        child._savedTitle = child.getAttribute('title');
        child.removeAttribute('title');
      }
    } else {
      delete el._savedTitleNodes;
    }
  }

  function restoreTitle(el) {
    if (el._savedTitle !== undefined) {
      el.setAttribute('title', el._savedTitle);
      delete el._savedTitle;
    }
    if (el._savedTitleNodes) {
      for (const child of el._savedTitleNodes) {
        if (child._savedTitle !== undefined) {
          child.setAttribute('title', child._savedTitle);
          delete child._savedTitle;
        }
      }
      delete el._savedTitleNodes;
    }
  }

  function show(el) {
    let text = el.getAttribute('data-tooltip');
    if (!text || openMenuInside(el)) return;
    clearTimeout(hideTimer);
    suppressTitle(el);
    const nlIdx = text.indexOf('\n');
    if (nlIdx !== -1) {
      let main = text.slice(0, nlIdx);
      if (main.length > 200) main = main.slice(0, 200) + '\u2026';
      const mainNode = document.createTextNode(main);
      const sub = document.createElement('span');
      sub.className = 'ui-tooltip-sub';
      sub.textContent = text.slice(nlIdx + 1);
      textEl.textContent = '';
      textEl.appendChild(mainNode);
      textEl.appendChild(document.createElement('br'));
      textEl.appendChild(sub);
    } else {
      if (text.length > 200) text = text.slice(0, 200) + '\u2026';
      textEl.textContent = text;
    }
    currentTarget = el;
    tip.style.display = 'block';
    const { rect: initialRect, width: initialWidth } = positionTip(el);
    tip.classList.add('visible');

    // Follow targets that actually animate their geometry on hover (via transitionrun),
    // without polling static targets across multiple rAFs.
    const followFor = 360;
    let stopAt = 0;
    let lastRectKey = rectKey(initialRect);
    let stableTicks = 0;
    const tick = () => {
      repositionRafId = 0;
      if (currentTarget !== el) return;
      const { rect: r } = positionTip(el);
      const key = rectKey(r);
      if (key === lastRectKey) {
        if (++stableTicks >= 2) return;
      } else {
        stableTicks = 0;
        lastRectKey = key;
      }
      if (performance.now() < stopAt) {
        repositionRafId = requestAnimationFrame(tick);
      }
    };
    repositionRunHandler = (event) => {
      if (currentTarget !== el) return;
      if (event.target !== el && !el.contains(event.target)) return;
      if (!/width|max-width|transform|margin|padding|left|right|top|bottom/.test(event.propertyName || '')) return;
      stopAt = performance.now() + followFor;
      stableTicks = 0;
      if (!repositionRafId) repositionRafId = requestAnimationFrame(tick);
    };
    repositionEndHandler = (event) => {
      if (currentTarget !== el) return;
      if (event.target !== el && !el.contains(event.target)) return;
      positionTip(el);
    };
    el.addEventListener('transitionrun', repositionRunHandler);
    el.addEventListener('transitionend', repositionEndHandler);

    // One check on the next frame (a single rect read): metrics that settle after display:none, or a
    // hover transition that began before the listeners above were attached (the 16-20 ms show delay).
    if (!repositionRafId) {
      repositionRafId = requestAnimationFrame(() => {
        repositionRafId = 0;
        if (currentTarget !== el) return;
        const r = el.getBoundingClientRect();
        const key = rectKey(r);
        if (key !== lastRectKey || tip.offsetWidth !== initialWidth) {
          lastRectKey = key;
          positionTip(el, r);
          if (key !== rectKey(initialRect)) {
            stopAt = performance.now() + followFor;
            repositionRafId = requestAnimationFrame(tick);
          }
        }
      });
    }
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = null;
    if (repositionRafId) {
      cancelAnimationFrame(repositionRafId);
      repositionRafId = 0;
    }
    if (currentTarget) {
      if (repositionRunHandler) currentTarget.removeEventListener('transitionrun', repositionRunHandler);
      if (repositionEndHandler) currentTarget.removeEventListener('transitionend', repositionEndHandler);
    }
    repositionRunHandler = null;
    repositionEndHandler = null;
    if (currentTarget) restoreTitle(currentTarget);
    currentTarget = null;
    tip.classList.remove('visible');
    hideTimer = setTimeout(() => { tip.style.display = 'none'; }, 150);
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (!el) return;
    // A dropdown whose menu is open keeps the menu as a child of the control:
    // it (and the control) then resolve here, and the tooltip must not show —
    // and any tooltip already up (for this control or another) goes away.
    if (openMenuInside(el)) { if (currentTarget) hide(); return; }
    if (el === currentTarget) { clearTimeout(hideTimer); return; }
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (currentTarget) {
      hide();
      showTimer = setTimeout(() => show(el), 16);
    } else {
      showTimer = setTimeout(() => show(el), 20);
    }
  });

  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (!el) return;
    if (openMenuInside(el)) { hide(); return; }
    const related = e.relatedTarget;
    if (related && el.contains(related)) return;
    hide();
  });

  document.addEventListener('scroll', hide, true);
  document.addEventListener('pointerdown', hide, true);

  // Keyboard focus shows the tooltip too, but only inside the Assistant
  // (.asst-root, and .asst-bar: its toolbar, which the sidepanel places in its
  // header), where glyph-only capsules have no visible label. Every other
  // surface stays hover-only.
  const FOCUS_SCOPE = '.asst-root, .asst-bar';
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el?.closest || !el.hasAttribute?.('data-tooltip') || !el.closest(FOCUS_SCOPE)) return;
    let keyboard = false;
    try { keyboard = el.matches(':focus-visible'); } catch { keyboard = false; }
    if (!keyboard || el === currentTarget) return;
    clearTimeout(showTimer);
    if (currentTarget) hide();
    show(el);
  });
  document.addEventListener('focusout', (e) => {
    if (currentTarget && e.target === currentTarget && currentTarget.closest(FOCUS_SCOPE)) hide();
  });
}
