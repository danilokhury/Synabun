/**
 * html-term-renderer.js — Custom HTML/CSS terminal renderer
 *
 * Replaces xterm.js for CLI tool profiles (claude-code, codex, gemini).
 * Converts VTermBuffer state to styled DOM elements. Handles keyboard
 * input, selection, scrollback with native scrollbar, and resize.
 *
 * Performance optimizations:
 *   - Pre-cached FG/BG class name lookup tables (zero allocation per cell)
 *   - Batched HTML string building with zero intermediate arrays
 *   - Passive scroll listener to avoid blocking compositor
 *   - Resize debouncing to prevent layout thrashing
 *   - Cached cell dimensions to avoid repeated measurements
 *   - Row content hashing to skip unchanged rows during full re-renders
 *   - Smooth auto-scroll with requestAnimationFrame batching
 *
 * Usage:
 *   const renderer = new HtmlTermRenderer(container, ws, { onTitle, onResize });
 *   // WS messages: renderer.write(data)
 *   // Cleanup: renderer.dispose()
 */

import { VTermBuffer } from './vterm-buffer.js';

// ─── Theme (must match XTERM_THEME in ui-terminal.js) ───
const THEME = {
  bg:  '#0a0a0c',
  fg:  '#d0d0d0',
  cursor: '#6eb5ff',
  selBg: 'rgba(110,181,255,0.3)',
  selFg: '#ffffff',
};

// Pre-cached class name lookup tables — avoids string concat per cell
const FG_CLASSES = [];
const BG_CLASSES = [];
for (let i = 0; i < 16; i++) {
  FG_CLASSES[i] = `ht-fg${i}`;
  BG_CLASSES[i] = `ht-bg${i}`;
}

// HTML entity map for single-char escaping
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

// Resize debounce (ms) — prevents layout thrashing during continuous resize
const RESIZE_DEBOUNCE_MS = 60;

export class HtmlTermRenderer {
  /**
   * @param {HTMLElement} container — mount point (will be filled)
   * @param {WebSocket|null} ws — WebSocket to PTY (null = deferred connect)
   * @param {object} [options]
   * @param {function} [options.onTitle] — title change callback
   * @param {function} [options.onResize] — (cols, rows) resize callback
   * @param {number} [options.fontSize] — default 13
   * @param {string} [options.fontFamily] — default JetBrains Mono
   * @param {number} [options.lineHeight] — default 1.3
   */
  constructor(container, ws, options = {}) {
    this._container = container;
    this._ws = ws;
    this._options = options;
    this._disposed = false;

    this._fontSize = options.fontSize || 13;
    this._fontFamily = options.fontFamily || "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace";
    this._lineHeight = options.lineHeight || 1.3;

    // Cell dimensions (measured once, cached)
    this._cellWidth = 0;
    this._cellHeight = 0;
    this._cols = 80;
    this._rows = 24;

    // Buffer (created after measurement)
    this._buffer = null;

    // Render state
    this._rafId = null;
    this._renderPending = false;
    this._lastTitle = '';

    // Row content hashes — skip re-rendering unchanged rows on full re-renders
    this._rowHashes = [];

    // Selection state
    this._selecting = false;
    this._selStart = null;
    this._selEnd = null;
    this._selectionDirty = false;

    // Scroll state
    this._wasAtBottom = true;
    this._lastFirstVisible = -1;
    this._suppressScrollEvent = false;

    // Resize debounce state
    this._resizeTimer = null;
    this._resizePending = false;

    // Bound handlers (avoids closure allocation on every event)
    this._boundScrollHandler = this._onScroll.bind(this);

    // Build DOM
    this._buildDOM();
    this._measureCell();
    this._calculateSize();

    // Create buffer
    this._buffer = new VTermBuffer(this._cols, this._rows);

    // Wire events
    this._wireKeyboard();
    this._wireMouse();
    this._wireScroll();
    this._wireResize();

    // Initial render
    this._rebuildRows();
    this._scheduleRender();
  }

  // ─── Public API ────────────────────────────────────────

