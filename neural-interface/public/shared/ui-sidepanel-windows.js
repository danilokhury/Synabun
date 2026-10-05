import { storage } from './storage.js';
import { state } from './state.js';
import { hostedSidepanelId, sidepanelHost } from './ui-sidepanel-runtime.js';
import { reserveRightPanelLayout, clearRightPanelLayout, setRightPanelResizing } from './ui-sidepanel-layout.js';
import { createSidepanelController, clampSidepanelRect, resizeSidepanelRect } from './ui-sidepanel-state.js';

const STORAGE_PREFIX = 'synabun-sidepanel-layout-';
const surfaces = new Map();
const LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', assistant: 'SynaBun Assistant' };
const DETACH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="7" width="14" height="14" rx="2"/><path d="M13 3h8v8M21 3l-9 9"/></svg>';
const DOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16M6 12h6m-3-3 3 3-3 3"/></svg>';
const MOVE_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="4" r="1"/><circle cx="11" cy="4" r="1"/><circle cx="5" cy="8" r="1"/><circle cx="11" cy="8" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="11" cy="12" r="1"/></svg>';
let interaction = null;

const controller = createSidepanelController({
  load: key => hostedSidepanelId ? null : storage.getItem(STORAGE_PREFIX + key),
  save: (key, value) => { if (!hostedSidepanelId) storage.setItem(STORAGE_PREFIX + key, value); },
  changed: (view, reason) => {
    if (!view.visible && interaction?.id === view.id) finishInteraction(true);
    renderPresentation(view);
    if (reason !== 'geometry' || view.layout.mode === 'docked') {
      syncSidepanelLayout(view.id, reason === 'geometry' ? view.layout.dockedWidth : undefined);
    }
  },
  focused: view => {
    state.lastActivePanel = view.provider;
    state.lastActiveSidepanel = view.id;
    if (hostedSidepanelId) sidepanelHost()?.focus(hostedSidepanelId);
    // Bounded ranks keep panels above workspace windows and below app modals.
    const ordered = controller.all().filter(entry => entry.visible).sort((a, b) => a.order - b.order);
    ordered.forEach((entry, i) => {
      const element = surfaces.get(entry.id)?.element;
      element?.style.setProperty('--sp-window-layer', String(11000 + i));
      element?.classList.toggle('sp-window-focused', entry.id === view.id);
    });
  },
});

function viewport() {
  return {
    width: window.innerWidth, height: window.innerHeight,
    top: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--navbar-height')) || 48,
  };
}

function injectStyles() {
  if (document.getElementById('sidepanel-window-styles')) return;
  const style = document.createElement('style');
  style.id = 'sidepanel-window-styles';
  style.textContent = `
    html .sp-sidepanel { z-index: var(--sp-window-layer, 11000) !important; }
    html .sp-sidepanel[data-sp-visible="false"] { visibility: hidden; pointer-events: none; }
    html .sp-sidepanel.sp-floating {
      right: auto; bottom: auto; min-width: 0; max-width: none; min-height: 0;
      transform: none !important; transition: opacity .15s ease;
    }
    .sp-sidepanel.sp-floating.sp-window-focused { border-color: rgba(148,163,184,.38); }
    .sp-sidepanel.sp-floating > :is(.cp-resize-handle,.cxp-resize-handle,.ocpv2-resize-handle,.asp-resize-handle) { display: none; }
    .sp-window-move { display: none !important; }
    .sp-floating .sp-window-move { display: inline-flex !important; cursor: grab; flex-shrink: 0; }
    .sp-floating > :is(.cp-header,.cxp-header,.ocpv2-header,.asp-header) { cursor: grab; touch-action: none; }
    .sp-window-toggle svg, .sp-window-move svg { width: 13px; height: 13px; pointer-events: none; }
    .sp-window-resize { display: none; position: absolute; z-index: 20; touch-action: none; }
    .sp-floating > .sp-window-resize { display: block; }
    .sp-window-resize[data-edge="n"] { top: -3px; left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
    .sp-window-resize[data-edge="s"] { bottom: -3px; left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
    .sp-window-resize[data-edge="e"] { right: -3px; top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
    .sp-window-resize[data-edge="w"] { left: -3px; top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
    .sp-window-resize[data-edge="ne"], .sp-window-resize[data-edge="nw"],
    .sp-window-resize[data-edge="se"], .sp-window-resize[data-edge="sw"] { width: 12px; height: 12px; }
    .sp-window-resize[data-edge="ne"] { top: -3px; right: -3px; cursor: nesw-resize; }
    .sp-window-resize[data-edge="nw"] { top: -3px; left: -3px; cursor: nwse-resize; }
    .sp-window-resize[data-edge="se"] { bottom: -3px; right: -3px; cursor: nwse-resize; }
    .sp-window-resize[data-edge="sw"] { bottom: -3px; left: -3px; cursor: nesw-resize; }
    .sp-floating > .sp-window-resize[data-edge="se"]::after {
      content: ''; position: absolute; right: 4px; bottom: 4px; width: 6px; height: 6px;
      border-right: 1px solid #94a3b8; border-bottom: 1px solid #94a3b8;
    }
    .sp-sidepanel [data-sidepanel-handle]:focus-visible, .sp-window-toggle:focus-visible {
      outline: 2px solid #3b82f6; outline-offset: 2px;
    }
    html .sp-sidepanel.sp-window-interacting {
      transition: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
      background: rgba(18,18,20,.985) !important;
    }
    .sp-window-interacting iframe { pointer-events: none; }
    .sp-dock-resize { touch-action: none; }
  `;
  document.head.appendChild(style);
}

