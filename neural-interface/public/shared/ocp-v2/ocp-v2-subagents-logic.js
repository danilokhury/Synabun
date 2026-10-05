// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — sub-agent panels: the rules (no DOM, no socket)
// Every sub-agent session (a session with a parentID, at any depth) of a
// session the main panel has as a tab gets a panel and a pill of its own. None
// replaces another and there is no cap. This module decides:
//   decideVisibility()        which OpenCode panels are on screen (the one place)
//   createSubagentRegistry()  one entry per sub-agent session, kept per parent
//   placeSubagent()           whose set a new sub-agent belongs to, and its chain of parents
//   descendantsOf()           the same tree from a session list (the reload)
//   pillState() / trayPills() what a pill says, and what the tray shows
//   createClosedSubagents()   the sub-agents the user closed (they stay closed)
//   createShownSubagent()     the sub-agent panel that was on screen (the reload)
//   lineageOf() / entriesUnder()  a session's parents, and what is below a session
//   createUnsentPrompts()     prompts that were on their way when their panel went
// The glue is ocp-v2-manager.js (the set) and ocp-v2-childpanel.js (one panel).
// ─────────────────────────────────────────────────────────────────────────────

import { describeError } from './ocp-v2-events.js';
import { closeWithPromptsConfirm } from './ocp-v2-composer-logic.js';

/** The main panel's id in the list of OpenCode panels. A sub-agent panel's id is its panelId. */
export const MAIN_VIEW = 'main';

/**
 * Which OpenCode panels are on screen. This is the one place that decides it:
 * the manager applies what it returns and every panel asks the manager.
 *
 * The rule (2026-10-04): ONE OpenCode panel is visible at a time, the main
 * panel or one sub-agent's panel, in the slot at the right edge that the
 * OpenCode, Claude and Codex panels share. Whether several sub-agent panels
 * may be visible side by side is not decided; when it is, it changes here.
 *
 *   views    every OpenCode panel that exists: MAIN_VIEW and one id per sub-agent panel
 *   visible  the ones on screen now
 *   request  what happened:
 *     { show: id }      a pill, a breadcrumb, a task card or the navbar asks for this panel
 *     { hide: id }      minimize
 *     { hideAll: true } the navbar button while an OpenCode panel is on screen
 *     { yielded: id }   the shared controller took `id` off screen: another
 *                       provider's panel (Claude, Codex) has the slot now
 *     { removed: id }   the panel was closed and no longer exists
 *
 * Returns { visible, show, hide }: the panels on screen afterwards, and what
 * the caller has to show and hide to get there. Nothing is ever shown that was
 * not asked for: a panel that leaves the screen leaves the slot empty.
 */
export function decideVisibility({ views = [], visible = [], request = {} } = {}) {
  const exists = new Set(views);
  const gone = request?.yielded ?? request?.removed;
  // What is on screen before the request, as the caller has to treat it.
  const before = [...new Set(visible)].filter((id) => exists.has(id) && id !== gone);
  let after = before;
  if (request?.hideAll) after = [];
  else if (request?.hide !== undefined) after = before.filter((id) => id !== request.hide);
  else if (request?.show !== undefined && exists.has(request.show)) after = [request.show];
  // One at a time: of several, the one shown last stays.
  if (after.length > 1) after = after.slice(-1);
  return {
    visible: after,
    show: after.filter((id) => !before.includes(id)),
    hide: before.filter((id) => !after.includes(id)),
  };
}

/**
 * The sub-agent panels that exist, one entry per sub-agent session.
 *   add(entry)  entry: { sessionId, parentSessionId, rootSessionId, startedAt, … }.
 *               Returns the entry that is kept: a session that already has one
 *               keeps it (never replaced, whatever announces the session again).
 *   ofRoot(id)  the entries of one parent session (the one the main panel
 *               shows, or any other tab), in the order they were started
 * Entries are the caller's own objects; nothing is copied and nothing is capped.
 */
