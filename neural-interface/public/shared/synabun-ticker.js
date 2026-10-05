// ═══════════════════════════════════════════
// SynaBun ticker — one frame loop for everything that animates
// ═══════════════════════════════════════════
// Animated pieces of the UI (the mascot rigs, live clocks) draw from ONE
// requestAnimationFrame loop instead of a loop each. A subscriber names its
// frame rate (1, 30 or 60 fps) and is called at most that often. The loop only
// exists while somebody listens: with no subscribers there is no rAF at all,
// and when every subscriber is slow the loop sleeps on a timer between frames.
// requestFrames(ms) lifts the animation subscribers (≥ 24 fps) to 60 fps for a
// moment: a pose blend, a hop.
//
// The loop stops while the tab is hidden (document.hidden, body.app-hidden)
// and freezes while the UI is dragged (body.ui-interacting): subscribers are
// skipped, and the first frame after either hands each one a dt of at most
// 50 ms, so nothing jumps. The body classes are watched by one
// MutationObserver, attached only while the loop has subscribers.
//
// It also owns the page-wide inputs animations share, each attached only while
// somebody listens: one live prefers-reduced-motion query, one passive window
// pointermove listener and one keydown listener (both capture phase, so a
// handler that stops propagation cannot hide input from them).
//
//   subscribe(fn(now, dt), { fps })  → unsubscribe()   (unsubscribe.setFps(n) re-caps)
//   requestFrames(ms)                   60 fps for the next ms
//   isReducedMotion()                   live prefers-reduced-motion
//   onReducedMotionChange(fn(on))    → unsubscribe()
//   onPointer(fn(x, y))              → unsubscribe()   clientX / clientY
//   onKey(fn(event))                 → unsubscribe()
//   pointerPosition()                   last pointer seen { x, y, at } or null
//   lastInputAt()                       when the last pointer move or key was seen
//   tickerPaused()                      '' | 'hidden' | 'interacting'
//   now()                               the ticker's clock (performance.now)
//
// `now` handed to subscribers is the frame's timestamp; `dt` is the time since
// that subscriber's previous call (its subscription for the first one), never
// negative and never more than two of its frames (50 ms after a stop).
//
// Safe to import anywhere, Node included: nothing touches the DOM until the
// first call. __ticker.setEnv() swaps the platform for a fake one (tests).

const FRAME_60 = 1000 / 60;
const SLOP = 4; // ms of rAF jitter a capped subscriber tolerates before it skips a frame
const RESUME_DT = 50; // the first dt after a stop or a freeze is at most this
const SLEEP_OVER = 48; // a wait longer than this sleeps on a timer instead of frames
const POLL_MS = 250; // how often a stopped loop re-checks when no MutationObserver exists
const MAX_BOOST = 5000;
const LISTEN = { passive: true, capture: true };

// The platform. null = the real globals; __ticker.setEnv() injects a fake.
let env = null;

const win = () => (env ? env.window : (typeof window === 'undefined' ? undefined : window));
const doc = () => (env ? env.document : (typeof document === 'undefined' ? undefined : document));

