// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: the minimap
// ═══════════════════════════════════════════
//
// An overview of the document at the right edge of the editor: every line a
// row of small blocks in the colours of its tokens, a box over the part that
// is in view, and marks for what the editor knows about a line: changed
// against the last commit (a strip on the left), a search match and a problem
// (a tick on the right). A click goes to a line; dragging scrolls.
//
// It draws only the rows that fit in it, from the editor's own syntax tree, at
// most once per frame: nothing here is done per document on a keystroke. Of a
// line it looks at the characters it can draw and no further, so a line of a
// megabyte (a minified file) costs what any line costs. It is a part of the
// scroller (so the text is laid out beside it, never under it) that stays in
// view while the text scrolls.
// Takes the vendored bundle as an argument: no imports. The helpers at the top
// need no page: `node --test` loads them as they are.

/** Sizes in CSS pixels: the whole width, a row, the block in it, a character, the git strip, the gap after it, a tick. */
export const MINIMAP = Object.freeze({ width: 64, row: 3, block: 2, char: 0.75, strip: 3, gap: 3, tick: 4 });
/** Characters of a line that are looked at, at most: what lies beyond is outside the minimap anyway. */
const LINE_SCAN = 400;
// @lezer/common's IterMode.IncludeAnonymous: a walk that sees the nodes a parser adds to keep a long run of
// siblings balanced. Through them a place in the tree is found by its position, not by passing every sibling.
const INCLUDE_ANONYMOUS = 2;
/** Search matches marked at most, and how long after an edit they are looked for again. */
export const MATCH_CAP = 5000;
const MATCH_DELAY_MS = 200;

/**
 * Which lines the minimap shows.
 * @param {{ lines: number, height: number, row?: number, scrollTop: number, scrollMax: number }} o `height`: the
 *   minimap's; `scrollTop` / `scrollMax`: where the editor is scrolled to, and the furthest it can be
 * @returns {{ first: number, count: number }} the first line (1-based) and how many: all of them when they fit,
 *   else the stretch that is as far through the document as the editor is scrolled
 */
export function minimapWindow({ lines, height, row = MINIMAP.row, scrollTop, scrollMax }) {
  const total = Math.max(1, Math.floor(lines) || 1);
  const fit = Math.max(1, Math.floor(height / row));
  if (total <= fit) return { first: 1, count: total };
  const ratio = scrollMax > 0 ? Math.min(1, Math.max(0, scrollTop / scrollMax)) : 0;
  return { first: 1 + Math.round(ratio * (total - fit)), count: fit };
}

/**
 * The box over the lines that are in view.
 * @param {{ first: number, count: number, topLine: number, bottomLine: number, row?: number }} o `first` / `count`:
 *   what minimapWindow() returned; `topLine` / `bottomLine`: the first and the last line in view
 * @returns {{ top: number, height: number }} in pixels from the minimap's top; never outside the rows it shows
 */
export function minimapBox({ first, count, topLine, bottomLine, row = MINIMAP.row }) {
  const last = first + count - 1;
  const from = Math.min(Math.max(topLine, first), last);
  const to = Math.min(Math.max(bottomLine, from), last);
  return { top: (from - first) * row, height: (to - from + 1) * row };
}

/** The line under a point of the minimap, `y` pixels from its top. */
export function minimapLineAt({ y, first, count, row = MINIMAP.row }) {
  return first + Math.min(count - 1, Math.max(0, Math.floor(y / row)));
}

/**
 * The blocks of one line: each run of characters that are not blank and share a colour.
 * @param {string} text the line (or its start)
 * @param {{ tabSize?: number, maxColumns?: number, colorAt?: (index: number) => any }} [o] `colorAt`: the colour
 *   of the character at an index of `text`
 * @returns {{ column: number, width: number, color: any }[]} `column`: where the run starts, tabs counted as
 *   the columns they take
 */
export function lineRuns(text, { tabSize = 4, maxColumns = Infinity, colorAt = () => null } = {}) {
  const runs = [];
  let column = 0;
  let open = null;
  for (let i = 0; i < text.length && column < maxColumns; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9) {
      open = null;
      column += c === 9 ? tabSize - (column % tabSize) : 1;
      continue;
    }
    const color = colorAt(i);
    if (open && open.color === color) open.width++;
    else { open = { column, width: 1, color }; runs.push(open); }
    column++;
  }
  return runs;
}