export function createSubagentRegistry() {
  const entries = new Map();          // sessionId → entry
  let seq = 0;
  const started = (entry) => (Number.isFinite(entry.startedAt) && entry.startedAt > 0 ? entry.startedAt : Infinity);
  const inOrder = (list) => list.sort((a, b) => (started(a) - started(b)) || (a.seq - b.seq));
  return {
    add(entry) {
      const sessionId = String(entry?.sessionId || '');
      if (!sessionId) return null;
      const existing = entries.get(sessionId);
      if (existing) return existing;
      seq += 1;
      entry.seq = seq;
      entries.set(sessionId, entry);
      return entry;
    },
    get: (sessionId) => entries.get(sessionId) || null,
    has: (sessionId) => entries.has(sessionId),
    byPanelId: (panelId) => [...entries.values()].find((entry) => entry.panelId === panelId) || null,
    remove(sessionId) {
      const entry = entries.get(sessionId) || null;
      if (entry) entries.delete(sessionId);
      return entry;
    },
    removeRoot(rootSessionId) {
      const gone = inOrder([...entries.values()].filter((entry) => entry.rootSessionId === rootSessionId));
      for (const entry of gone) entries.delete(entry.sessionId);
      return gone;
    },
    ofRoot: (rootSessionId) => inOrder([...entries.values()].filter((entry) => entry.rootSessionId === rootSessionId)),
    all: () => inOrder([...entries.values()]),
    size: () => entries.size,
  };
}

export const SUBAGENT_MAX_DEPTH = 12;

/**
 * Whose set does the sub-agent `childSessionId` of `parentSessionId` belong to?
 * Walks parent → grandparent through `parentOf` (child → parent, learned from
 * session events and from the children the server listed) up to a session for
 * which `isRoot(id)` holds: a session the main panel has as a tab.
 * Returns { rootSessionId, chain } with `chain` the parents from that session
 * down to the direct parent (what the breadcrumb shows), or null when the
 * lineage cannot be established: then the sub-agent is nobody's here.
 */
export function placeSubagent({ parentSessionId, childSessionId, parentOf, isRoot } = {}) {
  if (!parentSessionId || !childSessionId || parentSessionId === childSessionId) return null;
  const root = (id) => { try { return isRoot?.(id) === true; } catch { return false; } };
  const chain = [];
  const seen = new Set([childSessionId]);
  let cursor = parentSessionId;
  for (let depth = 0; depth < SUBAGENT_MAX_DEPTH && cursor; depth += 1) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
    chain.unshift(cursor);
    if (root(cursor)) return { rootSessionId: cursor, chain };
    cursor = parentOf?.get?.(cursor);
  }
  return null;
}

const parentIdOf = (session) => String(session?.parentID || session?.parentId || session?.parent_id || '');
const createdOf = (session) => Number(session?.time?.created || session?.time?.updated || 0) || 0;

/**
 * Every descendant of `rootSessionId` in a session list, each after its
 * parent's turn in the order they were created. For the rebuild after a
 * reload: from the children the server lists per session, or from the whole
 * list of a server that cannot list children.
 */
export function descendantsOf(sessions, rootSessionId) {
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && (s.id || s.sessionID));
  const idOf = (s) => String(s.id || s.sessionID);
  const inTree = new Set([String(rootSessionId || '')]);
  const out = [];
  if (!rootSessionId) return out;
  for (let depth = 0; depth < SUBAGENT_MAX_DEPTH; depth += 1) {
    const found = list.filter((s) => !inTree.has(idOf(s)) && inTree.has(parentIdOf(s)));
    if (!found.length) break;
    for (const s of found) { inTree.add(idOf(s)); out.push(s); }
  }
  return out.sort((a, b) => createdOf(a) - createdOf(b));
}

// ── What a pill says ────────────────────────────────────────────────────────

// The error of the last answer in the transcript, when it is a real one.
// Stopping a turn is not a failure (the message itself says "Stopped").
function lastAnswerFailed(state) {
  const order = state?.messageOrder || [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const info = state.messages?.get?.(order[i])?.info;
    if (!info || info.role !== 'assistant') continue;
    return !!info.error && describeError(info.error).kind !== 'aborted';
  }
  return false;
}

/**
 * What the pill of a sub-agent says, from its panel's store state.
 *   state    'waiting'  a permission request or a question waits for the user
 *            'running'  its turn is running
 *            'failed'   the session reported an error, or its last answer carries one
 *            'done'     the turn ended and there is a transcript
 *            'idle'     nothing yet
 *   kind / text   the badge: permission "!", question "?" (or how many), error "!", done "✓"
 *   waiting / running   as flags (a sub-agent that waits is usually still running)
 *   shown    this sub-agent's panel is the one on screen
 * Waiting wins: it is the one state that needs the user.
 *   started  (option) the sub-agent ran before this page knew it: its pill was
 *            rebuilt from the sessions the server listed after a reload. Its
 *            transcript is read when its panel is first shown, so 'done' is
 *            said without one; whether its last answer failed is known only
 *            once the transcript was read.
 */
