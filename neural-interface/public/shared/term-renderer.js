// ── Terminal renderer manager — budgeted WebGL lifecycle ──
//
// xterm.js renders via its DOM renderer by default; loading a WebglAddon
// upgrades a terminal to GPU rendering. Browsers cap live WebGL contexts per
// page (~16, oldest dropped past that) and the three.js neural view already
// holds one, so unmanaged one-context-per-terminal is exactly what corrupted
// glyph atlases / exhausted contexts before WebGL was disabled in May 2026.
//
// This module makes GPU rendering safe by construction:
//  - at most WEBGL_BUDGET terminals hold a WebGL context, LRU-evicted by
//    last-focus time — evicted terminals fall back to xterm's DOM renderer
//  - hidden/minimized terminals release their context (callers drive this
//    via ui-terminal.js's _syncRenderers())
//  - glyph atlas is pruned at safe points (alt-screen exit, every 1500
//    writes while on the normal buffer)
//  - context loss → DOM renderer immediately, with up to 2 delayed retries
//
// Invariant: this module only manages the RENDERER. Terminal writes/parsing
// must continue while hidden — CLI status badges read term.buffer.active and
// loop readiness detection needs the stream.

const WEBGL_BUDGET = 6;
const RETRY_DELAY_MS = 30000;
const MAX_LOSS_RETRIES = 2;
const ATLAS_PRUNE_WRITES = 1500;

let _WebglAddon = null;
let _isVisible = () => true; // injected by ui-terminal.js (_isSessionVisible)

// sessionId → { session, webgl, disposables: [], lastFocus, lossCount, cooldownUntil, retryTimer }
const _entries = new Map();

export function initRendererManager({ WebglAddon, isVisible }) {
  _WebglAddon = WebglAddon || null;
  if (typeof isVisible === 'function') _isVisible = isVisible;
}

export function hasWebgl(session) {
  return !!(session && _entries.get(session.id)?.webgl);
}

export function noteFocus(session) {
  const entry = session && _entries.get(session.id);
  if (entry) entry.lastFocus = performance.now();
}

/**
 * Give this session a WebGL renderer if eligible. Idempotent — safe to call
 * on every visibility change (_syncRenderers loops every session). On any
 * failure the terminal simply stays on the DOM renderer.
 *
 * Budget discipline: a session only evicts the least-recently-focused holder
 * when it is itself MORE recently focused — otherwise repeated sync passes
 * with >BUDGET visible terminals would rotate contexts on every UI event
 * (create/dispose churn is exactly what corrupts atlases). lastFocus is set
 * at entry creation and by noteFocus(), deliberately NOT refreshed on every
 * acquire, so sync passes don't inflate recency.
 */
