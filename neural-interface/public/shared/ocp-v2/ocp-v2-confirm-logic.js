// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — confirming what publishes or destroys (no DOM)
// The panel never asks with a native dialog (window.confirm): a browser driven
// by an automation accepts those by itself, so one click would publish a
// transcript or delete a session. A confirmation is two steps, both in the
// panel:
//   1. ask()      arms it: the panel shows what will happen, the button that
//                 does it and Cancel (ocp-v2-confirm.js draws that row)
//   2. confirm()  the click on that button, the only thing that resolves true
// Armed is not agreed. It ends as "no" when it is cancelled, when it times out,
// when another question takes its place, and when the panel is bound to
// another session while it waits (ocp-v2-binding.js): the question on screen
// was about the session the panel has left.
// ─────────────────────────────────────────────────────────────────────────────

import { captureBinding, onRebind } from './ocp-v2-binding.js';

export const CONFIRM_TIMEOUT_MS = 15_000;
// A second click this soon after the first is the same gesture (a double
// click, a click that bounced): it confirms nothing, and the question stays.
export const CONFIRM_MIN_DELAY_MS = 350;

/**
 * One question at a time for one panel.
 *   ask({ key, text, confirmLabel, cancelLabel, surface })
 *                    → Promise<boolean>; true only after confirm(key).
 *                      `key` names the action ("share:ses_1"), `text` says what
 *                      will happen, `surface` is where the row is drawn. A
 *                      question without a key or a text is not asked: false.
 *   confirm(key)     step two → true when that question was armed, in time and
 *                      on the binding it was asked on
 *   cancel(match)    `match`: nothing (whatever is armed), a key, or
 *                      `(view) => boolean`
 *   armed()          the question on screen (`{ key, text, confirmLabel,
 *                      cancelLabel, surface }`), or null
 *   onChange(fn)     `fn(view | null, reason)` whenever the question changes;
 *                      reason: armed / confirmed / cancelled / timeout /
 *                      replaced / moved
 * `store` is the panel store the questions belong to; without one nothing is
 * tied to a session.
 */
export function createConfirmations({
  store = null, timeoutMs = CONFIRM_TIMEOUT_MS, minDelayMs = CONFIRM_MIN_DELAY_MS,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let armed = null;                 // { view, at, armedAt, timer, settle }
  const listeners = new Set();

  const notify = (reason) => {
    const view = armed ? armed.view : null;
    for (const fn of [...listeners]) {
      try { fn(view, reason); } catch (err) { console.warn('[ocp-v2-confirm] listener failed', err); }
    }
  };
  function end(agreed, reason) {
    const was = armed;
    if (!was) return false;
    armed = null;
    clearTimer(was.timer);
    was.settle(agreed === true);
    notify(reason);
    return true;
  }
  const matches = (match) => {
    if (!armed) return false;
    if (match === undefined) return true;
    if (typeof match === 'function') { try { return match(armed.view) === true; } catch { return false; } }
    return armed.view.key === String(match);
  };

  function ask({ key, text, confirmLabel, cancelLabel, surface } = {}) {
    const view = Object.freeze({
      key: String(key || ''),
      text: String(text || ''),
      confirmLabel: String(confirmLabel || 'Confirm'),
      cancelLabel: String(cancelLabel || 'Cancel'),
      surface: String(surface || ''),
    });
    // A question that does not say what will happen is not asked, and nothing
    // is agreed to.
    if (!view.key || !view.text.trim()) return Promise.resolve(false);
    end(false, 'replaced');
    // The session the question is about: the one on screen when it is asked.
    const at = store ? captureBinding(store) : null;
    return new Promise((resolve) => {
      const entry = { view, at, armedAt: now(), settle: resolve, timer: null };
      entry.timer = setTimer(() => { if (armed === entry) end(false, 'timeout'); }, timeoutMs);
      entry.timer?.unref?.();
      armed = entry;
      notify('armed');
    });
  }

  // Step two. (Not called `confirm`: nothing here is the browser's dialog.)
  function agree(key) {
    if (key === undefined || !matches(String(key))) return false;
    if (armed.at && !armed.at.isCurrent()) { end(false, 'moved'); return false; }
    const waited = now() - armed.armedAt;
    if (waited >= timeoutMs) { end(false, 'timeout'); return false; }
    if (waited < minDelayMs) return false;
    return end(true, 'confirmed');
  }

  const unsubscribe = store
    ? onRebind(store, () => { if (armed?.at && !armed.at.isCurrent()) end(false, 'moved'); })
    : null;

  return {
    ask,
    confirm: agree,
    cancel: (match, reason = 'cancelled') => (matches(match) ? end(false, reason) : false),
    armed: () => (armed ? armed.view : null),
    isArmed: (key) => !!armed && armed.view.key === String(key || ''),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() { end(false, 'cancelled'); try { unsubscribe?.(); } catch { /* already gone */ } listeners.clear(); },
  };
}
