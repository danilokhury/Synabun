// ═══════════════════════════════════════════
// SynaBun — OpenCode Panel: Unified Trace Bus
//
// One `[ocp-trace]` channel for every plan-mode and AskUserQuestion
// state transition. Mirrors to console, batches to the server jsonl
// sink, and broadcasts via /ws/ocp-trace for the in-panel viewer.
//
// API:
//   trace(tag, fields?)             emit a structured event
//   traceTimer(tag, fields?)        returns end(extra?) → emits ${tag}:end with ms
//   setTraceLevel('silent'|'errors'|'normal'|'verbose')
//   getTraceLevel()
//   onTrace(fn)                     subscribe; returns unsubscribe
//   exportTraceLog()                returns ring buffer (last RING_LIMIT entries)
//   clearTraceLog()                 reset ring buffer (does NOT clear server jsonl)
//   setTraceContext({ tabId, sessionId, mode, model, agent })
// ═══════════════════════════════════════════

const RING_LIMIT = 5000;
const BATCH_INTERVAL_MS = 250;
const BATCH_MAX = 200;
const INGEST_URL = '/api/ocp/trace/ingest';

const LEVELS = { silent: 0, errors: 1, normal: 2, verbose: 3 };
const LEVEL_FOR_TAG = (tag) => {
  if (/(:error|:err|:fail|fail$)/i.test(tag)) return 1;
  if (/^(stream:|render:partUpdated|event:fallthrough)/.test(tag)) return 3;
  return 2;
};

let _level = (() => {
  try {
    const stored = localStorage.getItem('ocp.traceLevel');
    if (stored && stored in LEVELS) return stored;
  } catch {}
  // Default VERBOSE while we hunt the streaming-pause bug. Once stable,
  // flip back to 'normal'. User can override anytime via:
  //   localStorage.setItem('ocp.traceLevel', 'normal') in DevTools.
  return 'verbose';
})();

let _seq = 0;
const _ring = [];
const _subs = new Set();
const _ctx = { tabId: null, sessionId: null, mode: null, model: null, agent: null };
let _pendingBatch = [];
let _batchTimer = null;
// Default OFF: tracing is console + ring-buffer only. Enable via
// `setIngestEnabled(true)` after the server has been restarted with the new
// /api/ocp/trace/ingest endpoint. Default-ON would spam fetch errors against a
// missing endpoint on the user's running server, contend with message:send,
// and contribute to sidepanel hang symptoms.
let _ingestEnabled = false;

export function setTraceLevel(level) {
  if (!(level in LEVELS)) return;
  _level = level;
  try { localStorage.setItem('ocp.traceLevel', level); } catch {}
}

export function getTraceLevel() { return _level; }

export function setTraceContext(ctx = {}) {
  if (typeof ctx !== 'object' || !ctx) return;
  for (const k of ['tabId', 'sessionId', 'mode', 'model', 'agent']) {
    if (k in ctx) _ctx[k] = ctx[k];
  }
}

export function getTraceContext() { return { ..._ctx }; }

export function setIngestEnabled(enabled) { _ingestEnabled = !!enabled; }

export function trace(tag, fields = {}) {
  if (!tag) return;
  if (LEVELS[_level] < LEVEL_FOR_TAG(tag)) return;
  const entry = {
    seq: ++_seq,
    t: Date.now(),
    tag: String(tag),
    ..._ctx,
    ...fields,
  };
  _ring.push(entry);
  if (_ring.length > RING_LIMIT) _ring.splice(0, _ring.length - RING_LIMIT);
  try {
    const summary = summarize(entry);
    if (LEVEL_FOR_TAG(tag) === 1) {
      console.warn('%c[ocp-trace]%c ' + entry.tag + summary,
        'color:#E8E0DC;background:#5a1a1a;padding:1px 4px;border-radius:2px', '', entry);
    } else {
      console.debug('%c[ocp-trace]%c ' + entry.tag + summary,
        'color:#0e0e0e;background:#E8E0DC;padding:1px 4px;border-radius:2px', '', entry);
    }
  } catch {}
  for (const fn of _subs) {
    try { fn(entry); } catch (e) { console.error('[ocp-trace] subscriber error:', e); }
  }
  if (_ingestEnabled) queueBatch(entry);
}

export function traceTimer(tag, fields = {}) {
  const startedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  trace(`${tag}:start`, fields);
  let ended = false;
  return (extra = {}) => {
    if (ended) return 0;
    ended = true;
    const ms = Math.max(0, Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
    ));
    trace(`${tag}:end`, { ...fields, ...extra, ms });
    return ms;
  };
}

export function onTrace(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => _subs.delete(fn);
}

export function exportTraceLog() { return _ring.slice(); }

export function clearTraceLog() { _ring.length = 0; }

function summarize(entry) {
  const keys = ['sid', 'sessionId', 'reqId', 'toolName', 'mode', 'tier', 'reason', 'status', 'ms', 'count', 'bytes'];
  const parts = [];
  for (const k of keys) {
    const v = entry[k];
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.length ? ' · ' + parts.join(' ') : '';
}

function queueBatch(entry) {
  _pendingBatch.push(entry);
  if (_pendingBatch.length >= BATCH_MAX) {
    flushBatch();
    return;
  }
  if (_batchTimer) return;
  _batchTimer = setTimeout(() => {
    _batchTimer = null;
    flushBatch();
  }, BATCH_INTERVAL_MS);
}

async function flushBatch() {
  if (_pendingBatch.length === 0) return;
  const batch = _pendingBatch;
  _pendingBatch = [];
  try {
    await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
  } catch (err) {
    if (_pendingBatch.length < BATCH_MAX * 2) {
      _pendingBatch = batch.concat(_pendingBatch);
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { try { flushBatch(); } catch {} });
  window.addEventListener('beforeunload', () => { try { flushBatch(); } catch {} });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { try { flushBatch(); } catch {} }
  });
}
