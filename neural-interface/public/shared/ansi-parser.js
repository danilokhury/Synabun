/**
 * ansi-parser.js — Streaming ANSI escape code state machine
 *
 * Parses raw PTY output into structured handler calls. Designed for
 * pairing with VTermBuffer but any object implementing the handler
 * interface will work.
 *
 * Handler interface:
 *   print(text)                          — printable characters
 *   execute(code)                        — C0 control codes (BS, TAB, CR, LF, etc.)
 *   csiDispatch(params, intermediates, final)  — CSI sequences
 *   escDispatch(intermediates, final)    — simple ESC sequences
 *   oscDispatch(data)                    — OSC strings (title, hyperlinks)
 */

// C0 control codes that get dispatched via execute()
const C0_EXECUTE = new Set([
  0x07, // BEL
  0x08, // BS
  0x09, // HT  (tab)
  0x0a, // LF
  0x0b, // VT  (treat as LF)
  0x0c, // FF  (treat as LF)
  0x0d, // CR
]);

// Parser states
const S_GROUND       = 0;
const S_ESCAPE       = 1;
const S_ESCAPE_INTER = 2;
const S_CSI_ENTRY    = 3;
const S_CSI_PARAM    = 4;
const S_CSI_INTER    = 5;
const S_OSC_STRING   = 6;
const S_DCS_PASSTHRU = 7; // we mostly ignore DCS but need to consume it

export class AnsiParser {
  /**
   * @param {object} handler — object implementing print/execute/csiDispatch/escDispatch/oscDispatch
   */
  constructor(handler) {
    this._handler = handler;
    this._state = S_GROUND;

    // CSI accumulators
    this._params = '';
    this._intermediates = '';

    // OSC accumulator
    this._oscData = '';

    // Printable text batch buffer
    this._printBuf = '';
  }

  /** Flush any accumulated printable text to the handler */
  _flushPrint() {
    if (this._printBuf.length > 0) {
      this._handler.print(this._printBuf);
      this._printBuf = '';
    }
  }

