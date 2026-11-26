// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — a shell command's output, live (no DOM, no socket)
//
// OpenCode 2 does not send what a command prints with its tool call: it keeps
// the combined stdout and stderr, in the order written, and answers pages of it
// by byte position while the command runs and after (`shell:output`). This
// module reads those pages and keeps what the transcript shows:
//   createTerminalBuffer()   the text as a terminal would leave it, windowed
//   createShellFollower()    reads one command to its end, then stops
//   followShells()           one follower per command of a store's session
//   shellCardState()         what a command means for its tool card
// The store holds the result (shellOutput), ocp-v2-shell.js draws it.
// ─────────────────────────────────────────────────────────────────────────────

/** What the transcript keeps of one command's output until the reader asks for all of it. */
export const SHELL_WINDOW_CHARS = 256 * 1024;
/** The most "Load full output" keeps in the page; a longer output says so and names where it stops. */
export const SHELL_FULL_MAX_CHARS = 8 * 1024 * 1024;
/** How often a running command is asked for more: at once while it prints, slower while it is quiet. */
export const SHELL_POLL_MIN_MS = 400;
export const SHELL_POLL_MAX_MS = 2500;

// CSI / OSC sequences and the other escapes a test runner colours its lines with.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// A sequence the page cut in two waits for its other half.
// eslint-disable-next-line no-control-regex
const ANSI_TAIL = /\x1b(?:\[[0-9;?]*[ -/]*|\][^\x07\x1b]*)?$/;

/**
 * The text of a command as a terminal would leave it: escape sequences gone, a
 * line rewritten with a carriage return (a progress bar) kept as its last
 * form, CRLF as one line end. At most `maxChars` are kept: the oldest whole
 * lines go first, and `dropped` counts the characters that went.
 */
export function createTerminalBuffer({ maxChars = SHELL_WINDOW_CHARS } = {}) {
  let text = '';
  let dropped = 0;
  let pending = '';   // an escape sequence, or a lone "\r", still waiting for what follows
  let limit = Math.max(1024, Number(maxChars) || SHELL_WINDOW_CHARS);

  function trim() {
    if (text.length <= limit) return;
    let cut = text.length - limit;
    const lineEnd = text.indexOf('\n', cut);
    // The line that crosses the limit goes whole, unless it is the last one.
    if (lineEnd !== -1 && lineEnd < text.length - 1) cut = lineEnd + 1;
    dropped += cut;
    text = text.slice(cut);
  }

  function append(chunk) {
    let incoming = pending + String(chunk ?? '');
    pending = '';
    const tail = ANSI_TAIL.exec(incoming);
    if (tail) { pending = tail[0]; incoming = incoming.slice(0, tail.index); }
    if (incoming.endsWith('\r')) { pending = `\r${pending}`; incoming = incoming.slice(0, -1); }
    incoming = incoming.replace(ANSI, '').replace(/\r\n/g, '\n');
    if (!incoming) return;
    if (incoming.includes('\r')) {
      // A carriage return goes back to the start of the line: what follows replaces it.
      for (const piece of incoming.split(/(\r)/)) {
        if (piece === '\r') text = text.slice(0, text.lastIndexOf('\n') + 1);
        else text += piece;
      }
    } else {
      text += incoming;
    }
    trim();
  }

  return {
    append,
    text: () => text,
    /** Characters no longer kept (the start of a long output). */
    dropped: () => dropped,
    setLimit(maxChars) { limit = Math.max(1024, Number(maxChars) || limit); trim(); },
    reset() { text = ''; dropped = 0; pending = ''; },
  };
}

const replyFailed = (res) => !res || res.ok === false || (typeof res.status === 'number' && res.status >= 400);

/**
 * Reads one command's output to its end.
 *   api.shellOutput({ sessionId, shellId, cwd, cursor, tail, limit }) → { data: { output, cursor, size, from } }
 *   isRunning()   the command still runs (the store's word); once it does not,
 *                 a read that brings nothing new is the last one
 *   isCurrent()   false once the panel left the session: nothing more is read
 *   onUpdate(view)  { text, from, size, done, gone, error, full, capped } after every page
 * The first read starts `window` characters before the end (a panel that opens
 * on a long output shows its end at once); `loadAll()` reads it again from its
 * first byte. Nothing is polled once the command ended and was read to its end.
 */
