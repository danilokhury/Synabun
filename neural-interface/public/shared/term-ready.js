// ═══════════════════════════════════════════
// SynaBun Neural Interface — Terminal readiness
// When a freshly opened terminal can take a typed command, and how to hand it
// over. DOM-free: ui-terminal.js feeds it the output stream and does the I/O.
// ═══════════════════════════════════════════

// CSI, OSC (BEL or ST terminated), charset selection, and the two-byte escapes.
const ESCAPES_RE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[=>78MDEHNOc]/g;

// What _sendOnceReady has always stripped and matched for the CLIs (Claude
// Code, Codex, …). Kept as it was: the loops depend on this exact reading.
const CLI_ANSI_RE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;
const CLI_READY_PATTERNS = [
  /^>\s*$/m,        // Claude Code prompt: ">" on its own line
  /\n>\s*$/,        // ">" after newline at end of output
  />\s*$/,          // ">" at end of buffer (catch partial lines)
  /❯/,         // ❯ (some CLI prompts)
  /\$ $/,           // Shell prompt fallback
];

// The line editor (zsh's ZLE, readline in bash 5, fish) turns bracketed paste
// on when it starts reading a line and off when a command runs.
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';
// Shell integration marks (FinalTerm / OSC 133): B = the prompt has ended,
// C = a command is running.
const MARK_PROMPT_END = '\x1b]133;B';
const MARK_RUNNING = '\x1b]133;C';

