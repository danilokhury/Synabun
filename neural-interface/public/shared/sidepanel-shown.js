// ═══════════════════════════════════════════
// SynaBun Neural Interface — "is this inside a closed side panel?", and "run this when it is shown"
// ═══════════════════════════════════════════
// A closed side panel stays in the page, hidden and skipped (ui-sidepanel-windows.js: data-sp-visible="false",
// content-visibility: hidden). Work that reads layout in there (getClientRects, scrollHeight, a focus) makes
// the engine lay the hidden panel out for nothing, and Chrome says so in the console ("Rendering was
// performed in a subtree hidden by content-visibility"). Such work asks here first: inside a closed panel it
// is held, and done once, right after the task that shows the panel. Outside one it runs at once, as before.
//
// No layout is read here: `closest()` and one attribute. tests/sidepanel-shown.test.mjs.

const VISIBLE_ATTR = 'data-sp-visible';
const CLOSED_PANEL = `.sp-sidepanel[${VISIBLE_ATTR}="false"]`;

/** The closed side panel `el` is inside, or null (not in a side panel, or in one that is on screen). */
export function closedSidepanelOf(el) {
  return el && typeof el.closest === 'function' ? el.closest(CLOSED_PANEL) : null;
}

/**
 * Hold `run` while `el` is inside a closed side panel.
 *
 *   const gate = createShownGate(el, run);
 *   gate.request();   // runs `run` now, or once when the panel is shown (many requests while closed: one run)
 *   gate.pending();   // a request is waiting for the panel
 *   gate.cancel();    // forget a waiting request (teardown)
 *
 * `request()` returns true when `run` ran in the call. Without a MutationObserver (an old engine, a test
 * without one) nothing can be awaited, so `run` runs at once: what the caller did before there was a gate.
 */
export function createShownGate(el, run, { MutationObserver: Observer } = {}) {
  let host = null;
  let observer = null;

  const stop = () => {
    try { observer?.disconnect(); } catch { /* already gone */ }
    observer = null;
    host = null;
  };

  const wait = (panel) => {
    if (host === panel) return true;
    const Ctor = Observer || el?.ownerDocument?.defaultView?.MutationObserver || globalThis.MutationObserver;
    if (typeof Ctor !== 'function') return false;
    stop();
    host = panel;
    try {
      observer = new Ctor(() => {
        // Still closed, and still around it: keep waiting. Shown, or the element left it: now.
        if (panel.getAttribute(VISIBLE_ATTR) === 'false' && panel.contains(el)) return;
        stop();
        run();
      });
      observer.observe(panel, { attributes: true, attributeFilter: [VISIBLE_ATTR] });
    } catch {
      stop();
      return false;
    }
    return true;
  };

  return {
    request() {
      const panel = closedSidepanelOf(el);
      if (panel && wait(panel)) return false;
      if (host) stop(); // it left the closed panel (a detached window), or the panel was shown meanwhile
      run();
      return true;
    },
    pending: () => host !== null,
    cancel: stop,
  };
}
