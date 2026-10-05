// ── Terminal renderer manager — budgeted WebGL lifecycle ──
//
// xterm.js renders via its DOM renderer by default; loading a WebglAddon
// upgrades a terminal to GPU rendering. Browsers cap live WebGL contexts per
// page (~16, oldest dropped past that) and the three.js neural view already
// holds one, so unmanaged one-context-per-terminal is exactly what corrupted
// glyph atlases / exhausted contexts before WebGL was disabled in May 2026.
//
// This module makes GPU rendering safe by construction:
//  - at most WEBGL_BUDGET terminals hold a WebGL context. Contexts stay WARM
//    while a terminal is hidden (switching tabs or returning to the app must
//    not recompile shaders and rebuild the glyph atlas). Budget eviction takes
//    hidden holders first (LRU), then the least-recently-focused visible one.
//    Evicted terminals fall back to xterm's DOM renderer.
//  - ui-terminal.js's _syncRenderers() only ACQUIRES for visible terminals;
//    nothing here releases on hide.
//  - the glyph atlas is SHARED by every terminal with identical options
//    (addon-webgl CharAtlasCache), so it is pruned for all holders at once,
//    only when it has grown by ATLAS_PRUNE_PAGES pages, the page is visible
//    and no holder has parsed output for ATLAS_IDLE_MS.
//  - context loss → DOM renderer immediately, with up to 2 delayed retries.
//    A loss while the page is hidden is the OS reclaiming GPU memory from a
//    background app: it neither counts nor starts the cooldown, and the
//    context is re-acquired as soon as the terminal is visible again.
//
// Invariant: this module only manages the RENDERER. Terminal writes/parsing
// must continue while hidden — CLI status badges read term.buffer.active and
// loop readiness detection needs the stream.

const WEBGL_BUDGET = 6;
const RETRY_DELAY_MS = 30000;
const MAX_LOSS_RETRIES = 2;
const ATLAS_PRUNE_PAGES = 8;     // atlas pages added since the last prune
const ATLAS_IDLE_MS = 2000;      // no holder parsed output for this long
// addon-webgl waits 3 s for 'webglcontextrestored' before firing onContextLoss,
// so a context the OS dropped while hidden can report just after we return.
const HIDDEN_LOSS_GRACE_MS = 5000;

let _WebglAddon = null;
let _isVisible = () => true; // injected by ui-terminal.js (_isSessionVisible)

// sessionId → { session, webgl, disposables: [], lastFocus, lossCount, cooldownUntil, retryTimer, lostWhileHidden }
const _entries = new Map();

// Atlas pages seen since the last prune. Holders forward the SAME canvas
// objects for a shared atlas, so a Set dedupes them across terminals.
const _atlasPages = new Set();
let _lastWriteAt = 0;
let _pruneTimer = null;
let _lastVisibleAt = -Infinity;   // last hidden → visible transition
let _visibilityWired = false;

const _stats = { contextsCreated: 0, losses: 0, hiddenLosses: 0, evictions: 0, prunes: 0 };

export function initRendererManager({ WebglAddon, isVisible }) {
  _WebglAddon = WebglAddon || null;
  if (typeof isVisible === 'function') _isVisible = isVisible;
  if (!_visibilityWired && typeof document !== 'undefined') {
    _visibilityWired = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      _lastVisibleAt = performance.now();
      _schedulePrune(); // a prune deferred while hidden
    });
  }
}

export function hasWebgl(session) {
  return !!(session && _entries.get(session.id)?.webgl);
}

export function noteFocus(session) {
  const entry = session && _entries.get(session.id);
  if (entry) entry.lastFocus = performance.now();
}

/** Diagnostics for window.__synabunTermStats(). */
export function rendererState(session) {
  const e = session && _entries.get(session.id);
  if (!e) return { renderer: 'dom', lossCount: 0, cooldown: false, lostWhileHidden: false };
  return {
    renderer: e.webgl ? 'webgl' : 'dom',
    lossCount: e.lossCount,
    cooldown: !!(e.cooldownUntil && performance.now() < e.cooldownUntil),
    lostWhileHidden: !!e.lostWhileHidden,
  };
}

export function rendererStats() {
  let holders = 0;
  for (const e of _entries.values()) if (e.webgl) holders++;
  return { ..._stats, holders, budget: WEBGL_BUDGET, atlasPagesSincePrune: _atlasPages.size };
}

function _visible(session) {
  try { return !!_isVisible(session); } catch { return false; }
}

/** Free enough budget for `entry`. Hidden holders go first (LRU); a visible
 *  holder is only evicted when `entry` is more recently focused — otherwise
 *  sync passes with > BUDGET visible terminals would rotate contexts on every
 *  UI event (create/dispose churn is what corrupts atlases). */
