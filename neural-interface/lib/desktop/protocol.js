// Desktop helper protocol — shared by the manager (manager.js), the fake helper
// (fake-helper.js) and the desktop service. The native side is
// helper/SynabunDesktop.swift; keep both in step and bump PROTOCOL_VERSION on
// any incompatible change (the manager refuses a helper speaking another one).
//
// JSON lines over the helper's stdio (UTF-8, one object per line):
//   request  {"id":17,"cmd":"click","args":{...}}
//   reply    {"id":17,"ok":true,"result":{...}}
//            {"id":17,"ok":false,"error":{"code":"SECURE_FIELD","message":"...","details":{...}}}
//   event    {"event":"ready"|"user_input"|..., ...}                    (no id)
//
// Actions run strictly serially in arrival order; BYPASS_COMMANDS are answered
// immediately, even while an action is in flight.
//
// Coordinates: every point the helper receives or returns is a Quartz GLOBAL
// DISPLAY POINT — origin at the top-left of the main display, y grows down,
// secondary displays may have negative origins. Screenshot pixels only exist in
// the images it returns (see fitImageSize).
//
// Scroll: dy > 0 scrolls DOWN (toward the end of the document), dx > 0 scrolls
// RIGHT. The helper flips both signs for Quartz (wheel1 +up, wheel2 +left).
//
// Protocol 2 (ready.features axVerify, guardPrefixes, axEnrich) — an older
// helper would silently ignore `verify` and `bundlePrefixes`, so the manager
// refuses it:
//   guard rules   blockedApps[].bundlePrefixes, protectedWindows[].bundlePrefixes
//                 and protectedWindows[].appNameRe (see matchGuard); titles and
//                 app names are NFC-normalized before matching.
//   ax_snapshot   every node also carries help, placeholder (text roles),
//                 identifier (≤ 120), group ("<container role> <label>", ≤ 60,
//                 never a window title), modal (at or below a sheet, popover,
//                 dialog or AXModal window) and web (at or below an AXWebArea).
//                 args.enrich:true adds per node titleElement (≤ 80) and
//                 contentLabel (unnamed rows/cells: first static text two levels
//                 down, ≤ 80), and on the result window {id, title, subrole,
//                 modal}, app.lang (primary subtag, e.g. "pt") and texts (up to
//                 args.maxTexts static texts, default 80, ≤ 200 chars each).
//   ax_action     action "press" may carry verify {pid, role, subrole, title,
//                 description, help, identifier} from the snapshot; the helper
//                 re-reads the element after its guard check, immediately before
//                 AXPerformAction, and fails TARGET_CHANGED (details.field) unless
//                 compareVerify still passes. verify with any other action is
//                 BAD_ARGS.

export const PROTOCOL_VERSION = 2;

/** `ready.features` flags a protocol-2 helper announces. */
export const READY_FEATURES = Object.freeze({ AX_VERIFY: 'axVerify', GUARD_PREFIXES: 'guardPrefixes', AX_ENRICH: 'axEnrich' });

export const COMMANDS = Object.freeze({
  PERMISSIONS: 'permissions',
  REQUEST_PERMISSION: 'request_permission',
  DISPLAYS: 'displays',
  SESSION_STATE: 'session_state',
  CONFIGURE: 'configure',
  SCREENSHOT: 'screenshot',
  CAPTURE_RECT: 'capture_rect',
  CURSOR: 'cursor',
  MOVE: 'move',
  CLICK: 'click',
  MOUSE_DOWN: 'mouse_down',
  MOUSE_UP: 'mouse_up',
  DRAG: 'drag',
  SCROLL: 'scroll',
  TYPE: 'type',
  KEY: 'key',
  HOLD_KEY: 'hold_key',
  PROBE_POINT: 'probe_point',
  PROBE_FOCUS: 'probe_focus',
  APPS: 'apps',
  WINDOWS: 'windows',
  OPEN_APP: 'open_app',
  FOCUS_APP: 'focus_app',
  AX_SNAPSHOT: 'ax_snapshot',
  AX_ACTION: 'ax_action',
  ABORT: 'abort',
  PANIC: 'panic',
  POWER: 'power',
  SHUTDOWN: 'shutdown',
});

