// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: a file as it is on disk and as it is edited
// ═══════════════════════════════════════════
//
// A <textarea> holds every line break as "\n" and shows a byte-order mark as an invisible first character. A
// file is edited in that form, and written back as it was: the mark when it had one, and each line that is
// still there with the line ending it had (a file that mixes CRLF and LF keeps the mix). A line the user wrote
// takes the ending most of the file uses. Opening a file, switching tabs or saving it unchanged writes nothing
// new: the bytes that come back are the bytes that were read.
//
// Also here: whether bytes are text that can be edited at all (a PNG cannot), and the revision of a text. No
// DOM and no imports: loaded by `node --test` as it is, and by the server for the text check.

export const BOM = '﻿';

/** The lines of a text with the line break that ends each one ('' for the last). `\r\n`, `\n` and a lone `\r` are breaks. */
export function splitLines(text) {
  const s = String(text ?? '');
  const lines = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 13) {
      const eol = s.charCodeAt(i + 1) === 10 ? '\r\n' : '\r';
      lines.push({ text: s.slice(start, i), eol });
      i += eol.length - 1;
      start = i + 1;
    } else if (c === 10) {
      lines.push({ text: s.slice(start, i), eol: '\n' });
      start = i + 1;
    }
  }
  lines.push({ text: s.slice(start), eol: '' });
  return lines;
}

/** The line ending most lines of a text end with ("\n" when none leads, or there are none). */
export function dominantEol(lines) {
  let crlf = 0; let lf = 0; let cr = 0;
  for (const line of lines) {
    if (line.eol === '\r\n') crlf++;
    else if (line.eol === '\n') lf++;
    else if (line.eol === '\r') cr++;
  }
  if (crlf > lf && crlf >= cr) return '\r\n';
  if (cr > lf && cr > crlf) return '\r';
  return '\n';
}

/**
 * The text as it is edited: no byte-order mark, every line break "\n".
 * @returns {{ text: string, bom: boolean, eol: '\n' | '\r\n' | '\r', mixed: boolean }}
 */
export function toEditing(raw) {
  const s = String(raw ?? '');
  const bom = s.charCodeAt(0) === 0xFEFF;
  const lines = splitLines(bom ? s.slice(1) : s);
  const kinds = new Set(lines.filter((l) => l.eol).map((l) => l.eol));
  return { text: lines.map((l) => l.text).join('\n'), bom, eol: dominantEol(lines), mixed: kinds.size > 1 };
}

/** Whether the edited text is what the file holds (line endings and the byte-order mark aside). */
export function sameAsSaved(savedRaw, editedText) {
  return toEditing(savedRaw).text === String(editedText ?? '').replace(/\r\n?/g, '\n');
}

/** Edits further apart than this many changed lines in the middle of a file get the file's own ending, not each line's. */
export const MAX_ALIGNED_EDITS = 1000;

/**
 * The lines two lists have in common, in order (a longest common subsequence, by Myers' algorithm): pairs of
 * indexes `[i in a, j in b]`. Null when the lists differ by more than `maxEdits` inserted or removed lines.
 */
export function commonLines(a, b, maxEdits = MAX_ALIGNED_EDITS) {
  const n = a.length; const m = b.length;
  const maxD = Math.min(n + m, maxEdits);
  const off = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace = [];   // trace[d]: v for k in [-d-1, d+1] as it was when step d began
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) {
        // Back through the steps: every diagonal move is a line both lists keep.
        const kept = [];
        let cx = n; let cy = m;
        for (let s = d; s >= 0; s--) {
          const win = trace[s];
          const at = (kk) => win[kk + s + 1];
          const kk = cx - cy;
          const prevK = (kk === -s || (kk !== s && at(kk - 1) < at(kk + 1))) ? kk + 1 : kk - 1;
          const px = at(prevK);
          const py = px - prevK;
          while (cx > px && cy > py) { kept.push([cx - 1, cy - 1]); cx--; cy--; }
          if (s > 0) { cx = px; cy = py; }
        }
        return kept.reverse();
      }
    }
  }
  return null;
}

/**
 * The text to write: the edited text with the file's byte-order mark and line endings put back.
 * @param {string} savedRaw the file as it was read (or last saved)
 * @param {string} editedText the editor's text ("\n" line breaks)
 * @returns {string} exactly `savedRaw` when nothing but line breaks differs
 */
export function fromEditing(savedRaw, editedText) {
  const saved = String(savedRaw ?? '');
  const edited = String(editedText ?? '').replace(/\r\n?/g, '\n');
  const bom = saved.charCodeAt(0) === 0xFEFF;
  const before = splitLines(bom ? saved.slice(1) : saved);
  const beforeText = before.map((l) => l.text);
  const after = edited.split('\n');
  if (beforeText.join('\n') === edited) return saved;
  const fallback = dominantEol(before);
  const eols = new Array(after.length).fill(null);
  // The same lines at the start and at the end keep their endings; what lies between is aligned line by line.
  let head = 0;
  const shorter = Math.min(before.length, after.length);
  while (head < shorter && beforeText[head] === after[head]) { eols[head] = before[head].eol; head++; }
  let tail = 0;
  while (tail < shorter - head && beforeText[before.length - 1 - tail] === after[after.length - 1 - tail]) {
    eols[after.length - 1 - tail] = before[before.length - 1 - tail].eol;
    tail++;
  }
  const midBefore = beforeText.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);
  if (midBefore.length && midAfter.length) {
    const kept = commonLines(midBefore, midAfter, MAX_ALIGNED_EDITS);
    if (kept) for (const [i, j] of kept) eols[head + j] = before[head + i].eol;
  }
  const last = after.length - 1;
  const out = after.map((line, i) => {
    let eol = eols[i];
    if (i === last) eol = '';
    else if (!eol) eol = fallback;   // a new line, or one that was last and is not any more
    return line + eol;
  });
  return (bom ? BOM : '') + out.join('');
}

// ── Text or not ──

const TEXT_DECODER = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;

/**
 * Whether bytes are text the editor can show and write back unchanged: UTF-8, and no control byte a text file
 * does not hold (NUL and the like; tab, line breaks, form feed and escape are text). A PNG, a PDF, a font, a
 * compiled program are not.
 * @param {Uint8Array} bytes
 */
export function isEditableText(bytes) {
  if (!bytes || typeof bytes.length !== 'number') return false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x09 || (b > 0x0D && b < 0x20 && b !== 0x1B)) return false;
  }
  if (!TEXT_DECODER) return true;
  try { TEXT_DECODER.decode(bytes); return true; } catch { return false; }
}

/** A string that came back from a server that decoded bytes as UTF-8 without checking: it holds what decoding replaced. */
export function looksDecodedFromBinary(text) {
  const s = String(text ?? '');
  return s.includes('\u0000') || s.includes('�');
}