export function createShellFollower({
  api, sessionId, shellId, cwd, isRunning = () => false, isCurrent = () => true, onUpdate = () => {},
  windowChars = SHELL_WINDOW_CHARS, setTimer = setTimeout, clearTimer = clearTimeout,
  // How often a running command is asked again (a caller may ask less often: the Background tasks view, 1 s).
  pollMinMs = SHELL_POLL_MIN_MS, pollMaxMs = SHELL_POLL_MAX_MS,
} = {}) {
  const POLL_MIN = Math.max(SHELL_POLL_MIN_MS, Number(pollMinMs) || SHELL_POLL_MIN_MS);
  const POLL_MAX = Math.max(POLL_MIN, Number(pollMaxMs) || SHELL_POLL_MAX_MS);
  const buffer = createTerminalBuffer({ maxChars: windowChars });
  let cursor = null;        // null: nothing read yet (the first read asks for the tail)
  let from = 0;             // the byte the kept text starts at, as far as the server said
  let size = 0;
  let timer = null;
  let reading = false;
  let stopped = false;
  let done = false;
  let gone = false;
  let error = '';
  let full = false;
  let capped = false;
  let delay = POLL_MIN;
  let failures = 0;
  let generation = 0;       // a read begun before loadAll() belongs to the reading it replaced

  const view = () => ({
    text: buffer.text(), from: from + buffer.dropped(), size, done, gone, error, full, capped,
    // Something of the output is not in `text` (its start): the reader can ask for it.
    partial: from + buffer.dropped() > 0,
  });
  const publish = () => { try { onUpdate(view()); } catch (err) { console.warn('[ocp-v2-shell] update failed', err); } };

  function schedule(ms) {
    if (stopped || done || gone) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; read(); }, ms);
  }

  async function read() {
    if (stopped || done || gone || reading) return;
    if (!isCurrent()) { stop(); return; }
    reading = true;
    const mine = generation;
    const wasRunning = isRunning();
    let res;
    try {
      res = await api.shellOutput(cursor == null
        ? { sessionId, shellId, cwd, tail: full ? undefined : windowChars, cursor: full ? 0 : undefined }
        : { sessionId, shellId, cwd, cursor });
    } catch (err) { res = { ok: false, error: err?.message || String(err) }; }
    reading = false;
    if (stopped) return;
    if (mine !== generation) { schedule(0); return; }
    if (!isCurrent()) { stop(); return; }
    if (replyFailed(res) || !res.data || typeof res.data !== 'object') {
      // OpenCode keeps a finished command's output for a while only.
      if (res?.status === 404) { gone = true; publish(); return; }
      failures += 1;
      error = (typeof res?.error === 'string' && res.error) || 'The output could not be read.';
      if (failures >= 5 && !isRunning()) { done = true; publish(); return; }
      publish();
      schedule(Math.min(POLL_MAX * 2, POLL_MIN * 2 ** failures));
      return;
    }
    failures = 0;
    error = '';
    const page = res.data;
    const text = typeof page.output === 'string' ? page.output : '';
    if (cursor == null) from = Math.max(0, Number(page.from) || 0);
    const next = Math.max(0, Number(page.cursor) || 0);
    size = Math.max(next, Number(page.size) || 0);
    const moved = cursor == null || next > cursor;
    if (text) buffer.append(text);
    cursor = next;
    if (full && buffer.dropped() > 0) capped = true;
    const behind = cursor < size;
    // Read to its end after the command stopped (as it was before this read): nothing more will come.
    if (!wasRunning && !isRunning() && !behind && !text) done = true;
    else if (!wasRunning && !isRunning() && !behind) { publish(); schedule(0); return; }
    publish();
    if (done) return;
    if (behind) { delay = POLL_MIN; schedule(0); return; }
    delay = moved && text ? POLL_MIN : Math.min(POLL_MAX, Math.round(delay * 1.5));
    schedule(isRunning() ? delay : 0);
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimer(timer); timer = null; }
  }

  return {
    start() { if (cursor == null && !reading) read(); },
    stop,
    /** The store says the command changed (it ended): read now instead of at the next tick. */
    poke() { if (!done && !gone && !stopped) schedule(0); },
    /** Read the whole output again, from its first byte, keeping up to SHELL_FULL_MAX_CHARS. */
    loadAll() {
      if (stopped) return;
      generation += 1;
      full = true;
      capped = false;
      done = false;
      gone = false;
      buffer.reset();
      buffer.setLimit(SHELL_FULL_MAX_CHARS);
      cursor = null;
      from = 0;
      schedule(0);
    },
    view,
    isDone: () => done || gone,
    isStopped: () => stopped,
  };
}

/**
 * Keeps one follower per command of the store's session, for as long as the
 * store is on that session: started when a command appears (an event, or the
 * server's list after a reload), stopped when the store moves to another
 * session. `supported()`: the server answers `shell:output` (an older one does
 * not, and the cards then show what the tool call itself returned).
 * Finished commands no block shows keep their text up to `kept` (the oldest
 * goes first, review S5: a long session kept up to 8 MB of text per command it
 * ever ran); one that comes on screen again is read afresh (watch).
 * Returns { loadAll(shellId), watch(shellId) → release, has(shellId), stop() }.
 */
export const SHELL_OUTPUT_KEPT_FINISHED = 12;

