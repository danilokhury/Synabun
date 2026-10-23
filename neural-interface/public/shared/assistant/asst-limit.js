// ═══════════════════════════════════════════
// SynaBun Assistant — usage limits: is it one, and when does it reset?
// ═══════════════════════════════════════════
// A provider that stops a turn on its usage limit says so in words ("You've
// hit your session limit · resets 5:10am (America/Sao_Paulo)", "try again in
// 2 hours 3 minutes", "blocked until about 06:01 UTC"). limitFromText reads
// that message: whether it is a usage limit, and the reset time it names
// (epoch ms, or null when it names none). The time is read against the moment
// the message was written (`now`), so a reload draws the same countdown. A
// structured reset time (the Claude SDK's rate_limit_info, an account's usage
// window) always wins over the words; this is what is left when there is
// none. limitCountdown is the waiting card's clock. No imports and no DOM:
// the dispatcher (lib/assistant-dispatch.js) reads a worker's failure with it.

const LIMIT_RE = /\b(?:usage limit|session limit|weekly limit|daily limit|hourly limit|5-hour limit|rate[- ]limit(?:ed)?|limit reached|limit exceeded|hit (?:your|the) (?:\w+ ){0,2}limit|out of (?:usage|credits|quota)|quota (?:exceeded|reached)|exceeded (?:your |the )?(?:current )?quota|too many requests)\b/i;
const DAY_MS = 86_400_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const UNIT_MS = { d: DAY_MS, h: 3_600_000, m: 60_000, s: 1000 };

/** The offset of `timeZone` from UTC at the instant `ms` (wall time − UTC), in ms; null for a zone this runtime does not know. */
function zoneOffset(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Number.isFinite(wall) ? wall - (Math.floor(ms / 1000) * 1000) : null;
  } catch { return null; }
}

/** A wall-clock time in `zone` ('UTC', an IANA name, or null for this machine's own) → epoch ms. */
export function wallTimeToEpoch({ year, month, day, hour, minute = 0 }, zone = null) {
  if (zone === 'UTC') return Date.UTC(year, month, day, hour, minute);
  if (zone) {
    const guess = Date.UTC(year, month, day, hour, minute);
    const first = zoneOffset(guess, zone);
    if (first !== null) {
      const at = guess - first;
      const second = zoneOffset(at, zone);
      return second !== null && second !== first ? guess - second : at;
    }
  }
  return new Date(year, month, day, hour, minute).getTime();
}

/** Year / month / day of the instant `ms` as `zone` sees it. */
function dateIn(ms, zone) {
  if (zone === 'UTC') { const d = new Date(ms); return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() }; }
  if (zone) {
    const offset = zoneOffset(ms, zone);
    if (offset !== null) { const d = new Date(ms + offset); return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() }; }
  }
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

function isZone(name) {
  if (!name) return false;
  if (/^(?:utc|gmt|z)$/i.test(name)) return true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return true; } catch { return false; }
}

