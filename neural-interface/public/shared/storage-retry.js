// SynaBun — when storage.js tries a refused flush again. DOM-free (unit-tested under node --test).
//
// A failure that may pass by itself (network, 5xx, 408, 429) waits base·2^(attempt-1), capped, with full jitter in
// the upper half. A 401 / 403 is the server saying this client is not allowed: nothing is retried on a timer until
// something changes (a new write, the window regaining focus, the network coming back). Unsent values stay queued.

export const RETRY_BASE_MS = 1000;
export const RETRY_CAP_MS = 60_000;

/** Whether an HTTP status (or null for a network error) is a refusal that a timer will not fix. */
export function isAuthRefusal(status) {
  return status === 401 || status === 403;
}

/** The wait before retry number `attempt` (1-based): between half and all of min(cap, base·2^(attempt-1)). */
export function retryDelay(attempt, { base = RETRY_BASE_MS, cap = RETRY_CAP_MS, random = Math.random } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const ceiling = Math.min(cap, base * 2 ** Math.min(n - 1, 30));
  const r = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(ceiling / 2 + r * (ceiling / 2));
}

/**
 * The retry state of one flusher. `fail(status)` → { blocked, delay } (delay null when blocked);
 * `ok()` resets; `poke()` (a write or a reconnect) lifts a block and gives the wait the next try still owes.
 */
export function createRetryState({ base = RETRY_BASE_MS, cap = RETRY_CAP_MS, random = Math.random, now = () => Date.now() } = {}) {
  let attempt = 0;
  let blocked = false;
  let notBefore = 0;
  return {
    get attempt() { return attempt; },
    get blocked() { return blocked; },
    fail(status) {
      attempt++;
      const delay = retryDelay(attempt, { base, cap, random });
      notBefore = now() + delay;
      blocked = isAuthRefusal(status);
      return { blocked, delay: blocked ? null : delay };
    },
    ok() { attempt = 0; blocked = false; notBefore = 0; },
    /** How long a flush asked for now must still wait (0 when none is owed). Lifts an auth block. */
    poke() { blocked = false; return Math.max(0, notBefore - now()); },
    /** How long a flush must still wait, without lifting a block (Infinity while blocked). */
    wait() { return blocked ? Infinity : Math.max(0, notBefore - now()); },
  };
}