export const COMMAND_NAMES = Object.freeze(Object.values(COMMANDS));

// Answered immediately by the helper's stdin thread, never queued behind an action.
export const BYPASS_COMMANDS = Object.freeze(['abort', 'panic', 'permissions', 'session_state', 'cursor', 'shutdown']);

export const EVENTS = Object.freeze({
  READY: 'ready',                             // {protocol, version, sourceHash, pid, arch, os, features} — see READY_FEATURES
  USER_INPUT: 'user_input',                   // {kind:'mouse'|'key'|'scroll', x, y} — unstamped input only, ≤ 4/s
  EMERGENCY_STOP: 'emergency_stop',           // {reason:'esc'|'failsafe_corner'} — only while monitor.armed
  SCREEN_LOCK: 'screen_lock',                 // {locked}
  DISPLAYS_CHANGED: 'displays_changed',       // {displays:[...]}
  PERMISSIONS_CHANGED: 'permissions_changed', // {permissions:{...}}
  LOG: 'log',                                 // {level, message}
});

export const ERROR_CODES = Object.freeze({
  NOT_TRUSTED: 'NOT_TRUSTED',
  NO_SCREEN_RECORDING: 'NO_SCREEN_RECORDING',
  SCREEN_LOCKED: 'SCREEN_LOCKED',
  BLOCKED_APP: 'BLOCKED_APP',
  PROTECTED_WINDOW: 'PROTECTED_WINDOW',
  SECURE_FIELD: 'SECURE_FIELD',
  OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  INTERRUPTED: 'INTERRUPTED',
  ABORTED: 'ABORTED',
  AX_ERROR: 'AX_ERROR',
  AX_TIMEOUT: 'AX_TIMEOUT',
  REF_EXPIRED: 'REF_EXPIRED',
  APP_NOT_FOUND: 'APP_NOT_FOUND',
  UNSUPPORTED: 'UNSUPPORTED',
  TIMEOUT: 'TIMEOUT',
  BAD_ARGS: 'BAD_ARGS',
  INTERNAL: 'INTERNAL',
  HELPER_UNAVAILABLE: 'HELPER_UNAVAILABLE',
  TARGET_CHANGED: 'TARGET_CHANGED', // ax_action verify: details.field names the first check that failed
});

export const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;

/** An Error carrying the protocol's `code` (and `details` when given). */
export function helperError(code, message, details) {
  const err = new Error(message || code || 'desktop helper error');
  err.name = 'DesktopHelperError';
  err.code = code || ERROR_CODES.INTERNAL;
  if (details !== undefined) err.details = details;
  return err;
}

export function encodeMessage(obj) {
  return `${JSON.stringify(obj)}\n`;
}

/**
 * Splits a byte stream into JSON messages. Bytes are buffered until a newline,
 * so multi-byte characters split across chunks decode correctly. A line longer
 * than maxLineBytes is reported through onError and discarded up to its newline;
 * a line that isn't JSON is reported and skipped.
 */