/** "in 2 hours 3 minutes" / "in 4h 12m" → ms, or null. */
function relativeMs(text) {
  const m = /\b(?:in|after|within)\s+(?:about\s+|around\s+|~\s*)?((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (!m) return null;
  let total = 0;
  for (const part of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi)) {
    const unit = part[2].toLowerCase();
    const key = unit.startsWith('d') ? 'd' : unit.startsWith('h') ? 'h' : unit.startsWith('m') ? 'm' : 's';
    total += Number(part[1]) * UNIT_MS[key];
  }
  return total > 0 ? total : null;
}

/**
 * A clock time the message names after "resets", "until", "try again at"…: the next such moment
 * from `now` (today, or tomorrow when it has passed), in the zone it names ("UTC", "(America/Sao_Paulo)")
 * or this machine's own. A month and day before it ("Oct 23, 5:52 PM") pin the date.
 */
function clockTime(text, now) {
  const re = /\b(?:resets?|reset at|until|till|try again at|again at|available (?:again )?at|back at)\s+(?:on\s+)?(?:at\s+)?(?:about\s+|around\s+|approximately\s+|~\s*)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*(?:\(\s*)?(UTC|GMT|Z|[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)(?:\s*\))?)?/gi;
  for (const m of text.matchAll(re)) {
    const [, monthName, dayText, yearText, hourText, minuteText, meridiem, zoneText] = m;
    let hour = Number(hourText);
    const minute = minuteText ? Number(minuteText) : 0;
    // "until 3 runs finish" is no time: a clock needs minutes or am / pm.
    if (!minuteText && !meridiem) continue;
    if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) continue;
    if (meridiem) { const pm = /^p/i.test(meridiem); hour = (hour % 12) + (pm ? 12 : 0); }
    const zone = zoneText && isZone(zoneText) ? (/^(?:utc|gmt|z)$/i.test(zoneText) ? 'UTC' : zoneText) : null;
    const monthIndex = monthName ? MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) : -1;
    if (monthName && monthIndex >= 0) {
      const today = dateIn(now, zone);
      let year = yearText ? Number(yearText) : today.year;
      let at = wallTimeToEpoch({ year, month: monthIndex, day: Number(dayText), hour, minute }, zone);
      if (!yearText && at < now - DAY_MS) { year += 1; at = wallTimeToEpoch({ year, month: monthIndex, day: Number(dayText), hour, minute }, zone); }
      return at;
    }
    if (monthName) continue; // a word that is no month ("resets daily 5pm"): try the next match
    const today = dateIn(now, zone);
    let at = wallTimeToEpoch({ ...today, hour, minute }, zone);
    if (at < now - 60_000) {
      const next = new Date(Date.UTC(today.year, today.month, today.day + 1));
      at = wallTimeToEpoch({ year: next.getUTCFullYear(), month: next.getUTCMonth(), day: next.getUTCDate(), hour, minute }, zone);
    }
    return at;
  }
  return null;
}

/** An instant written out: epoch seconds or ms after "limit reached|" (the Claude CLI's old form), or an ISO timestamp. */
function absoluteTime(text) {
  const epoch = /limit reached\|(\d{10,13})\b/i.exec(text);
  if (epoch) { const n = Number(epoch[1]); return n < 1e12 ? n * 1000 : n; }
  const isoMatch = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/.exec(text);
  if (isoMatch) { const ms = Date.parse(isoMatch[1].replace(' ', 'T')); if (Number.isFinite(ms)) return ms; }
  return null;
}

/**
 * Is `text` a provider's usage-limit message? → { resetsAt: epoch ms | null } or null.
 * `now`: when the message was written (its reset time is the next one from then).
 * A reset time more than a day before `now` or 31 days after it is none.
 */
export function limitFromText(text, { now = Date.now() } = {}) {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!src || src.length > 4000 || !LIMIT_RE.test(src)) return null;
  let resetsAt = absoluteTime(src);
  if (resetsAt === null) { const rel = relativeMs(src); if (rel !== null) resetsAt = now + rel; }
  if (resetsAt === null) resetsAt = clockTime(src, now);
  if (resetsAt !== null && (!Number.isFinite(resetsAt) || resetsAt < now - DAY_MS || resetsAt > now + 31 * DAY_MS)) resetsAt = null;
  return { resetsAt };
}

/** A reset time in any form the panel meets (epoch s or ms, ISO text) → epoch ms, or null. Seconds below 1e11 (until the year 5138). */
export function resetMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? (value < 1e11 ? value * 1000 : value) : null;
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== '') return resetMs(n);
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** ms → "hh:mm:ss" (hours past 99 keep growing), counted up so the last second shows 00:00:01. */
export function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * The waiting card's clock at `now`: { known, done, remainingMs, clock, progress }.
 * `since`: when the wait began (the ring fills from there to `resetsAt`). No reset time: known false.
 */
export function limitCountdown({ resetsAt = null, since = null } = {}, now = Date.now()) {
  const at = resetMs(resetsAt);
  if (at === null) return { known: false, done: false, remainingMs: null, clock: '', progress: null };
  const remainingMs = Math.max(0, at - now);
  const start = Number.isFinite(since) && since < at ? since : Math.min(now, at);
  const span = Math.max(1, at - start);
  const progress = remainingMs <= 0 ? 1 : Math.min(1, Math.max(0, 1 - remainingMs / span));
  return { known: true, done: remainingMs <= 0, remainingMs, clock: fmtCountdown(remainingMs), progress };
}
