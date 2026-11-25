// ─────────────────────────────────────────────────────────────────────────────
// SynaBun Assistant — a shell call's live terminal block
//
// The block itself is the OpenCode panel's (ocp-v2-shell-block.js) in the rack's
// classes and words; the command's state and output come from the tracker
// (asst-shell-logic.js). A long test run must not cost the conversation
// anything: drawing is coalesced to one frame, and a block that is off screen or
// in a closed panel does no DOM work at all until it is seen again.
// ─────────────────────────────────────────────────────────────────────────────

import { createTerminalBlock } from '../ocp-v2/ocp-v2-shell-block.js';
import { shellNoteText } from './asst-shell-logic.js';

const SHOW_EVENT = 'asst-term-show';

const CLASSES = Object.freeze({
  wrap: 'asst-term',
  note: 'asst-term-note',
  noteText: 'asst-term-note-text',
  load: 'asst-tool-more asst-term-load',
  out: 'asst-tool-section asst-term-out',
  foot: 'asst-term-foot',
  state: 'asst-term-state',
  jump: 'asst-tool-more asst-term-jump',
  copy: 'asst-copy asst-term-copy',
});

/**
 * mountShellTerminal(tracker, shellId, { t, onDraw, onGone }) → { el, show(), dispose() }
 * `onDraw`: the block was drawn (its height may have changed); `onGone`: OpenCode no longer has this output.
 */
export function mountShellTerminal(tracker, shellId, { t, onDraw = () => {}, onGone = () => {} } = {}) {
  let drawBlock = null;
  let frame = 0;
  let dirty = false;
  let seen = true;
  let disposed = false;
  let wasGone = !!tracker.view(shellId)?.gone;
  let wrap = null;

  const flush = () => {
    frame = 0;
    if (disposed || !dirty || !seen || !wrap?.isConnected) return;
    dirty = false;
    drawBlock?.();
    onDraw();
    const gone = !!tracker.view(shellId)?.gone;
    if (gone && !wasGone) { wasGone = true; onGone(); }
  };
  const request = () => {
    dirty = true;
    if (frame || !seen) return;
    frame = requestAnimationFrame(flush);
  };

  tracker.open(shellId);
  wrap = createTerminalBlock({
    shellId,
    place: tracker.placeOf(shellId),
    showEvent: SHOW_EVENT,
    read: () => ({ view: tracker.view(shellId), shell: tracker.shell(shellId) }),
    // Told through `request` below, for as long as this mount lives (dispose ends it).
    subscribe: (draw) => {
      drawBlock = draw;
      return () => {};
    },
    loadAll: () => tracker.loadAll(shellId),
    classes: CLASSES,
    words: {
      load: t('assistant.rack.shell.loadFull', 'Load full output'),
      loading: t('assistant.rack.shell.loading', 'Loading…'),
      jump: t('assistant.rack.shell.jump', 'Jump to latest'),
      copy: t('assistant.rack.shell.copy', 'Copy output'),
      copied: t('assistant.rack.shell.copied', 'Copied'),
      label: t('assistant.rack.shell.label', 'Command output'),
      noOutputYet: t('assistant.rack.shell.noOutputYet', 'No output yet'),
      noOutput: t('assistant.rack.shell.noOutput', 'No output'),
      reading: t('assistant.rack.shell.reading', 'Reading the output…'),
      running: t('assistant.rack.shell.runningNow', 'Running'),
      note: (view) => shellNoteText(view, t),
    },
  });

  // Not tied to being in the page: a row can be out of it for a moment while it is rebuilt.
  const release = tracker.subscribe(shellId, request);
  const watcher = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      seen = entries[entries.length - 1].isIntersecting;
      if (seen && dirty && !frame) frame = requestAnimationFrame(flush);
    })
    : null;
  watcher?.observe(wrap);

  return {
    el: wrap,
    /** The block is in the page again (a body rebuilt, a row opened): it measures itself and catches up. */
    show() {
      wrap.dispatchEvent(new Event(SHOW_EVENT));
      request();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      watcher?.disconnect();
      release();
      wrap.remove();
    },
  };
}
