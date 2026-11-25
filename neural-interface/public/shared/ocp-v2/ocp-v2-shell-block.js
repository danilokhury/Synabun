// ─────────────────────────────────────────────────────────────────────────────
// A terminal block: what a shell command printed, drawn as it is read
//
// The block of the OpenCode side panel's bash card (ocp-v2-shell.js) and of the
// Assistant panel's shell calls (assistant/asst-shell.js). No socket, no store
// of its own: the caller says how to read the command's state, how to hear of a
// change and how to ask for the whole output, and gives the class names and the
// words of its own panel. The block updates itself in place (appended text,
// never a rebuilt card), so a long test run costs one text append per page and
// the reader's place in it is kept. Everything a command printed goes in as
// text, never as markup.
// ─────────────────────────────────────────────────────────────────────────────

const NEAR_BOTTOM_PX = 24;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * createTerminalBlock({ shellId, read, subscribe, loadAll, place, classes, words, showEvent })
 *   read()            → { view, shell }: the output as far as it was read (ocp-v2-shell-logic.js
 *                       createShellFollower's view) and the command ({ status, … }); either may be null
 *   subscribe(draw)   → unsubscribe; `draw` is called when that command or its output changed
 *   loadAll()         ask for the whole output, from its first byte
 *   place             { follow, top }: where the reader left the block (kept by the caller, so a block built
 *                     again for the same command opens at the same place)
 *   classes           { wrap, note, noteText, load, out, foot, state, jump, copy }
 *   words             { load, loading, jump, copy, copied, label, noOutputYet, noOutput, reading, running,
 *                       note(view) → the line above the output when it does not show everything ('' when it does) }
 *   showEvent         the event the caller dispatches on the block when it gets a size (a card opened by hand)
 * It follows the output while the reader is at its end, and leaves the reader alone once they scrolled up.
 */
export function createTerminalBlock({ shellId, read, subscribe, loadAll, place = { follow: true, top: 0 }, classes, words, showEvent = 'shell-term-show' }) {
  const wrap = el('div', classes.wrap);
  wrap.dataset.shellId = shellId;

  const note = el('div', classes.note);
  const noteText = el('span', classes.noteText);
  const loadButton = el('button', classes.load, words.load);
  loadButton.type = 'button';
  note.append(noteText, loadButton);
  note.hidden = true;

  const out = el('pre', classes.out);
  out.tabIndex = 0;
  out.setAttribute('role', 'log');
  out.setAttribute('aria-label', words.label);
  // A screen reader is not read every line of a test run; the card's status says when it ends.
  out.setAttribute('aria-live', 'off');
  const textNode = document.createTextNode('');
  out.appendChild(textNode);

  const foot = el('div', classes.foot);
  const state = el('span', classes.state);
  const jump = el('button', classes.jump, words.jump);
  jump.type = 'button';
  jump.hidden = true;
  const copy = el('button', classes.copy, words.copy);
  copy.type = 'button';
  foot.append(state, jump, copy);
  wrap.append(note, out, foot);

  let shownFrom = -1;
  let shownLength = 0;
  let drawn = false;
  let toTop = false;   // the whole output was asked for: its first page opens at the top

  const atEnd = () => out.scrollHeight - out.scrollTop - out.clientHeight < NEAR_BOTTOM_PX;
  out.addEventListener('scroll', () => {
    place.follow = atEnd();
    place.top = out.scrollTop;
    jump.hidden = place.follow;
  });
  jump.addEventListener('click', (event) => {
    event.stopPropagation();
    place.follow = true;
    out.scrollTop = out.scrollHeight;
    jump.hidden = true;
  });
  loadButton.addEventListener('click', (event) => {
    event.stopPropagation();
    loadButton.disabled = true;
    loadButton.textContent = words.loading;
    // The whole output is read from its start: the reader starts at its top.
    place.follow = false;
    place.top = 0;
    toTop = true;
    loadAll();
  });
  copy.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(textNode.data);
      copy.textContent = words.copied;
      setTimeout(() => { if (copy.isConnected) copy.textContent = words.copy; }, 1200);
    } catch { /* clipboard unavailable */ }
  });

  function draw() {
    const current = read() || {};
    const view = current.view || null;
    const running = current.shell?.status === 'running';
    const text = view?.text || '';
    const from = view ? view.from : 0;
    // Appended when the kept text only grew; set anew when its start moved (a long output's window, the full output).
    // A carriage return rewrites the line it is on and never one before it, so of what is shown only its last line
    // can have changed: compared, and replaced when it did (review S6: a progress line of the same width or longer
    // kept showing, and copying, its first state).
    if (drawn && from === shownFrom && textNode.data.length === shownLength) {
      const stable = textNode.data.lastIndexOf('\n') + 1;
      if (text.length >= shownLength && text.slice(stable, shownLength) === textNode.data.slice(stable)) {
        if (text.length > shownLength) textNode.appendData(text.slice(shownLength));
      } else if (text.slice(0, stable) === textNode.data.slice(0, stable)) {
        textNode.replaceData(stable, shownLength - stable, text.slice(stable));
      } else {
        textNode.data = text;
      }
    } else if (!drawn || from !== shownFrom || text.length !== shownLength) {
      textNode.data = text;
      if (toTop && view?.full) { toTop = false; out.scrollTop = 0; }
    }
    shownFrom = from;
    shownLength = text.length;

    const noteWords = words.note(view);
    note.hidden = !noteWords;
    noteText.textContent = noteWords;
    const canLoad = !!view && view.partial && !view.full && !view.gone;
    loadButton.hidden = !canLoad;
    if (canLoad) { loadButton.disabled = false; loadButton.textContent = words.load; }

    wrap.dataset.running = running ? 'true' : 'false';
    state.textContent = view?.error && !view.done ? view.error
      : !text && running ? words.noOutputYet
      : !text && view && (view.done || view.gone) ? words.noOutput
      : !text ? words.reading
      : running ? words.running : '';
    copy.hidden = !text;
    out.hidden = !text;

    if (!drawn) {
      drawn = true;
      out.scrollTop = place.follow ? out.scrollHeight : place.top;
    } else if (place.follow) {
      out.scrollTop = out.scrollHeight;
    }
    jump.hidden = place.follow || !text;
  }

  const unsubscribe = subscribe(() => {
    if (!wrap.isConnected) { unsubscribe(); return; }
    draw();
  });
  draw();
  // The block is measured once it is in the page (a card built open, or opened later).
  const settle = () => { if (wrap.isConnected) out.scrollTop = place.follow ? out.scrollHeight : place.top; };
  globalThis.requestAnimationFrame?.(settle);
  // A card opened by hand shows its block for the first time: it has a height only now.
  wrap.addEventListener(showEvent, settle);
  return wrap;
}
