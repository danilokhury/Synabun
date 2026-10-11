// ═══════════════════════════════════════════
// SynaBun — browser screenshots (browser_screenshot)
// ═══════════════════════════════════════════
//
// Breakpoint and full-page captures of a SynaBun browser tab, optionally saved
// as a file, so visual checks never need a browser of the agent's own.
//
// A viewport size is a CDP device-metrics override sent from a CDP session opened
// for this capture only. Chromium keeps one override per page, and detaching the
// session does not remove it, so it is always cleared explicitly when the capture
// ends — on errors and timeouts too — and the tab's innerWidth, innerHeight and
// devicePixelRatio are read again against the values from before the capture. A
// clear that fails, hangs or does not take is sent once more from a fresh CDP
// session; a tab still not confirmed is retired (viewportRestored: false):
// server.js takes it out of routing at once and closes it, so a MoreLogin tab
// never keeps a size, DPR or mobile flag its profile does not have.
//
// Measured in stock Chromium 147 with a real window (tests/browser-screenshot-
// window.browser.mjs), not yet on a MoreLogin browser: Page.captureScreenshot got
// no answer for the selected tab of a window that was minimized or whose
// application was hidden, for as long as it was waited on, while background tabs
// of that window were captured. The page cannot tell (visibilityState stays
// visible, requestAnimationFrame keeps firing), and for a capture with a clip
// Chromium has by then resized the tab's view to the clip (64x64 for the scale
// measurement) and puts the size back only when the capture answers. So every
// capture first sends one capture without a clip, which resizes nothing: no
// answer in time is reported as such, with the window state CDP reports, and the
// tab is untouched. A capture that stops answering later is cut short with the
// name of its phase, and the view is put back with Emulation.setVisibleSize. The
// page reads the clip's size only once the capture's CDP session is gone (its own
// emulation hides it until then; measured, about 2 ms after the detach answers, 2.2 ms seen),
// so the tab is confirmed after the detach, on two readings 150 ms apart.
//
// One capture runs per tab at a time, and one budget (the request deadline)
// covers the capture and putting the tab back: the answer never waits past it.
// A capture the browser never answered, on a CDP session that could not be
// confirmed detached, may still be pending: its tab is not given to the next
// capture until one of the two ends, and is retired if neither does.

import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { getDataHome, pathIsInside } from '../../lib/paths.js';
import { readRegisteredProjects } from './remote-policy.js';

export const SCREENSHOT_MIN_SIZE = 100;
export const SCREENSHOT_MAX_SIZE = 4096;
// Chromium's largest capturable bitmap edge: a longer page is cut here (truncated: true).
const MAX_CAPTURE_EDGE = 16384;
// Model APIs refuse an image edge over 8000 px; the returned image stays under it.
const MAX_INLINE_EDGE = 7900;
const DEFAULT_MAX_WIDTH = 1024;
const DEFAULT_QUALITY = 60;
const DEFAULT_FILE_QUALITY = 90;
const SETTLE_MS = 150;

export class ScreenshotRequestError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const flag = (value) => value === true || TRUE.has(String(value ?? '').toLowerCase());

function sizeParam(query, name) {
  const raw = query?.[name];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < SCREENSHOT_MIN_SIZE || value > SCREENSHOT_MAX_SIZE) {
    throw new ScreenshotRequestError(`${name} must be a whole number of CSS pixels from ${SCREENSHOT_MIN_SIZE} to ${SCREENSHOT_MAX_SIZE}`);
  }
  return value;
}

/** The format a file name asks for, or null. */
export function formatOfPath(path) {
  const match = /\.(png|jpe?g)$/i.exec(String(path || ''));
  if (!match) return null;
  return match[1].toLowerCase() === 'png' ? 'png' : 'jpeg';
}

/**
 * The query of GET …/screenshot-base64 as capture options. Throws
 * ScreenshotRequestError (400) on a bad size, format or path.
 */
export function parseScreenshotOptions(query = {}) {
  const maxWidthRaw = parseInt(query.maxWidth, 10);
  const maxWidth = Number.isNaN(maxWidthRaw) ? DEFAULT_MAX_WIDTH : Math.max(0, maxWidthRaw); // 0 = native resolution
  const qualityRaw = parseInt(query.quality, 10);
  const quality = Number.isNaN(qualityRaw) ? null : Math.min(100, Math.max(10, qualityRaw));
  let format = query.format ? String(query.format).toLowerCase() : null;
  if (format === 'jpg') format = 'jpeg';
  if (format && format !== 'png' && format !== 'jpeg') throw new ScreenshotRequestError('format must be png or jpeg');
  const path = typeof query.path === 'string' && query.path.trim() ? query.path.trim() : null;
  const save = flag(query.save) || !!path;
  if (path) {
    const fromName = formatOfPath(path);
    if (!fromName) throw new ScreenshotRequestError('path must end in .png, .jpg or .jpeg');
    if (format && format !== fromName) throw new ScreenshotRequestError(`path ends in ${basename(path).split('.').pop()} but format is ${format}`);
    format = format || fromName;
  }
  return {
    width: sizeParam(query, 'width'),
    height: sizeParam(query, 'height'),
    fullPage: flag(query.fullPage),
    maxWidth,
    quality: quality ?? DEFAULT_QUALITY,
    // The returned image is a JPEG as always, unless PNG was asked for.
    inlineFormat: format === 'png' ? 'png' : 'jpeg',
    // A saved file is a PNG unless JPEG was asked for (format or file name).
    fileFormat: save ? (format || 'png') : null,
    fileQuality: quality ?? DEFAULT_FILE_QUALITY,
    save,
    path,
  };
}

// ── where a file may go ─────────────────────────────────────────────────────

/** ~/.synabun/data/media/screenshots */
export function screenshotsDir(dataHome = getDataHome()) {
  return resolve(dataHome, 'data', 'media', 'screenshots');
}

// The real path of `path`: its deepest existing ancestor resolved through
// symlinks, plus the parts that do not exist yet (/tmp → /private/tmp on macOS).
function realTarget(path) {
  let current = resolve(path);
  const rest = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try { real = realpathSync(current); } catch { /* keep the lexical path */ }
  return join(real, ...rest);
}