function _makeRoom(entry) {
  const holders = [];
  for (const e of _entries.values()) if (e.webgl && e !== entry) holders.push(e);
  const need = holders.length - WEBGL_BUDGET + 1;
  if (need <= 0) return true;
  const hidden = [];
  const shown = [];
  for (const e of holders) (_visible(e.session) ? shown : hidden).push(e);
  hidden.sort((a, b) => a.lastFocus - b.lastFocus);
  shown.sort((a, b) => a.lastFocus - b.lastFocus);
  const victims = hidden.slice(0, need);
  for (const e of shown) {
    if (victims.length >= need) break;
    if (e.lastFocus >= entry.lastFocus) break; // not newer — stay on DOM, no churn
    victims.push(e);
  }
  if (victims.length < need) return false;
  for (const v of victims) {
    releaseRenderer(v.session);
    _stats.evictions++;
  }
  return true;
}

function _track(entry, disposable) {
  if (disposable) entry.disposables.push(disposable);
}

/**
 * Give this session a WebGL renderer if eligible. Idempotent — safe to call
 * on every visibility change (_syncRenderers loops every session). On any
 * failure the terminal simply stays on the DOM renderer. Returns true when the
 * session holds a context afterwards.
 *
 * lastFocus is set at entry creation and by noteFocus(), deliberately NOT
 * refreshed on every acquire, so sync passes don't inflate recency.
 */
export function acquireRenderer(session) {
  if (!_WebglAddon || !session?.term || session.dead) return false;
  if (session._isBrowser || session._gitOutput) return false;

  const existing = _entries.get(session.id);
  if (existing?.webgl) { existing.session = session; return true; }

  // Context-loss discipline: hard cap, then cooldown between attempts —
  // a flapping GPU must not loop dispose/create via _syncRenderers.
  if (existing && existing.lossCount > MAX_LOSS_RETRIES) return false;
  if (existing && existing.cooldownUntil && performance.now() < existing.cooldownUntil) return false;

  const entry = existing || {
    session, webgl: null, disposables: [], lastFocus: performance.now(),
    lossCount: 0, cooldownUntil: 0, retryTimer: null, lostWhileHidden: false,
  };
  _entries.set(session.id, entry);
  entry.session = session;

  if (!_makeRoom(entry)) return false;

  let webgl;
  try {
    webgl = new _WebglAddon();
    session.term.loadAddon(webgl);
  } catch {
    try { webgl?.dispose?.(); } catch {}
    return false; // stays on DOM renderer
  }
  entry.webgl = webgl;
  entry.lostWhileHidden = false;
  _stats.contextsCreated++;

  const term = session.term;

  // ── Atlas bookkeeping ──
  // The renderer acquires its atlas inside its constructor, before the addon
  // forwards atlas events, so seed the current root page from the getter.
  try { const root = webgl.textureAtlas; if (root) _atlasPages.add(root); } catch {}
  try { _track(entry, webgl.onChangeTextureAtlas?.((c) => { if (c) _atlasPages.add(c); _schedulePrune(); })); } catch {}
  try { _track(entry, webgl.onAddTextureAtlasCanvas?.((c) => { if (c) _atlasPages.add(c); _schedulePrune(); })); } catch {}
  try { _track(entry, webgl.onRemoveTextureAtlasCanvas?.((c) => { _atlasPages.delete(c); })); } catch {}
  // One assignment per parse batch — the prune waits for every holder to idle.
  try { _track(entry, term.onWriteParsed?.(() => { _lastWriteAt = performance.now(); })); } catch {}

  // Context loss → fall back to DOM renderer (xterm v6 reverts automatically
  // on addon dispose), then retry WebGL after a delay (bounded).
  try { webgl.onContextLoss(() => _handleLoss(entry)); } catch {}

  // Lock in cell metrics against the fresh renderer on the next frame.
  // WebGL floors the cell width to device pixels, the DOM renderer does not —
  // if the refit changes the grid, the PTY must hear about it or the TUI keeps
  // drawing at the stale size (same contract as _scheduleFit). Reads
  // entry.session so a pre-spawn acquire (adoptRenderer) resolves to the real
  // session by the time this runs.
  requestAnimationFrame(() => {
    const s = entry.session;
    if (!entry.webgl || !s?.term || s.dead) return;
    try {
      s.fitAddon?.fit();
      s.term.refresh(0, s.term.rows - 1);
      const l = s._lastSentResize;
      if (s.ws?.readyState === WebSocket.OPEN &&
          s.term.cols >= 2 && s.term.rows >= 2 &&
          (!l || l.cols !== s.term.cols || l.rows !== s.term.rows)) {
        s._lastSentResize = { cols: s.term.cols, rows: s.term.rows };
        s.ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows }));
      }
    } catch {}
  });
  return true;
}

