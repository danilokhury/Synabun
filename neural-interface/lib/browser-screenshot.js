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
// ends — on errors and timeouts too — and the tab's innerWidth and
// devicePixelRatio are read again against the values from before the capture. A
// clear that fails, hangs or does not take is sent once more from a fresh CDP
// session; a tab still not confirmed is reported (viewportRestored: false) and
// server.js closes it, so a MoreLogin tab never keeps a size, DPR or mobile flag
// its profile does not have.

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
const within = (promise, ms, what) => Promise.race([promise, delay(ms).then(() => { throw new Error(`${what} timed out`); })]);
// How long one clear, one fresh CDP session or one viewport read may take.
const RESTORE_STEP_MS = 2000;

/** The tab's own viewport: innerWidth, innerHeight and devicePixelRatio as the page sees them. */
function readViewport(page) {
  return within(page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })), RESTORE_STEP_MS, 'reading the viewport');
}

/**
 * Clear the device-metrics override and confirm the tab is back: innerWidth
 * and devicePixelRatio equal to what they were before the capture (read twice,
 * a frame apart, for a resize still on its way). A clear that fails, hangs or
 * does not take is sent once more from a fresh CDP session. Chromium ignores a
 * clear from a session that never set an override, so that session first sets
 * an empty one (0 width, height and scale: nothing overridden). True when confirmed.
 */
export async function restoreViewport(page, cdp, before, { newSession = () => page.context().newCDPSession(page) } = {}) {
  const clear = (session) => within(session.send('Emulation.clearDeviceMetricsOverride'), RESTORE_STEP_MS, 'clearing the viewport');
  const back = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt) await delay(SETTLE_MS);
      try {
        const now = await readViewport(page);
        if (now.width === before.width && now.dpr === before.dpr) return true;
      } catch { /* unreadable: not confirmed */ }
    }
    return false;
  };
  try { await clear(cdp); } catch { /* retried below */ }
  if (await back()) return true;
  let fresh = null;
  try {
    fresh = await within(newSession(), RESTORE_STEP_MS, 'opening a CDP session');
    await within(fresh.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 0, mobile: false }), RESTORE_STEP_MS, 'resetting the viewport');
    await clear(fresh);
  } catch { /* checked below */ } finally {
    if (fresh) await within(fresh.detach(), RESTORE_STEP_MS, 'detaching').catch(() => {});
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
 * Capture `page`. `options` from parseScreenshotOptions. `runBounded(work)`
 * bounds the capture (server.js passes the request deadline); the override is
 * cleared, the tab's viewport confirmed (restoreViewport) and the CDP session
 * detached when it settles, even if the capture itself never answers. Returns
 * the base64 image to show (downscaled to `maxWidth` unless 0, and under 8000
 * px), the full-resolution file bytes when saving, the sizes and, after an
 * emulated size, `viewportRestored`. A capture that fails after an override the
 * restore could not confirm throws with `viewportRestored: false` too.
 */
export async function captureScreenshot(page, options, { runBounded = (work) => work(), restore = restoreViewport } = {}) {
  const cdp = await page.context().newCDPSession(page);
  let overrideSent = false;
  let settled = false;
  let viewportBefore = null;
  let result = null;
  let failure = null;
  try {
    result = await runBounded(async () => {
      let emulated = null;
      if (options.width || options.height) {
        const before = await cdp.send('Page.getLayoutMetrics');
        const layout = before.cssLayoutViewport || before.layoutViewport;
        emulated = {
          width: options.width || Math.round(layout.clientWidth),
          height: options.height || Math.round(layout.clientHeight),
        };
        // What the restore is confirmed against; unreadable, nothing is emulated.
        viewportBefore = await readViewport(page);
        // Checked and sent in one tick: once cleanup has begun, no override goes out.
        if (settled) throw new Error('Screenshot cancelled');
        overrideSent = true;
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: emulated.width, height: emulated.height, deviceScaleFactor: 1, mobile: emulated.width < 768,
        });
        await settleLayout(page);
      }
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const visual = metrics.cssVisualViewport || metrics.visualViewport;
      const content = metrics.cssContentSize || metrics.contentSize;
      const dpr = emulated ? 1 : await captureScaleOf(cdp, visual);
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
        const { data } = await cdp.send('Page.captureScreenshot', {
          format,
          ...(format === 'jpeg' && { quality }),
          clip: { ...region, scale: scale * factor },
          captureBeyondViewport: !!options.fullPage,
        });
        return data;
      };
      const fileData = options.save ? await shoot(options.fileFormat, options.fileQuality, 1) : null;
      const reuse = fileData && shrink === 1 && options.inlineFormat === options.fileFormat;
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
    });
  } catch (error) {
    failure = error;
  }
  // Also when the capture timed out and is still pending: the clear goes out on
  // its own (a detach alone would leave the override on the page).
  settled = true;
  const viewportRestored = overrideSent ? await restore(page, cdp, viewportBefore) : null;
  await Promise.race([cdp.detach(), delay(2000)]).catch(() => {});
  if (failure) {
    if (viewportRestored === false && failure && typeof failure === 'object') failure.viewportRestored = false;
    throw failure;
  }
  return viewportRestored === null ? result : { ...result, viewportRestored };
}
