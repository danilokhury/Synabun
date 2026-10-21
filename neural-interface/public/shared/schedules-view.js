// SynaBun Neural Interface — what the Schedules window shows, without the page.
// Which schedules a view lists and in which order, how a schedule's state reads, and the cron
// in plain words. ui-schedules-studio.js draws it; tests import this file under Node, so it
// has no imports and never touches the DOM.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
// A run this late is overdue, not merely due: the scheduler missed it.
export const OVERDUE_AFTER = 5 * MINUTE;
// "Up next" looks this far ahead.
export const UP_NEXT_WINDOW = DAY;

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const VIEW_SCOPES = ['upcoming', 'all', 'attention', 'paused', 'timers', 'activity'];
export const LIST_SCOPES = ['upcoming', 'all', 'attention', 'paused'];
export const SORTS = ['next', 'name', 'last'];

const pad = (n) => String(n).padStart(2, '0');
const time = (t) => (Number.isFinite(t) ? t : NaN);
const parse = (iso) => (iso ? time(Date.parse(iso)) : NaN);

/** "a", "a and b", "a, b and c". */
export function listJoin(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

function dayList(field) {
  if (field === '*' || field === '?') return 'Every day';
  if (field === '1-5') return 'Weekdays';
  if (field === '0,6' || field === '6,0' || field === '6,7') return 'Weekends';
  const parts = field.split(',');
  const names = [];
  for (const part of parts) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      const from = DAY_SHORT[+range[1] % 7], to = DAY_SHORT[+range[2] % 7];
      if (!from || !to) return null;
      names.push(`${from}–${to}`);
    } else if (/^\d$/.test(part)) {
      names.push(DAY_SHORT[+part % 7]);
    } else {
      return null;
    }
  }
  return listJoin(names);
}

function timesOf(minute, hour) {
  const m = /^\d{1,2}$/.test(minute) ? +minute : null;
  if (minute === '*' && hour === '*') return { every: 'every minute' };
  const minStep = minute.match(/^\*\/(\d+)$/);
  if (minStep && hour === '*') return { every: `every ${minStep[1]} minutes` };
  if (m == null) {
    // Several minutes in one hour: "at 09:00 and 09:30".
    if (/^\d{1,2}(,\d{1,2})+$/.test(minute) && /^\d{1,2}$/.test(hour)) {
      return { at: listJoin(minute.split(',').map(x => `${pad(+hour)}:${pad(+x)}`)) };
    }
    return null;
  }
  if (hour === '*') return { every: `every hour at :${pad(m)}` };
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep) return { every: `every ${hourStep[1]} hours at :${pad(m)}` };
  const hourRange = hour.match(/^(\d{1,2})-(\d{1,2})$/);
  if (hourRange) return { every: `every hour from ${pad(+hourRange[1])}:${pad(m)} to ${pad(+hourRange[2])}:${pad(m)}` };
  if (/^\d{1,2}(,\d{1,2})*$/.test(hour)) return { at: listJoin(hour.split(',').map(h => `${pad(+h)}:${pad(m)}`)) };
  return null;
}

/**
 * A five-field cron in plain words: "Every day at 06:55, 14:55 and 20:55", "Weekdays at 09:00",
 * "Every 15 minutes". Anything it cannot say plainly comes back as the expression itself.
 */
export function describeCron(cron) {
  const expr = String(cron ?? '').trim();
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) return expr;
  const [minute, hour, dom, month, dow] = fields;
  if (month !== '*') return expr;
  let days;
  if (dom === '*' || dom === '?') days = dayList(dow);
  else if (dow === '*' && /^\d{1,2}(,\d{1,2})*$/.test(dom)) {
    const dates = dom.split(',').map(Number);
    days = `${dates.length > 1 ? 'Days' : 'Day'} ${listJoin(dates)} of every month`;
  } else return expr;
  const times = timesOf(minute, hour);
  if (!days || !times) return expr;
  if (times.at) return `${days} at ${times.at}`;
  const every = times.every.charAt(0).toUpperCase() + times.every.slice(1);
  return days === 'Every day' ? every : `${days}, ${times.every}`;
}

/** One line of text from a run result: no newlines, no runs of spaces. */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * How the last run went, apart from whether the schedule is on: `kind` is ok, failed, started,
 * stopped, interrupted, never or other; `label` is the word to show; `reason` the server's words.
 */
