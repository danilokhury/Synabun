// ═══════════════════════════════════════════
// SynaBun — browser console buffer (browser_console)
// ═══════════════════════════════════════════
//
// A per-page ring buffer of console messages and uncaught page errors, so an
// agent can read a page's errors through SynaBun's browser instead of opening
// its own DevTools or Playwright. Attached wherever server.js registers a page
// (the first tab of a session, new tabs, recovered tabs, their popups);
// attaching twice is a no-op. A popup is not a tab of its session, so its
// entries come back with the tab that opened it (browser_console on that tab),
// each labelled with the popup's URL; the last MAX_POPUPS popups of a tab count.
//
// Playwright hands every console argument over as a JSHandle that stays alive
// until the page navigates. Only the text is kept here, so the handles are
// released at once: a long-lived tab of a chatty single-page app would
// otherwise pin every logged object in the page and in this process.

export const CONSOLE_BUFFER_LIMIT = 200;
export const MAX_POPUPS = 5;
const TEXT_LIMIT = 2000;
const STACK_LIMIT = 4000;
const LOCATION_URL_LIMIT = 300;
// Popups of popups are read too, this deep.
const POPUP_DEPTH = 3;
// One order across every buffer, so a tab's entries and its popups' interleave as they happened.
let arrival = 0;

// Severity order; a read at one level includes every more severe one.
export const CONSOLE_LEVELS = ['error', 'warning', 'info', 'log'];
const RANK = { error: 0, warning: 1, info: 2, log: 3 };

const buffers = new WeakMap();

/** Playwright's console message type (log, debug, warning, assert, verbose…) as one of CONSOLE_LEVELS. */
export function consoleLevel(type) {
  const text = String(type || '').toLowerCase();
  if (text === 'error' || text === 'assert') return 'error';
  if (text === 'warning' || text === 'warn') return 'warning';
  if (text === 'info') return 'info';
  return 'log';
}

const clip = (text, max) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}… (${value.length - max} more chars)` : value;
};

function formatLocation(location) {
  if (!location || !location.url) return null;
  const url = clip(location.url, LOCATION_URL_LIMIT);
  const line = Number.isFinite(location.lineNumber) ? `:${location.lineNumber}` : '';
  const column = line && Number.isFinite(location.columnNumber) ? `:${location.columnNumber}` : '';
  return `${url}${line}${column}`;
}

function push(buffer, entry) {
  buffer.seq += 1;
  arrival += 1;
  buffer.entries.push({ seq: buffer.seq, arrival, ...entry });
  if (buffer.entries.length > buffer.limit) {
    buffer.dropped += buffer.entries.length - buffer.limit;
    buffer.entries.splice(0, buffer.entries.length - buffer.limit);
  }
}

function pageUrl(page) {
  try { return clip(page.url(), LOCATION_URL_LIMIT); } catch { return null; }
}

/**
 * Start buffering `page`'s console and page errors (idempotent). Returns the
 * buffer. `popup`: the page is a popup, so each entry carries its URL.
 */
export function attachConsoleBuffer(page, { limit = CONSOLE_BUFFER_LIMIT, now = Date.now, popup = false } = {}) {
  if (!page || typeof page.on !== 'function') return null;
  const existing = buffers.get(page);
  if (existing) return existing;
  const buffer = { entries: [], dropped: 0, seq: 0, limit, attachedAt: now(), popups: [] };
  buffers.set(page, buffer);
  const where = () => (popup ? { popup: pageUrl(page) } : {});
  page.on('console', (message) => {
    try {
      const type = message.type();
      push(buffer, {
        kind: 'console',
        level: consoleLevel(type),
        type,
        text: clip(message.text(), TEXT_LIMIT),
        location: formatLocation(message.location()),
        ...where(),
        at: now(),
      });
    } catch { /* a message that cannot be read is skipped */ }
    try { for (const handle of message.args()) handle.dispose().catch(() => {}); } catch {}
  });
  page.on('pageerror', (error) => {
    push(buffer, {
      kind: 'pageerror',
      level: 'error',
      message: clip(error?.message || String(error), TEXT_LIMIT),
      stack: error?.stack ? clip(error.stack, STACK_LIMIT) : null,
      ...where(),
      at: now(),
    });
  });
  // A popup a registered tab opens gets its own buffer from its first message,
  // read with this tab's (popups are not tabs a caller can name).
  page.on('popup', (child) => {
    const childBuffer = attachConsoleBuffer(child, { limit, now, popup: true });
    if (!childBuffer || buffer.popups.includes(childBuffer)) return;
    buffer.popups.push(childBuffer);
    if (buffer.popups.length > MAX_POPUPS) buffer.popups.splice(0, buffer.popups.length - MAX_POPUPS);
  });
  return buffer;
}

/** A buffer and its popups' buffers (and theirs, POPUP_DEPTH deep). */
function withPopups(buffer, depth = 0, out = []) {
  if (!buffer || out.includes(buffer)) return out;
  out.push(buffer);
  if (depth < POPUP_DEPTH) for (const child of buffer.popups || []) withPopups(child, depth + 1, out);
  return out;
}

/** The buffer attached to `page`, or null. */
export function consoleBufferOf(page) {
  return (page && buffers.get(page)) || null;
}

/** `since` as epoch ms: a number, a numeric string, or an ISO date. NaN when unreadable. */
export function parseConsoleSince(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? NaN : parsed;
}

/**
 * Read a page's buffer, with the entries of the popups it opened (each with
 * `popup`: that popup's URL). `level` (error | warning | info | log | all)
 * keeps that level and every more severe one; `since` (epoch ms) keeps entries
 * after it; `limit` returns the newest N of what matched, oldest first; `clear`
 * empties the buffers after reading.
 */
export function readConsoleBuffer(page, { level = 'all', since = null, limit = 50, clear = false } = {}) {
  const buffer = consoleBufferOf(page);
  if (!buffer) return { attached: false, entries: [], matched: 0, total: 0, dropped: 0 };
  const wanted = level === 'all' || !level ? RANK.log : RANK[level];
  if (wanted === undefined) throw new Error(`level must be one of all, ${CONSOLE_LEVELS.join(', ')}`);
  const sources = withPopups(buffer);
  const all = sources.flatMap((source) => source.entries).sort((a, b) => a.arrival - b.arrival);
  const matching = all.filter((entry) => RANK[entry.level] <= wanted && (since === null || entry.at > since));
  const cap = Math.max(1, Math.min(CONSOLE_BUFFER_LIMIT, Math.floor(Number(limit) || 50)));
  const entries = matching.slice(-cap).map(({ seq, arrival: _arrival, at, ...rest }) => ({ ...rest, at: new Date(at).toISOString() }));
  const popups = sources.length - 1;
  const result = {
    attached: true,
    entries,
    matched: matching.length,
    total: all.length,
    dropped: sources.reduce((sum, source) => sum + source.dropped, 0),
    bufferingSince: new Date(buffer.attachedAt).toISOString(),
    latest: all.length ? new Date(Math.max(...all.map((entry) => entry.at))).toISOString() : null,
    ...(popups && { popups }),
  };
  if (clear) {
    for (const source of sources) {
      source.entries.length = 0;
      source.dropped = 0;
    }
    result.cleared = true;
  }
  return result;
}