export function createLineParser(onMessage, { maxLineBytes = DEFAULT_MAX_LINE_BYTES, onError = () => {} } = {}) {
  let parts = [];
  let size = 0;
  let skipping = false;

  function report(code, message) {
    const err = new Error(message);
    err.code = code;
    try { onError(err); } catch {}
  }

  function emitLine(buf) {
    let text = buf.toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (!text.trim()) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      report('BAD_LINE', `desktop helper sent a line that is not JSON: ${text.slice(0, 120)}`);
      return;
    }
    try {
      onMessage(msg);
    } catch (err) {
      try { onError(err); } catch {}
    }
  }

  function tooLong() {
    parts = [];
    size = 0;
    report('LINE_TOO_LONG', `desktop helper line exceeds ${maxLineBytes} bytes; discarded`);
  }

  function push(chunk) {
    if (chunk == null) return;
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let start = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(0x0a, start);
      if (nl === -1) {
        const rest = buf.subarray(start);
        if (!skipping) {
          if (size + rest.length > maxLineBytes) {
            skipping = true;
            tooLong();
          } else {
            parts.push(rest);
            size += rest.length;
          }
        }
        return;
      }
      const piece = buf.subarray(start, nl);
      start = nl + 1;
      if (skipping) {
        skipping = false;
        continue;
      }
      if (size + piece.length > maxLineBytes) {
        tooLong();
        continue;
      }
      const line = parts.length ? Buffer.concat([...parts, piece], size + piece.length) : piece;
      parts = [];
      size = 0;
      emitLine(line);
    }
  }

  /** Stream ended: a final line without a trailing newline still counts. */
  function end() {
    if (!skipping && size > 0) {
      const line = Buffer.concat(parts, size);
      parts = [];
      size = 0;
      emitLine(line);
    }
    skipping = false;
  }

  function reset() {
    parts = [];
    size = 0;
    skipping = false;
  }

  return { push, end, reset, get bufferedBytes() { return size; } };
}

/**
 * The helper's fit math: an area of w×h points on a display with backing scale
 * `scale`, fitted into fit.w × fit.h, is f = min(fit.w/w, fit.h/h, scale) and
 * the image is round(w·f) × round(h·f) — never larger than native pixels.
 * A missing fit dimension means "native". Screenshot pixel (px, py) maps back
 * to the point (bounds.x + px / f, bounds.y + py / f).
 */
export function fitImageSize(area, fit, scale = 1) {
  const w = Number(area?.w);
  const h = Number(area?.h);
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0, factor: 0 };
  const s = scale > 0 ? scale : 1;
  const fw = fit?.w > 0 ? fit.w : w * s;
  const fh = fit?.h > 0 ? fit.h : h * s;
  const factor = Math.max(1e-6, Math.min(fw / w, fh / h, s));
  return { w: Math.max(1, Math.round(w * factor)), h: Math.max(1, Math.round(h * factor)), factor };
}

/**
 * `configure` semantics: any subset may be sent; within guard / monitor / input
 * each field sent replaces the previous value and omitted fields are kept.
 * The manager uses this to replay the effective configuration after a respawn.
 */
export function mergeConfigure(prev, next) {
  const out = { ...(prev || {}) };
  for (const key of ['guard', 'monitor', 'input']) {
    const add = next?.[key];
    if (add && typeof add === 'object' && !Array.isArray(add)) out[key] = { ...(out[key] || {}), ...add };
  }
  return out;
}

/**
 * A bundle-id prefix: dotted reverse-DNS, at least two segments, trailing dot
 * ("com.apple.Safari.WebApp."), so it can never equal a bare bundle id. The
 * helper (BUNDLE_PREFIX_PATTERN) and config.js validate with the same rule.
 */
export const BUNDLE_PREFIX_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\.$/;

/** Patterns compile case-insensitively and in NFC, like the helper's ICU regexes. */
function compileGuardRe(pattern, field) {
  if (pattern == null || pattern === '') return null;
  if (typeof pattern !== 'string') throw helperError(ERROR_CODES.BAD_ARGS, `${field} must be a string`, { field });
  try {
    return new RegExp(pattern.normalize('NFC'), 'i');
  } catch {
    throw helperError(ERROR_CODES.BAD_ARGS, `${field} is not a valid regular expression`, { field, pattern });
  }
}

function validatePrefixes(list, field) {
  if (list == null) return;
  if (!Array.isArray(list)) throw helperError(ERROR_CODES.BAD_ARGS, `${field} must be an array`, { field });
  list.forEach((prefix, j) => {
    if (typeof prefix !== 'string' || !BUNDLE_PREFIX_RE.test(prefix)) {
      throw helperError(ERROR_CODES.BAD_ARGS, `${field}[${j}] must be a dotted bundle id prefix ending in "."`, { field: `${field}[${j}]` });
    }
  });
}

