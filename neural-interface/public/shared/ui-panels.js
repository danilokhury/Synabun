// ═══════════════════════════════════════════
// SynaBun Neural Interface — Panel System
// Drag, resize, pin toggle, layout save/restore, viewport clamping
// ═══════════════════════════════════════════

import { KEYS } from './constants.js';
import { state, emit } from './state.js';

const MIN_W = 140;
const MIN_H = 100;

// ── Viewport clamping ──

export function clampPanelsToViewport() {
  document.querySelectorAll('.resizable').forEach(el => {
    const minVisible = 60;
    const minHeight = 100;
    const minWidth = 140;

    let rect = el.getBoundingClientRect();

    if (el.style.left) {
      const currentLeft = parseInt(el.style.left);
      const maxLeft = Math.max(0, window.innerWidth - rect.width - 10);
      if (currentLeft > maxLeft) {
        el.style.left = maxLeft + 'px';
      }
    }

    if (el.style.top) {
      const currentTop = parseInt(el.style.top);
      const maxTop = Math.max(0, window.innerHeight - rect.height - 10);
      if (currentTop > maxTop) {
        el.style.top = maxTop + 'px';
      }
    }

    rect = el.getBoundingClientRect();

    if (rect.right > window.innerWidth && el.style.width) {
      const maxWidth = window.innerWidth - rect.left - 10;
      if (maxWidth > minWidth) {
        el.style.width = maxWidth + 'px';
      }
    }

    rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      const maxHeight = window.innerHeight - rect.top - 10;
      if (maxHeight > minHeight) {
        el.style.maxHeight = maxHeight + 'px';
        if (el.style.height && el.style.height !== 'auto') {
          const currentHeight = parseInt(el.style.height);
          if (currentHeight > maxHeight) {
            el.style.height = maxHeight + 'px';
          }
        }
      }
    }
  });
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
  localStorage.setItem(KEYS.PANEL_PREFIX + id, JSON.stringify(data));
}

export function restorePanelLayout(el, sizeOnly) {
  const saved = localStorage.getItem(KEYS.PANEL_PREFIX + el.id);
  if (!saved) return;
  try {
    const data = JSON.parse(saved);
    if (!sizeOnly) {
      if (data.left && data.left !== 'auto') el.style.left = data.left;
      if (data.top) el.style.top = data.top;
      if (data.right) el.style.right = data.right;
    }
    if (data.width) el.style.width = data.width;
    if (data.height) el.style.height = data.height;
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
    ensureLeftTop(el);
    const s = getElScale(el);
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    dragging = {
      el, startX: e.clientX, startY: e.clientY,
      startLeft: parseFloat(cs.left), startTop: parseFloat(cs.top),
      startVisualLeft: rect.left, startVisualTop: rect.top,
      startW: rect.width, startH: rect.height,
    };
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  });

  // RAF tick
  function applyInteraction() {
    rafPending = false;
    const mx = latestMouseX;
    const my = latestMouseY;

    if (resizing) {
      const { el, dir, scale: rScale, startX, startY, startW, startH, startL, startT, minW: rMinW, minH: rMinH } = resizing;
      const dx = (mx - startX) / rScale;
      const dy = (my - startY) / rScale;

      let newW = startW, newH = startH, newL = startL, newT = startT;

      if (dir === 'r' || dir === 'br' || dir === 'tr') newW = Math.max(rMinW, startW + dx);
      if (dir === 'l' || dir === 'bl' || dir === 'tl') { newW = Math.max(rMinW, startW - dx); newL = startL + startW - newW; }
      if (dir === 'b' || dir === 'br' || dir === 'bl') newH = Math.max(rMinH, startH + dy);
      if (dir === 't' || dir === 'tr' || dir === 'tl') { newH = Math.max(rMinH, startH - dy); newT = startT + startH - newH; }

      newL = Math.max(0, newL);
      newT = Math.max(0, newT);
      const maxWidth = window.innerWidth / rScale - newL - 10;
      const maxHeight = window.innerHeight / rScale - newT - 10;
      newW = Math.min(newW, maxWidth);
      newH = Math.min(newH, maxHeight);

      el.style.width = newW + 'px';
      el.style.height = newH + 'px';
      el.style.left = newL + 'px';
      el.style.top = newT + 'px';
      el.style.maxHeight = maxHeight + 'px';
    }

    if (dragging) {
      const { el, startX, startY, startLeft, startTop, startVisualLeft, startVisualTop, startW, startH } = dragging;
      const dx = mx - startX;
      const dy = my - startY;

      const clampedDx = Math.max(-startVisualLeft, Math.min(window.innerWidth - startW - 10 - startVisualLeft, dx));
      const clampedDy = Math.max(-startVisualTop, Math.min(window.innerHeight - startH - 10 - startVisualTop, dy));

      let finalLeft = startLeft + clampedDx;
      let finalTop  = startTop + clampedDy;

      if (state.gridSnap) {
        const gs = state.gridSize || 20;
        finalLeft = Math.round(finalLeft / gs) * gs;
        finalTop  = Math.round(finalTop / gs) * gs;
      }

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
      resizing = null;
    }
    if (dragging) {
      dragging.el.classList.remove('dragging');
      savePanelLayout(dragging.el);
      dragging = null;
    }
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
}

// ── Pin toggle (event delegation for dynamic panels) ──

export function initPinToggle() {
  // Restore pinned state for static panels at boot
  document.querySelectorAll('.pin-btn').forEach(btn => {
    const panelId = btn.dataset.pin;
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const key = 'neural-pinned-' + panelId;
    if (localStorage.getItem(key) === 'true') {
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
    localStorage.setItem('neural-pinned-' + panelId, pinned);
  });
}
