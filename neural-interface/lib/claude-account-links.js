// ═══════════════════════════════════════════
// SynaBun — how a named account shares the default account's files
// ═══════════════════════════════════════════
//
// A named Claude account is a config directory of its own (lib/claude-accounts.js). What is not an identity
// (SHARED_LINKS there: settings.json with its allow list and hooks, CLAUDE.md, rules, skills, ...) is shared
// with the default ~/.claude, so the account reads what the default reads. A named Codex account
// (lib/codex-accounts.js) shares config.toml, AGENTS.md and prompts/ of the default CODEX_HOME through the same
// functions: nothing here knows a provider, only a default's entry (`source`) and an account's name for it
// (`target`).
//
// A folder is shared by a link to it: a symbolic link on macOS / Linux, a junction on Windows (a junction needs
// no administrator rights and no Developer Mode). A FILE cannot be shared by a junction: Windows makes a junction
// to a file, and it opens as a broken folder, so Claude Code in the account reads no settings.json at all (every
// tool asks again). Older SynaBun versions did exactly that. A file is shared, in this order, by:
//   1. a symbolic link (macOS / Linux always; Windows only with Developer Mode or as administrator),
//   2. a hard link (Windows without either: no privilege needed, the same file under two names, same volume),
//   3. a copy (another volume, or a file system without hard links).
// A hard link holds only while every writer writes the file in place. Claude Code writes settings.json, and
// Codex its config.toml, by writing a new file and renaming it over the old one, which leaves the two names two
// files. So a hard link or a copy is kept in step by syncSharedFile(): at a start, before every launch of the
// account, after SynaBun writes the default's file: the name that changed since the two were last in step is the
// content, the other name is linked to it again; when both changed, the newer wins and the other is kept in the
// account's backups/.
//
// Never removes anything but a link (lstat says so), a hard-linked / copied file SynaBun itself made and
// recorded, or, only when a caller says the account's file is SynaBun's own doing (`adopt`), that file after a
// copy of it is in the account's backups/; never follows a link to remove; never touches the default's file
// except to write the newer content into it, in place when it has other names.

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { resolve } from 'node:path';

/** The entries of Claude's SHARED_LINKS that are files (everything else is a folder). */
export const SHARED_FILE_NAMES = Object.freeze(['settings.json', 'CLAUDE.md', 'keybindings.json']);

const code = (error) => (error && typeof error.code === 'string' ? error.code : '');
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
function digestOf(fs, path) { try { return sha(fs.readFileSync(path)); } catch { return null; } }

