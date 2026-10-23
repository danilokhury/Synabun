// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: differences, as rows to draw
// ═══════════════════════════════════════════
//
// Two sources of a diff: the service's (GET /v2/diff between revisions, GET /v2/compare between a revision and a
// folder: files with unified hunks, lib/skills/library.js), and one worked out here between two texts the page
// holds (a draft's file against its version, an installed SKILL.md against the shipped one), with the same line
// alignment the editor uses to keep line endings (ss-doc.js commonLines, Myers). Both end as the same rows: one
// per line, marked added, removed or context, with its line numbers. No DOM; imports only ss-doc.js.

import { commonLines } from '../ss-doc.js';

export const CONTEXT_LINES = 3;
export const MAX_DIFF_EDITS = 4000;

/**
 * The difference of two texts as hunks of rows, or `tooFar: true` when they differ in more lines than are aligned.
 * @returns {{ hunks: { header: string, rows: { t: ' '|'+'|'-', text: string, a: number|null, b: number|null }[] }[],
 *   added: number, removed: number, same: boolean, tooFar: boolean }}
 */
export function lineDiff(before, after, { context = CONTEXT_LINES, maxEdits = MAX_DIFF_EDITS } = {}) {
  const a = String(before ?? '').replace(/\r\n?/g, '\n').split('\n');
  const b = String(after ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (a.join('\n') === b.join('\n')) return { hunks: [], added: 0, removed: 0, same: true, tooFar: false };
  const kept = commonLines(a, b, maxEdits);
  if (!kept) return { hunks: [], added: 0, removed: 0, same: false, tooFar: true };
  // The edit script: every line of `a` is kept or removed, every line of `b` kept or added, in order.
  const ops = [];
  let i = 0; let j = 0;
  const removeTo = (end) => { for (; i < end; i++) ops.push({ t: '-', text: a[i], a: i + 1, b: null }); };
  const addTo = (end) => { for (; j < end; j++) ops.push({ t: '+', text: b[j], a: null, b: j + 1 }); };
  for (const [ka, kb] of kept) {
    removeTo(ka);
    addTo(kb);
    ops.push({ t: ' ', text: a[i], a: i + 1, b: j + 1 });
    i++; j++;
  }
  removeTo(a.length);
  addTo(b.length);
  const added = ops.filter((o) => o.t === '+').length;
  const removed = ops.filter((o) => o.t === '-').length;
  return { hunks: groupHunks(ops, context), added, removed, same: false, tooFar: false };
}

/** Changed rows with `context` rows around them; two changes closer than twice that share a hunk. */
function groupHunks(ops, context) {
  const changed = [];
  ops.forEach((o, k) => { if (o.t !== ' ') changed.push(k); });
  const groups = [];
  for (const k of changed) {
    const last = groups[groups.length - 1];
    if (last && k - last.end <= context * 2 + 1) last.end = k;
    else groups.push({ start: k, end: k });
  }
  return groups.map(({ start, end }) => {
    const rows = ops.slice(Math.max(0, start - context), Math.min(ops.length, end + 1 + context));
    const aRows = rows.filter((r) => r.t !== '+');
    const bRows = rows.filter((r) => r.t !== '-');
    const aStart = aRows.find((r) => r.a !== null)?.a ?? 0;
    const bStart = bRows.find((r) => r.b !== null)?.b ?? 0;
    return { header: `@@ -${aStart},${aRows.length} +${bStart},${bRows.length} @@`, rows };
  });
}

/** A hunk of the service (`{ header, lines: ['+x', '-y', ' z'] }`) as rows with line numbers. */
export function serviceHunkRows(hunk) {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(String(hunk?.header ?? ''));
  let a = m ? Number(m[1]) : 1;
  let b = m ? Number(m[2]) : 1;
  const rows = [];
  for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
    const t = line[0] === '+' || line[0] === '-' ? line[0] : ' ';
    const text = String(line).slice(1).replace(/\r$/, '');   // a CRLF line's \r is not shown (the file's line endings are said once)
    if (t === '+') rows.push({ t, text, a: null, b: b++ });
    else if (t === '-') rows.push({ t, text, a: a++, b: null });
    else rows.push({ t, text, a: a++, b: b++ });
  }
  return { header: String(hunk?.header ?? ''), rows };
}

/** What a service diff changed, file by file: counts and each file's rows (text files with hunks). */
export function serviceDiff(diff) {
  const files = (Array.isArray(diff?.files) ? diff.files : []).map((f) => {
    const hunks = Array.isArray(f.hunks) ? f.hunks.map(serviceHunkRows) : [];
    const added = hunks.reduce((n, h) => n + h.rows.filter((r) => r.t === '+').length, 0);
    const removed = hunks.reduce((n, h) => n + h.rows.filter((r) => r.t === '-').length, 0);
    const eol = f.before?.eol && f.after?.eol && f.before.eol !== f.after.eol ? { from: String(f.before.eol), to: String(f.after.eol) } : null;
    return { path: String(f.path ?? ''), status: f.status, hunks, added, removed, note: f.note || null, before: f.before || null, after: f.after || null, eol };
  });
  return {
    same: !!diff?.same || files.length === 0,
    files,
    unchanged: Number(diff?.unchanged) || 0,
    counts: {
      added: files.filter((f) => f.status === 'added').length,
      removed: files.filter((f) => f.status === 'removed').length,
      modified: files.filter((f) => f.status === 'modified' || f.status === 'mode').length,
    },
  };
}

/** The changed files of a draft against a revision: by each file's digest (the same bytes are the same file). */
export function changedFiles(fromFiles = [], toFiles = []) {
  const a = new Map((fromFiles || []).map((f) => [f.path, f.digest]));
  const b = new Map((toFiles || []).map((f) => [f.path, f.digest]));
  const out = [];
  for (const [path, digest] of b) {
    if (!a.has(path)) out.push({ path, status: 'added' });
    else if (a.get(path) !== digest) out.push({ path, status: 'modified' });
  }
  for (const path of a.keys()) if (!b.has(path)) out.push({ path, status: 'removed' });
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** A service diff read the other way round (from `to` back to `from`): what an update changes, from a copy's side. */
export function invertDiff(diff) {
  const flip = { added: 'removed', removed: 'added' };
  return {
    ...diff,
    from: diff?.to || null,
    to: diff?.from || null,
    files: (Array.isArray(diff?.files) ? diff.files : []).map((f) => ({
      ...f,
      status: flip[f.status] || f.status,
      before: f.after || null,
      after: f.before || null,
      hunks: Array.isArray(f.hunks) ? f.hunks.map((h) => {
        const m = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/.exec(String(h.header ?? ''));
        return { header: m ? `@@ -${m[2]} +${m[1]} @@` : h.header, lines: (h.lines || []).map((l) => (l[0] === '+' ? `-${l.slice(1)}` : l[0] === '-' ? `+${l.slice(1)}` : l)) };
      }) : f.hunks,
    })),
  };
}
