// ═══════════════════════════════════════════
// SynaBun — Antigravity panel: a file change as unified diff rows (no DOM)
// ═══════════════════════════════════════════
//
// An ACP tool call reports a change as `{ type: 'diff', path, oldText, newText }`
// (oldText null for a new file). This module turns one into the rows the panel
// draws: hunks with three lines of context, each row with its old and new line
// number, a sign and its text, plus the counts. Myers' algorithm on the lines
// between the common head and tail; a change too large to diff within the
// bounds is shown as the old text removed and the new text added, and says so.
// Imported by the page and by `node --test`.

export const DIFF_LIMITS = Object.freeze({
  maxChars: 200_000,   // per side; more is shown truncated
  maxLines: 2000,      // per side
  maxEdits: 1000,      // Myers' D: beyond it the change is "replace everything"
  context: 3,
  previewRows: 60,     // rows drawn before "Show the whole diff"
});

const splitLines = (text) => {
  const value = String(text ?? '');
  if (!value) return [];
  const lines = value.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/**
 * Myers' O(ND) diff of two line arrays. Returns the edit script as
 * [{ op: 'equal' | 'delete' | 'insert', a, b }] (a / b: indexes into the
 * arrays), or null when it needs more than `maxEdits` edits.
 */
export function myersDiff(a, b, maxEdits = DIFF_LIMITS.maxEdits) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const limit = Math.min(max, maxEdits);
  const offset = limit + 1;
  let v = new Int32Array(2 * limit + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1 < 0 ? 0 : offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // Walk the trace back from (n, m).
  const script = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    const base = offset - d - 1 < 0 ? 0 : offset - d - 1;
    const at = (k) => prev[offset + k - base];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x -= 1; y -= 1; script.push({ op: 'equal', a: x, b: y }); }
    if (x === prevX) { y -= 1; script.push({ op: 'insert', a: x, b: y }); }
    else { x -= 1; script.push({ op: 'delete', a: x, b: y }); }
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; script.push({ op: 'equal', a: x, b: y }); }
  return script.reverse();
}

function clip(text, maxChars) {
  const value = String(text ?? '');
  return value.length > maxChars ? { text: value.slice(0, maxChars), clipped: true } : { text: value, clipped: false };
}

/**
 * One ACP diff as rows:
 * { path, status: 'added' | 'modified' | 'deleted', added, removed, rows: [{ kind: 'hunk' | 'context' | 'add' |
 *   'delete' | 'note', old, new, text }], truncated, fallback, identical }
 */
export function diffView(item, limits = DIFF_LIMITS) {
  const path = String(item?.path || '');
  const oldRaw = item?.oldText;
  const isNew = oldRaw === null || oldRaw === undefined;
  const oldClip = clip(isNew ? '' : oldRaw, limits.maxChars);
  const newClip = clip(item?.newText ?? '', limits.maxChars);
  let oldLines = splitLines(oldClip.text);
  let newLines = splitLines(newClip.text);
  let truncated = oldClip.clipped || newClip.clipped;
  if (oldLines.length > limits.maxLines) { oldLines = oldLines.slice(0, limits.maxLines); truncated = true; }
  if (newLines.length > limits.maxLines) { newLines = newLines.slice(0, limits.maxLines); truncated = true; }
  const status = isNew ? 'added' : (!newLines.length && oldLines.length ? 'deleted' : 'modified');

  // The common head and tail never take part in the edit search.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (tail < oldLines.length - head && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail += 1;
  const midA = oldLines.slice(head, oldLines.length - tail);
  const midB = newLines.slice(head, newLines.length - tail);
  let middle = myersDiff(midA, midB, limits.maxEdits);
  const fallback = middle === null;
  if (fallback) middle = [...midA.map((_, a) => ({ op: 'delete', a, b: 0 })), ...midB.map((_, b) => ({ op: 'insert', a: midA.length, b }))];
  const ops = [];
  for (let i = 0; i < head; i += 1) ops.push({ op: 'equal', a: i, b: i });
  for (const step of middle) ops.push({ op: step.op, a: step.a + head, b: step.b + head });
  for (let i = 0; i < tail; i += 1) ops.push({ op: 'equal', a: oldLines.length - tail + i, b: newLines.length - tail + i });

  let added = 0;
  let removed = 0;
  for (const step of ops) { if (step.op === 'insert') added += 1; else if (step.op === 'delete') removed += 1; }
  const identical = added === 0 && removed === 0;

  // Hunks: every change with `context` equal lines around it; runs closer than twice that merge.
  const rows = [];
  const changeAt = ops.map((step) => step.op !== 'equal');
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i += 1) {
    if (!changeAt[i]) continue;
    for (let j = Math.max(0, i - limits.context); j <= Math.min(ops.length - 1, i + limits.context); j += 1) keep[j] = true;
  }
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) { i += 1; continue; }
    let end = i;
    while (end + 1 < ops.length && keep[end + 1]) end += 1;
    const first = ops[i];
    let oldStart = first.op === 'insert' ? first.a : first.a;
    let newStart = first.op === 'delete' ? first.b : first.b;
    let oldCount = 0;
    let newCount = 0;
    for (let j = i; j <= end; j += 1) {
      if (ops[j].op !== 'insert') oldCount += 1;
      if (ops[j].op !== 'delete') newCount += 1;
    }
    rows.push({ kind: 'hunk', old: null, new: null, text: `@@ -${oldCount ? oldStart + 1 : oldStart},${oldCount} +${newCount ? newStart + 1 : newStart},${newCount} @@` });
    for (let j = i; j <= end; j += 1) {
      const step = ops[j];
      if (step.op === 'equal') rows.push({ kind: 'context', old: step.a + 1, new: step.b + 1, text: oldLines[step.a] });
      else if (step.op === 'delete') rows.push({ kind: 'delete', old: step.a + 1, new: null, text: oldLines[step.a] });
      else rows.push({ kind: 'add', old: null, new: step.b + 1, text: newLines[step.b] });
    }
    i = end + 1;
  }
  if (truncated) rows.push({ kind: 'note', old: null, new: null, text: 'truncated' });
  return { path, status, added, removed, rows, truncated, fallback, identical };
}

/** Counts over several diffs: { files, added, removed }. */
export function diffTotals(views) {
  const list = Array.isArray(views) ? views : [];
  return list.reduce((sum, view) => ({ files: sum.files + 1, added: sum.added + (view?.added || 0), removed: sum.removed + (view?.removed || 0) }), { files: 0, added: 0, removed: 0 });
}
