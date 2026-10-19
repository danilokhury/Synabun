/**
 * The update feed, read the same way on every platform. Pure (tested in
 * packaging/tests/desktop-updater.test.mjs).
 *
 * The feed is the public GitHub Releases of danilokhury/Synabun, read through
 * the "latest release" download address, so it does not depend on how a tag is
 * spelled (SynaBun tags look like v.2.0.5). The release carries one file per
 * platform that says what is in it (latest-mac.yml, latest.yml,
 * latest-linux.yml), written by packaging/build.mjs. A latest release without
 * those files is a release without a desktop build: no update, quietly.
 *
 * Which version is newer is SynaBun's own rule (synabun-version.mjs, a copy of
 * neural-interface/lib/synabun-version.js), not plain semver: a date-style
 * version (2026.9.8, the Dev builds made before Dev moved to semver on
 * 2026-10-17) is older than every 2.x release.
 */

import { synabunVersionNewer, parseSemver } from './synabun-version.mjs';

export const DEFAULT_FEED = 'https://github.com/danilokhury/Synabun/releases/latest/download';
/** Test-only: a feed served by a local HTTP server. Read from the environment at start, never from the interface. */
export const FEED_ENV = 'SYNABUN_DESKTOP_UPDATE_FEED';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The feed to use: the public one, or a test feed from the environment when it
 * is an https address or a plain-http address on this machine. Anything else is
 * ignored (`rejected` says what), so a stray variable cannot point the app at
 * an unencrypted remote server.
 */
export function feedFromEnv(env = process.env) {
  const raw = String(env[FEED_ENV] || '').trim();
  if (!raw) return { url: DEFAULT_FEED, test: false, rejected: null };
  let url;
  try { url = new URL(raw); } catch { return { url: DEFAULT_FEED, test: false, rejected: raw }; }
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!allowed || url.username || url.password || url.search || url.hash) return { url: DEFAULT_FEED, test: false, rejected: raw };
  return { url: url.href.replace(/\/+$/, ''), test: true, rejected: null };
}

/** The file of the feed that describes this platform's build. */
export function channelFileFor(platform) {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'win32') return 'latest.yml';
  return 'latest-linux.yml';
}

/** True when `candidate` is a newer SynaBun than `current` (SynaBun's own version order). */
export function isNewer(current, candidate) {
  return synabunVersionNewer(current, candidate);
}

/** An absolute address for a file the feed names (a file name, or already an address). */
export function assetUrl(feedUrl, file) {
  try { return new URL(String(file)).href; } catch {}
  return `${String(feedUrl).replace(/\/+$/, '')}/${String(file).split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Checks the shape of a parsed feed file: a version, and files that each have
 * a name, a sha512 (base64, as electron-builder writes it) and a size. Throws
 * with what is wrong; returns the info normalised.
 */
export function normalizeFeed(info) {
  if (!info || typeof info !== 'object') throw new Error('the feed file is empty');
  const version = String(info.version || '');
  if (!parseSemver(version)) throw new Error(`the feed names no valid version ("${version}")`);
  const files = (Array.isArray(info.files) ? info.files : []).map((file) => ({
    url: String(file?.url || ''),
    sha512: String(file?.sha512 || ''),
    size: Number(file?.size),
    arch: file?.arch ? String(file.arch) : null,
    blockMapSize: file?.blockMapSize ?? null,
  }));
  for (const file of files) {
    if (!file.url || /[\\]|(^|\/)\.\.(\/|$)/.test(file.url)) throw new Error(`the feed names a file without a usable name ("${file.url}")`);
    if (!/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) throw new Error(`the feed has no sha512 for ${file.url}`);
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`the feed has no size for ${file.url}`);
  }
  return {
    version,
    files,
    releaseDate: info.releaseDate ? String(info.releaseDate) : null,
    notes: notesText(info.releaseNotes),
    minimumSystemVersion: info.minimumSystemVersion ? String(info.minimumSystemVersion) : null,
  };
}

/** Release notes as text: a string, or electron-builder's list of { version, note }. */
export function notesText(notes) {
  if (notes == null) return null;
  if (typeof notes === 'string') return notes.trim() || null;
  if (Array.isArray(notes)) {
    const text = notes.map(item => (item && typeof item === 'object' ? [item.version, item.note].filter(Boolean).join('\n') : String(item ?? ''))).join('\n\n').trim();
    return text || null;
  }
  return null;
}

const archOf = (file) => {
  if (file.arch) return file.arch === 'arm64' ? 'arm64' : file.arch === 'x64' || file.arch === 'x86_64' ? 'x64' : file.arch;
  const name = file.url.toLowerCase();
  if (/(^|[-_.])arm64([-_.]|$)/.test(name)) return 'arm64';
  if (/(^|[-_.])(x64|x86_64|intel)([-_.]|$)/.test(name)) return 'x64';
  return null;
};

/**
 * The macOS file of `kind` ('zip' to swap in, 'dmg' to hand over) for this Mac.
 * An Intel build running on Apple Silicon (Rosetta) moves to the Apple Silicon
 * build, like electron-updater does. Null when the feed has none: the latest
 * release then has no build for this Mac, and that is no update.
 */
export function pickMacFile(info, { arch = process.arch, translated = false, kind = 'zip' } = {}) {
  const wanted = translated ? 'arm64' : arch;
  const extension = `.${kind}`;
  const candidates = (info?.files || []).filter(file => file.url.toLowerCase().endsWith(extension));
  return candidates.find(file => archOf(file) === wanted)
    // A one-architecture feed without marks: only when it cannot be the other one.
    || candidates.find(file => archOf(file) === null && candidates.length === 1)
    || null;
}