function renderPresentation(view) {
  const surface = surfaces.get(view.id);
  if (!surface) return;
  const { element, toggle, dockHandle, moveHandle } = surface;
  const floating = view.layout.mode === 'floating';
  element.classList.toggle('sp-floating', floating);
  element.dataset.spVisible = String(view.visible);
  element.inert = !view.visible;
  if (surface.renderedMode !== view.layout.mode) {
    toggle.title = floating ? 'Dock panel' : 'Detach panel';
    toggle.setAttribute('aria-label', `${toggle.title}: ${LABELS[view.provider]}`);
    toggle.setAttribute('aria-pressed', String(floating));
    toggle.innerHTML = floating ? DOCK_ICON : DETACH_ICON;
    surface.renderedMode = view.layout.mode;
  }
  moveHandle.tabIndex = floating ? 0 : -1;
  if (dockHandle) dockHandle.tabIndex = floating ? -1 : 0;
  if (floating && view.layout.rect) {
    const rect = view.layout.rect;
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  } else {
    element.style.left = '';
    element.style.top = '';
    element.style.height = '';
    if (view.layout.dockedWidth) element.style.width = `${view.layout.dockedWidth}px`;
  }
}

export function registerSidepanel({ owner, provider, layoutKey = provider, element, header, actions, buttonClass, dockHandle, applyVisibility }) {
  injectStyles();
  element.classList.add('sp-sidepanel');
  element.dataset.sidepanelProvider = provider;
  element.tabIndex = -1;
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', `${LABELS[provider]} sidepanel`);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = `${buttonClass} sp-window-toggle`;
  actions.prepend(toggle);
  const moveHandle = document.createElement('button');
  moveHandle.type = 'button';
  moveHandle.className = `${buttonClass} sp-window-move`;
  moveHandle.dataset.sidepanelHandle = 'move';
  moveHandle.title = 'Move panel (arrow keys; Shift for larger steps)';
  moveHandle.setAttribute('aria-label', `Move ${LABELS[provider]} panel with arrow keys`);
  moveHandle.innerHTML = MOVE_ICON;
  header.prepend(moveHandle);
  const abort = new AbortController();
  const listen = (target, event, callback, options = {}) => target.addEventListener(event, callback, { ...options, signal: abort.signal });
  surfaces.set(owner, { element, toggle, dockHandle, moveHandle, abort });
  controller.register({ id: owner, provider, layoutKey, applyVisibility });
  ensureFloatingRect(owner);
  listen(toggle, 'click', () => {
    if (controller.get(owner).layout.mode === 'floating') dockSidepanel(owner);
    else detachSidepanel(owner);
  });
  listen(element, 'pointerdown', event => {
    controller.focus(owner);
    const control = event.target.closest('button,input,select,textarea,a,[contenteditable],[tabindex]');
    if (!control || control === element) element.focus({ preventScroll: true });
  }, { capture: true });
  listen(element, 'focusin', () => controller.focus(owner));
  listen(header, 'pointerdown', event => {
    if (controller.get(owner).layout.mode !== 'floating') return;
    if (!event.target.closest('.sp-window-move') && event.target.closest('button,input,select,textarea,a,[contenteditable],[draggable="true"]')) return;
    startInteraction(owner, 'move', event);
  });
  listen(moveHandle, 'keydown', event => keyboardInteraction(owner, 'move', event));
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const handle = document.createElement('div');
    handle.className = 'sp-window-resize';
    handle.dataset.edge = edge;
    handle.dataset.sidepanelHandle = 'resize';
    handle.tabIndex = edge === 'se' ? 0 : -1;
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', `Resize ${LABELS[provider]} panel with arrow keys`);
    element.appendChild(handle);
    listen(handle, 'pointerdown', event => startInteraction(owner, edge, event));
    listen(handle, 'keydown', event => keyboardInteraction(owner, edge, event));
  }
  if (dockHandle) {
    dockHandle.classList.add('sp-dock-resize');
    dockHandle.dataset.sidepanelHandle = 'resize';
    dockHandle.setAttribute('role', 'separator');
    dockHandle.setAttribute('aria-orientation', 'vertical');
    dockHandle.setAttribute('aria-label', `Resize docked ${LABELS[provider]} panel with arrow keys`);
    listen(dockHandle, 'pointerdown', event => startInteraction(owner, 'dock', event));
    listen(dockHandle, 'keydown', event => keyboardInteraction(owner, 'dock', event));
  }
  return () => {
    if (interaction?.id === owner) finishInteraction(true);
    controller.unregister(owner);
    clearRightPanelLayout(owner);
    abort.abort();
    surfaces.delete(owner);
  };
}