export function followShells(store, api, { supported = () => true, setTimer, clearTimer, kept = SHELL_OUTPUT_KEPT_FINISHED } = {}) {
  const followers = new Map();   // shellId → follower
  const usedAt = new Map();      // shellId → when its output was last read or shown
  const watched = new Map();     // shellId → how many blocks show it
  const evicted = new Set();     // finished commands whose text was let go: read again only when shown
  let clock = 0;
  let stopped = false;
  let binding = typeof store.getBinding === 'function' ? store.getBinding() : 0;
  const bindingNow = () => (typeof store.getBinding === 'function' ? store.getBinding() : 0);

  function clear() {
    for (const follower of followers.values()) follower.stop();
    followers.clear();
    usedAt.clear();
    evicted.clear();
  }

  /** Let go of the text of finished commands nobody looks at, beyond `kept`. */
  function trim() {
    const idle = [...followers].filter(([id, follower]) => follower.isDone() && !watched.get(id)
      && store.getState().shells.get(id)?.status !== 'running');
    if (idle.length <= kept) return;
    idle.sort((a, b) => (usedAt.get(a[0]) || 0) - (usedAt.get(b[0]) || 0));
    for (const [id, follower] of idle.slice(0, idle.length - kept)) {
      follower.stop();
      followers.delete(id);
      usedAt.delete(id);
      evicted.add(id);
      store.setShellOutput(id, null);
    }
  }

  function follow(shellId) {
    const state = store.getState();
    const mine = binding;
    const follower = createShellFollower({
      api, sessionId: state.sessionId, shellId, cwd: state.cwd || state.sessionInfo?.directory || undefined,
      isRunning: () => store.getState().shells.get(shellId)?.status === 'running',
      isCurrent: () => !stopped && bindingNow() === mine,
      onUpdate: (view) => {
        if (stopped || bindingNow() !== mine || followers.get(shellId) !== follower) return;
        usedAt.set(shellId, ++clock);
        store.setShellOutput(shellId, view);
        if (view?.done || view?.gone) trim();
      },
      ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}),
    });
    followers.set(shellId, follower);
    usedAt.set(shellId, ++clock);
    follower.start();
    return follower;
  }

  function sync() {
    if (stopped) return;
    const now = bindingNow();
    if (now !== binding) { binding = now; clear(); }
    const state = store.getState();
    if (!state.sessionId || !supported() || typeof api?.shellOutput !== 'function') return;
    for (const [shellId, shell] of state.shells) {
      const follower = followers.get(shellId);
      if (!follower) {
        if (!evicted.has(shellId)) follow(shellId);
      } else if (shell.status !== 'running') {
        follower.poke();
      }
    }
  }

  const unsubscribe = store.subscribe((event) => {
    if (event?.type === 'shell:update' || event?.type === 'session:set') sync();
  });
  sync();
  return {
    loadAll(shellId) { followers.get(shellId)?.loadAll(); },
    /** A block shows `shellId`: its text is kept (and read again if it was let go) until the release. */
    watch(shellId) {
      if (stopped) return () => {};
      watched.set(shellId, (watched.get(shellId) || 0) + 1);
      usedAt.set(shellId, ++clock);
      if (evicted.delete(shellId) && store.getState().shells.has(shellId) && supported()) follow(shellId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (watched.get(shellId) || 1) - 1;
        if (left > 0) watched.set(shellId, left); else watched.delete(shellId);
        trim();
      };
    },
    has: (shellId) => followers.has(shellId),
    stop() { stopped = true; try { unsubscribe(); } catch { /* gone */ } clear(); watched.clear(); },
  };
}

/**
 * What a command means for the card of its tool call.
 *   status   'running' | 'completed' | 'error' | '' (the call's own status stands)
 *   note     a few words for the card's head ("in the background", "exit 1", "stopped")
 */
export function shellCardState(shell) {
  if (!shell || typeof shell !== 'object') return { status: '', note: '', running: false };
  if (shell.status === 'running') {
    return { status: 'running', note: shell.background ? 'in the background' : '', running: true };
  }
  if (shell.status === 'killed') return { status: 'error', note: 'stopped', running: false };
  if (shell.status === 'timeout') return { status: 'error', note: 'timed out', running: false };
  const exit = typeof shell.exit === 'number' ? shell.exit : null;
  if (exit != null && exit !== 0) return { status: shell.background ? 'error' : '', note: `exit ${exit}`, running: false };
  return { status: shell.background ? 'completed' : '', note: '', running: false };
}

/** "1.2 MB", "340 KB", "512 B". */
export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** The line above a terminal block when it does not show everything: '' when it does. */
export function shellOutputNote(view) {
  if (!view) return '';
  if (view.gone) return 'OpenCode no longer keeps the output of this command.';
  if (view.capped) return `Showing the last ${formatBytes(view.text.length)} of ${formatBytes(view.size)}: the whole output is too long to show here.`;
  if (view.partial) return `Showing the last ${formatBytes(view.text.length)} of ${formatBytes(view.size)}.`;
  return '';
}
