import { DIAGNOSTIC_BATCH, validDiagnosticEntry } from './loading-diagnostic-entry.js';

const KEY = 'synabun-loading-diagnostics-v1';
const CAP = 200;

// The shell passes the original fetch, before the UI installs its owner-access
// notifications. A diagnostic refusal must never raise a banner over the app.
export function createLoadingDiagnostics(page, { send = page.fetch.bind(page), early = [] } = {}) {
  let entries = [];
  let sent = 0;
  let timer = null;
  let sending = false;
  let retryDelay = 1000;
  // After a refused batch: one entry a request until the trail is drained, so the refused entry is found and dropped.
  let narrow = false;

  try {
    const saved = JSON.parse(page.sessionStorage.getItem(KEY));
    if (Array.isArray(saved?.entries) && saved.entries.length <= CAP && saved.entries.every(validDiagnosticEntry)) {
      entries = saved.entries;
      if (Number.isInteger(saved.sent) && saved.sent >= 0 && saved.sent <= entries.length) sent = saved.sent;
    }
  } catch { /* Storage may be disabled. Delivery can still run in memory. */ }

  function save() {
    try { page.sessionStorage.setItem(KEY, JSON.stringify({ entries, sent })); } catch {}
  }

  function schedule(delay) {
    if (timer === null && !sending && sent < entries.length) timer = page.setTimeout(flush, delay);
  }

  async function flush() {
    timer = null;
    const batch = [];
    for (const entry of entries.slice(sent, sent + (narrow ? 1 : DIAGNOSTIC_BATCH))) {
      if (batch.length && entry.pageId !== batch[0].pageId) break;
      batch.push(entry);
    }
    if (!batch.length) return;
    sending = true;
    let delay = null;
    const options = { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' };
    const post = () => send('/api/client-diagnostics', {
      ...options, method: 'POST', keepalive: true, signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch),
    });
    try {
      let response = await post();
      if (response.status === 403 && (await response.json()).code === 'PAGE_SECRET_REQUIRED') {
        // A tab surviving a restart can still have the previous boot's HttpOnly cookie.
        const refresh = await send('/api/page-session', { ...options, signal: AbortSignal.timeout(5000) });
        if (refresh.ok) response = await post();
      }
      if (response.status === 204) {
        // Recording continues while the request is in flight, including evictions.
        const last = entries.indexOf(batch.at(-1));
        if (last >= 0) sent = last + 1;
        if (sent >= entries.length) narrow = false;
        else if (narrow) delay = 100;
        save();
        retryDelay = 1000;
      } else if (response.status === 400) {
        // The server can never take this batch: its validator predates an event this page records (the page's
        // files are newer than the running server). Sending it again would hold back the whole trail; the
        // refused entry is dropped and the rest still reach the log.
        if (batch.length === 1) {
          const at = entries.indexOf(batch[0]);
          if (at >= 0) sent = at + 1;
          save();
        }
        narrow = true;
        retryDelay = 1000;
        delay = 0;
      } else {
        retryDelay = Math.min(60000, retryDelay * 2);
      }
    } catch { retryDelay = Math.min(60000, retryDelay * 2); }
    finally { sending = false; schedule(delay ?? retryDelay); }
  }

  function append(entry) {
    try {
      if (!validDiagnosticEntry(entry)) return;
      entries.push(entry);
      if (entries.length > CAP) { entries.shift(); sent = Math.max(0, sent - 1); }
      try { if (page.localStorage.getItem('synabun-diag') === '1') page.console.info('[client-diag]', entry); } catch {}
    } catch { /* Observation must not interrupt startup or recovery. */ }
  }
  for (const entry of early) append(entry);
  if (early.length) save();
  schedule(0); // Drain entries from earlier documents even if the app module never loads.
  return entry => { append(entry); save(); schedule(250); };
}
