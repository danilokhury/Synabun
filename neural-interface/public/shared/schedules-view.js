import { toolListView } from './tool-list-view.js';
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

export const VIEW_SCOPES = ['upcoming', 'all', 'attention', 'paused', 'timers', 'activity'];
export const LIST_SCOPES = ['upcoming', 'all', 'attention', 'paused'];
export const SORTS = ['next', 'name', 'last'];

// ── Words ──
// SCHEDULES_VIEW_COPY is the English of every word this file shows: `schedules.view.*` in
// i18n/en.json must equal it, and every locale file holds the same keys (the test checks both).
// A `{ one, other }` entry is counted, as i18n's tp() counts. Without a translator (tests, Node)
// the English reads as written; the window installs i18n's t() and the app's locale with
// setSchedulesViewTranslator.
export const SCHEDULES_VIEW_COPY = Object.freeze({
  everyDay: 'Every day',
  weekdays: 'Weekdays',
  weekends: 'Weekends',
  dayRange: '{from}–{to}',
  monthDays: { one: 'Day {days} of every month', other: 'Days {days} of every month' },
  everyMinutes: { one: 'every minute', other: 'every {count} minutes' },
  everyHoursAt: { one: 'every hour at :{minute}', other: 'every {count} hours at :{minute}' },
  everyHourBetween: 'every hour from {from} to {to}',
  daysAt: '{days} at {times}',
  daysEvery: '{days}, {every}',
  listAnd: '{list} and {last}',
  dayShort: { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' },
  dayLong: { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' },
  runNever: 'Not run yet',
  runCompleted: 'Completed',
  runStarted: 'Started',
  runAutomationMissing: 'Automation missing',
  runAutomationMissingReason: 'The automation this schedule launches no longer exists.',
  runFailed: 'Failed',
  runFailedReason: 'The run failed.',
  runStopped: 'Stopped',
  runStoppedByYou: 'Stopped by you',
  runInterrupted: 'Interrupted',
  notScheduled: 'Not scheduled',
  dueNow: 'Due now',
  overdue: 'Overdue',
  inSeconds: 'in {n} s',
  inMinutes: 'in {n} min',
  inHoursMinutes: 'in {h} h {m} min',
  inHours: 'in {h} h',
  inDaysHours: 'in {d} d {h} h',
  inDays: 'in {d} d',
  justNow: 'just now',
  minutesAgo: '{n} min ago',
  hoursAgo: '{n} h ago',
  yesterdayAgo: 'yesterday',
  daysAgo: '{n} d ago',
  today: 'Today',
  tomorrow: 'Tomorrow',
  yesterday: 'Yesterday',
  dayAt: '{day} {time}',
  tomorrowAt: 'Tomorrow {time}',
  weekdayAt: '{day} {time}',
  factCli: 'CLI',
  factModel: 'Model',
  factContext: 'Context',
  factThinking: 'Thinking',
  factMcp: 'Tools and MCP servers',
  factAccount: 'OpenAI account',
  factBrowser: 'Browser',
  valueDefault: 'Default',
  valueOn: 'On',
  valueOff: 'Off',
  context1m: '1M tokens',
  contextExtended: 'Extended',
  effort: { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Xhigh', max: 'Max', ultra: 'Ultra', thinking: 'Thinking' },
});

let _translate = null;
let _locale = null;

/**
 * The page's translator, `(key, params) => t('schedules.view.' + key, params)`, and the app's locale
 * (a code or a function that returns one). An answer that is empty, or the key itself (i18n's word for
 * "no such string"), falls back to the English.
 */
export function setSchedulesViewTranslator(fn, locale = null) {
  _translate = typeof fn === 'function' ? fn : null;
  _locale = locale;
}

const copyAt = (key) => key.split('.').reduce((node, part) => node?.[part], SCHEDULES_VIEW_COPY);
const fill = (text, params) => String(text).replace(/\{(\w+)\}/g, (whole, name) => (params?.[name] != null ? params[name] : whole));

/** A SCHEDULES_VIEW_COPY sentence in the page's language (the translator above, else the English). */
export function scheduleWord(key, params) {
  if (_translate) {
    try {
      const text = _translate(key, params);
      if (typeof text === 'string' && text && text !== key && text !== `schedules.view.${key}`) return text;
    } catch { /* the English below */ }
  }
  const english = copyAt(key);
  return typeof english === 'string' ? fill(english, params) : key;
}

/** A counted sentence: `key.one` for exactly one, `key.other` otherwise (i18n's tp rule). */
const countWord = (key, count, params) => scheduleWord(`${key}.${count === 1 ? 'one' : 'other'}`, { count, ...params });

/**
 * The locale dates and times are written in. English keeps en-GB: the 24-hour clock and day-first dates
 * ("Wed 22 Oct 09:00") the cron descriptions use. Any other language writes them its own way.
 */
export function scheduleDateLocale() {
  const locale = typeof _locale === 'function' ? _locale() : _locale;
  return !locale || /^en(-|$)/i.test(locale) ? 'en-GB' : locale;
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** A weekday (0 = Sunday … 6 = Saturday; 7 is Sunday too, as in cron): "Mon", or "Monday" with `long`. */
export function weekdayName(index, { long = false } = {}) {
  const key = DAY_KEYS[Number(index) % 7];
  return key ? scheduleWord(`${long ? 'dayLong' : 'dayShort'}.${key}`) : '';
}

const pad = (n) => String(n).padStart(2, '0');
const time = (t) => (Number.isFinite(t) ? t : NaN);
const parse = (iso) => (iso ? time(Date.parse(iso)) : NaN);

/** "a", "a and b", "a, b and c" (the last joint in the page's language). */
export function listJoin(items) {
  const list = items.filter(item => item || item === 0).map(String);
  if (list.length <= 1) return list.join('');
  return scheduleWord('listAnd', { list: list.slice(0, -1).join(', '), last: list.at(-1) });
}

/** The days of a cron's day-of-week field: `{ text, everyDay }`, or null when it cannot be said plainly. */
function dayList(field) {
  if (field === '*' || field === '?') return { text: scheduleWord('everyDay'), everyDay: true };
  if (field === '1-5') return { text: scheduleWord('weekdays') };
  if (field === '0,6' || field === '6,0' || field === '6,7') return { text: scheduleWord('weekends') };
  const parts = field.split(',');
  const names = [];
  for (const part of parts) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      const from = weekdayName(range[1]), to = weekdayName(range[2]);
      if (!from || !to) return null;
      names.push(scheduleWord('dayRange', { from, to }));
    } else if (/^\d$/.test(part)) {
      names.push(weekdayName(part));
    } else {
      return null;
    }
  }
  return { text: listJoin(names) };
}

function timesOf(minute, hour) {
  const m = /^\d{1,2}$/.test(minute) ? +minute : null;
  if (minute === '*' && hour === '*') return { every: countWord('everyMinutes', 1) };
  const minStep = minute.match(/^\*\/(\d+)$/);
  if (minStep && hour === '*') return { every: countWord('everyMinutes', +minStep[1]) };
  if (m == null) {
    // Several minutes in one hour: "at 09:00 and 09:30".
    if (/^\d{1,2}(,\d{1,2})+$/.test(minute) && /^\d{1,2}$/.test(hour)) {
      return { at: listJoin(minute.split(',').map(x => `${pad(+hour)}:${pad(+x)}`)) };
    }
    return null;
  }
  if (hour === '*') return { every: countWord('everyHoursAt', 1, { minute: pad(m) }) };
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep) return { every: countWord('everyHoursAt', +hourStep[1], { minute: pad(m) }) };
  const hourRange = hour.match(/^(\d{1,2})-(\d{1,2})$/);
  if (hourRange) return { every: scheduleWord('everyHourBetween', { from: `${pad(+hourRange[1])}:${pad(m)}`, to: `${pad(+hourRange[2])}:${pad(m)}` }) };
  if (/^\d{1,2}(,\d{1,2})*$/.test(hour)) return { at: listJoin(hour.split(',').map(h => `${pad(+h)}:${pad(m)}`)) };
  return null;
}

// A sentence that starts with a phrase written for its middle ("every 15 minutes").
const capitalize = (text) => text.charAt(0).toLocaleUpperCase(scheduleDateLocale()) + text.slice(1);

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
    days = { text: countWord('monthDays', dates.length, { days: listJoin(dates) }) };
  } else return expr;
  const times = timesOf(minute, hour);
  if (!days || !times) return expr;
  if (times.at) return scheduleWord('daysAt', { days: days.text, times: times.at });
  return days.everyDay ? capitalize(times.every) : scheduleWord('daysEvery', { days: days.text, every: times.every });
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
  if (raw == null || raw === '') return { kind: 'never', label: scheduleWord('runNever'), reason: '' };
  const text = String(raw);
  if (text === 'completed') return { kind: 'ok', label: scheduleWord('runCompleted'), reason: '' };
  if (text === 'launched' || text === 'running' || text === 'started') return { kind: 'started', label: scheduleWord('runStarted'), reason: '' };
  if (text === 'template_missing') return { kind: 'failed', label: scheduleWord('runAutomationMissing'), reason: scheduleWord('runAutomationMissingReason') };
  // What follows the colon is the server's own message: it shows as it came.
  const colon = text.indexOf(':');
  const head = (colon >= 0 ? text.slice(0, colon) : text).trim();
  const reason = colon >= 0 ? text.slice(colon + 1).trim() : '';
  if (head === 'error') return { kind: 'failed', label: scheduleWord('runFailed'), reason: reason || scheduleWord('runFailedReason') };
  if (head === 'stopped') return { kind: 'stopped', label: scheduleWord('runStopped'), reason: reason === 'user' ? scheduleWord('runStoppedByYou') : reason };
  if (head === 'interrupted') return { kind: 'interrupted', label: scheduleWord('runInterrupted'), reason };
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
  if (!Number.isFinite(next)) return { text: scheduleWord('notScheduled'), state: 'none' };
  const diff = next - now;
  if (diff <= 0) return diff > -OVERDUE_AFTER ? { text: scheduleWord('dueNow'), state: 'due' } : { text: scheduleWord('overdue'), state: 'overdue' };
  if (diff < MINUTE) return { text: scheduleWord('inSeconds', { n: Math.ceil(diff / 1000) }), state: 'soon' };
  if (diff < HOUR) return { text: scheduleWord('inMinutes', { n: Math.floor(diff / MINUTE) }), state: diff < 15 * MINUTE ? 'soon' : 'future' };
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR), m = Math.floor((diff % HOUR) / MINUTE);
    return { text: m ? scheduleWord('inHoursMinutes', { h, m }) : scheduleWord('inHours', { h }), state: 'future' };
  }
  const d = Math.floor(diff / DAY), h = Math.floor((diff % DAY) / HOUR);
  return { text: h ? scheduleWord('inDaysHours', { d, h }) : scheduleWord('inDays', { d }), state: 'future' };
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 d ago". */
export function formatAgo(iso, now = Date.now()) {
  const then = parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, now - then);
  if (diff < MINUTE) return scheduleWord('justNow');
  if (diff < HOUR) return scheduleWord('minutesAgo', { n: Math.floor(diff / MINUTE) });
  if (diff < DAY) return scheduleWord('hoursAgo', { n: Math.floor(diff / HOUR) });
  const days = Math.floor(diff / DAY);
  return days === 1 ? scheduleWord('yesterdayAgo') : scheduleWord('daysAgo', { n: days });
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today", "Tomorrow", "Yesterday" or the weekday and date, for a heading or a time. */
export function dayLabel(iso, now = Date.now(), locale = scheduleDateLocale()) {
  const then = new Date(parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  const today = new Date(now);
  if (sameDay(then, today)) return scheduleWord('today');
  if (sameDay(then, new Date(now + DAY))) return scheduleWord('tomorrow');
  if (sameDay(then, new Date(now - DAY))) return scheduleWord('yesterday');
  return then.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** 24-hour clock, as the cron descriptions are: "14:55". */
export function clockTime(iso, locale = scheduleDateLocale()) {
  const then = new Date(parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  return then.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** "Today 14:55", "Tomorrow 09:00", "Wed 22 Oct 09:00". */
export function whenLabel(iso, now = Date.now(), locale = scheduleDateLocale()) {
  const day = dayLabel(iso, now, locale);
  const clock = clockTime(iso, locale);
  return day && clock ? scheduleWord('dayAt', { day, time: clock }) : '';
}

/** A run time in the fewest words: "14:55" today, "Tomorrow 09:00", "Wed 09:00" this week, then "22 Oct". */
export function shortWhen(iso, now = Date.now(), locale = scheduleDateLocale()) {
  const at = parse(iso);
  if (!Number.isFinite(at)) return '';
  const then = new Date(at);
  const clock = clockTime(iso, locale);
  if (sameDay(then, new Date(now))) return clock;
  if (sameDay(then, new Date(now + DAY))) return scheduleWord('tomorrowAt', { time: clock });
  if (at > now && at - now < 6 * DAY) return scheduleWord('weekdayAt', { day: then.toLocaleDateString(locale, { weekday: 'short' }), time: clock });
  return then.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** A date and time in full, for a tooltip: "22/10/2026, 14:55:03" in English, the locale's own way otherwise. */
export function fullDateTime(iso, locale = scheduleDateLocale()) {
  const then = new Date(parse(iso));
  return Number.isNaN(then.getTime()) ? '' : then.toLocaleString(locale);
}

const capitalized = (value) => String(value).charAt(0).toUpperCase() + String(value).slice(1);

/** A context choice in words: "1M tokens", "Extended"; one this file does not know reads as its id. */
export function contextWord(value) {
  if (value === '1m') return scheduleWord('context1m');
  if (value === 'extended') return scheduleWord('contextExtended');
  return capitalized(value);
}

/** A thinking level in words: "Low", "High"; one this file does not know reads as its id. */
export function effortWord(value) {
  return Object.prototype.hasOwnProperty.call(SCHEDULES_VIEW_COPY.effort, value) ? scheduleWord(`effort.${value}`) : capitalized(value);
}

/**
 * The launch settings a run will use and where each comes from: the schedule's own value wins,
 * then its group's, then the automation's. `labels` names CLIs (`profiles`) and tool groups.
 */
export function launchFacts(schedule, { group = null, template = null, profiles = [], toolCatalog = null, translate } = {}) {
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
  facts.push({ key: 'profile', label: scheduleWord('factCli'), value: profiles.find(p => p.id === profileId)?.label || profileId, source: profile.value ? profile.source : 'default' });
  const model = pick('model');
  facts.push({ key: 'model', label: scheduleWord('factModel'), value: model.value || scheduleWord('valueDefault'), source: model.source, mono: !!model.value });
  const context = pick('contextMode');
  if (context.value && context.value !== 'default') facts.push({ key: 'contextMode', label: scheduleWord('factContext'), value: contextWord(context.value), source: context.source });
  const effort = pick('effort');
  if (effort.value && effort.value !== 'off') facts.push({ key: 'effort', label: scheduleWord('factThinking'), value: effortWord(effort.value), source: effort.source });
  const mcp = pick('tools');
  if (mcp.value) {
    const value = toolCatalog ? toolListView(toolCatalog, mcp.value, { translate }).summary : mcp.value.filter(id => !id.startsWith('mcp:')).join(', ') || scheduleWord('valueDefault');
    facts.push({ key: 'tools', label: scheduleWord('factMcp'), value, source: mcp.source });
  }
  if (profileId === 'codex') {
    const account = pick('codexAccountId');
    if (account.value) facts.push({ key: 'codexAccountId', label: scheduleWord('factAccount'), value: account.value, source: account.source });
  }
  const browser = pick('usesBrowser');
  facts.push({ key: 'usesBrowser', label: scheduleWord('factBrowser'), value: scheduleWord(browser.value === true ? 'valueOn' : 'valueOff'), source: browser.source });
  return facts;
}
