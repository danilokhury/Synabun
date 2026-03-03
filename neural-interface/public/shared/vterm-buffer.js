/**
 * vterm-buffer.js — Virtual terminal buffer (2D cell grid)
 *
 * Implements the handler interface for AnsiParser. Maintains terminal
 * state: cell grid, cursor, SGR attributes, scroll region, alternate
 * screen buffer, and scrollback.
 *
 * Each cell: { char, fg, bg, bold, dim, italic, underline, inverse, strikethrough, url }
 * Dirty row tracking via Set<rowIndex> for incremental rendering.
 *
 * Performance optimizations:
 *   - Circular buffer for scrollback (O(1) push/shift vs O(n) Array.shift)
 *   - Cell reuse in erase operations (mutate instead of replace)
 *   - getDirtyRows returns snapshot Array (safe across clearDirty calls)
 */

import { AnsiParser } from './ansi-parser.js';

// ─── Default cell ──────────────────────────────────────────

function blankCell() {
  return { char: ' ', fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strikethrough: false, url: null };
}

/** Reset an existing cell to blank state — avoids allocation */
function resetCell(c) {
  c.char = ' '; c.fg = null; c.bg = null;
  c.bold = false; c.dim = false; c.italic = false;
  c.underline = false; c.inverse = false; c.strikethrough = false;
  c.url = null;
}

function blankRow(cols) {
  const row = new Array(cols);
  for (let i = 0; i < cols; i++) row[i] = blankCell();
  return row;
}

/** Reset all cells in a row to blank — reuses existing cell objects */
function resetRow(row, cols) {
  for (let i = 0; i < cols; i++) {
    if (row[i]) resetCell(row[i]);
    else row[i] = blankCell();
  }
}

// ─── Circular buffer for scrollback ────────────────────────
// Array.shift() is O(n) — moves every element. This is O(1) amortized.
class CircularBuffer {
  constructor(capacity) {
    this._capacity = capacity;
    this._buf = new Array(capacity);
    this._head = 0;  // index of oldest element
    this._size = 0;
  }

  get length() { return this._size; }

  push(item) {
    const idx = (this._head + this._size) % this._capacity;
    this._buf[idx] = item;
    if (this._size < this._capacity) {
      this._size++;
    } else {
      // Overwrite oldest — advance head
      this._head = (this._head + 1) % this._capacity;
    }
  }

  get(index) {
    if (index < 0 || index >= this._size) return null;
    return this._buf[(this._head + index) % this._capacity];
  }

  clear() {
    // Release references for GC
    for (let i = 0; i < this._capacity; i++) this._buf[i] = undefined;
    this._head = 0;
    this._size = 0;
  }

  /** Transfer excess rows from array-shrink into scrollback */
  pushMany(rows) {
    for (let i = 0; i < rows.length; i++) this.push(rows[i]);
  }
}

// ─── Standard 256-color palette (indices 0–255) ───────────
// 0-7: standard, 8-15: bright, 16-231: 6x6x6 cube, 232-255: grayscale
const PALETTE_256 = (() => {
  const p = new Array(256);
  // 0-15 handled by theme lookup at render time (null → use CSS class)
  for (let i = 0; i < 16; i++) p[i] = null;
  // 16-231: 6x6x6 color cube
  for (let i = 16; i < 232; i++) {
    const idx = i - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    p[i] = `rgb(${r ? r * 40 + 55 : 0},${g ? g * 40 + 55 : 0},${b ? b * 40 + 55 : 0})`;
  }
  // 232-255: grayscale
  for (let i = 232; i < 256; i++) {
    const v = (i - 232) * 10 + 8;
    p[i] = `rgb(${v},${v},${v})`;
  }
  return p;
})();

const MAX_SCROLLBACK = 5000;

export class VTermBuffer {
  /**
   * @param {number} cols
   * @param {number} rows
   */
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;

    // Main screen buffer
    this._mainBuffer = [];
    for (let r = 0; r < rows; r++) this._mainBuffer.push(blankRow(cols));

    // Alternate screen buffer (created on demand)
    this._altBuffer = null;
    this._useAlt = false;

    // Active buffer reference
    this._buffer = this._mainBuffer;

