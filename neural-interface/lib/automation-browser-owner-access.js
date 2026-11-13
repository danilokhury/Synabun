// ═══════════════════════════════════════════
// SynaBun — Let the automation browser act as owner: the one global value
// ═══════════════════════════════════════════
//
// DATA_HOME/data/automation-browser-owner-access.json ({ enabled, updatedAt }), read live: whether SynaBun's own
// automation browser (the Playwright / MoreLogin browser the browser_* tools drive) may use the Neural Interface
// on this server as the owner. Off by default, and off whenever the file is missing or cannot be read.
//
// What it changes (lib/page-session.js, lib/owner-authority.js read it through `enabled()` on every request):
// while on, a request that carries the automation browser's marker (cookie or host-proof header), or whose peer
// process the lookup names an automation browser, is handed the page secret, verifies as the owner and passes the
// owner gate (its writes, its reads, its sockets: /ws/assistant, the panels, the memory map's data), so a
// screenshot or visual-QA run sees the real UI. Every other refusal stays: an agent's process tree, a relay,
// another SynaBun server, a remote login, a guest, a failed lookup. The automation browser still gets no service
// worker (nothing it does is answered out of the server's sight).
//
// Who may change it: only the owner's own page (PUT /api/assistant/automation-browser-owner-access: this boot's
// page secret, no agent header, and never from the automation browser itself, whatever the setting says). No
// agent tool, mailbox, worker or hook writes it; nothing reads it from a request. A change is broadcast to every
// window and said in the server log; a server that starts with it on says so too.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const AUTOMATION_BROWSER_OWNER_ACCESS_EVENT = 'browser:owner-access-changed';
export const AUTOMATION_BROWSER_OWNER_ACCESS_FILE = 'automation-browser-owner-access.json';
export const AUTOMATION_BROWSER_OWNER_ACCESS_DEFAULT = false;
/** The one-line notice the server log carries while the setting is on (at start, and on every change to on). */
export const AUTOMATION_BROWSER_OWNER_ACCESS_NOTICE = 'the automation browser acts as the owner on this server: agents driving the SynaBun browser can read and act on the Neural Interface as the owner (Settings → Browser → Automation browser access)';

/** Only `true` / `false` (and the strings "true" / "false") are a value; anything else is refused. */
export function normalizeOwnerAccessValue(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

export function createAutomationBrowserOwnerAccess({ path, broadcast = () => {}, log = () => {}, now = Date.now } = {}) {
  if (!path) throw new Error('createAutomationBrowserOwnerAccess requires a path');
  const listeners = new Set();
  let cache = null; // { mtimeMs, value }

  /** Whether the setting is on: the file's `enabled` when it is exactly true, else off. Never throws. */
  function read() {
    try {
      const stat = statSync(path);
      if (cache && cache.mtimeMs === stat.mtimeMs) return cache.value;
      const data = JSON.parse(readFileSync(path, 'utf8'));
      const value = data?.enabled === true;
      cache = { mtimeMs: stat.mtimeMs, value };
      return value;
    } catch {
      return AUTOMATION_BROWSER_OWNER_ACCESS_DEFAULT;
    }
  }
  /** What the UI shows: the value in effect and the default. */
  function view() {
    return { enabled: read(), defaultEnabled: AUTOMATION_BROWSER_OWNER_ACCESS_DEFAULT };
  }
  function set(value) {
    const next = normalizeOwnerAccessValue(value);
    if (next === null) throw Object.assign(new Error('enabled must be true or false.'), { code: 'INVALID_VALUE', status: 400 });
    const before = read();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ enabled: next, updatedAt: new Date(now()).toISOString() }, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
    cache = null;
    const changed = next !== before;
    if (changed) log('automation-browser', next ? `owner access ON: ${AUTOMATION_BROWSER_OWNER_ACCESS_NOTICE}` : 'owner access OFF: the automation browser is refused the owner\'s page secret and authority again');
    try { broadcast({ type: AUTOMATION_BROWSER_OWNER_ACCESS_EVENT, ...view() }); } catch { /* nobody listening */ }
    if (changed) for (const listener of [...listeners]) { try { listener(next); } catch { /* the listener's own failure */ } }
    return view();
  }
  /** The notice a server that starts with the setting on writes to its log (null when off). */
  function startupNotice() {
    return read() ? `[automation-browser] owner access is ON: ${AUTOMATION_BROWSER_OWNER_ACCESS_NOTICE}` : null;
  }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }

  return { enabled: read, view, set, subscribe, startupNotice, path };
}
