const DEFAULT_THRESHOLD_PX = 48;

const controllers = new WeakMap();

function eventTouchY(event) {
  const touch = event?.touches?.[0] || event?.changedTouches?.[0];
  return Number.isFinite(touch?.clientY) ? touch.clientY : null;
}

export function createStickyScrollController(container, options = {}) {
  if (!container) return null;
  const existing = controllers.get(container);
  if (existing) return existing;

  const threshold = Number.isFinite(options.threshold)
    ? Math.max(0, options.threshold)
    : DEFAULT_THRESHOLD_PX;
  const view = container.ownerDocument?.defaultView || globalThis;
  const requestFrame = view.requestAnimationFrame?.bind(view)
    || ((callback) => view.setTimeout(callback, 16));
  const cancelFrame = view.cancelAnimationFrame?.bind(view)
    || view.clearTimeout?.bind(view)
    || (() => {});

  let following = options.following !== false;
  let active = options.active !== false;
  let disposed = false;
  let frameId = 0;
  let generation = 0;
  let touchY = null;
  let lastScrollTop = container.scrollTop;

  const distanceFromBottom = () => Math.max(
    0,
    container.scrollHeight - container.scrollTop - container.clientHeight,
  );
  const hasScrollableContent = () => container.scrollHeight - container.clientHeight > 1;

  const cancelScheduled = () => {
    generation += 1;
    if (!frameId) return;
    cancelFrame(frameId);
    frameId = 0;
  };

  const setFollowing = (next) => {
    const value = !!next;
    if (following === value) return;
    following = value;
    cancelScheduled();
  };

  const writeBottom = () => {
    try {
      container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
    } catch {
      container.scrollTop = container.scrollHeight;
    }
    lastScrollTop = container.scrollTop;
  };

  const scrollToBottom = ({ force = false, immediate = false } = {}) => {
    if (disposed) return false;
    if (force) setFollowing(true);
    if (!following || !active) return false;
    if (immediate) {
      cancelScheduled();
      writeBottom();
      return true;
    }
    if (frameId) return true;
    const scheduledGeneration = generation;
    frameId = requestFrame(() => {
      frameId = 0;
      if (disposed || !active || !following || generation !== scheduledGeneration) return;
      writeBottom();
    });
    return true;
  };

  const refreshPosition = () => {
    if (disposed) return false;
    const nearBottom = distanceFromBottom() <= threshold;
    if (nearBottom) setFollowing(true);
    return nearBottom;
  };

  const detachForUpwardIntent = () => {
    if (hasScrollableContent()) setFollowing(false);
  };

  const onScroll = () => {
    const nextScrollTop = container.scrollTop;
    const movedUp = nextScrollTop < lastScrollTop - 1;
    lastScrollTop = nextScrollTop;
    if (movedUp && distanceFromBottom() > 1) {
      setFollowing(false);
      return;
    }
    // A scroll event caused by writeBottom() may arrive after more streamed
    // content has already increased scrollHeight. In that case the viewport
    // is temporarily far from the new bottom without having moved upward.
    // Preserve follow mode so the queued mutation/resize frame can catch up.
    if (refreshPosition()) scrollToBottom();
  };
  const onWheel = (event) => {
    if (event.deltaY < 0) detachForUpwardIntent();
  };
  const onKeyDown = (event) => {
    if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') {
      detachForUpwardIntent();
    }
  };
  const onTouchStart = (event) => { touchY = eventTouchY(event); };
  const onTouchMove = (event) => {
    const nextY = eventTouchY(event);
    if (touchY != null && nextY != null && nextY > touchY) detachForUpwardIntent();
    touchY = nextY;
  };
  const onTouchEnd = () => { touchY = null; };

  container.addEventListener('scroll', onScroll, { passive: true });
  container.addEventListener('wheel', onWheel, { passive: true });
  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: true });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });

  const ResizeObserverCtor = view.ResizeObserver || globalThis.ResizeObserver;
  const MutationObserverCtor = view.MutationObserver || globalThis.MutationObserver;
  const observedChildren = new WeakSet();
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(() => scrollToBottom())
    : null;
  const observeChildren = () => {
    if (!resizeObserver) return;
    resizeObserver.observe(container);
    for (const child of container.children) {
      if (observedChildren.has(child)) continue;
      observedChildren.add(child);
      resizeObserver.observe(child);
    }
  };
  observeChildren();

  const mutationObserver = MutationObserverCtor
    ? new MutationObserverCtor(() => {
      observeChildren();
      scrollToBottom();
    })
    : null;
  mutationObserver?.observe(container, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'open', 'style'],
  });

  const controller = {
    scrollToBottom,
    refresh: refreshPosition,
    isFollowing: () => following,
    setActive(next) {
      if (disposed) return;
      active = !!next;
      if (!active) cancelScheduled();
      else scrollToBottom();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      cancelScheduled();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      controllers.delete(container);
    },
  };

  controllers.set(container, controller);
  return controller;
}

export function getStickyScrollController(container) {
  return container ? controllers.get(container) || null : null;
}