export const setSidepanelVisible = (owner, visible) => {
  if (hostedSidepanelId && !visible) { sidepanelHost()?.hide(hostedSidepanelId); return; }
  controller.setVisible(owner, visible);
};
export const focusSidepanel = owner => controller.focus(owner);
export const getSidepanelPresentation = owner => controller.get(owner);

export function openAnotherSidepanelSession(owner, provider, defaults = {}) {
  if (!hostedSidepanelId && controller.get(owner)?.layout.mode !== 'floating') return false;
  const host = sidepanelHost();
  if (!host) return false;
  host.open(provider, defaults);
  return true;
}

export function isHostedSessionFocused() {
  return !hostedSidepanelId && !!sidepanelHost()?.has(state.lastActiveSidepanel);
}

export function sendToFocusedSession(kind, data) {
  if (!isHostedSessionFocused()) return false;
  sidepanelHost().send(state.lastActiveSidepanel, kind, data);
  return true;
}

export function syncSidepanelLayout(owner, knownWidth) {
  const view = controller.get(owner);
  const panel = surfaces.get(owner)?.element;
  if (!view?.visible || view.layout.mode !== 'docked' || !panel) {
    clearRightPanelLayout(owner);
    return;
  }
  reserveRightPanelLayout(owner, typeof knownWidth === 'number' ? knownWidth + 20 : panel, 20);
}

function ensureFloatingRect(owner) {
  const view = controller.get(owner);
  if (view.layout.mode !== 'floating') return;
  const element = surfaces.get(owner).element;
  const rect = view.layout.rect || { x: window.innerWidth - element.offsetWidth - 44, y: viewport().top + 44,
    width: element.offsetWidth, height: element.offsetHeight };
  const clamped = clampSidepanelRect(rect, viewport());
  if (!view.layout.rect || Object.keys(clamped).some(key => clamped[key] !== view.layout.rect[key])) {
    controller.updateLayout(owner, { rect: clamped });
  }
}

export function detachSidepanel(owner) {
  const view = controller.get(owner);
  if (!view || view.layout.mode === 'floating') return;
  const rect = surfaces.get(owner).element.getBoundingClientRect();
  const offset = 24 * (1 + controller.all().filter(entry => entry.visible && entry.layout.mode === 'floating').length);
  controller.updateLayout(owner, {
    dockedWidth: rect.width,
    rect: clampSidepanelRect(view.layout.rect || { x: rect.x - offset, y: rect.y + offset, width: rect.width, height: rect.height }, viewport()),
  });
  controller.setMode(owner, 'floating');
  window.dispatchEvent(new Event('resize'));
}

export function dockSidepanel(owner) {
  if (interaction?.id === owner) finishInteraction(false);
  controller.setMode(owner, 'docked');
  window.dispatchEvent(new Event('resize'));
}

export function sidepanelAcceptsKeyboard(provider, event) {
  if (isHostedSessionFocused()) return false;
  if (event.defaultPrevented || interaction) return false;
  const target = event.target;
  if (target?.closest?.('[data-sidepanel-handle], [role="dialog"], [aria-modal="true"]')) return false;
  const surface = target?.closest?.('[data-sidepanel-provider]');
  if (surface) return surface.dataset.sidepanelProvider === provider;
  if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return false;
  return state.lastActivePanel === provider;
}

