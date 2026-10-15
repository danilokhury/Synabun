// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: which lines differ from the last commit
// ═══════════════════════════════════════════
//
// The decisions behind the git markers (editor-git.js draws them): what the
// server said about a file's committed version, which lines of the document
// differ from it, and what the gutter shows for them. A line comparison by the
// O(ND) method, bounded: beyond its limit the stretch that differs is marked as
// one change instead of being taken apart. No DOM and no imports: loaded by
// `node --test` as it is.

/** Edits a comparison takes apart; a stretch that needs more is one "modified" block. */
export const DIFF_MAX_EDITS = 1500;

/**
 * What GET /api/file-head answered.
 * @param {{ status?: number, body?: object | null }} response
 * @returns {{ tracked: boolean, text: string | null }} `text`: the committed version, line breaks as "\n"; null
 *   when git does not know the file, when what it holds is not text, or when the server could not say
 */
export function readHeadResponse({ status = 0, body = null } = {}) {
  if (status !== 200 || body?.ok !== true || body.tracked !== true) return { tracked: false, text: null };
  if (typeof body.content !== 'string') return { tracked: true, text: null };
  return { tracked: true, text: body.content.replace(/\r\n?/g, '\n') };
}

/**
 * The stretches where two lists of lines differ.
 * @param {string[]} before the committed lines
 * @param {string[]} after the document's lines
 * @param {{ maxEdits?: number }} [o]
 * @returns {{ aFrom: number, aTo: number, bFrom: number, bTo: number }[]} in order; each replaces lines
 *   `aFrom`..`aTo` of `before` with lines `bFrom`..`bTo` of `after` (0-based, the end not included)
 */
export function diffLines(before, after, { maxEdits = DIFF_MAX_EDITS } = {}) {
  const a = before; const b = after;
  let start = 0;
  const shortest = Math.min(a.length, b.length);
  while (start < shortest && a[start] === b[start]) start++;
  let endA = a.length; let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  if (start === endA && start === endB) return [];
  const whole = [{ aFrom: start, aTo: endA, bFrom: start, bTo: endB }];
  if (start === endA || start === endB) return whole;

  // The middle, each distinct line as a number: comparing lines is then comparing numbers.
  const ids = new Map();
  const intern = (line) => { let id = ids.get(line); if (id === undefined) { id = ids.size; ids.set(line, id); } return id; };
  const n = endA - start; const m = endB - start;
  const x0 = new Int32Array(n); const y0 = new Int32Array(m);
  for (let i = 0; i < n; i++) x0[i] = intern(a[start + i]);
  for (let i = 0; i < m; i++) y0[i] = intern(b[start + i]);

  const max = Math.min(n + m, Math.max(1, maxEdits));
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));   // the furthest points before this round, for the way back
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && x0[x] === y0[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return whole;

  // Back from the end: the lines both have are what separates one stretch from the next.
  const hunks = [];
  let open = null;
  const edit = (x, y, dx, dy) => {
    if (open && open.aFrom === x + dx && open.bFrom === y + dy) { open.aFrom = x; open.bFrom = y; return; }
    open = { aFrom: x, aTo: x + dx, bFrom: y, bTo: y + dy };
    hunks.push(open);
  };
  let x = n; let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const at = (k) => prev[k + d];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    if (down) edit(prevX, prevY, 0, 1);   // a line of `after` that `before` does not have
    else edit(prevX, prevY, 1, 0);        // a line of `before` that is gone
    x = prevX; y = prevY;
  }
  return hunks.reverse().map((hunk) => ({ aFrom: hunk.aFrom + start, aTo: hunk.aTo + start, bFrom: hunk.bFrom + start, bTo: hunk.bTo + start }));
}

/**
 * What the gutter shows for the stretches diffLines() found.
 * @param {{ aFrom: number, aTo: number, bFrom: number, bTo: number }[]} hunks
 * @param {number} lineCount lines in the document
 * @returns {{ from: number, to: number, kind: 'added' | 'modified' | 'deleted', after?: boolean }[]} `from`..`to`:
 *   lines of the document, 1-based, both included. `deleted` marks one line: the one committed lines were removed
 *   in front of, or (with `after`) the last line when they were removed behind it.
 */
export function lineMarks(hunks, lineCount) {
  const marks = [];
  const last = Math.max(1, lineCount);
  for (const hunk of hunks) {
    if (hunk.bTo > hunk.bFrom) {
      marks.push({ from: hunk.bFrom + 1, to: hunk.bTo, kind: hunk.aTo > hunk.aFrom ? 'modified' : 'added' });
    } else if (hunk.aTo > hunk.aFrom) {
      const after = hunk.bFrom >= last;
      marks.push({ from: after ? last : hunk.bFrom + 1, to: after ? last : hunk.bFrom + 1, kind: 'deleted', ...(after ? { after: true } : {}) });
    }
  }
  return marks;
}

/**
 * The marks for a document against its committed version.
 * @param {string[]} headLines the committed lines
 * @param {string[]} lines the document's lines
 */
export function gitMarks(headLines, lines, options) {
  return lineMarks(diffLines(headLines, lines, options), lines.length);
}

/** How many lines each kind of mark covers: `{ added, modified, deleted }` (`deleted` counts places, not lines). */
export function countMarks(marks) {
  const count = { added: 0, modified: 0, deleted: 0 };
  for (const mark of marks) count[mark.kind] += mark.kind === 'deleted' ? 1 : mark.to - mark.from + 1;
  return count;
}