// The character a prompt ends in: zsh %, bash/sh $, root #, cmd.exe / PowerShell
// / fish >, and the arrows the common themes use. A reconnect snapshot trims the
// trailing space, so the space is optional.
const PROMPT_TAIL_RE = /[%$#>❯➜»›→▶λ][ \t]*$/;

const BUFFER_MAX = 16384;
const BUFFER_KEEP = 8192;

// capMs runs from the moment the terminal's socket is open, never from the
// call: a socket that takes its time must not eat into the wait for a prompt.
// openGraceMs is how much longer than that a socket may take to open at all.
export const READY_LIMITS = Object.freeze({
  // A shell takes typeahead, so its limits are short: the worst case is a
  // command typed a moment before the prompt is drawn, never a lost one.
  shell: Object.freeze({ quietMs: 350, capMs: 5000, settleMs: 40, openGraceMs: 2000 }),
  // A CLI started inside the shell swallows input typed before its own prompt.
  cli: Object.freeze({ quietMs: 0, capMs: 15000, settleMs: 500, openGraceMs: 2000 }),
});

/** Which reading a terminal profile gets. */
export function readinessKind(profile) {
  return profile === 'shell' ? 'shell' : 'cli';
}

export function stripEscapes(text) {
  return String(text || '').replace(ESCAPES_RE, '');
}

function lastOn(raw, on, off) {
  const at = raw.lastIndexOf(on);
  return at >= 0 && at > raw.lastIndexOf(off);
}

/**
 * Read everything a terminal printed so far. Returns the reason it is ready
 * ('line-editor', 'prompt-mark', 'prompt') or null.
 */
export function readySignal(raw, kind = 'shell') {
  const text = String(raw || '');
  if (!text) return null;
  if (kind !== 'shell') {
    const clean = text.replace(CLI_ANSI_RE, '');
    return CLI_READY_PATTERNS.some(p => p.test(clean)) ? 'prompt' : null;
  }
  if (lastOn(text, PASTE_ON, PASTE_OFF)) return 'line-editor';
  if (lastOn(text, MARK_PROMPT_END, MARK_RUNNING)) return 'prompt-mark';
  // The line the cursor is on: zsh draws its prompt after "\r \r", so a
  // carriage return starts a line here just like a newline does.
  const clean = stripEscapes(text);
  const line = clean.slice(Math.max(clean.lastIndexOf('\n'), clean.lastIndexOf('\r')) + 1);
  return line.trim() && PROMPT_TAIL_RE.test(line) ? 'prompt' : null;
}

/**
 * Watch one terminal until it can take input, then call onReady(reason) once.
 *   output(text)  — output arrived (live bytes, or what was already buffered)
 *   replace(text) — a snapshot replaced the screen (connect / reconnect)
 *   poke()        — the emulator parsed something: re-read its line-editor mode
 *   start()       — the wait begins
 *   opened()      — the terminal's socket is open
 *   cancel()
 * Nothing is decided before opened(): the readiness window (capMs, and the
 * quiet rule) runs from there, in full, however late the socket opens. What
 * was fed in earlier is read at that moment. A socket that never opens ends
 * the wait capMs + openGraceMs after start().
 * Reasons: 'line-editor' | 'prompt-mark' | 'prompt' | 'quiet' | 'timeout'.
 */
export function createReadyWatch({
  kind = 'shell',
  onReady,
  lineEditorActive = null,
  limits = READY_LIMITS[kind] || READY_LIMITS.cli,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
} = {}) {
  let buf = '';
  let done = false;
  let started = false;
  let open = false;
  let sawOutput = false;
  let quietTimer = null;
  let capTimer = null;
  let openTimer = null;

  function clearTimers() {
    if (quietTimer) timers.clear(quietTimer);
    if (capTimer) timers.clear(capTimer);
    if (openTimer) timers.clear(openTimer);
    quietTimer = capTimer = openTimer = null;
  }

  function finish(reason) {
    if (done) return;
    done = true;
    clearTimers();
    try { onReady?.(reason); } catch {}
  }

  // Something a person could see. A connect snapshot of an empty screen and a
  // shell's terminal queries are escape codes only: not a sign of life yet.
  function noteOutput(text) {
    if (!sawOutput && /\S/.test(stripEscapes(text))) sawOutput = true;
  }

  function armQuiet() {
    if (done || !open || !sawOutput || !(limits.quietMs > 0)) return;
    if (quietTimer) timers.clear(quietTimer);
    quietTimer = timers.set(() => { quietTimer = null; finish('quiet'); }, limits.quietMs);
  }

  function evaluate() {
    if (done || !open) return;
    const signal = readySignal(buf, kind);
    if (signal) { finish(signal); return; }
    if (kind === 'shell' && lineEditorActive) {
      let active = false;
      try { active = lineEditorActive() === true; } catch {}
      if (active) { finish('line-editor'); return; }
    }
    armQuiet();
  }

  return {
    output(text) {
      if (done || !text) return;
      noteOutput(text);
      buf += text;
      if (buf.length > BUFFER_MAX) buf = buf.slice(-BUFFER_KEEP);
      evaluate();
    },
    replace(text) {
      if (done) return;
      buf = String(text || '');
      noteOutput(buf);
      evaluate();
    },
    poke() {
      if (done || !open || kind !== 'shell' || !lineEditorActive) return;
      let active = false;
      try { active = lineEditorActive() === true; } catch {}
      if (active) finish('line-editor');
    },
    start() {
      if (done || started) return;
      started = true;
      if (open) return;
      openTimer = timers.set(() => { openTimer = null; finish('timeout'); }, limits.capMs + (limits.openGraceMs || 0));
    },
    opened() {
      if (done || open) return; // a reconnect later on does not restart the window
      started = true;
      open = true;
      if (openTimer) timers.clear(openTimer);
      openTimer = null;
      capTimer = timers.set(() => { capTimer = null; finish('timeout'); }, limits.capMs);
      evaluate();
    },
    cancel() {
      if (done) return;
      done = true;
      clearTimers();
    },
    get done() { return done; },
    get open() { return open; },
  };
}

/** Split typed input into the writes the PTY gets (ConPTY drops long ones). */
export function inputChunks(text, size = 256) {
  const full = String(text ?? '');
  const out = [];
  for (let i = 0; i < full.length; i += size) out.push(full.slice(i, i + size));
  return out;
}

/**
 * Type `text` into a terminal: every chunk in order, each through the socket
 * that is current at that moment (a reconnect swaps it). Waits for an open
 * socket instead of dropping the input, and stops for good the moment a chunk
 * cannot be delivered — a command with a hole in it must never reach Enter.
 *   socket()     → the session's current socket ({ readyState, send }) or null
 *   alive()      → false once the terminal is gone
 * Resolves { ok, sent, chunks, reason? } with reason 'closed' | 'no-socket'.
 */
export async function typeInto({
  socket,
  alive = () => true,
  text,
  chunkSize = 256,
  gapMs = 30,
  openWaitMs = 10000,
  pollMs = 25,
  OPEN = 1,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const chunks = inputChunks(text, chunkSize);
  let sent = 0;
  for (const chunk of chunks) {
    const deadline = now() + openWaitMs;
    let ws = socket();
    while (alive() && (!ws || ws.readyState !== OPEN) && now() < deadline) {
      // Mid-command the wait is over: what follows a gap would be a different command.
      if (sent > 0) return { ok: false, sent, chunks: chunks.length, reason: 'closed' };
      await sleep(pollMs);
      ws = socket();
    }
    if (!alive()) return { ok: false, sent, chunks: chunks.length, reason: 'closed' };
    if (!ws || ws.readyState !== OPEN) return { ok: false, sent, chunks: chunks.length, reason: 'no-socket' };
    try { ws.send(JSON.stringify({ type: 'input', data: chunk })); }
    catch { return { ok: false, sent, chunks: chunks.length, reason: 'closed' }; }
    sent++;
    if (sent < chunks.length) await sleep(gapMs);
  }
  return { ok: true, sent, chunks: chunks.length };
}

/**
 * The whole hand-over of one message: wait until the terminal can take it, let
 * it settle, type it. Everything that touches the page is handed in, so this
 * runs the same under a test clock.
 *   socket()            → the session's current socket (a reconnect swaps it)
 *   alive()             → false once the terminal is gone
 *   lineEditorActive()  → the emulator's bracketed-paste mode
 *   buffered            → output that arrived before this call
 *   subscribe({ output(text, replaced), opened(), parsed() }) → unsubscribe
 *                         output for every chunk, opened whenever a socket of
 *                         this session opens, parsed after the emulator parsed
 *   onReady(reason, waitedMs)
 * Resolves { ok: true, reason, waitedMs } or { ok: false, reason, sent, chunks }.
 */
export function typeWhenReady({
  kind = 'shell',
  text,
  socket,
  alive = () => true,
  lineEditorActive = null,
  buffered = '',
  subscribe = null,
  onReady = () => {},
  OPEN = 1,
  limits = READY_LIMITS[kind] || READY_LIMITS.cli,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
  now = () => Date.now(),
  sleep = (ms) => new Promise(r => timers.set(r, ms)),
} = {}) {
  return new Promise((resolve) => {
    const t0 = now();
    let unsubscribe = null;
    const watch = createReadyWatch({
      kind,
      lineEditorActive,
      limits,
      timers,
      onReady: (reason) => {
        try { unsubscribe?.(); } catch {}
        unsubscribe = null;
        const waitedMs = Math.round(now() - t0);
        try { onReady(reason, waitedMs); } catch {}
        timers.set(async () => {
          const result = await typeInto({ socket, alive, text, OPEN, sleep, now });
          resolve(result.ok
            ? { ok: true, reason, waitedMs }
            : { ok: false, reason: result.reason, sent: result.sent, chunks: result.chunks });
        }, limits.settleMs);
      },
    });
    // Subscribed before anything can be decided: no verdict comes before opened().
    unsubscribe = subscribe?.({
      output: (chunk, replaced) => { if (replaced) watch.replace(chunk); else watch.output(chunk); },
      opened: () => watch.opened(),
      parsed: () => watch.poke(),
    }) || null;
    if (buffered) watch.output(buffered);
    watch.start();
    const ws = socket?.();
    if (ws && ws.readyState === OPEN) watch.opened();
  });
}