/**
 * The stretches of the document a redraw needs the colours of: from each line shown, the characters that can be
 * drawn. Lines that are no longer than `limit` are joined into one stretch; of a longer line only its start is
 * taken, and the next stretch begins on the line after it.
 * @param {{ from: number, lengths: number[], limit: number }} o `from`: where the first line shown starts;
 *   `lengths`: the length of each line shown, in order; `limit`: how many characters of a line are looked at
 * @returns {number[]} pairs of document positions: start, end, start, end, …, in order, none of them empty
 */
export function highlightRanges({ from, lengths, limit }) {
  const ranges = [];
  let at = from;       // where the line being looked at starts
  let start = from;    // where the stretch that is open starts
  for (const length of lengths) {
    if (length > limit) {
      if (at + limit > start) ranges.push(start, at + limit);
      start = at + length + 1;
    }
    at += length + 1;
  }
  const end = at - 1;  // the end of the last line
  if (end > start) ranges.push(start, end);
  return ranges;
}

/**
 * The token colours of what a redraw shows: `[start, end, colour, start, end, colour, …]` in document order.
 * Asked stretch by stretch (highlightRanges), each found in the tree by its position: the cost follows what is
 * drawn, whatever the length of the lines and wherever in the document they are.
 * @param {object} cm the vendored CodeMirror bundle
 * @param {{ tree: object, highlighter: object, ranges: number[], colorOf: (name: string) => any }} o `tree`: the
 *   document's syntax tree; `highlighter`: a tag highlighter whose classes `colorOf` turns into colours
 */
export function tokenSpans(cm, { tree, highlighter, ranges, colorOf }) {
  const spans = [];
  const byPosition = { cursor: () => tree.cursor(INCLUDE_ANONYMOUS), length: tree.length };
  const put = (start, stop, cls) => {
    const name = cls.indexOf(' ') < 0 ? cls : cls.slice(0, cls.indexOf(' '));
    spans.push(start, stop, colorOf(name));
  };
  for (let i = 0; i < ranges.length; i += 2) cm.highlightTree(byPosition, highlighter, put, ranges[i], ranges[i + 1]);
  return spans;
}

/**
 * @param {object} cm the vendored CodeMirror bundle (editor-loader.js)
 * @param {object} o
 * @param {{ tag: any, color?: string }[]} o.highlight the theme's tag → colour table (editor-theme.js: highlightSpecs)
 * @param {{ between: (state: object, from: number, to: number, use: (at: number, kind: string) => void) => void }} [o.git]
 *   editor-git.js: the marks of a stretch of the document
 * @param {{ each: (state: object, use: (from: number, to: number) => void) => void }} [o.problems] editor-lint.js
 */
