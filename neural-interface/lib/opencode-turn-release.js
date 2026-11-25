// What a serve of SynaBun's does right before it is stopped: the turns still running on it are interrupted, so that
// no session stays claimed in OpenCode's database.
//
// Why (measured on OpenCode 2.2.7 and 2.4.1, 2026-11-23): a session whose turn is in flight has `time_suspended` set
// in OpenCode's `session_v2` table. A serve that ends with the turn still running leaves that mark: on SIGKILL
// (`taskkill /F`, what Windows gets) and on SIGTERM alike. A serve started the way SynaBun starts one (`opencode
// serve`) never looks at the mark again, but OpenCode's own background service (the one a plain `opencode` in a
// terminal starts) resumes EVERY marked session at its boot, all at once, and each one calls its model again. A
// session a schedule ran weeks ago wakes up then. `POST /api/session/<id>/interrupt` on the serve that runs the turn
// clears the mark; on any other serve it changes nothing, so the only moment to do it is before the stop.
//
// The caller's stop is never held up for long: one read of the active sessions, one interrupt for each, and a short
// wait for the serve to say they ended, all inside `budgetMs`. A serve that does not answer is stopped as before.
import { basicAuthHeader } from './opencode-protocol.js';

/** How long a stop waits for its serve's turns to end, at most. */
export const TURN_RELEASE_BUDGET_MS = 2500;

const pause = (ms) => new Promise((done) => { const timer = setTimeout(done, ms); timer.unref?.(); });

async function request(fetchImpl, url, { method = 'GET', password, timeoutMs }) {
  const res = await fetchImpl(url, {
    method,
    headers: { accept: 'application/json', ...(password ? { authorization: basicAuthHeader(password) } : {}) },
    signal: AbortSignal.timeout(Math.max(1, Math.round(timeoutMs))),
  });
  let body = null;
  try { body = await res.json(); } catch { /* no JSON body */ }
  return { ok: res.ok, status: res.status, body };
}

/**
 * The sessions a serve is running a turn for right now: `{ ok, ids, error }`. `ok` false when the serve did not
 * answer its own API (stopped already, another server on the port, a refused password): nothing is known then.
 */
export async function activeOpencodeSessions({ port, password = null, host = '127.0.0.1', fetchImpl = globalThis.fetch, timeoutMs = 1000 } = {}) {
  if (!(Number(port) > 0)) return { ok: false, ids: [], error: 'no port' };
  try {
    const answer = await request(fetchImpl, `http://${host}:${port}/api/session/active`, { password, timeoutMs });
    if (!answer.ok) return { ok: false, ids: [], error: `GET /api/session/active answered ${answer.status}` };
    const data = answer.body?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, ids: [], error: 'GET /api/session/active answered no list' };
    return { ok: true, ids: Object.keys(data), error: null };
  } catch (error) {
    return { ok: false, ids: [], error: String(error?.message || error) };
  }
}

/**
 * Interrupt every turn a serve is running and wait, inside `budgetMs`, until it reports none of them.
 * `{ ok, active, interrupted, remaining, ms, error }`: `active` the sessions that were running, `interrupted` the
 * ones the serve took the interrupt for, `remaining` the ones still running when the budget ended (they stay
 * claimed). Never throws.
 */
export async function releaseOpencodeTurns({
  port, password = null, host = '127.0.0.1', fetchImpl = globalThis.fetch,
  budgetMs = TURN_RELEASE_BUDGET_MS, pollMs = 100, now = Date.now, sleep = pause,
} = {}) {
  const started = now();
  const left = () => budgetMs - (now() - started);
  const done = (result) => ({ active: [], interrupted: [], remaining: [], error: null, ...result, ms: now() - started });
  const first = await activeOpencodeSessions({ port, password, host, fetchImpl, timeoutMs: Math.min(1000, Math.max(1, budgetMs)) });
  if (!first.ok) return done({ ok: false, error: first.error });
  if (!first.ids.length) return done({ ok: true });
  const interrupted = [];
  await Promise.all(first.ids.map(async (id) => {
    try {
      const answer = await request(fetchImpl, `http://${host}:${port}/api/session/${encodeURIComponent(id)}/interrupt`, { method: 'POST', password, timeoutMs: Math.max(1, left()) });
      if (answer.ok) interrupted.push(id);
    } catch { /* it stays in `remaining` */ }
  }));
  let remaining = first.ids;
  while (left() > 0) {
    const look = await activeOpencodeSessions({ port, password, host, fetchImpl, timeoutMs: Math.max(1, Math.min(1000, left())) });
    // A serve that stopped answering has ended: nothing more can be asked of it.
    if (!look.ok) return done({ ok: false, active: first.ids, interrupted, remaining, error: look.error });
    remaining = first.ids.filter((id) => look.ids.includes(id));
    if (!remaining.length) break;
    if (left() <= pollMs) break;
    await sleep(pollMs);
  }
  return done({ ok: remaining.length === 0, active: first.ids, interrupted, remaining, error: remaining.length ? 'turns still running when the wait ended' : null });
}

