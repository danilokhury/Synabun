import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { DatabaseSync, StatementSync } from 'node:sqlite';

let activeMonitor;

// `last` alone named whatever marked most recently, and the 2 s capture and maintenance timers mark every second:
// a multi-second recall or write wait that started before them was reported under their names
// (docs/startup-freeze-and-agents-audit.md → Third pass). A stall line now also says what was still in flight
// (beginActivity) and the slowest synchronous work of the stalled interval (instrumentSqlite, timeBlockingWork,
// beginBlockingWork, noteBlockingWork). `markActivity` labels are kept strictly as context (`last:`), never
// timed via nextTick, so unrelated callbacks sharing a turn are never misattributed.
const open = new Map();
let openSeq = 0;
let slowest = null;
const activeSyncSpans = []; // stack of open beginBlockingWork/timeBlockingWork spans on this thread

export function markActivity(label) {
  activeMonitor?.mark(label);
}

/**
 * Work that spans several turns of the event loop (a recall, an MCP request, a session-cache job). Returns the
 * function that ends it; a stall while it is open names it with its age. Also marks the label, like markActivity.
 */
export function beginActivity(label) {
  markActivity(label);
  const id = ++openSeq;
  open.set(id, { label, at: performance.now() });
  if (open.size > 200) open.delete(open.keys().next().value);
  let ended = false;
  return () => { if (!ended) { ended = true; open.delete(id); } };
}

/** Synchronous work of `ms` that just ended on this thread (the stall line names the longest of its interval). */
export function noteBlockingWork(label, ms) {
  if (!slowest || ms > slowest.ms) slowest = { label, ms };
}

/**
 * Time a non-SQL synchronous section on this thread. Returns an `end()` callback that records its duration
 * via `noteBlockingWork` when at or over `thresholdMs`. Also keeps the span visible while still running so
 * a stall detected mid-section attributes it immediately.
 */
export function beginBlockingWork(label, { thresholdMs = 50, mark = true } = {}) {
  if (mark) markActivity(label);
  const span = { label, started: performance.now(), thresholdMs, ended: false };
  activeSyncSpans.push(span);
  if (activeSyncSpans.length > 64) activeSyncSpans.shift();
  return () => {
    if (span.ended) return 0;
    span.ended = true;
    const idx = activeSyncSpans.lastIndexOf(span);
    if (idx >= 0) activeSyncSpans.splice(idx, 1);
    const ms = performance.now() - span.started;
    if (ms >= thresholdMs) noteBlockingWork(label, ms);
    return ms;
  };
}

/** Run synchronous function `fn` under a named blocking-work timer (attributed on any stall line). */
export function timeBlockingWork(label, fn, options) {
  const end = beginBlockingWork(label, options);
  try { return fn(); } finally { end(); }
}

function inFlight(now) {
  const list = [];
  for (const { label, at } of open.values()) { list.push(`${label} ${((now - at) / 1000).toFixed(1)} s`); if (list.length === 3) break; }
  return list.length ? `; in flight: ${list.join(', ')}${open.size > 3 ? ` +${open.size - 3}` : ''}` : '';
}

function longestActiveSpan(now) {
  let best = null;
  for (const span of activeSyncSpans) {
    const ms = now - span.started;
    if (!best || ms > best.ms) best = { label: span.label, ms };
  }
  return best;
}

let sqliteInstrumented = false;
/**
 * Time every synchronous SQLite call on this thread (node:sqlite statements, prepare and exec) and keep the slowest
 * of each monitor interval at or over `thresholdMs`, with the start of its SQL. A few tens of nanoseconds per call.
 * Off with SYNABUN_LOOP_STALL_SQL=off. Only for the thread that runs the monitor: workers have their own classes.
 */
export function instrumentSqlite({ thresholdMs = 50 } = {}) {
  if (sqliteInstrumented || process.env.SYNABUN_LOOP_STALL_SQL === 'off') return false;
  sqliteInstrumented = true;
  const describe = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 100).trim();
  for (const method of ['all', 'get', 'run']) {
    const original = StatementSync.prototype[method];
    if (typeof original !== 'function') continue;
    StatementSync.prototype[method] = function timedStatement(...args) {
      const started = performance.now();
      try { return original.apply(this, args); } finally {
        const ms = performance.now() - started;
        if (ms >= thresholdMs) noteBlockingWork(`sql ${method} ${describe(this.sourceSQL)}`, ms);
      }
    };
  }
  const prepare = DatabaseSync.prototype.prepare;
  if (typeof prepare === 'function') {
    DatabaseSync.prototype.prepare = function timedPrepare(sql, ...rest) {
      const started = performance.now();
      try { return prepare.call(this, sql, ...rest); } finally {
        const ms = performance.now() - started;
        if (ms >= thresholdMs) noteBlockingWork(`sql prepare ${describe(sql)}`, ms);
      }
    };
  }
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function timedExec(sql) {
    const started = performance.now();
    try { return exec.call(this, sql); } finally {
      const ms = performance.now() - started;
      if (ms >= thresholdMs) noteBlockingWork(`sql exec ${describe(sql)}`, ms);
    }
  };
  return true;
}