  /** Feed raw PTY data */
  write(data) {
    if (this._disposed || !this._buffer) return;

    // Track whether we were at bottom before new data
    const wasBottom = this._isAtBottom();

    this._buffer.write(data);

    // Check title change
    if (this._buffer.title !== this._lastTitle) {
      this._lastTitle = this._buffer.title;
      if (this._options.onTitle) this._options.onTitle(this._lastTitle);
    }

    // Update spacer height (scrollback may have grown)
    this._updateSpacerHeight();

    // Auto-scroll to bottom if we were already there (but not during selection)
    if (wasBottom && !this._selecting) {
      this._scrollToMax();
    }

    this._scheduleRender();
  }

  /** Set WebSocket (for deferred connect) */
  setWebSocket(ws) {
    this._ws = ws;
  }

  /** Recalculate cols/rows from container size */
  fit() {
    if (this._disposed) return;
    this._measureCell();
    const changed = this._calculateSize();
    if (changed) {
      this._buffer.resize(this._cols, this._rows);
      this._rebuildRows();
      this._updateSpacerHeight();
      this._scrollToMax();
      this._scheduleRender();
      if (this._options.onResize) {
        this._options.onResize(this._cols, this._rows);
      }
    }
  }

  focus() {
    if (!this._disposed) this._input.focus();
  }

  blur() {
    if (!this._disposed) this._input.blur();
  }

  get cols() { return this._cols; }
  get rows() { return this._rows; }
  get buffer() { return this._buffer; }

  /** Get selected text */
  getSelection() {
    if (!this._selStart || !this._selEnd) return '';
    const s = this._normalizeSelection();
    if (!s) return '';
    return this._buffer.getText(s.startRow, s.startCol, s.endRow, s.endCol);
  }