function isImageFile(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(8);
    const read = readSync(fd, head, 0, 8, 0);
    const png = read >= 8 && head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = read >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    return png || jpeg;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

// An existing target may only be a PNG or JPEG file, never a folder, a link or anything else.
function existingTargetRefusal(path) {
  let stat;
  try { stat = lstatSync(path); } catch { return null; }
  if (stat.isSymbolicLink()) return `${path} is a symbolic link; pick another file name`;
  if (!stat.isFile()) return `${path} exists and is not a file`;
  if (!isImageFile(path)) return `${path} exists and is not a PNG or JPEG image, so it was not overwritten`;
  return null;
}

/** The real folders a screenshot may be saved in: the screenshots folder and every registered project below the home folder. */
function screenshotRoots({ dataHome, registeredProjects, home }) {
  const realHome = realTarget(home);
  const roots = [realTarget(screenshotsDir(dataHome))];
  for (const project of registeredProjects || []) {
    if (!project || !isAbsolute(String(project))) continue;
    const real = realTarget(String(project));
    if (pathIsInside(realHome, real)) continue; // a "project" at or above $HOME never counts
    roots.push(real);
  }
  return roots;
}
const outsideRoots = (path, dataHome) => `${path} is outside SynaBun's registered projects and ${screenshotsDir(dataHome)}; save inside a project or leave path out`;

/**
 * Why an explicit `path` may not receive a screenshot, or null. It must be
 * absolute, end in .png / .jpg / .jpeg, lie inside a registered project (never
 * one at or above the home folder) or the screenshots folder, and never replace
 * anything but an image. writeScreenshotFile checks again when it writes.
 */
export function screenshotPathRefusal(path, { dataHome = getDataHome(), registeredProjects = readRegisteredProjects({ dataHome }), home = homedir() } = {}) {
  if (typeof path !== 'string' || !path.trim()) return 'path must be a file path';
  if (!isAbsolute(path)) return `path must be absolute: ${path}`;
  if (!formatOfPath(path)) return 'path must end in .png, .jpg or .jpeg';
  const target = realTarget(path);
  if (!screenshotRoots({ dataHome, registeredProjects, home }).some((root) => pathIsInside(target, root))) return outsideRoots(path, dataHome);
  return existingTargetRefusal(resolve(path));
}

/** The default file: <screenshots>/<yyyy-mm-dd>/<host>-<width>x<height>-<hhmmss>.<png|jpg>, never an existing one. */
export function defaultScreenshotPath({ dataHome = getDataHome(), pageUrl, width, height, format = 'png', now = new Date() } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let host = '';
  try { host = new URL(pageUrl).host; } catch { /* about:blank and the like */ }
  host = host.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'page';
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  const dir = join(screenshotsDir(dataHome), day);
  const stem = `${host}-${width}x${height}-${time}`;
  let file = join(dir, `${stem}.${ext}`);
  for (let n = 2; existsSync(file); n += 1) file = join(dir, `${stem}-${n}.${ext}`);
  return file;
}

// A new temp file only: never an existing one, never through a symlink (0 where the platform lacks O_NOFOLLOW).
const CREATE_NEW = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0);

/**
 * Write the image at `path`, checked again now: a capture can take a minute
 * after screenshotPathRefusal said yes. The parent folders are created, then the
 * parent's real path must still lie inside an allowed folder (the same rule), a
 * symlink or a non-image at the file's name is refused, and the bytes go to a
 * temp file created in that real folder (O_CREAT | O_EXCL | O_NOFOLLOW) and
 * renamed over the name there. The folder's real path is read again before the
 * rename (a component swapped for a symlink meanwhile refuses the write), and a
 * rename replaces a symlink at the name rather than following it. Returns the
 * real path written.
 */