export function acquireRenderer(session) {
  if (!_WebglAddon || !session?.term || session.dead) return;
  if (session._isBrowser || session._gitOutput) return;

  const existing = _entries.get(session.id);
  if (existing?.webgl) return;

  // Context-loss discipline: hard cap, then cooldown between attempts —
  // a flapping GPU must not loop dispose/create via _syncRenderers.
  if (existing && existing.lossCount > MAX_LOSS_RETRIES) return;
  if (existing && existing.cooldownUntil && performance.now() < existing.cooldownUntil) return;

  const entry = existing || { session, webgl: null, disposables: [], lastFocus: performance.now(), lossCount: 0, cooldownUntil: 0, retryTimer: null };
  _entries.set(session.id, entry);
  entry.session = session;

  // Enforce the context budget: only evict when this session out-ranks the LRU holder.
  const holders = [..._entries.values()].filter(e => e.webgl);
  if (holders.length >= WEBGL_BUDGET) {
    holders.sort((a, b) => a.lastFocus - b.lastFocus);
    const lru = holders[0];
    if (lru.lastFocus >= entry.lastFocus) return; // not newer — stay on DOM, no churn
    for (let i = 0; i <= holders.length - WEBGL_BUDGET; i++) {
      releaseRenderer(holders[i].session);
    }
  }

  let webgl;
  try {
    webgl = new _WebglAddon();
    session.term.loadAddon(webgl);
  } catch {
    try { webgl?.dispose?.(); } catch {}
    return; // stays on DOM renderer
  }
  entry.webgl = webgl;

  const term = session.term;

  // ── Atlas lifecycle ──
  // Long-running Ink/React TUIs (Claude Code) rewrite the screen thousands of
  // times per session. Each unique glyph×attr combo allocates an atlas entry
  // until GPU memory pressure triggers a context loss. Prune at two safe
  // points: when the TUI leaves the alt-screen (menus, /help exit) and every
  // 1500 parsed writes for long streaming sessions. Pruning mid alt-screen
  // frame causes a one-frame flicker, so the periodic prune only fires on the
  // normal screen.
  let writesSincePrune = 0;
  const pruneAtlas = () => {
    try { entry.webgl?.clearTextureAtlas?.(); term.refresh(0, term.rows - 1); } catch {}
  };
  try {
    const d1 = term.buffer?.onBufferChange?.(buf => {
      if (buf?.type === 'normal') pruneAtlas();
    });
    if (d1) entry.disposables.push(d1);
  } catch {}
  try {
    const d2 = term.onWriteParsed?.(() => {
      if (++writesSincePrune >= ATLAS_PRUNE_WRITES) {
        writesSincePrune = 0;
        if (term.buffer?.active?.type === 'normal') pruneAtlas();
      }
    });
    if (d2) entry.disposables.push(d2);
  } catch {}

  // Context loss → fall back to DOM renderer (xterm v6 reverts automatically
  // on addon dispose), force a refit + PTY resize so the TUI redraws into the
  // fresh cell grid, then retry WebGL after a delay (bounded).
  try {
    webgl.onContextLoss(() => _handleLoss(entry));
  } catch {}

  // Lock in cell metrics against the fresh renderer on the next frame.
  // WebGL and DOM renderers can measure cells slightly differently — if the
  // refit changes the grid, the PTY must hear about it or the TUI keeps
  // drawing at the stale size (same contract as _scheduleFit).
  requestAnimationFrame(() => {
    try {
      session.fitAddon?.fit();
      term.refresh(0, term.rows - 1);
      const l = session._lastSentResize;
      if (session.ws?.readyState === WebSocket.OPEN &&
          term.cols >= 2 && term.rows >= 2 &&
          (!l || l.cols !== term.cols || l.rows !== term.rows)) {
        session._lastSentResize = { cols: term.cols, rows: term.rows };
        session.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch {}
  });
}

/** Release this session's WebGL context (terminal reverts to DOM renderer). */
export function releaseRenderer(session) {
  const entry = session && _entries.get(session.id);
  if (!entry) return;
  for (const d of entry.disposables.splice(0)) {
    try { d.dispose?.(); } catch {}
  }
  if (entry.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
  if (entry.webgl) {
    try { entry.webgl.dispose(); } catch {}
    entry.webgl = null;
  }
}

/** Full teardown on session close — call BEFORE term.dispose(). */
export function disposeRenderer(session) {
  if (!session) return;
  releaseRenderer(session);
  _entries.delete(session.id);
}

function _handleLoss(entry) {
  const session = entry.session;
  releaseRenderer(session);
  entry.lossCount++;
  // Cooldown blocks _syncRenderers from instantly re-acquiring a flapping
  // context; the timer below is the only sanctioned retry path.
  entry.cooldownUntil = performance.now() + RETRY_DELAY_MS;

  requestAnimationFrame(() => {
    try { session.fitAddon?.fit(); session.term?.refresh(0, session.term.rows - 1); } catch {}
    // Force a PTY resize (bypass _lastSentResize dedup) so Ink redraws into
    // the fresh cell grid instead of the stale WebGL one. Use session.ws —
    // NOT a closure ws — so this survives WS reconnects.
    try {
      session._lastSentResize = null;
      if (session.ws?.readyState === WebSocket.OPEN && session.term) {
        session.ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }));
      }
    } catch {}
  });

  // Bounded retry while the terminal is still alive and actually visible
  // (full visibility predicate from ui-terminal — viewport display alone
  // misses minimized floats and hidden panels).
  if (entry.lossCount <= MAX_LOSS_RETRIES) {
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      entry.cooldownUntil = 0;
      if (!session.dead && session.viewport?.isConnected && _isVisible(session)) {
        acquireRenderer(session);
      }
    }, RETRY_DELAY_MS);
  }
}
