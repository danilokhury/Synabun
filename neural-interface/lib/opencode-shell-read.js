// ─────────────────────────────────────────────────────────────────────────────
// A page of what a shell command of OpenCode 2 printed
//
// OpenCode 2 keeps a command's combined stdout and stderr, in the order
// written, and answers pages of it by byte position while the command runs and
// after (GET /api/shell/:id/output, lib/opencode2-client.js `shell.output`).
// The OpenCode side panel (`shell:output`, lib/opencode-v2-ws-requests.js) and
// the Assistant's OpenCode brain (lib/assistant-brains/opencode.js) both read
// it through here, so a page means the same in both: at most
// SHELL_OUTPUT_PAGE_BYTES, from a byte `cursor`, or the last `tail` bytes.
// Who may read which command is the caller's to decide before it asks.
// ─────────────────────────────────────────────────────────────────────────────

import { PAGE_CONTEXT_CHARS, scrubOutputWindow } from './terminal-token-redaction.js';

/** The most one read returns. */
export const SHELL_OUTPUT_PAGE_BYTES = 256 * 1024;

/** The least a scrubbed page asks for: never so small that a secret could fill it. */
export const SHELL_OUTPUT_PAGE_MIN_BYTES = 4096;

/** How many bytes after a page are read to tell whether a secret crosses its end (more than the longest form). */
const LOOKAHEAD_BYTES = PAGE_CONTEXT_CHARS * 2;

/** What a reader is told when OpenCode no longer has the output. */
export const SHELL_OUTPUT_GONE_TEXT = 'The output of that command is no longer available.';

const wholeNumber = (value) => Math.max(0, Math.floor(Number(value) || 0));

/**
 * `shell`: `{ output({ shellID, directory, cursor, limit }) → { status, data: { output, cursor, size } } }`
 * (a client's `extra.shell`). `cursor`: the byte to read from; `tail`: instead, the last so many bytes (a
 * reader that opens on a long output starts at its end). `errorText(body, fallback)` words a refusal.
 * → `{ status, data: { output, cursor, size, truncated, from } }`, or `{ ok: false, status, error }`.
 * A call that throws is the caller's to catch.
 */
export async function readShellOutputPage(shell, { shellID, directory, cursor, tail, limit } = {}, { errorText = (_body, fallback) => fallback } = {}) {
  const refused = (r) => ({ ok: false, status: r.status, error: errorText(r.data, SHELL_OUTPUT_GONE_TEXT) });
  const size = Math.min(SHELL_OUTPUT_PAGE_BYTES, Math.max(1, Math.floor(Number(limit) || SHELL_OUTPUT_PAGE_BYTES)));
  let from = wholeNumber(cursor);
  const last = wholeNumber(tail);
  if (last > 0) {
    // The size first (one byte asked for), then the page that ends at it.
    const probe = await shell.output({ shellID, directory, cursor: 0, limit: 1 });
    if (probe.status >= 400) return refused(probe);
    from = Math.max(0, (Number(probe.data?.size) || 0) - Math.min(last, size));
  }
  const r = await shell.output({ shellID, directory, cursor: from, limit: size });
  if (r.status >= 400) return refused(r);
  return { status: r.status, data: { ...r.data, from } };
}

/**
 * A page as a reader may be given it: scrubbed of SynaBun's run secrets with what lies on both sides of it, so that
 * the pages a reader joins never hold a secret whole (lib/terminal-token-redaction.js scrubOutputWindow). Both the
 * OpenCode side panel (`shell:output`) and the Assistant panel (assistant-runtime.js shellOutput) read through here.
 * `read({ cursor, limit })` → a raw page `{ status, data: { output, cursor, size } }` or a refusal. `running`: the
 * command may still write (an end that could become a secret waits for the next page; once it ended it is masked).
 * → `{ status, data: { output, cursor, size, from } }`, or the refusal of the read that failed (a failed look on
 * either side is a failed page: unread, it could let part of a secret through).
 */
export async function readSafeShellOutputPage(read, { cursor, tail, limit, running = false } = {}) {
  const bad = (r) => !r || r.ok === false || !(Number(r.status) < 400);
  const refusal = (r) => (r && r.ok === false ? r : { ok: false, status: Number(r?.status) >= 400 ? Number(r.status) : 502, error: r?.error || 'The output could not be read.' });
  const size = Math.min(SHELL_OUTPUT_PAGE_BYTES, Math.max(SHELL_OUTPUT_PAGE_MIN_BYTES, Math.floor(Number(limit) || SHELL_OUTPUT_PAGE_BYTES)));
  let from = wholeNumber(cursor);
  const last = wholeNumber(tail);
  if (last > 0) {
    const probe = await read({ cursor: 0, limit: 1 });
    if (bad(probe)) return refusal(probe);
    from = Math.max(0, (Number(probe.data?.size) || 0) - Math.min(last, size));
  }
  const r = await read({ cursor: from, limit: size });
  if (bad(r)) return refusal(r);
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  const output = typeof data.output === 'string' ? data.output : '';
  const next = Math.max(from, Number(data.cursor) || 0);
  let total = Math.max(next, Number(data.size) || 0);
  const extra = data.truncated === true ? { truncated: true } : {};
  if (!output) return { status: r.status, data: { output: '', cursor: next, size: total, from, ...extra } };
  let before = '';
  if (from > 0) {
    const start = Math.max(0, from - PAGE_CONTEXT_CHARS);
    const context = await read({ cursor: start, limit: from - start });
    if (bad(context)) return refusal(context);
    before = typeof context.data?.output === 'string' ? context.data.output : '';
  }
  let after = '';
  let aheadEnd = next;
  if (next < total) {
    const ahead = await read({ cursor: next, limit: LOOKAHEAD_BYTES });
    if (bad(ahead)) return refusal(ahead);
    after = typeof ahead.data?.output === 'string' ? ahead.data.output : '';
    aheadEnd = Math.max(next, Number(ahead.data?.cursor) || next);
    total = Math.max(total, Number(ahead.data?.size) || 0);
  }
  // The window reaches the end of what the command printed so far: nothing follows it once the command ended.
  const reachesEnd = aheadEnd >= total;
  const page = scrubOutputWindow(output, { before, after, final: reachesEnd && !running });
  const at = page.consumed <= output.length
    ? next - Buffer.byteLength(output.slice(page.consumed), 'utf8')
    : next + Buffer.byteLength(after.slice(0, page.consumed - output.length), 'utf8');
  const moved = Math.max(from, at);
  // An end held back at the end of the output: nothing more to read for now, the reader asks again at its own pace.
  if (page.held && reachesEnd) total = moved;
  return { status: r.status, data: { output: page.text, cursor: moved, size: Math.max(moved, total), from, ...extra } };
}
