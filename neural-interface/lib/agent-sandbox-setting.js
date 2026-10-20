// ═══════════════════════════════════════════
// SynaBun — Admin sandbox: the one global value
// ═══════════════════════════════════════════
//
// DATA_HOME/data/agent-sandbox.json ({ adminSandbox, updatedAt }), read live:
// one value for every agent SynaBun starts, not per session or tab. No file
// (or one that cannot be read) is the default, off. What the value means for
// each provider is lib/agent-sandbox-elevation.js. Only the UI changes it
// (PUT /api/assistant/admin-sandbox answers UI_ONLY to agents); a change
// reaches every window as `agents:admin-sandbox-changed` and every listener
// (server.js restarts the idle Codex app-servers there).

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ADMIN_SANDBOX_DEFAULT, adminSandboxProviders, normalizeAdminSandbox } from './agent-sandbox-elevation.js';

export const ADMIN_SANDBOX_EVENT = 'agents:admin-sandbox-changed';

export function createAdminSandboxSetting({ path, broadcast = () => {}, log = () => {}, now = Date.now } = {}) {
  if (!path) throw new Error('createAdminSandboxSetting requires a path');
  const listeners = new Set();
  let cache = null; // { mtimeMs, value }

  function read() {
    try {
      const stat = statSync(path);
      if (cache && cache.mtimeMs === stat.mtimeMs) return cache.value;
      const data = JSON.parse(readFileSync(path, 'utf8'));
      const value = normalizeAdminSandbox(data?.adminSandbox);
      cache = { mtimeMs: stat.mtimeMs, value };
      return value;
    } catch {
      return ADMIN_SANDBOX_DEFAULT;
    }
  }
  /** What the UI shows: the value and the providers it changes. */
  function view() {
    return { adminSandbox: read(), providers: adminSandboxProviders() };
  }
  function set(value) {
    const next = normalizeAdminSandbox(value);
    const before = read();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ adminSandbox: next, updatedAt: new Date(now()).toISOString() }, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
    cache = null;
    const changed = next !== before;
    if (changed) log('agent-sandbox', `admin sandbox ${next ? 'on' : 'off'}`);
    try { broadcast({ type: ADMIN_SANDBOX_EVENT, ...view() }); } catch { /* nobody listening */ }
    if (changed) for (const listener of [...listeners]) { try { listener(next); } catch { /* the listener's own failure */ } }
    return view();
  }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }

  return { enabled: read, view, set, subscribe, path };
}
