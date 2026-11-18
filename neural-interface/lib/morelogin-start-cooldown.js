/**
 * MoreLogin's daily start quota, remembered per profile (2026-11-15).
 *
 * MoreLogin's plan caps how many profile launches an account makes per day: past it, `/api/env/start` answers code
 * 19124 ("The daily startup limit is exceeded. Please upgrade the package to increase the daily limit."). About 90
 * scheduled runs a day share one profile, and each failed run asked for a start at least twice (strategy 2 of
 * acquireSharedBrowserTab, then the recover / create paths), so the whole afternoon kept asking MoreLogin for starts
 * it had already refused. Once a start of a profile is refused for the plan's limit, SynaBun does not ask MoreLogin to
 * start that profile again until MoreLogin's next day: every start fails at once with the same error
 * (MORELOGIN_START_REFUSED, the same apiCode / planLimit / needsUser) and the reset time.
 *
 * When MoreLogin's day starts, found from MoreLogin's own logs (`~/Library/Application Support/MoreLogin/logs`):
 * every launch is an `envkit.*.log` line "get shop detail:-{"id":"<envId>",…}" (one `main.*.log` "onopensucceedbrower"
 * each). Today's (2026-11-15) first refusal was at 15:02:54 local time (UTC-03:00, 18:02:54 UTC), 33 s after the
 * last launch that worked (15:02:21). Launches counted before it, per candidate day:
 *   - local day (UTC-03:00, from 03:00 UTC): 13 today (plus an unlogged stretch 00:00-02:57 local), while the
 *     local day 2026-11-14 had 23 launches that all worked: not a cap of 20;
 *   - UTC+8 day (from 16:00 UTC, 13:00 local): only 5 launches in the window that refused, while the UTC+8 day before
 *     it took 24: ruled out;
 *   - UTC day (from 00:00 UTC, 21:00 local): 18 logged today plus the unlogged stretch, and no earlier UTC day above
 *     19 (11-08: 6, 11-09: 2, 11-10: 16, 11-11: 17, 11-12: 5, 11-13: 9, 11-14: 19). MoreLogin's own counter read
 *     "5/20" just before the launch of 2026-11-14 03:08:48 local and "6/20" after it: 5 is exactly the count of that
 *     UTC day so far (the local day had 4).
 * So the quota is 20 launches per UTC day for the account, and it resets at 00:00 UTC. A launch is spent only when the
 * profile is not running already (startProfile asks the status first and attaches to a running profile).
 *
 * A refusal right after a reset (within RESET_SLACK_MS) holds only RESET_SLACK_MS: MoreLogin's clock may be a little
 * behind ours, and a whole day's wait for that would be wrong.
 *
 * State: in memory, and in DATA_HOME/data/morelogin-start-cooldowns.json (another process, such as fetch-deals.mjs,
 * and the next start of the server read the same). Only a plan-limit refusal is kept; any other refusal is not.
 * The copy in memory is read again whenever the file changed under it (its size or modification time), so a refusal
 * another process noted holds here too, and a save never writes over an entry another process added meanwhile.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataHome } from '../../lib/paths.js';

export const RESET_SLACK_MS = 15 * 60_000;
const MAX_ENTRIES = 200;
const DAY_MS = 24 * 60 * 60_000;

/** The file the cooldowns live in (read through getDataHome each time: SYNABUN_DATA_HOME decides, tests use a temp one). */
export function cooldownFile() {
  return join(getDataHome(), 'data', 'morelogin-start-cooldowns.json');
}

/** The first 00:00 UTC after `at` (ms): when MoreLogin's daily start quota resets. */
export function nextMoreLoginDayReset(at = Date.now()) {
  return (Math.floor(at / DAY_MS) + 1) * DAY_MS;
}

/** Until when a refusal at `at` holds: the next reset, or RESET_SLACK_MS when the last reset was only just now. */
export function cooldownUntil(at = Date.now()) {
  const lastReset = Math.floor(at / DAY_MS) * DAY_MS;
  if (at - lastReset < RESET_SLACK_MS) return at + RESET_SLACK_MS;
  return nextMoreLoginDayReset(at);
}

/** A time in the computer's own zone, as people read it: "2026-11-15 21:00 (UTC-03:00)". */
export function formatLocalTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} (UTC${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)})`;
}

let _entries = null; // envId → { envId, since, until, apiCode, reason }
let _loadedFrom = null;
let _loadedStamp = null; // the file's size and modification time when it was last read or written here

/** What tells one version of the file from the next: 'none' while there is none. */
function fileStamp(file) {
  try { const s = statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return 'none'; }
}

function load() {
  const file = cooldownFile();
  const stamp = fileStamp(file);
  if (_entries && _loadedFrom === file && _loadedStamp === stamp) return _entries;
  _entries = new Map();
  _loadedFrom = file;
  _loadedStamp = stamp;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    for (const e of Array.isArray(raw?.cooldowns) ? raw.cooldowns : []) {
      const until = Number(e?.until);
      if (!e?.envId || !Number.isFinite(until)) continue;
      _entries.set(String(e.envId), {
        envId: String(e.envId), since: Number(e.since) || null, until,
        apiCode: e.apiCode ?? null, reason: typeof e.reason === 'string' ? e.reason.slice(0, 500) : '',
      });
    }
  } catch { /* none yet, or unreadable: no cooldown (a start is asked, and a refusal writes it again) */ }
  return _entries;
}

function save() {
  const file = cooldownFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, cooldowns: [..._entries.values()] }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    // What this process wrote is what it holds: not read back on the next call.
    _loadedStamp = fileStamp(file);
  } catch (err) {
    console.warn(`[morelogin] could not save the start cooldowns (${err?.message || err}); they hold in memory until a restart`);
  }
}

function prune(now) {
  let changed = false;
  for (const [id, e] of load()) if (!(e.until > now)) { _entries.delete(id); changed = true; }
  return changed;
}

/**
 * Note a refused start. Kept only for a plan-limit refusal (`err.planLimit`): returns the entry, or null.
 */
export function noteStartRefusal(envId, err, now = Date.now()) {
  if (!envId || !err?.planLimit) return null;
  const entries = load();
  prune(now);
  const reason = String(err.reason || err.message || '').slice(0, 500);
  const entry = { envId: String(envId), since: now, until: cooldownUntil(now), apiCode: err.apiCode ?? null, reason };
  entries.delete(entry.envId); // newest last
  entries.set(entry.envId, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  save();
  return { ...entry };
}

/** The cooldown that holds for a profile now, or null. */
export function activeStartCooldown(envId, now = Date.now()) {
  if (!envId) return null;
  const e = load().get(String(envId));
  if (!e) return null;
  if (!(e.until > now)) { _entries.delete(String(envId)); save(); return null; }
  return { ...e };
}

/** Every cooldown that holds now: [{ envId, since, until, apiCode, reason, resetAt, resetLocal }]. */
export function listStartCooldowns(now = Date.now()) {
  if (prune(now)) save();
  return [...load().values()].map((e) => ({ ...e, resetAt: new Date(e.until).toISOString(), resetLocal: formatLocalTime(e.until) }));
}

/** End a profile's cooldown (a start that worked: the quota was reset or raised). */
export function clearStartCooldown(envId) {
  if (!envId) return false;
  const had = load().delete(String(envId));
  if (had) save();
  return had;
}

/** Forget what is held in memory: the next call reads the file again (what a new process or a reload sees). */
export function _reloadStartCooldownsForTests() { _entries = null; _loadedFrom = null; }
