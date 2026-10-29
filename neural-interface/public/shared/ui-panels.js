// ═══════════════════════════════════════════
// SynaBun Neural Interface — Panel System
// Drag, resize, pin toggle, layout save/restore, viewport clamping
// ═══════════════════════════════════════════

import { KEYS } from './constants.js';
import { storage } from './storage.js';
import { state, emit } from './state.js';
import { frameRect, onFrameChange } from './app-frame.js';

const MIN_W = 140;
const MIN_H = 100;

// ── Frame clamping ──
// A window stays inside the app frame (app-frame.js): its top-left corner never leaves it and its size shrinks to
// what is left of it. Flush against an edge is allowed: the frame's rounded corners cut a window that reaches them.
// left/top are the element's own (style) coordinates; with --ui-scale its box is drawn scaled from its
// transform-origin, so visual offsets are turned into style offsets through the box's measured position.

/** Keep one .resizable window inside the frame. */
export function clampPanelToFrame(el, f = frameRect()) {
  if (!el?.isConnected) return;
  const minHeight = MIN_H;
  const minWidth = MIN_W;
  const s = getElScale(el);

  let rect = el.getBoundingClientRect();
  // Not drawn (display: none): nothing to measure, and its place is checked again when it shows.
  if (!rect.width && !rect.height) return;

  if (el.style.left) {
    const currentLeft = parseFloat(el.style.left);
    // Style left of the box's visual left at the frame's left / right edge.
    const toStyle = currentLeft - rect.left;
    const minLeft = f.left + toStyle;
    const maxLeft = Math.max(minLeft, f.right - rect.width + toStyle);
    if (currentLeft < minLeft) el.style.left = minLeft + 'px';
    else if (currentLeft > maxLeft) el.style.left = maxLeft + 'px';
  }

  if (el.style.top) {
    const currentTop = parseFloat(el.style.top);
    const toStyle = currentTop - rect.top;
    const minTop = f.top + toStyle;
    const maxTop = Math.max(minTop, f.bottom - rect.height + toStyle);
    if (currentTop < minTop) el.style.top = minTop + 'px';
    else if (currentTop > maxTop) el.style.top = maxTop + 'px';
  }

  rect = el.getBoundingClientRect();

  if (rect.right > f.right + 0.5 && el.style.width) {
    const maxWidth = (f.right - rect.left) / s;
    if (maxWidth > minWidth) {
      el.style.width = maxWidth + 'px';
    }
  }

  rect = el.getBoundingClientRect();
  if (rect.bottom > f.bottom + 0.5) {
    const maxHeight = (f.bottom - rect.top) / s;
    if (maxHeight > minHeight) {
      el.style.maxHeight = maxHeight + 'px';
      if (el.style.height && el.style.height !== 'auto') {
        const currentHeight = parseFloat(el.style.height);
        if (currentHeight > maxHeight) {
          el.style.height = maxHeight + 'px';
        }
      }
    }
  }
}

export function clampPanelsToViewport() {
  const f = frameRect();
  document.querySelectorAll('.resizable').forEach(el => clampPanelToFrame(el, f));
}

// ── Save/Restore panel layout ──

export function savePanelLayout(el) {
  const id = el.id;
  const data = {
    left: el.style.left || null,
    top: el.style.top || null,
    right: el.style.right || null,
    width: el.style.width || null,
    height: el.style.height || null,
    maxHeight: el.style.maxHeight || null,
  };
  storage.setItem(KEYS.PANEL_PREFIX + id, JSON.stringify(data));
}

export function restorePanelLayout(el, sizeOnly) {
  const saved = storage.getItem(KEYS.PANEL_PREFIX + el.id);
  if (!saved) return;
  try {
    const data = JSON.parse(saved);
    if (!sizeOnly) {
      const f = frameRect();
      if (data.left && data.left !== 'auto') el.style.left = Math.max(f.left, parseFloat(data.left) || 0) + 'px';
      if (data.top) el.style.top = Math.max(f.top, parseFloat(data.top) || 0) + 'px';
      if (data.right) el.style.right = data.right;
    }
    if (data.width) el.style.width = data.width;
    if (data.height) el.style.height = data.height;
    // A layout saved in a bigger window, or with the explorers closed, comes back inside the frame.
    if (!sizeOnly && el.isConnected) clampPanelToFrame(el);
  } catch {}
}

// ── UI Scale helper ──

