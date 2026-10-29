// ═══════════════════════════════════════════
// SynaBun Assistant — the open card at the bottom of the transcript
// ═══════════════════════════════════════════
// A card that waits on the user (a follow-ups set, a question, a clarify, a route) must not be
// buried by what streams in after it: while it is open it is drawn in a slot under every other
// row (still above the "Working…" row), and rows appended meanwhile go above it. Once answered,
// dismissed or expired it goes back where it belongs: a follow-ups card under its message, a
// control or route card in the transcript. Cards are moved, never redrawn, so the picks, the
// typed answer, focus and the mascot's rig survive the move; a home row that was pruned (or a
// cleared transcript) takes its card with it.
//
// createAskTail(container, { anchor: () => node | null, slotClass? })
//   → { pin(handle), sync(), insert(node), clear() }
// `handle`: { el, isOpen() → bool } (asst-render.js adds seq / onChange). `anchor` is the row
// that stays last (the "Working…" row); `insert` places a new row above the open cards, or
// above that row when none waits.

export const ASK_TAIL_CLASS = 'asst-ask-tail';

export function createAskTail(container, { anchor = () => null, slotClass = ASK_TAIL_CLASS } = {}) {
  const pinned = new Set(); // { el, isOpen, home: { parent, next } | null, at: 'slot' | 'home' | null }
  let slot = null;
  let seq = 0;

  const anchorNode = () => {
    const node = anchor();
    return node && node.parentNode === container ? node : null;
  };

  function place(node, before = null) {
    if (!node) return;
    if (before && before.parentNode === container) {
      if (node.parentNode === container && node.nextSibling === before) return; // already where it belongs
      container.insertBefore(node, before);
    } else {
      if (node.parentNode === container && node === container.lastChild) return; // already last
      container.appendChild(node);
    }
  }

  function ensureSlot() {
    if (!slot || slot.parentNode !== container) {
      slot = container.ownerDocument.createElement('div');
      slot.className = slotClass;
    }
    return slot;
  }

  /** The card back where it was: its own row (a follow-ups card), else the transcript above the open cards. */
  function restore(handle) {
    const { el, home } = handle;
    const parent = home?.parent;
    if (!parent?.isConnected) { el.remove(); return; }
    // A direct row goes back above every card that still waits, never under one: the open slot is last.
    if (parent === container) { place(el, slot?.parentNode === container ? slot : anchorNode()); return; }
    if (home.next && home.next.parentNode === parent) parent.insertBefore(el, home.next);
    else parent.appendChild(el);
  }

  /** Every open card in the slot, in the order they appeared; every closed one back home. */
  function sync() {
    for (const handle of [...pinned]) {
      if (!handle.el?.isConnected) { pinned.delete(handle); continue; }
      // Its message row was pruned (the transcript cap): the card goes with it, never waits alone.
      if (handle.at === 'slot' && handle.home?.parent && !handle.home.parent.isConnected) {
        handle.el.remove();
        pinned.delete(handle);
      }
    }
    const open = [];
    for (const handle of pinned) {
      if (handle.isOpen?.()) { open.push(handle); continue; }
      if (handle.at !== 'slot') continue;
      restore(handle);
      handle.at = 'home';
    }
    if (!open.length) {
      slot?.remove();
      slot = null;
      return;
    }
    const box = ensureSlot();
    place(box, anchorNode());
    open.sort((a, b) => a.seq - b.seq);
    const order = open.map((handle) => handle.el);
    const same = box.childNodes.length === order.length && order.every((el, i) => box.childNodes[i] === el);
    if (!same) for (const el of order) box.appendChild(el);
    for (const handle of open) handle.at = 'slot';
  }

  /** A card that waits on the user joins the bottom slot now; sync() puts it back once it closes. */
  function pin(handle) {
    if (!handle?.el) return handle;
    handle.seq ||= (seq += 1);
    if (pinned.has(handle)) { sync(); return handle; }
    handle.home = handle.el.parentNode ? { parent: handle.el.parentNode, next: handle.el.nextSibling } : null;
    handle.at = null;
    pinned.add(handle);
    sync();
    return handle;
  }

  /** A new transcript row: above the open cards (and above the "Working…" row when it is last). */
  function insert(node) {
    place(node, slot?.parentNode === container ? slot : anchorNode());
    return node;
  }

  /** Forget the cards and put them back home (a cleared transcript keeps none). */
  function clear() {
    for (const handle of pinned) if (handle.at === 'slot') restore(handle);
    pinned.clear();
    slot?.remove();
    slot = null;
  }

  return { pin, sync, insert, clear, get slot() { return slot; } };
}
