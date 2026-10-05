// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — the binding rule (no DOM)
// A panel has one store, and that store is bound to one session at a time. Its
// state object is rebound in place when the session changes and
// store.getState() hands out that live object: after an `await`, `s.sessionId`,
// `s.cwd`, the plan, the queue or the session info are those of whatever the
// panel is on by then, not of the session the action started on.
//
// So every flow that waits (an await, a promise callback, a timer, a handler
// that fires later) does this, and nothing else:
//   const at = captureBinding(store);        // before the first await
//   const res = await api.something({ sessionId: at.sessionId, cwd: at.cwd });
//   if (!at.isCurrent()) return;             // the panel moved on: drop it
// `at` is a frozen snapshot: what goes into a request, a file name or a
// persistence key after the wait is read from it, never from the store.
//
// The identity is the store's `binding` revision (ocp-v2-state.js): it changes
// on every rebinding, also when the panel leaves a session and comes back to it
// (A → B → A is a new binding), and it is the same counter the recovery guards
// in ocp-v2-rehydrate.js use. A stale continuation drops its result; where the
// result is still worth something to the session it belongs to (a download, a
// saved setting, a prompt that failed to send) the flow applies it to
// `at.sessionId` explicitly, never to the store.
// ─────────────────────────────────────────────────────────────────────────────

/** The store's binding identity (0 for a store that has none). */
export function bindingOf(store) {
  if (typeof store?.getBinding === 'function') return store.getBinding();
  if (typeof store?.getRevisions === 'function') return store.getRevisions().binding || 0;
  return 0;
}

const directoryOf = (s) => s.cwd || s.sessionInfo?.directory || null;

// A frozen copy of plain data (objects and arrays, all the way down). What a
// token carries is what the store held when it was captured: the store's own
// objects are rebound and edited in place afterwards (session.updated merges
// into sessionInfo, the model picker replaces the model), and a continuation
// must neither see that nor be able to change the store through its token.
function frozenCopy(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(frozenCopy(item, seen));
    return Object.freeze(out);
  }
  const proto = Object.getPrototypeOf(value);
  // Not plain data (a Map, a Date, a DOM node): nothing a snapshot should hold.
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) out[key] = frozenCopy(value[key], seen);
  return Object.freeze(out);
}

/**
 * The binding the store has right now, with what a flow needs from it later.
 *   sessionId    pin the token to this session instead of the one the store is
 *                on (recovery is asked for a session by id): it is current only
 *                while the store is on that session under this binding
 *   isCurrent()  an extra veto, e.g. "this child panel is still the open one"
 * Returns a frozen token:
 *   binding, sessionId, cwd, directory (cwd, else the session's directory),
 *   model, variant, agent, mode, mcpProfile, sessionInfo (model and
 *   sessionInfo are frozen copies, nested objects included)
 *   isCurrent()  the store is still on this binding
 *   isStale()    the opposite
 *   sameCwd()    the store's project directory is still the captured one
 */
export function captureBinding(store, { sessionId, isCurrent } = {}) {
  const s = store.getState();
  const binding = bindingOf(store);
  const boundSessionId = sessionId === undefined ? (s.sessionId || null) : (sessionId || null);
  const veto = typeof isCurrent === 'function' ? isCurrent : null;
  const cwd = s.cwd || null;
  const current = () => {
    if (bindingOf(store) !== binding) return false;
    if ((store.getState().sessionId || null) !== boundSessionId) return false;
    if (!veto) return true;
    try { return veto() === true; } catch { return false; }
  };
  return Object.freeze({
    binding,
    sessionId: boundSessionId,
    cwd,
    directory: directoryOf(s),
    model: frozenCopy(s.model) || null,
    variant: s.variant || null,
    agent: s.agent || null,
    mode: s.mode || null,
    mcpProfile: s.mcpProfile || null,
    sessionInfo: s.sessionInfo ? frozenCopy(s.sessionInfo) : null,
    isCurrent: current,
    isStale: () => !current(),
    sameCwd: () => (store.getState().cwd || null) === cwd,
  });
}

/** True for a token captureBinding made (a session id or nothing is not one). */
export const isBindingToken = (value) => !!value && typeof value === 'object' && typeof value.isCurrent === 'function';

/**
 * Notices a rebinding from inside a store listener: `changed()` is true once
 * per move. For a module that already subscribes and has to do something
 * first when the binding changes (forget what belonged to the old one).
 */
export function trackBinding(store) {
  let last = bindingOf(store);
  return {
    changed() {
      const now = bindingOf(store);
      if (now === last) return false;
      last = now;
      return true;
    },
  };
}

/**
 * Calls `listener(token)` once for every rebinding of `store`, with the new
 * binding. Returns the unsubscribe. For things that live across sessions (an
 * overlay, a popover, a busy flag) and must be closed or reset when the panel
 * moves.
 */
export function onRebind(store, listener) {
  const tracker = trackBinding(store);
  return store.subscribe(() => {
    if (!tracker.changed()) return;
    try { listener(captureBinding(store)); } catch (err) { console.warn('[ocp-v2-binding] rebind listener failed', err); }
  });
}

/**
 * "The latest one wins" for a view that asks again before the previous answer
 * is back (a search per keystroke, a tab, a popover that re-renders): `begin()`
 * returns `() => boolean`, true while no newer request began and nothing
 * called `cancel()`.
 */