function getElScale(el) {
  return parseFloat(getComputedStyle(el).getPropertyValue('--ui-scale')) || parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
}

function ensureLeftTop(el) {
  const cs = getComputedStyle(el);
  el.style.left = cs.left;
  el.style.top = cs.top;
  el.style.right = 'auto';
}

// ── Initialize panel system ──

export function initPanelSystem() {
  let resizing = null;
  let dragging = null;
  let rafPending = false;
  let latestMouseX = 0;
  let latestMouseY = 0;

  // --- Resize (all 8 directions, event delegation for dynamic panels) ---
  document.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.resize-handle');
    if (!handle) return;
    e.preventDefault();
    const dir = handle.dataset.resize;
    const el = handle.closest('.resizable');
    if (!el) return;

    handle.classList.add('active');
    el.classList.add('dragging');
    document.body.classList.add('ui-interacting');

    const s = getElScale(el);
    ensureLeftTop(el);
    const cs = getComputedStyle(el);

    const elMinW = Math.max(MIN_W, parseInt(cs.minWidth) || 0);
    const elMinH = Math.max(MIN_H, parseInt(cs.minHeight) || 0);

    resizing = {
      el, dir, scale: s,
      startX: e.clientX, startY: e.clientY,
      startW: parseFloat(cs.width), startH: parseFloat(cs.height),
      startL: parseFloat(cs.left), startT: parseFloat(cs.top),
      minW: elMinW, minH: elMinH,
      frame: frameRect(),
      // Scaled from its top-right corner (the category sidebar) or its top-left (every other window)
      originRight: Math.abs((parseFloat(cs.transformOrigin) || 0) - parseFloat(cs.width)) < 1,
    };
    document.body.style.cursor = getComputedStyle(handle).cursor;
    document.body.style.userSelect = 'none';
  });

  // --- Drag (event delegation for dynamic panels) ---
  document.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    if (e.target.closest('.resize-handle')) return;
    const tag = e.target.closest('button, input, select, textarea, a, [contenteditable], [draggable="true"]');
    if (tag) return;
    e.preventDefault();
    const el = document.getElementById(handle.dataset.drag);
    if (!el) return;
    if (el.classList.contains('locked')) return;

    el.classList.add('dragging');
    document.body.classList.add('ui-interacting');
    ensureLeftTop(el);
    const s = getElScale(el);
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    dragging = {
      el, startX: e.clientX, startY: e.clientY,
      startLeft: parseFloat(cs.left), startTop: parseFloat(cs.top),
      startVisualLeft: rect.left, startVisualTop: rect.top,
      startW: rect.width, startH: rect.height,
      frame: frameRect(),
    };
    document.body.style.cursor = 'move';
    document.body.style.userSelect = 'none';
  });

  // RAF tick
  function applyInteraction() {
    rafPending = false;
    const mx = latestMouseX;
    const my = latestMouseY;

    if (resizing) {
      const { el, dir, scale: rScale, startX, startY, startW, startH, startL, startT, minW: rMinW, minH: rMinH, frame: f, originRight } = resizing;
      const dx = (mx - startX) / rScale;
      const dy = (my - startY) / rScale;

      let newW = startW, newH = startH, newL = startL, newT = startT;

      // Widths are the element's own (unscaled) pixels; left/top are viewport pixels. A left or top edge moves
      // against the opposite edge, which stays where it is on screen: drawn from a top-left origin, right = left +
      // width × scale; from a top-right one (scaled towards its right edge), right = left + width.
      const span = (w) => (originRight ? w : w * rScale);   // style left → drawn right edge
      if (dir === 'r' || dir === 'br' || dir === 'tr') newW = Math.max(rMinW, startW + dx);
      if (dir === 'l' || dir === 'bl' || dir === 'tl') {
        const right = startL + span(startW);
        newW = Math.max(rMinW, startW - dx);
        newL = right - span(newW);
        const drawnLeft = right - newW * rScale;
        if (drawnLeft < f.left) { newW = Math.max(rMinW, (right - f.left) / rScale); newL = right - span(newW); }
      }
      if (dir === 'b' || dir === 'br' || dir === 'bl') newH = Math.max(rMinH, startH + dy);
      if (dir === 't' || dir === 'tr' || dir === 'tl') {
        const bottom = startT + startH * rScale;
        newH = Math.max(rMinH, startH - dy);
        newT = bottom - newH * rScale;
        if (newT < f.top) { newT = f.top; newH = Math.max(rMinH, (bottom - f.top) / rScale); }
      }

      if (!originRight) newL = Math.max(f.left, newL);
      newT = Math.max(f.top, newT);
      const maxWidth = originRight ? f.right - newL : (f.right - newL) / rScale;
      const maxHeight = (f.bottom - newT) / rScale;
      newW = Math.min(newW, maxWidth);
      newH = Math.min(newH, maxHeight);

      el.style.width = newW + 'px';
      el.style.height = newH + 'px';
      el.style.left = newL + 'px';
      el.style.top = newT + 'px';
      el.style.maxHeight = maxHeight + 'px';
    }

    if (dragging) {
      const { el, startX, startY, startLeft, startTop, startVisualLeft, startVisualTop, startW, startH, frame: f } = dragging;
      const dx = mx - startX;
      const dy = my - startY;

      // The visual box (startW × startH, scaled) moves inside the frame; flush against its edges is allowed.
      const clampedDx = Math.max(f.left - startVisualLeft, Math.min(f.right - startW - startVisualLeft, dx));
      const clampedDy = Math.max(f.top - startVisualTop, Math.min(f.bottom - startH - startVisualTop, dy));

      let finalLeft = startLeft + clampedDx;
      let finalTop  = startTop + clampedDy;

      if (state.gridSnap) {
        const gs = state.gridSize || 20;
        finalLeft = Math.round(finalLeft / gs) * gs;
        finalTop  = Math.round(finalTop / gs) * gs;
      }

      // A grid step never takes the window past the frame's left or top edge (below the bar, right of the explorers)
      finalLeft = Math.max(startLeft + f.left - startVisualLeft, finalLeft);
      finalTop = Math.max(startTop + f.top - startVisualTop, finalTop);
      el.style.left = finalLeft + 'px';
      el.style.top  = finalTop + 'px';
    }
  }

  document.addEventListener('mousemove', (e) => {
    if (!resizing && !dragging) return;
    latestMouseX = e.clientX;
    latestMouseY = e.clientY;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(applyInteraction);
    }
  });

  document.addEventListener('mouseup', () => {
    rafPending = false;
    if (resizing) {
      document.querySelectorAll('.resize-handle.active').forEach(h => h.classList.remove('active'));
      resizing.el.classList.remove('dragging');
      savePanelLayout(resizing.el);
      if (resizing.el.classList.contains('detail-card')) emit('detail:layout-changed', { panelId: resizing.el.id });
      resizing = null;
    }
    if (dragging) {
      dragging.el.classList.remove('dragging');
      savePanelLayout(dragging.el);
      if (dragging.el.classList.contains('detail-card')) emit('detail:layout-changed', { panelId: dragging.el.id });
      dragging = null;
    }
    document.body.classList.remove('ui-interacting');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Restore saved layouts
  const sidebar = document.getElementById('category-sidebar');
  if (sidebar) restorePanelLayout(sidebar, false);

  clampPanelsToViewport();

  // Window resize handler — emit event so variant can resize graph
  window.addEventListener('resize', () => {
    emit('window:resize', { width: window.innerWidth, height: window.innerHeight });
    clampPanelsToViewport();
  });
  // An explorer opening or closing, or the bar changing height, moves the frame without a window resize.
  onFrameChange(() => clampPanelsToViewport());

  // Pause all CSS animations while the tab is hidden (body.app-hidden rule)
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('app-hidden', document.hidden);
  });
}

// ── Pin toggle (event delegation for dynamic panels) ──

export function initPinToggle() {
  // Restore pinned state for static panels at boot
  document.querySelectorAll('.pin-btn').forEach(btn => {
    const panelId = btn.dataset.pin;
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const key = 'neural-pinned-' + panelId;
    if (storage.getItem(key) === 'true') {
      panel.classList.add('locked');
      btn.classList.add('pinned');
    }
  });

  // Document-level delegation — works for both static and dynamically spawned panels
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.pin-btn');
    if (!btn) return;
    const panelId = btn.dataset.pin;
    const panel = document.getElementById(panelId);
    if (!panel) return;
    e.stopPropagation();
    const pinned = panel.classList.toggle('locked');
    btn.classList.toggle('pinned', pinned);
    storage.setItem('neural-pinned-' + panelId, pinned);
  });
}
