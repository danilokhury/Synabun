/**
 * SynaBun — what Windows recorded about a server that crashed
 *
 * A native crash ends the server with an NTSTATUS and no words of its own:
 * 0xC0000409 is abort() (an uncaught C++ exception, a failed native
 * assertion), a failed /GS or Control Flow Guard check, or another fail-fast.
 * Windows Error Reporting records which: an "Application Error" event (ID
 * 1000: the faulting module, its version, the offset, the process id) and,
 * a moment later, a "Windows Error Reporting" event (ID 1001) whose BEX
 * bucket carries the fail-fast code (7 is abort(), 2 a /GS stack cookie,
 * 10 a Control Flow Guard check, 5 an invalid argument) and the folder of
 * the report. After such a crash the supervisor reads both from the
 * Application log once (`wevtutil`, an argument array, never a shell,
 * bounded) and writes them to its log, which the user can send.
 *
 * Windows only, best effort: no event (Windows Error Reporting turned off,
 * the log not readable) is no line. Parsing is pure and tested with recorded
 * events; nothing here ever throws.
 */

import { execFile as nodeExecFile } from 'node:child_process';

export const APPLICATION_ERROR_QUERY = "*[System[Provider[@Name='Application Error'] and (EventID=1000)]]";
export const WER_REPORT_QUERY = "*[System[Provider[@Name='Windows Error Reporting'] and (EventID=1001)]]";

/**
 * The fail-fast codes a BEX / BEX64 bucket names (winnt.h FAST_FAIL_*), in
 * words. Only the ones a crash of node.exe or a DLL in it is expected to show;
 * any other is logged by number.
 */
export const FAST_FAIL_CODES = Object.freeze({
  0: 'a legacy /GS violation',
  1: 'a vtable guard check',
  2: 'a /GS stack cookie check (a stack buffer overrun)',
  3: 'a corrupt list entry (corrupted native memory)',
  4: 'an incorrect stack',
  5: 'an invalid argument (the C runtime\'s invalid parameter check)',
  6: 'a /GS cookie initialization check',
  7: 'abort(): an uncaught C++ exception, a failed native assertion or a fatal error',
  8: 'a range check',
  9: 'an unsafe registry access',
  10: 'a Control Flow Guard check (an indirect call to a bad address)',
  11: 'a Control Flow Guard write check',
  12: 'an invalid fiber switch',
  13: 'an invalid thread context',
  14: 'an invalid reference count',
});

/** wevtutil's arguments: the newest `count` events of `query` in the Application log, as XML. */
export function wevtutilArgs(query = APPLICATION_ERROR_QUERY, { count = 20 } = {}) {
  return ['qe', 'Application', `/q:${query}`, `/c:${Math.max(1, Math.min(100, Math.floor(Number(count) || 20)))}`, '/rd:true', '/f:xml'];
}

/** wevtutil by its full path: a launch with a short PATH still finds it, and nothing else of that name is run. */
export function wevtutilPath(env = process.env) {
  const root = String(env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || 'C:\\Windows').replace(/[\\/]+$/, '');
  return `${root}\\System32\\wevtutil.exe`;
}

/** What wevtutil printed, as text: UTF-8, or UTF-16 (with or without its byte order mark) as some Windows tools write to a pipe. */
export function decodeOutput(output) {
  if (typeof output === 'string') return output;
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output || []);
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return buffer.subarray(3).toString('utf8');
  let zeros = 0;
  for (let i = 1; i < Math.min(buffer.length, 4096); i += 2) if (buffer[i] === 0) zeros++;
  return zeros > Math.min(buffer.length, 4096) / 4 ? buffer.toString('utf16le') : buffer.toString('utf8');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
