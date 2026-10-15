// ── The File Explorer's system programs ──
// The three things the explorer asks the operating system for: move something
// to the Trash, show something in the file manager, and (for "Add project")
// the folder picker. Every path is handed over as an argument of its own
// (execFile, never a shell), so nothing in a file name is ever read as a command.
//
// Trash, per system:
//   macOS    /usr/bin/trash (macOS 14 and later), else a move into ~/.Trash
//   Windows  the Recycle Bin, through lib/file-explorer-trash.ps1, and only
//            where the bin is sure to keep the item (recycleVerdict)
//   Linux    `gio trash`, else the FreeDesktop Trash of the home folder
// A path that has no Trash (another volume, a system without one) throws
// TrashUnavailable and nothing is removed: the caller asks before deleting for good.

import { execFile } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { splitName } from '../public/shared/explorer/fx-names.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TRASH_SCRIPT = join(HERE, 'file-explorer-trash.ps1');
export const MAC_TRASH = '/usr/bin/trash';
const SYSTEM_TIMEOUT_MS = 20000;

/** There is no Trash for that path on this system. Nothing was removed. */
export class TrashUnavailable extends Error {
  constructor(message = 'No Trash is available for that path.') {
    super(message);
    this.name = 'TrashUnavailable';
    this.code = 'no-trash';
  }
}

