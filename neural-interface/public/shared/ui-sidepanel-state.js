// Presentation only: providers retain ownership of their DOM and live sessions.
const MIN_SIZE = 320;
const MARGIN = 8;

export function clampSidepanelRect(rect, viewport) {
  const left = MARGIN;
  const top = Math.max(MARGIN, viewport.top + MARGIN);
  const availableWidth = Math.max(1, viewport.width - MARGIN * 2);
  const availableHeight = Math.max(1, viewport.height - top - MARGIN);
  const width = Math.min(availableWidth, Math.max(Math.min(MIN_SIZE, availableWidth), rect.width));
  const height = Math.min(availableHeight, Math.max(Math.min(MIN_SIZE, availableHeight), rect.height));
  return {
    x: Math.max(left, Math.min(viewport.width - MARGIN - width, rect.x)),
    y: Math.max(top, Math.min(viewport.height - MARGIN - height, rect.y)),
    width, height,
  };
}

export function resizeSidepanelRect(rect, edge, dx, dy, viewport) {
  const minWidth = Math.min(MIN_SIZE, Math.max(1, viewport.width - MARGIN * 2));
  const minHeight = Math.min(MIN_SIZE, Math.max(1, viewport.height - viewport.top - MARGIN * 2));
  let { x, y, width, height } = rect;
  if (edge.includes('w')) {
    x = Math.max(MARGIN, Math.min(rect.x + dx, rect.x + rect.width - minWidth));
    width = rect.x + rect.width - x;
  }
  if (edge.includes('e')) width = Math.max(minWidth, Math.min(viewport.width - MARGIN - x, rect.width + dx));
  if (edge.includes('n')) {
    y = Math.max(viewport.top + MARGIN, Math.min(rect.y + dy, rect.y + rect.height - minHeight));
    height = rect.y + rect.height - y;
  }
  if (edge.includes('s')) height = Math.max(minHeight, Math.min(viewport.height - MARGIN - y, rect.height + dy));
  return clampSidepanelRect({ x, y, width, height }, viewport);
}

export function readSidepanelLayout(value) {
  try {
    const saved = typeof value === 'string' ? JSON.parse(value) : value;
    if (saved?.version !== 1) throw new Error('Unknown layout version');
    const rect = saved.rect;
    const validRect = rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
      && rect.width > 0 && rect.height > 0;
    return {
      version: 1,
      mode: saved.mode === 'floating' ? 'floating' : 'docked',
      rect: validRect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      dockedWidth: Number.isFinite(saved.dockedWidth) && saved.dockedWidth > 0
        ? Math.max(320, Math.min(700, saved.dockedWidth)) : null,
    };
  } catch {
    return { version: 1, mode: 'docked', rect: null, dockedWidth: null };
  }
}

export function createSidepanelController({ load = () => null, save = () => {}, changed = () => {}, focused = () => {} } = {}) {
  const views = new Map();
  const layouts = new Map();
  let focusOrder = 0;

  function register({ id, provider, layoutKey = provider, applyVisibility }) {
    if (views.has(id)) throw new Error(`Sidepanel already registered: ${id}`);
    if (!layouts.has(layoutKey)) layouts.set(layoutKey, readSidepanelLayout(load(layoutKey)));
    const view = { id, provider, layoutKey, applyVisibility, visible: false, order: 0, layout: layouts.get(layoutKey) };
    views.set(id, view);
    changed(view, 'register');
    return view;
  }

  function focus(id) {
    const view = views.get(id);
    if (!view?.visible) return;
    view.order = ++focusOrder;
    focused(view);
  }

  function hidePeers(view) {
    for (const peer of views.values()) {
      if (peer.id !== view.id && peer.visible && (peer.layoutKey === view.layoutKey
        || (view.layout.mode === 'docked' && peer.layout.mode === 'docked'))) {
        setVisible(peer.id, false);
      }
    }
  }

  function setVisible(id, visible) {
    const view = views.get(id);
    if (!view) return;
    visible = !!visible;
    if (visible) hidePeers(view);
    if (visible !== view.visible) {
      view.visible = visible;
      changed(view, 'visibility');
      view.applyVisibility(visible);
    }
    if (visible) focus(id);
  }

  function setMode(id, mode) {
    const view = views.get(id);
    if (!view || !['docked', 'floating'].includes(mode) || mode === view.layout.mode) return;
    view.layout.mode = mode;
    if (view.visible) hidePeers(view);
    for (const peer of views.values()) {
      if (peer.layoutKey === view.layoutKey) changed(peer, 'mode');
    }
    persist(id);
    focus(id);
  }

  function updateLayout(id, patch) {
    const view = views.get(id);
    if (!view) return;
    Object.assign(view.layout, patch);
    for (const peer of views.values()) {
      if (peer.layoutKey === view.layoutKey) changed(peer, 'geometry');
    }
  }

  function persist(id) {
    const view = views.get(id);
    if (view) save(view.layoutKey, JSON.stringify(view.layout));
  }

  function unregister(id) {
    setVisible(id, false);
    views.delete(id);
  }

  return { register, unregister, setVisible, setMode, updateLayout, persist, focus,
    get: id => views.get(id), all: () => [...views.values()] };
}
