// ═══════════════════════════════════════════
// SynaBun Neural Interface — put new markup on screen without replacing what did not change
// ═══════════════════════════════════════════
// Two side panels drew a stream by writing innerHTML: Antigravity the whole transcript on every frame,
// Codex the whole message on every tick. Every element was made again, styled, laid out and painted, and
// whatever the page knew about the old ones was lost (a text selection, a fold the user opened, a hover).
// What they draw is still decided exactly as before, as markup; these two helpers only decide which nodes
// have to change for the page to show it.
//
//   createKeyedHtmlList(box)       a list of keyed pieces of markup (a transcript's rows): a piece whose
//                                  markup is what it was keeps its nodes.
//   morphChildren(target, source)  one element's children against a freshly built copy (a message being
//                                  written): the leading children that are equal stay, the rest is replaced.
//
// The result is node for node what innerHTML would have given. tests/dom-morph.test.mjs.

function defaultParse(html, doc) {
  const template = doc.createElement('template');
  template.innerHTML = html;
  return [...template.content.childNodes];
}

/**
 * A container whose children are the nodes of keyed pieces of markup, in order.
 *
 * `patch(pieces)` takes `[{ key, html }]` and makes the container hold exactly their nodes, in that order:
 * a piece whose `html` is unchanged keeps its nodes (and their state), a changed or new one is parsed, one
 * that is no longer listed is removed, and anything else found in the container goes too, as it would with
 * innerHTML. It returns the keys it built. Keys must be unique; a repeated key makes the whole list be built
 * again, which is always correct.
 *
 * `forget()`: the container was written some other way; nothing in it is known any more.
 */
export function createKeyedHtmlList(box, { doc = box?.ownerDocument || globalThis.document, parse = (html) => defaultParse(html, doc) } = {}) {
  /** @type {Map<string, { html: string, nodes: Node[] }>} */
  let known = new Map();

  function patch(pieces) {
    const list = [];
    const seen = new Set();
    let repeated = false;
    for (const piece of pieces || []) {
      if (!piece || !piece.html) continue;
      const key = String(piece.key);
      if (seen.has(key)) repeated = true;
      seen.add(key);
      list.push({ key, html: String(piece.html) });
    }
    if (repeated) known = new Map();

    const next = new Map();
    const built = new Set();
    for (const piece of list) {
      const had = known.get(piece.key);
      // Kept only when its nodes are still where they were put: something else may have taken them out.
      const intact = had && had.html === piece.html && had.nodes.every((node) => node.parentNode === box);
      if (intact && !next.has(piece.key)) {
        next.set(piece.key, had);
      } else {
        next.set(repeated ? `${piece.key}\u0000${next.size}` : piece.key, { html: piece.html, nodes: parse(piece.html) });
        built.add(piece.key);
      }
    }

    // What stays, in order; everything else in the container leaves.
    const wanted = [];
    for (const entry of next.values()) for (const node of entry.nodes) wanted.push(node);
    const keep = new Set(wanted);
    for (let node = box.firstChild; node;) {
      const after = node.nextSibling;
      if (!keep.has(node)) box.removeChild(node);
      node = after;
    }
    let cursor = box.firstChild;
    for (const node of wanted) {
      if (node === cursor) cursor = cursor.nextSibling;
      else box.insertBefore(node, cursor);
    }
    known = repeated ? new Map() : next;
    return { built, kept: list.length - built.size };
  }

  return {
    patch,
    forget() { known = new Map(); },
    size: () => known.size,
  };
}

/**
 * Make `target`'s children those of `source`, keeping the leading children that are already equal.
 *
 * `source` is a freshly built copy of what `target` should hold (same markup, same post-processing). The
 * children of `target` that equal `source`'s, counted from the start, stay as they are; from the first
 * difference on, `target`'s are removed and `source`'s are moved in. A stream only ever changes the end of
 * a message, so one tick replaces the paragraph being written and nothing before it.
 *
 * @returns {{ kept: number, removed: number, added: number }}
 */
export function morphChildren(target, source, { equal = (a, b) => a.isEqualNode(b) } = {}) {
  let kept = 0;
  let live = target.firstChild;
  let fresh = source.firstChild;
  while (live && fresh && equal(live, fresh)) {
    kept += 1;
    live = live.nextSibling;
    fresh = fresh.nextSibling;
  }
  let removed = 0;
  while (live) {
    const after = live.nextSibling;
    target.removeChild(live);
    removed += 1;
    live = after;
  }
  let added = 0;
  while (fresh) {
    const after = fresh.nextSibling;
    target.appendChild(fresh); // moved out of `source`
    added += 1;
    fresh = after;
  }
  return { kept, removed, added };
}
