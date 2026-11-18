// ═══════════════════════════════════════════
// SynaBun Assistant — dismissed usage-limit countdowns
// ═══════════════════════════════════════════
// The × on a limit-wait card (asst-limit-wait.js, shown by the conversation's
// one dock, asst-limit-dock.js) hides that card for the limit episode it
// counts down: the session, the dock entry (`brain` or `run:<id>`) and the
// reset time. The same episode reported again (a reattach, a replayed error,
// a run card that refreshes, a reload) stays hidden; a new one shows: a later
// reset time, another run, another session. A dismissal ends with its episode
// (the reset time passing) and is pruned then.
//
// No DOM and no imports but asst-limit.js: the store is injected
// ({ getItem, setItem, removeItem }: storage.js in the panel, a Map in tests),
// so it runs under node.

import { resetMs } from './asst-limit.js';

export const LIMIT_DISMISSALS_KEY = 'synabun-assistant-limit-dismissed';
/**
 * A reset reported up to this much later is the same episode: a structured report refining the words' time, or
 * the same limit hit again a few minutes on, whose "try again in 2 hours" is read from a later moment. Two real
 * limit windows are hours apart (a 5-hour window, a weekly one), so a later one is never mistaken for this one.
 */
export const SAME_EPISODE_SLACK_MS = 15 * 60_000;
/** A card whose reset time is unknown stays dismissed this long, then shows again if the limit still holds. */
export const UNKNOWN_RESET_HOLD_MS = 5 * 3_600_000;
const MAX_RECORDS = 200;

/** A record's reset: stored already in epoch ms by dismiss() (never normalized twice). */
function recordReset(record) {
  const n = record?.resetsAt == null ? NaN : Number(record.resetsAt);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function idOf(scope, key) {
  return `${String(scope || '')}|${String(key || '')}`;
}

/** When a dismissal stops mattering: its reset time, or (reset unknown) the hold after it was made. */
export function dismissalExpiresAt(record) {
  if (!record || typeof record !== 'object') return 0;
  const reset = recordReset(record);
  if (reset !== null) return reset;
  const at = Number(record.at);
  return Number.isFinite(at) ? at + UNKNOWN_RESET_HOLD_MS : 0;
}

/**
 * Whether a dismissal still hides a card that counts to `resetsAt` (null: unknown). Pure.
 * Hidden: the dismissal's episode has not ended, and the card's reset is not later than the dismissed one
 * (beyond the slack): a later reset is a new limit. A card with no known reset is hidden by any live
 * dismissal of the same entry (it adds nothing the dismissed card did not say).
 */
export function dismissalHides(record, resetsAt, now = Date.now()) {
  if (!record) return false;
  if (dismissalExpiresAt(record) <= now) return false;
  const dismissed = recordReset(record);
  const shown = resetMs(resetsAt);
  if (shown === null) return true;
  if (dismissed === null) return true;
  return shown <= dismissed + SAME_EPISODE_SLACK_MS;
}

/** The records still in force, newest kept when there are too many. Pure. */
export function pruneDismissals(records, now = Date.now()) {
  const live = Object.entries(records && typeof records === 'object' ? records : {})
    .filter(([, record]) => dismissalExpiresAt(record) > now)
    .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
    .slice(0, MAX_RECORDS);
  return Object.fromEntries(live);
}

/**
 * createLimitDismissals({ storage, key, now }) → { hides(scope, key, resetsAt), dismiss(scope, key, resetsAt), forget(scope, key) }
 * `storage`: { getItem, setItem, removeItem } (strings). Without one, dismissals live in memory only.
 */
export function createLimitDismissals({ storage = null, key = LIMIT_DISMISSALS_KEY, now = () => Date.now() } = {}) {
  let memory = {};
  function read() {
    if (!storage) return memory;
    try {
      const parsed = JSON.parse(storage.getItem(key) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  function write(records) {
    if (!storage) { memory = records; return; }
    try {
      if (Object.keys(records).length) storage.setItem(key, JSON.stringify(records));
      else storage.removeItem(key);
    } catch { /* a refused write keeps the card hidden for this page only */ memory = records; }
  }
  return {
    hides(scope, entryKey, resetsAt) {
      return dismissalHides(read()[idOf(scope, entryKey)], resetsAt, now());
    },
    dismiss(scope, entryKey, resetsAt) {
      const at = now();
      const records = pruneDismissals(read(), at);
      records[idOf(scope, entryKey)] = { resetsAt: resetMs(resetsAt), at };
      write(pruneDismissals(records, at));
    },
    forget(scope, entryKey) {
      const records = read();
      const id = idOf(scope, entryKey);
      if (!(id in records)) return;
      delete records[id];
      write(pruneDismissals(records, now()));
    },
  };
}
