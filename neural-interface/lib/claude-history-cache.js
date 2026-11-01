// ── Claude Code transcripts, parsed once ──
// GET /api/claude-code/sessions/:id/messages used to read and JSON.parse a
// session's whole JSONL on every request, and one session open makes several:
// the panel's snapshot probe (limit=1), the rebuild (limit=500), "load earlier",
// "show all" of a clipped result (?tool=). A transcript runs to tens of MB, and
// on Windows (slower file reads, every read scanned by the antivirus) each pass
// costs seconds. This keeps the collector of the last few transcripts read and,
// when the file grew, parses only what was appended.
//
// A kept collector is used only for the same file (device and inode) when
// everything it read is still there unchanged. Same size and time: reused as it
// is. Grown: the first HEAD_BYTES of the file and the last TAIL_BYTES before
// where the last read stopped must still be what was read (a rewrite followed by
// growth changes one of them). Any other change (shorter, same size with a new
// time, an edit in place) reads the file again from the start. Only whole lines are taken: a last line
// still being written (no newline yet, and not JSON yet) is read next time.
// The file is always opened through openConfinedStream, from the canonical
// paths findSessionTranscript checked.

import { statSync } from 'node:fs';
import { openConfinedStream } from './confined-fs.js';
import { createHistoryCollector } from './claude-history.js';

const NEWLINE = 0x0a;
const TAIL_BYTES = 4096;
const HEAD_BYTES = 4096;
export const HISTORY_CACHE_LIMITS = Object.freeze({
  maxEntries: 4,
  maxIdleMs: 10 * 60_000,
  // A bigger transcript is still answered, from a fresh read each time: it is not kept in memory.
  maxCachedBytes: 256 * 1024 * 1024,
  // All kept transcripts together (bytes parsed, a stand-in for the rows they hold): the least recently used go first.
  maxTotalBytes: 384 * 1024 * 1024,
});

function parseLine(buf, collector) {
  let text = buf.toString('utf-8');
  if (text.endsWith('\r')) text = text.slice(0, -1);
  if (!text.trim()) return true;
  try { collector.add(JSON.parse(text)); return true; } catch { return false; }
}

/**
 * Read `found.realPath` from `from` (an offset at a line start), feeding whole
 * lines to `collector`. With `expectTail`, the first bytes read must equal it
 * (the bytes before the old end); otherwise nothing is added and `null` is
 * returned. Returns `{ offset, tail }`: where the next read starts, and the
 * bytes before it.
 */
async function readFrom(found, collector, { from = 0, expectTail = null, open }) {
  const skip = expectTail ? expectTail.length : 0;
  const stream = open(found.realFolder, found.realPath, { start: Math.max(0, from - skip) });
  let head = skip ? Buffer.alloc(0) : null; // collects the bytes to compare
  let carry = Buffer.alloc(0);
  let offset = from;
  let tail = expectTail || Buffer.alloc(0);
  let fileHead = from === 0 ? Buffer.alloc(0) : null; // the first bytes of the file, taken on a read from the start
  const consumed = (bytes) => {
    if (fileHead && fileHead.length < HEAD_BYTES) fileHead = Buffer.concat([fileHead, bytes.subarray(0, HEAD_BYTES - fileHead.length)]);
    offset += bytes.length;
    tail = Buffer.concat([tail, bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES))]);
    if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
  };
  try {
    for await (const raw of stream) {
      let chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf-8');
      if (head) {
        const need = skip - head.length;
        head = Buffer.concat([head, chunk.subarray(0, need)]);
        chunk = chunk.subarray(need);
        if (head.length < skip) continue;
        if (!head.equals(expectTail)) return null; // the file changed under what was read
        head = null;
      }
      let data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let start = 0;
      let index;
      while ((index = data.indexOf(NEWLINE, start)) !== -1) {
        parseLine(data.subarray(start, index), collector);
        consumed(data.subarray(start, index + 1));
        start = index + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
  } finally {
    stream.destroy?.();
  }
  if (head) return null; // the file ends before the bytes that were read last time
  // A last line without its newline: taken when it is whole JSON already, else read next time.
  if (carry.length && parseLine(carry, collector)) consumed(carry);
  return { offset, tail, head: fileHead };
}

/** The first `length` bytes of the file, or less when it is shorter. */
async function readHead(found, length, open) {
  if (!length) return Buffer.alloc(0);
  const stream = open(found.realFolder, found.realPath, { start: 0, end: length - 1 });
  const parts = [];
  let got = 0;
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf-8');
      parts.push(chunk); got += chunk.length;
      if (got >= length) break;
    }
  } finally { stream.destroy?.(); }
  return Buffer.concat(parts).subarray(0, length);
}