  /**
   * Feed raw PTY data. Handles partial sequences across calls.
   * @param {string} data
   */
  parse(data) {
    const len = data.length;

    for (let i = 0; i < len; i++) {
      const ch = data.charCodeAt(i);

      switch (this._state) {

        // ─── GROUND ────────────────────────────────────────
        case S_GROUND:
          if (ch === 0x1b) {
            // ESC — start escape sequence
            this._flushPrint();
            this._state = S_ESCAPE;
          } else if (C0_EXECUTE.has(ch)) {
            this._flushPrint();
            this._handler.execute(ch);
          } else if (ch >= 0x20) {
            // Printable — batch consecutive chars for efficiency
            // Scan ahead for more printable chars
            let end = i + 1;
            while (end < len) {
              const c = data.charCodeAt(end);
              if (c < 0x20 || c === 0x1b) break;
              end++;
            }
            this._printBuf += data.substring(i, end);
            i = end - 1; // -1 because loop increments
          }
          // else: ignore other C0 codes (NUL, etc.)
          break;

        // ─── ESCAPE ────────────────────────────────────────
        case S_ESCAPE:
          if (ch === 0x5b) {
            // ESC [ → CSI
            this._state = S_CSI_ENTRY;
            this._params = '';
            this._intermediates = '';
          } else if (ch === 0x5d) {
            // ESC ] → OSC
            this._state = S_OSC_STRING;
            this._oscData = '';
          } else if (ch === 0x50) {
            // ESC P → DCS (consume until ST)
            this._state = S_DCS_PASSTHRU;
          } else if (ch >= 0x20 && ch <= 0x2f) {
            // Intermediate bytes → ESC intermediate
            this._intermediates = String.fromCharCode(ch);
            this._state = S_ESCAPE_INTER;
          } else if (ch >= 0x30 && ch <= 0x7e) {
            // Final byte — dispatch simple ESC sequence
            this._handler.escDispatch(this._intermediates, String.fromCharCode(ch));
            this._intermediates = '';
            this._state = S_GROUND;
          } else if (ch === 0x1b) {
            // Double ESC — stay in escape state
          } else {
            // Invalid — return to ground
            this._state = S_GROUND;
          }
          break;

        // ─── ESCAPE INTERMEDIATE ───────────────────────────
        case S_ESCAPE_INTER:
          if (ch >= 0x20 && ch <= 0x2f) {
            this._intermediates += String.fromCharCode(ch);
          } else if (ch >= 0x30 && ch <= 0x7e) {
            this._handler.escDispatch(this._intermediates, String.fromCharCode(ch));
            this._intermediates = '';
            this._state = S_GROUND;
          } else {
            // Invalid → ground
            this._intermediates = '';
            this._state = S_GROUND;
          }
          break;

        // ─── CSI ENTRY ─────────────────────────────────────
        case S_CSI_ENTRY:
          if (ch >= 0x30 && ch <= 0x3f) {
            // Parameter byte (0-9, ;, <, =, >, ?)
            this._params += String.fromCharCode(ch);
            this._state = S_CSI_PARAM;
          } else if (ch >= 0x20 && ch <= 0x2f) {
            // Intermediate byte
            this._intermediates += String.fromCharCode(ch);
            this._state = S_CSI_INTER;
          } else if (ch >= 0x40 && ch <= 0x7e) {
            // Final byte — dispatch immediately (no params)
            this._dispatchCSI(String.fromCharCode(ch));
            this._state = S_GROUND;
          } else if (ch === 0x1b) {
            // ESC inside CSI — abort and restart
            this._state = S_ESCAPE;
          } else {
            // Ignore other
          }
          break;

        // ─── CSI PARAM ─────────────────────────────────────
        case S_CSI_PARAM:
          if (ch >= 0x30 && ch <= 0x3f) {
            // More parameter bytes
            this._params += String.fromCharCode(ch);
          } else if (ch >= 0x20 && ch <= 0x2f) {
            // Intermediate
            this._intermediates += String.fromCharCode(ch);
            this._state = S_CSI_INTER;
          } else if (ch >= 0x40 && ch <= 0x7e) {
            // Final byte
            this._dispatchCSI(String.fromCharCode(ch));
            this._state = S_GROUND;
          } else if (ch === 0x1b) {
            this._state = S_ESCAPE;
          } else {
            // Ignore
          }
          break;

        // ─── CSI INTERMEDIATE ──────────────────────────────
        case S_CSI_INTER:
          if (ch >= 0x20 && ch <= 0x2f) {
            this._intermediates += String.fromCharCode(ch);
          } else if (ch >= 0x40 && ch <= 0x7e) {
            this._dispatchCSI(String.fromCharCode(ch));
            this._state = S_GROUND;
          } else if (ch === 0x1b) {
            this._state = S_ESCAPE;
          } else {
            // Ignore
          }
          break;

        // ─── OSC STRING ────────────────────────────────────
        case S_OSC_STRING:
          if (ch === 0x07) {
            // BEL terminates OSC
            this._handler.oscDispatch(this._oscData);
            this._oscData = '';
            this._state = S_GROUND;
          } else if (ch === 0x1b) {
            // Check for ST (ESC \)
            if (i + 1 < len && data.charCodeAt(i + 1) === 0x5c) {
              // ESC \ = ST
              this._handler.oscDispatch(this._oscData);
              this._oscData = '';
              this._state = S_GROUND;
              i++; // skip the backslash
            } else {
              // Bare ESC inside OSC — terminate OSC, reprocess ESC
              this._handler.oscDispatch(this._oscData);
              this._oscData = '';
              this._state = S_ESCAPE;
            }
          } else if (ch === 0x9c) {
            // ST (C1) terminates OSC
            this._handler.oscDispatch(this._oscData);
            this._oscData = '';
            this._state = S_GROUND;
          } else {
            this._oscData += String.fromCharCode(ch);
          }
          break;

        // ─── DCS PASSTHROUGH ───────────────────────────────
        case S_DCS_PASSTHRU:
          // Consume until ST (ESC \) or BEL
          if (ch === 0x1b) {
            if (i + 1 < len && data.charCodeAt(i + 1) === 0x5c) {
              this._state = S_GROUND;
              i++; // skip backslash
            }
          } else if (ch === 0x07 || ch === 0x9c) {
            this._state = S_GROUND;
          }
          break;
      }
    }

    // Flush any remaining printable text
    this._flushPrint();
  }

  /**
   * Parse CSI params string and dispatch to handler.
   * Params format: "?25" or "1;2" or "38;2;255;128;0" or "" etc.
   */
  _dispatchCSI(final) {
    // Extract private marker (?, >, !) if present
    let privateMarker = '';
    let paramStr = this._params;
    if (paramStr.length > 0) {
      const first = paramStr.charCodeAt(0);
      if (first === 0x3f || first === 0x3e || first === 0x21) {
        // ? > ! are private markers
        privateMarker = paramStr[0];
        paramStr = paramStr.substring(1);
      }
    }

    // Parse semicolon-separated numeric params
    // Supports colon sub-params (e.g., 38:2:255:128:0 for truecolor)
    const params = [];
    if (paramStr.length > 0) {
      const parts = paramStr.split(';');
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        if (part.indexOf(':') !== -1) {
          // Sub-params — store as array within params
          const subParts = part.split(':');
          const subNums = [];
          for (let s = 0; s < subParts.length; s++) {
            subNums.push(subParts[s] === '' ? 0 : parseInt(subParts[s], 10));
          }
          params.push(subNums);
        } else {
          params.push(part === '' ? 0 : parseInt(part, 10));
        }
      }
    }

    this._handler.csiDispatch(params, privateMarker, this._intermediates, final);

    // Reset
    this._params = '';
    this._intermediates = '';
  }

  /** Reset parser to ground state (e.g., on RIS) */
  reset() {
    this._state = S_GROUND;
    this._params = '';
    this._intermediates = '';
    this._oscData = '';
    this._printBuf = '';
  }
}