/**
 * Re-key a renderer acquired before the session id was known (openSession
 * warms WebGL before measuring, so the PTY spawns at the WebGL cell grid).
 */
export function adoptRenderer(from, session) {
  if (!from || !session || from.id === session.id) return;
  const entry = _entries.get(from.id);
  if (!entry) return;
  _entries.delete(from.id);
  entry.session = session;
  _entries.set(session.id, entry);
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
  let anyHolder = false;
  for (const e of _entries.values()) if (e.webgl) { anyHolder = true; break; }
  if (!anyHolder) _atlasPages.clear();
}

/** Full teardown on session close — call BEFORE term.dispose(). */
export function disposeRenderer(session) {
  if (!session) return;
  releaseRenderer(session);
  _entries.delete(session.id);
}

function _handleLoss(entry) {
  const session = entry.session;
  const hiddenLoss = (typeof document !== 'undefined' && document.hidden) ||
    performance.now() - _lastVisibleAt < HIDDEN_LOSS_GRACE_MS;
  releaseRenderer(session);

  if (hiddenLoss) {
    // Background GPU reclaim, not a flapping GPU: no loss count, no cooldown.
    // No refit either — the grid keeps its size on the DOM renderer, and the
    // WebGL re-acquire restores the same metrics, so the CLI never redraws.
    // ui-terminal's visibilitychange handler re-acquires via _syncRenderers();
    // if we are already visible again, re-acquire on the next frame.
    _stats.hiddenLosses++;
    entry.lostWhileHidden = true;
    entry.cooldownUntil = 0;
    if (typeof document === 'undefined' || !document.hidden) {
      requestAnimationFrame(() => {
        const s = entry.session;
        if (s && !s.dead && s.viewport?.isConnected && _visible(s)) acquireRenderer(s);
      });
    }
    return;
  }

  entry.lossCount++;
  _stats.losses++;
  // Cooldown blocks _syncRenderers from instantly re-acquiring a flapping
  // context; the timer below is the only sanctioned retry path.
  entry.cooldownUntil = performance.now() + RETRY_DELAY_MS;

  requestAnimationFrame(() => {
    const s = entry.session;
    try { s.fitAddon?.fit(); s.term?.refresh(0, s.term.rows - 1); } catch {}
    // Force a PTY resize (bypass _lastSentResize dedup) so Ink redraws into
    // the fresh cell grid instead of the stale WebGL one. Use session.ws —
    // NOT a closure ws — so this survives WS reconnects.
    try {
      s._lastSentResize = null;
      if (s.ws?.readyState === WebSocket.OPEN && s.term) {
        s._lastSentResize = { cols: s.term.cols, rows: s.term.rows };
        s.ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows }));
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
      const s = entry.session;
      if (!s.dead && s.viewport?.isConnected && _visible(s)) {
        acquireRenderer(s);
      }
    }, RETRY_DELAY_MS);
  }
}

// ── Shared glyph-atlas prune ──
// Timers, not requestIdleCallback (Safari has none). The prune fires only when
// the atlas grew by ATLAS_PRUNE_PAGES pages since the last one, the page is
// visible, and no holder parsed output for ATLAS_IDLE_MS; clearTextureAtlas()
// runs on ALL holders in one task (the texture is shared, and every holder's
// glyph model must drop its references to the cleared pages together). It
// requests its own redraw, so no extra refresh. Cleared pages stay allocated,
// so growth is counted from the prune — a refilled atlas has to add pages
// again before the next prune.

function _schedulePrune() {
  if (_pruneTimer || _atlasPages.size < ATLAS_PRUNE_PAGES) return;
  const wait = Math.max(50, _lastWriteAt + ATLAS_IDLE_MS - performance.now());
  _pruneTimer = setTimeout(_maybePrune, wait);
}

function _maybePrune() {
  _pruneTimer = null;
  if (_atlasPages.size < ATLAS_PRUNE_PAGES) return;
  if (typeof document !== 'undefined' && document.hidden) return; // re-armed when visible
  const idle = performance.now() - _lastWriteAt;
  if (idle < ATLAS_IDLE_MS) {
    _pruneTimer = setTimeout(_maybePrune, Math.max(50, ATLAS_IDLE_MS - idle));
    return;
  }
  const holders = [];
  for (const e of _entries.values()) if (e.webgl) holders.push(e);
  _atlasPages.clear();
  if (!holders.length) return;
  for (const e of holders) {
    try { e.webgl.clearTextureAtlas(); } catch {}
  }
  _stats.prunes++;
}
