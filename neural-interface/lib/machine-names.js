// ═══════════════════════════════════════════
// SynaBun — the names this computer answers to
// ═══════════════════════════════════════════
//
// The Host rule (lib/http-guards.js isAllowedHost) lets a request through that
// names this computer. os.hostname() is one such name and not always the one a
// browser on the network uses: on macOS the Bonjour name ("LocalHostName", what
// <name>.local resolves) is set apart from the kernel's host name, and the two
// differ on many machines (os.hostname() "Mac", Bonjour "Someones-MacBook").
//
// macOS is asked through scutil: `--get LocalHostName` and `--get HostName`,
// run by argument array (no shell), read into a cache. Never per request: the
// answers are kept, and asked for again only when a name that is not known is
// being checked and the last answers are older than a minute (a renamed
// computer is picked up without a restart; a flood of unknown names costs one
// pair of calls a minute). Everywhere else os.hostname() is the whole answer.
//
// Nothing here throws or rejects: a system that cannot be asked adds no name.

import { execFile } from 'node:child_process';
import { hostname as osHostname, platform as osPlatform } from 'node:os';

/** How long the system's answers are taken as they are. */
export const MACHINE_NAMES_REFRESH_MS = 60_000;
const PROBE_TIMEOUT_MS = 1500;
const SCUTIL = '/usr/sbin/scutil';
const SCUTIL_KEYS = ['LocalHostName', 'HostName'];

/** One `scutil --get <key>`: the name it prints, or '' (the key is not set, there is no scutil, it took too long). */
function askScutil(key) {
  return new Promise((done) => {
    try {
      execFile(SCUTIL, ['--get', key], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', shell: false }, (error, stdout) => {
        done(error ? '' : String(stdout || '').trim());
      });
    } catch {
      done('');
    }
  });
}

/**
 * @param {object} [deps]
 * @param {() => string} [deps.hostname] os.hostname
 * @param {string} [deps.platform] os.platform()
 * @param {(key: string) => Promise<string>} [deps.ask] one name of the system's configuration (macOS: scutil --get)
 * @param {() => number} [deps.now]
 * @param {number} [deps.refreshMs]
 * @returns {{ names: () => string[], refresh: () => Promise<string[]>, stale: () => boolean }}
 *   `names`: what is known now, os.hostname() first (it never waits; while the answers are old it asks again in the
 *   background); `refresh`: ask the system now, one call shared by everybody who waits for it; `stale`: waiting
 *   for `refresh()` could add a name, because the answers are old or new ones are on their way (false where the
 *   system is never asked)
 */
export function createMachineNames({ hostname = osHostname, platform = osPlatform(), ask = askScutil, now = Date.now, refreshMs = MACHINE_NAMES_REFRESH_MS } = {}) {
  const asks = platform === 'darwin';
  let found = [];          // what the system said beyond os.hostname()
  let askedAt = null;      // when it was last asked (null: never)
  let pending = null;

  const kernelName = () => { try { return String(hostname() || ''); } catch { return ''; } };
  const list = () => [...new Set([kernelName(), ...found].filter(Boolean))];
  // An answer newer than what is known is due, or on its way.
  const stale = () => asks && (pending !== null || askedAt === null || now() - askedAt >= refreshMs);

  function refresh() {
    if (!asks) return Promise.resolve(list());
    if (pending) return pending;
    askedAt = now();
    pending = Promise.all(SCUTIL_KEYS.map((key) => Promise.resolve().then(() => ask(key)).catch(() => '')))
      .then((answers) => { found = answers.map((answer) => String(answer || '').trim()).filter(Boolean); })
      .catch(() => {})
      .then(() => { pending = null; return list(); });
    return pending;
  }

  return {
    names() {
      if (stale()) refresh();
      return list();
    },
    refresh,
    stale,
  };
}

/** This process's own: what isAllowedHost reads when it is given no machine name. */
export const machineNames = createMachineNames();
