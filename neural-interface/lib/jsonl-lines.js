// ═══════════════════════════════════════════
// SynaBun — JSON-lines reading that survives U+2028 / U+2029
// ═══════════════════════════════════════════
//
// node:readline ends a line at \n, \r\n, \r — and also at U+2028 and U+2029.
// Those two are legal, unescaped, inside a JSON string (JSON.stringify and
// serde_json both emit them raw), so a JSON-lines reader built on readline
// splits any record whose text holds one, and JSON.parse fails on the halves.
// Seen on 2026-09-24: @openai/codex-sdk reads `codex exec --json` that way, and
// a command whose output held U+2028 ended the Codex worker with
// "Failed to parse item"; the session-history endpoint silently dropped such
// transcript lines.

/**
 * Lines of a text stream (or any async iterable of string chunks), split on
 * "\n" only; a trailing "\r" is removed. The last line is yielded even without
 * a final newline.
 */
export async function* jsonlLines(chunks) {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : String(chunk);
    let start = 0;
    let index;
    while ((index = buffer.indexOf('\n', start)) !== -1) {
      const line = buffer.slice(start, index);
      start = index + 1;
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
    buffer = buffer.slice(start);
  }
  if (buffer) yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
}

function isRecord(text) {
  if (!text.startsWith('{')) return false;
  try {
    const value = JSON.parse(text);
    return !!value && typeof value === 'object' && !Array.isArray(value);
  } catch { return false; }
}

/**
 * Wrap an async generator of JSON-lines that some reader already split at
 * U+2028 / U+2029 (readline): fragments of one record are joined back — with
 * U+2028, since the reader dropped whichever separator it was — until they
 * parse. Lines that are whole records, and anything that does not start like a
 * record, pass through untouched, so a reader that throws on a bad line still
 * throws on it. A buffer past `maxChars` is handed over as it is.
 *
 * @param {(...args: any[]) => AsyncIterable<string>} run  e.g. codex.exec.run bound to its exec
 * @returns {(...args: any[]) => AsyncGenerator<string>}
 */
export function rejoinSplitJsonLines(run, { maxChars = 8 * 1024 * 1024 } = {}) {
  return async function* rejoined(...args) {
    let pending = null;
    for await (const raw of run(...args)) {
      const line = typeof raw === 'string' ? raw : String(raw);
      if (pending === null) {
        // A record's first fragment starts with "{" and does not parse.
        if (line.startsWith('{') && !isRecord(line)) { pending = line; continue; }
        yield line;
        continue;
      }
      const joined = `${pending}\u2028${line}`;
      if (isRecord(joined)) { pending = null; yield joined; continue; }
      if (isRecord(line)) {
        // What was pending was not a split record: hand both over as they came.
        const stale = pending;
        pending = null;
        yield stale;
        yield line;
        continue;
      }
      if (joined.length > maxChars) { pending = null; yield joined; continue; }
      pending = joined;
    }
    if (pending !== null) yield pending;
  };
}

/**
 * Patch a @openai/codex-sdk `Codex` instance so its threads survive U+2028 /
 * U+2029 in command output. The SDK passes the same `exec` object to every
 * Thread, so patching it once covers them all. Returns false (and changes
 * nothing) when the SDK no longer has that shape.
 */
export function patchCodexLineSplitting(codex) {
  const exec = codex?.exec;
  if (!exec || typeof exec.run !== 'function' || exec.__synabunRejoined) return false;
  exec.run = rejoinSplitJsonLines(exec.run.bind(exec));
  exec.__synabunRejoined = true;
  return true;
}