export function lastRunState(schedule) {
  const raw = schedule?.lastRunResult;
  if (raw == null || raw === '') return { kind: 'never', label: 'Not run yet', reason: '' };
  const text = String(raw);
  if (text === 'completed') return { kind: 'ok', label: 'Completed', reason: '' };
  if (text === 'launched' || text === 'running' || text === 'started') return { kind: 'started', label: 'Started', reason: '' };
  if (text === 'template_missing') return { kind: 'failed', label: 'Automation missing', reason: 'The automation this schedule launches no longer exists.' };
  const colon = text.indexOf(':');
  const head = (colon >= 0 ? text.slice(0, colon) : text).trim();
  const reason = colon >= 0 ? text.slice(colon + 1).trim() : '';
  if (head === 'error') return { kind: 'failed', label: 'Failed', reason: reason || 'The run failed.' };
  if (head === 'stopped') return { kind: 'stopped', label: 'Stopped', reason: reason === 'user' ? 'Stopped by you' : reason };
  if (head === 'interrupted') return { kind: 'interrupted', label: 'Interrupted', reason };
  return { kind: 'other', label: head.charAt(0).toUpperCase() + head.slice(1), reason };
}

export const isFailing = (schedule) => lastRunState(schedule).kind === 'failed';

export function isOverdue(schedule, now = Date.now()) {
  const next = parse(schedule?.nextRun);
  return !!schedule?.enabled && Number.isFinite(next) && next < now - OVERDUE_AFTER;
}

/** An active schedule whose last run failed, or that missed its time. A paused one waits for you. */
export function needsAttention(schedule, now = Date.now()) {
  return !!schedule?.enabled && (isFailing(schedule) || isOverdue(schedule, now));
}

export function isUpcoming(schedule, now = Date.now(), within = UP_NEXT_WINDOW) {
  const next = parse(schedule?.nextRun);
  return !!schedule?.enabled && Number.isFinite(next) && next >= now - OVERDUE_AFTER && next <= now + within;
}

const groupIdOf = (scope) => (typeof scope === 'string' && scope.startsWith('group:') ? scope.slice(6) : null);
export { groupIdOf };

/** Does a schedule belong to a list scope (a view, a group, or ungrouped)? */
export function inScope(schedule, scope, { now = Date.now(), groupIds = null } = {}) {
  const groupId = groupIdOf(scope);
  if (groupId) return schedule.groupId === groupId;
  switch (scope) {
    case 'upcoming': return isUpcoming(schedule, now);
    case 'attention': return needsAttention(schedule, now);
    case 'paused': return !schedule.enabled;
    case 'ungrouped': return !schedule.groupId || (groupIds ? !groupIds.has(schedule.groupId) : false);
    default: return true;
  }
}

/** The counts the rail shows next to each view. */
export function scopeCounts(schedules, now = Date.now()) {
  const counts = { upcoming: 0, all: schedules.length, attention: 0, paused: 0, active: 0, failing: 0 };
  for (const s of schedules) {
    if (isUpcoming(s, now)) counts.upcoming++;
    if (needsAttention(s, now)) counts.attention++;
    if (s.enabled) counts.active++; else counts.paused++;
    if (isFailing(s)) counts.failing++;
  }
  return counts;
}

/** How many of a group's schedules are on, paused and need attention. */
export function groupSummary(schedules, now = Date.now()) {
  const summary = { total: schedules.length, active: 0, paused: 0, attention: 0 };
  for (const s of schedules) {
    if (s.enabled) summary.active++; else summary.paused++;
    if (needsAttention(s, now)) summary.attention++;
  }
  return summary;
}

/** Lower case, accents gone: "Ação" finds "acao". */
export function fold(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Every word of the query must appear in the schedule's name, its automation, its group, its
 * cadence or its model. `extra` adds the words the caller knows (automation and group names).
 */
export function matchesQuery(schedule, query, extra = []) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = fold([
    schedule.name, schedule.cron, describeCron(schedule.cron), schedule.model, schedule.profile, ...extra,
  ].filter(Boolean).join(' \u0000 '));
  return terms.every(term => haystack.includes(term));
}

const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });

/** next: active first, soonest first. name: A to Z. last: most recent run first. */
export function sortSchedules(list, sort = 'next') {
  const copy = [...list];
  if (sort === 'name') return copy.sort(byName);
  if (sort === 'last') {
    return copy.sort((a, b) => {
      const at = parse(a.lastRun), bt = parse(b.lastRun);
      const av = Number.isFinite(at) ? at : -Infinity, bv = Number.isFinite(bt) ? bt : -Infinity;
      return av !== bv ? bv - av : byName(a, b);
    });
  }
  return copy.sort((a, b) => {
    if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1;
    const at = parse(a.nextRun), bt = parse(b.nextRun);
    const av = Number.isFinite(at) ? at : Infinity, bv = Number.isFinite(bt) ? bt : Infinity;
    return av !== bv ? av - bv : byName(a, b);
  });
}

