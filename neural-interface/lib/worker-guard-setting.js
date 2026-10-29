// ═══════════════════════════════════════════
// SynaBun — Protect workers: the one global value
// ═══════════════════════════════════════════
//
// DATA_HOME/data/worker-guard.json ({ mode, updatedAt }), read live: one value for every worker the
// Assistant's dispatcher starts with capability read-only or workspace (lib/worker-confinement.js says what
// each mode means; capability full is never guarded). No file, or one that cannot be read, is the default,
// enforce. Only the UI changes it (PUT /api/assistant/worker-guard answers UI_ONLY to agents); a change
// reaches every window as `agents:worker-guard-changed`. A run keeps the mode it started with.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WORKER_GUARD_DEFAULT, WORKER_GUARD_MODES, normalizeWorkerGuardMode } from './worker-confinement.js';

export const WORKER_GUARD_EVENT = 'agents:worker-guard-changed';

export function createWorkerGuardSetting({ path, broadcast = () => {}, log = () => {}, now = Date.now } = {}) {
  if (!path) throw new Error('createWorkerGuardSetting requires a path');
  const listeners = new Set();
  let cache = null; // { mtimeMs, value }

  function read() {
    try {
      const stat = statSync(path);
      if (cache && cache.mtimeMs === stat.mtimeMs) return cache.value;
      const data = JSON.parse(readFileSync(path, 'utf8'));
      const value = normalizeWorkerGuardMode(data?.mode);
      cache = { mtimeMs: stat.mtimeMs, value };
      return value;
    } catch {
      return WORKER_GUARD_DEFAULT;
    }
  }
  /** What the UI shows: the mode in effect, the modes, the default. */
  function view() {
    return { mode: read(), modes: [...WORKER_GUARD_MODES], defaultMode: WORKER_GUARD_DEFAULT };
  }
  function set(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!WORKER_GUARD_MODES.includes(text)) throw Object.assign(new Error(`mode must be one of ${WORKER_GUARD_MODES.join(', ')}.`), { code: 'INVALID_VALUE', status: 400 });
    const before = read();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mode: text, updatedAt: new Date(now()).toISOString() }, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
    cache = null;
    const changed = text !== before;
    if (changed) log('worker-guard', `protect workers: ${text}`);
    try { broadcast({ type: WORKER_GUARD_EVENT, ...view() }); } catch { /* nobody listening */ }
    if (changed) for (const listener of [...listeners]) { try { listener(text); } catch { /* the listener's own failure */ } }
    return view();
  }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }

  return { mode: read, view, set, subscribe, path };
}