/** Case-insensitive bundle-id prefix test (prefixes are validated elsewhere). */
export function hasBundlePrefix(bundleId, prefixes) {
  if (typeof bundleId !== 'string' || !bundleId || !Array.isArray(prefixes)) return false;
  const b = bundleId.toLowerCase();
  return prefixes.some((prefix) => typeof prefix === 'string' && prefix && b.startsWith(prefix.toLowerCase()));
}

/** Throws BAD_ARGS for a GuardSpec the helper would refuse. */
export function validateGuardSpec(guard) {
  if (guard == null) return;
  if (typeof guard !== 'object' || Array.isArray(guard)) throw helperError(ERROR_CODES.BAD_ARGS, 'guard must be an object');
  if (guard.blockedApps != null) {
    if (!Array.isArray(guard.blockedApps)) throw helperError(ERROR_CODES.BAD_ARGS, 'guard.blockedApps must be an array');
    guard.blockedApps.forEach((r, i) => {
      if (!r || typeof r !== 'object') throw helperError(ERROR_CODES.BAD_ARGS, `guard.blockedApps[${i}] must be an object`);
      validatePrefixes(r.bundlePrefixes, `guard.blockedApps[${i}].bundlePrefixes`);
      compileGuardRe(r.nameRe, `guard.blockedApps[${i}].nameRe`);
      compileGuardRe(r.windowTitleRe, `guard.blockedApps[${i}].windowTitleRe`);
    });
  }
  if (guard.protectedWindows != null) {
    if (!Array.isArray(guard.protectedWindows)) throw helperError(ERROR_CODES.BAD_ARGS, 'guard.protectedWindows must be an array');
    guard.protectedWindows.forEach((r, i) => {
      if (!r || typeof r !== 'object') throw helperError(ERROR_CODES.BAD_ARGS, `guard.protectedWindows[${i}] must be an object`);
      const titleRe = compileGuardRe(r.titleRe, `guard.protectedWindows[${i}].titleRe`);
      const appNameRe = compileGuardRe(r.appNameRe, `guard.protectedWindows[${i}].appNameRe`);
      if (!titleRe && !appNameRe) {
        throw helperError(ERROR_CODES.BAD_ARGS, `guard.protectedWindows[${i}].titleRe (or appNameRe) is required`);
      }
      validatePrefixes(r.bundlePrefixes, `guard.protectedWindows[${i}].bundlePrefixes`);
    });
  }
}

/**
 * Reference implementation of the helper's guard rules (the fake uses it; the
 * service may pre-check with it).
 *   Blocked app: bundle id listed (case-insensitive) OR bundle id starts with a
 *   listed bundlePrefix OR app name matches nameRe OR window title matches
 *   windowTitleRe → details.rule.matched bundleId | bundlePrefix | name | windowTitle.
 *   Protected window: the app is in scope — bundle id listed or prefixed; no
 *   bundleIds and no bundlePrefixes means any app — AND (window title matches
 *   titleRe OR app name matches appNameRe) → details.rule.matched title | appName.
 * App names and titles are NFC-normalized before matching; patterns are
 * case-insensitive; empty patterns and unknown names / titles never match.
 * Returns null or { code, message, details }.
 */
