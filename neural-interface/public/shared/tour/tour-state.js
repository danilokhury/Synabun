// What the Workspace tour remembers, in the UI state (storage.js): whether it was
// completed or skipped, whether it was ever started, and its cursor (a beat id;
// tour-beats.js resumeBeat reads the older tours' cursors too). No DOM, no
// engine: the empty state's starter row asks tourOffered() without loading the
// tour. The just-in-time tips (tour-tips.js) keep the ones already shown here.
import { KEYS } from '../constants.js';

/** The first-visit starter row shows until the tour is completed or skipped. */
export function tourOffered(storage) {
  try { return !storage.getItem(KEYS.TUTORIAL_COMPLETED) && !storage.getItem(KEYS.TUTORIAL_SKIPPED); } catch { return false; }
}

/** A returning user (the tour was started, completed or skipped before): ? opens on the chapter list. */
export function tourReturning(storage) {
  try { return [KEYS.TUTORIAL_COMPLETED, KEYS.TUTORIAL_SKIPPED, KEYS.TUTORIAL_STARTED].some(k => !!storage.getItem(k)); } catch { return false; }
}

/** The tour was completed ('completed') or skipped ('skipped'). */
export function markTourSeen(storage, how) {
  try {
    if (how === 'completed') storage.setItem(KEYS.TUTORIAL_COMPLETED, 'true');
    else if (how === 'skipped') storage.setItem(KEYS.TUTORIAL_SKIPPED, 'true');
  } catch { /* storage unavailable: the row shows again next time */ }
}

/** The tips already shown (a set of ids). */
export function tipsSeen(storage) {
  try {
    const list = JSON.parse(storage.getItem(KEYS.TOUR_TIPS) || '[]');
    return new Set(Array.isArray(list) ? list.filter(x => typeof x === 'string') : []);
  } catch { return new Set(); }
}

/** Remember that tip `id` was shown: never twice. */
export function markTipSeen(storage, id) {
  const seen = tipsSeen(storage);
  if (seen.has(id)) return;
  seen.add(id);
  try { storage.setItem(KEYS.TOUR_TIPS, JSON.stringify([...seen])); } catch { /* shown again next time */ }
}