// All durations use the monotonic clock. Wall time is only for matching the line
// to server logs. A due timer may mark new work before our delayed tick runs.
//
// One line per `rateLimitMs` used to be all there was: on 2026-11-21 the log showed stalls of 0.6 to 2.8 s, none long
// enough to fail two health probes, while pages were shown as offline. Whatever came inside the 30 s after a line was
// dropped, so a run of stalls back to back, or a longer one after a short one, left no trace. Now a stall of `longMs`
// or more is always written (one such stall alone fails a probe: public/shared/api.js fetchHealth, 3 s), and every
// line ends with what the limit kept back since the line before it: how many stalls, their sum and the worst.
export function startLoopStallMonitor({
  thresholdMs = 500, intervalMs = 100, resolution = 20, rateLimitMs = 30_000, longMs = 3000,
  unattributedMs = 10_000,
  log = console.warn,
} = {}) {
  if (activeMonitor) return activeMonitor;
  const delay = monitorEventLoopDelay({ resolution });
  delay.enable();
  let lastTick = performance.now();
  let lastReport = -Infinity;
  let activity = 'startup';
  let held = { count: 0, ms: 0, worst: 0 };
  // One stall is seen twice (by the mark that follows it and by the delayed tick): `seenUntil` counts it once.
  let seenUntil = -Infinity;

  function pickAttribution(now, blocked) {
    const activeSpan = longestActiveSpan(now);
    const specific = !slowest ? activeSpan
      : !activeSpan ? slowest
      : activeSpan.ms > slowest.ms ? activeSpan : slowest;
    const minReport = Math.min(blocked / 4, 100);
    if (specific && specific.ms >= minReport) {
      return `; longest sync: ${specific.label} ${Math.round(specific.ms)} ms`;
    }
    // Never leave a >10 s stall completely unattributed: report whatever timed section ran, or explicitly
    // state it was unattributed (e.g., V8 GC pause, OS sleep, or untagged native/JS work) after `activity`.
    if (blocked >= unattributedMs) {
      if (specific && specific.ms > 0) return `; longest sync: ${specific.label} ${Math.round(specific.ms)} ms`;
      return `; longest sync: unattributed (after ${activity})`;
    }
    return '';
  }

  function check(now, histogram = 0) {
    const blocked = Math.max(now - lastTick - intervalMs, histogram);
    if (blocked < thresholdMs) return;
    const limited = now - lastReport < rateLimitMs;
    if (limited && !(blocked >= longMs)) {
      if (now - blocked >= seenUntil) {
        held = { count: held.count + 1, ms: held.ms + blocked, worst: Math.max(held.worst, blocked) };
        seenUntil = now;
      }
      return;
    }
    if (limited && now - blocked < seenUntil) return; // this long stall already has its line
    lastReport = now;
    seenUntil = now;
    const work = pickAttribution(now, blocked);
    slowest = null;
    const more = held.count
      ? `; ${held.count} more ${held.count === 1 ? 'stall' : 'stalls'} since the last line, ${Math.round(held.ms)} ms in all, worst ${Math.round(held.worst)} ms`
      : '';
    held = { count: 0, ms: 0, worst: 0 };
    log(`[loop-stall] ${new Date().toISOString()} blocked ${Math.round(blocked)} ms (last: ${activity}${inFlight(now)}${work})${more}`);
  }

  const timer = setInterval(() => {
    const now = performance.now();
    check(now, delay.max / 1e6 - resolution);
    lastTick = now;
    slowest = null;
    delay.reset();
  }, intervalMs);
  timer.unref();
  activeMonitor = {
    mark(label) {
      check(performance.now());
      activity = label;
    },
    stop() {
      clearInterval(timer);
      delay.disable();
      slowest = null;
      activeSyncSpans.length = 0;
      if (activeMonitor === this) activeMonitor = undefined;
    },
  };
  return activeMonitor;
}
