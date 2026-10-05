// Fake desktop helper: the whole native protocol (protocol.js) over scripted
// data, with the same guard, latch, queue and abort semantics as
// helper/SynabunDesktop.swift. Used by tests, by the manager's `fake` mode
// (SYNABUN_DESKTOP_HELPER=fake) and for developing the desktop service without
// touching the real desktop.
//
//   in-process  createFakeHelperCore(options) → { handle, on, onExit, emit, start, close, simulate, state, pid }
//   runnable    node fake-helper.js — JSON lines on stdio; options from the
//               env var SYNABUN_FAKE_HELPER_OPTIONS (JSON)
//
// Test hooks (fake only; reachable through the manager too):
//   __fake_state              → received commands, performed actions, config, held input, counters
//   __fake_set {...}          → change scripted state (locked, secureFocus, permissions, frontmostPid, delayMs, …);
//                               axPatch:[{id, patch}] shallow-assigns `patch` onto the live axTrees node
//                               with that test-only `id` (BAD_ARGS when no node has it)
//   __fake_emit {event}       → emit an arbitrary event object
//   __fake_simulate {kind,x,y}→ user input through the monitor rules; kind: mouse|click|key|scroll|esc|corner
//   __fake_crash {code}       → the "process" dies without answering (bypass)
//   __fake_hang               → an action that never finishes (wedges the action queue)
//
// AX fixtures (options.axTrees / __fake_set axTrees, keyed by pid) are element
// objects: role, subrole, title, description, value, help, placeholder,
// identifier, titleElement (a label string or {value, title}), enabled,
// focused, modal (AXModal), actions (AX action names), frame, children, and a
// test-only `id`. They stay live: ax_action re-finds its element in the current
// tree (by `id` when it has one, else by identity) and fails REF_EXPIRED when it
// is gone, so axPatch / a replaced tree reach verify the way a changed app does.
// options.features overrides ready.features (e.g. {axVerify:false} for an old helper).

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BYPASS_COMMANDS, ERROR_CODES, PROTOCOL_VERSION, clipGraphemes, compareVerify, createLineParser, encodeMessage, fitImageSize,
  helperError, matchGuard, mergeConfigure, normalizeVerify, validateGuardSpec,
} from './protocol.js';

// A real 1×1 JPEG; the reported w/h follow the fit math.
export const FAKE_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABgYGBgYGCgYGCg4KCgoOEg4ODg4SFxISEhISFxwXFxcXFxccHBwcHBwcHCIiIiIiIicnJycnLCwsLCwsLCwsLP/bAEMBBwcHCwoLEwoKEy4fGh8uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLv/dAAQAAf/aAAwDAQACEQMRAD8A5eiiiv0Q+YP/2Q==';

export const FAKE_MAIN_DISPLAY = Object.freeze({
  id: 1, index: 0, main: true, bounds: { x: 0, y: 0, w: 1470, h: 956 }, pixel: { w: 2940, h: 1912 },
  scale: 2, asleep: false, name: 'Built-in Retina Display',
});
export const FAKE_SECONDARY_DISPLAY = Object.freeze({
  id: 2, index: 1, main: false, bounds: { x: -1920, y: -124, w: 1920, h: 1080 }, pixel: { w: 1920, h: 1080 },
  scale: 1, asleep: false, name: 'External Display',
});

const DEFAULT_APPS = [
  { pid: 101, bundleId: 'com.apple.finder', name: 'Finder', hidden: false, path: '/System/Library/CoreServices/Finder.app' },
  { pid: 202, bundleId: 'com.apple.Safari', name: 'Safari', hidden: false, path: '/Applications/Safari.app' },
  { pid: 303, bundleId: 'com.apple.TextEdit', name: 'TextEdit', hidden: false, path: '/System/Applications/TextEdit.app' },
  { pid: 404, bundleId: 'com.1password.1password', name: '1Password', hidden: false, path: '/Applications/1Password.app' },
  { pid: 505, bundleId: 'com.apple.Terminal', name: 'Terminal', hidden: false, path: '/System/Applications/Utilities/Terminal.app' },
];

const DEFAULT_INSTALLED = [
  { bundleId: 'com.apple.calculator', name: 'Calculator', path: '/System/Applications/Calculator.app' },
  { bundleId: 'com.apple.Notes', name: 'Notes', path: '/System/Applications/Notes.app' },
];

// Front to back, like CGWindowListCopyWindowInfo.
const DEFAULT_WINDOWS = [
  {
    windowId: 1001, pid: 202, title: 'Example Domain', bounds: { x: 80, y: 60, w: 900, h: 700 }, layer: 0, onScreen: true,
    elements: [
      { role: 'AXButton', title: 'Reload', frame: { x: 100, y: 70, w: 24, h: 24 } },
      { role: 'AXTextField', title: 'Address', value: 'https://example.com', frame: { x: 140, y: 70, w: 600, h: 24 } },
      { role: 'AXLink', title: 'More information...', frame: { x: 120, y: 300, w: 200, h: 20 } },
    ],
  },
  { windowId: 1002, pid: 303, title: 'Untitled', bounds: { x: 700, y: 200, w: 600, h: 500 }, layer: 0, onScreen: true },
  { windowId: 1003, pid: 404, title: '1Password', bounds: { x: 1000, y: 520, w: 420, h: 400 }, layer: 0, onScreen: true },
  { windowId: 1004, pid: 505, title: 'zsh', bounds: { x: 40, y: 600, w: 500, h: 300 }, layer: 0, onScreen: true },
  { windowId: 1005, pid: 303, title: 'Notes.txt', bounds: { x: 200, y: 150, w: 500, h: 400 }, layer: 0, onScreen: false },
];

const SECONDARY_WINDOW = { windowId: 1006, pid: 202, title: 'Docs', bounds: { x: -1800, y: 0, w: 1200, h: 800 }, layer: 0, onScreen: true };

const DEFAULT_PERMISSIONS = { screenRecording: true, accessibility: true, postEvents: true, inputMonitoring: true };
const DEFAULT_RESPONSIBLE_APP = { name: 'Terminal', bundleId: 'com.apple.Terminal', path: '/System/Applications/Utilities/Terminal.app', pid: 505 };

const DEFAULT_CONFIG = {
  guard: { blockedApps: [], protectedWindows: [], secureField: true, refuseWhenLocked: true },
  monitor: { armed: false, esc: true, failsafeCorner: true, cornerSizePt: 4 },
  input: { typeChunk: 20, typeDelayMs: 10, moveSteps: 8 },
};

const TEST_BYPASS = new Set(['__fake_state', '__fake_set', '__fake_emit', '__fake_simulate', '__fake_crash']);
const BYPASS = new Set(BYPASS_COMMANDS);
// Commands that apply delayMs themselves (between their guard checks, or as an
// interruptible wait); every other command is delayed before it runs.
const SELF_PACED = new Set([
  'screenshot', 'capture_rect', 'move', 'click', 'mouse_down', 'drag', 'scroll', 'type', 'key', 'hold_key',
  'open_app', 'focus_app', 'ax_snapshot', 'ax_action',
]);

