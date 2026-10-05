// ── The composer while a Compact is under way (DOM-free) ──
// A turn the user sent shows as running: a prompt sent meanwhile waits in the
// queue, and Compact is refused. A Compact the user started is a turn too, but
// one the tab does not show as running: until it ends, a second Compact does
// nothing and a prompt waits in the same queue, instead of both reaching a
// session that is still switching to the compacted conversation.
// The tab notes when it sent a Compact (`_compactSentAt`); the note is dropped
// when the turn ends (done, stopped, error), when the socket closes and when the
// tab starts another conversation. Should none of those ever come, the hold
// lapses once the session has been silent for as long as the panel waits on a
// running turn that says nothing.
// A hold that ends with its turn's `done` or `aborted` has the queue advanced by
// that message. Every other end goes through compactQueue() below, so a prompt
// queued behind a Compact is either sent or stopped where the user sees it.

export const COMPACT_HOLD_MS = 10 * 60 * 1000;
// How long a turn end waits for the `done` that advances the queue before the queue is moved without it.
export const COMPACT_SETTLE_MS = 3000;

/** True while a Compact the user started holds the composer of a tab that is not running a turn. */
export function compactHolds(tab, now = Date.now()) {
  if (!tab || tab.running) return false;
  const sentAt = Number(tab._compactSentAt) || 0;
  if (!sentAt) return false;
  const heardAt = Math.max(sentAt, Number(tab._lastWsActivity) || 0);
  return now - heardAt < COMPACT_HOLD_MS;
}

/** Milliseconds until a hold nothing ends lapses; 0 when nothing is held. */
export function compactHoldLeft(tab, now = Date.now()) {
  if (!compactHolds(tab, now)) return 0;
  const heardAt = Math.max(Number(tab._compactSentAt) || 0, Number(tab._lastWsActivity) || 0);
  return heardAt + COMPACT_HOLD_MS - now;
}

/** `/compact`, with or without arguments: what the slash router runs as Compact. */
export function isCompactCommand(text) {
  return /^\/compact(\s|$)/i.test(String(text || '').trim());
}

// ── Whose a queued prompt is ──
// A tab holds one conversation at a time, and the page can move it to another
// (New chat, a session picked from the menu). `tab.conversation` names the one
// it holds: a new value each time the page moves the tab, the same value while
// the session only changes its id (its first start, a resume, a reattach, a
// reset). A queued prompt keeps the value it was typed under and is sent only
// while the tab still has that value: after a move it stays in the tray, marked
// as not sent.

export function newConversation() {
  return globalThis.crypto.randomUUID();
}

/** True when the prompt was typed for the conversation the tab holds now. */
export function ownsQueued(tab, item) {
  return !!tab && !!item && item.conversation === tab.conversation;
}

/** Index of the prompt the queue sends next: the first one typed for this conversation. -1: none. */
export function nextQueued(tab) {
  return (tab?.queue || []).findIndex((item) => ownsQueued(tab, item));
}

/** A queue read from storage: a prompt saved before prompts carried a conversation is the tab's own. */
export function restoredQueue(tab, queue) {
  return (Array.isArray(queue) ? queue : []).filter(Boolean).map((item) => (item.conversation ? item : { ...item, conversation: tab.conversation }));
}

/** Why a prompt taken off the queue is not sent after all: '' (send it), 'conversation' or 'closed'. */
export function queuedRefusal(tab, item, { connected }) {
  if (!ownsQueued(tab, item)) return 'conversation';
  if (!connected) return 'closed';
  return '';
}

export const QUEUED_REFUSAL_LINES = {
  conversation: 'A queued prompt was typed for another conversation and was not sent here. It stays in the queue, marked.',
  closed: 'Not connected: the queued prompt was not sent. Resume the queue when the session is back.',
};

// ── The queue when a Compact ends without the `done` that advances it ──

