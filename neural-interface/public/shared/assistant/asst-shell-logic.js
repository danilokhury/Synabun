// ─────────────────────────────────────────────────────────────────────────────
// SynaBun Assistant — the shell commands of an OpenCode brain (no DOM, no socket)
//
// The runtime tells a panel which commands the brain's tool calls started and how
// they ended (`assistant:shell`, `assistant:shells`). What a command printed is
// never in those packets: it is read in pages over REST, only while a terminal
// block shows that command, by the same follower and terminal buffer as the
// OpenCode side panel (ocp-v2-shell-logic.js). Everything here is display data:
// nothing of it goes to the model, the transcript, a memory or a meter.
// ─────────────────────────────────────────────────────────────────────────────

import { createShellFollower, formatBytes, shellCardState } from '../ocp-v2/ocp-v2-shell-logic.js';

/** How many finished commands keep their read output once no block shows them (the next look reads it again). */
export const SHELL_KEPT_FINISHED = 12;

const GONE_VIEW = Object.freeze({ text: '', from: 0, size: 0, done: true, gone: true, error: '', full: false, capped: false, partial: false });

/**
 * createShellTracker({ read })
 *   read({ shellId, cursor, tail, limit }) → { status, data: { output, cursor, size, from } } or { ok: false, status, error }
 * apply / applyList take what the runtime says; open(id) + subscribe(id, fn) follow one command for as long as a
 * block shows it; onChange(fn) hears that a command's state changed.
 */
