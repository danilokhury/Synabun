// ═══════════════════════════════════════════
// SynaBun Assistant — what a stop names
// ═══════════════════════════════════════════
// Pure module (no DOM, no i18n import) so node:test can exercise it.
//
// A stop ends the work the user named and nothing else:
//   resolveStopTarget   `/stop <target>`: the one run of this session the target names (its id, the
//                       start of its id, its title or the words of its title), or why it names none.
//                       Two candidates stop nothing: the user picks one.
//   createConfirmGate   the agents tray's "Stop all": the first press arms it, a second press inside
//                       the window stops every run of the session at once. A single stray click, a
//                       double click or a held key never does (2026-10-24: one "Stop all" press
//                       ended both runs of a session while the user meant one of them).
// Words the user types to stop everything ("stop", "cancel") go to the brain, which stops runs
// with agent_stop (assistant-persona.js): nothing here reads a message.

import { isTerminalRunStatus } from './asst-state.js';

/** How long an armed "Stop all" waits for its second press, and the least time between the two. */
export const STOP_ALL_CONFIRM_MS = 4000;
export const STOP_ALL_MIN_GAP_MS = 300;

// Words that say "a run" without saying which one: "/stop the OpenCode settings run" names it by the rest.
const FILLER = new Set(['the', 'a', 'an', 'that', 'this', 'my', 'our', 'one', 'run', 'runs', 'agent', 'agents', 'worker', 'workers', 'task', 'job', 'please', 'o', 'os', 'as', 'do', 'da', 'de']);
const FULL_RUN_ID = /^[0-9a-f]{32}$/i;
const ID_PREFIX = /^[0-9a-f][0-9a-f-]{3,}$/i;

function words(text) {
  return String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function unquote(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/^(["'“‘])([\s\S]*)(["'”’])$/);
  return m ? m[2].trim() : s;
}

/**
 * The run `/stop <target>` names among `runs` (the tray's runs of this session).
 * → { run, by: 'id' | 'prefix' | 'title' | 'words' }
 *   | { error: 'empty' | 'none' | 'finished' | 'ambiguous', matches?: run[], run? }
 * An exact id names that run whatever its state (the server says when it already ended). Every
 * other way names a run that still works; one that ended is `finished`. A full id the tray does not
 * know is handed on as `{ error: 'none', passthrough: id }`: the server knows more runs than a tray.
 */
export function resolveStopTarget(target, runs = []) {
  const raw = unquote(target);
  if (!raw) return { error: 'empty' };
  const list = (Array.isArray(runs) ? runs : []).filter((run) => run && run.runId && run.removed !== true);
  const live = list.filter((run) => !isTerminalRunStatus(run.status));
  const one = (matches, by) => {
    if (matches.length === 1) return isTerminalRunStatus(matches[0].status) ? { error: 'finished', run: matches[0] } : { run: matches[0], by };
    if (matches.length > 1) return { error: 'ambiguous', matches };
    return null;
  };
  const lower = raw.toLowerCase();

  const exact = list.find((run) => String(run.runId).toLowerCase() === lower);
  if (exact) return { run: exact, by: 'id' };
  if (ID_PREFIX.test(raw)) {
    const byPrefix = one(list.filter((run) => String(run.runId).toLowerCase().startsWith(lower)), 'prefix');
    if (byPrefix) return byPrefix;
  }

  const title = (run) => words(run.title || run.task || '').join(' ');
  const wanted = words(raw).join(' ');
  if (wanted) {
    const byTitle = one(live.filter((run) => title(run) === wanted), 'title');
    if (byTitle) return byTitle;
  }
  // The words that say which run: each one is a word of its title, or the start of one.
  const keys = words(raw).filter((word) => !FILLER.has(word));
  if (keys.length) {
    const fits = (run) => { const have = words(run.title || run.task || ''); return keys.every((key) => have.some((word) => word === key || (key.length >= 3 && word.startsWith(key)))); };
    const byWords = one(live.filter(fits), 'words');
    if (byWords) return byWords;
    const ended = list.filter((run) => isTerminalRunStatus(run.status) && (title(run) === wanted || fits(run)));
    if (ended.length === 1) return { error: 'finished', run: ended[0] };
  }
  return FULL_RUN_ID.test(raw) ? { error: 'none', passthrough: raw } : { error: 'none' };
}

/**
 * A press that only counts as the second of two. `press()` → 'armed' (the first: `onChange(true)`),
 * 'confirmed' (the second, inside `windowMs` and at least `minGapMs` after the first:
 * `onChange(false)`, the caller stops everything) or 'ignored' (too soon after the first: a double
 * click, a held key). The arm lapses after `windowMs` by itself (`onChange(false)`).
 */
export function createConfirmGate({
  windowMs = STOP_ALL_CONFIRM_MS,
  minGapMs = STOP_ALL_MIN_GAP_MS,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onChange = () => {},
} = {}) {
  let armedAt = null;
  let timer = null;
  const notify = (armed) => { try { onChange(armed); } catch { /* the button is gone */ } };
  function reset() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (armedAt === null) return false;
    armedAt = null;
    notify(false);
    return true;
  }
  function press() {
    const at = now();
    // An arm whose timer never ran (a throttled background tab) has lapsed all the same.
    if (armedAt !== null && at - armedAt > windowMs) reset();
    if (armedAt === null) {
      armedAt = at;
      timer = setTimer(() => { timer = null; reset(); }, windowMs);
      notify(true);
      return 'armed';
    }
    if (at - armedAt < minGapMs) return 'ignored';
    reset();
    return 'confirmed';
  }
  return {
    press,
    reset,
    isArmed: () => armedAt !== null,
    destroy() { if (timer !== null) { clearTimer(timer); timer = null; } armedAt = null; },
  };
}