    // Scrollback (main buffer only) — circular buffer for O(1) operations
    this._scrollback = new CircularBuffer(MAX_SCROLLBACK);

    // Cursor state
    this._cursorX = 0;
    this._cursorY = 0;
    this._cursorVisible = true;

    // Saved cursor (DECSC/DECRC)
    this._savedCursor = null;
    this._savedCursorAlt = null;

    // SGR attributes
    this._attr = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strikethrough: false };

    // Scroll region (DECSTBM) — 0-based, inclusive
    this._scrollTop = 0;
    this._scrollBottom = rows - 1;

    // Mode flags
    this._bracketedPaste = false;
    this._appCursorKeys = false;
    this._autoWrap = true;
    this._originMode = false;
    this._insertMode = false;

    // OSC state
    this._title = '';
    this._currentUrl = null; // for OSC 8 hyperlinks

    // Dirty tracking
    this._dirty = new Set();
    this._allDirty = true; // first render paints everything

    // Wrap-pending flag: cursor at right margin, next char wraps
    this._wrapPending = false;

    // Parser
    this._parser = new AnsiParser(this);

    // Charset (G0/G1) — simplified, just track if special
    this._charsetG0 = null;
    this._charsetG1 = null;
    this._activeCharset = 0; // 0=G0, 1=G1
  }

  // ─── Public API ────────────────────────────────────────

  /** Feed raw PTY data */
  write(data) {
    this._parser.parse(data);
  }

  /** Get a row from the visible buffer (0 = top of screen) */
  getRow(idx) {
    if (idx < 0 || idx >= this.rows) return null;
    return this._buffer[idx];
  }

  /** Get scrollback row (0 = oldest) */
  getScrollbackRow(idx) {
    if (this._useAlt) return null;
    return this._scrollback.get(idx);
  }

  get scrollbackLength() {
    return this._useAlt ? 0 : this._scrollback.length;
  }

  /** Get dirty row indices since last clearDirty().
   *  Returns the internal Set when not allDirty — avoids Array.from allocation.
   *  Callers must iterate with for..of (Set is iterable). */
  getDirtyRows() {
    if (this._allDirty) {
      const all = [];
      for (let i = 0; i < this.rows; i++) all.push(i);
      return all;
    }
    return Array.from(this._dirty);
  }

  clearDirty() {
    this._dirty.clear();
    this._allDirty = false;
  }

  get cursorX() { return this._cursorX; }
  get cursorY() { return this._cursorY; }
  get cursorVisible() { return this._cursorVisible; }
  get title() { return this._title; }
  get bracketedPaste() { return this._bracketedPaste; }
  get appCursorKeys() { return this._appCursorKeys; }

  /** Resize the terminal */
  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    const oldCols = this.cols;
    const oldRows = this.rows;
    this.cols = cols;
    this.rows = rows;

    // Resize both buffers
    this._resizeBuffer(this._mainBuffer, oldCols, oldRows, cols, rows, true);
    if (this._altBuffer) {
      this._resizeBuffer(this._altBuffer, oldCols, oldRows, cols, rows, false);
    }
    this._buffer = this._useAlt ? this._altBuffer : this._mainBuffer;

    // Clamp cursor
    this._cursorX = Math.min(this._cursorX, cols - 1);
    this._cursorY = Math.min(this._cursorY, rows - 1);

    // Reset scroll region
    this._scrollTop = 0;
    this._scrollBottom = rows - 1;

    this._allDirty = true;
  }

  /** Get plain text content of a region (for copy).
   *  Row indices are absolute: 0..scrollbackLength-1 = scrollback,
   *  scrollbackLength..scrollbackLength+rows-1 = screen buffer.
   */
  getText(startRow, startCol, endRow, endCol) {
    const sb = this.scrollbackLength;
    const lines = [];
    for (let r = startRow; r <= endRow; r++) {
      const row = r < sb
        ? this.getScrollbackRow(r)
        : this.getRow(r - sb);
      if (!row) continue;
      const s = r === startRow ? startCol : 0;
      const e = r === endRow ? endCol : this.cols - 1;
      let line = '';
      for (let c = s; c <= e; c++) {
        line += row[c]?.char || ' ';
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }

  // ─── Handler interface (called by AnsiParser) ──────────

  /** Printable characters */
  print(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // Handle wrap-pending
      if (this._wrapPending) {
        if (this._autoWrap) {
          this._dirty.add(this._cursorY);
          this._cursorX = 0;
          this._lineFeed();
        }
        this._wrapPending = false;
      }

      // Insert mode: shift chars right
      if (this._insertMode && this._cursorX < this.cols) {
        const row = this._buffer[this._cursorY];
        for (let c = this.cols - 1; c > this._cursorX; c--) {
          row[c] = row[c - 1];
        }
      }

      // Write cell
      const row = this._buffer[this._cursorY];
      if (this._cursorX < this.cols) {
        const cell = row[this._cursorX];
        cell.char = ch;
        cell.fg = this._attr.fg;
        cell.bg = this._attr.bg;
        cell.bold = this._attr.bold;
        cell.dim = this._attr.dim;
        cell.italic = this._attr.italic;
        cell.underline = this._attr.underline;
        cell.inverse = this._attr.inverse;
        cell.strikethrough = this._attr.strikethrough;
        cell.url = this._currentUrl;
        this._dirty.add(this._cursorY);
      }

      // Advance cursor
      if (this._cursorX >= this.cols - 1) {
        this._wrapPending = true;
      } else {
        this._cursorX++;
      }
    }
  }

  /** C0 control codes */
  execute(code) {
    switch (code) {
      case 0x08: // BS
        if (this._cursorX > 0) this._cursorX--;
        this._wrapPending = false;
        break;
      case 0x09: // HT (tab)
        this._cursorX = Math.min(((this._cursorX >> 3) + 1) << 3, this.cols - 1);
        this._wrapPending = false;
        break;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        this._lineFeed();
        break;
      case 0x0d: // CR
        this._cursorX = 0;
        this._wrapPending = false;
        break;
      case 0x07: // BEL
        // Could trigger visual bell — currently ignored
        break;
    }
  }

  /** CSI dispatch */
  csiDispatch(params, privateMarker, intermediates, final) {
    if (privateMarker === '?') {
      this._csiPrivate(params, final);
      return;
    }
    if (privateMarker === '>') {
      // DA2 and similar — ignore
      return;
    }

    const p0 = this._getParam(params, 0, 1);
    const p1 = this._getParam(params, 1, 1);

    switch (final) {
      // ─── Cursor movement ─────────────────────────────
      case 'A': // CUU — cursor up
        this._cursorY = Math.max(this._scrollTop, this._cursorY - p0);
        this._wrapPending = false;
        break;
      case 'B': // CUD — cursor down
        this._cursorY = Math.min(this._scrollBottom, this._cursorY + p0);
        this._wrapPending = false;
        break;
      case 'C': // CUF — cursor forward
        this._cursorX = Math.min(this.cols - 1, this._cursorX + p0);
        this._wrapPending = false;
        break;
      case 'D': // CUB — cursor back
        this._cursorX = Math.max(0, this._cursorX - p0);
        this._wrapPending = false;
        break;
      case 'E': // CNL — cursor next line
        this._cursorX = 0;
        this._cursorY = Math.min(this._scrollBottom, this._cursorY + p0);
        this._wrapPending = false;
        break;
      case 'F': // CPL — cursor previous line
        this._cursorX = 0;
        this._cursorY = Math.max(this._scrollTop, this._cursorY - p0);
        this._wrapPending = false;
        break;
      case 'G': // CHA — cursor horizontal absolute
        this._cursorX = Math.min(Math.max(p0 - 1, 0), this.cols - 1);
        this._wrapPending = false;
        break;
      case 'H': // CUP — cursor position
      case 'f': // HVP — same as CUP
        this._cursorY = Math.min(Math.max(p0 - 1, 0), this.rows - 1);
        this._cursorX = Math.min(Math.max(p1 - 1, 0), this.cols - 1);
        this._wrapPending = false;
        break;
      case 'd': // VPA — vertical line position absolute
        this._cursorY = Math.min(Math.max(p0 - 1, 0), this.rows - 1);
        this._wrapPending = false;
        break;

      // ─── Erase ───────────────────────────────────────
      case 'J': // ED — erase in display
        this._eraseDisplay(this._getParam(params, 0, 0));
        break;
      case 'K': // EL — erase in line
        this._eraseLine(this._getParam(params, 0, 0));
        break;

      // ─── Insert/Delete ───────────────────────────────
      case 'L': // IL — insert lines
        this._insertLines(p0);
        break;
      case 'M': // DL — delete lines
        this._deleteLines(p0);
        break;
      case '@': // ICH — insert characters
        this._insertChars(p0);
        break;
      case 'P': // DCH — delete characters
        this._deleteChars(p0);
        break;
      case 'X': // ECH — erase characters
        this._eraseChars(p0);
        break;

      // ─── Scroll ──────────────────────────────────────
      case 'S': // SU — scroll up
        this._scrollUp(p0);
        break;
      case 'T': // SD — scroll down
        this._scrollDown(p0);
        break;

      // ─── SGR ─────────────────────────────────────────
      case 'm': // SGR — select graphic rendition
        this._handleSGR(params);
        break;

      // ─── Scroll region ──────────────────────────────
      case 'r': // DECSTBM — set top and bottom margins
        this._scrollTop = Math.max(0, (this._getParam(params, 0, 1)) - 1);
        this._scrollBottom = Math.min(this.rows - 1, (this._getParam(params, 1, this.rows)) - 1);
        // Move cursor to home position
        this._cursorX = 0;
        this._cursorY = this._originMode ? this._scrollTop : 0;
        this._wrapPending = false;
        break;

      // ─── Tab clear ──────────────────────────────────
      case 'g': // TBC — tab clear (ignore, we use fixed 8-col tabs)
        break;

      // ─── Device Status Report ───────────────────────
      case 'n': // DSR
        // p0 === 6 → report cursor position (not needed for rendering, but some apps expect it)
        break;

      // ─── Cursor save/restore (ANSI) ─────────────────
      case 's': // SCP — save cursor position
        this._savedCursor = { x: this._cursorX, y: this._cursorY, attr: { ...this._attr } };
        break;
      case 'u': // RCP — restore cursor position
        if (this._savedCursor) {
          this._cursorX = this._savedCursor.x;
          this._cursorY = this._savedCursor.y;
          this._attr = { ...this._savedCursor.attr };
        }
        this._wrapPending = false;
        break;

      // ─── Repeat ─────────────────────────────────────
      case 'b': // REP — repeat preceding character
        // Not commonly used by CLI tools, safe to ignore
        break;

      // ─── Set mode (SM) / Reset mode (RM) ────────────
      case 'h': // SM
        if (this._getParam(params, 0, 0) === 4) this._insertMode = true;
        break;
      case 'l': // RM
        if (this._getParam(params, 0, 0) === 4) this._insertMode = false;
        break;

      default:
        // Unhandled CSI — silently ignore
        break;
    }
  }

  /** ESC dispatch (simple escape sequences) */
  escDispatch(intermediates, final) {
    if (intermediates === '') {
      switch (final) {
        case '7': // DECSC — save cursor
          this._saveCursor();
          break;
        case '8': // DECRC — restore cursor
          this._restoreCursor();
          break;
        case 'D': // IND — index (line feed without CR)
          this._lineFeed();
          break;
        case 'E': // NEL — next line (LF + CR)
          this._cursorX = 0;
          this._lineFeed();
          break;
        case 'M': // RI — reverse index
          this._reverseIndex();
          break;
        case 'c': // RIS — full reset
          this._fullReset();
          break;
        case 'H': // HTS — horizontal tab set (ignore, fixed tabs)
          break;
      }
    } else if (intermediates === '(') {
      // G0 charset designation
      this._charsetG0 = final === '0' ? 'special' : null;
    } else if (intermediates === ')') {
      // G1 charset designation
      this._charsetG1 = final === '0' ? 'special' : null;
    } else if (intermediates === '#') {
      // DECDHL, DECSWL, DECDWL — double height/width (ignore)
    }
  }

  /** OSC dispatch */
  oscDispatch(data) {
    const semiIdx = data.indexOf(';');
    if (semiIdx === -1) return;
    const cmd = data.substring(0, semiIdx);
    const payload = data.substring(semiIdx + 1);

    switch (cmd) {
      case '0': // Set title + icon name
      case '2': // Set title
        this._title = payload;
        break;
      case '8': { // Hyperlink
        // OSC 8 ; params ; uri ST
        // params are key=value pairs separated by :
        // empty uri = close link
        const semiIdx2 = payload.indexOf(';');
        if (semiIdx2 !== -1) {
          const uri = payload.substring(semiIdx2 + 1);
          this._currentUrl = uri || null;
        }
        break;
      }
      // OSC 4: set color palette — ignored
      // OSC 10/11: fg/bg color — ignored
    }
  }

  // ─── Private mode (CSI ? ...) ──────────────────────────

  _csiPrivate(params, final) {
    const mode = this._getParam(params, 0, 0);

    switch (final) {
      case 'h': // DECSET
        this._setPrivateMode(mode, true);
        // Handle multiple params
        for (let i = 1; i < params.length; i++) {
          const m = typeof params[i] === 'number' ? params[i] : 0;
          if (m) this._setPrivateMode(m, true);
        }
        break;
      case 'l': // DECRST
        this._setPrivateMode(mode, false);
        for (let i = 1; i < params.length; i++) {
          const m = typeof params[i] === 'number' ? params[i] : 0;
          if (m) this._setPrivateMode(m, false);
        }
        break;
    }
  }

  _setPrivateMode(mode, enable) {
    switch (mode) {
      case 1: // DECCKM — application cursor keys
        this._appCursorKeys = enable;
        break;
      case 7: // DECAWM — auto-wrap
        this._autoWrap = enable;
        break;
      case 25: // DECTCEM — cursor visible
        this._cursorVisible = enable;
        break;
      case 1049: // Alt screen + save/restore cursor
        if (enable) {
          this._saveCursor();
          this._switchToAltBuffer();
        } else {
          this._switchToMainBuffer();
          this._restoreCursor();
        }
        break;
      case 47:  // Alt screen (no save/restore)
      case 1047:
        if (enable) {
          this._switchToAltBuffer();
        } else {
          this._switchToMainBuffer();
        }
        break;
      case 2004: // Bracketed paste
        this._bracketedPaste = enable;
        break;
      case 6: // DECOM — origin mode
        this._originMode = enable;
        if (enable) {
          this._cursorX = 0;
          this._cursorY = this._scrollTop;
        }
        break;
      case 12: // AT&T cursor blink — ignore
        break;
      case 1000: // Mouse tracking — ignore for now
      case 1002:
      case 1003:
      case 1006:
        break;
    }
  }

  // ─── SGR (Select Graphic Rendition) ────────────────────

  _handleSGR(params) {
    if (params.length === 0) {
      this._resetAttr();
      return;
    }

    for (let i = 0; i < params.length; i++) {
      const p = params[i];

      // Handle colon-separated sub-params (e.g., 38:2:r:g:b)
      if (Array.isArray(p)) {
        this._handleSGRSubParams(p);
        continue;
      }

      switch (p) {
        case 0:
          this._resetAttr();
          break;
        case 1: this._attr.bold = true; break;
        case 2: this._attr.dim = true; break;
        case 3: this._attr.italic = true; break;
        case 4: this._attr.underline = true; break;
        case 7: this._attr.inverse = true; break;
        case 9: this._attr.strikethrough = true; break;
        case 21: this._attr.underline = true; break; // double underline → underline
        case 22: this._attr.bold = false; this._attr.dim = false; break;
        case 23: this._attr.italic = false; break;
        case 24: this._attr.underline = false; break;
        case 27: this._attr.inverse = false; break;
        case 29: this._attr.strikethrough = false; break;

        // Foreground colors (standard)
        case 30: case 31: case 32: case 33:
        case 34: case 35: case 36: case 37:
          this._attr.fg = p - 30;
          break;
        case 39: // Default fg
          this._attr.fg = null;
          break;

        // Background colors (standard)
        case 40: case 41: case 42: case 43:
        case 44: case 45: case 46: case 47:
          this._attr.bg = p - 40;
          break;
        case 49: // Default bg
          this._attr.bg = null;
          break;

        // Bright foreground
        case 90: case 91: case 92: case 93:
        case 94: case 95: case 96: case 97:
          this._attr.fg = p - 90 + 8;
          break;

        // Bright background
        case 100: case 101: case 102: case 103:
        case 104: case 105: case 106: case 107:
          this._attr.bg = p - 100 + 8;
          break;

        // Extended colors (semicolon-separated)
        case 38: { // FG extended
          const result = this._parseExtendedColor(params, i + 1);
          if (result) {
            this._attr.fg = result.color;
            i = result.nextIndex - 1; // -1 because loop increments
          }
          break;
        }
        case 48: { // BG extended
          const result = this._parseExtendedColor(params, i + 1);
          if (result) {
            this._attr.bg = result.color;
            i = result.nextIndex - 1;
          }
          break;
        }
        case 58: { // Underline color (ignore value but consume params)
          const result = this._parseExtendedColor(params, i + 1);
          if (result) i = result.nextIndex - 1;
          break;
        }
      }
    }
  }

  /** Handle colon-separated SGR sub-params like 38:2:r:g:b */
  _handleSGRSubParams(subParams) {
    if (subParams.length < 2) return;
    const type = subParams[0];
    const colorType = subParams[1];

    if (type === 38 || type === 48) {
      // FG or BG
      const isFg = type === 38;
      if (colorType === 2 && subParams.length >= 5) {
        // Truecolor: 38:2:r:g:b or 38:2:colorspace:r:g:b
        let r, g, b;
        if (subParams.length >= 6) {
          // With colorspace: 38:2:cs:r:g:b
          r = subParams[3]; g = subParams[4]; b = subParams[5];
        } else {
          r = subParams[2]; g = subParams[3]; b = subParams[4];
        }
        const color = `rgb(${r & 255},${g & 255},${b & 255})`;
        if (isFg) this._attr.fg = color; else this._attr.bg = color;
      } else if (colorType === 5 && subParams.length >= 3) {
        // 256-color: 38:5:idx
        this._set256Color(isFg, subParams[2]);
      }
    }
  }

  /**
   * Parse extended color params (semicolon-separated):
   *   38;2;r;g;b  or  38;5;idx
   * @returns {{ color: any, nextIndex: number }} or null
   */
  _parseExtendedColor(params, startIdx) {
    if (startIdx >= params.length) return null;
    const mode = typeof params[startIdx] === 'number' ? params[startIdx] : 0;

    if (mode === 2) {
      // Truecolor
      if (startIdx + 3 < params.length) {
        const r = typeof params[startIdx + 1] === 'number' ? params[startIdx + 1] : 0;
        const g = typeof params[startIdx + 2] === 'number' ? params[startIdx + 2] : 0;
        const b = typeof params[startIdx + 3] === 'number' ? params[startIdx + 3] : 0;
        return { color: `rgb(${r & 255},${g & 255},${b & 255})`, nextIndex: startIdx + 4 };
      }
    } else if (mode === 5) {
      // 256-color
      if (startIdx + 1 < params.length) {
        const idx = typeof params[startIdx + 1] === 'number' ? params[startIdx + 1] : 0;
        const color = this._resolve256(idx);
        return { color, nextIndex: startIdx + 2 };
      }
    }
    return null;
  }

  _resolve256(idx) {
    if (idx < 0 || idx > 255) return null;
    if (idx < 16) return idx; // Theme color index (rendered via CSS class)
    return PALETTE_256[idx]; // RGB string
  }

  _set256Color(isFg, idx) {
    const color = this._resolve256(idx);
    if (isFg) this._attr.fg = color; else this._attr.bg = color;
  }

  _resetAttr() {
    this._attr.fg = null;
    this._attr.bg = null;
    this._attr.bold = false;
    this._attr.dim = false;
    this._attr.italic = false;
    this._attr.underline = false;
    this._attr.inverse = false;
    this._attr.strikethrough = false;
  }

  // ─── Line operations ──────────────────────────────────

  _lineFeed() {
    this._wrapPending = false;
    if (this._cursorY === this._scrollBottom) {
      this._scrollUp(1);
    } else if (this._cursorY < this.rows - 1) {
      this._cursorY++;
    }
  }

  _reverseIndex() {
    this._wrapPending = false;
    if (this._cursorY === this._scrollTop) {
      this._scrollDown(1);
    } else if (this._cursorY > 0) {
      this._cursorY--;
    }
  }

  _scrollUp(n) {
    for (let i = 0; i < n; i++) {
      // Push top line to scrollback (main buffer only, full-screen scroll region)
      if (!this._useAlt && this._scrollTop === 0) {
        this._scrollback.push(this._buffer[this._scrollTop]);
      }
      // Shift rows up within scroll region
      for (let r = this._scrollTop; r < this._scrollBottom; r++) {
        this._buffer[r] = this._buffer[r + 1];
      }
      this._buffer[this._scrollBottom] = blankRow(this.cols);
    }
    // Mark all rows in scroll region dirty
    for (let r = this._scrollTop; r <= this._scrollBottom; r++) {
      this._dirty.add(r);
    }
  }

  _scrollDown(n) {
    for (let i = 0; i < n; i++) {
      for (let r = this._scrollBottom; r > this._scrollTop; r--) {
        this._buffer[r] = this._buffer[r - 1];
      }
      this._buffer[this._scrollTop] = blankRow(this.cols);
    }
    for (let r = this._scrollTop; r <= this._scrollBottom; r++) {
      this._dirty.add(r);
    }
  }

  _insertLines(n) {
    const top = this._cursorY;
    const bot = this._scrollBottom;
    for (let i = 0; i < n; i++) {
      for (let r = bot; r > top; r--) {
        this._buffer[r] = this._buffer[r - 1];
      }
      this._buffer[top] = blankRow(this.cols);
    }
    for (let r = top; r <= bot; r++) this._dirty.add(r);
  }

  _deleteLines(n) {
    const top = this._cursorY;
    const bot = this._scrollBottom;
    for (let i = 0; i < n; i++) {
      for (let r = top; r < bot; r++) {
        this._buffer[r] = this._buffer[r + 1];
      }
      this._buffer[bot] = blankRow(this.cols);
    }
    for (let r = top; r <= bot; r++) this._dirty.add(r);
  }

  // ─── Character operations ─────────────────────────────

  _insertChars(n) {
    const row = this._buffer[this._cursorY];
    for (let i = 0; i < n; i++) {
      row.pop();
      row.splice(this._cursorX, 0, blankCell());
    }
    // Ensure row stays correct length
    while (row.length < this.cols) row.push(blankCell());
    if (row.length > this.cols) row.length = this.cols;
    this._dirty.add(this._cursorY);
  }

  _deleteChars(n) {
    const row = this._buffer[this._cursorY];
    row.splice(this._cursorX, n);
    while (row.length < this.cols) row.push(blankCell());
    this._dirty.add(this._cursorY);
  }

  _eraseChars(n) {
    const row = this._buffer[this._cursorY];
    const end = Math.min(this._cursorX + n, this.cols);
    for (let c = this._cursorX; c < end; c++) {
      resetCell(row[c]);
    }
    this._dirty.add(this._cursorY);
  }

  // ─── Erase operations ─────────────────────────────────

  _eraseDisplay(mode) {
    switch (mode) {
      case 0: // Cursor to end
        this._eraseLineFrom(this._cursorY, this._cursorX);
        for (let r = this._cursorY + 1; r < this.rows; r++) {
          resetRow(this._buffer[r], this.cols);
          this._dirty.add(r);
        }
        break;
      case 1: // Start to cursor
        for (let r = 0; r < this._cursorY; r++) {
          resetRow(this._buffer[r], this.cols);
          this._dirty.add(r);
        }
        this._eraseLineTo(this._cursorY, this._cursorX);
        break;
      case 2: // Entire display
        for (let r = 0; r < this.rows; r++) {
          resetRow(this._buffer[r], this.cols);
          this._dirty.add(r);
        }
        break;
      case 3: // Entire display + scrollback
        for (let r = 0; r < this.rows; r++) {
          resetRow(this._buffer[r], this.cols);
          this._dirty.add(r);
        }
        this._scrollback.clear();
        break;
    }
  }

  _eraseLine(mode) {
    switch (mode) {
      case 0: // Cursor to end
        this._eraseLineFrom(this._cursorY, this._cursorX);
        break;
      case 1: // Start to cursor
        this._eraseLineTo(this._cursorY, this._cursorX);
        break;
      case 2: // Entire line
        resetRow(this._buffer[this._cursorY], this.cols);
        this._dirty.add(this._cursorY);
        break;
    }
  }

  _eraseLineFrom(row, col) {
    const r = this._buffer[row];
    for (let c = col; c < this.cols; c++) {
      resetCell(r[c]);
    }
    this._dirty.add(row);
  }

  _eraseLineTo(row, col) {
    const r = this._buffer[row];
    for (let c = 0; c <= col && c < this.cols; c++) {
      resetCell(r[c]);
    }
    this._dirty.add(row);
  }

  // ─── Cursor save/restore ──────────────────────────────

  _saveCursor() {
    const saved = { x: this._cursorX, y: this._cursorY, attr: { ...this._attr } };
    if (this._useAlt) {
      this._savedCursorAlt = saved;
    } else {
      this._savedCursor = saved;
    }
  }

  _restoreCursor() {
    const saved = this._useAlt ? this._savedCursorAlt : this._savedCursor;
    if (saved) {
      this._cursorX = Math.min(saved.x, this.cols - 1);
      this._cursorY = Math.min(saved.y, this.rows - 1);
      this._attr = { ...saved.attr };
    }
    this._wrapPending = false;
  }

  // ─── Alt screen buffer ────────────────────────────────

  _switchToAltBuffer() {
    if (this._useAlt) return;
    // Create fresh alt buffer
    this._altBuffer = [];
    for (let r = 0; r < this.rows; r++) this._altBuffer.push(blankRow(this.cols));
    this._useAlt = true;
    this._buffer = this._altBuffer;
    this._allDirty = true;
  }

  _switchToMainBuffer() {
    if (!this._useAlt) return;
    this._useAlt = false;
    this._altBuffer = null;
    this._buffer = this._mainBuffer;
    this._allDirty = true;
  }

  // ─── Full reset ───────────────────────────────────────

  _fullReset() {
    this._cursorX = 0;
    this._cursorY = 0;
    this._cursorVisible = true;
    this._resetAttr();
    this._scrollTop = 0;
    this._scrollBottom = this.rows - 1;
    this._bracketedPaste = false;
    this._appCursorKeys = false;
    this._autoWrap = true;
    this._originMode = false;
    this._insertMode = false;
    this._title = '';
    this._currentUrl = null;
    this._wrapPending = false;
    this._savedCursor = null;
    this._savedCursorAlt = null;

    if (this._useAlt) {
      this._useAlt = false;
      this._altBuffer = null;
      this._buffer = this._mainBuffer;
    }

    for (let r = 0; r < this.rows; r++) {
      resetRow(this._buffer[r], this.cols);
    }
    this._scrollback.clear();
    this._allDirty = true;
    this._parser.reset();
  }

  // ─── Buffer resize ────────────────────────────────────

  _resizeBuffer(buffer, oldCols, oldRows, newCols, newRows, isMain) {
    // Adjust row count
    while (buffer.length < newRows) {
      buffer.push(blankRow(newCols));
    }
    // If shrinking rows, push excess to scrollback (main only)
    while (buffer.length > newRows) {
      const removed = buffer.shift();
      if (isMain) {
        this._scrollback.push(removed);
      }
    }
    // Adjust column count per row
    if (newCols !== oldCols) {
      for (let r = 0; r < buffer.length; r++) {
        const row = buffer[r];
        if (newCols > oldCols) {
          // Expand
          for (let c = oldCols; c < newCols; c++) row.push(blankCell());
        } else {
          // Shrink
          row.length = newCols;
        }
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────

  _getParam(params, idx, def) {
    if (idx >= params.length) return def;
    const v = params[idx];
    if (typeof v === 'number') return v || def;
    if (Array.isArray(v)) return v[0] || def;
    return def;
  }
}