export function createShellTracker({ read, setTimer, clearTimer, kept = SHELL_KEPT_FINISHED } = {}) {
  const shells = new Map();    // shellId → the runtime's view of it
  const byCall = new Map();    // the tool call's id → shellId
  const entries = new Map();   // shellId → { follower, view, usedAt }
  const listeners = new Map(); // shellId → Set of what draws it
  const places = new Map();    // shellId → { follow, top }: where the reader left its block
  const changes = new Set();
  let clock = 0;
  let destroyed = false;

  const tell = (shellId) => {
    for (const fn of [...(listeners.get(shellId) || [])]) { try { fn(); } catch (err) { console.warn('[asst-shell] draw failed', err); } }
  };
  const changed = (shell) => {
    for (const fn of [...changes]) { try { fn(shell); } catch (err) { console.warn('[asst-shell] update failed', err); } }
  };

  // Stop removes a command from OpenCode, so its next read is a 404. What was read up to then is what it printed
  // before it was stopped: nothing to apologise for, unless the start of a long output is out of reach.
  const settledView = (shellId, view) => (view.gone && view.text && !view.partial && shells.get(shellId)?.status === 'killed'
    ? { ...view, gone: false, done: true }
    : view);

  function dropEntry(shellId) {
    entries.get(shellId)?.follower?.stop();
    entries.delete(shellId);
  }

  /** Finished commands nobody looks at keep their text up to `kept`; the oldest goes first. */
  function evict() {
    const idle = [...entries].filter(([id]) => !listeners.get(id)?.size).sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (idle.length > kept) {
      const [id] = idle.shift();
      dropEntry(id);
      places.delete(id);
    }
  }

  function apply(shell) {
    if (destroyed || !shell?.id) return;
    const known = shells.get(shell.id);
    // Named again after it was lost (a brain that came back to its serve): it is read afresh.
    if (known?.lost) dropEntry(shell.id);
    shells.set(shell.id, shell);
    if (shell.callID) byCall.set(shell.callID, shell.id);
    if (shell.status !== 'running') entries.get(shell.id)?.follower?.poke();
    tell(shell.id);
    changed(shell);
  }

  /** The brain no longer has this command (it was replaced, or its serve ended). What was read stays on screen. */
  function lose(shellId) {
    const shell = shells.get(shellId);
    if (!shell || shell.lost) return;
    const next = { ...shell, lost: true, status: shell.status === 'running' ? 'killed' : shell.status };
    shells.set(shellId, next);
    const entry = entries.get(shellId);
    if (entry) {
      entry.follower?.stop();
      entry.follower = null;
      const view = entry.view;
      // Read to its end, the text on screen is the whole output: nothing is missing from it.
      if (!view) entry.view = { ...GONE_VIEW };
      else if (!view.done || view.partial) entry.view = { ...view, done: true, gone: true };
    }
    tell(shellId);
    changed(next);
  }

  /** The whole list as the runtime knows it now: a command it no longer names is gone. */
  function applyList(list) {
    if (destroyed) return;
    const named = new Set();
    for (const shell of Array.isArray(list) ? list : []) {
      if (!shell?.id) continue;
      named.add(shell.id);
      apply(shell);
    }
    for (const id of [...shells.keys()]) if (!named.has(id)) lose(id);
  }

  /** Start reading a command for a block that shows it. */
  function open(shellId) {
    if (destroyed || !shells.has(shellId)) return;
    let entry = entries.get(shellId);
    if (!entry) {
      entry = { follower: null, view: null, usedAt: 0 };
      entries.set(shellId, entry);
      if (shells.get(shellId).lost) entry.view = { ...GONE_VIEW };
      else {
        const mine = entry;
        const options = {
          api: { shellOutput: ({ shellId: id, cursor, tail, limit }) => read({ shellId: id, cursor, tail, limit }) },
          sessionId: 'assistant', shellId,
          isRunning: () => shells.get(shellId)?.status === 'running',
          onUpdate: (view) => { if (entries.get(shellId) === mine) { mine.view = settledView(shellId, view); tell(shellId); } },
        };
        if (setTimer) options.setTimer = setTimer;
        if (clearTimer) options.clearTimer = clearTimer;
        entry.follower = createShellFollower(options);
        entry.follower.start();
      }
    }
    entry.usedAt = ++clock;
    evict();
  }

  function subscribe(shellId, fn) {
    let set = listeners.get(shellId);
    if (!set) { set = new Set(); listeners.set(shellId, set); }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size) return;
      listeners.delete(shellId);
      // Nobody looks: nothing is polled. A command that ended and was read keeps its text for the next look.
      const entry = entries.get(shellId);
      if (entry?.follower && !entry.follower.isDone()) dropEntry(shellId);
      evict();
    };
  }

  return {
    apply,
    applyList,
    open,
    subscribe,
    loadAll(shellId) { entries.get(shellId)?.follower?.loadAll(); },
    forCall: (callId) => shells.get(byCall.get(callId)) || null,
    shell: (shellId) => shells.get(shellId) || null,
    view: (shellId) => entries.get(shellId)?.view || null,
    placeOf(shellId) {
      let place = places.get(shellId);
      if (!place) { place = { follow: true, top: 0 }; places.set(shellId, place); }
      return place;
    },
    onChange(fn) { changes.add(fn); return () => changes.delete(fn); },
    /** For tests: which commands are being read now. */
    reading: () => [...entries].filter(([, entry]) => entry.follower && !entry.follower.isDone()).map(([id]) => id),
    destroy() {
      destroyed = true;
      for (const id of [...entries.keys()]) dropEntry(id);
      listeners.clear();
      changes.clear();
    },
  };
}

/** The word on a call's row for its command ('' when the call's own state says it). */
export function shellStateLabel(shell, t) {
  if (!shell) return '';
  if (shell.status === 'running') {
    return shell.background ? t('assistant.rack.shell.background', 'in the background') : t('assistant.rack.shell.running', 'running');
  }
  if (shell.status === 'killed') return t('assistant.rack.shell.stopped', 'stopped');
  if (shell.status === 'timeout') return t('assistant.rack.shell.timedOut', 'timed out');
  if (typeof shell.exit === 'number') return t('assistant.rack.shell.exit', 'exit {code}', { code: shell.exit });
  return '';
}

/** A command the model no longer waits for failed after its tool call had already answered. */
export function shellFailedLate(shell) {
  return shellCardState(shell).status === 'error';
}

/** The line above a terminal block when it does not show everything: '' when it does. */
export function shellNoteText(view, t) {
  if (!view) return '';
  if (view.gone) return t('assistant.rack.shell.gone', 'OpenCode no longer keeps the output of this command.');
  const shown = formatBytes(view.text.length);
  const size = formatBytes(view.size);
  if (view.capped) return t('assistant.rack.shell.capped', 'Showing the last {shown} of {size}: the whole output is too long to show here.', { shown, size });
  if (view.partial) return t('assistant.rack.shell.partial', 'Showing the last {shown} of {size}.', { shown, size });
  return '';
}

