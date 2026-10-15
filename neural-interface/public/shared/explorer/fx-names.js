// ═══════════════════════════════════════════
// SynaBun Neural Interface — File Explorer: names
// ═══════════════════════════════════════════
//
// What a file or folder may be called on the system the server runs on, how
// two names are ordered, and the names the explorer makes up itself (a copy's).
// No imports and no page: the server reads the same rules
// (lib/file-explorer-api.js), the way it reads the editor's preferences, so
// page and server cannot disagree about a name.

/** The longest name most filesystems take, in UTF-8 bytes. */
export const MAX_NAME_BYTES = 255;

// Device names Windows keeps for itself, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const WINDOWS_CHARS = /[<>:"|?*]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const byteLength = (text) => new TextEncoder().encode(text).length;

/**
 * Why a name cannot be used, or null when it can.
 * @param {string} name one path segment, as it would be written to disk
 * @param {{ platform?: string }} [o] `process.platform` of the machine that holds the files
 * @returns {null | 'empty' | 'dots' | 'separator' | 'control' | 'reserved' | 'chars' | 'trailing' | 'long'}
 */
export function validateName(name, { platform = 'posix' } = {}) {
  if (typeof name !== 'string' || name.length === 0 || name.trim().length === 0) return 'empty';
  if (name === '.' || name === '..') return 'dots';
  if (/[\\/]/.test(name)) return 'separator';
  if (CONTROL.test(name)) return 'control';
  if (platform === 'win32') {
    if (WINDOWS_CHARS.test(name)) return 'chars';
    if (WINDOWS_RESERVED.test(name)) return 'reserved';
    if (/[ .]$/.test(name)) return 'trailing';
  }
  if (byteLength(name) > MAX_NAME_BYTES) return 'long';
  return null;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Natural, case-insensitive order: `file2` before `file10`, `a` next to `A`. Stable for names that only differ in case. */
export function compareNames(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * A name as a stem and its extension. A dotfile has no extension (`.env`), and only the last one counts
 * (`archive.tar.gz` → `archive.tar` + `.gz`).
 * @returns {{ stem: string, ext: string }}
 */
export function splitName(name) {
  const text = String(name ?? '');
  const dot = text.lastIndexOf('.');
  if (dot <= 0) return { stem: text, ext: '' };
  return { stem: text.slice(0, dot), ext: text.slice(dot) };
}

/** What a rename selects at first: the name without its extension (all of a folder's name). */
export function renameSelection(name, isDir = false) {
  return [0, isDir ? String(name).length : splitName(name).stem.length];
}

/**
 * The name of a copy that sits next to its original: `notes copy.md`, then `notes copy 2.md`, …
 * @param {string} name
 * @param {(candidate: string) => boolean} taken whether a name is in use in that folder
 * @param {{ isDir?: boolean }} [o] a folder's name has no extension
 */
export function copyName(name, taken, { isDir = false } = {}) {
  const { stem, ext } = isDir ? { stem: String(name), ext: '' } : splitName(name);
  // A copy of a copy counts on: `notes copy.md` → `notes copy 2.md`.
  const again = /^(.*) copy(?: (\d+))?$/.exec(stem);
  const base = again ? again[1] : stem;
  for (let n = again ? Number(again[2] || 1) + 1 : 1; n < 10000; n++) {
    const candidate = `${base} copy${n > 1 ? ` ${n}` : ''}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base} copy ${Date.now()}${ext}`;
}

/** Whether two names are one entry on a disk that does not tell case apart (macOS and Windows by default). */
export function sameNameIgnoringCase(a, b) {
  return String(a).normalize('NFC').toLowerCase() === String(b).normalize('NFC').toLowerCase();
}