export function matchGuard(probe, guard, context = '') {
  const p = probe || {};
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const app = typeof p.app === 'string' ? p.app.normalize('NFC') : null;
  const title = typeof p.windowTitle === 'string' ? p.windowTitle.normalize('NFC') : null;
  const blocked = Array.isArray(guard?.blockedApps) ? guard.blockedApps : [];
  for (let i = 0; i < blocked.length; i++) {
    const r = blocked[i] || {};
    let matched = null;
    if (p.bundleId && (r.bundleIds || []).some((b) => same(b, p.bundleId))) matched = 'bundleId';
    else if (p.bundleId && hasBundlePrefix(p.bundleId, r.bundlePrefixes)) matched = 'bundlePrefix';
    else if (app && compileGuardRe(r.nameRe, 'nameRe')?.test(app)) matched = 'name';
    else if (title && compileGuardRe(r.windowTitleRe, 'windowTitleRe')?.test(title)) matched = 'windowTitle';
    if (matched) {
      const reason = r.reason || '';
      return {
        code: ERROR_CODES.BLOCKED_APP,
        message: `${p.app || p.bundleId || 'this app'} is blocked for computer use${reason ? ` (${reason})` : ''}`,
        details: { probe: p, rule: { id: r.id ?? `rule${i}`, reason, matched }, context },
      };
    }
  }
  const protectedWindows = Array.isArray(guard?.protectedWindows) ? guard.protectedWindows : [];
  for (let i = 0; i < protectedWindows.length; i++) {
    const r = protectedWindows[i] || {};
    const ids = r.bundleIds || [];
    const prefixes = r.bundlePrefixes || [];
    const scoped = ids.length > 0 || prefixes.length > 0;
    const appOk = !scoped || (!!p.bundleId && (ids.some((b) => same(b, p.bundleId)) || hasBundlePrefix(p.bundleId, prefixes)));
    if (!appOk) continue;
    let matched = null;
    if (title && compileGuardRe(r.titleRe, 'titleRe')?.test(title)) matched = 'title';
    else if (app && compileGuardRe(r.appNameRe, 'appNameRe')?.test(app)) matched = 'appName';
    if (matched) {
      const reason = r.reason || '';
      const what = matched === 'title' ? `the window "${p.windowTitle}"` : `${p.app || 'this app'} (every window)`;
      return {
        code: ERROR_CODES.PROTECTED_WINDOW,
        message: `${what} is protected${reason ? ` (${reason})` : ''}`,
        details: { probe: p, rule: { index: i, id: r.id ?? null, reason, matched }, context },
      };
    }
  }
  return null;
}

// ── ax_action verify (protocol 2) ──────────────────────────────────────────

/**
 * Text limits the snapshot applies; verify compares within the same limits, in
 * the same unit (grapheme clusters) and after the same trim, so a label longer
 * than its limit verifies against its clipped snapshot copy.
 */
export const VERIFY_TEXT_LIMITS = Object.freeze({ role: 200, subrole: 200, title: 200, description: 200, help: 200, identifier: 120 });

/** Every details.field a TARGET_CHANGED can name, in check order ("sheet" is checked three times). */
export const TARGET_CHANGED_FIELDS = Object.freeze([
  'pid', 'frontmost', 'role', 'subrole', 'title', 'description', 'help', 'identifier',
  'enabled', 'secure', 'press', 'sheet', 'popover', 'dialog', 'modal', 'window',
]);

const DIALOG_SUBROLES = Object.freeze(['AXDialog', 'AXSystemDialog']);

// A Node built without Intl (never the case for supported builds) falls back to
// code points rather than failing to load the protocol the manager depends on.
const GRAPHEMES = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

/**
 * The first `limit` user-perceived characters (extended grapheme clusters), the
 * unit of Swift's String.prefix — so the helper's snapshot clip, the fake's
 * snapshot clip and verifyText all cut at the same place, and NFC never moves
 * the cut (a base letter and its combining marks are one cluster either way).
 */
export function clipGraphemes(value, limit) {
  const s = String(value ?? '');
  const n = Math.max(0, Math.floor(Number(limit) || 0));
  if (s.length <= n) return s; // a cluster is at least one UTF-16 unit
  if (!GRAPHEMES) return [...s].slice(0, n).join('');
  let out = '';
  let count = 0;
  for (const { segment } of GRAPHEMES.segment(s)) {
    if (count >= n) break;
    out += segment;
    count += 1;
  }
  return out;
}

/**
 * What verify trims from both ends: JavaScript's \s plus NEL (U+0085). It is the
 * same set as the helper's VERIFY_TRIM (.whitespacesAndNewlines plus U+FEFF), and
 * a superset of String.prototype.trim, which the Neural Interface applies to the
 * snapshot values it sends — so trimming twice never changes the result.
 */