export function writeScreenshotFile(path, bytes, { dataHome = getDataHome(), registeredProjects = readRegisteredProjects({ dataHome }), home = homedir() } = {}) {
  const wanted = resolve(path);
  mkdirSync(dirname(wanted), { recursive: true });
  const folder = realpathSync(dirname(wanted));
  const target = join(folder, basename(wanted));
  if (!screenshotRoots({ dataHome, registeredProjects, home }).some((root) => pathIsInside(target, root))) throw new ScreenshotRequestError(outsideRoots(path, dataHome));
  const refusal = existingTargetRefusal(target);
  if (refusal) throw new ScreenshotRequestError(refusal);
  const tmp = join(folder, `.${basename(wanted)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  let fd;
  try {
    fd = openSync(tmp, CREATE_NEW, 0o644);
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    closeSync(fd);
    fd = undefined;
    if (realpathSync(dirname(wanted)) !== folder) throw new ScreenshotRequestError(`${path} changed while the screenshot was taken (its folder is now elsewhere); nothing was saved`);
    const late = existingTargetRefusal(target);
    if (late) throw new ScreenshotRequestError(late);
    renameSync(tmp, target);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { if (lstatSync(tmp).isFile()) unlinkSync(tmp); } catch {}
    throw error;
  }
  return target;
}

// ── capture ─────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
// `promise`, or a rejection after `ms`. `late(value)` gets a value that arrives
// after the wait was given up, so what it names (a CDP session) is not left behind.
const within = (promise, ms, what, late = null) => {
  let timer;
  let over = false;
  const watched = Promise.resolve(promise);
  if (late) watched.then((value) => { if (over) Promise.resolve().then(() => late(value)).catch(() => {}); }, () => {});
  return Promise.race([watched, new Promise((_, fail) => { timer = setTimeout(() => { over = true; fail(new Error(`${what} timed out`)); }, ms); })]).finally(() => clearTimeout(timer));
};
// The longest one clear, one fresh CDP session or one viewport read may take.
// Every such wait is a slice of the capture's one budget (stepUntil), never more.
const RESTORE_STEP_MS = 2000;
// How long the browser gets to present one frame before a capture gives up.
const PRESENT_TIMEOUT_MS = 8000;
// The selected tab of a minimized window presents nothing; a background tab of it
// does, at once. This long to tell them apart.
const MINIMIZED_GRACE_MS = 1500;
// The budget of a capture whose caller names no deadline.
const DEFAULT_BUDGET_MS = 60_000;
// The part of the budget kept back for putting the tab's viewport back: a capture
// still working that long before the deadline is given up on (half of a budget
// under twice this).
const RECOVERY_SHARE_MS = 4000;
// Putting the viewport back never takes longer than this, however far the deadline is.
const RECOVERY_CAP_MS = 10_000;
// How long the answer waits to hear that a retired tab closed (never past the deadline).
const CLOSE_CONFIRM_MS = 3000;
// How long a tab stays kept from the next capture while an unanswered capture of it may
// still be pending (its CDP session was not confirmed detached); after that it is retired.
const PENDING_HOLD_MS = 60_000;

/** What is left of a wait that ends at `until`, at most `cap`; 1 ms once it is over, so the step fails at once. */
const stepUntil = (until, cap = RESTORE_STEP_MS) => Math.max(1, Math.min(cap, until - Date.now()));
const seconds = (ms) => `${Math.max(0.1, Math.round(ms / 100) / 10)} s`;
/** A CDP session not confirmed detached may still be attached in the browser: recorded, never dropped silently. */
const detachFailed = (what, error) => {
  try { console.warn(`[browser] screenshot: ${what} was not confirmed detached and may still be attached: ${error?.message ?? error}`); } catch { /* nothing left to tell */ }
};
/**
 * Detach `session`. `confirmed` settles true or false within the wait (never
 * past `until`); `eventually` settles true when the browser does answer, however
 * late, and false when it refuses. A detach refused or not answered in time is
 * recorded.
 */
function letGo(session, until, what) {
  const eventually = Promise.resolve().then(() => session.detach()).then(() => true, (error) => { detachFailed(what, error); return false; });
  const confirmed = within(eventually, stepUntil(until), 'detaching').catch((error) => { detachFailed(what, error); return false; });
  return { confirmed, eventually };
}
const detachWithin = (session, until, what) => letGo(session, until, what).confirmed;
/** A CDP session nobody will use (it arrived after its wait was given up): detached, and a failure recorded. */
const discard = (session, what) => Promise.resolve().then(() => session?.detach?.()).catch((error) => detachFailed(what, error));
const openSession = (newSession, until) => within(Promise.resolve().then(newSession), stepUntil(until), 'opening a CDP session', (session) => discard(session, 'a CDP session that arrived after its wait was given up'));

// What a capture is doing, for the error of one that is cut short.
const PHASES = {
  queue: 'waiting for an earlier screenshot of this tab to finish',
  session: 'opening a CDP session',
  viewport: 'reading the tab\'s viewport',
  present: 'waiting for the answer to its first capture (the one without a clip)',
  layout: 'reading the page layout',
  emulate: 'setting the viewport size',
  calibrate: 'measuring the capture scale',
  file: 'capturing the image for the file',
  capture: 'capturing the image',
};
/**
 * The window state CDP reported for a failure: the one read when the capture
 * stopped, and the one read when it began whenever that is another (a state that
 * could not be read is `unknown`, never the other reading).
 */
const windowWords = (atStop, atStart) => (atStop === atStart ? atStop || 'unknown' : `${atStop || 'unknown'} when it stopped, ${atStart || 'unknown'} when it began`);
/** What was measured when a capture stopped: its phase, how long it was in it and the window state CDP reported. */
const measured = (phase, waitedMs, windowState, windowAtStart = windowState) => `phase ${phase}, ${seconds(waitedMs)} in it; window state from CDP: ${windowWords(windowState || null, windowAtStart || null)}`;

/**
 * The first capture, sent without a clip, got no answer in the time it was
 * given; nothing that resizes the tab was sent. The message says what was
 * measured (the command without an answer, the phase, the wait, the window state
 * CDP reported when the capture began and when it stopped) and, for a minimized
 * window, the one behaviour that was measured in Chromium 147; it names no other
 * cause.
 */
export class ScreenshotStalledError extends Error {
  constructor(windowState, waitedMs, windowAtStart = windowState) {
    super(`No screenshot: the screenshot command (Page.captureScreenshot, sent without a clip) got no answer in the time it was given (${measured('present', waitedMs, windowState, windowAtStart)}). The tab was not resized. ${windowState === 'minimized' || windowAtStart === 'minimized'
      ? 'Measured in Chromium 147: a capture of the selected tab of a minimized window gets no answer until the window is restored, and captures of its other tabs do. Restore the window (it may stay behind other windows) and take the screenshot again.'
      : 'CDP does not report a hidden application, and in Chromium 147 a capture of the selected tab of a hidden application\'s window gets no answer either; no other cause was measured. Check that the browser window is on screen and take the screenshot again.'}`);
    this.status = 503;
    this.code = 'SCREENSHOT_NOT_PRESENTING';
    this.phase = 'present';
    this.windowState = windowState || null;
    this.windowAtStart = windowAtStart || null;
  }
}

/** An earlier screenshot of this tab was cut short and the tab is still being put back at its own size: nothing was sent. */
export class ScreenshotTabRecoveringError extends Error {
  constructor(recovering) {
    super(`No screenshot: this tab is being put back at its own size after a screenshot that stopped while ${PHASES[recovering.phase] || recovering.phase} ${seconds(Date.now() - recovering.since)} ago (phase recover). Nothing was sent to the tab; take the screenshot again in a few seconds.`);
    this.status = 503;
    this.code = 'SCREENSHOT_TAB_RECOVERING';
    this.phase = 'recover';
  }
}

/**
 * An earlier screenshot of this tab got no answer and its CDP session could not
 * be confirmed detached, so that capture may still be pending in the browser:
 * nothing was sent, and no second capture is started next to it.
 */
export class ScreenshotPendingError extends Error {
  constructor(pending) {
    super(`No screenshot: an earlier screenshot of this tab got no answer while ${PHASES[pending.phase] || pending.phase} ${seconds(Date.now() - pending.since)} ago, and its CDP session could not be confirmed detached, so it may still be pending in the browser (phase pending). Nothing was sent to the tab; take the screenshot again in a few seconds. A tab still in this state ${seconds(pending.holdMs)} after that screenshot is retired.`);
    this.status = 503;
    this.code = 'SCREENSHOT_CAPTURE_PENDING';
    this.phase = 'pending';
  }
}

/** The tab was retired after an earlier screenshot (its size could not be confirmed, or a capture of it may be pending for good): nothing was sent. */
export class ScreenshotTabRetiredError extends Error {
  constructor(retired) {
    super(retired.reason === 'pending'
      ? `No screenshot: this tab was retired ${seconds(Date.now() - retired.at)} ago: a screenshot that got no answer while ${PHASES[retired.phase] || retired.phase} may still be pending in the browser, and its CDP session was never confirmed detached (phase retired). Nothing was sent to the tab; the next browser call opens a fresh one.`
      : `No screenshot: this tab was retired ${seconds(Date.now() - retired.at)} ago, after a screenshot that stopped while ${PHASES[retired.phase] || retired.phase} left it at a size SynaBun could not confirm (phase retired). Nothing was sent to the tab; the next browser call opens a fresh one.`);
    this.status = 410;
    this.code = 'SCREENSHOT_TAB_RETIRED';
    this.phase = 'retired';
  }
}

// One capture per tab at a time: a second one would read, resize and restore the
// view under the first. A gate per page holds the queue (`tail` settles when every
// turn taken so far has been released), what a cut-short capture is still putting
// back (`recovering`), a capture that may still be pending in the browser
// (`pending`) and whether the tab was retired. It lives as long as the
// page object, so a waiter that gives up frees its own place and nothing else:
// whoever comes after it still waits for the capture that is active.
const gates = new WeakMap();
function gateOf(page) {
  let gate = gates.get(page);
  if (!gate) {
    gate = { tail: Promise.resolve(), holder: null, recovering: null, pending: null, retired: null, watchers: new Set() };
    gates.set(page, gate);
  }
  return gate;
}
function takeTurn(gate) {
  const previous = gate.tail;
  let release;
  const mine = new Promise((done) => { release = done; });
  gate.tail = previous.then(() => mine);
  return { ready: previous, release };
}
/** Those waiting for the tab's turn look at its gate again now (retired, or a capture that may still be pending). */
function wakeWaiters(gate) {
  for (const wake of gate.watchers) wake();
  gate.watchers.clear();
}
/** From now on no capture touches the tab: those waiting for it are told at once, later ones refused. */
function retireGate(gate, phase, reason = 'size') {
  if (gate.retired) return;
  gate.retired = { phase, reason, at: Date.now() };
  wakeWaiters(gate);
}

/** The tab's own viewport: innerWidth, innerHeight and devicePixelRatio as the page sees them. */
function readViewport(page, ms = RESTORE_STEP_MS) {
  return within(page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })), ms, 'reading the viewport');
}
const sameView = (now, before) => now.width === before.width && now.height === before.height && now.dpr === before.dpr;

/**
 * True when the tab reads the width, height and devicePixelRatio it had before
 * the capture (`before`). One reading that matches is enough after a capture
 * that answered; one that does not is taken once more SETTLE_MS later, for a
 * change still on its way. With `twice` (after a capture that failed with a
 * clip sent) two readings SETTLE_MS apart must both match, and a reading that
 * differs after one that matched is a tab that did not stay as it was. An
 * unreadable tab is not confirmed.
 */
async function viewportIs(page, before, until = Infinity, twice = false) {
  let matched = 0;
  for (let attempt = 0; attempt < (twice ? 3 : 2); attempt += 1) {
    if (attempt) {
      if (Date.now() + SETTLE_MS >= until) return false;
      await delay(SETTLE_MS);
    }
    let same = false;
    try {
      same = sameView(await readViewport(page, stepUntil(until)), before);
    } catch { /* unreadable: not confirmed */ }
    if (same) {
      matched += 1;
      if (!twice || matched === 2) return true;
    } else if (matched) {
      return false;
    }
  }
  return false;
}

// Chromium resizes a tab's view to the clip of a capture and puts the size back
// only when that capture answers. Emulation.setVisibleSize sets it directly, in
// DIP: CSS px times the page zoom. So the first size asked for is the CSS size;
// the second is corrected once in proportion to what the page then reads (the
// zoom), and after that only a pixel at a time, until width and height are
// exactly the tab's own. A view that does not follow that way is left alone:
// no size further from the tab's own is ever asked for twice.
async function resizeViewTo(page, session, before, until = Infinity) {
  const sized = (now) => now.width === before.width && now.height === before.height;
  const near = (got, want) => Math.abs(got - want) <= 2;
  const left = await readViewport(page, stepUntil(until));
  if (sized(left)) return true;
  let last = left;
  let width = before.width;
  let height = before.height;
  let scaled = false;
  for (let attempt = 0; attempt < 4 && Date.now() < until; attempt += 1) {
    await within(session.send('Emulation.setVisibleSize', { width, height }), stepUntil(until), 'resizing the view');
    let now = last;
    for (let read = 0; read < 4 && Date.now() < until; read += 1) {
      await delay(read ? SETTLE_MS : 20);
      now = await readViewport(page, stepUntil(until));
      if (sized(now)) return true;
      if (now.width !== last.width || now.height !== last.height) break;
    }
    // Not applied at all, or a reading no page zoom explains (25% to 500%): leave it.
    if (!attempt && now.width === left.width && now.height === left.height) return false;
    if (!(now.width > 0 && now.height > 0)) return false;
    const zoom = Math.max(width / now.width, height / now.height, now.width / width, now.height / height);
    if (zoom > 5.5) return false;
    if (!near(now.width, before.width) || !near(now.height, before.height)) {
      if (scaled) return false;
      scaled = true;
    }
    const next = (asked, got, want) => (got === want ? asked : near(got, want) ? asked + Math.sign(want - got) : Math.round(asked * want / got));
    width = next(width, now.width, before.width);
    height = next(height, now.height, before.height);
    last = now;
  }
  return false;
}

/**
 * After a capture with a clip that did not answer, once its CDP session is
 * detached (a pending capture holds the view at its size, and the page reads
 * that size only when the session is gone): put the tab's view back at `before`
 * if Chromium left it at the clip's size. True only when the tab then reads its
 * own width, height and devicePixelRatio on two readings SETTLE_MS apart (the
 * size showed about 2 ms after the detach answered: at most 1.8 ms in headless
 * Chromium, 20 of 20 detaches per run of browser-screenshot-stall.browser.mjs,
 * and 2.2 ms seen in a real minimized window); every wait ends at `until`, and
 * a budget too short for the second reading confirms nothing.
 */
export async function restoreViewSize(page, before, { newSession = () => page.context().newCDPSession(page), until = Infinity } = {}) {
  let now;
  try {
    now = await readViewport(page, stepUntil(until));
    if (sameView(now, before)) {
      if (Date.now() + SETTLE_MS >= until) return false;
      await delay(SETTLE_MS);
      now = await readViewport(page, stepUntil(until));
      if (sameView(now, before)) return true;
    }
  } catch {
    return false;
  }
  // Nothing here changes a devicePixelRatio: one that is not the tab's own stays unconfirmed.
  if (now.dpr !== before.dpr) return false;
  let fresh = null;
  try {
    fresh = await openSession(newSession, until);
    await resizeViewTo(page, fresh, before, until);
  } catch { /* checked below */ } finally {
    if (fresh) await detachWithin(fresh, until, 'the CDP session that put the view back');
  }
  // A size put back counts once it has stayed: two readings apart, not the one right after the resize.
  return viewportIs(page, before, until, true);
}

/**
 * Clear the device-metrics override and confirm the tab is back: innerWidth,
 * innerHeight and devicePixelRatio equal to what they were before the capture
 * (a reading that differs is taken once more SETTLE_MS later). A clear that
 * fails, hangs or does not take is sent once more from a fresh CDP session.
 * Chromium ignores a clear from a session that never set an override, so that
 * session first sets an empty one (0 width, height and scale: nothing
 * overridden). A view still at another size then is one a scaled clip resized
 * (the capture never answered): `release` detaches the capture's own session,
 * whose pending capture holds the view, and the fresh session sets the size
 * back. True when confirmed; every wait ends at `until`. After a capture that
 * failed with a clip sent, captureScreenshot does not stop at this: it confirms
 * the tab again once the capture's session is detached (restoreViewSize).
 */
export async function restoreViewport(page, cdp, before, { newSession = () => page.context().newCDPSession(page), release = async () => {}, until = Infinity } = {}) {
  const clear = (session) => within(session.send('Emulation.clearDeviceMetricsOverride'), stepUntil(until), 'clearing the viewport');
  const back = () => viewportIs(page, before, until);
  try { await clear(cdp); } catch { /* retried below */ }
  if (await back()) return true;
  let fresh = null;
  try {
    fresh = await openSession(newSession, until);
    await within(fresh.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 0, mobile: false }), stepUntil(until), 'resetting the viewport');
    await clear(fresh);
    if (!await back()) {
      await release();
      await resizeViewTo(page, fresh, before, until);
    }
  } catch { /* checked below */ } finally {
    if (fresh) await detachWithin(fresh, until, 'the CDP session that cleared the viewport');
  }
  return back();
}

// Two animation frames (bounded: a hidden tab may not paint), then a short pause
// for resize handlers and media-query transitions.
async function settleLayout(page) {
  const frames = page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))).catch(() => false);
  await Promise.race([frames, delay(500)]);
  await delay(SETTLE_MS);
}

/** The window state CDP reports for the tab's window (normal, minimized, maximized, fullscreen), or null. */
const readWindowState = (cdp, ms) => within(Promise.resolve().then(() => cdp.send('Browser.getWindowForTarget')), ms, 'reading the window state')
  .then((target) => target?.bounds?.windowState || null, () => null); // a browser without windows: unknown

// One capture without a clip, or word that it got no answer in time
// (ScreenshotStalledError). Unlike every later capture it resizes nothing: when
// it does not answer, the tab is exactly as it was. In a minimized window the
// answer comes at once or not at all, so it is not waited on for long.
// `windowRead` settles with the window state CDP reported when the capture began.
function presentedFrame(cdp, timeoutMs) {
  const started = Date.now();
  const windowRead = readWindowState(cdp, 1000);
  const frame = new Promise((done, fail) => {
    let timer = null;
    let over = false;
    const finish = (settle, value) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      settle(value);
    };
    cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1, optimizeForSpeed: true }).then(() => finish(done), (error) => finish(fail, error));
    windowRead.then((windowState) => {
      if (over) return;
      const allowed = windowState === 'minimized' ? Math.min(MINIMIZED_GRACE_MS, timeoutMs) : timeoutMs;
      timer = setTimeout(() => finish(fail, new ScreenshotStalledError(windowState, Date.now() - started)), Math.max(0, allowed - (Date.now() - started)));
    });
  });
  return { frame, windowRead };
}

// Device pixels per CSS pixel in this session's captures, measured: the width of
// a small corner shot. The page's devicePixelRatio can be a fingerprint value, and
// another client's DPR emulation does not apply to this session's captures.
async function captureScaleOf(cdp, visual) {
  const side = Math.max(1, Math.min(64, Math.floor(visual.clientWidth), Math.floor(visual.clientHeight)));
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', clip: { x: visual.pageX || 0, y: visual.pageY || 0, width: side, height: side, scale: 1 },
  });
  const width = Buffer.from(data, 'base64').readUInt32BE(16);
  return width > 0 ? width / side : 1;
}

/**
 * Capture `page`. `options` from parseScreenshotOptions.
 *
 * One budget, ending at `deadline` (epoch ms; 60 s from now when not given),
 * covers the capture and putting the tab back: the call has settled by then,
 * whatever the browser does. A capture still working RECOVERY_SHARE_MS before
 * it is given up on, with the phase it was in (`phase`, and in the message,
 * with the window state CDP reported); what is left goes to the viewport.
 * `runBounded(work)` may end the capture earlier (server.js: the request was
 * aborted); `presentTimeoutMs` is how long the browser gets to present a frame.
 *
 * Captures of one tab run one at a time, and the turn is held until everything
 * a capture started is over. A first capture (no clip) that gets no answer
 * throws ScreenshotStalledError and nothing that resizes the tab was sent. After
 * any other failure that sent an override or a clip, the tab is put back
 * (restoreViewport, restoreViewSize) and confirmed at the width, height and
 * devicePixelRatio it had, after a clip on two readings apart taken once the
 * capture's CDP session is detached; while that goes on, another call for the
 * tab is refused at once (ScreenshotTabRecoveringError). A tab not confirmed
 * when the capture answers, the deadline included, is retired: `retire(reason)`
 * is called at once (server.js takes it out of routing and closes it;
 * `{ closed }` settles true when the close was confirmed), every later call for
 * the page is refused (ScreenshotTabRetiredError), and the answer carries
 * `viewportRestored: false`, `tab: 'retired'` and `tabClosed`. A failure's `tab`
 * is otherwise 'untouched' or 'restored'.
 *
 * When the capture's CDP session cannot be confirmed detached, what it left
 * unanswered decides. The override or a capture with a clip: the browser may
 * still apply it, so the tab is not confirmed and is retired as above. A capture
 * without a clip: nothing can resize the tab, so it is kept, but its turn is not
 * released (`capturePending` on the error; other calls are refused at once with
 * ScreenshotPendingError) until that capture is answered or the detach is; a tab
 * still held after `pendingHoldMs` is retired (`retire('pending')`). Nothing
 * unanswered: the tab is given back and the session recorded as possibly left
 * attached.
 *
 * `onRecord` gets one record per call: { outcome: 'ok' | 'failed' | 'refused',
 * phase, code, windowState, windowAtStart, tab, tabClosed, ms } and
 * `capturePending: true` when the tab is held. `windowState` is what CDP
 * reported when the capture began; for a failure, what it reported when the
 * capture stopped (null when that could not be read, never the earlier reading).
 *
 * Returns the base64 image to show (downscaled to `maxWidth` unless 0, and
 * under 8000 px), the full-resolution file bytes when saving, the sizes and,
 * after an emulated size, `viewportRestored`.
 */
export async function captureScreenshot(page, options, {
  runBounded = (work) => work(),
  deadline = null,
  restore = restoreViewport,
  restoreSize = restoreViewSize,
  presentTimeoutMs = PRESENT_TIMEOUT_MS,
  pendingHoldMs = PENDING_HOLD_MS,
  retire = null,
  onRecord = null,
} = {}) {
  const started = Date.now();
  const until = Number.isFinite(deadline) ? deadline : started + DEFAULT_BUDGET_MS;
  const gate = gateOf(page);
  const run = {
    phase: 'queue', since: started, cdp: null, before: null,
    overrideSent: false,
    // A capture with a clip went out: Chromium resizes the view to the clip until it answers.
    clipSent: false,
    // Commands the browser has not answered yet: captures, and those that resize the tab (the override, a capture with a clip).
    captures: 0, resizing: 0, quiet: null,
    // Its unanswered capture may still be pending in the browser: the tab's turn is not released.
    pending: false,
    settled: false, finished: false,
    // The window state CDP reported when the capture began, and when it stopped (read for failures only).
    windowAtStart: null, windowAtStop: null, windowRead: null,
  };
  const record = (outcome, error = null, tab = 'untouched', tabClosed = null) => {
    try {
      onRecord?.({ outcome, phase: error?.phase ?? null, code: error?.code ?? null, windowState: outcome === 'failed' ? run.windowAtStop : run.windowAtStart, windowAtStart: run.windowAtStart, tab, tabClosed, ...(run.pending && { capturePending: true }), ms: Date.now() - started });
    } catch { /* a record that cannot be written never fails a capture */ }
  };
  if (gate.retired || gate.pending || gate.recovering) {
    const refusal = gate.retired ? new ScreenshotTabRetiredError(gate.retired) : gate.pending ? new ScreenshotPendingError(gate.pending) : new ScreenshotTabRecoveringError(gate.recovering);
    record('refused', refusal);
    throw refusal;
  }

  const turn = takeTurn(gate);
  const enter = (phase) => { run.phase = phase; run.since = Date.now(); };
  const cancelled = () => { if (run.settled) throw new Error('Screenshot cancelled'); };
  const work = async () => {
    try {
      // The turn, or word that the tab was retired, or is held for a capture that may still be pending, while this call waited for it.
      let wake;
      const told = new Promise((done) => { wake = done; });
      gate.watchers.add(wake);
      try { await Promise.race([turn.ready, told]); } finally { gate.watchers.delete(wake); }
      if (gate.retired) throw new ScreenshotTabRetiredError(gate.retired);
      if (gate.pending) throw new ScreenshotPendingError(gate.pending);
      cancelled();
      gate.holder = run;
      enter('session');
      const session = await page.context().newCDPSession(page);
      if (run.settled) {
        // Opened after the capture was given up on: nothing was sent through it.
        discard(session, 'a CDP session that arrived after its capture was given up on');
        cancelled();
      }
      run.cdp = session;
      // The capture's own commands: a capture, or a command that resizes the tab (the
      // override, a capture with a clip), is counted until the browser answers it.
      const cdp = {
        send: (...command) => {
          const [method, params] = command;
          const answer = session.send(...command);
          const capture = method === 'Page.captureScreenshot';
          const resizes = method === 'Emulation.setDeviceMetricsOverride' || (capture && !!params?.clip);
          if (capture || resizes) {
            if (capture) run.captures += 1;
            if (resizes) run.resizing += 1;
            const over = () => {
              if (capture) run.captures -= 1;
              if (resizes) run.resizing -= 1;
              if (!run.captures) run.quiet?.();
            };
            Promise.resolve(answer).then(over, over);
          }
          return answer;
        },
      };
      enter('viewport');
      // What the tab is put back to; unreadable, nothing is captured.
      run.before = await readViewport(page, 5000);
      cancelled();
      enter('present');
      const presented = presentedFrame(cdp, presentTimeoutMs);
      run.windowRead = presented.windowRead.then((state) => { run.windowAtStart = state; });
      await presented.frame;
      let emulated = null;
      if (options.width || options.height) {
        cancelled();
        enter('layout');
        const before = await cdp.send('Page.getLayoutMetrics');
        const layout = before.cssLayoutViewport || before.layoutViewport;
        emulated = {
          width: options.width || Math.round(layout.clientWidth),
          height: options.height || Math.round(layout.clientHeight),
        };
        // Checked and sent in one tick: once cleanup has begun, no override goes out.
        cancelled();
        enter('emulate');
        run.overrideSent = true;
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: emulated.width, height: emulated.height, deviceScaleFactor: 1, mobile: emulated.width < 768,
        });
        cancelled();
        await settleLayout(page);
      }
      // Given up on: nothing more is sent, a read included.
      cancelled();
      enter('layout');
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const visual = metrics.cssVisualViewport || metrics.visualViewport;
      const content = metrics.cssContentSize || metrics.contentSize;
      let dpr = 1;
      if (!emulated) {
        cancelled();
        enter('calibrate');
        run.clipSent = true;
        dpr = await captureScaleOf(cdp, visual);
      }
      let region;
      let scale;
      let truncated = false;
      if (options.fullPage) {
        const edge = Math.floor(MAX_CAPTURE_EDGE / dpr);
        const width = Math.max(1, Math.ceil(content.width));
        const height = Math.max(1, Math.ceil(content.height));
        truncated = height > edge || width > edge;
        region = { x: 0, y: 0, width: Math.min(width, edge), height: Math.min(height, edge) };
        scale = 1;
      } else {
        // What the tab shows: the visual viewport at its own zoom.
        const zoom = visual.scale || 1;
        region = { x: visual.pageX || 0, y: visual.pageY || 0, width: Math.max(1, Math.floor(visual.clientWidth)), height: Math.max(1, Math.floor(visual.clientHeight)) };
        scale = zoom;
      }
      const width = Math.round(region.width * scale);
      const height = Math.round(region.height * scale);
      const outWidth = width * dpr;
      const outHeight = height * dpr;
      const shrink = Math.min(1, options.maxWidth > 0 ? options.maxWidth / outWidth : 1, MAX_INLINE_EDGE / outWidth, MAX_INLINE_EDGE / outHeight);
      const shoot = async (format, quality, factor) => {
        cancelled();
        run.clipSent = true;
        const { data } = await cdp.send('Page.captureScreenshot', {
          format,
          ...(format === 'jpeg' && { quality }),
          clip: { ...region, scale: scale * factor },
          captureBeyondViewport: !!options.fullPage,
        });
        return data;
      };
      enter('file');
      const fileData = options.save ? await shoot(options.fileFormat, options.fileQuality, 1) : null;
      const reuse = fileData && shrink === 1 && options.inlineFormat === options.fileFormat;
      enter('capture');
      const data = reuse ? fileData : await shoot(options.inlineFormat, options.quality, shrink);
      return {
        data,
        mime: options.inlineFormat === 'png' ? 'image/png' : 'image/jpeg',
        width,
        height,
        imageWidth: Math.round(outWidth * shrink),
        imageHeight: Math.round(outHeight * shrink),
        fullPage: !!options.fullPage,
        truncated,
        emulated,
        fileData,
      };
    } finally {
      run.finished = true;
    }
  };

  let result = null;
  let failure = null;
  // Where the capture stood when it was over or given up on. From then on the
  // work sends nothing more: each command that resizes is checked and sent in one tick.
  let stopped = null;
  const stop = () => {
    if (stopped) return;
    run.settled = true;
    stopped = { phase: run.phase, waited: Date.now() - run.since, cut: !run.finished };
  };
  // true / false once the tab's viewport had to be confirmed, null when nothing that resizes went out.
  let restored = null;
  const resized = () => run.overrideSent || (!!failure && run.clipSent);

  const capture = async () => {
    const share = Math.min(RECOVERY_SHARE_MS, Math.max(0, until - started) / 2);
    let timer;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => runBounded(work)),
        new Promise((_, fail) => { timer = setTimeout(() => fail(Object.assign(new Error('no answer within the time the request allows'), { code: 'BROWSER_OPERATION_TIMEOUT', ownBudget: true })), Math.max(0, until - share - Date.now())); }),
      ]);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    stop();
  };
  // Settles when a tab held for a capture that may still be pending is given back or retired.
  let held = null;
  const putBack = async () => {
    const session = run.cdp;
    if (!session) return; // nothing was sent
    const stopAt = Math.min(until, Date.now() + RECOVERY_CAP_MS);
    // A capture cut short that may have resized the tab: until it is put back, other calls for it are refused at once.
    if (failure && resized()) gate.recovering = { run, phase: stopped.phase, since: Date.now() };
    // For the record of a failure, whatever its phase: what CDP reports of the window
    // now, next to what it reported when the capture began. Asked for before the
    // session is let go and kept as soon as it answers; waited for only when the
    // tab is back, so it takes nothing from the time the viewport gets.
    const windowNow = failure ? readWindowState(session, stepUntil(stopAt, 1000)).then((state) => { run.windowAtStop = state; }) : null;
    let letting = null;
    // True once the capture's CDP session is confirmed detached.
    const drop = () => { letting ||= letGo(session, stopAt, 'the capture\'s CDP session'); return letting.confirmed; };
    let detached = false;
    try {
      // Also when the capture timed out and is still pending: the clear goes out on
      // its own (a detach alone would leave the override on the page).
      if (run.overrideSent) restored = await restore(page, session, run.before, { release: drop, until: stopAt }) === true;
      detached = await drop();
      // A clip that did not answer: the view is at the clip's size, and the page reads
      // that size only once the capture's session is gone. So the tab is confirmed
      // from here, on two readings apart, whatever was read while it was attached.
      if (failure && run.clipSent && restored !== false) restored = await restoreSize(page, run.before, { until: stopAt }) === true;
    } catch {
      if (resized()) restored = false;
      detached = await drop();
    }
    if (!detached && run.resizing) {
      // The override or a clip still unanswered on a session that may still be
      // attached: the browser can apply it at any time. Nothing read now confirms the tab.
      restored = false;
    } else if (!detached && run.captures) {
      // A capture without a clip still unanswered on a session that may still be
      // attached: the browser may still be working on it, and nothing in it resizes
      // the tab. The tab is kept, and so is its turn: those waiting are told, later
      // callers refused, until the capture is answered or the detach is. A tab still
      // held after `pendingHoldMs` is retired: no screenshot of it would ever start again.
      run.pending = true;
      gate.pending = { run, phase: stopped.phase, since: Date.now(), holdMs: pendingHoldMs };
      wakeWaiters(gate);
      let holdTimer;
      held = Promise.race([
        new Promise((done) => { run.quiet = () => done('answered'); }),
        letting.eventually.then((gone) => (gone ? 'detached' : new Promise(() => {}))),
        new Promise((done) => { holdTimer = setTimeout(() => done('over'), pendingHoldMs); holdTimer.unref?.(); }),
      ]).then((how) => {
        clearTimeout(holdTimer);
        if (how !== 'over' || gate.retired) return;
        retireGate(gate, stopped.phase, 'pending');
        try { console.warn(`[browser] screenshot: a capture that got no answer while ${PHASES[stopped.phase]} was still unanswered, and its CDP session not confirmed detached, after ${seconds(pendingHoldMs)}: the tab is retired`); } catch { /* nothing left to tell */ }
        try { retire?.('pending'); } catch { /* out of this module's hands */ }
      });
    }
    // The window state the capture began with is an answer of a few ms; a browser that owes it is not waited on for long.
    if (run.windowRead) await Promise.race([run.windowRead, delay(failure ? stepUntil(stopAt, 1000) : 100)]);
    if (windowNow) await windowNow;
  };
  const everything = capture().then(putBack);
  // The tab's turn ends when everything this capture started is over, whoever still waits for its answer.
  everything.catch(() => {}).then(async () => {
    if (gate.recovering?.run === run) gate.recovering = null;
    if (held) {
      await held;
      if (gate.pending?.run === run) gate.pending = null;
    }
    if (gate.holder === run) gate.holder = null;
    turn.release();
  });

  // The answer: when all of it is over, or at the deadline with whatever is not.
  let timer;
  const inTime = await Promise.race([
    everything.then(() => true, () => true),
    new Promise((done) => { timer = setTimeout(() => done(false), Math.max(0, until - Date.now())); }),
  ]);
  clearTimeout(timer);
  if (!inTime) {
    if (!stopped && !failure) failure = Object.assign(new Error('no answer within the time the request allows'), { code: 'BROWSER_OPERATION_TIMEOUT', ownBudget: true });
    stop();
    // Not confirmed by now is not confirmed: the rest goes on without the caller.
    // (A tab already confirmed stays so; only its session is still being let go.)
    if (resized() && restored === null) restored = false;
  } else if (resized() && restored === null) {
    restored = false; // putting it back ended without a verdict: not confirmed
  }
  // What this call answers with, whatever the work or the cleanup still running sets later.
  const failed = failure;
  const shot = result;
  const unverified = restored === false;
  let tabClosed = null;
  if (unverified) {
    retireGate(gate, stopped.phase);
    let retiring = null;
    try { retiring = retire ? retire('size') : null; } catch { /* reported as not closed */ }
    tabClosed = false;
    if (retiring?.closed) {
      let closeTimer;
      tabClosed = await Promise.race([
        Promise.resolve(retiring.closed).then((closed) => closed === true, () => false),
        new Promise((done) => { closeTimer = setTimeout(() => done(false), Math.max(0, Math.min(CLOSE_CONFIRM_MS, until - Date.now()))); }),
      ]);
      clearTimeout(closeTimer);
    }
  }
  const tab = unverified ? 'retired' : restored === true ? 'restored' : 'untouched';

  if (failed) {
    const { phase, waited } = stopped;
    // What CDP reported of the window when the capture stopped (null when that was not read) and when it began.
    const { windowAtStop, windowAtStart } = run;
    let error = failed;
    if (phase === 'present' && (stopped.cut || failed instanceof ScreenshotStalledError)) {
      // The first capture got no answer, whoever stopped the wait: said with both window readings.
      error = new ScreenshotStalledError(windowAtStop, waited, windowAtStart);
    } else if (stopped.cut) {
      const earlier = phase === 'queue' && gate.holder && gate.holder !== run ? `; the earlier one is ${PHASES[gate.holder.phase]}` : '';
      error = new Error(`Screenshot timed out while ${PHASES[phase]} (${measured(phase, waited, windowAtStop, windowAtStart)}${earlier})${failed.ownBudget ? '' : `: ${failed.message}`}`);
      Object.assign(error, { code: failed.code, status: failed.status, phase });
    } else if (!(failed instanceof ScreenshotTabRetiredError || failed instanceof ScreenshotPendingError)) {
      error = new Error(`Screenshot failed while ${PHASES[phase]} (${measured(phase, waited, windowAtStop, windowAtStart)}): ${failed?.message ?? failed}`);
      Object.assign(error, { code: failed?.code, status: failed?.status, phase });
    }
    if (error !== failed) error.cause = failed;
    if (error.windowState === undefined) error.windowState = windowAtStop;
    if (error.windowAtStart === undefined) error.windowAtStart = windowAtStart;
    error.tab = tab;
    if (run.pending) {
      error.capturePending = true;
      error.message += ` Its CDP session could not be confirmed detached, so the capture may still be pending in the browser: until it is answered or the session detaches, other screenshots of this tab are refused (SCREENSHOT_CAPTURE_PENDING), and a tab still in that state after ${seconds(pendingHoldMs)} is retired.`;
    }
    if (unverified) Object.assign(error, { viewportRestored: false, tabClosed });
    record('failed', error, tab, tabClosed);
    throw error;
  }
  record('ok', null, tab, tabClosed);
  if (restored === null) return shot;
  return { ...shot, viewportRestored: restored, ...(unverified && { tab, tabClosed }) };
}
