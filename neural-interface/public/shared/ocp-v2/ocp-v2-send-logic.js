// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — compose logic without DOM (node:test imports this directly)
// ─────────────────────────────────────────────────────────────────────────────

import { isBindingToken } from './ocp-v2-binding.js';
import { knownDescendant, requestOwner } from './ocp-v2-rehydrate.js';

/**
 * The compose box shows the outgoing prompt at once as a local message. The
 * server's copy arrives as message.updated + message.part.updated a moment
 * later; from then on the local one is a duplicate. Drop it as soon as a user
 * message this send did not know about has a part to show, and stop watching
 * when the turn ends.
 *
 * Returns { dropped(), stop() }.
 */
export function trackOptimisticMessage(store, { optimisticId, existingMessageIds, onDrop, isCurrent } = {}) {
  const known = existingMessageIds instanceof Set ? existingMessageIds : new Set(existingMessageIds || []);
  let dropped = false;
  let unsubscribe = () => {};
  const stop = () => { try { unsubscribe(); } catch { /* already gone */ } unsubscribe = () => {}; };
  const drop = () => {
    if (dropped) return;
    dropped = true;
    stop();
    try { onDrop?.(); } catch (e) { console.warn('[ocp-v2-send] optimistic drop failed', e); }
  };
  unsubscribe = store.subscribe((event, state) => {
    if (dropped) return;
    // The store was bound to another session (`isCurrent` is the send's
    // binding): its messages are not this prompt's server copy.
    if (typeof isCurrent === 'function' && !isCurrent()) { dropped = true; stop(); return; }
    if (event?.type === 'message:remove' && event.messageId === optimisticId) { dropped = true; stop(); return; }
    if (event?.type !== 'part:upsert' && event?.type !== 'part:delta') return;
    const id = event.messageId;
    if (!id || id === optimisticId || known.has(id)) return;
    const msg = state.messages.get(id);
    if (msg && (msg.role || msg.info?.role) === 'user') drop();
  });
  return { dropped: () => dropped, stop };
}

// How often a running turn re-reads the whole transcript. Deltas and part
// updates arrive over the socket; this only repairs a dropped event.
export const TRANSCRIPT_SAFETY_POLL_MS = 10_000;

// ── Turns ────────────────────────────────────────────────────────────────────
// The binding says which session the store is on. It does not say which of
// that session's turns a continuation belongs to: an idle event can let the
// next prompt out while the previous send is still reading the transcript,
// and that older send must not end the newer turn. So a turn has an identity
// of its own (store.beginTurn(), a counter), and a turn token is a binding
// token that also knows its turn:
//   isCurrent()  the store is on the token's binding AND no newer turn began
//   onBinding()  the store is on the token's binding (what the transcript, a
//                banner or the strips need: they are the session's, not the turn's)
function turnToken(store, at, turnId) {
  const onBinding = at.isCurrent;
  const sameTurn = () => (typeof store.getTurn === 'function' ? store.getTurn() === turnId : true);
  const isCurrent = () => onBinding() && sameTurn();
  return Object.freeze({ ...at, turnId, onBinding, isCurrent, isStale: () => !isCurrent() });
}

/**
 * Start a turn on the binding `at`: sets `running` and returns the turn token.
 * (A store without beginTurn, in older tests, just gets `running` set.)
 */
export function beginTurn(store, at) {
  const turnId = typeof store.beginTurn === 'function' ? store.beginTurn() : (store.setRunning(true), 0);
  return turnToken(store, at, turnId);
}

/**
 * The turn that is running right now on the binding `at`, for an action on it
 * that waits (Stop): what it clears afterwards is cleared only while that turn
 * is still the newest one of that binding.
 */
export function currentTurn(store, at) {
  return turnToken(store, at, typeof store.getTurn === 'function' ? store.getTurn() : 0);
}

/**
 * A turn ended (finished, failed, was stopped, timed out): clear `running`,
 * unless it is no longer this turn's to clear. `turn` is the token the turn
 * started with (beginTurn; a plain binding token is accepted too): once the
 * panel left that binding the flag is another session's, also when the panel
 * is back on the same session (A → B → A); and once a newer turn began on the
 * same binding the flag is that turn's. A bare session id is still accepted
 * and compared by id only.
 * Returns whether the flag was this turn's to clear.
 */
export function endTurn(store, turn) {
  const current = isBindingToken(turn) ? turn.isCurrent() : store.getState().sessionId === turn;
  if (!current) return false;
  store.setRunning(false);
  return true;
}