export function pillState(state, { visible = false, started = false } = {}) {
  const permissions = (state?.pendingPermissions || []).length;
  const questions = (state?.pendingQuestions || []).length;
  const running = !!state?.running;
  const waiting = permissions + questions > 0;
  const errors = (state?.errors || []).filter((err) => !err?.notice).length;
  const base = { waiting, running, shown: !!visible };
  if (permissions) return { state: 'waiting', kind: 'permission', text: '!', ...base };
  if (questions) return { state: 'waiting', kind: 'question', text: questions > 1 ? String(questions) : '?', ...base };
  if (running) return { state: 'running', kind: '', text: '', ...base };
  if (errors || lastAnswerFailed(state)) return { state: 'failed', kind: 'error', text: '!', ...base };
  if ((state?.messageOrder || []).length || started) return { state: 'done', kind: 'done', text: '✓', ...base };
  return { state: 'idle', kind: '', text: '', ...base };
}

/** The pills that fit before the group scrolls (the stylesheet bounds it to this many rows). */
export const SUBAGENT_TRAY_ROWS = 8;

export const SUBAGENT_TRAY_MAX_PX = 310;
/** One pill and the gap under it. */
export const SUBAGENT_PILL_ROW_PX = 36;

/**
 * How tall the group of pills may be, in px: the room the tray's other pills
 * (every provider's tabs, `othersHeight`) leave in the window under the
 * tray's top edge, eight rows at most. The group takes what is left, however
 * little that is (nothing, when the other pills already fill the window), and
 * scrolls inside it: it never ends below the window and never pushes the
 * pills under it off the page. Without a layout to measure, the stylesheet's
 * own bound.
 */
export function trayGroupHeight({ trayTop = 0, othersHeight = 0, viewportHeight = 0 } = {}) {
  const room = Math.floor(viewportHeight - trayTop - othersHeight - 12);
  if (!(viewportHeight > 0) || !Number.isFinite(room)) return SUBAGENT_TRAY_MAX_PX;
  return Math.max(0, Math.min(SUBAGENT_TRAY_MAX_PX, room));
}

/**
 * Does the group scroll: more pills than its rows, or more than fit into the
 * height it was given (trayGroupHeight)? Then the count line is shown, so a
 * group that has room for a row or less still says how many sub-agents there
 * are and how many of them wait.
 */
export function trayGroupScrolls({ count = 0, height = SUBAGENT_TRAY_MAX_PX } = {}) {
  if (count > SUBAGENT_TRAY_ROWS) return true;
  return Number.isFinite(height) && count * SUBAGENT_PILL_ROW_PX > height;
}

/** How many sub-agents there are, and how many need attention, as one line. */
export function traySummary(states) {
  const list = Array.isArray(states) ? states : [];
  const count = (name) => list.filter((s) => s?.state === name).length;
  const out = { total: list.length, running: count('running'), waiting: count('waiting'), failed: count('failed'), done: count('done') };
  const parts = out.total ? [`${out.total} sub-agent${out.total === 1 ? '' : 's'}`] : [];
  if (out.waiting) parts.push(`${out.waiting} waiting`);
  if (out.running) parts.push(`${out.running} running`);
  if (out.failed) parts.push(`${out.failed} failed`);
  out.text = parts.join(' · ');
  return out;
}

/**
 * What the tray shows of the sub-agent panels.
 *   entries         every sub-agent panel (createSubagentRegistry().all())
 *   shownRoot       the session the main panel is on: its sub-agents have their
 *                   pills in the tray, in the order they were started; the
 *                   pills of every other session's sub-agents are kept, out of it
 *   visiblePanelId  the sub-agent panel on screen, if one is
 *   stateOf(entry)  its pillState()
 * Returns { pills, summary, scrolls, firstWaiting, parents }:
 *   pills          [{ sessionId, panelId, depth, shown, ...pillState }]
 *   scrolls        more pills than the group shows at once: the count line is shown
 *   firstWaiting   the first sub-agent that waits for an answer (scrolled into view)
 *   parents        Map(rootSessionId → { hasChild, running, waiting }): what the
 *                  pill of each parent session says about its sub-agents
 */
