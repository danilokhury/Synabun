// ── A browser start its caller stopped waiting for is kept for that caller (DOM-free) ──
//
// A cold MoreLogin start waits up to two minutes for the app (server.js createBrowserSession), and nothing can cancel
// it once it runs. Before 2026-11-04 the MCP gave up on browser_session create after 70 s while the server went on and
// registered the session: the agent read "timed out", called create again and started a second browser, and the first
// stayed open, owned by an agent that never learned its id.
//
// Now one start runs per caller (`key`) at a time:
// - a caller that asks again while its start is still running waits for that same start (`joined`), never a second one;
// - a caller waits `waitMs` at most and is then answered `pending` (the routes answer 202 BROWSER_STARTING before their
//   deadline, so the agent reads "still starting, call create again" rather than a timeout);
// - a start that finishes when none of its callers can be answered any more is parked for the key, and the caller's
//   next request takes it (`parked`) instead of starting another;
// - a start that finishes while one of its callers still waits but another was already answered `pending` is parked
//   too, as `delivered`: the caller that was told "call again" gets that same start on its retry, never a second one.
//   A delivered start is in use, so nobody closes it when it is not taken;
// - a parked start nobody takes within `ttlMs` is handed to `onUnclaimed` (the route closes what it opened), with the
//   time it was parked (`{ parkedAt }`), so the route can see whether its caller used it meanwhile;
// - a start that never settles is given up after `startDeadlineMs` (BROWSER_START_STUCK): its waiters are answered,
//   the key is free again, and what the start makes if it ever finishes goes to `onUnclaimed`;
// - after `clear()` (shutdown) nothing is parked any more: every parked start and every one that finishes later goes
//   to `onUnclaimed` at once.
// A start that fails is never parked: the next request starts again and gets the real error.

export const BROWSER_START_HANDOFF_TTL_MS = 10 * 60_000;
/** A cold MoreLogin start (two minutes for the app) plus a tab, with room to spare: past this a start is stuck. */
export const BROWSER_START_DEADLINE_MS = 6 * 60_000;
export const BROWSER_START_STUCK = 'BROWSER_START_STUCK';

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {number} [opts.ttlMs]            how long a parked start waits for its caller
 * @param {number} [opts.startDeadlineMs]  how long a start may run before it is given up
 * @param {Function} [opts.setTimer]  setTimeout stand-in (tests)
 * @param {Function} [opts.clearTimer]
 * @param {(message: string) => void} [opts.log]
 */
