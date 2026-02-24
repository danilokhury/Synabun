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

  function positionTip(el) {
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 8;
    const preferred = el.getAttribute('data-tooltip-pos');

    // Right-side placement (used inside explorer sidebar)
    if (preferred === 'right' && r.right + gap + tw < window.innerWidth - 4) {
      tip.className = 'ui-tooltip right';
      tip.style.top = (r.top + r.height / 2 - th / 2) + 'px';
      tip.style.left = (r.right + gap) + 'px';
      const arrow = tip.querySelector('.ui-tooltip-arrow');
      arrow.style.left = '';
      arrow.style.top = (th / 2) + 'px';
      arrow.style.transform = 'translateY(-50%)';
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
    const arrow = tip.querySelector('.ui-tooltip-arrow');
    arrow.style.left = arrowLeft + 'px';
    arrow.style.top = '';
    arrow.style.transform = 'translateX(-50%)';
  }

  function show(el) {
    let text = el.getAttribute('data-tooltip');
    if (!text) return;
    if (text.length > 200) text = text.slice(0, 200) + '\u2026';
    clearTimeout(hideTimer);
    tip.querySelector('.ui-tooltip-text').textContent = text;
    currentTarget = el;
    tip.style.display = 'block';
    tip.offsetHeight; // force reflow
    positionTip(el);
    tip.classList.add('visible');
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = null;
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
      showTimer = setTimeout(() => show(el), 120);
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