function decodeXml(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name) => {
    if (name[0] === '#') {
      const value = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10FFFF ? String.fromCodePoint(value) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Every `<Event>` of wevtutil's XML output: { provider, id, time (ms), data: [{ name, value }] }. */
export function parseEvents(xml) {
  const events = [];
  for (const match of String(xml || '').matchAll(/<Event\b[\s\S]*?<\/Event>/g)) {
    const block = match[0];
    const provider = /<Provider\b[^>]*\bName=(['"])(.*?)\1/.exec(block)?.[2] || '';
    const id = Number(/<EventID\b[^>]*>(\d+)<\/EventID>/.exec(block)?.[1]);
    const stamp = /<TimeCreated\b[^>]*\bSystemTime=(['"])(.*?)\1/.exec(block)?.[2] || '';
    const time = Date.parse(stamp);
    const eventData = /<EventData\b[^>]*>([\s\S]*?)<\/EventData>/.exec(block)?.[1] || '';
    const data = [];
    for (const item of eventData.matchAll(/<Data\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Data>)/g)) {
      const name = /\bName=(['"])(.*?)\1/.exec(item[1] || '')?.[2] || null;
      data.push({ name, value: decodeXml(item[2] ?? '').trim() });
    }
    events.push({ provider: decodeXml(provider), id: Number.isFinite(id) ? id : null, time: Number.isFinite(time) ? time : null, data });
  }
  return events;
}

// The fields of an Application Error event, by name (Windows 10 and later) or by position (older Windows).
const APPLICATION_ERROR_FIELDS = ['AppName', 'AppVersion', 'AppTimeStamp', 'ModuleName', 'ModuleVersion', 'ModuleTimeStamp', 'ExceptionCode', 'FaultingOffset', 'ProcessId', 'ProcessCreationTime', 'AppPath', 'ModulePath', 'IntegratorReportId', 'PackageFullName', 'PackageRelativeAppId'];

const hexValue = (text) => {
  const clean = String(text || '').trim().replace(/^0x/i, '');
  return /^[0-9a-f]+$/i.test(clean) ? Number.parseInt(clean, 16) : null;
};
const sameHex = (a, b) => {
  const x = String(a || '').trim().replace(/^0x/i, '').replace(/^0+(?=.)/, '').toLowerCase();
  const y = String(b || '').trim().replace(/^0x/i, '').replace(/^0+(?=.)/, '').toLowerCase();
  return !!x && x === y;
};

/** An Application Error event (ID 1000) as fields, or null when `event` is not one. */
export function applicationErrorOf(event) {
  if (!event || event.provider !== 'Application Error' || event.id !== 1000) return null;
  const named = event.data.some(item => item.name);
  const field = (key) => {
    if (named) return event.data.find(item => item.name === key)?.value ?? '';
    return event.data[APPLICATION_ERROR_FIELDS.indexOf(key)]?.value ?? '';
  };
  return {
    time: event.time,
    app: field('AppName'),
    appVersion: field('AppVersion'),
    module: field('ModuleName'),
    moduleVersion: field('ModuleVersion'),
    exceptionCode: field('ExceptionCode').replace(/^0x/i, '').toLowerCase(),
    offset: field('FaultingOffset'),
    pid: hexValue(field('ProcessId')),
    appPath: field('AppPath'),
    modulePath: field('ModulePath'),
    reportId: field('IntegratorReportId'),
  };
}

/**
 * The crash of process `pid` (started at `since`, in ms) among `events`: the
 * newest Application Error event for that process id, no older than `since`
 * less a minute. Null when there is none.
 */
export function findApplicationError(events, { pid, since = 0 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const floor = Number(since) - 60_000;
  const found = (events || []).map(applicationErrorOf)
    .filter(item => item && item.pid === pid && (!Number.isFinite(item.time) || item.time >= floor))
    .sort((a, b) => (b.time || 0) - (a.time || 0));
  return found[0] || null;
}

/**
 * The Windows Error Reporting event (ID 1001) of that crash, when its bucket
 * is there: its kind, the fail-fast code of a BEX bucket and the report's
 * folder. Its parameters carry no field names, so it is matched by the
 * module, the offset and the exception code in the order its bucket gives
 * them: a BEX / BEX64 bucket (a fail-fast, 0xC0000409) has the module (P4),
 * the offset (P7), the exception code (P8) and the fail-fast code (P9); an
 * APPCRASH bucket the module (P4), the exception code (P7) and the offset (P8).
 */
export function findWerReport(events, crash) {
  if (!crash?.module || !crash.exceptionCode) return null;
  const sameModule = (value) => String(value || '').toLowerCase() === crash.module.toLowerCase();
  for (const event of events || []) {
    if (!event || event.provider !== 'Windows Error Reporting' || event.id !== 1001) continue;
    if (Number.isFinite(event.time) && Number.isFinite(crash.time) && event.time < crash.time - 60_000) continue;
    const values = event.data.map(item => item.value);
    const bucket = values.find(value => /^(?:BEX(?:64)?|APPCRASH|MoAppCrash)$/i.test(value)) || '';
    const folder = values.find(value => /\\WER\\Report(?:Archive|Queue)\\/i.test(value)) || '';
    for (let i = 3; i < values.length; i++) {
      if (!sameHex(values[i], crash.exceptionCode)) continue;
      // BEX: module, version, time stamp, offset, exception code, fail-fast code.
      if (i >= 4 && sameHex(values[i - 1], crash.offset) && sameModule(values[i - 4])) {
        const fastFail = /^BEX/i.test(bucket) ? hexValue(values[i + 1]) : null;
        return { bucket, fastFail: Number.isInteger(fastFail) ? fastFail : null, folder };
      }
      // APPCRASH: module, version, time stamp, exception code, offset.
      if (sameHex(values[i + 1], crash.offset) && sameModule(values[i - 3])) return { bucket, fastFail: null, folder };
    }
  }
  return null;
}

/** The crash in one line for the supervisor's log. */
export function describeWindowsCrash(crash, report = null) {
  if (!crash) return '';
  const module = [crash.module || 'an unknown module', crash.moduleVersion].filter(Boolean).join(' ');
  const parts = [`Windows recorded the crash of ${crash.app || 'the server'} (pid ${crash.pid}) in ${module}`];
  if (crash.offset) parts.push(`at offset ${crash.offset.startsWith('0x') ? crash.offset : `0x${crash.offset}`}`);
  if (crash.exceptionCode) parts.push(`exception 0x${crash.exceptionCode}`);
  let line = parts.join(', ');
  if (report && Number.isInteger(report.fastFail)) {
    line += `; fail-fast code ${report.fastFail}${FAST_FAIL_CODES[report.fastFail] ? ` (${FAST_FAIL_CODES[report.fastFail]})` : ''}`;
  }
  if (crash.modulePath) line += `. Module: ${crash.modulePath}`;
  if (report?.folder) line += `. Report: ${report.folder}`;
  return `${line}.`;
}

/** The pauses before each look (the Application Error event is written while Windows handles the crash, the bucket event a little later). */
export const LOOKUP_WAITS_MS = Object.freeze([1500, 6000, 15000]);
/** One wevtutil query, at most. */
export const LOOKUP_QUERY_TIMEOUT_MS = 8000;
/** The whole lookup, waits and queries together, at most: a supervisor that waits for it (30 s) never cuts it off. */
export const LOOKUP_BUDGET_MS = 28_000;
/** A query is not started with less time than this left. */
const MIN_QUERY_MS = 1000;

function runWevtutil(execFile, file, query, { count, timeoutMs }) {
  return new Promise((done) => {
    try {
      execFile(file, wevtutilArgs(query, { count }), { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
        done(error ? '' : decodeOutput(stdout));
      });
    } catch {
      done('');
    }
  });
}

/**
 * Look the crash of process `pid` up in the Application log. Resolves
 * { crash, report } (report null when its bucket has not been written yet) or
 * null. Never rejects. `waits` are the pauses before each attempt: the
 * Application Error event is written while Windows handles the crash, the
 * bucket event once the report is filed, a little later. `onFound` hears each
 * step as it is found ({ crash, report: null }, then { crash, report }), so a
 * caller that cannot wait for the last attempt still has what came first.
 * Waits and queries together end within `budgetMs`: a query gets what is left
 * of it (`timeoutMs` at most), a wait is cut to leave a query room, and nothing
 * is started with less than a second left.
 */
export async function lookupWindowsCrash({
  pid, since = 0, platform = process.platform, execFile = nodeExecFile, env = process.env, onFound = null,
  waits = LOOKUP_WAITS_MS, timeoutMs = LOOKUP_QUERY_TIMEOUT_MS, budgetMs = LOOKUP_BUDGET_MS, now = () => Date.now(),
  sleep = (ms) => new Promise(done => { const t = setTimeout(done, ms); t.unref?.(); }),
} = {}) {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  const file = wevtutilPath(env);
  const tell = (found) => { try { onFound?.(found); } catch {} };
  const deadline = now() + Math.max(0, Number(budgetMs) || 0);
  const left = () => deadline - now();
  // A query, given what is left of the budget; '' (nothing found) when too little is left to start one.
  const query = (which) => {
    const ms = Math.min(timeoutMs, left());
    return ms < MIN_QUERY_MS ? Promise.resolve('') : runWevtutil(execFile, file, which, { count: 30, timeoutMs: ms });
  };
  let crash = null;
  let report = null;
  try {
    for (const wait of waits) {
      const pause = Math.min(wait, left() - MIN_QUERY_MS);
      if (pause < 0) break;
      await sleep(pause);
      if (!crash) {
        crash = findApplicationError(parseEvents(await query(APPLICATION_ERROR_QUERY)), { pid, since });
        if (crash) tell({ crash, report: null });
      }
      if (crash && !report) {
        report = findWerReport(parseEvents(await query(WER_REPORT_QUERY)), crash);
        if (report) tell({ crash, report });
      }
      if (crash && report) break;
    }
  } catch {
    // Best effort: what was found so far.
  }
  return crash ? { crash, report } : null;
}
