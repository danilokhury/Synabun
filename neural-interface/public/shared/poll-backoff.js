// ═══════════════════════════════════════════
// SynaBun Neural Interface — one gate for a poller that several places share
// ═══════════════════════════════════════════
//
// A status poller (the Computer tray's GET /api/desktop/status, asst-computer.js) can run in every Assistant tab at
// once, each on its own timer. Through one gate they make at most one request at a time and one per interval, and a
// failure is not asked again at the same pace:
//   • an answer: the next is due one interval later (less a little slack, so the timers that share it do not drift
//     past each other);
//   • a failure: the next is due after an exponential wait, capped (base · factor^failures, at most `maxMs`);
//   • a refusal (the page has no owner access: owner-access.js): no more polling at all until `resume()`, which the
//     page calls when something changed (it got the owner's page secret again, or it became visible again).
// A request the user asks for (Check again) does not ask the gate; its answer still counts.
//
// No DOM: `node --test` loads this file with a test clock (tests/poll-backoff.test.mjs).

export const POLL_BACKOFF_DEFAULTS = Object.freeze({ baseMs: 3000, maxMs: 5 * 60_000, factor: 2, slackMs: 250 });

/** The wait after `failures` failures in a row: the interval itself for none, then exponential, capped. */
export function backoffDelay(failures, { baseMs = POLL_BACKOFF_DEFAULTS.baseMs, maxMs = POLL_BACKOFF_DEFAULTS.maxMs, factor = POLL_BACKOFF_DEFAULTS.factor } = {}) {
  const n = Math.max(0, Math.floor(Number(failures) || 0));
  const base = Math.max(0, Number(baseMs) || 0);
  const cap = Math.max(base, Number(maxMs) || 0);
  if (n === 0) return base;
  return Math.min(cap, base * Math.pow(Math.max(1, Number(factor) || 1), n));
}

export function createPollGate({ baseMs = POLL_BACKOFF_DEFAULTS.baseMs, maxMs = POLL_BACKOFF_DEFAULTS.maxMs, factor = POLL_BACKOFF_DEFAULTS.factor, slackMs = POLL_BACKOFF_DEFAULTS.slackMs, now = () => Date.now() } = {}) {
  const opts = { baseMs, maxMs, factor };
  let failures = 0;
  let nextAt = 0;
  let halted = null; // { code, reason } while a refusal stops the polling
  let inFlight = false;
  return {
    /** Whether a timer's tick may send the request now. */
    due() { return !halted && !inFlight && now() >= nextAt; },
    /** A request leaves (timer or user). */
    begin() { inFlight = true; },
    /** It answered. */
    succeed() {
      inFlight = false;
      failures = 0;
      halted = null;
      nextAt = now() + Math.max(0, baseMs - Math.max(0, slackMs));
    },
    /** It failed; `refusal` (owner-access.js) stops the polling until resume(). Returns the wait before the next. */
    fail(refusal = null) {
      inFlight = false;
      failures += 1;
      if (refusal) { halted = { code: refusal.code || null, reason: refusal.reason || null }; return Infinity; }
      const wait = backoffDelay(failures, opts);
      nextAt = now() + wait;
      return wait;
    },
    /** Something changed (owner access back, the page visible again): due at once, from a clean slate. */
    resume() { halted = null; failures = 0; nextAt = 0; },
    snapshot() { return { failures, nextAt, halted, inFlight, waitMs: halted ? Infinity : Math.max(0, nextAt - now()) }; },
  };
}
