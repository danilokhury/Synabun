// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — a tool card's terminal block
// What a shell command printed, live: stdout and stderr in the order written,
// read by ocp-v2-shell-logic.js into the store (shellOutput) and drawn here.
// The block updates itself in place (appended text, never a rebuilt card), so
// a long test run costs one text append per page and the reader's place in it
// is kept. Everything a command printed goes in as text, never as markup.
// ─────────────────────────────────────────────────────────────────────────────

import { api, supports } from './ocp-v2-ws.js';
import { followShells, shellOutputNote } from './ocp-v2-shell-logic.js';
import { createTerminalBlock } from './ocp-v2-shell-block.js';

// One set of followers per store (the primary panel and every sub-agent panel), for as long as a renderer of that
// store is mounted (review S5: they used to outlive every view, polling a session nobody showed any more).
const _followers = new WeakMap();
const _holders = new WeakMap();   // store → how many mounted renderers hold its followers
// Where the reader left each block: { follow, top }. A card is built again
// when its command ends; the block that replaces it opens at the same place.
const _places = new Map();

/** Follow the commands of `store`'s session (idempotent per store). */
export function ensureShellFollowing(store) {
  let following = _followers.get(store);
  if (!following) {
    following = followShells(store, api, { supported: () => supports('shell:output') });
    _followers.set(store, following);
  }
  return following;
}

/**
 * A renderer of `store` is mounted: its commands are followed until every renderer that holds them released them
 * (the last unmount stops the followers and lets their text go).
 */
export function retainShellFollowing(store) {
  ensureShellFollowing(store);
  _holders.set(store, (_holders.get(store) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (_holders.get(store) || 1) - 1;
    if (left > 0) { _holders.set(store, left); return; }
    _holders.delete(store);
    const following = _followers.get(store);
    _followers.delete(store);
    following?.stop();
  };
}

/** Whether the server can be asked for a command's output (an older one cannot). */
export function shellOutputSupported() {
  return supports('shell:output');
}

/**
 * The terminal block of `shellId`: a note when not everything is shown, the
 * output, and its actions (ocp-v2-shell-block.js). It follows the output while
 * the reader is at its end, and leaves the reader alone once they scrolled up.
 */
export function renderShellTerminal(store, shellId) {
  const following = ensureShellFollowing(store);
  const place = _places.get(shellId) || { follow: true, top: 0 };
  _places.set(shellId, place);
  return createTerminalBlock({
    shellId,
    place,
    showEvent: 'ocpv2-term-show',
    read: () => {
      const s = store.getState();
      return { view: s.shellOutput.get(shellId) || null, shell: s.shells.get(shellId) || null };
    },
    // While the block is on screen its command's text is kept (and read again if it was let go).
    subscribe: (draw) => {
      const off = store.subscribe((event) => {
        if (event?.type === 'shell:output' ? event.shellId === shellId : event?.type === 'shell:update') draw();
      });
      const release = following.watch ? following.watch(shellId) : () => {};
      return () => { try { off(); } finally { release(); } };
    },
    loadAll: () => following.loadAll(shellId),
    classes: {
      wrap: 'ocpv2-term',
      note: 'ocpv2-term-note',
      noteText: 'ocpv2-term-note-text',
      load: 'ocpv2-tc-more ocpv2-term-load',
      out: 'ocpv2-tool-output ocpv2-term-out',
      foot: 'ocpv2-term-foot',
      state: 'ocpv2-term-state',
      jump: 'ocpv2-tc-more ocpv2-term-jump',
      copy: 'ocpv2-msg-action ocpv2-term-copy',
    },
    words: {
      load: 'Load full output',
      loading: 'Loading…',
      jump: 'Jump to latest',
      copy: 'Copy output',
      copied: 'Copied',
      label: 'Command output',
      noOutputYet: 'No output yet',
      noOutput: 'No output',
      reading: 'Reading the output…',
      running: 'Running',
      note: shellOutputNote,
    },
  });
}
