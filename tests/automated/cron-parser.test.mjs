#!/usr/bin/env node

/**
 * Cron Parser Unit Tests
 *
 * Tests parseCronField, cronMatchesDate, getNextCronRun, describeCron,
 * and getNowInTimezone — extracted from neural-interface/server.js.
 *
 * Run: node tests/automated/cron-parser.test.mjs
 */

import { assert, section, printSummary, B, X } from './test-utils.mjs';

// ─── Extracted cron functions (copied from server.js to test in isolation) ────

function parseCronField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (trimmed.includes('/')) {
      const [range, step] = trimmed.split('/');
      const stepNum = parseInt(step, 10);
      let start = min, end = max;
      if (range !== '*') {
        if (range.includes('-')) {
          const parts = range.split('-').map(Number);
          start = parts[0]; end = parts[1];
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += stepNum) values.add(i);
    } else if (trimmed.includes('-')) {
      const parts = trimmed.split('-').map(Number);
      for (let i = parts[0]; i <= parts[1]; i++) values.add(i);
    } else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n)) values.add(n);
    }
  }
  return values;
}

function cronMatchesDate(cronStr, date) {
  const fields = cronStr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return parseCronField(minute, 0, 59).has(date.getMinutes()) &&
    parseCronField(hour, 0, 23).has(date.getHours()) &&
    parseCronField(dayOfMonth, 1, 31).has(date.getDate()) &&
    parseCronField(month, 1, 12).has(date.getMonth() + 1) &&
    parseCronField(dayOfWeek, 0, 6).has(date.getDay());
}

function getNowInTimezone(tz) {
  try {
    const str = new Date().toLocaleString('en-US', { timeZone: tz });
    return new Date(str);
  } catch {
    return new Date();
  }
}

function getNextCronRun(cronStr, tz) {
  const now = getNowInTimezone(tz);
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const maxIterations = 7 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatchesDate(cronStr, candidate)) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

function describeCron(cronStr) {
  const fields = cronStr.trim().split(/\s+/);
  if (fields.length !== 5) return cronStr;
  const [minute, hour, , , dayOfWeek] = fields;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let dayPart = '';
  if (dayOfWeek === '*') dayPart = 'Every day';
  else if (dayOfWeek === '1-5') dayPart = 'Weekdays';
  else if (dayOfWeek === '0,6') dayPart = 'Weekends';
  else {
    const days = [...parseCronField(dayOfWeek, 0, 6)].sort().map(d => dayNames[d]);
    dayPart = days.join(', ');
  }
  const timePart = hour === '*' ? `every hour at :${minute.padStart(2, '0')}` :
    [...parseCronField(hour, 0, 23)].sort((a, b) => a - b)
      .map(h => `${String(h).padStart(2, '0')}:${minute.padStart(2, '0')}`).join(', ');
  return `${dayPart} at ${timePart}`;
}

