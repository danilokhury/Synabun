/**
 * A MoreLogin profile closed outside SynaBun, remembered per profile (2026-11-15, widened the same night).
 *
 * Every start of a profile that is not running spends one of the MoreLogin plan's 20 daily launches
 * (lib/morelogin-start-cooldown.js). When a profile's browser goes away and SynaBun did not close it (server.js: the
 * context's close handler, after lib/browser-close-evidence.js wrote its evidence line), whoever closed it wanted it
 * closed. Before this, SynaBun opened it again at the next browser call: on 2026-11-15 one close of P-1 cost two
 * launches within a minute (loops' recover / create, 21:13:44 and 21:14:34 local), and at 23:01 a close of P-4 that
 * orphaned no loop was undone 26 s later by the same interactive session's next browser_navigate ("a replacement tab
 * … is open"), one more launch.
 *
 * Now the close is remembered for the profile, and NO automatic path starts it again while the mark holds: a browser
 * tool call (browser_navigate, browser_session create, a replacement tab, /api/browser/acquire), a loop's create /
 * recover, a run's morelogin "use" followed by a browser call, a run's or agent's morelogin "start", a script
 * (fetch-deals.mjs): lib/morelogin.js startProfile refuses at once with MORELOGIN_CLOSED_OUTSIDE (409, needsUser),
 * before MoreLogin is asked for a start. Nobody is moved to another profile or browser in its place.
 *
 * What lifts it:
 *   - the owner starts it: SynaBun's Start (Settings → Connected tools → MoreLogin, the owner's page; a session the owner's
 *     page creates), or the MoreLogin app, after which MoreLogin lists it running with a debug port. Attaching to a
 *     running profile is always allowed (it spends nothing) and a successful attach or start clears the mark;
 *   - a NEW scheduled run fires (a schedule's or a quick timer's trigger, server.js `schedule:browser`): it may start
 *     the profile as usual, subject to the start-limit hold, and its start clears the mark. A recovery or a create of a
 *     run already under way is not a firing;
 *   - MoreLogin's next daily reset (00:00 UTC after the close): the mark expires there. The reason it exists is the
 *     day's launch budget, and a new day has a new budget; a stale mark would otherwise hold a profile shut for good.
 * A new dispatched worker or a new assistant turn does NOT lift it: they are automatic too, and the point is that
 * the person who closed the profile wanted it closed.
 * A close SynaBun made itself (POST /api/morelogin/stop, its own teardown, the OpenCode serve boundary's revocation,
 * which keeps the window: "SynaBun let go of profile") is never recorded here.
 *
 * `owners`: the runs the close orphaned (server.js finishBlockedLoop ends those loops after their turn; the status
 * route counts them). They no longer decide who is held: everybody is.
 *
 * State: in memory and in DATA_HOME/data/morelogin-outside-closes.json (a restart must not forget it), read again
 * whenever the file changed under it (a script in another process sees the server's marks, and the other way round).
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataHome } from '../../lib/paths.js';
import { formatLocalTime, nextMoreLoginDayReset } from './morelogin-start-cooldown.js';

const MAX_ENTRIES = 200;
const MAX_OWNERS = 100;
const MAX_NAME = 120;

/** Until when a close at `at` holds: MoreLogin's next daily reset (the first 00:00 UTC after it). */
export function outsideCloseUntil(at) {
  return nextMoreLoginDayReset(at);
}

/** The file the marks live in (read through getDataHome each time: SYNABUN_DATA_HOME decides, tests use a temp one). */
export function outsideCloseFile() {
  return join(getDataHome(), 'data', 'morelogin-outside-closes.json');
}

let _entries = null; // envId → { envId, at, until, name, sessionId, owners: string[] }
let _loadedFrom = null;
let _loadedStamp = null;

function fileStamp(file) {
  try { const s = statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return 'none'; }
}

const cleanName = (name) => (typeof name === 'string' && name.trim() ? name.trim().replace(/[\u0000-\u001f"]/g, '').slice(0, MAX_NAME) : null);

function load() {
  const file = outsideCloseFile();
  const stamp = fileStamp(file);
  if (_entries && _loadedFrom === file && _loadedStamp === stamp) return _entries;
  _entries = new Map();
  _loadedFrom = file;
  _loadedStamp = stamp;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    for (const e of Array.isArray(raw?.closes) ? raw.closes : []) {
      const at = Number(e?.at);
      if (!e?.envId || !Number.isFinite(at)) continue;
      // A mark written before the expiry existed (version 1) holds until the reset after its close, like a new one.
      const until = Number.isFinite(Number(e.until)) && Number(e.until) > at ? Number(e.until) : outsideCloseUntil(at);
      const owners = Array.isArray(e.owners) ? e.owners.filter((o) => typeof o === 'string' && o).slice(0, MAX_OWNERS) : [];
      _entries.set(String(e.envId), {
        envId: String(e.envId), at, until, name: cleanName(e.name),
        sessionId: typeof e.sessionId === 'string' ? e.sessionId.slice(0, 128) : null, owners,
      });
    }
  } catch { /* none yet, or unreadable: nothing is blocked */ }
  return _entries;
}

function save() {
  const file = outsideCloseFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 2, closes: [..._entries.values()] }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    _loadedStamp = fileStamp(file);
  } catch (err) {
    console.warn(`[morelogin] could not save the profiles closed outside SynaBun (${err?.message || err}); they hold in memory until a restart`);
  }
}