/** Run a program with its arguments, without a shell. Rejects with the error (its `code` is the errno or exit code). */
export function runProgram(file, args, { timeoutMs = SYSTEM_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((done, failed) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, shell: false, env, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) { error.stderr = String(stderr || ''); failed(error); } else done({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (error) { failed(error); }
  });
}

const two = (n) => String(n).padStart(2, '0');

/**
 * Move `path` into the folder `dir` without ever replacing something that is there. The name is reserved first by
 * making an empty placeholder exclusively (a file, or a folder for a folder): `rename` then replaces only what
 * was just made here. A second entry of one name gets the time appended, as the Finder does.
 * @returns {string} where it is now
 */
export function moveIntoFolder(path, dir, { now = new Date() } = {}) {
  const st = lstatSync(path);
  const isDir = st.isDirectory();
  const name = basename(path);
  const { stem, ext } = isDir ? { stem: name, ext: '' } : splitName(name);
  const stamp = `${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`;
  for (let n = 0; n < 500; n++) {
    const candidate = n === 0 ? name : `${stem} ${stamp}${n > 1 ? ` ${n}` : ''}${ext}`;
    const dest = join(dir, candidate);
    try {
      if (isDir) mkdirSync(dest);
      else closeSync(openSync(dest, 'wx'));
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    try {
      renameSync(path, dest);
      return dest;
    } catch (error) {
      try { if (isDir) rmdirSync(dest); else unlinkSync(dest); } catch { /* the placeholder stays: an empty entry in the Trash */ }
      throw error;
    }
  }
  throw new Error('No free name in the Trash.');
}

/**
 * Give `path` the name `dest` only when nothing is there: a file or a folder that is under that name, or turns up
 * under it while a request waits, is never replaced. The name is reserved first by an empty placeholder made
 * exclusively (a file, or a folder for a folder), and `rename` then replaces only what was just made here. Throws
 * EEXIST when the name is taken; a rename that fails leaves nothing under the name.
 *
 * The window that is left, and why it is accepted. Between the two calls (making the placeholder, renaming onto
 * it) another writer can put something of its own in the placeholder's place, and the rename replaces it. That
 * takes another program writing to the very same name in the instant between two system calls that follow one
 * another; for a folder the system closes most of it (a rename onto a folder that got content fails by itself).
 * The one way to close it for a file is to give the file its new name as a hard link, which replaces nothing; it
 * was tried and taken out again, because macOS does not report the later deletion of a file that ever had a
 * second hard link (APFS, macOS 26.6: not to a recursive watch, not to a watch on its folder). A file placed
 * that way and deleted by something else kept its row in the tree: the explorer no longer followed the disk for
 * every file it had renamed, moved or taken in. A window that needs a second writer on the same name in the same
 * instant is the smaller cost. (tests/file-explorer-safety.test.mjs asks the real disk.)
 * @param {string} path @param {string} dest
 * @param {{ isDir?: boolean, platform?: string, rename?: typeof renameSync }} [o]
 */
export function renameExclusive(path, dest, { isDir = false, platform = process.platform, rename = renameSync } = {}) {
  if (isDir && platform === 'win32') {
    // Windows renames a folder over nothing at all, and not onto a placeholder either: the name is looked at,
    // and the system's own refusal is what holds.
    let there = true;
    try { lstatSync(dest); } catch { there = false; }
    if (there) throw Object.assign(new Error(`EEXIST: file already exists, rename '${path}' -> '${dest}'`), { code: 'EEXIST' });
    rename(path, dest);
    return;
  }
  if (isDir) mkdirSync(dest);
  else closeSync(openSync(dest, 'wx'));
  try {
    rename(path, dest);
  } catch (error) {
    try { if (isDir) rmdirSync(dest); else unlinkSync(dest); } catch { /* the placeholder stays: an empty entry */ }
    throw error;
  }
}

// ── The Recycle Bin (Windows) ──
// The Shell deletes for good, without a word, what its bin cannot keep: an item on a network or a removable
// drive, on a drive whose bin is switched off, or larger than the bin. So the bin is asked about first
// (file-explorer-trash.ps1 -Probe gives the facts) and the item is handed to the Shell only when the rule
// below says it will be kept. The rule is here, not in the script, so that it is tested without Windows.

const MB = 1024 * 1024;
/** The Win32 drive type of a local disk (Win32_Volume.DriveType): the only kind whose bin keeps what it is given. */
export const FIXED_DRIVE = 3;
/** A bin that was never set up has the system's own limit: taken at its smallest. */
export const DEFAULT_BIN_SHARE = 0.05;
export const BIN_PROBE_TTL_MS = 5000;
export const MEASURE_MAX_ENTRIES = 200000;

/**
 * Whether an item is sure to be kept by the Recycle Bin. Each of the two switches is `true` (off), `false` (on:
 * also what the probe says of a setting that is not there, which is Windows' default) or anything else, which is
 * "it could not be read": then nothing is known, and the answer is no.
 * @param {{ driveType?: number | string, volumeBytes?: number | null, maxCapacityMB?: number | null, nukeOnDelete?: boolean | null, policyOff?: boolean | null, error?: string } | null} facts
 *   what the probe said of the bin that serves the item's folder
 * @param {number | null} sizeBytes how large the item is (`Infinity`: past the limit it was measured to; null: not known)
 * @returns {{ ok: true } | { ok: false, reason: 'unknown' | 'drive' | 'off' | 'too-large' }} `unknown`: the bin could
 *   not be asked, one of its switches could not be read, or the item was not measured; `drive`: not a local disk;
 *   `off`: the bin is switched off, for the drive or by policy; `too-large`: the item is larger than the bin
 */
export function recycleVerdict(facts, sizeBytes) {
  const no = (reason) => ({ ok: false, reason });
  if (!facts || typeof facts !== 'object' || facts.error) return no('unknown');
  if (facts.policyOff === true) return no('off');
  if (facts.policyOff !== false) return no('unknown');
  if (Number(facts.driveType) !== FIXED_DRIVE) return no('drive');
  if (facts.nukeOnDelete === true) return no('off');
  if (facts.nukeOnDelete !== false) return no('unknown');
  const own = facts.maxCapacityMB;
  const capacity = typeof own === 'number' && Number.isFinite(own) && own >= 0 ? own * MB
    : typeof facts.volumeBytes === 'number' && Number.isFinite(facts.volumeBytes) && facts.volumeBytes > 0 ? facts.volumeBytes * DEFAULT_BIN_SHARE
      : null;
  if (capacity === null) return no('unknown');
  if (typeof sizeBytes !== 'number' || Number.isNaN(sizeBytes) || sizeBytes < 0) return no('unknown');
  return sizeBytes > capacity ? no('too-large') : { ok: true };
}

/**
 * How large an entry is: a file's size, or everything below a folder (a link counts as the link it is).
 * @param {string} path
 * @param {{ stopAt?: number, maxEntries?: number }} [o] past `stopAt` bytes the answer is `Infinity` and the rest
 *   is not walked; a folder of more than `maxEntries` entries is not measured
 * @returns {Promise<number | null>} null when it cannot be said
 */
export async function entryBytes(path, { stopAt = Infinity, maxEntries = MEASURE_MAX_ENTRIES } = {}) {
  let total = 0; let seen = 0;
  const queue = [path];
  try {
    while (queue.length) {
      const at = queue.pop();
      if (++seen > maxEntries) return null;
      const st = await lstat(at);
      total += st.size;
      if (total > stopAt) return Infinity;
      if (st.isDirectory()) for (const name of await readdir(at)) queue.push(join(at, name));
    }
  } catch { return null; }
  return total;
}

const BIN_REASONS = {
  unknown: 'The Recycle Bin of that drive could not be asked about.',
  drive: 'That drive has no Recycle Bin (a network or a removable drive).',
  off: 'The Recycle Bin is switched off for that drive.',
  'too-large': 'That is larger than the Recycle Bin of its drive.',
};

/** The FreeDesktop Trash of the home folder: `files/` holds the entry, `info/<name>.trashinfo` where it came from. */
export function trashFreeDesktop(path, { trashDir, now = new Date() } = {}) {
  const files = join(trashDir, 'files');
  const info = join(trashDir, 'info');
  mkdirSync(files, { recursive: true, mode: 0o700 });
  mkdirSync(info, { recursive: true, mode: 0o700 });
  const name = basename(path);
  const isDir = lstatSync(path).isDirectory();
  const { stem, ext } = isDir ? { stem: name, ext: '' } : splitName(name);
  const when = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
  const record = `[Trash Info]\nPath=${pathToFileURL(path).pathname}\nDeletionDate=${when}\n`;
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem}.${n}${ext}`;
    const infoFile = join(info, `${candidate}.trashinfo`);
    if (existsSync(join(files, candidate))) continue;
    // The record is written first, exclusively: that is what reserves the name (the Trash specification).
    try { writeFileSync(infoFile, record, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error?.code === 'EEXIST') continue; throw error; }
    try {
      renameSync(path, join(files, candidate));
      return join(files, candidate);
    } catch (error) {
      try { unlinkSync(infoFile); } catch { /* nothing to undo */ }
      throw error;
    }
  }
  throw new Error('No free name in the Trash.');
}

/**
 * @param {object} [o]
 * @param {string} [o.platform]
 * @param {(file: string, args: string[]) => Promise<any>} [o.run] runs a program (tests hand in a recorder)
 * @param {object} [o.env] @param {string} [o.home]
 * @param {(path: string) => boolean} [o.exists]
 * @param {typeof entryBytes} [o.measure] @param {() => number} [o.now] Windows: how an item is measured, and the clock
 * @returns {{ kind: string, available: () => boolean, trash: (path: string) => Promise<void> }} `path` is a
 *   canonical absolute path that exists; `trash` rejects with TrashUnavailable when it has nowhere to go
 */
export function createTrash({
  platform = process.platform, run = runProgram, env = process.env, home = homedir(), exists = existsSync,
  measure = entryBytes, now = () => Date.now(),
} = {}) {
  // A cross-device move, or a Trash that cannot be written, is "no Trash here", not a failure of the delete.
  const noTrashHere = (error) => ['EXDEV', 'EACCES', 'EPERM', 'ENOENT', 'EROFS'].includes(error?.code);

  if (platform === 'darwin') {
    const fallback = (path) => {
      try { moveIntoFolder(path, join(home, '.Trash')); }
      catch (error) { if (noTrashHere(error)) throw new TrashUnavailable(); throw error; }
    };
    return {
      kind: 'macos',
      available: () => true,
      async trash(path) {
        if (exists(MAC_TRASH)) {
          try { await run(MAC_TRASH, [path]); return; }
          catch { if (!exists(path)) return; /* it went all the same */ }
        }
        fallback(path);
      },
    };
  }

  if (platform === 'win32') {
    const script = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TRASH_SCRIPT];
    const asked = new Map();   // folder → { at, facts }: the rows of one delete are mostly of one folder
    // What is known of the bin that serves a folder, or null when it could not be asked.
    async function binOf(folder) {
      const known = asked.get(folder);
      if (known && now() - known.at < BIN_PROBE_TTL_MS) return known.facts;
      let facts = null;
      try { facts = JSON.parse(String((await run('powershell.exe', [...script, '-Probe', folder]))?.stdout || '').trim()); } catch { facts = null; }
      asked.set(folder, { at: now(), facts });
      if (asked.size > 64) asked.delete(asked.keys().next().value);
      return facts;
    }
    return {
      kind: 'windows',
      available: () => true,
      async trash(path) {
        // Asked first, and nothing is handed to the Shell unless the bin is sure to keep it: what it cannot keep
        // it deletes for good without a word. Refused here, the item stays and the caller asks its own question.
        const facts = await binOf(dirname(path));
        const limit = typeof facts?.maxCapacityMB === 'number' ? facts.maxCapacityMB * MB : typeof facts?.volumeBytes === 'number' ? facts.volumeBytes * DEFAULT_BIN_SHARE : 0;
        const verdict = recycleVerdict(facts, recycleVerdict(facts, 0).ok ? await measure(path, { stopAt: limit }) : null);
        if (!verdict.ok) throw new TrashUnavailable(BIN_REASONS[verdict.reason]);
        try {
          await run('powershell.exe', [...script, path]);
        } catch (error) {
          if (!exists(path)) return;
          // The script could not be run at all (no PowerShell), or the Shell refused the item.
          throw new TrashUnavailable(String(error?.stderr || error?.message || '').trim() || undefined);
        }
      },
    };
  }

  const trashDir = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'Trash');
  return {
    kind: 'freedesktop',
    available: () => true,
    async trash(path) {
      try { await run('gio', ['trash', '--', path]); return; }
      catch { if (!exists(path)) return; /* no gio, or it refused: the home Trash is tried by hand */ }
      try { trashFreeDesktop(path, { trashDir }); }
      catch (error) { if (noTrashHere(error)) throw new TrashUnavailable(); throw error; }
    },
  };
}

/**
 * The program that shows `path` selected in the system's file manager, as `{ file, args }` lists (the first that
 * runs is used), or an empty list when this system has none.
 */
export function revealCommands(platform, path, { env = process.env } = {}) {
  if (platform === 'darwin') return [{ file: 'open', args: ['-R', path] }];
  // explorer.exe takes "/select," and the path as one argument, and answers 1 even when it worked.
  if (platform === 'win32') return [{ file: 'explorer.exe', args: [`/select,${path}`], anyExit: true }];
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return [];
  // dbus-send splits the items of an array at commas: one in the path is written as its escape, which a file
  // manager reads back as the comma.
  const url = pathToFileURL(path).href.replace(/,/g, '%2C');
  return [
    { file: 'dbus-send', args: ['--session', '--dest=org.freedesktop.FileManager1', '--type=method_call', '/org/freedesktop/FileManager1',
      'org.freedesktop.FileManager1.ShowItems', `array:string:${url}`, 'string:'] },
    { file: 'xdg-open', args: [dirname(path)] },
  ];
}

/** @returns {{ available: () => boolean, reveal: (path: string) => Promise<boolean> }} */
export function createRevealer({ platform = process.platform, run = runProgram, env = process.env } = {}) {
  return {
    available: () => revealCommands(platform, '/', { env }).length > 0,
    async reveal(path) {
      for (const command of revealCommands(platform, path, { env })) {
        try { await run(command.file, command.args); return true; }
        catch (error) { if (command.anyExit && error?.code !== 'ENOENT') return true; }
      }
      return false;
    },
  };
}

/**
 * The system's folder picker as a program and its arguments. The prompt is an argument: it is never part of a
 * script or a command line that is parsed again.
 * @param {string} platform @param {string} prompt
 * @param {{ scriptPath?: string }} [o] Windows: lib/folder-picker.ps1
 */
export function folderPickerCommand(platform, prompt, { scriptPath = join(HERE, 'folder-picker.ps1') } = {}) {
  const title = String(prompt || 'Select a folder').replace(/[\r\n]+/g, ' ').slice(0, 200);
  if (platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Title', title] };
  }
  if (platform === 'darwin') {
    return { file: 'osascript', args: ['-e', 'on run argv', '-e', 'POSIX path of (choose folder with prompt (item 1 of argv))', '-e', 'end run', title] };
  }
  return { file: 'zenity', args: ['--file-selection', '--directory', `--title=${title}`] };
}