  scrollToBottom() {
    this._scrollToMax();
    this._scheduleRender();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._ro) this._ro.disconnect();
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    // Remove scroll listener (was added with passive: true)
    this._scrollEl.removeEventListener('scroll', this._boundScrollHandler);
    this._container.innerHTML = '';
  }

  // ─── DOM construction ─────────────────────────────────

  _buildDOM() {
    this._container.innerHTML = '';

    // Root
    this._root = document.createElement('div');
    this._root.className = 'html-term';
    this._root.tabIndex = 0;

    // Scroll viewport — native scroll handles scrollback
    this._scrollEl = document.createElement('div');
    this._scrollEl.className = 'html-term-scroll';

    // Spacer — its height represents scrollback content above the screen rows.
    // Browser's native scrollbar uses this to provide a real scrollbar track.
    this._spacer = document.createElement('div');
    this._spacer.className = 'html-term-spacer';
    this._spacer.style.cssText = 'width: 1px; height: 0; pointer-events: none;';

    // Rows container — holds exactly this._rows div elements
    this._rowsEl = document.createElement('div');
    this._rowsEl.className = 'html-term-rows';

    this._scrollEl.appendChild(this._spacer);
    this._scrollEl.appendChild(this._rowsEl);

    // Cursor element — positioned relative to _rowsEl
    this._cursorEl = document.createElement('div');
    this._cursorEl.className = 'html-term-cursor';
    this._rowsEl.appendChild(this._cursorEl);

    this._root.appendChild(this._scrollEl);

    // Hidden textarea for keyboard input
    this._input = document.createElement('textarea');
    this._input.className = 'html-term-input';
    this._input.autocomplete = 'off';
    this._input.autocorrect = 'off';
    this._input.autocapitalize = 'off';
    this._input.spellcheck = false;
    this._root.appendChild(this._input);

    // Probe element for measuring cell size
    this._probe = document.createElement('span');
    this._probe.className = 'html-term-probe';
    this._probe.style.cssText = `
      position: absolute; visibility: hidden; white-space: pre;
      font-family: ${this._fontFamily}; font-size: ${this._fontSize}px;
      line-height: ${this._lineHeight};
    `;
    this._probe.textContent = 'W';
    this._root.appendChild(this._probe);

    this._container.appendChild(this._root);

    // Row DOM elements (reused)
    this._rowEls = [];
  }

  _measureCell() {
    if (this._disposed) return;
    const rect = this._probe.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this._cellWidth = rect.width;
      this._cellHeight = rect.height;
    } else {
      // Fallback estimate
      this._cellWidth = this._fontSize * 0.6;
      this._cellHeight = this._fontSize * this._lineHeight;
    }
  }

  _calculateSize() {
    const rect = this._scrollEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const cols = Math.max(2, Math.floor(rect.width / this._cellWidth));
    const rows = Math.max(1, Math.floor(rect.height / this._cellHeight));
    if (cols !== this._cols || rows !== this._rows) {
      this._cols = cols;
      this._rows = rows;
      return true;
    }
    return false;
  }

  _rebuildRows() {
    // Remove existing rows (keep spacer and cursor)
    for (const el of this._rowEls) el.remove();
    this._rowEls = [];
    this._rowHashes = [];

    // Insert row elements before the cursor
    const frag = document.createDocumentFragment();
    for (let r = 0; r < this._rows; r++) {
      const el = document.createElement('div');
      el.className = 'html-term-row';
      el.style.height = `${this._cellHeight}px`;
      el.style.lineHeight = `${this._cellHeight}px`;
      frag.appendChild(el);
      this._rowEls.push(el);
      this._rowHashes.push('');
    }
    this._rowsEl.insertBefore(frag, this._cursorEl);
    this._lastFirstVisible = -1; // force full re-render
  }

  // ─── Scroll helpers ───────────────────────────────────

  _updateSpacerHeight() {
    if (!this._buffer || !this._cellHeight) return;
    // Total virtual height: scrollback rows + screen rows.
    // _rowsEl is position:absolute so doesn't contribute to scrollHeight.
    const h = (this._buffer.scrollbackLength + this._rows) * this._cellHeight;
    this._spacer.style.height = h + 'px';
  }

  _isAtBottom() {
    const el = this._scrollEl;
    // Within 2px of bottom counts as "at bottom"
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  }

  _scrollToMax() {
    this._suppressScrollEvent = true;
    this._scrollEl.scrollTop = this._scrollEl.scrollHeight;
  }

  _getFirstVisibleRow() {
    if (!this._cellHeight) return 0;
    return Math.max(0, Math.floor(this._scrollEl.scrollTop / this._cellHeight));
  }

  // ─── Rendering ─────────────────────────────────────────

  _scheduleRender() {
    if (this._renderPending || this._disposed) return;
    this._renderPending = true;
    this._rafId = requestAnimationFrame(() => {
      this._renderPending = false;
      this._render();
    });
  }

  _render() {
    if (this._disposed || !this._buffer) return;

    // Ensure correct row element count
    while (this._rowEls.length < this._rows) {
      const el = document.createElement('div');
      el.className = 'html-term-row';
      el.style.height = `${this._cellHeight}px`;
      el.style.lineHeight = `${this._cellHeight}px`;
      this._rowsEl.insertBefore(el, this._cursorEl);
      this._rowEls.push(el);
      this._rowHashes.push('');
    }
    while (this._rowEls.length > this._rows) {
      const el = this._rowEls.pop();
      this._rowHashes.pop();
      el.remove();
    }

    const scrollback = this._buffer.scrollbackLength;

    // Force layout reflow so scrollTop is correctly clamped after spacer height changes.
    // Without this, rAF can read stale scrollTop before browser recalculates layout,
    // causing firstVisible to point beyond valid data → all rows render blank.
    void this._scrollEl.scrollHeight;

    // Clamp firstVisible to valid range: 0 .. scrollback (live view starts at scrollback)
    // This prevents blank rendering when scrollTop is out of sync with spacer height
    // (e.g. after alt screen transitions, buffer clears, or rapid data bursts)
    let firstVisible = this._getFirstVisibleRow();
    let clamped = false;
    const maxFirstVisible = scrollback; // beyond this = live view, capped by screen rows
    if (firstVisible > maxFirstVisible) {
      firstVisible = maxFirstVisible;
      clamped = true;
      // Fix the scroll position to match (prevent repeated clamping)
      this._suppressScrollEvent = true;
      this._scrollEl.scrollTop = firstVisible * this._cellHeight;
    }

    // Guard against NaN/Infinity (e.g. from zero-size measurement)
    if (!Number.isFinite(firstVisible) || firstVisible < 0) {
      firstVisible = scrollback;
      clamped = true;
    }

    // Position _rowsEl at the current viewport via GPU-composited transform
    const scrollTop = this._scrollEl.scrollTop;
    this._rowsEl.style.transform = Number.isFinite(scrollTop) ? `translateY(${scrollTop}px)` : 'translateY(0)';

    const scrolled = firstVisible !== this._lastFirstVisible;
    this._lastFirstVisible = firstVisible;

    // Determine which rows need re-rendering
    const sel = this._normalizeSelection();
    const dirty = this._buffer.getDirtyRows();
    this._buffer.clearDirty();
    const selDirty = this._selectionDirty;
    this._selectionDirty = false;

    // At bottom (live view): firstVisible >= scrollback
    const isLive = firstVisible >= scrollback;

    if (scrolled || selDirty || clamped) {
      // Scroll position changed, selection changed, or position was clamped — full re-render
      this._renderAllVisible(firstVisible, scrollback, sel);
    } else if ((dirty.size || dirty.length) > 0) {
      if (isLive) {
        // Live view: dirty row indices map directly to screen positions
        for (const rowIdx of dirty) {
          if (rowIdx >= 0 && rowIdx < this._rows) {
            const row = this._buffer.getRow(rowIdx);
            this._renderRowData(rowIdx, row, sel, scrollback + rowIdx, true);
          }
        }
      } else {
        // Scrolled up: dirty rows are in the screen buffer but we're showing
        // scrollback. Just re-render everything visible to be safe.
        this._renderAllVisible(firstVisible, scrollback, sel);
      }
    }

    // Cursor: only visible when at bottom (live view)
    if (isLive && this._buffer.cursorVisible) {
      this._cursorEl.style.display = 'block';
      const x = this._buffer.cursorX * this._cellWidth;
      const y = this._buffer.cursorY * this._cellHeight;
      this._cursorEl.style.transform = `translate(${x}px, ${y}px)`;
      this._cursorEl.style.height = `${this._cellHeight}px`;
      this._cursorEl.style.width = '2px';
    } else {
      this._cursorEl.style.display = 'none';
    }
  }

  _renderAllVisible(firstVisible, scrollback, sel) {
    for (let i = 0; i < this._rows; i++) {
      const virtualRow = firstVisible + i;
      let row;
      if (virtualRow < scrollback) {
        row = this._buffer.getScrollbackRow(virtualRow);
      } else {
        row = this._buffer.getRow(virtualRow - scrollback);
      }
      this._renderRowData(i, row, sel, virtualRow, false);
    }
  }

  /**
   * Render a single row to its DOM element.
   * Uses batched string building — zero intermediate array allocations.
   * Skips rendering if row content hash matches previous (full re-render only).
   *
   * @param {number} screenIdx — screen row index (0-based)
   * @param {Array} row — cell array from buffer
   * @param {object|null} sel — normalized selection bounds
   * @param {number} absoluteRow — absolute row index (scrollback + screen)
   * @param {boolean} forceDirty — true if row is known-dirty (skip hash check)
   */
  _renderRowData(screenIdx, row, sel, absoluteRow, forceDirty) {
    const el = this._rowEls[screenIdx];
    if (!el) return;
    if (!row) { el.innerHTML = ''; this._rowHashes[screenIdx] = ''; return; }

    let html = '';
    let spanOpen = false;
    let prevCls = '';
    let prevStyle = '';

    const cols = this._cols;
    const hasSel = sel !== null;

    for (let c = 0; c < cols; c++) {
      const cell = row[c];
      if (!cell) continue;

      const inSel = hasSel && this._cellInSelection(absoluteRow, c, sel);

      // Inline _cellStyle — avoids object allocation per cell
      let cls = '';
      let style = '';
      let fg = cell.fg;
      let bg = cell.bg;

      if (cell.inverse) {
        const tmp = fg; fg = bg; bg = tmp;
        if (fg === null) fg = THEME.bg;
        if (bg === null) bg = THEME.fg;
      }

      if (inSel) {
        style = `background:${THEME.selBg};color:${THEME.selFg}`;
      } else {
        if (fg !== null) {
          if (typeof fg === 'number' && fg >= 0 && fg <= 15) {
            cls = FG_CLASSES[fg];
          } else if (typeof fg === 'string') {
            style = `color:${fg}`;
          }
        }
        if (bg !== null) {
          if (typeof bg === 'number' && bg >= 0 && bg <= 15) {
            cls = cls ? cls + ' ' + BG_CLASSES[bg] : BG_CLASSES[bg];
          } else if (typeof bg === 'string') {
            style = style ? style + `;background:${bg}` : `background:${bg}`;
          }
        }
      }

      if (cell.bold) cls = cls ? cls + ' ht-b' : 'ht-b';
      if (cell.dim) cls = cls ? cls + ' ht-dim' : 'ht-dim';
      if (cell.italic) cls = cls ? cls + ' ht-i' : 'ht-i';
      if (cell.underline) cls = cls ? cls + ' ht-u' : 'ht-u';
      if (cell.strikethrough) cls = cls ? cls + ' ht-s' : 'ht-s';
      if (cell.url) cls = cls ? cls + ' ht-link' : 'ht-link';

      if (cls !== prevCls || style !== prevStyle) {
        if (spanOpen) html += '</span>';
        if (cls || style) {
          html += '<span';
          if (cls) html += ` class="${cls}"`;
          if (style) html += ` style="${style}"`;
          if (cell.url) html += ` data-url="${this._escAttr(cell.url)}"`;
          html += '>';
          spanOpen = true;
        } else {
          spanOpen = false;
        }
        prevCls = cls;
        prevStyle = style;
      }

      // Inline HTML escaping — avoids function call overhead per character
      const ch = cell.char;
      html += HTML_ENTITIES[ch] || ch;
    }

    if (spanOpen) html += '</span>';

    // Hash check: skip DOM update if content unchanged (only for full re-renders)
    if (!forceDirty && this._rowHashes[screenIdx] === html) return;
    this._rowHashes[screenIdx] = html;
    el.innerHTML = html;
  }

  // ─── Keyboard input ───────────────────────────────────

  _wireKeyboard() {
    // Focus proxy: click on terminal → focus textarea (but not during selection drag)
    this._root.addEventListener('mousedown', (e) => {
      if (e.target === this._scrollEl || e.target === this._rowsEl ||
          e.target === this._root || e.target.classList.contains('html-term-row') ||
          e.target.closest('.html-term-rows')) {
        // Delay focus to avoid stealing it during selection drag.
        // onUp handler calls focus() when selection is complete.
        if (!this._selecting) {
          setTimeout(() => { if (!this._selecting) this._input.focus(); }, 0);
        }
      }
    });

    this._input.addEventListener('keydown', (e) => {
      if (this._disposed) return;
      const seq = this._keyToSequence(e);
      if (seq !== null) {
        e.preventDefault();
        // Any keyboard input → snap to bottom
        if (!this._isAtBottom()) {
          this._scrollToMax();
          this._scheduleRender();
        }
        this._send(seq);
      }
    });

    // Handle paste (text + images)
    this._input.addEventListener('paste', (e) => {
      if (this._disposed) return;
      e.preventDefault();
      if (e.clipboardData) {
        // Check for image paste first
        for (const item of e.clipboardData.items) {
          if (item.type.startsWith('image/') && this._ws?.readyState === WebSocket.OPEN) {
            const blob = item.getAsFile();
            if (!blob) return;
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = reader.result.split(',')[1];
              this._ws.send(JSON.stringify({ type: 'image_paste', data: base64, mimeType: item.type }));
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
      }
      // Text paste
      const text = e.clipboardData?.getData('text') || '';
      if (!text) return;
      const normalized = text.replace(/\r?\n/g, '\r');
      if (this._buffer.bracketedPaste) {
        this._send('\x1b[200~' + normalized + '\x1b[201~');
      } else {
        this._send(normalized);
      }
    });

    // Composition input (IME)
    this._input.addEventListener('input', (e) => {
      if (this._disposed) return;
      if (e.inputType === 'insertText' && this._input.value) {
        this._send(this._input.value);
        this._input.value = '';
      }
    });
  }

  _keyToSequence(e) {
    const key = e.key;
    const ctrl = e.ctrlKey;
    const alt = e.altKey;
    const shift = e.shiftKey;
    const meta = e.metaKey;

    // Ctrl+Shift+C → copy
    if (ctrl && shift && key === 'C') {
      const sel = this.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        return null;
      }
    }

    // Ctrl+V / Ctrl+Shift+V → let browser fire paste event
    if (ctrl && (key === 'v' || key === 'V')) return null;

    // Ctrl+C → SIGINT if no selection
    if (ctrl && !shift && key === 'c') {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return null;
      return '\x03';
    }

    // Ctrl+letter → control codes
    if (ctrl && !alt && !meta && key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
      if (key === '[') return '\x1b';
      if (key === '\\') return '\x1c';
      if (key === ']') return '\x1d';
      if (key === '^') return '\x1e';
      if (key === '_') return '\x1f';
    }

    // Alt+letter → ESC + letter
    if (alt && !ctrl && !meta && key.length === 1) return '\x1b' + key;

    // Application cursor mode
    const app = this._buffer?.appCursorKeys;
    const CSI = app ? '\x1bO' : '\x1b[';

    switch (key) {
      case 'Enter':     return ctrl ? '\x1b\r' : '\r';
      case 'Backspace': return ctrl ? '\x08' : '\x7f';
      case 'Tab':       return shift ? '\x1b[Z' : '\t';
      case 'Escape':    return '\x1b';
      case 'ArrowUp':   return shift ? '\x1b[1;2A' : (alt ? '\x1b[1;3A' : (ctrl ? '\x1b[1;5A' : `${CSI}A`));
      case 'ArrowDown': return shift ? '\x1b[1;2B' : (alt ? '\x1b[1;3B' : (ctrl ? '\x1b[1;5B' : `${CSI}B`));
      case 'ArrowRight':return shift ? '\x1b[1;2C' : (alt ? '\x1b[1;3C' : (ctrl ? '\x1b[1;5C' : `${CSI}C`));
      case 'ArrowLeft': return shift ? '\x1b[1;2D' : (alt ? '\x1b[1;3D' : (ctrl ? '\x1b[1;5D' : `${CSI}D`));
      case 'Home':      return ctrl ? '\x1b[1;5H' : '\x1b[H';
      case 'End':       return ctrl ? '\x1b[1;5F' : '\x1b[F';
      case 'PageUp':    return '\x1b[5~';
      case 'PageDown':  return '\x1b[6~';
      case 'Insert':    return '\x1b[2~';
      case 'Delete':    return '\x1b[3~';
      case 'F1':  return '\x1bOP';
      case 'F2':  return '\x1bOQ';
      case 'F3':  return '\x1bOR';
      case 'F4':  return '\x1bOS';
      case 'F5':  return '\x1b[15~';
      case 'F6':  return '\x1b[17~';
      case 'F7':  return '\x1b[18~';
      case 'F8':  return '\x1b[19~';
      case 'F9':  return '\x1b[20~';
      case 'F10': return '\x1b[21~';
      case 'F11': return '\x1b[23~';
      case 'F12': return '\x1b[24~';
    }

    // Regular printable character
    if (key.length === 1 && !ctrl && !alt && !meta) return key;

    return null;
  }

  _send(data) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'input', data }));
    }
  }

  // ─── Mouse / selection ────────────────────────────────

  _wireMouse() {
    this._scrollEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // Block native text selection — we handle selection ourselves
      this._selecting = true;
      // Clear previous selection first, THEN set new start
      this._selStart = null;
      this._selEnd = null;
      this._selectionDirty = true;
      this._scheduleRender();
      this._selStart = this._mouseToCell(e);

      const onMove = (ev) => {
        if (!this._selecting) return;
        this._selEnd = this._mouseToCell(ev);
        this._selectionDirty = true;
        this._scheduleRender();
      };

      const onUp = () => {
        this._selecting = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!this._selStart || !this._selEnd || (this._selStart.row === this._selEnd.row && this._selStart.col === this._selEnd.col)) {
          this._selStart = null;
          this._selEnd = null;
        } else {
          // Copy-on-select
          const sel = this.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        }
        this._selectionDirty = true;
        this._scheduleRender();
        this._input.focus();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Double-click to select word
    this._scrollEl.addEventListener('dblclick', (e) => {
      e.preventDefault(); // Block native word selection
      const cell = this._mouseToCell(e);
      const scrollback = this._buffer.scrollbackLength;
      const row = cell.row < scrollback
        ? this._buffer.getScrollbackRow(cell.row)
        : this._buffer.getRow(cell.row - scrollback);
      if (!row) return;
      let start = cell.col;
      let end = cell.col;
      while (start > 0 && row[start - 1]?.char !== ' ') start--;
      while (end < this._cols - 1 && row[end + 1]?.char !== ' ') end++;
      this._selStart = { row: cell.row, col: start };
      this._selEnd = { row: cell.row, col: end };
      this._selectionDirty = true;
      this._scheduleRender();
      // Copy-on-select
      const sel = this.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    });
  }

  _mouseToCell(e) {
    const rect = this._rowsEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const screenRow = Math.min(Math.max(0, Math.floor(y / this._cellHeight)), this._rows - 1);
    const firstVisible = this._getFirstVisibleRow();
    return {
      row: firstVisible + screenRow,  // absolute index into scrollback+screen
      col: Math.min(Math.max(0, Math.floor(x / this._cellWidth)), this._cols - 1),
    };
  }

  _normalizeSelection() {
    if (!this._selStart || !this._selEnd) return null;
    let { row: r1, col: c1 } = this._selStart;
    let { row: r2, col: c2 } = this._selEnd;
    if (r1 > r2 || (r1 === r2 && c1 > c2)) {
      [r1, c1, r2, c2] = [r2, c2, r1, c1];
    }
    return { startRow: r1, startCol: c1, endRow: r2, endCol: c2 };
  }

  _cellInSelection(row, col, sel) {
    if (row < sel.startRow || row > sel.endRow) return false;
    if (row === sel.startRow && col < sel.startCol) return false;
    if (row === sel.endRow && col > sel.endCol) return false;
    return true;
  }

  _clearSelectionHighlight() {
    if (this._selStart || this._selEnd) this._selectionDirty = true;
    this._selStart = null;
    this._selEnd = null;
  }

  // ─── Scroll + Resize ──────────────────────────────────

  _onScroll() {
    if (this._suppressScrollEvent) {
      this._suppressScrollEvent = false;
      return;
    }
    this._scheduleRender();
  }

  _wireScroll() {
    // Passive listener: doesn't block compositor thread during scroll.
    // This is critical for smooth 60fps scrolling — non-passive listeners
    // force the browser to wait for JS before compositing the scroll frame.
    this._scrollEl.addEventListener('scroll', this._boundScrollHandler, { passive: true });
  }

  _wireResize() {
    this._ro = new ResizeObserver(() => {
      if (this._disposed) return;
      // Debounce resize to prevent layout thrashing during continuous drag
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        if (!this._disposed) this.fit();
      }, RESIZE_DEBOUNCE_MS);
    });
    this._ro.observe(this._scrollEl);
  }

  // ─── HTML helpers ─────────────────────────────────────

  _escAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