/** Is `path` a link (a symbolic link, or a junction: Node reports both as one)? */
function isLink(fs, path) {
  try { return fs.lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** Does `path` read as a regular file (following a link)? */
function readsAsFile(fs, path) {
  try {
    if (!fs.statSync(path).isFile()) return false;
    fs.readFileSync(path);
    return true;
  } catch { return false; }
}

/** The same file under both names (device and file index / inode)? */
export function sameFile(fs, a, b) {
  try {
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    return x.dev === y.dev && x.ino === y.ino && x.ino !== 0n;
  } catch { return false; }
}

/** Remove a link without touching what it points at. A junction on Windows is a folder to rmdir. */
function removeLink(fs, path) {
  try { fs.unlinkSync(path); return; } catch (error) {
    if (!['EPERM', 'EISDIR', 'EACCES'].includes(code(error))) throw error;
  }
  fs.rmdirSync(path);
}

/**
 * Write `text` to the file at `path` so every name of it reads the new content: in place when the file has
 * other names (a hard link of a named account), else a new file renamed over it (atomic).
 */
export function writeKeepingLinks(fs, path, text) {
  let real = path;
  try { real = fs.realpathSync(path); } catch {}
  let names = 1;
  try { names = Number(fs.statSync(real).nlink) || 1; } catch {}
  if (names > 1) { fs.writeFileSync(real, text); return; }
  const tmp = `${real}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, real);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

/**
 * Share the file `source` as `target` (which must not exist). Returns how: 'symlink' | 'hardlink' | 'copy'.
 * Throws when none of them works.
 */
export function linkSharedFile({ source, target, platform = process.platform, fs = nodeFs }) {
  try {
    fs.symlinkSync(source, target, platform === 'win32' ? 'file' : undefined);
    if (platform !== 'win32' || readsAsFile(fs, target)) return 'symlink';
    removeLink(fs, target);
  } catch (error) {
    // Without the right to make symbolic links (Windows: no Developer Mode, not elevated) or where the file
    // system has none: the next way. Anything else (the folder is gone, no space) is a real failure.
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(code(error))) throw error;
  }
  // A default that is itself a link (dotfiles, a synced folder): the file behind it is the one shared.
  let real = source;
  try { real = fs.realpathSync(source); } catch {}
  try {
    fs.linkSync(real, target);
    return 'hardlink';
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(code(error))) throw error;
  }
  fs.copyFileSync(real, target, fs.constants?.COPYFILE_EXCL ?? 1);
  return 'copy';
}

/** Share the folder `source` as `target`: a junction on Windows, a symbolic link elsewhere. */
export function linkSharedFolder({ source, target, platform = process.platform, fs = nodeFs }) {
  fs.symlinkSync(source, target, platform === 'win32' ? 'junction' : undefined);
  return platform === 'win32' ? 'junction' : 'symlink';
}

/**
 * Keep `content`, the losing side of `target`, in the account's backups folder as
 * `<name>.synabun-<side>-<time>` and return its path. A backup of that name and side with the same content is
 * already enough (an adoption that could not finish, a file in use, made it, and the next start tries again):
 * it is returned and nothing is written. Otherwise the file is created exclusively under the first free name
 * (`-<time>`, then `-<time>-2`, ...): two backups made in the same millisecond never meet, and an earlier
 * backup is never overwritten.
 */
function keepBackup(fs, backupDir, target, side, now, content) {
  fs.mkdirSync(backupDir, { recursive: true });
  const prefix = `${target.split(/[\\/]/).pop()}.synabun-${side}-`;
  let existing = [];
  try { existing = fs.readdirSync(backupDir).filter((name) => name.startsWith(prefix)).sort(); } catch {}
  for (const name of existing) {
    const path = resolve(backupDir, name);
    try {
      if (fs.lstatSync(path).isFile() && fs.readFileSync(path).equals(content)) return path;
    } catch {}
  }
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  for (let n = 1; ; n += 1) {
    const path = resolve(backupDir, `${prefix}${stamp}${n === 1 ? '' : `-${n}`}`);
    try {
      // Owner-only: a config.toml can hold an MCP server's token.
      fs.writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
      return path;
    } catch (error) {
      if (code(error) !== 'EEXIST' || n >= 1000) throw error;
    }
  }
}

/**
 * Put one shared file of an account in order. `recorded` is SynaBun's note of how it shared the file before,
 * `{ how: 'hardlink' | 'copy', sha }` (sha: the content the two names last had in common), or undefined.
 * Returns `{ how, action, backup, sha }`:
 *   how    — what the target is now: 'symlink' | 'hardlink' | 'copy' | 'own' (a file of the account's own,
 *            left alone) | null (nothing to share: the default has no such file, or the account has none
 *            and `linkMissing` is false)
 *   action — 'none' | 'linked' (it was missing) | 'repaired' (a link that does not read as a file was
 *            replaced) | 'relinked' (a hard link two writes apart, linked again) | 'synced' (a copy updated) |
 *            'adopted' (with `adopt`: a file nothing recorded was replaced by the default's)
 *   backup — where content that lost was kept (when both names changed since they were last in step, and the
 *            account's own file when it was adopted and differed)
 *   sha    — for a hard link or a copy, the content both names have now (the next `recorded.sha`)
 * `adopt` is for a file SynaBun knows it left in the account by a failed link (a named Codex account's
 * config.toml on Windows): the default's content always wins there, never the newer one, because the
 * account's file was never the shared one.
 */
export function syncSharedFile({
  source, target, recorded = undefined, platform = process.platform, fs = nodeFs, now = Date.now, backupDir = null,
  linkMissing = true, adopt = false,
}) {
  const result = (how, action, backup = null) => ({
    how, action, backup, sha: how === 'hardlink' || how === 'copy' ? digestOf(fs, source) : null,
  });
  if (!readsAsFile(fs, source)) return result(null, 'none');
  let present = true;
  try { fs.lstatSync(target); } catch { present = false; }
  if (!present) {
    // Made when the account is made; later, a name the owner removed from the account stays removed.
    if (!linkMissing) return result(null, 'none');
    return result(linkSharedFile({ source, target, platform, fs }), 'linked');
  }

  if (isLink(fs, target)) {
    if (readsAsFile(fs, target)) return result('symlink', 'none');
    // A link that does not read as a file: on Windows, the junction to settings.json SynaBun made before.
    // Elsewhere a broken link is the owner's (left alone).
    if (platform !== 'win32') return result('own', 'none');
    removeLink(fs, target);
    return result(linkSharedFile({ source, target, platform, fs }), 'repaired');
  }

  if (sameFile(fs, source, target)) return result('hardlink', 'none');
  // A file SynaBun did not make (no record) is the account's own choice: left alone, unless the caller knows
  // it is what a link that could not be made left behind.
  const was = recorded?.how;
  if (was !== 'hardlink' && was !== 'copy') {
    if (!adopt) return result('own', 'none');
    let kept = null;
    const own = fs.readFileSync(target);
    if (!fs.readFileSync(source).equals(own)) {
      if (!backupDir) return result('own', 'none');
      kept = keepBackup(fs, backupDir, target, 'account', now, own);
    }
    fs.unlinkSync(target);
    return result(linkSharedFile({ source, target, platform, fs }), 'adopted', kept);
  }

  const a = fs.readFileSync(source);
  const b = fs.readFileSync(target);
  let backup = null;
  if (!a.equals(b)) {
    const base = typeof recorded.sha === 'string' ? recorded.sha : null;
    const aChanged = !base || sha(a) !== base;
    const bChanged = !base || sha(b) !== base;
    // The side that changed since the two were last in step wins; when both did, the newer one.
    const accountWins = bChanged && (!aChanged || fs.statSync(target).mtimeMs > fs.statSync(source).mtimeMs);
    if (aChanged && bChanged && backupDir) {
      backup = keepBackup(fs, backupDir, target, accountWins ? 'default' : 'account', now, accountWins ? a : b);
    }
    // The newer content goes into the default's file (in place when other accounts share it too).
    if (accountWins) writeKeepingLinks(fs, source, b);
    if (was === 'copy') {
      if (!accountWins) writeKeepingLinks(fs, target, a);
      return result('copy', 'synced', backup);
    }
  } else if (was === 'copy') {
    return result('copy', 'none');
  }
  // The two names are one file again (a hard link where possible, else a fresh copy).
  fs.unlinkSync(target);
  return result(linkSharedFile({ source, target, platform, fs }), 'relinked', backup);
}

/** The folder under an account's home where content that lost a sync is kept. */
export function sharedBackupDir(home) { return resolve(home, 'backups'); }

/** Do two records of how an account's files are shared (`{ [name]: { how, sha } }`) say the same? */
export function sameSharedRecords(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key]?.how !== b[key]?.how || a[key]?.sha !== b[key]?.sha) return false;
  return true;
}

/**
 * Put the shared entries of one account in order: every name of `names` (in that order) that the default has,
 * a name of `fileNames` through syncSharedFile(), any other as a folder link made when it is missing.
 * `recorded` is the account's record (`{ [name]: { how, sha } }`); only a hard link or a copy is recorded,
 * because only those are kept in step by SynaBun. `adopt` lists the file names an unrecorded file of the
 * account is replaced for (see syncSharedFile). Never throws: a name that fails is logged, listed in `failed`
 * and keeps its record. Returns `{ linked, repaired, failed, modes }` (`modes`: the record to keep now).
 */
export function syncSharedEntries({
  defaultHome, home, names, fileNames = [], recorded = {}, linkMissing = true, adopt = [],
  platform = process.platform, fs = nodeFs, now = Date.now, log = () => {}, tag = 'accounts',
}) {
  const linked = [];
  const repaired = [];
  const failed = [];
  const modes = {};
  const nothing = { how: null, action: 'none', backup: null };
  const entry = (name) => {
    const source = resolve(defaultHome, name);
    const target = resolve(home, name);
    if (fileNames.includes(name)) {
      return syncSharedFile({
        source, target, recorded: recorded[name], platform, fs, now, backupDir: sharedBackupDir(home), linkMissing,
        adopt: adopt.includes(name),
      });
    }
    if (!fs.existsSync(source)) return nothing;
    try { fs.lstatSync(target); return { how: 'link', action: 'none', backup: null }; } catch {}
    if (!linkMissing) return nothing;
    return { how: linkSharedFolder({ source, target, platform, fs }), action: 'linked', backup: null };
  };
  for (const name of names) {
    try {
      const result = entry(name);
      if (result.how === 'hardlink' || result.how === 'copy') modes[name] = { how: result.how, sha: result.sha };
      else if (result.how === 'own' && recorded[name]) modes[name] = recorded[name];
      if (result.action === 'linked') linked.push(name);
      else if (result.action !== 'none') repaired.push(name);
      if (result.action === 'repaired') log(tag, `${name} of ${home} was a link that does not open as a file (a junction): shared again as a ${result.how}`);
      else if (result.action === 'adopted') log(tag, `${name} of ${home} was a file of its own, left where a link could not be made: it is the default's again, shared as a ${result.how}${result.backup ? `; what it held is kept as ${result.backup}` : ''}`);
      else if (result.backup) log(tag, `${name} of ${home} and the default's both changed since they were last in step: the newer was kept, the other saved as ${result.backup}`);
    } catch (error) {
      log(tag, `link ${name} failed: ${error?.message || error}`);
      failed.push(name);
      if (recorded[name]) modes[name] = recorded[name];
    }
  }
  return { linked, repaired, failed, modes };
}

