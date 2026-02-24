// ═══════════════════════════════════════════
// STORAGE — Server-synced persistent state
// ═══════════════════════════════════════════
//
// Drop-in replacement for localStorage calls.
// Data persists to data/ui-state.json on the server.
//
// Self-hydrating: the module-level `await` ensures any module that
// imports from storage.js gets a populated cache before its own
// body executes. This is critical for modules like gfx.js that call
// loadGfxConfig() at import time.
//
// The in-memory cache ensures synchronous reads (zero latency).
// Writes are async but invisible to callers.

const _cache = {};
let _dirty = {};
let _flushTimer = null;
let _hydrated = false;
const DEBOUNCE_MS = 500;

// ── Hydrate from server ──────────────────────────────

async function _hydrate() {
  let serverData = null;
  try {
    const res = await fetch('/api/ui-state');
    if (res.ok) serverData = await res.json();
  } catch { /* server unreachable */ }

  if (serverData && Object.keys(serverData).filter(k => !k.startsWith('_')).length > 0) {
    // Normal boot: hydrate from server file
    for (const [key, value] of Object.entries(serverData)) {
      if (key.startsWith('_')) continue;
      _cache[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  } else {
    // First run or server down: import from localStorage
    console.info('[storage] Migrating localStorage to server...');
    _migrateFromLocalStorage();
    // Build dirty set from everything we imported
    for (const [key, val] of Object.entries(_cache)) {
      try { _dirty[key] = JSON.parse(val); } catch { _dirty[key] = val; }
    }
    if (Object.keys(_dirty).length > 0) {
      await _flushToServer();
      console.info('[storage] Migration complete. Data saved to data/ui-state.json');
    }
  }
  _hydrated = true;
}

// Self-hydrate at module load — blocks dependents until cache is ready
await _hydrate();

// ── Drop-in API (mirrors localStorage) ───────────────

export const storage = {
  getItem(key) {
    return _cache[key] ?? null;
  },

  setItem(key, value) {
    const strValue = String(value);
    if (_cache[key] === strValue) return; // no-op if unchanged
    _cache[key] = strValue;
    // Parse back to native type for the server (avoids double-encoding JSON)
    try { _dirty[key] = JSON.parse(strValue); } catch { _dirty[key] = strValue; }
    _scheduleDebouncedFlush();
  },

  removeItem(key) {
    if (!(key in _cache)) return;
    delete _cache[key];
    _dirty[key] = null; // null signals deletion to the server
    _scheduleDebouncedFlush();
  },
};

// ── Debounced flush to server ────────────────────────

function _scheduleDebouncedFlush() {
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(_flushToServer, DEBOUNCE_MS);
}

async function _flushToServer() {
  const payload = { ..._dirty };
  _dirty = {};
  _flushTimer = null;
  if (Object.keys(payload).length === 0) return;
  try {
    const res = await fetch('/api/ui-state', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn('[storage] Flush failed:', err.message, '— will retry');
    // Re-queue failed keys (don't overwrite newer dirty values)
    for (const [k, v] of Object.entries(payload)) {
      if (!(k in _dirty)) _dirty[k] = v;
    }
    _scheduleDebouncedFlush();
  }
}

// ── Flush on page unload (sendBeacon for reliability) ──

window.addEventListener('beforeunload', () => {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  // Merge any pending dirty keys
  const payload = { ..._dirty };
  _dirty = {};
  if (Object.keys(payload).length === 0) return;
  navigator.sendBeacon(
    '/api/ui-state',
    new Blob([JSON.stringify(payload)], { type: 'application/json' })
  );
});

// ── Migration helper ─────────────────────────────────

function _migrateFromLocalStorage() {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('neural-') || key.startsWith('synabun-'))) {
      _cache[key] = localStorage.getItem(key);
    }
  }
}

// ── Utilities ────────────────────────────────────────

/** Force an immediate flush (useful for testing or explicit save actions) */
export async function flushStorage() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  await _flushToServer();
}

export function isHydrated() {
  return _hydrated;
}