const VERIFY_TRIM_RE = /^[\s\u0085]+|[\s\u0085]+$/gu;

/** NFC, clipped to `limit` grapheme clusters, whitespace-trimmed; null/undefined → ''. */
export function verifyText(value, limit) {
  if (value == null) return '';
  return clipGraphemes(String(value).normalize('NFC'), limit).replace(VERIFY_TRIM_RE, '');
}

/**
 * The `verify` argument of ax_action, as the helper reads it: an object, only
 * with action "press", a positive pid, a non-empty role; subrole / title /
 * description / help / identifier are strings or null (null or absent means
 * the element must have none). Throws BAD_ARGS; returns the normalized spec.
 */
export function normalizeVerify(verify, action = 'press') {
  if (!verify || typeof verify !== 'object' || Array.isArray(verify)) throw helperError(ERROR_CODES.BAD_ARGS, 'verify must be an object');
  if (action !== 'press') throw helperError(ERROR_CODES.BAD_ARGS, 'verify is only allowed with press', { action });
  const pid = typeof verify.pid === 'number' && Number.isFinite(verify.pid) ? Math.round(verify.pid) : 0;
  if (!(pid > 0)) throw helperError(ERROR_CODES.BAD_ARGS, 'verify.pid is required');
  if (typeof verify.role !== 'string' || !verifyText(verify.role, VERIFY_TEXT_LIMITS.role)) throw helperError(ERROR_CODES.BAD_ARGS, 'verify.role is required');
  const text = (key) => {
    const value = verify[key];
    if (value == null) return '';
    if (typeof value !== 'string') throw helperError(ERROR_CODES.BAD_ARGS, `verify.${key} must be a string or null`, { field: key });
    return verifyText(value, VERIFY_TEXT_LIMITS[key]);
  };
  return {
    pid, role: verifyText(verify.role, VERIFY_TEXT_LIMITS.role), subrole: text('subrole'), title: text('title'),
    description: text('description'), help: text('help'), identifier: text('identifier'),
  };
}

/**
 * Reference for the helper's verifyCompare (same checks, same order, same
 * field names — the drift test compares both sources). `want` comes from
 * normalizeVerify; `facts` describes the element right before the press:
 *   {pid, frontmostPid, role, subrole, title, description, help, identifier,
 *    enabled, secure, canPress, ancestorRoles (element → window, window
 *    excluded), windowSubrole, windowModal, focusedWindowIsSheet,
 *    inFocusedWindow, windowHasSheet}
 * → the first field that no longer holds, or null.
 */
export function compareVerify(want, f = {}) {
  const ancestors = Array.isArray(f.ancestorRoles) ? f.ancestorRoles : [];
  if (f.pid !== want.pid) return 'pid';
  if (f.frontmostPid !== want.pid) return 'frontmost';
  if (verifyText(f.role, 200) !== want.role) return 'role';
  if (verifyText(f.subrole, 200) !== want.subrole) return 'subrole';
  if (verifyText(f.title, 200) !== want.title) return 'title';
  if (verifyText(f.description, 200) !== want.description) return 'description';
  if (verifyText(f.help, 200) !== want.help) return 'help';
  if (verifyText(f.identifier, 120) !== want.identifier) return 'identifier';
  if (f.enabled !== true) return 'enabled';
  if (f.secure) return 'secure';
  if (!f.canPress) return 'press';
  if (ancestors.includes('AXSheet')) return 'sheet';
  if (ancestors.includes('AXPopover')) return 'popover';
  if (f.windowSubrole && DIALOG_SUBROLES.includes(f.windowSubrole)) return 'dialog';
  if (f.windowModal) return 'modal';
  if (f.focusedWindowIsSheet) return 'sheet';
  if (!f.inFocusedWindow) return 'window';
  if (f.windowHasSheet) return 'sheet';
  return null;
}