export function trayPills({ entries = [], shownRoot = '', visiblePanelId = '', stateOf = () => ({ state: 'idle' }) } = {}) {
  const parents = new Map();
  const pills = [];
  for (const entry of entries) {
    const said = stateOf(entry) || { state: 'idle' };
    const flags = parents.get(entry.rootSessionId) || { hasChild: false, running: false, waiting: false };
    flags.hasChild = true;
    if (said.state === 'running' || said.running) flags.running = true;
    if (said.state === 'waiting') flags.waiting = true;
    parents.set(entry.rootSessionId, flags);
    if (!shownRoot || entry.rootSessionId !== shownRoot) continue;
    pills.push({ ...said, sessionId: entry.sessionId, panelId: entry.panelId, depth: entry.depth || 0, shown: !!visiblePanelId && entry.panelId === visiblePanelId });
  }
  return {
    pills,
    summary: traySummary(pills),
    scrolls: pills.length > SUBAGENT_TRAY_ROWS,
    firstWaiting: pills.find((pill) => pill.state === 'waiting')?.sessionId || '',
    parents,
  };
}

// ── Closing ─────────────────────────────────────────────────────────────────

/**
 * The question before a sub-agent panel is closed while its compose box still
 * holds something unsent (its queue, its draft): closing discards that. ''
 * when there is nothing to lose (no question). Closing removes the panel and
 * the pill; the sub-agent session itself is not deleted or stopped.
 */
export function closeSubagentConfirm({ items = [], label = '' } = {}) {
  if (!items.length) return '';
  const lead = label ? `Close the sub-agent panel “${label}”?` : 'Close this sub-agent panel?';
  // A prompt that is on its way (`sending`) is this panel's until OpenCode has
  // accepted it: it is listed, and the question says what closing means for it.
  const sending = items.filter((item) => item?.sending).length;
  const which = items.length === 1 ? 'It is' : (sending === 1 ? 'One of them is' : `${sending} of them are`);
  const onItsWay = sending
    ? `\n\n${which} being sent: that goes on. If it fails, the prompt is kept for this sub-agent and is back in its compose box when its panel is opened again.`
    : '';
  return `${closeWithPromptsConfirm({ items, lead })}${onItsWay}\n\nThe sub-agent session itself is not deleted.`;
}

// ── A prompt that was on its way when its panel went ────────────────────────

/**
 * Prompts that were being sent to a sub-agent when its panel went away (the
 * user closed it, its parent's tab was closed, its session was deleted
 * somewhere else) and whose send then failed. Each is kept whole (text,
 * attachments, referenced paths, mentions; a command as that command) for the
 * sub-agent it was written for, and is put back into that sub-agent's compose
 * box when its panel is opened again (`take`). Nothing is evicted: every entry
 * is a prompt the user has not sent. In memory, like every queue and draft.
 */
export function createUnsentPrompts() {
  const bySession = new Map();        // sessionId → [prompt]
  return {
    keep(sessionId, item) {
      const key = String(sessionId || '');
      if (!key || !item) return false;
      const { sending, id, ...prompt } = item;
      bySession.set(key, [...(bySession.get(key) || []), prompt]);
      return true;
    },
    /** What is kept for `sessionId`, removed from here. */
    take(sessionId) {
      const key = String(sessionId || '');
      const items = bySession.get(key) || [];
      bySession.delete(key);
      return items;
    },
    peek: (sessionId) => [...(bySession.get(String(sessionId || '')) || [])],
    size: () => bySession.size,
  };
}

/**
 * What the main panel says, once, about such a prompt: which one, for which
 * sub-agent, and where it is now.
 */
export function unsentSubagentNotice({ item, label = '', error = '' } = {}) {
  const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
  const excerpt = !text ? '(attachments)' : (text.length > 60 ? `“${text.slice(0, 60)}…”` : `“${text}”`);
  const files = (item?.images?.length || 0) + (item?.paths?.length || 0);
  const what = `${excerpt}${item?.command?.command ? ' (command)' : ''}${files ? ` with ${files} attachment${files === 1 ? '' : 's'}` : ''}`;
  const who = label ? `the sub-agent “${label}”` : 'a sub-agent';
  const why = error ? ` (${String(error)})` : '';
  return `Not sent: ${what} was on its way to ${who} when its panel went away, and the send failed${why}. It is kept for that sub-agent: open its panel again (“Open sub-agent” on its task card) and it is back in the compose box. Reloading the page drops it.`;
}

// ── Whose sub-agent it is ───────────────────────────────────────────────────

/**
 * A session and everything above it, nearest first: [sessionId, its parent,
 * that one's parent, …], as far as `parentOf` (child → parent) knows.
 */
export function lineageOf(sessionId, parentOf) {
  const out = [];
  let cursor = String(sessionId || '');
  while (cursor && out.length <= SUBAGENT_MAX_DEPTH && !out.includes(cursor)) {
    out.push(cursor);
    cursor = String(parentOf?.get?.(cursor) || '');
  }
  return out;
}