/**
 * The outcome of a send, for the panel that started it and for the session it
 * went to. `turn` is the binding token of the send; `item` is the prompt as a
 * queue item (`{ text, images, paths, mentions }`, a command also `command`).
 *   • On the binding it started on, the composer handles it as it always did
 *     (`here` is true): the error banner, the attachments back in the strips,
 *     the queued prompt back at the front of the queue.
 *   • Once the panel is elsewhere, none of that may land in the session on
 *     screen. What could not be delivered is parked for the session it was
 *     written for (`parked`), and comes back, paused, when the panel is on
 *     that session: at the next rebinding to it, or at once when the panel is
 *     already back on it under a newer binding (the composer asks the parking
 *     after every failure: see restoreParkedHere in ocp-v2-send.js).
 */
export function settleFailedSend(turn, parked, { item, error = '' } = {}) {
  const here = typeof turn.onBinding === 'function' ? turn.onBinding() : turn.isCurrent();
  if (here) return { here: true, parked: false };
  const kept = !!(turn.sessionId && item && parked?.park(turn.sessionId, { item, error }));
  return { here: false, parked: kept };
}

// ── How long a turn may take ────────────────────────────────────────────────
// A turn can wait on the user for as long as they take (a permission, a
// question): the clock that gives up on a turn nobody hears from again counts
// only the time it works.

/** The working time a turn's send waits for its answer (message:send, command:run, an async turn's idle). */
export const TURN_LIMIT_MS = 30 * 60 * 1000;

/**
 * Runs `onExpire` once `ms` of unpaused time went by. `paused()` says whether
 * the turn waits on the user now; `subscribe(fn)` calls `fn` whenever that may
 * have changed and returns an unsubscribe. `cancel()` stops it for good.
 */