/** The ticker's clock: performance.now() (or the injected clock). */
export function now() {
  if (env?.now) return env.now();
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

function rafFn() {
  if (env) return env.raf || null;
  const w = win();
  return w && typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame.bind(w) : null;
}
function cafFn() {
  if (env) return env.caf || null;
  const w = win();
  return w && typeof w.cancelAnimationFrame === 'function' ? w.cancelAnimationFrame.bind(w) : null;
}
const later = (fn, ms) => (env?.setTimeout || globalThis.setTimeout)(fn, ms);
const unlater = id => (env?.clearTimeout || globalThis.clearTimeout)(id);

function report(err) {
  try { console.error('[synabun-ticker]', err); } catch { /* no console */ }
}

// ── The loop ──

const subs = new Set();
let rafId = 0;
let timerId = 0;
let pollId = 0;
let boostUntil = -Infinity;
let watching = false;
let observer = null;

const capFps = fps => Math.max(1, Math.min(60, Number(fps) > 0 ? Number(fps) : 30));
const boosted = (sub, t) => t < boostUntil && sub.fps >= 24;
const intervalOf = (sub, t) => (boosted(sub, t) ? FRAME_60 : 1000 / sub.fps);

/** Why the loop is not running: '' (it runs), 'hidden' or 'interacting'. */
export function tickerPaused() {
  const d = doc();
  if (!d) return '';
  if (d.hidden) return 'hidden';
  const cl = d.body?.classList;
  if (cl?.contains('app-hidden')) return 'hidden';
  if (cl?.contains('ui-interacting')) return 'interacting';
  return '';
}

/**
 * Call `fn(now, dt)` from the shared loop, at most `fps` times a second
 * (1-60, default 30). Returns unsubscribe(); unsubscribe.setFps(n) changes the
 * cap in place.
 */
export function subscribe(fn, { fps = 30 } = {}) {
  if (typeof fn !== 'function') return Object.assign(() => {}, { setFps() {} });
  const sub = { fn, fps: capFps(fps), last: -1, born: now(), resume: false };
  subs.add(sub);
  watch();
  wakeNow();
  const unsubscribe = () => {
    if (!subs.delete(sub)) return;
    if (!subs.size) halt();
  };
  unsubscribe.setFps = (next) => {
    const fpsNext = capFps(next);
    if (fpsNext === sub.fps) return;
    sub.fps = fpsNext;
    if (subs.has(sub)) wakeNow();
  };
  return unsubscribe;
}

/** Run every animation subscriber at 60 fps for the next `ms` (a blend, a hop). */
export function requestFrames(ms = 200) {
  const span = Math.max(0, Math.min(MAX_BOOST, Number(ms) || 0));
  const until = now() + span;
  if (until > boostUntil) boostUntil = until;
  if (subs.size) wakeNow();
}

/** Something became due sooner than the sleeping timer thinks: re-plan. */
function wakeNow() {
  if (timerId) { unlater(timerId); timerId = 0; }
  schedule();
}

function schedule() {
  if (rafId || timerId || !subs.size) return;
  const raf = rafFn();
  if (!raf) return;
  if (tickerPaused()) { stopped(); return; }
  const t = now();
  let wait = Infinity;
  for (const sub of subs) {
    const due = sub.last < 0 ? 0 : sub.last + intervalOf(sub, t) - SLOP - t;
    if (due < wait) wait = due;
  }
  if (wait > SLEEP_OVER) {
    timerId = later(() => { timerId = 0; schedule(); }, wait - FRAME_60);
    return;
  }
  rafId = raf(frame);
}

function frame(ts) {
  rafId = 0;
  if (!subs.size) return;
  if (tickerPaused()) { stopped(); return; }
  const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : now();
  for (const sub of Array.from(subs)) {
    if (!subs.has(sub)) continue; // unsubscribed by an earlier subscriber this frame
    const interval = intervalOf(sub, t);
    if (sub.last >= 0 && t - sub.last < interval - SLOP) continue;
    let dt = t - (sub.last >= 0 ? sub.last : sub.born);
    if (!(dt > 0)) dt = 0;
    if (sub.resume) { dt = Math.min(dt, RESUME_DT); sub.resume = false; }
    dt = Math.min(dt, Math.max(RESUME_DT, 2 * interval)); // a long task is not a leap
    sub.last = t;
    try { sub.fn(t, dt); } catch (err) { report(err); }
  }
  schedule();
}

/** The loop stopped (hidden) or froze (drag): mark the jump, wait for the watchers. */
function stopped() {
  for (const sub of subs) sub.resume = true;
  if (!observer && !pollId) pollId = later(() => { pollId = 0; schedule(); }, POLL_MS);
}

function onWake() {
  if (!tickerPaused()) schedule();
}

function watch() {
  if (watching) return;
  const d = doc();
  if (!d) return;
  watching = true;
  d.addEventListener?.('visibilitychange', onWake);
  const MO = env ? env.MutationObserver : globalThis.MutationObserver;
  if (typeof MO === 'function' && d.body) {
    try {
      observer = new MO(onWake);
      observer.observe(d.body, { attributes: true, attributeFilter: ['class'] });
    } catch { observer = null; }
  }
}

function unwatch() {
  if (!watching) return;
  watching = false;
  doc()?.removeEventListener?.('visibilitychange', onWake);
  observer?.disconnect();
  observer = null;
}

function halt() {
  if (rafId) cafFn()?.(rafId);
  rafId = 0;
  if (timerId) unlater(timerId);
  timerId = 0;
  if (pollId) unlater(pollId);
  pollId = 0;
  unwatch();
}

// ── prefers-reduced-motion: one query, one listener ──

let motionQuery; // undefined = not looked up yet, null = unavailable
const motionFns = new Set();

function query() {
  if (motionQuery === undefined) {
    try {
      const w = win();
      const mm = env ? env.matchMedia : w?.matchMedia;
      motionQuery = typeof mm === 'function' ? mm.call(w, '(prefers-reduced-motion: reduce)') : null;
    } catch { motionQuery = null; }
  }
  return motionQuery;
}

/** True while the user asks for reduced motion (read live). */
export function isReducedMotion() {
  return !!query()?.matches;
}

function onMotionQuery() {
  const on = isReducedMotion();
  for (const fn of Array.from(motionFns)) {
    if (!motionFns.has(fn)) continue;
    try { fn(on); } catch (err) { report(err); }
  }
}

/** Call `fn(reduced)` when prefers-reduced-motion flips. Returns unsubscribe(). */
export function onReducedMotionChange(fn) {
  if (typeof fn !== 'function') return () => {};
  const q = query();
  const entry = on => fn(on);
  motionFns.add(entry);
  if (motionFns.size === 1 && q) {
    if (q.addEventListener) q.addEventListener('change', onMotionQuery);
    else q.addListener?.(onMotionQuery);
  }
  return () => {
    if (!motionFns.delete(entry) || motionFns.size || !q) return;
    if (q.removeEventListener) q.removeEventListener('change', onMotionQuery);
    else q.removeListener?.(onMotionQuery);
  };
}

// ── Page inputs: one pointermove and one keydown listener ──

const pointerFns = new Set();
const keyFns = new Set();
let pointerOn = false;
let keyOn = false;
let lastPointer = null;
let inputAt = -Infinity;

function onPointerMove(e) {
  const x = e.clientX;
  const y = e.clientY;
  const at = now();
  lastPointer = { x, y, at };
  inputAt = at;
  for (const entry of Array.from(pointerFns)) {
    if (!pointerFns.has(entry)) continue;
    try { entry.fn(x, y); } catch (err) { report(err); }
  }
}

function onKeyDown(e) {
  inputAt = now();
  for (const entry of Array.from(keyFns)) {
    if (!keyFns.has(entry)) continue;
    try { entry.fn(e); } catch (err) { report(err); }
  }
}

function listen(set, fn, type, handler, isOn, setOn) {
  if (typeof fn !== 'function') return () => {};
  const entry = { fn };
  set.add(entry);
  if (!isOn()) {
    const w = win();
    if (w?.addEventListener) { w.addEventListener(type, handler, LISTEN); setOn(true); }
  }
  return () => {
    if (!set.delete(entry) || set.size || !isOn()) return;
    win()?.removeEventListener?.(type, handler, LISTEN);
    setOn(false);
  };
}

/** Call `fn(clientX, clientY)` on every pointer move. Returns unsubscribe(). */
export function onPointer(fn) {
  return listen(pointerFns, fn, 'pointermove', onPointerMove, () => pointerOn, (v) => { pointerOn = v; });
}

/** Call `fn(event)` on every keydown anywhere on the page. Returns unsubscribe(). */
export function onKey(fn) {
  return listen(keyFns, fn, 'keydown', onKeyDown, () => keyOn, (v) => { keyOn = v; });
}

/** The last pointer position seen while somebody listened: { x, y, at } or null. */
export function pointerPosition() {
  return lastPointer ? { ...lastPointer } : null;
}

/** When the last pointer move or key press was seen (-Infinity when never). */
export function lastInputAt() {
  return inputAt;
}

// ── Test hook ──

function reset() {
  halt();
  subs.clear();
  boostUntil = -Infinity;
  const q = motionQuery;
  if (q && motionFns.size) {
    if (q.removeEventListener) q.removeEventListener('change', onMotionQuery);
    else q.removeListener?.(onMotionQuery);
  }
  motionFns.clear();
  motionQuery = undefined;
  if (pointerOn) win()?.removeEventListener?.('pointermove', onPointerMove, LISTEN);
  if (keyOn) win()?.removeEventListener?.('keydown', onKeyDown, LISTEN);
  pointerFns.clear();
  keyFns.clear();
  pointerOn = false;
  keyOn = false;
  lastPointer = null;
  inputAt = -Infinity;
}

/**
 * Internal: tests swap the platform for a fake one.
 * setEnv({ raf, caf, now, window, document, setTimeout, clearTimeout,
 * MutationObserver, matchMedia }) resets every subscription first; setEnv(null)
 * restores the real globals.
 */
export const __ticker = {
  setEnv(next) { reset(); env = next || null; },
  reset,
  state: () => ({
    subscribers: subs.size,
    raf: !!rafId,
    timer: !!timerId,
    watching,
    observing: !!observer,
    boosted: now() < boostUntil,
    pointerListeners: pointerFns.size,
    pointerAttached: pointerOn,
    keyListeners: keyFns.size,
    keyAttached: keyOn,
    motionListeners: motionFns.size,
  }),
};