function startInteraction(id, kind, event) {
  if (event.button !== 0 || interaction) return;
  const view = controller.get(id);
  if (!view?.visible || (kind === 'dock') !== (view.layout.mode === 'docked')) return;
  event.preventDefault();
  event.stopPropagation();
  const element = surfaces.get(id).element;
  const focusTarget = kind === 'move' ? surfaces.get(id).moveHandle : event.currentTarget;
  focusTarget.focus({ preventScroll: true });
  interaction = { id, kind, pointerId: event.pointerId, target: event.currentTarget,
    x: event.clientX, y: event.clientY, dx: 0, dy: 0, raf: 0, viewport: viewport(),
    rect: view.layout.rect && { ...view.layout.rect }, width: element.offsetWidth,
    cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  element.classList.add('sp-window-interacting');
  document.body.classList.add('ui-interacting');
  document.body.style.userSelect = 'none';
  document.body.style.cursor = kind === 'move' ? 'grabbing' : kind === 'dock' ? 'col-resize' : `${kind}-resize`;
  if (kind === 'dock') setRightPanelResizing(true);
}

function applyInteraction() {
  if (!interaction) return;
  const { id, kind, rect, width, dx, dy, viewport: bounds } = interaction;
  interaction.raf = 0;
  if (kind === 'dock') {
    controller.updateLayout(id, { dockedWidth: Math.max(320, Math.min(700, width - dx)) });
  } else {
    controller.updateLayout(id, { rect: kind === 'move'
      ? clampSidepanelRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, bounds)
      : resizeSidepanelRect(rect, kind, dx, dy, bounds) });
  }
}

function finishInteraction(cancelled) {
  if (!interaction) return;
  const current = interaction;
  if (current.raf) cancelAnimationFrame(current.raf);
  if (!cancelled) applyInteraction();
  interaction = null;
  if (cancelled) controller.updateLayout(current.id, current.kind === 'dock'
    ? { dockedWidth: current.width } : { rect: current.rect });
  if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  surfaces.get(current.id)?.element.classList.remove('sp-window-interacting');
  document.body.classList.remove('ui-interacting');
  document.body.style.cursor = current.cursor;
  document.body.style.userSelect = current.userSelect;
  if (current.kind === 'dock') setRightPanelResizing(false);
  if (!cancelled) {
    controller.persist(current.id);
    window.dispatchEvent(new Event('resize'));
  }
}

function keyboardInteraction(id, kind, event) {
  const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (!delta) return;
  event.preventDefault();
  event.stopPropagation();
  const view = controller.get(id);
  const step = event.shiftKey ? 24 : 8;
  const [dx, dy] = delta.map(value => value * step);
  if (kind === 'dock') {
    controller.updateLayout(id, { dockedWidth: Math.max(320, Math.min(700, surfaces.get(id).element.offsetWidth - dx)) });
  } else if (view.layout.rect) {
    const rect = view.layout.rect;
    controller.updateLayout(id, { rect: kind === 'move'
      ? clampSidepanelRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, viewport())
      : resizeSidepanelRect(rect, kind, dx, dy, viewport()) });
  }
  controller.persist(id);
}

window.addEventListener('pointermove', event => {
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  interaction.dx = event.clientX - interaction.x;
  interaction.dy = event.clientY - interaction.y;
  if (!interaction.raf) interaction.raf = requestAnimationFrame(applyInteraction);
});
window.addEventListener('pointerup', event => {
  if (event.pointerId === interaction?.pointerId) {
    interaction.dx = event.clientX - interaction.x;
    interaction.dy = event.clientY - interaction.y;
    finishInteraction(false);
  }
});
window.addEventListener('pointercancel', event => { if (event.pointerId === interaction?.pointerId) finishInteraction(true); });
window.addEventListener('lostpointercapture', event => { if (event.pointerId === interaction?.pointerId) finishInteraction(true); });
window.addEventListener('blur', () => finishInteraction(true));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && interaction) {
    event.preventDefault();
    event.stopImmediatePropagation();
    finishInteraction(true);
  }
}, { capture: true });
function refreshViewport() {
  if (interaction) finishInteraction(true);
  for (const view of controller.all()) {
    if (view.layout.mode === 'floating') ensureFloatingRect(view.id);
    else syncSidepanelLayout(view.id);
  }
}
window.addEventListener('resize', refreshViewport);

// UI settings and the measured title bar can change without a window resize.
// Inspect only those inline variables so reservation writes cannot retrigger us.
function viewportStyleKey() {
  const style = document.documentElement.style;
  return `${style.getPropertyValue('--ui-scale')}|${style.getPropertyValue('--navbar-height')}`;
}
let lastViewportStyle = viewportStyleKey();
new MutationObserver(() => {
  const next = viewportStyleKey();
  if (next === lastViewportStyle) return;
  lastViewportStyle = next;
  refreshViewport();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