export function editorMinimap(cm, { highlight, git = null, problems = null }) {
  const { EditorView, ViewPlugin } = cm;
  // The theme's colours are variables: a token's class here is the name of its variable, read off the editor once.
  const variable = (color) => /var\((--[\w-]+)/.exec(String(color || ''))?.[1] || null;
  const highlighter = cm.tagHighlighter(highlight.filter((spec) => variable(spec.color)).map((spec) => ({ tag: spec.tag, class: variable(spec.color) })));

  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.colors = new Map();
      this.window = { first: 1, count: 1 };
      this.box = { top: 0, height: 0, shown: false };
      this.matches = [];
      this.matchTimer = 0;
      this.drag = null;

      this.dom = document.createElement('div');
      this.dom.className = 'cm-minimap';
      // An overview for the pointer: everything it shows is in the text, where the keyboard and a screen reader are.
      this.dom.setAttribute('aria-hidden', 'true');
      this.canvas = document.createElement('canvas');
      this.slider = document.createElement('div');
      this.slider.className = 'cm-minimap-box';
      this.dom.append(this.canvas, this.slider);
      view.scrollDOM.insertBefore(this.dom, view.contentDOM.nextSibling);

      this.onScroll = () => this.schedule();
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      this.onDown = (event) => this.pointerDown(event);
      this.onMove = (event) => this.pointerMove(event);
      this.onUp = (event) => this.pointerUp(event);
      this.dom.addEventListener('pointerdown', this.onDown);
      this.dom.addEventListener('pointermove', this.onMove);
      this.dom.addEventListener('pointerup', this.onUp);
      this.dom.addEventListener('pointercancel', this.onUp);

      this.measure = { key: this, read: (v) => this.read(v), write: (geometry) => this.draw(geometry) };
      this.findMatches();
      this.schedule();
    }

    schedule() { this.view.requestMeasure(this.measure); }

    update(update) {
      const searching = cm.searchPanelOpen(update.state);
      const queryChanged = searching !== cm.searchPanelOpen(update.startState)
        || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(cm.setSearchQuery)));
      if (queryChanged || (update.docChanged && searching)) {
        clearTimeout(this.matchTimer);
        this.matchTimer = setTimeout(() => { this.findMatches(); this.schedule(); }, queryChanged ? 0 : MATCH_DELAY_MS);
      }
      // A caret that only moves changes nothing here. Anything else may: text, size, the parse reaching further,
      // marks that arrived with an effect.
      if (update.docChanged || update.geometryChanged || update.viewportChanged || update.transactions.some((tr) => tr.effects.length)
        || cm.syntaxTree(update.state) !== cm.syntaxTree(update.startState)) this.schedule();
    }

    // The lines that hold a match of the find bar's query, in order.
    findMatches() {
      this.matchTimer = 0;
      const { state } = this.view;
      const lines = [];
      if (cm.searchPanelOpen(state)) {
        const query = cm.getSearchQuery(state);
        if (query.search && query.valid) {
          const cursor = query.getCursor(state);
          let seen = 0; let last = 0;
          for (let step = cursor.next(); !step.done && seen < MATCH_CAP; step = cursor.next(), seen++) {
            const line = state.doc.lineAt(step.value.from).number;
            if (line !== last) { lines.push(line); last = line; }
          }
        }
      }
      this.matches = lines;
    }

    color(name) {
      if (!this.colors.has(name)) this.colors.set(name, getComputedStyle(this.view.dom).getPropertyValue(name).trim() || '#888');
      return this.colors.get(name);
    }

    read(view) {
      const scroller = view.scrollDOM;
      const { doc } = view.state;
      const top = scroller.getBoundingClientRect().top - view.documentTop;
      return {
        height: this.dom.clientHeight,
        scrollTop: scroller.scrollTop,
        scrollMax: scroller.scrollHeight - scroller.clientHeight,
        topLine: doc.lineAt(view.lineBlockAtHeight(top).from).number,
        bottomLine: doc.lineAt(view.lineBlockAtHeight(top + scroller.clientHeight).from).number,
      };
    }

    draw(geometry) {
      const { view, canvas } = this;
      const { state } = view;
      const { doc } = state;
      const { width, row, block, char, strip, gap, tick } = MINIMAP;
      const height = geometry.height;
      if (height <= 0) return;
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const w = Math.round(width * ratio); const h = Math.round(height * ratio);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const shown = minimapWindow({ lines: doc.lines, height, scrollTop: geometry.scrollTop, scrollMax: geometry.scrollMax });
      this.window = shown;
      const end = shown.first + shown.count;   // not included
      const from = doc.line(shown.first).from;
      const to = doc.line(end - 1).to;

      const left = strip + gap;
      const maxColumns = Math.floor((width - left - tick) / char);
      // A character takes a column at least: no more of a line than there are columns is ever drawn.
      const scan = Math.min(LINE_SCAN, maxColumns);
      const texts = [];
      const lengths = [];
      for (const text of doc.iterLines(shown.first, end)) {
        lengths.push(text.length);
        texts.push(text.length > scan ? text.slice(0, scan) : text);
      }
      // The token colours of what is drawn, from the tree the editor has parsed so far.
      const spans = tokenSpans(cm, { tree: cm.syntaxTree(state), highlighter, ranges: highlightRanges({ from, lengths, limit: scan }), colorOf: (name) => this.color(name) });
      const plain = this.color('--ed-fg');

      // What is known about its lines.
      const changed = new Map();
      git?.between(state, from, to, (at, kind) => changed.set(doc.lineAt(at).number, kind));
      const broken = new Set();
      problems?.each(state, (start, stop) => {
        if (stop < from || start > to) return;
        const lastLine = doc.lineAt(Math.min(stop, to)).number;
        for (let n = doc.lineAt(Math.max(start, from)).number; n <= lastLine; n++) broken.add(n);
      });
      const matched = new Set();
      for (const line of this.matches) { if (line >= end) break; if (line >= shown.first) matched.add(line); }

      const tabSize = state.tabSize;
      const gitColor = { added: this.color('--ed-add'), modified: this.color('--ed-warn'), deleted: this.color('--ed-del') };
      let at = from;      // the document position of the line being drawn
      let span = 0;       // the first span that may reach into it
      for (let n = shown.first; n < end; n++) {
        const text = texts[n - shown.first] || '';
        const y = (n - shown.first) * row;
        ctx.globalAlpha = 1;
        const kind = changed.get(n);
        if (kind) { ctx.fillStyle = gitColor[kind]; ctx.fillRect(0, y, strip, kind === 'deleted' ? 1 : row); }
        if (broken.has(n)) { ctx.fillStyle = this.color('--ed-error'); ctx.fillRect(width - tick, y, tick, block); }
        else if (matched.has(n)) { ctx.fillStyle = this.color('--ed-minimap-match'); ctx.fillRect(width - tick, y, tick, block); }
        if (text) {
          const start = at;
          const colorAt = (index) => {
            const position = start + index;
            while (span < spans.length && spans[span + 1] <= position) span += 3;
            return span < spans.length && spans[span] <= position ? spans[span + 2] : plain;
          };
          ctx.globalAlpha = 0.65;
          for (const run of lineRuns(text, { tabSize, maxColumns, colorAt })) {
            ctx.fillStyle = run.color;
            ctx.fillRect(left + run.column * char, y, Math.min(run.width, maxColumns - run.column) * char, block);
          }
        }
        at += (lengths[n - shown.first] || 0) + 1;
      }
      ctx.globalAlpha = 1;

      // The part that is in view. With nothing to scroll there is no part to point out.
      const box = minimapBox({ ...shown, topLine: geometry.topLine, bottomLine: geometry.bottomLine });
      this.box = { ...box, shown: geometry.scrollMax > 0 };
      this.slider.style.display = this.box.shown ? '' : 'none';
      this.slider.style.top = `${box.top}px`;
      this.slider.style.height = `${box.height}px`;
      this.extent = Math.min(height, shown.count * row);
    }

    // The pointer `y` pixels down the minimap, the box held `grab` pixels from its top: scroll so it is there.
    follow(y, grab) {
      const scroller = this.view.scrollDOM;
      const room = (this.extent || 0) - this.box.height;
      const max = scroller.scrollHeight - scroller.clientHeight;
      if (max <= 0) return;
      const ratio = room > 0 ? Math.min(1, Math.max(0, (y - grab) / room)) : 0;
      scroller.scrollTop = ratio * max;
    }

    pointerDown(event) {
      if (event.button !== 0) return;
      event.preventDefault();   // the keyboard stays in the text
      const y = event.clientY - this.dom.getBoundingClientRect().top;
      const onBox = this.box.shown && y >= this.box.top && y <= this.box.top + this.box.height;
      if (!onBox) {
        // A click beside the box: that line goes to the middle of the view.
        const line = minimapLineAt({ y, ...this.window });
        const { doc } = this.view.state;
        this.view.dispatch({ effects: EditorView.scrollIntoView(doc.line(Math.min(line, doc.lines)).from, { y: 'center' }) });
      }
      this.drag = { grab: onBox ? y - this.box.top : this.box.height / 2, moved: false };
      this.dom.classList.add('cm-minimap-dragging');
      try { this.dom.setPointerCapture(event.pointerId); } catch { /* the pointer is gone already */ }
    }

    pointerMove(event) {
      if (!this.drag) return;
      this.drag.moved = true;
      this.follow(event.clientY - this.dom.getBoundingClientRect().top, this.drag.grab);
    }

    pointerUp(event) {
      if (!this.drag) return;
      this.drag = null;
      this.dom.classList.remove('cm-minimap-dragging');
      try { this.dom.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
    }

    destroy() {
      clearTimeout(this.matchTimer);
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
      this.dom.remove();
    }
  });

  return {
    /** The minimap, for the view's minimap compartment. */
    extension: [plugin, EditorView.scrollMargins.of(() => ({ right: MINIMAP.width }))],
  };
}