/**
 * @param o.open     (folder, file, options) => readable stream (openConfinedStream)
 * @param o.stat     (path) => fs.Stats
 * @param o.newCollector () => a history collector (lib/claude-history.js)
 */
export function createHistoryCache({
  open = openConfinedStream,
  stat = statSync,
  newCollector = createHistoryCollector,
  now = Date.now,
  limits = HISTORY_CACHE_LIMITS,
} = {}) {
  const entries = new Map(); // realPath → { dev, ino, size, mtimeMs, offset, tail, collector, usedAt }
  const running = new Map(); // realPath → promise of the collector being brought up to date
  const stats = { fresh: 0, appended: 0, reused: 0, reread: 0 };

  const evict = (keep = null) => {
    const at = now();
    for (const [key, entry] of entries) if (key !== keep && at - entry.usedAt > limits.maxIdleMs) entries.delete(key);
    while (entries.size > limits.maxEntries) entries.delete(entries.keys().next().value);
    const maxTotal = limits.maxTotalBytes ?? Infinity;
    let total = 0;
    for (const entry of entries.values()) total += entry.offset;
    for (const [key, entry] of entries) { // oldest first
      if (total <= maxTotal) break;
      entries.delete(key); total -= entry.offset;
    }
  };
  const touch = (key, entry) => {
    entry.usedAt = now();
    entries.delete(key); entries.set(key, entry); // most recently used last
    evict(key);
  };
  // Kept only while it fits: a transcript that grew past the limit is answered this once, then dropped.
  const fits = (size) => size <= limits.maxCachedBytes;

  async function update(found) {
    const key = found.realPath;
    evict(); // an idle entry goes before it could be reused
    const st = stat(key);
    let entry = entries.get(key) || null;
    if (entry && (entry.dev !== st.dev || entry.ino !== st.ino || st.size < entry.offset)) entry = null;
    if (entry && st.size === entry.size && st.mtimeMs === entry.mtimeMs) {
      stats.reused++;
      touch(key, entry);
      return entry.collector;
    }
    // Changed without growing (same size with a new time, an edit in place): nothing tells what changed.
    if (entry && st.size <= entry.size) { stats.reread++; entry = null; }
    if (entry) {
      let read = null;
      const head = entry.head.length ? await readHead(found, entry.head.length, open) : entry.head;
      if (head.equals(entry.head)) {
        read = await readFrom(found, entry.collector, { from: entry.offset, expectTail: entry.offset ? entry.tail : null, open });
      }
      if (read) {
        stats.appended++;
        Object.assign(entry, { size: st.size, mtimeMs: st.mtimeMs, offset: read.offset, tail: read.tail });
        if (fits(st.size)) touch(key, entry); else entries.delete(key);
        return entry.collector;
      }
      stats.reread++;
    }
    entries.delete(key);
    const collector = newCollector();
    const read = await readFrom(found, collector, { from: 0, open });
    stats.fresh++;
    if (read && fits(st.size)) {
      entries.set(key, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset: read.offset, tail: read.tail, head: read.head, collector, usedAt: now() });
      evict(key);
    }
    return collector;
  }

  return {
    /** The collector of the transcript `found` names, with every whole line it holds now. */
    async collectorFor(found) {
      const key = found?.realPath;
      if (!key || !found.realFolder) throw new Error('A checked transcript path is required.');
      // One read per file at a time: a second request waits for it and then checks again.
      while (running.has(key)) { try { await running.get(key); } catch {} }
      const job = update(found);
      running.set(key, job);
      try { return await job; } catch (err) { entries.delete(key); throw err; } finally { if (running.get(key) === job) running.delete(key); }
    },
    forget(realPath) { entries.delete(realPath); },
    /** Drop every kept transcript of a session (its file is `<sessionId>.jsonl`, in any project folder). */
    forgetSession(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return 0;
      let dropped = 0;
      for (const key of [...entries.keys()]) {
        const name = key.split(/[\\/]/).pop();
        if (name === `${sessionId}.jsonl`) { entries.delete(key); dropped++; }
      }
      return dropped;
    },
    clear() { entries.clear(); },
    get size() { return entries.size; },
    get stats() { return { ...stats }; },
  };
}