/**
 * What happens to the prompts queued behind a Compact.
 * `how`: 'lapsed' (the session stayed silent), 'ended' (its turn ended and no
 * `done` followed), 'failed' (it ended with an error), 'closed' (the socket
 * closed under it), 'reattached' (the reconnect found the session), 'lost' (it
 * did not).
 * Returns `action`: 'send' (the next prompt goes out), 'reconnect' (they wait
 * for the reconnect's answer), 'stop' (the queue is paused; Resume sends them)
 * or 'none' (nothing of this conversation waits, the user paused the queue, or
 * a running turn's end advances it), and `line`: what the transcript says.
 */
export function queueAfterCompact(tab, { how, connected }) {
  const n = (tab?.queue || []).filter((item) => ownsQueued(tab, item)).length;
  if (!n || tab.queuePaused) return { action: 'none', line: '' };
  const prompts = n === 1 ? '1 queued prompt' : `${n} queued prompts`;
  const kept = `${prompts} ${n === 1 ? 'was' : 'were'} not sent: resume the queue to send ${n === 1 ? 'it' : 'them'}.`;
  if (how === 'failed') return { action: 'stop', line: `The Compact ended with an error. ${kept}` };
  if (how === 'lost') return { action: 'stop', line: `The session did not come back after the disconnect, so the Compact may not have finished. ${kept}` };
  if (how === 'closed' || !connected) return { action: 'reconnect', line: `Connection lost during the Compact. ${prompts} will be sent when the session is back.` };
  if (tab.running) return { action: 'none', line: '' };
  const going = `Sending the queued prompt${n === 1 ? '' : 's'}.`;
  if (how === 'lapsed') return { action: 'send', line: `The Compact did not report back. ${going}` };
  if (how === 'reattached') return { action: 'send', line: `Reconnected. ${going}` };
  return { action: 'send', line: '' };
}

/**
 * The same, carried out. `io` is the panel's side: `connected(tab)`,
 * `advance(tab)` (advanceQueue), `stop(tab)` (pause the queue and show it),
 * `say(tab, line)` (a status line) and `unlabel(tab)` (the "compacting" label off).
 * `tab._queueWaits` is 'compact' while prompts wait behind a hold, 'session'
 * while they wait for a reconnect to say whether the session is still there.
 */
export function compactQueue(io) {
  const after = (tab, how) => {
    clearTimeout(tab._compactTimer);
    tab._compactTimer = null;
    const { action, line } = queueAfterCompact(tab, { how, connected: !!io.connected(tab) });
    tab._queueWaits = action === 'reconnect' ? 'session' : '';
    if (line) io.say(tab, line);
    if (action === 'stop') io.stop(tab);
    else if (action === 'send') io.advance(tab);
  };
  // Prompts wait behind a hold: should the session stay silent until it lapses, the queue is moved then.
  const watch = (tab) => {
    if (!tab.queue?.length || !compactHolds(tab)) return;
    tab._queueWaits = 'compact';
    if (tab._compactTimer) return;
    tab._compactTimer = setTimeout(() => {
      tab._compactTimer = null;
      if (tab.closed || tab._queueWaits !== 'compact') return;
      if (compactHolds(tab)) { watch(tab); return; } // the session spoke meanwhile: still held
      if (tab.running) return; // a turn started by itself: its end comes through ended()
      tab._compactSentAt = 0;
      io.unlabel(tab);
      after(tab, 'lapsed');
    }, compactHoldLeft(tab));
  };
  // A turn ended (finishTab). Its `done` or `aborted` advances the queue and an
  // `error` stops it; should none of them follow, the queue is moved from here.
  const ended = (tab) => {
    if (tab._queueWaits !== 'compact') return;
    clearTimeout(tab._compactTimer);
    tab._compactTimer = setTimeout(() => {
      tab._compactTimer = null;
      if (tab.closed || tab._queueWaits !== 'compact') return;
      after(tab, 'ended');
    }, COMPACT_SETTLE_MS);
  };
  // The tab moved to another conversation: nothing of the old one is waited on.
  const drop = (tab) => {
    clearTimeout(tab._compactTimer);
    tab._compactTimer = null;
    tab._queueWaits = '';
  };
  return { after, watch, ended, drop };
}
