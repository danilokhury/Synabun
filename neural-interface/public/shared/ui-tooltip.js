// ═══════════════════════════════════════════
// SynaBun Neural Interface — Tooltip System
// Body-appended, overflow-proof tooltip for data-tooltip attributes
// ═══════════════════════════════════════════

/**
 * Initialize the tooltip system.
 * Creates a body-appended tooltip element and delegates
 * mouseover/mouseout on any [data-tooltip] elements.
 */
export function initTooltip() {
  const tip = document.createElement('div');
  tip.className = 'ui-tooltip';
  tip.innerHTML = '<span class="ui-tooltip-arrow"></span><span class="ui-tooltip-text"></span>';
  document.body.appendChild(tip);

  let showTimer = null;
  let hideTimer = null;
  let currentTarget = null;
  let repositionRunHandler = null;
  let repositionEndHandler = null;
  let repositionRafId = 0;

  function positionTip(el) {
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 8;
    const preferred = el.getAttribute('data-tooltip-pos');

    // Left-side placement (session dropdowns in sidepanels)
    // Anchor to the left edge of the containing sidepanel so tooltip always appears fully outside
    if (preferred === 'left') {
      const panel = el.closest('.claude-panel, .codex-panel, .ocp-panel, .menubar-dropdown--resume');
      const anchorLeft = panel ? panel.getBoundingClientRect().left : r.left;
      if (anchorLeft - gap - tw > 4) {
        tip.className = 'ui-tooltip left';
        tip.style.top = (r.top + r.height / 2 - th / 2) + 'px';
        tip.style.left = (anchorLeft - gap - tw) + 'px';
        tip.style.setProperty('--arrow-y', (th / 2) + 'px');
        return;
      }
    }

    // Right-side placement (explorer sidebar, whiteboard toolbar, Resume dropdown)
    const inWbToolbar = !!el.closest('#wb-toolbar');
    const rightAnchor = el.closest('.menubar-dropdown--resume');
    const anchorRight = rightAnchor ? rightAnchor.getBoundingClientRect().right : r.right;
    if ((preferred === 'right' || inWbToolbar) && anchorRight + gap + tw < window.innerWidth - 4) {
      tip.className = 'ui-tooltip right';
      tip.style.top = (r.top + r.height / 2 - th / 2) + 'px';
      tip.style.left = (anchorRight + gap) + 'px';
      tip.style.setProperty('--arrow-y', (th / 2) + 'px');
      return;
    }

    // Elements near the top (title bar) → force below
    const forceBelow = preferred === 'below' || el.closest('#title-bar');
    let top = forceBelow ? r.bottom + gap : r.top - th - gap;
    let placement = forceBelow ? 'below' : 'above';
    if (!forceBelow && top < 4) {
      top = r.bottom + gap;
      placement = 'below';
    }
    let left = r.left + r.width / 2 - tw / 2;
    if (left < 4) left = 4;
    if (left + tw > window.innerWidth - 4) left = window.innerWidth - 4 - tw;
    tip.className = 'ui-tooltip ' + placement;
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
    const arrowLeft = r.left + r.width / 2 - left;
    tip.style.setProperty('--arrow-x', arrowLeft + 'px');
    tip.style.setProperty('--arrow-y', '');
  }

  function suppressTitle(el) {
    // Remove native title from the element and its children to prevent double-tooltip
    if (el.hasAttribute('title')) {
      el._savedTitle = el.getAttribute('title');
      el.removeAttribute('title');
    }
    el.querySelectorAll('[title]').forEach(child => {
      child._savedTitle = child.getAttribute('title');
      child.removeAttribute('title');
    });
  }

  function restoreTitle(el) {
    if (el._savedTitle !== undefined) {
      el.setAttribute('title', el._savedTitle);
      delete el._savedTitle;
    }
    el.querySelectorAll('*').forEach(child => {
      if (child._savedTitle !== undefined) {
        child.setAttribute('title', child._savedTitle);
        delete child._savedTitle;
      }
    });
  }

  function show(el) {
    let text = el.getAttribute('data-tooltip');
    if (!text) return;
    clearTimeout(hideTimer);
    suppressTitle(el);
    const textEl = tip.querySelector('.ui-tooltip-text');
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
    tip.offsetHeight; // force reflow so dimensions are measurable
    positionTip(el);
    tip.classList.add('visible');
    // Re-position on next frame — first show after display:none can mis-measure
    requestAnimationFrame(() => {
      if (currentTarget === el) {
        positionTip(el);
        tip.classList.add('visible');
      }
    });
    // Some targets resize on hover (e.g. tray pill label expands max-width
    // 100→300px over ~300ms). Without follow-up positioning, the tooltip
    // stays anchored to the un-expanded rect and the pill grows leftward
    // over it. Drive a rAF loop for the duration of any size/position
    // transition so the tooltip tracks the target.
    const followFor = 360; // ms — slightly longer than the longest pill transition
    const stopAt = performance.now() + followFor;
    const tick = () => {
      repositionRafId = 0;
      if (currentTarget !== el) return;
      positionTip(el);
      if (performance.now() < stopAt) {
        repositionRafId = requestAnimationFrame(tick);
      }
    };
    repositionRunHandler = (event) => {
      if (currentTarget !== el) return;
      if (event.target !== el && !el.contains(event.target)) return;
      if (!/width|max-width|transform|margin|padding|left|right|top|bottom/.test(event.propertyName || '')) return;
      if (!repositionRafId) repositionRafId = requestAnimationFrame(tick);
    };
    repositionEndHandler = (event) => {
      if (currentTarget !== el) return;
      if (event.target !== el && !el.contains(event.target)) return;
      positionTip(el);
    };
    el.addEventListener('transitionrun', repositionRunHandler);
    el.addEventListener('transitionend', repositionEndHandler);
    // Kick off one immediate rAF in case the transition already started on
    // mouseenter before our listeners attached.
    if (!repositionRafId) repositionRafId = requestAnimationFrame(tick);
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
    if (el === currentTarget) { clearTimeout(hideTimer); return; }
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (currentTarget) {
      hide();
      show(el);
    } else {
      showTimer = setTimeout(() => show(el), 20);
    }
  });

  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (!el) return;
    const related = e.relatedTarget;
    if (related && el.contains(related)) return;
    hide();
  });

  document.addEventListener('scroll', hide, true);
  document.addEventListener('pointerdown', hide, true);
}
