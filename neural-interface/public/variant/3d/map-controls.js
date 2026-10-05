// ── Memory map input ──
//
// Hover → tooltip, click → open the memory, ⌘/Ctrl-click → multi-select,
// click a label → fly to that island, double-click empty space → frame all,
// Esc → clear the search, then the selection. Orbit / pan / zoom and the
// arrow keys belong to OrbitControls (arrows only while the map has focus, so
// the app's single-key shortcuts keep working everywhere else).

import { isGraphPointerActivity } from '../../shared/graph-activity.js';
import { clearSearch } from '../../shared/ui-search.js';
import { escapeHtml } from '../../shared/utils.js';

const CLICK_SLOP = 5; // px a press may move and still count as a click

export function initMapControls({ renderer, view, labels }) {
  const canvas = renderer.canvas;
  const tip = document.getElementById('tooltip');
  const tipCategory = document.getElementById('tooltip-category');
  const tipPreview = document.getElementById('tooltip-preview');
  const tipImportance = document.getElementById('tooltip-importance');
  let down = null;
  let canvasDown = false;
  let pickRaf = 0;
  let lastMove = null;
  let tipFor = -1;

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  // What is under the cursor: a memory right under it beats a label (island
  // labels sit over their island), a label beats a memory a little further off.
  function resolve(x, y) {
    const close = view.pickAt(x, y, 6);
    if (close >= 0) return { i: close, label: null };
    const label = labels.hitTest(x, y);
    if (label?.type === 'memory') return { i: label.index, label: null };
    if (label) return { i: -1, label };
    return { i: view.pickAt(x, y, 12), label: null };
  }

  function hideTip() {
    tip?.classList.remove('visible');
    tipFor = -1;
  }

  function showTip(i, e) {
    if (!tip) return;
    if (tipFor !== i) {
      const d = view.describe(i);
      if (!d) { hideTip(); return; }
      tipCategory.textContent = d.project ? `${d.category} · ${d.project}` : d.category;
      tipCategory.style.color = d.color;
      tipPreview.innerHTML = d.title ? escapeHtml(d.title) : '<span style="opacity:.55">Loading…</span>';
      tipImportance.textContent = `★ ${d.importance} · ${d.when}`;
      tipFor = i;
    }
    const pad = 16;
    const w = tip.offsetWidth || 260, h = tip.offsetHeight || 80;
    const x = Math.min(e.clientX + pad, window.innerWidth - w - 8);
    const y = e.clientY + pad + h > window.innerHeight ? e.clientY - h - pad : e.clientY + pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
    tip.classList.add('visible');
  }

  function hover(e) {
    if (!isGraphPointerActivity(e, canvas, canvasDown) || e.buttons) {
      view.setHover(-1);
      hideTip();
      canvas.style.cursor = '';
      return;
    }
    const [x, y] = local(e);
    const { i, label } = resolve(x, y);
    if (i < 0 && label) {
      view.setHover(-1);
      hideTip();
      canvas.style.cursor = 'pointer';
      return;
    }
    view.setHover(i);
    canvas.style.cursor = i >= 0 ? 'pointer' : '';
    if (i >= 0) showTip(i, e);
    else hideTip();
  }

  const onPointerMove = (e) => {
    lastMove = e;
    if (pickRaf) return;
    pickRaf = requestAnimationFrame(() => { pickRaf = 0; if (lastMove) hover(lastMove); });
  };

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', () => { view.setHover(-1); hideTip(); canvas.style.cursor = ''; });
  canvas.addEventListener('pointerdown', (e) => {
    canvasDown = true;
    down = { x: e.clientX, y: e.clientY, button: e.button };
    hideTip();
    canvas.focus({ preventScroll: true });
  });
  canvas.addEventListener('wheel', hideTip, { passive: true });

  const onPointerUp = (e) => {
    const d = down;
    const wasDown = canvasDown;
    down = null;
    canvasDown = false;
    if (!d || !wasDown || d.button !== 0 || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) return; // a drag, not a click
    const [x, y] = local(e);
    const { i, label } = resolve(x, y);
    if (i >= 0) view.clickPoint(i, { additive: e.metaKey || e.ctrlKey });
    else if (label) view.clickLabel(label);
  };
  window.addEventListener('pointerup', onPointerUp);

  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = local(e);
    if (labels.hitTest(x, y) || view.pickAt(x, y) >= 0) return;
    view.frameAll();
  });

  // Esc: search first, then selection. Backs off whenever something else owns it.
  const onKeyDown = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const active = document.activeElement;
    const owned = active && active !== document.body && active !== canvas;
    if (owned || document.querySelector('.menubar-item.open, .modal-overlay.open, .settings-modal.open')) return;
    if (view.searching) { clearSearch(); return; }
    if (view.selectedId) view.clearSelection();
  };
  window.addEventListener('keydown', onKeyDown, true);

  return {
    hideTip,
    dispose() {
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown, true);
      if (pickRaf) cancelAnimationFrame(pickRaf);
    },
  };
}