/** "in 45 s", "in 26 min", "in 3 h 5 min", "in 2 d 4 h"; "Due now"; "Overdue". */
export function formatCountdown(iso, now = Date.now()) {
  const next = parse(iso);
  if (!Number.isFinite(next)) return { text: 'Not scheduled', state: 'none' };
  const diff = next - now;
  if (diff <= 0) return diff > -OVERDUE_AFTER ? { text: 'Due now', state: 'due' } : { text: 'Overdue', state: 'overdue' };
  if (diff < MINUTE) return { text: `in ${Math.ceil(diff / 1000)} s`, state: 'soon' };
  if (diff < HOUR) return { text: `in ${Math.floor(diff / MINUTE)} min`, state: diff < 15 * MINUTE ? 'soon' : 'future' };
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR), m = Math.floor((diff % HOUR) / MINUTE);
    return { text: m ? `in ${h} h ${m} min` : `in ${h} h`, state: 'future' };
  }
  const d = Math.floor(diff / DAY), h = Math.floor((diff % DAY) / HOUR);
  return { text: h ? `in ${d} d ${h} h` : `in ${d} d`, state: 'future' };
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 d ago". */
export function formatAgo(iso, now = Date.now()) {
  const then = parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, now - then);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  const days = Math.floor(diff / DAY);
  return days === 1 ? 'yesterday' : `${days} d ago`;
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
// The window's words are English, so are its dates: "Wed 22 Oct", never half in another language.
const LOCALE = 'en-GB';

/** "Today", "Tomorrow", "Yesterday" or the weekday and date, for a heading or a time. */
export function dayLabel(iso, now = Date.now(), locale = LOCALE) {
  const then = new Date(parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  const today = new Date(now);
  if (sameDay(then, today)) return 'Today';
  if (sameDay(then, new Date(now + DAY))) return 'Tomorrow';
  if (sameDay(then, new Date(now - DAY))) return 'Yesterday';
  return then.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** 24-hour clock, as the cron descriptions are: "14:55". */
export function clockTime(iso, locale = LOCALE) {
  const then = new Date(parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  return then.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** "Today 14:55", "Tomorrow 09:00", "Wed 22 Oct 09:00". */
export function whenLabel(iso, now = Date.now(), locale = LOCALE) {
  const day = dayLabel(iso, now, locale);
  const clock = clockTime(iso, locale);
  return day && clock ? `${day} ${clock}` : '';
}

/** A run time in the fewest words: "14:55" today, "Tomorrow 09:00", "Wed 09:00" this week, then "22 Oct". */
export function shortWhen(iso, now = Date.now(), locale = LOCALE) {
  const at = parse(iso);
  if (!Number.isFinite(at)) return '';
  const then = new Date(at);
  const clock = clockTime(iso, locale);
  if (sameDay(then, new Date(now))) return clock;
  if (sameDay(then, new Date(now + DAY))) return `Tomorrow ${clock}`;
  if (at > now && at - now < 6 * DAY) return `${then.toLocaleDateString(locale, { weekday: 'short' })} ${clock}`;
  return then.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/**
 * The launch settings a run will use and where each comes from: the schedule's own value wins,
 * then its group's, then the automation's. `labels` names CLIs (`profiles`) and MCP presets.
 */
export function launchFacts(schedule, { group = null, template = null, profiles = [], mcpLabels = {} } = {}) {
  const pick = (field) => {
    for (const [source, owner] of [['schedule', schedule], ['group', group], ['automation', template]]) {
      const value = owner?.[field];
      if (value !== undefined && value !== null && value !== '') return { value, source };
    }
    return { value: null, source: 'default' };
  };
  const facts = [];
  const profile = pick('profile');
  const profileId = profile.value || 'claude-code';
  facts.push({ key: 'profile', label: 'CLI', value: profiles.find(p => p.id === profileId)?.label || profileId, source: profile.value ? profile.source : 'default' });
  const model = pick('model');
  facts.push({ key: 'model', label: 'Model', value: model.value || 'Default', source: model.source, mono: !!model.value });
  const context = pick('contextMode');
  if (context.value && context.value !== 'default') facts.push({ key: 'contextMode', label: 'Context', value: context.value === '1m' ? '1M tokens' : context.value.charAt(0).toUpperCase() + context.value.slice(1), source: context.source });
  const effort = pick('effort');
  if (effort.value && effort.value !== 'off') facts.push({ key: 'effort', label: 'Thinking', value: effort.value.charAt(0).toUpperCase() + effort.value.slice(1), source: effort.source });
  const mcp = pick('mcpProfile');
  if (mcp.value) {
    const value = mcpLabels[mcp.value] || String(mcp.value).split(',').map(x => x.trim()).filter(Boolean).join(', ');
    facts.push({ key: 'mcpProfile', label: 'MCP tools', value, source: mcp.source });
  }
  if (profileId === 'codex') {
    const account = pick('codexAccountId');
    if (account.value) facts.push({ key: 'codexAccountId', label: 'OpenAI account', value: account.value, source: account.source });
  }
  const browser = pick('usesBrowser');
  facts.push({ key: 'usesBrowser', label: 'Browser', value: browser.value === true ? 'On' : 'Off', source: browser.source });
  return facts;
}