export function createTurnClock({
  ms, paused = () => false, subscribe = () => () => {}, onExpire = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let left = Math.max(0, Number(ms) || 0);
  let since = 0;
  let timer = null;
  let done = false;
  let unsubscribe = () => {};
  const finish = () => {
    done = true;
    timer = null;
    try { unsubscribe(); } catch { /* gone */ }
  };
  const run = () => {
    if (done || timer) return;
    since = now();
    timer = setTimer(() => { finish(); onExpire(); }, left);
  };
  const hold = () => {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
    left = Math.max(0, left - (now() - since));
  };
  const sync = () => {
    if (done) return;
    if (paused()) hold(); else run();
  };
  unsubscribe = subscribe(sync) || (() => {});
  sync();
  return {
    cancel() {
      if (done) return;
      if (timer) clearTimer(timer);
      finish();
    },
    /** The working time left (ms). */
    left: () => (timer ? Math.max(0, left - (now() - since)) : left),
  };
}

const ASKED = new Set(['permission.asked', 'question.asked']);
const ANSWERED = new Set(['permission.replied', 'question.replied', 'question.rejected']);
const askIdOf = (ev) => String(ev?.requestID || ev?.id || ev?.permissionID || '');
const askKindOf = (eventType) => (String(eventType).startsWith('permission.') ? 'permission' : 'question');

/** The two lists a session's open requests are read from (permission:list, question:list). */
export const ASK_KINDS = Object.freeze(['permission', 'question']);
/** How often a list is read before the panel gives up on it, the first read included. */
export const ASK_READ_ATTEMPTS = 3;
/** The waits before the second and the third read of a list. */
export const ASK_RETRY_MS = Object.freeze([1000, 4000]);
const LIST_STATES = new Set(['ok', 'failed', 'unsupported', 'unresolved']);

// One event applied to the open requests (request id → { owner, kind, stale }); true when what waits changed.
function applyAskEvent(open, eventType, ev) {
  if (ASKED.has(eventType)) {
    const id = askIdOf(ev);
    const owner = requestOwner(ev);
    if (!id || !owner) return false;
    const known = open.get(id);
    open.set(id, { owner, kind: askKindOf(eventType), stale: false });
    return known?.owner !== owner;
  }
  if (ANSWERED.has(eventType)) return open.delete(askIdOf(ev));
  if (eventType === 'session.idle' || eventType === 'session.error') {
    const sid = String(ev?.sessionID || ev?.sessionId || '');
    let gone = false;
    for (const [id, entry] of open) if (entry.owner === sid) { open.delete(id); gone = true; }
    return gone;
  }
  return false;
}

/**
 * The requests that wait on the user, by the session that raised them, from
 * the panel's event stream (every session's events reach it): asked by
 * permission.asked / question.asked, gone with their answer, and gone with the
 * turn (session.idle, session.error). `waits(sessionId)` is true while that
 * session, or a sub-agent below it (`parentOf`: child → parent), has one.
 *
 * What the stream cannot tell (what was asked before the page loaded, or while
 * the socket was down) is read from the server, list by list: each session's
 * permissions and its questions (readOpenAsks). `read(want, { attempt, partial })`
 * resolves `{ lists }`, each `{ sessionId, kind, state, requests }`; `want` is
 * null for every session a panel is bound to, else `[{ sessionId, kinds }]`.
 *   • A list that was read (state ok, or unresolved: read, but a request in it
 *     is of a session whose place could not be established) replaces what was
 *     known of its kind for its session and the sub-agents known below it, also
 *     when it came back empty. Events that arrived while it was read are applied
 *     again on top.
 *   • A session whose list failed or is unresolved keeps waiting (no clock of it
 *     counts) and has that list read again, ASK_READ_ATTEMPTS times in all. Then,
 *     or at once for a list the server cannot give (unsupported), the panel gives
 *     up on it: what was known of it from before the outage goes, its clocks
 *     count again, and the rebuild resolves `{ gaveUp: [{ sessionId, kinds }] }`
 *     so that the panel says so. Nothing could be read at all: `{ unread: true }`.
 * `hold()` (the socket closed): every session counts as waiting until the first
 * read of the `rebuild(read)` that follows, and what was known turns into
 * unconfirmed, to be confirmed or dropped by the lists. A newer `hold()` makes
 * an older rebuild void (it resolves null).
 * `expect(sessionIds)` + `rebuild(read, { sessions })` read only those sessions
 * (a page load, a panel bound to another session): they wait from `expect` until
 * their lists are in, and no other session is held.
 */
export function createAskTracker({ parentOf = new Map(), attempts = ASK_READ_ATTEMPTS, retryMs = ASK_RETRY_MS, setTimer = setTimeout } = {}) {
  let open = new Map();        // request id → { owner, kind, stale }
  let held = false;            // the socket is down, or the first read after it is out: everything waits
  const pending = new Map();   // session → the kinds whose list is still to be read (it waits meanwhile)
  let generation = 0;
  let replay = null;           // the events noted while a read is out
  const listeners = new Set();
  const changed = () => {
    for (const fn of [...listeners]) {
      try { fn(); } catch (e) { console.warn('[ocp-v2-send] ask listener failed', e); }
    }
  };
  const under = (owner, root) => owner === root || knownDescendant(owner, root, parentOf);
  const expect = (sessionId, kinds) => {
    let set = pending.get(sessionId);
    if (!set) pending.set(sessionId, (set = new Set()));
    for (const kind of kinds) set.add(kind);
  };
  const settle = (sessionId, kind) => {
    const set = pending.get(sessionId);
    if (!set) return;
    set.delete(kind);
    if (!set.size) pending.delete(sessionId);
  };
  // An entry still to be confirmed by a list that will be read again.
  const awaited = (entry) => {
    for (const [root, kinds] of pending) if (kinds.has(entry.kind) && under(entry.owner, root)) return true;
    return false;
  };
  const sleep = (ms) => new Promise((done) => { setTimer(done, Math.max(0, Number(ms) || 0)); });
  const delayAfter = (attempt) => (Array.isArray(retryMs) ? retryMs[Math.min(attempt, retryMs.length) - 1] : retryMs) || 0;
  const wantedOf = (sessions) => (Array.isArray(sessions)
    ? [...new Set(sessions.map((id) => String(id || '')).filter(Boolean))].map((sessionId) => ({ sessionId, kinds: [...ASK_KINDS] }))
    : null);

  return {
    note(eventType, ev) {
      replay?.push([eventType, ev]);
      if (applyAskEvent(open, eventType, ev) && !held) changed();
    },
    waits(sessionId) {
      const sid = String(sessionId || '');
      if (!sid) return false;
      if (held) return true;
      for (const [root, kinds] of pending) if (kinds.size && under(sid, root)) return true;
      for (const { owner } of open.values()) if (owner === sid || knownDescendant(owner, sid, parentOf)) return true;
      return false;
    },
    hold() {
      generation += 1;
      replay = null;
      pending.clear();
      for (const entry of open.values()) entry.stale = true;
      if (held) return;
      held = true;
      changed();
    },
    /** These sessions wait from now until their lists are read (rebuild with `sessions`). */
    expect(sessionIds) {
      const wanted = wantedOf(sessionIds) || [];
      for (const { sessionId, kinds } of wanted) expect(sessionId, kinds);
      if (wanted.length && !held) changed();
    },
    /** These sessions wait for no read of their own (their parent's lists hold their requests). */
    release(sessionIds) {
      let gone = false;
      for (const { sessionId } of wantedOf(sessionIds) || []) gone = pending.delete(sessionId) || gone;
      if (gone && !held) changed();
    },
    async rebuild(read, { sessions = null } = {}) {
      const mine = generation;
      const partial = Array.isArray(sessions);
      let want = wantedOf(sessions);
      if (partial) {
        if (!want.length) return { gaveUp: [] };
        for (const { sessionId, kinds } of want) expect(sessionId, kinds);
      }
      const gaveUp = new Map(); // session → kinds given up on
      for (let attempt = 1; ; attempt += 1) {
        replay = [];
        let snapshot = null;
        try { snapshot = await read(want, { attempt, partial }); } catch { snapshot = null; }
        if (mine !== generation) return null;
        const events = replay || [];
        replay = null;
        const last = attempt >= attempts;
        const lists = Array.isArray(snapshot?.lists) ? snapshot.lists : null;
        if (!lists && !want) {
          // Nothing came back, and nothing says which sessions were read.
          if (!last) {
            await sleep(delayAfter(attempt));
            if (mine !== generation) return null;
            continue;
          }
          for (const [id, entry] of open) if (entry.stale) open.delete(id);
          held = false;
          changed();
          return { gaveUp: [], unread: true };
        }
        const results = [];
        for (const list of lists || []) {
          const sessionId = String(list?.sessionId || '');
          if (!sessionId || !ASK_KINDS.includes(list?.kind)) continue;
          results.push({
            sessionId,
            kind: list.kind,
            state: LIST_STATES.has(list.state) ? list.state : 'failed',
            requests: Array.isArray(list.requests) ? list.requests : [],
          });
        }
        for (const { sessionId, kinds } of want || []) {
          for (const kind of kinds) {
            if (results.some((list) => list.sessionId === sessionId && list.kind === kind)) continue;
            // Not in the answer: nothing came back (failed), or no panel is bound to it any more (not asked).
            if (lists) settle(sessionId, kind);
            else results.push({ sessionId, kind, state: 'failed', requests: [] });
          }
        }
        const next = new Map(open);
        for (const list of results) {
          if (list.state !== 'ok' && list.state !== 'unresolved') continue;
          const listed = new Map();
          for (const req of list.requests) {
            const id = askIdOf(req);
            const owner = requestOwner(req);
            if (id && owner) listed.set(id, owner);
          }
          // What the list does not hold is no longer open, for its session and the sub-agents known below it.
          for (const [id, entry] of next) {
            if (entry.kind === list.kind && under(entry.owner, list.sessionId) && !listed.has(id)) next.delete(id);
          }
          for (const [id, owner] of listed) next.set(id, { owner, kind: list.kind, stale: false });
        }
        const again = new Map(); // session → kinds to read again
        for (const list of results) {
          if (list.state === 'ok') { settle(list.sessionId, list.kind); continue; }
          if (list.state === 'unsupported' || last) {
            settle(list.sessionId, list.kind);
            if (!gaveUp.has(list.sessionId)) gaveUp.set(list.sessionId, new Set());
            gaveUp.get(list.sessionId).add(list.kind);
            continue;
          }
          expect(list.sessionId, [list.kind]);
          if (!again.has(list.sessionId)) again.set(list.sessionId, new Set());
          again.get(list.sessionId).add(list.kind);
        }
        for (const [eventType, ev] of events) applyAskEvent(next, eventType, ev);
        // Known from before the outage and confirmed by no list that is still to come: it goes.
        for (const [id, entry] of next) if (entry.stale && !awaited(entry)) next.delete(id);
        open = next;
        if (!partial) held = false;
        changed();
        if (!again.size) {
          return { gaveUp: [...gaveUp].map(([sessionId, kinds]) => ({ sessionId, kinds: ASK_KINDS.filter((kind) => kinds.has(kind)) })) };
        }
        await sleep(delayAfter(attempt));
        if (mine !== generation) return null;
        want = [...again].map(([sessionId, kinds]) => ({ sessionId, kinds: ASK_KINDS.filter((kind) => kinds.has(kind)) }));
      }
    },
    clear() {
      if (!open.size) return;
      open.clear();
      changed();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * The sentence a panel shows when the open requests of its session could not
 * be read (the tracker gave up on `kinds`): its turn's clock counts again.
 */
export function unreadAsksNotice(kinds = ASK_KINDS) {
  const set = new Set(Array.isArray(kinds) && kinds.length ? kinds : ASK_KINDS);
  const what = set.has('permission') && set.has('question') ? 'permissions and questions'
    : set.has('permission') ? 'permissions' : 'questions';
  return `Could not read this session's open ${what} from OpenCode: its 30-minute turn limit runs as if none were waiting.`;
}

/**
 * What waits on the user in the sessions panels are bound to, read from the
 * server: for each `{ sessionId, cwd, kinds }` (both kinds unless it says), the
 * open permissions (`api.permissionList`) and questions (`api.questionList`) of
 * the serve that runs that session, with its sub-agents' (they run on the same
 * serve). Each list comes back with its `state`: ok; failed; unsupported (the
 * server has no such request type); or unresolved: read, but it holds a request
 * of a session whose place under this one could not be established.
 * A request of a session that is neither one of these nor known below one has
 * its place read (`ancestry(owner, sessionId)`: true, false, or null when that
 * could not be read; it remembers what it learns), so that a sub-agent spawned
 * while nobody watched holds its parent's clock too: at most `maxLookups`
 * lookups within `lookupMs`, each given only the time that is left (a lookup
 * still waiting on the server then counts as not read). `isDescendant`, a
 * yes / no answer, is accepted in its place.
 * Resolves `{ lists, requests, complete }`: `complete` when every list is ok.
 */
export async function readOpenAsks(api, sessions, {
  ancestry = null, isDescendant = null, known = () => false,
  maxLookups = 20, lookupMs = 5000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const listOf = (res) => {
    const data = res?.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.questions)) return data.questions;
    if (Array.isArray(data?.data)) return data.data;
    return null;
  };
  const failed = (res) => !res || res.ok === false || res.error != null || (typeof res.status === 'number' && res.status >= 400);
  const readList = async (call) => {
    let res;
    try { res = await call(); } catch { res = null; }
    if (res?.unsupported) return { state: 'unsupported', requests: [] };
    const list = failed(res) ? null : listOf(res);
    if (!list) return { state: 'failed', requests: [] };
    return { state: 'ok', requests: list.filter((req) => askIdOf(req) && requestOwner(req)) };
  };
  const lists = [];
  for (const { sessionId, cwd, kinds } of Array.isArray(sessions) ? sessions : []) {
    if (!sessionId) continue;
    const root = String(sessionId);
    const wanted = ASK_KINDS.filter((kind) => !Array.isArray(kinds) || kinds.includes(kind));
    const read = await Promise.all(wanted.map((kind) => readList(() => (kind === 'permission'
      ? api.permissionList({ sessionId, cwd })
      : api.questionList({ sessionId, cwd })))));
    wanted.forEach((kind, i) => lists.push({ sessionId: root, kind, ...read[i] }));
  }

  // Sub-agents spawned while nobody watched: their place under a session that was read, a few at most and for
  // a few seconds at most (the clocks stay held meanwhile).
  const lookup = typeof ancestry === 'function' ? ancestry
    : typeof isDescendant === 'function' ? async (owner, root) => (await isDescendant(owner, root)) === true
      : null;
  const roots = [...new Set(lists.map((list) => list.sessionId))];
  const until = now() + lookupMs;
  let lookups = 0;
  const place = async (owner, root) => {
    if (!lookup) return false;
    const left = until - now();
    if (lookups >= maxLookups || left <= 0) return null;
    lookups += 1;
    let timer = null;
    const late = new Promise((done) => { timer = setTimer(() => done(null), left); });
    try {
      const answer = await Promise.race([Promise.resolve().then(() => lookup(owner, root)).catch(() => null), late]);
      return answer === true ? true : answer === false ? false : null;
    } finally {
      clearTimer(timer);
    }
  };
  const unplaced = new Map(); // owner → the sessions whose lists hold a request of it
  for (const list of lists) {
    if (list.state !== 'ok') continue;
    for (const req of list.requests) {
      const owner = requestOwner(req);
      if (roots.includes(owner) || roots.some((root) => known(owner, root))) continue;
      if (!unplaced.has(owner)) unplaced.set(owner, new Set());
      unplaced.get(owner).add(list.sessionId);
    }
  }
  for (const [owner, under] of unplaced) {
    const unknown = [];
    let placed = false;
    for (const root of under) {
      const answer = await place(owner, root);
      if (answer === true) { placed = true; break; }
      if (answer === null) unknown.push(root);
    }
    if (placed) continue;
    for (const list of lists) {
      if (list.state === 'ok' && unknown.includes(list.sessionId) && list.requests.some((req) => requestOwner(req) === owner)) list.state = 'unresolved';
    }
  }
  const requests = new Map();
  for (const list of lists) for (const req of list.requests) requests.set(askIdOf(req), req);
  return { lists, requests: [...requests.values()], complete: lists.every((list) => list.state === 'ok') };
}