export function createBrowserStartHandoff({
  now = Date.now, ttlMs = BROWSER_START_HANDOFF_TTL_MS, startDeadlineMs = BROWSER_START_DEADLINE_MS,
  setTimer = setTimeout, clearTimer = clearTimeout, log = () => {},
} = {}) {
  const flights = new Map(); // key → { promise, waiters: Set<{ gone, left }>, timer, abandoned }
  const parked = new Map(); // key → { value, at, timer, onUnclaimed, delivered }
  let closed = false;

  function unpark(key) {
    const entry = parked.get(key);
    if (!entry) return null;
    parked.delete(key);
    clearTimer(entry.timer);
    return entry;
  }

  function park(key, value, onUnclaimed, { delivered = false } = {}) {
    const previous = unpark(key);
    if (previous) expire(key, previous);
    const entry = { value, at: now(), onUnclaimed: delivered ? null : onUnclaimed, delivered, timer: null };
    if (closed) { expire(key, entry); return; }
    entry.timer = setTimer(() => {
      if (parked.get(key) !== entry) return;
      parked.delete(key);
      expire(key, entry);
    }, ttlMs);
    entry.timer?.unref?.();
    parked.set(key, entry);
    log(delivered
      ? `kept a browser start for ${key}: one of its callers had been told it was still starting`
      : `parked a browser start for ${key}: its caller had stopped waiting`);
  }

  /** Hand a parked (or never-parked) value to its onUnclaimed. Resolves when that is done; never rejects. */
  function expire(key, entry) {
    if (typeof entry.onUnclaimed !== 'function') return Promise.resolve();
    log(`a browser start for ${key} was not taken${closed ? ' (shutting down)' : ` within ${Math.round(ttlMs / 1000)} s`}`);
    return Promise.resolve().then(() => entry.onUnclaimed(entry.value, { parkedAt: entry.at })).catch(() => {});
  }

  /**
   * Run `start` for `key`, or hand over the one already running or parked.
   * @param {string} key
   * @param {() => Promise<any>} start   resolves with the started value; rejects with the reason it failed
   * @param {object} [opts]
   * @param {() => boolean} [opts.gone]   true once this caller can no longer be answered (its request ended)
   * @param {number} [opts.waitMs]        how long this caller waits before it is answered `pending`
   * @param {(value) => boolean} [opts.alive]  whether a parked value is still usable (a closed tab is not)
   * @param {(value, info: { parkedAt: number }) => any} [opts.onUnclaimed] what to do with a value nobody took
   * @returns {Promise<{ value: any, from: 'parked' | 'joined' | 'started' } | { pending: true, from: 'joined' | 'started' }>}
   */
  async function run(key, start, { gone = () => false, waitMs = Infinity, alive = null, onUnclaimed = null } = {}) {
    const kept = unpark(key);
    if (kept) {
      if (!alive || safeAlive(alive, kept.value)) return { value: kept.value, from: 'parked' };
      log(`a parked browser start for ${key} is gone: starting again`);
      // What is left of it (a session whose tab closed) is closed like one nobody took.
      expire(key, kept);
    }
    let flight = flights.get(key);
    const from = flight ? 'joined' : 'started';
    if (!flight) {
      const current = { waiters: new Set(), promise: null, timer: null, abandoned: false };
      const started = Promise.resolve().then(start);
      // A start that never settles would hold the key for good (every later request only joins it).
      const watchdog = new Promise((_, reject) => {
        current.timer = setTimer(() => reject(Object.assign(
          new Error(`The browser start did not finish within ${Math.round(startDeadlineMs / 60_000)} minutes and was given up. Call the browser tool again to start over.`),
          { code: BROWSER_START_STUCK, status: 504 },
        )), startDeadlineMs);
        current.timer?.unref?.();
      });
      current.promise = Promise.race([started, watchdog]).then((value) => {
        clearTimer(current.timer);
        if (flights.get(key) === current) flights.delete(key);
        // Answered by a caller that is still there: it has the value. Otherwise nobody does, so keep it for the key.
        // When one caller has it and another was answered "still starting", keep it too (delivered): that caller's
        // retry gets this start, not a second one.
        const waiters = [...current.waiters];
        const answered = waiters.some((w) => !w.left && !safeGone(w.gone));
        const toldPending = waiters.some((w) => w.left);
        if (!answered) park(key, value, onUnclaimed);
        else if (toldPending) park(key, value, onUnclaimed, { delivered: true });
        return value;
      }, (error) => {
        clearTimer(current.timer);
        if (flights.get(key) === current) flights.delete(key);
        if (error?.code === BROWSER_START_STUCK) {
          current.abandoned = true;
          log(`a browser start for ${key} was given up after ${Math.round(startDeadlineMs / 1000)} s`);
        }
        throw error;
      });
      // What a start given up on makes after all is nobody's: handed to onUnclaimed at once.
      started.then((value) => {
        if (current.abandoned) expire(key, { value, at: now(), onUnclaimed });
      }, () => {});
      // Every caller may have left before a failure: never an unhandled rejection.
      current.promise.catch(() => {});
      flights.set(key, current);
      flight = current;
    }
    const waiter = { gone, left: false };
    flight.waiters.add(waiter);
    let timer = null;
    try {
      if (!(waitMs < Infinity)) return { value: await flight.promise, from };
      const waited = await Promise.race([
        flight.promise.then((value) => ({ value })),
        new Promise((resolve) => { timer = setTimer(() => resolve(null), Math.max(0, waitMs)); }),
      ]);
      if (waited) return { value: waited.value, from };
      // This caller is answered "still starting": it no longer counts as one the start can be answered to.
      waiter.left = true;
      return { pending: true, from };
    } finally {
      if (timer) clearTimer(timer);
      // Once answered (or failed) this caller is done either way; a pending one stays marked as left.
      if (!waiter.left) flight.waiters.delete(waiter);
    }
  }

  return {
    run,
    /** Whether a start for `key` is running now. */
    running: (key) => flights.has(key),
    /** Whether a finished start is parked for `key`. */
    hasParked: (key) => parked.has(key),
    /** Whether the start parked for `key` is one a caller already has (delivered), not one nobody took. */
    parkedDelivered: (key) => parked.get(key)?.delivered === true,
    /**
     * Shutdown: every parked start goes to its onUnclaimed now, and so does every start still running when it
     * finishes. Resolves once the parked ones are handled (the caller bounds the wait).
     */
    clear() {
      closed = true;
      const done = [];
      for (const key of [...parked.keys()]) {
        const entry = unpark(key);
        if (entry) done.push(expire(key, entry));
      }
      return Promise.allSettled(done).then(() => undefined);
    },
  };
}

function safeGone(gone) {
  try { return gone() === true; } catch { return true; }
}

function safeAlive(alive, value) {
  try { return alive(value) === true; } catch { return false; }
}

/**
 * How long a route waits for a browser start before it answers BROWSER_STARTING: what is left of its request's
 * deadline, less a margin so that answer, not the deadline's 408 (lib/browser-execution.js), is what the caller reads.
 * `deadline` absent (a route without one): Infinity, the route waits for the start.
 */
export function startWaitMs(deadline, { now = Date.now(), margin = 2_000 } = {}) {
  const at = Number(deadline);
  if (!Number.isFinite(at) || at <= 0) return Infinity;
  return Math.max(0, at - now - margin);
}