// ─── Tests ───────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${B}SynaBun Cron Parser Tests${X}\n`);

  // ═══════════════════════════════════════════════════════════════════
  section('parseCronField');
  // ═══════════════════════════════════════════════════════════════════

  // Test 1: Wildcard
  const wildcard = parseCronField('*', 0, 59);
  assert(wildcard.size === 60, `wildcard '*' matches all 60 values (0-59) — got ${wildcard.size}`);

  // Test 2: Single value
  const single = parseCronField('5', 0, 59);
  assert(single.size === 1 && single.has(5), `single '5' matches only [5]`);

  // Test 3: Range
  const range = parseCronField('1-5', 0, 59);
  assert(range.size === 5, `range '1-5' has 5 values — got ${range.size}`);
  assert(range.has(1) && range.has(3) && range.has(5), `range '1-5' contains 1, 3, 5`);
  assert(!range.has(0) && !range.has(6), `range '1-5' does not contain 0 or 6`);

  // Test 4: List
  const list = parseCronField('1,3,5', 0, 59);
  assert(list.size === 3, `list '1,3,5' has 3 values — got ${list.size}`);
  assert(list.has(1) && list.has(3) && list.has(5), `list '1,3,5' contains 1, 3, 5`);
  assert(!list.has(2) && !list.has(4), `list '1,3,5' does not contain 2 or 4`);

  // Test 5: Step (minutes)
  const step15 = parseCronField('*/15', 0, 59);
  assert(step15.size === 4, `step '*/15' over 0-59 has 4 values — got ${step15.size}`);
  assert(step15.has(0) && step15.has(15) && step15.has(30) && step15.has(45), `step '*/15' = [0,15,30,45]`);

  // Test 6: Step (hours)
  const step2h = parseCronField('*/2', 0, 23);
  assert(step2h.size === 12, `step '*/2' over 0-23 has 12 values — got ${step2h.size}`);
  assert(step2h.has(0) && step2h.has(2) && step2h.has(22), `step '*/2' contains 0, 2, 22`);
  assert(!step2h.has(1) && !step2h.has(23), `step '*/2' does not contain 1 or 23`);

  // Test 7: Range with step
  const rangeStep = parseCronField('1-10/3', 0, 59);
  assert(rangeStep.has(1) && rangeStep.has(4) && rangeStep.has(7) && rangeStep.has(10), `range-step '1-10/3' = [1,4,7,10]`);
  assert(!rangeStep.has(0) && !rangeStep.has(2), `range-step '1-10/3' excludes 0 and 2`);

  // Test 8: Wildcard for day-of-week
  const dowWild = parseCronField('*', 0, 6);
  assert(dowWild.size === 7, `wildcard '*' for DOW matches all 7 days — got ${dowWild.size}`);

  // ═══════════════════════════════════════════════════════════════════
  section('cronMatchesDate');
  // ═══════════════════════════════════════════════════════════════════

  // Test 9: Every minute matches any date
  const now = new Date();
  assert(cronMatchesDate('* * * * *', now), `'* * * * *' matches current date/time`);

  // Test 10: Specific time — 9:30am
  const date930 = new Date(2026, 2, 27, 9, 30, 0); // March 27, 2026, 09:30 (Friday)
  assert(cronMatchesDate('30 9 * * *', date930), `'30 9 * * *' matches 9:30am`);

  // Test 11: Specific time — does NOT match 10:00am
  const date1000 = new Date(2026, 2, 27, 10, 0, 0);
  assert(!cronMatchesDate('30 9 * * *', date1000), `'30 9 * * *' does NOT match 10:00am`);

  // Test 12: Every 2 hours at :00 matches 4:00am
  const date400 = new Date(2026, 2, 27, 4, 0, 0);
  assert(cronMatchesDate('0 */2 * * *', date400), `'0 */2 * * *' matches 4:00am`);

  // Test 13: Every 2 hours does NOT match 3:00am
  const date300 = new Date(2026, 2, 27, 3, 0, 0);
  assert(!cronMatchesDate('0 */2 * * *', date300), `'0 */2 * * *' does NOT match 3:00am`);

  // Test 14: Weekdays 9am — Friday (day=5) should match
  const friday9 = new Date(2026, 2, 27, 9, 0, 0); // March 27, 2026 is Friday
  assert(cronMatchesDate('0 9 * * 1-5', friday9), `'0 9 * * 1-5' matches Friday 9am`);

  // Test 15: Weekdays 9am — Saturday (day=6) should NOT match
  const saturday9 = new Date(2026, 2, 28, 9, 0, 0); // March 28, 2026 is Saturday
  assert(!cronMatchesDate('0 9 * * 1-5', saturday9), `'0 9 * * 1-5' does NOT match Saturday 9am`);

  // Test 16: Weekends — Saturday at correct time matches
  const satAt10 = new Date(2026, 2, 28, 10, 0, 0);
  assert(cronMatchesDate('0 10 * * 0,6', satAt10), `'0 10 * * 0,6' matches Saturday 10am`);
  assert(cronMatchesDate('0 9 * * 0,6', saturday9), `'0 9 * * 0,6' matches Saturday 9am`);

  // Test 17: Invalid cron (wrong field count) returns false
  assert(!cronMatchesDate('* * *', now), `invalid cron '* * *' (3 fields) returns false`);
  assert(!cronMatchesDate('', now), `empty cron returns false`);

  // ═══════════════════════════════════════════════════════════════════
  section('getNextCronRun');
  // ═══════════════════════════════════════════════════════════════════

  // Test 18: Next daily 9am — returns a valid ISO date string
  const next9am = getNextCronRun('0 9 * * *', 'UTC');
  assert(next9am !== null, `getNextCronRun('0 9 * * *') returns non-null`);
  assert(typeof next9am === 'string' && next9am.includes('T'), `getNextCronRun returns ISO string — got "${next9am?.slice(0, 20)}..."`);
  if (next9am) {
    const nextDate = new Date(next9am);
    assert(nextDate.getMinutes() === 0, `next 9am has minutes=0`);
    assert(nextDate.getHours() === 9, `next 9am has hours=9 — got ${nextDate.getHours()}`);
  }

  // Test 19: Every 15 minutes — next fire has minutes divisible by 15
  const next15 = getNextCronRun('*/15 * * * *', 'UTC');
  assert(next15 !== null, `getNextCronRun('*/15 * * * *') returns non-null`);
  if (next15) {
    const nextDate15 = new Date(next15);
    assert(nextDate15.getMinutes() % 15 === 0, `next */15 fire has minutes divisible by 15 — got :${nextDate15.getMinutes()}`);
  }

  // Test 20: Returns null for impossible cron (should not happen with valid expressions, but test boundary)
  // Actually all valid 5-field crons will fire within 7 days, so just verify non-null for a weekly cron
  const nextWeekly = getNextCronRun('0 9 * * 1', 'UTC'); // Mondays 9am
  assert(nextWeekly !== null, `getNextCronRun weekly Monday 9am returns non-null`);

  // ═══════════════════════════════════════════════════════════════════
  section('describeCron');
  // ═══════════════════════════════════════════════════════════════════

  // Test 21: Every 15 minutes
  const desc15 = describeCron('*/15 * * * *');
  assert(desc15.toLowerCase().includes('every'), `describeCron('*/15 * * * *') contains "every" — got "${desc15}"`);

  // Test 22: Weekdays at 9am
  const descWeekdays = describeCron('0 9 * * 1-5');
  assert(descWeekdays.includes('Weekdays'), `describeCron('0 9 * * 1-5') contains "Weekdays" — got "${descWeekdays}"`);
  assert(descWeekdays.includes('09:00'), `describeCron('0 9 * * 1-5') contains "09:00" — got "${descWeekdays}"`);

  // Test 23: Weekends
  const descWeekends = describeCron('0 10 * * 0,6');
  assert(descWeekends.includes('Weekends'), `describeCron('0 10 * * 0,6') contains "Weekends" — got "${descWeekends}"`);

  // Test 24: Multiple times
  const descMulti = describeCron('0 9,17 * * *');
  assert(descMulti.includes('09:00') && descMulti.includes('17:00'), `describeCron('0 9,17 * * *') includes both times — got "${descMulti}"`);

  // Test 25: Invalid cron returns the raw string
  const descInvalid = describeCron('bad');
  assert(descInvalid === 'bad', `describeCron('bad') returns raw string — got "${descInvalid}"`);

  // ═══════════════════════════════════════════════════════════════════
  section('getNowInTimezone');
  // ═══════════════════════════════════════════════════════════════════

  // Test 26: Returns a Date object
  const utcNow = getNowInTimezone('UTC');
  assert(utcNow instanceof Date, `getNowInTimezone('UTC') returns a Date`);
  assert(!isNaN(utcNow.getTime()), `getNowInTimezone('UTC') returns a valid Date`);

  // Test 27: Invalid timezone falls back gracefully
  const badTz = getNowInTimezone('Not/A/Timezone');
  assert(badTz instanceof Date, `getNowInTimezone with invalid tz returns a Date (fallback)`);
  assert(!isNaN(badTz.getTime()), `fallback Date is valid`);

  // Test 28: Different timezones produce different times (or same if close enough)
  const tokyoNow = getNowInTimezone('Asia/Tokyo');
  const laTime = getNowInTimezone('America/Los_Angeles');
  // Tokyo is always ahead of LA — at least 15 hours difference
  // We just check both are valid Dates
  assert(tokyoNow instanceof Date && laTime instanceof Date, `different timezones both return valid Dates`);

  // ═══════════════════════════════════════════════════════════════════

  const failures = printSummary('Cron Parser Tests');
  process.exit(failures ? 1 : 0);
}

export { main };
main().catch(e => { console.error(e); process.exit(1); });