/**
 * How SynaBun ends its serves: `end()` releases a serve's turns and then runs its `kill`, exactly once.
 *
 *   end({ port, password, alive, kill, label, immediate })
 *       → null when the serve was ended at once (nothing can be asked of it: no port or password, its process is
 *         gone, or `immediate`), else a promise of its end. `kill` always runs, also when the release failed.
 *   settled(timeoutMs)   every end under way has finished (true), or the wait ran out (false): a shutdown waits here.
 *   killNow()            the kills not run yet, now and synchronously: the process's exit handler, where nothing
 *                        can be awaited, so that a serve whose release was still under way is not left running.
 */
export function createServeEnds({ release = releaseOpencodeTurns, log = () => {} } = {}) {
  const pending = new Set();
  const kills = new Set();
  return {
    end({ port = null, password = null, alive = () => true, kill, label = 'serve', immediate = false } = {}) {
      let ran = false;
      const once = () => {
        if (ran) return;
        ran = true;
        kills.delete(once);
        try { kill?.(); } catch { /* its process is gone */ }
      };
      let running = false;
      try { running = !!alive(); } catch { running = false; }
      if (immediate || !(Number(port) > 0) || !password || !running) { once(); return null; }
      kills.add(once);
      const ended = (async () => {
        try {
          const released = await release({ port, password });
          if (released?.active?.length) {
            const kept = released.remaining?.length || 0;
            log(`${label}: ${released.active.length - kept} of ${released.active.length} running turn(s) interrupted before the stop${kept ? `; ${kept} did not end in time and may be resumed by OpenCode's own background service` : ''}`);
          }
        } catch { /* the serve is ended either way */ } finally { once(); }
      })().finally(() => pending.delete(ended));
      pending.add(ended);
      return ended;
    },
    killNow() { for (const kill of [...kills]) kill(); },
    size: () => pending.size,
    async settled(timeoutMs = TURN_RELEASE_BUDGET_MS + 1500) {
      if (!pending.size) return true;
      let timer = null;
      const timeout = new Promise((done) => { timer = setTimeout(() => done(false), timeoutMs); timer.unref?.(); });
      const all = Promise.allSettled([...pending]).then(() => true);
      const result = await Promise.race([all, timeout]);
      clearTimeout(timer);
      return result;
    },
  };
}

// ── A serve older than the OpenCode on disk ────────────────────────────────────────────────────────────────────────
//
// An update of OpenCode replaces the file; a serve SynaBun started before keeps running the old program from memory
// (on Windows OpenCode's updater links the running file under another name first, so the installed path can be
// replaced while SynaBun's serve runs from it). Nothing told SynaBun: its shared serve, and the serve of every open
// session, stayed on the old version until SynaBun itself was restarted, and the panel kept showing that version.
// OpenCode treats the same situation in its own client as a reason to replace the server ("Restarting background
// server (version mismatch)").

/** A file's identity (lib/opencode-serve-probe.js binaryIdentity) as one string, or null. */
export function binaryFileKey(identity) {
  if (!identity?.realpath) return null;
  return [identity.realpath, identity.size, identity.mtimeMs, identity.ino, identity.dev].join('|');
}

/**
 * Which of SynaBun's serves run a file that is no longer the OpenCode on disk.
 *
 *   current   the file key of the OpenCode SynaBun would start now; null (not readable, a command line in Settings):
 *             nothing is decided
 *   shared    { key, managed, ready, starting }: SynaBun's shared serve. Only one SynaBun spawned (`managed`) and
 *             that answers (`ready`, not `starting`) is restarted.
 *   isolated  [{ termId, key, busy }]: the serves of sessions, loops, workers and brains. One that runs a turn, is
 *             starting, or belongs to a live run (`busy`) is left for a later look.
 *
 * → { shared: 'keep' | 'restart', isolated: [termId], waiting: [termId] }
 */
export function staleServePlan({ current = null, shared = null, isolated = [] } = {}) {
  const plan = { shared: 'keep', isolated: [], waiting: [] };
  if (!current) return plan;
  if (shared?.managed && shared.ready && !shared.starting && shared.key && shared.key !== current) plan.shared = 'restart';
  for (const serve of isolated) {
    if (!serve?.termId || !serve.key || serve.key === current) continue;
    (serve.busy ? plan.waiting : plan.isolated).push(serve.termId);
  }
  return plan;
}
