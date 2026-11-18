// What Settings → Connected tools → MoreLogin says about MoreLogin's daily start limit, without the page.
// No imports: `node --test` loads it (tests/morelogin-start-cooldown.test.mjs).
//
// When MoreLogin refuses to start a profile because its plan's daily launches are used up, SynaBun holds every
// further start of that profile until MoreLogin's day resets (lib/morelogin-start-cooldown.js) and lists the held
// profiles as `startCooldowns` in GET /api/browser/morelogin-envs and GET /api/morelogin/status:
// [{ envId, name, resetAt (ISO), resetLocal, since, apiCode }]. The page shows one line per profile:
// "Start limit reached for <profile name>, resets <local time>".

/** The reset time in the viewer's own time zone: the time alone when it is today, else with the day. */
export function formatResetTime(resetAt, { now = Date.now(), locale = undefined } = {}) {
  const at = new Date(resetAt);
  if (Number.isNaN(at.getTime())) return '';
  const today = new Date(now);
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  const options = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  try { return new Intl.DateTimeFormat(locale, options).format(at); }
  catch { return at.toLocaleString(); }
}

/**
 * The held profiles still in force at `now`, each with the name to show and its reset time:
 * [{ envId, name, resetAt, time }]. The name is the server's, else the one in `envs` (the picker's list), else the id.
 */
export function startLimitNotes(cooldowns, envs = [], { now = Date.now(), locale = undefined } = {}) {
  if (!Array.isArray(cooldowns)) return [];
  const names = new Map((Array.isArray(envs) ? envs : []).filter((e) => e && e.id != null && e.name).map((e) => [String(e.id), String(e.name)]));
  const out = [];
  for (const c of cooldowns) {
    if (!c || !c.envId) continue;
    const until = Date.parse(c.resetAt);
    if (!Number.isFinite(until) || until <= now) continue;
    out.push({ envId: String(c.envId), name: c.name || names.get(String(c.envId)) || String(c.envId), resetAt: c.resetAt, time: formatResetTime(c.resetAt, { now, locale }) });
  }
  return out;
}

// A profile closed outside SynaBun (lib/morelogin-outside-close.js): SynaBun does not start it again for any session,
// run, agent or script until the owner starts it (MoreLogin, or Start here), a new scheduled run fires, or MoreLogin's
// daily reset (`holdUntil`). Listed as `closedOutside` in the same answers:
// [{ envId, name, closedAt (ISO), closedLocal, holdUntil (ISO), holdUntilLocal, runs }]. The page shows one line per
// profile: "Closed outside SynaBun at <local time>; SynaBun won't reopen <profile name> until you start it".

/**
 * The closes still in force at `now`, each with the name to show and the close time:
 * [{ envId, name, closedAt, time }]. The name is the server's, else the one in `envs`, else the id.
 */
export function closedOutsideNotes(closes, envs = [], { now = Date.now(), locale = undefined } = {}) {
  if (!Array.isArray(closes)) return [];
  const names = new Map((Array.isArray(envs) ? envs : []).filter((e) => e && e.id != null && e.name).map((e) => [String(e.id), String(e.name)]));
  const out = [];
  for (const c of closes) {
    if (!c || !c.envId) continue;
    const until = Date.parse(c.holdUntil);
    if (Number.isFinite(until) && until <= now) continue;
    const at = Date.parse(c.closedAt);
    if (!Number.isFinite(at)) continue;
    out.push({ envId: String(c.envId), name: c.name || names.get(String(c.envId)) || String(c.envId), closedAt: c.closedAt, time: formatResetTime(c.closedAt, { now, locale }) });
  }
  return out;
}
