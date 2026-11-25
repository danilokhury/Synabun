const DEFAULT_THRESHOLD_PX = 48;
// A side panel that is closed (ui-sidepanel-windows.js keeps data-sp-visible on every registered panel).
const HOST_VISIBLE_ATTR = 'data-sp-visible';
const CLOSED_HOST = `.sp-sidepanel[${HOST_VISIBLE_ATTR}="false"]`;

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
  let pointerDown = false;
  let pointerScrolled = false;
  let lastScrollTop = container.scrollTop;
  let lastScrollHeight = null;
  let lastClientHeight = null;

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
    lastScrollHeight = container.scrollHeight;
    lastClientHeight = container.clientHeight;
  };

  // A transcript inside a closed side panel is not drawn (ui-sidepanel-windows.js: data-sp-visible="false",
  // content-visibility: hidden). Scrolling it reads its height, which makes the engine lay the whole hidden
  // panel out: once per frame for as long as a session streams there. The follow is kept instead and the
  // scroll is made when the panel is shown: the attribute changes inside the task that opens it, the
  // observer answers right after that task and the frame that draws the panel is already at the bottom.
  let waitingHost = null;
  let hostObserver = null;
  const stopWaitingForHost = () => {
    try { hostObserver?.disconnect(); } catch { /* already gone */ }
    hostObserver = null;
    waitingHost = null;
  };
  const closedHost = () => (typeof container.closest === 'function' ? container.closest(CLOSED_HOST) : null);
  const waitForHost = (host) => {
    if (waitingHost === host) return true;
    const HostObserver = view.MutationObserver || globalThis.MutationObserver;
    if (typeof HostObserver !== 'function') return false;
    stopWaitingForHost();
    waitingHost = host;
    hostObserver = new HostObserver(() => {
      if (disposed) { stopWaitingForHost(); return; }
      if (host.getAttribute(HOST_VISIBLE_ATTR) === 'false' && host.contains(container)) return;
      stopWaitingForHost();
      scrollToBottom();
    });
    hostObserver.observe(host, { attributes: true, attributeFilter: [HOST_VISIBLE_ATTR] });
    return true;
  };

  const scrollToBottom = ({ force = false, immediate = false } = {}) => {
    if (disposed) return false;
    if (force) setFollowing(true);
    if (!following || !active) return false;
    const host = closedHost();
    if (host && waitForHost(host)) {
      cancelScheduled();
      return true;
    }
    if (!host && waitingHost) stopWaitingForHost(); // moved out of the closed panel (a detached window)
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

  const onPointerDown = (event) => {
    if (event?.target && event.target !== container) return;
    pointerDown = true;
    pointerScrolled = false;
  };
  const onPointerUp = () => {
    if (!pointerDown) return;
    const scrolled = pointerScrolled;
    pointerDown = false;
    pointerScrolled = false;
    if (disposed || !active || !scrolled) return;
    if (!following && refreshPosition()) scrollToBottom();
  };

  const onScroll = () => {
    const nextScrollTop = container.scrollTop;
    const nextScrollHeight = container.scrollHeight;
    const nextClientHeight = container.clientHeight;
    if (pointerDown) pointerScrolled = true;
    const prevScrollTop = lastScrollTop;
    const prevScrollHeight = lastScrollHeight;
    const prevClientHeight = lastClientHeight;
    const movedUp = nextScrollTop < prevScrollTop - 1;
    lastScrollTop = nextScrollTop;
    lastScrollHeight = nextScrollHeight;
    lastClientHeight = nextClientHeight;

    const remaining = Math.max(0, nextScrollHeight - nextScrollTop - nextClientHeight);
    if (movedUp && remaining > 1) {
      const maxShrankBy = (prevScrollHeight != null && prevClientHeight != null)
        ? Math.max(0, (prevScrollHeight - prevClientHeight) - (nextScrollHeight - nextClientHeight))
        : 0;
      const clientGrewBy = prevClientHeight != null ? Math.max(0, nextClientHeight - prevClientHeight) : 0;
      const layoutShrink = Math.max(maxShrankBy, clientGrewBy);
      // A layout shrink (composer collapsing, top rows pruned/collapsed, streamed row
      // replaced, or zoom) makes the engine clamp scrollTop downward without user intent.
      // Keep following when no user pointer/wheel/key/touch gesture is active and either a
      // follow frame is already queued from the mutation/resize or the shrinkage accounts
      // for the drop.
      const clampedByLayout = following && !pointerDown && (
        frameId !== 0
        || (layoutShrink > 0 && (prevScrollTop - nextScrollTop) <= layoutShrink + 2)
      );
      if (!clampedByLayout) {
        setFollowing(false);
        return;
      }
    }
    // Never yank the scrollbar out of the user's hand mid-drag; wait for release or true bottom.
    if (pointerDown) {
      if (remaining <= 1) setFollowing(true);
      return;
    }
    // A scroll event caused by writeBottom() may arrive after more streamed
    // content has already increased scrollHeight. In that case the viewport
    // is temporarily far from the new bottom without having moved upward.
    // Preserve follow mode so the queued mutation/resize frame can catch up.
    if (following) {
      if (remaining > 0.5) scrollToBottom();
      return;
    }
    // Detached: only a scroll back down near the bottom follows again. An animated key or wheel scroll upward
    // (WebKit's PageUp / ArrowUp) can step 1 px or less, under movedUp's 1 px; treating that step as "near the
    // bottom" re-attached and the follow frame snapped the reader back, cancelling their scroll.
    if (nextScrollTop < prevScrollTop) return;
    if (refreshPosition()) scrollToBottom();
  };
  const onWheel = (event) => {
    if (event.deltaY < 0) detachForUpwardIntent();
  };
  const onKeyDown = (event) => {
    if (
      event.key === 'PageUp'
      || event.key === 'ArrowUp'
      || event.key === 'Home'
      || (event.key === ' ' && event.shiftKey)
    ) {
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
  const fonts = container.ownerDocument?.fonts;
  const onFontsDone = () => { if (!disposed) scrollToBottom(); };

  container.addEventListener('scroll', onScroll, { passive: true });
  container.addEventListener('wheel', onWheel, { passive: true });
  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('pointerdown', onPointerDown, { passive: true });
  container.addEventListener('mousedown', onPointerDown, { passive: true });
  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: true });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });
  if (typeof view?.addEventListener === 'function') {
    view.addEventListener('pointerup', onPointerUp, { passive: true });
    view.addEventListener('pointercancel', onPointerUp, { passive: true });
    view.addEventListener('mouseup', onPointerUp, { passive: true });
    view.addEventListener('blur', onPointerUp, { passive: true });
  }
  if (typeof fonts?.addEventListener === 'function') {
    fonts.addEventListener('loadingdone', onFontsDone);
  }

  const ResizeObserverCtor = view.ResizeObserver || globalThis.ResizeObserver;
  const MutationObserverCtor = view.MutationObserver || globalThis.MutationObserver;
  // ResizeObserver retains its targets, even after they leave the transcript.
  // Keep only current rows: OpenCode replaces a row on every streaming update.
  const observedChildren = new Set();
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(() => scrollToBottom())
    : null;
  const observeChildren = () => {
    if (!resizeObserver) return;
    const current = new Set(container.children);
    for (const child of observedChildren) {
      if (current.has(child)) continue;
      resizeObserver.unobserve(child);
      observedChildren.delete(child);
    }
    for (const child of current) {
      if (observedChildren.has(child)) continue;
      observedChildren.add(child);
      // Observe border-box so row padding/border changes also trigger bottom lock.
      try {
        resizeObserver.observe(child, { box: 'border-box' });
      } catch {
        resizeObserver.observe(child);
      }
    }
  };
  resizeObserver?.observe(container);
  observeChildren();

  const mutationObserver = MutationObserverCtor
    ? new MutationObserverCtor((records) => {
      if (disposed) return;
      // Nested text/class changes need scrolling, but cannot change row ownership.
      if (records.some(record => record.type === 'childList' && record.target === container)) observeChildren();
      scrollToBottom();
    })
    : null;
  mutationObserver?.observe(container, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'open', 'style', 'data-state', 'aria-expanded', 'aria-hidden'],
  });

  const controller = {
    scrollToBottom,
    // A single transcript container may host several tabs; restore each tab's
    // following intent before its rows are replaced (and cancel stale frames).
    setFollowing,
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
      pointerDown = false;
      pointerScrolled = false;
      cancelScheduled();
      stopWaitingForHost();
      resizeObserver?.disconnect();
      observedChildren.clear();
      mutationObserver?.disconnect();
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('mousedown', onPointerDown);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      if (typeof view?.removeEventListener === 'function') {
        view.removeEventListener('pointerup', onPointerUp);
        view.removeEventListener('pointercancel', onPointerUp);
        view.removeEventListener('mouseup', onPointerUp);
        view.removeEventListener('blur', onPointerUp);
      }
      if (typeof fonts?.removeEventListener === 'function') {
        fonts.removeEventListener('loadingdone', onFontsDone);
      }
      controllers.delete(container);
    },
  };

  controllers.set(container, controller);
  return controller;
}

export function getStickyScrollController(container) {
  return container ? controllers.get(container) || null : null;
}