const MOD_ALIASES = {
  cmd: 'cmd', command: 'cmd', super: 'cmd', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt',
  ctrl: 'ctrl', control: 'ctrl', fn: 'fn', function: 'fn',
};
const NAMED_KEYS = new Set([
  'return', 'enter', 'kp_enter', 'tab', 'escape', 'esc', 'backspace', 'delete', 'forwarddelete', 'up', 'down', 'left',
  'right', 'home', 'end', 'page_up', 'pageup', 'prior', 'page_down', 'pagedown', 'next', 'help', 'insert',
  ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`),
]);
const KEYSYM_CHARS = {
  space: ' ', minus: '-', equal: '=', plus: '+', underscore: '_', comma: ',', period: '.', slash: '/', backslash: '\\',
  semicolon: ';', colon: ':', apostrophe: "'", quoteright: "'", quotedbl: '"', grave: '`', quoteleft: '`', asciitilde: '~',
  bracketleft: '[', bracketright: ']', braceleft: '{', braceright: '}', parenleft: '(', parenright: ')', less: '<',
  greater: '>', question: '?', exclam: '!', at: '@', numbersign: '#', dollar: '$', percent: '%', asciicircum: '^',
  ampersand: '&', asterisk: '*', bar: '|',
};
const SHIFTED_CHARS = new Set('!@#$%^&*()_+{}|:"<>?~');

const INTERACTIVE_ROLES = new Set([
  'AXButton', 'AXCheckBox', 'AXRadioButton', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXPopUpButton', 'AXMenuButton',
  'AXSlider', 'AXLink', 'AXMenuItem', 'AXMenuBarItem', 'AXDisclosureTriangle', 'AXIncrementor', 'AXColorWell',
  'AXDockItem', 'AXRow', 'AXTab', 'AXSearchField',
]);
const INTERACTIVE_ACTIONS = new Set(['AXPress', 'AXConfirm', 'AXPick', 'AXIncrement', 'AXDecrement', 'AXShowMenu', 'AXOpen']);
const ACTION_NAMES = {
  AXPress: 'press', AXShowMenu: 'show_menu', AXRaise: 'raise', AXScrollToVisible: 'scroll_into_view', AXConfirm: 'confirm',
  AXPick: 'select', AXIncrement: 'increment', AXDecrement: 'decrement', AXCancel: 'cancel',
};
const TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox']);
const AX_ACTIONS = new Set(['press', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'scroll_into_view', 'raise', 'show_menu']);
// Same tables as the helper's snapshot walk (protocol 2).
const GROUP_ROLES = new Set([
  'AXGroup', 'AXToolbar', 'AXSheet', 'AXTabGroup', 'AXSplitGroup', 'AXScrollArea', 'AXOutline', 'AXTable',
  'AXList', 'AXRadioGroup', 'AXPopover', 'AXBrowser',
]);
const BARE_GROUP_ROLES = new Set(['AXToolbar', 'AXSheet', 'AXPopover']);
const DIALOG_SUBROLES = new Set(['AXDialog', 'AXSystemDialog']);
const ROW_ROLES = new Set(['AXRow', 'AXCell']);

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
/**
 * First n characters as Swift counts them (grapheme clusters, String.prefix): the
 * same unit verifyText clips in, so a clipped label still verifies whatever its
 * normalization.
 */
const clip = (s, n) => clipGraphemes(s, n);
const clipOrNull = (v, n) => (v == null ? null : clip(String(v), n));
/** Whitespace runs collapsed to one space; null unless a non-blank string. */
const cleanLabel = (s) => (typeof s === 'string' ? s.split(/\s+/).filter(Boolean).join(' ') || null : null);

/** The helper's groupForChildren: "<role> <label>" ≤ 60, bare toolbar/sheet/popover, else inherited. */
function groupForChildren(role, title, description, inherited) {
  if (!GROUP_ROLES.has(role)) return inherited;
  const name = role.slice(2).toLowerCase();
  const label = cleanLabel(title) ?? cleanLabel(description);
  if (label) return clip(`${name} ${label}`, 60);
  return BARE_GROUP_ROLES.has(role) ? name : inherited;
}

/** enrich: the fixture's titleElement label (a string, or its value / title), ≤ 80. */
function titleElementLabel(te) {
  if (te == null) return null;
  const s = typeof te === 'string' ? cleanLabel(te) : cleanLabel(te.value) ?? cleanLabel(te.title);
  return s ? clip(s, 80) : null;
}

/** enrich: first AXStaticText value two levels below an unnamed row (≤ 8 children per element), ≤ 80. */
function contentLabelOf(el) {
  let level = (el.children || []).slice(0, 8);
  for (let depth = 0; depth < 2; depth++) {
    const next = [];
    for (const c of level) {
      if (!c || typeof c !== 'object' || c.role == null) continue;
      if (c.role === 'AXStaticText') {
        const s = cleanLabel(c.value);
        if (s) return clip(s, 80);
      }
      if (depth === 0) next.push(...(c.children || []).slice(0, 8));
    }
    level = next;
  }
  return null;
}

/** Path root → target (inclusive) in a fixture tree: by test-only `id` when the target has one, else by identity. */
function findPath(root, target) {
  if (!root || typeof root !== 'object' || !target) return null;
  const byId = target.id != null;
  const stack = [[root, [root]]];
  while (stack.length) {
    const [node, path] = stack.pop();
    if (byId ? node.id === target.id : node === target) return path;
    const kids = Array.isArray(node.children) ? node.children : [];
    for (let i = kids.length - 1; i >= 0; i--) {
      if (kids[i] && typeof kids[i] === 'object') stack.push([kids[i], [...path, kids[i]]]);
    }
  }
  return null;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const inside = (r, x, y) => !!r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/** The same light parse the helper applies: known names only, uppercase letters imply shift. */
export function parseComboLite(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw helperError(ERROR_CODES.BAD_ARGS, 'empty key combo');
  let tokens;
  if (s === '+') tokens = ['+'];
  else if (s.endsWith('++')) tokens = [...s.slice(0, -2).split('+'), '+'];
  else tokens = s.split('+');
  tokens = tokens.map((t) => t.trim());
  if (tokens.some((t) => !t)) throw helperError(ERROR_CODES.BAD_ARGS, `malformed key combo '${raw}'`);
  const mods = [];
  let key = null;
  let isChar = false;
  tokens.forEach((t, i) => {
    const m = MOD_ALIASES[t.toLowerCase()];
    if (m) {
      if (!mods.includes(m)) mods.push(m);
      return;
    }
    if (i !== tokens.length - 1) throw helperError(ERROR_CODES.BAD_ARGS, `unknown modifier '${t}' in '${raw}'`);
    const lower = t.toLowerCase();
    if (NAMED_KEYS.has(lower)) {
      key = lower;
      return;
    }
    const ch = KEYSYM_CHARS[lower] ?? ([...t].length === 1 ? t : null);
    if (ch == null) throw helperError(ERROR_CODES.BAD_ARGS, `unknown key '${t}' in '${raw}'`);
    key = ch.toLowerCase();
    isChar = true;
    if ((ch !== ch.toLowerCase() || SHIFTED_CHARS.has(ch)) && !mods.includes('shift')) mods.push('shift');
  });
  const needsSecureCheck = key != null
    && ((isChar && mods.every((m) => m === 'shift' || m === 'alt')) || (key === 'v' && mods.includes('cmd')));
  return { mods, key, isChar, needsSecureCheck };
}

function validateAppToken(s, field) {
  const bad = typeof s !== 'string' || !s || s.length > 200 || s.includes('://') || s.includes('/') || s.includes(':')
    || s.includes('..') || s.startsWith('~') || /[\u0000-\u001f\u007f]/.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s);
  if (bad) throw helperError(ERROR_CODES.BAD_ARGS, `${field} must be an app name or bundle id, not a URL or path`);
}

let coreSeq = 0;

export function createFakeHelperCore(options = {}) {
  const opts = { ...options };
  const env = opts.env || {};
  const pid = isNum(opts.pid) ? opts.pid : 90000 + (++coreSeq);

  const displays = clone(opts.displays) || [
    { ...FAKE_MAIN_DISPLAY, bounds: { ...FAKE_MAIN_DISPLAY.bounds }, pixel: { ...FAKE_MAIN_DISPLAY.pixel } },
    ...(opts.secondaryDisplay ? [typeof opts.secondaryDisplay === 'object' ? clone(opts.secondaryDisplay) : clone({ ...FAKE_SECONDARY_DISPLAY })] : []),
  ];
  const windows = clone(opts.windows) || [...clone(DEFAULT_WINDOWS), ...(opts.secondaryDisplay ? [clone(SECONDARY_WINDOW)] : [])];

  const state = {
    displays,
    apps: clone(opts.apps) || clone(DEFAULT_APPS),
    installedApps: clone(opts.installedApps) || clone(DEFAULT_INSTALLED),
    windows,
    permissions: { ...DEFAULT_PERMISSIONS, ...(opts.permissions || {}) },
    responsibleApp: opts.responsibleApp === undefined ? { ...DEFAULT_RESPONSIBLE_APP } : clone(opts.responsibleApp),
    locked: !!opts.locked,
    onConsole: opts.onConsole !== false,
    secureInput: !!opts.secureInput,
    secureFocus: !!opts.secureFocus,
    focusUnreadable: !!opts.focusUnreadable,
    focus: clone(opts.focus) || null,
    frontmostPid: isNum(opts.frontmostPid) ? opts.frontmostPid : 202,
    cursor: { x: 400, y: 300, ...(opts.cursor || {}) },
    axTrees: clone(opts.axTrees) || {},
    delayMs: clone(opts.delayMs) ?? 0,
    config: mergeConfigure(clone(DEFAULT_CONFIG), {}),
    latched: false,
    inCorner: false,
    power: false,
    received: [],
    actions: [],
    held: { buttons: new Set(), keys: new Set() },
    snapshots: [],
    aborts: 0,
    panics: 0,
  };

  const eventListeners = new Set();
  const exitListeners = new Set();
  const waiters = new Set();
  let chain = Promise.resolve();
  let gen = 0;
  let snapshotSeq = 0;
  let nextPid = 7000;
  let started = false;
  let closed = false;
  let lastUserInputAt = 0;
  const userInputIntervalMs = isNum(opts.userInputIntervalMs) ? opts.userInputIntervalMs : 250;

  // ── events / lifetime ──
  function emit(ev) {
    if (closed || !ev) return;
    for (const fn of [...eventListeners]) {
      try { fn(ev); } catch {}
    }
  }

  function on(fn) {
    eventListeners.add(fn);
    return () => eventListeners.delete(fn);
  }

  function onExit(fn) {
    exitListeners.add(fn);
    return () => exitListeners.delete(fn);
  }

  function readyEvent() {
    return {
      event: 'ready',
      protocol: isNum(opts.protocol) ? opts.protocol : PROTOCOL_VERSION,
      version: opts.version || '0.0.0-fake',
      sourceHash: env.SYNABUN_DESKTOP_SOURCE_HASH || 'fake',
      pid,
      arch: process.arch,
      os: 'fake',
      features: { sck: true, captureInRect: true, monitor: 'fake', axVerify: true, guardPrefixes: true, axEnrich: true, ...(opts.features || {}) },
    };
  }

  function start() {
    if (started || closed) return;
    started = true;
    const go = () => {
      if (closed) return;
      if (opts.crashBeforeReady) {
        exit(1, null);
        return;
      }
      emit(readyEvent());
    };
    if (opts.readyDelayMs > 0) setTimeout(go, opts.readyDelayMs);
    else queueMicrotask(go);
  }

  function exit(code = 0, signal = null) {
    if (closed) return;
    closed = true;
    for (const w of [...waiters]) w.resolve('abort');
    setImmediate(() => {
      for (const fn of [...exitListeners]) {
        try { fn({ code, signal }); } catch {}
      }
    });
  }

  /** The manager's kill(): the process is gone, nothing more is answered. */
  function close({ code = null, signal = 'SIGKILL' } = {}) {
    exit(code, signal);
  }

  // ── waits (abortable, optionally interrupted by user input) ──
  function wait(ms, myGen, { userInput = false } = {}) {
    return new Promise((resolve) => {
      if (closed || gen !== myGen) {
        resolve('abort');
        return;
      }
      if (!(ms > 0)) {
        resolve('done');
        return;
      }
      const w = {
        userInput,
        resolve: (why) => {
          clearTimeout(timer);
          waiters.delete(w);
          resolve(why);
        },
      };
      const timer = setTimeout(() => w.resolve('done'), ms);
      waiters.add(w);
    });
  }

  function delayFor(cmd) {
    const d = state.delayMs;
    if (isNum(d)) return BYPASS.has(cmd) || TEST_BYPASS.has(cmd) ? 0 : d;
    return d && isNum(d[cmd]) ? d[cmd] : 0;
  }

  async function pause(cmd, myGen) {
    if ((await wait(delayFor(cmd), myGen)) === 'abort') throw helperError(ERROR_CODES.ABORTED, 'the action was aborted');
  }

  function releaseHeld() {
    if (state.held.buttons.size || state.held.keys.size) {
      state.actions.push({ cmd: 'release', buttons: [...state.held.buttons], keys: [...state.held.keys] });
    }
    state.held.buttons.clear();
    state.held.keys.clear();
  }

  function doAbort() {
    gen += 1;
    state.aborts += 1;
    for (const w of [...waiters]) w.resolve('abort');
    releaseHeld();
  }

  function emergencyStop(reason) {
    state.latched = true;
    doAbort();
    emit({ event: 'emergency_stop', reason });
  }

  // ── scripted world ──
  const appByPid = (p) => state.apps.find((a) => a.pid === p) || null;
  const frontmost = () => {
    const a = appByPid(state.frontmostPid);
    return a ? { pid: a.pid, bundleId: a.bundleId ?? null, name: a.name ?? null } : null;
  };
  const mainDisplay = () => state.displays.find((d) => d.main) || state.displays[0];
  const displayAt = (x, y) => state.displays.find((d) => inside(d.bounds, x, y)) || null;

  function elementProbe(w, el) {
    const app = appByPid(w?.pid);
    const secure = el?.subrole === 'AXSecureTextField' || el?.role === 'AXSecureTextField';
    return {
      pid: w?.pid ?? null,
      bundleId: w?.bundleId ?? app?.bundleId ?? null,
      app: w?.app ?? app?.name ?? null,
      windowId: w?.windowId ?? null,
      windowTitle: w?.title ?? null,
      role: el?.role ?? null,
      subrole: el?.subrole ?? null,
      title: el?.title ?? null,
      description: el?.description ?? null,
      valuePreview: secure || el?.value == null ? null : String(el.value).slice(0, 80),
      secure,
      enabled: el ? el.enabled ?? true : null,
      frame: clone(el?.frame ?? w?.bounds ?? null),
    };
  }

  function probeAt(x, y) {
    const w = state.windows.find((win) => win.onScreen !== false && inside(win.bounds, x, y));
    if (!w) return elementProbe(null, null);
    const el = (w.elements || []).find((e) => inside(e.frame, x, y)) || { role: 'AXGroup', frame: w.bounds };
    return elementProbe(w, el);
  }

  function frontWindow() {
    return state.windows.find((w) => w.pid === state.frontmostPid && w.onScreen !== false)
      || state.windows.find((w) => w.pid === state.frontmostPid) || null;
  }

  function frontWindowProbe() {
    const w = frontWindow();
    const app = appByPid(state.frontmostPid);
    if (!w) return { ...elementProbe(null, null), pid: app?.pid ?? null, bundleId: app?.bundleId ?? null, app: app?.name ?? null };
    return elementProbe(w, { role: 'AXWindow', title: w.title, frame: w.bounds });
  }

  function focusProbe() {
    const w = frontWindow();
    if (state.focusUnreadable || !w) return { probe: frontWindowProbe(), readable: false };
    const b = w.bounds;
    const el = { role: 'AXTextField', title: 'Address', value: '', frame: { x: b.x + 60, y: b.y + 10, w: Math.max(40, b.w - 120), h: 24 }, ...(state.focus || {}) };
    if (state.secureFocus) {
      el.subrole = 'AXSecureTextField';
      if (!state.focus?.title) el.title = 'Password';
    }
    return { probe: elementProbe(w, el), readable: true };
  }

  // ── guards (same order as the helper) ──
  function requireTrusted() {
    if (!state.permissions.accessibility) {
      throw helperError(ERROR_CODES.NOT_TRUSTED, 'Accessibility permission is required', { responsibleApp: clone(state.responsibleApp) });
    }
  }
  function requireNotLatched() {
    if (state.latched) throw helperError(ERROR_CODES.INTERRUPTED, 'an emergency stop is latched; send configure to resume', { latched: true });
  }
  function requireUnlocked() {
    if (state.config.guard.refuseWhenLocked === false) return;
    if (state.locked || !state.onConsole) {
      throw helperError(ERROR_CODES.SCREEN_LOCKED, state.locked ? 'the screen is locked' : 'the login session is not on the console',
        { locked: state.locked, onConsole: state.onConsole });
    }
  }
  function preInput() {
    requireTrusted();
    requireNotLatched();
    requireUnlocked();
  }
  function requireCapture() {
    if (!state.permissions.screenRecording) {
      throw helperError(ERROR_CODES.NO_SCREEN_RECORDING, 'Screen Recording permission is required', { responsibleApp: clone(state.responsibleApp) });
    }
  }
  function point(v, name = 'this command') {
    if (!v || !isNum(v.x) || !isNum(v.y)) throw helperError(ERROR_CODES.BAD_ARGS, `${name} needs numeric x and y (global display points)`);
    return { x: v.x, y: v.y };
  }
  function requireOnScreen(p) {
    if (!displayAt(p.x, p.y)) throw helperError(ERROR_CODES.OUT_OF_BOUNDS, `(${p.x}, ${p.y}) is not on any display`, { point: p });
  }
  function checkGuard(probe, context) {
    const hit = matchGuard(probe, state.config.guard, context);
    if (hit) throw helperError(hit.code, hit.message, hit.details);
  }
  function guardPoint(p, context) {
    const probe = probeAt(p.x, p.y);
    checkGuard(probe, context);
    return probe;
  }
  function keyboardGuard(printable, context) {
    requireUnlocked();
    const { probe, readable } = focusProbe();
    checkGuard(probe, context);
    checkGuard(frontWindowProbe(), context);
    if (printable && state.config.guard.secureField !== false) {
      if (probe.secure) throw helperError(ERROR_CODES.SECURE_FIELD, 'the focused field is a password field', { probe, context });
      if (!readable && state.secureInput) {
        throw helperError(ERROR_CODES.SECURE_FIELD, "secure input is active and the focused element can't be read", { probe, context, secureInput: true });
      }
    }
    return probe;
  }
  function parseButton(b) {
    if (b == null) return 'left';
    if (!['left', 'right', 'middle'].includes(String(b).toLowerCase())) throw helperError(ERROR_CODES.BAD_ARGS, 'button must be left, right or middle');
    return String(b).toLowerCase();
  }
  function parseModifiers(list) {
    const out = [];
    for (const m of list || []) {
      const mod = MOD_ALIASES[String(m).toLowerCase()];
      if (!mod) throw helperError(ERROR_CODES.BAD_ARGS, `unknown modifier ${m}`);
      if (!out.includes(mod)) out.push(mod);
    }
    return out;
  }
  function record(entry) {
    state.actions.push(clone(entry));
  }

  // ── accessibility snapshots ──
  function defaultTree(w) {
    const b = w.bounds;
    const row = (i) => ({ x: b.x + 20, y: b.y + 40 + i * 32, w: Math.max(40, Math.min(300, b.w - 40)), h: 24 });
    return {
      role: 'AXWindow', title: w.title, frame: clone(b), actions: ['AXRaise'],
      children: [
        {
          role: 'AXToolbar', frame: { x: b.x, y: b.y, w: b.w, h: 36 },
          children: [
            { role: 'AXButton', title: 'Back', actions: ['AXPress'], frame: row(0) },
            { role: 'AXButton', title: 'Forward', actions: ['AXPress'], enabled: false, frame: row(1) },
          ],
        },
        {
          role: 'AXGroup', frame: { x: b.x, y: b.y + 36, w: b.w, h: b.h - 36 },
          children: [
            { role: 'AXTextField', title: 'Search', value: 'hello world', actions: ['AXConfirm'], frame: row(2) },
            { role: 'AXTextField', subrole: 'AXSecureTextField', title: 'Password', value: 'hunter2', frame: row(3) },
            { role: 'AXCheckBox', title: 'Remember me', value: 0, actions: ['AXPress'], frame: row(4) },
            { role: 'AXLink', title: 'Forgot password?', actions: ['AXPress'], frame: row(5) },
            { role: 'AXStaticText', value: 'Welcome back', frame: row(6) },
          ],
        },
      ],
    };
  }

  function axSnapshot(args) {
    requireTrusted();
    requireUnlocked();
    const depthMax = clamp(Math.round(isNum(args.depth) ? args.depth : 12), 1, 40);
    const maxNodes = clamp(Math.round(isNum(args.maxNodes) ? args.maxNodes : 400), 1, 5000);
    const interactiveOnly = args.interactiveOnly !== false;
    const enrich = args.enrich === true;
    const maxTexts = clamp(Math.round(isNum(args.maxTexts) ? args.maxTexts : 80), 0, 500);
    let win = null;
    let targetPid;
    if (isNum(args.windowId)) {
      win = state.windows.find((w) => w.windowId === args.windowId);
      if (!win) throw helperError(ERROR_CODES.APP_NOT_FOUND, `window ${args.windowId} not found`, { windowId: args.windowId });
      targetPid = win.pid;
    } else {
      targetPid = isNum(args.pid) ? args.pid : state.frontmostPid;
      win = state.windows.find((w) => w.pid === targetPid && w.onScreen !== false) || state.windows.find((w) => w.pid === targetPid) || null;
    }
    const app = appByPid(targetPid);
    if (!app) throw helperError(ERROR_CODES.APP_NOT_FOUND, `no process ${targetPid}`);
    const tree = state.axTrees[targetPid] || (win ? defaultTree(win) : { role: 'AXApplication', title: app.name, children: [] });

    const nodes = [];
    const elements = [];
    const texts = [];
    let truncated = false;
    const stack = [{ el: tree, depth: 0, parent: null, group: null, modal: false, web: false }];
    while (stack.length) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        break;
      }
      const item = stack.pop();
      const { el, depth, parent } = item;
      const role = el.role ?? null;
      const subrole = el.subrole ?? null;
      const title = clipOrNull(el.title, 200);
      const description = clipOrNull(el.description, 200);
      const secure = subrole === 'AXSecureTextField' || role === 'AXSecureTextField';
      const dialogWindow = role === 'AXWindow' && DIALOG_SUBROLES.has(subrole);
      const modal = item.modal || role === 'AXSheet' || role === 'AXPopover' || dialogWindow || el.modal === true;
      const web = item.web || role === 'AXWebArea';
      if (enrich && role === 'AXStaticText' && texts.length < maxTexts) {
        const text = cleanLabel(el.value);
        if (text) texts.push(clip(text, 200));
      }
      const rawActions = el.actions || [];
      const interactive = secure || INTERACTIVE_ROLES.has(role) || rawActions.some((a) => INTERACTIVE_ACTIONS.has(a));
      let myRef = parent;
      if (!interactiveOnly || interactive) {
        elements.push({ el, win, pid: targetPid, root: tree });
        const ref = `e${elements.length}`;
        myRef = ref;
        const textRole = TEXT_ROLES.has(role) || role === 'AXSearchField';
        const actions = rawActions.map((a) => ACTION_NAMES[a] ?? (a.startsWith('AX') ? null : a)).filter(Boolean);
        if (textRole) actions.push('focus', 'set_value');
        if (role === 'AXCheckBox' || role === 'AXRadioButton') actions.push('toggle');
        const value = secure || el.value == null ? null : (typeof el.value === 'string' ? clip(el.value, 200) : el.value);
        const node = {
          ref, parent, depth, role, subrole, title, description,
          value, secure, enabled: el.enabled ?? true, focused: el.focused ?? false,
          actions: [...new Set(actions)].sort(), frame: clone(el.frame ?? null),
          help: clipOrNull(el.help, 200), placeholder: textRole ? clipOrNull(el.placeholder, 200) : null,
          identifier: clipOrNull(el.identifier, 120), group: item.group, modal, web,
        };
        if (enrich) {
          node.titleElement = titleElementLabel(el.titleElement);
          const rowLike = ROW_ROLES.has(role) || subrole === 'AXOutlineRow';
          node.contentLabel = rowLike && !cleanLabel(title) && !cleanLabel(description) ? contentLabelOf(el) : null;
        }
        nodes.push(node);
      }
      if (depth < depthMax && role !== 'AXMenuBar') {
        const kids = el.children || [];
        const group = groupForChildren(role, title, description, item.group);
        for (let i = kids.length - 1; i >= 0; i--) stack.push({ el: kids[i], depth: depth + 1, parent: myRef, group, modal, web });
      }
    }
    const snapshotId = `s${++snapshotSeq}`;
    state.snapshots.push({ id: snapshotId, elements });
    if (state.snapshots.length > 4) state.snapshots.splice(0, state.snapshots.length - 4);
    const result = { snapshotId, app: { pid: app.pid, bundleId: app.bundleId ?? null, name: app.name ?? null }, nodes, truncated };
    if (enrich) {
      result.app.lang = app.lang ?? 'en';
      result.window = tree.role === 'AXWindow'
        ? { id: win?.windowId ?? null, title: clipOrNull(tree.title ?? win?.title, 1000), subrole: tree.subrole ?? null, modal: tree.modal === true }
        : null;
      result.texts = texts;
    }
    return result;
  }

  function axLookup(snapshotId, ref) {
    const snap = state.snapshots.find((s) => s.id === snapshotId);
    const n = /^e(\d+)$/.exec(String(ref ?? ''))?.[1];
    const item = snap && n ? snap.elements[Number(n) - 1] : null;
    if (!item) throw helperError(ERROR_CODES.REF_EXPIRED, `${snapshotId}/${ref} is not in the last 4 snapshots`, { snapshotId, ref });
    return item;
  }

  /** The element as the app shows it now (fixture trees are live), with its window re-read. */
  function axResolve(item, snapshotId, ref) {
    const root = state.axTrees[item.pid] || item.root;
    const path = findPath(root, item.el);
    if (!path) throw helperError(ERROR_CODES.REF_EXPIRED, `${snapshotId}/${ref} no longer exists`, { snapshotId, ref });
    const win = (item.win && state.windows.find((w) => w.windowId === item.win.windowId)) || item.win;
    return { node: path[path.length - 1], ancestors: path.slice(0, -1), root, win, pid: item.pid };
  }

  /** The helper's verifyFacts over the fixture: the app's focused window is its frontmost on-screen one. */
  function verifyFacts({ node, ancestors, root, win, pid }) {
    const ancestorRoles = [];
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const r = ancestors[i]?.role;
      if (r == null || r === 'AXWindow' || r === 'AXApplication') break;
      ancestorRoles.push(r);
    }
    const windowNode = root?.role === 'AXWindow' ? root : null;
    const focused = state.windows.find((w) => w.pid === pid && w.onScreen !== false) || null;
    return {
      pid, frontmostPid: state.frontmostPid,
      role: node.role ?? null, subrole: node.subrole ?? null, title: node.title ?? null, description: node.description ?? null,
      help: node.help ?? null, identifier: node.identifier ?? null, enabled: node.enabled ?? true,
      secure: node.subrole === 'AXSecureTextField' || node.role === 'AXSecureTextField',
      canPress: (node.actions || []).includes('AXPress'),
      ancestorRoles,
      windowSubrole: windowNode?.subrole ?? null, windowModal: windowNode?.modal === true,
      focusedWindowIsSheet: false,
      inFocusedWindow: !!win && !!focused && focused.windowId === win.windowId,
      windowHasSheet: (windowNode?.children || []).some((c) => c?.role === 'AXSheet'),
    };
  }

  // ── commands ──
  async function execute(cmd, args, myGen) {
    switch (cmd) {
      case 'permissions':
        return { ...state.permissions, responsibleApp: clone(state.responsibleApp) };

      case 'request_permission': {
        const kind = args.kind;
        if (kind !== 'screen' && kind !== 'accessibility') throw helperError(ERROR_CODES.BAD_ARGS, "kind must be 'screen' or 'accessibility'");
        if (opts.grantOnRequest) {
          const key = kind === 'screen' ? 'screenRecording' : 'accessibility';
          if (!state.permissions[key]) {
            state.permissions[key] = true;
            if (key === 'accessibility') state.permissions.postEvents = true;
            emit({ event: 'permissions_changed', permissions: { ...state.permissions, responsibleApp: clone(state.responsibleApp) } });
          }
        }
        return { ...state.permissions, responsibleApp: clone(state.responsibleApp) };
      }

      case 'displays':
        return clone(state.displays);

      case 'session_state':
        return { locked: state.locked, onConsole: state.onConsole, secureInput: state.secureInput, frontmost: frontmost() };

      case 'configure': {
        if (args.guard != null) validateGuardSpec(args.guard);
        const next = mergeConfigure(state.config, { guard: args.guard, monitor: args.monitor, input: args.input });
        const m = next.monitor;
        m.cornerSizePt = clamp(isNum(m.cornerSizePt) ? m.cornerSizePt : 4, 1, 200);
        const i = next.input;
        i.typeChunk = clamp(Math.trunc(isNum(i.typeChunk) ? i.typeChunk : 20), 1, 20);
        i.typeDelayMs = clamp(isNum(i.typeDelayMs) ? i.typeDelayMs : 10, 0, 1000);
        i.moveSteps = clamp(Math.trunc(isNum(i.moveSteps) ? i.moveSteps : 8), 1, 200);
        state.config = clone(next);
        state.latched = false;
        return {};
      }

      case 'screenshot': {
        requireCapture();
        const d = args.displayId != null ? state.displays.find((x) => x.id === args.displayId) : mainDisplay();
        if (!d) throw helperError(ERROR_CODES.BAD_ARGS, `unknown display ${args.displayId}`);
        await pause(cmd, myGen);
        const fit = { w: isNum(args.fit?.w) ? args.fit.w : d.bounds.w, h: isNum(args.fit?.h) ? args.fit.h : d.bounds.h };
        const size = fitImageSize(d.bounds, fit, d.scale);
        return {
          displayId: d.id, bounds: clone(d.bounds), capturedPixels: clone(d.pixel),
          image: { w: size.w, h: size.h, mime: 'image/jpeg', data: FAKE_JPEG_BASE64 },
          cursor: { ...state.cursor }, frontmost: frontmost(), capturedAt: Date.now(),
        };
      }

      case 'capture_rect': {
        requireCapture();
        const r = args.rect;
        if (!r || !isNum(r.x) || !isNum(r.y) || !(r.w > 0) || !(r.h > 0)) throw helperError(ERROR_CODES.BAD_ARGS, 'rect needs numeric x, y and positive w, h');
        const d = displayAt(r.x + r.w / 2, r.y + r.h / 2);
        if (!d) throw helperError(ERROR_CODES.OUT_OF_BOUNDS, "the rect's centre is not on any display", { rect: r });
        const x0 = Math.max(r.x, d.bounds.x), y0 = Math.max(r.y, d.bounds.y);
        const x1 = Math.min(r.x + r.w, d.bounds.x + d.bounds.w), y1 = Math.min(r.y + r.h, d.bounds.y + d.bounds.h);
        const clipped = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        await pause(cmd, myGen);
        const fit = { w: isNum(args.fit?.w) ? args.fit.w : clipped.w * d.scale, h: isNum(args.fit?.h) ? args.fit.h : clipped.h * d.scale };
        const size = fitImageSize(clipped, fit, d.scale);
        return { image: { w: size.w, h: size.h, mime: 'image/jpeg', data: FAKE_JPEG_BASE64 }, rect: clipped, capturedAt: Date.now() };
      }

      case 'cursor':
        return { ...state.cursor };

      case 'move': {
        preInput();
        const p = point(args);
        requireOnScreen(p);
        if (state.held.buttons.size) guardPoint(p, 'move.drag'); // a move with a button down is a drag
        await pause(cmd, myGen);
        state.cursor = p;
        record({ cmd, x: p.x, y: p.y });
        return {};
      }

      case 'click':
      case 'mouse_down': {
        preInput();
        const p = point(args);
        requireOnScreen(p);
        const button = parseButton(args.button);
        const count = clamp(Math.round(isNum(args.count) ? args.count : 1), 1, 3);
        const modifiers = parseModifiers(args.modifiers);
        guardPoint(p, cmd);
        await pause(cmd, myGen);
        const target = guardPoint(p, cmd); // re-checked right before the button goes down, like the helper
        state.cursor = p;
        if (cmd === 'mouse_down') state.held.buttons.add(button);
        record(cmd === 'click' ? { cmd, x: p.x, y: p.y, button, count, modifiers, target } : { cmd, x: p.x, y: p.y, button, target });
        return { target };
      }

      case 'mouse_up': {
        requireTrusted();
        const p = point(args);
        requireOnScreen(p);
        const button = parseButton(args.button);
        state.cursor = p;
        state.held.buttons.delete(button);
        const target = probeAt(p.x, p.y);
        record({ cmd, x: p.x, y: p.y, button, target });
        return { target };
      }

      case 'drag': {
        preInput();
        const from = point(args.from, 'from');
        const to = point(args.to, 'to');
        requireOnScreen(from);
        requireOnScreen(to);
        const button = parseButton(args.button);
        const target = guardPoint(from, 'drag.from');
        guardPoint(to, 'drag.to');
        await pause(cmd, myGen);
        state.cursor = to;
        record({ cmd, from, to, button, steps: isNum(args.steps) ? args.steps : 20, target });
        return { target };
      }

      case 'scroll': {
        preInput();
        const p = point(args);
        requireOnScreen(p);
        if (args.units != null && args.units !== 'line') throw helperError(ERROR_CODES.BAD_ARGS, "units must be 'line'");
        const modifiers = parseModifiers(args.modifiers);
        const target = guardPoint(p, cmd);
        await pause(cmd, myGen);
        state.cursor = p;
        record({ cmd, x: p.x, y: p.y, dx: Math.round(args.dx || 0), dy: Math.round(args.dy || 0), modifiers, target });
        return { target };
      }

      case 'type': {
        preInput();
        if (typeof args.text !== 'string') throw helperError(ERROR_CODES.BAD_ARGS, 'text is required');
        const mode = args.mode ?? 'unicode';
        if (mode !== 'unicode' && mode !== 'keys') throw helperError(ERROR_CODES.BAD_ARGS, "mode must be 'unicode' or 'keys'");
        const target = keyboardGuard(true, 'type');
        const why = await wait(delayFor(cmd), myGen, { userInput: true });
        if (why === 'abort') return { typed: 0, interrupted: 'abort' };
        if (why === 'user_input') return { typed: 0, interrupted: 'user_input' };
        record({ cmd, text: args.text, mode, target });
        return { typed: args.text.length };
      }

      case 'key':
      case 'hold_key': {
        preInput();
        const combo = parseComboLite(args.combo);
        const target = keyboardGuard(combo.needsSecureCheck, cmd);
        const holdMs = cmd === 'hold_key' ? clamp(isNum(args.durationMs) ? args.durationMs : 500, 0, 30000) : 0;
        if ((await wait(delayFor(cmd) + holdMs, myGen)) === 'abort') throw helperError(ERROR_CODES.ABORTED, 'the action was aborted');
        record({ cmd, combo: args.combo, mods: combo.mods, key: combo.key, repeat: cmd === 'key' ? Math.max(1, Math.round(args.repeat || 1)) : 1, holdMs, target });
        return { target };
      }

      case 'probe_point': {
        requireTrusted();
        const p = point(args);
        requireOnScreen(p);
        return probeAt(p.x, p.y);
      }

      case 'probe_focus':
        requireTrusted();
        return focusProbe().probe;

      case 'apps':
        return state.apps.map((a) => ({
          pid: a.pid, bundleId: a.bundleId ?? null, name: a.name ?? null, active: a.pid === state.frontmostPid,
          hidden: !!a.hidden, path: a.path ?? null,
        }));

      case 'windows': {
        const onScreenOnly = args.onScreenOnly !== false;
        return state.windows
          .filter((w) => (!onScreenOnly || w.onScreen !== false) && (!isNum(args.pid) || w.pid === args.pid))
          .map((w) => {
            const a = appByPid(w.pid);
            return {
              windowId: w.windowId, pid: w.pid, app: w.app ?? a?.name ?? null, bundleId: w.bundleId ?? a?.bundleId ?? null,
              title: w.title ?? null, bounds: clone(w.bounds), layer: w.layer ?? 0, onScreen: w.onScreen !== false,
            };
          });
      }

      case 'open_app': {
        requireNotLatched();
        requireUnlocked();
        const { bundleId, name } = args;
        if (!bundleId && !name) throw helperError(ERROR_CODES.BAD_ARGS, 'bundleId or name is required');
        if (bundleId != null) validateAppToken(bundleId, 'bundleId');
        if (name != null) validateAppToken(name, 'name');
        const pool = [...state.apps, ...state.installedApps];
        const app = bundleId ? pool.find((a) => sameId(a.bundleId, bundleId)) : pool.find((a) => sameId(a.name, name));
        if (!app) throw helperError(ERROR_CODES.APP_NOT_FOUND, `no application ${bundleId || name}`, { bundleId: bundleId ?? null, name: name ?? null });
        checkGuard({ bundleId: app.bundleId ?? null, app: app.name ?? null }, 'open_app');
        await pause(cmd, myGen);
        let running = state.apps.find((a) => sameId(a.bundleId, app.bundleId));
        if (!running) {
          running = { pid: nextPid++, bundleId: app.bundleId, name: app.name, hidden: false, path: app.path ?? null };
          state.apps.push(running);
        }
        state.frontmostPid = running.pid;
        record({ cmd, bundleId: running.bundleId, pid: running.pid });
        return { pid: running.pid, bundleId: running.bundleId ?? null };
      }

      case 'focus_app': {
        requireNotLatched();
        requireUnlocked();
        let app = null;
        let win = null;
        if (isNum(args.windowId)) win = state.windows.find((w) => w.windowId === args.windowId) || null;
        if (isNum(args.pid)) app = appByPid(args.pid);
        else if (args.bundleId) app = state.apps.find((a) => sameId(a.bundleId, args.bundleId)) || null;
        else if (win) app = appByPid(win.pid);
        if (!app) throw helperError(ERROR_CODES.APP_NOT_FOUND, 'no running application matches', clone(args));
        checkGuard({ pid: app.pid, bundleId: app.bundleId ?? null, app: app.name ?? null, windowId: win?.windowId ?? null, windowTitle: win?.title ?? null }, 'focus_app');
        await pause(cmd, myGen);
        state.frontmostPid = app.pid;
        if (win && win.pid === app.pid) state.windows = [win, ...state.windows.filter((w) => w !== win)];
        record({ cmd, pid: app.pid, windowId: win?.windowId ?? null });
        return { pid: app.pid, bundleId: app.bundleId ?? null, frontmost: true };
      }

      case 'ax_snapshot': {
        await pause(cmd, myGen);
        return axSnapshot(args);
      }

      case 'ax_action': {
        // The helper's order: preInput → lookup → probe → guard (fresh window title)
        // → password field → verify → the action, with nothing in between the last two.
        preInput();
        if (!args.snapshotId || !args.ref) throw helperError(ERROR_CODES.BAD_ARGS, 'snapshotId and ref are required');
        const action = args.action ?? 'press';
        const verify = args.verify == null ? null : normalizeVerify(args.verify, action);
        const item = axLookup(args.snapshotId, args.ref);
        await pause(cmd, myGen); // the AX round trips; from here on nothing is awaited
        const live = axResolve(item, args.snapshotId, args.ref);
        const target = elementProbe(live.win, live.node);
        checkGuard(target, 'ax_action');
        if (action === 'set_value' && state.config.guard.secureField !== false && target.secure) {
          throw helperError(ERROR_CODES.SECURE_FIELD, 'refusing to set the value of a password field', { probe: target });
        }
        if (verify) {
          const field = compareVerify(verify, verifyFacts(live));
          if (field) {
            throw helperError(ERROR_CODES.TARGET_CHANGED, `the target is no longer what the snapshot showed (${field}); nothing was pressed`, { field, probe: target });
          }
        }
        if (!AX_ACTIONS.has(action)) throw helperError(ERROR_CODES.BAD_ARGS, `unknown action '${action}'`);
        if (action === 'set_value') {
          if (!('value' in args)) throw helperError(ERROR_CODES.BAD_ARGS, 'value is required for set_value');
          live.node.value = args.value;
        }
        record({ cmd, snapshotId: args.snapshotId, ref: args.ref, action, value: action === 'set_value' ? args.value : undefined, verified: !!verify, target });
        return { target };
      }

      case 'abort':
        doAbort();
        return {};

      case 'panic':
        doAbort();
        state.panics += 1;
        return {};

      case 'power':
        if (typeof args.holdDisplayAwake !== 'boolean') throw helperError(ERROR_CODES.BAD_ARGS, 'holdDisplayAwake is required');
        state.power = args.holdDisplayAwake;
        return {};

      case 'shutdown':
        setImmediate(() => exit(0, null)); // after the reply is on its way
        return {};

      // ── test hooks ──
      case '__fake_state':
        return snapshotState();

      case '__fake_set':
        applySet(args);
        return {};

      case '__fake_emit':
        if (args.event && typeof args.event === 'object') emit(clone(args.event));
        return {};

      case '__fake_simulate':
        simulate(args);
        return {};

      case '__fake_crash':
        exit(isNum(args.code) ? args.code : 1, null);
        return new Promise(() => {}); // dies without answering

      case '__fake_hang':
        return new Promise(() => {}); // a wedged action: the queue behind it never moves

      default:
        throw helperError(ERROR_CODES.UNSUPPORTED, `unknown command '${cmd}'`);
    }
  }

  function snapshotState() {
    return clone({
      pid,
      received: state.received,
      actions: state.actions,
      config: state.config,
      latched: state.latched,
      locked: state.locked,
      secureFocus: state.secureFocus,
      frontmostPid: state.frontmostPid,
      cursor: state.cursor,
      held: { buttons: [...state.held.buttons], keys: [...state.held.keys] },
      power: state.power,
      aborts: state.aborts,
      panics: state.panics,
      snapshots: state.snapshots.map((s) => s.id),
    });
  }

  function applySet(args = {}) {
    if (args.permissions && typeof args.permissions === 'object') {
      state.permissions = { ...state.permissions, ...args.permissions };
      emit({ event: 'permissions_changed', permissions: { ...state.permissions, responsibleApp: clone(state.responsibleApp) } });
    }
    if (typeof args.locked === 'boolean' && args.locked !== state.locked) {
      state.locked = args.locked;
      emit({ event: 'screen_lock', locked: state.locked });
    }
    for (const key of ['onConsole', 'secureInput', 'secureFocus', 'focusUnreadable', 'latched']) {
      if (typeof args[key] === 'boolean') state[key] = args[key];
    }
    if (isNum(args.frontmostPid)) state.frontmostPid = args.frontmostPid;
    if (args.cursor && isNum(args.cursor.x) && isNum(args.cursor.y)) state.cursor = { x: args.cursor.x, y: args.cursor.y };
    if ('delayMs' in args) state.delayMs = clone(args.delayMs) ?? 0;
    if ('focus' in args) state.focus = clone(args.focus);
    if (Array.isArray(args.apps)) state.apps = clone(args.apps);
    if (Array.isArray(args.windows)) state.windows = clone(args.windows);
    if (args.axTrees && typeof args.axTrees === 'object') state.axTrees = { ...state.axTrees, ...clone(args.axTrees) };
    if (Array.isArray(args.axPatch)) {
      for (const change of args.axPatch) {
        const id = change?.id;
        let node = null;
        for (const tree of Object.values(state.axTrees)) {
          const path = id == null ? null : findPath(tree, { id });
          if (path) { node = path[path.length - 1]; break; }
        }
        if (!node) throw helperError(ERROR_CODES.BAD_ARGS, `axPatch: no fixture node has id ${JSON.stringify(id)}`);
        Object.assign(node, clone(change.patch || {}));
      }
    }
    if (Array.isArray(args.displays)) {
      state.displays = clone(args.displays);
      emit({ event: 'displays_changed', displays: clone(state.displays) });
    }
  }

  /** User input as the helper's global monitor sees it. */
  function simulate({ kind = 'mouse', x, y } = {}) {
    if (closed) return;
    const pos = { x: isNum(x) ? x : state.cursor.x, y: isNum(y) ? y : state.cursor.y };
    if (kind === 'corner') {
      pos.x = 0;
      pos.y = 0;
    }
    const isKey = kind === 'key' || kind === 'esc';
    if (!isKey && kind !== 'scroll') state.cursor = { ...pos };
    if (isKey || kind === 'click') {
      for (const w of [...waiters]) if (w.userInput) w.resolve('user_input');
    }
    const m = state.config.monitor;
    if (m.armed) {
      if (kind === 'esc' && m.esc !== false) emergencyStop('esc');
      if (!isKey && m.failsafeCorner !== false) {
        const s = m.cornerSizePt ?? 4;
        const within = pos.x >= 0 && pos.y >= 0 && pos.x < s && pos.y < s;
        if (within && !state.inCorner) emergencyStop('failsafe_corner');
        state.inCorner = within;
      }
    } else {
      state.inCorner = false;
    }
    const now = Date.now();
    if (now - lastUserInputAt >= userInputIntervalMs) {
      lastUserInputAt = now;
      emit({ event: 'user_input', kind: isKey ? 'key' : kind === 'scroll' ? 'scroll' : 'mouse', x: pos.x, y: pos.y });
    }
  }

  async function run(id, cmd, args) {
    const myGen = gen;
    try {
      if (!SELF_PACED.has(cmd)) await pause(cmd, myGen);
      const result = await execute(cmd, args || {}, myGen);
      return closed ? null : { id, ok: true, result };
    } catch (err) {
      if (closed) return null;
      const error = { code: err?.code && ERROR_CODES[err.code] ? err.code : ERROR_CODES.INTERNAL, message: err?.message || String(err) };
      if (err?.details !== undefined) error.details = err.details;
      return { id, ok: false, error };
    }
  }

  /** One request object → Promise of its reply object (null once the "process" is gone). */
  function handle(req) {
    if (closed) return new Promise(() => {});
    const { id = null, cmd, args } = req || {};
    state.received.push({ id, cmd, args: clone(args ?? {}) });
    if (typeof cmd !== 'string' || !cmd) {
      return Promise.resolve({ id, ok: false, error: { code: ERROR_CODES.BAD_ARGS, message: 'cmd is required' } });
    }
    if (BYPASS.has(cmd) || TEST_BYPASS.has(cmd)) return run(id, cmd, args);
    const reply = chain.then(() => run(id, cmd, args));
    chain = reply.then(() => {}, () => {});
    return reply;
  }

  return {
    handle,
    on,
    onExit,
    emit,
    start,
    close,
    simulate,
    readyEvent,
    setLocked: (locked) => applySet({ locked: !!locked }),
    get state() { return state; },
    get pid() { return pid; },
    get closed() { return closed; },
  };
}

// ── Runnable mode: `node fake-helper.js` speaks the protocol on stdio ──
function runStdio() {
  let options = {};
  try {
    options = JSON.parse(process.env.SYNABUN_FAKE_HELPER_OPTIONS || '{}') || {};
  } catch (err) {
    process.stderr.write(`fake-helper: ignoring invalid SYNABUN_FAKE_HELPER_OPTIONS (${err.message})\n`);
  }
  const core = createFakeHelperCore({ ...options, pid: process.pid, env: process.env });
  let exiting = false;
  const write = (obj) => {
    if (obj && !exiting) process.stdout.write(encodeMessage(obj));
  };
  core.on(write);
  core.onExit(({ code }) => {
    exiting = true;
    process.stdout.write('', () => process.exit(code ?? 0));
  });
  const parser = createLineParser((msg) => {
    core.handle(msg).then(write, (err) => process.stderr.write(`fake-helper: ${err?.message || err}\n`));
  }, { onError: (err) => process.stderr.write(`fake-helper: ${err.message}\n`) });
  process.stdin.on('data', (chunk) => parser.push(chunk));
  process.stdin.on('end', () => core.close({ code: 0, signal: null }));
  process.on('SIGTERM', () => core.close({ code: 0, signal: null }));
  process.stderr.write(`fake-helper: pid ${process.pid} starting\n`);
  core.start();
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) runStdio();