/**
 * The entries that are `sessionId` or below it, at any depth: by the chain of
 * parents each panel was made with (`entry.chain`) and by the links known
 * now. What goes when a session becomes an automation's.
 */
export function entriesUnder(entries, sessionId, parentOf) {
  const id = String(sessionId || '');
  if (!id) return [];
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry.sessionId === id
    || (entry.chain || []).includes(id)
    || lineageOf(entry.sessionId, parentOf).includes(id));
}

export const CLOSED_SUBAGENTS_MAX = 1000;

/**
 * The sub-agents whose panel the user closed. A closed sub-agent stays closed:
 * no event, scan or reload brings its pill back, only "Open sub-agent" on its
 * task card (`reopen`). Kept as { childSessionId: rootSessionId } so that
 * everything of a parent session goes when that session is deleted.
 *   load()         → the stored object (or nothing)
 *   save(entries)  ← the object to store
 * The newest `max` closes are remembered.
 */
export function createClosedSubagents({ load = () => null, save = () => {}, max = CLOSED_SUBAGENTS_MAX } = {}) {
  let entries = new Map();
  try {
    const stored = load();
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [child, root] of Object.entries(stored)) { if (child) entries.set(child, String(root || '')); }
    }
  } catch { entries = new Map(); }
  const persist = () => { try { save(Object.fromEntries(entries)); } catch { /* remembered for this page only */ } };
  return {
    isClosed: (childSessionId) => entries.has(String(childSessionId || '')),
    close(childSessionId, rootSessionId = '') {
      const child = String(childSessionId || '');
      if (!child) return;
      entries.delete(child);
      entries.set(child, String(rootSessionId || ''));
      while (entries.size > max) entries.delete(entries.keys().next().value);
      persist();
    },
    reopen(childSessionId) { if (entries.delete(String(childSessionId || ''))) persist(); },
    forget(childSessionId) { if (entries.delete(String(childSessionId || ''))) persist(); },
    forgetRoot(rootSessionId) {
      const root = String(rootSessionId || '');
      let changed = false;
      for (const [child, owner] of [...entries]) { if (owner === root) { entries.delete(child); changed = true; } }
      if (changed) persist();
    },
  };
}

// ── The reload ──────────────────────────────────────────────────────────────

/**
 * Which sub-agent panel is the OpenCode panel on screen, remembered so that it
 * is on screen again after a page reload.
 *   note(view)   `{ rootSessionId, sessionId }` while a sub-agent panel is on
 *                screen, null while the main panel or none is
 *   restoreFor(rootSessionId, { mainVisible, ready })
 *                the sub-agent that was on screen before the reload, once per
 *                page load, or ''. It is handed out when the user has the
 *                main panel on screen (`mainVisible`: nothing opens by itself,
 *                also not when an automation booted the panel) on the session
 *                it belonged to, and that session's children were read
 *                (`ready`). Until both hold it waits; the main panel on
 *                another session, or a panel the user chose meanwhile, ends it.
 * While the restore waits, "the main panel is on screen" is not stored:
 * opening OpenCode after the reload is how the restore begins.
 */
export function createShownSubagent({ load = () => null, save = () => {} } = {}) {
  const valid = (view) => (view && view.rootSessionId && view.sessionId
    ? { rootSessionId: String(view.rootSessionId), sessionId: String(view.sessionId) } : null);
  let pending = null;
  try { pending = valid(load()); } catch { pending = null; }
  const persist = (view) => { try { save(view); } catch { /* not remembered */ } };
  return {
    note(view) {
      const shown = valid(view);
      if (shown) { pending = null; persist(shown); return; }
      if (!pending) persist(null);
    },
    restoreFor(rootSessionId, { mainVisible = true, ready = true } = {}) {
      const was = pending;
      if (!was || !mainVisible) return '';
      if (was.rootSessionId !== String(rootSessionId || '')) { pending = null; return ''; }
      if (!ready) return '';
      pending = null;
      return was.sessionId;
    },
  };
}

/**
 * Runs at most `max` of the given jobs at a time, in the order they were
 * handed in. Rebuilding the pills of a session with many sub-agents reads each
 * one's transcript; this keeps that from being one burst of requests.
 */
export function createLimiter(max = 4) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active += 1;
    const { job, resolve, reject } = waiting.shift();
    Promise.resolve().then(job).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (job) => new Promise((resolve, reject) => { waiting.push({ job, resolve, reject }); next(); });
}