function prune(now) {
  let changed = false;
  for (const [id, e] of load()) if (!(now < e.until)) { _entries.delete(id); changed = true; }
  return changed;
}

const copy = (e) => ({ ...e, owners: [...e.owners] });

/**
 * Note that `envId` (MoreLogin calls it `name`) was closed outside SynaBun, orphaning the runs `owners`. A second
 * close before the mark is lifted adds its runs to the same mark (the newest time, and its expiry, are kept).
 */
export function noteOutsideClose(envId, { at = Date.now(), sessionId = null, owners = [], name = null } = {}) {
  if (!envId) return null;
  const entries = load();
  prune(at);
  const id = String(envId);
  const before = entries.get(id);
  const merged = [...new Set([...(before?.owners || []), ...owners.filter((o) => typeof o === 'string' && o)])].slice(-MAX_OWNERS);
  const entry = {
    envId: id, at, until: outsideCloseUntil(at), name: cleanName(name) || before?.name || null,
    sessionId: sessionId ? String(sessionId).slice(0, 128) : null, owners: merged,
  };
  entries.delete(id); // newest last
  entries.set(id, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  save();
  return copy(entry);
}

/**
 * The mark that holds for `envId` now, or null. It holds for every caller (any session, run, agent or script); only
 * the owner's start and a new scheduled firing go past it (lib/morelogin.js startProfile `allowAfterOutsideClose`).
 */
export function outsideCloseFor(envId, now = Date.now()) {
  if (!envId) return null;
  // Before the widening the second argument was the run's id: a string is never a time.
  if (typeof now !== 'number') now = Date.now();
  const e = load().get(String(envId));
  if (!e) return null;
  if (!(now < e.until)) { _entries.delete(String(envId)); save(); return null; }
  return copy(e);
}

/** Every mark that holds now: [{ envId, name, at, until, closedAt, closedLocal, holdUntil, holdUntilLocal, sessionId, owners }]. */
export function listOutsideCloses(now = Date.now()) {
  if (prune(now)) save();
  return [...load().values()].map((e) => ({
    ...copy(e),
    closedAt: new Date(e.at).toISOString(), closedLocal: formatLocalTime(e.at),
    holdUntil: new Date(e.until).toISOString(), holdUntilLocal: formatLocalTime(e.until),
  }));
}

/** The profile runs again (attached to, or started by someone allowed to): the mark is over for everybody. */
export function clearOutsideClose(envId) {
  if (!envId) return false;
  const had = load().delete(String(envId));
  if (had) save();
  return had;
}

/**
 * The refusal of a start of a profile closed outside SynaBun. `label`: how the profile is named (`MoreLogin profile
 * "P-4" (id)`), else the name the mark kept, else its id. Code MORELOGIN_CLOSED_OUTSIDE, status 409, needsUser,
 * closedAt, holdUntil; never retried by SynaBun, never answered with another profile.
 */
export function outsideCloseError(envId, entry, { label = null } = {}) {
  const name = label || (entry?.name ? `MoreLogin profile "${entry.name}" (${envId})` : `MoreLogin profile ${envId}`);
  const when = entry?.at ? formatLocalTime(entry.at) : 'an earlier moment';
  const until = entry?.until ? ` SynaBun stops holding it at MoreLogin's daily reset (${formatLocalTime(entry.until)}).` : '';
  const e = new Error(`${name} was closed outside SynaBun at ${when}, and SynaBun will not reopen it by itself: whoever closed it may have wanted it closed, and each start spends one of MoreLogin's daily launches. Nothing was started, and nothing was moved to another profile or browser. To go on, start the profile in MoreLogin or in SynaBun (Settings → Connected tools → MoreLogin → Start): browser calls then attach to it without a new launch. Otherwise wait for its next scheduled run, which starts it as usual.${until} This needs the user, not a retry: report it and stop`);
  e.code = 'MORELOGIN_CLOSED_OUTSIDE';
  e.status = 409;
  e.needsUser = true;
  e.envId = String(envId);
  if (entry?.at) e.closedAt = new Date(entry.at).toISOString();
  if (entry?.until) e.holdUntil = new Date(entry.until).toISOString();
  return e;
}

/** Forget what is held in memory: the next call reads the file again (what a new process or a reload sees). */
export function _reloadOutsideClosesForTests() { _entries = null; _loadedFrom = null; }
