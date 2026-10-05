// Server-side terminal model for reconnect snapshots: a headless xterm (the
// same parser the browser runs) plus the serialize addon, so a reconnect
// restores colors, attributes, the alternate screen, cursor and input modes
// instead of plain text.
//
// The serializer omits a few pieces of state that TUIs rely on; they are
// appended after its output: scroll region (+ cursor re-placement), SGR mouse
// encoding, hidden cursor, DECSCUSR cursor style and the window title.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const MOUSE_ENCODING_MODE = { SGR: 1006, SGR_PIXELS: 1016, URXVT: 1015, UTF8: 1005 };
const CURSOR_STYLE_BASE = { block: 1, underline: 3, bar: 5 };

export function createTerminalModel({ cols = 120, rows = 30, scrollback = 1000 } = {}) {
  const term = new Terminal({
    cols: Math.max(2, cols | 0),
    rows: Math.max(1, rows | 0),
    scrollback,
    allowProposedApi: true,
    logLevel: 'off',
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  // Same wide-character table as the browser client, or emoji/CJK rows drift.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';

  let title = '';
  term.onTitleChange((t) => { title = String(t || ''); });

  let pendingBytes = 0;
  let parseGen = 0;
  let cache = null;
  let disposed = false;

  function write(data, onParsed) {
    if (disposed || data == null || data.length === 0) return;
    const n = data.length;
    pendingBytes += n;
    term.write(data, () => {
      pendingBytes -= n;
      parseGen++;
      onParsed?.();
    });
  }

  /** Runs `cb` once everything written so far has been parsed. */
  function barrier(cb) {
    if (disposed) { cb?.(); return; }
    term.write('', cb);
  }

  /** Resize after already-queued output is parsed (it was produced at the old size). */
  function resize(c, r) {
    if (disposed) return;
    term.write('', () => {
      try { term.resize(Math.max(2, c | 0), Math.max(1, r | 0)); } catch {}
      parseGen++;
    });
  }

  function extras() {
    const parts = [];
    try {
      const core = term._core;
      const buf = core?.buffer;
      const dm = core?.coreService?.decPrivateModes || {};
      if (buf && (buf.scrollTop !== 0 || buf.scrollBottom !== term.rows - 1)) {
        parts.push(`\x1b[${buf.scrollTop + 1};${buf.scrollBottom + 1}r`);
        // DECSTBM homes the cursor; put it back (origin mode is region-relative).
        const y = dm.origin ? buf.y - buf.scrollTop : buf.y;
        parts.push(`\x1b[${Math.max(1, y + 1)};${Math.max(1, buf.x + 1)}H`);
      }
      const enc = MOUSE_ENCODING_MODE[core?.coreMouseService?.activeEncoding];
      if (enc) parts.push(`\x1b[?${enc}h`);
      const base = CURSOR_STYLE_BASE[dm.cursorStyle];
      if (base) parts.push(`\x1b[${dm.cursorBlink ? base : base + 1} q`);
      if (core?.coreService?.isCursorHidden) parts.push('\x1b[?25l');
    } catch {}
    const safeTitle = title.replace(/[\x00-\x1f\x7f]/g, '');
    if (safeTitle) parts.push(`\x1b]0;${safeTitle}\x07`);
    return parts.join('');
  }

  function plainText() {
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }

  /** Serialize the current state. Call from a barrier() callback. */
  function serialize() {
    if (cache && cache.gen === parseGen) return cache.snap;
    let ansi = '';
    try { ansi = serializer.serialize({ scrollback }); } catch { ansi = ''; }
    const snap = { ansi: ansi + extras(), plain: plainText(), cols: term.cols, rows: term.rows };
    cache = { gen: parseGen, snap };
    return snap;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cache = null;
    try { term.dispose(); } catch {}
  }

  return {
    write,
    barrier,
    resize,
    serialize,
    dispose,
    get pendingBytes() { return pendingBytes; },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    get title() { return title; },
  };
}