export function latestOnly() {
  let seq = 0;
  return {
    begin() { const mine = ++seq; return () => mine === seq; },
    cancel() { seq += 1; },
  };
}

/**
 * latestOnly for a list that is read again whenever its filters change (a
 * search box, a "show archived" switch): `begin(filters)` returns
 * `(filtersNow) => boolean`, true while no newer read began AND the filters
 * are still the ones this read was asked with. A read that was overtaken, or
 * whose filters changed while the next read is still scheduled, paints
 * nothing: neither its rows nor its failure.
 */
export function latestFor() {
  const reads = latestOnly();
  const keyOf = (filters) => JSON.stringify(filters ?? null);
  return {
    begin(filters) {
      const mine = reads.begin();
      const key = keyOf(filters);
      return (filtersNow) => mine() && keyOf(filtersNow) === key;
    },
    cancel() { reads.cancel(); },
  };
}

/**
 * Wraps a search so its answer is only handed out for the binding and the
 * directory it was asked under. `search(query, { sessionId, cwd })` does the
 * asking; the wrapper resolves its answer, or null when the store was rebound
 * or `getCwd()` changed while it was out (rows of another session's project
 * are never offered).
 */
export function searchOnBinding(store, getCwd, search) {
  return async (query) => {
    const at = captureBinding(store);
    const cwd = getCwd();
    const answer = await search(query, { sessionId: at.sessionId, cwd });
    return at.isCurrent() && getCwd() === cwd ? answer : null;
  };
}

/**
 * A reader for a view that outlives a session (a popover, an overlay) and asks
 * the server about the session on screen. `read(load, apply)`:
 *   load(at)          asks, with the binding snapshot `at` for its parameters
 *   apply(value, at)  paints, and runs only when this is still the latest read
 *                     AND the store is still on the binding it was asked under
 * Resolves true when `apply` ran. An answer for a session the panel has left
 * (or left and came back to) is dropped, and so is its error.
 */
export function boundReader(store) {
  const reads = latestOnly();
  const read = async (load, apply) => {
    const at = captureBinding(store);
    const mine = reads.begin();
    const fresh = () => mine() && at.isCurrent();
    let value;
    try { value = await load(at); } catch (err) {
      if (fresh()) throw err;
      return false;
    }
    if (!fresh()) return false;
    apply(value, at);
    return true;
  };
  read.cancel = () => reads.cancel();
  return read;
}

// ── Navigation intents ───────────────────────────────────────────────────────
// A binding token says "the panel is still on the session this started on". It
// cannot tell two navigations apart while neither has bound anything yet: a
// click on one tab that is still waiting for the panel to open, and a click on
// another tab after it. Both were started on the same binding.
//
// So where the panel goes has an identity of its own. Every choice of the user
// (a tab, a session in the menu, New session, another project, a new worktree)
// begins an intent, and a navigation binds the panel only while its intent is
// the latest one: after every wait it checks `isCurrent()`, and it binds
// through `apply()`. A later choice always wins over an older one that is
// still in flight. A rebinding nobody announced (the active tab was closed)
// overtakes every intent that is still out.
//
//   const nav = navigation.begin();          // at the gesture, before any await
//   await something();
//   nav.apply(() => store.setSession(id));   // false, and not run, when overtaken
//
// `observe()` is for a navigation the panel starts by itself (boot, an
// automation that asks for focus). It overtakes nothing, so a choice the user
// made before it still stands, and it stands down for everything that happens
// after it: a newer intent, and any rebinding it did not make itself.
//
// `repair()` is for a rebinding the panel has to make because the session on
// screen is gone (the recovery found it deleted). It overtakes nothing either,
// and stands down only when the panel was taken somewhere else: a choice that
// has bound nothing yet does not leave the dead session on screen, and still
// wins when it binds later.
export function createNavigation(store) {
  let latest = 0;                  // the newest intent
  let moves = 0;                   // every rebinding of the store, whoever made it
  let applying = 0;                // > 0 while a navigation applies its own rebinding
  let seen = bindingOf(store);
  const unsubscribe = store.subscribe(() => {
    const now = bindingOf(store);
    if (now === seen) return;
    seen = now;
    moves += 1;
    if (!applying) latest += 1;    // bound by something that announced no intent
  });
  const token = (mine, observing, yields = true) => {
    let ownMoves = moves;          // observing: the rebindings it has seen or made
    const isCurrent = () => (!yields || mine === latest) && (!observing || moves === ownMoves);
    return Object.freeze({
      intent: mine,
      // Where the panel was when the navigation began (what it leaves).
      sessionId: store.getState().sessionId || null,
      cwd: store.getState().cwd || null,
      isCurrent,
      isStale: () => !isCurrent(),
      /** Runs `fn` (this navigation's own rebinding) only while it is current. */
      apply(fn) {
        if (!isCurrent()) return false;
        applying += 1;
        try { fn(); } finally { applying -= 1; seen = bindingOf(store); ownMoves = moves; }
        return true;
      },
    });
  };
  return {
    begin() { latest += 1; return token(latest, false); },
    observe() { return token(latest, true); },
    repair() { return token(latest, true, false); },
    latest: () => latest,
    destroy() { try { unsubscribe(); } catch { /* already gone */ } },
  };
}
